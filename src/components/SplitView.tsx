import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { clampRatio, type EditorSide } from "../split";

interface Props {
  side: EditorSide;
  /** Editor pane width as a fraction of the split area (0.2-0.8). */
  ratio: number;
  onResizeEnd: (ratio: number) => void;
  onSwap: () => void;
  editor: ReactNode;
  preview: ReactNode;
}

/**
 * Two-pane layout for the split view: a draggable divider adjusts the pane
 * ratio (ref-driven while dragging, so no React re-renders per move), the
 * ⇄ button swaps editor/preview sides, double-click resets to 50/50.
 */
export default function SplitView({ side, ratio, onResizeEnd, onSwap, editor, preview }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const firstPaneRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const pendingRatio = useRef(ratio);

  // The first DOM pane holds the editor while side==="left"; once swapped it
  // holds the preview, so the dragged fraction flips meaning with the side.
  const firstIsEditor = side === "left";

  const applyPointer = (clientX: number) => {
    const root = rootRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    if (rect.width <= 0) return;
    const frac = firstIsEditor
      ? (clientX - rect.left) / rect.width
      : (rect.right - clientX) / rect.width;
    pendingRatio.current = clampRatio(frac);
    if (rafRef.current == null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const pane = firstPaneRef.current;
        if (pane) pane.style.flexBasis = `${(pendingRatio.current * 100).toFixed(3)}%`;
      });
    }
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* capture may already be gone */
    }
    document.documentElement.classList.remove("split-resizing");
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    onResizeEnd(pendingRatio.current);
  };

  const editorPane = firstIsEditor ? editor : preview;
  const previewPane = firstIsEditor ? preview : editor;

  return (
    <div className="split-view" ref={rootRef}>
      <div
        className="split-pane"
        ref={firstPaneRef}
        style={{ flexBasis: `${(ratio * 100).toFixed(3)}%` }}
      >
        {editorPane}
      </div>
      <div
        className="split-divider"
        title="拖拽调整宽度,双击恢复 50/50"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          draggingRef.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          document.documentElement.classList.add("split-resizing");
        }}
        onPointerMove={(e) => {
          if (draggingRef.current) applyPointer(e.clientX);
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => onResizeEnd(0.5)}
      >
        <button
          type="button"
          className="split-swap"
          title="交换编辑器/预览位置"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onSwap}
        >
          ⇄
        </button>
      </div>
      <div className="split-pane split-pane-rest">{previewPane}</div>
    </div>
  );
}
