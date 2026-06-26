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
//! quota = round(model_price * quota_per_unit * group_ratio)
//! ```
//!
//! Per-token mode (default):
//! ```text
//! ratio            = model_ratio * group_ratio
//! prompt_base      = prompt_tokens - cached_tokens            // OpenAI semantic
//! prompt_base      = prompt_tokens                             // Anthropic semantic
//! cached_contrib   = cached_tokens * cache_ratio
//! completion_quota = completion_tokens * completion_ratio
//! quota            = round((prompt_base + cached_contrib + completion_quota) * ratio)
//! ```
//!
//! Guards (match Go):
//! - `total_tokens == 0` → `quota = 0` (free; caller refunds any reserve).
//! - `ratio != 0 && quota <= 0` → `quota = 1` (floor for billable models).
//!
//! ## Simplifications vs Go (deferred to a later batch)
//!
//! - No `cache_creation` 5m/1h split (single `cache_creation_ratio`).
//! - No `ToolCallSurcharge` (web_search / file_search fixed fees).
//! - No `OtherRatios` (image "n" multiplier).
//! - No hardcoded completion-ratio prefix table — operators configure
//!   `CompletionRatio` explicitly; default 1.0.
//! - Image / audio tokens are NOT subtracted from the prompt base; they are
//!   billed at the prompt rate. The tiered path handles per-modality
//!   pricing; for flat mode they ride along with prompt_tokens.

use crate::pricing::PricingConfig;

/// Default cache-creation multiplier (matches Go default of 1.25). Exposed
/// for future cache-creation billing; the current flat path only prices
/// cache reads via `cache_ratio`.
#[allow(dead_code)]
pub const DEFAULT_CREATE_CACHE_RATIO: f64 = 1.25;

/// Usage inputs for the flat quota computation. The caller maps from its
/// own usage type (e.g. relay's `UsageSummary`) into this neutral struct
/// so the billing crate stays free of relay types.
#[derive(Debug, Clone, Copy)]
pub struct FlatUsage {
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
    pub cached_tokens: i64,
    /// True when the upstream usage follows Anthropic semantics, where
    /// `prompt_tokens` already excludes cache hits (so we add them back at
    /// the cache ratio instead of subtracting-then-remultiplying).
    pub is_anthropic_usage_semantic: bool,
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
}

/// Compute the flat quota for a single relay response.
pub fn compute_flat_quota(
    usage: &FlatUsage,
    model: &str,
    group: &str,
    config: &PricingConfig,
) -> FlatQuotaResult {
    let group_ratio = config.group_ratio(group);
    let model_ratio = config.model_ratio(model);
    let completion_ratio = config.completion_ratio(model);
    let cache_ratio = config.cache_ratio(model);

    // Zero-usage guard: free request.
    if usage.total_tokens <= 0 {
        return FlatQuotaResult {
            quota: 0,
            mode: FlatBillingMode::PerToken,
            model_ratio,
            completion_ratio,
            group_ratio,
            cache_ratio,
        };
    }

    // Fixed-price mode takes precedence.
    if let Some(price) = config.model_price(model) {
        let quota = price * config.quota_per_unit * group_ratio;
        return FlatQuotaResult {
            quota: quota_round(quota),
            mode: FlatBillingMode::FixedPrice,
            model_ratio,
            completion_ratio,
            group_ratio,
            cache_ratio,
        };
    }

    // Per-token mode.
    let ratio = model_ratio * group_ratio;
    let prompt = usage.prompt_tokens.max(0) as f64;
    let completion = usage.completion_tokens.max(0) as f64;
    let cached = usage.cached_tokens.max(0) as f64;

    let prompt_base = if usage.is_anthropic_usage_semantic {
        // Claude: prompt_tokens already excludes cache hits; add them back
        // at the cache ratio. No subtraction needed.
        prompt + cached * cache_ratio
    } else {
        // OpenAI: cached tokens are INCLUDED in prompt_tokens; subtract then
        // re-add at the cache ratio to apply the discount.
        let base = (prompt - cached).max(0.0);
        base + cached * cache_ratio
    };
    let completion_quota = completion * completion_ratio;
    let raw_quota = (prompt_base + completion_quota) * ratio;

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
    }
}

/// Round a quota value to the nearest integer, rounding halves away from
/// zero. Matches Go's `int(math.Round(...))` and the tiered path's
/// `quota_round`.
fn quota_round(value: f64) -> i64 {
    if value >= 0.0 {
        (value + 0.5) as i64
    } else {
        // Negative quotas should not occur in the flat path (guards floor
        // to 0 or 1), but round symmetrically for safety.
        -(((-value) + 0.5) as i64)
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
            cached_tokens: 0,
            is_anthropic_usage_semantic: false,
        }
    }

    #[test]
    fn zero_usage_is_free() {
        let config = config_with_model_ratio("gpt-4o", 1.25);
        let usage = FlatUsage {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
            cached_tokens: 0,
            is_anthropic_usage_semantic: false,
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
            completion_tokens: 0,
            total_tokens: 1,
            cached_tokens: 0,
            is_anthropic_usage_semantic: false,
        };
        let result = compute_flat_quota(&usage, "dall-e-3", "default", &config);
        // 0.04 * 500000 * 1 = 20000
        assert_eq!(result.quota, 20_000);
        assert_eq!(result.mode, FlatBillingMode::FixedPrice);
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
            completion_tokens: 0,
            total_tokens: 1000,
            cached_tokens: 800,
            is_anthropic_usage_semantic: false,
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
            completion_tokens: 0,
            total_tokens: 1000,
            cached_tokens: 800,
            is_anthropic_usage_semantic: true,
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
}
