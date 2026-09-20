import { memo } from "react";
import type { OutlineItem } from "../ipc";

interface Props {
  items: OutlineItem[];
  activeId: string | null;
  onJump: (id: string) => void;
}

export const Outline = memo(function Outline({ items, activeId, onJump }: Props) {
  if (items.length === 0) {
    return <div className="pane-empty">本文档没有标题</div>;
  }
  return (
    <ul className="outline-root">
      {items.map((item, index) => (
        <li key={item.id + index}>
          <button
            className={"outline-row" + (activeId === item.id ? " active" : "")}
            style={{ paddingLeft: 10 + (item.level - 1) * 14 }}
            onClick={() => onJump(item.id)}
            title={item.text}
          >
            {item.text}
          </button>
        </li>
      ))}
    </ul>
  );
});
