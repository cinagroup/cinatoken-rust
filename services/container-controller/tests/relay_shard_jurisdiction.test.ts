import { describe, expect, test } from "bun:test";

import { ProtocolError } from "../src/protocol";
import {
  RELAY_SHARD_RESTRICTED_JURISDICTIONS,
  assertRelayShardObjectJurisdiction,
  relayShardJurisdictionPolicy,
  selectRelayShardNamespace,
  type RelayShardJurisdictionEnvironment,
} from "../src/relay_shard_jurisdiction";

function jurisdictionEnv(
  overrides: Partial<RelayShardJurisdictionEnvironment> = {},
): RelayShardJurisdictionEnvironment {
  return {
    CONTAINER_DURABLE_OBJECT_JURISDICTION: "default",
    CONTAINER_DURABLE_OBJECT_JURISDICTION_ENABLED: "false",
    CONTAINER_DURABLE_OBJECT_JURISDICTION_STAGING_VERIFIED: "false",
    ...overrides,
  };
}

function restrictedEnv(jurisdiction: string): RelayShardJurisdictionEnvironment {
  return jurisdictionEnv({
    CONTAINER_DURABLE_OBJECT_JURISDICTION: jurisdiction,
    CONTAINER_DURABLE_OBJECT_JURISDICTION_ENABLED: "true",
    CONTAINER_DURABLE_OBJECT_JURISDICTION_STAGING_VERIFIED: "true",
  });
}

function expectProtocolError(
  callback: () => unknown,
  code: string,
): void {
  try {
    callback();
    throw new Error("expected ProtocolError");
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe(code);
    expect((error as ProtocolError).status).toBe(503);
  }
}

describe("RelayShardContainer Durable Object jurisdiction policy", () => {
  test("default policy retains the base namespace without calling jurisdiction", () => {
    let jurisdictionCalls = 0;
    const namespace = {
      getByName: (name: string) => `base:${name}`,
      jurisdiction: () => {
        jurisdictionCalls += 1;
        throw new Error("must not select a restricted subnamespace");
      },
    };

    const selected = selectRelayShardNamespace({
      ...jurisdictionEnv(),
      RELAY_SHARDS: namespace,
    });

    expect(selected).toBe(namespace);
    expect(selected.getByName("shard-1")).toBe("base:shard-1");
    expect(jurisdictionCalls).toBe(0);
    expect(relayShardJurisdictionPolicy(jurisdictionEnv())).toEqual({
      jurisdiction: "default",
      restricted: false,
    });
  });

  for (const expected of RELAY_SHARD_RESTRICTED_JURISDICTIONS) {
    test(`selects the ${expected} subnamespace before deriving an object`, () => {
      const selectedNamespace = {
        getByName: (name: string) => `${expected}:${name}`,
      };
      const calls: string[] = [];
      const baseNamespace = {
        getByName: (name: string) => `base:${name}`,
        jurisdiction(jurisdiction: string) {
          calls.push(jurisdiction);
          return selectedNamespace;
        },
      };

      const selected = selectRelayShardNamespace({
        ...restrictedEnv(expected),
        RELAY_SHARDS: baseNamespace,
      });

      expect(calls).toEqual([expected]);
      expect(selected).toBe(selectedNamespace);
      expect(selected.getByName("shard-2")).toBe(`${expected}:shard-2`);
    });
  }

  test("rejects unknown jurisdictions and non-boolean gates", () => {
    expectProtocolError(
      () =>
        relayShardJurisdictionPolicy(
          jurisdictionEnv({
            CONTAINER_DURABLE_OBJECT_JURISDICTION: "apac",
          }),
        ),
      "container_durable_object_jurisdiction_invalid",
    );
    for (const name of [
      "CONTAINER_DURABLE_OBJECT_JURISDICTION_ENABLED",
      "CONTAINER_DURABLE_OBJECT_JURISDICTION_STAGING_VERIFIED",
    ] as const) {
      expectProtocolError(
        () =>
          relayShardJurisdictionPolicy(
            jurisdictionEnv({ [name]: "1" }),
          ),
        "container_durable_object_jurisdiction_gate_invalid",
      );
    }
  });

  test("rejects every partial or contradictory gate combination", () => {
    for (const [jurisdiction, enabled, stagingVerified] of [
      ["default", "true", "false"],
      ["default", "false", "true"],
      ["default", "true", "true"],
      ["eu", "false", "false"],
      ["eu", "true", "false"],
      ["eu", "false", "true"],
    ]) {
      expectProtocolError(
        () =>
          relayShardJurisdictionPolicy(
            jurisdictionEnv({
              CONTAINER_DURABLE_OBJECT_JURISDICTION: jurisdiction,
              CONTAINER_DURABLE_OBJECT_JURISDICTION_ENABLED: enabled,
              CONTAINER_DURABLE_OBJECT_JURISDICTION_STAGING_VERIFIED:
                stagingVerified,
            }),
          ),
        "container_durable_object_jurisdiction_gate_mismatch",
      );
    }
  });

  test("fails closed when the runtime lacks restricted namespace support", () => {
    expectProtocolError(
      () =>
        selectRelayShardNamespace({
          ...restrictedEnv("eu"),
          RELAY_SHARDS: {
            getByName: (name: string) => name,
          },
        }),
      "container_durable_object_jurisdiction_unavailable",
    );
  });

  test("checks the actual object jurisdiction before local initialization", () => {
    expect(assertRelayShardObjectJurisdiction(jurisdictionEnv(), undefined)).toEqual({
      jurisdiction: "default",
      restricted: false,
    });
    expect(assertRelayShardObjectJurisdiction(restrictedEnv("eu"), "eu")).toEqual({
      jurisdiction: "eu",
      restricted: true,
    });

    for (const [env, actual] of [
      [jurisdictionEnv(), "eu"],
      [restrictedEnv("eu"), undefined],
      [restrictedEnv("eu"), "us"],
    ] as const) {
      expectProtocolError(
        () => assertRelayShardObjectJurisdiction(env, actual),
        "container_durable_object_jurisdiction_mismatch",
      );
    }
  });
});
