import { describe, expect, test } from "bun:test";
import {
  jumpConsistentHash,
  routingDigestSha256,
  runContainerShardRoutingSelfTest,
  verifyContainerShardRoutingContract,
} from "../tools/verify_container_shard_routing_contract.mjs";

const contract = await Bun.file(
  new URL("./fixtures/container-shard-routing-v1.json", import.meta.url),
).json();

describe("container shard routing contract", () => {
  test("matches the independent HMAC and Jump Hash vectors", () => {
    const report = verifyContainerShardRoutingContract(contract);
    expect(report).toEqual({
      ok: true,
      schemaVersion: 1,
      contractVersion: 1,
      algorithm: "hmac-sha256+jump-consistent-hash-v1",
      vectorCount: 4,
      planCount: 16,
      adjacentTransitionCount: 8,
      movedToNewShardCount: 1,
      maximumRingCovered: true,
      fixtureSecretsAreTestOnly: true,
    });
    const serialized = JSON.stringify(report);
    for (const vector of contract.vectors) {
      expect(serialized).not.toContain(vector.secret_hex);
      expect(serialized).not.toContain(vector.tenant_id);
      expect(serialized).not.toContain(vector.routing_digest_sha256);
    }
  });

  test("binds tenant length and the domain before hashing", () => {
    const vector = contract.vectors[0];
    const secret = Buffer.from(vector.secret_hex, "hex");
    const domain = Buffer.from(contract.domain_hex, "hex");
    expect(routingDigestSha256(secret, vector.tenant_id, domain)).toBe(
      vector.routing_digest_sha256,
    );
    expect(routingDigestSha256(secret, `${vector.tenant_id}x`, domain)).not.toBe(
      vector.routing_digest_sha256,
    );
    expect(
      routingDigestSha256(secret, vector.tenant_id, Buffer.from("different-domain\0")),
    ).not.toBe(vector.routing_digest_sha256);
  });

  test("moves only to the appended shard during one-shard expansion", () => {
    for (const vector of contract.vectors) {
      const plans = [...vector.plans].sort(
        (left, right) => left.shard_count - right.shard_count,
      );
      for (let index = 1; index < plans.length; index += 1) {
        const previous = plans[index - 1];
        const current = plans[index];
        if (current.shard_count !== previous.shard_count + 1) continue;
        const calculated = jumpConsistentHash(
          vector.routing_digest_sha256,
          current.shard_count,
        );
        expect(calculated).toBe(current.shard_index);
        if (current.shard_index !== previous.shard_index) {
          expect(current.shard_index).toBe(previous.shard_count);
        }
      }
    }
  });

  test("rejects drifted digests, plans, names, and transition evidence", () => {
    expect(runContainerShardRoutingSelfTest(contract)).toEqual({
      selfTest: true,
      rejectedMutationCount: 6,
    });
  });
});
