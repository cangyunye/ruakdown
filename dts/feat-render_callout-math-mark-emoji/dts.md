---
id: "feat-render_callout-math-mark-emoji"
domain: "feat-render"
slug: "callout-math-mark-emoji"
title: "推进二期：GitHub 提示块解析渲染、公式渲染、==标记== 补齐分屏预览/导出、表情选择面板"
status: "resolved"
created: "2026-09-27T19:13:13+08:00"
resolved: "2026-09-27T19:13:30+08:00"
commit: "e6c04ef"
branch: "main"
platform: "win32"
session: ""
---

# feat-render_callout-math-mark-emoji

## 问题

推进二期：GitHub 提示块解析渲染、公式渲染、==标记== 补齐分屏预览/导出、表情选择面板

## 环境

| 项 | 值 |
|----|----|
| git commit | e6c04ef |
| 分支 | main |
| 平台 | win32 |
| 建档时间 | 2026-09-27T19:13:13+08:00 |
| 会话 | - |

## 调查过程

- [19:13] 建档
- [19:13] 记录日志 (chat): 二期渲染落地：统一 post_process_events（Gfm alert 原生 + latex2mathml + ==mark==）+ 表情面板，四管线一致
- [19:13] 新增 E2E 用例: 二期渲染四管线一致性 + 表情面板
- [19:13] 记录证据 1 项
- [19:13] 记录终端文本快照
- [19:13] 结案

## 日志与摘录

### [chat] 2026-09-27T19:13:21+08:00 · 二期渲染落地：统一 post_process_events（Gfm alert 原生 + latex2mathml + ==mark==）+ 表情面板，四管线一致

```
二期渲染补齐实现记录（v0.10.0 已发布的插入语法层，现在四管线全部真实渲染）：

调研结论（决定方案的关键事实）
- pulldown-cmark 0.13：`ENABLE_GFM` 原生解析 GitHub 块引用提示块（Tag::BlockQuote(Some(kind)) → html.rs 直接输出 <blockquote class="markdown-alert-*">，标记行被解析器消费）；`ENABLE_MATH` 只把 $…$ / $$…$$ 切成 InlineMath/DisplayMath 事件（**给的是原始 TeX，不转 MathML**，html.rs 只输出 <span class="math math-x">TeX</span>）
- 两条渲染管线共用 md_options() 与 highlight_code_events：render_markdown（阅读/导出/分享）与 large_doc::finish_block（分屏预览/分块阅读）；export.rs 与 serve.rs 均复用前者 → 后处理统一一处即四端一致

实现
- Cargo：+latex2mathml 0.2.3（纯 Rust LaTeX→MathML，无 JS 引擎/字体资产）
- markdown.rs：md_options 增 ENABLE_GFM/ENABLE_MATH；新增统一 post_process_events = mark_events(math_events(highlight_code_events))，顺序即依赖（代码先转 raw HTML，保证代码内容永不被当数学/标记处理）；math_html：latex_to_mathml 成功输出 <span class="math math-inline|display"><math…>，失败回退 math-raw span（escape 原文 + title 提示）；mark_text_html：纯文本按 ==…== 包裹 <mark>（内容不得含 = 或换行、空内容作 literal，与原前端 DOM 后处理语义一致）
- large_doc.rs：finish_block 改用 post_process_events（分块与全文输出保持字节一致，既有 large_doc 一致性测试全过）
- 前端：删除被取代的 zen.ts applyMarkSyntax 与 Reader 调用（Rust 单一实现，导出/分享也获得标记渲染）
- md-content.css：五种提示块的左边框色+::before 标题（Note/Tip/Important/Warning/Caution，GitHub 配色）+ 基础背景；.math-inline/.math-display（display:block 居中可横向滚动）/.math-raw 等宽回退样式。该 CSS 被应用内、导出（include_str 内联）、LAN 分享共用
- 表情面板：src/emoji.ts（7 类约 250 个 [emoji,中文名]）+ components/EmojiPicker.tsx（分类页签+网格，不抢焦点与斜杠面板同规则，Esc/外部点击/滚动关闭，选择后保持打开可连插）+ index.css 样式；菜单入口 editorMenuEntries 两变体共享「表情」（icon 🙂），App 用 menuAnchorRef（最近一次编辑器菜单/斜杠面板的坐标）锚定面板，picked 即 insertAtCursor

验证
- cargo test --lib 78/78（+7：五种 alert class 与标记行不泄漏、普通引用不受影响、行内/块级公式 MathML、不可解析 TeX 回退、mark 包裹且代码内 == 不受影响、====/==a=b== 保持字面、导出 HTML 携带 alert+mark+math 且 CSS 同步内联）
- pnpm test 231/231（+4：EmojiPicker 选择/换分类/Esc 与外部关闭/不抢焦点；菜单变体含 emoji）；pnpm build 通过
- 四管线一致性由构造保证（同一 render_markdown / 同一 post_process_events / 同一 MD_CONTENT_CSS），导出另有真实断言

已知边界
- ==x== 跨行或含 = 不解析（与替换掉的前端实现语义一致）；公式解析失败回退原文
- 启用 ENABLE_MATH 后，正文中成对的 $ 会按数学解析（标准取舍，USAGE 已说明）；不可解析时回退可见
- GUI 人工回归点：阅读/分屏/导出/分享四处看提示块卡片、公式排版（MathML 在 WebView2/现代浏览器原生渲染）、==高亮==、表情面板插入
```

## 测试场景与 E2E 用例

| # | 用例 | 步骤 | 预期 | 结果 |
|---|------|------|------|------|
| 1 | 二期渲染四管线一致性 + 表情面板 | 1. 文档写入 > [!WARNING] + 内容，阅读/分屏预览看五色卡片 2. 写入 $a^2+b^2=c^2$ 与 $$\frac{1}{2}$$ 看 MathML 排版 3. 写入 ==高亮== 与代码块内 ==字面== 对比 4. 导出 HTML 在浏览器打开复核同样效果 5. 斜杠面板选「表情」插入数个 emoji 后继续输入 | 四端（阅读/分屏预览/导出 HTML/局域网分享）提示块呈五色卡片带标题、公式以 MathML 排版、==高亮== 高亮；代码块内 == 与 $ 不受影响；表情面板可连续插入 | pass（Rust 78/78 含导出断言 + 前端 231/231；GUI 渲染待人工回归） |

## 证据截图

[文本快照: 验证快照：Rust 78/78（+7）、前端 231/231（+4）、tsc+vite 构建通过](shots/001-191324.txt)

## 修复方案

二期渲染补齐（四管线一致：阅读 / 分屏预览 / 导出 HTML / LAN 分享）：
1) 提示块：md_options 启用 pulldown-cmark 的 ENABLE_GFM，五种 GitHub 提示块原生解析为 <blockquote class="markdown-alert-*">；md-content.css 补五色左边框 + ::before 标题（Note/Tip/Important/Warning/Caution）。
2) 公式：启用 ENABLE_MATH 得到 InlineMath/DisplayMath 事件（pulldown 只给原始 TeX），新增 latex2mathml 0.2.3 纯 Rust 转 MathML（无 JS 引擎/字体资产，导出零依赖），失败回退 math-raw 样式显示原文。
3) ==标记==：Rust 事件级实现 mark_text_html 包裹 <mark>，删除原仅阅读视图生效的前端 applyMarkSyntax——导出与分享同时获得标记渲染。
关键结构：新增统一 post_process_events（code → math → mark，顺序即依赖），render_markdown 与 large_doc::finish_block 共用，导出/分享复用同一 CSS（MD_CONTENT_CSS）。
4) 表情面板：src/emoji.ts 数据（7 类约 250 个，中文名 tooltip）+ EmojiPicker 组件（分类页签+网格，不抢焦点、Esc/外点/滚动关闭、选择后可连插）+ 两套菜单共享「表情」入口（icon 🙂），App 用 menuAnchorRef 锚定。
验证：cargo 78/78（+7 含导出断言）、pnpm 231/231（+4 EmojiPicker）、构建通过、large_doc 字节一致性测试保持全过。

## 复盘

复盘：
1) 先摸依赖的真实能力再定方案：计划里设想"pulldown-cmark math feature 直接输出 MathML"，读源码发现它只做分词（事件给原始 TeX）——若不先核实，方案会在实现中途推倒。alert 则相反：原生支持到 class 级别，直接用。
2) 多管线渲染的一致性靠"单一后处理链 + 单一选项源 + 单一 CSS"的构造保证，而不是逐端补丁：两处 push_html 调用点收敛到一个 post_process_events 后，四端自动一致，没写一行分享代码。
3) 事件级处理的顺序就是约束：code 必须先转 raw HTML，否则代码里的 == 和 $ 会被后续 pass 误伤（与前端 DOM 版的"跳过 pre/code"等价，但更彻底）。
4) 替换实现时要删干净旧路径（前端 applyMarkSyntax 全删），双实现并存迟早分叉；顺带让导出/分享获得此前缺失的标记渲染。
5) 新依赖选型优先"纯 Rust、零运行时资产"：MathML 方案让导出文件不背字体包，WebView2 与主流浏览器原生排版；KaTeX 的字体资产与导出内联问题仅在观感确实不达标时再引入。
