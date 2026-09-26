import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { MOD_KEY } from "../shortcuts";
import type { Mode } from "../split";

/** True inside the Tauri webview, false in plain-browser `pnpm dev` and
 * jsdom tests — window controls and caption dragging need a native window. */
const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface TitleBarProps {
  mode: Mode;
  hasDoc: boolean;
  /** Basename of the open file; null shows the brand name. */
  docName: string | null;
  docPath: string | null;
  dirty: boolean;
  /** Zen is reader-only and chunked large docs are excluded. */
  zenAvailable: boolean;
  zenOn: boolean;
  fullscreenOn: boolean;
  themeName: string;
  themeLabels: Record<string, string>;
  /** `--features share` build; hides the share menu section otherwise. */
  shareAvailable: boolean;
  /** Runtime app version (Tauri `getVersion()`); null hides the menu footer. */
  version?: string | null;
  onMode: (mode: Mode) => void;
  onZen: () => void;
  onFullscreen: () => void;
  onTheme: (name: string) => void;
  onSettings: () => void;
  /** Former native-menu actions (open/export/find/sidebar/share/help). */
  onAction: (id: string) => void;
}

type MenuEntry = { type: "sep" } | { type: "item"; id: string; label: string; shortcut?: string };

/* ---------- icons (16px inline SVG, stroke = currentColor) ---------- */

function Icon({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** Gradient rounded square + white page, echoing the app icon. */
function LogoMark() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id="tb-logo-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3b82f6" />
          <stop offset="1" stopColor="#14b8a6" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="22" height="22" rx="6" fill="url(#tb-logo-g)" />
      <path
        d="M8 5.5h6.2L18 9.3V18a1.2 1.2 0 0 1-1.2 1.2H8A1.2 1.2 0 0 1 6.8 18V6.7A1.2 1.2 0 0 1 8 5.5z"
        fill="#ffffff"
        opacity="0.95"
      />
      <path d="M14.2 5.5 18 9.3h-3.8z" fill="#cfe3f2" />
    </svg>
  );
}

function IconTarget() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none" />
    </Icon>
  );
}

function IconExpand() {
  return (
    <Icon>
      <path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9" />
      <path d="M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9" />
      <path d="M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15" />
      <path d="M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15" />
    </Icon>
  );
}

function IconSliders() {
  return (
    <Icon>
      <path d="M4 7.5h8.5" />
      <path d="M17.5 7.5H20" />
      <circle cx="15" cy="7.5" r="2.2" />
      <path d="M4 16.5h2.5" />
      <path d="M11.5 16.5H20" />
      <circle cx="9" cy="16.5" r="2.2" />
    </Icon>
  );
}

/** Half-filled circle: light/dark contrast, stands in for "theme". */
function IconContrast() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none" />
    </Icon>
  );
}

function IconChevron() {
  return (
    <Icon size={13}>
      <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />
    </Icon>
  );
}

function IconCheck() {
  return (
    <Icon size={13}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </Icon>
  );
}

function IconKebab() {
  return (
    <Icon>
      <circle cx="5.5" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </Icon>
  );
}

/* ---------- window controls ---------- */

function IconMin() {
  return (
    <Icon size={15}>
      <path d="M5.5 12h13" />
    </Icon>
  );
}

function IconMax() {
  return (
    <Icon size={14}>
      <rect x="5.5" y="5.5" width="13" height="13" rx="1.6" />
    </Icon>
  );
}

function IconRestore() {
  return (
    <Icon size={14}>
      <rect x="5" y="8" width="11" height="11" rx="1.6" />
      <path d="M8.5 8V6.6A1.6 1.6 0 0 1 10.1 5h7.3A1.6 1.6 0 0 1 19 6.6v7.3a1.6 1.6 0 0 1-1.6 1.6H16" />
    </Icon>
  );
}

function IconClose() {
  return (
    <Icon size={15}>
      <path d="m6 6 12 12" />
      <path d="M18 6 6 18" />
    </Icon>
  );
}

/** Native-style min/max/close. The maximize button doubles as the state
 * indicator: tao reports undecorated-window maximization through resize
 * events, so the icon flips via onResized + isMaximized. */
function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!IS_TAURI) return;
    const win = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const sync = () => {
      void win.isMaximized().then((v) => {
        if (!disposed) setMaximized(v);
      });
    };
    sync();
    void win.onResized(sync).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  if (!IS_TAURI) return null;
  const win = getCurrentWindow();
  return (
    <div className="tb-win">
      <button
        type="button"
        className="tb-win-btn"
        title="最小化"
        aria-label="最小化"
        onClick={() => void win.minimize()}
      >
        <IconMin />
      </button>
      <button
        type="button"
        className="tb-win-btn"
        title={maximized ? "向下还原" : "最大化"}
        aria-label={maximized ? "向下还原" : "最大化"}
        onClick={() => void win.toggleMaximize()}
      >
        {maximized ? <IconRestore /> : <IconMax />}
      </button>
      <button
        type="button"
        className="tb-win-btn tb-win-close"
        title="关闭"
        aria-label="关闭"
        onClick={() => void win.close()}
      >
        <IconClose />
      </button>
    </div>
  );
}

/* ---------- dropdown menu ---------- */

interface DropdownProps {
  trigger: ReactNode;
  triggerClass: string;
  triggerTitle: string;
  entries: MenuEntry[];
  /** When set, the entry with this id renders checked (theme picker). */
  checkedId?: string | null;
  /** Muted non-interactive line pinned after the entries (version info). */
  footer?: string | null;
  onSelect: (id: string) => void;
}

function Dropdown({
  trigger,
  triggerClass,
  triggerTitle,
  entries,
  checkedId,
  footer,
  onSelect,
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // Click-outside close, in the capture phase so it wins over the header's
  // drag handler (which excludes .tb-menu targets anyway).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open]);

  // Focus the active (or first) item when the menu opens, so ↑/↓ work right
  // away and Enter re-confirms the current theme.
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => {
      const items = rootRef.current?.querySelectorAll<HTMLButtonElement>(".tb-menu-item");
      if (!items || items.length === 0) return;
      const active =
        checkedId != null
          ? Array.from(items).find((b) => b.getAttribute("aria-checked") === "true")
          : null;
      (active ?? items[0]).focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [open, checkedId]);

  const close = useCallback((focusBack: boolean) => {
    setOpen(false);
    if (focusBack) triggerRef.current?.focus();
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close(true);
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(
      rootRef.current?.querySelectorAll<HTMLButtonElement>(".tb-menu-item") ?? [],
    );
    if (items.length === 0) return;
    const idx = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "ArrowDown" ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length;
    items[next].focus();
  };

  return (
    <div className="tb-dd" ref={rootRef} onKeyDown={open ? onKeyDown : undefined}>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClass}
        title={triggerTitle}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {trigger}
      </button>
      {open && (
        <div className="tb-menu" role="menu">
          {entries.map((entry, i) =>
            entry.type === "sep" ? (
              <div className="tb-menu-sep" key={`sep-${i}`} />
            ) : (
              <button
                key={entry.id}
                type="button"
                role={checkedId != null ? "menuitemradio" : "menuitem"}
                aria-checked={checkedId != null ? entry.id === checkedId : undefined}
                className="tb-menu-item"
                onClick={() => {
                  onSelect(entry.id);
                  close(false);
                }}
              >
                <span className="tb-menu-check">{entry.id === checkedId && <IconCheck />}</span>
                <span className="tb-menu-label">{entry.label}</span>
                {entry.shortcut && <span className="tb-menu-sc">{entry.shortcut}</span>}
              </button>
            ),
          )}
          {footer && <div className="tb-menu-version">{footer}</div>}
        </div>
      )}
    </div>
  );
}

/* ---------- title bar ---------- */

export default function TitleBar({
  mode,
  hasDoc,
  docName,
  docPath,
  dirty,
  zenAvailable,
  zenOn,
  fullscreenOn,
  themeName,
  themeLabels,
  shareAvailable,
  version,
  onMode,
  onZen,
  onFullscreen,
  onTheme,
  onSettings,
  onAction,
}: TitleBarProps) {
  // Caption drag: any press on the bar that is not a control goes to the
  // native move loop (HTCAPTION), which also gives Aero-snap and the
  // double-click-to-maximize behaviour — never add a JS dblclick handler on
  // top of it, the system already synthesizes WM_NCLBUTTONDBLCLK.
  const onDragMouseDown = (e: ReactMouseEvent<HTMLElement>) => {
    if (!IS_TAURI || e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, a, input, select, .tb-menu")) return;
    void getCurrentWindow().startDragging();
  };

  const themeEntries = useMemo<MenuEntry[]>(
    () =>
      Object.entries(themeLabels).map(([id, label]) => ({ type: "item", id, label })),
    [themeLabels],
  );

  const moreEntries = useMemo<MenuEntry[]>(() => {
    const entries: MenuEntry[] = [
      { type: "item", id: "open-file", label: "打开文件…", shortcut: `${MOD_KEY}+O` },
      { type: "item", id: "open-folder", label: "打开文件夹…", shortcut: `${MOD_KEY}+Shift+O` },
      { type: "item", id: "quick-open", label: "快速打开…", shortcut: `${MOD_KEY}+P` },
      { type: "item", id: "search-dir", label: "目录内搜索…", shortcut: `${MOD_KEY}+Shift+F` },
      { type: "sep" },
      { type: "item", id: "find", label: "查找…", shortcut: `${MOD_KEY}+F` },
      { type: "item", id: "replace", label: "替换…", shortcut: `${MOD_KEY}+R` },
      { type: "item", id: "export-html", label: "导出 HTML…", shortcut: `${MOD_KEY}+E` },
      { type: "sep" },
      { type: "item", id: "toggle-sidebar", label: "显示/隐藏侧边栏", shortcut: `${MOD_KEY}+B` },
    ];
    if (shareAvailable) {
      entries.push(
        { type: "sep" },
        { type: "item", id: "serve-local", label: "本机预览服务" },
        { type: "item", id: "serve-lan", label: "局域网分享 (只读, 需防火墙授权)" },
        { type: "item", id: "serve-lan-follow", label: "局域网分享 (同步浏览)" },
        { type: "item", id: "serve-lan-edit", label: "局域网分享 (协作编辑)" },
        { type: "sep" },
        { type: "item", id: "serve-stop", label: "停止分享服务" },
        { type: "item", id: "serve-open", label: "在浏览器打开分享页" },
      );
    }
    entries.push(
      { type: "sep" },
      { type: "item", id: "open-repo", label: "GitHub 仓库" },
      { type: "item", id: "open-releases", label: "检查更新 (Releases)…" },
    );
    return entries;
  }, [shareAvailable]);

  return (
    <header className="titlebar" onMouseDown={onDragMouseDown}>
      <div className="tb-left">
        <span className="tb-logo">
          <LogoMark />
        </span>
        <span className="tb-doc" title={docPath ?? "Ruakdown"}>
          {docName ?? "Ruakdown"}
        </span>
        {dirty && docName && <span className="tb-dirty" title="有未保存的修改" />}
      </div>
      <div className="tb-fill" />
      {hasDoc && (
        <div className="mode-switch" aria-label="视图模式">
          {(
            [
              ["read", "阅读"],
              ["split", "分屏"],
              ["edit", "源码"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={mode === value ? "active" : ""}
              aria-pressed={mode === value}
              onClick={() => onMode(value)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <div className="tb-fill" />
      <div className="tb-actions">
        <Dropdown
          trigger={
            <>
              <IconContrast />
              <span className="tb-dd-label">{themeLabels[themeName] ?? themeName}</span>
              <IconChevron />
            </>
          }
          triggerClass="tb-btn tb-dd-trigger"
          triggerTitle="切换主题"
          entries={themeEntries}
          checkedId={themeName}
          onSelect={onTheme}
        />
        {zenAvailable && (
          <button
            type="button"
            className={`tb-btn${zenOn ? " active" : ""}`}
            title={`专注模式 (${MOD_KEY}+Shift+Z, Esc 退出)`}
            aria-pressed={zenOn}
            onClick={onZen}
          >
            <IconTarget />
          </button>
        )}
        <button
          type="button"
          className={`tb-btn${fullscreenOn ? " active" : ""}`}
          title={`全屏模式 (${MOD_KEY === "⌘" ? "⌃⌘F" : "F11"})`}
          aria-pressed={fullscreenOn}
          onClick={onFullscreen}
        >
          <IconExpand />
        </button>
        <button type="button" className="tb-btn" title="设置" onClick={onSettings}>
          <IconSliders />
        </button>
        <Dropdown
          trigger={<IconKebab />}
          triggerClass="tb-btn"
          triggerTitle="更多操作"
          entries={moreEntries}
          footer={version ? `Ruakdown v${version}` : null}
          onSelect={onAction}
        />
      </div>
      <WindowControls />
    </header>
  );
}
