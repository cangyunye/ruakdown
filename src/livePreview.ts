import { type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

const liveTheme = EditorView.theme({
  "&.rk-live .cm-scroller": {
    fontFamily: "inherit",
    fontSize: "15px",
    lineHeight: "1.75",
  },
  "&.rk-live .cm-content": {
    maxWidth: "860px",
    padding: "24px 16px 60vh",
  },
  "&.rk-live .cm-line": {
    padding: "0 8px",
  },
});

/** Live-preview decorations; the decoration pass is added in Task 5. */
export function livePreview(docPath: string): Extension {
  void docPath;
  return [EditorView.editorAttributes.of({ class: "rk-live" }), liveTheme];
}
