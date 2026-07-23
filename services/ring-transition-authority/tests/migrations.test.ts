import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const serviceRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("dedicated D1 migration mirrors", () => {
  test.each([
    [
      "migrations/0001_ring_transition_claims.sql",
      "migrations/d1/0059_relay_container_ring_transition_claims.sql",
    ],
    [
      "migrations/0002_ring_transition_authority.sql",
      "migrations/d1/0060_relay_container_ring_transition_authority.sql",
    ],
  ])("%s is a byte-for-byte source mirror", async (servicePath, sourcePath) => {
    const [serviceBytes, sourceBytes] = await Promise.all([
      readFile(`${serviceRoot}${servicePath}`),
      readFile(`${repositoryRoot}${sourcePath}`),
    ]);
    expect(serviceBytes.equals(sourceBytes)).toBe(true);
    expect(createHash("sha256").update(serviceBytes).digest("hex")).toBe(
      createHash("sha256").update(sourceBytes).digest("hex"),
    );
  });
});
