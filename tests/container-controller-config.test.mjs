import { describe, expect, test } from "bun:test";

const rootConfig = Bun.TOML.parse(
  await Bun.file(new URL("../wrangler.toml", import.meta.url)).text(),
);
const packageJson = await Bun.file(new URL("../package.json", import.meta.url)).json();
const platformGatewaySource = await Bun.file(
  new URL("../crates/worker/src/platform_gateway.rs", import.meta.url),
).text();
const controllerSource = await Bun.file(
  new URL("../services/container-controller/src/index.ts", import.meta.url),
).text();
const storageGatewaySource = await Bun.file(
  new URL("../services/container-controller/src/storage_gateway.ts", import.meta.url),
).text();
const operationStatusSource = await Bun.file(
  new URL("../services/container-controller/src/operation_status.ts", import.meta.url),
).text();
const terminalAckSource = await Bun.file(
  new URL("../services/container-controller/src/terminal_ack.ts", import.meta.url),
).text();
const controllerLedgerSource = await Bun.file(
  new URL("../services/container-controller/src/ledger.ts", import.meta.url),
).text();
const durableStateSource = await Bun.file(
  new URL(
    "../services/container-controller/src/relay_shard_durable_state.ts",
    import.meta.url,
  ),
).text();
const providerAttemptGatewaySource = await Bun.file(
  new URL("../services/container-controller/src/provider_attempt_gateway.ts", import.meta.url),
).text();
const providerEgressGatewaySource = await Bun.file(
  new URL("../services/container-controller/src/provider_egress_gateway.ts", import.meta.url),
).text();
const providerEgressSource = await Bun.file(
  new URL("../crates/container-egress/src/lib.rs", import.meta.url),
).text();
const providerEgressConfig = Bun.TOML.parse(
  await Bun.file(new URL("../crates/container-egress/wrangler.toml", import.meta.url)).text(),
);
const configFiles = [
  "wrangler.jsonc",
  "wrangler.staging.jsonc",
  "wrangler.production.jsonc",
];
const providerEgressTargets = {
  "wrangler.jsonc": "cinatoken-container-egress-local",
  "wrangler.staging.jsonc": "cinatoken-container-egress-staging",
  "wrangler.production.jsonc": "cinatoken-container-egress-production",
};
const controllerEnvironments = {
  "wrangler.jsonc": "local",
  "wrangler.staging.jsonc": "staging",
  "wrangler.production.jsonc": "production",
};
const rootEnvironmentForControllerConfig = {
  "wrangler.jsonc": rootConfig,
  "wrangler.staging.jsonc": rootConfig.env.staging,
  "wrangler.production.jsonc": rootConfig.env.production,
};

describe("isolated container controller configuration", () => {
  for (const file of configFiles) {
    test(`${file} is private, default-off, and capacity-aligned`, async () => {
      const config = JSON.parse(
        await Bun.file(new URL(`../services/container-controller/${file}`, import.meta.url)).text(),
      );
      expect(config.workers_dev).toBe(false);
      expect(config.preview_urls).toBe(false);
      expect(config.routes).toBeUndefined();
      expect(config.version_metadata).toEqual({ binding: "CF_VERSION_METADATA" });
      expect(config.vars.ENVIRONMENT).toBe(controllerEnvironments[file]);
      expect(config.vars.CONTAINER_CONTROLLER_ENABLED).toBe("false");
      expect(config.vars.CONTAINER_EXECUTION_ENABLED).toBe("false");
      expect(config.vars.CONTAINER_READINESS_PROBE_ENABLED).toBe("false");
      expect(config.vars.CONTAINER_READINESS_WAKE_ENABLED).toBe("false");
      expect(config.vars.CONTAINER_STORAGE_R2_READ_ENABLED).toBe("false");
      expect(config.vars.CONTAINER_STORAGE_R2_WRITE_ENABLED).toBe("false");
      expect(config.vars.CONTAINER_STORAGE_KV_READ_ENABLED).toBe("false");
      expect(config.vars.CONTAINER_STORAGE_D1_READ_ENABLED).toBe("false");
      expect(config.vars.CONTAINER_PROVIDER_ATTEMPT_JOURNAL_ENABLED).toBe("false");
      expect(config.vars.CONTAINER_PROVIDER_CLIENT_ENABLED).toBe("false");
      expect(config.vars.CONTAINER_PROVIDER_EGRESS_ENABLED).toBe("false");
      expect(config.vars.CONTAINER_PROVIDER_RESPONSE_V3_PARSE_ENABLED).toBe("false");
      expect(config.vars.CONTAINER_PROVIDER_RESPONSE_RAW_WRITE_ENABLED).toBe("false");
      expect(config.vars.CONTAINER_PROVIDER_RESPONSE_CLIENT_WRITE_ENABLED).toBe("false");
      expect(config.vars.CONTAINER_PROVIDER_RESPONSE_TERMINAL_ENABLED).toBe("false");
      expect(config.vars.CONTAINER_PROVIDER_RETRY_ENABLED).toBe("false");
      expect(config.vars.CONTAINER_PROVIDER_ATTEMPT_STAGING_VERIFIED).toBe("false");
      expect(config.vars.CONTAINER_GLOBAL_TERMINAL_ACK_ENABLED).toBe("false");
      expect(config.vars.CONTAINER_GLOBAL_TERMINAL_COMPACTION_ENABLED).toBe("false");
      expect(config.vars.CONTAINER_OPERATION_RECOVERY_INTENT_V1_ENABLED).toBe("false");
      expect(
        config.vars.CONTAINER_OPERATION_RECOVERY_INTENT_V1_STAGING_VERIFIED,
      ).toBe("false");
      expect(config.vars.CONTAINER_SHARD_ACTIVATION_WRITE_ENABLED).toBe("false");
      expect(
        config.vars.CONTAINER_SHARD_ACTIVATION_EXPECTED_RUNTIME_BUILD_ID,
      ).toBe("");
      expect(config.vars.CONTAINER_MAX_PROVIDER_ATTEMPTS).toBe("1");
      expect(Number(config.vars.CONTAINER_TERMINAL_RETENTION_SECONDS)).toBeGreaterThanOrEqual(600);
      expect(Number(config.vars.CONTAINER_MAX_TERMINAL_OPERATIONS)).toBeGreaterThan(0);
      expect(config.vars.CONTAINER_PREVIOUS_RING_GENERATION).toBe("0");
      expect(config.vars.CONTAINER_PREVIOUS_SHARD_COUNT).toBe("0");
      expect(config.vars.CONTAINER_PREVIOUS_RING_ADMISSION_STARTED_AT).toBe("0");
      expect(config.vars.CONTAINER_PREVIOUS_RING_ADMISSION_UNTIL).toBe("0");
      expect(config.vars.CONTAINER_AUTHORITY_CURRENT_SECRET).toBeUndefined();
      expect(config.vars.CONTAINER_AUTHORITY_PREVIOUS_SECRET).toBeUndefined();
      expect(config.d1_databases).toHaveLength(1);
      expect(config.d1_databases[0].binding).toBe("DB");
      expect(config.kv_namespaces).toHaveLength(1);
      expect(config.kv_namespaces[0].binding).toBe("CONFIG_KV");
      expect(config.r2_buckets).toHaveLength(1);
      expect(config.r2_buckets[0].binding).toBe("FILE_BUCKET");
      expect(config.services).toEqual([
        {
          binding: "PROVIDER_EGRESS",
          service: providerEgressTargets[file],
        },
      ]);
      expect(config.durable_objects.bindings).toEqual([
        { name: "RELAY_SHARDS", class_name: "RelayShardContainer" },
      ]);
      expect(config.migrations[0].new_sqlite_classes).toEqual(["RelayShardContainer"]);
      expect(config.containers[0]).toMatchObject({
        class_name: "RelayShardContainer",
        max_instances: Number(config.vars.CONTAINER_SHARD_COUNT),
        instance_type: "lite",
        rollout_step_percentage: [10, 100],
        ssh: { enabled: false },
      });
    });

    test(`${file} shares exact edge resource identities`, async () => {
      const config = JSON.parse(
        await Bun.file(new URL(`../services/container-controller/${file}`, import.meta.url)).text(),
      );
      const edge = rootEnvironmentForControllerConfig[file];
      expect(edge.services.find((item) => item.binding === "CONTAINER_CONTROLLER")).toEqual({
        binding: "CONTAINER_CONTROLLER",
        service: config.name,
      });
      expect(config.d1_databases).toEqual([
        {
          binding: "DB",
          database_name: edge.d1_databases.find((item) => item.binding === "DB").database_name,
          database_id: edge.d1_databases.find((item) => item.binding === "DB").database_id,
        },
      ]);
      expect(config.kv_namespaces).toEqual([
        edge.kv_namespaces.find((item) => item.binding === "CONFIG_KV"),
      ]);
      expect(config.r2_buckets).toEqual([
        edge.r2_buckets.find((item) => item.binding === "FILE_BUCKET"),
      ]);
    });
  }

  test("main edge remains container-free until the controller is independently verified", () => {
    expect(rootConfig.containers).toBeUndefined();
    expect(packageJson.scripts["check:container-controller"]).toContain("container-controller");
    expect(packageJson.scripts.check).toContain("bun run check:container-controller");
  });

  test("edge and controller deployment identities are operator-visible", () => {
    for (const edge of [rootConfig, rootConfig.env.staging, rootConfig.env.production]) {
      expect(edge.version_metadata).toEqual({ binding: "CF_VERSION_METADATA" });
    }
    expect(platformGatewaySource).toContain("WorkerVersionMetadata");
    expect(platformGatewaySource).toContain(
      '.get_binding::<WorkerVersionMetadata>("CF_VERSION_METADATA")',
    );
    expect(platformGatewaySource).toContain("edge_worker_version_id");
    expect(platformGatewaySource).toContain("container_scheduler_controller_version_id");
    expect(platformGatewaySource).toContain(
      "container_scheduler_controller_action_gate_inventory_sha256",
    );
  });

  test("operation recovery v1 is durable, rollback-readable, and double-gated", () => {
    expect(controllerSource).toContain(
      'env.CONTAINER_OPERATION_RECOVERY_INTENT_V1_ENABLED === "true"',
    );
    expect(controllerSource).toContain(
      'env.CONTAINER_OPERATION_RECOVERY_INTENT_V1_STAGING_VERIFIED === "true"',
    );
    expect(controllerSource).toContain(
      'throw new ProtocolError("operation_recovery_intent_v1_disabled", 503)',
    );
    expect(controllerSource).toContain(
      'return jsonError("operation_recovery_intent_v1_disabled", 503)',
    );
    expect(controllerSource).not.toContain(
      'deadline_at: verified.envelope.execution_deadline_at',
    );
    expect(controllerSource).toContain("ctx.blockConcurrencyWhile(async () => {");
    expect(controllerSource).toContain("await this.rearmPendingOperationRecoveryIntents();");
    expect(controllerSource).toContain(
      'this.ctx.abort("operation recovery retry persistence failed")',
    );
    expect(controllerSource).toContain(
      'this.ctx.abort("legacy operation recovery persistence failed")',
    );
    expect(controllerSource).toContain("parseOperationRecoverySchedule(payload)");
    expect(controllerLedgerSource).toContain("cinatoken_shard_schema_migrations");
    expect(controllerLedgerSource).toContain("cinatoken_shard_alarm_intents");
    expect(controllerLedgerSource).toContain("persistRecoveryIntentV1 = false");
    expect(controllerLedgerSource).toContain("this.ensureOperationRecoveryIntentRow(operation, now)");
    expect(durableStateSource).toContain("LegacyOperationRecoverySchedule");
    expect(durableStateSource).toContain("RELAY_SHARD_ALARM_MAX_DELIVERIES = 8");
    expect(durableStateSource).not.toMatch(/D1Database|R2Bucket|fetch\(/);
  });

  test("container storage uses named outbound handlers and never exposes generic binding CRUD", () => {
    expect(controllerSource).toContain("RelayShardContainer.outboundByHost");
    for (const host of [
      "r2-input.cinatoken.internal",
      "r2-result.cinatoken.internal",
      "kv-config.cinatoken.internal",
      "d1-admission.cinatoken.internal",
    ]) {
      expect(controllerSource).toContain(host.split(".")[0].replaceAll("-", "_").toUpperCase());
      expect(storageGatewaySource).toContain(`\"${host}\"`);
    }
    expect(controllerSource).toContain("PROVIDER_EGRESS_HOST");
    expect(providerEgressGatewaySource).toContain('"provider-egress.cinatoken.internal"');
    expect(storageGatewaySource).not.toMatch(/\.list\(|\.delete\(/);
    expect(storageGatewaySource).toContain("operation.operation_id = ?1");
    expect(storageGatewaySource).toContain("operation.owner_generation = ?2");
    expect(storageGatewaySource).toContain("reservation.owner_generation = ?2");
    expect(controllerSource.indexOf("await requireD1OperationAdmission(")).toBeGreaterThan(-1);
    expect(controllerSource.indexOf("await requireD1OperationAdmission(")).toBeLessThan(
      controllerSource.indexOf("const claim = this.ledger.claimOperation("),
    );
    expect(controllerSource).toContain("PROVIDER_ATTEMPT_HOST");
    expect(controllerSource).toContain("PROVIDER_EGRESS_HOST");
    expect(providerAttemptGatewaySource).toContain('"provider-attempt.cinatoken.internal"');
    expect(providerAttemptGatewaySource).not.toContain("prepareProviderAttempt(");
    expect(controllerSource).toContain("if (retryEnabled || maxAttempts !== 1)");
  });

  test("provider egress is a private default-off fixed-profile service", () => {
    expect(providerEgressConfig.workers_dev).toBe(false);
    expect(providerEgressConfig.preview_urls).toBe(false);
    expect(providerEgressConfig.routes).toBeUndefined();
    expect(providerEgressConfig.vars.CINATOKEN_CONTAINER_PROVIDER_EGRESS_ENABLED).toBe("false");
    expect(providerEgressConfig.vars.CINATOKEN_CONTAINER_PROVIDER_MODEL).toBe("");
    expect(providerEgressConfig.env.staging.name).toBe("cinatoken-container-egress-staging");
    expect(providerEgressConfig.env.production.name).toBe("cinatoken-container-egress-production");
    expect(providerEgressConfig.version_metadata).toEqual({ binding: "CF_VERSION_METADATA" });
    expect(providerEgressConfig.env.staging.version_metadata).toEqual({
      binding: "CF_VERSION_METADATA",
    });
    expect(providerEgressConfig.env.production.version_metadata).toEqual({
      binding: "CF_VERSION_METADATA",
    });
    expect(providerEgressGatewaySource).toContain("requireD1ProviderEgressAdmission");
    expect(providerEgressGatewaySource).toContain("requireProviderEgressReadiness");
    expect(providerEgressGatewaySource).toContain("dispatchProviderAttemptV2");
    const dispatchCall = providerEgressGatewaySource.indexOf(
      "dispatch = await port.dispatchProviderAttemptV2(",
    );
    const admissionCall = providerEgressGatewaySource.indexOf(
      "await requireD1ProviderEgressAdmission(env, grant);",
    );
    const readinessCall = providerEgressGatewaySource.indexOf(
      "egressIdentity = await requireProviderEgressReadiness(",
    );
    expect(dispatchCall).toBeGreaterThan(-1);
    expect(admissionCall).toBeGreaterThan(-1);
    expect(readinessCall).toBeGreaterThan(-1);
    expect(admissionCall).toBeLessThan(readinessCall);
    expect(readinessCall).toBeLessThan(dispatchCall);
    expect(providerEgressGatewaySource).toContain("cloudflare-workers-version-key");
    expect(providerEgressGatewaySource).toContain("provider_egress_version_ambiguous");
    expect(providerEgressSource).toContain('const API_KEY_ENV: &str = "CINATOKEN_CONTAINER_PROVIDER_API_KEY"');
    expect(providerEgressSource).toContain('pub const UPSTREAM_HOST: &str = "api.openai.com"');
    expect(providerEgressSource).toContain('pub const UPSTREAM_PATH: &str = "/v1/chat/completions"');
    expect(providerEgressSource).toContain(
      'pub const INTERNAL_EGRESS_READINESS_PATH: &str = "/internal/v1/provider-egress/readiness"',
    );
    expect(providerEgressSource).toContain('const VERSION_METADATA_ENV: &str = "CF_VERSION_METADATA"');
    expect(providerEgressSource).not.toMatch(/BASE_URL_ENV|UPSTREAM_URL_ENV|env\.secret\([^A]/);
    expect(packageJson.scripts["check:container-egress"]).toContain("wasm32-unknown-unknown");
  });

  test("operation status is routed through a ledger-only RPC", () => {
    const statusBranch = controllerSource.indexOf(
      "if (path === INTERNAL_OPERATION_STATUS_PATH)",
    );
    expect(statusBranch).toBeGreaterThan(-1);
    expect(statusBranch).toBeLessThan(
      controllerSource.indexOf("if (path !== INTERNAL_OPERATION_PATH)"),
    );
    expect(operationStatusSource).toContain("stub.readOperationStatus(verified.query)");
    expect(operationStatusSource).not.toMatch(
      /containerFetch|requireD1OperationAdmission|claimOperation|\.schedule\(|wake_container/,
    );
  });

  test("terminal ack is routed through a default-off non-compacting ledger RPC", () => {
    expect(controllerSource).toContain("if (path === INTERNAL_OPERATION_TERMINAL_ACK_PATH)");
    expect(controllerSource).toContain("return handleTerminalAckRequest(request, env)");
    expect(terminalAckSource).toContain("stub.acknowledgeGlobalTerminal(verified.ack)");
    expect(terminalAckSource).toContain('"cache-control": "no-store"');
    expect(terminalAckSource).not.toMatch(/containerFetch|requireD1OperationAdmission|\.schedule\(/);
    expect(controllerLedgerSource).toContain("cinatoken_shard_terminal_acks");
    expect(controllerLedgerSource).toContain(
      "if (!policy.globalTerminalCompactionEnabled) return",
    );
    expect(controllerLedgerSource).toContain("ack.compaction_authorized_at IS NOT NULL");
    expect(controllerLedgerSource).not.toMatch(
      /SET[\s\S]{0,200}compaction_authorized_at\s*=/,
    );
  });
});
