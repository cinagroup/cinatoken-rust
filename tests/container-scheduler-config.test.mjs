import { describe, expect, test } from "bun:test";

const config = Bun.TOML.parse(
  await Bun.file(new URL("../wrangler.toml", import.meta.url)).text(),
);
const packageJson = await Bun.file(
  new URL("../package.json", import.meta.url),
).json();

const expected = {
  CONTAINER_SCHEDULER_RING_GENERATION: "1",
  CONTAINER_SCHEDULER_SHARD_COUNT: "8",
  CONTAINER_SCHEDULER_ENABLED: "false",
  CONTAINER_SCHEDULER_STAGING_VERIFIED: "false",
  CONTAINER_OPERATION_WRITE_ENABLED: "false",
  CONTAINER_TERMINAL_CAS_ENABLED: "false",
  CONTAINER_FINANCIAL_TERMINAL_ENABLED: "false",
  CONTAINER_EXACT_RESPONSE_REPLAY_ENABLED: "false",
  CONTAINER_OPERATION_RECONCILIATION_ENABLED: "false",
  CONTAINER_SCHEDULED_TERMINALIZER_ENABLED: "false",
  CONTAINER_SCHEDULED_TERMINALIZER_STAGING_VERIFIED: "false",
  CONTAINER_TERMINAL_OUTBOX_ENABLED: "false",
  CONTAINER_TERMINAL_OUTBOX_STAGING_VERIFIED: "false",
  CONTAINER_TERMINAL_OUTBOX_SCAN_LIMIT: "4",
  CONTAINER_R2_ORPHAN_INVENTORY_ENABLED: "false",
  CONTAINER_R2_ORPHAN_INVENTORY_SCAN_LIMIT: "4",
  CONTAINER_R2_ORPHAN_INVENTORY_GRACE_SECONDS: "86400",
  CONTAINER_DIVERGENCE_RECONCILIATION_VERIFIED: "false",
  CONTAINER_CHAT_CANARY_ENABLED: "false",
  CONTAINER_OPERATION_STAGING_VERIFIED: "false",
  CONTAINER_CONTROLLER_PROBE_ENABLED: "false",
  CONTAINER_SHARD_READINESS_PROBE_ENABLED: "false",
  CONTAINER_SHARD_READINESS_WAKE_ENABLED: "false",
  CONTAINER_SHARD_READINESS_STAGING_VERIFIED: "false",
  CONTAINER_PROTOCOL_VERSION: "1",
};

const environments = [
  ["top-level", config, config.vars, "cinatoken-container-controller-local", "local"],
  [
    "staging",
    config.env?.staging,
    config.env?.staging?.vars,
    "cinatoken-container-controller-staging",
    "staging",
  ],
  [
    "production",
    config.env?.production,
    config.env?.production?.vars,
    "cinatoken-container-controller-production",
    "production",
  ],
];

const operationGates = [
  "CONTAINER_OPERATION_WRITE_ENABLED",
  "CONTAINER_TERMINAL_CAS_ENABLED",
  "CONTAINER_FINANCIAL_TERMINAL_ENABLED",
  "CONTAINER_EXACT_RESPONSE_REPLAY_ENABLED",
  "CONTAINER_OPERATION_RECONCILIATION_ENABLED",
  "CONTAINER_SCHEDULED_TERMINALIZER_ENABLED",
  "CONTAINER_SCHEDULED_TERMINALIZER_STAGING_VERIFIED",
  "CONTAINER_TERMINAL_OUTBOX_ENABLED",
  "CONTAINER_TERMINAL_OUTBOX_STAGING_VERIFIED",
  "CONTAINER_DIVERGENCE_RECONCILIATION_VERIFIED",
  "CONTAINER_CHAT_CANARY_ENABLED",
  "CONTAINER_OPERATION_STAGING_VERIFIED",
];

describe("container scheduler Wrangler foundation", () => {
  for (const [environment, scope, vars, controllerService, authorityEnvironment] of environments) {
    test(`${environment} keeps the ring valid and runtime fail-closed`, () => {
      expect(vars).toBeDefined();
      expect(
        Object.fromEntries(
          Object.keys(expected).map((name) => [name, vars[name]]),
        ),
      ).toEqual(expected);
      expect(Number(vars.CONTAINER_SCHEDULER_RING_GENERATION)).toBe(1);
      expect(Number(vars.CONTAINER_SCHEDULER_SHARD_COUNT)).toBe(8);
      expect(Number(vars.CONTAINER_R2_ORPHAN_INVENTORY_SCAN_LIMIT)).toBe(4);
      expect(Number(vars.CONTAINER_TERMINAL_OUTBOX_SCAN_LIMIT)).toBe(4);
      expect(Number(vars.CONTAINER_R2_ORPHAN_INVENTORY_GRACE_SECONDS)).toBe(
        86400,
      );
      expect(vars.CONTAINER_R2_ORPHAN_INVENTORY_ENABLED).toBe("false");
      expect(vars.CONTAINER_TERMINAL_OUTBOX_ENABLED).toBe("false");
      expect(vars.CONTAINER_TERMINAL_OUTBOX_STAGING_VERIFIED).toBe("false");
      expect(vars.CONTAINER_RECONCILIATION_RETRY_APPLY_ENABLED).toBe("false");
      expect(operationGates.map((name) => vars[name])).toEqual([
        "false",
        "false",
        "false",
        "false",
        "false",
        "false",
        "false",
        "false",
        "false",
        "false",
        "false",
        "false",
      ]);
      expect(operationGates.some((name) => vars[name] === "true")).toBeFalse();
      expect(vars.CONTAINER_SCHEDULER_ROUTING_SECRET).toBeUndefined();
      expect(vars.CONTAINER_AUTHORITY_CURRENT_SECRET).toBeUndefined();
      expect(vars.CONTAINER_AUTHORITY_ISSUER).toBe(
        `cinatoken-edge-${authorityEnvironment}`,
      );
      expect(vars.CONTAINER_AUTHORITY_AUDIENCE).toBe(controllerService);
      expect(vars.CONTAINER_AUTHORITY_CURRENT_KID).toBe(
        `${authorityEnvironment}-v1`,
      );
      expect(scope?.services).toEqual([
        { binding: "CONTAINER_CONTROLLER", service: controllerService },
      ]);

      // Containers remain owned only by the isolated controller Worker.
      expect(scope?.containers).toBeUndefined();
    });
  }

  test("the full repository gate includes the scheduler config contract", () => {
    expect(packageJson.scripts["check:container-scheduler-config"]).toBe(
      "bun test tests/container-scheduler-config.test.mjs",
    );
    expect(packageJson.scripts.check).toContain(
      "bun run check:container-scheduler-config",
    );
  });
});
