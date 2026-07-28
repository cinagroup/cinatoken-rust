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
