import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const serviceRoot = fileURLToPath(new URL("../", import.meta.url));
const forbiddenBindings = [
  "d1_databases",
  "kv_namespaces",
  "r2_buckets",
  "durable_objects",
  "queues",
  "services",
  "assets",
  "containers",
];
const secretNames = [
  "DRAIN_SOURCE_REGISTRATION_HMAC_CURRENT_SECRET",
  "DRAIN_SOURCE_REGISTRATION_HMAC_PREVIOUS_SECRET",
  "DRAIN_SOURCE_REGISTRATION_PERMIT_PKCS8_BASE64URL",
  "DRAIN_SOURCE_REGISTRATION_PERMIT_SPKI_BASE64URL",
];

describe("Wrangler issuer isolation", () => {
  test.each([
    ["wrangler.jsonc", "local"],
    ["wrangler.staging.jsonc", "staging"],
  ])("%s is private, default-off, and binding-free", async (path, environment) => {
    const config = JSON.parse(
      await readFile(`${serviceRoot}${path}`, "utf8"),
    ) as Record<string, unknown>;
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(config).not.toHaveProperty("route");
    expect(config).not.toHaveProperty("routes");
    expect(config.version_metadata).toEqual({
      binding: "CF_VERSION_METADATA",
    });
    for (const binding of forbiddenBindings) {
      expect(config).not.toHaveProperty(binding);
    }

    const vars = config.vars as Record<string, string>;
    expect(vars.ENVIRONMENT).toBe(environment);
    expect(
      vars.DRAIN_SOURCE_REGISTRATION_PERMIT_ISSUER_ENABLED,
    ).toBe("false");
    for (const secret of secretNames) expect(vars).not.toHaveProperty(secret);
  });

  test("contains no production Wrangler configuration", async () => {
    const names = await readdir(serviceRoot);
    expect(names.filter((name) => /wrangler.*production/iu.test(name))).toEqual(
      [],
    );
  });

  test("runtime source contains no logging sink", async () => {
    const source = await Promise.all([
      readFile(`${serviceRoot}src/index.ts`, "utf8"),
      readFile(`${serviceRoot}src/protocol.ts`, "utf8"),
    ]);
    expect(source.join("\n")).not.toMatch(/\bconsole\s*\./u);
  });
});
