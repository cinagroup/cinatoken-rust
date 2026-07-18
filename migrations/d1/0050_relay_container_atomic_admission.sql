-- Establish the immutable commit receipt for one all-or-nothing Container chat
-- admission. The receipt is inserted first with deferred foreign keys in the
-- same D1 batch as the selected billing reservation, authority checks, quota
-- debits, and prepared operation. It is the only
-- state that the edge may interpret as an admitted Container request.
--
-- Apply only after every pre-0050 Worker has the chat canary hard-disabled and
-- the old-writer drain query below is empty. Historical non-canary operations
-- remain readable and are not rewritten or backfilled.

CREATE TABLE migration_0050_relay_container_canary_drain_guard (
  active_count INTEGER NOT NULL CHECK (active_count = 0)
);

INSERT INTO migration_0050_relay_container_canary_drain_guard (active_count)
SELECT COUNT(*)
FROM relay_container_operations
WHERE protocol_version = 1
  AND operation_kind = 'chat_completions_canary';

DROP TABLE migration_0050_relay_container_canary_drain_guard;

CREATE TABLE relay_container_atomic_admissions (
  reservation_key TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(reservation_key) = 'text'
      AND length(reservation_key) BETWEEN 1 AND 128
      AND reservation_key NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  operation_id TEXT NOT NULL UNIQUE
    CHECK (
      typeof(operation_id) = 'text'
      AND length(operation_id) BETWEEN 1 AND 128
      AND operation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  contract_version INTEGER NOT NULL
    CHECK (typeof(contract_version) = 'integer' AND contract_version = 1),
  atomic_admission_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(atomic_admission_sha256) = 'text'
      AND length(atomic_admission_sha256) = 64
      AND atomic_admission_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  operation_admission_sha256 TEXT NOT NULL
    CHECK (
      typeof(operation_admission_sha256) = 'text'
      AND length(operation_admission_sha256) = 64
      AND operation_admission_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  client_idempotency_hmac_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(client_idempotency_hmac_sha256) = 'text'
      AND length(client_idempotency_hmac_sha256) = 64
      AND client_idempotency_hmac_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  client_request_sha256 TEXT NOT NULL
    CHECK (
      typeof(client_request_sha256) = 'text'
      AND length(client_request_sha256) = 64
      AND client_request_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  idempotency_alias_count INTEGER NOT NULL
    CHECK (
      typeof(idempotency_alias_count) = 'integer'
      AND idempotency_alias_count BETWEEN 1 AND 2
    ),
  idempotency_aliases_sha256 TEXT NOT NULL
    CHECK (
      typeof(idempotency_aliases_sha256) = 'text'
      AND length(idempotency_aliases_sha256) = 64
      AND idempotency_aliases_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  billing_snapshot_sha256 TEXT NOT NULL
    CHECK (
      typeof(billing_snapshot_sha256) = 'text'
      AND length(billing_snapshot_sha256) = 64
      AND billing_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  user_id INTEGER NOT NULL
    CHECK (typeof(user_id) = 'integer' AND user_id > 0),
  token_id INTEGER NOT NULL
    CHECK (typeof(token_id) = 'integer' AND token_id > 0),
  pre_consumed_quota INTEGER NOT NULL
    CHECK (typeof(pre_consumed_quota) = 'integer' AND pre_consumed_quota > 0),
  owner_generation INTEGER NOT NULL
    CHECK (typeof(owner_generation) = 'integer' AND owner_generation = 2),
  owner_lease_expires_at INTEGER NOT NULL
    CHECK (typeof(owner_lease_expires_at) = 'integer' AND owner_lease_expires_at > 0),
  channel_id INTEGER NOT NULL
    CHECK (typeof(channel_id) = 'integer' AND channel_id > 0),
  selected_channel_type INTEGER NOT NULL
    CHECK (typeof(selected_channel_type) = 'integer' AND selected_channel_type > 0),
  selected_group TEXT NOT NULL
    CHECK (typeof(selected_group) = 'text' AND length(selected_group) BETWEEN 1 AND 64),
  selected_snapshot_key TEXT NOT NULL
    CHECK (
      typeof(selected_snapshot_key) = 'text'
      AND length(selected_snapshot_key) BETWEEN 1 AND 64
    ),
  owner_deadline_at INTEGER NOT NULL
    CHECK (typeof(owner_deadline_at) = 'integer' AND owner_deadline_at > 0),
  selected_at INTEGER NOT NULL
    CHECK (typeof(selected_at) = 'integer' AND selected_at > 0),
  created_at INTEGER NOT NULL
    CHECK (typeof(created_at) = 'integer' AND created_at > 0),
  attempt_count INTEGER NOT NULL
    CHECK (typeof(attempt_count) = 'integer' AND attempt_count = 1),
  provider_attempt_generation INTEGER NOT NULL
    CHECK (
      typeof(provider_attempt_generation) = 'integer'
      AND provider_attempt_generation = 1
    ),
  CHECK (operation_id = reservation_key),
  CHECK (selected_snapshot_key = CAST(selected_channel_type AS TEXT)),
  CHECK (selected_at = created_at),
  CHECK (owner_deadline_at = owner_lease_expires_at),
  CHECK (created_at < owner_lease_expires_at),
  FOREIGN KEY (reservation_key)
    REFERENCES relay_billing_reservations(reservation_key)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (operation_id)
    REFERENCES relay_container_operations(operation_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX idx_relay_container_atomic_admissions_created
  ON relay_container_atomic_admissions(created_at, reservation_key);

-- Every HMAC accepted by a rolling current/previous keyring is claimed in the
-- same transaction as the receipt. A different Worker version cannot create a
-- second operation under the other key because the alias primary key is the
-- shared D1 serialization point.
CREATE TABLE relay_container_idempotency_aliases (
  client_idempotency_hmac_sha256 TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(client_idempotency_hmac_sha256) = 'text'
      AND length(client_idempotency_hmac_sha256) = 64
      AND client_idempotency_hmac_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  reservation_key TEXT NOT NULL
    CHECK (
      typeof(reservation_key) = 'text'
      AND length(reservation_key) BETWEEN 1 AND 128
      AND reservation_key NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  operation_id TEXT NOT NULL
    CHECK (
      typeof(operation_id) = 'text'
      AND length(operation_id) BETWEEN 1 AND 128
      AND operation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  canonical_client_idempotency_hmac_sha256 TEXT NOT NULL
    CHECK (
      typeof(canonical_client_idempotency_hmac_sha256) = 'text'
      AND length(canonical_client_idempotency_hmac_sha256) = 64
      AND canonical_client_idempotency_hmac_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  client_request_sha256 TEXT NOT NULL
    CHECK (
      typeof(client_request_sha256) = 'text'
      AND length(client_request_sha256) = 64
      AND client_request_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  created_at INTEGER NOT NULL
    CHECK (typeof(created_at) = 'integer' AND created_at > 0),
  CHECK (operation_id = reservation_key),
  FOREIGN KEY (reservation_key)
    REFERENCES relay_container_atomic_admissions(reservation_key)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (operation_id)
    REFERENCES relay_container_operations(operation_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX idx_relay_container_idempotency_aliases_reservation
  ON relay_container_idempotency_aliases(reservation_key, client_idempotency_hmac_sha256);

CREATE TRIGGER relay_container_idempotency_alias_insert_guard
BEFORE INSERT ON relay_container_idempotency_aliases
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM relay_container_atomic_admissions AS admission
  WHERE admission.reservation_key = NEW.reservation_key
    AND admission.operation_id = NEW.operation_id
    AND admission.client_idempotency_hmac_sha256 =
      NEW.canonical_client_idempotency_hmac_sha256
    AND admission.client_request_sha256 = NEW.client_request_sha256
    AND admission.created_at = NEW.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'relay container idempotency alias authority mismatch');
END;

CREATE TRIGGER relay_container_idempotency_alias_update_guard
BEFORE UPDATE ON relay_container_idempotency_aliases
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container idempotency alias is immutable');
END;

CREATE TRIGGER relay_container_idempotency_alias_delete_guard
BEFORE DELETE ON relay_container_idempotency_aliases
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container idempotency alias cannot be deleted');
END;

-- The receipt is inserted first with deferred foreign keys. Requiring it from
-- the operation INSERT closes the legacy writer path entirely: a pre-0050
-- writer cannot even create an unmarked prepared canary operation.
CREATE TRIGGER relay_container_atomic_admission_operation_insert_guard
BEFORE INSERT ON relay_container_operations
FOR EACH ROW
WHEN NEW.protocol_version = 1
  AND NEW.operation_kind = 'chat_completions_canary'
  AND NOT EXISTS (
  SELECT 1
  FROM relay_billing_reservations AS reservation
  JOIN relay_container_atomic_admissions AS admission
    ON admission.reservation_key = reservation.reservation_key
   AND admission.operation_id = NEW.operation_id
  JOIN relay_container_idempotency_aliases AS canonical_alias
    ON canonical_alias.client_idempotency_hmac_sha256 =
         admission.client_idempotency_hmac_sha256
   AND canonical_alias.reservation_key = admission.reservation_key
   AND canonical_alias.operation_id = admission.operation_id
   AND canonical_alias.canonical_client_idempotency_hmac_sha256 =
         admission.client_idempotency_hmac_sha256
   AND canonical_alias.client_request_sha256 = admission.client_request_sha256
   AND canonical_alias.created_at = admission.created_at
  WHERE reservation.reservation_key = NEW.reservation_key
    AND reservation.status = 'reserved'
    AND reservation.user_id = admission.user_id
    AND reservation.token_id = admission.token_id
    AND reservation.pre_consumed_quota = admission.pre_consumed_quota
    AND reservation.owner_generation = admission.owner_generation
    AND reservation.lease_expires_at = admission.owner_lease_expires_at
    AND reservation.owner_deadline_at = admission.owner_deadline_at
    AND reservation.channel_id = admission.channel_id
    AND reservation.selected_group = admission.selected_group
    AND reservation.selected_at = admission.selected_at
    AND reservation.created_at = admission.created_at
    AND reservation.updated_at = admission.created_at
    AND admission.contract_version = 1
    AND admission.operation_admission_sha256 = NEW.admission_sha256
    AND admission.client_idempotency_hmac_sha256 = NEW.client_idempotency_hmac_sha256
    AND admission.client_request_sha256 = NEW.client_request_sha256
    AND admission.idempotency_alias_count = (
      SELECT COUNT(*)
      FROM relay_container_idempotency_aliases AS alias
      WHERE alias.reservation_key = admission.reservation_key
        AND alias.operation_id = admission.operation_id
        AND alias.canonical_client_idempotency_hmac_sha256 =
              admission.client_idempotency_hmac_sha256
        AND alias.client_request_sha256 = admission.client_request_sha256
        AND alias.created_at = admission.created_at
    )
    AND admission.owner_generation = NEW.owner_generation
    AND admission.owner_lease_expires_at = NEW.owner_lease_expires_at
    AND admission.channel_id = NEW.channel_id
    AND admission.selected_group = NEW.selected_group
    AND admission.created_at = NEW.created_at
    AND NEW.status = 'prepared'
    AND NEW.updated_at = NEW.created_at
    AND NEW.execution_deadline_at > NEW.created_at
    AND NEW.execution_deadline_at < NEW.owner_lease_expires_at
    AND NEW.response_status IS NULL
    AND NEW.response_code IS NULL
    AND NEW.result_object_key IS NULL
    AND NEW.result_object_version IS NULL
    AND NEW.result_sha256 IS NULL
    AND NEW.result_size IS NULL
    AND NEW.result_content_type IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'relay container atomic admission authority mismatch');
END;

CREATE TRIGGER relay_container_atomic_admission_update_guard
BEFORE UPDATE ON relay_container_atomic_admissions
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container atomic admission is immutable');
END;

CREATE TRIGGER relay_container_atomic_admission_delete_guard
BEFORE DELETE ON relay_container_atomic_admissions
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container atomic admission cannot be deleted');
END;

CREATE TRIGGER relay_container_canary_atomic_admission_update_guard
BEFORE UPDATE ON relay_container_operations
FOR EACH ROW
WHEN
  OLD.protocol_version = 1
  AND OLD.operation_kind = 'chat_completions_canary'
  AND NOT EXISTS (
    SELECT 1
    FROM relay_container_atomic_admissions AS admission
    WHERE admission.reservation_key = OLD.reservation_key
      AND admission.operation_id = OLD.operation_id
      AND admission.contract_version = 1
      AND admission.operation_admission_sha256 = OLD.admission_sha256
      AND admission.client_idempotency_hmac_sha256 = OLD.client_idempotency_hmac_sha256
      AND admission.client_request_sha256 = OLD.client_request_sha256
      AND admission.owner_generation = OLD.owner_generation
      AND admission.owner_lease_expires_at = OLD.owner_lease_expires_at
      AND admission.channel_id = OLD.channel_id
      AND admission.selected_group = OLD.selected_group
      AND admission.created_at = OLD.created_at
  )
BEGIN
  SELECT RAISE(ABORT, 'relay container canary operation lacks atomic admission');
END;

CREATE TRIGGER relay_container_canary_operation_delete_guard
BEFORE DELETE ON relay_container_operations
FOR EACH ROW
WHEN OLD.protocol_version = 1
  AND OLD.operation_kind = 'chat_completions_canary'
BEGIN
  SELECT RAISE(ABORT, 'relay container canary operation cannot be deleted');
END;
