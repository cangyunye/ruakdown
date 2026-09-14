/** After opening a file from search results, scroll the rendered document to
 * the first occurrence of `query` and flash-highlight it. Best-effort: does
 * nothing when the text is not present (edit mode, unmounted chunks, …). */
export function scrollToText(container: Element | null, query: string): void {
  if (!container || !query) return;
  const needle = query.toLowerCase();
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue ?? "";
    const idx = text.toLowerCase().indexOf(needle);
    if (idx === -1) continue;
    flashRange(node as Text, idx, query.length);
    return;
  }
}

function flashRange(node: Text, start: number, length: number): void {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, Math.min(start + length, node.nodeValue?.length ?? start));

  // Wrap the exact match when the range sits inside one text node (it always
  // does here); md-body content is rendered via dangerouslySetInnerHTML, so
  // this foreign node is replaced wholesale on the next document load.
  let target: Element;
  try {
    const mark = document.createElement("mark");
    mark.className = "search-jump-mark";
    range.surroundContents(mark);
    target = mark;
  } catch {
    const parent = node.parentElement;
    if (!parent) return;
    parent.classList.add("search-jump-flash");
    target = parent;
  }
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  window.setTimeout(() => {
    if (target.classList.contains("search-jump-mark")) {
      target.replaceWith(...target.childNodes);
    } else {
      target.classList.remove("search-jump-flash");
    }
  }, 2000);
}
