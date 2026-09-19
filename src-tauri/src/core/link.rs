use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedLink {
    pub path: String,
    pub exists: bool,
    pub in_root: bool,
    pub is_markdown: bool,
}

/// Resolve a markdown link target against the document's own directory,
/// mirroring how browsers resolve relative hrefs. Handles `file://` URLs
/// (with percent-encoding), absolute paths, and `.`/`..` segments.
/// `root` only feeds the informational `in_root` flag.
pub fn resolve(
    base_file: &std::path::Path,
    link: &str,
    root: Option<&std::path::Path>,
) -> ResolvedLink {
    let decoded = strip_file_scheme(link);
    let trimmed = decoded.trim();
    let joined = if is_absoluteish(trimmed) {
        std::path::PathBuf::from(trimmed)
    } else {
        let base = base_file
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| std::path::Path::new("/"));
        base.join(trimmed)
    };
    let normalized = normalize(&joined);
    let simplified = dunce::simplified(&normalized);
    let exists = simplified.is_file();
    ResolvedLink {
        path: simplified.to_string_lossy().into_owned(),
        exists,
        in_root: root
            .map(|r| starts_with_path(&simplified, r))
            .unwrap_or(false),
        is_markdown: is_markdown_path(&simplified),
    }
}

fn is_markdown_path(path: &std::path::Path) -> bool {
    matches!(
        path.extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .as_deref(),
        Some("md" | "markdown")
    )
}

/// Strip a `file://` prefix and percent-decode the remainder.
fn strip_file_scheme(link: &str) -> String {
    let stripped = if link.len() >= 7 && link[..7].eq_ignore_ascii_case("file://") {
        &link[7..]
    } else {
        link
    };
    percent_encoding::percent_decode_str(stripped)
        .decode_utf8_lossy()
        .into_owned()
}

fn is_absoluteish(s: &str) -> bool {
    if s.starts_with('/') || s.starts_with('\\') {
        return true;
    }
    // Windows drive letter, e.g. "C:/..." or "C:\...".
    let b = s.as_bytes();
    b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic()
}

/// Lexical `.`/`..` normalization. `..` never escapes above the root.
fn normalize(path: &std::path::Path) -> std::path::PathBuf {
    use std::path::Component;
    let mut result = std::path::PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                if !result.pop() {
                    result.push("..");
                }
            }
            other => result.push(other.as_os_str()),
        }
    }
    result
}

/// Case-insensitive prefix check that never matches across a path-separator
/// boundary (`/root1` is not a prefix of `/root10/x`).
fn starts_with_path(path: &std::path::Path, root: &std::path::Path) -> bool {
    let p = path.to_string_lossy();
    let r = root.to_string_lossy();
    let r_trimmed = r.trim_end_matches(['/', '\\']);
    if r_trimmed.is_empty() {
        return true;
    }
    let lower_p = p.to_lowercase();
    let lower_r = r_trimmed.to_lowercase();
    let Some(rest) = lower_p.strip_prefix(&lower_r) else {
        return false;
    };
    rest.is_empty() || rest.starts_with('/') || rest.starts_with('\\')
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ruakdown-link-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &std::path::Path) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, b"test").unwrap();
    }

    /// Path-separator-agnostic comparison: `PathBuf::join` keeps `/` inside
    /// pushed components on Windows while resolve() normalizes to `\`.
    fn norm(path: &str) -> String {
        path.replace('\\', "/")
    }

    #[test]
    fn relative_link_resolves_against_document_dir() {
        let root = temp_dir("rel");
        let doc = root.join("docs/a.md");
        let target = root.join("docs/b.md");
        write(&doc);
        write(&target);
        let r = resolve(&doc, "b.md", Some(&root));
        assert_eq!(norm(&r.path), norm(target.to_string_lossy().as_ref()));
        assert!(r.exists);
        assert!(r.in_root);
        assert!(r.is_markdown);
    }

    #[test]
    fn parent_traversal_and_dot_segments_normalize() {
        let root = temp_dir("dotdot");
        let doc = root.join("docs/sub/a.md");
        // base = docs/sub; ".." leaves sub, ".." again leaves docs.
        let target = root.join("notes/b.md");
        write(&doc);
        write(&target);
        let r = resolve(&doc, "../.././notes/./b.md", Some(&root));
        assert_eq!(norm(&r.path), norm(target.to_string_lossy().as_ref()));
        assert!(r.exists);
        // One level up from docs/sub lands inside docs/.
        let sibling = root.join("docs/notes/other.md");
        write(&sibling);
        let r2 = resolve(&doc, ".././notes/./other.md", Some(&root));
        assert_eq!(norm(&r2.path), norm(sibling.to_string_lossy().as_ref()));
        assert!(r2.exists);
    }

    #[test]
    fn absolute_link_is_used_verbatim() {
        let root = temp_dir("abs");
        let doc = root.join("a.md");
        let target = root.join("elsewhere/b.md");
        write(&doc);
        write(&target);
        let r = resolve(&doc, target.to_string_lossy().as_ref(), Some(&root));
        assert_eq!(norm(&r.path), norm(target.to_string_lossy().as_ref()));
        assert!(r.exists);
    }

    #[test]
    fn in_root_is_case_insensitive_and_boundary_safe() {
        let root = temp_dir("boundary");
        let doc = root.join("a.md");
        let inside = root.join("sub/b.txt");
        let sibling_root = root.with_file_name("boundary2");
        let outside = sibling_root.join("c.txt");
        write(&doc);
        write(&inside);
        write(&outside);
        // Case-insensitive on the root itself.
        let upper_root = root.to_string_lossy().to_uppercase();
        let r = resolve(&doc, "sub/b.txt", Some(std::path::Path::new(&upper_root)));
        assert!(r.in_root);
        // /root1 must not claim /root10/... as inside.
        let r2 = resolve(&doc, outside.to_string_lossy().as_ref(), Some(&root));
        assert!(!r2.in_root);
        // Non-markdown local file still resolves (opened via system app).
        let r3 = resolve(&doc, "sub/b.txt", Some(&root));
        assert!(r3.exists);
        assert!(!r3.is_markdown);
    }

    #[test]
    fn missing_file_reports_exists_false() {
        let root = temp_dir("missing");
        let doc = root.join("a.md");
        write(&doc);
        let r = resolve(&doc, "ghost.md", Some(&root));
        assert!(!r.exists);
        assert!(r.is_markdown);
    }

    #[test]
    fn percent_encoded_and_file_urls_decode() {
        let root = temp_dir("enc");
        let doc = root.join("a.md");
        let target = root.join("my file.md");
        write(&doc);
        write(&target);
        let r = resolve(&doc, "my%20file.md", Some(&root));
        assert_eq!(r.path, target.to_string_lossy());
        assert!(r.exists);
        let r2 = resolve(
            &doc,
            &format!("file://{}", target.to_string_lossy()),
            Some(&root),
        );
        assert_eq!(r2.path, target.to_string_lossy());
        assert!(r2.exists);
    }

    #[test]
    fn extension_detection_covers_markdown_variants() {
        let root = temp_dir("ext");
        let doc = root.join("a.md");
        let md = root.join("b.MARKDOWN");
        let txt = root.join("c.txt");
        write(&doc);
        write(&md);
        write(&txt);
        assert!(resolve(&doc, "b.MARKDOWN", Some(&root)).is_markdown);
        assert!(!resolve(&doc, "c.txt", Some(&root)).is_markdown);
    }

    #[test]
    fn traversal_above_root_stays_lexical() {
        let root = temp_dir("escape");
        let doc = root.join("a.md");
        write(&doc);
        let r = resolve(&doc, "../../../outside.md", Some(&root));
        assert!(!r.in_root);
        assert!(r.path.contains("outside.md"));
    }
}
