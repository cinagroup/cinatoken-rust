import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import {
  canonicalJson,
  derivePermitIdSha256,
  type IssuerEnv,
  type RegistrationPermitBindings,
  type RegistrationPermitSubject,
} from "../src/protocol";

export const FIXTURE_NOW = 2_000_000_000;
export const FIXTURE_REQUEST_ID = "registration-request-canary-001";
export const CURRENT_SECRET = "current-registration-authority-secret-0001";
export const PREVIOUS_SECRET = "previous-registration-authority-secret-001";
export const CURRENT_CREDENTIAL_ID_SHA256 = digest(20);
export const PREVIOUS_CREDENTIAL_ID_SHA256 = digest(21);
export const ADMIN_NETWORK_IDENTITY_HMAC_SHA256 =
  "b8de0f80c9ba10bc79d9534f35da4341bcca1f76e288c3d2059dd8186d96b2cf";

const ED25519_PKCS8_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);
const TEST_ONLY_ED25519_SEED = Buffer.alloc(32, 0x07);
const TEST_PKCS8 = Buffer.concat([
  ED25519_PKCS8_PREFIX,
  TEST_ONLY_ED25519_SEED,
]);
const TEST_PRIVATE_KEY = createPrivateKey({
  key: TEST_PKCS8,
  format: "der",
  type: "pkcs8",
});
const TEST_SPKI = createPublicKey(TEST_PRIVATE_KEY).export({
  format: "der",
  type: "spki",
});

export const TEST_PKCS8_BASE64URL = TEST_PKCS8.toString("base64url");
export const TEST_SPKI_BASE64URL = TEST_SPKI.toString("base64url");
export const TEST_SPKI_SHA256 = createHash("sha256")
  .update(TEST_SPKI)
  .digest("hex");
export const FIXTURE_PERMIT_ID_SHA256 =
  "33b768701f84f398cbf03fb83daffb0ff850bb1130f07c65551355cf8208c347";
export const FIXTURE_SUBJECT_SHA256 =
  "b9bd26a4ad6684f28878362519b4b4dd297ee896d27e73261287f0d36f57add4";
export const FIXTURE_SIGNATURE_BASE64URL =
  "2NDJX_XmVvSI8HCEmjhYAUEPIhpYuFdxkYKvuC3CPQm8X2tLOWRyEocVKWMAYemQo7AXkzfA67oxlT_O5kVhDQ";
export const FIXTURE_ENVELOPE_SHA256 =
  "4c1fcd00ce0ae3f9f6849e59174e4e38e2be287a3a620c1a7049c21a819156be";
export const FIXTURE_ISSUE_REQUEST_SHA256 =
  "72f7cdc6d9e535626ed85fe6e852f43204fb1a5d8a20f5d9871497ccab00f755";

export function digest(byte: number): string {
  return byte.toString(16).padStart(2, "0").repeat(32);
}

export function fixtureBindings(
  overrides: Partial<RegistrationPermitBindings> = {},
): RegistrationPermitBindings {
  return {
    environment: "staging",
    action: "relay_container.drain_source_authorization_register",
    authorizationIdSha256: digest(1),
    authorizationSubjectSha256: digest(2),
    authorizationSignatureEnvelopeSha256: digest(3),
    actionSubjectSha256: digest(4),
    actionDigestSha256: digest(5),
    registrationRequestSha256: digest(6),
    adminAuditDigestSha256: digest(8),
    adminNetworkIdentityHmacSha256: ADMIN_NETWORK_IDENTITY_HMAC_SHA256,
    changeTicketSha256: digest(9),
    rootAdminId: 1,
    rootSessionEpoch: 7,
    rootSessionIssuedAt: FIXTURE_NOW - 60,
    rootSessionExpiresAt: FIXTURE_NOW + 300,
    rootSessionBindingSha256: digest(10),
    passkeyCredentialRowId: 11,
    passkeyCredentialIdSha256: digest(11),
    passkeyCredentialRegistrationIdSha256: digest(21),
    passkeyCredentialBindingSha256: digest(22),
    passkeyPreviousUseGeneration: 17,
    passkeyAssertionSubjectSha256: digest(12),
    passkeyAssertionSignatureSha256: digest(13),
    secureVerificationChallengeSha256: digest(14),
    passkeyPreviousSignCount: 41,
    passkeySignCount: 42,
    passkeyUserPresent: true,
    passkeyUserVerified: true,
    passkeyBackupEligible: true,
    passkeyBackupState: false,
    registeredByServiceName: "cinatoken-application",
    registeredByVersionId: "application-version-001",
    registrationExecutionIdSha256: digest(15),
    registrationCredentialIdSha256: CURRENT_CREDENTIAL_ID_SHA256,
    authorityLedgerIdentitySha256: digest(17),
    receiptSequence: 1,
    ledgerHeadBeforeSha256: digest(18),
    verificationExpiresAt: FIXTURE_NOW + 24,
    verifiedAt: FIXTURE_NOW,
    ...overrides,
  };
}

export function fixtureBody(
  bindings: RegistrationPermitBindings = fixtureBindings(),
): Uint8Array {
  return new TextEncoder().encode(canonicalJson(bindings));
}

export async function fixtureSubject(): Promise<RegistrationPermitSubject> {
  const bindings = fixtureBindings();
  const permitIdSha256 = await derivePermitIdSha256(
    FIXTURE_REQUEST_ID,
    bindings.actionSubjectSha256,
    bindings.passkeyAssertionSignatureSha256,
    bindings.secureVerificationChallengeSha256,
    FIXTURE_NOW,
    FIXTURE_NOW + 24,
  );
  const { verifiedAt, ...bindingsBeforePermitId } = bindings;
  return {
    schemaVersion: 1,
    contract: "relay-container-drain-source-registration-permit-v1",
    issuer: "cinatoken-drain-source-registration-permit-issuer-staging",
    audience:
      "cinatoken-relay-application:staging:drain-source-registration:v1",
    keyId: "registration-permit-staging-v1",
    signerIdentitySha256: digest(19),
    signerSpkiSha256: TEST_SPKI_SHA256,
    ...bindingsBeforePermitId,
    permitIdSha256,
    verifiedAt,
    issuedAt: FIXTURE_NOW,
    expiresAt: FIXTURE_NOW + 24,
  };
}

export function fixtureEnv(overrides: Partial<IssuerEnv> = {}): IssuerEnv {
  return {
    CF_VERSION_METADATA: {
      id: "registration-permit-issuer-version-001",
      tag: "",
      timestamp: "",
    },
    ENVIRONMENT: "staging",
    DRAIN_SOURCE_REGISTRATION_PERMIT_ISSUER_ENABLED: "true",
    DRAIN_SOURCE_REGISTRATION_AUTHORITY_ISSUER:
      "cinatoken-relay-application-staging",
    DRAIN_SOURCE_REGISTRATION_AUTHORITY_AUDIENCE:
      "cinatoken-drain-source-registration-permit-issuer-staging",
    DRAIN_SOURCE_REGISTRATION_HMAC_CURRENT_KID: "current-v1",
    DRAIN_SOURCE_REGISTRATION_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
      CURRENT_CREDENTIAL_ID_SHA256,
    DRAIN_SOURCE_REGISTRATION_HMAC_CURRENT_SECRET: CURRENT_SECRET,
    DRAIN_SOURCE_REGISTRATION_HMAC_PREVIOUS_KID: "previous-v1",
    DRAIN_SOURCE_REGISTRATION_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256:
      PREVIOUS_CREDENTIAL_ID_SHA256,
    DRAIN_SOURCE_REGISTRATION_HMAC_PREVIOUS_SECRET: PREVIOUS_SECRET,
    DRAIN_SOURCE_REGISTRATION_PERMIT_ISSUER:
      "cinatoken-drain-source-registration-permit-issuer-staging",
    DRAIN_SOURCE_REGISTRATION_PERMIT_AUDIENCE:
      "cinatoken-relay-application:staging:drain-source-registration:v1",
    DRAIN_SOURCE_REGISTRATION_PERMIT_KEY_ID: "registration-permit-staging-v1",
    DRAIN_SOURCE_REGISTRATION_PERMIT_SIGNER_IDENTITY_SHA256: digest(19),
    DRAIN_SOURCE_REGISTRATION_PERMIT_SPKI_SHA256: TEST_SPKI_SHA256,
    DRAIN_SOURCE_REGISTRATION_PERMIT_PKCS8_BASE64URL: TEST_PKCS8_BASE64URL,
    DRAIN_SOURCE_REGISTRATION_PERMIT_SPKI_BASE64URL: TEST_SPKI_BASE64URL,
    ...overrides,
  };
}
