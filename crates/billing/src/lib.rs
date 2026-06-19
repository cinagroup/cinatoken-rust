use serde::{Deserialize, Serialize};

mod expression;
mod tiered;

pub use expression::{
    run_billing_expr, run_billing_expr_with_request, BillingExprError, ExprRun, RequestInput,
    TraceResult,
};
pub use tiered::{
    compute_tiered_quota, compute_tiered_quota_with_request, estimate_tiered_billing_snapshot,
    estimate_tiered_billing_snapshot_with_request, TieredBillingResult, TieredBillingSnapshot,
};

pub const DEFAULT_QUOTA_PER_UNIT: f64 = 500_000.0;
pub const DEFAULT_EXPR_VERSION: u32 = 1;

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

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct TokenParams {
    pub p: f64,
    pub c: f64,
    pub len: f64,
    pub cr: f64,
    pub cc: f64,
    pub cc1h: f64,
    pub img: f64,
    pub img_o: f64,
    pub ai: f64,
    pub ao: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum UsageSemantic {
    #[default]
    OpenAi,
    Anthropic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct TieredTokenUsage {
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub cached_tokens: i64,
    pub cache_creation_tokens: i64,
    pub claude_cache_creation_5m_tokens: i64,
    pub claude_cache_creation_1h_tokens: i64,
    pub image_input_tokens: i64,
    pub image_output_tokens: i64,
    pub audio_input_tokens: i64,
    pub audio_output_tokens: i64,
    pub usage_semantic: UsageSemantic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct BillingExprVariables {
    pub p: bool,
    pub c: bool,
    pub len: bool,
    pub cr: bool,
    pub cc: bool,
    pub cc1h: bool,
    pub img: bool,
    pub img_o: bool,
    pub ai: bool,
    pub ao: bool,
}

impl BillingExprVariables {
    pub fn contains(self, name: &str) -> bool {
        match name {
            "p" => self.p,
            "c" => self.c,
            "len" => self.len,
            "cr" => self.cr,
            "cc" => self.cc,
            "cc1h" => self.cc1h,
            "img" => self.img,
            "img_o" => self.img_o,
            "ai" => self.ai,
            "ao" => self.ao,
            _ => false,
        }
    }

    fn mark(&mut self, name: &str) {
        match name {
            "p" => self.p = true,
            "c" => self.c = true,
            "len" => self.len = true,
            "cr" => self.cr = true,
            "cc" => self.cc = true,
            "cc1h" => self.cc1h = true,
            "img" => self.img = true,
            "img_o" => self.img_o = true,
            "ai" => self.ai = true,
            "ao" => self.ao = true,
            _ => {}
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BillingExprParts {
    pub billing_expr: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_rule_expr: Option<String>,
}

pub fn split_billing_expr_request_rule(expr: &str) -> BillingExprParts {
    let (billing_expr, request_rule_expr) = split_billing_expr_request_rule_slices(expr);
    BillingExprParts {
        billing_expr: billing_expr.to_string(),
        request_rule_expr: request_rule_expr.map(str::to_string),
    }
}

pub fn parse_expr_version(expr: &str) -> (u32, &str) {
    let (expr, _) = split_billing_expr_request_rule_slices(expr);
    if let Some(body) = expr.strip_prefix("v1:") {
        (1, body)
    } else {
        (DEFAULT_EXPR_VERSION, expr)
    }
}

fn split_billing_expr_request_rule_slices(expr: &str) -> (&str, Option<&str>) {
    let expr = expr.trim();
    let Some(index) = find_request_rule_separator(expr) else {
        return (expr, None);
    };
    let billing_expr = expr[..index].trim();
    let request_rule_expr = expr[index + 3..].trim();
    (
        billing_expr,
        (!request_rule_expr.is_empty()).then_some(request_rule_expr),
    )
}

fn find_request_rule_separator(expr: &str) -> Option<usize> {
    let bytes = expr.as_bytes();
    let mut index = 0;
    let mut quote = None;
    let mut raw_quote = false;

    while index < bytes.len() {
        let byte = bytes[index];
        if let Some(quote_byte) = quote {
            if !raw_quote && byte == b'\\' {
                index = (index + 2).min(bytes.len());
                continue;
            }
            if byte == quote_byte {
                quote = None;
                raw_quote = false;
            }
            index += 1;
            continue;
        }

        match byte {
            b'\'' | b'"' => quote = Some(byte),
            b'`' => {
                quote = Some(byte);
                raw_quote = true;
            }
            b'|' if bytes[index..].starts_with(b"|||") => return Some(index),
            _ => {}
        }
        index += 1;
    }

    None
}

pub fn detect_billing_expr_variables(expr: &str) -> BillingExprVariables {
    let (_, body) = parse_expr_version(expr);
    let bytes = body.as_bytes();
    let mut vars = BillingExprVariables::default();
    let mut index = 0;

    while index < bytes.len() {
        let byte = bytes[index];
        if byte == b'"' || byte == b'\'' {
            index = skip_quoted(bytes, index, byte);
            continue;
        }
        if byte == b'`' {
            index = skip_raw_quoted(bytes, index);
            continue;
        }
        if is_identifier_start(byte) {
            let start = index;
            index += 1;
            while index < bytes.len() && is_identifier_continue(bytes[index]) {
                index += 1;
            }
            if let Some(identifier) = body.get(start..index) {
                vars.mark(identifier);
            }
            continue;
        }
        index += 1;
    }

    vars
}

pub fn build_tiered_token_params(
    usage: TieredTokenUsage,
    is_claude_usage_semantic: bool,
    used_vars: BillingExprVariables,
) -> TokenParams {
    let mut p = usage.prompt_tokens as f64;
    let mut c = usage.completion_tokens as f64;
    let cr = usage.cached_tokens as f64;
    let img = usage.image_input_tokens as f64;
    let ai = usage.audio_input_tokens as f64;
    let img_o = usage.image_output_tokens as f64;
    let ao = usage.audio_output_tokens as f64;

    let (cc, cc1h) = if usage.usage_semantic == UsageSemantic::Anthropic {
        (
            usage.claude_cache_creation_5m_tokens as f64,
            usage.claude_cache_creation_1h_tokens as f64,
        )
    } else {
        (usage.cache_creation_tokens as f64, 0.0)
    };

    let len = if is_claude_usage_semantic {
        p + cr + cc + cc1h
    } else {
        p
    };

    if !is_claude_usage_semantic {
        if used_vars.cr {
            p -= cr;
        }
        if used_vars.cc {
            p -= cc;
        }
        if used_vars.cc1h {
            p -= cc1h;
        }
        if used_vars.img {
            p -= img;
        }
        if used_vars.ai {
            p -= ai;
        }
        if used_vars.img_o {
            c -= img_o;
        }
        if used_vars.ao {
            c -= ao;
        }
    }

    TokenParams {
        p: p.max(0.0),
        c: c.max(0.0),
        len,
        cr,
        cc,
        cc1h,
        img,
        img_o,
        ai,
        ao,
    }
}

fn skip_quoted(bytes: &[u8], mut index: usize, quote: u8) -> usize {
    index += 1;
    while index < bytes.len() {
        if bytes[index] == b'\\' {
            index = (index + 2).min(bytes.len());
            continue;
        }
        if bytes[index] == quote {
            return index + 1;
        }
        index += 1;
    }
    index
}

fn skip_raw_quoted(bytes: &[u8], mut index: usize) -> usize {
    index += 1;
    while index < bytes.len() {
        if bytes[index] == b'`' {
            return index + 1;
        }
        index += 1;
    }
    index
}

fn is_identifier_start(byte: u8) -> bool {
    byte.is_ascii_alphabetic() || byte == b'_'
}

fn is_identifier_continue(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
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
    fn split_billing_expr_request_rule_handles_separator_and_quotes() {
        assert_eq!(
            split_billing_expr_request_rule(r#" tier("base", p) ||| (header("x") != "" ? 2 : 1) "#),
            BillingExprParts {
                billing_expr: r#"tier("base", p)"#.to_string(),
                request_rule_expr: Some(r#"(header("x") != "" ? 2 : 1)"#.to_string()),
            }
        );
        assert_eq!(
            split_billing_expr_request_rule(r#"tier("base|||name", p) ||| "#),
            BillingExprParts {
                billing_expr: r#"tier("base|||name", p)"#.to_string(),
                request_rule_expr: None,
            }
        );
        assert_eq!(
            split_billing_expr_request_rule(r#"`|||` == "x" ? p : c"#),
            BillingExprParts {
                billing_expr: r#"`|||` == "x" ? p : c"#.to_string(),
                request_rule_expr: None,
            }
        );
    }

    #[test]
    fn parse_expr_version_accepts_v1_prefix_and_defaults_to_v1() {
        assert_eq!(
            parse_expr_version("v1:tier(\"base\", p)"),
            (1, "tier(\"base\", p)")
        );
        assert_eq!(
            parse_expr_version(" tier(\"base\", p) "),
            (DEFAULT_EXPR_VERSION, "tier(\"base\", p)")
        );
        assert_eq!(
            parse_expr_version(r#"v1:tier("base", p)|||(header("x") != "" ? 2 : 1)"#),
            (1, r#"tier("base", p)"#)
        );
    }

    #[test]
    fn detect_billing_expr_variables_finds_known_identifiers_only() {
        let vars = detect_billing_expr_variables(
            r#"v1:tier("cr is a tier name", p * 2 + c * 10 + cr * 0.2 + img_o * 3 + ao)"#,
        );

        assert!(vars.p);
        assert!(vars.c);
        assert!(vars.cr);
        assert!(vars.img_o);
        assert!(vars.ao);
        assert!(!vars.cc);
        assert!(!vars.img);
        assert!(!vars.contains("tier"));
    }

    #[test]
    fn detect_billing_expr_variables_ignores_strings_and_partial_names() {
        let vars = detect_billing_expr_variables(
            r#"param("messages.#.cr") == "img" ? tier("audio ao", crunch * 2) : p"#,
        );

        assert!(vars.p);
        assert!(!vars.cr);
        assert!(!vars.img);
        assert!(!vars.ao);
    }

    #[test]
    fn detect_billing_expr_variables_ignores_request_rules_after_separator() {
        let vars = detect_billing_expr_variables(
            r#"tier("base", p * 2 + c * 10)|||(param("use_cache") == true ? cr : 1)"#,
        );

        assert!(vars.p);
        assert!(vars.c);
        assert!(!vars.cr);
    }

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
    fn tiered_token_params_gpt_subtracts_cache_only_when_used() {
        let usage = TieredTokenUsage {
            prompt_tokens: 1_000,
            completion_tokens: 500,
            cached_tokens: 200,
            ..TieredTokenUsage::default()
        };

        let with_cache = build_tiered_token_params(
            usage,
            false,
            detect_billing_expr_variables(r#"tier("base", p * 2.5 + c * 15 + cr * 0.25)"#),
        );
        assert_eq!(with_cache.p, 800.0);
        assert_eq!(with_cache.c, 500.0);
        assert_eq!(with_cache.len, 1_000.0);
        assert_eq!(with_cache.cr, 200.0);

        let without_cache = build_tiered_token_params(
            usage,
            false,
            detect_billing_expr_variables(r#"tier("base", p * 2.5 + c * 15)"#),
        );
        assert_eq!(without_cache.p, 1_000.0);
        assert_eq!(without_cache.cr, 200.0);
    }

    #[test]
    fn tiered_token_params_gpt_subtracts_image_and_audio_when_used() {
        let usage = TieredTokenUsage {
            prompt_tokens: 1_000,
            completion_tokens: 600,
            image_input_tokens: 200,
            audio_input_tokens: 100,
            image_output_tokens: 50,
            audio_output_tokens: 75,
            ..TieredTokenUsage::default()
        };

        let params = build_tiered_token_params(
            usage,
            false,
            detect_billing_expr_variables(
                r#"tier("base", p * 2 + c * 10 + img * 2.5 + ai * 3 + img_o * 4 + ao * 5)"#,
            ),
        );

        assert_eq!(params.p, 700.0);
        assert_eq!(params.c, 475.0);
        assert_eq!(params.img, 200.0);
        assert_eq!(params.ai, 100.0);
        assert_eq!(params.img_o, 50.0);
        assert_eq!(params.ao, 75.0);
    }

    #[test]
    fn tiered_token_params_claude_keeps_text_tokens_and_expands_len() {
        let usage = TieredTokenUsage {
            prompt_tokens: 5_000,
            completion_tokens: 2_000,
            cached_tokens: 3_000,
            claude_cache_creation_5m_tokens: 1_000,
            claude_cache_creation_1h_tokens: 500,
            usage_semantic: UsageSemantic::Anthropic,
            ..TieredTokenUsage::default()
        };

        let params = build_tiered_token_params(
            usage,
            true,
            detect_billing_expr_variables(
                r#"tier("base", p * 3 + c * 15 + cr * 0.3 + cc * 3.75 + cc1h * 6)"#,
            ),
        );

        assert_eq!(params.p, 5_000.0);
        assert_eq!(params.c, 2_000.0);
        assert_eq!(params.len, 9_500.0);
        assert_eq!(params.cr, 3_000.0);
        assert_eq!(params.cc, 1_000.0);
        assert_eq!(params.cc1h, 500.0);
    }

    #[test]
    fn tiered_token_params_clamps_reduced_prompt_and_completion_to_zero() {
        let usage = TieredTokenUsage {
            prompt_tokens: 100,
            completion_tokens: 50,
            cached_tokens: 120,
            audio_output_tokens: 75,
            ..TieredTokenUsage::default()
        };

        let params = build_tiered_token_params(
            usage,
            false,
            detect_billing_expr_variables(r#"tier("base", p + cr + c + ao)"#),
        );

        assert_eq!(params.p, 0.0);
        assert_eq!(params.c, 0.0);
        assert_eq!(params.len, 100.0);
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
