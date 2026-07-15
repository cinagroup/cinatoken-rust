import { describe, expect, test } from "bun:test";

const config = Bun.TOML.parse(
  await Bun.file(new URL("../wrangler.toml", import.meta.url)).text(),
);

const expected = {
  TASK_POLL_LEASE_ENABLED: "false",
  TASK_POLL_LEASE_SECONDS: "120",
  TASK_POLL_LEASE_STAGING_VERIFIED: "false",
};

const environments = [
  ["top-level", config.vars],
  ["staging", config.env?.staging?.vars],
  ["production", config.env?.production?.vars],
];

describe("task poll lease Wrangler defaults", () => {
  for (const [environment, vars] of environments) {
    test(`${environment} remains explicitly disabled`, () => {
      expect(vars).toBeDefined();
      expect(vars).toMatchObject(expected);
    });
  }
});
