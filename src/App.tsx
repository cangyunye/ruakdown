import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  api,
  SERVE_PORT,
  type AppConfig,
  type BackgroundConfig,
  type DocPayload,
  type TreeNode,
  type ZenConfig,
} from "./ipc";
import { applyTheme } from "./theme";
import { scrollToText } from "./jumpToText";
import type { ZenController, ZenLevel } from "./zen";
import { Sidebar, type SidebarTab } from "./components/Sidebar";
import { Reader } from "./components/Reader";
import SearchModal from "./components/SearchModal";
import ChunkedReader, { type ChunkedReaderHandle } from "./components/ChunkedReader";

const SourceEditor = lazy(() => import("./components/SourceEditor"));

type Mode = "read" | "edit";

const THEME_LABELS: Record<string, string> = {
  light: "浅色",
  dark: "暗色",
  graphite: "石墨",
  "sunset-coast": "夕阳海岸",
  verdant: "无边绿意",
  sky: "蓝天白云",
  newsprint: "陈旧报纸",
};

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
    root.style.setProperty("--reader-bg-blur", `${cfg.blur ?? 0}px`);
    root.style.setProperty(
      "--reader-bg-overlay",
      String((cfg.overlay ?? 80) / 100),
    );
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
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [autosaveOn, setAutosaveOn] = useState(true);
  const [servePort, setServePort] = useState(SERVE_PORT);
  const [bg, setBg] = useState<ResolvedBg>(DEFAULT_BG);
  const [zenOn, setZenOn] = useState(false);
  const [zenCfg, setZenCfg] = useState<ResolvedZen>(DEFAULT_ZEN);
  const [zenPos, setZenPos] = useState<{ idx: number; total: number } | null>(null);
  const zenPosRef = useRef(zenPos);
  zenPosRef.current = zenPos;
  const zenCtlRef = useRef<ZenController | null>(null);

  const autosaveRef = useRef(autosaveOn);
  autosaveRef.current = autosaveOn;
  const servePortRef = useRef(servePort);
  servePortRef.current = servePort;

  const hydrated = useRef(false);
  const chunkedReaderRef = useRef<ChunkedReaderHandle | null>(null);
  const stateRef = useRef({
    root,
    currentFile,
    themeName,
    mode,
    doc,
    serveUrl,
    servePort,
    autosaveOn,
    bg,
    zenCfg,
  });
  stateRef.current = {
    root,
    currentFile,
    themeName,
    mode,
    doc,
    serveUrl,
    servePort,
    autosaveOn,
    bg,
    zenCfg,
  };
  const editTextRef = useRef("");
  const dirtyRef = useRef(false);
  const autosaveTimer = useRef<number | null>(null);

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
      dirtyRef.current = false;
      setDirty(false);
      setExternalChange(false);
      setDoc((prev) => (prev ? { ...prev, text: editTextRef.current } : prev));
    } catch (err) {
      setError("保存失败: " + String(err));
    }
  }, []);

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
        persist({ lastFile: path });
      } catch (err) {
        setError("打开文件失败: " + String(err));
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [persist],
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

  // Open a file from search results, then scroll the rendered view to the
  // first occurrence of the query. Read mode only; chunked docs (over 1MB)
  // and the source editor are opened without positioning.
  const handleSearchHit = useCallback(
    async (path: string, query: string) => {
      setSearchOpen(false);
      await openFile(path);
      if (!query || stateRef.current.mode !== "read") return;
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
      if (next === "read") {
        await saveDoc();
      } else {
        editTextRef.current = stateRef.current.doc?.text ?? "";
      }
      setMode(next);
    },
    [saveDoc],
  );

  const toggleZen = useCallback(() => {
    if (stateRef.current.mode === "edit") {
      void switchMode("read");
    }
    setZenPos(null);
    setZenOn((v) => !v);
  }, [switchMode]);

  const handleZenUnavailable = useCallback(() => {
    setZenOn(false);
    setInfo("当前文档没有可用的分节标题(同一层级需至少两个),专注模式未开启");
  }, []);

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

  const startServe = useCallback(async (lan: boolean) => {
    if (lan && !window.confirm("局域网共享将绑定 0.0.0.0 并触发 Windows 防火墙授权弹窗,任何同网段设备都可访问。确认继续?")) {
      return;
    }
    try {
      const url = await api.serveStart(servePortRef.current, lan);
      setServeUrl(url);
      setInfo(`预览服务已启动: ${url}`);
    } catch (err) {
      setError("启动预览服务失败: " + String(err));
    }
  }, []);

  const stopServe = useCallback(async () => {
    try {
      await api.serveStop();
      setServeUrl(null);
      setInfo("预览服务已停止");
    } catch (err) {
      setError("停止预览服务失败: " + String(err));
    }
  }, []);

  const openServe = useCallback(async () => {
    const url = stateRef.current.serveUrl ?? serveUrl;
    if (url) await openUrl(url);
  }, [serveUrl]);

  // Latest handlers for native menu events.
  const menuRouteRef = useRef<(id: string) => void>(() => {});
  menuRouteRef.current = (id: string) => {
    if (id.startsWith("theme-")) {
      void changeTheme(id.slice("theme-".length));
      return;
    }
    switch (id) {
      case "open-folder":
        void chooseFolder();
        break;
      case "open-file":
        void chooseFile();
        break;
      case "search-dir":
        setSearchOpen(true);
        break;
      case "save":
        void saveDoc();
        break;
      case "export-html":
        void exportHtml();
        break;
      case "mode-read":
        void switchMode("read");
        break;
      case "mode-edit":
        void switchMode("edit");
        break;
      case "toggle-zen":
        toggleZen();
        break;
      case "toggle-sidebar":
        setSidebarVisible((v) => !v);
        break;
      case "serve-local":
        void startServe(false);
        break;
      case "serve-lan":
        void startServe(true);
        break;
      case "serve-stop":
        void stopServe();
        break;
      case "serve-open":
        void openServe();
        break;
    }
  };

  useEffect(() => {
    const unlisten = listen<string>("menu", (event) => {
      menuRouteRef.current(event.payload);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Clear transient info notices.
  useEffect(() => {
    if (!info) return;
    const t = window.setTimeout(() => setInfo(null), 5000);
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

  // Zen keyboard navigation: Esc exits, ←/→ (or j/k) jump between sections.
  useEffect(() => {
    if (!zenOn || mode !== "read" || searchOpen || settingsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setZenOn(false);
        return;
      }
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "j" && e.key !== "k") {
        return;
      }
      const ctl = zenCtlRef.current;
      if (!ctl) return;
      const current = zenPosRef.current?.idx ?? 0;
      ctl.jumpTo(e.key === "ArrowRight" || e.key === "j" ? current + 1 : current - 1);
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zenOn, mode, searchOpen, settingsOpen]);

  // Restore last session (folder/file/theme) on startup.
  useEffect(() => {
    (async () => {
      try {
        const cfg = await api.getConfig();
        const theme = cfg.theme ?? "light";
        setThemeName(theme);
        const t = await applyTheme(theme);
        setThemeDark(t?.dark ?? false);
        if (cfg.servePort && cfg.servePort > 0 && cfg.servePort < 65536) {
          setServePort(cfg.servePort);
        }
        if (cfg.autosave != null) setAutosaveOn(cfg.autosave);
        if (cfg.background) {
          const merged = normalizeBg(cfg.background);
          setBg(merged);
          applyBackground(merged);
        }
        if (cfg.zen) setZenCfg(normalizeZen(cfg.zen));
        if (cfg.lastFolder) {
          await openFolder(cfg.lastFolder);
          if (cfg.lastFile) await openFile(cfg.lastFile);
        }
      } catch (err) {
        console.error("restore session:", err);
      } finally {
        hydrated.current = true;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // External filesystem changes: refresh tree; reload the open file unless
  // there are unsaved edits (then ask via the notice bar).
  useEffect(() => {
    const unlisten = listen<{ paths: string[] }>("fs-change", async (event) => {
      const s = stateRef.current;
      if (s.root) {
        try {
          setTree(await api.loadTree(s.root));
        } catch {
          /* folder may have been removed; keep last tree */
        }
      }
      const current = s.currentFile;
      if (
        !current ||
        !event.payload.paths.some((p) => p.toLowerCase() === current.toLowerCase())
      ) {
        return;
      }
      if (s.mode === "edit" && dirtyRef.current) {
        setExternalChange(true);
        return;
      }
      try {
        const d = await api.openDoc(current);
        setDoc(d);
        editTextRef.current = d.text;
        setExternalChange(false);
      } catch {
        /* file may be mid-write; next event will refresh */
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Warn before closing with unsaved edits; best-effort save.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
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
      if (stateRef.current.doc?.chunked) {
        chunkedReaderRef.current?.jumpTo(id);
      } else {
        document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    },
    [],
  );

  const currentOutline = doc?.chunked
    ? doc.chunked.outline
    : (doc?.outline ?? []);

  return (
    <div className="app">
      <header className="titlebar">
        <div className="brand">Ruakdown</div>
        <div className="spacer" />
        {doc && (
          <div className="mode-switch">
            <button
              className={mode === "read" ? "active" : ""}
              onClick={() => switchMode("read")}
            >
              阅读
            </button>
            <button
              className={mode === "edit" ? "active" : ""}
              onClick={() => switchMode("edit")}
            >
              源码
            </button>
          </div>
        )}
        <button className="tool-btn" onClick={chooseFolder} title="打开文件夹">
          打开文件夹
        </button>
        <button className="tool-btn" onClick={chooseFile} title="打开文件">
          打开文件
        </button>
        <button
          className="tool-btn"
          onClick={() => setSearchOpen(true)}
          title="目录内搜索 (Ctrl+Shift+F)"
        >
          搜索
        </button>
        {doc && !doc.chunked && (
          <button
            className={`tool-btn${zenOn ? " active" : ""}`}
            onClick={toggleZen}
            title="专注模式 (Ctrl+Shift+Z, Esc 退出)"
          >
            专注
          </button>
        )}
        <select
          className="theme-select"
          value={themeName}
          onChange={(e) => changeTheme(e.target.value)}
          title="切换主题"
        >
          {Object.entries(THEME_LABELS).map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
        <button
          className="tool-btn"
          onClick={() => setSettingsOpen(true)}
          title="设置"
        >
          设置
        </button>
      </header>

      {error && <div className="error-bar">{error}</div>}
      {info && <div className="notice-bar info">{info}</div>}

      <div className="main">
        {sidebarVisible && (
          <Sidebar
            tab={tab}
            onTabChange={setTab}
            tree={tree}
            outline={currentOutline}
            activeFile={currentFile}
            activeHeading={activeHeading}
            hasFolder={root !== null}
            onOpenFile={openFile}
            onJump={jumpToHeading}
          />
        )}
        <div className="content">
          {doc ? (
            <>
              {externalChange && (
                <div className="notice-bar">
                  <span>文件已被外部修改。</span>
                  <button onClick={reloadCurrent}>重新加载</button>
                  <button onClick={() => setExternalChange(false)}>忽略</button>
                </div>
              )}
              {mode === "read" ? (
                <div className="reader-wrap">
                  {doc.chunked ? (
                    <ChunkedReader
                      ref={chunkedReaderRef}
                      key={doc.chunked.token}
                      meta={doc.chunked}
                      path={currentFile ?? ""}
                      dark={themeDark}
                      onActiveHeading={setActiveHeading}
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
                    />
                  )}
                </div>
              ) : (
                <div className="editor-wrap">
                  <Suspense fallback={<div className="editor-loading">正在加载编辑器…</div>}>
                    <SourceEditor
                      key={currentFile ?? ""}
                      initialText={doc.text}
                      text={doc.text}
                      onChange={markDirty}
                      onSave={saveDoc}
                    />
                  </Suspense>
                </div>
              )}
              <footer className="statusbar">
                <span className="status-file" title={currentFile ?? ""}>
                  {currentFile?.split(/[\\/]/).pop()}
                </span>
                <span>{mode === "read" ? "阅读视图" : "源码模式"}</span>
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
                  <a
                    className="status-link"
                    href={serveUrl}
                    onClick={(e) => {
                      e.preventDefault();
                      void openServe();
                    }}
                    title="在浏览器打开预览"
                  >
                    预览: {serveUrl}
                  </a>
                )}
              </footer>
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
            </div>
          )}
        </div>
      </div>

      {searchOpen && (
        <SearchModal
          root={root}
          onClose={() => setSearchOpen(false)}
          onOpenHit={handleSearchHit}
        />
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
