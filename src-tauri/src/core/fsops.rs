//! File-tree mutation primitives behind the sidebar context menu: create,
//! rename, trash, copy/move with Explorer-style "- 副本" name uniquing.
//! Every entry path handed in by the frontend is validated to stay inside
//! the workspace root before it touches the filesystem.

use std::path::Path;
use std::path::PathBuf;

/// Filename portion of a path, as a lossy string (callers always build
/// entry paths as `dir + separator + name`, so this is always present).
pub fn entry_name(p: &Path) -> Result<String, String> {
    p.file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .ok_or_else(|| format!("无效的路径: {}", p.display()))
}

/// Validate a user-typed file/folder name as a single path component,
/// rejecting what Windows itself rejects: separators, reserved characters,
/// reserved device names, trailing dots/spaces.
pub fn validate_entry_name(name: &str) -> Result<(), String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("名称不能为空".into());
    }
    if n == "." || n == ".." {
        return Err("名称不能为 . 或 ..".into());
    }
    if let Some(c) = n
        .chars()
        .find(|c| matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
    {
        return Err(format!("名称不能包含字符 {c}"));
    }
    if n.ends_with('.') || n.ends_with(' ') {
        return Err("名称不能以点或空格结尾".into());
    }
    let stem = n.split('.').next().unwrap_or("").to_ascii_uppercase();
    if matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL"
            | "COM1" | "COM2" | "COM3" | "COM4" | "COM5"
            | "COM6" | "COM7" | "COM8" | "COM9"
            | "LPT1" | "LPT2" | "LPT3" | "LPT4" | "LPT5"
            | "LPT6" | "LPT7" | "LPT8" | "LPT9"
    ) {
        return Err(format!("{stem} 是 Windows 保留设备名"));
    }
    Ok(())
}

/// Lexical containment: `p` must equal `root` or live under it. Paths come
/// from the frontend as string joins of the root, so no canonicalization is
/// needed (and the targets may not exist yet anyway).
pub fn ensure_inside(root: &Path, p: &Path) -> Result<(), String> {
    if p.starts_with(root) {
        Ok(())
    } else {
        Err(format!("路径越出工作区: {}", p.display()))
    }
}

/// First free path for `target`: if taken, insert " - 副本" (then
/// " - 副本 (2)", "(3)", …) before the extension, Explorer-style.
pub fn unique_path(target: &Path) -> PathBuf {
    if !target.exists() {
        return target.to_path_buf();
    }
    let dir = target.parent().unwrap_or(Path::new("."));
    let name = target
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let (stem, ext) = match name.rsplit_once('.') {
        // "doc.md" → ("doc", ".md"); dotfiles like ".md" keep the whole name.
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name, String::new()),
    };
    let mut n: u32 = 1;
    loop {
        let suffix = if n == 1 {
            " - 副本".to_string()
        } else {
            format!(" - 副本 ({n})")
        };
        let cand = dir.join(format!("{stem}{suffix}{ext}"));
        if !cand.exists() {
            return cand;
        }
        n += 1;
    }
}

/// First free path for `target` using a numeric suffix: if taken, insert
/// "_1", "_2", … before the extension (asset names already carry a
/// timestamp, so this only fires on same-second collisions).
pub fn unique_numeric_path(target: &Path) -> PathBuf {
    if !target.exists() {
        return target.to_path_buf();
    }
    let dir = target.parent().unwrap_or(Path::new("."));
    let name = target
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name, String::new()),
    };
    let mut n: u32 = 1;
    loop {
        let cand = dir.join(format!("{stem}_{n}{ext}"));
        if !cand.exists() {
            return cand;
        }
        n += 1;
    }
}

/// Archive pasted resource bytes under `dest_dir` (created on demand) using
/// `base_name`; returns the final path (uniquified on collision).
pub fn write_asset(
    root: &Path,
    dest_dir: &Path,
    base_name: &str,
    bytes: &[u8],
) -> Result<PathBuf, String> {
    ensure_inside(root, dest_dir)?;
    validate_entry_name(base_name)?;
    std::fs::create_dir_all(dest_dir)
        .map_err(|e| format!("创建资源目录失败 {}: {e}", dest_dir.display()))?;
    let target = unique_numeric_path(&dest_dir.join(base_name));
    std::fs::write(&target, bytes).map_err(|e| format!("写入资源失败: {e}"))?;
    Ok(target)
}

/// Archive an existing file into `dest_dir` (read + write_asset, so sources
/// may live anywhere readable, not only inside the workspace).
pub fn import_asset(
    root: &Path,
    src: &Path,
    dest_dir: &Path,
    base_name: &str,
) -> Result<PathBuf, String> {
    if !src.is_file() {
        return Err(format!("资源不存在: {}", src.display()));
    }
    let bytes = std::fs::read(src).map_err(|e| format!("读取资源失败 {}: {e}", src.display()))?;
    write_asset(root, dest_dir, base_name, &bytes)
}

/// Recursively copy a directory tree (files, subdirectories).
pub fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("创建目录失败 {}: {e}", dst.display()))?;
    for entry in
        std::fs::read_dir(src).map_err(|e| format!("读取目录失败 {}: {e}", src.display()))?
    {
        let entry = entry.map_err(|e| e.to_string())?;
        let to = dst.join(entry.file_name());
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            copy_dir_all(&entry.path(), &to)?;
        } else {
            std::fs::copy(entry.path(), &to)
                .map_err(|e| format!("复制失败 {}: {e}", entry.path().display()))?;
        }
    }
    Ok(())
}

/// Returns true when something was actually copied (paste-into-same-dir is
/// a silent no-op).
fn copy_one(root: &Path, src: &Path, dest_dir: &Path) -> Result<bool, String> {
    ensure_inside(root, src)?;
    validate_entry_name(&entry_name(src)?)?;
    if src == dest_dir {
        return Ok(false);
    }
    // Pasting a folder into its own subtree would recurse forever.
    if src.is_dir() && dest_dir.starts_with(src) {
        return Err("不能把文件夹粘贴到它自身内部".into());
    }
    let target = unique_path(&dest_dir.join(entry_name(src)?));
    if src.is_dir() {
        copy_dir_all(src, &target)?;
    } else {
        std::fs::copy(src, &target)
            .map_err(|e| format!("复制失败 {}: {e}", src.display()))?;
    }
    Ok(true)
}

/// Returns true when something was actually moved (same-dir move is a
/// silent no-op).
fn move_one(root: &Path, src: &Path, dest_dir: &Path) -> Result<bool, String> {
    ensure_inside(root, src)?;
    validate_entry_name(&entry_name(src)?)?;
    if src == dest_dir || src.parent() == Some(dest_dir) {
        return Ok(false);
    }
    if src.is_dir() && dest_dir.starts_with(src) {
        return Err("不能把文件夹移动到它自身内部".into());
    }
    let target = unique_path(&dest_dir.join(entry_name(src)?));
    std::fs::rename(src, &target).map_err(|e| format!("移动失败 {}: {e}", src.display()))?;
    Ok(true)
}

/// Copy each entry into `dest_dir` under a non-conflicting name.
/// Returns how many entries were actually copied.
pub fn copy_entries(root: &Path, paths: &[String], dest_dir: &Path) -> Result<u32, String> {
    ensure_inside(root, dest_dir)?;
    if !dest_dir.is_dir() {
        return Err(format!("目标不是文件夹: {}", dest_dir.display()));
    }
    let mut count = 0u32;
    for p in paths {
        let src = PathBuf::from(p);
        if copy_one(root, &src, dest_dir)? {
            count += 1;
        }
    }
    Ok(count)
}

/// Move each entry into `dest_dir` (rename within the workspace volume).
/// Entries already living in `dest_dir` are skipped. Returns how many
/// entries were actually moved.
pub fn move_entries(root: &Path, paths: &[String], dest_dir: &Path) -> Result<u32, String> {
    ensure_inside(root, dest_dir)?;
    if !dest_dir.is_dir() {
        return Err(format!("目标不是文件夹: {}", dest_dir.display()));
    }
    let mut count = 0u32;
    for p in paths {
        let src = PathBuf::from(p);
        if move_one(root, &src, dest_dir)? {
            count += 1;
        }
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ruakdown-fsops-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn entry_name_rejects_bad_input() {
        assert!(validate_entry_name("笔记.md").is_ok());
        assert!(validate_entry_name("  a b  ").is_ok());
        assert!(validate_entry_name("").is_err());
        assert!(validate_entry_name("  ").is_err());
        assert!(validate_entry_name(".").is_err());
        assert!(validate_entry_name("..").is_err());
        assert!(validate_entry_name("a/b").is_err());
        assert!(validate_entry_name("a\\b").is_err());
        assert!(validate_entry_name("a:b").is_err());
        assert!(validate_entry_name("a*b?").is_err());
        assert!(validate_entry_name("a<b>|\"").is_err());
        assert!(validate_entry_name("doc.").is_err());
        assert!(validate_entry_name("doc ").is_ok()); // trimmed above
        assert!(validate_entry_name("CON").is_err());
        assert!(validate_entry_name("com1.txt").is_err());
        assert!(validate_entry_name("lpt9").is_err());
        assert!(validate_entry_name("console.md").is_ok());
    }

    #[test]
    fn inside_root_guard() {
        let root = Path::new("F:\\vault");
        assert!(ensure_inside(root, Path::new("F:\\vault")).is_ok());
        assert!(ensure_inside(root, Path::new("F:\\vault\\a.md")).is_ok());
        assert!(ensure_inside(root, Path::new("F:\\vault\\sub\\a.md")).is_ok());
        assert!(ensure_inside(root, Path::new("F:\\vault2\\a.md")).is_err());
        assert!(ensure_inside(root, Path::new("C:\\a.md")).is_err());
    }

    #[test]
    fn unique_path_appends_fuben() {
        let dir = temp_dir("unique");
        let a = dir.join("doc.md");
        fs::write(&a, "x").unwrap();
        assert_eq!(unique_path(&a), dir.join("doc - 副本.md"));
        fs::write(dir.join("doc - 副本.md"), "x").unwrap();
        assert_eq!(unique_path(&a), dir.join("doc - 副本 (2).md"));
        fs::write(dir.join("doc - 副本 (2).md"), "x").unwrap();
        assert_eq!(unique_path(&a), dir.join("doc - 副本 (3).md"));

        // No extension / multiple dots / dotfile.
        let b = dir.join("notes");
        fs::write(&b, "x").unwrap();
        assert_eq!(unique_path(&b), dir.join("notes - 副本"));
        let c = dir.join("a.b.md");
        fs::write(&c, "x").unwrap();
        assert_eq!(unique_path(&c), dir.join("a.b - 副本.md"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unique_numeric_path_appends_index() {
        let dir = temp_dir("unique-num");
        let a = dir.join("doc_20260504120000.jpg");
        fs::write(&a, b"x").unwrap();
        assert_eq!(unique_numeric_path(&a), dir.join("doc_20260504120000_1.jpg"));
        fs::write(dir.join("doc_20260504120000_1.jpg"), b"x").unwrap();
        assert_eq!(unique_numeric_path(&a), dir.join("doc_20260504120000_2.jpg"));
        // Fresh name is returned untouched.
        assert_eq!(unique_numeric_path(&dir.join("other.png")), dir.join("other.png"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_and_import_asset() {
        let root = temp_dir("asset");
        let dest = root.join("assets");

        // Creates the destination directory on demand.
        let out = write_asset(&root, &dest, "a_20260504120000.png", b"PNG").unwrap();
        assert_eq!(out, dest.join("a_20260504120000.png"));
        assert_eq!(fs::read(&out).unwrap(), b"PNG");

        // Same-second collision gets a numeric suffix.
        let out2 = write_asset(&root, &dest, "a_20260504120000.png", b"PNG2").unwrap();
        assert_eq!(out2, dest.join("a_20260504120000_1.png"));
        assert_eq!(fs::read(&out2).unwrap(), b"PNG2");

        // import_asset copies an existing file (any readable source).
        let src = root.join("src.md");
        fs::write(&src, b"# hi").unwrap();
        let out3 = import_asset(&root, &src, &dest, "b_20260504120000.md").unwrap();
        assert_eq!(fs::read_to_string(&out3).unwrap(), "# hi");

        // Out-of-root destination and bad names are rejected.
        assert!(write_asset(&root, Path::new("C:\\evil"), "x.png", b"").is_err());
        assert!(write_asset(&root, &dest, "a/b.png", b"").is_err());
        assert!(import_asset(&root, Path::new("F:\\missing.png"), &dest, "x.png").is_err());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn copy_and_move_entries_roundtrip() {
        let root = temp_dir("roundtrip");
        let sub = root.join("sub");
        fs::create_dir_all(&sub).unwrap();
        fs::write(root.join("a.md"), "A").unwrap();
        fs::write(sub.join("b.md"), "B").unwrap();

        // Copy a file: lands under the "- 副本" name.
        let n = copy_entries(&root, &[root.join("a.md").to_string_lossy().into_owned()], &root)
            .unwrap();
        assert_eq!(n, 1);
        assert_eq!(fs::read_to_string(root.join("a - 副本.md")).unwrap(), "A");

        // Copy a directory recursively.
        let n = copy_entries(&root, &[sub.to_string_lossy().into_owned()], &root).unwrap();
        assert_eq!(n, 1);
        assert_eq!(fs::read_to_string(root.join("sub - 副本").join("b.md")).unwrap(), "B");

        // Move the copy into sub.
        let n = move_entries(
            &root,
            &[root.join("a - 副本.md").to_string_lossy().into_owned()],
            &sub,
        )
        .unwrap();
        assert_eq!(n, 1);
        assert_eq!(fs::read_to_string(sub.join("a - 副本.md")).unwrap(), "A");

        // Moving into the same directory is a no-op.
        let n = move_entries(&root, &[sub.join("b.md").to_string_lossy().into_owned()], &sub)
            .unwrap();
        assert_eq!(n, 0);

        // Out-of-root and dir-into-self are rejected.
        assert!(copy_entries(&root, &["C:\\elsewhere.md".into()], &root).is_err());
        assert!(copy_entries(&root, &[sub.to_string_lossy().into_owned()], &sub.join("x")).is_err());

        let _ = fs::remove_dir_all(&root);
    }
}
