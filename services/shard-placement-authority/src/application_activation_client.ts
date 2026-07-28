import {
  ProtocolError,
  canonicalJson,
  sha256Hex,
} from "./protocol";
import type { ExecutionClaimRow } from "./execution_repository";

export const APPLICATION_ACTIVATION_CONTRACT =
  "cinatoken-relay-container-shard-placement-execution-ticket-activation-v1";
export const APPLICATION_ACTIVATION_READ_PATH =
  "/internal/v1/shard-placement/execution-ticket-activations";

const APPLICATION_HMAC_DOMAIN =
  "cinatoken-shard-placement-application-v1\n";
const ACTIVATION_DIGEST_DOMAIN = new Uint8Array([
  ...new TextEncoder().encode(
    "cinatoken:relay-container-shard-placement-execution-ticket-activation:v1",
  ),
  0,
]);
const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const RESPONSE_LIMIT_BYTES = 64 * 1024;
const TIMEOUT_MILLISECONDS = 3_000;
const SHA256 = /^[0-9a-f]{64}$/;
const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VERSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface ApplicationActivationClientEnv {
  SHARD_PLACEMENT_APPLICATION: Fetcher;
  SHARD_PLACEMENT_APPLICATION_ISSUER: string;
  SHARD_PLACEMENT_APPLICATION_AUDIENCE: string;
  SHARD_PLACEMENT_APPLICATION_ACTIVATION_READ_HMAC_CURRENT_KID: string;
  SHARD_PLACEMENT_APPLICATION_ACTIVATION_READ_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
    string;
  SHARD_PLACEMENT_APPLICATION_ACTIVATION_READ_HMAC_CURRENT_SECRET?: string;
}

export interface ApplicationActivationReadCommand {
  applicationActivationDigestSha256: string;
  activationRequestIdSha256: string;
}

export interface ApplicationActivation {
  schemaVersion: 1;
  contract:
    "cinatoken-relay-container-shard-placement-execution-ticket-activation-snapshot-v1";
  ticketIdSha256: string;
  ticketDigestSha256: string;
  authorizationIdSha256: string;
  campaignId: string;
  applicationDatabaseIdentitySha256: string;
  authorityDatabaseIdentitySha256: string;
  authorityLedgerIdentitySha256: string;
  operationScheduleSha256: string;
  authorityClaimDigestSha256: string;
  authorityClaimAcquiredReceiptSha256: string;
  authorityClaimOperationIdSha256: string;
  authorityActivationOperationIdSha256: string;
  authorityVersionId: string;
  activationCredentialIdSha256: string;
  activationRequestIdSha256: string;
  activationDigestSha256: string;
  activatedByAdminId: number;
  preparedAt: number;
  activatedAt: number;
  activationDeadlineAt: number;
  executionDeadlineAt: number;
  permitExpiresAt: number;
  campaignExpiresAt: number;
  campaignSealedAt: number | null;
  databaseNow: number;
}

export interface ApplicationActivationReadback {
  activation: ApplicationActivation;
  responseSha256: string;
  credentialIdSha256: string;
}

const ACTIVATION_FIELDS = [
  "schemaVersion",
  "contract",
  "ticketIdSha256",
  "ticketDigestSha256",
  "authorizationIdSha256",
  "campaignId",
  "applicationDatabaseIdentitySha256",
  "authorityDatabaseIdentitySha256",
  "authorityLedgerIdentitySha256",
  "operationScheduleSha256",
  "authorityClaimDigestSha256",
  "authorityClaimAcquiredReceiptSha256",
  "authorityClaimOperationIdSha256",
  "authorityActivationOperationIdSha256",
  "authorityVersionId",
  "activationCredentialIdSha256",
  "activationRequestIdSha256",
  "activationDigestSha256",
  "activatedByAdminId",
  "preparedAt",
  "activatedAt",
  "activationDeadlineAt",
  "executionDeadlineAt",
  "permitExpiresAt",
  "campaignExpiresAt",
  "campaignSealedAt",
  "databaseNow",
] as const;

export function validateApplicationActivationClientConfig(
  env: ApplicationActivationClientEnv,
): void {
  const secret =
    env.SHARD_PLACEMENT_APPLICATION_ACTIVATION_READ_HMAC_CURRENT_SECRET;
  if (
    typeof env.SHARD_PLACEMENT_APPLICATION?.fetch !== "function"
    || !IDENTITY.test(env.SHARD_PLACEMENT_APPLICATION_ISSUER)
    || !IDENTITY.test(env.SHARD_PLACEMENT_APPLICATION_AUDIENCE)
    || !KEY_ID.test(
      env.SHARD_PLACEMENT_APPLICATION_ACTIVATION_READ_HMAC_CURRENT_KID,
    )
    || !SHA256.test(
      env
        .SHARD_PLACEMENT_APPLICATION_ACTIVATION_READ_HMAC_CURRENT_CREDENTIAL_ID_SHA256,
    )
    || typeof secret !== "string"
    || secret.length < 32
    || secret.length > 256
  ) {
    throw new ProtocolError(
      "application_activation_reader_unavailable",
      503,
    );
  }
}

export async function readExactApplicationActivation(
  env: ApplicationActivationClientEnv,
  claim: ExecutionClaimRow,
  activationOperationIdSha256: string,
  command: ApplicationActivationReadCommand,
  authorityVersionId: string,
  now = Math.floor(Date.now() / 1_000),
): Promise<ApplicationActivationReadback> {
  validateApplicationActivationClientConfig(env);
  const pathAndQuery =
    `${APPLICATION_ACTIVATION_READ_PATH}/${claim.application_ticket_id_sha256}`
    + `?ticketDigestSha256=${claim.application_ticket_digest_sha256}`
    + `&claimDigestSha256=${claim.claim_digest_sha256}`
    + `&activationDigestSha256=${command.applicationActivationDigestSha256}`;
  const requestId =
    `op4-${command.activationRequestIdSha256.slice(0, 48)}`;
  const token = await applicationHmacToken(
    env,
    pathAndQuery,
    requestId,
    now,
  );
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort("application_activation_timeout"),
    TIMEOUT_MILLISECONDS,
  );
  let response: Response;
  try {
    response = await env.SHARD_PLACEMENT_APPLICATION.fetch(
      new Request(`https://cinatoken-application.internal${pathAndQuery}`, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "x-cinatoken-shard-placement-application": token,
        },
      }),
    );
  } catch {
    if (controller.signal.aborted) {
      throw new ProtocolError("application_activation_timeout", 504);
    }
    throw new ProtocolError("application_activation_unavailable", 503);
  } finally {
    clearTimeout(timeout);
  }
  if (
    response.status !== 200
    || response.redirected
    || response.headers.get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() !== "application/json"
    || !hasNoStore(response.headers.get("cache-control"))
  ) {
    throw new ProtocolError("application_activation_invalid_response", 502);
  }
  const bytes = await readBoundedResponse(response);
  const envelope = parseObject(bytes);
  assertExactKeys(envelope, [
    "result",
    "requestId",
    "snapshot",
    "applicationVersionId",
  ]);
  if (
    envelope.result !== "exact_execution_ticket_activation"
    || envelope.requestId !== requestId
    || typeof envelope.applicationVersionId !== "string"
    || !VERSION_ID.test(envelope.applicationVersionId)
  ) {
    throw new ProtocolError("application_activation_invalid_response", 502);
  }
  const activation = parseActivation(envelope.snapshot);
  requireActivationMatches(
    activation,
    claim,
    activationOperationIdSha256,
    command,
    authorityVersionId,
  );
  const expectedDigest = await applicationActivationDigest(activation);
  if (expectedDigest !== activation.activationDigestSha256) {
    throw new ProtocolError("application_activation_digest_mismatch", 409);
  }
  return {
    activation,
    responseSha256: await sha256Hex(bytes),
    credentialIdSha256:
      env
        .SHARD_PLACEMENT_APPLICATION_ACTIVATION_READ_HMAC_CURRENT_CREDENTIAL_ID_SHA256,
  };
}

export async function applicationActivationDigest(
  activation: ApplicationActivation,
): Promise<string> {
  const values = [
    APPLICATION_ACTIVATION_CONTRACT,
    activation.ticketIdSha256,
    activation.ticketDigestSha256,
    activation.authorityClaimDigestSha256,
    activation.authorityClaimAcquiredReceiptSha256,
    activation.authorityClaimOperationIdSha256,
    activation.authorityActivationOperationIdSha256,
    activation.applicationDatabaseIdentitySha256,
    activation.authorityDatabaseIdentitySha256,
    activation.authorityLedgerIdentitySha256,
    activation.authorityVersionId,
    activation.activationCredentialIdSha256,
    String(activation.activatedByAdminId),
    activation.activationRequestIdSha256,
  ];
  const encoded = values.map((value) => new TextEncoder().encode(value));
  const total = ACTIVATION_DIGEST_DOMAIN.byteLength
    + encoded.reduce((sum, value) => sum + 4 + value.byteLength, 0);
  const input = new Uint8Array(total);
  input.set(ACTIVATION_DIGEST_DOMAIN);
  let offset = ACTIVATION_DIGEST_DOMAIN.byteLength;
  for (const value of encoded) {
    new DataView(input.buffer).setUint32(
      offset,
      value.byteLength,
      false,
    );
    offset += 4;
    input.set(value, offset);
    offset += value.byteLength;
  }
  return sha256Hex(input);
}

async function applicationHmacToken(
  env: ApplicationActivationClientEnv,
  pathAndQuery: string,
  requestId: string,
  now: number,
): Promise<string> {
  const headerPart = encodeBase64Url(new TextEncoder().encode(canonicalJson({
    typ: "CINATOKEN-SHARD-PLACEMENT-APPLICATION",
    alg: "HS256",
    kid:
      env.SHARD_PLACEMENT_APPLICATION_ACTIVATION_READ_HMAC_CURRENT_KID,
  })));
  const claimsPart = encodeBase64Url(new TextEncoder().encode(canonicalJson({
    issuer: env.SHARD_PLACEMENT_APPLICATION_ISSUER,
    audience: env.SHARD_PLACEMENT_APPLICATION_AUDIENCE,
    role: "activation_read",
    credential_id_sha256:
      env
        .SHARD_PLACEMENT_APPLICATION_ACTIVATION_READ_HMAC_CURRENT_CREDENTIAL_ID_SHA256,
    request_id: requestId,
    method: "GET",
    path_and_query: pathAndQuery,
    body_sha256: EMPTY_SHA256,
    issued_at: now,
    expires_at: now + 30,
  })));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(
      env.SHARD_PLACEMENT_APPLICATION_ACTIVATION_READ_HMAC_CURRENT_SECRET!,
    ),
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

function parseActivation(value: unknown): ApplicationActivation {
  const object = requireObject(value);
  assertExactKeys(object, ACTIVATION_FIELDS);
  return {
    schemaVersion: requireLiteral(object.schemaVersion, 1),
    contract: requireLiteral(
      object.contract,
      "cinatoken-relay-container-shard-placement-execution-ticket-activation-snapshot-v1",
    ),
    ticketIdSha256: requireSha256(object.ticketIdSha256),
    ticketDigestSha256: requireSha256(object.ticketDigestSha256),
    authorizationIdSha256: requireSha256(
      object.authorizationIdSha256,
    ),
    campaignId: requireSha256(object.campaignId),
    applicationDatabaseIdentitySha256: requireSha256(
      object.applicationDatabaseIdentitySha256,
    ),
    authorityDatabaseIdentitySha256: requireSha256(
      object.authorityDatabaseIdentitySha256,
    ),
    authorityLedgerIdentitySha256: requireSha256(
      object.authorityLedgerIdentitySha256,
    ),
    operationScheduleSha256: requireSha256(
      object.operationScheduleSha256,
    ),
    authorityClaimDigestSha256: requireSha256(
      object.authorityClaimDigestSha256,
    ),
    authorityClaimAcquiredReceiptSha256: requireSha256(
      object.authorityClaimAcquiredReceiptSha256,
    ),
    authorityClaimOperationIdSha256: requireSha256(
      object.authorityClaimOperationIdSha256,
    ),
    authorityActivationOperationIdSha256: requireSha256(
      object.authorityActivationOperationIdSha256,
    ),
    authorityVersionId: requireString(
      object.authorityVersionId,
      VERSION_ID,
    ),
    activationCredentialIdSha256: requireSha256(
      object.activationCredentialIdSha256,
    ),
    activationRequestIdSha256: requireSha256(
      object.activationRequestIdSha256,
    ),
    activationDigestSha256: requireSha256(
      object.activationDigestSha256,
    ),
    activatedByAdminId: requireInteger(
      object.activatedByAdminId,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    preparedAt: requireInteger(
      object.preparedAt,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    activatedAt: requireInteger(
      object.activatedAt,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    activationDeadlineAt: requireInteger(
      object.activationDeadlineAt,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    executionDeadlineAt: requireInteger(
      object.executionDeadlineAt,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    permitExpiresAt: requireInteger(
      object.permitExpiresAt,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    campaignExpiresAt: requireInteger(
      object.campaignExpiresAt,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    campaignSealedAt: object.campaignSealedAt === null
      ? null
      : requireInteger(
          object.campaignSealedAt,
          1,
          Number.MAX_SAFE_INTEGER,
        ),
    databaseNow: requireInteger(
      object.databaseNow,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

function requireActivationMatches(
  activation: ApplicationActivation,
  claim: ExecutionClaimRow,
  activationOperationIdSha256: string,
  command: ApplicationActivationReadCommand,
  authorityVersionId: string,
): void {
  if (
    activation.ticketIdSha256 !== claim.application_ticket_id_sha256
    || activation.ticketDigestSha256
      !== claim.application_ticket_digest_sha256
    || activation.authorizationIdSha256
      !== claim.authorization_id_sha256
    || activation.campaignId !== claim.campaign_id
    || activation.applicationDatabaseIdentitySha256
      !== claim.application_database_identity_sha256
    || activation.authorityClaimDigestSha256
      !== claim.claim_digest_sha256
    || activation.authorityClaimAcquiredReceiptSha256
      !== claim.claim_acquired_receipt_digest_sha256
    || activation.authorityClaimOperationIdSha256
      !== claim.claim_operation_id_sha256
    || activation.authorityActivationOperationIdSha256
      !== activationOperationIdSha256
    || activation.authorityDatabaseIdentitySha256
      !== claim.authority_database_identity_sha256
    || activation.authorityLedgerIdentitySha256
      !== claim.ledger_identity_sha256
    || activation.operationScheduleSha256
      !== claim.operation_schedule_sha256
    || activation.authorityVersionId !== authorityVersionId
    || activation.activationRequestIdSha256
      !== command.activationRequestIdSha256
    || activation.activationDigestSha256
      !== command.applicationActivationDigestSha256
    || activation.preparedAt > activation.activatedAt
    || activation.activatedAt < claim.claimed_at
    || activation.activatedAt >= activation.activationDeadlineAt
    || activation.databaseNow >= activation.activationDeadlineAt
    || activation.databaseNow >= activation.executionDeadlineAt
    || activation.databaseNow >= activation.permitExpiresAt
    || activation.databaseNow >= activation.campaignExpiresAt
    || activation.executionDeadlineAt !== claim.normal_deadline_at
    || activation.campaignExpiresAt !== claim.normal_deadline_at
    || activation.permitExpiresAt !== claim.permit_expires_at
    || activation.campaignSealedAt !== null
  ) {
    throw new ProtocolError("application_activation_mismatch", 409);
  }
}

async function readBoundedResponse(response: Response): Promise<Uint8Array> {
  if (response.body === null) {
    throw new ProtocolError("application_activation_invalid_response", 502);
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
        await reader.cancel("application_activation_response_too_large");
        throw new ProtocolError(
          "application_activation_response_too_large",
          502,
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) {
    throw new ProtocolError("application_activation_invalid_response", 502);
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
    return requireObject(JSON.parse(new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes)));
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError("application_activation_invalid_response", 502);
  }
}

function requireObject(value: unknown): Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new ProtocolError("application_activation_invalid_response", 502);
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
    throw new ProtocolError("application_activation_invalid_response", 502);
  }
}

function requireLiteral<T extends string | number | boolean>(
  value: unknown,
  expected: T,
): T {
  if (value !== expected) {
    throw new ProtocolError("application_activation_invalid_response", 502);
  }
  return expected;
}

function requireString(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new ProtocolError("application_activation_invalid_response", 502);
  }
  return value;
}

function requireSha256(value: unknown): string {
  return requireString(value, SHA256);
}

function requireInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    throw new ProtocolError("application_activation_invalid_response", 502);
  }
  return value;
}

function hasNoStore(value: string | null): boolean {
  return value !== null
    && value.split(",").some((directive) =>
      directive.trim().toLowerCase() === "no-store");
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
