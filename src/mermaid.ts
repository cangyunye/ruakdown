/**
 * Mermaid rendering against the vendored `resources/mermaid.min.js` — the
 * same file the HTML export inlines and the LAN share page serves, so there
 * is exactly one mermaid copy in the app (no npm dependency, no version
 * drift). The vendored build is an esbuild IIFE that assigns
 * `globalThis.mermaid`; we inject a classic <script> pointing at the asset
 * protocol on first use and reuse the global afterwards.
 */

import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "./ipc";

/** The subset of the mermaid API this module relies on. */
interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  render(id: string, source: string): Promise<{ svg: string }>;
}

declare global {
  interface Window {
    mermaid?: MermaidApi;
  }
}

let loadPromise: Promise<MermaidApi> | null = null;
let initedTheme: string | null = null;
let renderSeq = 0;

/** Inject the vendored mermaid script once; resolves with the global API. */
function loadMermaid(): Promise<MermaidApi> {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  loadPromise ??= (async () => {
    const path = await api.mermaidAssetPath();
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = convertFileSrc(path);
      script.onload = () => resolve();
      script.onerror = () => {
        // Allow a retry after a transient failure (e.g. resource dir not
        // ready during dev hot reloads).
        loadPromise = null;
        script.remove();
        reject(new Error("内置 mermaid.min.js 加载失败"));
      };
      document.head.appendChild(script);
    });
    if (!window.mermaid) {
      loadPromise = null;
      throw new Error("mermaid 全局对象缺失:脚本已加载但未挂载 window.mermaid");
    }
    return window.mermaid;
  })();
  return loadPromise;
}

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
  const mermaid = await loadMermaid();
  if (initedTheme !== theme) {
    mermaid.initialize({
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
      const { svg } = await mermaid.render(id, source);
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
