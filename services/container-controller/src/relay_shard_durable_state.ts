import { ProtocolError, type OperationShard } from "./protocol";

export const RELAY_SHARD_ALARM_INTENT_VERSION = 1 as const;
export const RELAY_SHARD_ALARM_INTENT_KIND = "operation_deadline" as const;
export const RELAY_SHARD_ALARM_MAX_DELIVERIES = 8;
export const RELAY_SHARD_ALARM_RETRY_HORIZON_SECONDS = 86_400;

const RELAY_SHARD_ALARM_RETRY_BASE_SECONDS = 5;
const RELAY_SHARD_ALARM_RETRY_MAX_SECONDS = 300;

export interface LegacyOperationRecoverySchedule {
  payload_version: 0;
  kind: typeof RELAY_SHARD_ALARM_INTENT_KIND;
  operation_id: string;
  owner_generation: number;
  deadline_at: number;
  delivery_generation: 0;
  shard: null;
}

export interface RelayShardAlarmIntentV1 {
  payload_version: typeof RELAY_SHARD_ALARM_INTENT_VERSION;
  kind: typeof RELAY_SHARD_ALARM_INTENT_KIND;
  operation_id: string;
  owner_generation: number;
  deadline_at: number;
  delivery_generation: number;
  shard: OperationShard;
}

export type ParsedOperationRecoverySchedule =
  | LegacyOperationRecoverySchedule
  | RelayShardAlarmIntentV1;

export function buildRelayShardAlarmIntentV1(
  operationId: string,
  ownerGeneration: number,
  deadlineAt: number,
  deliveryGeneration: number,
  shard: OperationShard,
): RelayShardAlarmIntentV1 {
  return parseOperationRecoverySchedule({
    payload_version: RELAY_SHARD_ALARM_INTENT_VERSION,
    kind: RELAY_SHARD_ALARM_INTENT_KIND,
    operation_id: operationId,
    owner_generation: ownerGeneration,
    deadline_at: deadlineAt,
    delivery_generation: deliveryGeneration,
    shard,
  }) as RelayShardAlarmIntentV1;
}

export function parseOperationRecoverySchedule(
  value: unknown,
): ParsedOperationRecoverySchedule {
  const record = strictRecord(value, "invalid_operation_recovery_schedule");
  if (!("payload_version" in record)) {
    requireExactKeys(record, ["operation_id", "owner_generation", "deadline_at"]);
    return {
      payload_version: 0,
      kind: RELAY_SHARD_ALARM_INTENT_KIND,
      operation_id: operationId(record.operation_id),
      owner_generation: positiveInteger(record.owner_generation),
      deadline_at: positiveInteger(record.deadline_at),
      delivery_generation: 0,
      shard: null,
    };
  }
  requireExactKeys(record, [
    "payload_version",
    "kind",
    "operation_id",
    "owner_generation",
    "deadline_at",
    "delivery_generation",
    "shard",
  ]);
  if (
    record.payload_version !== RELAY_SHARD_ALARM_INTENT_VERSION ||
    record.kind !== RELAY_SHARD_ALARM_INTENT_KIND
  ) {
    throw invalidSchedule();
  }
  const deliveryGeneration = positiveInteger(record.delivery_generation);
  if (deliveryGeneration > RELAY_SHARD_ALARM_MAX_DELIVERIES) {
    throw invalidSchedule();
  }
  return {
    payload_version: RELAY_SHARD_ALARM_INTENT_VERSION,
    kind: RELAY_SHARD_ALARM_INTENT_KIND,
    operation_id: operationId(record.operation_id),
    owner_generation: positiveInteger(record.owner_generation),
    deadline_at: positiveInteger(record.deadline_at),
    delivery_generation: deliveryGeneration,
    shard: parseShard(record.shard),
  };
}

export function relayShardAlarmRetryAt(
  operationId: string,
  deliveryCount: number,
  now: number,
  deadlineAt: number,
): number | null {
  if (
    !Number.isSafeInteger(deliveryCount) ||
    deliveryCount < 1 ||
    deliveryCount >= RELAY_SHARD_ALARM_MAX_DELIVERIES ||
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(deadlineAt) ||
    now < 1 ||
    deadlineAt < 1 ||
    now >= deadlineAt + RELAY_SHARD_ALARM_RETRY_HORIZON_SECONDS
  ) {
    return null;
  }
  const exponent = Math.min(deliveryCount - 1, 6);
  const nominal = Math.min(
    RELAY_SHARD_ALARM_RETRY_BASE_SECONDS * 2 ** exponent,
    RELAY_SHARD_ALARM_RETRY_MAX_SECONDS,
  );
  let hash = 2_166_136_261;
  for (const byte of new TextEncoder().encode(operationId)) {
    hash ^= byte;
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  const jitter = hash % Math.max(1, Math.floor(nominal / 4) + 1);
  return Math.min(
    now + nominal + jitter,
    deadlineAt + RELAY_SHARD_ALARM_RETRY_HORIZON_SECONDS,
  );
}

export function operationShardsEqual(left: OperationShard, right: OperationShard): boolean {
  return (
    left.contract_version === right.contract_version &&
    left.ring_generation === right.ring_generation &&
    left.shard_count === right.shard_count &&
    left.shard_index === right.shard_index &&
    left.instance_name === right.instance_name
  );
}

function parseShard(value: unknown): OperationShard {
  const record = strictRecord(value, "invalid_operation_recovery_schedule");
  requireExactKeys(record, [
    "contract_version",
    "ring_generation",
    "shard_count",
    "shard_index",
    "instance_name",
  ]);
  const contractVersion = positiveInteger(record.contract_version);
  const ringGeneration = positiveInteger(record.ring_generation);
  const shardCount = positiveInteger(record.shard_count);
  const shardIndex = nonNegativeInteger(record.shard_index);
  if (
    contractVersion !== 1 ||
    shardCount > 1_024 ||
    shardIndex >= shardCount ||
    typeof record.instance_name !== "string" ||
    record.instance_name !== `cinatoken-relay-shard-v1-${shardIndex.toString().padStart(4, "0")}`
  ) {
    throw invalidSchedule();
  }
  return {
    contract_version: contractVersion,
    ring_generation: ringGeneration,
    shard_count: shardCount,
    shard_index: shardIndex,
    instance_name: record.instance_name,
  };
}

function strictRecord(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError(code, 500);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(record: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw invalidSchedule();
  }
}

function operationId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/.test(value)
  ) {
    throw invalidSchedule();
  }
  return value;
}

function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw invalidSchedule();
  }
  return value;
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalidSchedule();
  }
  return value;
}

function invalidSchedule(): ProtocolError {
  return new ProtocolError("invalid_operation_recovery_schedule", 500);
}
