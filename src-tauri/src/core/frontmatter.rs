//! Frontmatter (YAML-style `---` metadata block) rendering.
//!
//! pulldown-cmark parses the block when `ENABLE_YAML_STYLE_METADATA_BLOCKS`
//! is on but writes nothing for it; here the raw metadata text becomes a
//! declarative key-value card prepended to the rendered document. Well-known
//! keys get tailored treatments (title / bold-only / chips / date); lists of
//! maps render one item per line; everything else keeps the plain key-value
//! look.

use crate::core::markdown::escape_html;

/// A frontmatter block split off the top of the document.
pub(crate) struct FrontmatterSplit<'a> {
    /// Raw text between the fences, line endings included.
    pub meta: &'a str,
    /// Everything after the closing fence line; always a suffix of the input.
    pub body: &'a str,
}

/// Split a metadata block off the very top of the document, mirroring
/// pulldown-cmark's YAML-style scan: optional leading blank lines, then a
/// column-0 line of exactly three `-` (trailing whitespace only) whose first
/// following line is non-blank, closed by a column-0 line of exactly `---` or
/// `...` (trailing spaces only). Only a document-initial block counts; a
/// `---…---` run in the middle of the document is the author's divider plus
/// content and must render as such, not disappear into the property card.
pub(crate) fn split_initial(source: &str) -> Option<FrontmatterSplit<'_>> {
    let bytes = source.as_bytes();
    let mut pos = 0usize;
    // Leading blank lines pass through before the scan sees the opener.
    loop {
        let (start, end) = line_at(bytes, pos)?;
        if is_blank(&bytes[start..end]) {
            pos = end;
        } else {
            break;
        }
    }
    let (opener_start, opener_end) = line_at(bytes, pos)?;
    if opener_field(&bytes[opener_start..opener_end], b'-') != Some(3) {
        return None;
    }
    let meta_start = opener_end;
    let mut first = true;
    let mut cursor = meta_start;
    loop {
        let (start, end) = line_at(bytes, cursor)?;
        let line = &bytes[start..end];
        let closed = opener_field(line, b'-') == Some(3) || opener_field(line, b'.') == Some(3);
        if first {
            // The first line inside the fences can neither be blank nor the
            // closing fence itself, or pulldown would not see a block either.
            if closed || is_blank(line) {
                return None;
            }
            first = false;
        }
        cursor = end;
        if closed {
            return Some(FrontmatterSplit {
                meta: &source[meta_start..start],
                body: &source[end..],
            });
        }
    }
}

/// Byte range of the line starting at `pos`, line ending included; None at EOF.
fn line_at(bytes: &[u8], pos: usize) -> Option<(usize, usize)> {
    if pos >= bytes.len() {
        return None;
    }
    let end = bytes[pos..]
        .iter()
        .position(|&b| b == b'\n')
        .map_or(bytes.len(), |i| pos + i + 1);
    Some((pos, end))
}

/// A blank line: nothing but spaces and tabs before the line ending.
fn is_blank(line: &[u8]) -> bool {
    line.iter()
        .take_while(|&&b| b != b'\n')
        .all(|&b| b == b' ' || b == b'\t' || b == b'\r')
}

/// Count leading runs of `ch` on the line when the remainder is fenced-line
/// shaped: exactly 3 runs, then spaces/tabs only up to the line ending (the
/// closing fence allows trailing spaces only — tabs would fail pulldown's
/// scan — and `\r` before the `\n` folds into that check).
fn opener_field(line: &[u8], ch: u8) -> Option<usize> {
    let mut i = 0usize;
    while i < line.len() && line[i] == ch {
        i += 1;
    }
    if i != 3 {
        return None;
    }
    let rest = &line[i..];
    let body = match rest.iter().position(|&b| b == b'\n') {
        Some(j) => &rest[..j],
        None => rest,
    };
    let body = body.strip_suffix(b"\r").unwrap_or(body);
    if body.iter().all(|&b| b == b' ' || b == b'\t') {
        Some(i)
    } else {
        None
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
        "references" => reference_html(row),
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

/// `references` row: every entry renders as a themed link (`<a class="fm-ref">`)
/// so local paths open in the app and web URLs in the browser. Scalar
/// comma-separated values and plain `- entry` items join on one wrapped line;
/// structured (`k: v`) items keep the one-item-per-line look, linking the
/// value of the pair that names the target.
fn reference_html(row: &Row) -> (&'static str, &'static str, String) {
    let structured = row.items.iter().any(|item| !item.pairs.is_empty());
    if !structured {
        let mut links: Vec<String> = split_entries(&row.text)
            .into_iter()
            .map(ref_link)
            .collect();
        for item in &row.items {
            links.extend(split_entries(&item.text).into_iter().map(ref_link));
        }
        if links.is_empty() {
            return ("", "", String::new());
        }
        return ("", " fm-refs", links.join(", "));
    }
    let mut lines: Vec<String> = Vec::new();
    if !row.text.is_empty() {
        let links: Vec<String> = split_entries(&row.text).into_iter().map(ref_link).collect();
        if !links.is_empty() {
            lines.push(format!(
                "<span class=\"fm-item\">{}</span>",
                links.join(", ")
            ));
        }
    }
    for item in &row.items {
        let mut parts: Vec<String> = item
            .pairs
            .iter()
            .map(|(k, v)| {
                let target = if is_ref_target_key(k) { ref_link(v) } else { escape_html(v) };
                format!(
                    "<span class=\"fm-pair\"><span class=\"fm-pair-key\">{}:</span> {target}</span>",
                    escape_html(k)
                )
            })
            .collect();
        if !item.text.is_empty() {
            let links: Vec<String> =
                split_entries(&item.text).into_iter().map(ref_link).collect();
            parts.push(links.join(", "));
        }
        if parts.is_empty() {
            continue;
        }
        lines.push(format!(
            "<span class=\"fm-item\">{}</span>",
            parts.join("<span class=\"fm-sep\"> · </span>")
        ));
    }
    (" fm-items-row", " fm-items", lines.join(""))
}

/// Pair keys whose value names the link target of a structured reference.
fn is_ref_target_key(key: &str) -> bool {
    ["path", "url", "href", "link", "file"]
        .iter()
        .any(|c| key.eq_ignore_ascii_case(c))
}

/// Split an entry list on the same separators as [`chip_html`].
fn split_entries(val: &str) -> Vec<&str> {
    val.split([',', '，', '、', ';', '；'])
        .map(str::trim)
        .filter(|tag| !tag.is_empty())
        .collect()
}

/// One reference entry as a link; the raw value is both href and label.
fn ref_link(value: &str) -> String {
    format!(
        "<a class=\"fm-ref\" href=\"{}\">{}</a>",
        escape_html(value),
        escape_html(value)
    )
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

    /// split_initial accepted: (meta text, body text).
    fn split(src: &str) -> Option<(&str, &str)> {
        split_initial(src).map(|s| (s.meta, s.body))
    }

    #[test]
    fn split_lifts_only_a_document_initial_block() {
        // The common shape.
        assert_eq!(
            split("---\ntitle: x\ntags: a\n---\n\nbody\n"),
            Some(("title: x\ntags: a\n", "\nbody\n"))
        );
        // Leading blank lines pass through before the opener.
        assert_eq!(split("\n\n---\nk: v\n---\nrest\n"), Some(("k: v\n", "rest\n")));
        // Trailing whitespace on either fence; `...` also closes.
        assert_eq!(split("--- \nk: v\n---\nrest"), Some(("k: v\n", "rest")));
        assert_eq!(split("---\nk: v\n...\nrest"), Some(("k: v\n", "rest")));
        // A blank line after the first content line stays inside the block.
        assert_eq!(split("---\na: 1\n\nb: 2\n---\nrest"), Some(("a: 1\n\nb: 2\n", "rest")));
        // Close at EOF without a trailing newline.
        assert_eq!(split("---\nk: v\n---"), Some(("k: v\n", "")));
    }

    #[test]
    fn split_rejects_non_frontmatter_shapes() {
        // A blank line right after the opener: thematic break, not metadata.
        assert_eq!(split("---\n\ntitle: x\n---\n"), None);
        // Indented opener (a list continuation / code block, never metadata).
        assert_eq!(split(" ---\nk: v\n---\n"), None);
        // Any fence longer than three dashes.
        assert_eq!(split("----\nk: v\n----\n"), None);
        assert_eq!(split("---\nk: v\n----\n"), None);
        // No closing fence at all.
        assert_eq!(split("---\nk: v\n"), None);
        // Empty document.
        assert_eq!(split(""), None);
        assert_eq!(split("\n\n"), None);
    }

    #[test]
    fn split_ignores_mid_document_runs() {
        // The motivating case: a `---…---` run after body content is a
        // divider plus content, never frontmatter — even though its shape
        // matches the metadata syntax exactly.
        let doc = "# 标题\n\n正文。\n\n---\n设置: 打开\n备注: 测试\n---\n\n第二节。\n";
        assert_eq!(split(doc), None);
        // Blank lines around the fences change nothing.
        let doc = "一段。\n\n---\n\n中间内容\n\n---\n\n二段。\n";
        assert_eq!(split(doc), None);
    }

    #[test]
    fn split_body_is_always_a_suffix_starting_after_the_closer() {
        let src = "---\ntitle: x\n---\n# Head\n";
        let s = split_initial(src).unwrap();
        assert!(src.ends_with(s.body));
        assert_eq!(s.body, "# Head\n");
        // The metadata text feeds card_html unchanged.
        assert!(card_html(s.meta).contains("fm-title"));
    }

    #[test]
    fn references_render_as_links_in_every_shape() {
        // Scalar comma list on the key line.
        let card = card_html("references: auth.md, https://example.com\n");
        assert!(
            card.contains("<a class=\"fm-ref\" href=\"auth.md\">auth.md</a>"),
            "{card}"
        );
        assert!(
            card.contains("<a class=\"fm-ref\" href=\"https://example.com\">https://example.com</a>"),
            "{card}"
        );
        // Plain `- entry` items: one link per item.
        let card = card_html("references:\n  - notes/a.md\n  - docs/b.md\n");
        assert!(card.contains("fm-refs"), "{card}");
        assert!(card.contains("href=\"notes/a.md\""), "{card}");
        assert!(card.contains("href=\"docs/b.md\""), "{card}");
        // Structured items: the path pair links, desc stays plain text.
        let card = card_html(
            "references:\n  - path: auth.md\n    desc: 安全鉴权\n",
        );
        assert!(card.contains("fm-items"), "{card}");
        assert!(card.contains("fm-pair-key\">path:</span> <a class=\"fm-ref\" href=\"auth.md\">auth.md</a>"), "{card}");
        assert!(card.contains("fm-pair-key\">desc:</span> 安全鉴权"), "{card}");
        // Values are attribute-escaped.
        let card = card_html("references: a\"b.md\n");
        assert!(card.contains("href=\"a&quot;b.md\""), "{card}");
        // Flow-array key line: the quick-insert template ships this shape.
        let card = card_html("references: [./相关文档.md, https://example.com]\n");
        assert!(card.contains("href=\"./相关文档.md\""), "{card}");
        assert!(card.contains("href=\"https://example.com\""), "{card}");
    }

    #[test]
    fn references_key_matches_case_insensitively_and_stays_plain_when_empty() {
        let card = card_html("References: []\n");
        assert!(card.contains("<span class=\"fm-key\">References</span>"), "{card}");
        assert!(!card.contains("fm-ref"), "{card}");
    }

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
            "deps:\n  - path: auth\n    desc: 安全鉴权\n  - path: layout\n    desc: UI 布局\n",
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
