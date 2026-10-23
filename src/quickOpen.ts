/** Pure helpers for the recent-files history and the Quick Open modal
 * (filename search). The recent list itself is consumed by Quick Open, the
 * title-bar 最近打开文件 section and the empty-state list. */
import type { TreeNode } from "./ipc";

/** A filename hit in the current folder tree. */
export interface FileHit {
  name: string;
  path: string;
  /** Parent directory path, for display. */
  dir: string;
}

/** How many recent files are kept and offered (Quick Open, title-bar menu
 * and the empty state all share one list). */
export const RECENT_CAP = 10;

/** Insert `path` at the front of `recent`, de-duplicated and capped. */
export function upsertRecent(path: string, recent: string[], cap = RECENT_CAP): string[] {
  return [path, ...recent.filter((p) => p !== path)].slice(0, cap);
}

/** Display model for a recent-files row: basename plus parent-folder hint. */
export interface RecentEntry {
  path: string;
  name: string;
  dir: string;
}

function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx > 0 ? path.slice(idx + 1) : path;
}

/** Immediate parent folder *name* (not the full path) — the display hint
 * shared with Quick Open rows. */
function parentName(path: string): string {
  const parts = path.split(path.includes("\\") ? "\\" : "/");
  return parts.length < 2 ? "" : parts[parts.length - 2];
}

/** The first `max` recent paths with display fields precomputed — consumed
 * by the title-bar 最近打开文件 section and the empty-state list. */
export function recentEntries(recent: string[], max = RECENT_CAP): RecentEntry[] {
  return recent.slice(0, max).map((p) => ({
    path: p,
    name: basename(p),
    dir: parentName(p),
  }));
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
