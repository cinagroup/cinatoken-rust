//! Pure response parser for the Vertex AI (Veo) video task provider, ported
//! from `relay/channel/task/vertex/adaptor.go` (`ParseTaskResult`).
//!
//! Vertex returns a long-running-operation envelope: an `error.message` is a
//! failure, `done == false` is still in progress, and a completed operation
//! carries the video inline as base64, which the parser renders as a
//! `data:<mime>;base64,<payload>` URL. The payload may live in
//! `response.videos[0]`, `response.bytesBase64Encoded`, or `response.video`
//! (variant), checked in that order.

use crate::{TaskInfo, TaskStatus};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rsa::pkcs1v15::SigningKey;
use rsa::pkcs8::DecodePrivateKey;
use rsa::sha2::Sha256;
use rsa::signature::{SignatureEncoding, Signer};
use rsa::RsaPrivateKey;
use serde::{Deserialize, Serialize};

/// A GCP service-account credentials blob (the channel key for Vertex) — Go
/// `vertex.Credentials`.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct ServiceAccount {
    #[serde(default)]
    pub project_id: String,
    #[serde(default)]
    pub private_key: String,
    #[serde(default)]
    pub client_email: String,
}

#[derive(Serialize)]
struct JwtClaims<'a> {
    aud: &'a str,
    exp: i64,
    iat: i64,
    iss: &'a str,
    scope: &'a str,
}

/// Parse a service-account PKCS#8 private key, normalizing the PEM the way Go's
/// `createSignedJWT` does first: strip the armor + every newline form (including
/// the literal `\n` GCP JSON escapes), then re-wrap the base64 at 64 columns.
/// This tolerates the many ways the key arrives (escaped JSON, CRLFs, single
/// line) and satisfies Rust's strict RFC-7468 PKCS#8 parser.
fn parse_private_key(private_key_pem: &str) -> Result<RsaPrivateKey, String> {
    let cleaned: String = private_key_pem
        .replace("-----BEGIN PRIVATE KEY-----", "")
        .replace("-----END PRIVATE KEY-----", "")
        .replace('\r', "")
        .replace('\n', "")
        .replace("\\n", "")
        .replace(' ', "");
    // Re-wrap the base64 body at 64 columns: Rust's PKCS#8 PEM parser follows
    // RFC 7468 strictly (Go's `pem.Decode` tolerates a single long line).
    let wrapped = cleaned
        .as_bytes()
        .chunks(64)
        .map(|chunk| std::str::from_utf8(chunk).unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n");
    let pem = format!("-----BEGIN PRIVATE KEY-----\n{wrapped}\n-----END PRIVATE KEY-----");
    RsaPrivateKey::from_pkcs8_pem(&pem).map_err(|err| format!("parse private key: {err}"))
}

/// Mint the RS256 service-account assertion JWT — a port of Go `createSignedJWT`.
/// The claims are `iss`/`scope`/`aud`/`exp = now + 35m`/`iat = now`, signed with
/// RSASSA-PKCS1-v1.5-SHA256. `now` is unix seconds (the caller reads the clock),
/// and the header/claims keys are alphabetically ordered to match Go's
/// `encoding/json` map marshaling so the signing input is reproducible.
pub fn create_signed_jwt(email: &str, private_key_pem: &str, now: i64) -> Result<String, String> {
    let key = parse_private_key(private_key_pem)?;
    let signing_key: SigningKey<Sha256> = SigningKey::new(key);

    let header_b64 = URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256","typ":"JWT"}"#);
    let claims = JwtClaims {
        aud: "https://www.googleapis.com/oauth2/v4/token",
        exp: now + 35 * 60,
        iat: now,
        iss: email,
        scope: "https://www.googleapis.com/auth/cloud-platform",
    };
    let claims_json = serde_json::to_vec(&claims).map_err(|err| err.to_string())?;
    let claims_b64 = URL_SAFE_NO_PAD.encode(&claims_json);

    let signing_input = format!("{header_b64}.{claims_b64}");
    let signature = signing_key.sign(signing_input.as_bytes());
    let signature_b64 = URL_SAFE_NO_PAD.encode(signature.to_bytes());

    Ok(format!("{signing_input}.{signature_b64}"))
}

/// The Google OAuth2 token endpoint the assertion JWT is exchanged at.
pub const TOKEN_ENDPOINT: &str = "https://www.googleapis.com/oauth2/v4/token";

/// The form body for the JWT-bearer token exchange (Go
/// `exchangeJwtForAccessToken`): `grant_type=jwt-bearer&assertion=<jwt>`.
pub fn token_exchange_body(signed_jwt: &str) -> String {
    format!(
        "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion={}",
        signed_jwt
    )
}

/// Extract the `access_token` from a GCP token-exchange response.
pub fn parse_token_response(body: &[u8]) -> Result<String, String> {
    let value: serde_json::Value = serde_json::from_slice(body).map_err(|err| err.to_string())?;
    value
        .get("access_token")
        .and_then(|token| token.as_str())
        .map(|token| token.to_string())
        .ok_or_else(|| format!("no access_token: {}", String::from_utf8_lossy(body)))
}

fn append_api_version(base_url: &str, version: &str) -> String {
    let version = version.trim().trim_matches('/');
    if version.is_empty() || base_url.ends_with(&format!("/{version}")) {
        base_url.to_string()
    } else {
        format!("{base_url}/{version}")
    }
}

fn normalize_region(region: &str) -> String {
    let region = region.trim();
    if region.is_empty() {
        "global".to_string()
    } else {
        region.to_string()
    }
}

/// Build the Vertex API base URL (Go `BuildAPIBaseURL`). A configured channel
/// base URL is normalized + version-appended + scoped to the project/location;
/// otherwise the regional `aiplatform.googleapis.com` host is constructed (the
/// `global` region uses the unprefixed host).
fn build_api_base_url(base_url: &str, version: &str, project_id: &str, region: &str) -> String {
    let normalized = base_url.trim().trim_end_matches('/');
    if !normalized.is_empty() {
        let mut url = append_api_version(normalized, version);
        let region = normalize_region(region);
        if !project_id.trim().is_empty() {
            url = format!("{url}/projects/{project_id}/locations/{region}");
        }
        return url;
    }
    let region = normalize_region(region);
    match (project_id.trim().is_empty(), region.as_str()) {
        (true, "global") => format!("https://aiplatform.googleapis.com/{version}"),
        (true, _) => format!("https://{region}-aiplatform.googleapis.com/{version}"),
        (false, "global") => format!(
            "https://aiplatform.googleapis.com/{version}/projects/{project_id}/locations/global"
        ),
        (false, _) => format!(
            "https://{region}-aiplatform.googleapis.com/{version}/projects/{project_id}/locations/{region}"
        ),
    }
}

/// Build the Vertex `predictLongRunning` submit URL (Go `BuildGoogleModelURL`
/// with publisher `google`).
pub fn build_predict_url(
    base_url: &str,
    version: &str,
    project_id: &str,
    region: &str,
    model: &str,
) -> String {
    format!(
        "{}/publishers/google/models/{model}:predictLongRunning",
        build_api_base_url(base_url, version, project_id, region)
    )
}

/// Extract the path segment following `key` from a resource name like
/// `projects/<p>/locations/<r>/.../models/<m>/operations/<op>`.
fn extract_segment(name: &str, key: &str) -> String {
    let parts: Vec<&str> = name.split('/').collect();
    for window in parts.windows(2) {
        if window[0] == key {
            return window[1].to_string();
        }
    }
    String::new()
}

/// Build the Vertex poll URL (Go `buildFetchOperationURL`): extract the
/// project/region/model from the operation name and build the
/// `fetchPredictOperation` endpoint (region defaults to `us-central1`). The poll
/// body is `{"operationName": "<name>"}`.
pub fn build_fetch_url(base_url: &str, operation_name: &str) -> Result<String, String> {
    let region = {
        let r = extract_segment(operation_name, "locations");
        if r.is_empty() {
            "us-central1".to_string()
        } else {
            r
        }
    };
    let project = extract_segment(operation_name, "projects");
    let model = extract_segment(operation_name, "models");
    if model.trim().is_empty() {
        return Err("cannot extract model from operation name".to_string());
    }
    if project.trim().is_empty() {
        return Err("cannot extract project from operation name".to_string());
    }
    Ok(format!(
        "{}/publishers/google/models/{model}:fetchPredictOperation",
        build_api_base_url(base_url, "v1", &project, &region)
    ))
}

/// Extract the upstream task id from a Vertex submit response (Go `DoResponse`):
/// the operation `name`, base64-encoded as a local task id; an empty name is an
/// error.
pub fn parse_submit_response(resp_body: &[u8]) -> Result<String, String> {
    #[derive(Deserialize, Default)]
    struct SubmitResponse {
        #[serde(default)]
        name: String,
    }
    let resp: SubmitResponse = serde_json::from_slice(resp_body)
        .map_err(|err| format!("unmarshal_response_failed: {err}"))?;
    if resp.name.trim().is_empty() {
        return Err("missing operation name".to_string());
    }
    Ok(crate::taskcommon::encode_local_task_id(&resp.name))
}

#[derive(Deserialize, Default)]
struct OperationResponse {
    #[serde(default)]
    done: bool,
    #[serde(default)]
    response: ResponseField,
    #[serde(default)]
    error: ErrorField,
}

#[derive(Deserialize, Default)]
struct ResponseField {
    #[serde(default)]
    videos: Vec<OperationVideo>,
    #[serde(default, rename = "bytesBase64Encoded")]
    bytes_base64_encoded: String,
    #[serde(default)]
    encoding: String,
    #[serde(default)]
    video: String,
}

#[derive(Deserialize, Default)]
struct OperationVideo {
    #[serde(default, rename = "mimeType")]
    mime_type: String,
    #[serde(default, rename = "bytesBase64Encoded")]
    bytes_base64_encoded: String,
    #[serde(default)]
    encoding: String,
}

#[derive(Deserialize, Default)]
struct ErrorField {
    #[serde(default)]
    message: String,
}

/// Resolve a MIME type from an `encoding` hint: blank defaults to `mp4`, a value
/// already containing `/` is used as-is, otherwise it is prefixed with `video/`.
fn mime_from_encoding(encoding: &str) -> String {
    let enc = encoding.trim();
    let enc = if enc.is_empty() { "mp4" } else { enc };
    if enc.contains('/') {
        enc.to_string()
    } else {
        format!("video/{enc}")
    }
}

/// Build the `data:` URL for a completed operation, checking the three payload
/// locations in Go's order. Returns an empty string when none carry base64.
fn success_url(response: &ResponseField) -> String {
    if let Some(video) = response.videos.first() {
        if !video.bytes_base64_encoded.is_empty() {
            let mime = if video.mime_type.trim().is_empty() {
                mime_from_encoding(&video.encoding)
            } else {
                video.mime_type.trim().to_string()
            };
            return format!("data:{mime};base64,{}", video.bytes_base64_encoded);
        }
    }
    if !response.bytes_base64_encoded.is_empty() {
        let mime = mime_from_encoding(&response.encoding);
        return format!("data:{mime};base64,{}", response.bytes_base64_encoded);
    }
    if !response.video.is_empty() {
        let mime = mime_from_encoding(&response.encoding);
        return format!("data:{mime};base64,{}", response.video);
    }
    String::new()
}

fn task_info(status: TaskStatus, progress: &str, reason: String, url: String) -> TaskInfo {
    TaskInfo {
        code: 0,
        task_id: String::new(),
        status,
        reason,
        url,
        remote_url: String::new(),
        progress: progress.to_string(),
        completion_tokens: 0,
        total_tokens: 0,
    }
}

pub fn parse_task_result(resp_body: &[u8]) -> Result<TaskInfo, String> {
    let op: OperationResponse = serde_json::from_slice(resp_body)
        .map_err(|err| format!("unmarshal operation response failed: {err}"))?;

    if !op.error.message.is_empty() {
        return Ok(task_info(
            TaskStatus::Failure,
            "100%",
            op.error.message,
            String::new(),
        ));
    }
    if !op.done {
        return Ok(task_info(
            TaskStatus::InProgress,
            "50%",
            String::new(),
            String::new(),
        ));
    }
    Ok(task_info(
        TaskStatus::Success,
        "100%",
        String::new(),
        success_url(&op.response),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    // A throwaway 2048-bit PKCS#8 RSA key, used only to exercise RS256 signing.
    const TEST_KEY: &str = "-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC5OMWi4PW2wccW
AoM9K5NbKLHIAjm62emIT30sJk73ZOOb2A+B5vUoZFlPOG3AuFj7iiNffTrovtpe
MiOuw4nq/UDuCcgIW/W17JqrgA5efglMt8fPhIaYQ1oYoy52iK6u/ckPxDYSPVhc
PASgoKaFdfo0tStExgXjkOMipQQlDei90RqFx4cH2ytGar1skvoxkE+LnYIkc7Qj
u3p5bdJI6lU2Q8zhQlr1swlF0VTP9kImn2ijNIPevzFAujb16j7jQIwZTff2VR+/
afHxKH3zbNPfAPjqo9lYx+FCqhvXtZFqYA7ITAkiDUmBQP9JHGrxtn3VPblGczzO
QnNDA6S9AgMBAAECggEAGmQmdPDM0f+GWHJ/NKYS1vhTbIY0p5UJG20IDtReiA2O
CNSeUQoRgHHb79fAe6dItn6WT7LOQ/99qdJHF02xRxRSvhgSsm438nYGC82xPnGC
7bV5+O2PJ/7gxYXqxuTuzuxGS8LPWYX4IxxCJIj/cSDAR+ZQhfoZOLWaR4Nvtb+p
Sl/ylZhf4NPea95kLJORmum0Ollj6u6KHUMxZf4n3brXzEjvgJOXiniD+giRZIWY
4bHTmolo7kugNr7rbAeq0dsxS0Sii4202sMKV7XUu0wutdwIEPkFGkXEBUAPzI1j
N2fMAWc9xP7zgwUvYW9jM95OnJAR84UNQtM1Tw4xQQKBgQDu0FcCZVgdA97HZiyC
KYVOWdsUbFa9mhBQu7u56Gelj0rFMdHwAdn92z6BRWuuhhWUCuE4gTMvnOcuZKY+
ciL7Ycx/Iupxv+8X5AjQBR/BKPi6sMY1CBXAr3L1bRulaBrypLBW0uRjt3pVMuAh
MdQezM6uGmDg+mvCdL5sMm/KaQKBgQDGjRtujQbQPXRSxrmY4nNSErlBz1hcWvKv
Pb6KouksdD6G4nwtNixSaOo9CMVl43vBQ2uUL+d2ztnAc2CCKophIHWN6Mr+Osct
gxs/yJv/fNgpktJfFJW3MY9OjgBeu5DB12xnYX6yg5yJHWV2VgqYtPTnEETJuTj3
v6aREF81NQKBgBXcLkrC2hj11Lut558Wi+RLJ1msPRhn9NxfAuUWl/44qqB4Wf49
PSYWnpcYsq2sCmedw1X3xaazFxpRDkKjEf6uyhhNKua0qf8m2YOpJGn7BSGZstsB
3XPg24YJscEnUWgqmRWpgkx6bBFGceu38vHKz5RyR7HwWlLXeuLOjxsZAoGBALUr
nJRLaqQo7zN40XGHb+K74v8By4a6FieBF5Q5ArrldwhtMRGwFNE9mj8G+df2sr2u
X0NgUrw+EsNgg/dCCfKGQ72xZUiFKamFsB+LVYzSxgtpRTws9E+skS8Es6G9VGEL
yIasl4ccQIF8qVBJQnIE7FLKrXnD4Q9vePV1EurhAoGAY7ltI71fxcE4Lzwx6sKn
6rz5z4xD28xvnYTi67I1aCID6q9hNczY5LKCpJ1RF9tTvUJbLZo1hOsueaMgWQHv
l+NIzNWilPGfyLTdFEJPwdH8BUDvHi8AkMarH0Jb4wbG9wFECYk3qWARvtHPko2l
XLmak3bnZHNpev8oBuq/HH0=
-----END PRIVATE KEY-----";

    #[test]
    fn create_signed_jwt_rs256_structure_and_signature() {
        use rsa::pkcs1v15::{Signature, VerifyingKey};
        use rsa::signature::Verifier;

        let jwt =
            create_signed_jwt("svc@proj.iam.gserviceaccount.com", TEST_KEY, 1_000_000).unwrap();
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3, "header.payload.signature");

        // Header is RS256, sorted keys (matching Go's json marshaling).
        assert_eq!(
            URL_SAFE_NO_PAD.decode(parts[0]).unwrap(),
            br#"{"alg":"RS256","typ":"JWT"}"#
        );
        // Claims carry the Go fields; exp = now + 35m.
        assert_eq!(
            String::from_utf8(URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap(),
            r#"{"aud":"https://www.googleapis.com/oauth2/v4/token","exp":1002100,"iat":1000000,"iss":"svc@proj.iam.gserviceaccount.com","scope":"https://www.googleapis.com/auth/cloud-platform"}"#
        );

        // The RS256 signature verifies under the matching public key.
        let key = parse_private_key(TEST_KEY).unwrap();
        let verifying_key = VerifyingKey::<Sha256>::new(key.to_public_key());
        let signing_input = format!("{}.{}", parts[0], parts[1]);
        let signature =
            Signature::try_from(URL_SAFE_NO_PAD.decode(parts[2]).unwrap().as_slice()).unwrap();
        assert!(verifying_key
            .verify(signing_input.as_bytes(), &signature)
            .is_ok());
    }

    #[test]
    fn create_signed_jwt_rejects_bad_key() {
        assert!(create_signed_jwt("svc", "not a key", 0).is_err());
    }

    #[test]
    fn predict_url_configured_base() {
        assert_eq!(
            build_predict_url("https://proxy.example/", "v1", "my-proj", "us-central1", "veo-2"),
            "https://proxy.example/v1/projects/my-proj/locations/us-central1/publishers/google/models/veo-2:predictLongRunning"
        );
    }

    #[test]
    fn predict_url_constructed_host() {
        // Regional host when no base URL is configured.
        assert_eq!(
            build_predict_url("", "v1", "my-proj", "us-central1", "veo-2"),
            "https://us-central1-aiplatform.googleapis.com/v1/projects/my-proj/locations/us-central1/publishers/google/models/veo-2:predictLongRunning"
        );
        // global region uses the unprefixed host; empty region defaults to global.
        assert_eq!(
            build_predict_url("", "v1", "my-proj", "", "veo-2"),
            "https://aiplatform.googleapis.com/v1/projects/my-proj/locations/global/publishers/google/models/veo-2:predictLongRunning"
        );
    }

    #[test]
    fn token_response_extracts_access_token() {
        assert_eq!(
            parse_token_response(br#"{"access_token":"ya29.abc","expires_in":3599}"#).unwrap(),
            "ya29.abc"
        );
        assert!(parse_token_response(br#"{"error":"invalid_grant"}"#).is_err());
    }

    #[test]
    fn token_exchange_body_is_form_encoded() {
        let body = token_exchange_body("JWT123");
        assert!(body.contains("grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer"));
        assert!(body.contains("assertion=JWT123"));
    }

    #[test]
    fn fetch_url_from_operation_name() {
        let op = "projects/my-proj/locations/us-central1/publishers/google/models/veo-2/operations/abc123";
        assert_eq!(
            build_fetch_url("", op).unwrap(),
            "https://us-central1-aiplatform.googleapis.com/v1/projects/my-proj/locations/us-central1/publishers/google/models/veo-2:fetchPredictOperation"
        );
        // Missing project/model -> error.
        assert!(build_fetch_url("", "operations/abc").is_err());
    }

    #[test]
    fn submit_response_encodes_operation_name() {
        use crate::taskcommon::decode_local_task_id;
        let id =
            parse_submit_response(br#"{"name":"projects/p/locations/r/operations/op9"}"#).unwrap();
        assert_eq!(
            decode_local_task_id(&id).unwrap(),
            "projects/p/locations/r/operations/op9"
        );
        assert_eq!(
            parse_submit_response(br#"{"name":""}"#).unwrap_err(),
            "missing operation name"
        );
    }

    #[test]
    fn error_message_is_failure() {
        let info = parse_task_result(br#"{"error":{"message":"safety"}}"#).unwrap();
        assert_eq!(info.status, TaskStatus::Failure);
        assert_eq!(info.reason, "safety");
        assert_eq!(info.progress, "100%");
    }

    #[test]
    fn not_done_is_in_progress() {
        let info = parse_task_result(br#"{"done":false}"#).unwrap();
        assert_eq!(info.status, TaskStatus::InProgress);
        assert_eq!(info.progress, "50%");
    }

    #[test]
    fn done_video_uses_explicit_mime_type() {
        let info = parse_task_result(
            br#"{"done":true,"response":{"videos":[{"mimeType":"video/mp4","bytesBase64Encoded":"AAAA"}]}}"#,
        )
        .unwrap();
        assert_eq!(info.status, TaskStatus::Success);
        assert_eq!(info.url, "data:video/mp4;base64,AAAA");
    }

    #[test]
    fn done_video_falls_back_to_encoding_then_mp4() {
        // encoding without a slash -> prefixed with video/
        let info = parse_task_result(
            br#"{"done":true,"response":{"videos":[{"bytesBase64Encoded":"BBBB","encoding":"webm"}]}}"#,
        )
        .unwrap();
        assert_eq!(info.url, "data:video/webm;base64,BBBB");

        // encoding already a full mime -> used as-is
        let info = parse_task_result(
            br#"{"done":true,"response":{"videos":[{"bytesBase64Encoded":"CCCC","encoding":"image/gif"}]}}"#,
        )
        .unwrap();
        assert_eq!(info.url, "data:image/gif;base64,CCCC");

        // no mime, no encoding -> default mp4
        let info = parse_task_result(
            br#"{"done":true,"response":{"videos":[{"bytesBase64Encoded":"DDDD"}]}}"#,
        )
        .unwrap();
        assert_eq!(info.url, "data:video/mp4;base64,DDDD");
    }

    #[test]
    fn done_falls_back_to_response_level_payloads() {
        // response.bytesBase64Encoded
        let info = parse_task_result(
            br#"{"done":true,"response":{"bytesBase64Encoded":"EEEE","encoding":"mp4"}}"#,
        )
        .unwrap();
        assert_eq!(info.url, "data:video/mp4;base64,EEEE");

        // response.video variant
        let info = parse_task_result(br#"{"done":true,"response":{"video":"FFFF"}}"#).unwrap();
        assert_eq!(info.url, "data:video/mp4;base64,FFFF");
    }

    #[test]
    fn done_with_no_payload_is_success_without_url() {
        let info = parse_task_result(br#"{"done":true,"response":{}}"#).unwrap();
        assert_eq!(info.status, TaskStatus::Success);
        assert_eq!(info.progress, "100%");
        assert!(info.url.is_empty());
    }
}
