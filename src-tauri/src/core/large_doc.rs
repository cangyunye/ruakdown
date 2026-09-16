use crate::core::markdown::{highlight_code_events, make_heading_id, md_options};
use pulldown_cmark::{html, CodeBlockKind, Event, Parser, Tag, TagEnd};
use serde::Serialize;
use std::collections::HashMap;

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
    /// Global top-level block index the heading lives in; lets the split
    /// view map an outline click straight onto the editor line.
    pub bi: u32,
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

/// One entry of the block→source table. `bi` doubles as the `data-bi`
/// attribute injected into the rendered HTML, so the frontend can jump from
/// an editor line to a preview element (and back) with plain lookups.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockInfo {
    /// Global top-level block index.
    pub bi: u32,
    /// Chunk the block was packed into.
    pub chunk: u32,
    /// 1-based source line range of the block.
    pub start_line: u32,
    pub end_line: u32,
    /// Heading id when the block is a heading.
    pub heading_id: Option<String>,
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
    /// Block→source-line table for editor/preview scroll sync.
    pub blocks: Vec<BlockInfo>,
    /// Fresh per-block render cache; `Some` only for preview builds.
    pub reuse: Option<BlockReuseMap>,
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

#[derive(Clone)]
struct RawBlock {
    html: String,
    tags: u32,
    mermaid: bool,
    kind: BlockKind,
    heading: Option<(u8, String, String, u32)>, // level, text, id, global index
    src_start: usize,
    src_end: usize,
}

#[derive(Clone, Copy, PartialEq)]
enum BlockKind {
    Heading,
    Code,
    Table,
    Quote,
    Other,
}

/// Per-block render cache for the split preview. Keys bind (heading counter,
/// block source text): identical inputs always render identically (CommonMark
/// blocks are context-independent), so unchanged blocks skip re-rendering
/// between editor keystrokes. The heading counter is part of the key because
/// it feeds generated heading ids — reusing across a shifted counter would
/// keep stale ids.
#[derive(Default)]
pub struct BlockReuseMap {
    map: HashMap<u64, RawBlock>,
    /// Blocks served from the previous map by the build that created this one.
    pub reused: u32,
}

impl BlockReuseMap {
    fn lookup(&self, key: u64) -> Option<RawBlock> {
        self.map.get(&key).cloned()
    }

    fn insert(&mut self, key: u64, block: RawBlock) {
        self.map.insert(key, block);
    }
}

/// Split the document into top-level block fragments. Each fragment renders to
/// well-formed HTML on its own (CommonMark blocks are context-independent), so
/// any concatenation of fragments equals the full-document HTML. Unchanged
/// fragments are served from `prev` when provided, with every rendered block
/// recorded into `fresh` for the next round.
fn build_blocks(
    source: &str,
    prev: Option<&BlockReuseMap>,
    fresh: &mut Option<BlockReuseMap>,
) -> Vec<RawBlock> {
    let mut blocks: Vec<RawBlock> = Vec::new();
    let mut depth: usize = 0;
    let mut buffer: Vec<Event<'_>> = Vec::new();
    let mut heading_counter: usize = 0;
    let mut block_start: usize = 0;

    for (event, range) in Parser::new_ext(source, md_options()).into_offset_iter() {
        match &event {
            Event::Start(_) => {
                if depth == 0 {
                    buffer.clear();
                    block_start = range.start;
                }
                depth += 1;
                buffer.push(event);
            }
            Event::End(_) => {
                if depth > 0 {
                    buffer.push(event);
                    depth -= 1;
                    if depth == 0 {
                        blocks.push(make_block(
                            source,
                            std::mem::take(&mut buffer),
                            block_start,
                            range.end,
                            &mut heading_counter,
                            prev,
                            fresh,
                        ));
                    }
                } else {
                    // Standalone End at top level (defensive): own fragment.
                    blocks.push(make_block(
                        source,
                        vec![event],
                        range.start,
                        range.end,
                        &mut heading_counter,
                        prev,
                        fresh,
                    ));
                }
            }
            other => {
                if depth == 0 {
                    // Standalone inline/HTML event between blocks: own fragment.
                    blocks.push(make_block(
                        source,
                        vec![other.clone()],
                        range.start,
                        range.end,
                        &mut heading_counter,
                        prev,
                        fresh,
                    ));
                } else {
                    buffer.push(event);
                }
            }
        }
    }
    if !buffer.is_empty() {
        blocks.push(make_block(
            source,
            std::mem::take(&mut buffer),
            block_start,
            source.len(),
            &mut heading_counter,
            prev,
            fresh,
        ));
    }
    blocks
}

/// Render (or reuse) one top-level block and stamp its source range on it.
#[allow(clippy::too_many_arguments)]
fn make_block(
    source: &str,
    events: Vec<Event<'_>>,
    start: usize,
    end: usize,
    heading_counter: &mut usize,
    prev: Option<&BlockReuseMap>,
    fresh: &mut Option<BlockReuseMap>,
) -> RawBlock {
    let end = end.min(source.len());
    let key = {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        (*heading_counter).hash(&mut h);
        source.get(start..end).unwrap_or("").hash(&mut h);
        h.finish()
    };
    if let Some(mut hit) = prev.and_then(|m| m.lookup(key)) {
        // Reused renders skip finish_block, so the heading counter must be
        // advanced manually to keep subsequent keys (and heading ids) aligned.
        if let Some((_, _, _, idx)) = hit.heading {
            *heading_counter = idx as usize + 1;
        }
        hit.src_start = start;
        hit.src_end = end;
        if let Some(f) = fresh.as_mut() {
            f.reused += 1;
            // Re-serve the hit into the fresh map too — prev only covers the
            // previous round, the fresh map must stay complete for the next.
            f.insert(key, hit.clone());
        }
        return hit;
    }
    let mut block = finish_block(events, heading_counter);
    block.src_start = start;
    block.src_end = end;
    if let Some(f) = fresh.as_mut() {
        f.insert(key, block.clone());
    }
    block
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
    html::push_html(&mut html, highlight_code_events(events).into_iter());
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

    RawBlock {
        html,
        tags,
        mermaid,
        kind,
        heading,
        src_start: 0,
        src_end: 0,
    }
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

/// Insert `data-bi="N"` into the first opening tag of a rendered block.
/// Blocks whose HTML does not begin with an opening tag (defensive
/// fragments such as stray closing tags) get no anchor.
fn inject_data_bi(html: &mut String, bi: u32) {
    let b = html.as_bytes();
    if b.len() < 3 || b[0] != b'<' || !b[1].is_ascii_alphabetic() {
        return;
    }
    let mut i = 1;
    while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'-') {
        i += 1;
    }
    html.insert_str(i, &format!(" data-bi=\"{bi}\""));
}

/// Convert each block's byte range to a 1-based source line range with a
/// single monotonic pass (blocks are disjoint and ordered).
fn source_line_ranges(source: &str, blocks: &[RawBlock]) -> Vec<(u32, u32)> {
    let bytes = source.as_bytes();
    let mut out = Vec::with_capacity(blocks.len());
    let mut pos = 0usize;
    let mut line = 1u32;
    for b in blocks {
        let start = b.src_start.min(bytes.len());
        let end = b.src_end.min(bytes.len());
        while pos < start {
            if bytes[pos] == b'\n' {
                line += 1;
            }
            pos += 1;
        }
        let start_line = line;
        while pos < end {
            if bytes[pos] == b'\n' {
                line += 1;
            }
            pos += 1;
        }
        let ends_with_nl = end > start && bytes[end - 1] == b'\n';
        let end_line = if end > start { line - ends_with_nl as u32 } else { start_line };
        out.push((start_line, end_line.max(start_line)));
    }
    out
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

    fn push_block(&mut self, html: String, tags: u32, est: u32, mermaid: bool) {
        self.est += est;
        self.tags += tags;
        self.mermaid = self.mermaid || mermaid;
        self.html.push_str(&html);
    }

    /// Close the current chunk: bind every outline item and block entry added
    /// since the last flush to this chunk index. Outline and block tables
    /// advance independently (only headings enter the outline).
    fn flush(
        &mut self,
        chunks: &mut Vec<Chunk>,
        outline: &mut [ChunkOutlineItem],
        blocks: &mut [BlockInfo],
        outline_assigned: &mut usize,
        blocks_assigned: &mut usize,
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
        for item in &mut outline[*outline_assigned..] {
            item.chunk = chunk_index;
        }
        *outline_assigned = outline.len();
        for item in &mut blocks[*blocks_assigned..] {
            item.chunk = chunk_index;
        }
        *blocks_assigned = blocks.len();
        self.tags = 0;
        self.est = 0;
        self.mermaid = false;
        self.first_heading = None;
        self.last_heading = None;
    }
}

/// Shared build pipeline: split into blocks, convert source ranges to lines,
/// inject `data-bi` anchors, then pack into chunks.
fn assemble(source: &str, prev: Option<&BlockReuseMap>, collect_reuse: bool) -> CachedDoc {
    let mut fresh = if collect_reuse { Some(BlockReuseMap::default()) } else { None };
    let raw_blocks = build_blocks(source, prev, &mut fresh);
    let lines = source_line_ranges(source, &raw_blocks);

    let mut chunks: Vec<Chunk> = Vec::new();
    let mut outline: Vec<ChunkOutlineItem> = Vec::new();
    let mut block_infos: Vec<BlockInfo> = Vec::with_capacity(raw_blocks.len());
    let mut outline_assigned: usize = 0; // outline entries already bound to a flushed chunk
    let mut blocks_assigned: usize = 0; // block entries already bound to a flushed chunk
    let mut acc = ChunkAcc::new();

    for (bi, block) in raw_blocks.into_iter().enumerate() {
        if acc.is_full() {
            acc.flush(
                &mut chunks,
                &mut outline,
                &mut block_infos,
                &mut outline_assigned,
                &mut blocks_assigned,
            );
        }
        let bi = bi as u32;
        let (start_line, end_line) = lines[bi as usize];
        if let Some((level, text, id, idx)) = &block.heading {
            outline.push(ChunkOutlineItem {
                level: *level,
                text: text.clone(),
                id: id.clone(),
                chunk: 0,
                bi,
            });
            if acc.first_heading.is_none() {
                acc.first_heading = Some(*idx);
            }
            acc.last_heading = Some(*idx);
        }
        block_infos.push(BlockInfo {
            bi,
            chunk: 0,
            start_line,
            end_line,
            heading_id: block.heading.as_ref().map(|(_, _, id, _)| id.clone()),
        });
        let est = est_height(block.kind, block.html.len(), block.mermaid);
        let mut html = block.html;
        inject_data_bi(&mut html, bi);
        acc.push_block(html, block.tags, est, block.mermaid);
    }
    acc.flush(
        &mut chunks,
        &mut outline,
        &mut block_infos,
        &mut outline_assigned,
        &mut blocks_assigned,
    );

    for chunk in &mut chunks {
        chunk.info.html_bytes = chunk.html.len() as u32;
    }

    CachedDoc {
        path: String::new(),
        source: source.to_string(),
        chunks,
        outline,
        blocks: block_infos,
        reuse: fresh,
    }
}

/// Build the chunk index for a large document. Chunk boundaries always fall
/// between top-level blocks; budgets target ~32KB of HTML or ~1500 tags,
/// whichever hits first (a single oversized block becomes its own chunk).
pub fn build(source: &str) -> CachedDoc {
    assemble(source, None, false)
}

/// Like [`build`], but unchanged blocks are served from `prev` and the
/// returned doc carries a fresh reuse map for the next preview update.
pub fn build_reusable(source: &str, prev: Option<&BlockReuseMap>) -> CachedDoc {
    assemble(source, prev, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::markdown::render_markdown;

    const TEMPLATE: &str = "# 章节标题\n\n这是一段中文正文,包含**加粗**、*斜体*和`行内代码`。\n\n- 列表项一\n- 列表项二\n\n| 列A | 列B |\n| --- | --- |\n| 1 | 2 |\n\n```rust\nfn main() {}\n```\n\n> 引用。\n\n";

    /// Remove the `data-bi` anchors the assembler injects so chunk output can
    /// be compared byte-for-byte against the plain full render.
    fn strip_data_bi(html: &str) -> String {
        let mut out = String::with_capacity(html.len());
        let mut rest = html;
        while let Some(pos) = rest.find(" data-bi=\"") {
            out.push_str(&rest[..pos]);
            let after = &rest[pos + " data-bi=\"".len()..];
            let end = after.find('"').expect("data-bi closing quote");
            rest = &after[end + 1..];
        }
        out.push_str(rest);
        out
    }

    fn concat_chunks(doc: &CachedDoc) -> String {
        doc.chunks.iter().map(|c| c.html.as_str()).collect()
    }

    #[test]
    fn chunk_concat_equals_full_render() {
        let source = TEMPLATE.repeat(200);
        let doc = build(&source);
        assert!(doc.chunks.len() > 3, "expected multiple chunks, got {}", doc.chunks.len());
        let joined = strip_data_bi(&concat_chunks(&doc));
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
            assert_eq!(doc.blocks[item.bi as usize].heading_id.as_deref(), Some(item.id.as_str()));
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

    #[test]
    fn data_bi_sequential_and_lines_match_template() {
        let source = TEMPLATE.repeat(3);
        let doc = build(&source);

        // data-bi anchors appear in document order, 0..block_count.
        let joined = concat_chunks(&doc);
        let mut expected = 0u32;
        let mut rest = joined.as_str();
        while let Some(pos) = rest.find(" data-bi=\"") {
            let after = &rest[pos + " data-bi=\"".len()..];
            let end = after.find('"').expect("data-bi closing quote");
            let value: u32 = after[..end].parse().expect("data-bi value");
            assert_eq!(value, expected, "data-bi must be sequential");
            expected += 1;
            rest = &after[end + 1..];
        }
        assert_eq!(expected as usize, doc.blocks.len(), "every block carries an anchor");

        // Block table: 6 top-level blocks per template repeat, one line each
        // apart from the list (5-6) and table (8-10) and code fence (12-14).
        let starts = [1, 3, 5, 8, 12, 16, 18, 20, 22, 25, 29, 33, 35, 37, 39, 42, 46, 50];
        assert_eq!(doc.blocks.len(), starts.len());
        let mut last_start = 0;
        for (i, b) in doc.blocks.iter().enumerate() {
            assert_eq!(b.bi as usize, i);
            assert_eq!(b.start_line, starts[i], "block {i} start line");
            assert!(b.end_line >= b.start_line);
            assert!(b.start_line > last_start, "start lines must be monotonic");
            last_start = b.start_line;
        }
        // chunk assignment on the block table matches the outline binding
        for item in &doc.outline {
            assert_eq!(doc.blocks[item.bi as usize].chunk, item.chunk);
        }
    }

    #[test]
    fn reuse_serves_unchanged_blocks_and_keeps_render_equal() {
        let source = TEMPLATE.repeat(50);

        let first = build_reusable(&source, None);
        assert_eq!(first.reuse.as_ref().unwrap().reused, 0);
        let block_count = first.blocks.len();

        // Same text again: every block comes from the cache, output identical.
        let second = build_reusable(&source, first.reuse.as_ref());
        assert_eq!(second.reuse.as_ref().unwrap().reused as usize, block_count);
        assert_eq!(strip_data_bi(&concat_chunks(&first)), strip_data_bi(&concat_chunks(&second)));

        // One paragraph edited: everything else is reused, output matches a
        // fresh full render of the modified source.
        let modified = source.replacen("这是一段中文正文", "这是修改后的正文内容", 1);
        let third = build_reusable(&modified, second.reuse.as_ref());
        assert_eq!(third.reuse.as_ref().unwrap().reused as usize, block_count - 1);
        assert_eq!(
            strip_data_bi(&concat_chunks(&third)),
            strip_data_bi(&concat_chunks(&build(&modified)))
        );
        // ids stay unique across the reused/fresh boundary
        let joined = concat_chunks(&third);
        assert_eq!(joined.matches("章节标题-").count(), 50);
    }
}
