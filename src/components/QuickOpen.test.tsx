import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TreeNode } from "../ipc";
import QuickOpen from "./QuickOpen";

const tree: TreeNode[] = [
  {
    name: "docs",
    path: "/root/docs",
    isDir: true,
    children: [
      { name: "guide.md", path: "/root/docs/guide.md", isDir: false, children: [] },
    ],
  },
  { name: "readme.md", path: "/root/readme.md", isDir: false, children: [] },
];

function setup(over: Partial<Parameters<typeof QuickOpen>[0]> = {}) {
  const props = {
    root: "/root",
    recent: [] as string[],
    tree,
    onClose: vi.fn(),
    onOpenFile: vi.fn(),
    onOpenHit: vi.fn(),
    ...over,
  };
  render(<QuickOpen {...props} />);
  return props;
}

describe("QuickOpen", () => {
  it("lists recent files when the query is empty", () => {
    setup({ recent: ["/docs/notes.md"] });
    expect(screen.getByText("notes.md")).toBeInTheDocument();
  });

  it("matches filenames from the folder tree as you type", () => {
    setup({ recent: [] });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "readme" } });
    expect(screen.getByText("readme.md")).toBeInTheDocument();
  });

  it("opens the selected file on Enter", () => {
    const props = setup({ recent: ["/docs/notes.md"] });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(props.onOpenFile).toHaveBeenCalledWith("/docs/notes.md");
  });

  it("toggles content mode via the button, which shows the other mode", () => {
    setup({ recent: ["/docs/notes.md"] });
    fireEvent.click(screen.getByText("内容"));
    expect(screen.getByPlaceholderText("搜索当前目录内容…")).toBeInTheDocument();
    fireEvent.click(screen.getByText("历史"));
    expect(screen.getByPlaceholderText("快速打开 — 输入文件名")).toBeInTheDocument();
  });
});
