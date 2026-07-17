//! Default-off delivery of immutable D1 terminal events to the owning shard DO.

use cinatoken_sharding::ShardPlan;
use serde::Serialize;
use worker::{D1Database, Env};

use crate::container_controller::{
    acknowledge_terminal_event, ContainerTerminalAckEnvelope, ContainerTerminalAckOutcome,
    ContainerTerminalAckResult,
};
use crate::d1_repositories::{
    claim_relay_container_terminal_outbox, dead_letter_relay_container_terminal_outbox,
    mark_relay_container_terminal_outbox_delivered, relay_container_terminal_outbox_due_candidates,
    relay_container_terminal_outbox_schema_ready, retry_relay_container_terminal_outbox,
    RelayContainerTerminalOutboxClaimOutcome, RelayContainerTerminalOutboxLease,
    RelayContainerTerminalOutboxTransitionOutcome,
};

pub const CONTAINER_TERMINAL_OUTBOX_ENABLED_ENV: &str = "CONTAINER_TERMINAL_OUTBOX_ENABLED";
pub const CONTAINER_TERMINAL_OUTBOX_STAGING_VERIFIED_ENV: &str =
    "CONTAINER_TERMINAL_OUTBOX_STAGING_VERIFIED";
pub const CONTAINER_TERMINAL_OUTBOX_SCAN_LIMIT_ENV: &str = "CONTAINER_TERMINAL_OUTBOX_SCAN_LIMIT";
pub const DEFAULT_CONTAINER_TERMINAL_OUTBOX_SCAN_LIMIT: u32 = 4;
pub const MAX_CONTAINER_TERMINAL_OUTBOX_SCAN_LIMIT: u32 = 8;
pub const CONTAINER_TERMINAL_OUTBOX_LEASE_SECONDS: i64 = 30;
const CONTAINER_TERMINAL_OUTBOX_RETRY_BASE_SECONDS: i64 = 15;
const CONTAINER_TERMINAL_OUTBOX_RETRY_MAX_SECONDS: i64 = 3_600;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ContainerTerminalOutboxRuntimeConfig {
    pub configured: bool,
    pub valid: bool,
    pub requested: bool,
    pub staging_verified: bool,
    pub enabled: bool,
    pub scan_limit: u32,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct ContainerTerminalOutboxSummary {
    pub candidates: u32,
    pub claimed: u32,
    pub delivered: u32,
    pub duplicates: u32,
    pub retried: u32,
    pub dead_lettered: u32,
    pub skipped: u32,
    pub conflicts: u32,
    pub failed: u32,
}

pub fn container_terminal_outbox_runtime_config(env: &Env) -> ContainerTerminalOutboxRuntimeConfig {
    let enabled = runtime_value(env, CONTAINER_TERMINAL_OUTBOX_ENABLED_ENV);
    let staging_verified = runtime_value(env, CONTAINER_TERMINAL_OUTBOX_STAGING_VERIFIED_ENV);
    let scan_limit = runtime_value(env, CONTAINER_TERMINAL_OUTBOX_SCAN_LIMIT_ENV);
    parse_container_terminal_outbox_runtime_config(
        enabled.as_deref(),
        staging_verified.as_deref(),
        scan_limit.as_deref(),
    )
}

pub fn container_terminal_outbox_compiled() -> bool {
    DEFAULT_CONTAINER_TERMINAL_OUTBOX_SCAN_LIMIT > 0
        && MAX_CONTAINER_TERMINAL_OUTBOX_SCAN_LIMIT <= 8
        && CONTAINER_TERMINAL_OUTBOX_LEASE_SECONDS >= 15
        && CONTAINER_TERMINAL_OUTBOX_LEASE_SECONDS <= 60
        && CONTAINER_TERMINAL_OUTBOX_RETRY_BASE_SECONDS > 0
        && CONTAINER_TERMINAL_OUTBOX_RETRY_MAX_SECONDS <= 3_600
}

pub fn container_terminal_outbox_retry_delay(attempt_count: i64) -> i64 {
    let exponent = attempt_count.saturating_sub(1).clamp(0, 8) as u32;
    CONTAINER_TERMINAL_OUTBOX_RETRY_BASE_SECONDS
        .saturating_mul(1_i64 << exponent)
        .min(CONTAINER_TERMINAL_OUTBOX_RETRY_MAX_SECONDS)
}

pub async fn run_container_terminal_outbox(
    env: &Env,
    db: &D1Database,
    now: i64,
) -> worker::Result<ContainerTerminalOutboxSummary> {
    let config = container_terminal_outbox_runtime_config(env);
    if !config.valid || !config.enabled {
        return Err(outbox_error(
            "container terminal outbox is not enabled with a verified configuration",
        ));
    }
    if !relay_container_terminal_outbox_schema_ready(db).await? {
        return Err(outbox_error(
            "container terminal outbox schema is unavailable",
        ));
    }
    let candidates =
        relay_container_terminal_outbox_due_candidates(db, now, i64::from(config.scan_limit))
            .await?;
    let mut summary = ContainerTerminalOutboxSummary {
        candidates: u32::try_from(candidates.len()).unwrap_or(u32::MAX),
        ..ContainerTerminalOutboxSummary::default()
    };
    for candidate in candidates {
        let claim = match claim_relay_container_terminal_outbox(
            db,
            &candidate.billing_event_id,
            now,
            CONTAINER_TERMINAL_OUTBOX_LEASE_SECONDS,
        )
        .await
        {
            Ok(claim) => claim,
            Err(err) => {
                worker::console_error!("container terminal outbox claim failed: {err}");
                summary.failed = summary.failed.saturating_add(1);
                continue;
            }
        };
        let lease = match claim {
            RelayContainerTerminalOutboxClaimOutcome::Applied(lease) => {
                summary.claimed = summary.claimed.saturating_add(1);
                lease
            }
            RelayContainerTerminalOutboxClaimOutcome::NotDue
            | RelayContainerTerminalOutboxClaimOutcome::AlreadyLeased
            | RelayContainerTerminalOutboxClaimOutcome::Terminal => {
                summary.skipped = summary.skipped.saturating_add(1);
                continue;
            }
            RelayContainerTerminalOutboxClaimOutcome::Conflict => {
                summary.conflicts = summary.conflicts.saturating_add(1);
                continue;
            }
        };
        deliver_terminal_outbox_lease(env, db, lease, &mut summary).await;
    }
    Ok(summary)
}

async fn deliver_terminal_outbox_lease(
    env: &Env,
    db: &D1Database,
    lease: RelayContainerTerminalOutboxLease,
    summary: &mut ContainerTerminalOutboxSummary,
) {
    let envelope = match terminal_ack_envelope(&lease) {
        Ok(envelope) => envelope,
        Err(code) => {
            let now = current_unix_seconds();
            match dead_letter_relay_container_terminal_outbox(db, &lease, code, now).await {
                Ok(outcome) => record_transition(summary, outcome, TransitionKind::DeadLetter),
                Err(err) => {
                    worker::console_error!(
                        "container terminal outbox local-contract dead-letter failed: {err}"
                    );
                    summary.failed = summary.failed.saturating_add(1);
                }
            }
            return;
        }
    };
    let delivery = acknowledge_terminal_event(env, &envelope).await;
    let now = current_unix_seconds();
    match delivery {
        Ok(outcome) => {
            let duplicate = matches!(outcome, ContainerTerminalAckOutcome::Duplicate { .. });
            match mark_relay_container_terminal_outbox_delivered(db, &lease, now).await {
                Ok(transition) => {
                    record_transition(summary, transition, TransitionKind::Delivered);
                    if duplicate
                        && matches!(
                            transition,
                            RelayContainerTerminalOutboxTransitionOutcome::Applied
                        )
                    {
                        summary.duplicates = summary.duplicates.saturating_add(1);
                    }
                }
                Err(err) => {
                    worker::console_error!(
                        "container terminal outbox delivery completion failed: {err}"
                    );
                    summary.failed = summary.failed.saturating_add(1);
                }
            }
        }
        Err(error) if error.retryable() => {
            let available_at = now.saturating_add(container_terminal_outbox_retry_delay(
                lease.delivery_attempt_count,
            ));
            match retry_relay_container_terminal_outbox(db, &lease, available_at, error.code(), now)
                .await
            {
                Ok(transition) => record_transition(summary, transition, TransitionKind::Retry),
                Err(err) => {
                    worker::console_error!("container terminal outbox retry failed: {err}");
                    summary.failed = summary.failed.saturating_add(1);
                }
            }
        }
        Err(error) => {
            match dead_letter_relay_container_terminal_outbox(db, &lease, error.code(), now).await {
                Ok(transition) => {
                    record_transition(summary, transition, TransitionKind::DeadLetter)
                }
                Err(err) => {
                    worker::console_error!("container terminal outbox dead-letter failed: {err}");
                    summary.failed = summary.failed.saturating_add(1);
                }
            }
        }
    }
}

fn terminal_ack_envelope(
    lease: &RelayContainerTerminalOutboxLease,
) -> Result<ContainerTerminalAckEnvelope, &'static str> {
    let operation = &lease.operation;
    let receipt = &lease.receipt;
    let result = match lease.terminal_ack.result.as_ref() {
        Some(result) => Some(ContainerTerminalAckResult {
            object_key: result.object_key.clone(),
            object_version: result.object_version.clone(),
            sha256: result.sha256.clone(),
            size: u64::try_from(result.size).map_err(|_| "invalid_result_size")?,
            content_type: result.content_type.clone(),
        }),
        None => None,
    };
    Ok(ContainerTerminalAckEnvelope {
        protocol_version: u32::try_from(operation.protocol_version)
            .map_err(|_| "invalid_protocol_version")?,
        billing_event_id: lease.billing_event_id.clone(),
        terminal_contract_sha256: receipt.terminal_contract_sha256.clone(),
        reconciliation_id: receipt.reconciliation_id.clone(),
        reconciliation_revision: receipt.reconciliation_revision,
        predecessor_billing_event_id: lease.predecessor_billing_event_id.clone(),
        operation_id: operation.operation_id.clone(),
        owner_generation: operation.owner_generation,
        operation_from_status: receipt.operation_from_status.clone(),
        operation_status: receipt.operation_status.clone(),
        response_status: lease.terminal_ack.response_status,
        response_code: lease.terminal_ack.response_code.clone(),
        result,
        shard: ShardPlan {
            contract_version: u32::try_from(operation.shard_contract_version)
                .map_err(|_| "invalid_shard_contract_version")?,
            ring_generation: u64::try_from(operation.ring_generation)
                .map_err(|_| "invalid_ring_generation")?,
            shard_count: u16::try_from(operation.shard_count).map_err(|_| "invalid_shard_count")?,
            shard_index: u16::try_from(operation.shard_index).map_err(|_| "invalid_shard_index")?,
            instance_name: operation.instance_name.clone(),
        },
        trace_id: operation.trace_id.clone(),
    })
}

#[derive(Debug, Clone, Copy)]
enum TransitionKind {
    Delivered,
    Retry,
    DeadLetter,
}

fn record_transition(
    summary: &mut ContainerTerminalOutboxSummary,
    outcome: RelayContainerTerminalOutboxTransitionOutcome,
    kind: TransitionKind,
) {
    match outcome {
        RelayContainerTerminalOutboxTransitionOutcome::Applied => match kind {
            TransitionKind::Delivered => summary.delivered = summary.delivered.saturating_add(1),
            TransitionKind::Retry => summary.retried = summary.retried.saturating_add(1),
            TransitionKind::DeadLetter => {
                summary.dead_lettered = summary.dead_lettered.saturating_add(1)
            }
        },
        RelayContainerTerminalOutboxTransitionOutcome::StaleLease
        | RelayContainerTerminalOutboxTransitionOutcome::Terminal => {
            summary.skipped = summary.skipped.saturating_add(1)
        }
        RelayContainerTerminalOutboxTransitionOutcome::Conflict => {
            summary.conflicts = summary.conflicts.saturating_add(1)
        }
    }
}

fn current_unix_seconds() -> i64 {
    i64::try_from(worker::Date::now().as_millis() / 1_000).unwrap_or(i64::MAX)
}

fn outbox_error(message: &str) -> worker::Error {
    worker::Error::RustError(message.to_string())
}

fn parse_container_terminal_outbox_runtime_config(
    enabled: Option<&str>,
    staging_verified: Option<&str>,
    scan_limit: Option<&str>,
) -> ContainerTerminalOutboxRuntimeConfig {
    let configured = enabled.is_some() && staging_verified.is_some() && scan_limit.is_some();
    let requested = enabled == Some("true");
    let staging_verified_enabled = staging_verified == Some("true");
    let booleans_valid = matches!(enabled, Some("true" | "false"))
        && matches!(staging_verified, Some("true" | "false"));
    let parsed_scan_limit = scan_limit.and_then(|value| value.parse::<u32>().ok());
    let scan_limit_valid = parsed_scan_limit
        .is_some_and(|value| (1..=MAX_CONTAINER_TERMINAL_OUTBOX_SCAN_LIMIT).contains(&value));
    let valid = configured && booleans_valid && scan_limit_valid;
    ContainerTerminalOutboxRuntimeConfig {
        configured,
        valid,
        requested,
        staging_verified: staging_verified_enabled,
        enabled: valid && requested && staging_verified_enabled,
        scan_limit: parsed_scan_limit
            .filter(|value| (1..=MAX_CONTAINER_TERMINAL_OUTBOX_SCAN_LIMIT).contains(value))
            .unwrap_or(DEFAULT_CONTAINER_TERMINAL_OUTBOX_SCAN_LIMIT),
    }
}

fn runtime_value(env: &Env, name: &str) -> Option<String> {
    env.var(name).ok().map(|value| value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_outbox_requires_both_runtime_gates() {
        let disabled =
            parse_container_terminal_outbox_runtime_config(Some("false"), Some("false"), Some("4"));
        assert!(disabled.configured);
        assert!(disabled.valid);
        assert!(!disabled.enabled);

        let unverified =
            parse_container_terminal_outbox_runtime_config(Some("true"), Some("false"), Some("4"));
        assert!(unverified.valid);
        assert!(unverified.requested);
        assert!(!unverified.enabled);

        let enabled =
            parse_container_terminal_outbox_runtime_config(Some("true"), Some("true"), Some("8"));
        assert!(enabled.valid);
        assert!(enabled.enabled);
        assert_eq!(enabled.scan_limit, 8);
    }

    #[test]
    fn terminal_outbox_rejects_ambiguous_or_unbounded_configuration() {
        for config in [
            (Some("TRUE"), Some("true"), Some("4")),
            (Some("true"), Some("yes"), Some("4")),
            (Some("true"), Some("true"), Some("0")),
            (Some("true"), Some("true"), Some("9")),
            (Some("true"), Some("true"), Some("four")),
            (None, Some("true"), Some("4")),
        ] {
            let parsed =
                parse_container_terminal_outbox_runtime_config(config.0, config.1, config.2);
            assert!(!parsed.valid);
            assert!(!parsed.enabled);
        }
    }

    #[test]
    fn terminal_outbox_retry_backoff_is_bounded_and_deterministic() {
        assert_eq!(container_terminal_outbox_retry_delay(0), 15);
        assert_eq!(container_terminal_outbox_retry_delay(1), 15);
        assert_eq!(container_terminal_outbox_retry_delay(2), 30);
        assert_eq!(container_terminal_outbox_retry_delay(3), 60);
        assert_eq!(container_terminal_outbox_retry_delay(100), 3_600);
    }

    #[test]
    fn tracked_terminal_outbox_gates_are_false_in_every_environment() {
        let config = include_str!("../../../wrangler.toml").replace("\r\n", "\n");
        let (default, environment_overrides) = config.split_once("\n[env.staging]\n").unwrap();
        let (staging, production) = environment_overrides
            .split_once("\n[env.production]\n")
            .unwrap();
        for scope in [default, staging, production] {
            assert!(scope.contains("CONTAINER_TERMINAL_OUTBOX_ENABLED = \"false\""));
            assert!(scope.contains("CONTAINER_TERMINAL_OUTBOX_STAGING_VERIFIED = \"false\""));
            assert!(scope.contains("CONTAINER_TERMINAL_OUTBOX_SCAN_LIMIT = \"4\""));
            assert!(!scope.contains("CONTAINER_TERMINAL_OUTBOX_ENABLED = \"true\""));
            assert!(!scope.contains("CONTAINER_TERMINAL_OUTBOX_STAGING_VERIFIED = \"true\""));
        }
    }
}
