/** Mirror of the Rust `BlockInfo` table: one entry per top-level markdown
 * block, ordered by `bi` and by `startLine` (both monotonic). */
export interface SyncBlock {
  bi: number;
  chunk: number;
  startLine: number;
  endLine: number;
  headingId: string | null;
}

/** Block containing (or nearest below) the given 1-based source line. */
export function blockAtLine(blocks: SyncBlock[], line: number): SyncBlock | null {
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
export function headingOwners(blocks: SyncBlock[]): (string | null)[] {
  const out: (string | null)[] = new Array(blocks.length);
  let current: string | null = null;
  for (let i = 0; i < blocks.length; i++) {
    const hid = blocks[i].headingId;
    if (hid) current = hid;
    out[i] = current;
  }
  return out;
}
