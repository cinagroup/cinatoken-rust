//! Hardcoded default model ratio/price tables — faithful port of Go
//! `setting/ratio_setting.defaultModelRatio` / `defaultModelPrice` /
//! `defaultCompletionRatio` (`model_ratio.go`, `cache_ratio.go`).
//!
//! In Go, `InitRatioSettings()` seeds the operator-editable ratio maps with
//! these tables as a **base layer**; an operator's `options` JSON *overrides*
//! individual entries. The Rust `billing::pricing::PricingConfig` mirrors that:
//! the operator map is consulted first, then these defaults. Without this layer
//! an unconfigured-but-known model (e.g. `gpt-4o`, Go default ratio `1.25`)
//! bills at `1.0` or is treated as free — diverging from Go for most models.
//!
//! Currency constants are preserved verbatim so a Go<->Rust diff is trivial:
//! `1 ratio === $0.002 / 1K tokens`, so `$1 === 500` (`USD`), and `RMB =
//! USD/USD2RMB` (Go's `7.3`). Values that Go derives from RMB/USD are kept in
//! expression form here (e.g. `0.120 * RMB`) for traceability rather than
//! pre-evaluated to a long decimal.

/// `$1 === 500` quota units (`1 ratio === $0.002 / 1K tokens`). Mirrors Go
/// `USD`.
pub const USD: f64 = 500.0;
/// `1 USD === 7.3 RMB`. Mirrors Go `USD2RMB`.
pub const USD2RMB: f64 = 7.3;
/// `RMB = USD / USD2RMB`. Mirrors Go `RMB`.
pub const RMB: f64 = USD / USD2RMB;

/// Default per-token prompt ratios (Go `defaultModelRatio`). `1 === $0.002/1K`.
/// Order and values mirror Go exactly; commented-out (deprecated) Go entries
/// are omitted, matching Go's source.
pub const DEFAULT_MODEL_RATIO: &[(&str, f64)] = &[
    ("gpt-4-gizmo-*", 15.0),
    ("gpt-4o-gizmo-*", 2.5),
    ("gpt-4-all", 15.0),
    ("gpt-4o-all", 15.0),
    ("gpt-4", 15.0),
    ("gpt-4-0613", 15.0),
    ("gpt-4-32k", 30.0),
    ("gpt-4-32k-0613", 30.0),
    ("gpt-4-1106-preview", 5.0),
    ("gpt-4-0125-preview", 5.0),
    ("gpt-4-turbo-preview", 5.0),
    ("gpt-4-vision-preview", 5.0),
    ("gpt-4-1106-vision-preview", 5.0),
    ("chatgpt-4o-latest", 2.5),
    ("gpt-4o", 1.25),
    ("gpt-4o-audio-preview", 1.25),
    ("gpt-4o-audio-preview-2024-10-01", 1.25),
    ("gpt-4o-2024-05-13", 2.5),
    ("gpt-4o-2024-08-06", 1.25),
    ("gpt-4o-2024-11-20", 1.25),
    ("gpt-4o-realtime-preview", 2.5),
    ("gpt-4o-realtime-preview-2024-10-01", 2.5),
    ("gpt-4o-realtime-preview-2024-12-17", 2.5),
    ("gpt-4o-mini-realtime-preview", 0.3),
    ("gpt-4o-mini-realtime-preview-2024-12-17", 0.3),
    ("gpt-4.1", 1.0),
    ("gpt-4.1-2025-04-14", 1.0),
    ("gpt-4.1-mini", 0.2),
    ("gpt-4.1-mini-2025-04-14", 0.2),
    ("gpt-4.1-nano", 0.05),
    ("gpt-4.1-nano-2025-04-14", 0.05),
    ("gpt-image-1", 2.5),
    ("o1", 7.5),
    ("o1-2024-12-17", 7.5),
    ("o1-preview", 7.5),
    ("o1-preview-2024-09-12", 7.5),
    ("o1-mini", 0.55),
    ("o1-mini-2024-09-12", 0.55),
    ("o1-pro", 75.0),
    ("o1-pro-2025-03-19", 75.0),
    ("o3-mini", 0.55),
    ("o3-mini-2025-01-31", 0.55),
    ("o3-mini-high", 0.55),
    ("o3-mini-2025-01-31-high", 0.55),
    ("o3-mini-low", 0.55),
    ("o3-mini-2025-01-31-low", 0.55),
    ("o3-mini-medium", 0.55),
    ("o3-mini-2025-01-31-medium", 0.55),
    ("o3", 1.0),
    ("o3-2025-04-16", 1.0),
    ("o3-pro", 10.0),
    ("o3-pro-2025-06-10", 10.0),
    ("o3-deep-research", 5.0),
    ("o3-deep-research-2025-06-26", 5.0),
    ("o4-mini", 0.55),
    ("o4-mini-2025-04-16", 0.55),
    ("o4-mini-deep-research", 1.0),
    ("o4-mini-deep-research-2025-06-26", 1.0),
    ("gpt-4o-mini", 0.075),
    ("gpt-4o-mini-2024-07-18", 0.075),
    ("gpt-4-turbo", 5.0),
    ("gpt-4-turbo-2024-04-09", 5.0),
    ("gpt-4.5-preview", 37.5),
    ("gpt-4.5-preview-2025-02-27", 37.5),
    ("gpt-5", 0.625),
    ("gpt-5-2025-08-07", 0.625),
    ("gpt-5-chat-latest", 0.625),
    ("gpt-5-mini", 0.125),
    ("gpt-5-mini-2025-08-07", 0.125),
    ("gpt-5-nano", 0.025),
    ("gpt-5-nano-2025-08-07", 0.025),
    ("gpt-3.5-turbo", 0.25),
    ("gpt-3.5-turbo-0613", 0.75),
    ("gpt-3.5-turbo-16k", 1.5),
    ("gpt-3.5-turbo-16k-0613", 1.5),
    ("gpt-3.5-turbo-instruct", 0.75),
    ("gpt-3.5-turbo-1106", 0.5),
    ("gpt-3.5-turbo-0125", 0.25),
    ("babbage-002", 0.2),
    ("davinci-002", 1.0),
    ("text-ada-001", 0.2),
    ("text-babbage-001", 0.25),
    ("text-curie-001", 1.0),
    ("text-davinci-edit-001", 10.0),
    ("code-davinci-edit-001", 10.0),
    ("whisper-1", 15.0),
    ("tts-1", 7.5),
    ("tts-1-1106", 7.5),
    ("tts-1-hd", 15.0),
    ("tts-1-hd-1106", 15.0),
    ("davinci", 10.0),
    ("curie", 10.0),
    ("babbage", 10.0),
    ("ada", 10.0),
    ("text-embedding-3-small", 0.01),
    ("text-embedding-3-large", 0.065),
    ("text-embedding-ada-002", 0.05),
    ("text-search-ada-doc-001", 10.0),
    ("text-moderation-stable", 0.1),
    ("text-moderation-latest", 0.1),
    ("claude-3-haiku-20240307", 0.125),
    ("claude-3-5-haiku-20241022", 0.5),
    ("claude-haiku-4-5-20251001", 0.5),
    ("claude-3-sonnet-20240229", 1.5),
    ("claude-3-5-sonnet-20240620", 1.5),
    ("claude-3-5-sonnet-20241022", 1.5),
    ("claude-3-7-sonnet-20250219", 1.5),
    ("claude-3-7-sonnet-20250219-thinking", 1.5),
    ("claude-sonnet-4-20250514", 1.5),
    ("claude-sonnet-4-5-20250929", 1.5),
    ("claude-opus-4-5-20251101", 2.5),
    ("claude-opus-4-6", 2.5),
    ("claude-opus-4-6-max", 2.5),
    ("claude-opus-4-6-high", 2.5),
    ("claude-opus-4-6-medium", 2.5),
    ("claude-opus-4-6-low", 2.5),
    ("claude-opus-4-7", 2.5),
    ("claude-opus-4-7-max", 2.5),
    ("claude-opus-4-7-xhigh", 2.5),
    ("claude-opus-4-7-high", 2.5),
    ("claude-opus-4-7-medium", 2.5),
    ("claude-opus-4-7-low", 2.5),
    ("claude-opus-4-8", 2.5),
    ("claude-opus-4-8-max", 2.5),
    ("claude-opus-4-8-xhigh", 2.5),
    ("claude-opus-4-8-high", 2.5),
    ("claude-opus-4-8-medium", 2.5),
    ("claude-opus-4-8-low", 2.5),
    ("claude-3-opus-20240229", 7.5),
    ("claude-opus-4-20250514", 7.5),
    ("claude-opus-4-1-20250805", 7.5),
    ("ERNIE-4.0-8K", 0.120 * RMB),
    ("ERNIE-3.5-8K", 0.012 * RMB),
    ("ERNIE-3.5-8K-0205", 0.024 * RMB),
    ("ERNIE-3.5-8K-1222", 0.012 * RMB),
    ("ERNIE-Bot-8K", 0.024 * RMB),
    ("ERNIE-3.5-4K-0205", 0.012 * RMB),
    ("ERNIE-Speed-8K", 0.004 * RMB),
    ("ERNIE-Speed-128K", 0.004 * RMB),
    ("ERNIE-Lite-8K-0922", 0.008 * RMB),
    ("ERNIE-Lite-8K-0308", 0.003 * RMB),
    ("ERNIE-Tiny-8K", 0.001 * RMB),
    ("BLOOMZ-7B", 0.004 * RMB),
    ("Embedding-V1", 0.002 * RMB),
    ("bge-large-zh", 0.002 * RMB),
    ("bge-large-en", 0.002 * RMB),
    ("tao-8k", 0.002 * RMB),
    ("PaLM-2", 1.0),
    ("gemini-1.5-pro-latest", 1.25),
    ("gemini-1.5-flash-latest", 0.075),
    ("gemini-2.0-flash", 0.05),
    ("gemini-2.5-pro-exp-03-25", 0.625),
    ("gemini-2.5-pro-preview-03-25", 0.625),
    ("gemini-2.5-pro", 0.625),
    ("gemini-2.5-flash-preview-04-17", 0.075),
    ("gemini-2.5-flash-preview-04-17-thinking", 0.075),
    ("gemini-2.5-flash-preview-04-17-nothinking", 0.075),
    ("gemini-2.5-flash-preview-05-20", 0.075),
    ("gemini-2.5-flash-preview-05-20-thinking", 0.075),
    ("gemini-2.5-flash-preview-05-20-nothinking", 0.075),
    ("gemini-2.5-flash-thinking-*", 0.075),
    ("gemini-2.5-pro-thinking-*", 0.625),
    ("gemini-2.5-flash-lite-preview-thinking-*", 0.05),
    ("gemini-2.5-flash-lite-preview-06-17", 0.05),
    ("gemini-2.5-flash", 0.15),
    ("gemini-robotics-er-1.5-preview", 0.15),
    ("gemini-embedding-001", 0.075),
    ("text-embedding-004", 0.001),
    ("chatglm_turbo", 0.3572),
    ("chatglm_pro", 0.7143),
    ("chatglm_std", 0.3572),
    ("chatglm_lite", 0.1429),
    ("glm-4", 7.143),
    ("glm-4v", 0.05 * RMB),
    ("glm-4-alltools", 0.1 * RMB),
    ("glm-3-turbo", 0.3572),
    ("glm-4-plus", 0.05 * RMB),
    ("glm-4-0520", 0.1 * RMB),
    ("glm-4-air", 0.001 * RMB),
    ("glm-4-airx", 0.01 * RMB),
    ("glm-4-long", 0.001 * RMB),
    ("glm-4-flash", 0.0),
    ("glm-4v-plus", 0.01 * RMB),
    ("qwen-turbo", 0.8572),
    ("qwen-plus", 10.0),
    ("text-embedding-v1", 0.05),
    ("SparkDesk-v1.1", 1.2858),
    ("SparkDesk-v2.1", 1.2858),
    ("SparkDesk-v3.1", 1.2858),
    ("SparkDesk-v3.5", 1.2858),
    ("SparkDesk-v4.0", 1.2858),
    ("360GPT_S2_V9", 0.8572),
    ("360gpt-turbo", 0.0858),
    ("360gpt-turbo-responsibility-8k", 0.8572),
    ("360gpt-pro", 0.8572),
    ("360gpt2-pro", 0.8572),
    ("embedding-bert-512-v1", 0.0715),
    ("embedding_s1_v1", 0.0715),
    ("semantic_similarity_s1_v1", 0.0715),
    ("hunyuan", 7.143),
    ("yi-34b-chat-0205", 0.18),
    ("yi-34b-chat-200k", 0.864),
    ("yi-vl-plus", 0.432),
    ("yi-large", 20.0 / 1000.0 * RMB),
    ("yi-medium", 2.5 / 1000.0 * RMB),
    ("yi-vision", 6.0 / 1000.0 * RMB),
    ("yi-medium-200k", 12.0 / 1000.0 * RMB),
    ("yi-spark", 1.0 / 1000.0 * RMB),
    ("yi-large-rag", 25.0 / 1000.0 * RMB),
    ("yi-large-turbo", 12.0 / 1000.0 * RMB),
    ("yi-large-preview", 20.0 / 1000.0 * RMB),
    ("yi-large-rag-preview", 25.0 / 1000.0 * RMB),
    ("command", 0.5),
    ("command-nightly", 0.5),
    ("command-light", 0.5),
    ("command-light-nightly", 0.5),
    ("command-r", 0.25),
    ("command-r-plus", 1.5),
    ("command-r-08-2024", 0.075),
    ("command-r-plus-08-2024", 1.25),
    ("deepseek-chat", 0.27 / 2.0),
    ("deepseek-coder", 0.27 / 2.0),
    ("deepseek-reasoner", 0.55 / 2.0),
    ("llama-3-sonar-small-32k-chat", 0.2 / 1000.0 * USD),
    ("llama-3-sonar-small-32k-online", 0.2 / 1000.0 * USD),
    ("llama-3-sonar-large-32k-chat", 1.0 / 1000.0 * USD),
    ("llama-3-sonar-large-32k-online", 1.0 / 1000.0 * USD),
    ("grok-3-beta", 1.5),
    ("grok-3-mini-beta", 0.15),
    ("grok-2", 1.0),
    ("grok-2-vision", 1.0),
    ("grok-beta", 2.5),
    ("grok-vision-beta", 2.5),
    ("grok-3-fast-beta", 2.5),
    ("grok-3-mini-fast-beta", 0.3),
    ("NousResearch/Hermes-4-405B-FP8", 0.8),
    ("Qwen/Qwen3-235B-A22B-Thinking-2507", 0.6),
    ("Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8", 0.8),
    ("Qwen/Qwen3-235B-A22B-Instruct-2507", 0.3),
    ("zai-org/GLM-4.5-FP8", 0.8),
    ("openai/gpt-oss-120b", 0.5),
    ("deepseek-ai/DeepSeek-R1-0528", 0.8),
    ("deepseek-ai/DeepSeek-R1", 0.8),
    ("deepseek-ai/DeepSeek-V3-0324", 0.8),
    ("deepseek-ai/DeepSeek-V3.1", 0.8),
];

/// Default fixed per-request USD prices (Go `defaultModelPrice`). Mirrors Go.
pub const DEFAULT_MODEL_PRICE: &[(&str, f64)] = &[
    ("suno_music", 0.1),
    ("suno_lyrics", 0.01),
    ("dall-e-3", 0.04),
    ("imagen-3.0-generate-002", 0.03),
    ("black-forest-labs/flux-1.1-pro", 0.04),
    ("gpt-4-gizmo-*", 0.1),
    ("mj_video", 0.8),
    ("mj_imagine", 0.1),
    ("mj_edits", 0.1),
    ("mj_variation", 0.1),
    ("mj_reroll", 0.1),
    ("mj_blend", 0.1),
    ("mj_modal", 0.1),
    ("mj_zoom", 0.1),
    ("mj_shorten", 0.1),
    ("mj_high_variation", 0.1),
    ("mj_low_variation", 0.1),
    ("mj_pan", 0.1),
    ("mj_inpaint", 0.0),
    ("mj_custom_zoom", 0.0),
    ("mj_describe", 0.05),
    ("mj_upscale", 0.05),
    ("swap_face", 0.05),
    ("mj_upload", 0.05),
    ("sora-2", 0.3),
    ("sora-2-pro", 0.5),
    ("gpt-4o-mini-tts", 0.3),
    ("veo-3.0-generate-001", 0.4),
    ("veo-3.0-fast-generate-001", 0.15),
    ("veo-3.1-generate-preview", 0.4),
    ("veo-3.1-fast-generate-preview", 0.15),
];

/// Default completion-token ratios (Go `defaultCompletionRatio`). These are the
/// small operator-seed map (4 entries); the much larger per-model table lives
/// in `completion_ratio::hardcoded_completion_ratio`. Mirrors Go.
pub const DEFAULT_COMPLETION_RATIO: &[(&str, f64)] = &[
    ("gpt-4-gizmo-*", 2.0),
    ("gpt-4o-gizmo-*", 3.0),
    ("gpt-4-all", 2.0),
    ("gpt-image-1", 8.0),
];

/// Default cache-read ratios (Go `defaultCacheRatio`, `cache_ratio.go`).
/// Applied to cached prompt tokens. Mirrors Go.
pub const DEFAULT_CACHE_RATIO: &[(&str, f64)] = &[
    ("gemini-3-flash-preview", 0.1),
    ("gemini-3-pro-preview", 0.1),
    ("gemini-3.1-pro-preview", 0.1),
    ("gpt-4", 0.5),
    ("o1", 0.5),
    ("o1-2024-12-17", 0.5),
    ("o1-preview-2024-09-12", 0.5),
    ("o1-preview", 0.5),
    ("o1-mini-2024-09-12", 0.5),
    ("o1-mini", 0.5),
    ("o3-mini", 0.5),
    ("o3-mini-2025-01-31", 0.5),
    ("gpt-4o-2024-11-20", 0.5),
    ("gpt-4o-2024-08-06", 0.5),
    ("gpt-4o", 0.5),
    ("gpt-4o-mini-2024-07-18", 0.5),
    ("gpt-4o-mini", 0.5),
    ("gpt-4o-realtime-preview", 0.5),
    ("gpt-4o-mini-realtime-preview", 0.5),
    ("gpt-4.5-preview", 0.5),
    ("gpt-4.5-preview-2025-02-27", 0.5),
    ("gpt-4.1", 0.25),
    ("gpt-4.1-mini", 0.25),
    ("gpt-4.1-nano", 0.25),
    ("gpt-5", 0.1),
    ("gpt-5-2025-08-07", 0.1),
    ("gpt-5-chat-latest", 0.1),
    ("gpt-5-mini", 0.1),
    ("gpt-5-mini-2025-08-07", 0.1),
    ("gpt-5-nano", 0.1),
    ("gpt-5-nano-2025-08-07", 0.1),
    ("deepseek-chat", 0.25),
    ("deepseek-reasoner", 0.25),
    ("deepseek-coder", 0.25),
    ("claude-3-sonnet-20240229", 0.1),
    ("claude-3-opus-20240229", 0.1),
    ("claude-3-haiku-20240307", 0.1),
    ("claude-3-5-haiku-20241022", 0.1),
    ("claude-haiku-4-5-20251001", 0.1),
    ("claude-3-5-sonnet-20240620", 0.1),
    ("claude-3-5-sonnet-20241022", 0.1),
    ("claude-3-7-sonnet-20250219", 0.1),
    ("claude-3-7-sonnet-20250219-thinking", 0.1),
    ("claude-sonnet-4-20250514", 0.1),
    ("claude-sonnet-4-20250514-thinking", 0.1),
    ("claude-opus-4-20250514", 0.1),
    ("claude-opus-4-20250514-thinking", 0.1),
    ("claude-opus-4-1-20250805", 0.1),
    ("claude-opus-4-1-20250805-thinking", 0.1),
    ("claude-sonnet-4-5-20250929", 0.1),
    ("claude-sonnet-4-5-20250929-thinking", 0.1),
    ("claude-opus-4-5-20251101", 0.1),
    ("claude-opus-4-5-20251101-thinking", 0.1),
    ("claude-opus-4-6", 0.1),
    ("claude-opus-4-6-thinking", 0.1),
    ("claude-opus-4-6-max", 0.1),
    ("claude-opus-4-6-high", 0.1),
    ("claude-opus-4-6-medium", 0.1),
    ("claude-opus-4-6-low", 0.1),
    ("claude-opus-4-7", 0.1),
    ("claude-opus-4-7-thinking", 0.1),
    ("claude-opus-4-7-max", 0.1),
    ("claude-opus-4-7-xhigh", 0.1),
    ("claude-opus-4-7-high", 0.1),
    ("claude-opus-4-7-medium", 0.1),
    ("claude-opus-4-7-low", 0.1),
    ("claude-opus-4-8", 0.1),
    ("claude-opus-4-8-thinking", 0.1),
    ("claude-opus-4-8-max", 0.1),
    ("claude-opus-4-8-xhigh", 0.1),
    ("claude-opus-4-8-high", 0.1),
    ("claude-opus-4-8-medium", 0.1),
    ("claude-opus-4-8-low", 0.1),
];

/// Default cache-creation (cache-write) ratios (Go `defaultCreateCacheRatio`,
/// `cache_ratio.go`). Mirrors Go.
pub const DEFAULT_CREATE_CACHE_RATIO: &[(&str, f64)] = &[
    ("claude-3-sonnet-20240229", 1.25),
    ("claude-3-opus-20240229", 1.25),
    ("claude-3-haiku-20240307", 1.25),
    ("claude-3-5-haiku-20241022", 1.25),
    ("claude-haiku-4-5-20251001", 1.25),
    ("claude-3-5-sonnet-20240620", 1.25),
    ("claude-3-5-sonnet-20241022", 1.25),
    ("claude-3-7-sonnet-20250219", 1.25),
    ("claude-3-7-sonnet-20250219-thinking", 1.25),
    ("claude-sonnet-4-20250514", 1.25),
    ("claude-sonnet-4-20250514-thinking", 1.25),
    ("claude-opus-4-20250514", 1.25),
    ("claude-opus-4-20250514-thinking", 1.25),
    ("claude-opus-4-1-20250805", 1.25),
    ("claude-opus-4-1-20250805-thinking", 1.25),
    ("claude-sonnet-4-5-20250929", 1.25),
    ("claude-sonnet-4-5-20250929-thinking", 1.25),
    ("claude-opus-4-5-20251101", 1.25),
    ("claude-opus-4-5-20251101-thinking", 1.25),
    ("claude-opus-4-6", 1.25),
    ("claude-opus-4-6-thinking", 1.25),
    ("claude-opus-4-6-max", 1.25),
    ("claude-opus-4-6-high", 1.25),
    ("claude-opus-4-6-medium", 1.25),
    ("claude-opus-4-6-low", 1.25),
    ("claude-opus-4-7", 1.25),
    ("claude-opus-4-7-thinking", 1.25),
    ("claude-opus-4-7-max", 1.25),
    ("claude-opus-4-7-xhigh", 1.25),
    ("claude-opus-4-7-high", 1.25),
    ("claude-opus-4-7-medium", 1.25),
    ("claude-opus-4-7-low", 1.25),
    ("claude-opus-4-8", 1.25),
    ("claude-opus-4-8-thinking", 1.25),
    ("claude-opus-4-8-max", 1.25),
    ("claude-opus-4-8-xhigh", 1.25),
    ("claude-opus-4-8-high", 1.25),
    ("claude-opus-4-8-medium", 1.25),
    ("claude-opus-4-8-low", 1.25),
];

/// Default image-token ratios (Go `defaultImageRatio`, `model_ratio.go`).
/// Mirrors Go.
pub const DEFAULT_IMAGE_RATIO: &[(&str, f64)] = &[("gpt-image-1", 2.0)];

/// Default audio-token ratios (Go `defaultAudioRatio`, `model_ratio.go`).
/// Mirrors Go.
pub const DEFAULT_AUDIO_RATIO: &[(&str, f64)] = &[
    ("gpt-4o-audio-preview", 16.0),
    ("gpt-4o-mini-audio-preview", 66.67),
    ("gpt-4o-realtime-preview", 8.0),
    ("gpt-4o-mini-realtime-preview", 16.67),
    ("gpt-4o-mini-tts", 25.0),
];

/// Default audio-completion ratios (Go `defaultAudioCompletionRatio`,
/// `model_ratio.go`). Mirrors Go.
pub const DEFAULT_AUDIO_COMPLETION_RATIO: &[(&str, f64)] = &[
    ("gpt-4o-realtime", 2.0),
    ("gpt-4o-mini-realtime", 2.0),
    ("gpt-4o-mini-tts", 1.0),
    ("tts-1", 0.0),
    ("tts-1-hd", 0.0),
    ("tts-1-1106", 0.0),
    ("tts-1-hd-1106", 0.0),
];

/// Fixed ratio between the 1-hour and 5-minute Claude cache-creation prices.
/// Go `relay/helper/price.go::claudeCacheCreation1hMultiplier = 6 / 3.75`.
pub const CLAUDE_CACHE_CREATION_1H_MULTIPLIER: f64 = 6.0 / 3.75;

/// Linear scan over a `(name, value)` table. These tables are small enough
/// (the largest is ~250 entries) that a flat scan is cheaper than a `HashMap`
/// allocation on the Worker hot path, and keeps the module `const`/`no_std`-
/// friendly.
fn lookup(table: &[(&str, f64)], name: &str) -> Option<f64> {
    // `iter().find` short-circuits on the first match; values are unique by
    // key in the source tables.
    table.iter().find(|(k, _)| *k == name).map(|(_, v)| *v)
}

/// Default per-token prompt ratio for a model, or `None` if absent.
pub fn default_model_ratio(name: &str) -> Option<f64> {
    lookup(DEFAULT_MODEL_RATIO, name)
}

/// Default fixed per-request USD price for a model, or `None` if absent.
pub fn default_model_price(name: &str) -> Option<f64> {
    lookup(DEFAULT_MODEL_PRICE, name)
}

/// Default completion-token ratio for a model, or `None` if absent.
pub fn default_completion_ratio(name: &str) -> Option<f64> {
    lookup(DEFAULT_COMPLETION_RATIO, name)
}

/// Default cache-read ratio for a model, or `None` if absent.
pub fn default_cache_ratio(name: &str) -> Option<f64> {
    lookup(DEFAULT_CACHE_RATIO, name)
}

/// Default cache-creation (cache-write) ratio for a model, or `None` if absent.
pub fn default_create_cache_ratio(name: &str) -> Option<f64> {
    lookup(DEFAULT_CREATE_CACHE_RATIO, name)
}

/// Default image-token ratio for a model, or `None` if absent.
pub fn default_image_ratio(name: &str) -> Option<f64> {
    lookup(DEFAULT_IMAGE_RATIO, name)
}

/// Default audio-token ratio for a model, or `None` if absent.
pub fn default_audio_ratio(name: &str) -> Option<f64> {
    lookup(DEFAULT_AUDIO_RATIO, name)
}

/// Default audio-completion ratio for a model, or `None` if absent.
pub fn default_audio_completion_ratio(name: &str) -> Option<f64> {
    lookup(DEFAULT_AUDIO_COMPLETION_RATIO, name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tables_are_nonempty() {
        assert!(!DEFAULT_MODEL_RATIO.is_empty());
        assert!(!DEFAULT_MODEL_PRICE.is_empty());
        assert!(!DEFAULT_COMPLETION_RATIO.is_empty());
    }

    #[test]
    fn model_ratio_spot_checks() {
        // Representative entries across vendors (kept verbatim from Go).
        assert_eq!(default_model_ratio("gpt-4o"), Some(1.25));
        assert_eq!(default_model_ratio("claude-3-opus-20240229"), Some(7.5));
        assert_eq!(default_model_ratio("gemini-2.5-pro"), Some(0.625));
        assert_eq!(default_model_ratio("deepseek-chat"), Some(0.27 / 2.0));
        assert_eq!(default_model_ratio("gpt-4.5-preview"), Some(37.5));
        // glm-4-flash is explicitly free in Go.
        assert_eq!(default_model_ratio("glm-4-flash"), Some(0.0));
        // Unknown model.
        assert_eq!(default_model_ratio("does-not-exist"), None);
    }

    #[test]
    fn model_price_spot_checks() {
        assert_eq!(default_model_price("dall-e-3"), Some(0.04));
        assert_eq!(default_model_price("sora-2-pro"), Some(0.5));
        assert_eq!(default_model_price("gpt-4o"), None); // ratio-billed, not priced
    }

    #[test]
    fn completion_ratio_spot_checks() {
        assert_eq!(default_completion_ratio("gpt-image-1"), Some(8.0));
        assert_eq!(default_completion_ratio("gpt-4o-gizmo-*"), Some(3.0));
        assert_eq!(default_completion_ratio("gpt-4o"), None); // not in default map
    }

    #[test]
    fn rmb_currency_constants_match_go() {
        // Go: USD=500, USD2RMB=7.3, RMB=USD/USD2RMB.
        assert_eq!(USD, 500.0);
        assert_eq!(USD2RMB, 7.3);
        assert!((RMB - 68.4931506849315).abs() < 1e-9);
        // An RMB-derived entry resolves to the precomputed value.
        assert!((default_model_ratio("glm-4v").unwrap() - (0.05 * RMB)).abs() < 1e-12);
    }

    #[test]
    fn cache_ratio_spot_checks() {
        assert_eq!(default_cache_ratio("gpt-4o"), Some(0.5));
        assert_eq!(default_cache_ratio("gpt-4.1"), Some(0.25));
        assert_eq!(default_cache_ratio("claude-sonnet-4-20250514"), Some(0.1));
        assert_eq!(default_cache_ratio("deepseek-chat"), Some(0.25));
        assert_eq!(default_cache_ratio("unknown"), None);
    }

    #[test]
    fn create_cache_ratio_spot_checks() {
        // All entries are 1.25 (Claude cache-write default).
        assert_eq!(
            default_create_cache_ratio("claude-sonnet-4-20250514"),
            Some(1.25)
        );
        assert_eq!(
            default_create_cache_ratio("claude-opus-4-8-low"),
            Some(1.25)
        );
        // Non-Claude / unknown models have no default create-cache ratio.
        assert_eq!(default_create_cache_ratio("gpt-4o"), None);
    }

    #[test]
    fn image_and_audio_ratio_spot_checks() {
        assert_eq!(default_image_ratio("gpt-image-1"), Some(2.0));
        assert_eq!(default_image_ratio("gpt-4o"), None);
        assert_eq!(default_audio_ratio("gpt-4o-audio-preview"), Some(16.0));
        assert_eq!(default_audio_completion_ratio("gpt-4o-realtime"), Some(2.0));
        // tts models are priced at 0 completion (audio-only flat).
        assert_eq!(default_audio_completion_ratio("tts-1"), Some(0.0));
    }

    #[test]
    fn claude_cache_creation_1h_multiplier_matches_go() {
        // Go: 6 / 3.75 = 1.6.
        assert!((CLAUDE_CACHE_CREATION_1H_MULTIPLIER - 1.6).abs() < 1e-9);
    }
}
