import type { TreeNode } from "./ipc";

/** Path helpers and validation for the sidebar file-tree context menu.
 * Pure string logic — the filesystem side lives in Rust (core/fsops.rs);
 * this module mirrors its name rules so bad input is caught inline before
 * an invoke round-trip. */

const SEPS = /[\\/]/;

export function pathBasename(p: string): string {
  return p.split(SEPS).pop() || p;
}

export function pathDirname(p: string): string {
  const parts = p.split(SEPS);
  parts.pop();
  return parts.join(p.includes("\\") ? "\\" : "/");
}

/** Join a directory and an entry name with the directory's own separator. */
export function pathJoin(dir: string, name: string): string {
  if (!dir) return name;
  const sep = dir.includes("\\") ? "\\" : "/";
  return dir.replace(/[\\/]+$/, "") + sep + name;
}

/** True when `p` lives directly under `root` (not equal, not outside). */
export function isInsideRoot(root: string, p: string): boolean {
  const norm = root.replace(/[\\/]+$/, "");
  if (!norm || p === norm) return false;
  return p.startsWith(norm + "\\") || p.startsWith(norm + "/");
}

/** Path of `p` relative to `root`; falls back to the basename when the
 * prefix doesn't match (e.g. a standalone file with a folder open). */
export function relativePathInRoot(root: string, p: string): string {
  const norm = root.replace(/[\\/]+$/, "");
  if (norm && p.startsWith(norm)) {
    const rest = p.slice(norm.length).replace(/^[\\/]+/, "");
    if (rest) return rest;
  }
  return pathBasename(p);
}

/** New-file input helper: "笔记" → "笔记.md", keeps explicit .markdown. */
export function ensureMdExt(name: string): string {
  return /\.(md|markdown)$/i.test(name) ? name : `${name}.md`;
}

/** Name without the .md / .markdown suffix (for search prefill). */
export function stemOf(name: string): string {
  return name.replace(/\.(md|markdown)$/i, "");
}

const RESERVED_STEMS = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

/** Mirror of Rust `fsops::validate_entry_name`, plus a case-insensitive
 * conflict check against the entry's siblings. Returns the error message,
 * or null when the name is acceptable. */
export function entryNameError(name: string, siblings: Iterable<string>): string | null {
  const n = name.trim();
  if (!n) return "名称不能为空";
  if (n === "." || n === "..") return "名称不能为 . 或 ..";
  if (/[\\/:*?"<>|]/.test(n)) return '名称不能包含 \\ / : * ? " < > | 字符';
  if (n.endsWith(".") || n.endsWith(" ")) return "名称不能以点或空格结尾";
  const stem = n.split(".")[0].toUpperCase();
  if (RESERVED_STEMS.has(stem)) return `${stem} 是 Windows 保留设备名`;
  const lower = n.toLowerCase();
  for (const s of siblings) {
    if (s.toLowerCase() === lower) return "已存在同名文件或文件夹";
  }
  return null;
}

export function findTreeNode(nodes: TreeNode[], path: string): TreeNode | null {
  for (const n of nodes) {
    if (n.path === path) return n;
    if (n.isDir) {
      const hit = findTreeNode(n.children, path);
      if (hit) return hit;
    }
  }
  return null;
}

/* ── Markdown link generation & pasted-asset naming ────────────────
 * Generation must mirror the *parsing* conventions: links and images are
 * resolved relative to the document's own directory (core/link.rs,
 * markdown.rs rewrite_img_srcs), so generated hrefs are doc-relative with
 * forward slashes — never the workspace-root-relative form used by
 * copyRelPath. */

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "bmp", "gif", "avif", "svg"]);

export function isImagePath(name: string): boolean {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return !!m && IMAGE_EXTS.has(m[1].toLowerCase());
}

/** Characters Windows forbids in names; also stripped from doc-name parts. */
const NAME_BAD = /[\\/:*?"<>|\u0000-\u001f]/g;

export function sanitizeNamePart(s: string): string {
  return s.replace(NAME_BAD, "").replace(/[. ]+$/g, "").trim();
}

/** Local-time yyyymmddHHMMSS token. */
export function tsToken(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** Asset stem = first 10 characters of the open document's name. */
export const ASSET_STEM_MAX = 10;
const ASSET_STEM_FALLBACK = "doc";

/** `{docname first 10 chars}_{yyyymmddHHMMSS}{ext}` — the on-disk asset
 * name. The extension (with dot, lowercased) comes from the source name. */
export function assetBaseName(
  docPath: string | null,
  srcName: string,
  now: Date = new Date(),
): string {
  let stem = ASSET_STEM_FALLBACK;
  if (docPath) {
    const base = pathBasename(docPath).replace(/\.(md|markdown)$/i, "");
    const sanitized = sanitizeNamePart(base);
    if (sanitized) stem = Array.from(sanitized).slice(0, ASSET_STEM_MAX).join("");
  }
  const dot = srcName.lastIndexOf(".");
  const ext = dot > 0 ? srcName.slice(dot).toLowerCase() : "";
  return `${stem}_${tsToken(now)}${ext}`;
}

/** Alt/label text for a generated tag: source stem minus brackets. */
export function linkLabel(srcName: string, fallback: string): string {
  const dot = srcName.lastIndexOf(".");
  const stem = dot > 0 ? srcName.slice(0, dot) : srcName;
  const cleaned = sanitizeNamePart(stem).replace(/[[\]]/g, "").trim();
  return cleaned || fallback;
}

/** Percent-encode only what breaks CommonMark destinations (spaces, brackets,
 * unbalanced parens, `#`/`%`/`?`…); CJK stays human-readable. */
const HREF_BAD = /[\u0000-\u001f\s"#%<>?[\]^`{|}\\()]/g;

function encodeHrefSegment(seg: string): string {
  // All HREF_BAD chars are ASCII, so a fixed %XX escape is exact — and
  // unlike encodeURIComponent it always escapes ( ) too, which matters for
  // unbalanced parens in CommonMark destinations.
  return seg.replace(HREF_BAD, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
}

/** Markdown href from `fromFile`'s directory to `toPath`: forward slashes,
 * `./`-prefixed when no `..` climb is needed, segment-encoded. Falls back
 * to an absolute forward-slash path across drives. */
export function relativeLinkHref(fromFile: string, toPath: string): string {
  const fromParts = pathDirname(fromFile).split(SEPS).filter(Boolean);
  const toParts = toPath.split(SEPS).filter(Boolean);
  if (
    fromParts.length === 0 ||
    toParts.length === 0 ||
    fromParts[0].toLowerCase() !== toParts[0].toLowerCase()
  ) {
    return toParts.map(encodeHrefSegment).join("/") || toPath;
  }
  let k = 0;
  while (
    k < fromParts.length &&
    k < toParts.length &&
    fromParts[k].toLowerCase() === toParts[k].toLowerCase()
  ) {
    k += 1;
  }
  const ups = fromParts.length - k;
  const downs = toParts.slice(k);
  if (downs.length === 0) {
    // Exact self-link; point at the file itself.
    return `./${encodeHrefSegment(toParts[toParts.length - 1])}`;
  }
  const rel = [...Array.from({ length: ups }, () => ".."), ...downs]
    .map(encodeHrefSegment)
    .join("/");
  return ups === 0 ? `./${rel}` : rel;
}

export function mdImageTag(alt: string, href: string): string {
  return `![${alt}](${href})`;
}

export function mdLinkTag(label: string, href: string): string {
  return `[${label}](${href})`;
}

/** Normalized assets folder relative to the workspace root ("assets" when
 * unset/blank); forward slashes, no leading/trailing separators. */
export function assetsRelDir(raw: string | null | undefined): string {
  const v = (raw ?? "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return v || "assets";
}

/** Where pasted/inserted assets are archived. Documents inside the open
 * workspace use the workspace-level assets dir; anything else (standalone
 * file, or a file outside the open folder) gets a sibling assets dir next
 * to the document — a root-based archive would force cross-tree `../`
 * climbs (or cross-drive absolute links) that render unreliably and leave
 * the assets behind when the folder is closed. Null when there is no
 * document to anchor to. */
export function assetDestDir(
  root: string | null,
  currentFile: string | null,
  assetsDir: string | null,
): string | null {
  if (!currentFile) return null;
  const rel = assetsRelDir(assetsDir);
  if (root && isInsideRoot(root, currentFile)) return pathJoin(root, rel);
  return pathJoin(pathDirname(currentFile), rel);
}
