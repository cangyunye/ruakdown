import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";

/** The editor parser must match the Rust renderer's GFM surface
 * (tables, task lists, strikethrough, GFM alerts). `codeLanguages` embeds
 * fenced-code grammars so the live view can syntax-highlight code blocks —
 * grammars load lazily, one per info string actually used. */
export const markdownSupport = markdown({
  base: markdownLanguage,
  codeLanguages: languages,
});
