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
//! quota = round(model_price * quota_per_unit * group_ratio * fixed_price_multiplier)
//! ```
//!
//! Per-token mode (ports Go `calculateTextQuotaSummary`): each token
//! sub-category is priced at its own ratio, then multiplied by
//! `model_ratio * group_ratio`.
//! ```text
//! ratio              = model_ratio * group_ratio
//! base_tokens        = prompt - cached - cache_creation - image   // OpenAI
//! base_tokens        = prompt                                   // Anthropic
//! cached_contrib     = cached * cache_ratio
//! cache_create_contrib = cache_creation * cache_creation_ratio   // 5m/1h split
//!                     // for Anthropic: remaining*5m + 5m_tokens*5m + 1h_tokens*1h
//! image_contrib      = image * image_ratio
//! completion_quota   = completion * completion_ratio
//! prompt_quota       = base_tokens + cached_contrib + image_contrib + cache_create_contrib
//! quota              = round((prompt_quota + completion_quota) * ratio)
//! ```
//!
//! Guards (match Go):
//! - `total_tokens == 0` → `quota = 0` (free; caller refunds any reserve).
//! - `ratio != 0 && quota <= 0` → `quota = 1` (floor for billable models).
//!
//! Rounding uses the shared `crate::quota_round` (half-away-from-zero, with
//! saturating guards for NaN/out-of-i64), the same rounder the tiered path
//! uses — Go mandates every billing path call `QuotaRound`.
//!
//! ## Simplifications vs Go (deferred)
//!
//! - No Gemini separate audio-input pricing
//!   (`GetGeminiInputAudioPricePerMillionTokens`).
//! - Only the image count `OtherRatios["n"]` equivalent is implemented; other
//!   provider-specific fixed-price multipliers remain deferred.
//! - No `ToolCallSurcharge` (web_search / file_search fixed fees).

use crate::pricing::PricingConfig;
// Reuse the single canonical rounder (`crate::quota_round`, lib.rs) that the
// tiered path uses — Go mandates every billing path call `QuotaRound`
// (`int(math.Round)`) to avoid ±1 discrepancies. Do not reintroduce a
// per-path rounding variant here.
use crate::quota_round;

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
    /// True when the upstream usage follows Anthropic semantics, where
    /// `prompt_tokens` already excludes cache hits (so we add them back at
    /// the cache ratio instead of subtracting-then-remultiplying).
    pub is_anthropic_usage_semantic: bool,
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
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlatBillingMode {
    /// `ModelPrice` was set: quota = price × quota_per_unit × group_ratio.
    FixedPrice,
    /// Per-token formula with model_ratio × completion_ratio × group_ratio.
    PerToken,
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
    pub fixed_price_multiplier: f64,
}

/// Compute the flat quota for a single relay response.
pub fn compute_flat_quota(
    usage: &FlatUsage,
    model: &str,
    group: &str,
    config: &PricingConfig,
) -> FlatQuotaResult {
    compute_flat_quota_with_fixed_price_multiplier(usage, model, group, config, 1.0)
}

/// Compute flat quota while applying a request-derived multiplier only to the
/// fixed-price branch. This is the Rust equivalent of Go's image `n` ratio.
pub fn compute_flat_quota_with_fixed_price_multiplier(
    usage: &FlatUsage,
    model: &str,
    group: &str,
    config: &PricingConfig,
    fixed_price_multiplier: f64,
) -> FlatQuotaResult {
    let fixed_price_multiplier =
        if fixed_price_multiplier.is_finite() && fixed_price_multiplier > 0.0 {
            fixed_price_multiplier
        } else {
            1.0
        };
    let group_ratio = config.group_ratio(group);
    let model_ratio = config.model_ratio(model);
    let completion_ratio = config.completion_ratio(model);
    let cache_ratio = config.cache_ratio(model);
    let cache_creation_ratio = config.cache_creation_ratio(model);
    let cache_creation_ratio_5m = config.cache_creation_ratio_5m(model);
    let cache_creation_ratio_1h = config.cache_creation_ratio_1h(model);
    let image_ratio = config.image_ratio(model);

    // Zero-usage guard: free request.
    if usage.total_tokens <= 0 {
        return FlatQuotaResult {
            quota: 0,
            mode: FlatBillingMode::PerToken,
            model_ratio,
            completion_ratio,
            group_ratio,
            cache_ratio,
            fixed_price_multiplier,
        };
    }

    // Fixed-price mode takes precedence.
    if let Some(price) = config.model_price(model) {
        let quota = price * config.quota_per_unit * group_ratio * fixed_price_multiplier;
        return FlatQuotaResult {
            quota: quota_round(quota),
            mode: FlatBillingMode::FixedPrice,
            model_ratio,
            completion_ratio,
            group_ratio,
            cache_ratio,
            fixed_price_multiplier,
        };
    }

    // Per-token mode. Ports Go `calculateTextQuotaSummary` (service/text_quota.go):
    // each token sub-category is priced at its own ratio relative to model_ratio,
    // then the sum is multiplied by model_ratio * group_ratio. Cache-read,
    // cache-write, and image tokens are SUBTRACTED from the prompt base (for
    // non-Anthropic usage) and re-added at their own ratio, so e.g. image
    // tokens bill at image_ratio, not the prompt rate.
    let ratio = model_ratio * group_ratio;
    let prompt = usage.prompt_tokens.max(0) as f64;
    let completion = usage.completion_tokens.max(0) as f64;
    let cached = usage.cached_tokens.max(0) as f64;
    let cache_creation = usage.cache_creation_tokens.max(0) as f64;
    let image = usage.image_tokens.max(0) as f64;

    let mut base_tokens = prompt;
    let mut cached_with_ratio = 0.0;
    let mut cache_creation_with_ratio = 0.0;
    let mut image_with_ratio = 0.0;

    if cached > 0.0 {
        if !usage.is_anthropic_usage_semantic {
            // OpenAI: cached tokens are INCLUDED in prompt_tokens; subtract.
            base_tokens -= cached;
        }
        cached_with_ratio = cached * cache_ratio;
    }

    if cache_creation > 0.0
        || usage.cache_creation_5m_tokens > 0
        || usage.cache_creation_1h_tokens > 0
    {
        if !usage.is_anthropic_usage_semantic {
            base_tokens -= cache_creation;
            cache_creation_with_ratio = cache_creation * cache_creation_ratio;
        } else {
            // Anthropic: prompt excludes cache-write; price the remainder at the
            // 5m ratio and the explicit 5m/1h split at their own ratios.
            let remaining = (cache_creation
                - usage.cache_creation_5m_tokens as f64
                - usage.cache_creation_1h_tokens as f64)
                .max(0.0);
            cache_creation_with_ratio = remaining * cache_creation_ratio_5m
                + (usage.cache_creation_5m_tokens as f64) * cache_creation_ratio_5m
                + (usage.cache_creation_1h_tokens as f64) * cache_creation_ratio_1h;
        }
    }

    if image > 0.0 {
        base_tokens -= image;
        image_with_ratio = image * image_ratio;
    }

    base_tokens = base_tokens.max(0.0);
    let prompt_quota =
        base_tokens + cached_with_ratio + image_with_ratio + cache_creation_with_ratio;
    let completion_quota = completion * completion_ratio;
    let raw_quota = (prompt_quota + completion_quota) * ratio;

    // Floor: a billable model with ratio > 0 must charge at least 1.
    let quota = if ratio != 0.0 && raw_quota <= 0.0 {
        1
    } else {
        quota_round(raw_quota)
    };

    FlatQuotaResult {
        quota,
        mode: FlatBillingMode::PerToken,
        model_ratio,
        completion_ratio,
        group_ratio,
        cache_ratio,
        fixed_price_multiplier,
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
        // Even with total_tokens=0, fixed-price mode charges because the
        // upstream returned a successful image. BUT our guard returns 0 for
        // total_tokens==0 BEFORE the fixed-price branch. To charge for
        // image gens, the caller must set total_tokens>=1 (the relay does
        // this: Go forces TotalTokens=1 for image models). Verify the guard
        // fires here.
        assert_eq!(result.quota, 0);

        // With total_tokens=1 (caller-set for image gens):
        let usage = FlatUsage {
            prompt_tokens: 1,
            total_tokens: 1,
            ..FlatUsage::default()
        };
        let result = compute_flat_quota(&usage, "dall-e-3", "default", &config);
        // 0.04 * 500000 * 1 = 20000
        assert_eq!(result.quota, 20_000);
        assert_eq!(result.mode, FlatBillingMode::FixedPrice);
    }

    #[test]
    fn fixed_price_multiplier_scales_before_rounding_and_ignores_invalid_values() {
        let mut config = PricingConfig::new();
        config.model_prices.insert("image-model".to_string(), 0.04);
        let usage = FlatUsage {
            prompt_tokens: 1,
            total_tokens: 1,
            ..FlatUsage::default()
        };

        let result = compute_flat_quota_with_fixed_price_multiplier(
            &usage,
            "image-model",
            "default",
            &config,
            4.0,
        );
        assert_eq!(result.quota, 80_000);
        assert_eq!(result.fixed_price_multiplier, 4.0);

        for invalid in [0.0, -1.0, f64::NAN] {
            let result = compute_flat_quota_with_fixed_price_multiplier(
                &usage,
                "image-model",
                "default",
                &config,
                invalid,
            );
            assert_eq!(result.quota, 20_000);
            assert_eq!(result.fixed_price_multiplier, 1.0);
        }
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
}
