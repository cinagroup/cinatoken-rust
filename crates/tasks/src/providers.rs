//! Per-provider upstream-response parsers — the pure half of each
//! `relay/channel/task/<provider>` adaptor's `ParseTaskResult`. Each maps a
//! provider's poll response onto the shared [`crate::TaskInfo`]; the I/O half
//! (request building, HTTP) lives in the Worker adaptor that calls these.
pub mod ali;
pub mod doubao;
pub mod gemini;
pub mod hailuo;
pub mod jimeng;
pub mod kling;
pub mod midjourney;
pub mod poll_request;
pub mod sora;
pub mod submit_request;
pub mod suno;
pub mod vertex;
pub mod vidu;

use crate::TaskInfo;

/// The task-capable video providers, identified by their Cloudflare channel-type
/// id (`constant/channel.go`). This is the dispatch the polling orchestration
/// uses to pick a parser, ported from the channel-type switch in Go
/// `GetTaskAdaptor` (`relay/relay_adaptor.go`). Suno and Midjourney are not here
/// — they batch-poll through their own paths.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoProvider {
    Ali,
    Kling,
    Jimeng,
    Vertex,
    Vidu,
    Doubao,
    Sora,
    Gemini,
    Hailuo,
}

impl VideoProvider {
    /// Map a channel-type id to its task provider. Returns `None` for channel
    /// types that do not run video tasks. Mirrors Go `GetTaskAdaptor`'s
    /// channel-type switch, including the aliases (DoubaoVideo/VolcEngine →
    /// Doubao, Sora/OpenAI → Sora, MiniMax → Hailuo).
    pub fn from_channel_type(channel_type: i64) -> Option<VideoProvider> {
        match channel_type {
            17 => Some(VideoProvider::Ali),
            50 => Some(VideoProvider::Kling),
            51 => Some(VideoProvider::Jimeng),
            41 => Some(VideoProvider::Vertex),
            52 => Some(VideoProvider::Vidu),
            54 | 45 => Some(VideoProvider::Doubao),
            55 | 1 => Some(VideoProvider::Sora),
            24 => Some(VideoProvider::Gemini),
            35 => Some(VideoProvider::Hailuo),
            _ => None,
        }
    }

    /// Parse an upstream poll response with this provider's `ParseTaskResult`
    /// port.
    pub fn parse_task_result(self, body: &[u8]) -> Result<TaskInfo, String> {
        match self {
            VideoProvider::Ali => ali::parse_task_result(body),
            VideoProvider::Kling => kling::parse_task_result(body),
            VideoProvider::Jimeng => jimeng::parse_task_result(body),
            VideoProvider::Vertex => vertex::parse_task_result(body),
            VideoProvider::Vidu => vidu::parse_task_result(body),
            VideoProvider::Doubao => doubao::parse_task_result(body),
            VideoProvider::Sora => sora::parse_task_result(body),
            VideoProvider::Gemini => gemini::parse_task_result(body),
            VideoProvider::Hailuo => hailuo::parse_task_result(body),
        }
    }

    /// Extract the upstream task id from a submit response using this provider's
    /// `DoResponse` port. The five providers with a ported submit parser
    /// (sora/vidu/doubao/kling/ali) dispatch to it; the others return an error
    /// until their submit parser is ported.
    pub fn parse_submit_response(self, body: &[u8]) -> Result<String, String> {
        match self {
            VideoProvider::Sora => sora::parse_submit_response(body),
            VideoProvider::Vidu => vidu::parse_submit_response(body),
            VideoProvider::Doubao => doubao::parse_submit_response(body),
            VideoProvider::Kling => kling::parse_submit_response(body),
            VideoProvider::Ali => ali::parse_submit_response(body),
            VideoProvider::Jimeng
            | VideoProvider::Vertex
            | VideoProvider::Gemini
            | VideoProvider::Hailuo => {
                Err("submit response parser not yet ported for this provider".to_string())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::TaskStatus;

    #[test]
    fn channel_type_dispatch_matches_go() {
        let cases = [
            (17, VideoProvider::Ali),
            (50, VideoProvider::Kling),
            (51, VideoProvider::Jimeng),
            (41, VideoProvider::Vertex),
            (52, VideoProvider::Vidu),
            (54, VideoProvider::Doubao),
            (45, VideoProvider::Doubao),
            (55, VideoProvider::Sora),
            (1, VideoProvider::Sora),
            (24, VideoProvider::Gemini),
            (35, VideoProvider::Hailuo),
        ];
        for (channel_type, provider) in cases {
            assert_eq!(
                VideoProvider::from_channel_type(channel_type),
                Some(provider),
                "channel type {channel_type}"
            );
        }
        // A non-task channel type.
        assert_eq!(VideoProvider::from_channel_type(999), None);
    }

    #[test]
    fn dispatch_routes_to_the_right_parser() {
        // Kling vocabulary parses only through the Kling arm.
        let info = VideoProvider::Kling
            .parse_task_result(br#"{"data":{"task_status":"succeed"}}"#)
            .unwrap();
        assert_eq!(info.status, TaskStatus::Success);

        // The same body is invalid for Vidu (which expects `state`), so it maps
        // to Vidu's Unknown-state error — proving the dispatch is per-provider.
        let err = VideoProvider::Vidu
            .parse_task_result(br#"{"data":{"task_status":"succeed"}}"#)
            .unwrap_err();
        assert_eq!(err, "unknown task state: ");
    }

    #[test]
    fn submit_response_dispatch_routes_per_provider() {
        // Doubao extracts `id`.
        assert_eq!(
            VideoProvider::Doubao
                .parse_submit_response(br#"{"id":"cgt-9"}"#)
                .unwrap(),
            "cgt-9"
        );
        // Ali extracts `output.task_id`.
        assert_eq!(
            VideoProvider::Ali
                .parse_submit_response(br#"{"output":{"task_id":"ali-1"}}"#)
                .unwrap(),
            "ali-1"
        );
        // Unported providers error.
        assert!(VideoProvider::Jimeng
            .parse_submit_response(br#"{}"#)
            .is_err());
    }
}
