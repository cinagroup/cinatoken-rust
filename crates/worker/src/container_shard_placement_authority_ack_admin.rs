//! Root-only mirror of an exact Authority operation-4 terminal receipt.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use worker::{Env, Request, Response, Result as WorkerResult};

use crate::admin::{
    admin_audit_info, envelope_error_response, envelope_ok_response, require_root_auth,
    require_secure_verification,
};
use crate::container_shard_placement_execution_ticket_admin::authority_claim_identity_matches;
use crate::d1_repositories::{
    acknowledge_relay_container_shard_placement_execution_ticket_authority,
    admin_audit_log_statement, relay_container_shard_activation_campaign_schema_ready,
    relay_container_shard_placement_execution_ticket_activation_read_snapshot,
    relay_container_shard_placement_execution_ticket_authority_ack,
    RelayContainerShardPlacementExecutionTicketActivationReadSnapshot,
    RelayContainerShardPlacementExecutionTicketAuthorityAck,
    RelayContainerShardPlacementExecutionTicketAuthorityAckRow,
};
use crate::shard_placement_authority_client::{
    read_exact_execution_claim, AuthorityExecutionClaimReadResponse, AuthorityExecutionReceipt,
    ExactExecutionClaimQuery, ExactExecutionClaimReadback,
};

const CONTRACT_VERSION: u32 = 1;
const ACKNOWLEDGEMENT_CONTRACT: &str = "cinatoken-relay-container-shard-placement-authority-ack-v1";
const ACKNOWLEDGEMENT_DIGEST_DOMAIN: &[u8] =
    b"cinatoken:relay-container-shard-placement-authority-ack:v1\0";
const BODY_LIMIT_BYTES: usize = 4 * 1024;
const WRITE_ENABLED_ENV: &str =
    "RELAY_CONTAINER_SHARD_PLACEMENT_TICKET_AUTHORITY_ACK_WRITE_ENABLED";
const APPLICATION_DATABASE_IDENTITY_ENV: &str =
    "RELAY_CONTAINER_SHARD_APPLICATION_DATABASE_IDENTITY_SHA256";
const AUTHORITY_DATABASE_IDENTITY_ENV: &str =
    "RELAY_CONTAINER_SHARD_AUTHORITY_DATABASE_IDENTITY_SHA256";
const AUTHORITY_LEDGER_IDENTITY_ENV: &str =
    "RELAY_CONTAINER_SHARD_AUTHORITY_LEDGER_IDENTITY_SHA256";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AcknowledgeAuthorityRequest {
    contract_version: u32,
    expected_environment: String,
    authorization_id_sha256: String,
    authority_claim_digest_sha256: String,
    authority_claim_owner_sha256: String,
    application_activation_digest_sha256: String,
    authority_activation_terminal_receipt_sha256: String,
    authority_read_request_id: String,
    confirm_acknowledge: bool,
}

#[derive(Debug, Serialize)]
struct AcknowledgeAuthorityResponse {
    contract_version: u32,
    acknowledgement_contract: &'static str,
    result: &'static str,
    ticket_id_sha256: String,
    application_ticket_digest_sha256: String,
    authority_claim_digest_sha256: String,
    application_activation_digest_sha256: String,
    authority_activation_terminal_receipt_sha256: String,
    authority_ledger_head_sha256: String,
    authority_version_id: String,
    authority_read_request_id_sha256: String,
    acknowledgement_digest_sha256: String,
    acknowledged_at: i64,
}

pub async fn acknowledge(
    mut req: Request,
    env: Env,
    ticket_id_sha256: Option<String>,
) -> WorkerResult<Response> {
    let claims = match require_root_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return no_store(response),
    };
    if let Some(response) = require_secure_verification(&req, &env, claims.id).await? {
        return no_store(response);
    }
    let ticket_id_sha256 = match ticket_id_sha256 {
        Some(value) if valid_sha256(&value) => value,
        _ => {
            return no_store(envelope_error_response(
                400,
                "Invalid shard placement execution ticket ID",
            ));
        }
    };
    let input = match read_request(&mut req).await {
        Ok(input) => input,
        Err(response) => return no_store(response),
    };
    if let Err(message) = validate_request(&input) {
        return no_store(envelope_error_response(400, message));
    }
    if deployment_environment(&env) != Some("staging") || input.expected_environment != "staging" {
        return no_store(envelope_error_response(
            404,
            "Shard placement Authority acknowledgement is unavailable",
        ));
    }
    let Some(application_database_identity_sha256) =
        deployment_identity_sha256(&env, APPLICATION_DATABASE_IDENTITY_ENV)
    else {
        return no_store(envelope_error_response(
            503,
            "Application D1 identity is unavailable",
        ));
    };
    let Some(authority_database_identity_sha256) =
        deployment_identity_sha256(&env, AUTHORITY_DATABASE_IDENTITY_ENV)
    else {
        return no_store(envelope_error_response(
            503,
            "Shard placement Authority D1 identity is unavailable",
        ));
    };
    let Some(authority_ledger_identity_sha256) =
        deployment_identity_sha256(&env, AUTHORITY_LEDGER_IDENTITY_ENV)
    else {
        return no_store(envelope_error_response(
            503,
            "Shard placement Authority ledger identity is unavailable",
        ));
    };
    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(err) => {
            worker::console_error!("Placement Authority acknowledgement: D1 unavailable: {err}");
            return no_store(envelope_error_response(
                503,
                "Shard placement execution ticket ledger is unavailable",
            ));
        }
    };
    match relay_container_shard_activation_campaign_schema_ready(&db).await {
        Ok(true) => {}
        Ok(false) => {
            return no_store(envelope_error_response(
                503,
                "Shard placement execution ticket schema is not ready",
            ));
        }
        Err(err) => {
            worker::console_error!(
                "Placement Authority acknowledgement schema probe failed: {err}"
            );
            return no_store(envelope_error_response(
                503,
                "Shard placement execution ticket ledger is unavailable",
            ));
        }
    }
    let application =
        match relay_container_shard_placement_execution_ticket_activation_read_snapshot(
            &db,
            &ticket_id_sha256,
        )
        .await
        {
            Ok(Some(snapshot)) => snapshot,
            Ok(None) => {
                return no_store(envelope_error_response(
                    404,
                    "Shard placement execution ticket activation was not found",
                ));
            }
            Err(err) => {
                worker::console_error!(
                    "Placement Authority acknowledgement snapshot failed: {err}"
                );
                return no_store(envelope_error_response(
                    503,
                    "Shard placement execution ticket ledger is unavailable",
                ));
            }
        };
    if !application_snapshot_matches(
        &application,
        &input,
        &application_database_identity_sha256,
        &authority_database_identity_sha256,
        &authority_ledger_identity_sha256,
    ) {
        return no_store(envelope_error_response(
            409,
            "Shard placement application activation identity changed",
        ));
    }
    let existing = match relay_container_shard_placement_execution_ticket_authority_ack(
        &db,
        &ticket_id_sha256,
    )
    .await
    {
        Ok(existing) => existing,
        Err(err) => {
            worker::console_error!("Placement Authority acknowledgement read failed: {err}");
            return no_store(envelope_error_response(
                503,
                "Shard placement execution ticket ledger is unavailable",
            ));
        }
    };
    let readback = match read_exact_execution_claim(
        &env,
        &ExactExecutionClaimQuery {
            authorization_id_sha256: &input.authorization_id_sha256,
            claim_digest_sha256: &input.authority_claim_digest_sha256,
            claim_owner_sha256: &input.authority_claim_owner_sha256,
            request_id: &input.authority_read_request_id,
        },
    )
    .await
    {
        Ok(readback) => readback,
        Err(error) => {
            worker::console_error!(
                "Placement Authority acknowledgement readback failed: {}",
                error.code()
            );
            let status = match error {
                crate::shard_placement_authority_client::AuthorityClientError::Disabled => 404,
                crate::shard_placement_authority_client::AuthorityClientError::Timeout => 504,
                _ => 503,
            };
            return no_store(envelope_error_response(
                status,
                "Shard placement Authority exact readback is unavailable",
            ));
        }
    };
    if !authority_claim_identity_matches(
        &readback.response,
        &application.ticket,
        &application.context,
        &input.authority_claim_digest_sha256,
        &input.authority_claim_owner_sha256,
    ) {
        return no_store(envelope_error_response(
            409,
            "Shard placement Authority claim does not match the execution ticket",
        ));
    }
    let Some(terminal) = exact_operation_four_terminal(
        &readback.response,
        &application,
        &input.authority_activation_terminal_receipt_sha256,
    ) else {
        return no_store(envelope_error_response(
            409,
            "Shard placement Authority activation terminal is not exact",
        ));
    };
    let read_request_id_sha256 = sha256_hex(input.authority_read_request_id.as_bytes());
    let acknowledgement_digest_sha256 = acknowledgement_digest(
        &application,
        &readback,
        terminal,
        &read_request_id_sha256,
        claims.id,
    );
    if let Some(existing) = existing {
        if !stored_ack_matches(
            &existing,
            &application,
            &readback,
            terminal,
            &read_request_id_sha256,
            &acknowledgement_digest_sha256,
            claims.id,
        ) {
            return no_store(envelope_error_response(
                409,
                "Shard placement Authority acknowledgement evidence conflicts",
            ));
        }
        return no_store(envelope_ok_response(&ack_response(
            "exact_replay",
            existing,
        ))?);
    }
    if !fresh_operation_four_terminal(&readback.response, terminal, &application) {
        return no_store(envelope_error_response(
            409,
            "Shard placement Authority activation is not acknowledgeable",
        ));
    }
    if !runtime_flag(&env, WRITE_ENABLED_ENV) {
        return no_store(envelope_error_response(
            404,
            "Shard placement Authority acknowledgement is unavailable",
        ));
    }
    let now = application.context.database_now;
    let acknowledgement = RelayContainerShardPlacementExecutionTicketAuthorityAck {
        ticket_id_sha256: &application.ticket.ticket_id_sha256,
        application_ticket_digest_sha256: &application.ticket.ticket_digest_sha256,
        authority_claim_digest_sha256: &readback.response.snapshot.claim.claim_digest_sha256,
        application_activation_digest_sha256: &application.activation.activation_digest_sha256,
        authority_activation_terminal_receipt_sha256: &terminal.receipt_digest_sha256,
        authority_ledger_head_sha256: &terminal.receipt_digest_sha256,
        authority_database_identity_sha256: &application.ticket.authority_database_identity_sha256,
        authority_version_id: &readback.response.authority_version_id,
        authority_read_credential_id_sha256: &readback.credential_id_sha256,
        authority_read_request_id_sha256: &read_request_id_sha256,
        acknowledgement_digest_sha256: &acknowledgement_digest_sha256,
        acknowledged_by_admin_id: claims.id,
    };
    let audit_params = json!({
        "placement_execution_ticket_id_sha256": application.ticket.ticket_id_sha256,
        "placement_execution_ticket_digest_sha256": application.ticket.ticket_digest_sha256,
        "placement_authorization_id_sha256": application.ticket.authorization_id_sha256,
        "authority_claim_digest_sha256": readback.response.snapshot.claim.claim_digest_sha256,
        "application_activation_digest_sha256":
            application.activation.activation_digest_sha256,
        "authority_activation_terminal_receipt_sha256":
            terminal.receipt_digest_sha256,
        "authority_ledger_head_sha256": terminal.receipt_digest_sha256,
        "authority_version_id": readback.response.authority_version_id,
        "authority_read_request_id_sha256": read_request_id_sha256,
        "acknowledgement_digest_sha256": acknowledgement_digest_sha256,
    });
    let admin_info = admin_audit_info(&claims, &req);
    let admin_audit = admin_audit_log_statement(
        &db,
        None,
        None,
        &claims.username,
        "container_shard_placement_execution_ticket.authority_acknowledged",
        "Acknowledged the exact Authority ticket activation terminal",
        &audit_params,
        &admin_info,
        now,
    )?;
    let stored = match acknowledge_relay_container_shard_placement_execution_ticket_authority(
        &db,
        &acknowledgement,
        admin_audit,
    )
    .await
    {
        Ok(stored) => stored,
        Err(err) => {
            let raced = relay_container_shard_placement_execution_ticket_authority_ack(
                &db,
                &ticket_id_sha256,
            )
            .await
            .ok()
            .flatten();
            if let Some(stored) = raced {
                if stored_ack_matches(
                    &stored,
                    &application,
                    &readback,
                    terminal,
                    &read_request_id_sha256,
                    &acknowledgement_digest_sha256,
                    claims.id,
                ) {
                    return no_store(envelope_ok_response(&ack_response("exact_replay", stored))?);
                }
            }
            worker::console_error!("Placement Authority acknowledgement write failed: {err}");
            return no_store(envelope_error_response(
                409,
                "Shard placement Authority acknowledgement could not be recorded",
            ));
        }
    };
    if !stored_ack_matches(
        &stored,
        &application,
        &readback,
        terminal,
        &read_request_id_sha256,
        &acknowledgement_digest_sha256,
        claims.id,
    ) {
        return no_store(envelope_error_response(
            502,
            "Shard placement Authority acknowledgement readback is invalid",
        ));
    }
    no_store(envelope_ok_response(&ack_response("created", stored))?)
}

fn application_snapshot_matches(
    snapshot: &RelayContainerShardPlacementExecutionTicketActivationReadSnapshot,
    input: &AcknowledgeAuthorityRequest,
    application_database_identity_sha256: &str,
    authority_database_identity_sha256: &str,
    authority_ledger_identity_sha256: &str,
) -> bool {
    let ticket = &snapshot.ticket;
    let activation = &snapshot.activation;
    let context = &snapshot.context;
    ticket.contract_version == 1
        && ticket.ticket_contract == "cinatoken-relay-container-shard-placement-execution-ticket-v1"
        && activation.contract_version == 1
        && activation.activation_contract
            == "cinatoken-relay-container-shard-placement-execution-ticket-activation-v1"
        && ticket.authorization_id_sha256 == input.authorization_id_sha256
        && activation.authority_claim_digest_sha256 == input.authority_claim_digest_sha256
        && activation.activation_digest_sha256 == input.application_activation_digest_sha256
        && ticket.application_database_identity_sha256 == application_database_identity_sha256
        && ticket.authority_database_identity_sha256 == authority_database_identity_sha256
        && ticket.authority_ledger_identity_sha256 == authority_ledger_identity_sha256
        && activation.ticket_id_sha256 == ticket.ticket_id_sha256
        && activation.authority_database_identity_sha256
            == ticket.authority_database_identity_sha256
        && activation.authority_ledger_identity_sha256 == ticket.authority_ledger_identity_sha256
        && activation.authority_activation_operation_id_sha256
            == ticket.activation_operation_id_sha256
        && activation.activated_at >= ticket.prepared_at
        && activation.activated_at < ticket.activation_deadline_at
        && context.campaign_sealed_at.is_none()
        && context.database_now < ticket.activation_deadline_at
        && context.database_now < ticket.execution_deadline_at
        && context.database_now < context.permit_expires_at
        && context.database_now < context.campaign_expires_at
}

fn exact_operation_four_terminal<'a>(
    response: &'a AuthorityExecutionClaimReadResponse,
    application: &RelayContainerShardPlacementExecutionTicketActivationReadSnapshot,
    expected_terminal_sha256: &str,
) -> Option<&'a AuthorityExecutionReceipt> {
    let claim = &response.snapshot.claim;
    let activation = &application.activation;
    let start = response.snapshot.receipts.iter().find(|receipt| {
        receipt.sequence == 2
            && receipt.event_kind == "operation_started"
            && receipt.operation_ordinal == 4
    })?;
    let terminal = response.snapshot.receipts.iter().find(|receipt| {
        receipt.sequence == 3
            && receipt.event_kind == "operation_terminal"
            && receipt.operation_ordinal == 4
    })?;
    let exact = start.claim_digest_sha256 == claim.claim_digest_sha256
        && start.execution_plan_sha256 == claim.execution_plan_sha256
        && start.ledger_identity_sha256 == claim.ledger_identity_sha256
        && start.operation_id_sha256 == application.ticket.activation_operation_id_sha256
        && start.operation_kind == "activate_execution_ticket"
        && start.shard_index.is_none()
        && start.predecessor_receipt_sha256 == claim.claim_acquired_receipt_sha256
        && start.response_sha256.is_empty()
        && start.cloudflare_request_id_sha256.is_empty()
        && start.evidence_sha256 == activation.activation_digest_sha256
        && start.safety_reason.is_none()
        && start.outcome == "pending"
        && start.lease_owner_sha256 == claim.lease_owner_sha256
        && terminal.receipt_digest_sha256 == expected_terminal_sha256
        && terminal.claim_digest_sha256 == claim.claim_digest_sha256
        && terminal.execution_plan_sha256 == claim.execution_plan_sha256
        && terminal.ledger_identity_sha256 == claim.ledger_identity_sha256
        && terminal.operation_id_sha256 == start.operation_id_sha256
        && terminal.operation_kind == start.operation_kind
        && terminal.shard_index.is_none()
        && terminal.predecessor_receipt_sha256 == start.receipt_digest_sha256
        && terminal.request_sha256 == start.request_sha256
        && valid_sha256(&terminal.response_sha256)
        && terminal.cloudflare_request_id_sha256.is_empty()
        && terminal.evidence_sha256 == activation.activation_digest_sha256
        && terminal.safety_reason.is_none()
        && matches!(
            terminal.outcome.as_str(),
            "exact_success" | "ambiguous_recovered" | "exact_replay"
        )
        && terminal.lease_owner_sha256 == start.lease_owner_sha256
        && terminal.lease_token_sha256 == start.lease_token_sha256
        && terminal.lease_generation == start.lease_generation
        && terminal.lease_expires_at == start.lease_expires_at
        && terminal.receipt_credential_id_sha256 == start.receipt_credential_id_sha256
        && terminal.request_id_sha256 == start.request_id_sha256
        && terminal.recorded_at >= start.recorded_at;
    exact.then_some(terminal)
}

fn fresh_operation_four_terminal(
    response: &AuthorityExecutionClaimReadResponse,
    terminal: &AuthorityExecutionReceipt,
    application: &RelayContainerShardPlacementExecutionTicketActivationReadSnapshot,
) -> bool {
    let state = &response.snapshot.state;
    state.status == "running"
        && state.lease_generation == 1
        && state.lease_expires_at > application.context.database_now
        && state.next_operation_ordinal == Some(5)
        && state.active_operation_ordinal.is_none()
        && !state.inflight_readback_only
        && state.receipt_count == 3
        && response.snapshot.receipts.len() == 3
        && state.receipt_head_sha256 == terminal.receipt_digest_sha256
        && !state.controller_enable_intent_recorded
        && state.controller_disabled_verified
        && state.application_activation_digest_sha256.as_deref()
            == Some(application.activation.activation_digest_sha256.as_str())
        && state.ticket_activation_confirmed
        && state.renewal_count == 0
        && state.takeover_count == 0
        && state.terminal_at.is_none()
}

fn acknowledgement_digest(
    application: &RelayContainerShardPlacementExecutionTicketActivationReadSnapshot,
    readback: &ExactExecutionClaimReadback,
    terminal: &AuthorityExecutionReceipt,
    read_request_id_sha256: &str,
    admin_id: i64,
) -> String {
    let admin_id = admin_id.to_string();
    sha256_len_prefixed(
        ACKNOWLEDGEMENT_DIGEST_DOMAIN,
        &[
            ACKNOWLEDGEMENT_CONTRACT,
            &application.ticket.ticket_id_sha256,
            &application.ticket.ticket_digest_sha256,
            &readback.response.snapshot.claim.claim_digest_sha256,
            &application.activation.activation_digest_sha256,
            &terminal.receipt_digest_sha256,
            &terminal.receipt_digest_sha256,
            &application.ticket.authority_database_identity_sha256,
            &readback.response.authority_version_id,
            &readback.credential_id_sha256,
            &admin_id,
            read_request_id_sha256,
        ],
    )
}

fn stored_ack_matches(
    stored: &RelayContainerShardPlacementExecutionTicketAuthorityAckRow,
    application: &RelayContainerShardPlacementExecutionTicketActivationReadSnapshot,
    readback: &ExactExecutionClaimReadback,
    terminal: &AuthorityExecutionReceipt,
    read_request_id_sha256: &str,
    acknowledgement_digest_sha256: &str,
    admin_id: i64,
) -> bool {
    stored.contract_version == 1
        && stored.acknowledgement_contract == ACKNOWLEDGEMENT_CONTRACT
        && stored.ticket_id_sha256 == application.ticket.ticket_id_sha256
        && stored.application_ticket_digest_sha256 == application.ticket.ticket_digest_sha256
        && stored.authority_claim_digest_sha256
            == readback.response.snapshot.claim.claim_digest_sha256
        && stored.application_activation_digest_sha256
            == application.activation.activation_digest_sha256
        && stored.authority_activation_terminal_receipt_sha256 == terminal.receipt_digest_sha256
        && stored.authority_ledger_head_sha256 == terminal.receipt_digest_sha256
        && stored.authority_database_identity_sha256
            == application.ticket.authority_database_identity_sha256
        && stored.authority_version_id == readback.response.authority_version_id
        && stored.authority_read_credential_id_sha256 == readback.credential_id_sha256
        && stored.authority_read_request_id_sha256 == read_request_id_sha256
        && stored.acknowledgement_digest_sha256 == acknowledgement_digest_sha256
        && stored.acknowledged_by_admin_id == admin_id
        && stored.acknowledged_at >= application.activation.activated_at
        && stored.acknowledged_at < application.ticket.activation_deadline_at
}

fn ack_response(
    result: &'static str,
    stored: RelayContainerShardPlacementExecutionTicketAuthorityAckRow,
) -> AcknowledgeAuthorityResponse {
    AcknowledgeAuthorityResponse {
        contract_version: CONTRACT_VERSION,
        acknowledgement_contract: ACKNOWLEDGEMENT_CONTRACT,
        result,
        ticket_id_sha256: stored.ticket_id_sha256,
        application_ticket_digest_sha256: stored.application_ticket_digest_sha256,
        authority_claim_digest_sha256: stored.authority_claim_digest_sha256,
        application_activation_digest_sha256: stored.application_activation_digest_sha256,
        authority_activation_terminal_receipt_sha256: stored
            .authority_activation_terminal_receipt_sha256,
        authority_ledger_head_sha256: stored.authority_ledger_head_sha256,
        authority_version_id: stored.authority_version_id,
        authority_read_request_id_sha256: stored.authority_read_request_id_sha256,
        acknowledgement_digest_sha256: stored.acknowledgement_digest_sha256,
        acknowledged_at: stored.acknowledged_at,
    }
}

async fn read_request(req: &mut Request) -> Result<AcknowledgeAuthorityRequest, Response> {
    let content_type = req
        .headers()
        .get("content-type")
        .ok()
        .flatten()
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if content_type != "application/json" {
        return Err(envelope_error_response(
            415,
            "Shard placement Authority acknowledgement requires application/json",
        ));
    }
    if let Ok(Some(content_length)) = req.headers().get("content-length") {
        if !content_length
            .parse::<usize>()
            .ok()
            .is_some_and(|length| length <= BODY_LIMIT_BYTES)
        {
            return Err(envelope_error_response(
                413,
                "Shard placement Authority acknowledgement body too large",
            ));
        }
    }
    let mut stream = req.stream().map_err(|_| {
        envelope_error_response(
            400,
            "Failed to read shard placement Authority acknowledgement",
        )
    })?;
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| {
            envelope_error_response(
                400,
                "Failed to read shard placement Authority acknowledgement",
            )
        })?;
        if body.len().saturating_add(chunk.len()) > BODY_LIMIT_BYTES {
            return Err(envelope_error_response(
                413,
                "Shard placement Authority acknowledgement body too large",
            ));
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body)
        .map_err(|_| envelope_error_response(400, "Invalid Authority acknowledgement"))
}

fn validate_request(input: &AcknowledgeAuthorityRequest) -> Result<(), &'static str> {
    if input.contract_version != CONTRACT_VERSION {
        return Err("Unsupported shard placement Authority acknowledgement contract");
    }
    if input.expected_environment != "staging" {
        return Err("Invalid shard placement Authority acknowledgement environment");
    }
    for value in [
        &input.authorization_id_sha256,
        &input.authority_claim_digest_sha256,
        &input.authority_claim_owner_sha256,
        &input.application_activation_digest_sha256,
        &input.authority_activation_terminal_receipt_sha256,
    ] {
        if !valid_sha256(value) {
            return Err("Invalid shard placement Authority acknowledgement identity");
        }
    }
    if !valid_identity(&input.authority_read_request_id)
        || !input.confirm_acknowledge
        || input.authority_claim_digest_sha256 == input.application_activation_digest_sha256
        || input.authority_claim_digest_sha256 == input.authority_activation_terminal_receipt_sha256
        || input.application_activation_digest_sha256
            == input.authority_activation_terminal_receipt_sha256
    {
        return Err("Invalid shard placement Authority acknowledgement");
    }
    Ok(())
}

fn sha256_len_prefixed(domain: &[u8], values: &[&str]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    for value in values {
        let bytes = value.as_bytes();
        hasher.update((bytes.len() as u32).to_be_bytes());
        hasher.update(bytes);
    }
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn deployment_environment(env: &Env) -> Option<&'static str> {
    match env.var("ENVIRONMENT").ok()?.to_string().as_str() {
        "staging" => Some("staging"),
        "local" => Some("local"),
        "production" => Some("production"),
        _ => None,
    }
}

fn deployment_identity_sha256(env: &Env, name: &str) -> Option<String> {
    env.var(name)
        .ok()
        .map(|value| value.to_string())
        .filter(|value| valid_sha256(value))
}

fn runtime_flag(env: &Env, name: &str) -> bool {
    env.var(name)
        .ok()
        .is_some_and(|value| value.to_string() == "true")
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_identity(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn no_store(mut response: Response) -> WorkerResult<Response> {
    response.headers_mut().set("Cache-Control", "no-store")?;
    response
        .headers_mut()
        .set("X-Content-Type-Options", "nosniff")?;
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> AcknowledgeAuthorityRequest {
        AcknowledgeAuthorityRequest {
            contract_version: 1,
            expected_environment: "staging".to_string(),
            authorization_id_sha256: "1".repeat(64),
            authority_claim_digest_sha256: "2".repeat(64),
            authority_claim_owner_sha256: "3".repeat(64),
            application_activation_digest_sha256: "4".repeat(64),
            authority_activation_terminal_receipt_sha256: "5".repeat(64),
            authority_read_request_id: "authority-ack-read-1".to_string(),
            confirm_acknowledge: true,
        }
    }

    #[test]
    fn acknowledgement_request_is_strict_and_collision_free() {
        assert!(validate_request(&request()).is_ok());
        let mut invalid = request();
        invalid.confirm_acknowledge = false;
        assert!(validate_request(&invalid).is_err());
        let mut collision = request();
        collision.authority_activation_terminal_receipt_sha256 =
            collision.application_activation_digest_sha256.clone();
        assert!(validate_request(&collision).is_err());
    }

    #[test]
    fn acknowledgement_digest_is_domain_separated_and_ordered() {
        let first = sha256_len_prefixed(
            ACKNOWLEDGEMENT_DIGEST_DOMAIN,
            &[ACKNOWLEDGEMENT_CONTRACT, "ticket", "activation", "terminal"],
        );
        let second = sha256_len_prefixed(
            ACKNOWLEDGEMENT_DIGEST_DOMAIN,
            &[ACKNOWLEDGEMENT_CONTRACT, "ticket", "terminal", "activation"],
        );
        assert!(valid_sha256(&first));
        assert_ne!(first, second);
    }

    #[test]
    fn acknowledgement_source_keeps_gate_audit_and_exact_readback() {
        let source = include_str!("container_shard_placement_authority_ack_admin.rs");
        assert!(
            source.contains("RELAY_CONTAINER_SHARD_PLACEMENT_TICKET_AUTHORITY_ACK_WRITE_ENABLED")
        );
        assert!(source.contains("read_exact_execution_claim"));
        assert!(source.contains("admin_audit_log_statement"));
        assert!(source.contains("authority_activation_terminal_receipt_sha256"));
        assert!(source.contains("Cache-Control\", \"no-store"));
    }
}
