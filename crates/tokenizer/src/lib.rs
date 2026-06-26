//! Char-class token estimator for relay preflight estimates and fallback
//! counting when the upstream provider does not return a `usage` block.
//!
//! Ports the Go gateway's `service/token_estimator.go` character-class
//! state machine. The Go gateway uses real BPE tokenization only for
//! GPT/o-series models (via `tiktoken-go`); for Claude, Gemini, and all
//! other models it falls back to this estimator. The Rust port mirrors
//! that behavior: every model family uses the estimator, and a future
//! native-server build can swap in `tiktoken` for OpenAI models without
//! changing this crate's public API.
//!
//! ## Accuracy
//!
//! The estimator classifies each UnicodeGrapheme as CJK / Latin word /
//! Number / Emoji / MathSymbol / URLDelim / Space and sums per-family
//! weights. It is intentionally approximate (±20-30% vs real BPE) and is
//! only used when no authoritative usage is available. Settlement always
//! prefers the provider-reported `usage`.

use std::collections::HashMap;
use unicode_segmentation::UnicodeSegmentation;

/// Per-family multipliers. Mirrors Go `service/token_estimator.go`
/// `multipliersMap` (lines 36-46).
#[derive(Debug, Clone, Copy)]
struct FamilyMultipliers {
    word: f64,
    number: f64,
    cjk: f64,
    emoji: f64,
    math_symbol: f64,
    url_delim: f64,
    /// Space multiplier (Go uses 0.0 for all families; kept for parity but
    /// currently unused because whitespace runs are not separately weighed).
    #[allow(dead_code)]
    space: f64,
}

impl FamilyMultipliers {
    const fn openai() -> Self {
        Self {
            word: 1.02,
            number: 1.55,
            cjk: 0.85,
            emoji: 2.0,
            math_symbol: 1.0,
            url_delim: 1.0,
            space: 0.0,
        }
    }

    const fn claude() -> Self {
        Self {
            word: 1.13,
            number: 1.63,
            cjk: 1.21,
            emoji: 2.0,
            math_symbol: 1.0,
            url_delim: 1.0,
            space: 0.0,
        }
    }

    const fn gemini() -> Self {
        Self {
            word: 1.15,
            number: 2.8,
            cjk: 0.68,
            emoji: 2.0,
            math_symbol: 1.0,
            url_delim: 1.0,
            space: 0.0,
        }
    }
}

/// Tokenizer family derived from the model name. Mirrors Go
/// `service/token_estimator.go::EstimateToken` dispatch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenizerFamily {
    OpenAI,
    Claude,
    Gemini,
}

/// Resolve the tokenizer family from a model name. Mirrors Go
/// `EstimateToken(provider, text)` dispatch: `gemini` substring → Gemini,
/// `claude` substring → Claude, everything else → OpenAI.
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
/// no-usage fallback path.
pub fn estimate_tokens(model: &str, text: &str) -> usize {
    let family = family_for_model(model);
    estimate_tokens_for_family(family, text)
}

/// Estimate the token count for a known family. Exposed so callers can
/// override the auto-detected family (rarely needed).
pub fn estimate_tokens_for_family(family: TokenizerFamily, text: &str) -> usize {
    let multipliers = match family {
        TokenizerFamily::OpenAI => FamilyMultipliers::openai(),
        TokenizerFamily::Claude => FamilyMultipliers::claude(),
        TokenizerFamily::Gemini => FamilyMultipliers::gemini(),
    };
    let total = estimate_weighted(text, multipliers);
    // The Go estimator floors at 1 for any non-empty text.
    if text.chars().any(|c| !c.is_whitespace()) && total < 1.0 {
        1
    } else {
        total.round() as usize
    }
}

/// Walk the text's word boundaries, classify each token, and sum the
/// weighted contribution. Mirrors Go `EstimateToken`'s inner loop.
fn estimate_weighted(text: &str, m: FamilyMultipliers) -> f64 {
    let mut total = 0.0_f64;
    // Use Unicode word boundaries (handles CJK runs, latin words, numbers,
    // punctuation). This matches Go's `strings.FieldsFunc`-based tokenizer
    // semantics.
    for word in text.unicode_words() {
        total += classify_token(word, m);
    }
    // unicode_words skips whitespace runs; account for standalone
    // whitespace-separated non-word tokens (punctuation, symbols) via the
    // word-boundary iterator, which yields grapheme clusters we also need
    // to weigh. Walk UWordBounds to catch symbols unicode_words drops.
    for token in text.split_word_bounds() {
        let token = token.trim();
        if token.is_empty() {
            continue;
        }
        // If this token is entirely non-word (symbol/punct), unicode_words
        // skipped it; weigh it here as math_symbol / url_delim.
        if token.chars().all(|c| !c.is_alphanumeric()) {
            total += classify_symbol_token(token, m);
        }
    }
    total
}

/// Classify a single alphanumeric token (word or number run) and return its
/// weighted contribution. Mirrors Go's per-rune classification aggregated
/// per token.
fn classify_token(token: &str, m: FamilyMultipliers) -> f64 {
    let mut sum = 0.0_f64;
    let mut cjk_chars = 0usize;
    let mut word_chars = 0usize;
    let mut number_chars = 0usize;
    for ch in token.chars() {
        if is_cjk(ch) {
            cjk_chars += 1;
        } else if ch.is_ascii_digit() {
            number_chars += 1;
        } else if ch.is_alphanumeric() {
            word_chars += 1;
        } else if is_emoji(ch) {
            sum += m.emoji;
        } else if is_math_symbol(ch) {
            sum += m.math_symbol;
        }
    }
    // Aggregate word/number/cjk at the token level to mirror Go's behavior
    // where the weight is applied per-character-class-run.
    if cjk_chars > 0 {
        sum += (cjk_chars as f64) * m.cjk;
    }
    if word_chars > 0 {
        // Latin/Cyrillic/etc. word: weight by characters, then divide by ~4
        // to approximate subword token count (Go applies word weight per
        // rune but a "word" token averages ~4 chars per subword).
        sum += ((word_chars as f64) * m.word) / 4.0;
    }
    if number_chars > 0 {
        // Numbers: Go weights per-digit but digits cluster ~3 per token.
        sum += ((number_chars as f64) * m.number) / 3.0;
    }
    sum
}

/// Classify a non-alphanumeric token (pure punctuation/symbol run).
fn classify_symbol_token(token: &str, m: FamilyMultipliers) -> f64 {
    let chars: Vec<char> = token.chars().collect();
    let mut sum = 0.0_f64;
    for ch in chars {
        if is_emoji(ch) {
            sum += m.emoji;
        } else if is_math_symbol(ch) {
            sum += m.math_symbol;
        } else if is_url_delim(ch) {
            sum += m.url_delim;
        } else {
            // Generic punctuation contributes ~1 token per cluster.
            sum += 1.0;
        }
    }
    sum
}

fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x3000..=0x303F |   // CJK symbols and punctuation
        0x3040..=0x309F |   // Hiragana
        0x30A0..=0x30FF |   // Katakana
        0x3400..=0x4DBF |   // CJK Unified Ideographs Extension A
        0x4E00..=0x9FFF |   // CJK Unified Ideographs
        0xF900..=0xFAFF |   // CJK Compatibility Ideographs
        0xFF00..=0xFFEF |   // Halfwidth and Fullwidth Forms
        0x20000..=0x2A6DF | // Extension B
        0x2A700..=0x2B73F | // Extension C
        0x2B740..=0x2B81F | // Extension D
        0x2B820..=0x2CEAF   // Extension E
    )
}

fn is_emoji(c: char) -> bool {
    matches!(c as u32,
        0x1F300..=0x1F9FF |
        0x1FA00..=0x1FAFF |
        0x2600..=0x26FF |
        0x2700..=0x27BF |
        0xFE00..=0xFE0F |
        0x1F000..=0x1F02F
    )
}

fn is_math_symbol(c: char) -> bool {
    matches!(c as u32, 0x2200..=0x22FF | 0x27C0..=0x27EF | 0x2980..=0x29FF | 0x2A00..=0x2AFF)
}

fn is_url_delim(c: char) -> bool {
    matches!(
        c,
        '/' | ':' | '.' | '-' | '_' | '~' | '?' | '#' | '[' | ']' | '@' | '!'
    )
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
        assert_eq!(estimate_tokens("gpt-4o", "   "), 0);
    }

    #[test]
    fn pure_english_openai_is_reasonable() {
        // "Hello world" ~ 2 tokens; estimator should be in the 1-3 range.
        let n = estimate_tokens("gpt-4o", "Hello world");
        assert!(n >= 1 && n <= 4, "got {n}");
    }

    #[test]
    fn pure_chinese_openai_is_reasonable() {
        // 10 CJK chars × 0.85 ≈ 9 tokens for OpenAI.
        let n = estimate_tokens("gpt-4o", "你好世界你好世界你好");
        assert!(n >= 6 && n <= 12, "got {n}");
    }

    #[test]
    fn claude_weights_cjk_higher_than_openai() {
        // Same CJK text: Claude weight 1.21 > OpenAI 0.85, so Claude should
        // estimate more tokens.
        let text = "你好世界你好世界你好";
        let openai = estimate_tokens_for_family(TokenizerFamily::OpenAI, text);
        let claude = estimate_tokens_for_family(TokenizerFamily::Claude, text);
        assert!(
            claude > openai,
            "claude ({claude}) should exceed openai ({openai}) for CJK"
        );
    }

    #[test]
    fn gemini_weights_numbers_higher() {
        // "1234567890" — Gemini number weight 2.8 vs OpenAI 1.55.
        let text = "12345678901234567890";
        let openai = estimate_tokens_for_family(TokenizerFamily::OpenAI, text);
        let gemini = estimate_tokens_for_family(TokenizerFamily::Gemini, text);
        assert!(
            gemini > openai,
            "gemini ({gemini}) should exceed openai ({openai}) for numbers"
        );
    }

    #[test]
    fn mixed_text_produces_positive_count() {
        let text = "Hello 世界! 123 🎉 https://example.com";
        let n = estimate_tokens("gpt-4o", text);
        assert!(n > 0, "got {n}");
    }

    #[test]
    fn longer_text_estimates_more_tokens() {
        let short = "Hello";
        let long = "Hello world this is a much longer sentence with many words";
        let short_n = estimate_tokens("gpt-4o", short);
        let long_n = estimate_tokens("gpt-4o", long);
        assert!(
            long_n > short_n,
            "long ({long_n}) should exceed short ({short_n})"
        );
    }

    #[test]
    fn emoji_contributes_tokens() {
        let no_emoji = estimate_tokens("gpt-4o", "Hello");
        let with_emoji = estimate_tokens("gpt-4o", "Hello 🎉🚀");
        assert!(with_emoji > no_emoji);
    }

    #[test]
    fn estimate_is_deterministic() {
        let text = "The quick brown fox 你好世界 12345";
        let a = estimate_tokens("claude-3-5-sonnet", text);
        let b = estimate_tokens("claude-3-5-sonnet", text);
        assert_eq!(a, b);
    }
}
