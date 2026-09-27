---
id: "feat-editor-menu_context-menu-markdown-suite"
domain: "feat-editor-menu"
slug: "context-menu-markdown-suite"
title: "分析下，如果右键增加这些功能（思源笔记风格的右键菜单：块级插入/提示块/行内格式/媒体插入），当前是否可以实现"
status: "resolved"
created: "2026-09-27T15:21:15+08:00"
resolved: "2026-09-27T15:23:02+08:00"
commit: "2355b44"
branch: "main"
platform: "win32"
session: ""
---

# feat-editor-menu_context-menu-markdown-suite

## 问题

分析下，如果右键增加这些功能（思源笔记风格的右键菜单：块级插入/提示块/行内格式/媒体插入），当前是否可以实现

## 环境

| 项 | 值 |
|----|----|
| git commit | 2355b44 |
| 分支 | main |
| 平台 | win32 |
| 建档时间 | 2026-09-27T15:21:15+08:00 |
| 会话 | - |

## 调查过程

- [15:21] 建档
- [15:21] 记录日志 (chat): 右键菜单一期（插入语法层+焦点优先快捷键+子文档引用）实现完成
- [15:22] 记录证据 1 项
- [15:22] 记录终端文本快照
- [15:22] 新增 E2E 用例: 编辑器右键菜单一期：插入/切换语法与焦点优先快捷键
- [15:23] 结案

## 日志与摘录

### [chat] 2026-09-27T15:21:45+08:00 · 右键菜单一期（插入语法层+焦点优先快捷键+子文档引用）实现完成

```
编辑器右键菜单一期实现与验证记录（CodeMirror 6 源码编辑器，"插入/切换 Markdown 语法"形态）：

前提澄清（与探索期结论的差异）
- 分屏模式下也只有唯一 SourceEditor 实例（editorRef 单引用），无需焦点实例路由，只需跟踪"编辑器是否聚焦"
- 复用已有 feat-links 基建：insertAtCursor 句柄、saveAsset/importAsset TS 包装、fileOps 链接生成（relativeLinkHref/assetBaseName/mdImageTag/mdLinkTag）、归档管线（archiveAndInsert 同款流程），零后端改动

新增/改动
- src/editorCommands.ts（新）：纯函数命令层 planWrap/planInsertBlock/planTogglePrefix/planClearCallout（EditorState→EditPlan 可无 DOM 测试）+ 视图包装 toggleWrap/insertBlock/insertCodeBlock/insertTable/insertHr/insertMathBlock/insertMindmap/insertCallout/clearCallout/togglePrefix/insertLink/insertImageLink/insertIframe/insertVideo/insertAudio
  - planInsertBlock 按 CommonMark 空行隔离（防 "---" 紧贴段落变 setext 标题）：restOfLine 非空 → 后缀 "\n\n"，行尾 → "\n"（原换行已在插入点后，恰好补一个空行）
  - 块前缀切换语义：同类标记再按即移除；异类整体替换（BLOCK_PREFIX 正则归一）；有序列表按所选行重新编号；空选区插入后光标落在标记后
- src/components/SourceEditor.tsx：SourceEditorHandle +runCommand(fn(view))（执行后 view.focus() 归还焦点）；+onFocusChange 上报（contentDOM focus/blur）；keymap 增 16 组编辑器和弦（Mod-b/i/u/m/k/l/o/`/'、Mod-Shift-s/k、Alt-d、Mod-Alt-1..6）
- src/shortcuts.ts：ShortcutState +editorFocused；编辑器聚焦时 Ctrl+B（粗体优先于切侧栏）、Ctrl+O（表格优先于打开文件）、Ctrl+Shift+Z（重做优先于禅模式）放行给 CodeMirror（全局匹配器在 window capture 阶段先于编辑器执行，必须在此放行）
- src/components/ContextMenu.tsx：CtxEntry +icon/color（彩色圆点），前置槽与 tb-menu-check 同宽对齐
- src/App.tsx：.cm-editor 右键从"放行原生菜单"改为拦截并打开自绘菜单（首组剪切/复制/粘贴用 copyText+insertAtCursor 实现，粘贴走 navigator.clipboard.readText 失败则提示可直接 Ctrl+V）；editorMenu 独立 state+分发器（与文件树菜单互斥关闭）；新建子文档并引用弹层（entryNameError 同名校验 → createFile → 相对链接插入光标）；插入图片或文件 = pickFile → importAsset → isImagePath 分支插图链/文链；editorFocusedRef 在 onViewDestroy 显式清零（卸载不触发 blur）
- md-content.css：kbd 键帽/sup/sub/u 基础样式（HTML 透传已可渲染，只缺样式）；index.css：tb-menu-icon
- USAGE.md：第五章补"编辑器右键菜单"小节、第十二章补编辑器排版快捷键表并修订 Ctrl+B/O/Shift+Z 的焦点优先说明

范围裁剪（用户确认）
- 不做：页签块、标签 #tag#、嵌入 HTML 文件、![[..]] 嵌入语法（引用走标准链接）
- 分两期：一期插入语法层；二期渲染补齐（GitHub callout 解析渲染、KaTeX/pulldown-cmark math、==mark== 补分屏预览、表情面板）——期间提示块显示为普通引用块、公式为原文本

关键设计事实
- keymap 和弦冲突核查：defaultKeymap 中仅 Mod-i(selectParentSyntax) 被遮蔽（冷门，可接受）；Shift-Mod-k(deleteLine) 属 standardKeymap 未加载；historyKeymap 的 Mod-Shift-z 由全局放行后正常触发重做
- 粘贴菜单项依赖 WebView2 剪贴板读权限，失败有兜底提示；Ctrl+V 原生路径不受影响
```

## 测试场景与 E2E 用例

| # | 用例 | 步骤 | 预期 | 结果 |
|---|------|------|------|------|
| 1 | 编辑器右键菜单一期：插入/切换语法与焦点优先快捷键 | 1. 打开文档切到源码/分屏模式，点击编辑区使光标进入 2. 按 Ctrl+B 观察光标处语法与侧栏状态 3. 点击侧栏/标题栏让焦点离开编辑器 4. 再按 Ctrl+B | 编辑器内 Ctrl+B 插入粗体语法，不切换侧栏；焦点不在编辑器时 Ctrl+B 恢复切换侧栏；同理 Ctrl+O/Ctrl+Shift+Z | pass（shortcuts.test.ts + SourceEditor keymap 覆盖；应用内待人工回归） |

## 证据截图

[文本快照: 一期三层验证：vitest 209/209、tsc+vite 构建通过（Rust 端零改动，cargo 无需重跑）](shots/001-152229.txt)

## 修复方案

右键菜单一期落地（源码/分屏编辑器的"插入/切换 Markdown 语法"层）：
1) 新建 src/editorCommands.ts 纯函数命令层（planWrap/planInsertBlock/planTogglePrefix/planClearCallout 返回 EditPlan，可无 DOM 单测）+ 视图包装，覆盖 H1-H6/无序/有序/任务列表/引述切换（同类移除、异类替换、有序重编号）、代码块/表格/分隔线/公式块/mermaid 思维导图插入（CommonMark 空行隔离防 setext 误判）、GitHub 风格提示块（> [!NOTE] 等 5 种+清除）、行内格式（粗斜删除线/标记/上下标/下划线/键盘/行内代码/行内公式）、链接与图片/iframe/视频/音频链接（URL 占位自动选中）。SourceEditorHandle +runCommand，编辑器 keymap +16 组和弦。
2) 编辑器右键：App 的 contextmenu 抑制从放行 .cm-editor 改为拦截并打开自绘菜单（ContextMenu 组件 +icon/color 扩展），首组剪切/复制/粘贴自实现（粘贴读系统剪贴板失败时提示可直接 Ctrl+V）。
3) 快捷键焦点优先：shortcuts.ts +editorFocused 状态，编辑器聚焦时 Ctrl+B=粗体（非切侧栏）、Ctrl+O=表格（非打开文件）、Ctrl+Shift+Z=重做（非禅模式）；onViewDestroy 显式清零焦点标志（卸载不触发 blur）。
4) 新建子文档并引用：命名弹层（entryNameError 同名校验）→ createFile 同目录建 .md → 光标插入 [标题](./文件.md) 相对链接。
5) 插入图片或文件：pickFile → importAsset 归档 assets（复用 feat-links 管线）→ 按扩展名插图链/文链。
6) md-content.css 补 kbd/sup/sub/u 样式；USAGE.md 补第五/十二章。
二期（渲染补齐）已与用户约定：GitHub callout 解析渲染、公式渲染（pulldown-cmark math 优先）、==mark== 补分屏预览、表情面板。验证：vitest 209/209、tsc+vite build 通过，Rust 零改动。

## 复盘

复盘：
1) 探索结论要随实现进度复核——探索时 SourceEditorHandle 只有滚动句柄，动手时 feat-links 已落地 insertAtCursor/saveAsset/importAsset，复用后本特性后端零改动；开工前重读工作区现状比信任一次性调研更重要。
2) "分屏=两个编辑器"是误判，实际任意时刻只有一个 SourceEditor 实例（SplitView 单 editor 槽），焦点路由问题退化为一个布尔标志；设计前先确认真实的组件生命周期。
3) 全局快捷键挂在 window capture 阶段，必然先于 CodeMirror keymap——"编辑器内优先"必须改全局匹配器放行，而不是在编辑器 keymap 里抢。
4) CommonMark 空行隔离的坑："---" 紧贴上一段会被解析为 setext 标题；块插入的后缀逻辑要区分"光标行尾（原换行已在插入点后，补 1 个 \n 即得空行）"与"行中（补 \n\n）"，凭直觉会多出一个空行（测试抓住）。
5) 手写 HTML 模板的 select 偏移量容易漏数 `=` 等字符，用"插入后 sliceDoc 断言选中内容"的测试写法比数偏移可靠。
