import { describe, expect, test } from "bun:test";

import {
  buildJsonCompatibilityAccountBindingCredentialProvenance,
  buildJsonCompatibilityAccountBindingCredentialReceiptEnvelope,
  buildJsonCompatibilityAccountBindingCredentialReceiptSubject,
  buildJsonCompatibilityAccountBindingCredentialTrustPolicy,
} from "../tools/container_runtime_json_compatibility_account_binding_credentials.mjs";
import {
  verifyJsonCompatibilityAccountBindingCredentialProvenance,
} from "../tools/lib/container_runtime_json_compatibility_account_binding_credentials.mjs";
import {
  createAccountBindingCredentialProvenanceFixture,
} from "./fixtures/container-runtime-json-compatibility-source-authentication.mjs";
import {
  digest,
} from "./fixtures/container-runtime-json-compatibility-deployment-transition.mjs";

const NOW = 1_786_100_000;

describe("JSON compatibility account binding credential provenance", () => {
  test("verifies two signed least-privilege receipts and a current revocation snapshot", () => {
    const provenance = fixture();
    const verified =
      verifyJsonCompatibilityAccountBindingCredentialProvenance(
        provenance,
        verificationOptions(provenance),
      );

    expect(verified.collectionReceipt.subject.permissionGrants.map(
      (value) => value.name,
    )).toEqual([
      "Workers Routes Read",
      "Workers Scripts Read",
      "Zone Read",
    ]);
    expect(verified.collectionCredentialIdSha256)
      .not.toBe(verified.readbackCredentialIdSha256);
    expect(verified.collectionCustodianIdentitySha256)
      .not.toBe(verified.readbackCustodianIdentitySha256);
    expect(verified.collectionReceipt.subject.writePermissionsAbsent)
      .toBe(true);
    expect(verified.collectionReceipt.subject.tokenManagementPermissionsAbsent)
      .toBe(true);
    expect(verified.revocation.subject.completeSnapshot).toBe(true);
  });

  test("rejects a structurally valid envelope with a forged signature", () => {
    const provenance = fixture();
    const receipt = provenance.collectionReceipt;
    const forged =
      buildJsonCompatibilityAccountBindingCredentialReceiptEnvelope({
        subject: receipt.subject,
        signatureBase64url:
          `${receipt.signatureBase64url[0] === "A" ? "B" : "A"}${receipt.signatureBase64url.slice(1)}`,
      });
    const forgedProvenance =
      buildJsonCompatibilityAccountBindingCredentialProvenance({
        trustPolicy: provenance.trustPolicy,
        collectionReceipt: forged,
        readbackReceipt: provenance.readbackReceipt,
        revocation: provenance.revocation,
      });

    expect(() => verifyJsonCompatibilityAccountBindingCredentialProvenance(
      forgedProvenance,
      verificationOptions(forgedProvenance),
    )).toThrow(/credential_signature_invalid/);
  });

  test("rejects an expired revocation snapshot", () => {
    const provenance = fixture();
    expect(() => verifyJsonCompatibilityAccountBindingCredentialProvenance(
      provenance,
      verificationOptions(provenance, {
        now: provenance.revocation.subject.expiresAt + 1,
      }),
    )).toThrow(/credential_revocation_not_current/);
  });

  test("rejects a revocation snapshot at its exact expiry boundary", () => {
    const provenance = fixture();
    expect(() => verifyJsonCompatibilityAccountBindingCredentialProvenance(
      provenance,
      verificationOptions(provenance, {
        now: provenance.revocation.subject.expiresAt,
      }),
    )).toThrow(/credential_revocation_not_current/);
  });

  test("requires external trust and revocation rollback anchors", () => {
    const provenance = fixture();
    const attacker = fixture();
    expect(() => verifyJsonCompatibilityAccountBindingCredentialProvenance(
      attacker,
      {
        ...verificationOptions(attacker),
        expectedTrustPolicySha256:
          provenance.credentialTrustPolicySha256,
      },
    )).toThrow(/credential_trust_policy_anchor_mismatch/);
    expect(() => verifyJsonCompatibilityAccountBindingCredentialProvenance(
      provenance,
      {
        ...verificationOptions(provenance),
        minimumRevocationSequence: provenance.revocation.subject.sequence + 1,
      },
    )).toThrow(/credential_revocation_sequence_rollback/);
  });

  test("bounds previous-key overlap and validates unused trust keys eagerly", () => {
    const provenance = fixture();
    expect(() => buildJsonCompatibilityAccountBindingCredentialTrustPolicy({
      effectiveAt: NOW,
      current: provenance.trustPolicy.current,
      previous: {
        keyId: "previous-account-binding-key",
        spkiSha256: digest("previous-account-binding-spki"),
        spkiBase64url: "A".repeat(43),
        acceptUntil: NOW + 3_601,
      },
    })).toThrow(/credential_previous_key_overlap_invalid/);

    const trustPolicy =
      buildJsonCompatibilityAccountBindingCredentialTrustPolicy({
        effectiveAt: provenance.trustPolicy.effectiveAt,
        current: provenance.trustPolicy.current,
        previous: {
          keyId: "previous-account-binding-key",
          spkiSha256: digest("previous-account-binding-spki"),
          spkiBase64url: "A".repeat(43),
          acceptUntil: provenance.trustPolicy.effectiveAt + 600,
        },
      });
    const malformedPrevious =
      buildJsonCompatibilityAccountBindingCredentialProvenance({
        trustPolicy,
        collectionReceipt: provenance.collectionReceipt,
        readbackReceipt: provenance.readbackReceipt,
        revocation: provenance.revocation,
      });
    expect(() => verifyJsonCompatibilityAccountBindingCredentialProvenance(
      malformedPrevious,
      verificationOptions(malformedPrevious),
    )).toThrow(/credential_trust_spki_digest_mismatch/);
  });

  test("rejects shared custody even when both receipt envelopes are retained", () => {
    const provenance = fixture();
    const readback = provenance.readbackReceipt.subject;
    const sharedCustodian =
      buildJsonCompatibilityAccountBindingCredentialReceiptSubject({
        accountIdSha256: readback.accountIdSha256,
        role: readback.role,
        credentialIdSha256: readback.credentialIdSha256,
        permissionGrants: readback.permissionGrants,
        createdAt: readback.createdAt,
        expiresAt: readback.expiresAt,
        issuingPrincipalIdentitySha256:
          readback.issuingPrincipalIdentitySha256,
        custodianIdentitySha256:
          provenance.collectionReceipt.subject.custodianIdentitySha256,
        approverIdentitySha256s: readback.approverIdentitySha256s,
        approvalPolicySha256: readback.approvalPolicySha256,
        keyId: readback.keyId,
      });
    const readbackEnvelope =
      buildJsonCompatibilityAccountBindingCredentialReceiptEnvelope({
        subject: sharedCustodian,
        signatureBase64url: provenance.readbackReceipt.signatureBase64url,
      });

    expect(() => buildJsonCompatibilityAccountBindingCredentialProvenance({
      trustPolicy: provenance.trustPolicy,
      collectionReceipt: provenance.collectionReceipt,
      readbackReceipt: readbackEnvelope,
      revocation: provenance.revocation,
    })).toThrow(/credential_receipt_independence_invalid/);
  });
});

function fixture() {
  return createAccountBindingCredentialProvenanceFixture({
    accountIdSha256: digest("credential-test-account"),
    collectionCredentialIdSha256: digest("credential-test-collection"),
    readbackCredentialIdSha256: digest("credential-test-readback"),
    now: NOW,
  });
}

function verificationOptions(provenance, overrides = {}) {
  return {
    now: NOW,
    expectedTrustPolicySha256: provenance.credentialTrustPolicySha256,
    expectedRevocationStateSha256:
      provenance.credentialRevocationStateSha256,
    minimumRevocationSequence: provenance.revocation.subject.sequence,
    ...overrides,
  };
}
