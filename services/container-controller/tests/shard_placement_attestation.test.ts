import { describe, expect, test } from "bun:test";

import fixture from "../../../tests/fixtures/container-shard-placement-attestation-v1.json";
import { ProtocolError } from "../src/protocol";
import {
  RELAY_SHARD_DURABLE_OBJECT_CLASS,
  RELAY_SHARD_NAMESPACE_BINDING,
  SHARD_PLACEMENT_ATTESTATION_CONTRACT,
  SHARD_PLACEMENT_ATTESTATION_DIGEST_DOMAIN,
  createShardPlacementAttestationV1,
  parseShardPlacementAttestationV1,
  shardPlacementAttestationDigest,
  type CreateShardPlacementAttestationV1Input,
  type ShardPlacementAttestationV1,
} from "../src/shard_placement_attestation";

const input = fixture.input as CreateShardPlacementAttestationV1Input;
const expected = fixture.attestation as ShardPlacementAttestationV1;

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
});
