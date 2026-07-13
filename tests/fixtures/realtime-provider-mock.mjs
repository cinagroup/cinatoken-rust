import { DurableObject } from "cloudflare:workers";

const providerName = "realtime-provider";

export class MockRealtimeProvider extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__mock/reset" && request.method === "POST") {
      await this.ctx.storage.deleteAll();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/__mock/state" && request.method === "GET") {
      return Response.json((await this.ctx.storage.get("state")) ?? { count: 0 });
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }

    const previous = (await this.ctx.storage.get("state")) ?? { count: 0 };
    const state = {
      count: previous.count + 1,
      method: request.method,
      path: url.pathname,
      authorizationPresent: request.headers.has("authorization"),
    };
    await this.ctx.storage.put("state", state);

    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    this.ctx.waitUntil(
      new Promise((resolve) => {
        setTimeout(() => {
          server.close(1000, "mock runtime detached");
          resolve();
        }, 10);
      }),
    );
    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  fetch(request, env) {
    return env.MOCK_REALTIME_PROVIDER.getByName(providerName).fetch(request);
  },
};
