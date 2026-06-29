//! Pure response parser for the Kling video task provider, ported from
//! `relay/channel/task/kling/adaptor.go` (`ParseTaskResult`).

use crate::{TaskInfo, TaskStatus};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

#[derive(Serialize)]
struct JwtClaims<'a> {
    exp: i64,
    iss: &'a str,
    nbf: i64,
}

/// Build the Kling API JWT — a port of Go `createJWTTokenWithKey`.
///
/// A key starting with `sk-` is a new-api relay key, returned verbatim.
/// Otherwise the key is `accessKey|secretKey` and this mints an HS256 JWT with
/// `iss = accessKey`, `exp = now + 1800`, `nbf = now - 5`, signed with
/// `secretKey`. `now` is unix seconds, supplied by the caller (the Worker reads
/// the clock; keeping it a parameter makes this pure and testable). The header
/// and claims are serialized with alphabetically-ordered keys to match Go's
/// `encoding/json` map marshaling, so the signature is reproducible.
pub fn create_jwt_token(api_key: &str, now: i64) -> Result<String, String> {
    if api_key.starts_with("sk-") {
        return Ok(api_key.to_string());
    }
    let parts: Vec<&str> = api_key.split('|').collect();
    if parts.len() != 2 {
        return Err("invalid api_key, required format is accessKey|secretKey".to_string());
    }
    let access_key = parts[0].trim();
    let secret_key = parts[1].trim();

    let header_b64 = URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256","typ":"JWT"}"#);
    let claims = JwtClaims {
        exp: now + 1800,
        iss: access_key,
        nbf: now - 5,
    };
    let claims_json = serde_json::to_vec(&claims).map_err(|err| err.to_string())?;
    let claims_b64 = URL_SAFE_NO_PAD.encode(&claims_json);

    let signing_input = format!("{header_b64}.{claims_b64}");
    let mut mac =
        HmacSha256::new_from_slice(secret_key.as_bytes()).map_err(|err| err.to_string())?;
    mac.update(signing_input.as_bytes());
    let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());

    Ok(format!("{signing_input}.{signature}"))
}

#[derive(Deserialize, Default)]
struct Response {
    #[serde(default)]
    code: i64,
    #[serde(default)]
    data: Data,
}

#[derive(Deserialize, Default)]
struct Data {
    #[serde(default)]
    task_id: String,
    #[serde(default)]
    task_status: String,
    #[serde(default)]
    task_status_msg: String,
    #[serde(default)]
    task_result: TaskResult,
    #[serde(default)]
    final_unit_deduction: String,
}

#[derive(Deserialize, Default)]
struct TaskResult {
    #[serde(default)]
    videos: Vec<Video>,
}

#[derive(Deserialize, Default)]
struct Video {
    #[serde(default)]
    url: String,
}

/// Map a Kling poll response onto a [`TaskInfo`]. The upstream `task_status`
/// vocabulary is `submitted` / `processing` / `succeed` / `failed`; anything
/// else is an error (mirroring Go's `unknown task status` fallback). On
/// `succeed`, the first video URL is captured and `final_unit_deduction` is
/// parsed as a float and ceil'd into the actual token charge — but only when it
/// is positive, matching Go (`if rounded > 0`).
pub fn parse_task_result(resp_body: &[u8]) -> Result<TaskInfo, String> {
    let resp: Response = serde_json::from_slice(resp_body)
        .map_err(|err| format!("failed to unmarshal response body: {err}"))?;
    let data = resp.data;

    let mut url = String::new();
    let mut tokens = 0i64;
    let status = match data.task_status.as_str() {
        "submitted" => TaskStatus::Submitted,
        "processing" => TaskStatus::InProgress,
        "succeed" => {
            if let Some(video) = data.task_result.videos.first() {
                url = video.url.clone();
            }
            if let Ok(value) = data.final_unit_deduction.parse::<f64>() {
                let rounded = value.ceil() as i64;
                if rounded > 0 {
                    tokens = rounded;
                }
            }
            TaskStatus::Success
        }
        "failed" => TaskStatus::Failure,
        other => return Err(format!("unknown task status: {other}")),
    };

    Ok(TaskInfo {
        code: resp.code,
        task_id: data.task_id,
        status,
        reason: data.task_status_msg,
        url,
        remote_url: String::new(),
        progress: String::new(),
        completion_tokens: tokens,
        total_tokens: tokens,
    })
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

/// Extract the upstream task id from a Kling submit response (Go `DoResponse`): a
/// non-zero `code` is an error (carrying `message`), otherwise return
/// `data.task_id`.
pub fn parse_submit_response(resp_body: &[u8]) -> Result<String, String> {
    let resp: SubmitResponse = serde_json::from_slice(resp_body)
        .map_err(|err| format!("unmarshal_response_failed: {err}"))?;
    if resp.code != 0 {
        return Err(resp.message);
    }
    Ok(resp.data.task_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jwt_passthrough_for_new_api_relay_key() {
        assert_eq!(create_jwt_token("sk-abc123", 1000).unwrap(), "sk-abc123");
    }

    #[test]
    fn jwt_requires_access_secret_format() {
        assert_eq!(
            create_jwt_token("onlyone", 1000).unwrap_err(),
            "invalid api_key, required format is accessKey|secretKey"
        );
    }

    #[test]
    fn jwt_structure_and_signature_round_trip() {
        let token = create_jwt_token("AK123|SECRET", 1_000_000).unwrap();
        let parts: Vec<&str> = token.split('.').collect();
        assert_eq!(parts.len(), 3, "header.payload.signature");

        // Header matches Go's sorted-key marshaling.
        let header = URL_SAFE_NO_PAD.decode(parts[0]).unwrap();
        assert_eq!(header, br#"{"alg":"HS256","typ":"JWT"}"#);

        // Claims carry iss/exp/nbf with the Go offsets.
        let claims = URL_SAFE_NO_PAD.decode(parts[1]).unwrap();
        assert_eq!(
            String::from_utf8(claims).unwrap(),
            r#"{"exp":1001800,"iss":"AK123","nbf":999995}"#
        );

        // Signature verifies: recompute HMAC-SHA256 over header.payload with the
        // secret and compare.
        let signing_input = format!("{}.{}", parts[0], parts[1]);
        let mut mac = HmacSha256::new_from_slice(b"SECRET").unwrap();
        mac.update(signing_input.as_bytes());
        let expected = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        assert_eq!(parts[2], expected);
    }

    #[test]
    fn jwt_trims_key_parts() {
        // Surrounding whitespace in the key parts is trimmed (Go TrimSpace).
        let token = create_jwt_token(" AK | SECRET ", 1_000_000).unwrap();
        let parts: Vec<&str> = token.split('.').collect();
        let claims = URL_SAFE_NO_PAD.decode(parts[1]).unwrap();
        assert_eq!(
            String::from_utf8(claims).unwrap(),
            r#"{"exp":1001800,"iss":"AK","nbf":999995}"#
        );
        // Signed with the trimmed secret.
        let signing_input = format!("{}.{}", parts[0], parts[1]);
        let mut mac = HmacSha256::new_from_slice(b"SECRET").unwrap();
        mac.update(signing_input.as_bytes());
        assert_eq!(
            parts[2],
            URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
        );
    }

    #[test]
    fn submit_returns_task_id_or_message_on_error() {
        assert_eq!(
            parse_submit_response(br#"{"code":0,"data":{"task_id":"k_77"}}"#).unwrap(),
            "k_77"
        );
        assert_eq!(
            parse_submit_response(br#"{"code":1,"message":"quota exceeded"}"#).unwrap_err(),
            "quota exceeded"
        );
    }

    #[test]
    fn submitted_and_processing_map_to_live_states() {
        let info =
            parse_task_result(br#"{"code":0,"data":{"task_id":"t1","task_status":"submitted"}}"#)
                .unwrap();
        assert_eq!(info.status, TaskStatus::Submitted);
        assert_eq!(info.task_id, "t1");
        assert_eq!(info.completion_tokens, 0);
        assert!(info.url.is_empty());

        let info = parse_task_result(br#"{"data":{"task_status":"processing"}}"#).unwrap();
        assert_eq!(info.status, TaskStatus::InProgress);
    }

    #[test]
    fn succeed_extracts_url_and_ceils_deduction() {
        let body = br#"{
            "code": 0,
            "data": {
                "task_id": "abc",
                "task_status": "succeed",
                "task_status_msg": "ok",
                "task_result": { "videos": [ {"url": "https://cdn/v1.mp4"} ] },
                "final_unit_deduction": "3.2"
            }
        }"#;
        let info = parse_task_result(body).unwrap();
        assert_eq!(info.status, TaskStatus::Success);
        assert_eq!(info.url, "https://cdn/v1.mp4");
        assert_eq!(info.reason, "ok");
        // ceil(3.2) = 4, applied to both completion and total tokens.
        assert_eq!(info.completion_tokens, 4);
        assert_eq!(info.total_tokens, 4);
    }

    #[test]
    fn succeed_without_deduction_or_videos_is_zero_tokens() {
        let info = parse_task_result(br#"{"data":{"task_status":"succeed"}}"#).unwrap();
        assert_eq!(info.status, TaskStatus::Success);
        assert_eq!(info.completion_tokens, 0);
        assert!(info.url.is_empty());
    }

    #[test]
    fn non_positive_deduction_does_not_set_tokens() {
        // "0" ceils to 0, which fails the `> 0` guard, so tokens stay 0.
        let info =
            parse_task_result(br#"{"data":{"task_status":"succeed","final_unit_deduction":"0"}}"#)
                .unwrap();
        assert_eq!(info.completion_tokens, 0);
    }

    #[test]
    fn failed_maps_to_failure() {
        let info =
            parse_task_result(br#"{"data":{"task_status":"failed","task_status_msg":"boom"}}"#)
                .unwrap();
        assert_eq!(info.status, TaskStatus::Failure);
        assert_eq!(info.reason, "boom");
    }

    #[test]
    fn unknown_status_is_an_error() {
        let err = parse_task_result(br#"{"data":{"task_status":"weird"}}"#).unwrap_err();
        assert_eq!(err, "unknown task status: weird");
    }

    #[test]
    fn malformed_json_is_an_error() {
        let err = parse_task_result(b"not json").unwrap_err();
        assert!(err.starts_with("failed to unmarshal response body"));
    }
}
