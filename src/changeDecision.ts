import type { Mode } from "./split";

type FsChangeDecision = "ignore" | "prompt" | "reload";

/** Marker for a write this app just performed; fs events for the same file
 * before `until` are echoes of our own save, not external edits. */
export interface SelfSaveMark {
  path: string;
  /** Epoch ms until which the suppression window stays open. */
  until: number;
}

interface FsChangeInput {
  paths: string[];
  currentFile: string | null;
  mode: Mode;
  dirty: boolean;
  selfSave: SelfSaveMark | null;
  now: number;
}

/** Decide what a watcher event means for the currently open file:
 * - ignore: not about the open file, or an echo of our own save;
 * - prompt: external change while the user has unsaved edits (banner);
 * - reload: safe to refresh the document from disk. */
export function decideFsChange(input: FsChangeInput): FsChangeDecision {
  const current = input.currentFile;
  if (!current) return "ignore";
  if (!input.paths.some((p) => p.toLowerCase() === current.toLowerCase())) {
    return "ignore";
  }
  const s = input.selfSave;
  if (
    s &&
    s.path.toLowerCase() === current.toLowerCase() &&
    input.now < s.until
  ) {
    return "ignore";
  }
  // edit and split both carry a live editor buffer that a silent reload
  // would clobber
  if (input.mode !== "read" && input.dirty) return "prompt";
  return "reload";
}
