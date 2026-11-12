import { isMarkdownPath } from "./fileOps";

/** First .md / .markdown file of a native drag-drop path list, or null when
 * the drag carries none. Plain-text drags arrive with an empty list (wry
 * emits Enter/Drop for those on macOS), so "no path" must stay silent. */
export function pickDroppedMarkdown(paths: string[]): string | null {
  return paths.find(isMarkdownPath) ?? null;
}
