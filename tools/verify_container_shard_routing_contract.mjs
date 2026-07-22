#!/usr/bin/env node

import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultContractPath = path.join(
  repoRoot,
  "tests",
  "fixtures",
  "container-shard-routing-v1.json",
);
const U64_MASK = (1n << 64n) - 1n;
const JUMP_MULTIPLIER = 2_862_933_555_777_941_757n;
const JUMP_SCALE = 1n << 31n;
const LOWER_HEX_64 = /^[0-9a-f]{64}$/;
const LOWER_BYTE_HEX = /^(?:[0-9a-f]{2})+$/;
const EXPECTED_DOMAIN_HEX = Buffer.from(
  "cinatoken-container-shard-routing:v1\0",
  "utf8",
).toString("hex");
const VECTOR_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EXPECTED_KEYS = Object.freeze({
  contract: [
    "algorithm",
    "contract_version",
    "domain_hex",
    "instance_prefix",
    "maximum_shards",
    "minimum_secret_bytes",
    "schema_version",
    "vectors",
  ],
  vector: ["name", "plans", "routing_digest_sha256", "secret_hex", "tenant_id"],
  plan: ["instance_name", "ring_generation", "shard_count", "shard_index"],
});

export function routingDigestSha256(secret, tenantId, domain) {
  assert(Buffer.isBuffer(secret), "routing secret must be bytes");
  assert(Buffer.isBuffer(domain), "routing domain must be bytes");
  const tenant = Buffer.from(tenantId, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(tenant.length);
  return createHmac("sha256", secret)
    .update(domain)
    .update(length)
    .update(tenant)
    .digest("hex");
}

export function jumpConsistentHash(routingDigestHex, shardCount) {
  assert(LOWER_HEX_64.test(routingDigestHex), "routing digest must be lowercase SHA-256");
  assertPositiveInteger(shardCount, "shard count");
  let key = BigInt(`0x${routingDigestHex.slice(0, 16)}`);
  let current = -1n;
  let candidate = 0n;
  while (candidate < BigInt(shardCount)) {
    current = candidate;
    key = (key * JUMP_MULTIPLIER + 1n) & U64_MASK;
    candidate = ((current + 1n) * JUMP_SCALE) / ((key >> 33n) + 1n);
  }
  return Number(current);
}

export function verifyContainerShardRoutingContract(contract) {
  requireRecord(contract, "routing contract");
  requireExactKeys(contract, EXPECTED_KEYS.contract, "routing contract");
  assert(contract.schema_version === 1, "routing contract schema version must be 1");
  assert(contract.contract_version === 1, "routing contract version must be 1");
  assert(
    contract.algorithm === "hmac-sha256+jump-consistent-hash-v1",
    "routing contract algorithm is unsupported",
  );
  assert(contract.domain_hex === EXPECTED_DOMAIN_HEX, "routing domain bytes drifted");
  assert(
    contract.instance_prefix === "cinatoken-relay-shard-v1",
    "routing instance prefix is not canonical",
  );
  assert(contract.minimum_secret_bytes === 32, "minimum routing secret must be 32 bytes");
  assert(contract.maximum_shards === 1024, "maximum routing shard count must be 1024");
  assert(Array.isArray(contract.vectors) && contract.vectors.length >= 3, "routing vectors are incomplete");

  const domain = Buffer.from(contract.domain_hex, "hex");
  const names = new Set();
  let planCount = 0;
  let adjacentTransitionCount = 0;
  let movedToNewShardCount = 0;
  let maximumRingCovered = false;

  for (const vector of contract.vectors) {
    requireRecord(vector, "routing vector");
    requireExactKeys(vector, EXPECTED_KEYS.vector, `routing vector ${String(vector.name)}`);
    assert(VECTOR_NAME.test(vector.name), "routing vector name is invalid");
    assert(!names.has(vector.name), `duplicate routing vector ${vector.name}`);
    names.add(vector.name);
    assert(LOWER_BYTE_HEX.test(vector.secret_hex), `${vector.name} secret must be lowercase byte hex`);
    const secret = Buffer.from(vector.secret_hex, "hex");
    assert(secret.length >= contract.minimum_secret_bytes, `${vector.name} routing secret is too short`);
    validateTenantId(vector.tenant_id, vector.name);
    assert(
      LOWER_HEX_64.test(vector.routing_digest_sha256),
      `${vector.name} routing digest is invalid`,
    );
    const digest = routingDigestSha256(secret, vector.tenant_id, domain);
    assert(digest === vector.routing_digest_sha256, `${vector.name} routing digest drifted`);
    assert(Array.isArray(vector.plans) && vector.plans.length >= 2, `${vector.name} plans are incomplete`);

    const seenPlans = new Set();
    const plans = [...vector.plans].sort((left, right) => left.shard_count - right.shard_count);
    for (const plan of plans) {
      requireRecord(plan, `${vector.name} plan`);
      requireExactKeys(plan, EXPECTED_KEYS.plan, `${vector.name} plan`);
      assertPositiveInteger(plan.ring_generation, `${vector.name} ring generation`);
      assertPositiveInteger(plan.shard_count, `${vector.name} shard count`);
      assert(plan.shard_count <= contract.maximum_shards, `${vector.name} shard count exceeds maximum`);
      assert(Number.isInteger(plan.shard_index), `${vector.name} shard index must be an integer`);
      assert(
        plan.shard_index >= 0 && plan.shard_index < plan.shard_count,
        `${vector.name} shard index is outside the ring`,
      );
      const identity = `${plan.ring_generation}:${plan.shard_count}`;
      assert(!seenPlans.has(identity), `${vector.name} repeats ring ${identity}`);
      seenPlans.add(identity);
      const expectedIndex = jumpConsistentHash(digest, plan.shard_count);
      assert(expectedIndex === plan.shard_index, `${vector.name} shard index drifted for ${identity}`);
      const expectedName = `${contract.instance_prefix}-${String(expectedIndex).padStart(4, "0")}`;
      assert(plan.instance_name === expectedName, `${vector.name} instance name drifted for ${identity}`);
      maximumRingCovered ||= plan.shard_count === contract.maximum_shards;
      planCount += 1;
    }

    for (let index = 1; index < plans.length; index += 1) {
      const previous = plans[index - 1];
      const current = plans[index];
      assert(
        current.ring_generation > previous.ring_generation,
        `${vector.name} ring generation did not advance`,
      );
      if (current.shard_count !== previous.shard_count + 1) {
        continue;
      }
      assert(
        current.ring_generation === previous.ring_generation + 1,
        `${vector.name} one-shard expansion did not advance one generation`,
      );
      adjacentTransitionCount += 1;
      if (current.shard_index !== previous.shard_index) {
        assert(
          current.shard_index === previous.shard_count,
          `${vector.name} moved to an existing shard during one-shard expansion`,
        );
        movedToNewShardCount += 1;
      }
    }
  }

  assert(adjacentTransitionCount >= contract.vectors.length, "adjacent ring expansion coverage is incomplete");
  assert(movedToNewShardCount > 0, "routing vectors do not cover movement to a newly added shard");
  assert(maximumRingCovered, "routing vectors do not cover the maximum ring size");
  return Object.freeze({
    ok: true,
    schemaVersion: contract.schema_version,
    contractVersion: contract.contract_version,
    algorithm: contract.algorithm,
    vectorCount: contract.vectors.length,
    planCount,
    adjacentTransitionCount,
    movedToNewShardCount,
    maximumRingCovered,
    fixtureSecretsAreTestOnly: true,
  });
}

export function runContainerShardRoutingSelfTest(contract) {
  const mutations = [
    (value) => {
      value.vectors[0].routing_digest_sha256 = "0".repeat(64);
    },
    (value) => {
      value.vectors[0].plans[0].shard_index = 7;
    },
    (value) => {
      value.vectors[0].plans[0].instance_name = "cinatoken-relay-shard-v1-9999";
    },
    (value) => {
      value.vectors[1].name = value.vectors[0].name;
    },
    (value) => {
      value.vectors[2].plans.find((plan) => plan.shard_count === 65).shard_index = 1;
    },
    (value) => {
      value.vectors[0].plans[1].ring_generation = value.vectors[0].plans[0].ring_generation;
    },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(contract);
    mutate(changed);
    let rejected = false;
    try {
      verifyContainerShardRoutingContract(changed);
    } catch {
      rejected = true;
    }
    assert(rejected, "routing contract self-test mutation was accepted");
  }
  return { selfTest: true, rejectedMutationCount: mutations.length };
}

function validateTenantId(value, vectorName) {
  assert(typeof value === "string" && value.length > 0, `${vectorName} tenant ID is empty`);
  assert(value === value.trim(), `${vectorName} tenant ID has surrounding whitespace`);
  assert(Buffer.byteLength(value, "utf8") <= 256, `${vectorName} tenant ID is too long`);
  assert(!/[\u0000-\u001f\u007f]/u.test(value), `${vectorName} tenant ID contains controls`);
}

function requireRecord(value, label) {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
}

function requireExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  assert(
    actual.length === expected.length && actual.every((key, index) => key === expected[index]),
    `${label} fields are not canonical`,
  );
}

function assertPositiveInteger(value, label) {
  assert(Number.isSafeInteger(value) && value > 0, `${label} must be a positive integer`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const contract = JSON.parse(await readFile(defaultContractPath, "utf8"));
  const report = verifyContainerShardRoutingContract(contract);
  const selfTest = args.has("--self-test") ? runContainerShardRoutingSelfTest(contract) : {};
  const output = { ...report, ...selfTest };
  process.stdout.write(`${JSON.stringify(output, null, args.has("--json") ? 2 : 0)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
