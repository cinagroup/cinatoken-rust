# Source Retry, Auto-Ban, And Channel Health Parity (G3)

Date: 2026-06-25

Status: canonical, source-derived specification of the Go relay retry loop,
retryable-error classification, channel auto-ban, and auto-recovery. Completes
the relay-core resilience picture alongside
`docs/source-channel-selection-parity.md` (which covers how `retry` maps to the
selected channel). Wrong retry/ban behavior causes either request failures that
should have retried, or healthy channels getting banned (or bad channels never
banned).

## Source Of Truth

- `controller/relay.go` — `Relay` retry loop, `shouldRetry`,
  `processChannelError`, `addUsedChannel`, `shouldRetryTaskRelay`.
- `service/channel.go` — `ShouldDisableChannel`, `DisableChannel`,
  `EnableChannel`, `ShouldEnableChannel`.
- `operation_setting` — `ShouldRetryByStatusCode`, `ShouldDisableByStatusCode`,
  `IsAlwaysSkipRetryCode`, `AutomaticDisableKeywords`.
- `types` — error taxonomy (`IsChannelError`, `IsSkipRetryError`,
  `IsRecordErrorLog`, `NewChannelError`).

## Retry Loop

```text
relayInfo.RetryIndex = 0
for retry = 0; retry <= RetryTimes; retry++:
    relayInfo.RetryIndex = retry
    channel = getChannel(retry)        # retry -> priority/group, see channel-selection doc
    addUsedChannel(channel.Id)         # appends to use_channel chain for audit
    err = relayHandler(...)            # or Claude/Gemini/Realtime variant
    if err == nil: return              # success
    err = NormalizeViolationFeeError(err)
    processChannelError(channelError, err)   # auto-ban + error log (async)
    if !shouldRetry(err, RetryTimes - retry): break
```

- Total attempts = `RetryTimes + 1` (retry starts at 0, `<=` bound). Rust must
  match this off-by-one.
- `retry` selects the channel (priority tier within a group, or group+priority in
  `auto`); the auto cross-group path resets the counter
  (`docs/source-channel-selection-parity.md`).
- The `use_channel` chain (`#a -> #b -> ...`) is logged when more than one
  channel was tried.

## `shouldRetry` Decision (ordered)

1. `err == nil` -> false.
2. `ShouldSkipRetryAfterChannelAffinityFailure` -> false.
3. `IsChannelError(err)` -> **true** (always retry to next channel).
4. `IsSkipRetryError(err)` -> false.
5. `retryTimes <= 0` -> false (budget exhausted).
6. `specific_channel_id` set -> false (pinned channel, no failover).
7. status `2xx` -> false.
8. status `<100 || >599` (non-HTTP, e.g. network/timeout) -> true.
9. `IsAlwaysSkipRetryCode(errorCode)` -> false.
10. else -> `ShouldRetryByStatusCode(code)` (configurable).

## Auto-Ban: `ShouldDisableChannel` (ordered) + `DisableChannel`

`ShouldDisableChannel(err)`:

1. `!AutomaticDisableChannelEnabled` -> false.
2. `err == nil` -> false.
3. `IsChannelError(err)` -> true.
4. `IsSkipRetryError(err)` -> false.
5. `ShouldDisableByStatusCode(StatusCode)` -> true (configurable codes).
6. else -> Aho-Corasick substring match of the **lowercased error message**
   against `AutomaticDisableKeywords` (e.g. quota/credential phrases) -> ban on
   match.

`processChannelError`: if `ShouldDisableChannel(err) && channelError.AutoBan`,
**asynchronously** (`gopool.Go`) `DisableChannel`. Also records an error log
(channel/error metadata) when `ErrorLogEnabled && IsRecordErrorLog(err)`.

`DisableChannel`: AutoBan-gated; sets channel status to **`ChannelStatusAutoDisabled`**
with the reason; **multi-key aware** (`UsingKey` / multi-key index — bans the
specific key, not the whole channel, in multi-key mode); notifies root user.

## Channel Status And Recovery

- Statuses: `Enabled`, `AutoDisabled` (auto-ban), and manual `Disabled`.
- `ShouldEnableChannel(err, status)` (recovery): true only when
  `AutomaticEnableChannelEnabled && err == nil && status == AutoDisabled`. Driven
  by the channel test path — a successful test re-enables an **auto-disabled**
  channel. **Manually disabled channels are never auto-recovered.**

## Parity-Critical Findings

1. **Channel-error class both retries and bans.** `IsChannelError` -> always
   retry (rule 3) and always ban (rule 3). Rust needs the same error taxonomy
   (`IsChannelError`, `IsSkipRetryError`, `IsAlwaysSkipRetryCode`,
   `IsRecordErrorLog`) or retry/ban diverge.
2. **`specific_channel_id` disables failover** — consistent with the admin pin in
   `docs/source-auth-session-parity.md` and selection doc.
3. **Keyword-based auto-ban.** Rust needs a substring/AC matcher over the
   configurable `AutomaticDisableKeywords` on the lowercased error message, in
   addition to status-code bans.
4. **Auto-ban is per-key in multi-key mode** (`UsingKey`/index +
   `ChannelInfo.MultiKeyStatusList`), not whole-channel. Banning the whole
   channel on one bad key over-bans.
5. **`AutoDisabled` vs manual `Disabled` must be distinguished** so auto-recovery
   never re-enables an operator-disabled channel.
6. **Ban is off the request path.** Go uses `gopool.Go`; the Worker must use
   `wait_until` or a Queue/DO write, and **must invalidate the channel/ability
   cache** after a ban so selection stops choosing it (ties to
   `docs/source-channel-selection-parity.md` and the cache-invalidation policy).
   **Fixed 2026-06-25:** `record_retryable_channel_failure` now calls
   `invalidate_channel_cache(env)` after both auto-disable paths (401 + threshold)
   — previously a banned channel was still served (without failover) from the
   read-through cache until its TTL, defeating the ban.
7. **Total attempts = RetryTimes + 1**; the auto-group counter reset interacts
   with the budget. Add fixtures for single-group priority walk and cross-group
   advance.
8. **Both `Automatic{Disable,Enable}ChannelEnabled` are config flags** — bans and
   recovery are operator-gated; respect them.

## Rust Status And Checklist

Implementation status (verified 2026-06-25): auto-ban is implemented in
`crates/worker/src/relay.rs` but with a **different model than Go** — a
failure-**threshold/window counter** (`channel_auto_ban_threshold` failures
within `CHANNEL_AUTO_BAN_WINDOW_SECONDS = 60` → `disable_channel_best_effort`),
rather than Go's immediate disable on error-classification
(`ShouldDisableChannel`: channel-error / status-code / keyword). This is a
deliberate divergence (more tolerant of transient errors) — decide whether to
keep it or match Go, and document either way. The keyword-based ban and per-key
multi-key ban are not evident. Checklist:

1. Port the retry loop with `RetryTimes+1` attempts and the `retry`->selection
   mapping; record the `use_channel` chain in audit.
2. `shouldRetry` rule order — **ported** as
   `cinatoken_core::relay_policy::should_retry` (IsChannelError, skip-retry,
   budget, specific-channel, 2xx, non-HTTP, always-skip, status policy). Supply
   the error-taxonomy booleans + status predicate and wire into the retry loop.
3. `ShouldDisableChannel` (status-code + case-insensitive keyword matching) —
   **ported** as `core::relay_policy::should_disable_channel` (the Go-matching
   immediate-disable policy; available if decision #1 chooses to match Go).
   Still needs the error taxonomy (IsChannelError/IsSkipRetry) at the caller.
   **Keyword branch WIRED 2026-06-28 (flag-gated,
   `RELAY_CHANNEL_KEYWORD_BAN_ENABLED`):** the Go `AutomaticDisableKeywords`
   default (7 phrases) is ported as `core::AUTOMATIC_DISABLE_KEYWORDS` +
   `error_body_triggers_auto_disable` (host-tested), and
   `relay.rs::maybe_keyword_disable_channel` reads a bounded prefix of a retried
   channel's error body, bans the channel off-path + invalidates the selection
   cache on a match. The status-code default already matches Go
   (`AutomaticDisableStatusCodeRanges = {401}` == `is_auto_disable_status`).
   **Remaining**: the keyword check currently fires only on the retry path
   (where the error body is freely discarded); the out-of-retries passthrough
   response would need read+reconstruct to also keyword-ban there.
4. Implement `DisableChannel` as an off-path (wait_until/Queue/DO) status write
   to `AutoDisabled`, multi-key aware, plus channel/ability cache invalidation
   and optional root notification.
5. Distinguish `AutoDisabled` vs manual `Disabled`; implement
   `ShouldEnableChannel` recovery via the channel-test path only.
6. Record error logs for banned/failed attempts with channel/error metadata
   (`IsRecordErrorLog`), redacted.
7. Add Go<->Rust fixtures for retry decisions, ban decisions (status + keyword),
   per-key ban, and recovery eligibility.

## Wire-In

- `docs/source-channel-selection-parity.md` (retry->channel mapping; ban must
  invalidate the selection cache).
- `docs/route-provider-parity-runbook.md` Provider Adapter Contract
  (error mapping / auto-ban / retry) and `docs/production-readiness-matrices.md`
  G3 + channel-admin rows reference this file.
- Off-path ban writes follow the cache/rate-limit plan (DO/Queue,
  migration-plan §21.2/§21.5).
