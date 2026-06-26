//! Lightweight multipart/form-data field extraction.
//!
//! Used by the upload relay endpoints (`/v1/audio/transcriptions`,
//! `/v1/audio/translations`, `/v1/images/edits`) to pull the `model` form
//! field out of the request so the relay can authenticate, route, and bill
//! the request. The full multipart body is forwarded to the upstream
//! verbatim; this module only reads the text fields the gateway needs.
//!
//! This is intentionally NOT a full multipart parser. It does not decode
//! file parts, base64, or quoted-printable; it does not validate the body
//! against RFC 7578. It finds text fields by scanning for the boundary and
//! the `Content-Disposition` header, which is sufficient for the gateway's
//! model-extraction need and avoids pulling in a full multipart crate.

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

/// Extract the `boundary` parameter from a `multipart/form-data;
/// boundary=...` Content-Type header. Returns the raw boundary value
/// (without the leading `--`).
pub fn extract_boundary(content_type: &str) -> Option<String> {
    let lower = content_type.to_ascii_lowercase();
    if !lower.contains("multipart/form-data") {
        return None;
    }
    let boundary_marker = "boundary=";
    let idx = lower.find(boundary_marker)?;
    let rest = &content_type[idx + boundary_marker.len()..];
    // Boundary may be quoted ("...") or followed by other parameters (;).
    let boundary = if let Some(stripped) = rest.strip_prefix('"') {
        let end = stripped.find('"')?;
        &stripped[..end]
    } else {
        rest.split(';').next()?
    };
    let boundary = boundary.trim();
    if boundary.is_empty() {
        None
    } else {
        Some(boundary.to_string())
    }
}

fn extract_field_with_boundary(body: &[u8], boundary: &str, field_name: &str) -> Option<String> {
    let body_str = std::str::from_utf8(body).ok()?;
    let closing = format!("--{boundary}--");
    // Truncate at the closing boundary so the last part doesn't carry
    // trailing closing-delimiter bytes.
    let body_str = match body_str.find(&closing) {
        Some(idx) => &body_str[..idx],
        None => body_str,
    };

    let first_delim = format!("--{boundary}\r\n");
    let after_first = body_str.find(&first_delim)?;
    let remainder = &body_str[after_first + first_delim.len()..];

    // Split on `\r\n--{boundary}\r\n` to get individual parts.
    let delimiter = format!("\r\n--{boundary}\r\n");
    for raw_part in remainder.split(&delimiter) {
        if raw_part.is_empty() {
            continue;
        }
        // Each part: headers \r\n\r\n body
        let (headers, part_body) = match raw_part.split_once("\r\n\r\n") {
            Some(split) => split,
            None => continue,
        };
        // Parse Content-Disposition to find name="field" and skip files.
        if let Some((name, is_file)) = parse_content_disposition(headers) {
            if is_file {
                continue;
            }
            if name == field_name {
                // The part value has a trailing `\r\n` that belongs to the
                // next delimiter framing. Strip exactly one CRLF.
                let value = part_body.strip_suffix("\r\n").unwrap_or(part_body);
                return Some(value.to_string());
            }
        }
    }
    None
}

/// Parse a `Content-Disposition: form-data; name="field"[; filename="..."]`
/// header block. Returns `(name, is_file)`.
fn parse_content_disposition(headers: &str) -> Option<(String, bool)> {
    let mut name: Option<String> = None;
    let mut is_file = false;
    for line in headers.lines() {
        let lower = line.to_ascii_lowercase();
        if !lower.starts_with("content-disposition:") {
            continue;
        }
        // Extract name="..." and filename="..." via simple scanning.
        if let Some(n) = extract_quoted_param(line, "name") {
            name = Some(n);
        }
        if extract_quoted_param(line, "filename").is_some() {
            is_file = true;
        }
        break;
    }
    name.map(|n| (n, is_file))
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
    fn extract_boundary_rejects_non_multipart() {
        assert_eq!(extract_boundary("application/json"), None);
        assert_eq!(extract_boundary("text/plain"), None);
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
