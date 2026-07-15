//! OpenRouter cache-write reconstruction from provider-reported USD cost.
//!
//! This ports the narrow Go `CalcOpenRouterCacheCreateTokens` compatibility
//! path. It is flat-billing only and consumes frozen pricing facts; tiered
//! expressions always retain the original provider usage.

use rust_decimal::prelude::ToPrimitive;
use rust_decimal::{Decimal, RoundingStrategy};

pub const OPENROUTER_CACHE_WRITE_INFERENCE_VERSION: u16 = 1;

#[derive(Debug, Clone, Copy)]
pub struct OpenRouterCacheWriteInput {
    pub is_openrouter: bool,
    pub is_anthropic_usage_semantic: bool,
    pub is_per_token: bool,
    pub model_ratio_matches_go_default: bool,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub cache_read_tokens: i64,
    pub existing_cache_creation_tokens: i64,
    pub provider_cost_usd: Option<Decimal>,
    pub model_ratio: f64,
    pub completion_ratio: f64,
    pub cache_ratio: f64,
    pub cache_creation_ratio: f64,
    pub quota_per_unit: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenRouterCacheWriteReason {
    Applied,
    NotOpenRouter,
    NonAnthropicSemantic,
    FixedPrice,
    ExplicitAggregate,
    CustomModelRatio,
    MissingProviderCost,
    UnitCacheCreationRatio,
    InvalidPricing,
    CandidateOutOfRange,
}

impl OpenRouterCacheWriteReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Applied => "applied",
            Self::NotOpenRouter => "not_openrouter",
            Self::NonAnthropicSemantic => "non_anthropic_semantic",
            Self::FixedPrice => "fixed_price",
            Self::ExplicitAggregate => "explicit_aggregate",
            Self::CustomModelRatio => "custom_model_ratio",
            Self::MissingProviderCost => "missing_provider_cost",
            Self::UnitCacheCreationRatio => "unit_cache_creation_ratio",
            Self::InvalidPricing => "invalid_pricing",
            Self::CandidateOutOfRange => "candidate_out_of_range",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OpenRouterCacheWriteInference {
    pub version: u16,
    pub candidate_tokens: Option<i64>,
    pub applied_tokens: Option<i64>,
    pub reason: OpenRouterCacheWriteReason,
}

impl OpenRouterCacheWriteInference {
    fn rejected(reason: OpenRouterCacheWriteReason, candidate_tokens: Option<i64>) -> Self {
        Self {
            version: OPENROUTER_CACHE_WRITE_INFERENCE_VERSION,
            candidate_tokens,
            applied_tokens: None,
            reason,
        }
    }
}

pub fn infer_openrouter_cache_write_tokens(
    input: OpenRouterCacheWriteInput,
) -> OpenRouterCacheWriteInference {
    if !input.is_openrouter {
        return OpenRouterCacheWriteInference::rejected(
            OpenRouterCacheWriteReason::NotOpenRouter,
            None,
        );
    }
    if !input.is_anthropic_usage_semantic {
        return OpenRouterCacheWriteInference::rejected(
            OpenRouterCacheWriteReason::NonAnthropicSemantic,
            None,
        );
    }
    if !input.is_per_token {
        return OpenRouterCacheWriteInference::rejected(
            OpenRouterCacheWriteReason::FixedPrice,
            None,
        );
    }
    if input.existing_cache_creation_tokens > 0 {
        return OpenRouterCacheWriteInference::rejected(
            OpenRouterCacheWriteReason::ExplicitAggregate,
            None,
        );
    }
    if !input.model_ratio_matches_go_default {
        return OpenRouterCacheWriteInference::rejected(
            OpenRouterCacheWriteReason::CustomModelRatio,
            None,
        );
    }
    let Some(cost) = input.provider_cost_usd else {
        return OpenRouterCacheWriteInference::rejected(
            OpenRouterCacheWriteReason::MissingProviderCost,
            None,
        );
    };
    if input.cache_creation_ratio == 1.0 {
        return OpenRouterCacheWriteInference::rejected(
            OpenRouterCacheWriteReason::UnitCacheCreationRatio,
            None,
        );
    }

    let pricing = (
        decimal_from_f64(input.model_ratio),
        decimal_from_f64(input.completion_ratio),
        decimal_from_f64(input.cache_ratio),
        decimal_from_f64(input.cache_creation_ratio),
        decimal_from_f64(input.quota_per_unit),
    );
    let (
        Some(model_ratio),
        Some(completion_ratio),
        Some(cache_ratio),
        Some(cache_creation_ratio),
        Some(quota_per_unit),
    ) = pricing
    else {
        return OpenRouterCacheWriteInference::rejected(
            OpenRouterCacheWriteReason::InvalidPricing,
            None,
        );
    };
    if model_ratio <= Decimal::ZERO
        || quota_per_unit <= Decimal::ZERO
        || completion_ratio < Decimal::ZERO
        || cache_ratio < Decimal::ZERO
        || cache_creation_ratio < Decimal::ZERO
        || cost < Decimal::ZERO
    {
        return OpenRouterCacheWriteInference::rejected(
            OpenRouterCacheWriteReason::InvalidPricing,
            None,
        );
    }

    let prices = model_ratio.checked_div(quota_per_unit).and_then(|base| {
        Some((
            base,
            base.checked_mul(cache_ratio)?,
            base.checked_mul(cache_creation_ratio)?,
            base.checked_mul(completion_ratio)?,
        ))
    });
    let Some((base_price, read_price, write_price, output_price)) = prices else {
        return OpenRouterCacheWriteInference::rejected(
            OpenRouterCacheWriteReason::InvalidPricing,
            None,
        );
    };
    let Some(denominator) = write_price.checked_sub(base_price) else {
        return OpenRouterCacheWriteInference::rejected(
            OpenRouterCacheWriteReason::InvalidPricing,
            None,
        );
    };
    if denominator.is_zero() {
        return OpenRouterCacheWriteInference::rejected(
            OpenRouterCacheWriteReason::UnitCacheCreationRatio,
            None,
        );
    }

    let prompt = Decimal::from(input.prompt_tokens.max(0));
    let completion = Decimal::from(input.completion_tokens.max(0));
    let cache_read = Decimal::from(input.cache_read_tokens.max(0));
    let numerator = prompt
        .checked_mul(base_price)
        .and_then(|prompt_cost| cost.checked_sub(prompt_cost))
        .and_then(|value| {
            base_price
                .checked_sub(read_price)
                .and_then(|delta| cache_read.checked_mul(delta))
                .and_then(|component| value.checked_add(component))
        })
        .and_then(|value| {
            completion
                .checked_mul(output_price)
                .and_then(|v| value.checked_sub(v))
        });
    let Some(candidate) = numerator.and_then(|value| value.checked_div(denominator)) else {
        return OpenRouterCacheWriteInference::rejected(
            OpenRouterCacheWriteReason::InvalidPricing,
            None,
        );
    };
    let candidate = candidate
        .round_dp_with_strategy(0, RoundingStrategy::MidpointAwayFromZero)
        .to_i64();
    let Some(candidate) = candidate else {
        return OpenRouterCacheWriteInference::rejected(
            OpenRouterCacheWriteReason::InvalidPricing,
            None,
        );
    };
    let max_candidate = input
        .prompt_tokens
        .max(0)
        .saturating_sub(input.cache_read_tokens.max(0));
    if candidate < 0 || candidate > max_candidate {
        return OpenRouterCacheWriteInference::rejected(
            OpenRouterCacheWriteReason::CandidateOutOfRange,
            Some(candidate),
        );
    }

    OpenRouterCacheWriteInference {
        version: OPENROUTER_CACHE_WRITE_INFERENCE_VERSION,
        candidate_tokens: Some(candidate),
        applied_tokens: Some(candidate),
        reason: OpenRouterCacheWriteReason::Applied,
    }
}

fn decimal_from_f64(value: f64) -> Option<Decimal> {
    if !value.is_finite() {
        return None;
    }
    let raw = value.to_string();
    if raw.contains(['e', 'E']) {
        Decimal::from_scientific(&raw).ok()
    } else {
        raw.parse().ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> OpenRouterCacheWriteInput {
        OpenRouterCacheWriteInput {
            is_openrouter: true,
            is_anthropic_usage_semantic: true,
            is_per_token: true,
            model_ratio_matches_go_default: true,
            prompt_tokens: 2_604,
            completion_tokens: 383,
            cache_read_tokens: 2_432,
            existing_cache_creation_tokens: 0,
            provider_cost_usd: Some(Decimal::new(16_464, 7)),
            model_ratio: 1.0,
            completion_ratio: 1.0,
            cache_ratio: 0.1,
            cache_creation_ratio: 1.25,
            quota_per_unit: 500_000.0,
        }
    }

    #[test]
    fn infers_go_compatible_cache_write_from_provider_cost() {
        let result = infer_openrouter_cache_write_tokens(input());
        assert_eq!(result.reason, OpenRouterCacheWriteReason::Applied);
        assert_eq!(result.applied_tokens, Some(100));
    }

    #[test]
    fn rounds_half_away_from_zero_once() {
        let result = infer_openrouter_cache_write_tokens(OpenRouterCacheWriteInput {
            prompt_tokens: 10,
            completion_tokens: 0,
            cache_read_tokens: 0,
            provider_cost_usd: Some(Decimal::new(105, 1)),
            model_ratio: 1.0,
            completion_ratio: 0.0,
            cache_ratio: 1.0,
            cache_creation_ratio: 2.0,
            quota_per_unit: 1.0,
            ..input()
        });
        assert_eq!(result.applied_tokens, Some(1));
    }

    #[test]
    fn explicit_aggregate_and_custom_ratio_disable_inference() {
        let explicit = infer_openrouter_cache_write_tokens(OpenRouterCacheWriteInput {
            existing_cache_creation_tokens: 1,
            ..input()
        });
        assert_eq!(
            explicit.reason,
            OpenRouterCacheWriteReason::ExplicitAggregate
        );

        let custom = infer_openrouter_cache_write_tokens(OpenRouterCacheWriteInput {
            model_ratio_matches_go_default: false,
            ..input()
        });
        assert_eq!(custom.reason, OpenRouterCacheWriteReason::CustomModelRatio);
    }

    #[test]
    fn rejects_candidates_outside_uncached_prompt_bound() {
        let result = infer_openrouter_cache_write_tokens(OpenRouterCacheWriteInput {
            provider_cost_usd: Some(Decimal::ONE),
            ..input()
        });
        assert_eq!(
            result.reason,
            OpenRouterCacheWriteReason::CandidateOutOfRange
        );
        assert!(result.applied_tokens.is_none());
    }
}
