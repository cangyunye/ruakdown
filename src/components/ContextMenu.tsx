import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

export type CtxEntry =
  | { type: "sep" }
  | {
      type: "item";
      id: string;
      label: string;
      shortcut?: string;
      /** Rendered in the error red (delete). */
      danger?: boolean;
      disabled?: boolean;
      /** Short glyph shown in the leading slot (e.g. "●" for callout colors). */
      icon?: string;
      /** CSS color for the icon (colored-dot styling). */
      color?: string;
    };

interface Props {
  x: number;
  y: number;
  entries: CtxEntry[];
  onClose: () => void;
  onSelect: (id: string) => void;
  /** Focus the first item on mount (default true). The slash palette turns
   * this off so the editor keeps keyboard focus while the menu is open —
   * stealing focus mid-IME-composition duplicates the committed character. */
  autoFocus?: boolean;
  /** Navigate with ArrowUp/ArrowDown/Enter/Tab from a window-level capture
   * listener, so the menu is keyboard-operable even when focus sits outside
   * it (the slash palette's default state). */
  windowKeyNav?: boolean;
}

/** Fixed-position context menu for the file tree. Reuses the TitleBar
 * dropdown's `.tb-menu` visual language; positioning, viewport clamping and
 * dismissal (outside pointerdown / Esc / scroll / resize / window blur) are
 * its own. */
export default function ContextMenu({ x, y, entries, onClose, onSelect, autoFocus, windowKeyNav }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x, y });

  // Clamp into the viewport once the menu has a measurable size.
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
    // Scrolling anywhere outside the menu dismisses it (inner menu scrolling
    // must not).
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

  // Focus the first enabled item so ↑/↓ work immediately. A layout effect:
  // by paint time the menu is already keyboard-navigable, and focus needs no
  // frame delay.
  useLayoutEffect(() => {
    if (autoFocus === false) return;
    rootRef.current
      ?.querySelector<HTMLButtonElement>(".tb-menu-item:not(.disabled)")
      ?.focus();
  }, [autoFocus]);

  // Window-level navigation for callers that keep focus elsewhere (slash
  // palette): ↑/↓ move DOM focus into the menu (then it behaves like any
  // focused button), Enter/Tab activate the focused item or the first one.
  // Capture phase + stopPropagation so the editor keymap never sees them.
  useEffect(() => {
    if (!windowKeyNav) return;
    const items = () =>
      Array.from(
        rootRef.current?.querySelectorAll<HTMLButtonElement>(".tb-menu-item:not(.disabled)") ?? [],
      );
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        const list = items();
        if (list.length === 0) return;
        const idx = list.indexOf(document.activeElement as HTMLButtonElement);
        const next =
          e.key === "ArrowDown"
            ? idx < 0
              ? 0
              : (idx + 1) % list.length
            : idx < 0
              ? list.length - 1
              : (idx - 1 + list.length) % list.length;
        list[next].focus();
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        const list = items();
        const active = document.activeElement as HTMLButtonElement | null;
        const target = active && list.includes(active) ? active : list[0];
        target?.click();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [windowKeyNav]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    e.stopPropagation();
    const items = Array.from(
      rootRef.current?.querySelectorAll<HTMLButtonElement>(".tb-menu-item:not(.disabled)") ?? [],
    );
    if (items.length === 0) return;
    const idx = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === "ArrowDown" ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length;
    items[next].focus();
  };

  return (
    <div
      className="tb-menu ctx-menu"
      role="menu"
      ref={rootRef}
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {entries.map((entry, i) =>
        entry.type === "sep" ? (
          <div className="tb-menu-sep" key={`sep-${i}`} />
        ) : (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            className={
              "tb-menu-item" +
              (entry.danger ? " danger" : "") +
              (entry.disabled ? " disabled" : "")
            }
            disabled={entry.disabled}
            onClick={() => {
              if (entry.disabled) return;
              onSelect(entry.id);
              onClose();
            }}
          >
            {entry.icon ? (
              <span className="tb-menu-icon" style={entry.color ? { color: entry.color } : undefined}>
                {entry.icon}
              </span>
            ) : (
              <span className="tb-menu-check" />
            )}
            <span className="tb-menu-label">{entry.label}</span>
            {entry.shortcut && <span className="tb-menu-sc">{entry.shortcut}</span>}
          </button>
        ),
      )}
    </div>
  );
}
