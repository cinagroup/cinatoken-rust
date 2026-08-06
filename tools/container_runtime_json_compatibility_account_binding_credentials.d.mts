export const JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_TRUST_POLICY_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-account-binding-credential-trust-policy-v1";
export const JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_RECEIPT_SUBJECT_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-account-binding-credential-receipt-subject-v1";
export const JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_RECEIPT_ENVELOPE_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-account-binding-credential-receipt-envelope-v1";
export const JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_REVOCATION_SUBJECT_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-account-binding-credential-revocation-subject-v1";
export const JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_REVOCATION_ENVELOPE_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-account-binding-credential-revocation-envelope-v1";
export const JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_PROVENANCE_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-account-binding-credential-provenance-v1";
export const JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_SIGNATURE_DOMAIN:
  "cinatoken-container-runtime-json-compatibility-account-binding-credential-provenance-v1\n";
export const JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_ISSUER:
  "cinatoken-json-compatibility-account-binding-credential-authority-staging";
export const JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_AUDIENCE:
  "cinatoken-json-compatibility-account-binding-collector-profile-staging";
export const JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_PERMISSION_NAMES:
  readonly ["Workers Scripts Read", "Workers Routes Read", "Zone Read"];
export const JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_MAX_LIFETIME_SECONDS:
  number;
export const JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_MIN_REMAINING_SECONDS:
  number;
export const JSON_COMPATIBILITY_ACCOUNT_BINDING_REVOCATION_MAX_LIFETIME_SECONDS:
  number;
export const JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_MAX_PREVIOUS_KEY_OVERLAP_SECONDS:
  number;
export const JSON_COMPATIBILITY_ACCOUNT_BINDING_REQUIRED_APPROVER_COUNT: 2;

export type JsonCompatibilityAccountBindingCredentialRole =
  | "collection"
  | "independent-readback";
export type JsonCompatibilityAccountBindingCredentialPermissionName =
  (typeof JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_PERMISSION_NAMES)[number];

export interface JsonCompatibilityAccountBindingCredentialCurrentTrustKeyV1 {
  readonly keyId: string;
  readonly spkiSha256: string;
  readonly spkiBase64url: string;
}

export interface JsonCompatibilityAccountBindingCredentialPreviousTrustKeyV1
  extends JsonCompatibilityAccountBindingCredentialCurrentTrustKeyV1 {
  readonly acceptUntil: number;
}

export interface JsonCompatibilityAccountBindingCredentialTrustPolicyV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-account-binding-credential-trust-policy-v1";
  readonly environment: "staging";
  readonly issuer:
    "cinatoken-json-compatibility-account-binding-credential-authority-staging";
  readonly audience:
    "cinatoken-json-compatibility-account-binding-collector-profile-staging";
  readonly algorithm: "Ed25519";
  readonly effectiveAt: number;
  readonly current: JsonCompatibilityAccountBindingCredentialCurrentTrustKeyV1;
  readonly previous: JsonCompatibilityAccountBindingCredentialPreviousTrustKeyV1 | null;
  readonly requiredApproverCount: 2;
  readonly maximumCredentialLifetimeSeconds: number;
  readonly minimumCredentialRemainingSeconds: number;
  readonly maximumRevocationLifetimeSeconds: number;
  readonly maximumPreviousKeyOverlapSeconds: number;
  readonly requiredPermissionNames: readonly JsonCompatibilityAccountBindingCredentialPermissionName[];
  readonly custodySeparationRequired: true;
  readonly readOnlyRequired: true;
  readonly writePermissionsForbidden: true;
  readonly tokenManagementPermissionsForbidden: true;
  readonly credentialTrustPolicySha256: string;
}

export interface JsonCompatibilityAccountBindingCredentialPermissionGrantV1 {
  readonly permissionGroupId: string;
  readonly name: JsonCompatibilityAccountBindingCredentialPermissionName;
  readonly access: "read";
}

export interface JsonCompatibilityAccountBindingCredentialReceiptSubjectV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-account-binding-credential-receipt-subject-v1";
  readonly environment: "staging";
  readonly issuer:
    "cinatoken-json-compatibility-account-binding-credential-authority-staging";
  readonly audience:
    "cinatoken-json-compatibility-account-binding-collector-profile-staging";
  readonly keyId: string;
  readonly credentialType: "cloudflare-api-token";
  readonly accountIdSha256: string;
  readonly role: JsonCompatibilityAccountBindingCredentialRole;
  readonly credentialIdSha256: string;
  readonly permissionGrants: readonly JsonCompatibilityAccountBindingCredentialPermissionGrantV1[];
  readonly permissionSetSha256: string;
  readonly accountResourceScope: "specific-account";
  readonly zoneResourceScope: "all-zones-in-account";
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly issuingPrincipalIdentitySha256: string;
  readonly custodianIdentitySha256: string;
  readonly approverIdentitySha256s: readonly [string, string];
  readonly approvalPolicySha256: string;
  readonly requiredApproverCount: 2;
  readonly readOnly: true;
  readonly writePermissionsAbsent: true;
  readonly tokenManagementPermissionsAbsent: true;
  readonly secretRetained: false;
  readonly credentialReceiptSubjectSha256: string;
}

export interface JsonCompatibilityAccountBindingCredentialReceiptEnvelopeV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-account-binding-credential-receipt-envelope-v1";
  readonly algorithm: "Ed25519";
  readonly subject: JsonCompatibilityAccountBindingCredentialReceiptSubjectV1;
  readonly subjectSha256: string;
  readonly signatureBase64url: string;
  readonly credentialReceiptEnvelopeSha256: string;
}

export interface JsonCompatibilityAccountBindingCredentialRevocationSubjectV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-account-binding-credential-revocation-subject-v1";
  readonly environment: "staging";
  readonly issuer:
    "cinatoken-json-compatibility-account-binding-credential-authority-staging";
  readonly audience:
    "cinatoken-json-compatibility-account-binding-collector-profile-staging";
  readonly keyId: string;
  readonly sequence: number;
  readonly completeSnapshot: true;
  readonly revokedCredentialIdSha256s: readonly string[];
  readonly revokedReceiptSubjectSha256s: readonly string[];
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly credentialRevocationSubjectSha256: string;
}

export interface JsonCompatibilityAccountBindingCredentialRevocationEnvelopeV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-account-binding-credential-revocation-envelope-v1";
  readonly algorithm: "Ed25519";
  readonly subject: JsonCompatibilityAccountBindingCredentialRevocationSubjectV1;
  readonly subjectSha256: string;
  readonly signatureBase64url: string;
  readonly credentialRevocationEnvelopeSha256: string;
}

export interface JsonCompatibilityAccountBindingCredentialProvenanceV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-account-binding-credential-provenance-v1";
  readonly environment: "staging";
  readonly accountIdSha256: string;
  readonly trustPolicy: JsonCompatibilityAccountBindingCredentialTrustPolicyV1;
  readonly collectionReceipt: JsonCompatibilityAccountBindingCredentialReceiptEnvelopeV1;
  readonly readbackReceipt: JsonCompatibilityAccountBindingCredentialReceiptEnvelopeV1;
  readonly revocation: JsonCompatibilityAccountBindingCredentialRevocationEnvelopeV1;
  readonly collectionCredentialIdSha256: string;
  readonly readbackCredentialIdSha256: string;
  readonly collectionPermissionSetSha256: string;
  readonly readbackPermissionSetSha256: string;
  readonly collectionCustodianIdentitySha256: string;
  readonly readbackCustodianIdentitySha256: string;
  readonly collectionCredentialReceiptSha256: string;
  readonly readbackCredentialReceiptSha256: string;
  readonly credentialTrustPolicySha256: string;
  readonly credentialRevocationStateSha256: string;
  readonly independentCredentials: true;
  readonly independentCustodians: true;
  readonly readOnlyLeastPrivilege: true;
  readonly revocationChecked: true;
  readonly credentialProvenanceSha256: string;
}

export class JsonCompatibilityAccountBindingCredentialError extends Error {
  constructor(code: string, message?: string);
  readonly code: string;
}

export function buildJsonCompatibilityAccountBindingCredentialTrustPolicy(input: {
  readonly effectiveAt: number;
  readonly current: JsonCompatibilityAccountBindingCredentialCurrentTrustKeyV1;
  readonly previous?: JsonCompatibilityAccountBindingCredentialPreviousTrustKeyV1 | null;
}): JsonCompatibilityAccountBindingCredentialTrustPolicyV1;

export function validateJsonCompatibilityAccountBindingCredentialTrustPolicy(
  input: unknown,
): JsonCompatibilityAccountBindingCredentialTrustPolicyV1;

export function buildJsonCompatibilityAccountBindingCredentialReceiptSubject(input: {
  readonly accountIdSha256: string;
  readonly role: JsonCompatibilityAccountBindingCredentialRole;
  readonly credentialIdSha256: string;
  readonly permissionGrants: readonly JsonCompatibilityAccountBindingCredentialPermissionGrantV1[];
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly issuingPrincipalIdentitySha256: string;
  readonly custodianIdentitySha256: string;
  readonly approverIdentitySha256s: readonly string[];
  readonly approvalPolicySha256: string;
  readonly keyId: string;
}): JsonCompatibilityAccountBindingCredentialReceiptSubjectV1;

export function validateJsonCompatibilityAccountBindingCredentialReceiptSubject(
  input: unknown,
): JsonCompatibilityAccountBindingCredentialReceiptSubjectV1;

export function buildJsonCompatibilityAccountBindingCredentialReceiptEnvelope(input: {
  readonly subject: JsonCompatibilityAccountBindingCredentialReceiptSubjectV1;
  readonly signatureBase64url: string;
}): JsonCompatibilityAccountBindingCredentialReceiptEnvelopeV1;

export function validateJsonCompatibilityAccountBindingCredentialReceiptEnvelope(
  input: unknown,
): JsonCompatibilityAccountBindingCredentialReceiptEnvelopeV1;

export function buildJsonCompatibilityAccountBindingCredentialRevocationSubject(input: {
  readonly sequence: number;
  readonly revokedCredentialIdSha256s: readonly string[];
  readonly revokedReceiptSubjectSha256s: readonly string[];
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly keyId: string;
}): JsonCompatibilityAccountBindingCredentialRevocationSubjectV1;

export function validateJsonCompatibilityAccountBindingCredentialRevocationSubject(
  input: unknown,
): JsonCompatibilityAccountBindingCredentialRevocationSubjectV1;

export function buildJsonCompatibilityAccountBindingCredentialRevocationEnvelope(input: {
  readonly subject: JsonCompatibilityAccountBindingCredentialRevocationSubjectV1;
  readonly signatureBase64url: string;
}): JsonCompatibilityAccountBindingCredentialRevocationEnvelopeV1;

export function validateJsonCompatibilityAccountBindingCredentialRevocationEnvelope(
  input: unknown,
): JsonCompatibilityAccountBindingCredentialRevocationEnvelopeV1;

export function buildJsonCompatibilityAccountBindingCredentialProvenance(input: {
  readonly trustPolicy: JsonCompatibilityAccountBindingCredentialTrustPolicyV1;
  readonly collectionReceipt: JsonCompatibilityAccountBindingCredentialReceiptEnvelopeV1;
  readonly readbackReceipt: JsonCompatibilityAccountBindingCredentialReceiptEnvelopeV1;
  readonly revocation: JsonCompatibilityAccountBindingCredentialRevocationEnvelopeV1;
}): JsonCompatibilityAccountBindingCredentialProvenanceV1;

export function validateJsonCompatibilityAccountBindingCredentialProvenance(
  input: unknown,
): JsonCompatibilityAccountBindingCredentialProvenanceV1;

export function accountBindingCredentialSigningPayload(
  subject:
    | JsonCompatibilityAccountBindingCredentialReceiptSubjectV1
    | JsonCompatibilityAccountBindingCredentialRevocationSubjectV1,
): Uint8Array;
