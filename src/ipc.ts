import { invoke } from "@tauri-apps/api/core";

export interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
}

export interface OutlineItem {
  level: number;
  text: string;
  id: string;
  chunk?: number;
}

export interface ChunkInfo {
  htmlBytes: number;
  tags: number;
  estHeight: number;
  hasMermaid: boolean;
  firstHeading: number | null;
  lastHeading: number | null;
}

export interface ChunkOutlineItem {
  level: number;
  text: string;
  id: string;
  chunk: number;
  /** Global top-level block index (split-view scroll sync). */
  bi?: number;
}

export interface ChunkedMeta {
  token: number;
  chunkCount: number;
  chunks: ChunkInfo[];
  outline: ChunkOutlineItem[];
}

/** One top-level markdown block: the unit of editor↔preview scroll sync. */
export interface BlockInfo {
  bi: number;
  chunk: number;
  startLine: number;
  endLine: number;
  headingId: string | null;
}

/** Preview index returned once per rebuild; chunk HTML comes via
 * previewChunks keyed by `rev`. */
export interface PreviewMeta {
  rev: number;
  chunkCount: number;
  chunks: ChunkInfo[];
  blocks: BlockInfo[];
  outline: ChunkOutlineItem[];
}

export interface ChunkOut {
  index: number;
  html: string;
}

export interface DocPayload {
  html: string | null;
  outline: OutlineItem[];
  text: string;
  encoding: string;
  eol: string;
  chunked: ChunkedMeta | null;
}

export interface BackgroundConfig {
  enabled: boolean | null;
  path: string | null;
  /** Blur radius in px (0-40). */
  blur: number | null;
  /** Mask strength in percent (0-100). */
  overlay: number | null;
  /** "paper" (opaque sheet) or "frosted" (translucent blur). */
  style: "paper" | "frosted" | null;
}

export interface ZenConfig {
  /** "auto", "h1", "h2" or "h3". */
  level: "auto" | "h1" | "h2" | "h3" | null;
  /** "dim" or "dim-blur". */
  effect: "dim" | "dim-blur" | null;
  /** Emphasis boost for strong/code/mark/blockquote in zen mode. */
  emphasis: boolean | null;
}

export interface SplitConfig {
  /** Which side the source editor sits on. */
  editorSide: "left" | "right" | null;
  /** Editor pane width as a fraction of the split area (0.2-0.8). */
  ratio: number | null;
}

export interface AppConfig {
  lastFolder: string | null;
  lastFile: string | null;
  theme: string | null;
  servePort: number | null;
  autosave: boolean | null;
  background: BackgroundConfig | null;
  zen: ZenConfig | null;
  split: SplitConfig | null;
  /** Recently opened file paths (most recent first, max 15). */
  recentFiles?: string[] | null;
}

export interface Theme {
  name: string;
  dark: boolean;
  vars: Record<string, string>;
}

export interface SaveResult {
  bytes: number;
  backup: string | null;
}

export interface SearchHit {
  line: number;
  text: string;
}

export interface SearchFileResult {
  path: string;
  name: string;
  nameMatch: boolean;
  hits: SearchHit[];
}

export interface SearchOutcome {
  files: SearchFileResult[];
  totalHits: number;
  truncated: boolean;
}

export interface ResolvedLink {
  path: string;
  exists: boolean;
  inRoot: boolean;
  isMarkdown: boolean;
}

export const api = {
  pickFolder: () => invoke<string | null>("pick_folder"),
  pickFile: () => invoke<string | null>("pick_file"),
  pickImage: () => invoke<string | null>("pick_image"),
  loadTree: (root: string) => invoke<TreeNode[]>("load_tree", { root }),
  searchDocs: (root: string, query: string, caseSensitive: boolean) =>
    invoke<SearchOutcome>("search_docs", { root, query, caseSensitive }),
  openDoc: (path: string) => invoke<DocPayload>("open_doc", { path }),
  renderChunks: (token: number, start: number, count: number) =>
    invoke<ChunkOut[]>("render_chunks", { token, start, count }),
  previewUpdate: (text: string, baseFile: string) =>
    invoke<PreviewMeta>("preview_update", { text, baseFile }),
  previewChunks: (rev: number, start: number, count: number) =>
    invoke<ChunkOut[]>("preview_chunks", { rev, start, count }),
  saveFile: (path: string, text: string, encoding: string, eol: string) =>
    invoke<SaveResult>("save_file", { path, text, encoding, eol }),
  watchFolder: (root: string) => invoke<void>("watch_folder", { root }),
  resolveLink: (baseFile: string, link: string, root: string | null) =>
    invoke<ResolvedLink>("resolve_link", { baseFile, link, root }),
  takePendingOpen: () => invoke<string | null>("take_pending_open"),
  getConfig: () => invoke<AppConfig>("get_config"),
  saveConfig: (config: AppConfig) => invoke<void>("save_config", { config }),
  applyTheme: (name: string) => invoke<Theme>("apply_theme", { name }),
  /** Absolute path of the bundled mermaid.min.js (loaded via asset protocol). */
  mermaidAssetPath: () => invoke<string>("mermaid_asset_path"),
  pickExportPath: (defaultName: string) =>
    invoke<string | null>("pick_export_path", { defaultName }),
  exportHtml: (
    sourcePath: string,
    outPath: string,
    themeId: string,
    inlineMermaid: boolean,
  ) =>
    invoke<number>("export_html", {
      sourcePath,
      outPath,
      themeId,
      inlineMermaid,
    }),
  setCurrentFile: (path: string | null) => invoke<void>("set_current_file", { path }),
  setFullscreen: (fullscreen: boolean) => invoke<void>("set_fullscreen", { fullscreen }),
  // Share commands below only exist in `--features share` builds. The
  // lightweight build has no share menu, so none of these are ever invoked
  // there; every call site swallows the rejection as a safety net.
  serveStart: (port: number, lan: boolean, follow: boolean, edit: boolean) =>
    invoke<string>("serve_start", { port, lan, follow, edit }),
  serveStop: () => invoke<void>("serve_stop"),
  /** Tell viewers the shared content changed (call after saving). */
  serveNotifyChange: () => invoke<void>("serve_notify_change"),
  /** Broadcast the local reading position to viewers (scroll sync). */
  serveBroadcastScroll: (
    line: number | null,
    heading: string | null,
    frac: number | null,
  ) => invoke<void>("serve_broadcast_scroll", { line, heading, frac }),
  /** Viewer-visible notice, e.g. a rejected remote edit. */
  serveNotice: (text: string) => invoke<void>("serve_notice", { text }),
  serveSetDirty: (dirty: boolean) => invoke<void>("serve_set_dirty", { dirty }),
};

export const SERVE_PORT = 17630;
