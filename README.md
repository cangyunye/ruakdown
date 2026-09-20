# Ruakdown

**Windows 优先、离线优先的本地 Markdown 阅读器 / 编辑器**,Tauri 2(Rust)+ React 19 + TypeScript。

不做云、不联网:打开本地文件夹或文件,渲染、编辑、导出、分享全部在本机完成。

## 公告

### 2026-09-18 · ZCode(智谱 AI 编程客户端)静默上传用户代码事件

- **事件**:据 [ferstar 的逆向分析](https://blog.ferstar.org/posts/zcode-silent-workspace-snapshot-upload/),ZCode 只要处于登录状态,就会在后台把整个工作区——含完整 `.git` 历史、LFS 缓存、reflog 及全局配置——打包加密后直传阿里云 OSS,近九成内容来自 `.git` 目录。
- **没有开关**:设置里的「优化体验」「仓库快照索引」均无法关闭该上传行为;UI 中没有任何开关能关掉它。
- **服务端独有密钥**:加密密钥由服务端动态下发,私钥仅存云端,用户本地与客户端都无法解密,只能智谱后端单方面查看。
- **隐私政策**:全文未提及整仓工作区连同完整 Git 历史会被静默打包上传。
- **防护建议**:未安装/未登录状态下使用,或参照原文锁定 `~/.zcode/v2/checkpoints` 目录(未登录仍需防范)。Ruakdown 坚持本地离线,不做任何隐式数据采集与上传。

## 特性

- **阅读优先** — 三档视图「阅读 / 分屏 / 源码」。渲染由 Rust 侧 `pulldown-cmark` 完成,阅读视图、导出 HTML、局域网分享页共用同一条管线,结果必然一致。
- **大文档可读** — 超过 1MB 自动切分块虚拟化渲染(按需挂载 + DOM 驱逐),快速滚动流畅;源码与预览块级双向滚动同步。
- **编码与换行不破坏** — 逐文件保持原编码(UTF-8 / BOM / UTF-16 / GBK)与换行风格(CRLF / LF)。
- **可分享**(可选) — 内置 axum 服务:本机预览,或局域网三档权限分享(只读 / 同步浏览 / 协作编辑),访问令牌鉴权,分享页离线可用。发布安装包为全量版;本地默认构建为不含分享的轻量版,`--features share` 启用。
- **阅读增强** — 大纲导航与滚动高亮、Mermaid、代码语法高亮、`==高亮==`、图片悬停放大与灯箱、专注模式(Zen)、目录内全文搜索。
- **外观** — 10 款内置主题、阅读区背景图(纸面实色 / 半透明毛玻璃)。
- **桌面集成** — `.md` 文件关联、单实例、双击打开、会话恢复、离线单文件 HTML 导出。

## 安装

从 [Releases](https://github.com/cangyunye/ruakdown/releases) 下载:

| 平台 | 文件 |
|------|------|
| Windows x64 | `Ruakdown_<版本>_x64-setup.exe`(NSIS,按当前用户安装,无需管理员) |
| macOS (Apple Silicon) | `Ruakdown_<版本>_aarch64.dmg` |

Intel Mac 与 Linux 暂无预编译包,需从源码构建。macOS 未做代码签名,首次打开如提示来源不明,在「系统设置 → 隐私与安全性」中允许即可。

## 文档

| 文档 | 内容 |
|------|------|
| [USAGE.md](USAGE.md) | **使用指南**:功能操作、快捷键、分享与排障 |
| [DESIGN.md](DESIGN.md) | 架构设计与关键技术决策 |
| [CHANGELOG.md](CHANGELOG.md) | 各版本升级差异(Release 说明来源) |

## 开发

需要 Node + pnpm、Rust、WebView2(Win11 自带)与 [go-task](https://taskfile.dev)。

```sh
task doctor     # 检查工具链
task dev        # 开发模式(轻量版,不含分享;task dev:share 为全量版)
task test       # Rust 单元测试(轻量 + share 两种 feature 组合)
task check      # 前端构建 + cargo check
task build      # release 轻量版 + 平台安装包(task build:share 为全量版)
```

前端测试用 `pnpm test`(vitest)。推送 `v*` tag 触发 CI 构建并发布安装包,Release 说明自动取自 CHANGELOG 对应版本段落。
