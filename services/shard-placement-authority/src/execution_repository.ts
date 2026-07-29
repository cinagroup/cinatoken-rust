import type {
  ExecutionClaim,
  ExecutionOperation,
  ExecutionReceipt,
} from "./execution_protocol";
import {
  RepositoryConflictError,
  RepositoryNotFoundError,
  RepositoryUnavailableError,
} from "./repository";

const CLAIM_COLUMNS = [
  "authorization_id_sha256",
  "permit_subject_digest_sha256",
  "execution_nonce_sha256",
  "application_ticket_id_sha256",
  "application_ticket_digest_sha256",
  "application_database_identity_sha256",
  "authority_database_identity_sha256",
  "campaign_id",
  "campaign_nonce_sha256",
  "claim_scope",
  "execution_plan_sha256",
  "release_sha256",
  "publication_sha256",
  "execution_activation_sha256",
  "runner_build_sha256",
  "claim_owner_sha256",
  "lease_owner_sha256",
  "ledger_identity_sha256",
  "lease_token_sha256",
  "lease_generation",
  "lease_expires_at",
  "baseline_operation_id_sha256",
  "baseline_terminal_digest_sha256",
  "preparation_operation_id_sha256",
  "claim_operation_id_sha256",
  "operation_schedule_sha256",
  "claim_credential_id_sha256",
  "claim_request_id_sha256",
  "claim_digest_sha256",
  "claim_acquired_receipt_digest_sha256",
  "permit_expires_at",
  "normal_deadline_at",
  "recovery_deadline_at",
  "status",
  "ledger_version",
  "ledger_head_sha256",
  "last_completed_ordinal",
  "inflight_operation_ordinal",
  "inflight_operation_id_sha256",
  "inflight_request_sha256",
  "inflight_cloudflare_request_id_sha256",
  "inflight_started_generation",
  "inflight_started_owner_sha256",
  "inflight_started_lease_token_sha256",
  "inflight_readback_only",
  "enable_intent_seen",
  "disable_confirmed",
  "application_activation_digest_sha256",
  "ticket_activation_confirmed",
  "renewal_count",
  "takeover_count",
  "generated_at",
  "claimed_at",
  "updated_at",
  "terminal_at",
] as const;
const OPERATION_COLUMNS = [
  "authorization_id_sha256",
  "ordinal",
  "operation_id_sha256",
  "kind",
  "shard_index",
] as const;
const RECEIPT_COLUMNS = [
  "authorization_id_sha256",
  "sequence",
  "event_kind",
  "claim_digest_sha256",
  "execution_plan_sha256",
  "ledger_identity_sha256",
  "operation_ordinal",
  "operation_id_sha256",
  "operation_kind",
  "shard_index",
  "predecessor_receipt_sha256",
  "request_sha256",
  "response_sha256",
  "cloudflare_request_id_sha256",
  "evidence_sha256",
  "safety_reason",
  "outcome",
  "lease_owner_sha256",
  "lease_token_sha256",
  "lease_generation",
  "lease_expires_at",
  "receipt_credential_id_sha256",
  "request_id_sha256",
  "receipt_digest_sha256",
  "recorded_at",
] as const;
const OPERATION_FIVE_ADMISSION_COLUMNS = [
  "authorization_id_sha256",
  "contract_version",
  "confirmation_contract",
  "claim_digest_sha256",
  "application_ticket_id_sha256",
  "application_ticket_digest_sha256",
  "application_database_identity_sha256",
  "application_activation_digest_sha256",
  "authority_activation_terminal_receipt_sha256",
  "authority_ledger_head_sha256",
  "authority_database_identity_sha256",
  "authority_version_id",
  "application_acknowledgement_digest_sha256",
  "application_version_id",
  "application_read_credential_id_sha256",
  "application_read_request_id_sha256",
  "application_response_sha256",
  "application_response_bytes",
  "enable_credential_id_sha256",
  "enable_request_id_sha256",
  "command_enable_request_id_sha256",
  "enable_operation_request_sha256",
  "confirmation_digest_sha256",
  "operation_start_receipt_digest_sha256",
  "confirmed_at",
] as const;
const OPERATION_FIVE_DISPATCH_OUTBOX_COLUMNS = [
  "authorization_id_sha256",
  "contract_version",
  "dispatch_contract",
  "claim_digest_sha256",
  "application_ticket_id_sha256",
  "application_ticket_digest_sha256",
  "application_database_identity_sha256",
  "application_activation_digest_sha256",
  "application_acknowledgement_digest_sha256",
  "operation_five_admission_digest_sha256",
  "operation_five_start_receipt_sha256",
  "authority_database_identity_sha256",
  "authority_version_id",
  "authority_ledger_head_sha256",
  "application_version_id",
  "application_read_credential_id_sha256",
  "application_read_request_id_sha256",
  "application_response_sha256",
  "application_response_bytes",
  "application_database_now",
  "dispatch_credential_id_sha256",
  "dispatch_request_id_sha256",
  "command_dispatch_request_id_sha256",
  "controller_service_name",
  "controller_enable_operation_id_sha256",
  "controller_baseline_version_id",
  "controller_enabled_version_id",
  "dispatch_request_sha256",
  "outbox_digest_sha256",
  "outbox_state",
  "prepared_at",
] as const;
const OPERATION_FIVE_APPLICATION_GRANT_COLUMNS = [
  "authorization_id_sha256",
  "contract_version",
  "receipt_contract",
  "claim_digest_sha256",
  "application_ticket_id_sha256",
  "application_ticket_digest_sha256",
  "application_database_identity_sha256",
  "application_activation_digest_sha256",
  "application_acknowledgement_digest_sha256",
  "operation_five_admission_digest_sha256",
  "operation_five_start_receipt_sha256",
  "authority_dispatch_outbox_digest_sha256",
  "application_grant_digest_sha256",
  "application_grant_credential_id_sha256",
  "application_grant_request_id_sha256",
  "application_version_id",
  "application_response_sha256",
  "application_response_bytes",
  "application_database_now",
  "application_granted_at",
  "authority_database_identity_sha256",
  "authority_ledger_identity_sha256",
  "authority_ledger_head_sha256",
  "authority_version_id",
  "grant_credential_id_sha256",
  "grant_request_id_sha256",
  "command_grant_request_id_sha256",
  "controller_service_name",
  "controller_enable_operation_id_sha256",
  "controller_baseline_version_id",
  "controller_enabled_version_id",
  "receipt_digest_sha256",
  "recorded_at",
] as const;
const OPERATION_FIVE_DISPATCH_CLAIM_COLUMNS = [
  "authorization_id_sha256",
  "contract_version",
  "claim_contract",
  "claim_digest_sha256",
  "application_ticket_id_sha256",
  "application_database_identity_sha256",
  "authority_dispatch_outbox_digest_sha256",
  "application_grant_receipt_digest_sha256",
  "application_grant_digest_sha256",
  "operation_five_start_receipt_sha256",
  "authority_database_identity_sha256",
  "authority_ledger_identity_sha256",
  "authority_ledger_head_sha256",
  "authority_version_id",
  "application_version_id",
  "dispatch_owner_sha256",
  "lease_token_sha256",
  "lease_generation",
  "lease_expires_at",
  "normal_deadline_at",
  "permit_expires_at",
  "dispatch_claim_credential_id_sha256",
  "dispatch_claim_request_id_sha256",
  "command_dispatch_claim_request_id_sha256",
  "controller_service_name",
  "controller_enable_operation_id_sha256",
  "controller_baseline_version_id",
  "controller_enabled_version_id",
  "send_attempt_limit",
  "retry_limit",
  "missing_readback_allows_resend",
  "dispatch_claim_digest_sha256",
  "claim_state",
  "claimed_at",
] as const;
const OPERATION_FIVE_DISPATCH_CLAIM_TRIGGERS = [
  "shard_placement_authority_operation_five_dispatch_claim_delete_guard",
  "shard_placement_authority_operation_five_dispatch_claim_insert_guard",
  "shard_placement_authority_operation_five_dispatch_claim_update_guard",
] as const;
const OPERATION_FIVE_DISPATCH_CONSUMPTION_COLUMNS = [
  "authorization_id_sha256",
  "contract_version",
  "receipt_contract",
  "claim_digest_sha256",
  "application_ticket_id_sha256",
  "campaign_id",
  "application_database_identity_sha256",
  "application_version_id",
  "application_grant_receipt_digest_sha256",
  "application_grant_digest_sha256",
  "authority_dispatch_outbox_digest_sha256",
  "operation_five_start_receipt_sha256",
  "authority_dispatch_claim_digest_sha256",
  "authority_database_identity_sha256",
  "authority_ledger_identity_sha256",
  "authority_ledger_head_sha256",
  "authority_version_id",
  "dispatch_owner_sha256",
  "lease_token_sha256",
  "lease_generation",
  "lease_expires_at",
  "normal_deadline_at",
  "permit_expires_at",
  "dispatch_claim_credential_id_sha256",
  "dispatch_claim_request_id_sha256",
  "command_dispatch_claim_request_id_sha256",
  "authority_dispatch_claimed_at",
  "controller_service_name",
  "controller_enable_operation_id_sha256",
  "controller_baseline_version_id",
  "controller_enabled_version_id",
  "send_attempt_limit",
  "retry_limit",
  "missing_readback_allows_resend",
  "application_dispatch_consumption_digest_sha256",
  "application_dispatch_consumption_credential_id_sha256",
  "application_dispatch_consumption_request_id_sha256",
  "command_dispatch_consumption_request_id_sha256",
  "application_consumption_state",
  "application_consumed_at",
  "application_response_sha256",
  "application_response_bytes",
  "consume_credential_id_sha256",
  "consume_request_id_sha256",
  "command_consume_request_id_sha256",
  "receipt_digest_sha256",
  "recorded_at",
] as const;
const OPERATION_FIVE_DISPATCH_CONSUMPTION_TRIGGERS = [
  "shard_placement_authority_operation_five_dispatch_consumption_delete_guard",
  "shard_placement_authority_operation_five_dispatch_consumption_insert_guard",
  "shard_placement_authority_operation_five_dispatch_consumption_update_guard",
] as const;
const OPERATION_FIVE_DISPATCH_CONSUMPTION_RECOVERY_COLUMNS = [
  "authorization_id_sha256",
  "contract_version",
  "recovery_contract",
  "claim_digest_sha256",
  "application_ticket_id_sha256",
  "campaign_id",
  "application_database_identity_sha256",
  "application_version_id",
  "authority_dispatch_claim_digest_sha256",
  "application_dispatch_consumption_digest_sha256",
  "application_dispatch_consumption_credential_id_sha256",
  "application_dispatch_consumption_request_id_sha256",
  "command_dispatch_consumption_request_id_sha256",
  "application_consumed_at",
  "application_history_read_credential_id_sha256",
  "application_history_read_request_id_sha256",
  "application_response_sha256",
  "application_response_bytes",
  "application_database_now",
  "recovery_credential_id_sha256",
  "recovery_request_id_sha256",
  "command_recovery_request_id_sha256",
  "retention_deadline_at",
  "receipt_digest_sha256",
  "recovery_evidence_digest_sha256",
  "recorded_at",
] as const;
const OPERATION_FIVE_DISPATCH_CONSUMPTION_RECOVERY_TRIGGERS = [
  "shard_placement_authority_operation_five_dispatch_consumption_recovery_delete_guard",
  "shard_placement_authority_operation_five_dispatch_consumption_recovery_insert_guard",
  "shard_placement_authority_operation_five_dispatch_consumption_recovery_update_guard",
] as const;
const OPERATION_FIVE_SEND_ATTEMPT_COLUMNS = [
  "authorization_id_sha256",
  "contract_version",
  "attempt_contract",
  "attempt_generation",
  "retry_count",
  "retry_limit",
  "send_attempt_limit",
  "send_authority_state",
  "claim_digest_sha256",
  "authority_dispatch_claim_digest_sha256",
  "dispatch_consumption_receipt_digest_sha256",
  "application_dispatch_consumption_digest_sha256",
  "application_ticket_id_sha256",
  "campaign_id",
  "application_database_identity_sha256",
  "application_version_id",
  "authority_database_identity_sha256",
  "authority_ledger_identity_sha256",
  "authority_ledger_head_sha256",
  "authority_version_id",
  "dispatch_owner_sha256",
  "lease_token_sha256",
  "lease_generation",
  "controller_service_name",
  "controller_enable_operation_id_sha256",
  "controller_baseline_version_id",
  "controller_enabled_version_id",
  "controller_command_contract",
  "controller_command_digest_sha256",
  "gateway_idempotency_contract",
  "gateway_idempotency_key_sha256",
  "send_credential_id_sha256",
  "send_request_id_sha256",
  "command_send_attempt_request_id_sha256",
  "controller_request_sent",
  "gateway_request_sent",
  "attempt_digest_sha256",
  "created_at",
] as const;
const OPERATION_FIVE_SEND_ATTEMPT_TRIGGERS = [
  "shard_placement_authority_operation_five_send_attempt_clock_guard",
  "shard_placement_authority_operation_five_send_attempt_delete_guard",
  "shard_placement_authority_operation_five_send_attempt_identity_guard",
  "shard_placement_authority_operation_five_send_attempt_live_guard",
  "shard_placement_authority_operation_five_send_attempt_source_guard",
  "shard_placement_authority_operation_five_send_attempt_update_guard",
] as const;
const OPERATION_FIVE_SEND_ATTEMPT_EVENT_COLUMNS = [
  "authorization_id_sha256",
  "attempt_digest_sha256",
  "event_sequence",
  "contract_version",
  "event_contract",
  "event_kind",
  "from_state",
  "to_state",
  "event_semantics",
  "predecessor_event_digest_sha256",
  "dispatch_consumption_receipt_digest_sha256",
  "controller_command_digest_sha256",
  "gateway_idempotency_key_sha256",
  "controller_request_sent",
  "gateway_request_sent",
  "event_digest_sha256",
  "recorded_at",
] as const;
const OPERATION_FIVE_SEND_ATTEMPT_EVENT_TRIGGERS = [
  "shard_placement_authority_operation_five_send_attempt_event_clock_guard",
  "shard_placement_authority_operation_five_send_attempt_event_delete_guard",
  "shard_placement_authority_operation_five_send_attempt_event_insert_guard",
  "shard_placement_authority_operation_five_send_attempt_event_update_guard",
] as const;
const OPERATION_FIVE_GATEWAY_EVENT_COLUMNS = [
  "authorization_id_sha256",
  "attempt_digest_sha256",
  "send_started_event_digest_sha256",
  "event_sequence",
  "contract_version",
  "event_contract",
  "event_kind",
  "predecessor_event_digest_sha256",
  "gateway_idempotency_key_sha256",
  "controller_command_digest_sha256",
  "gateway_credential_role",
  "gateway_credential_id_sha256",
  "gateway_request_id_sha256",
  "gateway_response_sha256",
  "gateway_response_bytes",
  "gateway_version_id",
  "mutation_request_sha256",
  "result_classification",
  "result_http_status",
  "result_response_body_sha256",
  "result_response_request_id_sha256",
  "result_response_bytes",
  "status_classification",
  "deployments_http_status",
  "version_http_status",
  "deployment_set_sha256",
  "target_version_sha256",
  "status_response_request_id_sha256",
  "observation_digest_sha256",
  "gateway_recorded_at",
  "target_stable",
  "required_matching_observations",
  "stability_minimum_seconds",
  "stability_predecessor_observation_digest_sha256",
  "stability_predecessor_recorded_at",
  "event_digest_sha256",
  "recorded_at",
] as const;
const OPERATION_FIVE_GATEWAY_EVENT_TRIGGERS = [
  "shard_placement_authority_operation_five_gateway_closed_guard",
  "shard_placement_authority_operation_five_gateway_event_append",
  "shard_placement_authority_operation_five_gateway_event_delete_guard",
  "shard_placement_authority_operation_five_gateway_event_insert_guard",
  "shard_placement_authority_operation_five_gateway_event_update_guard",
] as const;
const OPERATION_FIVE_TERMINAL_COLUMNS = [
  "authorization_id_sha256",
  "contract_version",
  "terminal_contract",
  "claim_digest_sha256",
  "claim_owner_sha256",
  "lease_owner_sha256",
  "lease_token_sha256",
  "lease_generation",
  "attempt_digest_sha256",
  "send_started_event_digest_sha256",
  "stable_gateway_event_sequence",
  "stable_gateway_event_digest_sha256",
  "stable_gateway_predecessor_event_digest_sha256",
  "stable_gateway_request_id_sha256",
  "stable_gateway_response_sha256",
  "stable_gateway_response_bytes",
  "stable_observation_digest_sha256",
  "stable_status_response_request_id_sha256",
  "stable_gateway_recorded_at",
  "deployment_set_sha256",
  "target_version_sha256",
  "gateway_version_id",
  "controller_service_name",
  "controller_enabled_version_id",
  "controller_command_digest_sha256",
  "gateway_idempotency_key_sha256",
  "authority_database_identity_sha256",
  "authority_ledger_identity_sha256",
  "authority_dispatch_version_id",
  "authority_terminal_version_id",
  "operation_five_id_sha256",
  "operation_five_request_sha256",
  "operation_start_receipt_digest_sha256",
  "operation_start_credential_id_sha256",
  "operation_start_request_id_sha256",
  "admission_confirmation_digest_sha256",
  "terminal_writer_credential_id_sha256",
  "terminal_writer_request_id_sha256",
  "terminal_command_digest_sha256",
  "ledger_head_before_sha256",
  "ledger_head_after_sha256",
  "terminal_evidence_manifest_sha256",
  "generic_receipt_sequence",
  "generic_terminal_receipt_digest_sha256",
  "next_operation_ordinal",
  "next_operation_id_sha256",
  "recorded_at",
] as const;
const OPERATION_FIVE_TERMINAL_TRIGGERS = [
  "shard_placement_authority_operation_five_terminal_attempt_guard",
  "shard_placement_authority_operation_five_terminal_delete_guard",
  "shard_placement_authority_operation_five_terminal_digest_guard",
  "shard_placement_authority_operation_five_terminal_gateway_guard",
  "shard_placement_authority_operation_five_terminal_insert_guard",
  "shard_placement_authority_operation_five_terminal_project",
  "shard_placement_authority_operation_five_terminal_update_guard",
] as const;

const SCHEMA_PROBE_SQL = `
SELECT
  (
    SELECT group_concat(name, ',')
    FROM (
      SELECT name
      FROM pragma_table_info(
        'shard_placement_authority_execution_claims'
      )
      ORDER BY cid
    )
  ) AS claim_columns,
  (
    SELECT group_concat(name, ',')
    FROM (
      SELECT name
      FROM pragma_table_info(
        'shard_placement_authority_execution_operations'
      )
      ORDER BY cid
    )
  ) AS operation_columns,
  (
    SELECT group_concat(name, ',')
    FROM (
      SELECT name
      FROM pragma_table_info(
        'shard_placement_authority_execution_receipts'
      )
      ORDER BY cid
    )
  ) AS receipt_columns,
  (
    SELECT group_concat(name, ',')
    FROM (
      SELECT name
      FROM pragma_table_info(
        'shard_placement_authority_operation_five_admissions'
      )
      ORDER BY cid
    )
  ) AS operation_five_admission_columns,
  (
    SELECT group_concat(name, ',')
    FROM (
      SELECT name
      FROM pragma_table_info(
        'shard_placement_authority_operation_five_dispatch_outbox'
      )
      ORDER BY cid
    )
  ) AS operation_five_dispatch_outbox_columns,
  (
    SELECT group_concat(name, ',')
    FROM (
      SELECT name
      FROM pragma_table_info(
        'shard_placement_authority_operation_five_application_grants'
      )
      ORDER BY cid
    )
  ) AS operation_five_application_grant_columns,
  (
    SELECT group_concat(name, ',')
    FROM (
      SELECT name
      FROM pragma_table_info(
        'shard_placement_authority_operation_five_dispatch_claims'
      )
      ORDER BY cid
    )
  ) AS operation_five_dispatch_claim_columns,
  (
    SELECT group_concat(name, ',')
    FROM (
      SELECT name
      FROM sqlite_schema
      WHERE type = 'trigger'
        AND tbl_name =
          'shard_placement_authority_operation_five_dispatch_claims'
      ORDER BY name
    )
  ) AS operation_five_dispatch_claim_triggers,
  (
    SELECT group_concat(name, ',')
    FROM (
      SELECT name
      FROM pragma_table_info(
        'shard_placement_authority_operation_five_dispatch_consumptions'
      )
      ORDER BY cid
    )
  ) AS operation_five_dispatch_consumption_columns,
  (
    SELECT group_concat(name, ',')
    FROM (
      SELECT name
      FROM sqlite_schema
      WHERE type = 'trigger'
        AND tbl_name =
          'shard_placement_authority_operation_five_dispatch_consumptions'
      ORDER BY name
    )
  ) AS operation_five_dispatch_consumption_triggers
  ,
  (
    SELECT group_concat(name, ',')
    FROM (
      SELECT name
      FROM pragma_table_info(
        'shard_placement_authority_operation_five_dispatch_consumption_recoveries'
      )
      ORDER BY cid
    )
  ) AS operation_five_dispatch_consumption_recovery_columns,
  (
    SELECT group_concat(name, ',')
    FROM (
      SELECT name
      FROM sqlite_schema
      WHERE type = 'trigger'
        AND tbl_name =
          'shard_placement_authority_operation_five_dispatch_consumption_recoveries'
      ORDER BY name
    )
  ) AS operation_five_dispatch_consumption_recovery_triggers
  ,
  (
    SELECT group_concat(name, ',')
    FROM (
      SELECT name
      FROM pragma_table_info(
        'shard_placement_authority_operation_five_send_attempts'
      )
      ORDER BY cid
    )
  ) AS operation_five_send_attempt_columns,
  (
    SELECT group_concat(name, ',')
    FROM (
      SELECT name
      FROM sqlite_schema
      WHERE type = 'trigger'
        AND tbl_name =
          'shard_placement_authority_operation_five_send_attempts'
      ORDER BY name
    )
  ) AS operation_five_send_attempt_triggers,
  (
    SELECT group_concat(name, ',')
    FROM (
      SELECT name
      FROM pragma_table_info(
        'shard_placement_authority_operation_five_send_attempt_events'
      )
      ORDER BY cid
    )
  ) AS operation_five_send_attempt_event_columns,
  (
    SELECT group_concat(name, ',')
    FROM (
      SELECT name
      FROM sqlite_schema
      WHERE type = 'trigger'
        AND tbl_name =
          'shard_placement_authority_operation_five_send_attempt_events'
      ORDER BY name
    )
  ) AS operation_five_send_attempt_event_triggers
  ,
  (
    SELECT group_concat(name, ',')
    FROM (
      SELECT name
      FROM pragma_table_info(
        'shard_placement_authority_operation_five_gateway_events'
      )
      ORDER BY cid
    )
  ) AS operation_five_gateway_event_columns,
  (
    SELECT group_concat(name, ',')
    FROM (
      SELECT name
      FROM sqlite_schema
      WHERE type = 'trigger'
        AND tbl_name =
          'shard_placement_authority_operation_five_gateway_events'
      ORDER BY name
    )
  ) AS operation_five_gateway_event_triggers,
  (
    SELECT group_concat(name, ',')
    FROM (
      SELECT name
      FROM pragma_table_info(
        'shard_placement_authority_operation_five_terminals'
      )
      ORDER BY cid
    )
  ) AS operation_five_terminal_columns,
  (
    SELECT group_concat(name, ',')
    FROM (
      SELECT name
      FROM sqlite_schema
      WHERE type = 'trigger'
        AND tbl_name =
          'shard_placement_authority_operation_five_terminals'
      ORDER BY name
    )
  ) AS operation_five_terminal_triggers
`.trim();

const INSERT_CLAIM_SQL = `
INSERT INTO shard_placement_authority_execution_claims (
  authorization_id_sha256, permit_subject_digest_sha256,
  execution_nonce_sha256, application_ticket_id_sha256,
  application_ticket_digest_sha256,
  application_database_identity_sha256,
  authority_database_identity_sha256, campaign_id, campaign_nonce_sha256,
  claim_scope, execution_plan_sha256, release_sha256,
  publication_sha256, execution_activation_sha256,
  runner_build_sha256, claim_owner_sha256, lease_owner_sha256,
  ledger_identity_sha256, lease_token_sha256, lease_generation,
  lease_expires_at, baseline_operation_id_sha256,
  baseline_terminal_digest_sha256, preparation_operation_id_sha256,
  claim_operation_id_sha256,
  operation_schedule_sha256, claim_credential_id_sha256,
  claim_request_id_sha256, claim_digest_sha256,
  claim_acquired_receipt_digest_sha256, permit_expires_at,
  normal_deadline_at, recovery_deadline_at, ledger_head_sha256,
  generated_at, claimed_at, updated_at
)
SELECT
  ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
  ?15, ?16, ?16, ?17, ?18, 1, unixepoch() + 60, ?19, ?20, ?21, ?22,
  ?23, ?24, ?25, ?26, ?27, issuance.permit_expires_at, ?28,
  issuance.permit_expires_at + 600, ?20, ?29, unixepoch(),
  unixepoch()
FROM shard_placement_authority_issuances AS issuance
LEFT JOIN shard_placement_authority_revocations AS revocation
  ON revocation.authorization_id_sha256 =
       issuance.authorization_id_sha256
WHERE issuance.authorization_id_sha256 = ?1
  AND issuance.permit_subject_digest_sha256 = ?2
  AND issuance.execution_nonce_sha256 = ?3
  AND issuance.campaign_id = ?8
  AND issuance.campaign_nonce_sha256 = ?9
  AND issuance.environment = 'staging'
  AND issuance.shard_count = 8
  AND revocation.authorization_id_sha256 IS NULL
`.trim();

const INSERT_OPERATION_SQL = `
INSERT INTO shard_placement_authority_execution_operations (
  authorization_id_sha256, ordinal, operation_id_sha256, kind,
  shard_index
) VALUES (?1, ?2, ?3, ?4, ?5)
`.trim();

const INSERT_RECEIPT_SQL = `
INSERT INTO shard_placement_authority_execution_receipts (
  authorization_id_sha256, sequence, event_kind,
  claim_digest_sha256, execution_plan_sha256,
  ledger_identity_sha256, operation_ordinal,
  operation_id_sha256, operation_kind, shard_index,
  predecessor_receipt_sha256, request_sha256, response_sha256,
  cloudflare_request_id_sha256, evidence_sha256, safety_reason,
  outcome, lease_owner_sha256, lease_token_sha256,
  lease_generation, lease_expires_at,
  receipt_credential_id_sha256, request_id_sha256,
  receipt_digest_sha256
)
SELECT
  ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
  ?14, ?15, ?16, ?17, ?18, ?19, ?20,
  CASE
    WHEN ?3 IN ('lease_renewed', 'lease_taken_over')
      THEN unixepoch() + 60
    ELSE claim.lease_expires_at
  END,
  ?21, ?22, ?23
FROM shard_placement_authority_execution_claims AS claim
WHERE claim.authorization_id_sha256 = ?1
  AND claim.claim_digest_sha256 = ?4
  AND claim.execution_plan_sha256 = ?5
  AND claim.ledger_identity_sha256 = ?6
`.trim();

const INSERT_OPERATION_FIVE_ADMISSION_SQL = `
INSERT INTO shard_placement_authority_operation_five_admissions (
  authorization_id_sha256, contract_version,
  confirmation_contract, claim_digest_sha256,
  application_ticket_id_sha256, application_ticket_digest_sha256,
  application_database_identity_sha256,
  application_activation_digest_sha256,
  authority_activation_terminal_receipt_sha256,
  authority_ledger_head_sha256,
  authority_database_identity_sha256, authority_version_id,
  application_acknowledgement_digest_sha256,
  application_version_id, application_read_credential_id_sha256,
  application_read_request_id_sha256, application_response_sha256,
  application_response_bytes, enable_credential_id_sha256,
  enable_request_id_sha256,
  command_enable_request_id_sha256, enable_operation_request_sha256,
  confirmation_digest_sha256,
  operation_start_receipt_digest_sha256
) VALUES (
  ?1, 1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
  ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23
)
`.trim();

const INSERT_OPERATION_FIVE_DISPATCH_OUTBOX_SQL = `
INSERT INTO shard_placement_authority_operation_five_dispatch_outbox (
  authorization_id_sha256, contract_version, dispatch_contract,
  claim_digest_sha256, application_ticket_id_sha256,
  application_ticket_digest_sha256,
  application_database_identity_sha256,
  application_activation_digest_sha256,
  application_acknowledgement_digest_sha256,
  operation_five_admission_digest_sha256,
  operation_five_start_receipt_sha256,
  authority_database_identity_sha256, authority_version_id,
  authority_ledger_head_sha256, application_version_id,
  application_read_credential_id_sha256,
  application_read_request_id_sha256, application_response_sha256,
  application_response_bytes, application_database_now,
  dispatch_credential_id_sha256, dispatch_request_id_sha256,
  command_dispatch_request_id_sha256, controller_service_name,
  controller_enable_operation_id_sha256,
  controller_baseline_version_id, controller_enabled_version_id,
  dispatch_request_sha256, outbox_digest_sha256, outbox_state
) VALUES (
  ?1, 1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
  ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25,
  ?26, ?27, ?28, 'prepared'
)
`.trim();

const INSERT_OPERATION_FIVE_APPLICATION_GRANT_SQL = `
INSERT INTO shard_placement_authority_operation_five_application_grants (
  authorization_id_sha256, contract_version, receipt_contract,
  claim_digest_sha256, application_ticket_id_sha256,
  application_ticket_digest_sha256,
  application_database_identity_sha256,
  application_activation_digest_sha256,
  application_acknowledgement_digest_sha256,
  operation_five_admission_digest_sha256,
  operation_five_start_receipt_sha256,
  authority_dispatch_outbox_digest_sha256,
  application_grant_digest_sha256,
  application_grant_credential_id_sha256,
  application_grant_request_id_sha256, application_version_id,
  application_response_sha256, application_response_bytes,
  application_database_now, application_granted_at,
  authority_database_identity_sha256,
  authority_ledger_identity_sha256, authority_ledger_head_sha256,
  authority_version_id, grant_credential_id_sha256,
  grant_request_id_sha256, command_grant_request_id_sha256,
  controller_service_name, controller_enable_operation_id_sha256,
  controller_baseline_version_id, controller_enabled_version_id,
  receipt_digest_sha256
) VALUES (
  ?1, 1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
  ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25,
  ?26, ?27, ?28, ?29, ?30, ?31
)
`.trim();

const INSERT_OPERATION_FIVE_DISPATCH_CLAIM_SQL = `
INSERT INTO shard_placement_authority_operation_five_dispatch_claims (
  authorization_id_sha256, contract_version, claim_contract,
  claim_digest_sha256, application_ticket_id_sha256,
  application_database_identity_sha256,
  authority_dispatch_outbox_digest_sha256,
  application_grant_receipt_digest_sha256,
  application_grant_digest_sha256,
  operation_five_start_receipt_sha256,
  authority_database_identity_sha256,
  authority_ledger_identity_sha256, authority_ledger_head_sha256,
  authority_version_id, application_version_id,
  dispatch_owner_sha256, lease_token_sha256, lease_generation,
  lease_expires_at, normal_deadline_at, permit_expires_at,
  dispatch_claim_credential_id_sha256,
  dispatch_claim_request_id_sha256,
  command_dispatch_claim_request_id_sha256,
  controller_service_name, controller_enable_operation_id_sha256,
  controller_baseline_version_id, controller_enabled_version_id,
  send_attempt_limit, retry_limit, missing_readback_allows_resend,
  dispatch_claim_digest_sha256, claim_state
) VALUES (
  ?1, 1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
  ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25,
  ?26, ?27, ?28, ?29, ?30, ?31, ?32
)
`.trim();

const SELECT_OPERATION_FIVE_DISPATCH_CLAIM_SQL = `
SELECT ${OPERATION_FIVE_DISPATCH_CLAIM_COLUMNS.join(", ")}
FROM shard_placement_authority_operation_five_dispatch_claims
WHERE authorization_id_sha256 = ?1
LIMIT 1
`.trim();

const INSERT_OPERATION_FIVE_DISPATCH_CONSUMPTION_SQL = `
INSERT INTO shard_placement_authority_operation_five_dispatch_consumptions (
  authorization_id_sha256, contract_version, receipt_contract,
  claim_digest_sha256, application_ticket_id_sha256, campaign_id,
  application_database_identity_sha256, application_version_id,
  application_grant_receipt_digest_sha256,
  application_grant_digest_sha256,
  authority_dispatch_outbox_digest_sha256,
  operation_five_start_receipt_sha256,
  authority_dispatch_claim_digest_sha256,
  authority_database_identity_sha256,
  authority_ledger_identity_sha256, authority_ledger_head_sha256,
  authority_version_id, dispatch_owner_sha256, lease_token_sha256,
  lease_generation, lease_expires_at, normal_deadline_at,
  permit_expires_at, dispatch_claim_credential_id_sha256,
  dispatch_claim_request_id_sha256,
  command_dispatch_claim_request_id_sha256,
  authority_dispatch_claimed_at, controller_service_name,
  controller_enable_operation_id_sha256,
  controller_baseline_version_id, controller_enabled_version_id,
  send_attempt_limit, retry_limit, missing_readback_allows_resend,
  application_dispatch_consumption_digest_sha256,
  application_dispatch_consumption_credential_id_sha256,
  application_dispatch_consumption_request_id_sha256,
  command_dispatch_consumption_request_id_sha256,
  application_consumption_state, application_consumed_at,
  application_response_sha256, application_response_bytes,
  consume_credential_id_sha256, consume_request_id_sha256,
  command_consume_request_id_sha256, receipt_digest_sha256
) VALUES (
  ?1, 1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
  ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25,
  ?26, ?27, ?28, ?29, ?30, ?31, ?32, ?33, ?34, ?35, ?36, ?37,
  ?38, ?39, ?40, ?41, ?42, ?43, ?44, ?45
)
`.trim();

const SELECT_OPERATION_FIVE_DISPATCH_CONSUMPTION_SQL = `
SELECT ${OPERATION_FIVE_DISPATCH_CONSUMPTION_COLUMNS.join(", ")}
FROM shard_placement_authority_operation_five_dispatch_consumptions
WHERE authorization_id_sha256 = ?1
LIMIT 1
`.trim();

const INSERT_OPERATION_FIVE_DISPATCH_CONSUMPTION_RECOVERY_SQL = `
INSERT INTO shard_placement_authority_operation_five_dispatch_consumption_recoveries (
  authorization_id_sha256, contract_version, recovery_contract,
  claim_digest_sha256, application_ticket_id_sha256, campaign_id,
  application_database_identity_sha256, application_version_id,
  authority_dispatch_claim_digest_sha256,
  application_dispatch_consumption_digest_sha256,
  application_dispatch_consumption_credential_id_sha256,
  application_dispatch_consumption_request_id_sha256,
  command_dispatch_consumption_request_id_sha256,
  application_consumed_at,
  application_history_read_credential_id_sha256,
  application_history_read_request_id_sha256,
  application_response_sha256, application_response_bytes,
  application_database_now, recovery_credential_id_sha256,
  recovery_request_id_sha256, command_recovery_request_id_sha256,
  retention_deadline_at, receipt_digest_sha256,
  recovery_evidence_digest_sha256
) VALUES (
  ?1, 1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
  ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25
)
`.trim();

const SELECT_OPERATION_FIVE_DISPATCH_CONSUMPTION_RECOVERY_SQL = `
SELECT ${OPERATION_FIVE_DISPATCH_CONSUMPTION_RECOVERY_COLUMNS.join(", ")}
FROM shard_placement_authority_operation_five_dispatch_consumption_recoveries
WHERE authorization_id_sha256 = ?1
LIMIT 1
`.trim();

const INSERT_OPERATION_FIVE_SEND_ATTEMPT_SQL = `
INSERT INTO shard_placement_authority_operation_five_send_attempts (
  authorization_id_sha256, contract_version, attempt_contract,
  attempt_generation, retry_count, retry_limit, send_attempt_limit,
  send_authority_state, claim_digest_sha256,
  authority_dispatch_claim_digest_sha256,
  dispatch_consumption_receipt_digest_sha256,
  application_dispatch_consumption_digest_sha256,
  application_ticket_id_sha256, campaign_id,
  application_database_identity_sha256, application_version_id,
  authority_database_identity_sha256,
  authority_ledger_identity_sha256, authority_ledger_head_sha256,
  authority_version_id, dispatch_owner_sha256, lease_token_sha256,
  lease_generation, controller_service_name,
  controller_enable_operation_id_sha256,
  controller_baseline_version_id, controller_enabled_version_id,
  controller_command_contract, controller_command_digest_sha256,
  gateway_idempotency_contract, gateway_idempotency_key_sha256,
  send_credential_id_sha256, send_request_id_sha256,
  command_send_attempt_request_id_sha256,
  controller_request_sent, gateway_request_sent, attempt_digest_sha256
) VALUES (
  ?1, 1, ?2, 1, 0, 0, 1, 'granted', ?3, ?4, ?5, ?6, ?7, ?8, ?9,
  ?10, ?11, ?12, ?13, ?14, ?15, ?16, 1, ?17, ?18, ?19, ?20, ?21,
  ?22, ?23, ?24, ?25, ?26, ?27, 0, 0, ?28
)
`.trim();

const SELECT_OPERATION_FIVE_SEND_ATTEMPT_SQL = `
SELECT ${OPERATION_FIVE_SEND_ATTEMPT_COLUMNS.join(", ")}
FROM shard_placement_authority_operation_five_send_attempts
WHERE authorization_id_sha256 = ?1
LIMIT 1
`.trim();

const INSERT_OPERATION_FIVE_SEND_ATTEMPT_EVENT_SQL = `
INSERT INTO shard_placement_authority_operation_five_send_attempt_events (
  authorization_id_sha256, attempt_digest_sha256, event_sequence,
  contract_version, event_contract, event_kind, from_state, to_state,
  event_semantics, predecessor_event_digest_sha256,
  dispatch_consumption_receipt_digest_sha256,
  controller_command_digest_sha256, gateway_idempotency_key_sha256,
  controller_request_sent, gateway_request_sent, event_digest_sha256
) VALUES (
  ?1, ?2, 1, 1, ?3, 'send_started', 'consumption_receipted',
  'send_started',
  'unique_send_authority_persisted_network_may_not_have_occurred',
  ?4, ?5, ?6, ?7, 0, 0, ?8
)
`.trim();

const SELECT_OPERATION_FIVE_SEND_ATTEMPT_EVENT_SQL = `
SELECT ${OPERATION_FIVE_SEND_ATTEMPT_EVENT_COLUMNS.join(", ")}
FROM shard_placement_authority_operation_five_send_attempt_events
WHERE authorization_id_sha256 = ?1
  AND event_sequence = 1
LIMIT 1
`.trim();

const INSERT_OPERATION_FIVE_GATEWAY_EVENT_SQL = `
INSERT INTO shard_placement_authority_operation_five_gateway_events (
  authorization_id_sha256, attempt_digest_sha256,
  send_started_event_digest_sha256, event_sequence,
  contract_version, event_contract, event_kind,
  predecessor_event_digest_sha256, gateway_idempotency_key_sha256,
  controller_command_digest_sha256, gateway_credential_role,
  gateway_credential_id_sha256, gateway_request_id_sha256,
  gateway_response_sha256, gateway_response_bytes,
  gateway_version_id, mutation_request_sha256,
  result_classification, result_http_status,
  result_response_body_sha256, result_response_request_id_sha256,
  result_response_bytes, status_classification,
  deployments_http_status, version_http_status,
  deployment_set_sha256, target_version_sha256,
  status_response_request_id_sha256, observation_digest_sha256,
  gateway_recorded_at, target_stable,
  required_matching_observations, stability_minimum_seconds,
  stability_predecessor_observation_digest_sha256,
  stability_predecessor_recorded_at, event_digest_sha256
) VALUES (
  ?1, ?2, ?3, ?4, 1, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
  ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23,
  ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32, ?33, ?34,
  ?35
)
`.trim();

const SELECT_OPERATION_FIVE_GATEWAY_EVENT_SQL = `
SELECT ${OPERATION_FIVE_GATEWAY_EVENT_COLUMNS.join(", ")}
FROM shard_placement_authority_operation_five_gateway_events
WHERE authorization_id_sha256 = ?1
  AND attempt_digest_sha256 = ?2
  AND event_sequence = ?3
LIMIT 1
`.trim();

const SELECT_OPERATION_FIVE_GATEWAY_EVENTS_SQL = `
SELECT ${OPERATION_FIVE_GATEWAY_EVENT_COLUMNS.join(", ")}
FROM shard_placement_authority_operation_five_gateway_events
WHERE authorization_id_sha256 = ?1
  AND attempt_digest_sha256 = ?2
ORDER BY event_sequence
`.trim();

const INSERT_OPERATION_FIVE_TERMINAL_SQL = `
INSERT INTO shard_placement_authority_operation_five_terminals (
  authorization_id_sha256, contract_version, terminal_contract,
  claim_digest_sha256, claim_owner_sha256, lease_owner_sha256,
  lease_token_sha256, lease_generation, attempt_digest_sha256,
  send_started_event_digest_sha256, stable_gateway_event_sequence,
  stable_gateway_event_digest_sha256,
  stable_gateway_predecessor_event_digest_sha256,
  stable_gateway_request_id_sha256, stable_gateway_response_sha256,
  stable_gateway_response_bytes, stable_observation_digest_sha256,
  stable_status_response_request_id_sha256,
  stable_gateway_recorded_at, deployment_set_sha256,
  target_version_sha256, gateway_version_id,
  controller_service_name, controller_enabled_version_id,
  controller_command_digest_sha256, gateway_idempotency_key_sha256,
  authority_database_identity_sha256,
  authority_ledger_identity_sha256, authority_dispatch_version_id,
  authority_terminal_version_id, operation_five_id_sha256,
  operation_five_request_sha256,
  operation_start_receipt_digest_sha256,
  operation_start_credential_id_sha256,
  operation_start_request_id_sha256,
  admission_confirmation_digest_sha256,
  terminal_writer_credential_id_sha256,
  terminal_writer_request_id_sha256, terminal_command_digest_sha256,
  ledger_head_before_sha256, ledger_head_after_sha256,
  terminal_evidence_manifest_sha256, generic_receipt_sequence,
  generic_terminal_receipt_digest_sha256, next_operation_ordinal,
  next_operation_id_sha256
) VALUES (
  ?1, 1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, ?9, ?10, ?11, ?12,
  ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24,
  ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32, ?33, ?34, ?35, ?36,
  ?37, ?38, ?39, ?40, 5, ?41, 6, ?42
)
`.trim();

const SELECT_OPERATION_FIVE_TERMINAL_SQL = `
SELECT ${OPERATION_FIVE_TERMINAL_COLUMNS.join(", ")}
FROM shard_placement_authority_operation_five_terminals
WHERE authorization_id_sha256 = ?1
LIMIT 1
`.trim();

interface SchemaProbeRow {
  claim_columns: string;
  operation_columns: string;
  receipt_columns: string;
  operation_five_admission_columns: string;
  operation_five_dispatch_outbox_columns: string;
  operation_five_application_grant_columns: string;
  operation_five_dispatch_claim_columns: string;
  operation_five_dispatch_claim_triggers: string;
  operation_five_dispatch_consumption_columns: string;
  operation_five_dispatch_consumption_triggers: string;
  operation_five_dispatch_consumption_recovery_columns: string;
  operation_five_dispatch_consumption_recovery_triggers: string;
  operation_five_send_attempt_columns: string;
  operation_five_send_attempt_triggers: string;
  operation_five_send_attempt_event_columns: string;
  operation_five_send_attempt_event_triggers: string;
  operation_five_gateway_event_columns: string;
  operation_five_gateway_event_triggers: string;
  operation_five_terminal_columns: string;
  operation_five_terminal_triggers: string;
}

export interface ExecutionClaimRow {
  authorization_id_sha256: string;
  permit_subject_digest_sha256: string;
  execution_nonce_sha256: string;
  application_ticket_id_sha256: string;
  application_ticket_digest_sha256: string;
  application_database_identity_sha256: string;
  authority_database_identity_sha256: string;
  campaign_id: string;
  campaign_nonce_sha256: string;
  claim_scope: string;
  execution_plan_sha256: string;
  release_sha256: string;
  publication_sha256: string;
  execution_activation_sha256: string;
  runner_build_sha256: string;
  claim_owner_sha256: string;
  lease_owner_sha256: string;
  ledger_identity_sha256: string;
  lease_token_sha256: string;
  lease_generation: number;
  lease_expires_at: number;
  baseline_operation_id_sha256: string;
  baseline_terminal_digest_sha256: string;
  preparation_operation_id_sha256: string;
  claim_operation_id_sha256: string;
  operation_schedule_sha256: string;
  claim_credential_id_sha256: string;
  claim_request_id_sha256: string;
  claim_digest_sha256: string;
  claim_acquired_receipt_digest_sha256: string;
  permit_expires_at: number;
  normal_deadline_at: number;
  recovery_deadline_at: number;
  status: string;
  ledger_version: number;
  ledger_head_sha256: string;
  last_completed_ordinal: number;
  inflight_operation_ordinal: number | null;
  inflight_operation_id_sha256: string | null;
  inflight_request_sha256: string | null;
  inflight_cloudflare_request_id_sha256: string | null;
  inflight_started_generation: number | null;
  inflight_started_owner_sha256: string | null;
  inflight_started_lease_token_sha256: string | null;
  inflight_readback_only: number;
  enable_intent_seen: number;
  disable_confirmed: number;
  application_activation_digest_sha256: string | null;
  ticket_activation_confirmed: number;
  renewal_count: number;
  takeover_count: number;
  generated_at: number;
  claimed_at: number;
  updated_at: number;
  terminal_at: number | null;
}

export interface ExecutionOperationRow {
  authorization_id_sha256: string;
  ordinal: number;
  operation_id_sha256: string;
  kind: string;
  shard_index: number | null;
}

export interface ExecutionReceiptRow {
  authorization_id_sha256: string;
  sequence: number;
  event_kind: string;
  claim_digest_sha256: string;
  execution_plan_sha256: string;
  ledger_identity_sha256: string;
  operation_ordinal: number;
  operation_id_sha256: string;
  operation_kind: string;
  shard_index: number | null;
  predecessor_receipt_sha256: string;
  request_sha256: string;
  response_sha256: string | null;
  cloudflare_request_id_sha256: string | null;
  evidence_sha256: string;
  safety_reason: string | null;
  outcome: string;
  lease_owner_sha256: string;
  lease_token_sha256: string;
  lease_generation: number;
  lease_expires_at: number;
  receipt_credential_id_sha256: string;
  request_id_sha256: string;
  receipt_digest_sha256: string;
  recorded_at: number;
}

export interface ExecutionClaimSnapshot {
  claim: ExecutionClaimRow;
  operations: readonly ExecutionOperationRow[];
  receipts: readonly ExecutionReceiptRow[];
}

export interface OperationFiveAdmission {
  authorizationIdSha256: string;
  confirmationContract:
    "cinatoken-shard-placement-authority-operation-five-admission-v1";
  claimDigestSha256: string;
  applicationTicketIdSha256: string;
  applicationTicketDigestSha256: string;
  applicationDatabaseIdentitySha256: string;
  applicationActivationDigestSha256: string;
  authorityActivationTerminalReceiptSha256: string;
  authorityLedgerHeadSha256: string;
  authorityDatabaseIdentitySha256: string;
  authorityVersionId: string;
  applicationAcknowledgementDigestSha256: string;
  applicationVersionId: string;
  applicationReadCredentialIdSha256: string;
  applicationReadRequestIdSha256: string;
  applicationResponseSha256: string;
  applicationResponseBytes: number;
  enableCredentialIdSha256: string;
  enableRequestIdSha256: string;
  commandEnableRequestIdSha256: string;
  enableOperationRequestSha256: string;
  confirmationDigestSha256: string;
  operationStartReceiptDigestSha256: string;
}

export interface OperationFiveAdmissionRow {
  authorization_id_sha256: string;
  contract_version: number;
  confirmation_contract: string;
  claim_digest_sha256: string;
  application_ticket_id_sha256: string;
  application_ticket_digest_sha256: string;
  application_database_identity_sha256: string;
  application_activation_digest_sha256: string;
  authority_activation_terminal_receipt_sha256: string;
  authority_ledger_head_sha256: string;
  authority_database_identity_sha256: string;
  authority_version_id: string;
  application_acknowledgement_digest_sha256: string;
  application_version_id: string;
  application_read_credential_id_sha256: string;
  application_read_request_id_sha256: string;
  application_response_sha256: string;
  application_response_bytes: number;
  enable_credential_id_sha256: string;
  enable_request_id_sha256: string;
  command_enable_request_id_sha256: string;
  enable_operation_request_sha256: string;
  confirmation_digest_sha256: string;
  operation_start_receipt_digest_sha256: string;
  confirmed_at: number;
}

export interface OperationFiveDispatchOutbox {
  authorizationIdSha256: string;
  dispatchContract:
    "cinatoken-shard-placement-authority-operation-five-dispatch-outbox-v1";
  claimDigestSha256: string;
  applicationTicketIdSha256: string;
  applicationTicketDigestSha256: string;
  applicationDatabaseIdentitySha256: string;
  applicationActivationDigestSha256: string;
  applicationAcknowledgementDigestSha256: string;
  operationFiveAdmissionDigestSha256: string;
  operationFiveStartReceiptSha256: string;
  authorityDatabaseIdentitySha256: string;
  authorityVersionId: string;
  authorityLedgerHeadSha256: string;
  applicationVersionId: string;
  applicationReadCredentialIdSha256: string;
  applicationReadRequestIdSha256: string;
  applicationResponseSha256: string;
  applicationResponseBytes: number;
  applicationDatabaseNow: number;
  dispatchCredentialIdSha256: string;
  dispatchRequestIdSha256: string;
  commandDispatchRequestIdSha256: string;
  controllerServiceName: string;
  controllerEnableOperationIdSha256: string;
  controllerBaselineVersionId: string;
  controllerEnabledVersionId: string;
  dispatchRequestSha256: string;
  outboxDigestSha256: string;
}

export interface OperationFiveDispatchOutboxRow {
  authorization_id_sha256: string;
  contract_version: number;
  dispatch_contract: string;
  claim_digest_sha256: string;
  application_ticket_id_sha256: string;
  application_ticket_digest_sha256: string;
  application_database_identity_sha256: string;
  application_activation_digest_sha256: string;
  application_acknowledgement_digest_sha256: string;
  operation_five_admission_digest_sha256: string;
  operation_five_start_receipt_sha256: string;
  authority_database_identity_sha256: string;
  authority_version_id: string;
  authority_ledger_head_sha256: string;
  application_version_id: string;
  application_read_credential_id_sha256: string;
  application_read_request_id_sha256: string;
  application_response_sha256: string;
  application_response_bytes: number;
  application_database_now: number;
  dispatch_credential_id_sha256: string;
  dispatch_request_id_sha256: string;
  command_dispatch_request_id_sha256: string;
  controller_service_name: string;
  controller_enable_operation_id_sha256: string;
  controller_baseline_version_id: string;
  controller_enabled_version_id: string;
  dispatch_request_sha256: string;
  outbox_digest_sha256: string;
  outbox_state: "prepared";
  prepared_at: number;
}

export interface OperationFiveApplicationGrantReceipt {
  authorizationIdSha256: string;
  receiptContract:
    "cinatoken-shard-placement-authority-operation-five-application-grant-receipt-v1";
  claimDigestSha256: string;
  applicationTicketIdSha256: string;
  applicationTicketDigestSha256: string;
  applicationDatabaseIdentitySha256: string;
  applicationActivationDigestSha256: string;
  applicationAcknowledgementDigestSha256: string;
  operationFiveAdmissionDigestSha256: string;
  operationFiveStartReceiptSha256: string;
  authorityDispatchOutboxDigestSha256: string;
  applicationGrantDigestSha256: string;
  applicationGrantCredentialIdSha256: string;
  applicationGrantRequestIdSha256: string;
  applicationVersionId: string;
  applicationResponseSha256: string;
  applicationResponseBytes: number;
  applicationDatabaseNow: number;
  applicationGrantedAt: number;
  authorityDatabaseIdentitySha256: string;
  authorityLedgerIdentitySha256: string;
  authorityLedgerHeadSha256: string;
  authorityVersionId: string;
  grantCredentialIdSha256: string;
  grantRequestIdSha256: string;
  commandGrantRequestIdSha256: string;
  controllerServiceName: string;
  controllerEnableOperationIdSha256: string;
  controllerBaselineVersionId: string;
  controllerEnabledVersionId: string;
  receiptDigestSha256: string;
}

export interface OperationFiveApplicationGrantReceiptRow {
  authorization_id_sha256: string;
  contract_version: number;
  receipt_contract: string;
  claim_digest_sha256: string;
  application_ticket_id_sha256: string;
  application_ticket_digest_sha256: string;
  application_database_identity_sha256: string;
  application_activation_digest_sha256: string;
  application_acknowledgement_digest_sha256: string;
  operation_five_admission_digest_sha256: string;
  operation_five_start_receipt_sha256: string;
  authority_dispatch_outbox_digest_sha256: string;
  application_grant_digest_sha256: string;
  application_grant_credential_id_sha256: string;
  application_grant_request_id_sha256: string;
  application_version_id: string;
  application_response_sha256: string;
  application_response_bytes: number;
  application_database_now: number;
  application_granted_at: number;
  authority_database_identity_sha256: string;
  authority_ledger_identity_sha256: string;
  authority_ledger_head_sha256: string;
  authority_version_id: string;
  grant_credential_id_sha256: string;
  grant_request_id_sha256: string;
  command_grant_request_id_sha256: string;
  controller_service_name: string;
  controller_enable_operation_id_sha256: string;
  controller_baseline_version_id: string;
  controller_enabled_version_id: string;
  receipt_digest_sha256: string;
  recorded_at: number;
}

export interface OperationFiveDispatchClaim {
  authorizationIdSha256: string;
  claimContract:
    "cinatoken-shard-placement-authority-operation-five-dispatch-claim-v1";
  claimDigestSha256: string;
  applicationTicketIdSha256: string;
  applicationDatabaseIdentitySha256: string;
  authorityDispatchOutboxDigestSha256: string;
  applicationGrantReceiptDigestSha256: string;
  applicationGrantDigestSha256: string;
  operationFiveStartReceiptSha256: string;
  authorityDatabaseIdentitySha256: string;
  authorityLedgerIdentitySha256: string;
  authorityLedgerHeadSha256: string;
  authorityVersionId: string;
  applicationVersionId: string;
  dispatchOwnerSha256: string;
  leaseTokenSha256: string;
  leaseGeneration: 1;
  leaseExpiresAt: number;
  normalDeadlineAt: number;
  permitExpiresAt: number;
  dispatchClaimCredentialIdSha256: string;
  dispatchClaimRequestIdSha256: string;
  commandDispatchClaimRequestIdSha256: string;
  controllerServiceName: string;
  controllerEnableOperationIdSha256: string;
  controllerBaselineVersionId: string;
  controllerEnabledVersionId: string;
  sendAttemptLimit: 1;
  retryLimit: 0;
  missingReadbackAllowsResend: 0;
  dispatchClaimDigestSha256: string;
  claimState: "claimed";
}

export interface OperationFiveDispatchClaimRow {
  authorization_id_sha256: string;
  contract_version: number;
  claim_contract: string;
  claim_digest_sha256: string;
  application_ticket_id_sha256: string;
  application_database_identity_sha256: string;
  authority_dispatch_outbox_digest_sha256: string;
  application_grant_receipt_digest_sha256: string;
  application_grant_digest_sha256: string;
  operation_five_start_receipt_sha256: string;
  authority_database_identity_sha256: string;
  authority_ledger_identity_sha256: string;
  authority_ledger_head_sha256: string;
  authority_version_id: string;
  application_version_id: string;
  dispatch_owner_sha256: string;
  lease_token_sha256: string;
  lease_generation: number;
  lease_expires_at: number;
  normal_deadline_at: number;
  permit_expires_at: number;
  dispatch_claim_credential_id_sha256: string;
  dispatch_claim_request_id_sha256: string;
  command_dispatch_claim_request_id_sha256: string;
  controller_service_name: string;
  controller_enable_operation_id_sha256: string;
  controller_baseline_version_id: string;
  controller_enabled_version_id: string;
  send_attempt_limit: number;
  retry_limit: number;
  missing_readback_allows_resend: number;
  dispatch_claim_digest_sha256: string;
  claim_state: "claimed";
  claimed_at: number;
}

export interface OperationFiveDispatchConsumptionReceipt {
  authorizationIdSha256: string;
  receiptContract:
    "cinatoken-shard-placement-authority-operation-five-dispatch-consumption-receipt-v1";
  claimDigestSha256: string;
  applicationTicketIdSha256: string;
  campaignId: string;
  applicationDatabaseIdentitySha256: string;
  applicationVersionId: string;
  applicationGrantReceiptDigestSha256: string;
  applicationGrantDigestSha256: string;
  authorityDispatchOutboxDigestSha256: string;
  operationFiveStartReceiptSha256: string;
  authorityDispatchClaimDigestSha256: string;
  authorityDatabaseIdentitySha256: string;
  authorityLedgerIdentitySha256: string;
  authorityLedgerHeadSha256: string;
  authorityVersionId: string;
  dispatchOwnerSha256: string;
  leaseTokenSha256: string;
  leaseGeneration: 1;
  leaseExpiresAt: number;
  normalDeadlineAt: number;
  permitExpiresAt: number;
  dispatchClaimCredentialIdSha256: string;
  dispatchClaimRequestIdSha256: string;
  commandDispatchClaimRequestIdSha256: string;
  authorityDispatchClaimedAt: number;
  controllerServiceName: string;
  controllerEnableOperationIdSha256: string;
  controllerBaselineVersionId: string;
  controllerEnabledVersionId: string;
  sendAttemptLimit: 1;
  retryLimit: 0;
  missingReadbackAllowsResend: 0;
  applicationDispatchConsumptionDigestSha256: string;
  applicationDispatchConsumptionCredentialIdSha256: string;
  applicationDispatchConsumptionRequestIdSha256: string;
  commandDispatchConsumptionRequestIdSha256: string;
  applicationConsumptionState: "consumed";
  applicationConsumedAt: number;
  applicationResponseSha256: string;
  applicationResponseBytes: number;
  consumeCredentialIdSha256: string;
  consumeRequestIdSha256: string;
  commandConsumeRequestIdSha256: string;
  receiptDigestSha256: string;
}

export interface OperationFiveDispatchConsumptionReceiptRow {
  authorization_id_sha256: string;
  contract_version: number;
  receipt_contract: string;
  claim_digest_sha256: string;
  application_ticket_id_sha256: string;
  campaign_id: string;
  application_database_identity_sha256: string;
  application_version_id: string;
  application_grant_receipt_digest_sha256: string;
  application_grant_digest_sha256: string;
  authority_dispatch_outbox_digest_sha256: string;
  operation_five_start_receipt_sha256: string;
  authority_dispatch_claim_digest_sha256: string;
  authority_database_identity_sha256: string;
  authority_ledger_identity_sha256: string;
  authority_ledger_head_sha256: string;
  authority_version_id: string;
  dispatch_owner_sha256: string;
  lease_token_sha256: string;
  lease_generation: number;
  lease_expires_at: number;
  normal_deadline_at: number;
  permit_expires_at: number;
  dispatch_claim_credential_id_sha256: string;
  dispatch_claim_request_id_sha256: string;
  command_dispatch_claim_request_id_sha256: string;
  authority_dispatch_claimed_at: number;
  controller_service_name: string;
  controller_enable_operation_id_sha256: string;
  controller_baseline_version_id: string;
  controller_enabled_version_id: string;
  send_attempt_limit: number;
  retry_limit: number;
  missing_readback_allows_resend: number;
  application_dispatch_consumption_digest_sha256: string;
  application_dispatch_consumption_credential_id_sha256: string;
  application_dispatch_consumption_request_id_sha256: string;
  command_dispatch_consumption_request_id_sha256: string;
  application_consumption_state: "consumed";
  application_consumed_at: number;
  application_response_sha256: string;
  application_response_bytes: number;
  consume_credential_id_sha256: string;
  consume_request_id_sha256: string;
  command_consume_request_id_sha256: string;
  receipt_digest_sha256: string;
  recorded_at: number;
}

export interface OperationFiveDispatchConsumptionRecoveryEvidence {
  authorizationIdSha256: string;
  recoveryContract:
    "cinatoken-shard-placement-authority-operation-five-dispatch-consumption-recovery-v1";
  claimDigestSha256: string;
  applicationTicketIdSha256: string;
  campaignId: string;
  applicationDatabaseIdentitySha256: string;
  applicationVersionId: string;
  authorityDispatchClaimDigestSha256: string;
  applicationDispatchConsumptionDigestSha256: string;
  applicationDispatchConsumptionCredentialIdSha256: string;
  applicationDispatchConsumptionRequestIdSha256: string;
  commandDispatchConsumptionRequestIdSha256: string;
  applicationConsumedAt: number;
  applicationHistoryReadCredentialIdSha256: string;
  applicationHistoryReadRequestIdSha256: string;
  applicationResponseSha256: string;
  applicationResponseBytes: number;
  applicationDatabaseNow: number;
  recoveryCredentialIdSha256: string;
  recoveryRequestIdSha256: string;
  commandRecoveryRequestIdSha256: string;
  retentionDeadlineAt: number;
  receiptDigestSha256: string;
  recoveryEvidenceDigestSha256: string;
}

export interface OperationFiveDispatchConsumptionRecoveryEvidenceRow {
  authorization_id_sha256: string;
  contract_version: number;
  recovery_contract: string;
  claim_digest_sha256: string;
  application_ticket_id_sha256: string;
  campaign_id: string;
  application_database_identity_sha256: string;
  application_version_id: string;
  authority_dispatch_claim_digest_sha256: string;
  application_dispatch_consumption_digest_sha256: string;
  application_dispatch_consumption_credential_id_sha256: string;
  application_dispatch_consumption_request_id_sha256: string;
  command_dispatch_consumption_request_id_sha256: string;
  application_consumed_at: number;
  application_history_read_credential_id_sha256: string;
  application_history_read_request_id_sha256: string;
  application_response_sha256: string;
  application_response_bytes: number;
  application_database_now: number;
  recovery_credential_id_sha256: string;
  recovery_request_id_sha256: string;
  command_recovery_request_id_sha256: string;
  retention_deadline_at: number;
  receipt_digest_sha256: string;
  recovery_evidence_digest_sha256: string;
  recorded_at: number;
}

export interface OperationFiveSendAttempt {
  authorizationIdSha256: string;
  attemptContract:
    "cinatoken-shard-placement-authority-operation-five-send-attempt-v1";
  attemptGeneration: 1;
  retryCount: 0;
  retryLimit: 0;
  sendAttemptLimit: 1;
  sendAuthorityState: "granted";
  claimDigestSha256: string;
  authorityDispatchClaimDigestSha256: string;
  dispatchConsumptionReceiptDigestSha256: string;
  applicationDispatchConsumptionDigestSha256: string;
  applicationTicketIdSha256: string;
  campaignId: string;
  applicationDatabaseIdentitySha256: string;
  applicationVersionId: string;
  authorityDatabaseIdentitySha256: string;
  authorityLedgerIdentitySha256: string;
  authorityLedgerHeadSha256: string;
  authorityVersionId: string;
  dispatchOwnerSha256: string;
  leaseTokenSha256: string;
  leaseGeneration: 1;
  controllerServiceName: string;
  controllerEnableOperationIdSha256: string;
  controllerBaselineVersionId: string;
  controllerEnabledVersionId: string;
  controllerCommandContract:
    "cinatoken-controller-deployment-gateway-enable-command-v1";
  controllerCommandDigestSha256: string;
  gatewayIdempotencyContract:
    "cinatoken-controller-deployment-gateway-idempotency-v1";
  gatewayIdempotencyKeySha256: string;
  sendCredentialIdSha256: string;
  sendRequestIdSha256: string;
  commandSendAttemptRequestIdSha256: string;
  controllerRequestSent: 0;
  gatewayRequestSent: 0;
  attemptDigestSha256: string;
}

export interface OperationFiveSendAttemptRow {
  authorization_id_sha256: string;
  contract_version: number;
  attempt_contract: string;
  attempt_generation: number;
  retry_count: number;
  retry_limit: number;
  send_attempt_limit: number;
  send_authority_state: "granted";
  claim_digest_sha256: string;
  authority_dispatch_claim_digest_sha256: string;
  dispatch_consumption_receipt_digest_sha256: string;
  application_dispatch_consumption_digest_sha256: string;
  application_ticket_id_sha256: string;
  campaign_id: string;
  application_database_identity_sha256: string;
  application_version_id: string;
  authority_database_identity_sha256: string;
  authority_ledger_identity_sha256: string;
  authority_ledger_head_sha256: string;
  authority_version_id: string;
  dispatch_owner_sha256: string;
  lease_token_sha256: string;
  lease_generation: number;
  controller_service_name: string;
  controller_enable_operation_id_sha256: string;
  controller_baseline_version_id: string;
  controller_enabled_version_id: string;
  controller_command_contract: string;
  controller_command_digest_sha256: string;
  gateway_idempotency_contract: string;
  gateway_idempotency_key_sha256: string;
  send_credential_id_sha256: string;
  send_request_id_sha256: string;
  command_send_attempt_request_id_sha256: string;
  controller_request_sent: number;
  gateway_request_sent: number;
  attempt_digest_sha256: string;
  created_at: number;
}

export interface OperationFiveSendStartedEvent {
  authorizationIdSha256: string;
  attemptDigestSha256: string;
  eventSequence: 1;
  eventContract:
    "cinatoken-shard-placement-authority-operation-five-send-attempt-event-v1";
  eventKind: "send_started";
  fromState: "consumption_receipted";
  toState: "send_started";
  eventSemantics:
    "unique_send_authority_persisted_network_may_not_have_occurred";
  predecessorEventDigestSha256:
    "0000000000000000000000000000000000000000000000000000000000000000";
  dispatchConsumptionReceiptDigestSha256: string;
  controllerCommandDigestSha256: string;
  gatewayIdempotencyKeySha256: string;
  controllerRequestSent: 0;
  gatewayRequestSent: 0;
  eventDigestSha256: string;
}

export interface OperationFiveSendStartedEventRow {
  authorization_id_sha256: string;
  attempt_digest_sha256: string;
  event_sequence: number;
  contract_version: number;
  event_contract: string;
  event_kind: "send_started";
  from_state: "consumption_receipted";
  to_state: "send_started";
  event_semantics:
    "unique_send_authority_persisted_network_may_not_have_occurred";
  predecessor_event_digest_sha256: string;
  dispatch_consumption_receipt_digest_sha256: string;
  controller_command_digest_sha256: string;
  gateway_idempotency_key_sha256: string;
  controller_request_sent: number;
  gateway_request_sent: number;
  event_digest_sha256: string;
  recorded_at: number;
}

export interface OperationFiveSendAttemptPair {
  attempt: OperationFiveSendAttemptRow;
  event: OperationFiveSendStartedEventRow;
}

export type OperationFiveGatewayEventKind =
  | "gateway_create_dispatched"
  | "gateway_create_accepted"
  | "gateway_create_rejected"
  | "gateway_create_ambiguous"
  | "gateway_status_target"
  | "gateway_status_baseline"
  | "gateway_status_drift"
  | "gateway_status_ambiguous"
  | "gateway_status_stable";

export interface OperationFiveGatewayEvent {
  authorizationIdSha256: string;
  attemptDigestSha256: string;
  sendStartedEventDigestSha256: string;
  eventSequence: number;
  eventContract:
    "cinatoken-shard-placement-authority-operation-five-gateway-event-v1";
  eventKind: OperationFiveGatewayEventKind;
  predecessorEventDigestSha256: string;
  gatewayIdempotencyKeySha256: string;
  controllerCommandDigestSha256: string;
  gatewayCredentialRole: "create" | "status";
  gatewayCredentialIdSha256: string;
  gatewayRequestIdSha256: string;
  gatewayResponseSha256: string | null;
  gatewayResponseBytes: number | null;
  gatewayVersionId: string | null;
  mutationRequestSha256: string | null;
  resultClassification:
    | "accepted"
    | "rejected"
    | "ambiguous"
    | null;
  resultHttpStatus: number | null;
  resultResponseBodySha256: string | null;
  resultResponseRequestIdSha256: string | null;
  resultResponseBytes: number | null;
  statusClassification:
    | "target_observed"
    | "baseline_observed"
    | "deployment_drift"
    | "ambiguous"
    | null;
  deploymentsHttpStatus: number | null;
  versionHttpStatus: number | null;
  deploymentSetSha256: string | null;
  targetVersionSha256: string | null;
  statusResponseRequestIdSha256: string | null;
  observationDigestSha256: string | null;
  gatewayRecordedAt: number | null;
  targetStable: 0 | 1 | null;
  requiredMatchingObservations: 2 | null;
  stabilityMinimumSeconds: number | null;
  stabilityPredecessorObservationDigestSha256: string | null;
  stabilityPredecessorRecordedAt: number | null;
  eventDigestSha256: string;
}

export interface OperationFiveGatewayEventRow {
  authorization_id_sha256: string;
  attempt_digest_sha256: string;
  send_started_event_digest_sha256: string;
  event_sequence: number;
  contract_version: number;
  event_contract: string;
  event_kind: OperationFiveGatewayEventKind;
  predecessor_event_digest_sha256: string;
  gateway_idempotency_key_sha256: string;
  controller_command_digest_sha256: string;
  gateway_credential_role: "create" | "status";
  gateway_credential_id_sha256: string;
  gateway_request_id_sha256: string;
  gateway_response_sha256: string | null;
  gateway_response_bytes: number | null;
  gateway_version_id: string | null;
  mutation_request_sha256: string | null;
  result_classification:
    | "accepted"
    | "rejected"
    | "ambiguous"
    | null;
  result_http_status: number | null;
  result_response_body_sha256: string | null;
  result_response_request_id_sha256: string | null;
  result_response_bytes: number | null;
  status_classification:
    | "target_observed"
    | "baseline_observed"
    | "deployment_drift"
    | "ambiguous"
    | null;
  deployments_http_status: number | null;
  version_http_status: number | null;
  deployment_set_sha256: string | null;
  target_version_sha256: string | null;
  status_response_request_id_sha256: string | null;
  observation_digest_sha256: string | null;
  gateway_recorded_at: number | null;
  target_stable: 0 | 1 | null;
  required_matching_observations: 2 | null;
  stability_minimum_seconds: number | null;
  stability_predecessor_observation_digest_sha256: string | null;
  stability_predecessor_recorded_at: number | null;
  event_digest_sha256: string;
  recorded_at: number;
}

export interface OperationFiveGatewayDispatchTriple {
  pair: OperationFiveSendAttemptPair;
  dispatch: OperationFiveGatewayEventRow;
}

export interface OperationFiveTerminal {
  authorizationIdSha256: string;
  terminalContract:
    "cinatoken-shard-placement-authority-operation-five-terminal-v1";
  claimDigestSha256: string;
  claimOwnerSha256: string;
  leaseOwnerSha256: string;
  leaseTokenSha256: string;
  leaseGeneration: 1;
  attemptDigestSha256: string;
  sendStartedEventDigestSha256: string;
  stableGatewayEventSequence: number;
  stableGatewayEventDigestSha256: string;
  stableGatewayPredecessorEventDigestSha256: string;
  stableGatewayRequestIdSha256: string;
  stableGatewayResponseSha256: string;
  stableGatewayResponseBytes: number;
  stableObservationDigestSha256: string;
  stableStatusResponseRequestIdSha256: string;
  stableGatewayRecordedAt: number;
  deploymentSetSha256: string;
  targetVersionSha256: string;
  gatewayVersionId: string;
  controllerServiceName: string;
  controllerEnabledVersionId: string;
  controllerCommandDigestSha256: string;
  gatewayIdempotencyKeySha256: string;
  authorityDatabaseIdentitySha256: string;
  authorityLedgerIdentitySha256: string;
  authorityDispatchVersionId: string;
  authorityTerminalVersionId: string;
  operationFiveIdSha256: string;
  operationFiveRequestSha256: string;
  operationStartReceiptDigestSha256: string;
  operationStartCredentialIdSha256: string;
  operationStartRequestIdSha256: string;
  admissionConfirmationDigestSha256: string;
  terminalWriterCredentialIdSha256: string;
  terminalWriterRequestIdSha256: string;
  terminalCommandDigestSha256: string;
  ledgerHeadBeforeSha256: string;
  ledgerHeadAfterSha256: string;
  terminalEvidenceManifestSha256: string;
  genericTerminalReceiptDigestSha256: string;
  nextOperationOrdinal: 6;
  nextOperationIdSha256: string;
}

export interface OperationFiveTerminalRow {
  authorization_id_sha256: string;
  contract_version: number;
  terminal_contract: string;
  claim_digest_sha256: string;
  claim_owner_sha256: string;
  lease_owner_sha256: string;
  lease_token_sha256: string;
  lease_generation: number;
  attempt_digest_sha256: string;
  send_started_event_digest_sha256: string;
  stable_gateway_event_sequence: number;
  stable_gateway_event_digest_sha256: string;
  stable_gateway_predecessor_event_digest_sha256: string;
  stable_gateway_request_id_sha256: string;
  stable_gateway_response_sha256: string;
  stable_gateway_response_bytes: number;
  stable_observation_digest_sha256: string;
  stable_status_response_request_id_sha256: string;
  stable_gateway_recorded_at: number;
  deployment_set_sha256: string;
  target_version_sha256: string;
  gateway_version_id: string;
  controller_service_name: string;
  controller_enabled_version_id: string;
  controller_command_digest_sha256: string;
  gateway_idempotency_key_sha256: string;
  authority_database_identity_sha256: string;
  authority_ledger_identity_sha256: string;
  authority_dispatch_version_id: string;
  authority_terminal_version_id: string;
  operation_five_id_sha256: string;
  operation_five_request_sha256: string;
  operation_start_receipt_digest_sha256: string;
  operation_start_credential_id_sha256: string;
  operation_start_request_id_sha256: string;
  admission_confirmation_digest_sha256: string;
  terminal_writer_credential_id_sha256: string;
  terminal_writer_request_id_sha256: string;
  terminal_command_digest_sha256: string;
  ledger_head_before_sha256: string;
  ledger_head_after_sha256: string;
  terminal_evidence_manifest_sha256: string;
  generic_receipt_sequence: number;
  generic_terminal_receipt_digest_sha256: string;
  next_operation_ordinal: number;
  next_operation_id_sha256: string;
  recorded_at: number;
}

export async function createExecutionClaim(
  database: D1Database,
  claim: ExecutionClaim,
): Promise<{
  classification: "created" | "exact_replay";
  snapshot: ExecutionClaimSnapshot;
}> {
  const session = database.withSession("first-primary");
  await requireExecutionSchema(session);
  const statements = [
    session
      .prepare(INSERT_CLAIM_SQL)
      .bind(
        claim.authorizationIdSha256,
        claim.permitSubjectDigestSha256,
        claim.executionNonceSha256,
        claim.applicationTicketIdSha256,
        claim.applicationTicketDigestSha256,
        claim.applicationDatabaseIdentitySha256,
        claim.authorityDatabaseIdentitySha256,
        claim.campaignId,
        claim.campaignNonceSha256,
        claim.claimScope,
        claim.executionPlanSha256,
        claim.releaseSha256,
        claim.publicationSha256,
        claim.executionActivationSha256,
        claim.runnerBuildSha256,
        claim.claimOwnerSha256,
        claim.ledgerIdentitySha256,
        claim.leaseTokenSha256,
        claim.baselineOperationIdSha256,
        claim.baselineTerminalReceiptSha256,
        claim.preparationOperationIdSha256,
        claim.claimOperationIdSha256,
        claim.operationScheduleSha256,
        claim.claimCredentialIdSha256,
        claim.requestIdSha256,
        claim.claimDigestSha256,
        claim.claimAcquiredReceiptSha256,
        claim.normalDeadlineAt,
        claim.generatedAt,
      ),
    ...claim.operations.map((operation) =>
      session
        .prepare(INSERT_OPERATION_SQL)
        .bind(
          claim.authorizationIdSha256,
          operation.ordinal,
          operation.operationIdSha256,
          operation.kind,
          operation.shardIndex,
        )
    ),
  ];
  let writeSucceeded = false;
  try {
    const results = await session.batch(statements);
    writeSucceeded =
      results.length === statements.length
      && results.every((result) => result.success === true);
  } catch {
    writeSucceeded = false;
  }

  let snapshot: ExecutionClaimSnapshot;
  try {
    snapshot = await readSnapshot(
      session,
      claim.authorizationIdSha256,
      claim.claimDigestSha256,
      claim.claimOwnerSha256,
    );
  } catch (error) {
    if (
      error instanceof RepositoryConflictError
      || error instanceof RepositoryNotFoundError
    ) {
      if (writeSucceeded) throw new RepositoryUnavailableError(true);
      throw new RepositoryConflictError("execution_claim_conflict");
    }
    throw error;
  }
  if (!matchesClaimSnapshot(snapshot, claim)) {
    if (writeSucceeded) throw new RepositoryUnavailableError(true);
    throw new RepositoryConflictError("execution_claim_conflict");
  }
  return {
    classification: writeSucceeded ? "created" : "exact_replay",
    snapshot,
  };
}

export async function readExactExecutionClaim(
  database: D1Database,
  authorizationIdSha256: string,
  claimDigestSha256: string,
  claimOwnerSha256: string,
): Promise<ExecutionClaimSnapshot> {
  const session = database.withSession("first-primary");
  await requireExecutionSchema(session);
  return readSnapshot(
    session,
    authorizationIdSha256,
    claimDigestSha256,
    claimOwnerSha256,
  );
}

export async function readExactOperationFiveAdmission(
  database: D1Database,
  authorizationIdSha256: string,
  claimDigestSha256: string,
): Promise<OperationFiveAdmissionRow | null> {
  const session = database.withSession("first-primary");
  await requireExecutionSchema(session);
  const admission = await readOperationFiveAdmission(
    session,
    authorizationIdSha256,
  );
  if (
    admission !== null
    && admission.claim_digest_sha256 !== claimDigestSha256
  ) {
    throw new RepositoryConflictError(
      "operation_five_admission_conflict",
    );
  }
  return admission;
}

export async function readExactOperationFiveDispatchOutbox(
  database: D1Database,
  authorizationIdSha256: string,
  claimDigestSha256: string,
): Promise<OperationFiveDispatchOutboxRow | null> {
  const session = database.withSession("first-primary");
  await requireExecutionSchema(session);
  const outbox = await readOperationFiveDispatchOutbox(
    session,
    authorizationIdSha256,
  );
  if (
    outbox !== null
    && outbox.claim_digest_sha256 !== claimDigestSha256
  ) {
    throw new RepositoryConflictError(
      "operation_five_dispatch_outbox_conflict",
    );
  }
  return outbox;
}

export async function appendExecutionReceipt(
  database: D1Database,
  authorizationIdSha256: string,
  receipt: ExecutionReceipt,
  receiptCredentialIdSha256: string,
): Promise<{
  classification: "receipt_appended" | "receipt_replayed";
  claim: ExecutionClaimRow;
  receipt: ExecutionReceiptRow;
}> {
  const session = database.withSession("first-primary");
  await requireExecutionSchema(session);
  if (authorizationIdSha256 !== receipt.authorizationIdSha256) {
    throw new RepositoryConflictError("execution_receipt_path_mismatch");
  }
  let writeSucceeded = false;
  try {
    const result = await session
      .prepare(INSERT_RECEIPT_SQL)
      .bind(
        authorizationIdSha256,
        receipt.sequence,
        receipt.eventKind,
        receipt.claimDigestSha256,
        receipt.executionPlanSha256,
        receipt.ledgerIdentitySha256,
        receipt.operationOrdinal,
        receipt.operationIdSha256,
        receipt.operationKind,
        receipt.shardIndex,
        receipt.predecessorReceiptSha256,
        receipt.requestSha256,
        receipt.responseSha256,
        receipt.cloudflareRequestIdSha256,
        receipt.evidenceSha256,
        receipt.safetyReason,
        receipt.outcome,
        receipt.actorOwnerSha256,
        receipt.leaseTokenSha256,
        receipt.leaseGeneration,
        receiptCredentialIdSha256,
        receipt.requestIdSha256,
        receipt.receiptDigestSha256,
      )
      .run();
    writeSucceeded =
      result.success === true
      && (result.meta?.changes ?? 0) > 0;
  } catch {
    writeSucceeded = false;
  }
  const persisted = await readReceipt(
    session,
    authorizationIdSha256,
    receipt.sequence,
  );
  if (
    persisted === null
    || !matchesReceipt(
      persisted,
      receipt,
      receiptCredentialIdSha256,
    )
  ) {
    if (writeSucceeded) throw new RepositoryUnavailableError(true);
    throw new RepositoryConflictError("execution_receipt_conflict");
  }
  const snapshot = await readSnapshotByDigest(
    session,
    authorizationIdSha256,
    receipt.claimDigestSha256,
  );
  if (
    snapshot.claim.ledger_identity_sha256
      !== receipt.ledgerIdentitySha256
    || snapshot.claim.execution_plan_sha256
      !== receipt.executionPlanSha256
    || snapshot.claim.ledger_version !== receipt.sequence
    || snapshot.claim.ledger_head_sha256
      !== receipt.receiptDigestSha256
  ) {
    throw new RepositoryUnavailableError(true);
  }
  return {
    classification: writeSucceeded
      ? "receipt_appended"
      : "receipt_replayed",
    claim: snapshot.claim,
    receipt: persisted,
  };
}

export async function admitAndStartOperationFive(
  database: D1Database,
  admission: OperationFiveAdmission,
  receipt: ExecutionReceipt,
): Promise<{
  classification: "admitted" | "exact_replay";
  admission: OperationFiveAdmissionRow;
  claim: ExecutionClaimRow;
  receipt: ExecutionReceiptRow;
}> {
  const session = database.withSession("first-primary");
  await requireExecutionSchema(session);
  if (
    admission.authorizationIdSha256 !== receipt.authorizationIdSha256
    || receipt.eventKind !== "operation_started"
    || receipt.operationOrdinal !== 5
    || receipt.actorCredentialIdSha256
      !== admission.enableCredentialIdSha256
    || receipt.requestIdSha256 !== admission.enableRequestIdSha256
    || receipt.requestSha256 !== admission.enableOperationRequestSha256
    || receipt.evidenceSha256 !== admission.confirmationDigestSha256
    || receipt.receiptDigestSha256
      !== admission.operationStartReceiptDigestSha256
  ) {
    throw new RepositoryConflictError(
      "operation_five_admission_mismatch",
    );
  }

  const statements = [
    session
      .prepare(INSERT_OPERATION_FIVE_ADMISSION_SQL)
      .bind(
        admission.authorizationIdSha256,
        admission.confirmationContract,
        admission.claimDigestSha256,
        admission.applicationTicketIdSha256,
        admission.applicationTicketDigestSha256,
        admission.applicationDatabaseIdentitySha256,
        admission.applicationActivationDigestSha256,
        admission.authorityActivationTerminalReceiptSha256,
        admission.authorityLedgerHeadSha256,
        admission.authorityDatabaseIdentitySha256,
        admission.authorityVersionId,
        admission.applicationAcknowledgementDigestSha256,
        admission.applicationVersionId,
        admission.applicationReadCredentialIdSha256,
        admission.applicationReadRequestIdSha256,
        admission.applicationResponseSha256,
        admission.applicationResponseBytes,
        admission.enableCredentialIdSha256,
        admission.enableRequestIdSha256,
        admission.commandEnableRequestIdSha256,
        admission.enableOperationRequestSha256,
        admission.confirmationDigestSha256,
        admission.operationStartReceiptDigestSha256,
      ),
    session
      .prepare(INSERT_RECEIPT_SQL)
      .bind(
        receipt.authorizationIdSha256,
        receipt.sequence,
        receipt.eventKind,
        receipt.claimDigestSha256,
        receipt.executionPlanSha256,
        receipt.ledgerIdentitySha256,
        receipt.operationOrdinal,
        receipt.operationIdSha256,
        receipt.operationKind,
        receipt.shardIndex,
        receipt.predecessorReceiptSha256,
        receipt.requestSha256,
        receipt.responseSha256,
        receipt.cloudflareRequestIdSha256,
        receipt.evidenceSha256,
        receipt.safetyReason,
        receipt.outcome,
        receipt.actorOwnerSha256,
        receipt.leaseTokenSha256,
        receipt.leaseGeneration,
        admission.enableCredentialIdSha256,
        receipt.requestIdSha256,
        receipt.receiptDigestSha256,
      ),
  ];
  let writeSucceeded = false;
  try {
    const results = await session.batch(statements);
    writeSucceeded =
      results.length === statements.length
      && results.every((result) =>
        result.success === true && (result.meta?.changes ?? 0) > 0
      );
  } catch {
    writeSucceeded = false;
  }

  const persistedAdmission = await readOperationFiveAdmission(
    session,
    admission.authorizationIdSha256,
  );
  const persistedReceipt = await readReceipt(
    session,
    receipt.authorizationIdSha256,
    receipt.sequence,
  );
  if (
    persistedAdmission === null
    || persistedReceipt === null
    || !matchesOperationFiveAdmission(persistedAdmission, admission)
    || !matchesReceipt(
      persistedReceipt,
      receipt,
      admission.enableCredentialIdSha256,
    )
  ) {
    if (writeSucceeded) throw new RepositoryUnavailableError(true);
    throw new RepositoryConflictError(
      "operation_five_admission_conflict",
    );
  }
  const snapshot = await readSnapshotByDigest(
    session,
    admission.authorizationIdSha256,
    admission.claimDigestSha256,
  );
  if (
    snapshot.claim.enable_intent_seen !== 1
    || snapshot.claim.ledger_version < receipt.sequence
    || snapshot.receipts[receipt.sequence - 1]?.receipt_digest_sha256
      !== receipt.receiptDigestSha256
  ) {
    throw new RepositoryUnavailableError(true);
  }
  return {
    classification: writeSucceeded ? "admitted" : "exact_replay",
    admission: persistedAdmission,
    claim: snapshot.claim,
    receipt: persistedReceipt,
  };
}

export async function createOperationFiveDispatchOutbox(
  database: D1Database,
  outbox: OperationFiveDispatchOutbox,
): Promise<{
  classification: "prepared" | "exact_replay";
  outbox: OperationFiveDispatchOutboxRow;
  claim: ExecutionClaimRow;
}> {
  const session = database.withSession("first-primary");
  await requireExecutionSchema(session);
  let writeSucceeded = false;
  try {
    const result = await session
      .prepare(INSERT_OPERATION_FIVE_DISPATCH_OUTBOX_SQL)
      .bind(
        outbox.authorizationIdSha256,
        outbox.dispatchContract,
        outbox.claimDigestSha256,
        outbox.applicationTicketIdSha256,
        outbox.applicationTicketDigestSha256,
        outbox.applicationDatabaseIdentitySha256,
        outbox.applicationActivationDigestSha256,
        outbox.applicationAcknowledgementDigestSha256,
        outbox.operationFiveAdmissionDigestSha256,
        outbox.operationFiveStartReceiptSha256,
        outbox.authorityDatabaseIdentitySha256,
        outbox.authorityVersionId,
        outbox.authorityLedgerHeadSha256,
        outbox.applicationVersionId,
        outbox.applicationReadCredentialIdSha256,
        outbox.applicationReadRequestIdSha256,
        outbox.applicationResponseSha256,
        outbox.applicationResponseBytes,
        outbox.applicationDatabaseNow,
        outbox.dispatchCredentialIdSha256,
        outbox.dispatchRequestIdSha256,
        outbox.commandDispatchRequestIdSha256,
        outbox.controllerServiceName,
        outbox.controllerEnableOperationIdSha256,
        outbox.controllerBaselineVersionId,
        outbox.controllerEnabledVersionId,
        outbox.dispatchRequestSha256,
        outbox.outboxDigestSha256,
      )
      .run();
    writeSucceeded =
      result.success === true
      && (result.meta?.changes ?? 0) > 0;
  } catch {
    writeSucceeded = false;
  }

  const persisted = await readOperationFiveDispatchOutbox(
    session,
    outbox.authorizationIdSha256,
  );
  if (
    persisted === null
    || !matchesOperationFiveDispatchOutbox(persisted, outbox)
  ) {
    if (writeSucceeded) throw new RepositoryUnavailableError(true);
    throw new RepositoryConflictError(
      "operation_five_dispatch_outbox_conflict",
    );
  }
  const snapshot = await readSnapshotByDigest(
    session,
    outbox.authorizationIdSha256,
    outbox.claimDigestSha256,
  );
  if (
    snapshot.claim.ledger_version < 4
    || snapshot.claim.enable_intent_seen !== 1
  ) {
    throw new RepositoryUnavailableError(true);
  }
  return {
    classification: writeSucceeded ? "prepared" : "exact_replay",
    outbox: persisted,
    claim: snapshot.claim,
  };
}

export async function readExactOperationFiveApplicationGrant(
  database: D1Database,
  authorizationIdSha256: string,
  claimDigestSha256: string,
): Promise<OperationFiveApplicationGrantReceiptRow | null> {
  const session = database.withSession("first-primary");
  await requireExecutionSchema(session);
  const row = await readOperationFiveApplicationGrant(
    session,
    authorizationIdSha256,
  );
  if (row !== null && row.claim_digest_sha256 !== claimDigestSha256) {
    throw new RepositoryConflictError(
      "operation_five_application_grant_conflict",
    );
  }
  return row;
}

export async function createOperationFiveApplicationGrant(
  database: D1Database,
  receipt: OperationFiveApplicationGrantReceipt,
): Promise<{
  classification: "recorded" | "exact_replay";
  receipt: OperationFiveApplicationGrantReceiptRow;
  claim: ExecutionClaimRow;
}> {
  const session = database.withSession("first-primary");
  await requireExecutionSchema(session);
  let writeSucceeded = false;
  try {
    const result = await session
      .prepare(INSERT_OPERATION_FIVE_APPLICATION_GRANT_SQL)
      .bind(
        receipt.authorizationIdSha256,
        receipt.receiptContract,
        receipt.claimDigestSha256,
        receipt.applicationTicketIdSha256,
        receipt.applicationTicketDigestSha256,
        receipt.applicationDatabaseIdentitySha256,
        receipt.applicationActivationDigestSha256,
        receipt.applicationAcknowledgementDigestSha256,
        receipt.operationFiveAdmissionDigestSha256,
        receipt.operationFiveStartReceiptSha256,
        receipt.authorityDispatchOutboxDigestSha256,
        receipt.applicationGrantDigestSha256,
        receipt.applicationGrantCredentialIdSha256,
        receipt.applicationGrantRequestIdSha256,
        receipt.applicationVersionId,
        receipt.applicationResponseSha256,
        receipt.applicationResponseBytes,
        receipt.applicationDatabaseNow,
        receipt.applicationGrantedAt,
        receipt.authorityDatabaseIdentitySha256,
        receipt.authorityLedgerIdentitySha256,
        receipt.authorityLedgerHeadSha256,
        receipt.authorityVersionId,
        receipt.grantCredentialIdSha256,
        receipt.grantRequestIdSha256,
        receipt.commandGrantRequestIdSha256,
        receipt.controllerServiceName,
        receipt.controllerEnableOperationIdSha256,
        receipt.controllerBaselineVersionId,
        receipt.controllerEnabledVersionId,
        receipt.receiptDigestSha256,
      )
      .run();
    writeSucceeded =
      result.success === true
      && (result.meta?.changes ?? 0) > 0;
  } catch {
    writeSucceeded = false;
  }
  const persisted = await readOperationFiveApplicationGrant(
    session,
    receipt.authorizationIdSha256,
  );
  if (
    persisted === null
    || !matchesOperationFiveApplicationGrant(persisted, receipt)
  ) {
    if (writeSucceeded) throw new RepositoryUnavailableError(true);
    throw new RepositoryConflictError(
      "operation_five_application_grant_conflict",
    );
  }
  const snapshot = await readSnapshotByDigest(
    session,
    receipt.authorizationIdSha256,
    receipt.claimDigestSha256,
  );
  if (
    snapshot.claim.ledger_version !== 4
    || snapshot.claim.ledger_head_sha256
      !== receipt.operationFiveStartReceiptSha256
    || snapshot.claim.inflight_operation_ordinal !== 5
  ) {
    throw new RepositoryUnavailableError(true);
  }
  return {
    classification: writeSucceeded ? "recorded" : "exact_replay",
    receipt: persisted,
    claim: snapshot.claim,
  };
}

export async function readExactOperationFiveDispatchClaim(
  database: D1Database,
  authorizationIdSha256: string,
  claimDigestSha256: string,
): Promise<OperationFiveDispatchClaimRow | null> {
  const session = database.withSession("first-primary");
  await requireExecutionSchema(session);
  const row = await readOperationFiveDispatchClaim(
    session,
    authorizationIdSha256,
  );
  if (row !== null && row.claim_digest_sha256 !== claimDigestSha256) {
    throw new RepositoryConflictError(
      "operation_five_dispatch_claim_conflict",
    );
  }
  return row;
}

export async function createOperationFiveDispatchClaim(
  database: D1Database,
  dispatchClaim: OperationFiveDispatchClaim,
): Promise<{
  classification: "claimed" | "exact_replay";
  dispatchClaim: OperationFiveDispatchClaimRow;
  claim: ExecutionClaimRow;
}> {
  const session = database.withSession("first-primary");
  await requireExecutionSchema(session);
  let writeOutcome: "claimed" | "failed" | "unknown";
  try {
    const result = await session
      .prepare(INSERT_OPERATION_FIVE_DISPATCH_CLAIM_SQL)
      .bind(
        dispatchClaim.authorizationIdSha256,
        dispatchClaim.claimContract,
        dispatchClaim.claimDigestSha256,
        dispatchClaim.applicationTicketIdSha256,
        dispatchClaim.applicationDatabaseIdentitySha256,
        dispatchClaim.authorityDispatchOutboxDigestSha256,
        dispatchClaim.applicationGrantReceiptDigestSha256,
        dispatchClaim.applicationGrantDigestSha256,
        dispatchClaim.operationFiveStartReceiptSha256,
        dispatchClaim.authorityDatabaseIdentitySha256,
        dispatchClaim.authorityLedgerIdentitySha256,
        dispatchClaim.authorityLedgerHeadSha256,
        dispatchClaim.authorityVersionId,
        dispatchClaim.applicationVersionId,
        dispatchClaim.dispatchOwnerSha256,
        dispatchClaim.leaseTokenSha256,
        dispatchClaim.leaseGeneration,
        dispatchClaim.leaseExpiresAt,
        dispatchClaim.normalDeadlineAt,
        dispatchClaim.permitExpiresAt,
        dispatchClaim.dispatchClaimCredentialIdSha256,
        dispatchClaim.dispatchClaimRequestIdSha256,
        dispatchClaim.commandDispatchClaimRequestIdSha256,
        dispatchClaim.controllerServiceName,
        dispatchClaim.controllerEnableOperationIdSha256,
        dispatchClaim.controllerBaselineVersionId,
        dispatchClaim.controllerEnabledVersionId,
        dispatchClaim.sendAttemptLimit,
        dispatchClaim.retryLimit,
        dispatchClaim.missingReadbackAllowsResend,
        dispatchClaim.dispatchClaimDigestSha256,
        dispatchClaim.claimState,
      )
      .run();
    writeOutcome =
      result.success === true && result.meta?.changes === 1
        ? "claimed"
        : "unknown";
  } catch {
    writeOutcome = "failed";
  }

  const persisted = await readOperationFiveDispatchClaim(
    session,
    dispatchClaim.authorizationIdSha256,
  );
  if (
    persisted === null
    || !matchesOperationFiveDispatchClaim(persisted, dispatchClaim)
  ) {
    if (writeOutcome !== "failed") {
      throw new RepositoryUnavailableError(true);
    }
    throw new RepositoryConflictError(
      "operation_five_dispatch_claim_conflict",
    );
  }
  if (writeOutcome === "unknown") {
    throw new RepositoryUnavailableError(true);
  }

  const snapshot = await readSnapshotByDigest(
    session,
    dispatchClaim.authorizationIdSha256,
    dispatchClaim.claimDigestSha256,
  );
  if (
    snapshot.claim.status !== "running"
    || snapshot.claim.ledger_version !== 4
    || snapshot.claim.ledger_identity_sha256
      !== dispatchClaim.authorityLedgerIdentitySha256
    || snapshot.claim.ledger_head_sha256
      !== dispatchClaim.authorityLedgerHeadSha256
    || snapshot.claim.ledger_head_sha256
      !== dispatchClaim.operationFiveStartReceiptSha256
    || snapshot.claim.inflight_operation_ordinal !== 5
    || snapshot.claim.inflight_operation_id_sha256
      !== dispatchClaim.controllerEnableOperationIdSha256
    || snapshot.claim.claim_owner_sha256
      !== dispatchClaim.dispatchOwnerSha256
    || snapshot.claim.lease_owner_sha256
      !== dispatchClaim.dispatchOwnerSha256
    || snapshot.claim.lease_token_sha256
      !== dispatchClaim.leaseTokenSha256
    || snapshot.claim.lease_generation !== dispatchClaim.leaseGeneration
    || snapshot.claim.lease_expires_at !== dispatchClaim.leaseExpiresAt
    || snapshot.claim.normal_deadline_at !== dispatchClaim.normalDeadlineAt
    || snapshot.claim.permit_expires_at !== dispatchClaim.permitExpiresAt
    || snapshot.claim.inflight_readback_only !== 0
    || snapshot.claim.enable_intent_seen !== 1
    || snapshot.claim.disable_confirmed !== 0
    || snapshot.claim.renewal_count !== 0
    || snapshot.claim.takeover_count !== 0
  ) {
    throw new RepositoryUnavailableError(true);
  }
  return {
    classification: writeOutcome === "claimed"
      ? "claimed"
      : "exact_replay",
    dispatchClaim: persisted,
    claim: snapshot.claim,
  };
}

export async function readExactOperationFiveDispatchConsumption(
  database: D1Database,
  authorizationIdSha256: string,
  claimDigestSha256: string,
): Promise<OperationFiveDispatchConsumptionReceiptRow | null> {
  const session = database.withSession("first-primary");
  await requireExecutionSchema(session);
  const row = await readOperationFiveDispatchConsumption(
    session,
    authorizationIdSha256,
  );
  if (row !== null && row.claim_digest_sha256 !== claimDigestSha256) {
    throw new RepositoryConflictError(
      "operation_five_dispatch_consumption_conflict",
    );
  }
  return row;
}

export async function createOperationFiveDispatchConsumption(
  database: D1Database,
  receipt: OperationFiveDispatchConsumptionReceipt,
): Promise<{
  classification: "recorded" | "exact_replay";
  receipt: OperationFiveDispatchConsumptionReceiptRow;
}> {
  const session = database.withSession("first-primary");
  await requireExecutionSchema(session);
  let writeOutcome: "recorded" | "failed" | "unknown";
  try {
    const result =
      await operationFiveDispatchConsumptionInsertStatement(
        session,
        receipt,
      ).run();
    writeOutcome =
      result.success === true && result.meta?.changes === 1
        ? "recorded"
        : "unknown";
  } catch {
    writeOutcome = "failed";
  }

  const persisted = await readOperationFiveDispatchConsumption(
    session,
    receipt.authorizationIdSha256,
  );
  if (
    persisted === null
    || !matchesOperationFiveDispatchConsumption(persisted, receipt)
  ) {
    if (writeOutcome !== "failed") {
      throw new RepositoryUnavailableError(true);
    }
    throw new RepositoryConflictError(
      "operation_five_dispatch_consumption_conflict",
    );
  }
  if (writeOutcome === "unknown") {
    throw new RepositoryUnavailableError(true);
  }

  return {
    classification: writeOutcome === "recorded"
      ? "recorded"
      : "exact_replay",
    receipt: persisted,
  };
}

export async function createRecoveredOperationFiveDispatchConsumption(
  database: D1Database,
  receipt: OperationFiveDispatchConsumptionReceipt,
  recovery: OperationFiveDispatchConsumptionRecoveryEvidence,
): Promise<{
  classification: "recorded" | "exact_replay";
  receipt: OperationFiveDispatchConsumptionReceiptRow;
  recovery:
    OperationFiveDispatchConsumptionRecoveryEvidenceRow | null;
}> {
  const session = database.withSession("first-primary");
  await requireExecutionSchema(session);
  let writeOutcome: "recorded" | "failed" | "unknown";
  try {
    const results = await session.batch([
      operationFiveDispatchConsumptionRecoveryInsertStatement(
        session,
        recovery,
      ),
      operationFiveDispatchConsumptionInsertStatement(session, receipt),
    ]);
    writeOutcome =
      results.length === 2
        && results.every((result) =>
          result.success === true && result.meta?.changes === 1)
        ? "recorded"
        : "unknown";
  } catch {
    writeOutcome = "failed";
  }

  const persistedReceipt = await readOperationFiveDispatchConsumption(
    session,
    receipt.authorizationIdSha256,
  );
  const persistedRecovery =
    await readOperationFiveDispatchConsumptionRecovery(
      session,
      recovery.authorizationIdSha256,
    );
  if (
    persistedReceipt === null
    || !matchesRecoveredOperationFiveDispatchConsumptionSource(
      persistedReceipt,
      receipt,
    )
  ) {
    if (writeOutcome !== "failed") {
      throw new RepositoryUnavailableError(true);
    }
    throw new RepositoryConflictError(
      "operation_five_dispatch_consumption_recovery_conflict",
    );
  }
  if (writeOutcome === "recorded") {
    if (
      persistedRecovery === null
      || !matchesOperationFiveDispatchConsumptionRecovery(
        persistedRecovery,
        recovery,
      )
      || !matchesOperationFiveDispatchConsumption(
        persistedReceipt,
        receipt,
      )
    ) {
      throw new RepositoryUnavailableError(true);
    }
  } else if (writeOutcome === "unknown") {
    throw new RepositoryUnavailableError(true);
  }

  return {
    classification: writeOutcome === "recorded"
      ? "recorded"
      : "exact_replay",
    receipt: persistedReceipt,
    recovery: persistedRecovery,
  };
}

export async function readExactOperationFiveDispatchConsumptionRecovery(
  database: D1Database,
  authorizationIdSha256: string,
  claimDigestSha256: string,
): Promise<OperationFiveDispatchConsumptionRecoveryEvidenceRow | null> {
  const session = database.withSession("first-primary");
  await requireExecutionSchema(session);
  const row = await readOperationFiveDispatchConsumptionRecovery(
    session,
    authorizationIdSha256,
  );
  if (row !== null && row.claim_digest_sha256 !== claimDigestSha256) {
    throw new RepositoryConflictError(
      "operation_five_dispatch_consumption_recovery_conflict",
    );
  }
  return row;
}

export async function readExactOperationFiveSendAttemptPair(
  database: D1Database,
  authorizationIdSha256: string,
  claimDigestSha256: string,
): Promise<OperationFiveSendAttemptPair | null> {
  const session = database.withSession("first-primary");
  await requireExecutionSchema(session);
  const pair = await readOperationFiveSendAttemptPair(
    session,
    authorizationIdSha256,
  );
  if (
    pair !== null
    && pair.attempt.claim_digest_sha256 !== claimDigestSha256
  ) {
    throw new RepositoryConflictError(
      "operation_five_send_attempt_pair_conflict",
    );
  }
  return pair;
}

export async function createOperationFiveSendAttemptPair(
  database: D1Database,
  attempt: OperationFiveSendAttempt,
  event: OperationFiveSendStartedEvent,
): Promise<{
  classification: "created" | "exact_replay";
  pair: OperationFiveSendAttemptPair;
}> {
  const session = database.withSession("first-primary");
  await requireExecutionSchema(session);
  let writeOutcome: "created" | "failed" | "unknown";
  try {
    const results = await session.batch([
      operationFiveSendAttemptInsertStatement(session, attempt),
      operationFiveSendAttemptEventInsertStatement(session, event),
    ]);
    writeOutcome =
      results.length === 2
        && results[0]?.success === true
        && results[0].meta?.changes === 1
        && results[1]?.success === true
        && results[1].meta?.changes === 1
        ? "created"
        : "unknown";
  } catch {
    writeOutcome = "failed";
  }

  const persisted = await readOperationFiveSendAttemptPair(
    session,
    attempt.authorizationIdSha256,
  );
  return classifyOperationFiveSendAttemptPairReadback(
    writeOutcome,
    persisted,
    attempt,
    event,
  );
}

export async function createOperationFiveGatewayDispatchTriple(
  database: D1Database,
  attempt: OperationFiveSendAttempt,
  event: OperationFiveSendStartedEvent,
  dispatch: OperationFiveGatewayEvent,
): Promise<{
  classification: "created" | "exact_replay";
  triple: OperationFiveGatewayDispatchTriple;
}> {
  const session = database.withSession("first-primary");
  await requireExecutionSchema(session);
  let writeOutcome: "created" | "failed" | "unknown";
  try {
    const results = await session.batch([
      operationFiveSendAttemptInsertStatement(session, attempt),
      operationFiveSendAttemptEventInsertStatement(session, event),
      operationFiveGatewayEventInsertStatement(session, dispatch),
    ]);
    writeOutcome =
      results.length === 3
        && results.every((result) => result.success === true)
        && results[0]?.meta?.changes === 1
        && results[1]?.meta?.changes === 1
        && (results[2]?.meta?.changes ?? 0) >= 1
        ? "created"
        : "unknown";
  } catch {
    writeOutcome = "failed";
  }

  const pair = await readOperationFiveSendAttemptPair(
    session,
    attempt.authorizationIdSha256,
  );
  const persistedDispatch = await readOperationFiveGatewayEvent(
    session,
    attempt.authorizationIdSha256,
    attempt.attemptDigestSha256,
    dispatch.eventSequence,
  );
  if (pair === null || persistedDispatch === null) {
    if (writeOutcome === "failed") {
      throw new RepositoryConflictError(
        "operation_five_gateway_dispatch_not_created",
      );
    }
    throw new RepositoryUnavailableError(true);
  }
  if (
    !matchesOperationFiveSendAttempt(pair.attempt, attempt)
    || !matchesOperationFiveSendStartedEvent(pair.event, event)
    || !matchesOperationFiveGatewayEvent(persistedDispatch, dispatch)
  ) {
    if (writeOutcome === "failed") {
      throw new RepositoryConflictError(
        "operation_five_gateway_dispatch_conflict",
      );
    }
    throw new RepositoryUnavailableError(true);
  }
  return {
    classification: writeOutcome === "created"
      ? "created"
      : "exact_replay",
    triple: { pair, dispatch: persistedDispatch },
  };
}

export async function appendOperationFiveGatewayEvent(
  database: D1Database,
  event: OperationFiveGatewayEvent,
): Promise<{
  classification: "created" | "exact_replay";
  event: OperationFiveGatewayEventRow;
}> {
  const session = database.withSession("first-primary");
  await requireExecutionSchema(session);
  let writeOutcome: "created" | "failed" | "unknown";
  try {
    const results = await session.batch([
      operationFiveGatewayEventInsertStatement(session, event),
    ]);
    writeOutcome =
      results.length === 1
        && results[0]?.success === true
        && (results[0].meta?.changes ?? 0) >= 1
        ? "created"
        : "unknown";
  } catch {
    writeOutcome = "failed";
  }
  const persisted = await readOperationFiveGatewayEvent(
    session,
    event.authorizationIdSha256,
    event.attemptDigestSha256,
    event.eventSequence,
  );
  if (persisted === null) {
    if (writeOutcome === "failed") {
      throw new RepositoryConflictError(
        "operation_five_gateway_event_not_created",
      );
    }
    throw new RepositoryUnavailableError(true);
  }
  if (!matchesOperationFiveGatewayEvent(persisted, event)) {
    if (writeOutcome === "failed") {
      throw new RepositoryConflictError(
        "operation_five_gateway_event_conflict",
      );
    }
    throw new RepositoryUnavailableError(true);
  }
  return {
    classification: writeOutcome === "created"
      ? "created"
      : "exact_replay",
    event: persisted,
  };
}

export async function readOperationFiveGatewayEventChain(
  database: D1Database,
  authorizationIdSha256: string,
  attemptDigestSha256: string,
): Promise<OperationFiveGatewayEventRow[]> {
  const session = database.withSession("first-primary");
  await requireExecutionSchema(session);
  try {
    const rows = await session
      .prepare(SELECT_OPERATION_FIVE_GATEWAY_EVENTS_SQL)
      .bind(authorizationIdSha256, attemptDigestSha256)
      .all<OperationFiveGatewayEventRow>();
    return rows.results;
  } catch {
    throw new RepositoryUnavailableError(true);
  }
}

export async function readExactOperationFiveTerminal(
  database: D1Database,
  authorizationIdSha256: string,
  claimDigestSha256: string,
): Promise<OperationFiveTerminalRow | null> {
  const session = database.withSession("first-primary");
  await requireExecutionSchema(session);
  const row = await readOperationFiveTerminal(
    session,
    authorizationIdSha256,
  );
  if (
    row !== null
    && row.claim_digest_sha256 !== claimDigestSha256
  ) {
    throw new RepositoryConflictError(
      "operation_five_terminal_conflict",
    );
  }
  return row;
}

export async function createOperationFiveTerminal(
  database: D1Database,
  terminal: OperationFiveTerminal,
): Promise<{
  classification: "created" | "exact_replay";
  terminal: OperationFiveTerminalRow;
  claim: ExecutionClaimRow;
  receipt: ExecutionReceiptRow;
}> {
  const session = database.withSession("first-primary");
  await requireExecutionSchema(session);
  let writeOutcome: "created" | "failed" | "unknown";
  try {
    const result = await operationFiveTerminalInsertStatement(
      session,
      terminal,
    ).run();
    writeOutcome =
      result.success === true
        && (result.meta?.changes ?? 0) >= 1
        ? "created"
        : "unknown";
  } catch {
    writeOutcome = "failed";
  }

  const persisted = await readOperationFiveTerminal(
    session,
    terminal.authorizationIdSha256,
  );
  if (persisted === null) {
    if (writeOutcome === "failed") {
      throw new RepositoryConflictError(
        "operation_five_terminal_not_created",
      );
    }
    throw new RepositoryUnavailableError(true);
  }
  if (!matchesOperationFiveTerminal(persisted, terminal)) {
    if (writeOutcome === "failed") {
      throw new RepositoryConflictError(
        "operation_five_terminal_conflict",
      );
    }
    throw new RepositoryUnavailableError(true);
  }
  const snapshot = await readSnapshotByDigest(
    session,
    terminal.authorizationIdSha256,
    terminal.claimDigestSha256,
  );
  const receipt = await readReceipt(
    session,
    terminal.authorizationIdSha256,
    5,
  );
  if (
    receipt === null
    || snapshot.claim.status !== "running"
    || snapshot.claim.ledger_version !== 5
    || snapshot.claim.ledger_head_sha256
      !== terminal.genericTerminalReceiptDigestSha256
    || snapshot.claim.last_completed_ordinal !== 5
    || snapshot.claim.inflight_operation_ordinal !== null
    || receipt.receipt_digest_sha256
      !== terminal.genericTerminalReceiptDigestSha256
    || receipt.response_sha256
      !== terminal.terminalEvidenceManifestSha256
  ) {
    throw new RepositoryUnavailableError(true);
  }
  return {
    classification: writeOutcome === "created"
      ? "created"
      : "exact_replay",
    terminal: persisted,
    claim: snapshot.claim,
    receipt,
  };
}

function classifyOperationFiveSendAttemptPairReadback(
  writeOutcome: "created" | "failed" | "unknown",
  persisted: OperationFiveSendAttemptPair | null,
  attempt: OperationFiveSendAttempt,
  event: OperationFiveSendStartedEvent,
): {
  classification: "created" | "exact_replay";
  pair: OperationFiveSendAttemptPair;
} {
  if (persisted === null) {
    if (writeOutcome === "failed") {
      throw new RepositoryConflictError(
        "operation_five_send_attempt_pair_not_created",
      );
    }
    throw new RepositoryUnavailableError(true);
  }
  if (
    !matchesOperationFiveSendAttempt(persisted.attempt, attempt)
    || !matchesOperationFiveSendStartedEvent(persisted.event, event)
  ) {
    if (writeOutcome === "failed") {
      throw new RepositoryConflictError(
        "operation_five_send_attempt_pair_conflict",
      );
    }
    throw new RepositoryUnavailableError(true);
  }
  return {
    classification: writeOutcome === "created"
      ? "created"
      : "exact_replay",
    pair: persisted,
  };
}

function operationFiveDispatchConsumptionInsertStatement(
  session: D1DatabaseSession,
  receipt: OperationFiveDispatchConsumptionReceipt,
): D1PreparedStatement {
  return session
    .prepare(INSERT_OPERATION_FIVE_DISPATCH_CONSUMPTION_SQL)
    .bind(
      receipt.authorizationIdSha256,
      receipt.receiptContract,
      receipt.claimDigestSha256,
      receipt.applicationTicketIdSha256,
      receipt.campaignId,
      receipt.applicationDatabaseIdentitySha256,
      receipt.applicationVersionId,
      receipt.applicationGrantReceiptDigestSha256,
      receipt.applicationGrantDigestSha256,
      receipt.authorityDispatchOutboxDigestSha256,
      receipt.operationFiveStartReceiptSha256,
      receipt.authorityDispatchClaimDigestSha256,
      receipt.authorityDatabaseIdentitySha256,
      receipt.authorityLedgerIdentitySha256,
      receipt.authorityLedgerHeadSha256,
      receipt.authorityVersionId,
      receipt.dispatchOwnerSha256,
      receipt.leaseTokenSha256,
      receipt.leaseGeneration,
      receipt.leaseExpiresAt,
      receipt.normalDeadlineAt,
      receipt.permitExpiresAt,
      receipt.dispatchClaimCredentialIdSha256,
      receipt.dispatchClaimRequestIdSha256,
      receipt.commandDispatchClaimRequestIdSha256,
      receipt.authorityDispatchClaimedAt,
      receipt.controllerServiceName,
      receipt.controllerEnableOperationIdSha256,
      receipt.controllerBaselineVersionId,
      receipt.controllerEnabledVersionId,
      receipt.sendAttemptLimit,
      receipt.retryLimit,
      receipt.missingReadbackAllowsResend,
      receipt.applicationDispatchConsumptionDigestSha256,
      receipt.applicationDispatchConsumptionCredentialIdSha256,
      receipt.applicationDispatchConsumptionRequestIdSha256,
      receipt.commandDispatchConsumptionRequestIdSha256,
      receipt.applicationConsumptionState,
      receipt.applicationConsumedAt,
      receipt.applicationResponseSha256,
      receipt.applicationResponseBytes,
      receipt.consumeCredentialIdSha256,
      receipt.consumeRequestIdSha256,
      receipt.commandConsumeRequestIdSha256,
      receipt.receiptDigestSha256,
    );
}

function operationFiveDispatchConsumptionRecoveryInsertStatement(
  session: D1DatabaseSession,
  recovery: OperationFiveDispatchConsumptionRecoveryEvidence,
): D1PreparedStatement {
  return session
    .prepare(INSERT_OPERATION_FIVE_DISPATCH_CONSUMPTION_RECOVERY_SQL)
    .bind(
      recovery.authorizationIdSha256,
      recovery.recoveryContract,
      recovery.claimDigestSha256,
      recovery.applicationTicketIdSha256,
      recovery.campaignId,
      recovery.applicationDatabaseIdentitySha256,
      recovery.applicationVersionId,
      recovery.authorityDispatchClaimDigestSha256,
      recovery.applicationDispatchConsumptionDigestSha256,
      recovery.applicationDispatchConsumptionCredentialIdSha256,
      recovery.applicationDispatchConsumptionRequestIdSha256,
      recovery.commandDispatchConsumptionRequestIdSha256,
      recovery.applicationConsumedAt,
      recovery.applicationHistoryReadCredentialIdSha256,
      recovery.applicationHistoryReadRequestIdSha256,
      recovery.applicationResponseSha256,
      recovery.applicationResponseBytes,
      recovery.applicationDatabaseNow,
      recovery.recoveryCredentialIdSha256,
      recovery.recoveryRequestIdSha256,
      recovery.commandRecoveryRequestIdSha256,
      recovery.retentionDeadlineAt,
      recovery.receiptDigestSha256,
      recovery.recoveryEvidenceDigestSha256,
    );
}

function operationFiveSendAttemptInsertStatement(
  session: D1DatabaseSession,
  attempt: OperationFiveSendAttempt,
): D1PreparedStatement {
  return session
    .prepare(INSERT_OPERATION_FIVE_SEND_ATTEMPT_SQL)
    .bind(
      attempt.authorizationIdSha256,
      attempt.attemptContract,
      attempt.claimDigestSha256,
      attempt.authorityDispatchClaimDigestSha256,
      attempt.dispatchConsumptionReceiptDigestSha256,
      attempt.applicationDispatchConsumptionDigestSha256,
      attempt.applicationTicketIdSha256,
      attempt.campaignId,
      attempt.applicationDatabaseIdentitySha256,
      attempt.applicationVersionId,
      attempt.authorityDatabaseIdentitySha256,
      attempt.authorityLedgerIdentitySha256,
      attempt.authorityLedgerHeadSha256,
      attempt.authorityVersionId,
      attempt.dispatchOwnerSha256,
      attempt.leaseTokenSha256,
      attempt.controllerServiceName,
      attempt.controllerEnableOperationIdSha256,
      attempt.controllerBaselineVersionId,
      attempt.controllerEnabledVersionId,
      attempt.controllerCommandContract,
      attempt.controllerCommandDigestSha256,
      attempt.gatewayIdempotencyContract,
      attempt.gatewayIdempotencyKeySha256,
      attempt.sendCredentialIdSha256,
      attempt.sendRequestIdSha256,
      attempt.commandSendAttemptRequestIdSha256,
      attempt.attemptDigestSha256,
    );
}

function operationFiveSendAttemptEventInsertStatement(
  session: D1DatabaseSession,
  event: OperationFiveSendStartedEvent,
): D1PreparedStatement {
  return session
    .prepare(INSERT_OPERATION_FIVE_SEND_ATTEMPT_EVENT_SQL)
    .bind(
      event.authorizationIdSha256,
      event.attemptDigestSha256,
      event.eventContract,
      event.predecessorEventDigestSha256,
      event.dispatchConsumptionReceiptDigestSha256,
      event.controllerCommandDigestSha256,
      event.gatewayIdempotencyKeySha256,
      event.eventDigestSha256,
    );
}

function operationFiveGatewayEventInsertStatement(
  session: D1DatabaseSession,
  event: OperationFiveGatewayEvent,
): D1PreparedStatement {
  return session
    .prepare(INSERT_OPERATION_FIVE_GATEWAY_EVENT_SQL)
    .bind(
      event.authorizationIdSha256,
      event.attemptDigestSha256,
      event.sendStartedEventDigestSha256,
      event.eventSequence,
      event.eventContract,
      event.eventKind,
      event.predecessorEventDigestSha256,
      event.gatewayIdempotencyKeySha256,
      event.controllerCommandDigestSha256,
      event.gatewayCredentialRole,
      event.gatewayCredentialIdSha256,
      event.gatewayRequestIdSha256,
      event.gatewayResponseSha256,
      event.gatewayResponseBytes,
      event.gatewayVersionId,
      event.mutationRequestSha256,
      event.resultClassification,
      event.resultHttpStatus,
      event.resultResponseBodySha256,
      event.resultResponseRequestIdSha256,
      event.resultResponseBytes,
      event.statusClassification,
      event.deploymentsHttpStatus,
      event.versionHttpStatus,
      event.deploymentSetSha256,
      event.targetVersionSha256,
      event.statusResponseRequestIdSha256,
      event.observationDigestSha256,
      event.gatewayRecordedAt,
      event.targetStable,
      event.requiredMatchingObservations,
      event.stabilityMinimumSeconds,
      event.stabilityPredecessorObservationDigestSha256,
      event.stabilityPredecessorRecordedAt,
      event.eventDigestSha256,
    );
}

function operationFiveTerminalInsertStatement(
  session: D1DatabaseSession,
  terminal: OperationFiveTerminal,
): D1PreparedStatement {
  return session
    .prepare(INSERT_OPERATION_FIVE_TERMINAL_SQL)
    .bind(
      terminal.authorizationIdSha256,
      terminal.terminalContract,
      terminal.claimDigestSha256,
      terminal.claimOwnerSha256,
      terminal.leaseOwnerSha256,
      terminal.leaseTokenSha256,
      terminal.attemptDigestSha256,
      terminal.sendStartedEventDigestSha256,
      terminal.stableGatewayEventSequence,
      terminal.stableGatewayEventDigestSha256,
      terminal.stableGatewayPredecessorEventDigestSha256,
      terminal.stableGatewayRequestIdSha256,
      terminal.stableGatewayResponseSha256,
      terminal.stableGatewayResponseBytes,
      terminal.stableObservationDigestSha256,
      terminal.stableStatusResponseRequestIdSha256,
      terminal.stableGatewayRecordedAt,
      terminal.deploymentSetSha256,
      terminal.targetVersionSha256,
      terminal.gatewayVersionId,
      terminal.controllerServiceName,
      terminal.controllerEnabledVersionId,
      terminal.controllerCommandDigestSha256,
      terminal.gatewayIdempotencyKeySha256,
      terminal.authorityDatabaseIdentitySha256,
      terminal.authorityLedgerIdentitySha256,
      terminal.authorityDispatchVersionId,
      terminal.authorityTerminalVersionId,
      terminal.operationFiveIdSha256,
      terminal.operationFiveRequestSha256,
      terminal.operationStartReceiptDigestSha256,
      terminal.operationStartCredentialIdSha256,
      terminal.operationStartRequestIdSha256,
      terminal.admissionConfirmationDigestSha256,
      terminal.terminalWriterCredentialIdSha256,
      terminal.terminalWriterRequestIdSha256,
      terminal.terminalCommandDigestSha256,
      terminal.ledgerHeadBeforeSha256,
      terminal.ledgerHeadAfterSha256,
      terminal.terminalEvidenceManifestSha256,
      terminal.genericTerminalReceiptDigestSha256,
      terminal.nextOperationIdSha256,
    );
}

async function requireExecutionSchema(
  session: D1DatabaseSession,
): Promise<void> {
  let row: SchemaProbeRow | null;
  try {
    row = await session
      .prepare(SCHEMA_PROBE_SQL)
      .first<SchemaProbeRow>();
  } catch {
    throw new RepositoryUnavailableError(false);
  }
  if (
    row === null
    || row.claim_columns !== CLAIM_COLUMNS.join(",")
    || row.operation_columns !== OPERATION_COLUMNS.join(",")
    || row.receipt_columns !== RECEIPT_COLUMNS.join(",")
    || row.operation_five_admission_columns
      !== OPERATION_FIVE_ADMISSION_COLUMNS.join(",")
    || row.operation_five_dispatch_outbox_columns
      !== OPERATION_FIVE_DISPATCH_OUTBOX_COLUMNS.join(",")
    || row.operation_five_application_grant_columns
      !== OPERATION_FIVE_APPLICATION_GRANT_COLUMNS.join(",")
    || row.operation_five_dispatch_claim_columns
      !== OPERATION_FIVE_DISPATCH_CLAIM_COLUMNS.join(",")
    || row.operation_five_dispatch_claim_triggers
      !== OPERATION_FIVE_DISPATCH_CLAIM_TRIGGERS.join(",")
    || row.operation_five_dispatch_consumption_columns
      !== OPERATION_FIVE_DISPATCH_CONSUMPTION_COLUMNS.join(",")
    || row.operation_five_dispatch_consumption_triggers
      !== OPERATION_FIVE_DISPATCH_CONSUMPTION_TRIGGERS.join(",")
    || row.operation_five_dispatch_consumption_recovery_columns
      !== OPERATION_FIVE_DISPATCH_CONSUMPTION_RECOVERY_COLUMNS.join(",")
    || row.operation_five_dispatch_consumption_recovery_triggers
      !== OPERATION_FIVE_DISPATCH_CONSUMPTION_RECOVERY_TRIGGERS.join(",")
    || row.operation_five_send_attempt_columns
      !== OPERATION_FIVE_SEND_ATTEMPT_COLUMNS.join(",")
    || row.operation_five_send_attempt_triggers
      !== OPERATION_FIVE_SEND_ATTEMPT_TRIGGERS.join(",")
    || row.operation_five_send_attempt_event_columns
      !== OPERATION_FIVE_SEND_ATTEMPT_EVENT_COLUMNS.join(",")
    || row.operation_five_send_attempt_event_triggers
      !== OPERATION_FIVE_SEND_ATTEMPT_EVENT_TRIGGERS.join(",")
    || row.operation_five_gateway_event_columns
      !== OPERATION_FIVE_GATEWAY_EVENT_COLUMNS.join(",")
    || row.operation_five_gateway_event_triggers
      !== OPERATION_FIVE_GATEWAY_EVENT_TRIGGERS.join(",")
    || row.operation_five_terminal_columns
      !== OPERATION_FIVE_TERMINAL_COLUMNS.join(",")
    || row.operation_five_terminal_triggers
      !== OPERATION_FIVE_TERMINAL_TRIGGERS.join(",")
  ) {
    throw new RepositoryUnavailableError(false);
  }
}

async function readOperationFiveAdmission(
  session: D1DatabaseSession,
  authorizationIdSha256: string,
): Promise<OperationFiveAdmissionRow | null> {
  try {
    return await session
      .prepare(
        `SELECT ${OPERATION_FIVE_ADMISSION_COLUMNS.join(", ")}
         FROM shard_placement_authority_operation_five_admissions
         WHERE authorization_id_sha256 = ?1
         LIMIT 1`,
      )
      .bind(authorizationIdSha256)
      .first<OperationFiveAdmissionRow>();
  } catch {
    throw new RepositoryUnavailableError(true);
  }
}

async function readOperationFiveDispatchOutbox(
  session: D1DatabaseSession,
  authorizationIdSha256: string,
): Promise<OperationFiveDispatchOutboxRow | null> {
  try {
    return await session
      .prepare(
        `SELECT ${OPERATION_FIVE_DISPATCH_OUTBOX_COLUMNS.join(", ")}
         FROM shard_placement_authority_operation_five_dispatch_outbox
         WHERE authorization_id_sha256 = ?1
         LIMIT 1`,
      )
      .bind(authorizationIdSha256)
      .first<OperationFiveDispatchOutboxRow>();
  } catch {
    throw new RepositoryUnavailableError(true);
  }
}

async function readOperationFiveApplicationGrant(
  session: D1DatabaseSession,
  authorizationIdSha256: string,
): Promise<OperationFiveApplicationGrantReceiptRow | null> {
  try {
    return await session
      .prepare(
        `SELECT ${OPERATION_FIVE_APPLICATION_GRANT_COLUMNS.join(", ")}
         FROM shard_placement_authority_operation_five_application_grants
         WHERE authorization_id_sha256 = ?1
         LIMIT 1`,
      )
      .bind(authorizationIdSha256)
      .first<OperationFiveApplicationGrantReceiptRow>();
  } catch {
    throw new RepositoryUnavailableError(true);
  }
}

async function readOperationFiveDispatchClaim(
  session: D1DatabaseSession,
  authorizationIdSha256: string,
): Promise<OperationFiveDispatchClaimRow | null> {
  try {
    return await session
      .prepare(SELECT_OPERATION_FIVE_DISPATCH_CLAIM_SQL)
      .bind(authorizationIdSha256)
      .first<OperationFiveDispatchClaimRow>();
  } catch {
    throw new RepositoryUnavailableError(true);
  }
}

async function readOperationFiveDispatchConsumption(
  session: D1DatabaseSession,
  authorizationIdSha256: string,
): Promise<OperationFiveDispatchConsumptionReceiptRow | null> {
  try {
    return await session
      .prepare(SELECT_OPERATION_FIVE_DISPATCH_CONSUMPTION_SQL)
      .bind(authorizationIdSha256)
      .first<OperationFiveDispatchConsumptionReceiptRow>();
  } catch {
    throw new RepositoryUnavailableError(true);
  }
}

async function readOperationFiveDispatchConsumptionRecovery(
  session: D1DatabaseSession,
  authorizationIdSha256: string,
): Promise<
  OperationFiveDispatchConsumptionRecoveryEvidenceRow | null
> {
  try {
    return await session
      .prepare(SELECT_OPERATION_FIVE_DISPATCH_CONSUMPTION_RECOVERY_SQL)
      .bind(authorizationIdSha256)
      .first<OperationFiveDispatchConsumptionRecoveryEvidenceRow>();
  } catch {
    throw new RepositoryUnavailableError(true);
  }
}

async function readOperationFiveSendAttemptPair(
  session: D1DatabaseSession,
  authorizationIdSha256: string,
): Promise<OperationFiveSendAttemptPair | null> {
  let attempt: OperationFiveSendAttemptRow | null;
  let event: OperationFiveSendStartedEventRow | null;
  try {
    attempt = await session
      .prepare(SELECT_OPERATION_FIVE_SEND_ATTEMPT_SQL)
      .bind(authorizationIdSha256)
      .first<OperationFiveSendAttemptRow>();
    event = await session
      .prepare(SELECT_OPERATION_FIVE_SEND_ATTEMPT_EVENT_SQL)
      .bind(authorizationIdSha256)
      .first<OperationFiveSendStartedEventRow>();
  } catch {
    throw new RepositoryUnavailableError(true);
  }
  return assembleOperationFiveSendAttemptPair(attempt, event);
}

async function readOperationFiveGatewayEvent(
  session: D1DatabaseSession,
  authorizationIdSha256: string,
  attemptDigestSha256: string,
  eventSequence: number,
): Promise<OperationFiveGatewayEventRow | null> {
  try {
    return await session
      .prepare(SELECT_OPERATION_FIVE_GATEWAY_EVENT_SQL)
      .bind(
        authorizationIdSha256,
        attemptDigestSha256,
        eventSequence,
      )
      .first<OperationFiveGatewayEventRow>();
  } catch {
    throw new RepositoryUnavailableError(true);
  }
}

async function readOperationFiveTerminal(
  session: D1DatabaseSession,
  authorizationIdSha256: string,
): Promise<OperationFiveTerminalRow | null> {
  try {
    return await session
      .prepare(SELECT_OPERATION_FIVE_TERMINAL_SQL)
      .bind(authorizationIdSha256)
      .first<OperationFiveTerminalRow>();
  } catch {
    throw new RepositoryUnavailableError(true);
  }
}

function assembleOperationFiveSendAttemptPair(
  attempt: OperationFiveSendAttemptRow | null,
  event: OperationFiveSendStartedEventRow | null,
): OperationFiveSendAttemptPair | null {
  if (attempt === null && event === null) return null;
  if (
    attempt === null
    || event === null
    || event.authorization_id_sha256
      !== attempt.authorization_id_sha256
    || event.attempt_digest_sha256 !== attempt.attempt_digest_sha256
  ) {
    throw new RepositoryUnavailableError(true);
  }
  return { attempt, event };
}

async function readSnapshot(
  session: D1DatabaseSession,
  authorizationIdSha256: string,
  claimDigestSha256: string,
  claimOwnerSha256: string,
): Promise<ExecutionClaimSnapshot> {
  const claim = await readClaim(
    session,
    authorizationIdSha256,
    claimDigestSha256,
    "AND claim_owner_sha256 = ?3",
    claimOwnerSha256,
  );
  return readSnapshotRows(session, claim);
}

async function readSnapshotByDigest(
  session: D1DatabaseSession,
  authorizationIdSha256: string,
  claimDigestSha256: string,
): Promise<ExecutionClaimSnapshot> {
  const claim = await readClaim(
    session,
    authorizationIdSha256,
    claimDigestSha256,
    "",
  );
  return readSnapshotRows(session, claim);
}

async function readClaim(
  session: D1DatabaseSession,
  authorizationIdSha256: string,
  claimDigestSha256: string,
  extraPredicate: string,
  extraBinding?: string,
): Promise<ExecutionClaimRow> {
  let claim: ExecutionClaimRow | null;
  try {
    const statement = session
      .prepare(
        `SELECT ${CLAIM_COLUMNS.join(", ")}
         FROM shard_placement_authority_execution_claims
         WHERE authorization_id_sha256 = ?1
           AND claim_digest_sha256 = ?2
           ${extraPredicate}
         LIMIT 1`,
      );
    claim = extraBinding === undefined
      ? await statement
        .bind(authorizationIdSha256, claimDigestSha256)
        .first<ExecutionClaimRow>()
      : await statement
        .bind(authorizationIdSha256, claimDigestSha256, extraBinding)
        .first<ExecutionClaimRow>();
  } catch {
    throw new RepositoryUnavailableError(false);
  }
  if (claim === null) {
    await classifyMissingClaim(session, authorizationIdSha256);
  }
  return claim!;
}

async function readSnapshotRows(
  session: D1DatabaseSession,
  claim: ExecutionClaimRow,
): Promise<ExecutionClaimSnapshot> {
  try {
    const operations = await session
      .prepare(
        `SELECT ${OPERATION_COLUMNS.join(", ")}
         FROM shard_placement_authority_execution_operations
         WHERE authorization_id_sha256 = ?1
         ORDER BY ordinal`,
      )
      .bind(claim.authorization_id_sha256)
      .all<ExecutionOperationRow>();
    const receipts = await session
      .prepare(
        `SELECT ${RECEIPT_COLUMNS.join(", ")}
         FROM shard_placement_authority_execution_receipts
         WHERE authorization_id_sha256 = ?1
         ORDER BY sequence`,
      )
      .bind(claim.authorization_id_sha256)
      .all<ExecutionReceiptRow>();
    return {
      claim,
      operations: operations.results,
      receipts: receipts.results,
    };
  } catch {
    throw new RepositoryUnavailableError(false);
  }
}

async function classifyMissingClaim(
  session: D1DatabaseSession,
  authorizationIdSha256: string,
): Promise<never> {
  let present: { present: number } | null;
  try {
    present = await session
      .prepare(
        `SELECT 1 AS present
         FROM shard_placement_authority_execution_claims
         WHERE authorization_id_sha256 = ?1
         LIMIT 1`,
      )
      .bind(authorizationIdSha256)
      .first<{ present: number }>();
  } catch {
    throw new RepositoryUnavailableError(false);
  }
  if (present === null) throw new RepositoryNotFoundError();
  throw new RepositoryConflictError("exact_execution_claim_mismatch");
}

async function readReceipt(
  session: D1DatabaseSession,
  authorizationIdSha256: string,
  sequence: number,
): Promise<ExecutionReceiptRow | null> {
  try {
    return await session
      .prepare(
        `SELECT ${RECEIPT_COLUMNS.join(", ")}
         FROM shard_placement_authority_execution_receipts
         WHERE authorization_id_sha256 = ?1
           AND sequence = ?2
         LIMIT 1`,
      )
      .bind(authorizationIdSha256, sequence)
      .first<ExecutionReceiptRow>();
  } catch {
    throw new RepositoryUnavailableError(true);
  }
}

function matchesClaimSnapshot(
  snapshot: ExecutionClaimSnapshot,
  claim: ExecutionClaim,
): boolean {
  const row = snapshot.claim;
  return (
    row.authorization_id_sha256 === claim.authorizationIdSha256
    && row.permit_subject_digest_sha256
      === claim.permitSubjectDigestSha256
    && row.execution_nonce_sha256 === claim.executionNonceSha256
    && row.application_ticket_id_sha256
      === claim.applicationTicketIdSha256
    && row.application_ticket_digest_sha256
      === claim.applicationTicketDigestSha256
    && row.application_database_identity_sha256
      === claim.applicationDatabaseIdentitySha256
    && row.authority_database_identity_sha256
      === claim.authorityDatabaseIdentitySha256
    && row.campaign_id === claim.campaignId
    && row.campaign_nonce_sha256 === claim.campaignNonceSha256
    && row.claim_scope === claim.claimScope
    && row.execution_plan_sha256 === claim.executionPlanSha256
    && row.release_sha256 === claim.releaseSha256
    && row.publication_sha256 === claim.publicationSha256
    && row.execution_activation_sha256
      === claim.executionActivationSha256
    && row.runner_build_sha256 === claim.runnerBuildSha256
    && row.claim_owner_sha256 === claim.claimOwnerSha256
    && row.ledger_identity_sha256 === claim.ledgerIdentitySha256
    && row.baseline_operation_id_sha256
      === claim.baselineOperationIdSha256
    && row.baseline_terminal_digest_sha256
      === claim.baselineTerminalReceiptSha256
    && row.preparation_operation_id_sha256
      === claim.preparationOperationIdSha256
    && row.claim_operation_id_sha256
      === claim.claimOperationIdSha256
    && row.operation_schedule_sha256
      === claim.operationScheduleSha256
    && row.claim_credential_id_sha256
      === claim.claimCredentialIdSha256
    && row.claim_request_id_sha256 === claim.requestIdSha256
    && row.claim_digest_sha256 === claim.claimDigestSha256
    && row.claim_acquired_receipt_digest_sha256
      === claim.claimAcquiredReceiptSha256
    && row.generated_at === claim.generatedAt
    && row.normal_deadline_at === claim.normalDeadlineAt
    && snapshot.operations.length === claim.operations.length
    && snapshot.operations.every(
      (operation, index) =>
        matchesOperation(operation, claim.operations[index]!),
    )
    && snapshot.receipts.length >= 1
    && snapshot.receipts[0]?.receipt_digest_sha256
      === claim.claimAcquiredReceiptSha256
    && snapshot.receipts[0]?.lease_owner_sha256
      === claim.claimOwnerSha256
    && snapshot.receipts[0]?.lease_token_sha256
      === claim.leaseTokenSha256
    && snapshot.receipts[0]?.lease_generation === 1
  );
}

function matchesOperation(
  row: ExecutionOperationRow,
  operation: ExecutionOperation,
): boolean {
  return (
    row.ordinal === operation.ordinal
    && row.operation_id_sha256 === operation.operationIdSha256
    && row.kind === operation.kind
    && row.shard_index === operation.shardIndex
  );
}

function matchesReceipt(
  row: ExecutionReceiptRow,
  receipt: ExecutionReceipt,
  credentialIdSha256: string,
): boolean {
  return (
    row.sequence === receipt.sequence
    && row.event_kind === receipt.eventKind
    && row.claim_digest_sha256 === receipt.claimDigestSha256
    && row.execution_plan_sha256 === receipt.executionPlanSha256
    && row.ledger_identity_sha256 === receipt.ledgerIdentitySha256
    && row.operation_ordinal === receipt.operationOrdinal
    && row.operation_id_sha256 === receipt.operationIdSha256
    && row.operation_kind === receipt.operationKind
    && row.shard_index === receipt.shardIndex
    && row.predecessor_receipt_sha256
      === receipt.predecessorReceiptSha256
    && row.request_sha256 === receipt.requestSha256
    && row.response_sha256 === receipt.responseSha256
    && row.cloudflare_request_id_sha256
      === receipt.cloudflareRequestIdSha256
    && row.evidence_sha256 === receipt.evidenceSha256
    && row.safety_reason === receipt.safetyReason
    && row.outcome === receipt.outcome
    && row.lease_owner_sha256 === receipt.actorOwnerSha256
    && row.lease_token_sha256 === receipt.leaseTokenSha256
    && row.lease_generation === receipt.leaseGeneration
    && row.receipt_credential_id_sha256 === credentialIdSha256
    && row.request_id_sha256 === receipt.requestIdSha256
    && row.receipt_digest_sha256 === receipt.receiptDigestSha256
  );
}

function matchesOperationFiveAdmission(
  row: OperationFiveAdmissionRow,
  admission: OperationFiveAdmission,
): boolean {
  return (
    row.authorization_id_sha256 === admission.authorizationIdSha256
    && row.contract_version === 1
    && row.confirmation_contract === admission.confirmationContract
    && row.claim_digest_sha256 === admission.claimDigestSha256
    && row.application_ticket_id_sha256
      === admission.applicationTicketIdSha256
    && row.application_ticket_digest_sha256
      === admission.applicationTicketDigestSha256
    && row.application_database_identity_sha256
      === admission.applicationDatabaseIdentitySha256
    && row.application_activation_digest_sha256
      === admission.applicationActivationDigestSha256
    && row.authority_activation_terminal_receipt_sha256
      === admission.authorityActivationTerminalReceiptSha256
    && row.authority_ledger_head_sha256
      === admission.authorityLedgerHeadSha256
    && row.authority_database_identity_sha256
      === admission.authorityDatabaseIdentitySha256
    && row.authority_version_id === admission.authorityVersionId
    && row.application_acknowledgement_digest_sha256
      === admission.applicationAcknowledgementDigestSha256
    && row.application_version_id === admission.applicationVersionId
    && row.application_read_credential_id_sha256
      === admission.applicationReadCredentialIdSha256
    && row.application_read_request_id_sha256
      === admission.applicationReadRequestIdSha256
    && row.application_response_sha256
      === admission.applicationResponseSha256
    && row.application_response_bytes
      === admission.applicationResponseBytes
    && row.enable_credential_id_sha256
      === admission.enableCredentialIdSha256
    && row.enable_request_id_sha256 === admission.enableRequestIdSha256
    && row.command_enable_request_id_sha256
      === admission.commandEnableRequestIdSha256
    && row.enable_operation_request_sha256
      === admission.enableOperationRequestSha256
    && row.confirmation_digest_sha256
      === admission.confirmationDigestSha256
    && row.operation_start_receipt_digest_sha256
      === admission.operationStartReceiptDigestSha256
    && Number.isSafeInteger(row.confirmed_at)
    && row.confirmed_at > 0
  );
}

function matchesOperationFiveDispatchOutbox(
  row: OperationFiveDispatchOutboxRow,
  outbox: OperationFiveDispatchOutbox,
): boolean {
  return (
    row.authorization_id_sha256 === outbox.authorizationIdSha256
    && row.contract_version === 1
    && row.dispatch_contract === outbox.dispatchContract
    && row.claim_digest_sha256 === outbox.claimDigestSha256
    && row.application_ticket_id_sha256
      === outbox.applicationTicketIdSha256
    && row.application_ticket_digest_sha256
      === outbox.applicationTicketDigestSha256
    && row.application_database_identity_sha256
      === outbox.applicationDatabaseIdentitySha256
    && row.application_activation_digest_sha256
      === outbox.applicationActivationDigestSha256
    && row.application_acknowledgement_digest_sha256
      === outbox.applicationAcknowledgementDigestSha256
    && row.operation_five_admission_digest_sha256
      === outbox.operationFiveAdmissionDigestSha256
    && row.operation_five_start_receipt_sha256
      === outbox.operationFiveStartReceiptSha256
    && row.authority_database_identity_sha256
      === outbox.authorityDatabaseIdentitySha256
    && row.authority_version_id === outbox.authorityVersionId
    && row.authority_ledger_head_sha256
      === outbox.authorityLedgerHeadSha256
    && row.application_version_id === outbox.applicationVersionId
    && row.application_read_credential_id_sha256
      === outbox.applicationReadCredentialIdSha256
    && row.application_read_request_id_sha256
      === outbox.applicationReadRequestIdSha256
    && row.application_response_sha256
      === outbox.applicationResponseSha256
    && row.application_response_bytes
      === outbox.applicationResponseBytes
    && row.application_database_now === outbox.applicationDatabaseNow
    && row.dispatch_credential_id_sha256
      === outbox.dispatchCredentialIdSha256
    && row.dispatch_request_id_sha256
      === outbox.dispatchRequestIdSha256
    && row.command_dispatch_request_id_sha256
      === outbox.commandDispatchRequestIdSha256
    && row.controller_service_name === outbox.controllerServiceName
    && row.controller_enable_operation_id_sha256
      === outbox.controllerEnableOperationIdSha256
    && row.controller_baseline_version_id
      === outbox.controllerBaselineVersionId
    && row.controller_enabled_version_id
      === outbox.controllerEnabledVersionId
    && row.dispatch_request_sha256 === outbox.dispatchRequestSha256
    && row.outbox_digest_sha256 === outbox.outboxDigestSha256
    && row.outbox_state === "prepared"
    && Number.isSafeInteger(row.prepared_at)
    && row.prepared_at > 0
  );
}

function matchesOperationFiveApplicationGrant(
  row: OperationFiveApplicationGrantReceiptRow,
  receipt: OperationFiveApplicationGrantReceipt,
): boolean {
  return (
    row.authorization_id_sha256 === receipt.authorizationIdSha256
    && row.contract_version === 1
    && row.receipt_contract === receipt.receiptContract
    && row.claim_digest_sha256 === receipt.claimDigestSha256
    && row.application_ticket_id_sha256
      === receipt.applicationTicketIdSha256
    && row.application_ticket_digest_sha256
      === receipt.applicationTicketDigestSha256
    && row.application_database_identity_sha256
      === receipt.applicationDatabaseIdentitySha256
    && row.application_activation_digest_sha256
      === receipt.applicationActivationDigestSha256
    && row.application_acknowledgement_digest_sha256
      === receipt.applicationAcknowledgementDigestSha256
    && row.operation_five_admission_digest_sha256
      === receipt.operationFiveAdmissionDigestSha256
    && row.operation_five_start_receipt_sha256
      === receipt.operationFiveStartReceiptSha256
    && row.authority_dispatch_outbox_digest_sha256
      === receipt.authorityDispatchOutboxDigestSha256
    && row.application_grant_digest_sha256
      === receipt.applicationGrantDigestSha256
    && row.application_grant_credential_id_sha256
      === receipt.applicationGrantCredentialIdSha256
    && row.application_grant_request_id_sha256
      === receipt.applicationGrantRequestIdSha256
    && row.application_version_id === receipt.applicationVersionId
    && row.application_response_sha256
      === receipt.applicationResponseSha256
    && row.application_response_bytes
      === receipt.applicationResponseBytes
    && row.application_database_now === receipt.applicationDatabaseNow
    && row.application_granted_at === receipt.applicationGrantedAt
    && row.authority_database_identity_sha256
      === receipt.authorityDatabaseIdentitySha256
    && row.authority_ledger_identity_sha256
      === receipt.authorityLedgerIdentitySha256
    && row.authority_ledger_head_sha256
      === receipt.authorityLedgerHeadSha256
    && row.authority_version_id === receipt.authorityVersionId
    && row.grant_credential_id_sha256
      === receipt.grantCredentialIdSha256
    && row.grant_request_id_sha256 === receipt.grantRequestIdSha256
    && row.command_grant_request_id_sha256
      === receipt.commandGrantRequestIdSha256
    && row.controller_service_name === receipt.controllerServiceName
    && row.controller_enable_operation_id_sha256
      === receipt.controllerEnableOperationIdSha256
    && row.controller_baseline_version_id
      === receipt.controllerBaselineVersionId
    && row.controller_enabled_version_id
      === receipt.controllerEnabledVersionId
    && row.receipt_digest_sha256 === receipt.receiptDigestSha256
    && Number.isSafeInteger(row.recorded_at)
    && row.recorded_at > 0
  );
}

function matchesOperationFiveDispatchClaim(
  row: OperationFiveDispatchClaimRow,
  dispatchClaim: OperationFiveDispatchClaim,
): boolean {
  return (
    row.authorization_id_sha256
      === dispatchClaim.authorizationIdSha256
    && row.contract_version === 1
    && row.claim_contract === dispatchClaim.claimContract
    && row.claim_digest_sha256 === dispatchClaim.claimDigestSha256
    && row.application_ticket_id_sha256
      === dispatchClaim.applicationTicketIdSha256
    && row.application_database_identity_sha256
      === dispatchClaim.applicationDatabaseIdentitySha256
    && row.authority_dispatch_outbox_digest_sha256
      === dispatchClaim.authorityDispatchOutboxDigestSha256
    && row.application_grant_receipt_digest_sha256
      === dispatchClaim.applicationGrantReceiptDigestSha256
    && row.application_grant_digest_sha256
      === dispatchClaim.applicationGrantDigestSha256
    && row.operation_five_start_receipt_sha256
      === dispatchClaim.operationFiveStartReceiptSha256
    && row.authority_database_identity_sha256
      === dispatchClaim.authorityDatabaseIdentitySha256
    && row.authority_ledger_identity_sha256
      === dispatchClaim.authorityLedgerIdentitySha256
    && row.authority_ledger_head_sha256
      === dispatchClaim.authorityLedgerHeadSha256
    && row.authority_version_id === dispatchClaim.authorityVersionId
    && row.application_version_id === dispatchClaim.applicationVersionId
    && row.dispatch_owner_sha256 === dispatchClaim.dispatchOwnerSha256
    && row.lease_token_sha256 === dispatchClaim.leaseTokenSha256
    && row.lease_generation === dispatchClaim.leaseGeneration
    && row.lease_expires_at === dispatchClaim.leaseExpiresAt
    && row.normal_deadline_at === dispatchClaim.normalDeadlineAt
    && row.permit_expires_at === dispatchClaim.permitExpiresAt
    && row.dispatch_claim_credential_id_sha256
      === dispatchClaim.dispatchClaimCredentialIdSha256
    && row.dispatch_claim_request_id_sha256
      === dispatchClaim.dispatchClaimRequestIdSha256
    && row.command_dispatch_claim_request_id_sha256
      === dispatchClaim.commandDispatchClaimRequestIdSha256
    && row.controller_service_name === dispatchClaim.controllerServiceName
    && row.controller_enable_operation_id_sha256
      === dispatchClaim.controllerEnableOperationIdSha256
    && row.controller_baseline_version_id
      === dispatchClaim.controllerBaselineVersionId
    && row.controller_enabled_version_id
      === dispatchClaim.controllerEnabledVersionId
    && row.send_attempt_limit === dispatchClaim.sendAttemptLimit
    && row.retry_limit === dispatchClaim.retryLimit
    && row.missing_readback_allows_resend
      === dispatchClaim.missingReadbackAllowsResend
    && row.dispatch_claim_digest_sha256
      === dispatchClaim.dispatchClaimDigestSha256
    && row.claim_state === dispatchClaim.claimState
    && Number.isSafeInteger(row.claimed_at)
    && row.claimed_at > 0
  );
}

function matchesOperationFiveDispatchConsumption(
  row: OperationFiveDispatchConsumptionReceiptRow,
  receipt: OperationFiveDispatchConsumptionReceipt,
): boolean {
  return (
    row.authorization_id_sha256 === receipt.authorizationIdSha256
    && row.contract_version === 1
    && row.receipt_contract === receipt.receiptContract
    && row.claim_digest_sha256 === receipt.claimDigestSha256
    && row.application_ticket_id_sha256
      === receipt.applicationTicketIdSha256
    && row.campaign_id === receipt.campaignId
    && row.application_database_identity_sha256
      === receipt.applicationDatabaseIdentitySha256
    && row.application_version_id === receipt.applicationVersionId
    && row.application_grant_receipt_digest_sha256
      === receipt.applicationGrantReceiptDigestSha256
    && row.application_grant_digest_sha256
      === receipt.applicationGrantDigestSha256
    && row.authority_dispatch_outbox_digest_sha256
      === receipt.authorityDispatchOutboxDigestSha256
    && row.operation_five_start_receipt_sha256
      === receipt.operationFiveStartReceiptSha256
    && row.authority_dispatch_claim_digest_sha256
      === receipt.authorityDispatchClaimDigestSha256
    && row.authority_database_identity_sha256
      === receipt.authorityDatabaseIdentitySha256
    && row.authority_ledger_identity_sha256
      === receipt.authorityLedgerIdentitySha256
    && row.authority_ledger_head_sha256
      === receipt.authorityLedgerHeadSha256
    && row.authority_version_id === receipt.authorityVersionId
    && row.dispatch_owner_sha256 === receipt.dispatchOwnerSha256
    && row.lease_token_sha256 === receipt.leaseTokenSha256
    && row.lease_generation === receipt.leaseGeneration
    && row.lease_expires_at === receipt.leaseExpiresAt
    && row.normal_deadline_at === receipt.normalDeadlineAt
    && row.permit_expires_at === receipt.permitExpiresAt
    && row.dispatch_claim_credential_id_sha256
      === receipt.dispatchClaimCredentialIdSha256
    && row.dispatch_claim_request_id_sha256
      === receipt.dispatchClaimRequestIdSha256
    && row.command_dispatch_claim_request_id_sha256
      === receipt.commandDispatchClaimRequestIdSha256
    && row.authority_dispatch_claimed_at
      === receipt.authorityDispatchClaimedAt
    && row.controller_service_name === receipt.controllerServiceName
    && row.controller_enable_operation_id_sha256
      === receipt.controllerEnableOperationIdSha256
    && row.controller_baseline_version_id
      === receipt.controllerBaselineVersionId
    && row.controller_enabled_version_id
      === receipt.controllerEnabledVersionId
    && row.send_attempt_limit === receipt.sendAttemptLimit
    && row.retry_limit === receipt.retryLimit
    && row.missing_readback_allows_resend
      === receipt.missingReadbackAllowsResend
    && row.application_dispatch_consumption_digest_sha256
      === receipt.applicationDispatchConsumptionDigestSha256
    && row.application_dispatch_consumption_credential_id_sha256
      === receipt.applicationDispatchConsumptionCredentialIdSha256
    && row.application_dispatch_consumption_request_id_sha256
      === receipt.applicationDispatchConsumptionRequestIdSha256
    && row.command_dispatch_consumption_request_id_sha256
      === receipt.commandDispatchConsumptionRequestIdSha256
    && row.application_consumption_state
      === receipt.applicationConsumptionState
    && row.application_consumed_at === receipt.applicationConsumedAt
    && row.application_response_sha256
      === receipt.applicationResponseSha256
    && row.application_response_bytes === receipt.applicationResponseBytes
    && row.consume_credential_id_sha256
      === receipt.consumeCredentialIdSha256
    && row.consume_request_id_sha256 === receipt.consumeRequestIdSha256
    && row.command_consume_request_id_sha256
      === receipt.commandConsumeRequestIdSha256
    && row.receipt_digest_sha256 === receipt.receiptDigestSha256
    && Number.isSafeInteger(row.recorded_at)
    && row.recorded_at > 0
  );
}

function matchesRecoveredOperationFiveDispatchConsumptionSource(
  row: OperationFiveDispatchConsumptionReceiptRow,
  receipt: OperationFiveDispatchConsumptionReceipt,
): boolean {
  return (
    row.authorization_id_sha256 === receipt.authorizationIdSha256
    && row.contract_version === 1
    && row.receipt_contract === receipt.receiptContract
    && row.claim_digest_sha256 === receipt.claimDigestSha256
    && row.application_ticket_id_sha256
      === receipt.applicationTicketIdSha256
    && row.campaign_id === receipt.campaignId
    && row.application_database_identity_sha256
      === receipt.applicationDatabaseIdentitySha256
    && row.application_version_id === receipt.applicationVersionId
    && row.application_grant_receipt_digest_sha256
      === receipt.applicationGrantReceiptDigestSha256
    && row.application_grant_digest_sha256
      === receipt.applicationGrantDigestSha256
    && row.authority_dispatch_outbox_digest_sha256
      === receipt.authorityDispatchOutboxDigestSha256
    && row.operation_five_start_receipt_sha256
      === receipt.operationFiveStartReceiptSha256
    && row.authority_dispatch_claim_digest_sha256
      === receipt.authorityDispatchClaimDigestSha256
    && row.authority_database_identity_sha256
      === receipt.authorityDatabaseIdentitySha256
    && row.authority_ledger_identity_sha256
      === receipt.authorityLedgerIdentitySha256
    && row.authority_ledger_head_sha256
      === receipt.authorityLedgerHeadSha256
    && row.authority_version_id === receipt.authorityVersionId
    && row.dispatch_owner_sha256 === receipt.dispatchOwnerSha256
    && row.lease_token_sha256 === receipt.leaseTokenSha256
    && row.lease_generation === receipt.leaseGeneration
    && row.lease_expires_at === receipt.leaseExpiresAt
    && row.normal_deadline_at === receipt.normalDeadlineAt
    && row.permit_expires_at === receipt.permitExpiresAt
    && row.dispatch_claim_credential_id_sha256
      === receipt.dispatchClaimCredentialIdSha256
    && row.dispatch_claim_request_id_sha256
      === receipt.dispatchClaimRequestIdSha256
    && row.command_dispatch_claim_request_id_sha256
      === receipt.commandDispatchClaimRequestIdSha256
    && row.authority_dispatch_claimed_at
      === receipt.authorityDispatchClaimedAt
    && row.controller_service_name === receipt.controllerServiceName
    && row.controller_enable_operation_id_sha256
      === receipt.controllerEnableOperationIdSha256
    && row.controller_baseline_version_id
      === receipt.controllerBaselineVersionId
    && row.controller_enabled_version_id
      === receipt.controllerEnabledVersionId
    && row.send_attempt_limit === receipt.sendAttemptLimit
    && row.retry_limit === receipt.retryLimit
    && row.missing_readback_allows_resend
      === receipt.missingReadbackAllowsResend
    && row.application_dispatch_consumption_digest_sha256
      === receipt.applicationDispatchConsumptionDigestSha256
    && row.application_dispatch_consumption_credential_id_sha256
      === receipt.applicationDispatchConsumptionCredentialIdSha256
    && row.application_dispatch_consumption_request_id_sha256
      === receipt.applicationDispatchConsumptionRequestIdSha256
    && row.command_dispatch_consumption_request_id_sha256
      === receipt.commandDispatchConsumptionRequestIdSha256
    && row.application_consumption_state
      === receipt.applicationConsumptionState
    && row.application_consumed_at === receipt.applicationConsumedAt
  );
}

function matchesOperationFiveDispatchConsumptionRecovery(
  row: OperationFiveDispatchConsumptionRecoveryEvidenceRow,
  recovery: OperationFiveDispatchConsumptionRecoveryEvidence,
): boolean {
  return (
    row.authorization_id_sha256 === recovery.authorizationIdSha256
    && row.contract_version === 1
    && row.recovery_contract === recovery.recoveryContract
    && row.claim_digest_sha256 === recovery.claimDigestSha256
    && row.application_ticket_id_sha256
      === recovery.applicationTicketIdSha256
    && row.campaign_id === recovery.campaignId
    && row.application_database_identity_sha256
      === recovery.applicationDatabaseIdentitySha256
    && row.application_version_id === recovery.applicationVersionId
    && row.authority_dispatch_claim_digest_sha256
      === recovery.authorityDispatchClaimDigestSha256
    && row.application_dispatch_consumption_digest_sha256
      === recovery.applicationDispatchConsumptionDigestSha256
    && row.application_dispatch_consumption_credential_id_sha256
      === recovery.applicationDispatchConsumptionCredentialIdSha256
    && row.application_dispatch_consumption_request_id_sha256
      === recovery.applicationDispatchConsumptionRequestIdSha256
    && row.command_dispatch_consumption_request_id_sha256
      === recovery.commandDispatchConsumptionRequestIdSha256
    && row.application_consumed_at === recovery.applicationConsumedAt
    && row.application_history_read_credential_id_sha256
      === recovery.applicationHistoryReadCredentialIdSha256
    && row.application_history_read_request_id_sha256
      === recovery.applicationHistoryReadRequestIdSha256
    && row.application_response_sha256
      === recovery.applicationResponseSha256
    && row.application_response_bytes
      === recovery.applicationResponseBytes
    && row.application_database_now === recovery.applicationDatabaseNow
    && row.recovery_credential_id_sha256
      === recovery.recoveryCredentialIdSha256
    && row.recovery_request_id_sha256
      === recovery.recoveryRequestIdSha256
    && row.command_recovery_request_id_sha256
      === recovery.commandRecoveryRequestIdSha256
    && row.retention_deadline_at === recovery.retentionDeadlineAt
    && row.receipt_digest_sha256 === recovery.receiptDigestSha256
    && row.recovery_evidence_digest_sha256
      === recovery.recoveryEvidenceDigestSha256
    && Number.isSafeInteger(row.recorded_at)
    && row.recorded_at > 0
  );
}

function matchesOperationFiveSendAttempt(
  row: OperationFiveSendAttemptRow,
  attempt: OperationFiveSendAttempt,
): boolean {
  return (
    row.authorization_id_sha256 === attempt.authorizationIdSha256
    && row.contract_version === 1
    && row.attempt_contract === attempt.attemptContract
    && row.attempt_generation === attempt.attemptGeneration
    && row.retry_count === attempt.retryCount
    && row.retry_limit === attempt.retryLimit
    && row.send_attempt_limit === attempt.sendAttemptLimit
    && row.send_authority_state === attempt.sendAuthorityState
    && row.claim_digest_sha256 === attempt.claimDigestSha256
    && row.authority_dispatch_claim_digest_sha256
      === attempt.authorityDispatchClaimDigestSha256
    && row.dispatch_consumption_receipt_digest_sha256
      === attempt.dispatchConsumptionReceiptDigestSha256
    && row.application_dispatch_consumption_digest_sha256
      === attempt.applicationDispatchConsumptionDigestSha256
    && row.application_ticket_id_sha256
      === attempt.applicationTicketIdSha256
    && row.campaign_id === attempt.campaignId
    && row.application_database_identity_sha256
      === attempt.applicationDatabaseIdentitySha256
    && row.application_version_id === attempt.applicationVersionId
    && row.authority_database_identity_sha256
      === attempt.authorityDatabaseIdentitySha256
    && row.authority_ledger_identity_sha256
      === attempt.authorityLedgerIdentitySha256
    && row.authority_ledger_head_sha256
      === attempt.authorityLedgerHeadSha256
    && row.authority_version_id === attempt.authorityVersionId
    && row.dispatch_owner_sha256 === attempt.dispatchOwnerSha256
    && row.lease_token_sha256 === attempt.leaseTokenSha256
    && row.lease_generation === attempt.leaseGeneration
    && row.controller_service_name === attempt.controllerServiceName
    && row.controller_enable_operation_id_sha256
      === attempt.controllerEnableOperationIdSha256
    && row.controller_baseline_version_id
      === attempt.controllerBaselineVersionId
    && row.controller_enabled_version_id
      === attempt.controllerEnabledVersionId
    && row.controller_command_contract
      === attempt.controllerCommandContract
    && row.controller_command_digest_sha256
      === attempt.controllerCommandDigestSha256
    && row.gateway_idempotency_contract
      === attempt.gatewayIdempotencyContract
    && row.gateway_idempotency_key_sha256
      === attempt.gatewayIdempotencyKeySha256
    && row.send_credential_id_sha256
      === attempt.sendCredentialIdSha256
    && row.send_request_id_sha256 === attempt.sendRequestIdSha256
    && row.command_send_attempt_request_id_sha256
      === attempt.commandSendAttemptRequestIdSha256
    && row.controller_request_sent === attempt.controllerRequestSent
    && row.gateway_request_sent === attempt.gatewayRequestSent
    && row.attempt_digest_sha256 === attempt.attemptDigestSha256
    && Number.isSafeInteger(row.created_at)
    && row.created_at > 0
  );
}

function matchesOperationFiveSendStartedEvent(
  row: OperationFiveSendStartedEventRow,
  event: OperationFiveSendStartedEvent,
): boolean {
  return (
    row.authorization_id_sha256 === event.authorizationIdSha256
    && row.attempt_digest_sha256 === event.attemptDigestSha256
    && row.event_sequence === event.eventSequence
    && row.contract_version === 1
    && row.event_contract === event.eventContract
    && row.event_kind === event.eventKind
    && row.from_state === event.fromState
    && row.to_state === event.toState
    && row.event_semantics === event.eventSemantics
    && row.predecessor_event_digest_sha256
      === event.predecessorEventDigestSha256
    && row.dispatch_consumption_receipt_digest_sha256
      === event.dispatchConsumptionReceiptDigestSha256
    && row.controller_command_digest_sha256
      === event.controllerCommandDigestSha256
    && row.gateway_idempotency_key_sha256
      === event.gatewayIdempotencyKeySha256
    && row.controller_request_sent === event.controllerRequestSent
    && row.gateway_request_sent === event.gatewayRequestSent
    && row.event_digest_sha256 === event.eventDigestSha256
    && Number.isSafeInteger(row.recorded_at)
    && row.recorded_at > 0
  );
}

function matchesOperationFiveGatewayEvent(
  row: OperationFiveGatewayEventRow,
  event: OperationFiveGatewayEvent,
): boolean {
  return (
    row.authorization_id_sha256 === event.authorizationIdSha256
    && row.attempt_digest_sha256 === event.attemptDigestSha256
    && row.send_started_event_digest_sha256
      === event.sendStartedEventDigestSha256
    && row.event_sequence === event.eventSequence
    && row.contract_version === 1
    && row.event_contract === event.eventContract
    && row.event_kind === event.eventKind
    && row.predecessor_event_digest_sha256
      === event.predecessorEventDigestSha256
    && row.gateway_idempotency_key_sha256
      === event.gatewayIdempotencyKeySha256
    && row.controller_command_digest_sha256
      === event.controllerCommandDigestSha256
    && row.gateway_credential_role === event.gatewayCredentialRole
    && row.gateway_credential_id_sha256
      === event.gatewayCredentialIdSha256
    && row.gateway_request_id_sha256
      === event.gatewayRequestIdSha256
    && row.gateway_response_sha256 === event.gatewayResponseSha256
    && row.gateway_response_bytes === event.gatewayResponseBytes
    && row.gateway_version_id === event.gatewayVersionId
    && row.mutation_request_sha256 === event.mutationRequestSha256
    && row.result_classification === event.resultClassification
    && row.result_http_status === event.resultHttpStatus
    && row.result_response_body_sha256
      === event.resultResponseBodySha256
    && row.result_response_request_id_sha256
      === event.resultResponseRequestIdSha256
    && row.result_response_bytes === event.resultResponseBytes
    && row.status_classification === event.statusClassification
    && row.deployments_http_status === event.deploymentsHttpStatus
    && row.version_http_status === event.versionHttpStatus
    && row.deployment_set_sha256 === event.deploymentSetSha256
    && row.target_version_sha256 === event.targetVersionSha256
    && row.status_response_request_id_sha256
      === event.statusResponseRequestIdSha256
    && row.observation_digest_sha256
      === event.observationDigestSha256
    && row.gateway_recorded_at === event.gatewayRecordedAt
    && row.target_stable === event.targetStable
    && row.required_matching_observations
      === event.requiredMatchingObservations
    && row.stability_minimum_seconds
      === event.stabilityMinimumSeconds
    && row.stability_predecessor_observation_digest_sha256
      === event.stabilityPredecessorObservationDigestSha256
    && row.stability_predecessor_recorded_at
      === event.stabilityPredecessorRecordedAt
    && row.event_digest_sha256 === event.eventDigestSha256
    && Number.isSafeInteger(row.recorded_at)
    && row.recorded_at > 0
  );
}

function matchesOperationFiveTerminal(
  row: OperationFiveTerminalRow,
  terminal: OperationFiveTerminal,
): boolean {
  return (
    row.authorization_id_sha256 === terminal.authorizationIdSha256
    && row.contract_version === 1
    && row.terminal_contract === terminal.terminalContract
    && row.claim_digest_sha256 === terminal.claimDigestSha256
    && row.claim_owner_sha256 === terminal.claimOwnerSha256
    && row.lease_owner_sha256 === terminal.leaseOwnerSha256
    && row.lease_token_sha256 === terminal.leaseTokenSha256
    && row.lease_generation === terminal.leaseGeneration
    && row.attempt_digest_sha256 === terminal.attemptDigestSha256
    && row.send_started_event_digest_sha256
      === terminal.sendStartedEventDigestSha256
    && row.stable_gateway_event_sequence
      === terminal.stableGatewayEventSequence
    && row.stable_gateway_event_digest_sha256
      === terminal.stableGatewayEventDigestSha256
    && row.stable_gateway_predecessor_event_digest_sha256
      === terminal.stableGatewayPredecessorEventDigestSha256
    && row.stable_gateway_request_id_sha256
      === terminal.stableGatewayRequestIdSha256
    && row.stable_gateway_response_sha256
      === terminal.stableGatewayResponseSha256
    && row.stable_gateway_response_bytes
      === terminal.stableGatewayResponseBytes
    && row.stable_observation_digest_sha256
      === terminal.stableObservationDigestSha256
    && row.stable_status_response_request_id_sha256
      === terminal.stableStatusResponseRequestIdSha256
    && row.stable_gateway_recorded_at
      === terminal.stableGatewayRecordedAt
    && row.deployment_set_sha256 === terminal.deploymentSetSha256
    && row.target_version_sha256 === terminal.targetVersionSha256
    && row.gateway_version_id === terminal.gatewayVersionId
    && row.controller_service_name === terminal.controllerServiceName
    && row.controller_enabled_version_id
      === terminal.controllerEnabledVersionId
    && row.controller_command_digest_sha256
      === terminal.controllerCommandDigestSha256
    && row.gateway_idempotency_key_sha256
      === terminal.gatewayIdempotencyKeySha256
    && row.authority_database_identity_sha256
      === terminal.authorityDatabaseIdentitySha256
    && row.authority_ledger_identity_sha256
      === terminal.authorityLedgerIdentitySha256
    && row.authority_dispatch_version_id
      === terminal.authorityDispatchVersionId
    && row.authority_terminal_version_id
      === terminal.authorityTerminalVersionId
    && row.operation_five_id_sha256 === terminal.operationFiveIdSha256
    && row.operation_five_request_sha256
      === terminal.operationFiveRequestSha256
    && row.operation_start_receipt_digest_sha256
      === terminal.operationStartReceiptDigestSha256
    && row.operation_start_credential_id_sha256
      === terminal.operationStartCredentialIdSha256
    && row.operation_start_request_id_sha256
      === terminal.operationStartRequestIdSha256
    && row.admission_confirmation_digest_sha256
      === terminal.admissionConfirmationDigestSha256
    && row.terminal_writer_credential_id_sha256
      === terminal.terminalWriterCredentialIdSha256
    && row.terminal_writer_request_id_sha256
      === terminal.terminalWriterRequestIdSha256
    && row.terminal_command_digest_sha256
      === terminal.terminalCommandDigestSha256
    && row.ledger_head_before_sha256
      === terminal.ledgerHeadBeforeSha256
    && row.ledger_head_after_sha256
      === terminal.ledgerHeadAfterSha256
    && row.terminal_evidence_manifest_sha256
      === terminal.terminalEvidenceManifestSha256
    && row.generic_receipt_sequence === 5
    && row.generic_terminal_receipt_digest_sha256
      === terminal.genericTerminalReceiptDigestSha256
    && row.next_operation_ordinal === terminal.nextOperationOrdinal
    && row.next_operation_id_sha256
      === terminal.nextOperationIdSha256
    && Number.isSafeInteger(row.recorded_at)
    && row.recorded_at > 0
  );
}

export const executionRepositorySqlForTest = {
  insertClaim: INSERT_CLAIM_SQL,
  insertOperation: INSERT_OPERATION_SQL,
  insertReceipt: INSERT_RECEIPT_SQL,
  insertOperationFiveAdmission:
    INSERT_OPERATION_FIVE_ADMISSION_SQL,
  insertOperationFiveDispatchOutbox:
    INSERT_OPERATION_FIVE_DISPATCH_OUTBOX_SQL,
  insertOperationFiveApplicationGrant:
    INSERT_OPERATION_FIVE_APPLICATION_GRANT_SQL,
  insertOperationFiveDispatchClaim:
    INSERT_OPERATION_FIVE_DISPATCH_CLAIM_SQL,
  selectOperationFiveDispatchClaim:
    SELECT_OPERATION_FIVE_DISPATCH_CLAIM_SQL,
  insertOperationFiveDispatchConsumption:
    INSERT_OPERATION_FIVE_DISPATCH_CONSUMPTION_SQL,
  selectOperationFiveDispatchConsumption:
    SELECT_OPERATION_FIVE_DISPATCH_CONSUMPTION_SQL,
  insertOperationFiveDispatchConsumptionRecovery:
    INSERT_OPERATION_FIVE_DISPATCH_CONSUMPTION_RECOVERY_SQL,
  selectOperationFiveDispatchConsumptionRecovery:
    SELECT_OPERATION_FIVE_DISPATCH_CONSUMPTION_RECOVERY_SQL,
  insertOperationFiveSendAttempt:
    INSERT_OPERATION_FIVE_SEND_ATTEMPT_SQL,
  selectOperationFiveSendAttempt:
    SELECT_OPERATION_FIVE_SEND_ATTEMPT_SQL,
  insertOperationFiveSendAttemptEvent:
    INSERT_OPERATION_FIVE_SEND_ATTEMPT_EVENT_SQL,
  selectOperationFiveSendAttemptEvent:
    SELECT_OPERATION_FIVE_SEND_ATTEMPT_EVENT_SQL,
  insertOperationFiveGatewayEvent:
    INSERT_OPERATION_FIVE_GATEWAY_EVENT_SQL,
  selectOperationFiveGatewayEvent:
    SELECT_OPERATION_FIVE_GATEWAY_EVENT_SQL,
  insertOperationFiveTerminal:
    INSERT_OPERATION_FIVE_TERMINAL_SQL,
  selectOperationFiveTerminal:
    SELECT_OPERATION_FIVE_TERMINAL_SQL,
} as const;

export const operationFiveSendAttemptRepositoryForTest = {
  assemblePair: assembleOperationFiveSendAttemptPair,
  classifyReadback: classifyOperationFiveSendAttemptPairReadback,
} as const;
