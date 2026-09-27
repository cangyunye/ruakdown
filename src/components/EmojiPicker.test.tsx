import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import EmojiPicker from "./EmojiPicker";

function setup() {
  const props = { x: 40, y: 60, onPick: vi.fn(), onClose: vi.fn() };
  render(<EmojiPicker {...props} />);
  return props;
}

describe("EmojiPicker", () => {
  it("picks an emoji from the first category", () => {
    const props = setup();
    fireEvent.click(screen.getByTitle("开心"));
    expect(props.onPick).toHaveBeenCalledWith("😀");
    // Picking keeps the panel open for more inserts.
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("switches categories", () => {
    const props = setup();
    fireEvent.click(screen.getByText("爱心"));
    fireEvent.click(screen.getByTitle("红心"));
    expect(props.onPick).toHaveBeenCalledWith("❤️");
  });

  it("closes on Escape and outside pointerdown but not on inner clicks", () => {
    const props = setup();
    fireEvent.click(screen.getByTitle("开心"));
    expect(props.onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(document.body, { bubbles: true });
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });

  it("does not grab focus (editor keeps the caret)", () => {
    setup();
    const focused = document.activeElement;
    expect(focused === null || focused === document.body).toBe(true);
  });
});
