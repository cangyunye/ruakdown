import { beforeEach, describe, expect, it, vi } from "vitest";
import { linkAtLine, openMarkdownLink } from "./links";
import { api } from "./ipc";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
  openPath: vi.fn(),
}));

vi.mock("./ipc", () => ({
  api: { resolveLink: vi.fn() },
}));

const mockedOpenUrl = vi.mocked(openUrl);
const mockedOpenPath = vi.mocked(openPath);
const mockedResolve = vi.mocked(api.resolveLink);

describe("openMarkdownLink routing (classifyLink)", () => {
  beforeEach(() => {
    mockedOpenUrl.mockReset();
    mockedOpenPath.mockReset();
    mockedResolve.mockReset();
  });

  it("routes web and mail links as external (browser)", async () => {
    await openMarkdownLink("https://example.com", ctx());
    expect(mockedOpenUrl).toHaveBeenCalledWith("https://example.com");
    await openMarkdownLink("mailto:a@b.c", ctx());
    expect(mockedOpenUrl).toHaveBeenCalledWith("mailto:a@b.c");
    await openMarkdownLink("HTTPS://EXAMPLE.COM", ctx());
    expect(mockedOpenUrl).toHaveBeenCalledTimes(3);
    expect(mockedResolve).not.toHaveBeenCalled();
  });

  it("routes fragment-only links as anchors", async () => {
    const scroll = vi.fn();
    vi.stubGlobal("document", {
      getElementById: vi.fn((id: string) => (id === "标题-1" ? { scrollIntoView: scroll } : null)),
    });
    try {
      await openMarkdownLink("#%E6%A0%87%E9%A2%98-1", ctx());
      expect(scroll).toHaveBeenCalled();
      expect(mockedResolve).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("routes everything else as local (resolve against the open file)", async () => {
    mockedResolve.mockResolvedValue({
      path: "/proj/docs/b.md",
      exists: true,
      inRoot: true,
      isMarkdown: true,
    });
    for (const href of ["./b.md", "../up/c.md", "/abs/path.md", "file:///C:/doc.md", "b.md#frag"]) {
      const openFile = vi.fn();
      await openMarkdownLink(href, {
        currentFile: "/proj/docs/a.md",
        root: "/proj",
        openFile,
        notify: vi.fn(),
      });
      expect(mockedResolve).toHaveBeenCalled();
    }
  });

  it("does nothing for empty or missing hrefs", async () => {
    await openMarkdownLink("", ctx());
    expect(mockedOpenUrl).not.toHaveBeenCalled();
    expect(mockedResolve).not.toHaveBeenCalled();
  });
});

describe("linkAtLine", () => {
  it("finds the link spanning the cursor", () => {
    const line = "see [doc](./b.md) here";
    expect(linkAtLine(line, 5)).toBe("./b.md");
    expect(linkAtLine(line, 9)).toBe("./b.md"); // inside ()
    expect(linkAtLine(line, 16)).toBe("./b.md"); // closing paren
    expect(linkAtLine(line, 17)).toBe("./b.md"); // immediately after
  });

  it("returns null when the cursor is outside any link", () => {
    const line = "see [doc](./b.md) here";
    expect(linkAtLine(line, 0)).toBeNull();
    expect(linkAtLine(line, 21)).toBeNull();
    expect(linkAtLine("no links at all", 3)).toBeNull();
  });

  it("picks the specific link when several share the line", () => {
    const line = "[a](1.md) text [b](2.md)";
    expect(linkAtLine(line, 1)).toBe("1.md");
    expect(linkAtLine(line, 22)).toBe("2.md");
  });
});

describe("openMarkdownLink", () => {
  beforeEach(() => {
    mockedOpenUrl.mockReset();
    mockedOpenPath.mockReset();
    mockedResolve.mockReset();
  });

  it("opens external links in the system browser", async () => {
    await openMarkdownLink("https://example.com", ctx());
    expect(mockedOpenUrl).toHaveBeenCalledWith("https://example.com");
    expect(mockedResolve).not.toHaveBeenCalled();
  });

  it("scrolls to anchors without touching the filesystem", async () => {
    const scroll = vi.fn();
    vi.stubGlobal("document", {
      getElementById: vi.fn((id: string) =>
        id === "标题-1" ? { scrollIntoView: scroll } : null,
      ),
    });
    try {
      await openMarkdownLink("#%E6%A0%87%E9%A2%98-1", ctx());
      expect(scroll).toHaveBeenCalled();
      expect(mockedResolve).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("opens in-project md links via openFile without changing the root", async () => {
    const openFile = vi.fn();
    mockedResolve.mockResolvedValue({
      path: "/proj/docs/b.md",
      exists: true,
      inRoot: true,
      isMarkdown: true,
    });
    await openMarkdownLink("b.md", { currentFile: "/proj/docs/a.md", root: "/proj", openFile, notify: vi.fn() });
    expect(mockedResolve).toHaveBeenCalledWith("/proj/docs/a.md", "b.md", "/proj");
    expect(openFile).toHaveBeenCalledWith("/proj/docs/b.md");
    expect(mockedOpenPath).not.toHaveBeenCalled();
  });

  it("opens out-of-project md links the same way (tree untouched)", async () => {
    const openFile = vi.fn();
    mockedResolve.mockResolvedValue({
      path: "/elsewhere/c.md",
      exists: true,
      inRoot: false,
      isMarkdown: true,
    });
    await openMarkdownLink("../../elsewhere/c.md", { currentFile: "/proj/docs/a.md", root: "/proj", openFile, notify: vi.fn() });
    expect(openFile).toHaveBeenCalledWith("/elsewhere/c.md");
  });

  it("strips fragments, opens the file, then jumps to the anchor", async () => {
    const scroll = vi.fn();
    vi.stubGlobal("document", {
      getElementById: vi.fn((id: string) => (id === "sec" ? { scrollIntoView: scroll } : null)),
    });
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => cb());
    const openFile = vi.fn();
    mockedResolve.mockResolvedValue({
      path: "/proj/b.md",
      exists: true,
      inRoot: true,
      isMarkdown: true,
    });
    try {
      await openMarkdownLink("b.md#sec", { currentFile: "/proj/a.md", root: "/proj", openFile, notify: vi.fn() });
      expect(openFile).toHaveBeenCalledWith("/proj/b.md");
      expect(scroll).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("hands non-markdown existing files to the system default app", async () => {
    mockedResolve.mockResolvedValue({
      path: "/proj/img.png",
      exists: true,
      inRoot: true,
      isMarkdown: false,
    });
    await openMarkdownLink("img.png", ctx());
    expect(mockedOpenPath).toHaveBeenCalledWith("/proj/img.png");
  });

  it("notifies when the target does not exist", async () => {
    const notify = vi.fn();
    mockedResolve.mockResolvedValue({
      path: "/proj/ghost.md",
      exists: false,
      inRoot: true,
      isMarkdown: true,
    });
    await openMarkdownLink("ghost.md", ctx("/proj/a.md", "/proj", notify));
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("/proj/ghost.md"));
  });

  it("notifies when there is no open document for a relative link", async () => {
    const notify = vi.fn();
    await openMarkdownLink("b.md", ctx(null, null, notify));
    expect(notify).toHaveBeenCalled();
    expect(mockedResolve).not.toHaveBeenCalled();
  });
});

function ctx(currentFile: string | null = "/proj/a.md", root: string | null = "/proj", notify = vi.fn()) {
  return { currentFile, root, openFile: vi.fn(), notify };
}
