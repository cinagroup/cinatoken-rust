//! Pure request-token estimation helpers — the non-tokenizer, non-decoder parts
//! of Go `service.EstimateRequestToken` / `CountAudioToken*`
//! (`service/token_counter.go`). Complements `image_tokens` (vision) and the
//! `tokenizer` crate (text). Parity target:
//! `docs/source-token-estimation-parity.md`.
//!
//! What stays out of this module (genuine I/O, handled by callers): real
//! tiktoken BPE for OpenAI text, the non-OpenAI text heuristic
//! (`crates/tokenizer`), image dimension decoding, and audio duration decoding.

/// Per-file fallback token counts when a media file is counted by type rather
/// than measured (Go `EstimateRequestToken` `meta.Files` switch).
pub const NON_OPENAI_IMAGE_TOKENS: i64 = 520;
pub const AUDIO_FILE_TOKENS: i64 = 256;
pub const VIDEO_FILE_TOKENS: i64 = 4096 * 2;
pub const FILE_TOKENS: i64 = 4096;
/// Unknown/default file type fallback.
pub const DEFAULT_FILE_TOKENS: i64 = 4096;

/// OpenAI chat formatting overhead added on top of text tokens, for
/// `RelayFormatOpenAI` only (Go: `tools*8 + messages*3 + name*3 + 3`).
pub fn openai_chat_format_overhead(messages_count: i64, tools_count: i64, name_count: i64) -> i64 {
    tools_count * 8 + messages_count * 3 + name_count * 3 + 3
}

/// Audio transcription/translation tokens from duration (Go:
/// `round(ceil(duration_secs) / 60 * 1000)` — 1 minute = 1000 tokens).
pub fn audio_transcription_tokens(duration_secs: f64) -> i64 {
    (duration_secs.ceil() / 60.0 * 1000.0).round() as i64
}

/// Realtime audio **input** tokens (Go `CountAudioTokenInput`:
/// `int(duration / 60 * 100 / 0.06)` — `int()` truncates toward zero).
pub fn realtime_audio_input_tokens(duration_secs: f64) -> i64 {
    (duration_secs / 60.0 * 100.0 / 0.06) as i64
}

/// Realtime audio **output** tokens (Go `CountAudioTokenOutput`:
/// `int(duration / 60 * 200 / 0.24)`).
pub fn realtime_audio_output_tokens(duration_secs: f64) -> i64 {
    (duration_secs / 60.0 * 200.0 / 0.24) as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_overhead_matches_go() {
        // 3 messages, 2 tools, 1 name: 2*8 + 3*3 + 1*3 + 3 = 31.
        assert_eq!(openai_chat_format_overhead(3, 2, 1), 31);
        // base reply priming with nothing else.
        assert_eq!(openai_chat_format_overhead(0, 0, 0), 3);
    }

    #[test]
    fn transcription_rounds_after_ceil() {
        // 30s -> ceil 30 -> 30/60*1000 = 500.
        assert_eq!(audio_transcription_tokens(30.0), 500);
        // 30.1s -> ceil 31 -> 31/60*1000 = 516.66.. -> round 517.
        assert_eq!(audio_transcription_tokens(30.1), 517);
        // 60s -> 1000.
        assert_eq!(audio_transcription_tokens(60.0), 1000);
    }

    #[test]
    fn realtime_audio_truncates() {
        // input: 60s -> 60/60*100/0.06 = 1666.66.. -> trunc 1666.
        assert_eq!(realtime_audio_input_tokens(60.0), 1666);
        // output: 60s -> 60/60*200/0.24 = 833.33.. -> trunc 833.
        assert_eq!(realtime_audio_output_tokens(60.0), 833);
        // zero duration -> zero.
        assert_eq!(realtime_audio_input_tokens(0.0), 0);
        assert_eq!(realtime_audio_output_tokens(0.0), 0);
    }

    #[test]
    fn media_fallback_constants() {
        assert_eq!(VIDEO_FILE_TOKENS, 8192);
        assert_eq!(AUDIO_FILE_TOKENS, 256);
        assert_eq!(NON_OPENAI_IMAGE_TOKENS, 520);
    }
}
