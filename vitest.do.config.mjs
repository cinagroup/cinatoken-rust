import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const authoritySecret = "0123456789abcdef0123456789abcdef";
const dispatchConsumptionHistorySecret =
  "history-read-runtime-secret-0123456789abcdef";
const authorityWorker = "tenant-runtime-test";
const accountId = "0123456789abcdef0123456789abcdef";
const compiledWasmModules = [
  {
    type: "CompiledWasm",
    include: ["**/*.wasm"],
    fallthrough: true,
  },
];
const d1Migrations = await readD1Migrations("./migrations/d1");
const d1AdmissionFenceMigrationIndex = d1Migrations.findIndex(
  ({ name }) => name === "0068_relay_container_drain_admission_enforce.sql",
);
if (d1AdmissionFenceMigrationIndex < 0) {
  throw new Error("0068 admission fence migration is missing");
}
const d1MigrationsBeforeAdmissionFence = d1Migrations.slice(
  0,
  d1AdmissionFenceMigrationIndex,
);
const d1AdmissionFenceMigration = d1Migrations.slice(
  d1AdmissionFenceMigrationIndex,
  d1AdmissionFenceMigrationIndex + 1,
);
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
        compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
        modulesRules: compiledWasmModules,
        bindings: {
          WFP_RELAY_AUTHORITY_SECRET: authoritySecret,
          SESSION_SECRET: "runtime-session-secret-0123456789abcdef",
          TASK_RUNNER_DO_ENABLED: "false",
          TASK_POLL_LEASE_ENABLED: "true",
          TASK_POLL_SCHEDULER_ENABLED: "true",
          TASK_POLL_RECOVERY_ENABLED: "true",
          TASK_SUBMIT_TIMEOUT_SECONDS: "90",
          TASK_CLIENT_IDEMPOTENCY_REQUIRED: "true",
          CONTAINER_SCHEDULER_RING_GENERATION: "1",
          CONTAINER_SCHEDULER_SHARD_COUNT: "8",
          CONTAINER_SCHEDULER_ENABLED: "false",
          CONTAINER_SCHEDULER_STAGING_VERIFIED: "false",
          CONTAINER_RECONCILIATION_RETRY_APPLY_ENABLED: "true",
          CONTAINER_TERMINAL_OUTBOX_ENABLED: "true",
          CONTAINER_TERMINAL_OUTBOX_STAGING_VERIFIED: "true",
          CONTAINER_TERMINAL_OUTBOX_SCAN_LIMIT: "4",
          CONTAINER_AUTHORITY_ISSUER: "cinatoken-edge-runtime-test",
          CONTAINER_AUTHORITY_AUDIENCE: "container-terminal-ack-mock",
          CONTAINER_AUTHORITY_CURRENT_KID: "runtime-test-v1",
          CONTAINER_AUTHORITY_CURRENT_SECRET: authoritySecret,
          CONTAINER_PROTOCOL_VERSION: "1",
          RELAY_CONTAINER_SHARD_APPLICATION_DATABASE_IDENTITY_SHA256:
            "c".repeat(64),
          RELAY_CONTAINER_SHARD_PLACEMENT_ACTIVATION_READ_ISSUER:
            "shard-placement-authority-runtime-test",
          RELAY_CONTAINER_SHARD_PLACEMENT_ACTIVATION_READ_AUDIENCE:
            "cinatoken-rust-api-runtime-test",
          RELAY_CONTAINER_SHARD_PLACEMENT_DISPATCH_CONSUMPTION_RECOVERY_READ_ENABLED:
            "true",
          RELAY_CONTAINER_SHARD_PLACEMENT_DISPATCH_CONSUMPTION_RECOVERY_READ_HMAC_CURRENT_KID:
            "dispatch-consumption-recovery-read-runtime-v1",
          RELAY_CONTAINER_SHARD_PLACEMENT_DISPATCH_CONSUMPTION_RECOVERY_READ_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
            "4a".repeat(32),
          RELAY_CONTAINER_SHARD_PLACEMENT_DISPATCH_CONSUMPTION_RECOVERY_READ_HMAC_CURRENT_SECRET:
            dispatchConsumptionHistorySecret,
          RELAY_CONTAINER_SHARD_PLACEMENT_DISPATCH_CONSUMPTION_RECOVERY_RETENTION_SECONDS:
            "2592000",
          CONTAINER_R2_ORPHAN_INVENTORY_ENABLED: "true",
          CONTAINER_R2_ORPHAN_INVENTORY_SCAN_LIMIT: "1",
          CONTAINER_R2_ORPHAN_INVENTORY_GRACE_SECONDS: "0",
          REALTIME_SESSION_V1_ENABLED: "true",
          REALTIME_BILLING_SETTLEMENT_WRITE_ENABLED: "true",
          REALTIME_BILLING_RECONCILIATION_ENABLED: "true",
          REALTIME_BILLING_RECONCILIATION_STAGING_VERIFIED: "false",
          REALTIME_BILLING_RESERVATION_LEASE_SECONDS: "900",
          REALTIME_BILLING_ORPHAN_RECOVERY_ENABLED: "true",
          REALTIME_BILLING_ORPHAN_SWEEP_LIMIT: "1",
          RELAY_BILLING_ORPHAN_RECOVERY_ENABLED: "true",
          RELAY_BILLING_ORPHAN_SWEEP_LIMIT: "32",
          RELAY_BILLING_RESERVATION_LEASE_SECONDS: "300",
          RELAY_BILLING_STREAM_LEASE_HEARTBEAT_SECONDS: "5",
          RELAY_JSON_RESPONSE_LIMIT_BYTES: "1024",
          RELAY_BILLING_PREBIND_OWNER_GENERATION_STAGING_VERIFIED: "false",
          RELAY_BILLING_FINALIZATION_QUEUE_ENABLED: "true",
          RELAY_BILLING_FINALIZATION_RECONCILE_ENABLED: "true",
          RELAY_MISSING_USAGE_ESTIMATE_ENABLED: "true",
          QUOTA_COORD_SHADOW_ENABLED: "true",
          QUOTA_COORD_SHADOW_TOKEN_IDS: "1",
          QUOTA_COORD_RETENTION_VERIFIED: "true",
          QUOTA_COORD_STAGING_VERIFIED: "false",
          TEST_D1_MIGRATIONS: d1Migrations,
          TEST_D1_MIGRATIONS_BEFORE_ADMISSION_FENCE:
            d1MigrationsBeforeAdmissionFence,
          TEST_D1_ADMISSION_FENCE_MIGRATION: d1AdmissionFenceMigration,
        },
        d1Databases: { DB: "do-runtime-test" },
        r2Buckets: ["FILE_BUCKET"],
        kvNamespaces: ["CACHE_KV"],
        queueProducers: {
          BILLING_QUEUE: "cinatoken-rust-billing-finalization-runtime",
        },
        queueConsumers: {
          "cinatoken-rust-billing-finalization-runtime": {
            maxBatchSize: 1,
            maxBatchTimeout: 0,
            maxRetries: 3,
            deadLetterQueue: "cinatoken-rust-billing-finalization-runtime-dlq",
          },
          "cinatoken-rust-billing-finalization-runtime-dlq": {
            maxBatchSize: 1,
            maxBatchTimeout: 0,
            maxRetries: 3,
            deadLetterQueue:
              "cinatoken-rust-billing-finalization-runtime-parking",
          },
        },
        outboundService: "realtime-provider-mock",
        serviceBindings: {
          WFP_TENANT_RUNTIME: "wfp-tenant-runtime",
          WFP_OUTBOUND_RUNTIME: "wfp-outbound-runtime",
          WFP_OUTBOUND_MISSING_CONTEXT: "wfp-outbound-missing-context",
          WFP_OUTBOUND_WRONG_CONTEXT: "wfp-outbound-wrong-context",
          WFP_PROVIDER_MOCK: "wfp-provider-mock",
          REALTIME_PROVIDER_MOCK: "realtime-provider-mock",
          DURABLE_RELAY_RUNTIME: "durable-relay-runtime",
          CONTAINER_CONTROLLER: "container-terminal-ack-mock",
        },
        durableObjects: {
          REALTIME_SESSIONS: {
            className: "RealtimeSession",
            useSQLite: true,
          },
          WFP_AUTHORITY_REPLAY: "WfpAuthorityReplay",
          TASK_RUNNER: "TaskRunner",
          QUOTA_COORD: {
            className: "QuotaCoordinator",
            useSQLite: true,
          },
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
              CF_ACCOUNT_ID: accountId,
              AI_GATEWAY_ID: "runtime-gateway",
              AI_GATEWAY_MAX_ATTEMPTS: "1",
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
              AI_GATEWAY_ID: "runtime-outbound-gateway",
              AI_GATEWAY_MAX_ATTEMPTS: "1",
              AI_GATEWAY_COLLECT_LOG: "true",
              CINATOKEN_WFP_OUTBOUND_CONTEXT: {
                version: 1,
                route_kind: "relay-authority",
                public_worker: authorityWorker,
                dispatch_worker: authorityWorker,
              },
            },
            durableObjects: {
              WFP_AUTHORITY_REPLAY: {
                className: "WfpAuthorityReplay",
                scriptName: "wfp-platform-runtime",
              },
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
            name: "wfp-outbound-missing-context",
            scriptPath: "./crates/wfp-outbound/build/index.js",
            modules: true,
            modulesRules: auxiliaryModuleRules,
            compatibilityDate: "2026-07-11",
            compatibilityFlags: ["nodejs_compat"],
            bindings: {
              CLOUDFLARE_ACCOUNT_ID: accountId,
              CINATOKEN_WFP_OUTBOUND_AI_TOKEN: "runtime-outbound-token",
            },
            durableObjects: {
              WFP_AUTHORITY_REPLAY: {
                className: "WfpAuthorityReplay",
                scriptName: "wfp-platform-runtime",
              },
            },
            outboundService: "wfp-provider-mock",
          },
          {
            name: "wfp-outbound-wrong-context",
            scriptPath: "./crates/wfp-outbound/build/index.js",
            modules: true,
            modulesRules: auxiliaryModuleRules,
            compatibilityDate: "2026-07-11",
            compatibilityFlags: ["nodejs_compat"],
            bindings: {
              CLOUDFLARE_ACCOUNT_ID: accountId,
              CINATOKEN_WFP_OUTBOUND_AI_TOKEN: "runtime-outbound-token",
              CINATOKEN_WFP_OUTBOUND_CONTEXT: {
                version: 1,
                route_kind: "relay-authority",
                public_worker: authorityWorker,
                dispatch_worker: "wrong-runtime-worker",
              },
            },
            durableObjects: {
              WFP_AUTHORITY_REPLAY: {
                className: "WfpAuthorityReplay",
                scriptName: "wfp-platform-runtime",
              },
            },
            outboundService: "wfp-provider-mock",
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
          {
            name: "durable-relay-runtime",
            scriptPath: "./tests/fixtures/do-runtime-worker.mjs",
            modules: true,
            modulesRules: auxiliaryModuleRules,
            compatibilityDate: "2026-07-13",
            compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
            bindings: {
              RELAY_BILLING_RESERVATION_LEASE_SECONDS: "300",
              RELAY_BILLING_STREAM_LEASE_HEARTBEAT_SECONDS: "5",
              RELAY_BILLING_FINALIZATION_QUEUE_ENABLED: "true",
              RELAY_MISSING_USAGE_ESTIMATE_ENABLED: "true",
              RELAY_HTTP_STREAM_DURABLE_HANDOFF_ENABLED: "true",
              RELAY_HTTP_STREAM_DURABLE_HANDOFF_STAGING_VERIFIED: "true",
              RELAY_HTTP_STREAM_OUTBOX_ENABLED: "true",
              RELAY_HTTP_STREAM_RECOVERY_ENABLED: "true",
            },
            d1Databases: { DB: "do-runtime-test" },
            queueProducers: {
              BILLING_QUEUE: "cinatoken-rust-billing-finalization-runtime",
            },
            versionMetadata: "CF_VERSION_METADATA",
            outboundService: "realtime-provider-mock",
          },
          {
            name: "container-terminal-ack-mock",
            scriptPath: "./tests/fixtures/container-terminal-ack-mock.mjs",
            modules: true,
            compatibilityDate: "2026-07-13",
          },
        ],
      },
    }),
  ],
  test: {
    include: ["tests/do-lifecycle-runtime.test.mjs"],
  },
});
