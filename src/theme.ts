import { api, type Theme } from "./ipc";

/** Names written to :root by the previous applyTheme call. Theme JSONs carry
 * different slot sets (e.g. 论道武当 overrides --syn-* for its ink code
 * blocks), and inline style beats every stylesheet rule — stale entries would
 * silently override the next theme's values and the scheme defaults, so each
 * apply removes what the previous one set but the new theme doesn't define. */
let appliedVars: string[] = [];

/** Load a builtin theme from Rust, apply its CSS vars, sync the window chrome. */
export async function applyTheme(name: string): Promise<Theme | null> {
  try {
    const theme = await api.applyTheme(name);
    const root = document.documentElement;
    for (const key of appliedVars) {
      if (!(key in theme.vars)) root.style.removeProperty(key);
    }
    for (const [key, value] of Object.entries(theme.vars)) {
      root.style.setProperty(key, value);
    }
    appliedVars = Object.keys(theme.vars);
    root.dataset.theme = name;
    root.dataset.scheme = theme.dark ? "dark" : "light";
    root.style.colorScheme = theme.dark ? "dark" : "light";
    return theme;
  } catch (err) {
    console.error("applyTheme failed:", err);
    return null;
  }
}
