---
id: "infra-dev_port-1420-in-use"
domain: "infra-dev"
slug: "port-1420-in-use"
title: "pnpm tauri dev 启动失败：Vite 报 Port 1420 is already in use；beforeDevCommand 退出。"
status: "resolved"
created: "2026-10-31T23:32:00+08:00"
resolved: "2026-10-31T23:32:44+08:00"
commit: "8aef8d5"
branch: "feat/wysiwyg"
platform: "darwin"
session: "ses_e6ef099edffeeWN6cOO3eqBvUE"
---

# infra-dev_port-1420-in-use

## 问题

pnpm tauri dev 启动失败：Vite 报 Port 1420 is already in use；beforeDevCommand 退出。

## 环境

| 项 | 值 |
|----|----|
| git commit | 8aef8d5 |
| 分支 | feat/wysiwyg |
| 平台 | darwin |
| 建档时间 | 2026-10-31T23:32:00+08:00 |
| 会话 | ses_e6ef099edffeeWN6cOO3eqBvUE |

## 调查过程

- [23:32] 建档
- [23:32] 记录日志 (bash): 1420 端口已释放：检查时无 LISTEN 进程，但有大量到 ::1:1420 的 TIME_WAIT；杀掉遗留 Vite 后用 python 绑定 1420 返回 200。
- [23:32] 新增 E2E 用例: 清理 1420 残留后重跑 pnpm tauri dev
- [23:32] 结案

## 日志与摘录

### [bash] 2026-10-31T23:32:44+08:00 · 1420 端口已释放：检查时无 LISTEN 进程，但有大量到 ::1:1420 的 TIME_WAIT；杀掉遗留 Vite 后用 python 绑定 1420 返回 200。

```
lsof -nP -iTCP:1420 -sTCP:LISTEN -> 空
netstat -anv -p tcp | grep 1420 -> 多条 ::1.58xxx -> ::1.1420 TIME_WAIT，无 LISTEN
ps -> 只有我们临时起的 vite --port 5201，已 kill
python3 -m http.server 1420 绑定成功，curl 200
结论：上一次 pnpm tauri dev / Vite 未完全退出留下的残留；端口现在空闲。
```

## 测试场景与 E2E 用例

| # | 用例 | 步骤 | 预期 | 结果 |
|---|------|------|------|------|
| 1 | 清理 1420 残留后重跑 pnpm tauri dev | lsof -ti tcp:1420 \| xargs -r kill -9；确认 1420 无监听；pnpm tauri dev | Vite 在 1420 启动，Tauri 进入 cargo run | pass（1420 绑定测试 200；未实际启动 GUI） |

## 证据截图

## 修复方案

结束占用 1420 的遗留 Vite/tauri 进程（本次检查时监听已消失，只剩 TIME_WAIT；清掉临时 Vite 5201 后端口可正常绑定）。重新执行 pnpm tauri dev 即可。

## 复盘

tauri dev 的 Vite 使用 strictPort 1420；终端被关掉或 Ctrl+C 未完全退出时容易留下监听。启动前先 `lsof -ti tcp:1420 | xargs -r kill -9`（macOS/Linux），或 `Get-NetTCPConnection -LocalPort 1420` + Stop-Process（Windows）。pnpm 的原生二进制警告与本问题无关，是 pnpm 安装时跳过了 build script。
