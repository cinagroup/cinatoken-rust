import { describe, expect, test } from "bun:test";

const rootConfig = Bun.TOML.parse(
  await Bun.file(new URL("../wrangler.toml", import.meta.url)).text(),
);
const packageJson = await Bun.file(new URL("../package.json", import.meta.url)).json();
const configFiles = [
  "wrangler.jsonc",
  "wrangler.staging.jsonc",
  "wrangler.production.jsonc",
];

describe("isolated container controller configuration", () => {
  for (const file of configFiles) {
    test(`${file} is private, default-off, and capacity-aligned`, async () => {
      const config = JSON.parse(
        await Bun.file(new URL(`../services/container-controller/${file}`, import.meta.url)).text(),
      );
      expect(config.workers_dev).toBe(false);
      expect(config.preview_urls).toBe(false);
      expect(config.routes).toBeUndefined();
      expect(config.vars.CONTAINER_CONTROLLER_ENABLED).toBe("false");
      expect(config.vars.CONTAINER_EXECUTION_ENABLED).toBe("false");
      expect(config.vars.CONTAINER_AUTHORITY_CURRENT_SECRET).toBeUndefined();
      expect(config.vars.CONTAINER_AUTHORITY_PREVIOUS_SECRET).toBeUndefined();
      expect(config.durable_objects.bindings).toEqual([
        { name: "RELAY_SHARDS", class_name: "RelayShardContainer" },
      ]);
      expect(config.migrations[0].new_sqlite_classes).toEqual(["RelayShardContainer"]);
      expect(config.containers[0]).toMatchObject({
        class_name: "RelayShardContainer",
        max_instances: Number(config.vars.CONTAINER_SHARD_COUNT),
        instance_type: "lite",
        rollout_step_percentage: [10, 100],
        ssh: { enabled: false },
      });
    });
  }

  test("main edge remains container-free until the controller is independently verified", () => {
    expect(rootConfig.containers).toBeUndefined();
    expect(packageJson.scripts["check:container-controller"]).toContain("container-controller");
    expect(packageJson.scripts.check).toContain("bun run check:container-controller");
  });
});
