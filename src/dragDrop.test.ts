import { describe, expect, it } from "vitest";
import { pickDroppedMarkdown } from "./dragDrop";

describe("pickDroppedMarkdown", () => {
  it("returns the first markdown path of the drop", () => {
    expect(pickDroppedMarkdown(["/docs/b.md", "/docs/a.md"])).toBe("/docs/b.md");
  });

  it("skips non-markdown entries and finds a later markdown one", () => {
    expect(pickDroppedMarkdown(["/docs/img.png", "/docs/notes.markdown"])).toBe(
      "/docs/notes.markdown",
    );
  });

  it("matches extensions case-insensitively", () => {
    expect(pickDroppedMarkdown(["/docs/Notes.MD"])).toBe("/docs/Notes.MD");
  });

  it("returns null for an empty list (text drag on macOS)", () => {
    expect(pickDroppedMarkdown([])).toBeNull();
  });

  it("returns null when no path is markdown", () => {
    expect(pickDroppedMarkdown(["/docs/report.pdf", "/docs/img.png"])).toBeNull();
  });
});
