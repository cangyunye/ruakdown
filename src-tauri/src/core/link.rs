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
/// (percent-encoded, the `file:///C:/…` drive form and `file://localhost/…`),
/// absolute paths, and `.`/`..` segments.
///
/// A rooted link with neither drive letter nor UNC host (`/docs/x.md`) is
/// probed as a filesystem path first; when that misses it is retried under
/// `root` and then the document directory — authors writing such links mean
/// the workspace, and on Windows the literal reading would be the current
/// drive's root. `root` otherwise only feeds the informational `in_root`.
pub fn resolve(
    base_file: &std::path::Path,
    link: &str,
    root: Option<&std::path::Path>,
) -> ResolvedLink {
    let decoded = strip_file_scheme(link);
    let trimmed = strip_slash_before_drive(decoded.trim());
    let dir = doc_dir(base_file);
    let primary = if is_absoluteish(trimmed) {
        std::path::PathBuf::from(trimmed)
    } else {
        dir.join(trimmed)
    };
    let mut resolved = finish(&primary);
    let mut exists = resolved.is_file();
    if !exists && is_rooted_without_prefix(trimmed) {
        let rel = trimmed.trim_start_matches(['/', '\\']);
        let hit = root
            .map(|r| r.join(rel))
            .into_iter()
            .chain(std::iter::once(dir.join(rel)))
            .map(|c| finish(&c))
            .find(|c| c.is_file());
        if let Some(hit) = hit {
            resolved = hit;
            exists = true;
        }
    }
    ResolvedLink {
        path: resolved.to_string_lossy().into_owned(),
        exists,
        in_root: root
            .map(|r| starts_with_path(&resolved, r))
            .unwrap_or(false),
        is_markdown: is_markdown_path(&resolved),
    }
}

fn doc_dir(base_file: &std::path::Path) -> &std::path::Path {
    base_file
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| std::path::Path::new("/"))
}

/// Lexical normalization plus `\\?\` prefix removal: the path that gets
/// probed and reported.
fn finish(path: &std::path::Path) -> std::path::PathBuf {
    dunce::simplified(&normalize(path)).to_path_buf()
}

fn is_markdown_path(path: &std::path::Path) -> bool {
    matches!(
        path.extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .as_deref(),
        Some("md" | "markdown")
    )
}

/// Strip a `file://` prefix (and an RFC 8089 `localhost` host, which means
/// the same as no host) and percent-decode the remainder.
fn strip_file_scheme(link: &str) -> String {
    // `get` instead of byte slicing: a CJK link like "./子目录/a.md" has its
    // 7th byte inside a multi-byte char, and `link[..7]` would panic.
    // A non-boundary index can never be an ASCII "file://" prefix anyway.
    let stripped = match link.get(..7) {
        Some(prefix) if prefix.eq_ignore_ascii_case("file://") => {
            let rest = &link[7..];
            match rest.get(..9) {
                Some(host)
                    if host.eq_ignore_ascii_case("localhost")
                        && rest[9..].starts_with(['/', '\\']) =>
                {
                    &rest[9..]
                }
                _ => rest,
            }
        }
        _ => link,
    };
    percent_encoding::percent_decode_str(stripped)
        .decode_utf8_lossy()
        .into_owned()
}

/// `/C:/x` — what `file:///C:/x` leaves behind once the scheme is gone — is
/// a drive path, not a rooted path containing a `C:` directory. Without this
/// the Windows path parser lands it at `\C:\x` on the current drive.
fn strip_slash_before_drive(s: &str) -> &str {
    let b = s.as_bytes();
    let drive_follows = matches!(b.first(), Some(b'/' | b'\\'))
        && b.get(1).is_some_and(|c| c.is_ascii_alphabetic())
        && b.get(2) == Some(&b':')
        && matches!(b.get(3), None | Some(b'/' | b'\\'));
    if drive_follows {
        &s[1..]
    } else {
        s
    }
}

fn is_absoluteish(s: &str) -> bool {
    if s.starts_with('/') || s.starts_with('\\') {
        return true;
    }
    // Windows drive letter, e.g. "C:/..." or "C:\...".
    let b = s.as_bytes();
    b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic()
}

/// `/docs/x` or `\docs\x`: rooted, but with neither a drive letter nor a
/// UNC host — the one absolute-looking form whose root is ambiguous.
fn is_rooted_without_prefix(s: &str) -> bool {
    let b = s.as_bytes();
    matches!(b.first(), Some(b'/' | b'\\')) && !matches!(b.get(1), Some(b'/' | b'\\'))
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

    /// Regression: a relative CJK link whose 7th byte falls inside a
    /// multi-byte char ("./子目录/…" → byte 7 is inside 目) used to panic in
    /// strip_file_scheme's byte slicing. Windows-crash found by E2E 2026-10-25.
    #[test]
    fn cjk_link_at_file_scheme_length_does_not_panic() {
        let root = temp_dir("cjk");
        let doc = root.join("a.md");
        let target = root.join("子目录/嵌套文档.md");
        write(&doc);
        write(&target);
        let r = resolve(&doc, "./子目录/嵌套文档.md", Some(&root));
        assert_eq!(norm(&r.path), norm(target.to_string_lossy().as_ref()));
        assert!(r.exists);
        assert!(r.is_markdown);
        // file:// URLs around CJK must still strip and decode.
        let r2 = resolve(
            &doc,
            &format!("file://{}", target.to_string_lossy()),
            Some(&root),
        );
        assert_eq!(norm(&r2.path), norm(target.to_string_lossy().as_ref()));
        assert!(r2.exists);
    }

    /// Body of a `file:` URL for an on-disk path: `/tmp/x` → `tmp/x`,
    /// `C:\tmp\x` → `C:/tmp/x`; callers prepend `file:///` or
    /// `file://localhost/`, which yields the three-slash form browsers,
    /// Explorer and most editors hand out.
    fn url_body(path: &std::path::Path) -> String {
        path.to_string_lossy()
            .replace('\\', "/")
            .trim_start_matches('/')
            .to_string()
    }

    /// Regression: `file:///C:/…` stripped to `/C:/…` was parsed as a rooted
    /// path with a `C:` directory and probed at `\C:\…` on the current
    /// drive — "链接目标不存在" for every absolute file URL on Windows.
    #[test]
    fn three_slash_and_localhost_file_urls_resolve() {
        let root = temp_dir("fileurl");
        let doc = root.join("a.md");
        let target = root.join("sub/b.md");
        write(&doc);
        write(&target);
        let want = norm(target.to_string_lossy().as_ref());
        let r = resolve(&doc, &format!("file:///{}", url_body(&target)), Some(&root));
        assert_eq!(norm(&r.path), want);
        assert!(r.exists);
        assert!(r.in_root);
        let r2 = resolve(
            &doc,
            &format!("file://localhost/{}", url_body(&target)),
            Some(&root),
        );
        assert_eq!(norm(&r2.path), want);
        assert!(r2.exists);
    }

    /// Lexical shape only, so it runs everywhere: a drive letter behind a
    /// leading separator must come out first, never as `/C:` or `\C:`. A
    /// rooted path without a drive keeps its root.
    #[test]
    fn leading_slash_before_drive_letter_is_dropped() {
        let doc = std::path::Path::new("/anywhere/a.md");
        for link in [
            "/C:/Users/me/b.md",
            "file:///C:/Users/me/b.md",
            "\\C:\\Users\\me\\b.md",
            "/c:/x.md",
        ] {
            let r = resolve(doc, link, None);
            assert!(
                r.path.starts_with("C:") || r.path.starts_with("c:"),
                "{link} -> {}",
                r.path
            );
        }
        let r = resolve(doc, "/docs/b.md", None);
        assert!(r.path.starts_with(['/', '\\']), "{}", r.path);
        // `/Cx` or `/C:foo` are not drive paths.
        assert!(resolve(doc, "/Cx/b.md", None).path.starts_with(['/', '\\']));
        assert!(resolve(doc, "/C:foo/b.md", None).path.starts_with(['/', '\\']));
    }

    /// `/docs/x.md` means "under the workspace" to the people who write it;
    /// the filesystem-root reading (current-drive root on Windows) is tried
    /// first and the workspace, then the document directory, catch the miss.
    #[test]
    fn rooted_link_falls_back_to_workspace_root_then_doc_dir() {
        let root = temp_dir("rooted");
        let doc = root.join("docs/sub/a.md");
        let in_root = root.join("docs/rooted-b.md");
        let beside = root.join("docs/sub/rooted-c.md");
        write(&doc);
        write(&in_root);
        write(&beside);
        let r = resolve(&doc, "/docs/rooted-b.md", Some(&root));
        assert!(r.exists, "{}", r.path);
        assert_eq!(norm(&r.path), norm(in_root.to_string_lossy().as_ref()));
        assert!(r.in_root);
        assert!(r.is_markdown);
        // No workspace open: the document directory is the fallback.
        let r2 = resolve(&doc, "/rooted-c.md", None);
        assert!(r2.exists, "{}", r2.path);
        assert_eq!(norm(&r2.path), norm(beside.to_string_lossy().as_ref()));
        // Nothing matches anywhere: report the literal rooted reading.
        let r3 = resolve(&doc, "/nowhere/rooted-ghost.md", Some(&root));
        assert!(!r3.exists);
        assert!(r3.path.starts_with(['/', '\\']), "{}", r3.path);
        if cfg!(windows) {
            let r4 = resolve(&doc, "\\docs\\rooted-b.md", Some(&root));
            assert!(r4.exists, "{}", r4.path);
        }
    }
}
