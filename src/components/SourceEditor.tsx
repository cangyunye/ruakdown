import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { HighlightStyle, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { tags as t } from "@lezer/highlight";
import { linkAtLine } from "../links";
import { createSourceSearch, searchStateField, type SourceSearch } from "../sourceSearch";
import {
  insertCodeBlock,
  insertLink,
  insertTable,
  slashTrigger,
  togglePrefix,
  toggleWrap,
} from "../editorCommands";

/** Imperative access for the split view's scroll sync and link insertion. */
export interface SourceEditorHandle {
  /** 1-based line at (or nearest below) the viewport top. */
  getTopLine: () => number;
  /** Scroll the given 1-based line to (near) the viewport top. */
  scrollToLine: (line: number) => void;
  /** Replace the selection / insert at the cursor; returns false when the
   * view is gone. Triggers the normal onChange chain. */
  insertAtCursor: (insert: string) => boolean;
  /** Run an editorCommands-style callback against the live view (context
   * menu formatting actions); returns false when the view is gone. The
   * command's dispatch flows through the normal onChange chain, and the
   * editor regains focus afterwards. */
  runCommand: (fn: (view: EditorView) => void) => boolean;
}

/** Payload handed to the paste interceptor. `files` holds files copied to
 * the system clipboard (explorer copies, screenshots); `text` is the plain
 * text flavour, empty for file-only clips. */
export interface PastePayload {
  files: File[];
  text: string;
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
  /** Paste interceptor: return true to claim the paste (native paste is then
   * suppressed; the insert happens asynchronously). Only called for pastes
   * that carry files or carry no text at all — plain text always goes
   * through the native path. */
  onPasteFile?: (payload: PastePayload) => boolean;
  /** Fires with the live EditorView once it is created (search panel). */
  onViewReady?: (search: SourceSearch) => void;
  /** Fires just before the view is destroyed so the parent can drop its ref. */
  onViewDestroy?: () => void;
  /** Keyboard focus entered or left the editor's text area. */
  onFocusChange?: (focused: boolean) => void;
  /** The user typed "/" or "、" at the cursor — open the slash palette
   * anchored at the given viewport coordinates. */
  onSlashTrigger?: (trigger: { pos: number; char: string; x: number; y: number }) => void;
  /** User-driven document input that was NOT a palette trigger (further
   * typing, IME commits, backspace). The parent closes the slash palette. */
  onUserInput?: () => void;
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
  { initialText, text, onChange, onSave, onScroll, onOpenLink, onPasteFile, onViewReady, onViewDestroy, onFocusChange, onSlashTrigger, onUserInput },
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
  const onPasteFileRef = useRef(onPasteFile);
  onPasteFileRef.current = onPasteFile;
  const onFocusChangeRef = useRef(onFocusChange);
  onFocusChangeRef.current = onFocusChange;
  const onSlashTriggerRef = useRef(onSlashTrigger);
  onSlashTriggerRef.current = onSlashTrigger;
  const onUserInputRef = useRef(onUserInput);
  onUserInputRef.current = onUserInput;
  // A trigger typed inside an active IME composition is held here and
  // re-validated when the composition ends (see the compositionend handler).
  const pendingSlashRef = useRef<{ pos: number; char: string } | null>(null);

  /** Keymap chord → editorCommands binding. Returning true claims the chord
   * (prevents the browser default) even when there was nothing to do. */
  const editorKeymap = [
    { key: "Mod-b", run: (v: EditorView) => toggleWrap(v, "**", "**", { placeholder: "粗体" }) },
    { key: "Mod-i", run: (v: EditorView) => toggleWrap(v, "*", "*", { placeholder: "斜体" }) },
    { key: "Mod-u", run: (v: EditorView) => toggleWrap(v, "<u>", "</u>", { placeholder: "下划线" }) },
    { key: "Mod-Shift-s", run: (v: EditorView) => toggleWrap(v, "~~", "~~", { placeholder: "删除线" }) },
    { key: "Alt-d", run: (v: EditorView) => toggleWrap(v, "==", "==", { placeholder: "高亮" }) },
    { key: "Mod-`", run: (v: EditorView) => toggleWrap(v, "`", "`", { placeholder: "代码" }) },
    { key: "Mod-'", run: (v: EditorView) => toggleWrap(v, "<kbd>", "</kbd>", { placeholder: "Ctrl" }) },
    { key: "Mod-m", run: (v: EditorView) => toggleWrap(v, "$", "$", { placeholder: "公式" }) },
    { key: "Mod-k", run: insertLink },
    { key: "Mod-l", run: (v: EditorView) => togglePrefix(v, "task") },
    { key: "Mod-o", run: insertTable },
    { key: "Mod-Shift-k", run: insertCodeBlock },
    ...[1, 2, 3, 4, 5, 6].map((level) => ({
      key: `Mod-alt-${level}`,
      run: (v: EditorView) => togglePrefix(v, level),
    })),
  ];

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
    insertAtCursor: (insert: string) => {
      const view = viewRef.current;
      if (!view) return false;
      const sel = view.state.selection.main;
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert },
        selection: { anchor: sel.from + insert.length },
        scrollIntoView: true,
        userEvent: "input.insert",
      });
      return true;
    },
    runCommand: (fn) => {
      const view = viewRef.current;
      if (!view) return false;
      fn(view);
      view.focus();
      return true;
    },
  }));

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    /** Open the palette at the trigger, anchored under the cursor. */
    const emitSlash = (trig: { pos: number; char: string }) => {
      const view = viewRef.current;
      if (!view) return;
      const coords = view.coordsAtPos(trig.pos);
      if (!coords) return;
      onSlashTriggerRef.current?.({
        pos: trig.pos,
        char: trig.char,
        x: coords.left,
        y: coords.bottom + 2,
      });
    };

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
            ...editorKeymap,
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
            paste(event) {
              const cb = onPasteFileRef.current;
              if (!cb) return false;
              const dt = event.clipboardData;
              const files = Array.from(dt?.files ?? []);
              const text = dt?.getData("text/plain") ?? "";
              // Text pastes stay native; file-only or empty pastes (the
              // app-internal tree clipboard never touches the system
              // clipboard) go through the interceptor, which decides.
              if (text) return false;
              if (!cb({ files, text })) return false;
              event.preventDefault();
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
              // Slash palette: "/" or "、" just typed at the cursor.
              const trig = slashTrigger(update);
              if (trig) {
                if (update.view.composing) {
                  // Opening (and focusing) a menu mid-composition can cancel
                  // the IME's pending commit and duplicate the character —
                  // hold the trigger until the composition ends.
                  pendingSlashRef.current = trig;
                } else {
                  emitSlash(trig);
                }
              } else if (
                update.transactions.some(
                  (tr) => tr.isUserEvent("input.type") || tr.isUserEvent("delete"),
                )
              ) {
                onUserInputRef.current?.();
              }
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    const handleScroll = () => onScrollRef.current?.();
    view.scrollDOM.addEventListener("scroll", handleScroll, { passive: true });
    // Keyboard-focus reporting: focus/blur on the editable content element
    // (they do not bubble, so document-level listeners would miss them).
    const reportFocus = () => onFocusChangeRef.current?.(true);
    const reportBlur = () => onFocusChangeRef.current?.(false);
    view.contentDOM.addEventListener("focus", reportFocus);
    view.contentDOM.addEventListener("blur", reportBlur);
    // Deferred palette trigger: a "/" or "、" committed inside an IME
    // composition opens the palette only once the composition has fully
    // ended — re-validating that the trigger char still sits before the
    // cursor (a different candidate pick changes it).
    const onCompEnd = () => {
      const p = pendingSlashRef.current;
      pendingSlashRef.current = null;
      if (!p) return;
      const view = viewRef.current;
      if (!view) return;
      const head = view.state.selection.main.head;
      if (head > 0 && view.state.doc.sliceString(head - 1, head) === p.char) {
        emitSlash({ pos: head, char: p.char });
      }
    };
    view.contentDOM.addEventListener("compositionend", onCompEnd);
    onViewReadyRef.current?.(createSourceSearch(view));
    return () => {
      view.scrollDOM.removeEventListener("scroll", handleScroll);
      view.contentDOM.removeEventListener("focus", reportFocus);
      view.contentDOM.removeEventListener("blur", reportBlur);
      view.contentDOM.removeEventListener("compositionend", onCompEnd);
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
