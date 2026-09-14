import { useEffect, useRef } from "react";
import type { DocPayload } from "../ipc";
import { renderMermaidBlocks } from "../mermaid";
import {
  applyMarkSyntax,
  trackZenFocus,
  unwrapZenSections,
  wrapZenSections,
  type ZenController,
  type ZenLevel,
} from "../zen";

interface Props {
  doc: DocPayload;
  dark: boolean;
  onActiveHeading: (id: string | null) => void;
  onZenPos: (pos: { idx: number; total: number } | null) => void;
  onZenUnavailable: () => void;
  onZenController: (ctl: ZenController | null) => void;
  zenOn: boolean;
  zenLevel: ZenLevel;
}

export function Reader({
  doc,
  dark,
  onActiveHeading,
  onZenPos,
  onZenUnavailable,
  onZenController,
  zenOn,
  zenLevel,
}: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const onActiveRef = useRef(onActiveHeading);
  onActiveRef.current = onActiveHeading;
  const onZenPosRef = useRef(onZenPos);
  onZenPosRef.current = onZenPos;
  const onZenUnavailableRef = useRef(onZenUnavailable);
  onZenUnavailableRef.current = onZenUnavailable;
  const onZenControllerRef = useRef(onZenController);
  onZenControllerRef.current = onZenController;

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    renderMermaidBlocks(el, dark).catch((err) => console.error("mermaid render:", err));
  }, [doc, dark]);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const onScroll = () => {
      const headings = el.querySelectorAll<HTMLElement>("h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]");
      let active: string | null = null;
      const threshold = el.scrollTop + 96;
      for (const h of headings) {
        if (h.offsetTop <= threshold) active = h.id;
        else break;
      }
      onActiveRef.current(active);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener("scroll", onScroll);
  }, [doc]);

  // ==mark== syntax: rerun after each render; idempotent (marks are skipped).
  useEffect(() => {
    const el = bodyRef.current;
    if (el) applyMarkSyntax(el);
  }, [doc]);

  // Zen mode: split into sections and track the one at the viewport middle.
  // The wrap is plain DOM movement, so scroll-sync (offsetTop based) and
  // mermaid blocks keep working across it.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !zenOn) {
      onZenControllerRef.current(null);
      return;
    }
    if (!wrapZenSections(el, zenLevel)) {
      onZenControllerRef.current(null);
      onZenUnavailableRef.current();
      return;
    }
    const tracker = trackZenFocus(el, (pos) => onZenPosRef.current(pos));
    onZenControllerRef.current(tracker);
    return () => {
      tracker.stop();
      onZenControllerRef.current(null);
      unwrapZenSections(el);
      onZenPosRef.current(null);
    };
  }, [zenOn, zenLevel, doc]);

  return (
    <div
      ref={bodyRef}
      className="md-body"
      dangerouslySetInnerHTML={{ __html: doc.html ?? "" }}
    />
  );
}
