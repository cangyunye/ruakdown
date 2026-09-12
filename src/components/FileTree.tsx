import { useState } from "react";
import type { TreeNode } from "../ipc";

interface Props {
  nodes: TreeNode[];
  activeFile: string | null;
  onOpenFile: (path: string) => void;
}

export function FileTree({ nodes, activeFile, onOpenFile }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  if (nodes.length === 0) {
    return <div className="pane-empty">此文件夹下没有 Markdown 文件</div>;
  }

  return (
    <ul className="tree-root">
      {nodes.map((node) =>
        node.isDir ? (
          <li key={node.path}>
            <button
              className={"tree-row dir" + (expanded.has(node.path) ? " open" : "")}
              onClick={() => toggle(node.path)}
            >
              <span className="chev">▸</span>
              <span className="label">{node.name}</span>
            </button>
            {expanded.has(node.path) && (
              <div className="tree-children">
                <FileTree nodes={node.children} activeFile={activeFile} onOpenFile={onOpenFile} />
              </div>
            )}
          </li>
        ) : (
          <li key={node.path}>
            <button
              className={"tree-row file" + (activeFile === node.path ? " active" : "")}
              onClick={() => onOpenFile(node.path)}
              title={node.path}
            >
              <span className="chev" />
              <span className="label">{node.name}</span>
            </button>
          </li>
        ),
      )}
    </ul>
  );
}
