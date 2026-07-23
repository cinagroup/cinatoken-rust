import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const serviceRoot = fileURLToPath(new URL("../", import.meta.url));
const zeroDatabaseId = "00000000-0000-0000-0000-000000000000";
const forbiddenBindings = [
  "kv_namespaces",
  "r2_buckets",
  "durable_objects",
  "containers",
  "queues",
  "services",
  "vectorize",
  "hyperdrive",
  "workflows",
];

describe("Wrangler authority isolation", () => {
  test.each([
    ["wrangler.jsonc", "cinatoken-ring-control-local"],
    ["wrangler.staging.jsonc", "cinatoken-ring-control-staging"],
  ])("%s has only dedicated D1 and version metadata resources", async (path, databaseName) => {
    const config = JSON.parse(
      await readFile(`${serviceRoot}${path}`, "utf8"),
    ) as Record<string, unknown>;
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(config.version_metadata).toEqual({ binding: "CF_VERSION_METADATA" });
    expect(config.d1_databases).toEqual([
      {
        binding: "DB",
        database_name: databaseName,
        database_id: zeroDatabaseId,
        migrations_dir: "migrations",
      },
    ]);
    for (const key of forbiddenBindings) expect(config).not.toHaveProperty(key);

    const vars = config.vars as Record<string, string>;
    expect(vars.RING_TRANSITION_AUTHORITY_ENABLED).toBe("false");
    expect(vars.RING_TRANSITION_CLAIM_WRITE_ENABLED).toBe("false");
    expect(vars.RING_TRANSITION_STEP_WRITE_ENABLED).toBe("false");
    expect(vars.RING_TRANSITION_EXPIRY_WRITE_ENABLED).toBe("false");
    expect(vars).not.toHaveProperty("RING_TRANSITION_PERMIT_SPKI_BASE64URL");
    expect(vars).toHaveProperty("RING_TRANSITION_PERMIT_SPKI_SHA256", "");
  });

  test("staging exposes exactly the narrow internal route", async () => {
    const config = JSON.parse(
      await readFile(`${serviceRoot}wrangler.staging.jsonc`, "utf8"),
    ) as Record<string, unknown>;
    expect(config.routes).toEqual([
      {
        pattern:
          "ring-transition-authority-staging.cinatoken.com/internal/v1/ring-transition/*",
        zone_name: "cinatoken.com",
        custom_domain: false,
      },
    ]);
  });

  test("runtime source contains no logging sink", async () => {
    const source = await Promise.all([
      readFile(`${serviceRoot}src/index.ts`, "utf8"),
      readFile(`${serviceRoot}src/protocol.ts`, "utf8"),
      readFile(`${serviceRoot}src/repository.ts`, "utf8"),
    ]);
    expect(source.join("\n")).not.toMatch(/\bconsole\s*\./u);
  });
});
