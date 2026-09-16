import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
} from "react";
import { api, type PreviewMeta } from "../ipc";
import { renderMermaidBlocks } from "../mermaid";

export interface PreviewPaneHandle {
  /** Align the block's top with the viewport top (fetching its chunk first). */
  scrollToBlock: (bi: number) => void;
  /** Block index at (or nearest above) the viewport top. */
  getTopBi: () => number | null;
}

interface Props {
  meta: PreviewMeta;
  /** Document identity: a change resets scroll, a rev update keeps it. */
  docKey: string;
  dark: boolean;
  /** Editor-driven sync target — the block that should sit at the top. */
  syncTargetRef: MutableRefObject<number>;
  /** Top block changed (throttled); fires for user and programmatic scrolls. */
  onTopBi: (bi: number) => void;
  onOpenLink?: (href: string) => void;
}

const BACK_CHUNKS = 2;
const AHEAD_CHUNKS = 3;
const KEEP_MARGIN = 6; // eviction window beyond the loaded band
const MAX_INFLIGHT = 8;
const TOP_BI_MS = 120;
/** Breathing room when a block is aligned to the viewport top. */
const BLOCK_TOP_PAD = 12;

interface BiTop {
  bi: number;
  /** Offset from the chunk container's top, in px. */
  top: number;
}

interface State {
  heights: number[];
  loaded: boolean[];
  els: (HTMLDivElement | null)[];
  biTops: (BiTop[] | null)[];
  inflight: Set<number>;
  pendingBi: number | null;
  lastScrollTop: number;
  lastTime: number;
  vel: number; // px/ms, smoothed
  raf: number | null;
  lastTopBi: number;
  lastTopBiCheck: number;
  disposed: boolean;
}

/**
 * Virtualized live preview for the split view: every chunk is a placeholder
 * div sized by estimate; chunks near the viewport are fetched from Rust and
 * mounted, far ones are evicted back to placeholders. Each top-level block
 * carries a `data-bi` anchor (injected by Rust at render time) which maps
 * straight back to a source line, so scroll sync in both directions is a
 * plain table lookup — no DOM-to-source reverse parsing.
 */
const PreviewPane = forwardRef<PreviewPaneHandle, Props>(function PreviewPane(
  { meta, docKey, dark, syncTargetRef, onTopBi, onOpenLink },
  ref,
) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const st = useRef<State>({
    heights: [],
    loaded: [],
    els: [],
    biTops: [],
    inflight: new Set(),
    pendingBi: null,
    lastScrollTop: 0,
    lastTime: 0,
    vel: 0,
    raf: null,
    lastTopBi: 0,
    lastTopBiCheck: 0,
    disposed: false,
  });
  const darkRef = useRef(dark);
  darkRef.current = dark;
  const onTopBiRef = useRef(onTopBi);
  onTopBiRef.current = onTopBi;
  const onOpenLinkRef = useRef(onOpenLink);
  onOpenLinkRef.current = onOpenLink;
  const docKeyRef = useRef<string | null>(null);

  // Delegated link handling on the scroll container; chunk HTML mounts here
  // imperatively, so the delegation survives every mount/unmount cycle.
  const onScrollClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const cb = onOpenLinkRef.current;
    if (!cb) return;
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href");
    if (href) cb(href);
  };

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

  /** Exact offset of a block anchor inside a chunk, or null. */
  function findTop(tops: BiTop[], bi: number): number | null {
    let lo = 0;
    let hi = tops.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (tops[mid].bi === bi) return tops[mid].top;
      if (tops[mid].bi < bi) lo = mid + 1;
      else hi = mid - 1;
    }
    return null;
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

    // Index block anchors with chunk-local offsets for O(log n) sync.
    const tops: BiTop[] = [];
    const chunkRect = el.getBoundingClientRect();
    el.querySelectorAll("[data-bi]").forEach((node) => {
      const bi = Number((node as HTMLElement).dataset.bi);
      if (!Number.isFinite(bi)) return;
      tops.push({ bi, top: node.getBoundingClientRect().top - chunkRect.top });
    });
    st.current.biTops[index] = tops;

    if (meta.chunks[index]?.hasMermaid) {
      void renderMermaidBlocks(el, darkRef.current);
    }
    if (st.current.pendingBi != null) {
      const local = findTop(tops, st.current.pendingBi);
      if (local != null) {
        st.current.lastTopBi = st.current.pendingBi;
        st.current.pendingBi = null;
        const sc = scrollRef.current;
        if (sc) {
          sc.scrollTop = Math.max(0, chunkTop(index) + local - BLOCK_TOP_PAD);
        }
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
    st.current.biTops[index] = null;
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
        .previewChunks(meta.rev, start, run.length)
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

  /** Block at (or nearest above) `scrollTop`, or the last known value. */
  function topBiAt(scrollTop: number): number {
    const first = firstVisibleIndex(scrollTop);
    for (
      let c = Math.max(0, first - 1);
      c <= Math.min(meta.chunkCount - 1, first + 1);
      c++
    ) {
      if (!st.current.loaded[c]) continue;
      const tops = st.current.biTops[c];
      if (!tops || tops.length === 0) continue;
      const want = scrollTop + BLOCK_TOP_PAD - chunkTop(c);
      if (want <= tops[0].top) return tops[0].bi;
      let lo = 0;
      let hi = tops.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (tops[mid].top < want) lo = mid + 1;
        else hi = mid;
      }
      return tops[lo].bi;
    }
    return st.current.lastTopBi;
  }

  function updateTopBi(scrollTop: number) {
    const now = performance.now();
    if (now - st.current.lastTopBiCheck < TOP_BI_MS) return;
    st.current.lastTopBiCheck = now;
    const bi = topBiAt(scrollTop);
    if (bi !== st.current.lastTopBi) {
      st.current.lastTopBi = bi;
      onTopBiRef.current(bi);
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

    updateTopBi(sc.scrollTop);
  }

  function onScroll() {
    if (st.current.raf != null) return;
    st.current.raf = requestAnimationFrame(() => {
      st.current.raf = null;
      update();
    });
  }

  /** Align the block's top with the viewport top. Mounted chunks resolve it
   * exactly; otherwise we land on the chunk estimate and refine once the
   * chunk mounts (pendingBi). */
  function scrollToBlock(bi: number) {
    const sc = scrollRef.current;
    const block = meta.blocks[bi];
    if (!sc || !block) return;
    for (let c = 0; c < meta.chunkCount; c++) {
      if (!st.current.loaded[c]) continue;
      const tops = st.current.biTops[c];
      if (!tops || tops.length === 0) continue;
      if (bi < tops[0].bi || bi > tops[tops.length - 1].bi) continue;
      const local = findTop(tops, bi);
      if (local != null) {
        sc.scrollTop = Math.max(0, chunkTop(c) + local - BLOCK_TOP_PAD);
        st.current.lastTopBi = bi;
        return;
      }
    }
    st.current.pendingBi = bi;
    sc.scrollTop = Math.max(0, chunkTop(block.chunk));
    requestChunks([block.chunk]);
    if (st.current.raf == null) {
      st.current.raf = requestAnimationFrame(() => {
        st.current.raf = null;
        update();
      });
    }
  }

  useImperativeHandle(ref, () => ({
    scrollToBlock,
    getTopBi: () => {
      const sc = scrollRef.current;
      if (!sc) return null;
      return topBiAt(sc.scrollTop);
    },
  }));

  useEffect(() => {
    st.current.disposed = false;
    const inner = innerRef.current;
    const sc = scrollRef.current;
    if (!inner || !sc) return;

    const resetScroll = docKeyRef.current !== docKey;
    docKeyRef.current = docKey;

    inner.innerHTML = "";
    st.current.heights = meta.chunks.map((c) => c.estHeight);
    st.current.loaded = new Array(meta.chunkCount).fill(false);
    st.current.els = new Array(meta.chunkCount).fill(null);
    st.current.biTops = new Array(meta.chunkCount).fill(null);
    st.current.inflight.clear();
    st.current.pendingBi = null;
    st.current.vel = 0;
    st.current.lastTopBi = 0;
    if (resetScroll) {
      st.current.lastScrollTop = sc.scrollTop = 0;
    }

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

    // Re-align to the editor-driven target after every rebuild: the editor
    // is the source of truth, so top alignment absorbs any height changes
    // above the fold without the preview visually jumping. All chunks are
    // placeholders at this point, so this lands on an estimate and refines
    // once the target chunk mounts (pendingBi).
    if (meta.blocks.length > 0) {
      const bi = Math.min(Math.max(0, syncTargetRef.current), meta.blocks.length - 1);
      scrollToBlock(bi);
    }
    update();

    return () => {
      st.current.disposed = true;
      sc.removeEventListener("scroll", onScroll);
      if (st.current.raf != null) cancelAnimationFrame(st.current.raf);
      inner.innerHTML = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, docKey]);

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
    <div ref={scrollRef} className="md-body chunked-scroll" onClick={onScrollClick}>
      <div ref={innerRef} />
    </div>
  );
});

export default PreviewPane;
