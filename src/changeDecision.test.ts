import { describe, expect, it } from "vitest";
import { decideFsChange } from "./changeDecision";

// Structural alias from the (unexported) input type — keeps the test honest
// without forcing changeDecision to export internals.
type FsChangeInput = Parameters<typeof decideFsChange>[0];

const FILE = "/proj/docs/a.md";

function base(overrides: Partial<FsChangeInput> = {}): FsChangeInput {
  return {
    paths: [FILE],
    currentFile: FILE,
    mode: "read",
    dirty: false,
    selfSave: null,
    now: 10_000,
    ...overrides,
  };
}

describe("decideFsChange", () => {
  it("ignores events about other files", () => {
    expect(decideFsChange(base({ paths: ["/proj/docs/other.md"] }))).toBe("ignore");
  });

  it("matches the current file case-insensitively (Windows paths)", () => {
    expect(
      decideFsChange(base({ paths: ["/PROJ/DOCS/A.MD"], currentFile: "/proj/docs/a.md" })),
    ).toBe("reload");
  });

  it("ignores when no file is open", () => {
    expect(decideFsChange(base({ currentFile: null }))).toBe("ignore");
  });

  it("suppresses the echo of our own save inside the window", () => {
    const input = base({
      mode: "edit",
      dirty: true, // user kept typing after the save
      selfSave: { path: FILE, until: 11_500 },
      now: 10_400, // watcher debounce lands ~400ms after the write
    });
    expect(decideFsChange(input)).toBe("ignore");
  });

  it("stops suppressing once the window has expired", () => {
    const input = base({
      mode: "edit",
      dirty: true,
      selfSave: { path: FILE, until: 11_500 },
      now: 12_000,
    });
    expect(decideFsChange(input)).toBe("prompt");
  });

  it("does not suppress events for a different file than the one saved", () => {
    const input = base({
      selfSave: { path: "/proj/docs/other.md", until: 11_500 },
    });
    expect(decideFsChange(input)).toBe("reload");
  });

  it("prompts when there are unsaved edits in source mode", () => {
    expect(decideFsChange(base({ mode: "edit", dirty: true }))).toBe("prompt");
  });

  it("reloads silently when the editor has no unsaved edits", () => {
    expect(decideFsChange(base({ mode: "edit", dirty: false }))).toBe("reload");
    expect(decideFsChange(base({ mode: "read" }))).toBe("reload");
  });
});
