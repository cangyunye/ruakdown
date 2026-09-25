import { describe, expect, it } from "vitest";
import { matchShortcut, type ShortcutKey, type ShortcutState } from "./shortcuts";

function press(partial: Partial<ShortcutKey>): ShortcutKey {
  return { key: "", ctrlKey: false, metaKey: false, shiftKey: false, ...partial };
}

const idle: ShortcutState = {
  quickOpen: false,
  findOpen: false,
  settingsOpen: false,
  zenOn: false,
  fullscreenOn: false,
  hasDoc: true,
  mode: "read",
};

const modal: ShortcutState = { ...idle, quickOpen: true };
const fullscreen: ShortcutState = { ...idle, fullscreenOn: true };

describe("matchShortcut · Windows chords (Ctrl, no meta)", () => {
  const win = (key: string, shift = false) =>
    press({ key, ctrlKey: true, metaKey: false, shiftKey: shift });

  it("opens a folder with Ctrl+Shift+O", () => {
    expect(matchShortcut(win("o", true), idle)).toBe("open-folder");
  });

  it("opens a file with Ctrl+O", () => {
    expect(matchShortcut(win("o"), idle)).toBe("open-file");
  });

  it("saves with Ctrl+S", () => {
    expect(matchShortcut(win("s"), idle)).toBe("save");
  });

  it("exports HTML with Ctrl+E", () => {
    expect(matchShortcut(win("e"), idle)).toBe("export-html");
  });

  it("opens workspace search with Ctrl+Shift+F", () => {
    expect(matchShortcut(win("f", true), idle)).toBe("search");
  });

  it("opens quick open with Ctrl+P", () => {
    expect(matchShortcut(win("p"), idle)).toBe("quick-open");
  });

  it("toggles zen with Ctrl+Shift+Z", () => {
    expect(matchShortcut(win("z", true), idle)).toBe("zen");
  });

  it("enters fullscreen with F11", () => {
    expect(matchShortcut(press({ key: "F11" }), idle)).toBe("fullscreen");
  });

  it("opens in-document find with Ctrl+F", () => {
    expect(matchShortcut(win("f"), idle)).toBe("find");
  });

  it("opens replace with Ctrl+R", () => {
    expect(matchShortcut(win("r"), idle)).toBe("replace");
  });

  it("reloads the view with F5", () => {
    expect(matchShortcut(press({ key: "F5" }), idle)).toBe("reload");
  });

  it("cycles view modes with Ctrl+Tab", () => {
    expect(matchShortcut(press({ key: "Tab", ctrlKey: true }), idle)).toBe("mode-cycle");
  });
});

describe("matchShortcut · macOS chords (⌘/meta)", () => {
  const mac = (key: string, shift = false) =>
    press({ key, ctrlKey: false, metaKey: true, shiftKey: shift });

  it("maps ⌘+Shift+O → open-folder and ⌘+O → open-file", () => {
    expect(matchShortcut(mac("o", true), idle)).toBe("open-folder");
    expect(matchShortcut(mac("o"), idle)).toBe("open-file");
  });

  it("maps ⌘+S → save and ⌘+E → export-html", () => {
    expect(matchShortcut(mac("s"), idle)).toBe("save");
    expect(matchShortcut(mac("e"), idle)).toBe("export-html");
  });

  it("maps ⌘+Shift+F → search, ⌘+P → quick-open, ⌘+Shift+Z → zen", () => {
    expect(matchShortcut(mac("f", true), idle)).toBe("search");
    expect(matchShortcut(mac("p"), idle)).toBe("quick-open");
    expect(matchShortcut(mac("z", true), idle)).toBe("zen");
  });

  it("maps ⌘+F → find and ⌘+R → replace", () => {
    expect(matchShortcut(mac("f"), idle)).toBe("find");
    expect(matchShortcut(mac("r"), idle)).toBe("replace");
  });

  it("enters fullscreen with Ctrl+⌘+F (macOS convention), not find", () => {
    expect(matchShortcut(press({ key: "f", ctrlKey: true, metaKey: true }), idle)).toBe(
      "fullscreen",
    );
  });

  it("does not hijack ⌘+Tab (belongs to the OS)", () => {
    expect(matchShortcut(press({ key: "Tab", metaKey: true }), idle)).toBeNull();
  });
});

describe("matchShortcut · suppression and gating", () => {
  it("ignores IME composition and key auto-repeat", () => {
    expect(matchShortcut(press({ key: "s", ctrlKey: true, isComposing: true }), idle)).toBeNull();
    expect(matchShortcut(press({ key: "s", ctrlKey: true, repeat: true }), idle)).toBeNull();
  });

  it("returns null for plain keys and unknown chords", () => {
    expect(matchShortcut(press({ key: "a" }), idle)).toBeNull();
    expect(matchShortcut(press({ key: "o" }), idle)).toBeNull(); // no modifier
    expect(matchShortcut(press({ key: "z" }), idle)).toBeNull(); // no modifier
  });

  it("matches regardless of letter case", () => {
    expect(matchShortcut(press({ key: "O", ctrlKey: true }), idle)).toBe("open-file");
    expect(matchShortcut(press({ key: "S", ctrlKey: true }), idle)).toBe("save");
    expect(matchShortcut(press({ key: "E", ctrlKey: true }), idle)).toBe("export-html");
  });

  it("ignores Alt so Ctrl+Alt+chord still routes", () => {
    expect(matchShortcut(press({ key: "o", ctrlKey: true, altKey: true }), idle)).toBe(
      "open-file",
    );
  });

  it("keeps native-dialog chords (open/save/export) ungated like the native menu", () => {
    expect(matchShortcut(press({ key: "o", ctrlKey: true }), modal)).toBe("open-file");
    expect(matchShortcut(press({ key: "o", ctrlKey: true, shiftKey: true }), modal)).toBe(
      "open-folder",
    );
    expect(matchShortcut(press({ key: "s", ctrlKey: true }), modal)).toBe("save");
    expect(matchShortcut(press({ key: "e", ctrlKey: true }), modal)).toBe("export-html");
  });

  it("suppresses zen toggle and view cycling while quick open / settings are open", () => {
    expect(matchShortcut(press({ key: "z", ctrlKey: true, shiftKey: true }), modal)).toBeNull();
    expect(matchShortcut(press({ key: "Tab", ctrlKey: true }), modal)).toBeNull();
    expect(matchShortcut(press({ key: "z", ctrlKey: true, shiftKey: true }), { ...idle, settingsOpen: true })).toBeNull();
  });

  it("keeps workspace search triggerable even while a modal is open (matches native menu)", () => {
    expect(matchShortcut(press({ key: "f", ctrlKey: true, shiftKey: true }), modal)).toBe(
      "search",
    );
  });

  it("requires a document for view-mode cycling", () => {
    expect(matchShortcut(press({ key: "Tab", ctrlKey: true }), { ...idle, hasDoc: false })).toBeNull();
  });

  it("only exits fullscreen with Esc when fullscreen is active and nothing else owns Esc", () => {
    expect(matchShortcut(press({ key: "Escape" }), fullscreen)).toBe("exit-fullscreen");
    expect(matchShortcut(press({ key: "Escape" }), idle)).toBeNull(); // not fullscreen
    // Zen consumes Esc first (逐层退出:专注 → 全屏).
    expect(matchShortcut(press({ key: "Escape" }), { ...fullscreen, zenOn: true })).toBe(
      "zen-exit",
    );
    expect(matchShortcut(press({ key: "Escape" }), { ...fullscreen, quickOpen: true })).toBeNull();
    expect(matchShortcut(press({ key: "Escape" }), { ...fullscreen, findOpen: true })).toBeNull();
    expect(matchShortcut(press({ key: "Escape" }), { ...fullscreen, settingsOpen: true })).toBeNull();
  });
});

describe("matchShortcut · zen navigation and Esc layering", () => {
  const zen: ShortcutState = { ...idle, zenOn: true, mode: "read" };

  it("maps ←/→ and j/k to zen section navigation", () => {
    expect(matchShortcut(press({ key: "ArrowRight" }), zen)).toBe("zen-next");
    expect(matchShortcut(press({ key: "j" }), zen)).toBe("zen-next");
    expect(matchShortcut(press({ key: "ArrowLeft" }), zen)).toBe("zen-prev");
    expect(matchShortcut(press({ key: "k" }), zen)).toBe("zen-prev");
  });

  it("exits zen with Esc before falling through to fullscreen exit", () => {
    expect(matchShortcut(press({ key: "Escape" }), zen)).toBe("zen-exit");
    expect(matchShortcut(press({ key: "Escape" }), fullscreen)).toBe("exit-fullscreen");
    // 逐层退出:专注 → 全屏
    expect(matchShortcut(press({ key: "Escape" }), { ...zen, fullscreenOn: true })).toBe(
      "zen-exit",
    );
  });

  it("only navigates while zen is on and the reader is active", () => {
    expect(matchShortcut(press({ key: "j" }), idle)).toBeNull(); // zen off
    expect(matchShortcut(press({ key: "j" }), { ...idle, zenOn: true, mode: "split" })).toBeNull();
    expect(matchShortcut(press({ key: "ArrowRight" }), { ...zen, quickOpen: true })).toBeNull();
    expect(matchShortcut(press({ key: "ArrowRight" }), { ...zen, findOpen: true })).toBeNull();
    expect(matchShortcut(press({ key: "ArrowRight" }), { ...zen, settingsOpen: true })).toBeNull();
  });
});