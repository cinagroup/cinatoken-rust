import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { build } from "esbuild";
import { kCurrentWorker } from "miniflare";
import path from "node:path";
import { defineConfig } from "vitest/config";

import {
  createSourceAuthenticationFixture,
} from "../../tests/fixtures/container-runtime-json-compatibility-source-authentication.mjs";

const d1Migrations = await readD1Migrations("./migrations");
const sourceVerifierBundlePath = path.resolve(
  ".wrangler/runtime-source-verifier/index.mjs",
);
await build({
  entryPoints: [
    "../container-runtime-json-compatibility-source-verifier/src/index.ts",
  ],
  outfile: sourceVerifierBundlePath,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  external: ["cloudflare:workers", "node:*"],
  define: {
    "import.meta.main": "false",
    "import.meta.url": '"file:///worker/index.mjs"',
  },
  logLevel: "silent",
});
const sourceFixture = await createSourceAuthenticationFixture({
  now: Math.floor(Date.now() / 1000),
  operationSeed: "deployment-transition-workerd-operation",
});
const invocation = {
  campaignPlan: sourceFixture.campaignPlan,
  statePlan: sourceFixture.statePlan,
  authorizedTransition: sourceFixture.authorizedTransition,
};
const mockWorkerName = "json-compatibility-deployment-transition-rpc-mock";
const sourceVerifierWorkerName =
  "json-compatibility-deployment-transition-source-verifier";
const sourceVerifierProxyWorkerName =
  "json-compatibility-deployment-transition-source-verifier-proxy";
const sourceBucketName =
  "json-compatibility-deployment-transition-source-runtime-test";
const moduleRules = [
  {
    type: "ESModule" as const,
    include: ["**/*.js", "**/*.mjs"],
    fallthrough: true,
  },
];

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      miniflare: {
        compatibilityDate: "2026-07-15",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          TEST_D1_MIGRATIONS: d1Migrations,
          TEST_TRANSITION_INVOCATION: JSON.stringify(invocation),
          TEST_SOURCE_AUTHENTICATION_BUNDLE: sourceFixture.bundleBody,
          TEST_SOURCE_AUTHENTICATION_BUNDLE_KEY: sourceFixture.bundleKey,
          TEST_SOURCE_AUTHENTICATION_BUNDLE_SHA256:
            sourceFixture.bundle.bundleSha256,
          TEST_SOURCE_SIGNATURE_ENVELOPE_SHA256:
            sourceFixture.sourceSignatureEnvelopeSha256,
          CF_VERSION_METADATA: {
            id: "deployment-transition-runtime-version-001",
            tag: "runtime-test",
            timestamp: "2026-08-05T00:00:00.000Z",
          },
          ENVIRONMENT: "staging",
          JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_ENABLED: "true",
          JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_EXECUTION_ENABLED: "true",
          JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_STATUS_READ_ENABLED: "true",
          JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_PROFILE_VERSION: "1",
          JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_SERVICE_NAME:
            "cinatoken-container-runtime-json-compatibility-deployment-transition-staging",
          JSON_COMPATIBILITY_DEPLOYMENT_LEAF_SERVICE_NAME:
            "cinatoken-container-runtime-json-compatibility-deployment-leaf-staging",
          JSON_COMPATIBILITY_SOURCE_VERIFIER_SERVICE_NAME:
            "cinatoken-container-runtime-json-compatibility-source-verifier-staging",
        },
        d1Databases: {
          DB: "json-compatibility-deployment-transition-runtime-test",
        },
        serviceBindings: {
          JSON_COMPATIBILITY_DEPLOYMENT_LEAF: {
            name: mockWorkerName,
            entrypoint: "JsonCompatibilityDeploymentLeafEntrypoint",
          },
          JSON_COMPATIBILITY_SOURCE_VERIFIER: {
            name: sourceVerifierProxyWorkerName,
            entrypoint: "JsonCompatibilitySourceVerifierProxyEntrypoint",
          },
          JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_NAMED: {
            name: kCurrentWorker,
            entrypoint: "JsonCompatibilityDeploymentTransitionEntrypoint",
          },
          JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_MOCK_CONTROL: {
            name: mockWorkerName,
            entrypoint:
              "JsonCompatibilityDeploymentTransitionMockControlEntrypoint",
          },
          JSON_COMPATIBILITY_SOURCE_VERIFIER_PROXY_CONTROL: {
            name: sourceVerifierProxyWorkerName,
            entrypoint:
              "JsonCompatibilitySourceVerifierProxyControlEntrypoint",
          },
        },
        r2Buckets: {
          TEST_SOURCE_AUTHENTICATION_BUCKET: sourceBucketName,
        },
        workers: [
          {
            name: mockWorkerName,
            scriptPath: "./tests/fixtures/deployment-rpc-mock.mjs",
            modules: true,
            modulesRules: moduleRules,
            compatibilityDate: "2026-07-15",
            compatibilityFlags: ["nodejs_compat"],
          },
          {
            name: sourceVerifierWorkerName,
            scriptPath: sourceVerifierBundlePath,
            modules: true,
            modulesRules: moduleRules,
            compatibilityDate: "2026-07-15",
            compatibilityFlags: ["nodejs_compat"],
            bindings: {
              CF_VERSION_METADATA: {
                id: "source-verifier-integration-version-001",
                tag: "runtime-integration-test",
                timestamp: "2026-08-05T00:00:00.000Z",
              },
              ENVIRONMENT: "staging",
              JSON_COMPATIBILITY_SOURCE_VERIFIER_ENABLED: "true",
              JSON_COMPATIBILITY_SOURCE_VERIFIER_R2_READ_ENABLED: "true",
              JSON_COMPATIBILITY_SOURCE_VERIFIER_PROFILE_VERSION: "1",
              JSON_COMPATIBILITY_SOURCE_VERIFIER_SERVICE_NAME:
                "cinatoken-container-runtime-json-compatibility-source-verifier-staging",
              JSON_COMPATIBILITY_SOURCE_BUNDLE_KEY_PREFIX:
                "container-runtime/json-compatibility/source-authentication/v2/sha256",
              JSON_COMPATIBILITY_SOURCE_SIGNATURE_ISSUER:
                "cinatoken-json-compatibility-source-archive-authority-staging",
              JSON_COMPATIBILITY_SOURCE_SIGNATURE_AUDIENCE:
                "cinatoken-container-runtime-json-compatibility-source-verifier-staging",
              JSON_COMPATIBILITY_SOURCE_CURRENT_KID:
                sourceFixture.sourcePolicyCurrent.keyId,
              JSON_COMPATIBILITY_SOURCE_CURRENT_SPKI_SHA256:
                sourceFixture.sourcePolicyCurrent.spkiSha256,
              JSON_COMPATIBILITY_SOURCE_PREVIOUS_KID:
                sourceFixture.sourcePolicyPrevious?.keyId ?? "",
              JSON_COMPATIBILITY_SOURCE_PREVIOUS_SPKI_SHA256:
                sourceFixture.sourcePolicyPrevious?.spkiSha256 ?? "",
              JSON_COMPATIBILITY_SOURCE_PREVIOUS_ACCEPT_UNTIL:
                sourceFixture.sourcePolicyPrevious === null
                  ? ""
                  : String(sourceFixture.sourcePolicyPrevious.acceptUntil),
            },
            r2Buckets: {
              SOURCE_AUTHENTICATION_BUCKET: sourceBucketName,
            },
          },
          {
            name: sourceVerifierProxyWorkerName,
            scriptPath: "./tests/fixtures/source-verifier-rpc-proxy.mjs",
            modules: true,
            modulesRules: moduleRules,
            compatibilityDate: "2026-07-15",
            compatibilityFlags: ["nodejs_compat"],
            serviceBindings: {
              JSON_COMPATIBILITY_SOURCE_VERIFIER_ACTUAL: {
                name: sourceVerifierWorkerName,
                entrypoint: "JsonCompatibilitySourceVerifierEntrypoint",
              },
            },
          },
        ],
      },
    }),
  ],
  test: {
    include: ["tests/**/*.runtime.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 30_000,
  },
});
