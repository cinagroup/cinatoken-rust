import {
  createHash,
  createPublicKey,
  verify,
} from "node:crypto";
import { Buffer } from "node:buffer";

import {
  JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_MIN_REMAINING_SECONDS,
  JsonCompatibilityAccountBindingCredentialError,
  accountBindingCredentialSigningPayload,
  validateJsonCompatibilityAccountBindingCredentialProvenance,
  validateJsonCompatibilityAccountBindingCredentialReceiptEnvelope,
  validateJsonCompatibilityAccountBindingCredentialRevocationEnvelope,
  validateJsonCompatibilityAccountBindingCredentialTrustPolicy,
} from "../container_runtime_json_compatibility_account_binding_credentials.mjs";

export function verifyJsonCompatibilityAccountBindingCredentialProvenance(
  input,
  {
    now,
    expectedTrustPolicySha256,
    expectedRevocationStateSha256,
    minimumRevocationSequence,
  },
) {
  const provenance =
    validateJsonCompatibilityAccountBindingCredentialProvenance(input);
  timestamp(now, "credential verification time");
  sha256(expectedTrustPolicySha256, "expected credential trust policy");
  sha256(expectedRevocationStateSha256, "expected credential revocation state");
  positiveInteger(
    minimumRevocationSequence,
    "minimum credential revocation sequence",
  );
  if (
    provenance.credentialTrustPolicySha256 !== expectedTrustPolicySha256
  ) fail("credential_trust_policy_anchor_mismatch");
  if (
    provenance.credentialRevocationStateSha256
      !== expectedRevocationStateSha256
  ) fail("credential_revocation_state_anchor_mismatch");
  if (
    provenance.revocation.subject.sequence < minimumRevocationSequence
  ) fail("credential_revocation_sequence_rollback");
  verifyJsonCompatibilityAccountBindingCredentialEnvelope({
    trustPolicy: provenance.trustPolicy,
    envelope: provenance.collectionReceipt,
    kind: "receipt",
    now,
    expectedTrustPolicySha256,
  });
  verifyJsonCompatibilityAccountBindingCredentialEnvelope({
    trustPolicy: provenance.trustPolicy,
    envelope: provenance.readbackReceipt,
    kind: "receipt",
    now,
    expectedTrustPolicySha256,
  });
  verifyJsonCompatibilityAccountBindingCredentialEnvelope({
    trustPolicy: provenance.trustPolicy,
    envelope: provenance.revocation,
    kind: "revocation",
    now,
    expectedTrustPolicySha256,
  });
  for (const receipt of [
    provenance.collectionReceipt.subject,
    provenance.readbackReceipt.subject,
  ]) {
    if (
      receipt.createdAt > now
      || receipt.expiresAt - now
        < JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_MIN_REMAINING_SECONDS
    ) fail("credential_receipt_not_current");
  }
  const revocation = provenance.revocation.subject;
  if (revocation.issuedAt > now || revocation.expiresAt <= now) {
    fail("credential_revocation_not_current");
  }
  return provenance;
}

export function verifyJsonCompatibilityAccountBindingCredentialEnvelope({
  trustPolicy: trustPolicyInput,
  envelope: envelopeInput,
  kind,
  now,
  expectedTrustPolicySha256,
}) {
  const trustPolicy =
    validateJsonCompatibilityAccountBindingCredentialTrustPolicy(
      trustPolicyInput,
    );
  timestamp(now, "credential envelope verification time");
  sha256(expectedTrustPolicySha256, "expected credential trust policy");
  if (
    trustPolicy.credentialTrustPolicySha256 !== expectedTrustPolicySha256
  ) fail("credential_trust_policy_anchor_mismatch");
  const publicKeys = validateTrustPolicyKeys(trustPolicy);
  let envelope;
  let signedAt;
  if (kind === "receipt") {
    envelope =
      validateJsonCompatibilityAccountBindingCredentialReceiptEnvelope(
        envelopeInput,
      );
    signedAt = envelope.subject.createdAt;
  } else if (kind === "revocation") {
    envelope =
      validateJsonCompatibilityAccountBindingCredentialRevocationEnvelope(
        envelopeInput,
      );
    signedAt = envelope.subject.issuedAt;
    if (envelope.subject.keyId !== trustPolicy.current.keyId) {
      fail("credential_revocation_not_signed_by_current_key");
    }
  } else {
    fail("credential_envelope_kind_invalid");
  }
  const trustKey = resolveTrustKey(
    trustPolicy,
    envelope.subject.keyId,
    signedAt,
    now,
  );
  const publicKey = publicKeys.get(trustKey.keyId);
  const signature = decodeCanonicalBase64url(
    envelope.signatureBase64url,
    "credential signature",
  );
  if (signature.byteLength !== 64) fail("credential_signature_length_invalid");
  let valid = false;
  try {
    valid = verify(
      null,
      accountBindingCredentialSigningPayload(envelope.subject),
      publicKey,
      signature,
    );
  } catch {
    fail("credential_signature_verification_failed");
  }
  if (!valid) fail("credential_signature_invalid");
  return envelope;
}

function resolveTrustKey(policy, keyId, signedAt, now) {
  if (
    keyId === policy.current.keyId
    && signedAt >= policy.effectiveAt
  ) return policy.current;
  if (
    policy.previous !== null
    && keyId === policy.previous.keyId
    && signedAt <= policy.previous.acceptUntil
    && now <= policy.previous.acceptUntil
  ) return policy.previous;
  fail("credential_signature_key_not_currently_trusted");
}

function validateTrustPolicyKeys(policy) {
  const publicKeys = new Map();
  for (const trustKey of [policy.current, policy.previous]) {
    if (trustKey === null) continue;
    const spki = decodeCanonicalBase64url(
      trustKey.spkiBase64url,
      "credential trust SPKI",
    );
    if (sha256Bytes(spki) !== trustKey.spkiSha256) {
      fail("credential_trust_spki_digest_mismatch");
    }
    let publicKey;
    try {
      publicKey = createPublicKey({ key: spki, format: "der", type: "spki" });
    } catch {
      fail("credential_trust_spki_invalid");
    }
    if (publicKey.asymmetricKeyType !== "ed25519") {
      fail("credential_trust_key_type_invalid");
    }
    const exported = publicKey.export({ format: "der", type: "spki" });
    if (!Buffer.from(exported).equals(spki)) {
      fail("credential_trust_spki_not_canonical");
    }
    publicKeys.set(trustKey.keyId, publicKey);
  }
  return publicKeys;
}

function decodeCanonicalBase64url(value, label) {
  let bytes;
  try {
    bytes = Buffer.from(value, "base64url");
  } catch {
    fail(`${label.replaceAll(" ", "_")}_invalid`);
  }
  if (bytes.toString("base64url") !== value) {
    fail(`${label.replaceAll(" ", "_")}_not_canonical`);
  }
  return bytes;
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function timestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${label.replaceAll(" ", "_")}_invalid`);
  }
  return value;
}

function sha256(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    fail(`${label.replaceAll(" ", "_")}_invalid`);
  }
  return value;
}

function positiveInteger(value, label) {
  timestamp(value, label);
  if (value < 1) fail(`${label.replaceAll(" ", "_")}_invalid`);
  return value;
}

function fail(code) {
  throw new JsonCompatibilityAccountBindingCredentialError(code);
}
