import { beforeEach, describe, expect, it } from "vitest";
import { clearRenderedMarks, markRenderedMatches, normalizeForRender } from "./readLocate";

describe("normalizeForRender", () => {
  it("strips inline emphasis markers", () => {
    expect(normalizeForRender("**bold**")).toBe("bold");
    expect(normalizeForRender("`code`")).toBe("code");
    expect(normalizeForRender("~~gone~~")).toBe("gone");
  });

  it("keeps link text and drops the url", () => {
    expect(normalizeForRender("[docs](https://x.y)")).toBe("docs");
    expect(normalizeForRender("![alt](img.png)")).toBe("alt");
  });

  it("strips leading heading and quote markers", () => {
    expect(normalizeForRender("## Title")).toBe("Title");
    expect(normalizeForRender("> quoted")).toBe("quoted");
  });
});

describe("markRenderedMatches", () => {
  let root: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    root = document.createElement("div");
    root.className = "md-body";
    document.body.appendChild(root);
  });

  it("marks every match and flags only the current one", () => {
    const source = "Hello world, the world awaits.";
    root.innerHTML = `<p>${source}</p>`;
    const matches = [
      { from: source.indexOf("world"), to: source.indexOf("world") + 5 },
      { from: source.lastIndexOf("world"), to: source.lastIndexOf("world") + 5 },
    ];

    markRenderedMatches(root, source, matches, 1, true);

    const marks = root.querySelectorAll("mark.search-rendered-mark");
    expect(marks).toHaveLength(2);
    expect(marks[0].classList.contains("current")).toBe(false);
    expect(marks[1].classList.contains("current")).toBe(true);
  });

  it("places a match whose source carries markdown markers", () => {
    root.innerHTML = "<p>Hello bold text.</p>";
    const source = "Hello **bold** text.";

    markRenderedMatches(root, source, [{ from: 6, to: 14 }], 0, true);

    const mark = root.querySelector("mark.search-rendered-mark.current");
    expect(mark?.textContent).toBe("bold");
  });

  it("clears marks and restores the original text", () => {
    root.innerHTML = "<p>Hello world.</p>";

    markRenderedMatches(root, "Hello world.", [{ from: 6, to: 11 }], 0, true);
    expect(root.querySelectorAll("mark.search-rendered-mark")).toHaveLength(1);

    clearRenderedMarks(root);
    expect(root.querySelectorAll("mark.search-rendered-mark")).toHaveLength(0);
    expect(root.textContent).toBe("Hello world.");
  });

  it("skips matches it cannot place in the rendered text", () => {
    root.innerHTML = "<p>nothing here</p>";

    markRenderedMatches(root, "absent phrase", [{ from: 0, to: 13 }], 0, true);

    expect(root.querySelectorAll("mark.search-rendered-mark")).toHaveLength(0);
  });
});
