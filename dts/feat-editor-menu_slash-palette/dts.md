---
id: "feat-editor-menu_slash-palette"
domain: "feat-editor-menu"
slug: "slash-palette"
title: "编辑模式下\"/\"和\"、\"可以和思源一样，快捷打开配方面板，也就是和右键差不多的功能，但是不需要粘贴，剪切，复制和新建子文档引用"
status: "resolved"
created: "2026-09-27T17:45:35+08:00"
resolved: "2026-09-27T17:46:28+08:00"
commit: "2355b44"
branch: "main"
platform: "win32"
session: ""
---

# feat-editor-menu_slash-palette

## 问题

编辑模式下"/"和"、"可以和思源一样，快捷打开配方面板，也就是和右键差不多的功能，但是不需要粘贴，剪切，复制和新建子文档引用

## 环境

| 项 | 值 |
|----|----|
| git commit | 2355b44 |
| 分支 | main |
| 平台 | win32 |
| 建档时间 | 2026-09-27T17:45:35+08:00 |
| 会话 | - |

## 调查过程

- [17:45] 建档
- [17:45] 记录日志 (chat): "/"与"、"呼出插入面板：触发检测/选中控件/焦点归还全链路实现
- [17:46] 新增 E2E 用例: 斜杠面板：/ 与 、 呼出插入菜单
- [17:46] 记录证据 1 项
- [17:46] 记录终端文本快照
- [17:46] 结案

## 日志与摘录

### [chat] 2026-09-27T17:45:55+08:00 · "/"与"、"呼出插入面板：触发检测/选中控件/焦点归还全链路实现

```
斜杠面板（"/" 或 "、" 呼出插入菜单）实现记录：

结构
- 新建 src/editorMenuEntries.ts：CALLOUT_TYPES + buildEditorMenuEntries(includeClipboard) 从 App.tsx 抽出——context 变体（含剪切/复制/粘贴 + 新建子文档并引用）与 slash 变体（纯插入条目）共用一份清单，App 减重且可单测
- editorCommands.ts +slashTrigger(update)：docChanged 且 update.transactions.some(tr => tr.isUserEvent("input.type"))，光标前一字符为 "/" 或 "、" 则返回 {pos, char}。关键坑：**ViewUpdate 没有 userEvent 属性**（undefined），正确读法是遍历 update.transactions 用 Transaction.isUserEvent()（前缀语义，"input.type.compose" 也命中）；isUserEvent 过滤天然排除程序化插入（我们的命令是 input.insert/input.format）、粘贴（input.paste）、撤销（undo），IME 组合的 "、" 是 input.type 一样命中
- SourceEditor.tsx：+onSlashTrigger prop，在既有 updateListener 里检测，view.coordsAtPos(pos) 取光标视口坐标（left/bottom+2 作为锚点）
- App.tsx：slashMenu 独立 state + 第三个 ContextMenu 实例；handleSlashTrigger 打开时互斥关闭文件树/编辑器菜单；runSlashAction 先 runCommand 删除触发字符（带 sliceDoc 字符校验防错删）再复用 runEditorActionRef 分发；键入即关面板的 window keydown capture（key.length===1 或 Backspace/Delete 关闭；导航键/Enter/Tab/Esc/修饰键排除），关闭可打印键时同步 runCommand(()=>{}) 把焦点还给编辑器——keydown 的默认动作在分发完成后落点于当时焦点元素，同步 refocus 使该字符仍打进文档；compositionend 兜底关闭（面板开着时继续打中文）

行为语义（对齐思源、无过滤版）
- 选条目：触发符被消费，不残留 "/表格"
- 继续打字/Esc/点击面板外/滚动编辑器：面板关闭，触发符保留为普通文本
- 连续打 "/"：关闭后重新打开（每次 / 都触发，与思源一致）

验证
- pnpm test 218/218（+4 editorMenuEntries 变体/彩点、+3 slashTrigger 经真实 EditorView updateListener 捕获；测试中 dispatch 必须带 selection 模拟打字光标跟随，否则 head 不动检测不到）
- pnpm build (tsc+vite) 通过
- 无 Rust 改动

已知边界（后续可迭代）
- 无输入过滤（思源继续输入会过滤菜单项）；本版继续输入=关闭面板
- Esc 关闭后焦点不自动回编辑器（点击即可回）
```

## 测试场景与 E2E 用例

| # | 用例 | 步骤 | 预期 | 结果 |
|---|------|------|------|------|
| 1 | 斜杠面板：/ 与 、 呼出插入菜单 | 1. 源码/分屏模式编辑器内键入 / 2. 观察面板在光标处弹出且无剪贴板/新建子文档条目 3. 选「表格」确认 "/" 被移除且表格模板插入 4. 再键入 、选「提示块 - Note」验证 IME 触发 5. 键入 / 后直接继续打字验证面板关闭且字符落入文档 | 光标处弹出插入面板（不含剪切/复制/粘贴/新建子文档），选择条目后触发符被移除并插入对应语法；Esc/继续输入/点击外部可关闭 | pass（editorMenuEntries 变体 + slashTrigger 单测覆盖；GUI 交互待人工回归） |

## 证据截图

[文本快照: 验证快照：218/218（+7 新用例）、tsc+vite 构建通过、零 Rust 改动](shots/001-174610.txt)

## 修复方案

斜杠面板落地：编辑器内键入 "/" 或 "、"（含中文输入法）在光标处弹出插入面板，条目=右键菜单插入类全集（标题/列表/引述/提示块/代码块/表格/分隔线/公式块/思维导图/行内格式/媒体链接），按要求不含剪切/复制/粘贴与新建子文档并引用。
1) 抽出 src/editorMenuEntries.ts：buildEditorMenuEntries(includeClipboard) 同时供右键菜单（true）与斜杠面板（false），清单单一来源。
2) editorCommands.slashTrigger：经 update.transactions.some(tr => tr.isUserEvent("input.type")) 判定真实键入（排除程序化插入/粘贴/撤销），光标前一字符为 "/" 或 "、" 即触发——IME 组合的 "、" 也是 input.type，天然支持。
3) SourceEditor +onSlashTrigger（coordsAtPos 锚定光标），App 第三个 ContextMenu 实例 + 互斥关闭其他菜单。
4) 选中条目先删触发符（sliceDoc 字符校验防错删）再插入；继续键入即关面板并同步把焦点还回编辑器（keydown 默认动作随当时焦点落点，同步 refocus 让该字符仍打进文档）；Esc/点击外/滚动由 ContextMenu 既有机制关闭。
验证：pnpm test 218/218（+7 新用例，slashTrigger 经真实 EditorView 捕获）、pnpm build 通过、零 Rust 改动。

## 复盘

复盘：
1) CodeMirror 6 的 ViewUpdate 没有 userEvent 属性（一直是 undefined）——读用户事件必须遍历 update.transactions 用 tr.isUserEvent(name)（前缀匹配）；这种"直觉 API 不存在"的问题靠打印真实 update 才能实锤，别对着想象中的 API 写代码。
2) 测试里模拟打字时 dispatch 必须带 selection（真实打字光标跟随插入），否则 head 不动、检测逻辑"看起来坏了"其实是测试环境失真。
3) 菜单抢焦点与继续输入是天然矛盾：ContextMenu 自动聚焦首项让键盘导航可用，代价是后续按键落不到编辑器——解法是关闭面板的 keydown 捕获里同步 refocus，利用"keydown 默认动作在分发完成后才执行"的时机让该字符仍落进文档。
4) 两种入口（右键/斜杠）共用一份条目清单后，测试直接锁"slash 变体不含哪几项、含哪几项"，未来加条目两处自动同步。
