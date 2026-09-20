import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type SearchFileResult, type SearchOutcome } from "../ipc";

interface SearchModalProps {
  root: string | null;
  onClose: () => void;
  onOpenHit: (path: string, query: string, line?: number) => void;
}

interface FlatHit {
  file: SearchFileResult;
  line: number;
  text: string;
}

interface FileGroup {
  file: SearchFileResult;
  hits: Array<FlatHit & { index: number }>;
}

interface HitRowProps {
  hit: FlatHit & { index: number };
  selected: boolean;
  selectedRef: React.RefObject<HTMLButtonElement | null>;
  query: string;
  caseSensitive: boolean;
  onHover: (index: number) => void;
  onOpen: (hit: FlatHit & { index: number }) => void;
}

/** Memoized row: hovering the list flips `selected` on two rows only, so a
 * 300-result modal no longer re-renders every row per mousemove. */
const HitRow = memo(function HitRow({
  hit,
  selected,
  selectedRef,
  query,
  caseSensitive,
  onHover,
  onOpen,
}: HitRowProps) {
  return (
    <button
      ref={selected ? selectedRef : undefined}
      className={"search-hit" + (selected ? " selected" : "")}
      onMouseEnter={() => onHover(hit.index)}
      onClick={() => onOpen(hit)}
    >
      <span className="search-hit-ln">{hit.line}</span>
      <span className="search-hit-text">
        <Highlighted text={hit.text} query={query} caseSensitive={caseSensitive} />
      </span>
    </button>
  );
});

/** Split text into plain / <mark> segments so matching keywords stand out
 * without touching innerHTML. */
function Highlighted({
  text,
  query,
  caseSensitive,
}: {
  text: string;
  query: string;
  caseSensitive: boolean;
}) {
  const hay = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  if (!needle) return <>{text}</>;
  const parts: Array<{ s: string; mark: boolean }> = [];
  let i = 0;
  while (i < text.length) {
    const idx = hay.indexOf(needle, i);
    if (idx === -1) {
      parts.push({ s: text.slice(i), mark: false });
      break;
    }
    if (idx > i) parts.push({ s: text.slice(i, idx), mark: false });
    parts.push({ s: text.slice(idx, idx + needle.length), mark: true });
    i = idx + needle.length;
  }
  return (
    <>
      {parts.map((p, k) =>
        p.mark ? <mark key={k}>{p.s}</mark> : <span key={k}>{p.s}</span>,
      )}
    </>
  );
}

/** Wait this long after the last keystroke before scanning the workspace. */
const DEBOUNCE_MS = 500;
/** Single-character queries match whole vaults; require a bit more intent. */
const MIN_QUERY_LEN = 2;
/** Mirrors the backend's per-file hit cap, purely for a hint row. */
const PER_FILE_HIT_CAP = 50;
/** Upper bound on rendered rows; the status line still reports the real count. */
const RENDER_CAP = 300;

export default function SearchModal({ root, onClose, onOpenHit }: SearchModalProps) {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [result, setResult] = useState<SearchOutcome | null>(null);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState(0);

  const seqRef = useRef(0);
  const inflightRef = useRef(false);
  const rerunRef = useRef<{ q: string; cs: boolean } | null>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);

  const trimmed = query.trim();
  const canSearch = Boolean(root) && trimmed.length >= MIN_QUERY_LEN;

  // Run at most one workspace scan at a time. Searches requested while a scan
  // is in flight collapse into the newest query and re-run when it settles, so
  // typing can never pile up overlapping CPU-heavy scans.
  const runSearch = useCallback(
    async (q: string, cs: boolean) => {
      if (!root) return;
      if (inflightRef.current) {
        rerunRef.current = { q, cs };
        return;
      }
      inflightRef.current = true;
      const seq = ++seqRef.current;
      setSearching(true);
      try {
        const outcome = await api.searchDocs(root, q, cs);
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
        if (next) {
          void runSearch(next.q, next.cs);
        } else {
          setSearching(false);
        }
      }
    },
    [root],
  );

  // Debounced trigger; responses invalidated by a newer query are discarded.
  useEffect(() => {
    if (!canSearch) {
      seqRef.current += 1;
      rerunRef.current = null;
      setResult(null);
      setSearching(false);
      return;
    }
    const timer = window.setTimeout(
      () => void runSearch(trimmed, caseSensitive),
      DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [trimmed, caseSensitive, root, canSearch, runSearch]);

  // Grouped rows for rendering plus a flat index space for ↑/↓/Enter, capped
  // so a vault-wide query cannot explode the DOM.
  const groups = useMemo<FileGroup[]>(() => {
    const list: FileGroup[] = [];
    let index = 0;
    let shown = 0;
    for (const file of result?.files ?? []) {
      if (shown >= RENDER_CAP) break;
      const take = Math.min(file.hits.length, RENDER_CAP - shown);
      const hits = file.hits.slice(0, take).map((hit) => ({
        file,
        line: hit.line,
        text: hit.text,
        index: index++,
      }));
      shown += take;
      list.push({ file, hits });
    }
    return list;
  }, [result]);
  const renderedRows = groups.reduce((n, g) => n + g.hits.length, 0);
  const hiddenRows = result ? Math.max(result.totalHits - renderedRows, 0) : 0;

  // Esc closes even when the input lost focus (e.g. after clicking a result).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Keep the keyboard-selected row visible.
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const openIndex = (index: number) => {
    for (const g of groups) {
      const hit = g.hits.find((h) => h.index === index);
      if (hit) {
        onOpenHit(hit.file.path, trimmed, hit.line);
        return;
      }
    }
  };

  // Stable row callbacks so memoized rows only re-render on real changes.
  const hoverRow = useCallback((index: number) => setSelected(index), []);
  const openRow = useCallback(
    (hit: FlatHit & { index: number }) => onOpenHit(hit.file.path, trimmed, hit.line),
    [onOpenHit, trimmed],
  );

  const onInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, Math.max(renderedRows - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      openIndex(selected);
    }
  };

  let status: string;
  if (!root) {
    status = "请先打开文件夹,再搜索其中的 Markdown 文档";
  } else if (!trimmed) {
    status = "输入关键词,递归搜索当前目录下所有 .md / .markdown 文件";
  } else if (trimmed.length < MIN_QUERY_LEN) {
    status = `至少输入 ${MIN_QUERY_LEN} 个字符,避免过宽的搜索拖慢目录扫描`;
  } else if (searching) {
    status = "搜索中…";
  } else if (result) {
    status = result.files.length
      ? `${result.files.length} 个文件 · ${result.totalHits} 处匹配${result.truncated ? "(结果已截断)" : ""}`
      : "无匹配结果";
  } else {
    status = "";
  }

  const showResults = canSearch && groups.length > 0;
  const showEmpty = canSearch && !searching && groups.length === 0;

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal search-modal" onClick={(e) => e.stopPropagation()}>
        <div className="search-input-row">
          <input
            className="search-input"
            type="text"
            placeholder="搜索当前目录…"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
          />
          <button
            className={"search-case-btn" + (caseSensitive ? " active" : "")}
            title={caseSensitive ? "已区分大小写" : "不区分大小写"}
            onClick={() => setCaseSensitive((v) => !v)}
          >
            Aa
          </button>
        </div>
        <div className="search-status">{status}</div>
        <div className="search-results">
          {showEmpty && <div className="search-empty">没有找到匹配的内容</div>}
          {showResults &&
            groups.map(({ file, hits }) => (
              <div key={file.path} className="search-file-group">
                <div className="search-file-head" title={file.path}>
                  <span className="search-file-name">{file.name}</span>
                  {file.nameMatch && <span className="search-name-tag">文件名</span>}
                  <span className="search-file-count">{file.hits.length}</span>
                </div>
                {hits.length >= PER_FILE_HIT_CAP && (
                  <div className="search-hits-cap">该文件匹配较多,仅显示前 {PER_FILE_HIT_CAP} 条</div>
                )}
                {hits.map((hit) => (
                  <HitRow
                    key={hit.index}
                    hit={hit}
                    selected={hit.index === selected}
                    selectedRef={selectedRef}
                    query={trimmed}
                    caseSensitive={caseSensitive}
                    onHover={hoverRow}
                    onOpen={openRow}
                  />
                ))}
              </div>
            ))}
          {hiddenRows > 0 && (
            <div className="search-more">
              已显示前 {renderedRows} 条,其余 {hiddenRows} 条未列出,可输入更长的关键词缩小范围
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
