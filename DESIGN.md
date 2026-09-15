# Ruakdown 架构设计 v2(Rust + Tauri 2,Windows-first Markdown 阅读器/编辑器)

> **v2 修订说明(2026-09)**:相对 v1 的主要变化——
> 1. 主适配目标调整为 **Windows 优先**;macOS 后续跟进,Android 降级为附录(未来扩展)。
> 2. 产品定位调整为**阅读优先**:MVP 先做高质量渲染阅读(文件树/大纲/Mermaid/主题),编辑随后叠加。
> 3. 渲染管线改为 **Rust 侧 pulldown-cmark 单一事实源**(阅读视图、导出 HTML、内嵌 Serve 共用同一条管线),前端不再引入 marked/micromark,体积最小化。
> 4. 编辑内核改为**手搓分阶段**:M2 用 CodeMirror 6 做源码模式;WYSIWYG 后置到 M5 评估(基于 ProseMirror core 手搓,参考 Milkdown 的 schema/序列化设计,不引入 Milkdown 本体)。原则:**尽量减少框架依赖和编译后体积**。
> 5. 依赖版本全面更新,补齐 Windows 专项(编码兼容、CRLF/LF、单实例、文件关联、安装器)。

## 一、整体架构

```
┌─────────────────────────────────────────────────────────────┐
│  前端层(WebView2,React + TypeScript + Tailwind,无组件库) │
│  职责:文件树/大纲 UI、阅读视图展示、Mermaid 按需渲染、        │
│        源码编辑器(CodeMirror 6,动态加载)、主题 CSS 变量     │
└───────────────────────────┬─────────────────────────────────┘
                            │ Tauri IPC(command / event)
┌───────────────────────────▼─────────────────────────────────┐
│  Rust 层                                                     │
│  ├─ core/(纯 Rust,无 tauri 依赖,lib 形态)                  │
│  │    markdown 渲染(pulldown-cmark)、目录树、文件 watch、    │
│  │    读写(编码探测/换行符保持)、HTML 导出、axum 内嵌 Serve、│
│  │    主题与配置管理                                          │
│  └─ commands/(Tauri command 桥,薄层)                       │
└─────────────────────────────────────────────────────────────┘
```

分层原则:
- `core/` 不依赖 tauri,可独立编译为 lib,为将来 macOS/Android 复用留边界。
- `commands.rs` 只做参数转换和桥接,业务逻辑全部在 core。
- 前端不引入 UI 组件库(文件树、菜单、侧栏均为简单组件,手写),Tailwind 负责样式。

## 二、渲染管线(核心决策)

**pulldown-cmark(Rust)是唯一的 Markdown → HTML 渲染事实源**,三处消费:

| 消费方 | 流程 |
|--------|------|
| 阅读视图 | Rust 渲染 HTML → IPC 返回 → 前端 `innerHTML` 展示 |
| 导出 HTML | 同一管线 + 内联主题 CSS + mermaid.js(可选内嵌,离线可开) |
| 内嵌 Serve | `GET /api/doc` 返回同一渲染结果,静态预览页展示 |

收益:前端零解析器依赖(省 ~50KB+),预览/导出/外部访问三者渲染结果**必然一致**,单一维护点。

前端唯一承担的渲染是 **Mermaid**:识别 `mermaid` 代码块,动态 `import()` mermaid 12 渲染 SVG(按需加载,无 mermaid 的文档不加载 ~1MB chunk)。Rust 只负责在渲染时给 mermaid 代码块打上标记 class。

大纲(标题树)由 Rust 在渲染时一并提取(H1–H6 + 锚点 id),随 HTML 一起返回。

## 三、编辑方案(分阶段)

- **M2 源码模式**:CodeMirror 6(按需引入:markdown 语言包 + 基础 setup,模块化可控)。阅读/源码双模式切换(类 Typora 的同一文档双视图,不做左右分屏)。
- **M5 WYSIWYG(评估后置)**:手搓 Typora 级 WYSIWYG(表格、任务列表、粘贴、序列化往返)工作量极大,不作为 MVP 内容。届时基于 ProseMirror core(model/view/state/transform/markdown,合计约 150KB gzip,纯库非框架)自建,参考 Milkdown 的 schema 与 markdown 序列化设计;若评估后发现体积/工作量超出预算,源码模式 + 阅读模式已是可用的最终形态。

保存策略:自动保存(防抖)+ 手动保存 + 崩溃备份;**逐文件保持原编码与换行符**(见 §五)。

## 四、主题系统

CSS 变量驱动,主题 JSON 由 Rust 管理(打包进 `resources/themes/`):

```json
{
  "name": "Dark",
  "dark": true,
  "vars": {
    "--bg": "#1e1e1e",
    "--text": "#d4d4d4",
    "--heading": "#569cd6",
    "--code-bg": "#2d2d2d",
    "--mermaid-bg": "#222222"
  }
}
```

流程:Rust 读取主题 → IPC 发送变量 → 前端写入 `:root`,实时切换免刷新;窗口深色标题栏跟随主题(Windows:设置 window theme);Mermaid 主题随明暗同步(`dark` 字段)。内置:浅色 / 暗色 / 石墨 / 夕阳海岸 / 无边绿意 / 蓝天白云 / 陈旧报纸 / 青梅煮酒 / 高山流水 / 论道武当;支持导入导出主题 JSON。

## 五、Rust core 模块

### 1. 文件与目录(`file.rs`)
- 目录树:递归遍历,只收 `.md`(大小写不敏感匹配),忽略 `.git`/`node_modules`/隐藏目录;层级懒加载可后置。
- Watch:`notify 8`(Windows 走 ReadDirectoryChangesW),**防抖合并**事件,**忽略自身写入产生的变更**(保存时记录路径+时间窗),外部修改 → 事件推送前端刷新。
- 读写与编码(Windows 专项):
  - 读取:`encoding_rs` 探测——UTF-8(BOM)直接解码;无效 UTF-8 回退 GBK;记录原编码。
  - 写入:按原编码写回(新建文件默认 UTF-8 无 BOM)。
  - 换行符:探测 CRLF/LF/CR,编辑与保存逐文件保持,不做全文件改写。
  - 路径:`dunce` 规范化,避免 `\\?\` 前缀泄漏到 UI;长路径用 std 默认处理。

### 2. Markdown 渲染(`markdown.rs`)
- `pulldown-cmark 0.13`(`CommonMark` + 表格/删除线/任务列表扩展),渲染 HTML + 提取大纲 + mermaid 块标记。
- 大文件策略:单文档全量渲染(MVP 规模足够),虚拟滚动/增量列为后续优化。

### 3. HTML 导出(`export.rs`)
- 同管线渲染 + 内联主题 CSS + `mermaid.min.js` 可选内嵌(离线打开图形完整);图片可选 base64 内嵌或保持相对链接。

### 4. 内嵌 Serve(`serve.rs`)
- `axum 0.8` + tokio,独立任务,与 Tauri 解耦;菜单/命令启停。
- 路由:`GET /` 预览页(静态)、`GET /api/doc`(渲染 HTML + 大纲)、静态资源(图片/附件)。
- 默认绑定 `127.0.0.1`,端口可配;开启 `0.0.0.0` 需手动,UI 提示 **Windows 防火墙将弹窗授权**。

### 5. 配置(`config.rs`)
- `serde_json`,经 `tauri::path` 存 `%APPDATA%/ruakdown/`:上次文件夹/文件、主题、窗口状态、serve 配置、自动保存开关。

## 六、前端结构

```
src/
├── components/      # FileTree / Outline / Reader / SourceEditor / Sidebar / MenuBar
├── ipc.ts           # invoke/listen 类型化封装
├── theme/           # CSS 变量注入、主题切换逻辑
├── mermaid.ts       # 动态 import mermaid,渲染/重渲染 mermaid 块
└── App.tsx
```

布局(桌面):
```
┌───────────────────────────────────────────────┐
│ 菜单栏(文件/编辑/视图/主题/服务/帮助)        │
├──────────────┬────────────────────────────────┤
│ 文件树 | 大纲 │  阅读视图 / 源码编辑器(切换)  │
│ (可折叠双Tab)│                                │
└──────────────┴────────────────────────────────┘
```

## 七、依赖清单(2026-09 核实版本)

Rust(`src-tauri/Cargo.toml`):
```toml
tauri = "2"                      # 2.11.x
tauri-plugin-dialog = "2"        # 文件/文件夹选择
tauri-plugin-single-instance = "2"  # M4 启用
pulldown-cmark = { version = "0.13", default-features = false, features = ["html"] }
notify = "8"                     # 9 尚在 rc
axum = "0.8"
tokio = { version = "1", features = ["rt-multi-thread", "macros", "net", "fs", "time"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
encoding_rs = "0.8"
dunce = "1"
```

前端(`package.json`):`react` / `react-dom`、`typescript`、`vite`、`@tauri-apps/cli`、`@tauri-apps/api`、`tailwindcss`、`codemirror 6`(@codemirror/* 按需)、`mermaid`(动态 import)。**不引入**:shadcn/radix、marked/micromark、Milkdown、ProseMirror(M5 前不装)。

体积策略:阅读模式仅 React(~45KB gzip)+ 应用代码;mermaid 按需 chunk;CodeMirror 仅编辑模式动态加载;Rust 渲染省去前端解析器。

## 八、Windows 专项清单

| 项 | 处理 |
|----|------|
| 编码 | UTF-8(有/无 BOM)/ GBK 回退;保存保持原编码 |
| 换行符 | 逐文件保持 CRLF/LF |
| 单实例 | tauri-plugin-single-instance,二次启动唤起已有窗口并带上目标文件 |
| 文件关联 | tauri.conf.json 注册 `.md`(NSIS),Explorer 双击打开 |
| 安装器 | NSIS + WebView2 bootstrapper(Win10 旧版兜底,Win11 自带) |
| 防火墙 | 0.0.0.0 绑定时 UI 明确提示授权弹窗 |
| 标题栏 | 深浅色跟随主题(window theme) |
| 路径 | dunce 规范化,大小写不敏感,统一正斜杠显示可选 |

## 九、里程碑

1. **M0 环境**:rustc(MSVC)/node/pnpm 确认;create-tauri-app(React-TS);`tauri dev` 跑通。
2. **M1 阅读 MVP**:打开文件夹/文件 → 文件树(watch)→ Rust 渲染阅读视图 → 大纲(跳转+滚动高亮)→ Mermaid 渲染 → 主题切换 → 状态记忆。
3. **M2 编辑**:CodeMirror 6 源码模式,双模式切换;保存/自动保存/崩溃备份;编码与换行符保持;外部修改重载提示。
4. **M3 输出**:导出 HTML;axum 内嵌 Serve;原生菜单栏。
5. **M4 Windows 打磨**:单实例、文件关联、NSIS 安装包、图标、设置页。
6. **M5 后置评估**:WYSIWYG(ProseMirror core 手搓)、macOS 适配、全文搜索、PDF 打印、大文档优化。

## 附录:Android 未来适配要点(Tauri Mobile,当前不做)

- 复用 `core/` 与前端;UI 响应式分支(抽屉式侧栏,无原生菜单栏)。
- SAF 限制:不能任意遍历存储,需用户选目录授权,`file.rs` 需路径适配层。
- 系统 WebView 版本参差,Mermaid/JS 兼容性需实测;Serve 仅限本机访问。
- Tauri Mobile 自 2024-10 随 v2 stable,但社区反馈移动端仍有边角问题,启动前需专项评估。

## 十一、实施状态(2026-09-12)

已完成并实测通过:
- **M0–M4 全部里程碑**。工具链 Rust 1.96 / Node 24 / pnpm 10.29;Tauri 2.11.x。
- 阅读 MVP:文件夹树(notify 8 watch + 400ms 防抖批量事件)、pulldown-cmark 渲染、大纲(锚点注入 + 滚动同步高亮)、Mermaid 12 按需动态 import(暗色主题同步重渲染)、三主题(CSS 变量 + 窗口深浅色标题栏跟随)、会话恢复(上次文件夹/文件/主题/设置)。
- 编辑:CodeMirror 6 源码模式(懒加载分包)、阅读/源码切换、自动保存(1.5s 防抖,已落盘实测)、Ctrl+S、逐文件保持编码(UTF-8/BOM/UTF-16/GBK)与 CRLF/LF(单测覆盖)、保存前滚动备份(保留 10 份,单测覆盖)、外部修改检测(未保存时提示条)。
- 输出:导出离线 HTML(同渲染管线 + 内联主题 CSS + 内嵌 mermaid.min.js 5.6MB 资源,CDN 兜底)、axum 0.8 内嵌预览 Serve(`GET /` `GET /api/doc` `GET /static/*` 文档目录图片,CORS 全开,3s 轮询刷新)、原生菜单(文件/视图/主题/服务/帮助,快捷键 Ctrl+Shift+O / Ctrl+O / Ctrl+S / Ctrl+E / Ctrl+Shift+F / Ctrl+Shift+Z / F11,macOS 对应 ⌘ 系)。
- Windows 打磨:单实例(二次启动唤起主窗口,已实测)、`.md`/`.markdown` 文件关联(NSIS,currentUser 安装)、设置弹窗(自动保存开关 + Serve 端口,持久化)。
- 跨平台打包:`tauri.conf.json` 的 `bundle.targets` 为 `all`,各平台由 `tauri.{windows,macos,linux}.conf.json` 收敛——Windows→NSIS、macOS→app+dmg、Linux→deb;Taskfile `task build` 按平台输出对应安装包路径。

实现备注:
- 内置主题以 `include_str!` 嵌入二进制(`src-tauri/resources/themes/`),自定义主题导入导出尚未实现(M5)。
- Serve 预览页的 Mermaid 走 CDN;导出 HTML 的 Mermaid 走本地内嵌资源,资源缺失时回退 CDN。
- 导出 HTML 的图片仍为相对引用,base64 内嵌未实现(M5)。
- Mermaid 渲染安全级别 `strict`;原始 HTML 透传 pulldown-cmark,信任本地文档(前端未暴露全局 IPC)。
- **所有原生文件对话框命令(pick_folder/pick_file/pick_export_path)必须是 async + spawn_blocking 等待回调**:Tauri 同步命令在主线程执行,而对话框回调也要主线程分发,同步等待会在 macOS 上直接死锁(Windows 下 IPC 回调在不同线程,故此问题仅在 mac 复现,2026-09-14 修复)。load_tree/save_file/export_html 同理移入 spawn_blocking,避免大目录扫描/大文件写入阻塞 UI。

M5(未开始):WYSIWYG(ProseMirror core 手搓)、macOS 适配、文件内查找/替换、PDF 打印、图片 base64 内嵌导出、主题导入导出。

M5 部分提前落地——目录内搜索(2026-09-14 已完成):Rust `core/search.rs` 递归搜索已打开目录下全部 `.md`/`.markdown`(复用 `collect_markdown_files` 的遍历规则与 `read_text` 的编码检测,GBK/UTF-16 可直接匹配),内容按行匹配 + 文件名匹配(文件名命中排前);上限保护(单文件 50 条/总量 2000 条/跳过 >16MB);前端 `SearchModal` 中央模态框,输入防抖 500ms、关键词 ≥2 字符才触发、同一时刻只允许一个目录扫描(输入期间的触发合并为最新一次,结束后补跑)、渲染上限 300 条(状态行仍显示真实计数),结果按文件分组展示命中行片段(关键词 `<mark>` 高亮),Ctrl+Shift+F(视图菜单「目录内搜索」)或标题栏「搜索」按钮打开,↑/↓/Enter/Esc 键盘导航;点击命中项打开文件并滚动定位到首个匹配处(阅读模式 best-effort,分块大文档/源码模式仅打开不定位)。文件内 Ctrl+F 查找仍归 M5。

v0.3.2——快捷键兜底与全屏(2026-09-15 已完成):搜索/专注模式的原生菜单加速键在 Windows 上 WebView2 聚焦时不触发(已知平台行为),全局快捷键改由前端 `window` capture 阶段 keydown 统一兜底:Ctrl/Cmd+Shift+F 搜索、Ctrl/Cmd+Shift+Z 专注、Ctrl+Tab 阅读/源码切换(Cmd+Tab 归操作系统,故两端统一 Ctrl+Tab)、F11 全屏(macOS 兼容 ⌃⌘F)、Esc 逐层退出(搜索/设置 > 专注 > 全屏)。capture 监听先于 CodeMirror 截获按键,顺带避免 Ctrl+Shift+Z 被编辑器当作「重做」,Ctrl+F 仍归编辑器内查找;菜单加速键与 keydown 双路径用 350ms `fireOnce` 去重,防止双触发。全屏为应用级「纯内容」:隐藏标题栏、侧栏、状态栏;Windows/Linux 的原生菜单栏属窗口框架,由自定义命令 `set_fullscreen` 内调 `hide_menu/show_menu` 随全屏显隐(macOS 全屏自动隐藏菜单栏,无需处理);前端不依赖窗口 JS API 查询全屏态,以 React 状态为唯一事实来源,偶发的外部全屏退出会在下一次按键时自然归位。

## 十二、构建(仓库根目录 `Taskfile.yml`,基于 go-task)

| 命令 | 作用 |
|------|------|
| `task doctor` | 检查工具链(node/pnpm/rustc/cargo)与产物目标目录 |
| `task install` | `pnpm install` |
| `task dev` | 开发模式(tauri dev,Vite HMR + Rust 增量编译) |
| `task check` | 快速检查:前端 `tsc + vite build` + Rust `cargo check` |
| `task test` | Rust 单元测试(18 个) |
| `task bench` | 大文档渲染基准(1/5/10MB,release + ignored test) |
| `task build` | release + 平台安装包(win→NSIS / mac→dmg / linux→deb;内置 `CARGO_BUILD_JOBS=4`,防链接器 OOM) |
| `task build:frontend` | 仅构建前端(`dist/`) |
| `task clean` | 清理 `dist/` 与 cargo target |

- 前置依赖:Node + pnpm、Rust(MSVC 工具链)、WebView2(Win11 自带)、go-task。
- **可移植性约定**:Taskfile 内的命令只使用 shell 内建(`printf`)与项目工具链(`node`/`pnpm`/`cargo`/`task`),**不依赖任何 Unix 工具**(`tr`/`rm`/`sed` 等)。原因:go-task 只提供 POSIX 解释器,外部命令仍需从 PATH 查找——Git Bash 里有 `tr` 而 cmd.exe 里没有,曾导致 `task build` 在 cmd 下报 `"tr" executable file not found`。删除文件统一用 `node -e "fs.rmSync(...)"`,避免 `rmdir`/`if exist` 这类平台专属语法。
- 安装包路径:`${CARGO_TARGET_DIR:-src-tauri/target}/release/bundle/` 下,按平台:Windows `nsis/Ruakdown_0.1.0_x64-setup.exe`、macOS `dmg/Ruakdown_0.1.0_*.dmg`(另有 `macos/Ruakdown.app`)、Linux `deb/Ruakdown_0.1.0_*.deb`。
- 已知环境坑:16 线程并行链接会触发 `LNK1102 内存不足`,故打包任务固定 `CARGO_BUILD_JOBS=4`;不要在 `tauri dev` 运行期间执行 `task build`(两者共用 target 目录会互相清产物)。

## 十三、M5-1 大文档分块渲染(2026-09-12 已完成)

实测背景(debug 构建):10MB markdown → Rust 全量渲染 2.0s、HTML 18.9MB、3.5 万标题;瓶颈在前端一次性 DOM 构建而非 Rust 渲染。

实现(阈值:源文件 > 1MB 走分块,否则维持一次性渲染):
- **分块单位 = Markdown 顶层块**(pulldown-cmark offset-iter 按深度切顶层块,单次解析按块路由事件,`html::push_html` 逐块渲染),任意块拼接 == 全量渲染(单测断言字节相等);块边界永不切开表格/列表/代码块。
- **块预算**:~32KB HTML 或 ~1500 标签对先到者切块(标签数在渲染时精确统计),单个超大块独立成块。
- **Rust**(`core/large_doc.rs`):打开时单次解析建索引(块 HTML + 估算高度 + 带块号的大纲 + mermaid 标记),`CachedDoc` 常驻内存;`open_doc` 命令统一入口(小文件返回完整 HTML,大文件返回 `ChunkedMeta`);`render_chunks(token, start, count)` 按需批量返回块 HTML。
- **前端**(`components/ChunkedReader.tsx`):每块一个占位 div(估计高度骨架),rAF 节流滚动监听;预取窗口 = 视口前 2/后 3 块,**随滚动速度自适应放大**(速度自适应替代定长"高负载窗口"),在途请求上限 8;超出保留窗口(±6+boost)的块**逐出 DOM**换回占位(保留实测高度);块高度实测后缓存,视口上方高度变化做**滚动锚定补偿**;大纲项携带块号,跨未加载区跳转 = 先拉块再 `scrollIntoView`;滚动高亮基于"块顶 + 块内标题偏移"计算。
- **图片协议**(顺带修复既有缺陷):`rewrite_img_srcs` 将相对路径 `<img>` 统一改写为 asset 协议(`http://asset.localhost/...`,启用 `assetProtocol` scope `**`,tauri `protocol-asset` feature),小文件/分块两条路径都生效,图片本地可见。
- Mermaid SVG 按"内容哈希+主题"缓存(40 条 LRU),逐出的块滚回时秒级重挂载。
- 实测:2MB 文档(1700 单元/3400+ 标题)快速滚动流畅、内存稳定(进程 ~60MB 含 webview 基线)、大纲跨区跳转与滚动高亮正常、小文件路径无回归。
- 已知限制:浏览器 Ctrl+F 只搜已挂载块(全文搜索走 M5 Rust 搜索);大纲列表本身在超大文档(数千标题)未虚拟化;`CachedDoc` 常驻内存(源文件 + 渲染 HTML 约 2 倍文件体积),超百 MB 文档需再加 Rust 侧 LRU(预留)。
