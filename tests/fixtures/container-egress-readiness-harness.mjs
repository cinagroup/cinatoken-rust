const routes = {
  "/ready": ["BROKER_READY", "/internal/v1/provider-egress/readiness"],
  "/execute": ["BROKER_READY", "/internal/v1/provider-attempts/execute"],
  "/disabled": ["BROKER_DISABLED", "/internal/v1/provider-egress/readiness"],
  "/missing-model": ["BROKER_MISSING_MODEL", "/internal/v1/provider-egress/readiness"],
  "/missing-secret": ["BROKER_MISSING_SECRET", "/internal/v1/provider-egress/readiness"],
  "/missing-version": ["BROKER_MISSING_VERSION", "/internal/v1/provider-egress/readiness"],
};

export default {
  async fetch(request, env) {
    const route = routes[new URL(request.url).pathname];
    if (!route) return new Response("not found", { status: 404 });
    const [bindingName, targetPath] = route;
    return env[bindingName].fetch(
      new Request(`https://provider-egress.cinatoken.internal${targetPath}`, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      }),
    );
  },
};
