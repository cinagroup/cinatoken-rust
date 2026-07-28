//! Private, authenticated exact readback of one application-D1 ticket activation.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use futures_util::StreamExt;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use worker::{Env, Request, Response, Result as WorkerResult, WorkerVersionMetadata};

use crate::d1_repositories::{
    create_relay_container_shard_placement_dispatch_consumption,
    create_relay_container_shard_placement_pre_enable_grant,
    relay_container_shard_placement_dispatch_consumption,
    relay_container_shard_placement_dispatch_consumption_matches,
    relay_container_shard_placement_execution_ticket,
    relay_container_shard_placement_execution_ticket_activation_context,
    relay_container_shard_placement_execution_ticket_activation_read_snapshot,
    relay_container_shard_placement_execution_ticket_authority_ack_read_snapshot,
    relay_container_shard_placement_pre_enable_grant,
    RelayContainerShardPlacementDispatchConsumption,
    RelayContainerShardPlacementDispatchConsumptionCreateOutcome,
    RelayContainerShardPlacementDispatchConsumptionRow,
    RelayContainerShardPlacementExecutionTicketActivationReadSnapshot,
    RelayContainerShardPlacementExecutionTicketAuthorityAckReadSnapshot,
    RelayContainerShardPlacementPreEnableGrant,
    RelayContainerShardPlacementPreEnableGrantCreateOutcome,
    RelayContainerShardPlacementPreEnableGrantRow,
};

const READ_ENABLED_ENV: &str = "RELAY_CONTAINER_SHARD_PLACEMENT_ACTIVATION_READ_ENABLED";
const ACK_READ_ENABLED_ENV: &str = "RELAY_CONTAINER_SHARD_PLACEMENT_AUTHORITY_ACK_READ_ENABLED";
const PRE_ENABLE_GRANT_WRITE_ENABLED_ENV: &str =
    "RELAY_CONTAINER_SHARD_PLACEMENT_PRE_ENABLE_GRANT_WRITE_ENABLED";
const DISPATCH_CONSUMPTION_WRITE_ENABLED_ENV: &str =
    "RELAY_CONTAINER_SHARD_PLACEMENT_DISPATCH_CONSUMPTION_WRITE_ENABLED";
const ISSUER_ENV: &str = "RELAY_CONTAINER_SHARD_PLACEMENT_ACTIVATION_READ_ISSUER";
const AUDIENCE_ENV: &str = "RELAY_CONTAINER_SHARD_PLACEMENT_ACTIVATION_READ_AUDIENCE";
const HMAC_KID_ENV: &str = "RELAY_CONTAINER_SHARD_PLACEMENT_ACTIVATION_READ_HMAC_CURRENT_KID";
const HMAC_CREDENTIAL_ID_ENV: &str =
    "RELAY_CONTAINER_SHARD_PLACEMENT_ACTIVATION_READ_HMAC_CURRENT_CREDENTIAL_ID_SHA256";
const HMAC_SECRET_ENV: &str = "RELAY_CONTAINER_SHARD_PLACEMENT_ACTIVATION_READ_HMAC_CURRENT_SECRET";
const HMAC_PREVIOUS_KID_ENV: &str =
    "RELAY_CONTAINER_SHARD_PLACEMENT_ACTIVATION_READ_HMAC_PREVIOUS_KID";
const HMAC_PREVIOUS_CREDENTIAL_ID_ENV: &str =
    "RELAY_CONTAINER_SHARD_PLACEMENT_ACTIVATION_READ_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256";
const HMAC_PREVIOUS_SECRET_ENV: &str =
    "RELAY_CONTAINER_SHARD_PLACEMENT_ACTIVATION_READ_HMAC_PREVIOUS_SECRET";
const ACK_HMAC_KID_ENV: &str =
    "RELAY_CONTAINER_SHARD_PLACEMENT_AUTHORITY_ACK_READ_HMAC_CURRENT_KID";
const ACK_HMAC_CREDENTIAL_ID_ENV: &str =
    "RELAY_CONTAINER_SHARD_PLACEMENT_AUTHORITY_ACK_READ_HMAC_CURRENT_CREDENTIAL_ID_SHA256";
const ACK_HMAC_SECRET_ENV: &str =
    "RELAY_CONTAINER_SHARD_PLACEMENT_AUTHORITY_ACK_READ_HMAC_CURRENT_SECRET";
const ACK_HMAC_PREVIOUS_KID_ENV: &str =
    "RELAY_CONTAINER_SHARD_PLACEMENT_AUTHORITY_ACK_READ_HMAC_PREVIOUS_KID";
const ACK_HMAC_PREVIOUS_CREDENTIAL_ID_ENV: &str =
    "RELAY_CONTAINER_SHARD_PLACEMENT_AUTHORITY_ACK_READ_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256";
const ACK_HMAC_PREVIOUS_SECRET_ENV: &str =
    "RELAY_CONTAINER_SHARD_PLACEMENT_AUTHORITY_ACK_READ_HMAC_PREVIOUS_SECRET";
const GRANT_HMAC_KID_ENV: &str =
    "RELAY_CONTAINER_SHARD_PLACEMENT_PRE_ENABLE_GRANT_HMAC_CURRENT_KID";
const GRANT_HMAC_CREDENTIAL_ID_ENV: &str =
    "RELAY_CONTAINER_SHARD_PLACEMENT_PRE_ENABLE_GRANT_HMAC_CURRENT_CREDENTIAL_ID_SHA256";
const GRANT_HMAC_SECRET_ENV: &str =
    "RELAY_CONTAINER_SHARD_PLACEMENT_PRE_ENABLE_GRANT_HMAC_CURRENT_SECRET";
const GRANT_HMAC_PREVIOUS_KID_ENV: &str =
    "RELAY_CONTAINER_SHARD_PLACEMENT_PRE_ENABLE_GRANT_HMAC_PREVIOUS_KID";
const GRANT_HMAC_PREVIOUS_CREDENTIAL_ID_ENV: &str =
    "RELAY_CONTAINER_SHARD_PLACEMENT_PRE_ENABLE_GRANT_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256";
const GRANT_HMAC_PREVIOUS_SECRET_ENV: &str =
    "RELAY_CONTAINER_SHARD_PLACEMENT_PRE_ENABLE_GRANT_HMAC_PREVIOUS_SECRET";
const CONSUMPTION_HMAC_KID_ENV: &str =
    "RELAY_CONTAINER_SHARD_PLACEMENT_DISPATCH_CONSUMPTION_HMAC_CURRENT_KID";
const CONSUMPTION_HMAC_CREDENTIAL_ID_ENV: &str =
    "RELAY_CONTAINER_SHARD_PLACEMENT_DISPATCH_CONSUMPTION_HMAC_CURRENT_CREDENTIAL_ID_SHA256";
const CONSUMPTION_HMAC_SECRET_ENV: &str =
    "RELAY_CONTAINER_SHARD_PLACEMENT_DISPATCH_CONSUMPTION_HMAC_CURRENT_SECRET";
const CONSUMPTION_HMAC_PREVIOUS_KID_ENV: &str =
    "RELAY_CONTAINER_SHARD_PLACEMENT_DISPATCH_CONSUMPTION_HMAC_PREVIOUS_KID";
const CONSUMPTION_HMAC_PREVIOUS_CREDENTIAL_ID_ENV: &str =
    "RELAY_CONTAINER_SHARD_PLACEMENT_DISPATCH_CONSUMPTION_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256";
const CONSUMPTION_HMAC_PREVIOUS_SECRET_ENV: &str =
    "RELAY_CONTAINER_SHARD_PLACEMENT_DISPATCH_CONSUMPTION_HMAC_PREVIOUS_SECRET";
const APPLICATION_DATABASE_IDENTITY_ENV: &str =
    "RELAY_CONTAINER_SHARD_APPLICATION_DATABASE_IDENTITY_SHA256";
const APPLICATION_HEADER: &str = "x-cinatoken-shard-placement-application";
const HMAC_DOMAIN: &[u8] = b"cinatoken-shard-placement-application-v1\n";
const ACTIVATION_DIGEST_DOMAIN: &[u8] =
    b"cinatoken:relay-container-shard-placement-execution-ticket-activation:v1\0";
const ACKNOWLEDGEMENT_DIGEST_DOMAIN: &[u8] =
    b"cinatoken:relay-container-shard-placement-authority-ack:v1\0";
const PRE_ENABLE_GRANT_DIGEST_DOMAIN: &[u8] =
    b"cinatoken:relay-container-shard-placement-pre-enable-grant:v1\0";
const DISPATCH_CONSUMPTION_DIGEST_DOMAIN: &[u8] =
    b"cinatoken:relay-container-shard-placement-dispatch-consumption:v1\0";
const EMPTY_BODY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const SNAPSHOT_CONTRACT: &str =
    "cinatoken-relay-container-shard-placement-execution-ticket-activation-snapshot-v1";
const ACK_SNAPSHOT_CONTRACT: &str =
    "cinatoken-relay-container-shard-placement-authority-ack-snapshot-v1";
const ACTIVATION_CONTRACT: &str =
    "cinatoken-relay-container-shard-placement-execution-ticket-activation-v1";
const ACKNOWLEDGEMENT_CONTRACT: &str = "cinatoken-relay-container-shard-placement-authority-ack-v1";
const PRE_ENABLE_GRANT_CONTRACT: &str =
    "cinatoken-relay-container-shard-placement-pre-enable-grant-v1";
const PRE_ENABLE_GRANT_SNAPSHOT_CONTRACT: &str =
    "cinatoken-relay-container-shard-placement-pre-enable-grant-snapshot-v1";
const AUTHORITY_DISPATCH_CLAIM_CONTRACT: &str =
    "cinatoken-shard-placement-authority-operation-five-dispatch-claim-v1";
const DISPATCH_CONSUMPTION_CONTRACT: &str =
    "cinatoken-relay-container-shard-placement-dispatch-consumption-v1";
const DISPATCH_CONSUMPTION_RESULT_CONTRACT: &str =
    "cinatoken-relay-container-shard-placement-dispatch-consumption-result-v1";
const DISPATCH_CONSUMPTION_SNAPSHOT_CONTRACT: &str =
    "cinatoken-relay-container-shard-placement-dispatch-consumption-snapshot-v1";
const TICKET_CONTRACT: &str = "cinatoken-relay-container-shard-placement-execution-ticket-v1";
const HMAC_WINDOW_SECONDS: i64 = 60;
const HMAC_CLOCK_SKEW_SECONDS: i64 = 5;
const TOKEN_MAX_BYTES: usize = 4096;
const MAX_JSON_BODY_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone)]
struct ReadConfig {
    issuer: String,
    audience: String,
    kid: String,
    credential_id_sha256: String,
    secret: String,
    application_database_identity_sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TokenHeader {
    typ: String,
    alg: String,
    kid: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TokenClaims {
    issuer: String,
    audience: String,
    role: String,
    credential_id_sha256: String,
    request_id: String,
    method: String,
    path_and_query: String,
    body_sha256: String,
    issued_at: i64,
    expires_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ExactReadQuery {
    ticket_digest_sha256: String,
    claim_digest_sha256: String,
    activation_digest_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ExactAckReadQuery {
    ticket_digest_sha256: String,
    claim_digest_sha256: String,
    activation_digest_sha256: String,
    acknowledgement_digest_sha256: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PreEnableGrantCommand {
    schema_version: u32,
    contract: String,
    ticket_id_sha256: String,
    authorization_id_sha256: String,
    application_ticket_digest_sha256: String,
    application_database_identity_sha256: String,
    authority_claim_digest_sha256: String,
    application_activation_digest_sha256: String,
    application_acknowledgement_digest_sha256: String,
    operation_five_admission_digest_sha256: String,
    operation_five_start_receipt_sha256: String,
    authority_dispatch_outbox_digest_sha256: String,
    authority_database_identity_sha256: String,
    authority_ledger_identity_sha256: String,
    authority_ledger_head_sha256: String,
    authority_version_id: String,
    controller_service_name: String,
    controller_enable_operation_id_sha256: String,
    controller_baseline_version_id: String,
    controller_enabled_version_id: String,
    grant_digest_sha256: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DispatchConsumptionCommand {
    schema_version: u32,
    contract: String,
    ticket_id_sha256: String,
    authorization_id_sha256: String,
    application_database_identity_sha256: String,
    application_version_id: String,
    application_grant_digest_sha256: String,
    authority_claim_digest_sha256: String,
    authority_dispatch_outbox_digest_sha256: String,
    application_grant_receipt_digest_sha256: String,
    operation_five_start_receipt_sha256: String,
    authority_dispatch_claim_digest_sha256: String,
    authority_database_identity_sha256: String,
    authority_ledger_identity_sha256: String,
    authority_ledger_head_sha256: String,
    authority_version_id: String,
    dispatch_owner_sha256: String,
    lease_token_sha256: String,
    lease_generation: i64,
    lease_expires_at: i64,
    normal_deadline_at: i64,
    permit_expires_at: i64,
    dispatch_claim_credential_id_sha256: String,
    dispatch_claim_request_id_sha256: String,
    command_dispatch_claim_request_id_sha256: String,
    authority_dispatch_claimed_at: i64,
    controller_service_name: String,
    controller_enable_operation_id_sha256: String,
    controller_baseline_version_id: String,
    controller_enabled_version_id: String,
    send_attempt_limit: i64,
    retry_limit: i64,
    missing_readback_allows_resend: i64,
    dispatch_consumption_request_id_sha256: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExactActivationSnapshot<'a> {
    schema_version: u32,
    contract: &'static str,
    ticket_id_sha256: &'a str,
    ticket_digest_sha256: &'a str,
    authorization_id_sha256: &'a str,
    campaign_id: &'a str,
    application_database_identity_sha256: &'a str,
    authority_database_identity_sha256: &'a str,
    authority_ledger_identity_sha256: &'a str,
    operation_schedule_sha256: &'a str,
    authority_claim_digest_sha256: &'a str,
    authority_claim_acquired_receipt_sha256: &'a str,
    authority_claim_operation_id_sha256: &'a str,
    authority_activation_operation_id_sha256: &'a str,
    authority_version_id: &'a str,
    activation_credential_id_sha256: &'a str,
    activation_request_id_sha256: &'a str,
    activation_digest_sha256: &'a str,
    activated_by_admin_id: i64,
    prepared_at: i64,
    activated_at: i64,
    activation_deadline_at: i64,
    execution_deadline_at: i64,
    permit_expires_at: i64,
    campaign_expires_at: i64,
    campaign_sealed_at: Option<i64>,
    database_now: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExactAuthorityAckSnapshot<'a> {
    schema_version: u32,
    contract: &'static str,
    ticket_id_sha256: &'a str,
    ticket_digest_sha256: &'a str,
    authorization_id_sha256: &'a str,
    campaign_id: &'a str,
    application_database_identity_sha256: &'a str,
    authority_database_identity_sha256: &'a str,
    authority_ledger_identity_sha256: &'a str,
    operation_schedule_sha256: &'a str,
    controller_service_name: &'a str,
    controller_baseline_version_id: &'a str,
    controller_enabled_version_id: &'a str,
    controller_enable_operation_id_sha256: &'a str,
    authority_claim_digest_sha256: &'a str,
    authority_claim_acquired_receipt_sha256: &'a str,
    authority_claim_operation_id_sha256: &'a str,
    authority_activation_operation_id_sha256: &'a str,
    application_activation_digest_sha256: &'a str,
    authority_activation_terminal_receipt_sha256: &'a str,
    authority_ledger_head_sha256: &'a str,
    authority_version_id: &'a str,
    authority_read_credential_id_sha256: &'a str,
    authority_read_request_id_sha256: &'a str,
    acknowledgement_digest_sha256: &'a str,
    acknowledged_by_admin_id: i64,
    prepared_at: i64,
    activated_at: i64,
    acknowledged_at: i64,
    activation_deadline_at: i64,
    execution_deadline_at: i64,
    permit_expires_at: i64,
    campaign_expires_at: i64,
    campaign_sealed_at: Option<i64>,
    database_now: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExactPreEnableGrantSnapshot<'a> {
    schema_version: u32,
    contract: &'static str,
    ticket_id_sha256: &'a str,
    authorization_id_sha256: &'a str,
    application_ticket_digest_sha256: &'a str,
    application_database_identity_sha256: &'a str,
    authority_claim_digest_sha256: &'a str,
    application_activation_digest_sha256: &'a str,
    application_acknowledgement_digest_sha256: &'a str,
    operation_five_admission_digest_sha256: &'a str,
    operation_five_start_receipt_sha256: &'a str,
    authority_dispatch_outbox_digest_sha256: &'a str,
    authority_database_identity_sha256: &'a str,
    authority_ledger_identity_sha256: &'a str,
    authority_ledger_head_sha256: &'a str,
    authority_version_id: &'a str,
    controller_service_name: &'a str,
    controller_enable_operation_id_sha256: &'a str,
    controller_baseline_version_id: &'a str,
    controller_enabled_version_id: &'a str,
    application_grant_credential_id_sha256: &'a str,
    application_grant_request_id_sha256: &'a str,
    grant_digest_sha256: &'a str,
    granted_at: i64,
    activation_deadline_at: i64,
    execution_deadline_at: i64,
    permit_expires_at: i64,
    campaign_expires_at: i64,
    campaign_sealed_at: Option<i64>,
    database_now: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExactDispatchConsumptionSnapshot<'a> {
    schema_version: u32,
    contract: &'static str,
    ticket_id_sha256: &'a str,
    contract_version: i64,
    consumption_contract: &'a str,
    authorization_id_sha256: &'a str,
    campaign_id: &'a str,
    application_database_identity_sha256: &'a str,
    application_version_id: &'a str,
    application_grant_digest_sha256: &'a str,
    authority_claim_digest_sha256: &'a str,
    authority_dispatch_outbox_digest_sha256: &'a str,
    application_grant_receipt_digest_sha256: &'a str,
    operation_five_start_receipt_sha256: &'a str,
    authority_dispatch_claim_digest_sha256: &'a str,
    authority_database_identity_sha256: &'a str,
    authority_ledger_identity_sha256: &'a str,
    authority_ledger_head_sha256: &'a str,
    authority_version_id: &'a str,
    dispatch_owner_sha256: &'a str,
    lease_token_sha256: &'a str,
    lease_generation: i64,
    lease_expires_at: i64,
    normal_deadline_at: i64,
    permit_expires_at: i64,
    dispatch_claim_credential_id_sha256: &'a str,
    dispatch_claim_request_id_sha256: &'a str,
    command_dispatch_claim_request_id_sha256: &'a str,
    authority_dispatch_claimed_at: i64,
    controller_service_name: &'a str,
    controller_enable_operation_id_sha256: &'a str,
    controller_baseline_version_id: &'a str,
    controller_enabled_version_id: &'a str,
    send_attempt_limit: i64,
    retry_limit: i64,
    missing_readback_allows_resend: i64,
    application_dispatch_consumption_credential_id_sha256: &'a str,
    application_dispatch_consumption_request_id_sha256: &'a str,
    command_dispatch_consumption_request_id_sha256: &'a str,
    dispatch_consumption_digest_sha256: &'a str,
    consumption_state: &'a str,
    consumed_at: i64,
}

pub async fn read_exact(
    mut req: Request,
    env: Env,
    ticket_id_sha256: Option<String>,
) -> WorkerResult<Response> {
    if !runtime_flag(&env, READ_ENABLED_ENV) {
        return protocol_error(404, "activation_read_disabled");
    }
    if request_has_forbidden_ambient_headers(&req) {
        return protocol_error(400, "forbidden_request_header");
    }
    if !request_body_is_empty(&mut req).await {
        return protocol_error(400, "unexpected_body");
    }
    let path_and_query = match request_path_and_query(&req) {
        Some(value) => value,
        None => return protocol_error(400, "invalid_request_url"),
    };
    let configs = match read_activation_configs(&env) {
        Some(value) => value,
        None => return protocol_error(503, "activation_read_configuration_invalid"),
    };
    let token = match req.headers().get(APPLICATION_HEADER).ok().flatten() {
        Some(value) => value,
        None => return protocol_error(403, "invalid_authority"),
    };
    let now = (worker::Date::now().as_millis() / 1_000) as i64;
    let (request_id, config) = match configs.iter().find_map(|config| {
        verify_token(&token, config, "activation_read", &path_and_query, now)
            .map(|request_id| (request_id, config))
    }) {
        Some(value) => value,
        None => return protocol_error(403, "invalid_authority"),
    };
    let ticket_id_sha256 = match ticket_id_sha256 {
        Some(value) if valid_sha256(&value) => value,
        _ => return protocol_error(400, "invalid_ticket_id"),
    };
    let query = match parse_exact_query(&path_and_query, &ticket_id_sha256) {
        Some(value) => value,
        None => return protocol_error(400, "invalid_exact_read_query"),
    };
    let db = match env.d1("DB") {
        Ok(value) => value,
        Err(_) => return protocol_error(503, "activation_ledger_unavailable"),
    };
    let snapshot = match relay_container_shard_placement_execution_ticket_activation_read_snapshot(
        &db,
        &ticket_id_sha256,
    )
    .await
    {
        Ok(Some(value)) => value,
        Ok(None) => return protocol_error(404, "activation_not_found"),
        Err(err) => {
            worker::console_error!("Placement activation exact-read D1 failed: {err}");
            return protocol_error(503, "activation_ledger_unavailable");
        }
    };
    if !snapshot_is_exact(
        &snapshot,
        &query,
        &config.application_database_identity_sha256,
    ) {
        return protocol_error(409, "activation_snapshot_mismatch");
    }
    let application_version_id = match env
        .get_binding::<WorkerVersionMetadata>("CF_VERSION_METADATA")
        .map(|metadata| metadata.id())
        .ok()
        .filter(|value| valid_identity(value))
    {
        Some(value) => value,
        None => return protocol_error(503, "application_version_unavailable"),
    };
    let ticket = &snapshot.ticket;
    let activation = &snapshot.activation;
    let context = &snapshot.context;
    protocol_json(
        200,
        &json!({
            "result": "exact_execution_ticket_activation",
            "requestId": request_id,
            "snapshot": ExactActivationSnapshot {
                schema_version: 1,
                contract: SNAPSHOT_CONTRACT,
                ticket_id_sha256: &ticket.ticket_id_sha256,
                ticket_digest_sha256: &ticket.ticket_digest_sha256,
                authorization_id_sha256: &ticket.authorization_id_sha256,
                campaign_id: &ticket.campaign_id,
                application_database_identity_sha256:
                    &ticket.application_database_identity_sha256,
                authority_database_identity_sha256:
                    &ticket.authority_database_identity_sha256,
                authority_ledger_identity_sha256:
                    &ticket.authority_ledger_identity_sha256,
                operation_schedule_sha256: &ticket.operation_schedule_sha256,
                authority_claim_digest_sha256:
                    &activation.authority_claim_digest_sha256,
                authority_claim_acquired_receipt_sha256:
                    &activation.authority_claim_acquired_receipt_sha256,
                authority_claim_operation_id_sha256:
                    &activation.authority_claim_operation_id_sha256,
                authority_activation_operation_id_sha256:
                    &activation.authority_activation_operation_id_sha256,
                authority_version_id: &activation.authority_version_id,
                activation_credential_id_sha256:
                    &activation.activation_credential_id_sha256,
                activation_request_id_sha256:
                    &activation.activation_request_id_sha256,
                activation_digest_sha256: &activation.activation_digest_sha256,
                activated_by_admin_id: activation.activated_by_admin_id,
                prepared_at: ticket.prepared_at,
                activated_at: activation.activated_at,
                activation_deadline_at: ticket.activation_deadline_at,
                execution_deadline_at: ticket.execution_deadline_at,
                permit_expires_at: context.permit_expires_at,
                campaign_expires_at: context.campaign_expires_at,
                campaign_sealed_at: context.campaign_sealed_at,
                database_now: context.database_now,
            },
            "applicationVersionId": application_version_id,
        }),
    )
}

pub async fn read_exact_ack(
    mut req: Request,
    env: Env,
    ticket_id_sha256: Option<String>,
) -> WorkerResult<Response> {
    if !runtime_flag(&env, ACK_READ_ENABLED_ENV) {
        return protocol_error(404, "authority_ack_read_disabled");
    }
    if request_has_forbidden_ambient_headers(&req) {
        return protocol_error(400, "forbidden_request_header");
    }
    if !request_body_is_empty(&mut req).await {
        return protocol_error(400, "unexpected_body");
    }
    let path_and_query = match request_path_and_query(&req) {
        Some(value) => value,
        None => return protocol_error(400, "invalid_request_url"),
    };
    let configs = match read_ack_configs(&env) {
        Some(value) => value,
        None => return protocol_error(503, "authority_ack_read_configuration_invalid"),
    };
    let token = match req.headers().get(APPLICATION_HEADER).ok().flatten() {
        Some(value) => value,
        None => return protocol_error(403, "invalid_authority"),
    };
    let now = (worker::Date::now().as_millis() / 1_000) as i64;
    let (request_id, config) = match configs.iter().find_map(|config| {
        verify_token(&token, config, "authority_ack_read", &path_and_query, now)
            .map(|request_id| (request_id, config))
    }) {
        Some(value) => value,
        None => return protocol_error(403, "invalid_authority"),
    };
    let ticket_id_sha256 = match ticket_id_sha256 {
        Some(value) if valid_sha256(&value) => value,
        _ => return protocol_error(400, "invalid_ticket_id"),
    };
    let query = match parse_exact_ack_query(&path_and_query, &ticket_id_sha256) {
        Some(value) => value,
        None => return protocol_error(400, "invalid_exact_read_query"),
    };
    let db = match env.d1("DB") {
        Ok(value) => value,
        Err(_) => return protocol_error(503, "authority_ack_ledger_unavailable"),
    };
    let snapshot =
        match relay_container_shard_placement_execution_ticket_authority_ack_read_snapshot(
            &db,
            &ticket_id_sha256,
        )
        .await
        {
            Ok(Some(value)) => value,
            Ok(None) => return protocol_error(404, "authority_ack_not_found"),
            Err(err) => {
                worker::console_error!(
                    "Placement Authority acknowledgement exact-read D1 failed: {err}"
                );
                return protocol_error(503, "authority_ack_ledger_unavailable");
            }
        };
    if !ack_snapshot_is_exact(
        &snapshot,
        &query,
        &config.application_database_identity_sha256,
    ) {
        return protocol_error(409, "authority_ack_snapshot_mismatch");
    }
    let application_version_id = match env
        .get_binding::<WorkerVersionMetadata>("CF_VERSION_METADATA")
        .map(|metadata| metadata.id())
        .ok()
        .filter(|value| valid_identity(value))
    {
        Some(value) => value,
        None => return protocol_error(503, "application_version_unavailable"),
    };
    let ticket = &snapshot.ticket;
    let activation = &snapshot.activation;
    let acknowledgement = &snapshot.acknowledgement;
    let context = &snapshot.context;
    protocol_json(
        200,
        &json!({
            "result": "exact_execution_ticket_authority_ack",
            "requestId": request_id,
            "snapshot": ExactAuthorityAckSnapshot {
                schema_version: 1,
                contract: ACK_SNAPSHOT_CONTRACT,
                ticket_id_sha256: &ticket.ticket_id_sha256,
                ticket_digest_sha256: &ticket.ticket_digest_sha256,
                authorization_id_sha256: &ticket.authorization_id_sha256,
                campaign_id: &ticket.campaign_id,
                application_database_identity_sha256:
                    &ticket.application_database_identity_sha256,
                authority_database_identity_sha256:
                    &ticket.authority_database_identity_sha256,
                authority_ledger_identity_sha256:
                    &ticket.authority_ledger_identity_sha256,
                operation_schedule_sha256: &ticket.operation_schedule_sha256,
                controller_service_name: &ticket.controller_service_name,
                controller_baseline_version_id:
                    &ticket.controller_baseline_version_id,
                controller_enabled_version_id:
                    &ticket.controller_enabled_version_id,
                controller_enable_operation_id_sha256:
                    &ticket.controller_enable_operation_id_sha256,
                authority_claim_digest_sha256:
                    &activation.authority_claim_digest_sha256,
                authority_claim_acquired_receipt_sha256:
                    &activation.authority_claim_acquired_receipt_sha256,
                authority_claim_operation_id_sha256:
                    &activation.authority_claim_operation_id_sha256,
                authority_activation_operation_id_sha256:
                    &activation.authority_activation_operation_id_sha256,
                application_activation_digest_sha256:
                    &activation.activation_digest_sha256,
                authority_activation_terminal_receipt_sha256:
                    &acknowledgement.authority_activation_terminal_receipt_sha256,
                authority_ledger_head_sha256:
                    &acknowledgement.authority_ledger_head_sha256,
                authority_version_id: &acknowledgement.authority_version_id,
                authority_read_credential_id_sha256:
                    &acknowledgement.authority_read_credential_id_sha256,
                authority_read_request_id_sha256:
                    &acknowledgement.authority_read_request_id_sha256,
                acknowledgement_digest_sha256:
                    &acknowledgement.acknowledgement_digest_sha256,
                acknowledged_by_admin_id: acknowledgement.acknowledged_by_admin_id,
                prepared_at: ticket.prepared_at,
                activated_at: activation.activated_at,
                acknowledged_at: acknowledgement.acknowledged_at,
                activation_deadline_at: ticket.activation_deadline_at,
                execution_deadline_at: ticket.execution_deadline_at,
                permit_expires_at: context.permit_expires_at,
                campaign_expires_at: context.campaign_expires_at,
                campaign_sealed_at: context.campaign_sealed_at,
                database_now: context.database_now,
            },
            "applicationVersionId": application_version_id,
        }),
    )
}

pub async fn create_pre_enable_grant(
    mut req: Request,
    env: Env,
    ticket_id_sha256: Option<String>,
) -> WorkerResult<Response> {
    if !runtime_flag(&env, PRE_ENABLE_GRANT_WRITE_ENABLED_ENV) {
        return protocol_error(404, "pre_enable_grant_write_disabled");
    }
    if request_has_forbidden_ambient_headers(&req) {
        return protocol_error(400, "forbidden_request_header");
    }
    let path_and_query = match request_path_and_query(&req) {
        Some(value) => value,
        None => return protocol_error(400, "invalid_request_url"),
    };
    let ticket_id_sha256 = match ticket_id_sha256 {
        Some(value) if valid_sha256(&value) => value,
        _ => return protocol_error(400, "invalid_ticket_id"),
    };
    let expected_path =
        format!("/internal/v1/shard-placement/pre-enable-grants/{ticket_id_sha256}");
    if path_and_query != expected_path {
        return protocol_error(400, "invalid_grant_path");
    }
    let body = match read_bounded_json_body(&mut req).await {
        Ok(value) => value,
        Err(code) => return protocol_error(code.0, code.1),
    };
    let command = match parse_pre_enable_grant_command(&body) {
        Some(value) => value,
        None => return protocol_error(400, "invalid_grant_command"),
    };
    if command.ticket_id_sha256 != ticket_id_sha256 {
        return protocol_error(400, "grant_path_mismatch");
    }
    let configs = match read_grant_configs(&env) {
        Some(value) => value,
        None => return protocol_error(503, "pre_enable_grant_configuration_invalid"),
    };
    let token = match req.headers().get(APPLICATION_HEADER).ok().flatten() {
        Some(value) => value,
        None => return protocol_error(403, "invalid_authority"),
    };
    let body_sha256 = sha256_hex(&body);
    let now = (worker::Date::now().as_millis() / 1_000) as i64;
    let (request_id, config) = match configs.iter().find_map(|config| {
        verify_token_for_request(
            &token,
            config,
            "pre_enable_grant",
            "POST",
            &path_and_query,
            &body_sha256,
            now,
        )
        .map(|request_id| (request_id, config))
    }) {
        Some(value) => value,
        None => return protocol_error(403, "invalid_authority"),
    };
    let request_id_sha256 = sha256_hex(request_id.as_bytes());
    if !pre_enable_grant_command_is_valid(
        &command,
        &config.application_database_identity_sha256,
        &config.credential_id_sha256,
        &request_id_sha256,
    ) {
        return protocol_error(409, "pre_enable_grant_command_mismatch");
    }
    let db = match env.d1("DB") {
        Ok(value) => value,
        Err(_) => return protocol_error(503, "pre_enable_grant_ledger_unavailable"),
    };
    let grant = RelayContainerShardPlacementPreEnableGrant {
        ticket_id_sha256: &command.ticket_id_sha256,
        authorization_id_sha256: &command.authorization_id_sha256,
        application_ticket_digest_sha256: &command.application_ticket_digest_sha256,
        application_database_identity_sha256: &command.application_database_identity_sha256,
        authority_claim_digest_sha256: &command.authority_claim_digest_sha256,
        application_activation_digest_sha256: &command.application_activation_digest_sha256,
        application_acknowledgement_digest_sha256: &command
            .application_acknowledgement_digest_sha256,
        operation_five_admission_digest_sha256: &command.operation_five_admission_digest_sha256,
        operation_five_start_receipt_sha256: &command.operation_five_start_receipt_sha256,
        authority_dispatch_outbox_digest_sha256: &command.authority_dispatch_outbox_digest_sha256,
        authority_database_identity_sha256: &command.authority_database_identity_sha256,
        authority_ledger_identity_sha256: &command.authority_ledger_identity_sha256,
        authority_ledger_head_sha256: &command.authority_ledger_head_sha256,
        authority_version_id: &command.authority_version_id,
        controller_service_name: &command.controller_service_name,
        controller_enable_operation_id_sha256: &command.controller_enable_operation_id_sha256,
        controller_baseline_version_id: &command.controller_baseline_version_id,
        controller_enabled_version_id: &command.controller_enabled_version_id,
        application_grant_credential_id_sha256: &config.credential_id_sha256,
        application_grant_request_id_sha256: &request_id_sha256,
        grant_digest_sha256: &command.grant_digest_sha256,
    };
    let (status, result, persisted) =
        match create_relay_container_shard_placement_pre_enable_grant(&db, &grant).await {
            Ok(RelayContainerShardPlacementPreEnableGrantCreateOutcome::Created(row)) => {
                (201, "grant_created", row)
            }
            Ok(RelayContainerShardPlacementPreEnableGrantCreateOutcome::ExactReplay(row)) => {
                (200, "exact_replay", row)
            }
            Ok(RelayContainerShardPlacementPreEnableGrantCreateOutcome::Conflict) => {
                return protocol_error(409, "pre_enable_grant_conflict");
            }
            Err(err) => {
                let error = err.to_string();
                worker::console_error!("Placement pre-enable grant D1 failed: {error}");
                if error.contains("not admissible")
                    || error.contains("constraint failed")
                    || error.contains("Constraint failed")
                {
                    return protocol_error(409, "pre_enable_grant_not_admissible");
                }
                return protocol_error(503, "pre_enable_grant_ledger_unavailable");
            }
        };
    if !pre_enable_grant_row_is_exact(&persisted, &grant) {
        return protocol_error(409, "pre_enable_grant_readback_mismatch");
    }
    let ticket =
        match relay_container_shard_placement_execution_ticket(&db, &ticket_id_sha256).await {
            Ok(Some(value)) => value,
            Ok(None) => return protocol_error(409, "pre_enable_grant_readback_mismatch"),
            Err(err) => {
                worker::console_error!("Placement pre-enable ticket readback failed: {err}");
                return protocol_error(503, "pre_enable_grant_ledger_unavailable");
            }
        };
    let context = match relay_container_shard_placement_execution_ticket_activation_context(
        &db,
        &ticket_id_sha256,
    )
    .await
    {
        Ok(Some(value)) => value,
        Ok(None) => return protocol_error(409, "pre_enable_grant_readback_mismatch"),
        Err(err) => {
            worker::console_error!("Placement pre-enable context readback failed: {err}");
            return protocol_error(503, "pre_enable_grant_ledger_unavailable");
        }
    };
    let application_version_id = match env
        .get_binding::<WorkerVersionMetadata>("CF_VERSION_METADATA")
        .map(|metadata| metadata.id())
        .ok()
        .filter(|value| valid_identity(value))
    {
        Some(value) => value,
        None => return protocol_error(503, "application_version_unavailable"),
    };
    protocol_json(
        status,
        &json!({
            "result": result,
            "requestId": request_id,
            "credentialIdSha256": config.credential_id_sha256,
            "snapshot": ExactPreEnableGrantSnapshot {
                schema_version: 1,
                contract: PRE_ENABLE_GRANT_SNAPSHOT_CONTRACT,
                ticket_id_sha256: &persisted.ticket_id_sha256,
                authorization_id_sha256: &persisted.authorization_id_sha256,
                application_ticket_digest_sha256:
                    &persisted.application_ticket_digest_sha256,
                application_database_identity_sha256:
                    &persisted.application_database_identity_sha256,
                authority_claim_digest_sha256:
                    &persisted.authority_claim_digest_sha256,
                application_activation_digest_sha256:
                    &persisted.application_activation_digest_sha256,
                application_acknowledgement_digest_sha256:
                    &persisted.application_acknowledgement_digest_sha256,
                operation_five_admission_digest_sha256:
                    &persisted.operation_five_admission_digest_sha256,
                operation_five_start_receipt_sha256:
                    &persisted.operation_five_start_receipt_sha256,
                authority_dispatch_outbox_digest_sha256:
                    &persisted.authority_dispatch_outbox_digest_sha256,
                authority_database_identity_sha256:
                    &persisted.authority_database_identity_sha256,
                authority_ledger_identity_sha256:
                    &persisted.authority_ledger_identity_sha256,
                authority_ledger_head_sha256:
                    &persisted.authority_ledger_head_sha256,
                authority_version_id: &persisted.authority_version_id,
                controller_service_name: &persisted.controller_service_name,
                controller_enable_operation_id_sha256:
                    &persisted.controller_enable_operation_id_sha256,
                controller_baseline_version_id:
                    &persisted.controller_baseline_version_id,
                controller_enabled_version_id:
                    &persisted.controller_enabled_version_id,
                application_grant_credential_id_sha256:
                    &persisted.application_grant_credential_id_sha256,
                application_grant_request_id_sha256:
                    &persisted.application_grant_request_id_sha256,
                grant_digest_sha256: &persisted.grant_digest_sha256,
                granted_at: persisted.granted_at,
                activation_deadline_at: ticket.activation_deadline_at,
                execution_deadline_at: ticket.execution_deadline_at,
                permit_expires_at: context.permit_expires_at,
                campaign_expires_at: context.campaign_expires_at,
                campaign_sealed_at: context.campaign_sealed_at,
                database_now: context.database_now,
            },
            "applicationVersionId": application_version_id,
        }),
    )
}

pub async fn create_dispatch_consumption(
    mut req: Request,
    env: Env,
    ticket_id_sha256: Option<String>,
) -> WorkerResult<Response> {
    if !runtime_flag(&env, DISPATCH_CONSUMPTION_WRITE_ENABLED_ENV) {
        return protocol_error(404, "dispatch_consumption_write_disabled");
    }
    if request_has_forbidden_ambient_headers(&req) {
        return protocol_error(400, "forbidden_request_header");
    }
    let path_and_query = match request_path_and_query(&req) {
        Some(value) => value,
        None => return protocol_error(400, "invalid_request_url"),
    };
    let ticket_id_sha256 = match ticket_id_sha256 {
        Some(value) if valid_sha256(&value) => value,
        _ => return protocol_error(400, "invalid_ticket_id"),
    };
    let expected_path =
        format!("/internal/v1/shard-placement/dispatch-consumptions/{ticket_id_sha256}");
    if path_and_query != expected_path {
        return protocol_error(400, "invalid_dispatch_consumption_path");
    }
    let body = match read_bounded_json_body(&mut req).await {
        Ok(value) => value,
        Err(code) => return protocol_error(code.0, code.1),
    };
    let command = match parse_dispatch_consumption_command(&body) {
        Some(value) => value,
        None => return protocol_error(400, "invalid_dispatch_consumption_command"),
    };
    if command.ticket_id_sha256 != ticket_id_sha256 {
        return protocol_error(400, "dispatch_consumption_path_mismatch");
    }
    let configs = match read_consumption_configs(&env) {
        Some(value) => value,
        None => return protocol_error(503, "dispatch_consumption_configuration_invalid"),
    };
    let token = match req.headers().get(APPLICATION_HEADER).ok().flatten() {
        Some(value) => value,
        None => return protocol_error(403, "invalid_authority"),
    };
    let body_sha256 = sha256_hex(&body);
    let now = (worker::Date::now().as_millis() / 1_000) as i64;
    let (request_id, config) = match configs.iter().find_map(|config| {
        verify_token_for_request(
            &token,
            config,
            "dispatch_consumption",
            "POST",
            &path_and_query,
            &body_sha256,
            now,
        )
        .map(|request_id| (request_id, config))
    }) {
        Some(value) => value,
        None => return protocol_error(403, "invalid_authority"),
    };
    let request_id_sha256 = sha256_hex(request_id.as_bytes());
    if !dispatch_consumption_command_is_valid(
        &command,
        &config.application_database_identity_sha256,
    ) {
        return protocol_error(409, "dispatch_consumption_command_mismatch");
    }
    let db = match env.d1("DB") {
        Ok(value) => value,
        Err(_) => return protocol_error(503, "dispatch_consumption_ledger_unavailable"),
    };

    let existing =
        match relay_container_shard_placement_dispatch_consumption(&db, &ticket_id_sha256).await {
            Ok(value) => value,
            Err(err) => {
                worker::console_error!("Placement dispatch consumption read failed: {err}");
                return protocol_error(503, "dispatch_consumption_ledger_unavailable");
            }
        };
    if let Some(existing) = existing {
        let digest = dispatch_consumption_digest(
            &command,
            &existing.campaign_id,
            &config.credential_id_sha256,
            &request_id_sha256,
        );
        let candidate = dispatch_consumption_record(
            &command,
            &existing.campaign_id,
            &config.credential_id_sha256,
            &request_id_sha256,
            &digest,
        );
        if !relay_container_shard_placement_dispatch_consumption_matches(&existing, &candidate) {
            return protocol_error(409, "dispatch_consumption_conflict");
        }
        return dispatch_consumption_response(200, "exact_replay", &existing);
    }

    let ticket =
        match relay_container_shard_placement_execution_ticket(&db, &ticket_id_sha256).await {
            Ok(Some(value)) => value,
            Ok(None) => return protocol_error(409, "dispatch_consumption_not_admissible"),
            Err(err) => {
                worker::console_error!("Placement dispatch consumption ticket read failed: {err}");
                return protocol_error(503, "dispatch_consumption_ledger_unavailable");
            }
        };
    let grant = match relay_container_shard_placement_pre_enable_grant(&db, &ticket_id_sha256).await
    {
        Ok(Some(value)) => value,
        Ok(None) => return protocol_error(409, "dispatch_consumption_not_admissible"),
        Err(err) => {
            worker::console_error!("Placement dispatch consumption grant read failed: {err}");
            return protocol_error(503, "dispatch_consumption_ledger_unavailable");
        }
    };
    if ticket.authorization_id_sha256 != command.authorization_id_sha256
        || ticket.application_database_identity_sha256
            != command.application_database_identity_sha256
        || grant.authorization_id_sha256 != command.authorization_id_sha256
        || grant.application_database_identity_sha256
            != command.application_database_identity_sha256
        || grant.grant_digest_sha256 != command.application_grant_digest_sha256
        || grant.authority_claim_digest_sha256 != command.authority_claim_digest_sha256
        || grant.authority_dispatch_outbox_digest_sha256
            != command.authority_dispatch_outbox_digest_sha256
        || grant.operation_five_start_receipt_sha256 != command.operation_five_start_receipt_sha256
        || grant.authority_database_identity_sha256 != command.authority_database_identity_sha256
        || grant.authority_ledger_identity_sha256 != command.authority_ledger_identity_sha256
        || grant.authority_ledger_head_sha256 != command.authority_ledger_head_sha256
        || grant.authority_version_id != command.authority_version_id
        || grant.controller_service_name != command.controller_service_name
        || grant.controller_enable_operation_id_sha256
            != command.controller_enable_operation_id_sha256
        || grant.controller_baseline_version_id != command.controller_baseline_version_id
        || grant.controller_enabled_version_id != command.controller_enabled_version_id
    {
        return protocol_error(409, "dispatch_consumption_local_evidence_mismatch");
    }
    let digest = dispatch_consumption_digest(
        &command,
        &ticket.campaign_id,
        &config.credential_id_sha256,
        &request_id_sha256,
    );
    let candidate = dispatch_consumption_record(
        &command,
        &ticket.campaign_id,
        &config.credential_id_sha256,
        &request_id_sha256,
        &digest,
    );
    let application_version_id = match env
        .get_binding::<WorkerVersionMetadata>("CF_VERSION_METADATA")
        .map(|metadata| metadata.id())
        .ok()
        .filter(|value| valid_identity(value))
    {
        Some(value) => value,
        None => return protocol_error(503, "application_version_unavailable"),
    };
    if command.application_version_id != application_version_id {
        return protocol_error(409, "dispatch_consumption_application_version_mismatch");
    }
    let (status, result, persisted) =
        match create_relay_container_shard_placement_dispatch_consumption(&db, &candidate).await {
            Ok(RelayContainerShardPlacementDispatchConsumptionCreateOutcome::Created(row)) => {
                (201, "dispatch_consumption_recorded", row)
            }
            Ok(RelayContainerShardPlacementDispatchConsumptionCreateOutcome::ExactReplay(row)) => {
                (200, "exact_replay", row)
            }
            Ok(RelayContainerShardPlacementDispatchConsumptionCreateOutcome::Conflict) => {
                return protocol_error(409, "dispatch_consumption_conflict");
            }
            Err(err) => {
                let error = err.to_string();
                worker::console_error!("Placement dispatch consumption D1 failed: {error}");
                if error.contains("not admissible")
                    || error.contains("constraint failed")
                    || error.contains("Constraint failed")
                {
                    return protocol_error(409, "dispatch_consumption_not_admissible");
                }
                return protocol_error(503, "dispatch_consumption_ledger_unavailable");
            }
        };
    if !relay_container_shard_placement_dispatch_consumption_matches(&persisted, &candidate) {
        return protocol_error(409, "dispatch_consumption_readback_mismatch");
    }
    dispatch_consumption_response(status, result, &persisted)
}

fn request_has_forbidden_ambient_headers(req: &Request) -> bool {
    ["content-encoding", "cookie", "origin"]
        .iter()
        .any(|name| req.headers().has(name).unwrap_or(true))
}

async fn request_body_is_empty(req: &mut Request) -> bool {
    if req
        .headers()
        .get("content-length")
        .ok()
        .flatten()
        .is_some_and(|value| value != "0")
    {
        return false;
    }
    let Ok(mut stream) = req.stream() else {
        return true;
    };
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(bytes) if bytes.is_empty() => {}
            _ => return false,
        }
    }
    true
}

async fn read_bounded_json_body(req: &mut Request) -> Result<Vec<u8>, (u16, &'static str)> {
    let content_type = req
        .headers()
        .get("content-type")
        .ok()
        .flatten()
        .map(|value| {
            value
                .split(';')
                .next()
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase()
        });
    if content_type.as_deref() != Some("application/json") {
        return Err((415, "invalid_content_type"));
    }
    if let Some(length) = req.headers().get("content-length").ok().flatten() {
        let Ok(length) = length.parse::<usize>() else {
            return Err((413, "request_too_large"));
        };
        if length == 0 {
            return Err((400, "invalid_json"));
        }
        if length > MAX_JSON_BODY_BYTES {
            return Err((413, "request_too_large"));
        }
    }
    let Ok(mut stream) = req.stream() else {
        return Err((400, "invalid_json"));
    };
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let Ok(bytes) = chunk else {
            return Err((400, "invalid_json"));
        };
        if body.len().saturating_add(bytes.len()) > MAX_JSON_BODY_BYTES {
            return Err((413, "request_too_large"));
        }
        body.extend_from_slice(&bytes);
    }
    if body.is_empty() {
        return Err((400, "invalid_json"));
    }
    Ok(body)
}

fn parse_pre_enable_grant_command(body: &[u8]) -> Option<PreEnableGrantCommand> {
    let value: serde_json::Value = serde_json::from_slice(body).ok()?;
    let mut canonical = String::new();
    write_canonical_json_value(&value, &mut canonical)?;
    if canonical.as_bytes() != body {
        return None;
    }
    serde_json::from_value(value).ok()
}

fn parse_dispatch_consumption_command(body: &[u8]) -> Option<DispatchConsumptionCommand> {
    let value: serde_json::Value = serde_json::from_slice(body).ok()?;
    let mut canonical = String::new();
    write_canonical_json_value(&value, &mut canonical)?;
    if canonical.as_bytes() != body {
        return None;
    }
    serde_json::from_value(value).ok()
}

fn write_canonical_json_value(value: &serde_json::Value, output: &mut String) -> Option<()> {
    match value {
        serde_json::Value::Null => output.push_str("null"),
        serde_json::Value::Bool(value) => {
            output.push_str(if *value { "true" } else { "false" });
        }
        serde_json::Value::Number(value) => output.push_str(&value.to_string()),
        serde_json::Value::String(value) => {
            output.push_str(&serde_json::to_string(value).ok()?);
        }
        serde_json::Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                write_canonical_json_value(value, output)?;
            }
            output.push(']');
        }
        serde_json::Value::Object(values) => {
            output.push('{');
            let mut entries = values.iter().collect::<Vec<_>>();
            entries.sort_unstable_by(|left, right| left.0.as_bytes().cmp(right.0.as_bytes()));
            for (index, (key, value)) in entries.into_iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(&serde_json::to_string(key).ok()?);
                output.push(':');
                write_canonical_json_value(value, output)?;
            }
            output.push('}');
        }
    }
    Some(())
}

fn pre_enable_grant_command_is_valid(
    command: &PreEnableGrantCommand,
    application_database_identity_sha256: &str,
    credential_id_sha256: &str,
    request_id_sha256: &str,
) -> bool {
    let sha256_values = [
        &command.ticket_id_sha256,
        &command.authorization_id_sha256,
        &command.application_ticket_digest_sha256,
        &command.application_database_identity_sha256,
        &command.authority_claim_digest_sha256,
        &command.application_activation_digest_sha256,
        &command.application_acknowledgement_digest_sha256,
        &command.operation_five_admission_digest_sha256,
        &command.operation_five_start_receipt_sha256,
        &command.authority_dispatch_outbox_digest_sha256,
        &command.authority_database_identity_sha256,
        &command.authority_ledger_identity_sha256,
        &command.authority_ledger_head_sha256,
        &command.controller_enable_operation_id_sha256,
        &command.grant_digest_sha256,
    ];
    if command.schema_version != 1
        || command.contract != PRE_ENABLE_GRANT_CONTRACT
        || sha256_values.iter().any(|value| !valid_sha256(value))
        || !valid_identity(&command.authority_version_id)
        || command.controller_service_name != "cinatoken-container-controller-staging"
        || !valid_identity(&command.controller_baseline_version_id)
        || !valid_identity(&command.controller_enabled_version_id)
        || command.controller_baseline_version_id == command.controller_enabled_version_id
        || command.application_database_identity_sha256 != application_database_identity_sha256
        || command.authority_ledger_head_sha256 != command.operation_five_start_receipt_sha256
        || !valid_sha256(credential_id_sha256)
        || !valid_sha256(request_id_sha256)
    {
        return false;
    }
    let expected = sha256_len_prefixed(
        PRE_ENABLE_GRANT_DIGEST_DOMAIN,
        &[
            PRE_ENABLE_GRANT_CONTRACT,
            &command.ticket_id_sha256,
            &command.authorization_id_sha256,
            &command.application_ticket_digest_sha256,
            &command.application_database_identity_sha256,
            &command.authority_claim_digest_sha256,
            &command.application_activation_digest_sha256,
            &command.application_acknowledgement_digest_sha256,
            &command.operation_five_admission_digest_sha256,
            &command.operation_five_start_receipt_sha256,
            &command.authority_dispatch_outbox_digest_sha256,
            &command.authority_database_identity_sha256,
            &command.authority_ledger_identity_sha256,
            &command.authority_ledger_head_sha256,
            &command.authority_version_id,
            &command.controller_service_name,
            &command.controller_enable_operation_id_sha256,
            &command.controller_baseline_version_id,
            &command.controller_enabled_version_id,
            credential_id_sha256,
            request_id_sha256,
        ],
    );
    command.grant_digest_sha256 == expected
}

fn dispatch_consumption_command_is_valid(
    command: &DispatchConsumptionCommand,
    application_database_identity_sha256: &str,
) -> bool {
    let sha256_values = [
        &command.ticket_id_sha256,
        &command.authorization_id_sha256,
        &command.application_database_identity_sha256,
        &command.application_grant_digest_sha256,
        &command.authority_claim_digest_sha256,
        &command.authority_dispatch_outbox_digest_sha256,
        &command.application_grant_receipt_digest_sha256,
        &command.operation_five_start_receipt_sha256,
        &command.authority_dispatch_claim_digest_sha256,
        &command.authority_database_identity_sha256,
        &command.authority_ledger_identity_sha256,
        &command.authority_ledger_head_sha256,
        &command.dispatch_owner_sha256,
        &command.lease_token_sha256,
        &command.dispatch_claim_credential_id_sha256,
        &command.dispatch_claim_request_id_sha256,
        &command.command_dispatch_claim_request_id_sha256,
        &command.controller_enable_operation_id_sha256,
        &command.dispatch_consumption_request_id_sha256,
    ];
    if command.schema_version != 1
        || command.contract != DISPATCH_CONSUMPTION_CONTRACT
        || sha256_values.iter().any(|value| !valid_sha256(value))
        || !valid_identity(&command.application_version_id)
        || !valid_identity(&command.authority_version_id)
        || command.controller_service_name != "cinatoken-container-controller-staging"
        || !valid_identity(&command.controller_baseline_version_id)
        || !valid_identity(&command.controller_enabled_version_id)
        || command.controller_baseline_version_id == command.controller_enabled_version_id
        || command.application_database_identity_sha256 != application_database_identity_sha256
        || command.authority_ledger_head_sha256 != command.operation_five_start_receipt_sha256
        || command.lease_generation != 1
        || command.lease_expires_at <= 0
        || command.normal_deadline_at <= 0
        || command.permit_expires_at <= 0
        || command.lease_expires_at > command.normal_deadline_at
        || command.normal_deadline_at > command.permit_expires_at
        || command.authority_dispatch_claimed_at <= 0
        || command.send_attempt_limit != 1
        || command.retry_limit != 0
        || command.missing_readback_allows_resend != 0
        || command.dispatch_claim_credential_id_sha256 == command.dispatch_claim_request_id_sha256
    {
        return false;
    }
    authority_dispatch_claim_digest(command)
        .is_some_and(|value| value == command.authority_dispatch_claim_digest_sha256)
}

fn authority_dispatch_claim_digest(command: &DispatchConsumptionCommand) -> Option<String> {
    let value = json!({
        "schemaVersion": 1,
        "contract": AUTHORITY_DISPATCH_CLAIM_CONTRACT,
        "authorizationIdSha256": command.authorization_id_sha256,
        "claimDigestSha256": command.authority_claim_digest_sha256,
        "applicationTicketIdSha256": command.ticket_id_sha256,
        "applicationDatabaseIdentitySha256":
            command.application_database_identity_sha256,
        "authorityDispatchOutboxDigestSha256":
            command.authority_dispatch_outbox_digest_sha256,
        "applicationGrantReceiptDigestSha256":
            command.application_grant_receipt_digest_sha256,
        "applicationGrantDigestSha256":
            command.application_grant_digest_sha256,
        "operationFiveStartReceiptSha256":
            command.operation_five_start_receipt_sha256,
        "authorityDatabaseIdentitySha256":
            command.authority_database_identity_sha256,
        "authorityLedgerIdentitySha256":
            command.authority_ledger_identity_sha256,
        "authorityLedgerHeadSha256":
            command.authority_ledger_head_sha256,
        "authorityVersionId": command.authority_version_id,
        "applicationVersionId": command.application_version_id,
        "dispatchOwnerSha256": command.dispatch_owner_sha256,
        "leaseTokenSha256": command.lease_token_sha256,
        "leaseGeneration": command.lease_generation,
        "leaseExpiresAt": command.lease_expires_at,
        "normalDeadlineAt": command.normal_deadline_at,
        "permitExpiresAt": command.permit_expires_at,
        "dispatchClaimCredentialIdSha256":
            command.dispatch_claim_credential_id_sha256,
        "dispatchClaimRequestIdSha256":
            command.dispatch_claim_request_id_sha256,
        "commandDispatchClaimRequestIdSha256":
            command.command_dispatch_claim_request_id_sha256,
        "controllerServiceName": command.controller_service_name,
        "controllerEnableOperationIdSha256":
            command.controller_enable_operation_id_sha256,
        "controllerBaselineVersionId":
            command.controller_baseline_version_id,
        "controllerEnabledVersionId":
            command.controller_enabled_version_id,
        "sendAttemptLimit": command.send_attempt_limit,
        "retryLimit": command.retry_limit,
        "missingReadbackAllowsResend":
            command.missing_readback_allows_resend,
        "claimState": "claimed",
    });
    let mut canonical = String::new();
    write_canonical_json_value(&value, &mut canonical)?;
    Some(sha256_hex(canonical.as_bytes()))
}

fn dispatch_consumption_digest(
    command: &DispatchConsumptionCommand,
    campaign_id: &str,
    credential_id_sha256: &str,
    request_id_sha256: &str,
) -> String {
    let lease_generation = command.lease_generation.to_string();
    let lease_expires_at = command.lease_expires_at.to_string();
    let normal_deadline_at = command.normal_deadline_at.to_string();
    let permit_expires_at = command.permit_expires_at.to_string();
    let authority_dispatch_claimed_at = command.authority_dispatch_claimed_at.to_string();
    let send_attempt_limit = command.send_attempt_limit.to_string();
    let retry_limit = command.retry_limit.to_string();
    let missing_readback_allows_resend = command.missing_readback_allows_resend.to_string();
    sha256_len_prefixed(
        DISPATCH_CONSUMPTION_DIGEST_DOMAIN,
        &[
            DISPATCH_CONSUMPTION_CONTRACT,
            &command.ticket_id_sha256,
            &command.authorization_id_sha256,
            campaign_id,
            &command.application_database_identity_sha256,
            &command.application_version_id,
            &command.application_grant_digest_sha256,
            &command.authority_claim_digest_sha256,
            &command.authority_dispatch_outbox_digest_sha256,
            &command.application_grant_receipt_digest_sha256,
            &command.operation_five_start_receipt_sha256,
            &command.authority_dispatch_claim_digest_sha256,
            &command.authority_database_identity_sha256,
            &command.authority_ledger_identity_sha256,
            &command.authority_ledger_head_sha256,
            &command.authority_version_id,
            &command.dispatch_owner_sha256,
            &command.lease_token_sha256,
            &lease_generation,
            &lease_expires_at,
            &normal_deadline_at,
            &permit_expires_at,
            &command.dispatch_claim_credential_id_sha256,
            &command.dispatch_claim_request_id_sha256,
            &command.command_dispatch_claim_request_id_sha256,
            &authority_dispatch_claimed_at,
            &command.controller_service_name,
            &command.controller_enable_operation_id_sha256,
            &command.controller_baseline_version_id,
            &command.controller_enabled_version_id,
            &send_attempt_limit,
            &retry_limit,
            &missing_readback_allows_resend,
            credential_id_sha256,
            request_id_sha256,
            &command.dispatch_consumption_request_id_sha256,
            "consumed",
        ],
    )
}

fn dispatch_consumption_record<'a>(
    command: &'a DispatchConsumptionCommand,
    campaign_id: &'a str,
    credential_id_sha256: &'a str,
    request_id_sha256: &'a str,
    digest_sha256: &'a str,
) -> RelayContainerShardPlacementDispatchConsumption<'a> {
    RelayContainerShardPlacementDispatchConsumption {
        ticket_id_sha256: &command.ticket_id_sha256,
        authorization_id_sha256: &command.authorization_id_sha256,
        campaign_id,
        application_database_identity_sha256: &command.application_database_identity_sha256,
        application_version_id: &command.application_version_id,
        application_grant_digest_sha256: &command.application_grant_digest_sha256,
        authority_claim_digest_sha256: &command.authority_claim_digest_sha256,
        authority_dispatch_outbox_digest_sha256: &command.authority_dispatch_outbox_digest_sha256,
        application_grant_receipt_digest_sha256: &command.application_grant_receipt_digest_sha256,
        operation_five_start_receipt_sha256: &command.operation_five_start_receipt_sha256,
        authority_dispatch_claim_digest_sha256: &command.authority_dispatch_claim_digest_sha256,
        authority_database_identity_sha256: &command.authority_database_identity_sha256,
        authority_ledger_identity_sha256: &command.authority_ledger_identity_sha256,
        authority_ledger_head_sha256: &command.authority_ledger_head_sha256,
        authority_version_id: &command.authority_version_id,
        dispatch_owner_sha256: &command.dispatch_owner_sha256,
        lease_token_sha256: &command.lease_token_sha256,
        lease_generation: command.lease_generation,
        lease_expires_at: command.lease_expires_at,
        normal_deadline_at: command.normal_deadline_at,
        permit_expires_at: command.permit_expires_at,
        dispatch_claim_credential_id_sha256: &command.dispatch_claim_credential_id_sha256,
        dispatch_claim_request_id_sha256: &command.dispatch_claim_request_id_sha256,
        command_dispatch_claim_request_id_sha256: &command.command_dispatch_claim_request_id_sha256,
        authority_dispatch_claimed_at: command.authority_dispatch_claimed_at,
        controller_service_name: &command.controller_service_name,
        controller_enable_operation_id_sha256: &command.controller_enable_operation_id_sha256,
        controller_baseline_version_id: &command.controller_baseline_version_id,
        controller_enabled_version_id: &command.controller_enabled_version_id,
        send_attempt_limit: command.send_attempt_limit,
        retry_limit: command.retry_limit,
        missing_readback_allows_resend: command.missing_readback_allows_resend,
        application_dispatch_consumption_credential_id_sha256: credential_id_sha256,
        application_dispatch_consumption_request_id_sha256: request_id_sha256,
        command_dispatch_consumption_request_id_sha256: &command
            .dispatch_consumption_request_id_sha256,
        dispatch_consumption_digest_sha256: digest_sha256,
    }
}

fn dispatch_consumption_response(
    status: u16,
    result: &'static str,
    row: &RelayContainerShardPlacementDispatchConsumptionRow,
) -> WorkerResult<Response> {
    protocol_json(
        status,
        &json!({
            "contract": DISPATCH_CONSUMPTION_RESULT_CONTRACT,
            "result": result,
            "snapshot": ExactDispatchConsumptionSnapshot {
                schema_version: 1,
                contract: DISPATCH_CONSUMPTION_SNAPSHOT_CONTRACT,
                ticket_id_sha256: &row.ticket_id_sha256,
                contract_version: row.contract_version,
                consumption_contract: &row.consumption_contract,
                authorization_id_sha256: &row.authorization_id_sha256,
                campaign_id: &row.campaign_id,
                application_database_identity_sha256:
                    &row.application_database_identity_sha256,
                application_version_id: &row.application_version_id,
                application_grant_digest_sha256:
                    &row.application_grant_digest_sha256,
                authority_claim_digest_sha256:
                    &row.authority_claim_digest_sha256,
                authority_dispatch_outbox_digest_sha256:
                    &row.authority_dispatch_outbox_digest_sha256,
                application_grant_receipt_digest_sha256:
                    &row.application_grant_receipt_digest_sha256,
                operation_five_start_receipt_sha256:
                    &row.operation_five_start_receipt_sha256,
                authority_dispatch_claim_digest_sha256:
                    &row.authority_dispatch_claim_digest_sha256,
                authority_database_identity_sha256:
                    &row.authority_database_identity_sha256,
                authority_ledger_identity_sha256:
                    &row.authority_ledger_identity_sha256,
                authority_ledger_head_sha256:
                    &row.authority_ledger_head_sha256,
                authority_version_id: &row.authority_version_id,
                dispatch_owner_sha256: &row.dispatch_owner_sha256,
                lease_token_sha256: &row.lease_token_sha256,
                lease_generation: row.lease_generation,
                lease_expires_at: row.lease_expires_at,
                normal_deadline_at: row.normal_deadline_at,
                permit_expires_at: row.permit_expires_at,
                dispatch_claim_credential_id_sha256:
                    &row.dispatch_claim_credential_id_sha256,
                dispatch_claim_request_id_sha256:
                    &row.dispatch_claim_request_id_sha256,
                command_dispatch_claim_request_id_sha256:
                    &row.command_dispatch_claim_request_id_sha256,
                authority_dispatch_claimed_at:
                    row.authority_dispatch_claimed_at,
                controller_service_name: &row.controller_service_name,
                controller_enable_operation_id_sha256:
                    &row.controller_enable_operation_id_sha256,
                controller_baseline_version_id:
                    &row.controller_baseline_version_id,
                controller_enabled_version_id:
                    &row.controller_enabled_version_id,
                send_attempt_limit: row.send_attempt_limit,
                retry_limit: row.retry_limit,
                missing_readback_allows_resend:
                    row.missing_readback_allows_resend,
                application_dispatch_consumption_credential_id_sha256:
                    &row.application_dispatch_consumption_credential_id_sha256,
                application_dispatch_consumption_request_id_sha256:
                    &row.application_dispatch_consumption_request_id_sha256,
                command_dispatch_consumption_request_id_sha256:
                    &row.command_dispatch_consumption_request_id_sha256,
                dispatch_consumption_digest_sha256:
                    &row.dispatch_consumption_digest_sha256,
                consumption_state: &row.consumption_state,
                consumed_at: row.consumed_at,
            },
            "sendAttemptCreated": false,
            "controllerRequestSent": false,
        }),
    )
}

fn pre_enable_grant_row_is_exact(
    row: &RelayContainerShardPlacementPreEnableGrantRow,
    grant: &RelayContainerShardPlacementPreEnableGrant<'_>,
) -> bool {
    row.contract_version == 1
        && row.grant_contract == PRE_ENABLE_GRANT_CONTRACT
        && row.ticket_id_sha256 == grant.ticket_id_sha256
        && row.authorization_id_sha256 == grant.authorization_id_sha256
        && row.application_ticket_digest_sha256 == grant.application_ticket_digest_sha256
        && row.application_database_identity_sha256 == grant.application_database_identity_sha256
        && row.authority_claim_digest_sha256 == grant.authority_claim_digest_sha256
        && row.application_activation_digest_sha256 == grant.application_activation_digest_sha256
        && row.application_acknowledgement_digest_sha256
            == grant.application_acknowledgement_digest_sha256
        && row.operation_five_admission_digest_sha256
            == grant.operation_five_admission_digest_sha256
        && row.operation_five_start_receipt_sha256 == grant.operation_five_start_receipt_sha256
        && row.authority_dispatch_outbox_digest_sha256
            == grant.authority_dispatch_outbox_digest_sha256
        && row.authority_database_identity_sha256 == grant.authority_database_identity_sha256
        && row.authority_ledger_identity_sha256 == grant.authority_ledger_identity_sha256
        && row.authority_ledger_head_sha256 == grant.authority_ledger_head_sha256
        && row.authority_version_id == grant.authority_version_id
        && row.controller_service_name == grant.controller_service_name
        && row.controller_enable_operation_id_sha256 == grant.controller_enable_operation_id_sha256
        && row.controller_baseline_version_id == grant.controller_baseline_version_id
        && row.controller_enabled_version_id == grant.controller_enabled_version_id
        && row.application_grant_credential_id_sha256
            == grant.application_grant_credential_id_sha256
        && row.application_grant_request_id_sha256 == grant.application_grant_request_id_sha256
        && row.grant_digest_sha256 == grant.grant_digest_sha256
        && row.granted_at > 0
}

fn request_path_and_query(req: &Request) -> Option<String> {
    let url = req.url().ok()?;
    let mut value = url.path().to_string();
    if let Some(query) = url.query() {
        value.push('?');
        value.push_str(query);
    }
    valid_path_and_query(&value).then_some(value)
}

fn parse_exact_query(path_and_query: &str, ticket_id_sha256: &str) -> Option<ExactReadQuery> {
    let prefix =
        format!("/internal/v1/shard-placement/execution-ticket-activations/{ticket_id_sha256}?");
    let query = path_and_query.strip_prefix(&prefix)?;
    let mut fields = query.split('&');
    let ticket_digest_sha256 = fields
        .next()?
        .strip_prefix("ticketDigestSha256=")?
        .to_string();
    let claim_digest_sha256 = fields
        .next()?
        .strip_prefix("claimDigestSha256=")?
        .to_string();
    let activation_digest_sha256 = fields
        .next()?
        .strip_prefix("activationDigestSha256=")?
        .to_string();
    if fields.next().is_some()
        || !valid_sha256(&ticket_digest_sha256)
        || !valid_sha256(&claim_digest_sha256)
        || !valid_sha256(&activation_digest_sha256)
    {
        return None;
    }
    Some(ExactReadQuery {
        ticket_digest_sha256,
        claim_digest_sha256,
        activation_digest_sha256,
    })
}

fn parse_exact_ack_query(
    path_and_query: &str,
    ticket_id_sha256: &str,
) -> Option<ExactAckReadQuery> {
    let prefix =
        format!("/internal/v1/shard-placement/execution-ticket-authority-acks/{ticket_id_sha256}?");
    let query = path_and_query.strip_prefix(&prefix)?;
    let mut fields = query.split('&');
    let ticket_digest_sha256 = fields
        .next()?
        .strip_prefix("ticketDigestSha256=")?
        .to_string();
    let claim_digest_sha256 = fields
        .next()?
        .strip_prefix("claimDigestSha256=")?
        .to_string();
    let activation_digest_sha256 = fields
        .next()?
        .strip_prefix("activationDigestSha256=")?
        .to_string();
    let acknowledgement_digest_sha256 = fields
        .next()?
        .strip_prefix("acknowledgementDigestSha256=")?
        .to_string();
    if fields.next().is_some()
        || !valid_sha256(&ticket_digest_sha256)
        || !valid_sha256(&claim_digest_sha256)
        || !valid_sha256(&activation_digest_sha256)
        || !valid_sha256(&acknowledgement_digest_sha256)
    {
        return None;
    }
    Some(ExactAckReadQuery {
        ticket_digest_sha256,
        claim_digest_sha256,
        activation_digest_sha256,
        acknowledgement_digest_sha256,
    })
}

fn read_activation_configs(env: &Env) -> Option<Vec<ReadConfig>> {
    let configs = read_rotating_configs(
        env,
        (HMAC_KID_ENV, HMAC_CREDENTIAL_ID_ENV, HMAC_SECRET_ENV),
        (
            HMAC_PREVIOUS_KID_ENV,
            HMAC_PREVIOUS_CREDENTIAL_ID_ENV,
            HMAC_PREVIOUS_SECRET_ENV,
        ),
    )?;
    let acknowledgement = read_optional_rotating_configs(
        env,
        (
            ACK_HMAC_KID_ENV,
            ACK_HMAC_CREDENTIAL_ID_ENV,
            ACK_HMAC_SECRET_ENV,
        ),
        (
            ACK_HMAC_PREVIOUS_KID_ENV,
            ACK_HMAC_PREVIOUS_CREDENTIAL_ID_ENV,
            ACK_HMAC_PREVIOUS_SECRET_ENV,
        ),
    )?;
    let grant = read_optional_rotating_configs(
        env,
        (
            GRANT_HMAC_KID_ENV,
            GRANT_HMAC_CREDENTIAL_ID_ENV,
            GRANT_HMAC_SECRET_ENV,
        ),
        (
            GRANT_HMAC_PREVIOUS_KID_ENV,
            GRANT_HMAC_PREVIOUS_CREDENTIAL_ID_ENV,
            GRANT_HMAC_PREVIOUS_SECRET_ENV,
        ),
    )?;
    let consumption = read_optional_rotating_configs(
        env,
        (
            CONSUMPTION_HMAC_KID_ENV,
            CONSUMPTION_HMAC_CREDENTIAL_ID_ENV,
            CONSUMPTION_HMAC_SECRET_ENV,
        ),
        (
            CONSUMPTION_HMAC_PREVIOUS_KID_ENV,
            CONSUMPTION_HMAC_PREVIOUS_CREDENTIAL_ID_ENV,
            CONSUMPTION_HMAC_PREVIOUS_SECRET_ENV,
        ),
    )?;
    if !optional_config_inventories_are_disjoint(
        &configs,
        &[&acknowledgement, &grant, &consumption],
    ) {
        return None;
    }
    Some(configs)
}

fn read_ack_configs(env: &Env) -> Option<Vec<ReadConfig>> {
    let configs = read_rotating_configs(
        env,
        (
            ACK_HMAC_KID_ENV,
            ACK_HMAC_CREDENTIAL_ID_ENV,
            ACK_HMAC_SECRET_ENV,
        ),
        (
            ACK_HMAC_PREVIOUS_KID_ENV,
            ACK_HMAC_PREVIOUS_CREDENTIAL_ID_ENV,
            ACK_HMAC_PREVIOUS_SECRET_ENV,
        ),
    )?;
    let activation = read_optional_rotating_configs(
        env,
        (HMAC_KID_ENV, HMAC_CREDENTIAL_ID_ENV, HMAC_SECRET_ENV),
        (
            HMAC_PREVIOUS_KID_ENV,
            HMAC_PREVIOUS_CREDENTIAL_ID_ENV,
            HMAC_PREVIOUS_SECRET_ENV,
        ),
    )?;
    let grant = read_optional_rotating_configs(
        env,
        (
            GRANT_HMAC_KID_ENV,
            GRANT_HMAC_CREDENTIAL_ID_ENV,
            GRANT_HMAC_SECRET_ENV,
        ),
        (
            GRANT_HMAC_PREVIOUS_KID_ENV,
            GRANT_HMAC_PREVIOUS_CREDENTIAL_ID_ENV,
            GRANT_HMAC_PREVIOUS_SECRET_ENV,
        ),
    )?;
    let consumption = read_optional_rotating_configs(
        env,
        (
            CONSUMPTION_HMAC_KID_ENV,
            CONSUMPTION_HMAC_CREDENTIAL_ID_ENV,
            CONSUMPTION_HMAC_SECRET_ENV,
        ),
        (
            CONSUMPTION_HMAC_PREVIOUS_KID_ENV,
            CONSUMPTION_HMAC_PREVIOUS_CREDENTIAL_ID_ENV,
            CONSUMPTION_HMAC_PREVIOUS_SECRET_ENV,
        ),
    )?;
    if !optional_config_inventories_are_disjoint(&configs, &[&activation, &grant, &consumption]) {
        return None;
    }
    Some(configs)
}

fn read_grant_configs(env: &Env) -> Option<Vec<ReadConfig>> {
    let configs = read_rotating_configs(
        env,
        (
            GRANT_HMAC_KID_ENV,
            GRANT_HMAC_CREDENTIAL_ID_ENV,
            GRANT_HMAC_SECRET_ENV,
        ),
        (
            GRANT_HMAC_PREVIOUS_KID_ENV,
            GRANT_HMAC_PREVIOUS_CREDENTIAL_ID_ENV,
            GRANT_HMAC_PREVIOUS_SECRET_ENV,
        ),
    )?;
    let activation = read_optional_rotating_configs(
        env,
        (HMAC_KID_ENV, HMAC_CREDENTIAL_ID_ENV, HMAC_SECRET_ENV),
        (
            HMAC_PREVIOUS_KID_ENV,
            HMAC_PREVIOUS_CREDENTIAL_ID_ENV,
            HMAC_PREVIOUS_SECRET_ENV,
        ),
    )?;
    let acknowledgement = read_optional_rotating_configs(
        env,
        (
            ACK_HMAC_KID_ENV,
            ACK_HMAC_CREDENTIAL_ID_ENV,
            ACK_HMAC_SECRET_ENV,
        ),
        (
            ACK_HMAC_PREVIOUS_KID_ENV,
            ACK_HMAC_PREVIOUS_CREDENTIAL_ID_ENV,
            ACK_HMAC_PREVIOUS_SECRET_ENV,
        ),
    )?;
    let consumption = read_optional_rotating_configs(
        env,
        (
            CONSUMPTION_HMAC_KID_ENV,
            CONSUMPTION_HMAC_CREDENTIAL_ID_ENV,
            CONSUMPTION_HMAC_SECRET_ENV,
        ),
        (
            CONSUMPTION_HMAC_PREVIOUS_KID_ENV,
            CONSUMPTION_HMAC_PREVIOUS_CREDENTIAL_ID_ENV,
            CONSUMPTION_HMAC_PREVIOUS_SECRET_ENV,
        ),
    )?;
    if !optional_config_inventories_are_disjoint(
        &configs,
        &[&activation, &acknowledgement, &consumption],
    ) {
        return None;
    }
    Some(configs)
}

fn read_consumption_configs(env: &Env) -> Option<Vec<ReadConfig>> {
    let configs = read_rotating_configs(
        env,
        (
            CONSUMPTION_HMAC_KID_ENV,
            CONSUMPTION_HMAC_CREDENTIAL_ID_ENV,
            CONSUMPTION_HMAC_SECRET_ENV,
        ),
        (
            CONSUMPTION_HMAC_PREVIOUS_KID_ENV,
            CONSUMPTION_HMAC_PREVIOUS_CREDENTIAL_ID_ENV,
            CONSUMPTION_HMAC_PREVIOUS_SECRET_ENV,
        ),
    )?;
    let activation = read_optional_rotating_configs(
        env,
        (HMAC_KID_ENV, HMAC_CREDENTIAL_ID_ENV, HMAC_SECRET_ENV),
        (
            HMAC_PREVIOUS_KID_ENV,
            HMAC_PREVIOUS_CREDENTIAL_ID_ENV,
            HMAC_PREVIOUS_SECRET_ENV,
        ),
    )?;
    let acknowledgement = read_optional_rotating_configs(
        env,
        (
            ACK_HMAC_KID_ENV,
            ACK_HMAC_CREDENTIAL_ID_ENV,
            ACK_HMAC_SECRET_ENV,
        ),
        (
            ACK_HMAC_PREVIOUS_KID_ENV,
            ACK_HMAC_PREVIOUS_CREDENTIAL_ID_ENV,
            ACK_HMAC_PREVIOUS_SECRET_ENV,
        ),
    )?;
    let grant = read_optional_rotating_configs(
        env,
        (
            GRANT_HMAC_KID_ENV,
            GRANT_HMAC_CREDENTIAL_ID_ENV,
            GRANT_HMAC_SECRET_ENV,
        ),
        (
            GRANT_HMAC_PREVIOUS_KID_ENV,
            GRANT_HMAC_PREVIOUS_CREDENTIAL_ID_ENV,
            GRANT_HMAC_PREVIOUS_SECRET_ENV,
        ),
    )?;
    if !optional_config_inventories_are_disjoint(&configs, &[&activation, &acknowledgement, &grant])
    {
        return None;
    }
    Some(configs)
}

fn optional_config_inventories_are_disjoint(
    required: &[ReadConfig],
    optional: &[&Option<Vec<ReadConfig>>],
) -> bool {
    for values in optional.iter().filter_map(|values| values.as_ref()) {
        if !configs_are_disjoint(required, values) {
            return false;
        }
    }
    for left_index in 0..optional.len() {
        for right_index in (left_index + 1)..optional.len() {
            if let (Some(left), Some(right)) = (
                optional[left_index].as_ref(),
                optional[right_index].as_ref(),
            ) {
                if !configs_are_disjoint(left, right) {
                    return false;
                }
            }
        }
    }
    true
}

fn read_optional_rotating_configs(
    env: &Env,
    current_names: (&str, &str, &str),
    previous_names: (&str, &str, &str),
) -> Option<Option<Vec<ReadConfig>>> {
    let configured = [
        runtime_value(env, current_names.0),
        runtime_value(env, current_names.1),
        env.secret(current_names.2)
            .ok()
            .map(|value| value.to_string()),
        runtime_value(env, previous_names.0),
        runtime_value(env, previous_names.1),
        env.secret(previous_names.2)
            .ok()
            .map(|value| value.to_string()),
    ]
    .iter()
    .any(Option::is_some);
    if !configured {
        return Some(None);
    }
    read_rotating_configs(env, current_names, previous_names).map(Some)
}

fn read_rotating_configs(
    env: &Env,
    current_names: (&str, &str, &str),
    previous_names: (&str, &str, &str),
) -> Option<Vec<ReadConfig>> {
    let current =
        read_config_with_credential(env, current_names.0, current_names.1, current_names.2)?;
    let previous_fields = [
        runtime_value(env, previous_names.0),
        runtime_value(env, previous_names.1),
        env.secret(previous_names.2)
            .ok()
            .map(|value| value.to_string()),
    ];
    let previous_configured = previous_fields.iter().any(Option::is_some);
    let previous = if previous_configured {
        Some(read_config_with_credential(
            env,
            previous_names.0,
            previous_names.1,
            previous_names.2,
        )?)
    } else {
        None
    };
    if previous.as_ref().is_some_and(|value| {
        value.kid == current.kid
            || value.credential_id_sha256 == current.credential_id_sha256
            || value.secret == current.secret
    }) {
        return None;
    }
    let mut configs = vec![current];
    if let Some(previous) = previous {
        configs.push(previous);
    }
    Some(configs)
}

fn configs_are_disjoint(left: &[ReadConfig], right: &[ReadConfig]) -> bool {
    left.iter().all(|left| {
        right.iter().all(|right| {
            left.kid != right.kid
                && left.credential_id_sha256 != right.credential_id_sha256
                && left.secret != right.secret
        })
    })
}

fn read_config_with_credential(
    env: &Env,
    kid_env: &str,
    credential_id_env: &str,
    secret_env: &str,
) -> Option<ReadConfig> {
    let issuer = runtime_value(env, ISSUER_ENV)?;
    let audience = runtime_value(env, AUDIENCE_ENV)?;
    let kid = runtime_value(env, kid_env)?;
    let credential_id_sha256 = runtime_value(env, credential_id_env)?;
    let application_database_identity_sha256 =
        runtime_value(env, APPLICATION_DATABASE_IDENTITY_ENV)?;
    let secret = env.secret(secret_env).ok()?.to_string();
    if !valid_identity(&issuer)
        || !valid_identity(&audience)
        || !valid_key_id(&kid)
        || !valid_sha256(&credential_id_sha256)
        || !valid_sha256(&application_database_identity_sha256)
        || !(32..=256).contains(&secret.as_bytes().len())
    {
        return None;
    }
    Some(ReadConfig {
        issuer,
        audience,
        kid,
        credential_id_sha256,
        secret,
        application_database_identity_sha256,
    })
}

fn verify_token(
    token: &str,
    config: &ReadConfig,
    expected_role: &str,
    path_and_query: &str,
    now: i64,
) -> Option<String> {
    verify_token_for_request(
        token,
        config,
        expected_role,
        "GET",
        path_and_query,
        EMPTY_BODY_SHA256,
        now,
    )
}

fn verify_token_for_request(
    token: &str,
    config: &ReadConfig,
    expected_role: &str,
    expected_method: &str,
    path_and_query: &str,
    expected_body_sha256: &str,
    now: i64,
) -> Option<String> {
    if token.is_empty()
        || token.len() > TOKEN_MAX_BYTES
        || token != token.trim()
        || !valid_path_and_query(path_and_query)
        || !valid_sha256(expected_body_sha256)
    {
        return None;
    }
    let mut parts = token.split('.');
    let header_part = parts.next()?;
    let claims_part = parts.next()?;
    let signature_part = parts.next()?;
    if parts.next().is_some()
        || header_part.is_empty()
        || claims_part.is_empty()
        || signature_part.is_empty()
    {
        return None;
    }
    let header_bytes = decode_canonical_base64url(header_part, 1024)?;
    let claims_bytes = decode_canonical_base64url(claims_part, 4096)?;
    let signature = decode_canonical_base64url(signature_part, 32)?;
    if signature.len() != 32 {
        return None;
    }
    let header: TokenHeader = serde_json::from_slice(&header_bytes).ok()?;
    let claims: TokenClaims = serde_json::from_slice(&claims_bytes).ok()?;
    if header.typ != "CINATOKEN-SHARD-PLACEMENT-APPLICATION"
        || header.alg != "HS256"
        || header.kid != config.kid
        || claims.issuer != config.issuer
        || claims.audience != config.audience
        || claims.role != expected_role
        || claims.credential_id_sha256 != config.credential_id_sha256
        || !valid_identity(&claims.request_id)
        || claims.method != expected_method
        || claims.path_and_query != path_and_query
        || claims.body_sha256 != expected_body_sha256
        || claims.issued_at > now.saturating_add(HMAC_CLOCK_SKEW_SECONDS)
        || now.saturating_sub(claims.issued_at) > HMAC_WINDOW_SECONDS
        || claims.expires_at <= now
        || claims.expires_at <= claims.issued_at
        || claims.expires_at.saturating_sub(claims.issued_at) > HMAC_WINDOW_SECONDS
    {
        return None;
    }
    let mut mac = Hmac::<Sha256>::new_from_slice(config.secret.as_bytes()).ok()?;
    mac.update(HMAC_DOMAIN);
    mac.update(header_part.as_bytes());
    mac.update(b".");
    mac.update(claims_part.as_bytes());
    mac.verify_slice(&signature).ok()?;
    Some(claims.request_id)
}

fn snapshot_is_exact(
    snapshot: &RelayContainerShardPlacementExecutionTicketActivationReadSnapshot,
    query: &ExactReadQuery,
    application_database_identity_sha256: &str,
) -> bool {
    let ticket = &snapshot.ticket;
    let activation = &snapshot.activation;
    let context = &snapshot.context;
    let admin_id = activation.activated_by_admin_id.to_string();
    let expected_activation_digest = sha256_len_prefixed(
        ACTIVATION_DIGEST_DOMAIN,
        &[
            ACTIVATION_CONTRACT,
            &ticket.ticket_id_sha256,
            &ticket.ticket_digest_sha256,
            &activation.authority_claim_digest_sha256,
            &activation.authority_claim_acquired_receipt_sha256,
            &activation.authority_claim_operation_id_sha256,
            &ticket.activation_operation_id_sha256,
            &ticket.application_database_identity_sha256,
            &activation.authority_database_identity_sha256,
            &activation.authority_ledger_identity_sha256,
            &activation.authority_version_id,
            &activation.activation_credential_id_sha256,
            &admin_id,
            &activation.activation_request_id_sha256,
        ],
    );
    ticket.contract_version == 1
        && ticket.ticket_contract == TICKET_CONTRACT
        && activation.contract_version == 1
        && activation.activation_contract == ACTIVATION_CONTRACT
        && ticket.ticket_digest_sha256 == query.ticket_digest_sha256
        && activation.authority_claim_digest_sha256 == query.claim_digest_sha256
        && activation.activation_digest_sha256 == query.activation_digest_sha256
        && ticket.ticket_id_sha256 == activation.ticket_id_sha256
        && ticket.application_database_identity_sha256 == application_database_identity_sha256
        && ticket.authority_database_identity_sha256
            == activation.authority_database_identity_sha256
        && ticket.authority_ledger_identity_sha256 == activation.authority_ledger_identity_sha256
        && ticket.claim_operation_id_sha256 == activation.authority_claim_operation_id_sha256
        && ticket.activation_operation_id_sha256
            == activation.authority_activation_operation_id_sha256
        && valid_sha256(&ticket.ticket_digest_sha256)
        && valid_sha256(&activation.authority_claim_digest_sha256)
        && valid_sha256(&activation.authority_claim_acquired_receipt_sha256)
        && valid_sha256(&activation.activation_credential_id_sha256)
        && valid_sha256(&activation.activation_request_id_sha256)
        && activation.activation_digest_sha256 == expected_activation_digest
        && activation.activated_by_admin_id > 0
        && ticket.prepared_at > 0
        && activation.activated_at >= ticket.prepared_at
        && activation.activated_at < ticket.activation_deadline_at
        && ticket.activation_deadline_at <= ticket.execution_deadline_at
        && ticket.execution_deadline_at == context.campaign_expires_at
        && ticket.execution_deadline_at <= context.permit_expires_at
        && context.database_now > 0
}

fn ack_snapshot_is_exact(
    snapshot: &RelayContainerShardPlacementExecutionTicketAuthorityAckReadSnapshot,
    query: &ExactAckReadQuery,
    application_database_identity_sha256: &str,
) -> bool {
    let activation_snapshot = RelayContainerShardPlacementExecutionTicketActivationReadSnapshot {
        ticket: snapshot.ticket.clone(),
        activation: snapshot.activation.clone(),
        context: snapshot.context.clone(),
    };
    let activation_query = ExactReadQuery {
        ticket_digest_sha256: query.ticket_digest_sha256.clone(),
        claim_digest_sha256: query.claim_digest_sha256.clone(),
        activation_digest_sha256: query.activation_digest_sha256.clone(),
    };
    if !snapshot_is_exact(
        &activation_snapshot,
        &activation_query,
        application_database_identity_sha256,
    ) {
        return false;
    }
    let ticket = &snapshot.ticket;
    let activation = &snapshot.activation;
    let acknowledgement = &snapshot.acknowledgement;
    let context = &snapshot.context;
    let admin_id = acknowledgement.acknowledged_by_admin_id.to_string();
    let expected_acknowledgement_digest = sha256_len_prefixed(
        ACKNOWLEDGEMENT_DIGEST_DOMAIN,
        &[
            ACKNOWLEDGEMENT_CONTRACT,
            &ticket.ticket_id_sha256,
            &ticket.ticket_digest_sha256,
            &acknowledgement.authority_claim_digest_sha256,
            &acknowledgement.application_activation_digest_sha256,
            &acknowledgement.authority_activation_terminal_receipt_sha256,
            &acknowledgement.authority_ledger_head_sha256,
            &acknowledgement.authority_database_identity_sha256,
            &acknowledgement.authority_version_id,
            &acknowledgement.authority_read_credential_id_sha256,
            &admin_id,
            &acknowledgement.authority_read_request_id_sha256,
        ],
    );
    acknowledgement.contract_version == 1
        && acknowledgement.acknowledgement_contract == ACKNOWLEDGEMENT_CONTRACT
        && acknowledgement.ticket_id_sha256 == ticket.ticket_id_sha256
        && acknowledgement.application_ticket_digest_sha256 == ticket.ticket_digest_sha256
        && acknowledgement.authority_claim_digest_sha256 == activation.authority_claim_digest_sha256
        && acknowledgement.application_activation_digest_sha256
            == activation.activation_digest_sha256
        && acknowledgement.authority_database_identity_sha256
            == ticket.authority_database_identity_sha256
        && acknowledgement.authority_version_id == activation.authority_version_id
        && acknowledgement.authority_activation_terminal_receipt_sha256
            == acknowledgement.authority_ledger_head_sha256
        && acknowledgement.acknowledgement_digest_sha256 == query.acknowledgement_digest_sha256
        && acknowledgement.acknowledgement_digest_sha256 == expected_acknowledgement_digest
        && valid_identity(&ticket.controller_service_name)
        && valid_identity(&ticket.controller_baseline_version_id)
        && valid_identity(&ticket.controller_enabled_version_id)
        && ticket.controller_baseline_version_id != ticket.controller_enabled_version_id
        && valid_sha256(&ticket.controller_enable_operation_id_sha256)
        && valid_sha256(&acknowledgement.authority_activation_terminal_receipt_sha256)
        && valid_sha256(&acknowledgement.authority_read_credential_id_sha256)
        && valid_sha256(&acknowledgement.authority_read_request_id_sha256)
        && acknowledgement.acknowledged_by_admin_id > 0
        && acknowledgement.acknowledged_at >= activation.activated_at
        && acknowledgement.acknowledged_at < ticket.activation_deadline_at
        && context.campaign_sealed_at.is_none()
        && context.database_now < ticket.activation_deadline_at
        && context.database_now < ticket.execution_deadline_at
        && context.database_now < context.permit_expires_at
        && context.database_now < context.campaign_expires_at
}

fn decode_canonical_base64url(value: &str, max_bytes: usize) -> Option<Vec<u8>> {
    if value.is_empty()
        || value.contains('=')
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return None;
    }
    let decoded = URL_SAFE_NO_PAD.decode(value).ok()?;
    if decoded.len() > max_bytes || URL_SAFE_NO_PAD.encode(&decoded) != value {
        return None;
    }
    Some(decoded)
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

fn sha256_hex(value: &[u8]) -> String {
    Sha256::digest(value)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn runtime_flag(env: &Env, name: &str) -> bool {
    env.var(name)
        .ok()
        .is_some_and(|value| value.to_string() == "true")
}

fn runtime_value(env: &Env, name: &str) -> Option<String> {
    env.var(name)
        .ok()
        .map(|value| value.to_string())
        .filter(|value| !value.is_empty() && value == value.trim())
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

fn valid_key_id(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
}

fn valid_path_and_query(value: &str) -> bool {
    (1..=2048).contains(&value.len())
        && value.starts_with('/')
        && !value.bytes().any(|byte| matches!(byte, b'\r' | b'\n'))
}

fn protocol_error(status: u16, code: &'static str) -> WorkerResult<Response> {
    protocol_json(status, &json!({"error": {"code": code}}))
}

fn protocol_json<T: Serialize>(status: u16, value: &T) -> WorkerResult<Response> {
    let mut response = Response::from_json(value)?.with_status(status);
    response.headers_mut().set("Cache-Control", "no-store")?;
    response
        .headers_mut()
        .set("X-Content-Type-Options", "nosniff")?;
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> ReadConfig {
        ReadConfig {
            issuer: "cinatoken-shard-placement-authority-runtime-test".to_string(),
            audience: "cinatoken-rust-api-runtime-test".to_string(),
            kid: "activation-read-current-v1".to_string(),
            credential_id_sha256: "a".repeat(64),
            secret: "0123456789abcdef0123456789abcdef".to_string(),
            application_database_identity_sha256: "b".repeat(64),
        }
    }

    fn sign(path_and_query: &str, now: i64) -> String {
        let header_part = URL_SAFE_NO_PAD.encode(
            br#"{"typ":"CINATOKEN-SHARD-PLACEMENT-APPLICATION","alg":"HS256","kid":"activation-read-current-v1"}"#,
        );
        let claims_part = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&json!({
                "issuer": "cinatoken-shard-placement-authority-runtime-test",
                "audience": "cinatoken-rust-api-runtime-test",
                "role": "activation_read",
                "credential_id_sha256": "a".repeat(64),
                "request_id": "operation-4-activation-read-1",
                "method": "GET",
                "path_and_query": path_and_query,
                "body_sha256": EMPTY_BODY_SHA256,
                "issued_at": now - 1,
                "expires_at": now + 30,
            }))
            .unwrap(),
        );
        let mut mac = Hmac::<Sha256>::new_from_slice(config().secret.as_bytes()).unwrap();
        mac.update(HMAC_DOMAIN);
        mac.update(header_part.as_bytes());
        mac.update(b".");
        mac.update(claims_part.as_bytes());
        format!(
            "{header_part}.{claims_part}.{}",
            URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
        )
    }

    fn sign_post(path_and_query: &str, body_sha256: &str, now: i64) -> String {
        let header_part = URL_SAFE_NO_PAD.encode(
            br#"{"typ":"CINATOKEN-SHARD-PLACEMENT-APPLICATION","alg":"HS256","kid":"activation-read-current-v1"}"#,
        );
        let claims_part = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&json!({
                "issuer": "cinatoken-shard-placement-authority-runtime-test",
                "audience": "cinatoken-rust-api-runtime-test",
                "role": "pre_enable_grant",
                "credential_id_sha256": "a".repeat(64),
                "request_id": "operation-5-pre-enable-grant-1",
                "method": "POST",
                "path_and_query": path_and_query,
                "body_sha256": body_sha256,
                "issued_at": now - 1,
                "expires_at": now + 30,
            }))
            .unwrap(),
        );
        let mut mac = Hmac::<Sha256>::new_from_slice(config().secret.as_bytes()).unwrap();
        mac.update(HMAC_DOMAIN);
        mac.update(header_part.as_bytes());
        mac.update(b".");
        mac.update(claims_part.as_bytes());
        format!(
            "{header_part}.{claims_part}.{}",
            URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
        )
    }

    fn sign_consumption_post(path_and_query: &str, body_sha256: &str, now: i64) -> String {
        let header_part = URL_SAFE_NO_PAD.encode(
            br#"{"typ":"CINATOKEN-SHARD-PLACEMENT-APPLICATION","alg":"HS256","kid":"activation-read-current-v1"}"#,
        );
        let claims_part = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&json!({
                "issuer": "cinatoken-shard-placement-authority-runtime-test",
                "audience": "cinatoken-rust-api-runtime-test",
                "role": "dispatch_consumption",
                "credential_id_sha256": "a".repeat(64),
                "request_id": "operation-5-dispatch-consumption-1",
                "method": "POST",
                "path_and_query": path_and_query,
                "body_sha256": body_sha256,
                "issued_at": now - 1,
                "expires_at": now + 30,
            }))
            .unwrap(),
        );
        let mut mac = Hmac::<Sha256>::new_from_slice(config().secret.as_bytes()).unwrap();
        mac.update(HMAC_DOMAIN);
        mac.update(header_part.as_bytes());
        mac.update(b".");
        mac.update(claims_part.as_bytes());
        format!(
            "{header_part}.{claims_part}.{}",
            URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
        )
    }

    fn dispatch_consumption_command() -> DispatchConsumptionCommand {
        DispatchConsumptionCommand {
            schema_version: 1,
            contract: DISPATCH_CONSUMPTION_CONTRACT.to_string(),
            ticket_id_sha256: "01".repeat(32),
            authorization_id_sha256: "02".repeat(32),
            application_database_identity_sha256: "03".repeat(32),
            application_version_id: "application-version-1".to_string(),
            application_grant_digest_sha256: "04".repeat(32),
            authority_claim_digest_sha256: "05".repeat(32),
            authority_dispatch_outbox_digest_sha256: "06".repeat(32),
            application_grant_receipt_digest_sha256: "07".repeat(32),
            operation_five_start_receipt_sha256: "08".repeat(32),
            authority_dispatch_claim_digest_sha256:
                "a5613effb227e283ff2a2c10cc6c8fa92a6ad5299aa496c95c26add4e87a90cc".to_string(),
            authority_database_identity_sha256: "09".repeat(32),
            authority_ledger_identity_sha256: "0a".repeat(32),
            authority_ledger_head_sha256: "08".repeat(32),
            authority_version_id: "authority-version-1".to_string(),
            dispatch_owner_sha256: "0b".repeat(32),
            lease_token_sha256: "0c".repeat(32),
            lease_generation: 1,
            lease_expires_at: 1_800_000_100,
            normal_deadline_at: 1_800_000_200,
            permit_expires_at: 1_800_000_300,
            dispatch_claim_credential_id_sha256: "0d".repeat(32),
            dispatch_claim_request_id_sha256: "0e".repeat(32),
            command_dispatch_claim_request_id_sha256: "0f".repeat(32),
            authority_dispatch_claimed_at: 1_800_000_000,
            controller_service_name: "cinatoken-container-controller-staging".to_string(),
            controller_enable_operation_id_sha256: "10".repeat(32),
            controller_baseline_version_id: "controller-baseline-v1".to_string(),
            controller_enabled_version_id: "controller-enabled-v1".to_string(),
            send_attempt_limit: 1,
            retry_limit: 0,
            missing_readback_allows_resend: 0,
            dispatch_consumption_request_id_sha256: "11".repeat(32),
        }
    }

    fn path() -> String {
        format!(
            "/internal/v1/shard-placement/execution-ticket-activations/{}?ticketDigestSha256={}&claimDigestSha256={}&activationDigestSha256={}",
            "1".repeat(64),
            "2".repeat(64),
            "3".repeat(64),
            "4".repeat(64),
        )
    }

    #[test]
    fn exact_query_is_canonical_and_rejects_extras() {
        let parsed = parse_exact_query(&path(), &"1".repeat(64)).expect("query");
        assert_eq!(parsed.ticket_digest_sha256, "2".repeat(64));
        assert_eq!(parsed.claim_digest_sha256, "3".repeat(64));
        assert_eq!(parsed.activation_digest_sha256, "4".repeat(64));
        assert!(parse_exact_query(&(path() + "&extra=1"), &"1".repeat(64)).is_none());
        assert!(parse_exact_query(
            &path().replace("ticketDigest", "TicketDigest"),
            &"1".repeat(64)
        )
        .is_none());
    }

    #[test]
    fn exact_ack_query_is_canonical_and_rejects_extras() {
        let path = format!(
            "/internal/v1/shard-placement/execution-ticket-authority-acks/{}?ticketDigestSha256={}&claimDigestSha256={}&activationDigestSha256={}&acknowledgementDigestSha256={}",
            "1".repeat(64),
            "2".repeat(64),
            "3".repeat(64),
            "4".repeat(64),
            "5".repeat(64),
        );
        let parsed = parse_exact_ack_query(&path, &"1".repeat(64)).expect("acknowledgement query");
        assert_eq!(parsed.ticket_digest_sha256, "2".repeat(64));
        assert_eq!(parsed.claim_digest_sha256, "3".repeat(64));
        assert_eq!(parsed.activation_digest_sha256, "4".repeat(64));
        assert_eq!(parsed.acknowledgement_digest_sha256, "5".repeat(64));
        assert!(parse_exact_ack_query(&(path + "&extra=1"), &"1".repeat(64)).is_none());
    }

    #[test]
    fn authority_ack_digest_matches_authority_client_fixed_vector() {
        assert_eq!(
            sha256_len_prefixed(
                ACKNOWLEDGEMENT_DIGEST_DOMAIN,
                &[
                    ACKNOWLEDGEMENT_CONTRACT,
                    &"1".repeat(64),
                    &"2".repeat(64),
                    &"9".repeat(64),
                    &"d".repeat(64),
                    &"e".repeat(64),
                    &"e".repeat(64),
                    &"6".repeat(64),
                    "authority-version-1",
                    &"f".repeat(64),
                    "7",
                    &"0".repeat(64),
                ],
            ),
            "afd96cd6232295c41963fb3c9f88916aa3a131ab7a66d027b3dfed85665be02c"
        );
    }

    #[test]
    fn authority_hmac_binds_exact_path_and_time_window() {
        let now = 1_750_000_000;
        let exact_path = path();
        let token = sign(&exact_path, now);
        assert_eq!(
            verify_token(&token, &config(), "activation_read", &exact_path, now,).as_deref(),
            Some("operation-4-activation-read-1")
        );
        assert!(verify_token(
            &token,
            &config(),
            "activation_read",
            &(exact_path + "&drift=1"),
            now
        )
        .is_none());
        assert!(verify_token(&token, &config(), "activation_read", &path(), now + 120).is_none());
    }

    #[test]
    fn authority_hmac_rejects_signature_and_credential_drift() {
        let now = 1_750_000_000;
        let path = path();
        let token = sign(&path, now);
        let mut wrong_secret = config();
        wrong_secret.secret = "fedcba9876543210fedcba9876543210".to_string();
        assert!(verify_token(&token, &wrong_secret, "activation_read", &path, now).is_none());
        let mut wrong_credential = config();
        wrong_credential.credential_id_sha256 = "c".repeat(64);
        assert!(verify_token(&token, &wrong_credential, "activation_read", &path, now).is_none());
        assert!(verify_token(&token, &config(), "authority_ack_read", &path, now).is_none());
    }

    #[test]
    fn authority_grant_hmac_binds_post_path_and_body() {
        let now = 1_750_000_000;
        let path = format!(
            "/internal/v1/shard-placement/pre-enable-grants/{}",
            "1".repeat(64)
        );
        let body_sha256 = "2".repeat(64);
        let token = sign_post(&path, &body_sha256, now);
        assert_eq!(
            verify_token_for_request(
                &token,
                &config(),
                "pre_enable_grant",
                "POST",
                &path,
                &body_sha256,
                now,
            )
            .as_deref(),
            Some("operation-5-pre-enable-grant-1")
        );
        assert!(verify_token_for_request(
            &token,
            &config(),
            "pre_enable_grant",
            "GET",
            &path,
            &body_sha256,
            now,
        )
        .is_none());
        assert!(verify_token_for_request(
            &token,
            &config(),
            "pre_enable_grant",
            "POST",
            &path,
            &"3".repeat(64),
            now,
        )
        .is_none());
    }

    #[test]
    fn dispatch_consumption_hmac_binds_role_post_path_and_body() {
        let now = 1_750_000_000;
        let path = format!(
            "/internal/v1/shard-placement/dispatch-consumptions/{}",
            "1".repeat(64)
        );
        let body_sha256 = "2".repeat(64);
        let token = sign_consumption_post(&path, &body_sha256, now);
        assert_eq!(
            verify_token_for_request(
                &token,
                &config(),
                "dispatch_consumption",
                "POST",
                &path,
                &body_sha256,
                now,
            )
            .as_deref(),
            Some("operation-5-dispatch-consumption-1")
        );
        for role in ["pre_enable_grant", "activation_read", "authority_ack_read"] {
            assert!(verify_token_for_request(
                &token,
                &config(),
                role,
                "POST",
                &path,
                &body_sha256,
                now,
            )
            .is_none());
        }
        assert!(verify_token_for_request(
            &token,
            &config(),
            "dispatch_consumption",
            "POST",
            &path,
            &"3".repeat(64),
            now,
        )
        .is_none());
    }

    #[test]
    fn four_role_credentials_are_pairwise_disjoint_by_kid_fingerprint_and_secret() {
        let activation = vec![config()];
        let mut acknowledgement = config();
        acknowledgement.kid = "ack-read-current-v1".to_string();
        acknowledgement.credential_id_sha256 = "c".repeat(64);
        acknowledgement.secret = "abcdef0123456789abcdef0123456789".to_string();
        let acknowledgement = Some(vec![acknowledgement]);
        let mut grant = config();
        grant.kid = "grant-current-v1".to_string();
        grant.credential_id_sha256 = "d".repeat(64);
        grant.secret = "1234567890abcdef1234567890abcdef".to_string();
        let grant = Some(vec![grant]);
        let mut consumption = config();
        consumption.kid = "consumption-current-v1".to_string();
        consumption.credential_id_sha256 = "e".repeat(64);
        consumption.secret = "fedcba0987654321fedcba0987654321".to_string();
        let consumption = Some(vec![consumption]);
        assert!(optional_config_inventories_are_disjoint(
            &activation,
            &[&acknowledgement, &grant, &consumption],
        ));

        let mut reused_kid = consumption.clone();
        reused_kid.as_mut().unwrap()[0].kid = activation[0].kid.clone();
        assert!(!optional_config_inventories_are_disjoint(
            &activation,
            &[&acknowledgement, &grant, &reused_kid],
        ));

        let mut reused_fingerprint = consumption.clone();
        reused_fingerprint.as_mut().unwrap()[0].credential_id_sha256 =
            acknowledgement.as_ref().unwrap()[0]
                .credential_id_sha256
                .clone();
        assert!(!optional_config_inventories_are_disjoint(
            &activation,
            &[&acknowledgement, &grant, &reused_fingerprint],
        ));

        let mut reused_secret = consumption.clone();
        reused_secret.as_mut().unwrap()[0].secret = grant.as_ref().unwrap()[0].secret.clone();
        assert!(!optional_config_inventories_are_disjoint(
            &activation,
            &[&acknowledgement, &grant, &reused_secret],
        ));
    }

    #[test]
    fn protocol_source_enforces_default_gate_and_no_store() {
        let source = include_str!("container_shard_placement_activation_read.rs");
        assert!(source.contains("RELAY_CONTAINER_SHARD_PLACEMENT_ACTIVATION_READ_ENABLED"));
        assert!(source.contains("RELAY_CONTAINER_SHARD_PLACEMENT_AUTHORITY_ACK_READ_ENABLED"));
        assert!(source.contains("RELAY_CONTAINER_SHARD_PLACEMENT_PRE_ENABLE_GRANT_WRITE_ENABLED"));
        assert!(
            source.contains("RELAY_CONTAINER_SHARD_PLACEMENT_DISPATCH_CONSUMPTION_WRITE_ENABLED")
        );
        assert!(
            source.contains("RELAY_CONTAINER_SHARD_PLACEMENT_ACTIVATION_READ_HMAC_PREVIOUS_SECRET")
        );
        assert!(source
            .contains("RELAY_CONTAINER_SHARD_PLACEMENT_AUTHORITY_ACK_READ_HMAC_PREVIOUS_SECRET"));
        assert!(source
            .contains("RELAY_CONTAINER_SHARD_PLACEMENT_PRE_ENABLE_GRANT_HMAC_PREVIOUS_SECRET"));
        assert!(source
            .contains("RELAY_CONTAINER_SHARD_PLACEMENT_DISPATCH_CONSUMPTION_HMAC_PREVIOUS_SECRET"));
        assert!(source.contains("env.secret(secret_env)"));
        assert!(source.contains("Cache-Control\", \"no-store"));
        assert!(source.contains("X-Content-Type-Options"));
        assert!(source
            .contains("relay_container_shard_placement_execution_ticket_activation_read_snapshot"));
        assert!(source.contains(
            "relay_container_shard_placement_execution_ticket_authority_ack_read_snapshot"
        ));
        assert!(source.contains("create_relay_container_shard_placement_pre_enable_grant"));
        assert!(source.contains("create_relay_container_shard_placement_dispatch_consumption"));
    }

    #[test]
    fn pre_enable_grant_digest_matches_authority_client_fixed_vector() {
        let digest = sha256_len_prefixed(
            PRE_ENABLE_GRANT_DIGEST_DOMAIN,
            &[
                PRE_ENABLE_GRANT_CONTRACT,
                &"1".repeat(64),
                &"2".repeat(64),
                &"3".repeat(64),
                &"4".repeat(64),
                &"5".repeat(64),
                &"6".repeat(64),
                &"7".repeat(64),
                &"8".repeat(64),
                &"9".repeat(64),
                &"a".repeat(64),
                &"b".repeat(64),
                &"c".repeat(64),
                &"9".repeat(64),
                "authority-version-1",
                "controller-staging",
                &"d".repeat(64),
                "controller-baseline",
                "controller-enabled",
                &"e".repeat(64),
                &"f".repeat(64),
            ],
        );
        assert_eq!(
            digest,
            "8ee874989d2ad6a1754062891241957beda37a82008d2ab62b6c81ba84092df7"
        );
    }

    #[test]
    fn dispatch_claim_digest_matches_authority_typescript_fixed_vector() {
        let command = dispatch_consumption_command();
        assert_eq!(
            authority_dispatch_claim_digest(&command).as_deref(),
            Some("a5613effb227e283ff2a2c10cc6c8fa92a6ad5299aa496c95c26add4e87a90cc")
        );
        assert!(dispatch_consumption_command_is_valid(
            &command,
            &"03".repeat(32),
        ));
    }

    #[test]
    fn dispatch_consumption_digest_matches_fixed_vector() {
        let command = dispatch_consumption_command();
        assert_eq!(
            dispatch_consumption_digest(
                &command,
                &"14".repeat(32),
                &"12".repeat(32),
                &"13".repeat(32),
            ),
            "1b9f27aba0fe2d26ab23f04746ffcbe6f544e2893357d57e750c1f73a30aaabf"
        );
    }

    #[test]
    fn dispatch_consumption_command_requires_flat_canonical_json() {
        let command = dispatch_consumption_command();
        let value = serde_json::to_value(&command).unwrap();
        let mut canonical = String::new();
        write_canonical_json_value(&value, &mut canonical).unwrap();
        assert!(parse_dispatch_consumption_command(canonical.as_bytes()).is_some());
        assert!(parse_dispatch_consumption_command(format!(" {canonical}").as_bytes()).is_none());
        let mut with_extra = value;
        with_extra
            .as_object_mut()
            .unwrap()
            .insert("extra".to_string(), serde_json::Value::Bool(true));
        let mut canonical_with_extra = String::new();
        write_canonical_json_value(&with_extra, &mut canonical_with_extra).unwrap();
        assert!(parse_dispatch_consumption_command(canonical_with_extra.as_bytes()).is_none());
    }

    #[test]
    fn exact_dispatch_consumption_replay_precedes_version_and_live_context_checks() {
        let source = include_str!("container_shard_placement_activation_read.rs");
        let handler = source
            .split("pub async fn create_dispatch_consumption")
            .nth(1)
            .unwrap()
            .split("fn request_has_forbidden_ambient_headers")
            .next()
            .unwrap();
        let exact_replay = handler.find("if let Some(existing) = existing").unwrap();
        let ticket_read = handler
            .find("relay_container_shard_placement_execution_ticket(&db")
            .unwrap();
        let current_version = handler.find("CF_VERSION_METADATA").unwrap();
        assert!(exact_replay < ticket_read);
        assert!(exact_replay < current_version);
        assert!(handler[exact_replay..ticket_read]
            .contains("dispatch_consumption_response(200, \"exact_replay\""));
    }

    #[test]
    fn dispatch_consumption_route_is_registered_in_router_and_contract_inventory() {
        let source = include_str!("lib.rs");
        let path = "/internal/v1/shard-placement/dispatch-consumptions/:ticket_id";
        assert_eq!(source.matches(path).count(), 2);
        assert!(source
            .contains("container_shard_placement_activation_read::create_dispatch_consumption"));
    }

    #[test]
    fn activation_digest_matches_typescript_fixed_vector() {
        let digest = sha256_len_prefixed(
            ACTIVATION_DIGEST_DOMAIN,
            &[
                ACTIVATION_CONTRACT,
                &"1".repeat(64),
                &"2".repeat(64),
                &"9".repeat(64),
                &"a".repeat(64),
                &"b".repeat(64),
                &"c".repeat(64),
                &"5".repeat(64),
                &"6".repeat(64),
                &"7".repeat(64),
                "authority-version-1",
                &"d".repeat(64),
                "7",
                &"e".repeat(64),
            ],
        );
        assert_eq!(
            digest,
            "1eb4e9925af7fd7c6f8dae9be6a17720cbfdd67363600f3baa567c73b1173d9c"
        );
    }
}
