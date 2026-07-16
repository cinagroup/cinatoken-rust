//! Default-off Container cross-store replay, observation, and divergence classification.

use cinatoken_sharding::ShardPlan;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use worker::{D1Database, Env, Response};

use crate::container_artifacts::{
    inspect_container_client_response, read_verified_container_client_response,
    validate_container_client_response_manifest, ContainerArtifactManifest,
    ContainerClientResponseManifest, ContainerClientResponseObjectState,
};
use crate::container_controller::{
    query_operation_status, ContainerOperationEnvelope, ContainerOperationInput,
    ContainerOperationOutcome, ContainerOperationStatus,
};
use crate::d1_repositories::{
    advance_relay_container_reconciliation_cursor, claim_relay_container_reconciliation,
    claim_relay_container_reconciliation_run, complete_relay_container_reconciliation_run,
    record_relay_container_reconciliation, relay_container_financial_receipt_integrity_valid,
    relay_container_financial_terminal_receipt_for_operation, relay_container_operation,
    relay_container_reconciliation_candidates, relay_container_reconciliation_schema_ready,
    RelayContainerFinancialTerminalReceipt, RelayContainerOperation,
    RelayContainerReconciliationClaimOutcome, RelayContainerReconciliationLease,
    RelayContainerReconciliationRecord, RelayContainerReconciliationRecordOutcome,
    RelayContainerReconciliationRunClaimOutcome, RelayContainerReconciliationRunLease,
};

pub const CONTAINER_RECONCILIATION_SCAN_LIMIT_ENV: &str = "CONTAINER_RECONCILIATION_SCAN_LIMIT";
const DEFAULT_CONTAINER_RECONCILIATION_SCAN_LIMIT: i64 = 4;
const MAX_CONTAINER_RECONCILIATION_SCAN_LIMIT: i64 = 8;
const CONTAINER_RECONCILIATION_RUN_LEASE_SECONDS: i64 = 45;
const CONTAINER_RECONCILIATION_ITEM_LEASE_SECONDS: i64 = 30;
const CONTAINER_RECONCILIATION_WALL_BUDGET_MILLIS: u64 = 25_000;
const CONTAINER_RECONCILIATION_RETRY_HORIZON_SECONDS: i64 = 86_400;
const CONTAINER_RECONCILIATION_RETRY_BASE_SECONDS: i64 = 15;
const CONTAINER_RECONCILIATION_RETRY_MAX_SECONDS: i64 = 900;
const CONTAINER_RECONCILIATION_BACKOFF_DOMAIN: &[u8] =
    b"cinatoken:container-reconciliation-backoff:v1\0";
pub(crate) const CONTAINER_RECONCILIATION_DEAD_LETTER_REASONS: &[&str] = &[
    "retry_horizon_exhausted",
    "terminal_conflict",
    "terminal_response_divergent",
    "response_r2_orphan",
    "legacy_terminal_without_receipt",
    "contract_violation",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContainerD1Observation {
    Prepared,
    Dispatched,
    RecoveryRequired,
    TerminalWithReceipt,
    LegacyTerminalWithoutReceipt,
    ContractViolation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContainerDoObservation {
    Unavailable,
    ContractViolation,
    NotFound,
    Claimed,
    Running,
    RecoveryRequired,
    MatchingTerminal,
    DefinitiveTerminal,
    ConflictingTerminal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContainerResponseObservation {
    NotExpected,
    Unavailable,
    Missing,
    Matching,
    Divergent,
    Orphan,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContainerDivergenceClass {
    ConvergedReplayable,
    PreparedDoAbsent,
    DispatchedDoAbsent,
    PendingDoClaimed,
    PendingDoRunning,
    D1LaggingDispatch,
    D1LaggingTerminal,
    RecoveryDoAbsent,
    RecoveryPending,
    RecoveryResolvable,
    TerminalDoAbsent,
    TerminalConflict,
    TerminalResponseMissing,
    TerminalResponseDivergent,
    ResponseR2Orphan,
    LegacyTerminalWithoutReceipt,
    StoreUnavailable,
    ContractViolation,
}

pub fn classify_container_divergence(
    d1: ContainerD1Observation,
    controller: ContainerDoObservation,
    response: ContainerResponseObservation,
) -> ContainerDivergenceClass {
    if d1 == ContainerD1Observation::ContractViolation {
        return ContainerDivergenceClass::ContractViolation;
    }
    if d1 == ContainerD1Observation::LegacyTerminalWithoutReceipt {
        return ContainerDivergenceClass::LegacyTerminalWithoutReceipt;
    }
    if controller == ContainerDoObservation::Unavailable
        || response == ContainerResponseObservation::Unavailable
    {
        return ContainerDivergenceClass::StoreUnavailable;
    }
    if controller == ContainerDoObservation::ContractViolation {
        return ContainerDivergenceClass::ContractViolation;
    }
    match d1 {
        ContainerD1Observation::Prepared => match response {
            ContainerResponseObservation::Orphan => ContainerDivergenceClass::ResponseR2Orphan,
            ContainerResponseObservation::NotExpected => match controller {
                ContainerDoObservation::NotFound => ContainerDivergenceClass::PreparedDoAbsent,
                ContainerDoObservation::Claimed | ContainerDoObservation::Running => {
                    ContainerDivergenceClass::D1LaggingDispatch
                }
                ContainerDoObservation::RecoveryRequired
                | ContainerDoObservation::MatchingTerminal
                | ContainerDoObservation::DefinitiveTerminal => {
                    ContainerDivergenceClass::D1LaggingTerminal
                }
                ContainerDoObservation::ConflictingTerminal => {
                    ContainerDivergenceClass::TerminalConflict
                }
                ContainerDoObservation::Unavailable => ContainerDivergenceClass::StoreUnavailable,
                ContainerDoObservation::ContractViolation => {
                    ContainerDivergenceClass::ContractViolation
                }
            },
            ContainerResponseObservation::Unavailable => ContainerDivergenceClass::StoreUnavailable,
            _ => ContainerDivergenceClass::ContractViolation,
        },
        ContainerD1Observation::Dispatched => match response {
            ContainerResponseObservation::Orphan => ContainerDivergenceClass::ResponseR2Orphan,
            ContainerResponseObservation::NotExpected => match controller {
                ContainerDoObservation::NotFound => ContainerDivergenceClass::DispatchedDoAbsent,
                ContainerDoObservation::Claimed => ContainerDivergenceClass::PendingDoClaimed,
                ContainerDoObservation::Running => ContainerDivergenceClass::PendingDoRunning,
                ContainerDoObservation::RecoveryRequired
                | ContainerDoObservation::MatchingTerminal
                | ContainerDoObservation::DefinitiveTerminal => {
                    ContainerDivergenceClass::D1LaggingTerminal
                }
                ContainerDoObservation::ConflictingTerminal => {
                    ContainerDivergenceClass::TerminalConflict
                }
                ContainerDoObservation::Unavailable => ContainerDivergenceClass::StoreUnavailable,
                ContainerDoObservation::ContractViolation => {
                    ContainerDivergenceClass::ContractViolation
                }
            },
            ContainerResponseObservation::Unavailable => ContainerDivergenceClass::StoreUnavailable,
            _ => ContainerDivergenceClass::ContractViolation,
        },
        ContainerD1Observation::RecoveryRequired => match response {
            ContainerResponseObservation::Orphan => ContainerDivergenceClass::ResponseR2Orphan,
            ContainerResponseObservation::NotExpected => match controller {
                ContainerDoObservation::NotFound => ContainerDivergenceClass::RecoveryDoAbsent,
                ContainerDoObservation::Claimed
                | ContainerDoObservation::Running
                | ContainerDoObservation::RecoveryRequired => {
                    ContainerDivergenceClass::RecoveryPending
                }
                ContainerDoObservation::MatchingTerminal
                | ContainerDoObservation::DefinitiveTerminal => {
                    ContainerDivergenceClass::RecoveryResolvable
                }
                ContainerDoObservation::ConflictingTerminal => {
                    ContainerDivergenceClass::TerminalConflict
                }
                ContainerDoObservation::Unavailable => ContainerDivergenceClass::StoreUnavailable,
                ContainerDoObservation::ContractViolation => {
                    ContainerDivergenceClass::ContractViolation
                }
            },
            ContainerResponseObservation::Unavailable => ContainerDivergenceClass::StoreUnavailable,
            _ => ContainerDivergenceClass::ContractViolation,
        },
        ContainerD1Observation::TerminalWithReceipt => match response {
            ContainerResponseObservation::Missing => {
                ContainerDivergenceClass::TerminalResponseMissing
            }
            ContainerResponseObservation::Divergent => {
                ContainerDivergenceClass::TerminalResponseDivergent
            }
            ContainerResponseObservation::Matching => match controller {
                ContainerDoObservation::MatchingTerminal => {
                    ContainerDivergenceClass::ConvergedReplayable
                }
                ContainerDoObservation::NotFound => ContainerDivergenceClass::TerminalDoAbsent,
                ContainerDoObservation::ConflictingTerminal
                | ContainerDoObservation::Claimed
                | ContainerDoObservation::Running
                | ContainerDoObservation::RecoveryRequired
                | ContainerDoObservation::DefinitiveTerminal => {
                    ContainerDivergenceClass::TerminalConflict
                }
                ContainerDoObservation::Unavailable => ContainerDivergenceClass::StoreUnavailable,
                ContainerDoObservation::ContractViolation => {
                    ContainerDivergenceClass::ContractViolation
                }
            },
            ContainerResponseObservation::Unavailable => ContainerDivergenceClass::StoreUnavailable,
            ContainerResponseObservation::NotExpected | ContainerResponseObservation::Orphan => {
                ContainerDivergenceClass::ContractViolation
            }
        },
        ContainerD1Observation::LegacyTerminalWithoutReceipt => {
            ContainerDivergenceClass::LegacyTerminalWithoutReceipt
        }
        ContainerD1Observation::ContractViolation => ContainerDivergenceClass::ContractViolation,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ContainerReconciliationObservation {
    class: ContainerDivergenceClass,
    error_code: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ContainerReconciliationDecision {
    Retry {
        available_at: i64,
        consecutive_failures: i64,
    },
    Converged,
    DeadLetter {
        reason: &'static str,
    },
}

#[derive(Debug, Default, Serialize, PartialEq, Eq)]
pub struct ContainerReconciliationSummary {
    pub run_acquired: bool,
    pub budget_exhausted: bool,
    pub scanned: u32,
    pub claimed: u32,
    pub skipped: u32,
    pub converged: u32,
    pub retried: u32,
    pub dead_lettered: u32,
    pub stale: u32,
    pub failed: u32,
    pub classes: BTreeMap<String, u32>,
}

impl ContainerReconciliationSummary {
    fn observe(&mut self, class: ContainerDivergenceClass) {
        let entry = self.classes.entry(class.as_str().to_string()).or_default();
        *entry = entry.saturating_add(1);
    }
}

impl ContainerDivergenceClass {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ConvergedReplayable => "converged_replayable",
            Self::PreparedDoAbsent => "prepared_do_absent",
            Self::DispatchedDoAbsent => "dispatched_do_absent",
            Self::PendingDoClaimed => "pending_do_claimed",
            Self::PendingDoRunning => "pending_do_running",
            Self::D1LaggingDispatch => "d1_lagging_dispatch",
            Self::D1LaggingTerminal => "d1_lagging_terminal",
            Self::RecoveryDoAbsent => "recovery_do_absent",
            Self::RecoveryPending => "recovery_pending",
            Self::RecoveryResolvable => "recovery_resolvable",
            Self::TerminalDoAbsent => "terminal_do_absent",
            Self::TerminalConflict => "terminal_conflict",
            Self::TerminalResponseMissing => "terminal_response_missing",
            Self::TerminalResponseDivergent => "terminal_response_divergent",
            Self::ResponseR2Orphan => "response_r2_orphan",
            Self::LegacyTerminalWithoutReceipt => "legacy_terminal_without_receipt",
            Self::StoreUnavailable => "store_unavailable",
            Self::ContractViolation => "contract_violation",
        }
    }
}

pub fn container_reconciliation_scan_limit(env: &Env) -> i64 {
    env.var(CONTAINER_RECONCILIATION_SCAN_LIMIT_ENV)
        .ok()
        .and_then(|value| value.to_string().trim().parse::<i64>().ok())
        .filter(|value| (1..=MAX_CONTAINER_RECONCILIATION_SCAN_LIMIT).contains(value))
        .unwrap_or(DEFAULT_CONTAINER_RECONCILIATION_SCAN_LIMIT)
}

pub fn container_reconciliation_observer_compiled() -> bool {
    DEFAULT_CONTAINER_RECONCILIATION_SCAN_LIMIT > 0
        && MAX_CONTAINER_RECONCILIATION_SCAN_LIMIT <= 8
        && CONTAINER_RECONCILIATION_RUN_LEASE_SECONDS > 30
        && CONTAINER_RECONCILIATION_ITEM_LEASE_SECONDS >= 15
        && CONTAINER_RECONCILIATION_WALL_BUDGET_MILLIS < 30_000
        && CONTAINER_RECONCILIATION_RETRY_HORIZON_SECONDS == 86_400
        && ContainerDivergenceClass::ConvergedReplayable.as_str() == "converged_replayable"
}

pub async fn run_container_reconciliation_observer(
    env: &Env,
    db: &D1Database,
    now: i64,
) -> worker::Result<ContainerReconciliationSummary> {
    if !relay_container_reconciliation_schema_ready(db).await? {
        return Err(reconciliation_error(
            "container reconciliation observer schema is unavailable",
        ));
    }
    let run_owner = random_reconciliation_claim_owner()?;
    let run = match claim_relay_container_reconciliation_run(
        db,
        &run_owner,
        now,
        CONTAINER_RECONCILIATION_RUN_LEASE_SECONDS,
    )
    .await?
    {
        RelayContainerReconciliationRunClaimOutcome::Applied(run) => run,
        RelayContainerReconciliationRunClaimOutcome::AlreadyRunning => {
            return Ok(ContainerReconciliationSummary {
                skipped: 1,
                ..ContainerReconciliationSummary::default()
            });
        }
        RelayContainerReconciliationRunClaimOutcome::Conflict => {
            return Err(reconciliation_error(
                "container reconciliation run claim conflicted",
            ));
        }
    };
    let result = run_container_reconciliation_observer_inner(env, db, now, &run).await;
    let completed_at = current_unix_seconds();
    let completed = complete_relay_container_reconciliation_run(
        db,
        &run,
        completed_at,
        result.is_ok(),
        if result.is_ok() {
            ""
        } else {
            "observer_failed"
        },
    )
    .await;
    match (result, completed) {
        (Ok(summary), Ok(true)) => Ok(summary),
        (Ok(_), Ok(false)) => Err(reconciliation_error(
            "container reconciliation run completion lost its fence",
        )),
        (Ok(_), Err(err)) => Err(err),
        (Err(err), _) => Err(err),
    }
}

async fn run_container_reconciliation_observer_inner(
    env: &Env,
    db: &D1Database,
    now: i64,
    run: &RelayContainerReconciliationRunLease,
) -> worker::Result<ContainerReconciliationSummary> {
    let started_at_millis = worker::Date::now().as_millis();
    let page = relay_container_reconciliation_candidates(
        db,
        run,
        now,
        container_reconciliation_scan_limit(env),
    )
    .await?;
    let mut cursor = page.cursor;
    let mut summary = ContainerReconciliationSummary {
        run_acquired: true,
        ..ContainerReconciliationSummary::default()
    };
    for candidate in page.operations {
        if worker::Date::now()
            .as_millis()
            .saturating_sub(started_at_millis)
            >= CONTAINER_RECONCILIATION_WALL_BUDGET_MILLIS
        {
            summary.budget_exhausted = true;
            break;
        }
        let attempt_now = current_unix_seconds();
        summary.scanned = summary.scanned.saturating_add(1);
        let claim_owner = random_reconciliation_claim_owner()?;
        let claim = claim_relay_container_reconciliation(
            db,
            &candidate,
            &claim_owner,
            attempt_now,
            CONTAINER_RECONCILIATION_ITEM_LEASE_SECONDS,
            CONTAINER_RECONCILIATION_RETRY_HORIZON_SECONDS,
        )
        .await?;
        match claim {
            RelayContainerReconciliationClaimOutcome::Applied(lease) => {
                summary.claimed = summary.claimed.saturating_add(1);
                let operation = relay_container_operation(db, &candidate.operation_id)
                    .await?
                    .ok_or_else(|| {
                        reconciliation_error(
                            "container reconciliation operation disappeared after claim",
                        )
                    })?;
                let observation = if attempt_now >= lease.recovery_deadline_at {
                    ContainerReconciliationObservation {
                        class: ContainerDivergenceClass::StoreUnavailable,
                        error_code: "retry_horizon_exhausted",
                    }
                } else {
                    observe_container_operation(env, db, &operation).await
                };
                summary.observe(observation.class);
                let observed_at = current_unix_seconds();
                let decision =
                    reconciliation_decision(&operation, &lease, &observation, observed_at);
                let record = match &decision {
                    ContainerReconciliationDecision::Retry {
                        available_at,
                        consecutive_failures,
                    } => RelayContainerReconciliationRecord::Retry {
                        class: observation.class.as_str(),
                        error_code: observation.error_code,
                        available_at: *available_at,
                        consecutive_failures: *consecutive_failures,
                    },
                    ContainerReconciliationDecision::Converged => {
                        RelayContainerReconciliationRecord::Converged {
                            class: observation.class.as_str(),
                        }
                    }
                    ContainerReconciliationDecision::DeadLetter { reason } => {
                        RelayContainerReconciliationRecord::DeadLetter {
                            class: observation.class.as_str(),
                            error_code: observation.error_code,
                            reason,
                        }
                    }
                };
                match record_relay_container_reconciliation(
                    db,
                    &operation,
                    &lease,
                    record,
                    observed_at,
                )
                .await?
                {
                    RelayContainerReconciliationRecordOutcome::Applied => match decision {
                        ContainerReconciliationDecision::Retry { .. } => {
                            summary.retried = summary.retried.saturating_add(1)
                        }
                        ContainerReconciliationDecision::Converged => {
                            summary.converged = summary.converged.saturating_add(1)
                        }
                        ContainerReconciliationDecision::DeadLetter { .. } => {
                            summary.dead_lettered = summary.dead_lettered.saturating_add(1)
                        }
                    },
                    RelayContainerReconciliationRecordOutcome::StaleOperation
                    | RelayContainerReconciliationRecordOutcome::StaleLease => {
                        summary.stale = summary.stale.saturating_add(1)
                    }
                    RelayContainerReconciliationRecordOutcome::Terminal => {
                        summary.skipped = summary.skipped.saturating_add(1)
                    }
                    RelayContainerReconciliationRecordOutcome::Conflict => {
                        summary.failed = summary.failed.saturating_add(1)
                    }
                }
            }
            RelayContainerReconciliationClaimOutcome::NotDue
            | RelayContainerReconciliationClaimOutcome::AlreadyLeased
            | RelayContainerReconciliationClaimOutcome::Terminal => {
                summary.skipped = summary.skipped.saturating_add(1)
            }
            RelayContainerReconciliationClaimOutcome::Conflict => {
                summary.failed = summary.failed.saturating_add(1)
            }
        }
        if !advance_relay_container_reconciliation_cursor(
            db,
            run,
            &cursor,
            candidate.created_at,
            &candidate.reservation_key,
            current_unix_seconds(),
        )
        .await?
        {
            return Err(reconciliation_error(
                "container reconciliation cursor advance lost its fence",
            ));
        }
        cursor.last_created_at = candidate.created_at;
        cursor.last_reservation_key = candidate.reservation_key;
    }
    Ok(summary)
}

fn current_unix_seconds() -> i64 {
    (worker::Date::now().as_millis() / 1_000) as i64
}

async fn observe_container_operation(
    env: &Env,
    db: &D1Database,
    operation: &RelayContainerOperation,
) -> ContainerReconciliationObservation {
    let legacy_identity = operation.client_idempotency_hmac_sha256.is_empty()
        && operation.client_request_sha256.is_empty()
        && operation.reconciliation_id.is_empty();
    let (d1, receipt) = match operation.status.as_str() {
        "prepared" => (ContainerD1Observation::Prepared, None),
        "dispatched" => (ContainerD1Observation::Dispatched, None),
        "recovery_required" => {
            if legacy_identity {
                (ContainerD1Observation::RecoveryRequired, None)
            } else {
                match relay_container_financial_terminal_receipt_for_operation(
                    db,
                    &operation.operation_id,
                )
                .await
                {
                    Ok(Some(receipt)) => (ContainerD1Observation::RecoveryRequired, Some(receipt)),
                    Ok(None) => {
                        return ContainerReconciliationObservation {
                            class: ContainerDivergenceClass::ContractViolation,
                            error_code: "d1_terminal_receipt_missing",
                        };
                    }
                    Err(_) => {
                        return ContainerReconciliationObservation {
                            class: ContainerDivergenceClass::StoreUnavailable,
                            error_code: "d1_terminal_receipt_unavailable",
                        };
                    }
                }
            }
        }
        "completed" | "failed" if legacy_identity => {
            (ContainerD1Observation::LegacyTerminalWithoutReceipt, None)
        }
        "completed" | "failed" => {
            match relay_container_financial_terminal_receipt_for_operation(
                db,
                &operation.operation_id,
            )
            .await
            {
                Ok(Some(receipt)) => (ContainerD1Observation::TerminalWithReceipt, Some(receipt)),
                Ok(None) => {
                    return ContainerReconciliationObservation {
                        class: ContainerDivergenceClass::ContractViolation,
                        error_code: "d1_terminal_receipt_missing",
                    };
                }
                Err(_) => {
                    return ContainerReconciliationObservation {
                        class: ContainerDivergenceClass::StoreUnavailable,
                        error_code: "d1_terminal_receipt_unavailable",
                    };
                }
            }
        }
        _ => {
            return ContainerReconciliationObservation {
                class: ContainerDivergenceClass::ContractViolation,
                error_code: "d1_operation_status_invalid",
            };
        }
    };

    let envelope = match container_operation_envelope(operation) {
        Ok(envelope) => envelope,
        Err(_) => {
            return ContainerReconciliationObservation {
                class: ContainerDivergenceClass::ContractViolation,
                error_code: "d1_operation_identity_invalid",
            };
        }
    };
    let (controller, controller_error) = match query_operation_status(env, &envelope).await {
        Ok(outcome) => (controller_observation(operation, &outcome), ""),
        Err("operation_status_not_found") => (ContainerDoObservation::NotFound, ""),
        Err(
            "authority_rejected"
            | "route_not_found"
            | "operation_fence_rejected"
            | "operation_conflict"
            | "protocol_rejected"
            | "contract_mismatch"
            | "invalid_operation_envelope",
        ) => (
            ContainerDoObservation::ContractViolation,
            "controller_contract_violation",
        ),
        Err(_) => (
            ContainerDoObservation::Unavailable,
            "controller_status_unavailable",
        ),
    };
    let response = if d1 == ContainerD1Observation::TerminalWithReceipt {
        let Some(receipt) = receipt.as_ref() else {
            return ContainerReconciliationObservation {
                class: ContainerDivergenceClass::ContractViolation,
                error_code: "d1_terminal_receipt_missing",
            };
        };
        let manifest = match client_response_manifest_from_receipt(receipt) {
            Ok(Some(manifest)) => manifest,
            _ => {
                return ContainerReconciliationObservation {
                    class: ContainerDivergenceClass::ContractViolation,
                    error_code: "client_response_manifest_invalid",
                };
            }
        };
        match inspect_container_client_response(
            env,
            &operation.operation_id,
            operation.owner_generation,
            &manifest,
        )
        .await
        {
            Ok(ContainerClientResponseObjectState::Missing) => {
                ContainerResponseObservation::Missing
            }
            Ok(ContainerClientResponseObjectState::Matching) => {
                ContainerResponseObservation::Matching
            }
            Ok(ContainerClientResponseObjectState::Divergent) => {
                ContainerResponseObservation::Divergent
            }
            Err(_) => ContainerResponseObservation::Unavailable,
        }
    } else {
        ContainerResponseObservation::NotExpected
    };
    let class = classify_container_divergence(d1, controller, response);
    ContainerReconciliationObservation {
        class,
        error_code: if class == ContainerDivergenceClass::StoreUnavailable
            && response == ContainerResponseObservation::Unavailable
        {
            "r2_response_unavailable"
        } else {
            controller_error
        },
    }
}

fn container_operation_envelope(
    operation: &RelayContainerOperation,
) -> Result<ContainerOperationEnvelope, &'static str> {
    let protocol_version =
        u32::try_from(operation.protocol_version).map_err(|_| "invalid_operation_envelope")?;
    let contract_version = u32::try_from(operation.shard_contract_version)
        .map_err(|_| "invalid_operation_envelope")?;
    let ring_generation =
        u64::try_from(operation.ring_generation).map_err(|_| "invalid_operation_envelope")?;
    let shard_count =
        u16::try_from(operation.shard_count).map_err(|_| "invalid_operation_envelope")?;
    let shard_index =
        u16::try_from(operation.shard_index).map_err(|_| "invalid_operation_envelope")?;
    let input_size =
        u64::try_from(operation.input_size).map_err(|_| "invalid_operation_envelope")?;
    Ok(ContainerOperationEnvelope {
        protocol_version,
        operation_id: operation.operation_id.clone(),
        operation_kind: operation.operation_kind.clone(),
        owner_generation: operation.owner_generation,
        owner_lease_expires_at: operation.owner_lease_expires_at,
        execution_deadline_at: operation.execution_deadline_at,
        provider_operation_id: operation.provider_operation_id.clone(),
        admission_sha256: operation.admission_sha256.clone(),
        input: ContainerOperationInput {
            mode: "r2",
            sha256: operation.input_sha256.clone(),
            size: input_size,
            content_type: operation.input_content_type.clone(),
            request_object_key: operation.input_object_key.clone(),
            object_version: operation.input_object_version.clone(),
        },
        shard: ShardPlan {
            contract_version,
            ring_generation,
            shard_count,
            shard_index,
            instance_name: operation.instance_name.clone(),
        },
        trace_id: operation.trace_id.clone(),
    })
}

fn controller_observation(
    operation: &RelayContainerOperation,
    outcome: &ContainerOperationOutcome,
) -> ContainerDoObservation {
    match outcome.status {
        ContainerOperationStatus::Claimed => ContainerDoObservation::Claimed,
        ContainerOperationStatus::Running => ContainerDoObservation::Running,
        ContainerOperationStatus::RecoveryRequired => {
            if operation.status == "recovery_required" {
                if terminal_outcome_matches(operation, outcome) {
                    ContainerDoObservation::RecoveryRequired
                } else {
                    ContainerDoObservation::ConflictingTerminal
                }
            } else if matches!(operation.status.as_str(), "prepared" | "dispatched") {
                ContainerDoObservation::RecoveryRequired
            } else {
                ContainerDoObservation::ConflictingTerminal
            }
        }
        ContainerOperationStatus::Completed | ContainerOperationStatus::Failed => {
            if matches!(operation.status.as_str(), "completed" | "failed") {
                if terminal_outcome_matches(operation, outcome) {
                    ContainerDoObservation::MatchingTerminal
                } else {
                    ContainerDoObservation::ConflictingTerminal
                }
            } else if matches!(
                operation.status.as_str(),
                "prepared" | "dispatched" | "recovery_required"
            ) {
                ContainerDoObservation::DefinitiveTerminal
            } else {
                ContainerDoObservation::ConflictingTerminal
            }
        }
    }
}

fn terminal_outcome_matches(
    operation: &RelayContainerOperation,
    outcome: &ContainerOperationOutcome,
) -> bool {
    operation.response_status == Some(i64::from(outcome.http_status))
        && operation.response_code.as_deref() == outcome.code.as_deref()
        && match (&outcome.result, operation.result_object_key.as_deref()) {
            (None, None) => true,
            (Some(result), Some(object_key)) => {
                result.object_key == object_key
                    && Some(result.object_version.as_str())
                        == operation.result_object_version.as_deref()
                    && Some(result.sha256.as_str()) == operation.result_sha256.as_deref()
                    && i64::try_from(result.size).ok() == operation.result_size
                    && Some(result.content_type.as_str())
                        == operation.result_content_type.as_deref()
            }
            _ => false,
        }
}

fn reconciliation_decision(
    operation: &RelayContainerOperation,
    lease: &RelayContainerReconciliationLease,
    observation: &ContainerReconciliationObservation,
    now: i64,
) -> ContainerReconciliationDecision {
    if now >= lease.recovery_deadline_at || observation.error_code == "retry_horizon_exhausted" {
        return ContainerReconciliationDecision::DeadLetter {
            reason: "retry_horizon_exhausted",
        };
    }
    match observation.class {
        ContainerDivergenceClass::ConvergedReplayable => ContainerReconciliationDecision::Converged,
        ContainerDivergenceClass::TerminalConflict
        | ContainerDivergenceClass::TerminalResponseDivergent
        | ContainerDivergenceClass::ResponseR2Orphan
        | ContainerDivergenceClass::LegacyTerminalWithoutReceipt
        | ContainerDivergenceClass::ContractViolation => {
            ContainerReconciliationDecision::DeadLetter {
                reason: observation.class.as_str(),
            }
        }
        _ => {
            let delay = reconciliation_retry_delay(&operation.operation_id, lease.attempt_count);
            ContainerReconciliationDecision::Retry {
                available_at: now.saturating_add(delay).min(lease.recovery_deadline_at),
                consecutive_failures: if observation.class
                    == ContainerDivergenceClass::StoreUnavailable
                {
                    lease.consecutive_failures.saturating_add(1)
                } else {
                    0
                },
            }
        }
    }
}

fn reconciliation_retry_delay(operation_id: &str, attempt_count: i64) -> i64 {
    let exponent = attempt_count.saturating_sub(1).clamp(0, 6) as u32;
    let nominal = CONTAINER_RECONCILIATION_RETRY_BASE_SECONDS
        .saturating_mul(1_i64 << exponent)
        .min(CONTAINER_RECONCILIATION_RETRY_MAX_SECONDS);
    let mut hasher = Sha256::new();
    hasher.update(CONTAINER_RECONCILIATION_BACKOFF_DOMAIN);
    hasher.update(operation_id.as_bytes());
    hasher.update(attempt_count.to_be_bytes());
    let digest = hasher.finalize();
    let sample = u64::from_be_bytes(digest[..8].try_into().unwrap_or([0; 8]));
    let window = (nominal / 5).max(1);
    let span = u64::try_from(window.saturating_mul(2).saturating_add(1)).unwrap_or(1);
    let offset = i64::try_from(sample % span).unwrap_or_default() - window;
    nominal
        .saturating_add(offset)
        .clamp(5, CONTAINER_RECONCILIATION_RETRY_MAX_SECONDS)
}

fn random_reconciliation_claim_owner() -> worker::Result<String> {
    let mut bytes = [0_u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|_| {
        reconciliation_error("container reconciliation claim entropy is unavailable")
    })?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub fn client_response_manifest_from_receipt(
    receipt: &RelayContainerFinancialTerminalReceipt,
) -> worker::Result<Option<ContainerClientResponseManifest>> {
    if !relay_container_financial_receipt_integrity_valid(receipt) {
        return Err(reconciliation_error(
            "container terminal receipt integrity check failed",
        ));
    }
    let fields = [
        receipt.client_response_status.is_some(),
        receipt.client_response_headers_json.is_some(),
        receipt.client_response_headers_sha256.is_some(),
        receipt.client_response_object_key.is_some(),
        receipt.client_response_object_version.is_some(),
        receipt.client_response_sha256.is_some(),
        receipt.client_response_size.is_some(),
        receipt.client_response_content_type.is_some(),
    ];
    if fields.iter().all(|present| !present) {
        if receipt.billing_action == "recovery_required"
            && receipt.operation_status == "recovery_required"
        {
            return Ok(None);
        }
        return Err(reconciliation_error(
            "container terminal receipt is missing a client response",
        ));
    }
    if !fields.iter().all(|present| *present) || receipt.billing_action == "recovery_required" {
        return Err(reconciliation_error(
            "container terminal receipt has a partial client response",
        ));
    }
    let status = u16::try_from(receipt.client_response_status.unwrap_or_default())
        .map_err(|_| reconciliation_error("container client response status is invalid"))?;
    if receipt.operation_response_status != Some(i64::from(status)) {
        return Err(reconciliation_error(
            "container client response status does not match the operation",
        ));
    }
    let size = u64::try_from(receipt.client_response_size.unwrap_or_default())
        .map_err(|_| reconciliation_error("container client response size is invalid"))?;
    let manifest = ContainerClientResponseManifest {
        status,
        headers_json: receipt
            .client_response_headers_json
            .clone()
            .unwrap_or_default(),
        headers_sha256: receipt
            .client_response_headers_sha256
            .clone()
            .unwrap_or_default(),
        body: ContainerArtifactManifest {
            object_key: receipt
                .client_response_object_key
                .clone()
                .unwrap_or_default(),
            object_version: receipt
                .client_response_object_version
                .clone()
                .unwrap_or_default(),
            sha256: receipt.client_response_sha256.clone().unwrap_or_default(),
            size,
            content_type: receipt
                .client_response_content_type
                .clone()
                .unwrap_or_default(),
        },
    };
    validate_container_client_response_manifest(
        &receipt.operation_id,
        receipt.owner_generation,
        &manifest,
    )?;
    Ok(Some(manifest))
}

pub async fn inspect_receipt_client_response(
    env: &Env,
    receipt: &RelayContainerFinancialTerminalReceipt,
) -> worker::Result<ContainerResponseObservation> {
    let Some(manifest) = client_response_manifest_from_receipt(receipt)? else {
        return Ok(ContainerResponseObservation::NotExpected);
    };
    Ok(
        match inspect_container_client_response(
            env,
            &receipt.operation_id,
            receipt.owner_generation,
            &manifest,
        )
        .await?
        {
            ContainerClientResponseObjectState::Missing => ContainerResponseObservation::Missing,
            ContainerClientResponseObjectState::Matching => ContainerResponseObservation::Matching,
            ContainerClientResponseObjectState::Divergent => {
                ContainerResponseObservation::Divergent
            }
        },
    )
}

pub async fn replay_receipt_client_response(
    env: &Env,
    receipt: &RelayContainerFinancialTerminalReceipt,
) -> worker::Result<Option<Response>> {
    let Some(manifest) = client_response_manifest_from_receipt(receipt)? else {
        return Ok(None);
    };
    read_verified_container_client_response(
        env,
        &receipt.operation_id,
        receipt.owner_generation,
        &manifest,
    )
    .await
    .map(Some)
}

fn reconciliation_error(message: &str) -> worker::Error {
    worker::Error::RustError(message.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_operation(status: &str) -> RelayContainerOperation {
        RelayContainerOperation {
            reservation_key: "operation-1".to_string(),
            operation_id: "operation-1".to_string(),
            owner_generation: 1,
            owner_lease_expires_at: 2_000,
            channel_id: 7,
            selected_group: "default".to_string(),
            operation_kind: "chat_completions".to_string(),
            provider_operation_id: "provider-operation-1".to_string(),
            admission_sha256: "a".repeat(64),
            protocol_version: 1,
            shard_contract_version: 1,
            ring_generation: 1,
            shard_count: 8,
            shard_index: 3,
            instance_name: "cinatoken-relay-shard-v1-0003".to_string(),
            execution_deadline_at: 1_500,
            input_mode: "r2".to_string(),
            input_object_key: "container-inputs/v1/operation-1/1/input".to_string(),
            input_object_version: "input-version-1".to_string(),
            input_sha256: "b".repeat(64),
            input_size: 128,
            input_content_type: "application/json".to_string(),
            trace_id: "trace-1".to_string(),
            client_idempotency_hmac_sha256: "c".repeat(64),
            client_request_sha256: "d".repeat(64),
            reconciliation_id: "e".repeat(64),
            status: status.to_string(),
            response_status: Some(200),
            response_code: Some("ok".to_string()),
            result_object_key: Some("container-results/v1/operation-1/1/result".to_string()),
            result_object_version: Some("result-version-1".to_string()),
            result_sha256: Some("f".repeat(64)),
            result_size: Some(256),
            result_content_type: Some("application/json".to_string()),
            created_at: 1_000,
            updated_at: 1_100,
        }
    }

    fn terminal_outcome(status: ContainerOperationStatus) -> ContainerOperationOutcome {
        ContainerOperationOutcome {
            status,
            http_status: 200,
            code: Some("ok".to_string()),
            result: Some(ContainerArtifactManifest {
                object_key: "container-results/v1/operation-1/1/result".to_string(),
                object_version: "result-version-1".to_string(),
                sha256: "f".repeat(64),
                size: 256,
                content_type: "application/json".to_string(),
            }),
            provider_attempt: None,
        }
    }

    #[test]
    fn divergence_classifier_is_fail_closed_across_all_stores() {
        let cases = [
            (
                ContainerD1Observation::Prepared,
                ContainerDoObservation::NotFound,
                ContainerResponseObservation::NotExpected,
                ContainerDivergenceClass::PreparedDoAbsent,
            ),
            (
                ContainerD1Observation::Dispatched,
                ContainerDoObservation::NotFound,
                ContainerResponseObservation::NotExpected,
                ContainerDivergenceClass::DispatchedDoAbsent,
            ),
            (
                ContainerD1Observation::Dispatched,
                ContainerDoObservation::Claimed,
                ContainerResponseObservation::NotExpected,
                ContainerDivergenceClass::PendingDoClaimed,
            ),
            (
                ContainerD1Observation::Dispatched,
                ContainerDoObservation::Running,
                ContainerResponseObservation::NotExpected,
                ContainerDivergenceClass::PendingDoRunning,
            ),
            (
                ContainerD1Observation::Prepared,
                ContainerDoObservation::Running,
                ContainerResponseObservation::NotExpected,
                ContainerDivergenceClass::D1LaggingDispatch,
            ),
            (
                ContainerD1Observation::Dispatched,
                ContainerDoObservation::DefinitiveTerminal,
                ContainerResponseObservation::NotExpected,
                ContainerDivergenceClass::D1LaggingTerminal,
            ),
            (
                ContainerD1Observation::RecoveryRequired,
                ContainerDoObservation::NotFound,
                ContainerResponseObservation::NotExpected,
                ContainerDivergenceClass::RecoveryDoAbsent,
            ),
            (
                ContainerD1Observation::RecoveryRequired,
                ContainerDoObservation::RecoveryRequired,
                ContainerResponseObservation::NotExpected,
                ContainerDivergenceClass::RecoveryPending,
            ),
            (
                ContainerD1Observation::RecoveryRequired,
                ContainerDoObservation::DefinitiveTerminal,
                ContainerResponseObservation::NotExpected,
                ContainerDivergenceClass::RecoveryResolvable,
            ),
            (
                ContainerD1Observation::TerminalWithReceipt,
                ContainerDoObservation::MatchingTerminal,
                ContainerResponseObservation::Matching,
                ContainerDivergenceClass::ConvergedReplayable,
            ),
            (
                ContainerD1Observation::TerminalWithReceipt,
                ContainerDoObservation::NotFound,
                ContainerResponseObservation::Matching,
                ContainerDivergenceClass::TerminalDoAbsent,
            ),
            (
                ContainerD1Observation::TerminalWithReceipt,
                ContainerDoObservation::ConflictingTerminal,
                ContainerResponseObservation::Matching,
                ContainerDivergenceClass::TerminalConflict,
            ),
            (
                ContainerD1Observation::TerminalWithReceipt,
                ContainerDoObservation::MatchingTerminal,
                ContainerResponseObservation::Missing,
                ContainerDivergenceClass::TerminalResponseMissing,
            ),
            (
                ContainerD1Observation::TerminalWithReceipt,
                ContainerDoObservation::MatchingTerminal,
                ContainerResponseObservation::Divergent,
                ContainerDivergenceClass::TerminalResponseDivergent,
            ),
            (
                ContainerD1Observation::Dispatched,
                ContainerDoObservation::Running,
                ContainerResponseObservation::Orphan,
                ContainerDivergenceClass::ResponseR2Orphan,
            ),
            (
                ContainerD1Observation::LegacyTerminalWithoutReceipt,
                ContainerDoObservation::NotFound,
                ContainerResponseObservation::NotExpected,
                ContainerDivergenceClass::LegacyTerminalWithoutReceipt,
            ),
            (
                ContainerD1Observation::TerminalWithReceipt,
                ContainerDoObservation::Unavailable,
                ContainerResponseObservation::Matching,
                ContainerDivergenceClass::StoreUnavailable,
            ),
            (
                ContainerD1Observation::Prepared,
                ContainerDoObservation::Claimed,
                ContainerResponseObservation::Matching,
                ContainerDivergenceClass::ContractViolation,
            ),
            (
                ContainerD1Observation::TerminalWithReceipt,
                ContainerDoObservation::MatchingTerminal,
                ContainerResponseObservation::Unavailable,
                ContainerDivergenceClass::StoreUnavailable,
            ),
            (
                ContainerD1Observation::Prepared,
                ContainerDoObservation::ContractViolation,
                ContainerResponseObservation::NotExpected,
                ContainerDivergenceClass::ContractViolation,
            ),
        ];
        for (d1, controller, response, expected) in cases {
            assert_eq!(
                classify_container_divergence(d1, controller, response),
                expected
            );
        }
    }

    #[test]
    fn observer_backoff_is_deterministic_bounded_and_operation_scoped() {
        let first = reconciliation_retry_delay("operation-a", 1);
        assert!((12..=18).contains(&first));
        assert_eq!(first, reconciliation_retry_delay("operation-a", 1));
        assert!(reconciliation_retry_delay("operation-a", 2) > first);
        assert!(
            reconciliation_retry_delay("operation-a", 64)
                <= CONTAINER_RECONCILIATION_RETRY_MAX_SECONDS
        );
        assert!(container_reconciliation_observer_compiled());
        let classes = [
            ContainerDivergenceClass::ConvergedReplayable,
            ContainerDivergenceClass::PreparedDoAbsent,
            ContainerDivergenceClass::DispatchedDoAbsent,
            ContainerDivergenceClass::PendingDoClaimed,
            ContainerDivergenceClass::PendingDoRunning,
            ContainerDivergenceClass::D1LaggingDispatch,
            ContainerDivergenceClass::D1LaggingTerminal,
            ContainerDivergenceClass::RecoveryDoAbsent,
            ContainerDivergenceClass::RecoveryPending,
            ContainerDivergenceClass::RecoveryResolvable,
            ContainerDivergenceClass::TerminalDoAbsent,
            ContainerDivergenceClass::TerminalConflict,
            ContainerDivergenceClass::TerminalResponseMissing,
            ContainerDivergenceClass::TerminalResponseDivergent,
            ContainerDivergenceClass::ResponseR2Orphan,
            ContainerDivergenceClass::LegacyTerminalWithoutReceipt,
            ContainerDivergenceClass::StoreUnavailable,
            ContainerDivergenceClass::ContractViolation,
        ]
        .map(ContainerDivergenceClass::as_str);
        assert_eq!(
            classes.as_slice(),
            crate::d1_repositories::RELAY_CONTAINER_RECONCILIATION_CLASSES
        );
    }

    #[test]
    fn controller_observation_preserves_dispatch_and_execution_phases() {
        let prepared = test_operation("prepared");
        let dispatched = test_operation("dispatched");

        assert_eq!(
            controller_observation(
                &prepared,
                &ContainerOperationOutcome {
                    status: ContainerOperationStatus::Claimed,
                    http_status: 202,
                    code: None,
                    result: None,
                    provider_attempt: None,
                },
            ),
            ContainerDoObservation::Claimed
        );
        assert_eq!(
            classify_container_divergence(
                ContainerD1Observation::Prepared,
                ContainerDoObservation::Claimed,
                ContainerResponseObservation::NotExpected,
            ),
            ContainerDivergenceClass::D1LaggingDispatch
        );
        assert_eq!(
            controller_observation(
                &dispatched,
                &ContainerOperationOutcome {
                    status: ContainerOperationStatus::Running,
                    http_status: 202,
                    code: None,
                    result: None,
                    provider_attempt: None,
                },
            ),
            ContainerDoObservation::Running
        );
        assert_eq!(
            classify_container_divergence(
                ContainerD1Observation::Dispatched,
                ContainerDoObservation::Running,
                ContainerResponseObservation::NotExpected,
            ),
            ContainerDivergenceClass::PendingDoRunning
        );
        assert_eq!(
            controller_observation(
                &prepared,
                &terminal_outcome(ContainerOperationStatus::Completed),
            ),
            ContainerDoObservation::DefinitiveTerminal
        );
    }

    #[test]
    fn controller_observation_requires_an_exact_terminal_match() {
        let completed = test_operation("completed");
        let matching = terminal_outcome(ContainerOperationStatus::Completed);
        assert_eq!(
            controller_observation(&completed, &matching),
            ContainerDoObservation::MatchingTerminal
        );

        let mut conflicting = matching;
        conflicting.result.as_mut().expect("result").sha256 = "0".repeat(64);
        assert_eq!(
            controller_observation(&completed, &conflicting),
            ContainerDoObservation::ConflictingTerminal
        );
    }
}
