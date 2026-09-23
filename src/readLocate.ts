/**
 * Locate source-search matches inside the rendered reader DOM.
 *
 * The reader renders parsed HTML, so a match found in the markdown source may
 * not appear verbatim there (`**bold**` renders as `bold`, `[x](u)` as `x`).
 * We therefore do a secondary lookup in the rendered text: first the raw match,
 * then a marker-stripped form. Matches we cannot place are skipped — the search
 * itself is always over the source, this only drives the on-screen highlight.
 */

/** Marks we inject for a located match (never for source-authored content). */
const MARK_CLASS = "search-rendered-mark";

/** Cap on wrapped ranges: a vault-sized match list must not stall the reader. */
const MAX_MARKS = 2000;

export interface SourceMatch {
  from: number;
  to: number;
}

/** Strip the inline markers that never survive markdown rendering. */
export function normalizeForRender(s: string): string {
  return s
    .replace(/^[#>\s]+/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .trim();
}

/** Unwrap every mark a previous search injected, restoring the original nodes. */
export function clearRenderedMarks(root: Element | null): void {
  if (!root) return;
  const marks = root.querySelectorAll("mark." + MARK_CLASS);
  if (marks.length === 0) return;
  const parents = new Set<Node>();
  marks.forEach((m) => {
    const parent = m.parentNode;
    if (!parent) return;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    parents.add(parent);
  });
  parents.forEach((p) => (p as Element).normalize?.());
}

interface TextSpan {
  node: Text;
  start: number;
  end: number;
}

/** Concatenate the container's visible text and remember each text node's
 *  offset range, so a plain string index maps back to (node, offset). */
function indexText(root: Element): { text: string; spans: TextSpan[] } {
  const spans: TextSpan[] = [];
  let text = "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const node = n as Text;
    const tag = node.parentElement?.tagName;
    if (tag === "SCRIPT" || tag === "STYLE") continue;
    const value = node.nodeValue ?? "";
    if (!value) continue;
    spans.push({ node, start: text.length, end: text.length + value.length });
    text += value;
  }
  return { text, spans };
}

/** Find the next occurrence of a match's raw or marker-stripped text. */
function locate(
  hay: string,
  raw: string,
  caseSensitive: boolean,
  cursor: number,
): { at: number; len: number } | null {
  const candidates = [raw];
  const stripped = normalizeForRender(raw);
  if (stripped && stripped !== raw) candidates.push(stripped);
  for (const c of candidates) {
    const needle = caseSensitive ? c : c.toLowerCase();
    if (!needle) continue;
    const at = hay.indexOf(needle, cursor);
    if (at !== -1) return { at, len: needle.length };
  }
  return null;
}

function wrap(node: Text, start: number, end: number, current: boolean): void {
  const len = node.nodeValue?.length ?? 0;
  const range = document.createRange();
  range.setStart(node, Math.max(0, Math.min(start, len)));
  range.setEnd(node, Math.max(0, Math.min(end, len)));
  const mark = document.createElement("mark");
  mark.className = current ? MARK_CLASS + " current" : MARK_CLASS;
  try {
    range.surroundContents(mark);
  } catch {
    /* range straddled an element boundary — leave this segment unmarked */
  }
}

/**
 * Highlight `matches` (source offsets) inside the rendered reader.
 * `current` gets the sparkle treatment and is scrolled into view.
 */
export function markRenderedMatches(
  root: Element | null,
  source: string,
  matches: SourceMatch[],
  current: number,
  caseSensitive: boolean,
): void {
  if (!root) return;
  clearRenderedMarks(root);
  if (matches.length === 0) return;

  const { text, spans } = indexText(root);
  const hay = caseSensitive ? text : text.toLowerCase();

  interface Range {
    span: TextSpan;
    start: number;
    end: number;
    current: boolean;
  }
  const ranges: Range[] = [];
  let cursor = 0;
  for (let i = 0; i < matches.length && ranges.length < MAX_MARKS; i++) {
    const m = matches[i];
    const raw = source.slice(m.from, m.to);
    const hit = locate(hay, raw, caseSensitive, cursor);
    if (!hit) continue;
    cursor = hit.at + hit.len;
    const isCurrent = i === current;
    for (const span of spans) {
      if (span.end <= hit.at || span.start >= hit.at + hit.len) continue;
      ranges.push({
        span,
        start: Math.max(hit.at, span.start) - span.start,
        end: Math.min(hit.at + hit.len, span.end) - span.start,
        current: isCurrent,
      });
    }
  }

  const byNode = new Map<Text, Range[]>();
  for (const r of ranges) {
    const list = byNode.get(r.span.node);
    if (list) list.push(r);
    else byNode.set(r.span.node, [r]);
  }
  byNode.forEach((list, node) => {
    list.sort((a, b) => b.start - a.start); // right-to-left keeps offsets valid
    for (const r of list) wrap(node, r.start, r.end, r.current);
  });

  root
    .querySelector("mark." + MARK_CLASS + ".current")
    ?.scrollIntoView({ behavior: "smooth", block: "center" });
}
