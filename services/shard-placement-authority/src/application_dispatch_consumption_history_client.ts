import {
  applicationDispatchConsumptionDigest,
  parseApplicationDispatchConsumptionSnapshot,
  requireApplicationDispatchConsumptionMatchesDispatchClaim,
  type ApplicationDispatchConsumptionSnapshot,
} from "./application_dispatch_consumption_client";
import type {
  OperationFiveDispatchClaimRow,
} from "./execution_repository";
import {
  ProtocolError,
  canonicalJson,
  sha256Hex,
} from "./protocol";

const HISTORY_READ_CONTRACT =
  "cinatoken-relay-container-shard-placement-dispatch-consumption-history-read-v1";
const HISTORY_READ_RESULT_CONTRACT =
  "cinatoken-relay-container-shard-placement-dispatch-consumption-history-read-result-v1";
const APPLICATION_HMAC_DOMAIN =
  "cinatoken-shard-placement-application-v1\n";
const REQUEST_LIMIT_BYTES = 4 * 1024;
const RESPONSE_LIMIT_BYTES = 64 * 1024;
const TIMEOUT_MILLISECONDS = 3_000;
const DATABASE_CLOCK_SKEW_SECONDS = 30;
const MINIMUM_RETENTION_SECONDS = 60 * 60;
const MAXIMUM_RETENTION_SECONDS = 365 * 24 * 60 * 60;
const SHA256 = /^[0-9a-f]{64}$/;
const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface ApplicationDispatchConsumptionHistoryClientEnv {
  SHARD_PLACEMENT_APPLICATION: Fetcher;
  SHARD_PLACEMENT_APPLICATION_ISSUER: string;
  SHARD_PLACEMENT_APPLICATION_AUDIENCE: string;
  SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_RECOVERY_READ_HMAC_CURRENT_KID:
    string;
  SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_RECOVERY_READ_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
    string;
  SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_RECOVERY_READ_HMAC_CURRENT_SECRET?:
    string;
  SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_RECOVERY_READ_HMAC_PREVIOUS_KID:
    string;
  SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_RECOVERY_READ_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256:
    string;
  SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_RECOVERY_READ_HMAC_PREVIOUS_SECRET?:
    string;
  SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_RECOVERY_RETENTION_SECONDS:
    string;
}

export interface HistoricalApplicationDispatchConsumptionReadback {
  consumption: ApplicationDispatchConsumptionSnapshot;
  applicationDatabaseNow: number;
  retentionDeadlineAt: number;
  responseSha256: string;
  responseBytes: number;
  readCredentialIdSha256: string;
  readRequestIdSha256: string;
}

interface HistoricalApplicationDispatchConsumptionRequest {
  schemaVersion: 1;
  contract: typeof HISTORY_READ_CONTRACT;
  ticketIdSha256: string;
  authorizationIdSha256: string;
  authorityClaimDigestSha256: string;
  authorityDispatchClaimDigestSha256: string;
  applicationDatabaseIdentitySha256: string;
  commandDispatchConsumptionRequestIdSha256: string;
  recoveryRequestIdSha256: string;
}

interface HmacCredential {
  kid: string;
  credentialIdSha256: string;
  secret: string;
}

export function validateApplicationDispatchConsumptionHistoryClientConfig(
  env: ApplicationDispatchConsumptionHistoryClientEnv,
): void {
  const current = currentCredential(env);
  const previous = previousCredential(env);
  if (
    typeof env.SHARD_PLACEMENT_APPLICATION?.fetch !== "function"
    || !IDENTITY.test(env.SHARD_PLACEMENT_APPLICATION_ISSUER)
    || !IDENTITY.test(env.SHARD_PLACEMENT_APPLICATION_AUDIENCE)
    || !validCredential(current)
    || parseRetentionSeconds(env) === null
    || (
      previous !== null
      && (
        !validCredential(previous)
        || previous.kid === current.kid
        || previous.credentialIdSha256 === current.credentialIdSha256
        || previous.secret === current.secret
      )
    )
  ) {
    throw new ProtocolError(
      "application_dispatch_consumption_history_client_unavailable",
      503,
    );
  }
}

export async function readHistoricalApplicationDispatchConsumption(
  env: ApplicationDispatchConsumptionHistoryClientEnv,
  dispatchClaim: OperationFiveDispatchClaimRow,
  dispatchConsumptionRequestIdSha256: string,
  recoveryRequestIdSha256: string,
  now = Math.floor(Date.now() / 1_000),
): Promise<HistoricalApplicationDispatchConsumptionReadback> {
  validateApplicationDispatchConsumptionHistoryClientConfig(env);
  if (
    !SHA256.test(dispatchConsumptionRequestIdSha256)
    || !SHA256.test(recoveryRequestIdSha256)
  ) {
    throw new ProtocolError(
      "application_dispatch_consumption_history_command_invalid",
      400,
    );
  }
  const retentionSeconds = parseRetentionSeconds(env);
  if (retentionSeconds === null) {
    throw new ProtocolError(
      "application_dispatch_consumption_history_client_unavailable",
      503,
    );
  }

  const pathAndQuery =
    `/internal/v1/shard-placement/dispatch-consumptions/${dispatchClaim.application_ticket_id_sha256}/historical-readback`;
  const requestId =
    `op5-recovery-read-${recoveryRequestIdSha256.slice(0, 40)}`;
  const requestIdSha256 = await sha256Hex(
    new TextEncoder().encode(requestId),
  );
  const requestBody: HistoricalApplicationDispatchConsumptionRequest = {
    schemaVersion: 1,
    contract: HISTORY_READ_CONTRACT,
    ticketIdSha256: dispatchClaim.application_ticket_id_sha256,
    authorizationIdSha256: dispatchClaim.authorization_id_sha256,
    authorityClaimDigestSha256: dispatchClaim.claim_digest_sha256,
    authorityDispatchClaimDigestSha256:
      dispatchClaim.dispatch_claim_digest_sha256,
    applicationDatabaseIdentitySha256:
      dispatchClaim.application_database_identity_sha256,
    commandDispatchConsumptionRequestIdSha256:
      dispatchConsumptionRequestIdSha256,
    recoveryRequestIdSha256,
  };
  const body = new TextEncoder().encode(canonicalJson(requestBody));
  if (body.byteLength === 0 || body.byteLength > REQUEST_LIMIT_BYTES) {
    throw new ProtocolError(
      "application_dispatch_consumption_history_request_too_large",
      500,
    );
  }

  let credential = currentCredential(env);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort("application_dispatch_consumption_history_timeout"),
    TIMEOUT_MILLISECONDS,
  );
  try {
    let response = await applicationFetch(
      env,
      pathAndQuery,
      body,
      await applicationHmacToken(
        env,
        credential,
        pathAndQuery,
        requestId,
        await sha256Hex(body),
        now,
      ),
      controller.signal,
    );
    const previous = previousCredential(env);
    if (response.status === 409 && previous !== null) {
      await response.body?.cancel(
        "retry_exact_history_read_with_previous_credential",
      );
      credential = previous;
      response = await applicationFetch(
        env,
        pathAndQuery,
        body,
        await applicationHmacToken(
          env,
          credential,
          pathAndQuery,
          requestId,
          await sha256Hex(body),
          now,
        ),
        controller.signal,
      );
    }
    if (response.status === 404) {
      throw new ProtocolError(
        "application_dispatch_consumption_history_missing",
        409,
      );
    }
    if (
      response.status !== 200
      || response.redirected
      || response.headers.has("content-encoding")
      || !validContentLength(response.headers.get("content-length"))
      || response.headers.get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase() !== "application/json"
      || !hasNoStore(response.headers.get("cache-control"))
    ) {
      throw new ProtocolError(
        "application_dispatch_consumption_history_invalid_response",
        502,
      );
    }

    const bytes = await readBoundedResponse(response);
    const envelope = parseObject(bytes);
    assertExactKeys(envelope, [
      "contract",
      "result",
      "snapshot",
      "applicationDatabaseNow",
      "retentionDeadlineAt",
      "sendAttemptCreated",
      "controllerRequestSent",
    ]);
    if (
      envelope.contract !== HISTORY_READ_RESULT_CONTRACT
      || envelope.result !== "historical_dispatch_consumption_found"
      || envelope.sendAttemptCreated !== false
      || envelope.controllerRequestSent !== false
    ) {
      throw new ProtocolError(
        "application_dispatch_consumption_history_invalid_response",
        502,
      );
    }
    const consumption = parseApplicationDispatchConsumptionSnapshot(
      envelope.snapshot,
    );
    requireApplicationDispatchConsumptionMatchesDispatchClaim(
      consumption,
      dispatchClaim,
      dispatchConsumptionRequestIdSha256,
    );
    if (
      await applicationDispatchConsumptionDigest(consumption)
        !== consumption.dispatchConsumptionDigestSha256
    ) {
      throw new ProtocolError(
        "application_dispatch_consumption_history_digest_mismatch",
        409,
      );
    }
    const applicationDatabaseNow = requireTimestamp(
      envelope.applicationDatabaseNow,
    );
    const retentionDeadlineAt = requireTimestamp(
      envelope.retentionDeadlineAt,
    );
    const expectedRetentionDeadline =
      consumption.consumedAt + retentionSeconds;
    if (
      !Number.isSafeInteger(expectedRetentionDeadline)
      || retentionDeadlineAt !== expectedRetentionDeadline
      || consumption.consumedAt > applicationDatabaseNow
      || Math.abs(applicationDatabaseNow - now)
        > DATABASE_CLOCK_SKEW_SECONDS
      || applicationDatabaseNow > retentionDeadlineAt
      || now > retentionDeadlineAt
    ) {
      throw new ProtocolError(
        "application_dispatch_consumption_history_retention_mismatch",
        409,
      );
    }
    return {
      consumption,
      applicationDatabaseNow,
      retentionDeadlineAt,
      responseSha256: await sha256Hex(bytes),
      responseBytes: bytes.byteLength,
      readCredentialIdSha256: credential.credentialIdSha256,
      readRequestIdSha256: requestIdSha256,
    };
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    if (controller.signal.aborted) {
      throw new ProtocolError(
        "application_dispatch_consumption_history_timeout",
        504,
      );
    }
    throw new ProtocolError(
      "application_dispatch_consumption_history_unavailable",
      503,
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function applicationHmacToken(
  env: ApplicationDispatchConsumptionHistoryClientEnv,
  credential: HmacCredential,
  pathAndQuery: string,
  requestId: string,
  bodySha256: string,
  now: number,
): Promise<string> {
  const headerPart = encodeBase64Url(new TextEncoder().encode(canonicalJson({
    typ: "CINATOKEN-SHARD-PLACEMENT-APPLICATION",
    alg: "HS256",
    kid: credential.kid,
  })));
  const claimsPart = encodeBase64Url(new TextEncoder().encode(canonicalJson({
    issuer: env.SHARD_PLACEMENT_APPLICATION_ISSUER,
    audience: env.SHARD_PLACEMENT_APPLICATION_AUDIENCE,
    role: "dispatch_consumption_recovery_read",
    credential_id_sha256: credential.credentialIdSha256,
    request_id: requestId,
    method: "POST",
    path_and_query: pathAndQuery,
    body_sha256: bodySha256,
    issued_at: now,
    expires_at: now + 30,
  })));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(credential.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(
      `${APPLICATION_HMAC_DOMAIN}${headerPart}.${claimsPart}`,
    ),
  );
  return `${headerPart}.${claimsPart}.${encodeBase64Url(new Uint8Array(signature))}`;
}

function currentCredential(
  env: ApplicationDispatchConsumptionHistoryClientEnv,
): HmacCredential {
  return {
    kid:
      env
        .SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_RECOVERY_READ_HMAC_CURRENT_KID,
    credentialIdSha256:
      env
        .SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_RECOVERY_READ_HMAC_CURRENT_CREDENTIAL_ID_SHA256,
    secret:
      env
        .SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_RECOVERY_READ_HMAC_CURRENT_SECRET
        ?? "",
  };
}

function previousCredential(
  env: ApplicationDispatchConsumptionHistoryClientEnv,
): HmacCredential | null {
  const credential = {
    kid:
      env
        .SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_RECOVERY_READ_HMAC_PREVIOUS_KID,
    credentialIdSha256:
      env
        .SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_RECOVERY_READ_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256,
    secret:
      env
        .SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_RECOVERY_READ_HMAC_PREVIOUS_SECRET
        ?? "",
  };
  return Object.values(credential).every((value) => value.length === 0)
    ? null
    : credential;
}

function validCredential(value: HmacCredential): boolean {
  return KEY_ID.test(value.kid)
    && SHA256.test(value.credentialIdSha256)
    && value.secret.length >= 32
    && value.secret.length <= 256;
}

function parseRetentionSeconds(
  env: ApplicationDispatchConsumptionHistoryClientEnv,
): number | null {
  const value =
    env
      .SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_RECOVERY_RETENTION_SECONDS;
  if (!/^[1-9][0-9]{0,8}$/.test(value)) return null;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds)
      && seconds >= MINIMUM_RETENTION_SECONDS
      && seconds <= MAXIMUM_RETENTION_SECONDS
    ? seconds
    : null;
}

function applicationFetch(
  env: ApplicationDispatchConsumptionHistoryClientEnv,
  pathAndQuery: string,
  body: Uint8Array,
  token: string,
  signal: AbortSignal,
): Promise<Response> {
  return env.SHARD_PLACEMENT_APPLICATION.fetch(
    new Request(`https://cinatoken-application.internal${pathAndQuery}`, {
      method: "POST",
      redirect: "manual",
      signal,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-cinatoken-shard-placement-application": token,
      },
      body,
    }),
  );
}

async function readBoundedResponse(response: Response): Promise<Uint8Array> {
  if (response.body === null) {
    throw new ProtocolError(
      "application_dispatch_consumption_history_invalid_response",
      502,
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > RESPONSE_LIMIT_BYTES) {
        await reader.cancel(
          "application_dispatch_consumption_history_response_too_large",
        );
        throw new ProtocolError(
          "application_dispatch_consumption_history_response_too_large",
          502,
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) {
    throw new ProtocolError(
      "application_dispatch_consumption_history_invalid_response",
      502,
    );
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function parseObject(bytes: Uint8Array): Record<string, unknown> {
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    const value: unknown = JSON.parse(text);
    if (canonicalJson(value) !== text) {
      throw new ProtocolError(
        "application_dispatch_consumption_history_invalid_response",
        502,
      );
    }
    return requireObject(value);
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError(
      "application_dispatch_consumption_history_invalid_response",
      502,
    );
  }
}

function requireObject(value: unknown): Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new ProtocolError(
      "application_dispatch_consumption_history_invalid_response",
      502,
    );
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    throw new ProtocolError(
      "application_dispatch_consumption_history_invalid_response",
      502,
    );
  }
}

function requireTimestamp(value: unknown): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value <= 0
  ) {
    throw new ProtocolError(
      "application_dispatch_consumption_history_invalid_response",
      502,
    );
  }
  return value;
}

function hasNoStore(value: string | null): boolean {
  return value !== null
    && value.split(",").some((directive) =>
      directive.trim().toLowerCase() === "no-store");
}

function validContentLength(value: string | null): boolean {
  if (value === null) return true;
  if (!/^(?:0|[1-9][0-9]{0,9})$/.test(value)) return false;
  const length = Number(value);
  return Number.isSafeInteger(length)
    && length > 0
    && length <= RESPONSE_LIMIT_BYTES;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
