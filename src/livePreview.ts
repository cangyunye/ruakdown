import { type EditorState, type Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { convertFileSrc } from "@tauri-apps/api/core";
import { pathDirname } from "./fileOps";
import { liveBlocksField, renderedBlocks } from "./liveBlocks";

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
  "CodeBlock",
]);

export interface LiveDecorationsOptions {
  from: number;
  to: number;
  composing: boolean;
  docPath: string;
  /** Ranges currently hidden behind block widgets (liveBlocks.ts); the
   * inline decorator must not touch them — CM6 rejects replace decorations
   * nested inside another replace. */
  skip?: { from: number; to: number }[];
}

export interface LiveDecorations {
  decorations: DecorationSet;
  atomic: DecorationSet;
}

interface Range {
  from: number;
  to: number;
}

/** GFM alert tag text (brackets included); parsed by lezer as a Link node. */
const ALERT_TAG = /^\[!(note|tip|important|warning|caution)\]$/i;

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

export class TaskWidget extends WidgetType {
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
    box.tabIndex = 0;
    box.setAttribute("aria-label", "切换任务完成");
    box.addEventListener("click", (e) => {
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

export class ImageWidget extends WidgetType {
  constructor(
    readonly docPath: string,
    readonly rawSrc: string,
    readonly alt: string,
  ) {
    super();
  }
  eq(other: ImageWidget) {
    return (
      other.docPath === this.docPath &&
      other.rawSrc === this.rawSrc &&
      other.alt === this.alt
    );
  }
  toDOM(view: EditorView) {
    const img = document.createElement("img");
    img.className = "rk-image";
    img.alt = this.alt;
    img.draggable = false;
    const path = resolveImagePath(this.docPath, this.rawSrc);
    try {
      img.src = path ? convertFileSrc(path) : this.rawSrc;
    } catch {
      img.src = this.rawSrc;
    }
    img.addEventListener("load", () => view.requestMeasure());
    img.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const pos = view.posAtDOM(img);
      view.dispatch({ selection: { anchor: pos } });
      view.focus();
    });
    return img;
  }
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
  let from = state.doc.length;
  let to = 0;
  for (const sel of state.selection.ranges) {
    const a = revealRange(state, sel.from);
    const b = revealRange(state, sel.to);
    from = Math.min(from, a.from, b.from);
    to = Math.max(to, a.to, b.to);
  }
  return { from, to };
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
  const widgets: { from: number; to: number; deco: Decoration }[] = [];
  const lineClasses = new Map<number, string[]>();

  // CM6 forbids plugin replaces that cross a line break, so leave any such
  // span as raw Markdown instead of throwing at render time.
  const crossesLine = (from: number, to: number) =>
    state.doc.lineAt(from).to < to;

  const widget = (from: number, to: number, w: WidgetType) => {
    if (from >= to || opts.composing) return;
    if (crossesLine(from, to)) return;
    widgets.push({ from, to, deco: Decoration.replace({ widget: w }) });
  };

  const hide = (from: number, to: number) => {
    if (from >= to || opts.composing) return;
    if (crossesLine(from, to)) return;
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
  // Line classes for a block, clamped to the visible range so a block that
  // starts above the viewport does not walk its off-screen lines.
  const lines = (from: number, to: number, cls: string) => {
    const end = Math.min(to, opts.to);
    for (let p = Math.max(from, opts.from); p <= end; ) {
      const l = state.doc.lineAt(p);
      line(l.from, cls);
      p = l.to + 1;
    }
  };

  const paired = (
    marks_: { from: number; to: number }[],
    activeHere: boolean,
    cls: string,
  ) => {
    if (marks_.length < 2) return;
    if (!activeHere) {
      hide(marks_[0].from, marks_[0].to);
      hide(marks_[marks_.length - 1].from, marks_[marks_.length - 1].to);
    }
    mark(marks_[0].to, marks_[marks_.length - 1].from, cls);
  };

  const fm = frontmatterLines(state);
  const skip = opts.skip ?? [];
  // Nodes inside a widget-rendered block must not receive any decoration.
  const skipped = (from: number, to: number) =>
    skip.some((s) => from < s.to && to > s.from);

  syntaxTree(state).iterate({
    from: opts.from,
    to: opts.to,
    enter: (ref) => {
      const n = ref.node;
      // The Document root spans everything and must keep descending, or a
      // single skipped range would blank out the whole tree.
      if (n.name !== "Document" && skipped(n.from, n.to)) return false;
      // Frontmatter is not a lezer node; skip syntax-tree decoration for any
      // node that overlaps it (the card styling is added separately below).
      // The Document root itself must still descend, or every decoration in
      // the file would be skipped whenever frontmatter exists.
      if (fm && n.name !== "Document" && intersects({ from: n.from, to: n.to }, fm)) {
        return false;
      }
      const activeHere = intersects({ from: n.from, to: n.to }, active);

      switch (n.name) {
        case "HeaderMark":
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
        // Inline emphasis-ish nodes descend so nesting (**a *b* c**) is
        // decorated too; the marker nodes are handled here, not standalone.
        case "StrongEmphasis":
        case "Emphasis":
          paired(
            n.getChildren("EmphasisMark"),
            activeHere,
            n.name === "StrongEmphasis" ? "rk-strong" : "rk-em",
          );
          return;
        case "Strikethrough":
          paired(n.getChildren("StrikethroughMark"), activeHere, "rk-strike");
          return;
        case "Link": {
          // A GFM alert tag (`[!NOTE]`) parses as a link; the Blockquote
          // case owns it, so leave it alone here.
          if (ALERT_TAG.test(state.doc.sliceString(n.from, n.to))) return false;
          const lm = n.getChildren("LinkMark");
          if (lm.length >= 2) {
            if (!activeHere) {
              for (const m of lm) hide(m.from, m.to);
              const url = n.getChild("URL");
              if (url) hide(url.from, url.to);
              const label = n.getChild("LinkLabel");
              if (label) hide(label.from, label.to);
              const title = n.getChild("LinkTitle");
              if (title) hide(title.from, title.to);
            }
            mark(lm[0].to, lm[1].from, "rk-link");
          }
          return;
        }
        case "ATXHeading1":
        case "ATXHeading2":
        case "ATXHeading3":
        case "ATXHeading4":
        case "ATXHeading5":
        case "ATXHeading6":
        case "SetextHeading1":
        case "SetextHeading2":
          line(state.doc.lineAt(n.from).from, `rk-h${n.name.slice(-1)}`);
          return;
        case "Blockquote": {
          lines(n.from, n.to, "rk-quote");
          const first = state.doc.lineAt(n.from);
          line(first.from, "rk-quote-first");
          line(
            state.doc.lineAt(n.to > n.from ? n.to - 1 : n.to).from,
            "rk-quote-last",
          );
          // GFM alert (`> [!NOTE]`): color the quote and label it like the
          // reading view; the raw tag text hides while the block is inactive.
          const alert =
            /^\s{0,3}(?:>\s?)+\[!(note|tip|important|warning|caution)\][^\n]*/i.exec(
              first.text,
            );
          if (alert) {
            const kind = alert[1].toLowerCase();
            lines(n.from, n.to, `rk-alert rk-alert-${kind}`);
            line(first.from, "rk-alert-title");
            if (!activeHere) {
              const tagFrom = first.from + alert[0].indexOf("[!");
              hide(tagFrom, first.from + alert[0].length);
            }
          }
          return;
        }
        case "FencedCode": {
          lines(n.from, n.to, "rk-code");
          line(n.from, "rk-code-first");
          line(
            state.doc.lineAt(n.to > n.from ? n.to - 1 : n.to).from,
            "rk-code-last",
          );
          if (!activeHere) {
            // The opening fence line (with its info string) and the closing
            // fence collapse to padding-height, leaving a styled code block;
            // the cursor entering the block brings the raw fences back.
            for (const mark of n.getChildren("CodeMark")) {
              const l = state.doc.lineAt(mark.from);
              hide(l.from, l.to);
              line(l.from, "rk-code-fence");
            }
          }
          return false;
        }
        case "CodeBlock": {
          lines(n.from, n.to, "rk-code");
          line(n.from, "rk-code-first");
          line(
            state.doc.lineAt(n.to > n.from ? n.to - 1 : n.to).from,
            "rk-code-last",
          );
          return false;
        }
        // Spacing-only line classes so block gaps match the reading view's
        // margins; these nodes must keep descending (inline marks live
        // inside them), so no early `return false`.
        case "Paragraph":
          if (n.parent?.name === "Document") {
            line(n.from, "rk-p-first");
            line(
              state.doc.lineAt(n.to > n.from ? n.to - 1 : n.to).from,
              "rk-p-last",
            );
          }
          return;
        case "ListItem":
          line(n.from, "rk-li-first");
          line(
            state.doc.lineAt(n.to > n.from ? n.to - 1 : n.to).from,
            "rk-li-last",
          );
          return;
        case "BulletList":
        case "OrderedList":
          if (n.parent?.name === "Document") {
            line(n.from, "rk-list-first");
            line(
              state.doc.lineAt(n.to > n.from ? n.to - 1 : n.to).from,
              "rk-list-last",
            );
          }
          return;
        case "ListMark": {
          if (!activeHere && n.parent?.parent?.name === "BulletList") {
            const task = n.parent?.getChild("Task");
            if (task) {
              // Hide the dash and its trailing space, leaving the checkbox.
              hide(n.from, task.from);
            } else {
              widget(n.from, n.to, new BulletWidget());
            }
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
          // lezer tags the whole Task as `list`, which the editor's prose
          // highlight paints in the accent color; the reading view shows
          // task text in the normal text color.
          const task = n.parent;
          if (task && task.to > n.to) mark(n.to, task.to, "rk-task-text");
          return false;
        }
        case "Image": {
          if (!activeHere) {
            const marks = n.getChildren("LinkMark");
            const alt =
              marks.length >= 2
                ? state.doc.sliceString(marks[0].to, marks[1].from)
                : "";
            const url = n.getChild("URL");
            const rawSrc = url ? state.doc.sliceString(url.from, url.to) : "";
            // Reference-style images have no URL; keep their Markdown visible.
            if (!url || !rawSrc) return false;
            widget(
              n.from,
              n.to,
              new ImageWidget(opts.docPath, rawSrc, alt),
            );
          }
          return false;
        }
        case "HorizontalRule": {
          if (!activeHere && n.parent?.name === "Document") {
            const l = state.doc.lineAt(n.from);
            // CM forbids block decorations from ViewPlugins; draw the rule as a line border instead.
            hide(l.from, l.to);
            line(l.from, "rk-hr-line");
          }
          return false;
        }
        default:
          return;
      }
    },
  });

  // The card yields to raw text only while a selection actually sits inside
  // the block. Selection ranges are checked directly, not through the
  // reveal-expanded `active` union: an empty range at the document start —
  // where every freshly opened file's cursor rests — touches nothing, so the
  // card renders on first open instead of staying raw until the cursor moves.
  // Any collapsed cursor beyond position 0 (or a selection crossing into the
  // block) still intersects and reveals the raw YAML for editing.
  const fmEditing =
    fm && state.selection.ranges.some((r) => intersects(fm, r));
  if (
    fm &&
    !fmEditing &&
    intersects(fm, { from: opts.from, to: opts.to })
  ) {
    const first = state.doc.lineAt(fm.from);
    const last = state.doc.lineAt(Math.max(fm.from, fm.to - 1));
    // Hide the fences and collapse their line boxes; the metadata lines get
    // a card-like background plus key/value marks (the reading view renders
    // the same block as a property card).
    hide(first.from, first.to);
    hide(last.from, last.to);
    line(first.from, "rk-fm-delim");
    line(last.from, "rk-fm-delim");
    for (let num = first.number + 1; num < last.number; num++) {
      const l = state.doc.line(num);
      const classes = ["rk-fm-line"];
      if (num === first.number + 1) classes.push("rk-fm-first");
      if (num === last.number - 1) classes.push("rk-fm-last");
      line(l.from, classes.join(" "));
      const m = /^(\s*)([A-Za-z0-9_-]+)(\s*:)(.*)$/.exec(l.text);
      if (!m) continue;
      const keyFrom = l.from + m[1].length;
      const key = m[2].toLowerCase();
      const valueStart = keyFrom + m[2].length + m[3].length;
      mark(keyFrom, keyFrom + m[2].length, "rk-fm-key");
      // The reading card hides the colon; keep the column width but drop it.
      mark(keyFrom + m[2].length, valueStart, "rk-fm-colon");
      const raw = m[4];
      if (key === "keywords" || key === "tags" || key === "categories") {
        const items = [...raw.matchAll(/[^,，、\[\]]+/g)]
          .map((hit) => {
            const text = hit[0];
            const lead = text.length - text.trimStart().length;
            const from = valueStart + (hit.index ?? 0) + lead;
            return { from, to: from + text.trim().length };
          })
          .filter((item) => item.to > item.from);
        if (items.length === 0) {
          hide(valueStart, l.to);
        } else {
          // Hide everything between the chips (spaces, brackets, separators)
          // so only the themed pills remain.
          let cursor = valueStart;
          for (const item of items) {
            if (item.from > cursor) hide(cursor, item.from);
            cursor = item.to;
          }
          if (l.to > cursor) hide(cursor, l.to);
          items.forEach((item, index) =>
            mark(item.from, item.to, `fm-chip chip-${index % 8} rk-fm-chip`),
          );
        }
      } else if (raw.trim() && raw.trim() !== "[]") {
        const valueFrom = valueStart + (raw.length - raw.trimStart().length);
        if (valueFrom > valueStart) hide(valueStart, valueFrom);
        let cls = "rk-fm-val";
        if (key === "description") cls += " rk-fm-desc";
        if (key === "name" || key === "author" || key === "version") {
          cls += " rk-fm-strong";
        }
        if (key === "title") cls += " rk-fm-title";
        mark(valueFrom, l.to, cls);
      } else if (raw.trim() === "[]") {
        hide(valueStart, l.to);
      }
    }
  }

  const ranges = [
    ...hides.map((h) => Decoration.replace({}).range(h.from, h.to)),
    ...widgets.map((w) => w.deco.range(w.from, w.to)),
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

const ABSOLUTE_SRC = /^(?:https?:|data:|#|asset:)/i;

/** The live view's complete highlight style. SourceEditor swaps its base
 * prose highlight out for this one in live mode (same compartment), because
 * CM mounts style modules so that the *earlier* extension's rules win on
 * equal specificity — a later `inherit` could never override the base.
 *
 * Prose tags mirror SourceEditor's base style minus `heading`: in the live
 * view the `rk-h*` line classes own heading color and weight. An inner span
 * painted `--heading` would also tint frontmatter, whose closing `---`
 * makes lezer parse the metadata as a Setext heading, on every theme whose
 * heading color differs from the text color.
 *
 * Code tokens key to the same `--syn-*` palette the Rust highlighter feeds,
 * so a highlighted fence matches its reading-view rendering. */
export const liveHighlight = HighlightStyle.define([
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "var(--link)" },
  { tag: t.url, color: "var(--muted)" },
  { tag: t.monospace, color: "var(--code-text)" },
  { tag: t.quote, color: "var(--quote-text)" },
  { tag: t.list, color: "var(--accent)" },
  { tag: t.processingInstruction, color: "var(--accent)" },
  { tag: t.keyword, color: "var(--syn-keyword)" },
  { tag: t.string, color: "var(--syn-string)" },
  { tag: t.comment, color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: t.number, color: "var(--syn-number)" },
  { tag: [t.bool, t.null], color: "var(--syn-const)" },
  { tag: [t.typeName, t.className], color: "var(--syn-type)" },
  {
    tag: [t.function(t.variableName), t.function(t.propertyName)],
    color: "var(--syn-function)",
  },
  { tag: t.tagName, color: "var(--syn-tag)" },
  { tag: t.attributeName, color: "var(--syn-attr)" },
]);

/** Resolve a Markdown image src to an absolute local path, following the same
 * shape as core/markdown.rs::resolve_img_path but clamping `..` at the root.
 * Returns null for remote/data/anchor references and when the document has no
 * directory. */
export function resolveImagePath(docPath: string, rawSrc: string): string | null {
  if (!docPath) return null;
  let decoded = rawSrc.trim();
  if (!decoded) return null;
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    /* keep the raw text; malformed escapes stay literal */
  }
  if (ABSOLUTE_SRC.test(decoded)) return null;
  let dir = pathDirname(docPath).replace(/\\/g, "/");
  if (!dir) {
    if (!docPath.startsWith("/")) return null;
    dir = "/";
  }
  const rel = decoded.replace(/\\/g, "/").replace(/^\/+/, "");
  return normalizePath(dir.endsWith("/") ? `${dir}${rel}` : `${dir}/${rel}`);
}

/** Lexical `.` / `..` resolution; never touches the filesystem. */
function normalizePath(p: string): string {
  const drive = /^[A-Za-z]:/.exec(p)?.[0] ?? "";
  const rest = p.slice(drive.length);
  const unc = !drive && rest.startsWith("//");
  const abs = !unc && rest.startsWith("/");
  const out: string[] = [];
  for (const seg of rest.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!abs && !drive && !unc) out.push("..");
    } else {
      out.push(seg);
    }
  }
  const prefix = drive
    ? drive + (abs ? "/" : "")
    : unc
      ? "//"
      : abs
        ? "/"
        : "";
  return prefix + out.join("/");
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
      composing: boolean;
      tree: ReturnType<typeof syntaxTree>;

      constructor(view: EditorView) {
        this.composing = view.composing;
        this.tree = syntaxTree(view.state);
        const built = build(view, docPath);
        this.decorations = built.decorations;
        this.atomic = built.atomic;
      }

      update(update: ViewUpdate) {
        const tree = syntaxTree(update.state);
        if (
          update.docChanged ||
          update.selectionSet ||
          update.viewportChanged ||
          update.view.composing !== this.composing ||
          tree !== this.tree
        ) {
          this.composing = update.view.composing;
          this.tree = tree;
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
    // Block widgets (tables / mermaid / display math) come from this
    // StateField; the inline plugin above skips their ranges.
    liveBlocksField,
    syntaxHighlighting(liveHighlight),
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
    skip: renderedBlocks(view.state),
  });
}

function frontmatterLines(state: EditorState): Range | null {
  const doc = state.doc;
  if (doc.lines < 2 || doc.line(1).text.trimEnd() !== "---") return null;
  // shortcut: frontmatter over 200 lines is not card-formatted; raise the cap if real docs need it
  const last = Math.min(doc.lines, 200);
  for (let n = 2; n <= last; n++) {
    const t = doc.line(n).text.trimEnd();
    if (t === "---" || t === "...") return { from: 0, to: doc.line(n).to };
  }
  return null;
}
