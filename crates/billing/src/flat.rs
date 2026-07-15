//! Non-tiered ("flat") quota computation.
//!
//! Ports the core of Go's `service/text_quota.go::calculateTextQuotaSummary`.
//! When a model has no `tiered_expr` configured, the relay falls back to
//! this per-token (or per-request fixed-price) formula. The result is the
//! integer quota to deduct from the user and token.
//!
//! ## Formula
//!
//! Fixed-price mode (`ModelPrice` configured):
//! ```text
//! quota = round(model_price * image_price_ratio * quota_per_unit * group_ratio
//!               * other_ratio_product)
//! ```
//!
//! Per-token mode (ports Go `calculateTextQuotaSummary`): each token
//! sub-category is priced at its own ratio, then multiplied by
//! `model_ratio * group_ratio`.
//! ```text
//! ratio              = model_ratio * group_ratio
//! base_tokens        = prompt - cached - cache_creation - image - audio_input
//! base_tokens        = prompt                                   // Anthropic
//! cached_contrib     = cached * cache_ratio
//! cache_create_contrib = cache_creation * cache_creation_ratio   // 5m/1h split
//!                     // for Anthropic: remaining*generic + 5m_tokens*5m + 1h_tokens*1h
//! image_contrib      = image * image_ratio
//! audio_input_contrib = audio_input * audio_ratio
//! audio_output_contrib = audio_output * audio_ratio * audio_completion_ratio
//! completion_quota   = (completion - audio_output) * completion_ratio
//! prompt_quota       = base_tokens + cached_contrib + image_contrib
//!                      + cache_create_contrib + audio_input_contrib
//! quota              = round((prompt_quota + completion_quota) * ratio)
//! ```
//!
//! Guards:
//! - Fixed-price models charge per successful request and do not require token
//!   usage. The caller remains responsible for admitting only billable success.
//! - Per-token mode with `total_tokens == 0` returns `quota = 0`.
//! - `ratio != 0 && quota <= 0` → `quota = 1` (floor for billable models).
//!
//! Final flat settlement uses decimal intermediates and explicit
//! half-away-from-zero rounding, matching Go's `shopspring/decimal` path.
//! Tiered expressions retain the shared float `crate::quota_round` contract.
//!
//! Request-derived multipliers and mutable tool prices are frozen before the
//! upstream call. Settlement adds bounded response-derived tool facts to the
//! frozen token/fixed-price contract and rounds once at the end.

use crate::pricing::PricingConfig;
use rust_decimal::prelude::ToPrimitive;
use rust_decimal::{Decimal, RoundingStrategy};
use serde::{Deserialize, Serialize};

/// Default cache-creation multiplier (matches Go default of 1.25). Exposed
/// for future cache-creation billing; the current flat path only prices
/// cache reads via `cache_ratio`.
#[allow(dead_code)]
pub const DEFAULT_CREATE_CACHE_RATIO: f64 = 1.25;

/// Usage inputs for the flat quota computation. The caller maps from its
/// own usage type (e.g. relay's `UsageSummary`) into this neutral struct
/// so the billing crate stays free of relay types.
#[derive(Debug, Clone, Copy, Default)]
pub struct FlatUsage {
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
    pub cached_tokens: i64,
    /// Cache-write (creation) token count. For Anthropic usage this is the
    /// total; the 5m/1h split fields refine it when present.
    pub cache_creation_tokens: i64,
    /// Anthropic cache-write 5-minute and 1-hour split. When both are 0 the
    /// whole `cache_creation_tokens` is priced at the 5m ratio.
    pub cache_creation_5m_tokens: i64,
    pub cache_creation_1h_tokens: i64,
    /// Vision/image input token count (subtracted from the prompt base and
    /// re-priced at `image_ratio`).
    pub image_tokens: i64,
    /// Audio input tokens used by Gemini's separate per-million USD price.
    pub audio_input_tokens: i64,
    /// Audio output tokens removed from the ordinary completion base and
    /// repriced with `audio_ratio * audio_completion_ratio`.
    pub audio_output_tokens: i64,
    /// Responses and Claude built-in tool facts. These counts are bounded by
    /// the relay parser before entering billing.
    pub web_search_preview_calls: i64,
    pub web_search_calls: i64,
    pub file_search_calls: i64,
    /// GPT Image 1 charges at most one generated-image tool call per response,
    /// matching the Go settlement contract.
    pub image_generation_price_class: Option<ImageGenerationPriceClass>,
    /// True when the upstream usage follows Anthropic semantics, where
    /// `prompt_tokens` already excludes cache hits (so we add them back at
    /// the cache ratio instead of subtracting-then-remultiplying).
    pub is_anthropic_usage_semantic: bool,
}

/// Normalized GPT Image 1 quality/size price class.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImageGenerationPriceClass {
    Low1024x1024,
    Low1024x1536,
    Low1536x1024,
    Medium1024x1024,
    Medium1024x1536,
    Medium1536x1024,
    High1024x1024,
    High1024x1536,
    High1536x1024,
}

/// Frozen per-call tool prices. Search prices are USD per 1K calls; image
/// prices are USD per call.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolSurchargePrices {
    pub web_search_preview_per_1k: f64,
    pub web_search_per_1k: f64,
    pub file_search_per_1k: f64,
    pub image_low_1024x1024: f64,
    pub image_low_1024x1536: f64,
    pub image_low_1536x1024: f64,
    pub image_medium_1024x1024: f64,
    pub image_medium_1024x1536: f64,
    pub image_medium_1536x1024: f64,
    pub image_high_1024x1024: f64,
    pub image_high_1024x1536: f64,
    pub image_high_1536x1024: f64,
}

impl ToolSurchargePrices {
    fn from_config(model: &str, config: &PricingConfig) -> Self {
        Self {
            web_search_preview_per_1k: config.tool_price_for_model("web_search_preview", model),
            web_search_per_1k: config.tool_price_for_model("web_search", model),
            file_search_per_1k: config.tool_price_for_model("file_search", model),
            image_low_1024x1024: 0.011,
            image_low_1024x1536: 0.016,
            image_low_1536x1024: 0.016,
            image_medium_1024x1024: 0.042,
            image_medium_1024x1536: 0.063,
            image_medium_1536x1024: 0.063,
            image_high_1024x1024: 0.167,
            image_high_1024x1536: 0.250,
            image_high_1536x1024: 0.250,
        }
    }

    fn image_price(&self, class: ImageGenerationPriceClass) -> f64 {
        match class {
            ImageGenerationPriceClass::Low1024x1024 => self.image_low_1024x1024,
            ImageGenerationPriceClass::Low1024x1536 => self.image_low_1024x1536,
            ImageGenerationPriceClass::Low1536x1024 => self.image_low_1536x1024,
            ImageGenerationPriceClass::Medium1024x1024 => self.image_medium_1024x1024,
            ImageGenerationPriceClass::Medium1024x1536 => self.image_medium_1024x1536,
            ImageGenerationPriceClass::Medium1536x1024 => self.image_medium_1536x1024,
            ImageGenerationPriceClass::High1024x1024 => self.image_high_1024x1024,
            ImageGenerationPriceClass::High1024x1536 => self.image_high_1024x1536,
            ImageGenerationPriceClass::High1536x1024 => self.image_high_1536x1024,
        }
    }

    fn values(&self) -> [f64; 12] {
        [
            self.web_search_preview_per_1k,
            self.web_search_per_1k,
            self.file_search_per_1k,
            self.image_low_1024x1024,
            self.image_low_1024x1536,
            self.image_low_1536x1024,
            self.image_medium_1024x1024,
            self.image_medium_1024x1536,
            self.image_medium_1536x1024,
            self.image_high_1024x1024,
            self.image_high_1024x1536,
            self.image_high_1536x1024,
        ]
    }
}

impl FlatUsage {
    /// Total cache-write tokens, mirroring Go `cacheWriteTokensTotal`: when the
    /// 5m/1h split is present and exceeds `cache_creation_tokens`, use the
    /// split sum; otherwise the whole `cache_creation_tokens`. Used by Go only
    /// for the audit `cache_write_tokens` display field; kept here so a future
    /// audit-metadata port matches Go without re-deriving the rule.
    #[allow(dead_code)]
    fn cache_write_tokens_total(&self) -> i64 {
        let split = self
            .cache_creation_5m_tokens
            .saturating_add(self.cache_creation_1h_tokens);
        if self.cache_creation_5m_tokens > 0 || self.cache_creation_1h_tokens > 0 {
            split.max(self.cache_creation_tokens)
        } else {
            self.cache_creation_tokens
        }
    }
}

/// Which billing mode produced the quota. Surfaced in audit metadata.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FlatBillingMode {
    /// `ModelPrice` was set: quota = price × quota_per_unit × group_ratio.
    FixedPrice,
    /// Per-token formula with model_ratio × completion_ratio × group_ratio.
    PerToken,
}

pub const FREE_MODEL_RUNTIME_POLICY_VERSION: u16 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FreeModelRuntimeReason {
    PreConsumeEnabled,
    GroupRatioZero,
    ModelPriceZero,
    ModelRatioZero,
    NonZeroBasePrice,
}

impl FreeModelRuntimeReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::PreConsumeEnabled => "pre_consume_enabled",
            Self::GroupRatioZero => "group_ratio_zero",
            Self::ModelPriceZero => "model_price_zero",
            Self::ModelRatioZero => "model_ratio_zero",
            Self::NonZeroBasePrice => "non_zero_base_price",
        }
    }
}

/// Frozen Go-compatible decision for `EnableFreeModelPreConsume`.
///
/// A free-model decision skips only the base wallet reservation. Terminal
/// accounting must still retain request counting and independently priced
/// tool/media charges.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct FreeModelRuntimeDecision {
    pub policy_version: u16,
    pub enable_free_model_pre_consume: bool,
    pub free_model: bool,
    pub reason: FreeModelRuntimeReason,
    pub charge_additive_at_settlement: bool,
}

pub fn free_model_runtime_decision(
    snapshot: &FlatPricingSnapshot,
    enable_free_model_pre_consume: bool,
) -> FreeModelRuntimeDecision {
    let (free_model, reason) = if enable_free_model_pre_consume {
        (false, FreeModelRuntimeReason::PreConsumeEnabled)
    } else if snapshot.group_ratio == 0.0 {
        (true, FreeModelRuntimeReason::GroupRatioZero)
    } else if snapshot.mode == FlatBillingMode::FixedPrice && snapshot.model_price == Some(0.0) {
        (true, FreeModelRuntimeReason::ModelPriceZero)
    } else if snapshot.mode == FlatBillingMode::PerToken && snapshot.model_ratio == 0.0 {
        (true, FreeModelRuntimeReason::ModelRatioZero)
    } else {
        (false, FreeModelRuntimeReason::NonZeroBasePrice)
    };
    FreeModelRuntimeDecision {
        policy_version: FREE_MODEL_RUNTIME_POLICY_VERSION,
        enable_free_model_pre_consume,
        free_model,
        reason,
        charge_additive_at_settlement: true,
    }
}

/// Fully resolved, request-time pricing facts for one serving group/channel
/// candidate. Persisting this snapshot prevents mutable D1 options from
/// changing the financial contract while an upstream request is in flight.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FlatPricingSnapshot {
    pub schema_version: u16,
    pub mode: FlatBillingMode,
    pub model_ratio: f64,
    pub completion_ratio: f64,
    pub group_ratio: f64,
    pub cache_ratio: f64,
    pub cache_creation_ratio: f64,
    pub cache_creation_ratio_5m: f64,
    pub cache_creation_ratio_1h: f64,
    pub image_ratio: f64,
    pub audio_ratio: f64,
    pub audio_completion_ratio: f64,
    pub uses_audio_detail_billing: bool,
    pub audio_input_price_per_million: f64,
    pub quota_per_unit: f64,
    pub model_price: Option<f64>,
    pub model_ratio_matches_go_default: bool,
    pub openrouter_cache_write_inference_version: u16,
    /// Fixed-price image size/quality adjustment. Go includes this factor in
    /// pre-consume while excluding `OtherRatios`.
    pub image_price_ratio: f64,
    /// Product of request-time `OtherRatios`, applied after all base and
    /// additive charges in both fixed-price and per-token modes.
    pub other_ratio_product: f64,
    pub tool_prices: ToolSurchargePrices,
    pub pre_consumed_token_floor: i64,
}

impl FlatPricingSnapshot {
    pub const SCHEMA_VERSION: u16 = 4;

    pub fn from_config(
        model: &str,
        group: &str,
        config: &PricingConfig,
        other_ratio_product: f64,
        pre_consumed_token_floor: i64,
    ) -> Self {
        let other_ratio_product = if other_ratio_product.is_finite() && other_ratio_product > 0.0 {
            other_ratio_product
        } else {
            1.0
        };
        let model_price = config.model_price(model);
        Self {
            schema_version: Self::SCHEMA_VERSION,
            mode: if model_price.is_some() {
                FlatBillingMode::FixedPrice
            } else {
                FlatBillingMode::PerToken
            },
            model_ratio: config.model_ratio(model),
            completion_ratio: config.completion_ratio(model),
            group_ratio: config.group_ratio(group),
            cache_ratio: config.cache_ratio(model),
            cache_creation_ratio: config.cache_creation_ratio(model),
            cache_creation_ratio_5m: config.cache_creation_ratio_5m(model),
            cache_creation_ratio_1h: config.cache_creation_ratio_1h(model),
            image_ratio: config.image_ratio(model),
            audio_ratio: config.audio_ratio(model),
            audio_completion_ratio: config.audio_completion_ratio(model),
            uses_audio_detail_billing: config.uses_audio_detail_billing(model),
            audio_input_price_per_million: config.audio_input_price_per_million(model),
            quota_per_unit: config.quota_per_unit,
            model_price,
            model_ratio_matches_go_default: config.model_ratio_matches_go_default(model),
            openrouter_cache_write_inference_version:
                crate::OPENROUTER_CACHE_WRITE_INFERENCE_VERSION,
            image_price_ratio: 1.0,
            other_ratio_product,
            tool_prices: ToolSurchargePrices::from_config(model, config),
            pre_consumed_token_floor: pre_consumed_token_floor.max(0),
        }
    }

    pub fn with_image_price_ratio(mut self, image_price_ratio: f64) -> Self {
        self.image_price_ratio = if image_price_ratio.is_finite() && image_price_ratio > 0.0 {
            image_price_ratio
        } else {
            1.0
        };
        self
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        if self.schema_version != Self::SCHEMA_VERSION {
            return Err("flat pricing snapshot schema is unsupported");
        }
        if self.openrouter_cache_write_inference_version
            != crate::OPENROUTER_CACHE_WRITE_INFERENCE_VERSION
        {
            return Err("flat pricing snapshot OpenRouter inference version is unsupported");
        }
        let values = [
            self.model_ratio,
            self.completion_ratio,
            self.group_ratio,
            self.cache_ratio,
            self.cache_creation_ratio,
            self.cache_creation_ratio_5m,
            self.cache_creation_ratio_1h,
            self.image_ratio,
            self.audio_ratio,
            self.audio_completion_ratio,
            self.audio_input_price_per_million,
            self.quota_per_unit,
            self.image_price_ratio,
            self.other_ratio_product,
        ];
        if values
            .into_iter()
            .any(|value| !value.is_finite() || value < 0.0)
            || self
                .model_price
                .is_some_and(|value| !value.is_finite() || value < 0.0)
            || self.pre_consumed_token_floor < 0
        {
            return Err("flat pricing snapshot contains an invalid price or ratio");
        }
        if self
            .tool_prices
            .values()
            .into_iter()
            .any(|value| !value.is_finite() || value < 0.0)
        {
            return Err("flat pricing snapshot contains an invalid tool price");
        }
        if self.quota_per_unit <= 0.0
            || self.image_price_ratio <= 0.0
            || self.other_ratio_product <= 0.0
        {
            return Err("flat pricing snapshot contains an invalid multiplier");
        }
        if (self.mode == FlatBillingMode::FixedPrice) != self.model_price.is_some() {
            return Err("flat pricing snapshot mode conflicts with model price");
        }
        Ok(())
    }
}

/// Result of a flat quota computation. Includes the resolved ratios for
/// audit logging.
#[derive(Debug, Clone)]
pub struct FlatQuotaResult {
    pub quota: i64,
    pub mode: FlatBillingMode,
    pub model_ratio: f64,
    pub completion_ratio: f64,
    pub group_ratio: f64,
    pub cache_ratio: f64,
    pub image_price_ratio: f64,
    pub other_ratio_product: f64,
    pub audio_input_price_per_million: f64,
    pub audio_ratio: f64,
    pub audio_completion_ratio: f64,
    pub uses_audio_detail_billing: bool,
    pub audio_input_tokens: i64,
    pub audio_output_tokens: i64,
    pub web_search_preview_calls: i64,
    pub web_search_calls: i64,
    pub file_search_calls: i64,
    pub image_generation_price_class: Option<ImageGenerationPriceClass>,
    pub web_search_preview_price_per_1k: f64,
    pub web_search_price_per_1k: f64,
    pub file_search_price_per_1k: f64,
    pub image_generation_price_per_call: Option<f64>,
    /// Additive tool quota before `other_ratio_product` and final rounding.
    pub tool_surcharge_quota: f64,
}

/// Compute the flat quota for a single relay response.
pub fn compute_flat_quota(
    usage: &FlatUsage,
    model: &str,
    group: &str,
    config: &PricingConfig,
) -> FlatQuotaResult {
    compute_flat_quota_with_other_ratio_product(usage, model, group, config, 1.0)
}

/// Compute flat quota while applying a request-derived `OtherRatios` product.
pub fn compute_flat_quota_with_other_ratio_product(
    usage: &FlatUsage,
    model: &str,
    group: &str,
    config: &PricingConfig,
    other_ratio_product: f64,
) -> FlatQuotaResult {
    let snapshot = FlatPricingSnapshot::from_config(model, group, config, other_ratio_product, 0);
    compute_flat_quota_from_snapshot(usage, &snapshot)
}

/// Compute an actual charge exclusively from request-time frozen facts.
pub fn compute_flat_quota_from_snapshot(
    usage: &FlatUsage,
    snapshot: &FlatPricingSnapshot,
) -> FlatQuotaResult {
    let other_ratio_product = snapshot.other_ratio_product;
    let group_ratio = snapshot.group_ratio;
    let model_ratio = snapshot.model_ratio;
    let completion_ratio = snapshot.completion_ratio;
    let cache_ratio = snapshot.cache_ratio;
    let cache_creation_ratio = snapshot.cache_creation_ratio;
    let cache_creation_ratio_5m = snapshot.cache_creation_ratio_5m;
    let cache_creation_ratio_1h = snapshot.cache_creation_ratio_1h;
    let image_ratio = snapshot.image_ratio;
    let result = |quota, tool_surcharge_quota| FlatQuotaResult {
        quota,
        mode: snapshot.mode,
        model_ratio,
        completion_ratio,
        group_ratio,
        cache_ratio,
        image_price_ratio: snapshot.image_price_ratio,
        other_ratio_product,
        audio_input_price_per_million: snapshot.audio_input_price_per_million,
        audio_ratio: snapshot.audio_ratio,
        audio_completion_ratio: snapshot.audio_completion_ratio,
        uses_audio_detail_billing: snapshot.uses_audio_detail_billing,
        audio_input_tokens: usage.audio_input_tokens.max(0),
        audio_output_tokens: usage.audio_output_tokens.max(0),
        web_search_preview_calls: usage.web_search_preview_calls.max(0),
        web_search_calls: usage.web_search_calls.max(0),
        file_search_calls: usage.file_search_calls.max(0),
        image_generation_price_class: usage.image_generation_price_class,
        web_search_preview_price_per_1k: snapshot.tool_prices.web_search_preview_per_1k,
        web_search_price_per_1k: snapshot.tool_prices.web_search_per_1k,
        file_search_price_per_1k: snapshot.tool_prices.file_search_per_1k,
        image_generation_price_per_call: usage
            .image_generation_price_class
            .map(|class| snapshot.tool_prices.image_price(class)),
        tool_surcharge_quota,
    };

    let (
        Some(d_model_ratio),
        Some(d_completion_ratio),
        Some(d_group_ratio),
        Some(d_cache_ratio),
        Some(d_cache_creation_ratio),
        Some(d_cache_creation_ratio_5m),
        Some(d_cache_creation_ratio_1h),
        Some(d_image_ratio),
        Some(d_audio_ratio),
        Some(d_audio_completion_ratio),
        Some(d_quota_per_unit),
        Some(d_image_price_ratio),
        Some(d_other_ratio_product),
        Some(d_audio_input_price_per_million),
    ) = (
        go_decimal_from_f64(model_ratio),
        go_decimal_from_f64(completion_ratio),
        go_decimal_from_f64(group_ratio),
        go_decimal_from_f64(cache_ratio),
        go_decimal_from_f64(cache_creation_ratio),
        go_decimal_from_f64(cache_creation_ratio_5m),
        go_decimal_from_f64(cache_creation_ratio_1h),
        go_decimal_from_f64(image_ratio),
        go_decimal_from_f64(snapshot.audio_ratio),
        go_decimal_from_f64(snapshot.audio_completion_ratio),
        go_decimal_from_f64(snapshot.quota_per_unit),
        go_decimal_from_f64(snapshot.image_price_ratio),
        go_decimal_from_f64(other_ratio_product),
        go_decimal_from_f64(snapshot.audio_input_price_per_million),
    )
    else {
        return result(i64::MAX, 0.0);
    };
    let Some(tool_surcharge) =
        tool_surcharge_quota(usage, snapshot, d_group_ratio, d_quota_per_unit)
    else {
        return result(i64::MAX, 0.0);
    };
    let tool_surcharge_audit = tool_surcharge.to_f64().unwrap_or(f64::MAX);

    // Fixed-price mode is request-priced and therefore independent of token
    // usage. The caller admits only successful billable responses.
    if let Some(price) = snapshot.model_price {
        let quota = go_decimal_from_f64(price).and_then(|price| {
            checked_decimal_product(&[price, d_image_price_ratio, d_quota_per_unit, d_group_ratio])
                .and_then(|base| base.checked_add(tool_surcharge))
                .and_then(|total| total.checked_mul(d_other_ratio_product))
        });
        return result(round_decimal_quota(quota), tool_surcharge_audit);
    }

    // Per-token mode cannot charge without usage.
    if usage.total_tokens <= 0 {
        return result(0, 0.0);
    }

    // Per-token mode. Ports Go `calculateTextQuotaSummary` (service/text_quota.go):
    // each token sub-category is priced at its own ratio relative to model_ratio,
    // then the sum is multiplied by model_ratio * group_ratio. Cache-read,
    // cache-write, and image tokens are SUBTRACTED from the prompt base (for
    // non-Anthropic usage) and re-added at their own ratio, so e.g. image
    // tokens bill at image_ratio, not the prompt rate.
    let Some(ratio) = checked_decimal_product(&[d_model_ratio, d_group_ratio]) else {
        return result(i64::MAX, tool_surcharge_audit);
    };
    let prompt = Decimal::from(usage.prompt_tokens.max(0));
    let completion = Decimal::from(usage.completion_tokens.max(0));
    let cached = Decimal::from(usage.cached_tokens.max(0));
    let cache_creation = Decimal::from(usage.cache_creation_tokens.max(0));
    let cache_creation_5m = Decimal::from(usage.cache_creation_5m_tokens.max(0));
    let cache_creation_1h = Decimal::from(usage.cache_creation_1h_tokens.max(0));
    let image = Decimal::from(usage.image_tokens.max(0));
    let audio_input = Decimal::from(usage.audio_input_tokens.max(0));
    let audio_output = Decimal::from(usage.audio_output_tokens.max(0));

    let mut base_tokens = prompt;
    let mut cached_with_ratio = Decimal::ZERO;
    let mut cache_creation_with_ratio = Decimal::ZERO;
    let mut image_with_ratio = Decimal::ZERO;
    let mut audio_input_with_ratio = Decimal::ZERO;
    let mut audio_output_with_ratio = Decimal::ZERO;

    if !cached.is_zero() {
        if !usage.is_anthropic_usage_semantic {
            // OpenAI: cached tokens are INCLUDED in prompt_tokens; subtract.
            base_tokens -= cached;
        }
        let Some(value) = cached.checked_mul(d_cache_ratio) else {
            return result(i64::MAX, tool_surcharge_audit);
        };
        cached_with_ratio = value;
    }

    if !cache_creation.is_zero()
        || usage.cache_creation_5m_tokens > 0
        || usage.cache_creation_1h_tokens > 0
    {
        if !usage.is_anthropic_usage_semantic {
            base_tokens -= cache_creation;
            let Some(value) = cache_creation.checked_mul(d_cache_creation_ratio) else {
                return result(i64::MAX, tool_surcharge_audit);
            };
            cache_creation_with_ratio = value;
        } else {
            // Go prices the unbucketed remainder with the generic creation
            // ratio, then applies explicit ratios to the 5m/1h buckets.
            let remaining =
                (cache_creation - cache_creation_5m - cache_creation_1h).max(Decimal::ZERO);
            let parts = [
                remaining.checked_mul(d_cache_creation_ratio),
                cache_creation_5m.checked_mul(d_cache_creation_ratio_5m),
                cache_creation_1h.checked_mul(d_cache_creation_ratio_1h),
            ];
            let Some(value) = checked_decimal_options_sum(&parts) else {
                return result(i64::MAX, tool_surcharge_audit);
            };
            cache_creation_with_ratio = value;
        }
    }

    if !image.is_zero() {
        base_tokens -= image;
        let Some(value) = image.checked_mul(d_image_ratio) else {
            return result(i64::MAX, tool_surcharge_audit);
        };
        image_with_ratio = value;
    }

    let mut audio_input_quota = Decimal::ZERO;
    if !audio_input.is_zero() && !d_audio_input_price_per_million.is_zero() {
        base_tokens -= audio_input;
        let Some(value) = checked_decimal_product(&[
            d_audio_input_price_per_million,
            audio_input,
            d_group_ratio,
            d_quota_per_unit,
        ])
        .and_then(|value| value.checked_div(Decimal::from(1_000_000))) else {
            return result(i64::MAX, tool_surcharge_audit);
        };
        audio_input_quota = value;
    } else if !audio_input.is_zero() && snapshot.uses_audio_detail_billing {
        base_tokens -= audio_input;
        let Some(value) = audio_input.checked_mul(d_audio_ratio) else {
            return result(i64::MAX, tool_surcharge_audit);
        };
        audio_input_with_ratio = value;
    }

    let completion_base = if snapshot.uses_audio_detail_billing {
        completion - audio_output
    } else {
        completion
    };
    if !audio_output.is_zero() && snapshot.uses_audio_detail_billing {
        let Some(value) =
            checked_decimal_product(&[audio_output, d_audio_ratio, d_audio_completion_ratio])
        else {
            return result(i64::MAX, tool_surcharge_audit);
        };
        audio_output_with_ratio = value;
    }

    let Some(prompt_quota) = checked_decimal_sum(&[
        base_tokens,
        cached_with_ratio,
        image_with_ratio,
        cache_creation_with_ratio,
        audio_input_with_ratio,
    ]) else {
        return result(i64::MAX, tool_surcharge_audit);
    };
    let Some(completion_quota) = completion_base
        .checked_mul(d_completion_ratio)
        .and_then(|value| value.checked_add(audio_output_with_ratio))
    else {
        return result(i64::MAX, tool_surcharge_audit);
    };
    let Some(raw_quota) = prompt_quota
        .checked_add(completion_quota)
        .and_then(|quota| quota.checked_mul(ratio))
        .and_then(|quota| quota.checked_add(audio_input_quota))
        .and_then(|quota| quota.checked_add(tool_surcharge))
        .and_then(|quota| quota.checked_mul(d_other_ratio_product))
    else {
        return result(i64::MAX, tool_surcharge_audit);
    };

    // Floor: a billable model with ratio > 0 must charge at least 1.
    let quota = if !ratio.is_zero() && raw_quota <= Decimal::ZERO {
        1
    } else {
        round_decimal_quota(Some(raw_quota))
    };

    result(quota, tool_surcharge_audit)
}

fn tool_surcharge_quota(
    usage: &FlatUsage,
    snapshot: &FlatPricingSnapshot,
    group_ratio: Decimal,
    quota_per_unit: Decimal,
) -> Option<Decimal> {
    let search = [
        (
            usage.web_search_preview_calls,
            snapshot.tool_prices.web_search_preview_per_1k,
        ),
        (
            usage.web_search_calls,
            snapshot.tool_prices.web_search_per_1k,
        ),
        (
            usage.file_search_calls,
            snapshot.tool_prices.file_search_per_1k,
        ),
    ]
    .into_iter()
    .try_fold(Decimal::ZERO, |total, (calls, price)| {
        let component = checked_decimal_product(&[
            go_decimal_from_f64(price)?,
            Decimal::from(calls.max(0)),
            group_ratio,
            quota_per_unit,
        ])?
        .checked_div(Decimal::from(1_000))?;
        total.checked_add(component)
    })?;

    let image = match usage.image_generation_price_class {
        Some(class) => checked_decimal_product(&[
            go_decimal_from_f64(snapshot.tool_prices.image_price(class))?,
            group_ratio,
            quota_per_unit,
        ])?,
        None => Decimal::ZERO,
    };
    search.checked_add(image)
}

fn go_decimal_from_f64(value: f64) -> Option<Decimal> {
    if !value.is_finite() {
        return None;
    }

    let value = value.to_string();
    if value.contains(['e', 'E']) {
        Decimal::from_scientific(&value).ok()
    } else {
        value.parse().ok()
    }
}

fn checked_decimal_product(values: &[Decimal]) -> Option<Decimal> {
    values
        .iter()
        .try_fold(Decimal::ONE, |product, value| product.checked_mul(*value))
}

fn checked_decimal_sum(values: &[Decimal]) -> Option<Decimal> {
    values
        .iter()
        .try_fold(Decimal::ZERO, |sum, value| sum.checked_add(*value))
}

fn checked_decimal_options_sum(values: &[Option<Decimal>]) -> Option<Decimal> {
    values.iter().try_fold(Decimal::ZERO, |sum, value| {
        sum.checked_add(value.as_ref().copied()?)
    })
}

fn round_decimal_quota(value: Option<Decimal>) -> i64 {
    let Some(value) = value else {
        return i64::MAX;
    };
    value
        .round_dp_with_strategy(0, RoundingStrategy::MidpointAwayFromZero)
        .to_i64()
        .unwrap_or_else(|| {
            if value < Decimal::ZERO {
                i64::MIN
            } else {
                i64::MAX
            }
        })
}

/// Go-compatible pre-consume estimate. Fixed-price requests reserve their
/// exact request price. Per-token requests reserve `(max(prompt, floor) +
/// max_completion) * model_ratio * group_ratio`, truncating toward zero like
/// Go's `int(float64(...))`; completion/cache/media premiums remain settlement
/// facts and can produce an additional CAS debit.
pub fn estimate_flat_pre_consumed_quota(
    snapshot: &FlatPricingSnapshot,
    estimated_prompt_tokens: i64,
    estimated_completion_tokens: i64,
) -> i64 {
    if snapshot.mode == FlatBillingMode::FixedPrice {
        let raw = snapshot.model_price.unwrap_or(0.0)
            * snapshot.image_price_ratio
            * snapshot.quota_per_unit
            * snapshot.group_ratio;
        return if !raw.is_finite() || raw <= 0.0 {
            0
        } else if raw >= i64::MAX as f64 {
            i64::MAX
        } else {
            raw.trunc() as i64
        };
    }
    let tokens = estimated_prompt_tokens
        .max(snapshot.pre_consumed_token_floor)
        .max(0)
        .saturating_add(estimated_completion_tokens.max(0));
    let raw = (tokens as f64) * snapshot.model_ratio * snapshot.group_ratio;
    if !raw.is_finite() || raw <= 0.0 {
        0
    } else if raw >= i64::MAX as f64 {
        i64::MAX
    } else {
        raw.trunc() as i64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config_with_model_ratio(model: &str, ratio: f64) -> PricingConfig {
        let mut config = PricingConfig::new();
        config.model_ratios.insert(model.to_string(), ratio);
        config
    }

    fn simple_usage(prompt: i64, completion: i64) -> FlatUsage {
        FlatUsage {
            prompt_tokens: prompt,
            completion_tokens: completion,
            total_tokens: prompt + completion,
            ..FlatUsage::default()
        }
    }

    #[test]
    fn zero_usage_is_free() {
        let config = config_with_model_ratio("gpt-4o", 1.25);
        let usage = FlatUsage {
            total_tokens: 0,
            ..FlatUsage::default()
        };
        let result = compute_flat_quota(&usage, "gpt-4o", "default", &config);
        assert_eq!(result.quota, 0);
    }

    #[test]
    fn per_token_basic_formula() {
        // model_ratio=2, group_ratio=1 (default). gpt-4o has a hardcoded
        // completion-ratio soft default of 4.0 (cinatoken_core::
        // hardcoded_completion_ratio), so completion_ratio=4 even with an empty
        // options map. prompt=100, completion=50 → (100 + 50*4) * (2*1) = 600.
        let config = config_with_model_ratio("gpt-4o", 2.0);
        let usage = simple_usage(100, 50);
        let result = compute_flat_quota(&usage, "gpt-4o", "default", &config);
        assert_eq!(result.quota, 600);
        assert_eq!(result.mode, FlatBillingMode::PerToken);
    }

    #[test]
    fn audio_details_replace_text_bases_and_use_both_frozen_audio_ratios() {
        let mut config = config_with_model_ratio("gpt-audio", 2.0);
        config
            .completion_ratios
            .insert("gpt-audio".to_string(), 4.0);
        config.audio_ratios.insert("gpt-audio".to_string(), 3.0);
        config
            .audio_completion_ratios
            .insert("gpt-audio".to_string(), 2.0);
        let usage = FlatUsage {
            prompt_tokens: 100,
            completion_tokens: 50,
            total_tokens: 150,
            audio_input_tokens: 20,
            audio_output_tokens: 10,
            ..FlatUsage::default()
        };

        // (80 text-in + 20*3 audio-in + 40*4 text-out + 10*3*2 audio-out) * 2.
        let result = compute_flat_quota(&usage, "gpt-audio", "default", &config);
        assert_eq!(result.quota, 720);
        assert_eq!(result.audio_ratio, 3.0);
        assert_eq!(result.audio_completion_ratio, 2.0);
        assert!(result.uses_audio_detail_billing);
        assert_eq!(result.audio_input_tokens, 20);
        assert_eq!(result.audio_output_tokens, 10);
    }

    #[test]
    fn audio_details_keep_text_formula_without_an_audio_ratio_contract() {
        let mut config = config_with_model_ratio("plain-audio-details", 1.0);
        config
            .completion_ratios
            .insert("plain-audio-details".to_string(), 4.0);
        let usage = FlatUsage {
            prompt_tokens: 100,
            completion_tokens: 50,
            total_tokens: 150,
            audio_input_tokens: 20,
            audio_output_tokens: 10,
            ..FlatUsage::default()
        };

        let result = compute_flat_quota(&usage, "plain-audio-details", "default", &config);
        assert_eq!(result.quota, 300);
        assert!(!result.uses_audio_detail_billing);
    }

    #[test]
    fn completion_ratio_applies_premium() {
        // model_ratio=1, completion_ratio=4 → (100 + 50*4) * 1 = 300
        let mut config = config_with_model_ratio("gpt-4o", 1.0);
        config.completion_ratios.insert("gpt-4o".to_string(), 4.0);
        let usage = simple_usage(100, 50);
        let result = compute_flat_quota(&usage, "gpt-4o", "default", &config);
        assert_eq!(result.quota, 300);
    }

    #[test]
    fn group_ratio_multiplies() {
        // model_ratio=1, group_ratio=2, gpt-4o completion_ratio=4 (hardcoded
        // soft default) → (100 + 50*4) * (1*2) = 600.
        let mut config = config_with_model_ratio("gpt-4o", 1.0);
        config.group_ratios.insert("vip".to_string(), 2.0);
        let usage = simple_usage(100, 50);
        let result = compute_flat_quota(&usage, "gpt-4o", "vip", &config);
        assert_eq!(result.quota, 600);
    }

    #[test]
    fn fixed_price_mode_overrides_per_token() {
        // ModelPrice takes precedence over ModelRatio.
        let mut config = PricingConfig::new();
        config.model_prices.insert("dall-e-3".to_string(), 0.04); // $0.04/request
        config.model_ratios.insert("dall-e-3".to_string(), 99.0); // ignored
        let usage = simple_usage(0, 0);
        let result = compute_flat_quota(&usage, "dall-e-3", "default", &config);
        // Fixed-price billing is per successful request, not per token.
        assert_eq!(result.quota, 20_000);
        assert_eq!(result.mode, FlatBillingMode::FixedPrice);
    }

    #[test]
    fn other_ratio_product_scales_fixed_price_and_ignores_invalid_values() {
        let mut config = PricingConfig::new();
        config.model_prices.insert("image-model".to_string(), 0.04);
        let usage = FlatUsage {
            prompt_tokens: 1,
            total_tokens: 1,
            ..FlatUsage::default()
        };

        let result = compute_flat_quota_with_other_ratio_product(
            &usage,
            "image-model",
            "default",
            &config,
            4.0,
        );
        assert_eq!(result.quota, 80_000);
        assert_eq!(result.other_ratio_product, 4.0);

        for invalid in [0.0, -1.0, f64::NAN] {
            let result = compute_flat_quota_with_other_ratio_product(
                &usage,
                "image-model",
                "default",
                &config,
                invalid,
            );
            assert_eq!(result.quota, 20_000);
            assert_eq!(result.other_ratio_product, 1.0);
        }
    }

    #[test]
    fn other_ratio_product_applies_to_per_token_after_weighting() {
        let config = config_with_model_ratio("other-ratio-model", 1.0);
        let usage = simple_usage(10, 0);
        let result = compute_flat_quota_with_other_ratio_product(
            &usage,
            "other-ratio-model",
            "default",
            &config,
            3.0,
        );
        assert_eq!(result.quota, 30);
    }

    #[test]
    fn gemini_audio_input_uses_frozen_per_million_price_without_model_ratio() {
        let mut config = config_with_model_ratio("gemini-2.5-flash", 10.0);
        config.quota_per_unit = 500_000.0;
        let usage = FlatUsage {
            prompt_tokens: 1_000,
            total_tokens: 1_000,
            audio_input_tokens: 1_000,
            ..FlatUsage::default()
        };
        let snapshot =
            FlatPricingSnapshot::from_config("gemini-2.5-flash", "default", &config, 1.0, 0);
        let result = compute_flat_quota_from_snapshot(&usage, &snapshot);
        assert_eq!(snapshot.audio_input_price_per_million, 1.0);
        assert_eq!(result.quota, 500);
    }

    #[test]
    fn negative_prompt_base_is_not_clamped_before_go_final_floor() {
        let config = config_with_model_ratio("go-negative-base", 1.0);
        let usage = FlatUsage {
            prompt_tokens: 1,
            total_tokens: 1,
            image_tokens: 2,
            ..FlatUsage::default()
        };
        let result = compute_flat_quota(&usage, "go-negative-base", "default", &config);
        assert_eq!(result.quota, 1);
    }

    #[test]
    fn openai_cache_discount_subtracts_then_remultiplies() {
        // prompt=1000 includes 800 cached. cache_ratio=0.5.
        // base = 1000-800 = 200; cached_contrib = 800*0.5 = 400.
        // prompt_total = 200+400 = 600. model_ratio=1, completion=0.
        // quota = 600 * 1 = 600 (vs 1000 without cache discount).
        let mut config = config_with_model_ratio("gpt-4o", 1.0);
        config.cache_ratios.insert("gpt-4o".to_string(), 0.5);
        let usage = FlatUsage {
            prompt_tokens: 1000,
            total_tokens: 1000,
            cached_tokens: 800,
            ..FlatUsage::default()
        };
        let result = compute_flat_quota(&usage, "gpt-4o", "default", &config);
        assert_eq!(result.quota, 600);
    }

    #[test]
    fn anthropic_cache_semantic_adds_without_subtracting() {
        // Claude: prompt=200 EXCLUDES cache. cached=800. cache_ratio=0.1.
        // prompt_total = 200 + 800*0.1 = 280. model_ratio=1.
        let mut config = config_with_model_ratio("claude-3-5-sonnet", 1.0);
        config
            .cache_ratios
            .insert("claude-3-5-sonnet".to_string(), 0.1);
        let usage = FlatUsage {
            prompt_tokens: 200,
            total_tokens: 1000,
            cached_tokens: 800,
            is_anthropic_usage_semantic: true,
            ..FlatUsage::default()
        };
        let result = compute_flat_quota(&usage, "claude-3-5-sonnet", "default", &config);
        assert_eq!(result.quota, 280);
    }

    #[test]
    fn floor_one_when_ratio_nonzero_and_quota_rounds_to_zero() {
        // Tiny usage that rounds to 0 with a non-zero ratio → floor to 1.
        // Uses an unknown model (no hardcoded completion-ratio entry) so
        // completion_ratio defaults to 1.0: completion=1 * cr=1 * mr=1 → 1.
        let config = config_with_model_ratio("deepseek-chat", 1.0);
        let usage = simple_usage(0, 1); // completion=1, ratio=1 → quota=1
        let result = compute_flat_quota(&usage, "deepseek-chat", "default", &config);
        assert_eq!(result.quota, 1);
    }

    #[test]
    fn result_includes_audit_ratios() {
        let mut config = config_with_model_ratio("gpt-4o", 2.5);
        config.completion_ratios.insert("gpt-4o".to_string(), 4.0);
        config.cache_ratios.insert("gpt-4o".to_string(), 0.5);
        config.group_ratios.insert("vip".to_string(), 1.5);
        let usage = simple_usage(100, 50);
        let result = compute_flat_quota(&usage, "gpt-4o", "vip", &config);
        assert_eq!(result.model_ratio, 2.5);
        assert_eq!(result.completion_ratio, 4.0);
        assert_eq!(result.cache_ratio, 0.5);
        assert_eq!(result.group_ratio, 1.5);
    }

    // --- Sub-category settlement arithmetic parity (Go
    // calculateTextQuotaSummary, service/text_quota.go). ---

    #[test]
    fn image_tokens_billed_at_image_ratio_not_prompt_rate() {
        // OpenAI: prompt=1000 INCLUDES 200 image tokens. image_ratio=2.
        // base = 1000 - 200 = 800; image_contrib = 200*2 = 400.
        // prompt_quota = 800 + 400 = 1200. model_ratio=1, completion=0.
        // quota = 1200 * 1 = 1200 (vs 1000 if image stayed at prompt rate).
        let mut config = config_with_model_ratio("gpt-4o", 1.0);
        config.image_ratios.insert("gpt-4o".to_string(), 2.0);
        let usage = FlatUsage {
            prompt_tokens: 1000,
            total_tokens: 1000,
            image_tokens: 200,
            ..FlatUsage::default()
        };
        let result = compute_flat_quota(&usage, "gpt-4o", "default", &config);
        assert_eq!(result.quota, 1200);
    }

    #[test]
    fn cache_creation_billed_at_create_cache_ratio() {
        // OpenAI: prompt=1000 INCLUDES 100 cache-write tokens.
        // create_cache_ratio=1.25 (the Go default). base = 1000 - 100 = 900;
        // cache_creation_contrib = 100*1.25 = 125. prompt_quota = 900 + 125 =
        // 1025. model_ratio=1, completion=0. quota = 1025.
        let config = config_with_model_ratio("gpt-4o", 1.0);
        let usage = FlatUsage {
            prompt_tokens: 1000,
            total_tokens: 1000,
            cache_creation_tokens: 100,
            ..FlatUsage::default()
        };
        let result = compute_flat_quota(&usage, "gpt-4o", "default", &config);
        assert_eq!(result.quota, 1025);
    }

    #[test]
    fn anthropic_cache_creation_5m_1h_split() {
        // Claude: prompt EXCLUDES cache-write. cache_creation=100, split 60 5m
        // + 40 1h. remaining = 100-60-40 = 0. create_cache_ratio (5m) default
        // 1.25; 1h = 1.25 * 1.6 = 2.0. contrib = 60*1.25 + 40*2.0 = 75 + 80 =
        // 155. prompt_quota = 200 + 155 = 355. model_ratio=1. quota = 355.
        let config = config_with_model_ratio("claude-sonnet-4-20250514", 1.0);
        let usage = FlatUsage {
            prompt_tokens: 200,
            total_tokens: 1000,
            cache_creation_tokens: 100,
            cache_creation_5m_tokens: 60,
            cache_creation_1h_tokens: 40,
            is_anthropic_usage_semantic: true,
            ..FlatUsage::default()
        };
        let result = compute_flat_quota(&usage, "claude-sonnet-4-20250514", "default", &config);
        assert_eq!(result.quota, 355);
    }

    #[test]
    fn anthropic_unbucketed_cache_creation_uses_generic_ratio() {
        let config = config_with_model_ratio("claude-test", 1.0);
        let mut snapshot =
            FlatPricingSnapshot::from_config("claude-test", "default", &config, 1.0, 0);
        snapshot.cache_creation_ratio = 1.0;
        snapshot.cache_creation_ratio_5m = 2.0;
        snapshot.cache_creation_ratio_1h = 3.0;
        let usage = FlatUsage {
            total_tokens: 1,
            cache_creation_tokens: 100,
            cache_creation_5m_tokens: 20,
            cache_creation_1h_tokens: 30,
            is_anthropic_usage_semantic: true,
            ..FlatUsage::default()
        };

        // remaining=50 uses generic ratio 1, then 20*2 + 30*3 = 180.
        let result = compute_flat_quota_from_snapshot(&usage, &snapshot);
        assert_eq!(result.quota, 180);
    }

    #[test]
    fn combined_subcategories_non_anthropic() {
        // OpenAI: prompt=2000 includes 500 cached + 300 image + 200 cache-write.
        // cache_ratio=0.5, image_ratio=2, create_cache_ratio=1.25.
        // gpt-4o completion_ratio is the hardcoded soft default 4.0.
        // base = 2000 - 500 - 300 - 200 = 1000
        // cached_contrib = 500*0.5 = 250; image_contrib = 300*2 = 600;
        // cache_creation_contrib = 200*1.25 = 250.
        // prompt_quota = 1000 + 250 + 600 + 250 = 2100. completion=100, cr=4 → 400.
        // (2100 + 400) * (model_ratio=1 * group=1) = 2500.
        let mut config = config_with_model_ratio("gpt-4o", 1.0);
        config.cache_ratios.insert("gpt-4o".to_string(), 0.5);
        config.image_ratios.insert("gpt-4o".to_string(), 2.0);
        let usage = FlatUsage {
            prompt_tokens: 2000,
            completion_tokens: 100,
            total_tokens: 2100,
            cached_tokens: 500,
            cache_creation_tokens: 200,
            image_tokens: 300,
            ..FlatUsage::default()
        };
        let result = compute_flat_quota(&usage, "gpt-4o", "default", &config);
        assert_eq!(result.quota, 2500);
    }

    #[test]
    fn flat_path_rounds_half_away_from_zero_like_go_quota_round() {
        // Lock the rounding parity: the flat path must round half-away-from-
        // zero exactly like Go's QuotaRound (`int(math.Round)`), at the
        // half-boundary. We construct a model_ratio + usage whose raw quota
        // lands on a half-integer and assert the rounded result. gpt-4o has a
        // hardcoded completion ratio of 4.0 and default model_ratio 1.25.
        // prompt=0, completion=1, cr=4, mr=1.25, gr=1 → raw = (0 + 1*4) * 1.25
        // = 5.0 (exact, sanity). To hit a .5 boundary use completion=1 with a
        // ratio that yields a half: mr=1.5 (operator override), cr=1 (unknown
        // model 'deepseek-chat' has cr=1): (0 + 1*1) * 1.5 = 1.5 → rounds to 2.
        let config = config_with_model_ratio("deepseek-chat", 1.5);
        let usage = simple_usage(0, 1);
        let result = compute_flat_quota(&usage, "deepseek-chat", "default", &config);
        assert_eq!(result.quota, 2, "1.5 must round half-away-from-zero to 2");

        // A raw value of 0.5 → 1 (the smallest billable half). completion=1,
        // mr=0.5: (0 + 1*1) * 0.5 = 0.5 → 1.
        let config = config_with_model_ratio("deepseek-chat", 0.5);
        let usage = simple_usage(0, 1);
        let result = compute_flat_quota(&usage, "deepseek-chat", "default", &config);
        assert_eq!(result.quota, 1, "0.5 must round half-away-from-zero to 1");
    }

    #[test]
    fn flat_path_uses_go_decimal_intermediates_before_rounding() {
        let mut config = config_with_model_ratio("decimal-parity", 3.75);
        config.group_ratios.insert("vip".to_string(), 4.1);
        let usage = simple_usage(4, 0);

        // Binary float computes 4 * (3.75 * 4.1) as 61.49999999999999 and
        // would charge 61. Go decimal computes exactly 61.500 and charges 62.
        let result = compute_flat_quota(&usage, "decimal-parity", "vip", &config);
        assert_eq!(result.quota, 62);

        let mut fixed = FlatPricingSnapshot::from_config("decimal-parity", "vip", &config, 4.0, 0);
        fixed.mode = FlatBillingMode::FixedPrice;
        fixed.model_price = Some(3.75);
        fixed.quota_per_unit = 1.0;
        let result = compute_flat_quota_from_snapshot(&FlatUsage::default(), &fixed);
        assert_eq!(result.quota, 62);
    }

    #[test]
    fn frozen_snapshot_ignores_later_config_mutation() {
        let mut config = config_with_model_ratio("snapshot-model", 2.0);
        config
            .completion_ratios
            .insert("snapshot-model".to_string(), 3.0);
        config.group_ratios.insert("vip".to_string(), 1.5);
        let snapshot = FlatPricingSnapshot::from_config("snapshot-model", "vip", &config, 1.0, 500);
        snapshot.validate().unwrap();

        config
            .model_ratios
            .insert("snapshot-model".to_string(), 99.0);
        config
            .completion_ratios
            .insert("snapshot-model".to_string(), 99.0);
        config.group_ratios.insert("vip".to_string(), 99.0);

        let usage = simple_usage(100, 20);
        let frozen = compute_flat_quota_from_snapshot(&usage, &snapshot);
        let mutable = compute_flat_quota(&usage, "snapshot-model", "vip", &config);
        assert_eq!(frozen.quota, 480);
        assert_ne!(frozen.quota, mutable.quota);
    }

    #[test]
    fn flat_preconsume_matches_go_truncation_and_fixed_price() {
        let mut config = config_with_model_ratio("token-model", 1.25);
        config.group_ratios.insert("default".to_string(), 1.5);
        let token_snapshot =
            FlatPricingSnapshot::from_config("token-model", "default", &config, 1.0, 500);
        // (max(100, 500) + 33) * 1.25 * 1.5 = 999.375, truncated to 999.
        assert_eq!(
            estimate_flat_pre_consumed_quota(&token_snapshot, 100, 33),
            999
        );

        config.model_prices.insert("fixed-model".to_string(), 0.02);
        let fixed_snapshot =
            FlatPricingSnapshot::from_config("fixed-model", "default", &config, 3.0, 500)
                .with_image_price_ratio(2.0);
        assert_eq!(
            estimate_flat_pre_consumed_quota(&fixed_snapshot, 0, 0),
            30_000
        );
        assert_eq!(
            compute_flat_quota_from_snapshot(&FlatUsage::default(), &fixed_snapshot).quota,
            90_000
        );
    }

    #[test]
    fn snapshot_round_trips_without_losing_financial_facts() {
        let mut config = PricingConfig::new();
        config.model_prices.insert("fixed-model".to_string(), 0.04);
        config.group_ratios.insert("vip".to_string(), 1.2);
        let snapshot = FlatPricingSnapshot::from_config("fixed-model", "vip", &config, 2.0, 500);
        let json = serde_json::to_string(&snapshot).unwrap();
        let restored: FlatPricingSnapshot = serde_json::from_str(&json).unwrap();
        assert_eq!(restored, snapshot);
        assert_eq!(restored.schema_version, FlatPricingSnapshot::SCHEMA_VERSION);
        assert_eq!(restored.tool_prices.web_search_per_1k, 10.0);
        restored.validate().unwrap();
    }

    #[test]
    fn tool_surcharges_are_added_before_other_ratio_and_rounded_once() {
        let mut config = config_with_model_ratio("gpt-4o", 1.0);
        config.group_ratios.insert("vip".to_string(), 2.0);
        let snapshot = FlatPricingSnapshot::from_config("gpt-4o", "vip", &config, 3.0, 0);
        let usage = FlatUsage {
            prompt_tokens: 10,
            total_tokens: 10,
            web_search_preview_calls: 1,
            file_search_calls: 2,
            image_generation_price_class: Some(ImageGenerationPriceClass::Low1024x1024),
            ..FlatUsage::default()
        };

        // Token base: 10 * group 2 = 20.
        // Tools before OtherRatios: preview 25_000 + file 5_000 + image 11_000.
        // Final: (20 + 41_000) * 3 = 123_060.
        let result = compute_flat_quota_from_snapshot(&usage, &snapshot);
        assert_eq!(result.quota, 123_060);
        assert_eq!(result.tool_surcharge_quota, 41_000.0);
    }

    #[test]
    fn fixed_price_adds_tool_surcharge_before_other_ratio() {
        let mut config = PricingConfig::new();
        config
            .model_prices
            .insert("fixed-tool-model".to_string(), 0.04);
        let snapshot =
            FlatPricingSnapshot::from_config("fixed-tool-model", "default", &config, 2.0, 0);
        let usage = FlatUsage {
            web_search_calls: 1,
            image_generation_price_class: Some(ImageGenerationPriceClass::High1024x1024),
            ..FlatUsage::default()
        };

        // Fixed base 20_000 + web 5_000 + image 83_500, then OtherRatios 2.
        let result = compute_flat_quota_from_snapshot(&usage, &snapshot);
        assert_eq!(result.quota, 217_000);
        assert_eq!(result.tool_surcharge_quota, 88_500.0);
    }

    #[test]
    fn frozen_snapshot_ignores_later_tool_price_mutation() {
        let mut config = config_with_model_ratio("tool-freeze", 1.0)
            .with_tool_prices(Some(r#"{"web_search_preview:tool-*":40}"#));
        let snapshot = FlatPricingSnapshot::from_config("tool-freeze", "default", &config, 1.0, 0);
        config = config.with_tool_prices(Some(r#"{"web_search_preview:tool-*":99}"#));
        let usage = FlatUsage {
            prompt_tokens: 1,
            total_tokens: 1,
            web_search_preview_calls: 1,
            ..FlatUsage::default()
        };

        let frozen = compute_flat_quota_from_snapshot(&usage, &snapshot);
        let mutable = compute_flat_quota(&usage, "tool-freeze", "default", &config);
        assert_eq!(frozen.quota, 20_001);
        assert_ne!(frozen.quota, mutable.quota);
    }
}
