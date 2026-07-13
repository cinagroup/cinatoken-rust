import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { createHmac } from "node:crypto";
import { defineConfig } from "vitest/config";

const authoritySecret = "0123456789abcdef0123456789abcdef";
const authorityWorker = "tenant-runtime-test";
const accountId = "0123456789abcdef0123456789abcdef";
const authorityDomain = Buffer.concat([
  Buffer.from("cinatoken-wfp-authority-key:v1"),
  Buffer.from([0]),
  Buffer.from(authorityWorker),
]);
const authorityWorkerKey = createHmac("sha256", authoritySecret)
  .update(authorityDomain)
  .digest("base64url");
const compiledWasmModules = [
  {
    type: "CompiledWasm",
    include: ["**/*.wasm"],
    fallthrough: true,
  },
];
const d1Migrations = await readD1Migrations("./migrations/d1");
const auxiliaryModuleRules = [
  {
    type: "ESModule",
    include: ["**/*.js", "**/*.mjs"],
    fallthrough: true,
  },
  ...compiledWasmModules,
];

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./tests/fixtures/do-runtime-worker.mjs",
      miniflare: {
        compatibilityDate: "2026-07-13",
        compatibilityFlags: ["nodejs_compat"],
        modulesRules: compiledWasmModules,
        bindings: {
          WFP_RELAY_AUTHORITY_SECRET: authoritySecret,
          TASK_RUNNER_DO_ENABLED: "false",
          REALTIME_SESSION_V1_ENABLED: "true",
          REALTIME_BILLING_SETTLEMENT_WRITE_ENABLED: "true",
          REALTIME_BILLING_RESERVATION_LEASE_SECONDS: "900",
          REALTIME_BILLING_ORPHAN_RECOVERY_ENABLED: "true",
          REALTIME_BILLING_ORPHAN_SWEEP_LIMIT: "1",
          TEST_D1_MIGRATIONS: d1Migrations,
        },
        d1Databases: { DB: "do-runtime-test" },
        outboundService: "realtime-provider-mock",
        serviceBindings: {
          WFP_TENANT_RUNTIME: "wfp-tenant-runtime",
          WFP_PROVIDER_MOCK: "wfp-provider-mock",
          REALTIME_PROVIDER_MOCK: "realtime-provider-mock",
        },
        durableObjects: {
          REALTIME_SESSIONS: {
            className: "RealtimeSession",
            useSQLite: true,
          },
          WFP_AUTHORITY_REPLAY: "WfpAuthorityReplay",
          TASK_RUNNER: "TaskRunner",
        },
        workers: [
          {
            name: "wfp-platform-runtime",
            scriptPath: "./tests/fixtures/do-runtime-worker.mjs",
            modules: true,
            modulesRules: auxiliaryModuleRules,
            compatibilityDate: "2026-07-11",
            compatibilityFlags: ["nodejs_compat"],
            bindings: {
              WFP_RELAY_AUTHORITY_SECRET: authoritySecret,
            },
            durableObjects: {
              WFP_AUTHORITY_REPLAY: "WfpAuthorityReplay",
            },
          },
          {
            name: "wfp-tenant-runtime",
            scriptPath: "./crates/wfp-tenant/build/index.js",
            modules: true,
            modulesRules: auxiliaryModuleRules,
            compatibilityDate: "2026-07-11",
            compatibilityFlags: ["nodejs_compat"],
            bindings: {
              CINATOKEN_TENANT_ID: "tenant-runtime-test",
              CINATOKEN_WFP_WORKER_NAME: authorityWorker,
              CINATOKEN_WFP_OUTBOUND_AUTH_MODE: "platform-outbound-v1",
              WFP_RELAY_AUTHORITY_KEY: authorityWorkerKey,
              CF_ACCOUNT_ID: accountId,
              AI_GATEWAY_ID: "runtime-gateway",
              AI_GATEWAY_MAX_ATTEMPTS: "1",
            },
            durableObjects: {
              WFP_AUTHORITY_REPLAY: {
                className: "WfpAuthorityReplay",
                scriptName: "wfp-platform-runtime",
              },
            },
            outboundService: "wfp-outbound-runtime",
          },
          {
            name: "wfp-outbound-runtime",
            scriptPath: "./crates/wfp-outbound/build/index.js",
            modules: true,
            modulesRules: auxiliaryModuleRules,
            compatibilityDate: "2026-07-11",
            compatibilityFlags: ["nodejs_compat"],
            bindings: {
              CLOUDFLARE_ACCOUNT_ID: accountId,
              CINATOKEN_WFP_OUTBOUND_AI_TOKEN: "runtime-outbound-token",
            },
            outboundService: "wfp-provider-mock",
          },
          {
            name: "wfp-provider-mock",
            scriptPath: "./tests/fixtures/wfp-egress-mock.mjs",
            modules: true,
            compatibilityDate: "2026-07-11",
            compatibilityFlags: ["nodejs_compat"],
            durableObjects: {
              MOCK_EGRESS_COUNTER: "MockEgressCounter",
            },
          },
          {
            name: "realtime-provider-mock",
            scriptPath: "./tests/fixtures/realtime-provider-mock.mjs",
            modules: true,
            compatibilityDate: "2026-07-13",
            durableObjects: {
              MOCK_REALTIME_PROVIDER: "MockRealtimeProvider",
            },
          },
        ],
      },
    }),
  ],
  test: {
    include: ["tests/do-lifecycle-runtime.test.mjs"],
  },
});
