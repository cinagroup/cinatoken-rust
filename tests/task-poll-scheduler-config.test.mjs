import { describe, expect, test } from "bun:test";

const config = Bun.TOML.parse(
  await Bun.file(new URL("../wrangler.toml", import.meta.url)).text(),
);
const packageJson = await Bun.file(
  new URL("../package.json", import.meta.url),
).json();

const expected = {
  TASK_POLL_SCHEDULER_ENABLED: "false",
  TASK_POLL_RETRY_BASE_SECONDS: "15",
  TASK_POLL_RETRY_MAX_SECONDS: "900",
  TASK_POLL_MAX_CONSECUTIVE_FAILURES: "8",
  TASK_POLL_SCHEDULER_STAGING_VERIFIED: "false",
  TASK_POLL_RECOVERY_ENABLED: "false",
  TASK_POLL_RECOVERY_STAGING_VERIFIED: "false",
};

const environments = [
  ["top-level", config.vars],
  ["staging", config.env?.staging?.vars],
  ["production", config.env?.production?.vars],
];

describe("task poll scheduler Wrangler defaults", () => {
  for (const [environment, vars] of environments) {
    test(`${environment} has the explicit fail-closed scheduler contract`, () => {
      expect(vars).toBeDefined();
      expect(
        Object.fromEntries(
          Object.keys(expected).map((name) => [name, vars[name]]),
        ),
      ).toEqual(expected);

      const retryBase = Number(vars.TASK_POLL_RETRY_BASE_SECONDS);
      const retryMax = Number(vars.TASK_POLL_RETRY_MAX_SECONDS);
      const maxFailures = Number(vars.TASK_POLL_MAX_CONSECUTIVE_FAILURES);
      expect(Number.isSafeInteger(retryBase)).toBe(true);
      expect(Number.isSafeInteger(retryMax)).toBe(true);
      expect(Number.isSafeInteger(maxFailures)).toBe(true);
      expect(retryBase).toBeGreaterThan(0);
      expect(retryMax).toBeGreaterThanOrEqual(retryBase);
      expect(maxFailures).toBeGreaterThan(0);
    });
  }

  test("bun run check executes lease validation before scheduler validation", () => {
    expect(packageJson.scripts["check:task-poll-scheduler-config"]).toBe(
      "bun test tests/task-poll-scheduler-config.test.mjs",
    );

    const check = packageJson.scripts.check;
    const leaseCheck = "bun run check:task-poll-lease-config";
    const schedulerCheck = "bun run check:task-poll-scheduler-config";
    expect(check).toContain(leaseCheck);
    expect(check).toContain(schedulerCheck);
    expect(check.indexOf(leaseCheck)).toBeLessThan(check.indexOf(schedulerCheck));
  });
});
