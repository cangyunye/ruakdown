import { type EditorState, type Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
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
