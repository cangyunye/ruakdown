import { api, type Theme } from "./ipc";

/** Load a builtin theme from Rust, apply its CSS vars, sync the window chrome. */
export async function applyTheme(name: string): Promise<Theme | null> {
  try {
    const theme = await api.applyTheme(name);
    const root = document.documentElement;
    for (const [key, value] of Object.entries(theme.vars)) {
      root.style.setProperty(key, value);
    }
    root.dataset.theme = name;
    root.dataset.scheme = theme.dark ? "dark" : "light";
    root.style.colorScheme = theme.dark ? "dark" : "light";
    return theme;
  } catch (err) {
    console.error("applyTheme failed:", err);
    return null;
  }
}
