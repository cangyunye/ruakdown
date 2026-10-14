import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { api } from "./ipc";

type LinkKind = "external" | "anchor" | "local";

/** Pure routing decision for a markdown link href. */
function classifyLink(href: string | null | undefined): LinkKind | null {
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
  /** Anchor jump routing: the split view maps the id onto its virtualized
   * block table (unmounted chunks have no DOM to scroll to). True = handled;
   * false falls through to the plain `getElementById` lookup. */
  jumpAnchor?: (id: string) => boolean;
  /** An anchor whose target does not exist yet — typically a cross-file jump
   * whose preview is still building. The app retries it as the new preview
   * (or doc) lands. */
  anchorPending?: (id: string) => void;
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
    scrollToAnchor(decodeSafe(href.trim().slice(1)), ctx);
    return;
  }
  // Local target: strip file:// and any trailing #fragment.
  let target = href.trim();
  if (target.toLowerCase().startsWith("file://")) target = target.slice(7);
  const hashIdx = target.indexOf("#");
  const fragment = hashIdx >= 0 ? decodeSafe(target.slice(hashIdx + 1)) : null;
  if (hashIdx >= 0) target = target.slice(0, hashIdx);
  if (!target) {
    if (fragment) scrollToAnchor(fragment, ctx);
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
      // Arm the pending anchor before the doc switches so the retry effect
      // (which fires when the new preview lands) owns the jump.
      if (fragment) ctx.anchorPending?.(fragment);
      await ctx.openFile(r.path);
      if (fragment) {
        // Wait for the render commit, then jump (same trick as search hits).
        requestAnimationFrame(() =>
          requestAnimationFrame(() => scrollToAnchor(fragment, ctx)),
        );
      }
    } else {
      await openPath(r.path);
    }
  } catch (err) {
    ctx.notify("打开链接失败: " + String(err));
  }
}

/** Jump to a heading id: the app's block-table routing first (split view),
 * then the plain DOM lookup; a miss arms the pending retry. */
function scrollToAnchor(id: string, ctx: OpenLinkCtx): void {
  if (!id) return;
  if (ctx.jumpAnchor?.(id)) return;
  const el = document.getElementById(id);
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  ctx.anchorPending?.(id);
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
