---
id: "fix-theme-wudang_code-invisible-black-on-black"
domain: "fix-theme-wudang"
slug: "code-invisible-black-on-black"
title: "论道武当主题下，阅读模式与实时模式的代码块/行内代码出现黑底黑字，文字不可见（截图红框与黑块）。"
status: "open"
created: "2026-10-31T20:47:10+08:00"
resolved: ""
commit: "739cf43"
branch: "feat/wysiwyg"
platform: "darwin"
session: "ses_e6ef099edffeeWN6cOO3eqBvUE"
---

# fix-theme-wudang_code-invisible-black-on-black

## 问题

论道武当主题下，阅读模式与实时模式的代码块/行内代码出现黑底黑字，文字不可见（截图红框与黑块）。

## 环境

| 项 | 值 |
|----|----|
| git commit | 739cf43 |
| 分支 | feat/wysiwyg |
| 平台 | darwin |
| 建档时间 | 2026-10-31T20:47:10+08:00 |
| 会话 | ses_e6ef099edffeeWN6cOO3eqBvUE |

## 调查过程

- [20:47] 建档
- [21:09] 记录日志 (chat): 根因: 论道武当是浅色主题但代码面是深色, 语法 token 仍用浅色方案且 pre code 继承了 --text(墨黑), 导致黑底黑字; 实时模式 frontmatter 只有半透明行样式, 未做卡片格式化。
- [21:15] 新增 E2E 用例: 论道武当主题：阅读模式代码块文字可见
- [21:15] 新增 E2E 用例: 论道武当主题：实时模式代码块与行内代码可见
- [21:15] 新增 E2E 用例: 实时模式 frontmatter 显示为卡片
- [21:16] 记录证据 2 项

## 日志与摘录

### [chat] 2026-10-31T21:09:32+08:00 · 根因: 论道武当是浅色主题但代码面是深色, 语法 token 仍用浅色方案且 pre code 继承了 --text(墨黑), 导致黑底黑字; 实时模式 frontmatter 只有半透明行样式, 未做卡片格式化。

```
wudang.json: dark=false, --code-bg=#141414, --pre-bg=#101010, --code-text=#f2f2ee
md-content.css: .md-body pre code { color: var(--text) } -> #1a1a1a on #101010 (invisible)
index.css: :root[data-scheme=light] 提供深色 --syn-* 语法色, wudang 的深色代码面没有覆盖
livePreview.ts: frontmatter 只加 rk-frontmatter 半透明, 围栏与 key/value 未格式化; SetextHeading2 可能把元信息行渲染成标题
```

## 测试场景与 E2E 用例

| # | 用例 | 步骤 | 预期 | 结果 |
|---|------|------|------|------|
| 1 | 论道武当主题：阅读模式代码块文字可见 | 切到论道武当；打开含 fenced code block 与行内代码的 Markdown；阅读模式 | 代码块浅色文字显示在深色背景上，行内代码同样可见 | pass（浏览器复现：pre code color=#f2f2ee on #101010） |
| 2 | 论道武当主题：实时模式代码块与行内代码可见 | 切到论道武当；实时视图；含 fenced code block 与行内代码的文档 | 代码块与行内代码均为浅色文字 + 深色底 | pass（浏览器复现：rk-code / rk-inline-code color=#f2f2ee） |
| 3 | 实时模式 frontmatter 显示为卡片 | 实时视图；文档以 --- frontmatter 开头；光标移出 frontmatter | 首尾 --- 隐藏，元信息行有卡片背景，键名弱化、值正常着色；光标进入时恢复原文 | pass（浏览器复现：rk-fm-line / rk-fm-key / rk-fm-val） |

## 证据截图

![修复后：实时视图（前）代码块/行内代码/ frontmatter 卡片；阅读视图（后）代码块与行内代码均为浅色文字。](shots/001.png)

![修复后：实时视图（前）代码块/行内代码/ frontmatter 卡片；阅读视图（后）代码块与行内代码均为浅色文字。](shots/002.png)

## 修复方案

## 复盘
