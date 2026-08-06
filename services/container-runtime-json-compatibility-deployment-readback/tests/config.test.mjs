import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

describe("deployment readback package configuration", () => {
  test.each(["local", "staging"])(
    "%s profile is private and disabled by default",
    async (profile) => {
      const source = await readFile(
        new URL(`../wrangler.${profile}.jsonc`, import.meta.url),
        "utf8",
      );
      const config = JSON.parse(source);

      expect(config.workers_dev).toBe(false);
      expect(config.preview_urls).toBe(false);
      expect(config).not.toHaveProperty("routes");
      expect(config).not.toHaveProperty("route");
      expect(config.vars.JSON_COMPATIBILITY_DEPLOYMENT_READBACK_ENABLED)
        .toBe("false");
      expect(config.main).toBe("src/index.ts");
      expect(source).not.toContain("CLOUDFLARE_DEPLOYMENT_READ_API_TOKEN");
    },
  );

  test("default entrypoint is inert and the package exposes a complete local gate", async () => {
    const index = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
    const packageJson = JSON.parse(await readFile(
      new URL("../package.json", import.meta.url),
      "utf8",
    ));

    expect(index).toContain("JsonCompatibilityDeploymentReadbackEntrypoint");
    expect(index).toContain("readDeploymentState(input: unknown)");
    expect(index).toMatch(
      /JsonCompatibilityDeploymentReadbackDefaultEntrypoint[\s\S]*WorkerEntrypoint<JsonCompatibilityDeploymentReadbackEnv> \{\}/,
    );
    expect(index).not.toContain("fetch(");
    expect(packageJson.scripts.check).toContain("types:check");
    expect(packageJson.scripts.check).toContain("typecheck");
    expect(packageJson.scripts.check).toContain("test");
    expect(packageJson.scripts.check).toContain("dry-run");
  });
});
