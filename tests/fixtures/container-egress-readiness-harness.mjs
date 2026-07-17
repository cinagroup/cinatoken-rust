const bindings = {
  "/ready": "BROKER_READY",
  "/disabled": "BROKER_DISABLED",
  "/missing-model": "BROKER_MISSING_MODEL",
  "/missing-secret": "BROKER_MISSING_SECRET",
};

export default {
  async fetch(request, env) {
    const bindingName = bindings[new URL(request.url).pathname];
    if (!bindingName) return new Response("not found", { status: 404 });
    return env[bindingName].fetch(
      new Request(
        "https://provider-egress.cinatoken.internal/internal/v1/provider-egress/readiness",
        {
          method: request.method,
          headers: request.headers,
        },
      ),
    );
  },
};
