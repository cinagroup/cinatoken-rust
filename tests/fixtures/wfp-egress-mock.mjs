import { DurableObject } from "cloudflare:workers";

const counterName = "tenant-egress";

export class MockEgressCounter extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__mock/reset" && request.method === "POST") {
      await this.ctx.storage.deleteAll();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/__mock/state" && request.method === "GET") {
      return Response.json(
        (await this.ctx.storage.get("state")) ?? { count: 0 },
      );
    }

    const body = await request.text();
    JSON.parse(body);
    const previous = (await this.ctx.storage.get("state")) ?? { count: 0 };
    const state = {
      count: previous.count + 1,
      method: request.method,
      path: url.pathname,
      authorizationPresent: request.headers.has("authorization"),
      authorizationScheme:
        request.headers.get("authorization")?.split(" ", 1)[0] ?? null,
      authorityPresent: request.headers.has("x-cinatoken-wfp-authority"),
      workerMarkerPresent: request.headers.has("x-cinatoken-wfp-worker"),
      cookiePresent: request.headers.has("cookie"),
      contentType: request.headers.get("content-type"),
      gatewayId: request.headers.get("cf-aig-gateway-id"),
      maxAttempts: request.headers.get("cf-aig-max-attempts"),
      collectLog: request.headers.get("cf-aig-collect-log"),
      metadata: request.headers.get("cf-aig-metadata"),
    };
    await this.ctx.storage.put("state", state);

    return Response.json(
      {
        id: "mock-provider-response",
        object: "response",
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
      {
        headers: {
          "x-request-id": "mock-provider-request",
          "cf-aig-log-id": "must-be-removed",
          "set-cookie": "must-be-removed=true",
          authorization: "Bearer must-be-removed",
        },
      },
    );
  }
}

export default {
  async fetch(request, env) {
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer();
    const forwarded = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body,
    });
    return env.MOCK_EGRESS_COUNTER.getByName(counterName).fetch(forwarded);
  },
};
