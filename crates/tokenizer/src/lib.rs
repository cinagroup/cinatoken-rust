//! Char-class token estimator for relay preflight estimates and fallback
//! counting when the upstream provider does not return a `usage` block.
//!
//! Faithful per-rune port of Go `service/token_estimator.go::EstimateToken`
//! (the state machine + per-family multiplier tables). The Go gateway uses
//! real BPE tokenization only for GPT/o-series models (via `tiktoken-go`); for
//! Claude, Gemini, and all other models it falls back to this estimator. The
//! Rust port mirrors that behavior: every model family uses the estimator, and
//! a future native-server build can swap in `tiktoken` for OpenAI models (the
//! `core::bpe` primitive) without changing this crate's public API.
//!
//! ## Algorithm (matches Go exactly)
//!
//! Each rune is classified in order — space → CJK → emoji → latin/number →
//! math-symbol → `@` → url-delim → generic symbol — and the per-family weight
//! is added. A Latin↔Number type switch starts a new weighted token (so
//! `abc123` bills the word then the number). Newlines/tabs use the `Newline`
//! weight; other spaces use `Space`. The total is `ceil(sum) + base_pad`
//! (base_pad is 0 for all families).
//!
//! ## Accuracy
//!
//! Intentionally approximate (±20-30% vs real BPE) and used only when no
//! authoritative usage is available. Settlement always prefers the
//! provider-reported `usage`.

use std::collections::HashMap;

/// Per-family multipliers — faithful port of Go `multipliersMap`
/// (`service/token_estimator.go:36-46`). Every class Go weighs is present with
/// its exact value; do not add heuristic divisions or drop a class without
/// matching Go.
#[derive(Debug, Clone, Copy)]
struct FamilyMultipliers {
    word: f64,
    number: f64,
    cjk: f64,
    symbol: f64,
    math_symbol: f64,
    url_delim: f64,
    at_sign: f64,
    emoji: f64,
    newline: f64,
    space: f64,
    /// Base padding added after rounding (Go `BasePad`); 0 for all families.
    #[allow(dead_code)]
    base_pad: i64,
}

impl FamilyMultipliers {
    const fn openai() -> Self {
        Self {
            word: 1.02,
            number: 1.55,
            cjk: 0.85,
            symbol: 0.4,
            math_symbol: 2.68,
            url_delim: 1.0,
            at_sign: 2.0,
            emoji: 2.12,
            newline: 0.5,
            space: 0.42,
            base_pad: 0,
        }
    }

    const fn claude() -> Self {
        Self {
            word: 1.13,
            number: 1.63,
            cjk: 1.21,
            symbol: 0.4,
            math_symbol: 4.52,
            url_delim: 1.26,
            at_sign: 2.82,
            emoji: 2.6,
            newline: 0.89,
            space: 0.39,
            base_pad: 0,
        }
    }

    const fn gemini() -> Self {
        Self {
            word: 1.15,
            number: 2.8,
            cjk: 0.68,
            symbol: 0.38,
            math_symbol: 1.05,
            url_delim: 1.2,
            at_sign: 2.5,
            emoji: 1.08,
            newline: 1.15,
            space: 0.2,
            base_pad: 0,
        }
    }
}

/// Tokenizer family derived from the model name. Mirrors Go
/// `service/token_estimator.go::EstimateTokenByModel` dispatch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenizerFamily {
    OpenAI,
    Claude,
    Gemini,
}

/// Resolve the tokenizer family from a model name. Mirrors Go
/// `EstimateTokenByModel` dispatch: `gemini` substring → Gemini,
/// `claude` substring → Claude, everything else → OpenAI (the default).
pub fn family_for_model(model: &str) -> TokenizerFamily {
    let lower = model.to_ascii_lowercase();
    if lower.contains("gemini") {
        TokenizerFamily::Gemini
    } else if lower.contains("claude") {
        TokenizerFamily::Claude
    } else {
        TokenizerFamily::OpenAI
    }
}

/// Estimate the token count of `text` for the given `model`. This is the
/// primary entry point used by the relay preflight estimate and the
/// no-usage fallback path. Empty text → 0 (matches Go's `text == ""` guard).
pub fn estimate_tokens(model: &str, text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }
    let family = family_for_model(model);
    estimate_tokens_for_family(family, text)
}

/// Estimate the token count for a known family. Exposed so callers can
/// override the auto-detected family (rarely needed).
pub fn estimate_tokens_for_family(family: TokenizerFamily, text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }
    let multipliers = match family {
        TokenizerFamily::OpenAI => FamilyMultipliers::openai(),
        TokenizerFamily::Claude => FamilyMultipliers::claude(),
        TokenizerFamily::Gemini => FamilyMultipliers::gemini(),
    };
    let total = estimate_weighted(text, multipliers);
    // Go returns int(math.Ceil(count)) + BasePad; BasePad is 0, so ceil. The
    // public contract floors at 1 for any non-empty text (Go's caller guards
    // on text != ""). Empty was handled above.
    let ceil = total.ceil();
    if ceil < 1.0 {
        1
    } else {
        ceil as usize
    }
}

/// Word-type state for the Latin/Number transition logic, mirroring Go's
/// `currentWordType` (`None` / `Latin` / `Number`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WordType {
    None,
    Latin,
    Number,
}

/// Walk `text` rune-by-rune, classifying each in Go's exact order and summing
/// the per-family weight. Faithful port of Go `EstimateToken`'s inner loop
/// (`token_estimator.go:69-148`).
fn estimate_weighted(text: &str, m: FamilyMultipliers) -> f64 {
    let mut count = 0.0_f64;
    let mut current_word_type = WordType::None;

    for ch in text.chars() {
        // 1. Whitespace: newline/tab use Newline weight, other spaces use Space.
        if ch.is_whitespace() {
            current_word_type = WordType::None;
            if ch == '\n' || ch == '\t' {
                count += m.newline;
            } else {
                count += m.space;
            }
            continue;
        }
        // 2. CJK — billed per character.
        if is_cjk(ch) {
            current_word_type = WordType::None;
            count += m.cjk;
            continue;
        }
        // 3. Emoji — own weight.
        if is_emoji(ch) {
            current_word_type = WordType::None;
            count += m.emoji;
            continue;
        }
        // 4. Latin letter / number — a type switch (letter<->number) starts a
        // new weighted token; mid-token chars add nothing.
        if is_latin_or_number(ch) {
            let new_type = if ch.is_numeric() {
                WordType::Number
            } else {
                WordType::Latin
            };
            if current_word_type == WordType::None || current_word_type != new_type {
                count += if new_type == WordType::Number {
                    m.number
                } else {
                    m.word
                };
                current_word_type = new_type;
            }
            continue;
        }
        // 5. Punctuation / special — by type. Resets the word run.
        current_word_type = WordType::None;
        if is_math_symbol(ch) {
            count += m.math_symbol;
        } else if ch == '@' {
            count += m.at_sign;
        } else if is_url_delim(ch) {
            count += m.url_delim;
        } else {
            count += m.symbol;
        }
    }

    count
}

/// CJK check — port of Go `isCJK`: `unicode.Han` + Hiragana/Katakana
/// (0x3040-0x30FF) + Hangul (0xAC00-0xD7A3). Go's `unicode.Is(unicode.Han, r)`
/// covers the Han ideograph blocks; we list them explicitly.
fn is_cjk(c: char) -> bool {
    let cp = c as u32;
    // Hiragana / Katakana (Go's explicit 0x3040-0x30FF).
    (0x3040..=0x30FF).contains(&cp)
    // Hangul Syllables (Go's explicit 0xAC00-0xD7A3).
    || (0xAC00..=0xD7A3).contains(&cp)
    // unicode.Han equivalents (the ideograph blocks).
    || (0x3400..=0x4DBF).contains(&cp)   // CJK Unified Ideographs Extension A
    || (0x4E00..=0x9FFF).contains(&cp)   // CJK Unified Ideographs
    || (0xF900..=0xFAFF).contains(&cp)   // CJK Compatibility Ideographs
    || (0x20000..=0x2A6DF).contains(&cp) // Extension B
    || (0x2A700..=0x2B73F).contains(&cp) // Extension C
    || (0x2B740..=0x2B81F).contains(&cp) // Extension D
    || (0x2B820..=0x2CEAF).contains(&cp) // Extension E
}

/// Latin letter or number — port of Go `isLatinOrNumber`
/// (`unicode.IsLetter(r) || unicode.IsNumber(r)`). CJK/emoji are checked
/// first in the caller, so Han letters never reach here.
fn is_latin_or_number(c: char) -> bool {
    c.is_alphanumeric()
}

/// Emoji check — port of Go `isEmoji` ranges.
fn is_emoji(c: char) -> bool {
    let cp = c as u32;
    (0x1F300..=0x1F9FF).contains(&cp)
        || (0x2600..=0x26FF).contains(&cp)
        || (0x2700..=0x27BF).contains(&cp)
        || (0x1F600..=0x1F64F).contains(&cp)
        || (0x1F900..=0x1F9FF).contains(&cp)
        || (0x1FA00..=0x1FAFF).contains(&cp)
}

/// Math-symbol check — port of Go `isMathSymbol`: an explicit character set
/// plus the Mathematical Operators / Supplemental / Alphanumeric ranges.
fn is_math_symbol(c: char) -> bool {
    // The explicit set from Go (sub/superscripts, basic operators, Greek-ish).
    const MATH_CHARS: &[char] = &[
        '∑', '∫', '∂', '√', '∞', '≤', '≥', '≠', '≈', '±', '×', '÷', '∈', '∉', '∋', '∌', '⊂', '⊃',
        '⊆', '⊇', '∪', '∩', '∧', '∨', '¬', '∀', '∃', '∄', '∅', '∆', '∇', '∝', '∟', '∠', '∡', '∢',
        '°', '′', '″', '‴', '⁺', '⁻', '⁼', '⁽', '⁾', 'ⁿ', '₀', '₁', '₂', '₃', '₄', '₅', '₆', '₇',
        '₈', '₉', '₊', '₋', '₌', '₍', '₎', '²', '³', '¹', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹', '⁰',
    ];
    if MATH_CHARS.contains(&c) {
        return true;
    }
    let cp = c as u32;
    (0x2200..=0x22FF).contains(&cp) // Mathematical Operators
        || (0x2A00..=0x2AFF).contains(&cp) // Supplemental Mathematical Operators
        || (0x1D400..=0x1D7FF).contains(&cp) // Mathematical Alphanumeric Symbols
}

/// URL-delimiter check — port of Go `isURLDelim` (`/:?&=;#%`). NOTE: Go does
/// NOT include `@` here (it gets its own AtSign weight), nor `.-_~[]!`.
fn is_url_delim(c: char) -> bool {
    matches!(c, '/' | ':' | '?' | '&' | '=' | ';' | '#' | '%')
}

/// Collect model→family dispatch into a reusable map shape for callers that
/// batch-estimate multiple models. Currently trivial (substring match) but
/// kept here to document the contract.
#[allow(dead_code)]
pub fn family_dispatch_table() -> HashMap<&'static str, TokenizerFamily> {
    let mut map = HashMap::new();
    map.insert("gemini", TokenizerFamily::Gemini);
    map.insert("claude", TokenizerFamily::Claude);
    map.insert("gpt", TokenizerFamily::OpenAI);
    map.insert("o1", TokenizerFamily::OpenAI);
    map.insert("o3", TokenizerFamily::OpenAI);
    map
}

/// Estimated usage when an upstream response omits a `usage` block — a faithful
/// port of Go `service.ResponseText2Usage` plus the relay's `toolCount * 7`
/// completion bump. Completion tokens are the char-class heuristic estimate over
/// the accumulated response text (Go uses `EstimateTokenByModel` here, the
/// heuristic, for *all* models — not real tiktoken) plus 7 per tool call; total
/// is prompt + completion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EstimatedUsage {
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
}

/// See [`EstimatedUsage`]. `tool_count` is clamped at 0.
pub fn response_text_to_usage(
    model: &str,
    response_text: &str,
    prompt_tokens: i64,
    tool_count: i64,
) -> EstimatedUsage {
    let completion_tokens =
        estimate_tokens(model, response_text) as i64 + tool_count.max(0) * 7;
    EstimatedUsage {
        prompt_tokens,
        completion_tokens,
        total_tokens: prompt_tokens + completion_tokens,
    }
}

/// Go `service.ValidUsage`: an upstream usage block is "real" when it reports any
/// prompt **or** completion tokens. Note this is `prompt != 0 || completion != 0`
/// — NOT `total > 0` — so a usage that reports only prompt tokens is valid (the
/// relay should settle it, not refund as missing).
pub fn valid_usage(prompt_tokens: i64, completion_tokens: i64) -> bool {
    prompt_tokens != 0 || completion_tokens != 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn family_dispatch_matches_go() {
        assert_eq!(
            family_for_model("gemini-2.0-flash"),
            TokenizerFamily::Gemini
        );
        assert_eq!(
            family_for_model("claude-3-5-sonnet-20241022"),
            TokenizerFamily::Claude
        );
        assert_eq!(family_for_model("gpt-4o"), TokenizerFamily::OpenAI);
        assert_eq!(family_for_model("deepseek-chat"), TokenizerFamily::OpenAI);
        assert_eq!(family_for_model("unknown-model"), TokenizerFamily::OpenAI);
    }

    #[test]
    fn empty_text_is_zero() {
        assert_eq!(estimate_tokens("gpt-4o", ""), 0);
        // Whitespace-only is non-empty in Go's guard (text != ""); 3 spaces ×
        // Space 0.42 = 1.26 -> ceil 2 for OpenAI.
        assert_eq!(estimate_tokens("gpt-4o", "   "), 2);
    }

    #[test]
    fn pure_english_openai_weights_per_word() {
        // "Hello world" — two Latin words (Word=1.02 each) + space (0.42) =
        // 2.46 -> ceil 3.
        assert_eq!(estimate_tokens("gpt-4o", "Hello world"), 3);
    }

    #[test]
    fn pure_chinese_openai_is_per_char() {
        // 10 CJK chars × 0.85 = 8.5 -> ceil 9 for OpenAI.
        assert_eq!(estimate_tokens("gpt-4o", "你好世界你好世界你好"), 9);
    }

    #[test]
    fn claude_weights_cjk_higher_than_openai() {
        let text = "你好世界你好世界你好";
        let openai = estimate_tokens_for_family(TokenizerFamily::OpenAI, text);
        let claude = estimate_tokens_for_family(TokenizerFamily::Claude, text);
        assert!(
            claude > openai,
            "claude ({claude}) > openai ({openai}) for CJK"
        );
    }

    #[test]
    fn gemini_weights_numbers_higher() {
        let text = "1234567890";
        let openai = estimate_tokens_for_family(TokenizerFamily::OpenAI, text);
        let gemini = estimate_tokens_for_family(TokenizerFamily::Gemini, text);
        assert!(
            gemini > openai,
            "gemini ({gemini}) > openai ({openai}) for a number run"
        );
    }

    #[test]
    fn letter_number_switch_starts_new_token() {
        let word_only = estimate_tokens("gpt-4o", "abc");
        let with_digits = estimate_tokens("gpt-4o", "abc123");
        assert!(with_digits > word_only);
    }

    #[test]
    fn at_sign_uses_atsign_weight_not_url_delim() {
        // "a@b" = Latin '@'(AtSign) Latin = 1.02+2.0+1.02 = 4.04 -> ceil 5.
        assert_eq!(estimate_tokens("gpt-4o", "a@b"), 5);
    }

    #[test]
    fn math_symbol_weighted_high() {
        // "a+b" = 1.02 + 0.4(Symbol) + 1.02 = 2.44 -> ceil 3.
        assert_eq!(estimate_tokens("gpt-4o", "a+b"), 3);
        // "a∑b" = 1.02 + 2.68(MathSymbol) + 1.02 = 4.72 -> ceil 5.
        assert_eq!(estimate_tokens("gpt-4o", "a∑b"), 5);
    }

    #[test]
    fn newline_and_space_weighted_separately() {
        assert_eq!(estimate_tokens("gpt-4o", "a\nb"), 3); // 1.02+0.5+1.02=2.54
        assert_eq!(estimate_tokens("gpt-4o", "a b"), 3); // 1.02+0.42+1.02=2.46
                                                         // Newline counts more than space for Claude (0.89 vs 0.39) on a long run.
        let spaces = estimate_tokens("claude-3", "a    b");
        let newlines = estimate_tokens("claude-3", "a\n\n\n\nb");
        assert!(newlines > spaces, "{newlines} > {spaces}");
    }

    #[test]
    fn emoji_contributes_tokens() {
        let no_emoji = estimate_tokens("gpt-4o", "Hello");
        let with_emoji = estimate_tokens("gpt-4o", "Hello 🎉🚀");
        assert!(with_emoji > no_emoji);
        assert_eq!(with_emoji, 6); // 1.02+0.42+2.12+2.12=5.68 -> 6
    }

    #[test]
    fn url_delim_set_matches_go() {
        assert_eq!(estimate_tokens("gpt-4o", "a/b"), 4); // 1.02+1.0+1.02=3.04
        assert_eq!(estimate_tokens("gpt-4o", "a.b"), 3); // '.' is Symbol 0.4
    }

    #[test]
    fn mixed_text_produces_positive_count() {
        let n = estimate_tokens("gpt-4o", "Hello 世界! 123 🎉 https://example.com");
        assert!(n > 0, "got {n}");
    }

    #[test]
    fn longer_text_estimates_more_tokens() {
        let short = "Hello";
        let long = "Hello world this is a much longer sentence with many words";
        let short_n = estimate_tokens("gpt-4o", short);
        let long_n = estimate_tokens("gpt-4o", long);
        assert!(long_n > short_n, "long ({long_n}) > short ({short_n})");
    }

    #[test]
    fn estimate_is_deterministic() {
        let text = "The quick brown fox 你好世界 12345";
        assert_eq!(
            estimate_tokens("claude-3-5-sonnet", text),
            estimate_tokens("claude-3-5-sonnet", text)
        );
    }

    #[test]
    fn golden_fixtures_match_go_estimate_token() {
        // Ground truth generated by running Go `service.EstimateTokenByModel`
        // (service/token_estimator.go) over this exact corpus — see
        // scratchpad fixturegen. Each tuple is (model, text, go_tokens). The
        // corpus exercises every classification branch (space/newline, CJK,
        // emoji, latin/number switch, @, math symbol, url delim, accented
        // latin, Greek letters, superscript-digit-as-number) across the
        // OpenAI / Claude / Gemini families and the OpenAI default fallback.
        let cases: &[(&str, &str, usize)] = &[
            ("gpt-4o", "", 0),
            ("gpt-4o", "   ", 2),
            ("gpt-4o", "Hello world", 3),
            ("gpt-4o", "你好世界你好世界你好", 9),
            ("gpt-4o", "1234567890", 2),
            ("gpt-4o", "abc123", 3),
            ("gpt-4o", "a@b", 5),
            ("gpt-4o", "a+b", 3),
            ("gpt-4o", "a∑b", 5),
            ("gpt-4o", "a\nb", 3),
            ("gpt-4o", "Hello 🎉🚀", 6),
            ("gpt-4o", "https://example.com/path?q=1&x=2", 18),
            ("gpt-4o", "Hello 世界! 123 🎉 https://example.com", 15),
            ("gpt-4o", "The quick brown fox jumps over the lazy dog", 13),
            ("gpt-4o", "café résumé naïve", 4),
            ("gpt-4o", "email me at user@example.com please", 12),
            ("gpt-4o", "result := compute(x, y)", 9),
            ("claude-3-5-sonnet", "Hello world", 3),
            ("claude-3-5-sonnet", "你好世界你好世界你好", 13),
            ("claude-3-5-sonnet", "a\n\n\n\nb", 6),
            ("claude-3-5-sonnet", "The quick brown fox 你好世界 12345 🎉", 16),
            ("claude-3", "α β γ δ ε", 8),
            ("gemini-2.0-flash", "1234567890", 3),
            ("gemini-2.0-flash", "Hello world", 3),
            ("gemini-2.0-flash", "你好世界", 3),
            ("gemini-2.0-flash", "The quick brown fox 你好世界 12345", 12),
            ("deepseek-chat", "Hello world", 3),
            ("o1-preview", "x = ∑ 1/i²", 12),
        ];
        for (model, text, expected) in cases {
            assert_eq!(
                estimate_tokens(model, text),
                *expected,
                "estimate_tokens({model:?}, {text:?}) diverged from Go EstimateTokenByModel"
            );
        }
    }

    #[test]
    fn valid_usage_checks_prompt_or_completion_not_total() {
        assert!(!valid_usage(0, 0));
        assert!(valid_usage(10, 0)); // prompt-only is valid (Go: prompt!=0)
        assert!(valid_usage(0, 5)); // completion-only is valid
        assert!(valid_usage(10, 5));
    }

    #[test]
    fn response_text_to_usage_estimates_completion_plus_tool_bump() {
        // "Hello world" estimates to 3 (two OpenAI words + space); +2*7 tools.
        let usage = response_text_to_usage("gpt-4o", "Hello world", 10, 2);
        assert_eq!(usage.completion_tokens, 3 + 14);
        assert_eq!(usage.prompt_tokens, 10);
        assert_eq!(usage.total_tokens, 10 + 17);
        // No text + no tools -> zero completion, total = prompt.
        let empty = response_text_to_usage("gpt-4o", "", 8, 0);
        assert_eq!(empty.completion_tokens, 0);
        assert_eq!(empty.total_tokens, 8);
        // Negative tool count is clamped to 0.
        assert_eq!(
            response_text_to_usage("gpt-4o", "", 0, -3).completion_tokens,
            0
        );
    }
}
