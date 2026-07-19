import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";

import {
  SHARD_ACTIVATION_CAMPAIGN_ACTION_GATES,
  activationCampaignProbeId,
  campaignActionGateInventory,
  campaignDigest,
  claimShardActivationCampaign,
  finalizeShardActivationCampaign,
  sealShardActivationCampaignFailure,
  type ShardActivationCampaignAcquire,
  type ShardActivationCampaignClaim,
  type ShardActivationCampaignClaimInput,
} from "../src/shard_activation_campaign";
import type { ShardActivationInput } from "../src/shard_activation";
import type { OperationShard } from "../src/protocol";

const CAMPAIGN_ID = "d".repeat(64);
const NONCE = "e".repeat(64);
const RUNTIME_BUILD_ID = "c".repeat(64);
const ACTION_GATE_DIGEST = "a".repeat(64);
const READINESS_RESULT_SHA256 = "9".repeat(64);
const NOW = 1_900_000_000;

const credential = {
  contract_version: 1 as const,
  campaign_id: CAMPAIGN_ID,
  nonce: NONCE,
  confirm_consume: true as const,
};

function shard(shardIndex: number): OperationShard {
  return {
    contract_version: 1,
    ring_generation: 7,
    shard_count: 2,
    shard_index: shardIndex,
    instance_name: `cinatoken-relay-shard-v1-${shardIndex.toString().padStart(4, "0")}`,
  };
}

function activation(
  claim: ShardActivationCampaignClaim,
  probeGeneration: number,
  overrides: Partial<ShardActivationInput> = {},
): ShardActivationInput {
  return {
    controllerVersionId: claim.controllerVersionId,
    shard: claim.shard,
    runtimeProtocolVersion: claim.runtimeProtocolVersion,
    runtimeContractVersion: claim.runtimeContractVersion,
    runtimeBuildId: claim.runtimeBuildId,
    activationGeneration: claim.activationGeneration,
    activationProbeGeneration: probeGeneration,
    environment: claim.environment,
    containerStatus: "healthy",
    readinessResultCode: "process_ready_execution_disabled",
    processReady: true,
    runtimeExecutionEnabled: false,
    controllerExecutionEnabled: false,
    activatedAt: claim.claimedAt,
    ...overrides,
  };
}

describe("relay Container shard activation campaign", () => {
  test("shares the exact campaign and deterministic probe vectors with Rust", async () => {
    expect(
      await campaignDigest({
        campaign_id:
          "a9f9f7aa3b8672759a9a7b37b5ee3a093930c3041ef4b741f0e3c824fbf1a477",
        campaign_nonce_sha256:
          "43a2608fbbc98d0c5c2ed3bf30b5bfb7a40f45da1f452c3d70ad485cc4a38130",
        controller_version_id: "controller-version-55",
        action_gate_inventory_sha256: ACTION_GATE_DIGEST,
        action_gate_count: 22,
        all_action_gates_false: 1,
        foundation_manifest_sha256: "b".repeat(64),
        runtime_build_id: "c".repeat(64),
        ring_generation: 7,
        shard_count: 8,
        shard_contract_version: 1,
        runtime_protocol_version: 1,
        runtime_contract_version: 1,
        activation_generation: 1,
        environment: "staging",
        created_by_admin_id: 42,
        campaign_digest_sha256: "",
        created_at: NOW,
        expires_at: NOW + 600,
        claimed_shard_count: 0,
        consumed_shard_count: 0,
        seal_reason: null,
        seal_detail_code: null,
        last_consumption_digest_sha256: null,
        sealed_at: null,
        database_now: NOW,
      }),
    ).toBe("7500482b4cff400b784f890595abe940ef274fe3ee2f1a0002d7b90f06a351f1");
    expect(
      await activationCampaignProbeId(
        "a9f9f7aa3b8672759a9a7b37b5ee3a093930c3041ef4b741f0e3c824fbf1a477",
        7,
      ),
    ).toBe("6a3d0e58ee9be4b475264a2496ab965364535d8979fbcf88df79a9f761c41b74");
  });

  test("claims before activation, recovers an unconsumed claim, and seals exactly at N", async () => {
    const fixture = await campaignDatabase();
    try {
      const firstInput = await claimInput(0);
      const firstClaim = expectClaimed(
        await claimShardActivationCampaign(fixture.database as never, firstInput),
      );
      expect(firstClaim.recovered).toBeFalse();
      expect(count(fixture.sqlite, "relay_container_shard_activation_campaign_claims")).toBe(1);
      expect(count(fixture.sqlite, "relay_container_shard_activations")).toBe(0);

      const recovered = expectClaimed(
        await claimShardActivationCampaign(fixture.database as never, firstInput),
      );
      expect(recovered).toMatchObject({
        campaignId: CAMPAIGN_ID,
        claimDigestSha256: firstClaim.claimDigestSha256,
        recovered: true,
      });

      const first = await finalizeShardActivationCampaign(
        fixture.database as never,
        recovered,
        activation(recovered, 1),
        READINESS_RESULT_SHA256,
      );
      expect(first).toMatchObject({
        claimedShardCount: 1,
        consumedShardCount: 1,
        shardCount: 2,
        sealed: false,
      });
      expect(count(fixture.sqlite, "relay_container_shard_activations")).toBe(1);

      const completedReplay = await claimShardActivationCampaign(
        fixture.database as never,
        firstInput,
      );
      expect(completedReplay).toMatchObject({
        kind: "completed",
        readinessResultSha256: READINESS_RESULT_SHA256,
        claim: { claimDigestSha256: firstClaim.claimDigestSha256 },
      });

      const secondInput = await claimInput(1);
      const secondClaim = expectClaimed(
        await claimShardActivationCampaign(fixture.database as never, secondInput),
      );
      const final = await finalizeShardActivationCampaign(
        fixture.database as never,
        secondClaim,
        activation(secondClaim, 2),
        READINESS_RESULT_SHA256,
      );
      expect(final).toMatchObject({
        claimedShardCount: 2,
        consumedShardCount: 2,
        shardCount: 2,
        sealed: true,
      });
      expect(
        fixture.sqlite
          .query(
            `SELECT consumed_shard_count, seal_reason, seal_detail_code
             FROM relay_container_shard_activation_campaign_seals`,
          )
          .get(),
      ).toEqual({
        consumed_shard_count: 2,
        seal_reason: "complete",
        seal_detail_code: "all_shards_consumed",
      });
      expect(count(fixture.sqlite, "relay_container_shard_activations")).toBe(2);
      expect(
        await claimShardActivationCampaign(fixture.database as never, secondInput),
      ).toMatchObject({
        kind: "completed",
        readinessResultSha256: READINESS_RESULT_SHA256,
        claim: { claimDigestSha256: secondClaim.claimDigestSha256 },
      });
    } finally {
      fixture.sqlite.close();
    }
  });

  test("rejects nonce, version, gate, and expiry before any activation", async () => {
    for (const candidate of [
      async () => ({ ...(await claimInput(0)), credential: { ...credential, nonce: "f".repeat(64) } }),
      async () => ({ ...(await claimInput(0)), controllerVersionId: "controller-version-other" }),
    ]) {
      const fixture = await campaignDatabase();
      try {
        await expect(
          claimShardActivationCampaign(fixture.database as never, await candidate()),
        ).rejects.toMatchObject({ status: expect.any(Number) });
        expect(count(fixture.sqlite, "relay_container_shard_activation_campaign_claims")).toBe(0);
        expect(count(fixture.sqlite, "relay_container_shard_activations")).toBe(0);
      } finally {
        fixture.sqlite.close();
      }
    }

    const gateFixture = await campaignDatabase();
    try {
      const input = await claimInput(0);
      input.actionGateInventory = {
        ...input.actionGateInventory,
        allActionGatesFalse: false,
      };
      await expect(
        claimShardActivationCampaign(gateFixture.database as never, input),
      ).rejects.toMatchObject({
        code: "invalid_shard_activation_campaign",
        status: 400,
      });
      expect(count(gateFixture.sqlite, "relay_container_shard_activation_campaign_claims")).toBe(0);
    } finally {
      gateFixture.sqlite.close();
    }

    const expiredFixture = await campaignDatabase({ expired: true });
    try {
      await expect(
        claimShardActivationCampaign(expiredFixture.database as never, await claimInput(0)),
      ).rejects.toMatchObject({
        code: "shard_activation_campaign_expired",
        status: 409,
      });
      expect(count(expiredFixture.sqlite, "relay_container_shard_activation_campaign_claims")).toBe(0);
      expect(
        expiredFixture.sqlite
          .query(
            `SELECT seal_reason, seal_detail_code
             FROM relay_container_shard_activation_campaign_seals`,
          )
          .get(),
      ).toEqual({ seal_reason: "expired", seal_detail_code: "campaign_expired" });
      expect(count(expiredFixture.sqlite, "relay_container_shard_activations")).toBe(0);
    } finally {
      expiredFixture.sqlite.close();
    }
  });

  test("terminal failure seal retires the claimed candidate without writing 0054", async () => {
    const fixture = await campaignDatabase();
    try {
      await claimShardActivationCampaign(fixture.database as never, await claimInput(0));
      await sealShardActivationCampaignFailure(
        fixture.database as never,
        CAMPAIGN_ID,
        "readiness_rejected",
      );
      await expect(
        claimShardActivationCampaign(fixture.database as never, await claimInput(1)),
      ).rejects.toMatchObject({
        code: "shard_activation_campaign_sealed",
        status: 409,
      });
      expect(count(fixture.sqlite, "relay_container_shard_activations")).toBe(0);
      expect(
        fixture.sqlite
          .query("SELECT seal_reason, seal_detail_code FROM relay_container_shard_activation_campaign_seals")
          .get(),
      ).toEqual({ seal_reason: "failed", seal_detail_code: "readiness_rejected" });
    } finally {
      fixture.sqlite.close();
    }
  });

  test("action-gate digest covers the exact 22-name inventory", async () => {
    const environment = disabledActionGates();
    const first = await campaignActionGateInventory(environment);
    expect(first).toMatchObject({ allActionGatesFalse: true, count: 22 });
    environment.CONTAINER_READINESS_WAKE_ENABLED = "true";
    const changed = await campaignActionGateInventory(environment);
    expect(changed.allActionGatesFalse).toBeFalse();
    expect(changed.digestSha256).not.toBe(first.digestSha256);
  });

  test("readiness route claims D1 before DO lookup and replays completed claims without the nonce", async () => {
    const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
    const routeStart = source.indexOf("if (path === INTERNAL_READINESS_PATH) {");
    const routeEnd = source.indexOf(
      "if (path !== INTERNAL_OPERATION_PATH)",
      routeStart,
    );
    expect(routeStart).toBeGreaterThan(-1);
    expect(routeEnd).toBeGreaterThan(routeStart);
    const route = source.slice(routeStart, routeEnd);

    const acquire = route.indexOf("claimShardActivationCampaignBeforeWake(");
    const firstDoLookup = route.indexOf("env.RELAY_SHARDS.getByName(");
    const v2CallStart = route.indexOf("stub.readinessProbeV2(");
    const v2CallEnd = route.indexOf(");", v2CallStart);
    const finalize = route.indexOf("finalizeClaimedShardActivationCampaign(");
    expect(acquire).toBeGreaterThan(-1);
    expect(firstDoLookup).toBeGreaterThan(acquire);
    expect(v2CallStart).toBeGreaterThan(firstDoLookup);
    expect(finalize).toBeGreaterThan(v2CallStart);

    const v2Call = route.slice(v2CallStart, v2CallEnd + 2);
    expect(v2Call).toContain("shardProbe");
    expect(v2Call).toContain('campaignAcquire.kind === "completed"');
    expect(v2Call).not.toContain("activation_campaign");
    expect(v2Call).not.toContain("verified.probe,");
    expect(route.indexOf("readinessResultSha256 !== outcome.result_sha256")).toBeGreaterThan(
      v2CallStart,
    );
  });
});

function expectClaimed(acquire: ShardActivationCampaignAcquire): ShardActivationCampaignClaim {
  expect(acquire.kind).toBe("claimed");
  if (acquire.kind !== "claimed") throw new Error("expected a newly claimed campaign shard");
  return acquire.claim;
}

async function claimInput(shardIndex: number): Promise<ShardActivationCampaignClaimInput> {
  return {
    credential,
    controllerVersionId: "controller-version-55",
    actionGateInventory: await campaignActionGateInventory(disabledActionGates()),
    shard: shard(shardIndex),
    runtimeProtocolVersion: 1,
    environment: "staging",
    probeId: await activationCampaignProbeId(CAMPAIGN_ID, shardIndex),
  };
}

function disabledActionGates(): Record<
  (typeof SHARD_ACTIVATION_CAMPAIGN_ACTION_GATES)[number],
  string
> {
  return Object.fromEntries(
    SHARD_ACTIVATION_CAMPAIGN_ACTION_GATES.map((name) => [name, "false"]),
  ) as Record<(typeof SHARD_ACTIVATION_CAMPAIGN_ACTION_GATES)[number], string>;
}

async function campaignDatabase(options: { expired?: boolean } = {}) {
  const [activationMigration, campaignMigration] = await Promise.all([
    readFile(
      new URL(
        "../../../migrations/d1/0054_relay_container_shard_activations.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../../../migrations/d1/0055_relay_container_shard_activation_campaigns.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);
  const sqlite = new Database(":memory:");
  const databaseNow = Math.floor(Date.now() / 1_000);
  sqlite.exec(
    "CREATE TABLE d1_migrations (name TEXT NOT NULL); " +
      "INSERT INTO d1_migrations(name) VALUES " +
      "('0054_relay_container_shard_activations.sql'), " +
      "('0055_relay_container_shard_activation_campaigns.sql');",
  );
  sqlite.exec(activationMigration);
  const testMigration = campaignMigration.replace(
    /CREATE TRIGGER relay_container_shard_activation_campaign_insert_guard[\s\S]*?\r?\nEND;\r?\n\r?\n(?=CREATE TRIGGER relay_container_shard_activation_campaign_update_guard)/,
    `CREATE TRIGGER relay_container_shard_activation_campaign_insert_guard
     BEFORE INSERT ON relay_container_shard_activation_campaigns
     FOR EACH ROW BEGIN SELECT 1; END;\n\n`,
  );
  if (testMigration === campaignMigration) throw new Error("campaign insert guard fixture not found");
  sqlite.exec(testMigration);
  const createdAt = options.expired ? databaseNow - 600 : databaseNow;
  const expiresAt = options.expired ? databaseNow - 1 : databaseNow + 600;
  const campaign = {
    campaign_id: CAMPAIGN_ID,
    campaign_nonce_sha256: await sha256Hex(NONCE),
    controller_version_id: "controller-version-55",
    action_gate_inventory_sha256: (await campaignActionGateInventory(disabledActionGates()))
      .digestSha256,
    action_gate_count: 22,
    all_action_gates_false: 1,
    foundation_manifest_sha256: "b".repeat(64),
    runtime_build_id: RUNTIME_BUILD_ID,
    ring_generation: 7,
    shard_count: 2,
    shard_contract_version: 1,
    runtime_protocol_version: 1,
    runtime_contract_version: 1,
    activation_generation: 1,
    environment: "staging",
    created_by_admin_id: 42,
    campaign_digest_sha256: "",
    created_at: createdAt,
    expires_at: expiresAt,
    claimed_shard_count: 0,
    consumed_shard_count: 0,
    seal_reason: null,
    seal_detail_code: null,
    last_consumption_digest_sha256: null,
    sealed_at: null,
    database_now: databaseNow,
  };
  campaign.campaign_digest_sha256 = await campaignDigest(campaign);
  sqlite
    .query(
      `INSERT INTO relay_container_shard_activation_campaigns (
         campaign_id, campaign_nonce_sha256, controller_version_id,
         action_gate_inventory_sha256, action_gate_count, all_action_gates_false,
         foundation_manifest_sha256, runtime_build_id, ring_generation,
         shard_count, shard_contract_version, runtime_protocol_version,
         runtime_contract_version, activation_generation, environment,
         created_by_admin_id, campaign_digest_sha256, created_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      campaign.campaign_id,
      campaign.campaign_nonce_sha256,
      campaign.controller_version_id,
      campaign.action_gate_inventory_sha256,
      campaign.action_gate_count,
      campaign.all_action_gates_false,
      campaign.foundation_manifest_sha256,
      campaign.runtime_build_id,
      campaign.ring_generation,
      campaign.shard_count,
      campaign.shard_contract_version,
      campaign.runtime_protocol_version,
      campaign.runtime_contract_version,
      campaign.activation_generation,
      campaign.environment,
      campaign.created_by_admin_id,
      campaign.campaign_digest_sha256,
      campaign.created_at,
      campaign.expires_at,
    );
  return { sqlite, database: sqliteD1Database(sqlite) };
}

function sqliteD1Database(database: Database) {
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

function count(database: Database, table: string): number {
  return (database.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
