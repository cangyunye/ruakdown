import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  api,
  SERVE_PORT,
  type AppConfig,
  type BackgroundConfig,
  type DocPayload,
  type PreviewMeta,
  type TreeNode,
  type ZenConfig,
} from "./ipc";
import { applyTheme } from "./theme";
import { scrollToText } from "./jumpToText";
import { openMarkdownLink } from "./links";
import { decideFsChange, type SelfSaveMark } from "./changeDecision";
import { blockAtLine, headingOwners, lockAllows, nextSyncTarget, SYNC_LOCK_MS, type SyncLock } from "./scrollSync";
import { matchShortcut } from "./shortcuts";
import {
  clearCallout,
  insertAudio,
  insertCallout,
  insertCodeBlock,
  insertHr,
  insertIframe,
  insertImageLink,
  insertLink,
  insertMathBlock,
  insertMindmap,
  insertTable,
  insertVideo,
  togglePrefix,
  toggleWrap,
} from "./editorCommands";
import type { EditorView } from "@codemirror/view";
import {
  flipSide,
  nextEditorText,
  nextMode,
  normalizeRatio,
  normalizeSide,
  type EditorSide,
  type Mode,
} from "./split";
import type { ZenController, ZenLevel } from "./zen";
import { Sidebar, type SidebarTab } from "./components/Sidebar";
import { Reader } from "./components/Reader";
import QuickOpen from "./components/QuickOpen";
import ContextMenu, { type CtxEntry } from "./components/ContextMenu";
import EmojiPicker from "./components/EmojiPicker";
import type { TreeDraft } from "./components/FileTree";
import {
  assetDestDir,
  assetBaseName,
  ensureMdExt,
  findTreeNode,
  isImagePath,
  isInsideRoot,
  linkLabel,
  mdImageTag,
  mdLinkTag,
  pathBasename,
  pathDirname,
  pathJoin,
  relativeLinkHref,
  relativePathInRoot,
  stemOf,
  entryNameError,
} from "./fileOps";
import { upsertRecent } from "./quickOpen";
import { buildEditorMenuEntries } from "./editorMenuEntries";
import ChunkedReader, { type ChunkedReaderHandle } from "./components/ChunkedReader";
import SplitView from "./components/SplitView";
import PreviewPane, { type PreviewPaneHandle } from "./components/PreviewPane";
import SearchPanel from "./components/SearchPanel";
import TitleBar from "./components/TitleBar";
import type { SourceEditorHandle, PastePayload } from "./components/SourceEditor";
import type { SourceSearch } from "./sourceSearch";

const SourceEditor = lazy(() => import("./components/SourceEditor"));

/** Clipboard write with an execCommand fallback for non-secure contexts. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

const THEME_LABELS: Record<string, string> = {
  light: "浅色",
  dark: "暗色",
  graphite: "石墨",
  "sunset-coast": "夕阳海岸",
  verdant: "无边绿意",
  sky: "蓝天白云",
  newsprint: "陈旧报纸",
  "plum-wine": "青梅煮酒",
  "mountain-stream": "高山流水",
  wudang: "论道武当",
};


/** Project home and release feed, opened from the settings modal and the
 * empty state. Releases carry the prebuilt installers (update channel). */
const REPO_URL = "https://github.com/cangyunye/ruakdown";
const RELEASES_URL = `${REPO_URL}/releases`;

/** BackgroundConfig with all optional fields resolved to concrete values. */
type ResolvedBg = {
  enabled: boolean;
  path: string | null;
  blur: number;
  overlay: number;
  style: "paper" | "frosted";
};

const DEFAULT_BG: ResolvedBg = {
  enabled: false,
  path: null,
  blur: 0,
  overlay: 80,
  style: "paper",
};

function normalizeBg(raw: Partial<BackgroundConfig> | null): ResolvedBg {
  return {
    enabled: raw?.enabled ?? DEFAULT_BG.enabled,
    path: raw?.path ?? null,
    blur: raw?.blur ?? DEFAULT_BG.blur,
    overlay: raw?.overlay ?? DEFAULT_BG.overlay,
    style: raw?.style === "frosted" ? "frosted" : "paper",
  };
}

/** Mirror a BackgroundConfig onto documentElement classes and CSS vars. */
function applyBackground(cfg: ResolvedBg): void {
  const root = document.documentElement;
  const on = !!cfg.enabled && !!cfg.path;
  root.classList.toggle("bg-on", on);
  root.classList.toggle("bg-style-paper", on && cfg.style !== "frosted");
  root.classList.toggle("bg-style-frosted", on && cfg.style === "frosted");
  if (on) {
    root.style.setProperty(
      "--reader-bg-image",
      `url("${convertFileSrc(cfg.path!)}")`,
    );
    root.style.setProperty("--reader-bg-blur", `${cfg.blur}px`);
    root.style.setProperty("--reader-bg-overlay", String(cfg.overlay / 100));
  } else {
    root.style.removeProperty("--reader-bg-image");
    root.style.removeProperty("--reader-bg-blur");
    root.style.removeProperty("--reader-bg-overlay");
  }
}

/** ZenConfig with all optional fields resolved to concrete values. */
type ResolvedZen = {
  level: ZenLevel;
  effect: "dim" | "dim-blur";
  emphasis: boolean;
};

const DEFAULT_ZEN: ResolvedZen = {
  level: "auto",
  effect: "dim",
  emphasis: true,
};

function normalizeZen(raw: Partial<ZenConfig> | null): ResolvedZen {
  const level: ZenLevel =
    raw?.level === "h1" || raw?.level === "h2" || raw?.level === "h3"
      ? raw.level
      : "auto";
  return {
    level,
    effect: raw?.effect === "dim-blur" ? "dim-blur" : "dim",
    emphasis: raw?.emphasis ?? DEFAULT_ZEN.emphasis,
  };
}

export default function App() {
  const [root, setRoot] = useState<string | null>(null);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const [doc, setDoc] = useState<DocPayload | null>(null);
  const [mode, setMode] = useState<Mode>("read");
  const [dirty, setDirty] = useState(false);
  const [externalChange, setExternalChange] = useState(false);
  const [themeName, setThemeName] = useState("light");
  const [themeDark, setThemeDark] = useState(false);
  const [tab, setTab] = useState<SidebarTab>("files");
  const [activeHeading, setActiveHeading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [serveUrl, setServeUrl] = useState<string | null>(null);
  const [servePerms, setServePerms] = useState<{ follow: boolean; edit: boolean } | null>(null);
  const [shareAvailable, setShareAvailable] = useState(false);
  const [followRemote, setFollowRemote] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickContent, setQuickContent] = useState(false);
  const [quickQuery, setQuickQuery] = useState("");
  const [assetsDir, setAssetsDir] = useState<string | null>(null);
  const [recentFiles, setRecentFiles] = useState<string[]>([]);
  // File-tree context menu state.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [draft, setDraft] = useState<TreeDraft | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; entries: CtxEntry[] } | null>(
    null,
  );
  // Editor (CodeMirror) context menu — same shape, separate dispatcher.
  const [editorMenu, setEditorMenu] = useState<{ x: number; y: number; entries: CtxEntry[] } | null>(
    null,
  );
  // Anchor of the most recently opened editor menu / slash palette, reused
  // by the emoji picker (which outlives the menu that launched it).
  const menuAnchorRef = useRef<{ x: number; y: number }>({ x: 200, y: 160 });
  const [emojiAt, setEmojiAt] = useState<{ x: number; y: number } | null>(null);
  // 新建子文档并引用 naming dialog.
  const [subdocOpen, setSubdocOpen] = useState(false);
  const [subdocName, setSubdocName] = useState("");
  // Unsaved-changes dialog raised by Tauri's CloseRequested hook.
  const [exitAsk, setExitAsk] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  // Bumped whenever the reading view's rendered content is rebuilt outside
  // the normal open flow (e.g. the post-edit reload when switching to read
  // mode) — ChunkedReader keeps imperative state, so it must remount.
  const [readRev, setReadRev] = useState(0);
  const [findShowReplace, setFindShowReplace] = useState(false);
  const [findFocusNonce, setFindFocusNonce] = useState(0);
  const [sourceSearch, setSourceSearch] = useState<SourceSearch | null>(null);
  const [docVersion, setDocVersion] = useState(0);
  const [autosaveOn, setAutosaveOn] = useState(true);
  const [servePort, setServePort] = useState(SERVE_PORT);
  const [bg, setBg] = useState<ResolvedBg>(DEFAULT_BG);
  const [zenOn, setZenOn] = useState(false);
  const [zenCfg, setZenCfg] = useState<ResolvedZen>(DEFAULT_ZEN);
  const [zenPos, setZenPos] = useState<{ idx: number; total: number } | null>(null);
  const [fullscreenOn, setFullscreenOn] = useState(false);
  const [appVersion, setAppVersion] = useState("");
  const [editorSide, setEditorSide] = useState<EditorSide>("left");
  const [splitRatio, setSplitRatio] = useState(0.5);
  const [previewMeta, setPreviewMeta] = useState<PreviewMeta | null>(null);
  const zenPosRef = useRef(zenPos);
  zenPosRef.current = zenPos;
  const zenCtlRef = useRef<ZenController | null>(null);
  const readerWrapRef = useRef<HTMLDivElement | null>(null);
  const recentFilesRef = useRef<string[]>([]);
  recentFilesRef.current = recentFiles;
  const previewMetaRef = useRef<PreviewMeta | null>(null);
  previewMetaRef.current = previewMeta;
  // A chord can fire from both the native menu accelerator and the webview
  // keydown fallback on some platforms; collapse duplicates.
  const lastFireRef = useRef<Record<string, number>>({});
  const fireOnce = useCallback((action: string, fn: () => void) => {
    const now = Date.now();
    if (now - (lastFireRef.current[action] ?? 0) < 350) return;
    lastFireRef.current[action] = now;
    fn();
  }, []);

  const autosaveRef = useRef(autosaveOn);
  autosaveRef.current = autosaveOn;
  const servePortRef = useRef(servePort);
  servePortRef.current = servePort;
  // Share-session mirrors for listeners and scroll handlers that must read
  // the latest values without re-subscribing.
  const followRemoteRef = useRef(false);
  followRemoteRef.current = followRemote;
  const servePermsRef = useRef(servePerms);
  servePermsRef.current = servePerms;
  const activeHeadingRef = useRef<string | null>(null);
  activeHeadingRef.current = activeHeading;
  // Timestamp guard: after applying a remote scroll we briefly stop
  // re-broadcasting our own position, so follower loops damp out.
  const remoteGuardRef = useRef(0);

  const hydrated = useRef(false);
  const chunkedReaderRef = useRef<ChunkedReaderHandle | null>(null);
  const editorRef = useRef<SourceEditorHandle | null>(null);
  // Whether the CodeMirror editor currently holds keyboard focus; consulted
  // by the global chord router so Ctrl+B / Ctrl+O / Ctrl+Shift+Z reach the
  // editor commands instead of the sidebar / open dialog / zen.
  const editorFocusedRef = useRef(false);
  const previewRef = useRef<PreviewPaneHandle | null>(null);
  // Scroll-sync state: which side drove the last sync (echo suppression)
  // and the block that should sit at the preview top (editor is the source
  // of truth).
  const syncLockRef = useRef<SyncLock | null>(null);
  const syncTargetBiRef = useRef(0);
  const previewTimer = useRef<number | null>(null);
  const previewRevRef = useRef(0);
  const editorScrollRaf = useRef<number | null>(null);
  const stateRef = useRef({
    root,
    currentFile,
    themeName,
    mode,
    doc,
    serveUrl,
    bg,
    zenCfg,
    editorSide,
    splitRatio,
    assetsDir,
  });
  stateRef.current = {
    root,
    currentFile,
    themeName,
    mode,
    doc,
    serveUrl,
    bg,
    zenCfg,
    editorSide,
    splitRatio,
    assetsDir,
  };
  const editTextRef = useRef("");
  const dirtyRef = useRef(false);
  const autosaveTimer = useRef<number | null>(null);
  // Exit flow: `exitApproved` lets the confirmed re-close pass the
  // CloseRequested guard; `appExiting` keeps beforeunload from running its
  // best-effort save over a "不保存退出" decision.
  const exitApprovedRef = useRef(false);
  const appExitingRef = useRef(false);
  // fs events landing shortly after a save are echoes of our own write
  // (tmp+rename trips the watcher), never external edits.
  const selfSaveRef = useRef<SelfSaveMark | null>(null);

  /** Suppress watcher reactions to this file for a window after a save. */
  const markSelfSave = useCallback((path: string | null) => {
    if (!path) return;
    selfSaveRef.current = { path, until: Date.now() + 3000 };
  }, []);

  const persist = useCallback((patch: Partial<AppConfig>) => {
    if (!hydrated.current) return;
    const s = stateRef.current;
    api
      .saveConfig({
        lastFolder: s.root,
        lastFile: s.currentFile,
        theme: s.themeName,
        servePort: servePortRef.current,
        autosave: autosaveRef.current,
        background: s.bg,
        zen: s.zenCfg,
        split: { editorSide: s.editorSide, ratio: s.splitRatio },
        assetsDir: s.assetsDir,
        ...patch,
      })
      .catch(() => {});
  }, []);

  const saveDoc = useCallback(async () => {
    const s = stateRef.current;
    const d = s.doc;
    if (!s.currentFile || !d || !dirtyRef.current) return;
    if (autosaveTimer.current) {
      window.clearTimeout(autosaveTimer.current);
      autosaveTimer.current = null;
    }
    try {
      await api.saveFile(s.currentFile, editTextRef.current, d.encoding, d.eol);
      markSelfSave(s.currentFile);
      dirtyRef.current = false;
      setDirty(false);
      setExternalChange(false);
      setDoc((prev) => (prev ? { ...prev, text: editTextRef.current } : prev));
      // Live-reload for share viewers (no-op when the server is off).
      void api.serveNotifyChange().catch(() => {});
    } catch (err) {
      setError("保存失败: " + String(err));
    }
  }, [markSelfSave]);

  const scheduleAutosave = useCallback(() => {
    if (!autosaveRef.current) return;
    if (autosaveTimer.current) {
      window.clearTimeout(autosaveTimer.current);
    }
    autosaveTimer.current = window.setTimeout(() => {
      void saveDoc();
    }, 1500);
  }, [saveDoc]);

  const markDirty = useCallback(
    (text: string) => {
      editTextRef.current = text;
      if (!dirtyRef.current) {
        dirtyRef.current = true;
        setDirty(true);
      }
      scheduleAutosave();
    },
    [scheduleAutosave],
  );

  /** Debounced rebuild of the split-view preview from the editor buffer.
   * Responses carry a revision; anything that lost the latest-wins race is
   * dropped on arrival. Call sites that just flipped the mode pass it via
   * `forMode`: stateRef still holds the previous mode until React re-renders. */
  const refreshPreview = useCallback((immediate: boolean, forMode?: Mode) => {
    if ((forMode ?? stateRef.current.mode) !== "split") return;
    if (previewTimer.current != null) {
      window.clearTimeout(previewTimer.current);
      previewTimer.current = null;
    }
    const run = async () => {
      const rev = ++previewRevRef.current;
      try {
        const meta = await api.previewUpdate(
          editTextRef.current,
          stateRef.current.currentFile ?? "",
        );
        if (rev === previewRevRef.current) setPreviewMeta(meta);
      } catch (err) {
        if (rev === previewRevRef.current) {
          setError("预览渲染失败: " + String(err));
        }
      }
    };
    if (immediate) {
      void run();
    } else {
      previewTimer.current = window.setTimeout(() => void run(), 280);
    }
  }, []);

  const handleEditorChange = useCallback(
    (text: string) => {
      markDirty(text);
      refreshPreview(false);
      setDocVersion((v) => v + 1);
    },
    [markDirty, refreshPreview],
  );

  const headingOwnerMap = useMemo(
    () => headingOwners(previewMeta?.blocks ?? []),
    [previewMeta],
  );

  /** Editor scrolled (or jumped): drive the preview from its viewport top. */
  const handleEditorScroll = useCallback(() => {
    if (editorScrollRaf.current != null) return;
    editorScrollRaf.current = requestAnimationFrame(() => {
      editorScrollRaf.current = null;
      const now = Date.now();
      if (!lockAllows(syncLockRef.current, "editor", now)) return;
      const ed = editorRef.current;
      const m = previewMetaRef.current;
      const pv = previewRef.current;
      if (!ed || !m || !pv || m.blocks.length === 0) return;
      const block = blockAtLine(m.blocks, ed.getTopLine());
      if (!block) return;
      syncTargetBiRef.current = nextSyncTarget(block.bi);
      pv.scrollToBlock(block.bi);
      syncLockRef.current = { source: "editor", until: now + SYNC_LOCK_MS };
      setActiveHeading(headingOwnerMap[block.bi] ?? null);
    });
  }, [headingOwnerMap]);

  /** Preview scrolled to a new top block: update the outline highlight, and
   * drive the editor back when the user (not our own sync) scrolled it. */
  const handlePreviewTopBi = useCallback(
    (bi: number) => {
      const m = previewMetaRef.current;
      // The preview's top block becomes the rebuild sync target. The editor
      // path updates it on editor scrolls; without this, an edit made right
      // after scrolling only the preview (the editor's follow is suppressed
      // by the 150ms echo lock, so it never reports its position) would
      // rebuild the preview re-anchored to the editor's stale target — the
      // document top.
      syncTargetBiRef.current = nextSyncTarget(bi);
      setActiveHeading(headingOwnerMap[bi] ?? null);
      // Share viewers follow the preview position while serving in
      // follow/edit mode; paused briefly after a remote-driven scroll.
      if (
        stateRef.current.serveUrl &&
        servePermsRef.current?.follow &&
        Date.now() >= remoteGuardRef.current
      ) {
        void api
          .serveBroadcastScroll(
            m?.blocks[bi]?.startLine ?? null,
            headingOwnerMap[bi] ?? null,
            null,
          )
          .catch(() => {});
      }
      const now = Date.now();
      if (!lockAllows(syncLockRef.current, "preview", now)) return;
      const line = m?.blocks[bi]?.startLine;
      if (line == null) return;
      syncLockRef.current = { source: "preview", until: now + SYNC_LOCK_MS };
      editorRef.current?.scrollToLine(line);
    },
    [headingOwnerMap],
  );

  /** Remote viewer scrolled (share sync): move the local view. Split mode
   * follows by source line (the editor drives the preview); read mode
   * prefers the heading anchor, falling back to a viewport fraction. */
  const applyRemoteScroll = useCallback(
    (p: { line?: number | null; heading?: string | null; frac?: number | null }) => {
      const s = stateRef.current;
      remoteGuardRef.current = Date.now() + 700;
      if (s.mode === "split") {
        if (p.line != null) editorRef.current?.scrollToLine(p.line);
        return;
      }
      if (p.heading) {
        if (s.doc?.chunked) chunkedReaderRef.current?.jumpTo(p.heading);
        else document.getElementById(p.heading)?.scrollIntoView({ block: "start" });
        return;
      }
      if (p.frac != null) {
        const wrap = document.querySelector(".reader-wrap");
        const sc =
          (wrap?.querySelector(".chunked-scroll") as HTMLElement | null) ??
          (wrap as HTMLElement | null);
        if (sc) {
          const max = sc.scrollHeight - sc.clientHeight;
          if (max > 0) sc.scrollTop = p.frac * max;
        }
      }
    },
    [],
  );

  const handleSplitResize = useCallback(
    (ratio: number) => {
      setSplitRatio(ratio);
      persist({ split: { editorSide: stateRef.current.editorSide, ratio } });
    },
    [persist],
  );

  const handleSplitSwap = useCallback(() => {
    const next = flipSide(stateRef.current.editorSide);
    // The ratio tracks the editor pane; swapping sides mirrors the fraction
    // so the editor keeps its on-screen width.
    const nextRatio = 1 - stateRef.current.splitRatio;
    setEditorSide(next);
    setSplitRatio(nextRatio);
    persist({ split: { editorSide: next, ratio: nextRatio } });
  }, [persist]);

  const openFolder = useCallback(
    async (path: string) => {
      try {
        const nodes = await api.loadTree(path);
        await api.watchFolder(path);
        setRoot(path);
        setTree(nodes);
        setError(null);
        persist({ lastFolder: path });
      } catch (err) {
        setError("打开文件夹失败: " + String(err));
      }
    },
    [persist],
  );

  /** Immediate one-shot tree rescan after a context-menu operation (the
   * watcher would also catch it, but only after its debounce). */
  const rescanTree = useCallback(() => {
    const r = stateRef.current.root;
    if (!r) return;
    api.loadTree(r).then(setTree).catch(() => {
      /* folder may have been removed; keep last tree */
    });
  }, []);

  const toggleExpanded = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const expandDir = useCallback((path: string) => {
    setExpanded((prev) => (prev.has(path) ? prev : new Set(prev).add(path)));
  }, []);

  const openFile = useCallback(
    async (path: string) => {
      try {
        // Switching files with unsaved edits: save before leaving.
        if (dirtyRef.current) {
          await saveDoc();
        }
        const d = await api.openDoc(path);
        setCurrentFile(path);
        setDoc(d);
        editTextRef.current = d.text;
        dirtyRef.current = false;
        setDirty(false);
        setExternalChange(false);
        setActiveHeading(null);
        setError(null);
        await api.setCurrentFile(path);
        // Share viewers follow the open document; announce the switch.
        void api.serveNotifyChange().catch(() => {});
        const nextRecent = upsertRecent(path, recentFilesRef.current);
        recentFilesRef.current = nextRecent;
        setRecentFiles(nextRecent);
        persist({ lastFile: path, recentFiles: nextRecent });
        if (stateRef.current.mode === "split") {
          syncTargetBiRef.current = 0;
          refreshPreview(true);
        }
      } catch (err) {
        setError("打开文件失败: " + String(err));
        // Drop a history entry that points at a file that is now gone, so it
        // stops resurfacing in Quick Open.
        const next = recentFilesRef.current.filter((p) => p !== path);
        if (next.length !== recentFilesRef.current.length) {
          recentFilesRef.current = next;
          setRecentFiles(next);
          persist({ recentFiles: next });
        }
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [persist, refreshPreview],
  );

  const chooseFolder = useCallback(async () => {
    const path = await api.pickFolder();
    if (path) {
      if (dirtyRef.current) await saveDoc();
      setCurrentFile(null);
      setDoc(null);
      await api.setCurrentFile(null);
      await openFolder(path);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openFolder]);

  const chooseFile = useCallback(async () => {
    const path = await api.pickFile();
    if (path) await openFile(path);
  }, [openFile]);

  // Open a file from search results, then position the view: read mode
  // scrolls the rendered text to the first match, split mode jumps the
  // editor to the hit's line; chunked docs (over 1MB) open without
  // positioning.
  const handleSearchHit = useCallback(
    async (path: string, query: string, line?: number) => {
      setQuickOpen(false);
      await openFile(path);
      const mode = stateRef.current.mode;
      if (mode === "split") {
        if (line == null) return;
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            editorRef.current?.scrollToLine(line);
          });
        });
        return;
      }
      if (!query || mode !== "read") return;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          scrollToText(document.querySelector(".reader-wrap"), query);
        });
      });
    },
    [openFile],
  );

  const reloadCurrent = useCallback(async () => {
    const s = stateRef.current;
    if (!s.currentFile) return;
    try {
      const d = await api.openDoc(s.currentFile);
      setDoc(d);
      editTextRef.current = d.text;
      dirtyRef.current = false;
      setDirty(false);
      setExternalChange(false);
    } catch (err) {
      setError("重新加载失败: " + String(err));
    }
  }, []);

  const switchMode = useCallback(
    async (next: Mode) => {
      if (next === stateRef.current.mode) return;
      const prev = stateRef.current.mode;
      if (next === "read") {
        await saveDoc();
        // The reading view renders doc.html / chunked HTML that open_doc
        // built once at open time — saving only refreshes the text, so an
        // image pasted in the editor never showed up. Re-open the just-
        // saved file to regenerate the rendered content.
        const file = stateRef.current.currentFile;
        if (file) {
          try {
            const d = await api.openDoc(file);
            setDoc(d);
            setReadRev((v) => v + 1);
          } catch (err) {
            setError("重新加载失败: " + String(err));
          }
        }
      }
      editTextRef.current = nextEditorText(
        next,
        prev,
        editTextRef.current,
        stateRef.current.doc?.text ?? "",
      );
      setMode(next);
      if (prev === "read" && next !== "read") {
        // Zen sections only exist inside the reader. Leaving read mode must
        // drop the now-invisible zen state, or the next Ctrl+Shift+Z would
        // toggle it OFF with nothing visible happening.
        setZenOn(false);
      }
      if (next === "split") {
        syncTargetBiRef.current = 0;
        refreshPreview(true, "split");
      }
    },
    [saveDoc, refreshPreview],
  );

  const toggleZen = useCallback(async () => {
    if (stateRef.current.doc?.chunked) {
      setInfo("分块渲染的大文档(>1MB)暂不支持专注模式");
      return;
    }
    if (stateRef.current.mode !== "read") {
      // The chord must always produce a visible effect: re-entering reading
      // view turns zen ON, instead of toggling the stale hidden state.
      await switchMode("read");
      setZenOn(true);
    } else {
      setZenOn((v) => !v);
    }
    setZenPos(null);
  }, [switchMode]);

  const handleZenUnavailable = useCallback(() => {
    setZenOn(false);
    setInfo("当前文档没有可用的分节标题(同一层级需至少两个),专注模式未开启");
  }, []);

  const toggleFullscreen = useCallback(async () => {
    const next = !fullscreenOn;
    try {
      await api.setFullscreen(next);
      setFullscreenOn(next);
      if (next) setInfo("全屏模式:按 F11 或 Esc 退出");
    } catch (err) {
      setError("切换全屏失败: " + String(err));
    }
  }, [fullscreenOn]);

  const exportHtml = useCallback(async () => {
    const s = stateRef.current;
    if (!s.currentFile || !s.doc) return;
    if (dirtyRef.current) await saveDoc();
    const stem = s.currentFile.split(/[\\/]/).pop()?.replace(/\.(md|markdown)$/i, "") ?? "文档";
    const out = await api.pickExportPath(`${stem}.html`);
    if (!out) return;
    try {
      await api.exportHtml(s.currentFile, out, s.themeName, true);
      setInfo(`已导出: ${out}`);
    } catch (err) {
      setError("导出失败: " + String(err));
    }
  }, [saveDoc]);

  const startServe = useCallback(async (lan: boolean, follow: boolean, edit: boolean) => {
    if (lan) {
      const modeLabel = edit
        ? "协作编辑 (远端可修改并保存文档)"
        : follow
          ? "同步浏览 (双向滚动同步)"
          : "只读";
      if (
        !window.confirm(
          `局域网分享将绑定 0.0.0.0 并可能触发防火墙授权弹窗,同一网络内持有链接的设备都能访问当前文档及其目录下的图片等附件。\n\n模式: ${modeLabel}\n确认继续?`,
        )
      ) {
        return;
      }
    }
    try {
      const url = await api.serveStart(servePortRef.current, lan, follow, edit);
      setServeUrl(url);
      setServePerms({ follow, edit });
      setFollowRemote(false);
      setInfo(`分享服务已启动: ${url}`);
    } catch (err) {
      setError("启动分享服务失败: " + String(err));
    }
  }, []);

  const stopServe = useCallback(async () => {
    try {
      await api.serveStop();
      setServeUrl(null);
      setServePerms(null);
      setFollowRemote(false);
      setInfo("分享服务已停止");
    } catch (err) {
      setError("停止分享服务失败: " + String(err));
    }
  }, []);

  const openServe = useCallback(async () => {
    const url = stateRef.current.serveUrl;
    if (url) await openUrl(url);
  }, []);

  // About entries: project repo and the releases page (the update channel —
  // installers are published there; overwrite-install keeps all settings).
  const openExternal = useCallback(async (url: string) => {
    try {
      await openUrl(url);
    } catch (err) {
      setError("无法在浏览器打开链接: " + String(err));
    }
  }, []);

  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion(""));
  }, []);

  // Share entries in the ⋯ menu exist only in `--features share` builds; the
  // command is registered in both builds so this never rejects.
  useEffect(() => {
    api
      .shareAvailable()
      .then(setShareAvailable)
      .catch(() => setShareAvailable(false));
  }, []);

  // Link navigation inside markdown (preview click / Ctrl+click in source):
  // web → browser, md → open in app (folder tree untouched), other local
  // files → system default app.
  const handleOpenLink = useCallback(
    (href: string) => {
      const s = stateRef.current;
      void openMarkdownLink(href, {
        currentFile: s.currentFile,
        root: s.root,
        openFile,
        notify: setInfo,
      });
    },
    [openFile],
  );

  // In-document find/replace panel. `replace` expands the replace row; in
  // read mode replace is unavailable and it degrades to plain find.
  const openFind = useCallback((replace: boolean) => {
    if (!stateRef.current.doc) return;
    setFindShowReplace(replace && stateRef.current.mode !== "read");
    setFindOpen(true);
    setFindFocusNonce((v) => v + 1);
  }, []);

  const closeFind = useCallback(() => setFindOpen(false), []);

  /** Quick Open modal; `content` starts it in workspace content-search mode,
   * `query` prefills the search text (context-menu "search references"). */
  const openQuickOpen = useCallback((content: boolean, query = "") => {
    setQuickContent(content);
    setQuickQuery(query);
    setQuickOpen(true);
  }, []);

  /** SourceEditor hands us its search bridge for the panel. */
  const handleEditorViewReady = useCallback((search: SourceSearch) => setSourceSearch(search), []);
  const handleEditorViewDestroy = useCallback(() => {
    // The unmount path never fires blur — drop the focus flag explicitly so
    // global chords (Ctrl+B sidebar etc.) work again in read mode.
    editorFocusedRef.current = false;
    setSourceSearch(null);
  }, []);
  const handleEditorFocusChange = useCallback((focused: boolean) => {
    editorFocusedRef.current = focused;
  }, []);

  // TitleBar actions (the former native-menu entries) routed by id. No
  // fireOnce here: each action has a single entry point now, unlike the old
  // menu-accelerator + webview-keydown double path that shortcuts.ts still
  // collapses.
  const routeActionRef = useRef<(id: string) => void>(() => {});
  routeActionRef.current = (id: string) => {
    switch (id) {
      case "open-folder":
        void chooseFolder();
        break;
      case "open-file":
        void chooseFile();
        break;
      case "search-dir":
        openQuickOpen(true);
        break;
      case "quick-open":
        openQuickOpen(false);
        break;
      case "find":
        openFind(false);
        break;
      case "replace":
        openFind(true);
        break;
      case "save":
        void saveDoc();
        break;
      case "export-html":
        void exportHtml();
        break;
      case "toggle-sidebar":
        setSidebarVisible((v) => !v);
        break;
      case "serve-local":
        void startServe(false, false, false);
        break;
      case "serve-lan":
        void startServe(true, false, false);
        break;
      case "serve-lan-follow":
        void startServe(true, true, false);
        break;
      case "serve-lan-edit":
        void startServe(true, true, true);
        break;
      case "serve-stop":
        void stopServe();
        break;
      case "serve-open":
        void openServe();
        break;
      case "open-repo":
        void openExternal(REPO_URL);
        break;
      case "open-releases":
        void openExternal(RELEASES_URL);
        break;
    }
  };
  const routeAction = useCallback((id: string) => routeActionRef.current(id), []);

  // ── Sidebar file-tree context menu ─────────────────────────────────
  // `node === null` means the blank area / workspace root. The target is
  // captured at open time (ctxTargetRef) so menu actions can't race a
  // quickly-reopened menu: they read it once, synchronously.
  const ctxTargetRef = useRef<TreeNode | null>(null);
  /** App-internal clipboard for 复制/剪切 → 粘贴 (system file clipboard is
   * out of scope; duplicates cover the copy-within-folder case). */
  const clipRef = useRef<{ paths: string[]; cut: boolean } | null>(null);
  const treeRef = useRef<TreeNode[]>([]);
  treeRef.current = tree;

  const closeCtxMenu = useCallback(() => setCtxMenu(null), []);

  const openTreeMenu = useCallback(
    (e: ReactMouseEvent, node: TreeNode | null) => {
      e.preventDefault();
      e.stopPropagation();
      const s = stateRef.current;
      if (!s.root) return;
      ctxTargetRef.current = node;
      setEditorMenu(null);
      const hasClip = clipRef.current != null;
      const canInsert = !!s.currentFile && s.mode !== "read";
      const items: CtxEntry[] = [];
      if (node == null) {
        items.push(
          { type: "item", id: "new-file", label: "新建 Markdown 文件" },
          { type: "item", id: "new-dir", label: "新建文件夹" },
          { type: "sep" },
          { type: "item", id: "reveal", label: "在资源管理器中打开" },
          { type: "item", id: "refresh", label: "刷新" },
        );
        if (hasClip) {
          items.push({ type: "sep" }, { type: "item", id: "paste", label: "粘贴" });
        }
      } else if (node.isDir) {
        items.push(
          { type: "item", id: "new-file", label: "新建 Markdown 文件" },
          { type: "item", id: "new-dir", label: "新建文件夹" },
          { type: "sep" },
          { type: "item", id: "reveal", label: "在资源管理器中打开" },
          { type: "item", id: "rename", label: "重命名", shortcut: "F2" },
          { type: "item", id: "duplicate", label: "创建副本" },
          { type: "item", id: "copy", label: "复制" },
          { type: "item", id: "cut", label: "剪切" },
        );
        if (hasClip) items.push({ type: "item", id: "paste", label: "粘贴" });
        items.push({ type: "sep" }, { type: "item", id: "delete", label: "删除", danger: true });
      } else {
        items.push(
          { type: "item", id: "open", label: "打开" },
          { type: "item", id: "reveal", label: "在资源管理器中显示" },
          { type: "item", id: "search-name", label: "在目录内搜索该文件" },
          { type: "sep" },
          { type: "item", id: "copy-path", label: "复制文件路径" },
          { type: "item", id: "copy-rel", label: "复制相对路径" },
          { type: "item", id: "copy-name", label: "复制文件名" },
          { type: "sep" },
          { type: "item", id: "copy-md-link", label: "复制 Markdown 链接" },
          {
            type: "item",
            id: "insert-link",
            label: "插入链接到当前文档",
            disabled: !canInsert,
          },
          { type: "sep" },
          { type: "item", id: "rename", label: "重命名", shortcut: "F2" },
          { type: "item", id: "duplicate", label: "创建副本" },
          { type: "item", id: "copy", label: "复制" },
          { type: "item", id: "cut", label: "剪切" },
          { type: "sep" },
          { type: "item", id: "delete", label: "删除", danger: true },
        );
      }
      setCtxMenu({ x: e.clientX, y: e.clientY, entries: items });
    },
    [],
  );

  const treeActionRef = useRef<(id: string) => void>(() => {});
  treeActionRef.current = (id: string) => {
    const node = ctxTargetRef.current;
    const s = stateRef.current;
    const rootDir = s.root;
    if (!rootDir) return;
    switch (id) {
      case "open":
        if (node) void openFile(node.path);
        break;
      case "reveal":
        // Entries are revealed (selected in their parent); the workspace
        // root itself is opened directly.
        if (node) {
          revealItemInDir(node.path).catch((err) =>
            setError("打开资源管理器失败: " + String(err)),
          );
        } else {
          openPath(rootDir).catch((err) => setError("打开资源管理器失败: " + String(err)));
        }
        break;
      case "refresh":
        rescanTree();
        break;
      case "search-name":
        if (node) openQuickOpen(true, stemOf(node.name));
        break;
      case "copy-path":
        if (node) void copyText(node.path).then((ok) => setInfo(ok ? "路径已复制" : "复制失败"));
        break;
      case "copy-rel":
        if (node)
          void copyText(relativePathInRoot(rootDir, node.path)).then((ok) =>
            setInfo(ok ? "相对路径已复制" : "复制失败"),
          );
        break;
      case "copy-name":
        if (node) void copyText(node.name).then((ok) => setInfo(ok ? "文件名已复制" : "复制失败"));
        break;
      case "copy-md-link": {
        if (!node) break;
        // Relative to the open document so it resolves when pasted there;
        // without a document, root-relative.
        const href = relativeLinkHref(s.currentFile ?? rootDir, node.path);
        void copyText(mdLinkTag(linkLabel(node.name, "doc"), href)).then((ok) =>
          setInfo(ok ? "Markdown 链接已复制,可粘贴到其他文档" : "复制失败"),
        );
        break;
      }
      case "insert-link": {
        if (!node) break;
        const href = relativeLinkHref(s.currentFile ?? rootDir, node.path);
        if (!editorRef.current?.insertAtCursor(mdLinkTag(linkLabel(node.name, "doc"), href))) {
          setInfo("插入链接需要先在源码或分屏模式打开文档");
        }
        break;
      }
      case "rename":
        if (node) setDraft({ kind: "rename", targetPath: node.path, initial: node.name });
        break;
      case "new-file":
        setDraft({ kind: "new-file", parentDir: node?.path ?? rootDir });
        if (node) expandDir(node.path);
        break;
      case "new-dir":
        setDraft({ kind: "new-dir", parentDir: node?.path ?? rootDir });
        if (node) expandDir(node.path);
        break;
      case "duplicate": {
        if (!node) break;
        api
          .copyEntries(rootDir, [node.path], pathDirname(node.path))
          .then(() => {
            rescanTree();
            setInfo(`已创建 "${node.name}" 的副本`);
          })
          .catch((err) => setError("创建副本失败: " + String(err)));
        break;
      }
      case "copy":
        if (node) {
          clipRef.current = { paths: [node.path], cut: false };
          setInfo(`已复制 "${node.name}",可在目标文件夹或空白处粘贴`);
        }
        break;
      case "cut":
        if (node) {
          clipRef.current = { paths: [node.path], cut: true };
          setInfo(`已剪切 "${node.name}",在目标文件夹或空白处粘贴`);
        }
        break;
      case "paste": {
        const clip = clipRef.current;
        if (!clip) break;
        const dest = node?.isDir ? node.path : node ? pathDirname(node.path) : rootDir;
        const move = clip.cut;
        const op = move
          ? api.moveEntries(rootDir, clip.paths, dest)
          : api.copyEntries(rootDir, clip.paths, dest);
        op.then((n) => {
          if (move) clipRef.current = null;
          expandDir(dest);
          rescanTree();
          setInfo(move ? `已移动 ${n} 项` : `已粘贴 ${n} 项`);
        }).catch((err) => setError("粘贴失败: " + String(err)));
        break;
      }
      case "delete": {
        if (!node) break;
        const sep = node.path.includes("\\") ? "\\" : "/";
        const touchesCurrent =
          !!s.currentFile &&
          (s.currentFile === node.path || s.currentFile.startsWith(node.path + sep));
        const what = node.isDir ? "文件夹" : "文件";
        if (
          !window.confirm(
            `删除${what} "${node.name}"?\n` +
              (node.isDir ? "其中所有内容将一并" : "") +
              "移入回收站,可在回收站恢复。",
          )
        ) {
          break;
        }
        api
          .trashEntry(rootDir, node.path)
          .then(() => {
            if (touchesCurrent) {
              setCurrentFile(null);
              setDoc(null);
              editTextRef.current = "";
              dirtyRef.current = false;
              setDirty(false);
              setExternalChange(false);
              void api.setCurrentFile(null);
              persist({ lastFile: null });
            }
            rescanTree();
            setInfo(`已删除 "${node.name}" (移入回收站)`);
          })
          .catch((err) => setError("删除失败: " + String(err)));
        break;
      }
    }
  };
  const runTreeAction = useCallback((id: string) => treeActionRef.current(id), []);

  // ── Editor (CodeMirror) context menu ────────────────────────────────
  const closeEditorMenu = useCallback(() => setEditorMenu(null), []);
  // Opened from the document-level contextmenu listener (which currently
  // lets .cm-editor through); preventDefaults and builds the entry list.
  const openEditorMenuRef = useRef<(e: MouseEvent) => void>(() => {});
  openEditorMenuRef.current = (e: MouseEvent) => {
    const s = stateRef.current;
    if (!s.doc) return;
    e.preventDefault();
    setCtxMenu(null);
    menuAnchorRef.current = { x: e.clientX, y: e.clientY };
    setEditorMenu({ x: e.clientX, y: e.clientY, entries: buildEditorMenuEntries(true) });
  };

  // ── Slash palette ("/" or "、" typed in the editor) ─────────────────
  // Same insertion entries as the context menu, minus clipboard and
  // 新建子文档并引用. Selecting an entry consumes the trigger character
  // before inserting, so "／表格" leaves just the table.
  const [slashMenu, setSlashMenu] = useState<{ x: number; y: number; entries: CtxEntry[] } | null>(
    null,
  );
  const slashPosRef = useRef<number | null>(null);
  const slashCharRef = useRef("/");
  const closeSlashMenu = useCallback(() => setSlashMenu(null), []);
  const handleSlashTrigger = useCallback(
    (t: { pos: number; char: string; x: number; y: number }) => {
      setCtxMenu(null);
      setEditorMenu(null);
      slashPosRef.current = t.pos;
      slashCharRef.current = t.char;
      menuAnchorRef.current = { x: t.x, y: t.y };
      setSlashMenu({ x: t.x, y: t.y, entries: buildEditorMenuEntries(false) });
    },
    [],
  );
  const runSlashAction = useCallback((id: string) => {
    setSlashMenu(null);
    const pos = slashPosRef.current;
    const ch = slashCharRef.current;
    const ed = editorRef.current;
    if (ed && pos != null) {
      ed.runCommand((view) => {
        const p = Math.min(pos, view.state.doc.length);
        if (p > 0 && view.state.sliceDoc(p - 1, p) === ch) {
          view.dispatch({ changes: { from: p - 1, to: p }, userEvent: "delete.backward" });
        }
      });
    }
    runEditorActionRef.current(id);
  }, []);
  // Keep typing with the palette open = dismiss it. The keystroke that
  // closes the palette is refocused into the editor so it still lands in
  // the document (focus may sit on a menu item after ↑/↓ navigation); IME
  // composition reports key "Process" and is handled by the editor-side
  // onUserInput instead. No compositionend listener here: for the IME
  // trigger commit it could fire right after the palette opens and close it
  // instantly.
  useEffect(() => {
    if (!slashMenu) return;
    const onKey = (e: KeyboardEvent) => {
      const closes = e.key.length === 1 || e.key === "Backspace" || e.key === "Delete";
      if (!closes) return;
      setSlashMenu(null);
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        editorRef.current?.runCommand(() => {});
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
    };
  }, [slashMenu]);

  /** Insert a picked file as an archived asset, mirroring the paste path. */
  const insertAssetFromFile = async () => {
    const s = stateRef.current;
    if (!s.currentFile) {
      setInfo("插入资源需要先打开文档");
      return;
    }
    const src = await api.pickAsset();
    if (!src || !editorRef.current) return;
    const destDir = assetDestDir(s.root, s.currentFile, s.assetsDir);
    if (!destDir) return;
    try {
      const name = pathBasename(src);
      const finalPath = await api.importAsset(
        s.root ?? pathDirname(s.currentFile),
        src,
        destDir,
        assetBaseName(s.currentFile, name),
      );
      const href = relativeLinkHref(s.currentFile, finalPath);
      const label = linkLabel(name, "file");
      editorRef.current.insertAtCursor(
        isImagePath(name) ? mdImageTag(label, href) : mdLinkTag(label, href),
      );
      setInfo(`已插入 "${name}"`);
    } catch (err) {
      setError("资源归档失败: " + String(err));
    }
  };

  const runEditorActionRef = useRef<(id: string) => void>(() => {});
  runEditorActionRef.current = (id: string) => {
    const ed = editorRef.current;
    const run = (fn: (view: EditorView) => void) => {
      if (!ed?.runCommand(fn)) setInfo("编辑操作需要在源码或分屏模式中进行");
    };
    switch (id) {
      case "cut":
        run((view) => {
          const sel = view.state.selection.main;
          if (sel.empty) return;
          const text = view.state.sliceDoc(sel.from, sel.to);
          void copyText(text).then((ok) => {
            if (ok) view.dispatch({ changes: { from: sel.from, to: sel.to }, userEvent: "delete.cut" });
          });
        });
        break;
      case "copy":
        run((view) => {
          const sel = view.state.selection.main;
          if (!sel.empty) void copyText(view.state.sliceDoc(sel.from, sel.to));
        });
        break;
      case "paste":
        navigator.clipboard
          .readText()
          .then((text) => {
            if (text) ed?.insertAtCursor(text);
          })
          .catch(() => setInfo("无法读取系统剪贴板,可直接 Ctrl+V 粘贴"));
        break;
      case "new-subdoc":
        setSubdocName("");
        setSubdocOpen(true);
        break;
      case "ul":
        run((view) => togglePrefix(view, "ul"));
        break;
      case "ol":
        run((view) => togglePrefix(view, "ol"));
        break;
      case "task":
        run((view) => togglePrefix(view, "task"));
        break;
      case "quote":
        run((view) => togglePrefix(view, "quote"));
        break;
      case "callout-clear":
        run(clearCallout);
        break;
      case "codeblock":
        run(insertCodeBlock);
        break;
      case "table":
        run(insertTable);
        break;
      case "hr":
        run(insertHr);
        break;
      case "mathblock":
        run(insertMathBlock);
        break;
      case "mindmap":
        run(insertMindmap);
        break;
      case "emoji":
        setEmojiAt(menuAnchorRef.current);
        break;
      case "link":
        run(insertLink);
        break;
      case "bold":
        run((view) => toggleWrap(view, "**", "**", { placeholder: "粗体" }));
        break;
      case "italic":
        run((view) => toggleWrap(view, "*", "*", { placeholder: "斜体" }));
        break;
      case "underline":
        run((view) => toggleWrap(view, "<u>", "</u>", { placeholder: "下划线文本" }));
        break;
      case "strike":
        run((view) => toggleWrap(view, "~~", "~~", { placeholder: "删除线" }));
        break;
      case "mark":
        run((view) => toggleWrap(view, "==", "==", { placeholder: "高亮" }));
        break;
      case "sup":
        run((view) => toggleWrap(view, "<sup>", "</sup>", { placeholder: "上标" }));
        break;
      case "sub":
        run((view) => toggleWrap(view, "<sub>", "</sub>", { placeholder: "下标" }));
        break;
      case "inlinecode":
        run((view) => toggleWrap(view, "`", "`", { placeholder: "代码" }));
        break;
      case "kbd":
        run((view) => toggleWrap(view, "<kbd>", "</kbd>", { placeholder: "Ctrl" }));
        break;
      case "inlinemath":
        run((view) => toggleWrap(view, "$", "$", { placeholder: "公式" }));
        break;
      case "insert-asset":
        void insertAssetFromFile();
        break;
      case "insert-image-link":
        run(insertImageLink);
        break;
      case "insert-iframe":
        run(insertIframe);
        break;
      case "insert-video":
        run(insertVideo);
        break;
      case "insert-audio":
        run(insertAudio);
        break;
      default:
        if (id.startsWith("h")) {
          const level = Number(id.slice(1));
          if (level >= 1 && level <= 6) run((view) => togglePrefix(view, level));
        } else if (id.startsWith("callout-")) {
          const type = id.slice("callout-".length);
          run((view) => insertCallout(view, type));
        }
        break;
    }
  };
  const runEditorAction = useCallback((id: string) => runEditorActionRef.current(id), []);

  // ── Editor paste: asset archive & app-clipboard links ──────────────
  /** Import clipboard files into the assets folder, then insert their tags
   * at the cursor. Runs after the paste event has been claimed. */
  const archiveAndInsert = async (files: File[]) => {
    const s = stateRef.current;
    if (!s.currentFile || !s.root || !editorRef.current) return;
    const destDir = assetDestDir(s.root, s.currentFile, s.assetsDir);
    if (!destDir) return;
    const tags: string[] = [];
    try {
      for (const f of files) {
        // Screenshots arrive named ("image.png"); unnamed blobs fall back
        // to the mime subtype so the archive keeps a usable extension.
        const name =
          f.name ||
          (f.type.startsWith("image/") ? `image.${f.type.split("/")[1] || "bin"}` : "file");
        const base = assetBaseName(s.currentFile, name);
        const bytes = new Uint8Array(await f.arrayBuffer());
        const finalPath = await api.saveAsset(s.root, destDir, base, bytes);
        const href = relativeLinkHref(s.currentFile, finalPath);
        const label = linkLabel(name, "img");
        tags.push(isImagePath(name) ? mdImageTag(label, href) : mdLinkTag(label, href));
      }
      if (tags.length > 0) {
        editorRef.current.insertAtCursor(tags.join("\n"));
      }
    } catch (err) {
      setError("资源归档失败: " + String(err));
    }
  };

  const editorPasteRef = useRef<(p: PastePayload) => boolean>(() => false);
  editorPasteRef.current = ({ files }) => {
    const s = stateRef.current;
    if (!s.currentFile || !s.root || !editorRef.current) return false;
    // System clipboard files → archive as assets and insert tags.
    if (files.length > 0) {
      void archiveAndInsert(files);
      return true;
    }
    // Tree-copied file → reference link; the file itself is not copied (md
    // documents are referenced in place, not duplicated into assets).
    const clip = clipRef.current;
    if (clip && !clip.cut && clip.paths.length > 0) {
      const target = clip.paths[0];
      const href = relativeLinkHref(s.currentFile, target);
      editorRef.current.insertAtCursor(
        mdLinkTag(linkLabel(pathBasename(target), "doc"), href),
      );
      setInfo(`已插入对 "${pathBasename(target)}" 的引用链接`);
      return true;
    }
    return false;
  };
  const handleEditorPasteFile = useCallback(
    (p: PastePayload) => editorPasteRef.current(p),
    [],
  );

  const cancelDraft = useCallback(() => setDraft(null), []);

  const commitDraft = useCallback(
    async (name: string) => {
      const d = draft;
      const s = stateRef.current;
      setDraft(null);
      if (!d || !s.root) return;
      try {
        if (d.kind === "rename") {
          const target = pathJoin(pathDirname(d.targetPath), name);
          if (target === d.targetPath) return;
          await api.renameEntry(s.root, d.targetPath, target);
          rescanTree();
          // Track the open document across its rename.
          if (s.currentFile === d.targetPath) {
            setCurrentFile(target);
            void api.setCurrentFile(target);
            const nextRecent = recentFilesRef.current.map((p) =>
              p === d.targetPath ? target : p,
            );
            recentFilesRef.current = nextRecent;
            setRecentFiles(nextRecent);
            persist({ lastFile: target, recentFiles: nextRecent });
          }
          setInfo(`已重命名为 "${name}"`);
        } else if (d.kind === "new-file") {
          const target = pathJoin(d.parentDir, ensureMdExt(name));
          await api.createFile(s.root, target);
          expandDir(d.parentDir);
          rescanTree();
          await openFile(target);
        } else {
          const target = pathJoin(d.parentDir, name);
          await api.createDir(s.root, target);
          expandDir(d.parentDir);
          rescanTree();
        }
      } catch (err) {
        setError("操作失败: " + String(err));
      }
    },
    [draft, expandDir, openFile, persist, rescanTree],
  );
  /** Stable wrapper so the memoized Sidebar doesn't re-render on every tick. */
  const handleCommitDraft = useCallback(
    (name: string) => void commitDraft(name),
    [commitDraft],
  );

  /** 新建子文档并引用: create an .md sibling of the current document and
   * insert a relative link at the cursor. */
  const commitSubdoc = useCallback(async () => {
    const s = stateRef.current;
    const name = subdocName.trim();
    if (!name || !s.currentFile || !s.root) return;
    const dir = pathDirname(s.currentFile);
    const fileName = ensureMdExt(name);
    // Same validation the tree's inline rename runs, against the same
    // sibling set, so conflicts surface before the round-trip.
    const siblings = (findTreeNode(treeRef.current, dir)?.children ?? []).map((c) => c.name);
    const nameErr = entryNameError(fileName, siblings);
    if (nameErr) {
      setInfo(nameErr);
      return;
    }
    const target = pathJoin(dir, fileName);
    try {
      await api.createFile(s.root, target);
      const href = relativeLinkHref(s.currentFile, target);
      editorRef.current?.insertAtCursor(mdLinkTag(stemOf(fileName), href));
      setSubdocOpen(false);
      rescanTree();
      setInfo(`已创建 "${fileName}" 并插入引用`);
    } catch (err) {
      setError("创建子文档失败: " + String(err));
    }
  }, [subdocName, rescanTree]);

  // Share session: mirror the dirty flag so viewers see a "本机有未保存修改"
  // hint (initial state on join + live flips via the server broadcast).
  useEffect(() => {
    if (!serveUrl) return;
    void api.serveSetDirty(dirty).catch(() => {});
  }, [dirty, serveUrl]);

  // Remote viewer events. Scroll moves the local view only when 跟随远端 is
  // on; an edit applies only while the local buffer is clean, otherwise the
  // viewer gets a rejection notice.
  useEffect(() => {
    const unScroll = listen<{
      line?: number | null;
      heading?: string | null;
      frac?: number | null;
    }>("serve-remote-scroll", (event) => {
      if (!followRemoteRef.current) return;
      applyRemoteScroll(event.payload);
    });
    const unEdit = listen<{ text: string }>("serve-remote-edit", async (event) => {
      const s = stateRef.current;
      if (!s.serveUrl) return;
      if (!s.currentFile || !s.doc) {
        void api.serveNotice("本机当前没有打开的文档,远端修改被拒绝").catch(() => {});
        return;
      }
      if (dirtyRef.current) {
        void api
          .serveNotice("本机有未保存的修改,远端修改被拒绝;本机保存后可重试")
          .catch(() => {});
        return;
      }
      editTextRef.current = event.payload.text;
      dirtyRef.current = true;
      setDirty(true);
      setDoc((prev) => (prev ? { ...prev, text: event.payload.text } : prev));
      setInfo("已应用远端修改并保存");
      await saveDoc();
      void api.serveNotice("远端修改已应用").catch(() => {});
    });
    return () => {
      unScroll.then((fn) => fn());
      unEdit.then((fn) => fn());
    };
  }, [applyRemoteScroll, saveDoc]);

  // Read mode: broadcast the local reading position to viewers (split mode
  // broadcasts from the preview's top-block handler instead).
  useEffect(() => {
    if (!serveUrl || !servePerms?.follow || mode !== "read" || !doc) return;
    const wrap = document.querySelector(".reader-wrap");
    if (!wrap) return;
    const sc =
      (wrap.querySelector(".chunked-scroll") as HTMLElement | null) ??
      (wrap as HTMLElement);
    let lastSent = 0;
    let raf: number | null = null;
    const send = () => {
      const now = Date.now();
      if (now < remoteGuardRef.current || now - lastSent < 250) return;
      lastSent = now;
      const max = sc.scrollHeight - sc.clientHeight;
      void api
        .serveBroadcastScroll(null, activeHeadingRef.current, max > 0 ? sc.scrollTop / max : 0)
        .catch(() => {});
    };
    const onScroll = () => {
      if (raf != null) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        send();
      });
    };
    sc.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      sc.removeEventListener("scroll", onScroll);
      if (raf != null) cancelAnimationFrame(raf);
    };
  }, [serveUrl, servePerms, mode, doc]);

  // Clear transient info notices after the banner animation finishes
  // (0.45s slide-in + 2s hold + 0.6s fade-out).
  useEffect(() => {
    if (!info) return;
    const t = window.setTimeout(() => setInfo(null), 3200);
    return () => window.clearTimeout(t);
  }, [info]);

  // Mirror zen preferences onto documentElement for the CSS side.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("zen-on", zenOn);
    root.classList.toggle("zen-dim-blur", zenCfg.effect === "dim-blur");
    root.classList.toggle("zen-emphasis", zenCfg.emphasis);
    root.style.setProperty(
      "--zen-dim",
      zenCfg.effect === "dim-blur" ? "0.15" : "0.22",
    );
  }, [zenOn, zenCfg]);

  // Suppress the webview's default context menu everywhere except text-entry
  // surfaces. The file tree layers its own menu on top via onContextMenu
  // handlers; the CodeMirror editor gets the formatting/insertion menu in
  // place of the native cut/copy/paste entries.
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      const t = e.target;
      if (t instanceof Element && t.closest(".cm-editor")) {
        openEditorMenuRef.current(e);
        return;
      }
      if (
        t instanceof Element &&
        t.closest("input, textarea, select, [contenteditable]")
      ) {
        return;
      }
      e.preventDefault();
    };
    document.addEventListener("contextmenu", onCtx);
    return () => document.removeEventListener("contextmenu", onCtx);
  }, []);

  // Global shortcuts, handled in the capture phase so they win over the
  // focused editor (CodeMirror) and stay identical on every platform. This
  // is the primary path on Windows, where native menu accelerators do not
  // fire while the webview has focus — without it Ctrl+O / Ctrl+Shift+O /
  // Ctrl+E (and the older search/zen chords) would silently do nothing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // F2 renames the active file; Delete deletes the focused tree row.
      // Both are no-ops while typing in any input (incl. the inline rename
      // field) and while an inline edit is already open.
      if (
        !e.repeat &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        (e.key === "F2" || e.key === "Delete") &&
        !(e.target instanceof HTMLElement && e.target.closest("input, textarea, select, [contenteditable]"))
      ) {
        if (e.key === "F2") {
          const s = stateRef.current;
          if (
            s.root &&
            s.currentFile &&
            sidebarVisible &&
            !draft &&
            isInsideRoot(s.root, s.currentFile)
          ) {
            e.preventDefault();
            e.stopPropagation();
            setCtxMenu(null);
            setDraft({
              kind: "rename",
              targetPath: s.currentFile,
              initial: pathBasename(s.currentFile),
            });
          }
          return;
        }
        const row =
          document.activeElement instanceof HTMLElement
            ? document.activeElement.closest<HTMLElement>(".tree-row[data-path]")
            : null;
        const p = row?.dataset.path;
        if (p) {
          const node = findTreeNode(treeRef.current, p);
          if (node) {
            e.preventDefault();
            e.stopPropagation();
            setCtxMenu(null);
            ctxTargetRef.current = node;
            treeActionRef.current("delete");
          }
        }
        return;
      }
      const action = matchShortcut(e, {
        quickOpen,
        findOpen,
        settingsOpen,
        zenOn,
        fullscreenOn,
        hasDoc: !!stateRef.current.doc,
        mode: stateRef.current.mode,
        editorFocused: editorFocusedRef.current,
      });
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      switch (action) {
        case "search":
          fireOnce("search", () => openQuickOpen(true));
          break;
        case "quick-open":
          fireOnce("quick-open", () => openQuickOpen(false));
          break;
        case "zen":
          fireOnce("zen", () => void toggleZen());
          break;
        case "fullscreen":
          fireOnce("fullscreen", () => void toggleFullscreen());
          break;
        case "find":
          fireOnce("find", () => openFind(false));
          break;
        case "replace":
          fireOnce("replace", () => openFind(true));
          break;
        case "reload":
          location.reload();
          break;
        case "mode-cycle":
          fireOnce("mode", () => void switchMode(nextMode(stateRef.current.mode)));
          break;
        case "open-folder":
          fireOnce("open-folder", () => void chooseFolder());
          break;
        case "open-file":
          fireOnce("open-file", () => void chooseFile());
          break;
        case "save":
          fireOnce("save", () => void saveDoc());
          break;
        case "export-html":
          fireOnce("export-html", () => void exportHtml());
          break;
        case "toggle-sidebar":
          setSidebarVisible((v) => !v);
          break;
        case "zen-next":
          zenCtlRef.current?.jumpTo((zenPosRef.current?.idx ?? 0) + 1);
          break;
        case "zen-prev":
          zenCtlRef.current?.jumpTo((zenPosRef.current?.idx ?? 0) - 1);
          break;
        case "zen-exit":
          setZenOn(false);
          break;
        case "exit-fullscreen":
          void toggleFullscreen();
          break;
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [fireOnce, toggleZen, toggleFullscreen, switchMode, openQuickOpen, openFind, chooseFolder, chooseFile, saveDoc, exportHtml, fullscreenOn, zenOn, quickOpen, findOpen, settingsOpen, sidebarVisible, draft]);

  // The reader gutters (left/right of the centered 860px body) belong to the
  // overflow-hidden wrapper, so the wheel hits a dead zone there — forward it
  // to the scroll container instead. Covers both Reader and ChunkedReader,
  // which share the .md-body scroller.
  useEffect(() => {
    if (mode !== "read") return;
    const wrap = readerWrapRef.current;
    if (!wrap) return;
    const onWheel = (e: WheelEvent) => {
      const body = wrap.querySelector<HTMLElement>(".md-body");
      if (!body) return;
      if (e.target instanceof Node && body.contains(e.target)) return;
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      body.scrollTop += e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    };
    wrap.addEventListener("wheel", onWheel, { passive: false });
    return () => wrap.removeEventListener("wheel", onWheel);
  }, [mode, doc]);

  // Restore last session (folder/file/theme) on startup. A path handed over
  // by the launching process (double-clicked .md) takes priority over the
  // stored lastFile; the folder tree still restores as-is.
  useEffect(() => {
    (async () => {
      try {
        const pending = await api.takePendingOpen();
        const cfg = await api.getConfig();
        const theme = cfg.theme ?? "light";
        setThemeName(theme);
        const t = await applyTheme(theme);
        setThemeDark(t?.dark ?? false);
        if (cfg.servePort && cfg.servePort > 0 && cfg.servePort < 65536) {
          setServePort(cfg.servePort);
        }
        if (cfg.autosave != null) setAutosaveOn(cfg.autosave);
        if (cfg.recentFiles) {
          setRecentFiles(cfg.recentFiles);
          recentFilesRef.current = cfg.recentFiles;
        }
        if (cfg.background) {
          const merged = normalizeBg(cfg.background);
          setBg(merged);
          applyBackground(merged);
        }
        if (cfg.zen) setZenCfg(normalizeZen(cfg.zen));
        if (cfg.split) {
          setEditorSide(normalizeSide(cfg.split.editorSide));
          setSplitRatio(normalizeRatio(cfg.split.ratio));
        }
        setAssetsDir(cfg.assetsDir ?? null);
        if (cfg.lastFolder) await openFolder(cfg.lastFolder);
        if (pending) await openFile(pending);
        else if (cfg.lastFile) await openFile(cfg.lastFile);
      } catch (err) {
        console.error("restore session:", err);
      } finally {
        hydrated.current = true;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Files pushed by the backend after launch: a second double-click launch
  // (single-instance) or macOS Opened event. Taking the pending slot keeps
  // the startup path from opening the same file twice.
  const openFileRef = useRef(openFile);
  openFileRef.current = openFile;
  useEffect(() => {
    const unlisten = listen<string>("open-file-arg", async (event) => {
      const pending = await api.takePendingOpen();
      const path = event.payload || pending;
      if (path) void openFileRef.current(path);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // External filesystem changes: refresh the tree, then decide what the
  // event means for the open file (our own save echoes are suppressed —
  // see decideFsChange; real changes prompt via the overlay banner when
  // there are unsaved edits, or reload silently otherwise).
  useEffect(() => {
    // Watcher events arrive in bursts (an autosave trips tmp+rename; an
    // external batch touches many files). A trailing debounce collapses
    // each burst into one directory rescan.
    let treeTimer: number | null = null;
    const refreshTree = (rootDir: string) => {
      if (treeTimer != null) window.clearTimeout(treeTimer);
      treeTimer = window.setTimeout(() => {
        treeTimer = null;
        api
          .loadTree(rootDir)
          .then(setTree)
          .catch(() => {
            /* folder may have been removed; keep last tree */
          });
      }, 600);
    };
    const unlisten = listen<{ paths: string[] }>("fs-change", (event) => {
      const s = stateRef.current;
      if (s.root) refreshTree(s.root);
      const decision = decideFsChange({
        paths: event.payload.paths,
        currentFile: s.currentFile,
        mode: s.mode,
        dirty: dirtyRef.current,
        selfSave: selfSaveRef.current,
        now: Date.now(),
      });
      if (decision !== "reload") {
        if (decision === "prompt") setExternalChange(true);
        return;
      }
      void api
        .openDoc(s.currentFile!)
        .then((d) => {
          setDoc(d);
          editTextRef.current = d.text;
          setExternalChange(false);
        })
        .catch(() => {
          /* file may be mid-write; next event will refresh */
        });
    });
    return () => {
      unlisten.then((fn) => fn());
      if (treeTimer != null) window.clearTimeout(treeTimer);
    };
  }, []);

  // Unsaved-changes guard on exit: every close path (title-bar ✕, Alt+F4,
  // taskbar) raises Tauri's CloseRequested. A clean buffer closes straight
  // away — Ctrl+S or autosave already cleared the dirty flag — while a dirty
  // one is held for the in-app dialog.
  useEffect(() => {
    const unlisten = getCurrentWindow().onCloseRequested((event) => {
      if (exitApprovedRef.current || !dirtyRef.current) return;
      event.preventDefault();
      setExitAsk(true);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  /** Exit after the dialog's decision. `save` writes the buffer first; a
   * failed save keeps the app open (error banner shown) so nothing is
   * silently lost. */
  const confirmExit = useCallback(
    async (save: boolean) => {
      setExitAsk(false);
      // A pending autosave must not fire mid-exit and override a discard.
      if (autosaveTimer.current) {
        window.clearTimeout(autosaveTimer.current);
        autosaveTimer.current = null;
      }
      exitApprovedRef.current = true;
      appExitingRef.current = true;
      if (save) {
        await saveDoc();
        if (dirtyRef.current) {
          exitApprovedRef.current = false;
          appExitingRef.current = false;
          return;
        }
      }
      try {
        await getCurrentWindow().close();
      } catch (err) {
        exitApprovedRef.current = false;
        appExitingRef.current = false;
        setError("退出失败: " + String(err));
      }
    },
    [saveDoc],
  );

  // Best-effort guard for the in-app reload path (F5); real window closes go
  // through onCloseRequested above. The exit flow sets appExitingRef so a
  // "不保存退出" decision is not overridden by a last-second save.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (appExitingRef.current) return;
      if (dirtyRef.current) {
        void saveDoc();
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [saveDoc]);

  const changeTheme = useCallback(
    async (name: string) => {
      setThemeName(name);
      const t = await applyTheme(name);
      setThemeDark(t?.dark ?? false);
      persist({ theme: name });
    },
    [persist],
  );

  const updateBg = useCallback(
    (patch: Partial<BackgroundConfig>) => {
      const next = normalizeBg({ ...stateRef.current.bg, ...patch });
      setBg(next);
      applyBackground(next);
      persist({ background: next });
    },
    [persist],
  );

  const pickBgImage = useCallback(async () => {
    const path = await api.pickImage();
    if (path) updateBg({ path, enabled: true });
  }, [updateBg]);

  const updateZenCfg = useCallback(
    (patch: Partial<ResolvedZen>) => {
      const next = normalizeZen({ ...stateRef.current.zenCfg, ...patch });
      setZenCfg(next);
      persist({ zen: next });
    },
    [persist],
  );

  const bgFileName = bg.path?.split(/[\\/]/).pop() ?? null;

  const jumpToHeading = useCallback(
    (id: string) => {
      if (stateRef.current.mode === "split") {
        // Outline click in split view: jump the editor to the heading's
        // source line; the preview follows via scroll sync.
        const m = previewMetaRef.current;
        const item = m?.outline.find((o) => o.id === id);
        const line = item?.bi != null ? m?.blocks[item.bi]?.startLine : undefined;
        if (line != null) editorRef.current?.scrollToLine(line);
        return;
      }
      if (stateRef.current.doc?.chunked) {
        chunkedReaderRef.current?.jumpTo(id);
      } else {
        document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    },
    [],
  );

  // The sidebar outline in split view comes from the live preview build so
  // it stays aligned with the edited buffer.
  const currentOutline =
    mode === "split" && previewMeta
      ? previewMeta.outline
      : doc?.chunked
        ? doc.chunked.outline
        : (doc?.outline ?? []);

  return (
    <div className={fullscreenOn ? "app fullscreen" : "app"}>
      {!fullscreenOn && (
        <TitleBar
          mode={mode}
          hasDoc={!!doc}
          docName={currentFile?.split(/[\\/]/).pop() ?? null}
          docPath={currentFile}
          dirty={dirty}
          zenAvailable={!!doc && !doc.chunked}
          zenOn={zenOn}
          fullscreenOn={fullscreenOn}
          themeName={themeName}
          themeLabels={THEME_LABELS}
          shareAvailable={shareAvailable}
          version={appVersion || null}
          onMode={(next) => void switchMode(next)}
          onZen={() => void toggleZen()}
          onFullscreen={() => void toggleFullscreen()}
          onTheme={(name) => void changeTheme(name)}
          onSettings={() => setSettingsOpen(true)}
          onAction={routeAction}
        />
      )}

      {/* Banner curtain: fixed overlay above everything (z 300). It slides
          down over the content without ever reflowing it. */}
      <div className="banner-layer">
        {error && <div className="error-bar">{error}</div>}
        {info && <div className="notice-bar info">{info}</div>}
        {externalChange && (
          <div className="notice-bar external">
            <span>文件已被外部修改。</span>
            <button onClick={reloadCurrent}>重新加载</button>
            <button onClick={() => setExternalChange(false)}>忽略</button>
          </div>
        )}
      </div>

      <div className="main">
        {!fullscreenOn && sidebarVisible && (
          <Sidebar
            tab={tab}
            onTabChange={setTab}
            tree={tree}
            outline={currentOutline}
            activeFile={currentFile}
            activeHeading={activeHeading}
            hasFolder={root !== null}
            rootPath={root}
            expanded={expanded}
            onToggle={toggleExpanded}
            draft={draft}
            onCommitDraft={handleCommitDraft}
            onCancelDraft={cancelDraft}
            onNodeContextMenu={openTreeMenu}
            onOpenFile={openFile}
            onJump={jumpToHeading}
          />
        )}
        <div className="content">
          {doc ? (
            <>
              {mode === "read" ? (
                <div className="reader-wrap" ref={readerWrapRef}>
                  {doc.chunked ? (
                    <ChunkedReader
                      ref={chunkedReaderRef}
                      key={`${doc.chunked.token}-${readRev}`}
                      meta={doc.chunked}
                      path={currentFile ?? ""}
                      dark={themeDark}
                      onActiveHeading={setActiveHeading}
                      onOpenLink={handleOpenLink}
                    />
                  ) : (
                    <Reader
                      doc={doc}
                      dark={themeDark}
                      onActiveHeading={setActiveHeading}
                      zenOn={zenOn && mode === "read"}
                      zenLevel={zenCfg.level}
                      onZenPos={setZenPos}
                      onZenUnavailable={handleZenUnavailable}
                      onZenController={(ctl) => (zenCtlRef.current = ctl)}
                      onOpenLink={handleOpenLink}
                    />
                  )}
                  {findOpen && (
                    <SearchPanel
                      mode={mode}
                      source={null}
                      docText={doc.text}
                      docVersion={docVersion}
                      showReplace={findShowReplace}
                      onShowReplace={setFindShowReplace}
                      onClose={closeFind}
                      readWrap={readerWrapRef}
                      focusNonce={findFocusNonce}
                    />
                  )}
                </div>
              ) : mode === "split" ? (
                <SplitView
                  side={editorSide}
                  ratio={splitRatio}
                  onResizeEnd={handleSplitResize}
                  onSwap={handleSplitSwap}
                  editor={
                    <div className="editor-wrap">
                      <Suspense fallback={<div className="editor-loading">正在加载编辑器…</div>}>
                        <SourceEditor
                          key={currentFile ?? ""}
                          ref={editorRef}
                          initialText={editTextRef.current}
                          text={doc.text}
                          onChange={handleEditorChange}
                          onSave={saveDoc}
                          onScroll={handleEditorScroll}
                          onOpenLink={handleOpenLink}
                          onPasteFile={handleEditorPasteFile}
                          onViewReady={handleEditorViewReady}
                          onViewDestroy={handleEditorViewDestroy}
                          onFocusChange={handleEditorFocusChange}
                          onSlashTrigger={handleSlashTrigger}
                          onUserInput={closeSlashMenu}
                        />
                      </Suspense>
                      {findOpen && (
                        <SearchPanel
                          mode={mode}
                          source={sourceSearch}
                          docText={doc.text}
                          docVersion={docVersion}
                          showReplace={findShowReplace}
                          onShowReplace={setFindShowReplace}
                          onClose={closeFind}
                          readWrap={readerWrapRef}
                          focusNonce={findFocusNonce}
                        />
                      )}
                    </div>
                  }
                  preview={
                    <div className="reader-wrap split-preview">
                      {previewMeta ? (
                        <PreviewPane
                          ref={previewRef}
                          meta={previewMeta}
                          docKey={currentFile ?? ""}
                          dark={themeDark}
                          syncTargetRef={syncTargetBiRef}
                          onTopBi={handlePreviewTopBi}
                          onOpenLink={handleOpenLink}
                        />
                      ) : (
                        <div className="editor-loading">正在渲染预览…</div>
                      )}
                    </div>
                  }
                />
              ) : (
                <div className="editor-wrap">
                  <Suspense fallback={<div className="editor-loading">正在加载编辑器…</div>}>
                    <SourceEditor
                      key={currentFile ?? ""}
                      ref={editorRef}
                      initialText={editTextRef.current}
                      text={doc.text}
                      onChange={handleEditorChange}
                      onSave={saveDoc}
                      onOpenLink={handleOpenLink}
                      onPasteFile={handleEditorPasteFile}
                      onViewReady={handleEditorViewReady}
                      onViewDestroy={handleEditorViewDestroy}
                      onFocusChange={handleEditorFocusChange}
                      onSlashTrigger={handleSlashTrigger}
                      onUserInput={closeSlashMenu}
                    />
                  </Suspense>
                  {findOpen && (
                    <SearchPanel
                      mode={mode}
                      source={sourceSearch}
                      docText={doc.text}
                      docVersion={docVersion}
                      showReplace={findShowReplace}
                      onShowReplace={setFindShowReplace}
                      onClose={closeFind}
                      readWrap={readerWrapRef}
                      focusNonce={findFocusNonce}
                    />
                  )}
                </div>
              )}
              {!fullscreenOn && (
                <footer className="statusbar">
                  <span className="status-file" title={currentFile ?? ""}>
                    {currentFile?.split(/[\\/]/).pop()}
                  </span>
                  <span>
                    {mode === "read" ? "阅读视图" : mode === "split" ? "分屏模式" : "源码模式"}
                  </span>
                  {zenOn && mode === "read" && zenPos && (
                    <span>
                      专注 {zenPos.idx + 1}/{zenPos.total}
                    </span>
                  )}
                  <span>{doc.encoding}</span>
                  <span>{doc.eol.toUpperCase()}</span>
                  {dirty && <span className="status-dirty">未保存</span>}
                  <span className="spacer" />
                  {serveUrl && (
                    <>
                      {servePerms?.follow && (
                        <button
                          className={`tool-btn${followRemote ? " active" : ""}`}
                          onClick={() => setFollowRemote((v) => !v)}
                          title="开启后,远端浏览者滚动时本机视图跟随滚动"
                        >
                          {followRemote ? "跟随远端:开" : "跟随远端:关"}
                        </button>
                      )}
                      <button
                        className="tool-btn"
                        onClick={() => {
                          void copyText(serveUrl).then((ok) =>
                            setInfo(ok ? "分享链接已复制" : "复制失败,请手动复制"),
                          );
                        }}
                        title="复制分享链接"
                      >
                        复制链接
                      </button>
                      <span>
                        {servePerms?.edit
                          ? "协作编辑"
                          : servePerms?.follow
                            ? "同步浏览"
                            : "只读分享"}
                      </span>
                      <a
                        className="status-link"
                        href={serveUrl}
                        onClick={(e) => {
                          e.preventDefault();
                          void openServe();
                        }}
                        title="在浏览器打开分享页"
                      >
                        分享: {serveUrl}
                      </a>
                    </>
                  )}
                </footer>
              )}
            </>
          ) : (
            <div className="empty-state">
              <h1>Ruakdown</h1>
              <p>Windows 优先的 Markdown 阅读器 / 编辑器</p>
              <div className="empty-actions">
                <button className="primary-btn" onClick={chooseFolder}>
                  打开文件夹
                </button>
                <button className="primary-btn secondary" onClick={chooseFile}>
                  打开文件
                </button>
              </div>
              <div className="empty-links">
                <a
                  href={REPO_URL}
                  onClick={(e) => {
                    e.preventDefault();
                    void openExternal(REPO_URL);
                  }}
                >
                  GitHub 仓库
                </a>
                <span>·</span>
                <a
                  href={RELEASES_URL}
                  onClick={(e) => {
                    e.preventDefault();
                    void openExternal(RELEASES_URL);
                  }}
                >
                  Releases 更新
                </a>
              </div>
            </div>
          )}
        </div>
      </div>

      {quickOpen && (
        <QuickOpen
          root={root}
          recent={recentFiles}
          tree={tree}
          initialContent={quickContent}
          initialQuery={quickQuery}
          onClose={() => setQuickOpen(false)}
          onOpenFile={(path) => {
            setQuickOpen(false);
            void openFile(path);
          }}
          onOpenHit={handleSearchHit}
        />
      )}

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          entries={ctxMenu.entries}
          onClose={closeCtxMenu}
          onSelect={runTreeAction}
        />
      )}

      {editorMenu && (
        <ContextMenu
          x={editorMenu.x}
          y={editorMenu.y}
          entries={editorMenu.entries}
          onClose={closeEditorMenu}
          onSelect={runEditorAction}
        />
      )}

      {slashMenu && (
        <ContextMenu
          x={slashMenu.x}
          y={slashMenu.y}
          entries={slashMenu.entries}
          onClose={closeSlashMenu}
          onSelect={runSlashAction}
          autoFocus={false}
          windowKeyNav
        />
      )}

      {emojiAt && (
        <EmojiPicker
          x={emojiAt.x}
          y={emojiAt.y}
          onPick={(emoji) => editorRef.current?.insertAtCursor(emoji)}
          onClose={() => setEmojiAt(null)}
        />
      )}

      {exitAsk && (
        <div className="modal-mask" onClick={() => setExitAsk(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>有未保存的修改</h2>
            <p className="setting-hint">
              「{currentFile?.split(/[\\/]/).pop() ?? "当前文档"}
              」还有未保存的修改,退出前要保存吗?
            </p>
            <div className="modal-actions">
              <button className="primary-btn secondary" onClick={() => setExitAsk(false)}>
                取消
              </button>
              <button className="primary-btn danger" onClick={() => void confirmExit(false)}>
                不保存退出
              </button>
              <button className="primary-btn" onClick={() => void confirmExit(true)}>
                保存并退出
              </button>
            </div>
          </div>
        </div>
      )}

      {subdocOpen && (
        <div className="modal-mask" onClick={() => setSubdocOpen(false)}>
          <div className="modal subdoc-modal" onClick={(e) => e.stopPropagation()}>
            <h2>新建子文档并引用</h2>
            <label className="setting-row">
              <span>文件名</span>
              <input
                type="text"
                value={subdocName}
                placeholder="子文档标题"
                spellCheck={false}
                autoFocus
                onChange={(e) => setSubdocName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void commitSubdoc();
                  else if (e.key === "Escape") setSubdocOpen(false);
                }}
                style={{ width: 200 }}
              />
            </label>
            <p className="setting-hint">
              将在当前文档同目录创建 Markdown 文件,并在光标处插入指向它的链接。
            </p>
            <div className="modal-actions">
              <button className="primary-btn secondary" onClick={() => setSubdocOpen(false)}>
                取消
              </button>
              <button className="primary-btn" onClick={() => void commitSubdoc()}>
                创建并引用
              </button>
            </div>
          </div>
        </div>
      )}

      {settingsOpen && (
        <div className="modal-mask" onClick={() => setSettingsOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>设置</h2>
            <label className="setting-row">
              <span>自动保存(输入暂停 1.5 秒后)</span>
              <input
                type="checkbox"
                checked={autosaveOn}
                onChange={(e) => {
                  setAutosaveOn(e.target.checked);
                  persist({ autosave: e.target.checked });
                }}
              />
            </label>
            <label className="setting-row">
              <span>预览服务端口</span>
              <input
                type="number"
                min={1024}
                max={65535}
                value={servePort}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v)) setServePort(v);
                }}
                onBlur={() => persist({ servePort })}
                style={{ width: 90 }}
              />
            </label>
            <div className="setting-divider">阅读区背景图</div>
            <label className="setting-row">
              <span>启用背景图</span>
              <input
                type="checkbox"
                checked={bg.enabled}
                onChange={(e) => updateBg({ enabled: e.target.checked })}
              />
            </label>
            <div className="setting-row">
              <span>背景图片</span>
              <span className="setting-controls">
                <button className="tool-btn" onClick={() => void pickBgImage()}>
                  {bgFileName ?? "选择图片"}
                </button>
                {bg.path && (
                  <button className="tool-btn" onClick={() => updateBg({ path: null })}>
                    清除
                  </button>
                )}
              </span>
            </div>
            <label className="setting-row">
              <span>显示样式</span>
              <select
                className="theme-select"
                value={bg.style}
                onChange={(e) =>
                  updateBg({ style: e.target.value as BackgroundConfig["style"] })
                }
              >
                <option value="paper">纸面实色</option>
                <option value="frosted">半透明毛玻璃</option>
              </select>
            </label>
            <label className="setting-row">
              <span>模糊度 ({bg.blur}px)</span>
              <input
                type="range"
                min={0}
                max={40}
                value={bg.blur}
                onChange={(e) => updateBg({ blur: Number(e.target.value) })}
                style={{ width: 150 }}
              />
            </label>
            <label className="setting-row">
              <span>蒙版浓度 ({bg.overlay}%)</span>
              <input
                type="range"
                min={0}
                max={100}
                value={bg.overlay}
                onChange={(e) => updateBg({ overlay: Number(e.target.value) })}
                style={{ width: 150 }}
              />
            </label>
            <p className="setting-hint">
              背景图仅作用于阅读区。蒙版颜色随主题自动适配:浅色主题叠白纱、深色主题叠暗纱。
            </p>
            <div className="setting-divider">专注模式 (Zen)</div>
            <label className="setting-row">
              <span>分节级别</span>
              <select
                className="theme-select"
                value={zenCfg.level}
                onChange={(e) => updateZenCfg({ level: e.target.value as ResolvedZen["level"] })}
              >
                <option value="auto">自动</option>
                <option value="h1">H1</option>
                <option value="h2">H2</option>
                <option value="h3">H3</option>
              </select>
            </label>
            <label className="setting-row">
              <span>效果强度</span>
              <select
                className="theme-select"
                value={zenCfg.effect}
                onChange={(e) => updateZenCfg({ effect: e.target.value as ResolvedZen["effect"] })}
              >
                <option value="dim">仅调暗</option>
                <option value="dim-blur">调暗 + 模糊</option>
              </select>
            </label>
            <label className="setting-row">
              <span>重点增强 (粗体放大、代码荧光、高亮)</span>
              <input
                type="checkbox"
                checked={zenCfg.emphasis}
                onChange={(e) => updateZenCfg({ emphasis: e.target.checked })}
              />
            </label>
            <p className="setting-hint">
              专注模式只保留当前章节清晰,其余调暗;←/→ 或 j/k 跳转章节,Esc 退出。
              文中可用 ==高亮== 语法手动标记重点。
            </p>
            <p className="setting-hint">
              端口修改后,下次启动预览服务生效。当前主题:{THEME_LABELS[themeName]}
            </p>
            <div className="setting-divider">粘贴资源 (assets)</div>
            <label className="setting-row">
              <span>资源归档目录</span>
              <input
                type="text"
                value={assetsDir ?? ""}
                placeholder="assets"
                spellCheck={false}
                onChange={(e) => setAssetsDir(e.target.value)}
                onBlur={(e) => {
                  const v =
                    e.target.value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") || null;
                  setAssetsDir(v);
                  persist({ assetsDir: v });
                }}
                style={{ width: 160 }}
              />
            </label>
            <p className="setting-hint">
              在源码/分屏模式中粘贴图片或文件时，资源会归档到 assets 目录并以「文档名前10字符_时间戳.扩展名」命名，同时在光标处插入相对链接。
              目录相对工作区根（默认 assets，可改）；当前文档在工作区外时，资源归档到文档同目录的 assets 下。
            </p>
            <div className="setting-divider">关于与更新</div>
            <div className="setting-row">
              <span>Ruakdown{appVersion ? ` v${appVersion}` : ""}</span>
              <span className="setting-controls">
                <button
                  className="tool-btn"
                  onClick={() => void openExternal(REPO_URL)}
                  title="在浏览器打开项目仓库"
                >
                  GitHub 仓库
                </button>
                <button
                  className="tool-btn"
                  onClick={() => void openExternal(RELEASES_URL)}
                  title="打开 Releases 页下载最新安装包"
                >
                  检查更新 (Releases)
                </button>
              </span>
            </div>
            <p className="setting-hint">
              更新经 GitHub Releases 发布:下载最新安装包覆盖安装即可,配置与设置均保留。
            </p>
            <div className="modal-actions">
              <button className="primary-btn" onClick={() => setSettingsOpen(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
