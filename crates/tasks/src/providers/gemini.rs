//! Pure response parser for the Gemini (Veo) video task provider, ported from
//! `relay/channel/task/gemini/adaptor.go` (`ParseTaskResult`).
//!
//! Like Vertex, Gemini returns a long-running-operation envelope, but on
//! completion it (a) sets the public task id to the base64-encoded operation
//! name and (b) exposes the result as a remote `uri` (not inline base64) under
//! `response.generateVideoResponse.generatedVideos[0].video.uri`.

use crate::taskcommon::encode_local_task_id;
use crate::{TaskInfo, TaskStatus};
use serde::Deserialize;

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
}
