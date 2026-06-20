use std::collections::HashMap;

use cinatoken_billing::{
    build_tiered_token_params, detect_billing_expr_variables, expression_cost_to_quota,
    run_billing_expr, run_billing_expr_with_request, BillingExprVariables, Quota, RequestInput,
    TieredTokenUsage, TokenParams, DEFAULT_QUOTA_PER_UNIT,
};
use serde_json::json;

fn assert_close(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 1e-6,
        "actual={actual}, expected={expected}"
    );
}

#[test]
fn go_glm_multicondition_expression_with_division() {
    let expr = r#"
        (
            p < 32000 && c < 200 ? tier("tier1_short", p * 2 + c * 8) :
            p < 32000 && c >= 200 ? tier("tier2_long_output", p * 3 + c * 14) :
            tier("tier3_long_input", p * 4 + c * 16)
        ) / 1000000
    "#;

    let tier1 = run_billing_expr(
        expr,
        TokenParams {
            p: 15_000.0,
            c: 100.0,
            ..TokenParams::default()
        },
    )
    .expect("tier1 should run");
    assert_close(tier1.cost, (15_000.0 * 2.0 + 100.0 * 8.0) / 1_000_000.0);
    assert_eq!(tier1.trace.matched_tier, "tier1_short");

    let tier2 = run_billing_expr(
        expr,
        TokenParams {
            p: 15_000.0,
            c: 500.0,
            ..TokenParams::default()
        },
    )
    .expect("tier2 should run");
    assert_close(tier2.cost, (15_000.0 * 3.0 + 500.0 * 14.0) / 1_000_000.0);
    assert_eq!(tier2.trace.matched_tier, "tier2_long_output");

    let tier3 = run_billing_expr(
        expr,
        TokenParams {
            p: 50_000.0,
            c: 100.0,
            ..TokenParams::default()
        },
    )
    .expect("tier3 should run");
    assert_close(tier3.cost, (50_000.0 * 4.0 + 100.0 * 16.0) / 1_000_000.0);
    assert_eq!(tier3.trace.matched_tier, "tier3_long_input");
}

#[test]
fn go_claude_cache_split_and_legacy_expression_parity() {
    let cache_split_expr =
        r#"tier("default", p * 1.5 + c * 7.5 + cr * 0.15 + cc * 2.0 + cc1h * 3.0)"#;
    let cache_split = run_billing_expr(
        cache_split_expr,
        TokenParams {
            p: 100_000.0,
            c: 5_000.0,
            cr: 10_000.0,
            cc: 5_000.0,
            cc1h: 2_000.0,
            ..TokenParams::default()
        },
    )
    .expect("cache split expression should run");
    assert_close(
        cache_split.cost,
        100_000.0 * 1.5 + 5_000.0 * 7.5 + 10_000.0 * 0.15 + 5_000.0 * 2.0 + 2_000.0 * 3.0,
    );
    assert_eq!(cache_split.trace.matched_tier, "default");

    let legacy_expr = r#"p <= 200000 ? tier("standard", p * 1.5 + c * 7.5) : tier("long_context", p * 3.0 + c * 11.25)"#;
    let legacy = run_billing_expr(
        legacy_expr,
        TokenParams {
            p: 100_000.0,
            c: 5_000.0,
            cr: 99_999.0,
            cc: 88_888.0,
            ..TokenParams::default()
        },
    )
    .expect("legacy expression should ignore unused cache fields");
    assert_close(legacy.cost, 100_000.0 * 1.5 + 5_000.0 * 7.5);
    assert_eq!(legacy.trace.matched_tier, "standard");
}

#[test]
fn go_len_tier_condition_uses_raw_context_after_cache_subtraction() {
    let expr = r#"len <= 200000 ? tier("standard", p * 3 + c * 15 + cr * 0.3) : tier("long_context", p * 6 + c * 22.5 + cr * 0.6)"#;
    let usage = TieredTokenUsage {
        prompt_tokens: 300_000,
        completion_tokens: 5_000,
        cached_tokens: 250_000,
        ..TieredTokenUsage::default()
    };
    let params = build_tiered_token_params(usage, false, detect_billing_expr_variables(expr));

    assert_eq!(params.len, 300_000.0);
    assert_eq!(params.p, 50_000.0);
    assert_eq!(params.cr, 250_000.0);

    let run = run_billing_expr(expr, params).expect("len tier expression should run");
    assert_eq!(run.trace.matched_tier, "long_context");
    assert_close(run.cost, 50_000.0 * 6.0 + 5_000.0 * 22.5 + 250_000.0 * 0.6);
}

#[test]
fn go_ratio_equivalent_tiered_quota_parity() {
    let expr = r#"tier("base", p * 2.5 + c * 15 + cr * 0.25)"#;
    let usage = TieredTokenUsage {
        prompt_tokens: 10_000,
        completion_tokens: 2_000,
        cached_tokens: 3_000,
        ..TieredTokenUsage::default()
    };
    let params = build_tiered_token_params(usage, false, detect_billing_expr_variables(expr));
    let run = run_billing_expr(expr, params).expect("ratio parity expression should run");

    assert_close(run.cost, 7_000.0 * 2.5 + 2_000.0 * 15.0 + 3_000.0 * 0.25);
    assert_eq!(
        expression_cost_to_quota(run.cost, DEFAULT_QUOTA_PER_UNIT, 1.0),
        Quota(24_125)
    );
    assert_eq!(
        expression_cost_to_quota(run.cost, DEFAULT_QUOTA_PER_UNIT, 1.5),
        Quota(36_188)
    );
}

#[test]
fn go_request_probe_multiple_rules_multiply() {
    let request = RequestInput::from_json_body(json!({"service_tier": "fast"})).with_headers(
        HashMap::from([(
            "Anthropic-Beta".to_string(),
            "fast-mode-2026-02-01".to_string(),
        )]),
    );

    let run = run_billing_expr_with_request(
        r#"(param("service_tier") == "fast" ? 2 : 1) * (has(header("anthropic-beta"), "fast-mode-2026-02-01") ? 2.5 : 1)"#,
        TokenParams::default(),
        request,
    )
    .expect("request probe expression should run");

    assert_close(run.cost, 5.0);
}

#[test]
fn go_time_helpers_accept_common_frontend_timezones() {
    let expr = r#"
        tier("default", p)
        * (hour("America/New_York") >= 0 && hour("America/New_York") < 24 ? 1 : 999)
        * (hour("America/Los_Angeles") >= 0 && hour("America/Los_Angeles") < 24 ? 1 : 999)
        * (hour("America/Chicago") >= 0 && hour("America/Chicago") < 24 ? 1 : 999)
        * (hour("Europe/London") >= 0 && hour("Europe/London") < 24 ? 1 : 999)
        * (hour("Europe/Berlin") >= 0 && hour("Europe/Berlin") < 24 ? 1 : 999)
        * (hour("Asia/Tokyo") >= 0 && hour("Asia/Tokyo") < 24 ? 1 : 999)
        * (hour("Asia/Seoul") >= 0 && hour("Asia/Seoul") < 24 ? 1 : 999)
        * (hour("Australia/Sydney") >= 0 && hour("Australia/Sydney") < 24 ? 1 : 999)
        * (minute("UTC") >= 0 && minute("UTC") < 60 ? 1 : 999)
        * (weekday("UTC") >= 0 && weekday("UTC") <= 6 ? 1 : 999)
        * (month("Asia/Shanghai") >= 1 && month("Asia/Shanghai") <= 12 ? 1 : 999)
        * (day("Asia/Shanghai") >= 1 && day("Asia/Shanghai") <= 31 ? 1 : 999)
    "#;

    let run = run_billing_expr(
        expr,
        TokenParams {
            p: 500.0,
            ..TokenParams::default()
        },
    )
    .expect("common timezone expression should run");

    assert_close(run.cost, 500.0);
    assert_eq!(run.trace.matched_tier, "default");
}

#[test]
fn go_used_vars_parity_for_token_normalization() {
    let vars = detect_billing_expr_variables(
        r#"tier("base", p * 2.5 + c * 15 + cr * 0.25 + img * 2 + ao * 50)"#,
    );
    assert_eq!(
        vars,
        BillingExprVariables {
            p: true,
            c: true,
            cr: true,
            img: true,
            ao: true,
            ..BillingExprVariables::default()
        }
    );
}
