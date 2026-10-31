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

  const widget = (from: number, to: number, w: WidgetType, block = false) => {
    if (from >= to || opts.composing) return;
    widgets.push({ from, to, deco: Decoration.replace({ widget: w, block }) });
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
            widget(l.from, l.to, new HrWidget(l.from), true);
          }
          return false;
        }
        default:
          return;
      }
    },
  });

  if (fm && !intersects(fm, active)) {
    for (let p = fm.from; p <= fm.to; ) {
      const l = state.doc.lineAt(p);
      line(l.from, "rk-frontmatter");
      p = l.to + 1;
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
  for (let n = 2; n <= doc.lines; n++) {
    const t = doc.line(n).text.trim();
    if (t === "---" || t === "...") return { from: 0, to: doc.line(n).to };
  }
  return null;
}
