//! Root-only readback of the safe shard placement mutation authorization row.

use std::collections::HashSet;
use worker::{Env, Request, Response, Result as WorkerResult};

use crate::admin::{envelope_error_response, envelope_ok_response, require_root_auth};
use crate::d1_repositories::{
    relay_container_shard_placement_authorization_by_campaign,
    relay_container_shard_placement_schema_ready,
    RelayContainerShardPlacementMutationAuthorizationRow,
};

const AUTHORIZATION_CONTRACT: &str = "cinatoken-relay-shard-placement-mutation-authorization-v1";
const CONTROLLER_SERVICE: &str = "cinatoken-container-controller-staging";
const MAX_RING_GENERATION: i64 = 1_000_000;
const MAX_SHARD_COUNT: i64 = 1_024;
const MAX_CAMPAIGN_LIFETIME_SECONDS: i64 = 3_600;

pub async fn get(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_root_auth(&req, &env).await? {
        return no_store(response);
    }
    let campaign_id = match campaign_id_from_request(&req) {
        Ok(campaign_id) => campaign_id,
        Err(message) => return no_store(envelope_error_response(400, message)),
    };
    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(_) => {
            worker::console_error!("Shard placement authorization D1 binding is unavailable");
            return no_store(envelope_error_response(
                503,
                "Shard placement authorization ledger is unavailable",
            ));
        }
    };
    match relay_container_shard_placement_schema_ready(&db).await {
        Ok(true) => {}
        Ok(false) => {
            return no_store(envelope_error_response(
                503,
                "Shard placement authorization schema is not ready",
            ));
        }
        Err(_) => {
            worker::console_error!("Shard placement authorization schema probe failed");
            return no_store(envelope_error_response(
                503,
                "Shard placement authorization ledger is unavailable",
            ));
        }
    }
    let row =
        match relay_container_shard_placement_authorization_by_campaign(&db, &campaign_id).await {
            Ok(Some(row)) => row,
            Ok(None) => {
                return no_store(envelope_error_response(
                    404,
                    "Shard placement authorization was not found",
                ));
            }
            Err(_) => {
                worker::console_error!("Shard placement authorization D1 readback failed");
                return no_store(envelope_error_response(
                    503,
                    "Shard placement authorization ledger is unavailable",
                ));
            }
        };
    if !authorization_row_valid(&row, &campaign_id) {
        worker::console_error!("Shard placement authorization row contract is invalid");
        return no_store(envelope_error_response(
            503,
            "Shard placement authorization ledger is unavailable",
        ));
    }
    no_store(envelope_ok_response(&row)?)
}

fn campaign_id_from_request(req: &Request) -> Result<String, &'static str> {
    let url = req
        .url()
        .map_err(|_| "Invalid shard placement authorization URL")?;
    campaign_id_from_url(&url)
}

fn campaign_id_from_url(url: &url::Url) -> Result<String, &'static str> {
    let mut campaign_id = None;
    let mut seen = HashSet::new();
    for (key, value) in url.query_pairs() {
        if !seen.insert(key.to_string()) {
            return Err("Duplicate shard placement authorization query");
        }
        match key.as_ref() {
            "campaign_id" if valid_lower_hex(value.as_ref(), 64) => {
                campaign_id = Some(value.into_owned());
            }
            "campaign_id" => return Err("Invalid shard placement authorization campaign ID"),
            _ => return Err("Unsupported shard placement authorization query"),
        }
    }
    campaign_id.ok_or("Shard placement authorization campaign ID is required")
}

fn authorization_row_valid(
    row: &RelayContainerShardPlacementMutationAuthorizationRow,
    campaign_id: &str,
) -> bool {
    [
        &row.authorization_id_sha256,
        &row.execution_nonce_sha256,
        &row.campaign_nonce_sha256,
        &row.subject_digest_sha256,
        &row.signer_spki_sha256,
        &row.action_gate_inventory_sha256,
        &row.foundation_manifest_sha256,
        &row.runtime_build_id,
        &row.campaign_id,
        &row.campaign_digest_sha256,
    ]
    .into_iter()
    .all(|value| valid_lower_hex(value, 64))
        && HashSet::from([
            row.authorization_id_sha256.as_str(),
            row.execution_nonce_sha256.as_str(),
            row.campaign_nonce_sha256.as_str(),
        ])
        .len()
            == 3
        && row.contract_version == 1
        && row.authorization_contract == AUTHORIZATION_CONTRACT
        && valid_issuer(&row.issuer)
        && valid_key_id(&row.key_id)
        && row.environment == "staging"
        && row.controller_service_name == CONTROLLER_SERVICE
        && valid_controller_version_id(&row.controller_version_id)
        && (1..=MAX_RING_GENERATION).contains(&row.ring_generation)
        && (1..=MAX_SHARD_COUNT).contains(&row.shard_count)
        && (60..=MAX_CAMPAIGN_LIFETIME_SECONDS).contains(&row.campaign_lifetime_seconds)
        && row.permit_issued_at > 0
        && row.permit_expires_at >= row.permit_issued_at.saturating_add(60)
        && row.permit_expires_at <= row.permit_issued_at.saturating_add(600)
        && row.campaign_id == campaign_id
        && row.campaign_expires_at > row.consumed_at
        && row.consumed_by_admin_id > 0
        && row.consumed_at > 0
}

fn valid_issuer(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn valid_key_id(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || (index > 0 && matches!(byte, b'.' | b'_' | b'-'))
        })
}

fn valid_controller_version_id(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn valid_lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn no_store(mut response: Response) -> WorkerResult<Response> {
    response.headers_mut().set("Cache-Control", "no-store")?;
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row() -> RelayContainerShardPlacementMutationAuthorizationRow {
        RelayContainerShardPlacementMutationAuthorizationRow {
            authorization_id_sha256: "1".repeat(64),
            execution_nonce_sha256: "2".repeat(64),
            campaign_nonce_sha256: "3".repeat(64),
            subject_digest_sha256: "4".repeat(64),
            contract_version: 1,
            authorization_contract: AUTHORIZATION_CONTRACT.to_string(),
            issuer: "cinatoken-shard-placement-authority-staging".to_string(),
            key_id: "placement-permit-2026-07".to_string(),
            signer_spki_sha256: "5".repeat(64),
            environment: "staging".to_string(),
            controller_service_name: CONTROLLER_SERVICE.to_string(),
            controller_version_id: "controller-version-001".to_string(),
            action_gate_inventory_sha256: "6".repeat(64),
            foundation_manifest_sha256: "7".repeat(64),
            runtime_build_id: "8".repeat(64),
            ring_generation: 7,
            shard_count: 32,
            campaign_lifetime_seconds: 600,
            permit_issued_at: 1_900_000_000,
            permit_expires_at: 1_900_000_300,
            campaign_id: "9".repeat(64),
            campaign_digest_sha256: "a".repeat(64),
            campaign_expires_at: 1_900_000_600,
            consumed_by_admin_id: 1,
            consumed_at: 1_900_000_000,
        }
    }

    #[test]
    fn validates_only_the_safe_authorization_projection() {
        let row = row();
        assert!(authorization_row_valid(&row, &"9".repeat(64)));
        let value = serde_json::to_value(row).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 25);
        for prohibited in ["campaign_nonce", "execution_nonce", "signature", "spki"] {
            assert!(!value.as_object().unwrap().contains_key(prohibited));
        }
    }

    #[test]
    fn rejects_query_and_authorization_drift() {
        let url = url::Url::parse(&format!(
            "https://example.test/api/platform/container/shards/placement-mutation-authorizations?campaign_id={}",
            "9".repeat(64)
        ))
        .unwrap();
        assert_eq!(campaign_id_from_url(&url).unwrap(), "9".repeat(64));
        for raw in [
            "https://example.test/api",
            "https://example.test/api?campaign_id=ABC",
            "https://example.test/api?unknown=1",
            &format!(
                "https://example.test/api?campaign_id={}&campaign_id={}",
                "9".repeat(64),
                "9".repeat(64)
            ),
        ] {
            assert!(campaign_id_from_url(&url::Url::parse(raw).unwrap()).is_err());
        }
        let corrupt = RelayContainerShardPlacementMutationAuthorizationRow {
            campaign_digest_sha256: "A".repeat(64),
            ..row()
        };
        assert!(!authorization_row_valid(&corrupt, &"9".repeat(64)));
    }

    #[test]
    fn route_is_root_first_d1_only_and_no_store() {
        let source = include_str!("container_shard_placement_authorization_admin.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        let auth = source.find("require_root_auth(&req, &env)").unwrap();
        let db = source.find("env.d1(\"DB\")").unwrap();
        assert!(auth < db);
        assert!(source.contains("Cache-Control\", \"no-store"));
        assert!(!source.contains("INSERT INTO"));
        assert!(!source.contains("UPDATE relay_container"));
        assert!(!source.contains("DELETE FROM"));
        assert!(!source.contains(".durable_object("));
        assert!(!source.contains(".service("));

        let repository = include_str!("d1_repositories.rs")
            .split("pub async fn relay_container_shard_placement_authorization_by_campaign")
            .nth(1)
            .unwrap()
            .split("pub async fn relay_container_shard_activation_campaign_receipts")
            .next()
            .unwrap();
        assert!(repository.contains("FROM relay_container_shard_placement_mutation_authorizations"));
        assert!(repository.contains("INNER JOIN relay_container_shard_activation_campaigns"));
        assert!(repository.contains("LIMIT 1"));
        assert!(!repository.contains("INSERT INTO"));
        assert!(!repository.contains("UPDATE relay_container"));
        assert!(!repository.contains("DELETE FROM"));
    }
}
