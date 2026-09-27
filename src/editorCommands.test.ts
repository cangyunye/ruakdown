import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearCallout,
  insertCallout,
  insertCodeBlock,
  insertHr,
  insertIframe,
  insertImageLink,
  insertLink,
  insertTable,
  insertVideo,
  slashTrigger,
  togglePrefix,
  toggleWrap,
} from "./editorCommands";

const views: EditorView[] = [];

function makeView(doc: string, from?: number, to?: number): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      ...(from != null ? { selection: EditorSelection.single(from, to ?? from) } : {}),
    }),
  });
  views.push(view);
  return view;
}

afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
});

/** Run a command against a fresh view and capture doc + selection after. */
function run(doc: string, fn: (view: EditorView) => unknown, from?: number, to?: number) {
  const view = makeView(doc, from, to);
  fn(view);
  const sel = view.state.selection.main;
  return {
    text: view.state.doc.toString(),
    from: sel.from,
    to: sel.to,
    head: sel.head,
    selected: view.state.sliceDoc(sel.from, sel.to),
  };
}

describe("toggleWrap (inline formats)", () => {
  const bold = (v: EditorView) => toggleWrap(v, "**", "**", { placeholder: "粗体" });

  it("wraps a selection and keeps it selected", () => {
    const r = run("hello", bold, 1, 5);
    expect(r.text).toBe("h**ello**");
    expect(r.selected).toBe("ello");
  });

  it("toggles off an existing wrap", () => {
    const r = run("h**ello**", bold, 3, 7);
    expect(r.text).toBe("hello");
  });

  it("inserts and selects the placeholder on an empty selection", () => {
    const r = run("ab", bold, 1);
    expect(r.text).toBe("a**粗体**b");
    expect(r.selected).toBe("粗体");
  });

  it("wraps raw-HTML spans like <kbd>", () => {
    const r = run("Ctrl", (v) => toggleWrap(v, "<kbd>", "</kbd>", { placeholder: "Ctrl" }), 0, 4);
    expect(r.text).toBe("<kbd>Ctrl</kbd>");
  });

  it("adds ==mark== syntax", () => {
    const r = run("重点", (v) => toggleWrap(v, "==", "==", { placeholder: "高亮" }), 0, 2);
    expect(r.text).toBe("==重点==");
  });
});

describe("togglePrefix (blocks)", () => {
  it("adds a heading marker and places the caret after it", () => {
    const r = run("标题", (v) => togglePrefix(v, 2), 2);
    expect(r.text).toBe("## 标题");
    expect(r.head).toBe(3);
  });

  it("removes the marker when the line already has it", () => {
    const r = run("## 标题", (v) => togglePrefix(v, 2), 5);
    expect(r.text).toBe("标题");
    expect(r.head).toBe(0);
  });

  it("switches a heading level instead of nesting", () => {
    const r = run("## 标题", (v) => togglePrefix(v, 3), 0);
    expect(r.text).toBe("### 标题");
  });

  it("switches a bullet into a task item", () => {
    const r = run("- 待办", (v) => togglePrefix(v, "task"), 4);
    expect(r.text).toBe("- [ ] 待办");
  });

  it("renumbers an ordered list from the selection start", () => {
    const doc = "一行\n二行\n三行";
    const r = run(doc, (v) => togglePrefix(v, "ol"), 0, doc.length);
    expect(r.text).toBe("1. 一行\n2. 二行\n3. 三行");
  });

  it("removes an ordered list regardless of the numbers", () => {
    const doc = "2. 一行\n3. 二行";
    const r = run(doc, (v) => togglePrefix(v, "ol"), 0, doc.length);
    expect(r.text).toBe("一行\n二行");
  });

  it("maps the caret through marker removal", () => {
    const r = run("- 列表", (v) => togglePrefix(v, "ul"), 4);
    expect(r.text).toBe("列表");
    expect(r.head).toBe(0);
  });
});

describe("block insertion", () => {
  it("separates a divider from a preceding paragraph", () => {
    const r = run("段落文字", insertHr, 4);
    expect(r.text).toBe("段落文字\n\n---\n");
  });

  it("separates a divider from a following paragraph too", () => {
    const r = run("段落文字\n后续段落", insertHr, 4);
    expect(r.text).toBe("段落文字\n\n---\n\n后续段落");
  });

  it("inserts an empty code fence with the caret inside", () => {
    const r = run("", insertCodeBlock, 0);
    expect(r.text).toBe("```\n\n```\n");
    expect(r.head).toBe(4);
  });

  it("wraps a selection in a fence", () => {
    const r = run("代码", insertCodeBlock, 0, 2);
    expect(r.text).toBe("```\n代码\n```");
    expect(r.head).toBe(r.text.length);
  });

  it("inserts a table with the first header cell selected", () => {
    const r = run("", insertTable, 0);
    expect(r.text.startsWith("| 表头 |")).toBe(true);
    expect(r.selected).toBe("表头");
  });

  it("opens a callout block with the caret on the body line", () => {
    const r = run("", (v) => insertCallout(v, "NOTE"), 0);
    expect(r.text).toBe("> [!NOTE]\n> \n");
    expect(r.head).toBe(12);
  });

  it("quotes a selection under the callout marker", () => {
    const doc = "内容一\n内容二";
    const r = run(doc, (v) => insertCallout(v, "TIP"), 0, doc.length);
    expect(r.text).toBe("> [!TIP]\n> 内容一\n> 内容二");
  });
});

describe("clearCallout", () => {
  it("drops the header line and the quote markers", () => {
    const doc = "> [!NOTE]\n> 内容\n> 更多";
    const r = run(doc, clearCallout, 0, doc.length);
    expect(r.text).toBe("内容\n更多");
  });

  it("only strips markers outside a callout header", () => {
    const doc = "> 普通引用";
    const r = run(doc, clearCallout, 0, doc.length);
    expect(r.text).toBe("普通引用");
  });
});

describe("link & media insertions", () => {
  it("wraps a selection into a link and selects the URL slot", () => {
    const r = run("文本", insertLink, 0, 2);
    expect(r.text).toBe("[文本](https://)");
    expect(r.selected).toBe("https://");
  });

  it("selects the URL slot on an empty selection too", () => {
    const r = run("", insertLink, 0);
    expect(r.text).toBe("[链接文本](https://)");
    expect(r.selected).toBe("https://");
  });

  it("inserts an image link", () => {
    const r = run("图", insertImageLink, 0, 1);
    expect(r.text).toBe("![图](https://)");
    expect(r.selected).toBe("https://");
  });

  it("inserts an iframe with the URL selected", () => {
    const r = run("", insertIframe, 0);
    expect(r.selected).toBe("https://");
    expect(r.text).toContain('<iframe src="https://"');
  });

  it("inserts a video element with the URL selected", () => {
    const r = run("", insertVideo, 0);
    expect(r.selected).toBe("https://");
    expect(r.text).toContain("<video ");
  });
});

describe("slashTrigger", () => {
  /** Feed updates through a real view's listener, like the editor does. */
  function capture() {
    let last: ReturnType<typeof slashTrigger> = null;
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "",
        extensions: [EditorView.updateListener.of((u) => {
          last = slashTrigger(u);
        })],
      }),
    });
    views.push(view);
    return { view, get: () => last };
  }

  it("fires for a typed / at the cursor", () => {
    const { view, get } = capture();
    view.dispatch({
      changes: { from: 0, insert: "ab/" },
      selection: { anchor: 3 },
      userEvent: "input.type",
    });
    expect(get()).toEqual({ pos: 3, char: "/" });
    view.destroy();
  });

  it("fires for a composed 、 (IME reports input.type too)", () => {
    const { view, get } = capture();
    view.dispatch({
      changes: { from: 0, insert: "、" },
      selection: { anchor: 1 },
      userEvent: "input.type",
    });
    expect(get()).toEqual({ pos: 1, char: "、" });
    view.destroy();
  });

  it("ignores programmatic inserts, paste, undo and non-trigger chars", () => {
    const { view, get } = capture();
    view.dispatch({ changes: { from: 0, insert: "x" }, selection: { anchor: 1 }, userEvent: "input.type" });
    expect(get()).toBeNull();
    view.dispatch({ changes: { from: 1, insert: "/" }, selection: { anchor: 2 }, userEvent: "input.insert" });
    expect(get()).toBeNull();
    view.dispatch({ changes: { from: 2, insert: "/url" }, selection: { anchor: 6 }, userEvent: "input.paste" });
    expect(get()).toBeNull();
    view.destroy();
  });
});
