export type Mode = "read" | "edit" | "split";
export type EditorSide = "left" | "right";

const MIN_RATIO = 0.2;
const MAX_RATIO = 0.8;

/** Keep the editor pane within 20%-80% of the split area. */
export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
}

/** Config values may be absent or corrupt; never trust them. */
export function normalizeSide(raw: unknown): EditorSide {
  return raw === "right" ? "right" : "left";
}

export function normalizeRatio(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0.5;
  return clampRatio(raw);
}

export function flipSide(side: EditorSide): EditorSide {
  return side === "left" ? "right" : "left";
}

/** Ctrl+Tab cycles 阅读 → 分屏 → 源码 → 阅读. */
export function nextMode(mode: Mode): Mode {
  if (mode === "read") return "split";
  return mode === "split" ? "edit" : "read";
}

/**
 * Editor buffer after a mode switch. Entering an editing view from read
 * seeds it with the document text; moving between the two editing views
 * (edit↔split) keeps the live buffer so unsaved edits survive. Read mode
 * discards the buffer (callers save first).
 */
export function nextEditorText(
  next: Mode,
  prev: Mode,
  editText: string,
  docText: string,
): string {
  if (prev === "read" && next !== "read") return docText;
  return next === "read" ? docText : editText;
}
