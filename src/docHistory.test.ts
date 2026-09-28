import { describe, expect, it } from "vitest";
import {
  DOC_HISTORY_LIMIT,
  canGoBack,
  canGoForward,
  emptyHistory,
  popBack,
  popForward,
  pushVisit,
} from "./docHistory";

describe("pushVisit", () => {
  it("pushes the previous doc and voids the forward branch", () => {
    const h = pushVisit(pushVisit(emptyHistory(), null, "/a.md"), "/a.md", "/b.md");
    expect(h.back).toEqual(["/a.md"]);
    expect(h.forward).toEqual([]);

    const afterBack = popBack(h, "/b.md");
    // Current doc is now /a.md; a fresh jump from there voids the forward branch.
    const redo = pushVisit(afterBack.history, afterBack.target, "/c.md");
    expect(redo.forward).toEqual([]);
    expect(redo.back).toEqual(["/a.md"]);
  });

  it("ignores a first open (no previous doc) and same-doc reopens", () => {
    expect(pushVisit(emptyHistory(), null, "/a.md")).toEqual(emptyHistory());
    const h = pushVisit(emptyHistory(), "/a.md", "/a.md");
    expect(h).toEqual(emptyHistory());
  });

  it("evicts the oldest entry past the limit", () => {
    let h = emptyHistory();
    for (let i = 0; i <= DOC_HISTORY_LIMIT; i++) {
      h = pushVisit(h, `/${i}.md`, `/${i + 1}.md`);
    }
    expect(h.back.length).toBe(DOC_HISTORY_LIMIT);
    expect(h.back[0]).toBe("/1.md");
    expect(h.back[h.back.length - 1]).toBe(`/${DOC_HISTORY_LIMIT}.md`);
  });
});

describe("popBack / popForward", () => {
  it("swaps the current doc to the opposite stack", () => {
    let h = pushVisit(pushVisit(emptyHistory(), null, "/a.md"), "/a.md", "/b.md");

    const back = popBack(h, "/b.md");
    expect(back.target).toBe("/a.md");
    expect(back.history.back).toEqual([]);
    expect(back.history.forward).toEqual(["/b.md"]);

    const fwd = popForward(back.history, "/a.md");
    expect(fwd.target).toBe("/b.md");
    expect(fwd.history.back).toEqual(["/a.md"]);
    expect(fwd.history.forward).toEqual([]);
  });

  it("is a no-op with nothing to visit", () => {
    expect(popBack(emptyHistory(), "/a.md").target).toBeNull();
    expect(popForward(emptyHistory(), "/a.md").target).toBeNull();
    expect(popBack(emptyHistory(), null).target).toBeNull();
    expect(canGoBack(emptyHistory())).toBe(false);
    expect(canGoForward(emptyHistory())).toBe(false);
  });
});
