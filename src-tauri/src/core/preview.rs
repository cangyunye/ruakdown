use crate::core::large_doc::{self, BlockInfo, ChunkInfo, ChunkOutlineItem};
use crate::core::markdown::rewrite_img_srcs;
use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::Path;

/// Meta returned once per preview rebuild; chunk HTML is fetched on demand
/// via `preview_chunks` keyed by `rev`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewMeta {
    pub rev: u64,
    pub chunk_count: u32,
    pub chunks: Vec<ChunkInfo>,
    pub blocks: Vec<BlockInfo>,
    pub outline: Vec<ChunkOutlineItem>,
}

/// Single-slot cache of the live editor buffer's rendered preview. The split
/// view only ever previews the document being edited, so holding the latest
/// build (plus its per-block reuse map) is enough; identical text
/// short-circuits to a meta re-serve with no re-render at all.
#[derive(Default)]
pub struct PreviewStore {
    rev: u64,
    text_hash: u64,
    base_file: String,
    doc: Option<large_doc::CachedDoc>,
}

impl PreviewStore {
    /// Rebuild (or reuse) the preview index for the editor buffer. `base_file`
    /// is the document path, kept for relative-image rewriting at chunk fetch
    /// time.
    pub fn update(&mut self, text: &str, base_file: &str) -> PreviewMeta {
        let hash = text_hash(text);
        if self.doc.is_some() && hash == self.text_hash && base_file == self.base_file {
            return self.meta();
        }
        let prev = self.doc.as_ref().and_then(|d| d.reuse.as_ref());
        let doc = large_doc::build_reusable(text, prev);
        self.rev = self.rev.wrapping_add(1);
        self.text_hash = hash;
        self.base_file = base_file.to_string();
        self.doc = Some(doc);
        self.meta()
    }

    /// Chunk HTML for a given revision. Stale revisions are rejected so the
    /// frontend can drop responses that lost the latest-wins race.
    pub fn chunks(&self, rev: u64, start: u32, count: u32) -> Result<Vec<(u32, String)>, String> {
        let doc = self.doc.as_ref().ok_or("预览尚未构建")?;
        if rev != self.rev {
            return Err("预览已过期".to_string());
        }
        let base_dir = Path::new(&self.base_file).parent();
        let end = (start as usize + count as usize).min(doc.chunks.len());
        let begin = (start as usize).min(doc.chunks.len());
        Ok(doc.chunks[begin..end]
            .iter()
            .enumerate()
            .map(|(i, c)| ((begin + i) as u32, rewrite_img_srcs(&c.html, base_dir)))
            .collect())
    }

    fn meta(&self) -> PreviewMeta {
        let doc = self.doc.as_ref().expect("meta without doc");
        PreviewMeta {
            rev: self.rev,
            chunk_count: doc.chunks.len() as u32,
            chunks: doc.chunks.iter().map(|c| c.info.clone()).collect(),
            blocks: doc.blocks.clone(),
            outline: doc.outline.clone(),
        }
    }
}

fn text_hash(text: &str) -> u64 {
    let mut h = DefaultHasher::new();
    text.hash(&mut h);
    h.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOC: &str = "# 标题\n\n第一段。\n\n第二段。\n\n";

    #[test]
    fn identical_text_short_circuits() {
        let mut store = PreviewStore::default();
        let first = store.update(DOC, "/tmp/a.md");
        assert_eq!(first.rev, 1);
        let second = store.update(DOC, "/tmp/a.md");
        assert_eq!(second.rev, 1, "same text must not bump the revision");
        assert_eq!(second.chunk_count, first.chunk_count);
    }

    #[test]
    fn edits_bump_revision_and_reject_stale_fetches() {
        let mut store = PreviewStore::default();
        let first = store.update(DOC, "/tmp/a.md");
        let chunks = store.chunks(first.rev, 0, 10).unwrap();
        assert_eq!(chunks.len(), first.chunk_count as usize);
        assert!(chunks.iter().all(|(i, _)| *i == 0));
        assert!(chunks[0].1.contains("data-bi=\"0\""), "chunk html carries block anchors");

        let second = store.update(&DOC.replace("第二段", "改过的第二段"), "/tmp/a.md");
        assert_eq!(second.rev, 2);
        assert!(store.chunks(first.rev, 0, 10).is_err(), "stale rev must be rejected");
    }

    #[test]
    fn empty_text_builds_empty_index() {
        let mut store = PreviewStore::default();
        let meta = store.update("", "/tmp/a.md");
        assert_eq!(meta.chunk_count, 0);
        assert_eq!(meta.blocks.len(), 0);
        assert_eq!(store.chunks(meta.rev, 0, 1).unwrap().len(), 0);
    }
}
