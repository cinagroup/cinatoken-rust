use std::fmt::Write as _;

use serde::{Deserialize, Serialize};

mod expression;
mod flat;
mod pricing;
mod tiered;

pub use expression::{
    run_billing_expr, run_billing_expr_at, run_billing_expr_with_request,
    run_billing_expr_with_request_at, validate_billing_expr, BillingExprError, ExprRun,
    RequestInput, TraceResult,
};
pub use flat::{
    compute_flat_quota, compute_flat_quota_from_snapshot,
    compute_flat_quota_with_other_ratio_product, estimate_flat_pre_consumed_quota, FlatBillingMode,
    FlatPricingSnapshot, FlatQuotaResult, FlatUsage,
};
pub use pricing::PricingConfig;
pub use tiered::{
    compute_tiered_quota, compute_tiered_quota_with_request, estimate_tiered_billing_snapshot,
    estimate_tiered_billing_snapshot_with_request, rebase_tiered_billing_snapshot_group_ratio,
    TieredBillingResult, TieredBillingSnapshot,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BillingExprMetadata {
    pub expr_hash: String,
    pub expr_version: u32,
    pub billing_expr: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_rule_expr: Option<String>,
    pub used_vars: BillingExprVariables,
}

pub fn split_billing_expr_request_rule(expr: &str) -> BillingExprParts {
    let (billing_expr, request_rule_expr) = split_billing_expr_request_rule_slices(expr);
    BillingExprParts {
        billing_expr: billing_expr.to_string(),
        request_rule_expr: request_rule_expr.map(str::to_string),
    }
}

pub fn expr_hash_string(expr: &str) -> String {
    let digest = sha256_digest(expr.as_bytes());
    let mut output = String::with_capacity(64);
    for byte in digest {
        write!(&mut output, "{byte:02x}").expect("writing to a string cannot fail");
    }
    output
}

pub fn compile_billing_expr_metadata(expr: &str) -> Result<BillingExprMetadata, BillingExprError> {
    validate_billing_expr(expr)?;
    let parts = split_billing_expr_request_rule(expr);
    let (expr_version, _) = parse_expr_version(&parts.billing_expr);
    let used_vars = detect_billing_expr_variables(&parts.billing_expr);
    Ok(BillingExprMetadata {
        expr_hash: expr_hash_string(expr),
        expr_version,
        billing_expr: parts.billing_expr,
        request_rule_expr: parts.request_rule_expr,
        used_vars,
    })
}

const SHA256_INITIAL_STATE: [u32; 8] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

const SHA256_K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

fn sha256_digest(input: &[u8]) -> [u8; 32] {
    let mut state = SHA256_INITIAL_STATE;
    let mut chunks = input.chunks_exact(64);
    for chunk in &mut chunks {
        sha256_compress(&mut state, chunk);
    }

    let remainder = chunks.remainder();
    let bit_len = (input.len() as u64).wrapping_mul(8);
    let mut block = [0u8; 64];
    block[..remainder.len()].copy_from_slice(remainder);
    block[remainder.len()] = 0x80;

    if remainder.len() >= 56 {
        sha256_compress(&mut state, &block);
        block = [0u8; 64];
    }
    block[56..].copy_from_slice(&bit_len.to_be_bytes());
    sha256_compress(&mut state, &block);

    let mut digest = [0u8; 32];
    for (index, word) in state.iter().enumerate() {
        digest[index * 4..index * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    digest
}

fn sha256_compress(state: &mut [u32; 8], block: &[u8]) {
    let mut words = [0u32; 64];
    for (index, chunk) in block.chunks_exact(4).take(16).enumerate() {
        words[index] = u32::from_be_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
    }
    for index in 16..64 {
        let s0 = words[index - 15].rotate_right(7)
            ^ words[index - 15].rotate_right(18)
            ^ (words[index - 15] >> 3);
        let s1 = words[index - 2].rotate_right(17)
            ^ words[index - 2].rotate_right(19)
            ^ (words[index - 2] >> 10);
        words[index] = words[index - 16]
            .wrapping_add(s0)
            .wrapping_add(words[index - 7])
            .wrapping_add(s1);
    }

    let mut a = state[0];
    let mut b = state[1];
    let mut c = state[2];
    let mut d = state[3];
    let mut e = state[4];
    let mut f = state[5];
    let mut g = state[6];
    let mut h = state[7];

    for index in 0..64 {
        let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
        let ch = (e & f) ^ (!e & g);
        let temp1 = h
            .wrapping_add(s1)
            .wrapping_add(ch)
            .wrapping_add(SHA256_K[index])
            .wrapping_add(words[index]);
        let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
        let maj = (a & b) ^ (a & c) ^ (b & c);
        let temp2 = s0.wrapping_add(maj);

        h = g;
        g = f;
        f = e;
        e = d.wrapping_add(temp1);
        d = c;
        c = b;
        b = a;
        a = temp1.wrapping_add(temp2);
    }

    state[0] = state[0].wrapping_add(a);
    state[1] = state[1].wrapping_add(b);
    state[2] = state[2].wrapping_add(c);
    state[3] = state[3].wrapping_add(d);
    state[4] = state[4].wrapping_add(e);
    state[5] = state[5].wrapping_add(f);
    state[6] = state[6].wrapping_add(g);
    state[7] = state[7].wrapping_add(h);
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
    fn expr_hash_string_matches_sha256_hex_and_is_deterministic() {
        assert_eq!(
            expr_hash_string(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            expr_hash_string("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(expr_hash_string("p * 0.5"), expr_hash_string("p * 0.5"));
        assert_ne!(expr_hash_string("p * 0.5"), expr_hash_string("p * 0.6"));
    }

    #[test]
    fn compile_billing_expr_metadata_validates_and_reports_cache_fields() {
        let expr =
            r#"v1:tier("base", p * 2 + c * 10 + cr * 0.2)|||(param("use_cache") == true ? 2 : 1)"#;
        let metadata = compile_billing_expr_metadata(expr).expect("expression should validate");

        assert_eq!(metadata.expr_hash, expr_hash_string(expr));
        assert_eq!(metadata.expr_version, 1);
        assert_eq!(
            metadata.billing_expr,
            r#"v1:tier("base", p * 2 + c * 10 + cr * 0.2)"#
        );
        assert_eq!(
            metadata.request_rule_expr.as_deref(),
            Some(r#"(param("use_cache") == true ? 2 : 1)"#)
        );
        assert!(metadata.used_vars.p);
        assert!(metadata.used_vars.c);
        assert!(metadata.used_vars.cr);
        assert!(!metadata.used_vars.cc);
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
