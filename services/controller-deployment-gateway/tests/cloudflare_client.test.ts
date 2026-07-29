import { describe, expect, it } from "vitest";

import {
  buildDeploymentMutation,
  createDeploymentOnce,
  readDeploymentStatus,
} from "../src/cloudflare_client";
import { commandFixture } from "./fixtures";

const cloudflareEnv = {
  CLOUDFLARE_ACCOUNT_ID: "account-test",
  CLOUDFLARE_DEPLOY_API_TOKEN: "deploy-token-00000000000000000000",
  CLOUDFLARE_READ_API_TOKEN: "read-token-000000000000000000000",
};

describe("controller deployment Cloudflare client", () => {
  it("sends one canonical deployment mutation and classifies a valid result", async () => {
    const command = commandFixture();
    const mutation = await buildDeploymentMutation(
      cloudflareEnv.CLOUDFLARE_ACCOUNT_ID,
      command,
    );
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const outcome = await createDeploymentOnce(
      cloudflareEnv,
      command,
      mutation,
      {
        fetch: async (input, init) => {
          calls.push({ input: String(input), init });
          return new Response(
            JSON.stringify({
              success: true,
              result: {
                id: "deployment-1",
                strategy: "percentage",
                annotations: {
                  "workers/message": mutation.mutationAnnotation,
                },
                versions: [
                  {
                    version_id: command.controllerEnabledVersionId,
                    percentage: 100,
                  },
                ],
              },
            }),
            {
              status: 200,
              headers: { "cf-ray": "ray-1" },
            },
          );
        },
      },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.body).toBe(mutation.body);
    expect(JSON.parse(mutation.body)).toEqual({
      annotations: {
        "workers/message": mutation.mutationAnnotation,
      },
      strategy: "percentage",
      versions: [
        {
          percentage: 100,
          version_id: command.controllerEnabledVersionId,
        },
      ],
    });
    expect(outcome).toMatchObject({
      classification: "accepted",
      httpStatus: 200,
    });
  });

  it("never retries ambiguous transport or HTTP outcomes", async () => {
    const command = commandFixture();
    const mutation = await buildDeploymentMutation(
      cloudflareEnv.CLOUDFLARE_ACCOUNT_ID,
      command,
    );
    let transportCalls = 0;
    const transport = await createDeploymentOnce(
      cloudflareEnv,
      command,
      mutation,
      {
        fetch: async () => {
          transportCalls += 1;
          throw new Error("connection lost");
        },
      },
    );
    expect(transportCalls).toBe(1);
    expect(transport.classification).toBe("ambiguous");

    let rateLimitCalls = 0;
    const rateLimited = await createDeploymentOnce(
      cloudflareEnv,
      command,
      mutation,
      {
        fetch: async () => {
          rateLimitCalls += 1;
          return new Response(
            JSON.stringify({ success: false, errors: [{ code: 10000 }] }),
            { status: 429 },
          );
        },
      },
    );
    expect(rateLimitCalls).toBe(1);
    expect(rateLimited.classification).toBe("ambiguous");
  });

  it("treats compressed or structurally incomplete success as ambiguous", async () => {
    const command = commandFixture();
    const mutation = await buildDeploymentMutation(
      cloudflareEnv.CLOUDFLARE_ACCOUNT_ID,
      command,
    );
    const compressed = await createDeploymentOnce(
      cloudflareEnv,
      command,
      mutation,
      {
        fetch: async () => new Response(
          JSON.stringify({ success: true, result: { id: "deployment-1" } }),
          {
            status: 200,
            headers: { "content-encoding": "gzip" },
          },
        ),
      },
    );
    expect(compressed.classification).toBe("ambiguous");

    const incomplete = await createDeploymentOnce(
      cloudflareEnv,
      command,
      mutation,
      {
        fetch: async () => json({
          success: true,
          result: { id: "deployment-1" },
        }),
      },
    );
    expect(incomplete.classification).toBe("ambiguous");
  });

  it("uses status-only GETs and requires target, 100 percent, and annotation", async () => {
    const command = commandFixture();
    const mutation = await buildDeploymentMutation(
      cloudflareEnv.CLOUDFLARE_ACCOUNT_ID,
      command,
    );
    const methods: string[] = [];
    const observation = await readDeploymentStatus(
      cloudflareEnv,
      command,
      {
        fetch: async (input, init) => {
          methods.push(init?.method ?? "GET");
          const url = String(input);
          if (url.endsWith("/deployments")) {
            return json({
              success: true,
              result: {
                deployments: [
                  {
                    created_on: "2026-07-29T00:00:00.000Z",
                    annotations: {
                      "workers/message": "older-deployment",
                    },
                    versions: [
                      {
                        version_id: command.controllerBaselineVersionId,
                        percentage: 100,
                      },
                    ],
                  },
                  {
                    created_on: "2026-07-29T00:00:05.000Z",
                    annotations: {
                      "workers/message": mutation.mutationAnnotation,
                    },
                    versions: [
                      {
                        version_id: command.controllerEnabledVersionId,
                        percentage: 100,
                      },
                    ],
                  },
                ],
              },
            });
          }
          return json({
            success: true,
            result: { id: command.controllerEnabledVersionId },
          });
        },
      },
    );
    expect(methods).toEqual(["GET", "GET"]);
    expect(observation.classification).toBe("target_observed");
  });

  it("does not accept a target deployed under another mutation annotation", async () => {
    const command = commandFixture();
    const observation = await readDeploymentStatus(
      cloudflareEnv,
      command,
      {
        fetch: async (input) => {
          if (String(input).endsWith("/deployments")) {
            return json({
              success: true,
              result: {
                deployments: [
                  {
                    created_on: "2026-07-29T00:00:05.000Z",
                    annotations: {
                      "workers/message": "manual-deployment",
                    },
                    versions: [
                      {
                        version_id: command.controllerEnabledVersionId,
                        percentage: 100,
                      },
                    ],
                  },
                ],
              },
            });
          }
          return json({
            success: true,
            result: { id: command.controllerEnabledVersionId },
          });
        },
      },
    );
    expect(observation.classification).toBe("deployment_drift");
  });

  it("treats malformed deployment and version success bodies as ambiguous", async () => {
    const command = commandFixture();
    const observation = await readDeploymentStatus(
      cloudflareEnv,
      command,
      {
        fetch: async (input) => {
          if (String(input).endsWith("/deployments")) {
            return json({ success: true, result: { deployments: [] } });
          }
          return json({
            success: true,
            result: { id: "different-version" },
          });
        },
      },
    );
    expect(observation.classification).toBe("ambiguous");
  });
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "cf-ray": `ray-${status}` },
  });
}
