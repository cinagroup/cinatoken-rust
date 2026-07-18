-- Bind P3 provider-response evidence to one global financial decision without
-- rewriting historical financial-terminal v1 rows or their outbox hashes.

CREATE TABLE migration_0053_relay_container_terminal_v2_drain_guard (
  active_count INTEGER NOT NULL CHECK (active_count = 0)
);

INSERT INTO migration_0053_relay_container_terminal_v2_drain_guard (active_count)
SELECT COUNT(*)
FROM relay_container_terminal_events
WHERE owner_generation = 2;

DROP TABLE migration_0053_relay_container_terminal_v2_drain_guard;

ALTER TABLE relay_container_terminal_events
  ADD COLUMN financial_terminal_contract_version INTEGER NOT NULL DEFAULT 1
    CHECK (
      typeof(financial_terminal_contract_version) = 'integer'
      AND financial_terminal_contract_version IN (1, 2)
    );

ALTER TABLE relay_container_terminal_events
  ADD COLUMN client_replay_status INTEGER
    CHECK (
      client_replay_status IS NULL
      OR (
        typeof(client_replay_status) = 'integer'
        AND client_replay_status BETWEEN 100 AND 599
      )
    );

ALTER TABLE relay_container_terminal_events
  ADD COLUMN provider_response_attempt_generation INTEGER
    CHECK (
      provider_response_attempt_generation IS NULL
      OR (
        typeof(provider_response_attempt_generation) = 'integer'
        AND provider_response_attempt_generation = 1
      )
    );

ALTER TABLE relay_container_terminal_events
  ADD COLUMN provider_response_status INTEGER
    CHECK (
      provider_response_status IS NULL
      OR (
        typeof(provider_response_status) = 'integer'
        AND provider_response_status BETWEEN 100 AND 599
      )
    );

ALTER TABLE relay_container_terminal_events
  ADD COLUMN provider_response_class TEXT
    CHECK (
      provider_response_class IS NULL
      OR provider_response_class IN (
        'success', 'typed_error', 'http_error', 'invalid_body'
      )
    );

ALTER TABLE relay_container_terminal_events
  ADD COLUMN provider_response_code TEXT
    CHECK (
      provider_response_code IS NULL
      OR (
        typeof(provider_response_code) = 'text'
        AND length(provider_response_code) BETWEEN 1 AND 64
        AND provider_response_code NOT GLOB '*[^a-z0-9_:-]*'
      )
    );

ALTER TABLE relay_container_terminal_events
  ADD COLUMN provider_response_evidence_sha256 TEXT
    CHECK (
      provider_response_evidence_sha256 IS NULL
      OR (
        typeof(provider_response_evidence_sha256) = 'text'
        AND length(provider_response_evidence_sha256) = 64
        AND provider_response_evidence_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    )
    REFERENCES relay_container_provider_response_evidence(
      provider_response_evidence_sha256
    ) ON UPDATE RESTRICT ON DELETE RESTRICT;

CREATE UNIQUE INDEX idx_relay_container_terminal_events_provider_response
  ON relay_container_terminal_events(provider_response_evidence_sha256)
  WHERE provider_response_evidence_sha256 IS NOT NULL;

DROP TRIGGER relay_container_terminal_event_insert_guard;

CREATE TRIGGER relay_container_terminal_event_insert_guard
BEFORE INSERT ON relay_container_terminal_events
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM relay_container_operations AS operation
  JOIN relay_billing_reservations AS reservation
    ON reservation.reservation_key = operation.reservation_key
  JOIN users AS billing_user
    ON billing_user.id = reservation.user_id
  LEFT JOIN tokens AS billing_token
    ON billing_token.id = reservation.token_id
  JOIN channels AS billing_channel
    ON billing_channel.id = reservation.channel_id
  WHERE operation.reservation_key = NEW.reservation_key
    AND operation.operation_id = NEW.operation_id
    AND operation.owner_generation = NEW.owner_generation
    AND operation.status = NEW.operation_from_status
    AND operation.reconciliation_id = NEW.reconciliation_id
    AND operation.channel_id = reservation.channel_id
    AND operation.selected_group = reservation.selected_group
    AND reservation.owner_generation = NEW.billing_owner_generation
    AND reservation.status = NEW.billing_from_status
    AND (reservation.token_id = 0 OR billing_token.user_id = reservation.user_id)
    AND (
      (
        NEW.billing_action = 'settle'
        AND NEW.pre_consumed_quota = reservation.pre_consumed_quota
        AND NEW.user_quota_delta =
          reservation.pre_consumed_quota - NEW.billing_final_quota
        AND NEW.token_quota_delta = CASE
          WHEN reservation.token_id = 0 THEN 0
          ELSE reservation.pre_consumed_quota - NEW.billing_final_quota
        END
        AND NEW.user_used_quota_delta = NEW.billing_final_quota
        AND NEW.channel_used_quota_delta = NEW.billing_final_quota
        AND NEW.request_count_delta = 1
      )
      OR (
        NEW.billing_action = 'refund'
        AND NEW.pre_consumed_quota = reservation.pre_consumed_quota
        AND NEW.user_quota_delta = reservation.pre_consumed_quota
        AND NEW.token_quota_delta = CASE
          WHEN reservation.token_id = 0 THEN 0
          ELSE reservation.pre_consumed_quota
        END
        AND NEW.user_used_quota_delta = 0
        AND NEW.channel_used_quota_delta = 0
        AND NEW.request_count_delta = NEW.billing_request_accounted
      )
      OR (
        NEW.billing_action = 'recovery_required'
        AND NEW.pre_consumed_quota = reservation.pre_consumed_quota
        AND NEW.user_quota_delta = 0
        AND NEW.token_quota_delta = 0
        AND NEW.user_used_quota_delta = 0
        AND NEW.channel_used_quota_delta = 0
        AND NEW.request_count_delta = 0
      )
    )
    AND (
      NEW.client_response_headers_json IS NULL
      OR CASE
        WHEN json_valid(NEW.client_response_headers_json) = 1 THEN (
          json_extract(
            NEW.client_response_headers_json,
            '$."content-type"'
          ) = NEW.client_response_content_type
          AND NOT EXISTS (
            SELECT 1
            FROM json_each(NEW.client_response_headers_json) AS header
            WHERE header.key NOT IN (
              'anthropic-request-id',
              'cache-control',
              'content-language',
              'content-type',
              'openai-request-id',
              'request-id',
              'retry-after',
              'x-request-id'
            )
            OR header.type <> 'text'
            OR length(CAST(header.value AS TEXT)) NOT BETWEEN 1 AND 1024
          )
        )
        ELSE 1
      END
    )
)
BEGIN
  SELECT RAISE(ABORT, 'relay container terminal event authority mismatch');
END;

CREATE TRIGGER relay_container_financial_terminal_v2_guard
BEFORE INSERT ON relay_container_terminal_events
FOR EACH ROW
WHEN
  (
    NEW.owner_generation = 2
    AND (
      NEW.financial_terminal_contract_version <> 2
      OR (
        NEW.billing_action IN ('settle', 'refund')
        AND (
          NEW.provider_response_attempt_generation <> 1
          OR NEW.provider_response_evidence_sha256 IS NULL
          OR NEW.client_response_artifact_sha256 IS NULL
          OR NEW.client_replay_status IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM relay_container_client_response_artifacts AS artifact
            JOIN relay_container_provider_response_evidence AS evidence
              ON evidence.operation_id = artifact.operation_id
             AND evidence.owner_generation = artifact.owner_generation
             AND evidence.attempt_generation = artifact.attempt_generation
             AND evidence.provider_response_evidence_sha256 =
                   artifact.provider_response_evidence_sha256
            WHERE artifact.operation_id = NEW.operation_id
              AND artifact.owner_generation = NEW.owner_generation
              AND artifact.attempt_generation =
                    NEW.provider_response_attempt_generation
              AND artifact.client_response_artifact_sha256 =
                    NEW.client_response_artifact_sha256
              AND artifact.provider_response_evidence_sha256 =
                    NEW.provider_response_evidence_sha256
              AND artifact.response_class = NEW.provider_response_class
              AND evidence.raw_response_status = NEW.provider_response_status
              AND artifact.client_response_status = NEW.client_replay_status
              AND (
                (
                  NEW.billing_action = 'settle'
                  AND NEW.operation_status = 'completed'
                  AND NEW.client_response_status = 200
                  AND NEW.client_replay_status = 200
                  AND NEW.provider_response_status = 200
                  AND NEW.provider_response_class = 'success'
                  AND NEW.provider_response_code IS NULL
                  AND artifact.provider_usage_receipt_sha256 =
                        NEW.provider_usage_receipt_sha256
                )
                OR (
                  NEW.billing_action = 'refund'
                  AND NEW.operation_status = 'failed'
                  AND NEW.client_response_status = 422
                  AND NEW.billing_request_accounted = 0
                  AND NEW.request_count_delta = 0
                  AND NEW.provider_usage_receipt_sha256 IS NULL
                  AND NEW.provider_result_sha256 IS NULL
                  AND NEW.provider_attempt_generation IS NULL
                  AND artifact.provider_usage_receipt_sha256 IS NULL
                  AND (
                    (
                      NEW.provider_response_class = 'typed_error'
                      AND NEW.provider_response_status = 200
                      AND NEW.client_replay_status = 200
                      AND NEW.provider_response_code = 'provider_typed_error'
                    )
                    OR (
                      NEW.provider_response_class = 'http_error'
                      AND NEW.provider_response_status <> 200
                      AND NEW.client_replay_status = NEW.provider_response_status
                      AND NEW.provider_response_code = 'provider_http_error'
                    )
                    OR (
                      NEW.provider_response_class = 'invalid_body'
                      AND NEW.provider_response_status = 200
                      AND NEW.client_replay_status = 500
                      AND NEW.provider_response_code = 'provider_invalid_body'
                    )
                  )
                )
              )
          )
        )
      )
      OR (
        NEW.billing_action = 'recovery_required'
        AND (
          NEW.client_replay_status IS NOT NULL
          OR NEW.provider_response_attempt_generation IS NOT NULL
          OR NEW.provider_response_status IS NOT NULL
          OR NEW.provider_response_class IS NOT NULL
          OR NEW.provider_response_code IS NOT NULL
          OR NEW.provider_response_evidence_sha256 IS NOT NULL
          OR NEW.client_response_artifact_sha256 IS NOT NULL
        )
      )
    )
  )
  OR (
    NEW.owner_generation <> 2
    AND (
      NEW.financial_terminal_contract_version <> 1
      OR NEW.client_replay_status IS NOT NULL
      OR NEW.provider_response_attempt_generation IS NOT NULL
      OR NEW.provider_response_status IS NOT NULL
      OR NEW.provider_response_class IS NOT NULL
      OR NEW.provider_response_code IS NOT NULL
      OR NEW.provider_response_evidence_sha256 IS NOT NULL
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'relay container financial terminal v2 binding mismatch');
END;

DROP TRIGGER relay_container_terminal_event_response_artifact_guard;

CREATE TRIGGER relay_container_terminal_event_response_artifact_guard
BEFORE INSERT ON relay_container_terminal_events
FOR EACH ROW
WHEN
  (
    NEW.billing_action IN ('settle', 'refund')
    AND (
      NEW.client_response_artifact_sha256 IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM relay_container_client_response_artifacts AS artifact
        WHERE artifact.operation_id = NEW.operation_id
          AND artifact.owner_generation = NEW.owner_generation
          AND artifact.attempt_generation = CASE
            WHEN NEW.financial_terminal_contract_version = 2
              THEN NEW.provider_response_attempt_generation
            WHEN NEW.billing_action = 'settle'
              THEN NEW.provider_attempt_generation
            ELSE 1
          END
          AND artifact.client_response_artifact_sha256 =
                NEW.client_response_artifact_sha256
          AND artifact.client_response_status = CASE
            WHEN NEW.financial_terminal_contract_version = 2
              THEN NEW.client_replay_status
            ELSE NEW.client_response_status
          END
          AND artifact.client_response_headers_json = NEW.client_response_headers_json
          AND artifact.client_response_headers_sha256 =
                NEW.client_response_headers_sha256
          AND artifact.client_response_sha256 = NEW.client_response_sha256
          AND artifact.client_response_size = NEW.client_response_size
          AND artifact.client_response_content_type = NEW.client_response_content_type
          AND artifact.created_at < (NEW.created_at + 1) * 1000
          AND (
            (NEW.billing_action = 'settle'
              AND artifact.response_class = 'success'
              AND artifact.provider_usage_receipt_sha256 =
                    NEW.provider_usage_receipt_sha256)
            OR (NEW.billing_action = 'refund'
              AND artifact.response_class IN ('typed_error', 'http_error', 'invalid_body')
              AND artifact.provider_usage_receipt_sha256 IS NULL)
          )
      )
    )
  )
  OR (
    NEW.billing_action = 'recovery_required'
    AND (
      NEW.client_response_artifact_sha256 IS NOT NULL
      OR EXISTS (
        SELECT 1
        FROM relay_container_provider_response_evidence AS evidence
        WHERE evidence.operation_id = NEW.operation_id
          AND evidence.owner_generation = NEW.owner_generation
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'relay container terminal event response artifact mismatch');
END;

DROP TRIGGER relay_container_operation_response_artifact_terminal_guard;

CREATE TRIGGER relay_container_operation_response_artifact_terminal_guard
BEFORE UPDATE OF status ON relay_container_operations
FOR EACH ROW
WHEN
  OLD.protocol_version = 1
  AND NEW.status IS NOT OLD.status
  AND NEW.status IN ('completed', 'failed')
  AND EXISTS (
    SELECT 1
    FROM relay_container_provider_egress_grants AS grant_row
    WHERE grant_row.operation_id = OLD.operation_id
      AND grant_row.owner_generation = OLD.owner_generation
  )
  AND NOT EXISTS (
    SELECT 1
    FROM relay_container_terminal_events AS event
    JOIN relay_container_client_response_artifacts AS artifact
      ON artifact.client_response_artifact_sha256 =
           event.client_response_artifact_sha256
     AND artifact.operation_id = event.operation_id
     AND artifact.owner_generation = event.owner_generation
    WHERE event.operation_id = OLD.operation_id
      AND event.reservation_key = OLD.reservation_key
      AND event.owner_generation = OLD.owner_generation
      AND event.operation_from_status = OLD.status
      AND artifact.client_response_sha256 = event.client_response_sha256
      AND artifact.client_response_size = event.client_response_size
      AND artifact.client_response_content_type = event.client_response_content_type
      AND artifact.created_at < (event.created_at + 1) * 1000
      AND (
        (
          NEW.status = 'completed'
          AND event.operation_status = 'completed'
          AND event.billing_action = 'settle'
          AND artifact.attempt_generation = event.provider_attempt_generation
          AND artifact.response_class = 'success'
          AND artifact.client_response_status = NEW.response_status
          AND artifact.provider_usage_receipt_sha256 =
                event.provider_usage_receipt_sha256
        )
        OR (
          NEW.status = 'failed'
          AND NEW.response_status = 422
          AND event.financial_terminal_contract_version = 2
          AND event.operation_status = 'failed'
          AND event.billing_action = 'refund'
          AND event.client_response_status = 422
          AND event.provider_response_code = NEW.response_code
          AND artifact.attempt_generation = event.provider_response_attempt_generation
          AND artifact.response_class = event.provider_response_class
          AND artifact.client_response_status = event.client_replay_status
          AND artifact.provider_usage_receipt_sha256 IS NULL
        )
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'relay container terminal operation lacks response evidence');
END;

DROP TRIGGER relay_container_reconciliation_response_artifact_convergence_guard;

CREATE TRIGGER relay_container_reconciliation_response_artifact_convergence_guard
BEFORE UPDATE ON relay_container_reconciliation_observations
FOR EACH ROW
WHEN
  OLD.status <> 'converged'
  AND NEW.status = 'converged'
  AND EXISTS (
    SELECT 1
    FROM relay_container_provider_egress_grants AS grant_row
    WHERE grant_row.operation_id = NEW.operation_id
      AND grant_row.owner_generation = NEW.owner_generation
  )
  AND NOT EXISTS (
    SELECT 1
    FROM relay_container_terminal_events AS event
    JOIN relay_container_client_response_artifacts AS artifact
      ON artifact.client_response_artifact_sha256 =
           event.client_response_artifact_sha256
     AND artifact.operation_id = event.operation_id
     AND artifact.owner_generation = event.owner_generation
    WHERE event.operation_id = NEW.operation_id
      AND event.reservation_key = NEW.reservation_key
      AND event.owner_generation = NEW.owner_generation
      AND event.reconciliation_id = NEW.reconciliation_id
      AND (
        (
          event.operation_status = 'completed'
          AND event.billing_action = 'settle'
          AND artifact.attempt_generation = event.provider_attempt_generation
          AND artifact.response_class = 'success'
          AND artifact.provider_usage_receipt_sha256 =
                event.provider_usage_receipt_sha256
        )
        OR (
          event.financial_terminal_contract_version = 2
          AND event.operation_status = 'failed'
          AND event.billing_action = 'refund'
          AND artifact.attempt_generation = event.provider_response_attempt_generation
          AND artifact.response_class = event.provider_response_class
          AND artifact.client_response_status = event.client_replay_status
          AND artifact.provider_usage_receipt_sha256 IS NULL
        )
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'relay container reconciliation lacks response evidence');
END;
