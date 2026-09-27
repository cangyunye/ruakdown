import { memo, type MouseEvent as ReactMouseEvent } from "react";
import { FileTree, type TreeDraft } from "./FileTree";
import { Outline } from "./Outline";
import type { OutlineItem, TreeNode } from "../ipc";

export type SidebarTab = "files" | "outline";

interface Props {
  tab: SidebarTab;
  onTabChange: (tab: SidebarTab) => void;
  tree: TreeNode[];
  outline: OutlineItem[];
  activeFile: string | null;
  activeHeading: string | null;
  hasFolder: boolean;
  /** Workspace root path (file-tree context menu anchor). */
  rootPath: string | null;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  draft: TreeDraft | null;
  onCommitDraft: (name: string) => void;
  onCancelDraft: () => void;
  /** node === null is the blank area of the pane. */
  onNodeContextMenu: (e: ReactMouseEvent, node: TreeNode | null) => void;
  onOpenFile: (path: string) => void;
  onJump: (id: string) => void;
}

/** Memoized: App re-renders on every keystroke and scroll tick, but the
 * sidebar only depends on tree/outline/active state — all stable between
 * real changes, so unrelated renders stop here. */
export const Sidebar = memo(function Sidebar(props: Props) {
  return (
    <aside className="sidebar">
      <div className="sidebar-tabs">
        <button
          className={"tab" + (props.tab === "files" ? " active" : "")}
          onClick={() => props.onTabChange("files")}
        >
          文件
        </button>
        <button
          className={"tab" + (props.tab === "outline" ? " active" : "")}
          onClick={() => props.onTabChange("outline")}
        >
          大纲
        </button>
      </div>
      <div className="sidebar-panes">
        <div
          className={"sidebar-pane" + (props.tab === "files" ? "" : " hidden")}
          onContextMenu={(e) => props.onNodeContextMenu(e, null)}
        >
          {props.hasFolder ? (
            <FileTree
              nodes={props.tree}
              rootPath={props.rootPath}
              activeFile={props.activeFile}
              onOpenFile={props.onOpenFile}
              expanded={props.expanded}
              onToggle={props.onToggle}
              draft={props.draft}
              onCommitDraft={props.onCommitDraft}
              onCancelDraft={props.onCancelDraft}
              onNodeContextMenu={props.onNodeContextMenu}
            />
          ) : (
            <div className="pane-empty">尚未打开文件夹</div>
          )}
        </div>
        <div className={"sidebar-pane" + (props.tab === "outline" ? "" : " hidden")}>
          <Outline
            items={props.outline}
            activeId={props.activeHeading}
            onJump={props.onJump}
          />
        </div>
      </div>
    </aside>
  );
});
