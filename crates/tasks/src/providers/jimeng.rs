//! Pure response parser + Volcengine request signing for the Jimeng (ByteDance)
//! video task provider, ported from `relay/channel/task/jimeng/adaptor.go`
//! (`ParseTaskResult` and `signRequest`).

use crate::{TaskInfo, TaskStatus};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

type HmacSha256 = Hmac<Sha256>;

#[derive(Deserialize, Default)]
struct ResponseTask {
    #[serde(default)]
    code: i64,
    #[serde(default)]
    message: String,
    #[serde(default)]
    data: DataField,
}

#[derive(Deserialize, Default)]
struct DataField {
    #[serde(default)]
    status: String,
    #[serde(default)]
    video_url: String,
}

/// Map a Jimeng poll response onto a [`TaskInfo`]. A `code` other than the
/// success sentinel `10000` carries the error code and message as a failure.
/// Then the inner `data.status` switch recognizes only `in_queue` (queued, 10%)
/// and `done` (success, 100%) — any other status leaves whatever the code gate
/// produced. `data.video_url` is always copied to the URL (Go sets it
/// unconditionally after the switch).
///
/// Faithful quirks: when `code != 10000` but `data.status` is `done`/`in_queue`,
/// the switch overrides the failure status (Go runs the switch unconditionally).
/// When `code == 10000` but `data.status` is unrecognized, Go leaves the empty
/// zero-value status; this port uses [`TaskStatus::Unknown`] (same no-op).
pub fn parse_task_result(resp_body: &[u8]) -> Result<TaskInfo, String> {
    let resp: ResponseTask = serde_json::from_slice(resp_body)
        .map_err(|err| format!("unmarshal task result failed: {err}"))?;

    let mut code = 0;
    let mut reason = String::new();
    let mut status = TaskStatus::Unknown;
    let mut progress = String::new();
    if resp.code != 10000 {
        code = resp.code;
        reason = resp.message;
        status = TaskStatus::Failure;
        progress = "100%".to_string();
    }

    match resp.data.status.as_str() {
        "in_queue" => {
            status = TaskStatus::Queued;
            progress = "10%".to_string();
        }
        "done" => {
            status = TaskStatus::Success;
            progress = "100%".to_string();
        }
        _ => {}
    }

    Ok(TaskInfo {
        code,
        task_id: String::new(),
        status,
        reason,
        url: resp.data.video_url,
        remote_url: String::new(),
        progress,
        completion_tokens: 0,
        total_tokens: 0,
    })
}

/// The headers a signed Jimeng request must carry, produced by [`sign_request`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedHeaders {
    pub host: String,
    pub x_date: String,
    pub x_content_sha256: String,
    pub authorization: String,
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex_encode(&Sha256::digest(bytes))
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("hmac accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

/// Percent-encode a query component the way Go's `url.QueryEscape` does:
/// alphanumerics and `-_.~` pass through, space becomes `+`, everything else is
/// `%XX` (uppercase hex).
fn query_escape(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Sign a Jimeng (Volcengine) request — a faithful port of Go `signRequest`
/// (AWS-SigV4-style: SHA-256 payload hash → canonical request → credential-scoped
/// HMAC key-derivation chain → signature). `x_date` (`YYYYMMDDTHHMMSSZ`) and
/// `short_date` (`YYYYMMDD`) are passed in (the Worker formats `now` in UTC) so
/// the signing is pure and testable. `region`/`service` are fixed to Volcengine
/// CV (`cn-north-1`/`cv`). Returns the `Host`/`X-Date`/`X-Content-Sha256`/
/// `Authorization` headers to set on the outbound request.
#[allow(clippy::too_many_arguments)]
pub fn sign_request(
    method: &str,
    host: &str,
    path: &str,
    query_pairs: &[(String, String)],
    content_type: Option<&str>,
    body: &[u8],
    access_key: &str,
    secret_key: &str,
    x_date: &str,
    short_date: &str,
) -> SignedHeaders {
    let hex_payload_hash = sha256_hex(body);

    // Canonical query: group by key, sort keys then values, escape, join.
    let mut grouped: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for (key, value) in query_pairs {
        grouped
            .entry(key.as_str())
            .or_default()
            .push(value.as_str());
    }
    let mut query_parts = Vec::new();
    for (key, mut values) in grouped {
        values.sort_unstable();
        for value in values {
            query_parts.push(format!("{}={}", query_escape(key), query_escape(value)));
        }
    }
    let canonical_query = query_parts.join("&");

    // Headers to sign (BTreeMap keeps them sorted, as Go sorts signedHeaderKeys).
    let mut headers: BTreeMap<&str, String> = BTreeMap::new();
    headers.insert("host", host.to_string());
    headers.insert("x-date", x_date.to_string());
    headers.insert("x-content-sha256", hex_payload_hash.clone());
    if let Some(ct) = content_type {
        if !ct.is_empty() {
            headers.insert("content-type", ct.to_string());
        }
    }
    let mut canonical_headers = String::new();
    let mut signed_keys = Vec::new();
    for (key, value) in &headers {
        canonical_headers.push_str(key);
        canonical_headers.push(':');
        canonical_headers.push_str(value.trim());
        canonical_headers.push('\n');
        signed_keys.push(*key);
    }
    let signed_headers = signed_keys.join(";");

    let canonical_request = format!(
        "{method}\n{path}\n{canonical_query}\n{canonical_headers}\n{signed_headers}\n{hex_payload_hash}"
    );
    let hex_hashed = sha256_hex(canonical_request.as_bytes());

    let region = "cn-north-1";
    let service = "cv";
    let credential_scope = format!("{short_date}/{region}/{service}/request");
    let string_to_sign = format!("HMAC-SHA256\n{x_date}\n{credential_scope}\n{hex_hashed}");

    let k_date = hmac_sha256(secret_key.as_bytes(), short_date.as_bytes());
    let k_region = hmac_sha256(&k_date, region.as_bytes());
    let k_service = hmac_sha256(&k_region, service.as_bytes());
    let k_signing = hmac_sha256(&k_service, b"request");
    let signature = hex_encode(&hmac_sha256(&k_signing, string_to_sign.as_bytes()));

    let authorization = format!(
        "HMAC-SHA256 Credential={access_key}/{credential_scope}, SignedHeaders={signed_headers}, Signature={signature}"
    );

    SignedHeaders {
        host: host.to_string(),
        x_date: x_date.to_string(),
        x_content_sha256: hex_payload_hash,
        authorization,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_request_matches_go_ground_truth() {
        // Ground truth captured from the Go signRequest (relay/channel/task/
        // jimeng) with these exact fixed inputs.
        let signed = sign_request(
            "POST",
            "visual.volcengineapi.com",
            "/",
            &[
                ("Action".to_string(), "CVSync2AsyncGetResult".to_string()),
                ("Version".to_string(), "2022-08-31".to_string()),
            ],
            Some("application/json"),
            br#"{"req_key":"jimeng_vgfm_t2v_l20","task_id":"abc"}"#,
            "AKTEST",
            "SKTEST",
            "20240115T120000Z",
            "20240115",
        );
        assert_eq!(
            signed.x_content_sha256,
            "2e83d6a6ed2aef0fb0dd7125abe5bad97718ec9bd6be63d52418921ea3133955"
        );
        assert_eq!(
            signed.authorization,
            "HMAC-SHA256 Credential=AKTEST/20240115/cn-north-1/cv/request, \
             SignedHeaders=content-type;host;x-content-sha256;x-date, \
             Signature=5cbe194cc35a9fe8a0dcf34cbfc8f10d2c989caa3059aa6fe4f186977c0fef7a"
        );
        assert_eq!(signed.host, "visual.volcengineapi.com");
        assert_eq!(signed.x_date, "20240115T120000Z");
    }

    #[test]
    fn query_escape_matches_go() {
        assert_eq!(
            query_escape("CVSync2AsyncGetResult"),
            "CVSync2AsyncGetResult"
        );
        assert_eq!(query_escape("2022-08-31"), "2022-08-31");
        assert_eq!(query_escape("a b"), "a+b");
        assert_eq!(query_escape("a/b=c"), "a%2Fb%3Dc");
    }

    #[test]
    fn success_code_with_known_states() {
        let info = parse_task_result(br#"{"code":10000,"data":{"status":"in_queue"}}"#).unwrap();
        assert_eq!(info.status, TaskStatus::Queued);
        assert_eq!(info.progress, "10%");
        assert_eq!(info.code, 0);

        let info = parse_task_result(
            br#"{"code":10000,"data":{"status":"done","video_url":"https://cdn/v.mp4"}}"#,
        )
        .unwrap();
        assert_eq!(info.status, TaskStatus::Success);
        assert_eq!(info.progress, "100%");
        assert_eq!(info.url, "https://cdn/v.mp4");
    }

    #[test]
    fn error_code_is_failure() {
        let info =
            parse_task_result(br#"{"code":50500,"message":"quota exhausted","data":{}}"#).unwrap();
        assert_eq!(info.status, TaskStatus::Failure);
        assert_eq!(info.progress, "100%");
        assert_eq!(info.code, 50500);
        assert_eq!(info.reason, "quota exhausted");
    }

    #[test]
    fn switch_overrides_error_code_when_state_is_terminal() {
        // Faithful quirk: the unconditional switch promotes an error-coded
        // response to success when data.status is "done".
        let info = parse_task_result(br#"{"code":50000,"data":{"status":"done"}}"#).unwrap();
        assert_eq!(info.status, TaskStatus::Success);
        assert_eq!(info.progress, "100%");
        assert_eq!(info.code, 50000); // code passthrough is unchanged
    }

    #[test]
    fn success_code_unknown_state_is_unknown_no_op() {
        let info = parse_task_result(br#"{"code":10000,"data":{"status":"weird"}}"#).unwrap();
        assert_eq!(info.status, TaskStatus::Unknown);
        assert!(info.progress.is_empty());
    }
}
