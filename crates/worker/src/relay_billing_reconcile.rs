use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use worker::{Env, Request, Response, Result as WorkerResult};

use crate::admin::{
    admin_audit_info, envelope_error_response, envelope_ok_response, read_json_body,
    require_admin_auth, require_root_auth, require_secure_verification,
};

const INCIDENT_DEFAULT_LIMIT: i64 = 20;
const INCIDENT_MAX_LIMIT: i64 = 50;
const REPLAY_LEASE_SECONDS: i64 = 60;

#[derive(Debug, Serialize, PartialEq, Eq)]
struct IncidentListResponse {
    contract_version: u32,
    count: usize,
    records: Vec<IncidentMetadata>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct IncidentMetadata {
    incident_id: String,
    event_fingerprint: String,
    classification: String,
    status: String,
    replayable: bool,
    delivery_count: i64,
    first_seen_at: i64,
    last_seen_at: i64,
    replay_attempt_count: i64,
    replay_lease_expires_at: Option<i64>,
    last_replay_at: Option<i64>,
    resolved_at: Option<i64>,
    resolution: Option<String>,
    last_error_code: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct IncidentReplayRequest {
    confirm_replay: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct IncidentReplayResponse {
    contract_version: u32,
    incident_id: String,
    status: &'static str,
    replay_generation: i64,
}

pub(crate) fn relay_billing_finalization_reconcile_compiled() -> bool {
    true
}

pub async fn list_incidents(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return no_store(response);
    }
    let (status, limit) = match incident_list_query(&req) {
        Ok(query) => query,
        Err(message) => return no_store(envelope_error_response(400, message)),
    };
    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(err) => {
            worker::console_error!("billing finalization incident list: D1 unavailable: {err}");
            return no_store(envelope_error_response(
                503,
                "Billing finalization incidents are unavailable",
            ));
        }
    };
    match crate::d1_repositories::relay_billing_reservation_schema_ready(&db).await {
        Ok(true) => {}
        Ok(false) => {
            return no_store(envelope_error_response(
                503,
                "Billing finalization incident schema is not ready",
            ));
        }
        Err(err) => {
            worker::console_error!("billing finalization incident schema probe failed: {err}");
            return no_store(envelope_error_response(
                503,
                "Billing finalization incident schema is not ready",
            ));
        }
    }
    let rows = match crate::d1_repositories::list_relay_billing_finalization_incidents(
        &db, &status, limit,
    )
    .await
    {
        Ok(rows) => rows,
        Err(err) => {
            worker::console_error!("billing finalization incident list failed: {err}");
            return no_store(envelope_error_response(
                503,
                "Billing finalization incidents are unavailable",
            ));
        }
    };
    let records = rows
        .into_iter()
        .map(IncidentMetadata::from)
        .collect::<Vec<_>>();
    no_store(envelope_ok_response(&IncidentListResponse {
        contract_version: 1,
        count: records.len(),
        records,
    })?)
}

pub async fn replay_incident(
    mut req: Request,
    env: Env,
    incident_id: Option<String>,
) -> WorkerResult<Response> {
    let claims = match require_root_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return no_store(response),
    };
    if let Some(response) = require_secure_verification(&req, &env, claims.id).await? {
        return no_store(response);
    }
    let admin_info = admin_audit_info(&claims, &req);
    if !crate::relay_billing_queue::relay_billing_finalization_reconcile_enabled(&env) {
        return no_store(envelope_error_response(
            403,
            "Billing finalization reconciliation is disabled",
        ));
    }
    let incident_id = incident_id.unwrap_or_default();
    if !valid_incident_id(&incident_id) {
        return no_store(envelope_error_response(400, "Invalid incident id"));
    }
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return no_store(response),
    };
    let replay: IncidentReplayRequest = match serde_json::from_value(body) {
        Ok(replay) => replay,
        Err(_) => {
            return no_store(envelope_error_response(
                400,
                "Invalid billing finalization replay request",
            ));
        }
    };
    if !replay.confirm_replay {
        return no_store(envelope_error_response(
            400,
            "Billing finalization replay requires confirm_replay=true",
        ));
    }

    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(err) => {
            worker::console_error!("billing finalization replay: D1 unavailable: {err}");
            return no_store(envelope_error_response(
                503,
                "Billing finalization replay is unavailable",
            ));
        }
    };
    let schema_ready =
        match crate::d1_repositories::relay_billing_reservation_schema_ready(&db).await {
            Ok(ready) => ready,
            Err(err) => {
                worker::console_error!("billing finalization replay schema probe failed: {err}");
                false
            }
        };
    if !schema_ready {
        return no_store(envelope_error_response(
            503,
            "Billing finalization incident schema is not ready",
        ));
    }
    let queue = match env.queue(crate::relay_billing_queue::BILLING_QUEUE_BINDING) {
        Ok(queue) => queue,
        Err(err) => {
            worker::console_error!("billing finalization replay: Queue unavailable: {err}");
            return no_store(envelope_error_response(
                503,
                "Billing finalization replay Queue is unavailable",
            ));
        }
    };
    let now = crate::admin::unix_timestamp();
    let claimed = match crate::d1_repositories::claim_relay_billing_finalization_incident(
        &db,
        &incident_id,
        now,
        now.saturating_add(REPLAY_LEASE_SECONDS),
    )
    .await
    {
        Ok(Some(claimed)) => claimed,
        Ok(None) => {
            let current =
                crate::d1_repositories::relay_billing_finalization_incident(&db, &incident_id)
                    .await?;
            return no_store(match current {
                None => envelope_error_response(404, "Billing finalization incident was not found"),
                Some(current) if current.classification == "invalid" => {
                    envelope_error_response(409, "Billing finalization incident is not replayable")
                }
                Some(current) if current.status == "resolved" => envelope_error_response(
                    409,
                    "Billing finalization incident is already resolved",
                ),
                Some(_) => envelope_error_response(
                    409,
                    "Billing finalization incident replay is already in progress",
                ),
            });
        }
        Err(err) => {
            worker::console_error!("billing finalization incident claim failed: {err}");
            return no_store(envelope_error_response(
                503,
                "Billing finalization replay is unavailable",
            ));
        }
    };

    let event = match serde_json::from_str::<
        crate::relay_billing_queue::RelayBillingFinalizationEvent,
    >(&claimed.payload_json)
    {
        Ok(event) if stored_event_matches_incident(&event, &claimed) => event,
        _ => {
            worker::console_error!(
                "billing finalization incident {} failed stored-event integrity validation",
                incident_id
            );
            let _ = crate::d1_repositories::fail_relay_billing_finalization_incident(
                &db,
                &incident_id,
                claimed.replay_generation,
                "stored_event_invalid",
            )
            .await;
            return no_store(envelope_error_response(
                409,
                "Billing finalization incident is not replayable",
            ));
        }
    };
    if let Err(err) = crate::d1_repositories::insert_admin_audit_log(
        &db,
        None,
        None,
        &claims.username,
        "billing_finalization.replay_requested",
        "Authorized a frozen billing finalization incident replay",
        &serde_json::json!({
            "incident_id": incident_id.as_str(),
            "replay_generation": claimed.replay_generation,
        }),
        &admin_info,
        now,
    )
    .await
    {
        worker::console_error!("billing finalization replay audit failed: {err}");
        let _ = crate::d1_repositories::fail_relay_billing_finalization_incident(
            &db,
            &incident_id,
            claimed.replay_generation,
            "admin_audit_failed",
        )
        .await;
        return no_store(envelope_error_response(
            503,
            "Billing finalization replay audit is unavailable",
        ));
    }
    if let Err(err) = queue.send(&event).await {
        worker::console_error!("billing finalization incident Queue replay failed: {err}");
        let _ = crate::d1_repositories::fail_relay_billing_finalization_incident(
            &db,
            &incident_id,
            claimed.replay_generation,
            "queue_send_failed",
        )
        .await;
        return no_store(envelope_error_response(
            503,
            "Billing finalization replay Queue send failed",
        ));
    }
    let response = envelope_ok_response(&IncidentReplayResponse {
        contract_version: 1,
        incident_id,
        status: "queued",
        replay_generation: claimed.replay_generation,
    })?
    .with_status(202);
    no_store(response)
}

impl From<crate::d1_repositories::RelayBillingFinalizationIncidentSummary> for IncidentMetadata {
    fn from(row: crate::d1_repositories::RelayBillingFinalizationIncidentSummary) -> Self {
        Self {
            incident_id: row.incident_id,
            event_fingerprint: row.payload_sha256,
            replayable: row.classification == "replayable" && row.status != "resolved",
            classification: row.classification,
            status: row.status,
            delivery_count: row.delivery_count,
            first_seen_at: row.first_seen_at,
            last_seen_at: row.last_seen_at,
            replay_attempt_count: row.replay_attempt_count,
            replay_lease_expires_at: (row.replay_lease_expires_at > 0)
                .then_some(row.replay_lease_expires_at),
            last_replay_at: (row.last_replay_at > 0).then_some(row.last_replay_at),
            resolved_at: (row.resolved_at > 0).then_some(row.resolved_at),
            resolution: (!row.resolution.is_empty()).then_some(row.resolution),
            last_error_code: (!row.last_error.is_empty()).then_some(row.last_error),
        }
    }
}

fn incident_list_query(req: &Request) -> Result<(String, i64), &'static str> {
    let url = req.url().map_err(|_| "Invalid incident list URL")?;
    let mut status = String::new();
    let mut limit = INCIDENT_DEFAULT_LIMIT;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "status" => {
                let candidate = value.trim();
                if !matches!(
                    candidate,
                    "" | "open" | "replaying" | "resolved" | "invalid"
                ) {
                    return Err("Invalid billing finalization incident status");
                }
                status = candidate.to_string();
            }
            "limit" => {
                limit = value
                    .parse::<i64>()
                    .ok()
                    .filter(|value| (1..=INCIDENT_MAX_LIMIT).contains(value))
                    .ok_or("Invalid billing finalization incident limit")?;
            }
            _ => return Err("Unsupported billing finalization incident query"),
        }
    }
    Ok((status, limit))
}

fn valid_incident_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn stored_event_matches_incident(
    event: &crate::relay_billing_queue::RelayBillingFinalizationEvent,
    incident: &crate::d1_repositories::RelayBillingFinalizationIncident,
) -> bool {
    let payload_sha256 = format!("{:x}", Sha256::digest(incident.payload_json.as_bytes()));
    let incident_id = format!(
        "{:x}",
        Sha256::digest(format!("relay-billing-dlq-v1:event:{}", event.event_id).as_bytes())
    );
    event.validate().is_ok()
        && event.event_id == incident.event_id
        && payload_sha256 == incident.payload_sha256
        && incident_id == incident.incident_id
}

fn no_store(mut response: Response) -> WorkerResult<Response> {
    response.headers_mut().set("Cache-Control", "no-store")?;
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn incident_ids_are_exact_lower_hex_digests() {
        assert!(valid_incident_id(&"a".repeat(64)));
        assert!(!valid_incident_id(&"A".repeat(64)));
        assert!(!valid_incident_id(&"a".repeat(63)));
        assert!(!valid_incident_id(&format!("{}g", "a".repeat(63))));
    }

    #[test]
    fn replay_request_rejects_payload_and_pricing_fields() {
        assert!(
            serde_json::from_str::<IncidentReplayRequest>(r#"{"confirm_replay":true}"#).is_ok()
        );
        assert!(serde_json::from_str::<IncidentReplayRequest>(
            r#"{"confirm_replay":true,"final_quota":1}"#
        )
        .is_err());
        assert!(serde_json::from_str::<IncidentReplayRequest>(
            r#"{"confirm_replay":true,"payload":{}}"#
        )
        .is_err());
    }

    #[test]
    fn incident_projection_omits_frozen_payload_and_event_identity() {
        let metadata = IncidentMetadata::from(
            crate::d1_repositories::RelayBillingFinalizationIncidentSummary {
                incident_id: "a".repeat(64),
                payload_sha256: "b".repeat(64),
                classification: "replayable".to_string(),
                status: "open".to_string(),
                delivery_count: 2,
                first_seen_at: 1,
                last_seen_at: 2,
                replay_attempt_count: 0,
                replay_lease_expires_at: 0,
                last_replay_at: 0,
                resolved_at: 0,
                resolution: String::new(),
                last_error: "delivery_exhausted".to_string(),
            },
        );
        let serialized = serde_json::to_string(&metadata).unwrap();
        assert!(serialized.contains("event_fingerprint"));
        assert!(!serialized.contains("payload_json"));
        assert!(!serialized.contains("event_id"));
        assert!(!serialized.contains("reservation_key"));
    }

    #[test]
    fn stored_replay_requires_matching_event_payload_and_incident_digests() {
        let reservation_key = "relayreserve-integrity";
        let event_id = format!("relay-finalization-v1:{reservation_key}");
        let event = crate::relay_billing_queue::RelayBillingFinalizationEvent {
            event_type: "cinatoken.relay_billing_finalization".to_string(),
            schema_version: 1,
            event_id: event_id.clone(),
            reservation_key: reservation_key.to_string(),
            expr_hash: "sha256:expr".to_string(),
            channel_id: 9,
            selected_group: "default".to_string(),
            finalized_at: 1_800_000_000,
            finalization: crate::relay_billing_queue::RelayBillingFinalizationAction::Refund {
                finalization_reason: "upstream_failure".to_string(),
                account_request: true,
            },
            audit_log: crate::relay_billing_queue::RelayBillingFinalizationAudit {
                user_id: 7,
                created_at: 1_800_000_000,
                log_type: 2,
                content: "frozen refund".to_string(),
                model_name: "gpt-test".to_string(),
                quota: 0,
                prompt_tokens: 0,
                completion_tokens: 0,
                use_time: 1,
                is_stream: 1,
                channel_id: 9,
                token_id: 11,
                group: "default".to_string(),
                other: serde_json::json!({
                    "billing_finalization_event_id": event_id,
                    "billing_finalization_transport": "billing_queue",
                    "billing_reservation_key": reservation_key,
                })
                .to_string(),
            },
        };
        let payload_json = serde_json::to_string(&event).expect("serialize event");
        let payload_sha256 = format!("{:x}", Sha256::digest(payload_json.as_bytes()));
        let incident_id = format!(
            "{:x}",
            Sha256::digest(format!("relay-billing-dlq-v1:event:{}", event.event_id).as_bytes())
        );
        let incident = crate::d1_repositories::RelayBillingFinalizationIncident {
            incident_id,
            event_id: event.event_id.clone(),
            payload_sha256,
            payload_json,
            classification: "replayable".to_string(),
            status: "replaying".to_string(),
            replay_generation: 1,
            replay_attempt_count: 1,
            replay_lease_expires_at: 1_800_000_060,
        };
        assert!(stored_event_matches_incident(&event, &incident));

        let mut corrupted = incident.clone();
        corrupted.payload_sha256 = "0".repeat(64);
        assert!(!stored_event_matches_incident(&event, &corrupted));
        corrupted = incident;
        corrupted.incident_id = "0".repeat(64);
        assert!(!stored_event_matches_incident(&event, &corrupted));
    }
}
