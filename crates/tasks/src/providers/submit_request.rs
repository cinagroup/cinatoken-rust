//! Pure submit-endpoint URL builders for the video task providers, ported from
//! each provider's `BuildRequestURL` in `relay/channel/task/<p>/adaptor.go`.
//!
//! Several endpoints depend on the task action (Go's `TaskAction*` constants:
//! `generate`, `textGenerate`, `firstTailGenerate`, `referenceGenerate`,
//! `remixGenerate`). The request body + auth headers are built separately
//! (`submit_request`/signing live elsewhere); this is the URL half.

/// Sora: remix posts to a per-origin endpoint, every other action to the create
/// endpoint.
pub fn sora(base_url: &str, action: &str, origin_task_id: &str) -> String {
    if action == "remixGenerate" {
        format!("{base_url}/v1/videos/{origin_task_id}/remix")
    } else {
        format!("{base_url}/v1/videos")
    }
}

/// Kling: `generate` is image-to-video, anything else is text-to-video; a
/// new-api relay key routes through the `/kling` path prefix.
pub fn kling(base_url: &str, action: &str, is_new_api_relay: bool) -> String {
    let path = if action == "generate" {
        "/v1/videos/image2video"
    } else {
        "/v1/videos/text2video"
    };
    if is_new_api_relay {
        format!("{base_url}/kling{path}")
    } else {
        format!("{base_url}{path}")
    }
}

/// Vidu: one of four `/ent/v2` endpoints by action.
pub fn vidu(base_url: &str, action: &str) -> String {
    let path = match action {
        "generate" => "/img2video",
        "firstTailGenerate" => "/start-end2video",
        "referenceGenerate" => "/reference2video",
        _ => "/text2video",
    };
    format!("{base_url}/ent/v2{path}")
}

/// Doubao: a single content-generation tasks endpoint.
pub fn doubao(base_url: &str) -> String {
    format!("{base_url}/api/v3/contents/generations/tasks")
}

/// Ali (DashScope): a single video-synthesis endpoint.
pub fn ali(base_url: &str) -> String {
    format!("{base_url}/api/v1/services/aigc/video-generation/video-synthesis")
}

/// Hailuo (MiniMax): a single video-generation endpoint.
pub fn hailuo(base_url: &str) -> String {
    format!("{base_url}/v1/video_generation")
}

/// Gemini/Veo: the `predictLongRunning` submit endpoint for a model + API
/// version (Go `BuildRequestURL`).
pub fn gemini(base_url: &str, version: &str, model: &str) -> String {
    format!("{base_url}/{version}/models/{model}:predictLongRunning")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sora_remix_vs_create() {
        assert_eq!(
            sora("https://api.sora", "remixGenerate", "vid_1"),
            "https://api.sora/v1/videos/vid_1/remix"
        );
        assert_eq!(
            sora("https://api.sora", "generate", ""),
            "https://api.sora/v1/videos"
        );
    }

    #[test]
    fn kling_action_and_relay_prefix() {
        assert_eq!(
            kling("https://k", "generate", false),
            "https://k/v1/videos/image2video"
        );
        assert_eq!(
            kling("https://k", "textGenerate", false),
            "https://k/v1/videos/text2video"
        );
        assert_eq!(
            kling("https://k", "generate", true),
            "https://k/kling/v1/videos/image2video"
        );
    }

    #[test]
    fn vidu_action_paths() {
        assert_eq!(vidu("https://v", "generate"), "https://v/ent/v2/img2video");
        assert_eq!(
            vidu("https://v", "firstTailGenerate"),
            "https://v/ent/v2/start-end2video"
        );
        assert_eq!(
            vidu("https://v", "referenceGenerate"),
            "https://v/ent/v2/reference2video"
        );
        assert_eq!(
            vidu("https://v", "textGenerate"),
            "https://v/ent/v2/text2video"
        );
    }

    #[test]
    fn fixed_endpoints() {
        assert_eq!(
            doubao("https://ark"),
            "https://ark/api/v3/contents/generations/tasks"
        );
        assert_eq!(
            ali("https://dashscope"),
            "https://dashscope/api/v1/services/aigc/video-generation/video-synthesis"
        );
        assert_eq!(
            hailuo("https://minimax"),
            "https://minimax/v1/video_generation"
        );
    }
}
