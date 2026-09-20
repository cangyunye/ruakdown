import { memo } from "react";
import { FileTree } from "./FileTree";
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
        <div className={"sidebar-pane" + (props.tab === "files" ? "" : " hidden")}>
          {props.hasFolder ? (
            <FileTree
              nodes={props.tree}
              activeFile={props.activeFile}
              onOpenFile={props.onOpenFile}
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
