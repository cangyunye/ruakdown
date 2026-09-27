---
id: "feat-links_bidirectional-links-asset-paste"
domain: "feat-links"
slug: "bidirectional-links-asset-paste"
title: "实现双向互引三件套：文件树右键\"复制 Markdown 链接 / 插入链接到当前文档光标处\"；复制的文件可粘贴进编辑器（源码/分屏），系统剪贴板文件/截图粘贴后"
status: "resolved"
created: "2026-09-27T14:23:32+08:00"
resolved: "2026-09-27T14:36:48+08:00"
commit: "2355b44"
branch: "main"
platform: "win32"
session: ""
---

# feat-links_bidirectional-links-asset-paste

## 问题

实现双向互引三件套：文件树右键"复制 Markdown 链接 / 插入链接到当前文档光标处"；复制的文件可粘贴进编辑器（源码/分屏），系统剪贴板文件/截图粘贴后归档到 assets 并插入 ![img](./assets/文档名前10字符_时间戳.扩展名) 标签；assets 目录进配置（默认 assets，相对工作区根，可改）

## 环境

| 项 | 值 |
|----|----|
| git commit | 2355b44 |
| 分支 | main |
| 平台 | win32 |
| 建档时间 | 2026-09-27T14:23:32+08:00 |
| 会话 | - |

## 调查过程

- [14:23] 建档
- [14:36] 记录日志 (chat): 互引三件套+assets 归档实现完成，三层验证全绿
- [14:36] 记录证据 1 项
- [14:36] 记录终端文本快照
- [14:36] 结案

## 日志与摘录

### [chat] 2026-09-27T14:36:23+08:00 · 互引三件套+assets 归档实现完成，三层验证全绿

```
实现与验证记录（双向互引 + 粘贴资源归档）：

Rust
- core/config.rs：+assets_dir: Option<String>（serde camelCase + 容器级 default，老配置缺字段兼容）
- core/fsops.rs：+unique_numeric_path（同秒冲突 _1/_2）、+write_asset（ensure_inside + 自建 assets 目录 + 唯一化 + 写盘）、+import_asset（read + write_asset，源可在根外任意可读位置）；新增 2 个单测
- commands.rs：+save_asset(root,dest_dir,base_name,bytes:Vec<u8>)->String、+import_asset(root,src,dest_dir,base_name)->String（返回去重后绝对路径，dunce::simplified）；lib.rs 两个 feature 分支注册

前端
- ipc.ts：AppConfig.assetsDir? + api.saveAsset/importAsset（Uint8Array → Vec<u8>）
- fileOps.ts(+12 测试)：tsToken(本地 yyyymmddHHMMSS)、assetBaseName(文档名前 10 Unicode 码点+清洗+小写扩展名)、linkLabel、relativeLinkHref(文档目录相对、正斜杠、./ 与 ../、仅 ASCII 不安全字符 %XX 强制编码——encodeURIComponent 不编码括号所以手写)、mdImageTag/mdLinkTag、isImagePath、assetsRelDir
- SourceEditor.tsx：SourceEditorHandle +insertAtCursor(dispatch changes+selection+scrollIntoView，自动走 onChange 链)；+paste domEventHandler——有 text 一律放行原生，文件或空粘贴交给 onPasteFile prop 决定是否 claim（preventDefault + 异步插入）
- App.tsx：assetsDir 状态/恢复/persist 基础对象/stateRef；设置弹窗"粘贴资源"分区；文件菜单 +copy-md-link/+insert-link(阅读模式置灰)；archiveAndInsert(系统剪贴板文件→saveAsset 归档→按扩展名插 ![]() 或 []())；editorPaste 分流(系统文件→归档；树里复制的 md→引用链接不复制文件；剪切不参与)

关键设计事实（探索结论）
- 渲染零改动：rewrite_img_srcs(markdown.rs) 把文档目录相对图片转 asset 协议 URL，阅读/chunked/分屏三管线通用；resolve_link 按文档目录解析相对链接且支持 %XX——生成的 ./assets/... 与 ../assets/... 均可直接渲染/点击
- 生成必须用文档目录相对（不能用 copy-rel 的根相对惯例），否则子目录文档裂图

验证
- pnpm test 178/178（新增 fileOps 12 项）
- pnpm build(tsc+vite) 通过
- cargo test --lib 70/70（fsops 新增 2 项）
- 途中修的测试问题：CJK 前 10 字符期望值数错（"这是一个非常长的中文"才是 10 个）；encodeURIComponent 不编码 ()，改为手写 %XX
```

## 测试场景与 E2E 用例

| # | 用例 | 步骤 | 预期 | 结果 |
|---|------|------|------|------|

## 证据截图

[文本快照: 终端验证快照：前端测试/构建与 Rust 测试结果](shots/001-143623.txt)

## 修复方案

双向互引三件套落地：
1) 文件树右键新增「复制 Markdown 链接」（相对当前打开文档生成 [名称](路径)，正斜杠+./与../前缀+仅 ASCII 不安全字符强制 %XX 编码，中文保持可读；无文档时相对根）与「插入链接到当前文档」（阅读模式置灰，编辑器 insertAtCursor 光标处插入，自动触发 onChange→markDirty→自动保存→预览刷新链）。
2) 编辑器(源码/分屏)粘贴分流：系统剪贴板文件（资源管理器复制的图片/PDF、截图）→ saveAsset 归档到 assets（目录自建、文档名前10字符_时间戳.扩展名命名、同秒冲突 _1/_2）→ 按扩展名插入 ![alt](./assets/...) 或 [名称](路径)；树里「复制」的文档 → 插入引用链接不复制文件；剪切不参与；纯文本粘贴完全走原生不受影响。拦截点为 CodeMirror domEventHandlers({paste})，有文本一律放行。
3) 配置新增 assetsDir（默认 assets，相对工作区根，设置弹窗可改），serde default 对老配置兼容，persist 基础对象同步补字段。
4) Rust 新增 fsops::write_asset/import_asset/unique_numeric_path 与 save_asset/import_asset 两个命令，全部 spawn_blocking + 越界校验 + 单测。
渲染与点击零改动——复用 rewrite_img_srcs 的文档目录相对图片管线和 resolve_link 的相对链接解析，生成的 ./assets 与 ../assets 路径在阅读/chunked/分屏三管线均可渲染。

## 复盘

要点复盘：
1) 生成链接必须与解析惯例对齐：本应用解析只认「相对当前文档目录」，而此前 copy-rel 是根相对惯例——生成侧新写 relativeLinkHref 按文档位置算相对路径，这是子目录文档不裂图的关键。
2) encodeURIComponent 不编码 ( )，对 CommonMark 链接目标不够安全（不平衡括号会断链），手写 ASCII %XX 替换更可控且保持中文可读。
3) 编辑器粘贴拦截用 domEventHandlers({paste})：claim 必须同步返回，而资源导入是异步的——模式是"同步 claim+preventDefault，异步归档后 insertAtCursor"，onChange 链自动补齐后续。
4) 系统剪贴板文件经 clipboardData.files 获取（截图会以 image.png 出现），应用内树剪贴板不触碰系统剪贴板，两者用"有无文本/文件"即可无歧义分流。
5) 测试期望自身也要仔细：CJK 按 Unicode 码点数前 10 字符，别按直觉数。
