import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import TitleBar, { type TitleBarProps } from "./TitleBar";
import type { Mode } from "../split";

const THEME_LABELS: Record<string, string> = {
  light: "浅色",
  dark: "暗色",
  graphite: "石墨",
};

function renderBar(over: Partial<TitleBarProps> = {}) {
  const props: TitleBarProps = {
    mode: "read",
    hasDoc: true,
    docName: "notes.md",
    docPath: "C:/docs/notes.md",
    dirty: false,
    zenAvailable: true,
    zenOn: false,
    fullscreenOn: false,
    themeName: "light",
    themeLabels: THEME_LABELS,
    shareAvailable: false,
    onMode: () => {},
    onZen: () => {},
    onFullscreen: () => {},
    onTheme: () => {},
    onSettings: () => {},
    onAction: () => {},
    ...over,
  };
  const utils = render(<TitleBar {...props} />);
  const rerender = (next: Partial<TitleBarProps> = {}) =>
    utils.rerender(<TitleBar {...{ ...props, ...next }} />);
  return { ...utils, rerender };
}

describe("TitleBar", () => {
  it("shows the doc name and hides the mode switch without a document", () => {
    const { rerender } = renderBar({ hasDoc: false, docName: null, docPath: null });

    expect(screen.getByTitle("Ruakdown")).toHaveTextContent("Ruakdown");
    expect(screen.queryByLabelText("视图模式")).toBeNull();

    rerender({ hasDoc: true, docName: "notes.md" });
    expect(screen.getByLabelText("视图模式")).not.toBeNull();
  });

  it("switches view modes from the segmented control", () => {
    const onMode = vi.fn();
    renderBar({ onMode });

    fireEvent.click(screen.getByRole("button", { name: "分屏" }));
    expect(onMode).toHaveBeenCalledWith("split");
    fireEvent.click(screen.getByRole("button", { name: "源码" }));
    expect(onMode).toHaveBeenCalledWith("edit");
  });

  it("marks the active mode", () => {
    renderBar({ mode: "edit" as Mode });

    expect(screen.getByRole("button", { name: "源码" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "阅读" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("shows the dirty dot only while edits are unsaved", () => {
    const { rerender } = renderBar({ dirty: false });
    expect(screen.queryByTitle("有未保存的修改")).toBeNull();

    rerender({ dirty: true });
    expect(screen.getByTitle("有未保存的修改")).not.toBeNull();
  });

  it("picks a theme from the dropdown and closes the menu", () => {
    const onTheme = vi.fn();
    renderBar({ onTheme });

    fireEvent.click(screen.getByTitle("切换主题"));
    const dark = screen.getByRole("menuitemradio", { name: "暗色" });
    expect(dark).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("menuitemradio", { name: "浅色" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    fireEvent.click(dark);
    expect(onTheme).toHaveBeenCalledWith("dark");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("hides the zen button when the document cannot use it", () => {
    const { rerender } = renderBar({ zenAvailable: false });
    expect(screen.queryByTitle(/专注模式/)).toBeNull();

    const onZen = vi.fn();
    rerender({ zenAvailable: true, onZen });
    fireEvent.click(screen.getByTitle(/专注模式/));
    expect(onZen).toHaveBeenCalledTimes(1);
  });

  it("routes kebab-menu actions and omits share entries in lightweight builds", () => {
    const onAction = vi.fn();
    renderBar({ onAction, shareAvailable: false });

    fireEvent.click(screen.getByTitle("更多操作"));
    expect(screen.queryByRole("menuitem", { name: /本机预览服务/ })).toBeNull();

    fireEvent.click(screen.getByRole("menuitem", { name: /导出 HTML/ }));
    expect(onAction).toHaveBeenCalledWith("export-html");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("lists share actions only in share builds", () => {
    renderBar({ shareAvailable: true });

    fireEvent.click(screen.getByTitle("更多操作"));
    expect(screen.getByRole("menuitem", { name: "本机预览服务" })).not.toBeNull();
    expect(
      screen.getByRole("menuitem", { name: "局域网分享 (同步浏览)" }),
    ).not.toBeNull();
  });

  it("closes the open menu with Escape", () => {
    renderBar();

    fireEvent.click(screen.getByTitle("更多操作"));
    expect(screen.queryByRole("menu")).not.toBeNull();

    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("renders no window controls outside the Tauri webview", () => {
    renderBar();

    expect(screen.queryByRole("button", { name: "最小化" })).toBeNull();
    expect(screen.queryByRole("button", { name: "关闭" })).toBeNull();
  });

  it("shows the app version as a non-interactive menu footer", () => {
    renderBar({ version: "0.9.0" });

    fireEvent.click(screen.getByTitle("更多操作"));
    const footer = screen.getByText("Ruakdown v0.9.0");
    expect(footer).toHaveClass("tb-menu-version");
    expect(footer.closest("button")).toBeNull();
  });

  it("omits the version footer when no version is available", () => {
    renderBar({ version: null });

    fireEvent.click(screen.getByTitle("更多操作"));
    expect(screen.queryByText(/Ruakdown v/)).toBeNull();
  });
});
