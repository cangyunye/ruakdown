---
id: "feat-sidebar_file-tree-rightclick-web-menu"
domain: "feat-sidebar"
slug: "file-tree-rightclick-web-menu"
title: "侧边文件导航栏里对文件右键，弹出的是网页端默认右键菜单（遗留行为），需要改成编辑器级右键菜单，至少要有\"打开文件所在位置\"和复制粘贴等基本功能；先评估还能补充哪"
status: "resolved"
created: "2026-09-27T12:03:21+08:00"
resolved: "2026-09-27T12:44:11+08:00"
commit: "2355b44"
branch: "main"
platform: "win32"
session: ""
---

# feat-sidebar_file-tree-rightclick-web-menu

## 问题

侧边文件导航栏里对文件右键，弹出的是网页端默认右键菜单（遗留行为），需要改成编辑器级右键菜单，至少要有"打开文件所在位置"和复制粘贴等基本功能；先评估还能补充哪些功能

## 环境

| 项 | 值 |
|----|----|
| git commit | 2355b44 |
| 分支 | main |
| 平台 | win32 |
| 建档时间 | 2026-09-27T12:03:21+08:00 |
| 会话 | - |

## 调查过程

- [12:03] 建档
- [12:07] 记录日志 (chat): 确认右键问题根因（无任何 contextmenu 拦截）并盘点可复用能力与缺口
- [12:43] 记录日志 (chat): P0+P1+目录内搜索已实现，三层验证全绿
- [12:43] 记录证据 1 项
- [12:43] 记录终端文本快照
- [12:44] 结案

## 日志与摘录

### [chat] 2026-09-27T12:07:12+08:00 · 确认右键问题根因（无任何 contextmenu 拦截）并盘点可复用能力与缺口

```
排查结论：
1. 全应用（src/）没有任何 contextmenu 事件处理（grep 无结果），文件树 FileTree.tsx 的行按钮只绑了 onClick，右键直接落到 WebView2 默认网页菜单（刷新/另存为/检查等），即用户看到的"网页端右键遗留"。
2. 可复用基础已具备：v0.9.0 TitleBar.tsx 有成熟 Dropdown 菜单模式（.tb-menu 样式、点击外部关闭、键盘导航）；@tauri-apps/plugin-opener 已依赖且 JS 端有 revealItemInDir/openPath/openUrl；dialog 插件已接入；后端 watch_folder + App.tsx refreshTree(App.tsx:1117) 已实现外部变更自动刷新树——新增文件操作命令后树会自动更新。
3. 后端（commands.rs）只有读/保存能力（load_tree/save_file），无新建/重命名/删除/复制文件命令，文件管理类菜单项需新增 Rust 命令。
4. 文件树只显示目录和 .md/.markdown（core/file.rs is_markdown），非 Markdown 文件不出现，"用系统程序打开"意义有限。
5. 剪贴板：无 clipboard 插件；文件级复制粘贴（CF_HDROP）需 Rust 端额外 crate，成本较高，可先以"应用内复制/粘贴 + 创建副本"语义替代。
```

### [chat] 2026-09-27T12:43:45+08:00 · P0+P1+目录内搜索已实现，三层验证全绿

```
实现与验证记录：

改动清单
- src-tauri/src/core/fsops.rs(新增)：名字校验(镜像 Windows 规则)、ensure_inside 越界防护、" - 副本/- 副本 (n)"重名自动避让、递归 copy_dir_all、copy_entries/move_entries，含 4 个单元测试
- src-tauri/src/commands.rs：create_file(create_new 防覆盖)/create_dir/rename_entry(目标存在即拒)/trash_entry(trash crate 走回收站)/copy_entries/move_entries 六命令，均 spawn_blocking + 根目录包含校验
- src-tauri：lib.rs 两套 feature 分支均注册；Cargo.toml 加 trash = "5"；capabilities 加 opener:allow-reveal-item-in-dir
- src/fileOps.ts(新增)+测试：路径拆合、相对路径、.md 后缀、前端名字校验(与 Rust 镜像)、树查找
- src/components/ContextMenu.tsx(新增)+测试：fixed 定位+视口钳制、复用 .tb-menu 视觉、Esc/外点/滚动/失焦关闭、↑↓ 导航、危险项红、禁用项
- FileTree.tsx 重写：行级 onContextMenu(data-path/data-dir)、行内重命名输入(选中基名)、new-file/new-dir 草稿行(目标文件夹自动展开)、空状态兼容
- Sidebar.tsx：透传树编辑 props + 空白区右键(node=null)
- QuickOpen.tsx：新增 initialQuery 预填(供"在目录内搜索该文件")
- App.tsx：全局 contextmenu 抑制(input/textarea/contenteditable/.cm-editor 保留原生)、菜单构建与 14 个动作、应用内复制/剪切/粘贴(clipRef)、删除 window.confirm+回收站+活动文件关闭、重命名同步 currentFile/recentFiles/lastFile、rescanTree 即时刷新(watcher 兜底)、F2 重命名活动文件、Delete 键删焦点行、reveal 根目录用 openPath/条目用 revealItemInDir
- index.css：.ctx-menu 定位与 danger/disabled 态、.tree-rename 行内输入样式

验证
- pnpm test：166/166 通过(新增 fileOps 6 + ContextMenu 5 + FileTree 8)
- pnpm build(tsc + vite)：通过
- cargo test --lib：68 通过(含 fsops 4)，cargo check 干净
```

## 测试场景与 E2E 用例

| # | 用例 | 步骤 | 预期 | 结果 |
|---|------|------|------|------|

## 证据截图

[文本快照: 终端验证快照：前端测试/构建与 Rust 测试结果](shots/001-124345.txt)

## 修复方案

侧边栏文件树从"无任何 contextmenu 处理(直落 WebView2 网页菜单)"改为完整编辑器级右键菜单体系：
1) 新组件 ContextMenu(fixed 定位+视口钳制、Esc/外点/滚动/失焦关闭、↑↓ 键盘导航、危险项红色)，复用标题栏 .tb-menu 视觉语言保持一致性；
2) 文件行菜单：打开/在资源管理器中显示/在目录内搜索该文件(QuickOpen 内容模式预填文件名，找引用)/复制路径·相对路径·文件名/重命名(F2)/创建副本/复制/剪切/删除(回收站+确认)；文件夹行：新建 Markdown 文件/新建文件夹/打开/重命名/副本/复制/剪切/粘贴/删除；空白区：新建/在资源管理器中打开(openPath)/刷新/粘贴；
3) 后端新增 core/fsops.rs + 六个 Tauri 命令(create_file 用 create_new 防覆盖、rename 目标存在即拒、trash_entry 走 trash crate 回收站、copy/move_entries 带 "- 副本" 重名避让与"文件夹粘贴进自身"防护)，所有路径做工作区包含校验；
4) 行内重命名/新建输入：自动聚焦并预选基名、Enter 提交/Esc 取消/失焦智能处理、与 Rust 镜像的名字校验+同级重名即时提示；活动文件重命名后同步 currentFile/recentFiles/持久化配置；
5) 全局 contextmenu 抑制，但 input/textarea/contenteditable 与 CodeMirror(.cm-editor) 保留原生菜单；F2 重命名活动文件、Delete 键删除焦点树行(带确认)。树刷新走即时 rescanTree + 既有 watcher 兜底。

## 复盘

根因：文件树组件只绑了 onClick，全应用从未拦截 contextmenu，右键自然落到 WebView2 默认网页菜单——这是功能缺口而非平台限制。
教训/踩坑：
1) Tauri 前端"网页感"细节(右键/焦点/键盘)需要逐点显式处理，默认 webview 行为与桌面应用预期差距大；
2) 前端做一遍名字校验(UI 即时反馈)同时必须让 Rust 端再校验一遍(防绕过)，两端规则要镜像一致，测试成对写；
3) jsdom 中 requestAnimationFrame 不即时触发，组件初始聚焦直接用 useLayoutEffect 更可靠；
4) 测试里同一用例二次 render 记得 cleanup，否则 getByText 撞重复元素；
5) 删除/重命名要考虑"正在打开的文件"的同步：close doc、路径重映射、最近列表与持久化配置都要跟着动。
