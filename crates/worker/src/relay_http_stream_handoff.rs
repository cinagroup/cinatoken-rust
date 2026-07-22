//! Default-off durable terminal handoff for ordinary HTTP SSE relays.

use serde::Serialize;
use sha2::{Digest, Sha256};
use worker::{D1Database, Env};

use crate::d1_repositories::{
    claim_relay_http_stream_outbox, dead_letter_relay_http_stream_outbox,
    mark_relay_http_stream_finalization_applied, mark_relay_http_stream_outbox_delivered,
    reconcile_relay_http_stream_finalization_handoffs, relay_http_stream_handoff_schema_ready,
    relay_http_stream_outbox_due_candidates, retry_relay_http_stream_outbox,
    sweep_expired_relay_http_stream_handoffs, RelayHttpStreamHandoffTransitionOutcome,
    RelayHttpStreamOutboxClaimOutcome, RelayHttpStreamOutboxLease,
};
use crate::relay_billing_queue::{RelayBillingFinalizationEvent, BILLING_QUEUE_BINDING};

pub const RELAY_HTTP_STREAM_DURABLE_HANDOFF_ENABLED_ENV: &str =
    "RELAY_HTTP_STREAM_DURABLE_HANDOFF_ENABLED";
pub const RELAY_HTTP_STREAM_DURABLE_HANDOFF_STAGING_VERIFIED_ENV: &str =
    "RELAY_HTTP_STREAM_DURABLE_HANDOFF_STAGING_VERIFIED";
pub const RELAY_HTTP_STREAM_OUTBOX_ENABLED_ENV: &str = "RELAY_HTTP_STREAM_OUTBOX_ENABLED";
pub const RELAY_HTTP_STREAM_RECOVERY_ENABLED_ENV: &str = "RELAY_HTTP_STREAM_RECOVERY_ENABLED";

const HTTP_STREAM_HANDOFF_SCAN_LIMIT: i64 = 16;
const HTTP_STREAM_OUTBOX_LEASE_SECONDS: i64 = 30;
const HTTP_STREAM_OUTBOX_MAX_ATTEMPTS: i64 = 8;
const HTTP_STREAM_OUTBOX_RETRY_BASE_SECONDS: i64 = 15;
const HTTP_STREAM_OUTBOX_RETRY_MAX_SECONDS: i64 = 3_600;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RelayHttpStreamHandoffRuntimeConfig {
    pub configured: bool,
    pub valid: bool,
    pub requested: bool,
    pub staging_verified: bool,
    pub handoff_enabled: bool,
    pub outbox_requested: bool,
    pub outbox_enabled: bool,
    pub recovery_requested: bool,
    pub recovery_enabled: bool,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct RelayHttpStreamHandoffScheduledSummary {
    pub outbox_candidates: u32,
    pub outbox_claimed: u32,
    pub outbox_enqueued: u32,
    pub outbox_retried: u32,
    pub outbox_dead_lettered: u32,
    pub outbox_skipped: u32,
    pub outbox_conflicts: u32,
    pub outbox_failed: u32,
    pub expired_forwarding_recovered: u32,
    pub applied_finalizations_reconciled: u32,
}

pub fn relay_http_stream_handoff_runtime_config(env: &Env) -> RelayHttpStreamHandoffRuntimeConfig {
    parse_relay_http_stream_handoff_runtime_config(
        runtime_value(env, RELAY_HTTP_STREAM_DURABLE_HANDOFF_ENABLED_ENV).as_deref(),
        runtime_value(env, RELAY_HTTP_STREAM_DURABLE_HANDOFF_STAGING_VERIFIED_ENV).as_deref(),
        runtime_value(env, RELAY_HTTP_STREAM_OUTBOX_ENABLED_ENV).as_deref(),
        runtime_value(env, RELAY_HTTP_STREAM_RECOVERY_ENABLED_ENV).as_deref(),
    )
}

pub fn relay_http_stream_handoff_compiled() -> bool {
    HTTP_STREAM_HANDOFF_SCAN_LIMIT > 0
        && HTTP_STREAM_HANDOFF_SCAN_LIMIT <= 64
        && (15..=60).contains(&HTTP_STREAM_OUTBOX_LEASE_SECONDS)
        && HTTP_STREAM_OUTBOX_MAX_ATTEMPTS > 0
        && HTTP_STREAM_OUTBOX_RETRY_BASE_SECONDS > 0
        && HTTP_STREAM_OUTBOX_RETRY_MAX_SECONDS <= 3_600
}

pub async fn run_relay_http_stream_handoff_scheduled(
    env: &Env,
    db: &D1Database,
    now: i64,
) -> worker::Result<RelayHttpStreamHandoffScheduledSummary> {
    let config = relay_http_stream_handoff_runtime_config(env);
    if !config.valid || (!config.outbox_enabled && !config.recovery_enabled) {
        return Err(handoff_error(
            "relay HTTP stream scheduled recovery is not enabled with verified configuration",
        ));
    }
    if !relay_http_stream_handoff_schema_ready(db).await? {
        return Err(handoff_error(
            "relay HTTP stream handoff schema is unavailable",
        ));
    }
    let mut summary = RelayHttpStreamHandoffScheduledSummary::default();
    if config.outbox_enabled {
        run_outbox(env, db, now, &mut summary).await?;
    }
    if config.recovery_enabled {
        summary.expired_forwarding_recovered = u32::try_from(
            sweep_expired_relay_http_stream_handoffs(db, now, HTTP_STREAM_HANDOFF_SCAN_LIMIT)
                .await?,
        )
        .unwrap_or(u32::MAX);
        summary.applied_finalizations_reconciled = u32::try_from(
            reconcile_relay_http_stream_finalization_handoffs(
                db,
                now,
                HTTP_STREAM_HANDOFF_SCAN_LIMIT,
            )
            .await?,
        )
        .unwrap_or(u32::MAX);
    }
    Ok(summary)
}

async fn run_outbox(
    env: &Env,
    db: &D1Database,
    now: i64,
    summary: &mut RelayHttpStreamHandoffScheduledSummary,
) -> worker::Result<()> {
    let candidates =
        relay_http_stream_outbox_due_candidates(db, now, HTTP_STREAM_HANDOFF_SCAN_LIMIT).await?;
    summary.outbox_candidates = u32::try_from(candidates.len()).unwrap_or(u32::MAX);
    for candidate in candidates {
        let claim = match claim_relay_http_stream_outbox(
            db,
            &candidate.reservation_key,
            now,
            HTTP_STREAM_OUTBOX_LEASE_SECONDS,
        )
        .await
        {
            Ok(claim) => claim,
            Err(err) => {
                worker::console_error!("relay HTTP stream outbox claim failed: {err}");
                summary.outbox_failed = summary.outbox_failed.saturating_add(1);
                continue;
            }
        };
        let lease = match claim {
            RelayHttpStreamOutboxClaimOutcome::Applied(lease) => {
                summary.outbox_claimed = summary.outbox_claimed.saturating_add(1);
                lease
            }
            RelayHttpStreamOutboxClaimOutcome::NotFound
            | RelayHttpStreamOutboxClaimOutcome::NotDue
            | RelayHttpStreamOutboxClaimOutcome::AlreadyLeased
            | RelayHttpStreamOutboxClaimOutcome::Terminal => {
                summary.outbox_skipped = summary.outbox_skipped.saturating_add(1);
                continue;
            }
            RelayHttpStreamOutboxClaimOutcome::Conflict => {
                summary.outbox_conflicts = summary.outbox_conflicts.saturating_add(1);
                continue;
            }
        };
        deliver_outbox_lease(env, db, lease, summary).await;
    }
    Ok(())
}

async fn deliver_outbox_lease(
    env: &Env,
    db: &D1Database,
    lease: RelayHttpStreamOutboxLease,
    summary: &mut RelayHttpStreamHandoffScheduledSummary,
) {
    let event = match decode_outbox_event(&lease) {
        Ok(event) => event,
        Err(code) => {
            dead_letter_lease(db, &lease, code, summary).await;
            return;
        }
    };
    let queue = match env.queue(BILLING_QUEUE_BINDING) {
        Ok(queue) => queue,
        Err(_) => {
            retry_or_dead_letter_lease(db, &lease, "queue_binding_unavailable", summary).await;
            return;
        }
    };
    if queue.send(&event).await.is_err() {
        retry_or_dead_letter_lease(db, &lease, "queue_send_failed", summary).await;
        return;
    }
    let now = current_unix_seconds();
    match mark_relay_http_stream_outbox_delivered(db, &lease, now).await {
        Ok(RelayHttpStreamHandoffTransitionOutcome::Applied) => {
            summary.outbox_enqueued = summary.outbox_enqueued.saturating_add(1)
        }
        Ok(RelayHttpStreamHandoffTransitionOutcome::MatchingReplay)
        | Ok(RelayHttpStreamHandoffTransitionOutcome::Terminal)
        | Ok(RelayHttpStreamHandoffTransitionOutcome::NotFound) => {
            summary.outbox_skipped = summary.outbox_skipped.saturating_add(1)
        }
        Ok(RelayHttpStreamHandoffTransitionOutcome::StaleGeneration)
        | Ok(RelayHttpStreamHandoffTransitionOutcome::Conflict) => {
            summary.outbox_conflicts = summary.outbox_conflicts.saturating_add(1)
        }
        Err(err) => {
            worker::console_error!("relay HTTP stream outbox enqueue completion failed: {err}");
            summary.outbox_failed = summary.outbox_failed.saturating_add(1);
        }
    }
}

fn decode_outbox_event(
    lease: &RelayHttpStreamOutboxLease,
) -> Result<RelayBillingFinalizationEvent, &'static str> {
    let digest = format!(
        "{:x}",
        Sha256::digest(lease.finalization_event_json.as_bytes())
    );
    if digest != lease.finalization_event_sha256 {
        return Err("event_digest_mismatch");
    }
    let event: RelayBillingFinalizationEvent =
        serde_json::from_str(&lease.finalization_event_json).map_err(|_| "event_invalid")?;
    event.validate().map_err(|_| "event_invalid")?;
    if event.reservation_key != lease.reservation_key
        || event.owner_generation != lease.owner_generation
    {
        return Err("event_identity_conflict");
    }
    Ok(event)
}

async fn retry_or_dead_letter_lease(
    db: &D1Database,
    lease: &RelayHttpStreamOutboxLease,
    code: &'static str,
    summary: &mut RelayHttpStreamHandoffScheduledSummary,
) {
    if lease.delivery_attempt_count >= HTTP_STREAM_OUTBOX_MAX_ATTEMPTS {
        dead_letter_lease(db, lease, code, summary).await;
        return;
    }
    let now = current_unix_seconds();
    let available_at = now.saturating_add(outbox_retry_delay(lease.delivery_attempt_count));
    match retry_relay_http_stream_outbox(db, lease, code, available_at, now).await {
        Ok(RelayHttpStreamHandoffTransitionOutcome::Applied) => {
            summary.outbox_retried = summary.outbox_retried.saturating_add(1)
        }
        Ok(RelayHttpStreamHandoffTransitionOutcome::MatchingReplay)
        | Ok(RelayHttpStreamHandoffTransitionOutcome::Terminal)
        | Ok(RelayHttpStreamHandoffTransitionOutcome::NotFound) => {
            summary.outbox_skipped = summary.outbox_skipped.saturating_add(1)
        }
        Ok(RelayHttpStreamHandoffTransitionOutcome::StaleGeneration)
        | Ok(RelayHttpStreamHandoffTransitionOutcome::Conflict) => {
            summary.outbox_conflicts = summary.outbox_conflicts.saturating_add(1)
        }
        Err(err) => {
            worker::console_error!("relay HTTP stream outbox retry transition failed: {err}");
            summary.outbox_failed = summary.outbox_failed.saturating_add(1);
        }
    }
}

async fn dead_letter_lease(
    db: &D1Database,
    lease: &RelayHttpStreamOutboxLease,
    code: &'static str,
    summary: &mut RelayHttpStreamHandoffScheduledSummary,
) {
    let now = current_unix_seconds();
    match dead_letter_relay_http_stream_outbox(db, lease, code, now).await {
        Ok(RelayHttpStreamHandoffTransitionOutcome::Applied) => {
            summary.outbox_dead_lettered = summary.outbox_dead_lettered.saturating_add(1)
        }
        Ok(RelayHttpStreamHandoffTransitionOutcome::MatchingReplay)
        | Ok(RelayHttpStreamHandoffTransitionOutcome::Terminal)
        | Ok(RelayHttpStreamHandoffTransitionOutcome::NotFound) => {
            summary.outbox_skipped = summary.outbox_skipped.saturating_add(1)
        }
        Ok(RelayHttpStreamHandoffTransitionOutcome::StaleGeneration)
        | Ok(RelayHttpStreamHandoffTransitionOutcome::Conflict) => {
            summary.outbox_conflicts = summary.outbox_conflicts.saturating_add(1)
        }
        Err(err) => {
            worker::console_error!("relay HTTP stream outbox dead-letter failed: {err}");
            summary.outbox_failed = summary.outbox_failed.saturating_add(1);
        }
    }
}

pub async fn observe_applied_finalization(
    db: &D1Database,
    event: &RelayBillingFinalizationEvent,
    now: i64,
) -> worker::Result<RelayHttpStreamHandoffTransitionOutcome> {
    let event_json = serde_json::to_string(event)
        .map_err(|_| handoff_error("relay HTTP stream finalization cannot be serialized"))?;
    let event_sha256 = format!("{:x}", Sha256::digest(event_json.as_bytes()));
    mark_relay_http_stream_finalization_applied(
        db,
        &event.reservation_key,
        event.owner_generation,
        &event.event_id,
        &event_sha256,
        now,
    )
    .await
}

fn outbox_retry_delay(attempt_count: i64) -> i64 {
    let exponent = attempt_count.saturating_sub(1).clamp(0, 8) as u32;
    HTTP_STREAM_OUTBOX_RETRY_BASE_SECONDS
        .saturating_mul(1_i64 << exponent)
        .min(HTTP_STREAM_OUTBOX_RETRY_MAX_SECONDS)
}

fn parse_relay_http_stream_handoff_runtime_config(
    handoff_enabled: Option<&str>,
    staging_verified: Option<&str>,
    outbox_enabled: Option<&str>,
    recovery_enabled: Option<&str>,
) -> RelayHttpStreamHandoffRuntimeConfig {
    let values = [
        handoff_enabled,
        staging_verified,
        outbox_enabled,
        recovery_enabled,
    ];
    let configured = values.iter().all(Option::is_some);
    let valid = configured
        && values
            .iter()
            .all(|value| matches!(value, Some("true" | "false")));
    let requested = handoff_enabled == Some("true");
    let staging_verified = staging_verified == Some("true");
    let outbox_requested = outbox_enabled == Some("true");
    let recovery_requested = recovery_enabled == Some("true");
    let handoff_enabled = valid && requested && staging_verified;
    RelayHttpStreamHandoffRuntimeConfig {
        configured,
        valid,
        requested,
        staging_verified,
        handoff_enabled,
        outbox_requested,
        outbox_enabled: valid && staging_verified && outbox_requested,
        recovery_requested,
        recovery_enabled: valid && staging_verified && recovery_requested,
    }
}

fn runtime_value(env: &Env, name: &str) -> Option<String> {
    env.var(name).ok().map(|value| value.to_string())
}

fn current_unix_seconds() -> i64 {
    i64::try_from(worker::Date::now().as_millis() / 1_000).unwrap_or(i64::MAX)
}

fn handoff_error(message: &str) -> worker::Error {
    worker::Error::RustError(message.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_authority_requires_handoff_and_staging_evidence() {
        let disabled = parse_relay_http_stream_handoff_runtime_config(
            Some("false"),
            Some("false"),
            Some("false"),
            Some("false"),
        );
        assert!(disabled.configured);
        assert!(disabled.valid);
        assert!(!disabled.handoff_enabled);

        let unverified = parse_relay_http_stream_handoff_runtime_config(
            Some("true"),
            Some("false"),
            Some("true"),
            Some("true"),
        );
        assert!(unverified.valid);
        assert!(!unverified.handoff_enabled);
        assert!(!unverified.outbox_enabled);
        assert!(!unverified.recovery_enabled);

        let drain_only = parse_relay_http_stream_handoff_runtime_config(
            Some("false"),
            Some("true"),
            Some("true"),
            Some("true"),
        );
        assert!(!drain_only.handoff_enabled);
        assert!(drain_only.outbox_enabled);
        assert!(drain_only.recovery_enabled);
        assert!(!unverified.outbox_enabled);
        assert!(!unverified.recovery_enabled);

        let verified = parse_relay_http_stream_handoff_runtime_config(
            Some("true"),
            Some("true"),
            Some("true"),
            Some("true"),
        );
        assert!(verified.handoff_enabled);
        assert!(verified.outbox_enabled);
        assert!(verified.recovery_enabled);
    }

    #[test]
    fn runtime_authority_rejects_ambiguous_boolean_values() {
        for values in [
            (Some("TRUE"), Some("true"), Some("true"), Some("true")),
            (Some("true"), Some("yes"), Some("true"), Some("true")),
            (Some("true"), Some("true"), None, Some("true")),
            (Some("true"), Some("true"), Some("true"), Some("1")),
        ] {
            let parsed = parse_relay_http_stream_handoff_runtime_config(
                values.0, values.1, values.2, values.3,
            );
            assert!(!parsed.valid);
            assert!(!parsed.handoff_enabled);
            assert!(!parsed.outbox_enabled);
            assert!(!parsed.recovery_enabled);
        }
    }

    #[test]
    fn outbox_retry_policy_is_bounded() {
        assert_eq!(outbox_retry_delay(0), 15);
        assert_eq!(outbox_retry_delay(1), 15);
        assert_eq!(outbox_retry_delay(2), 30);
        assert_eq!(outbox_retry_delay(3), 60);
        assert_eq!(outbox_retry_delay(100), 3_600);
    }

    #[test]
    fn tracked_runtime_authorities_are_false_in_every_environment() {
        let config = include_str!("../../../wrangler.toml").replace("\r\n", "\n");
        let (default, environment_overrides) = config.split_once("\n[env.staging]\n").unwrap();
        let (staging, production) = environment_overrides
            .split_once("\n[env.production]\n")
            .unwrap();
        for scope in [default, staging, production] {
            for name in [
                RELAY_HTTP_STREAM_DURABLE_HANDOFF_ENABLED_ENV,
                RELAY_HTTP_STREAM_DURABLE_HANDOFF_STAGING_VERIFIED_ENV,
                RELAY_HTTP_STREAM_OUTBOX_ENABLED_ENV,
                RELAY_HTTP_STREAM_RECOVERY_ENABLED_ENV,
            ] {
                assert!(scope.contains(&format!("{name} = \"false\"")));
                assert!(!scope.contains(&format!("{name} = \"true\"")));
            }
        }
    }
}
