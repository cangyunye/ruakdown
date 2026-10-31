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
import { convertFileSrc } from "@tauri-apps/api/core";
import { pathDirname } from "./fileOps";

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
}

export interface LiveDecorations {
  decorations: DecorationSet;
  atomic: DecorationSet;
}

interface Range {
  from: number;
  to: number;
}

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

  const widget = (from: number, to: number, w: WidgetType) => {
    if (from >= to || opts.composing) return;
    widgets.push({ from, to, deco: Decoration.replace({ widget: w }) });
  };

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

  syntaxTree(state).iterate({
    from: opts.from,
    to: opts.to,
    enter: (ref) => {
      const n = ref.node;
      // Frontmatter is not a lezer node; never decorate inside it.
      if (fm && n.from >= fm.from && n.to <= fm.to) return false;
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
        case "Blockquote":
          lines(n.from, n.to, "rk-quote");
          return;
        case "FencedCode":
          lines(n.from, n.to, "rk-code");
          return false;
        case "CodeBlock":
          lines(n.from, n.to, "rk-code");
          return false;
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
          return false;
        }
        case "Image": {
          if (!activeHere) {
            // A replace decoration may not cross a line break; a multi-line
            // image (`![a\nb](x.png)`) stays as raw Markdown.
            if (state.doc.lineAt(n.from).to < n.to) return false;
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

  if (fm && !intersects(fm, active)) {
    lines(fm.from, fm.to, "rk-frontmatter");
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

function frontmatterLines(state: EditorState): Range | null {
  const doc = state.doc;
  if (doc.lines < 2 || doc.line(1).text.trimEnd() !== "---") return null;
  // shortcut: frontmatter over 200 lines is not dimmed; raise the cap if real docs need it
  const last = Math.min(doc.lines, 200);
  for (let n = 2; n <= last; n++) {
    const t = doc.line(n).text.trimEnd();
    if (t === "---" || t === "...") return { from: 0, to: doc.line(n).to };
  }
  return null;
}
