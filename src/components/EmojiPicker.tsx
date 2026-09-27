import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { EMOJI_CATEGORIES } from "../emoji";

interface Props {
  x: number;
  y: number;
  onPick: (emoji: string) => void;
  onClose: () => void;
}

/** Emoji picker popover for the editor. Deliberately does NOT take focus
 * (same rule as the slash palette): the editor keeps the caret, clicks
 * insert at it, and the panel stays open for inserting several emoji.
 * Dismissal mirrors ContextMenu: outside pointerdown / Esc / scroll /
 * resize / window blur. */
export default function EmojiPicker({ x, y, onPick, onClose }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x, y });
  const [tab, setTab] = useState(0);

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
      y: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)),
    });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    };
    const onScroll = (e: Event) => {
      if (!(e.target instanceof Node) || !rootRef.current?.contains(e.target)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const active = EMOJI_CATEGORIES[tab];

  return (
    <div className="emoji-panel" role="dialog" aria-label="表情" ref={rootRef} style={{ left: pos.x, top: pos.y }}>
      <div className="emoji-tabs">
        {EMOJI_CATEGORIES.map((c, i) => (
          <button
            key={c.name}
            type="button"
            className={`emoji-tab${i === tab ? " active" : ""}`}
            onClick={() => setTab(i)}
          >
            {c.name}
          </button>
        ))}
      </div>
      <div className="emoji-grid">
        {active.items.map(([emoji, name]) => (
          <button
            key={emoji}
            type="button"
            className="emoji-btn"
            title={name}
            onClick={() => onPick(emoji)}
          >
            {emoji}
          </button>
        ))}
      </div>
    </div>
  );
}
