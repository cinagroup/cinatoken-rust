//! Pure response parser for the Gemini (Veo) video task provider, ported from
//! `relay/channel/task/gemini/adaptor.go` (`ParseTaskResult`).
//!
//! Like Vertex, Gemini returns a long-running-operation envelope, but on
//! completion it (a) sets the public task id to the base64-encoded operation
//! name and (b) exposes the result as a remote `uri` (not inline base64) under
//! `response.generateVideoResponse.generatedVideos[0].video.uri`.

use crate::taskcommon::{encode_local_task_id, merge_metadata};
use crate::{TaskInfo, TaskStatus, TaskSubmitReq};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Deserialize, Default)]
struct OperationResponse {
    #[serde(default)]
    name: String,
    #[serde(default)]
    done: bool,
    #[serde(default)]
    response: ResponseField,
    #[serde(default)]
    error: ErrorField,
}

#[derive(Deserialize, Default)]
struct ResponseField {
    #[serde(default, rename = "generateVideoResponse")]
    generate_video_response: GenerateVideoResponse,
}

#[derive(Deserialize, Default)]
struct GenerateVideoResponse {
    #[serde(default, rename = "generatedVideos")]
    generated_videos: Vec<GeneratedVideo>,
}

#[derive(Deserialize, Default)]
struct GeneratedVideo {
    #[serde(default)]
    video: VideoField,
}

#[derive(Deserialize, Default)]
struct VideoField {
    #[serde(default)]
    uri: String,
}

#[derive(Deserialize, Default)]
struct ErrorField {
    #[serde(default)]
    message: String,
}

pub fn parse_task_result(resp_body: &[u8]) -> Result<TaskInfo, String> {
    let op: OperationResponse = serde_json::from_slice(resp_body)
        .map_err(|err| format!("unmarshal operation response failed: {err}"))?;

    if !op.error.message.is_empty() {
        return Ok(make(
            TaskStatus::Failure,
            "100%",
            op.error.message,
            String::new(),
            String::new(),
        ));
    }
    if !op.done {
        return Ok(make(
            TaskStatus::InProgress,
            "50%",
            String::new(),
            String::new(),
            String::new(),
        ));
    }

    let mut remote_url = String::new();
    if let Some(video) = op.response.generate_video_response.generated_videos.first() {
        if !video.video.uri.is_empty() {
            remote_url = video.video.uri.clone();
        }
    }

    Ok(make(
        TaskStatus::Success,
        "100%",
        String::new(),
        remote_url,
        encode_local_task_id(&op.name),
    ))
}

fn make(
    status: TaskStatus,
    progress: &str,
    reason: String,
    remote_url: String,
    task_id: String,
) -> TaskInfo {
    TaskInfo {
        code: 0,
        task_id,
        status,
        reason,
        url: String::new(),
        remote_url,
        progress: progress.to_string(),
        completion_tokens: 0,
        total_tokens: 0,
    }
}

// ── Submit body (Veo predictLongRunning) ────────────────────────────────────

#[derive(Debug, Clone, Default, Serialize)]
struct VeoImageInput {
    #[serde(rename = "bytesBase64Encoded")]
    bytes_base64_encoded: String,
    #[serde(rename = "mimeType")]
    mime_type: String,
}

#[derive(Debug, Clone, Default, Serialize)]
struct VeoInstance {
    prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    image: Option<VeoImageInput>,
}

fn is_zero(value: &i64) -> bool {
    *value == 0
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct VeoParameters {
    #[serde(rename = "sampleCount", default)]
    sample_count: i64,
    #[serde(rename = "durationSeconds", default, skip_serializing_if = "is_zero")]
    duration_seconds: i64,
    #[serde(
        rename = "aspectRatio",
        default,
        skip_serializing_if = "String::is_empty"
    )]
    aspect_ratio: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    resolution: String,
    /// Other Veo parameters (negativePrompt, personGeneration, seed, …) arriving
    /// via metadata passthrough, flattened to the top level.
    #[serde(flatten)]
    extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VeoRequestPayload {
    instances: Vec<VeoInstance>,
    #[serde(skip_serializing_if = "Option::is_none")]
    parameters: Option<VeoParameters>,
}

/// Map a `WxH` size to a Veo resolution (Go `SizeToVeoResolution`): the larger
/// dimension picks `4k` (≥3840), `1080p` (≥1920), else `720p`; an unparsable
/// size defaults to `720p`.
fn size_to_veo_resolution(size: &str) -> String {
    let lower = size.to_lowercase();
    let parts: Vec<&str> = lower.splitn(2, 'x').collect();
    if parts.len() != 2 {
        return "720p".to_string();
    }
    let w: i64 = parts[0].parse().unwrap_or(0);
    let h: i64 = parts[1].parse().unwrap_or(0);
    let max_dim = w.max(h);
    if max_dim >= 3840 {
        "4k".to_string()
    } else if max_dim >= 1920 {
        "1080p".to_string()
    } else {
        "720p".to_string()
    }
}

/// Map a `WxH` size to a Veo aspect ratio (Go `SizeToVeoAspectRatio`): portrait
/// (`h > w`) is `9:16`, otherwise `16:9`; unparsable/non-positive defaults
/// `16:9`.
fn size_to_veo_aspect_ratio(size: &str) -> String {
    let lower = size.to_lowercase();
    let parts: Vec<&str> = lower.splitn(2, 'x').collect();
    if parts.len() != 2 {
        return "16:9".to_string();
    }
    let w: i64 = parts[0].parse().unwrap_or(0);
    let h: i64 = parts[1].parse().unwrap_or(0);
    if w <= 0 || h <= 0 {
        return "16:9".to_string();
    }
    if h > w {
        "9:16".to_string()
    } else {
        "16:9".to_string()
    }
}

/// Detect a small set of image MIME types from magic bytes (a pragmatic subset
/// of Go's `http.DetectContentType`); unknown content falls back to
/// `application/octet-stream`, matching Go's default.
fn detect_content_type(data: &[u8]) -> String {
    if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png".to_string()
    } else if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg".to_string()
    } else if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        "image/gif".to_string()
    } else if data.len() >= 12 && &data[0..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        "image/webp".to_string()
    } else {
        "application/octet-stream".to_string()
    }
}

/// Parse a `data:<mime>;base64,<payload>` URI into a [`VeoImageInput`] — Go
/// `parseDataURI`. Missing comma or empty payload returns `None`; a missing mime
/// defaults to `application/octet-stream`.
fn parse_data_uri(uri: &str) -> Option<VeoImageInput> {
    let rest = uri.strip_prefix("data:")?;
    let idx = rest.find(',')?;
    let meta = &rest[..idx];
    let b64 = &rest[idx + 1..];
    if b64.is_empty() {
        return None;
    }
    let mime_type = meta
        .split(';')
        .next()
        .filter(|part| !part.is_empty())
        .unwrap_or("application/octet-stream");
    Some(VeoImageInput {
        bytes_base64_encoded: b64.to_string(),
        mime_type: mime_type.to_string(),
    })
}

/// Parse an image input string into a [`VeoImageInput`] — Go `ParseImageInput`.
/// A `data:` URI is decomposed; a bare base64 string is kept verbatim with the
/// MIME sniffed from its decoded bytes. Blank/invalid input yields `None`.
fn parse_image_input(image: &str) -> Option<VeoImageInput> {
    let image = image.trim();
    if image.is_empty() {
        return None;
    }
    if image.starts_with("data:") {
        return parse_data_uri(image);
    }
    let raw = STANDARD.decode(image).ok()?;
    Some(VeoImageInput {
        bytes_base64_encoded: image.to_string(),
        mime_type: detect_content_type(&raw),
    })
}

/// Build the Gemini/Veo submit payload from the client request — a port of Go
/// `BuildRequestBody`. The prompt + optional first image become the instance;
/// metadata passthrough fields seed the parameters, then `duration`/`size` fill
/// `durationSeconds`/`resolution`/`aspectRatio` when metadata didn't, the
/// resolution is lowercased, and `sampleCount` is forced to 1.
pub fn convert_to_request_payload(req: &TaskSubmitReq) -> Result<VeoRequestPayload, String> {
    let mut instance = VeoInstance {
        prompt: req.prompt.clone(),
        image: None,
    };
    if let Some(image) = req.images.first() {
        if let Some(parsed) = parse_image_input(image) {
            instance.image = Some(parsed);
        }
    }

    let mut params = VeoParameters::default();
    if let Some(metadata) = &req.metadata {
        let mut value = serde_json::to_value(&params).map_err(|err| err.to_string())?;
        merge_metadata(&mut value, metadata);
        params = serde_json::from_value(value).map_err(|err| err.to_string())?;
    }
    if params.duration_seconds == 0 && req.duration > 0 {
        params.duration_seconds = req.duration;
    }
    if params.resolution.is_empty() && !req.size.is_empty() {
        params.resolution = size_to_veo_resolution(&req.size);
    }
    if params.aspect_ratio.is_empty() && !req.size.is_empty() {
        params.aspect_ratio = size_to_veo_aspect_ratio(&req.size);
    }
    params.resolution = params.resolution.to_lowercase();
    params.sample_count = 1;

    Ok(VeoRequestPayload {
        instances: vec![instance],
        parameters: Some(params),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::taskcommon::decode_local_task_id;

    #[test]
    fn error_message_is_failure() {
        let info = parse_task_result(br#"{"error":{"message":"blocked"}}"#).unwrap();
        assert_eq!(info.status, TaskStatus::Failure);
        assert_eq!(info.reason, "blocked");
        assert_eq!(info.progress, "100%");
    }

    #[test]
    fn not_done_is_in_progress() {
        let info = parse_task_result(br#"{"done":false}"#).unwrap();
        assert_eq!(info.status, TaskStatus::InProgress);
        assert_eq!(info.progress, "50%");
    }

    #[test]
    fn done_encodes_task_id_and_takes_remote_uri() {
        let body = br#"{
            "name": "operations/op-77",
            "done": true,
            "response": {
                "generateVideoResponse": {
                    "generatedVideos": [ { "video": { "uri": "https://files/v.mp4" } } ]
                }
            }
        }"#;
        let info = parse_task_result(body).unwrap();
        assert_eq!(info.status, TaskStatus::Success);
        assert_eq!(info.progress, "100%");
        assert_eq!(info.remote_url, "https://files/v.mp4");
        assert!(info.url.is_empty());
        // task_id is the base64-encoded operation name (round-trips back).
        assert_eq!(
            decode_local_task_id(&info.task_id).unwrap(),
            "operations/op-77"
        );
    }

    #[test]
    fn done_without_videos_still_encodes_task_id() {
        let info = parse_task_result(br#"{"name":"operations/x","done":true}"#).unwrap();
        assert_eq!(info.status, TaskStatus::Success);
        assert!(info.remote_url.is_empty());
        assert_eq!(decode_local_task_id(&info.task_id).unwrap(), "operations/x");
    }

    #[test]
    fn size_mappings_match_go() {
        assert_eq!(size_to_veo_resolution("3840x2160"), "4k");
        assert_eq!(size_to_veo_resolution("1920x1080"), "1080p");
        assert_eq!(size_to_veo_resolution("1280x720"), "720p");
        assert_eq!(size_to_veo_resolution("bogus"), "720p");
        assert_eq!(size_to_veo_aspect_ratio("1080x1920"), "9:16");
        assert_eq!(size_to_veo_aspect_ratio("1920x1080"), "16:9");
        assert_eq!(size_to_veo_aspect_ratio("0x0"), "16:9");
    }

    #[test]
    fn parse_data_uri_extracts_mime_and_payload() {
        let img = parse_data_uri("data:image/png;base64,iVBOR").unwrap();
        assert_eq!(img.mime_type, "image/png");
        assert_eq!(img.bytes_base64_encoded, "iVBOR");
        // No comma -> None; empty payload -> None.
        assert!(parse_data_uri("data:image/png;base64").is_none());
        assert!(parse_data_uri("data:image/png;base64,").is_none());
    }

    #[test]
    fn submit_body_text_only_defaults() {
        let req = TaskSubmitReq {
            prompt: "a dog".to_string(),
            size: "1080x1920".to_string(),
            duration: 6,
            ..Default::default()
        };
        let payload = convert_to_request_payload(&req).unwrap();
        let value = serde_json::to_value(&payload).unwrap();
        assert_eq!(value["instances"][0]["prompt"], "a dog");
        assert!(value["instances"][0].get("image").is_none());
        assert_eq!(value["parameters"]["sampleCount"], 1);
        assert_eq!(value["parameters"]["durationSeconds"], 6);
        // max dim 1920 -> 1080p (lower-cased); portrait -> 9:16.
        assert_eq!(value["parameters"]["resolution"], "1080p");
        assert_eq!(value["parameters"]["aspectRatio"], "9:16");
    }

    #[test]
    fn submit_body_data_uri_image_and_metadata() {
        let req = TaskSubmitReq {
            prompt: "p".to_string(),
            images: vec!["data:image/jpeg;base64,QQ".to_string()],
            metadata: Some(serde_json::json!({"negativePrompt": "blurry", "model": "evil"})),
            ..Default::default()
        };
        let payload = convert_to_request_payload(&req).unwrap();
        let value = serde_json::to_value(&payload).unwrap();
        assert_eq!(value["instances"][0]["image"]["mimeType"], "image/jpeg");
        assert_eq!(value["instances"][0]["image"]["bytesBase64Encoded"], "QQ");
        // metadata passthrough (model stripped).
        assert_eq!(value["parameters"]["negativePrompt"], "blurry");
        assert!(value["parameters"].get("model").is_none());
    }
}
