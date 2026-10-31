import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { buildLiveDecorations } from "./livePreview";
import { markdownSupport } from "./markdownSupport";

function stateFor(doc: string, head = doc.length) {
  return EditorState.create({
    doc,
    selection: { anchor: head },
    extensions: [markdownSupport],
  });
}

function build(doc: string, head = doc.length) {
  const state = stateFor(doc, head);
  return buildLiveDecorations(state, {
    from: 0,
    to: state.doc.length,
    composing: false,
    docPath: "/ws/a.md",
  });
}

function hiddenRanges(doc: string, head = doc.length) {
  const out: [number, number][] = [];
  build(doc, head).decorations.between(0, doc.length, (from, to, value) => {
    if (value.spec.widget == null && value.spec.class == null) {
      out.push([from, to]);
    }
  });
  return out;
}

function markClasses(doc: string, head = doc.length) {
  const out: string[] = [];
  build(doc, head).decorations.between(0, doc.length, (_f, _t, value) => {
    const cls = value.spec.class;
    if (typeof cls === "string") out.push(...cls.split(" "));
  });
  return out;
}

const covers = (ranges: [number, number][], pos: number) =>
  ranges.some(([from, to]) => pos >= from && pos < to);

describe("live decorations", () => {
  it("hides a heading marker only when the cursor is outside the heading", () => {
    expect(hiddenRanges("# Title\n")).toEqual([[0, 1]]);
    expect(hiddenRanges("# Title\n", 3)).toEqual([]);
  });

  it("hides emphasis markers and keeps the text visible", () => {
    const ranges = hiddenRanges("**bold**\n");
    expect(covers(ranges, 0)).toBe(true);
    expect(covers(ranges, 1)).toBe(true);
    expect(covers(ranges, 3)).toBe(false);
    expect(covers(ranges, 6)).toBe(true);
  });

  it("hides nested emphasis markers", () => {
    const ranges = hiddenRanges("**a *b* c**\n");
    expect(covers(ranges, 0)).toBe(true);
    expect(covers(ranges, 4)).toBe(true);
    expect(covers(ranges, 5)).toBe(false);
    expect(covers(ranges, 6)).toBe(true);
  });

  it("marks strikethrough content", () => {
    expect(markClasses("~~gone~~\n", 9)).toContain("rk-strike");
    const ranges = hiddenRanges("~~gone~~\n", 9);
    expect(covers(ranges, 0)).toBe(true);
    expect(covers(ranges, 2)).toBe(false);
  });

  it("hides task list markers", () => {
    const ranges = hiddenRanges("- [ ] todo\n");
    expect(covers(ranges, 2)).toBe(true);
    expect(covers(ranges, 4)).toBe(true);
    expect(covers(ranges, 6)).toBe(false);
  });

  it("marks setext headings and hides their underline when inactive", () => {
    expect(markClasses("Title\n=====\n\ntext\n")).toContain("rk-h1");
    expect(covers(hiddenRanges("Title\n=====\n\ntext\n"), 6)).toBe(true);
  });

  it("applies a code line class to indented code blocks", () => {
    expect(markClasses("    indented\n")).toContain("rk-code");
  });

  it("hides link brackets and the URL but not the label", () => {
    const ranges = hiddenRanges("[label](https://example.com)\n");
    expect(covers(ranges, 0)).toBe(true);
    expect(covers(ranges, 2)).toBe(false);
    expect(covers(ranges, 10)).toBe(true);
  });

  it("hides a reference link label", () => {
    const ranges = hiddenRanges("[text][ref]\n");
    expect(covers(ranges, 0)).toBe(true);
    expect(covers(ranges, 2)).toBe(false);
    expect(covers(ranges, 7)).toBe(true);
  });

  it("reveals the heading on the cursor's line only for a blank line", () => {
    expect(hiddenRanges("# H\n\ntext\n", 4)).toEqual([[0, 1]]);
  });

  it("scopes decorations to the visible range", () => {
    const doc = "# One\n\ntext\n\n## Two\n";
    const second = doc.indexOf("## Two");
    const state = stateFor(doc);
    const { decorations } = buildLiveDecorations(state, {
      from: second,
      to: doc.length,
      composing: false,
      docPath: "/ws/a.md",
    });
    const ranges: [number, number][] = [];
    decorations.between(0, doc.length, (from, to, value) => {
      if (value.spec.widget == null && value.spec.class == null) {
        ranges.push([from, to]);
      }
    });
    expect(covers(ranges, 0)).toBe(false);
    expect(covers(ranges, second)).toBe(true);
  });

  it("unions every selection range for the active block", () => {
    const doc = "# One\n\ntext\n\n## Two\n";
    const second = doc.indexOf("## Two");
    const state = EditorState.create({
      doc,
      selection: EditorSelection.create([
        EditorSelection.cursor(2),
        EditorSelection.cursor(second + 3),
      ]),
      extensions: [markdownSupport, EditorState.allowMultipleSelections.of(true)],
    });
    const { decorations } = buildLiveDecorations(state, {
      from: 0,
      to: doc.length,
      composing: false,
      docPath: "/ws/a.md",
    });
    const ranges: [number, number][] = [];
    decorations.between(0, doc.length, (from, to, value) => {
      if (value.spec.widget == null && value.spec.class == null) {
        ranges.push([from, to]);
      }
    });
    expect(ranges).toEqual([]);
  });

  it("marks the active block as atomic", () => {
    const { atomic } = build("**bold**\n");
    const ranges: [number, number][] = [];
    atomic.between(0, 10, (from, to) => {
      ranges.push([from, to]);
    });
    expect(ranges).toEqual([[0, 2], [6, 8]]);
  });

  it("keeps the atomic set empty for the active block", () => {
    expect(build("**bold**\n", 3).atomic.size).toBe(0);
  });

  it("emits no replace decorations while composing", () => {
    const state = stateFor("**bold**\n");
    const { decorations, atomic } = buildLiveDecorations(state, {
      from: 0,
      to: state.doc.length,
      composing: true,
      docPath: "/ws/a.md",
    });
    const hidden: [number, number][] = [];
    decorations.between(0, state.doc.length, (from, to, value) => {
      if (value.spec.widget == null && value.spec.class == null) {
        hidden.push([from, to]);
      }
    });
    expect(hidden).toEqual([]);
    expect(atomic.size).toBe(0);
  });
});
