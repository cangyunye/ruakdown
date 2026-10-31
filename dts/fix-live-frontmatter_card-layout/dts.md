---
id: "fix-live-frontmatter_card-layout"
domain: "fix-live-frontmatter"
slug: "card-layout"
title: "实时模式 frontmatter 元数据没有按阅读模式渲染：键值挤在一行、整体被 Setext 标题样式染成橙色加粗、keywords 没有 chip、空 re"
status: "open"
created: "2026-10-31T23:58:34+08:00"
resolved: ""
commit: "9151143"
branch: "feat/wysiwyg"
platform: "darwin"
session: "ses_e6ef099edffeeWN6cOO3eqBvUE"
---

# fix-live-frontmatter_card-layout

## 问题

实时模式 frontmatter 元数据没有按阅读模式渲染：键值挤在一行、整体被 Setext 标题样式染成橙色加粗、keywords 没有 chip、空 references 仍显示 []。

## 环境

| 项 | 值 |
|----|----|
| git commit | 9151143 |
| 分支 | feat/wysiwyg |
| 平台 | darwin |
| 建档时间 | 2026-10-31T23:58:34+08:00 |
| 会话 | ses_e6ef099edffeeWN6cOO3eqBvUE |

## 调查过程

- [23:58] 建档
- [23:58] 记录日志 (chat): 根因：实时 frontmatter 之前只有行背景 + 单行 key/value 标记，没有列布局；行类未重置 color/font-weight，SetextHeading2 的标题样式会透到整行；keywords 未解析成 chip，空 references 未跳过。

## 日志与摘录

### [chat] 2026-10-31T23:58:43+08:00 · 根因：实时 frontmatter 之前只有行背景 + 单行 key/value 标记，没有列布局；行类未重置 color/font-weight，SetextHeading2 的标题样式会透到整行；keywords 未解析成 chip，空 references 未跳过。

```
旧实现: .rk-fm-line 只设 background/border/padding; .rk-fm-key 只设 color/weight; .rk-fm-val 只设 color。
key/value 都是普通 inline，value 紧跟在 key 后面，无法两列对齐。
若 SetextHeading2 的 rk-h2 行类同时落在该行，color: var(--heading) + font-weight:700 会覆盖，出现橙色加粗整行。
keywords/tags/categories 未特殊处理，显示为 [a, b] 原文；references: [] 也被当成普通值显示。
```

## 测试场景与 E2E 用例

| # | 用例 | 步骤 | 预期 | 结果 |
|---|------|------|------|------|

## 证据截图

## 修复方案

## 复盘
