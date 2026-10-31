# 实时编辑（WYSIWYG）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 Markdown 编辑器上增加第四种视图「实时」——Typora / Obsidian Live Preview 式的所见即所得编辑，同时保留 Markdown 文本作为唯一事实源。

**Architecture:** 复用现有 CodeMirror 6 编辑器，通过一个 `ViewPlugin` 在可视区语法树上生成装饰：非活动块隐藏 Markdown 标记并渲染图片/复选框/分隔线，活动块露出原文。不引入新依赖，不改保存/导出/分享管线。

**Tech Stack:** React 19、TypeScript、CodeMirror 6（`@codemirror/lang-markdown` 已含 GFM）、Vitest、Tauri 2 / Rust。

## Global Constraints

- **不新增运行时依赖。** 不引入 ProseMirror、Milkdown、KaTeX、remark 等。
- **Markdown 文本是唯一事实源。** 不允许 HTML→Markdown 往返；不允许改 `core/markdown.rs` 的阅读/导出渲染。
- **编辑缓冲、保存、编码、CRLF、撤销、外部修改检测维持现状。**
- 实时视图只装饰 `view.visibleRanges`，不得全文档扫描。
- 中文输入法组合期间（`view.composing`）不生成任何 `Decoration.replace`。
- 新增配置项必须向后兼容：旧 `config.json` 缺失字段时使用默认值。
- 默认启动模式为 `read`。

## Preconditions

工作区里有一批与本功能无关的未提交改动（双击打开自动加载目录：`App.tsx`、`fileOps.ts`、`CHANGELOG.md` 等）。开始实现前先二选一：

```bash
git stash push -m "wip: double-click open folder"   # 或
git add -A && git commit -m "feat: 双击打开自动加载所在目录"
```

确认 `git status --short` 只剩设计文档已提交后的干净状态，否则本计划的提交会混入无关改动。

## File Structure

| 文件 | 责任 |
|------|------|
| `src/split.ts` | `Mode` 联合类型、模式循环、启动模式归一化 |
| `src/livePreview.ts` | 装饰构建、widget、图片路径解析、实时主题与插件 |
| `src/livePreview.test.ts` | 装饰范围 / widget / 路径解析单测 |
| `src/components/SourceEditor.tsx` | `live` / `docPath` 属性，Compartment 动态挂载实时扩展 |
| `src/components/TitleBar.tsx` | 第四个视图按钮 |
| `src/headingLocate.ts` | 抽出 `scanHeadings`，供源码/实时大纲共用 |
| `src/App.tsx` | 模式分支、启动模式设置、实时大纲、搜索/锚点定位 |
| `src/ipc.ts` | `AppConfig.startupMode` |
| `src-tauri/src/core/config.rs` | `startup_mode` 字段 |
| `src/index.css` | 实时视图样式 |

---

### Task 1: Mode 四态与启动模式归一化

**Files:**
- Modify: `src/split.ts:1-47`
- Test: `src/split.test.ts:45-67`

**Interfaces:**
- Produces: `type Mode = "read" | "live" | "split" | "edit"`
- Produces: `nextMode(mode: Mode): Mode`（read → live → split → edit → read）
- Produces: `normalizeStartupMode(raw: unknown): Mode`（非法值回退 `"read"`）

- [ ] **Step 1: 改测试，先让它失败**

把 `src/split.test.ts` 里 `nextMode` 的用例替换为：

```ts
describe("nextMode", () => {
  it("cycles read → live → split → edit → read", () => {
    expect(nextMode("read")).toBe("live");
    expect(nextMode("live")).toBe("split");
    expect(nextMode("split")).toBe("edit");
    expect(nextMode("edit")).toBe("read");
  });
});
```

在 `nextEditorText` 的 describe 里补两条：

```ts
it("treats live as an editing view", () => {
  expect(nextEditorText("live", "read", "stale", "doc")).toBe("doc");
  expect(nextEditorText("edit", "live", "live edits", "doc")).toBe("live edits");
});
```

在文件末尾新增：

```ts
describe("normalizeStartupMode", () => {
  it("accepts the four modes", () => {
    expect(normalizeStartupMode("read")).toBe("read");
    expect(normalizeStartupMode("live")).toBe("live");
    expect(normalizeStartupMode("split")).toBe("split");
    expect(normalizeStartupMode("edit")).toBe("edit");
  });

  it("falls back to read for missing or corrupt values", () => {
    expect(normalizeStartupMode(undefined)).toBe("read");
    expect(normalizeStartupMode(null)).toBe("read");
    expect(normalizeStartupMode("wysiwyg")).toBe("read");
    expect(normalizeStartupMode(3)).toBe("read");
  });
});
```

把 import 补上 `normalizeStartupMode`。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/split.test.ts`
Expected: FAIL —— `nextMode("read")` 返回 `"split"`，`normalizeStartupMode` 不存在。

- [ ] **Step 3: 实现**

`src/split.ts` 第 1 行：

```ts
export type Mode = "read" | "live" | "split" | "edit";
```

`nextMode` 改为：

```ts
/** Ctrl+Tab cycles 阅读 → 实时 → 分屏 → 源码 → 阅读. */
export function nextMode(mode: Mode): Mode {
  if (mode === "read") return "live";
  if (mode === "live") return "split";
  return mode === "split" ? "edit" : "read";
}
```

文件末尾追加：

```ts
/** Startup view preference; anything unrecognised means the old default. */
export function normalizeStartupMode(raw: unknown): Mode {
  return raw === "live" || raw === "split" || raw === "edit" ? raw : "read";
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run src/split.test.ts`
Expected: PASS（原有用例 + 新增用例）

- [ ] **Step 5: 提交**

```bash
git add src/split.ts src/split.test.ts
git commit -m "feat: 视图模式增加实时(live)四态"
```

---

### Task 2: 标题栏第四个视图按钮

**Files:**
- Modify: `src/components/TitleBar.tsx:507-525`
- Test: `src/components/TitleBar.test.tsx:50-60`

**Interfaces:**
- Consumes: `Mode`（Task 1）
- Produces: 标题栏按钮 `阅读 | 实时 | 分屏 | 源码`，点击回调 `onMode("live")`

- [ ] **Step 1: 先写测试**

在 `TitleBar.test.tsx` 的「switches view modes」用例里追加：

```ts
fireEvent.click(screen.getByRole("button", { name: "实时" }));
expect(onMode).toHaveBeenCalledWith("live");
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run src/components/TitleBar.test.tsx`
Expected: FAIL —— 找不到「实时」按钮。

- [ ] **Step 3: 实现**

`src/components/TitleBar.tsx` 的数组改为：

```tsx
[
  ["read", "阅读"],
  ["live", "实时"],
  ["split", "分屏"],
  ["edit", "源码"],
] as const
```

- [ ] **Step 4: 运行测试**

Run: `pnpm exec vitest run src/components/TitleBar.test.tsx`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/components/TitleBar.tsx src/components/TitleBar.test.tsx
git commit -m "feat: 标题栏增加实时视图入口"
```

---

### Task 3: 启动模式配置与设置项

**Files:**
- Modify: `src-tauri/src/core/config.rs:47-61`
- Modify: `src/ipc.ts:102-116`
- Modify: `src/App.tsx`（状态、恢复、设置弹窗、`openFile` 返回值）
- Test: `src-tauri/src/core/config.rs`（新增 `#[cfg(test)]`）

**Interfaces:**
- Consumes: `normalizeStartupMode`（Task 1）、`Mode`（Task 1）
- Produces: `Config.startup_mode: Option<String>` / `AppConfig.startupMode`
- Produces: `openFile(...)` 返回 `Promise<DocPayload | null>`（成功返回文档，失败返回 `null`）

- [ ] **Step 1: 先写 Rust 测试**

在 `src-tauri/src/core/config.rs` 末尾追加：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_mode_round_trips_and_missing_field_defaults() {
        let cfg: Config = serde_json::from_str(r#"{"startupMode":"live"}"#).unwrap();
        assert_eq!(cfg.startup_mode.as_deref(), Some("live"));

        let old: Config = serde_json::from_str("{}").unwrap();
        assert!(old.startup_mode.is_none());
    }
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml startup_mode_round_trips`
Expected: 编译失败 —— 没有 `startup_mode` 字段。

- [ ] **Step 3: 实现 Rust 字段**

`Config` 增加：

```rust
    /// View shown when the app launches with a document: "read" | "live"
    /// | "split" | "edit"; missing means "read".
    pub startup_mode: Option<String>,
```

- [ ] **Step 4: 运行 Rust 测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml startup_mode_round_trips`
Expected: PASS

- [ ] **Step 5: 加前端类型**

`src/ipc.ts` 的 `AppConfig` 增加：

```ts
  /** View to show when launching with a document; default "read". */
  startupMode?: "read" | "live" | "split" | "edit" | null;
```

- [ ] **Step 6: 改 `openFile` 返回值**

`src/App.tsx` 里 `openFile` 的签名改为：

```ts
const openFile = useCallback(
  async (path: string, opts?: { history?: boolean; revealFolder?: boolean }): Promise<DocPayload | null> => {
```

成功路径在 `setExternalChange(false)` 附近保留 `const d = await api.openDoc(path)`，函数末尾 `return d;`；`catch` 分支末尾 `return null;`。现有调用方忽略返回值，无需修改。

- [ ] **Step 7: App 状态与恢复**

在 `useState` 区加：

```ts
const [startupMode, setStartupMode] = useState<Mode>("read");
```

`persist` 是 `useCallback(..., [])`，不能直接闭包读 `startupMode`，用 ref：

```ts
const startupModeRef = useRef(startupMode);
startupModeRef.current = startupMode;
```

`persist` 的对象里加：

```ts
startupMode: startupModeRef.current,
```

恢复会话的 effect 里，在读取 `cfg.autosave` 附近加：

```ts
const startMode = normalizeStartupMode(cfg.startupMode);
setStartupMode(startMode);
```

把打开文件的尾部改成：

```ts
let opened: DocPayload | null = null;
if (pending) {
  opened = await openFile(pending, { revealFolder: true });
} else {
  if (cfg.lastFolder) await openFolder(cfg.lastFolder);
  if (cfg.lastFile) opened = await openFile(cfg.lastFile);
}
if (opened && startMode !== "read") {
  setMode(startMode);
  if (startMode === "split") refreshPreview(true, "split");
}
```

import 补上 `normalizeStartupMode`。

- [ ] **Step 8: 设置弹窗加下拉框**

在设置弹窗 `<h2>设置</h2>` 之后插入：

```tsx
<label className="setting-row">
  <span>启动模式</span>
  <select
    className="theme-select"
    value={startupMode}
    onChange={(e) => {
      const v = e.target.value as Mode;
      setStartupMode(v);
      persist({ startupMode: v });
    }}
  >
    <option value="read">阅读</option>
    <option value="live">实时</option>
    <option value="split">分屏</option>
    <option value="edit">源码</option>
  </select>
</label>
<p className="setting-hint">
  仅影响下次启动时自动打开的那篇文档；启动后在欢迎页手动打开文件仍进入阅读视图。
</p>
```

- [ ] **Step 9: 类型检查 + 手工验证**

Run: `pnpm exec tsc --noEmit`
Expected: 无错误。

手工：设置里选「实时」→ 关闭应用 → 重新打开上一篇文档 → 直接进入实时视图（此时编辑器还不是实时渲染，只是源码 + 后续任务会接管）。选「源码」同理；选「阅读」保持原行为。

- [ ] **Step 10: 提交**

```bash
git add src-tauri/src/core/config.rs src/ipc.ts src/App.tsx
git commit -m "feat: 启动模式设置(阅读/实时/分屏/源码)"
```

---

### Task 4: 实时编辑器挂载（先只换字体，不做装饰）

**Files:**
- Modify: `src/components/SourceEditor.tsx`
- Modify: `src/App.tsx`（编辑器 JSX 去重 + 状态栏 + live 分支）

**Interfaces:**
- Consumes: `livePreview(docPath: string): Extension`（Task 5 创建；本任务先建空壳）
- Produces: `<SourceEditor live?: boolean docPath?: string />`

- [ ] **Step 1: 建空壳扩展**

新建 `src/livePreview.ts`：

```ts
import { type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

const liveTheme = EditorView.theme({
  "&.rk-live .cm-scroller": {
    fontFamily: "inherit",
    fontSize: "15px",
    lineHeight: "1.75",
  },
  "&.rk-live .cm-content": {
    maxWidth: "860px",
    padding: "24px 16px 60vh",
  },
  "&.rk-live .cm-line": {
    padding: "0 8px",
  },
});

/** Live-preview decorations; the decoration pass is added in Task 5. */
export function livePreview(docPath: string): Extension {
  void docPath;
  return [EditorView.editorAttributes.of({ class: "rk-live" }), liveTheme];
}
```

- [ ] **Step 2: SourceEditor 加属性与 Compartment**

`Props` 增加：

```ts
  /** Render the live-preview decorations (wysiwyg editing). */
  live?: boolean;
  /** Absolute path of the open document, for relative image resolution. */
  docPath?: string;
```

从 `@codemirror/state` 引入 `Compartment`，从 `../livePreview` 引入 `livePreview`。

组件参数解构补 `live = false, docPath = ""`。

创建实例前：

```ts
const liveCompartment = useRef(new Compartment());
```

`EditorState.create` 的 extensions 末尾加：

```ts
liveCompartment.current.of(live ? livePreview(docPath) : []),
```

在现有 `useEffect(..., [])` 之后新增一个 effect，让切换视图时无需重建编辑器（保留撤销历史与滚动位置）：

```ts
useEffect(() => {
  const view = viewRef.current;
  if (!view) return;
  view.dispatch({
    effects: liveCompartment.current.reconfigure(
      live ? livePreview(docPath) : [],
    ),
  });
}, [live, docPath]);
```

- [ ] **Step 3: App 抽一个 editorPane**

在 `App.tsx` 的 `return (` 之前（`currentOutline` 之后）定义：

```tsx
const editorPane = (
  <div className="editor-wrap">
    <Suspense fallback={<div className="editor-loading">正在加载编辑器…</div>}>
      <SourceEditor
        key={currentFile ?? ""}
        ref={editorRef}
        initialText={editTextRef.current}
        text={doc?.text ?? ""}
        docPath={currentFile ?? ""}
        live={mode === "live"}
        onChange={handleEditorChange}
        onSave={saveDoc}
        onScroll={handleEditorScroll}
        onOpenLink={handleOpenLink}
        onPasteFile={handleEditorPasteFile}
        onPasteHtml={handleEditorPasteHtml}
        onViewReady={handleEditorViewReady}
        onViewDestroy={handleEditorViewDestroy}
        onFocusChange={handleEditorFocusChange}
        onSlashTrigger={handleSlashTrigger}
        onUserInput={closeSlashMenu}
      />
    </Suspense>
    {findOpen && (
      <SearchPanel
        mode={mode}
        source={sourceSearch}
        docText={doc?.text ?? ""}
        docVersion={docVersion}
        showReplace={findShowReplace}
        onShowReplace={setFindShowReplace}
        onClose={closeFind}
        readWrap={readerWrapRef}
        focusNonce={findFocusNonce}
      />
    )}
  </div>
);
```

把分屏分支里的 `editor={<div className="editor-wrap">…</div>}` 替换成 `editor={editorPane}`，把最后的 `else` 分支（原先源码编辑器）替换成 `editorPane`。实时和源码现在共用同一个元素，靠 `live` 属性切换。

- [ ] **Step 4: 状态栏文案**

```tsx
{mode === "read"
  ? "阅读视图"
  : mode === "live"
    ? "实时模式"
    : mode === "split"
      ? "分屏模式"
      : "源码模式"}
```

- [ ] **Step 5: 检查**

Run: `pnpm exec tsc --noEmit`
Expected: 无错误。

手工：打开文档 → 点「实时」→ 界面是单栏编辑器，字体变成正文无衬线；点「源码」→ 回到等宽字体；撤销历史在切换后仍可用。

- [ ] **Step 6: 提交**

```bash
git add src/livePreview.ts src/components/SourceEditor.tsx src/App.tsx
git commit -m "feat: 实时视图挂载与编辑器复用"
```

---

### Task 5: 装饰核心——内联标记、活动块、原子区间、IME

**Files:**
- Modify: `src/livePreview.ts`
- Test: `src/livePreview.test.ts`（新建）

**Interfaces:**
- Produces: `buildLiveDecorations(state, opts): { decorations: DecorationSet; atomic: DecorationSet }`
- `LiveDecorationsOptions = { from, to, composing, docPath }`

- [ ] **Step 1: 写测试**

新建 `src/livePreview.test.ts`：

```ts
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { describe, expect, it } from "vitest";
import { buildLiveDecorations } from "./livePreview";

function stateFor(doc: string, head = doc.length) {
  return EditorState.create({
    doc,
    selection: { anchor: head },
    extensions: [markdown()],
  });
}

function build(doc: string, head = doc.length) {
  const state = stateFor(doc, head);
  return buildLiveDecorations(state, {
    from: 0,
    to: state.doc.length,
    composing: false,
    docPath: "/ws/a.md",
  });
}

function hiddenRanges(doc: string, head = doc.length) {
  const out: [number, number][] = [];
  build(doc, head).decorations.between(0, doc.length, (from, to, value) => {
    if (value.spec.widget == null && value.spec.class == null) out.push([from, to]);
  });
  return out;
}

const covers = (ranges: [number, number][], pos: number) =>
  ranges.some(([from, to]) => pos >= from && pos < to);

describe("live decorations", () => {
  it("hides a heading marker only when the cursor is outside the heading", () => {
    expect(hiddenRanges("# Title\n")).toEqual([[0, 1]]);
    expect(hiddenRanges("# Title\n", 3)).toEqual([]);
  });

  it("hides emphasis markers and keeps the text visible", () => {
    const ranges = hiddenRanges("**bold**\n");
    expect(covers(ranges, 0)).toBe(true);
    expect(covers(ranges, 1)).toBe(true);
    expect(covers(ranges, 3)).toBe(false);
    expect(covers(ranges, 6)).toBe(true);
  });

  it("hides link brackets and the URL but not the label", () => {
    const ranges = hiddenRanges("[label](https://example.com)\n");
    expect(covers(ranges, 0)).toBe(true);
    expect(covers(ranges, 2)).toBe(false);
    expect(covers(ranges, 10)).toBe(true);
  });

  it("marks the active block as atomic", () => {
    const { atomic } = build("**bold**\n");
    const ranges: [number, number][] = [];
    atomic.between(0, 10, (from, to) => ranges.push([from, to]));
    expect(ranges).toEqual([[0, 2], [6, 8]]);
  });

  it("emits no replace decorations while composing", () => {
    const state = stateFor("**bold**\n");
    const { decorations } = buildLiveDecorations(state, {
      from: 0,
      to: state.doc.length,
      composing: true,
      docPath: "/ws/a.md",
    });
    const hidden: [number, number][] = [];
    decorations.between(0, state.doc.length, (from, to, value) => {
      if (value.spec.widget == null && value.spec.class == null) hidden.push([from, to]);
    });
    expect(hidden).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run src/livePreview.test.ts`
Expected: FAIL —— `buildLiveDecorations` 未导出。

- [ ] **Step 3: 实现装饰模块**

把 `src/livePreview.ts` 改成（保留 Task 4 的主题）：

```ts
import { type EditorState, type Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";

/** Block nodes whose raw Markdown stays visible while the cursor is inside. */
const REVEAL_NODES = new Set([
  "Paragraph",
  "ATXHeading1",
  "ATXHeading2",
  "ATXHeading3",
  "ATXHeading4",
  "ATXHeading5",
  "ATXHeading6",
  "SetextHeading1",
  "SetextHeading2",
  "FencedCode",
  "ListItem",
  "Blockquote",
  "Table",
  "HTMLBlock",
  "HorizontalRule",
  "IndentedCode",
]);

export interface LiveDecorationsOptions {
  from: number;
  to: number;
  composing: boolean;
  docPath: string;
}

export interface LiveDecorations {
  decorations: DecorationSet;
  atomic: DecorationSet;
}

interface Range {
  from: number;
  to: number;
}

function revealRange(state: EditorState, pos: number): Range {
  let node = syntaxTree(state).resolveInner(
    Math.max(0, Math.min(pos, state.doc.length)),
    -1,
  );
  while (node.parent && !REVEAL_NODES.has(node.name)) node = node.parent;
  // Cursor on a blank line / between blocks: reveal that line only, never
  // the whole document (otherwise nothing would ever be hidden).
  if (node.name === "Document") {
    const l = state.doc.lineAt(pos);
    return { from: l.from, to: l.to };
  }
  const first = state.doc.lineAt(node.from);
  const endPos = node.to > node.from ? node.to - 1 : node.to;
  const last = state.doc.lineAt(endPos);
  return { from: first.from, to: last.to };
}

function activeLines(state: EditorState): Range {
  const sel = state.selection.main;
  const a = revealRange(state, sel.from);
  const b = revealRange(state, sel.to);
  return { from: Math.min(a.from, b.from), to: Math.max(a.to, b.to) };
}

function intersects(a: Range, b: Range): boolean {
  return a.from < b.to && a.to > b.from;
}

export function buildLiveDecorations(
  state: EditorState,
  opts: LiveDecorationsOptions,
): LiveDecorations {
  const active = activeLines(state);
  const hides: { from: number; to: number }[] = [];
  const marks: { from: number; to: number; cls: string }[] = [];
  const lineClasses = new Map<number, string[]>();

  const hide = (from: number, to: number) => {
    if (from >= to || opts.composing) return;
    hides.push({ from, to });
  };
  const mark = (from: number, to: number, cls: string) => {
    if (from < to) marks.push({ from, to, cls });
  };
  const line = (pos: number, cls: string) => {
    const list = lineClasses.get(pos);
    if (!list) lineClasses.set(pos, [cls]);
    else if (!list.includes(cls)) list.push(cls);
  };

  syntaxTree(state).iterate({
    from: opts.from,
    to: opts.to,
    enter: (ref) => {
      const n = ref.node;
      const activeHere = intersects({ from: n.from, to: n.to }, active);

      switch (n.name) {
        case "HeaderMark":
        case "EmphasisMark":
        case "StrikethroughMark":
          if (!activeHere) hide(n.from, n.to);
          return false;
        case "QuoteMark":
          if (!activeHere) hide(n.from, n.to);
          return false;
        case "InlineCode": {
          const cm = n.getChildren("CodeMark");
          if (cm.length >= 2) {
            if (!activeHere) {
              hide(cm[0].from, cm[0].to);
              hide(cm[cm.length - 1].from, cm[cm.length - 1].to);
            }
            mark(cm[0].to, cm[cm.length - 1].from, "rk-inline-code");
          }
          return false;
        }
        case "StrongEmphasis": {
          const em = n.getChildren("EmphasisMark");
          if (em.length >= 2) {
            if (!activeHere) {
              hide(em[0].from, em[0].to);
              hide(em[em.length - 1].from, em[em.length - 1].to);
            }
            mark(em[0].to, em[em.length - 1].from, "rk-strong");
          }
          return false;
        }
        case "Emphasis": {
          const em = n.getChildren("EmphasisMark");
          if (em.length >= 2) {
            if (!activeHere) {
              hide(em[0].from, em[0].to);
              hide(em[em.length - 1].from, em[em.length - 1].to);
            }
            mark(em[0].to, em[em.length - 1].from, "rk-em");
          }
          return false;
        }
        case "Link": {
          const lm = n.getChildren("LinkMark");
          if (lm.length > 0) {
            if (!activeHere) {
              for (const m of lm) hide(m.from, m.to);
              const url = n.getChild("URL");
              if (url) hide(url.from, url.to);
            }
            const textTo = lm[1]?.from ?? n.to;
            mark(lm[0].to, textTo, "rk-link");
          }
          return false;
        }
        case "ATXHeading1":
        case "ATXHeading2":
        case "ATXHeading3":
        case "ATXHeading4":
        case "ATXHeading5":
        case "ATXHeading6":
          line(state.doc.lineAt(n.from).from, `rk-h${n.name.slice(-1)}`);
          return;
        case "Blockquote": {
          for (let p = n.from; p <= n.to; ) {
            const l = state.doc.lineAt(p);
            line(l.from, "rk-quote");
            p = l.to + 1;
          }
          return;
        }
        case "FencedCode": {
          for (let p = n.from; p <= n.to; ) {
            const l = state.doc.lineAt(p);
            line(l.from, "rk-code");
            p = l.to + 1;
          }
          return false;
        }
        default:
          return;
      }
    },
  });

  const ranges = [
    ...hides.map((h) => Decoration.replace({}).range(h.from, h.to)),
    ...marks.map((m) => Decoration.mark({ class: m.cls }).range(m.from, m.to)),
    ...Array.from(lineClasses, ([pos, classes]) =>
      Decoration.line({ class: classes.join(" ") }).range(pos),
    ),
  ];

  return {
    decorations: Decoration.set(ranges, true),
    atomic: Decoration.set(
      hides.map((h) => Decoration.replace({}).range(h.from, h.to)),
      true,
    ),
  };
}

const liveTheme = EditorView.theme({
  "&.rk-live .cm-scroller": {
    fontFamily: "inherit",
    fontSize: "15px",
    lineHeight: "1.75",
  },
  "&.rk-live .cm-content": {
    maxWidth: "860px",
    padding: "24px 16px 60vh",
  },
  "&.rk-live .cm-line": {
    padding: "0 8px",
  },
});

export function livePreview(docPath: string): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      atomic: DecorationSet;

      constructor(view: EditorView) {
        const built = build(view, docPath);
        this.decorations = built.decorations;
        this.atomic = built.atomic;
      }

      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.selectionSet ||
          update.viewportChanged ||
          update.focusChanged
        ) {
          const built = build(update.view, docPath);
          this.decorations = built.decorations;
          this.atomic = built.atomic;
        }
      }
    },
    { decorations: (v) => v.decorations },
  );

  return [
    plugin,
    EditorView.atomicRanges.of(
      (view) => view.plugin(plugin)?.atomic ?? Decoration.none,
    ),
    EditorView.editorAttributes.of({ class: "rk-live" }),
    liveTheme,
  ];
}

function build(view: EditorView, docPath: string): LiveDecorations {
  const ranges = view.visibleRanges;
  return buildLiveDecorations(view.state, {
    from: ranges[0]?.from ?? 0,
    to: ranges[ranges.length - 1]?.to ?? view.state.doc.length,
    composing: view.composing,
    docPath,
  });
}
```

- [ ] **Step 4: 运行测试**

Run: `pnpm exec vitest run src/livePreview.test.ts`
Expected: PASS。如果 `Decoration.set` 报重叠错误，把 `HeaderMark` / `EmphasisMark` 的 `hide` 范围改为不与 mark 同起点（mark 从第一个标记的 `to` 开始，已经是这样），并确认没有同时 replace 同一个节点。

- [ ] **Step 5: 类型检查**

Run: `pnpm exec tsc --noEmit`
Expected: 无错误。

- [ ] **Step 6: 提交**

```bash
git add src/livePreview.ts src/livePreview.test.ts
git commit -m "feat: 实时视图内联装饰与活动块露出"
```

---

### Task 6: 块级 widget——任务框、列表圆点、分隔线、frontmatter

> **实现备注（2026-10-31）**：CM6 禁止 ViewPlugin 提供 `block: true` 的装饰（渲染时抛 `Block decorations may not be specified via plugins`）。实际实现把分隔线改为「隐藏整行文本 + `rk-hr-line` 行装饰画边框」，不再使用 `HrWidget`。下方原始片段仅作历史参考，以代码为准；Task 9 的样式名也随之为 `.rk-hr-line`。

**Files:**
- Modify: `src/livePreview.ts`
- Test: `src/livePreview.test.ts`

**Interfaces:**
- Consumes: `buildLiveDecorations`（Task 5）
- Produces: `TaskWidget`、`BulletWidget`、`HrWidget`（内部类，可导出供测试）

- [ ] **Step 1: 写测试**

在 `src/livePreview.test.ts` 追加：

```ts
function widgetNames(doc: string, head = doc.length): string[] {
  const names: string[] = [];
  build(doc, head).decorations.between(0, doc.length, (_from, _to, value) => {
    if (value.spec.widget) names.push(value.spec.widget.constructor.name);
  });
  return names;
}

describe("block widgets", () => {
  it("renders a checkbox for a task item outside the active block", () => {
    expect(widgetNames("- [ ] todo\n")).toContain("TaskWidget");
    expect(widgetNames("- [ ] todo\n", 3)).not.toContain("TaskWidget");
  });

  it("renders a bullet for unordered lists but leaves ordered numbers alone", () => {
    expect(widgetNames("- item\n")).toContain("BulletWidget");
    expect(widgetNames("1. item\n")).not.toContain("BulletWidget");
  });

  it("renders a horizontal rule as a block widget", () => {
    expect(widgetNames("---\n\npara\n")).toContain("HrWidget");
  });

  it("dims a frontmatter block without hiding it", () => {
    const classes: string[] = [];
    build("---\ntitle: x\n---\n\nbody\n").decorations.between(0, 24, (_f, _t, value) => {
      if (typeof value.spec.class === "string") classes.push(value.spec.class);
    });
    expect(classes.some((c) => c.includes("rk-frontmatter"))).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run src/livePreview.test.ts`
Expected: FAIL —— TaskWidget / BulletWidget / HrWidget 未生成。

- [ ] **Step 3: 实现 widget 与分支**

在 `livePreview.ts` 的 `LiveDecorationsOptions` 之前加：

```ts
class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "rk-bullet";
    el.textContent = "•";
    return el;
  }
}

class TaskWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly from: number,
    readonly to: number,
  ) {
    super();
  }
  eq(other: TaskWidget) {
    return (
      other.checked === this.checked &&
      other.from === this.from &&
      other.to === this.to
    );
  }
  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "rk-task";
    box.checked = this.checked;
    box.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({
        changes: {
          from: this.from,
          to: this.to,
          insert: this.checked ? "[ ]" : "[x]",
        },
      });
    });
    return box;
  }
}

class HrWidget extends WidgetType {
  constructor(readonly pos: number) {
    super();
  }
  eq(other: HrWidget) {
    return other.pos === this.pos;
  }
  get estimatedHeight() {
    return 20;
  }
  toDOM(view: EditorView) {
    const hr = document.createElement("hr");
    hr.className = "rk-hr";
    hr.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({ selection: { anchor: this.pos } });
    });
    return hr;
  }
}
```

在 `buildLiveDecorations` 的 `syntaxTree(...)` 之前先算 frontmatter：

```ts
  const fm = frontmatterLines(state);
```

在 `enter` 回调的最前面加：

```ts
      // Frontmatter is not a lezer node; never decorate inside it.
      if (fm && n.from >= fm.from && n.to <= fm.to) return false;
```

在 `buildLiveDecorations` 里增加 `widgets` 收集：

```ts
const widgets: { from: number; to: number; deco: Decoration }[] = [];
const widget = (from: number, to: number, w: WidgetType) => {
  if (from >= to || opts.composing) return;
  widgets.push({ from, to, deco: Decoration.replace({ widget: w }) });
};
```

`switch` 里追加分支（放在 `default` 之前）：

```ts
        case "ListMark": {
          if (!activeHere && n.parent?.parent?.name === "BulletList") {
            widget(n.from, n.to, new BulletWidget());
          }
          return false;
        }
        case "TaskMarker": {
          if (!activeHere) {
            const checked = state.doc
              .sliceString(n.from, n.to)
              .toLowerCase()
              .includes("x");
            widget(n.from, n.to, new TaskWidget(checked, n.from, n.to));
          }
          return false;
        }
        case "HorizontalRule": {
          if (!activeHere && n.parent?.name === "Document") {
            const l = state.doc.lineAt(n.from);
            widget(l.from, l.to, new HrWidget(l.from));
          }
          return false;
        }
```

在返回前把 widgets 合并进 decorations：

```ts
    ...widgets.map((w) => w.deco.range(w.from, w.to)),
```

并在 `syntaxTree` 循环之后给 frontmatter 加行样式：

```ts
  if (fm && !intersects(fm, active)) {
    for (let p = fm.from; p <= fm.to; ) {
      const l = state.doc.lineAt(p);
      line(l.from, "rk-frontmatter");
      p = l.to + 1;
    }
  }
```

文件底部加：

```ts
function frontmatterLines(state: EditorState): Range | null {
  const doc = state.doc;
  if (doc.lines < 2 || doc.line(1).text.trimEnd() !== "---") return null;
  for (let n = 2; n <= doc.lines; n++) {
    const t = doc.line(n).text.trim();
    if (t === "---" || t === "...") return { from: 0, to: doc.line(n).to };
  }
  return null;
}
```

- [ ] **Step 4: 运行测试**

Run: `pnpm exec vitest run src/livePreview.test.ts`
Expected: PASS

- [ ] **Step 5: 类型检查**

Run: `pnpm exec tsc --noEmit`
Expected: 无错误。

- [ ] **Step 6: 提交**

```bash
git add src/livePreview.ts src/livePreview.test.ts
git commit -m "feat: 实时视图任务框/列表/分隔线/frontmatter 装饰"
```

---

### Task 7: 图片 widget 与相对路径解析

**Files:**
- Modify: `src/livePreview.ts`
- Test: `src/livePreview.test.ts`

**Interfaces:**
- Produces: `resolveImagePath(docPath: string, rawSrc: string): string | null`
- Consumes: `pathDirname` from `./fileOps`

- [ ] **Step 1: 写测试**

追加：

```ts
import { resolveImagePath } from "./livePreview";

describe("resolveImagePath", () => {
  it("resolves relative paths next to the document", () => {
    expect(resolveImagePath("/ws/doc/a.md", "./img/x.png")).toBe(
      "/ws/doc/img/x.png",
    );
    expect(resolveImagePath("/ws/doc/a.md", "../assets/中文 图.png")).toBe(
      "/ws/assets/中文 图.png",
    );
    expect(resolveImagePath("C:\\ws\\doc\\a.md", ".\\img\\x.png")).toBe(
      "C:/ws/doc/img/x.png",
    );
  });

  it("decodes percent-encoded names", () => {
    expect(resolveImagePath("/ws/a.md", "img/%E4%B8%AD%E6%96%87.png")).toBe(
      "/ws/img/中文.png",
    );
  });

  it("passes absolute and non-file references through", () => {
    expect(resolveImagePath("/ws/a.md", "https://example.com/x.png")).toBeNull();
    expect(resolveImagePath("/ws/a.md", "http://example.com/x.png")).toBeNull();
    expect(resolveImagePath("/ws/a.md", "data:image/png;base64,xx")).toBeNull();
    expect(resolveImagePath("/ws/a.md", "asset://localhost/x.png")).toBeNull();
    expect(resolveImagePath("/ws/a.md", "#anchor")).toBeNull();
  });

  it("clamps parent traversal at the root", () => {
    expect(resolveImagePath("/ws/a.md", "../../x.png")).toBe("/x.png");
  });
});

describe("image widget", () => {
  it("replaces an image node outside the active block", () => {
    expect(widgetNames("![alt](img.png)\n")).toContain("ImageWidget");
    expect(widgetNames("![alt](img.png)\n", 2)).not.toContain("ImageWidget");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run src/livePreview.test.ts`
Expected: FAIL —— `resolveImagePath` 未导出，`ImageWidget` 未生成。

- [ ] **Step 3: 实现**

在 `livePreview.ts` 顶部加：

```ts
import { pathDirname } from "./fileOps";
import { convertFileSrc } from "@tauri-apps/api/core";
```

加 `ImageWidget`：

```ts
class ImageWidget extends WidgetType {
  constructor(
    readonly docPath: string,
    readonly rawSrc: string,
    readonly alt: string,
    readonly from: number,
  ) {
    super();
  }
  eq(other: ImageWidget) {
    return (
      other.docPath === this.docPath &&
      other.rawSrc === this.rawSrc &&
      other.alt === this.alt &&
      other.from === this.from
    );
  }
  get estimatedHeight() {
    return 180;
  }
  toDOM(view: EditorView) {
    const img = document.createElement("img");
    img.className = "rk-image";
    img.alt = this.alt;
    const path = resolveImagePath(this.docPath, this.rawSrc);
    try {
      img.src = path ? convertFileSrc(path) : this.rawSrc;
    } catch {
      img.src = this.rawSrc;
    }
    img.addEventListener("load", () => view.requestMeasure());
    img.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({ selection: { anchor: this.from } });
    });
    return img;
  }
}
```

`buildLiveDecorations` 的 `switch` 里加：

```ts
        case "Image": {
          if (!activeHere) {
            const marks = n.getChildren("LinkMark");
            const alt =
              marks.length >= 2
                ? state.doc.sliceString(marks[0].to, marks[1].from)
                : "";
            const url = n.getChild("URL");
            const rawSrc = url ? state.doc.sliceString(url.from, url.to) : "";
            widget(
              n.from,
              n.to,
              new ImageWidget(opts.docPath, rawSrc, alt, n.from),
            );
          }
          return false;
        }
```

图片的 alt 直接取两个 `LinkMark` 之间的原文（`![` 与 `]`），URL 取 `URL` 子节点；不需要额外类型 import。

加导出函数：

```ts
const ABSOLUTE_SRC = /^(?:https?:|data:|#|asset:)/i;

/** Resolve a Markdown image src to an absolute local path, mirroring
 * core/markdown.rs::resolve_img_path. Returns null for remote/data/anchor
 * references and when the document has no directory. */
export function resolveImagePath(docPath: string, rawSrc: string): string | null {
  if (!docPath) return null;
  let decoded = rawSrc.trim();
  if (!decoded || ABSOLUTE_SRC.test(decoded)) return null;
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    /* keep the raw text; malformed escapes stay literal */
  }
  const dir = pathDirname(docPath).replace(/\\/g, "/");
  if (!dir) return null;
  return normalizePath(`${dir}/${decoded.replace(/\\/g, "/").replace(/^\/+/, "")}`);
}

/** Lexical `.` / `..` resolution; never touches the filesystem. */
function normalizePath(p: string): string {
  const drive = /^[A-Za-z]:/.exec(p)?.[0] ?? "";
  const rest = p.slice(drive.length);
  const abs = rest.startsWith("/");
  const out: string[] = [];
  for (const seg of rest.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!abs && !drive) out.push("..");
    } else {
      out.push(seg);
    }
  }
  return (drive || "") + (abs ? "/" : "") + out.join("/");
}
```

- [ ] **Step 4: 运行测试**

Run: `pnpm exec vitest run src/livePreview.test.ts`
Expected: PASS

- [ ] **Step 5: 类型检查**

Run: `pnpm exec tsc --noEmit`
Expected: 无错误。

- [ ] **Step 6: 提交**

```bash
git add src/livePreview.ts src/livePreview.test.ts
git commit -m "feat: 实时视图图片渲染与相对路径解析"
```

---

### Task 8: 实时大纲

**Files:**
- Modify: `src/headingLocate.ts`
- Modify: `src/headingLocate.test.ts`
- Modify: `src/App.tsx`

**Interfaces:**
- Produces: `scanHeadings(doc: string): ScannedHeading[]`
- Produces: `outlineFromMarkdown(doc: string): OutlineItem[]`
- Existing `headingLineById` 改为复用 `scanHeadings`，行为不变

- [ ] **Step 1: 写测试**

在 `src/headingLocate.test.ts` 追加：

```ts
import { outlineFromMarkdown, scanHeadings } from "./headingLocate";

describe("scanHeadings", () => {
  it("returns level, text, slug and 1-based line", () => {
    expect(scanHeadings("# 标题\n\n## 子标题\n")).toEqual([
      { level: 1, text: "标题", id: "标题", line: 1 },
      { level: 2, text: "子标题", id: "子标题", line: 3 },
    ]);
  });

  it("numbers duplicate slugs like the Rust renderer", () => {
    expect(scanHeadings("# A\n# A\n").map((h) => h.id)).toEqual(["a", "a-1"]);
  });

  it("skips frontmatter", () => {
    expect(scanHeadings("---\ntitle: x\n---\n# Real\n").map((h) => h.id)).toEqual([
      "real",
    ]);
  });
});

describe("outlineFromMarkdown", () => {
  it("drops line numbers for the sidebar outline", () => {
    expect(outlineFromMarkdown("# A\n")).toEqual([
      { level: 1, text: "A", id: "a" },
    ]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run src/headingLocate.test.ts`
Expected: FAIL —— 未导出。

- [ ] **Step 3: 实现**

`src/headingLocate.ts` 加类型与扫描函数，并让 `headingLineById` 复用它：

```ts
import type { OutlineItem } from "./ipc";

export interface ScannedHeading {
  level: number;
  text: string;
  id: string;
  /** 1-based source line. */
  line: number;
}

export function scanHeadings(doc: string): ScannedHeading[] {
  const out: ScannedHeading[] = [];
  const seen = new Map<string, number>();
  const lines = doc.split("\n");
  let i = 0;
  if ((lines[0] ?? "").trimEnd() === "---") {
    for (i = 1; i < lines.length; i++) {
      const t = lines[i].trim();
      if (t === "---" || t === "...") {
        i += 1;
        break;
      }
    }
  }
  for (; i < lines.length; i++) {
    const m = /^ {0,3}(#{1,6})(\s+.*)?$/.exec(lines[i]);
    if (!m) continue;
    const text = (m[2] ?? "")
      .trimEnd()
      .replace(/\s+#+\s*$/, "")
      .replace(/[`*]/g, "")
      .trim();
    out.push({
      level: m[1].length,
      text,
      id: allocateSlug(seen, text),
      line: i + 1,
    });
  }
  return out;
}

export function outlineFromMarkdown(doc: string): OutlineItem[] {
  return scanHeadings(doc).map(({ level, text, id }) => ({ level, text, id }));
}

export function headingLineById(doc: string): Map<string, number> {
  return new Map(scanHeadings(doc).map((h) => [h.id, h.line]));
}
```

删除原来 `headingLineById` 的重复实现（保留 `allocateSlug` / `slugify`）。

- [ ] **Step 4: 运行测试**

Run: `pnpm exec vitest run src/headingLocate.test.ts`
Expected: PASS（原有 slug 用例 + 新增用例）

- [ ] **Step 5: App 接入大纲**

`App.tsx` import `outlineFromMarkdown`。

状态：

```ts
const [liveOutline, setLiveOutline] = useState<OutlineItem[]>([]);
const liveOutlineTimer = useRef<number | null>(null);
```

回调：

```ts
const scheduleLiveOutline = useCallback(() => {
  if (liveOutlineTimer.current != null) {
    window.clearTimeout(liveOutlineTimer.current);
  }
  liveOutlineTimer.current = window.setTimeout(() => {
    liveOutlineTimer.current = null;
    setLiveOutline(outlineFromMarkdown(editTextRef.current));
  }, 300);
}, []);
```

`handleEditorChange` 里：

```ts
if (stateRef.current.mode === "live") scheduleLiveOutline();
```

`switchMode` 里在 `editTextRef.current = nextEditorText(...)` 之后加：

```ts
if (next === "live") {
  setLiveOutline(outlineFromMarkdown(editTextRef.current));
}
```

`openFile` 成功设置 `editTextRef.current = d.text` 之后：

```ts
if (stateRef.current.mode === "live") {
  setLiveOutline(outlineFromMarkdown(d.text));
}
```

`currentOutline` 改为：

```ts
const currentOutline =
  mode === "live"
    ? liveOutline
    : mode === "split" && previewMeta
      ? previewMeta.outline
      : doc?.chunked
        ? doc.chunked.outline
        : (doc?.outline ?? []);
```

`jumpToHeading` 的源码分支改成同时覆盖实时：

```ts
if (stateRef.current.mode === "edit" || stateRef.current.mode === "live") {
  const line = headingLineById(editTextRef.current).get(id);
  if (line != null) editorRef.current?.gotoLine(line);
  return;
}
```

- [ ] **Step 6: 检查**

Run: `pnpm exec tsc --noEmit && pnpm exec vitest run src/headingLocate.test.ts`
Expected: 全部通过。

手工：实时视图输入 `## 新标题`，300ms 后侧栏大纲出现该项；点击跳到对应行。

- [ ] **Step 7: 提交**

```bash
git add src/headingLocate.ts src/headingLocate.test.ts src/App.tsx
git commit -m "feat: 实时视图大纲扫描与跳转"
```

---

### Task 9: 搜索/锚点定位、样式与回归

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/changeDecision.test.ts`
- Modify: `src/index.css`

**Interfaces:**
- Consumes: Tasks 1–8 的全部产出

- [ ] **Step 1: 先补测试**

`src/changeDecision.test.ts` 追加：

```ts
it("prompts for a dirty live buffer", () => {
  expect(decideFsChange(base({ mode: "live", dirty: true }))).toBe("prompt");
});
```

- [ ] **Step 2: 运行确认**

Run: `pnpm exec vitest run src/changeDecision.test.ts`
Expected: PASS（`mode !== "read"` 已覆盖 live；如果失败再改 `decideFsChange`，不需要改）。

- [ ] **Step 3: 搜索命中与锚点**

`handleSearchHit`：

```ts
if (mode === "split" || mode === "live") {
  if (line == null) return;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      editorRef.current?.scrollToLine(line);
    });
  });
  return;
}
```

`jumpAnchor` 在 chunked 分支之前加：

```ts
if (s.mode === "edit" || s.mode === "live") {
  const line = headingLineById(editTextRef.current).get(id);
  if (line == null) return false;
  editorRef.current?.gotoLine(line);
  pendingAnchorRef.current = null;
  return true;
}
```

- [ ] **Step 4: 样式**

在 `src/index.css` 末尾追加：

```css
/* ── 实时编辑（live preview）──────────────────────────────────────── */
.rk-h1 { font-size: 1.8em; font-weight: 700; color: var(--heading); padding-top: 0.5em; }
.rk-h2 { font-size: 1.45em; font-weight: 700; color: var(--heading); padding-top: 0.45em; }
.rk-h3 { font-size: 1.2em; font-weight: 700; color: var(--heading); padding-top: 0.4em; }
.rk-h4, .rk-h5, .rk-h6 { font-weight: 700; color: var(--heading); padding-top: 0.35em; }

.rk-strong { font-weight: 700; }
.rk-em { font-style: italic; }
.rk-strike { text-decoration: line-through; }
.rk-inline-code {
  font-family: "Cascadia Code", Consolas, monospace;
  background: var(--code-bg);
  color: var(--code-text);
  border-radius: 4px;
  padding: 0.1em 0.3em;
}
.rk-link { color: var(--link); text-decoration: underline; }

.rk-quote {
  border-left: 3px solid var(--border);
  padding-left: 12px;
  color: var(--quote-text);
}
.rk-code { background: var(--code-bg); }
.rk-frontmatter { opacity: 0.55; }

.rk-bullet { color: var(--accent); padding-right: 0.35em; }
.rk-task { vertical-align: middle; margin-right: 0.35em; accent-color: var(--accent); }
.rk-hr-line { border-top: 1px solid var(--border); padding-top: 1.2em; }
.rk-image { max-width: 100%; border-radius: 6px; display: block; margin: 0.5em 0; }
```

- [ ] **Step 5: 全量检查**

Run:

```bash
pnpm exec tsc --noEmit
pnpm test
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: 前端全部通过；Rust 测试通过（Windows 专属的两条既有失败与本改动无关，按仓库现状处理）。

- [ ] **Step 6: 手工验收**

按 `design/wysiwyg-live-preview.md` §8 的清单逐项执行，重点：

1. 中文输入法连续输入、候选切换、组合中按方向键：不吞字、不重复、不跳光标。
2. 标题/粗体/链接：光标进入该块时标记出现，离开后隐藏。
3. 任务框点击后原文从 `[ ]` 变 `[x]`，撤销可回退。
4. 图片相对路径（含中文/空格）正常显示；点击图片回到源码。
5. 斜杠面板、右键菜单、富文本粘贴、Ctrl+F 替换。
6. 大文档（>1MB）滚动流畅。
7. 启动模式四种取值；无文件启动保持阅读。
8. 阅读 / 导出 / 分享结果不变。

- [ ] **Step 7: 提交**

```bash
git add src/App.tsx src/changeDecision.test.ts src/index.css
git commit -m "feat: 实时视图搜索/锚点定位与样式"
```

---

## 自检

- **Spec 覆盖：** 四视图与 Ctrl+Tab（Task 1/2）、启动模式设置（Task 3）、编辑器复用（Task 4）、内联与活动块（Task 5）、块级 widget（Task 6）、图片（Task 7）、大纲（Task 8）、搜索/锚点/样式（Task 9）、IME/原子区间（Task 5）。
- **不做：** 代码块高亮 widget、公式、Mermaid、表格网格、frontmatter 折叠（P2/P3）。
- **类型一致性：** `Mode` 四态贯穿 `split.ts` / `TitleBar` / `App`；`buildLiveDecorations` 的 `LiveDecorations` 返回值在插件中按 `{decorations, atomic}` 使用；`resolveImagePath` 返回 `string | null`。
