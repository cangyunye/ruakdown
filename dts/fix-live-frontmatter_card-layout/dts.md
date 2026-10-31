---
id: "fix-live-frontmatter_card-layout"
domain: "fix-live-frontmatter"
slug: "card-layout"
title: "实时模式 frontmatter 元数据没有按阅读模式渲染：键值挤在一行、整体被 Setext 标题样式染成橙色加粗、keywords 没有 chip、空 re"
status: "resolved"
created: "2026-10-31T23:58:34+08:00"
resolved: "2026-10-31T23:59:00+08:00"
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
- [23:59] 新增 E2E 用例: 实时模式 frontmatter 与阅读模式卡片对齐
- [23:59] 记录证据 1 项
- [23:59] 记录终端文本快照
- [23:59] 结案

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
| 1 | 实时模式 frontmatter 与阅读模式卡片对齐 | 打开含 name/description/keywords/references 的 frontmatter 文档；实时视图；光标移出 frontmatter | 键名左列 104px、值右列对齐；name 加粗、description 斜体弱化、keywords 彩色 chip、空 references 留空；整行不被标题样式染成橙色加粗 | pass（浏览器 computed：key 104px / val 698px；name weight 700；description italic；5 个 fm-chip；references 行无值） |

## 证据截图

[文本快照: 实时 frontmatter 两列卡片验证快照（浏览器 computed style）](shots/001-235900.txt)

## 修复方案

1) .rk-fm-key/.rk-fm-val 改为 inline-block 固定 104px + calc(100%-104px) 两列布局；2) 隐藏冒号、隐藏值前空白；3) 行类重置 color/font-weight/font-style，避免 SetextHeading2 等标题类透色透粗；4) name/author/version 加粗、description 斜体弱化、title 放大；5) keywords/tags/categories 解析成复用阅读卡片的 fm-chip + chip-N 色板，隐藏方括号/逗号；6) 空 [] 直接隐藏，references 不显示 []。

## 复盘

CM6 行内 mark 也能做两列布局，但必须显式重置行类的 color/font-weight，否则其他行类（如标题）会通过继承污染卡片。frontmatter 的 key 特定样式（name 加粗、description 斜体、keywords chip）要与 Rust frontmatter.rs 的 key 映射保持一致，否则阅读/实时观感会分叉。
