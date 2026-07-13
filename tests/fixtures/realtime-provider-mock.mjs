import { DurableObject } from "cloudflare:workers";

const providerName = "realtime-provider";
const relayStreamSafetyTimeoutMs = 20_000;

export class MockRealtimeProvider extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__mock/reset" && request.method === "POST") {
      this.releaseRelayStream?.();
      await this.ctx.storage.deleteAll();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/__mock/state" && request.method === "GET") {
      return Response.json((await this.ctx.storage.get("state")) ?? { count: 0 });
    }
    if (url.pathname === "/__mock/release-relay-stream" && request.method === "POST") {
      if (!this.releaseRelayStream?.()) {
        return new Response("No relay stream is waiting", { status: 409 });
      }
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
      if (this.releaseRelayStream) {
        return new Response("Relay stream already active", { status: 409 });
      }
      const previous = (await this.ctx.storage.get("state")) ?? { count: 0 };
      await this.ctx.storage.put("state", {
        count: previous.count + 1,
        method: request.method,
        path: url.pathname,
        authorizationPresent: request.headers.has("authorization"),
        relayStreamHeld: true,
      });
      const encoder = new TextEncoder();
      const provider = this;
      let released = false;
      let safetyTimer;
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"id":"chatcmpl-runtime","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hello"}}]}\n\n',
            ),
          );
          const release = () => {
            if (released) return false;
            released = true;
            clearTimeout(safetyTimer);
            controller.enqueue(
              encoder.encode(
                'data: {"id":"chatcmpl-runtime","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
              ),
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
            provider.releaseRelayStream = null;
            return true;
          };
          provider.releaseRelayStream = release;
          safetyTimer = setTimeout(release, relayStreamSafetyTimeoutMs);
        },
        cancel() {
          released = true;
          clearTimeout(safetyTimer);
          provider.releaseRelayStream = null;
        },
      });
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
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
