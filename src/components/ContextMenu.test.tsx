import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ContextMenu, { type CtxEntry } from "./ContextMenu";

const entries: CtxEntry[] = [
  { type: "item", id: "open", label: "打开" },
  { type: "sep" },
  { type: "item", id: "rename", label: "重命名", shortcut: "F2" },
  { type: "item", id: "delete", label: "删除", danger: true },
  { type: "item", id: "paste", label: "粘贴", disabled: true },
];

function setup() {
  const props = { x: 40, y: 60, entries, onClose: vi.fn(), onSelect: vi.fn() };
  render(<ContextMenu {...props} />);
  return props;
}

describe("ContextMenu", () => {
  it("renders items and selects + closes on click", () => {
    const props = setup();
    fireEvent.click(screen.getByText("重命名"));
    expect(props.onSelect).toHaveBeenCalledWith("rename");
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("renders danger and disabled styling", () => {
    setup();
    expect(screen.getByText("删除").closest("button")).toHaveClass("danger");
    const paste = screen.getByText("粘贴").closest("button") as HTMLButtonElement;
    expect(paste).toHaveClass("disabled");
    expect(paste.disabled).toBe(true);
  });

  it("closes on Escape", () => {
    const props = setup();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on outside pointerdown but not on the menu itself", () => {
    const props = setup();
    fireEvent.pointerDown(document.body, { bubbles: true });
    expect(props.onClose).toHaveBeenCalledTimes(1);

    // Re-open and check that pressing on the menu itself keeps it.
    cleanup();
    const props2 = { x: 0, y: 0, entries, onClose: vi.fn(), onSelect: vi.fn() };
    render(<ContextMenu {...props2} />);
    fireEvent.pointerDown(screen.getByText("打开"), { bubbles: true });
    expect(props2.onClose).not.toHaveBeenCalled();
  });

  it("moves focus with arrow keys", () => {
    setup();
    const items = screen.getAllByRole("menuitem").filter((b) => !(b as HTMLButtonElement).disabled);
    // The first enabled item is focused on open.
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[0]);
  });

  it("renders an icon with its color in the leading slot", () => {
    render(
      <ContextMenu
        x={0}
        y={0}
        entries={[{ type: "item", id: "note", label: "提示块 - Note", icon: "●", color: "#4f8ef7" }]}
        onClose={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    const icon = screen.getByText("●");
    expect(icon).toHaveClass("tb-menu-icon");
    expect(icon).toHaveStyle({ color: "#4f8ef7" });
  });

  it("skips the mount autofocus when autoFocus is false", () => {
    render(
      <ContextMenu
        x={0}
        y={0}
        entries={entries}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        autoFocus={false}
      />,
    );
    const items = screen.getAllByRole("menuitem");
    expect(items.some((b) => b === document.activeElement)).toBe(false);
  });

  it("navigates and activates from a window listener when windowKeyNav is on", () => {
    const props = {
      x: 0,
      y: 0,
      entries,
      onClose: vi.fn(),
      onSelect: vi.fn(),
      autoFocus: false,
      windowKeyNav: true,
    };
    render(<ContextMenu {...props} />);
    const items = screen
      .getAllByRole("menuitem")
      .filter((b) => !(b as HTMLButtonElement).disabled);
    expect(document.activeElement).not.toBe(items[0]);

    // ArrowDown from outside the menu focuses the first item (and the chord
    // is claimed so the editor never sees it).
    expect(fireEvent.keyDown(window, { key: "ArrowDown" })).toBe(false);
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[0]);
    // Wraps to the last enabled item.
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[items.length - 1]);

    fireEvent.keyDown(window, { key: "Enter" });
    expect(props.onSelect).toHaveBeenCalledWith("delete");
  });

  it("Enter with focus outside the menu activates the first item", () => {
    const props = {
      x: 0,
      y: 0,
      entries,
      onClose: vi.fn(),
      onSelect: vi.fn(),
      autoFocus: false,
      windowKeyNav: true,
    };
    render(<ContextMenu {...props} />);
    expect(fireEvent.keyDown(window, { key: "Enter" })).toBe(false);
    expect(props.onSelect).toHaveBeenCalledWith("open");
  });
});
