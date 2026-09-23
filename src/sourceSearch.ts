/**
 * CodeMirror-side half of the in-document find/replace panel.
 *
 * The panel itself is intentionally free of CodeMirror imports so it can be
 * loaded eagerly without pulling the editor bundle into startup; it drives the
 * editor through this small handle instead.
 */
import { EditorView, Decoration, type DecorationSet } from "@codemirror/view";
import { StateField, StateEffect } from "@codemirror/state";
import type { MatchResult } from "./searchEngine";

const setDecos = StateEffect.define<DecorationSet>();

/** Match decorations as a StateField so positions map through edits. */
export const searchStateField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decos, tr) {
    for (const e of tr.effects) if (e.is(setDecos)) return e.value;
    return tr.docChanged ? decos.map(tr.changes) : decos;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const matchDeco = Decoration.mark({ class: "cm-search-match" });
const currentDeco = Decoration.mark({ class: "cm-search-current" });

/** Imperative bridge the search panel uses to drive the source editor. */
export interface SourceSearch {
  getText(): string;
  highlight(matches: MatchResult[], current: number): void;
  scrollTo(match: MatchResult): void;
  clear(): void;
  replaceMatch(match: MatchResult, text: string): void;
  replaceAll(matches: MatchResult[], text: string): void;
}

export function createSourceSearch(view: EditorView): SourceSearch {
  return {
    getText: () => view.state.doc.toString(),

    highlight(matches, current) {
      const parts = [];
      for (let i = 0; i < matches.length; i++) {
        const m = matches[i];
        if (m.from === m.to) continue;
        // Call .range as a method: MarkDecoration.range needs its `this`.
        parts.push((i === current ? currentDeco : matchDeco).range(m.from, m.to));
      }
      view.dispatch({
        effects: setDecos.of(parts.length ? Decoration.set(parts, true) : Decoration.none),
      });
    },

    scrollTo(match) {
      view.dispatch({ effects: EditorView.scrollIntoView(match.from, { y: "center" }) });
    },

    clear() {
      view.dispatch({ effects: setDecos.of(Decoration.none) });
    },

    replaceMatch(match, text) {
      view.dispatch({ changes: { from: match.from, to: match.to, insert: text } });
    },

    replaceAll(matches, text) {
      view.dispatch({
        changes: matches.map((m) => ({ from: m.from, to: m.to, insert: text })),
      });
    },
  };
}
