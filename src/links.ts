import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { api } from "./ipc";

export type LinkKind = "external" | "anchor" | "local";

/** Pure routing decision for a markdown link href. */
export function classifyLink(href: string | null | undefined): LinkKind | null {
  if (!href) return null;
  const h = href.trim();
  if (!h) return null;
  const lower = h.toLowerCase();
  if (
    lower.startsWith("http://") ||
    lower.startsWith("https://") ||
    lower.startsWith("mailto:")
  ) {
    return "external";
  }
  if (h.startsWith("#")) return "anchor";
  return "local";
}

/** Extract the `url` of a `[text](url)` span containing character `col`. */
export function linkAtLine(lineText: string, col: number): string | null {
  const re = /\[([^\]\n]*)\]\(([^()\s]+)\)/g;
  for (const m of lineText.matchAll(re)) {
    const start = m.index ?? 0;
    if (col >= start && col <= start + m[0].length) return m[2];
  }
  return null;
}

export interface OpenLinkCtx {
  /** Path of the currently open document (relative links resolve against it). */
  currentFile: string | null;
  /** Opened project folder; only feeds the informational in-root flag. */
  root: string | null;
  openFile: (path: string) => Promise<void>;
  /** Show a transient banner message. */
  notify: (msg: string) => void;
}

/** Act on a clicked markdown link: browser for web URLs, in-app open for
 * md files (never touching the opened folder tree), system default app for
 * other local files, smooth scroll for same-document anchors. */
export async function openMarkdownLink(
  href: string,
  ctx: OpenLinkCtx,
): Promise<void> {
  const kind = classifyLink(href);
  if (!kind) return;
  if (kind === "external") {
    await openUrl(href.trim());
    return;
  }
  if (kind === "anchor") {
    scrollToAnchor(decodeSafe(href.trim().slice(1)));
    return;
  }
  // Local target: strip file:// and any trailing #fragment.
  let target = href.trim();
  if (target.toLowerCase().startsWith("file://")) target = target.slice(7);
  const hashIdx = target.indexOf("#");
  const fragment = hashIdx >= 0 ? decodeSafe(target.slice(hashIdx + 1)) : null;
  if (hashIdx >= 0) target = target.slice(0, hashIdx);
  if (!target) {
    if (fragment) scrollToAnchor(fragment);
    return;
  }
  if (!ctx.currentFile) {
    ctx.notify("未打开文档,无法跳转相对链接");
    return;
  }
  try {
    const r = await api.resolveLink(ctx.currentFile, target, ctx.root);
    if (!r.exists) {
      ctx.notify(`链接目标不存在: ${r.path}`);
      return;
    }
    if (r.isMarkdown) {
      await ctx.openFile(r.path);
      if (fragment) {
        // Wait for the render commit, then jump (same trick as search hits).
        requestAnimationFrame(() =>
          requestAnimationFrame(() => scrollToAnchor(fragment)),
        );
      }
    } else {
      await openPath(r.path);
    }
  } catch (err) {
    ctx.notify("打开链接失败: " + String(err));
  }
}

function scrollToAnchor(id: string): void {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
