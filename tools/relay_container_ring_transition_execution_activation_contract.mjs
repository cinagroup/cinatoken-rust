import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";

export const RING_TRANSITION_EXECUTION_ACTIVATION_TRUST_CONTRACT =
  "cinatoken-relay-container-ring-transition-runner-execution-activation-trust-v1";
export const RING_TRANSITION_EXECUTION_ACTIVATION_CONTRACT =
  "cinatoken-relay-container-ring-transition-runner-execution-activation-v1";
export const RING_TRANSITION_EXECUTION_CLAIM_CONTRACT =
  "cinatoken-relay-container-ring-transition-execution-claim-v1";
export const RING_TRANSITION_CLAIM_REQUEST_CONTRACT =
  "cinatoken-ring-transition-claim-request-v1";
export const RING_TRANSITION_CLAIM_PERMIT_CONTRACT =
  "cinatoken-ring-transition-claim-permit-v1";
export const RING_TRANSITION_CLAIM_PERMIT_DOMAIN =
  "cinatoken-ring-transition-claim-permit-v1\n";
export const RING_TRANSITION_AUTHORITY_ORIGIN =
  "https://ring-transition-authority-staging.cinatoken.com";
export const RING_TRANSITION_CLAIMS_PATH =
  "/internal/v1/ring-transition/claims";
export const MAX_EXECUTION_ACTIVATION_BYTES = 128 * 1024;
export const MAX_CLAIM_REQUEST_BYTES = 64 * 1024;

const MAXIMUM_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MILLISECONDS = 10_000;
const MAXIMUM_CLAIM_LIFETIME_SECONDS = 600;
const MINIMUM_CLAIM_REMAINING_SECONDS = 60;
const MAXIMUM_PERMIT_LIFETIME_SECONDS = 60;
const MAXIMUM_CLOCK_SKEW_SECONDS = 5;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SERVICE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;
const VERSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/;
const IDENTITY_PATTERN = /^[a-z0-9](?:[a-z0-9._:-]{0,127})$/;
const KEY_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,63})$/;
const ED25519_SPKI_PREFIX = Buffer.from(
  "302a300506032b6570032100",
  "hex",
);
const textDecoder = new TextDecoder("utf-8", { fatal: true });

const ACTIVATION_KEYS = [
  "schemaVersion",
  "contract",
  "environment",
  "publication",
  "locator",
  "permitSpkiBase64url",
  "claimRequest",
];
const PUBLICATION_BINDING_KEYS = [
  "publicationManifestSha256",
  "publicationPacketSha256",
  "generationSha256",
  "activationSequence",
  "runnerBuildSha256",
  "runnerTrustConfigSha256",
];
const LOCATOR_KEYS = [
  "method",
  "authorityOrigin",
  "path",
  "retry",
  "timeoutMilliseconds",
  "maximumResponseBytes",
  "accessServiceTokenRequired",
];
const CLAIM_REQUEST_KEYS = [
  "schemaVersion",
  "contract",
  "claim",
  "permit",
];
const CLAIM_KEYS = [
  "schemaVersion",
  "contract",
  "claimAuthority",
  "claimScope",
  "environment",
  "authorizationIdSha256",
  "executionNonceSha256",
  "authorizationManifestSha256",
  "authorizationSubjectSha256",
  "authorizationPolicySha256",
  "transitionManifestSha256",
  "transitionSubjectSha256",
  "transitionPolicySha256",
  "transitionPlanSha256",
  "candidateSha256",
  "executionPlanSha256",
  "accountIdSha256",
  "ledgerIdentitySha256",
  "readCredentialIdSha256",
  "claimCredentialIdSha256",
  "deployCredentialIdSha256",
  "controller",
  "edge",
  "runnerBuildSha256",
  "runnerTrustConfigSha256",
  "claimOwnerSha256",
  "generatedAt",
  "expiresAt",
  "claimDigestSha256",
];
const SERVICE_KEYS = [
  "serviceName",
  "previousVersionId",
  "previousDeploymentSetSha256",
  "targetVersionId",
];
const PERMIT_KEYS = [
  "schemaVersion",
  "contract",
  "issuer",
  "keyId",
  "authorizationIdSha256",
  "claimDigestSha256",
  "claimOwnerSha256",
  "ledgerIdentitySha256",
  "claimCredentialIdSha256",
  "issuedAt",
  "expiresAt",
  "signatureBase64url",
];
const TRUST_KEYS = [
  "schemaVersion",
  "contract",
  "enabled",
  "environment",
  "authorityOrigin",
  "claimPath",
  "permitIssuer",
  "permitKeyId",
  "permitSpkiSha256",
  "ledgerIdentitySha256",
  "transitionPolicySha256",
  "authorizationPolicySha256",
  "accountIdSha256",
  "readCredentialIdSha256",
  "claimCredentialIdSha256",
  "deployCredentialIdSha256",
  "controllerServiceName",
  "edgeServiceName",
  "runnerTrustConfigSha256",
];
const PUBLICATION_KEYS = [
  "release",
  "publicationManifestSha256",
  "publicationPacketSha256",
  "generationSha256",
  "publicationDirectoryName",
  "activationSequence",
  "previousPublicationManifestSha256",
  "publishedAt",
  "expiresAt",
];
const RELEASE_KEYS = [
  "sourceCommit",
  "gitTreeSha",
  "targetTriple",
  "manifestSha256",
  "packetSha256",
  "policySha256",
  "releaseKeyId",
  "releaseKeySpkiBase64url",
  "releaseKeySpkiSha256",
  "artifactFileName",
  "artifactByteLength",
  "artifactSha256",
  "moduleInventorySha256",
  "moduleCount",
  "moduleBytes",
  "authorityVersionId",
  "permitSpkiSha256",
  "trustConfigSha256",
  "issuedAt",
  "expiresAt",
];

export function describeRingTransitionExecutionActivationContract() {
  return {
    ok: true,
    schemaVersion: 1,
    contract: RING_TRANSITION_EXECUTION_ACTIVATION_CONTRACT,
    environment: "staging",
    authorityOrigin: RING_TRANSITION_AUTHORITY_ORIGIN,
    claimPath: RING_TRANSITION_CLAIMS_PATH,
    maximumActivationBytes: MAX_EXECUTION_ACTIVATION_BYTES,
    maximumClaimRequestBytes: MAX_CLAIM_REQUEST_BYTES,
    constraints: {
      canonicalJsonRequired: true,
      duplicateAndUnknownFieldsAllowed: false,
      fixedAuthorityLocatorRequired: true,
      publicationAndTrustJoinsRequired: true,
      ed25519PermitRequired: true,
      credentialsRead: false,
      environmentRead: false,
      filesRead: false,
      filesWritten: false,
      networkRequestsPerformed: false,
      remoteMutationAuthorized: false,
    },
  };
}

export function computeRingTransitionExecutionClaimDigest(claim) {
  const value = requireObject(claim, "[claim] execution claim");
  const digestInput = { ...value };
  delete digestInput.claimDigestSha256;
  return digestCanonical(digestInput);
}

export function ringTransitionClaimPermitMessage(permitSubject) {
  const subject = requireObject(permitSubject, "[permit] subject");
  exactKeys(subject, PERMIT_KEYS.slice(0, -1), "[permit] subject");
  return Buffer.from(
    `${RING_TRANSITION_CLAIM_PERMIT_DOMAIN}${canonicalJson(subject)}`,
    "utf8",
  );
}

export function verifyRingTransitionExecutionActivation({
  activationBytes,
  trust,
  publication,
  now,
}) {
  const currentTime = requireInteger(
    now,
    1,
    Number.MAX_SAFE_INTEGER,
    "[time] now",
  );
  const verifiedPublication = validatePublication(publication);
  const verifiedTrust = validateTrust(trust, verifiedPublication);
  const bytes = requireByteArray(
    activationBytes,
    "[activation] canonical bytes",
  );
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_EXECUTION_ACTIVATION_BYTES
  ) {
    throw new Error("[activation] byte length is invalid");
  }
  const activation = parseCanonicalActivation(bytes);
  validateActivation(
    activation,
    verifiedTrust,
    verifiedPublication,
    currentTime,
  );
  const requestBytes = Buffer.from(
    canonicalJson(activation.claimRequest),
    "utf8",
  );
  if (requestBytes.byteLength > MAX_CLAIM_REQUEST_BYTES) {
    throw new Error("[activation] claim request exceeds its byte bound");
  }
  const claim = activation.claimRequest.claim;
  return {
    ok: true,
    activationSha256: sha256Hex(bytes),
    publicationManifestSha256:
      verifiedPublication.publicationManifestSha256,
    authorizationIdSha256: claim.authorizationIdSha256,
    executionNonceSha256: claim.executionNonceSha256,
    claimDigestSha256: claim.claimDigestSha256,
    claimOwnerSha256: claim.claimOwnerSha256,
    claimRequestSha256: sha256Hex(requestBytes),
    claimRequestBytes: Uint8Array.from(requestBytes),
    permitExpiresAt: activation.claimRequest.permit.expiresAt,
    claimExpiresAt: claim.expiresAt,
  };
}

function parseCanonicalActivation(bytes) {
  let text;
  try {
    text = textDecoder.decode(bytes);
  } catch {
    throw new Error("[activation] JSON must be valid UTF-8");
  }
  rejectDuplicateJsonFields(text, "[activation]");
  let activation;
  try {
    activation = JSON.parse(text);
  } catch {
    throw new Error("[activation] JSON is invalid");
  }
  if (text !== canonicalJson(activation)) {
    throw new Error("[activation] JSON must be canonical");
  }
  return activation;
}

function validateActivation(activation, trust, publication, now) {
  const record = requireObject(activation, "[activation] record");
  exactKeys(record, ACTIVATION_KEYS, "[activation] record");
  requireExact(record.schemaVersion, 1, "[activation] schema version");
  requireExact(
    record.contract,
    RING_TRANSITION_EXECUTION_ACTIVATION_CONTRACT,
    "[activation] contract",
  );
  requireExact(record.environment, "staging", "[activation] environment");

  validatePublicationBinding(record.publication, publication);
  validateLocator(record.locator, trust);
  const spki = decodeBase64Url(
    record.permitSpkiBase64url,
    44,
    "[activation] permit SPKI",
  );
  if (!spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
    throw new Error("[activation] permit public key is not Ed25519 SPKI");
  }
  requireExact(
    sha256Hex(spki),
    trust.permitSpkiSha256,
    "[activation] permit SPKI digest",
  );

  const request = requireObject(
    record.claimRequest,
    "[activation] claim request",
  );
  exactKeys(request, CLAIM_REQUEST_KEYS, "[activation] claim request");
  requireExact(request.schemaVersion, 1, "[activation] request schema version");
  requireExact(
    request.contract,
    RING_TRANSITION_CLAIM_REQUEST_CONTRACT,
    "[activation] request contract",
  );
  const claim = validateClaim(request.claim);
  validateClaimJoins(claim, trust, publication);
  validatePermit(request.permit, claim, trust, spki, now);
}

function validatePublicationBinding(value, publication) {
  const binding = requireObject(value, "[activation] publication binding");
  exactKeys(
    binding,
    PUBLICATION_BINDING_KEYS,
    "[activation] publication binding",
  );
  for (const [field, expected] of [
    ["publicationManifestSha256", publication.publicationManifestSha256],
    ["publicationPacketSha256", publication.publicationPacketSha256],
    ["generationSha256", publication.generationSha256],
    ["activationSequence", publication.activationSequence],
    ["runnerBuildSha256", publication.release.artifactSha256],
    ["runnerTrustConfigSha256", publication.release.trustConfigSha256],
  ]) {
    requireExact(
      binding[field],
      expected,
      `[activation] publication ${field}`,
    );
  }
}

function validateLocator(value, trust) {
  const locator = requireObject(value, "[activation] Authority locator");
  exactKeys(locator, LOCATOR_KEYS, "[activation] Authority locator");
  for (const [field, expected] of [
    ["method", "POST"],
    ["authorityOrigin", trust.authorityOrigin],
    ["path", RING_TRANSITION_CLAIMS_PATH],
    ["retry", false],
    ["timeoutMilliseconds", REQUEST_TIMEOUT_MILLISECONDS],
    ["maximumResponseBytes", MAXIMUM_RESPONSE_BYTES],
    ["accessServiceTokenRequired", true],
  ]) {
    requireExact(locator[field], expected, `[activation] locator ${field}`);
  }
}

function validateClaim(value) {
  const claim = requireObject(value, "[claim] execution claim");
  exactKeys(claim, CLAIM_KEYS, "[claim] execution claim");
  requireExact(claim.schemaVersion, 1, "[claim] schema version");
  requireExact(
    claim.contract,
    RING_TRANSITION_EXECUTION_CLAIM_CONTRACT,
    "[claim] contract",
  );
  requireExact(claim.claimAuthority, "d1-unique-claim-v1", "[claim] authority");
  requireExact(
    claim.claimScope,
    "staging-worker-ring-transition",
    "[claim] scope",
  );
  requireExact(claim.environment, "staging", "[claim] environment");
  for (const field of [
    "authorizationIdSha256",
    "executionNonceSha256",
    "authorizationManifestSha256",
    "authorizationSubjectSha256",
    "authorizationPolicySha256",
    "transitionManifestSha256",
    "transitionSubjectSha256",
    "transitionPolicySha256",
    "transitionPlanSha256",
    "candidateSha256",
    "executionPlanSha256",
    "accountIdSha256",
    "ledgerIdentitySha256",
    "readCredentialIdSha256",
    "claimCredentialIdSha256",
    "deployCredentialIdSha256",
    "runnerBuildSha256",
    "runnerTrustConfigSha256",
    "claimOwnerSha256",
    "claimDigestSha256",
  ]) {
    requireSha256(claim[field], `[claim] ${field}`);
  }
  if (
    claim.authorizationIdSha256 === claim.executionNonceSha256 ||
    new Set([
      claim.readCredentialIdSha256,
      claim.claimCredentialIdSha256,
      claim.deployCredentialIdSha256,
    ]).size !== 3
  ) {
    throw new Error("[claim] identity separation is invalid");
  }
  const controller = validateService(claim.controller, "[claim] controller");
  const edge = validateService(claim.edge, "[claim] edge");
  if (controller.serviceName === edge.serviceName) {
    throw new Error("[claim] controller and edge services must differ");
  }
  requireInteger(
    claim.generatedAt,
    1,
    Number.MAX_SAFE_INTEGER,
    "[claim] generatedAt",
  );
  requireInteger(
    claim.expiresAt,
    1,
    Number.MAX_SAFE_INTEGER,
    "[claim] expiresAt",
  );
  if (
    claim.expiresAt <= claim.generatedAt ||
    claim.expiresAt - claim.generatedAt > MAXIMUM_CLAIM_LIFETIME_SECONDS
  ) {
    throw new Error("[claim] validity window is invalid");
  }
  requireExact(
    claim.claimDigestSha256,
    computeRingTransitionExecutionClaimDigest(claim),
    "[claim] digest",
  );
  return claim;
}

function validateService(value, label) {
  const service = requireObject(value, label);
  exactKeys(service, SERVICE_KEYS, label);
  requirePattern(service.serviceName, SERVICE_NAME_PATTERN, `${label} service`);
  requirePattern(
    service.previousVersionId,
    VERSION_ID_PATTERN,
    `${label} previous version`,
  );
  requireSha256(
    service.previousDeploymentSetSha256,
    `${label} previous deployment set`,
  );
  requirePattern(
    service.targetVersionId,
    VERSION_ID_PATTERN,
    `${label} target version`,
  );
  if (service.previousVersionId === service.targetVersionId) {
    throw new Error(`${label} target version is unchanged`);
  }
  return service;
}

function validateClaimJoins(claim, trust, publication) {
  for (const [field, expected] of [
    ["authorizationPolicySha256", trust.authorizationPolicySha256],
    ["transitionPolicySha256", trust.transitionPolicySha256],
    ["accountIdSha256", trust.accountIdSha256],
    ["ledgerIdentitySha256", trust.ledgerIdentitySha256],
    ["readCredentialIdSha256", trust.readCredentialIdSha256],
    ["claimCredentialIdSha256", trust.claimCredentialIdSha256],
    ["deployCredentialIdSha256", trust.deployCredentialIdSha256],
    ["runnerBuildSha256", publication.release.artifactSha256],
    ["runnerTrustConfigSha256", trust.runnerTrustConfigSha256],
  ]) {
    requireExact(claim[field], expected, `[claim] trust join ${field}`);
  }
  requireExact(
    claim.controller.serviceName,
    trust.controllerServiceName,
    "[claim] controller service trust join",
  );
  requireExact(
    claim.edge.serviceName,
    trust.edgeServiceName,
    "[claim] edge service trust join",
  );
}

function validatePermit(value, claim, trust, spki, now) {
  const permit = requireObject(value, "[permit] signed permit");
  exactKeys(permit, PERMIT_KEYS, "[permit] signed permit");
  requireExact(permit.schemaVersion, 1, "[permit] schema version");
  requireExact(
    permit.contract,
    RING_TRANSITION_CLAIM_PERMIT_CONTRACT,
    "[permit] contract",
  );
  requirePattern(permit.issuer, IDENTITY_PATTERN, "[permit] issuer");
  requirePattern(permit.keyId, KEY_ID_PATTERN, "[permit] key ID");
  requireExact(permit.issuer, trust.permitIssuer, "[permit] issuer trust join");
  requireExact(permit.keyId, trust.permitKeyId, "[permit] key trust join");
  for (const [field, expected] of [
    ["authorizationIdSha256", claim.authorizationIdSha256],
    ["claimDigestSha256", claim.claimDigestSha256],
    ["claimOwnerSha256", claim.claimOwnerSha256],
    ["ledgerIdentitySha256", claim.ledgerIdentitySha256],
    ["claimCredentialIdSha256", claim.claimCredentialIdSha256],
  ]) {
    requireSha256(permit[field], `[permit] ${field}`);
    requireExact(permit[field], expected, `[permit] claim join ${field}`);
  }
  requireInteger(
    permit.issuedAt,
    1,
    Number.MAX_SAFE_INTEGER,
    "[permit] issuedAt",
  );
  requireInteger(
    permit.expiresAt,
    1,
    Number.MAX_SAFE_INTEGER,
    "[permit] expiresAt",
  );
  if (
    permit.issuedAt < claim.generatedAt ||
    permit.expiresAt <= permit.issuedAt ||
    permit.expiresAt - permit.issuedAt > MAXIMUM_PERMIT_LIFETIME_SECONDS ||
    permit.expiresAt > claim.expiresAt ||
    permit.issuedAt > now + MAXIMUM_CLOCK_SKEW_SECONDS ||
    Math.max(0, now - permit.issuedAt) > MAXIMUM_PERMIT_LIFETIME_SECONDS ||
    permit.expiresAt <= now ||
    claim.generatedAt > now ||
    claim.expiresAt < now + MINIMUM_CLAIM_REMAINING_SECONDS
  ) {
    throw new Error("[permit] validity window is invalid");
  }
  const signature = decodeBase64Url(
    permit.signatureBase64url,
    64,
    "[permit] signature",
  );
  let publicKey;
  try {
    publicKey = createPublicKey({
      key: spki,
      format: "der",
      type: "spki",
    });
  } catch {
    throw new Error("[permit] public key is invalid");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("[permit] public key must be Ed25519");
  }
  const subject = { ...permit };
  delete subject.signatureBase64url;
  if (
    !verifySignature(
      null,
      ringTransitionClaimPermitMessage(subject),
      publicKey,
      signature,
    )
  ) {
    throw new Error("[permit] signature is invalid");
  }
}

function validateTrust(value, publication) {
  const trust = requireObject(value, "[trust] execution activation trust");
  exactKeys(trust, TRUST_KEYS, "[trust] execution activation trust");
  requireExact(trust.schemaVersion, 1, "[trust] schema version");
  requireExact(
    trust.contract,
    RING_TRANSITION_EXECUTION_ACTIVATION_TRUST_CONTRACT,
    "[trust] contract",
  );
  requireExact(trust.enabled, true, "[trust] enabled");
  requireExact(trust.environment, "staging", "[trust] environment");
  requireExact(
    trust.authorityOrigin,
    RING_TRANSITION_AUTHORITY_ORIGIN,
    "[trust] Authority origin",
  );
  requireExact(
    trust.claimPath,
    RING_TRANSITION_CLAIMS_PATH,
    "[trust] claim path",
  );
  requirePattern(trust.permitIssuer, IDENTITY_PATTERN, "[trust] permit issuer");
  requirePattern(trust.permitKeyId, KEY_ID_PATTERN, "[trust] permit key ID");
  for (const field of [
    "permitSpkiSha256",
    "ledgerIdentitySha256",
    "transitionPolicySha256",
    "authorizationPolicySha256",
    "accountIdSha256",
    "readCredentialIdSha256",
    "claimCredentialIdSha256",
    "deployCredentialIdSha256",
    "runnerTrustConfigSha256",
  ]) {
    requireSha256(trust[field], `[trust] ${field}`);
  }
  requirePattern(
    trust.controllerServiceName,
    SERVICE_NAME_PATTERN,
    "[trust] controller service",
  );
  requirePattern(
    trust.edgeServiceName,
    SERVICE_NAME_PATTERN,
    "[trust] edge service",
  );
  if (
    trust.transitionPolicySha256 === trust.authorizationPolicySha256 ||
    trust.controllerServiceName === trust.edgeServiceName ||
    new Set([
      trust.readCredentialIdSha256,
      trust.claimCredentialIdSha256,
      trust.deployCredentialIdSha256,
    ]).size !== 3
  ) {
    throw new Error("[trust] identity separation is invalid");
  }
  requireExact(
    publication.release.permitSpkiSha256,
    trust.permitSpkiSha256,
    "[trust] publication permit key",
  );
  requireExact(
    publication.release.trustConfigSha256,
    trust.runnerTrustConfigSha256,
    "[trust] publication configuration",
  );
  if (
    publication.release.releaseKeySpkiSha256 === trust.permitSpkiSha256
  ) {
    throw new Error("[trust] release and permit keys must differ");
  }
  return trust;
}

function validatePublication(value) {
  const publication = requireObject(value, "[publication] identity");
  exactKeys(publication, PUBLICATION_KEYS, "[publication] identity");
  for (const field of [
    "publicationManifestSha256",
    "publicationPacketSha256",
    "generationSha256",
  ]) {
    requireSha256(publication[field], `[publication] ${field}`);
  }
  requireInteger(
    publication.activationSequence,
    1,
    Number.MAX_SAFE_INTEGER,
    "[publication] activation sequence",
  );
  if (publication.previousPublicationManifestSha256 !== null) {
    requireSha256(
      publication.previousPublicationManifestSha256,
      "[publication] previous manifest",
    );
  }
  for (const field of [
    "publicationDirectoryName",
    "publishedAt",
    "expiresAt",
  ]) {
    requireString(publication[field], `[publication] ${field}`);
  }
  const release = requireObject(publication.release, "[publication] release");
  exactKeys(release, RELEASE_KEYS, "[publication] release");
  for (const field of [
    "manifestSha256",
    "packetSha256",
    "policySha256",
    "releaseKeySpkiSha256",
    "artifactSha256",
    "moduleInventorySha256",
    "permitSpkiSha256",
    "trustConfigSha256",
  ]) {
    requireSha256(release[field], `[publication] release ${field}`);
  }
  return publication;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value);
  const allowed = new Set(expected);
  const unknown = actual.find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    throw new Error(`${label} contains unknown field ${unknown}`);
  }
  const missing = expected.find(
    (key) => !Object.prototype.hasOwnProperty.call(value, key),
  );
  if (missing !== undefined || actual.length !== expected.length) {
    throw new Error(`${label} is missing field ${missing ?? "unknown"}`);
  }
}

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  return value;
}

function requirePattern(value, pattern, label) {
  requireString(value, label);
  if (!pattern.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requireSha256(value, label) {
  return requirePattern(value, SHA256_PATTERN, label);
}

function requireInteger(value, minimum, maximum, label) {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function requireExact(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} mismatch`);
  }
  return actual;
}

function requireByteArray(value, label) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  throw new TypeError(`${label} must be a byte array`);
}

function decodeBase64Url(value, expectedLength, label) {
  requireString(value, label);
  if (
    value.length === 0 ||
    value.includes("=") ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new Error(`${label} is not unpadded base64url`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.byteLength !== expectedLength ||
    decoded.toString("base64url") !== value
  ) {
    throw new Error(`${label} has invalid encoding or length`);
  }
  return decoded;
}

function digestCanonical(value) {
  return sha256Hex(Buffer.from(canonicalJson(value), "utf8"));
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value) {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    requireUnicodeScalarString(value, "[canonical] string");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error("[canonical] numbers must be safe integers");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error("[canonical] value must be JSON-compatible");
  }
  const result = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    requireUnicodeScalarString(key, "[canonical] key");
    result[key] = canonicalValue(value[key]);
  }
  return result;
}

function requireUnicodeScalarString(value, label) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) {
        throw new Error(`${label} contains an unpaired surrogate`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error(`${label} contains an unpaired surrogate`);
    }
  }
}

function rejectDuplicateJsonFields(json, label) {
  let index = 0;

  function fail() {
    throw new Error(`${label} JSON is invalid or contains duplicate fields`);
  }

  function skipWhitespace() {
    while (
      index < json.length &&
      (json[index] === " " ||
        json[index] === "\n" ||
        json[index] === "\r" ||
        json[index] === "\t")
    ) {
      index += 1;
    }
  }

  function scanString() {
    if (json[index] !== '"') {
      fail();
    }
    const start = index;
    index += 1;
    while (index < json.length) {
      const code = json.charCodeAt(index);
      if (code === 0x22) {
        index += 1;
        try {
          return JSON.parse(json.slice(start, index));
        } catch {
          fail();
        }
      }
      if (code < 0x20) {
        fail();
      }
      if (code === 0x5c) {
        index += 1;
        if (index >= json.length) {
          fail();
        }
        if (json[index] === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(json.slice(index + 1, index + 5))) {
            fail();
          }
          index += 5;
          continue;
        }
        if (!'"\\/bfnrt'.includes(json[index])) {
          fail();
        }
      }
      index += 1;
    }
    fail();
  }

  function scanNumber() {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      json.slice(index),
    );
    if (match === null) {
      fail();
    }
    index += match[0].length;
  }

  function scanValue() {
    skipWhitespace();
    const token = json[index];
    if (token === "{") {
      scanObject();
      return;
    }
    if (token === "[") {
      scanArray();
      return;
    }
    if (token === '"') {
      scanString();
      return;
    }
    for (const literal of ["true", "false", "null"]) {
      if (json.startsWith(literal, index)) {
        index += literal.length;
        return;
      }
    }
    scanNumber();
  }

  function scanObject() {
    index += 1;
    skipWhitespace();
    const fields = new Set();
    if (json[index] === "}") {
      index += 1;
      return;
    }
    while (index < json.length) {
      skipWhitespace();
      const field = scanString();
      if (fields.has(field)) {
        fail();
      }
      fields.add(field);
      skipWhitespace();
      if (json[index] !== ":") {
        fail();
      }
      index += 1;
      scanValue();
      skipWhitespace();
      if (json[index] === "}") {
        index += 1;
        return;
      }
      if (json[index] !== ",") {
        fail();
      }
      index += 1;
    }
    fail();
  }

  function scanArray() {
    index += 1;
    skipWhitespace();
    if (json[index] === "]") {
      index += 1;
      return;
    }
    while (index < json.length) {
      scanValue();
      skipWhitespace();
      if (json[index] === "]") {
        index += 1;
        return;
      }
      if (json[index] !== ",") {
        fail();
      }
      index += 1;
    }
    fail();
  }

  scanValue();
  skipWhitespace();
  if (index !== json.length) {
    fail();
  }
}
