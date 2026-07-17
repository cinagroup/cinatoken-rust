//! Redacted operator status for the default-off Container terminal outbox.

use serde::Serialize;
use worker::{Env, Request, Response, Result as WorkerResult};

use crate::admin::{envelope_error_response, envelope_ok_response, require_admin_auth};
use crate::container_terminal_outbox::{
    container_terminal_outbox_compiled, container_terminal_outbox_runtime_config,
};
use crate::d1_repositories::{
    relay_container_terminal_outbox_runtime_snapshot, relay_container_terminal_outbox_schema_ready,
    RelayContainerTerminalOutboxRuntimeSnapshot,
};

const CONTRACT_VERSION: u32 = 1;

#[derive(Debug, Serialize, PartialEq, Eq)]
struct TerminalOutboxStatusResponse {
    contract_version: u32,
    delivery_compiled: bool,
    configured: bool,
    configuration_valid: bool,
    requested: bool,
    staging_verified: bool,
    runtime_enabled: bool,
    schema_ready: bool,
    scan_limit: u32,
    counts: Option<TerminalOutboxCounts>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct TerminalOutboxCounts {
    total: i64,
    pending: i64,
    leased: i64,
    delivered: i64,
    dead_letter: i64,
    due: i64,
    expired_leases: i64,
    oldest_due_at: Option<i64>,
    latest_updated_at: Option<i64>,
}

pub async fn status(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return no_store(response);
    }
    let config = container_terminal_outbox_runtime_config(&env);
    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(err) => {
            worker::console_error!("container terminal outbox status: D1 unavailable: {err}");
            return no_store(envelope_error_response(
                503,
                "Container terminal outbox status is unavailable",
            ));
        }
    };
    let schema_ready = match relay_container_terminal_outbox_schema_ready(&db).await {
        Ok(ready) => ready,
        Err(err) => {
            worker::console_error!("container terminal outbox schema probe failed: {err}");
            return no_store(envelope_error_response(
                503,
                "Container terminal outbox status is unavailable",
            ));
        }
    };
    let counts = if schema_ready {
        let now = i64::try_from(worker::Date::now().as_millis() / 1_000).unwrap_or(i64::MAX);
        match relay_container_terminal_outbox_runtime_snapshot(&db, now).await {
            Ok(snapshot) => Some(terminal_outbox_counts(snapshot)),
            Err(err) => {
                worker::console_error!("container terminal outbox status read failed: {err}");
                return no_store(envelope_error_response(
                    503,
                    "Container terminal outbox status is unavailable",
                ));
            }
        }
    } else {
        None
    };
    no_store(envelope_ok_response(&TerminalOutboxStatusResponse {
        contract_version: CONTRACT_VERSION,
        delivery_compiled: container_terminal_outbox_compiled(),
        configured: config.configured,
        configuration_valid: config.valid,
        requested: config.requested,
        staging_verified: config.staging_verified,
        runtime_enabled: config.enabled,
        schema_ready,
        scan_limit: config.scan_limit,
        counts,
    })?)
}

fn terminal_outbox_counts(
    snapshot: RelayContainerTerminalOutboxRuntimeSnapshot,
) -> TerminalOutboxCounts {
    TerminalOutboxCounts {
        total: snapshot.total_count,
        pending: snapshot.pending_count,
        leased: snapshot.leased_count,
        delivered: snapshot.delivered_count,
        dead_letter: snapshot.dead_letter_count,
        due: snapshot.due_count,
        expired_leases: snapshot.expired_lease_count,
        oldest_due_at: (snapshot.oldest_due_at > 0).then_some(snapshot.oldest_due_at),
        latest_updated_at: (snapshot.latest_updated_at > 0).then_some(snapshot.latest_updated_at),
    }
}

fn no_store(mut response: Response) -> WorkerResult<Response> {
    response.headers_mut().set("Cache-Control", "no-store")?;
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_counts_are_redacted_and_normalize_zero_timestamps() {
        let counts = terminal_outbox_counts(RelayContainerTerminalOutboxRuntimeSnapshot {
            total_count: 9,
            pending_count: 2,
            leased_count: 1,
            delivered_count: 5,
            dead_letter_count: 1,
            due_count: 2,
            expired_lease_count: 1,
            oldest_due_at: 0,
            latest_updated_at: 1_800_000_000,
        });
        assert_eq!(counts.total, 9);
        assert_eq!(counts.dead_letter, 1);
        assert_eq!(counts.oldest_due_at, None);
        assert_eq!(counts.latest_updated_at, Some(1_800_000_000));
        let json = serde_json::to_value(counts).unwrap();
        assert!(json.get("billing_event_id").is_none());
        assert!(json.get("operation_id").is_none());
    }
}
