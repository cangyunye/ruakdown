import { describe, expect, it } from "vitest";
import { headingLineById, outlineFromMarkdown, scanHeadings } from "./headingLocate";

describe("headingLineById", () => {
  it("maps basic, duplicate and CJK headings to 1-based lines", () => {
    const doc = "# One\n\ntext\n\n## 中文 标题\n\n## Two\n\n### Two\n";
    const map = headingLineById(doc);
    expect(map.get("one")).toBe(1);
    expect(map.get("中文-标题")).toBe(5);
    expect(map.get("two")).toBe(7);
    expect(map.get("two-1")).toBe(9);
  });

  it("strips the closing # sequence like CommonMark", () => {
    const map = headingLineById("## Close ##\n## not # a #close\n");
    expect(map.get("close")).toBe(1);
    expect(map.get("not-a-close")).toBe(2);
  });

  it("drops inline code and emphasis markers like the renderer", () => {
    const map = headingLineById("## `code` and *em*\n");
    expect(map.get("code-and-em")).toBe(1);
  });

  it("ignores headings inside the frontmatter block", () => {
    const doc = "---\nname: x\n# 注释\n---\n\n# Real\n";
    const map = headingLineById(doc);
    expect(map.has("注释")).toBe(false);
    expect(map.get("real")).toBe(6);
  });

  it("an empty heading text falls back to the 'heading' slug", () => {
    const map = headingLineById("## \n\n## \n");
    expect(map.get("heading")).toBe(1);
    expect(map.get("heading-1")).toBe(3);
  });

  it("rejects #tag without a space and indented-fence lookalikes", () => {
    const map = headingLineById("#tag\nx # y\n    # deep\n####### seven\n");
    expect(map.size).toBe(0);
  });

  it("up to six #s only, leading spaces tolerated", () => {
    const map = headingLineById(" ###### deep\n ####### no\n");
    expect(map.get("deep")).toBe(1);
    expect(map.size).toBe(1);
  });
});

describe("scanHeadings", () => {
  it("returns level, text, slug and 1-based line", () => {
    expect(scanHeadings("# 标题\n\n## 子标题\n")).toEqual([
      { level: 1, text: "标题", id: "标题", line: 1 },
      { level: 2, text: "子标题", id: "子标题", line: 3 },
    ]);
  });

  it("numbers duplicate slugs like the Rust renderer", () => {
    expect(scanHeadings("# A\n# A\n").map((h) => h.id)).toEqual(["a", "a-1"]);
  });

  it("skips frontmatter", () => {
    expect(scanHeadings("---\ntitle: x\n---\n# Real\n").map((h) => h.id)).toEqual([
      "real",
    ]);
  });
});

describe("outlineFromMarkdown", () => {
  it("drops line numbers for the sidebar outline", () => {
    expect(outlineFromMarkdown("# A\n")).toEqual([
      { level: 1, text: "A", id: "a" },
    ]);
  });
});
