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
}

export interface ChunkedMeta {
  token: number;
  chunkCount: number;
  chunks: ChunkInfo[];
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

export interface AppConfig {
  lastFolder: string | null;
  lastFile: string | null;
  theme: string | null;
  servePort: number | null;
  autosave: boolean | null;
  background: BackgroundConfig | null;
  zen: ZenConfig | null;
}

export interface ThemeInfo {
  id: string;
  name: string;
  dark: boolean;
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
  saveFile: (path: string, text: string, encoding: string, eol: string) =>
    invoke<SaveResult>("save_file", { path, text, encoding, eol }),
  watchFolder: (root: string) => invoke<void>("watch_folder", { root }),
  stopWatch: () => invoke<void>("stop_watch"),
  resolveLink: (baseFile: string, link: string, root: string | null) =>
    invoke<ResolvedLink>("resolve_link", { baseFile, link, root }),
  takePendingOpen: () => invoke<string | null>("take_pending_open"),
  getConfig: () => invoke<AppConfig>("get_config"),
  saveConfig: (config: AppConfig) => invoke<void>("save_config", { config }),
  listThemes: () => invoke<ThemeInfo[]>("list_themes"),
  applyTheme: (name: string) => invoke<Theme>("apply_theme", { name }),
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
  serveStatus: () => invoke<string | null>("serve_status"),
  serveStart: (port: number, lan: boolean) =>
    invoke<string>("serve_start", { port, lan }),
  serveStop: () => invoke<void>("serve_stop"),
};

export const SERVE_PORT = 17630;
