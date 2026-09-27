/** Editor formatting & insertion commands over the CodeMirror view.
 *
 * The planning functions are pure `EditorState → EditPlan` computations so
 * they can be unit-tested without a DOM; the view-level wrappers dispatch
 * the plan. Every command acts on the main selection range and returns true
 * so a keymap binding always claims its chord. Prefix toggles and the
 * callout-clear omit the plan's selection, letting CodeMirror map the
 * current selection through the changes on its own. */

import { type ChangeSpec, type EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

export interface EditPlan {
  changes: ChangeSpec | ChangeSpec[];
  /** Omit to let CodeMirror map the current selection through the changes. */
  selection?: { anchor: number; head?: number };
}

/** Block-level prefix spec: heading level, quote, or a list kind. */
export type BlockSpec = number | "quote" | "ul" | "ol" | "task";

function mainRange(state: EditorState): { from: number; to: number } {
  const r = state.selection.main;
  return { from: r.from, to: r.to };
}

function dispatchPlan(view: EditorView, plan: EditPlan, userEvent: string): void {
  view.dispatch({ ...plan, userEvent });
}

/* ── inline wrap (bold / italic / link / raw-HTML spans …) ────────── */

export interface WrapOptions {
  /** Marker inserted before the selection (also the toggle-off probe). */
  before: string;
  /** Marker inserted after the selection. */
  after: string;
  /** Inserted (and selected) when the selection is empty. */
  placeholder?: string;
  /** [start, end] range inside `after` to select after wrapping — the URL
   * slot of `](https://)`. Applies to both the empty and filled cases. */
  selectInAfter?: [number, number];
  /** Toggle off when the selection is already wrapped (default true). */
  toggle?: boolean;
}

export function planWrap(state: EditorState, opts: WrapOptions): EditPlan {
  const { from, to } = mainRange(state);
  const doc = state.doc;
  const { before, after } = opts;

  const canToggle =
    opts.toggle !== false &&
    from >= before.length &&
    to + after.length <= doc.length;
  if (
    canToggle &&
    doc.sliceString(from - before.length, from) === before &&
    doc.sliceString(to, to + after.length) === after
  ) {
    const inner = doc.sliceString(from, to);
    const at = from - before.length;
    return {
      changes: { from: at, to: to + after.length, insert: inner },
      selection: { anchor: at, head: at + inner.length },
    };
  }

  if (from === to) {
    const ph = opts.placeholder ?? "";
    return {
      changes: { from, insert: before + ph + after },
      selection: opts.selectInAfter
        ? {
            anchor: from + before.length + ph.length + opts.selectInAfter[0],
            head: from + before.length + ph.length + opts.selectInAfter[1],
          }
        : { anchor: from + before.length, head: from + before.length + ph.length },
    };
  }

  const sel = doc.sliceString(from, to);
  let anchor = from + before.length;
  let head = to + before.length;
  if (opts.selectInAfter) {
    const base = from + before.length + sel.length;
    anchor = base + opts.selectInAfter[0];
    head = base + opts.selectInAfter[1];
  }
  return {
    changes: { from, to, insert: before + sel + after },
    selection: { anchor, head },
  };
}

export function toggleWrap(
  view: EditorView,
  before: string,
  after: string,
  opts: Omit<WrapOptions, "before" | "after"> = {},
): boolean {
  dispatchPlan(view, planWrap(view.state, { ...opts, before, after }), "input.format");
  return true;
}

/* ── block insertion (fence / table / hr / callout …) ─────────────── */

export interface BlockOptions {
  /** [start, end] offsets within `text` to select after insertion. */
  select?: [number, number];
}

/** Insert `text` as a standalone block at the selection, with CommonMark
 * blank-line separation so the block never attaches to surrounding
 * paragraphs (a bare `---` right after a paragraph would be a setext
 * heading). Replaces a non-empty selection; `opts.select` then positions
 * the selection inside the inserted text. */
export function planInsertBlock(
  state: EditorState,
  text: string,
  opts: BlockOptions = {},
): EditPlan {
  const { from, to } = mainRange(state);
  const doc = state.doc;
  const line = doc.lineAt(to);
  const before = doc.sliceString(Math.max(0, from - 2), from);
  const prefix = from === 0 || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const restOfLine = doc.sliceString(to, line.to);
  // Mid-line: close the block and leave a blank before the trailing text.
  // At line end the original newline after the cursor already terminates the
  // block, so one more newline provides the blank line when content follows.
  const suffix = restOfLine.trim() !== "" ? "\n\n" : "\n";
  const insert = prefix + text + suffix;
  const start = from + prefix.length;
  const selection = opts.select
    ? { anchor: start + opts.select[0], head: start + opts.select[1] }
    : { anchor: start + text.length };
  return { changes: { from, to, insert }, selection };
}

export function insertBlock(view: EditorView, text: string, opts?: BlockOptions): boolean {
  dispatchPlan(view, planInsertBlock(view.state, text, opts), "input.insert");
  return true;
}

/** Wrap a non-empty selection in a fenced block; otherwise insert an empty
 * fence with the cursor inside. */
export function insertCodeBlock(view: EditorView): boolean {
  const { from, to } = mainRange(view.state);
  if (from === to) return insertBlock(view, "```\n\n```", { select: [4, 4] });
  const sel = view.state.sliceDoc(from, to);
  dispatchPlan(
    view,
    {
      changes: { from, to, insert: "```\n" + sel + "\n```" },
      selection: { anchor: from + 4 + sel.length + 1 + 3 },
    },
    "input.insert",
  );
  return true;
}

/** Same shape as the code fence, for display math (rendering lands in a
 * later release; the syntax is standard `$$…$$`). */
export function insertMathBlock(view: EditorView): boolean {
  const { from, to } = mainRange(view.state);
  if (from === to) return insertBlock(view, "$$\n\n$$", { select: [3, 3] });
  const sel = view.state.sliceDoc(from, to);
  dispatchPlan(
    view,
    {
      changes: { from, to, insert: "$$\n" + sel + "\n$$" },
      selection: { anchor: from + 3 + sel.length + 1 + 2 },
    },
    "input.insert",
  );
  return true;
}

export function insertHr(view: EditorView): boolean {
  return insertBlock(view, "---");
}

const TABLE_TEMPLATE = "| 表头 | 表头 | 表头 |\n| --- | --- | --- |\n| 内容 | 内容 | 内容 |";

export function insertTable(view: EditorView): boolean {
  return insertBlock(view, TABLE_TEMPLATE, { select: [2, 4] });
}

const MINDMAP_TEMPLATE =
  "```mermaid\nmindmap\n  root((主题))\n    分支一\n      细分一\n    分支二\n```";

export function insertMindmap(view: EditorView): boolean {
  return insertBlock(view, MINDMAP_TEMPLATE);
}

/* ── callouts (GitHub alerts) ─────────────────────────────────────── */

/** Insert a GitHub-style alert block. A non-empty selection is quoted line
 * by line under the marker; an empty one opens a fresh block with the
 * cursor on the first body line. */
export function insertCallout(view: EditorView, type: string): boolean {
  const { from, to } = mainRange(view.state);
  const header = `> [!${type}]`;
  if (from !== to) {
    const sel = view.state.sliceDoc(from, to);
    const quoted = sel
      .split("\n")
      .map((l) => (l.trim() === "" ? ">" : "> " + l))
      .join("\n");
    dispatchPlan(
      view,
      {
        changes: { from, to, insert: `${header}\n${quoted}` },
        selection: { anchor: from + header.length + 1 + quoted.length },
      },
      "input.insert",
    );
    return true;
  }
  return insertBlock(view, `${header}\n> `);
}

/** Strip callout markers from the selected lines: the `> [!TYPE]` header
 * line goes away entirely, remaining quote markers are removed. */
export function planClearCallout(state: EditorState): { changes: ChangeSpec[] } {
  const doc = state.doc;
  const r = state.selection.main;
  const startLine = doc.lineAt(r.from).number;
  let endLine = doc.lineAt(r.to).number;
  if (r.to > r.from && doc.lineAt(r.to).from === r.to) endLine -= 1;
  if (endLine < startLine) endLine = startLine;
  const changes: ChangeSpec[] = [];
  for (let n = startLine; n <= endLine; n++) {
    const line = doc.line(n);
    if (/^>\s\[!\w+\]\s*$/.test(line.text)) {
      // Drop the whole header line, newline included (guarded at doc end).
      changes.push({ from: line.from, to: Math.min(line.to + 1, doc.length), insert: "" });
    } else if (line.text.startsWith("> ")) {
      changes.push({ from: line.from, to: line.from + 2, insert: "" });
    } else if (line.text === ">") {
      changes.push({ from: line.from, to: line.to, insert: "" });
    }
  }
  return { changes };
}

/** Strip callout markers from the selected lines: the `> [!TYPE]` header
 * line goes away entirely, remaining quote markers are removed. */
export function clearCallout(view: EditorView): boolean {
  const plan = planClearCallout(view.state);
  if (plan.changes.length > 0) {
    view.dispatch({ changes: plan.changes, userEvent: "delete.format" });
  }
  return true;
}

/* ── line-prefix toggles (headings / lists / quote) ───────────────── */

/** Any block-level marker, used to normalize when switching kinds. */
const BLOCK_PREFIX = /^(\s*)(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d{1,9}[.)][ \t]+)/;

function markerFor(spec: BlockSpec, index: number): string {
  if (typeof spec === "number") return "#".repeat(spec) + " ";
  if (spec === "quote") return "> ";
  if (spec === "task") return "- [ ] ";
  if (spec === "ol") return `${index + 1}. `;
  return "- ";
}

/** Does the line already carry this kind of marker (any list numbering /
 * bullet char counts — that is what a second application should remove)? */
function hasMarker(lineText: string, spec: BlockSpec): boolean {
  if (typeof spec === "number") return lineText.startsWith("#".repeat(spec) + " ");
  if (spec === "quote") return lineText.startsWith("> ");
  if (spec === "ol") return /^\d{1,9}[.)][ \t]/.test(lineText);
  if (spec === "task") return /^[-*+][ \t]\[[ xX]\][ \t]/.test(lineText);
  return /^[-*+][ \t](?!\[[ xX]\])/.test(lineText);
}

export function planTogglePrefix(state: EditorState, spec: BlockSpec): EditPlan {
  const doc = state.doc;
  const r = state.selection.main;
  const startLine = doc.lineAt(r.from).number;
  let endLine = doc.lineAt(r.to).number;
  if (r.to > r.from && doc.lineAt(r.to).from === r.to) endLine -= 1;
  if (endLine < startLine) endLine = startLine;
  const lines: ReturnType<typeof doc.line>[] = [];
  for (let n = startLine; n <= endLine; n++) lines.push(doc.line(n));

  const allHave = lines.every((l) => l.text.trim() === "" || hasMarker(l.text, spec));
  const changes: ChangeSpec[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const marker = markerFor(spec, i);
    if (allHave) {
      // Remove this kind of marker — exact match first, any block marker
      // otherwise (e.g. "2. " when the renumbered expectation is "1. ").
      if (line.text.startsWith(marker)) {
        changes.push({ from: line.from, to: line.from + marker.length, insert: "" });
      } else {
        const m = BLOCK_PREFIX.exec(line.text);
        if (m) changes.push({ from: line.from, to: line.from + m[0].length, insert: "" });
      }
    } else if (BLOCK_PREFIX.test(line.text)) {
      // Switching kinds: replace the existing marker wholesale.
      const m = BLOCK_PREFIX.exec(line.text)!;
      changes.push({ from: line.from, to: line.from + m[0].length, insert: marker });
    } else {
      changes.push({ from: line.from, insert: marker });
    }
  }
  // Cursor-only edits place the caret after the (un)applied marker so typing
  // continues inside the block; otherwise CodeMirror maps the selection.
  const selection =
    r.empty && lines.length === 1
      ? { anchor: allHave ? lines[0].from : lines[0].from + markerFor(spec, 0).length }
      : undefined;
  return { changes, selection };
}

export function togglePrefix(view: EditorView, spec: BlockSpec): boolean {
  dispatchPlan(view, planTogglePrefix(view.state, spec), "input.format");
  return true;
}

/* ── slash-command palette trigger ────────────────────────────────── */

/** The "/" or "、" a user just typed at the cursor — the slash-palette
 * trigger. Only direct typing qualifies (`input.type`): programmatic
 * inserts (our commands, paste, undo, external reloads) use other
 * userEvents and must never open the palette. IME-composed "、" lands here
 * too, since CodeMirror reports compositions as input.type. */
export function slashTrigger(update: {
  docChanged: boolean;
  transactions: readonly { isUserEvent(event: string): boolean }[];
  state: EditorState;
}): { pos: number; char: string } | null {
  if (!update.docChanged) return null;
  if (!update.transactions.some((tr) => tr.isUserEvent("input.type"))) return null;
  const head = update.state.selection.main.head;
  if (head === 0) return null;
  const ch = update.state.doc.sliceString(head - 1, head);
  return ch === "/" || ch === "、" ? { pos: head, char: ch } : null;
}

/* ── link & media insertions ──────────────────────────────────────── */

export function insertLink(view: EditorView): boolean {
  return toggleWrap(view, "[", "](https://)", {
    placeholder: "链接文本",
    selectInAfter: [2, 10],
    toggle: false,
  });
}

export function insertImageLink(view: EditorView): boolean {
  return toggleWrap(view, "![", "](https://)", {
    placeholder: "图片",
    selectInAfter: [2, 10],
    toggle: false,
  });
}

export function insertIframe(view: EditorView): boolean {
  return insertBlock(view, '<iframe src="https://" width="100%" height="360"></iframe>', {
    select: [13, 21],
  });
}

export function insertVideo(view: EditorView): boolean {
  return insertBlock(view, '<video src="https://" controls></video>', { select: [12, 20] });
}

export function insertAudio(view: EditorView): boolean {
  return insertBlock(view, '<audio src="https://" controls></audio>', { select: [12, 20] });
}
