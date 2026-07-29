import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const d1Migrations = await readD1Migrations(
  "./services/controller-deployment-gateway/migrations",
);

let mutationAnnotation = "";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./services/controller-deployment-gateway/src/index.ts",
      miniflare: {
        compatibilityDate: "2026-07-15",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          TEST_D1_MIGRATIONS: d1Migrations,
          CF_VERSION_METADATA: {
            id: "gateway-runtime-test-version",
            tag: "runtime-test",
            timestamp: "2026-07-29T00:00:00.000Z",
          },
          ENVIRONMENT: "staging",
          CONTROLLER_DEPLOYMENT_GATEWAY_ENABLED: "true",
          CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_ENABLED: "true",
          CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_READ_ENABLED: "true",
          CONTROLLER_DEPLOYMENT_GATEWAY_REMOTE_MUTATION_ENABLED: "true",
          CONTROLLER_DEPLOYMENT_GATEWAY_REMOTE_READ_ENABLED: "true",
          CONTROLLER_DEPLOYMENT_GATEWAY_PROFILE_VERSION: "1",
          CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_STABILITY_MIN_SECONDS: "5",
          CONTROLLER_DEPLOYMENT_GATEWAY_CONTROLLER_SERVICE_NAME:
            "cinatoken-container-controller-staging",
          CONTROLLER_DEPLOYMENT_GATEWAY_ISSUER:
            "cinatoken-shard-placement-authority-runtime-test",
          CONTROLLER_DEPLOYMENT_GATEWAY_AUDIENCE:
            "cinatoken-controller-deployment-gateway-runtime-test",
          CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_CURRENT_KID:
            "create-runtime-v1",
          CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
            "a".repeat(64),
          CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_CURRENT_SECRET:
            "create-runtime-secret-00000000000000000000000000000000",
          CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_PREVIOUS_KID: "",
          CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256:
            "",
          CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_CURRENT_KID:
            "status-runtime-v1",
          CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
            "b".repeat(64),
          CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_CURRENT_SECRET:
            "status-runtime-secret-00000000000000000000000000000000",
          CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_PREVIOUS_KID: "",
          CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256:
            "",
          CLOUDFLARE_ACCOUNT_ID: "runtime-account",
          CLOUDFLARE_ACCOUNT_ID_SHA256:
            "a08a18f7b04242b55832d7f670379665138e201233b168650f0c3cbefbec1ebe",
          CLOUDFLARE_DEPLOY_API_TOKEN:
            "runtime-deploy-token-00000000000000000000",
          CLOUDFLARE_READ_API_TOKEN:
            "runtime-read-token-0000000000000000000000",
        },
        d1Databases: {
          DB: "controller-deployment-gateway-runtime-test",
        },
        outboundService: async (request) => {
            const url = new URL(request.url);
            if (
              request.method === "POST"
              && url.pathname.endsWith("/deployments")
            ) {
              const body = await request.json();
              mutationAnnotation = body.annotations["workers/message"];
              return Response.json(
                {
                  success: true,
                  result: {
                    id: "runtime-deployment-1",
                    strategy: "percentage",
                    annotations: {
                      "workers/message": mutationAnnotation,
                    },
                    versions: [
                      {
                        version_id: "controller-enabled-version",
                        percentage: 100,
                      },
                    ],
                  },
                },
                {
                  status: 200,
                  headers: { "cf-ray": "runtime-create-ray" },
                },
              );
            }
            if (
              request.method === "GET"
              && url.pathname.endsWith("/deployments")
            ) {
              return Response.json(
                {
                  success: true,
                  result: {
                    deployments: [
                      {
                        created_on: "2026-07-29T00:00:05.000Z",
                        annotations: {
                          "workers/message": mutationAnnotation,
                        },
                        versions: [
                          {
                            version_id: "controller-enabled-version",
                            percentage: 100,
                          },
                        ],
                      },
                    ],
                  },
                },
                {
                  status: 200,
                  headers: { "cf-ray": "runtime-status-ray" },
                },
              );
            }
            if (
              request.method === "GET"
              && url.pathname.endsWith("/versions/controller-enabled-version")
            ) {
              return Response.json(
                {
                  success: true,
                  result: { id: "controller-enabled-version" },
                },
                {
                  status: 200,
                  headers: { "cf-ray": "runtime-version-ray" },
                },
              );
            }
            return Response.json(
              { success: false, errors: [{ code: 1000 }] },
              { status: 404 },
            );
        },
      },
    }),
  ],
  test: {
    include: ["tests/controller-deployment-gateway-runtime.test.mjs"],
    testTimeout: 30_000,
  },
});
