//! Pure change-detection gate for the Midjourney subsystem, ported from
//! `checkMjTaskNeedUpdate` in `controller/midjourney.go`.
//!
//! Midjourney predates the unified `TaskAdaptor` and has its own model/table,
//! controller, and DTO. It also polls in batches and merges results into the
//! stored row (a side-effecting orchestration step that lives in the Worker).
//! The pure, testable core is this gate, which decides whether an incoming
//! [`MidjourneyDto`] differs from the persisted task enough to warrant a write.

use serde::Deserialize;
use serde_json::Value;

/// One Midjourney task item from a batch poll response — the compared subset of
/// Go `dto.MidjourneyDto` (camelCase JSON keys mapped via serde rename).
#[derive(Debug, Clone, Deserialize, Default)]
pub struct MidjourneyDto {
    /// The upstream mj task id (JSON `id`), used to match the stored row.
    #[serde(default, rename = "id")]
    pub mj_id: String,
    #[serde(default, rename = "promptEn")]
    pub prompt_en: String,
    #[serde(default)]
    pub state: String,
    #[serde(default, rename = "submitTime")]
    pub submit_time: i64,
    #[serde(default, rename = "startTime")]
    pub start_time: i64,
    #[serde(default, rename = "finishTime")]
    pub finish_time: i64,
    #[serde(default, rename = "imageUrl")]
    pub image_url: String,
    #[serde(default, rename = "videoUrl")]
    pub video_url: String,
    #[serde(default, rename = "videoUrls")]
    pub video_urls: Value,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub progress: String,
    #[serde(default, rename = "failReason")]
    pub fail_reason: String,
}

/// The persisted Midjourney row fields the gate compares against (Go
/// `model.Midjourney`). `video_urls` is stored as a JSON string, matching the
/// Go column.
pub struct CurrentMidjourneyState<'a> {
    pub code: i64,
    pub progress: &'a str,
    pub prompt_en: &'a str,
    pub state: &'a str,
    pub submit_time: i64,
    pub start_time: i64,
    pub finish_time: i64,
    pub image_url: &'a str,
    pub video_url: &'a str,
    pub video_urls: &'a str,
    pub status: &'a str,
    pub fail_reason: &'a str,
}

/// Port of Go `checkMjTaskNeedUpdate`. Returns true when the stored task has not
/// been confirmed (`code != 1`), when any compared field changed, when the task
/// is failing but progress is not yet pinned, or when the `videoUrls` set
/// changed (including being cleared).
///
/// Faithfulness note: Go compares `videoUrls` by JSON-marshaling the incoming
/// array and string-comparing it to the stored column; this port mirrors that
/// (serialize incoming, compare to the stored string). The exact bytes depend on
/// serializer key ordering, the same caveat Go carries.
pub fn check_mj_task_need_update(old: &CurrentMidjourneyState, new: &MidjourneyDto) -> bool {
    if old.code != 1 {
        return true;
    }
    if old.progress != new.progress
        || old.prompt_en != new.prompt_en
        || old.state != new.state
        || old.submit_time != new.submit_time
        || old.start_time != new.start_time
        || old.finish_time != new.finish_time
        || old.image_url != new.image_url
        || old.status != new.status
        || old.fail_reason != new.fail_reason
    {
        return true;
    }
    if old.progress != "100%" && !new.fail_reason.is_empty() {
        return true;
    }
    if old.video_url != new.video_url {
        return true;
    }

    // videoUrls: incoming non-empty array is serialized and compared to the
    // stored string; an empty/absent incoming clears a previously-set column.
    let incoming_non_empty = matches!(&new.video_urls, Value::Array(items) if !items.is_empty());
    if incoming_non_empty {
        let serialized = serde_json::to_string(&new.video_urls).unwrap_or_default();
        if old.video_urls != serialized {
            return true;
        }
    } else if !old.video_urls.is_empty() {
        return true;
    }

    false
}

#[derive(Deserialize, Default)]
struct MidjourneyResponse {
    #[serde(default)]
    code: i64,
    #[serde(default)]
    description: String,
    #[serde(default)]
    result: String,
}

/// Extract the upstream mj task id from a Midjourney submit response (Go
/// `dto.MidjourneyResponse`): `code == 1` is success and `result` is the mj id;
/// any other code is an error carrying `description`.
pub fn parse_submit_response(resp_body: &[u8]) -> Result<String, String> {
    let resp: MidjourneyResponse = serde_json::from_slice(resp_body)
        .map_err(|err| format!("unmarshal_response_body_failed: {err}"))?;
    if resp.code != 1 {
        return Err(resp.description);
    }
    Ok(resp.result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn submit_response_returns_result_or_description() {
        assert_eq!(
            parse_submit_response(br#"{"code":1,"result":"168xxx"}"#).unwrap(),
            "168xxx"
        );
        assert_eq!(
            parse_submit_response(br#"{"code":4,"description":"banned prompt"}"#).unwrap_err(),
            "banned prompt"
        );
    }

    fn current<'a>() -> CurrentMidjourneyState<'a> {
        CurrentMidjourneyState {
            code: 1,
            progress: "50%",
            prompt_en: "a cat",
            state: "",
            submit_time: 1,
            start_time: 2,
            finish_time: 0,
            image_url: "",
            video_url: "",
            video_urls: "",
            status: "IN_PROGRESS",
            fail_reason: "",
        }
    }

    fn matching_incoming() -> MidjourneyDto {
        MidjourneyDto {
            mj_id: String::new(),
            prompt_en: "a cat".to_string(),
            state: String::new(),
            submit_time: 1,
            start_time: 2,
            finish_time: 0,
            image_url: String::new(),
            video_url: String::new(),
            video_urls: Value::Null,
            status: "IN_PROGRESS".to_string(),
            progress: "50%".to_string(),
            fail_reason: String::new(),
        }
    }

    #[test]
    fn unconfirmed_code_always_updates() {
        let mut old = current();
        old.code = 0;
        assert!(check_mj_task_need_update(&old, &matching_incoming()));
    }

    #[test]
    fn fully_matching_does_not_update() {
        assert!(!check_mj_task_need_update(&current(), &matching_incoming()));
    }

    #[test]
    fn scalar_changes_update() {
        let mut incoming = matching_incoming();
        incoming.progress = "100%".to_string();
        assert!(check_mj_task_need_update(&current(), &incoming));

        let mut incoming = matching_incoming();
        incoming.image_url = "https://img".to_string();
        assert!(check_mj_task_need_update(&current(), &incoming));
    }

    #[test]
    fn failing_before_pinned_progress_updates() {
        let mut incoming = matching_incoming();
        incoming.fail_reason = "banned word".to_string();
        // current.progress is "50%" (not 100%) -> needs update to pin + refund.
        assert!(check_mj_task_need_update(&current(), &incoming));
    }

    #[test]
    fn video_urls_set_and_cleared() {
        // Incoming has videoUrls, stored is empty -> update.
        let mut incoming = matching_incoming();
        incoming.video_urls = json!([{"url": "https://v/1.mp4"}]);
        assert!(check_mj_task_need_update(&current(), &incoming));

        // Stored matches the serialized incoming -> no update.
        let serialized = serde_json::to_string(&incoming.video_urls).unwrap();
        let mut old = current();
        old.video_urls = &serialized;
        assert!(!check_mj_task_need_update(&old, &incoming));

        // Incoming empty but stored set -> update (clearing).
        let mut old = current();
        old.video_urls = "[{\"url\":\"x\"}]";
        assert!(check_mj_task_need_update(&old, &matching_incoming()));
    }

    #[test]
    fn dto_deserializes_camel_case() {
        let dto: MidjourneyDto = serde_json::from_slice(
            br#"{"promptEn":"p","submitTime":7,"imageUrl":"i","failReason":"f","status":"SUCCESS"}"#,
        )
        .unwrap();
        assert_eq!(dto.prompt_en, "p");
        assert_eq!(dto.submit_time, 7);
        assert_eq!(dto.image_url, "i");
        assert_eq!(dto.fail_reason, "f");
        assert_eq!(dto.status, "SUCCESS");
    }
}
