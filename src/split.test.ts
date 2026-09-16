import { describe, expect, it } from "vitest";
import {
  clampRatio,
  flipSide,
  MAX_RATIO,
  MIN_RATIO,
  nextEditorText,
  nextMode,
  normalizeRatio,
  normalizeSide,
} from "./split";

describe("clampRatio", () => {
  it("keeps values inside the 20%-80% band", () => {
    expect(clampRatio(0.5)).toBe(0.5);
    expect(clampRatio(0.05)).toBe(MIN_RATIO);
    expect(clampRatio(0.95)).toBe(MAX_RATIO);
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
    expect(normalizeRatio(3)).toBe(MAX_RATIO);
    expect(normalizeRatio(null)).toBe(0.5);
    expect(normalizeRatio("0.4")).toBe(0.5);
  });

  it("flips the side", () => {
    expect(flipSide("left")).toBe("right");
    expect(flipSide(flipSide("left"))).toBe("left");
  });
});

describe("nextMode", () => {
  it("cycles read → split → edit → read", () => {
    expect(nextMode("read")).toBe("split");
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
});
