CREATE TABLE json_compatibility_deployment_transition_authorities (
  operation_id_sha256 TEXT PRIMARY KEY NOT NULL,
  authority_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(authority_digest_sha256) = 'text'
      AND length(authority_digest_sha256) = 64
      AND authority_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  authority_json TEXT NOT NULL
    CHECK (
      typeof(authority_json) = 'text'
      AND length(CAST(authority_json AS BLOB)) BETWEEN 2 AND 32768
    ),
  coordinator_service_name TEXT NOT NULL,
  coordinator_version_id TEXT NOT NULL,
  coordinator_identity_sha256 TEXT NOT NULL,
  source_verifier_service_name TEXT NOT NULL,
  source_verifier_version_id TEXT NOT NULL,
  source_verifier_identity_sha256 TEXT NOT NULL,
  readback_service_name TEXT NOT NULL,
  readback_version_id TEXT NOT NULL,
  readback_identity_sha256 TEXT NOT NULL,
  readback_credential_id_sha256 TEXT NOT NULL,
  mutation_service_name TEXT NOT NULL,
  mutation_version_id TEXT NOT NULL,
  mutation_identity_sha256 TEXT NOT NULL,
  mutation_credential_id_sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer'),
  FOREIGN KEY (operation_id_sha256)
    REFERENCES json_compatibility_deployment_transition_operations(
      operation_id_sha256
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CHECK (
    typeof(coordinator_service_name) = 'text'
    AND length(coordinator_service_name) BETWEEN 1 AND 128
    AND coordinator_service_name NOT GLOB '*[^a-z0-9-]*'
  ),
  CHECK (
    typeof(source_verifier_service_name) = 'text'
    AND length(source_verifier_service_name) BETWEEN 1 AND 128
    AND source_verifier_service_name NOT GLOB '*[^a-z0-9-]*'
  ),
  CHECK (
    typeof(readback_service_name) = 'text'
    AND length(readback_service_name) BETWEEN 1 AND 128
    AND readback_service_name NOT GLOB '*[^a-z0-9-]*'
  ),
  CHECK (
    typeof(mutation_service_name) = 'text'
    AND length(mutation_service_name) BETWEEN 1 AND 128
    AND mutation_service_name NOT GLOB '*[^a-z0-9-]*'
  ),
  CHECK (
    length(coordinator_version_id) BETWEEN 1 AND 128
    AND length(source_verifier_version_id) BETWEEN 1 AND 128
    AND length(readback_version_id) BETWEEN 1 AND 128
    AND length(mutation_version_id) BETWEEN 1 AND 128
  ),
  CHECK (
    length(coordinator_identity_sha256) = 64
    AND coordinator_identity_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(source_verifier_identity_sha256) = 64
    AND source_verifier_identity_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(readback_identity_sha256) = 64
    AND readback_identity_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(readback_credential_id_sha256) = 64
    AND readback_credential_id_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(mutation_identity_sha256) = 64
    AND mutation_identity_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(mutation_credential_id_sha256) = 64
    AND mutation_credential_id_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (readback_service_name <> mutation_service_name),
  CHECK (readback_identity_sha256 <> mutation_identity_sha256),
  CHECK (readback_credential_id_sha256 <> mutation_credential_id_sha256)
) WITHOUT ROWID;

CREATE TRIGGER json_compatibility_deployment_transition_authority_time_guard
BEFORE INSERT ON json_compatibility_deployment_transition_authorities
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NEW.created_at <> unixepoch()
  THEN RAISE(ABORT, 'transition authority time must come from D1') END;
END;

CREATE TRIGGER json_compatibility_deployment_transition_authority_update_guard
BEFORE UPDATE ON json_compatibility_deployment_transition_authorities
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'transition authorities are immutable');
END;

CREATE TRIGGER json_compatibility_deployment_transition_authority_delete_guard
BEFORE DELETE ON json_compatibility_deployment_transition_authorities
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'transition authorities are append-preserved');
END;
