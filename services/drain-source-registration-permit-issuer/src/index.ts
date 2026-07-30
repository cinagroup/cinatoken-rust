import {
  PERMITS_PATH,
  ProtocolError,
  canonicalJson,
  issueRegistrationPermit,
  readBoundedJson,
  verifyHmacRequest,
  type IssuerEnv,
} from "./protocol";

export default {
  async fetch(request: Request, env: IssuerEnv): Promise<Response> {
    try {
      matchRoute(request);
      rejectAmbientHeaders(request);
      requireIssuerEnabled(env);
      const now = Math.floor(Date.now() / 1000);
      const body = await readBoundedJson(request);
      const authentication = await verifyHmacRequest(request, body, env, now);
      const issued = await issueRegistrationPermit(
        body,
        authentication,
        env,
        now,
      );
      const issuerVersionId = env.CF_VERSION_METADATA.id;
      if (
        typeof issuerVersionId !== "string" ||
        issuerVersionId.length === 0 ||
        issuerVersionId.length > 128
      ) {
        throw new ProtocolError("issuer_unavailable", 503);
      }
      return jsonResponse(201, {
        envelope: issued.envelope,
        subjectSha256: issued.subjectSha256,
        signatureEnvelopeSha256: issued.signatureEnvelopeSha256,
        requestId: authentication.requestId,
        issuerVersionId,
      });
    } catch (error) {
      return errorResponse(error);
    }
  },
} satisfies ExportedHandler<IssuerEnv>;

function matchRoute(request: Request): void {
  const url = new URL(request.url);
  if (
    request.method !== "POST" ||
    url.pathname !== PERMITS_PATH ||
    url.search.length !== 0
  ) {
    throw new ProtocolError("route_not_found", 404);
  }
}

function rejectAmbientHeaders(request: Request): void {
  if (
    request.headers.has("content-encoding") ||
    request.headers.has("cookie") ||
    request.headers.has("origin")
  ) {
    throw new ProtocolError("forbidden_request_header", 400);
  }
}

function requireIssuerEnabled(env: IssuerEnv): void {
  if (
    (env.ENVIRONMENT !== "local" && env.ENVIRONMENT !== "staging") ||
    env.DRAIN_SOURCE_REGISTRATION_PERMIT_ISSUER_ENABLED !== "true"
  ) {
    throw new ProtocolError("issuer_disabled", 503);
  }
}

function errorResponse(error: unknown): Response {
  if (error instanceof ProtocolError) {
    return jsonResponse(error.status, { error: error.code });
  }
  return jsonResponse(503, { error: "service_unavailable" });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(canonicalJson(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}
