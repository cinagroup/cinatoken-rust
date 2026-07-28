//! Root-admin, read-only pagination for immutable Container shard placement evidence.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use worker::{Env, Request, Response, Result as WorkerResult};

use crate::admin::{envelope_error_response, envelope_ok_response, require_root_auth};
use crate::d1_repositories::{
    list_relay_container_shard_placements, relay_container_shard_placement_schema_ready,
    relay_container_shard_placement_snapshot, RelayContainerShardPlacementRow,
};

const CONTRACT_VERSION: u32 = 1;
const PLACEMENT_CONTRACT: &str = "cinatoken-relay-shard-placement-attestation-v1";
const DEFAULT_LIMIT: i64 = 16;
const MAX_LIMIT: i64 = 64;
const MAX_RING_GENERATION: i64 = 1_000_000;
const MAX_SHARD_COUNT: i64 = 1_024;
const MAX_JSON_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const DIGEST_DOMAIN: &[u8] = b"cinatoken-relay-shard-placement-attestation-v1";

#[derive(Debug, PartialEq, Eq)]
struct PlacementQuery {
    controller_version_id: String,
    ring_generation: i64,
    campaign_id: String,
    high_watermark: i64,
    after_event_sequence: i64,
    limit: i64,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct PlacementPageResponse {
    contract_version: u32,
    placement_contract: &'static str,
    controller_version_id: String,
    ring_generation: i64,
    campaign_id: String,
    high_watermark: i64,
    total_records: i64,
    count: usize,
    next_cursor: Option<String>,
    pagination_complete: bool,
    records: Vec<PlacementRecord>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct PlacementRecord {
    placement_event_sequence: i64,
    placement_attestation_digest_sha256: String,
    contract_version: i64,
    environment: String,
    controller_service_name: String,
    controller_version_id: String,
    durable_object_namespace_binding: String,
    durable_object_class: String,
    jurisdiction: String,
    canonical_name_sha256: String,
    object_id_sha256: String,
    shard_contract_version: i64,
    ring_generation: i64,
    shard_count: i64,
    shard_index: i64,
    instance_name: String,
    activation_id: i64,
    campaign_id: String,
    claim_digest_sha256: String,
    readiness_result_sha256: String,
    activation_digest_sha256: String,
    consumption_digest_sha256: String,
    recorded_at: i64,
}

pub async fn list(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_root_auth(&req, &env).await? {
        return no_store(response);
    }
    let query = match placement_query(&req) {
        Ok(query) => query,
        Err(message) => return no_store(envelope_error_response(400, message)),
    };
    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(err) => {
            worker::console_error!("Container shard placement list: D1 unavailable: {err}");
            return no_store(envelope_error_response(
                503,
                "Container shard placement ledger is unavailable",
            ));
        }
    };
    match relay_container_shard_placement_schema_ready(&db).await {
        Ok(true) => {}
        Ok(false) => {
            return no_store(envelope_error_response(
                503,
                "Container shard placement schema is not ready",
            ));
        }
        Err(err) => {
            worker::console_error!("Container shard placement schema probe failed: {err}");
            return no_store(envelope_error_response(
                503,
                "Container shard placement ledger is unavailable",
            ));
        }
    }
    let snapshot = match relay_container_shard_placement_snapshot(
        &db,
        &query.controller_version_id,
        query.ring_generation,
        &query.campaign_id,
        query.high_watermark,
    )
    .await
    {
        Ok(snapshot) => snapshot,
        Err(err) => {
            worker::console_error!("Container shard placement snapshot failed: {err}");
            return no_store(envelope_error_response(
                503,
                "Container shard placement ledger is unavailable",
            ));
        }
    };
    if query.high_watermark > 0 && snapshot.high_watermark != query.high_watermark {
        return no_store(envelope_error_response(
            409,
            "Container shard placement high watermark is unavailable",
        ));
    }
    if snapshot.high_watermark > MAX_JSON_SAFE_INTEGER || snapshot.record_count < 0 {
        worker::console_error!("Container shard placement snapshot exceeds its JSON bound");
        return no_store(envelope_error_response(
            503,
            "Container shard placement ledger is unavailable",
        ));
    }
    if query.after_event_sequence > snapshot.high_watermark {
        return no_store(envelope_error_response(
            400,
            "Invalid Container shard placement cursor",
        ));
    }

    let mut rows = if snapshot.high_watermark == 0 {
        Vec::new()
    } else if query.after_event_sequence == snapshot.high_watermark {
        return no_store(envelope_error_response(
            400,
            "Container shard placement cursor is already terminal",
        ));
    } else {
        match list_relay_container_shard_placements(
            &db,
            &query.controller_version_id,
            query.ring_generation,
            &query.campaign_id,
            snapshot.high_watermark,
            query.after_event_sequence,
            query.limit.saturating_add(1),
        )
        .await
        {
            Ok(rows) => rows,
            Err(err) => {
                worker::console_error!("Container shard placement page failed: {err}");
                return no_store(envelope_error_response(
                    503,
                    "Container shard placement ledger is unavailable",
                ));
            }
        }
    };
    let mut previous_event_sequence = query.after_event_sequence;
    if rows.iter().any(|row| {
        let valid = row.placement_event_sequence > previous_event_sequence
            && placement_row_valid(
                row,
                &query.controller_version_id,
                query.ring_generation,
                &query.campaign_id,
                snapshot.high_watermark,
            );
        previous_event_sequence = row.placement_event_sequence;
        !valid
    }) {
        worker::console_error!("Container shard placement row contract is invalid");
        return no_store(envelope_error_response(
            503,
            "Container shard placement ledger is unavailable",
        ));
    }
    let has_more = rows.len() > query.limit as usize;
    rows.truncate(query.limit as usize);
    let next_cursor = has_more.then(|| {
        rows.last()
            .expect("non-empty over-limit page")
            .placement_event_sequence
            .to_string()
    });
    let records = rows.into_iter().map(placement_record).collect::<Vec<_>>();
    no_store(envelope_ok_response(&PlacementPageResponse {
        contract_version: CONTRACT_VERSION,
        placement_contract: PLACEMENT_CONTRACT,
        controller_version_id: query.controller_version_id,
        ring_generation: query.ring_generation,
        campaign_id: query.campaign_id,
        high_watermark: snapshot.high_watermark,
        total_records: snapshot.record_count,
        count: records.len(),
        pagination_complete: next_cursor.is_none(),
        next_cursor,
        records,
    })?)
}

fn placement_query(req: &Request) -> Result<PlacementQuery, &'static str> {
    let url = req
        .url()
        .map_err(|_| "Invalid Container shard placement URL")?;
    placement_query_from_url(&url)
}

fn placement_query_from_url(url: &url::Url) -> Result<PlacementQuery, &'static str> {
    let mut controller_version_id = None;
    let mut ring_generation = None;
    let mut campaign_id = None;
    let mut high_watermark = 0;
    let mut after_event_sequence = 0;
    let mut limit = DEFAULT_LIMIT;
    let mut seen = HashSet::new();
    for (key, value) in url.query_pairs() {
        if !seen.insert(key.to_string()) {
            return Err("Duplicate Container shard placement query");
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
            "campaign_id" => {
                if !valid_lower_hex(value.as_ref(), 64) {
                    return Err("Invalid Container shard activation campaign ID");
                }
                campaign_id = Some(value.into_owned());
            }
            "high_watermark" => {
                high_watermark = parse_integer(
                    value.as_ref(),
                    1,
                    MAX_JSON_SAFE_INTEGER,
                    "Invalid Container shard placement high watermark",
                )?;
            }
            "cursor" => {
                after_event_sequence = parse_integer(
                    value.as_ref(),
                    1,
                    MAX_JSON_SAFE_INTEGER,
                    "Invalid Container shard placement cursor",
                )?;
            }
            "limit" => {
                limit = parse_integer(
                    value.as_ref(),
                    1,
                    MAX_LIMIT,
                    "Invalid Container shard placement limit",
                )?;
            }
            _ => return Err("Unsupported Container shard placement query"),
        }
    }
    if after_event_sequence > 0 && high_watermark == 0 {
        return Err("Container shard placement cursor requires a high watermark");
    }
    Ok(PlacementQuery {
        controller_version_id: controller_version_id.ok_or("Controller version ID is required")?,
        ring_generation: ring_generation.ok_or("Container shard ring generation is required")?,
        campaign_id: campaign_id.ok_or("Container shard activation campaign ID is required")?,
        high_watermark,
        after_event_sequence,
        limit,
    })
}

fn placement_row_valid(
    row: &RelayContainerShardPlacementRow,
    controller_version_id: &str,
    ring_generation: i64,
    campaign_id: &str,
    high_watermark: i64,
) -> bool {
    row.placement_event_sequence > 0
        && row.placement_event_sequence <= high_watermark
        && row.activation_id > 0
        && row.contract_version == 1
        && matches!(row.environment.as_str(), "staging" | "production")
        && valid_controller_service_name(&row.controller_service_name)
        && row.controller_version_id == controller_version_id
        && row.durable_object_namespace_binding == "RELAY_SHARDS"
        && row.durable_object_class == "RelayShardContainer"
        && row.jurisdiction == "default"
        && valid_lower_hex(&row.canonical_name_sha256, 64)
        && valid_lower_hex(&row.object_id_sha256, 64)
        && row.shard_contract_version == 1
        && row.ring_generation == ring_generation
        && (1..=MAX_SHARD_COUNT).contains(&row.shard_count)
        && row.shard_index >= 0
        && row.shard_index < row.shard_count
        && row.instance_name == format!("cinatoken-relay-shard-v1-{:04}", row.shard_index)
        && row.campaign_id == campaign_id
        && valid_lower_hex(&row.claim_digest_sha256, 64)
        && valid_lower_hex(&row.readiness_result_sha256, 64)
        && valid_lower_hex(&row.activation_digest_sha256, 64)
        && valid_lower_hex(&row.consumption_digest_sha256, 64)
        && row.recorded_at > 0
        && row.canonical_name_sha256 == sha256_hex(&row.instance_name)
        && valid_lower_hex(&row.placement_attestation_digest_sha256, 64)
        && row.placement_attestation_digest_sha256 == placement_digest(row)
}

fn placement_record(row: RelayContainerShardPlacementRow) -> PlacementRecord {
    PlacementRecord {
        placement_event_sequence: row.placement_event_sequence,
        placement_attestation_digest_sha256: row.placement_attestation_digest_sha256,
        contract_version: row.contract_version,
        environment: row.environment,
        controller_service_name: row.controller_service_name,
        controller_version_id: row.controller_version_id,
        durable_object_namespace_binding: row.durable_object_namespace_binding,
        durable_object_class: row.durable_object_class,
        jurisdiction: row.jurisdiction,
        canonical_name_sha256: row.canonical_name_sha256,
        object_id_sha256: row.object_id_sha256,
        shard_contract_version: row.shard_contract_version,
        ring_generation: row.ring_generation,
        shard_count: row.shard_count,
        shard_index: row.shard_index,
        instance_name: row.instance_name,
        activation_id: row.activation_id,
        campaign_id: row.campaign_id,
        claim_digest_sha256: row.claim_digest_sha256,
        readiness_result_sha256: row.readiness_result_sha256,
        activation_digest_sha256: row.activation_digest_sha256,
        consumption_digest_sha256: row.consumption_digest_sha256,
        recorded_at: row.recorded_at,
    }
}

fn placement_digest(row: &RelayContainerShardPlacementRow) -> String {
    let mut hasher = Sha256::new();
    hasher.update(DIGEST_DOMAIN);
    for part in [
        row.contract_version.to_string(),
        row.environment.clone(),
        row.controller_service_name.clone(),
        row.controller_version_id.clone(),
        row.durable_object_namespace_binding.clone(),
        row.durable_object_class.clone(),
        row.jurisdiction.clone(),
        row.canonical_name_sha256.clone(),
        row.object_id_sha256.clone(),
        row.shard_contract_version.to_string(),
        row.ring_generation.to_string(),
        row.shard_count.to_string(),
        row.shard_index.to_string(),
        row.instance_name.clone(),
    ] {
        update_digest_part(&mut hasher, part);
    }
    format!("{:x}", hasher.finalize())
}

fn sha256_hex(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn update_digest_part(hasher: &mut Sha256, part: impl AsRef<[u8]>) {
    let part = part.as_ref();
    hasher.update((part.len() as u32).to_be_bytes());
    hasher.update(part);
}

fn valid_controller_service_name(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || (byte == b'-' && index > 0 && index + 1 < value.len())
        })
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

    fn row() -> RelayContainerShardPlacementRow {
        RelayContainerShardPlacementRow {
            placement_event_sequence: 101,
            placement_attestation_digest_sha256:
                "2f2416c82c3b17feb78884f9d42dbaec63554a98d391a43536df9aac5776fd5c".to_string(),
            contract_version: 1,
            environment: "staging".to_string(),
            controller_service_name: "cinatoken-container-controller-staging".to_string(),
            controller_version_id: "controller-version-001".to_string(),
            durable_object_namespace_binding: "RELAY_SHARDS".to_string(),
            durable_object_class: "RelayShardContainer".to_string(),
            jurisdiction: "default".to_string(),
            canonical_name_sha256:
                "0f7b57fb099ff92837664e800c3aa8066adf3040415dd98d00263a00e09adca4".to_string(),
            object_id_sha256: "a8ae6e6ee929abea3afcfc5258c8ccd6f85273e0d4626d26c7279f3250f77c8e"
                .to_string(),
            shard_contract_version: 1,
            ring_generation: 7,
            shard_count: 32,
            shard_index: 3,
            instance_name: "cinatoken-relay-shard-v1-0003".to_string(),
            activation_id: 41,
            campaign_id: "3".repeat(64),
            claim_digest_sha256: "4".repeat(64),
            readiness_result_sha256: "5".repeat(64),
            activation_digest_sha256: "6".repeat(64),
            consumption_digest_sha256: "7".repeat(64),
            recorded_at: 1_900_000_000,
        }
    }

    #[test]
    fn validates_cross_runtime_digest_and_hides_raw_object_identity() {
        let row = row();
        assert_eq!(
            placement_digest(&row),
            "2f2416c82c3b17feb78884f9d42dbaec63554a98d391a43536df9aac5776fd5c"
        );
        assert!(placement_row_valid(
            &row,
            "controller-version-001",
            7,
            &"3".repeat(64),
            101
        ));
        let record = placement_record(row);
        assert_eq!(record.placement_event_sequence, 101);
        assert_eq!(record.activation_id, 41);
        let source = include_str!("container_shard_placement_admin.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        assert!(!source.contains("durable_object_id"));
    }

    #[test]
    fn rejects_identity_or_digest_drift() {
        let row = row();
        for corrupt in [
            RelayContainerShardPlacementRow {
                jurisdiction: "eu".to_string(),
                ..row.clone()
            },
            RelayContainerShardPlacementRow {
                object_id_sha256: "8".repeat(64),
                ..row.clone()
            },
            RelayContainerShardPlacementRow {
                campaign_id: "9".repeat(64),
                ..row.clone()
            },
        ] {
            assert!(!placement_row_valid(
                &corrupt,
                "controller-version-001",
                7,
                &"3".repeat(64),
                101
            ));
        }
    }

    #[test]
    fn query_is_strict_and_reader_has_no_mutation_or_runtime_binding_path() {
        let url = url::Url::parse(&format!(
            "https://example.test/api/platform/container/shards/placements?controller_version_id=controller-version-001&ring_generation=7&campaign_id={}&limit=16",
            "3".repeat(64)
        ))
        .unwrap();
        assert_eq!(
            placement_query_from_url(&url).unwrap(),
            PlacementQuery {
                controller_version_id: "controller-version-001".to_string(),
                ring_generation: 7,
                campaign_id: "3".repeat(64),
                high_watermark: 0,
                after_event_sequence: 0,
                limit: 16,
            }
        );
        for url in [
            format!(
                "https://example.test/api?controller_version_id=controller-version-001&ring_generation=7&campaign_id={}&ring_generation=8",
                "3".repeat(64)
            ),
            format!(
                "https://example.test/api?controller_version_id=controller-version-001&ring_generation=07&campaign_id={}",
                "3".repeat(64)
            ),
            format!(
                "https://example.test/api?controller_version_id=controller-version-001&ring_generation=7&campaign_id={}&cursor=1",
                "3".repeat(64)
            ),
            format!(
                "https://example.test/api?controller_version_id=controller-version-001&ring_generation=7&campaign_id={}&unknown=1",
                "3".repeat(64)
            ),
        ] {
            let parsed = url::Url::parse(&url).unwrap();
            assert!(
                placement_query_from_url(&parsed).is_err(),
                "accepted {url}"
            );
        }
        let source = include_str!("container_shard_placement_admin.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        assert!(source.contains("require_root_auth(&req, &env)"));
        assert!(source.contains("Cache-Control\", \"no-store"));
        assert!(!source.contains("INSERT INTO"));
        assert!(!source.contains("UPDATE relay_container"));
        assert!(!source.contains("DELETE FROM"));
        assert!(!source.contains(".durable_object("));
        assert!(!source.contains(".service("));

        let repository = include_str!("d1_repositories.rs")
            .split("pub async fn relay_container_shard_placement_schema_ready")
            .nth(1)
            .unwrap()
            .split("pub async fn claim_relay_container_r2_inventory_run")
            .next()
            .unwrap();
        assert!(repository.contains("FROM relay_container_shard_placement_events"));
        assert!(repository.contains("JOIN relay_container_shard_placement_attestations"));
        assert!(repository.contains("placement_event_sequence"));
        assert!(repository.contains("name NOT LIKE 'sqlite_autoindex_%'"));
        assert!(repository.contains("idx_relay_container_shard_placement_events_candidate"));
        assert!(!repository.contains("INSERT INTO"));
        assert!(!repository.contains("UPDATE relay_container"));
        assert!(!repository.contains("DELETE FROM"));
    }
}
