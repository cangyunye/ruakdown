/** Bookkeeping core for saveDoc: in-flight serialization plus the dirty-flag
 * arbitration for edits typed while a write is in progress. Kept free of
 * React so the race timings can be unit-tested directly.
 *
 * The bug this guards against: a save starts writing version A, the user
 * types B during the write, and the completion handler clears the dirty
 * flag unconditionally — B then looks saved, the status dot goes clean and
 * the queued autosave bails, so B never reaches disk. Completion must only
 * clear the flag when the buffer still holds exactly what was written. */

export type SaveCoordinator = {
  /** Claim a save slot. False when the buffer is clean, or when a write is
   * already in flight — the request is then coalesced into one follow-up
   * save (taken via takeFollowUp after the current write settles). */
  begin: () => boolean;
  /** Write resolved successfully. Clears the dirty flag only when the live
   * buffer still equals what was written; returns false otherwise (the flag
   * stays on and the caller should arm a follow-up autosave). Also releases
   * the slot and wakes flush() waiters. */
  complete: (savedText: string) => boolean;
  /** Write failed: keep the dirty flag (the next input or Ctrl+S retries)
   * and release the slot. */
  fail: () => void;
  /** True once if a request was coalesced while a write was in flight. */
  takeFollowUp: () => boolean;
  /** Resolves when no write is in flight (immediately when idle). */
  flush: () => Promise<void>;
};

type Box<T> = { current: T };

export function createSaveCoordinator(
  dirtyRef: Box<boolean>,
  bufferText: () => string,
  onDirtyChange: (dirty: boolean) => void,
): SaveCoordinator {
  let saving = false;
  let wantAgain = false;
  const flushWaiters = new Set<() => void>();

  const release = () => {
    saving = false;
    for (const wake of flushWaiters) wake();
    flushWaiters.clear();
  };

  return {
    begin() {
      if (saving) {
        if (dirtyRef.current) wantAgain = true;
        return false;
      }
      if (!dirtyRef.current) return false;
      saving = true;
      return true;
    },

    complete(savedText) {
      release();
      if (bufferText() !== savedText) return false;
      dirtyRef.current = false;
      onDirtyChange(false);
      return true;
    },

    fail() {
      release();
    },

    takeFollowUp() {
      const v = wantAgain;
      wantAgain = false;
      return v;
    },

    flush() {
      return new Promise<void>((resolve) => {
        if (!saving) {
          resolve();
        } else {
          flushWaiters.add(resolve);
        }
      });
    },
  };
}
