# 实时编辑（WYSIWYG）交接文档

> 分支 `feat/wysiwyg`，HEAD `e4988b1`，工作区干净，**未合并、未推送**。
> 设计与实现计划见 `design/wysiwyg-live-preview.md`、`design/wysiwyg-live-preview-plan.md`。

## 一句话状态

四态视图（阅读 / 实时 / 分屏 / 源码）、启动模式设置、论道武当代码配色、实时 frontmatter 卡片均已实现并通过单测；
**待人工验收中文输入法手感**，然后决定是否合并 `main`。

## 已交付

| 功能 | 落点 |
|---|---|
| 第四种视图「实时」+ `Ctrl+Tab` 四态循环 | `src/split.ts`、`src/App.tsx`、`src/components/SourceEditor.tsx` |
| 启动模式设置（默认 `read`，持久化，仅作用于启动自动打开的那篇） | `src/App.tsx`、`src/ipc.ts`、`src-tauri/src/core/config.rs` |
| 装饰层：标题/强调/行内代码/链接/引用/列表/任务/图片/分隔线/frontmatter | `src/livePreview.ts` |
| 实时视图样式 | `src/index.css`（`.rk-live .cm-content .cm-line.rk-*`） |
| 论道武当代码黑底黑字 | `src-tauri/resources/themes/wudang.json`、`src-tauri/resources/md-content.css`、`src-tauri/src/core/export.rs` |
| 导出 HTML 深色语法变量修正 | `src-tauri/src/core/export.rs` |

关键设计约束（不要破坏）：

- Markdown 文本是唯一事实源，不做 HTML→Markdown 往返，不引入 ProseMirror / Milkdown。
- 只装饰 `view.visibleRanges`，不全文档扫描。
- 中文输入法组合期间（`view.composing`）不生成 `Decoration.replace`。
- 实时 ↔ 源码共用编辑缓冲与撤销历史；分屏 ↔ 实时会重挂载编辑器（撤销/滚动不保留）。

## 验证

```bash
pnpm exec tsc --noEmit
pnpm test                      # 368 passed / 23 files
cargo test --manifest-path src-tauri/Cargo.toml
# 99 passed, 2 项已知 Windows-only 在 macOS 失败：
#   core::fsops::tests::inside_root_guard
#   core::markdown::tests::img_rewrite_resolves_parent_climbs
```

手工验收清单（未做）：

1. 中文输入法：连续输入、候选切换、组合中按方向键，不应出现标记闪现或光标跳动。
2. 实时 ↔ 源码切换后撤销/滚动行为符合预期。
3. 论道武当在真实 Tauri 窗口里代码块与行内代码可读。
4. 图片相对路径、任务复选框、分隔线、frontmatter 光标进入/移出。

## 已知限制（P1，已写进 CHANGELOG）

- 代码围栏、公式、Mermaid、表格在实时视图仍以源码呈现。
- frontmatter 仅支持行内列表 `keywords: [a, b]` / `a, b`；块写法 `- 条目` 不会变成 chip（阅读模式支持）。
- 非空 `references` 在实时视图是普通文本，不是链接（阅读模式是链接）。
- 跨行图片 / 链接标题 / 引用式标签保持原文（CM6 禁止插件替换跨行内容）。
- frontmatter 扫描上限 200 行（`shortcut:` 注释在 `src/livePreview.ts`），超出不卡片化。
- 跨行装饰统一由 `crossesLine` 守卫，改动装饰逻辑时不要绕过它，否则 CM6 会崩。

## 待办 / 下一步

1. **人工验收中文输入法**（头号风险），通过后合并 `main` 并推送。
2. `stash@{0}`「wip: double-click open folder」需要恢复到独立分支（如 `feat/open-folder`），**不要**弹到 `feat/wysiwyg`（会冲突 `App.tsx` 与文档）。当前 `openFile` 的 `revealFolder` 选项是 no-op，恢复后才生效。
3. 可选 P2/P3：代码块高亮 widget、公式、Mermaid、表格网格、GFM callout 配色。

## 环境坑

- 主题 JSON 经 `include_str!` 编入 Rust 二进制：**改主题必须重启/重建**，前端 CSS 可直接 HMR。
- `pnpm tauri dev` 用 strictPort 1420。端口被占时：`lsof -ti tcp:1420 | xargs -r kill -9`。
- pnpm 的原生二进制警告不影响运行。

## 相关 dts 档案

- `dts/fix-theme-wudang_code-invisible-black-on-black/`
- `dts/fix-live-frontmatter_card-layout/`
- `dts/infra-dev_port-1420-in-use/`
