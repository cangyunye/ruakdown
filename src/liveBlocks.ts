import { type EditorState, StateField, type Text, type Transaction } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType as CmWidgetType,
} from "@codemirror/view";
import { api } from "./ipc";
import { mermaidSvg } from "./mermaid";

/**
 * Block-level rendering for the live view: GFM tables, ```mermaid fences and
 * display-math (`$$…$$`) blocks become real DOM widgets whenever the cursor
 * sits outside them, and fall back to raw Markdown the moment the cursor
 * enters (matching the reading view's authority rule).
 *
 * Why a StateField: CM6 forbids block replace decorations from ViewPlugins
 * ("Block decorations may not be specified via plugins"), so this cannot live
 * in livePreview.ts's plugin. The field keeps a cached block list, maps it
 * through unchanged transactions (plain prose edits pay no rescan cost) and
 * only rescans the document when a change touches structural characters
 * (`|` `` ` `` `~` `$`) or overlaps a known block.
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
  | { kind: "math"; from: number; to: number; tex: string };

/* ------------------------------------------------------------------ */
/* Text scanning                                                       */
/* ------------------------------------------------------------------ */

/** Frontmatter scan cap, kept identical to livePreview.ts's card cap: past
 * it the block is treated as ordinary content. */
const FM_SCAN_LINES = 200;

/** Position where block scanning starts: past the frontmatter closing fence
 * when the document opens with one, else 0. */
function frontmatterEnd(doc: Text): number {
  if (doc.lines < 2 || doc.line(1).text.trimEnd() !== "---") return 0;
  const last = Math.min(doc.lines, FM_SCAN_LINES);
  for (let n = 2; n <= last; n++) {
    const t = doc.line(n).text.trimEnd();
    if (t === "---" || t === "...") return doc.line(n).to;
  }
  return 0;
}

// One dash run per column, columns separated by `|`; outer pipes optional.
// A pipe-less `---` is a thematic break / setext underline, never a table.
const DELIM_ROW = /^\s{0,3}\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

function isDelimRow(text: string): boolean {
  return text.includes("|") && DELIM_ROW.test(text);
}

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
  return {
    header: splitTableRow(headerText),
    aligns,
    rows: bodyLines.map((l) => splitTableRow(l)),
  };
}

const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})/;

function isFenceClose(line: string, mark: string): boolean {
  const t = line.trim();
  return t.length >= mark.length && /^[`~]+$/.test(t) && t[0] === mark[0];
}

function lineEndClamped(doc: Text, line: number): number {
  // Block replace decorations must cover the trailing newline, or an empty
  // line is left behind under the widget.
  return doc.line(line).to + (line < doc.lines ? 1 : 0);
}

/** Scan the whole document for widget-rendered blocks. O(lines); runs on
 * mount and whenever a change touches structural characters. */
export function scanBlocks(doc: Text): LiveBlock[] {
  const blocks: LiveBlock[] = [];
  // Open fence state: the fence mark plus whether its info string is
  // `mermaid` (only mermaid fences get a widget; other fences are styled
  // inline by livePreview.ts but still tracked here so their content can
  // never be misread as table rows).
  let fenceMark: string | null = null;
  let fenceMermaid = false;
  let fenceFrom = 0;

  const startLine = frontmatterEnd(doc) > 0
    ? doc.lineAt(frontmatterEnd(doc)).number + 1
    : 1;

  for (let n = startLine; n <= doc.lines; n++) {
    const l = doc.line(n);
    const text = l.text;

    if (fenceMark) {
      if (isFenceClose(text, fenceMark)) {
        if (fenceMermaid) {
          blocks.push({
            kind: "mermaid",
            from: fenceFrom,
            to: lineEndClamped(doc, n),
            source: doc.sliceString(doc.lineAt(fenceFrom).to + 1, l.from),
          });
        }
        fenceMark = null;
      }
      continue;
    }

    const open = FENCE_OPEN.exec(text);
    if (open) {
      fenceMark = open[1];
      fenceMermaid = text.slice(open[0].length).trim() === "mermaid";
      fenceFrom = l.from;
      continue;
    }

    if (text.includes("|") && n < doc.lines && isDelimRow(doc.line(n + 1).text)) {
      const body: string[] = [];
      let end = n + 1;
      for (let m = n + 2; m <= doc.lines; m++) {
        const row = doc.line(m).text;
        if (!row.trim() || !row.includes("|")) break;
        body.push(row);
        end = m;
      }
      blocks.push({
        kind: "table",
        from: l.from,
        to: lineEndClamped(doc, end),
        table: parseTable(text, doc.line(n + 1).text, body),
      });
      n = end;
      continue;
    }

    const math = /^\s{0,3}\$\$/.exec(text);
    if (math) {
      const rest = text.slice(math[0].length);
      let tex: string | null = null;
      let endNum = n;
      // Single-line `$$…$$`.
      if (rest.trimEnd().endsWith("$$") && rest.trim().length >= 2) {
        tex = rest.trimEnd().slice(0, -2);
      } else {
        // Multi-line: first line contributes its remainder, closing line its
        // prefix before `$$`.
        const parts: string[] = [];
        if (rest.trim()) parts.push(rest);
        let closed = false;
        for (let m = n + 1; m <= doc.lines; m++) {
          const t = doc.line(m).text;
          const idx = t.trimEnd().lastIndexOf("$$");
          if (idx >= 0) {
            const head = t.slice(0, idx);
            if (head.trim()) parts.push(head);
            closed = true;
            endNum = m;
            break;
          }
          parts.push(t);
        }
        if (closed) tex = parts.join("\n");
      }
      if (tex != null) {
        blocks.push({
          kind: "math",
          from: l.from,
          to: lineEndClamped(doc, endNum),
          tex,
        });
        n = endNum;
      }
    }
  }
  return blocks;
}

/* ------------------------------------------------------------------ */
/* Incremental updates                                                 */
/* ------------------------------------------------------------------ */

/** Any of these characters in or next to a change forces a full rescan:
 * they can create/destroy table rows, fences or math blocks. */
const STRUCTURAL = /[|`~$]/;

function changedLinesText(doc: Text, from: number, to: number): string {
  const first = doc.lineAt(from).number;
  const last = doc.lineAt(to).number;
  const start = doc.line(Math.max(1, first - 1)).from;
  const end = doc.line(Math.min(doc.lines, last + 1)).to;
  return doc.sliceString(start, end);
}

function overlapsChange(b: LiveBlock, fromA: number, toA: number): boolean {
  return b.from <= toA && b.to >= fromA;
}

/** True when the transaction may have created, destroyed or moved a block
 * boundary — anything else just shifts positions. */
export function needsRescan(old: LiveBlock[], tr: Transaction): boolean {
  let needed = false;
  tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    if (needed) return;
    if (overlapsChangeLoose(old, fromA, toA)) {
      needed = true;
      return;
    }
    if (STRUCTURAL.test(changedLinesText(tr.startState.doc, fromA, toA))) {
      needed = true;
      return;
    }
    if (STRUCTURAL.test(changedLinesText(tr.state.doc, fromB, toB))) {
      needed = true;
    }
  });
  return needed;
}

function overlapsChangeLoose(old: LiveBlock[], fromA: number, toA: number): boolean {
  return old.some((b) => overlapsChange(b, fromA, toA));
}

function mapBlock(b: LiveBlock, tr: Transaction): LiveBlock | null {
  const from = tr.changes.mapPos(b.from, 1);
  const to = tr.changes.mapPos(b.to, -1);
  if (to <= from) return null;
  return { ...b, from, to } as LiveBlock;
}

export function updateBlocks(old: LiveBlock[], tr: Transaction): LiveBlock[] {
  if (!tr.docChanged) return old;
  if (needsRescan(old, tr)) return scanBlocks(tr.state.doc);
  const mapped: LiveBlock[] = [];
  for (const b of old) {
    const m = mapBlock(b, tr);
    if (m) mapped.push(m);
  }
  return mapped;
}

/* ------------------------------------------------------------------ */
/* Widgets                                                             */
/* ------------------------------------------------------------------ */

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
  }
}

/* ------------------------------------------------------------------ */
/* StateField                                                          */
/* ------------------------------------------------------------------ */

function selectionIntersects(state: EditorState, b: LiveBlock): boolean {
  // `to` covers the trailing newline, so a cursor sitting exactly at `to`
  // is on the next line — outside the block. A block that ends at the last
  // character of the document has no newline to cover; there `to` is the
  // end of its last row and still counts as inside.
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
    const blocks = scanBlocks(state.doc);
    return { blocks, decorations: buildBlockDecorations(blocks, state) };
  },
  update(value, tr) {
    const blocks = updateBlocks(value.blocks, tr);
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
