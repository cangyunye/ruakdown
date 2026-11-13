import { type EditorState, StateField, type Text } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType as CmWidgetType,
} from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { api } from "./ipc";
import { mermaidSvg, renderMermaidBlocks } from "./mermaid";

/** Structural view of the lezer syntax nodes this module traverses.
 * (@codemirror/language depends on @lezer/common but doesn't re-export the
 * type, and it isn't a direct dependency — the structural shape keeps the
 * import surface unchanged.) */
interface MdNode {
  name: string;
  from: number;
  to: number;
  nextSibling: MdNode | null;
}

/**
 * Block-level rendering for the live view: every top-level block becomes a
 * real DOM widget whenever the cursor sits outside it, and falls back to raw
 * Markdown the moment the cursor enters (the reading view's authority rule,
 * Typora/Obsidian style). Prose blocks (paragraphs, headings, quotes, lists,
 * html), fenced code and horizontal rules render through Rust's
 * `render_fragment` — the same pipeline the reader uses — so an inactive
 * block is byte-identical to the reading view by construction, not by
 * mirrored CSS. Tables keep a local TS renderer and math/mermaid their
 * dedicated widgets; all three predate this generalization and stay.
 *
 * Why a StateField: CM6 forbids block replace decorations from ViewPlugins
 * ("Block decorations may not be specified via plugins"), so this cannot
 * live in livePreview.ts's plugin. Block ranges come from the lezer syntax
 * tree (the same GFM parse the inline decorator reads), rebuilt whenever the
 * document changes — the parse itself is shared and incremental, so the walk
 * over top-level nodes is the only added cost per keystroke.
 */

export type TableAlign = "left" | "center" | "right" | "none";

export interface ParsedTable {
  header: string[];
  aligns: TableAlign[];
  rows: string[][];
}

export type LiveBlock =
  | { kind: "table"; from: number; to: number; table: ParsedTable }
  | { kind: "mermaid"; from: number; to: number; source: string }
  | { kind: "math"; from: number; to: number; tex: string }
  /** Fenced code: fragment-rendered (Rust highlights it, same as reading). */
  | { kind: "code"; from: number; to: number; text: string }
  /** Paragraph / heading / quote / list / html block: fragment-rendered. */
  | { kind: "prose"; from: number; to: number; text: string }
  /** Thematic break: a local `<hr>`, no IPC. */
  | { kind: "hr"; from: number; to: number };

/* ------------------------------------------------------------------ */
/* Document structure                                                  */
/* ------------------------------------------------------------------ */

/** Frontmatter scan cap, kept identical to livePreview.ts's card cap: past
 * it the block is treated as ordinary content. */
const FM_SCAN_LINES = 200;

/** End of the opening frontmatter block (the closing fence's end), or 0
 * when the document has none. Blocks before this position are never
 * widget-rendered. */
function frontmatterEnd(doc: Text): number {
  if (doc.lines < 2 || doc.line(1).text.trimEnd() !== "---") return 0;
  const last = Math.min(doc.lines, FM_SCAN_LINES);
  for (let n = 2; n <= last; n++) {
    const t = doc.line(n).text.trimEnd();
    if (t === "---" || t === "...") return doc.line(n).to;
  }
  return 0;
}

/** Above this document size only table/math/mermaid stay widget-rendered:
 * the per-keystroke block walk plus decoration rebuild must stay cheap, and
 * on a multi-thousand-line document the prose widgets' value drops while
 * their cost grows. (>1MB chunked docs in live mode fall into this too.) */
const ALL_BLOCK_LIMIT = 200_000;

/** Top-level lezer nodes that render through the Rust fragment pipeline. */
const PROSE_NODES = new Set([
  "Paragraph",
  "ATXHeading1",
  "ATXHeading2",
  "ATXHeading3",
  "ATXHeading4",
  "ATXHeading5",
  "ATXHeading6",
  "SetextHeading1",
  "SetextHeading2",
  "Blockquote",
  "BulletList",
  "OrderedList",
  "HTMLBlock",
]);

/** Split one table row into trimmed cell texts, honoring `\|` escapes. */
export function splitTableRow(text: string): string[] {
  let s = text.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

function parseAligns(text: string): TableAlign[] {
  return splitTableRow(text).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  });
}

function parseTable(headerText: string, delimText: string, bodyLines: string[]): ParsedTable {
  const aligns = parseAligns(delimText);
  const header = splitTableRow(headerText);
  return {
    header,
    aligns,
    // pulldown pads short rows with empty cells up to the header's column
    // count — mirror that so the widget's `<td>` layout matches the reader.
    rows: bodyLines.map((l) => {
      const cells = splitTableRow(l);
      while (cells.length < header.length) cells.push("");
      return cells;
    }),
  };
}

/** Display-math source of a Paragraph's text, or null when the paragraph is
 * not a `$$…$$` block. Same rules as the reading renderer's: the paragraph
 * must start with `$$` and close within itself (pulldown never pairs `$$`
 * across a blank line, so neither do we). Line-based like the original
 * scanner: the single-line form must be single-line. */
export function extractDisplayMath(text: string): string | null {
  const lines = text.split("\n");
  const open = /^\s{0,3}\$\$/.exec(lines[0]);
  if (!open) return null;
  const rest = lines[0].slice(open[0].length);
  // Single-line `$$…$$`.
  if (rest.trimEnd().endsWith("$$") && rest.trim().length >= 2) {
    return rest.trimEnd().slice(0, -2);
  }
  // Multi-line: first line contributes its remainder, each continuation line
  // until the closing `$$` contributes whole.
  const parts: string[] = [];
  if (rest.trim()) parts.push(rest);
  for (let i = 1; i < lines.length; i++) {
    const idx = lines[i].trimEnd().lastIndexOf("$$");
    if (idx >= 0) {
      const head = lines[i].slice(0, idx);
      if (head.trim()) parts.push(head);
      return parts.join("\n");
    }
    parts.push(lines[i]);
  }
  return null;
}

const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})/;

/** Classify one top-level syntax node into a widget-rendered block, or null
 * when the node stays raw (unknown kinds, reference definitions, and — past
 * the size guard — prose/code/hr). */
function classify(node: MdNode, doc: Text, full: boolean): LiveBlock | null {
  const name = node.name;
  if (name === "FencedCode") {
    const openLine = doc.lineAt(node.from);
    const open = FENCE_OPEN.exec(openLine.text);
    const info = open ? openLine.text.slice(open[0].length).trim() : "";
    if (info === "mermaid") {
      const closeLine = doc.lineAt(node.to);
      // Empty fences (` ```mermaid ` followed directly by the close) have
      // one line; there is no body to slice.
      const source =
        closeLine.number > openLine.number
          ? doc.sliceString(openLine.to + 1, closeLine.from)
          : "";
      return { kind: "mermaid", from: node.from, to: node.to, source };
    }
    return full
      ? { kind: "code", from: node.from, to: node.to, text: doc.sliceString(node.from, node.to) }
      : null;
  }
  if (name === "Table") {
    const first = doc.lineAt(node.from).number;
    const last = doc.lineAt(node.to).number;
    const lines: string[] = [];
    for (let n = first; n <= last; n++) lines.push(doc.line(n).text);
    return {
      kind: "table",
      from: node.from,
      to: node.to,
      table: parseTable(lines[0], lines[1], lines.slice(2)),
    };
  }
  if (name === "HorizontalRule") {
    return full ? { kind: "hr", from: node.from, to: node.to } : null;
  }
  if (name === "Paragraph") {
    const text = doc.sliceString(node.from, node.to);
    const tex = extractDisplayMath(text);
    if (tex != null) return { kind: "math", from: node.from, to: node.to, tex };
  }
  if (full && PROSE_NODES.has(name)) {
    return { kind: "prose", from: node.from, to: node.to, text: doc.sliceString(node.from, node.to) };
  }
  return null;
}

/** Walk the lezer tree's top-level children (frontmatter excluded) and build
 * the widget-rendered block list. Children are disjoint and in document
 * order; gaps (blank lines between blocks) are absorbed into the *preceding*
 * block's range so rendered neighbors leave no editor lines between them,
 * while a cursor on those blank lines still falls inside the preceding
 * block and reveals it. */
export function buildBlocks(state: EditorState): LiveBlock[] {
  const doc = state.doc;
  const fm = frontmatterEnd(doc);
  const full = doc.length <= ALL_BLOCK_LIMIT;
  const blocks: LiveBlock[] = [];
  const top = syntaxTree(state).topNode;
  for (let child = top.firstChild; child; child = child.nextSibling) {
    if (child.from < fm) continue;
    const b = classify(child, doc, full);
    if (b) blocks.push(b);
  }
  for (let i = 0; i < blocks.length; i++) {
    blocks[i].to = i + 1 < blocks.length ? blocks[i + 1].from : doc.length;
  }
  return blocks;
}

/* ------------------------------------------------------------------ */
/* Widgets                                                             */
/* ------------------------------------------------------------------ */

/** The document path fragments render against (asset URL rewriting). Set
 * when livePreview composes its extension stack; the app mounts one editor
 * per file (keyed remount), so a module-level value matches that lifecycle
 * and keeps the StateField a singleton `renderedBlocks` can find. */
let fragmentBase = "";
export function setFragmentBase(path: string): void {
  fragmentBase = path;
}

/** Memoized fragment HTML, keyed by kind+base+source. Scrolling back to a
 * rendered block re-mounts its widget; the cache turns that into a
 * synchronous fill with no IPC round trip and no flicker. LRU-capped. */
const fragmentCache = new Map<string, string>();
const FRAGMENT_CACHE_MAX = 400;

function cachedFragmentHtml(key: string): string | null {
  const hit = fragmentCache.get(key);
  if (hit === undefined) return null;
  // Refresh for LRU order.
  fragmentCache.delete(key);
  fragmentCache.set(key, hit);
  return hit;
}

function storeFragmentHtml(key: string, html: string): void {
  fragmentCache.delete(key);
  fragmentCache.set(key, html);
  if (fragmentCache.size > FRAGMENT_CACHE_MAX) {
    const oldest = fragmentCache.keys().next().value;
    if (oldest !== undefined) fragmentCache.delete(oldest);
  }
}

function isDarkScheme(): boolean {
  return document.documentElement.dataset.scheme === "dark";
}

/** Shared click behavior: mousedown on a rendered block reveals its Markdown
 * by moving the cursor into the block (the field then drops the widget). */
function revealOnClick(el: HTMLElement, view: EditorView, pos: number) {
  el.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    view.focus();
  });
}

/** Reading-view HTML for one markdown fragment. Nested mermaid fences come
 * out of Rust as marked `pre > code.language-mermaid` (the reading view
 * renders them the same way) — finish the job here so quotes/lists holding
 * diagrams look right. */
async function fragmentHtml(text: string): Promise<string> {
  const html = await api.renderFragment(text, fragmentBase);
  return html;
}

export class FragmentWidget extends CmWidgetType {
  constructor(
    readonly kind: "prose" | "code",
    readonly text: string,
    readonly pos: number,
  ) {
    super();
  }
  override eq(other: FragmentWidget) {
    return other.kind === this.kind && other.text === this.text;
  }
  override toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    // Reuse the reading view's content styles wholesale (the .rk-live
    // .md-body reset strips the reader's scroll-container chrome).
    wrap.className = "md-body rk-render-block";
    const key = `${this.kind}\x00${fragmentBase}\x00${this.text}`;
    const cached = cachedFragmentHtml(key);
    if (cached !== null) {
      wrap.innerHTML = cached;
      revealOnClick(wrap, view, this.pos);
      return wrap;
    }
    fragmentHtml(this.text)
      .then((html) => {
        storeFragmentHtml(key, html);
        if (!wrap.isConnected) return;
        wrap.innerHTML = html;
        void renderMermaidBlocks(wrap, isDarkScheme());
        // Images without intrinsic size shift layout on load; re-measure so
        // CM's scroll geometry follows.
        wrap.querySelectorAll("img").forEach((img) => {
          if (!img.complete) {
            img.addEventListener("load", () => view.requestMeasure(), { once: true });
          }
        });
        view.requestMeasure();
      })
      .catch(() => {
        if (!wrap.isConnected) return;
        wrap.classList.add("rk-fragment-raw");
        wrap.textContent = this.text;
      });
    revealOnClick(wrap, view, this.pos);
    return wrap;
  }
}

export class HrWidget extends CmWidgetType {
  constructor(readonly pos: number) {
    super();
  }
  override eq(other: HrWidget) {
    return other.pos === this.pos;
  }
  override toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "md-body rk-render-block rk-render-hr";
    wrap.innerHTML = "<hr>";
    revealOnClick(wrap, view, this.pos);
    return wrap;
  }
}

/** Minimal inline-Markdown → HTML for table cells and math fallbacks. The
 * reading renderer stays authoritative; this only needs to make common cell
 * content (`code`, bold, italic, strike, links) look the same. */
export function renderInlineMarkdown(src: string): string {
  const escaped = src
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  const codes: string[] = [];
  const withCode = escaped.replace(/`([^`]+)`/g, (_m, body: string) => {
    codes.push(body);
    return `\x00${codes.length - 1}\x00`;
  });

  const html = withCode
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt: string, url: string) =>
      alt ? `${alt}（${url}）` : url,
    )
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) =>
      `<a href="${url}">${label}</a>`,
    )
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/\x00(\d+)\x00/g, (_m, i: string) => `<code>${codes[Number(i)]}</code>`);

  return html;
}

function cellHtml(cell: string, align: TableAlign, tag: "th" | "td"): string {
  const style = align === "center" || align === "right" ? ` style="text-align: ${align}"` : "";
  return `<${tag}${style}>${renderInlineMarkdown(cell)}</${tag}>`;
}

export function tableHtml(table: ParsedTable): string {
  const head = table.header
    .map((c, i) => cellHtml(c, table.aligns[i] ?? "left", "th"))
    .join("");
  const body = table.rows
    .map(
      (row) =>
        `<tr>${row
          .map((c, i) => cellHtml(c, table.aligns[i] ?? "left", "td"))
          .join("")}</tr>`,
    )
    .join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

export class TableWidget extends CmWidgetType {
  constructor(
    readonly table: ParsedTable,
    readonly pos: number,
  ) {
    super();
  }
  override eq(other: TableWidget) {
    return (
      this.pos === other.pos &&
      this.table.aligns.join() === other.table.aligns.join() &&
      this.table.header.join("\x1f") === other.table.header.join("\x1f") &&
      this.table.rows.map((r) => r.join("\x1f")).join("\n") ===
        other.table.rows.map((r) => r.join("\x1f")).join("\n")
    );
  }
  override toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    // Reuse the reading view's table/inline styles wholesale.
    wrap.className = "md-body rk-render-table";
    wrap.innerHTML = tableHtml(this.table);
    revealOnClick(wrap, view, this.pos);
    return wrap;
  }
}

export class MathWidget extends CmWidgetType {
  constructor(readonly tex: string, readonly pos: number) {
    super();
  }
  override eq(other: MathWidget) {
    return other.tex === this.tex;
  }
  override toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "md-body rk-render-math";
    api.renderMath(this.tex, true).then((html) => {
      if (wrap.isConnected) {
        wrap.innerHTML = html;
        view.requestMeasure();
      }
    }).catch(() => {
      if (wrap.isConnected) {
        wrap.classList.add("math-raw");
        wrap.textContent = this.tex;
      }
    });
    revealOnClick(wrap, view, this.pos);
    return wrap;
  }
}

export class MermaidWidget extends CmWidgetType {
  constructor(readonly source: string, readonly dark: boolean, readonly pos: number) {
    super();
  }
  override eq(other: MermaidWidget) {
    return other.source === this.source && other.dark === this.dark;
  }
  override toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "mermaid-block rk-render-mermaid";
    mermaidSvg(this.source, this.dark)
      .then((svg) => {
        if (wrap.isConnected) {
          wrap.innerHTML = svg;
          view.requestMeasure();
        }
      })
      .catch((err) => {
        if (!wrap.isConnected) return;
        const box = document.createElement("pre");
        box.className = "mermaid-error";
        box.textContent = "Mermaid 渲染失败: " + String(err);
        wrap.appendChild(box);
      });
    revealOnClick(wrap, view, this.pos);
    return wrap;
  }
}

function widgetFor(b: LiveBlock): CmWidgetType {
  switch (b.kind) {
    case "table":
      return new TableWidget(b.table, b.from);
    case "math":
      return new MathWidget(b.tex, b.from);
    case "mermaid":
      return new MermaidWidget(b.source, isDarkScheme(), b.from);
    case "code":
    case "prose":
      return new FragmentWidget(b.kind, b.text, b.from);
    case "hr":
      return new HrWidget(b.from);
  }
}

/* ------------------------------------------------------------------ */
/* StateField                                                          */
/* ------------------------------------------------------------------ */

function selectionIntersects(state: EditorState, b: LiveBlock): boolean {
  // `to` covers the trailing newline (and any following blank lines), so a
  // cursor sitting exactly at `to` is on a line below the block — outside
  // it. A block ending at the last character of the document has no newline
  // to cover; there `to` is the end of its last row and still counts as
  // inside.
  const endInside =
    b.to === state.doc.length && state.doc.sliceString(b.to - 1, b.to) !== "\n";
  return state.selection.ranges.some(
    (r) => (endInside ? r.from <= b.to : r.from < b.to) && r.to >= b.from,
  );
}

function buildBlockDecorations(blocks: LiveBlock[], state: EditorState): DecorationSet {
  const ranges: ReturnType<Decoration["range"]>[] = [];
  for (const b of blocks) {
    if (selectionIntersects(state, b)) continue;
    ranges.push(
      Decoration.replace({ widget: widgetFor(b), block: true }).range(b.from, b.to),
    );
  }
  return Decoration.set(ranges, true);
}

export const liveBlocksField = StateField.define<{
  blocks: LiveBlock[];
  decorations: DecorationSet;
}>({
  create(state) {
    const blocks = buildBlocks(state);
    return { blocks, decorations: buildBlockDecorations(blocks, state) };
  },
  update(value, tr) {
    const blocks = tr.docChanged ? buildBlocks(tr.state) : value.blocks;
    return { blocks, decorations: buildBlockDecorations(blocks, tr.state) };
  },
  // Deliberately NOT atomic: arrowing into a rendered block moves the cursor
  // inside it, which reveals the source (Typora-style). Atomic ranges would
  // also make a Backspace right after the block delete the whole thing in
  // one keystroke (CM6's deleteBy skips through atomic ranges).
  provide: (field) => EditorView.decorations.from(field, (v) => v.decorations),
});

/** The blocks currently hidden behind widgets (cursor outside). The inline
 * decorator must not emit any decoration inside these ranges — CM6 rejects
 * replace decorations nested inside another replace. */
export function renderedBlocks(state: EditorState): LiveBlock[] {
  const field = state.field(liveBlocksField, false);
  if (!field) return [];
  return field.blocks.filter((b) => !selectionIntersects(state, b));
}
