/**
 * Heading id → source line mapping for the source-mode outline jump.
 *
 * The renderer (core/markdown.rs) allocates heading ids with a GitHub-style
 * slug + duplicate counter. The editor side has no DOM anchors, so the same
 * allocation is replayed over the buffer lines: the k-th ATX heading gets
 * the slug of its text, duplicates get `-1`, `-2`, …
 *
 * Best-effort by design: headings whose rendered text differs from their
 * raw line (setext underlines, inline HTML, image-only titles) can produce
 * no id or a divergent one; callers treat a miss as "no jump".
 */

/** Heading id → 1-based line number for ATX headings in `doc`. */
export function headingLineById(doc: string): Map<string, number> {
  const map = new Map<string, number>();
  const seen = new Map<string, number>();
  const lines = doc.split("\n");
  let i = 0;
  // Frontmatter (leading `---` … closing `---`/`...`) never renders headings,
  // but its comment lines can look like ATX headings — skip the whole block.
  if ((lines[0] ?? "").trimEnd() === "---") {
    for (i = 1; i < lines.length; i++) {
      const t = lines[i].trim();
      if (t === "---" || t === "...") {
        i += 1;
        break;
      }
    }
  }
  for (; i < lines.length; i++) {
    const m = /^ {0,3}(#{1,6})(\s+.*)?$/.exec(lines[i]);
    if (!m) continue;
    // Text the renderer sees: closing sequence stripped (CommonMark), inline
    // code/emphasis markers dropped (pulldown emits only their contents).
    const text = (m[2] ?? "")
      .trimEnd()
      .replace(/\s+#+\s*$/, "")
      .replace(/[`*]/g, "")
      .trim();
    map.set(allocateSlug(seen, text), i + 1);
  }
  return map;
}

/** The Rust HeadingSlugger: slugified text, duplicates suffixed -1, -2, … */
function allocateSlug(seen: Map<string, number>, text: string): string {
  let base = slugify(text);
  if (base === "") base = "heading";
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  return n === 0 ? base : `${base}-${n}`;
}

/** Mirror of core/markdown.rs `slugify`: ASCII alnum lowercased, other
 * alphanumeric (CJK etc.) kept, everything else collapsed to one `-`,
 * leading/trailing dashes trimmed. */
function slugify(text: string): string {
  let slug = "";
  let lastDash = true;
  for (const ch of text) {
    if (/[a-z0-9]/i.test(ch)) {
      slug += ch.toLowerCase();
      lastDash = false;
    } else if (/\p{Alphabetic}|\p{Number}/u.test(ch)) {
      slug += ch;
      lastDash = false;
    } else if (!lastDash) {
      slug += "-";
      lastDash = true;
    }
  }
  return slug.replace(/^-+|-+$/g, "");
}
