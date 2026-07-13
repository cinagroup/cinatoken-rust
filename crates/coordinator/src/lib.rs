//! Pure, I/O-free quota coordination for tiered-expression shadow observations.
//!
//! This crate projects accounting deltas but never writes user, token, or
//! channel balances. Validation and arithmetic failures return `Err` without
//! changing state. Business conflicts return `ApplyOutcome::Conflict` after
//! incrementing the persisted observation and conflict counters.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const QUOTA_COORDINATOR_CONTRACT_VERSION: u32 = 1;
pub const QUOTA_COORDINATOR_MODE: &str = "tiered_expression_shadow_only";
pub const DEFAULT_MAX_ACTIVE_RESERVATIONS: u32 = 1_024;
pub const DEFAULT_MAX_TERMINAL_RESERVATIONS: u32 = 4_096;
pub const MAX_ACTIVE_RESERVATIONS: u32 = 65_536;
pub const MAX_TERMINAL_RESERVATIONS: u32 = 65_536;

const MAX_QUOTA: i64 = i32::MAX as i64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuotaObservationKind {
    Reserve,
    Settle,
    Refund,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "QuotaObservationWire")]
pub struct QuotaObservation {
    pub contract_version: u32,
    pub kind: QuotaObservationKind,
    pub operation_id: String,
    pub reservation_fingerprint: String,
    pub generation: u64,
    pub reserved_quota: i64,
    pub final_quota: i64,
    pub request_count: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct QuotaObservationWire {
    contract_version: u32,
    kind: QuotaObservationKind,
    operation_id: String,
    reservation_fingerprint: String,
    generation: u64,
    reserved_quota: i64,
    final_quota: i64,
    request_count: u64,
}

impl TryFrom<QuotaObservationWire> for QuotaObservation {
    type Error = QuotaObservationValidationError;

    fn try_from(value: QuotaObservationWire) -> Result<Self, Self::Error> {
        let observation = Self {
            contract_version: value.contract_version,
            kind: value.kind,
            operation_id: value.operation_id,
            reservation_fingerprint: value.reservation_fingerprint,
            generation: value.generation,
            reserved_quota: value.reserved_quota,
            final_quota: value.final_quota,
            request_count: value.request_count,
        };
        observation.validate()?;
        Ok(observation)
    }
}

impl QuotaObservation {
    pub fn reserve(
        operation_id: impl Into<String>,
        reservation_fingerprint: impl Into<String>,
        reserved_quota: i64,
    ) -> Result<Self, QuotaObservationValidationError> {
        Self::validated(
            QuotaObservationKind::Reserve,
            operation_id,
            reservation_fingerprint,
            1,
            reserved_quota,
            0,
            0,
        )
    }

    pub fn settle(
        operation_id: impl Into<String>,
        reservation_fingerprint: impl Into<String>,
        generation: u64,
        reserved_quota: i64,
        final_quota: i64,
        request_count: u64,
    ) -> Result<Self, QuotaObservationValidationError> {
        Self::validated(
            QuotaObservationKind::Settle,
            operation_id,
            reservation_fingerprint,
            generation,
            reserved_quota,
            final_quota,
            request_count,
        )
    }

    pub fn refund(
        operation_id: impl Into<String>,
        reservation_fingerprint: impl Into<String>,
        generation: u64,
        reserved_quota: i64,
        request_count: u64,
    ) -> Result<Self, QuotaObservationValidationError> {
        Self::validated(
            QuotaObservationKind::Refund,
            operation_id,
            reservation_fingerprint,
            generation,
            reserved_quota,
            0,
            request_count,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn validated(
        kind: QuotaObservationKind,
        operation_id: impl Into<String>,
        reservation_fingerprint: impl Into<String>,
        generation: u64,
        reserved_quota: i64,
        final_quota: i64,
        request_count: u64,
    ) -> Result<Self, QuotaObservationValidationError> {
        let observation = Self {
            contract_version: QUOTA_COORDINATOR_CONTRACT_VERSION,
            kind,
            operation_id: operation_id.into(),
            reservation_fingerprint: reservation_fingerprint.into(),
            generation,
            reserved_quota,
            final_quota,
            request_count,
        };
        observation.validate()?;
        Ok(observation)
    }

    pub fn validate(&self) -> Result<(), QuotaObservationValidationError> {
        if self.contract_version != QUOTA_COORDINATOR_CONTRACT_VERSION {
            return Err(
                QuotaObservationValidationError::UnsupportedContractVersion {
                    actual: self.contract_version,
                },
            );
        }
        validate_hex_id("operation_id", &self.operation_id)?;
        validate_hex_id("reservation_fingerprint", &self.reservation_fingerprint)?;
        validate_quota("reserved_quota", self.reserved_quota)?;
        validate_quota("final_quota", self.final_quota)?;
        if self.request_count > 1 {
            return Err(QuotaObservationValidationError::InvalidRequestCount {
                kind: self.kind,
                actual: self.request_count,
            });
        }

        match self.kind {
            QuotaObservationKind::Reserve => {
                if self.generation != 1 {
                    return Err(QuotaObservationValidationError::InvalidGeneration {
                        kind: self.kind,
                        actual: self.generation,
                    });
                }
                if self.final_quota != 0 {
                    return Err(QuotaObservationValidationError::InvalidFinalQuota {
                        kind: self.kind,
                        actual: self.final_quota,
                    });
                }
                if self.request_count != 0 {
                    return Err(QuotaObservationValidationError::InvalidRequestCount {
                        kind: self.kind,
                        actual: self.request_count,
                    });
                }
            }
            QuotaObservationKind::Settle => {
                if self.generation < 2 {
                    return Err(QuotaObservationValidationError::InvalidGeneration {
                        kind: self.kind,
                        actual: self.generation,
                    });
                }
            }
            QuotaObservationKind::Refund => {
                if self.generation < 2 {
                    return Err(QuotaObservationValidationError::InvalidGeneration {
                        kind: self.kind,
                        actual: self.generation,
                    });
                }
                if self.final_quota != 0 {
                    return Err(QuotaObservationValidationError::InvalidFinalQuota {
                        kind: self.kind,
                        actual: self.final_quota,
                    });
                }
            }
        }
        Ok(())
    }
}

fn validate_hex_id(
    field: &'static str,
    value: &str,
) -> Result<(), QuotaObservationValidationError> {
    let valid = value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    if valid {
        Ok(())
    } else {
        Err(QuotaObservationValidationError::InvalidHexId { field })
    }
}

fn validate_quota(field: &'static str, value: i64) -> Result<(), QuotaObservationValidationError> {
    if (0..=MAX_QUOTA).contains(&value) {
        Ok(())
    } else {
        Err(QuotaObservationValidationError::InvalidQuota { field, value })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum QuotaObservationValidationError {
    #[error(
        "unsupported quota coordinator contract version {actual}; expected version {QUOTA_COORDINATOR_CONTRACT_VERSION}"
    )]
    UnsupportedContractVersion { actual: u32 },
    #[error("{field} must contain exactly 64 lowercase hexadecimal characters")]
    InvalidHexId { field: &'static str },
    #[error("{field} quota {value} must be between 0 and i32::MAX")]
    InvalidQuota { field: &'static str, value: i64 },
    #[error("{kind:?} generation {actual} violates the v1 contract")]
    InvalidGeneration {
        kind: QuotaObservationKind,
        actual: u64,
    },
    #[error("{kind:?} final quota {actual} violates the v1 contract")]
    InvalidFinalQuota {
        kind: QuotaObservationKind,
        actual: i64,
    },
    #[error("{kind:?} request count {actual} violates the v1 contract")]
    InvalidRequestCount {
        kind: QuotaObservationKind,
        actual: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
/// Persistable cumulative counters and the current active quota projection.
///
/// `refunded_quota` includes both explicit refunds and the positive
/// `reserved_quota - final_quota` difference from settlements.
pub struct QuotaCoordinatorSummary {
    pub contract_version: u32,
    pub observation_count: u64,
    pub applied_count: u64,
    pub replay_count: u64,
    pub conflict_count: u64,
    pub reserve_count: u64,
    pub settle_count: u64,
    pub refund_count: u64,
    pub active_reservations: u64,
    pub terminal_reservations: u64,
    pub outstanding_quota: i64,
    pub reserved_quota: i64,
    pub final_quota: i64,
    pub refunded_quota: i64,
    pub user_net_delta: i64,
    pub token_net_delta: i64,
    pub channel_used_quota: i64,
    pub request_count: u64,
}

impl Default for QuotaCoordinatorSummary {
    fn default() -> Self {
        Self {
            contract_version: QUOTA_COORDINATOR_CONTRACT_VERSION,
            observation_count: 0,
            applied_count: 0,
            replay_count: 0,
            conflict_count: 0,
            reserve_count: 0,
            settle_count: 0,
            refund_count: 0,
            active_reservations: 0,
            terminal_reservations: 0,
            outstanding_quota: 0,
            reserved_quota: 0,
            final_quota: 0,
            refunded_quota: 0,
            user_net_delta: 0,
            token_net_delta: 0,
            channel_used_quota: 0,
            request_count: 0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
/// A shadow projection only; applying it to an accounting store is out of scope.
pub struct QuotaShadowDelta {
    pub reserved_quota_delta: i64,
    pub final_quota_delta: i64,
    pub refunded_quota_delta: i64,
    pub outstanding_quota_delta: i64,
    pub user_net_delta: i64,
    pub token_net_delta: i64,
    pub channel_used_quota_delta: i64,
    pub request_count_delta: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
/// Result of one valid observation attempt.
///
/// `Conflict` and `Replay` are successful state-machine results. In particular,
/// callers must persist the state carrying a conflict before returning HTTP 409.
pub enum ApplyOutcome {
    Applied {
        shadow_delta: QuotaShadowDelta,
        summary: QuotaCoordinatorSummary,
    },
    Replay {
        summary: QuotaCoordinatorSummary,
    },
    Conflict {
        reason: QuotaConflict,
        summary: QuotaCoordinatorSummary,
    },
}

impl ApplyOutcome {
    pub fn summary(&self) -> &QuotaCoordinatorSummary {
        match self {
            Self::Applied { summary, .. }
            | Self::Replay { summary }
            | Self::Conflict { summary, .. } => summary,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum QuotaConflict {
    OperationIdPayloadConflict {
        operation_id: String,
    },
    RepeatedReserve {
        reservation_fingerprint: String,
    },
    MissingReserve {
        reservation_fingerprint: String,
    },
    RepeatedTerminal {
        reservation_fingerprint: String,
    },
    GenerationMismatch {
        reservation_fingerprint: String,
        expected: u64,
        actual: u64,
    },
    QuotaMismatch {
        reservation_fingerprint: String,
        expected_reserved_quota: i64,
        actual_reserved_quota: i64,
    },
    ActiveCapacityExceeded {
        limit: u32,
    },
    TerminalCapacityExceeded {
        limit: u32,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ActiveReservation {
    reserve: QuotaObservation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct TerminalReservation {
    reserve: QuotaObservation,
    terminal: QuotaObservation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "QuotaCoordinatorStateWire")]
pub struct QuotaCoordinatorState {
    contract_version: u32,
    max_active_reservations: u32,
    max_terminal_reservations: u32,
    active_reservations: BTreeMap<String, ActiveReservation>,
    terminal_reservations: VecDeque<TerminalReservation>,
    summary: QuotaCoordinatorSummary,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct QuotaCoordinatorStateWire {
    contract_version: u32,
    max_active_reservations: u32,
    max_terminal_reservations: u32,
    active_reservations: BTreeMap<String, ActiveReservation>,
    terminal_reservations: VecDeque<TerminalReservation>,
    summary: QuotaCoordinatorSummary,
}

impl TryFrom<QuotaCoordinatorStateWire> for QuotaCoordinatorState {
    type Error = QuotaCoordinatorError;

    fn try_from(value: QuotaCoordinatorStateWire) -> Result<Self, Self::Error> {
        let state = Self {
            contract_version: value.contract_version,
            max_active_reservations: value.max_active_reservations,
            max_terminal_reservations: value.max_terminal_reservations,
            active_reservations: value.active_reservations,
            terminal_reservations: value.terminal_reservations,
            summary: value.summary,
        };
        state.validate()?;
        Ok(state)
    }
}

impl Default for QuotaCoordinatorState {
    fn default() -> Self {
        Self {
            contract_version: QUOTA_COORDINATOR_CONTRACT_VERSION,
            max_active_reservations: DEFAULT_MAX_ACTIVE_RESERVATIONS,
            max_terminal_reservations: DEFAULT_MAX_TERMINAL_RESERVATIONS,
            active_reservations: BTreeMap::new(),
            terminal_reservations: VecDeque::new(),
            summary: QuotaCoordinatorSummary::default(),
        }
    }
}

impl QuotaCoordinatorState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_limits(
        max_active_reservations: u32,
        max_terminal_reservations: u32,
    ) -> Result<Self, QuotaCoordinatorError> {
        let state = Self {
            max_active_reservations,
            max_terminal_reservations,
            ..Self::default()
        };
        state.validate()?;
        Ok(state)
    }

    pub fn contract_version(&self) -> u32 {
        self.contract_version
    }

    pub fn max_active_reservations(&self) -> u32 {
        self.max_active_reservations
    }

    pub fn max_terminal_reservations(&self) -> u32 {
        self.max_terminal_reservations
    }

    pub fn summary(&self) -> &QuotaCoordinatorSummary {
        &self.summary
    }

    pub fn has_active_reservation(&self, reservation_fingerprint: &str) -> bool {
        self.active_reservations
            .contains_key(reservation_fingerprint)
    }

    /// Applies one observation transactionally.
    ///
    /// An `Err` leaves `self` byte-for-byte unchanged. An `Ok(Conflict { .. })`
    /// includes an incremented, persistable `conflict_count`.
    pub fn apply(
        &mut self,
        observation: QuotaObservation,
    ) -> Result<ApplyOutcome, QuotaCoordinatorError> {
        observation.validate()?;
        self.validate()?;

        // Apply to a working copy so validation and arithmetic errors never leak
        // partially updated state to a Durable Object caller.
        let mut next = self.clone();
        let outcome = next.apply_validated(observation)?;
        next.validate()?;
        *self = next;
        Ok(outcome)
    }

    pub fn validate(&self) -> Result<(), QuotaCoordinatorError> {
        if self.contract_version != QUOTA_COORDINATOR_CONTRACT_VERSION {
            return Err(invalid_state(
                "contract_version",
                format!(
                    "expected {QUOTA_COORDINATOR_CONTRACT_VERSION}, got {}",
                    self.contract_version
                ),
            ));
        }
        validate_limit(
            "max_active_reservations",
            self.max_active_reservations,
            MAX_ACTIVE_RESERVATIONS,
        )?;
        validate_limit(
            "max_terminal_reservations",
            self.max_terminal_reservations,
            MAX_TERMINAL_RESERVATIONS,
        )?;
        if self.active_reservations.len() > self.max_active_reservations as usize {
            return Err(invalid_state(
                "active_reservations",
                "collection exceeds configured capacity",
            ));
        }
        if self.terminal_reservations.len() > self.max_terminal_reservations as usize {
            return Err(invalid_state(
                "terminal_reservations",
                "collection exceeds configured capacity",
            ));
        }
        if self.summary.contract_version != QUOTA_COORDINATOR_CONTRACT_VERSION {
            return Err(invalid_state(
                "summary.contract_version",
                "summary contract version does not match state",
            ));
        }

        let mut operation_ids = BTreeSet::new();
        let mut reservation_fingerprints = BTreeSet::new();
        let mut expected = QuotaCoordinatorSummary::default();
        expected.observation_count = self.summary.observation_count;
        expected.replay_count = self.summary.replay_count;
        expected.conflict_count = self.summary.conflict_count;

        for (fingerprint, active) in &self.active_reservations {
            active.reserve.validate()?;
            if active.reserve.kind != QuotaObservationKind::Reserve {
                return Err(invalid_state(
                    "active_reservations",
                    "active record does not contain a reserve observation",
                ));
            }
            if fingerprint != &active.reserve.reservation_fingerprint {
                return Err(invalid_state(
                    "active_reservations",
                    "map key does not match reservation fingerprint",
                ));
            }
            if !reservation_fingerprints.insert(fingerprint.as_str()) {
                return Err(invalid_state(
                    "active_reservations",
                    "duplicate reservation fingerprint",
                ));
            }
            insert_operation_id(&mut operation_ids, &active.reserve.operation_id)?;
            accumulate_reserve(&mut expected, active.reserve.reserved_quota)?;
        }

        for terminal in &self.terminal_reservations {
            terminal.reserve.validate()?;
            terminal.terminal.validate()?;
            if terminal.reserve.kind != QuotaObservationKind::Reserve
                || terminal.terminal.kind == QuotaObservationKind::Reserve
            {
                return Err(invalid_state(
                    "terminal_reservations",
                    "terminal record has invalid observation kinds",
                ));
            }
            if terminal.reserve.reservation_fingerprint != terminal.terminal.reservation_fingerprint
            {
                return Err(invalid_state(
                    "terminal_reservations",
                    "reserve and terminal fingerprints differ",
                ));
            }
            if terminal.reserve.reserved_quota != terminal.terminal.reserved_quota {
                return Err(invalid_state(
                    "terminal_reservations",
                    "reserve and terminal quotas differ",
                ));
            }
            if !reservation_fingerprints.insert(&terminal.reserve.reservation_fingerprint) {
                return Err(invalid_state(
                    "terminal_reservations",
                    "duplicate reservation fingerprint",
                ));
            }
            insert_operation_id(&mut operation_ids, &terminal.reserve.operation_id)?;
            insert_operation_id(&mut operation_ids, &terminal.terminal.operation_id)?;
            accumulate_reserve(&mut expected, terminal.reserve.reserved_quota)?;
            accumulate_terminal(&mut expected, &terminal.terminal)?;
        }

        expected.active_reservations = usize_to_u64(
            self.active_reservations.len(),
            "summary.active_reservations",
        )?;
        expected.terminal_reservations = usize_to_u64(
            self.terminal_reservations.len(),
            "summary.terminal_reservations",
        )?;
        expected.applied_count = checked_add_u64(
            expected.reserve_count,
            expected.terminal_reservations,
            "summary.applied_count",
        )?;
        let classified_observations = checked_add_u64(
            checked_add_u64(
                expected.applied_count,
                expected.replay_count,
                "summary.observation_count",
            )?,
            expected.conflict_count,
            "summary.observation_count",
        )?;
        if expected.observation_count != classified_observations {
            return Err(invalid_state(
                "summary.observation_count",
                "must equal applied_count + replay_count + conflict_count",
            ));
        }
        if self.summary != expected {
            return Err(invalid_state(
                "summary",
                "summary does not match retained reservation state",
            ));
        }
        Ok(())
    }

    fn apply_validated(
        &mut self,
        observation: QuotaObservation,
    ) -> Result<ApplyOutcome, QuotaCoordinatorError> {
        increment_u64(
            &mut self.summary.observation_count,
            "summary.observation_count",
        )?;

        if let Some(existing) = self
            .observation_for_operation_id(&observation.operation_id)
            .cloned()
        {
            if existing == observation {
                increment_u64(&mut self.summary.replay_count, "summary.replay_count")?;
                return Ok(ApplyOutcome::Replay {
                    summary: self.summary.clone(),
                });
            }
            return self.conflict(QuotaConflict::OperationIdPayloadConflict {
                operation_id: observation.operation_id,
            });
        }

        match observation.kind {
            QuotaObservationKind::Reserve => self.apply_reserve(observation),
            QuotaObservationKind::Settle | QuotaObservationKind::Refund => {
                self.apply_terminal(observation)
            }
        }
    }

    fn apply_reserve(
        &mut self,
        observation: QuotaObservation,
    ) -> Result<ApplyOutcome, QuotaCoordinatorError> {
        let fingerprint = observation.reservation_fingerprint.clone();
        if self.active_reservations.contains_key(&fingerprint)
            || self.terminal_for_fingerprint(&fingerprint).is_some()
        {
            return self.conflict(QuotaConflict::RepeatedReserve {
                reservation_fingerprint: fingerprint,
            });
        }
        if self.active_reservations.len() >= self.max_active_reservations as usize {
            return self.conflict(QuotaConflict::ActiveCapacityExceeded {
                limit: self.max_active_reservations,
            });
        }

        let quota = observation.reserved_quota;
        let negative_quota = checked_neg_i64(quota, "shadow_delta.user_net_delta")?;
        accumulate_reserve(&mut self.summary, quota)?;
        self.active_reservations.insert(
            fingerprint,
            ActiveReservation {
                reserve: observation,
            },
        );
        self.refresh_collection_counts()?;

        Ok(ApplyOutcome::Applied {
            shadow_delta: QuotaShadowDelta {
                reserved_quota_delta: quota,
                final_quota_delta: 0,
                refunded_quota_delta: 0,
                outstanding_quota_delta: quota,
                user_net_delta: negative_quota,
                token_net_delta: negative_quota,
                channel_used_quota_delta: 0,
                request_count_delta: 0,
            },
            summary: self.summary.clone(),
        })
    }

    fn apply_terminal(
        &mut self,
        observation: QuotaObservation,
    ) -> Result<ApplyOutcome, QuotaCoordinatorError> {
        let fingerprint = observation.reservation_fingerprint.clone();
        if let Some(existing) = self.terminal_for_fingerprint(&fingerprint) {
            let existing_generation = existing.terminal.generation;
            if existing_generation != observation.generation {
                return self.conflict(QuotaConflict::GenerationMismatch {
                    reservation_fingerprint: fingerprint,
                    expected: existing_generation,
                    actual: observation.generation,
                });
            }
            return self.conflict(QuotaConflict::RepeatedTerminal {
                reservation_fingerprint: fingerprint,
            });
        }

        let Some(active) = self.active_reservations.get(&fingerprint).cloned() else {
            return self.conflict(QuotaConflict::MissingReserve {
                reservation_fingerprint: fingerprint,
            });
        };
        if active.reserve.reserved_quota != observation.reserved_quota {
            return self.conflict(QuotaConflict::QuotaMismatch {
                reservation_fingerprint: fingerprint,
                expected_reserved_quota: active.reserve.reserved_quota,
                actual_reserved_quota: observation.reserved_quota,
            });
        }
        if self.terminal_reservations.len() >= self.max_terminal_reservations as usize {
            return self.conflict(QuotaConflict::TerminalCapacityExceeded {
                limit: self.max_terminal_reservations,
            });
        }

        let reserved_quota = active.reserve.reserved_quota;
        let outstanding_delta =
            checked_neg_i64(reserved_quota, "shadow_delta.outstanding_quota_delta")?;
        let (user_delta, channel_delta, final_delta, refunded_delta) = match observation.kind {
            QuotaObservationKind::Settle => {
                let user_delta = checked_sub_i64(
                    reserved_quota,
                    observation.final_quota,
                    "shadow_delta.user_net_delta",
                )?;
                (
                    user_delta,
                    observation.final_quota,
                    observation.final_quota,
                    user_delta.max(0),
                )
            }
            QuotaObservationKind::Refund => (reserved_quota, 0, 0, reserved_quota),
            QuotaObservationKind::Reserve => unreachable!("validated terminal kind"),
        };
        let request_count_delta = observation.request_count;

        accumulate_terminal(&mut self.summary, &observation)?;
        let removed = self
            .active_reservations
            .remove(&fingerprint)
            .ok_or_else(|| invalid_state("active_reservations", "reservation disappeared"))?;
        self.terminal_reservations.push_back(TerminalReservation {
            reserve: removed.reserve,
            terminal: observation,
        });
        self.refresh_collection_counts()?;

        Ok(ApplyOutcome::Applied {
            shadow_delta: QuotaShadowDelta {
                reserved_quota_delta: 0,
                final_quota_delta: final_delta,
                refunded_quota_delta: refunded_delta,
                outstanding_quota_delta: outstanding_delta,
                user_net_delta: user_delta,
                token_net_delta: user_delta,
                channel_used_quota_delta: channel_delta,
                request_count_delta,
            },
            summary: self.summary.clone(),
        })
    }

    fn conflict(&mut self, reason: QuotaConflict) -> Result<ApplyOutcome, QuotaCoordinatorError> {
        increment_u64(&mut self.summary.conflict_count, "summary.conflict_count")?;
        Ok(ApplyOutcome::Conflict {
            reason,
            summary: self.summary.clone(),
        })
    }

    fn observation_for_operation_id(&self, operation_id: &str) -> Option<&QuotaObservation> {
        for active in self.active_reservations.values() {
            if active.reserve.operation_id == operation_id {
                return Some(&active.reserve);
            }
        }
        for terminal in &self.terminal_reservations {
            if terminal.reserve.operation_id == operation_id {
                return Some(&terminal.reserve);
            }
            if terminal.terminal.operation_id == operation_id {
                return Some(&terminal.terminal);
            }
        }
        None
    }

    fn terminal_for_fingerprint(&self, fingerprint: &str) -> Option<&TerminalReservation> {
        self.terminal_reservations
            .iter()
            .find(|record| record.reserve.reservation_fingerprint == fingerprint)
    }

    fn refresh_collection_counts(&mut self) -> Result<(), QuotaCoordinatorError> {
        self.summary.active_reservations = usize_to_u64(
            self.active_reservations.len(),
            "summary.active_reservations",
        )?;
        self.summary.terminal_reservations = usize_to_u64(
            self.terminal_reservations.len(),
            "summary.terminal_reservations",
        )?;
        Ok(())
    }
}

pub fn apply(
    state: &mut QuotaCoordinatorState,
    observation: QuotaObservation,
) -> Result<ApplyOutcome, QuotaCoordinatorError> {
    state.apply(observation)
}

pub fn summary(state: &QuotaCoordinatorState) -> &QuotaCoordinatorSummary {
    state.summary()
}

fn validate_limit(
    field: &'static str,
    value: u32,
    hard_max: u32,
) -> Result<(), QuotaCoordinatorError> {
    if value == 0 || value > hard_max {
        Err(invalid_state(
            field,
            format!("must be between 1 and {hard_max}, got {value}"),
        ))
    } else {
        Ok(())
    }
}

fn insert_operation_id<'a>(
    operation_ids: &mut BTreeSet<&'a str>,
    operation_id: &'a str,
) -> Result<(), QuotaCoordinatorError> {
    if operation_ids.insert(operation_id) {
        Ok(())
    } else {
        Err(invalid_state(
            "operation_id",
            "duplicate retained operation ID",
        ))
    }
}

fn accumulate_reserve(
    summary: &mut QuotaCoordinatorSummary,
    reserved_quota: i64,
) -> Result<(), QuotaCoordinatorError> {
    increment_u64(&mut summary.reserve_count, "summary.reserve_count")?;
    increment_u64(&mut summary.applied_count, "summary.applied_count")?;
    add_i64(
        &mut summary.outstanding_quota,
        reserved_quota,
        "summary.outstanding_quota",
    )?;
    add_i64(
        &mut summary.reserved_quota,
        reserved_quota,
        "summary.reserved_quota",
    )?;
    let negative_quota = checked_neg_i64(reserved_quota, "summary.user_net_delta")?;
    add_i64(
        &mut summary.user_net_delta,
        negative_quota,
        "summary.user_net_delta",
    )?;
    add_i64(
        &mut summary.token_net_delta,
        negative_quota,
        "summary.token_net_delta",
    )
}

fn accumulate_terminal(
    summary: &mut QuotaCoordinatorSummary,
    observation: &QuotaObservation,
) -> Result<(), QuotaCoordinatorError> {
    increment_u64(&mut summary.applied_count, "summary.applied_count")?;
    add_i64(
        &mut summary.outstanding_quota,
        checked_neg_i64(observation.reserved_quota, "summary.outstanding_quota")?,
        "summary.outstanding_quota",
    )?;
    add_u64(
        &mut summary.request_count,
        observation.request_count,
        "summary.request_count",
    )?;

    match observation.kind {
        QuotaObservationKind::Settle => {
            increment_u64(&mut summary.settle_count, "summary.settle_count")?;
            add_i64(
                &mut summary.final_quota,
                observation.final_quota,
                "summary.final_quota",
            )?;
            add_i64(
                &mut summary.channel_used_quota,
                observation.final_quota,
                "summary.channel_used_quota",
            )?;
            let delta = checked_sub_i64(
                observation.reserved_quota,
                observation.final_quota,
                "summary.user_net_delta",
            )?;
            if delta > 0 {
                add_i64(&mut summary.refunded_quota, delta, "summary.refunded_quota")?;
            }
            add_i64(&mut summary.user_net_delta, delta, "summary.user_net_delta")?;
            add_i64(
                &mut summary.token_net_delta,
                delta,
                "summary.token_net_delta",
            )
        }
        QuotaObservationKind::Refund => {
            increment_u64(&mut summary.refund_count, "summary.refund_count")?;
            add_i64(
                &mut summary.refunded_quota,
                observation.reserved_quota,
                "summary.refunded_quota",
            )?;
            add_i64(
                &mut summary.user_net_delta,
                observation.reserved_quota,
                "summary.user_net_delta",
            )?;
            add_i64(
                &mut summary.token_net_delta,
                observation.reserved_quota,
                "summary.token_net_delta",
            )
        }
        QuotaObservationKind::Reserve => Err(invalid_state(
            "terminal_reservations",
            "reserve cannot be accumulated as terminal",
        )),
    }
}

fn increment_u64(value: &mut u64, field: &'static str) -> Result<(), QuotaCoordinatorError> {
    add_u64(value, 1, field)
}

fn add_u64(value: &mut u64, delta: u64, field: &'static str) -> Result<(), QuotaCoordinatorError> {
    *value = checked_add_u64(*value, delta, field)?;
    Ok(())
}

fn checked_add_u64(
    left: u64,
    right: u64,
    field: &'static str,
) -> Result<u64, QuotaCoordinatorError> {
    left.checked_add(right)
        .ok_or(QuotaCoordinatorError::ArithmeticOverflow { field })
}

fn add_i64(value: &mut i64, delta: i64, field: &'static str) -> Result<(), QuotaCoordinatorError> {
    *value = value
        .checked_add(delta)
        .ok_or(QuotaCoordinatorError::ArithmeticOverflow { field })?;
    Ok(())
}

fn checked_sub_i64(
    left: i64,
    right: i64,
    field: &'static str,
) -> Result<i64, QuotaCoordinatorError> {
    left.checked_sub(right)
        .ok_or(QuotaCoordinatorError::ArithmeticOverflow { field })
}

fn checked_neg_i64(value: i64, field: &'static str) -> Result<i64, QuotaCoordinatorError> {
    value
        .checked_neg()
        .ok_or(QuotaCoordinatorError::ArithmeticOverflow { field })
}

fn usize_to_u64(value: usize, field: &'static str) -> Result<u64, QuotaCoordinatorError> {
    u64::try_from(value).map_err(|_| QuotaCoordinatorError::ArithmeticOverflow { field })
}

fn invalid_state(field: &'static str, message: impl Into<String>) -> QuotaCoordinatorError {
    QuotaCoordinatorError::InvalidState {
        field,
        message: message.into(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum QuotaCoordinatorError {
    #[error(transparent)]
    InvalidObservation(#[from] QuotaObservationValidationError),
    #[error("invalid quota coordinator state field {field}: {message}")]
    InvalidState {
        field: &'static str,
        message: String,
    },
    #[error("quota coordinator arithmetic overflow in {field}")]
    ArithmeticOverflow { field: &'static str },
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(character: char) -> String {
        character.to_string().repeat(64)
    }

    fn reserve(operation: char, fingerprint: char, quota: i64) -> QuotaObservation {
        QuotaObservation::reserve(hex(operation), hex(fingerprint), quota).unwrap()
    }

    fn settle(
        operation: char,
        fingerprint: char,
        generation: u64,
        reserved_quota: i64,
        final_quota: i64,
    ) -> QuotaObservation {
        QuotaObservation::settle(
            hex(operation),
            hex(fingerprint),
            generation,
            reserved_quota,
            final_quota,
            1,
        )
        .unwrap()
    }

    fn refund(
        operation: char,
        fingerprint: char,
        generation: u64,
        reserved_quota: i64,
        request_count: u64,
    ) -> QuotaObservation {
        QuotaObservation::refund(
            hex(operation),
            hex(fingerprint),
            generation,
            reserved_quota,
            request_count,
        )
        .unwrap()
    }

    fn applied_delta(outcome: ApplyOutcome) -> QuotaShadowDelta {
        match outcome {
            ApplyOutcome::Applied { shadow_delta, .. } => shadow_delta,
            other => panic!("expected applied outcome, got {other:?}"),
        }
    }

    #[test]
    fn observation_contract_round_trips_and_rejects_unknown_fields() {
        let observation = settle('a', 'b', 7, 100, 125);
        let json = serde_json::to_string(&observation).unwrap();
        assert!(json.contains(r#""contract_version":1"#));
        assert!(json.contains(r#""kind":"settle""#));
        assert_eq!(
            serde_json::from_str::<QuotaObservation>(&json).unwrap(),
            observation
        );

        let with_unknown = json.replacen("{", r#"{"model":"forbidden","#, 1);
        assert!(serde_json::from_str::<QuotaObservation>(&with_unknown).is_err());
    }

    #[test]
    fn validation_rejects_ids_quota_and_kind_invariants() {
        let mut observation = reserve('a', 'b', 1);
        observation.operation_id = "A".repeat(64);
        assert!(matches!(
            observation.validate(),
            Err(QuotaObservationValidationError::InvalidHexId {
                field: "operation_id"
            })
        ));

        let mut observation = reserve('a', 'b', 1);
        observation.reservation_fingerprint = "g".repeat(64);
        assert!(observation.validate().is_err());

        let mut observation = reserve('a', 'b', 1);
        observation.reserved_quota = -1;
        assert!(observation.validate().is_err());
        observation.reserved_quota = MAX_QUOTA + 1;
        assert!(observation.validate().is_err());

        let mut observation = reserve('a', 'b', 1);
        observation.generation = 2;
        assert!(observation.validate().is_err());
        observation.generation = 1;
        observation.final_quota = 1;
        assert!(observation.validate().is_err());
        observation.final_quota = 0;
        observation.request_count = 1;
        assert!(observation.validate().is_err());

        let mut observation = refund('c', 'b', 2, 1, 0);
        observation.final_quota = 1;
        assert!(observation.validate().is_err());
        observation.final_quota = 0;
        observation.generation = 1;
        assert!(observation.validate().is_err());

        let mut observation = settle('d', 'b', 2, 1, 1);
        observation.request_count = 2;
        assert!(observation.validate().is_err());
    }

    #[test]
    fn settle_can_charge_more_or_less_than_the_reservation() {
        let mut state = QuotaCoordinatorState::new();
        let reserve_delta = applied_delta(state.apply(reserve('a', 'b', 100)).unwrap());
        assert_eq!(reserve_delta.reserved_quota_delta, 100);
        assert_eq!(reserve_delta.user_net_delta, -100);
        assert_eq!(reserve_delta.outstanding_quota_delta, 100);

        let settle_delta = applied_delta(state.apply(settle('c', 'b', 8, 100, 125)).unwrap());
        assert_eq!(settle_delta.outstanding_quota_delta, -100);
        assert_eq!(settle_delta.final_quota_delta, 125);
        assert_eq!(settle_delta.refunded_quota_delta, 0);
        assert_eq!(settle_delta.user_net_delta, -25);
        assert_eq!(settle_delta.token_net_delta, -25);
        assert_eq!(settle_delta.channel_used_quota_delta, 125);
        assert_eq!(settle_delta.request_count_delta, 1);
        assert_eq!(state.summary().reserved_quota, 100);
        assert_eq!(state.summary().final_quota, 125);
        assert_eq!(state.summary().user_net_delta, -125);
        assert_eq!(state.summary().token_net_delta, -125);
        assert_eq!(state.summary().channel_used_quota, 125);
        assert_eq!(state.summary().request_count, 1);
        assert_eq!(state.summary().active_reservations, 0);
        assert_eq!(state.summary().terminal_reservations, 1);

        let mut state = QuotaCoordinatorState::new();
        state.apply(reserve('d', 'e', 100)).unwrap();
        let delta = applied_delta(state.apply(settle('f', 'e', 2, 100, 60)).unwrap());
        assert_eq!(delta.user_net_delta, 40);
        assert_eq!(delta.refunded_quota_delta, 40);
        assert_eq!(state.summary().user_net_delta, -60);
        assert_eq!(state.summary().final_quota, 60);
        assert_eq!(state.summary().refunded_quota, 40);
    }

    #[test]
    fn refund_clears_outstanding_quota_without_becoming_a_writer() {
        let mut state = QuotaCoordinatorState::new();
        state.apply(reserve('a', 'b', 75)).unwrap();
        let delta = applied_delta(state.apply(refund('c', 'b', 3, 75, 0)).unwrap());
        assert_eq!(delta.outstanding_quota_delta, -75);
        assert_eq!(delta.user_net_delta, 75);
        assert_eq!(delta.refunded_quota_delta, 75);
        assert_eq!(delta.channel_used_quota_delta, 0);
        assert_eq!(state.summary().outstanding_quota, 0);
        assert_eq!(state.summary().refunded_quota, 75);
        assert_eq!(state.summary().final_quota, 0);
        assert_eq!(state.summary().user_net_delta, 0);
        assert_eq!(state.summary().token_net_delta, 0);
        assert_eq!(state.summary().request_count, 0);
    }

    #[test]
    fn exact_operation_replays_are_idempotent_before_and_after_terminal() {
        let mut state = QuotaCoordinatorState::new();
        let reserve = reserve('a', 'b', 10);
        state.apply(reserve.clone()).unwrap();
        assert!(matches!(
            state.apply(reserve.clone()).unwrap(),
            ApplyOutcome::Replay { .. }
        ));

        let settle = settle('c', 'b', 2, 10, 12);
        state.apply(settle.clone()).unwrap();
        assert!(matches!(
            state.apply(settle).unwrap(),
            ApplyOutcome::Replay { .. }
        ));
        assert!(matches!(
            state.apply(reserve).unwrap(),
            ApplyOutcome::Replay { .. }
        ));
        assert_eq!(state.summary().observation_count, 5);
        assert_eq!(state.summary().applied_count, 2);
        assert_eq!(state.summary().replay_count, 3);
        assert_eq!(state.summary().conflict_count, 0);
        assert_eq!(state.summary().final_quota, 12);
    }

    #[test]
    fn operation_id_payload_conflict_is_persistable() {
        let mut state = QuotaCoordinatorState::new();
        state.apply(reserve('a', 'b', 10)).unwrap();
        let outcome = state.apply(reserve('a', 'c', 10)).unwrap();
        assert!(matches!(
            outcome,
            ApplyOutcome::Conflict {
                reason: QuotaConflict::OperationIdPayloadConflict { .. },
                ..
            }
        ));
        assert_eq!(state.summary().conflict_count, 1);
        assert_eq!(outcome.summary().conflict_count, 1);
        assert!(serde_json::to_string(&outcome)
            .unwrap()
            .contains(r#""outcome":"conflict""#));

        let persisted = serde_json::to_string(&state).unwrap();
        let restored: QuotaCoordinatorState = serde_json::from_str(&persisted).unwrap();
        assert_eq!(restored.summary().conflict_count, 1);
        assert_eq!(restored, state);
    }

    #[test]
    fn missing_reserve_and_quota_mismatch_are_fail_closed() {
        let mut state = QuotaCoordinatorState::new();
        assert!(matches!(
            state.apply(settle('a', 'b', 2, 10, 10)).unwrap(),
            ApplyOutcome::Conflict {
                reason: QuotaConflict::MissingReserve { .. },
                ..
            }
        ));
        state.apply(reserve('c', 'b', 10)).unwrap();
        assert!(matches!(
            state.apply(settle('d', 'b', 2, 9, 9)).unwrap(),
            ApplyOutcome::Conflict {
                reason: QuotaConflict::QuotaMismatch { .. },
                ..
            }
        ));
        assert!(state.has_active_reservation(&hex('b')));
        assert_eq!(state.summary().outstanding_quota, 10);
        assert_eq!(state.summary().conflict_count, 2);
    }

    #[test]
    fn repeated_terminal_and_generation_mismatch_are_distinct() {
        let mut state = QuotaCoordinatorState::new();
        state.apply(reserve('a', 'b', 10)).unwrap();
        state.apply(settle('c', 'b', 4, 10, 8)).unwrap();

        assert!(matches!(
            state.apply(refund('d', 'b', 4, 10, 0)).unwrap(),
            ApplyOutcome::Conflict {
                reason: QuotaConflict::RepeatedTerminal { .. },
                ..
            }
        ));
        assert!(matches!(
            state.apply(refund('e', 'b', 5, 10, 0)).unwrap(),
            ApplyOutcome::Conflict {
                reason: QuotaConflict::GenerationMismatch {
                    expected: 4,
                    actual: 5,
                    ..
                },
                ..
            }
        ));
        assert_eq!(state.summary().conflict_count, 2);
        assert_eq!(state.summary().final_quota, 8);
    }

    #[test]
    fn active_and_terminal_capacity_conflicts_preserve_state() {
        let mut state = QuotaCoordinatorState::with_limits(1, 1).unwrap();
        state.apply(reserve('a', 'b', 10)).unwrap();
        assert!(matches!(
            state.apply(reserve('c', 'd', 20)).unwrap(),
            ApplyOutcome::Conflict {
                reason: QuotaConflict::ActiveCapacityExceeded { limit: 1 },
                ..
            }
        ));
        state.apply(settle('e', 'b', 2, 10, 10)).unwrap();
        state.apply(reserve('f', 'd', 20)).unwrap();

        assert!(matches!(
            state.apply(refund('1', 'd', 2, 20, 0)).unwrap(),
            ApplyOutcome::Conflict {
                reason: QuotaConflict::TerminalCapacityExceeded { limit: 1 },
                ..
            }
        ));
        assert!(state.has_active_reservation(&hex('d')));
        assert_eq!(state.summary().active_reservations, 1);
        assert_eq!(state.summary().terminal_reservations, 1);
        assert_eq!(state.summary().outstanding_quota, 20);
        assert_eq!(state.summary().conflict_count, 2);
    }

    #[test]
    fn invalid_observation_and_overflow_errors_are_transactional() {
        let mut state = QuotaCoordinatorState::new();
        let mut invalid = reserve('a', 'b', 10);
        invalid.final_quota = 1;
        let before = state.clone();
        assert!(matches!(
            state.apply(invalid),
            Err(QuotaCoordinatorError::InvalidObservation(_))
        ));
        assert_eq!(state, before);

        state.summary.observation_count = u64::MAX;
        state.summary.conflict_count = u64::MAX;
        state.validate().unwrap();
        let before = state.clone();
        assert!(matches!(
            state.apply(settle('c', 'd', 2, 1, 1)),
            Err(QuotaCoordinatorError::ArithmeticOverflow {
                field: "summary.observation_count"
            })
        ));
        assert_eq!(state, before);
    }

    #[test]
    fn serialized_state_contains_only_bounded_accounting_metadata() {
        let mut state = QuotaCoordinatorState::with_limits(2, 2).unwrap();
        state.apply(reserve('a', 'b', MAX_QUOTA)).unwrap();
        state
            .apply(settle('c', 'b', u64::MAX, MAX_QUOTA, MAX_QUOTA))
            .unwrap();
        state.validate().unwrap();

        let json = serde_json::to_string(&state).unwrap();
        for forbidden in [
            "credential",
            "api_key",
            "model",
            "expression",
            "request_body",
            "username",
        ] {
            assert!(!json.contains(forbidden), "state leaked {forbidden}");
        }
        assert!(json.contains(r#""contract_version":1"#));
        assert!(json.contains(r#""max_active_reservations":2"#));
        let restored: QuotaCoordinatorState = serde_json::from_str(&json).unwrap();
        assert_eq!(restored, state);
    }

    #[test]
    fn deserialization_rejects_tampered_summary() {
        let mut state = QuotaCoordinatorState::new();
        state.apply(reserve('a', 'b', 10)).unwrap();
        let mut value = serde_json::to_value(&state).unwrap();
        value["summary"]["conflict_count"] = serde_json::json!(1);
        assert!(serde_json::from_value::<QuotaCoordinatorState>(value).is_err());

        let mut value = serde_json::to_value(&state).unwrap();
        value["summary"]["model"] = serde_json::json!("forbidden");
        assert!(serde_json::from_value::<QuotaCoordinatorState>(value).is_err());
    }
}
