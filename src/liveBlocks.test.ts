import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { describe, expect, it, vi } from "vitest";
import {
  FragmentWidget,
  MathWidget,
  TableWidget,
  buildBlocks,
  extractDisplayMath,
  liveBlocksField,
  renderInlineMarkdown,
  renderedBlocks,
  splitTableRow,
  tableHtml,
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
const renderFragment = vi.fn(
  async (md: string, _baseFile: string) => `<div class="rk-fragment">${md}</div>`,
);
vi.mock("./ipc", () => ({
  api: {
    renderMath: (tex: string, display: boolean) => renderMath(tex, display),
    renderFragment: (md: string, baseFile: string) => renderFragment(md, baseFile),
  },
}));

const mermaidSvg = vi.fn(async (_source: string, _dark: boolean) => "<svg data-mermaid></svg>");
const renderMermaidBlocks = vi.fn(
  async (_root: HTMLElement, _dark: boolean) => {},
);
vi.mock("./mermaid", () => ({
  mermaidSvg: (s: string, d: boolean) => mermaidSvg(s, d),
  renderMermaidBlocks: (root: HTMLElement, dark: boolean) =>
    renderMermaidBlocks(root, dark),
}));

const TABLE = "| a | b |\n|---|:-:|\n| 1 | 2 |\n| 3 | 4 |\n";

function stateWith(doc: string, anchor = doc.length) {
  return EditorState.create({
    doc,
    selection: { anchor },
    extensions: [markdownSupport, liveBlocksField],
  });
}

const blocksOf = (doc: string) => buildBlocks(stateWith(doc));
const kindsOf = (doc: string) => blocksOf(doc).map((b) => b.kind);

describe("buildBlocks", () => {
  it("parses a GFM table with header, alignment and body rows", () => {
    const blocks = blocksOf(TABLE);
    expect(blocks).toHaveLength(1);
    const b = blocks[0];
    expect(b.kind).toBe("table");
    if (b.kind !== "table") return;
    expect(b.from).toBe(0);
    // A trailing block owns up to the end of the document.
    expect(b.to).toBe(TABLE.length);
    expect(b.table.header).toEqual(["a", "b"]);
    expect(b.table.aligns).toEqual(["left", "center"]);
    expect(b.table.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("accepts tables without leading or trailing pipes", () => {
    const blocks = blocksOf("a | b\n--- | ---:\n1 | 2\n");
    expect(blocks).toHaveLength(1);
    if (blocks[0].kind !== "table") throw new Error("not a table");
    expect(blocks[0].table.header).toEqual(["a", "b"]);
    expect(blocks[0].table.aligns).toEqual(["left", "right"]);
    expect(blocks[0].table.rows).toEqual([["1", "2"]]);
  });

  it("ends the table where the lezer Table node ends", () => {
    const doc = "| a |\n|---|\n| 1 |\n\nafter | not a row\n";
    const blocks = blocksOf(doc);
    expect(blocks.map((b) => b.kind)).toEqual(["table", "prose"]);
    if (blocks[0].kind !== "table") throw new Error("not a table");
    expect(blocks[0].table.rows).toEqual([["1"]]);
    // The table owns everything up to the next block's start (its trailing
    // newline plus the blank line).
    expect(blocks[0].to).toBe(doc.indexOf("after"));
  });

  it("classifies plain paragraphs and setext headings as prose", () => {
    // `---` under a line is a setext underline (h2), never a table.
    expect(kindsOf("a | b\nplain text\n")).toEqual(["prose"]);
    expect(kindsOf("Title\n===\n")).toEqual(["prose"]);
  });

  it("continues a pipe-less body line as a row, matching the reading renderer", () => {
    // pulldown (verified) keeps scanning body rows past non-pipe lines; the
    // lezer Table node agrees, so the widget shows what the reader shows.
    const blocks = blocksOf("| a | b |\n|---|---|\n| 1 | 2 |\nafter\n");
    expect(blocks).toHaveLength(1);
    if (blocks[0].kind !== "table") throw new Error("not a table");
    expect(blocks[0].table.rows).toEqual([
      ["1", "2"],
      ["after", ""],
    ]);
  });

  it("honors escaped pipes inside cells", () => {
    expect(splitTableRow("| a \\| b | c |")).toEqual(["a | b", "c"]);
  });

  it("parses a mermaid fence with its inner source only", () => {
    const doc = "intro\n\n```mermaid\ngraph TD\n  A --> B\n```\n\nafter\n";
    const blocks = blocksOf(doc);
    expect(blocks.map((b) => b.kind)).toEqual(["prose", "mermaid", "prose"]);
    const b = blocks[1];
    if (b.kind !== "mermaid") return;
    expect(b.source).toBe("graph TD\n  A --> B\n");
    expect(doc.slice(b.from, b.to)).toContain("```mermaid");
  });

  it("renders non-mermaid fences as code fragments", () => {
    const doc = "```txt\n| a | b |\n|---|---|\n| 1 | 2 |\n```\n";
    const blocks = blocksOf(doc);
    expect(blocks).toHaveLength(1);
    if (blocks[0].kind !== "code") throw new Error("not code");
    // Fence content is never misread as a table.
    expect(blocks[0].text).toBe(doc.trimEnd());
  });

  it("handles tilde fences, longer backtick runs and unclosed fences", () => {
    expect(kindsOf("~~~mermaid\ngraph LR\n~~~\n")).toEqual(["mermaid"]);
    expect(kindsOf("````mermaid\ngraph LR\n````\n")).toEqual(["mermaid"]);
    // An unclosed fence runs to the end of the document; the shorter run
    // stays fence *content* — the reading renderer sees the same thing, so
    // the widget's diagram source matches it.
    const unclosed = blocksOf("````mermaid\ngraph LR\n```\n");
    expect(unclosed).toHaveLength(1);
    if (unclosed[0].kind !== "mermaid") throw new Error("not mermaid");
    expect(unclosed[0].source).toBe("graph LR\n```\n");
  });

  it("parses single-line and multi-line display math", () => {
    const one = blocksOf("$$E = mc^2$$\n");
    expect(one).toHaveLength(1);
    if (one[0].kind !== "math") throw new Error("not math");
    expect(one[0].tex).toBe("E = mc^2");
    expect(one[0].to).toBe("$$E = mc^2$$\n".length);

    const doc = "$$\n\\int_0^1 x\\,dx\n= \\frac12\n$$\n";
    const multi = blocksOf(doc);
    expect(multi).toHaveLength(1);
    if (multi[0].kind !== "math") throw new Error("not math");
    expect(multi[0].tex).toBe("\\int_0^1 x\\,dx\n= \\frac12");
    expect(multi[0].to).toBe(doc.length);
  });

  it("leaves math without a closing $$ inside the paragraph as prose", () => {
    // pulldown never pairs `$$` across a blank line — the widget must not
    // claim more than the reading view renders.
    expect(kindsOf("$$\nx = 1\n\nprose\n")).toEqual(["prose", "prose"]);
  });

  it("skips the frontmatter even when it contains table-looking lines", () => {
    const doc = "---\ntitle: a | b\n---|---\n---\n\n| h |\n|---|\n| 1 |\n";
    const blocks = blocksOf(doc);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].from).toBe(doc.indexOf("| h |"));
  });

  it("finds several blocks of different kinds in order", () => {
    const doc = `${TABLE}\n$$a$$\n\n\`\`\`mermaid\ngraph LR\n\`\`\`\n`;
    expect(kindsOf(doc)).toEqual(["table", "math", "mermaid"]);
  });

  it("renders headings, quotes, lists and hr as fragment widgets", () => {
    expect(kindsOf("# Head\n")).toEqual(["prose"]);
    expect(kindsOf("> quote line\n> more\n")).toEqual(["prose"]);
    expect(kindsOf("- item one\n- item two\n")).toEqual(["prose"]);
    expect(kindsOf("above\n\n---\n\nbelow\n")).toEqual(["prose", "hr", "prose"]);
  });

  it("makes each block own its trailing newline and following blank lines", () => {
    const doc = "one\n\ntwo\n\nthree\n";
    const blocks = blocksOf(doc);
    expect(blocks.map((b) => [b.kind, b.from, b.to])).toEqual([
      ["prose", 0, doc.indexOf("two")],
      ["prose", doc.indexOf("two"), doc.indexOf("three")],
      ["prose", doc.indexOf("three"), doc.length],
    ]);
  });

  it("drops prose/code/hr widgets past the size guard but keeps tables", () => {
    const filler = "word ".repeat(41_000); // > ALL_BLOCK_LIMIT
    const doc = `${TABLE}${filler}`;
    const state = stateWith(doc, 0);
    ensureSyntaxTree(state, 10_000);
    expect(buildBlocks(state).map((b) => b.kind)).toEqual(["table"]);
  });
});

describe("extractDisplayMath", () => {
  it("extracts single and multi line tex", () => {
    expect(extractDisplayMath("$$a$$")).toBe("a");
    expect(extractDisplayMath("$$\nx\n$$")).toBe("x");
    expect(extractDisplayMath("$$\na\nb\n$$")).toBe("a\nb");
  });
  it("rejects paragraphs that do not open with $$ or never close", () => {
    expect(extractDisplayMath("text $$x$$")).toBeNull();
    expect(extractDisplayMath("$$\nunclosed")).toBeNull();
  });
});

describe("liveBlocks field", () => {
  it("rebuilds blocks on document changes and reuses them on selection-only changes", () => {
    const doc = `intro\n\n${TABLE}`;
    const state = stateWith(doc, 0);
    const before = state.field(liveBlocksField).blocks;

    const selectionTr = state.update({ selection: { anchor: 2 } });
    expect(selectionTr.state.field(liveBlocksField).blocks).toBe(before);

    const editTr = state.update({ changes: { from: 0, insert: "Hello " } });
    const after = editTr.state.field(liveBlocksField).blocks;
    expect(after).toHaveLength(before.length);
    // The edit merged into the opening paragraph, which now starts at 0…
    expect(after[0].from).toBe(0);
    expect(after[0].kind).toBe("prose");
    // …and every following block shifted by the inserted width.
    const lastBefore = before[before.length - 1];
    const lastAfter = after[after.length - 1];
    expect(lastAfter.from).toBe(lastBefore.from + 6);
    expect(lastAfter.to).toBe(lastBefore.to + 6);
    expect(lastAfter.kind).toBe(lastBefore.kind);
  });

  it("drops blocks whose text was deleted entirely", () => {
    const state = stateWith(TABLE, 0);
    const tr = state.update({ changes: { from: 0, to: TABLE.length, insert: "" } });
    expect(tr.state.field(liveBlocksField).blocks).toEqual([]);
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
    const doc = `before\n${TABLE}\nafter\n`;
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
    const doc = `before\n${TABLE}\nafter\n`;
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

  it("renders an inactive paragraph as reading-view HTML via render_fragment", async () => {
    const doc = "fragment-probe-one **bold**\n\nafter\n";
    const { view, dispose } = mount(doc, doc.length);
    try {
      const wrap = view.dom.querySelector<HTMLElement>(".rk-render-block");
      expect(wrap).not.toBeNull();
      expect(wrap?.classList.contains("md-body")).toBe(true);
      // The paragraph source goes to Rust verbatim, addressed to the doc dir.
      expect(renderFragment).toHaveBeenCalledWith("fragment-probe-one **bold**", "/ws/a.md");
      // The raw Markdown is hidden behind the widget even before HTML lands.
      expect(view.dom.textContent).not.toContain("**bold**");
      await vi.waitFor(() =>
        expect(wrap?.innerHTML).toBe('<div class="rk-fragment">fragment-probe-one **bold**</div>'),
      );
    } finally {
      dispose();
    }
  });

  it("reveals a paragraph's raw source when the cursor enters it", () => {
    const doc = "reveal-probe **bold**\n";
    const { view, dispose } = mount(doc, doc.length);
    try {
      view.dispatch({ selection: { anchor: 2 } });
      expect(view.dom.querySelector(".rk-render-block")).toBeNull();
      expect(view.dom.textContent).toContain("reveal-probe **bold**");
    } finally {
      dispose();
    }
  });

  it("keeps the following block rendered while the cursor sits on the blank line", () => {
    const doc = "blank-owner\n\nblank-next\n";
    const { view, dispose } = mount(doc, doc.indexOf("blank-next") - 1);
    try {
      // The blank line belongs to the preceding block: it reveals, the next
      // one stays rendered.
      expect(view.dom.querySelector(".rk-render-block")).not.toBeNull();
      expect(view.dom.textContent).toContain("blank-owner");
    } finally {
      dispose();
    }
  });

  it("moves the cursor to the paragraph start when its widget is clicked", () => {
    const doc = "click-target **x**\n";
    const { view, dispose } = mount(doc, doc.length);
    try {
      const wrap = view.dom.querySelector<HTMLElement>(".rk-render-block");
      expect(wrap).not.toBeNull();
      wrap?.dispatchEvent(
        new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true }),
      );
      expect(view.state.selection.main.anchor).toBe(0);
      expect(view.dom.querySelector(".rk-render-block")).toBeNull();
    } finally {
      dispose();
    }
  });

  it("sends fenced code through the fragment pipeline instead of line styling", () => {
    const doc = "```rust\nfn main() {}\n```\n\nafter\n";
    const { view, dispose } = mount(doc, doc.length);
    try {
      expect(view.dom.querySelector(".rk-render-block")).not.toBeNull();
      expect(renderFragment).toHaveBeenCalledWith("```rust\nfn main() {}\n```", "/ws/a.md");
    } finally {
      dispose();
    }
  });

  it("renders a horizontal rule locally without IPC", () => {
    const doc = "above\n\n---\n\nbelow\n";
    const { view, dispose } = mount(doc, doc.length);
    try {
      const wrap = view.dom.querySelector<HTMLElement>(".rk-render-hr");
      expect(wrap).not.toBeNull();
      expect(wrap?.querySelector("hr")).not.toBeNull();
      expect(renderFragment).not.toHaveBeenCalledWith("---", "/ws/a.md");
    } finally {
      dispose();
    }
  });

  it("serves a re-mounted block from the cache without a second IPC call", async () => {
    const doc = "cache-probe-unique **x**\n\nafter\n";
    const first = mount(doc, doc.length);
    try {
      await vi.waitFor(() =>
        expect(first.view.dom.querySelector(".rk-render-block")?.innerHTML).toContain(
          "rk-fragment",
        ),
      );
      const calls = renderFragment.mock.calls.filter((c) => c[0] === "cache-probe-unique **x**");
      expect(calls).toHaveLength(1);
      first.dispose();

      const second = mount(doc, doc.length);
      try {
        // Synchronous fill from the cache — the call count stays at one.
        expect(second.view.dom.querySelector(".rk-render-block")?.innerHTML).toContain(
          "rk-fragment",
        );
        expect(renderFragment.mock.calls.filter((c) => c[0] === "cache-probe-unique **x**")).toHaveLength(1);
      } finally {
        second.dispose();
      }
    } finally {
      first.dispose();
    }
  });

  it("shows the raw source when fragment rendering fails", async () => {
    renderFragment.mockRejectedValueOnce(new Error("backend down"));
    const doc = "fragment-fail-probe\n\nafter\n";
    const { view, dispose } = mount(doc, doc.length);
    try {
      const wrap = view.dom.querySelector<HTMLElement>(".rk-render-block");
      await vi.waitFor(() => expect(wrap?.classList.contains("rk-fragment-raw")).toBe(true));
      expect(wrap?.textContent).toBe("fragment-fail-probe");
    } finally {
      dispose();
    }
  });

  it("renders nested mermaid fences inside a fragment", async () => {
    renderFragment.mockResolvedValueOnce(
      '<pre><code class="language-mermaid">graph TD\nA--&gt;B</code></pre>',
    );
    const doc = "quote with a diagram\n\nafter\n";
    const { view, dispose } = mount(doc, doc.length);
    try {
      const wrap = await vi.waitFor(() => {
        const el = view.dom.querySelector<HTMLElement>(".rk-render-block");
        if (!el) throw new Error("widget not mounted");
        return el;
      });
      await vi.waitFor(() => expect(renderMermaidBlocks).toHaveBeenCalled());
      const calledOnWidget = renderMermaidBlocks.mock.calls.some(
        ([root]) => root === wrap,
      );
      expect(calledOnWidget).toBe(true);
    } finally {
      dispose();
    }
  });

  it("keeps the inline decorator out of rendered block ranges", () => {
    const doc = "| **a** | b |\n|---|---|\n| `c` | d |\n\n**after**\n";
    const { view, dispose } = mount(doc, doc.indexOf("after") + 1);
    try {
      // The cursor sits inside the trailing paragraph (revealed raw); the
      // table is the only range hidden behind a widget.
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

  it("compares fragment widgets by kind and source text", () => {
    expect(new FragmentWidget("prose", "a", 0).eq(new FragmentWidget("prose", "a", 9))).toBe(true);
    expect(new FragmentWidget("prose", "a", 0).eq(new FragmentWidget("prose", "b", 0))).toBe(
      false,
    );
    expect(new FragmentWidget("prose", "a", 0).eq(new FragmentWidget("code", "a", 0))).toBe(
      false,
    );
  });
});
