import type { CtxEntry } from "./components/ContextMenu";

/** GitHub-alert callout types shared by the editor context menu and the
 * slash palette, with dot colors picked to stay readable on both light and
 * dark themes. */
export const CALLOUT_TYPES = [
  { id: "NOTE", label: "提示块 - Note", color: "#4c8dff" },
  { id: "TIP", label: "提示块 - Tip", color: "#3fbf6f" },
  { id: "IMPORTANT", label: "提示块 - Important", color: "#a371f7" },
  { id: "WARNING", label: "提示块 - Warning", color: "#d9a103" },
  { id: "CAUTION", label: "提示块 - Caution", color: "#ef5350" },
] as const;

/** MOD_KEY from shortcuts.ts, duplicated here to keep this module
 * dependency-free for unit tests. */
const MOD_KEY =
  typeof navigator !== "undefined" && /mac/i.test(navigator.platform) ? "⌘" : "Ctrl";

/** Entries for the editor context menu (`includeClipboard`: cut/copy/paste +
 * 新建子文档并引用 — context menu only) and the "/" / "、" slash palette
 * (insertion commands only). Markdown rendering of callouts/math lands in a
 * later release; the menu already speaks the final syntax. */
export function buildEditorMenuEntries(includeClipboard: boolean): CtxEntry[] {
  const items: CtxEntry[] = [];
  if (includeClipboard) {
    items.push(
      { type: "item", id: "cut", label: "剪切", shortcut: `${MOD_KEY}+X` },
      { type: "item", id: "copy", label: "复制", shortcut: `${MOD_KEY}+C` },
      { type: "item", id: "paste", label: "粘贴", shortcut: `${MOD_KEY}+V` },
      { type: "sep" },
      { type: "item", id: "new-subdoc", label: "新建子文档并引用" },
      { type: "sep" },
    );
  }
  items.push(
    ...([1, 2, 3, 4, 5, 6] as const).map((level) => ({
      type: "item" as const,
      id: `h${level}`,
      label: `${level} 级标题块`,
      shortcut: `${MOD_KEY}+Alt+${level}`,
    })),
    { type: "item", id: "ul", label: "无序列表块" },
    { type: "item", id: "ol", label: "有序列表块" },
    { type: "item", id: "task", label: "任务列表块", shortcut: `${MOD_KEY}+L` },
    { type: "item", id: "quote", label: "引述块" },
    { type: "sep" },
    ...CALLOUT_TYPES.map((c) => ({
      type: "item" as const,
      id: `callout-${c.id}`,
      label: c.label,
      icon: "●",
      color: c.color,
    })),
    { type: "item", id: "callout-clear", label: "清除提示块" },
    { type: "sep" },
    { type: "item", id: "codeblock", label: "代码块", shortcut: `${MOD_KEY}+Shift+K` },
    { type: "item", id: "table", label: "表格", shortcut: `${MOD_KEY}+O` },
    { type: "item", id: "hr", label: "分隔线" },
    { type: "item", id: "mathblock", label: "公式块" },
    { type: "item", id: "mindmap", label: "思维导图" },
    { type: "sep" },
    { type: "item", id: "link", label: "链接", shortcut: `${MOD_KEY}+K` },
    { type: "item", id: "bold", label: "粗体", shortcut: `${MOD_KEY}+B` },
    { type: "item", id: "italic", label: "斜体", shortcut: `${MOD_KEY}+I` },
    { type: "item", id: "underline", label: "下划线", shortcut: `${MOD_KEY}+U` },
    { type: "item", id: "strike", label: "删除线", shortcut: `${MOD_KEY}+Shift+S` },
    { type: "item", id: "mark", label: "标记", shortcut: "Alt+D" },
    { type: "item", id: "sup", label: "上标" },
    { type: "item", id: "sub", label: "下标" },
    { type: "item", id: "inlinecode", label: "行内代码", shortcut: `${MOD_KEY}+\`` },
    { type: "item", id: "kbd", label: "键盘", shortcut: `${MOD_KEY}+'` },
    { type: "item", id: "inlinemath", label: "行内公式", shortcut: `${MOD_KEY}+M` },
    { type: "sep" },
    { type: "item", id: "insert-asset", label: "插入图片或文件" },
    { type: "item", id: "insert-image-link", label: "插入图片链接" },
    { type: "item", id: "insert-iframe", label: "插入 IFrame 链接" },
    { type: "item", id: "insert-video", label: "插入视频链接" },
    { type: "item", id: "insert-audio", label: "插入音频链接" },
  );
  return items;
}
