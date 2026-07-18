import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";

import {
  recordShardActivation,
  shardActivationDigest,
  validateShardActivationInput,
  type ShardActivationInput,
} from "../src/shard_activation";

const BUILD_ID = "a".repeat(64);

function activation(
  overrides: Partial<ShardActivationInput> = {},
): ShardActivationInput {
  return {
    controllerVersionId: "controller-version-1",
    shard: {
      contract_version: 1,
      ring_generation: 7,
      shard_count: 8,
      shard_index: 3,
      instance_name: "cinatoken-relay-shard-v1-0003",
    },
    runtimeProtocolVersion: 1,
    runtimeContractVersion: 1,
    runtimeBuildId: BUILD_ID,
    activationGeneration: 1,
    activationProbeGeneration: 9,
    environment: "staging",
    containerStatus: "healthy",
    readinessResultCode: "process_ready_execution_disabled",
    processReady: true,
    runtimeExecutionEnabled: false,
    controllerExecutionEnabled: false,
    activatedAt: 1_900_000_000,
    ...overrides,
  };
}

class FakeActivationDatabase {
  migrationCount = 1;
  schemaOverrides: Record<string, number> = {};
  row: Record<string, unknown> | null = null;

  withSession() {
    return {
      prepare: (sql: string) => {
        let bindings: unknown[] = [];
        const statement = {
          bind: (...values: unknown[]) => {
            bindings = values;
            return statement;
          },
          first: async () => {
            if (sql.includes("sqlite_master")) {
              return {
                migration_count: this.migrationCount,
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
                ...this.schemaOverrides,
              };
            }
            return this.row === null ? null : { ...this.row };
          },
          run: async () => {
            if (!sql.startsWith("INSERT INTO relay_container_shard_activations")) {
              throw new Error("unexpected write");
            }
            if (this.row !== null) return { success: true, meta: { changes: 0 } };
            this.row = rowFromBindings(bindings);
            return { success: true, meta: { changes: 1 } };
          },
        };
        return statement;
      },
    };
  }
}

describe("relay Container shard activation ledger", () => {
  test("uses one deterministic cross-runtime digest", async () => {
    const value = activation();
    const first = await shardActivationDigest(value);
    const second = await shardActivationDigest(value);
    expect(first).toBe(second);
    expect(first).toBe(
      "dd807252bf5c7f04456c28f6daff983c63a5bc9557ce57cc872b91abb9293bdb",
    );
    expect(
      await shardActivationDigest(
        activation({ runtimeBuildId: "b".repeat(64) }),
      ),
    ).not.toBe(first);
  });

  test("accepts the exact 0054 schema through the real SQLite catalog", async () => {
    const migration = await readFile(
      new URL(
        "../../../migrations/d1/0054_relay_container_shard_activations.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const sqlite = new Database(":memory:");
    try {
      sqlite.exec(
        "CREATE TABLE d1_migrations (name TEXT NOT NULL); " +
          "INSERT INTO d1_migrations(name) VALUES " +
          "('0054_relay_container_shard_activations.sql');",
      );
      sqlite.exec(migration);
      const database = sqliteActivationDatabase(sqlite);
      expect(await recordShardActivation(database as never, activation())).toBe(
        "recorded",
      );
    } finally {
      sqlite.close();
    }
  });

  test("enforces the real 1024-shard ring and exact instance identity", () => {
    validateShardActivationInput(
      activation({
        shard: {
          contract_version: 1,
          ring_generation: 7,
          shard_count: 1024,
          shard_index: 1023,
          instance_name: "cinatoken-relay-shard-v1-1023",
        },
      }),
    );
    expect(() =>
      validateShardActivationInput(
        activation({
          shard: {
            contract_version: 1,
            ring_generation: 7,
            shard_count: 1025,
            shard_index: 1024,
            instance_name: "cinatoken-relay-shard-v1-1024",
          },
        }),
      ),
    ).toThrow("invalid_shard_activation");
    expect(() =>
      validateShardActivationInput(
        activation({
          shard: {
            ...activation().shard,
            instance_name: "cinatoken-relay-shard-v1-0004",
          },
        }),
      ),
    ).toThrow("invalid_shard_activation");
  });

  test("records once and accepts a later matching observation as duplicate", async () => {
    const database = new FakeActivationDatabase();
    expect(await recordShardActivation(database as never, activation())).toBe(
      "recorded",
    );
    expect(
      await recordShardActivation(
        database as never,
        activation({ activationProbeGeneration: 10, activatedAt: 1_900_000_060 }),
      ),
    ).toBe("duplicate");
    expect(database.row?.activation_id).toBe(41);
  });

  test("fails closed on candidate drift, schema drift, and digest corruption", async () => {
    const candidateDrift = new FakeActivationDatabase();
    await recordShardActivation(candidateDrift as never, activation());
    await expect(
      recordShardActivation(
        candidateDrift as never,
        activation({ runtimeProtocolVersion: 2 }),
      ),
    ).rejects.toMatchObject({ code: "shard_activation_conflict", status: 409 });

    const schemaDrift = new FakeActivationDatabase();
    schemaDrift.schemaOverrides.required_column_count = 19;
    await expect(
      recordShardActivation(schemaDrift as never, activation()),
    ).rejects.toMatchObject({
      code: "shard_activation_schema_unavailable",
      status: 503,
    });

    const rebuiltSchemaDrift = new FakeActivationDatabase();
    rebuiltSchemaDrift.schemaOverrides.immutable_trigger_count = 1;
    await expect(
      recordShardActivation(rebuiltSchemaDrift as never, activation()),
    ).rejects.toMatchObject({
      code: "shard_activation_schema_unavailable",
      status: 503,
    });

    const migrationDrift = new FakeActivationDatabase();
    migrationDrift.migrationCount = 0;
    await expect(
      recordShardActivation(migrationDrift as never, activation()),
    ).rejects.toMatchObject({
      code: "shard_activation_schema_unavailable",
      status: 503,
    });

    const digestDrift = new FakeActivationDatabase();
    await recordShardActivation(digestDrift as never, activation());
    digestDrift.row!.activation_digest_sha256 = "f".repeat(64);
    await expect(
      recordShardActivation(digestDrift as never, activation()),
    ).rejects.toMatchObject({
      code: "shard_activation_readback_invalid",
      status: 502,
    });
  });
});

function sqliteActivationDatabase(database: Database) {
  return {
    withSession: (bookmark: string) => {
      if (bookmark !== "first-primary") throw new Error("unexpected bookmark");
      return {
        prepare: (sql: string) => {
          let bindings: unknown[] = [];
          const statement = {
            bind: (...values: unknown[]) => {
              bindings = values;
              return statement;
            },
            first: async () =>
              database.query(sql).get(...bindings) as Record<string, unknown> | null,
            run: async () => {
              const result = database.query(sql).run(...bindings);
              return { success: true, meta: { changes: result.changes } };
            },
          };
          return statement;
        },
      };
    },
  };
}

function rowFromBindings(bindings: unknown[]): Record<string, unknown> {
  const [
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
    activated_at,
  ] = bindings;
  return {
    activation_id: 41,
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
    activated_at,
  };
}
