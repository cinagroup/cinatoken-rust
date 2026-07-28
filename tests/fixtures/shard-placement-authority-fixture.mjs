import {
  createPrivateKey,
  sign,
} from "node:crypto";

import {
  APPROVAL_CONTRACT,
  ISSUANCE_CONTRACT,
  PERMIT_CONTRACT,
  REVOCATION_CONTRACT,
  approvalMessage,
  canonicalJson,
  createHmacTokenForTest,
  encodePermitMessage,
  sha256Hex,
} from "../../services/shard-placement-authority/src/protocol.ts";
import {
  EXECUTION_CLAIM_CONTRACT,
  EXECUTION_CLAIM_SCOPE,
  EXECUTION_RECEIPT_CONTRACT,
  claimAcquiredDigestInput,
  requestIdSha256,
} from "../../services/shard-placement-authority/src/execution_protocol.ts";
import { SHARD_PLACEMENT_AUTHORITY_TEST_KEYS } from "./shard-placement-authority-test-keys.mjs";

export const SHARD_PLACEMENT_AUTHORITY_ORIGIN =
  "https://shard-placement-authority-runtime.test";
export const SHARD_PLACEMENT_AUTHORITY_POLICY_ID =
  "placement-policy-test-v1";
export const SHARD_PLACEMENT_AUTHORITY_POLICY_SHA256 = "9".repeat(64);
export const SHARD_PLACEMENT_AUTHORITY_HMAC = Object.freeze({
  read: Object.freeze({
    keyId: "read-hmac-test-v1",
    credentialIdSha256: "a".repeat(64),
    secret: "read-hmac-test-secret-00000000000000000000000000000000",
  }),
  issue: Object.freeze({
    keyId: "issue-hmac-test-v1",
    credentialIdSha256: "b".repeat(64),
    secret: "issue-hmac-test-secret-0000000000000000000000000000000",
  }),
  revoke: Object.freeze({
    keyId: "revoke-hmac-test-v1",
    credentialIdSha256: "c".repeat(64),
    secret: "revoke-hmac-test-secret-000000000000000000000000000000",
  }),
  claim: Object.freeze({
    keyId: "claim-hmac-test-v1",
    credentialIdSha256: "d".repeat(64),
    secret: "claim-hmac-test-secret-0000000000000000000000000000000",
  }),
  activate: Object.freeze({
    keyId: "activate-hmac-test-v1",
    credentialIdSha256: "0".repeat(64),
    secret:
      "activate-hmac-test-secret-0000000000000000000000000000",
  }),
  enable: Object.freeze({
    keyId: "enable-hmac-test-v1",
    credentialIdSha256: "1".repeat(64),
    secret:
      "enable-hmac-test-secret-000000000000000000000000000000",
  }),
  dispatch: Object.freeze({
    keyId: "dispatch-hmac-test-v1",
    credentialIdSha256: "2".repeat(64),
    secret:
      "dispatch-hmac-test-secret-0000000000000000000000000000",
  }),
  grant: Object.freeze({
    keyId: "grant-hmac-test-v1",
    credentialIdSha256: "3".repeat(64),
    secret:
      "grant-hmac-test-secret-0000000000000000000000000000000",
  }),
  send: Object.freeze({
    keyId: "send-hmac-test-v1",
    credentialIdSha256: "4".repeat(64),
    secret:
      "send-hmac-test-secret-00000000000000000000000000000000",
  }),
  receipt: Object.freeze({
    keyId: "receipt-hmac-test-v1",
    credentialIdSha256: "e".repeat(64),
    secret: "receipt-hmac-test-secret-00000000000000000000000000000",
  }),
  recovery: Object.freeze({
    keyId: "recovery-hmac-test-v1",
    credentialIdSha256: "f".repeat(64),
    secret: "recovery-hmac-test-secret-0000000000000000000000000000",
  }),
});

const APPROVAL_ROLES = [
  "security",
  "operations",
  "release",
  "rollback",
];

export function shardPlacementAuthorityEnv(overrides = {}) {
  const keys = SHARD_PLACEMENT_AUTHORITY_TEST_KEYS;
  return {
    ENVIRONMENT: "staging",
    SHARD_PLACEMENT_AUTHORITY_ENABLED: "true",
    SHARD_PLACEMENT_AUTHORITY_READ_ENABLED: "true",
    SHARD_PLACEMENT_AUTHORITY_ISSUE_WRITE_ENABLED: "true",
    SHARD_PLACEMENT_AUTHORITY_REVOKE_WRITE_ENABLED: "true",
    SHARD_PLACEMENT_AUTHORITY_CLAIM_WRITE_ENABLED: "true",
    SHARD_PLACEMENT_AUTHORITY_RECEIPT_WRITE_ENABLED: "true",
    SHARD_PLACEMENT_AUTHORITY_RECOVERY_WRITE_ENABLED: "true",
    SHARD_PLACEMENT_AUTHORITY_ACTIVATION_READ_ENABLED: "false",
    SHARD_PLACEMENT_AUTHORITY_ACTIVATION_WRITE_ENABLED: "false",
    SHARD_PLACEMENT_AUTHORITY_PRE_ENABLE_READ_ENABLED: "false",
    SHARD_PLACEMENT_AUTHORITY_ENABLE_INTENT_WRITE_ENABLED: "false",
    SHARD_PLACEMENT_AUTHORITY_PRE_DISPATCH_READ_ENABLED: "false",
    SHARD_PLACEMENT_AUTHORITY_DISPATCH_OUTBOX_WRITE_ENABLED: "false",
    SHARD_PLACEMENT_AUTHORITY_PRE_ENABLE_GRANT_WRITE_ENABLED:
      "false",
    SHARD_PLACEMENT_AUTHORITY_PRE_ENABLE_GRANT_RECEIPT_WRITE_ENABLED:
      "false",
    SHARD_PLACEMENT_APPLICATION_DATABASE_IDENTITY_SHA256:
      "6".repeat(64),
    SHARD_PLACEMENT_AUTHORITY_DATABASE_IDENTITY_SHA256:
      "7".repeat(64),
    SHARD_PLACEMENT_AUTHORITY_LEDGER_IDENTITY_SHA256:
      "8".repeat(64),
    SHARD_PLACEMENT_AUTHORITY_ISSUER:
      "cinatoken-shard-placement-operator-runtime-test",
    SHARD_PLACEMENT_AUTHORITY_AUDIENCE:
      "cinatoken-shard-placement-authority-runtime-test",
    SHARD_PLACEMENT_AUTHORITY_POLICY_ID:
      SHARD_PLACEMENT_AUTHORITY_POLICY_ID,
    SHARD_PLACEMENT_AUTHORITY_POLICY_SHA256:
      SHARD_PLACEMENT_AUTHORITY_POLICY_SHA256,
    SHARD_PLACEMENT_PERMIT_ISSUER:
      "cinatoken-shard-placement-permit-runtime-test",
    SHARD_PLACEMENT_PERMIT_KEY_ID: keys.permit.keyId,
    SHARD_PLACEMENT_PERMIT_SPKI_BASE64URL:
      keys.permit.spkiBase64url,
    SHARD_PLACEMENT_PERMIT_SPKI_SHA256: keys.permit.spkiSha256,
    SHARD_PLACEMENT_SECURITY_KEY_ID: keys.security.keyId,
    SHARD_PLACEMENT_SECURITY_SPKI_BASE64URL:
      keys.security.spkiBase64url,
    SHARD_PLACEMENT_SECURITY_SPKI_SHA256:
      keys.security.spkiSha256,
    SHARD_PLACEMENT_OPERATIONS_KEY_ID: keys.operations.keyId,
    SHARD_PLACEMENT_OPERATIONS_SPKI_BASE64URL:
      keys.operations.spkiBase64url,
    SHARD_PLACEMENT_OPERATIONS_SPKI_SHA256:
      keys.operations.spkiSha256,
    SHARD_PLACEMENT_RELEASE_KEY_ID: keys.release.keyId,
    SHARD_PLACEMENT_RELEASE_SPKI_BASE64URL:
      keys.release.spkiBase64url,
    SHARD_PLACEMENT_RELEASE_SPKI_SHA256:
      keys.release.spkiSha256,
    SHARD_PLACEMENT_ROLLBACK_KEY_ID: keys.rollback.keyId,
    SHARD_PLACEMENT_ROLLBACK_SPKI_BASE64URL:
      keys.rollback.spkiBase64url,
    SHARD_PLACEMENT_ROLLBACK_SPKI_SHA256:
      keys.rollback.spkiSha256,
    ...hmacEnvironment("READ", SHARD_PLACEMENT_AUTHORITY_HMAC.read),
    ...hmacEnvironment("ISSUE", SHARD_PLACEMENT_AUTHORITY_HMAC.issue),
    ...hmacEnvironment("REVOKE", SHARD_PLACEMENT_AUTHORITY_HMAC.revoke),
    ...hmacEnvironment("CLAIM", SHARD_PLACEMENT_AUTHORITY_HMAC.claim),
    ...hmacEnvironment(
      "ACTIVATE",
      SHARD_PLACEMENT_AUTHORITY_HMAC.activate,
    ),
    ...hmacEnvironment(
      "ENABLE",
      SHARD_PLACEMENT_AUTHORITY_HMAC.enable,
    ),
    ...hmacEnvironment(
      "DISPATCH",
      SHARD_PLACEMENT_AUTHORITY_HMAC.dispatch,
    ),
    ...hmacEnvironment(
      "GRANT",
      SHARD_PLACEMENT_AUTHORITY_HMAC.grant,
    ),
    ...hmacEnvironment(
      "SEND",
      SHARD_PLACEMENT_AUTHORITY_HMAC.send,
    ),
    ...hmacEnvironment(
      "RECEIPT",
      SHARD_PLACEMENT_AUTHORITY_HMAC.receipt,
    ),
    ...hmacEnvironment(
      "RECOVERY",
      SHARD_PLACEMENT_AUTHORITY_HMAC.recovery,
    ),
    ...overrides,
  };
}

export async function signedPlacementAuthorityIssuance({
  now = Math.floor(Date.now() / 1_000),
  permitOverrides = {},
  envelopeOverrides = {},
  approvalOverrides = {},
} = {}) {
  const keys = SHARD_PLACEMENT_AUTHORITY_TEST_KEYS;
  const unsignedPermit = {
    schema_version: 1,
    contract: PERMIT_CONTRACT,
    issuer: "cinatoken-shard-placement-permit-runtime-test",
    key_id: keys.permit.keyId,
    environment: "staging",
    authorization_id_sha256: "1".repeat(64),
    execution_nonce_sha256: "2".repeat(64),
    campaign_id: "3".repeat(64),
    campaign_nonce_sha256: "4".repeat(64),
    controller_service_name:
      "cinatoken-container-controller-staging",
    controller_version_id: "placement-controller-test-v1",
    action_gate_inventory_sha256: "5".repeat(64),
    foundation_manifest_sha256: "6".repeat(64),
    runtime_build_id: "7".repeat(64),
    ring_generation: 19,
    shard_count: 8,
    campaign_lifetime_seconds: 300,
    issued_at: now - 5,
    expires_at: now + 300,
    ...permitOverrides,
  };
  const permit = {
    ...unsignedPermit,
    signature_base64url: sign(
      null,
      Buffer.from(encodePermitMessage(unsignedPermit)),
      privateKey("permit"),
    ).toString("base64url"),
  };
  const permitSubjectDigestSha256 = await sha256Hex(
    encodePermitMessage(unsignedPermit),
  );
  const approvals = APPROVAL_ROLES.map((role) => {
    const roleOverrides = approvalOverrides[role] ?? {};
    const unsignedApproval = {
      schema_version: 1,
      contract: APPROVAL_CONTRACT,
      role,
      key_id: keys[role].keyId,
      policy_id: SHARD_PLACEMENT_AUTHORITY_POLICY_ID,
      policy_sha256: SHARD_PLACEMENT_AUTHORITY_POLICY_SHA256,
      permit_subject_digest_sha256: permitSubjectDigestSha256,
      authorization_id_sha256: permit.authorization_id_sha256,
      execution_nonce_sha256: permit.execution_nonce_sha256,
      campaign_id: permit.campaign_id,
      controller_version_id: permit.controller_version_id,
      signed_at: now,
      expires_at: permit.expires_at + 60,
      ...roleOverrides,
    };
    return {
      ...unsignedApproval,
      signature_base64url: sign(
        null,
        Buffer.from(approvalMessage(unsignedApproval)),
        privateKey(role),
      ).toString("base64url"),
    };
  });
  const envelope = {
    schema_version: 1,
    contract: ISSUANCE_CONTRACT,
    policy_id: SHARD_PLACEMENT_AUTHORITY_POLICY_ID,
    policy_sha256: SHARD_PLACEMENT_AUTHORITY_POLICY_SHA256,
    permit,
    approvals,
    ...envelopeOverrides,
  };
  return {
    envelope,
    body: canonicalJson(envelope),
    permit,
    permitSubjectDigestSha256,
    approvals,
  };
}

export async function signedAuthorityRequest({
  method,
  pathAndQuery,
  role,
  body = "",
  requestId,
  now = Math.floor(Date.now() / 1_000),
}) {
  const identity = SHARD_PLACEMENT_AUTHORITY_HMAC[role];
  const bodySha256 = await sha256Hex(new TextEncoder().encode(body));
  const token = await createHmacTokenForTest(
    identity.secret,
    identity.keyId,
    {
      issuer: "cinatoken-shard-placement-operator-runtime-test",
      audience:
        "cinatoken-shard-placement-authority-runtime-test",
      role,
      credential_id_sha256: identity.credentialIdSha256,
      request_id: requestId,
      method,
      path_and_query: pathAndQuery,
      body_sha256: bodySha256,
      issued_at: now - 1,
      expires_at: now + 30,
    },
  );
  const headers = new Headers({
    "x-cinatoken-shard-placement-authority": token,
  });
  if (body.length > 0) headers.set("content-type", "application/json");
  return new Request(`${SHARD_PLACEMENT_AUTHORITY_ORIGIN}${pathAndQuery}`, {
    method,
    headers,
    body: body.length > 0 ? body : undefined,
  });
}

export async function placementAuthorityRevocation({
  authorizationIdSha256,
  permitSubjectDigestSha256,
  reasonCode = "operator_abort",
  evidenceSha256 = "8".repeat(64),
}) {
  const unsigned = {
    schemaVersion: 1,
    contract: REVOCATION_CONTRACT,
    authorizationIdSha256,
    permitSubjectDigestSha256,
    reasonCode,
    evidenceSha256,
  };
  const value = {
    ...unsigned,
    revocationEventSha256: await sha256Hex(
      new TextEncoder().encode(canonicalJson(unsigned)),
    ),
  };
  return {
    value,
    body: canonicalJson(value),
  };
}

export async function placementExecutionClaim({
  issuance,
  now = Math.floor(Date.now() / 1_000),
  requestId = "placement-claim-fixture-1",
  overrides = {},
} = {}) {
  const source = issuance ?? await signedPlacementAuthorityIssuance({ now });
  const operations = await Promise.all(
    Array.from({ length: 11 }, async (_, index) => {
      const ordinal = index + 4;
      return {
        ordinal,
        operationIdSha256:
          await digestLabel(`placement-operation-${ordinal}`),
        kind: ordinal === 4
          ? "activate_execution_ticket"
          : ordinal === 5
            ? "enable_controller_deployment"
            : ordinal === 14
              ? "disable_controller_deployment"
              : "probe_shard_readiness",
        shardIndex:
          ordinal >= 6 && ordinal <= 13 ? ordinal - 6 : null,
      };
    }),
  );
  const unsigned = {
    schemaVersion: 1,
    contract: EXECUTION_CLAIM_CONTRACT,
    claimScope: EXECUTION_CLAIM_SCOPE,
    environment: "staging",
    authorizationIdSha256:
      source.permit.authorization_id_sha256,
    executionNonceSha256: source.permit.execution_nonce_sha256,
    permitSubjectDigestSha256: source.permitSubjectDigestSha256,
    applicationTicketIdSha256:
      await digestLabel("placement-application-ticket-id"),
    applicationTicketDigestSha256:
      await digestLabel("placement-application-ticket"),
    applicationDatabaseIdentitySha256: "6".repeat(64),
    authorityDatabaseIdentitySha256: "7".repeat(64),
    campaignId: source.permit.campaign_id,
    campaignNonceSha256: source.permit.campaign_nonce_sha256,
    executionPlanSha256:
      await digestLabel("placement-execution-plan"),
    releaseSha256: await digestLabel("placement-release"),
    publicationSha256: await digestLabel("placement-publication"),
    executionActivationSha256:
      await digestLabel("placement-execution-activation"),
    runnerBuildSha256: await digestLabel("placement-runner-build"),
    claimOwnerSha256: await digestLabel("placement-claim-owner"),
    ledgerIdentitySha256: "8".repeat(64),
    baselineOperationIdSha256:
      await digestLabel("placement-operation-1"),
    baselineTerminalReceiptSha256:
      await digestLabel("placement-operation-1-terminal-receipt"),
    preparationOperationIdSha256:
      await digestLabel("placement-operation-2"),
    claimOperationIdSha256:
      await digestLabel("placement-operation-3"),
    leaseTokenSha256:
      await digestLabel("placement-lease-token-generation-1"),
    claimCredentialIdSha256:
      SHARD_PLACEMENT_AUTHORITY_HMAC.claim.credentialIdSha256,
    requestIdSha256: await requestIdSha256(requestId),
    generatedAt: now,
    normalDeadlineAt: source.permit.expires_at,
    operationScheduleSha256: await sha256Hex(
      new TextEncoder().encode(canonicalJson({
        baselineOperationIdSha256:
          await digestLabel("placement-operation-1"),
        preparationOperationIdSha256:
          await digestLabel("placement-operation-2"),
        claimOperationIdSha256:
          await digestLabel("placement-operation-3"),
        operations,
      })),
    ),
    operations,
    ...overrides,
  };
  const digestInput = {
    ...unsigned,
  };
  const claimDigestSha256 = await sha256Hex(
    new TextEncoder().encode(canonicalJson(digestInput)),
  );
  const partial = {
    ...unsigned,
    claimDigestSha256,
  };
  const value = {
    ...partial,
    claimAcquiredReceiptSha256: await sha256Hex(
      new TextEncoder().encode(
        canonicalJson(claimAcquiredDigestInput(partial)),
      ),
    ),
  };
  return {
    issuance: source,
    requestId,
    value,
    body: canonicalJson(value),
  };
}

export async function placementExecutionReceipt({
  claim,
  sequence,
  eventKind,
  operationOrdinal = null,
  predecessorReceiptSha256,
  outcome = eventKind === "operation_started" ? "pending" : null,
  leaseGeneration = 1,
  leaseTokenSha256 = claim.leaseTokenSha256,
  actorOwnerSha256 = claim.claimOwnerSha256,
  role = eventKind === "operation_started"
      || eventKind === "operation_terminal"
    ? "receipt"
    : "recovery",
  requestId = `placement-${eventKind}-${sequence}`,
  requestSha256,
  responseSha256,
  cloudflareRequestIdSha256 = null,
  evidenceSha256,
  safetyReason = null,
  overrides = {},
}) {
  const leaseEvent =
    eventKind === "lease_renewed"
    || eventKind === "lease_taken_over";
  const safetyEvent = eventKind === "safety_diverted";
  const effectiveOrdinal = operationOrdinal
    ?? (leaseEvent ? 3 : safetyEvent ? 14 : null);
  const operation = effectiveOrdinal === 3
    ? {
        ordinal: 3,
        operationIdSha256: claim.claimOperationIdSha256,
        kind: "create_authority_claim",
        shardIndex: null,
      }
    : claim.operations.find(
        (entry) => entry.ordinal === effectiveOrdinal,
      );
  if (effectiveOrdinal === null || operation === undefined) {
    throw new Error("unknown test operation");
  }
  const isOperation =
    eventKind === "operation_started"
    || eventKind === "operation_terminal";
  const unsigned = {
    schemaVersion: 1,
    contract: EXECUTION_RECEIPT_CONTRACT,
    eventKind,
    authorizationIdSha256: claim.authorizationIdSha256,
    claimDigestSha256: claim.claimDigestSha256,
    executionPlanSha256: claim.executionPlanSha256,
    ledgerIdentitySha256: claim.ledgerIdentitySha256,
    sequence,
    predecessorReceiptSha256:
      predecessorReceiptSha256
      ?? claim.claimAcquiredReceiptSha256,
    leaseGeneration,
    leaseTokenSha256,
    leaseDurationSeconds: leaseEvent ? 60 : null,
    actorOwnerSha256,
    actorCredentialIdSha256:
      SHARD_PLACEMENT_AUTHORITY_HMAC[role].credentialIdSha256,
    requestIdSha256: await requestIdSha256(requestId),
    operationOrdinal: effectiveOrdinal,
    operationIdSha256: operation.operationIdSha256,
    operationKind: operation.kind,
    shardIndex: operation.shardIndex,
    outcome: outcome
      ?? (leaseEvent
        ? "exact_success"
        : safetyEvent
        ? "disable_required"
        : "exact_success"),
    requestSha256: requestSha256 ?? await digestLabel(
      `placement-request-${effectiveOrdinal}`,
    ),
    responseSha256:
      eventKind === "operation_terminal"
        ? responseSha256
          ?? await digestLabel(`placement-response-${operationOrdinal}`)
        : null,
    evidenceSha256:
      evidenceSha256 ?? await digestLabel(
        `placement-evidence-${sequence}`,
      ),
    cloudflareRequestIdSha256,
    safetyReason: safetyEvent
      ? safetyReason ?? "operation_failed"
      : null,
    ...overrides,
  };
  const value = {
    ...unsigned,
    receiptDigestSha256: await sha256Hex(
      new TextEncoder().encode(canonicalJson(unsigned)),
    ),
  };
  return { value, body: canonicalJson(value), requestId, role };
}

function hmacEnvironment(label, identity) {
  return {
    [`SHARD_PLACEMENT_${label}_HMAC_CURRENT_KID`]: identity.keyId,
    [`SHARD_PLACEMENT_${label}_HMAC_CURRENT_CREDENTIAL_ID_SHA256`]:
      identity.credentialIdSha256,
    [`SHARD_PLACEMENT_${label}_HMAC_CURRENT_SECRET`]: identity.secret,
    [`SHARD_PLACEMENT_${label}_HMAC_PREVIOUS_KID`]: "",
    [`SHARD_PLACEMENT_${label}_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256`]:
      "",
  };
}

function privateKey(role) {
  return createPrivateKey({
    key: Buffer.from(
      SHARD_PLACEMENT_AUTHORITY_TEST_KEYS[role]
        .privateKeyPkcs8Base64url,
      "base64url",
    ),
    format: "der",
    type: "pkcs8",
  });
}

async function digestLabel(value) {
  return sha256Hex(new TextEncoder().encode(value));
}
