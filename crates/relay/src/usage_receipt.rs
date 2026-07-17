//! Canonical provider-usage evidence emitted by the private non-streaming
//! OpenAI chat-completions egress boundary.

use std::{error::Error, fmt, str};

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::openai_compatible::{
    usage_summary_from_body, ImageGenerationQuality, ImageGenerationSize,
};

pub const PROVIDER_USAGE_RECEIPT_SCHEMA_VERSION: u32 = 1;
pub const PROVIDER_USAGE_RECEIPT_PARSER_CONTRACT: &str = "openai-chat-completions-usage-v1";
pub const PROVIDER_USAGE_RECEIPT_NORMALIZATION_CONTRACT: &str = "billing-token-normalization-v1";
pub const PROVIDER_USAGE_RECEIPT_SOURCE: &str = "provider_response";
pub const PROVIDER_USAGE_RECEIPT_EGRESS_PROFILE: &str = "openai-chat-completions-canary-v1";
pub const MAX_PROVIDER_USAGE_RECEIPT_JSON_BYTES: usize = 8_192;
pub const MAX_PROVIDER_USAGE_RECEIPT_ENCODED_BYTES: usize = 12_288;

/// The provider reported a top-level `usage.prompt_tokens` or `usage.input_tokens` integer.
pub const REPORTED_USAGE_PROMPT_TOKENS: u32 = 1 << 0;
/// The provider reported a top-level `usage.completion_tokens` or `usage.output_tokens` integer.
pub const REPORTED_USAGE_COMPLETION_TOKENS: u32 = 1 << 1;
/// The provider reported a top-level `usage.total_tokens` integer.
pub const REPORTED_USAGE_TOTAL_TOKENS: u32 = 1 << 2;
/// The provider reported a recognized nested cached-input token integer.
pub const REPORTED_USAGE_CACHED_TOKENS: u32 = 1 << 3;
/// The provider reported a recognized aggregate cache-creation token integer.
pub const REPORTED_USAGE_CACHE_CREATION_TOKENS: u32 = 1 << 4;
/// The provider reported a recognized five-minute cache-creation token integer.
pub const REPORTED_USAGE_CACHE_CREATION_TOKENS_5M: u32 = 1 << 5;
/// The provider reported a recognized one-hour cache-creation token integer.
pub const REPORTED_USAGE_CACHE_CREATION_TOKENS_1H: u32 = 1 << 6;
/// The provider reported a recognized nested image-input token integer.
pub const REPORTED_USAGE_IMAGE_INPUT_TOKENS: u32 = 1 << 7;
/// The provider reported a recognized nested image-output token integer.
pub const REPORTED_USAGE_IMAGE_OUTPUT_TOKENS: u32 = 1 << 8;
/// The provider reported a recognized nested audio-input token integer.
pub const REPORTED_USAGE_AUDIO_INPUT_TOKENS: u32 = 1 << 9;
/// The provider reported a recognized nested audio-output token integer.
pub const REPORTED_USAGE_AUDIO_OUTPUT_TOKENS: u32 = 1 << 10;
/// All and only the bits permitted by the v1 receipt contract.
pub const REPORTED_USAGE_FIELDS_ALL: u32 = 2_047;

const REQUIRED_USAGE_FIELDS: u32 = REPORTED_USAGE_PROMPT_TOKENS | REPORTED_USAGE_COMPLETION_TOKENS;
const MAX_IDENTITY_BYTES: usize = 128;
const MAX_GENERATION: i64 = 9_007_199_254_740_991;
const MAX_ATTEMPT_GENERATION: i64 = 3;
const MAX_UNIX_MILLISECONDS: i64 = 253_402_300_799_999;
const MAX_NORMALIZED_TOKENS: i64 = i32::MAX as i64;
const MAX_TOOL_CALLS: i64 = 256;
const MAX_DECIMAL_BYTES: usize = 64;
const MAX_PROVIDER_COST_USD: i64 = 1_000_000_000_000;

/// Canonical JSON contract. Field declaration order is the wire order.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProviderUsageReceiptV1 {
    pub schema_version: u32,
    pub parser_contract: String,
    pub normalization_contract: String,
    pub source: String,
    pub estimated: bool,
    pub operation_id: String,
    pub owner_generation: i64,
    pub attempt_generation: i64,
    pub provider_operation_id: String,
    pub request_sha256: String,
    pub egress_profile: String,
    pub egress_worker_version_id: String,
    pub provider_response_status: u16,
    pub provider_response_sha256: String,
    pub provider_request_id: Option<String>,
    pub provider_completed_at: i64,
    pub usage_present: bool,
    pub reported_usage_fields: u32,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
    pub cached_tokens: i64,
    pub cache_creation_tokens: i64,
    pub cache_creation_tokens_5m: i64,
    pub cache_creation_tokens_1h: i64,
    pub image_input_tokens: i64,
    pub image_output_tokens: i64,
    pub audio_input_tokens: i64,
    pub audio_output_tokens: i64,
    pub is_anthropic_usage_semantic: bool,
    pub usage_semantic_source: String,
    pub provider_cost_usd: Option<String>,
    pub cache_creation_source: String,
    pub responses_web_search_calls: i64,
    pub responses_file_search_calls: i64,
    pub claude_web_search_calls: i64,
    pub image_generation_quality: Option<String>,
    pub image_generation_size: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub struct ProviderUsageReceiptInput<'a> {
    pub operation_id: &'a str,
    pub owner_generation: i64,
    pub attempt_generation: i64,
    pub provider_operation_id: &'a str,
    pub request_sha256: &'a str,
    pub egress_worker_version_id: &'a str,
    pub provider_response_status: u16,
    pub provider_response_body: &'a [u8],
    pub provider_request_id: Option<&'a str>,
    pub provider_completed_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderUsageReceiptError {
    InvalidProviderResponse,
    InvalidField(&'static str),
    InvalidJson,
    NonCanonical,
    DigestMismatch,
    TooLarge,
    Serialization,
}

impl fmt::Display for ProviderUsageReceiptError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidProviderResponse => formatter.write_str("invalid provider response"),
            Self::InvalidField(field) => write!(formatter, "invalid receipt field: {field}"),
            Self::InvalidJson => formatter.write_str("invalid receipt JSON"),
            Self::NonCanonical => formatter.write_str("noncanonical receipt JSON"),
            Self::DigestMismatch => formatter.write_str("receipt digest mismatch"),
            Self::TooLarge => formatter.write_str("receipt exceeds the size bound"),
            Self::Serialization => formatter.write_str("receipt serialization failed"),
        }
    }
}

impl Error for ProviderUsageReceiptError {}

impl ProviderUsageReceiptV1 {
    pub fn from_provider_response(
        input: ProviderUsageReceiptInput<'_>,
    ) -> Result<Self, ProviderUsageReceiptError> {
        let body = str::from_utf8(input.provider_response_body)
            .map_err(|_| ProviderUsageReceiptError::InvalidProviderResponse)?;
        let value: Value = serde_json::from_slice(input.provider_response_body)
            .map_err(|_| ProviderUsageReceiptError::InvalidProviderResponse)?;
        validate_reported_usage_values(&value)?;
        let summary = usage_summary_from_body(body);
        let reported_usage_fields = reported_usage_fields(&value);
        let image_generation = summary.tool_usage.image_generation;

        let receipt = Self {
            schema_version: PROVIDER_USAGE_RECEIPT_SCHEMA_VERSION,
            parser_contract: PROVIDER_USAGE_RECEIPT_PARSER_CONTRACT.to_string(),
            normalization_contract: PROVIDER_USAGE_RECEIPT_NORMALIZATION_CONTRACT.to_string(),
            source: PROVIDER_USAGE_RECEIPT_SOURCE.to_string(),
            estimated: false,
            operation_id: input.operation_id.to_string(),
            owner_generation: input.owner_generation,
            attempt_generation: input.attempt_generation,
            provider_operation_id: input.provider_operation_id.to_string(),
            request_sha256: input.request_sha256.to_string(),
            egress_profile: PROVIDER_USAGE_RECEIPT_EGRESS_PROFILE.to_string(),
            egress_worker_version_id: input.egress_worker_version_id.to_string(),
            provider_response_status: input.provider_response_status,
            provider_response_sha256: sha256_lower_hex(input.provider_response_body),
            provider_request_id: input.provider_request_id.map(str::to_string),
            provider_completed_at: input.provider_completed_at,
            usage_present: reported_usage_fields & REQUIRED_USAGE_FIELDS == REQUIRED_USAGE_FIELDS,
            reported_usage_fields,
            prompt_tokens: reported_value(
                reported_usage_fields,
                REPORTED_USAGE_PROMPT_TOKENS,
                summary.prompt_tokens,
            ),
            completion_tokens: reported_value(
                reported_usage_fields,
                REPORTED_USAGE_COMPLETION_TOKENS,
                summary.completion_tokens,
            ),
            total_tokens: reported_value(
                reported_usage_fields,
                REPORTED_USAGE_TOTAL_TOKENS,
                summary.total_tokens,
            ),
            cached_tokens: reported_value(
                reported_usage_fields,
                REPORTED_USAGE_CACHED_TOKENS,
                summary.cached_tokens,
            ),
            cache_creation_tokens: reported_value(
                reported_usage_fields,
                REPORTED_USAGE_CACHE_CREATION_TOKENS,
                summary.cache_creation_tokens,
            ),
            cache_creation_tokens_5m: reported_value(
                reported_usage_fields,
                REPORTED_USAGE_CACHE_CREATION_TOKENS_5M,
                summary.claude_cache_creation_5m_tokens,
            ),
            cache_creation_tokens_1h: reported_value(
                reported_usage_fields,
                REPORTED_USAGE_CACHE_CREATION_TOKENS_1H,
                summary.claude_cache_creation_1h_tokens,
            ),
            image_input_tokens: reported_value(
                reported_usage_fields,
                REPORTED_USAGE_IMAGE_INPUT_TOKENS,
                summary.image_input_tokens,
            ),
            image_output_tokens: reported_value(
                reported_usage_fields,
                REPORTED_USAGE_IMAGE_OUTPUT_TOKENS,
                summary.image_output_tokens,
            ),
            audio_input_tokens: reported_value(
                reported_usage_fields,
                REPORTED_USAGE_AUDIO_INPUT_TOKENS,
                summary.audio_input_tokens,
            ),
            audio_output_tokens: reported_value(
                reported_usage_fields,
                REPORTED_USAGE_AUDIO_OUTPUT_TOKENS,
                summary.audio_output_tokens,
            ),
            is_anthropic_usage_semantic: summary.is_anthropic_usage_semantic,
            usage_semantic_source: summary.usage_semantic_source.as_str().to_string(),
            provider_cost_usd: summary
                .provider_cost_usd
                .map(|value| value.normalize().to_string()),
            cache_creation_source: summary.cache_creation_source.as_str().to_string(),
            responses_web_search_calls: i64::from(summary.tool_usage.responses_web_search_calls),
            responses_file_search_calls: i64::from(summary.tool_usage.responses_file_search_calls),
            claude_web_search_calls: i64::from(summary.tool_usage.claude_web_search_calls),
            image_generation_quality: image_generation
                .map(|usage| image_generation_quality(usage.quality).to_string()),
            image_generation_size: image_generation
                .map(|usage| image_generation_size(usage.size).to_string()),
        };
        receipt.validate()?;
        Ok(receipt)
    }

    pub fn validate(&self) -> Result<(), ProviderUsageReceiptError> {
        if self.schema_version != PROVIDER_USAGE_RECEIPT_SCHEMA_VERSION {
            return Err(ProviderUsageReceiptError::InvalidField("schema_version"));
        }
        require_exact(
            &self.parser_contract,
            PROVIDER_USAGE_RECEIPT_PARSER_CONTRACT,
            "parser_contract",
        )?;
        require_exact(
            &self.normalization_contract,
            PROVIDER_USAGE_RECEIPT_NORMALIZATION_CONTRACT,
            "normalization_contract",
        )?;
        require_exact(&self.source, PROVIDER_USAGE_RECEIPT_SOURCE, "source")?;
        if self.estimated {
            return Err(ProviderUsageReceiptError::InvalidField("estimated"));
        }
        require_identifier(&self.operation_id, "operation_id")?;
        if !(1..=MAX_GENERATION).contains(&self.owner_generation) {
            return Err(ProviderUsageReceiptError::InvalidField("owner_generation"));
        }
        if !(1..=MAX_ATTEMPT_GENERATION).contains(&self.attempt_generation) {
            return Err(ProviderUsageReceiptError::InvalidField(
                "attempt_generation",
            ));
        }
        require_identifier(&self.provider_operation_id, "provider_operation_id")?;
        require_sha256(&self.request_sha256, "request_sha256")?;
        require_exact(
            &self.egress_profile,
            PROVIDER_USAGE_RECEIPT_EGRESS_PROFILE,
            "egress_profile",
        )?;
        require_identifier(&self.egress_worker_version_id, "egress_worker_version_id")?;
        if !(200..=299).contains(&self.provider_response_status) {
            return Err(ProviderUsageReceiptError::InvalidField(
                "provider_response_status",
            ));
        }
        require_sha256(&self.provider_response_sha256, "provider_response_sha256")?;
        if let Some(provider_request_id) = &self.provider_request_id {
            require_identifier(provider_request_id, "provider_request_id")?;
        }
        if !(1..=MAX_UNIX_MILLISECONDS).contains(&self.provider_completed_at) {
            return Err(ProviderUsageReceiptError::InvalidField(
                "provider_completed_at",
            ));
        }
        if self.reported_usage_fields & !REPORTED_USAGE_FIELDS_ALL != 0 {
            return Err(ProviderUsageReceiptError::InvalidField(
                "reported_usage_fields",
            ));
        }
        let expected_usage_present =
            self.reported_usage_fields & REQUIRED_USAGE_FIELDS == REQUIRED_USAGE_FIELDS;
        if self.usage_present != expected_usage_present {
            return Err(ProviderUsageReceiptError::InvalidField("usage_present"));
        }
        for (field, bit, value) in [
            (
                "prompt_tokens",
                REPORTED_USAGE_PROMPT_TOKENS,
                self.prompt_tokens,
            ),
            (
                "completion_tokens",
                REPORTED_USAGE_COMPLETION_TOKENS,
                self.completion_tokens,
            ),
            (
                "total_tokens",
                REPORTED_USAGE_TOTAL_TOKENS,
                self.total_tokens,
            ),
            (
                "cached_tokens",
                REPORTED_USAGE_CACHED_TOKENS,
                self.cached_tokens,
            ),
            (
                "cache_creation_tokens",
                REPORTED_USAGE_CACHE_CREATION_TOKENS,
                self.cache_creation_tokens,
            ),
            (
                "cache_creation_tokens_5m",
                REPORTED_USAGE_CACHE_CREATION_TOKENS_5M,
                self.cache_creation_tokens_5m,
            ),
            (
                "cache_creation_tokens_1h",
                REPORTED_USAGE_CACHE_CREATION_TOKENS_1H,
                self.cache_creation_tokens_1h,
            ),
            (
                "image_input_tokens",
                REPORTED_USAGE_IMAGE_INPUT_TOKENS,
                self.image_input_tokens,
            ),
            (
                "image_output_tokens",
                REPORTED_USAGE_IMAGE_OUTPUT_TOKENS,
                self.image_output_tokens,
            ),
            (
                "audio_input_tokens",
                REPORTED_USAGE_AUDIO_INPUT_TOKENS,
                self.audio_input_tokens,
            ),
            (
                "audio_output_tokens",
                REPORTED_USAGE_AUDIO_OUTPUT_TOKENS,
                self.audio_output_tokens,
            ),
        ] {
            if !(0..=MAX_NORMALIZED_TOKENS).contains(&value)
                || (self.reported_usage_fields & bit == 0 && value != 0)
            {
                return Err(ProviderUsageReceiptError::InvalidField(field));
            }
        }
        if !matches!(
            self.usage_semantic_source.as_str(),
            "openai_default" | "upstream_explicit" | "native_anthropic"
        ) {
            return Err(ProviderUsageReceiptError::InvalidField(
                "usage_semantic_source",
            ));
        }
        if let Some(provider_cost_usd) = &self.provider_cost_usd {
            validate_canonical_decimal(provider_cost_usd)?;
        }
        if !matches!(
            self.cache_creation_source.as_str(),
            "none" | "upstream_aggregate" | "upstream_split"
        ) {
            return Err(ProviderUsageReceiptError::InvalidField(
                "cache_creation_source",
            ));
        }
        for (field, value) in [
            (
                "responses_web_search_calls",
                self.responses_web_search_calls,
            ),
            (
                "responses_file_search_calls",
                self.responses_file_search_calls,
            ),
            ("claude_web_search_calls", self.claude_web_search_calls),
        ] {
            if !(0..=MAX_TOOL_CALLS).contains(&value) {
                return Err(ProviderUsageReceiptError::InvalidField(field));
            }
        }
        if self
            .image_generation_quality
            .as_deref()
            .is_some_and(|value| !matches!(value, "low" | "medium" | "high"))
        {
            return Err(ProviderUsageReceiptError::InvalidField(
                "image_generation_quality",
            ));
        }
        if self
            .image_generation_size
            .as_deref()
            .is_some_and(|value| !matches!(value, "1024x1024" | "1024x1536" | "1536x1024"))
        {
            return Err(ProviderUsageReceiptError::InvalidField(
                "image_generation_size",
            ));
        }
        if self.image_generation_quality.is_some() != self.image_generation_size.is_some() {
            return Err(ProviderUsageReceiptError::InvalidField(
                "image_generation_quality",
            ));
        }
        Ok(())
    }

    pub fn to_canonical_json(&self) -> Result<Vec<u8>, ProviderUsageReceiptError> {
        self.validate()?;
        let canonical =
            serde_json::to_vec(self).map_err(|_| ProviderUsageReceiptError::Serialization)?;
        if canonical.len() > MAX_PROVIDER_USAGE_RECEIPT_JSON_BYTES {
            return Err(ProviderUsageReceiptError::TooLarge);
        }
        Ok(canonical)
    }

    pub fn canonical_sha256(&self) -> Result<String, ProviderUsageReceiptError> {
        Ok(sha256_lower_hex(&self.to_canonical_json()?))
    }

    pub fn parse_canonical_json(bytes: &[u8]) -> Result<Self, ProviderUsageReceiptError> {
        if bytes.is_empty() || bytes.len() > MAX_PROVIDER_USAGE_RECEIPT_JSON_BYTES {
            return Err(ProviderUsageReceiptError::TooLarge);
        }
        let receipt: Self =
            serde_json::from_slice(bytes).map_err(|_| ProviderUsageReceiptError::InvalidJson)?;
        receipt.validate()?;
        let canonical = receipt.to_canonical_json()?;
        if canonical != bytes {
            return Err(ProviderUsageReceiptError::NonCanonical);
        }
        Ok(receipt)
    }

    pub fn parse_canonical_json_with_sha256(
        bytes: &[u8],
        expected_sha256: &str,
    ) -> Result<Self, ProviderUsageReceiptError> {
        if bytes.is_empty() || bytes.len() > MAX_PROVIDER_USAGE_RECEIPT_JSON_BYTES {
            return Err(ProviderUsageReceiptError::TooLarge);
        }
        require_sha256(expected_sha256, "receipt_sha256")?;
        if sha256_lower_hex(bytes) != expected_sha256 {
            return Err(ProviderUsageReceiptError::DigestMismatch);
        }
        Self::parse_canonical_json(bytes)
    }
}

pub fn sha256_lower_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn reported_value(fields: u32, bit: u32, value: i32) -> i64 {
    if fields & bit == 0 {
        0
    } else {
        i64::from(value)
    }
}

fn reported_usage_fields(value: &Value) -> u32 {
    let Some(usage) = value.get("usage") else {
        return 0;
    };
    let input_details = [
        "prompt_tokens_details",
        "input_tokens_details",
        "input_token_details",
    ];
    let output_details = [
        "completion_tokens_details",
        "output_tokens_details",
        "output_token_details",
    ];
    let mut fields = 0;
    if has_integer_field(usage, &["prompt_tokens", "input_tokens"]) {
        fields |= REPORTED_USAGE_PROMPT_TOKENS;
    }
    if has_integer_field(usage, &["completion_tokens", "output_tokens"]) {
        fields |= REPORTED_USAGE_COMPLETION_TOKENS;
    }
    if has_integer_field(usage, &["total_tokens"]) {
        fields |= REPORTED_USAGE_TOTAL_TOKENS;
    }
    if has_nested_integer_field(usage, &input_details, &["cached_tokens"]) {
        fields |= REPORTED_USAGE_CACHED_TOKENS;
    }
    if has_nested_integer_field(usage, &input_details, &["cached_creation_tokens"]) {
        fields |= REPORTED_USAGE_CACHE_CREATION_TOKENS;
    }
    if has_integer_field(
        usage,
        &[
            "claude_cache_creation_5_m_tokens",
            "claude_cache_creation_5m_tokens",
        ],
    ) || has_nested_integer_field(usage, &["cache_creation"], &["ephemeral_5m_input_tokens"])
    {
        fields |= REPORTED_USAGE_CACHE_CREATION_TOKENS_5M;
    }
    if has_integer_field(
        usage,
        &[
            "claude_cache_creation_1_h_tokens",
            "claude_cache_creation_1h_tokens",
        ],
    ) || has_nested_integer_field(usage, &["cache_creation"], &["ephemeral_1h_input_tokens"])
    {
        fields |= REPORTED_USAGE_CACHE_CREATION_TOKENS_1H;
    }
    if has_nested_integer_field(usage, &input_details, &["image_tokens"]) {
        fields |= REPORTED_USAGE_IMAGE_INPUT_TOKENS;
    }
    if has_nested_integer_field(usage, &output_details, &["image_tokens"])
        || (is_image_generation_usage_value(value) && has_integer_field(usage, &["output_tokens"]))
    {
        fields |= REPORTED_USAGE_IMAGE_OUTPUT_TOKENS;
    }
    if has_nested_integer_field(usage, &input_details, &["audio_tokens"]) {
        fields |= REPORTED_USAGE_AUDIO_INPUT_TOKENS;
    }
    if has_nested_integer_field(usage, &output_details, &["audio_tokens"]) {
        fields |= REPORTED_USAGE_AUDIO_OUTPUT_TOKENS;
    }
    fields
}

fn validate_reported_usage_values(value: &Value) -> Result<(), ProviderUsageReceiptError> {
    let Some(usage) = value.get("usage").filter(|value| value.is_object()) else {
        return Ok(());
    };
    validate_integer_fields(usage, &["prompt_tokens", "input_tokens"], "prompt_tokens")?;
    validate_integer_fields(
        usage,
        &["completion_tokens", "output_tokens"],
        "completion_tokens",
    )?;
    validate_integer_fields(usage, &["total_tokens"], "total_tokens")?;
    validate_integer_fields(
        usage,
        &[
            "claude_cache_creation_5_m_tokens",
            "claude_cache_creation_5m_tokens",
        ],
        "cache_creation_tokens_5m",
    )?;
    validate_integer_fields(
        usage,
        &[
            "claude_cache_creation_1_h_tokens",
            "claude_cache_creation_1h_tokens",
        ],
        "cache_creation_tokens_1h",
    )?;

    let input_details = [
        "prompt_tokens_details",
        "input_tokens_details",
        "input_token_details",
    ];
    validate_nested_integer_fields(usage, &input_details, &["cached_tokens"], "cached_tokens")?;
    validate_nested_integer_fields(
        usage,
        &input_details,
        &["cached_creation_tokens"],
        "cache_creation_tokens",
    )?;
    validate_nested_integer_fields(
        usage,
        &input_details,
        &["image_tokens"],
        "image_input_tokens",
    )?;
    validate_nested_integer_fields(
        usage,
        &input_details,
        &["audio_tokens"],
        "audio_input_tokens",
    )?;

    let output_details = [
        "completion_tokens_details",
        "output_tokens_details",
        "output_token_details",
    ];
    validate_nested_integer_fields(
        usage,
        &output_details,
        &["image_tokens"],
        "image_output_tokens",
    )?;
    validate_nested_integer_fields(
        usage,
        &output_details,
        &["audio_tokens"],
        "audio_output_tokens",
    )?;
    validate_nested_integer_fields(
        usage,
        &["cache_creation"],
        &["ephemeral_5m_input_tokens"],
        "cache_creation_tokens_5m",
    )?;
    validate_nested_integer_fields(
        usage,
        &["cache_creation"],
        &["ephemeral_1h_input_tokens"],
        "cache_creation_tokens_1h",
    )?;
    Ok(())
}

fn validate_integer_fields(
    value: &Value,
    names: &[&str],
    field: &'static str,
) -> Result<(), ProviderUsageReceiptError> {
    for name in names {
        if value
            .get(*name)
            .is_some_and(|value| !is_normalized_token_integer(value))
        {
            return Err(ProviderUsageReceiptError::InvalidField(field));
        }
    }
    Ok(())
}

fn validate_nested_integer_fields(
    value: &Value,
    object_names: &[&str],
    field_names: &[&str],
    field: &'static str,
) -> Result<(), ProviderUsageReceiptError> {
    for object_name in object_names {
        if let Some(object) = value.get(*object_name).filter(|value| value.is_object()) {
            validate_integer_fields(object, field_names, field)?;
        }
    }
    Ok(())
}

fn is_normalized_token_integer(value: &Value) -> bool {
    value
        .as_i64()
        .is_some_and(|value| (0..=MAX_NORMALIZED_TOKENS).contains(&value))
        || value
            .as_u64()
            .is_some_and(|value| value <= MAX_NORMALIZED_TOKENS as u64)
}

fn has_integer_field(value: &Value, names: &[&str]) -> bool {
    names
        .iter()
        .any(|name| value.get(*name).is_some_and(is_i64_json_integer))
}

fn has_nested_integer_field(value: &Value, object_names: &[&str], field_names: &[&str]) -> bool {
    object_names.iter().any(|object_name| {
        value
            .get(*object_name)
            .is_some_and(|object| has_integer_field(object, field_names))
    })
}

fn is_i64_json_integer(value: &Value) -> bool {
    value.as_i64().is_some()
        || value
            .as_u64()
            .is_some_and(|value| i64::try_from(value).is_ok())
}

fn is_image_generation_usage_value(value: &Value) -> bool {
    value.get("type").and_then(Value::as_str) == Some("image_generation.completed")
        || value.get("data").is_some_and(Value::is_array)
            && value
                .pointer("/usage/input_tokens_details/image_tokens")
                .is_some()
}

fn image_generation_quality(quality: ImageGenerationQuality) -> &'static str {
    match quality {
        ImageGenerationQuality::Low => "low",
        ImageGenerationQuality::Medium => "medium",
        ImageGenerationQuality::High => "high",
    }
}

fn image_generation_size(size: ImageGenerationSize) -> &'static str {
    match size {
        ImageGenerationSize::Square1024 => "1024x1024",
        ImageGenerationSize::Portrait1024x1536 => "1024x1536",
        ImageGenerationSize::Landscape1536x1024 => "1536x1024",
    }
}

fn require_exact(
    value: &str,
    expected: &str,
    field: &'static str,
) -> Result<(), ProviderUsageReceiptError> {
    if value == expected {
        Ok(())
    } else {
        Err(ProviderUsageReceiptError::InvalidField(field))
    }
}

fn require_identifier(value: &str, field: &'static str) -> Result<(), ProviderUsageReceiptError> {
    if !value.is_empty()
        && value.len() <= MAX_IDENTITY_BYTES
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'/' | b'@' | b'-')
        })
    {
        Ok(())
    } else {
        Err(ProviderUsageReceiptError::InvalidField(field))
    }
}

fn require_sha256(value: &str, field: &'static str) -> Result<(), ProviderUsageReceiptError> {
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err(ProviderUsageReceiptError::InvalidField(field))
    }
}

fn validate_canonical_decimal(value: &str) -> Result<(), ProviderUsageReceiptError> {
    if value.is_empty() || value.len() > MAX_DECIMAL_BYTES {
        return Err(ProviderUsageReceiptError::InvalidField("provider_cost_usd"));
    }
    let decimal = value
        .parse::<Decimal>()
        .map_err(|_| ProviderUsageReceiptError::InvalidField("provider_cost_usd"))?;
    if decimal < Decimal::ZERO
        || decimal > Decimal::from(MAX_PROVIDER_COST_USD)
        || decimal.normalize().to_string() != value
    {
        return Err(ProviderUsageReceiptError::InvalidField("provider_cost_usd"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const REQUEST_SHA256: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn receipt(body: &[u8]) -> ProviderUsageReceiptV1 {
        ProviderUsageReceiptV1::from_provider_response(ProviderUsageReceiptInput {
            operation_id: "operation-1",
            owner_generation: 7,
            attempt_generation: 1,
            provider_operation_id: "provider-operation-1",
            request_sha256: REQUEST_SHA256,
            egress_worker_version_id: "worker-version-1",
            provider_response_status: 200,
            provider_response_body: body,
            provider_request_id: Some("request-1"),
            provider_completed_at: 1_752_710_400_123,
        })
        .expect("receipt")
    }

    #[test]
    fn canonical_roundtrip_and_hash_are_exact() {
        let body =
            br#"{"id":"chatcmpl-1","usage":{"prompt_tokens":7,"completion_tokens":5,"total_tokens":12}}"#;
        let receipt = receipt(body);
        let canonical = receipt.to_canonical_json().expect("canonical JSON");
        let canonical_text = str::from_utf8(&canonical).expect("UTF-8");
        let expected = [
            r#"{"schema_version":1,"parser_contract":"openai-chat-completions-usage-v1","normalization_contract":"billing-token-normalization-v1","source":"provider_response","estimated":false,"operation_id":"operation-1","owner_generation":7,"attempt_generation":1,"provider_operation_id":"provider-operation-1","request_sha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","egress_profile":"openai-chat-completions-canary-v1","egress_worker_version_id":"worker-version-1","provider_response_status":200,"provider_response_sha256":""#,
            &receipt.provider_response_sha256,
            r#"","provider_request_id":"request-1","provider_completed_at":1752710400123,"usage_present":true,"reported_usage_fields":7,"prompt_tokens":7,"completion_tokens":5,"total_tokens":12,"cached_tokens":0,"cache_creation_tokens":0,"cache_creation_tokens_5m":0,"cache_creation_tokens_1h":0,"image_input_tokens":0,"image_output_tokens":0,"audio_input_tokens":0,"audio_output_tokens":0,"is_anthropic_usage_semantic":false,"usage_semantic_source":"openai_default","provider_cost_usd":null,"cache_creation_source":"none","responses_web_search_calls":0,"responses_file_search_calls":0,"claude_web_search_calls":0,"image_generation_quality":null,"image_generation_size":null}"#,
        ]
        .concat();
        assert_eq!(canonical_text, expected);
        assert_eq!(receipt.provider_response_sha256, sha256_lower_hex(body));
        let digest = receipt.canonical_sha256().expect("canonical digest");
        assert_eq!(digest, sha256_lower_hex(&canonical));
        assert_eq!(
            ProviderUsageReceiptV1::parse_canonical_json_with_sha256(&canonical, &digest)
                .expect("roundtrip"),
            receipt
        );
    }

    #[test]
    fn v1_reported_usage_bit_allocation_is_frozen() {
        assert_eq!(REPORTED_USAGE_PROMPT_TOKENS, 1);
        assert_eq!(REPORTED_USAGE_COMPLETION_TOKENS, 2);
        assert_eq!(REPORTED_USAGE_TOTAL_TOKENS, 4);
        assert_eq!(REPORTED_USAGE_CACHED_TOKENS, 8);
        assert_eq!(REPORTED_USAGE_CACHE_CREATION_TOKENS, 16);
        assert_eq!(REPORTED_USAGE_CACHE_CREATION_TOKENS_5M, 32);
        assert_eq!(REPORTED_USAGE_CACHE_CREATION_TOKENS_1H, 64);
        assert_eq!(REPORTED_USAGE_IMAGE_INPUT_TOKENS, 128);
        assert_eq!(REPORTED_USAGE_IMAGE_OUTPUT_TOKENS, 256);
        assert_eq!(REPORTED_USAGE_AUDIO_INPUT_TOKENS, 512);
        assert_eq!(REPORTED_USAGE_AUDIO_OUTPUT_TOKENS, 1_024);
        assert_eq!(REPORTED_USAGE_FIELDS_ALL, 2_047);
    }

    #[test]
    fn missing_and_partial_usage_have_explicit_masks() {
        let missing = receipt(br#"{"id":"chatcmpl-missing"}"#);
        assert!(!missing.usage_present);
        assert_eq!(missing.reported_usage_fields, 0);

        let prompt_only = receipt(br#"{"usage":{"prompt_tokens":0}}"#);
        assert!(!prompt_only.usage_present);
        assert_eq!(
            prompt_only.reported_usage_fields,
            REPORTED_USAGE_PROMPT_TOKENS
        );

        let completion_only = receipt(br#"{"usage":{"completion_tokens":4}}"#);
        assert!(!completion_only.usage_present);
        assert_eq!(
            completion_only.reported_usage_fields,
            REPORTED_USAGE_COMPLETION_TOKENS
        );

        let complete_without_total = receipt(br#"{"usage":{"input_tokens":9,"output_tokens":4}}"#);
        assert!(complete_without_total.usage_present);
        assert_eq!(
            complete_without_total.reported_usage_fields,
            REPORTED_USAGE_PROMPT_TOKENS | REPORTED_USAGE_COMPLETION_TOKENS
        );
        assert_eq!(complete_without_total.total_tokens, 0);

        let nested_only =
            receipt(br#"{"response":{"usage":{"prompt_tokens":2,"completion_tokens":1}}}"#);
        assert!(!nested_only.usage_present);
        assert_eq!(nested_only.reported_usage_fields, 0);
        assert_eq!(nested_only.prompt_tokens, 0);
        assert_eq!(nested_only.completion_tokens, 0);
    }

    #[test]
    fn extracts_cache_image_audio_cost_and_tool_facts() {
        let body = br#"{
            "usage": {
                "prompt_tokens": 100,
                "completion_tokens": 20,
                "total_tokens": 120,
                "prompt_tokens_details": {
                    "cached_tokens": 30,
                    "cached_creation_tokens": 5,
                    "image_tokens": 4,
                    "audio_tokens": 6
                },
                "completion_tokens_details": {"image_tokens": 7, "audio_tokens": 8},
                "claude_cache_creation_5m_tokens": 2,
                "cache_creation": {"ephemeral_1h_input_tokens": 3},
                "usage_semantic": "anthropic",
                "cost": 0.012300,
                "server_tool_use": {"web_search_requests": 3}
            },
            "output": [
                {"type": "web_search_call"},
                {"type": "file_search_call"},
                {"type": "image_generation_call", "quality": "medium", "size": "1024x1536"}
            ]
        }"#;
        let receipt = receipt(body);
        assert!(receipt.usage_present);
        assert_eq!(receipt.reported_usage_fields, REPORTED_USAGE_FIELDS_ALL);
        assert_eq!(receipt.cached_tokens, 30);
        assert_eq!(receipt.cache_creation_tokens, 5);
        assert_eq!(receipt.cache_creation_tokens_5m, 2);
        assert_eq!(receipt.cache_creation_tokens_1h, 3);
        assert_eq!(receipt.image_input_tokens, 4);
        assert_eq!(receipt.image_output_tokens, 7);
        assert_eq!(receipt.audio_input_tokens, 6);
        assert_eq!(receipt.audio_output_tokens, 8);
        assert!(receipt.is_anthropic_usage_semantic);
        assert_eq!(receipt.usage_semantic_source, "upstream_explicit");
        assert_eq!(receipt.provider_cost_usd.as_deref(), Some("0.0123"));
        assert_eq!(receipt.cache_creation_source, "upstream_aggregate");
        assert_eq!(receipt.responses_web_search_calls, 1);
        assert_eq!(receipt.responses_file_search_calls, 1);
        assert_eq!(receipt.claude_web_search_calls, 3);
        assert_eq!(receipt.image_generation_quality.as_deref(), Some("medium"));
        assert_eq!(receipt.image_generation_size.as_deref(), Some("1024x1536"));
    }

    #[test]
    fn strict_validation_rejects_tampering_and_unbounded_values() {
        let receipt = receipt(br#"{"usage":{"prompt_tokens":1,"completion_tokens":2}}"#);
        let canonical = receipt.to_canonical_json().expect("canonical JSON");
        let digest = receipt.canonical_sha256().expect("digest");
        let tampered = String::from_utf8(canonical.clone())
            .expect("UTF-8")
            .replace("operation-1", "operation-2")
            .into_bytes();
        assert_eq!(
            ProviderUsageReceiptV1::parse_canonical_json_with_sha256(&tampered, &digest),
            Err(ProviderUsageReceiptError::DigestMismatch)
        );

        let pretty = serde_json::to_vec_pretty(&receipt).expect("pretty JSON");
        assert_eq!(
            ProviderUsageReceiptV1::parse_canonical_json(&pretty),
            Err(ProviderUsageReceiptError::NonCanonical)
        );

        let mut invalid = receipt.clone();
        invalid.provider_response_status = 500;
        assert!(invalid.validate().is_err());
        invalid = receipt.clone();
        invalid.provider_response_sha256 = "A".repeat(64);
        assert!(invalid.validate().is_err());
        invalid = receipt.clone();
        invalid.prompt_tokens = -1;
        assert!(invalid.validate().is_err());
        invalid = receipt.clone();
        invalid.responses_web_search_calls = MAX_TOOL_CALLS + 1;
        assert!(invalid.validate().is_err());
        invalid = receipt.clone();
        invalid.provider_cost_usd = Some("01.0".to_string());
        assert!(invalid.validate().is_err());
        invalid = receipt.clone();
        invalid.operation_id = "bad operation".to_string();
        assert!(invalid.validate().is_err());
        invalid = receipt.clone();
        invalid.reported_usage_fields |= 1 << 11;
        assert!(invalid.validate().is_err());
        invalid = receipt.clone();
        invalid.usage_present = false;
        assert!(invalid.validate().is_err());
        invalid = receipt;
        invalid.reported_usage_fields &= !REPORTED_USAGE_TOTAL_TOKENS;
        invalid.total_tokens = 3;
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn unknown_fields_and_invalid_provider_usage_fail_closed() {
        let receipt = receipt(br#"{"usage":{"prompt_tokens":1,"completion_tokens":2}}"#);
        let mut value = serde_json::to_value(receipt).expect("receipt value");
        value
            .as_object_mut()
            .expect("object")
            .insert("unexpected".to_string(), Value::Bool(true));
        let unknown = serde_json::to_vec(&value).expect("JSON");
        assert_eq!(
            ProviderUsageReceiptV1::parse_canonical_json(&unknown),
            Err(ProviderUsageReceiptError::InvalidJson)
        );

        let invalid_usage =
            ProviderUsageReceiptV1::from_provider_response(ProviderUsageReceiptInput {
                operation_id: "operation-1",
                owner_generation: 1,
                attempt_generation: 1,
                provider_operation_id: "provider-operation-1",
                request_sha256: REQUEST_SHA256,
                egress_worker_version_id: "worker-version-1",
                provider_response_status: 200,
                provider_response_body: br#"{"usage":{"prompt_tokens":-1,"completion_tokens":2}}"#,
                provider_request_id: None,
                provider_completed_at: 1_752_710_400_123,
            });
        assert_eq!(
            invalid_usage,
            Err(ProviderUsageReceiptError::InvalidField("prompt_tokens"))
        );

        for (body, field) in [
            (
                br#"{"usage":{"prompt_tokens":2147483648,"completion_tokens":2}}"#.as_slice(),
                "prompt_tokens",
            ),
            (
                br#"{"usage":{"prompt_tokens":1.5,"completion_tokens":2}}"#.as_slice(),
                "prompt_tokens",
            ),
            (
                br#"{"usage":{"prompt_tokens":1,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":2147483648}}}"#.as_slice(),
                "cached_tokens",
            ),
        ] {
            let invalid_usage =
                ProviderUsageReceiptV1::from_provider_response(ProviderUsageReceiptInput {
                    operation_id: "operation-1",
                    owner_generation: 1,
                    attempt_generation: 1,
                    provider_operation_id: "provider-operation-1",
                    request_sha256: REQUEST_SHA256,
                    egress_worker_version_id: "worker-version-1",
                    provider_response_status: 200,
                    provider_response_body: body,
                    provider_request_id: None,
                    provider_completed_at: 1_752_710_400_123,
                });
            assert_eq!(
                invalid_usage,
                Err(ProviderUsageReceiptError::InvalidField(field))
            );
        }
    }
}
