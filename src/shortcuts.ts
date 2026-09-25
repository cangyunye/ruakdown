import type { Mode } from "./split";

/** A global shortcut chord, normalized from a DOM KeyboardEvent. Only the
 * fields the router cares about are modelled; `altKey` is intentionally
 * ignored (same as the pre-existing handler's behaviour). */
export interface ShortcutKey {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  /** Modelled for completeness; deliberately ignored by the router. */
  altKey?: boolean;
  /** IME composition in progress (Chinese IMEs report key "Process") —
   * chords must never fire mid-composition. */
  isComposing?: boolean;
  /** Held-key auto-repeat — chords must never re-fire. */
  repeat?: boolean;
}

/** UI state the chord routing depends on. */
export interface ShortcutState {
  quickOpen: boolean;
  findOpen: boolean;
  settingsOpen: boolean;
  zenOn: boolean;
  fullscreenOn: boolean;
  /** A document is open (view-mode cycling needs one). */
  hasDoc: boolean;
  /** Current view mode — zen section navigation only applies in the reader. */
  mode: Mode;
}

export type ShortcutAction =
  | "search"
  | "quick-open"
  | "zen"
  | "fullscreen"
  | "find"
  | "replace"
  | "reload"
  | "mode-cycle"
  | "open-folder"
  | "open-file"
  | "save"
  | "export-html"
  | "zen-next"
  | "zen-prev"
  | "zen-exit"
  | "exit-fullscreen";

/**
 * Map a keydown event to a global shortcut action, or null when the chord is
 * not a shortcut (or must be suppressed by IME/repeat/UI state). This is the
 * capture-phase fallback that keeps every chord working on Windows, where the
 * native menu accelerators do not fire while the webview has focus — without
 * it Ctrl+O / Ctrl+Shift+O / Ctrl+S / Ctrl+E (and the search/zen chords)
 * would silently do nothing on Windows.
 *
 * macOS uses `⌘` for CmdOrCtrl chords (fullscreen and Ctrl+Tab excepted); the
 * matcher accepts either `ctrlKey` or `metaKey` as "mod" and special-cases the
 * two exceptions, so the exact same table drives both platforms.
 */
export function matchShortcut(
  e: ShortcutKey,
  s: ShortcutState,
): ShortcutAction | null {
  if (e.isComposing || e.repeat) return null;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();

  // Workspace content search: Ctrl/Cmd+Shift+F.
  if (mod && e.shiftKey && key === "f") return "search";
  // Quick Open: Ctrl/Cmd+P (intercepted from the webview print dialog).
  if (mod && !e.shiftKey && key === "p") return "quick-open";
  // Zen: Ctrl/Cmd+Shift+Z (would otherwise trigger editor redo).
  if (mod && e.shiftKey && key === "z" && !s.quickOpen && !s.settingsOpen) {
    return "zen";
  }
  // Fullscreen: F11 everywhere; Ctrl+Cmd+F follows the macOS convention.
  if (key === "f11" || (e.metaKey && e.ctrlKey && key === "f")) {
    return "fullscreen";
  }
  // In-document find/replace. Ctrl+R is remapped from the webview reload
  // (F5 reloads instead); Ctrl/Cmd+Shift+F stays the workspace search.
  if (mod && !e.shiftKey && key === "f" && !(e.metaKey && e.ctrlKey)) {
    return "find";
  }
  if (mod && !e.shiftKey && key === "r") return "replace";
  // Reload.
  if (key === "f5") return "reload";
  // View mode cycle: Ctrl+Tab (Cmd+Tab belongs to the OS).
  if (e.ctrlKey && key === "tab" && s.hasDoc && !s.quickOpen && !s.settingsOpen) {
    return "mode-cycle";
  }
  // Open folder / open file / save / export HTML. These mirror the native
  // menu, so — like the menu accelerators — they are not gated on UI state:
  // this keeps Windows (capture-phase fallback) aligned with macOS (menu
  // accelerators fire regardless of which panel is focused).
  if (mod && !e.shiftKey && key === "s") return "save";
  if (mod && !e.shiftKey && key === "e") return "export-html";
  if (mod && key === "o") return e.shiftKey ? "open-folder" : "open-file";
  // Zen section navigation: ←/→ or j/k jump between sections; Esc exits zen
  // first, then fullscreen (modals/panels consume their own Esc before both).
  const zenContext =
    s.zenOn && s.mode === "read" && !s.quickOpen && !s.findOpen && !s.settingsOpen;
  if (zenContext && key === "escape") return "zen-exit";
  if (zenContext && (key === "arrowright" || key === "j")) return "zen-next";
  if (zenContext && (key === "arrowleft" || key === "k")) return "zen-prev";
  // Esc exits fullscreen; zen/modals/panels consume their own Esc first.
  if (
    key === "escape" &&
    s.fullscreenOn &&
    !s.zenOn &&
    !s.quickOpen &&
    !s.findOpen &&
    !s.settingsOpen
  ) {
    return "exit-fullscreen";
  }
  return null;
}