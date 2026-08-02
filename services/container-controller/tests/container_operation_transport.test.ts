import { describe, expect, it } from "vitest";

import {
  dispatchContainerOperationWithLegacyFallback,
  type ContainerOperationTransport,
} from "../src/container_operation_transport";
import type { ContainerOperationHttpResult } from "../src/operation_outcome";

function protocolError(
  status: 415,
  code = "unsupported_media_type",
): ContainerOperationHttpResult {
  return {
    kind: "protocol_error",
    status,
    error: { code, message: code },
  };
}

function operationResponse(): ContainerOperationHttpResult {
  return {
    kind: "outcome",
    outcome: {
      code: "completed",
      classification: null,
      client_artifact: null,
      client_status: null,
      provider_status: null,
      result: null,
      status: "completed",
    },
  };
}

describe("container operation transport negotiation", () => {
  it("keeps legacy JSON as the default transport", async () => {
    const calls: ContainerOperationTransport[] = [];
    const result = await dispatchContainerOperationWithLegacyFallback(
      false,
      async (transport) => {
        calls.push(transport);
        return {
          response: new Response(null, {
            headers: { "content-type": "application/json" },
            status: 200,
          }),
          parsed: operationResponse(),
        };
      },
    );

    expect(calls).toEqual(["json"]);
    expect(result.transport).toBe("json");
  });

  it("uses Protobuf without retry when the runtime supports it", async () => {
    const calls: ContainerOperationTransport[] = [];
    const result = await dispatchContainerOperationWithLegacyFallback(
      true,
      async (transport) => {
        calls.push(transport);
        return {
          response: new Response(null, {
            headers: { "content-type": "application/x-protobuf" },
            status: 200,
          }),
          parsed: operationResponse(),
        };
      },
    );

    expect(calls).toEqual(["protobuf"]);
    expect(result.transport).toBe("protobuf");
  });

  it("retries once with JSON only for the old runtime's exact 415 proof", async () => {
    const calls: ContainerOperationTransport[] = [];
    const result = await dispatchContainerOperationWithLegacyFallback(
      true,
      async (transport) => {
        calls.push(transport);
        if (transport === "protobuf") {
          return {
            response: new Response(null, {
              headers: { "content-type": "application/json; charset=utf-8" },
              status: 415,
            }),
            parsed: protocolError(415),
          };
        }
        return {
          response: new Response(null, {
            headers: { "content-type": "application/json" },
            status: 200,
          }),
          parsed: operationResponse(),
        };
      },
    );

    expect(calls).toEqual(["protobuf", "json"]);
    expect(result.transport).toBe("json");
  });

  it.each([
    {
      name: "a Protobuf 415 body",
      response: new Response(null, {
        headers: { "content-type": "application/x-protobuf" },
        status: 415,
      }),
      parsed: protocolError(415),
    },
    {
      name: "a different JSON error code",
      response: new Response(null, {
        headers: { "content-type": "application/json" },
        status: 415,
      }),
      parsed: protocolError(415, "invalid_request"),
    },
    {
      name: "a missing response media type",
      response: new Response(null, { status: 415 }),
      parsed: protocolError(415),
    },
  ])("does not retry after $name", async ({ response, parsed }) => {
    const calls: ContainerOperationTransport[] = [];
    const result = await dispatchContainerOperationWithLegacyFallback(
      true,
      async (transport) => {
        calls.push(transport);
        return { response, parsed };
      },
    );

    expect(calls).toEqual(["protobuf"]);
    expect(result.transport).toBe("protobuf");
  });

  it("does not retry ambiguous transport failures", async () => {
    const calls: ContainerOperationTransport[] = [];
    await expect(
      dispatchContainerOperationWithLegacyFallback(true, async (transport) => {
        calls.push(transport);
        throw new Error("connection reset");
      }),
    ).rejects.toThrow("connection reset");
    expect(calls).toEqual(["protobuf"]);
  });
});
