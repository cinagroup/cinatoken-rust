use serde::{Deserialize, Serialize};

pub const DEFAULT_QUOTA_PER_UNIT: f64 = 500_000.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Quota(pub i64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct BillingEstimate {
    pub pre_consume_quota: Quota,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct BillingSettlement {
    pub final_quota: Quota,
    pub refund_quota: Quota,
    pub additional_quota: Quota,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct TokenUsage {
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
}

impl TokenUsage {
    pub fn total_tokens(self) -> i64 {
        self.prompt_tokens.saturating_add(self.completion_tokens)
    }
}

pub fn settle(pre_consumed: Quota, actual: Quota) -> BillingSettlement {
    let refund = (pre_consumed.0 - actual.0).max(0);
    let additional = (actual.0 - pre_consumed.0).max(0);
    BillingSettlement {
        final_quota: actual,
        refund_quota: Quota(refund),
        additional_quota: Quota(additional),
    }
}

pub fn quota_round(value: f64) -> i64 {
    if !value.is_finite() {
        return 0;
    }
    if value >= i64::MAX as f64 {
        return i64::MAX;
    }
    if value <= i64::MIN as f64 {
        return i64::MIN;
    }
    value.round() as i64
}

pub fn expression_cost_to_quota(
    expression_cost: f64,
    quota_per_unit: f64,
    group_ratio: f64,
) -> Quota {
    Quota(quota_round(
        expression_cost / 1_000_000.0 * quota_per_unit * group_ratio,
    ))
}

pub fn flat_text_quota(
    usage: TokenUsage,
    prompt_price_per_million: f64,
    completion_price_per_million: f64,
    quota_per_unit: f64,
    group_ratio: f64,
) -> Quota {
    let expression_cost = usage.prompt_tokens.max(0) as f64 * prompt_price_per_million
        + usage.completion_tokens.max(0) as f64 * completion_price_per_million;
    expression_cost_to_quota(expression_cost, quota_per_unit, group_ratio)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BillingSnapshot {
    pub billing_mode: String,
    pub model_name: String,
    pub group_ratio: f64,
    pub quota_per_unit: f64,
    pub estimated_prompt_tokens: i64,
    pub estimated_completion_tokens: i64,
    pub estimated_quota: Quota,
}

impl BillingSnapshot {
    pub fn from_flat_text_prices(
        model_name: impl Into<String>,
        usage: TokenUsage,
        prompt_price_per_million: f64,
        completion_price_per_million: f64,
        group_ratio: f64,
    ) -> Self {
        Self {
            billing_mode: "flat_text_price".to_string(),
            model_name: model_name.into(),
            group_ratio,
            quota_per_unit: DEFAULT_QUOTA_PER_UNIT,
            estimated_prompt_tokens: usage.prompt_tokens,
            estimated_completion_tokens: usage.completion_tokens,
            estimated_quota: flat_text_quota(
                usage,
                prompt_price_per_million,
                completion_price_per_million,
                DEFAULT_QUOTA_PER_UNIT,
                group_ratio,
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quota_round_matches_go_half_away_from_zero_cases() {
        let cases = [
            (0.0, 0),
            (0.4, 0),
            (0.5, 1),
            (0.6, 1),
            (1.5, 2),
            (-0.5, -1),
            (-0.6, -1),
            (999.4999, 999),
            (999.5, 1000),
            (1e9 + 0.5, 1_000_000_001),
        ];
        for (input, expected) in cases {
            assert_eq!(quota_round(input), expected, "input={input}");
        }
    }

    #[test]
    fn expression_cost_to_quota_uses_original_conversion_formula() {
        let cost = 100_000.0 * 1.5 + 5_000.0 * 7.5;
        assert_eq!(
            expression_cost_to_quota(cost, DEFAULT_QUOTA_PER_UNIT, 1.0),
            Quota(93_750)
        );
        assert_eq!(
            expression_cost_to_quota(cost, DEFAULT_QUOTA_PER_UNIT, 1.5),
            Quota(140_625)
        );
    }

    #[test]
    fn flat_text_quota_prices_prompt_and_completion_separately() {
        let usage = TokenUsage {
            prompt_tokens: 100_000,
            completion_tokens: 5_000,
        };
        assert_eq!(
            flat_text_quota(usage, 1.5, 7.5, DEFAULT_QUOTA_PER_UNIT, 1.0),
            Quota(93_750)
        );
    }

    #[test]
    fn settle_reports_refund_or_additional_delta() {
        assert_eq!(
            settle(Quota(100), Quota(80)),
            BillingSettlement {
                final_quota: Quota(80),
                refund_quota: Quota(20),
                additional_quota: Quota(0),
            }
        );
        assert_eq!(
            settle(Quota(100), Quota(130)),
            BillingSettlement {
                final_quota: Quota(130),
                refund_quota: Quota(0),
                additional_quota: Quota(30),
            }
        );
    }

    #[test]
    fn snapshot_freezes_estimate_inputs() {
        let snapshot = BillingSnapshot::from_flat_text_prices(
            "gpt-test",
            TokenUsage {
                prompt_tokens: 10,
                completion_tokens: 2,
            },
            2.0,
            10.0,
            1.25,
        );
        assert_eq!(snapshot.billing_mode, "flat_text_price");
        assert_eq!(snapshot.model_name, "gpt-test");
        assert_eq!(snapshot.estimated_prompt_tokens, 10);
        assert_eq!(snapshot.estimated_completion_tokens, 2);
        assert_eq!(snapshot.quota_per_unit, DEFAULT_QUOTA_PER_UNIT);
    }
}
