use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "$RECYCLE.BIN",
    "System Volume Information",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Vec<TreeNode>,
}

/// Build the markdown workspace tree: directories first, then .md files,
/// each group case-insensitively sorted. Dot-dirs and known build dirs are skipped.
pub fn build_tree(root: &Path) -> Vec<TreeNode> {
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    collect(root, 0, &mut dirs, &mut files);
    dirs.extend(files);
    dirs
}

fn collect(dir: &Path, depth: u8, dirs: &mut Vec<TreeNode>, files: &mut Vec<TreeNode>) {
    if depth >= 16 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut sub_dirs: Vec<TreeNode> = Vec::new();
    let mut sub_files: Vec<TreeNode> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        // symlink_metadata: never follow directory symlinks (cycles on Windows junctions)
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.is_dir() {
            if name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            let mut children_dirs = Vec::new();
            let mut children_files = Vec::new();
            collect(&path, depth + 1, &mut children_dirs, &mut children_files);
            let mut children = children_dirs;
            children.extend(children_files);
            sub_dirs.push(TreeNode {
                name,
                path: path_string(&path),
                is_dir: true,
                children,
            });
        } else if meta.is_file() && is_markdown(&name) {
            sub_files.push(TreeNode {
                name,
                path: path_string(&path),
                is_dir: false,
                children: Vec::new(),
            });
        }
    }
    sub_dirs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    sub_files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    dirs.append(&mut sub_dirs);
    files.append(&mut sub_files);
}

fn is_markdown(name: &str) -> bool {
    let ext = name.rsplit_once('.').map(|(_, e)| e);
    matches!(ext, Some(e) if e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"))
}

fn path_string(path: &Path) -> String {
    dunce::simplified(path).to_string_lossy().into_owned()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileText {
    pub text: String,
    pub encoding: String,
    pub eol: String,
}

/// Read a text file, detecting encoding (UTF-8 with/without BOM, UTF-16, GBK
/// fallback) and line-ending style. Callers keep both so saves can preserve them.
pub fn read_text(path: &Path) -> std::io::Result<FileText> {
    let bytes = fs::read(path)?;
    let (text, encoding) = decode(bytes);
    let eol = detect_eol(&text);
    Ok(FileText {
        text,
        encoding: encoding.to_string(),
        eol: eol.to_string(),
    })
}

fn decode(bytes: Vec<u8>) -> (String, &'static str) {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        let (text, _, _) = encoding_rs::UTF_8.decode(&bytes[3..]);
        return (text.into_owned(), "utf-8-bom");
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (text, _, _) = encoding_rs::UTF_16LE.decode(&bytes);
        return (text.into_owned(), "utf-16le");
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (text, _, _) = encoding_rs::UTF_16BE.decode(&bytes);
        return (text.into_owned(), "utf-16be");
    }
    match std::str::from_utf8(&bytes) {
        Ok(s) => (s.to_string(), "utf-8"),
        Err(_) => {
            let (text, _, had_errors) = encoding_rs::GBK.decode(&bytes);
            (
                text.into_owned(),
                if had_errors { "gbk-lossy" } else { "gbk" },
            )
        }
    }
}

pub fn detect_eol(text: &str) -> &'static str {
    if text.contains("\r\n") {
        "crlf"
    } else if text.contains('\r') {
        "cr"
    } else {
        "lf"
    }
}

/// Write text back preserving the file's original encoding and line-ending
/// style. Normalizes all newlines to LF first, then re-applies the target EOL.
/// Writes to `<path>.tmp` and renames, so a crash mid-write never truncates
/// the original file. Returns the number of bytes written.
pub fn write_text(path: &Path, text: &str, encoding: &str, eol: &str) -> std::io::Result<usize> {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let with_eol = match eol {
        "crlf" => normalized.replace('\n', "\r\n"),
        "cr" => normalized.replace('\n', "\r"),
        _ => normalized,
    };
    let bytes: Vec<u8> = match encoding {
        "utf-8-bom" => {
            let mut b = Vec::with_capacity(with_eol.len() + 3);
            b.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
            b.extend_from_slice(with_eol.as_bytes());
            b
        }
        "utf-16le" => encoding_rs::UTF_16LE.encode(&with_eol).0.into_owned(),
        "utf-16be" => encoding_rs::UTF_16BE.encode(&with_eol).0.into_owned(),
        "gbk" | "gbk-lossy" => encoding_rs::GBK.encode(&with_eol).0.into_owned(),
        _ => with_eol.into_bytes(),
    };

    let mut tmp_name = path.as_os_str().to_owned();
    tmp_name.push(".tmp");
    let tmp = PathBuf::from(tmp_name);
    fs::write(&tmp, &bytes)?;
    fs::rename(&tmp, path)?;
    Ok(bytes.len())
}

/// Copy the current file content to the backups dir before an overwrite,
/// keeping the newest `keep` backups per file. Returns the backup path.
pub fn backup_file(path: &Path, backups_dir: &Path, keep: usize) -> std::io::Result<Option<PathBuf>> {
    if !path.is_file() {
        return Ok(None);
    }
    let Some(name) = path.file_name() else {
        return Ok(None);
    };
    fs::create_dir_all(backups_dir)?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dest = backups_dir.join(format!("{}.{}.bak", name.to_string_lossy(), ts));
    fs::copy(path, &dest)?;
    prune_backups(backups_dir, &format!("{}.", name.to_string_lossy()), keep)?;
    Ok(Some(dest))
}

fn prune_backups(backups_dir: &Path, prefix: &str, keep: usize) -> std::io::Result<()> {
    let mut backups: Vec<PathBuf> = fs::read_dir(backups_dir)?
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .map(|n| n.to_string_lossy().starts_with(prefix) && n.to_string_lossy().ends_with(".bak"))
                .unwrap_or(false)
        })
        .collect();
    if backups.len() <= keep {
        return Ok(());
    }
    // Timestamp is embedded in the name, so lexical order == chronological order.
    backups.sort();
    let excess = backups.len() - keep;
    for victim in &backups[..excess] {
        let _ = fs::remove_file(victim);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eol_detection() {
        assert_eq!(detect_eol("a\r\nb"), "crlf");
        assert_eq!(detect_eol("a\nb"), "lf");
        assert_eq!(detect_eol("a\rb"), "cr");
    }

    #[test]
    fn gbk_fallback() {
        let (text, enc) = decode("中文".as_bytes().to_vec());
        assert_eq!(enc, "utf-8");
        assert_eq!(text, "中文");
    }

    #[test]
    fn write_preserves_eol_and_encoding_roundtrip() {
        let dir = std::env::temp_dir().join(format!("ruakdown-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sample.md");

        // CRLF + GBK
        let gbk_bytes = encoding_rs::GBK.encode("第一行\r\n第二行").0.into_owned();
        fs::write(&path, &gbk_bytes).unwrap();
        let ft = read_text(&path).unwrap();
        assert_eq!(ft.eol, "crlf");
        assert_eq!(ft.encoding, "gbk");
        write_text(&path, "改一下\n第二行", &ft.encoding, &ft.eol).unwrap();
        let raw = fs::read(&path).unwrap();
        assert!(String::from_utf8_lossy(&raw).contains("\r\n"));
        let reread = read_text(&path).unwrap();
        assert_eq!(reread.text, "改一下\r\n第二行");
        assert_eq!(reread.encoding, "gbk");

        // UTF-8 BOM
        write_text(&path, "bom test\nline2", "utf-8-bom", "lf").unwrap();
        let raw = fs::read(&path).unwrap();
        assert!(raw.starts_with(&[0xEF, 0xBB, 0xBF]));
        assert!(!raw.windows(2).any(|w| w == [0x0D, 0x0A]));
        assert_eq!(read_text(&path).unwrap().encoding, "utf-8-bom");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn backup_rotates() {
        let dir = std::env::temp_dir().join(format!("ruakdown-bak-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let backups = dir.join("backups");
        let file = dir.join("doc.md");
        fs::create_dir_all(&dir).unwrap();
        fs::write(&file, "v1").unwrap();
        for i in 0..12 {
            fs::write(&file, format!("v{i}")).unwrap();
            let b = backup_file(&file, &backups, 10).unwrap();
            assert!(b.is_some());
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        let count = fs::read_dir(&backups).unwrap().count();
        assert_eq!(count, 10);
        let _ = fs::remove_dir_all(&dir);
    }
}
