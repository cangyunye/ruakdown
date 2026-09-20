/**
 * Image zoom layer for rendered markdown: hovering a downscaled image floats
 * the original size near the cursor, clicking opens a lightbox. Both are
 * fixed-position overlays detached from the document flow — layout, and with
 * it scroll sync, never moves because of them.
 *
 * One attachment per scroll container (Reader / ChunkedReader / PreviewPane);
 * the returned cleanup detaches listeners and removes the layers.
 */
export function attachImageZoom(container: HTMLElement): () => void {
  // Hover layer: original size near the cursor.
  const hover = document.createElement("div");
  hover.className = "img-zoom-hover";
  const hoverImg = document.createElement("img");
  hoverImg.alt = "";
  hover.appendChild(hoverImg);
  document.body.appendChild(hover);

  // Lightbox: full-screen, centered.
  const box = document.createElement("div");
  box.className = "img-zoom-lightbox";
  const boxImg = document.createElement("img");
  boxImg.alt = "";
  box.appendChild(boxImg);
  document.body.appendChild(box);

  let active: HTMLImageElement | null = null;
  // Hover-layer size cached when the zoom starts: the layer has explicit
  // px sizing, so re-reading offsetWidth/Height on every mousemove would
  // force a layout per event for nothing.
  let hoverW = 10;
  let hoverH = 10;

  const hideHover = () => {
    active = null;
    hover.classList.remove("on");
  };

  /** Proportional fit of the natural size into a max box. */
  const fit = (img: HTMLImageElement, maxW: number, maxH: number) => {
    const w = img.naturalWidth || img.clientWidth;
    const h = img.naturalHeight || img.clientHeight;
    const scale = Math.min(1, maxW / w, maxH / h);
    return { width: Math.round(w * scale), height: Math.round(h * scale) };
  };

  const positionHover = (e: MouseEvent) => {
    if (!active) return;
    let x = e.clientX + 18;
    let y = e.clientY + 18;
    if (x + hoverW > window.innerWidth - 8) x = e.clientX - hoverW - 18;
    if (y + hoverH > window.innerHeight - 8) y = e.clientY - hoverH - 18;
    hover.style.left = `${Math.max(8, x)}px`;
    hover.style.top = `${Math.max(8, y)}px`;
  };

  // mousemove fires faster than frames; coalesce to one position pass per
  // frame instead of forcing style work per event.
  let moveRaf = 0;
  let lastMove: MouseEvent | null = null;

  const onOver = (e: MouseEvent) => {
    const el = (e.target as HTMLElement | null)?.closest("img") as HTMLImageElement | null;
    if (!el || !container.contains(el)) {
      hideHover();
      return;
    }
    // Only images the layout actually downscaled have something to restore.
    const scaled =
      el.complete &&
      el.naturalWidth > 0 &&
      (el.naturalWidth > el.clientWidth + 2 || el.naturalHeight > el.clientHeight + 2);
    if (!scaled) {
      hideHover();
      return;
    }
    if (active !== el) {
      active = el;
      hoverImg.src = el.currentSrc || el.src;
      const { width, height } = fit(el, window.innerWidth * 0.5, window.innerHeight * 0.6);
      hoverImg.style.width = `${width}px`;
      hoverImg.style.height = `${height}px`;
      hoverW = width;
      hoverH = height;
      hover.classList.add("on");
    }
    positionHover(e);
  };

  const onMove = (e: MouseEvent) => {
    if (!active) return;
    lastMove = e;
    if (!moveRaf) {
      moveRaf = requestAnimationFrame(() => {
        moveRaf = 0;
        if (lastMove) positionHover(lastMove);
        lastMove = null;
      });
    }
  };

  const onClick = (e: MouseEvent) => {
    const el = (e.target as HTMLElement | null)?.closest("img") as HTMLImageElement | null;
    if (!el || !container.contains(el) || !el.naturalWidth) return;
    e.preventDefault();
    boxImg.src = el.currentSrc || el.src;
    const { width, height } = fit(el, window.innerWidth * 0.92, window.innerHeight * 0.92);
    boxImg.style.width = `${width}px`;
    boxImg.style.height = `${height}px`;
    box.classList.add("on");
    hideHover();
  };

  const closeBox = () => box.classList.remove("on");
  const onBoxClick = (e: MouseEvent) => {
    e.stopPropagation();
    closeBox();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && box.classList.contains("on")) {
      e.preventDefault();
      closeBox();
    }
  };
  const hideOnScroll = () => hideHover();

  container.addEventListener("mouseover", onOver);
  container.addEventListener("mousemove", onMove);
  container.addEventListener("click", onClick);
  container.addEventListener("scroll", hideOnScroll, { passive: true });
  box.addEventListener("click", onBoxClick);
  window.addEventListener("keydown", onKey, true);

  return () => {
    container.removeEventListener("mouseover", onOver);
    container.removeEventListener("mousemove", onMove);
    container.removeEventListener("click", onClick);
    container.removeEventListener("scroll", hideOnScroll);
    box.removeEventListener("click", onBoxClick);
    window.removeEventListener("keydown", onKey, true);
    if (moveRaf) cancelAnimationFrame(moveRaf);
    hideHover();
    closeBox();
    hover.remove();
    box.remove();
  };
}
