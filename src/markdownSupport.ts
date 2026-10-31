import { markdown, markdownLanguage } from "@codemirror/lang-markdown";

/** The editor parser must match the Rust renderer's GFM surface
 * (tables, task lists, strikethrough, GFM alerts). */
export const markdownSupport = markdown({ base: markdownLanguage });
