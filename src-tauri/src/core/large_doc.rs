use crate::core::markdown::{make_heading_id, md_options};
use pulldown_cmark::{html, CodeBlockKind, Event, Parser, Tag, TagEnd};
use serde::Serialize;

const TARGET_CHUNK_BYTES: usize = 32 * 1024;
const MAX_CHUNK_TAGS: u32 = 1500;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkInfo {
    pub html_bytes: u32,
    pub tags: u32,
    pub est_height: u32,
    pub has_mermaid: bool,
    pub first_heading: Option<u32>,
    pub last_heading: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkOutlineItem {
    pub level: u8,
    pub text: String,
    pub id: String,
    pub chunk: u32,
}

/// Chunk index sent to the frontend once per open; chunk HTML itself is
/// fetched on demand via `render_chunks`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkedDoc {
    pub token: u32,
    pub chunk_count: u32,
    pub chunks: Vec<ChunkInfo>,
    pub outline: Vec<ChunkOutlineItem>,
}

#[derive(Debug, Clone)]
pub struct Chunk {
    pub html: String,
    pub info: ChunkInfo,
}

/// A chunked document held in memory: the source (needed for rebuilds) plus
/// the rendered chunks.
pub struct CachedDoc {
    pub path: String,
    pub source: String,
    pub chunks: Vec<Chunk>,
    pub outline: Vec<ChunkOutlineItem>,
}

impl CachedDoc {
    pub fn meta(&self, token: u32) -> ChunkedDoc {
        ChunkedDoc {
            token,
            chunk_count: self.chunks.len() as u32,
            chunks: self.chunks.iter().map(|c| c.info.clone()).collect(),
            outline: self.outline.clone(),
        }
    }
}

struct RawBlock {
    html: String,
    tags: u32,
    mermaid: bool,
    kind: BlockKind,
    heading: Option<(u8, String, String, u32)>, // level, text, id, global index
}

#[derive(Clone, Copy, PartialEq)]
enum BlockKind {
    Heading,
    Code,
    Table,
    Quote,
    Other,
}

/// Split the document into top-level block fragments. Each fragment renders to
/// well-formed HTML on its own (CommonMark blocks are context-independent), so
/// any concatenation of fragments equals the full-document HTML.
fn build_blocks(source: &str) -> Vec<RawBlock> {
    let mut blocks: Vec<RawBlock> = Vec::new();
    let mut depth: usize = 0;
    let mut buffer: Vec<Event<'_>> = Vec::new();
    let mut heading_counter: usize = 0;

    for (event, _range) in Parser::new_ext(source, md_options()).into_offset_iter() {
        match &event {
            Event::Start(_) => {
                if depth == 0 {
                    buffer.clear();
                }
                depth += 1;
                buffer.push(event);
            }
            Event::End(_) => {
                if depth > 0 {
                    buffer.push(event);
                    depth -= 1;
                    if depth == 0 {
                        let events = std::mem::take(&mut buffer);
                        blocks.push(finish_block(events, &mut heading_counter));
                    }
                } else {
                    // Standalone End at top level (defensive): own fragment.
                    blocks.push(finish_block(vec![event], &mut heading_counter));
                }
            }
            other => {
                if depth == 0 {
                    // Standalone inline/HTML event between blocks: own fragment.
                    blocks.push(finish_block(vec![other.clone()], &mut heading_counter));
                } else {
                    buffer.push(event);
                }
            }
        }
    }
    if !buffer.is_empty() {
        blocks.push(finish_block(std::mem::take(&mut buffer), &mut heading_counter));
    }
    blocks
}

fn finish_block(events: Vec<Event<'_>>, heading_counter: &mut usize) -> RawBlock {
    let mut kind = BlockKind::Other;
    let mut mermaid = false;
    if let Some(Event::Start(tag)) = events.first() {
        match tag {
            Tag::Heading { .. } => kind = BlockKind::Heading,
            Tag::CodeBlock(CodeBlockKind::Fenced(info)) => {
                kind = BlockKind::Code;
                mermaid = info.eq_ignore_ascii_case("mermaid");
            }
            Tag::CodeBlock(_) => kind = BlockKind::Code,
            Tag::Table(_) => kind = BlockKind::Table,
            Tag::BlockQuote(_) => kind = BlockKind::Quote,
            _ => {}
        }
    }

    let mut heading: Option<(u8, String)> = None;
    let mut in_heading = false;
    for ev in &events {
        match ev {
            Event::Start(Tag::Heading { level, .. }) => {
                in_heading = true;
                heading = Some(((*level) as u8, String::new()));
            }
            Event::End(TagEnd::Heading(_)) => in_heading = false,
            Event::Text(t) | Event::Code(t) if in_heading => {
                if let Some((_, s)) = heading.as_mut() {
                    s.push_str(t);
                }
            }
            Event::SoftBreak | Event::HardBreak if in_heading => {
                if let Some((_, s)) = heading.as_mut() {
                    s.push(' ');
                }
            }
            _ => {}
        }
    }

    let mut html = String::with_capacity(events.len() * 24);
    html::push_html(&mut html, events.into_iter());
    let tags = count_tags(&html);

    let heading = heading.map(|(level, text)| {
        let id = make_heading_id(text.trim(), *heading_counter + 1);
        let idx = *heading_counter as u32;
        *heading_counter += 1;
        (level, text.trim().to_string(), id, idx)
    });

    if kind == BlockKind::Heading {
        if let Some((level, _, id, _)) = &heading {
            let needle = format!("<h{level}>");
            if let Some(pos) = html.find(&needle) {
                html.replace_range(pos..pos + needle.len(), &format!("<h{level} id=\"{id}\">"));
            }
        }
    }

    RawBlock { html, tags, mermaid, kind, heading }
}

fn count_tags(html: &str) -> u32 {
    let b = html.as_bytes();
    let mut n = 0u32;
    for i in 0..b.len() {
        if b[i] == b'<' {
            match b.get(i + 1) {
                Some(c) if c.is_ascii_alphabetic() || *c == b'/' || *c == b'!' => n += 1,
                _ => {}
            }
        }
    }
    n
}

fn est_height(kind: BlockKind, bytes: usize, mermaid: bool) -> u32 {
    if mermaid {
        return 320;
    }
    match kind {
        BlockKind::Heading => 96,
        BlockKind::Code => 60 + (bytes as u32 / 40),
        BlockKind::Table => 48 + (bytes as u32 / 3),
        _ => 36 + (bytes as u32 / 5),
    }
}

/// Accumulator for the chunk currently being assembled.
struct ChunkAcc {
    html: String,
    tags: u32,
    est: u32,
    mermaid: bool,
    first_heading: Option<u32>,
    last_heading: Option<u32>,
}

impl ChunkAcc {
    fn new() -> Self {
        Self {
            html: String::new(),
            tags: 0,
            est: 0,
            mermaid: false,
            first_heading: None,
            last_heading: None,
        }
    }

    fn is_full(&self) -> bool {
        !self.html.is_empty() && (self.html.len() >= TARGET_CHUNK_BYTES || self.tags >= MAX_CHUNK_TAGS)
    }

    fn push_block(&mut self, block: RawBlock) {
        self.est += est_height(block.kind, block.html.len(), block.mermaid);
        self.tags += block.tags;
        self.mermaid = self.mermaid || block.mermaid;
        self.html.push_str(&block.html);
    }

    /// Close the current chunk: bind every outline item added since the last
    /// flush to this chunk index.
    fn flush(
        &mut self,
        chunks: &mut Vec<Chunk>,
        outline: &mut [ChunkOutlineItem],
        assigned: &mut usize,
    ) {
        if self.html.is_empty() {
            return;
        }
        chunks.push(Chunk {
            html: std::mem::take(&mut self.html),
            info: ChunkInfo {
                html_bytes: 0,
                tags: self.tags,
                est_height: self.est,
                has_mermaid: self.mermaid,
                first_heading: self.first_heading,
                last_heading: self.last_heading,
            },
        });
        let chunk_index = (chunks.len() - 1) as u32;
        for item in &mut outline[*assigned..] {
            item.chunk = chunk_index;
        }
        *assigned = outline.len();
        self.tags = 0;
        self.est = 0;
        self.mermaid = false;
        self.first_heading = None;
        self.last_heading = None;
    }
}

/// Build the chunk index for a large document. Chunk boundaries always fall
/// between top-level blocks; budgets target ~32KB of HTML or ~1500 tags,
/// whichever hits first (a single oversized block becomes its own chunk).
pub fn build(source: &str) -> CachedDoc {
    let blocks = build_blocks(source);
    let mut chunks: Vec<Chunk> = Vec::new();
    let mut outline: Vec<ChunkOutlineItem> = Vec::new();
    let mut assigned: usize = 0; // outline items already bound to a flushed chunk
    let mut acc = ChunkAcc::new();

    for block in blocks {
        if acc.is_full() {
            acc.flush(&mut chunks, &mut outline, &mut assigned);
        }
        if let Some((level, text, id, idx)) = &block.heading {
            outline.push(ChunkOutlineItem {
                level: *level,
                text: text.clone(),
                id: id.clone(),
                chunk: 0,
            });
            if acc.first_heading.is_none() {
                acc.first_heading = Some(*idx);
            }
            acc.last_heading = Some(*idx);
        }
        acc.push_block(block);
    }
    acc.flush(&mut chunks, &mut outline, &mut assigned);

    for chunk in &mut chunks {
        chunk.info.html_bytes = chunk.html.len() as u32;
    }

    CachedDoc {
        path: String::new(),
        source: source.to_string(),
        chunks,
        outline,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::markdown::render_markdown;

    const TEMPLATE: &str = "# 章节标题\n\n这是一段中文正文,包含**加粗**、*斜体*和`行内代码`。\n\n- 列表项一\n- 列表项二\n\n| 列A | 列B |\n| --- | --- |\n| 1 | 2 |\n\n```rust\nfn main() {}\n```\n\n> 引用。\n\n";

    #[test]
    fn chunk_concat_equals_full_render() {
        let source = TEMPLATE.repeat(200);
        let doc = build(&source);
        assert!(doc.chunks.len() > 3, "expected multiple chunks, got {}", doc.chunks.len());
        let joined: String = doc.chunks.iter().map(|c| c.html.as_str()).collect();
        let full = render_markdown(&source).html;
        assert_eq!(joined, full, "chunk concatenation must equal full render");
    }

    #[test]
    fn outline_chunks_are_monotonic_and_complete() {
        let source = TEMPLATE.repeat(300);
        let doc = build(&source);
        assert_eq!(doc.outline.len(), 300); // one "# 章节标题" per template repeat
        let mut last_chunk = 0u32;
        for (i, item) in doc.outline.iter().enumerate() {
            assert!(item.chunk >= last_chunk, "outline chunk must be monotonic at {i}");
            last_chunk = item.chunk;
            assert!((item.chunk as usize) < doc.chunks.len());
        }
        // first/last heading pointers per chunk must line up with the outline
        for chunk in &doc.chunks {
            if let (Some(f), Some(l)) = (chunk.info.first_heading, chunk.info.last_heading) {
                assert!(f <= l);
                assert!((l as usize) < doc.outline.len());
            }
        }
    }

    #[test]
    fn heading_ids_stable_across_chunking() {
        let source = format!("{}\n\n## 小节\n\ntext\n\n", TEMPLATE.repeat(50));
        let doc = build(&source);
        let full = render_markdown(&source);
        assert_eq!(doc.outline.len(), full.outline.len());
        for (chunked, plain) in doc.outline.iter().zip(full.outline.iter()) {
            assert_eq!(chunked.id, plain.id);
            assert_eq!(chunked.text, plain.text);
        }
    }

    #[test]
    fn mermaid_flagged() {
        let source = "```mermaid\ngraph TD; A-->B;\n```\n\ntext\n\n";
        let doc = build(source);
        assert_eq!(doc.chunks.len(), 1);
        assert!(doc.chunks[0].info.has_mermaid);
        assert!(doc.chunks[0].info.est_height >= 320);
    }
}
