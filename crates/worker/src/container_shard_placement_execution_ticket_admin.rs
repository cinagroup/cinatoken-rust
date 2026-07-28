//! Root-only application-D1 activation of a prepared placement execution ticket.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use worker::{Env, Request, Response, Result as WorkerResult};

use crate::admin::{
    admin_audit_info, envelope_error_response, envelope_ok_response, require_root_auth,
    require_secure_verification,
};
use crate::container_controller::probe as probe_container_controller;
use crate::container_scheduler::container_scheduler_runtime_status;
use crate::d1_repositories::{
    activate_relay_container_shard_placement_execution_ticket, admin_audit_log_statement,
    relay_container_shard_activation_campaign_schema_ready,
    relay_container_shard_placement_execution_ticket,
    relay_container_shard_placement_execution_ticket_activation,
    relay_container_shard_placement_execution_ticket_activation_context,
    RelayContainerShardPlacementExecutionTicketActivation,
    RelayContainerShardPlacementExecutionTicketActivationContextRow,
    RelayContainerShardPlacementExecutionTicketActivationRow,
    RelayContainerShardPlacementExecutionTicketRow,
};
use crate::shard_placement_authority_client::{
    read_exact_execution_claim, AuthorityExecutionClaimReadResponse, AuthorityExecutionOperation,
    AuthorityExecutionReceipt, ExactExecutionClaimQuery, ExactExecutionClaimReadback,
};

const CONTRACT_VERSION: u32 = 1;
const ACTIVATION_CONTRACT: &str =
    "cinatoken-relay-container-shard-placement-execution-ticket-activation-v1";
const ACTIVATION_DIGEST_DOMAIN: &[u8] =
    b"cinatoken:relay-container-shard-placement-execution-ticket-activation:v1\0";
const BODY_LIMIT_BYTES: usize = 4 * 1024;
const WRITE_ENABLED_ENV: &str = "RELAY_CONTAINER_SHARD_PLACEMENT_TICKET_ACTIVATION_WRITE_ENABLED";
const APPLICATION_DATABASE_IDENTITY_ENV: &str =
    "RELAY_CONTAINER_SHARD_APPLICATION_DATABASE_IDENTITY_SHA256";
const AUTHORITY_DATABASE_IDENTITY_ENV: &str =
    "RELAY_CONTAINER_SHARD_AUTHORITY_DATABASE_IDENTITY_SHA256";
const AUTHORITY_LEDGER_IDENTITY_ENV: &str =
    "RELAY_CONTAINER_SHARD_AUTHORITY_LEDGER_IDENTITY_SHA256";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ActivateTicketRequest {
    contract_version: u32,
    expected_environment: String,
    authorization_id_sha256: String,
    authority_claim_digest_sha256: String,
    authority_claim_owner_sha256: String,
    activation_request_id: String,
    confirm_activate: bool,
}

#[derive(Debug, Serialize)]
struct ActivateTicketResponse {
    contract_version: u32,
    activation_contract: &'static str,
    result: &'static str,
    ticket_id_sha256: String,
    ticket_digest_sha256: String,
    authorization_id_sha256: String,
    campaign_id: String,
    authority_claim_digest_sha256: String,
    authority_claim_acquired_receipt_sha256: String,
    authority_version_id: String,
    activation_request_id_sha256: String,
    activation_digest_sha256: String,
    activated_at: i64,
}

pub async fn activate(
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
    let environment = match deployment_environment(&env) {
        Some(value) => value,
        None => {
            return no_store(envelope_error_response(
                503,
                "Container deployment environment is invalid",
            ));
        }
    };
    if environment != "staging" || input.expected_environment != environment {
        return no_store(envelope_error_response(
            404,
            "Shard placement execution ticket activation is unavailable",
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
            worker::console_error!("Placement execution ticket activation: D1 unavailable: {err}");
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
            worker::console_error!("Placement execution ticket schema probe failed: {err}");
            return no_store(envelope_error_response(
                503,
                "Shard placement execution ticket ledger is unavailable",
            ));
        }
    }
    let ticket =
        match relay_container_shard_placement_execution_ticket(&db, &ticket_id_sha256).await {
            Ok(Some(ticket)) => ticket,
            Ok(None) => {
                return no_store(envelope_error_response(
                    404,
                    "Shard placement execution ticket was not found",
                ));
            }
            Err(err) => {
                worker::console_error!("Placement execution ticket read failed: {err}");
                return no_store(envelope_error_response(
                    503,
                    "Shard placement execution ticket ledger is unavailable",
                ));
            }
        };
    let context = match relay_container_shard_placement_execution_ticket_activation_context(
        &db,
        &ticket_id_sha256,
    )
    .await
    {
        Ok(Some(context)) => context,
        Ok(None) => {
            return no_store(envelope_error_response(
                409,
                "Shard placement execution ticket predecessor is missing",
            ));
        }
        Err(err) => {
            worker::console_error!("Placement execution ticket context read failed: {err}");
            return no_store(envelope_error_response(
                503,
                "Shard placement execution ticket ledger is unavailable",
            ));
        }
    };
    if !ticket_context_matches(
        &ticket,
        &context,
        &input,
        &application_database_identity_sha256,
        &authority_database_identity_sha256,
        &authority_ledger_identity_sha256,
    ) {
        return no_store(envelope_error_response(
            409,
            "Shard placement execution ticket identity changed",
        ));
    }
    let existing =
        match relay_container_shard_placement_execution_ticket_activation(&db, &ticket_id_sha256)
            .await
        {
            Ok(existing) => existing,
            Err(err) => {
                worker::console_error!("Placement execution ticket activation read failed: {err}");
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
            request_id: &input.activation_request_id,
        },
    )
    .await
    {
        Ok(readback) => readback,
        Err(error) => {
            worker::console_error!(
                "Placement execution ticket Authority read failed: {}",
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
        &ticket,
        &context,
        &input.authority_claim_digest_sha256,
        &input.authority_claim_owner_sha256,
    ) {
        return no_store(envelope_error_response(
            409,
            "Shard placement Authority claim does not match the execution ticket",
        ));
    }

    let activation_request_id_sha256 = sha256_hex(input.activation_request_id.as_bytes());
    if let Some(existing) = existing {
        if !stored_activation_matches(
            &existing,
            &ticket,
            &readback.response,
            &activation_request_id_sha256,
            claims.id,
        ) {
            return no_store(envelope_error_response(
                409,
                "Shard placement execution ticket has conflicting activation evidence",
            ));
        }
        return no_store(envelope_ok_response(&ActivateTicketResponse {
            contract_version: CONTRACT_VERSION,
            activation_contract: ACTIVATION_CONTRACT,
            result: "exact_replay",
            ticket_id_sha256: ticket.ticket_id_sha256,
            ticket_digest_sha256: ticket.ticket_digest_sha256,
            authorization_id_sha256: ticket.authorization_id_sha256,
            campaign_id: ticket.campaign_id,
            authority_claim_digest_sha256: existing.authority_claim_digest_sha256,
            authority_claim_acquired_receipt_sha256: existing
                .authority_claim_acquired_receipt_sha256,
            authority_version_id: existing.authority_version_id,
            activation_request_id_sha256: existing.activation_request_id_sha256,
            activation_digest_sha256: existing.activation_digest_sha256,
            activated_at: existing.activated_at,
        })?);
    }

    if !runtime_flag(&env, WRITE_ENABLED_ENV) {
        return no_store(envelope_error_response(
            404,
            "Shard placement execution ticket activation is unavailable",
        ));
    }
    let now = context.database_now;
    if !authority_claim_is_activatable(&readback.response, &ticket, &context, now) {
        return no_store(envelope_error_response(
            409,
            "Shard placement Authority claim is not activatable",
        ));
    }
    let runtime = container_scheduler_runtime_status(&env);
    if !runtime.valid
        || runtime.ring_generation as i64 != ticket.ring_generation
        || i64::from(runtime.shard_count) != ticket.shard_count
    {
        return no_store(envelope_error_response(
            409,
            "Container shard ring changed before ticket activation",
        ));
    }
    let controller = probe_container_controller(&env, runtime).await;
    if !controller.verified {
        return no_store(envelope_error_response(
            503,
            "Container Controller status is not verified",
        ));
    }
    if controller.controller_enabled
        || controller.execution_enabled
        || !controller.all_action_gates_false
        || controller.shard_activation_write_enabled
        || controller.shard_activation_candidate_build_configured
        || controller.shard_placement_attestation_write_enabled
        || controller.shard_placement_attestation_staging_verified
        || controller.controller_version_id.as_deref()
            != Some(ticket.controller_enabled_version_id.as_str())
        || controller.action_gate_inventory_sha256.as_deref()
            != Some(ticket.action_gate_inventory_sha256.as_str())
    {
        return no_store(envelope_error_response(
            409,
            "Container Controller changed before ticket activation",
        ));
    }

    let activation_digest_sha256 = placement_execution_ticket_activation_digest(
        &ticket,
        &readback,
        &activation_request_id_sha256,
        claims.id,
    );
    let claim = &readback.response.snapshot.claim;
    let activation = RelayContainerShardPlacementExecutionTicketActivation {
        ticket_id_sha256: &ticket.ticket_id_sha256,
        authority_claim_digest_sha256: &claim.claim_digest_sha256,
        authority_claim_acquired_receipt_sha256: &claim.claim_acquired_receipt_sha256,
        authority_claim_operation_id_sha256: &claim.claim_operation_id_sha256,
        authority_activation_operation_id_sha256: &ticket.activation_operation_id_sha256,
        authority_database_identity_sha256: &claim.authority_database_identity_sha256,
        authority_ledger_identity_sha256: &claim.ledger_identity_sha256,
        authority_version_id: &readback.response.authority_version_id,
        activation_credential_id_sha256: &readback.credential_id_sha256,
        activation_request_id_sha256: &activation_request_id_sha256,
        activation_digest_sha256: &activation_digest_sha256,
        activated_by_admin_id: claims.id,
    };
    let audit_params = json!({
        "placement_execution_ticket_id_sha256": ticket.ticket_id_sha256,
        "placement_execution_ticket_digest_sha256": ticket.ticket_digest_sha256,
        "placement_authorization_id_sha256": ticket.authorization_id_sha256,
        "campaign_id": ticket.campaign_id,
        "authority_claim_digest_sha256": claim.claim_digest_sha256,
        "authority_claim_acquired_receipt_sha256":
            claim.claim_acquired_receipt_sha256,
        "authority_version_id": readback.response.authority_version_id,
        "activation_request_id_sha256": activation_request_id_sha256,
        "activation_digest_sha256": activation_digest_sha256,
    });
    let admin_info = admin_audit_info(&claims, &req);
    let admin_audit = admin_audit_log_statement(
        &db,
        None,
        None,
        &claims.username,
        "container_shard_placement_execution_ticket.activated",
        "Activated a prepared Container shard placement execution ticket",
        &audit_params,
        &admin_info,
        now,
    )?;
    let stored = match activate_relay_container_shard_placement_execution_ticket(
        &db,
        &activation,
        admin_audit,
    )
    .await
    {
        Ok(stored) => stored,
        Err(err) => {
            let raced =
                relay_container_shard_placement_execution_ticket_activation(&db, &ticket_id_sha256)
                    .await
                    .ok()
                    .flatten();
            if let Some(stored) = raced {
                if stored_activation_matches(
                    &stored,
                    &ticket,
                    &readback.response,
                    &activation_request_id_sha256,
                    claims.id,
                ) {
                    return no_store(envelope_ok_response(&activation_response(
                        "exact_replay",
                        &ticket,
                        stored,
                    ))?);
                }
            }
            worker::console_error!("Placement execution ticket activation write failed: {err}");
            return no_store(envelope_error_response(
                409,
                "Shard placement execution ticket could not be activated",
            ));
        }
    };
    if !stored_activation_matches(
        &stored,
        &ticket,
        &readback.response,
        &activation_request_id_sha256,
        claims.id,
    ) {
        worker::console_error!("Placement execution ticket activation readback is invalid");
        return no_store(envelope_error_response(
            502,
            "Shard placement execution ticket activation readback is invalid",
        ));
    }
    worker::console_log!(
        "{}",
        json!({
            "event": "relay_container_shard_placement_execution_ticket_activated",
            "admin_id": claims.id,
            "ticket_id_sha256": stored.ticket_id_sha256,
            "authority_claim_digest_sha256": stored.authority_claim_digest_sha256,
            "authority_version_id": stored.authority_version_id,
            "activation_request_id_sha256": stored.activation_request_id_sha256,
            "activation_digest_sha256": stored.activation_digest_sha256,
            "activated_at": stored.activated_at,
        })
    );
    no_store(envelope_ok_response(&activation_response(
        "created", &ticket, stored,
    ))?)
}

fn activation_response(
    result: &'static str,
    ticket: &RelayContainerShardPlacementExecutionTicketRow,
    activation: RelayContainerShardPlacementExecutionTicketActivationRow,
) -> ActivateTicketResponse {
    ActivateTicketResponse {
        contract_version: CONTRACT_VERSION,
        activation_contract: ACTIVATION_CONTRACT,
        result,
        ticket_id_sha256: ticket.ticket_id_sha256.clone(),
        ticket_digest_sha256: ticket.ticket_digest_sha256.clone(),
        authorization_id_sha256: ticket.authorization_id_sha256.clone(),
        campaign_id: ticket.campaign_id.clone(),
        authority_claim_digest_sha256: activation.authority_claim_digest_sha256,
        authority_claim_acquired_receipt_sha256: activation.authority_claim_acquired_receipt_sha256,
        authority_version_id: activation.authority_version_id,
        activation_request_id_sha256: activation.activation_request_id_sha256,
        activation_digest_sha256: activation.activation_digest_sha256,
        activated_at: activation.activated_at,
    }
}

async fn read_request(req: &mut Request) -> Result<ActivateTicketRequest, Response> {
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
            "Shard placement execution ticket activation requires application/json",
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
                "Shard placement execution ticket activation body too large",
            ));
        }
    }
    let mut stream = req.stream().map_err(|_| {
        envelope_error_response(
            400,
            "Failed to read shard placement execution ticket activation",
        )
    })?;
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| {
            envelope_error_response(
                400,
                "Failed to read shard placement execution ticket activation",
            )
        })?;
        if body.len().saturating_add(chunk.len()) > BODY_LIMIT_BYTES {
            return Err(envelope_error_response(
                413,
                "Shard placement execution ticket activation body too large",
            ));
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| {
        envelope_error_response(400, "Invalid shard placement execution ticket activation")
    })
}

fn validate_request(input: &ActivateTicketRequest) -> Result<(), &'static str> {
    if input.contract_version != CONTRACT_VERSION {
        return Err("Unsupported shard placement execution ticket activation contract");
    }
    if input.expected_environment != "staging" {
        return Err("Invalid shard placement execution ticket activation environment");
    }
    if !valid_sha256(&input.authorization_id_sha256)
        || !valid_sha256(&input.authority_claim_digest_sha256)
        || !valid_sha256(&input.authority_claim_owner_sha256)
        || !valid_identity(&input.activation_request_id)
        || input.authorization_id_sha256 == input.authority_claim_digest_sha256
        || input.authority_claim_digest_sha256 == input.authority_claim_owner_sha256
    {
        return Err("Invalid shard placement Authority claim identity");
    }
    if !input.confirm_activate {
        return Err("Shard placement execution ticket activation is not confirmed");
    }
    Ok(())
}

fn ticket_context_matches(
    ticket: &RelayContainerShardPlacementExecutionTicketRow,
    context: &RelayContainerShardPlacementExecutionTicketActivationContextRow,
    input: &ActivateTicketRequest,
    application_database_identity_sha256: &str,
    authority_database_identity_sha256: &str,
    authority_ledger_identity_sha256: &str,
) -> bool {
    ticket.contract_version == 1
        && ticket.ticket_contract == "cinatoken-relay-container-shard-placement-execution-ticket-v1"
        && ticket.authorization_id_sha256 == input.authorization_id_sha256
        && ticket.application_database_identity_sha256 == application_database_identity_sha256
        && ticket.authority_database_identity_sha256 == authority_database_identity_sha256
        && ticket.authority_ledger_identity_sha256 == authority_ledger_identity_sha256
        && ticket.environment == "staging"
        && ticket.action_gate_count == 22
        && ticket.all_action_gates_false == 1
        && ticket.shard_count == 8
        && context.campaign_expires_at == ticket.execution_deadline_at
}

fn authority_claim_identity_matches(
    response: &AuthorityExecutionClaimReadResponse,
    ticket: &RelayContainerShardPlacementExecutionTicketRow,
    context: &RelayContainerShardPlacementExecutionTicketActivationContextRow,
    expected_claim_digest_sha256: &str,
    expected_claim_owner_sha256: &str,
) -> bool {
    let snapshot = &response.snapshot;
    let claim = &snapshot.claim;
    response.result == "exact_execution_claim"
        && valid_version_id(&response.authority_version_id)
        && snapshot.schema_version == 1
        && snapshot.contract == "cinatoken-relay-container-shard-placement-execution-snapshot-v1"
        && claim.claim_scope == "staging-controller-placement-v1"
        && claim.authorization_id_sha256 == ticket.authorization_id_sha256
        && claim.permit_subject_digest_sha256 == ticket.permit_subject_digest_sha256
        && claim.execution_nonce_sha256 == ticket.execution_nonce_sha256
        && claim.application_ticket_id_sha256 == ticket.ticket_id_sha256
        && claim.application_ticket_digest_sha256 == ticket.ticket_digest_sha256
        && claim.application_database_identity_sha256 == ticket.application_database_identity_sha256
        && claim.authority_database_identity_sha256 == ticket.authority_database_identity_sha256
        && claim.campaign_id == ticket.campaign_id
        && claim.campaign_nonce_sha256 == context.campaign_nonce_sha256
        && claim.execution_plan_sha256 == ticket.execution_plan_sha256
        && claim.release_sha256 == ticket.release_sha256
        && claim.publication_sha256 == ticket.publication_sha256
        && claim.execution_activation_sha256 == ticket.execution_activation_sha256
        && claim.runner_build_sha256 == ticket.runner_build_sha256
        && claim.claim_owner_sha256 == expected_claim_owner_sha256
        && claim.ledger_identity_sha256 == ticket.authority_ledger_identity_sha256
        && claim.preparation_operation_id_sha256 == ticket.preparation_operation_id_sha256
        && claim.claim_operation_id_sha256 == ticket.claim_operation_id_sha256
        && claim.operation_schedule_sha256 == ticket.operation_schedule_sha256
        && claim.claim_digest_sha256 == expected_claim_digest_sha256
        && valid_sha256(&claim.claim_acquired_receipt_sha256)
        && claim.permit_expires_at == context.permit_expires_at
        && claim.normal_deadline_at == ticket.execution_deadline_at
        && claim.generated_at > 0
        && claim.claimed_at >= claim.generated_at
        && exact_operation_schedule(&snapshot.operations, ticket)
        && acquisition_receipt_matches(&snapshot.receipts, claim)
}

fn authority_claim_is_activatable(
    response: &AuthorityExecutionClaimReadResponse,
    ticket: &RelayContainerShardPlacementExecutionTicketRow,
    context: &RelayContainerShardPlacementExecutionTicketActivationContextRow,
    now: i64,
) -> bool {
    let state = &response.snapshot.state;
    let claim = &response.snapshot.claim;
    context.campaign_sealed_at.is_none()
        && ticket.prepared_at <= now
        && now < ticket.activation_deadline_at
        && now < ticket.execution_deadline_at
        && now < context.permit_expires_at
        && now < context.campaign_expires_at
        && claim.claimed_at <= now.saturating_add(5)
        && claim.permit_expires_at > now
        && claim.normal_deadline_at > now
        && state.status == "claimed"
        && state.lease_generation == 1
        && state.lease_expires_at > now
        && claim.lease_owner_sha256 == claim.claim_owner_sha256
        && state.next_operation_ordinal == Some(4)
        && state.active_operation_ordinal.is_none()
        && !state.inflight_readback_only
        && state.receipt_count == 1
        && response.snapshot.receipts.len() == 1
        && state.receipt_head_sha256 == claim.claim_acquired_receipt_sha256
        && !state.controller_enable_intent_recorded
        && !state.controller_disabled_verified
        && state.application_activation_digest_sha256.is_none()
        && !state.ticket_activation_confirmed
        && state.renewal_count == 0
        && state.takeover_count == 0
        && state.updated_at >= claim.claimed_at
        && state.updated_at <= now.saturating_add(5)
        && state.terminal_at.is_none()
        && response.snapshot.receipts.first().is_some_and(|receipt| {
            receipt.lease_generation == state.lease_generation
                && receipt.lease_expires_at == state.lease_expires_at
        })
}

fn exact_operation_schedule(
    operations: &[AuthorityExecutionOperation],
    ticket: &RelayContainerShardPlacementExecutionTicketRow,
) -> bool {
    if operations.len() != 11 {
        return false;
    }
    operations.iter().enumerate().all(|(index, operation)| {
        let ordinal = index as i64 + 4;
        if operation.ordinal != ordinal || !valid_sha256(&operation.operation_id_sha256) {
            return false;
        }
        match ordinal {
            4 => {
                operation.kind == "activate_execution_ticket"
                    && operation.shard_index.is_none()
                    && operation.operation_id_sha256 == ticket.activation_operation_id_sha256
            }
            5 => {
                operation.kind == "enable_controller_deployment"
                    && operation.shard_index.is_none()
                    && operation.operation_id_sha256 == ticket.controller_enable_operation_id_sha256
            }
            6..=13 => {
                operation.kind == "probe_shard_readiness"
                    && operation.shard_index == Some(ordinal - 6)
            }
            14 => {
                operation.kind == "disable_controller_deployment"
                    && operation.shard_index.is_none()
                    && operation.operation_id_sha256
                        == ticket.controller_disable_operation_id_sha256
            }
            _ => false,
        }
    })
}

fn acquisition_receipt_matches(
    receipts: &[AuthorityExecutionReceipt],
    claim: &crate::shard_placement_authority_client::AuthorityExecutionClaim,
) -> bool {
    receipts.first().is_some_and(|receipt| {
        receipt.sequence == 1
            && receipt.event_kind == "claim_acquired"
            && receipt.claim_digest_sha256 == claim.claim_digest_sha256
            && receipt.execution_plan_sha256 == claim.execution_plan_sha256
            && receipt.ledger_identity_sha256 == claim.ledger_identity_sha256
            && receipt.operation_ordinal == 3
            && receipt.operation_id_sha256 == claim.claim_operation_id_sha256
            && receipt.operation_kind == "create_authority_claim"
            && receipt.shard_index.is_none()
            && receipt.predecessor_receipt_sha256 == claim.baseline_terminal_receipt_sha256
            && receipt.request_sha256 == claim.claim_digest_sha256
            && receipt.response_sha256.is_empty()
            && receipt.cloudflare_request_id_sha256.is_empty()
            && receipt.evidence_sha256 == claim.claim_digest_sha256
            && receipt.safety_reason.is_none()
            && receipt.outcome == "exact_success"
            && receipt.lease_owner_sha256 == claim.claim_owner_sha256
            && receipt.lease_generation == 1
            && receipt.receipt_credential_id_sha256 == claim.claim_credential_id_sha256
            && receipt.request_id_sha256 == claim.claim_request_id_sha256
            && receipt.receipt_digest_sha256 == claim.claim_acquired_receipt_sha256
            && receipt.recorded_at == claim.claimed_at
    })
}

fn placement_execution_ticket_activation_digest(
    ticket: &RelayContainerShardPlacementExecutionTicketRow,
    readback: &ExactExecutionClaimReadback,
    activation_request_id_sha256: &str,
    admin_id: i64,
) -> String {
    let claim = &readback.response.snapshot.claim;
    let admin_id = admin_id.to_string();
    sha256_len_prefixed(
        ACTIVATION_DIGEST_DOMAIN,
        &[
            ACTIVATION_CONTRACT,
            &ticket.ticket_id_sha256,
            &ticket.ticket_digest_sha256,
            &claim.claim_digest_sha256,
            &claim.claim_acquired_receipt_sha256,
            &claim.claim_operation_id_sha256,
            &ticket.activation_operation_id_sha256,
            &ticket.application_database_identity_sha256,
            &claim.authority_database_identity_sha256,
            &claim.ledger_identity_sha256,
            &readback.response.authority_version_id,
            &readback.credential_id_sha256,
            &admin_id,
            activation_request_id_sha256,
        ],
    )
}

fn stored_activation_matches(
    activation: &RelayContainerShardPlacementExecutionTicketActivationRow,
    ticket: &RelayContainerShardPlacementExecutionTicketRow,
    response: &AuthorityExecutionClaimReadResponse,
    activation_request_id_sha256: &str,
    admin_id: i64,
) -> bool {
    let claim = &response.snapshot.claim;
    let admin_id_string = admin_id.to_string();
    let expected_digest = sha256_len_prefixed(
        ACTIVATION_DIGEST_DOMAIN,
        &[
            ACTIVATION_CONTRACT,
            &ticket.ticket_id_sha256,
            &ticket.ticket_digest_sha256,
            &claim.claim_digest_sha256,
            &claim.claim_acquired_receipt_sha256,
            &claim.claim_operation_id_sha256,
            &ticket.activation_operation_id_sha256,
            &ticket.application_database_identity_sha256,
            &claim.authority_database_identity_sha256,
            &claim.ledger_identity_sha256,
            &activation.authority_version_id,
            &activation.activation_credential_id_sha256,
            &admin_id_string,
            activation_request_id_sha256,
        ],
    );
    activation.contract_version == 1
        && activation.activation_contract == ACTIVATION_CONTRACT
        && activation.ticket_id_sha256 == ticket.ticket_id_sha256
        && activation.authority_claim_digest_sha256 == claim.claim_digest_sha256
        && activation.authority_claim_acquired_receipt_sha256 == claim.claim_acquired_receipt_sha256
        && activation.authority_claim_operation_id_sha256 == claim.claim_operation_id_sha256
        && activation.authority_activation_operation_id_sha256
            == ticket.activation_operation_id_sha256
        && activation.authority_database_identity_sha256 == claim.authority_database_identity_sha256
        && activation.authority_ledger_identity_sha256 == claim.ledger_identity_sha256
        && activation.authority_version_id == response.authority_version_id
        && valid_sha256(&activation.activation_credential_id_sha256)
        && activation.activation_request_id_sha256 == activation_request_id_sha256
        && activation.activation_digest_sha256 == expected_digest
        && activation.activated_by_admin_id == admin_id
        && activation.activated_at >= ticket.prepared_at
        && activation.activated_at < ticket.activation_deadline_at
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

fn valid_version_id(value: &str) -> bool {
    valid_identity(value)
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
    use crate::shard_placement_authority_client::{
        AuthorityExecutionClaim, AuthorityExecutionSnapshot, AuthorityExecutionState,
    };

    fn digest(byte: char) -> String {
        byte.to_string().repeat(64)
    }

    fn ticket() -> RelayContainerShardPlacementExecutionTicketRow {
        RelayContainerShardPlacementExecutionTicketRow {
            ticket_id_sha256: digest('1'),
            contract_version: 1,
            ticket_contract: "cinatoken-relay-container-shard-placement-execution-ticket-v1"
                .to_string(),
            authorization_id_sha256: digest('2'),
            campaign_id: digest('3'),
            campaign_digest_sha256: digest('4'),
            execution_nonce_sha256: digest('5'),
            permit_subject_digest_sha256: digest('6'),
            application_database_identity_sha256: digest('7'),
            authority_database_identity_sha256: digest('8'),
            authority_ledger_identity_sha256: digest('9'),
            execution_plan_sha256: digest('a'),
            operation_schedule_sha256: digest('b'),
            preparation_operation_id_sha256: digest('c'),
            claim_operation_id_sha256: digest('d'),
            activation_operation_id_sha256: digest('e'),
            controller_enable_operation_id_sha256: digest('f'),
            controller_disable_operation_id_sha256: digest('0'),
            release_sha256: digest('1'),
            publication_sha256: digest('2'),
            execution_activation_sha256: digest('3'),
            runner_build_sha256: digest('4'),
            controller_service_name: "cinatoken-container-controller-staging".to_string(),
            controller_baseline_version_id: "baseline-v1".to_string(),
            controller_enabled_version_id: "enabled-v1".to_string(),
            controller_disabled_version_id: "disabled-v1".to_string(),
            edge_baseline_version_id: "edge-v1".to_string(),
            action_gate_inventory_sha256: digest('5'),
            action_gate_count: 22,
            all_action_gates_false: 1,
            foundation_manifest_sha256: digest('6'),
            runtime_build_id: "runtime-v1".to_string(),
            ring_generation: 1,
            shard_count: 8,
            environment: "staging".to_string(),
            prepared_by_admin_id: 1,
            activation_deadline_at: 1_750_000_100,
            execution_deadline_at: 1_750_000_500,
            ticket_digest_sha256: digest('7'),
            prepared_at: 1_749_999_900,
        }
    }

    fn context() -> RelayContainerShardPlacementExecutionTicketActivationContextRow {
        RelayContainerShardPlacementExecutionTicketActivationContextRow {
            campaign_nonce_sha256: digest('8'),
            permit_expires_at: 1_750_000_500,
            campaign_expires_at: 1_750_000_500,
            campaign_sealed_at: None,
            database_now: 1_750_000_000,
        }
    }

    fn response(
        ticket: &RelayContainerShardPlacementExecutionTicketRow,
    ) -> AuthorityExecutionClaimReadResponse {
        let claim = AuthorityExecutionClaim {
            authorization_id_sha256: ticket.authorization_id_sha256.clone(),
            permit_subject_digest_sha256: ticket.permit_subject_digest_sha256.clone(),
            execution_nonce_sha256: ticket.execution_nonce_sha256.clone(),
            application_ticket_id_sha256: ticket.ticket_id_sha256.clone(),
            application_ticket_digest_sha256: ticket.ticket_digest_sha256.clone(),
            application_database_identity_sha256: ticket
                .application_database_identity_sha256
                .clone(),
            authority_database_identity_sha256: ticket.authority_database_identity_sha256.clone(),
            campaign_id: ticket.campaign_id.clone(),
            campaign_nonce_sha256: context().campaign_nonce_sha256,
            claim_scope: "staging-controller-placement-v1".to_string(),
            execution_plan_sha256: ticket.execution_plan_sha256.clone(),
            release_sha256: ticket.release_sha256.clone(),
            publication_sha256: ticket.publication_sha256.clone(),
            execution_activation_sha256: ticket.execution_activation_sha256.clone(),
            runner_build_sha256: ticket.runner_build_sha256.clone(),
            claim_owner_sha256: digest('a'),
            lease_owner_sha256: digest('a'),
            ledger_identity_sha256: ticket.authority_ledger_identity_sha256.clone(),
            baseline_operation_id_sha256: digest('b'),
            baseline_terminal_receipt_sha256: digest('c'),
            preparation_operation_id_sha256: ticket.preparation_operation_id_sha256.clone(),
            claim_operation_id_sha256: ticket.claim_operation_id_sha256.clone(),
            operation_schedule_sha256: ticket.operation_schedule_sha256.clone(),
            claim_credential_id_sha256: digest('d'),
            claim_request_id_sha256: digest('e'),
            claim_digest_sha256: digest('f'),
            claim_acquired_receipt_sha256: digest('0'),
            generated_at: 1_749_999_950,
            permit_expires_at: 1_750_000_500,
            normal_deadline_at: ticket.execution_deadline_at,
            recovery_deadline_at: 1_750_001_100,
            claimed_at: 1_749_999_960,
        };
        let operations = (4..=14)
            .map(|ordinal| AuthorityExecutionOperation {
                ordinal,
                operation_id_sha256: match ordinal {
                    4 => ticket.activation_operation_id_sha256.clone(),
                    5 => ticket.controller_enable_operation_id_sha256.clone(),
                    14 => ticket.controller_disable_operation_id_sha256.clone(),
                    _ => sha256_hex(format!("operation-{ordinal}").as_bytes()),
                },
                kind: match ordinal {
                    4 => "activate_execution_ticket",
                    5 => "enable_controller_deployment",
                    6..=13 => "probe_shard_readiness",
                    14 => "disable_controller_deployment",
                    _ => unreachable!(),
                }
                .to_string(),
                shard_index: (6..=13).contains(&ordinal).then_some(ordinal - 6),
            })
            .collect();
        let receipt = AuthorityExecutionReceipt {
            sequence: 1,
            event_kind: "claim_acquired".to_string(),
            claim_digest_sha256: claim.claim_digest_sha256.clone(),
            execution_plan_sha256: claim.execution_plan_sha256.clone(),
            ledger_identity_sha256: claim.ledger_identity_sha256.clone(),
            operation_ordinal: 3,
            operation_id_sha256: claim.claim_operation_id_sha256.clone(),
            operation_kind: "create_authority_claim".to_string(),
            shard_index: None,
            predecessor_receipt_sha256: claim.baseline_terminal_receipt_sha256.clone(),
            request_sha256: claim.claim_digest_sha256.clone(),
            response_sha256: String::new(),
            cloudflare_request_id_sha256: String::new(),
            evidence_sha256: claim.claim_digest_sha256.clone(),
            safety_reason: None,
            outcome: "exact_success".to_string(),
            lease_owner_sha256: claim.claim_owner_sha256.clone(),
            lease_token_sha256: digest('1'),
            lease_generation: 1,
            lease_expires_at: 1_750_000_060,
            receipt_credential_id_sha256: claim.claim_credential_id_sha256.clone(),
            request_id_sha256: claim.claim_request_id_sha256.clone(),
            receipt_digest_sha256: claim.claim_acquired_receipt_sha256.clone(),
            recorded_at: claim.claimed_at,
        };
        AuthorityExecutionClaimReadResponse {
            result: "exact_execution_claim".to_string(),
            request_id: "activation-request-1".to_string(),
            snapshot: AuthorityExecutionSnapshot {
                schema_version: 1,
                contract: "cinatoken-relay-container-shard-placement-execution-snapshot-v1"
                    .to_string(),
                claim,
                state: AuthorityExecutionState {
                    status: "claimed".to_string(),
                    lease_generation: 1,
                    lease_expires_at: 1_750_000_060,
                    next_operation_ordinal: Some(4),
                    active_operation_ordinal: None,
                    inflight_readback_only: false,
                    receipt_count: 1,
                    receipt_head_sha256: digest('0'),
                    controller_enable_intent_recorded: false,
                    controller_disabled_verified: false,
                    application_activation_digest_sha256: None,
                    ticket_activation_confirmed: false,
                    renewal_count: 0,
                    takeover_count: 0,
                    updated_at: 1_749_999_960,
                    terminal_at: None,
                },
                operations,
                receipts: vec![receipt],
            },
            authority_version_id: "authority-version-v1".to_string(),
        }
    }

    #[test]
    fn exact_authority_claim_matches_the_prepared_ticket() {
        let ticket = ticket();
        assert!(authority_claim_identity_matches(
            &response(&ticket),
            &ticket,
            &context(),
            &digest('f'),
            &digest('a'),
        ));
    }

    #[test]
    fn authority_claim_identity_drift_is_rejected() {
        let ticket = ticket();
        let mut response = response(&ticket);
        response.snapshot.claim.application_ticket_digest_sha256 = digest('9');
        assert!(!authority_claim_identity_matches(
            &response,
            &ticket,
            &context(),
            &digest('f'),
            &digest('a'),
        ));
    }

    #[test]
    fn authority_claim_digest_query_drift_is_rejected() {
        let ticket = ticket();
        assert!(!authority_claim_identity_matches(
            &response(&ticket),
            &ticket,
            &context(),
            &digest('9'),
            &digest('a'),
        ));
    }

    #[test]
    fn only_pristine_operation_four_state_is_activatable() {
        let ticket = ticket();
        let base_context = context();
        let base_response = response(&ticket);
        assert!(authority_claim_is_activatable(
            &base_response,
            &ticket,
            &base_context,
            1_750_000_000,
        ));

        let mut cases = Vec::new();
        let mut response = base_response.clone();
        response.snapshot.state.next_operation_ordinal = Some(5);
        cases.push((response, base_context.clone()));
        let mut response = base_response.clone();
        response.snapshot.state.active_operation_ordinal = Some(4);
        cases.push((response, base_context.clone()));
        let mut response = base_response.clone();
        response.snapshot.state.inflight_readback_only = true;
        cases.push((response, base_context.clone()));
        let mut response = base_response.clone();
        response.snapshot.state.controller_enable_intent_recorded = true;
        cases.push((response, base_context.clone()));
        let mut response = base_response.clone();
        response.snapshot.state.ticket_activation_confirmed = true;
        cases.push((response, base_context.clone()));
        let mut response = base_response.clone();
        response.snapshot.state.renewal_count = 1;
        cases.push((response, base_context.clone()));
        let mut response = base_response.clone();
        response.snapshot.state.takeover_count = 1;
        cases.push((response, base_context.clone()));
        let mut response = base_response.clone();
        response.snapshot.state.lease_expires_at = 1_750_000_000;
        cases.push((response, base_context.clone()));
        let mut response = base_response.clone();
        let duplicate_receipt = response
            .snapshot
            .receipts
            .first()
            .expect("fixture acquisition receipt")
            .clone();
        response.snapshot.receipts.push(duplicate_receipt);
        cases.push((response, base_context.clone()));
        let mut sealed_context = base_context.clone();
        sealed_context.campaign_sealed_at = Some(1_749_999_999);
        cases.push((base_response.clone(), sealed_context));
        let mut expired_context = base_context.clone();
        expired_context.permit_expires_at = 1_750_000_000;
        cases.push((base_response.clone(), expired_context));

        for (response, context) in cases {
            assert!(!authority_claim_is_activatable(
                &response,
                &ticket,
                &context,
                1_750_000_000,
            ));
        }
    }

    #[test]
    fn activation_digest_binds_authority_and_application_identities() {
        let ticket = ticket();
        let response = response(&ticket);
        let readback = ExactExecutionClaimReadback {
            credential_id_sha256: digest('2'),
            response,
        };
        let first =
            placement_execution_ticket_activation_digest(&ticket, &readback, &digest('3'), 7);
        let mut changed = readback.clone();
        changed.response.authority_version_id = "authority-version-v2".to_string();
        assert_ne!(
            first,
            placement_execution_ticket_activation_digest(&ticket, &changed, &digest('3'), 7)
        );
        assert_ne!(
            first,
            placement_execution_ticket_activation_digest(&ticket, &readback, &digest('3'), 8)
        );
    }

    #[test]
    fn stored_activation_replay_requires_exact_request_admin_and_digest() {
        let ticket = ticket();
        let readback = ExactExecutionClaimReadback {
            credential_id_sha256: digest('2'),
            response: response(&ticket),
        };
        let request_id_sha256 = digest('3');
        let admin_id = 7;
        let claim = &readback.response.snapshot.claim;
        let activation_digest_sha256 = placement_execution_ticket_activation_digest(
            &ticket,
            &readback,
            &request_id_sha256,
            admin_id,
        );
        let activation = RelayContainerShardPlacementExecutionTicketActivationRow {
            ticket_id_sha256: ticket.ticket_id_sha256.clone(),
            contract_version: 1,
            activation_contract: ACTIVATION_CONTRACT.to_string(),
            authority_claim_digest_sha256: claim.claim_digest_sha256.clone(),
            authority_claim_acquired_receipt_sha256: claim.claim_acquired_receipt_sha256.clone(),
            authority_claim_operation_id_sha256: claim.claim_operation_id_sha256.clone(),
            authority_activation_operation_id_sha256: ticket.activation_operation_id_sha256.clone(),
            authority_database_identity_sha256: claim.authority_database_identity_sha256.clone(),
            authority_ledger_identity_sha256: claim.ledger_identity_sha256.clone(),
            authority_version_id: readback.response.authority_version_id.clone(),
            activation_credential_id_sha256: readback.credential_id_sha256.clone(),
            activation_request_id_sha256: request_id_sha256.clone(),
            activation_digest_sha256,
            activated_by_admin_id: admin_id,
            activated_at: ticket.prepared_at + 1,
        };
        assert!(stored_activation_matches(
            &activation,
            &ticket,
            &readback.response,
            &request_id_sha256,
            admin_id,
        ));
        assert!(!stored_activation_matches(
            &activation,
            &ticket,
            &readback.response,
            &digest('4'),
            admin_id,
        ));
        assert!(!stored_activation_matches(
            &activation,
            &ticket,
            &readback.response,
            &request_id_sha256,
            admin_id + 1,
        ));
        let mut changed = activation;
        changed.activation_digest_sha256 = digest('5');
        assert!(!stored_activation_matches(
            &changed,
            &ticket,
            &readback.response,
            &request_id_sha256,
            admin_id,
        ));
    }
}
