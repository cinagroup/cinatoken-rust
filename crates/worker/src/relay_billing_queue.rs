use cinatoken_storage::AuditLogEvent;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use worker::D1Database;

use crate::d1_repositories::{
    RelayBillingRequestAccounting, RelayBillingReservationFinalizationOutcome,
};

pub(crate) const BILLING_QUEUE_BINDING: &str = "BILLING_QUEUE";
pub(crate) const BILLING_FINALIZATION_EVENT_TYPE: &str = "cinatoken.relay_billing_finalization";
pub(crate) const BILLING_FINALIZATION_SCHEMA_VERSION: u16 = 1;
const BILLING_FINALIZATION_MAX_EVENT_BYTES: usize = 64 * 1024;
const BILLING_FINALIZATION_MAX_RESERVATION_KEY_BYTES: usize = 160;
const BILLING_FINALIZATION_MAX_GROUP_BYTES: usize = 128;
const BILLING_FINALIZATION_MAX_REASON_BYTES: usize = 96;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WorkerQueueKind {
    AuditLog,
    RelayBillingFinalization,
}

pub(crate) fn worker_queue_kind(queue_name: &str) -> Option<WorkerQueueKind> {
    match queue_name {
        "cinatoken-rust-log-events" | "cinatoken-rust-log-events-staging" => {
            Some(WorkerQueueKind::AuditLog)
        }
        "cinatoken-rust-billing-finalization"
        | "cinatoken-rust-billing-finalization-staging"
        | "cinatoken-rust-billing-finalization-runtime" => {
            Some(WorkerQueueKind::RelayBillingFinalization)
        }
        _ => None,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum RelayBillingFinalizationAction {
    Settle {
        final_quota: i64,
        finalization_reason: String,
    },
    Refund {
        finalization_reason: String,
        account_request: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RelayBillingFinalizationAudit {
    pub user_id: i64,
    pub created_at: i64,
    pub log_type: i32,
    pub content: String,
    pub model_name: String,
    pub quota: i64,
    pub prompt_tokens: i32,
    pub completion_tokens: i32,
    pub use_time: i64,
    pub is_stream: i32,
    pub channel_id: i64,
    pub token_id: i64,
    pub group: String,
    pub other: String,
}

impl From<AuditLogEvent> for RelayBillingFinalizationAudit {
    fn from(event: AuditLogEvent) -> Self {
        Self {
            user_id: event.user_id,
            created_at: event.created_at,
            log_type: event.log_type,
            content: event.content,
            model_name: event.model_name,
            quota: event.quota,
            prompt_tokens: event.prompt_tokens,
            completion_tokens: event.completion_tokens,
            use_time: event.use_time,
            is_stream: event.is_stream,
            channel_id: event.channel_id,
            token_id: event.token_id,
            group: event.group,
            other: event.other,
        }
    }
}

impl RelayBillingFinalizationAudit {
    fn into_audit_log_event(self) -> AuditLogEvent {
        AuditLogEvent {
            user_id: self.user_id,
            created_at: self.created_at,
            log_type: self.log_type,
            content: self.content,
            username: String::new(),
            token_name: String::new(),
            model_name: self.model_name,
            quota: self.quota,
            prompt_tokens: self.prompt_tokens,
            completion_tokens: self.completion_tokens,
            use_time: self.use_time,
            is_stream: self.is_stream,
            channel_id: self.channel_id,
            token_id: self.token_id,
            group: self.group,
            ip: String::new(),
            request_id: String::new(),
            upstream_request_id: String::new(),
            other: self.other,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RelayBillingFinalizationEvent {
    pub event_type: String,
    pub schema_version: u16,
    pub event_id: String,
    pub reservation_key: String,
    pub expr_hash: String,
    pub channel_id: i64,
    pub selected_group: String,
    pub finalized_at: i64,
    pub finalization: RelayBillingFinalizationAction,
    pub audit_log: RelayBillingFinalizationAudit,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum WorkerQueueEvent {
    RelayBillingFinalization(RelayBillingFinalizationEvent),
    AuditLog(AuditLogEvent),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RelayBillingFinalizationApplyOutcome {
    Applied,
    Replay,
}

impl RelayBillingFinalizationEvent {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn settlement(
        reservation_key: &str,
        expr_hash: &str,
        channel_id: i64,
        selected_group: &str,
        final_quota: i64,
        finalization_reason: &str,
        finalized_at: i64,
        audit_log: AuditLogEvent,
    ) -> worker::Result<Self> {
        Self::new(
            reservation_key,
            expr_hash,
            channel_id,
            selected_group,
            finalized_at,
            RelayBillingFinalizationAction::Settle {
                final_quota,
                finalization_reason: finalization_reason.to_string(),
            },
            audit_log,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn refund(
        reservation_key: &str,
        expr_hash: &str,
        channel_id: i64,
        selected_group: &str,
        finalization_reason: &str,
        account_request: bool,
        finalized_at: i64,
        audit_log: AuditLogEvent,
    ) -> worker::Result<Self> {
        Self::new(
            reservation_key,
            expr_hash,
            channel_id,
            selected_group,
            finalized_at,
            RelayBillingFinalizationAction::Refund {
                finalization_reason: finalization_reason.to_string(),
                account_request,
            },
            audit_log,
        )
    }

    fn new(
        reservation_key: &str,
        expr_hash: &str,
        channel_id: i64,
        selected_group: &str,
        finalized_at: i64,
        finalization: RelayBillingFinalizationAction,
        audit_log: AuditLogEvent,
    ) -> worker::Result<Self> {
        let reservation_key = reservation_key.trim();
        let event_id = billing_finalization_event_id(reservation_key);
        let mut audit_log = RelayBillingFinalizationAudit::from(audit_log);
        attach_audit_event_identity(&mut audit_log, &event_id, reservation_key)?;
        let event = Self {
            event_type: BILLING_FINALIZATION_EVENT_TYPE.to_string(),
            schema_version: BILLING_FINALIZATION_SCHEMA_VERSION,
            event_id,
            reservation_key: reservation_key.to_string(),
            expr_hash: expr_hash.trim().to_string(),
            channel_id,
            selected_group: selected_group.trim().to_string(),
            finalized_at,
            finalization,
            audit_log,
        };
        event.validate()?;
        Ok(event)
    }

    pub(crate) fn validate(&self) -> worker::Result<()> {
        if self.event_type != BILLING_FINALIZATION_EVENT_TYPE
            || self.schema_version != BILLING_FINALIZATION_SCHEMA_VERSION
        {
            return Err(finalization_error(
                "relay billing finalization event schema is unsupported",
            ));
        }
        if self.reservation_key.is_empty()
            || self.reservation_key.len() > BILLING_FINALIZATION_MAX_RESERVATION_KEY_BYTES
            || self.event_id != billing_finalization_event_id(&self.reservation_key)
        {
            return Err(finalization_error(
                "relay billing finalization event identity is invalid",
            ));
        }
        if self.expr_hash.is_empty()
            || self.expr_hash.len() > 96
            || self.channel_id <= 0
            || self.selected_group.is_empty()
            || self.selected_group.len() > BILLING_FINALIZATION_MAX_GROUP_BYTES
            || self.finalized_at <= 0
        {
            return Err(finalization_error(
                "relay billing finalization decision is invalid",
            ));
        }
        let (final_quota, reason) = match &self.finalization {
            RelayBillingFinalizationAction::Settle {
                final_quota,
                finalization_reason,
            } => (Some(*final_quota), finalization_reason.as_str()),
            RelayBillingFinalizationAction::Refund {
                finalization_reason,
                ..
            } => (None, finalization_reason.as_str()),
        };
        if final_quota.is_some_and(|quota| quota < 0)
            || reason.is_empty()
            || reason.len() > BILLING_FINALIZATION_MAX_REASON_BYTES
        {
            return Err(finalization_error(
                "relay billing finalization action is invalid",
            ));
        }
        if self.audit_log.user_id <= 0
            || self.audit_log.token_id < 0
            || self.audit_log.channel_id != self.channel_id
            || self.audit_log.group != self.selected_group
            || self.audit_log.created_at != self.finalized_at
            || self.audit_log.model_name.trim().is_empty()
            || self.audit_log.content.trim().is_empty()
            || self.audit_log.prompt_tokens < 0
            || self.audit_log.completion_tokens < 0
            || self.audit_log.use_time < 0
            || !matches!(self.audit_log.is_stream, 0 | 1)
        {
            return Err(finalization_error(
                "relay billing finalization audit identity is invalid",
            ));
        }
        match self.finalization {
            RelayBillingFinalizationAction::Settle { final_quota, .. }
                if self.audit_log.quota != final_quota =>
            {
                return Err(finalization_error(
                    "relay billing settlement audit quota does not match",
                ));
            }
            RelayBillingFinalizationAction::Refund { .. } if self.audit_log.quota != 0 => {
                return Err(finalization_error(
                    "relay billing refund audit quota must be zero",
                ));
            }
            _ => {}
        }
        let other: Value = serde_json::from_str(&self.audit_log.other).map_err(|_| {
            finalization_error("relay billing finalization audit metadata is invalid")
        })?;
        if other
            .get("billing_finalization_event_id")
            .and_then(Value::as_str)
            != Some(self.event_id.as_str())
            || other.get("billing_reservation_key").and_then(Value::as_str)
                != Some(self.reservation_key.as_str())
        {
            return Err(finalization_error(
                "relay billing finalization audit marker does not match",
            ));
        }
        let serialized = serde_json::to_vec(self).map_err(|_| {
            finalization_error("relay billing finalization event cannot be serialized")
        })?;
        if serialized.len() > BILLING_FINALIZATION_MAX_EVENT_BYTES {
            return Err(finalization_error(
                "relay billing finalization event exceeds the bounded size",
            ));
        }
        Ok(())
    }
}

pub(crate) async fn apply_relay_billing_finalization_event(
    db: &D1Database,
    event: &RelayBillingFinalizationEvent,
) -> worker::Result<RelayBillingFinalizationApplyOutcome> {
    event.validate()?;
    let reservation = crate::d1_repositories::relay_billing_reservation(db, &event.reservation_key)
        .await?
        .ok_or_else(|| {
            finalization_error("relay billing finalization reservation was not found")
        })?;
    if reservation.user_id != event.audit_log.user_id
        || reservation.token_id != event.audit_log.token_id
        || reservation.expr_hash != event.expr_hash
        || reservation.channel_id != event.channel_id
        || reservation.selected_group != event.selected_group
    {
        return Err(finalization_error(
            "relay billing finalization reservation identity conflicts",
        ));
    }

    let outcome = match &event.finalization {
        RelayBillingFinalizationAction::Settle {
            final_quota,
            finalization_reason,
        } => {
            crate::d1_repositories::settle_relay_billing_reservation(
                db,
                &event.reservation_key,
                event.channel_id,
                &event.selected_group,
                *final_quota,
                finalization_reason,
                event.finalized_at,
            )
            .await?
        }
        RelayBillingFinalizationAction::Refund {
            finalization_reason,
            account_request,
        } => {
            crate::d1_repositories::refund_relay_billing_reservation(
                db,
                &event.reservation_key,
                finalization_reason,
                if *account_request {
                    RelayBillingRequestAccounting::Account
                } else {
                    RelayBillingRequestAccounting::Skip
                },
                event.finalized_at,
            )
            .await?
        }
    };
    let replay = match outcome {
        RelayBillingReservationFinalizationOutcome::Applied => false,
        RelayBillingReservationFinalizationOutcome::MatchingSettled
        | RelayBillingReservationFinalizationOutcome::MatchingRefund => true,
        other => {
            return Err(finalization_error(format!(
                "relay billing finalization CAS rejected the event: {other:?}"
            )))
        }
    };
    let audit_log = event.audit_log.clone().into_audit_log_event();
    crate::d1_repositories::insert_billing_finalization_audit_log_event(
        db,
        &event.event_id,
        &audit_log,
    )
    .await?;
    Ok(if replay {
        RelayBillingFinalizationApplyOutcome::Replay
    } else {
        RelayBillingFinalizationApplyOutcome::Applied
    })
}

fn billing_finalization_event_id(reservation_key: &str) -> String {
    format!("relay-finalization-v1:{reservation_key}")
}

fn attach_audit_event_identity(
    audit_log: &mut RelayBillingFinalizationAudit,
    event_id: &str,
    reservation_key: &str,
) -> worker::Result<()> {
    let mut other: Value = serde_json::from_str(&audit_log.other)
        .map_err(|_| finalization_error("relay billing audit metadata is invalid"))?;
    let object = other
        .as_object_mut()
        .ok_or_else(|| finalization_error("relay billing audit metadata must be an object"))?;
    object.insert(
        "billing_finalization_event_id".to_string(),
        Value::String(event_id.to_string()),
    );
    object.insert(
        "billing_finalization_transport".to_string(),
        Value::String("billing_queue".to_string()),
    );
    object.insert(
        "billing_reservation_key".to_string(),
        Value::String(reservation_key.to_string()),
    );
    audit_log.other = other.to_string();
    Ok(())
}

fn finalization_error(message: impl Into<String>) -> worker::Error {
    worker::Error::RustError(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn audit(quota: i64) -> AuditLogEvent {
        AuditLogEvent {
            user_id: 7,
            created_at: 1_800_000_000,
            log_type: 2,
            content: "queued relay settlement".to_string(),
            username: "private-username".to_string(),
            token_name: "private-token-name".to_string(),
            model_name: "gpt-test".to_string(),
            quota,
            prompt_tokens: 10,
            completion_tokens: 5,
            use_time: 2,
            is_stream: 1,
            channel_id: 9,
            token_id: 11,
            group: "default".to_string(),
            ip: "203.0.113.9".to_string(),
            request_id: "raw-request-id".to_string(),
            upstream_request_id: "raw-upstream-request-id".to_string(),
            other: serde_json::json!({"billing_pending": false}).to_string(),
        }
    }

    #[test]
    fn settlement_event_is_bounded_and_contains_only_frozen_decision_metadata() {
        let event = RelayBillingFinalizationEvent::settlement(
            "relayreserve-test",
            "sha256:expr",
            9,
            "default",
            30,
            "usage_settlement",
            1_800_000_000,
            audit(30),
        )
        .expect("event");
        event.validate().expect("valid event");
        let serialized = serde_json::to_string(&event).expect("serialize");
        assert!(serialized.contains("relay-finalization-v1:relayreserve-test"));
        assert!(!serialized.contains("expr_string"));
        assert!(!serialized.contains("request_body"));
        assert!(!serialized.contains("authorization"));
        assert!(!serialized.contains("203.0.113.9"));
        assert!(!serialized.contains("raw-request-id"));
        assert!(!serialized.contains("raw-upstream-request-id"));
        assert!(!serialized.contains("private-username"));
        assert!(!serialized.contains("private-token-name"));
    }

    #[test]
    fn refund_event_requires_a_zero_quota_audit() {
        let error = RelayBillingFinalizationEvent::refund(
            "relayreserve-test",
            "sha256:expr",
            9,
            "default",
            "missing_stream_usage",
            true,
            1_800_000_000,
            audit(1),
        )
        .expect_err("nonzero refund audit must fail");
        assert!(error.to_string().contains("refund audit quota"));
    }

    #[test]
    fn event_identity_is_derived_from_the_reservation() {
        let mut event = RelayBillingFinalizationEvent::settlement(
            "relayreserve-test",
            "sha256:expr",
            9,
            "default",
            30,
            "usage_settlement",
            1_800_000_000,
            audit(30),
        )
        .expect("event");
        event.event_id = "forged".to_string();
        assert!(event.validate().is_err());
    }

    #[test]
    fn audit_projection_rejects_non_boolean_stream_markers() {
        let mut event = RelayBillingFinalizationEvent::settlement(
            "relayreserve-test",
            "sha256:expr",
            9,
            "default",
            30,
            "usage_settlement",
            1_800_000_000,
            audit(30),
        )
        .expect("event");
        event.audit_log.is_stream = 2;
        assert!(event.validate().is_err());
    }

    #[test]
    fn queue_names_are_environment_explicit_and_fail_closed() {
        assert_eq!(
            worker_queue_kind("cinatoken-rust-log-events-staging"),
            Some(WorkerQueueKind::AuditLog)
        );
        assert_eq!(
            worker_queue_kind("cinatoken-rust-billing-finalization"),
            Some(WorkerQueueKind::RelayBillingFinalization)
        );
        assert_eq!(worker_queue_kind("billing-events"), None);
    }
}
