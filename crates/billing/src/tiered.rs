use serde::{Deserialize, Serialize};

use crate::{
    compile_billing_expr_metadata, expression::current_unix_seconds, expression_cost_to_quota,
    freeze_billing_expr_request_input, quota_round, run_billing_expr_with_request_at, settle,
    BillingExprError, BillingSettlement, FrozenRequestInput, Quota, RequestInput, TokenParams,
    DEFAULT_QUOTA_PER_UNIT,
};

const MAX_DURABLE_EVALUATION_TIME_UNIX_SECONDS: i64 = 253_402_300_799;

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evaluation_time_unix_seconds: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frozen_request: Option<FrozenRequestInput>,
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
    estimate_tiered_billing_snapshot_with_request_at(
        model_name,
        expr_string,
        estimated_params,
        group_ratio,
        request,
        current_unix_seconds(),
    )
}

pub fn estimate_tiered_billing_snapshot_with_request_at(
    model_name: impl Into<String>,
    expr_string: impl Into<String>,
    estimated_params: TokenParams,
    group_ratio: f64,
    request: RequestInput,
    evaluation_time_unix_seconds: i64,
) -> Result<TieredBillingSnapshot, BillingExprError> {
    validate_durable_evaluation_time(evaluation_time_unix_seconds)?;
    let expr_string = expr_string.into();
    let metadata = compile_billing_expr_metadata(&expr_string)?;
    let frozen_request = freeze_billing_expr_request_input(&expr_string, &request)?;
    let run = run_billing_expr_with_request_at(
        &expr_string,
        estimated_params,
        frozen_request.to_request_input(),
        evaluation_time_unix_seconds,
    )?;
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
        evaluation_time_unix_seconds: Some(evaluation_time_unix_seconds),
        frozen_request: Some(frozen_request),
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
    let evaluation_time_unix_seconds = snapshot
        .evaluation_time_unix_seconds
        .unwrap_or_else(current_unix_seconds);
    let request = snapshot
        .frozen_request
        .as_ref()
        .map(FrozenRequestInput::to_request_input)
        .unwrap_or(request);
    compute_tiered_quota_at(
        snapshot,
        actual_params,
        request,
        evaluation_time_unix_seconds,
    )
}

/// Settles only from a complete reservation snapshot. This is the recovery-safe
/// API: callers cannot substitute live request facts or the current wall clock.
pub fn compute_tiered_quota_from_durable_snapshot(
    snapshot: &TieredBillingSnapshot,
    actual_params: TokenParams,
) -> Result<TieredBillingResult, BillingExprError> {
    snapshot.validate_durable()?;
    let request = snapshot
        .frozen_request
        .as_ref()
        .expect("durable snapshot validation requires frozen request facts")
        .to_request_input();
    let evaluation_time_unix_seconds = snapshot
        .evaluation_time_unix_seconds
        .expect("durable snapshot validation requires a frozen evaluation instant");
    compute_tiered_quota_at(
        snapshot,
        actual_params,
        request,
        evaluation_time_unix_seconds,
    )
}

fn compute_tiered_quota_at(
    snapshot: &TieredBillingSnapshot,
    actual_params: TokenParams,
    request: RequestInput,
    evaluation_time_unix_seconds: i64,
) -> Result<TieredBillingResult, BillingExprError> {
    let run = run_billing_expr_with_request_at(
        &snapshot.expr_string,
        actual_params,
        request,
        evaluation_time_unix_seconds,
    )?;
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

impl TieredBillingSnapshot {
    pub fn validate_durable(&self) -> Result<(), BillingExprError> {
        let metadata = compile_billing_expr_metadata(&self.expr_string)?;
        let evaluation_time_unix_seconds = self.evaluation_time_unix_seconds.ok_or_else(|| {
            BillingExprError::Runtime("tiered billing snapshot is not durable".to_string())
        })?;
        if self.billing_mode != "tiered_expr"
            || self.model_name.trim().is_empty()
            || self.expr_hash != metadata.expr_hash
            || self.expr_version != metadata.expr_version
            || self.request_rule_expr != metadata.request_rule_expr
            || !self.group_ratio.is_finite()
            || self.group_ratio < 0.0
            || !self.quota_per_unit.is_finite()
            || self.quota_per_unit <= 0.0
            || self.estimated_prompt_tokens < 0
            || self.estimated_completion_tokens < 0
            || !self.estimated_expression_cost.is_finite()
            || !self.estimated_quota_before_group.is_finite()
            || self.estimated_quota_after_group.0 < 0
            || self.frozen_request.is_none()
        {
            return Err(BillingExprError::Runtime(
                "tiered billing snapshot is not durable".to_string(),
            ));
        }
        validate_durable_evaluation_time(evaluation_time_unix_seconds)?;
        let frozen = self
            .frozen_request
            .as_ref()
            .expect("durable snapshot checked frozen request presence");
        let projected =
            freeze_billing_expr_request_input(&self.expr_string, &frozen.to_request_input())?;
        if &projected != frozen {
            return Err(BillingExprError::Runtime(
                "tiered billing snapshot request facts are not canonical".to_string(),
            ));
        }
        Ok(())
    }
}

fn validate_durable_evaluation_time(value: i64) -> Result<(), BillingExprError> {
    if (0..=MAX_DURABLE_EVALUATION_TIME_UNIX_SECONDS).contains(&value) {
        Ok(())
    } else {
        Err(BillingExprError::Runtime(
            "tiered billing evaluation time is outside the durable range".to_string(),
        ))
    }
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
        assert!(snapshot.evaluation_time_unix_seconds.is_some());
        assert!(snapshot.frozen_request.is_some());
        snapshot.validate_durable().expect("durable snapshot");
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
    fn tiered_settlement_reuses_frozen_request_without_live_probe() {
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
        assert_eq!(result.matched_tier, "fast");
        assert_eq!(result.actual_quota_after_group, Quota(7_000));
        assert!(!result.crossed_tier);
    }

    #[test]
    fn tiered_settlement_reuses_frozen_time() {
        let expr = r#"hour("UTC") == 0 ? tier("midnight", p * 2) : tier("day", p * 9)"#;
        let snapshot = estimate_tiered_billing_snapshot_with_request_at(
            "time-test",
            expr,
            params(1_000.0, 0.0),
            1.0,
            RequestInput::default(),
            0,
        )
        .expect("snapshot should build");

        assert_eq!(snapshot.estimated_tier, "midnight");
        assert_eq!(snapshot.evaluation_time_unix_seconds, Some(0));
        let result = compute_tiered_quota(&snapshot, params(2_000.0, 0.0))
            .expect("settlement should use the reservation instant");
        assert_eq!(result.matched_tier, "midnight");
        assert_eq!(result.actual_expression_cost, 4_000.0);
    }

    #[test]
    fn durable_snapshot_round_trip_settles_without_external_context() {
        let request = RequestInput::from_json_body(json!({"service_tier": "fast"}));
        let snapshot = estimate_tiered_billing_snapshot_with_request_at(
            "roundtrip-test",
            PROBE_EXPR,
            params(1_000.0, 500.0),
            1.0,
            request,
            1_700_000_000,
        )
        .expect("snapshot should build");
        let json = serde_json::to_string(&snapshot).expect("snapshot should serialize");
        let restored: TieredBillingSnapshot =
            serde_json::from_str(&json).expect("snapshot should deserialize");

        let result =
            compute_tiered_quota_from_durable_snapshot(&restored, params(2_000.0, 1_000.0))
                .expect("restored snapshot should settle");
        assert_eq!(result.matched_tier, "fast");
        assert_eq!(result.actual_quota_after_group, Quota(14_000));
    }

    #[test]
    fn strict_settlement_rejects_legacy_incomplete_snapshot() {
        let mut snapshot =
            estimate_tiered_billing_snapshot("legacy-test", FLAT_EXPR, params(1_000.0, 500.0), 1.0)
                .expect("snapshot should build");
        snapshot.evaluation_time_unix_seconds = None;
        assert!(
            compute_tiered_quota_from_durable_snapshot(&snapshot, params(1_000.0, 500.0),).is_err()
        );

        snapshot.evaluation_time_unix_seconds = Some(1_700_000_000);
        snapshot.frozen_request = None;
        assert!(
            compute_tiered_quota_from_durable_snapshot(&snapshot, params(1_000.0, 500.0),).is_err()
        );

        snapshot.frozen_request = Some(Default::default());
        snapshot.evaluation_time_unix_seconds = Some(i64::MAX);
        assert!(
            compute_tiered_quota_from_durable_snapshot(&snapshot, params(1_000.0, 500.0),).is_err()
        );

        let error = estimate_tiered_billing_snapshot_with_request_at(
            "invalid-time-test",
            FLAT_EXPR,
            params(1_000.0, 500.0),
            1.0,
            RequestInput::default(),
            -1,
        )
        .expect_err("negative reservation clocks must fail before expression evaluation");
        assert!(error.to_string().contains("outside the durable range"));
    }

    #[test]
    fn durable_tiered_snapshot_rejects_sensitive_or_structured_request_facts() {
        let sensitive = RequestInput::default().with_headers(HashMap::from([(
            "authorization".to_string(),
            "Bearer secret".to_string(),
        )]));
        let error = estimate_tiered_billing_snapshot_with_request(
            "secret-test",
            r#"header("authorization") == "" ? p : p * 2"#,
            params(100.0, 0.0),
            1.0,
            sensitive,
        )
        .expect_err("credential-bearing facts must not enter the ledger");
        assert!(error.to_string().contains("sensitive header"));

        let structured =
            RequestInput::from_json_body(json!({"pricing_options": {"mode": "premium"}}));
        let error = estimate_tiered_billing_snapshot_with_request(
            "structured-test",
            r#"has(param("pricing_options"), "premium") ? p * 2 : p"#,
            params(100.0, 0.0),
            1.0,
            structured,
        )
        .expect_err("structured prompt data must not enter the ledger");
        assert!(error.to_string().contains("structured request path"));

        let scalar_prompt =
            RequestInput::from_json_body(json!({"messages": [{"content": "private"}]}));
        let error = estimate_tiered_billing_snapshot_with_request(
            "prompt-test",
            r#"param("messages.0.content") == "" ? p : p * 2"#,
            params(100.0, 0.0),
            1.0,
            scalar_prompt,
        )
        .expect_err("scalar prompt content must not enter the ledger");
        assert!(error.to_string().contains("sensitive request path"));

        let error = estimate_tiered_billing_snapshot_with_request_at(
            "dst-test",
            r#"hour("America/New_York") >= 9 ? p * 2 : p"#,
            params(100.0, 0.0),
            1.0,
            RequestInput::default(),
            1_700_000_000,
        )
        .expect_err("DST-dependent clocks require a versioned timezone engine");
        assert!(error.to_string().contains("durable billing clock"));
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
