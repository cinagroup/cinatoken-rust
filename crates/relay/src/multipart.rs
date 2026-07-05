//! Lightweight multipart/form-data field extraction.
//!
//! Used by the upload relay endpoints (`/v1/audio/transcriptions`,
//! `/v1/audio/translations`, `/v1/images/edits`) to pull the `model` form
//! field out of the request so the relay can authenticate, route, and bill
//! the request. The full multipart body is forwarded to the upstream
//! verbatim; this module only reads the text fields the gateway needs.
//!
//! This is intentionally NOT a full multipart parser. It does not decode
//! base64 or quoted-printable, and it does not validate the body against RFC
//! 7578. It finds parts by scanning for boundary delimiters and parses the
//! ASCII headers each part needs. The body itself is scanned as bytes so real
//! binary uploads can still expose nearby text fields such as `model`.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MultipartFile<'a> {
    pub filename: String,
    pub content_type: Option<String>,
    pub bytes: &'a [u8],
}

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
    let separator = b"\r\n\r\n";
    let header_end = find_subslice_from(part, separator, 0)?;
    let headers = std::str::from_utf8(&part[..header_end]).ok()?;
    Some((headers, &part[header_end + separator.len()..]))
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
