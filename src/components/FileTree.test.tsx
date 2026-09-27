import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TreeNode } from "../ipc";
import { FileTree, type TreeDraft } from "./FileTree";

const tree: TreeNode[] = [
  {
    name: "sub",
    path: "F:\\v\\sub",
    isDir: true,
    children: [
      { name: "guide.md", path: "F:\\v\\sub\\guide.md", isDir: false, children: [] },
    ],
  },
  { name: "readme.md", path: "F:\\v\\readme.md", isDir: false, children: [] },
];

function setup(over: {
  draft?: TreeDraft | null;
  expanded?: Set<string>;
  activeFile?: string | null;
} = {}) {
  const props = {
    nodes: tree,
    rootPath: "F:\\v",
    activeFile: null,
    onOpenFile: vi.fn(),
    expanded: over.expanded ?? new Set<string>(),
    onToggle: vi.fn(),
    draft: over.draft ?? null,
    onCommitDraft: vi.fn(),
    onCancelDraft: vi.fn(),
    onNodeContextMenu: vi.fn(),
    ...over,
  };
  render(<FileTree {...props} />);
  return props;
}

describe("FileTree context menu + inline edit", () => {
  it("fires onNodeContextMenu with the node for rows", () => {
    const props = setup();
    fireEvent.contextMenu(screen.getByText("readme.md").closest("button")!);
    expect(props.onNodeContextMenu).toHaveBeenCalledTimes(1);
    const [e, node] = props.onNodeContextMenu.mock.calls[0];
    expect(node.path).toBe("F:\\v\\readme.md");
    expect(e).toBeDefined();
  });

  it("rename draft swaps the row for an input, prefilled with selection-ready text", () => {
    setup({ draft: { kind: "rename", targetPath: "F:\\v\\readme.md", initial: "readme.md" } });
    const input = screen.getByDisplayValue("readme.md") as HTMLInputElement;
    expect(input).toBeInTheDocument();
    // Base name (without extension) is pre-selected.
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("readme".length);
  });

  it("commits a valid rename on Enter", () => {
    const props = setup({
      draft: { kind: "rename", targetPath: "F:\\v\\readme.md", initial: "readme.md" },
    });
    const input = screen.getByDisplayValue("readme.md");
    fireEvent.change(input, { target: { value: "intro.md" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onCommitDraft).toHaveBeenCalledWith("intro.md");
  });

  it("blocks commits that collide with a sibling and flags the input", () => {
    const props = setup({
      draft: { kind: "rename", targetPath: "F:\\v\\readme.md", initial: "readme.md" },
    });
    const input = screen.getByDisplayValue("readme.md");
    fireEvent.change(input, { target: { value: "sub" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onCommitDraft).not.toHaveBeenCalled();
    expect(input).toHaveClass("invalid");
  });

  it("cancels the draft on Escape", () => {
    const props = setup({
      draft: { kind: "rename", targetPath: "F:\\v\\readme.md", initial: "readme.md" },
    });
    fireEvent.keyDown(screen.getByDisplayValue("readme.md"), { key: "Escape" });
    expect(props.onCancelDraft).toHaveBeenCalledTimes(1);
  });

  it("shows the new-file draft row at the root list", () => {
    setup({ draft: { kind: "new-file", parentDir: "F:\\v" } });
    expect(screen.getByPlaceholderText("文件名.md")).toBeInTheDocument();
  });

  it("renders the targeted folder expanded with its draft row", () => {
    setup({
      draft: { kind: "new-file", parentDir: "F:\\v\\sub" },
      expanded: new Set<string>(),
    });
    expect(screen.getByPlaceholderText("文件名.md")).toBeInTheDocument();
    // Children are visible because the draft targets this folder.
    expect(screen.getByText("guide.md")).toBeInTheDocument();
  });

  it("commits a new file name raw; the caller applies the .md extension", () => {
    const props = setup({ draft: { kind: "new-file", parentDir: "F:\\v\\sub" } });
    const input = screen.getByPlaceholderText("文件名.md");
    fireEvent.change(input, { target: { value: "笔记" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onCommitDraft).toHaveBeenCalledWith("笔记");
  });

  it("flags a new-file name that collides after adding the extension", () => {
    const props = setup({ draft: { kind: "new-file", parentDir: "F:\\v" } });
    const input = screen.getByPlaceholderText("文件名.md");
    fireEvent.change(input, { target: { value: "readme" } }); // readme.md exists
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onCommitDraft).not.toHaveBeenCalled();
    expect(input).toHaveClass("invalid");
  });
});
