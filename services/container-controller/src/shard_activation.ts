import { ProtocolError, type OperationShard } from "./protocol";

export const SHARD_ACTIVATION_CONTRACT =
  "cinatoken-relay-container-shard-activation-v1";
export const SHARD_ACTIVATION_WRITE_ENABLED_ENV =
  "CONTAINER_SHARD_ACTIVATION_WRITE_ENABLED";

const ACTIVATION_DIGEST_DOMAIN = new TextEncoder().encode(
  "cinatoken:relay-container-shard-activation:v1\0",
);
const VERSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_VERSION = 1_000_000;
const MAX_SHARDS = 1_024;

const SCHEMA_READINESS_SQL = `
SELECT
  (SELECT COUNT(1)
   FROM d1_migrations
   WHERE name = '0054_relay_container_shard_activations.sql') AS migration_count,
  (SELECT COUNT(1)
   FROM sqlite_master
   WHERE type = 'table'
     AND name = 'relay_container_shard_activations') AS table_count,
  (SELECT COUNT(1)
   FROM pragma_table_info('relay_container_shard_activations')) AS column_count,
  (SELECT COUNT(1)
   FROM pragma_table_info('relay_container_shard_activations')
   WHERE name IN (
     'activation_id', 'controller_version_id', 'ring_generation', 'shard_count',
     'shard_index', 'instance_name', 'shard_contract_version',
     'runtime_protocol_version', 'runtime_contract_version', 'runtime_build_id',
     'activation_generation', 'activation_probe_generation', 'environment',
     'container_status', 'readiness_result_code', 'process_ready',
     'runtime_execution_enabled', 'controller_execution_enabled',
     'activation_digest_sha256', 'activated_at'
   )) AS required_column_count,
  (SELECT COUNT(1)
   FROM sqlite_master
   WHERE type = 'index'
     AND name IN (
       'idx_relay_container_shard_activations_identity',
       'idx_relay_container_shard_activations_instance'
     )) AS index_count,
  (SELECT COUNT(1)
   FROM pragma_index_list('relay_container_shard_activations')
   WHERE name IN (
     'idx_relay_container_shard_activations_identity',
     'idx_relay_container_shard_activations_instance'
   ) AND "unique" = 1) AS unique_index_count,
  (SELECT COUNT(1)
   FROM pragma_index_info('idx_relay_container_shard_activations_identity')
   WHERE (seqno = 0 AND name = 'controller_version_id')
      OR (seqno = 1 AND name = 'runtime_build_id')
      OR (seqno = 2 AND name = 'ring_generation')
      OR (seqno = 3 AND name = 'shard_index')) AS identity_index_column_count,
  (SELECT COUNT(1)
   FROM pragma_index_info('idx_relay_container_shard_activations_instance')
   WHERE (seqno = 0 AND name = 'controller_version_id')
      OR (seqno = 1 AND name = 'runtime_build_id')
      OR (seqno = 2 AND name = 'ring_generation')
      OR (seqno = 3 AND name = 'instance_name')) AS instance_index_column_count,
  (SELECT COUNT(1)
   FROM sqlite_master
   WHERE type = 'trigger'
     AND name IN (
       'relay_container_shard_activation_update_guard',
       'relay_container_shard_activation_delete_guard'
     )) AS trigger_count,
  (SELECT COUNT(1)
   FROM sqlite_master
   WHERE type = 'trigger'
     AND lower(sql) LIKE '%raise(abort,%relay container shard activation rows are immutable%'
     AND (
       (name = 'relay_container_shard_activation_update_guard'
        AND lower(sql) LIKE '%before update on relay_container_shard_activations%')
       OR
       (name = 'relay_container_shard_activation_delete_guard'
        AND lower(sql) LIKE '%before delete on relay_container_shard_activations%')
     )) AS immutable_trigger_count,
  (SELECT COUNT(1)
   FROM sqlite_master
   WHERE type = 'table'
     AND name = 'relay_container_shard_activations'
     AND lower(sql) LIKE '%controller_version_id text not null%length(controller_version_id) between 1 and 128%'
     AND lower(sql) LIKE '%shard_count integer not null%shard_count between 1 and 1024%'
     AND lower(sql) LIKE '%shard_index integer not null%shard_index between 0 and shard_count - 1%'
     AND lower(sql) LIKE '%runtime_build_id text not null%length(runtime_build_id) = 64%'
     AND lower(sql) LIKE '%environment text not null%environment in (%staging%production%'
     AND lower(sql) LIKE '%container_status text not null%container_status = %healthy%'
     AND lower(sql) LIKE '%readiness_result_code text not null%process_ready_execution_disabled%execution_ready%'
     AND lower(sql) LIKE '%activation_digest_sha256 text not null%length(activation_digest_sha256) = 64%'
     AND lower(sql) LIKE '%activated_at integer not null%activated_at > 0%'
     AND lower(sql) LIKE '%readiness_result_code = %execution_ready%runtime_execution_enabled = 1%controller_execution_enabled = 1%'
     AND lower(sql) LIKE '%readiness_result_code = %process_ready_execution_disabled%runtime_execution_enabled = 0 or controller_execution_enabled = 0%'
  ) AS constraint_shape_count
`.trim();

const INSERT_SQL = `
INSERT INTO relay_container_shard_activations (
  controller_version_id,
  ring_generation,
  shard_count,
  shard_index,
  instance_name,
  shard_contract_version,
  runtime_protocol_version,
  runtime_contract_version,
  runtime_build_id,
  activation_generation,
  activation_probe_generation,
  environment,
  container_status,
  readiness_result_code,
  process_ready,
  runtime_execution_enabled,
  controller_execution_enabled,
  activation_digest_sha256,
  activated_at
) VALUES (
  ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
  ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19
)
ON CONFLICT(controller_version_id, runtime_build_id, ring_generation, shard_index) DO NOTHING
`.trim();

const READBACK_SQL = `
SELECT
  activation_id,
  controller_version_id,
  ring_generation,
  shard_count,
  shard_index,
  instance_name,
  shard_contract_version,
  runtime_protocol_version,
  runtime_contract_version,
  runtime_build_id,
  activation_generation,
  activation_probe_generation,
  environment,
  container_status,
  readiness_result_code,
  process_ready,
  runtime_execution_enabled,
  controller_execution_enabled,
  activation_digest_sha256,
  activated_at
FROM relay_container_shard_activations
WHERE controller_version_id = ?1
  AND runtime_build_id = ?2
  AND ring_generation = ?3
  AND shard_index = ?4
LIMIT 1
`.trim();

export interface ShardActivationInput {
  controllerVersionId: string;
  shard: OperationShard;
  runtimeProtocolVersion: number;
  runtimeContractVersion: number;
  runtimeBuildId: string;
  activationGeneration: number;
  activationProbeGeneration: number;
  environment: "staging" | "production";
  containerStatus: "healthy";
  readinessResultCode:
    | "process_ready_execution_disabled"
    | "execution_ready";
  processReady: true;
  runtimeExecutionEnabled: boolean;
  controllerExecutionEnabled: boolean;
  activatedAt: number;
}

export type ShardActivationWriteOutcome = "recorded" | "duplicate";

interface ShardActivationStoredRow extends Record<string, unknown> {
  activation_id: number;
  controller_version_id: string;
  ring_generation: number;
  shard_count: number;
  shard_index: number;
  instance_name: string;
  shard_contract_version: number;
  runtime_protocol_version: number;
  runtime_contract_version: number;
  runtime_build_id: string;
  activation_generation: number;
  activation_probe_generation: number;
  environment: string;
  container_status: string;
  readiness_result_code: string;
  process_ready: number;
  runtime_execution_enabled: number;
  controller_execution_enabled: number;
  activation_digest_sha256: string;
  activated_at: number;
}

type ShardActivationInsertRow = Omit<ShardActivationStoredRow, "activation_id">;

type ShardActivationDatabase = Pick<D1Database, "withSession">;

export async function recordShardActivation(
  database: ShardActivationDatabase,
  input: ShardActivationInput,
): Promise<ShardActivationWriteOutcome> {
  validateShardActivationInput(input);
  const digest = await shardActivationDigest(input);
  const expected = activationRow(input, digest);
  let session: ReturnType<ShardActivationDatabase["withSession"]>;
  try {
    session = database.withSession("first-primary");
    const schema = await session
      .prepare(SCHEMA_READINESS_SQL)
      .first<Record<string, unknown>>();
    if (!shardActivationSchemaReady(schema)) {
      throw new ProtocolError("shard_activation_schema_unavailable", 503);
    }
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError("shard_activation_schema_unavailable", 503);
  }

  let changes: number;
  try {
    const result = await session
      .prepare(INSERT_SQL)
      .bind(...activationBindings(expected))
      .run();
    changes = result?.meta?.changes;
    if (result?.success !== true || (changes !== 0 && changes !== 1)) {
      throw new ProtocolError("shard_activation_write_invalid", 502);
    }
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError("shard_activation_write_unavailable", 503);
  }

  let stored: Record<string, unknown> | null;
  try {
    stored = await session
      .prepare(READBACK_SQL)
      .bind(
        input.controllerVersionId,
        input.runtimeBuildId,
        input.shard.ring_generation,
        input.shard.shard_index,
      )
      .first<Record<string, unknown>>();
  } catch {
    throw new ProtocolError("shard_activation_readback_unavailable", 503);
  }
  if (!isShardActivationRow(stored)) {
    throw new ProtocolError("shard_activation_readback_invalid", 502);
  }
  let storedDigest: string;
  try {
    storedDigest = await storedShardActivationDigest(stored);
  } catch {
    throw new ProtocolError("shard_activation_readback_invalid", 502);
  }
  if (stored.activation_digest_sha256 !== storedDigest) {
    throw new ProtocolError("shard_activation_readback_invalid", 502);
  }
  const matches =
    changes === 1
      ? Object.entries(expected).every(([key, value]) => Object.is(stored[key], value))
      : activationCandidateMatches(stored, expected);
  if (!matches) {
    throw new ProtocolError("shard_activation_conflict", 409);
  }
  return changes === 0 ? "duplicate" : "recorded";
}

function shardActivationSchemaReady(
  schema: Record<string, unknown> | null,
): boolean {
  if (schema === null) return false;
  const expected = {
    migration_count: 1,
    table_count: 1,
    column_count: 20,
    required_column_count: 20,
    index_count: 2,
    unique_index_count: 2,
    identity_index_column_count: 4,
    instance_index_column_count: 4,
    trigger_count: 2,
    immutable_trigger_count: 2,
    constraint_shape_count: 1,
  };
  return (
    Object.keys(schema).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => schema[key] === value)
  );
}

export async function shardActivationDigest(
  input: ShardActivationInput,
): Promise<string> {
  validateShardActivationInput(input);
  const parts = [
    input.controllerVersionId,
    input.shard.ring_generation.toString(),
    input.shard.shard_count.toString(),
    input.shard.shard_index.toString(),
    input.shard.instance_name,
    input.shard.contract_version.toString(),
    input.runtimeProtocolVersion.toString(),
    input.runtimeContractVersion.toString(),
    input.runtimeBuildId,
    input.activationGeneration.toString(),
    input.activationProbeGeneration.toString(),
    input.environment,
    input.containerStatus,
    input.readinessResultCode,
    "1",
    input.runtimeExecutionEnabled ? "1" : "0",
    input.controllerExecutionEnabled ? "1" : "0",
    input.activatedAt.toString(),
  ];
  return digestParts(parts);
}

async function digestParts(parts: string[]): Promise<string> {
  const encoded = parts.map((part) => new TextEncoder().encode(part));
  const byteLength =
    ACTIVATION_DIGEST_DOMAIN.length +
    encoded.reduce((total, part) => total + 4 + part.length, 0);
  const bytes = new Uint8Array(byteLength);
  bytes.set(ACTIVATION_DIGEST_DOMAIN, 0);
  let offset = ACTIVATION_DIGEST_DOMAIN.length;
  const view = new DataView(bytes.buffer);
  for (const part of encoded) {
    view.setUint32(offset, part.length, false);
    offset += 4;
    bytes.set(part, offset);
    offset += part.length;
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function validateShardActivationInput(input: ShardActivationInput): void {
  if (!VERSION_ID_PATTERN.test(input.controllerVersionId)) invalid();
  const shard = input.shard;
  if (
    !positiveVersion(shard.contract_version) ||
    !positiveVersion(shard.ring_generation) ||
    !Number.isSafeInteger(shard.shard_count) ||
    shard.shard_count < 1 ||
    shard.shard_count > MAX_SHARDS ||
    !Number.isSafeInteger(shard.shard_index) ||
    shard.shard_index < 0 ||
    shard.shard_index >= shard.shard_count ||
    shard.instance_name !==
      `cinatoken-relay-shard-v1-${shard.shard_index.toString().padStart(4, "0")}`
  ) {
    invalid();
  }
  if (
    !positiveVersion(input.runtimeProtocolVersion) ||
    !positiveVersion(input.runtimeContractVersion) ||
    !/^[0-9a-f]{64}$/.test(input.runtimeBuildId) ||
    !positiveVersion(input.activationGeneration) ||
    !positiveVersion(input.activationProbeGeneration) ||
    !["staging", "production"].includes(input.environment) ||
    input.containerStatus !== "healthy" ||
    input.processReady !== true ||
    !Number.isSafeInteger(input.activatedAt) ||
    input.activatedAt <= 0
  ) {
    invalid();
  }
  const executionReady =
    input.runtimeExecutionEnabled && input.controllerExecutionEnabled;
  if (
    (input.readinessResultCode === "execution_ready" && !executionReady) ||
    (input.readinessResultCode === "process_ready_execution_disabled" &&
      executionReady) ||
    ![
      "process_ready_execution_disabled",
      "execution_ready",
    ].includes(input.readinessResultCode)
  ) {
    invalid();
  }
}

function activationRow(
  input: ShardActivationInput,
  digest: string,
): ShardActivationInsertRow {
  return {
    controller_version_id: input.controllerVersionId,
    ring_generation: input.shard.ring_generation,
    shard_count: input.shard.shard_count,
    shard_index: input.shard.shard_index,
    instance_name: input.shard.instance_name,
    shard_contract_version: input.shard.contract_version,
    runtime_protocol_version: input.runtimeProtocolVersion,
    runtime_contract_version: input.runtimeContractVersion,
    runtime_build_id: input.runtimeBuildId,
    activation_generation: input.activationGeneration,
    activation_probe_generation: input.activationProbeGeneration,
    environment: input.environment,
    container_status: input.containerStatus,
    readiness_result_code: input.readinessResultCode,
    process_ready: 1,
    runtime_execution_enabled: input.runtimeExecutionEnabled ? 1 : 0,
    controller_execution_enabled: input.controllerExecutionEnabled ? 1 : 0,
    activation_digest_sha256: digest,
    activated_at: input.activatedAt,
  };
}

function isShardActivationRow(value: unknown): value is ShardActivationStoredRow {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    Object.keys(row).length === 20 &&
    typeof row.controller_version_id === "string" &&
    typeof row.instance_name === "string" &&
    typeof row.environment === "string" &&
    typeof row.container_status === "string" &&
    typeof row.readiness_result_code === "string" &&
    typeof row.activation_digest_sha256 === "string" &&
    typeof row.runtime_build_id === "string" &&
    [
      "activation_id",
      "ring_generation",
      "shard_count",
      "shard_index",
      "shard_contract_version",
      "runtime_protocol_version",
      "runtime_contract_version",
      "activation_generation",
      "activation_probe_generation",
      "process_ready",
      "runtime_execution_enabled",
      "controller_execution_enabled",
      "activated_at",
    ].every((key) => typeof row[key] === "number")
  );
}

function activationBindings(row: ShardActivationInsertRow): unknown[] {
  return [
    row.controller_version_id,
    row.ring_generation,
    row.shard_count,
    row.shard_index,
    row.instance_name,
    row.shard_contract_version,
    row.runtime_protocol_version,
    row.runtime_contract_version,
    row.runtime_build_id,
    row.activation_generation,
    row.activation_probe_generation,
    row.environment,
    row.container_status,
    row.readiness_result_code,
    row.process_ready,
    row.runtime_execution_enabled,
    row.controller_execution_enabled,
    row.activation_digest_sha256,
    row.activated_at,
  ];
}

function activationCandidateMatches(
  stored: ShardActivationStoredRow,
  candidate: ShardActivationInsertRow,
): boolean {
  const stableKeys: Array<keyof ShardActivationInsertRow> = [
    "controller_version_id",
    "ring_generation",
    "shard_count",
    "shard_index",
    "instance_name",
    "shard_contract_version",
    "runtime_protocol_version",
    "runtime_contract_version",
    "runtime_build_id",
    "activation_generation",
    "environment",
    "container_status",
    "readiness_result_code",
    "process_ready",
    "runtime_execution_enabled",
    "controller_execution_enabled",
  ];
  return stableKeys.every((key) => Object.is(stored[key], candidate[key]));
}

async function storedShardActivationDigest(
  row: ShardActivationStoredRow,
): Promise<string> {
  return digestParts([
    row.controller_version_id,
    row.ring_generation.toString(),
    row.shard_count.toString(),
    row.shard_index.toString(),
    row.instance_name,
    row.shard_contract_version.toString(),
    row.runtime_protocol_version.toString(),
    row.runtime_contract_version.toString(),
    row.runtime_build_id,
    row.activation_generation.toString(),
    row.activation_probe_generation.toString(),
    row.environment,
    row.container_status,
    row.readiness_result_code,
    row.process_ready.toString(),
    row.runtime_execution_enabled.toString(),
    row.controller_execution_enabled.toString(),
    row.activated_at.toString(),
  ]);
}

function positiveVersion(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_VERSION;
}

function invalid(): never {
  throw new ProtocolError("invalid_shard_activation", 502);
}
