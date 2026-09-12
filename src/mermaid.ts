type MermaidModule = typeof import("mermaid");

let mod: MermaidModule["default"] | null = null;
let initedTheme: string | null = null;
let renderSeq = 0;

// Rendered SVG cache keyed by source+theme, so evicted chunks re-mount
// instantly when the user scrolls back.
const svgCache = new Map<string, string>();
const CACHE_CAP = 40;

function cacheKey(source: string, theme: string): string {
  let h = 5381;
  for (let i = 0; i < source.length; i++) {
    h = (((h << 5) + h) ^ source.charCodeAt(i)) | 0;
  }
  return `${theme}:${(h >>> 0).toString(36)}`;
}

/**
 * Render every ```mermaid code block inside `root` into an SVG.
 * The <pre> stays in the DOM (hidden) as the source of truth so blocks can be
 * re-rendered when the theme changes; stale containers are removed first.
 */
export async function renderMermaidBlocks(root: HTMLElement, dark: boolean) {
  const theme = dark ? "dark" : "default";
  if (!mod) {
    mod = (await import("mermaid")).default;
  }
  if (initedTheme !== theme) {
    mod.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme,
      fontFamily: "inherit",
    });
    initedTheme = theme;
  }

  root.querySelectorAll(".mermaid-block").forEach((el) => el.remove());

  const codes = root.querySelectorAll<HTMLElement>("pre > code.language-mermaid");
  for (const code of Array.from(codes)) {
    const pre = code.parentElement;
    if (!pre) continue;
    const source = code.textContent ?? "";
    const container = document.createElement("div");
    container.className = "mermaid-block";
    pre.after(container);

    const key = cacheKey(source, theme);
    const cached = svgCache.get(key);
    if (cached) {
      container.innerHTML = cached;
      pre.hidden = true;
      continue;
    }

    const id = `mermaid-svg-${Date.now()}-${renderSeq++}`;
    try {
      const { svg } = await mod.render(id, source);
      container.innerHTML = svg;
      pre.hidden = true;
      if (svgCache.size >= CACHE_CAP) {
        const oldest = svgCache.keys().next().value;
        if (oldest !== undefined) svgCache.delete(oldest);
      }
      svgCache.set(key, svg);
    } catch (err) {
      container.innerHTML = "";
      const box = document.createElement("pre");
      box.className = "mermaid-error";
      box.textContent = "Mermaid 渲染失败: " + String(err);
      container.appendChild(box);
      pre.hidden = false;
    }
  }
}
