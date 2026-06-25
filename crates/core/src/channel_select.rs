//! Weighted-random channel selection with smoothing — the core math of Go
//! `model.GetRandomSatisfiedChannel` (`model/channel_cache.go:97`).
//!
//! This is a pure, RNG-injected port of the hardest part of channel selection:
//! pick a priority tier by `retry`, then weighted-random among that tier's
//! candidates with the exact two smoothing modes Go uses. It is deliberately
//! free of D1/Worker types so it can be unit-tested deterministically and wired
//! into `crates/worker/src/d1_repositories.rs::select_relay_channels` (which
//! currently selects via a deterministic `ORDER BY priority DESC, weight DESC`
//! and does not yet reproduce Go's load-spreading distribution).
//!
//! Parity target: `docs/source-channel-selection-parity.md`.

/// One selectable candidate. `priority` mirrors Go `Channel.GetPriority()`
/// (nil -> 0) and `weight` mirrors `GetWeight()` (nil -> 0).
#[derive(Debug, Clone, Copy)]
pub struct Candidate {
    pub priority: i64,
    pub weight: i32,
}

/// Select the index into `candidates` of the chosen entry, mirroring Go
/// `GetRandomSatisfiedChannel`:
///
/// 1. one candidate -> return it;
/// 2. collect the distinct priorities, sort descending, and pick the
///    `retry`-th (clamped to the lowest) as the target tier;
/// 3. weighted-random among the candidates in that tier, with Go's smoothing:
///    - all weights zero -> uniform pick (each effective weight 100);
///    - average weight `< 10` (integer division) -> scale every weight by 100;
///    - otherwise straight weighted pick.
///
/// `random_below(total)` must return a value in `[0, total)` for `total > 0`
/// (inject the platform RNG; tests pass a deterministic stub). Returns `None`
/// only for an empty input.
pub fn select_weighted(
    candidates: &[Candidate],
    retry: usize,
    random_below: impl FnOnce(u64) -> u64,
) -> Option<usize> {
    match candidates.len() {
        0 => return None,
        1 => return Some(0),
        _ => {}
    }

    // Distinct priorities, descending. `retry` indexes the tier (clamped).
    let mut priorities: Vec<i64> = candidates.iter().map(|c| c.priority).collect();
    priorities.sort_unstable_by(|a, b| b.cmp(a));
    priorities.dedup();
    let target_priority = priorities[retry.min(priorities.len() - 1)];

    // Candidate indices in the target tier, preserving input order (Go iterates
    // the candidate slice in order, which affects the distribution).
    let tier: Vec<usize> = candidates
        .iter()
        .enumerate()
        .filter(|(_, c)| c.priority == target_priority)
        .map(|(i, _)| i)
        .collect();
    if tier.is_empty() {
        return None;
    }

    let n = tier.len() as i64;
    let mut sum_weight: i64 = tier.iter().map(|&i| candidates[i].weight as i64).sum();
    let mut smoothing_factor: i64 = 1;
    let mut smoothing_adjustment: i64 = 0;
    if sum_weight == 0 {
        // All weights zero: every effective weight becomes 100 (uniform).
        sum_weight = n * 100;
        smoothing_adjustment = 100;
    } else if sum_weight / n < 10 {
        // Low average weight: scale up so the random step has resolution.
        smoothing_factor = 100;
    }

    let total_weight = sum_weight * smoothing_factor;
    if total_weight <= 0 {
        return tier.first().copied();
    }

    let mut remaining = random_below(total_weight as u64) as i64;
    for &i in &tier {
        remaining -= candidates[i].weight as i64 * smoothing_factor + smoothing_adjustment;
        if remaining < 0 {
            return Some(i);
        }
    }
    // Defensive: a well-formed random_below never reaches here.
    tier.last().copied()
}

#[cfg(test)]
mod tests {
    use super::{select_weighted, Candidate};

    fn c(priority: i64, weight: i32) -> Candidate {
        Candidate { priority, weight }
    }

    #[test]
    fn single_candidate_is_returned() {
        assert_eq!(select_weighted(&[c(0, 0)], 0, |_| 0), Some(0));
    }

    #[test]
    fn empty_is_none() {
        assert_eq!(select_weighted(&[], 0, |_| 0), None);
    }

    #[test]
    fn retry_selects_priority_tier_descending_and_clamps() {
        // priorities {10,10,5}; retry 0 -> tier 10 (indices 0/1), retry 1 -> tier 5
        // (index 2), retry 2 -> clamped to lowest tier 5.
        let cands = [c(10, 1), c(10, 1), c(5, 1)];
        assert_eq!(select_weighted(&cands, 0, |_| 0), Some(0)); // first of tier 10
        assert_eq!(select_weighted(&cands, 1, |_| 0), Some(2)); // only of tier 5
        assert_eq!(select_weighted(&cands, 2, |_| 0), Some(2)); // clamp
    }

    #[test]
    fn low_average_weight_scales_by_100() {
        // weights [1,3], avg 2 < 10 -> factor 100, total 400.
        let cands = [c(0, 1), c(0, 3)];
        // r=50  -> 50-100 < 0 -> index 0.
        assert_eq!(select_weighted(&cands, 0, |_| 50), Some(0));
        // r=150 -> 150-100=50; 50-300 < 0 -> index 1.
        assert_eq!(select_weighted(&cands, 0, |_| 150), Some(1));
        // total exposed to the RNG is 400.
        select_weighted(&cands, 0, |total| {
            assert_eq!(total, 400);
            0
        });
    }

    #[test]
    fn all_zero_weights_are_uniform() {
        // sum 0 -> sum=n*100=200, adjustment 100, factor 1, total 200.
        let cands = [c(0, 0), c(0, 0)];
        assert_eq!(select_weighted(&cands, 0, |total| {
            assert_eq!(total, 200);
            50
        }), Some(0)); // 50-100 < 0
        assert_eq!(select_weighted(&cands, 0, |_| 150), Some(1)); // 150-100=50; 50-100<0
    }

    #[test]
    fn high_weights_use_straight_weighted_pick() {
        // weights [10,90], avg 50 >= 10 -> factor 1, total 100.
        let cands = [c(0, 10), c(0, 90)];
        assert_eq!(select_weighted(&cands, 0, |_| 5), Some(0));   // 5-10 < 0
        assert_eq!(select_weighted(&cands, 0, |_| 10), Some(1));  // 10-10=0; 0-90 < 0
        assert_eq!(select_weighted(&cands, 0, |_| 99), Some(1));
    }
}
