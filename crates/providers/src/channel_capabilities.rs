use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChannelAdapterKind {
    GenericOpenAi,
    AnthropicNative,
    GeminiNative,
    Rerank,
    CloudflareWorkersAi,
    DeepSeek,
    XaiOpenAi,
    DedicatedPending,
    TaskOnly,
    Unsupported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChannelRelayReadiness {
    Ready,
    Partial,
    Deferred,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderRelayRoute {
    ChatCompletions,
    Completions,
    Responses,
    ResponsesCompact,
    Embeddings,
    ImageGenerations,
    ImageEdits,
    AudioSpeech,
    AudioTranscriptions,
    AudioTranslations,
    Moderations,
    Edits,
    AnthropicMessages,
    Rerank,
    GeminiNative,
    Realtime,
}

impl ProviderRelayRoute {
    pub const fn method(self) -> &'static str {
        "POST"
    }

    pub const fn path(self) -> &'static str {
        match self {
            Self::ChatCompletions => "/v1/chat/completions",
            Self::Completions => "/v1/completions",
            Self::Responses => "/v1/responses",
            Self::ResponsesCompact => "/v1/responses/compact",
            Self::Embeddings => "/v1/embeddings",
            Self::ImageGenerations => "/v1/images/generations",
            Self::ImageEdits => "/v1/images/edits",
            Self::AudioSpeech => "/v1/audio/speech",
            Self::AudioTranscriptions => "/v1/audio/transcriptions",
            Self::AudioTranslations => "/v1/audio/translations",
            Self::Moderations => "/v1/moderations",
            Self::Edits => "/v1/edits",
            Self::AnthropicMessages => "/v1/messages",
            Self::Rerank => "/v1/rerank",
            Self::GeminiNative => "/v1beta/models/*",
            Self::Realtime => "/v1/realtime",
        }
    }

    pub const fn cache_family(self) -> &'static str {
        match self {
            Self::ChatCompletions => "route:chat_completions",
            Self::Completions => "route:completions",
            Self::Responses => "route:responses",
            Self::ResponsesCompact => "route:responses_compact",
            Self::Embeddings => "route:embeddings",
            Self::ImageGenerations => "route:image_generations",
            Self::ImageEdits => "route:image_edits",
            Self::AudioSpeech => "route:audio_speech",
            Self::AudioTranscriptions => "route:audio_transcriptions",
            Self::AudioTranslations => "route:audio_translations",
            Self::Moderations => "route:moderations",
            Self::Edits => "route:edits",
            Self::AnthropicMessages => "route:anthropic_messages",
            Self::Rerank => "route:rerank",
            Self::GeminiNative => "route:gemini_native",
            Self::Realtime => "route:realtime",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ChannelRelayCapability {
    pub channel_type: i32,
    pub name: &'static str,
    pub adapter: ChannelAdapterKind,
    pub readiness: ChannelRelayReadiness,
    pub supported_routes: &'static [ProviderRelayRoute],
    pub reason: &'static str,
}

const GENERIC_OPENAI_ROUTES: &[ProviderRelayRoute] = &[
    ProviderRelayRoute::ChatCompletions,
    ProviderRelayRoute::Completions,
    ProviderRelayRoute::Responses,
    ProviderRelayRoute::ResponsesCompact,
    ProviderRelayRoute::Embeddings,
    ProviderRelayRoute::ImageGenerations,
    ProviderRelayRoute::ImageEdits,
    ProviderRelayRoute::AudioSpeech,
    ProviderRelayRoute::AudioTranscriptions,
    ProviderRelayRoute::AudioTranslations,
    ProviderRelayRoute::Moderations,
    ProviderRelayRoute::Edits,
    ProviderRelayRoute::Realtime,
];
const ANTHROPIC_ROUTES: &[ProviderRelayRoute] = &[ProviderRelayRoute::AnthropicMessages];
const GEMINI_ROUTES: &[ProviderRelayRoute] = &[ProviderRelayRoute::GeminiNative];
const RERANK_ROUTES: &[ProviderRelayRoute] = &[ProviderRelayRoute::Rerank];
const CLOUDFLARE_ROUTES: &[ProviderRelayRoute] = &[ProviderRelayRoute::ChatCompletions];
const DEEPSEEK_ROUTES: &[ProviderRelayRoute] = &[
    ProviderRelayRoute::ChatCompletions,
    ProviderRelayRoute::Completions,
    ProviderRelayRoute::AnthropicMessages,
];
const XAI_ROUTES: &[ProviderRelayRoute] = &[
    ProviderRelayRoute::ChatCompletions,
    ProviderRelayRoute::Completions,
    ProviderRelayRoute::Responses,
    ProviderRelayRoute::ImageGenerations,
];
const NO_ROUTES: &[ProviderRelayRoute] = &[];

macro_rules! capability {
    ($channel_type:literal, $name:literal, $adapter:ident, $readiness:ident, $routes:expr, $reason:literal) => {
        ChannelRelayCapability {
            channel_type: $channel_type,
            name: $name,
            adapter: ChannelAdapterKind::$adapter,
            readiness: ChannelRelayReadiness::$readiness,
            supported_routes: $routes,
            reason: $reason,
        }
    };
}

pub const CHANNEL_RELAY_CAPABILITIES: &[ChannelRelayCapability] = &[
    capability!(
        1,
        "OpenAI",
        GenericOpenAi,
        Ready,
        GENERIC_OPENAI_ROUTES,
        "Go generic OpenAI adapter parity"
    ),
    capability!(
        2,
        "Midjourney",
        TaskOnly,
        Deferred,
        NO_ROUTES,
        "task route is separate; text relay is not supported"
    ),
    capability!(
        3,
        "Azure",
        GenericOpenAi,
        Ready,
        GENERIC_OPENAI_ROUTES,
        "Go generic OpenAI adapter parity"
    ),
    capability!(
        4,
        "Ollama",
        DedicatedPending,
        Deferred,
        NO_ROUTES,
        "dedicated Ollama text adapter is not migrated"
    ),
    capability!(
        5,
        "MidjourneyPlus",
        TaskOnly,
        Deferred,
        NO_ROUTES,
        "task route is separate; text relay is not supported"
    ),
    capability!(
        6,
        "OpenAIMax",
        GenericOpenAi,
        Ready,
        GENERIC_OPENAI_ROUTES,
        "Go generic OpenAI adapter parity"
    ),
    capability!(
        7,
        "OhMyGPT",
        GenericOpenAi,
        Ready,
        GENERIC_OPENAI_ROUTES,
        "Go generic OpenAI adapter parity"
    ),
    capability!(
        8,
        "Custom",
        GenericOpenAi,
        Ready,
        GENERIC_OPENAI_ROUTES,
        "Go generic OpenAI adapter parity"
    ),
    capability!(
        9,
        "AILS",
        GenericOpenAi,
        Ready,
        GENERIC_OPENAI_ROUTES,
        "Go generic OpenAI adapter parity"
    ),
    capability!(
        10,
        "AIProxy",
        GenericOpenAi,
        Ready,
        GENERIC_OPENAI_ROUTES,
        "Go generic OpenAI adapter parity"
    ),
    capability!(
        11,
        "PaLM",
        DedicatedPending,
        Deferred,
        NO_ROUTES,
        "dedicated PaLM adapter is not migrated"
    ),
    capability!(
        12,
        "API2GPT",
        GenericOpenAi,
        Ready,
        GENERIC_OPENAI_ROUTES,
        "Go generic OpenAI adapter parity"
    ),
    capability!(
        13,
        "AIGC2D",
        GenericOpenAi,
        Ready,
        GENERIC_OPENAI_ROUTES,
        "Go generic OpenAI adapter parity"
    ),
    capability!(
        14,
        "Anthropic",
        AnthropicNative,
        Ready,
        ANTHROPIC_ROUTES,
        "native Messages relay is implemented"
    ),
    capability!(
        15,
        "Baidu",
        DedicatedPending,
        Deferred,
        NO_ROUTES,
        "dedicated Baidu adapter is not migrated"
    ),
    capability!(
        16,
        "Zhipu",
        DedicatedPending,
        Deferred,
        NO_ROUTES,
        "dedicated Zhipu adapter is not migrated"
    ),
    capability!(
        17,
        "Ali",
        DedicatedPending,
        Deferred,
        NO_ROUTES,
        "dedicated Ali adapter is not migrated"
    ),
    capability!(
        18,
        "Xunfei",
        DedicatedPending,
        Deferred,
        NO_ROUTES,
        "dedicated Xunfei adapter is not migrated"
    ),
    capability!(
        19,
        "360",
        GenericOpenAi,
        Ready,
        GENERIC_OPENAI_ROUTES,
        "Go generic OpenAI adapter parity"
    ),
    capability!(
        20,
        "OpenRouter",
        GenericOpenAi,
        Ready,
        GENERIC_OPENAI_ROUTES,
        "Go explicitly maps this type to the generic OpenAI adapter"
    ),
    capability!(
        21,
        "AIProxyLibrary",
        Unsupported,
        Deferred,
        NO_ROUTES,
        "Go resolves this type to a nil adapter"
    ),
    capability!(
        22,
        "FastGPT",
        GenericOpenAi,
        Ready,
        GENERIC_OPENAI_ROUTES,
        "Go generic OpenAI adapter parity"
    ),
    capability!(
        23,
        "Tencent",
        DedicatedPending,
        Deferred,
        NO_ROUTES,
        "dedicated Tencent adapter is not migrated"
    ),
    capability!(
        24,
        "Gemini",
        GeminiNative,
        Ready,
        GEMINI_ROUTES,
        "native Gemini route family is implemented"
    ),
    capability!(
        25,
        "Moonshot",
        DedicatedPending,
        Deferred,
        NO_ROUTES,
        "dual OpenAI and Claude adapter is not migrated"
    ),
    capability!(
        26,
        "ZhipuV4",
        DedicatedPending,
        Deferred,
        NO_ROUTES,
        "dedicated Zhipu v4 adapter is not migrated"
    ),
    capability!(
        27,
        "Perplexity",
        DedicatedPending,
        Deferred,
        NO_ROUTES,
        "dedicated Perplexity adapter is not migrated"
    ),
    capability!(
        31,
        "LingYiWanWu",
        GenericOpenAi,
        Ready,
        GENERIC_OPENAI_ROUTES,
        "Go generic OpenAI adapter parity"
    ),
    capability!(
        33,
        "AWS",
        DedicatedPending,
        Deferred,
        NO_ROUTES,
        "SigV4 adapter is not migrated"
    ),
    capability!(
        34,
        "Cohere",
        Rerank,
        Partial,
        RERANK_ROUTES,
        "rerank is implemented; other Cohere routes are deferred"
    ),
    capability!(
        35,
        "MiniMax",
        DedicatedPending,
        Deferred,
        NO_ROUTES,
        "dedicated MiniMax text adapter is not migrated"
    ),
    capability!(
        36,
        "SunoAPI",
        TaskOnly,
        Deferred,
        NO_ROUTES,
        "task route is separate; text relay is not supported"
    ),
    capability!(
        37,
        "Dify",
        DedicatedPending,
        Deferred,
        NO_ROUTES,
        "dedicated application adapter is not migrated"
    ),
    capability!(
        38,
        "Jina",
        Rerank,
        Partial,
        RERANK_ROUTES,
        "rerank is implemented; embedding parity remains deferred"
    ),
    capability!(
        39,
        "Cloudflare",
        CloudflareWorkersAi,
        Partial,
        CLOUDFLARE_ROUTES,
        "chat is implemented through Workers AI binding or REST"
    ),
    capability!(
        40,
        "SiliconFlow",
        DedicatedPending,
        Deferred,
        NO_ROUTES,
        "dedicated SiliconFlow adapter is not migrated"
    ),
    capability!(
        41,
        "VertexAI",
        DedicatedPending,
        Deferred,
        NO_ROUTES,
        "dedicated Vertex AI text adapter is not migrated"
    ),
    capability!(
        42,
        "Mistral",
        DedicatedPending,
        Deferred,
        NO_ROUTES,
        "dedicated Mistral adapter is not migrated"
    ),
    capability!(
        43,
        "DeepSeek",
        DeepSeek,
        Partial,
        DEEPSEEK_ROUTES,
        "chat, legacy completions, and Anthropic Messages are implemented"
    ),
    capability!(
        44,
        "MokaAI",
        DedicatedPending,
        Deferred,
        NO_ROUTES,
        "dedicated MokaAI adapter is not migrated"
    ),
    capability!(
        45,
        "VolcEngine",
        DedicatedPending,
        Deferred,
        NO_ROUTES,
        "dedicated VolcEngine text adapter is not migrated"
    ),
    capability!(
        46,
        "BaiduV2",
        DedicatedPending,
        Deferred,
        NO_ROUTES,
        "dedicated Baidu v2 adapter is not migrated"
    ),
    capability!(
        47,
        "Xinference",
        GenericOpenAi,
        Ready,
        GENERIC_OPENAI_ROUTES,
        "Go explicitly maps this type to the generic OpenAI adapter"
    ),
    capability!(
        48,
        "xAI",
        XaiOpenAi,
        Partial,
        XAI_ROUTES,
        "dedicated chat, legacy completions, Responses, and image generation adapter is implemented"
    ),
    capability!(
        49,
        "Coze",
        DedicatedPending,
        Deferred,
        NO_ROUTES,
        "dedicated application adapter is not migrated"
    ),
    capability!(
        50,
        "Kling",
        TaskOnly,
        Deferred,
        NO_ROUTES,
        "task route is separate; text relay is not supported"
    ),
    capability!(
        51,
        "Jimeng",
        DedicatedPending,
        Deferred,
        NO_ROUTES,
        "dedicated Jimeng text adapter is not migrated"
    ),
    capability!(
        52,
        "Vidu",
        TaskOnly,
        Deferred,
        NO_ROUTES,
        "task route is separate; text relay is not supported"
    ),
    capability!(
        53,
        "Submodel",
        DedicatedPending,
        Deferred,
        NO_ROUTES,
        "dedicated Submodel adapter is not migrated"
    ),
    capability!(
        54,
        "DoubaoVideo",
        TaskOnly,
        Deferred,
        NO_ROUTES,
        "task route is separate; text relay is not supported"
    ),
    capability!(
        55,
        "Sora",
        TaskOnly,
        Deferred,
        NO_ROUTES,
        "video task path is separate; text fallback is not enabled"
    ),
    capability!(
        56,
        "Replicate",
        DedicatedPending,
        Deferred,
        NO_ROUTES,
        "dedicated text and media adapter is not migrated"
    ),
    capability!(
        57,
        "Codex",
        DedicatedPending,
        Deferred,
        NO_ROUTES,
        "subscription-backed relay adapter is not migrated"
    ),
];

pub fn channel_capabilities() -> &'static [ChannelRelayCapability] {
    CHANNEL_RELAY_CAPABILITIES
}

pub fn channel_capability(channel_type: i32) -> Option<&'static ChannelRelayCapability> {
    CHANNEL_RELAY_CAPABILITIES
        .iter()
        .find(|capability| capability.channel_type == channel_type)
}

pub fn channel_supports_relay_route(channel_type: i32, route: ProviderRelayRoute) -> bool {
    channel_capability(channel_type)
        .is_some_and(|capability| capability.supported_routes.contains(&route))
}

pub fn channel_types_for_relay_route(route: ProviderRelayRoute) -> Vec<i32> {
    CHANNEL_RELAY_CAPABILITIES
        .iter()
        .filter(|capability| capability.supported_routes.contains(&route))
        .map(|capability| capability.channel_type)
        .collect()
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;

    const GO_CHANNEL_TYPES: &[i32] = &[
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
        26, 27, 31, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52,
        53, 54, 55, 56, 57,
    ];

    #[test]
    fn registry_covers_every_go_channel_type_once() {
        let actual = CHANNEL_RELAY_CAPABILITIES
            .iter()
            .map(|capability| capability.channel_type)
            .collect::<Vec<_>>();
        assert_eq!(actual, GO_CHANNEL_TYPES);
        assert_eq!(
            actual.iter().copied().collect::<BTreeSet<_>>().len(),
            actual.len()
        );
    }

    #[test]
    fn generic_openai_set_matches_go_adapter_dispatch() {
        let expected = [1, 3, 6, 7, 8, 9, 10, 12, 13, 19, 20, 22, 31, 47];
        let actual = CHANNEL_RELAY_CAPABILITIES
            .iter()
            .filter(|capability| capability.adapter == ChannelAdapterKind::GenericOpenAi)
            .map(|capability| capability.channel_type)
            .collect::<Vec<_>>();
        assert_eq!(actual, expected);
        assert_eq!(actual, cinatoken_relay::OPENAI_COMPATIBLE_CHANNEL_TYPES);
    }

    #[test]
    fn dedicated_types_fail_closed_except_explicit_routes() {
        assert!(channel_supports_relay_route(
            43,
            ProviderRelayRoute::ChatCompletions
        ));
        assert!(channel_supports_relay_route(
            43,
            ProviderRelayRoute::Completions
        ));
        assert!(channel_supports_relay_route(
            43,
            ProviderRelayRoute::AnthropicMessages
        ));
        assert!(!channel_supports_relay_route(
            43,
            ProviderRelayRoute::Responses
        ));
        assert!(!channel_supports_relay_route(
            15,
            ProviderRelayRoute::ChatCompletions
        ));
        assert!(channel_supports_relay_route(
            48,
            ProviderRelayRoute::ChatCompletions
        ));
        assert!(channel_supports_relay_route(
            48,
            ProviderRelayRoute::Responses
        ));
        assert!(channel_supports_relay_route(
            48,
            ProviderRelayRoute::ImageGenerations
        ));
        assert!(!channel_supports_relay_route(
            48,
            ProviderRelayRoute::Embeddings
        ));
        assert!(!channel_supports_relay_route(
            21,
            ProviderRelayRoute::ChatCompletions
        ));
        assert_eq!(
            channel_types_for_relay_route(ProviderRelayRoute::AnthropicMessages),
            vec![14, 43]
        );
        assert_eq!(
            channel_types_for_relay_route(ProviderRelayRoute::Realtime),
            vec![1, 3, 6, 7, 8, 9, 10, 12, 13, 19, 20, 22, 31, 47]
        );
    }

    #[test]
    fn dedicated_route_sets_are_explicit() {
        assert_eq!(
            channel_types_for_relay_route(ProviderRelayRoute::Rerank),
            vec![34, 38]
        );
        assert_eq!(
            channel_types_for_relay_route(ProviderRelayRoute::GeminiNative),
            vec![24]
        );
        assert!(channel_types_for_relay_route(ProviderRelayRoute::Responses)
            .iter()
            .all(|channel_type| *channel_type != 43));
        assert_ne!(
            ProviderRelayRoute::ChatCompletions.cache_family(),
            ProviderRelayRoute::Embeddings.cache_family()
        );
        assert_ne!(
            ProviderRelayRoute::ChatCompletions.cache_family(),
            ProviderRelayRoute::Realtime.cache_family()
        );
    }
}
