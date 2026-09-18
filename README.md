# Ruakdown

**Windows 优先、离线优先的本地 Markdown 阅读器 / 编辑器**,Tauri 2(Rust)+ React 19 + TypeScript。

不做云、不联网:打开本地文件夹或文件,渲染、编辑、导出、分享全部在本机完成。

## 特性

- **阅读优先** — 三档视图「阅读 / 分屏 / 源码」。渲染由 Rust 侧 `pulldown-cmark` 完成,阅读视图、导出 HTML、局域网分享页共用同一条管线,结果必然一致。
- **大文档可读** — 超过 1MB 自动切分块虚拟化渲染(按需挂载 + DOM 驱逐),快速滚动流畅;源码与预览块级双向滚动同步。
- **编码与换行不破坏** — 逐文件保持原编码(UTF-8 / BOM / UTF-16 / GBK)与换行风格(CRLF / LF)。
- **可分享** — 内置 axum 服务:本机预览,或局域网三档权限分享(只读 / 同步浏览 / 协作编辑),访问令牌鉴权,分享页离线可用。
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
task dev        # 开发模式(tauri dev)
task test       # Rust 单元测试
task check      # 前端构建 + cargo check
task build      # release + 平台安装包
```

前端测试用 `pnpm test`(vitest)。推送 `v*` tag 触发 CI 构建并发布安装包,Release 说明自动取自 CHANGELOG 对应版本段落。
