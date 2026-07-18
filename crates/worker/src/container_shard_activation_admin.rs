//! Root-admin, read-only pagination for the immutable Container shard ledger.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use worker::{Env, Request, Response, Result as WorkerResult};

use crate::admin::{envelope_error_response, envelope_ok_response, require_root_auth};
use crate::d1_repositories::{
    list_relay_container_shard_activations, relay_container_shard_activation_schema_ready,
    relay_container_shard_activation_snapshot, RelayContainerShardActivationRow,
};

const CONTRACT_VERSION: u32 = 1;
const LEDGER_CONTRACT: &str = "cinatoken-relay-container-shard-activation-v1";
const DEFAULT_LIMIT: i64 = 16;
const MAX_LIMIT: i64 = 64;
const MAX_RING_GENERATION: i64 = 1_000_000;
const MAX_SHARD_COUNT: i64 = 1_024;
const DIGEST_DOMAIN: &[u8] = b"cinatoken:relay-container-shard-activation:v1\0";

#[derive(Debug, PartialEq, Eq)]
struct ActivationQuery {
    controller_version_id: String,
    ring_generation: i64,
    high_watermark: i64,
    after_activation_id: i64,
    limit: i64,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct ActivationPageResponse {
    contract_version: u32,
    ledger_contract: &'static str,
    controller_version_id: String,
    ring_generation: i64,
    high_watermark: i64,
    total_records: i64,
    count: usize,
    next_cursor: Option<String>,
    pagination_complete: bool,
    records: Vec<ActivationRecord>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct ActivationRecord {
    registry_event_sequence: i64,
    shard_count: i64,
    shard_index: i64,
    instance_name: String,
    shard_contract_version: i64,
    runtime_protocol_version: i64,
    runtime_contract_version: i64,
    runtime_build_id: String,
    activation_generation: i64,
    activation_probe_generation: i64,
    environment: String,
    container_status: String,
    readiness_result_code: String,
    process_ready: bool,
    runtime_execution_enabled: bool,
    controller_execution_enabled: bool,
    activation_digest_sha256: String,
    activated_at: i64,
}

pub async fn list(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_root_auth(&req, &env).await? {
        return no_store(response);
    }
    let query = match activation_query(&req) {
        Ok(query) => query,
        Err(message) => return no_store(envelope_error_response(400, message)),
    };
    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(err) => {
            worker::console_error!("Container shard activation list: D1 unavailable: {err}");
            return no_store(envelope_error_response(
                503,
                "Container shard activation ledger is unavailable",
            ));
        }
    };
    match relay_container_shard_activation_schema_ready(&db).await {
        Ok(true) => {}
        Ok(false) => {
            return no_store(envelope_error_response(
                503,
                "Container shard activation schema is not ready",
            ));
        }
        Err(err) => {
            worker::console_error!("Container shard activation schema probe failed: {err}");
            return no_store(envelope_error_response(
                503,
                "Container shard activation ledger is unavailable",
            ));
        }
    }
    let snapshot = match relay_container_shard_activation_snapshot(
        &db,
        &query.controller_version_id,
        query.ring_generation,
        query.high_watermark,
    )
    .await
    {
        Ok(snapshot) => snapshot,
        Err(err) => {
            worker::console_error!("Container shard activation snapshot failed: {err}");
            return no_store(envelope_error_response(
                503,
                "Container shard activation ledger is unavailable",
            ));
        }
    };
    if query.high_watermark > 0 && snapshot.high_watermark != query.high_watermark {
        return no_store(envelope_error_response(
            409,
            "Container shard activation high watermark is unavailable",
        ));
    }
    if query.after_activation_id > snapshot.high_watermark {
        return no_store(envelope_error_response(
            400,
            "Invalid Container shard activation cursor",
        ));
    }

    let mut rows = if snapshot.high_watermark == 0 {
        Vec::new()
    } else if query.after_activation_id == snapshot.high_watermark {
        return no_store(envelope_error_response(
            400,
            "Container shard activation cursor is already terminal",
        ));
    } else {
        match list_relay_container_shard_activations(
            &db,
            &query.controller_version_id,
            query.ring_generation,
            snapshot.high_watermark,
            query.after_activation_id,
            query.limit.saturating_add(1),
        )
        .await
        {
            Ok(rows) => rows,
            Err(err) => {
                worker::console_error!("Container shard activation page failed: {err}");
                return no_store(envelope_error_response(
                    503,
                    "Container shard activation ledger is unavailable",
                ));
            }
        }
    };
    if rows.iter().any(|row| {
        !activation_row_valid(
            row,
            &query.controller_version_id,
            query.ring_generation,
            snapshot.high_watermark,
        )
    }) {
        worker::console_error!("Container shard activation row contract is invalid");
        return no_store(envelope_error_response(
            503,
            "Container shard activation ledger is unavailable",
        ));
    }
    let has_more = rows.len() > query.limit as usize;
    rows.truncate(query.limit as usize);
    let next_cursor = has_more.then(|| {
        rows.last()
            .expect("non-empty over-limit page")
            .activation_id
            .to_string()
    });
    let records = rows.into_iter().map(activation_record).collect::<Vec<_>>();
    no_store(envelope_ok_response(&ActivationPageResponse {
        contract_version: CONTRACT_VERSION,
        ledger_contract: LEDGER_CONTRACT,
        controller_version_id: query.controller_version_id,
        ring_generation: query.ring_generation,
        high_watermark: snapshot.high_watermark,
        total_records: snapshot.record_count,
        count: records.len(),
        pagination_complete: next_cursor.is_none(),
        next_cursor,
        records,
    })?)
}

fn activation_query(req: &Request) -> Result<ActivationQuery, &'static str> {
    let url = req
        .url()
        .map_err(|_| "Invalid Container shard activation URL")?;
    activation_query_from_url(&url)
}

fn activation_query_from_url(url: &url::Url) -> Result<ActivationQuery, &'static str> {
    let mut controller_version_id = None;
    let mut ring_generation = None;
    let mut high_watermark = 0;
    let mut after_activation_id = 0;
    let mut limit = DEFAULT_LIMIT;
    let mut seen = HashSet::new();
    for (key, value) in url.query_pairs() {
        if !seen.insert(key.to_string()) {
            return Err("Duplicate Container shard activation query");
        }
        match key.as_ref() {
            "controller_version_id" => {
                if !valid_controller_version_id(value.as_ref()) {
                    return Err("Invalid Controller version ID");
                }
                controller_version_id = Some(value.into_owned());
            }
            "ring_generation" => {
                ring_generation = Some(parse_integer(
                    value.as_ref(),
                    1,
                    MAX_RING_GENERATION,
                    "Invalid Container shard ring generation",
                )?);
            }
            "high_watermark" => {
                high_watermark = parse_integer(
                    value.as_ref(),
                    1,
                    i64::MAX,
                    "Invalid Container shard activation high watermark",
                )?;
            }
            "cursor" => {
                after_activation_id = parse_integer(
                    value.as_ref(),
                    1,
                    i64::MAX,
                    "Invalid Container shard activation cursor",
                )?;
            }
            "limit" => {
                limit = parse_integer(
                    value.as_ref(),
                    1,
                    MAX_LIMIT,
                    "Invalid Container shard activation limit",
                )?;
            }
            _ => return Err("Unsupported Container shard activation query"),
        }
    }
    if after_activation_id > 0 && high_watermark == 0 {
        return Err("Container shard activation cursor requires a high watermark");
    }
    Ok(ActivationQuery {
        controller_version_id: controller_version_id.ok_or("Controller version ID is required")?,
        ring_generation: ring_generation.ok_or("Container shard ring generation is required")?,
        high_watermark,
        after_activation_id,
        limit,
    })
}

fn activation_row_valid(
    row: &RelayContainerShardActivationRow,
    controller_version_id: &str,
    ring_generation: i64,
    high_watermark: i64,
) -> bool {
    row.activation_id > 0
        && row.activation_id <= high_watermark
        && row.controller_version_id == controller_version_id
        && row.ring_generation == ring_generation
        && (1..=MAX_SHARD_COUNT).contains(&row.shard_count)
        && row.shard_index >= 0
        && row.shard_index < row.shard_count
        && row.instance_name == format!("cinatoken-relay-shard-v1-{:04}", row.shard_index)
        && (1..=MAX_RING_GENERATION).contains(&row.shard_contract_version)
        && (1..=MAX_RING_GENERATION).contains(&row.runtime_protocol_version)
        && (1..=MAX_RING_GENERATION).contains(&row.runtime_contract_version)
        && valid_lower_hex(&row.runtime_build_id, 64)
        && (1..=MAX_RING_GENERATION).contains(&row.activation_generation)
        && (1..=MAX_RING_GENERATION).contains(&row.activation_probe_generation)
        && matches!(row.environment.as_str(), "staging" | "production")
        && row.container_status == "healthy"
        && row.process_ready == 1
        && matches!(row.runtime_execution_enabled, 0 | 1)
        && matches!(row.controller_execution_enabled, 0 | 1)
        && ((row.readiness_result_code == "execution_ready"
            && row.runtime_execution_enabled == 1
            && row.controller_execution_enabled == 1)
            || (row.readiness_result_code == "process_ready_execution_disabled"
                && (row.runtime_execution_enabled == 0 || row.controller_execution_enabled == 0)))
        && row.activated_at > 0
        && valid_lower_hex(&row.activation_digest_sha256, 64)
        && row.activation_digest_sha256 == activation_digest(row)
}

fn activation_record(row: RelayContainerShardActivationRow) -> ActivationRecord {
    ActivationRecord {
        registry_event_sequence: row.activation_id,
        shard_count: row.shard_count,
        shard_index: row.shard_index,
        instance_name: row.instance_name,
        shard_contract_version: row.shard_contract_version,
        runtime_protocol_version: row.runtime_protocol_version,
        runtime_contract_version: row.runtime_contract_version,
        runtime_build_id: row.runtime_build_id,
        activation_generation: row.activation_generation,
        activation_probe_generation: row.activation_probe_generation,
        environment: row.environment,
        container_status: row.container_status,
        readiness_result_code: row.readiness_result_code,
        process_ready: row.process_ready == 1,
        runtime_execution_enabled: row.runtime_execution_enabled == 1,
        controller_execution_enabled: row.controller_execution_enabled == 1,
        activation_digest_sha256: row.activation_digest_sha256,
        activated_at: row.activated_at,
    }
}

fn activation_digest(row: &RelayContainerShardActivationRow) -> String {
    let mut hasher = Sha256::new();
    hasher.update(DIGEST_DOMAIN);
    update_digest_part(&mut hasher, &row.controller_version_id);
    update_digest_part(&mut hasher, row.ring_generation.to_string());
    update_digest_part(&mut hasher, row.shard_count.to_string());
    update_digest_part(&mut hasher, row.shard_index.to_string());
    update_digest_part(&mut hasher, &row.instance_name);
    update_digest_part(&mut hasher, row.shard_contract_version.to_string());
    update_digest_part(&mut hasher, row.runtime_protocol_version.to_string());
    update_digest_part(&mut hasher, row.runtime_contract_version.to_string());
    update_digest_part(&mut hasher, &row.runtime_build_id);
    update_digest_part(&mut hasher, row.activation_generation.to_string());
    update_digest_part(&mut hasher, row.activation_probe_generation.to_string());
    update_digest_part(&mut hasher, &row.environment);
    update_digest_part(&mut hasher, &row.container_status);
    update_digest_part(&mut hasher, &row.readiness_result_code);
    update_digest_part(&mut hasher, row.process_ready.to_string());
    update_digest_part(&mut hasher, row.runtime_execution_enabled.to_string());
    update_digest_part(&mut hasher, row.controller_execution_enabled.to_string());
    update_digest_part(&mut hasher, row.activated_at.to_string());
    format!("{:x}", hasher.finalize())
}

fn update_digest_part(hasher: &mut Sha256, part: impl AsRef<[u8]>) {
    let part = part.as_ref();
    hasher.update((part.len() as u32).to_be_bytes());
    hasher.update(part);
}

fn valid_controller_version_id(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'.' | b'_' | b':' | b'-'))
        })
}

fn valid_lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn parse_integer(
    value: &str,
    min: i64,
    max: i64,
    error: &'static str,
) -> Result<i64, &'static str> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(error);
    }
    let parsed = value
        .parse::<i64>()
        .ok()
        .filter(|value| (min..=max).contains(value));
    parsed
        .filter(|parsed| value == parsed.to_string())
        .ok_or(error)
}

fn no_store(mut response: Response) -> WorkerResult<Response> {
    response.headers_mut().set("Cache-Control", "no-store")?;
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row() -> RelayContainerShardActivationRow {
        let mut row = RelayContainerShardActivationRow {
            activation_id: 41,
            controller_version_id: "controller-version-1".to_string(),
            ring_generation: 7,
            shard_count: 8,
            shard_index: 3,
            instance_name: "cinatoken-relay-shard-v1-0003".to_string(),
            shard_contract_version: 1,
            runtime_protocol_version: 1,
            runtime_contract_version: 1,
            runtime_build_id: "a".repeat(64),
            activation_generation: 1,
            activation_probe_generation: 9,
            environment: "staging".to_string(),
            container_status: "healthy".to_string(),
            readiness_result_code: "process_ready_execution_disabled".to_string(),
            process_ready: 1,
            runtime_execution_enabled: 0,
            controller_execution_enabled: 0,
            activation_digest_sha256: String::new(),
            activated_at: 1_900_000_000,
        };
        row.activation_digest_sha256 = activation_digest(&row);
        assert_eq!(
            row.activation_digest_sha256,
            "dd807252bf5c7f04456c28f6daff983c63a5bc9557ce57cc872b91abb9293bdb"
        );
        row
    }

    #[test]
    fn validates_cross_runtime_digest_and_candidate_identity() {
        let row = row();
        assert!(activation_row_valid(&row, "controller-version-1", 7, 41));
        let mut corrupt = row.clone();
        corrupt.runtime_build_id = "b".repeat(64);
        assert!(!activation_row_valid(
            &corrupt,
            "controller-version-1",
            7,
            41
        ));
        assert_eq!(activation_record(row).registry_event_sequence, 41);
    }

    #[test]
    fn query_is_strict_and_source_contains_no_write_path() {
        let url = url::Url::parse(
            "https://example.test/api/platform/container/shards/activations?controller_version_id=controller-version-1&ring_generation=7&limit=16",
        )
        .unwrap();
        assert_eq!(
            activation_query_from_url(&url).unwrap(),
            ActivationQuery {
                controller_version_id: "controller-version-1".to_string(),
                ring_generation: 7,
                high_watermark: 0,
                after_activation_id: 0,
                limit: 16,
            }
        );
        for url in [
            "https://example.test/api?controller_version_id=controller-version-1&ring_generation=7&ring_generation=8",
            "https://example.test/api?controller_version_id=controller-version-1&ring_generation=07",
            "https://example.test/api?controller_version_id=controller-version-1&ring_generation=7&cursor=1",
            "https://example.test/api?controller_version_id=controller-version-1&ring_generation=7&unknown=1",
        ] {
            let parsed = url::Url::parse(url).unwrap();
            assert!(
                activation_query_from_url(&parsed).is_err(),
                "accepted {url}"
            );
        }
        let source = include_str!("container_shard_activation_admin.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        assert!(source.contains("require_root_auth(&req, &env)"));
        assert!(source.contains("Cache-Control\", \"no-store"));
        assert!(!source.contains("INSERT INTO"));
        assert!(!source.contains("UPDATE relay_container"));
        assert!(!source.contains("DELETE FROM"));
    }
}
