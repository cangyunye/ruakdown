import { describe, expect, it } from "vitest";
import {
  clampRatio,
  flipSide,
  nextEditorText,
  nextMode,
  normalizeRatio,
  normalizeSide,
  normalizeStartupMode,
} from "./split";

describe("clampRatio", () => {
  it("keeps values inside the 20%-80% band", () => {
    expect(clampRatio(0.5)).toBe(0.5);
    expect(clampRatio(0.05)).toBe(0.2);
    expect(clampRatio(0.95)).toBe(0.8);
  });

  it("falls back to 50% for garbage input", () => {
    expect(clampRatio(Number.NaN)).toBe(0.5);
    expect(clampRatio(Number.POSITIVE_INFINITY)).toBe(0.5);
  });
});

describe("normalize helpers", () => {
  it("normalizes the stored side", () => {
    expect(normalizeSide("left")).toBe("left");
    expect(normalizeSide("right")).toBe("right");
    expect(normalizeSide("bogus")).toBe("left");
    expect(normalizeSide(null)).toBe("left");
  });

  it("normalizes the stored ratio", () => {
    expect(normalizeRatio(0.7)).toBe(0.7);
    expect(normalizeRatio(3)).toBe(0.8);
    expect(normalizeRatio(null)).toBe(0.5);
    expect(normalizeRatio("0.4")).toBe(0.5);
  });

  it("flips the side", () => {
    expect(flipSide("left")).toBe("right");
    expect(flipSide(flipSide("left"))).toBe("left");
  });
});

describe("nextMode", () => {
  it("cycles read → live → split → edit → read", () => {
    expect(nextMode("read")).toBe("live");
    expect(nextMode("live")).toBe("split");
    expect(nextMode("split")).toBe("edit");
    expect(nextMode("edit")).toBe("read");
  });
});

describe("nextEditorText", () => {
  it("seeds the buffer from the document when leaving read mode", () => {
    expect(nextEditorText("split", "read", "stale", "doc")).toBe("doc");
    expect(nextEditorText("edit", "read", "stale", "doc")).toBe("doc");
  });

  it("keeps the live buffer between the two editing views", () => {
    expect(nextEditorText("split", "edit", "live edits", "doc")).toBe("live edits");
    expect(nextEditorText("edit", "split", "live edits", "doc")).toBe("live edits");
  });

  it("does not matter for read (callers save first)", () => {
    expect(nextEditorText("read", "split", "live", "doc")).toBe("doc");
    expect(nextEditorText("read", "edit", "live", "doc")).toBe("doc");
  });

  it("treats live as an editing view", () => {
    expect(nextEditorText("live", "read", "stale", "doc")).toBe("doc");
    expect(nextEditorText("edit", "live", "live edits", "doc")).toBe("live edits");
  });
});

describe("normalizeStartupMode", () => {
  it("accepts the four modes", () => {
    expect(normalizeStartupMode("read")).toBe("read");
    expect(normalizeStartupMode("live")).toBe("live");
    expect(normalizeStartupMode("split")).toBe("split");
    expect(normalizeStartupMode("edit")).toBe("edit");
  });

  it("falls back to read for missing or corrupt values", () => {
    expect(normalizeStartupMode(undefined)).toBe("read");
    expect(normalizeStartupMode(null)).toBe("read");
    expect(normalizeStartupMode("wysiwyg")).toBe("read");
    expect(normalizeStartupMode(3)).toBe("read");
  });
});
