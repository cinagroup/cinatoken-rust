//! Lightweight multipart/form-data field extraction.
//!
//! Used by the upload relay endpoints (`/v1/audio/transcriptions`,
//! `/v1/audio/translations`, `/v1/images/edits`) to pull the `model` form
//! field out of the request so the relay can authenticate, route, and bill
//! the request. Most providers receive the full multipart body verbatim;
//! dedicated adapters can also read bounded file parts for native conversion.
//!
//! This is intentionally NOT a full multipart parser. It does not decode
//! base64 or quoted-printable, and it does not validate the body against RFC
//! 7578. It finds parts by scanning for boundary delimiters and parses the
//! ASCII headers each part needs. The body itself is scanned as bytes so real
//! binary uploads can still expose nearby text fields such as `model`.

use std::fmt;

const MAX_MULTIPART_PART_HEADER_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MultipartFile<'a> {
    pub filename: String,
    pub content_type: Option<String>,
    pub bytes: &'a [u8],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MultipartFilesError {
    TooManyFiles { max_files: usize },
    PartHeadersTooLarge,
}

impl fmt::Display for MultipartFilesError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooManyFiles { max_files } => {
                write!(f, "multipart request exceeds the {max_files}-file limit")
            }
            Self::PartHeadersTooLarge => write!(
                f,
                "multipart part headers exceed the {MAX_MULTIPART_PART_HEADER_BYTES}-byte limit"
            ),
        }
    }
}

impl std::error::Error for MultipartFilesError {}

/// Extract a single text field from a `multipart/form-data` body by name.
///
/// Returns `None` when the field is absent, the content type is not
/// multipart, or the boundary cannot be parsed. File parts (parts with a
/// `filename=` disposition) are skipped.
pub fn extract_multipart_field(
    body: &[u8],
    content_type: &str,
    field_name: &str,
) -> Option<String> {
    let boundary = extract_boundary(content_type)?;
    extract_field_with_boundary(body, &boundary, field_name)
}

/// Extract the first file part with the given field name.
///
/// Returns `None` when the field is absent, the content type is not multipart,
/// the boundary cannot be parsed, or the part is not a file part.
pub fn extract_multipart_file<'a>(
    body: &'a [u8],
    content_type: &str,
    field_name: &str,
) -> Option<MultipartFile<'a>> {
    let boundary = extract_boundary(content_type)?;
    extract_file_with_boundary(body, &boundary, field_name)
}

/// Extract every file part with the exact field name, preserving body order.
pub fn extract_multipart_files<'a>(
    body: &'a [u8],
    content_type: &str,
    field_name: &str,
) -> Vec<MultipartFile<'a>> {
    let Some(boundary) = extract_boundary(content_type) else {
        return Vec::new();
    };
    extract_files_with_boundary(body, &boundary, |name| name == field_name)
}

/// Extract every file part whose field name starts with the supplied prefix.
pub fn extract_multipart_files_with_prefix<'a>(
    body: &'a [u8],
    content_type: &str,
    field_prefix: &str,
) -> Vec<MultipartFile<'a>> {
    let Some(boundary) = extract_boundary(content_type) else {
        return Vec::new();
    };
    extract_files_with_boundary(body, &boundary, |name| name.starts_with(field_prefix))
}

/// Extract exact-name file parts while refusing to retain more than `max_files`.
pub fn extract_multipart_files_bounded<'a>(
    body: &'a [u8],
    content_type: &str,
    field_name: &str,
    max_files: usize,
) -> Result<Vec<MultipartFile<'a>>, MultipartFilesError> {
    let Some(boundary) = extract_boundary(content_type) else {
        return Ok(Vec::new());
    };
    extract_files_with_boundary_bounded(body, &boundary, max_files, |name| name == field_name)
}

/// Extract prefix-matched file parts while refusing to retain more than `max_files`.
pub fn extract_multipart_files_with_prefix_bounded<'a>(
    body: &'a [u8],
    content_type: &str,
    field_prefix: &str,
    max_files: usize,
) -> Result<Vec<MultipartFile<'a>>, MultipartFilesError> {
    let Some(boundary) = extract_boundary(content_type) else {
        return Ok(Vec::new());
    };
    extract_files_with_boundary_bounded(body, &boundary, max_files, |name| {
        name.starts_with(field_prefix)
    })
}

/// Extract the `boundary` parameter from a `multipart/form-data;
/// boundary=...` Content-Type header. Returns the raw boundary value
/// (without the leading `--`).
pub fn extract_boundary(content_type: &str) -> Option<String> {
    let mut params = content_type.split(';');
    let media_type = params.next()?.trim();
    if !media_type.eq_ignore_ascii_case("multipart/form-data") {
        return None;
    }

    for param in params {
        let Some((name, value)) = param.split_once('=') else {
            continue;
        };
        if !name.trim().eq_ignore_ascii_case("boundary") {
            continue;
        }
        let value = value.trim();
        let boundary = if let Some(stripped) = value.strip_prefix('"') {
            let end = stripped.find('"')?;
            &stripped[..end]
        } else {
            value
        };
        let boundary = boundary.trim();
        if !boundary.is_empty() {
            return Some(boundary.to_string());
        }
    }
    None
}

fn extract_field_with_boundary(body: &[u8], boundary: &str, field_name: &str) -> Option<String> {
    for part in MultipartParts::new(body, boundary)? {
        let (headers, part_body) = split_part_headers(part)?;
        if let Some((name, filename)) = parse_content_disposition(headers) {
            if filename.is_some() {
                continue;
            }
            if name == field_name {
                return std::str::from_utf8(part_body).ok().map(str::to_string);
            }
        }
    }
    None
}

fn extract_file_with_boundary<'a>(
    body: &'a [u8],
    boundary: &str,
    field_name: &str,
) -> Option<MultipartFile<'a>> {
    for part in MultipartParts::new(body, boundary)? {
        let (headers, part_body) = split_part_headers(part)?;
        let Some((name, filename)) = parse_content_disposition(headers) else {
            continue;
        };
        if name != field_name {
            continue;
        }
        let filename = filename?;
        return Some(MultipartFile {
            filename,
            content_type: parse_part_content_type(headers),
            bytes: part_body,
        });
    }
    None
}

fn extract_files_with_boundary<'a, F>(
    body: &'a [u8],
    boundary: &str,
    mut matches_name: F,
) -> Vec<MultipartFile<'a>>
where
    F: FnMut(&str) -> bool,
{
    let Some(parts) = MultipartParts::new(body, boundary) else {
        return Vec::new();
    };
    parts
        .filter_map(|part| {
            let (headers, part_body) = split_part_headers(part)?;
            let (name, filename) = parse_content_disposition(headers)?;
            if !matches_name(&name) {
                return None;
            }
            Some(MultipartFile {
                filename: filename?,
                content_type: parse_part_content_type(headers),
                bytes: part_body,
            })
        })
        .collect()
}

fn extract_files_with_boundary_bounded<'a, F>(
    body: &'a [u8],
    boundary: &str,
    max_files: usize,
    mut matches_name: F,
) -> Result<Vec<MultipartFile<'a>>, MultipartFilesError>
where
    F: FnMut(&str) -> bool,
{
    let Some(parts) = MultipartParts::new(body, boundary) else {
        return Ok(Vec::new());
    };
    let mut files = Vec::with_capacity(max_files.min(16));
    for part in parts {
        let Some((headers, part_body)) = split_part_headers_bounded(part)? else {
            continue;
        };
        let Some((name, filename)) = parse_content_disposition(headers) else {
            continue;
        };
        if !matches_name(&name) {
            continue;
        }
        let Some(filename) = filename else {
            continue;
        };
        if files.len() >= max_files {
            return Err(MultipartFilesError::TooManyFiles { max_files });
        }
        files.push(MultipartFile {
            filename,
            content_type: parse_part_content_type(headers),
            bytes: part_body,
        });
    }
    Ok(files)
}

struct MultipartParts<'a> {
    body: &'a [u8],
    delimiter: Vec<u8>,
    position: usize,
    finished: bool,
}

impl<'a> MultipartParts<'a> {
    fn new(body: &'a [u8], boundary: &str) -> Option<Self> {
        let mut delimiter = Vec::with_capacity(boundary.len() + 2);
        delimiter.extend_from_slice(b"--");
        delimiter.extend_from_slice(boundary.as_bytes());
        let first = find_boundary_at_or_after(body, &delimiter, 0)?;
        Some(Self {
            body,
            delimiter,
            position: first,
            finished: false,
        })
    }
}

impl<'a> Iterator for MultipartParts<'a> {
    type Item = &'a [u8];

    fn next(&mut self) -> Option<Self::Item> {
        if self.finished {
            return None;
        }

        let mut part_start = self.position.checked_add(self.delimiter.len())?;
        if self.body.get(part_start..part_start + 2) == Some(b"--") {
            self.finished = true;
            return None;
        }
        if self.body.get(part_start..part_start + 2) == Some(b"\r\n") {
            part_start += 2;
        } else if self.body.get(part_start..part_start + 1) == Some(b"\n") {
            part_start += 1;
        }

        let (marker_start, delimiter_start) =
            find_next_boundary(self.body, &self.delimiter, part_start)?;
        self.position = delimiter_start;
        Some(&self.body[part_start..marker_start])
    }
}

fn find_boundary_at_or_after(body: &[u8], delimiter: &[u8], start: usize) -> Option<usize> {
    let mut search = start;
    while search <= body.len().saturating_sub(delimiter.len()) {
        let idx = find_subslice_from(body, delimiter, search)?;
        if idx == 0 || body.get(idx.saturating_sub(2)..idx) == Some(b"\r\n") {
            return Some(idx);
        }
        search = idx.saturating_add(1);
    }
    None
}

/// Return `(marker_start, delimiter_start)` for the next boundary. The marker
/// includes the CRLF before `--boundary`; the delimiter starts at `--boundary`.
fn find_next_boundary(body: &[u8], delimiter: &[u8], start: usize) -> Option<(usize, usize)> {
    let mut search = start;
    while search <= body.len().saturating_sub(delimiter.len()) {
        let delimiter_start = find_subslice_from(body, delimiter, search)?;
        let marker_start =
            if body.get(delimiter_start.saturating_sub(2)..delimiter_start) == Some(b"\r\n") {
                delimiter_start - 2
            } else if body.get(delimiter_start.saturating_sub(1)..delimiter_start) == Some(b"\n") {
                delimiter_start - 1
            } else {
                search = delimiter_start.saturating_add(1);
                continue;
            };
        let after = delimiter_start + delimiter.len();
        if body.get(after..after + 2) == Some(b"--")
            || body.get(after..after + 2) == Some(b"\r\n")
            || body.get(after..after + 1) == Some(b"\n")
        {
            return Some((marker_start, delimiter_start));
        }
        search = delimiter_start.saturating_add(1);
    }
    None
}

fn find_subslice_from(haystack: &[u8], needle: &[u8], start: usize) -> Option<usize> {
    if needle.is_empty() || start > haystack.len() {
        return None;
    }
    haystack
        .get(start..)?
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|idx| start + idx)
}

fn split_part_headers(part: &[u8]) -> Option<(&str, &[u8])> {
    split_part_headers_bounded(part).ok().flatten()
}

fn split_part_headers_bounded(part: &[u8]) -> Result<Option<(&str, &[u8])>, MultipartFilesError> {
    let separator = b"\r\n\r\n";
    let Some(header_end) = find_subslice_from(part, separator, 0) else {
        return if part.len() > MAX_MULTIPART_PART_HEADER_BYTES {
            Err(MultipartFilesError::PartHeadersTooLarge)
        } else {
            Ok(None)
        };
    };
    if header_end > MAX_MULTIPART_PART_HEADER_BYTES {
        return Err(MultipartFilesError::PartHeadersTooLarge);
    }
    let Some(headers) = std::str::from_utf8(&part[..header_end]).ok() else {
        return Ok(None);
    };
    Ok(Some((headers, &part[header_end + separator.len()..])))
}

/// Parse a `Content-Disposition: form-data; name="field"[; filename="..."]`
/// header block. Returns `(name, filename)`.
fn parse_content_disposition(headers: &str) -> Option<(String, Option<String>)> {
    let mut name: Option<String> = None;
    let mut filename: Option<String> = None;
    for line in headers.lines() {
        let lower = line.to_ascii_lowercase();
        if !lower.starts_with("content-disposition:") {
            continue;
        }
        // Extract name="..." and filename="..." via simple scanning.
        if let Some(n) = extract_quoted_param(line, "name") {
            name = Some(n);
        }
        filename = extract_quoted_param(line, "filename");
        break;
    }
    name.map(|n| (n, filename))
}

fn parse_part_content_type(headers: &str) -> Option<String> {
    for line in headers.lines() {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.trim().eq_ignore_ascii_case("content-type") {
            let value = value.trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

/// Extract a `param="value"` from a header line.
fn extract_quoted_param(line: &str, param: &str) -> Option<String> {
    let needle = format!("{param}=\"");
    let lower = line.to_ascii_lowercase();
    let idx = lower.find(&needle)?;
    let rest = &line[idx + needle.len()..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build_multipart(boundary: &str, fields: &[(&str, Option<&str>, &str)]) -> String {
        // fields: (name, filename, value). filename=None → text field.
        let mut out = String::new();
        for (name, filename, value) in fields {
            out.push_str(&format!("--{boundary}\r\n"));
            if let Some(fname) = filename {
                out.push_str(&format!(
                    "Content-Disposition: form-data; name=\"{name}\"; filename=\"{fname}\"\r\n"
                ));
                out.push_str("Content-Type: application/octet-stream\r\n\r\n");
            } else {
                out.push_str(&format!(
                    "Content-Disposition: form-data; name=\"{name}\"\r\n\r\n"
                ));
            }
            out.push_str(value);
            out.push_str("\r\n");
        }
        out.push_str(&format!("--{boundary}--\r\n"));
        out
    }

    #[test]
    fn extract_boundary_from_standard_content_type() {
        assert_eq!(
            extract_boundary("multipart/form-data; boundary=----WebKitFormBoundary7MA4YWxkTrZu0gW"),
            Some("----WebKitFormBoundary7MA4YWxkTrZu0gW".to_string())
        );
    }

    #[test]
    fn extract_boundary_from_quoted_content_type() {
        assert_eq!(
            extract_boundary(r#"multipart/form-data; boundary="abc123""#),
            Some("abc123".to_string())
        );
    }

    #[test]
    fn extract_boundary_from_content_type_with_extra_params() {
        assert_eq!(
            extract_boundary(r#"multipart/form-data; charset=utf-8; boundary="abc123""#),
            Some("abc123".to_string())
        );
    }

    #[test]
    fn extract_boundary_rejects_non_multipart() {
        assert_eq!(extract_boundary("application/json"), None);
        assert_eq!(extract_boundary("text/plain"), None);
        assert_eq!(
            extract_boundary("text/plain; x=multipart/form-data; boundary=b"),
            None
        );
    }

    #[test]
    fn extract_model_field_from_multipart() {
        let boundary = "testboundary";
        let body = build_multipart(
            boundary,
            &[
                ("model", None, "whisper-1"),
                ("file", Some("audio.mp3"), "binary-data-here"),
            ],
        );
        let content_type = format!("multipart/form-data; boundary={boundary}");
        let model = extract_multipart_field(body.as_bytes(), &content_type, "model");
        assert_eq!(model, Some("whisper-1".to_string()));
    }

    #[test]
    fn extract_text_field_with_binary_file_part() {
        let boundary = "bin";
        let mut body = Vec::new();
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        body.extend_from_slice(b"Content-Disposition: form-data; name=\"model\"\r\n\r\n");
        body.extend_from_slice(b"whisper-1\r\n");
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        body.extend_from_slice(
            b"Content-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\n",
        );
        body.extend_from_slice(b"Content-Type: audio/wav\r\n\r\n");
        body.extend_from_slice(&[0xff, 0xfe, 0x00, b'\r', b'\n', b'-', b'-', b'n', b'o']);
        body.extend_from_slice(b"\r\n");
        body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());

        let content_type = format!("multipart/form-data; boundary={boundary}");
        assert_eq!(
            extract_multipart_field(&body, &content_type, "model"),
            Some("whisper-1".to_string())
        );
    }

    #[test]
    fn extract_field_skips_file_parts() {
        let boundary = "b";
        let body = build_multipart(
            boundary,
            &[
                ("file", Some("audio.wav"), "fake-audio-bytes"),
                ("model", None, "gpt-4o"),
            ],
        );
        let content_type = format!("multipart/form-data; boundary={boundary}");
        // "file" is a filename part; extracting it as text returns None
        // (skipped), while "model" text field is found.
        assert_eq!(
            extract_multipart_field(body.as_bytes(), &content_type, "file"),
            None
        );
        assert_eq!(
            extract_multipart_field(body.as_bytes(), &content_type, "model"),
            Some("gpt-4o".to_string())
        );
    }

    #[test]
    fn extract_file_part_preserves_binary_bytes() {
        let boundary = "b";
        let bytes = [0xff, 0x00, 0x7f, b'\r', b'\n', b'-', b'-', b'x'];
        let mut body = Vec::new();
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        body.extend_from_slice(b"Content-Disposition: form-data; name=\"model\"\r\n\r\n");
        body.extend_from_slice(b"whisper-1\r\n");
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        body.extend_from_slice(
            b"Content-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\n",
        );
        body.extend_from_slice(b"Content-Type: audio/wav\r\n\r\n");
        body.extend_from_slice(&bytes);
        body.extend_from_slice(b"\r\n");
        body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());

        let content_type = format!("multipart/form-data; boundary={boundary}");
        let file = extract_multipart_file(&body, &content_type, "file").unwrap();

        assert_eq!(file.filename, "audio.wav");
        assert_eq!(file.content_type.as_deref(), Some("audio/wav"));
        assert_eq!(file.bytes, bytes);
    }

    #[test]
    fn extract_multiple_file_parts_preserves_order_and_indexed_names() {
        let boundary = "images";
        let body = build_multipart(
            boundary,
            &[
                ("image[]", Some("one.png"), "one"),
                ("image[]", Some("two.png"), "two"),
                ("image[2]", Some("three.png"), "three"),
            ],
        );
        let content_type = format!("multipart/form-data; boundary={boundary}");

        let exact = extract_multipart_files(body.as_bytes(), &content_type, "image[]");
        assert_eq!(
            exact
                .iter()
                .map(|file| file.filename.as_str())
                .collect::<Vec<_>>(),
            ["one.png", "two.png"]
        );
        let indexed = extract_multipart_files_with_prefix(body.as_bytes(), &content_type, "image[");
        assert_eq!(indexed.len(), 3);
        assert_eq!(indexed[2].bytes, b"three");
    }

    #[test]
    fn bounded_file_extraction_rejects_the_first_excess_part() {
        let boundary = "bounded-images";
        let fields = (0..17)
            .map(|_| ("image[]", Some("image.png"), "x"))
            .collect::<Vec<_>>();
        let body = build_multipart(boundary, &fields);
        let content_type = format!("multipart/form-data; boundary={boundary}");

        assert_eq!(
            extract_multipart_files_bounded(body.as_bytes(), &content_type, "image[]", 16),
            Err(MultipartFilesError::TooManyFiles { max_files: 16 })
        );
    }

    #[test]
    fn bounded_file_extraction_rejects_oversized_part_headers() {
        let boundary = "oversized-headers";
        let body = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{}\"\r\n\r\nx\r\n--{boundary}--\r\n",
            "a".repeat(MAX_MULTIPART_PART_HEADER_BYTES)
        );
        let content_type = format!("multipart/form-data; boundary={boundary}");

        assert_eq!(
            extract_multipart_files_bounded(body.as_bytes(), &content_type, "image", 16),
            Err(MultipartFilesError::PartHeadersTooLarge)
        );
        assert_eq!(
            extract_multipart_field(body.as_bytes(), &content_type, "model"),
            None
        );
    }

    #[test]
    fn extract_nonexistent_field_returns_none() {
        let boundary = "b";
        let body = build_multipart(boundary, &[("model", None, "whisper-1")]);
        let content_type = format!("multipart/form-data; boundary={boundary}");
        assert_eq!(
            extract_multipart_field(body.as_bytes(), &content_type, "prompt"),
            None
        );
    }

    #[test]
    fn extract_from_empty_body_returns_none() {
        let content_type = "multipart/form-data; boundary=b";
        assert_eq!(extract_multipart_field(b"", content_type, "model"), None);
    }

    #[test]
    fn extract_multiple_text_fields() {
        let boundary = "b";
        let body = build_multipart(
            boundary,
            &[
                ("model", None, "whisper-1"),
                ("response_format", None, "json"),
                ("language", None, "en"),
                ("file", Some("a.mp3"), "audio"),
            ],
        );
        let content_type = format!("multipart/form-data; boundary={boundary}");
        assert_eq!(
            extract_multipart_field(body.as_bytes(), &content_type, "model"),
            Some("whisper-1".to_string())
        );
        assert_eq!(
            extract_multipart_field(body.as_bytes(), &content_type, "response_format"),
            Some("json".to_string())
        );
        assert_eq!(
            extract_multipart_field(body.as_bytes(), &content_type, "language"),
            Some("en".to_string())
        );
    }

    #[test]
    fn extract_handles_value_with_special_chars() {
        let boundary = "b";
        // Value containing spaces and punctuation.
        let body = build_multipart(
            boundary,
            &[("prompt", None, "Transcribe this: hello world!")],
        );
        let content_type = format!("multipart/form-data; boundary={boundary}");
        assert_eq!(
            extract_multipart_field(body.as_bytes(), &content_type, "prompt"),
            Some("Transcribe this: hello world!".to_string())
        );
    }
}
