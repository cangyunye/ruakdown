//! Frontmatter (YAML-style `---` metadata block) rendering.
//!
//! pulldown-cmark parses the block when `ENABLE_YAML_STYLE_METADATA_BLOCKS`
//! is on but writes nothing for it; here the raw metadata text becomes a
//! declarative key-value card prepended to the rendered document. Well-known
//! keys get tailored treatments (title / bold-only / chips / date); lists of
//! maps render one item per line; everything else keeps the plain key-value
//! look.

use pulldown_cmark::{Event, Tag, TagEnd};

use crate::core::markdown::escape_html;

/// Raw metadata text carried by a metadata-block event run, if one is present.
pub(crate) fn metadata_text(events: &[Event]) -> Option<String> {
    let mut in_block = false;
    let mut raw = String::new();
    for event in events {
        match event {
            Event::Start(Tag::MetadataBlock(_)) => in_block = true,
            Event::End(TagEnd::MetadataBlock(_)) => in_block = false,
            Event::Text(t) if in_block => raw.push_str(t),
            _ => {}
        }
    }
    if raw.is_empty() {
        None
    } else {
        Some(raw)
    }
}

/// One folded list item: `k: v` lines become pairs, plain lines fold into
/// `text` (two levels only; deeper indentation stays inside the item).
struct Item {
    pairs: Vec<(String, String)>,
    text: String,
}

/// A top-level key, its key-line value, and any `- ` list items under it.
struct Row {
    key: String,
    text: String,
    items: Vec<Item>,
}

/// Render metadata text as the property card. Returns "" when no usable
/// top-level keys were found.
pub(crate) fn card_html(raw: &str) -> String {
    let rows = parse_rows(raw);
    if rows.is_empty() {
        return String::new();
    }
    let mut out = String::from("<div class=\"md-frontmatter\">");
    for row in &rows {
        out.push_str(&row_html(row));
    }
    out.push_str("</div>\n");
    out
}

/// Line-by-line parse (no YAML semantics): a `- ` line opens a new list item
/// under the current key, further indented lines fold into that item, and
/// `k: v` shaped lines inside an item become pairs.
fn parse_rows(raw: &str) -> Vec<Row> {
    let mut rows: Vec<Row> = Vec::new();
    for line in raw.lines() {
        let line = line.trim_end();
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let indented = line.starts_with(' ') || line.starts_with('\t');
        if indented || trimmed.starts_with("- ") {
            let Some(row) = rows.last_mut() else {
                continue;
            };
            let body = trimmed.strip_prefix("- ").unwrap_or(trimmed);
            if body.is_empty() {
                continue;
            }
            if trimmed.starts_with("- ") {
                row.items.push(Item { pairs: Vec::new(), text: String::new() });
            }
            let Some(item) = row.items.last_mut() else {
                // Indented continuation without `-`: folds onto the key-line value.
                if !row.text.is_empty() {
                    row.text.push_str(", ");
                }
                row.text.push_str(body);
                continue;
            };
            match split_pair(body) {
                Some((k, v)) => item.pairs.push((k.to_string(), scalar_value(v.trim()))),
                None => {
                    if !item.text.is_empty() {
                        item.text.push_str(", ");
                    }
                    item.text.push_str(body);
                }
            }
            continue;
        }
        let Some(colon) = trimmed.find(':') else {
            continue;
        };
        let key = trimmed[..colon].trim();
        if key.is_empty() {
            continue;
        }
        rows.push(Row {
            key: key.to_string(),
            text: scalar_value(trimmed[colon + 1..].trim()),
            items: Vec::new(),
        });
    }
    rows
}

/// `k: v` line → `(k, v)`; None when nothing precedes the colon.
fn split_pair(body: &str) -> Option<(&str, &str)> {
    let colon = body.find(':')?;
    let key = body[..colon].trim();
    if key.is_empty() {
        return None;
    }
    Some((key, &body[colon + 1..]))
}

/// Value folded back into one comma-joined line (known scalar keys and the
/// plain fallback render this way).
fn folded_text(row: &Row) -> String {
    let mut parts: Vec<String> = Vec::new();
    if !row.text.is_empty() {
        parts.push(row.text.clone());
    }
    for item in &row.items {
        let mut piece = item
            .pairs
            .iter()
            .map(|(k, v)| format!("{k}: {v}"))
            .collect::<Vec<_>>()
            .join(", ");
        if !item.text.is_empty() {
            if !piece.is_empty() {
                piece.push_str(", ");
            }
            piece.push_str(&item.text);
        }
        if !piece.is_empty() {
            parts.push(piece);
        }
    }
    parts.join(", ")
}

/// One `<div class="fm-row">` with a per-key look. Key matching is
/// case-insensitive; unknown keys render plain, or as one line per item when
/// their list items are structured (`k: v`) maps.
fn row_html(row: &Row) -> String {
    let text = folded_text(row);
    let structured = row.items.iter().any(|item| !item.pairs.is_empty());
    let (row_class, val_class, inner) = match row.key.to_lowercase().as_str() {
        "title" => (" fm-title", "", escape_html(&text)),
        "name" | "author" | "version" => ("", "", format!("<strong>{text}</strong>")),
        "tags" | "categories" | "keywords" => match chip_html(&text) {
            chips if chips.is_empty() => ("", "", escape_html(&text)),
            chips => (" fm-chiprow", " fm-chips", chips),
        },
        "date" => (
            "",
            "",
            escape_html(&normalize_date(&text).unwrap_or(text)),
        ),
        "description" => (" fm-desc", "", escape_html(&text)),
        _ if structured => (" fm-items-row", " fm-items", items_html(row)),
        _ => ("", "", escape_html(&text)),
    };
    format!(
        "<div class=\"fm-row{row_class}\"><span class=\"fm-key\">{}</span>\
         <span class=\"fm-val{val_class}\">{inner}</span></div>",
        escape_html(&row.key)
    )
}

/// Structured list items: one line per item; `k: v` pairs render with a
/// muted key and ` · ` between fields (styled via .fm-pair-key / .fm-sep).
fn items_html(row: &Row) -> String {
    let mut lines: Vec<String> = Vec::new();
    if !row.text.is_empty() {
        lines.push(format!("<span class=\"fm-item\">{}</span>", escape_html(&row.text)));
    }
    for item in &row.items {
        let mut parts: Vec<String> = item
            .pairs
            .iter()
            .map(|(k, v)| {
                format!(
                    "<span class=\"fm-pair\"><span class=\"fm-pair-key\">{}:</span> {}</span>",
                    escape_html(k),
                    escape_html(v)
                )
            })
            .collect();
        if !item.text.is_empty() {
            parts.push(escape_html(&item.text));
        }
        if parts.is_empty() {
            continue;
        }
        lines.push(format!(
            "<span class=\"fm-item\">{}</span>",
            parts.join("<span class=\"fm-sep\"> · </span>")
        ));
    }
    lines.join("")
}

/// Split a comma / 顿号 / semicolon separated value into colored capsule spans.
fn chip_html(val: &str) -> String {
    val.split([',', '，', '、', ';', '；'])
        .map(str::trim)
        .filter(|tag| !tag.is_empty())
        .map(|tag| {
            format!(
                "<span class=\"fm-chip chip-{}\">{}</span>",
                chip_index(tag),
                escape_html(tag)
            )
        })
        .collect()
}

/// FNV-1a over the UTF-8 bytes of the lowercased tag: the same tag always
/// lands on the same one of the 8 palette slots, in every render and chunk.
fn chip_index(tag: &str) -> usize {
    let mut h: u32 = 0x811c_9dc5;
    for b in tag.to_lowercase().as_bytes() {
        h ^= u32::from(*b);
        h = h.wrapping_mul(0x0100_0193);
    }
    (h % 8) as usize
}

/// Normalize common date spellings to `YYYY-MM-DD HH:MM:SS` as pure string
/// surgery: fields are extracted and zero-padded, a missing clock becomes
/// `00:00:00`, trailing `Z` / `±hh:mm` / `±hhmm` offsets are dropped without
/// conversion. No calendar validation (02-30 stays as written); returns None
/// for anything that does not match a known shape, and the caller then shows
/// the raw value.
fn normalize_date(raw: &str) -> Option<String> {
    let chars: Vec<char> = raw.trim().chars().collect();
    let mut i = 0usize;

    let year = take_num(&chars, &mut i, 4, 4)?;
    if !matches!(chars.get(i), Some('-' | '/' | '.' | '年')) {
        return None;
    }
    i += 1;
    let month = take_num(&chars, &mut i, 1, 2)?;
    if !matches!(chars.get(i), Some('-' | '/' | '.' | '月')) {
        return None;
    }
    i += 1;
    let day = take_num(&chars, &mut i, 1, 2)?;
    if chars.get(i) == Some(&'日') {
        i += 1;
    }

    let (mut hh, mut mm, mut ss) = (0u32, 0u32, 0u32);
    if matches!(chars.get(i), Some('T' | 't' | ' ')) {
        let save = i;
        i += 1;
        while chars.get(i) == Some(&' ') {
            i += 1;
        }
        match take_time(&chars, &mut i) {
            Some((h, m, s)) => {
                hh = h;
                mm = m;
                ss = s;
            }
            // Not a clock after all: rewind, the tail must then be a zone
            // suffix or the full-consumption check below rejects the value.
            None => i = save,
        }
    }

    if matches!(chars.get(i), Some('Z' | 'z')) {
        i += 1;
    } else if matches!(chars.get(i), Some('+' | '-')) {
        i += 1;
        take_num(&chars, &mut i, 2, 2)?;
        if chars.get(i) == Some(&':') {
            i += 1;
        }
        take_num(&chars, &mut i, 2, 2)?;
    }
    if i != chars.len() {
        return None;
    }

    Some(format!("{year:04}-{month:02}-{day:02} {hh:02}:{mm:02}:{ss:02}"))
}

/// Consume 1–2 digit fields like month/day/hour; `min`..`max` digits.
fn take_num(chars: &[char], i: &mut usize, min: usize, max: usize) -> Option<u32> {
    let start = *i;
    while *i < chars.len() && chars[*i].is_ascii_digit() && *i - start < max {
        *i += 1;
    }
    if *i - start < min {
        return None;
    }
    chars[start..*i].iter().collect::<String>().parse().ok()
}

/// Parse `H:MM` or `H:MM:SS` starting at `*i`; None when no clock follows.
fn take_time(chars: &[char], i: &mut usize) -> Option<(u32, u32, u32)> {
    let h = take_num(chars, i, 1, 2)?;
    if chars.get(*i) != Some(&':') {
        return None;
    }
    *i += 1;
    let m = take_num(chars, i, 2, 2)?;
    let s = if chars.get(*i) == Some(&':') {
        *i += 1;
        take_num(chars, i, 2, 2)?
    } else {
        0
    };
    Some((h, m, s))
}

/// Strip one layer of quoting or flow-list brackets from a scalar value.
fn scalar_value(val: &str) -> String {
    let unbracketed = if val.starts_with('[') && val.ends_with(']') && val.len() >= 2 {
        &val[1..val.len() - 1]
    } else {
        val
    };
    let bytes = unbracketed.as_bytes();
    if bytes.len() >= 2
        && ((bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\''))
    {
        unbracketed[1..unbracketed.len() - 1].to_string()
    } else {
        unbracketed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn card_renders_keys_values_lists_and_quotes() {
        let card = card_html("title: 示例文档\ntags:\n  - rust\n  - tauri\nquoted: \"a: b\"\n# 注释\n\n");
        assert!(card.contains("fm-row fm-title"), "{card}");
        assert!(card.contains(">rust<"), "{card}");
        assert!(card.contains(">tauri<"), "{card}");
        assert!(!card.contains("rust, tauri"), "{card}");
        assert!(card.contains(">a: b<"), "{card}");
        assert!(!card.contains("注释"), "{card}");
        assert!(card.starts_with("<div class=\"md-frontmatter\">"), "{card}");
    }

    #[test]
    fn tailored_keys_get_their_treatments() {
        let card = card_html(
            "name: ruakdown\nAUTHOR: cangyunye\nversion: 0.6.1\ndescription: 一份示例。\n",
        );
        assert!(card.contains("<strong>ruakdown</strong>"), "{card}");
        // Key matching is case-insensitive.
        assert!(card.contains("<strong>cangyunye</strong>"), "{card}");
        assert!(card.contains("<strong>0.6.1</strong>"), "{card}");
        assert!(card.contains("fm-row fm-desc"), "{card}");
    }

    #[test]
    fn nested_object_arrays_render_one_item_per_line() {
        let card = card_html(
            "references:\n  - path: auth\n    desc: 安全鉴权\n  - path: layout\n    desc: UI 布局\n",
        );
        assert!(card.contains("fm-items-row"), "{card}");
        assert!(card.contains("fm-pair-key\">path:</span> auth"), "{card}");
        assert!(card.contains("fm-pair-key\">desc:</span> 安全鉴权"), "{card}");
        assert!(card.contains("fm-sep"), "{card}");
        assert_eq!(card.matches("<span class=\"fm-item\">").count(), 2, "{card}");
    }

    #[test]
    fn plain_scalar_lists_keep_the_comma_joined_line() {
        let card = card_html("deps:\n  - a\n  - b\n");
        assert!(!card.contains("fm-items"), "{card}");
        assert!(card.contains(">a, b<"), "{card}");
    }

    #[test]
    fn empty_tag_value_falls_back_to_plain_text() {
        let card = card_html("tags: , 、\n");
        assert!(!card.contains("fm-chip"), "{card}");
        assert!(card.contains("class=\"fm-row\"><span class=\"fm-key\">tags</span>"), "{card}");
    }

    #[test]
    fn chips_split_and_stay_stable() {
        let card = card_html("tags: rust, tauri、markdown\nkeywords: [a, b]\n");
        assert!(card.contains(">rust<"), "{card}");
        assert!(card.contains(">tauri<"), "{card}");
        assert!(card.contains(">markdown<"), "{card}");
        assert!(card.contains(">a<"), "{card}");
        assert!(card.contains(">b<"), "{card}");
        assert!(card.contains("fm-chip chip-"), "{card}");
        // The same tag always lands on the same palette slot.
        assert_eq!(chip_index("rust"), chip_index("RUST"));
        for tag in ["rust", "tauri", "开发工具", "桌面应用", "a", ""] {
            assert!(chip_index(tag) < 8, "{tag}");
        }
    }

    #[test]
    fn date_normalizes_common_shapes() {
        let cases = [
            ("2024-1-5", "2024-01-05 00:00:00"),
            ("2024/01/15 10:30", "2024-01-15 10:30:00"),
            ("2024-01-15T10:30:45Z", "2024-01-15 10:30:45"),
            ("2024-01-15t10:30:45z", "2024-01-15 10:30:45"),
            ("2024-01-15T10:30:45+08:00", "2024-01-15 10:30:45"),
            ("2024-01-15 10:30:45-0530", "2024-01-15 10:30:45"),
            ("2024年1月5日", "2024-01-05 00:00:00"),
            ("2024.3.2 8:05:09", "2024-03-02 08:05:09"),
            ("  2024-1-5  ", "2024-01-05 00:00:00"),
        ];
        for (input, want) in cases {
            assert_eq!(normalize_date(input).as_deref(), Some(want), "{input}");
        }
        for bad in ["1705286400", "发布于上周", "2024-13", ""] {
            assert_eq!(normalize_date(bad), None, "{bad}");
        }
    }

    #[test]
    fn date_row_falls_back_to_raw_text() {
        let card = card_html("date: 发布于上周\n");
        assert!(card.contains(">发布于上周<"), "{card}");
    }

    #[test]
    fn card_escapes_html_and_handles_empty() {
        assert!(card_html("v: <b>&amp;</b>").contains("&lt;b&gt;&amp;amp;&lt;/b&gt;"));
        assert_eq!(card_html("# only a comment\n\n"), "");
        assert_eq!(card_html(""), "");
        assert_eq!(card_html("no colon line\n"), "");
    }
}
