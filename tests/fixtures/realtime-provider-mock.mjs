import { DurableObject } from "cloudflare:workers";

const providerName = "realtime-provider";
const relayStreamSafetyTimeoutMs = 20_000;
const realtimeUsageNullModel = "gpt-runtime-realtime-usage-null";
const nonStreamAuditLimitModel = "gpt-runtime-non-stream-audit-limit";
const zeroReserveModel = "gpt-runtime-zero-reserve";
const flatAuditLimitModel = "gpt-runtime-flat-audit-limit";
const unsetModel = "gpt-runtime-unset-model";
const fixedAudioModel = "tts-runtime-fixed-price";
const pcmAudioModel = "gpt-runtime-tts-pcm";
const oversizedAudioModel = "gpt-runtime-tts-oversized";
const openRouterCostModel = "gpt-4.1";
const cohereConsumedLimitModel = "rerank-runtime-cohere-consumed-limit";

export class MockRealtimeProvider extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__mock/reset" && request.method === "POST") {
      this.releaseRelayStream?.();
      await this.ctx.storage.deleteAll();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/__mock/state" && request.method === "GET") {
      return Response.json(
        (await this.ctx.storage.get("state")) ?? { count: 0 },
      );
    }
    if (
      url.pathname === "/__mock/release-relay-stream" &&
      request.method === "POST"
    ) {
      if (!this.releaseRelayStream?.()) {
        return new Response("No relay stream is waiting", { status: 409 });
      }
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
      if (this.releaseRelayStream) {
        return new Response("Relay stream already active", { status: 409 });
      }
      const requestBody = await request.json().catch(() => ({}));
      if (requestBody.model === openRouterCostModel && requestBody.stream !== true) {
        const previous = (await this.ctx.storage.get("state")) ?? { count: 0 };
        await this.ctx.storage.put("state", {
          count: previous.count + 1,
          method: request.method,
          path: url.pathname,
          authorizationPresent: request.headers.has("authorization"),
          openRouterCost: true,
        });
        return Response.json({
          id: "chatcmpl-runtime-openrouter-cost",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "cost reconstructed" },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 2604,
            completion_tokens: 383,
            total_tokens: 2987,
            prompt_tokens_details: { cached_tokens: 2432 },
            usage_semantic: "anthropic",
            cost: 0.0016464,
          },
        });
      }
      if (
        requestBody.model === nonStreamAuditLimitModel ||
        requestBody.model === zeroReserveModel ||
        requestBody.model === flatAuditLimitModel ||
        requestBody.model === unsetModel
      ) {
        const previous = (await this.ctx.storage.get("state")) ?? { count: 0 };
        const body = JSON.stringify({
          id: "chatcmpl-runtime-audit-limit",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "bounded result" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });
        await this.ctx.storage.put("state", {
          count: previous.count + 1,
          method: request.method,
          path: url.pathname,
          authorizationPresent: request.headers.has("authorization"),
          nonStreamAuditLimit: requestBody.model === nonStreamAuditLimitModel,
          zeroReserve: requestBody.model === zeroReserveModel,
          flatAuditLimit: requestBody.model === flatAuditLimitModel,
          unsetModel: requestBody.model === unsetModel,
        });
        const responseHeaders = { "content-type": "application/json" };
        if (
          requestBody.model !== zeroReserveModel &&
          requestBody.model !== unsetModel
        ) {
          responseHeaders["content-length"] = "2048";
        }
        return new Response(body, {
          headers: responseHeaders,
        });
      }
      const failAfterFirstChunk =
        requestBody.model === "gpt-runtime-stream-error";
      const failAfterUsageChunk =
        requestBody.model === "gpt-runtime-stream-usage-error";
      const previous = (await this.ctx.storage.get("state")) ?? { count: 0 };
      await this.ctx.storage.put("state", {
        count: previous.count + 1,
        method: request.method,
        path: url.pathname,
        authorizationPresent: request.headers.has("authorization"),
        relayStreamHeld: true,
        relayStreamFailurePlanned: failAfterFirstChunk || failAfterUsageChunk,
        relayStreamUsageBeforeFailure: failAfterUsageChunk,
      });
      const encoder = new TextEncoder();
      const provider = this;
      let released = false;
      let safetyTimer;
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              failAfterUsageChunk
                ? 'data: {"id":"chatcmpl-runtime","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hello"}}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n'
                : 'data: {"id":"chatcmpl-runtime","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hello"}}]}\n\n',
            ),
          );
          const release = () => {
            if (released) return false;
            released = true;
            clearTimeout(safetyTimer);
            if (failAfterFirstChunk || failAfterUsageChunk) {
              controller.error(new Error("controlled relay stream failure"));
              provider.releaseRelayStream = null;
              return true;
            }
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
    if (url.pathname === "/v1/audio/speech" && request.method === "POST") {
      const requestBody = await request.json().catch(() => ({}));
      const previous = (await this.ctx.storage.get("state")) ?? { count: 0 };
      await this.ctx.storage.put("state", {
        count: previous.count + 1,
        method: request.method,
        path: url.pathname,
        authorizationPresent: request.headers.has("authorization"),
        fixedAudio: requestBody.model === fixedAudioModel,
        pcmAudio: requestBody.model === pcmAudioModel,
        oversizedAudio: requestBody.model === oversizedAudioModel,
      });
      if (requestBody.model === pcmAudioModel) {
        return new Response(new Uint8Array(48), {
          headers: { "content-type": "audio/pcm" },
        });
      }
      if (requestBody.model === oversizedAudioModel) {
        return new Response(new Uint8Array(1025), {
          headers: { "content-type": "audio/mpeg" },
        });
      }
      return new Response("runtime-audio", {
        headers: { "content-type": "audio/mpeg" },
      });
    }
    if (url.pathname.endsWith("/rerank") && request.method === "POST") {
      const requestBody = await request.json().catch(() => ({}));
      const previous = (await this.ctx.storage.get("state")) ?? { count: 0 };
      await this.ctx.storage.put("state", {
        count: previous.count + 1,
        method: request.method,
        path: url.pathname,
        authorizationPresent: request.headers.has("authorization"),
        cohereConsumedLimit: requestBody.model === cohereConsumedLimitModel,
      });
      if (requestBody.model === cohereConsumedLimitModel) {
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode("x".repeat(2048)));
              controller.close();
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return Response.json({ results: [], meta: { billed_units: {} } });
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
      realtimeModel: url.searchParams.get("model"),
    };
    await this.ctx.storage.put("state", state);

    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    if (url.searchParams.get("model") === realtimeUsageNullModel) {
      let emitted = false;
      server.addEventListener("message", (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (emitted || message?.type !== "response.create") return;
        emitted = true;
        const responseId = "resp_runtime_usage_null";
        server.send(
          JSON.stringify({
            type: "response.created",
            response: { id: responseId, status: "in_progress" },
          }),
        );
        server.send(
          JSON.stringify({
            type: "response.done",
            response: { id: responseId, status: "completed", usage: null },
          }),
        );
      });
      return new Response(null, { status: 101, webSocket: client });
    }
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
