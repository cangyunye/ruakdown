import { useEffect, useRef } from "react";
import type { DocPayload } from "../ipc";
import { renderMermaidBlocks } from "../mermaid";

interface Props {
  doc: DocPayload;
  dark: boolean;
  onActiveHeading: (id: string | null) => void;
}

export function Reader({ doc, dark, onActiveHeading }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const onActiveRef = useRef(onActiveHeading);
  onActiveRef.current = onActiveHeading;

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

  return (
    <div
      ref={bodyRef}
      className="md-body"
      dangerouslySetInnerHTML={{ __html: doc.html ?? "" }}
    />
  );
}
