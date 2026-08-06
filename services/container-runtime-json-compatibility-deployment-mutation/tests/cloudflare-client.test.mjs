import { beforeAll, describe, expect, test, vi } from "vitest";

import {
  MAX_RESPONSE_BYTES,
  REQUEST_DEADLINE_MILLISECONDS,
  postDeploymentMutationOnce,
} from "../src/cloudflare_client.ts";
import { prepareDeploymentMutation } from "../src/protocol.ts";
import {
  acceptedCloudflareResponse,
  createMutationEnvelopeFixture,
} from "./fixtures/mutation-envelope.mjs";

const TOKEN = "test-deployment-mutation-token-000000000000";
let mutation;

beforeAll(async () => {
  const fixture = await createMutationEnvelopeFixture({
    operationSeed: "client-tests",
  });
  mutation = await prepareDeploymentMutation({
    accountId: fixture.accountId,
    accountIdSha256: fixture.accountIdSha256,
    serviceName:
      "cinatoken-container-runtime-json-compatibility-deployment-mutation-staging",
    entrypoint: "JsonCompatibilityDeploymentMutationEntrypoint",
    versionId: fixture.versionId,
    profileVersion: 1,
    credentialIdSha256: fixture.credentialIdSha256,
  }, fixture.envelope, fixture.now);
});

describe("Cloudflare deployment mutation client", () => {
  test("sends one fixed POST and accepts only an exact create response", async () => {
    const fetch = vi.fn(async (_input, init) => {
      expect(init.method).toBe("POST");
      expect(init.redirect).toBe("manual");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.body).toBe(mutation.requestBody);
      const body = JSON.parse(init.body);
      expect(body).toEqual({
        annotations: { "workers/message": mutation.mutationAnnotation },
        strategy: "percentage",
        versions: [{ percentage: 100, version_id: mutation.targetVersionId }],
      });
      expect(body).not.toHaveProperty("force");
      return acceptedCloudflareResponse(mutation);
    });
    const outcome = await postDeploymentMutationOnce(
      TOKEN,
      mutation,
      { fetch },
    );
    expect(outcome.classification).toBe("accepted");
    expect(outcome.httpStatus).toBe(201);
    expect(outcome.responseBytes).toBeGreaterThan(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(REQUEST_DEADLINE_MILLISECONDS).toBe(3_000);
  });

  test("classifies a well-formed deterministic 4xx as rejected", async () => {
    const response = new Response(JSON.stringify({
      success: false,
      errors: [{ code: 10090, message: "deployment rejected" }],
      messages: [],
      result: null,
    }), { status: 400 });
    const outcome = await postDeploymentMutationOnce(
      TOKEN,
      mutation,
      { fetch: async () => response },
    );
    expect(outcome.classification).toBe("rejected");
    expect(outcome.httpStatus).toBe(400);
  });

  test.each([408, 425, 429, 500, 503])(
    "classifies HTTP %i as ambiguous without retry",
    async (status) => {
      const fetch = vi.fn(async () => new Response(JSON.stringify({
        success: false,
        errors: [{ code: status, message: "uncertain" }],
      }), { status }));
      const outcome = await postDeploymentMutationOnce(
        TOKEN,
        mutation,
        { fetch },
      );
      expect(outcome.classification).toBe("ambiguous");
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  test("treats transport and response-format failures as ambiguous", async () => {
    const transport = await postDeploymentMutationOnce(
      TOKEN,
      mutation,
      { fetch: async () => { throw new Error("response lost"); } },
    );
    const malformed = await postDeploymentMutationOnce(
      TOKEN,
      mutation,
      { fetch: async () => new Response("not-json", { status: 201 }) },
    );
    const malformedRejection = await postDeploymentMutationOnce(
      TOKEN,
      mutation,
      { fetch: async () => new Response("not-json", { status: 400 }) },
    );
    expect(transport.classification).toBe("ambiguous");
    expect(malformed.classification).toBe("ambiguous");
    expect(malformedRejection.classification).toBe("ambiguous");
  });

  test("cancels evidence that exceeds the 64 KiB response bound", async () => {
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_RESPONSE_BYTES));
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    }), {
      status: 201,
    });
    const outcome = await postDeploymentMutationOnce(
      TOKEN,
      mutation,
      { fetch: async () => response },
    );
    expect(outcome).toMatchObject({
      classification: "ambiguous",
      httpStatus: 201,
      responseBodySha256: null,
      responseBytes: null,
    });
  });
});
