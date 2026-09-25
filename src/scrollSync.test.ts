import { describe, expect, it } from "vitest";
import { blockAtLine, clampSyncTarget, headingOwners, lockAllows, nextSyncTarget, type SyncLock } from "./scrollSync";
import type { BlockInfo } from "./ipc";

function b(bi: number, startLine: number, endLine: number, headingId: string | null = null): BlockInfo {
  return { bi, chunk: Math.floor(bi / 3), startLine, endLine, headingId };
}

const BLOCKS: BlockInfo[] = [
  b(0, 1, 1, "intro-1"),
  b(1, 3, 4),
  b(2, 6, 7, "section-2"),
  b(3, 9, 10),
  b(4, 12, 15, "section-3"),
  b(5, 18, 20),
];

describe("blockAtLine", () => {
  it("returns null for an empty table", () => {
    expect(blockAtLine([], 1)).toBeNull();
  });

  it("clamps to the first block above the document start", () => {
    expect(blockAtLine(BLOCKS, 0)?.bi).toBe(0);
    expect(blockAtLine(BLOCKS, 1)?.bi).toBe(0);
    expect(blockAtLine(BLOCKS, 2)?.bi).toBe(0);
  });

  it("finds the block containing the line", () => {
    expect(blockAtLine(BLOCKS, 3)?.bi).toBe(1);
    expect(blockAtLine(BLOCKS, 4)?.bi).toBe(1);
    expect(blockAtLine(BLOCKS, 13)?.bi).toBe(4);
  });

  it("lands on the nearest block at or above for blank gaps", () => {
    expect(blockAtLine(BLOCKS, 5)?.bi).toBe(1);
    expect(blockAtLine(BLOCKS, 17)?.bi).toBe(4);
  });

  it("clamps past the end to the last block", () => {
    expect(blockAtLine(BLOCKS, 999)?.bi).toBe(5);
  });
});

describe("lockAllows", () => {
  it("allows everything without a lock", () => {
    expect(lockAllows(null, "preview", 1000)).toBe(true);
  });

  it("allows the driving side and blocks the driven side", () => {
    const lock: SyncLock = { source: "editor", until: 2000 };
    expect(lockAllows(lock, "editor", 1500)).toBe(true);
    expect(lockAllows(lock, "preview", 1500)).toBe(false);
  });

  it("expires", () => {
    const lock: SyncLock = { source: "editor", until: 2000 };
    expect(lockAllows(lock, "preview", 2000)).toBe(true);
    expect(lockAllows(lock, "preview", 2001)).toBe(true);
  });
});

describe("headingOwners", () => {
  it("carries the nearest heading above each block", () => {
    const owners = headingOwners(BLOCKS);
    expect(owners).toEqual([
      "intro-1",
      "intro-1",
      "section-2",
      "section-2",
      "section-3",
      "section-3",
    ]);
  });

  it("yields nulls before the first heading", () => {
    const owners = headingOwners([b(0, 1, 2), b(1, 4, 5, "h-1")]);
    expect(owners).toEqual([null, "h-1"]);
  });
});

describe("nextSyncTarget", () => {
  it("adopts the preview's top block after a preview-only scroll", () => {
    // Document opened, editor never scrolled → the target is the first block.
    let target = 0;
    // The user reads by scrolling ONLY the preview down to block 30. The
    // editor's follow-scroll is suppressed by the 150ms echo lock, so no
    // editor report arrives to overwrite the target — the preview's report
    // must. Before the fix this stayed 0, so the next edit-driven rebuild
    // snapped the preview back to the document top.
    target = nextSyncTarget(30);
    expect(target).toBe(30);
  });

  it("lets a later editor report override the preview target", () => {
    let target = nextSyncTarget(30);
    target = nextSyncTarget(45);
    expect(target).toBe(45);
  });
});

describe("clampSyncTarget", () => {
  it("keeps the target inside the rebuilt block table", () => {
    expect(clampSyncTarget(30, 60)).toBe(30);
    expect(clampSyncTarget(-5, 60)).toBe(0);
    expect(clampSyncTarget(99, 60)).toBe(59);
  });

  it("falls back to the first block when the document is empty", () => {
    expect(clampSyncTarget(30, 0)).toBe(0);
  });
});
