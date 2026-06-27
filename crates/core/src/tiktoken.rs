//! Real tiktoken text token counting (cl100k_base) — the GPT pre-tokenizer plus
//! the byte-pair-encoding merge core (`crate::bpe`). Go uses `tiktoken-go` for
//! OpenAI text models (`service/token_counter.go::CountTextToken`); this is the
//! faithful Rust counterpart for the `cl100k_base` encoder. Parity target:
//! `docs/source-token-estimation-parity.md` (checklist #1).
//!
//! What stays the caller's responsibility (genuine I/O, per migration-plan
//! §21.7): loading the ~1.7 MB mergeable-rank table from KV/R2 — do not embed it
//! in the Worker bundle. `parse_mergeable_ranks` turns the standard `.tiktoken`
//! file text into the table this module consumes.
//!
//! ## Pre-tokenization
//!
//! tiktoken splits text with a regex before BPE. The published `cl100k_base`
//! pattern is:
//! ```text
//! (?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+
//! ```
//! The `\s+(?!\S)` alternative needs regex look-ahead, which the `regex` crate
//! lacks. Rather than pull in a look-ahead regex engine, this module reproduces
//! the regex's *ordered-alternative, leftmost-longest* semantics directly as a
//! scanner. `\p{L}`/`\p{N}`/`\p{M}` and the o200k upper/lower letter classes are
//! resolved from exact Unicode general categories
//! (`unicode-general-category`); `\s` uses `char::is_whitespace` (the Unicode
//! *White_Space* property, which equals regex `\s`).
//!
//! Two encoders are provided: `count_bpe_tokens_cl100k` (`cl100k_base`, GPT-4 /
//! 3.5 era) and `count_bpe_tokens_o200k` (`o200k_base`, gpt-4o / o-series). They
//! share the digit/punctuation/whitespace alternatives but differ in the word
//! rule: o200k splits letter runs on case transitions (camelCase) and attaches a
//! trailing contraction to the word, while cl100k treats a letter run as one
//! piece and emits contractions as their own piece.

use std::collections::HashMap;

use unicode_general_category::{get_general_category, GeneralCategory};

use crate::bpe::bpe_token_count;

/// Count the tokens `text` encodes to under the `cl100k_base` encoder, given the
/// mergeable-rank table. Pre-tokenizes, then BPE-merges each piece.
pub fn count_bpe_tokens_cl100k(text: &str, ranks: &HashMap<Vec<u8>, u32>) -> usize {
    pre_tokenize_cl100k(text)
        .iter()
        .map(|piece| bpe_token_count(piece.as_bytes(), ranks))
        .sum()
}

/// Count the tokens `text` encodes to under the `o200k_base` encoder (gpt-4o /
/// o-series), given the mergeable-rank table.
pub fn count_bpe_tokens_o200k(text: &str, ranks: &HashMap<Vec<u8>, u32>) -> usize {
    pre_tokenize_o200k(text)
        .iter()
        .map(|piece| bpe_token_count(piece.as_bytes(), ranks))
        .sum()
}

/// Parse a standard tiktoken `.tiktoken` mergeable-rank file: each non-empty
/// line is `<base64-encoded-token-bytes> <rank>`. Lines that do not parse are
/// skipped. The result maps token bytes to their BPE rank, ready for
/// `crate::bpe::bpe_token_count`.
pub fn parse_mergeable_ranks(data: &str) -> HashMap<Vec<u8>, u32> {
    let mut ranks = HashMap::new();
    for line in data.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split_whitespace();
        let (Some(token_b64), Some(rank_str), None) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let (Some(token), Ok(rank)) = (decode_base64_standard(token_b64), rank_str.parse::<u32>())
        else {
            continue;
        };
        ranks.insert(token, rank);
    }
    ranks
}

/// Split `text` into pre-token pieces per the `cl100k_base` regex (see module
/// docs). Exposed for testing; production callers use `count_bpe_tokens_cl100k`.
pub fn pre_tokenize_cl100k(text: &str) -> Vec<&str> {
    pre_tokenize_with(text, next_piece_char_len)
}

/// Split `text` into pre-token pieces per the `o200k_base` regex. Exposed for
/// testing; production callers use `count_bpe_tokens_o200k`.
pub fn pre_tokenize_o200k(text: &str) -> Vec<&str> {
    pre_tokenize_with(text, next_piece_char_len_o200k)
}

/// Run the pre-tokenization scan with the given per-encoder `next_len` rule.
fn pre_tokenize_with(text: &str, next_len: fn(&[char], usize) -> usize) -> Vec<&str> {
    let chars: Vec<char> = text.chars().collect();
    // Byte offset of each char boundary (len+1 entries; last == text.len()).
    let mut byte_at = Vec::with_capacity(chars.len() + 1);
    let mut offset = 0usize;
    for &ch in &chars {
        byte_at.push(offset);
        offset += ch.len_utf8();
    }
    byte_at.push(offset);

    let mut pieces = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let len = next_len(&chars, i);
        pieces.push(&text[byte_at[i]..byte_at[i + len]]);
        i += len;
    }
    pieces
}

/// Case-fold a char for matching the `(?i:'s|'t|...)` contraction letters. The
/// regex uses Unicode case-insensitive matching (case folding, not lowercasing);
/// `U+017F` LATIN SMALL LETTER LONG S folds to `s` and is the only non-ASCII
/// code point that folds onto any contraction letter (s/t/r/e/v/m/l/d), so it is
/// the only special case beyond ASCII lowercasing.
fn fold_contraction_letter(c: char) -> char {
    if c == '\u{017F}' {
        's'
    } else {
        c.to_ascii_lowercase()
    }
}

/// `\p{L}`: any letter (Lu, Ll, Lt, Lm, Lo).
fn is_letter(c: char) -> bool {
    matches!(
        get_general_category(c),
        GeneralCategory::UppercaseLetter
            | GeneralCategory::LowercaseLetter
            | GeneralCategory::TitlecaseLetter
            | GeneralCategory::ModifierLetter
            | GeneralCategory::OtherLetter
    )
}

/// `\p{N}`: any number (Nd, Nl, No) — includes e.g. Roman numerals (Nl).
fn is_number(c: char) -> bool {
    matches!(
        get_general_category(c),
        GeneralCategory::DecimalNumber
            | GeneralCategory::LetterNumber
            | GeneralCategory::OtherNumber
    )
}

/// `\p{M}`: any mark (Mn, Mc, Me).
fn is_mark(c: char) -> bool {
    matches!(
        get_general_category(c),
        GeneralCategory::NonspacingMark
            | GeneralCategory::SpacingMark
            | GeneralCategory::EnclosingMark
    )
}

/// o200k upper-letter class `[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]`.
fn is_o200k_upper(c: char) -> bool {
    matches!(
        get_general_category(c),
        GeneralCategory::UppercaseLetter
            | GeneralCategory::TitlecaseLetter
            | GeneralCategory::ModifierLetter
            | GeneralCategory::OtherLetter
    ) || is_mark(c)
}

/// o200k lower-letter class `[\p{Ll}\p{Lm}\p{Lo}\p{M}]`.
fn is_o200k_lower(c: char) -> bool {
    matches!(
        get_general_category(c),
        GeneralCategory::LowercaseLetter
            | GeneralCategory::ModifierLetter
            | GeneralCategory::OtherLetter
    ) || is_mark(c)
}

fn is_newline(c: char) -> bool {
    c == '\n' || c == '\r'
}

fn is_space(c: char) -> bool {
    c.is_whitespace()
}

/// `[^\s\p{L}\p{N}]`: not whitespace, letter, or number (punctuation/symbols).
fn is_other(c: char) -> bool {
    !c.is_whitespace() && !is_letter(c) && !is_number(c)
}

/// Number of chars the next pre-token piece consumes at position `i`. Returns at
/// least 1 (every regex alternative matches ≥1 char), so the scan always
/// progresses. Alternatives are tried in the regex's written order.
fn next_piece_char_len(c: &[char], i: usize) -> usize {
    let n = c.len();
    let ch = c[i];

    // alt1: (?i:'s|'t|'re|'ve|'m|'ll|'d) — apostrophe is literal U+0027.
    if ch == '\'' {
        if i + 2 < n {
            let a = fold_contraction_letter(c[i + 1]);
            let b = fold_contraction_letter(c[i + 2]);
            // 're, 've (b == 'e'), or 'll.
            if ((a == 'r' || a == 'v') && b == 'e') || (a == 'l' && b == 'l') {
                return 3;
            }
        }
        if i + 1 < n && matches!(fold_contraction_letter(c[i + 1]), 's' | 't' | 'm' | 'd') {
            return 2;
        }
    }

    // alt2: [^\r\n\p{L}\p{N}]?\p{L}+ — optional non-newline/letter/digit lead
    // (e.g. a space or punctuation) followed by one or more letters.
    if is_letter(ch) {
        let mut j = i + 1;
        while j < n && is_letter(c[j]) {
            j += 1;
        }
        return j - i;
    }
    if !is_newline(ch) && !is_number(ch) && i + 1 < n && is_letter(c[i + 1]) {
        // ch is the optional lead (not newline/letter/digit; whitespace allowed
        // except newline). Consume it plus the following letter run.
        let mut j = i + 2;
        while j < n && is_letter(c[j]) {
            j += 1;
        }
        return j - i;
    }

    // alt3: \p{N}{1,3} — 1 to 3 digits.
    if is_number(ch) {
        return digit_run_len(c, i);
    }

    // alt4:  ?[^\s\p{L}\p{N}]+[\r\n]* — optional single space, a punctuation/
    // symbol run, then trailing newlines.
    if let Some(len) = punctuation_run_len(c, i, false) {
        return len;
    }

    // alt5-7: `ch` is whitespace (every non-whitespace start matched above).
    whitespace_piece_len(c, i)
}

/// Number of chars the next `o200k_base` pre-token piece consumes at `i`. Shares
/// the digit/whitespace alternatives with cl100k; differs in the word rule
/// (case-split letter runs with attached contraction) and the alt4 trailing
/// class (which also absorbs `/`).
fn next_piece_char_len_o200k(c: &[char], i: usize) -> usize {
    let ch = c[i];

    // The word rule (regex alternatives A then B), each = optional
    // non-letter/digit lead, a case-structured letter run, optional contraction.
    if let Some(len) = match_word_o200k(c, i) {
        return len;
    }

    // alt3: \p{N}{1,3}
    if is_number(ch) {
        return digit_run_len(c, i);
    }

    // alt4:  ?[^\s\p{L}\p{N}]+[\r\n/]* — o200k adds `/` to the trailing class.
    if let Some(len) = punctuation_run_len(c, i, true) {
        return len;
    }

    // alt5-7: whitespace.
    whitespace_piece_len(c, i)
}

/// alt3: `\p{N}{1,3}` — 1 to 3 digits at `i` (caller ensures c[i] is a digit).
fn digit_run_len(c: &[char], i: usize) -> usize {
    let n = c.len();
    let mut j = i + 1;
    while j < n && j < i + 3 && is_number(c[j]) {
        j += 1;
    }
    j - i
}

/// alt4: ` ?[^\s\p{L}\p{N}]+[\r\n]*`, plus `/` in the trailing class when
/// `slash_trailing` (o200k). Returns the piece length, or `None` if no
/// punctuation/symbol run starts here.
fn punctuation_run_len(c: &[char], i: usize, slash_trailing: bool) -> Option<usize> {
    let n = c.len();
    let scan_start = if c[i] == ' ' { i + 1 } else { i };
    if scan_start < n && is_other(c[scan_start]) {
        let mut k = scan_start + 1;
        while k < n && is_other(c[k]) {
            k += 1;
        }
        while k < n && (is_newline(c[k]) || (slash_trailing && c[k] == '/')) {
            k += 1;
        }
        return Some(k - i);
    }
    None
}

/// alt5-7: `\s*[\r\n]+ | \s+(?!\S) | \s+`. Caller ensures c[i] is whitespace.
fn whitespace_piece_len(c: &[char], i: usize) -> usize {
    let n = c.len();
    let mut k = i;
    while k < n && is_space(c[k]) {
        k += 1;
    }
    // alt5: consume through the LAST newline in the run, if any.
    let mut last_newline = None;
    for (idx, &wc) in c.iter().enumerate().take(k).skip(i) {
        if is_newline(wc) {
            last_newline = Some(idx);
        }
    }
    if let Some(last) = last_newline {
        return last + 1 - i;
    }
    // alt6: \s+(?!\S) — whole run at end of input, else leave the last space.
    if k == n {
        return k - i;
    }
    if k - i >= 2 {
        return k - 1 - i;
    }
    // alt7: \s+ — a lone whitespace char before a non-space.
    1
}

/// o200k word match: optional lead `[^\r\n\p{L}\p{N}]?` then alternative A
/// (`[upper]*[lower]+`) or B (`[upper]+[lower]*`), then an optional contraction.
fn match_word_o200k(c: &[char], i: usize) -> Option<usize> {
    let ch = c[i];
    if is_letter(ch) {
        return match_ab_body(c, i);
    }
    // A valid lead is any non-newline, non-letter, non-digit char (incl. space /
    // punctuation); the letter body must then start at i+1.
    if !is_newline(ch) && !is_number(ch) {
        return match_ab_body(c, i + 1).map(|len| 1 + len);
    }
    None
}

/// Alternative A then B (no lead); returns the body length incl. contraction.
fn match_ab_body(c: &[char], start: usize) -> Option<usize> {
    match_a_body(c, start).or_else(|| match_b_body(c, start))
}

/// A body: `[upper]*[lower]+(contraction)?`. The greedy upper run yields a
/// "both-class" (Lm/Lo/M) trailing char to the required lower run when needed.
fn match_a_body(c: &[char], start: usize) -> Option<usize> {
    let n = c.len();
    let mut u = start;
    while u < n && is_o200k_upper(c[u]) {
        u += 1;
    }
    let lower_start = if u < n && is_o200k_lower(c[u]) {
        u
    } else if u > start && is_o200k_lower(c[u - 1]) {
        u - 1
    } else {
        return None;
    };
    let mut k = lower_start;
    while k < n && is_o200k_lower(c[k]) {
        k += 1;
    }
    Some(k - start + contraction_suffix_len(c, k))
}

/// B body: `[upper]+[lower]*(contraction)?`.
fn match_b_body(c: &[char], start: usize) -> Option<usize> {
    let n = c.len();
    let mut u = start;
    while u < n && is_o200k_upper(c[u]) {
        u += 1;
    }
    if u == start {
        return None;
    }
    let mut k = u;
    while k < n && is_o200k_lower(c[k]) {
        k += 1;
    }
    Some(k - start + contraction_suffix_len(c, k))
}

/// Optional `(?i:'s|'t|'re|'ve|'m|'ll|'d)` directly after an o200k word. Returns
/// 0 (none), 2, or 3.
fn contraction_suffix_len(c: &[char], k: usize) -> usize {
    let n = c.len();
    if k >= n || c[k] != '\'' {
        return 0;
    }
    if k + 2 < n {
        let a = fold_contraction_letter(c[k + 1]);
        let b = fold_contraction_letter(c[k + 2]);
        if ((a == 'r' || a == 'v') && b == 'e') || (a == 'l' && b == 'l') {
            return 3;
        }
    }
    if k + 1 < n && matches!(fold_contraction_letter(c[k + 1]), 's' | 't' | 'm' | 'd') {
        return 2;
    }
    0
}

/// Decode standard base64 (RFC 4648, `+/` alphabet, `=` padding). Returns `None`
/// on any invalid character or malformed length. Whitespace is not expected in
/// `.tiktoken` tokens, so it is rejected.
fn decode_base64_standard(input: &str) -> Option<Vec<u8>> {
    fn val(b: u8) -> Option<u32> {
        match b {
            b'A'..=b'Z' => Some((b - b'A') as u32),
            b'a'..=b'z' => Some((b - b'a' + 26) as u32),
            b'0'..=b'9' => Some((b - b'0' + 52) as u32),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }

    let bytes = input.as_bytes();
    // Strip trailing '=' padding.
    let unpadded = bytes
        .iter()
        .position(|&b| b == b'=')
        .map_or(bytes, |p| &bytes[..p]);
    // Any '=' must be trailing only.
    if bytes[unpadded.len()..].iter().any(|&b| b != b'=') {
        return None;
    }
    // A base64 group is 4 chars; a final group of length 1 is invalid.
    if unpadded.len() % 4 == 1 {
        return None;
    }

    let mut out = Vec::with_capacity(unpadded.len() / 4 * 3 + 2);
    let mut acc = 0u32;
    let mut bits = 0u32;
    for &b in unpadded {
        acc = (acc << 6) | val(b)?;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn english_words_keep_leading_space() {
        assert_eq!(pre_tokenize_cl100k("hello world"), vec!["hello", " world"]);
        assert_eq!(pre_tokenize_cl100k("Hello"), vec!["Hello"]);
    }

    #[test]
    fn contractions_split_off() {
        assert_eq!(pre_tokenize_cl100k("don't"), vec!["don", "'t"]);
        assert_eq!(pre_tokenize_cl100k("I'm"), vec!["I", "'m"]);
        assert_eq!(pre_tokenize_cl100k("they're"), vec!["they", "'re"]);
        assert_eq!(pre_tokenize_cl100k("we'll've"), vec!["we", "'ll", "'ve"]);
        // Case-insensitive contraction letters.
        assert_eq!(pre_tokenize_cl100k("DON'T"), vec!["DON", "'T"]);
        // U+017F (long s) case-folds to 's' under (?i:'s), so 'ſ is the 's
        // contraction (matching real tiktoken), not absorbed into a word run.
        assert_eq!(pre_tokenize_cl100k("x'\u{017F}y"), vec!["x", "'\u{017F}", "y"]);
        assert_eq!(
            pre_tokenize_cl100k("we'\u{017F}\u{017F}"),
            vec!["we", "'\u{017F}", "\u{017F}"]
        );
    }

    #[test]
    fn digits_group_by_threes() {
        assert_eq!(pre_tokenize_cl100k("1234567"), vec!["123", "456", "7"]);
        assert_eq!(pre_tokenize_cl100k("abc123"), vec!["abc", "123"]);
    }

    #[test]
    fn leading_punctuation_attaches_to_word() {
        assert_eq!(pre_tokenize_cl100k("(hello"), vec!["(hello"]);
        // A run of leading punctuation is its own piece; the single immediately
        // preceding punct attaches to the word.
        assert_eq!(pre_tokenize_cl100k("!!a"), vec!["!!", "a"]);
        // Space + punctuation -> alt4 (space attaches to the punctuation run).
        assert_eq!(pre_tokenize_cl100k(" !"), vec![" !"]);
    }

    #[test]
    fn multiple_leading_spaces() {
        // Extra leading spaces become their own piece; the last space attaches to
        // the word (matching tiktoken).
        assert_eq!(pre_tokenize_cl100k("  hello"), vec![" ", " hello"]);
        assert_eq!(pre_tokenize_cl100k("   hello"), vec!["  ", " hello"]);
    }

    #[test]
    fn whitespace_and_newlines() {
        // Trailing whitespace at end of input is one piece.
        assert_eq!(pre_tokenize_cl100k("a  "), vec!["a", "  "]);
        // A newline-terminated run is consumed through the newline.
        assert_eq!(pre_tokenize_cl100k("a\nb"), vec!["a", "\n", "b"]);
        assert_eq!(pre_tokenize_cl100k("a \n b"), vec!["a", " \n", " b"]);
        // Space before a digit is not absorbed by the word rule.
        assert_eq!(pre_tokenize_cl100k(" 5"), vec![" ", "5"]);
    }

    #[test]
    fn cjk_runs_as_letters() {
        // CJK code points are alphabetic, so they group like a word run.
        assert_eq!(pre_tokenize_cl100k("你好"), vec!["你好"]);
    }

    #[test]
    fn empty_input() {
        assert!(pre_tokenize_cl100k("").is_empty());
    }

    #[test]
    fn no_chars_dropped() {
        for text in [
            "Hello, world! It's 2026 — 你好.\n\tTabbed   spaces.",
            "a@b.com https://x.y/z?q=1&w=2",
            "'tis 'twas '99",
        ] {
            let joined: String = pre_tokenize_cl100k(text).concat();
            assert_eq!(joined, text, "round-trip failed for {text:?}");
        }
    }

    #[test]
    fn base64_decoder_matches_known_vectors() {
        assert_eq!(decode_base64_standard("").unwrap(), b"");
        assert_eq!(decode_base64_standard("Zg==").unwrap(), b"f");
        assert_eq!(decode_base64_standard("Zm8=").unwrap(), b"fo");
        assert_eq!(decode_base64_standard("Zm9v").unwrap(), b"foo");
        assert_eq!(decode_base64_standard("aGVsbG8=").unwrap(), b"hello");
        // Bytes that are not valid UTF-8 (a real .tiktoken token).
        assert_eq!(decode_base64_standard("IA==").unwrap(), b" ");
        assert!(decode_base64_standard("not base64!").is_none());
    }

    #[test]
    fn parse_mergeable_ranks_reads_token_rank_pairs() {
        // "IQ=="=b"!", "Ig=="=b"\"", "ICE="=b" !".
        let data = "IQ== 0\nIg== 1\nICE= 2\n\n  \n";
        let ranks = parse_mergeable_ranks(data);
        assert_eq!(ranks.len(), 3);
        assert_eq!(ranks.get(b"!".as_slice()), Some(&0));
        assert_eq!(ranks.get(b"\"".as_slice()), Some(&1));
        assert_eq!(ranks.get(b" !".as_slice()), Some(&2));
    }

    #[test]
    fn count_uses_pretokenize_and_bpe() {
        // Synthetic ranks: each single byte, plus the merge "lo".
        let mut ranks: HashMap<Vec<u8>, u32> = HashMap::new();
        for (i, b) in (b'a'..=b'z').enumerate() {
            ranks.insert(vec![b], i as u32);
        }
        ranks.insert(b" ".to_vec(), 100);
        ranks.insert(b"lo".to_vec(), 200);
        // "lo lo": pieces ["lo", " lo"]. "lo" -> 1 token (merged). " lo": bytes
        // [' ','l','o'] -> ' ' stays, "lo" merges -> 2 tokens. Total 3.
        assert_eq!(count_bpe_tokens_cl100k("lo lo", &ranks), 3);
    }

    #[test]
    fn o200k_splits_camelcase() {
        assert_eq!(pre_tokenize_o200k("HelloWorld"), vec!["Hello", "World"]);
        assert_eq!(pre_tokenize_o200k("getHTTPResponse"), vec!["get", "HTTPResponse"]);
        assert_eq!(pre_tokenize_o200k("aB"), vec!["a", "B"]);
        // upper* lower+ keeps a leading caps run with its lowercase tail.
        assert_eq!(pre_tokenize_o200k("ABCdef"), vec!["ABCdef"]);
        assert_eq!(pre_tokenize_o200k("ABC"), vec!["ABC"]);
    }

    #[test]
    fn o200k_attaches_contraction_to_word() {
        // Unlike cl100k, o200k folds the contraction into the word piece.
        assert_eq!(pre_tokenize_o200k("don't"), vec!["don't"]);
        assert_eq!(pre_tokenize_o200k("I'm"), vec!["I'm"]);
        assert_eq!(pre_tokenize_o200k("they're"), vec!["they're"]);
        assert_eq!(pre_tokenize_o200k("ABC's"), vec!["ABC's"]);
        // cl100k splits the same input differently (regression guard).
        assert_eq!(pre_tokenize_cl100k("don't"), vec!["don", "'t"]);
    }

    #[test]
    fn o200k_shares_digit_and_whitespace_rules() {
        assert_eq!(pre_tokenize_o200k("hello world"), vec!["hello", " world"]);
        assert_eq!(pre_tokenize_o200k("1234567"), vec!["123", "456", "7"]);
        assert_eq!(pre_tokenize_o200k("a\nb"), vec!["a", "\n", "b"]);
        assert_eq!(pre_tokenize_o200k("  hello"), vec![" ", " hello"]);
        // CJK (OtherLetter) groups as a single letter run.
        assert_eq!(pre_tokenize_o200k("你好"), vec!["你好"]);
    }

    #[test]
    fn o200k_no_chars_dropped() {
        for text in [
            "camelCaseHTTPServer don't 你好 — 2026!\n\tTab\tand   spaces.",
            "a/b/c path/to/file ABCdef'reGHI",
            "'tis 'TWAS 123abc456",
        ] {
            let joined: String = pre_tokenize_o200k(text).concat();
            assert_eq!(joined, text, "o200k round-trip failed for {text:?}");
        }
    }

    #[test]
    fn exact_unicode_categories_for_letter_and_number() {
        // Roman numeral U+2160 is \p{Nl} (a number), not \p{L} — exact category
        // resolution puts it on the digit path, matching real tiktoken.
        assert!(is_number('\u{2160}'));
        assert!(!is_letter('\u{2160}'));
        // CJK ideograph is \p{Lo} (a letter).
        assert!(is_letter('好'));
    }
}
