import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { findAllMatches, type MatchResult } from "../searchEngine";
import { clearRenderedMarks, markRenderedMatches } from "../readLocate";
import type { SourceSearch } from "../sourceSearch";
import type { Mode } from "../split";

/* ── Component ──────────────────────────────────────────────────── */

interface Props {
  mode: Mode;
  /** Editor bridge; null in read mode (replace disabled). */
  source: SourceSearch | null;
  /** Source text (read mode, or before the editor reports its handle). */
  docText: string;
  /** Bumped by the parent on every buffer change to re-run the search. */
  docVersion: number;
  showReplace: boolean;
  onShowReplace: (v: boolean) => void;
  onClose: () => void;
  /** Reader scroll container (read mode) for rendered-DOM highlighting. */
  readWrap: RefObject<HTMLDivElement | null>;
  /** Bumped by the parent on every Ctrl+F/Ctrl+R to re-focus the input. */
  focusNonce: number;
}

export default function SearchPanel({
  mode,
  source,
  docText,
  docVersion,
  showReplace,
  onShowReplace,
  onClose,
  readWrap,
  focusNonce,
}: Props) {
  const [query, setQuery] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [matches, setMatches] = useState<MatchResult[]>([]);
  const [current, setCurrent] = useState(0);

  const findRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const sigRef = useRef("");
  const readMode = mode === "read";
  const canReplace = !readMode && !!source;

  // Focus the active input whenever the replace row opens/closes or the
  // user re-triggers the panel.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const el = showReplace && canReplace ? replaceRef.current : findRef.current;
      el?.focus();
      el?.select();
    });
    return () => cancelAnimationFrame(id);
  }, [showReplace, canReplace, focusNonce]);

  // Re-run the search over the source text. A change to the query or the
  // options restarts from the first match; a document edit keeps position.
  useEffect(() => {
    const text = source ? source.getText() : docText;
    const found = query
      ? findAllMatches(text, query, { caseSensitive, regex, wholeWord })
      : [];
    const sig = `${query}\u0000${caseSensitive}\u0000${regex}\u0000${wholeWord}`;
    const restarted = sig !== sigRef.current;
    sigRef.current = sig;
    setMatches(found);
    setCurrent((c) => (restarted || found.length === 0 ? 0 : Math.min(c, found.length - 1)));
  }, [query, caseSensitive, regex, wholeWord, source, docText, docVersion]);

  // Source mode: paint highlights and scroll the current match into view.
  useEffect(() => {
    source?.highlight(matches, current);
  }, [source, matches, current]);

  useEffect(() => {
    if (source && matches[current]) source.scrollTo(matches[current]);
  }, [source, matches, current]);

  // Read mode: highlight the rendered DOM (source offsets → rendered text).
  useEffect(() => {
    if (!readMode) return;
    const root = readWrap.current?.querySelector(".md-body") ?? null;
    markRenderedMatches(root, docText, matches, current, caseSensitive);
    return () => clearRenderedMarks(root);
  }, [readMode, readWrap, docText, matches, current, caseSensitive]);

  // Drop every highlight when the panel closes or the editor is swapped.
  useEffect(
    () => () => {
      source?.clear();
      clearRenderedMarks(readWrap.current);
    },
    [source, readWrap],
  );

  const goNext = useCallback(() => {
    setCurrent((c) => (matches.length ? (c + 1) % matches.length : 0));
  }, [matches.length]);
  const goPrev = useCallback(() => {
    setCurrent((c) => (matches.length ? (c - 1 + matches.length) % matches.length : 0));
  }, [matches.length]);

  const doReplace = useCallback(() => {
    const m = matches[current];
    if (source && m) source.replaceMatch(m, replaceText);
  }, [source, matches, current, replaceText]);

  const doReplaceAll = useCallback(() => {
    if (source && matches.length) source.replaceAll(matches, replaceText);
  }, [source, matches, replaceText]);

  const onFindKey = (e: ReactKeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.shiftKey ? goPrev() : goNext();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  const onReplaceKey = (e: ReactKeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      doReplace();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  const counter = matches.length ? `${current + 1}/${matches.length}` : "0/0";

  return (
    <div className="search-panel" role="dialog" aria-label="查找替换">
      <div className="sp-row">
        <input
          ref={findRef}
          className="sp-input"
          placeholder="查找"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onFindKey}
        />
        <span className="sp-counter">{counter}</span>
        <button className="sp-btn" title="上一个 (Shift+Enter)" onClick={goPrev} disabled={!matches.length}>
          ‹
        </button>
        <button className="sp-btn" title="下一个 (Enter)" onClick={goNext} disabled={!matches.length}>
          ›
        </button>
        <button
          className={"sp-toggle" + (caseSensitive ? " on" : "")}
          title="区分大小写"
          onClick={() => setCaseSensitive((v) => !v)}
        >
          Aa
        </button>
        <button
          className={"sp-toggle" + (wholeWord ? " on" : "")}
          title="全词匹配"
          onClick={() => setWholeWord((v) => !v)}
        >
          W
        </button>
        <button
          className={"sp-toggle" + (regex ? " on" : "")}
          title="正则表达式"
          onClick={() => setRegex((v) => !v)}
        >
          .*
        </button>
        {!readMode && (
          <button
            className={"sp-btn" + (showReplace ? " active" : "")}
            title="替换 (Ctrl+R)"
            onClick={() => onShowReplace(!showReplace)}
          >
            {showReplace ? "▾" : "▸"}
          </button>
        )}
        <button className="sp-btn sp-close" title="关闭 (Esc)" onClick={onClose}>
          ×
        </button>
      </div>

      {showReplace && !readMode && (
        <div className="sp-row">
          <input
            ref={replaceRef}
            className="sp-input"
            placeholder="替换"
            value={replaceText}
            onChange={(e) => setReplaceText(e.target.value)}
            onKeyDown={onReplaceKey}
          />
          <button className="sp-btn" title="替换 (Enter)" onClick={doReplace} disabled={!matches.length}>
            替换
          </button>
          <button className="sp-btn" title="全部替换" onClick={doReplaceAll} disabled={!matches.length}>
            全部
          </button>
        </div>
      )}
    </div>
  );
}
