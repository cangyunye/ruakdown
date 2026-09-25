import type { BlockInfo } from "./ipc";

/** Block containing (or nearest below) the given 1-based source line. */
export function blockAtLine(blocks: BlockInfo[], line: number): BlockInfo | null {
  if (blocks.length === 0) return null;
  if (line <= blocks[0].startLine) return blocks[0];
  let lo = 0;
  let hi = blocks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (blocks[mid].startLine <= line) lo = mid;
    else hi = mid - 1;
  }
  return blocks[lo];
}

export type SyncSource = "editor" | "preview";

export interface SyncLock {
  source: SyncSource;
  until: number;
}

export const SYNC_LOCK_MS = 150;

/**
 * Whether a scroll on `source` may drive the other pane right now. The lock
 * records the side that last drove a sync; echo scrolls on the *driven* pane
 * are ignored until it expires, while the driving side may keep scrolling.
 */
export function lockAllows(lock: SyncLock | null, source: SyncSource, now: number): boolean {
  if (!lock || now >= lock.until) return true;
  return lock.source === source;
}

/** For each block index, the nearest heading id at or above it — used to
 * keep the sidebar outline highlighted while scrolling either pane. */
export function headingOwners(blocks: BlockInfo[]): (string | null)[] {
  const out: (string | null)[] = new Array(blocks.length);
  let current: string | null = null;
  for (let i = 0; i < blocks.length; i++) {
    const hid = blocks[i].headingId;
    if (hid) current = hid;
    out[i] = current;
  }
  return out;
}

/** The block that must sit at the preview top after the next rebuild.
 * Both panes report their viewport top — the editor maps its top source line
 * to a block, the preview reports its own `data-bi` anchor. The preview's
 * report must be honored too: without it, an edit made right after scrolling
 * only the preview (whose editor follow-scroll is suppressed by the echo
 * lock) would rebuild the preview re-anchored to the editor's stale target —
 * usually the document top. */
export function nextSyncTarget(reported: number): number {
  return reported;
}

/** Clamp a sync target into a rebuilt preview's block table. PreviewPane
 * re-anchors to the target after every preview update, so the index must be
 * valid even when the edit shrank or regrew the document. */
export function clampSyncTarget(target: number, blockCount: number): number {
  if (blockCount <= 0) return 0;
  return Math.min(Math.max(0, target), blockCount - 1);
}
