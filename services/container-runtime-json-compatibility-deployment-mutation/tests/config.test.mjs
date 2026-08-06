import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

const configUrls = [
  new URL("../wrangler.local.jsonc", import.meta.url),
  new URL("../wrangler.staging.jsonc", import.meta.url),
];

describe("deployment mutation Worker configuration", () => {
  test.each(configUrls)("keeps %s private and disabled", async (url) => {
    const source = await readFile(url, "utf8");
    const config = JSON.parse(source);
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(config).not.toHaveProperty("routes");
    expect(config.vars.JSON_COMPATIBILITY_DEPLOYMENT_MUTATION_ENABLED)
      .toBe("false");
    expect(config.vars.JSON_COMPATIBILITY_DEPLOYMENT_MUTATION_REMOTE_ENABLED)
      .toBe("false");
    expect(config.d1_databases).toHaveLength(1);
    expect(config).not.toHaveProperty("services");
    expect(source).not.toContain("CLOUDFLARE_DEPLOYMENT_MUTATION_API_TOKEN");
  });

  test("default entrypoint is inert and named entrypoint exposes one RPC", async () => {
    const source = await readFile(
      new URL("../src/index.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain(
      "class JsonCompatibilityDeploymentMutationEntrypoint",
    );
    expect(source.match(/async mutateDeploymentOnce\(/g)).toHaveLength(1);
    expect(source).toMatch(
      /JsonCompatibilityDeploymentMutationDefaultEntrypoint[\s\S]*WorkerEntrypoint<JsonCompatibilityDeploymentMutationEnv> \{\}/,
    );
    const protocol = await readFile(
      new URL("../src/protocol.ts", import.meta.url),
      "utf8",
    );
    expect(protocol).toMatch(
      /validateJsonCompatibilityDeploymentTransitionMutationExecution\(\s*envelope,/,
    );
  });
});
