import { describe, expect, it } from "vitest";
import {
  escapeRegex,
  findAllMatches,
  replaceAt,
  replaceAll,
} from "./searchEngine";

// ─── escapeRegex ────────────────────────────────────────────────────

describe("escapeRegex", () => {
  it("escapes all special regex characters", () => {
    expect(escapeRegex(".*+?^${}()|[]\\")).toBe(
      "\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\",
    );
  });

  it("leaves plain text unchanged", () => {
    expect(escapeRegex("hello world")).toBe("hello world");
  });

  it("escapes mixed input correctly", () => {
    expect(escapeRegex("price: $10.00 (USD)")).toBe(
      "price: \\$10\\.00 \\(USD\\)",
    );
  });
});

// ─── findAllMatches ─────────────────────────────────────────────────

describe("findAllMatches — plain text", () => {
  it("returns empty for empty query", () => {
    expect(findAllMatches("hello", "", {})).toEqual([]);
  });

  it("finds all occurrences (case-insensitive by default)", () => {
    const matches = findAllMatches("Hello hello HELLO", "hello", {});
    expect(matches).toEqual([
      { from: 0, to: 5 },
      { from: 6, to: 11 },
      { from: 12, to: 17 },
    ]);
  });

  it("respects case sensitivity", () => {
    const matches = findAllMatches("Hello hello HELLO", "hello", {
      caseSensitive: true,
      regex: false,
      wholeWord: false,
    });
    expect(matches).toEqual([{ from: 6, to: 11 }]);
  });

  it("finds non-overlapping matches only", () => {
    const matches = findAllMatches("aaa", "aa", {});
    expect(matches).toEqual([{ from: 0, to: 2 }]);
  });

  it("handles no matches", () => {
    expect(findAllMatches("hello world", "xyz", {})).toEqual([]);
  });
});

describe("findAllMatches — whole word", () => {
  it("matches only whole words", () => {
    const matches = findAllMatches("cat category cats cat", "cat", {
      caseSensitive: false,
      regex: false,
      wholeWord: true,
    });
    expect(matches).toEqual([
      { from: 0, to: 3 },
      { from: 18, to: 21 },
    ]);
  });

  it("handles word at start and end of document", () => {
    const matches = findAllMatches("test", "test", {
      caseSensitive: false,
      regex: false,
      wholeWord: true,
    });
    expect(matches).toEqual([{ from: 0, to: 4 }]);
  });

  it("does not match partial words with underscores", () => {
    // \w includes underscore, so _cat_ should not match
    const matches = findAllMatches("_cat_ cat", "cat", {
      caseSensitive: false,
      regex: false,
      wholeWord: true,
    });
    expect(matches).toEqual([{ from: 6, to: 9 }]);
  });
});

describe("findAllMatches — regex", () => {
  it("supports basic regex patterns", () => {
    const matches = findAllMatches("foo123 bar456", "\\d+", {
      caseSensitive: false,
      regex: true,
      wholeWord: false,
    });
    expect(matches).toEqual([
      { from: 3, to: 6 },
      { from: 10, to: 13 },
    ]);
  });

  it("handles invalid regex gracefully (returns empty)", () => {
    expect(
      findAllMatches("hello", "[invalid", {
        caseSensitive: false,
        regex: true,
        wholeWord: false,
      }),
    ).toEqual([]);
  });

  it("handles zero-length matches without infinite loop", () => {
    const matches = findAllMatches("ab", "a*", {
      caseSensitive: false,
      regex: true,
      wholeWord: false,
    });
    // "a*" matches "a" at 0, empty at 1, empty at 2 (or similar)
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.length).toBeLessThan(100);
  });

  it("respects case sensitivity in regex mode", () => {
    const matches = findAllMatches("Hello hello", "hello", {
      caseSensitive: true,
      regex: true,
      wholeWord: false,
    });
    expect(matches).toEqual([{ from: 6, to: 11 }]);
  });
});

// ─── replaceAt ──────────────────────────────────────────────────────

describe("replaceAt", () => {
  const text = "foo bar foo baz foo";
  const matches = findAllMatches(text, "foo", {});

  it("replaces the match at the given index", () => {
    const result = replaceAt(text, matches, 0, "qux");
    expect(result.newText).toBe("qux bar foo baz foo");
  });

  it("replaces the last match", () => {
    const result = replaceAt(text, matches, 2, "qux");
    expect(result.newText).toBe("foo bar foo baz qux");
  });

  it("returns unchanged text for out-of-range index", () => {
    const result = replaceAt(text, matches, 5, "qux");
    expect(result.newText).toBe(text);
  });

  it("returns unchanged text for negative index", () => {
    const result = replaceAt(text, matches, -1, "qux");
    expect(result.newText).toBe(text);
  });

  it("handles empty replacement (deletion)", () => {
    const result = replaceAt(text, matches, 1, "");
    expect(result.newText).toBe("foo bar  baz foo");
  });
});

// ─── replaceAll ─────────────────────────────────────────────────────

describe("replaceAll", () => {
  it("replaces all matches at once", () => {
    const text = "foo bar foo baz foo";
    const matches = findAllMatches(text, "foo", {});
    expect(replaceAll(text, matches, "qux")).toBe("qux bar qux baz qux");
  });

  it("returns original text when no matches", () => {
    const text = "hello world";
    expect(replaceAll(text, [], "qux")).toBe(text);
  });

  it("handles replacement with special characters", () => {
    const text = "a b a";
    const matches = findAllMatches(text, "a", {});
    expect(replaceAll(text, matches, "$1")).toBe("$1 b $1");
  });

  it("handles empty replacement", () => {
    const text = "xaxbx";
    const matches = findAllMatches(text, "x", {});
    expect(replaceAll(text, matches, "")).toBe("ab");
  });
});

// ─── Integration: search + replace round-trip ──────────────────────

describe("search + replace integration", () => {
  it("replace at current index then re-search yields updated matches", () => {
    let text = "aaa bbb aaa";
    let matches = findAllMatches(text, "aaa", {});
    expect(matches.length).toBe(2);

    // Replace first match
    const r = replaceAt(text, matches, 0, "ccc");
    text = r.newText;

    // Re-search
    matches = findAllMatches(text, "aaa", {});
    expect(matches.length).toBe(1);
    expect(matches[0]).toEqual({ from: 8, to: 11 });
  });

  it("replace all then re-search yields no matches", () => {
    let text = "foo bar foo baz foo";
    const matches = findAllMatches(text, "foo", {});
    text = replaceAll(text, matches, "qux");

    const newMatches = findAllMatches(text, "foo", {});
    expect(newMatches.length).toBe(0);

    const quxMatches = findAllMatches(text, "qux", {});
    expect(quxMatches.length).toBe(3);
  });
});
