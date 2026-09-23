/**
 * Pure search utilities for the in-editor find/replace panel.
 * No CodeMirror dependency — operates on plain strings.
 */

/** Escape special regex characters in a string. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A single match position within the document. */
export interface MatchResult {
  from: number;
  to: number;
}

/** Options controlling how the search is performed. */
export interface SearchOptions {
  caseSensitive?: boolean;
  regex?: boolean;
  wholeWord?: boolean;
}

/**
 * Find all non-overlapping matches of `query` in `text`.
 * Returns an empty array when `query` is empty or produces no matches.
 */
export function findAllMatches(
  text: string,
  query: string,
  opts: SearchOptions,
): MatchResult[] {
  if (!query) return [];
  const results: MatchResult[] = [];
  const cs = !!opts.caseSensitive;
  const re = !!opts.regex;
  const ww = !!opts.wholeWord;

  if (re) {
    let regex: RegExp;
    try {
      regex = new RegExp(query, cs ? "g" : "gi");
    } catch {
      return [];
    }
    let m: RegExpExecArray | null;
    let safety = 0;
    while ((m = regex.exec(text)) !== null && safety++ < 100_000) {
      if (m[0].length === 0) {
        regex.lastIndex++;
        if (regex.lastIndex > text.length) break;
        continue;
      }
      results.push({ from: m.index, to: m.index + m[0].length });
    }
  } else {
    const needle = cs ? query : query.toLowerCase();
    const hay = cs ? text : text.toLowerCase();
    let pos = 0;
    while (pos <= hay.length) {
      const idx = hay.indexOf(needle, pos);
      if (idx === -1) break;
      if (ww) {
        const before = idx > 0 ? hay[idx - 1] : " ";
        const after = idx + needle.length < hay.length ? hay[idx + needle.length] : " ";
        if (/\w/.test(before) || /\w/.test(after)) {
          pos = idx + 1;
          continue;
        }
      }
      results.push({ from: idx, to: idx + needle.length });
      pos = idx + needle.length;
    }
  }
  return results;
}

/**
 * Replace the match at `matchIndex` and return the new document text
 * together with the updated index (clamped to the new match list).
 */
export function replaceAt(
  text: string,
  matches: MatchResult[],
  matchIndex: number,
  replacement: string,
): { newText: string; newIndex: number } {
  if (matchIndex < 0 || matchIndex >= matches.length) {
    return { newText: text, newIndex: matchIndex };
  }
  const m = matches[matchIndex];
  const newText = text.slice(0, m.from) + replacement + text.slice(m.to);
  return { newText, newIndex: Math.min(matchIndex, Math.max(0, matches.length - 1)) };
}

/**
 * Replace every match and return the new document text.
 */
export function replaceAll(
  text: string,
  matches: MatchResult[],
  replacement: string,
): string {
  if (matches.length === 0) return text;
  let result = "";
  let prev = 0;
  for (const m of matches) {
    result += text.slice(prev, m.from) + replacement;
    prev = m.to;
  }
  result += text.slice(prev);
  return result;
}
