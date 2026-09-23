import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createSourceSearch, searchStateField } from "./sourceSearch";

function makeView(doc: string): EditorView {
  return new EditorView({
    state: EditorState.create({ doc, extensions: [searchStateField] }),
  });
}

describe("createSourceSearch", () => {
  it("reports the live document text", () => {
    const view = makeView("hello");
    expect(createSourceSearch(view).getText()).toBe("hello");
    view.destroy();
  });

  it("replaces a single match", () => {
    const view = makeView("hello world");
    createSourceSearch(view).replaceMatch({ from: 6, to: 11 }, "there");
    expect(view.state.doc.toString()).toBe("hello there");
    view.destroy();
  });

  it("replaces every match in one transaction", () => {
    const view = makeView("a a a");
    createSourceSearch(view).replaceAll(
      [
        { from: 0, to: 1 },
        { from: 2, to: 3 },
        { from: 4, to: 5 },
      ],
      "b",
    );
    expect(view.state.doc.toString()).toBe("b b b");
    view.destroy();
  });

  it("highlights and clears without touching the document", () => {
    const view = makeView("hello");
    const search = createSourceSearch(view);
    search.highlight([{ from: 0, to: 5 }], 0);
    search.clear();
    expect(view.state.doc.toString()).toBe("hello");
    view.destroy();
  });
});
