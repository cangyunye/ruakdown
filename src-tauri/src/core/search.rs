use serde::Serialize;
use std::path::Path;

use super::file;

/// Max kept matches per file; further hits in that file are dropped.
const MAX_HITS_PER_FILE: usize = 50;
/// Hard cap on total kept matches; `truncated` tells the UI more exist.
const MAX_TOTAL_HITS: usize = 2000;
/// Files above this size are skipped to bound memory/latency.
const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
/// Lines longer than this are clipped around the first match.
const MAX_SNIPPET_CHARS: usize = 400;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub line: u32,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileResult {
    pub path: String,
    pub name: String,
    pub name_match: bool,
    pub hits: Vec<SearchHit>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SearchOutcome {
    pub files: Vec<FileResult>,
    pub total_hits: usize,
    pub truncated: bool,
}

/// Search every markdown file under `root` for `query`, case-insensitively
/// unless `case_sensitive`. Files whose *name* matches also show up (marked
/// via `name_match`, sorted first). Content matching is line-based.
pub fn search(root: &Path, query: &str, case_sensitive: bool) -> SearchOutcome {
    let mut outcome = SearchOutcome::default();
    if query.is_empty() {
        return outcome;
    }
    let needle: String = if case_sensitive {
        query.to_string()
    } else {
        query.to_lowercase()
    };

    for path in file::collect_markdown_files(root) {
        if outcome.total_hits >= MAX_TOTAL_HITS {
            outcome.truncated = true;
            break;
        }
        if let Some(result) = search_file(&path, &needle, case_sensitive, &mut outcome) {
            outcome.files.push(result);
        }
    }
    // Name matches first, then by path for stable ordering.
    outcome
        .files
        .sort_by(|a, b| b.name_match.cmp(&a.name_match).then(a.path.cmp(&b.path)));
    outcome
}

fn search_file(
    path: &Path,
    needle: &str,
    case_sensitive: bool,
    outcome: &mut SearchOutcome,
) -> Option<FileResult> {
    let Ok(meta) = std::fs::metadata(path) else {
        return None;
    };
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
        return None;
    }
    // read_text handles UTF-8/BOM/UTF-16/GBK, so all common encodings are searchable.
    let Ok(file_text) = file::read_text(path) else {
        return None;
    };

    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let name_match = match_in(&name, needle, case_sensitive);
    let mut hits = Vec::new();

    for (idx, line) in file_text.text.lines().enumerate() {
        if hits.len() >= MAX_HITS_PER_FILE || outcome.total_hits >= MAX_TOTAL_HITS {
            if outcome.total_hits >= MAX_TOTAL_HITS {
                outcome.truncated = true;
            }
            break;
        }
        if !match_in(line, needle, case_sensitive) {
            continue;
        }
        outcome.total_hits += 1;
        hits.push(SearchHit {
            line: (idx + 1) as u32,
            text: clip_line(line, needle, case_sensitive),
        });
    }

    if hits.is_empty() && !name_match {
        return None;
    }
    Some(FileResult {
        path: path.to_string_lossy().into_owned(),
        name,
        name_match,
        hits,
    })
}

fn match_in(hay: &str, needle: &str, case_sensitive: bool) -> bool {
    if case_sensitive {
        hay.contains(needle)
    } else {
        hay.to_lowercase().contains(needle)
    }
}

/// Char index of the first match, for display-window math. Case-folding can
/// shift byte offsets, so clipping works purely in char space.
fn find_char_index(line: &str, needle: &str, case_sensitive: bool) -> Option<usize> {
    let byte_idx = if case_sensitive {
        line.find(needle)?
    } else {
        line.to_lowercase().find(needle)?
    };
    Some(line[..byte_idx].chars().count())
}

/// Keep long lines readable: clip to a window around the first match.
fn clip_line(line: &str, needle: &str, case_sensitive: bool) -> String {
    let char_count = line.chars().count();
    if char_count <= MAX_SNIPPET_CHARS {
        return line.to_string();
    }
    let Some(match_char) = find_char_index(line, needle, case_sensitive) else {
        // Name-only match or edge case: keep the head.
        let head: String = line.chars().take(MAX_SNIPPET_CHARS).collect();
        return format!("{head}…");
    };
    let start = match_char.saturating_sub(80);
    let end = (start + MAX_SNIPPET_CHARS).min(char_count);
    let snippet: String = line.chars().skip(start).take(end - start).collect();
    match (start > 0, end < char_count) {
        (true, true) => format!("…{snippet}…"),
        (true, false) => format!("…{snippet}"),
        (false, true) => format!("{snippet}…"),
        (false, false) => snippet,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_gbk(path: &Path, text: &str) {
        let bytes = encoding_rs::GBK.encode(text).0.into_owned();
        std::fs::write(path, bytes).unwrap();
    }

    #[test]
    fn case_insensitive_and_sensitive() {
        let dir = std::env::temp_dir().join(format!("ruakdown-search-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.md"), "Hello World\nвторой line\nhello again").unwrap();

        let hits = search(&dir, "hello", false);
        assert_eq!(hits.total_hits, 2);
        assert_eq!(hits.files.len(), 1);
        assert_eq!(hits.files[0].hits[0].line, 1);

        let hits = search(&dir, "hello", true);
        assert_eq!(hits.total_hits, 1);
        assert_eq!(hits.files[0].hits[0].line, 3);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cjk_and_gbk_files_are_searched() {
        let dir = std::env::temp_dir().join(format!("ruakdown-search-gbk-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        write_gbk(&dir.join("gbk.md"), "第一行 性能优化\n第二行");
        std::fs::write(dir.join("utf8.md"), "这里讲性能优化").unwrap();

        let hits = search(&dir, "性能优化", false);
        assert_eq!(hits.total_hits, 2);
        assert_eq!(hits.files.len(), 2);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn filename_matches_are_included_and_first() {
        let dir = std::env::temp_dir().join(format!("ruakdown-search-name-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let sub = dir.join("notes");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("performance.md"), "无关内容").unwrap();
        std::fs::write(dir.join("other.md"), "谈一谈 Performance").unwrap();

        let hits = search(&dir, "performance", false);
        assert_eq!(hits.files.len(), 2);
        assert!(hits.files[0].name_match);
        assert_eq!(hits.files[0].name, "performance.md");
        assert!(hits.files[0].hits.is_empty());
        assert!(!hits.files[1].name_match);
        assert_eq!(hits.total_hits, 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn skip_dirs_are_not_searched() {
        let dir = std::env::temp_dir().join(format!("ruakdown-search-skip-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let node = dir.join("node_modules");
        std::fs::create_dir_all(&node).unwrap();
        std::fs::write(node.join("dep.md"), "needle here").unwrap();

        assert_eq!(search(&dir, "needle", false).total_hits, 0);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn caps_and_truncation() {
        let dir = std::env::temp_dir().join(format!("ruakdown-search-cap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("many.md"), "hit\n".repeat(MAX_HITS_PER_FILE + 10).trim_end()).unwrap();

        let hits = search(&dir, "hit", false);
        assert!(!hits.truncated);
        assert_eq!(hits.files[0].hits.len(), MAX_HITS_PER_FILE);
        assert_eq!(hits.total_hits, MAX_HITS_PER_FILE);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn long_lines_are_clipped_around_match() {
        // Match sits far from both ends, so the clip window cuts both sides.
        let long = format!("{}性能优化{}", "x".repeat(300), "y".repeat(500));
        let clipped = clip_line(&long, "性能优化", false);
        assert!(clipped.chars().count() <= MAX_SNIPPET_CHARS + 2);
        assert!(clipped.contains("性能优化"));
        assert!(clipped.starts_with('…') && clipped.ends_with('…'));
    }
}
