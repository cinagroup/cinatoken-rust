use serde::{Deserialize, Serialize};

use crate::{
    compile_billing_expr_metadata, expression_cost_to_quota, quota_round,
    run_billing_expr_with_request, settle, BillingExprError, BillingSettlement, Quota,
    RequestInput, TokenParams, DEFAULT_QUOTA_PER_UNIT,
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TieredBillingSnapshot {
    pub billing_mode: String,
    pub model_name: String,
    pub expr_string: String,
    pub expr_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_rule_expr: Option<String>,
    pub expr_version: u32,
    pub group_ratio: f64,
    pub quota_per_unit: f64,
    pub estimated_prompt_tokens: i64,
    pub estimated_completion_tokens: i64,
    pub estimated_expression_cost: f64,
    pub estimated_quota_before_group: f64,
    pub estimated_quota_after_group: Quota,
    pub estimated_tier: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TieredBillingResult {
    pub actual_expression_cost: f64,
    pub actual_quota_before_group: f64,
    pub actual_quota_after_group: Quota,
    pub matched_tier: String,
    pub crossed_tier: bool,
    pub settlement: BillingSettlement,
}

pub fn estimate_tiered_billing_snapshot(
    model_name: impl Into<String>,
    expr_string: impl Into<String>,
    estimated_params: TokenParams,
    group_ratio: f64,
) -> Result<TieredBillingSnapshot, BillingExprError> {
    estimate_tiered_billing_snapshot_with_request(
        model_name,
        expr_string,
        estimated_params,
        group_ratio,
        RequestInput::default(),
    )
}

pub fn estimate_tiered_billing_snapshot_with_request(
    model_name: impl Into<String>,
    expr_string: impl Into<String>,
    estimated_params: TokenParams,
    group_ratio: f64,
    request: RequestInput,
) -> Result<TieredBillingSnapshot, BillingExprError> {
    let expr_string = expr_string.into();
    let metadata = compile_billing_expr_metadata(&expr_string)?;
    let run = run_billing_expr_with_request(&expr_string, estimated_params, request)?;
    let estimated_quota_before_group =
        expression_cost_to_quota_before_group(run.cost, DEFAULT_QUOTA_PER_UNIT);
    let estimated_quota_after_group =
        expression_cost_to_quota(run.cost, DEFAULT_QUOTA_PER_UNIT, group_ratio);

    Ok(TieredBillingSnapshot {
        billing_mode: "tiered_expr".to_string(),
        model_name: model_name.into(),
        expr_string,
        expr_hash: metadata.expr_hash,
        request_rule_expr: metadata.request_rule_expr,
        expr_version: metadata.expr_version,
        group_ratio,
        quota_per_unit: DEFAULT_QUOTA_PER_UNIT,
        estimated_prompt_tokens: quota_round(estimated_params.p),
        estimated_completion_tokens: quota_round(estimated_params.c),
        estimated_expression_cost: run.cost,
        estimated_quota_before_group,
        estimated_quota_after_group,
        estimated_tier: run.trace.matched_tier,
    })
}

/// Clone a frozen billing snapshot for another serving-group ratio without
/// re-running the expression. This keeps request/time-dependent expression
/// output identical across a preplanned cross-group retry set; only the group
/// multiplier and resulting reservation change.
pub fn rebase_tiered_billing_snapshot_group_ratio(
    snapshot: &TieredBillingSnapshot,
    group_ratio: f64,
) -> TieredBillingSnapshot {
    let mut rebased = snapshot.clone();
    let group_ratio = if group_ratio.is_finite() {
        group_ratio.max(0.0)
    } else {
        0.0
    };
    rebased.group_ratio = group_ratio;
    rebased.estimated_quota_after_group = expression_cost_to_quota(
        rebased.estimated_expression_cost,
        rebased.quota_per_unit,
        group_ratio,
    );
    rebased
}

pub fn compute_tiered_quota(
    snapshot: &TieredBillingSnapshot,
    actual_params: TokenParams,
) -> Result<TieredBillingResult, BillingExprError> {
    compute_tiered_quota_with_request(snapshot, actual_params, RequestInput::default())
}

pub fn compute_tiered_quota_with_request(
    snapshot: &TieredBillingSnapshot,
    actual_params: TokenParams,
    request: RequestInput,
) -> Result<TieredBillingResult, BillingExprError> {
    let run = run_billing_expr_with_request(&snapshot.expr_string, actual_params, request)?;
    let actual_quota_before_group =
        expression_cost_to_quota_before_group(run.cost, snapshot.quota_per_unit);
    let actual_quota_after_group = Quota(quota_round(
        actual_quota_before_group * snapshot.group_ratio,
    ));
    let matched_tier = run.trace.matched_tier;
    let crossed_tier = matched_tier != snapshot.estimated_tier;
    let settlement = settle(
        snapshot.estimated_quota_after_group,
        actual_quota_after_group,
    );

    Ok(TieredBillingResult {
        actual_expression_cost: run.cost,
        actual_quota_before_group,
        actual_quota_after_group,
        matched_tier,
        crossed_tier,
        settlement,
    })
}

fn expression_cost_to_quota_before_group(expression_cost: f64, quota_per_unit: f64) -> f64 {
    if !expression_cost.is_finite() || !quota_per_unit.is_finite() {
        return 0.0;
    }
    expression_cost / 1_000_000.0 * quota_per_unit
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use serde_json::json;

    use super::*;

    const FLAT_EXPR: &str = r#"tier("default", p * 2 + c * 10)"#;
    const TIER_EXPR: &str = r#"p <= 200000 ? tier("standard", p * 1.5 + c * 7.5) : tier("long_context", p * 3 + c * 11.25)"#;
    const PROBE_EXPR: &str = r#"param("service_tier") == "fast" ? tier("fast", p * 4 + c * 20) : tier("normal", p * 2 + c * 10)"#;
    const REQUEST_RULE_EXPR: &str =
        r#"tier("base", p * 2 + c * 10)|||(param("service_tier") == "fast" ? 3 : 1)"#;

    fn params(p: f64, c: f64) -> TokenParams {
        TokenParams {
            p,
            c,
            len: p,
            ..TokenParams::default()
        }
    }

    #[test]
    fn estimate_tiered_snapshot_freezes_preconsume_state() {
        let snapshot =
            estimate_tiered_billing_snapshot("gpt-test", FLAT_EXPR, params(1_000.0, 500.0), 1.0)
                .expect("snapshot should build");

        assert_eq!(snapshot.billing_mode, "tiered_expr");
        assert_eq!(snapshot.model_name, "gpt-test");
        assert_eq!(snapshot.expr_hash, crate::expr_hash_string(FLAT_EXPR));
        assert_eq!(snapshot.expr_version, 1);
        assert_eq!(snapshot.estimated_prompt_tokens, 1_000);
        assert_eq!(snapshot.estimated_completion_tokens, 500);
        assert_eq!(snapshot.estimated_expression_cost, 7_000.0);
        assert_eq!(snapshot.estimated_quota_before_group, 3_500.0);
        assert_eq!(snapshot.estimated_quota_after_group, Quota(3_500));
        assert_eq!(snapshot.estimated_tier, "default");
    }

    #[test]
    fn compute_tiered_quota_matches_preconsume_when_usage_matches() {
        let snapshot =
            estimate_tiered_billing_snapshot("gpt-test", FLAT_EXPR, params(1_000.0, 500.0), 1.0)
                .expect("snapshot should build");

        let result = compute_tiered_quota(&snapshot, params(1_000.0, 500.0)).expect("settlement");

        assert_eq!(result.actual_quota_after_group, Quota(3_500));
        assert_eq!(result.settlement.final_quota, Quota(3_500));
        assert_eq!(result.settlement.refund_quota, Quota(0));
        assert_eq!(result.settlement.additional_quota, Quota(0));
        assert!(!result.crossed_tier);
    }

    #[test]
    fn compute_tiered_quota_reports_additional_and_refund_deltas() {
        let snapshot =
            estimate_tiered_billing_snapshot("gpt-test", FLAT_EXPR, params(1_000.0, 500.0), 1.0)
                .expect("snapshot should build");

        let higher = compute_tiered_quota(&snapshot, params(2_000.0, 1_000.0)).expect("settlement");
        assert_eq!(higher.actual_quota_after_group, Quota(7_000));
        assert_eq!(higher.settlement.additional_quota, Quota(3_500));
        assert_eq!(higher.settlement.refund_quota, Quota(0));

        let lower = compute_tiered_quota(&snapshot, params(100.0, 50.0)).expect("settlement");
        assert_eq!(lower.actual_quota_after_group, Quota(350));
        assert_eq!(lower.settlement.additional_quota, Quota(0));
        assert_eq!(lower.settlement.refund_quota, Quota(3_150));
    }

    #[test]
    fn compute_tiered_quota_applies_group_ratio() {
        let snapshot =
            estimate_tiered_billing_snapshot("gpt-test", FLAT_EXPR, params(1_000.0, 500.0), 1.5)
                .expect("snapshot should build");

        assert_eq!(snapshot.estimated_quota_after_group, Quota(5_250));

        let result = compute_tiered_quota(&snapshot, params(1_000.0, 500.0)).expect("settlement");
        assert_eq!(result.actual_quota_before_group, 3_500.0);
        assert_eq!(result.actual_quota_after_group, Quota(5_250));
    }

    #[test]
    fn rebase_group_ratio_preserves_frozen_expression_result() {
        let snapshot =
            estimate_tiered_billing_snapshot("gpt-test", FLAT_EXPR, params(1_000.0, 500.0), 1.0)
                .expect("snapshot should build");
        let rebased = rebase_tiered_billing_snapshot_group_ratio(&snapshot, 2.0);

        assert_eq!(rebased.group_ratio, 2.0);
        assert_eq!(rebased.estimated_quota_after_group, Quota(7_000));
        assert_eq!(rebased.expr_hash, snapshot.expr_hash);
        assert_eq!(
            rebased.estimated_expression_cost,
            snapshot.estimated_expression_cost
        );
        assert_eq!(rebased.estimated_tier, snapshot.estimated_tier);
    }

    #[test]
    fn compute_tiered_quota_marks_crossed_tier_at_boundary() {
        let snapshot = estimate_tiered_billing_snapshot(
            "claude-test",
            TIER_EXPR,
            params(200_000.0, 1_000.0),
            1.0,
        )
        .expect("snapshot should build");

        assert_eq!(snapshot.estimated_tier, "standard");

        let result =
            compute_tiered_quota(&snapshot, params(200_001.0, 1_000.0)).expect("settlement");
        assert_eq!(result.matched_tier, "long_context");
        assert!(result.crossed_tier);
        assert_eq!(result.actual_quota_after_group, Quota(305_627));
    }

    #[test]
    fn tiered_snapshot_and_settlement_keep_request_probe_context() {
        let request = RequestInput::from_json_body(json!({"service_tier": "fast"})).with_headers(
            HashMap::from([("anthropic-beta".to_string(), "fast-mode".to_string())]),
        );
        let snapshot = estimate_tiered_billing_snapshot_with_request(
            "probe-test",
            PROBE_EXPR,
            params(1_000.0, 500.0),
            1.0,
            request.clone(),
        )
        .expect("snapshot should build");

        assert_eq!(snapshot.estimated_tier, "fast");
        assert_eq!(snapshot.estimated_quota_after_group, Quota(7_000));

        let result = compute_tiered_quota_with_request(&snapshot, params(1_000.0, 500.0), request)
            .expect("settlement");
        assert_eq!(result.matched_tier, "fast");
        assert_eq!(result.actual_quota_after_group, Quota(7_000));
        assert!(!result.crossed_tier);
    }

    #[test]
    fn tiered_snapshot_and_settlement_apply_request_rule_separator() {
        let request = RequestInput::from_json_body(json!({"service_tier": "fast"}));
        let snapshot = estimate_tiered_billing_snapshot_with_request(
            "probe-test",
            REQUEST_RULE_EXPR,
            params(1_000.0, 500.0),
            1.0,
            request.clone(),
        )
        .expect("snapshot should build");

        assert_eq!(
            snapshot.request_rule_expr.as_deref(),
            Some(r#"(param("service_tier") == "fast" ? 3 : 1)"#)
        );
        assert_eq!(
            snapshot.expr_hash,
            crate::expr_hash_string(REQUEST_RULE_EXPR)
        );
        assert_eq!(snapshot.estimated_tier, "base");
        assert_eq!(snapshot.estimated_expression_cost, 21_000.0);
        assert_eq!(snapshot.estimated_quota_after_group, Quota(10_500));

        let result = compute_tiered_quota_with_request(&snapshot, params(1_000.0, 500.0), request)
            .expect("settlement");
        assert_eq!(result.matched_tier, "base");
        assert_eq!(result.actual_quota_after_group, Quota(10_500));
        assert!(!result.crossed_tier);
    }

    #[test]
    fn tiered_settlement_without_request_probe_uses_default_branch() {
        let request = RequestInput::from_json_body(json!({"service_tier": "fast"}));
        let snapshot = estimate_tiered_billing_snapshot_with_request(
            "probe-test",
            PROBE_EXPR,
            params(1_000.0, 500.0),
            1.0,
            request,
        )
        .expect("snapshot should build");

        let result = compute_tiered_quota(&snapshot, params(1_000.0, 500.0)).expect("settlement");
        assert_eq!(result.matched_tier, "normal");
        assert_eq!(result.actual_quota_after_group, Quota(3_500));
        assert!(result.crossed_tier);
    }

    #[test]
    fn invalid_expression_returns_error_before_quota_mutation() {
        let error = estimate_tiered_billing_snapshot(
            "bad-test",
            "tier(\"default\", p + )",
            params(100.0, 0.0),
            1.0,
        )
        .expect_err("invalid expression should fail");

        assert!(matches!(error, BillingExprError::Parse(_)));
    }
}
