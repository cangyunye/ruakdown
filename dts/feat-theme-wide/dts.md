# feat-theme-wide · 宽屏模式与浅/暗主题重设

日期:2026-11-12 · 状态:resolved(视觉验证通过)

## 内容

1. **宽屏模式**:`Ctrl/Cmd+Shift+L` 或 设置 → 布局 切换;`wide-on` 挂到
   `documentElement`,`:root.wide-on .md-body { max-width: none }` 取消阅读列
   860px 居中限宽(Reader 与 ChunkedReader 共用该滚动壳;分屏预览与实时块
   widget 本就不限宽)。状态持久化到 `config.json` 的 `wide` 字段,状态栏显
   示「宽屏」指示。
2. **浅色/暗色主题重设**(现代化):
   - 浅色:瓷白面板 + 靛蓝 accent(#4f46e5),冷调中性格子 border,行内代
     码/引用/标签带靛色淡染;
   - 暗色:由 VS Code 灰改为深靛夜空(indigo-slate #111420 系),长春花蓝
     accent(#818cf8),代码底色 #0c0e18 沉于页面底色之下。
   - `index.css` 的 `:root` 默认值同步为浅色新值;语法高亮仍走 data-scheme
     两套默认(GitHub light/dark),主题 JSON 未新增槽位。
3. **顺手修复**:`theme.ts` applyTheme 此前只写不清,切换主题后上一主题的
   内联变量(如论道武当的 `--syn-*`)永久残留并压过后续主题的样式表默认值
   (内联样式优先级最高)。现记录上次写入的变量名,本次主题未定义的一律移除。

## 视觉验证

预览页 `theme-preview.html`(vite dev 下打开,复用真实 index.css 与主题变
量、应用真实 DOM 结构):

| 截图 | 状态 |
|------|------|
| shot-light.png | 浅色默认 860px 列宽 |
| shot-light-wide.png | 浅色 + 宽屏 |
| shot-dark-top.png | 暗色首屏(frontmatter 标签/链接/引用) |
| shot-dark-code.png | 暗色代码块/表格/高亮 |
| shot-dark-wide.png | 暗色 + 宽屏 |

## 测试

- 前端 416 项(+2:Ctrl/Cmd+Shift+L → wide,两平台变体)。
- Rust 110 项(+1:wide round-trip;macOS 本地固有的 2 项平台失败
  `inside_root_guard`/`img_rewrite_resolves_parent_climbs` 与本次无关)。
- export 测试中暗色 `--bg` 断言随新配色更新为 `#111420`。
