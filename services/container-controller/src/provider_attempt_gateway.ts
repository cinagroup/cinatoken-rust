import type {
  DispatchProviderAttemptOutcome,
  ProviderAttemptTerminal,
  RecordProviderAttemptOutcome,
} from "./ledger";

export const PROVIDER_ATTEMPT_HOST = "provider-attempt.cinatoken.internal";
export const PROVIDER_ATTEMPT_DISPATCH_PATH = "/v1/provider-attempts/dispatch";
export const PROVIDER_ATTEMPT_TERMINAL_PATH = "/v1/provider-attempts/terminal";

const MAX_PROVIDER_ATTEMPT_BODY_BYTES = 1024;

type RpcError = { code: string; status: number };
type RpcResult<T> = { ok: true; result: T } | { ok: false; error: RpcError };

export interface ProviderAttemptGatewayPort {
  dispatchProviderAttempt(
    operationId: string,
    ownerGeneration: number,
    attemptGeneration: number,
  ): Promise<RpcResult<DispatchProviderAttemptOutcome>>;
  recordProviderAttemptOutcome(
    operationId: string,
    ownerGeneration: number,
    attemptGeneration: number,
    terminal: ProviderAttemptTerminal,
  ): Promise<RpcResult<RecordProviderAttemptOutcome>>;
}

export async function handleProviderAttemptGatewayRequest(
  request: Request,
  port: ProviderAttemptGatewayPort,
  identity: { operationId: string; ownerGeneration: number },
): Promise<Response> {
  const path = exactProviderAttemptPath(new URL(request.url));
  if (path === null) {
    await cancelBody(request);
    return jsonError("provider_attempt_route_not_found", 404);
  }
  if (request.method !== "POST") {
    await cancelBody(request);
    return jsonError("provider_attempt_method_not_allowed", 405);
  }
  let body: Record<string, unknown>;
  try {
    body = await readJsonObject(request);
  } catch (error) {
    return error instanceof ProviderAttemptGatewayError
      ? jsonError(error.code, error.status)
      : jsonError("invalid_provider_attempt_request", 400);
  }

  if (path === PROVIDER_ATTEMPT_DISPATCH_PATH) {
    if (!hasExactKeys(body, ["attempt_generation"])) {
      return jsonError("invalid_provider_attempt_request", 400);
    }
    const attemptGeneration = readAttemptGeneration(body.attempt_generation);
    if (attemptGeneration === null) return jsonError("invalid_provider_attempt_request", 400);
    const result = await port.dispatchProviderAttempt(
      identity.operationId,
      identity.ownerGeneration,
      attemptGeneration,
    );
    if (!result.ok) return jsonError(result.error.code, result.error.status);
    return jsonResponse({
      outcome: result.result.kind,
      attempt_generation: result.result.row.attempt_generation,
      status: result.result.row.status,
      send_authorized: result.result.kind === "dispatched",
    });
  }

  if (path === PROVIDER_ATTEMPT_TERMINAL_PATH) {
    if (
      !hasExactKeys(body, [
        "attempt_generation",
        "status",
        "response_status",
        "response_code",
      ])
    ) {
      return jsonError("invalid_provider_attempt_request", 400);
    }
    const attemptGeneration = readAttemptGeneration(body.attempt_generation);
    const terminal = readTerminal(body);
    if (attemptGeneration === null || terminal === null) {
      return jsonError("invalid_provider_attempt_request", 400);
    }
    const result = await port.recordProviderAttemptOutcome(
      identity.operationId,
      identity.ownerGeneration,
      attemptGeneration,
      terminal,
    );
    if (!result.ok) return jsonError(result.error.code, result.error.status);
    return jsonResponse({
      outcome: result.result.kind,
      attempt_generation: result.result.row.attempt_generation,
      status: result.result.row.status,
      send_authorized: false,
    });
  }

  return jsonError("provider_attempt_route_not_found", 404);
}

function readTerminal(body: Record<string, unknown>): ProviderAttemptTerminal | null {
  if (
    typeof body.status !== "string" ||
    !["succeeded", "definite_reject", "ambiguous"].includes(body.status) ||
    typeof body.response_status !== "number" ||
    !Number.isSafeInteger(body.response_status) ||
    (body.response_code !== null && typeof body.response_code !== "string")
  ) {
    return null;
  }
  const status = body.status as ProviderAttemptTerminal["status"];
  const responseCode = body.response_code as string | null;
  const responseStatus = body.response_status;
  const validCode =
    responseCode !== null &&
    responseCode.length >= 1 &&
    responseCode.length <= 64 &&
    /^[a-z0-9_:-]+$/.test(responseCode);
  if (
    (status === "succeeded" &&
      (responseStatus < 200 || responseStatus > 299 || responseCode !== null)) ||
    (status === "definite_reject" &&
      (responseStatus < 400 || responseStatus > 599 || !validCode)) ||
    (status === "ambiguous" && (responseStatus !== 202 || !validCode))
  ) {
    return null;
  }
  return { status, response_status: responseStatus, response_code: responseCode };
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    await cancelBody(request);
    throw new ProviderAttemptGatewayError("invalid_provider_attempt_content_type", 415);
  }
  const contentLength = request.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_PROVIDER_ATTEMPT_BODY_BYTES)
  ) {
    await cancelBody(request);
    throw new ProviderAttemptGatewayError("provider_attempt_request_too_large", 413);
  }
  if (request.body === null) throw new ProviderAttemptGatewayError("invalid_provider_attempt_request", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_PROVIDER_ATTEMPT_BODY_BYTES) {
        await reader.cancel("provider_attempt_request_too_large");
        throw new ProviderAttemptGatewayError("provider_attempt_request_too_large", 413);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new ProviderAttemptGatewayError("invalid_provider_attempt_request", 400);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
  } catch {
    throw new ProviderAttemptGatewayError("invalid_provider_attempt_request", 400);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderAttemptGatewayError("invalid_provider_attempt_request", 400);
  }
  return value as Record<string, unknown>;
}

function readAttemptGeneration(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 3
    ? value
    : null;
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}

function exactProviderAttemptPath(url: URL): string | null {
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.hostname !== PROVIDER_ATTEMPT_HOST ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== ""
  ) {
    return null;
  }
  return url.pathname === PROVIDER_ATTEMPT_DISPATCH_PATH ||
    url.pathname === PROVIDER_ATTEMPT_TERMINAL_PATH
    ? url.pathname
    : null;
}

async function cancelBody(request: Request): Promise<void> {
  if (request.body === null || request.bodyUsed) return;
  await request.body.cancel("provider_attempt_request_rejected").catch(() => undefined);
}

function jsonResponse(value: Record<string, unknown>): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function jsonError(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

class ProviderAttemptGatewayError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}
