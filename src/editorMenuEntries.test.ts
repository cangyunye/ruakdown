import { describe, expect, it } from "vitest";
import { buildEditorMenuEntries } from "./editorMenuEntries";

function ids(entries: ReturnType<typeof buildEditorMenuEntries>): string[] {
  return entries.filter((e) => e.type === "item").map((e) => (e as { id: string }).id);
}

describe("buildEditorMenuEntries", () => {
  it("context variant leads with clipboard + 新建子文档并引用", () => {
    const list = ids(buildEditorMenuEntries(true));
    expect(list.slice(0, 4)).toEqual(["cut", "copy", "paste", "new-subdoc"]);
    expect(list).toContain("table");
    expect(list).toContain("insert-asset");
  });

  it("slash variant drops clipboard and 新建子文档并引用", () => {
    const list = ids(buildEditorMenuEntries(false));
    for (const gone of ["cut", "copy", "paste", "new-subdoc"]) {
      expect(list).not.toContain(gone);
    }
    // The insertion surface matches the context menu's.
    for (const kept of ["h1", "h6", "ul", "ol", "task", "quote", "callout-NOTE", "callout-clear",
      "codeblock", "table", "hr", "mathblock", "mindmap", "link", "bold", "italic", "underline",
      "strike", "mark", "sup", "sub", "inlinecode", "kbd", "inlinemath",
      "insert-asset", "insert-image-link", "insert-iframe", "insert-video", "insert-audio"]) {
      expect(list).toContain(kept);
    }
  });

  it("no leading separator in the slash variant", () => {
    const entries = buildEditorMenuEntries(false);
    expect(entries[0].type).toBe("item");
  });

  it("callout entries carry their color dots", () => {
    const note = buildEditorMenuEntries(false).find(
      (e) => e.type === "item" && e.id === "callout-NOTE",
    ) as { icon?: string; color?: string };
    expect(note.icon).toBe("●");
    expect(note.color).toMatch(/^#/);
  });
});
