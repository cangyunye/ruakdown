/** Zen (focus) reading mode: wrap a rendered markdown body into sections and
 * keep the section occupying the viewport's middle band highlighted. */

export type ZenLevel = "auto" | "h1" | "h2" | "h3";

const LEVEL_TAGS = ["h1", "h2", "h3"] as const;
type ZenTag = (typeof LEVEL_TAGS)[number];

/** Mark-syntax support: wrap ==text== into <mark>. Skips pre/code/checkbox
 * and existing marks, so it is safe to run repeatedly after each render. */
export function applyMarkSyntax(container: HTMLElement): void {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = (node as Text).parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest("pre, code, mark, textarea")) {
        return NodeFilter.FILTER_REJECT;
      }
      return node.nodeValue && node.nodeValue.includes("==")
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });
  // Collect first: replacing nodes while walking would skip siblings.
  const hits: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    hits.push(n as Text);
  }
  for (const node of hits) {
    const text = node.nodeValue ?? "";
    const pattern = /==([^=\n][^=\n]*?)==/;
    if (!pattern.test(text)) continue;
    const frag = document.createDocumentFragment();
    let rest = text;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(rest))) {
      if (m.index > 0) frag.appendChild(document.createTextNode(rest.slice(0, m.index)));
      const mark = document.createElement("mark");
      mark.textContent = m[1];
      frag.appendChild(mark);
      rest = rest.slice(m.index + m[0].length);
    }
    if (rest) frag.appendChild(document.createTextNode(rest));
    node.parentNode?.replaceChild(frag, node);
  }
}

function countHeadings(container: HTMLElement): Record<ZenTag, number> {
  const counts: Record<ZenTag, number> = { h1: 0, h2: 0, h3: 0 };
  for (const el of container.children) {
    const tag = el.tagName.toLowerCase();
    if (tag === "h1" || tag === "h2" || tag === "h3") counts[tag]++;
  }
  return counts;
}

/** Resolve the heading tag to split on. "auto" picks the shallowest level
 * with at least two headings; an explicit level needs two headings too —
 * a single section would leave nothing to focus. Returns null when unusable. */
function resolveZenTag(container: HTMLElement, level: ZenLevel): ZenTag | null {
  const counts = countHeadings(container);
  if (level === "auto") {
    for (const tag of LEVEL_TAGS) {
      if (counts[tag] >= 2) return tag;
    }
    return null;
  }
  return counts[level] >= 2 ? level : null;
}

/** Split on the chosen heading level. Content before the first heading
 * becomes its own section so it dims with the rest. Returns null when the
 * document cannot be split (fewer than two headings at the target level). */
export function wrapZenSections(container: HTMLElement, level: ZenLevel): ZenTag | null {
  const tag = resolveZenTag(container, level);
  if (!tag) return null;
  unwrapZenSections(container);
  let section: HTMLElement | null = null;
  for (const el of Array.from(container.children)) {
    if (!section || el.tagName.toLowerCase() === tag) {
      section = document.createElement("section");
      section.className = "zen-section";
      container.insertBefore(section, el);
    }
    section.appendChild(el);
  }
  return tag;
}

export function unwrapZenSections(container: HTMLElement): void {
  for (const sec of Array.from(container.querySelectorAll<HTMLElement>(":scope > .zen-section"))) {
    while (sec.firstChild) container.insertBefore(sec.firstChild, sec);
    sec.remove();
  }
}

function zenSections(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(":scope > .zen-section"));
}

/** Index of the section covering `y` in container coordinates, nearest
 * otherwise. Returns -1 when there are no sections. */
function zenSectionAt(container: HTMLElement, y: number): number {
  const sections = zenSections(container);
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < sections.length; i++) {
    const top = sections[i].offsetTop;
    const bottom = top + sections[i].offsetHeight;
    if (y >= top && y < bottom) return i;
    const dist = y < top ? top - y : y - bottom;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

export interface ZenController {
  stop: () => void;
  /** Jump to a section and lock it as the active one — needed when the
   * scroll position clamps (last section shorter than the viewport), where
   * the middle-band heuristic would otherwise keep the previous section lit. */
  jumpTo: (index: number) => void;
}

/** Keep the section at the viewport middle band marked active; reports the
 * position (0-based index, total) through `onPos`. Returns a controller. */
export function trackZenFocus(
  container: HTMLElement,
  onPos: (pos: { idx: number; total: number } | null) => void,
): ZenController {
  let raf = 0;
  let lockUntil = 0;
  const sections = () => zenSections(container);

  const update = () => {
    raf = 0;
    const list = sections();
    if (list.length === 0) {
      onPos(null);
      return;
    }
    if (Date.now() < lockUntil) return;
    const middle = container.scrollTop + container.clientHeight * 0.45;
    const idx = Math.max(0, zenSectionAt(container, middle));
    list.forEach((s, i) => s.classList.toggle("zen-active", i === idx));
    onPos({ idx, total: list.length });
  };
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(update);
  };

  const jumpTo = (index: number) => {
    const list = sections();
    if (list.length === 0) return;
    const idx = Math.max(0, Math.min(index, list.length - 1));
    container.scrollTop = list[idx].offsetTop;
    list.forEach((s, i) => s.classList.toggle("zen-active", i === idx));
    onPos({ idx, total: list.length });
    // Ignore the scroll event caused by the jump itself.
    lockUntil = Date.now() + 400;
  };

  container.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  update();
  return {
    stop: () => {
      if (raf) cancelAnimationFrame(raf);
      container.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    },
    jumpTo,
  };
}
