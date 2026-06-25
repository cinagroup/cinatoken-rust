//! Byte-pair-encoding token *count* — the core of real tiktoken
//! (cl100k_base / o200k_base), used by Go via `tiktoken-go` for OpenAI text.
//!
//! This is the pure merge algorithm, with the mergeable-rank table **injected**
//! by the caller (the same pattern as the other `core` primitives). It counts
//! the tokens a single pre-tokenized piece encodes to, which is all request-time
//! estimation needs.
//!
//! What stays the caller's responsibility (the genuine I/O / decisions, per
//! `docs/source-token-estimation-parity.md` and migration-plan §21.7):
//! - **Pre-tokenization**: split the input text into pieces with the model's
//!   GPT regex before calling this per piece, then sum the counts.
//! - **Vocab loading**: load the `cl100k_base` / `o200k_base` mergeable-rank
//!   table from KV/R2 (do not embed ~1.7 MB into the Worker bundle).
//!
//! For total tokens: `pieces.map(|p| bpe_token_count(p, ranks)).sum()` plus the
//! per-model special-token / message overhead handled elsewhere.

use std::collections::HashMap;

/// Number of tokens the byte string `piece` encodes to under `ranks` (the
/// mergeable-rank table mapping byte sequences to their BPE rank).
///
/// Faithful to the educational tiktoken BPE: start with every byte its own
/// part, then repeatedly merge the adjacent pair with the lowest rank until no
/// adjacent pair is in `ranks`. The token count is the number of remaining
/// parts. Pre-tokenized pieces are short, so the simple O(n^2) merge is fine.
pub fn bpe_token_count(piece: &[u8], ranks: &HashMap<Vec<u8>, u32>) -> usize {
    if piece.len() <= 1 {
        return piece.len();
    }

    // Each part is a half-open byte range [start, end) into `piece`.
    let mut parts: Vec<(usize, usize)> = (0..piece.len()).map(|i| (i, i + 1)).collect();

    loop {
        let mut min_rank: Option<u32> = None;
        let mut min_idx = 0usize;
        for i in 0..parts.len() - 1 {
            let pair = &piece[parts[i].0..parts[i + 1].1];
            if let Some(&rank) = ranks.get(pair) {
                if min_rank.map_or(true, |mr| rank < mr) {
                    min_rank = Some(rank);
                    min_idx = i;
                }
            }
        }
        if min_rank.is_none() {
            break;
        }
        // Merge parts[min_idx] and parts[min_idx + 1].
        parts[min_idx].1 = parts[min_idx + 1].1;
        parts.remove(min_idx + 1);
    }

    parts.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ranks() -> HashMap<Vec<u8>, u32> {
        // Synthetic mergeable ranks: lower rank = merged earlier.
        [
            (b"a".to_vec(), 0u32),
            (b"b".to_vec(), 1),
            (b"c".to_vec(), 2),
            (b"ab".to_vec(), 3),
            (b"bc".to_vec(), 4),
            (b"abc".to_vec(), 5),
        ]
        .into_iter()
        .collect()
    }

    #[test]
    fn empty_and_single() {
        assert_eq!(bpe_token_count(b"", &ranks()), 0);
        assert_eq!(bpe_token_count(b"a", &ranks()), 1);
    }

    #[test]
    fn merges_to_fewest_tokens() {
        // a+b -> ab (rank 3), then ab+c -> abc (rank 5): one token.
        assert_eq!(bpe_token_count(b"abc", &ranks()), 1);
        // a+b -> ab: one token.
        assert_eq!(bpe_token_count(b"ab", &ranks()), 1);
    }

    #[test]
    fn unmergeable_pairs_stay_separate() {
        // "ac" has no "ac" rank -> stays 2 parts.
        assert_eq!(bpe_token_count(b"ac", &ranks()), 2);
        // "cba": no cb/ba pair rank -> 3 parts.
        assert_eq!(bpe_token_count(b"cba", &ranks()), 3);
    }

    #[test]
    fn lowest_rank_merges_first() {
        // "aab": pairs are "aa" (none) and "ab" (rank 3). Merge ab -> "a","ab" =
        // 2 tokens.
        assert_eq!(bpe_token_count(b"aab", &ranks()), 2);
    }
}
