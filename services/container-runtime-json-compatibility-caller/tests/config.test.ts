import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, test } from "vitest";

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("private Caller Worker configuration", () => {
  test.each([
    ["local", "../wrangler.local.toml", "local"],
    ["staging", "../wrangler.staging.toml", "staging"],
  ])("keeps %s private, default-off, and bound to the named Runner", (_, path, environment) => {
    const config = read(path);
    expect(config).toContain('main = "src/index.ts"');
    expect(config).toContain('compatibility_flags = ["nodejs_compat"]');
    expect(config).toContain("workers_dev = false");
    expect(config).toContain("preview_urls = false");
    expect(config).not.toMatch(/^route\s*=/mu);
    expect(config).not.toMatch(/^routes\s*=/mu);
    expect(config).toContain('binding = "JSON_COMPATIBILITY_RUNNER_SERVICE"');
    expect(config).toContain(
      'service = "cinatoken-container-runtime-json-compatibility-runner-staging"',
    );
    expect(config).toContain(
      'entrypoint = "JsonCompatibilityCampaignRunnerEntrypoint"',
    );
    expect(config).toContain(`ENVIRONMENT = "${environment}"`);
    expect(config).toContain('JSON_COMPATIBILITY_CALLER_ENABLED = "false"');
    expect(config).toContain(
      'JSON_COMPATIBILITY_CALLER_STATUS_READ_ENABLED = "false"',
    );
    expect(config).toContain(
      'JSON_COMPATIBILITY_CALLER_RUNNER_VERSION_ID = ""',
    );
    expect(config).toContain(
      'JSON_COMPATIBILITY_CALLER_RUNNER_CONFIG_SHA256 = ""',
    );
    expect(config).not.toMatch(/_SECRET\s*=/u);
  });

  test("exports capability only from the named entrypoint", () => {
    const files = readdirSync(new URL("..", import.meta.url));
    expect(files.filter((name) => name.includes("production"))).toEqual([]);
    const source = read("../src/index.ts");
    expect(source).toMatch(/JsonCompatibilityCampaignCallerEntrypoint/u);
    expect(source).toMatch(/JsonCompatibilityCallerDefaultEntrypoint/u);
    expect(source).toMatch(/async invokePhase\(/u);
    expect(source).toMatch(/async getPhaseStatus\(/u);
    expect(source).not.toMatch(/\bfetch\s*\(/u);
  });
});
