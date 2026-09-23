/** Pure helpers for the Quick Open modal (recent files + filename search). */
import type { TreeNode } from "./ipc";

/** A filename hit in the current folder tree. */
export interface FileHit {
  name: string;
  path: string;
  /** Parent directory path, for display. */
  dir: string;
}

/** Insert `path` at the front of `recent`, de-duplicated and capped. */
export function upsertRecent(path: string, recent: string[], cap = 15): string[] {
  return [path, ...recent.filter((p) => p !== path)].slice(0, cap);
}

/** History entries whose full path contains `query` (case-insensitive),
 *  preserving recency order. An empty query keeps the whole history. */
export function rankRecent(query: string, recent: string[]): string[] {
  if (!query) return recent;
  const needle = query.toLowerCase();
  return recent.filter((p) => p.toLowerCase().includes(needle));
}

/** Parent directory of a path (handles both separators). */
function parentDir(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx > 0 ? path.slice(0, idx) : "";
}

/** Files in the folder tree whose name contains `query` (case-insensitive). */
export function matchTree(query: string, tree: TreeNode[]): FileHit[] {
  const needle = query.toLowerCase();
  const out: FileHit[] = [];
  const walk = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      if (n.isDir) walk(n.children);
      else if (n.name.toLowerCase().includes(needle)) {
        out.push({ name: n.name, path: n.path, dir: parentDir(n.path) });
      }
    }
  };
  walk(tree);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
