//! Root-only lifecycle for one-time, candidate-bound shard activation campaigns.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use worker::{Env, Request, Response, Result as WorkerResult};

use crate::admin::{
    admin_audit_info, envelope_error_response, envelope_ok_response, require_root_auth,
    require_secure_verification,
};
use crate::container_controller::probe as probe_container_controller;
use crate::container_scheduler::container_scheduler_runtime_status;
use crate::container_shard_placement_mutation_authorization::{
    verify_shard_placement_mutation_authorization, ExpectedShardPlacementMutationAuthorization,
    ShardPlacementMutationAuthorizationError, ShardPlacementMutationAuthorizationPermit,
    VerifiedShardPlacementMutationAuthorization,
};
use crate::d1_repositories::{
    admin_audit_log_statement, create_relay_container_shard_activation_campaign,
    materialize_expired_relay_container_shard_activation_campaign,
    relay_container_shard_activation_campaign_receipts,
    relay_container_shard_activation_campaign_schema_ready,
    relay_container_shard_activation_campaign_status, RelayContainerShardActivationCampaign,
    RelayContainerShardActivationCampaignReceiptRow,
    RelayContainerShardActivationCampaignStatusRow, RelayContainerShardPlacementExecutionTicket,
    RelayContainerShardPlacementExecutionTicketRow,
    RelayContainerShardPlacementMutationAuthorization,
    RelayContainerShardPlacementMutationAuthorizationRow,
};

const CONTRACT_VERSION: u32 = 1;
const CAMPAIGN_CONTRACT: &str = "cinatoken-relay-container-shard-activation-campaign-v1";
const CAMPAIGN_DIGEST_DOMAIN: &[u8] = b"cinatoken:relay-container-shard-activation-campaign:v1\0";
const ACTIVATION_DIGEST_DOMAIN: &[u8] = b"cinatoken:relay-container-shard-activation:v1\0";
const CONSUMPTION_DIGEST_DOMAIN: &[u8] =
    b"cinatoken:relay-container-shard-activation-campaign-consumption:v1\0";
const EXECUTION_TICKET_DIGEST_DOMAIN: &[u8] =
    b"cinatoken:relay-container-shard-placement-execution-ticket:v1\0";
const CREATE_BODY_LIMIT_BYTES: usize = 8 * 1024;
const MIN_LIFETIME_SECONDS: i64 = 60;
const MAX_LIFETIME_SECONDS: i64 = 3_600;
const MAX_VERSION: i64 = 1_000_000;
const APPLICATION_DATABASE_IDENTITY_ENV: &str =
    "RELAY_CONTAINER_SHARD_APPLICATION_DATABASE_IDENTITY_SHA256";
const AUTHORITY_DATABASE_IDENTITY_ENV: &str =
    "RELAY_CONTAINER_SHARD_AUTHORITY_DATABASE_IDENTITY_SHA256";
const AUTHORITY_LEDGER_IDENTITY_ENV: &str =
    "RELAY_CONTAINER_SHARD_AUTHORITY_LEDGER_IDENTITY_SHA256";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateCampaignRequest {
    contract_version: u32,
    expected_environment: String,
    campaign_id: String,
    campaign_nonce: String,
    authorization_id_sha256: String,
    execution_nonce_sha256: String,
    placement_mutation_authorization: ShardPlacementMutationAuthorizationPermit,
    placement_execution_ticket: PlacementExecutionTicketRequest,
    expected_ring_generation: u64,
    expected_shard_count: u16,
    foundation_manifest_sha256: String,
    runtime_build_id: String,
    shard_contract_version: i64,
    runtime_protocol_version: i64,
    runtime_contract_version: i64,
    activation_generation: i64,
    expires_in_seconds: i64,
    confirm_create: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PlacementExecutionTicketRequest {
    ticket_id_sha256: String,
    execution_plan_sha256: String,
    operation_schedule_sha256: String,
    preparation_operation_id_sha256: String,
    claim_operation_id_sha256: String,
    activation_operation_id_sha256: String,
    controller_enable_operation_id_sha256: String,
    controller_disable_operation_id_sha256: String,
    release_sha256: String,
    publication_sha256: String,
    execution_activation_sha256: String,
    runner_build_sha256: String,
    controller_baseline_version_id: String,
    controller_disabled_version_id: String,
    edge_baseline_version_id: String,
    activation_deadline_in_seconds: i64,
}

#[derive(Debug, Serialize)]
struct CampaignCreateResponse {
    contract_version: u32,
    campaign_contract: &'static str,
    state: &'static str,
    campaign_id: String,
    nonce: String,
    controller_version_id: String,
    action_gate_inventory_sha256: String,
    action_gate_count: i64,
    all_action_gates_false: bool,
    foundation_manifest_sha256: String,
    runtime_build_id: String,
    ring_generation: i64,
    shard_count: i64,
    shard_contract_version: i64,
    runtime_protocol_version: i64,
    runtime_contract_version: i64,
    activation_generation: i64,
    environment: String,
    campaign_digest_sha256: String,
    execution_ticket_id_sha256: String,
    execution_ticket_digest_sha256: String,
    execution_ticket_activation_deadline_at: i64,
    execution_ticket_execution_deadline_at: i64,
    created_at: i64,
    expires_at: i64,
    claimed_shard_count: i64,
    consumed_shard_count: i64,
    sealed_at: Option<i64>,
}

#[derive(Debug, Serialize)]
struct CampaignStatusResponse {
    contract_version: u32,
    campaign_contract: &'static str,
    state: &'static str,
    campaign_id: String,
    controller_version_id: String,
    action_gate_inventory_sha256: String,
    action_gate_count: i64,
    all_action_gates_false: bool,
    foundation_manifest_sha256: String,
    runtime_build_id: String,
    ring_generation: i64,
    shard_count: i64,
    shard_contract_version: i64,
    runtime_protocol_version: i64,
    runtime_contract_version: i64,
    activation_generation: i64,
    environment: String,
    campaign_digest_sha256: String,
    created_at: i64,
    expires_at: i64,
    claimed_shard_count: i64,
    consumed_shard_count: i64,
    seal_reason: Option<String>,
    seal_detail_code: Option<String>,
    last_consumption_digest_sha256: Option<String>,
    sealed_at: Option<i64>,
    receipts: Vec<CampaignReceiptResponse>,
}

#[derive(Debug, Serialize)]
struct CampaignReceiptResponse {
    campaign_id: String,
    shard_index: i64,
    claim_digest_sha256: String,
    probe_id: String,
    campaign_digest_sha256: String,
    controller_version_id: String,
    action_gate_inventory_sha256: String,
    action_gate_count: i64,
    all_action_gates_false: bool,
    foundation_manifest_sha256: String,
    ring_generation: i64,
    shard_count: i64,
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
    readiness_result_sha256: String,
    process_ready: bool,
    runtime_execution_enabled: bool,
    controller_execution_enabled: bool,
    activation_digest_sha256: String,
    consumption_digest_sha256: String,
    readiness_checked_at: i64,
    consumed_at: i64,
}

impl From<RelayContainerShardActivationCampaignReceiptRow> for CampaignReceiptResponse {
    fn from(row: RelayContainerShardActivationCampaignReceiptRow) -> Self {
        Self {
            campaign_id: row.campaign_id,
            shard_index: row.shard_index,
            claim_digest_sha256: row.claim_digest_sha256,
            probe_id: row.probe_id,
            campaign_digest_sha256: row.campaign_digest_sha256,
            controller_version_id: row.controller_version_id,
            action_gate_inventory_sha256: row.action_gate_inventory_sha256,
            action_gate_count: row.action_gate_count,
            all_action_gates_false: row.all_action_gates_false == 1,
            foundation_manifest_sha256: row.foundation_manifest_sha256,
            ring_generation: row.ring_generation,
            shard_count: row.shard_count,
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
            readiness_result_sha256: row.readiness_result_sha256,
            process_ready: row.process_ready == 1,
            runtime_execution_enabled: row.runtime_execution_enabled == 1,
            controller_execution_enabled: row.controller_execution_enabled == 1,
            activation_digest_sha256: row.activation_digest_sha256,
            consumption_digest_sha256: row.consumption_digest_sha256,
            readiness_checked_at: row.readiness_checked_at,
            consumed_at: row.consumed_at,
        }
    }
}

pub async fn create(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_root_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return no_store(response),
    };
    if let Some(response) = require_secure_verification(&req, &env, claims.id).await? {
        return no_store(response);
    }
    let input = match read_create_request(&mut req).await {
        Ok(input) => input,
        Err(response) => return no_store(response),
    };
    if let Err(message) = validate_create_request(&input) {
        return no_store(envelope_error_response(400, message));
    }

    let runtime = container_scheduler_runtime_status(&env);
    if !runtime.valid {
        return no_store(envelope_error_response(
            503,
            "Container shard ring is misconfigured",
        ));
    }
    if input.expected_ring_generation != runtime.ring_generation
        || input.expected_shard_count != runtime.shard_count
    {
        return no_store(envelope_error_response(
            409,
            "Container shard ring changed before campaign creation",
        ));
    }
    let environment = match deployment_environment(&env) {
        Some(environment) => environment,
        None => {
            return no_store(envelope_error_response(
                503,
                "Container deployment environment is invalid",
            ));
        }
    };
    if input.expected_environment != environment {
        return no_store(envelope_error_response(
            409,
            "Container deployment environment changed before campaign creation",
        ));
    }
    if environment != "staging" {
        return no_store(envelope_error_response(
            404,
            "Shard placement mutation authorization is unavailable",
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
    {
        return no_store(envelope_error_response(
            409,
            "Container Controller action gates must all remain disabled",
        ));
    }
    if controller.shard_activation_write_enabled
        || controller.shard_activation_candidate_build_configured
    {
        return no_store(envelope_error_response(
            409,
            "Legacy shard activation writer must remain disabled",
        ));
    }
    if controller.shard_placement_attestation_write_enabled
        || controller.shard_placement_attestation_staging_verified
    {
        return no_store(envelope_error_response(
            409,
            "Shard placement writer must remain disabled during ticket preparation",
        ));
    }
    let Some(controller_version_id) = controller.controller_version_id else {
        return no_store(envelope_error_response(
            503,
            "Container Controller version is unavailable",
        ));
    };
    let Some(action_gate_inventory_sha256) = controller.action_gate_inventory_sha256 else {
        return no_store(envelope_error_response(
            503,
            "Container Controller action gate inventory is unavailable",
        ));
    };

    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(err) => {
            worker::console_error!("Shard activation campaign: D1 unavailable: {err}");
            return no_store(envelope_error_response(
                503,
                "Shard activation campaign ledger is unavailable",
            ));
        }
    };
    match relay_container_shard_activation_campaign_schema_ready(&db).await {
        Ok(true) => {}
        Ok(false) => {
            return no_store(envelope_error_response(
                503,
                "Shard activation campaign schema is not ready",
            ));
        }
        Err(err) => {
            worker::console_error!("Shard activation campaign schema probe failed: {err}");
            return no_store(envelope_error_response(
                503,
                "Shard activation campaign ledger is unavailable",
            ));
        }
    }

    let campaign_id = input.campaign_id.clone();
    let nonce = input.campaign_nonce.clone();
    let campaign_nonce_sha256 = sha256_hex(nonce.as_bytes());
    let created_at = (worker::Date::now().as_millis() / 1_000) as i64;
    let expires_at = created_at.saturating_add(input.expires_in_seconds);
    let verified_authorization = match verify_shard_placement_mutation_authorization(
        &env,
        &input.placement_mutation_authorization,
        &ExpectedShardPlacementMutationAuthorization {
            authorization_id_sha256: &input.authorization_id_sha256,
            execution_nonce_sha256: &input.execution_nonce_sha256,
            campaign_id: &campaign_id,
            campaign_nonce: &nonce,
            controller_version_id: &controller_version_id,
            action_gate_inventory_sha256: &action_gate_inventory_sha256,
            foundation_manifest_sha256: &input.foundation_manifest_sha256,
            runtime_build_id: &input.runtime_build_id,
            ring_generation: runtime.ring_generation,
            shard_count: runtime.shard_count,
            campaign_lifetime_seconds: input.expires_in_seconds,
        },
        created_at,
    ) {
        Ok(verified) => verified,
        Err(error) => {
            let unavailable = matches!(
                error,
                ShardPlacementMutationAuthorizationError::MissingTrust
                    | ShardPlacementMutationAuthorizationError::InvalidTrust
            );
            worker::console_error!(
                "Shard placement mutation authorization rejected: {}",
                error.code()
            );
            return no_store(envelope_error_response(
                if unavailable { 503 } else { 403 },
                if unavailable {
                    "Shard placement mutation authorization verifier is unavailable"
                } else {
                    "Shard placement mutation authorization was rejected"
                },
            ));
        }
    };
    let campaign_digest_sha256 = campaign_digest(&CampaignDigestInput {
        campaign_id: &campaign_id,
        campaign_nonce_sha256: &campaign_nonce_sha256,
        controller_version_id: &controller_version_id,
        action_gate_inventory_sha256: &action_gate_inventory_sha256,
        action_gate_count: 22,
        all_action_gates_false: true,
        foundation_manifest_sha256: &input.foundation_manifest_sha256,
        runtime_build_id: &input.runtime_build_id,
        ring_generation: runtime.ring_generation as i64,
        shard_count: i64::from(runtime.shard_count),
        shard_contract_version: input.shard_contract_version,
        runtime_protocol_version: input.runtime_protocol_version,
        runtime_contract_version: input.runtime_contract_version,
        activation_generation: input.activation_generation,
        environment,
        created_by_admin_id: claims.id,
        created_at,
        expires_at,
    });
    let campaign = RelayContainerShardActivationCampaign {
        campaign_id: &campaign_id,
        campaign_nonce_sha256: &campaign_nonce_sha256,
        controller_version_id: &controller_version_id,
        action_gate_inventory_sha256: &action_gate_inventory_sha256,
        action_gate_count: 22,
        all_action_gates_false: 1,
        foundation_manifest_sha256: &input.foundation_manifest_sha256,
        runtime_build_id: &input.runtime_build_id,
        ring_generation: runtime.ring_generation as i64,
        shard_count: i64::from(runtime.shard_count),
        shard_contract_version: input.shard_contract_version,
        runtime_protocol_version: input.runtime_protocol_version,
        runtime_contract_version: input.runtime_contract_version,
        activation_generation: input.activation_generation,
        environment,
        created_by_admin_id: claims.id,
        campaign_digest_sha256: &campaign_digest_sha256,
        created_at,
        expires_at,
    };
    let authorization = relay_placement_mutation_authorization(
        &verified_authorization,
        &campaign_digest_sha256,
        claims.id,
        expires_at,
    );
    let execution_ticket_activation_deadline_at = created_at.saturating_add(
        input
            .placement_execution_ticket
            .activation_deadline_in_seconds,
    );
    let execution_ticket_digest_sha256 =
        placement_execution_ticket_digest(&PlacementExecutionTicketDigestInput {
            ticket_id_sha256: &input.placement_execution_ticket.ticket_id_sha256,
            authorization_id_sha256: &verified_authorization.authorization_id_sha256,
            campaign_id: &campaign_id,
            campaign_digest_sha256: &campaign_digest_sha256,
            execution_nonce_sha256: &verified_authorization.execution_nonce_sha256,
            permit_subject_digest_sha256: &verified_authorization.subject_digest_sha256,
            application_database_identity_sha256: &application_database_identity_sha256,
            authority_database_identity_sha256: &authority_database_identity_sha256,
            authority_ledger_identity_sha256: &authority_ledger_identity_sha256,
            execution_plan_sha256: &input.placement_execution_ticket.execution_plan_sha256,
            operation_schedule_sha256: &input.placement_execution_ticket.operation_schedule_sha256,
            preparation_operation_id_sha256: &input
                .placement_execution_ticket
                .preparation_operation_id_sha256,
            claim_operation_id_sha256: &input.placement_execution_ticket.claim_operation_id_sha256,
            activation_operation_id_sha256: &input
                .placement_execution_ticket
                .activation_operation_id_sha256,
            controller_enable_operation_id_sha256: &input
                .placement_execution_ticket
                .controller_enable_operation_id_sha256,
            controller_disable_operation_id_sha256: &input
                .placement_execution_ticket
                .controller_disable_operation_id_sha256,
            release_sha256: &input.placement_execution_ticket.release_sha256,
            publication_sha256: &input.placement_execution_ticket.publication_sha256,
            execution_activation_sha256: &input
                .placement_execution_ticket
                .execution_activation_sha256,
            runner_build_sha256: &input.placement_execution_ticket.runner_build_sha256,
            controller_baseline_version_id: &input
                .placement_execution_ticket
                .controller_baseline_version_id,
            controller_enabled_version_id: &controller_version_id,
            controller_disabled_version_id: &input
                .placement_execution_ticket
                .controller_disabled_version_id,
            edge_baseline_version_id: &input.placement_execution_ticket.edge_baseline_version_id,
            action_gate_inventory_sha256: &action_gate_inventory_sha256,
            foundation_manifest_sha256: &input.foundation_manifest_sha256,
            runtime_build_id: &input.runtime_build_id,
            ring_generation: runtime.ring_generation as i64,
            shard_count: i64::from(runtime.shard_count),
            prepared_by_admin_id: claims.id,
            activation_deadline_at: execution_ticket_activation_deadline_at,
            execution_deadline_at: expires_at,
        });
    let execution_ticket = RelayContainerShardPlacementExecutionTicket {
        ticket_id_sha256: &input.placement_execution_ticket.ticket_id_sha256,
        authorization_id_sha256: &verified_authorization.authorization_id_sha256,
        campaign_id: &campaign_id,
        campaign_digest_sha256: &campaign_digest_sha256,
        execution_nonce_sha256: &verified_authorization.execution_nonce_sha256,
        permit_subject_digest_sha256: &verified_authorization.subject_digest_sha256,
        application_database_identity_sha256: &application_database_identity_sha256,
        authority_database_identity_sha256: &authority_database_identity_sha256,
        authority_ledger_identity_sha256: &authority_ledger_identity_sha256,
        execution_plan_sha256: &input.placement_execution_ticket.execution_plan_sha256,
        operation_schedule_sha256: &input.placement_execution_ticket.operation_schedule_sha256,
        preparation_operation_id_sha256: &input
            .placement_execution_ticket
            .preparation_operation_id_sha256,
        claim_operation_id_sha256: &input.placement_execution_ticket.claim_operation_id_sha256,
        activation_operation_id_sha256: &input
            .placement_execution_ticket
            .activation_operation_id_sha256,
        controller_enable_operation_id_sha256: &input
            .placement_execution_ticket
            .controller_enable_operation_id_sha256,
        controller_disable_operation_id_sha256: &input
            .placement_execution_ticket
            .controller_disable_operation_id_sha256,
        release_sha256: &input.placement_execution_ticket.release_sha256,
        publication_sha256: &input.placement_execution_ticket.publication_sha256,
        execution_activation_sha256: &input.placement_execution_ticket.execution_activation_sha256,
        runner_build_sha256: &input.placement_execution_ticket.runner_build_sha256,
        controller_baseline_version_id: &input
            .placement_execution_ticket
            .controller_baseline_version_id,
        controller_enabled_version_id: &controller_version_id,
        controller_disabled_version_id: &input
            .placement_execution_ticket
            .controller_disabled_version_id,
        edge_baseline_version_id: &input.placement_execution_ticket.edge_baseline_version_id,
        action_gate_inventory_sha256: &action_gate_inventory_sha256,
        foundation_manifest_sha256: &input.foundation_manifest_sha256,
        runtime_build_id: &input.runtime_build_id,
        ring_generation: runtime.ring_generation as i64,
        shard_count: i64::from(runtime.shard_count),
        prepared_by_admin_id: claims.id,
        activation_deadline_at: execution_ticket_activation_deadline_at,
        execution_deadline_at: expires_at,
        ticket_digest_sha256: &execution_ticket_digest_sha256,
    };
    let audit_params = json!({
        "campaign_id": &campaign_id,
        "campaign_digest_sha256": &campaign_digest_sha256,
        "placement_authorization_id_sha256":
            &verified_authorization.authorization_id_sha256,
        "placement_authorization_subject_digest_sha256":
            &verified_authorization.subject_digest_sha256,
        "placement_authorization_issuer": &verified_authorization.issuer,
        "placement_authorization_key_id": &verified_authorization.key_id,
        "placement_authorization_signer_spki_sha256":
            &verified_authorization.signer_spki_sha256,
        "placement_authorization_expires_at": verified_authorization.expires_at,
        "placement_execution_ticket_id_sha256":
            &input.placement_execution_ticket.ticket_id_sha256,
        "placement_execution_ticket_digest_sha256":
            &execution_ticket_digest_sha256,
        "placement_execution_ticket_activation_deadline_at":
            execution_ticket_activation_deadline_at,
        "controller_version_id": &controller_version_id,
        "action_gate_inventory_sha256": &action_gate_inventory_sha256,
        "action_gate_count": 22,
        "foundation_manifest_sha256": &input.foundation_manifest_sha256,
        "runtime_build_id": &input.runtime_build_id,
        "ring_generation": runtime.ring_generation,
        "shard_count": runtime.shard_count,
        "expires_at": expires_at,
        "all_action_gates_false": true,
    });
    let admin_info = admin_audit_info(&claims, &req);
    let admin_audit = admin_audit_log_statement(
        &db,
        None,
        None,
        &claims.username,
        "container_shard_activation_campaign.created",
        "Created a one-time Container shard activation campaign",
        &audit_params,
        &admin_info,
        created_at,
    )?;
    let stored = match create_relay_container_shard_activation_campaign(
        &db,
        &campaign,
        &authorization,
        &execution_ticket,
        admin_audit,
    )
    .await
    {
        Ok(stored) => stored,
        Err(err) => {
            worker::console_error!("Shard activation campaign create failed: {err}");
            let message = err.to_string().to_ascii_lowercase();
            let conflict = message.contains("campaign")
                || message.contains("activation")
                || message.contains("unique");
            return no_store(envelope_error_response(
                if conflict { 409 } else { 503 },
                if conflict {
                    "Shard activation candidate already has conflicting evidence"
                } else {
                    "Shard activation campaign ledger is unavailable"
                },
            ));
        }
    };
    if !campaign_status_valid(&stored.campaign)
        || stored.campaign.campaign_nonce_sha256 != campaign_nonce_sha256
        || stored.campaign.campaign_digest_sha256 != campaign_digest_sha256
        || stored.campaign.claimed_shard_count != 0
        || stored.campaign.consumed_shard_count != 0
        || stored.campaign.seal_reason.is_some()
        || !placement_authorization_readback_valid(
            &stored.authorization,
            &verified_authorization,
            &campaign_digest_sha256,
            expires_at,
            claims.id,
            stored.campaign.created_at,
        )
        || !placement_execution_ticket_readback_valid(
            &stored.execution_ticket,
            &execution_ticket,
            stored.campaign.created_at,
        )
    {
        worker::console_error!("Shard activation campaign create readback is invalid");
        return no_store(envelope_error_response(
            502,
            "Shard activation campaign readback is invalid",
        ));
    }
    worker::console_log!(
        "{}",
        json!({
            "event": "relay_container_shard_activation_campaign_created",
            "admin_id": claims.id,
            "campaign_id": stored.campaign.campaign_id,
            "campaign_digest_sha256": stored.campaign.campaign_digest_sha256,
            "placement_authorization_id_sha256":
                stored.authorization.authorization_id_sha256,
            "placement_authorization_subject_digest_sha256":
                stored.authorization.subject_digest_sha256,
            "placement_execution_ticket_id_sha256":
                stored.execution_ticket.ticket_id_sha256,
            "placement_execution_ticket_digest_sha256":
                stored.execution_ticket.ticket_digest_sha256,
            "controller_version_id": stored.campaign.controller_version_id,
            "ring_generation": stored.campaign.ring_generation,
            "shard_count": stored.campaign.shard_count,
            "expires_at": stored.campaign.expires_at,
        })
    );
    let stored_execution_ticket = stored.execution_ticket;
    let stored = stored.campaign;
    no_store(envelope_ok_response(&CampaignCreateResponse {
        contract_version: CONTRACT_VERSION,
        campaign_contract: CAMPAIGN_CONTRACT,
        state: "open",
        campaign_id: stored.campaign_id,
        nonce,
        controller_version_id: stored.controller_version_id,
        action_gate_inventory_sha256: stored.action_gate_inventory_sha256,
        action_gate_count: stored.action_gate_count,
        all_action_gates_false: stored.all_action_gates_false == 1,
        foundation_manifest_sha256: stored.foundation_manifest_sha256,
        runtime_build_id: stored.runtime_build_id,
        ring_generation: stored.ring_generation,
        shard_count: stored.shard_count,
        shard_contract_version: stored.shard_contract_version,
        runtime_protocol_version: stored.runtime_protocol_version,
        runtime_contract_version: stored.runtime_contract_version,
        activation_generation: stored.activation_generation,
        environment: stored.environment,
        campaign_digest_sha256: stored.campaign_digest_sha256,
        execution_ticket_id_sha256: stored_execution_ticket.ticket_id_sha256,
        execution_ticket_digest_sha256: stored_execution_ticket.ticket_digest_sha256,
        execution_ticket_activation_deadline_at: stored_execution_ticket.activation_deadline_at,
        execution_ticket_execution_deadline_at: stored_execution_ticket.execution_deadline_at,
        created_at: stored.created_at,
        expires_at: stored.expires_at,
        claimed_shard_count: stored.claimed_shard_count,
        consumed_shard_count: stored.consumed_shard_count,
        sealed_at: stored.sealed_at,
    })?)
}

pub async fn status(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_root_auth(&req, &env).await? {
        return no_store(response);
    }
    let campaign_id = match campaign_id_query(&req) {
        Ok(campaign_id) => campaign_id,
        Err(message) => return no_store(envelope_error_response(400, message)),
    };
    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(err) => {
            worker::console_error!("Shard activation campaign status: D1 unavailable: {err}");
            return no_store(envelope_error_response(
                503,
                "Shard activation campaign ledger is unavailable",
            ));
        }
    };
    match relay_container_shard_activation_campaign_schema_ready(&db).await {
        Ok(true) => {}
        Ok(false) => {
            return no_store(envelope_error_response(
                503,
                "Shard activation campaign schema is not ready",
            ));
        }
        Err(err) => {
            worker::console_error!("Shard activation campaign schema probe failed: {err}");
            return no_store(envelope_error_response(
                503,
                "Shard activation campaign ledger is unavailable",
            ));
        }
    }
    if let Err(err) =
        materialize_expired_relay_container_shard_activation_campaign(&db, &campaign_id).await
    {
        worker::console_error!(
            "{}",
            json!({
                "event": "relay_container_shard_activation_campaign_expiry_materialization",
                "status": "error",
                "scope": "single_campaign",
                "campaign_id": &campaign_id,
                "error": err.to_string(),
            })
        );
        return no_store(envelope_error_response(
            503,
            "Shard activation campaign ledger is unavailable",
        ));
    }
    let stored = match relay_container_shard_activation_campaign_status(&db, &campaign_id).await {
        Ok(Some(stored)) => stored,
        Ok(None) => {
            return no_store(envelope_error_response(
                404,
                "Shard activation campaign was not found",
            ));
        }
        Err(err) => {
            worker::console_error!("Shard activation campaign status failed: {err}");
            return no_store(envelope_error_response(
                503,
                "Shard activation campaign ledger is unavailable",
            ));
        }
    };
    if !campaign_status_valid(&stored) {
        worker::console_error!("Shard activation campaign status readback is invalid");
        return no_store(envelope_error_response(
            502,
            "Shard activation campaign readback is invalid",
        ));
    }
    let receipt_rows =
        match relay_container_shard_activation_campaign_receipts(&db, &campaign_id).await {
            Ok(receipts) => receipts,
            Err(err) => {
                worker::console_error!("Shard activation campaign receipts failed: {err}");
                return no_store(envelope_error_response(
                    503,
                    "Shard activation campaign ledger is unavailable",
                ));
            }
        };
    if receipt_rows.len() as i64 != stored.consumed_shard_count
        || !campaign_receipts_valid(&receipt_rows, &stored)
    {
        worker::console_error!("Shard activation campaign receipt readback is invalid");
        return no_store(envelope_error_response(
            502,
            "Shard activation campaign readback is invalid",
        ));
    }
    let receipts = receipt_rows
        .into_iter()
        .map(CampaignReceiptResponse::from)
        .collect();
    let now = (worker::Date::now().as_millis() / 1_000) as i64;
    let state = if campaign_promotion_eligible(&stored) {
        "sealed_complete"
    } else {
        match stored.seal_reason.as_deref() {
            Some("complete") => "invalid",
            Some("expired") => "sealed_expired",
            Some("failed") => "sealed_failed",
            Some("aborted") => "sealed_aborted",
            Some(_) => "invalid",
            None if now >= stored.expires_at => "expiry_pending_seal",
            None => "open",
        }
    };
    no_store(envelope_ok_response(&CampaignStatusResponse {
        contract_version: CONTRACT_VERSION,
        campaign_contract: CAMPAIGN_CONTRACT,
        state,
        campaign_id: stored.campaign_id,
        controller_version_id: stored.controller_version_id,
        action_gate_inventory_sha256: stored.action_gate_inventory_sha256,
        action_gate_count: stored.action_gate_count,
        all_action_gates_false: stored.all_action_gates_false == 1,
        foundation_manifest_sha256: stored.foundation_manifest_sha256,
        runtime_build_id: stored.runtime_build_id,
        ring_generation: stored.ring_generation,
        shard_count: stored.shard_count,
        shard_contract_version: stored.shard_contract_version,
        runtime_protocol_version: stored.runtime_protocol_version,
        runtime_contract_version: stored.runtime_contract_version,
        activation_generation: stored.activation_generation,
        environment: stored.environment,
        campaign_digest_sha256: stored.campaign_digest_sha256,
        created_at: stored.created_at,
        expires_at: stored.expires_at,
        claimed_shard_count: stored.claimed_shard_count,
        consumed_shard_count: stored.consumed_shard_count,
        seal_reason: stored.seal_reason,
        seal_detail_code: stored.seal_detail_code,
        last_consumption_digest_sha256: stored.last_consumption_digest_sha256,
        sealed_at: stored.sealed_at,
        receipts,
    })?)
}

async fn read_create_request(req: &mut Request) -> Result<CreateCampaignRequest, Response> {
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
            "Shard activation campaign requires application/json",
        ));
    }
    if let Ok(Some(content_length)) = req.headers().get("content-length") {
        if !content_length
            .parse::<usize>()
            .ok()
            .is_some_and(|length| length <= CREATE_BODY_LIMIT_BYTES)
        {
            return Err(envelope_error_response(
                413,
                "Shard activation campaign request body too large",
            ));
        }
    }
    let mut stream = req.stream().map_err(|_| {
        envelope_error_response(400, "Failed to read shard activation campaign request")
    })?;
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| {
            envelope_error_response(400, "Failed to read shard activation campaign request")
        })?;
        if body.len().saturating_add(chunk.len()) > CREATE_BODY_LIMIT_BYTES {
            return Err(envelope_error_response(
                413,
                "Shard activation campaign request body too large",
            ));
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body)
        .map_err(|_| envelope_error_response(400, "Invalid shard activation campaign request"))
}

fn validate_create_request(input: &CreateCampaignRequest) -> Result<(), &'static str> {
    if input.contract_version != CONTRACT_VERSION {
        return Err("Unsupported shard activation campaign contract");
    }
    if input.expected_environment != "staging" {
        return Err("Invalid shard activation campaign environment");
    }
    if !valid_lower_hex(&input.campaign_id, 64)
        || !valid_lower_hex(&input.campaign_nonce, 64)
        || !valid_lower_hex(&input.authorization_id_sha256, 64)
        || !valid_lower_hex(&input.execution_nonce_sha256, 64)
        || input.authorization_id_sha256 == input.execution_nonce_sha256
    {
        return Err("Invalid shard placement mutation authorization identity");
    }
    let ticket = &input.placement_execution_ticket;
    for value in [
        ticket.ticket_id_sha256.as_str(),
        ticket.execution_plan_sha256.as_str(),
        ticket.operation_schedule_sha256.as_str(),
        ticket.preparation_operation_id_sha256.as_str(),
        ticket.claim_operation_id_sha256.as_str(),
        ticket.activation_operation_id_sha256.as_str(),
        ticket.controller_enable_operation_id_sha256.as_str(),
        ticket.controller_disable_operation_id_sha256.as_str(),
        ticket.release_sha256.as_str(),
        ticket.publication_sha256.as_str(),
        ticket.execution_activation_sha256.as_str(),
        ticket.runner_build_sha256.as_str(),
    ] {
        if !valid_lower_hex(value, 64) {
            return Err("Invalid shard placement execution ticket digest");
        }
    }
    if !valid_controller_version_id(&ticket.controller_baseline_version_id)
        || !valid_controller_version_id(&ticket.controller_disabled_version_id)
        || !valid_controller_version_id(&ticket.edge_baseline_version_id)
        || !(MIN_LIFETIME_SECONDS..=600).contains(&ticket.activation_deadline_in_seconds)
        || ticket.activation_deadline_in_seconds > input.expires_in_seconds
    {
        return Err("Invalid shard placement execution ticket deployment");
    }
    let operation_ids = [
        ticket.preparation_operation_id_sha256.as_str(),
        ticket.claim_operation_id_sha256.as_str(),
        ticket.activation_operation_id_sha256.as_str(),
        ticket.controller_enable_operation_id_sha256.as_str(),
        ticket.controller_disable_operation_id_sha256.as_str(),
    ];
    if operation_ids.iter().copied().collect::<HashSet<_>>().len() != operation_ids.len() {
        return Err("Invalid shard placement execution ticket operation schedule");
    }
    if input.expected_ring_generation == 0 || input.expected_ring_generation > MAX_VERSION as u64 {
        return Err("Invalid shard activation campaign ring generation");
    }
    if input.expected_shard_count == 0 || input.expected_shard_count > 1_024 {
        return Err("Invalid shard activation campaign shard count");
    }
    if !valid_lower_hex(&input.foundation_manifest_sha256, 64)
        || !valid_lower_hex(&input.runtime_build_id, 64)
    {
        return Err("Invalid shard activation campaign artifact digest");
    }
    if input.shard_contract_version != 1
        || !(1..=MAX_VERSION).contains(&input.runtime_protocol_version)
        || !(1..=MAX_VERSION).contains(&input.runtime_contract_version)
        || input.activation_generation != 1
    {
        return Err("Invalid shard activation campaign candidate contract");
    }
    if !(MIN_LIFETIME_SECONDS..=MAX_LIFETIME_SECONDS).contains(&input.expires_in_seconds) {
        return Err("Invalid shard activation campaign lifetime");
    }
    if !input.confirm_create {
        return Err("Shard activation campaign requires confirm_create=true");
    }
    Ok(())
}

fn relay_placement_mutation_authorization<'a>(
    verified: &'a VerifiedShardPlacementMutationAuthorization,
    campaign_digest_sha256: &'a str,
    consumed_by_admin_id: i64,
    campaign_expires_at: i64,
) -> RelayContainerShardPlacementMutationAuthorization<'a> {
    RelayContainerShardPlacementMutationAuthorization {
        authorization_id_sha256: &verified.authorization_id_sha256,
        execution_nonce_sha256: &verified.execution_nonce_sha256,
        campaign_nonce_sha256: &verified.campaign_nonce_sha256,
        subject_digest_sha256: &verified.subject_digest_sha256,
        contract_version: i64::from(verified.schema_version),
        authorization_contract: &verified.contract,
        issuer: &verified.issuer,
        key_id: &verified.key_id,
        signer_spki_sha256: &verified.signer_spki_sha256,
        environment: &verified.environment,
        controller_service_name: &verified.controller_service_name,
        controller_version_id: &verified.controller_version_id,
        action_gate_inventory_sha256: &verified.action_gate_inventory_sha256,
        foundation_manifest_sha256: &verified.foundation_manifest_sha256,
        runtime_build_id: &verified.runtime_build_id,
        ring_generation: verified.ring_generation as i64,
        shard_count: i64::from(verified.shard_count),
        campaign_lifetime_seconds: verified.campaign_lifetime_seconds,
        permit_issued_at: verified.issued_at,
        permit_expires_at: verified.expires_at,
        campaign_id: &verified.campaign_id,
        campaign_digest_sha256,
        campaign_expires_at,
        consumed_by_admin_id,
    }
}

fn placement_authorization_readback_valid(
    row: &RelayContainerShardPlacementMutationAuthorizationRow,
    verified: &VerifiedShardPlacementMutationAuthorization,
    campaign_digest_sha256: &str,
    campaign_expires_at: i64,
    consumed_by_admin_id: i64,
    campaign_created_at: i64,
) -> bool {
    row.authorization_id_sha256 == verified.authorization_id_sha256
        && row.execution_nonce_sha256 == verified.execution_nonce_sha256
        && row.campaign_nonce_sha256 == verified.campaign_nonce_sha256
        && row.subject_digest_sha256 == verified.subject_digest_sha256
        && row.contract_version == i64::from(verified.schema_version)
        && row.authorization_contract == verified.contract
        && row.issuer == verified.issuer
        && row.key_id == verified.key_id
        && row.signer_spki_sha256 == verified.signer_spki_sha256
        && row.environment == verified.environment
        && row.controller_service_name == verified.controller_service_name
        && row.controller_version_id == verified.controller_version_id
        && row.action_gate_inventory_sha256 == verified.action_gate_inventory_sha256
        && row.foundation_manifest_sha256 == verified.foundation_manifest_sha256
        && row.runtime_build_id == verified.runtime_build_id
        && row.ring_generation == verified.ring_generation as i64
        && row.shard_count == i64::from(verified.shard_count)
        && row.campaign_lifetime_seconds == verified.campaign_lifetime_seconds
        && row.permit_issued_at == verified.issued_at
        && row.permit_expires_at == verified.expires_at
        && row.campaign_id == verified.campaign_id
        && row.campaign_digest_sha256 == campaign_digest_sha256
        && row.campaign_expires_at == campaign_expires_at
        && row.consumed_by_admin_id == consumed_by_admin_id
        && row.consumed_at > 0
        && row.consumed_at.abs_diff(campaign_created_at) <= 5
}

fn placement_execution_ticket_readback_valid(
    row: &RelayContainerShardPlacementExecutionTicketRow,
    expected: &RelayContainerShardPlacementExecutionTicket<'_>,
    campaign_created_at: i64,
) -> bool {
    row.ticket_id_sha256 == expected.ticket_id_sha256
        && row.contract_version == 1
        && row.ticket_contract == "cinatoken-relay-container-shard-placement-execution-ticket-v1"
        && row.authorization_id_sha256 == expected.authorization_id_sha256
        && row.campaign_id == expected.campaign_id
        && row.campaign_digest_sha256 == expected.campaign_digest_sha256
        && row.execution_nonce_sha256 == expected.execution_nonce_sha256
        && row.permit_subject_digest_sha256 == expected.permit_subject_digest_sha256
        && row.application_database_identity_sha256 == expected.application_database_identity_sha256
        && row.authority_database_identity_sha256 == expected.authority_database_identity_sha256
        && row.authority_ledger_identity_sha256 == expected.authority_ledger_identity_sha256
        && row.execution_plan_sha256 == expected.execution_plan_sha256
        && row.operation_schedule_sha256 == expected.operation_schedule_sha256
        && row.preparation_operation_id_sha256 == expected.preparation_operation_id_sha256
        && row.claim_operation_id_sha256 == expected.claim_operation_id_sha256
        && row.activation_operation_id_sha256 == expected.activation_operation_id_sha256
        && row.controller_enable_operation_id_sha256
            == expected.controller_enable_operation_id_sha256
        && row.controller_disable_operation_id_sha256
            == expected.controller_disable_operation_id_sha256
        && row.release_sha256 == expected.release_sha256
        && row.publication_sha256 == expected.publication_sha256
        && row.execution_activation_sha256 == expected.execution_activation_sha256
        && row.runner_build_sha256 == expected.runner_build_sha256
        && row.controller_service_name == "cinatoken-container-controller-staging"
        && row.controller_baseline_version_id == expected.controller_baseline_version_id
        && row.controller_enabled_version_id == expected.controller_enabled_version_id
        && row.controller_disabled_version_id == expected.controller_disabled_version_id
        && row.edge_baseline_version_id == expected.edge_baseline_version_id
        && row.action_gate_inventory_sha256 == expected.action_gate_inventory_sha256
        && row.action_gate_count == 22
        && row.all_action_gates_false == 1
        && row.foundation_manifest_sha256 == expected.foundation_manifest_sha256
        && row.runtime_build_id == expected.runtime_build_id
        && row.ring_generation == expected.ring_generation
        && row.shard_count == expected.shard_count
        && row.environment == "staging"
        && row.prepared_by_admin_id == expected.prepared_by_admin_id
        && row.activation_deadline_at == expected.activation_deadline_at
        && row.execution_deadline_at == expected.execution_deadline_at
        && row.ticket_digest_sha256 == expected.ticket_digest_sha256
        && row.prepared_at > 0
        && row.prepared_at.abs_diff(campaign_created_at) <= 5
}

fn campaign_id_query(req: &Request) -> Result<String, &'static str> {
    let url = req
        .url()
        .map_err(|_| "Invalid shard activation campaign URL")?;
    campaign_id_query_from_url(&url)
}

fn campaign_id_query_from_url(url: &url::Url) -> Result<String, &'static str> {
    let mut campaign_id = None;
    let mut seen = HashSet::new();
    for (key, value) in url.query_pairs() {
        if !seen.insert(key.to_string()) {
            return Err("Duplicate shard activation campaign query");
        }
        if key != "campaign_id" {
            return Err("Unsupported shard activation campaign query");
        }
        if !valid_lower_hex(value.as_ref(), 64) {
            return Err("Invalid shard activation campaign ID");
        }
        campaign_id = Some(value.into_owned());
    }
    campaign_id.ok_or("Shard activation campaign ID is required")
}

fn deployment_environment(env: &Env) -> Option<&'static str> {
    match env.var("ENVIRONMENT").ok()?.to_string().as_str() {
        "staging" => Some("staging"),
        "production" | "prod" => Some("production"),
        _ => None,
    }
}

fn campaign_receipts_valid(
    rows: &[RelayContainerShardActivationCampaignReceiptRow],
    campaign: &RelayContainerShardActivationCampaignStatusRow,
) -> bool {
    if rows.len() as i64 != campaign.consumed_shard_count {
        return false;
    }

    let mut previous_shard_index = None;
    let mut claim_digests = HashSet::new();
    let mut probe_ids = HashSet::new();
    let mut activation_digests = HashSet::new();
    let mut consumption_digests = HashSet::new();
    for row in rows {
        if previous_shard_index.is_some_and(|previous| row.shard_index <= previous)
            || row.shard_index < 0
            || row.shard_index >= campaign.shard_count
            || row.campaign_id != campaign.campaign_id
            || !valid_lower_hex(&row.claim_digest_sha256, 64)
            || !valid_lower_hex(&row.probe_id, 64)
            || row.campaign_digest_sha256 != campaign.campaign_digest_sha256
            || row.controller_version_id != campaign.controller_version_id
            || row.action_gate_inventory_sha256 != campaign.action_gate_inventory_sha256
            || row.action_gate_count != 22
            || row.all_action_gates_false != 1
            || row.foundation_manifest_sha256 != campaign.foundation_manifest_sha256
            || row.ring_generation != campaign.ring_generation
            || row.shard_count != campaign.shard_count
            || row.instance_name != format!("cinatoken-relay-shard-v1-{:04}", row.shard_index)
            || row.shard_contract_version != campaign.shard_contract_version
            || row.runtime_protocol_version != campaign.runtime_protocol_version
            || row.runtime_contract_version != campaign.runtime_contract_version
            || row.runtime_build_id != campaign.runtime_build_id
            || row.activation_generation != campaign.activation_generation
            || !(1..=MAX_VERSION).contains(&row.activation_probe_generation)
            || row.environment != campaign.environment
            || row.container_status != "healthy"
            || row.readiness_result_code != "process_ready_execution_disabled"
            || !valid_lower_hex(&row.readiness_result_sha256, 64)
            || row.process_ready != 1
            || row.runtime_execution_enabled != 0
            || row.controller_execution_enabled != 0
            || !valid_lower_hex(&row.activation_digest_sha256, 64)
            || row.activation_digest_sha256 != campaign_receipt_activation_digest(row)
            || !valid_lower_hex(&row.consumption_digest_sha256, 64)
            || row.consumption_digest_sha256 != campaign_consumption_digest(row)
            || row.readiness_checked_at < campaign.created_at
            || row.readiness_checked_at > campaign.expires_at
            || row.consumed_at < row.readiness_checked_at
            || row.consumed_at > campaign.expires_at
            || !claim_digests.insert(row.claim_digest_sha256.as_str())
            || !probe_ids.insert(row.probe_id.as_str())
            || !activation_digests.insert(row.activation_digest_sha256.as_str())
            || !consumption_digests.insert(row.consumption_digest_sha256.as_str())
        {
            return false;
        }
        previous_shard_index = Some(row.shard_index);
    }

    if campaign_promotion_eligible(campaign)
        && !rows
            .iter()
            .enumerate()
            .all(|(index, row)| row.shard_index == index as i64)
    {
        return false;
    }

    let latest = rows
        .iter()
        .max_by_key(|row| (row.consumed_at, row.shard_index));
    match campaign.seal_reason.as_deref() {
        None => campaign.last_consumption_digest_sha256.is_none(),
        Some(reason) => match latest {
            None => campaign.last_consumption_digest_sha256.is_none(),
            Some(latest) => {
                campaign.last_consumption_digest_sha256.as_deref()
                    == Some(latest.consumption_digest_sha256.as_str())
                    && (reason != "complete" || campaign.sealed_at == Some(latest.consumed_at))
            }
        },
    }
}

fn deployment_identity_sha256(env: &Env, name: &str) -> Option<String> {
    let value = env.var(name).ok()?.to_string();
    valid_lower_hex(&value, 64).then_some(value)
}

fn campaign_status_valid(row: &RelayContainerShardActivationCampaignStatusRow) -> bool {
    valid_lower_hex(&row.campaign_id, 64)
        && valid_lower_hex(&row.campaign_nonce_sha256, 64)
        && valid_controller_version_id(&row.controller_version_id)
        && valid_lower_hex(&row.action_gate_inventory_sha256, 64)
        && row.action_gate_count == 22
        && row.all_action_gates_false == 1
        && valid_lower_hex(&row.foundation_manifest_sha256, 64)
        && valid_lower_hex(&row.runtime_build_id, 64)
        && (1..=MAX_VERSION).contains(&row.ring_generation)
        && (1..=1_024).contains(&row.shard_count)
        && row.shard_contract_version == 1
        && (1..=MAX_VERSION).contains(&row.runtime_protocol_version)
        && (1..=MAX_VERSION).contains(&row.runtime_contract_version)
        && row.activation_generation == 1
        && matches!(row.environment.as_str(), "staging" | "production")
        && row.created_by_admin_id > 0
        && valid_lower_hex(&row.campaign_digest_sha256, 64)
        && row.created_at > 0
        && row.expires_at > row.created_at
        && row.expires_at <= row.created_at.saturating_add(MAX_LIFETIME_SECONDS)
        && row.claimed_shard_count >= 0
        && row.claimed_shard_count <= row.shard_count
        && row.consumed_shard_count >= 0
        && row.consumed_shard_count <= row.claimed_shard_count
        && match row.seal_reason.as_deref() {
            None => {
                row.seal_detail_code.is_none()
                    && row.last_consumption_digest_sha256.is_none()
                    && row.sealed_at.is_none()
            }
            Some("complete") => {
                campaign_promotion_eligible(row)
                    && row.seal_detail_code.as_deref() == Some("all_shards_consumed")
                    && row
                        .last_consumption_digest_sha256
                        .as_deref()
                        .is_some_and(|value| valid_lower_hex(value, 64))
                    && row.sealed_at.is_some_and(|value| value > 0)
            }
            Some(reason @ ("failed" | "expired" | "aborted")) => {
                row.consumed_shard_count < row.shard_count
                    && match (reason, row.seal_detail_code.as_deref()) {
                        ("failed", Some("claim_execution_failed" | "readiness_rejected")) => true,
                        ("expired", Some("campaign_expired")) => true,
                        ("aborted", Some("operator_aborted" | "candidate_superseded")) => true,
                        _ => false,
                    }
                    && (reason != "expired"
                        || row.sealed_at.is_some_and(|value| value >= row.expires_at))
                    && (row.consumed_shard_count == 0)
                        == row.last_consumption_digest_sha256.is_none()
                    && row
                        .last_consumption_digest_sha256
                        .as_deref()
                        .map_or(true, |value| valid_lower_hex(value, 64))
                    && row.sealed_at.is_some_and(|value| value > 0)
            }
            _ => false,
        }
        && row.campaign_digest_sha256
            == campaign_digest(&CampaignDigestInput {
                campaign_id: &row.campaign_id,
                campaign_nonce_sha256: &row.campaign_nonce_sha256,
                controller_version_id: &row.controller_version_id,
                action_gate_inventory_sha256: &row.action_gate_inventory_sha256,
                action_gate_count: row.action_gate_count,
                all_action_gates_false: row.all_action_gates_false == 1,
                foundation_manifest_sha256: &row.foundation_manifest_sha256,
                runtime_build_id: &row.runtime_build_id,
                ring_generation: row.ring_generation,
                shard_count: row.shard_count,
                shard_contract_version: row.shard_contract_version,
                runtime_protocol_version: row.runtime_protocol_version,
                runtime_contract_version: row.runtime_contract_version,
                activation_generation: row.activation_generation,
                environment: &row.environment,
                created_by_admin_id: row.created_by_admin_id,
                created_at: row.created_at,
                expires_at: row.expires_at,
            })
}

fn campaign_promotion_eligible(row: &RelayContainerShardActivationCampaignStatusRow) -> bool {
    row.seal_reason.as_deref() == Some("complete")
        && row.seal_detail_code.as_deref() == Some("all_shards_consumed")
        && row.claimed_shard_count == row.shard_count
        && row.consumed_shard_count == row.shard_count
        && row
            .last_consumption_digest_sha256
            .as_deref()
            .is_some_and(|value| valid_lower_hex(value, 64))
        && row.sealed_at.is_some_and(|value| value > 0)
}

struct PlacementExecutionTicketDigestInput<'a> {
    ticket_id_sha256: &'a str,
    authorization_id_sha256: &'a str,
    campaign_id: &'a str,
    campaign_digest_sha256: &'a str,
    execution_nonce_sha256: &'a str,
    permit_subject_digest_sha256: &'a str,
    application_database_identity_sha256: &'a str,
    authority_database_identity_sha256: &'a str,
    authority_ledger_identity_sha256: &'a str,
    execution_plan_sha256: &'a str,
    operation_schedule_sha256: &'a str,
    preparation_operation_id_sha256: &'a str,
    claim_operation_id_sha256: &'a str,
    activation_operation_id_sha256: &'a str,
    controller_enable_operation_id_sha256: &'a str,
    controller_disable_operation_id_sha256: &'a str,
    release_sha256: &'a str,
    publication_sha256: &'a str,
    execution_activation_sha256: &'a str,
    runner_build_sha256: &'a str,
    controller_baseline_version_id: &'a str,
    controller_enabled_version_id: &'a str,
    controller_disabled_version_id: &'a str,
    edge_baseline_version_id: &'a str,
    action_gate_inventory_sha256: &'a str,
    foundation_manifest_sha256: &'a str,
    runtime_build_id: &'a str,
    ring_generation: i64,
    shard_count: i64,
    prepared_by_admin_id: i64,
    activation_deadline_at: i64,
    execution_deadline_at: i64,
}

fn placement_execution_ticket_digest(input: &PlacementExecutionTicketDigestInput<'_>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(EXECUTION_TICKET_DIGEST_DOMAIN);
    for part in [
        "1".to_string(),
        "cinatoken-relay-container-shard-placement-execution-ticket-v1".to_string(),
        input.ticket_id_sha256.to_string(),
        input.authorization_id_sha256.to_string(),
        input.campaign_id.to_string(),
        input.campaign_digest_sha256.to_string(),
        input.execution_nonce_sha256.to_string(),
        input.permit_subject_digest_sha256.to_string(),
        input.application_database_identity_sha256.to_string(),
        input.authority_database_identity_sha256.to_string(),
        input.authority_ledger_identity_sha256.to_string(),
        input.execution_plan_sha256.to_string(),
        input.operation_schedule_sha256.to_string(),
        input.preparation_operation_id_sha256.to_string(),
        input.claim_operation_id_sha256.to_string(),
        input.activation_operation_id_sha256.to_string(),
        input.controller_enable_operation_id_sha256.to_string(),
        input.controller_disable_operation_id_sha256.to_string(),
        input.release_sha256.to_string(),
        input.publication_sha256.to_string(),
        input.execution_activation_sha256.to_string(),
        input.runner_build_sha256.to_string(),
        "cinatoken-container-controller-staging".to_string(),
        input.controller_baseline_version_id.to_string(),
        input.controller_enabled_version_id.to_string(),
        input.controller_disabled_version_id.to_string(),
        input.edge_baseline_version_id.to_string(),
        input.action_gate_inventory_sha256.to_string(),
        "22".to_string(),
        "true".to_string(),
        input.foundation_manifest_sha256.to_string(),
        input.runtime_build_id.to_string(),
        input.ring_generation.to_string(),
        input.shard_count.to_string(),
        "staging".to_string(),
        input.prepared_by_admin_id.to_string(),
        input.activation_deadline_at.to_string(),
        input.execution_deadline_at.to_string(),
    ] {
        hasher.update((part.len() as u32).to_be_bytes());
        hasher.update(part.as_bytes());
    }
    format!("{:x}", hasher.finalize())
}

struct CampaignDigestInput<'a> {
    campaign_id: &'a str,
    campaign_nonce_sha256: &'a str,
    controller_version_id: &'a str,
    action_gate_inventory_sha256: &'a str,
    action_gate_count: i64,
    all_action_gates_false: bool,
    foundation_manifest_sha256: &'a str,
    runtime_build_id: &'a str,
    ring_generation: i64,
    shard_count: i64,
    shard_contract_version: i64,
    runtime_protocol_version: i64,
    runtime_contract_version: i64,
    activation_generation: i64,
    environment: &'a str,
    created_by_admin_id: i64,
    created_at: i64,
    expires_at: i64,
}

fn campaign_digest(input: &CampaignDigestInput<'_>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(CAMPAIGN_DIGEST_DOMAIN);
    for part in [
        input.campaign_id.to_string(),
        input.campaign_nonce_sha256.to_string(),
        input.controller_version_id.to_string(),
        input.action_gate_inventory_sha256.to_string(),
        input.action_gate_count.to_string(),
        input.all_action_gates_false.to_string(),
        input.foundation_manifest_sha256.to_string(),
        input.runtime_build_id.to_string(),
        input.ring_generation.to_string(),
        input.shard_count.to_string(),
        input.shard_contract_version.to_string(),
        input.runtime_protocol_version.to_string(),
        input.runtime_contract_version.to_string(),
        input.activation_generation.to_string(),
        input.environment.to_string(),
        input.created_by_admin_id.to_string(),
        input.created_at.to_string(),
        input.expires_at.to_string(),
    ] {
        hasher.update((part.len() as u32).to_be_bytes());
        hasher.update(part.as_bytes());
    }
    format!("{:x}", hasher.finalize())
}

fn campaign_receipt_activation_digest(
    row: &RelayContainerShardActivationCampaignReceiptRow,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(ACTIVATION_DIGEST_DOMAIN);
    for part in [
        row.controller_version_id.to_string(),
        row.ring_generation.to_string(),
        row.shard_count.to_string(),
        row.shard_index.to_string(),
        row.instance_name.to_string(),
        row.shard_contract_version.to_string(),
        row.runtime_protocol_version.to_string(),
        row.runtime_contract_version.to_string(),
        row.runtime_build_id.to_string(),
        row.activation_generation.to_string(),
        row.activation_probe_generation.to_string(),
        row.environment.to_string(),
        row.container_status.to_string(),
        row.readiness_result_code.to_string(),
        row.process_ready.to_string(),
        row.runtime_execution_enabled.to_string(),
        row.controller_execution_enabled.to_string(),
        row.readiness_checked_at.to_string(),
    ] {
        hasher.update((part.len() as u32).to_be_bytes());
        hasher.update(part.as_bytes());
    }
    format!("{:x}", hasher.finalize())
}

fn campaign_consumption_digest(row: &RelayContainerShardActivationCampaignReceiptRow) -> String {
    let mut hasher = Sha256::new();
    hasher.update(CONSUMPTION_DIGEST_DOMAIN);
    for part in [
        row.campaign_id.as_str(),
        row.campaign_digest_sha256.as_str(),
        row.claim_digest_sha256.as_str(),
        row.activation_digest_sha256.as_str(),
        row.readiness_result_sha256.as_str(),
        &row.readiness_checked_at.to_string(),
    ] {
        hasher.update((part.len() as u32).to_be_bytes());
        hasher.update(part.as_bytes());
    }
    format!("{:x}", hasher.finalize())
}

fn sha256_hex(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}

fn valid_lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_controller_version_id(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'.' | b'_' | b':' | b'-'))
        })
}

fn no_store(mut response: Response) -> WorkerResult<Response> {
    response
        .headers_mut()
        .set("Cache-Control", "no-store, max-age=0")?;
    response.headers_mut().set("Pragma", "no-cache")?;
    response
        .headers_mut()
        .set("X-Content-Type-Options", "nosniff")?;
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn digest_input<'a>() -> CampaignDigestInput<'a> {
        CampaignDigestInput {
            campaign_id: "a9f9f7aa3b8672759a9a7b37b5ee3a093930c3041ef4b741f0e3c824fbf1a477",
            campaign_nonce_sha256:
                "43a2608fbbc98d0c5c2ed3bf30b5bfb7a40f45da1f452c3d70ad485cc4a38130",
            controller_version_id: "controller-version-55",
            action_gate_inventory_sha256:
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            action_gate_count: 22,
            all_action_gates_false: true,
            foundation_manifest_sha256:
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            runtime_build_id: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            ring_generation: 7,
            shard_count: 8,
            shard_contract_version: 1,
            runtime_protocol_version: 1,
            runtime_contract_version: 1,
            activation_generation: 1,
            environment: "staging",
            created_by_admin_id: 42,
            created_at: 1_900_000_000,
            expires_at: 1_900_000_600,
        }
    }

    fn complete_status_row() -> RelayContainerShardActivationCampaignStatusRow {
        let input = digest_input();
        RelayContainerShardActivationCampaignStatusRow {
            campaign_id: input.campaign_id.to_string(),
            campaign_nonce_sha256: input.campaign_nonce_sha256.to_string(),
            controller_version_id: input.controller_version_id.to_string(),
            action_gate_inventory_sha256: input.action_gate_inventory_sha256.to_string(),
            action_gate_count: input.action_gate_count,
            all_action_gates_false: i64::from(input.all_action_gates_false),
            foundation_manifest_sha256: input.foundation_manifest_sha256.to_string(),
            runtime_build_id: input.runtime_build_id.to_string(),
            ring_generation: input.ring_generation,
            shard_count: input.shard_count,
            shard_contract_version: input.shard_contract_version,
            runtime_protocol_version: input.runtime_protocol_version,
            runtime_contract_version: input.runtime_contract_version,
            activation_generation: input.activation_generation,
            environment: input.environment.to_string(),
            created_by_admin_id: input.created_by_admin_id,
            campaign_digest_sha256: campaign_digest(&input),
            created_at: input.created_at,
            expires_at: input.expires_at,
            claimed_shard_count: input.shard_count,
            consumed_shard_count: input.shard_count,
            seal_reason: Some("complete".to_string()),
            seal_detail_code: Some("all_shards_consumed".to_string()),
            last_consumption_digest_sha256: Some("d".repeat(64)),
            sealed_at: Some(input.created_at + 30),
        }
    }

    fn receipt_row(
        campaign: &RelayContainerShardActivationCampaignStatusRow,
        shard_index: i64,
    ) -> RelayContainerShardActivationCampaignReceiptRow {
        let readiness_checked_at = campaign.created_at + 10 + shard_index;
        let mut row = RelayContainerShardActivationCampaignReceiptRow {
            campaign_id: campaign.campaign_id.clone(),
            shard_index,
            claim_digest_sha256: sha256_hex(format!("claim-{shard_index}").as_bytes()),
            probe_id: sha256_hex(format!("probe-{shard_index}").as_bytes()),
            campaign_digest_sha256: campaign.campaign_digest_sha256.clone(),
            controller_version_id: campaign.controller_version_id.clone(),
            action_gate_inventory_sha256: campaign.action_gate_inventory_sha256.clone(),
            action_gate_count: campaign.action_gate_count,
            all_action_gates_false: campaign.all_action_gates_false,
            foundation_manifest_sha256: campaign.foundation_manifest_sha256.clone(),
            ring_generation: campaign.ring_generation,
            shard_count: campaign.shard_count,
            instance_name: format!("cinatoken-relay-shard-v1-{shard_index:04}"),
            shard_contract_version: campaign.shard_contract_version,
            runtime_protocol_version: campaign.runtime_protocol_version,
            runtime_contract_version: campaign.runtime_contract_version,
            runtime_build_id: campaign.runtime_build_id.clone(),
            activation_generation: campaign.activation_generation,
            activation_probe_generation: 1,
            environment: campaign.environment.clone(),
            container_status: "healthy".to_string(),
            readiness_result_code: "process_ready_execution_disabled".to_string(),
            readiness_result_sha256: sha256_hex(format!("readiness-{shard_index}").as_bytes()),
            process_ready: 1,
            runtime_execution_enabled: 0,
            controller_execution_enabled: 0,
            activation_digest_sha256: String::new(),
            consumption_digest_sha256: String::new(),
            readiness_checked_at,
            consumed_at: readiness_checked_at,
        };
        row.activation_digest_sha256 = campaign_receipt_activation_digest(&row);
        row.consumption_digest_sha256 = campaign_consumption_digest(&row);
        row
    }

    #[test]
    fn campaign_digest_is_deterministic_and_candidate_bound() {
        let expected = campaign_digest(&digest_input());
        assert_eq!(
            expected,
            "7500482b4cff400b784f890595abe940ef274fe3ee2f1a0002d7b90f06a351f1"
        );
        assert_eq!(expected, campaign_digest(&digest_input()));
        let mut changed = digest_input();
        changed.runtime_build_id =
            "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
        assert_ne!(expected, campaign_digest(&changed));
    }

    #[test]
    fn creation_contract_and_status_query_are_strict() {
        let valid = CreateCampaignRequest {
            contract_version: 1,
            expected_environment: "staging".to_string(),
            campaign_id: "1".repeat(64),
            campaign_nonce: "2".repeat(64),
            authorization_id_sha256: "3".repeat(64),
            execution_nonce_sha256: "4".repeat(64),
            placement_mutation_authorization: ShardPlacementMutationAuthorizationPermit {
                schema_version: 1,
                contract: "cinatoken-relay-shard-placement-mutation-authorization-v1".to_string(),
                issuer: "placement-authority-staging".to_string(),
                key_id: "placement-v1".to_string(),
                environment: "staging".to_string(),
                authorization_id_sha256: "3".repeat(64),
                execution_nonce_sha256: "4".repeat(64),
                campaign_id: "1".repeat(64),
                campaign_nonce_sha256: sha256_hex("2".repeat(64).as_bytes()),
                controller_service_name: "cinatoken-container-controller-staging".to_string(),
                controller_version_id: "controller-version-55".to_string(),
                action_gate_inventory_sha256: "a".repeat(64),
                foundation_manifest_sha256: "b".repeat(64),
                runtime_build_id: "c".repeat(64),
                ring_generation: 7,
                shard_count: 8,
                campaign_lifetime_seconds: 600,
                issued_at: 1_900_000_000,
                expires_at: 1_900_000_600,
                signature_base64url: "A".repeat(86),
            },
            placement_execution_ticket: PlacementExecutionTicketRequest {
                ticket_id_sha256: "5".repeat(64),
                execution_plan_sha256: "8".repeat(64),
                operation_schedule_sha256: "9".repeat(64),
                preparation_operation_id_sha256: "0a".repeat(32),
                claim_operation_id_sha256: "0b".repeat(32),
                activation_operation_id_sha256: "0c".repeat(32),
                controller_enable_operation_id_sha256: "0d".repeat(32),
                controller_disable_operation_id_sha256: "0e".repeat(32),
                release_sha256: "0f".repeat(32),
                publication_sha256: "10".repeat(32),
                execution_activation_sha256: "11".repeat(32),
                runner_build_sha256: "12".repeat(32),
                controller_baseline_version_id: "controller-disabled-v1".to_string(),
                controller_disabled_version_id: "controller-disabled-v1".to_string(),
                edge_baseline_version_id: "edge-baseline-v1".to_string(),
                activation_deadline_in_seconds: 300,
            },
            expected_ring_generation: 7,
            expected_shard_count: 8,
            foundation_manifest_sha256: "b".repeat(64),
            runtime_build_id: "c".repeat(64),
            shard_contract_version: 1,
            runtime_protocol_version: 1,
            runtime_contract_version: 1,
            activation_generation: 1,
            expires_in_seconds: 600,
            confirm_create: true,
        };
        assert_eq!(validate_create_request(&valid), Ok(()));
        let mut unconfirmed = valid;
        unconfirmed.confirm_create = false;
        assert!(validate_create_request(&unconfirmed).is_err());

        let id = "a".repeat(64);
        let url = url::Url::parse(&format!("https://example.test/api?campaign_id={id}")).unwrap();
        assert_eq!(campaign_id_query_from_url(&url), Ok(id));
        let duplicate = url::Url::parse(&format!(
            "https://example.test/api?campaign_id={}&campaign_id={}",
            "a".repeat(64),
            "b".repeat(64)
        ))
        .unwrap();
        assert!(campaign_id_query_from_url(&duplicate).is_err());
    }

    #[test]
    fn only_complete_n_of_n_campaign_is_promotion_eligible() {
        let complete = complete_status_row();
        assert!(campaign_status_valid(&complete));
        assert!(campaign_promotion_eligible(&complete));

        let mut partial_complete = complete.clone();
        partial_complete.consumed_shard_count -= 1;
        assert!(!campaign_status_valid(&partial_complete));
        assert!(!campaign_promotion_eligible(&partial_complete));

        for (reason, detail, sealed_at) in [
            ("expired", "campaign_expired", complete.expires_at),
            ("failed", "readiness_rejected", complete.created_at + 30),
            ("aborted", "operator_aborted", complete.created_at + 30),
        ] {
            let mut terminal = complete.clone();
            terminal.consumed_shard_count -= 1;
            terminal.seal_reason = Some(reason.to_string());
            terminal.seal_detail_code = Some(detail.to_string());
            terminal.sealed_at = Some(sealed_at);
            assert!(campaign_status_valid(&terminal));
            assert!(!campaign_promotion_eligible(&terminal));
        }
    }

    #[test]
    fn receipts_bind_every_complete_campaign_shard_and_final_seal() {
        let mut campaign = complete_status_row();
        let receipts = (0..campaign.shard_count)
            .map(|shard_index| receipt_row(&campaign, shard_index))
            .collect::<Vec<_>>();
        let latest = receipts.last().unwrap();
        campaign.last_consumption_digest_sha256 = Some(latest.consumption_digest_sha256.clone());
        campaign.sealed_at = Some(latest.consumed_at);

        assert!(campaign_status_valid(&campaign));
        assert!(campaign_receipts_valid(&receipts, &campaign));

        let response = CampaignReceiptResponse::from(receipts[0].clone());
        assert!(response.all_action_gates_false);
        assert!(response.process_ready);
        assert!(!response.runtime_execution_enabled);
        assert!(!response.controller_execution_enabled);

        let mut tampered = receipts.clone();
        tampered[0].readiness_result_sha256 = "f".repeat(64);
        assert!(!campaign_receipts_valid(&tampered, &campaign));

        let mut wrong_seal = campaign.clone();
        wrong_seal.last_consumption_digest_sha256 =
            Some(receipts[0].consumption_digest_sha256.clone());
        assert!(!campaign_receipts_valid(&receipts, &wrong_seal));
    }

    #[test]
    fn open_partial_campaign_receipts_may_have_shard_gaps_without_a_seal_pointer() {
        let mut campaign = complete_status_row();
        campaign.claimed_shard_count = 1;
        campaign.consumed_shard_count = 1;
        campaign.seal_reason = None;
        campaign.seal_detail_code = None;
        campaign.last_consumption_digest_sha256 = None;
        campaign.sealed_at = None;
        let receipt = receipt_row(&campaign, 3);

        assert!(campaign_status_valid(&campaign));
        assert!(campaign_receipts_valid(&[receipt.clone()], &campaign));

        let mut duplicate = receipt;
        duplicate.shard_index = 4;
        duplicate.instance_name = "cinatoken-relay-shard-v1-0004".to_string();
        duplicate.activation_digest_sha256 = campaign_receipt_activation_digest(&duplicate);
        duplicate.consumption_digest_sha256 = campaign_consumption_digest(&duplicate);
        campaign.claimed_shard_count = 2;
        campaign.consumed_shard_count = 2;
        assert!(!campaign_receipts_valid(
            &[duplicate.clone(), duplicate],
            &campaign
        ));
    }

    #[test]
    fn status_materializes_expiry_before_readback_without_controller_probe() {
        let source = include_str!("container_shard_activation_campaign_admin.rs");
        let status_source = source
            .split("pub async fn status")
            .nth(1)
            .unwrap()
            .split("async fn read_create_request")
            .next()
            .unwrap();
        let materialize = status_source
            .find("materialize_expired_relay_container_shard_activation_campaign")
            .unwrap();
        let readback = status_source
            .find("relay_container_shard_activation_campaign_status(&db")
            .unwrap();
        assert!(materialize < readback);
        assert!(!status_source.contains("probe_container_controller"));
    }

    #[test]
    fn source_keeps_nonce_out_of_logs_and_requires_step_up() {
        let source = include_str!("container_shard_activation_campaign_admin.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        assert!(source.contains("require_root_auth(&req, &env)"));
        assert!(source.contains("require_secure_verification(&req, &env, claims.id)"));
        assert!(source.contains("probe_container_controller(&env, runtime)"));
        assert!(source.contains("Cache-Control\", \"no-store, max-age=0"));
        assert!(!source.contains("\"nonce\": nonce"));
        assert!(!source.contains("campaign_nonce_sha256\":"));
    }
}
