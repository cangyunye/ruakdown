import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { describe, expect, it } from "vitest";
import { buildLiveDecorations } from "./livePreview";

function stateFor(doc: string, head = doc.length) {
  return EditorState.create({
    doc,
    selection: { anchor: head },
    extensions: [markdown()],
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

  it("hides link brackets and the URL but not the label", () => {
    const ranges = hiddenRanges("[label](https://example.com)\n");
    expect(covers(ranges, 0)).toBe(true);
    expect(covers(ranges, 2)).toBe(false);
    expect(covers(ranges, 10)).toBe(true);
  });

  it("marks the active block as atomic", () => {
    const { atomic } = build("**bold**\n");
    const ranges: [number, number][] = [];
    atomic.between(0, 10, (from, to) => {
      ranges.push([from, to]);
    });
    expect(ranges).toEqual([[0, 2], [6, 8]]);
  });

  it("emits no replace decorations while composing", () => {
    const state = stateFor("**bold**\n");
    const { decorations } = buildLiveDecorations(state, {
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
  });
});
