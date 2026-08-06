import {
  canonicalJson,
  sha256Canonical,
} from "./container_runtime_json_compatibility_campaign.mjs";

export const JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_TRUST_POLICY_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-account-binding-credential-trust-policy-v1";
export const JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_RECEIPT_SUBJECT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-account-binding-credential-receipt-subject-v1";
export const JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_RECEIPT_ENVELOPE_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-account-binding-credential-receipt-envelope-v1";
export const JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_REVOCATION_SUBJECT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-account-binding-credential-revocation-subject-v1";
export const JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_REVOCATION_ENVELOPE_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-account-binding-credential-revocation-envelope-v1";
export const JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_PROVENANCE_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-account-binding-credential-provenance-v1";
export const JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_SIGNATURE_DOMAIN =
  "cinatoken-container-runtime-json-compatibility-account-binding-credential-provenance-v1\n";
export const JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_ISSUER =
  "cinatoken-json-compatibility-account-binding-credential-authority-staging";
export const JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_AUDIENCE =
  "cinatoken-json-compatibility-account-binding-collector-profile-staging";
export const JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_PERMISSION_NAMES =
  Object.freeze([
    "Workers Scripts Read",
    "Workers Routes Read",
    "Zone Read",
  ]);
export const JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_MAX_LIFETIME_SECONDS =
  60 * 60;
export const JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_MIN_REMAINING_SECONDS =
  10 * 60;
export const JSON_COMPATIBILITY_ACCOUNT_BINDING_REVOCATION_MAX_LIFETIME_SECONDS =
  15 * 60;
export const JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_MAX_PREVIOUS_KEY_OVERLAP_SECONDS =
  JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_MAX_LIFETIME_SECONDS;
export const JSON_COMPATIBILITY_ACCOUNT_BINDING_REQUIRED_APPROVER_COUNT = 2;

const SCHEMA_VERSION = 1;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const PERMISSION_NAME_SET = new Set(
  JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_PERMISSION_NAMES,
);

export class JsonCompatibilityAccountBindingCredentialError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "JsonCompatibilityAccountBindingCredentialError";
    this.code = code;
  }
}

export function buildJsonCompatibilityAccountBindingCredentialTrustPolicy({
  effectiveAt,
  current: currentInput,
  previous: previousInput = null,
}) {
  integer(effectiveAt, "credential trust policy effective time");
  const current = normalizeTrustKey(currentInput, false);
  const previous = previousInput === null
    ? null
    : normalizeTrustKey(previousInput, true);
  if (previous !== null) {
    if (
      previous.keyId === current.keyId
      || previous.spkiSha256 === current.spkiSha256
    ) fail("credential_trust_keys_not_distinct");
    if (
      previous.acceptUntil < effectiveAt
      || previous.acceptUntil - effectiveAt
        > JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_MAX_PREVIOUS_KEY_OVERLAP_SECONDS
    ) fail("credential_previous_key_overlap_invalid");
  }
  const subject = {
    schemaVersion: SCHEMA_VERSION,
    contract:
      JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_TRUST_POLICY_CONTRACT,
    environment: "staging",
    issuer: JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_ISSUER,
    audience: JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_AUDIENCE,
    algorithm: "Ed25519",
    effectiveAt,
    current,
    previous,
    requiredApproverCount:
      JSON_COMPATIBILITY_ACCOUNT_BINDING_REQUIRED_APPROVER_COUNT,
    maximumCredentialLifetimeSeconds:
      JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_MAX_LIFETIME_SECONDS,
    minimumCredentialRemainingSeconds:
      JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_MIN_REMAINING_SECONDS,
    maximumRevocationLifetimeSeconds:
      JSON_COMPATIBILITY_ACCOUNT_BINDING_REVOCATION_MAX_LIFETIME_SECONDS,
    maximumPreviousKeyOverlapSeconds:
      JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_MAX_PREVIOUS_KEY_OVERLAP_SECONDS,
    requiredPermissionNames: [
      ...JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_PERMISSION_NAMES,
    ],
    custodySeparationRequired: true,
    readOnlyRequired: true,
    writePermissionsForbidden: true,
    tokenManagementPermissionsForbidden: true,
  };
  return {
    ...subject,
    credentialTrustPolicySha256: sha256Canonical(subject),
  };
}

export function validateJsonCompatibilityAccountBindingCredentialTrustPolicy(
  input,
) {
  const value = record(input, "credential trust policy");
  exactKeys(value, [
    "schemaVersion", "contract", "environment", "issuer", "audience",
    "algorithm", "effectiveAt", "current", "previous", "requiredApproverCount",
    "maximumCredentialLifetimeSeconds",
    "minimumCredentialRemainingSeconds",
    "maximumRevocationLifetimeSeconds", "maximumPreviousKeyOverlapSeconds",
    "requiredPermissionNames",
    "custodySeparationRequired", "readOnlyRequired",
    "writePermissionsForbidden", "tokenManagementPermissionsForbidden",
    "credentialTrustPolicySha256",
  ], "credential trust policy");
  const rebuilt = buildJsonCompatibilityAccountBindingCredentialTrustPolicy({
    effectiveAt: value.effectiveAt,
    current: value.current,
    previous: value.previous,
  });
  canonicalEqual(rebuilt, value, "credential trust policy");
  return cloneJson(value);
}

export function buildJsonCompatibilityAccountBindingCredentialReceiptSubject({
  accountIdSha256,
  role,
  credentialIdSha256,
  permissionGrants: permissionInput,
  createdAt,
  expiresAt,
  issuingPrincipalIdentitySha256,
  custodianIdentitySha256,
  approverIdentitySha256s: approverInput,
  approvalPolicySha256,
  keyId,
}) {
  for (const [label, value] of [
    ["account ID", accountIdSha256],
    ["credential ID", credentialIdSha256],
    ["issuing principal", issuingPrincipalIdentitySha256],
    ["custodian", custodianIdentitySha256],
    ["approval policy", approvalPolicySha256],
  ]) sha256(value, `credential receipt ${label}`);
  oneOf(role, ["collection", "independent-readback"], "credential role");
  safeToken(keyId, "credential receipt key ID");
  integer(createdAt, "credential creation time");
  integer(expiresAt, "credential expiry time");
  if (
    expiresAt <= createdAt
    || expiresAt - createdAt
      > JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_MAX_LIFETIME_SECONDS
  ) fail("credential_lifetime_invalid");
  const permissionGrants = normalizePermissionGrants(permissionInput);
  const permissionSet = {
    accountIdSha256,
    accountResourceScope: "specific-account",
    zoneResourceScope: "all-zones-in-account",
    permissionGrants,
  };
  const approverIdentitySha256s = normalizeDigestSet(
    approverInput,
    "credential approver identity",
    JSON_COMPATIBILITY_ACCOUNT_BINDING_REQUIRED_APPROVER_COUNT,
  );
  if (
    approverIdentitySha256s.includes(issuingPrincipalIdentitySha256)
    || approverIdentitySha256s.includes(custodianIdentitySha256)
    || issuingPrincipalIdentitySha256 === custodianIdentitySha256
  ) fail("credential_duty_separation_invalid");
  const subject = {
    schemaVersion: SCHEMA_VERSION,
    contract:
      JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_RECEIPT_SUBJECT_CONTRACT,
    environment: "staging",
    issuer: JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_ISSUER,
    audience: JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_AUDIENCE,
    keyId,
    credentialType: "cloudflare-api-token",
    accountIdSha256,
    role,
    credentialIdSha256,
    permissionGrants,
    permissionSetSha256: sha256Canonical(permissionSet),
    accountResourceScope: "specific-account",
    zoneResourceScope: "all-zones-in-account",
    createdAt,
    expiresAt,
    issuingPrincipalIdentitySha256,
    custodianIdentitySha256,
    approverIdentitySha256s,
    approvalPolicySha256,
    requiredApproverCount:
      JSON_COMPATIBILITY_ACCOUNT_BINDING_REQUIRED_APPROVER_COUNT,
    readOnly: true,
    writePermissionsAbsent: true,
    tokenManagementPermissionsAbsent: true,
    secretRetained: false,
  };
  return {
    ...subject,
    credentialReceiptSubjectSha256: sha256Canonical(subject),
  };
}

export function validateJsonCompatibilityAccountBindingCredentialReceiptSubject(
  input,
) {
  const value = record(input, "credential receipt subject");
  exactKeys(value, [
    "schemaVersion", "contract", "environment", "issuer", "audience",
    "keyId", "credentialType", "accountIdSha256", "role",
    "credentialIdSha256", "permissionGrants", "permissionSetSha256",
    "accountResourceScope", "zoneResourceScope", "createdAt", "expiresAt",
    "issuingPrincipalIdentitySha256", "custodianIdentitySha256",
    "approverIdentitySha256s", "approvalPolicySha256",
    "requiredApproverCount", "readOnly", "writePermissionsAbsent",
    "tokenManagementPermissionsAbsent", "secretRetained",
    "credentialReceiptSubjectSha256",
  ], "credential receipt subject");
  equal(value.credentialType, "cloudflare-api-token", "credential type");
  equal(value.accountResourceScope, "specific-account", "account resource scope");
  equal(value.zoneResourceScope, "all-zones-in-account", "zone resource scope");
  equal(value.requiredApproverCount,
    JSON_COMPATIBILITY_ACCOUNT_BINDING_REQUIRED_APPROVER_COUNT,
    "credential required approver count");
  equal(value.readOnly, true, "credential read-only status");
  equal(value.writePermissionsAbsent, true, "credential write permission status");
  equal(value.tokenManagementPermissionsAbsent, true,
    "credential token-management permission status");
  equal(value.secretRetained, false, "credential secret retention status");
  const rebuilt = buildJsonCompatibilityAccountBindingCredentialReceiptSubject(
    value,
  );
  canonicalEqual(rebuilt, value, "credential receipt subject");
  return cloneJson(value);
}

export function buildJsonCompatibilityAccountBindingCredentialReceiptEnvelope({
  subject: subjectInput,
  signatureBase64url,
}) {
  const subject =
    validateJsonCompatibilityAccountBindingCredentialReceiptSubject(
      subjectInput,
    );
  signature(signatureBase64url, "credential receipt signature");
  const envelope = {
    schemaVersion: SCHEMA_VERSION,
    contract:
      JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_RECEIPT_ENVELOPE_CONTRACT,
    algorithm: "Ed25519",
    subject,
    subjectSha256: subject.credentialReceiptSubjectSha256,
    signatureBase64url,
  };
  return {
    ...envelope,
    credentialReceiptEnvelopeSha256: sha256Canonical(envelope),
  };
}

export function validateJsonCompatibilityAccountBindingCredentialReceiptEnvelope(
  input,
) {
  const value = record(input, "credential receipt envelope");
  exactKeys(value, [
    "schemaVersion", "contract", "algorithm", "subject", "subjectSha256",
    "signatureBase64url", "credentialReceiptEnvelopeSha256",
  ], "credential receipt envelope");
  equal(value.algorithm, "Ed25519", "credential receipt algorithm");
  const rebuilt = buildJsonCompatibilityAccountBindingCredentialReceiptEnvelope({
    subject: value.subject,
    signatureBase64url: value.signatureBase64url,
  });
  canonicalEqual(rebuilt, value, "credential receipt envelope");
  return cloneJson(value);
}

export function buildJsonCompatibilityAccountBindingCredentialRevocationSubject({
  sequence,
  revokedCredentialIdSha256s: credentialInput,
  revokedReceiptSubjectSha256s: receiptInput,
  issuedAt,
  expiresAt,
  keyId,
}) {
  positiveInteger(sequence, "credential revocation sequence");
  integer(issuedAt, "credential revocation issue time");
  integer(expiresAt, "credential revocation expiry time");
  if (
    expiresAt <= issuedAt
    || expiresAt - issuedAt
      > JSON_COMPATIBILITY_ACCOUNT_BINDING_REVOCATION_MAX_LIFETIME_SECONDS
  ) fail("credential_revocation_lifetime_invalid");
  safeToken(keyId, "credential revocation key ID");
  const revokedCredentialIdSha256s = normalizeDigestSet(
    credentialInput,
    "revoked credential ID",
  );
  const revokedReceiptSubjectSha256s = normalizeDigestSet(
    receiptInput,
    "revoked receipt subject",
  );
  const subject = {
    schemaVersion: SCHEMA_VERSION,
    contract:
      JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_REVOCATION_SUBJECT_CONTRACT,
    environment: "staging",
    issuer: JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_ISSUER,
    audience: JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_AUDIENCE,
    keyId,
    sequence,
    completeSnapshot: true,
    revokedCredentialIdSha256s,
    revokedReceiptSubjectSha256s,
    issuedAt,
    expiresAt,
  };
  return {
    ...subject,
    credentialRevocationSubjectSha256: sha256Canonical(subject),
  };
}

export function validateJsonCompatibilityAccountBindingCredentialRevocationSubject(
  input,
) {
  const value = record(input, "credential revocation subject");
  exactKeys(value, [
    "schemaVersion", "contract", "environment", "issuer", "audience",
    "keyId", "sequence", "completeSnapshot", "revokedCredentialIdSha256s",
    "revokedReceiptSubjectSha256s", "issuedAt", "expiresAt",
    "credentialRevocationSubjectSha256",
  ], "credential revocation subject");
  equal(value.completeSnapshot, true, "credential revocation completeness");
  const rebuilt =
    buildJsonCompatibilityAccountBindingCredentialRevocationSubject(value);
  canonicalEqual(rebuilt, value, "credential revocation subject");
  return cloneJson(value);
}

export function buildJsonCompatibilityAccountBindingCredentialRevocationEnvelope({
  subject: subjectInput,
  signatureBase64url,
}) {
  const subject =
    validateJsonCompatibilityAccountBindingCredentialRevocationSubject(
      subjectInput,
    );
  signature(signatureBase64url, "credential revocation signature");
  const envelope = {
    schemaVersion: SCHEMA_VERSION,
    contract:
      JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_REVOCATION_ENVELOPE_CONTRACT,
    algorithm: "Ed25519",
    subject,
    subjectSha256: subject.credentialRevocationSubjectSha256,
    signatureBase64url,
  };
  return {
    ...envelope,
    credentialRevocationEnvelopeSha256: sha256Canonical(envelope),
  };
}

export function validateJsonCompatibilityAccountBindingCredentialRevocationEnvelope(
  input,
) {
  const value = record(input, "credential revocation envelope");
  exactKeys(value, [
    "schemaVersion", "contract", "algorithm", "subject", "subjectSha256",
    "signatureBase64url", "credentialRevocationEnvelopeSha256",
  ], "credential revocation envelope");
  equal(value.algorithm, "Ed25519", "credential revocation algorithm");
  const rebuilt =
    buildJsonCompatibilityAccountBindingCredentialRevocationEnvelope({
      subject: value.subject,
      signatureBase64url: value.signatureBase64url,
    });
  canonicalEqual(rebuilt, value, "credential revocation envelope");
  return cloneJson(value);
}

export function buildJsonCompatibilityAccountBindingCredentialProvenance({
  trustPolicy: trustPolicyInput,
  collectionReceipt: collectionInput,
  readbackReceipt: readbackInput,
  revocation: revocationInput,
}) {
  const trustPolicy =
    validateJsonCompatibilityAccountBindingCredentialTrustPolicy(
      trustPolicyInput,
    );
  const collectionReceipt =
    validateJsonCompatibilityAccountBindingCredentialReceiptEnvelope(
      collectionInput,
    );
  const readbackReceipt =
    validateJsonCompatibilityAccountBindingCredentialReceiptEnvelope(
      readbackInput,
    );
  const revocation =
    validateJsonCompatibilityAccountBindingCredentialRevocationEnvelope(
      revocationInput,
    );
  const collection = collectionReceipt.subject;
  const readback = readbackReceipt.subject;
  equal(collection.role, "collection", "collection credential receipt role");
  equal(readback.role, "independent-readback", "readback credential receipt role");
  for (const subject of [collection, readback, revocation.subject]) {
    equal(subject.issuer, trustPolicy.issuer, "credential provenance issuer");
    equal(subject.audience, trustPolicy.audience, "credential provenance audience");
    assertPolicyKey(trustPolicy, subject.keyId, subject.createdAt ?? subject.issuedAt);
  }
  equal(revocation.subject.keyId, trustPolicy.current.keyId,
    "credential revocation current key");
  equal(collection.accountIdSha256, readback.accountIdSha256,
    "credential receipt account");
  if (
    collection.credentialIdSha256 === readback.credentialIdSha256
    || collection.custodianIdentitySha256 === readback.custodianIdentitySha256
    || collectionReceipt.credentialReceiptEnvelopeSha256
      === readbackReceipt.credentialReceiptEnvelopeSha256
  ) fail("credential_receipt_independence_invalid");
  if (
    revocation.subject.issuedAt < collection.createdAt
    || revocation.subject.issuedAt < readback.createdAt
  ) fail("credential_revocation_predates_receipt");
  for (const receipt of [collectionReceipt, readbackReceipt]) {
    if (
      revocation.subject.revokedCredentialIdSha256s.includes(
        receipt.subject.credentialIdSha256,
      )
      || revocation.subject.revokedReceiptSubjectSha256s.includes(
        receipt.subject.credentialReceiptSubjectSha256,
      )
    ) fail("credential_receipt_revoked");
  }
  const subject = {
    schemaVersion: SCHEMA_VERSION,
    contract:
      JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_PROVENANCE_CONTRACT,
    environment: "staging",
    accountIdSha256: collection.accountIdSha256,
    trustPolicy,
    collectionReceipt,
    readbackReceipt,
    revocation,
    collectionCredentialIdSha256: collection.credentialIdSha256,
    readbackCredentialIdSha256: readback.credentialIdSha256,
    collectionPermissionSetSha256: collection.permissionSetSha256,
    readbackPermissionSetSha256: readback.permissionSetSha256,
    collectionCustodianIdentitySha256: collection.custodianIdentitySha256,
    readbackCustodianIdentitySha256: readback.custodianIdentitySha256,
    collectionCredentialReceiptSha256:
      collectionReceipt.credentialReceiptEnvelopeSha256,
    readbackCredentialReceiptSha256:
      readbackReceipt.credentialReceiptEnvelopeSha256,
    credentialTrustPolicySha256:
      trustPolicy.credentialTrustPolicySha256,
    credentialRevocationStateSha256:
      revocation.credentialRevocationEnvelopeSha256,
    independentCredentials: true,
    independentCustodians: true,
    readOnlyLeastPrivilege: true,
    revocationChecked: true,
  };
  return {
    ...subject,
    credentialProvenanceSha256: sha256Canonical(subject),
  };
}

export function validateJsonCompatibilityAccountBindingCredentialProvenance(
  input,
) {
  const value = record(input, "credential provenance");
  exactKeys(value, [
    "schemaVersion", "contract", "environment", "accountIdSha256",
    "trustPolicy", "collectionReceipt", "readbackReceipt", "revocation",
    "collectionCredentialIdSha256", "readbackCredentialIdSha256",
    "collectionPermissionSetSha256", "readbackPermissionSetSha256",
    "collectionCustodianIdentitySha256", "readbackCustodianIdentitySha256",
    "collectionCredentialReceiptSha256", "readbackCredentialReceiptSha256",
    "credentialTrustPolicySha256", "credentialRevocationStateSha256",
    "independentCredentials", "independentCustodians",
    "readOnlyLeastPrivilege", "revocationChecked",
    "credentialProvenanceSha256",
  ], "credential provenance");
  for (const name of [
    "independentCredentials", "independentCustodians",
    "readOnlyLeastPrivilege", "revocationChecked",
  ]) equal(value[name], true, `credential provenance ${name}`);
  const rebuilt = buildJsonCompatibilityAccountBindingCredentialProvenance({
    trustPolicy: value.trustPolicy,
    collectionReceipt: value.collectionReceipt,
    readbackReceipt: value.readbackReceipt,
    revocation: value.revocation,
  });
  canonicalEqual(rebuilt, value, "credential provenance");
  return cloneJson(value);
}

export function accountBindingCredentialSigningPayload(subjectInput) {
  let subject;
  if (subjectInput?.contract ===
    JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_RECEIPT_SUBJECT_CONTRACT) {
    subject =
      validateJsonCompatibilityAccountBindingCredentialReceiptSubject(
        subjectInput,
      );
  } else if (subjectInput?.contract ===
    JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_REVOCATION_SUBJECT_CONTRACT) {
    subject =
      validateJsonCompatibilityAccountBindingCredentialRevocationSubject(
        subjectInput,
      );
  } else {
    fail("credential_signing_subject_contract_invalid");
  }
  return new TextEncoder().encode(
    `${JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_SIGNATURE_DOMAIN}${canonicalJson(subject)}`,
  );
}

function normalizeTrustKey(input, previous) {
  const value = record(input, previous ? "previous trust key" : "current trust key");
  exactKeys(
    value,
    previous
      ? ["keyId", "spkiSha256", "spkiBase64url", "acceptUntil"]
      : ["keyId", "spkiSha256", "spkiBase64url"],
    previous ? "previous trust key" : "current trust key",
  );
  safeToken(value.keyId, "credential trust key ID");
  sha256(value.spkiSha256, "credential trust SPKI");
  base64url(value.spkiBase64url, 32, 2_048, "credential trust SPKI bytes");
  if (previous) integer(value.acceptUntil, "previous trust acceptance deadline");
  return cloneJson(value);
}

function normalizePermissionGrants(input) {
  if (!Array.isArray(input) || input.length !== PERMISSION_NAME_SET.size) {
    fail("credential_permission_grant_set_invalid");
  }
  const values = input.map((entry) => {
    const value = record(entry, "credential permission grant");
    exactKeys(value, ["permissionGroupId", "name", "access"],
      "credential permission grant");
    safeToken(value.permissionGroupId, "credential permission group ID");
    if (!PERMISSION_NAME_SET.has(value.name)) {
      fail("credential_permission_name_invalid");
    }
    equal(value.access, "read", "credential permission access");
    return cloneJson(value);
  }).sort((left, right) => compareAscii(left.name, right.name));
  rejectDuplicates(values, (value) => value.name, "credential permission name");
  rejectDuplicates(values, (value) => value.permissionGroupId,
    "credential permission group ID");
  if (canonicalJson(values.map((value) => value.name)) !== canonicalJson(
    [...JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_PERMISSION_NAMES]
      .sort(compareAscii),
  )) fail("credential_permission_set_incomplete");
  return values;
}

function normalizeDigestSet(input, label, exactLength = null) {
  if (!Array.isArray(input) || (exactLength !== null && input.length !== exactLength)) {
    fail(`${label.replaceAll(" ", "_")}_set_invalid`);
  }
  const values = [...input];
  for (const value of values) sha256(value, label);
  values.sort(compareAscii);
  rejectDuplicates(values, (value) => value, label);
  return values;
}

function assertPolicyKey(policy, keyId, signedAt) {
  if (keyId === policy.current.keyId && signedAt >= policy.effectiveAt) return;
  if (
    policy.previous !== null
    && keyId === policy.previous.keyId
    && signedAt <= policy.previous.acceptUntil
  ) return;
  fail("credential_signature_key_not_trusted");
}

function signature(value, label) {
  base64url(value, 86, 86, label);
}

function base64url(value, minimum, maximum, label) {
  if (
    typeof value !== "string" || value.length < minimum || value.length > maximum
    || !BASE64URL.test(value) || value.includes("=")
  ) fail(`${label.replaceAll(" ", "_")}_invalid`);
  return value;
}

function record(value, label) {
  if (
    value === null || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) fail(`${label.replaceAll(" ", "_")}_invalid`);
  return value;
}

function exactKeys(value, keys, label) {
  const actual = Object.keys(value).sort(compareAscii);
  const expected = [...keys].sort(compareAscii);
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    fail(`${label.replaceAll(" ", "_")}_keys_invalid`);
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonicalEqual(actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    fail(`${label.replaceAll(" ", "_")}_mismatch`);
  }
}

function sha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail(`${label.replaceAll(" ", "_")}_invalid`);
  }
  return value;
}

function safeToken(value, label) {
  if (typeof value !== "string" || !SAFE_TOKEN.test(value)) {
    fail(`${label.replaceAll(" ", "_")}_invalid`);
  }
  return value;
}

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${label.replaceAll(" ", "_")}_invalid`);
  }
  return value;
}

function positiveInteger(value, label) {
  integer(value, label);
  if (value < 1) fail(`${label.replaceAll(" ", "_")}_invalid`);
  return value;
}

function oneOf(value, choices, label) {
  if (!choices.includes(value)) fail(`${label.replaceAll(" ", "_")}_invalid`);
  return value;
}

function equal(actual, expected, label) {
  if (actual !== expected) fail(`${label.replaceAll(" ", "_")}_mismatch`);
}

function rejectDuplicates(values, key, label) {
  const seen = new Set();
  for (const value of values) {
    if (!seen.add(key(value))) fail(`${label.replaceAll(" ", "_")}_duplicate`);
  }
}

function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(code) {
  throw new JsonCompatibilityAccountBindingCredentialError(code);
}
