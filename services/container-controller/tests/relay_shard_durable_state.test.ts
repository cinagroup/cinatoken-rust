import { describe, expect, it } from "vitest";

import { ProtocolError, type OperationShard } from "../src/protocol";
import {
  RELAY_SHARD_ALARM_MAX_DELIVERIES,
  RELAY_SHARD_ALARM_RETRY_HORIZON_SECONDS,
  buildRelayShardAlarmIntentV1,
  parseOperationRecoverySchedule,
  relayShardAlarmRetryAt,
} from "../src/relay_shard_durable_state";

const shard: OperationShard = {
  contract_version: 1,
  ring_generation: 7,
  shard_count: 8,
  shard_index: 3,
  instance_name: "cinatoken-relay-shard-v1-0003",
};

function expectInvalidSchedule(value: unknown): void {
  try {
    parseOperationRecoverySchedule(value);
    throw new Error("expected schedule validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe("invalid_operation_recovery_schedule");
  }
}

describe("relay shard durable alarm ABI", () => {
  it("normalizes the legacy three-field payload without changing its wire contract", () => {
    expect(
      parseOperationRecoverySchedule({
        operation_id: "operation-legacy",
        owner_generation: 2,
        deadline_at: 1_800_000_100,
      }),
    ).toEqual({
      payload_version: 0,
      kind: "operation_deadline",
      operation_id: "operation-legacy",
      owner_generation: 2,
      deadline_at: 1_800_000_100,
      delivery_generation: 0,
      shard: null,
    });
  });

  it("round-trips the exact v1 payload", () => {
    const payload = buildRelayShardAlarmIntentV1(
      "operation-v1",
      4,
      1_800_000_200,
      3,
      shard,
    );
    expect(parseOperationRecoverySchedule(payload)).toEqual(payload);
  });

  it("rejects unknown fields, future versions, and noncanonical shards", () => {
    const payload = buildRelayShardAlarmIntentV1(
      "operation-v1",
      4,
      1_800_000_200,
      3,
      shard,
    );
    expectInvalidSchedule({ ...payload, ignored: true });
    expectInvalidSchedule({ ...payload, payload_version: 2 });
    expectInvalidSchedule({ ...payload, delivery_generation: 9 });
    expectInvalidSchedule({
      ...payload,
      shard: { ...payload.shard, instance_name: "cinatoken-relay-shard-v1-0004" },
    });
    expectInvalidSchedule({
      operation_id: "operation-legacy",
      owner_generation: 2,
      deadline_at: 1_800_000_100,
      payload_version: 0,
    });
  });

  it("uses deterministic bounded retry timing and stops at the delivery ceiling", () => {
    const now = 1_800_000_200;
    const deadline = 1_800_000_100;
    const first = relayShardAlarmRetryAt("operation-retry", 1, now, deadline);
    expect(first).not.toBeNull();
    expect(first).toBe(relayShardAlarmRetryAt("operation-retry", 1, now, deadline));
    expect(first!).toBeGreaterThanOrEqual(now + 5);
    expect(first!).toBeLessThanOrEqual(now + 6);
    expect(
      relayShardAlarmRetryAt(
        "operation-retry",
        RELAY_SHARD_ALARM_MAX_DELIVERIES,
        now,
        deadline,
      ),
    ).toBeNull();
    expect(
      relayShardAlarmRetryAt(
        "operation-retry",
        1,
        deadline + RELAY_SHARD_ALARM_RETRY_HORIZON_SECONDS,
        deadline,
      ),
    ).toBeNull();
  });
});
