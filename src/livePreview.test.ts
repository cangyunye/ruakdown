import { EditorView, type WidgetType } from "@codemirror/view";
import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import {
  TaskWidget,
  buildLiveDecorations,
  livePreview,
  resolveImagePath,
} from "./livePreview";
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

  it("does not hide task markers that now render as a widget", () => {
    const ranges = hiddenRanges("- [ ] todo\n");
    expect(covers(ranges, 2)).toBe(false);
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

function widgetSpans(doc: string, head = doc.length) {
  const out: { from: number; to: number; widget: WidgetType }[] = [];
  build(doc, head).decorations.between(0, doc.length, (from, to, value) => {
    if (value.spec.widget) out.push({ from, to, widget: value.spec.widget });
  });
  return out;
}

function widgetNames(doc: string, head = doc.length): string[] {
  return widgetSpans(doc, head).map((s) => s.widget.constructor.name);
}

describe("block widgets", () => {
  it("renders a checkbox for a task item outside the active block", () => {
    expect(widgetNames("- [ ] todo\n")).toContain("TaskWidget");
    expect(widgetNames("- [ ] todo\n", 3)).not.toContain("TaskWidget");
  });

  it("renders a bullet for unordered lists but not for ordered or task items", () => {
    expect(widgetNames("- item\n")).toContain("BulletWidget");
    expect(widgetNames("1. item\n")).not.toContain("BulletWidget");
    expect(widgetNames("- [ ] todo\n")).not.toContain("BulletWidget");
  });

  it("hides the bullet while the list item is active", () => {
    expect(widgetNames("- item\n", 3)).not.toContain("BulletWidget");
  });

  it("hides a horizontal rule line and marks it with a rule class", () => {
    const doc = "---\n\npara\n";
    expect(hiddenRanges(doc)).toContainEqual([0, 3]);
    expect(markClasses(doc)).toContain("rk-hr-line");
  });

  it("leaves the horizontal rule raw while its line is active", () => {
    expect(hiddenRanges("---\n\npara\n", 1)).toEqual([]);
    expect(markClasses("---\n\npara\n", 1)).not.toContain("rk-hr-line");
  });

  it("mounts in a real editor without a block-decoration crash", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const doc = "---\n\npara\n";
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: doc.length },
        extensions: [markdownSupport, livePreview("/ws/a.md")],
      }),
      parent,
    });
    expect(view.dom.querySelector(".rk-hr-line")).not.toBeNull();
    view.destroy();
    parent.remove();
  });

  it("emits no widgets while composing", () => {
    const state = stateFor("- [ ] todo\n");
    const built = buildLiveDecorations(state, {
      from: 0,
      to: state.doc.length,
      composing: true,
      docPath: "/ws/a.md",
    });
    const widgets: unknown[] = [];
    const hidden: [number, number][] = [];
    built.decorations.between(0, state.doc.length, (from, to, value) => {
      if (value.spec.widget) widgets.push(value.spec.widget);
      if (value.spec.widget == null && value.spec.class == null) {
        hidden.push([from, to]);
      }
    });
    expect(widgets).toEqual([]);
    expect(hidden).toEqual([]);
    expect(built.atomic.size).toBe(0);
  });

  it("keeps widgets out of the atomic set", () => {
    expect(build("- [ ] todo\n").atomic.size).toBe(0);
    const doc = "# T\n\n- [ ] todo\n";
    const built = build(doc);
    const widgets: [number, number][] = [];
    built.decorations.between(0, doc.length, (from, to, value) => {
      if (value.spec.widget) widgets.push([from, to]);
    });
    const atomic: [number, number][] = [];
    built.atomic.between(0, doc.length, (from, to) => {
      atomic.push([from, to]);
    });
    expect(widgets.length).toBeGreaterThan(0);
    expect(atomic.length).toBeGreaterThan(0);
    expect(
      widgets.some(([wf, wt]) => atomic.some(([af, at]) => wf < at && wt > af)),
    ).toBe(false);
  });

  it("pins the checkbox span to the task marker range", () => {
    const task = widgetSpans("- [ ] todo\n").find(
      (s) => s.widget instanceof TaskWidget,
    );
    expect([task?.from, task?.to]).toEqual([2, 5]);
  });

  it("toggles the checkbox through the document", () => {
    const task = widgetSpans("- [ ] todo\n").find(
      (s) => s.widget instanceof TaskWidget,
    );
    expect(task).toBeDefined();
    const view = {
      dispatch: vi.fn(),
      requestMeasure: vi.fn(),
    } as unknown as EditorView;
    const el = task!.widget.toDOM(view);
    expect(el.tabIndex).toBe(0);
    expect(el.getAttribute("aria-label")).toBe("切换任务完成");
    el.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    expect(view.dispatch).toHaveBeenCalledWith({
      changes: { from: 2, to: 5, insert: "[x]" },
    });
  });

  it("dims frontmatter but decorates nothing inside it", () => {
    const doc = "---\ntitle: x\n---\n\nbody\n";
    const fmEnd = "---\ntitle: x\n---".length;
    const classes: string[] = [];
    const inside: string[] = [];
    build(doc).decorations.between(0, doc.length, (from, to, value) => {
      if (typeof value.spec.class === "string") classes.push(value.spec.class);
      if (to <= fmEnd && value.spec.class !== "rk-frontmatter") {
        inside.push(`${from}-${to}:${value.spec.widget ? "widget" : "replace"}`);
      }
    });
    expect(classes).toContain("rk-frontmatter");
    expect(inside).toEqual([]);
  });

  it("clamps frontmatter line classes to the visible range", () => {
    const doc = "---\ntitle: x\n---\n\nbody\n";
    const from = doc.indexOf("body");
    const state = stateFor(doc);
    const { decorations } = buildLiveDecorations(state, {
      from,
      to: doc.length,
      composing: false,
      docPath: "/ws/a.md",
    });
    const classesAtZero: string[] = [];
    decorations.between(0, from, (_f, _t, value) => {
      if (typeof value.spec.class === "string") {
        classesAtZero.push(value.spec.class);
      }
    });
    expect(classesAtZero).not.toContain("rk-frontmatter");
  });

  it("stops scanning for a frontmatter delimiter after 200 lines", () => {
    const doc = `---\n${"k: v\n".repeat(210)}---\n\nbody\n`;
    expect(markClasses(doc)).not.toContain("rk-frontmatter");
  });
});

describe("resolveImagePath", () => {
  it("resolves relative paths next to the document", () => {
    expect(resolveImagePath("/ws/doc/a.md", "./img/x.png")).toBe(
      "/ws/doc/img/x.png",
    );
    expect(resolveImagePath("/ws/doc/a.md", "../assets/中文 图.png")).toBe(
      "/ws/assets/中文 图.png",
    );
    expect(resolveImagePath("C:\\ws\\doc\\a.md", ".\\img\\x.png")).toBe(
      "C:/ws/doc/img/x.png",
    );
  });

  it("decodes percent-encoded names", () => {
    expect(resolveImagePath("/ws/a.md", "img/%E4%B8%AD%E6%96%87.png")).toBe(
      "/ws/img/中文.png",
    );
  });

  it("passes absolute and non-file references through", () => {
    expect(resolveImagePath("/ws/a.md", "https://example.com/x.png")).toBeNull();
    expect(resolveImagePath("/ws/a.md", "http://example.com/x.png")).toBeNull();
    expect(resolveImagePath("/ws/a.md", "data:image/png;base64,xx")).toBeNull();
    expect(resolveImagePath("/ws/a.md", "asset://localhost/x.png")).toBeNull();
    expect(resolveImagePath("/ws/a.md", "#anchor")).toBeNull();
  });

  it("clamps parent traversal at the root", () => {
    expect(resolveImagePath("/ws/a.md", "../../x.png")).toBe("/x.png");
  });
});

describe("image widget", () => {
  it("replaces an image node outside the active block", () => {
    expect(widgetNames("![alt](img.png)\n")).toContain("ImageWidget");
    expect(widgetNames("![alt](img.png)\n", 2)).not.toContain("ImageWidget");
  });
});
