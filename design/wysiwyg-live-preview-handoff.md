# 实时编辑（WYSIWYG）交接文档

> 分支 `feat/wysiwyg`，基于 `b4ab6bb`，**工作区有未提交改动**（本轮「实时视图块级渲染 + 阅读样式对齐」），**未合并、未推送**。
> 设计与实现计划见 `design/wysiwyg-live-preview.md`、`design/wysiwyg-live-preview-plan.md`。

## 一句话状态

四态视图（阅读 / 实时 / 分屏 / 源码）、启动模式设置、论道武当代码配色、实时 frontmatter 卡片、**实时块级渲染（表格 / Mermaid / 展示公式）与代码高亮、实时样式与阅读视图对齐**均已实现并通过单测与浏览器截图对比；
**待人工验收中文输入法手感**，然后提交并决定是否合并 `main`。

## 已交付

| 功能 | 落点 |
|---|---|
| 第四种视图「实时」+ `Ctrl+Tab` 四态循环 | `src/split.ts`、`src/App.tsx`、`src/components/SourceEditor.tsx` |
| 启动模式设置（默认 `read`，持久化，仅作用于启动自动打开的那篇） | `src/App.tsx`、`src/ipc.ts`、`src-tauri/src/core/config.rs` |
| 装饰层：标题/强调/行内代码/链接/引用/列表/任务/图片/分隔线/frontmatter | `src/livePreview.ts` |
| **行内补齐**：围栏行隐藏并折叠、代码按语言高亮（`--syn-*`）、GFM alert 五色标签、段落/列表/引用间距类、任务文字正文色 | `src/livePreview.ts`、`src/markdownSupport.ts`（`codeLanguages`） |
| **块级 widget**：GFM 表格 / ` ```mermaid ` / `$$…$$` 渲染为真 DOM，光标进入或点击回源码，增量更新 | `src/liveBlocks.ts`（`StateField`） |
| **`render_math` IPC**：实时公式复用 Rust `math_html`，与阅读输出一致 | `src-tauri/src/commands.rs`、`core/markdown.rs`、`src/ipc.ts` |
| `mermaidSvg(source, dark)`：阅读 / 实时共用的渲染 + 缓存 | `src/mermaid.ts` |
| 实时视图样式（与 `md-content.css` 对齐） | `src/index.css`（`.rk-live …`） |
| 实时高亮样式与源码基础高亮互斥加载 | `src/components/SourceEditor.tsx`（`liveCompartment`） |
| 论道武当代码黑底黑字 | `src-tauri/resources/themes/wudang.json`、`resources/md-content.css`、`core/export.rs` |
| 导出 HTML 深色语法变量修正 | `src-tauri/src/core/export.rs` |

关键设计约束（不要破坏）：

- Markdown 文本是唯一事实源，不做 HTML→Markdown 往返，不引入 ProseMirror / Milkdown。
- 行内装饰只扫 `view.visibleRanges`；块级扫描是整篇 O(行数)，但只在改动触及 `|` `` ` `` `~` `$` 或已知块时重扫，其余编辑只做位置映射（`liveBlocks.ts::needsRescan`）。
- 中文输入法组合期间（`view.composing`）行内层不生成 `Decoration.replace`；块级 widget 不受影响（光标在块内时本来就不渲染 widget）。
- 实时 ↔ 源码共用编辑缓冲与撤销历史；分屏 ↔ 实时会重挂载编辑器（撤销/滚动不保留）。
- **块级 widget 来自 `StateField`，不是 ViewPlugin**：CM6 禁止插件提供块装饰。行内装饰器必须跳过 widget 覆盖区间（`opts.skip`），否则 replace 嵌套 replace 会崩。
- **块级 widget 故意不设原子区间**：方向键进块即显源码（Typora 手感）；若设为原子，CM6 在块边缘按一次 Backspace 会整块删除。
- 块区间 `to` 含尾部换行：光标停在块后一行算块外；块位于文档末尾且无换行时 `to` 算块内（`liveBlocks.ts::selectionIntersects`）。
- 实时视图**自带**完整 `HighlightStyle`（无 heading 规则），`SourceEditor` 在同一 compartment 里与源码基础高亮互斥。原因：CM6 样式模块按扩展顺序反向挂载，同等优先级下靠前的扩展赢，靠后面再写 `inherit` 压不住基础高亮；标题颜色/字重全由 `rk-h*` 行级类负责，这也是 frontmatter 不再被标题色染色的根本修法。
- widget 容器带 `.md-body` 以复用阅读样式表；`index.css` 里裸 `.md-body` 同时是阅读滚动壳的选择器，`.rk-live .md-body` 已显式重置壳层布局与背景图卡片效果。**以后给 `.md-body` 加布局规则时要同步看这里。**
- CM 把语法高亮 span 嵌在 mark 装饰内层：mark 级 `color` 要配 `span { color: inherit }`（见 `.rk-task-text`）。

## 验证

```bash
pnpm exec tsc --noEmit
pnpm test                      # 409 passed / 24 files
cargo test --manifest-path src-tauri/Cargo.toml
# 100 passed, 2 项已知 Windows-only 在 macOS 失败：
#   core::fsops::tests::inside_root_guard
#   core::markdown::tests::img_rewrite_resolves_parent_climbs
```

浏览器截图对比（浅色 / 深色，实时 vs 手写等价阅读 HTML）与光标进出表格 / 代码块的激活态见 `dts/feat-live-render_blocks-and-reading-parity/shots/`；复现方法写在该 dts 的「证据截图」一节。

手工验收清单（未做）：

1. 中文输入法：连续输入、候选切换、组合中按方向键，不应出现标记闪现或光标跳动。**本轮新增**：在表格行内、代码围栏内、`$$` 块内输入中文（块级 widget 在光标进入时已退回源码，理论上与普通段落无异，需实测）。
2. 实时 ↔ 源码切换后撤销/滚动行为符合预期；切换时高亮样式互换（源码视图标题应仍为 `--heading` 色）。
3. 论道武当在真实 Tauri 窗口里代码块、行内代码、frontmatter 卡片可读（frontmatter 不应再被橙色染色）。
4. 图片相对路径、任务复选框、分隔线、frontmatter 光标进入/移出。
5. **本轮新增**：真实 Tauri 窗口里 `$$` 公式 widget（走 `render_math` IPC）与 Mermaid widget（asset 协议加载 `mermaid.min.js`）能渲染；点击 widget 光标落到块首并显示源码；在表格后一行打字不应让表格解渲染；文档末尾紧贴表格（无换行）时光标在末尾应看到源码。
6. **本轮新增**：开启阅读背景图（`bg-on` + paper / frosted）后切到实时，表格 / 公式 widget 不应出现卡片阴影或大内边距。

## 已知限制（P1，已写进 CHANGELOG）

- 行内公式 `$…$`、`==高亮==`、`<u>`/`<kbd>` 在实时视图仍是原文（展示公式 `$$` 已渲染）。
- 表格 widget 的单元格内联渲染是 `liveBlocks.ts::renderInlineMarkdown` 的轻量实现（行内代码 / 粗斜体 / 删除线 / 链接），不是 Rust 渲染器；复杂内联（内嵌 HTML、脚注、图片）以阅读视图为准。
- 表格只做"点击进源码"，无网格编辑（P3）。
- Mermaid widget 的主题跟随 `data-scheme`，切主题后需光标进出一次块或重开文档才会按新主题重绘（widget `eq` 含 dark 标记，但切主题不会触发 StateField 更新）。
- frontmatter 仅支持行内列表 `keywords: [a, b]` / `a, b`；块写法 `- 条目` 不会变成 chip（阅读模式支持）。
- 非空 `references` 在实时视图是普通文本，不是链接（阅读模式是链接）。
- 跨行图片 / 链接标题 / 引用式标签保持原文（CM6 禁止插件替换跨行内容）。
- frontmatter 扫描上限 200 行（`livePreview.ts` 与 `liveBlocks.ts` 各有一份同值常量），超出不卡片化。
- 跨行装饰统一由 `crossesLine` 守卫，改动装饰逻辑时不要绕过它，否则 CM6 会崩。

## 待办 / 下一步

1. **人工验收中文输入法**（头号风险，含本轮新增的块内输入场景），通过后提交本轮改动、合并 `main` 并推送。
2. `stash@{0}`「wip: double-click open folder」需要恢复到独立分支（如 `feat/open-folder`），**不要**弹到 `feat/wysiwyg`（会冲突 `App.tsx` 与文档）。当前 `openFile` 的 `revealFolder` 选项是 no-op，恢复后才生效。
3. 可选 P2/P3：行内公式 `$…$` 与 `==高亮==` 的 inline parser、Mermaid 切主题即时重绘、表格网格编辑。

## 环境坑

- 主题 JSON 经 `include_str!` 编入 Rust 二进制：**改主题必须重启/重建**，前端 CSS 可直接 HMR。
- `pnpm tauri dev` 用 strictPort 1420。端口被占时：`lsof -ti tcp:1420 | xargs -r kill -9`。
- **项目在外接卷（`/Volumes`）上，vite 文件监听不可靠**：改完 CSS / TS 看不到变化时用 `pnpm exec vite --force` 重启，并先 `curl` 对应模块确认服务端已吐新内容。
- pnpm 的原生二进制警告不影响运行。

## 相关 dts 档案

- `dts/feat-live-render_blocks-and-reading-parity/`（本轮）
- `dts/fix-theme-wudang_code-invisible-black-on-black/`
- `dts/fix-live-frontmatter_card-layout/`
- `dts/infra-dev_port-1420-in-use/`
