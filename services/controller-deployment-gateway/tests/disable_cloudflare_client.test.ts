import { describe, expect, it } from "vitest";

import {
  buildDisableDeploymentMutation,
  createDisableDeploymentOnce,
  readDisableDeploymentStatus,
  type DisableCloudflareClientDependencies,
} from "../src/disable_cloudflare_client";
import { disableCommandFixture } from "./disable_fixtures";

const cloudflareEnv = {
  CLOUDFLARE_ACCOUNT_ID: "account-test",
  CLOUDFLARE_DEPLOY_API_TOKEN: "deploy-token-00000000000000000000",
  CLOUDFLARE_READ_API_TOKEN: "read-token-000000000000000000000",
};

describe("controller deployment disable Cloudflare client", () => {
  it("builds the canonical baseline-100 mutation and bound annotation", async () => {
    const command = disableCommandFixture();
    const mutation = await buildDisableDeploymentMutation(
      cloudflareEnv.CLOUDFLARE_ACCOUNT_ID,
      command,
    );
    expect(mutation.mutationAnnotation).toBe(
      `cinatoken-controller-disable-v1:${command.operation14IdSha256}:` +
      mutation.intentDigestSha256,
    );
    expect(JSON.parse(mutation.body)).toEqual({
      annotations: {
        "workers/message": mutation.mutationAnnotation,
      },
      strategy: "percentage",
      versions: [
        {
          percentage: 100,
          version_id: command.controllerBaselineTargetVersionId,
        },
      ],
    });
  });

  it("sends exactly one POST and accepts only the exact disable response", async () => {
    const command = disableCommandFixture();
    const mutation = await buildDisableDeploymentMutation(
      cloudflareEnv.CLOUDFLARE_ACCOUNT_ID,
      command,
    );
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const outcome = await createDisableDeploymentOnce(
      cloudflareEnv,
      command,
      mutation,
      dependencies(async (input, init) => {
        calls.push({ input: String(input), init });
        return deploymentResponse(command, mutation.mutationAnnotation);
      }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.body).toBe(mutation.body);
    expect(outcome).toMatchObject({
      classification: "accepted",
      httpStatus: 200,
    });
  });

  it("never retries transport, rate-limit, or malformed success outcomes", async () => {
    const command = disableCommandFixture();
    const mutation = await buildDisableDeploymentMutation(
      cloudflareEnv.CLOUDFLARE_ACCOUNT_ID,
      command,
    );
    let transportCalls = 0;
    const transport = await createDisableDeploymentOnce(
      cloudflareEnv,
      command,
      mutation,
      dependencies(async () => {
        transportCalls += 1;
        throw new Error("connection lost");
      }),
    );
    expect(transportCalls).toBe(1);
    expect(transport.classification).toBe("ambiguous");

    let rateLimitCalls = 0;
    const rateLimit = await createDisableDeploymentOnce(
      cloudflareEnv,
      command,
      mutation,
      dependencies(async () => {
        rateLimitCalls += 1;
        return json({ success: false }, 429);
      }),
    );
    expect(rateLimitCalls).toBe(1);
    expect(rateLimit.classification).toBe("ambiguous");

    const wrongAnnotation = await createDisableDeploymentOnce(
      cloudflareEnv,
      command,
      mutation,
      dependencies(async () => deploymentResponse(command, "manual")),
    );
    expect(wrongAnnotation.classification).toBe("ambiguous");
  });

  it("uses only two GETs and recognizes the exact disable target", async () => {
    const command = disableCommandFixture();
    const mutation = await buildDisableDeploymentMutation(
      cloudflareEnv.CLOUDFLARE_ACCOUNT_ID,
      command,
    );
    const methods: string[] = [];
    const observation = await readDisableDeploymentStatus(
      cloudflareEnv,
      command,
      dependencies(async (input, init) => {
        methods.push(init?.method ?? "GET");
        if (String(input).endsWith("/deployments")) {
          return deploymentsResponse(command, mutation.mutationAnnotation);
        }
        return json({
          success: true,
          result: { id: command.controllerBaselineTargetVersionId },
        });
      }),
    );
    expect(methods).toEqual(["GET", "GET"]);
    expect(observation.classification).toBe("exact_disable_observed");
    expect(observation.deploymentSetSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(observation.baselineVersionSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps successful state evidence stable across irrelevant version fields", async () => {
    const command = disableCommandFixture();
    const mutation = await buildDisableDeploymentMutation(
      cloudflareEnv.CLOUDFLARE_ACCOUNT_ID,
      command,
    );
    const readWithMetadata = async (metadata: string) =>
      readDisableDeploymentStatus(
        cloudflareEnv,
        command,
        dependencies(async (input) => {
          if (String(input).endsWith("/deployments")) {
            return deploymentsResponse(command, mutation.mutationAnnotation);
          }
          return json({
            success: true,
            result: {
              id: command.controllerBaselineTargetVersionId,
              metadata,
            },
          });
        }),
      );
    const first = await readWithMetadata("first");
    const second = await readWithMetadata("second");
    expect(first.baselineVersionSha256).toBe(second.baselineVersionSha256);
  });

  it("rejects baseline 100 under a different annotation", async () => {
    const command = disableCommandFixture();
    const observation = await readDisableDeploymentStatus(
      cloudflareEnv,
      command,
      dependencies(async (input) => {
        if (String(input).endsWith("/deployments")) {
          return deploymentsResponse(command, "manual-disable");
        }
        return json({
          success: true,
          result: { id: command.controllerBaselineTargetVersionId },
        });
      }),
    );
    expect(observation.classification).toBe("deployment_drift");
  });

  it("distinguishes the enabled source and requires readable baseline", async () => {
    const command = disableCommandFixture();
    const source = await readDisableDeploymentStatus(
      cloudflareEnv,
      command,
      dependencies(async (input) => {
        if (String(input).endsWith("/deployments")) {
          return json({
            success: true,
            result: {
              deployments: [{
                annotations: { "workers/message": "enable-operation" },
                created_on: "2026-07-29T00:00:05.000Z",
                versions: [{
                  percentage: 100,
                  version_id: command.controllerEnabledSourceVersionId,
                }],
              }],
            },
          });
        }
        return json({
          success: true,
          result: { id: command.controllerBaselineTargetVersionId },
        });
      }),
    );
    expect(source.classification).toBe("enabled_source_observed");

    const unreadable = await readDisableDeploymentStatus(
      cloudflareEnv,
      command,
      dependencies(async (input) => {
        if (String(input).endsWith("/deployments")) {
          return deploymentsResponse(command, "irrelevant");
        }
        return json({ success: true, result: { id: "other-version" } });
      }),
    );
    expect(unreadable.classification).toBe("ambiguous");
  });

  it("fails closed on missing credentials and oversized evidence", async () => {
    const command = disableCommandFixture();
    const missing = await readDisableDeploymentStatus(
      { CLOUDFLARE_ACCOUNT_ID: "account-test" },
      command,
      dependencies(async () => {
        throw new Error("must not be called");
      }),
    );
    expect(missing.classification).toBe("ambiguous");

    const oversized = await readDisableDeploymentStatus(
      cloudflareEnv,
      command,
      dependencies(async () => new Response("x", {
        status: 200,
        headers: { "content-length": "65537" },
      })),
    );
    expect(oversized.classification).toBe("ambiguous");
  });
});

function dependencies(
  fetchImplementation: DisableCloudflareClientDependencies["fetch"],
): DisableCloudflareClientDependencies {
  return {
    fetch: fetchImplementation,
    now: () => Date.parse("2026-07-29T00:00:00.000Z"),
  };
}

function deploymentResponse(
  command: ReturnType<typeof disableCommandFixture>,
  annotation: string,
): Response {
  return json({
    success: true,
    result: {
      id: "disable-deployment-1",
      strategy: "percentage",
      annotations: { "workers/message": annotation },
      versions: [{
        percentage: 100,
        version_id: command.controllerBaselineTargetVersionId,
      }],
    },
  });
}

function deploymentsResponse(
  command: ReturnType<typeof disableCommandFixture>,
  annotation: string,
): Response {
  return json({
    success: true,
    result: {
      deployments: [{
        annotations: { "workers/message": annotation },
        created_on: "2026-07-29T00:00:05.000Z",
        versions: [{
          percentage: 100,
          version_id: command.controllerBaselineTargetVersionId,
        }],
      }],
    },
  });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "cf-ray": `disable-ray-${status}` },
  });
}
