import { EditorView } from "@codemirror/view";
import { EditorState, Text } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import {
  type LiveBlock,
  MathWidget,
  TableWidget,
  liveBlocksField,
  needsRescan,
  renderInlineMarkdown,
  renderedBlocks,
  scanBlocks,
  splitTableRow,
  tableHtml,
  updateBlocks,
} from "./liveBlocks";
import { buildLiveDecorations, livePreview } from "./livePreview";
import { markdownSupport } from "./markdownSupport";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: vi.fn((p: string) => `asset://${p}`),
  invoke: vi.fn(),
}));

const renderMath = vi.fn(
  async (tex: string, _display: boolean) => `<span class="math math-display">${tex}</span>`,
);
vi.mock("./ipc", () => ({
  api: { renderMath: (tex: string, display: boolean) => renderMath(tex, display) },
}));

const mermaidSvg = vi.fn(async (_source: string, _dark: boolean) => "<svg data-mermaid></svg>");
vi.mock("./mermaid", () => ({
  mermaidSvg: (s: string, d: boolean) => mermaidSvg(s, d),
}));

const scan = (doc: string) => scanBlocks(Text.of(doc.split("\n")));

const TABLE = "| a | b |\n|---|:-:|\n| 1 | 2 |\n| 3 | 4 |\n";

describe("scanBlocks", () => {
  it("parses a GFM table with header, alignment and body rows", () => {
    const blocks = scan(TABLE);
    expect(blocks).toHaveLength(1);
    const b = blocks[0];
    expect(b.kind).toBe("table");
    if (b.kind !== "table") return;
    expect(b.from).toBe(0);
    // The range covers the trailing newline of the last row.
    expect(b.to).toBe(TABLE.length);
    expect(b.table.header).toEqual(["a", "b"]);
    expect(b.table.aligns).toEqual(["left", "center"]);
    expect(b.table.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("accepts tables without leading or trailing pipes", () => {
    const blocks = scan("a | b\n--- | ---:\n1 | 2\n");
    expect(blocks).toHaveLength(1);
    if (blocks[0].kind !== "table") throw new Error("not a table");
    expect(blocks[0].table.header).toEqual(["a", "b"]);
    expect(blocks[0].table.aligns).toEqual(["left", "right"]);
    expect(blocks[0].table.rows).toEqual([["1", "2"]]);
  });

  it("ends the table at the first blank or pipe-less line", () => {
    const doc = "| a |\n|---|\n| 1 |\n\nafter | not a row\n";
    const blocks = scan(doc);
    expect(blocks).toHaveLength(1);
    if (blocks[0].kind !== "table") throw new Error("not a table");
    expect(blocks[0].table.rows).toEqual([["1"]]);
    // Ends right after the last row's newline — at the blank line's start.
    expect(blocks[0].to).toBe(doc.indexOf("\n\nafter") + 1);
  });

  it("does not treat a pipe without a delimiter row as a table", () => {
    expect(scan("a | b\nplain text\n")).toEqual([]);
  });

  it("accepts single-column tables and never a pipe-less dash line", () => {
    const one = scan("| only |\n|---|\n| x |\n");
    expect(one).toHaveLength(1);
    if (one[0].kind !== "table") throw new Error("not a table");
    expect(one[0].table.header).toEqual(["only"]);
    expect(one[0].table.rows).toEqual([["x"]]);
    // `---` under a line with a pipe is a setext underline, not a table.
    expect(scan("a | b\n---\n")).toEqual([]);
  });

  it("honors escaped pipes inside cells", () => {
    expect(splitTableRow("| a \\| b | c |")).toEqual(["a | b", "c"]);
  });

  it("parses a mermaid fence with its inner source only", () => {
    const doc = "intro\n\n```mermaid\ngraph TD\n  A --> B\n```\n\nafter\n";
    const blocks = scan(doc);
    expect(blocks).toHaveLength(1);
    const b = blocks[0];
    expect(b.kind).toBe("mermaid");
    if (b.kind !== "mermaid") return;
    expect(b.source).toBe("graph TD\n  A --> B\n");
    expect(doc.slice(b.from, b.to)).toBe("```mermaid\ngraph TD\n  A --> B\n```\n");
  });

  it("ignores non-mermaid fences and never scans their content as tables", () => {
    const doc = "```txt\n| a | b |\n|---|---|\n| 1 | 2 |\n```\n";
    expect(scan(doc)).toEqual([]);
  });

  it("handles tilde fences and longer backtick runs", () => {
    expect(scan("~~~mermaid\ngraph LR\n~~~\n")).toHaveLength(1);
    expect(scan("````mermaid\ngraph LR\n````\n")).toHaveLength(1);
    // A shorter closing run does not close a longer opener.
    expect(scan("````mermaid\ngraph LR\n```\n")).toEqual([]);
  });

  it("parses single-line and multi-line display math", () => {
    const one = scan("$$E = mc^2$$\n");
    expect(one).toEqual([{ kind: "math", from: 0, to: 13, tex: "E = mc^2" }]);

    const doc = "$$\n\\int_0^1 x\\,dx\n= \\frac12\n$$\n";
    const multi = scan(doc);
    expect(multi).toHaveLength(1);
    if (multi[0].kind !== "math") throw new Error("not math");
    expect(multi[0].tex).toBe("\\int_0^1 x\\,dx\n= \\frac12");
    expect(multi[0].to).toBe(doc.length);
  });

  it("leaves an unclosed math block alone", () => {
    expect(scan("$$\nx = 1\n\nprose\n")).toEqual([]);
  });

  it("skips the frontmatter even when it contains table-looking lines", () => {
    const doc = "---\ntitle: a | b\n---|---\n---\n\n| h |\n|---|\n| 1 |\n";
    const blocks = scan(doc);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].from).toBe(doc.indexOf("| h |"));
  });

  it("finds several blocks of different kinds in order", () => {
    const doc = `${TABLE}\n$$a$$\n\n\`\`\`mermaid\ngraph LR\n\`\`\`\n`;
    expect(scan(doc).map((b) => b.kind)).toEqual(["table", "math", "mermaid"]);
  });
});

function stateWith(doc: string, anchor = doc.length) {
  return EditorState.create({
    doc,
    selection: { anchor },
    extensions: [markdownSupport, liveBlocksField],
  });
}

describe("incremental updates", () => {
  it("maps block positions through a prose edit without rescanning", () => {
    const doc = `intro\n\n${TABLE}`;
    const state = stateWith(doc, 0);
    const old = scanBlocks(state.doc);
    const tr = state.update({ changes: { from: 0, insert: "Hello " } });
    expect(needsRescan(old, tr)).toBe(false);
    const next = updateBlocks(old, tr);
    expect(next).toHaveLength(1);
    expect(next[0].from).toBe(old[0].from + 6);
    expect(next[0].to).toBe(old[0].to + 6);
    // The parsed table is carried over, not re-parsed.
    expect((next[0] as Extract<LiveBlock, { kind: "table" }>).table).toBe(
      (old[0] as Extract<LiveBlock, { kind: "table" }>).table,
    );
  });

  it("rescans when a structural character is typed", () => {
    const state = stateWith("a b\n", 0);
    const tr = state.update({ changes: { from: 1, insert: "|" } });
    expect(needsRescan([], tr)).toBe(true);
  });

  it("rescans when an edit touches an existing block", () => {
    const state = stateWith(TABLE, 0);
    const old = scanBlocks(state.doc);
    const tr = state.update({ changes: { from: 2, to: 3, insert: "x" } });
    expect(needsRescan(old, tr)).toBe(true);
    const next = updateBlocks(old, tr);
    if (next[0].kind !== "table") throw new Error("not a table");
    expect(next[0].table.header).toEqual(["x", "b"]);
  });

  it("drops a block whose text was deleted entirely", () => {
    const state = stateWith(TABLE, 0);
    const old = scanBlocks(state.doc);
    const tr = state.update({ changes: { from: 0, to: TABLE.length, insert: "" } });
    expect(updateBlocks(old, tr)).toEqual([]);
  });

  it("returns the same array for a selection-only transaction", () => {
    const state = stateWith(TABLE, 0);
    const old = scanBlocks(state.doc);
    const tr = state.update({ selection: { anchor: 2 } });
    expect(updateBlocks(old, tr)).toBe(old);
  });
});

describe("HTML rendering", () => {
  it("renders inline code, emphasis, strike and links; escapes HTML", () => {
    expect(renderInlineMarkdown("`a<b`")).toBe("<code>a&lt;b</code>");
    expect(renderInlineMarkdown("**x** *y* ~~z~~")).toBe(
      "<strong>x</strong> <em>y</em> <del>z</del>",
    );
    expect(renderInlineMarkdown("[t](https://x)")).toBe('<a href="https://x">t</a>');
    expect(renderInlineMarkdown("<script>")).toBe("&lt;script&gt;");
  });

  it("does not format markers inside inline code", () => {
    expect(renderInlineMarkdown("`**not bold**`")).toBe("<code>**not bold**</code>");
  });

  it("emits a thead/tbody table with alignment styles", () => {
    const html = tableHtml({
      header: ["a", "b"],
      aligns: ["left", "right"],
      rows: [["1", "2"]],
    });
    expect(html).toBe(
      '<table><thead><tr><th>a</th><th style="text-align: right">b</th></tr></thead>' +
        '<tbody><tr><td>1</td><td style="text-align: right">2</td></tr></tbody></table>',
    );
  });
});

function mount(doc: string, anchor = doc.length) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [markdownSupport, livePreview("/ws/a.md")],
    }),
    parent,
  });
  return {
    view,
    dispose: () => {
      view.destroy();
      parent.remove();
    },
  };
}

describe("block widgets in the editor", () => {
  it("renders a table widget while the cursor is outside the table", () => {
    const doc = `${TABLE}\nafter\n`;
    const { view, dispose } = mount(doc);
    try {
      const table = view.dom.querySelector(".rk-render-table table");
      expect(table).not.toBeNull();
      expect(table?.querySelectorAll("th")).toHaveLength(2);
      expect(table?.querySelectorAll("tbody tr")).toHaveLength(2);
      // The reading stylesheet applies through the .md-body wrapper.
      expect(view.dom.querySelector(".rk-render-table")?.classList.contains("md-body")).toBe(
        true,
      );
      expect(view.dom.textContent).not.toContain("|---|");
    } finally {
      dispose();
    }
  });

  it("shows the raw Markdown when the cursor enters the table", () => {
    const doc = `${TABLE}\nafter\n`;
    const { view, dispose } = mount(doc);
    try {
      view.dispatch({ selection: { anchor: 2 } });
      expect(view.dom.querySelector(".rk-render-table")).toBeNull();
      expect(view.dom.textContent).toContain("|---|:-:|");

      view.dispatch({ selection: { anchor: doc.length } });
      expect(view.dom.querySelector(".rk-render-table")).not.toBeNull();
    } finally {
      dispose();
    }
  });

  it("keeps the block rendered while the cursor sits on the line after it", () => {
    const doc = `before\n${TABLE}after\n`;
    const { view, dispose } = mount(doc, 0);
    try {
      const blockTo = doc.indexOf("after");
      view.dispatch({ selection: { anchor: blockTo } });
      expect(view.dom.querySelector(".rk-render-table")).not.toBeNull();
      // End of the line before the block is outside as well.
      view.dispatch({ selection: { anchor: doc.indexOf("| a |") - 1 } });
      expect(view.dom.querySelector(".rk-render-table")).not.toBeNull();
    } finally {
      dispose();
    }
  });

  it("reveals the source when the cursor arrows into the block", () => {
    const doc = `before\n${TABLE}after\n`;
    const { view, dispose } = mount(doc, 0);
    try {
      const blockTo = doc.indexOf("after");
      // One step left from the line after the block lands on the block's
      // last row (the range is not atomic), which reveals the Markdown.
      view.dispatch({ selection: { anchor: blockTo - 1 } });
      expect(view.dom.querySelector(".rk-render-table")).toBeNull();
      expect(view.dom.textContent).toContain("| 3 | 4 |");
    } finally {
      dispose();
    }
  });

  it("treats the document end as inside a block that has no trailing newline", () => {
    const doc = "| a |\n|---|\n| 1 |";
    const { view, dispose } = mount(doc, doc.length);
    try {
      expect(view.dom.querySelector(".rk-render-table")).toBeNull();
      view.dispatch({ selection: { anchor: 0 } });
      expect(view.dom.querySelector(".rk-render-table")).toBeNull();
    } finally {
      dispose();
    }
    const withNewline = `${doc}\n`;
    const second = mount(withNewline, withNewline.length);
    try {
      expect(second.view.dom.querySelector(".rk-render-table")).not.toBeNull();
    } finally {
      second.dispose();
    }
  });

  it("moves the cursor into the block when the widget is clicked", () => {
    const doc = `${TABLE}\nafter\n`;
    const { view, dispose } = mount(doc);
    try {
      const wrap = view.dom.querySelector<HTMLElement>(".rk-render-table");
      expect(wrap).not.toBeNull();
      wrap?.dispatchEvent(
        new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true }),
      );
      expect(view.state.selection.main.anchor).toBe(0);
      expect(view.dom.querySelector(".rk-render-table")).toBeNull();
    } finally {
      dispose();
    }
  });

  it("renders display math through the Rust renderer", async () => {
    const doc = "$$E = mc^2$$\n\nafter\n";
    const { view, dispose } = mount(doc);
    try {
      const wrap = view.dom.querySelector<HTMLElement>(".rk-render-math");
      expect(wrap).not.toBeNull();
      expect(renderMath).toHaveBeenCalledWith("E = mc^2", true);
      await vi.waitFor(() =>
        expect(wrap?.innerHTML).toBe('<span class="math math-display">E = mc^2</span>'),
      );
    } finally {
      dispose();
    }
  });

  it("renders a mermaid fence as an SVG container", async () => {
    const doc = "```mermaid\ngraph LR\n```\n\nafter\n";
    const { view, dispose } = mount(doc);
    try {
      const wrap = view.dom.querySelector<HTMLElement>(".rk-render-mermaid");
      expect(wrap).not.toBeNull();
      expect(wrap?.classList.contains("mermaid-block")).toBe(true);
      expect(mermaidSvg).toHaveBeenCalledWith("graph LR\n", false);
      await vi.waitFor(() => expect(wrap?.querySelector("svg[data-mermaid]")).not.toBeNull());
    } finally {
      dispose();
    }
  });

  it("falls back to the raw TeX when rendering fails", async () => {
    renderMath.mockRejectedValueOnce(new Error("bad tex"));
    const doc = "$$\\bad{$$\n\nafter\n";
    const { view, dispose } = mount(doc);
    try {
      const wrap = view.dom.querySelector<HTMLElement>(".rk-render-math");
      await vi.waitFor(() => expect(wrap?.classList.contains("math-raw")).toBe(true));
      expect(wrap?.textContent).toBe("\\bad{");
    } finally {
      dispose();
    }
  });

  it("keeps the inline decorator out of rendered block ranges", () => {
    const doc = "| **a** | b |\n|---|---|\n| `c` | d |\n\n**after**\n";
    const { view, dispose } = mount(doc);
    try {
      const skip = renderedBlocks(view.state);
      expect(skip).toHaveLength(1);
      const built = buildLiveDecorations(view.state, {
        from: 0,
        to: doc.length,
        composing: false,
        docPath: "/ws/a.md",
        skip,
      });
      const inside: string[] = [];
      const outside: string[] = [];
      built.decorations.between(0, doc.length, (from, to, value) => {
        const cls = typeof value.spec.class === "string" ? value.spec.class : "";
        const target = from < skip[0].to && to > skip[0].from ? inside : outside;
        target.push(cls || (value.spec.widget ? "widget" : "hide"));
      });
      expect(inside).toEqual([]);
      expect(outside).toContain("rk-strong");
    } finally {
      dispose();
    }
  });

  it("reports no rendered blocks for a state without the field", () => {
    const state = EditorState.create({ doc: TABLE, extensions: [markdownSupport] });
    expect(renderedBlocks(state)).toEqual([]);
  });
});

describe("widget identity", () => {
  it("treats equal tables at the same position as the same widget", () => {
    const t = { header: ["a"], aligns: ["left" as const], rows: [["1"]] };
    expect(new TableWidget(t, 0).eq(new TableWidget({ ...t }, 0))).toBe(true);
    expect(new TableWidget(t, 0).eq(new TableWidget({ ...t, rows: [["2"]] }, 0))).toBe(false);
    expect(new TableWidget(t, 0).eq(new TableWidget(t, 5))).toBe(false);
  });

  it("compares math widgets by TeX source", () => {
    expect(new MathWidget("x", 0).eq(new MathWidget("x", 9))).toBe(true);
    expect(new MathWidget("x", 0).eq(new MathWidget("y", 0))).toBe(false);
  });
});
