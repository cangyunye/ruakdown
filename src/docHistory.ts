/** Browser-style back/forward history of opened documents. Driven by the
 * order files are opened in; the mouse side buttons, menu items and chords
 * all share one instance (session-only, never persisted). */

/** Cap on the back stack; the oldest entry is evicted past it so long
 * sessions can't grow it without bound. */
export const DOC_HISTORY_LIMIT = 100;

export type DocHistory = {
  /** Origin docs in visit order (the tail is the one just left). */
  back: string[];
  /** Only populated after going back; the tail is the most recent one
   * left behind by a back move. */
  forward: string[];
};

export function emptyHistory(): DocHistory {
  return { back: [], forward: [] };
}

export function canGoBack(h: DocHistory): boolean {
  return h.back.length > 0;
}

export function canGoForward(h: DocHistory): boolean {
  return h.forward.length > 0;
}

/** Record an ordinary jump (from → to): push from onto the back stack and
 * void the forward branch. History moves (history: false) and re-opening
 * the same file record nothing. */
export function pushVisit(
  h: DocHistory,
  from: string | null,
  to: string,
): DocHistory {
  if (!from || from === to) return h;
  const back = [...h.back, from];
  if (back.length > DOC_HISTORY_LIMIT) {
    back.splice(0, back.length - DOC_HISTORY_LIMIT);
  }
  return { back, forward: [] };
}

/** Go back: pop the back-stack tail as the target and push the current doc
 * onto the forward stack. Returns target null when there is nowhere to go. */
export function popBack(
  h: DocHistory,
  current: string | null,
): { history: DocHistory; target: string | null } {
  if (!h.back.length || !current) return { history: h, target: null };
  return {
    history: {
      back: h.back.slice(0, -1),
      forward: [...h.forward, current],
    },
    target: h.back[h.back.length - 1],
  };
}

/** Go forward: pop the forward-stack tail as the target and push the
 * current doc back onto the back stack. */
export function popForward(
  h: DocHistory,
  current: string | null,
): { history: DocHistory; target: string | null } {
  if (!h.forward.length || !current) return { history: h, target: null };
  return {
    history: {
      back: [...h.back, current],
      forward: h.forward.slice(0, -1),
    },
    target: h.forward[h.forward.length - 1],
  };
}
