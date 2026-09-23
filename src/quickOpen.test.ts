import { describe, expect, it } from "vitest";
import type { TreeNode } from "./ipc";
import { matchTree, rankRecent, upsertRecent } from "./quickOpen";

describe("upsertRecent", () => {
  it("adds a path to an empty history", () => {
    expect(upsertRecent("/docs/a.md", [])).toEqual(["/docs/a.md"]);
  });

  it("moves an existing path to the front and drops the duplicate", () => {
    expect(upsertRecent("/b.md", ["/a.md", "/b.md", "/c.md"])).toEqual([
      "/b.md",
      "/a.md",
      "/c.md",
    ]);
  });

  it("caps the history length", () => {
    const recent = Array.from({ length: 15 }, (_, i) => `/f${i}.md`);
    const next = upsertRecent("/new.md", recent);
    expect(next).toHaveLength(15);
    expect(next[0]).toBe("/new.md");
    expect(next).not.toContain("/f14.md");
  });
});

describe("rankRecent", () => {
  it("returns the history unchanged for an empty query", () => {
    expect(rankRecent("", ["/a.md", "/b.md"])).toEqual(["/a.md", "/b.md"]);
  });

  it("matches case-insensitively anywhere in the path, keeping recency order", () => {
    const recent = ["/docs/notes.md", "/other.md", "/Notes/old.md"];
    expect(rankRecent("NOTES", recent)).toEqual(["/docs/notes.md", "/Notes/old.md"]);
  });
});

const tree: TreeNode[] = [
  {
    name: "docs",
    path: "/root/docs",
    isDir: true,
    children: [
      { name: "guide.md", path: "/root/docs/guide.md", isDir: false, children: [] },
      { name: "notes.md", path: "/root/docs/notes.md", isDir: false, children: [] },
    ],
  },
  { name: "readme.md", path: "/root/readme.md", isDir: false, children: [] },
];

describe("matchTree", () => {
  it("finds a file by name substring in a nested folder", () => {
    expect(matchTree("readme", tree)).toEqual([
      { name: "readme.md", path: "/root/readme.md", dir: "/root" },
    ]);
  });

  it("matches case-insensitively", () => {
    expect(matchTree("README", tree)).toEqual([
      { name: "readme.md", path: "/root/readme.md", dir: "/root" },
    ]);
  });

  it("returns every match, sorted by path even when the tree is unordered", () => {
    const unordered: TreeNode[] = [
      { name: "z.md", path: "/root/z.md", isDir: false, children: [] },
      { name: "a.md", path: "/root/a.md", isDir: false, children: [] },
    ];
    expect(matchTree("md", unordered).map((h) => h.path)).toEqual([
      "/root/a.md",
      "/root/z.md",
    ]);
  });
});
