import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { HighlightStyle, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { tags as t } from "@lezer/highlight";
import { linkAtLine } from "../links";
import { createSourceSearch, searchStateField, type SourceSearch } from "../sourceSearch";

/** Imperative access for the split view's scroll sync. */
export interface SourceEditorHandle {
  /** 1-based line at (or nearest below) the viewport top. */
  getTopLine: () => number;
  /** Scroll the given 1-based line to (near) the viewport top. */
  scrollToLine: (line: number) => void;
}

interface Props {
  /** Document text at mount (component is remounted per file via key). */
  initialText: string;
  /** Latest saved/external text; applied only when it differs from our edits. */
  text: string;
  onChange: (text: string) => void;
  onSave: () => void;
  /** Scroll events from the editor viewport (raw, passive). */
  onScroll?: () => void;
  /** Ctrl/Cmd+clicked a [text](url) span in the source. */
  onOpenLink?: (href: string) => void;
  /** Fires with the live EditorView once it is created (search panel). */
  onViewReady?: (search: SourceSearch) => void;
  /** Fires just before the view is destroyed so the parent can drop its ref. */
  onViewDestroy?: () => void;
}

const highlightStyle = HighlightStyle.define([
  { tag: t.heading, color: "var(--heading)", fontWeight: "700" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "var(--link)" },
  { tag: t.url, color: "var(--muted)" },
  { tag: t.monospace, color: "var(--code-text)" },
  { tag: t.quote, color: "var(--quote-text)" },
  { tag: t.list, color: "var(--accent)" },
  { tag: t.processingInstruction, color: "var(--accent)" },
]);

const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--text)",
    backgroundColor: "transparent",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-scroller": {
    fontFamily: "'Cascadia Code', Consolas, 'Courier New', monospace",
    fontSize: "13.5px",
    lineHeight: 1.75,
    // Vertical padding lives on .cm-content so the background-image card
    // (index.css) wraps it instead of leaving bare margins at top/bottom.
    padding: "0 8px",
  },
  ".cm-content": {
    caretColor: "var(--accent)",
    maxWidth: "860px",
    margin: "0 auto",
    padding: "24px 0 60vh",
  },
  ".cm-line": {
    padding: "0 14px",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--accent)",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "var(--accent-soft) !important",
  },
  ".cm-activeLine": {
    backgroundColor: "transparent",
  },
  ".cm-gutters": {
    display: "none",
  },
});

const SourceEditor = forwardRef<SourceEditorHandle, Props>(function SourceEditor(
  { initialText, text, onChange, onSave, onScroll, onOpenLink, onViewReady, onViewDestroy },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const lastPushedRef = useRef(initialText);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onScrollRef = useRef(onScroll);
  onScrollRef.current = onScroll;
  const onOpenLinkRef = useRef(onOpenLink);
  onOpenLinkRef.current = onOpenLink;
  const onViewReadyRef = useRef(onViewReady);
  onViewReadyRef.current = onViewReady;
  const onViewDestroyRef = useRef(onViewDestroy);
  onViewDestroyRef.current = onViewDestroy;

  useImperativeHandle(ref, () => ({
    getTopLine: () => {
      const view = viewRef.current;
      if (!view) return 1;
      // Sample just inside the top of the scroller; precise=false snaps to
      // the nearest line when the point lands in padding.
      const rect = view.scrollDOM.getBoundingClientRect();
      const pos = view.posAtCoords(
        { x: rect.left + Math.min(200, rect.width / 2), y: rect.top + 8 },
        false,
      );
      if (pos == null) return 1;
      return view.state.doc.lineAt(pos).number;
    },
    scrollToLine: (line: number) => {
      const view = viewRef.current;
      if (!view || view.state.doc.lines === 0) return;
      const clamped = Math.min(Math.max(1, line), view.state.doc.lines);
      const l = view.state.doc.line(clamped);
      view.dispatch({
        effects: EditorView.scrollIntoView(l.from, { y: "start", yMargin: 8 }),
      });
    },
  }));

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const view = new EditorView({
      parent: container,
      state: EditorState.create({
        doc: initialText,
        extensions: [
          history(),
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                onSaveRef.current();
                return true;
              },
            },
          ]),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          searchStateField,
          indentUnit.of("    "),
          markdown(),
          EditorView.lineWrapping,
          EditorView.domEventHandlers({
            mousedown(event, view) {
              const cb = onOpenLinkRef.current;
              if (!cb || event.button !== 0 || !(event.metaKey || event.ctrlKey)) {
                return false;
              }
              const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
              if (pos == null) return false;
              const line = view.state.doc.lineAt(pos);
              const href = linkAtLine(line.text, pos - line.from);
              if (!href) return false;
              event.preventDefault();
              cb(href);
              return true;
            },
          }),
          syntaxHighlighting(highlightStyle),
          editorTheme,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              const value = update.state.doc.toString();
              lastPushedRef.current = value;
              onChangeRef.current(value);
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    const handleScroll = () => onScrollRef.current?.();
    view.scrollDOM.addEventListener("scroll", handleScroll, { passive: true });
    onViewReadyRef.current?.(createSourceSearch(view));
    return () => {
      view.scrollDOM.removeEventListener("scroll", handleScroll);
      view.destroy();
      viewRef.current = null;
      onViewDestroyRef.current?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply external reloads (file watcher / save echo) but never clobber typing.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || text === lastPushedRef.current) return;
    const anchor = Math.min(view.state.selection.main.anchor, text.length);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor },
    });
    lastPushedRef.current = text;
  }, [text]);

  return <div ref={containerRef} className="source-editor" />;
});

export default SourceEditor;
