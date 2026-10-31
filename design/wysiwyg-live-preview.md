# 实时编辑（WYSIWYG）设计

> 目标：在现有 Markdown 阅读器上增加 Typora / Obsidian Live Preview 式的所见即所得编辑视图。
> 状态：设计已确认，待实现。分支 `feat/wysiwyg`。

## 1. 结论先行

**Markdown 文本仍是唯一事实源，实时编辑只是 CodeMirror 6 上的一层装饰。**

- 不引入 ProseMirror / Milkdown，不新建第二套文档模型，不做 HTML→Markdown 往返。
- 磁盘上的文件、保存、编码、CRLF、撤销、搜索、导出、分享、大文档全部复用现有链路。
- 阅读 / 导出 / 分享继续由 Rust `pulldown-cmark` 渲染；实时编辑视图是表现层，渲染有出入时以阅读视图为准。

选择理由见「方案取舍」。

## 2. 方案取舍

| 方案 | 文档模型 | 往返损耗 | 新增依赖 | 结论 |
|------|----------|----------|----------|------|
| **A. CM6 装饰层**（本设计） | Markdown 文本 | 无 | 0 | 采用 |
| B. ProseMirror 富文本内核 | 富文档树 → 序列化 | 需自建 schema / serializer | +150KB gzip | 不做 |
| C. 渲染 HTML + contenteditable + Turndown | DOM → 反序列化 | 必然有损 | 0 | 不做 |

B 是思源 / Notion 的路线：文档模型本身是块树（思源存 JSON），要再养一条渲染管线和序列化器，和本项目「Rust 单一渲染事实源、不引重框架」的架构决策冲突。C 看起来最便宜，但每次按键都要重渲染整段 HTML、光标会跳、撤销会断，不能作为正式功能。

## 3. 视图与状态

### 3.1 四种视图

```ts
type Mode = "read" | "live" | "split" | "edit";
```

| 值 | 标题栏 | 说明 |
|----|--------|------|
| `read` | 阅读 | 现有阅读视图 |
| `live` | 实时 | 本次新增，所见即所得编辑 |
| `split` | 分屏 | 现有源码 + 预览 |
| `edit` | 源码 | 现有 CodeMirror 源码编辑 |

- 标题栏三段变四段：`阅读 | 实时 | 分屏 | 源码`。
- Ctrl+Tab 循环：`read → live → split → edit → read`。
- 源码视图原样保留，实时视图出问题时可一键退回。
- 实时视图不参与分屏：它是单栏编辑，不显示预览。

### 3.2 启动模式设置

设置弹窗新增「启动模式」下拉框，四个选项全部可选，**默认阅读**：

```json
// config.json
{ "startupMode": "read" }   // "read" | "live" | "split" | "edit"
```

- Rust `Config` 增加 `startup_mode: Option<String>`（serde camelCase → `startupMode`），旧配置缺省即为 `read`。
- 前端 `normalizeStartupMode(raw): Mode`：非法值/缺失一律回退 `read`，与现有 `normalizeSide` / `normalizeRatio` 同一风格，放在 `split.ts` 并单测。
- 设置项立即持久化（`persist({ startupMode })`），下次启动生效。
- **只作用于启动时打开的那篇文档**：启动有文件 → 打开后切到该模式；启动无文件（欢迎页）→ 保持阅读，之后手动打开文件不会自动切模式。文件打开失败同样保持阅读。

### 3.3 编辑器复用

不新建编辑器组件。`SourceEditor` 增加 `live?: boolean`：

- 同一个 CodeMirror 实例、同一套 keymap、搜索桥、粘贴拦截、斜杠面板、右键菜单、自动保存。
- 仅当 `live` 为真时追加 `livePreview()` 扩展和一套阅读态主题（字体、行高、内容宽度）。
- 分屏 / 源码 / 实时三处编辑器 JSX 抽成一个局部 `editorPane` 变量（当前分屏与源码已重复一份），避免第三份复制。

`switchMode` / `nextEditorText` 的现有语义天然覆盖 `live`：它是编辑视图，进入时从 `doc.text` 播种缓冲，离开到阅读时先保存。

## 4. 装饰层

### 4.1 计算时机

- `ViewPlugin`，在文档、选区、视口变化时重算；只遍历 `view.visibleRanges` 内的 `syntaxTree(state)`。
- `view.composing`（IME 组合中）时**不生成任何 replace 装饰**，组合结束再恢复。
- `Decoration.set(ranges, true)` 统一排序。

### 4.2 露出单位

光标 / 选区所在的块保持源码原样（Typora 手感）：

- 从 `syntaxTree(state).resolveInner(head, -1)` 向上找最近的「露出单位」：`Paragraph`、`ATXHeading1..6`、`SetextHeading1/2`、`FencedCode`、`ListItem`、`Blockquote`、`Table`、`HTMLBlock`；找不到则到 `Document`。
- 该块内**不隐藏标记**，但字号、粗体等样式照常应用。
- 选区跨多块时，涉及的每个块都露出。

### 4.3 内联

| lezer 节点 | 处理 |
|------------|------|
| `HeaderMark`（`#`） | `Decoration.replace` 隐藏 |
| `EmphasisMark` / `StrongEmphasis` | 隐藏标记，`Decoration.mark` 加 `rk-em` / `rk-strong` |
| `StrikethroughMark` | 隐藏标记，加 `rk-strike` |
| 行内 `CodeMark` | 隐藏反引号，加 `rk-inline-code` |
| `LinkMark`、链接 `URL` | 隐藏，保留链接文字并加 `rk-link` |
| `QuoteMark`（`>`） | 隐藏 |

未识别的行内语法（`==高亮==`、`$…$`、`<u>`/`<kbd>`、转义符）P1 保持原文，P2 补自定义 inline parser。

### 4.4 块级

| 节点 | 处理 |
|------|------|
| `ATXHeading1..6` | `Decoration.line` 加 `rk-h1..rk-h6`，字号/字重/间距走 CSS |
| `Blockquote` | 每行 `Decoration.line` 左边线；`QuoteMark` 隐藏 |
| `BulletList` | `ListMark` 替换为圆点 widget；有序列表的 `1.` 保留 |
| `Task` / `TaskMarker` | `[ ]`/`[x]` 替换为复选框 widget，点击 dispatch 改原文 |
| `HorizontalRule` | 隐藏整行文本 + `rk-hr-line` 行装饰画上边框。**不能用 block widget**：CM6 禁止 ViewPlugin 提供 block 装饰，渲染时会抛 `Block decorations may not be specified via plugins` |
| `FencedCode` | P1 只加背景/圆角样式，围栏仍可见；P2 做点击进入源码的高亮 widget |
| `Table` | P1 保持源码 + 等宽对齐美化；P3 单独评估网格编辑 |
| Frontmatter | lezer 不识别，按行扫描：隐藏首尾 `---` 并折叠行高；内容行绘制卡片背景，键名/值用 inline-block 两列对齐；`name`/`author`/`version` 加粗、`description` 斜体弱化、`keywords`/`tags`/`categories` 彩色 chip、空 `references` 留空；光标进入时显示原文 |

- 论道武当这类「浅色主题 + 深色代码面」必须在主题 JSON 里覆盖 `--syn-*`，否则浅色语法调色板会在深色代码块上变成黑底黑字。

### 4.5 图片

- `Image` 节点在非活动块内替换为 `<img>` widget。
- 相对路径解析复用阅读视图同一规则：百分号解码、`\`→`/`、`..` 词法规整、`http/https/data/#/asset` 直通；最终用 `convertFileSrc` 生成 webview URL。
- 该逻辑放在 `src/livePreview.ts` 的一个纯函数里并单测（CJK、空格、`..` 越界、Windows 盘符、外链直通），不新增 IPC；规则若与 Rust 漂移，以阅读视图为准。
- 图片 widget 加载后 `view.requestMeasure()` 修正高度；点击把光标放到节点前并露出该块。
- `data:` / 远程图片按原样交给 `<img>`。

### 4.6 光标与 IME

- **原子区间**：被 replace 的文本区间通过 `EditorView.atomicRanges` 设为原子，方向键与退格不会"看不见地"穿过标记。
- **IME 保护**：组合期间不替换；活动块本来就露原文，组合正常提交后再装饰。
- 点击图片 / 复选框等 widget 时，`ignoreEvent` 按需返回 `false` 并自行处理，避免抢走编辑器的正常选区行为。

## 5. 数据流

### 5.1 不变的部分

- `onChange` → `editTextRef` → 1.5s 防抖自动保存 / Ctrl+S：不变。
- 编码、CRLF、外部修改提示（`decideFsChange` 对任何非 `read` 模式已返回 `prompt`）：不变。
- Ctrl+F：`SearchPanel` 已按 `mode === "read"` 区分，`live` 自动走源码搜索桥，搜索的是原始 Markdown。
- 斜杠面板、右键菜单、富文本粘贴、插入资源、撤销/重做：不变。
- 阅读 / 导出 / 分享：仍走 Rust，不变。

### 5.2 大纲

- 阅读 / 分屏沿用现有来源；`live` 用 300ms 防抖在 JS 侧扫描编辑缓冲生成 `OutlineItem[]`，复用 `headingLocate.ts` 的 slug 规则（与 Rust 渲染器一致的重复序号、CJK、frontmatter 跳过）。
- 点击大纲 → `editorRef.gotoLine(line)`；滚动高亮由编辑器顶行映射（P1 可先只做点击跳转）。
- 该扫描是纯函数，单测覆盖；不触发 Rust 预览重建。
- 目录搜索命中与文档内 `#锚点` 链接在 `live` 下都按 `headingLineById` 找到行后 `gotoLine`（与分屏的定位行为一致）。

### 5.3 启动流程

```
get_config → normalizeStartupMode
  → 打开 pending / lastFile
  → 若启动模式 ≠ read：直接 setMode(startupMode)
     （editTextRef 已由 openFile 播种；split 才额外 refreshPreview）
```

不在启动流程调用 `switchMode`：它依赖已提交的 `stateRef.doc`，在 `openFile` 刚 setDoc 后仍可能是旧值，会把编辑缓冲清空。

## 6. 分期

### P1（本分支交付）

1. `Mode` 增加 `live`，标题栏四段、Ctrl+Tab 四态、状态栏「实时模式」。
2. 启动模式设置（Rust 配置字段 + 前端归一化 + 设置弹窗 + 启动应用）。
3. `SourceEditor.live` + `livePreview()` 扩展。
4. 内联标记隐藏与样式：标题、粗体、斜体、删除线、行内代码、链接、引用。
5. 块级：列表圆点、任务复选框、分隔线、图片、代码块背景。
6. 活动块露出、原子区间、IME 保护。
7. 实时大纲（扫描 + 点击跳转）。
8. 单测 + 中文输入法手工验收。

### P2（重组件）

- 代码块：失焦时用 Rust 高亮结果做 widget，点击回到源码。
- 公式：新增 `render_math` IPC，复用 Rust `latex2mathml`。
- Mermaid：复用 `mermaid.ts` 与现有缓存策略。
- GFM callout 配色。
- `==高亮==`、`<u>`/`<kbd>` 的自定义 inline parser。

### P3（表格，单独评估）

- 方案一：点击表格进入网格编辑（Typora 式特殊 UI）。
- 方案二：保持源码 + 管道对齐美化。
- 不做 ProseMirror 式单元格级真编辑。

### 明确不做

块拖拽、块引用、数据库视图、块级双链。这些属于思源 / Notion 的文档模型，不是「所见即所得」的必要条件。

## 7. 文件清单

| 文件 | 改动 |
|------|------|
| `src-tauri/src/core/config.rs` | `startup_mode: Option<String>` |
| `src/ipc.ts` | `AppConfig.startupMode` |
| `src/split.ts` | `Mode` 加 `live`；`nextMode`；`normalizeStartupMode` |
| `src/split.test.ts` | 四态循环、归一化、缓冲保持 |
| `src/components/TitleBar.tsx` | 第四个视图按钮 |
| `src/components/TitleBar.test.tsx` | 点击「实时」 |
| `src/components/SourceEditor.tsx` | `live` prop、阅读态主题、挂载 `livePreview()` |
| `src/livePreview.ts` | **新增**：装饰构建、widget、图片路径解析 |
| `src/livePreview.test.ts` | **新增**：装饰范围、活动块、widget、路径解析 |
| `src/App.tsx` | 模式分支、启动模式、实时大纲、设置项、状态栏、编辑器 JSX 去重 |
| `src/headingLocate.ts` | 拆出可复用的 outline 扫描（与现有 slug 规则共用） |
| `src/index.css` | 实时视图样式（复用 `--text` / `--heading` 等变量） |

## 8. 测试与验收

### 自动测试

- `nextMode` 四态循环；`normalizeStartupMode` 非法值回退 `read`。
- `livePreview` 纯函数：给定 markdown + 光标位置，断言哪些区间被隐藏、哪些加 mark、活动块是否露出。
- 图片路径解析：`./a.png`、`../assets/中文 图.png`、`..` 越界、Windows 盘符、`https://` / `data:` 直通。
- 任务复选框点击后原文从 `[ ]` 变 `[x]`（dispatch 结果断言）。
- `decideFsChange` 对 `live` 脏缓冲返回 `prompt`。
- 现有 315 项前端测试不回归。

### 手工验收

- 中文输入法连续输入、候选切换、组合中按方向键：不吞字、不重复、不跳光标。
- 标题/粗体/链接输入时标记的露出与隐藏。
- 粘贴富文本、粘贴图片、斜杠面板、右键菜单、Ctrl+F 替换。
- 大文档（>1MB）滚动：只装饰可视区，无明显卡顿。
- 启动模式四种取值各启动一次；无文件启动保持阅读。
- 阅读 / 导出 / 分享结果与改动前一致。

## 9. 风险与已知取舍

| 风险 | 处理 |
|------|------|
| IME 与装饰冲突（头号风险） | 组合期间不替换 + 活动块露原文 + 中文输入法实测 |
| 复制选区带出原始 Markdown | P1 接受；"复制渲染文本"另做剪贴板序列化（未排期） |
| Ctrl+F 命中落在隐藏标记里 | P1 接受，搜索仍以源码为准 |
| 表格 / 代码块在 P1 仍可见围栏与管道符 | 分期实现，不是遗漏 |
| lezer 不识别 `==` / `$…$` / HTML 标签 | P1 保持原文，P2 补 parser |
| 装饰样式改变行高导致滚动跳动 | 只用字号/行高/内边距的稳定组合，验收时检查长文档滚动 |
| 实时视图与阅读视图渲染细节不一致 | 以 Rust 阅读视图为准，实时视图不承担导出/分享正确性 |
