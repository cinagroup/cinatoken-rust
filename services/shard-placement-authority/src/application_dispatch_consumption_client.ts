import {
  ProtocolError,
  canonicalJson,
  sha256Hex,
} from "./protocol";
import type {
  OperationFiveDispatchClaimRow,
} from "./execution_repository";

export const APPLICATION_DISPATCH_CONSUMPTION_CONTRACT =
  "cinatoken-relay-container-shard-placement-dispatch-consumption-v1";
const APPLICATION_DISPATCH_CONSUMPTION_RESULT_CONTRACT =
  "cinatoken-relay-container-shard-placement-dispatch-consumption-result-v1";
const APPLICATION_DISPATCH_CONSUMPTION_SNAPSHOT_CONTRACT =
  "cinatoken-relay-container-shard-placement-dispatch-consumption-snapshot-v1";
const APPLICATION_HMAC_DOMAIN =
  "cinatoken-shard-placement-application-v1\n";
const CONSUMPTION_DIGEST_DOMAIN = new Uint8Array([
  ...new TextEncoder().encode(
    "cinatoken:relay-container-shard-placement-dispatch-consumption:v1",
  ),
  0,
]);
const RESPONSE_LIMIT_BYTES = 64 * 1024;
const TIMEOUT_MILLISECONDS = 3_000;
const SHA256 = /^[0-9a-f]{64}$/;
const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface ApplicationDispatchConsumptionClientEnv {
  SHARD_PLACEMENT_APPLICATION: Fetcher;
  SHARD_PLACEMENT_APPLICATION_ISSUER: string;
  SHARD_PLACEMENT_APPLICATION_AUDIENCE: string;
  SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_HMAC_CURRENT_KID:
    string;
  SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
    string;
  SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_HMAC_CURRENT_SECRET?:
    string;
  SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_HMAC_PREVIOUS_KID:
    string;
  SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256:
    string;
  SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_HMAC_PREVIOUS_SECRET?:
    string;
}

export interface ApplicationDispatchConsumptionSnapshot {
  schemaVersion: 1;
  contract:
    "cinatoken-relay-container-shard-placement-dispatch-consumption-snapshot-v1";
  ticketIdSha256: string;
  contractVersion: 1;
  consumptionContract:
    "cinatoken-relay-container-shard-placement-dispatch-consumption-v1";
  authorizationIdSha256: string;
  campaignId: string;
  applicationDatabaseIdentitySha256: string;
  applicationVersionId: string;
  applicationGrantDigestSha256: string;
  authorityClaimDigestSha256: string;
  authorityDispatchOutboxDigestSha256: string;
  applicationGrantReceiptDigestSha256: string;
  operationFiveStartReceiptSha256: string;
  authorityDispatchClaimDigestSha256: string;
  authorityDatabaseIdentitySha256: string;
  authorityLedgerIdentitySha256: string;
  authorityLedgerHeadSha256: string;
  authorityVersionId: string;
  dispatchOwnerSha256: string;
  leaseTokenSha256: string;
  leaseGeneration: 1;
  leaseExpiresAt: number;
  normalDeadlineAt: number;
  permitExpiresAt: number;
  dispatchClaimCredentialIdSha256: string;
  dispatchClaimRequestIdSha256: string;
  commandDispatchClaimRequestIdSha256: string;
  authorityDispatchClaimedAt: number;
  controllerServiceName: string;
  controllerEnableOperationIdSha256: string;
  controllerBaselineVersionId: string;
  controllerEnabledVersionId: string;
  sendAttemptLimit: 1;
  retryLimit: 0;
  missingReadbackAllowsResend: 0;
  applicationDispatchConsumptionCredentialIdSha256: string;
  applicationDispatchConsumptionRequestIdSha256: string;
  commandDispatchConsumptionRequestIdSha256: string;
  dispatchConsumptionDigestSha256: string;
  consumptionState: "consumed";
  consumedAt: number;
}

export interface ApplicationDispatchConsumptionReadback {
  classification: "dispatch_consumption_recorded" | "exact_replay";
  consumption: ApplicationDispatchConsumptionSnapshot;
  responseSha256: string;
  responseBytes: number;
  credentialIdSha256: string;
  requestIdSha256: string;
}

interface ApplicationDispatchConsumptionRequest {
  schemaVersion: 1;
  contract: typeof APPLICATION_DISPATCH_CONSUMPTION_CONTRACT;
  ticketIdSha256: string;
  authorizationIdSha256: string;
  applicationDatabaseIdentitySha256: string;
  applicationVersionId: string;
  applicationGrantDigestSha256: string;
  authorityClaimDigestSha256: string;
  authorityDispatchOutboxDigestSha256: string;
  applicationGrantReceiptDigestSha256: string;
  operationFiveStartReceiptSha256: string;
  authorityDispatchClaimDigestSha256: string;
  authorityDatabaseIdentitySha256: string;
  authorityLedgerIdentitySha256: string;
  authorityLedgerHeadSha256: string;
  authorityVersionId: string;
  dispatchOwnerSha256: string;
  leaseTokenSha256: string;
  leaseGeneration: number;
  leaseExpiresAt: number;
  normalDeadlineAt: number;
  permitExpiresAt: number;
  dispatchClaimCredentialIdSha256: string;
  dispatchClaimRequestIdSha256: string;
  commandDispatchClaimRequestIdSha256: string;
  authorityDispatchClaimedAt: number;
  controllerServiceName: string;
  controllerEnableOperationIdSha256: string;
  controllerBaselineVersionId: string;
  controllerEnabledVersionId: string;
  sendAttemptLimit: number;
  retryLimit: number;
  missingReadbackAllowsResend: number;
  dispatchConsumptionRequestIdSha256: string;
}

const SNAPSHOT_FIELDS = [
  "schemaVersion",
  "contract",
  "ticketIdSha256",
  "contractVersion",
  "consumptionContract",
  "authorizationIdSha256",
  "campaignId",
  "applicationDatabaseIdentitySha256",
  "applicationVersionId",
  "applicationGrantDigestSha256",
  "authorityClaimDigestSha256",
  "authorityDispatchOutboxDigestSha256",
  "applicationGrantReceiptDigestSha256",
  "operationFiveStartReceiptSha256",
  "authorityDispatchClaimDigestSha256",
  "authorityDatabaseIdentitySha256",
  "authorityLedgerIdentitySha256",
  "authorityLedgerHeadSha256",
  "authorityVersionId",
  "dispatchOwnerSha256",
  "leaseTokenSha256",
  "leaseGeneration",
  "leaseExpiresAt",
  "normalDeadlineAt",
  "permitExpiresAt",
  "dispatchClaimCredentialIdSha256",
  "dispatchClaimRequestIdSha256",
  "commandDispatchClaimRequestIdSha256",
  "authorityDispatchClaimedAt",
  "controllerServiceName",
  "controllerEnableOperationIdSha256",
  "controllerBaselineVersionId",
  "controllerEnabledVersionId",
  "sendAttemptLimit",
  "retryLimit",
  "missingReadbackAllowsResend",
  "applicationDispatchConsumptionCredentialIdSha256",
  "applicationDispatchConsumptionRequestIdSha256",
  "commandDispatchConsumptionRequestIdSha256",
  "dispatchConsumptionDigestSha256",
  "consumptionState",
  "consumedAt",
] as const;

export function validateApplicationDispatchConsumptionClientConfig(
  env: ApplicationDispatchConsumptionClientEnv,
): void {
  const current = currentCredential(env);
  const previous = previousCredential(env);
  if (
    typeof env.SHARD_PLACEMENT_APPLICATION?.fetch !== "function"
    || !IDENTITY.test(env.SHARD_PLACEMENT_APPLICATION_ISSUER)
    || !IDENTITY.test(env.SHARD_PLACEMENT_APPLICATION_AUDIENCE)
    || !validCredential(current)
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
      "application_dispatch_consumption_client_unavailable",
      503,
    );
  }
}

export async function createExactApplicationDispatchConsumption(
  env: ApplicationDispatchConsumptionClientEnv,
  dispatchClaim: OperationFiveDispatchClaimRow,
  dispatchConsumptionRequestIdSha256: string,
  now = Math.floor(Date.now() / 1_000),
): Promise<ApplicationDispatchConsumptionReadback> {
  validateApplicationDispatchConsumptionClientConfig(env);
  if (!SHA256.test(dispatchConsumptionRequestIdSha256)) {
    throw new ProtocolError(
      "application_dispatch_consumption_command_invalid",
      400,
    );
  }
  const pathAndQuery =
    `/internal/v1/shard-placement/dispatch-consumptions/${dispatchClaim.application_ticket_id_sha256}`;
  const requestId =
    `op5-consume-${dispatchConsumptionRequestIdSha256.slice(0, 48)}`;
  const requestIdSha256 = await sha256Hex(
    new TextEncoder().encode(requestId),
  );
  let credential = currentCredential(env);
  const requestBody: ApplicationDispatchConsumptionRequest = {
    schemaVersion: 1,
    contract: APPLICATION_DISPATCH_CONSUMPTION_CONTRACT,
    ticketIdSha256: dispatchClaim.application_ticket_id_sha256,
    authorizationIdSha256: dispatchClaim.authorization_id_sha256,
    applicationDatabaseIdentitySha256:
      dispatchClaim.application_database_identity_sha256,
    applicationVersionId: dispatchClaim.application_version_id,
    applicationGrantDigestSha256:
      dispatchClaim.application_grant_digest_sha256,
    authorityClaimDigestSha256: dispatchClaim.claim_digest_sha256,
    authorityDispatchOutboxDigestSha256:
      dispatchClaim.authority_dispatch_outbox_digest_sha256,
    applicationGrantReceiptDigestSha256:
      dispatchClaim.application_grant_receipt_digest_sha256,
    operationFiveStartReceiptSha256:
      dispatchClaim.operation_five_start_receipt_sha256,
    authorityDispatchClaimDigestSha256:
      dispatchClaim.dispatch_claim_digest_sha256,
    authorityDatabaseIdentitySha256:
      dispatchClaim.authority_database_identity_sha256,
    authorityLedgerIdentitySha256:
      dispatchClaim.authority_ledger_identity_sha256,
    authorityLedgerHeadSha256:
      dispatchClaim.authority_ledger_head_sha256,
    authorityVersionId: dispatchClaim.authority_version_id,
    dispatchOwnerSha256: dispatchClaim.dispatch_owner_sha256,
    leaseTokenSha256: dispatchClaim.lease_token_sha256,
    leaseGeneration: dispatchClaim.lease_generation,
    leaseExpiresAt: dispatchClaim.lease_expires_at,
    normalDeadlineAt: dispatchClaim.normal_deadline_at,
    permitExpiresAt: dispatchClaim.permit_expires_at,
    dispatchClaimCredentialIdSha256:
      dispatchClaim.dispatch_claim_credential_id_sha256,
    dispatchClaimRequestIdSha256:
      dispatchClaim.dispatch_claim_request_id_sha256,
    commandDispatchClaimRequestIdSha256:
      dispatchClaim.command_dispatch_claim_request_id_sha256,
    authorityDispatchClaimedAt: dispatchClaim.claimed_at,
    controllerServiceName: dispatchClaim.controller_service_name,
    controllerEnableOperationIdSha256:
      dispatchClaim.controller_enable_operation_id_sha256,
    controllerBaselineVersionId:
      dispatchClaim.controller_baseline_version_id,
    controllerEnabledVersionId:
      dispatchClaim.controller_enabled_version_id,
    sendAttemptLimit: dispatchClaim.send_attempt_limit,
    retryLimit: dispatchClaim.retry_limit,
    missingReadbackAllowsResend:
      dispatchClaim.missing_readback_allows_resend,
    dispatchConsumptionRequestIdSha256,
  };
  const body = new TextEncoder().encode(canonicalJson(requestBody));
  const token = await applicationHmacToken(
    env,
    credential,
    pathAndQuery,
    requestId,
    await sha256Hex(body),
    now,
  );
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort("application_dispatch_consumption_timeout"),
    TIMEOUT_MILLISECONDS,
  );
  try {
    let response = await applicationFetch(
      env,
      pathAndQuery,
      body,
      token,
      controller.signal,
    );
    const previous = previousCredential(env);
    if (response.status === 409 && previous !== null) {
      await response.body?.cancel(
        "retry_exact_consumption_with_previous_credential",
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
        "application_dispatch_consumption_invalid_response",
        502,
      );
    }
    const bytes = await readBoundedResponse(response);
    const envelope = parseObject(bytes);
    assertExactKeys(envelope, [
      "contract",
      "result",
      "snapshot",
      "sendAttemptCreated",
      "controllerRequestSent",
    ]);
    const classification =
      envelope.result === "dispatch_consumption_recorded"
        ? "dispatch_consumption_recorded"
        : envelope.result === "exact_replay"
        ? "exact_replay"
        : null;
    if (
      envelope.contract
        !== APPLICATION_DISPATCH_CONSUMPTION_RESULT_CONTRACT
      || classification === null
      || (
        classification === "dispatch_consumption_recorded"
        && response.status !== 201
      )
      || (classification === "exact_replay" && response.status !== 200)
      || envelope.sendAttemptCreated !== false
      || envelope.controllerRequestSent !== false
    ) {
      throw new ProtocolError(
        "application_dispatch_consumption_invalid_response",
        502,
      );
    }
    const consumption = parseConsumption(envelope.snapshot);
    requireConsumptionMatches({
      consumption,
      dispatchClaim,
      dispatchConsumptionRequestIdSha256,
      credentialIdSha256: credential.credentialIdSha256,
      requestIdSha256,
    });
    if (
      await applicationDispatchConsumptionDigest(consumption)
        !== consumption.dispatchConsumptionDigestSha256
    ) {
      throw new ProtocolError(
        "application_dispatch_consumption_digest_mismatch",
        409,
      );
    }
    return {
      classification,
      consumption,
      responseSha256: await sha256Hex(bytes),
      responseBytes: bytes.byteLength,
      credentialIdSha256: credential.credentialIdSha256,
      requestIdSha256,
    };
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    if (controller.signal.aborted) {
      throw new ProtocolError(
        "application_dispatch_consumption_timeout",
        504,
      );
    }
    throw new ProtocolError(
      "application_dispatch_consumption_unavailable",
      503,
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function applicationDispatchConsumptionDigest(
  value: ApplicationDispatchConsumptionSnapshot,
): Promise<string> {
  return lengthPrefixedSha256(CONSUMPTION_DIGEST_DOMAIN, [
    value.consumptionContract,
    value.ticketIdSha256,
    value.authorizationIdSha256,
    value.campaignId,
    value.applicationDatabaseIdentitySha256,
    value.applicationVersionId,
    value.applicationGrantDigestSha256,
    value.authorityClaimDigestSha256,
    value.authorityDispatchOutboxDigestSha256,
    value.applicationGrantReceiptDigestSha256,
    value.operationFiveStartReceiptSha256,
    value.authorityDispatchClaimDigestSha256,
    value.authorityDatabaseIdentitySha256,
    value.authorityLedgerIdentitySha256,
    value.authorityLedgerHeadSha256,
    value.authorityVersionId,
    value.dispatchOwnerSha256,
    value.leaseTokenSha256,
    String(value.leaseGeneration),
    String(value.leaseExpiresAt),
    String(value.normalDeadlineAt),
    String(value.permitExpiresAt),
    value.dispatchClaimCredentialIdSha256,
    value.dispatchClaimRequestIdSha256,
    value.commandDispatchClaimRequestIdSha256,
    String(value.authorityDispatchClaimedAt),
    value.controllerServiceName,
    value.controllerEnableOperationIdSha256,
    value.controllerBaselineVersionId,
    value.controllerEnabledVersionId,
    String(value.sendAttemptLimit),
    String(value.retryLimit),
    String(value.missingReadbackAllowsResend),
    value.applicationDispatchConsumptionCredentialIdSha256,
    value.applicationDispatchConsumptionRequestIdSha256,
    value.commandDispatchConsumptionRequestIdSha256,
    value.consumptionState,
  ]);
}

async function applicationHmacToken(
  env: ApplicationDispatchConsumptionClientEnv,
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
    role: "dispatch_consumption",
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

interface HmacCredential {
  kid: string;
  credentialIdSha256: string;
  secret: string;
}

function currentCredential(
  env: ApplicationDispatchConsumptionClientEnv,
): HmacCredential {
  return {
    kid:
      env
        .SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_HMAC_CURRENT_KID,
    credentialIdSha256:
      env
        .SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_HMAC_CURRENT_CREDENTIAL_ID_SHA256,
    secret:
      env
        .SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_HMAC_CURRENT_SECRET
        ?? "",
  };
}

function previousCredential(
  env: ApplicationDispatchConsumptionClientEnv,
): HmacCredential | null {
  const credential = {
    kid:
      env
        .SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_HMAC_PREVIOUS_KID,
    credentialIdSha256:
      env
        .SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256,
    secret:
      env
        .SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_HMAC_PREVIOUS_SECRET
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

function applicationFetch(
  env: ApplicationDispatchConsumptionClientEnv,
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

function parseConsumption(
  value: unknown,
): ApplicationDispatchConsumptionSnapshot {
  const object = requireObject(value);
  assertExactKeys(object, SNAPSHOT_FIELDS);
  return {
    schemaVersion: requireLiteral(object.schemaVersion, 1),
    contract: requireLiteral(
      object.contract,
      APPLICATION_DISPATCH_CONSUMPTION_SNAPSHOT_CONTRACT,
    ),
    ticketIdSha256: requireSha256(object.ticketIdSha256),
    contractVersion: requireLiteral(object.contractVersion, 1),
    consumptionContract: requireLiteral(
      object.consumptionContract,
      APPLICATION_DISPATCH_CONSUMPTION_CONTRACT,
    ),
    authorizationIdSha256: requireSha256(
      object.authorizationIdSha256,
    ),
    campaignId: requireSha256(object.campaignId),
    applicationDatabaseIdentitySha256: requireSha256(
      object.applicationDatabaseIdentitySha256,
    ),
    applicationVersionId: requireIdentity(object.applicationVersionId),
    applicationGrantDigestSha256: requireSha256(
      object.applicationGrantDigestSha256,
    ),
    authorityClaimDigestSha256: requireSha256(
      object.authorityClaimDigestSha256,
    ),
    authorityDispatchOutboxDigestSha256: requireSha256(
      object.authorityDispatchOutboxDigestSha256,
    ),
    applicationGrantReceiptDigestSha256: requireSha256(
      object.applicationGrantReceiptDigestSha256,
    ),
    operationFiveStartReceiptSha256: requireSha256(
      object.operationFiveStartReceiptSha256,
    ),
    authorityDispatchClaimDigestSha256: requireSha256(
      object.authorityDispatchClaimDigestSha256,
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
    dispatchOwnerSha256: requireSha256(object.dispatchOwnerSha256),
    leaseTokenSha256: requireSha256(object.leaseTokenSha256),
    leaseGeneration: requireLiteral(object.leaseGeneration, 1),
    leaseExpiresAt: requireTimestamp(object.leaseExpiresAt),
    normalDeadlineAt: requireTimestamp(object.normalDeadlineAt),
    permitExpiresAt: requireTimestamp(object.permitExpiresAt),
    dispatchClaimCredentialIdSha256: requireSha256(
      object.dispatchClaimCredentialIdSha256,
    ),
    dispatchClaimRequestIdSha256: requireSha256(
      object.dispatchClaimRequestIdSha256,
    ),
    commandDispatchClaimRequestIdSha256: requireSha256(
      object.commandDispatchClaimRequestIdSha256,
    ),
    authorityDispatchClaimedAt: requireTimestamp(
      object.authorityDispatchClaimedAt,
    ),
    controllerServiceName: requireIdentity(object.controllerServiceName),
    controllerEnableOperationIdSha256: requireSha256(
      object.controllerEnableOperationIdSha256,
    ),
    controllerBaselineVersionId: requireIdentity(
      object.controllerBaselineVersionId,
    ),
    controllerEnabledVersionId: requireIdentity(
      object.controllerEnabledVersionId,
    ),
    sendAttemptLimit: requireLiteral(object.sendAttemptLimit, 1),
    retryLimit: requireLiteral(object.retryLimit, 0),
    missingReadbackAllowsResend: requireLiteral(
      object.missingReadbackAllowsResend,
      0,
    ),
    applicationDispatchConsumptionCredentialIdSha256: requireSha256(
      object.applicationDispatchConsumptionCredentialIdSha256,
    ),
    applicationDispatchConsumptionRequestIdSha256: requireSha256(
      object.applicationDispatchConsumptionRequestIdSha256,
    ),
    commandDispatchConsumptionRequestIdSha256: requireSha256(
      object.commandDispatchConsumptionRequestIdSha256,
    ),
    dispatchConsumptionDigestSha256: requireSha256(
      object.dispatchConsumptionDigestSha256,
    ),
    consumptionState: requireLiteral(object.consumptionState, "consumed"),
    consumedAt: requireTimestamp(object.consumedAt),
  };
}

function requireConsumptionMatches(input: {
  consumption: ApplicationDispatchConsumptionSnapshot;
  dispatchClaim: OperationFiveDispatchClaimRow;
  dispatchConsumptionRequestIdSha256: string;
  credentialIdSha256: string;
  requestIdSha256: string;
}): void {
  const { consumption, dispatchClaim } = input;
  if (
    consumption.ticketIdSha256
      !== dispatchClaim.application_ticket_id_sha256
    || consumption.authorizationIdSha256
      !== dispatchClaim.authorization_id_sha256
    || consumption.applicationDatabaseIdentitySha256
      !== dispatchClaim.application_database_identity_sha256
    || consumption.applicationVersionId
      !== dispatchClaim.application_version_id
    || consumption.applicationGrantDigestSha256
      !== dispatchClaim.application_grant_digest_sha256
    || consumption.authorityClaimDigestSha256
      !== dispatchClaim.claim_digest_sha256
    || consumption.authorityDispatchOutboxDigestSha256
      !== dispatchClaim.authority_dispatch_outbox_digest_sha256
    || consumption.applicationGrantReceiptDigestSha256
      !== dispatchClaim.application_grant_receipt_digest_sha256
    || consumption.operationFiveStartReceiptSha256
      !== dispatchClaim.operation_five_start_receipt_sha256
    || consumption.authorityDispatchClaimDigestSha256
      !== dispatchClaim.dispatch_claim_digest_sha256
    || consumption.authorityDatabaseIdentitySha256
      !== dispatchClaim.authority_database_identity_sha256
    || consumption.authorityLedgerIdentitySha256
      !== dispatchClaim.authority_ledger_identity_sha256
    || consumption.authorityLedgerHeadSha256
      !== dispatchClaim.authority_ledger_head_sha256
    || consumption.authorityVersionId
      !== dispatchClaim.authority_version_id
    || consumption.dispatchOwnerSha256
      !== dispatchClaim.dispatch_owner_sha256
    || consumption.leaseTokenSha256 !== dispatchClaim.lease_token_sha256
    || consumption.leaseGeneration !== dispatchClaim.lease_generation
    || consumption.leaseExpiresAt !== dispatchClaim.lease_expires_at
    || consumption.normalDeadlineAt !== dispatchClaim.normal_deadline_at
    || consumption.permitExpiresAt !== dispatchClaim.permit_expires_at
    || consumption.dispatchClaimCredentialIdSha256
      !== dispatchClaim.dispatch_claim_credential_id_sha256
    || consumption.dispatchClaimRequestIdSha256
      !== dispatchClaim.dispatch_claim_request_id_sha256
    || consumption.commandDispatchClaimRequestIdSha256
      !== dispatchClaim.command_dispatch_claim_request_id_sha256
    || consumption.authorityDispatchClaimedAt !== dispatchClaim.claimed_at
    || consumption.controllerServiceName
      !== dispatchClaim.controller_service_name
    || consumption.controllerEnableOperationIdSha256
      !== dispatchClaim.controller_enable_operation_id_sha256
    || consumption.controllerBaselineVersionId
      !== dispatchClaim.controller_baseline_version_id
    || consumption.controllerEnabledVersionId
      !== dispatchClaim.controller_enabled_version_id
    || consumption.sendAttemptLimit !== dispatchClaim.send_attempt_limit
    || consumption.retryLimit !== dispatchClaim.retry_limit
    || consumption.missingReadbackAllowsResend
      !== dispatchClaim.missing_readback_allows_resend
    || consumption.applicationDispatchConsumptionCredentialIdSha256
      !== input.credentialIdSha256
    || consumption.applicationDispatchConsumptionRequestIdSha256
      !== input.requestIdSha256
    || consumption.commandDispatchConsumptionRequestIdSha256
      !== input.dispatchConsumptionRequestIdSha256
    || consumption.consumedAt < consumption.authorityDispatchClaimedAt
  ) {
    throw new ProtocolError(
      "application_dispatch_consumption_mismatch",
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
      "application_dispatch_consumption_invalid_response",
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
          "application_dispatch_consumption_response_too_large",
        );
        throw new ProtocolError(
          "application_dispatch_consumption_response_too_large",
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
      "application_dispatch_consumption_invalid_response",
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
      "application_dispatch_consumption_invalid_response",
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
      "application_dispatch_consumption_invalid_response",
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
      "application_dispatch_consumption_invalid_response",
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
      "application_dispatch_consumption_invalid_response",
      502,
    );
  }
  return expected;
}

function requireString(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new ProtocolError(
      "application_dispatch_consumption_invalid_response",
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
      "application_dispatch_consumption_invalid_response",
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
