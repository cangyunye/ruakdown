import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SearchPanel from "./SearchPanel";
import type { SourceSearch } from "../sourceSearch";
import type { MatchResult } from "../searchEngine";

function fakeSource(text: string) {
  const calls: {
    highlight: [MatchResult[], number][];
    replaceMatch: [MatchResult, string][];
    replaceAll: number;
    clear: number;
  } = { highlight: [], replaceMatch: [], replaceAll: 0, clear: 0 };
  const source: SourceSearch = {
    getText: () => text,
    highlight: (m, c) => void calls.highlight.push([m, c]),
    scrollTo: () => {},
    clear: () => void calls.clear++,
    replaceMatch: (m, t) => void calls.replaceMatch.push([m, t]),
    replaceAll: () => void calls.replaceAll++,
  };
  return { source, calls };
}

const readWrap = createRef<HTMLDivElement>();

function renderPanel(over: Partial<Parameters<typeof SearchPanel>[0]> = {}) {
  const props = {
    mode: "edit" as const,
    source: null,
    docText: "foo foo bar",
    docVersion: 0,
    showReplace: false,
    onShowReplace: () => {},
    onClose: () => {},
    readWrap,
    focusNonce: 0,
    ...over,
  };
  return render(<SearchPanel {...props} />);
}

describe("SearchPanel", () => {
  it("counts matches and hands them to the source bridge", () => {
    const { source, calls } = fakeSource("foo foo bar");
    renderPanel({ source });

    fireEvent.change(screen.getByPlaceholderText("查找"), { target: { value: "foo" } });

    expect(screen.getByText("1/2")).toBeInTheDocument();
    const [matches] = calls.highlight[calls.highlight.length - 1];
    expect(matches).toEqual([
      { from: 0, to: 3 },
      { from: 4, to: 7 },
    ]);
  });

  it("respects the case-sensitivity toggle", () => {
    const { source } = fakeSource("Foo foo");
    renderPanel({ source });

    fireEvent.change(screen.getByPlaceholderText("查找"), { target: { value: "foo" } });
    expect(screen.getByText("1/2")).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("区分大小写"));
    expect(screen.getByText("1/1")).toBeInTheDocument();
  });

  it("expands the replace row and replaces the current match", () => {
    const { source, calls } = fakeSource("foo foo bar");
    const onShowReplace = vi.fn();
    const { rerender } = renderPanel({ source, onShowReplace });

    fireEvent.change(screen.getByPlaceholderText("查找"), { target: { value: "foo" } });
    fireEvent.click(screen.getByTitle("替换 (Ctrl+R)"));
    expect(onShowReplace).toHaveBeenCalledWith(true);

    rerender(
      <SearchPanel
        mode="edit"
        source={source}
        docText="foo foo bar"
        docVersion={0}
        showReplace
        onShowReplace={onShowReplace}
        onClose={() => {}}
        readWrap={readWrap}
        focusNonce={0}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("替换"), { target: { value: "X" } });
    fireEvent.click(screen.getByText("替换"));

    expect(calls.replaceMatch[calls.replaceMatch.length - 1]).toEqual([
      { from: 0, to: 3 },
      "X",
    ]);
  });

  it("hides replace in read mode", () => {
    renderPanel({ mode: "read", source: null, showReplace: true });
    expect(screen.queryByTitle("替换 (Ctrl+R)")).toBeNull();
    expect(screen.queryByPlaceholderText("替换")).toBeNull();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    renderPanel({ onClose });
    fireEvent.keyDown(screen.getByPlaceholderText("查找"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
