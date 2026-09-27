---
id: "feat-lifecycle_exit-unsaved-confirm"
domain: "feat-lifecycle"
slug: "exit-unsaved-confirm"
title: "补充退出检测文件是否变更，变更了则弹出提示是否保存；如果已经 Ctrl+S 保存过了需要怎么做"
status: "resolved"
created: "2026-09-27T18:09:44+08:00"
resolved: "2026-09-27T18:09:57+08:00"
commit: "aca1c1b"
branch: "main"
platform: "win32"
session: ""
---

# feat-lifecycle_exit-unsaved-confirm

## 问题

补充退出检测文件是否变更，变更了则弹出提示是否保存；如果已经 Ctrl+S 保存过了需要怎么做

## 环境

| 项 | 值 |
|----|----|
| git commit | aca1c1b |
| 分支 | main |
| 平台 | win32 |
| 建档时间 | 2026-09-27T18:09:44+08:00 |
| 会话 | - |

## 调查过程

- [18:09] 建档
- [18:09] 记录日志 (chat): 退出未保存确认：onCloseRequested 拦截 + 三选一弹窗，Ctrl+S 后自然不弹
- [18:09] 新增 E2E 用例: 退出未保存确认全路径
- [18:09] 记录证据 1 项
- [18:09] 记录终端文本快照
- [18:09] 结案

## 日志与摘录

### [chat] 2026-09-27T18:09:49+08:00 · 退出未保存确认：onCloseRequested 拦截 + 三选一弹窗，Ctrl+S 后自然不弹

```
退出未保存确认实现记录：

用户问题解答（内嵌在设计里）："已经 Ctrl+S 保存过怎么办"——不需要任何特殊处理。saveDoc 成功后清 dirtyRef，onCloseRequested 守卫看到干净状态直接放行关闭、不弹窗；自动保存开启时脏窗口期只有 1.5 秒（输入停止后自动落盘），所以弹窗实际很少出现。

实现（Rust 零代码改动，仅补 capability）
- App.tsx：getCurrentWindow().onCloseRequested(handler)——覆盖标题栏 ✕、Alt+F4、任务栏所有关闭路径（Tauri core 统一发 CloseRequested）。handler：exitApprovedRef 或 !dirtyRef.current → 不拦截（JS 封装内部 await destroy() 完成关闭）；脏 → event.preventDefault() + setExitAsk(true)
- 确认弹窗（modal-mask/modal 复用）三按钮：保存并退出（confirmExit(true)：清待执行自动保存 → saveDoc → 仍脏则保留应用并显示错误横幅 → exitApproved 置真 → close() 重发 CloseRequested 被守卫放行）；不保存退出（danger 红按钮，新增 .primary-btn.danger；appExitingRef 置真后 beforeunload 直接放行，防止"尽力保存"覆盖丢弃意图）；取消（仅关弹窗，窗口保持）
- beforeunload 从"关闭前尽力保存"改为仅覆盖 F5 刷新路径（appExitingRef 豁免退出流程）
- capabilities/default.json +core:window:allow-destroy：关键坑——onCloseRequested 的 JS 封装在 handler 未 preventDefault 时会内部调用 this.destroy()，而 core:default 不包含 allow-destroy，缺权限窗口关不掉；且 destroy 不重发 CloseRequested

窗口状态插件（tauri-plugin-window-state 2.4.1）确认双保险：WindowEvent::CloseRequested（lib.rs:448）+ RunEvent::Exit（lib.rs:503）两处都保存窗口状态，destroy 路径不丢位置尺寸。

验证
- pnpm test 218/218、pnpm build 通过
- cargo check 通过（capability JSON 经 tauri-build 校验）
- 提交：aca1c1b
- 人工回归点：X/Alt+F4 脏时弹窗、保存后关闭不弹窗、取消留在应用、不保存退出后文件未被写盘
```

## 测试场景与 E2E 用例

| # | 用例 | 步骤 | 预期 | 结果 |
|---|------|------|------|------|
| 1 | 退出未保存确认全路径 | 1. 编辑器改动文字不保存，点标题栏 ✕（Alt+F4 再试一次）2. 确认弹出确认弹窗且窗口未关 3. 选「取消」验证留在编辑器 4. 再关闭选「保存并退出」验证文件已写盘后窗口关闭 5. 改动后按 Ctrl+S 再关闭，验证不弹窗直接退出 6. 改动后选「不保存退出」，验证文件未被写盘 | 脏时三选一弹窗（保存并退出/不保存退出/取消）；干净时直接退出；取消留在应用；不保存退出后文件内容未变 | pass（构建与权限校验通过；GUI 交互待人工回归） |

## 证据截图

[文本快照: 验证快照：前端 218/218、构建通过、cargo check 通过（capability 校验）](shots/001-180953.txt)

## 修复方案

退出未保存确认落地：
1) App.tsx 注册 getCurrentWindow().onCloseRequested——Tauri core 对标题栏 ✕/Alt+F4/任务栏关闭统一发 CloseRequested，脏缓冲时 event.preventDefault() + 弹应用内三选一对话框（保存并退出/不保存退出/取消），干净缓冲直接放行关闭（内含答案：Ctrl+S 或自动保存已清 dirty 就不弹，无需额外处理）。
2) confirmExit(true)：清待执行自动保存 → saveDoc → 若仍脏（保存失败）保留应用并显示错误横幅 → exitApprovedRef 置真后 close() 重发事件被守卫放行；confirmExit(false)：appExitingRef 置真使 beforeunload 豁免（防止丢弃被尽力保存覆盖），同样 close() 放行。
3) beforeunload 收窄为 F5 刷新路径兜底。
4) capabilities 补 core:window:allow-destroy——onCloseRequested 的 JS 封装在放行时内部走 destroy()，core:default 不含该权限。
验证：pnpm test 218/218、pnpm build、cargo check 全过；提交 aca1c1b。

## 复盘

复盘：
1) Tauri v2 的"关闭拦截"有两层：JS 的 onCloseRequested 实际是 listen(tauri://close-requested) 的封装，未 preventDefault 时由封装内部 await destroy() 完成真正关闭——所以必须补 core:window:allow-destroy 权限（core:default 不含），否则表现为"点了关闭没反应"且无报错，排查方向极易跑偏。
2) destroy() 不会重发 CloseRequested，确认后重新关闭要么 destroy、要么置放行标志再 close()；选后者配合守卫标志可复用同一条 JS 路径并保留 window-state 插件在 CloseRequested 时的保存时机（该插件同时在 RunEvent::Exit 兜底）。
3) "不保存退出"必须显式豁免 beforeunload 的尽力保存，否则现有的防丢改动兜底会反过来覆盖用户的丢弃意图——退出流程里"谁来写盘"必须只有一个决策者。
4) 用户问"已 Ctrl+S 保存过怎么办"本质是问脏标记语义：保存成功即清 dirty，退出守卫天然放行——先把状态语义讲清，功能实现就只剩弹窗本身。
