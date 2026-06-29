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
use serde::Deserialize;

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
