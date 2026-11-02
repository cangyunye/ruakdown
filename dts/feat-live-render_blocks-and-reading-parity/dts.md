---
id: "feat-live-render_blocks-and-reading-parity"
domain: "feat-live-render"
slug: "blocks-and-reading-parity"
title: "实时视图未复用阅读模式渲染：表格 / 代码围栏 / 公式 / Mermaid 以源码呈现，标题、引用、代码块样式与阅读不一致，frontmatter 在非默认主题下被标题色染色"
status: "resolved"
created: "2026-11-02T12:40:00+08:00"
resolved: "2026-11-02T13:41:24+08:00"
commit: "(未提交，feat/wysiwyg 工作区)"
branch: "feat/wysiwyg"
platform: "darwin"
session: "session_0eb2567f6427186d37f048a16db1ca24"
---

# feat-live-render_blocks-and-reading-parity

## 问题

用户对比阅读 / 实时两个视图的截图：

1. 实时视图里 GFM 表格、代码围栏（含 ` ``` ` 行）、`$$` 公式、Mermaid 全部是源码，阅读视图是渲染结果。
2. 标题字号 / 下划线、引用块配色、代码块的面板样式与阅读视图不一致（实时只有背景色）。
3. 论道武当等「标题色 ≠ 正文色」的主题下，实时 frontmatter 卡片整体被染成标题色加粗（dts `fix-live-frontmatter_card-layout` 只重置了行级样式，没有压住内层高亮 span）。

## 环境

| 项 | 值 |
|----|----|
| 分支 | feat/wysiwyg（基于 b4ab6bb） |
| 平台 | darwin arm64 |
| 验证方式 | 浏览器 harness（vite + Playwright，Tauri IPC 用 `window.__TAURI_INTERNALS__` 桩） |

## 调查过程

- [12:40] 读交接 / 设计文档：实时视图是 CM6 装饰层，表格 / 代码 / 公式 / Mermaid 是设计里明确的 P2 待办；阅读视图由 Rust `pulldown-cmark` + syntect 渲染，公式走 `latex2mathml`，Mermaid 由前端 `mermaid.ts` 渲染。
- [12:50] 阅读样式全部在 `resources/md-content.css`（`.md-body` 作用域），实时样式在 `index.css` 末段，字号 / 间距 / 边框各写一套，没有共用。
- [13:00] 块级渲染必须用 `Decoration.replace({block: true})`，而 CM6 禁止 ViewPlugin 提供块装饰 → 新建 `StateField`（`src/liveBlocks.ts`）。
- [13:02] 单测暴露：单列表格分隔行正则不匹配；光标停在表格后一行时表格会解渲染（块区间含尾部换行，`to` 位置被当成块内）。
- [13:05] 确认 lezer 围栏节点名是 `CodeMark` 不是 `FenceMark`；`[!NOTE]` 会被解析成 `Link` 节点，需在 Link 分支豁免。
- [13:20] harness 截图：块级 widget 上下留白过大 —— 根因是 `index.css:690` 给裸 `.md-body` 加了阅读壳层布局（`padding: 40px 48px 80px; height: 100%; overflow-y: auto`），widget 容器借 `.md-body` 复用内容样式时把壳层布局一起继承了。
- [13:25] 任务列表文字呈强调色：lezer 给 `Task` 节点打 `tags.list`，且 CM 把高亮 span 嵌在 mark span **内层**，行级 / mark 级 `color` 压不住。
- [13:33] 深色主题下 frontmatter 值仍是标题蓝：尝试在实时 HighlightStyle 里 `{tag: heading, color: inherit}` 无效 —— 浏览器里 `.ͼo{inherit}` 排在 `.ͼz{--heading}` **前面**，CM6 挂载样式模块是反序的，同等优先级下靠前的扩展赢。
- [13:38] 改为互斥：实时视图自带完整 HighlightStyle（不含 heading 规则），源码基础高亮只在非实时模式进 compartment。深色下 frontmatter computed 与阅读逐项一致。
- [13:41] 结案。

## 根因

| 现象 | 根因 |
|------|------|
| 表格 / 代码 / 公式 / Mermaid 不渲染 | P1 设计范围，未实现；需要块级 widget，而 ViewPlugin 不能提供块装饰 |
| 样式不一致 | 实时样式独立手写，未对齐 `md-content.css` 的字号 / 间距 / 边框 / 配色 |
| frontmatter 被标题色染色 | 末尾 `---` 让 lezer 把元信息解析成 Setext 标题，内层 span 带 `color: var(--heading)`；默认浅色主题 heading = text 所以看不出 |
| widget 留白过大 | `.md-body` 同时是阅读视图的滚动壳选择器，布局规则漏到 widget 容器 |
| 任务文字强调色 | `Task` 节点 `tags.list`，高亮 span 在 mark 内层 |

## 修复方案

1. **块级 widget**（`src/liveBlocks.ts`，`StateField`）：按行扫描 GFM 表格 / ` ```mermaid ` / `$$…$$`，光标在块外时替换为 `<table>`（复用 `.md-body` 样式）、Mermaid SVG（复用 `mermaidSvg` 缓存）、MathML（新增 `render_math` IPC，复用 Rust `math_html`，与阅读输出完全相同）；光标进入 / 点击 widget 即显示源码。增量更新：普通文字编辑只做位置映射，只有改动触及 `| ` `` ` `` `~` `$` 或已知块时才重扫。**故意不设原子区间**：方向键进块即显源码（Typora 手感），且避免 CM6 在原子区间边缘一次 Backspace 删掉整张表。
2. **行内装饰补齐**（`src/livePreview.ts`）：围栏行隐藏并折叠成内边距高度；代码 token 走 `--syn-*`（与 Rust syntect 同一套变量，`markdownSupport` 加 `codeLanguages` 按需懒加载语法）；引用块首尾圆角 + GFM alert 五色与 `Note/Tip/…` 标签；段落 / 列表 / 列表项首尾间距类；装饰器跳过 widget 覆盖区间（CM6 禁止 replace 嵌套 replace）。
3. **样式对齐**（`src/index.css`）：标题 1.9/1.5/1.25em、字重 650、h1/h2 下划线；行内代码 0.9em / 5px 圆角；链接无下划线 hover 才有；引用 4px `--quote-border` + `--panel`；代码块 `--pre-bg` + `--pre-border` 圆角面板；frontmatter 13px / 10px 内边距；`.rk-live .md-body` 重置阅读壳层布局与背景图卡片效果。
4. **高亮互斥**（`SourceEditor.tsx`）：`liveCompartment` 在实时模式装 `livePreview()`（自带不含 heading 的 HighlightStyle），否则装源码基础高亮。

## 测试场景与 E2E 用例

| # | 用例 | 步骤 | 预期 | 结果 |
|---|------|------|------|------|
| 1 | 实时 vs 阅读（浅色） | 同一文档两列并排 | 表格 / 代码块 / 公式 / Mermaid / 提示块 / 引用 / 任务 / frontmatter 观感一致 | pass（shots/001） |
| 2 | 实时 vs 阅读（深色） | 同上，`?theme=dark` | 同上；frontmatter `name` 白色 700、`description` 灰色斜体 400、key 灰色 600，与阅读 computed 完全一致 | pass（shots/002，logs/fmcheck.py） |
| 3 | 光标进入表格 | dispatch selection 到表头单元格 | widget 消失，显示管道源码，行内代码仍着色 | pass（shots/003） |
| 4 | 光标进入代码块 | dispatch selection 到代码行 | 围栏与语言标签重新可见，仍在代码面板内 | pass（shots/004） |
| 5 | 单测 | `pnpm test` | 409 passed / 24 files（基线 368，+41：liveBlocks 34 项、livePreview 7 项） | pass |
| 6 | Rust | `cargo test` | 99 passed；2 项已知 Windows-only 失败不变 | pass |

## 证据截图

- [实时 vs 阅读（浅色）](shots/001-live-vs-read-light.png)
- [实时 vs 阅读（深色）](shots/002-live-vs-read-dark.png)
- [光标进表格显示源码](shots/003-active-table-reveals-source.png)
- [光标进代码块显示围栏](shots/004-active-code-shows-fences.png)
- harness 脚本：`logs/shot.py`（整页截图）、`logs/fmcheck.py`（frontmatter computed 对比）。harness 页面本身（`harness.html` + `src/dev/liveHarness.ts`）是一次性文件，已删除；需要复现时按 dts 调查过程里的描述重建：挂 `livePreview()` 的 CM6 编辑器 + 手写等价阅读 HTML，`window.__TAURI_INTERNALS__.invoke` 桩 `render_math` / `mermaid_asset_path`，`convertFileSrc` 返回 vite `/@fs` 路径。

## 复盘

- 想复用阅读样式就得借 `.md-body` 类名，但 `index.css` 把阅读壳层布局也挂在裸 `.md-body` 上；实时侧显式重置比改阅读壳层选择器风险小。后续若再往 `.md-body` 加布局规则，要同步看 `.rk-live .md-body`。
- CM6 样式模块挂载顺序与扩展顺序相反：**同等优先级下靠前的扩展赢**，靠「后面再写一条 inherit」覆盖高亮样式是行不通的，要么提高特异性，要么互斥加载。
- CM 把语法高亮 span 嵌在 mark 装饰 **内层**，mark 级 `color` 要配 `span { color: inherit }` 才能生效，之后再给链接 / 行内代码补更高特异性规则。
- 外接卷（/Volumes）上 vite 文件监听不可靠，改完 CSS / TS 必须 `--force` 重启才能看到新内容；截图前先 `curl` 确认服务端吐的是新代码，避免白排查。
