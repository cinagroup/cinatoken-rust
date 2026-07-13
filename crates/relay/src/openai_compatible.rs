use std::collections::HashMap;

use serde_json::Value;

pub const CHANNEL_TYPE_OPENAI: i32 = 1;
pub const CHANNEL_TYPE_BAIDU: i32 = 15;
pub const CHANNEL_TYPE_ZHIPU: i32 = 16;
pub const CHANNEL_TYPE_ALI: i32 = 17;
pub const CHANNEL_TYPE_OPENROUTER: i32 = 20;
pub const CHANNEL_TYPE_TENCENT: i32 = 23;
pub const CHANNEL_TYPE_MOONSHOT: i32 = 25;
pub const CHANNEL_TYPE_ZHIPU_V4: i32 = 26;
pub const CHANNEL_TYPE_PERPLEXITY: i32 = 27;
pub const CHANNEL_TYPE_LINGYIWANWU: i32 = 31;
pub const CHANNEL_TYPE_SILICONFLOW: i32 = 40;
pub const CHANNEL_TYPE_MISTRAL: i32 = 42;
pub const CHANNEL_TYPE_DEEPSEEK: i32 = 43;
pub const CHANNEL_TYPE_MOKAAI: i32 = 44;
pub const CHANNEL_TYPE_VOLCENGINE: i32 = 45;
pub const CHANNEL_TYPE_BAIDU_V2: i32 = 46;
/// Cloudflare Workers AI (Go `ChannelCloudflare`). Speaks the OpenAI wire
/// format via the Workers AI REST endpoint (`{account base}/ai/v1/...`, the
/// account-scoped base configured on the channel) or an AI Gateway workers-ai
/// route; the worker additionally executes these channels natively over the
/// `AI` binding when the channel key is `internal` (see
/// `relay.rs::forward_workers_ai_binding`).
pub const CHANNEL_TYPE_CLOUDFLARE: i32 = 39;
pub const CHANNEL_TYPE_XAI: i32 = 48;
pub const CHANNEL_TYPE_SUBMODEL: i32 = 53;

// Channel types that the Go source actually routes through its generic OpenAI
// adaptor. Dedicated providers must not be added merely because their wire
// format looks OpenAI-compatible; they require an explicit Rust capability and
// adapter contract first.
pub const OPENAI_COMPATIBLE_CHANNEL_TYPES: &[i32] = &[
    1,  // OpenAI
    3,  // Azure
    6,  // OpenAIMax
    7,  // OhMyGPT
    8,  // Custom
    9,  // AILS
    10, // AIProxy
    12, // API2GPT
    13, // AIGC2D
    19, // 360
    20, // OpenRouter (explicit Go mapping to generic OpenAI)
    22, // FastGPT
    31, // LingYiWanWu
    47, // Xinference (explicit Go mapping to generic OpenAI)
];
pub const CHANNEL_TYPE_COHERE: i32 = 34;
pub const CHANNEL_TYPE_JINA: i32 = 38;
pub const RERANK_CHANNEL_TYPES: &[i32] = &[CHANNEL_TYPE_JINA, CHANNEL_TYPE_COHERE];
pub const CHANNEL_TYPE_ANTHROPIC: i32 = 14;
pub const ANTHROPIC_CHANNEL_TYPES: &[i32] = &[CHANNEL_TYPE_ANTHROPIC];
pub const CHANNEL_TYPE_GEMINI: i32 = 24;
pub const GEMINI_CHANNEL_TYPES: &[i32] = &[CHANNEL_TYPE_GEMINI];

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct UsageSummary {
    pub prompt_tokens: i32,
    pub completion_tokens: i32,
    pub total_tokens: i32,
    pub cached_tokens: i32,
    pub cache_creation_tokens: i32,
    pub claude_cache_creation_5m_tokens: i32,
    pub claude_cache_creation_1h_tokens: i32,
    pub image_input_tokens: i32,
    pub image_output_tokens: i32,
    pub audio_input_tokens: i32,
    pub audio_output_tokens: i32,
    pub is_anthropic_usage_semantic: bool,
}

pub fn is_openai_compatible_channel_type(channel_type: i32) -> bool {
    channel_type_supported(channel_type, OPENAI_COMPATIBLE_CHANNEL_TYPES)
}

pub fn is_rerank_channel_type(channel_type: i32) -> bool {
    channel_type_supported(channel_type, RERANK_CHANNEL_TYPES)
}

pub fn is_anthropic_channel_type(channel_type: i32) -> bool {
    channel_type_supported(channel_type, ANTHROPIC_CHANNEL_TYPES)
}

pub fn is_gemini_channel_type(channel_type: i32) -> bool {
    channel_type_supported(channel_type, GEMINI_CHANNEL_TYPES)
}

pub fn channel_type_supported(channel_type: i32, supported_channel_types: &[i32]) -> bool {
    supported_channel_types.contains(&channel_type)
}

/// Channel types that honor the OpenAI `stream_options` request field — a
/// faithful port of Go `relay/common.streamSupportedChannels`. For a streaming
/// request to one of these, the relay forces `stream_options.include_usage=true`
/// so the upstream emits a final usage chunk (real usage for settlement, instead
/// of the local estimate). For every other channel — and for non-streaming
/// requests — `stream_options` is stripped so upstreams that reject it don't error.
pub const STREAM_OPTIONS_SUPPORTED_CHANNEL_TYPES: &[i32] = &[
    1,  // OpenAI
    3,  // Azure
    4,  // Ollama
    14, // Anthropic
    17, // Ali
    24, // Gemini
    25, // Moonshot
    26, // Zhipu v4
    33, // AWS
    35, // MiniMax
    39, // Cloudflare
    40, // SiliconFlow
    43, // DeepSeek
    45, // VolcEngine
    46, // Baidu v2
    48, // xAI
    53, // Submodel
    57, // Codex
];

/// Whether `channel_type` honors the OpenAI `stream_options` request field.
pub fn channel_supports_stream_options(channel_type: i32) -> bool {
    STREAM_OPTIONS_SUPPORTED_CHANNEL_TYPES.contains(&channel_type)
}

/// Inject or strip the OpenAI `stream_options` request field, a faithful port of
/// Go `openai/adaptor.go` (inject) + `compatible_handler.go` (strip). On a
/// streaming request to a channel that supports it, force
/// `stream_options.include_usage = true` (replacing any client value) so the
/// upstream emits a final usage chunk. Otherwise — unsupported channel or a
/// non-streaming request — remove `stream_options` entirely. No-op on a
/// non-object body.
pub fn apply_stream_options(body: &mut Value, channel_type: i32, is_stream: bool) {
    let Some(map) = body.as_object_mut() else {
        return;
    };
    if is_stream && channel_supports_stream_options(channel_type) {
        map.insert(
            "stream_options".to_string(),
            serde_json::json!({ "include_usage": true }),
        );
    } else {
        map.remove("stream_options");
    }
}

pub fn csv_contains(csv: &str, needle: &str) -> bool {
    let needle = needle.trim();
    csv.split(',')
        .map(str::trim)
        .any(|item| item.eq_ignore_ascii_case(needle))
}

/// Whether `client_ip` is permitted by a token's `allow_ips` list.
///
/// Mirrors Go `middleware.TokenAuth`'s `common.IsIpInCIDRList`: an empty list
/// allows all; otherwise each entry is a `*` wildcard, a CIDR range
/// (`10.0.0.0/8`), or a bare IP literal. The client IP is parsed once and
/// compared by value (so IPv6 spellings normalize) and tested for CIDR
/// membership. A client IP that does not parse is denied, matching Go's
/// `net.ParseIP(...) == nil -> 403`.
pub fn ip_allowlist_matches(allow_ips: &str, client_ip: Option<&str>) -> bool {
    let allow_ips = allow_ips.trim();
    if allow_ips.is_empty() {
        return true;
    }
    let Some(client_ip) = client_ip.map(str::trim).filter(|value| !value.is_empty()) else {
        return false;
    };
    let Ok(client_addr) = client_ip.parse::<std::net::IpAddr>() else {
        return false;
    };
    allow_ips
        .lines()
        .flat_map(|line| line.split(','))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .any(|allowed| {
            if allowed == "*" {
                return true;
            }
            // CIDR range (e.g. `10.0.0.0/8`) — the common Go allowlist form.
            if let Ok(net) = allowed.parse::<ipnet::IpNet>() {
                return net.contains(&client_addr);
            }
            // Bare IP literal — value comparison normalizes IPv6 spellings.
            matches!(allowed.parse::<std::net::IpAddr>(), Ok(addr) if addr == client_addr)
        })
}

pub fn first_channel_key(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with('[') {
        if let Ok(values) = serde_json::from_str::<Vec<Value>>(trimmed) {
            return values
                .into_iter()
                .filter_map(|value| value.as_str().map(str::to_string))
                .find(|value| !value.trim().is_empty());
        }
    }
    trimmed
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

pub fn upstream_chat_url(channel_type: i32, base_url: Option<&str>) -> String {
    upstream_v1_url(channel_type, base_url, "chat/completions")
}

pub fn upstream_v1_url(channel_type: i32, base_url: Option<&str>, endpoint_path: &str) -> String {
    let endpoint_path = endpoint_path.trim().trim_start_matches('/');
    let base = base_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| default_base_url(channel_type).to_string());
    let base = base.trim_end_matches('/');
    // Honor provider-supplied version path segments like `/v1`, `/v2`, or
    // Zhipu's `/v4` rather than blindly appending another `/v1`. Mirrors Go's
    // behavior where a channel base_url that already ends with a version
    // segment is treated as the full API root.
    if has_trailing_version_segment(base) {
        format!("{base}/{endpoint_path}")
    } else {
        format!("{base}/v1/{endpoint_path}")
    }
}

fn has_trailing_version_segment(base: &str) -> bool {
    let Some(segment) = base.rsplit('/').next() else {
        return false;
    };
    let Some(rest) = segment.strip_prefix('v') else {
        return false;
    };
    !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit())
}

pub fn upstream_anthropic_messages_url(base_url: Option<&str>) -> String {
    let base = base_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("https://api.anthropic.com");
    let base = base.trim_end_matches('/');
    if base.ends_with("/v1") {
        format!("{base}/messages")
    } else {
        format!("{base}/v1/messages")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeminiNativePath {
    pub api_version: String,
    pub model: String,
    pub action: String,
}

impl GeminiNativePath {
    pub fn is_stream_generate_content(&self) -> bool {
        self.action.eq_ignore_ascii_case("streamGenerateContent")
    }

    pub fn is_generate_content(&self) -> bool {
        self.action.eq_ignore_ascii_case("generateContent")
    }

    pub fn is_embed_content(&self) -> bool {
        self.action.eq_ignore_ascii_case("embedContent")
    }

    pub fn is_batch_embed_contents(&self) -> bool {
        self.action.eq_ignore_ascii_case("batchEmbedContents")
    }

    pub fn is_count_tokens(&self) -> bool {
        self.action.eq_ignore_ascii_case("countTokens")
    }

    pub fn is_supported_generate_content(&self) -> bool {
        self.is_generate_content() || self.is_stream_generate_content()
    }

    pub fn is_supported_native_passthrough(&self) -> bool {
        self.is_supported_generate_content()
            || self.is_embed_content()
            || self.is_batch_embed_contents()
            || self.is_count_tokens()
    }

    pub fn upstream_path(&self) -> String {
        format!("{}/models/{}:{}", self.api_version, self.model, self.action)
    }
}

pub fn parse_gemini_native_path(path: &str) -> Option<GeminiNativePath> {
    let path = path.trim();
    let (api_version, rest) = path
        .strip_prefix("/v1beta/models/")
        .map(|rest| ("v1beta", rest))
        .or_else(|| path.strip_prefix("/v1/models/").map(|rest| ("v1", rest)))?;
    let (model, action) = rest.split_once(':')?;
    let model = model.trim();
    let action = action.trim();
    if model.is_empty() || action.is_empty() || action.contains('/') {
        return None;
    }
    Some(GeminiNativePath {
        api_version: api_version.to_string(),
        model: model.to_string(),
        action: action.to_string(),
    })
}

pub fn upstream_gemini_native_url(
    base_url: Option<&str>,
    route: &GeminiNativePath,
    query: Option<&str>,
) -> String {
    let base = base_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(default_base_url(CHANNEL_TYPE_GEMINI));
    let mut url = format!("{}/{}", base.trim_end_matches('/'), route.upstream_path());
    let query = gemini_upstream_query(query, route.is_stream_generate_content());
    if !query.is_empty() {
        url.push('?');
        url.push_str(&query);
    }
    url
}

pub fn default_base_url(channel_type: i32) -> &'static str {
    match channel_type {
        CHANNEL_TYPE_BAIDU => "https://qianfan.baidubce.com/v2",
        CHANNEL_TYPE_ZHIPU => "https://open.bigmodel.cn/api/paas/v4",
        CHANNEL_TYPE_ZHIPU_V4 => "https://open.bigmodel.cn/api/paas/v4",
        CHANNEL_TYPE_ALI => "https://dashscope.aliyuncs.com/compatible-mode/v1",
        CHANNEL_TYPE_OPENROUTER => "https://openrouter.ai/api",
        CHANNEL_TYPE_MOONSHOT => "https://api.moonshot.cn",
        CHANNEL_TYPE_PERPLEXITY => "https://api.perplexity.ai",
        CHANNEL_TYPE_LINGYIWANWU => "https://api.lingyiwanwu.com",
        CHANNEL_TYPE_SILICONFLOW => "https://api.siliconflow.cn",
        CHANNEL_TYPE_MISTRAL => "https://api.mistral.ai",
        CHANNEL_TYPE_DEEPSEEK => "https://api.deepseek.com",
        CHANNEL_TYPE_MOKAAI => "https://api.moka.ai",
        CHANNEL_TYPE_XAI => "https://api.x.ai",
        CHANNEL_TYPE_SUBMODEL => "https://llm.submodel.ai",
        // Cloudflare Workers AI: the account-scoped OpenAI-compatible root is
        // `https://api.cloudflare.com/client/v4/accounts/{account}/ai`, which
        // must be configured per channel (there is no account-independent
        // default). Go likewise defaults ChannelCloudflare to the API host.
        CHANNEL_TYPE_CLOUDFLARE => "https://api.cloudflare.com",
        CHANNEL_TYPE_COHERE => "https://api.cohere.ai",
        CHANNEL_TYPE_JINA => "https://api.jina.ai",
        CHANNEL_TYPE_GEMINI => "https://generativelanguage.googleapis.com",
        _ => "https://api.openai.com",
    }
}

pub fn apply_model_mapping(body: &mut Value, model: &str, mapping: Option<&str>) {
    let Some(mapped_model) = mapped_model_name(model, mapping) else {
        return;
    };
    if let Some(obj) = body.as_object_mut() {
        obj.insert("model".to_string(), Value::String(mapped_model));
    }
}

pub fn apply_gemini_native_model_mapping(body: &mut Value, model: &str, mapped_model: &str) {
    if model.trim().is_empty() || mapped_model.trim().is_empty() || model == mapped_model {
        return;
    }
    apply_gemini_native_model_value_mapping(body, model, mapped_model);
}

pub fn mapped_model_name(model: &str, mapping: Option<&str>) -> Option<String> {
    let mapping = mapping.map(str::trim).filter(|value| !value.is_empty())?;
    let map = serde_json::from_str::<HashMap<String, String>>(mapping).ok()?;
    map.get(model)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn apply_gemini_native_model_value_mapping(value: &mut Value, model: &str, mapped_model: &str) {
    match value {
        Value::Object(obj) => {
            if let Some(Value::String(body_model)) = obj.get_mut("model") {
                if body_model == model {
                    *body_model = mapped_model.to_string();
                } else if body_model == &format!("models/{model}") {
                    *body_model = format!("models/{mapped_model}");
                }
            }
            for nested in obj.values_mut() {
                apply_gemini_native_model_value_mapping(nested, model, mapped_model);
            }
        }
        Value::Array(values) => {
            for nested in values {
                apply_gemini_native_model_value_mapping(nested, model, mapped_model);
            }
        }
        _ => {}
    }
}

pub fn usage_summary_from_body(body: &str) -> UsageSummary {
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return UsageSummary::default();
    };
    usage_summary_from_value(&value).unwrap_or_default()
}

pub fn usage_summary_from_rerank_body(body: &str) -> UsageSummary {
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return UsageSummary::default();
    };
    usage_summary_from_cohere_rerank_value(&value)
        .or_else(|| usage_summary_from_jina_rerank_value(&value))
        .or_else(|| usage_summary_from_value(&value))
        .unwrap_or_default()
}

pub fn usage_summary_from_anthropic_body(body: &str) -> UsageSummary {
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return UsageSummary::default();
    };
    usage_summary_from_value(&value)
        .map(mark_anthropic_usage_semantic)
        .unwrap_or_default()
}

pub fn usage_summary_from_moonshot_body(body: &str) -> UsageSummary {
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return UsageSummary::default();
    };
    usage_summary_from_moonshot_value(&value).unwrap_or_default()
}

pub fn usage_summary_from_sse_stream(body: &str) -> UsageSummary {
    let mut accumulator = SseUsageAccumulator::default();
    accumulator.push_chunk(body.as_bytes());
    accumulator.finish()
}

pub fn usage_summary_from_anthropic_sse_stream(body: &str) -> UsageSummary {
    let mut accumulator = SseUsageAccumulator::anthropic();
    accumulator.push_chunk(body.as_bytes());
    accumulator.finish()
}

pub fn usage_summary_from_moonshot_sse_stream(body: &str) -> UsageSummary {
    let mut accumulator = SseUsageAccumulator::moonshot();
    accumulator.push_chunk(body.as_bytes());
    accumulator.finish()
}

pub fn usage_summary_from_gemini_body(body: &str) -> UsageSummary {
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return UsageSummary::default();
    };
    usage_summary_from_gemini_value(&value).unwrap_or_default()
}

pub fn usage_summary_from_gemini_sse_stream(body: &str) -> UsageSummary {
    let mut accumulator = SseUsageAccumulator::gemini();
    accumulator.push_chunk(body.as_bytes());
    accumulator.finish()
}

#[derive(Debug, Default)]
pub struct SseUsageAccumulator {
    latest: UsageSummary,
    pending_line: Vec<u8>,
    data_lines: Vec<String>,
    mode: SseUsageMode,
    /// Accumulated streamed completion text (OpenAI mode only) — used to
    /// estimate usage when the upstream stream omits a `usage` block. Faithful
    /// to Go `ProcessStreamResponse`: `delta.content` + `delta.reasoning_content`
    /// + each tool call's `function.name`/`function.arguments`.
    response_text: String,
    /// The largest `len(delta.tool_calls)` seen across the stream (Go uses a
    /// running max, not a sum). Feeds the `toolCount * 7` completion bump.
    tool_count: i64,
}

impl SseUsageAccumulator {
    pub fn anthropic() -> Self {
        Self {
            mode: SseUsageMode::Anthropic,
            ..Self::default()
        }
    }

    pub fn gemini() -> Self {
        Self {
            mode: SseUsageMode::Gemini,
            ..Self::default()
        }
    }

    pub fn moonshot() -> Self {
        Self {
            mode: SseUsageMode::Moonshot,
            ..Self::default()
        }
    }

    pub fn push_chunk(&mut self, chunk: &[u8]) {
        self.pending_line.extend_from_slice(chunk);

        while let Some(newline) = self.pending_line.iter().position(|byte| *byte == b'\n') {
            let mut line = self.pending_line.drain(..=newline).collect::<Vec<_>>();
            if line.last() == Some(&b'\n') {
                line.pop();
            }
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            self.push_line(&line);
        }
    }

    pub fn finish(self) -> UsageSummary {
        self.into_parts().0
    }

    /// Flush any buffered data and return the parsed usage together with the
    /// accumulated streamed completion text and tool-call count. Callers that
    /// need the missing-usage estimate fallback use this; [`Self::finish`] is the
    /// thin wrapper for callers that only want the usage.
    pub fn into_parts(mut self) -> (UsageSummary, String, i64) {
        if !self.pending_line.is_empty() {
            let line = std::mem::take(&mut self.pending_line);
            self.push_line(&line);
        }
        self.flush_event();
        (self.latest, self.response_text, self.tool_count)
    }

    fn push_line(&mut self, line: &[u8]) {
        let line = String::from_utf8_lossy(line);
        if line.trim().is_empty() {
            self.flush_event();
            return;
        }

        if let Some(data) = line.strip_prefix("data:") {
            self.data_lines.push(data.trim_start().to_string());
        }
    }

    fn flush_event(&mut self) {
        match self.mode {
            SseUsageMode::OpenAi => {
                if let Some(summary) = usage_summary_from_sse_data_lines(&self.data_lines, false) {
                    self.latest = summary;
                }
                accumulate_openai_stream_text(
                    &self.data_lines,
                    &mut self.response_text,
                    &mut self.tool_count,
                );
            }
            SseUsageMode::Anthropic => {
                if let Some(summary) = usage_summary_from_sse_data_lines(&self.data_lines, true) {
                    self.latest = merge_anthropic_stream_usage(self.latest, summary);
                }
            }
            SseUsageMode::Moonshot => {
                if let Some(summary) = usage_summary_from_moonshot_sse_data_lines(&self.data_lines)
                {
                    self.latest = merge_moonshot_stream_usage(self.latest, summary);
                }
                accumulate_openai_stream_text(
                    &self.data_lines,
                    &mut self.response_text,
                    &mut self.tool_count,
                );
            }
            SseUsageMode::Gemini => {
                if let Some(summary) = usage_summary_from_gemini_sse_data_lines(&self.data_lines) {
                    self.latest = summary;
                }
            }
        }
        self.data_lines.clear();
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum SseUsageMode {
    #[default]
    OpenAi,
    Anthropic,
    Moonshot,
    Gemini,
}

fn usage_summary_from_value(value: &Value) -> Option<UsageSummary> {
    let usage = value
        .get("usage")
        .or_else(|| {
            value
                .get("response")
                .and_then(|response| response.get("usage"))
        })
        .or_else(|| {
            value
                .get("message")
                .and_then(|message| message.get("usage"))
        })?;

    let prompt_tokens = first_i32_field(usage, &["prompt_tokens", "input_tokens"]);
    let completion_tokens = first_i32_field(usage, &["completion_tokens", "output_tokens"]);
    let total_tokens = first_i32_field(usage, &["total_tokens"])
        .max(prompt_tokens.saturating_add(completion_tokens));
    let input_token_detail_keys = [
        "prompt_tokens_details",
        "input_tokens_details",
        "input_token_details",
    ];
    let output_token_detail_keys = [
        "completion_tokens_details",
        "output_tokens_details",
        "output_token_details",
    ];
    let cached_tokens = first_non_zero_i32(&[
        nested_i32_field(usage, &input_token_detail_keys, &["cached_tokens"]),
        first_i32_field(usage, &["cache_read_input_tokens"]),
        first_i32_field(usage, &["prompt_cache_hit_tokens"]),
    ]);
    let cache_creation_tokens = first_non_zero_i32(&[
        nested_i32_field(usage, &input_token_detail_keys, &["cached_creation_tokens"]),
        first_i32_field(usage, &["cache_creation_input_tokens"]),
        nested_i32_field(usage, &["cache_creation"], &["ephemeral_5m_input_tokens"])
            .saturating_add(nested_i32_field(
                usage,
                &["cache_creation"],
                &["ephemeral_1h_input_tokens"],
            )),
    ]);
    let claude_cache_creation_5m_tokens = first_i32_field(
        usage,
        &[
            "claude_cache_creation_5_m_tokens",
            "claude_cache_creation_5m_tokens",
        ],
    )
    .max(nested_i32_field(
        usage,
        &["cache_creation"],
        &["ephemeral_5m_input_tokens"],
    ));
    let claude_cache_creation_1h_tokens = first_i32_field(
        usage,
        &[
            "claude_cache_creation_1_h_tokens",
            "claude_cache_creation_1h_tokens",
        ],
    )
    .max(nested_i32_field(
        usage,
        &["cache_creation"],
        &["ephemeral_1h_input_tokens"],
    ));
    let image_input_tokens = nested_i32_field(usage, &input_token_detail_keys, &["image_tokens"]);
    let audio_input_tokens = nested_i32_field(usage, &input_token_detail_keys, &["audio_tokens"]);
    let mut image_output_tokens = first_non_zero_i32(&[
        nested_i32_field(usage, &output_token_detail_keys, &["image_tokens"]),
        nested_i32_field(usage, &["output_tokens_details"], &["image_tokens"]),
    ]);
    if image_output_tokens <= 0 && is_image_generation_usage_value(value) {
        image_output_tokens = first_i32_field(usage, &["output_tokens"]);
    }
    let audio_output_tokens = nested_i32_field(usage, &output_token_detail_keys, &["audio_tokens"]);
    let is_anthropic_usage_semantic = usage
        .get("usage_semantic")
        .and_then(Value::as_str)
        .is_some_and(|value| value.eq_ignore_ascii_case("anthropic"));

    Some(UsageSummary {
        prompt_tokens,
        completion_tokens,
        total_tokens,
        cached_tokens,
        cache_creation_tokens,
        claude_cache_creation_5m_tokens,
        claude_cache_creation_1h_tokens,
        image_input_tokens,
        image_output_tokens,
        audio_input_tokens,
        audio_output_tokens,
        is_anthropic_usage_semantic,
    })
}

fn usage_summary_from_moonshot_value(value: &Value) -> Option<UsageSummary> {
    let mut summary = usage_summary_from_value(value).unwrap_or_default();
    let top_level_usage = value.get("usage");
    let cached_tokens = first_non_zero_i32(&[
        top_level_usage
            .map(|usage| nested_i32_field(usage, &["prompt_tokens_details"], &["cached_tokens"]))
            .unwrap_or_default(),
        top_level_usage
            .map(|usage| nested_i32_field(usage, &["input_tokens_details"], &["cached_tokens"]))
            .unwrap_or_default(),
        value
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| {
                choices.iter().find_map(|choice| {
                    choice
                        .get("usage")
                        .map(|usage| first_i32_field(usage, &["cached_tokens"]))
                        .filter(|tokens| *tokens > 0)
                })
            })
            .unwrap_or_default(),
        top_level_usage
            .map(|usage| first_i32_field(usage, &["cached_tokens"]))
            .unwrap_or_default(),
        top_level_usage
            .map(|usage| first_i32_field(usage, &["prompt_cache_hit_tokens"]))
            .unwrap_or_default(),
    ]);
    summary.cached_tokens = cached_tokens;
    (summary != UsageSummary::default()).then_some(summary)
}

fn usage_summary_from_jina_rerank_value(value: &Value) -> Option<UsageSummary> {
    let usage = value.get("usage")?;
    let total_tokens = first_i32_field(usage, &["total_tokens"]);
    if total_tokens <= 0 {
        return None;
    }
    Some(UsageSummary {
        prompt_tokens: total_tokens,
        total_tokens,
        ..UsageSummary::default()
    })
}

fn usage_summary_from_cohere_rerank_value(value: &Value) -> Option<UsageSummary> {
    let billed_units = value.get("meta")?.get("billed_units")?;
    let prompt_tokens = first_i32_field(billed_units, &["input_tokens"]);
    let completion_tokens = first_i32_field(billed_units, &["output_tokens"]);
    let total_tokens = prompt_tokens.saturating_add(completion_tokens);
    if total_tokens > 0 {
        return Some(UsageSummary {
            prompt_tokens,
            completion_tokens,
            total_tokens,
            ..UsageSummary::default()
        });
    }

    let search_units = first_i32_field(billed_units, &["search_units"]);
    if search_units > 0 {
        return Some(UsageSummary {
            prompt_tokens: search_units,
            total_tokens: search_units,
            ..UsageSummary::default()
        });
    }
    None
}

fn is_image_generation_usage_value(value: &Value) -> bool {
    let has_completed_event_type = value
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|value| {
            matches!(value, "image_generation.completed" | "image_edit.completed")
        });
    let has_images_response_usage = value.get("data").is_some_and(Value::is_array)
        && value
            .get("usage")
            .and_then(|usage| usage.get("input_tokens_details"))
            .and_then(|details| details.get("image_tokens"))
            .is_some();

    has_completed_event_type || has_images_response_usage
}

fn usage_summary_from_gemini_value(value: &Value) -> Option<UsageSummary> {
    let Some(metadata) = value.get("usageMetadata") else {
        return usage_summary_from_gemini_count_tokens_value(value);
    };
    usage_summary_from_gemini_usage_metadata(metadata)
}

fn usage_summary_from_gemini_usage_metadata(metadata: &Value) -> Option<UsageSummary> {
    let prompt_tokens = first_i32_field(metadata, &["promptTokenCount"])
        .saturating_add(first_i32_field(metadata, &["toolUsePromptTokenCount"]));
    let mut completion_tokens = first_i32_field(metadata, &["candidatesTokenCount"])
        .saturating_add(first_i32_field(metadata, &["thoughtsTokenCount"]));
    let mut total_tokens = first_i32_field(metadata, &["totalTokenCount"])
        .max(prompt_tokens.saturating_add(completion_tokens));
    if completion_tokens <= 0 && total_tokens > prompt_tokens {
        completion_tokens = total_tokens.saturating_sub(prompt_tokens);
    }
    total_tokens = total_tokens.max(prompt_tokens.saturating_add(completion_tokens));

    let (image_input_tokens, audio_input_tokens) = gemini_input_modality_tokens(metadata);
    let (image_output_tokens, audio_output_tokens) =
        gemini_modality_tokens(metadata.get("candidatesTokensDetails"));

    Some(UsageSummary {
        prompt_tokens,
        completion_tokens,
        total_tokens,
        cached_tokens: first_i32_field(metadata, &["cachedContentTokenCount"]),
        image_input_tokens,
        image_output_tokens,
        audio_input_tokens,
        audio_output_tokens,
        ..UsageSummary::default()
    })
}

fn usage_summary_from_gemini_count_tokens_value(value: &Value) -> Option<UsageSummary> {
    let total_tokens = first_i32_field_value(value, &["totalTokens"])?;
    let cached_tokens = first_i32_field(value, &["cachedContentTokenCount"]);
    let (image_input_tokens, audio_input_tokens) =
        gemini_modality_tokens(value.get("promptTokensDetails"));

    Some(UsageSummary {
        prompt_tokens: total_tokens,
        completion_tokens: 0,
        total_tokens,
        cached_tokens,
        image_input_tokens,
        audio_input_tokens,
        ..UsageSummary::default()
    })
}

fn usage_summary_from_sse_data_lines(
    data_lines: &[String],
    anthropic_semantics: bool,
) -> Option<UsageSummary> {
    if data_lines.is_empty() {
        return None;
    }

    let payload = data_lines.join("\n");
    let payload = payload.trim();
    if payload.is_empty() || payload == "[DONE]" {
        return None;
    }

    let value = serde_json::from_str::<Value>(payload).ok()?;
    let usage = usage_summary_from_value(&value)?;
    Some(if anthropic_semantics {
        mark_anthropic_usage_semantic(usage)
    } else {
        usage
    })
}

fn usage_summary_from_moonshot_sse_data_lines(data_lines: &[String]) -> Option<UsageSummary> {
    if data_lines.is_empty() {
        return None;
    }
    let payload = data_lines.join("\n");
    let payload = payload.trim();
    if payload.is_empty() || payload == "[DONE]" {
        return None;
    }
    let value = serde_json::from_str::<Value>(payload).ok()?;
    usage_summary_from_moonshot_value(&value)
}

fn merge_moonshot_stream_usage(previous: UsageSummary, current: UsageSummary) -> UsageSummary {
    UsageSummary {
        prompt_tokens: non_zero_or(current.prompt_tokens, previous.prompt_tokens),
        completion_tokens: non_zero_or(current.completion_tokens, previous.completion_tokens),
        total_tokens: non_zero_or(current.total_tokens, previous.total_tokens),
        cached_tokens: non_zero_or(current.cached_tokens, previous.cached_tokens),
        cache_creation_tokens: non_zero_or(
            current.cache_creation_tokens,
            previous.cache_creation_tokens,
        ),
        claude_cache_creation_5m_tokens: non_zero_or(
            current.claude_cache_creation_5m_tokens,
            previous.claude_cache_creation_5m_tokens,
        ),
        claude_cache_creation_1h_tokens: non_zero_or(
            current.claude_cache_creation_1h_tokens,
            previous.claude_cache_creation_1h_tokens,
        ),
        image_input_tokens: non_zero_or(current.image_input_tokens, previous.image_input_tokens),
        image_output_tokens: non_zero_or(current.image_output_tokens, previous.image_output_tokens),
        audio_input_tokens: non_zero_or(current.audio_input_tokens, previous.audio_input_tokens),
        audio_output_tokens: non_zero_or(current.audio_output_tokens, previous.audio_output_tokens),
        is_anthropic_usage_semantic: current.is_anthropic_usage_semantic
            || previous.is_anthropic_usage_semantic,
    }
}

fn non_zero_or(current: i32, previous: i32) -> i32 {
    if current > 0 {
        current
    } else {
        previous
    }
}

/// Accumulate the streamed completion text and running tool-call count from one
/// OpenAI SSE event's data lines, mirroring Go `openai.ProcessStreamResponse`:
/// for each choice append `delta.content` + `delta.reasoning_content`
/// (or `delta.reasoning`) + each tool call's `function.name`/`function.arguments`,
/// and track `tool_count = max(tool_count, len(delta.tool_calls))`.
fn accumulate_openai_stream_text(data_lines: &[String], text: &mut String, tool_count: &mut i64) {
    if data_lines.is_empty() {
        return;
    }
    let payload = data_lines.join("\n");
    let payload = payload.trim();
    if payload.is_empty() || payload == "[DONE]" {
        return;
    }
    let Ok(value) = serde_json::from_str::<Value>(payload) else {
        return;
    };
    if value.get("type").and_then(Value::as_str) == Some("response.output_text.delta") {
        if let Some(delta) = value.get("delta").and_then(Value::as_str) {
            text.push_str(delta);
        }
        return;
    }
    let Some(choices) = value.get("choices").and_then(Value::as_array) else {
        return;
    };
    for choice in choices {
        let Some(delta) = choice.get("delta") else {
            continue;
        };
        if let Some(content) = delta.get("content") {
            append_content_string(content, text);
        }
        // GetReasoningContent: prefer `reasoning_content`, fall back to `reasoning`.
        if let Some(reasoning) = delta
            .get("reasoning_content")
            .or_else(|| delta.get("reasoning"))
            .and_then(Value::as_str)
        {
            text.push_str(reasoning);
        }
        if let Some(tools) = delta.get("tool_calls").and_then(Value::as_array) {
            if tools.len() as i64 > *tool_count {
                *tool_count = tools.len() as i64;
            }
            for tool in tools {
                if let Some(function) = tool.get("function") {
                    if let Some(name) = function.get("name").and_then(Value::as_str) {
                        text.push_str(name);
                    }
                    if let Some(args) = function.get("arguments").and_then(Value::as_str) {
                        text.push_str(args);
                    }
                }
            }
        }
    }
}

/// Concatenate the assistant completion text of a non-stream OpenAI response
/// body — every `choices[].message.content` plus `reasoning_content`
/// (or `reasoning`). Mirrors Go `OpenaiHandler`'s missing-usage branch, which
/// estimates completion tokens from `choice.Message.StringContent() +
/// choice.Message.GetReasoningContent()`. Returns an empty string when the body
/// is not parseable or has no choices.
pub fn openai_response_completion_text(body: &str) -> String {
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return String::new();
    };
    let Some(choices) = value.get("choices").and_then(Value::as_array) else {
        return String::new();
    };
    let mut text = String::new();
    for choice in choices {
        let Some(message) = choice.get("message") else {
            continue;
        };
        if let Some(content) = message.get("content") {
            append_content_string(content, &mut text);
        }
        if let Some(reasoning) = message
            .get("reasoning_content")
            .or_else(|| message.get("reasoning"))
            .and_then(Value::as_str)
        {
            text.push_str(reasoning);
        }
    }
    text
}

/// Append an OpenAI message-content value as text. A delta's `content` is
/// normally a plain string, but tolerate the content-parts array shape
/// (`[{"type":"text","text":"..."}]`) by concatenating the `text` fields, so the
/// estimate never silently drops content.
fn append_content_string(content: &Value, text: &mut String) {
    match content {
        Value::String(value) => text.push_str(value),
        Value::Array(parts) => {
            for part in parts {
                if let Some(value) = part.get("text").and_then(Value::as_str) {
                    text.push_str(value);
                }
            }
        }
        _ => {}
    }
}

fn usage_summary_from_gemini_sse_data_lines(data_lines: &[String]) -> Option<UsageSummary> {
    if data_lines.is_empty() {
        return None;
    }

    let payload = data_lines.join("\n");
    let payload = payload.trim();
    if payload.is_empty() || payload == "[DONE]" {
        return None;
    }

    let value = serde_json::from_str::<Value>(payload).ok()?;
    let usage = usage_summary_from_gemini_value(&value)?;
    usage_has_tokens(&usage).then_some(usage)
}

fn mark_anthropic_usage_semantic(mut usage: UsageSummary) -> UsageSummary {
    if usage_has_tokens(&usage) {
        usage.is_anthropic_usage_semantic = true;
    }
    usage
}

fn merge_anthropic_stream_usage(mut current: UsageSummary, event: UsageSummary) -> UsageSummary {
    if event.prompt_tokens > 0 {
        current.prompt_tokens = event.prompt_tokens;
    }
    if event.completion_tokens > 0 {
        current.completion_tokens = event.completion_tokens;
    }
    if event.cached_tokens > 0 {
        current.cached_tokens = event.cached_tokens;
    }
    if event.cache_creation_tokens > 0 {
        current.cache_creation_tokens = event.cache_creation_tokens;
    }
    if event.claude_cache_creation_5m_tokens > 0 {
        current.claude_cache_creation_5m_tokens = event.claude_cache_creation_5m_tokens;
    }
    if event.claude_cache_creation_1h_tokens > 0 {
        current.claude_cache_creation_1h_tokens = event.claude_cache_creation_1h_tokens;
    }
    if event.image_input_tokens > 0 {
        current.image_input_tokens = event.image_input_tokens;
    }
    if event.image_output_tokens > 0 {
        current.image_output_tokens = event.image_output_tokens;
    }
    if event.audio_input_tokens > 0 {
        current.audio_input_tokens = event.audio_input_tokens;
    }
    if event.audio_output_tokens > 0 {
        current.audio_output_tokens = event.audio_output_tokens;
    }

    current.total_tokens = current
        .prompt_tokens
        .saturating_add(current.completion_tokens)
        .max(event.total_tokens);
    if usage_has_tokens(&current) || event.is_anthropic_usage_semantic {
        current.is_anthropic_usage_semantic = true;
    }
    current
}

fn usage_has_tokens(usage: &UsageSummary) -> bool {
    usage.total_tokens > 0
        || usage.prompt_tokens > 0
        || usage.completion_tokens > 0
        || usage.cached_tokens > 0
        || usage.cache_creation_tokens > 0
        || usage.claude_cache_creation_5m_tokens > 0
        || usage.claude_cache_creation_1h_tokens > 0
        || usage.image_input_tokens > 0
        || usage.image_output_tokens > 0
        || usage.audio_input_tokens > 0
        || usage.audio_output_tokens > 0
}

pub fn clamp_i64_to_i32(value: i64) -> i32 {
    value.clamp(i32::MIN as i64, i32::MAX as i64) as i32
}

fn first_i32_field(value: &Value, names: &[&str]) -> i32 {
    first_i32_field_value(value, names).unwrap_or_default()
}

fn first_i32_field_value(value: &Value, names: &[&str]) -> Option<i32> {
    names
        .iter()
        .find_map(|name| value.get(*name).and_then(value_to_i64))
        .map(clamp_i64_to_i32)
}

fn nested_i32_field(value: &Value, object_names: &[&str], field_names: &[&str]) -> i32 {
    object_names
        .iter()
        .filter_map(|object_name| value.get(*object_name))
        .find_map(|object| first_i32_field_value(object, field_names))
        .unwrap_or_default()
}

fn first_non_zero_i32(values: &[i32]) -> i32 {
    values
        .iter()
        .copied()
        .find(|value| *value != 0)
        .unwrap_or_default()
}

fn value_to_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
        .or_else(|| value.as_f64().map(|value| value.round() as i64))
}

fn gemini_upstream_query(query: Option<&str>, force_alt_sse: bool) -> String {
    let mut params = Vec::new();
    if let Some(query) = query.map(str::trim).filter(|value| !value.is_empty()) {
        for param in query
            .split('&')
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            let name = param.split_once('=').map(|(name, _)| name).unwrap_or(param);
            if name.eq_ignore_ascii_case("key") || name.eq_ignore_ascii_case("alt") {
                continue;
            }
            params.push(param.to_string());
        }
    }
    if force_alt_sse {
        params.push("alt=sse".to_string());
    }
    params.join("&")
}

fn gemini_input_modality_tokens(metadata: &Value) -> (i32, i32) {
    let prompt = gemini_modality_tokens(metadata.get("promptTokensDetails"));
    let tool = gemini_modality_tokens(metadata.get("toolUsePromptTokensDetails"));
    (
        prompt.0.saturating_add(tool.0),
        prompt.1.saturating_add(tool.1),
    )
}

fn gemini_modality_tokens(details: Option<&Value>) -> (i32, i32) {
    let Some(details) = details.and_then(Value::as_array) else {
        return (0, 0);
    };
    let mut image_tokens = 0_i32;
    let mut audio_tokens = 0_i32;
    for detail in details {
        let modality = detail
            .get("modality")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let token_count = first_i32_field(detail, &["tokenCount"]);
        if modality.eq_ignore_ascii_case("IMAGE") {
            image_tokens = image_tokens.saturating_add(token_count);
        } else if modality.eq_ignore_ascii_case("AUDIO") {
            audio_tokens = audio_tokens.saturating_add(token_count);
        }
    }
    (image_tokens, audio_tokens)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn csv_contains_trims_and_ignores_case() {
        assert!(csv_contains(" default, VIP ,beta", "vip"));
        assert!(csv_contains("gpt-4o,gpt-4.1", " GPT-4O "));
        assert!(!csv_contains("default,vip", "other"));
    }

    #[test]
    fn stream_options_injected_for_supported_streaming_channel() {
        // OpenAI (1) is supported; a streaming request gets include_usage forced
        // on, replacing any client-supplied value.
        let mut body = json!({
            "model": "gpt-4o",
            "stream": true,
            "stream_options": { "include_usage": false }
        });
        apply_stream_options(&mut body, CHANNEL_TYPE_OPENAI, true);
        assert_eq!(body["stream_options"]["include_usage"], json!(true));
    }

    #[test]
    fn stream_options_injected_when_absent() {
        let mut body = json!({ "model": "gpt-4o", "stream": true });
        apply_stream_options(&mut body, CHANNEL_TYPE_DEEPSEEK, true);
        assert_eq!(body["stream_options"]["include_usage"], json!(true));
    }

    #[test]
    fn stream_options_stripped_for_unsupported_channel() {
        // Perplexity (27) is not in the supported set: strip stream_options even
        // on a streaming request so the upstream does not reject it.
        let mut body = json!({
            "model": "x",
            "stream": true,
            "stream_options": { "include_usage": true }
        });
        assert!(!channel_supports_stream_options(CHANNEL_TYPE_PERPLEXITY));
        apply_stream_options(&mut body, CHANNEL_TYPE_PERPLEXITY, true);
        assert!(body.get("stream_options").is_none());
    }

    #[test]
    fn stream_options_stripped_for_non_streaming_request() {
        // Supported channel but non-streaming: strip (Go strips when !stream).
        let mut body = json!({
            "model": "gpt-4o",
            "stream_options": { "include_usage": true }
        });
        apply_stream_options(&mut body, CHANNEL_TYPE_OPENAI, false);
        assert!(body.get("stream_options").is_none());
    }

    #[test]
    fn stream_options_supported_set_matches_go() {
        // Spot-check the Go streamSupportedChannels values.
        for ct in [
            1, 3, 4, 14, 17, 24, 25, 26, 33, 35, 39, 40, 43, 45, 46, 48, 53, 57,
        ] {
            assert!(
                channel_supports_stream_options(ct),
                "{ct} should be supported"
            );
        }
        for ct in [20, 27, 34, 38, 42] {
            assert!(
                !channel_supports_stream_options(ct),
                "{ct} should NOT be supported"
            );
        }
    }

    #[test]
    fn ip_allowlist_supports_empty_wildcard_commas_and_lines() {
        assert!(ip_allowlist_matches("", None));
        assert!(ip_allowlist_matches("*", Some("203.0.113.1")));
        assert!(ip_allowlist_matches(
            "198.51.100.1, 203.0.113.1\n192.0.2.1",
            Some("203.0.113.1")
        ));
        assert!(!ip_allowlist_matches("198.51.100.1", Some("203.0.113.1")));
        assert!(!ip_allowlist_matches("198.51.100.1", None));
    }

    #[test]
    fn ip_allowlist_supports_cidr_and_normalized_ips() {
        // CIDR ranges (Go IsIpInCIDRList) — previously broken (exact-string only).
        assert!(ip_allowlist_matches("10.0.0.0/8", Some("10.1.2.3")));
        assert!(!ip_allowlist_matches("10.0.0.0/8", Some("11.0.0.1")));
        assert!(ip_allowlist_matches(
            "192.168.1.0/24, 10.0.0.0/8",
            Some("192.168.1.50")
        ));
        // IPv6 CIDR and normalized bare-IP comparison.
        assert!(ip_allowlist_matches("2001:db8::/32", Some("2001:db8::1")));
        assert!(ip_allowlist_matches("::1", Some("0:0:0:0:0:0:0:1")));
        // Mixed family: v4 CIDR must not match a v6 client.
        assert!(!ip_allowlist_matches("10.0.0.0/8", Some("2001:db8::1")));
        // Unparseable client IP is denied.
        assert!(!ip_allowlist_matches("10.0.0.0/8", Some("not-an-ip")));
    }

    #[test]
    fn first_channel_key_accepts_plain_multiline_and_json_arrays() {
        assert_eq!(first_channel_key("sk-a\nsk-b").as_deref(), Some("sk-a"));
        assert_eq!(first_channel_key("\n  sk-b  ").as_deref(), Some("sk-b"));
        assert_eq!(
            first_channel_key(r#"["", "sk-json", "sk-next"]"#).as_deref(),
            Some("sk-json")
        );
        assert_eq!(first_channel_key("   "), None);
    }

    #[test]
    fn upstream_chat_url_normalizes_base_urls() {
        assert_eq!(
            upstream_chat_url(1, None),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            upstream_chat_url(20, None),
            "https://openrouter.ai/api/v1/chat/completions"
        );
        assert_eq!(
            upstream_chat_url(1, Some("https://example.test/v1")),
            "https://example.test/v1/chat/completions"
        );
        assert_eq!(
            upstream_chat_url(1, Some("https://example.test/openai/")),
            "https://example.test/openai/v1/chat/completions"
        );
    }

    #[test]
    fn upstream_v1_url_supports_other_endpoints() {
        assert_eq!(
            upstream_v1_url(1, None, "/embeddings"),
            "https://api.openai.com/v1/embeddings"
        );
        assert_eq!(
            upstream_v1_url(CHANNEL_TYPE_JINA, None, "rerank"),
            "https://api.jina.ai/v1/rerank"
        );
        assert_eq!(
            upstream_v1_url(CHANNEL_TYPE_JINA, None, "embeddings"),
            "https://api.jina.ai/v1/embeddings"
        );
        assert_eq!(
            upstream_v1_url(CHANNEL_TYPE_COHERE, None, "rerank"),
            "https://api.cohere.ai/v1/rerank"
        );
        assert_eq!(
            upstream_v1_url(1, Some("https://example.test/v1/"), "embeddings"),
            "https://example.test/v1/embeddings"
        );
        assert_eq!(
            upstream_v1_url(
                CHANNEL_TYPE_JINA,
                Some("https://rerank.example/v1/"),
                "/rerank"
            ),
            "https://rerank.example/v1/rerank"
        );
    }

    #[test]
    fn openai_compatible_providers_use_known_default_base_urls() {
        // Every provider newly added to OPENAI_COMPATIBLE_CHANNEL_TYPES must
        // resolve to its documented upstream base when the channel does not
        // carry an explicit base_url.
        let cases: &[(i32, &str)] = &[
            (
                CHANNEL_TYPE_ZHIPU,
                "https://open.bigmodel.cn/api/paas/v4/chat/completions",
            ),
            (
                CHANNEL_TYPE_MOONSHOT,
                "https://api.moonshot.cn/v1/chat/completions",
            ),
            (
                CHANNEL_TYPE_PERPLEXITY,
                "https://api.perplexity.ai/v1/chat/completions",
            ),
            (
                CHANNEL_TYPE_LINGYIWANWU,
                "https://api.lingyiwanwu.com/v1/chat/completions",
            ),
            (
                CHANNEL_TYPE_DEEPSEEK,
                "https://api.deepseek.com/v1/chat/completions",
            ),
            (
                CHANNEL_TYPE_MISTRAL,
                "https://api.mistral.ai/v1/chat/completions",
            ),
            (
                CHANNEL_TYPE_SILICONFLOW,
                "https://api.siliconflow.cn/v1/chat/completions",
            ),
            (CHANNEL_TYPE_XAI, "https://api.x.ai/v1/chat/completions"),
            (
                CHANNEL_TYPE_MOKAAI,
                "https://api.moka.ai/v1/chat/completions",
            ),
            (
                CHANNEL_TYPE_OPENROUTER,
                "https://openrouter.ai/api/v1/chat/completions",
            ),
            (
                CHANNEL_TYPE_BAIDU,
                "https://qianfan.baidubce.com/v2/chat/completions",
            ),
            (
                CHANNEL_TYPE_ALI,
                "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
            ),
            (
                CHANNEL_TYPE_ZHIPU_V4,
                "https://open.bigmodel.cn/api/paas/v4/chat/completions",
            ),
        ];
        for (channel_type, expected) in cases {
            assert_eq!(
                upstream_v1_url(*channel_type, None, "chat/completions"),
                *expected,
                "channel type {channel_type} should map to its default base URL"
            );
        }
    }

    #[test]
    fn cloudflare_workers_ai_channel_routes_like_go() {
        // Type 39 is a dedicated adapter, not part of Go's generic OpenAI set.
        assert!(!OPENAI_COMPATIBLE_CHANNEL_TYPES.contains(&CHANNEL_TYPE_CLOUDFLARE));
        // The account-scoped Workers AI REST root (channel base_url) builds
        // Go's `{base}/client/v4/accounts/{acct}/ai/v1/chat/completions`.
        assert_eq!(
            upstream_v1_url(
                CHANNEL_TYPE_CLOUDFLARE,
                Some("https://api.cloudflare.com/client/v4/accounts/acct123/ai"),
                "chat/completions"
            ),
            "https://api.cloudflare.com/client/v4/accounts/acct123/ai/v1/chat/completions"
        );
        // An AI Gateway workers-ai route (already version-suffixed) is honored.
        assert_eq!(
            upstream_v1_url(
                CHANNEL_TYPE_CLOUDFLARE,
                Some("https://gateway.ai.cloudflare.com/v1/acct123/my-gw/workers-ai/v1"),
                "chat/completions"
            ),
            "https://gateway.ai.cloudflare.com/v1/acct123/my-gw/workers-ai/v1/chat/completions"
        );
    }

    #[test]
    fn openai_compatible_providers_prefer_explicit_base_url() {
        // Admin-configured base_url always wins, mirroring Go behavior.
        assert_eq!(
            upstream_v1_url(
                CHANNEL_TYPE_MOONSHOT,
                Some("https://custom.example"),
                "embeddings"
            ),
            "https://custom.example/v1/embeddings"
        );
        // Zhipu's default already ends with `/v4` (not `/v1`); an explicit
        // `/v1` override should still be honored as-is.
        assert_eq!(
            upstream_v1_url(
                CHANNEL_TYPE_ZHIPU,
                Some("https://open.bigmodel.cn/api/paas/v4"),
                "chat/completions"
            ),
            "https://open.bigmodel.cn/api/paas/v4/chat/completions"
        );
    }

    #[test]
    fn openai_compatible_channel_types_match_go_generic_adapter() {
        assert_eq!(
            OPENAI_COMPATIBLE_CHANNEL_TYPES,
            &[1, 3, 6, 7, 8, 9, 10, 12, 13, 19, 20, 22, 31, 47]
        );
        for dedicated in [
            CHANNEL_TYPE_ANTHROPIC,
            CHANNEL_TYPE_BAIDU,
            CHANNEL_TYPE_ZHIPU,
            CHANNEL_TYPE_ALI,
            CHANNEL_TYPE_GEMINI,
            CHANNEL_TYPE_MOONSHOT,
            CHANNEL_TYPE_ZHIPU_V4,
            CHANNEL_TYPE_PERPLEXITY,
            CHANNEL_TYPE_CLOUDFLARE,
            CHANNEL_TYPE_SILICONFLOW,
            CHANNEL_TYPE_MISTRAL,
            CHANNEL_TYPE_DEEPSEEK,
            CHANNEL_TYPE_MOKAAI,
            CHANNEL_TYPE_XAI,
            CHANNEL_TYPE_SUBMODEL,
            CHANNEL_TYPE_COHERE,
            CHANNEL_TYPE_JINA,
        ] {
            assert!(!is_openai_compatible_channel_type(dedicated));
        }
        assert!(is_openai_compatible_channel_type(CHANNEL_TYPE_LINGYIWANWU));
        assert!(is_openai_compatible_channel_type(CHANNEL_TYPE_OPENROUTER));
    }

    #[test]
    fn trailing_version_segment_detection() {
        // /v1, /v2, /v4 ... are honored so we do not append a second /v1.
        assert!(has_trailing_version_segment(
            "https://open.bigmodel.cn/api/paas/v4"
        ));
        assert!(has_trailing_version_segment("https://api.openai.com/v1"));
        assert!(has_trailing_version_segment("https://example.test/v2"));
        // Bare hosts, non-version paths, or `v` followed by non-digits must
        // still get the default `/v1` prefix.
        assert!(!has_trailing_version_segment("https://api.openai.com"));
        assert!(!has_trailing_version_segment("https://example.test/openai"));
        assert!(!has_trailing_version_segment(
            "https://example.test/version"
        ));
        assert!(!has_trailing_version_segment("https://example.test/v"));
    }

    #[test]
    fn upstream_anthropic_messages_url_normalizes_base_urls() {
        assert_eq!(
            upstream_anthropic_messages_url(None),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            upstream_anthropic_messages_url(Some("https://example.test/v1")),
            "https://example.test/v1/messages"
        );
        assert_eq!(
            upstream_anthropic_messages_url(Some("https://example.test/proxy/")),
            "https://example.test/proxy/v1/messages"
        );
    }

    #[test]
    fn parse_gemini_native_path_extracts_model_action_and_version() {
        assert_eq!(
            parse_gemini_native_path("/v1beta/models/gemini-2.0-flash:generateContent"),
            Some(GeminiNativePath {
                api_version: "v1beta".to_string(),
                model: "gemini-2.0-flash".to_string(),
                action: "generateContent".to_string(),
            })
        );
        assert_eq!(
            parse_gemini_native_path("/v1/models/gemini-2.5-pro:streamGenerateContent")
                .unwrap()
                .upstream_path(),
            "v1/models/gemini-2.5-pro:streamGenerateContent"
        );
        assert!(parse_gemini_native_path("/v1beta/models/gemini-2.0-flash").is_none());
        let embed =
            parse_gemini_native_path("/v1beta/models/text-embedding-004:embedContent").unwrap();
        assert!(embed.is_embed_content());
        assert!(embed.is_supported_native_passthrough());

        let batch =
            parse_gemini_native_path("/v1beta/models/text-embedding-004:batchEmbedContents")
                .unwrap();
        assert!(batch.is_batch_embed_contents());
        assert!(batch.is_supported_native_passthrough());

        let count =
            parse_gemini_native_path("/v1beta/models/gemini-2.0-flash:countTokens").unwrap();
        assert!(count.is_count_tokens());
        assert!(count.is_supported_native_passthrough());
    }

    #[test]
    fn upstream_gemini_native_url_normalizes_base_and_query() {
        let route =
            parse_gemini_native_path("/v1beta/models/gemini-2.0-flash:generateContent").unwrap();
        assert_eq!(
            upstream_gemini_native_url(None, &route, Some("key=client-secret&timeout=30s")),
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?timeout=30s"
        );

        let stream =
            parse_gemini_native_path("/v1beta/models/gemini-2.0-flash:streamGenerateContent")
                .unwrap();
        assert_eq!(
            upstream_gemini_native_url(
                Some("https://example.test/gemini/"),
                &stream,
                Some("alt=json&foo=bar"),
            ),
            "https://example.test/gemini/v1beta/models/gemini-2.0-flash:streamGenerateContent?foo=bar&alt=sse"
        );

        let embed =
            parse_gemini_native_path("/v1beta/models/text-embedding-004:embedContent").unwrap();
        assert_eq!(
            upstream_gemini_native_url(None, &embed, Some("key=client-secret&alt=json")),
            "https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent"
        );

        let count =
            parse_gemini_native_path("/v1beta/models/gemini-2.0-flash:countTokens").unwrap();
        assert_eq!(
            upstream_gemini_native_url(None, &count, Some("key=client-secret&timeout=30s")),
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:countTokens?timeout=30s"
        );
    }

    #[test]
    fn channel_type_helpers_recognize_supported_families() {
        assert!(is_anthropic_channel_type(CHANNEL_TYPE_ANTHROPIC));
        assert!(is_gemini_channel_type(CHANNEL_TYPE_GEMINI));
        assert!(is_rerank_channel_type(CHANNEL_TYPE_JINA));
        assert!(is_openai_compatible_channel_type(1));
        assert!(channel_type_supported(14, ANTHROPIC_CHANNEL_TYPES));
        assert!(channel_type_supported(24, GEMINI_CHANNEL_TYPES));
        assert!(channel_type_supported(
            CHANNEL_TYPE_JINA,
            RERANK_CHANNEL_TYPES
        ));
        assert!(channel_type_supported(
            CHANNEL_TYPE_COHERE,
            RERANK_CHANNEL_TYPES
        ));
        assert!(!channel_type_supported(14, OPENAI_COMPATIBLE_CHANNEL_TYPES));
        assert!(!channel_type_supported(
            CHANNEL_TYPE_JINA,
            OPENAI_COMPATIBLE_CHANNEL_TYPES
        ));
    }

    #[test]
    fn apply_model_mapping_only_rewrites_matching_model() {
        let mut body = json!({
            "model": "gpt-4o",
            "temperature": 0.0,
            "custom": true
        });
        apply_model_mapping(&mut body, "gpt-4o", Some(r#"{"gpt-4o":"upstream-model"}"#));
        assert_eq!(body["model"], "upstream-model");
        assert_eq!(body["temperature"], 0.0);
        assert_eq!(body["custom"], true);

        apply_model_mapping(&mut body, "missing", Some(r#"{"missing":""}"#));
        assert_eq!(body["model"], "upstream-model");
        assert_eq!(
            mapped_model_name("gpt-4o", Some(r#"{"gpt-4o":" upstream-model "}"#)).as_deref(),
            Some("upstream-model")
        );
        assert_eq!(
            mapped_model_name("missing", Some(r#"{"missing":""}"#)),
            None
        );
    }

    #[test]
    fn apply_gemini_native_model_mapping_rewrites_nested_model_fields() {
        let mut body = json!({
            "requests": [
                {
                    "model": "models/text-embedding-004",
                    "content": {"parts": [{"text": "hello"}]}
                },
                {
                    "model": "text-embedding-004",
                    "content": {"parts": [{"text": "world"}]}
                }
            ],
            "metadata": {
                "model": "other-model"
            }
        });

        apply_gemini_native_model_mapping(&mut body, "text-embedding-004", "gemini-embedding-exp");

        assert_eq!(body["requests"][0]["model"], "models/gemini-embedding-exp");
        assert_eq!(body["requests"][1]["model"], "gemini-embedding-exp");
        assert_eq!(body["metadata"]["model"], "other-model");
    }

    #[test]
    fn usage_summary_handles_openai_and_input_output_names() {
        assert_eq!(
            usage_summary_from_body(
                r#"{"usage":{"prompt_tokens":12,"completion_tokens":5,"total_tokens":17}}"#
            ),
            UsageSummary {
                prompt_tokens: 12,
                completion_tokens: 5,
                total_tokens: 17,
                ..UsageSummary::default()
            }
        );
        assert_eq!(
            usage_summary_from_body(r#"{"usage":{"input_tokens":7,"output_tokens":3}}"#),
            UsageSummary {
                prompt_tokens: 7,
                completion_tokens: 3,
                total_tokens: 10,
                ..UsageSummary::default()
            }
        );
    }

    #[test]
    fn usage_summary_from_body_extracts_rerank_usage() {
        assert_eq!(
            usage_summary_from_rerank_body(
                r#"{"model":"jina-reranker-v2-base-multilingual","usage":{"total_tokens":21}}"#
            ),
            UsageSummary {
                prompt_tokens: 21,
                total_tokens: 21,
                ..UsageSummary::default()
            }
        );
        assert_eq!(
            usage_summary_from_rerank_body(
                r#"{"meta":{"billed_units":{"input_tokens":34,"output_tokens":2}}}"#
            ),
            UsageSummary {
                prompt_tokens: 34,
                completion_tokens: 2,
                total_tokens: 36,
                ..UsageSummary::default()
            }
        );
        assert_eq!(
            usage_summary_from_rerank_body(r#"{"meta":{"billed_units":{"search_units":1}}}"#),
            UsageSummary {
                prompt_tokens: 1,
                total_tokens: 1,
                ..UsageSummary::default()
            }
        );
    }

    #[test]
    fn usage_summary_from_body_extracts_token_details() {
        assert_eq!(
            usage_summary_from_body(
                r#"{
                    "usage": {
                        "prompt_tokens": 1000,
                        "completion_tokens": 600,
                        "prompt_tokens_details": {
                            "cached_tokens": 200,
                            "cached_creation_tokens": 30,
                            "image_tokens": 120,
                            "audio_tokens": 80
                        },
                        "completion_tokens_details": {
                            "image_tokens": 40,
                            "audio_tokens": 60
                        }
                    }
                }"#
            ),
            UsageSummary {
                prompt_tokens: 1_000,
                completion_tokens: 600,
                total_tokens: 1_600,
                cached_tokens: 200,
                cache_creation_tokens: 30,
                image_input_tokens: 120,
                image_output_tokens: 40,
                audio_input_tokens: 80,
                audio_output_tokens: 60,
                ..UsageSummary::default()
            }
        );
    }

    #[test]
    fn moonshot_usage_preserves_source_cached_token_precedence() {
        let usage = usage_summary_from_moonshot_body(
            r#"{
                "usage": {
                    "prompt_tokens": 20,
                    "completion_tokens": 5,
                    "total_tokens": 25,
                    "input_tokens_details": {"cached_tokens": 9},
                    "prompt_tokens_details": {"cached_tokens": 7},
                    "prompt_cache_hit_tokens": 3
                },
                "choices": [{"usage": {"cached_tokens": 8}}]
            }"#,
        );
        assert_eq!(usage.prompt_tokens, 20);
        assert_eq!(usage.completion_tokens, 5);
        assert_eq!(usage.total_tokens, 25);
        assert_eq!(usage.cached_tokens, 7);

        let nested =
            usage_summary_from_moonshot_body(r#"{"choices":[{"usage":{"cached_tokens":11}}]}"#);
        assert_eq!(nested.cached_tokens, 11);

        let top_level =
            usage_summary_from_moonshot_body(r#"{"usage":{"prompt_tokens":5,"cached_tokens":4}}"#);
        assert_eq!(top_level.cached_tokens, 4);
    }

    #[test]
    fn usage_summary_from_body_extracts_image_generation_usage() {
        assert_eq!(
            usage_summary_from_body(
                r#"{
                    "created": 1713833628,
                    "data": [{"b64_json": "base64-image"}],
                    "usage": {
                        "input_tokens": 80,
                        "input_tokens_details": {
                            "image_tokens": 30,
                            "text_tokens": 50
                        },
                        "output_tokens": 120,
                        "output_tokens_details": {
                            "image_tokens": 115,
                            "text_tokens": 5
                        },
                        "total_tokens": 200
                    }
                }"#
            ),
            UsageSummary {
                prompt_tokens: 80,
                completion_tokens: 120,
                total_tokens: 200,
                image_input_tokens: 30,
                image_output_tokens: 115,
                ..UsageSummary::default()
            }
        );
    }

    #[test]
    fn usage_summary_from_body_extracts_realtime_response_done_usage() {
        assert_eq!(
            usage_summary_from_body(
                r#"{
                    "type": "response.done",
                    "response": {
                        "usage": {
                            "input_tokens": 1200,
                            "output_tokens": 350,
                            "total_tokens": 1550,
                            "input_token_details": {
                                "cached_tokens": 400,
                                "audio_tokens": 180
                            },
                            "output_token_details": {
                                "audio_tokens": 90
                            }
                        }
                    }
                }"#
            ),
            UsageSummary {
                prompt_tokens: 1_200,
                completion_tokens: 350,
                total_tokens: 1_550,
                cached_tokens: 400,
                audio_input_tokens: 180,
                audio_output_tokens: 90,
                ..UsageSummary::default()
            }
        );
    }

    #[test]
    fn usage_summary_from_sse_stream_extracts_image_generation_completed_usage() {
        let body = concat!(
            "event: image_generation.completed\n",
            "data: {\"type\":\"image_generation.completed\",\"usage\":{\"input_tokens\":70,\"input_tokens_details\":{\"image_tokens\":25,\"text_tokens\":45},\"output_tokens\":110,\"total_tokens\":180}}\n\n",
        );

        assert_eq!(
            usage_summary_from_sse_stream(body),
            UsageSummary {
                prompt_tokens: 70,
                completion_tokens: 110,
                total_tokens: 180,
                image_input_tokens: 25,
                image_output_tokens: 110,
                ..UsageSummary::default()
            }
        );
    }

    #[test]
    fn usage_summary_from_body_extracts_anthropic_cache_details() {
        assert_eq!(
            usage_summary_from_body(
                r#"{
                    "usage": {
                        "input_tokens": 500,
                        "output_tokens": 25,
                        "usage_semantic": "anthropic",
                        "input_tokens_details": {"cached_tokens": 100},
                        "claude_cache_creation_5_m_tokens": 30,
                        "claude_cache_creation_1_h_tokens": 20
                    }
                }"#
            ),
            UsageSummary {
                prompt_tokens: 500,
                completion_tokens: 25,
                total_tokens: 525,
                cached_tokens: 100,
                claude_cache_creation_5m_tokens: 30,
                claude_cache_creation_1h_tokens: 20,
                is_anthropic_usage_semantic: true,
                ..UsageSummary::default()
            }
        );
    }

    #[test]
    fn usage_summary_from_sse_stream_extracts_realtime_response_done_usage() {
        let body = concat!(
            "event: response.audio.delta\n",
            "data: {\"type\":\"response.audio.delta\",\"delta\":\"abc\"}\n\n",
            "event: response.done\n",
            "data: {\"type\":\"response.done\",\"response\":{\"usage\":{\"input_tokens\":1200,\"output_tokens\":350,\"total_tokens\":1550,\"input_token_details\":{\"cached_tokens\":400,\"audio_tokens\":180},\"output_token_details\":{\"audio_tokens\":90}}}}\n\n",
        );

        assert_eq!(
            usage_summary_from_sse_stream(body),
            UsageSummary {
                prompt_tokens: 1_200,
                completion_tokens: 350,
                total_tokens: 1_550,
                cached_tokens: 400,
                audio_input_tokens: 180,
                audio_output_tokens: 90,
                ..UsageSummary::default()
            }
        );
    }

    #[test]
    fn usage_summary_from_anthropic_body_marks_semantic_and_cache_details() {
        assert_eq!(
            usage_summary_from_anthropic_body(
                r#"{
                    "usage": {
                        "input_tokens": 500,
                        "cache_read_input_tokens": 120,
                        "output_tokens": 25,
                        "cache_creation": {
                            "ephemeral_5m_input_tokens": 30,
                            "ephemeral_1h_input_tokens": 20
                        }
                    }
                }"#
            ),
            UsageSummary {
                prompt_tokens: 500,
                completion_tokens: 25,
                total_tokens: 525,
                cached_tokens: 120,
                cache_creation_tokens: 50,
                claude_cache_creation_5m_tokens: 30,
                claude_cache_creation_1h_tokens: 20,
                is_anthropic_usage_semantic: true,
                ..UsageSummary::default()
            }
        );
    }

    #[test]
    fn usage_summary_from_anthropic_body_supports_message_usage() {
        assert_eq!(
            usage_summary_from_anthropic_body(
                r#"{
                    "type": "message_start",
                    "message": {
                        "usage": {
                            "input_tokens": 72,
                            "cache_read_input_tokens": 12,
                            "output_tokens": 1
                        }
                    }
                }"#
            ),
            UsageSummary {
                prompt_tokens: 72,
                completion_tokens: 1,
                total_tokens: 73,
                cached_tokens: 12,
                is_anthropic_usage_semantic: true,
                ..UsageSummary::default()
            }
        );
    }

    #[test]
    fn usage_summary_from_body_supports_nested_response_usage() {
        assert_eq!(
            usage_summary_from_body(
                r#"{"response":{"usage":{"input_tokens":9,"output_tokens":4}}}"#
            ),
            UsageSummary {
                prompt_tokens: 9,
                completion_tokens: 4,
                total_tokens: 13,
                ..UsageSummary::default()
            }
        );
    }

    #[test]
    fn usage_summary_from_gemini_body_extracts_usage_metadata() {
        assert_eq!(
            usage_summary_from_gemini_body(
                r#"{
                    "usageMetadata": {
                        "promptTokenCount": 100,
                        "toolUsePromptTokenCount": 20,
                        "candidatesTokenCount": 30,
                        "thoughtsTokenCount": 7,
                        "totalTokenCount": 157,
                        "cachedContentTokenCount": 11,
                        "promptTokensDetails": [
                            {"modality": "IMAGE", "tokenCount": 40},
                            {"modality": "AUDIO", "tokenCount": 12}
                        ],
                        "toolUsePromptTokensDetails": [
                            {"modality": "AUDIO", "tokenCount": 3}
                        ],
                        "candidatesTokensDetails": [
                            {"modality": "IMAGE", "tokenCount": 5},
                            {"modality": "AUDIO", "tokenCount": 6}
                        ]
                    }
                }"#
            ),
            UsageSummary {
                prompt_tokens: 120,
                completion_tokens: 37,
                total_tokens: 157,
                cached_tokens: 11,
                image_input_tokens: 40,
                audio_input_tokens: 15,
                image_output_tokens: 5,
                audio_output_tokens: 6,
                ..UsageSummary::default()
            }
        );
    }

    #[test]
    fn usage_summary_from_gemini_embedding_body_extracts_usage_metadata() {
        assert_eq!(
            usage_summary_from_gemini_body(
                r#"{
                    "embedding": {"values": [0.1, 0.2]},
                    "usageMetadata": {
                        "promptTokenCount": 7,
                        "totalTokenCount": 7
                    }
                }"#
            ),
            UsageSummary {
                prompt_tokens: 7,
                completion_tokens: 0,
                total_tokens: 7,
                ..UsageSummary::default()
            }
        );
    }

    #[test]
    fn usage_summary_from_gemini_count_tokens_body_extracts_token_count() {
        assert_eq!(
            usage_summary_from_gemini_body(
                r#"{
                    "totalTokens": 42,
                    "cachedContentTokenCount": 12,
                    "promptTokensDetails": [
                        {"modality": "IMAGE", "tokenCount": 20},
                        {"modality": "AUDIO", "tokenCount": 5}
                    ]
                }"#
            ),
            UsageSummary {
                prompt_tokens: 42,
                completion_tokens: 0,
                total_tokens: 42,
                cached_tokens: 12,
                image_input_tokens: 20,
                audio_input_tokens: 5,
                ..UsageSummary::default()
            }
        );
    }

    #[test]
    fn usage_summary_from_anthropic_sse_stream_merges_cumulative_events() {
        let body = concat!(
            "event: message_start\n",
            "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":25,\"cache_read_input_tokens\":5,\"cache_creation\":{\"ephemeral_5m_input_tokens\":2,\"ephemeral_1h_input_tokens\":3},\"output_tokens\":1}}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello\"}}\n\n",
            "event: message_delta\n",
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":15}}\n\n",
            "event: message_stop\n",
            "data: {\"type\":\"message_stop\"}\n\n",
        );

        assert_eq!(
            usage_summary_from_anthropic_sse_stream(body),
            UsageSummary {
                prompt_tokens: 25,
                completion_tokens: 15,
                total_tokens: 40,
                cached_tokens: 5,
                cache_creation_tokens: 5,
                claude_cache_creation_5m_tokens: 2,
                claude_cache_creation_1h_tokens: 3,
                is_anthropic_usage_semantic: true,
                ..UsageSummary::default()
            }
        );
    }

    #[test]
    fn usage_summary_from_gemini_sse_stream_uses_latest_usage_metadata() {
        let body = concat!(
            "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"hi\"}]}}],\"usageMetadata\":{\"promptTokenCount\":10,\"candidatesTokenCount\":2,\"totalTokenCount\":12}}\n\n",
            "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\" there\"}]}}],\"usageMetadata\":{\"promptTokenCount\":10,\"candidatesTokenCount\":5,\"totalTokenCount\":15,\"cachedContentTokenCount\":3}}\n\n",
        );

        assert_eq!(
            usage_summary_from_gemini_sse_stream(body),
            UsageSummary {
                prompt_tokens: 10,
                completion_tokens: 5,
                total_tokens: 15,
                cached_tokens: 3,
                ..UsageSummary::default()
            }
        );
    }

    #[test]
    fn usage_summary_from_sse_stream_extracts_final_usage_chunk() {
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n",
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":5,\"total_tokens\":12}}\n\n",
            "data: [DONE]\n\n",
        );

        assert_eq!(
            usage_summary_from_sse_stream(body),
            UsageSummary {
                prompt_tokens: 7,
                completion_tokens: 5,
                total_tokens: 12,
                ..UsageSummary::default()
            }
        );
    }

    #[test]
    fn moonshot_sse_merges_nested_cache_event_with_final_usage_across_chunks() {
        let stream = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"},\"usage\":{\"cached_tokens\":111}}]}\n\n",
            "data: {\"usage\":{\"prompt_tokens\":17,\"completion_tokens\":4,\"total_tokens\":21}}\n\n",
            "data: [DONE]\n\n"
        );
        let mut accumulator = SseUsageAccumulator::moonshot();
        for chunk in stream.as_bytes().chunks(13) {
            accumulator.push_chunk(chunk);
        }
        let (usage, text, tools) = accumulator.into_parts();
        assert_eq!(usage.prompt_tokens, 17);
        assert_eq!(usage.completion_tokens, 4);
        assert_eq!(usage.total_tokens, 21);
        assert_eq!(usage.cached_tokens, 111);
        assert_eq!(text, "hello");
        assert_eq!(tools, 0);
        assert_eq!(usage_summary_from_moonshot_sse_stream(stream), usage);
    }

    #[test]
    fn into_parts_accumulates_openai_stream_text_and_tool_count() {
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\" think\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\" world\",\"tool_calls\":[{\"function\":{\"name\":\"f\",\"arguments\":\"{}\"}}]}}]}\n\n",
            "data: [DONE]\n\n",
        );
        let mut acc = SseUsageAccumulator::default();
        acc.push_chunk(body.as_bytes());
        let (usage, text, tool_count) = acc.into_parts();
        // content + reasoning + tool name/args, in stream order.
        assert_eq!(text, "Hello think worldf{}");
        assert_eq!(tool_count, 1);
        // No usage chunk present -> usage stays default (caller estimates).
        assert_eq!(usage, UsageSummary::default());
    }

    #[test]
    fn into_parts_tool_count_is_running_max_not_sum() {
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"a\",\"arguments\":\"\"}},{\"index\":1,\"function\":{\"name\":\"b\",\"arguments\":\"\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"x\"}}]}}]}\n\n",
        );
        let mut acc = SseUsageAccumulator::default();
        acc.push_chunk(body.as_bytes());
        let (_usage, _text, tool_count) = acc.into_parts();
        // Go uses a running max across deltas, not a sum: max(2, 1) == 2.
        assert_eq!(tool_count, 2);
    }

    #[test]
    fn into_parts_handles_content_parts_array() {
        let body = "data: {\"choices\":[{\"delta\":{\"content\":[{\"type\":\"text\",\"text\":\"hi\"}]}}]}\n\n";
        let mut acc = SseUsageAccumulator::default();
        acc.push_chunk(body.as_bytes());
        let (_usage, text, _tool_count) = acc.into_parts();
        assert_eq!(text, "hi");
    }

    #[test]
    fn into_parts_accumulates_responses_output_text_after_malformed_event() {
        let body = concat!(
            "data: {not-json}\n\n",
            "event: response.output_text.delta\n",
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\n",
        );
        let mut acc = SseUsageAccumulator::default();
        acc.push_chunk(body.as_bytes());
        let (usage, text, tool_count) = acc.into_parts();
        assert_eq!(usage, UsageSummary::default());
        assert_eq!(text, "hi");
        assert_eq!(tool_count, 0);
    }

    #[test]
    fn openai_response_completion_text_concatenates_choices_content_and_reasoning() {
        let body = r#"{"choices":[{"message":{"role":"assistant","content":"Hello","reasoning_content":" because"}},{"message":{"content":[{"type":"text","text":" world"}]}}]}"#;
        assert_eq!(openai_response_completion_text(body), "Hello because world");
        // Unparseable / no choices -> empty.
        assert_eq!(openai_response_completion_text("not json"), "");
        assert_eq!(openai_response_completion_text(r#"{"usage":{}}"#), "");
    }

    #[test]
    fn usage_summary_from_sse_stream_extracts_responses_completed_usage() {
        let body = concat!(
            "event: response.output_text.delta\n",
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\n",
            "event: response.completed\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":9,\"output_tokens\":4,\"total_tokens\":13,\"input_tokens_details\":{\"cached_tokens\":3}}}}\n\n",
        );

        assert_eq!(
            usage_summary_from_sse_stream(body),
            UsageSummary {
                prompt_tokens: 9,
                completion_tokens: 4,
                total_tokens: 13,
                cached_tokens: 3,
                ..UsageSummary::default()
            }
        );
    }

    #[test]
    fn usage_summary_from_sse_stream_uses_last_usage_event() {
        let body = concat!(
            "data: {\"usage\":{\"input_tokens\":2,\"output_tokens\":1}}\n\n",
            "data: {\"usage\":{\"input_tokens\":5,\"output_tokens\":8}}\n\n",
        );

        assert_eq!(
            usage_summary_from_sse_stream(body),
            UsageSummary {
                prompt_tokens: 5,
                completion_tokens: 8,
                total_tokens: 13,
                ..UsageSummary::default()
            }
        );
    }

    #[test]
    fn usage_summary_from_sse_stream_ignores_invalid_events_and_crlf() {
        let body = concat!(
            ": keepalive\r\n\r\n",
            "event: completion.chunk\r\n",
            "data: not-json\r\n\r\n",
            "data: {\"response\":{\"usage\":{\"input_tokens\":4,\r\n",
            "data: \"output_tokens\":6}}}\r\n\r\n",
            "data: [DONE]\r\n",
        );

        assert_eq!(
            usage_summary_from_sse_stream(body),
            UsageSummary {
                prompt_tokens: 4,
                completion_tokens: 6,
                total_tokens: 10,
                ..UsageSummary::default()
            }
        );
    }

    #[test]
    fn anthropic_sse_usage_accumulator_handles_split_chunks() {
        let mut accumulator = SseUsageAccumulator::anthropic();
        accumulator.push_chunk(b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":8");
        accumulator.push_chunk(b",\"output_tokens\":1}}}\n\nevent: message_delta\n");
        accumulator
            .push_chunk(b"data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":6}}\n\n");

        assert_eq!(
            accumulator.finish(),
            UsageSummary {
                prompt_tokens: 8,
                completion_tokens: 6,
                total_tokens: 14,
                is_anthropic_usage_semantic: true,
                ..UsageSummary::default()
            }
        );
    }

    #[test]
    fn sse_usage_accumulator_handles_split_byte_chunks() {
        let mut accumulator = SseUsageAccumulator::default();
        accumulator.push_chunk(b"data: {\"usage\":{\"prompt_to");
        accumulator.push_chunk(b"kens\":11,\"completion_tokens\":");
        accumulator.push_chunk(b"4,\"total_tokens\":15}}\r\n\r\n");
        accumulator.push_chunk(b"data: [DONE]\r\n");

        assert_eq!(
            accumulator.finish(),
            UsageSummary {
                prompt_tokens: 11,
                completion_tokens: 4,
                total_tokens: 15,
                ..UsageSummary::default()
            }
        );
    }

    #[test]
    fn clamp_i64_to_i32_prevents_d1_integer_overflow() {
        assert_eq!(clamp_i64_to_i32(i64::MAX), i32::MAX);
        assert_eq!(clamp_i64_to_i32(i64::MIN), i32::MIN);
        assert_eq!(clamp_i64_to_i32(42), 42);
    }
}
