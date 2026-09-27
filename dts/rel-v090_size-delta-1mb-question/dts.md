---
id: "rel-v090_size-delta-1mb-question"
domain: "rel-v090"
slug: "size-delta-1mb-question"
title: "评估下 0.8-0.9 为什么加了 1MB"
status: "resolved"
created: "2026-09-27T11:59:39+08:00"
resolved: "2026-09-27T12:00:02+08:00"
commit: "2355b44"
branch: "main"
platform: "win32"
session: ""
---

# rel-v090_size-delta-1mb-question

## 问题

评估下 0.8-0.9 为什么加了 1MB

## 环境

| 项 | 值 |
|----|----|
| git commit | 2355b44 |
| 分支 | main |
| 平台 | win32 |
| 建档时间 | 2026-09-27T11:59:39+08:00 |
| 会话 | - |

## 调查过程

- [11:59] 建档
- [11:59] 记录日志 (bash)
- [12:00] 结案

## 日志与摘录

### [bash] 2026-09-27T11:59:49+08:00

```
排查记录：对比 v0.8.2 与 v0.9.0 全部发布产物（gh api repos/cangyunye/ruakdown/releases）：Windows 安装包 4,305,302→4,303,361（−2KB）、macOS dmg −3KB、app.tar.gz −3KB、本地 release exe 7,940,608→7,913,472（−27KB）。无任何产物增加 1MB。本地增量：dts/ 34MB（排障截图，未入库）、dist 848KB（历史同量级）、cargotarget 构建缓存（GB 级）。结论：+1MB 前提不成立，产品体积净减约 27KB（删原生菜单代码 > 增 TitleBar/CSS）。
```

## 测试场景与 E2E 用例

| # | 用例 | 步骤 | 预期 | 结果 |
|---|------|------|------|------|

## 证据截图

## 修复方案

无需修复：经核实为前提不成立。v0.8.2→v0.9.0 全部发布产物（Windows NSIS 安装包、macOS dmg、app.tar.gz、本地 release exe）均持平或略小，净变化 −2KB ~ −27KB。体积持平的原因：本轮删掉约 250 行原生菜单 Rust 代码与菜单运行时，新增 TitleBar 组件+CSS 打包压缩后更小，一增一减后安装包还小了 2KB。用户所说"+1MB"最可能来自本地非发布物（dts/ 排障截图 34MB、cargotarget 构建缓存），已逐项列出。

## 复盘

评估体积变化要以发布产物（NSIS/dmg/exe）为准——它们是 LZMA 压缩的整体，任何被打进产品的增量都会直接反映在安装包字节数上；本地工作区（截图档案、构建缓存、dist 中间产物）的增长与产品体积无关，不要混淆。反过来这也是个校验手段：安装包字节数持平即可证明前端 bundle 没有膨胀，无需单独构建两个版本的 dist 来对比。
