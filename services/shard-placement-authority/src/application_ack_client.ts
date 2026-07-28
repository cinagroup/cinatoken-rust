import {
  ProtocolError,
  canonicalJson,
  sha256Hex,
} from "./protocol";
import type {
  ExecutionClaimSnapshot,
} from "./execution_repository";

export const APPLICATION_AUTHORITY_ACK_CONTRACT =
  "cinatoken-relay-container-shard-placement-authority-ack-v1";
export const APPLICATION_AUTHORITY_ACK_READ_PATH =
  "/internal/v1/shard-placement/execution-ticket-authority-acks";

const APPLICATION_HMAC_DOMAIN =
  "cinatoken-shard-placement-application-v1\n";
const ACKNOWLEDGEMENT_DIGEST_DOMAIN = new Uint8Array([
  ...new TextEncoder().encode(
    "cinatoken:relay-container-shard-placement-authority-ack:v1",
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

export interface ApplicationAuthorityAckClientEnv {
  SHARD_PLACEMENT_APPLICATION: Fetcher;
  SHARD_PLACEMENT_APPLICATION_ISSUER: string;
  SHARD_PLACEMENT_APPLICATION_AUDIENCE: string;
  SHARD_PLACEMENT_APPLICATION_ACK_READ_HMAC_CURRENT_KID: string;
  SHARD_PLACEMENT_APPLICATION_ACK_READ_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
    string;
  SHARD_PLACEMENT_APPLICATION_ACK_READ_HMAC_CURRENT_SECRET?: string;
}

export interface ApplicationAuthorityAckReadCommand {
  applicationAcknowledgementDigestSha256: string;
  callerRequestIdSha256: string;
  requestDomain: "op5" | "op5-dispatch";
}

export interface ApplicationAuthorityAckSnapshot {
  schemaVersion: 1;
  contract:
    "cinatoken-relay-container-shard-placement-authority-ack-snapshot-v1";
  ticketIdSha256: string;
  ticketDigestSha256: string;
  authorizationIdSha256: string;
  campaignId: string;
  applicationDatabaseIdentitySha256: string;
  authorityDatabaseIdentitySha256: string;
  authorityLedgerIdentitySha256: string;
  operationScheduleSha256: string;
  controllerServiceName: string;
  controllerBaselineVersionId: string;
  controllerEnabledVersionId: string;
  controllerEnableOperationIdSha256: string;
  authorityClaimDigestSha256: string;
  authorityClaimAcquiredReceiptSha256: string;
  authorityClaimOperationIdSha256: string;
  authorityActivationOperationIdSha256: string;
  applicationActivationDigestSha256: string;
  authorityActivationTerminalReceiptSha256: string;
  authorityLedgerHeadSha256: string;
  authorityVersionId: string;
  authorityReadCredentialIdSha256: string;
  authorityReadRequestIdSha256: string;
  acknowledgementDigestSha256: string;
  acknowledgedByAdminId: number;
  preparedAt: number;
  activatedAt: number;
  acknowledgedAt: number;
  activationDeadlineAt: number;
  executionDeadlineAt: number;
  permitExpiresAt: number;
  campaignExpiresAt: number;
  campaignSealedAt: number | null;
  databaseNow: number;
}

export interface ApplicationAuthorityAckReadback {
  acknowledgement: ApplicationAuthorityAckSnapshot;
  applicationVersionId: string;
  responseSha256: string;
  responseBytes: number;
  credentialIdSha256: string;
  requestIdSha256: string;
}

const ACK_FIELDS = [
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
  "controllerServiceName",
  "controllerBaselineVersionId",
  "controllerEnabledVersionId",
  "controllerEnableOperationIdSha256",
  "authorityClaimDigestSha256",
  "authorityClaimAcquiredReceiptSha256",
  "authorityClaimOperationIdSha256",
  "authorityActivationOperationIdSha256",
  "applicationActivationDigestSha256",
  "authorityActivationTerminalReceiptSha256",
  "authorityLedgerHeadSha256",
  "authorityVersionId",
  "authorityReadCredentialIdSha256",
  "authorityReadRequestIdSha256",
  "acknowledgementDigestSha256",
  "acknowledgedByAdminId",
  "preparedAt",
  "activatedAt",
  "acknowledgedAt",
  "activationDeadlineAt",
  "executionDeadlineAt",
  "permitExpiresAt",
  "campaignExpiresAt",
  "campaignSealedAt",
  "databaseNow",
] as const;

export function validateApplicationAuthorityAckClientConfig(
  env: ApplicationAuthorityAckClientEnv,
): void {
  const secret =
    env.SHARD_PLACEMENT_APPLICATION_ACK_READ_HMAC_CURRENT_SECRET;
  if (
    typeof env.SHARD_PLACEMENT_APPLICATION?.fetch !== "function"
    || !IDENTITY.test(env.SHARD_PLACEMENT_APPLICATION_ISSUER)
    || !IDENTITY.test(env.SHARD_PLACEMENT_APPLICATION_AUDIENCE)
    || !KEY_ID.test(
      env.SHARD_PLACEMENT_APPLICATION_ACK_READ_HMAC_CURRENT_KID,
    )
    || !SHA256.test(
      env
        .SHARD_PLACEMENT_APPLICATION_ACK_READ_HMAC_CURRENT_CREDENTIAL_ID_SHA256,
    )
    || typeof secret !== "string"
    || secret.length < 32
    || secret.length > 256
  ) {
    throw new ProtocolError(
      "application_authority_ack_reader_unavailable",
      503,
    );
  }
}

export async function readExactApplicationAuthorityAck(
  env: ApplicationAuthorityAckClientEnv,
  authority: ExecutionClaimSnapshot,
  command: ApplicationAuthorityAckReadCommand,
  authorityVersionId: string,
  now = Math.floor(Date.now() / 1_000),
): Promise<ApplicationAuthorityAckReadback> {
  validateApplicationAuthorityAckClientConfig(env);
  const claim = authority.claim;
  const pathAndQuery =
    `${APPLICATION_AUTHORITY_ACK_READ_PATH}/${claim.application_ticket_id_sha256}`
    + `?ticketDigestSha256=${claim.application_ticket_digest_sha256}`
    + `&claimDigestSha256=${claim.claim_digest_sha256}`
    + `&activationDigestSha256=${claim.application_activation_digest_sha256}`
    + `&acknowledgementDigestSha256=${command.applicationAcknowledgementDigestSha256}`;
  const requestId =
    `${command.requestDomain}-${command.callerRequestIdSha256.slice(0, 48)}`;
  const token = await applicationHmacToken(
    env,
    pathAndQuery,
    requestId,
    now,
  );
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort("application_authority_ack_timeout"),
    TIMEOUT_MILLISECONDS,
  );
  try {
    const response = await env.SHARD_PLACEMENT_APPLICATION.fetch(
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
        "application_authority_ack_invalid_response",
        502,
      );
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
      envelope.result !== "exact_execution_ticket_authority_ack"
      || envelope.requestId !== requestId
      || typeof envelope.applicationVersionId !== "string"
      || !IDENTITY.test(envelope.applicationVersionId)
    ) {
      throw new ProtocolError(
        "application_authority_ack_invalid_response",
        502,
      );
    }
    const acknowledgement = parseAcknowledgement(envelope.snapshot);
    requireAcknowledgementMatches(
      acknowledgement,
      authority,
      command,
      authorityVersionId,
    );
    if (
      await applicationAuthorityAcknowledgementDigest(acknowledgement)
        !== acknowledgement.acknowledgementDigestSha256
    ) {
      throw new ProtocolError(
        "application_authority_ack_digest_mismatch",
        409,
      );
    }
    return {
      acknowledgement,
      applicationVersionId: envelope.applicationVersionId,
      responseSha256: await sha256Hex(bytes),
      responseBytes: bytes.byteLength,
      credentialIdSha256:
        env
          .SHARD_PLACEMENT_APPLICATION_ACK_READ_HMAC_CURRENT_CREDENTIAL_ID_SHA256,
      requestIdSha256: await sha256Hex(
        new TextEncoder().encode(requestId),
      ),
    };
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    if (controller.signal.aborted) {
      throw new ProtocolError("application_authority_ack_timeout", 504);
    }
    throw new ProtocolError(
      "application_authority_ack_unavailable",
      503,
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function applicationAuthorityAcknowledgementDigest(
  acknowledgement: ApplicationAuthorityAckSnapshot,
): Promise<string> {
  const values = [
    APPLICATION_AUTHORITY_ACK_CONTRACT,
    acknowledgement.ticketIdSha256,
    acknowledgement.ticketDigestSha256,
    acknowledgement.authorityClaimDigestSha256,
    acknowledgement.applicationActivationDigestSha256,
    acknowledgement.authorityActivationTerminalReceiptSha256,
    acknowledgement.authorityLedgerHeadSha256,
    acknowledgement.authorityDatabaseIdentitySha256,
    acknowledgement.authorityVersionId,
    acknowledgement.authorityReadCredentialIdSha256,
    String(acknowledgement.acknowledgedByAdminId),
    acknowledgement.authorityReadRequestIdSha256,
  ];
  const encoded = values.map((value) => new TextEncoder().encode(value));
  const total = ACKNOWLEDGEMENT_DIGEST_DOMAIN.byteLength
    + encoded.reduce((sum, value) => sum + 4 + value.byteLength, 0);
  const input = new Uint8Array(total);
  input.set(ACKNOWLEDGEMENT_DIGEST_DOMAIN);
  let offset = ACKNOWLEDGEMENT_DIGEST_DOMAIN.byteLength;
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
  env: ApplicationAuthorityAckClientEnv,
  pathAndQuery: string,
  requestId: string,
  now: number,
): Promise<string> {
  const headerPart = encodeBase64Url(new TextEncoder().encode(canonicalJson({
    typ: "CINATOKEN-SHARD-PLACEMENT-APPLICATION",
    alg: "HS256",
    kid:
      env.SHARD_PLACEMENT_APPLICATION_ACK_READ_HMAC_CURRENT_KID,
  })));
  const claimsPart = encodeBase64Url(new TextEncoder().encode(canonicalJson({
    issuer: env.SHARD_PLACEMENT_APPLICATION_ISSUER,
    audience: env.SHARD_PLACEMENT_APPLICATION_AUDIENCE,
    role: "authority_ack_read",
    credential_id_sha256:
      env
        .SHARD_PLACEMENT_APPLICATION_ACK_READ_HMAC_CURRENT_CREDENTIAL_ID_SHA256,
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
      env.SHARD_PLACEMENT_APPLICATION_ACK_READ_HMAC_CURRENT_SECRET!,
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

function parseAcknowledgement(
  value: unknown,
): ApplicationAuthorityAckSnapshot {
  const object = requireObject(value);
  assertExactKeys(object, ACK_FIELDS);
  return {
    schemaVersion: requireLiteral(object.schemaVersion, 1),
    contract: requireLiteral(
      object.contract,
      "cinatoken-relay-container-shard-placement-authority-ack-snapshot-v1",
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
    controllerServiceName: requireIdentity(
      object.controllerServiceName,
    ),
    controllerBaselineVersionId: requireIdentity(
      object.controllerBaselineVersionId,
    ),
    controllerEnabledVersionId: requireIdentity(
      object.controllerEnabledVersionId,
    ),
    controllerEnableOperationIdSha256: requireSha256(
      object.controllerEnableOperationIdSha256,
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
    applicationActivationDigestSha256: requireSha256(
      object.applicationActivationDigestSha256,
    ),
    authorityActivationTerminalReceiptSha256: requireSha256(
      object.authorityActivationTerminalReceiptSha256,
    ),
    authorityLedgerHeadSha256: requireSha256(
      object.authorityLedgerHeadSha256,
    ),
    authorityVersionId: requireString(
      object.authorityVersionId,
      IDENTITY,
    ),
    authorityReadCredentialIdSha256: requireSha256(
      object.authorityReadCredentialIdSha256,
    ),
    authorityReadRequestIdSha256: requireSha256(
      object.authorityReadRequestIdSha256,
    ),
    acknowledgementDigestSha256: requireSha256(
      object.acknowledgementDigestSha256,
    ),
    acknowledgedByAdminId: requireInteger(
      object.acknowledgedByAdminId,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    preparedAt: requireTimestamp(object.preparedAt),
    activatedAt: requireTimestamp(object.activatedAt),
    acknowledgedAt: requireTimestamp(object.acknowledgedAt),
    activationDeadlineAt: requireTimestamp(
      object.activationDeadlineAt,
    ),
    executionDeadlineAt: requireTimestamp(
      object.executionDeadlineAt,
    ),
    permitExpiresAt: requireTimestamp(object.permitExpiresAt),
    campaignExpiresAt: requireTimestamp(object.campaignExpiresAt),
    campaignSealedAt: object.campaignSealedAt === null
      ? null
      : requireTimestamp(object.campaignSealedAt),
    databaseNow: requireTimestamp(object.databaseNow),
  };
}

function requireAcknowledgementMatches(
  acknowledgement: ApplicationAuthorityAckSnapshot,
  authority: ExecutionClaimSnapshot,
  command: ApplicationAuthorityAckReadCommand,
  authorityVersionId: string,
): void {
  const claim = authority.claim;
  const operationFour = authority.operations.find(
    (operation) => operation.ordinal === 4,
  );
  const operationFive = authority.operations.find(
    (operation) => operation.ordinal === 5,
  );
  const terminal = authority.receipts.find(
    (receipt) =>
      receipt.sequence === 3
      && receipt.event_kind === "operation_terminal"
      && receipt.operation_ordinal === 4,
  );
  if (
    operationFour === undefined
    || operationFive === undefined
    || terminal === undefined
    || acknowledgement.ticketIdSha256
      !== claim.application_ticket_id_sha256
    || acknowledgement.ticketDigestSha256
      !== claim.application_ticket_digest_sha256
    || acknowledgement.authorizationIdSha256
      !== claim.authorization_id_sha256
    || acknowledgement.campaignId !== claim.campaign_id
    || acknowledgement.applicationDatabaseIdentitySha256
      !== claim.application_database_identity_sha256
    || acknowledgement.authorityDatabaseIdentitySha256
      !== claim.authority_database_identity_sha256
    || acknowledgement.authorityLedgerIdentitySha256
      !== claim.ledger_identity_sha256
    || acknowledgement.operationScheduleSha256
      !== claim.operation_schedule_sha256
    || acknowledgement.controllerEnableOperationIdSha256
      !== operationFive.operation_id_sha256
    || operationFive.kind !== "enable_controller_deployment"
    || operationFive.shard_index !== null
    || acknowledgement.controllerBaselineVersionId
      === acknowledgement.controllerEnabledVersionId
    || acknowledgement.authorityClaimDigestSha256
      !== claim.claim_digest_sha256
    || acknowledgement.authorityClaimAcquiredReceiptSha256
      !== claim.claim_acquired_receipt_digest_sha256
    || acknowledgement.authorityClaimOperationIdSha256
      !== claim.claim_operation_id_sha256
    || acknowledgement.authorityActivationOperationIdSha256
      !== operationFour.operation_id_sha256
    || acknowledgement.applicationActivationDigestSha256
      !== claim.application_activation_digest_sha256
    || acknowledgement.authorityActivationTerminalReceiptSha256
      !== terminal.receipt_digest_sha256
    || acknowledgement.authorityLedgerHeadSha256
      !== terminal.receipt_digest_sha256
    || acknowledgement.authorityVersionId !== authorityVersionId
    || acknowledgement.acknowledgementDigestSha256
      !== command.applicationAcknowledgementDigestSha256
    || acknowledgement.preparedAt > acknowledgement.activatedAt
    || acknowledgement.activatedAt > acknowledgement.acknowledgedAt
    || acknowledgement.acknowledgedAt
      >= acknowledgement.activationDeadlineAt
    || acknowledgement.databaseNow
      >= acknowledgement.activationDeadlineAt
    || acknowledgement.databaseNow
      >= acknowledgement.executionDeadlineAt
    || acknowledgement.databaseNow >= acknowledgement.permitExpiresAt
    || acknowledgement.databaseNow
      >= acknowledgement.campaignExpiresAt
    || acknowledgement.executionDeadlineAt !== claim.normal_deadline_at
    || acknowledgement.campaignExpiresAt !== claim.normal_deadline_at
    || acknowledgement.permitExpiresAt !== claim.permit_expires_at
    || acknowledgement.campaignSealedAt !== null
  ) {
    throw new ProtocolError(
      "application_authority_ack_mismatch",
      409,
    );
  }
}

async function readBoundedResponse(response: Response): Promise<Uint8Array> {
  if (response.body === null) {
    throw new ProtocolError(
      "application_authority_ack_invalid_response",
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
        await reader.cancel("application_authority_ack_response_too_large");
        throw new ProtocolError(
          "application_authority_ack_response_too_large",
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
      "application_authority_ack_invalid_response",
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
    return requireObject(JSON.parse(new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes)));
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError(
      "application_authority_ack_invalid_response",
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
      "application_authority_ack_invalid_response",
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
      "application_authority_ack_invalid_response",
      502,
    );
  }
}

function requireLiteral<T extends string | number>(
  value: unknown,
  expected: T,
): T {
  if (value !== expected) {
    throw new ProtocolError(
      "application_authority_ack_invalid_response",
      502,
    );
  }
  return expected;
}

function requireString(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new ProtocolError(
      "application_authority_ack_invalid_response",
      502,
    );
  }
  return value;
}

function requireSha256(value: unknown): string {
  return requireString(value, SHA256);
}

function requireIdentity(value: unknown): string {
  return requireString(value, IDENTITY);
}

function requireTimestamp(value: unknown): number {
  return requireInteger(value, 1, Number.MAX_SAFE_INTEGER);
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
    throw new ProtocolError(
      "application_authority_ack_invalid_response",
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
