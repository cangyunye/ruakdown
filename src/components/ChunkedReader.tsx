import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { api, type ChunkedMeta } from "../ipc";
import { renderMermaidBlocks } from "../mermaid";

export interface ChunkedReaderHandle {
  jumpTo: (id: string) => void;
}

interface Props {
  meta: ChunkedMeta;
  path: string;
  dark: boolean;
  onActiveHeading: (id: string | null) => void;
}

const BACK_CHUNKS = 2;
const AHEAD_CHUNKS = 3;
const KEEP_MARGIN = 6; // eviction window beyond the loaded band
const MAX_INFLIGHT = 8;
const ACTIVE_UPDATE_MS = 120;

interface State {
  heights: number[];
  loaded: boolean[];
  els: (HTMLDivElement | null)[];
  inflight: Set<number>;
  pendingJump: string | null;
  lastScrollTop: number;
  lastTime: number;
  vel: number; // px/ms, smoothed
  raf: number | null;
  activeId: string | null;
  lastActiveUpdate: number;
  disposed: boolean;
}

/**
 * Virtualized reader for large documents: every chunk is a placeholder div
 * sized by estimate; chunks near the viewport are fetched from Rust and
 * mounted, far ones are evicted back to placeholders. Scroll position is
 * re-anchored whenever a chunk above the viewport changes height.
 */
const ChunkedReader = forwardRef<ChunkedReaderHandle, Props>(function ChunkedReader(
  { meta, path, dark, onActiveHeading },
  ref,
) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const st = useRef<State>({
    heights: [],
    loaded: [],
    els: [],
    inflight: new Set(),
    pendingJump: null,
    lastScrollTop: 0,
    lastTime: 0,
    vel: 0,
    raf: null,
    activeId: null,
    lastActiveUpdate: 0,
    disposed: false,
  });
  const darkRef = useRef(dark);
  darkRef.current = dark;
  const activeCbRef = useRef(onActiveHeading);
  activeCbRef.current = onActiveHeading;

  function chunkTop(index: number): number {
    let sum = 0;
    const h = st.current.heights;
    for (let i = 0; i < index && i < h.length; i++) sum += h[i];
    return sum;
  }

  function firstVisibleIndex(scrollTop: number): number {
    let acc = 0;
    const h = st.current.heights;
    for (let i = 0; i < h.length; i++) {
      if (acc + h[i] > scrollTop) return i;
      acc += h[i];
    }
    return Math.max(0, h.length - 1);
  }

  function mountChunk(index: number, html: string) {
    const el = st.current.els[index];
    if (!el) return;
    el.innerHTML = html;
    el.classList.remove("placeholder");
    el.style.height = "";
    st.current.loaded[index] = true;

    const measured = el.getBoundingClientRect().height;
    const old = st.current.heights[index];
    if (Math.abs(measured - old) > 1) {
      st.current.heights[index] = measured;
      const sc = scrollRef.current;
      if (sc && index < firstVisibleIndex(sc.scrollTop)) {
        sc.scrollTop += measured - old;
      }
    }
    if (meta.chunks[index]?.hasMermaid) {
      void renderMermaidBlocks(el, darkRef.current);
    }
    if (st.current.pendingJump != null) {
      const target = meta.outline.find(
        (o) => o.id === st.current.pendingJump && o.chunk === index,
      );
      if (target) {
        st.current.pendingJump = null;
        requestAnimationFrame(() => {
          document.getElementById(target.id)?.scrollIntoView({ block: "start" });
        });
      }
    }
  }

  function unloadChunk(index: number) {
    const el = st.current.els[index];
    if (!el || !st.current.loaded[index]) return;
    el.innerHTML = "";
    el.classList.add("placeholder");
    el.style.height = st.current.heights[index] + "px";
    st.current.loaded[index] = false;
  }

  function requestChunks(indices: number[]) {
    const want = indices.filter(
      (i) =>
        i >= 0 &&
        i < meta.chunkCount &&
        !st.current.loaded[i] &&
        !st.current.inflight.has(i),
    );
    const budget = MAX_INFLIGHT - st.current.inflight.size;
    const picked = want.slice(0, Math.max(0, budget));
    // group contiguous indices into single batched requests
    let i = 0;
    while (i < picked.length) {
      const run = [picked[i]];
      while (i + 1 < picked.length && picked[i + 1] === picked[i] + run.length) {
        run.push(picked[i + 1]);
        i++;
      }
      i++;
      const start = run[0];
      for (const idx of run) st.current.inflight.add(idx);
      api
        .renderChunks(meta.token, start, run.length)
        .then((chunks) => {
          if (st.current.disposed) return;
          for (const c of chunks) {
            st.current.inflight.delete(c.index);
            mountChunk(c.index, c.html);
          }
        })
        .catch(() => {
          if (st.current.disposed) return;
          for (const idx of run) st.current.inflight.delete(idx);
        });
    }
  }

  function headingOffsetTop(id: string): number | null {
    for (let i = 0; i < st.current.els.length; i++) {
      if (!st.current.loaded[i]) continue;
      const el = st.current.els[i];
      if (!el) continue;
      const target = el.querySelector(`[id="${cssEscape(id)}"]`);
      if (target) return (target as HTMLElement).offsetTop;
    }
    return null;
  }

  function cssEscape(s: string): string {
    return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s.replace(/"/g, '\\"');
  }

  function updateActiveHeading(scrollTop: number) {
    const now = performance.now();
    if (now - st.current.lastActiveUpdate < ACTIVE_UPDATE_MS) return;
    st.current.lastActiveUpdate = now;

    // Start from the first outline item at/after the visible chunk to keep the
    // scan short on huge outlines.
    const visChunk = firstVisibleIndex(scrollTop);
    let startIdx = 0;
    {
      let lo = 0;
      let hi = meta.outline.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (meta.outline[mid].chunk < visChunk) lo = mid + 1;
        else hi = mid - 1;
      }
      startIdx = lo;
    }

    let active: string | null = null;
    for (let i = startIdx; i < meta.outline.length; i++) {
      const o = meta.outline[i];
      if (o.chunk > visChunk + 1) break;
      const inChunk = headingOffsetTop(o.id);
      const top = chunkTop(o.chunk) + (inChunk ?? 0);
      if (top <= scrollTop + 96) active = o.id;
      else break;
    }
    if (active !== st.current.activeId) {
      st.current.activeId = active;
      activeCbRef.current(active);
    }
  }

  function update() {
    const sc = scrollRef.current;
    if (!sc || st.current.disposed) return;
    const now = performance.now();
    const dt = now - st.current.lastTime;
    const dy = sc.scrollTop - st.current.lastScrollTop;
    st.current.lastTime = now;
    st.current.lastScrollTop = sc.scrollTop;
    if (dt > 0 && dt < 200) {
      st.current.vel = st.current.vel * 0.7 + (Math.abs(dy) / dt) * 0.3;
    } else if (dt >= 200) {
      st.current.vel = Math.abs(dy) / dt;
    }

    const first = firstVisibleIndex(sc.scrollTop);
    const last = firstVisibleIndex(sc.scrollTop + sc.clientHeight);
    const boost = Math.min(6, Math.floor(st.current.vel / 3));
    const from = Math.max(0, first - BACK_CHUNKS);
    const to = Math.min(meta.chunkCount - 1, last + AHEAD_CHUNKS + boost);

    const want: number[] = [];
    for (let i = from; i <= to; i++) {
      if (!st.current.loaded[i]) want.push(i);
    }
    if (want.length > 0) requestChunks(want);

    const keepFrom = Math.max(0, first - KEEP_MARGIN);
    const keepTo = Math.min(meta.chunkCount - 1, last + KEEP_MARGIN + boost);
    for (let i = 0; i < meta.chunkCount; i++) {
      if (st.current.loaded[i] && (i < keepFrom || i > keepTo)) unloadChunk(i);
    }

    updateActiveHeading(sc.scrollTop);
  }

  function onScroll() {
    if (st.current.raf != null) return;
    st.current.raf = requestAnimationFrame(() => {
      st.current.raf = null;
      update();
    });
  }

  useImperativeHandle(ref, () => ({
    jumpTo: (id: string) => {
      const item = meta.outline.find((o) => o.id === id);
      if (!item) return;
      if (st.current.loaded[item.chunk]) {
        document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
      } else {
        st.current.pendingJump = id;
        requestChunks([item.chunk]);
      }
    },
  }));

  useEffect(() => {
    st.current.disposed = false;
    const inner = innerRef.current;
    const sc = scrollRef.current;
    if (!inner || !sc) return;

    inner.innerHTML = "";
    st.current.heights = meta.chunks.map((c) => c.estHeight);
    st.current.loaded = new Array(meta.chunkCount).fill(false);
    st.current.els = new Array(meta.chunkCount).fill(null);
    st.current.inflight.clear();
    st.current.lastScrollTop = sc.scrollTop = 0;
    st.current.vel = 0;
    st.current.activeId = null;

    const frag = document.createDocumentFragment();
    for (let i = 0; i < meta.chunkCount; i++) {
      const d = document.createElement("div");
      d.className = "chunk-block placeholder";
      d.style.height = st.current.heights[i] + "px";
      d.dataset.chunk = String(i);
      st.current.els[i] = d;
      frag.appendChild(d);
    }
    inner.appendChild(frag);

    sc.addEventListener("scroll", onScroll, { passive: true });
    update();

    return () => {
      st.current.disposed = true;
      sc.removeEventListener("scroll", onScroll);
      if (st.current.raf != null) cancelAnimationFrame(st.current.raf);
      inner.innerHTML = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, path]);

  // Theme change: re-render mermaid blocks in currently mounted chunks.
  useEffect(() => {
    for (let i = 0; i < meta.chunkCount; i++) {
      if (st.current.loaded[i] && meta.chunks[i]?.hasMermaid) {
        const el = st.current.els[i];
        if (el) void renderMermaidBlocks(el, dark);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dark, meta]);

  return (
    <div ref={scrollRef} className="md-body chunked-scroll">
      <div ref={innerRef} />
    </div>
  );
});

export default ChunkedReader;
