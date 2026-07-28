import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";

import fixture from "../../../tests/fixtures/container-shard-placement-attestation-v1.json";
import { ProtocolError } from "../src/protocol";
import type { ShardActivationCampaignClaim } from "../src/shard_activation_campaign";
import {
  RELAY_SHARD_DURABLE_OBJECT_CLASS,
  RELAY_SHARD_NAMESPACE_BINDING,
  SHARD_PLACEMENT_ATTESTATION_CONTRACT,
  SHARD_PLACEMENT_ATTESTATION_DIGEST_DOMAIN,
  createShardPlacementAttestationV1,
  parseShardPlacementAttestationV1,
  shardPlacementAttestationDigest,
  shardPlacementAttestationWriterPolicy,
  verifyShardPlacementAttestationRpcV1,
  type CreateShardPlacementAttestationV1Input,
  type ShardPlacementAttestationV1,
  type VerifiedShardPlacementAttestationV1,
} from "../src/shard_placement_attestation";
import {
  recordShardPlacementAttestation,
  requireShardPlacementMutationAuthorization,
} from "../src/shard_placement_ledger";

const input = fixture.input as CreateShardPlacementAttestationV1Input;
const expected = fixture.attestation as ShardPlacementAttestationV1;
const CAMPAIGN_ID = "3".repeat(64);
const CLAIM_DIGEST_SHA256 = "4".repeat(64);
const READINESS_RESULT_SHA256 = "5".repeat(64);
const placementMigration = await readFile(
  new URL(
    "../../../migrations/d1/0061_relay_container_shard_placement_attestations.sql",
    import.meta.url,
  ),
  "utf8",
);
const placementEventMigration = await readFile(
  new URL(
    "../../../migrations/d1/0062_relay_container_shard_placement_events.sql",
    import.meta.url,
  ),
  "utf8",
);
const placementAuthorizationMigration = await readFile(
  new URL(
    "../../../migrations/d1/0063_relay_container_shard_placement_mutation_authorizations.sql",
    import.meta.url,
  ),
  "utf8",
);

async function expectInvalid(value: unknown): Promise<void> {
  try {
    await parseShardPlacementAttestationV1(value);
    throw new Error("expected ProtocolError");
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe(
      "invalid_shard_placement_attestation",
    );
    expect((error as ProtocolError).status).toBe(400);
  }
}

function expectProtocolError(
  callback: () => unknown,
  code: string,
  status: number,
): void {
  try {
    callback();
    throw new Error("expected ProtocolError");
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe(code);
    expect((error as ProtocolError).status).toBe(status);
  }
}

describe("relay shard placement attestation v1", () => {
  test("matches the frozen cross-language fixture", async () => {
    expect(fixture.contract).toBe(SHARD_PLACEMENT_ATTESTATION_CONTRACT);
    expect(fixture.digest_domain).toBe(
      SHARD_PLACEMENT_ATTESTATION_DIGEST_DOMAIN,
    );
    const attestation = await createShardPlacementAttestationV1(input);
    expect(attestation).toEqual(expected);
    expect(JSON.stringify(attestation)).toBe(fixture.canonical_json);
    expect(await shardPlacementAttestationDigest(attestation)).toBe(
      fixture.attestation_digest_sha256,
    );
    expect(await parseShardPlacementAttestationV1(attestation)).toEqual(
      attestation,
    );
  });

  test("derives identifiers without retaining the raw Durable Object ID", async () => {
    const attestation = await createShardPlacementAttestationV1(input);
    expect(attestation.object_id_sha256).toHaveLength(64);
    expect(JSON.stringify(attestation)).not.toContain(input.durableObjectId);
    expect(attestation.durable_object_namespace_binding).toBe(
      RELAY_SHARD_NAMESPACE_BINDING,
    );
    expect(attestation.durable_object_class).toBe(
      RELAY_SHARD_DURABLE_OBJECT_CLASS,
    );
  });

  test("expresses every supported jurisdiction with a distinct digest", async () => {
    const digests = new Set<string>();
    for (const jurisdiction of [
      "default",
      "eu",
      "us",
      "fedramp",
      "fedramp-high",
    ] as const) {
      const attestation = await createShardPlacementAttestationV1({
        ...input,
        jurisdiction,
      });
      expect(attestation.jurisdiction).toBe(jurisdiction);
      digests.add(await shardPlacementAttestationDigest(attestation));
    }
    expect(digests.size).toBe(5);
  });

  test("rejects unknown fields and identity drift", async () => {
    await expectInvalid({ ...expected, unexpected: true });
    await expectInvalid({
      ...expected,
      canonical_name_sha256: "0".repeat(64),
    });
    await expectInvalid({
      ...expected,
      shard: { ...expected.shard, instance_name: "cinatoken-relay-shard-v1-3" },
    });
    await expectInvalid({
      ...expected,
      controller_service_name: "Cinatoken Controller",
    });
  });

  test("requires an exact default-off two-gate writer policy", () => {
    expect(
      shardPlacementAttestationWriterPolicy({
        CONTAINER_SHARD_PLACEMENT_ATTESTATION_WRITE_ENABLED: "false",
        CONTAINER_SHARD_PLACEMENT_ATTESTATION_STAGING_VERIFIED: "false",
      }),
    ).toEqual({ enabled: false, staging_verified: false });
    expect(
      shardPlacementAttestationWriterPolicy({
        CONTAINER_SHARD_PLACEMENT_ATTESTATION_WRITE_ENABLED: "true",
        CONTAINER_SHARD_PLACEMENT_ATTESTATION_STAGING_VERIFIED: "true",
      }),
    ).toEqual({ enabled: true, staging_verified: true });
    expectProtocolError(
      () =>
        shardPlacementAttestationWriterPolicy({
          CONTAINER_SHARD_PLACEMENT_ATTESTATION_WRITE_ENABLED: "true",
          CONTAINER_SHARD_PLACEMENT_ATTESTATION_STAGING_VERIFIED: "false",
        }),
      "shard_placement_attestation_gate_mismatch",
      503,
    );
    expectProtocolError(
      () =>
        shardPlacementAttestationWriterPolicy({
          CONTAINER_SHARD_PLACEMENT_ATTESTATION_WRITE_ENABLED: "1",
          CONTAINER_SHARD_PLACEMENT_ATTESTATION_STAGING_VERIFIED: "false",
        }),
      "shard_placement_attestation_gate_invalid",
      503,
    );
  });

  test("requires the object RPC identity to equal the independently selected stub", async () => {
    const verified = await verifiedAttestation();
    expect(verified.attestation).toEqual(expected);
    expect(verified.attestationDigestSha256).toBe(
      fixture.attestation_digest_sha256,
    );

    const different = await createShardPlacementAttestationV1({
      ...input,
      durableObjectId: "f".repeat(64),
    });
    await expect(
      verifyShardPlacementAttestationRpcV1(
        {
          ok: true,
          attestation: different,
          attestation_digest_sha256:
            await shardPlacementAttestationDigest(different),
        },
        input,
      ),
    ).rejects.toMatchObject({
      code: "shard_placement_attestation_mismatch",
      status: 502,
    });
    await expect(
      verifyShardPlacementAttestationRpcV1(
        {
          ok: true,
          attestation: expected,
          attestation_digest_sha256: "0".repeat(64),
        },
        input,
      ),
    ).rejects.toMatchObject({
      code: "shard_placement_attestation_mismatch",
      status: 502,
    });
    await expect(
      verifyShardPlacementAttestationRpcV1(
        {
          ok: true,
          attestation: expected,
          attestation_digest_sha256: fixture.attestation_digest_sha256,
          unexpected: true,
        },
        input,
      ),
    ).rejects.toMatchObject({
      code: "shard_placement_attestation_rpc_invalid",
      status: 502,
    });
  });

  test("appends and exactly replays the same 0061/0062 evidence pair", async () => {
    const fixtureDatabase = placementDatabase();
    try {
      const verified = await verifiedAttestation();
      const first = await recordShardPlacementAttestation(
        fixtureDatabase.database as never,
        placementClaim(),
        READINESS_RESULT_SHA256,
        verified,
      );
      expect(first).toMatchObject({
        placementEventSequence: 1,
        activationId: 1,
        activationDigestSha256: "2".repeat(64),
        consumptionDigestSha256: "6".repeat(64),
        duplicate: false,
      });
      expect(first.recordedAt).toBeGreaterThan(0);

      const replay = await recordShardPlacementAttestation(
        fixtureDatabase.database as never,
        placementClaim(),
        READINESS_RESULT_SHA256,
        verified,
      );
      expect(replay).toEqual({ ...first, duplicate: true });
      expect(
        fixtureDatabase.sqlite
          .query(
            "SELECT COUNT(*) AS count FROM relay_container_shard_placement_attestations",
          )
          .get(),
      ).toEqual({ count: 1 });
      expect(
        fixtureDatabase.sqlite
          .query(
            "SELECT COUNT(*) AS count FROM relay_container_shard_placement_events",
          )
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      fixtureDatabase.sqlite.close();
    }
  });

  test("requires the exact active authorization before a shard wake", async () => {
    const authorized = placementDatabase();
    try {
      await expect(
        requireShardPlacementMutationAuthorization(
          authorized.database as never,
          placementAuthorizationCandidate(),
        ),
      ).resolves.toBeUndefined();
      await expect(
        requireShardPlacementMutationAuthorization(
          authorized.database as never,
          {
            ...placementAuthorizationCandidate(),
            controllerVersionId: "controller-version-drift",
          },
        ),
      ).rejects.toMatchObject({
        code: "shard_placement_mutation_authorization_required",
        status: 403,
      });
    } finally {
      authorized.sqlite.close();
    }

    const missing = placementDatabase({ includeAuthorization: false });
    try {
      await expect(
        requireShardPlacementMutationAuthorization(
          missing.database as never,
          placementAuthorizationCandidate(),
        ),
      ).rejects.toMatchObject({
        code: "shard_placement_mutation_authorization_required",
        status: 403,
      });
    } finally {
      missing.sqlite.close();
    }
  });

  test("fails closed on missing activation, schema drift, and placement conflict", async () => {
    const missing = placementDatabase({ includeParents: false });
    try {
      await expect(
        recordShardPlacementAttestation(
          missing.database as never,
          placementClaim(),
          READINESS_RESULT_SHA256,
          await verifiedAttestation(),
        ),
      ).rejects.toMatchObject({
        code: "shard_placement_attestation_activation_missing",
        status: 409,
      });
    } finally {
      missing.sqlite.close();
    }

    const schemaDrift = placementDatabase();
    try {
      schemaDrift.sqlite.exec(
        "DELETE FROM d1_migrations WHERE name = '0061_relay_container_shard_placement_attestations.sql'",
      );
      await expect(
        recordShardPlacementAttestation(
          schemaDrift.database as never,
          placementClaim(),
          READINESS_RESULT_SHA256,
          await verifiedAttestation(),
        ),
      ).rejects.toMatchObject({
        code: "shard_placement_attestation_schema_unavailable",
        status: 503,
      });
    } finally {
      schemaDrift.sqlite.close();
    }

    const extraSchema = placementDatabase();
    try {
      extraSchema.sqlite.exec(
        `CREATE INDEX unexpected_shard_placement_index
         ON relay_container_shard_placement_attestations(recorded_at)`,
      );
      await expect(
        recordShardPlacementAttestation(
          extraSchema.database as never,
          placementClaim(),
          READINESS_RESULT_SHA256,
          await verifiedAttestation(),
        ),
      ).rejects.toMatchObject({
        code: "shard_placement_attestation_schema_unavailable",
        status: 503,
      });
    } finally {
      extraSchema.sqlite.close();
    }

    const conflict = placementDatabase();
    try {
      await recordShardPlacementAttestation(
        conflict.database as never,
        placementClaim(),
        READINESS_RESULT_SHA256,
        await verifiedAttestation(),
      );
      const changedInput = {
        ...input,
        durableObjectId: "f".repeat(64),
      };
      const changedAttestation =
        await createShardPlacementAttestationV1(changedInput);
      const changed = await verifyShardPlacementAttestationRpcV1(
        {
          ok: true,
          attestation: changedAttestation,
          attestation_digest_sha256:
            await shardPlacementAttestationDigest(changedAttestation),
        },
        changedInput,
      );
      await expect(
        recordShardPlacementAttestation(
          conflict.database as never,
          placementClaim(),
          READINESS_RESULT_SHA256,
          changed,
        ),
      ).rejects.toMatchObject({
        code: "shard_placement_attestation_conflict",
        status: 409,
      });
    } finally {
      conflict.sqlite.close();
    }
  });

  test("classifies an inserted but unreadable row as invalid readback", async () => {
    const unreadable = placementDatabase({ hidePlacementReadback: true });
    try {
      await expect(
        recordShardPlacementAttestation(
          unreadable.database as never,
          placementClaim(),
          READINESS_RESULT_SHA256,
          await verifiedAttestation(),
        ),
      ).rejects.toMatchObject({
        code: "shard_placement_attestation_readback_invalid",
        status: 502,
      });
      expect(
        unreadable.sqlite
          .query(
            "SELECT COUNT(*) AS count FROM relay_container_shard_placement_attestations",
          )
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      unreadable.sqlite.close();
    }
  });
});

async function verifiedAttestation(): Promise<VerifiedShardPlacementAttestationV1> {
  const attestation = await createShardPlacementAttestationV1(input);
  return verifyShardPlacementAttestationRpcV1(
    {
      ok: true,
      attestation,
      attestation_digest_sha256:
        await shardPlacementAttestationDigest(attestation),
    },
    input,
  );
}

function placementClaim(): ShardActivationCampaignClaim {
  return {
    campaignId: CAMPAIGN_ID,
    campaignDigestSha256: "7".repeat(64),
    claimDigestSha256: CLAIM_DIGEST_SHA256,
    controllerVersionId: input.controllerVersionId,
    actionGateInventorySha256: "8".repeat(64),
    actionGateCount: 22,
    foundationManifestSha256: "9".repeat(64),
    runtimeBuildId: "1".repeat(64),
    shard: input.shard,
    runtimeProtocolVersion: 1,
    runtimeContractVersion: 1,
    activationGeneration: 1,
    probeId: "a".repeat(64),
    environment: "staging",
    claimedAt: 1_900_000_000,
    recovered: false,
  };
}

function placementAuthorizationCandidate() {
  return {
    campaignId: CAMPAIGN_ID,
    controllerVersionId: input.controllerVersionId,
    actionGateInventorySha256: "8".repeat(64),
    ringGeneration: 7,
    shardCount: 32,
    environment: "staging",
  };
}

function placementDatabase({
  includeParents = true,
  includeAuthorization = true,
  hidePlacementReadback = false,
}: {
  includeParents?: boolean;
  includeAuthorization?: boolean;
  hidePlacementReadback?: boolean;
} = {}) {
  const sqlite = new Database(":memory:", { strict: true });
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE d1_migrations (name TEXT NOT NULL);
    INSERT INTO d1_migrations(name)
    VALUES ('0061_relay_container_shard_placement_attestations.sql'),
           ('0062_relay_container_shard_placement_events.sql'),
           ('0063_relay_container_shard_placement_mutation_authorizations.sql');
    CREATE TABLE relay_container_shard_activation_campaigns (
      campaign_id TEXT PRIMARY KEY,
      campaign_nonce_sha256 TEXT NOT NULL,
      controller_version_id TEXT NOT NULL,
      action_gate_inventory_sha256 TEXT NOT NULL,
      action_gate_count INTEGER NOT NULL,
      all_action_gates_false INTEGER NOT NULL,
      foundation_manifest_sha256 TEXT NOT NULL,
      runtime_build_id TEXT NOT NULL,
      ring_generation INTEGER NOT NULL,
      shard_count INTEGER NOT NULL,
      shard_contract_version INTEGER NOT NULL,
      environment TEXT NOT NULL,
      created_by_admin_id INTEGER NOT NULL,
      campaign_digest_sha256 TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE relay_container_shard_activation_campaign_seals (
      campaign_id TEXT PRIMARY KEY
    );
    CREATE TABLE relay_container_shard_activations (
      activation_id INTEGER PRIMARY KEY,
      controller_version_id TEXT NOT NULL,
      runtime_build_id TEXT NOT NULL,
      ring_generation INTEGER NOT NULL,
      shard_index INTEGER NOT NULL,
      activation_digest_sha256 TEXT NOT NULL
    );
    CREATE TABLE relay_container_shard_activation_campaign_consumptions (
      campaign_id TEXT NOT NULL,
      shard_index INTEGER NOT NULL,
      claim_digest_sha256 TEXT NOT NULL,
      readiness_result_sha256 TEXT NOT NULL,
      activation_digest_sha256 TEXT NOT NULL,
      consumption_digest_sha256 TEXT NOT NULL,
      environment TEXT NOT NULL,
      controller_version_id TEXT NOT NULL,
      shard_contract_version INTEGER NOT NULL,
      ring_generation INTEGER NOT NULL,
      shard_count INTEGER NOT NULL,
      instance_name TEXT NOT NULL,
      runtime_build_id TEXT NOT NULL,
      PRIMARY KEY (campaign_id, shard_index)
    ) WITHOUT ROWID;
  `);
  sqlite.exec(placementMigration);
  sqlite.exec(placementEventMigration);
  sqlite.exec(placementAuthorizationMigration);
  if (includeAuthorization) {
    insertPlacementAuthorization(sqlite);
  }
  if (includeParents) {
    sqlite
      .query(
        `INSERT INTO relay_container_shard_activations (
           activation_id, controller_version_id, runtime_build_id,
           ring_generation, shard_index, activation_digest_sha256
         ) VALUES (1, ?, ?, 7, 3, ?)`,
      )
      .run(input.controllerVersionId, "1".repeat(64), "2".repeat(64));
    sqlite
      .query(
        `INSERT INTO relay_container_shard_activation_campaign_consumptions (
           campaign_id, shard_index, claim_digest_sha256,
           readiness_result_sha256, activation_digest_sha256,
           consumption_digest_sha256, environment, controller_version_id,
           shard_contract_version, ring_generation, shard_count,
           instance_name, runtime_build_id
         ) VALUES (?, 3, ?, ?, ?, ?, 'staging', ?, 1, 7, 32, ?, ?)`,
      )
      .run(
        CAMPAIGN_ID,
        CLAIM_DIGEST_SHA256,
        READINESS_RESULT_SHA256,
        "2".repeat(64),
        "6".repeat(64),
        input.controllerVersionId,
        input.shard.instance_name,
        "1".repeat(64),
      );
  }
  return {
    sqlite,
    database: sqliteD1Database(sqlite, { hidePlacementReadback }),
  };
}

function insertPlacementAuthorization(sqlite: Database): void {
  const now = Math.floor(Date.now() / 1000);
  sqlite.transaction(() => {
    sqlite
      .query(
        `INSERT INTO relay_container_shard_placement_mutation_authorizations (
           authorization_id_sha256, execution_nonce_sha256,
           campaign_nonce_sha256, subject_digest_sha256, contract_version,
           authorization_contract, issuer, key_id, signer_spki_sha256,
           environment, controller_service_name, controller_version_id,
           action_gate_inventory_sha256, foundation_manifest_sha256,
           runtime_build_id, ring_generation, shard_count,
           campaign_lifetime_seconds, permit_issued_at, permit_expires_at,
           campaign_id, campaign_digest_sha256, campaign_expires_at,
           consumed_by_admin_id
         ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, 'staging', ?, ?, ?, ?, ?,
                   7, 32, 600, ?, ?, ?, ?, ?, 42)`,
      )
      .run(
        "a".repeat(64),
        "b".repeat(64),
        "c".repeat(64),
        "d".repeat(64),
        "cinatoken-relay-shard-placement-mutation-authorization-v1",
        "placement-authority-staging",
        "placement-v1",
        "e".repeat(64),
        "cinatoken-container-controller-staging",
        input.controllerVersionId,
        "8".repeat(64),
        "9".repeat(64),
        "1".repeat(64),
        now,
        now + 300,
        CAMPAIGN_ID,
        "7".repeat(64),
        now + 600,
      );
    sqlite
      .query(
        `INSERT INTO relay_container_shard_activation_campaigns (
           campaign_id, campaign_nonce_sha256, controller_version_id,
           action_gate_inventory_sha256, action_gate_count,
           all_action_gates_false, foundation_manifest_sha256,
           runtime_build_id, ring_generation, shard_count,
           shard_contract_version, environment, created_by_admin_id,
           campaign_digest_sha256, created_at, expires_at
         ) VALUES (?, ?, ?, ?, 22, 1, ?, ?, 7, 32, 1, 'staging', 42, ?, ?, ?)`,
      )
      .run(
        CAMPAIGN_ID,
        "c".repeat(64),
        input.controllerVersionId,
        "8".repeat(64),
        "9".repeat(64),
        "1".repeat(64),
        "7".repeat(64),
        now,
        now + 600,
      );
  })();
}

function sqliteD1Database(
  database: Database,
  { hidePlacementReadback = false } = {},
) {
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
            first: async () => {
              if (
                hidePlacementReadback &&
                sql.includes(
                  "FROM relay_container_shard_placement_attestations AS placement",
                )
              ) {
                return null;
              }
              return database.query(sql).get(...bindings) as Record<
                string,
                unknown
              > | null;
            },
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
