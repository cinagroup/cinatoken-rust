//! Authenticated, read-only operator views for Container R2 inventory.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use worker::{Env, Request, Response, Result as WorkerResult};

use crate::admin::{
    envelope_error_response, envelope_ok_response, require_admin_auth, require_root_auth,
};
use crate::container_r2_inventory::{
    container_r2_inventory_compiled, container_r2_inventory_runtime_config,
};
use crate::d1_repositories::{
    list_relay_container_r2_inventory_findings, relay_container_r2_inventory_cursors,
    relay_container_r2_inventory_finding_counts, relay_container_r2_inventory_schema_ready,
    RelayContainerR2InventoryCursor, RelayContainerR2InventoryFindingCount,
    RelayContainerR2InventoryFindingRow, RELAY_CONTAINER_R2_INVENTORY_CLASSES,
    RELAY_CONTAINER_R2_INVENTORY_LANES, RELAY_CONTAINER_R2_INVENTORY_STATUSES,
};

const CONTRACT_VERSION: u32 = 1;
const DEFAULT_LIST_LIMIT: i64 = 20;
const MAX_LIST_LIMIT: i64 = 50;
const CANDIDATE_MIN_COMPLETED_GENERATIONS: u32 = 2;
const CURSOR_REFERENCE_DOMAIN: &[u8] = b"cinatoken:container-r2-inventory-cursor:v1\0";
const OBJECT_REFERENCE_DOMAIN: &[u8] = b"cinatoken:container-r2-inventory-object:v1\0";
const OPERATION_REFERENCE_DOMAIN: &[u8] = b"cinatoken:container-r2-inventory-operation:v1\0";

#[derive(Debug, Serialize, PartialEq, Eq)]
struct InventoryStatusResponse {
    contract_version: u32,
    inventory_compiled: bool,
    schema_ready: bool,
    runtime_configured: bool,
    runtime_valid: bool,
    runtime_enabled: bool,
    scan_limit: u32,
    grace_seconds: i64,
    candidate_min_completed_generations: u32,
    r2_read_only: bool,
    apply_compiled: bool,
    delete_compiled: bool,
    lanes: Vec<InventoryLaneStatus>,
    findings: Vec<InventoryFindingCount>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct InventoryLaneStatus {
    lane: String,
    prefix: String,
    scan_generation: i64,
    round_active: bool,
    cursor_present: bool,
    cursor_reference: Option<String>,
    run_generation: i64,
    owner_present: bool,
    run_active: bool,
    run_lease_expires_at: Option<i64>,
    round_started_at: Option<i64>,
    round_completed_at: Option<i64>,
    last_started_at: Option<i64>,
    last_completed_at: Option<i64>,
    last_success_at: Option<i64>,
    last_error_code: Option<String>,
    last_page_scanned: i64,
    last_page_deferred: i64,
    last_page_referenced: i64,
    last_page_anomalies: i64,
    last_page_resolved: i64,
    total_scanned: i64,
    total_deferred: i64,
    total_referenced: i64,
    total_anomalies: i64,
    total_resolved: i64,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct InventoryFindingCount {
    status: String,
    class: String,
    count: i64,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct InventoryListResponse {
    contract_version: u32,
    count: usize,
    next_cursor: Option<String>,
    status_filter: Option<String>,
    class_filter: Option<String>,
    lane_filter: Option<String>,
    records: Vec<InventoryFindingRecord>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct InventoryFindingRecord {
    finding_reference: String,
    object_reference: String,
    operation_reference: Option<String>,
    lane: String,
    owner_generation: Option<i64>,
    object_size: i64,
    uploaded_at: i64,
    status: String,
    class: String,
    first_scan_generation: i64,
    last_scan_generation: i64,
    distinct_scan_generations: i64,
    observation_count: i64,
    first_observed_at: i64,
    last_observed_at: i64,
    candidate_at: Option<i64>,
    resolved_at: Option<i64>,
    updated_at: i64,
    apply_compiled: bool,
    delete_compiled: bool,
}

#[derive(Debug, PartialEq, Eq)]
struct InventoryListQuery {
    before_id: i64,
    status: String,
    classification: String,
    lane_name: String,
    limit: i64,
}

pub async fn status(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return no_store(response);
    }
    let runtime = container_r2_inventory_runtime_config(&env);
    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(err) => {
            worker::console_error!("container R2 inventory status: D1 unavailable: {err}");
            return no_store(envelope_error_response(
                503,
                "Container R2 inventory status is unavailable",
            ));
        }
    };
    let schema_ready = match relay_container_r2_inventory_schema_ready(&db).await {
        Ok(ready) => ready,
        Err(err) => {
            worker::console_error!("container R2 inventory status schema probe failed: {err}");
            return no_store(envelope_error_response(
                503,
                "Container R2 inventory status is unavailable",
            ));
        }
    };
    if !schema_ready {
        return no_store(envelope_ok_response(&InventoryStatusResponse {
            contract_version: CONTRACT_VERSION,
            inventory_compiled: container_r2_inventory_compiled(),
            schema_ready: false,
            runtime_configured: runtime.configured,
            runtime_valid: runtime.valid,
            runtime_enabled: runtime.enabled,
            scan_limit: runtime.scan_limit,
            grace_seconds: runtime.grace_seconds,
            candidate_min_completed_generations: CANDIDATE_MIN_COMPLETED_GENERATIONS,
            r2_read_only: true,
            apply_compiled: false,
            delete_compiled: false,
            lanes: Vec::new(),
            findings: Vec::new(),
        })?);
    }
    let cursors = match relay_container_r2_inventory_cursors(&db).await {
        Ok(cursors) => cursors,
        Err(err) => {
            worker::console_error!("container R2 inventory status cursor read failed: {err}");
            return no_store(envelope_error_response(
                503,
                "Container R2 inventory status is unavailable",
            ));
        }
    };
    let counts = match relay_container_r2_inventory_finding_counts(&db).await {
        Ok(counts) => counts,
        Err(err) => {
            worker::console_error!("container R2 inventory status count read failed: {err}");
            return no_store(envelope_error_response(
                503,
                "Container R2 inventory status is unavailable",
            ));
        }
    };
    if !status_contract_valid(&cursors, &counts) {
        worker::console_error!("container R2 inventory stored status contract is invalid");
        return no_store(envelope_error_response(
            503,
            "Container R2 inventory status is unavailable",
        ));
    }
    let now = crate::admin::unix_timestamp();
    no_store(envelope_ok_response(&InventoryStatusResponse {
        contract_version: CONTRACT_VERSION,
        inventory_compiled: container_r2_inventory_compiled(),
        schema_ready: true,
        runtime_configured: runtime.configured,
        runtime_valid: runtime.valid,
        runtime_enabled: runtime.enabled,
        scan_limit: runtime.scan_limit,
        grace_seconds: runtime.grace_seconds,
        candidate_min_completed_generations: CANDIDATE_MIN_COMPLETED_GENERATIONS,
        r2_read_only: true,
        apply_compiled: false,
        delete_compiled: false,
        lanes: cursors
            .into_iter()
            .map(|cursor| inventory_lane_status(cursor, now))
            .collect(),
        findings: counts
            .into_iter()
            .map(|row| InventoryFindingCount {
                status: row.status,
                class: row.classification,
                count: row.finding_count,
            })
            .collect(),
    })?)
}

pub async fn list(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_root_auth(&req, &env).await? {
        return no_store(response);
    }
    let query = match inventory_list_query(&req) {
        Ok(query) => query,
        Err(message) => return no_store(envelope_error_response(400, message)),
    };
    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(err) => {
            worker::console_error!("container R2 inventory list: D1 unavailable: {err}");
            return no_store(envelope_error_response(
                503,
                "Container R2 inventory findings are unavailable",
            ));
        }
    };
    match relay_container_r2_inventory_schema_ready(&db).await {
        Ok(true) => {}
        Ok(false) => {
            return no_store(envelope_error_response(
                503,
                "Container R2 inventory schema is not ready",
            ));
        }
        Err(err) => {
            worker::console_error!("container R2 inventory list schema probe failed: {err}");
            return no_store(envelope_error_response(
                503,
                "Container R2 inventory findings are unavailable",
            ));
        }
    }
    let mut rows = match list_relay_container_r2_inventory_findings(
        &db,
        query.before_id,
        &query.status,
        &query.classification,
        &query.lane_name,
        query.limit.saturating_add(1),
    )
    .await
    {
        Ok(rows) => rows,
        Err(err) => {
            worker::console_error!("container R2 inventory finding list failed: {err}");
            return no_store(envelope_error_response(
                503,
                "Container R2 inventory findings are unavailable",
            ));
        }
    };
    if rows.iter().any(|row| !finding_contract_valid(row)) {
        worker::console_error!("container R2 inventory finding contract is invalid");
        return no_store(envelope_error_response(
            503,
            "Container R2 inventory findings are unavailable",
        ));
    }
    let has_more = rows.len() > query.limit as usize;
    rows.truncate(query.limit as usize);
    let next_cursor = if has_more {
        rows.last().map(|row| row.finding_id.to_string())
    } else {
        None
    };
    let records = rows
        .into_iter()
        .map(inventory_finding_record)
        .collect::<Vec<_>>();
    no_store(envelope_ok_response(&InventoryListResponse {
        contract_version: CONTRACT_VERSION,
        count: records.len(),
        next_cursor,
        status_filter: (!query.status.is_empty()).then_some(query.status),
        class_filter: (!query.classification.is_empty()).then_some(query.classification),
        lane_filter: (!query.lane_name.is_empty()).then_some(query.lane_name),
        records,
    })?)
}

fn inventory_lane_status(cursor: RelayContainerR2InventoryCursor, now: i64) -> InventoryLaneStatus {
    let owner_present = !cursor.run_owner.is_empty();
    InventoryLaneStatus {
        lane: cursor.lane_name.clone(),
        prefix: cursor.object_prefix,
        scan_generation: cursor.scan_generation,
        round_active: cursor.round_active == 1,
        cursor_present: !cursor.r2_cursor.is_empty(),
        cursor_reference: (!cursor.r2_cursor.is_empty()).then(|| {
            reference_parts(
                CURSOR_REFERENCE_DOMAIN,
                &[cursor.lane_name.as_bytes(), cursor.r2_cursor.as_bytes()],
            )
        }),
        run_generation: cursor.run_generation,
        owner_present,
        run_active: owner_present && cursor.run_lease_expires_at > now,
        run_lease_expires_at: owner_present.then_some(cursor.run_lease_expires_at),
        round_started_at: positive(cursor.round_started_at),
        round_completed_at: positive(cursor.round_completed_at),
        last_started_at: positive(cursor.last_started_at),
        last_completed_at: positive(cursor.last_completed_at),
        last_success_at: positive(cursor.last_success_at),
        last_error_code: optional_text(&cursor.last_error_code),
        last_page_scanned: cursor.last_page_scanned,
        last_page_deferred: cursor.last_page_deferred,
        last_page_referenced: cursor.last_page_referenced,
        last_page_anomalies: cursor.last_page_anomalies,
        last_page_resolved: cursor.last_page_resolved,
        total_scanned: cursor.total_scanned,
        total_deferred: cursor.total_deferred,
        total_referenced: cursor.total_referenced,
        total_anomalies: cursor.total_anomalies,
        total_resolved: cursor.total_resolved,
    }
}

fn inventory_finding_record(row: RelayContainerR2InventoryFindingRow) -> InventoryFindingRecord {
    InventoryFindingRecord {
        finding_reference: reference_parts(
            OBJECT_REFERENCE_DOMAIN,
            &[b"finding", row.finding_id.to_string().as_bytes()],
        ),
        object_reference: reference_parts(
            OBJECT_REFERENCE_DOMAIN,
            &[row.object_key.as_bytes(), row.object_version.as_bytes()],
        ),
        operation_reference: (!row.operation_id.is_empty())
            .then(|| reference_parts(OPERATION_REFERENCE_DOMAIN, &[row.operation_id.as_bytes()])),
        lane: row.lane_name,
        owner_generation: (row.owner_generation > 0).then_some(row.owner_generation),
        object_size: row.object_size,
        uploaded_at: row.uploaded_at,
        status: row.status,
        class: row.classification,
        first_scan_generation: row.first_scan_generation,
        last_scan_generation: row.last_scan_generation,
        distinct_scan_generations: row.distinct_scan_generations,
        observation_count: row.observation_count,
        first_observed_at: row.first_observed_at,
        last_observed_at: row.last_observed_at,
        candidate_at: positive(row.candidate_at),
        resolved_at: positive(row.resolved_at),
        updated_at: row.updated_at,
        apply_compiled: false,
        delete_compiled: false,
    }
}

fn status_contract_valid(
    cursors: &[RelayContainerR2InventoryCursor],
    counts: &[RelayContainerR2InventoryFindingCount],
) -> bool {
    if cursors.len() != 3 {
        return false;
    }
    let mut lanes = HashSet::new();
    cursors.iter().all(|cursor| {
        lanes.insert(cursor.lane_name.as_str())
            && RELAY_CONTAINER_R2_INVENTORY_LANES.contains(&cursor.lane_name.as_str())
            && expected_prefix(&cursor.lane_name) == Some(cursor.object_prefix.as_str())
            && cursor.round_active >= 0
            && cursor.round_active <= 1
            && cursor.scan_generation >= 0
            && cursor.run_generation >= 0
            && (cursor.run_owner.is_empty() || valid_lower_hex(&cursor.run_owner, 32))
            && cursor.last_page_scanned
                == cursor.last_page_deferred
                    + cursor.last_page_referenced
                    + cursor.last_page_anomalies
            && cursor.last_page_resolved <= cursor.last_page_referenced
            && cursor.total_scanned
                == cursor.total_deferred + cursor.total_referenced + cursor.total_anomalies
            && cursor.total_resolved <= cursor.total_referenced
    }) && counts.iter().all(|row| {
        RELAY_CONTAINER_R2_INVENTORY_STATUSES.contains(&row.status.as_str())
            && RELAY_CONTAINER_R2_INVENTORY_CLASSES.contains(&row.classification.as_str())
            && row.finding_count > 0
    })
}

fn finding_contract_valid(row: &RelayContainerR2InventoryFindingRow) -> bool {
    row.finding_id > 0
        && RELAY_CONTAINER_R2_INVENTORY_LANES.contains(&row.lane_name.as_str())
        && !row.object_key.is_empty()
        && row.object_key.len() <= 1_024
        && !row.object_version.is_empty()
        && row.object_version.len() <= 256
        && RELAY_CONTAINER_R2_INVENTORY_STATUSES.contains(&row.status.as_str())
        && RELAY_CONTAINER_R2_INVENTORY_CLASSES.contains(&row.classification.as_str())
        && row.first_scan_generation > 0
        && row.last_scan_generation >= row.first_scan_generation
        && row.distinct_scan_generations > 0
        && row.distinct_scan_generations <= row.observation_count
        && row.first_observed_at > 0
        && row.last_observed_at >= row.first_observed_at
        && row.updated_at >= row.last_observed_at
        && ((row.classification == "invalid_contract"
            && row.operation_id.is_empty()
            && row.owner_generation == 0
            && row.object_sha256.is_empty())
            || (row.classification != "invalid_contract"
                && !row.operation_id.is_empty()
                && row.owner_generation > 0
                && valid_lower_hex(&row.object_sha256, 64)))
}

fn inventory_list_query(req: &Request) -> Result<InventoryListQuery, &'static str> {
    let url = req
        .url()
        .map_err(|_| "Invalid Container R2 inventory list URL")?;
    let mut query = InventoryListQuery {
        before_id: 0,
        status: String::new(),
        classification: String::new(),
        lane_name: String::new(),
        limit: DEFAULT_LIST_LIMIT,
    };
    let mut seen = HashSet::new();
    for (key, value) in url.query_pairs() {
        if !seen.insert(key.to_string()) {
            return Err("Duplicate Container R2 inventory list query");
        }
        match key.as_ref() {
            "cursor" => {
                query.before_id = parse_cursor(value.as_ref())
                    .ok_or("Invalid Container R2 inventory list cursor")?;
            }
            "status" => {
                if !RELAY_CONTAINER_R2_INVENTORY_STATUSES.contains(&value.as_ref()) {
                    return Err("Invalid Container R2 inventory status filter");
                }
                query.status = value.into_owned();
            }
            "class" => {
                if !RELAY_CONTAINER_R2_INVENTORY_CLASSES.contains(&value.as_ref()) {
                    return Err("Invalid Container R2 inventory class filter");
                }
                query.classification = value.into_owned();
            }
            "lane" => {
                if !RELAY_CONTAINER_R2_INVENTORY_LANES.contains(&value.as_ref()) {
                    return Err("Invalid Container R2 inventory lane filter");
                }
                query.lane_name = value.into_owned();
            }
            "limit" => {
                query.limit = value
                    .parse::<i64>()
                    .ok()
                    .filter(|value| (1..=MAX_LIST_LIMIT).contains(value))
                    .ok_or("Invalid Container R2 inventory list limit")?;
            }
            _ => return Err("Unsupported Container R2 inventory list query"),
        }
    }
    Ok(query)
}

fn expected_prefix(lane_name: &str) -> Option<&'static str> {
    match lane_name {
        "input" => Some("container-inputs/v1/"),
        "result" => Some("container-results/v1/"),
        "client_response" => Some("container-client-responses/v1/"),
        _ => None,
    }
}

fn parse_cursor(value: &str) -> Option<i64> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let parsed = value.parse::<i64>().ok().filter(|value| *value > 0)?;
    (value == parsed.to_string()).then_some(parsed)
}

fn reference_parts(domain: &[u8], parts: &[&[u8]]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    for part in parts {
        hasher.update((part.len() as u32).to_be_bytes());
        hasher.update(part);
    }
    format!("{:x}", hasher.finalize())
}

fn valid_lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
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

    fn test_finding() -> RelayContainerR2InventoryFindingRow {
        RelayContainerR2InventoryFindingRow {
            finding_id: 7,
            lane_name: "input".to_string(),
            object_key: format!("container-inputs/v1/raw-operation/2/{}", "a".repeat(64)),
            object_version: "raw-r2-version".to_string(),
            operation_id: "raw-operation".to_string(),
            owner_generation: 2,
            object_sha256: "a".repeat(64),
            object_size: 42,
            uploaded_at: 100,
            status: "candidate".to_string(),
            classification: "operation_missing".to_string(),
            first_scan_generation: 1,
            last_scan_generation: 2,
            distinct_scan_generations: 2,
            observation_count: 2,
            first_observed_at: 200,
            last_observed_at: 300,
            candidate_at: 310,
            resolved_at: 0,
            created_at: 200,
            updated_at: 310,
        }
    }

    #[test]
    fn finding_projection_redacts_every_raw_r2_identity() {
        let row = test_finding();
        assert!(finding_contract_valid(&row));
        let raw_key = row.object_key.clone();
        let raw_version = row.object_version.clone();
        let raw_operation = row.operation_id.clone();
        let raw_sha = row.object_sha256.clone();
        let record = inventory_finding_record(row);
        let json = serde_json::to_string(&record).unwrap();
        assert!(!json.contains(&raw_key));
        assert!(!json.contains(&raw_version));
        assert!(!json.contains(&raw_operation));
        assert!(!json.contains(&raw_sha));
        assert_eq!(record.object_reference.len(), 64);
        assert_eq!(record.operation_reference.unwrap().len(), 64);
        assert!(!record.apply_compiled);
        assert!(!record.delete_compiled);
    }

    #[test]
    fn operator_queries_are_strict_and_source_is_read_only() {
        assert_eq!(parse_cursor("7"), Some(7));
        for invalid in ["", "0", "07", "-1", "+1", " 1"] {
            assert_eq!(parse_cursor(invalid), None);
        }
        let source = include_str!("container_r2_inventory_admin.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        assert!(source.contains("require_admin_auth(&req, &env)"));
        assert!(source.contains("require_root_auth(&req, &env)"));
        assert!(source.contains("Cache-Control\", \"no-store"));
        assert!(!source.contains("INSERT INTO"));
        assert!(!source.contains("UPDATE relay_container"));
        assert!(!source.contains("DELETE FROM"));
        assert!(!source.contains("/apply"));
        assert!(!source.contains("/delete"));

        let router = include_str!("lib.rs");
        assert!(router.contains("/api/platform/container/r2-inventory/status"));
        assert!(router.contains("/api/platform/container/r2-inventory/findings"));
        assert!(!router.contains("/api/platform/container/r2-inventory/apply"));
        assert!(!router.contains("/api/platform/container/r2-inventory/delete"));
    }
}
