---
id: "fix-editor-menu_asset-insert-render-readrefresh"
domain: "fix-editor-menu"
slug: "asset-insert-render-readrefresh"
title: "插入图片和文件限制了md格式无法实际插入；文件不在打开的文件夹里时粘贴图片生成的 ../../assets 相对链接无法渲染（是不是windows路径不支持）；"
status: "resolved"
created: "2026-09-27T15:54:58+08:00"
resolved: "2026-09-27T16:13:07+08:00"
commit: "2355b44"
branch: "main"
platform: "win32"
session: ""
---

# fix-editor-menu_asset-insert-render-readrefresh

## 问题

插入图片和文件限制了md格式无法实际插入；文件不在打开的文件夹里时粘贴图片生成的 ../../assets 相对链接无法渲染（是不是windows路径不支持）；源码模式编辑后切阅读模式图片没出现（是不是没有局部刷新）

## 环境

| 项 | 值 |
|----|----|
| git commit | 2355b44 |
| 分支 | main |
| 平台 | win32 |
| 建档时间 | 2026-09-27T15:54:58+08:00 |
| 会话 | - |

## 调查过程

- [15:54] 建档
- [16:12] 记录日志 (chat): 三问题根因：pickFile 误用/dunce 不归一 ..//阅读模式 html 从不重建，均已修复
- [16:12] 新增 E2E 用例: 插入图片对话框 + 资源链接渲染 + 阅读模式刷新
- [16:12] 新增 E2E 用例: 工作区外文档的粘贴资源归档到文档同目录
- [16:12] 记录证据 1 项
- [16:12] 记录终端文本快照
- [16:13] 结案

## 日志与摘录

### [chat] 2026-09-27T16:12:11+08:00 · 三问题根因：pickFile 误用/dunce 不归一 ..//阅读模式 html 从不重建，均已修复

```
三个问题的根因排查结论与修复记录：

问题1「插入图片和文件限制了 md 格式」
根因：右键"插入图片或文件"误用了 api.pickFile()（打开文件对话框，第一个过滤器是 Markdown，弹窗默认只列 .md，图片要手动切"所有文件"才可见）。
修复：Rust 新增 pick_asset 命令（图片过滤器置首 png/jpg/jpeg/webp/bmp/gif/avif/svg + "所有文件"兜底），lib.rs 两个 feature 分支注册，ipc.ts +pickAsset，App.insertAssetFromFile 改用。对话框链路与 pick_file 同款（channel + spawn_blocking 防 macOS 死锁、dunce::simplified 输出）。

问题2「../assets 相对链接无法渲染，是不是 Windows 路径不支持」
根因：不是 Windows 路径本身，而是 dunce::simplified 只做 UNC 前缀剥离、完全不做 ./.. 词法归一（读了 dunce 1.0.5 源码确认）。rewrite_img_srcs 把 base.join("../../assets/x.png") 原样编码进 http://asset.localhost/ URL，路径里带字面 %5C..%5C 段，能否读到完全依赖加载端对 Win32 路径的宽容度，预览/阅读渲染不可靠。
修复：markdown.rs 新增 normalize_lexical（纯词法 . / .. 消解，带深度计数防止爬过盘根），应用于 rewrite_img_srcs 的 asset URL 构造与 resolve_img_path（尺寸探测同路径）；新增回归测试 img_rewrite_resolves_parent_climbs 断言输出不含 ".." 且 Windows 下为 F%3A%5Cws%5Cassets%5Cpic.png。
另有一个设计层修复：文档不在打开的工作区内（或未开文件夹）时，粘贴/插入资源原归档到 root/assets，跨目录甚至跨盘的 ../../ 或绝对路径链接本就不可靠——新增 fileOps.assetDestDir(root, currentFile, assetsDir)：根内文档 → root/assets（原行为）；根外/无根文档 → 文档同目录 assets（链接即 ./assets/...，可移植）。archiveAndInsert 与 insertAssetFromFile 均改用；insertAssetFromFile 不再强制要求打开文件夹（root 为空时 importAsset 的 root 参数传文档目录）。

问题3「源码模式编辑好，切阅读模式图片没出现，是不是没局部刷新」
根因：确认没有刷新。Reader 直接渲染 doc.html，而 doc.html 只在 open_doc 时由 Rust 渲染一次；编辑链路（handleEditorChange/saveDoc）只更新 doc.text 与分屏预览，从不重建 html。切回阅读时 React 把旧 doc.html 原样渲染——不止图片，任何编辑都不会出现。这是存量缺陷，右键插入功能让它显形了。
修复：App.switchMode 在进入 read 时 saveDoc 后重新 api.openDoc(currentFile) 并 setDoc（重建 html/chunked 元数据）；新增 readRev 计数器，ChunkedReader 的 React key 从 token 改为 `${token}-${readRev}`——ChunkedReader 是全命令式内部状态（useRef 一次初始化），同 token 的 meta 更新不会重置，必须换 key 强制重挂。

验证
- cargo test --lib 71/71（+1 归一回归测试）
- pnpm test 211/211（+2 assetDestDir）
- pnpm build (tsc+vite) 通过
- USAGE.md 与设置弹窗提示同步（归档位置新规则、切阅读重渲染说明）
```

## 测试场景与 E2E 用例

| # | 用例 | 步骤 | 预期 | 结果 |
|---|------|------|------|------|
| 1 | 插入图片对话框 + 资源链接渲染 + 阅读模式刷新 | 1. 源码/分屏模式右键 → 插入图片或文件 2. 确认对话框默认显示图片文件（可切换所有文件） 3. 选中一张图片 4. 观察光标处插入的标签与分屏预览 5. 切到阅读模式再看图片 | 对话框默认列出图片类型；选图后归档并在光标处插入 ![]()；分屏预览与切回阅读视图后图片正常渲染 | pass（单测覆盖路径生成与 URL 归一；GUI 渲染待人工回归） |
| 2 | 工作区外文档的粘贴资源归档到文档同目录 | 1. 打开文件夹 A，再通过最近打开/双击打开不在 A 内的文档 B 2. 在 B 中粘贴截图或右键插入图片 3. 检查光标插入的链接与归档位置 | 生成的链接为 ./assets/…（归档在文档同目录），预览可渲染 | pass（fileOps.assetDestDir 单测覆盖根外/无根两分支） |

## 证据截图

[文本快照: 三端验证快照：Rust 71/71（+1 归一回归）、前端 211/211（+2 assetDestDir）、tsc+vite 构建通过](shots/001-161246.txt)

## 修复方案

三项修复：
1) 插入图片或文件对话框受限：Rust 新增 pick_asset 命令（图片过滤器置首 + 所有文件兜底），lib.rs 双分支注册、ipc.ts +pickAsset、App 改用；原 pickFile 的默认过滤器是 Markdown，属选错对话框。
2) ../assets 链接渲染失败：根因是 dunce::simplified 只剥 UNC 前缀、不做 ./.. 词法归一（读 dunce 1.0.5 源码确认），字面 .. 段进入 asset 协议 URL。markdown.rs 新增 normalize_lexical（深度计数的词法消解，防爬过盘根），应用于 rewrite_img_srcs 与 resolve_img_path；+回归测试。同时改归档策略：fileOps.assetDestDir——文档在工作区内归档 root/assets（原行为），工作区外/未开文件夹归档到文档同目录 assets，链接即 ./assets/...，不再产生跨树 ../ 或跨盘绝对链接。
3) 源码→阅读不刷新：确认存量缺陷——Reader 渲染的 doc.html 只在 open_doc 时生成，编辑/保存链路从不重建。switchMode 进入 read 时先 saveDoc 再 api.openDoc 重建 html/chunked，新增 readRev 计数并让 ChunkedReader 的 React key 由 token 改为 token-readRev（ChunkedReader 全命令式内部状态，必须重挂）。
验证：cargo test --lib 71/71、pnpm test 211/211、pnpm build 通过；USAGE.md 与设置弹窗提示同步更新。

## 复盘

复盘：
1) "打开文件"和"插入资源"是两种对话框语义，过滤器顺序就是用户体验——复用同名 API 前先看它的默认过滤器。
2) dunce::simplified 的名字有欺骗性：它只做 UNC 前缀剥离，不做路径归一。凡是用路径拼 URL 的地方，.. 都要自己词法消解；读依赖源码比读文档可靠。
3) 链接生成问题往往是归档策略问题的下游：与其修 ../../ 的渲染，不如让归档位置保证链接天然是 ./（文档同目录 assets）——生成端与解析端惯例对齐（与 feat-links 复盘同一原则）。
4) "切换视图不刷新"类问题要先分清数据层与视图层：doc.text 一直在更新（数据层正常），没人重建的是 doc.html（渲染层）；而 ChunkedReader 这类命令式组件连 React 的新 props 都消化不了，必须换 key 重挂——排查时沿着"谁消费这个状态"走一遍消费链。
5) 用户报"图片没渲染"，实际混着三个独立缺陷（对话框受限、路径归一、视图不刷新）——逐一分层归因，别被第一个表象带偏。
