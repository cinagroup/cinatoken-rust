-- Freeze the successful provider response and its reported usage before any
-- Container financial settlement. Historical terminal rows remain readable;
-- this migration does not synthesize receipts or rewrite existing events.

CREATE TABLE relay_container_provider_usage_receipts (
  operation_id TEXT NOT NULL
    CHECK (
      typeof(operation_id) = 'text'
      AND length(operation_id) BETWEEN 1 AND 128
      AND operation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  reservation_key TEXT NOT NULL
    CHECK (
      typeof(reservation_key) = 'text'
      AND length(reservation_key) BETWEEN 1 AND 128
      AND reservation_key NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  owner_generation INTEGER NOT NULL
    CHECK (typeof(owner_generation) = 'integer' AND owner_generation > 0),
  attempt_generation INTEGER NOT NULL
    CHECK (typeof(attempt_generation) = 'integer' AND attempt_generation = 1),
  provider_operation_id TEXT NOT NULL
    CHECK (
      typeof(provider_operation_id) = 'text'
      AND length(provider_operation_id) BETWEEN 1 AND 128
      AND provider_operation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  admission_sha256 TEXT NOT NULL
    CHECK (
      typeof(admission_sha256) = 'text'
      AND length(admission_sha256) = 64
      AND admission_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  request_sha256 TEXT NOT NULL
    CHECK (
      typeof(request_sha256) = 'text'
      AND length(request_sha256) = 64
      AND request_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  egress_profile TEXT NOT NULL
    CHECK (
      typeof(egress_profile) = 'text'
      AND egress_profile = 'openai-chat-completions-canary-v1'
    ),
  egress_worker_version_id TEXT NOT NULL
    CHECK (
      typeof(egress_worker_version_id) = 'text'
      AND length(egress_worker_version_id) BETWEEN 1 AND 128
      AND egress_worker_version_id NOT GLOB '*[^A-Za-z0-9._:/@-]*'
    ),
  billing_kind TEXT NOT NULL
    CHECK (typeof(billing_kind) = 'text' AND billing_kind IN ('tiered_expr', 'flat')),
  billing_contract_hash TEXT NOT NULL
    CHECK (
      typeof(billing_contract_hash) = 'text'
      AND (
        (
          billing_kind = 'tiered_expr'
          AND length(billing_contract_hash) = 64
          AND billing_contract_hash NOT GLOB '*[^0-9a-f]*'
        )
        OR (
          billing_kind = 'flat'
          AND length(billing_contract_hash) BETWEEN 66 AND 96
          AND substr(billing_contract_hash, length(billing_contract_hash) - 64, 1) = ':'
          AND substr(billing_contract_hash, -64) NOT GLOB '*[^0-9a-f]*'
        )
      )
    ),
  billing_snapshot_sha256 TEXT NOT NULL
    CHECK (
      typeof(billing_snapshot_sha256) = 'text'
      AND length(billing_snapshot_sha256) = 64
      AND billing_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  provider_response_status INTEGER NOT NULL
    CHECK (
      typeof(provider_response_status) = 'integer'
      AND provider_response_status BETWEEN 200 AND 299
    ),
  provider_response_sha256 TEXT NOT NULL
    CHECK (
      typeof(provider_response_sha256) = 'text'
      AND length(provider_response_sha256) = 64
      AND provider_response_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  provider_request_id TEXT
    CHECK (
      provider_request_id IS NULL
      OR (
        typeof(provider_request_id) = 'text'
        AND length(provider_request_id) BETWEEN 1 AND 128
        AND provider_request_id NOT GLOB '*[^A-Za-z0-9._:/@-]*'
      )
    ),
  provider_completed_at INTEGER NOT NULL
    CHECK (
      typeof(provider_completed_at) = 'integer'
      AND provider_completed_at BETWEEN 1 AND 253402300799999
    ),
  result_object_key TEXT NOT NULL
    CHECK (typeof(result_object_key) = 'text' AND length(result_object_key) BETWEEN 8 AND 512),
  result_object_version TEXT NOT NULL
    CHECK (
      typeof(result_object_version) = 'text'
      AND length(result_object_version) BETWEEN 1 AND 128
      AND result_object_version NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  result_sha256 TEXT NOT NULL
    CHECK (
      typeof(result_sha256) = 'text'
      AND length(result_sha256) = 64
      AND result_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  result_size INTEGER NOT NULL
    CHECK (typeof(result_size) = 'integer' AND result_size BETWEEN 2 AND 4194304),
  result_content_type TEXT NOT NULL
    CHECK (typeof(result_content_type) = 'text' AND result_content_type = 'application/json'),
  usage_schema_version INTEGER NOT NULL
    CHECK (typeof(usage_schema_version) = 'integer' AND usage_schema_version = 1),
  usage_parser_contract TEXT NOT NULL
    CHECK (
      typeof(usage_parser_contract) = 'text'
      AND usage_parser_contract = 'openai-chat-completions-usage-v1'
    ),
  usage_normalization_contract TEXT NOT NULL
    CHECK (
      typeof(usage_normalization_contract) = 'text'
      AND usage_normalization_contract = 'billing-token-normalization-v1'
    ),
  usage_present INTEGER NOT NULL
    CHECK (typeof(usage_present) = 'integer' AND usage_present IN (0, 1)),
  reported_usage_fields INTEGER NOT NULL
    CHECK (
      typeof(reported_usage_fields) = 'integer'
      AND reported_usage_fields BETWEEN 0 AND 2047
    ),
  usage_estimated INTEGER NOT NULL
    CHECK (typeof(usage_estimated) = 'integer' AND usage_estimated = 0),
  usage_receipt_json TEXT NOT NULL
    CHECK (
      typeof(usage_receipt_json) = 'text'
      AND length(usage_receipt_json) BETWEEN 2 AND 8192
      AND CASE
        WHEN json_valid(usage_receipt_json) = 1
        THEN json_type(usage_receipt_json) = 'object'
        ELSE 0
      END
    ),
  usage_receipt_sha256 TEXT NOT NULL
    CHECK (
      typeof(usage_receipt_sha256) = 'text'
      AND length(usage_receipt_sha256) = 64
      AND usage_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  persisted_at INTEGER NOT NULL
    CHECK (
      typeof(persisted_at) = 'integer'
      AND persisted_at >= provider_completed_at
      AND persisted_at <= 253402300799999
    ),
  PRIMARY KEY (operation_id, owner_generation, attempt_generation),
  FOREIGN KEY (operation_id) REFERENCES relay_container_operations(operation_id),
  FOREIGN KEY (reservation_key) REFERENCES relay_billing_reservations(reservation_key),
  FOREIGN KEY (operation_id, owner_generation, attempt_generation)
    REFERENCES relay_container_provider_egress_grants(
      operation_id,
      owner_generation,
      attempt_generation
    ),
  CHECK (operation_id = reservation_key),
  CHECK (provider_response_sha256 = result_sha256),
  CHECK (
    result_object_key =
      'container-results/v1/' || operation_id || '/' || owner_generation || '/' || result_sha256
  ),
  CHECK (
    billing_kind = 'tiered_expr'
    OR (
      billing_kind = 'flat'
      AND billing_snapshot_sha256 = substr(billing_contract_hash, -64)
    )
  ),
  CHECK (
    usage_present = CASE
      WHEN (reported_usage_fields & 3) = 3 THEN 1
      ELSE 0
    END
  )
);

-- SQLite REPLACE can bypass DELETE triggers when recursive_triggers is disabled.
-- This append-only identity ledger survives that implicit delete and makes the
-- replacement statement abort from the receipt AFTER INSERT trigger below.
CREATE TABLE relay_container_provider_usage_receipt_identities (
  operation_id TEXT NOT NULL
    CHECK (
      typeof(operation_id) = 'text'
      AND length(operation_id) BETWEEN 1 AND 128
      AND operation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  owner_generation INTEGER NOT NULL
    CHECK (typeof(owner_generation) = 'integer' AND owner_generation > 0),
  attempt_generation INTEGER NOT NULL
    CHECK (typeof(attempt_generation) = 'integer' AND attempt_generation = 1),
  provider_operation_id TEXT NOT NULL
    CHECK (
      typeof(provider_operation_id) = 'text'
      AND length(provider_operation_id) BETWEEN 1 AND 128
      AND provider_operation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  result_object_key TEXT NOT NULL
    CHECK (typeof(result_object_key) = 'text' AND length(result_object_key) BETWEEN 8 AND 512),
  result_object_version TEXT NOT NULL
    CHECK (
      typeof(result_object_version) = 'text'
      AND length(result_object_version) BETWEEN 1 AND 128
      AND result_object_version NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  PRIMARY KEY (operation_id, owner_generation, attempt_generation),
  UNIQUE (provider_operation_id),
  UNIQUE (result_object_key, result_object_version),
  FOREIGN KEY (operation_id, owner_generation, attempt_generation)
    REFERENCES relay_container_provider_usage_receipts(
      operation_id,
      owner_generation,
      attempt_generation
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE UNIQUE INDEX idx_relay_container_provider_usage_receipts_provider_operation
  ON relay_container_provider_usage_receipts(provider_operation_id);

CREATE INDEX idx_relay_container_provider_usage_receipts_reconciliation
  ON relay_container_provider_usage_receipts(
    provider_completed_at,
    persisted_at,
    operation_id
  )
  WHERE usage_present = 0;

CREATE UNIQUE INDEX idx_relay_container_provider_usage_receipts_result_object_identity
  ON relay_container_provider_usage_receipts(result_object_key, result_object_version);

CREATE TRIGGER relay_container_provider_usage_receipt_insert_authority_guard
BEFORE INSERT ON relay_container_provider_usage_receipts
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM relay_container_provider_egress_grants AS grant_row
  JOIN relay_container_operations AS operation
    ON operation.operation_id = grant_row.operation_id
    AND operation.reservation_key = grant_row.reservation_key
    AND operation.owner_generation = grant_row.owner_generation
    AND operation.provider_operation_id = grant_row.provider_operation_id
    AND operation.admission_sha256 = grant_row.admission_sha256
    AND operation.input_sha256 = grant_row.request_sha256
    AND operation.channel_id = grant_row.channel_id
    AND operation.selected_group = grant_row.selected_group
  JOIN relay_billing_reservations AS reservation
    ON reservation.reservation_key = grant_row.reservation_key
    AND reservation.owner_generation = grant_row.owner_generation
    AND reservation.channel_id = grant_row.channel_id
    AND reservation.selected_group = grant_row.selected_group
    AND reservation.model_name = grant_row.model_name
    AND reservation.endpoint_path = grant_row.endpoint_path
    AND reservation.billing_kind = grant_row.billing_kind
    AND reservation.expr_hash = grant_row.billing_contract_hash
  WHERE grant_row.operation_id = NEW.operation_id
    AND grant_row.reservation_key = NEW.reservation_key
    AND grant_row.owner_generation = NEW.owner_generation
    AND grant_row.attempt_generation = NEW.attempt_generation
    AND grant_row.provider_operation_id = NEW.provider_operation_id
    AND grant_row.admission_sha256 = NEW.admission_sha256
    AND grant_row.request_sha256 = NEW.request_sha256
    AND grant_row.egress_profile = NEW.egress_profile
    AND grant_row.egress_worker_version_id = NEW.egress_worker_version_id
    AND grant_row.billing_kind = NEW.billing_kind
    AND grant_row.billing_contract_hash = NEW.billing_contract_hash
    AND grant_row.billing_snapshot_sha256 = NEW.billing_snapshot_sha256
    AND operation.protocol_version = 1
    AND operation.operation_kind = 'chat_completions_canary'
    AND operation.status = 'dispatched'
    AND reservation.status = 'reserved'
    AND NEW.provider_completed_at >= grant_row.authorized_at * 1000
    AND NEW.provider_completed_at < grant_row.execution_deadline_at * 1000
    AND NEW.persisted_at < grant_row.reservation_owner_deadline_at * 1000
    AND NEW.persisted_at < grant_row.owner_lease_expires_at * 1000
    AND NEW.persisted_at < grant_row.reservation_lease_expires_at * 1000
    AND CASE
      WHEN json_valid(NEW.usage_receipt_json) = 1
        AND json_type(NEW.usage_receipt_json) = 'object'
      THEN
        (SELECT COUNT(*) FROM json_each(NEW.usage_receipt_json)) = 38
        AND NOT EXISTS (
          SELECT 1
          FROM json_each(NEW.usage_receipt_json) AS receipt_field
          WHERE receipt_field.key NOT IN (
            'schema_version',
            'parser_contract',
            'normalization_contract',
            'source',
            'estimated',
            'operation_id',
            'owner_generation',
            'attempt_generation',
            'provider_operation_id',
            'request_sha256',
            'egress_profile',
            'egress_worker_version_id',
            'provider_response_status',
            'provider_response_sha256',
            'provider_request_id',
            'provider_completed_at',
            'usage_present',
            'reported_usage_fields',
            'prompt_tokens',
            'completion_tokens',
            'total_tokens',
            'cached_tokens',
            'cache_creation_tokens',
            'cache_creation_tokens_5m',
            'cache_creation_tokens_1h',
            'image_input_tokens',
            'image_output_tokens',
            'audio_input_tokens',
            'audio_output_tokens',
            'is_anthropic_usage_semantic',
            'usage_semantic_source',
            'provider_cost_usd',
            'cache_creation_source',
            'responses_web_search_calls',
            'responses_file_search_calls',
            'claude_web_search_calls',
            'image_generation_quality',
            'image_generation_size'
          )
        )
        AND json_type(NEW.usage_receipt_json, '$.schema_version') = 'integer'
        AND json_extract(NEW.usage_receipt_json, '$.schema_version') = NEW.usage_schema_version
        AND json_type(NEW.usage_receipt_json, '$.parser_contract') = 'text'
        AND json_extract(NEW.usage_receipt_json, '$.parser_contract') = NEW.usage_parser_contract
        AND json_type(NEW.usage_receipt_json, '$.normalization_contract') = 'text'
        AND json_extract(NEW.usage_receipt_json, '$.normalization_contract') = NEW.usage_normalization_contract
        AND json_type(NEW.usage_receipt_json, '$.source') = 'text'
        AND json_extract(NEW.usage_receipt_json, '$.source') = 'provider_response'
        AND json_type(NEW.usage_receipt_json, '$.estimated') = 'false'
        AND NEW.usage_estimated = 0
        AND json_type(NEW.usage_receipt_json, '$.operation_id') = 'text'
        AND json_extract(NEW.usage_receipt_json, '$.operation_id') = NEW.operation_id
        AND json_type(NEW.usage_receipt_json, '$.owner_generation') = 'integer'
        AND json_extract(NEW.usage_receipt_json, '$.owner_generation') = NEW.owner_generation
        AND json_type(NEW.usage_receipt_json, '$.attempt_generation') = 'integer'
        AND json_extract(NEW.usage_receipt_json, '$.attempt_generation') = NEW.attempt_generation
        AND json_type(NEW.usage_receipt_json, '$.provider_operation_id') = 'text'
        AND json_extract(NEW.usage_receipt_json, '$.provider_operation_id') = NEW.provider_operation_id
        AND json_type(NEW.usage_receipt_json, '$.request_sha256') = 'text'
        AND json_extract(NEW.usage_receipt_json, '$.request_sha256') = NEW.request_sha256
        AND json_type(NEW.usage_receipt_json, '$.egress_profile') = 'text'
        AND json_extract(NEW.usage_receipt_json, '$.egress_profile') = NEW.egress_profile
        AND json_type(NEW.usage_receipt_json, '$.egress_worker_version_id') = 'text'
        AND json_extract(NEW.usage_receipt_json, '$.egress_worker_version_id') = NEW.egress_worker_version_id
        AND json_type(NEW.usage_receipt_json, '$.provider_response_status') = 'integer'
        AND json_extract(NEW.usage_receipt_json, '$.provider_response_status') = NEW.provider_response_status
        AND json_type(NEW.usage_receipt_json, '$.provider_response_sha256') = 'text'
        AND json_extract(NEW.usage_receipt_json, '$.provider_response_sha256') = NEW.provider_response_sha256
        AND (
          (NEW.provider_request_id IS NULL
            AND json_type(NEW.usage_receipt_json, '$.provider_request_id') = 'null')
          OR
          (NEW.provider_request_id IS NOT NULL
            AND json_type(NEW.usage_receipt_json, '$.provider_request_id') = 'text'
            AND json_extract(NEW.usage_receipt_json, '$.provider_request_id') = NEW.provider_request_id)
        )
        AND json_type(NEW.usage_receipt_json, '$.provider_completed_at') = 'integer'
        AND json_extract(NEW.usage_receipt_json, '$.provider_completed_at') = NEW.provider_completed_at
        AND (
          (NEW.usage_present = 1
            AND json_type(NEW.usage_receipt_json, '$.usage_present') = 'true')
          OR
          (NEW.usage_present = 0
            AND json_type(NEW.usage_receipt_json, '$.usage_present') = 'false')
        )
        AND json_type(NEW.usage_receipt_json, '$.reported_usage_fields') = 'integer'
        AND json_extract(NEW.usage_receipt_json, '$.reported_usage_fields') = NEW.reported_usage_fields
        AND json_type(NEW.usage_receipt_json, '$.prompt_tokens') = 'integer'
        AND json_extract(NEW.usage_receipt_json, '$.prompt_tokens') BETWEEN 0 AND 2147483647
        AND json_type(NEW.usage_receipt_json, '$.completion_tokens') = 'integer'
        AND json_extract(NEW.usage_receipt_json, '$.completion_tokens') BETWEEN 0 AND 2147483647
        AND json_type(NEW.usage_receipt_json, '$.total_tokens') = 'integer'
        AND json_extract(NEW.usage_receipt_json, '$.total_tokens') BETWEEN 0 AND 2147483647
        AND json_type(NEW.usage_receipt_json, '$.cached_tokens') = 'integer'
        AND json_extract(NEW.usage_receipt_json, '$.cached_tokens') BETWEEN 0 AND 2147483647
        AND json_type(NEW.usage_receipt_json, '$.cache_creation_tokens') = 'integer'
        AND json_extract(NEW.usage_receipt_json, '$.cache_creation_tokens') BETWEEN 0 AND 2147483647
        AND json_type(NEW.usage_receipt_json, '$.cache_creation_tokens_5m') = 'integer'
        AND json_extract(NEW.usage_receipt_json, '$.cache_creation_tokens_5m') BETWEEN 0 AND 2147483647
        AND json_type(NEW.usage_receipt_json, '$.cache_creation_tokens_1h') = 'integer'
        AND json_extract(NEW.usage_receipt_json, '$.cache_creation_tokens_1h') BETWEEN 0 AND 2147483647
        AND json_type(NEW.usage_receipt_json, '$.image_input_tokens') = 'integer'
        AND json_extract(NEW.usage_receipt_json, '$.image_input_tokens') BETWEEN 0 AND 2147483647
        AND json_type(NEW.usage_receipt_json, '$.image_output_tokens') = 'integer'
        AND json_extract(NEW.usage_receipt_json, '$.image_output_tokens') BETWEEN 0 AND 2147483647
        AND json_type(NEW.usage_receipt_json, '$.audio_input_tokens') = 'integer'
        AND json_extract(NEW.usage_receipt_json, '$.audio_input_tokens') BETWEEN 0 AND 2147483647
        AND json_type(NEW.usage_receipt_json, '$.audio_output_tokens') = 'integer'
        AND json_extract(NEW.usage_receipt_json, '$.audio_output_tokens') BETWEEN 0 AND 2147483647
        AND json_type(NEW.usage_receipt_json, '$.is_anthropic_usage_semantic') = 'false'
        AND json_type(NEW.usage_receipt_json, '$.usage_semantic_source') = 'text'
        AND json_extract(NEW.usage_receipt_json, '$.usage_semantic_source') IN (
          'openai_default',
          'upstream_explicit',
          'native_anthropic'
        )
        AND (
          json_type(NEW.usage_receipt_json, '$.provider_cost_usd') = 'null'
          OR (
            json_type(NEW.usage_receipt_json, '$.provider_cost_usd') = 'text'
            AND length(json_extract(NEW.usage_receipt_json, '$.provider_cost_usd')) BETWEEN 1 AND 64
            AND json_extract(NEW.usage_receipt_json, '$.provider_cost_usd') NOT GLOB '*[^0-9.]*'
            AND json_extract(NEW.usage_receipt_json, '$.provider_cost_usd') GLOB '*[0-9]*'
            AND length(json_extract(NEW.usage_receipt_json, '$.provider_cost_usd')) -
              length(replace(json_extract(NEW.usage_receipt_json, '$.provider_cost_usd'), '.', '')) <= 1
            AND substr(json_extract(NEW.usage_receipt_json, '$.provider_cost_usd'), 1, 1) <> '.'
            AND substr(json_extract(NEW.usage_receipt_json, '$.provider_cost_usd'), -1) <> '.'
            AND (
              instr(json_extract(NEW.usage_receipt_json, '$.provider_cost_usd'), '.') = 0
              OR substr(json_extract(NEW.usage_receipt_json, '$.provider_cost_usd'), -1)
                BETWEEN '1' AND '9'
            )
            AND (
              json_extract(NEW.usage_receipt_json, '$.provider_cost_usd') = '0'
              OR json_extract(NEW.usage_receipt_json, '$.provider_cost_usd') GLOB '0.[0-9]*'
              OR substr(json_extract(NEW.usage_receipt_json, '$.provider_cost_usd'), 1, 1)
                BETWEEN '1' AND '9'
            )
            AND CAST(json_extract(NEW.usage_receipt_json, '$.provider_cost_usd') AS REAL)
              BETWEEN 0 AND 1000000000000
          )
        )
        AND json_type(NEW.usage_receipt_json, '$.cache_creation_source') = 'text'
        AND json_extract(NEW.usage_receipt_json, '$.cache_creation_source') IN (
          'none',
          'upstream_aggregate',
          'upstream_split'
        )
        AND json_type(NEW.usage_receipt_json, '$.responses_web_search_calls') = 'integer'
        AND json_extract(NEW.usage_receipt_json, '$.responses_web_search_calls')
          BETWEEN 0 AND 256
        AND json_type(NEW.usage_receipt_json, '$.responses_file_search_calls') = 'integer'
        AND json_extract(NEW.usage_receipt_json, '$.responses_file_search_calls')
          BETWEEN 0 AND 256
        AND json_type(NEW.usage_receipt_json, '$.claude_web_search_calls') = 'integer'
        AND json_extract(NEW.usage_receipt_json, '$.claude_web_search_calls')
          BETWEEN 0 AND 256
        AND (
          (
            json_type(NEW.usage_receipt_json, '$.image_generation_quality') = 'null'
            AND json_type(NEW.usage_receipt_json, '$.image_generation_size') = 'null'
          )
          OR (
            json_type(NEW.usage_receipt_json, '$.image_generation_quality') = 'text'
            AND json_extract(NEW.usage_receipt_json, '$.image_generation_quality') IN (
              'low',
              'medium',
              'high'
            )
            AND json_type(NEW.usage_receipt_json, '$.image_generation_size') = 'text'
            AND json_extract(NEW.usage_receipt_json, '$.image_generation_size') IN (
              '1024x1024',
              '1024x1536',
              '1536x1024'
            )
          )
        )
        AND ((NEW.reported_usage_fields & 1) <> 0
          OR json_extract(NEW.usage_receipt_json, '$.prompt_tokens') = 0)
        AND ((NEW.reported_usage_fields & 2) <> 0
          OR json_extract(NEW.usage_receipt_json, '$.completion_tokens') = 0)
        AND ((NEW.reported_usage_fields & 4) <> 0
          OR json_extract(NEW.usage_receipt_json, '$.total_tokens') = 0)
        AND ((NEW.reported_usage_fields & 8) <> 0
          OR json_extract(NEW.usage_receipt_json, '$.cached_tokens') = 0)
        AND ((NEW.reported_usage_fields & 16) <> 0
          OR json_extract(NEW.usage_receipt_json, '$.cache_creation_tokens') = 0)
        AND ((NEW.reported_usage_fields & 32) <> 0
          OR json_extract(NEW.usage_receipt_json, '$.cache_creation_tokens_5m') = 0)
        AND ((NEW.reported_usage_fields & 64) <> 0
          OR json_extract(NEW.usage_receipt_json, '$.cache_creation_tokens_1h') = 0)
        AND ((NEW.reported_usage_fields & 128) <> 0
          OR json_extract(NEW.usage_receipt_json, '$.image_input_tokens') = 0)
        AND ((NEW.reported_usage_fields & 256) <> 0
          OR json_extract(NEW.usage_receipt_json, '$.image_output_tokens') = 0)
        AND ((NEW.reported_usage_fields & 512) <> 0
          OR json_extract(NEW.usage_receipt_json, '$.audio_input_tokens') = 0)
        AND ((NEW.reported_usage_fields & 1024) <> 0
          OR json_extract(NEW.usage_receipt_json, '$.audio_output_tokens') = 0)
      ELSE 0
    END
)
BEGIN
  SELECT RAISE(ABORT, 'relay container provider usage receipt authority mismatch');
END;

CREATE TRIGGER relay_container_provider_usage_receipt_identity_guard
AFTER INSERT ON relay_container_provider_usage_receipts
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container provider usage receipt identity is immutable')
  WHERE EXISTS (
    SELECT 1
    FROM relay_container_provider_usage_receipt_identities AS identity
    WHERE (
        identity.operation_id = NEW.operation_id
        AND identity.owner_generation = NEW.owner_generation
        AND identity.attempt_generation = NEW.attempt_generation
      )
      OR identity.provider_operation_id = NEW.provider_operation_id
      OR (
        identity.result_object_key = NEW.result_object_key
        AND identity.result_object_version = NEW.result_object_version
      )
  );

  INSERT INTO relay_container_provider_usage_receipt_identities (
    operation_id,
    owner_generation,
    attempt_generation,
    provider_operation_id,
    result_object_key,
    result_object_version
  ) VALUES (
    NEW.operation_id,
    NEW.owner_generation,
    NEW.attempt_generation,
    NEW.provider_operation_id,
    NEW.result_object_key,
    NEW.result_object_version
  );
END;

CREATE TRIGGER relay_container_provider_usage_receipt_identity_update_guard
BEFORE UPDATE ON relay_container_provider_usage_receipt_identities
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container provider usage receipt identity is immutable');
END;

CREATE TRIGGER relay_container_provider_usage_receipt_identity_delete_guard
BEFORE DELETE ON relay_container_provider_usage_receipt_identities
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container provider usage receipt identity cannot be deleted');
END;

CREATE TRIGGER relay_container_provider_usage_receipt_update_guard
BEFORE UPDATE ON relay_container_provider_usage_receipts
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container provider usage receipt is immutable');
END;

CREATE TRIGGER relay_container_provider_usage_receipt_delete_guard
BEFORE DELETE ON relay_container_provider_usage_receipts
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container provider usage receipt cannot be deleted');
END;

ALTER TABLE relay_container_terminal_events
  ADD COLUMN provider_usage_receipt_sha256 TEXT
    CHECK (
      provider_usage_receipt_sha256 IS NULL
      OR (
        typeof(provider_usage_receipt_sha256) = 'text'
        AND length(provider_usage_receipt_sha256) = 64
        AND provider_usage_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    );

ALTER TABLE relay_container_terminal_events
  ADD COLUMN provider_result_sha256 TEXT
    CHECK (
      provider_result_sha256 IS NULL
      OR (
        typeof(provider_result_sha256) = 'text'
        AND length(provider_result_sha256) = 64
        AND provider_result_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    );

ALTER TABLE relay_container_terminal_events
  ADD COLUMN provider_attempt_generation INTEGER
    CHECK (
      provider_attempt_generation IS NULL
      OR (
        typeof(provider_attempt_generation) = 'integer'
        AND provider_attempt_generation = 1
      )
    );

CREATE TRIGGER relay_container_terminal_event_provider_usage_guard
BEFORE INSERT ON relay_container_terminal_events
FOR EACH ROW
WHEN
  (
    NEW.billing_action = 'settle'
    AND NOT (
      (
        NEW.provider_usage_receipt_sha256 IS NULL
        AND NEW.provider_result_sha256 IS NULL
        AND NEW.provider_attempt_generation IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM relay_container_provider_egress_grants AS grant_row
          WHERE grant_row.operation_id = NEW.operation_id
            AND grant_row.reservation_key = NEW.reservation_key
            AND grant_row.owner_generation = NEW.owner_generation
            AND grant_row.attempt_generation = 1
        )
      )
      OR
      (
        NEW.provider_usage_receipt_sha256 IS NOT NULL
        AND NEW.provider_result_sha256 IS NOT NULL
        AND NEW.provider_attempt_generation IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM relay_container_provider_usage_receipts AS receipt
          WHERE receipt.operation_id = NEW.operation_id
            AND receipt.reservation_key = NEW.reservation_key
            AND receipt.owner_generation = NEW.owner_generation
            AND receipt.attempt_generation = NEW.provider_attempt_generation
            AND receipt.usage_receipt_sha256 = NEW.provider_usage_receipt_sha256
            AND receipt.result_sha256 = NEW.provider_result_sha256
            AND receipt.usage_present = 1
            AND receipt.usage_estimated = 0
            AND receipt.provider_response_status <> 202
            AND NEW.client_response_status = receipt.provider_response_status
            AND receipt.persisted_at < (NEW.created_at + 1) * 1000
        )
      )
    )
  )
  OR
  (
    NEW.billing_action IN ('refund', 'recovery_required')
    AND (
      NEW.provider_usage_receipt_sha256 IS NOT NULL
      OR NEW.provider_result_sha256 IS NOT NULL
      OR NEW.provider_attempt_generation IS NOT NULL
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'relay container terminal event provider usage receipt mismatch');
END;

CREATE TRIGGER relay_container_operation_provider_usage_terminal_guard
BEFORE UPDATE OF status ON relay_container_operations
FOR EACH ROW
WHEN
  OLD.protocol_version = 1
  AND NEW.status IS NOT OLD.status
  AND NEW.status = 'completed'
  AND EXISTS (
    SELECT 1
    FROM relay_container_provider_egress_grants AS grant_row
    WHERE grant_row.operation_id = OLD.operation_id
      AND grant_row.reservation_key = OLD.reservation_key
      AND grant_row.owner_generation = OLD.owner_generation
      AND grant_row.attempt_generation = 1
  )
  AND NOT EXISTS (
    SELECT 1
    FROM relay_container_terminal_events AS event
    JOIN relay_container_provider_usage_receipts AS receipt
      ON receipt.operation_id = event.operation_id
      AND receipt.reservation_key = event.reservation_key
      AND receipt.owner_generation = event.owner_generation
      AND receipt.attempt_generation = event.provider_attempt_generation
      AND receipt.usage_receipt_sha256 = event.provider_usage_receipt_sha256
      AND receipt.result_sha256 = event.provider_result_sha256
    WHERE event.operation_id = OLD.operation_id
      AND event.reservation_key = OLD.reservation_key
      AND event.owner_generation = OLD.owner_generation
      AND event.operation_from_status = OLD.status
      AND event.operation_status = 'completed'
      AND event.billing_action = 'settle'
      AND receipt.usage_present = 1
      AND receipt.usage_estimated = 0
      AND receipt.provider_response_status <> 202
      AND NEW.response_status = receipt.provider_response_status
      AND NEW.response_code IS NULL
      AND NEW.result_object_key = receipt.result_object_key
      AND NEW.result_object_version = receipt.result_object_version
      AND NEW.result_sha256 = receipt.result_sha256
      AND NEW.result_size = receipt.result_size
      AND NEW.result_content_type = receipt.result_content_type
      AND receipt.persisted_at < (event.created_at + 1) * 1000
      AND event.created_at <= NEW.updated_at
  )
BEGIN
  SELECT RAISE(ABORT, 'relay container completed operation provider usage receipt mismatch');
END;
