//! Read-only operator surface for the default-off Container reconciliation observer.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use worker::{Env, Request, Response, Result as WorkerResult};

use crate::admin::{
    envelope_error_response, envelope_ok_response, require_admin_auth, require_root_auth,
};
use crate::container_reconciliation::{
    container_reconciliation_observer_compiled, container_reconciliation_scan_limit,
};
use crate::container_scheduler::container_operation_runtime_status;
use crate::d1_repositories::{
    list_relay_container_reconciliation_observations, relay_container_reconciliation_class_counts,
    relay_container_reconciliation_runtime_snapshot, relay_container_reconciliation_schema_ready,
    RelayContainerReconciliationClassCount, RelayContainerReconciliationObservationRow,
    RelayContainerReconciliationRuntimeSnapshot, RELAY_CONTAINER_RECONCILIATION_CLASSES,
    RELAY_CONTAINER_RECONCILIATION_STATUSES,
};

const CONTRACT_VERSION: u32 = 1;
const DEFAULT_LIST_LIMIT: i64 = 20;
const MAX_LIST_LIMIT: i64 = 50;
const OPERATION_REFERENCE_DOMAIN: &[u8] =
    b"cinatoken:container-reconciliation-operation-reference:v1\0";
const RECONCILIATION_REFERENCE_DOMAIN: &[u8] =
    b"cinatoken:container-reconciliation-identity-reference:v1\0";
const CURSOR_REFERENCE_DOMAIN: &[u8] = b"cinatoken:container-reconciliation-cursor-reference:v1\0";

#[derive(Debug, Serialize, PartialEq, Eq)]
struct ReconciliationStatusResponse {
    contract_version: u32,
    observer_compiled: bool,
    schema_ready: bool,
    runtime_enabled: bool,
    scan_limit: i64,
    scan: Option<ReconciliationScanStatus>,
    run: Option<ReconciliationRunStatus>,
    observations: Option<ReconciliationObservationCounts>,
    classes: Vec<ReconciliationClassCount>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct ReconciliationScanStatus {
    generation: i64,
    in_progress: bool,
    cursor_created_at: Option<i64>,
    cursor_reference: Option<String>,
    high_watermark_created_at: Option<i64>,
    high_watermark_reference: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct ReconciliationRunStatus {
    generation: i64,
    owner_present: bool,
    active: bool,
    lease_expires_at: Option<i64>,
    last_started_at: Option<i64>,
    last_completed_at: Option<i64>,
    last_success_at: Option<i64>,
    last_error_code: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct ReconciliationObservationCounts {
    total: i64,
    pending: i64,
    leased: i64,
    retry: i64,
    converged: i64,
    dead_letter: i64,
    due: i64,
    expired_leases: i64,
    oldest_due_at: Option<i64>,
    latest_observed_at: Option<i64>,
    latest_updated_at: Option<i64>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct ReconciliationClassCount {
    class: String,
    count: i64,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct ReconciliationListResponse {
    contract_version: u32,
    count: usize,
    next_cursor: Option<String>,
    status_filter: Option<String>,
    class_filter: Option<String>,
    records: Vec<ReconciliationRecord>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct ReconciliationRecord {
    operation_reference: String,
    reconciliation_reference: Option<String>,
    operation_created_at: i64,
    owner_generation: i64,
    status: String,
    class: Option<String>,
    last_error_code: Option<String>,
    claim_generation: i64,
    attempt_count: i64,
    consecutive_failures: i64,
    due: bool,
    lease_active: bool,
    lease_expired: bool,
    available_at: Option<i64>,
    lease_expires_at: Option<i64>,
    first_observed_at: Option<i64>,
    last_attempt_at: Option<i64>,
    last_observed_at: Option<i64>,
    recovery_deadline_at: i64,
    converged_at: Option<i64>,
    dead_lettered_at: Option<i64>,
    dead_letter_reason: Option<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, PartialEq, Eq)]
struct ReconciliationListQuery {
    before_sequence: i64,
    status: String,
    class: String,
    limit: i64,
}

pub async fn status(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return no_store(response);
    }
    let runtime_enabled = container_operation_runtime_status(&env).operation_reconciliation_enabled;
    let scan_limit = container_reconciliation_scan_limit(&env);
    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(err) => {
            worker::console_error!("container reconciliation status: D1 unavailable: {err}");
            return no_store(envelope_error_response(
                503,
                "Container reconciliation status is unavailable",
            ));
        }
    };
    let schema_ready = match relay_container_reconciliation_schema_ready(&db).await {
        Ok(ready) => ready,
        Err(err) => {
            worker::console_error!("container reconciliation status schema probe failed: {err}");
            return no_store(envelope_error_response(
                503,
                "Container reconciliation status is unavailable",
            ));
        }
    };
    if !schema_ready {
        return no_store(envelope_ok_response(&ReconciliationStatusResponse {
            contract_version: CONTRACT_VERSION,
            observer_compiled: container_reconciliation_observer_compiled(),
            schema_ready: false,
            runtime_enabled,
            scan_limit,
            scan: None,
            run: None,
            observations: None,
            classes: Vec::new(),
        })?);
    }
    let now = crate::admin::unix_timestamp();
    let snapshot = match relay_container_reconciliation_runtime_snapshot(&db, now).await {
        Ok(snapshot) => snapshot,
        Err(err) => {
            worker::console_error!("container reconciliation status snapshot failed: {err}");
            return no_store(envelope_error_response(
                503,
                "Container reconciliation status is unavailable",
            ));
        }
    };
    let classes = match relay_container_reconciliation_class_counts(&db).await {
        Ok(classes) => classes,
        Err(err) => {
            worker::console_error!("container reconciliation class summary failed: {err}");
            return no_store(envelope_error_response(
                503,
                "Container reconciliation status is unavailable",
            ));
        }
    };
    if !status_contract_valid(&snapshot, &classes) {
        worker::console_error!("container reconciliation status contract is invalid");
        return no_store(envelope_error_response(
            503,
            "Container reconciliation status is unavailable",
        ));
    }
    no_store(envelope_ok_response(&status_response(
        runtime_enabled,
        scan_limit,
        now,
        &snapshot,
        classes,
    ))?)
}

pub async fn list(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_root_auth(&req, &env).await? {
        return no_store(response);
    }
    let query = match reconciliation_list_query(&req) {
        Ok(query) => query,
        Err(message) => return no_store(envelope_error_response(400, message)),
    };
    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(err) => {
            worker::console_error!("container reconciliation list: D1 unavailable: {err}");
            return no_store(envelope_error_response(
                503,
                "Container reconciliation observations are unavailable",
            ));
        }
    };
    match relay_container_reconciliation_schema_ready(&db).await {
        Ok(true) => {}
        Ok(false) => {
            return no_store(envelope_error_response(
                503,
                "Container reconciliation schema is not ready",
            ));
        }
        Err(err) => {
            worker::console_error!("container reconciliation list schema probe failed: {err}");
            return no_store(envelope_error_response(
                503,
                "Container reconciliation observations are unavailable",
            ));
        }
    }
    let mut rows = match list_relay_container_reconciliation_observations(
        &db,
        query.before_sequence,
        &query.status,
        &query.class,
        query.limit.saturating_add(1),
    )
    .await
    {
        Ok(rows) => rows,
        Err(err) => {
            worker::console_error!("container reconciliation observation list failed: {err}");
            return no_store(envelope_error_response(
                503,
                "Container reconciliation observations are unavailable",
            ));
        }
    };
    if rows.iter().any(|row| !observation_contract_valid(row)) {
        worker::console_error!("container reconciliation observation contract is invalid");
        return no_store(envelope_error_response(
            503,
            "Container reconciliation observations are unavailable",
        ));
    }
    let has_more = rows.len() > query.limit as usize;
    rows.truncate(query.limit as usize);
    let next_cursor = if has_more {
        rows.last().map(|row| row.observation_sequence.to_string())
    } else {
        None
    };
    let now = crate::admin::unix_timestamp();
    let records = rows
        .into_iter()
        .map(|row| reconciliation_record(row, now))
        .collect::<Vec<_>>();
    no_store(envelope_ok_response(&ReconciliationListResponse {
        contract_version: CONTRACT_VERSION,
        count: records.len(),
        next_cursor,
        status_filter: (!query.status.is_empty()).then_some(query.status),
        class_filter: (!query.class.is_empty()).then_some(query.class),
        records,
    })?)
}

fn status_response(
    runtime_enabled: bool,
    scan_limit: i64,
    now: i64,
    snapshot: &RelayContainerReconciliationRuntimeSnapshot,
    classes: Vec<RelayContainerReconciliationClassCount>,
) -> ReconciliationStatusResponse {
    let scan_in_progress = snapshot.round_high_created_at > 0
        && (snapshot.last_created_at < snapshot.round_high_created_at
            || (snapshot.last_created_at == snapshot.round_high_created_at
                && snapshot.last_reservation_key < snapshot.round_high_reservation_key));
    let owner_present = !snapshot.run_owner.is_empty();
    ReconciliationStatusResponse {
        contract_version: CONTRACT_VERSION,
        observer_compiled: container_reconciliation_observer_compiled(),
        schema_ready: true,
        runtime_enabled,
        scan_limit,
        scan: Some(ReconciliationScanStatus {
            generation: snapshot.scan_generation,
            in_progress: scan_in_progress,
            cursor_created_at: positive(snapshot.last_created_at),
            cursor_reference: cursor_reference(
                snapshot.last_created_at,
                &snapshot.last_reservation_key,
            ),
            high_watermark_created_at: positive(snapshot.round_high_created_at),
            high_watermark_reference: cursor_reference(
                snapshot.round_high_created_at,
                &snapshot.round_high_reservation_key,
            ),
        }),
        run: Some(ReconciliationRunStatus {
            generation: snapshot.run_generation,
            owner_present,
            active: owner_present && snapshot.run_lease_expires_at > now,
            lease_expires_at: owner_present.then_some(snapshot.run_lease_expires_at),
            last_started_at: positive(snapshot.last_started_at),
            last_completed_at: positive(snapshot.last_completed_at),
            last_success_at: positive(snapshot.last_success_at),
            last_error_code: optional_text(&snapshot.last_error_code),
        }),
        observations: Some(ReconciliationObservationCounts {
            total: snapshot.total_count,
            pending: snapshot.pending_count,
            leased: snapshot.leased_count,
            retry: snapshot.retry_count,
            converged: snapshot.converged_count,
            dead_letter: snapshot.dead_letter_count,
            due: snapshot.due_count,
            expired_leases: snapshot.expired_lease_count,
            oldest_due_at: positive(snapshot.oldest_due_at),
            latest_observed_at: positive(snapshot.latest_observed_at),
            latest_updated_at: positive(snapshot.latest_updated_at),
        }),
        classes: classes
            .into_iter()
            .map(|row| ReconciliationClassCount {
                class: row.last_class,
                count: row.observation_count,
            })
            .collect(),
    }
}

fn reconciliation_record(
    row: RelayContainerReconciliationObservationRow,
    now: i64,
) -> ReconciliationRecord {
    let due = matches!(row.status.as_str(), "pending" | "retry") && row.available_at <= now;
    let leased = row.status == "leased";
    ReconciliationRecord {
        operation_reference: reference(OPERATION_REFERENCE_DOMAIN, &row.operation_id),
        reconciliation_reference: (!row.reconciliation_id.is_empty())
            .then(|| reference(RECONCILIATION_REFERENCE_DOMAIN, &row.reconciliation_id)),
        operation_created_at: row.operation_created_at,
        owner_generation: row.owner_generation,
        status: row.status,
        class: optional_text(&row.last_class),
        last_error_code: optional_text(&row.last_error_code),
        claim_generation: row.claim_generation,
        attempt_count: row.attempt_count,
        consecutive_failures: row.consecutive_failures,
        due,
        lease_active: leased && row.claim_lease_expires_at > now,
        lease_expired: leased && row.claim_lease_expires_at <= now,
        available_at: positive(row.available_at),
        lease_expires_at: positive(row.claim_lease_expires_at),
        first_observed_at: positive(row.first_observed_at),
        last_attempt_at: positive(row.last_attempt_at),
        last_observed_at: positive(row.last_observed_at),
        recovery_deadline_at: row.recovery_deadline_at,
        converged_at: positive(row.converged_at),
        dead_lettered_at: positive(row.dead_lettered_at),
        dead_letter_reason: optional_text(&row.dead_letter_reason),
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

fn status_contract_valid(
    snapshot: &RelayContainerReconciliationRuntimeSnapshot,
    classes: &[RelayContainerReconciliationClassCount],
) -> bool {
    let state_total = snapshot
        .pending_count
        .saturating_add(snapshot.leased_count)
        .saturating_add(snapshot.retry_count)
        .saturating_add(snapshot.converged_count)
        .saturating_add(snapshot.dead_letter_count);
    let class_total = classes.iter().fold(0_i64, |total, row| {
        total.saturating_add(row.observation_count)
    });
    let cursor_valid = (snapshot.last_created_at == 0) == snapshot.last_reservation_key.is_empty()
        && (snapshot.round_high_created_at == 0) == snapshot.round_high_reservation_key.is_empty();
    let run_owner_valid = snapshot.run_owner.is_empty() || valid_lower_hex(&snapshot.run_owner, 32);
    snapshot.total_count >= 0
        && state_total == snapshot.total_count
        && class_total <= snapshot.total_count
        && snapshot.due_count >= 0
        && snapshot.due_count <= snapshot.pending_count.saturating_add(snapshot.retry_count)
        && snapshot.expired_lease_count >= 0
        && snapshot.expired_lease_count <= snapshot.leased_count
        && cursor_valid
        && run_owner_valid
        && classes.iter().all(|row| {
            RELAY_CONTAINER_RECONCILIATION_CLASSES.contains(&row.last_class.as_str())
                && row.observation_count > 0
        })
}

fn observation_contract_valid(row: &RelayContainerReconciliationObservationRow) -> bool {
    RELAY_CONTAINER_RECONCILIATION_STATUSES.contains(&row.status.as_str())
        && (row.last_class.is_empty()
            || RELAY_CONTAINER_RECONCILIATION_CLASSES.contains(&row.last_class.as_str()))
        && row.observation_sequence > 0
        && !row.operation_id.is_empty()
        && row.operation_created_at > 0
        && row.owner_generation > 0
        && (row.reconciliation_id.is_empty() || valid_lower_hex(&row.reconciliation_id, 64))
        && row.claim_generation == row.attempt_count
        && row.consecutive_failures <= row.attempt_count
        && row.recovery_deadline_at > row.created_at
}

fn valid_lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn reconciliation_list_query(req: &Request) -> Result<ReconciliationListQuery, &'static str> {
    let url = req
        .url()
        .map_err(|_| "Invalid Container reconciliation list URL")?;
    let mut query = ReconciliationListQuery {
        before_sequence: 0,
        status: String::new(),
        class: String::new(),
        limit: DEFAULT_LIST_LIMIT,
    };
    let mut seen = HashSet::new();
    for (key, value) in url.query_pairs() {
        if !seen.insert(key.to_string()) {
            return Err("Duplicate Container reconciliation list query");
        }
        match key.as_ref() {
            "cursor" => {
                query.before_sequence = parse_cursor(value.as_ref())
                    .ok_or("Invalid Container reconciliation list cursor")?;
            }
            "status" => {
                let value = value.trim();
                if !RELAY_CONTAINER_RECONCILIATION_STATUSES.contains(&value) {
                    return Err("Invalid Container reconciliation status filter");
                }
                query.status = value.to_string();
            }
            "class" => {
                let value = value.trim();
                if !RELAY_CONTAINER_RECONCILIATION_CLASSES.contains(&value) {
                    return Err("Invalid Container reconciliation class filter");
                }
                query.class = value.to_string();
            }
            "limit" => {
                query.limit = value
                    .parse::<i64>()
                    .ok()
                    .filter(|value| (1..=MAX_LIST_LIMIT).contains(value))
                    .ok_or("Invalid Container reconciliation list limit")?;
            }
            _ => return Err("Unsupported Container reconciliation list query"),
        }
    }
    Ok(query)
}

fn parse_cursor(value: &str) -> Option<i64> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse::<i64>().ok().filter(|value| *value > 0)
}

fn cursor_reference(created_at: i64, key: &str) -> Option<String> {
    if created_at <= 0 || key.is_empty() {
        return None;
    }
    let mut hasher = Sha256::new();
    hasher.update(CURSOR_REFERENCE_DOMAIN);
    hasher.update(created_at.to_be_bytes());
    hasher.update(key.as_bytes());
    Some(format!("{:x}", hasher.finalize()))
}

fn reference(domain: &[u8], value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    hasher.update(value.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn positive(value: i64) -> Option<i64> {
    (value > 0).then_some(value)
}

fn optional_text(value: &str) -> Option<String> {
    (!value.is_empty()).then(|| value.to_string())
}

fn no_store(mut response: Response) -> WorkerResult<Response> {
    response.headers_mut().set("Cache-Control", "no-store")?;
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_snapshot() -> RelayContainerReconciliationRuntimeSnapshot {
        RelayContainerReconciliationRuntimeSnapshot {
            last_created_at: 100,
            last_reservation_key: "raw-cursor-operation".to_string(),
            round_high_created_at: 200,
            round_high_reservation_key: "raw-high-operation".to_string(),
            scan_generation: 3,
            run_generation: 4,
            run_owner: "a".repeat(32),
            run_lease_expires_at: 400,
            last_started_at: 300,
            last_completed_at: 250,
            last_success_at: 250,
            last_error_code: String::new(),
            total_count: 5,
            pending_count: 1,
            leased_count: 1,
            retry_count: 1,
            converged_count: 1,
            dead_letter_count: 1,
            due_count: 2,
            expired_lease_count: 0,
            oldest_due_at: 120,
            latest_observed_at: 280,
            latest_updated_at: 300,
        }
    }

    fn test_row() -> RelayContainerReconciliationObservationRow {
        RelayContainerReconciliationObservationRow {
            observation_sequence: 9,
            operation_id: "raw-operation-id".to_string(),
            operation_created_at: 100,
            owner_generation: 2,
            reconciliation_id: "b".repeat(64),
            status: "retry".to_string(),
            claim_generation: 3,
            claim_lease_expires_at: 0,
            available_at: 250,
            attempt_count: 3,
            consecutive_failures: 1,
            first_observed_at: 150,
            last_attempt_at: 200,
            last_observed_at: 210,
            last_class: "store_unavailable".to_string(),
            last_error_code: "controller_status_unavailable".to_string(),
            recovery_deadline_at: 1_000,
            converged_at: 0,
            dead_lettered_at: 0,
            dead_letter_reason: String::new(),
            created_at: 140,
            updated_at: 210,
        }
    }

    #[test]
    fn status_projection_redacts_cursor_and_run_owners() {
        let snapshot = test_snapshot();
        let response = status_response(
            false,
            4,
            350,
            &snapshot,
            vec![RelayContainerReconciliationClassCount {
                last_class: "store_unavailable".to_string(),
                observation_count: 2,
            }],
        );
        let json = serde_json::to_string(&response).unwrap();
        assert!(!json.contains("raw-cursor-operation"));
        assert!(!json.contains("raw-high-operation"));
        assert!(!json.contains(&snapshot.run_owner));
        assert!(json.contains("cursor_reference"));
        assert!(json.contains("store_unavailable"));
        assert!(response.run.unwrap().active);
    }

    #[test]
    fn observation_projection_exposes_only_domain_scoped_references() {
        let row = test_row();
        let raw_operation = row.operation_id.clone();
        let raw_reconciliation = row.reconciliation_id.clone();
        let record = reconciliation_record(row, 200);
        let json = serde_json::to_string(&record).unwrap();
        assert!(!json.contains(&raw_operation));
        assert!(!json.contains(&raw_reconciliation));
        assert_eq!(record.operation_reference.len(), 64);
        assert_eq!(record.reconciliation_reference.unwrap().len(), 64);
        assert!(!record.due);
        assert_eq!(record.class.as_deref(), Some("store_unavailable"));
    }

    #[test]
    fn cursor_and_filter_contracts_are_strictly_bounded() {
        assert_eq!(parse_cursor("42"), Some(42));
        for invalid in ["", "0", "-1", "+1", " 1", "1.0", "9223372036854775808"] {
            assert_eq!(parse_cursor(invalid), None);
        }
        assert!(RELAY_CONTAINER_RECONCILIATION_STATUSES.contains(&"dead_letter"));
        assert!(RELAY_CONTAINER_RECONCILIATION_CLASSES.contains(&"terminal_conflict"));
        assert!(!RELAY_CONTAINER_RECONCILIATION_CLASSES.contains(&"unknown"));
        assert_eq!(DEFAULT_LIST_LIMIT, 20);
        assert_eq!(MAX_LIST_LIMIT, 50);
    }

    #[test]
    fn operator_surface_is_read_only_root_scoped_and_no_store() {
        let source = include_str!("container_reconciliation_admin.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        let router = include_str!("lib.rs");
        assert!(source.contains("require_admin_auth(&req, &env)"));
        assert!(source.contains("require_root_auth(&req, &env)"));
        assert!(source.contains("Cache-Control\", \"no-store"));
        assert!(!source.contains("require_secure_verification"));
        assert!(!source.contains("INSERT INTO"));
        assert!(!source.contains("UPDATE relay_container"));
        assert!(!source.contains("DELETE FROM"));
        assert!(router.contains("/api/platform/container/reconciliation/status"));
        assert!(router.contains("/api/platform/container/reconciliations"));
    }

    #[test]
    fn corrupted_observer_rows_fail_the_read_contract() {
        let snapshot = test_snapshot();
        let classes = vec![RelayContainerReconciliationClassCount {
            last_class: "store_unavailable".to_string(),
            observation_count: 2,
        }];
        assert!(status_contract_valid(&snapshot, &classes));

        let mut invalid_snapshot = snapshot;
        invalid_snapshot.dead_letter_count = 2;
        assert!(!status_contract_valid(&invalid_snapshot, &classes));

        let mut row = test_row();
        assert!(observation_contract_valid(&row));
        row.last_class = "unknown".to_string();
        assert!(!observation_contract_valid(&row));
    }
}
