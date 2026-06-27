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

/// The result of one auto cross-group selection step: the channel chosen for
/// this attempt plus the state to carry into the next retry. Mirrors the
/// side effects of Go `service.CacheGetRandomSatisfiedChannel`
/// (`ContextKeyAutoGroupIndex`, `param.SetRetry`, `param.ResetRetryNextTry`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutoGroupOutcome<T> {
    /// The selected channel (whatever the caller's `select` returned).
    pub selected: T,
    /// Index (into the user's auto-group list) of the group used this attempt.
    pub group_index: usize,
    /// The priority-tier index passed to the weighted selector for this group
    /// (Go `priorityRetry`).
    pub priority_retry: i32,
    /// `ContextKeyAutoGroupIndex` to persist for the next retry.
    pub next_group_index: usize,
    /// `param.Retry` to persist for the next retry.
    pub next_retry: i32,
    /// Whether the next `IncreaseRetry` must be skipped (Go `ResetRetryNextTry`),
    /// so the next attempt reuses `next_retry` rather than `next_retry + 1`.
    pub reset_retry_next_try: bool,
}

/// Auto cross-group channel selection — pure port of the state machine in Go
/// `service.CacheGetRandomSatisfiedChannel` for `tokenGroup == "auto"`
/// (`service/channel_select.go:83`).
///
/// Starting at `start_group_index`, walk the user's auto groups. The first group
/// uses `priority_retry = retry`; each subsequent group (reached because an
/// earlier group had no channel for the model) uses `priority_retry = 0` — so a
/// group exhausts its priorities before the next group is tried. `select(group_index,
/// priority_retry)` performs the actual per-group weighted selection (e.g. via
/// [`select_weighted`]) and returns the chosen channel, or `None` when that group
/// has no channel for the model.
///
/// On finding a channel:
/// - with `cross_group_retry` and `priority_retry >= retry_times`, the current
///   group is still used but the next retry advances to the next group
///   (`next_group_index = group_index + 1`, `next_retry = 0`,
///   `reset_retry_next_try = true`);
/// - otherwise the selection stays in the current group (`next_group_index =
///   group_index`, `next_retry = priority_retry`).
///
/// Returns `None` when every group from `start_group_index` onward has no
/// channel (the caller should stop retrying).
pub fn auto_group_retry_step<T>(
    group_count: usize,
    start_group_index: usize,
    retry: i32,
    cross_group_retry: bool,
    retry_times: i32,
    mut select: impl FnMut(usize, i32) -> Option<T>,
) -> Option<AutoGroupOutcome<T>> {
    for group_index in start_group_index..group_count {
        // The start group inherits the outer retry; groups reached after skipping
        // an empty one restart at priority 0 (Go `if i > startGroupIndex`).
        let priority_retry = if group_index > start_group_index {
            0
        } else {
            retry
        };

        let Some(selected) = select(group_index, priority_retry) else {
            // No channel in this group for the model: advance to the next group.
            continue;
        };

        let (next_group_index, next_retry, reset_retry_next_try) =
            if cross_group_retry && priority_retry >= retry_times {
                (group_index + 1, 0, true)
            } else {
                (group_index, priority_retry, false)
            };

        return Some(AutoGroupOutcome {
            selected,
            group_index,
            priority_retry,
            next_group_index,
            next_retry,
            reset_retry_next_try,
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{auto_group_retry_step, select_weighted, AutoGroupOutcome, Candidate};

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
        assert_eq!(
            select_weighted(&cands, 0, |total| {
                assert_eq!(total, 200);
                50
            }),
            Some(0)
        ); // 50-100 < 0
        assert_eq!(select_weighted(&cands, 0, |_| 150), Some(1)); // 150-100=50; 50-100<0
    }

    #[test]
    fn high_weights_use_straight_weighted_pick() {
        // weights [10,90], avg 50 >= 10 -> factor 1, total 100.
        let cands = [c(0, 10), c(0, 90)];
        assert_eq!(select_weighted(&cands, 0, |_| 5), Some(0)); // 5-10 < 0
        assert_eq!(select_weighted(&cands, 0, |_| 10), Some(1)); // 10-10=0; 0-90 < 0
        assert_eq!(select_weighted(&cands, 0, |_| 99), Some(1));
    }

    // --- auto cross-group retry state machine ---

    /// `select` available for group 0 only (always returns the priority it was
    /// asked for, so we can assert priority_retry).
    fn only_group0(gi: usize, pr: i32) -> Option<i32> {
        if gi == 0 {
            Some(pr)
        } else {
            None
        }
    }

    #[test]
    fn stays_in_group_without_cross_group_retry() {
        let out =
            auto_group_retry_step(2, 0, 1, false, 3, only_group0).expect("group 0 has a channel");
        assert_eq!(
            out,
            AutoGroupOutcome {
                selected: 1,         // priority_retry passed through by only_group0
                group_index: 0,
                priority_retry: 1,   // == outer retry
                next_group_index: 0, // stay in group 0
                next_retry: 1,       // unchanged -> outer loop will IncreaseRetry to 2
                reset_retry_next_try: false,
            }
        );
    }

    #[test]
    fn cross_group_retry_advances_group_when_priorities_exhausted() {
        // priority_retry (3) >= retry_times (3): use group 0 now, advance next time.
        let out = auto_group_retry_step(2, 0, 3, true, 3, |_, pr| Some(pr)).unwrap();
        assert_eq!(out.group_index, 0);
        assert_eq!(out.priority_retry, 3);
        assert_eq!(out.next_group_index, 1); // next retry uses group 1
        assert_eq!(out.next_retry, 0); // restart priorities in the new group
        assert!(out.reset_retry_next_try); // skip the next IncreaseRetry
    }

    #[test]
    fn skips_empty_leading_group_and_restarts_priority() {
        // Group 0 has no channel; group 1 does -> use group 1 at priority 0.
        let out = auto_group_retry_step(2, 0, 5, false, 3, |gi, pr| {
            if gi == 1 {
                Some(pr)
            } else {
                None
            }
        })
        .unwrap();
        assert_eq!(out.group_index, 1);
        assert_eq!(out.priority_retry, 0); // restarted (not the outer retry 5)
        assert_eq!(out.next_group_index, 1);
        assert_eq!(out.next_retry, 0);
        assert!(!out.reset_retry_next_try);
    }

    #[test]
    fn all_groups_empty_returns_none() {
        let out = auto_group_retry_step(3, 0, 0, true, 3, |_, _| None::<i32>);
        assert!(out.is_none());
    }

    #[test]
    fn starts_from_persisted_group_index() {
        // Resuming at group 1 (a prior cross-group advance); group 1 available.
        let out = auto_group_retry_step(3, 1, 0, false, 3, |gi, pr| {
            if gi == 1 {
                Some(pr)
            } else {
                None
            }
        })
        .unwrap();
        assert_eq!(out.group_index, 1);
        assert_eq!(out.priority_retry, 0);
        assert_eq!(out.next_group_index, 1);
    }

    #[test]
    fn drives_a_full_two_group_retry_loop() {
        // Two groups, each with channels at priorities 0..=1, retry_times = 1,
        // cross_group_retry on. Replicate the outer loop:
        //   for retry in 0..=retry_times (with IncreaseRetry / reset semantics).
        // Expect: g0/p0, g0/p1 (advance armed), g1/p0, g1/p1.
        let group_count = 2;
        let retry_times = 1;
        let select = |_gi: usize, _pr: i32| Some(());
        let mut group_index = 0usize;
        let mut retry = 0i32;
        let mut trace = Vec::new();

        while retry <= retry_times {
            let out = auto_group_retry_step(
                group_count,
                group_index,
                retry,
                true,
                retry_times,
                select,
            );
            let Some(out) = out else { break };
            trace.push((out.group_index, out.priority_retry));
            group_index = out.next_group_index;
            retry = out.next_retry;
            // Outer-loop IncreaseRetry: skip the increment once if reset was armed.
            if !out.reset_retry_next_try {
                retry += 1;
            }
        }

        assert_eq!(trace, vec![(0, 0), (0, 1), (1, 0), (1, 1)]);
    }
}
