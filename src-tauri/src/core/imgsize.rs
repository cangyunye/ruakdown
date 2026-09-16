use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Natural (width, height) of an image file, read from the header bytes
/// only — cheap enough to call per rebuild for uncached paths.
pub fn read_dims(path: &Path) -> Option<(u32, u32)> {
    let size = imagesize::size(path).ok()?;
    let w = u32::try_from(size.width).ok()?;
    let h = u32::try_from(size.height).ok()?;
    if w == 0 || h == 0 {
        return None;
    }
    Some((w, h))
}

/// Per-path dimension cache shared across preview rebuilds: the same image
/// is header-read once per session no matter how often the document around
/// it changes.
#[derive(Default)]
pub struct DimCache {
    map: HashMap<PathBuf, Option<(u32, u32)>>,
}

impl DimCache {
    pub fn get_or_read(&mut self, path: PathBuf) -> Option<(u32, u32)> {
        // usize::MAX sentinel would avoid the double lookup; a plain
        // entry-based match keeps it obvious.
        match self.map.get(&path) {
            Some(dims) => *dims,
            None => {
                let dims = read_dims(&path);
                self.map.insert(path, dims);
                dims
            }
        }
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_png_header_dims() {
        // 1x1 PNG, 8-byte signature + IHDR carrying the dimensions.
        let png: &[u8] = &[
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // signature
            0x00, 0x00, 0x00, 0x0D, // IHDR length
            0x49, 0x48, 0x44, 0x52, // "IHDR"
            0x00, 0x00, 0x00, 0x05, // width = 5
            0x00, 0x00, 0x00, 0x07, // height = 7
            0x08, 0x02, 0x00, 0x00, 0x00, // bit depth, color type, crc...
            0x90, 0x77, 0x53, 0xD8,
        ];
        let dir = std::env::temp_dir().join("ruakdown-imgsize");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("probe.png");
        std::fs::write(&path, png).unwrap();
        assert_eq!(read_dims(&path), Some((5, 7)));
    }

    #[test]
    fn missing_file_is_none() {
        assert_eq!(read_dims(Path::new("/nonexistent/nope.png")), None);
    }

    #[test]
    fn cache_reads_once_and_reuses() {
        let mut cache = DimCache::default();
        let ghost = PathBuf::from("/nonexistent/ghost.png");
        assert_eq!(cache.get_or_read(ghost.clone()), None);
        assert_eq!(cache.get_or_read(ghost.clone()), None);
        assert_eq!(cache.len(), 1, "misses are cached too, no repeated IO");
    }
}
