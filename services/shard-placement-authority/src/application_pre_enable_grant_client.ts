import {
  ProtocolError,
  canonicalJson,
  sha256Hex,
} from "./protocol";
import type {
  OperationFiveDispatchOutboxRow,
} from "./execution_repository";

export const APPLICATION_PRE_ENABLE_GRANT_CONTRACT =
  "cinatoken-relay-container-shard-placement-pre-enable-grant-v1";
export const APPLICATION_PRE_ENABLE_GRANT_PATH =
  "/internal/v1/shard-placement/pre-enable-grants";

const APPLICATION_PRE_ENABLE_GRANT_SNAPSHOT_CONTRACT =
  "cinatoken-relay-container-shard-placement-pre-enable-grant-snapshot-v1";
const APPLICATION_HMAC_DOMAIN =
  "cinatoken-shard-placement-application-v1\n";
const GRANT_DIGEST_DOMAIN = new Uint8Array([
  ...new TextEncoder().encode(
    "cinatoken:relay-container-shard-placement-pre-enable-grant:v1",
  ),
  0,
]);
const RESPONSE_LIMIT_BYTES = 64 * 1024;
const TIMEOUT_MILLISECONDS = 3_000;
const SHA256 = /^[0-9a-f]{64}$/;
const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface ApplicationPreEnableGrantClientEnv {
  SHARD_PLACEMENT_APPLICATION: Fetcher;
  SHARD_PLACEMENT_APPLICATION_ISSUER: string;
  SHARD_PLACEMENT_APPLICATION_AUDIENCE: string;
  SHARD_PLACEMENT_APPLICATION_PRE_ENABLE_GRANT_HMAC_CURRENT_KID:
    string;
  SHARD_PLACEMENT_APPLICATION_PRE_ENABLE_GRANT_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
    string;
  SHARD_PLACEMENT_APPLICATION_PRE_ENABLE_GRANT_HMAC_CURRENT_SECRET?:
    string;
}

export interface ApplicationPreEnableGrantCommand {
  callerRequestIdSha256: string;
  authorityLedgerIdentitySha256: string;
}

export interface ApplicationPreEnableGrantSnapshot {
  schemaVersion: 1;
  contract:
    "cinatoken-relay-container-shard-placement-pre-enable-grant-snapshot-v1";
  ticketIdSha256: string;
  authorizationIdSha256: string;
  applicationTicketDigestSha256: string;
  applicationDatabaseIdentitySha256: string;
  authorityClaimDigestSha256: string;
  applicationActivationDigestSha256: string;
  applicationAcknowledgementDigestSha256: string;
  operationFiveAdmissionDigestSha256: string;
  operationFiveStartReceiptSha256: string;
  authorityDispatchOutboxDigestSha256: string;
  authorityDatabaseIdentitySha256: string;
  authorityLedgerIdentitySha256: string;
  authorityLedgerHeadSha256: string;
  authorityVersionId: string;
  controllerServiceName: string;
  controllerEnableOperationIdSha256: string;
  controllerBaselineVersionId: string;
  controllerEnabledVersionId: string;
  applicationGrantCredentialIdSha256: string;
  applicationGrantRequestIdSha256: string;
  grantDigestSha256: string;
  grantedAt: number;
  activationDeadlineAt: number;
  executionDeadlineAt: number;
  permitExpiresAt: number;
  campaignExpiresAt: number;
  campaignSealedAt: number | null;
  databaseNow: number;
}

export interface ApplicationPreEnableGrantReadback {
  classification: "grant_created" | "exact_replay";
  grant: ApplicationPreEnableGrantSnapshot;
  applicationVersionId: string;
  responseSha256: string;
  responseBytes: number;
  credentialIdSha256: string;
  requestIdSha256: string;
}

interface ApplicationPreEnableGrantRequest {
  schemaVersion: 1;
  contract:
    "cinatoken-relay-container-shard-placement-pre-enable-grant-v1";
  ticketIdSha256: string;
  authorizationIdSha256: string;
  applicationTicketDigestSha256: string;
  applicationDatabaseIdentitySha256: string;
  authorityClaimDigestSha256: string;
  applicationActivationDigestSha256: string;
  applicationAcknowledgementDigestSha256: string;
  operationFiveAdmissionDigestSha256: string;
  operationFiveStartReceiptSha256: string;
  authorityDispatchOutboxDigestSha256: string;
  authorityDatabaseIdentitySha256: string;
  authorityLedgerIdentitySha256: string;
  authorityLedgerHeadSha256: string;
  authorityVersionId: string;
  controllerServiceName: string;
  controllerEnableOperationIdSha256: string;
  controllerBaselineVersionId: string;
  controllerEnabledVersionId: string;
  grantDigestSha256: string;
}

const GRANT_FIELDS = [
  "schemaVersion",
  "contract",
  "ticketIdSha256",
  "authorizationIdSha256",
  "applicationTicketDigestSha256",
  "applicationDatabaseIdentitySha256",
  "authorityClaimDigestSha256",
  "applicationActivationDigestSha256",
  "applicationAcknowledgementDigestSha256",
  "operationFiveAdmissionDigestSha256",
  "operationFiveStartReceiptSha256",
  "authorityDispatchOutboxDigestSha256",
  "authorityDatabaseIdentitySha256",
  "authorityLedgerIdentitySha256",
  "authorityLedgerHeadSha256",
  "authorityVersionId",
  "controllerServiceName",
  "controllerEnableOperationIdSha256",
  "controllerBaselineVersionId",
  "controllerEnabledVersionId",
  "applicationGrantCredentialIdSha256",
  "applicationGrantRequestIdSha256",
  "grantDigestSha256",
  "grantedAt",
  "activationDeadlineAt",
  "executionDeadlineAt",
  "permitExpiresAt",
  "campaignExpiresAt",
  "campaignSealedAt",
  "databaseNow",
] as const;

export function validateApplicationPreEnableGrantClientConfig(
  env: ApplicationPreEnableGrantClientEnv,
): void {
  const secret =
    env
      .SHARD_PLACEMENT_APPLICATION_PRE_ENABLE_GRANT_HMAC_CURRENT_SECRET;
  if (
    typeof env.SHARD_PLACEMENT_APPLICATION?.fetch !== "function"
    || !IDENTITY.test(env.SHARD_PLACEMENT_APPLICATION_ISSUER)
    || !IDENTITY.test(env.SHARD_PLACEMENT_APPLICATION_AUDIENCE)
    || !KEY_ID.test(
      env
        .SHARD_PLACEMENT_APPLICATION_PRE_ENABLE_GRANT_HMAC_CURRENT_KID,
    )
    || !SHA256.test(
      env
        .SHARD_PLACEMENT_APPLICATION_PRE_ENABLE_GRANT_HMAC_CURRENT_CREDENTIAL_ID_SHA256,
    )
    || typeof secret !== "string"
    || secret.length < 32
    || secret.length > 256
  ) {
    throw new ProtocolError(
      "application_pre_enable_grant_client_unavailable",
      503,
    );
  }
}

export async function createExactApplicationPreEnableGrant(
  env: ApplicationPreEnableGrantClientEnv,
  outbox: OperationFiveDispatchOutboxRow,
  command: ApplicationPreEnableGrantCommand,
  now = Math.floor(Date.now() / 1_000),
): Promise<ApplicationPreEnableGrantReadback> {
  validateApplicationPreEnableGrantClientConfig(env);
  if (
    !SHA256.test(command.callerRequestIdSha256)
    || !SHA256.test(command.authorityLedgerIdentitySha256)
  ) {
    throw new ProtocolError(
      "application_pre_enable_grant_command_invalid",
      400,
    );
  }
  const pathAndQuery =
    `${APPLICATION_PRE_ENABLE_GRANT_PATH}/${outbox.application_ticket_id_sha256}`;
  const requestId =
    `op5-grant-${command.callerRequestIdSha256.slice(0, 48)}`;
  const requestIdSha256 = await sha256Hex(
    new TextEncoder().encode(requestId),
  );
  const credentialIdSha256 =
    env
      .SHARD_PLACEMENT_APPLICATION_PRE_ENABLE_GRANT_HMAC_CURRENT_CREDENTIAL_ID_SHA256;
  const requestWithoutDigest = {
    schemaVersion: 1,
    contract: APPLICATION_PRE_ENABLE_GRANT_CONTRACT,
    ticketIdSha256: outbox.application_ticket_id_sha256,
    authorizationIdSha256: outbox.authorization_id_sha256,
    applicationTicketDigestSha256:
      outbox.application_ticket_digest_sha256,
    applicationDatabaseIdentitySha256:
      outbox.application_database_identity_sha256,
    authorityClaimDigestSha256: outbox.claim_digest_sha256,
    applicationActivationDigestSha256:
      outbox.application_activation_digest_sha256,
    applicationAcknowledgementDigestSha256:
      outbox.application_acknowledgement_digest_sha256,
    operationFiveAdmissionDigestSha256:
      outbox.operation_five_admission_digest_sha256,
    operationFiveStartReceiptSha256:
      outbox.operation_five_start_receipt_sha256,
    authorityDispatchOutboxDigestSha256:
      outbox.outbox_digest_sha256,
    authorityDatabaseIdentitySha256:
      outbox.authority_database_identity_sha256,
    authorityLedgerIdentitySha256:
      command.authorityLedgerIdentitySha256,
    authorityLedgerHeadSha256: outbox.authority_ledger_head_sha256,
    authorityVersionId: outbox.authority_version_id,
    controllerServiceName: outbox.controller_service_name,
    controllerEnableOperationIdSha256:
      outbox.controller_enable_operation_id_sha256,
    controllerBaselineVersionId:
      outbox.controller_baseline_version_id,
    controllerEnabledVersionId:
      outbox.controller_enabled_version_id,
  } as const;
  const grantDigestSha256 = await applicationPreEnableGrantDigest({
    ...requestWithoutDigest,
    applicationGrantCredentialIdSha256: credentialIdSha256,
    applicationGrantRequestIdSha256: requestIdSha256,
  });
  const requestBody: ApplicationPreEnableGrantRequest = {
    ...requestWithoutDigest,
    grantDigestSha256,
  };
  const body = new TextEncoder().encode(canonicalJson(requestBody));
  const token = await applicationHmacToken(
    env,
    pathAndQuery,
    requestId,
    await sha256Hex(body),
    now,
  );
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort("application_pre_enable_grant_timeout"),
    TIMEOUT_MILLISECONDS,
  );
  try {
    const response = await env.SHARD_PLACEMENT_APPLICATION.fetch(
      new Request(`https://cinatoken-application.internal${pathAndQuery}`, {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-cinatoken-shard-placement-application": token,
        },
        body,
      }),
    );
    if (
      (response.status !== 200 && response.status !== 201)
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
        "application_pre_enable_grant_invalid_response",
        502,
      );
    }
    const bytes = await readBoundedResponse(response);
    const envelope = parseObject(bytes);
    assertExactKeys(envelope, [
      "result",
      "requestId",
      "credentialIdSha256",
      "snapshot",
      "applicationVersionId",
    ]);
    const classification =
      envelope.result === "grant_created"
        ? "grant_created"
        : envelope.result === "exact_replay"
        ? "exact_replay"
        : null;
    if (
      classification === null
      || (classification === "grant_created" && response.status !== 201)
      || (classification === "exact_replay" && response.status !== 200)
      || envelope.requestId !== requestId
      || envelope.credentialIdSha256 !== credentialIdSha256
      || typeof envelope.applicationVersionId !== "string"
      || !IDENTITY.test(envelope.applicationVersionId)
    ) {
      throw new ProtocolError(
        "application_pre_enable_grant_invalid_response",
        502,
      );
    }
    const grant = parseGrant(envelope.snapshot);
    requireGrantMatches({
      grant,
      outbox,
      authorityLedgerIdentitySha256:
        command.authorityLedgerIdentitySha256,
      credentialIdSha256,
      requestIdSha256,
      grantDigestSha256,
    });
    if (
      await applicationPreEnableGrantDigest(grant)
        !== grant.grantDigestSha256
    ) {
      throw new ProtocolError(
        "application_pre_enable_grant_digest_mismatch",
        409,
      );
    }
    return {
      classification,
      grant,
      applicationVersionId: envelope.applicationVersionId,
      responseSha256: await sha256Hex(bytes),
      responseBytes: bytes.byteLength,
      credentialIdSha256,
      requestIdSha256,
    };
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    if (controller.signal.aborted) {
      throw new ProtocolError(
        "application_pre_enable_grant_timeout",
        504,
      );
    }
    throw new ProtocolError(
      "application_pre_enable_grant_unavailable",
      503,
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function applicationPreEnableGrantDigest(
  grant: Pick<
    ApplicationPreEnableGrantSnapshot,
    | "ticketIdSha256"
    | "authorizationIdSha256"
    | "applicationTicketDigestSha256"
    | "applicationDatabaseIdentitySha256"
    | "authorityClaimDigestSha256"
    | "applicationActivationDigestSha256"
    | "applicationAcknowledgementDigestSha256"
    | "operationFiveAdmissionDigestSha256"
    | "operationFiveStartReceiptSha256"
    | "authorityDispatchOutboxDigestSha256"
    | "authorityDatabaseIdentitySha256"
    | "authorityLedgerIdentitySha256"
    | "authorityLedgerHeadSha256"
    | "authorityVersionId"
    | "controllerServiceName"
    | "controllerEnableOperationIdSha256"
    | "controllerBaselineVersionId"
    | "controllerEnabledVersionId"
    | "applicationGrantCredentialIdSha256"
    | "applicationGrantRequestIdSha256"
  >,
): Promise<string> {
  return lengthPrefixedSha256(GRANT_DIGEST_DOMAIN, [
    APPLICATION_PRE_ENABLE_GRANT_CONTRACT,
    grant.ticketIdSha256,
    grant.authorizationIdSha256,
    grant.applicationTicketDigestSha256,
    grant.applicationDatabaseIdentitySha256,
    grant.authorityClaimDigestSha256,
    grant.applicationActivationDigestSha256,
    grant.applicationAcknowledgementDigestSha256,
    grant.operationFiveAdmissionDigestSha256,
    grant.operationFiveStartReceiptSha256,
    grant.authorityDispatchOutboxDigestSha256,
    grant.authorityDatabaseIdentitySha256,
    grant.authorityLedgerIdentitySha256,
    grant.authorityLedgerHeadSha256,
    grant.authorityVersionId,
    grant.controllerServiceName,
    grant.controllerEnableOperationIdSha256,
    grant.controllerBaselineVersionId,
    grant.controllerEnabledVersionId,
    grant.applicationGrantCredentialIdSha256,
    grant.applicationGrantRequestIdSha256,
  ]);
}

async function applicationHmacToken(
  env: ApplicationPreEnableGrantClientEnv,
  pathAndQuery: string,
  requestId: string,
  bodySha256: string,
  now: number,
): Promise<string> {
  const headerPart = encodeBase64Url(new TextEncoder().encode(canonicalJson({
    typ: "CINATOKEN-SHARD-PLACEMENT-APPLICATION",
    alg: "HS256",
    kid:
      env
        .SHARD_PLACEMENT_APPLICATION_PRE_ENABLE_GRANT_HMAC_CURRENT_KID,
  })));
  const claimsPart = encodeBase64Url(new TextEncoder().encode(canonicalJson({
    issuer: env.SHARD_PLACEMENT_APPLICATION_ISSUER,
    audience: env.SHARD_PLACEMENT_APPLICATION_AUDIENCE,
    role: "pre_enable_grant",
    credential_id_sha256:
      env
        .SHARD_PLACEMENT_APPLICATION_PRE_ENABLE_GRANT_HMAC_CURRENT_CREDENTIAL_ID_SHA256,
    request_id: requestId,
    method: "POST",
    path_and_query: pathAndQuery,
    body_sha256: bodySha256,
    issued_at: now,
    expires_at: now + 30,
  })));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(
      env
        .SHARD_PLACEMENT_APPLICATION_PRE_ENABLE_GRANT_HMAC_CURRENT_SECRET!,
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

function parseGrant(value: unknown): ApplicationPreEnableGrantSnapshot {
  const object = requireObject(value);
  assertExactKeys(object, GRANT_FIELDS);
  return {
    schemaVersion: requireLiteral(object.schemaVersion, 1),
    contract: requireLiteral(
      object.contract,
      APPLICATION_PRE_ENABLE_GRANT_SNAPSHOT_CONTRACT,
    ),
    ticketIdSha256: requireSha256(object.ticketIdSha256),
    authorizationIdSha256: requireSha256(
      object.authorizationIdSha256,
    ),
    applicationTicketDigestSha256: requireSha256(
      object.applicationTicketDigestSha256,
    ),
    applicationDatabaseIdentitySha256: requireSha256(
      object.applicationDatabaseIdentitySha256,
    ),
    authorityClaimDigestSha256: requireSha256(
      object.authorityClaimDigestSha256,
    ),
    applicationActivationDigestSha256: requireSha256(
      object.applicationActivationDigestSha256,
    ),
    applicationAcknowledgementDigestSha256: requireSha256(
      object.applicationAcknowledgementDigestSha256,
    ),
    operationFiveAdmissionDigestSha256: requireSha256(
      object.operationFiveAdmissionDigestSha256,
    ),
    operationFiveStartReceiptSha256: requireSha256(
      object.operationFiveStartReceiptSha256,
    ),
    authorityDispatchOutboxDigestSha256: requireSha256(
      object.authorityDispatchOutboxDigestSha256,
    ),
    authorityDatabaseIdentitySha256: requireSha256(
      object.authorityDatabaseIdentitySha256,
    ),
    authorityLedgerIdentitySha256: requireSha256(
      object.authorityLedgerIdentitySha256,
    ),
    authorityLedgerHeadSha256: requireSha256(
      object.authorityLedgerHeadSha256,
    ),
    authorityVersionId: requireIdentity(object.authorityVersionId),
    controllerServiceName: requireIdentity(
      object.controllerServiceName,
    ),
    controllerEnableOperationIdSha256: requireSha256(
      object.controllerEnableOperationIdSha256,
    ),
    controllerBaselineVersionId: requireIdentity(
      object.controllerBaselineVersionId,
    ),
    controllerEnabledVersionId: requireIdentity(
      object.controllerEnabledVersionId,
    ),
    applicationGrantCredentialIdSha256: requireSha256(
      object.applicationGrantCredentialIdSha256,
    ),
    applicationGrantRequestIdSha256: requireSha256(
      object.applicationGrantRequestIdSha256,
    ),
    grantDigestSha256: requireSha256(object.grantDigestSha256),
    grantedAt: requireTimestamp(object.grantedAt),
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

function requireGrantMatches(input: {
  grant: ApplicationPreEnableGrantSnapshot;
  outbox: OperationFiveDispatchOutboxRow;
  authorityLedgerIdentitySha256: string;
  credentialIdSha256: string;
  requestIdSha256: string;
  grantDigestSha256: string;
}): void {
  const { grant, outbox } = input;
  if (
    grant.ticketIdSha256 !== outbox.application_ticket_id_sha256
    || grant.authorizationIdSha256 !== outbox.authorization_id_sha256
    || grant.applicationTicketDigestSha256
      !== outbox.application_ticket_digest_sha256
    || grant.applicationDatabaseIdentitySha256
      !== outbox.application_database_identity_sha256
    || grant.authorityClaimDigestSha256 !== outbox.claim_digest_sha256
    || grant.applicationActivationDigestSha256
      !== outbox.application_activation_digest_sha256
    || grant.applicationAcknowledgementDigestSha256
      !== outbox.application_acknowledgement_digest_sha256
    || grant.operationFiveAdmissionDigestSha256
      !== outbox.operation_five_admission_digest_sha256
    || grant.operationFiveStartReceiptSha256
      !== outbox.operation_five_start_receipt_sha256
    || grant.authorityDispatchOutboxDigestSha256
      !== outbox.outbox_digest_sha256
    || grant.authorityDatabaseIdentitySha256
      !== outbox.authority_database_identity_sha256
    || grant.authorityLedgerIdentitySha256
      !== input.authorityLedgerIdentitySha256
    || grant.authorityLedgerHeadSha256
      !== outbox.authority_ledger_head_sha256
    || grant.authorityVersionId !== outbox.authority_version_id
    || grant.controllerServiceName !== outbox.controller_service_name
    || grant.controllerEnableOperationIdSha256
      !== outbox.controller_enable_operation_id_sha256
    || grant.controllerBaselineVersionId
      !== outbox.controller_baseline_version_id
    || grant.controllerEnabledVersionId
      !== outbox.controller_enabled_version_id
    || grant.applicationGrantCredentialIdSha256
      !== input.credentialIdSha256
    || grant.applicationGrantRequestIdSha256
      !== input.requestIdSha256
    || grant.grantDigestSha256 !== input.grantDigestSha256
    || grant.authorityLedgerHeadSha256
      !== grant.operationFiveStartReceiptSha256
    || grant.controllerBaselineVersionId
      === grant.controllerEnabledVersionId
    || grant.grantedAt > grant.databaseNow
    || grant.databaseNow >= grant.executionDeadlineAt
    || grant.databaseNow >= grant.permitExpiresAt
    || grant.databaseNow >= grant.campaignExpiresAt
    || grant.executionDeadlineAt !== grant.campaignExpiresAt
    || grant.campaignSealedAt !== null
  ) {
    throw new ProtocolError(
      "application_pre_enable_grant_mismatch",
      409,
    );
  }
}

async function lengthPrefixedSha256(
  domain: Uint8Array,
  values: readonly string[],
): Promise<string> {
  const encoded = values.map((value) => new TextEncoder().encode(value));
  const total = domain.byteLength
    + encoded.reduce((sum, value) => sum + 4 + value.byteLength, 0);
  const input = new Uint8Array(total);
  input.set(domain);
  let offset = domain.byteLength;
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

async function readBoundedResponse(response: Response): Promise<Uint8Array> {
  if (response.body === null) {
    throw new ProtocolError(
      "application_pre_enable_grant_invalid_response",
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
        await reader.cancel("application_pre_enable_grant_response_too_large");
        throw new ProtocolError(
          "application_pre_enable_grant_response_too_large",
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
      "application_pre_enable_grant_invalid_response",
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
      "application_pre_enable_grant_invalid_response",
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
      "application_pre_enable_grant_invalid_response",
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
      "application_pre_enable_grant_invalid_response",
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
      "application_pre_enable_grant_invalid_response",
      502,
    );
  }
  return expected;
}

function requireString(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new ProtocolError(
      "application_pre_enable_grant_invalid_response",
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
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value <= 0
  ) {
    throw new ProtocolError(
      "application_pre_enable_grant_invalid_response",
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
