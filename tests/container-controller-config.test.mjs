import { describe, expect, test } from "bun:test";

const rootConfig = Bun.TOML.parse(
  await Bun.file(new URL("../wrangler.toml", import.meta.url)).text(),
);
const packageJson = await Bun.file(new URL("../package.json", import.meta.url)).json();
const controllerSource = await Bun.file(
  new URL("../services/container-controller/src/index.ts", import.meta.url),
).text();
const storageGatewaySource = await Bun.file(
  new URL("../services/container-controller/src/storage_gateway.ts", import.meta.url),
).text();
const operationStatusSource = await Bun.file(
  new URL("../services/container-controller/src/operation_status.ts", import.meta.url),
).text();
const configFiles = [
  "wrangler.jsonc",
  "wrangler.staging.jsonc",
  "wrangler.production.jsonc",
];

describe("isolated container controller configuration", () => {
  for (const file of configFiles) {
    test(`${file} is private, default-off, and capacity-aligned`, async () => {
      const config = JSON.parse(
        await Bun.file(new URL(`../services/container-controller/${file}`, import.meta.url)).text(),
      );
      expect(config.workers_dev).toBe(false);
      expect(config.preview_urls).toBe(false);
      expect(config.routes).toBeUndefined();
      expect(config.vars.CONTAINER_CONTROLLER_ENABLED).toBe("false");
      expect(config.vars.CONTAINER_EXECUTION_ENABLED).toBe("false");
      expect(config.vars.CONTAINER_READINESS_PROBE_ENABLED).toBe("false");
      expect(config.vars.CONTAINER_READINESS_WAKE_ENABLED).toBe("false");
      expect(config.vars.CONTAINER_STORAGE_R2_READ_ENABLED).toBe("false");
      expect(config.vars.CONTAINER_STORAGE_R2_WRITE_ENABLED).toBe("false");
      expect(config.vars.CONTAINER_STORAGE_KV_READ_ENABLED).toBe("false");
      expect(config.vars.CONTAINER_STORAGE_D1_READ_ENABLED).toBe("false");
      expect(Number(config.vars.CONTAINER_TERMINAL_RETENTION_SECONDS)).toBeGreaterThanOrEqual(600);
      expect(Number(config.vars.CONTAINER_MAX_TERMINAL_OPERATIONS)).toBeGreaterThan(0);
      expect(config.vars.CONTAINER_AUTHORITY_CURRENT_SECRET).toBeUndefined();
      expect(config.vars.CONTAINER_AUTHORITY_PREVIOUS_SECRET).toBeUndefined();
      expect(config.d1_databases).toHaveLength(1);
      expect(config.d1_databases[0].binding).toBe("DB");
      expect(config.kv_namespaces).toHaveLength(1);
      expect(config.kv_namespaces[0].binding).toBe("CONFIG_KV");
      expect(config.r2_buckets).toHaveLength(1);
      expect(config.r2_buckets[0].binding).toBe("FILE_BUCKET");
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
  }

  test("main edge remains container-free until the controller is independently verified", () => {
    expect(rootConfig.containers).toBeUndefined();
    expect(packageJson.scripts["check:container-controller"]).toContain("container-controller");
    expect(packageJson.scripts.check).toContain("bun run check:container-controller");
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
    expect(storageGatewaySource).not.toMatch(/\.list\(|\.delete\(/);
    expect(storageGatewaySource).toContain("operation.operation_id = ?1");
    expect(storageGatewaySource).toContain("operation.owner_generation = ?2");
    expect(storageGatewaySource).toContain("reservation.owner_generation = ?2");
    expect(controllerSource.indexOf("await requireD1OperationAdmission(")).toBeGreaterThan(-1);
    expect(controllerSource.indexOf("await requireD1OperationAdmission(")).toBeLessThan(
      controllerSource.indexOf("const claim = this.ledger.claimOperation("),
    );
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
});
