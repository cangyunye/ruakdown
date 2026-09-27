import { memo, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { entryNameError, ensureMdExt } from "../fileOps";
import type { TreeNode } from "../ipc";

/** Inline tree edit driven by the context menu / F2. For "new-*" kinds the
 * input renders inside `parentDir` (or at the root when `parentDir` is the
 * workspace root); "rename" replaces the label of `targetPath`. */
export type TreeDraft =
  | { kind: "rename"; targetPath: string; initial: string }
  | { kind: "new-file" | "new-dir"; parentDir: string };

interface Props {
  nodes: TreeNode[];
  /** Workspace root path — the root-level list is the only one whose
   * children are not tracked by a parent TreeNode. */
  rootPath: string | null;
  activeFile: string | null;
  onOpenFile: (path: string) => void;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  draft: TreeDraft | null;
  onCommitDraft: (name: string) => void;
  onCancelDraft: () => void;
  /** node === null means the blank area / workspace root was clicked. */
  onNodeContextMenu: (e: ReactMouseEvent, node: TreeNode | null) => void;
}

/** Auto-focused, auto-selected inline input. Enter commits, Esc cancels,
 * blur commits when valid and cancels otherwise. */
function DraftInput({
  initial,
  placeholder,
  siblings,
  transform,
  onCommit,
  onCancel,
}: {
  initial: string;
  placeholder: string;
  siblings: string[];
  /** Apply before validation (new files get ".md" appended). */
  transform: (name: string) => string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const stateRef = useRef({ committed: false, cancelled: false });

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    const dot = initial.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const validate = (v: string) => entryNameError(transform(v), siblings);

  const commit = () => {
    if (stateRef.current.committed || stateRef.current.cancelled) return;
    const v = value.trim();
    const problem = validate(v);
    if (problem || !v) {
      // Invalid on blur — just close instead of trapping the user.
      if (problem) onCancel();
      return;
    }
    stateRef.current.committed = true;
    onCommit(v);
  };

  return (
    <input
      ref={inputRef}
      className={"tree-rename" + (err ? " invalid" : "")}
      type="text"
      placeholder={placeholder}
      value={value}
      title={err ?? undefined}
      spellCheck={false}
      onChange={(e) => {
        setValue(e.target.value);
        setErr(validate(e.target.value));
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const v = value.trim();
          const problem = validate(v);
          if (problem || !v) {
            setErr(problem ?? "名称不能为空");
            return;
          }
          stateRef.current.committed = true;
          onCommit(v);
        } else if (e.key === "Escape") {
          e.preventDefault();
          stateRef.current.cancelled = true;
          onCancel();
        }
        // Stop the global chord handler from stealing keys while naming.
        e.stopPropagation();
      }}
      onBlur={commit}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    />
  );
}

/** Memoized all the way down: App re-renders on every keystroke/scroll tick,
 * but as long as the tree data and callbacks keep their identity, the whole
 * recursion is pruned from the render. */
export const FileTree = memo(function FileTree({
  nodes,
  rootPath,
  activeFile,
  onOpenFile,
  expanded,
  onToggle,
  draft,
  onCommitDraft,
  onCancelDraft,
  onNodeContextMenu,
}: Props) {
  /** The new-file/new-dir input row lives in the list it targets: the root
   * list when parentDir is the workspace root, else inside that folder. */
  const draftHere =
    draft != null && draft.kind !== "rename" && draft.parentDir === rootPath;
  // Folders targeted by the draft render expanded even if never toggled.
  const isOpen = (path: string) =>
    expanded.has(path) ||
    (draft != null && draft.kind !== "rename" && draft.parentDir === path);

  if (nodes.length === 0 && !draftHere) {
    return <div className="pane-empty">此文件夹下没有 Markdown 文件</div>;
  }

  const siblingNames = nodes.map((n) => n.name);

  return (
    <ul className="tree-root">
      {draftHere && draft && (
        <li>
          <div className="tree-row file draft-row">
            <span className="chev" />
            <DraftInput
              initial=""
              placeholder={draft.kind === "new-file" ? "文件名.md" : "文件夹名"}
              siblings={siblingNames}
              transform={draft.kind === "new-file" ? ensureMdExt : (n) => n}
              onCommit={onCommitDraft}
              onCancel={onCancelDraft}
            />
          </div>
        </li>
      )}
      {nodes.map((node) =>
        node.isDir ? (
          <li key={node.path}>
            {draft?.kind === "rename" && draft.targetPath === node.path ? (
              <div
                className="tree-row dir open renaming"
                data-path={node.path}
                data-dir="true"
                onContextMenu={(e) => onNodeContextMenu(e, node)}
              >
                <span className="chev">▸</span>
                <DraftInput
                  initial={draft.initial}
                  placeholder=""
                  siblings={nodes.filter((n) => n.path !== node.path).map((n) => n.name)}
                  transform={(n) => n}
                  onCommit={onCommitDraft}
                  onCancel={onCancelDraft}
                />
              </div>
            ) : (
              <button
                className={"tree-row dir" + (isOpen(node.path) ? " open" : "")}
                data-path={node.path}
                data-dir="true"
                onClick={() => onToggle(node.path)}
                onContextMenu={(e) => onNodeContextMenu(e, node)}
                title={node.path}
              >
                <span className="chev">▸</span>
                <span className="label">{node.name}</span>
              </button>
            )}
            {isOpen(node.path) && (
              <div className="tree-children">
                <FileTree
                  nodes={node.children}
                  rootPath={node.path}
                  activeFile={activeFile}
                  onOpenFile={onOpenFile}
                  expanded={expanded}
                  onToggle={onToggle}
                  draft={draft}
                  onCommitDraft={onCommitDraft}
                  onCancelDraft={onCancelDraft}
                  onNodeContextMenu={onNodeContextMenu}
                />
              </div>
            )}
          </li>
        ) : (
          <li key={node.path}>
            {draft?.kind === "rename" && draft.targetPath === node.path ? (
              <div
                className="tree-row file active renaming"
                data-path={node.path}
                onContextMenu={(e) => onNodeContextMenu(e, node)}
              >
                <span className="chev" />
                <DraftInput
                  initial={draft.initial}
                  placeholder=""
                  siblings={nodes.filter((n) => n.path !== node.path).map((n) => n.name)}
                  transform={(n) => n}
                  onCommit={onCommitDraft}
                  onCancel={onCancelDraft}
                />
              </div>
            ) : (
              <button
                className={"tree-row file" + (activeFile === node.path ? " active" : "")}
                data-path={node.path}
                onClick={() => onOpenFile(node.path)}
                onContextMenu={(e) => onNodeContextMenu(e, node)}
                title={node.path}
              >
                <span className="chev" />
                <span className="label">{node.name}</span>
              </button>
            )}
          </li>
        ),
      )}
    </ul>
  );
});
