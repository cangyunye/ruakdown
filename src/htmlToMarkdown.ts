/** Clipboard `text/html` → Markdown source, so rich copies from browsers /
 * Office paste as editable Markdown into the source editor. Pure
 * DOM-in/markdown-out: the conversion itself is synchronous and fully
 * unit-testable; the caller only archives `data:` images (async) and does
 * the final single-dispatch insert. */
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

/** A base64 `data:` image found in the pasted HTML. `placeholder` appears
 * verbatim in `markdown` where the image URL belongs; the caller archives
 * `bytes` into the assets folder and replaces every placeholder occurrence
 * with the document-relative href. */
export interface PasteImage {
  placeholder: string;
  /** Suggested archive name; an `alt` that already looks like an image
   * filename wins over the generic `image.<ext>`. */
  filename: string;
  mime: string;
  bytes: Uint8Array;
}

export interface PasteConversion {
  markdown: string;
  images: PasteImage[];
  /** False when the HTML carries no meaningful markup — plain-text sources
   * (editors with syntax-highlighted copies) also emit a text/html flavour.
   * Callers should fall back to the native plain-text paste so ordinary
   * text is never re-typeset. */
  isMarkup: boolean;
}

/** Anything on this list means real structure worth converting. Sources
 * that only wrap plain text in <div>/<span> stay native pastes. */
const MEANINGFUL_SELECTOR =
  "h1,h2,h3,h4,h5,h6,p,ul,ol,li,table,blockquote,pre,code,a,img,strong,b," +
  "em,i,del,s,strike,u,mark,kbd,sup,sub,hr,dl,figure,br,td,th,tr";

const STRIP_SELECTOR =
  "script,style,noscript,iframe,object,embed,link,meta,title,base,head";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|ico)$/i;

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
};

let service: TurndownService | null = null;

/** Configured converter; created lazily so module import never touches the
 * DOM (keeps the module safe to load in plain-node test setups). */
function getService(): TurndownService {
  if (service) return service;
  const td = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
    strongDelimiter: "**",
    linkStyle: "inlined",
    // The br rule appends its own newline, so a lone backslash here yields
    // the CommonMark hard break `\<newline>`.
    br: "\\",
  });
  td.use(gfm);
  // Core listItem pads markers ("-   ", "1.  "); normalize to "- " / "1. "
  // with conventional 4-space nesting indents (matches the editor's
  // indentUnit, which core's prefix-derived indent would not).
  td.addRule("rkListItem", {
    filter: ["li"],
    replacement: (content, node) => {
      const parent = node.parentNode as HTMLElement | null;
      let prefix = "- ";
      if (parent && parent.nodeName === "OL") {
        const start = parent.getAttribute("start");
        const index = Array.prototype.indexOf.call(parent.children, node);
        prefix = `${start ? Number(start) + index : index + 1}. `;
      }
      const isParagraph = /\n$/.test(content);
      const trimmed =
        content.replace(/^\n+/, "").replace(/\n+$/, "") + (isParagraph ? "\n" : "");
      return prefix + trimmed.replace(/\n/gm, "\n    ") + (node.nextSibling ? "\n" : "");
    },
  });
  // The GFM plugin emits single-tilde strikethrough; the editor's syntax is
  // ~~…~~ (added after `use` so it wins the rule lookup).
  td.addRule("rkStrikethrough", {
    filter: (node) => ["DEL", "S", "STRIKE"].includes(node.nodeName),
    replacement: (content) => `~~${content}~~`,
  });
  // GFM table cells neither escape pipes nor tolerate line breaks (Excel
  // cells are full of <br>, which the br option already turned into hard
  // breaks). Flatten cell content to one line and escape pipes.
  td.addRule("rkTableCell", {
    filter: ["th", "td"],
    replacement: (content, node) => {
      const flat = content
        .replace(/\\\n/g, "<br>")
        .replace(/\s*\n+\s*/g, "<br>")
        .replace(/ {2,}/g, " ")
        .replace(/\|/g, "\\|");
      const parent = node.parentNode;
      const index = parent
        ? Array.prototype.indexOf.call(parent.childNodes, node)
        : -1;
      return (index === 0 ? "| " : " ") + flat + " |";
    },
  });
  // ruakdown-native syntax: underline/kbd round-trip verbatim, highlight
  // maps to ==…==, sup/sub survive as raw inline HTML (the renderer passes
  // them through; turndown's default would drop the tags entirely).
  td.addRule("rkUnderline", {
    filter: ["u"],
    replacement: (content) => `<u>${content}</u>`,
  });
  td.addRule("rkKeyboard", {
    filter: ["kbd"],
    replacement: (content) => `<kbd>${content}</kbd>`,
  });
  td.addRule("rkHighlight", {
    filter: ["mark"],
    replacement: (content) => `==${content}==`,
  });
  td.addRule("rkSupSub", {
    filter: ["sup", "sub"],
    replacement: (content, node) => {
      const tag = node.nodeName.toLowerCase();
      return `<${tag}>${content}</${tag}>`;
    },
  });
  service = td;
  return td;
}

/** Remove elements that can never map to Markdown and only carry risk or
 * noise: scripts/styles/frames, metadata, and comment noise (Office
 * <!--StartFragment--> markers). Also drops javascript: hrefs and normalizes
 * web-text whitespace junk (&nbsp;, zero-width characters). */
function cleanupClipboard(doc: Document): void {
  doc.querySelectorAll(STRIP_SELECTOR).forEach((el) => el.remove());
  const commentWalker = doc.createTreeWalker(doc, NodeFilter.SHOW_COMMENT);
  const comments: Node[] = [];
  while (commentWalker.nextNode()) comments.push(commentWalker.currentNode);
  comments.forEach((c) => c.parentNode?.removeChild(c));
  doc.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href") ?? "";
    if (/^\s*javascript:/i.test(href)) a.removeAttribute("href");
  });
  const textWalker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  while (textWalker.nextNode()) {
    const node = textWalker.currentNode;
    node.nodeValue = (node.nodeValue ?? "")
      .replace(/\u00A0/g, " ")
      .replace(/[\u200B\u200C\u200D\uFEFF]/g, "");
  }
}

/** GFM tables need a heading row, but Excel and many web pages ship bare
 * `<tr><td>…` rows. Promote each table's first row to the header so it
 * converts to a real Markdown table instead of a raw-HTML block. */
function promoteTableHeaders(doc: Document): void {
  doc.querySelectorAll("table").forEach((table) => {
    const el = table as HTMLTableElement;
    if (el.tHead && el.tHead.rows.length > 0) return;
    const firstRow = el.rows[0];
    if (!firstRow) return;
    const thead = el.tHead ?? doc.createElement("thead");
    if (!el.tHead) {
      table.insertBefore(thead, table.querySelector("tbody"));
    }
    thead.appendChild(firstRow);
    firstRow.querySelectorAll("td").forEach((td) => {
      const th = doc.createElement("th");
      th.innerHTML = td.innerHTML;
      td.replaceWith(th);
    });
  });
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Plain text for the isMarkup=false path (informational — callers fall back
 * to the native paste): top-level blocks joined by newlines. */
function plainTextOf(body: HTMLElement): string {
  if (body.children.length === 0) return (body.textContent ?? "").trim();
  return Array.from(body.children)
    .map((el) => (el.textContent ?? "").trim())
    .filter(Boolean)
    .join("\n");
}

/** Swap base64 bitmaps for archive placeholders, collecting the payloads.
 * Non-bitmap data URLs (SVG sources etc.) stay inline — a lossy rewrite
 * would silently drop content. */
function extractDataImages(doc: Document): PasteImage[] {
  const images: PasteImage[] = [];
  doc.querySelectorAll("img").forEach((img) => {
    const src = (img.getAttribute("src") ?? "").trim();
    const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(src);
    if (!match) return;
    const mime = match[1].toLowerCase();
    const ext = MIME_EXT[mime];
    if (!ext) return;
    const alt = (img.getAttribute("alt") ?? "").trim();
    const image: PasteImage = {
      placeholder: `__rk_paste_${images.length}__.${ext}`,
      filename: IMAGE_EXT.test(alt) ? alt : `image.${ext}`,
      mime,
      bytes: base64ToBytes(match[2].replace(/\s+/g, "")),
    };
    images.push(image);
    img.setAttribute("src", image.placeholder);
    if (!alt) img.setAttribute("alt", image.filename);
  });
  return images;
}

/** Convert a clipboard `text/html` payload to Markdown source. */
export function convertPasteHtml(html: string): PasteConversion {
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (!doc.body) return { markdown: "", images: [], isMarkup: false };
  cleanupClipboard(doc);
  if (!doc.body.querySelector(MEANINGFUL_SELECTOR)) {
    return {
      markdown: plainTextOf(doc.body),
      images: [],
      isMarkup: false,
    };
  }
  const images = extractDataImages(doc);
  promoteTableHeaders(doc);
  const markdown = getService()
    .turndown(doc.body.innerHTML)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { markdown, images, isMarkup: true };
}
