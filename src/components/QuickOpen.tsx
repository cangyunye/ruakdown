import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type SearchFileResult, type SearchOutcome, type TreeNode } from "../ipc";
import { matchTree, rankRecent } from "../quickOpen";

interface Props {
  root: string | null;
  /** Recently opened file paths, most recent first. */
  recent: string[];
  /** Current folder tree (for filename matching). */
  tree: TreeNode[];
  /** Open straight into content-search mode (Ctrl+Shift+F). */
  initialContent?: boolean;
  onClose: () => void;
  onOpenFile: (path: string) => void;
  /** Content hit: open the file and jump to `line`. */
  onOpenHit: (path: string, query: string, line?: number) => void;
}

interface QuickRow {
  path: string;
  name: string;
  dir: string;
  recent: boolean;
}

function basename(path: string): string {
  const parts = path.split(path.includes("\\") ? "\\" : "/");
  return parts[parts.length - 1] || path;
}

function parentName(path: string): string {
  const parts = path.split(path.includes("\\") ? "\\" : "/");
  return parts.length < 2 ? "" : parts[parts.length - 2];
}

const DEBOUNCE_MS = 400;
const MIN_QUERY_LEN = 2;
const RENDER_CAP = 200;

export default function QuickOpen({
  root,
  recent,
  tree,
  initialContent,
  onClose,
  onOpenFile,
  onOpenHit,
}: Props) {
  const [query, setQuery] = useState("");
  const [contentMode, setContentMode] = useState(!!initialContent);
  const [selected, setSelected] = useState(0);

  const [result, setResult] = useState<SearchOutcome | null>(null);
  const [searching, setSearching] = useState(false);
  const seqRef = useRef(0);
  const inflightRef = useRef(false);
  const rerunRef = useRef<{ q: string } | null>(null);

  const trimmed = query.trim();

  const quickRows = useMemo<QuickRow[]>(() => {
    if (contentMode) return [];
    if (!trimmed) {
      return recent.map((p) => ({
        path: p,
        name: basename(p),
        dir: parentName(p),
        recent: true,
      }));
    }
    const seen = new Set<string>();
    const rows: QuickRow[] = [];
    for (const p of rankRecent(trimmed, recent)) {
      seen.add(p);
      rows.push({ path: p, name: basename(p), dir: parentName(p), recent: true });
    }
    for (const h of matchTree(trimmed, tree)) {
      if (seen.has(h.path)) continue;
      seen.add(h.path);
      rows.push({ path: h.path, name: h.name, dir: parentName(h.path), recent: false });
    }
    return rows.slice(0, RENDER_CAP);
  }, [contentMode, trimmed, recent, tree]);

  // ── Content search (debounced workspace scan) ──────────────────
  const runSearch = useCallback(
    async (q: string) => {
      if (!root) return;
      if (inflightRef.current) {
        rerunRef.current = { q };
        return;
      }
      inflightRef.current = true;
      const seq = ++seqRef.current;
      setSearching(true);
      try {
        const outcome = await api.searchDocs(root, q, false);
        if (seq === seqRef.current) {
          setResult(outcome);
          setSelected(0);
        }
      } catch {
        if (seq === seqRef.current) setResult(null);
      } finally {
        inflightRef.current = false;
        const next = rerunRef.current;
        rerunRef.current = null;
        if (next) void runSearch(next.q);
        else setSearching(false);
      }
    },
    [root],
  );

  useEffect(() => {
    if (!contentMode) return;
    if (!root || trimmed.length < MIN_QUERY_LEN) {
      seqRef.current += 1;
      rerunRef.current = null;
      setResult(null);
      setSearching(false);
      return;
    }
    const timer = window.setTimeout(() => void runSearch(trimmed), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [contentMode, trimmed, root, runSearch]);

  const groups = useMemo(() => {
    const list: { file: SearchFileResult; hits: { line: number; text: string; index: number }[] }[] =
      [];
    let index = 0;
    let shown = 0;
    for (const file of result?.files ?? []) {
      if (shown >= RENDER_CAP) break;
      const take = Math.min(file.hits.length, RENDER_CAP - shown);
      const hits = file.hits.slice(0, take).map((hit) => ({
        line: hit.line,
        text: hit.text,
        index: index++,
      }));
      shown += take;
      list.push({ file, hits });
    }
    return list;
  }, [result]);

  const hitRows = useMemo(() => groups.flatMap((g) => g.hits), [groups]);
  const rowCount = contentMode ? hitRows.length : quickRows.length;
  const clamped = Math.min(selected, Math.max(0, rowCount - 1));

  useEffect(() => {
    setSelected(0);
  }, [trimmed, contentMode]);

  // Re-triggering the panel (Ctrl+P / Ctrl+Shift+F) while it is already open
  // switches mode via the prop.
  useEffect(() => {
    setContentMode(!!initialContent);
  }, [initialContent]);

  const openQuick = (row: QuickRow) => onOpenFile(row.path);
  const openHit = (index: number) => {
    const hit = hitRows.find((h) => h.index === index);
    if (!hit) return;
    const file = groups.find((g) => g.hits.includes(hit))?.file;
    if (file) onOpenHit(file.path, trimmed, hit.line);
  };

  const activate = () => {
    if (contentMode) openHit(clamped);
    else if (quickRows[clamped]) openQuick(quickRows[clamped]);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, Math.max(rowCount - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      activate();
    }
  };

  let status: string;
  if (contentMode) {
    if (!root) status = "请先打开文件夹,再搜索其中的 Markdown 文档";
    else if (!trimmed) status = "输入关键词,递归搜索当前目录下所有 .md / .markdown 文件";
    else if (trimmed.length < MIN_QUERY_LEN) status = `至少输入 ${MIN_QUERY_LEN} 个字符`;
    else if (searching) status = "搜索中…";
    else if (result)
      status = result.files.length
        ? `${result.files.length} 个文件 · ${result.totalHits} 处匹配${result.truncated ? "(结果已截断)" : ""}`
        : "无匹配结果";
    else status = "";
  } else if (!trimmed) {
    status = recent.length ? "最近打开" : "输入文件名以搜索当前文件夹";
  } else {
    status = quickRows.length ? `${quickRows.length} 个结果` : "无匹配文件";
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal search-modal" onClick={(e) => e.stopPropagation()}>
        <div className="search-input-row">
          <input
            className="search-input"
            type="text"
            autoFocus
            placeholder={contentMode ? "搜索当前目录内容…" : "快速打开 — 输入文件名"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
          />
          <button
            className={"mode-toggle-btn " + (contentMode ? "is-content" : "is-history")}
            title={contentMode ? "返回最近打开" : "搜索当前目录内容"}
            onClick={() => setContentMode((v) => !v)}
          >
            <span className="mt-item mt-content">内容</span>
            <span className="mt-item mt-history">历史</span>
          </button>
        </div>
        <div className="search-status">{status}</div>
        <div className="search-results">
          {!contentMode &&
            quickRows.map((row, i) => (
              <button
                key={row.path}
                className={"search-hit" + (i === clamped ? " selected" : "")}
                onMouseEnter={() => setSelected(i)}
                onClick={() => openQuick(row)}
              >
                <span className="search-hit-text">
                  {row.name}
                  {row.dir && <span className="quick-dir">{row.dir}</span>}
                </span>
                {row.recent && <span className="quick-tag">最近</span>}
              </button>
            ))}
          {contentMode &&
            groups.map(({ file, hits }) => (
              <div key={file.path} className="search-file-group">
                <div className="search-file-head" title={file.path}>
                  <span className="search-file-name">{file.name}</span>
                  <span className="search-file-count">{file.hits.length}</span>
                </div>
                {hits.map((hit) => (
                  <button
                    key={hit.index}
                    className={"search-hit" + (hit.index === clamped ? " selected" : "")}
                    onMouseEnter={() => setSelected(hit.index)}
                    onClick={() => onOpenHit(file.path, trimmed, hit.line)}
                  >
                    <span className="search-hit-ln">{hit.line}</span>
                    <span className="search-hit-text">{hit.text}</span>
                  </button>
                ))}
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
