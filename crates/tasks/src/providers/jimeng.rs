//! Pure response parser + Volcengine request signing for the Jimeng (ByteDance)
//! video task provider, ported from `relay/channel/task/jimeng/adaptor.go`
//! (`ParseTaskResult` and `signRequest`).

use crate::taskcommon::merge_metadata;
use crate::{TaskInfo, TaskStatus, TaskSubmitReq};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
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

#[derive(Deserialize, Default)]
struct SubmitResponse {
    #[serde(default)]
    code: i64,
    #[serde(default)]
    message: String,
    #[serde(default)]
    data: SubmitData,
}

#[derive(Deserialize, Default)]
struct SubmitData {
    #[serde(default)]
    task_id: String,
}

/// Extract the upstream task id from a Jimeng submit response (Go `DoResponse`):
/// success is the sentinel code `10000`, otherwise the upstream `message` is
/// returned as the error. Go does not reject an empty `data.task_id`, so this
/// port returns it verbatim.
pub fn parse_submit_response(resp_body: &[u8]) -> Result<String, String> {
    parse_submit_response_classified(resp_body).map_err(super::SubmitResponseFailure::into_message)
}

pub fn parse_submit_response_classified(
    resp_body: &[u8],
) -> Result<String, super::SubmitResponseFailure> {
    let resp: SubmitResponse = serde_json::from_slice(resp_body).map_err(|err| {
        super::SubmitResponseFailure::Unknown(format!("unmarshal_response_body_failed: {err}"))
    })?;
    if resp.code != 10000 {
        return Err(super::SubmitResponseFailure::Rejected(resp.message));
    }
    Ok(resp.data.task_id)
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

/// Convert a unix-seconds timestamp to the two UTC date strings the Volcengine
/// SigV4 signing needs: `x_date` (`YYYYMMDDTHHMMSSZ`, Go `t.Format("20060102T150405Z")`)
/// and `short_date` (`YYYYMMDD`). Pure (no clock) so it is host-testable; the
/// Worker supplies `now`. Uses Howard Hinnant's civil-from-days algorithm.
pub fn format_volcengine_dates(unix_seconds: i64) -> (String, String) {
    let days = unix_seconds.div_euclid(86400);
    let secs = unix_seconds.rem_euclid(86400);
    let (hour, minute, second) = (secs / 3600, (secs % 3600) / 60, secs % 60);

    // civil_from_days: days since 1970-01-01 -> (year, month, day).
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as i64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let day = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let month = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let year = if month <= 2 { year + 1 } else { year };

    let x_date = format!("{year:04}{month:02}{day:02}T{hour:02}{minute:02}{second:02}Z");
    let short_date = format!("{year:04}{month:02}{day:02}");
    (x_date, short_date)
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

/// The Jimeng submit payload. The transform sets req_key/prompt/frames and one
/// of image_urls / binary_data_base64; other fields (seed, aspect_ratio, …)
/// arrive via metadata (carried in `extra`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RequestPayload {
    req_key: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    prompt: String,
    #[serde(default, skip_serializing_if = "is_zero")]
    frames: i64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    image_urls: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    binary_data_base64: Vec<String>,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

fn is_zero(value: &i64) -> bool {
    *value == 0
}

/// Build the Jimeng submit payload — a port of `convertToRequestPayload`.
/// `req_key` is the upstream model, frames is 241 for a 10s duration else 121,
/// images route to `image_urls` (http) or `binary_data_base64` (otherwise), and
/// metadata is merged (model stripped). Finally the jimeng_v30 family `req_key`
/// is remapped by image count: `_pro` → `jimeng_ti2v_v30_pro`; >1 image →
/// `jimeng_i2v_first_tail_v30`; 1 image → `jimeng_i2v_first_v30`; none →
/// `jimeng_t2v_v30` (the i2v forms strip one trailing `p`, matching Go's
/// TrimSuffix).
pub fn convert_to_request_payload(
    req: &TaskSubmitReq,
    upstream_model: &str,
) -> Result<RequestPayload, String> {
    let frames = if req.duration == 10 { 241 } else { 121 };
    let mut image_urls = Vec::new();
    let mut binary_data_base64 = Vec::new();
    if req.has_image() {
        if req.images[0].starts_with("http") {
            image_urls = req.images.clone();
        } else {
            binary_data_base64 = req.images.clone();
        }
    }

    let mut payload = RequestPayload {
        req_key: upstream_model.to_string(),
        prompt: req.prompt.clone(),
        frames,
        image_urls,
        binary_data_base64,
        extra: Map::new(),
    };

    if let Some(metadata) = &req.metadata {
        let mut value = serde_json::to_value(&payload).map_err(|err| err.to_string())?;
        merge_metadata(&mut value, metadata);
        payload = serde_json::from_value(value).map_err(|err| err.to_string())?;
    }

    if payload.req_key.contains("jimeng_v30") {
        let image_len = req
            .images
            .len()
            .max(payload.binary_data_base64.len())
            .max(payload.image_urls.len());
        payload.req_key = if payload.req_key == "jimeng_v30_pro" {
            "jimeng_ti2v_v30_pro".to_string()
        } else if image_len > 1 {
            trim_one_trailing_p(&payload.req_key.replacen(
                "jimeng_v30",
                "jimeng_i2v_first_tail_v30",
                1,
            ))
        } else if image_len == 1 {
            trim_one_trailing_p(
                &payload
                    .req_key
                    .replacen("jimeng_v30", "jimeng_i2v_first_v30", 1),
            )
        } else {
            payload.req_key.replacen("jimeng_v30", "jimeng_t2v_v30", 1)
        };
    }

    Ok(payload)
}

/// Remove a single trailing `p` if present (Go `strings.TrimSuffix(_, "p")`).
fn trim_one_trailing_p(value: &str) -> String {
    value.strip_suffix('p').unwrap_or(value).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_payload_frames_images_and_reqkey_remap() {
        use serde_json::json;

        // Text, 5s -> frames 121; req_key = upstream model.
        let req = TaskSubmitReq {
            prompt: "p".to_string(),
            ..Default::default()
        };
        let value =
            serde_json::to_value(convert_to_request_payload(&req, "jimeng_xx").unwrap()).unwrap();
        assert_eq!(
            value,
            json!({"req_key": "jimeng_xx", "prompt": "p", "frames": 121})
        );

        // 10s -> frames 241; http image -> image_urls.
        let req = TaskSubmitReq {
            duration: 10,
            images: vec!["http://i/1.png".to_string()],
            ..Default::default()
        };
        let value =
            serde_json::to_value(convert_to_request_payload(&req, "jimeng_xx").unwrap()).unwrap();
        assert_eq!(value["frames"], json!(241));
        assert_eq!(value["image_urls"], json!(["http://i/1.png"]));

        // v30 remap: no image -> t2v; 1 image -> i2v_first (trim p); pro -> ti2v.
        let no_img = TaskSubmitReq::default();
        assert_eq!(
            convert_to_request_payload(&no_img, "jimeng_v30")
                .unwrap()
                .req_key,
            "jimeng_t2v_v30"
        );
        let one_img = TaskSubmitReq {
            images: vec!["data:abc".to_string()],
            ..Default::default()
        };
        assert_eq!(
            convert_to_request_payload(&one_img, "jimeng_v30p")
                .unwrap()
                .req_key,
            "jimeng_i2v_first_v30"
        );
        assert_eq!(
            convert_to_request_payload(&no_img, "jimeng_v30_pro")
                .unwrap()
                .req_key,
            "jimeng_ti2v_v30_pro"
        );
    }

    #[test]
    fn volcengine_dates_format() {
        // 2024-01-15 12:00:00 UTC = 1_705_320_000 (the sign_request ground-truth time).
        assert_eq!(
            format_volcengine_dates(1_705_320_000),
            ("20240115T120000Z".to_string(), "20240115".to_string())
        );
        // Unix epoch.
        assert_eq!(
            format_volcengine_dates(0),
            ("19700101T000000Z".to_string(), "19700101".to_string())
        );
        // A leap-day afternoon: 2020-02-29 23:59:59 UTC = 1_583_020_799.
        assert_eq!(format_volcengine_dates(1_583_020_799).0, "20200229T235959Z");
    }

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
    fn submit_returns_task_id_or_message_on_error() {
        assert_eq!(
            parse_submit_response(br#"{"code":10000,"data":{"task_id":"jm_77"}}"#).unwrap(),
            "jm_77"
        );
        assert_eq!(
            parse_submit_response(br#"{"code":50500,"message":"quota exhausted"}"#).unwrap_err(),
            "quota exhausted"
        );
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
