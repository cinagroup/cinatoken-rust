import {
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import {
  lstat,
  open,
  realpath,
} from "node:fs/promises";
import path from "node:path";

import {
  canonicalJson,
  sha256Hex,
} from "./relay_container_p5_evidence_contract.mjs";
import {
  readCanonicalJsonEvidence,
} from "./relay_container_ring_transition_contract.mjs";

export const RING_TRANSITION_RUNNER_RELEASE_MANIFEST_CONTRACT =
  "cinatoken-relay-container-ring-transition-runner-release-manifest-v1";
export const RING_TRANSITION_RUNNER_RELEASE_PACKET_CONTRACT =
  "cinatoken-relay-container-ring-transition-runner-release-packet-v1";
export const RING_TRANSITION_RUNNER_RELEASE_POLICY_CONTRACT =
  "cinatoken-relay-container-ring-transition-runner-release-policy-v1";
export const RING_TRANSITION_RUNNER_MODULE_INVENTORY_CONTRACT =
  "cinatoken-relay-container-ring-transition-runner-module-inventory-v1";
export const RING_TRANSITION_RUNNER_DSSE_PAYLOAD_TYPE =
  "application/vnd.cinatoken.ring-transition-runner-release.v1+json";

const MAX_PACKET_BYTES = 2 * 1024 * 1024;
const MAX_POLICY_BYTES = 256 * 1024;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_INVENTORY_FILES = 2048;
const MAX_INVENTORY_BYTES = 64 * 1024 * 1024;
const MAX_RELEASE_LIFETIME_SECONDS = 24 * 60 * 60;
const MAX_CLOCK_SKEW_SECONDS = 300;
const STAGING_AUTHORITY_ORIGIN =
  "https://ring-transition-authority-staging.cinatoken.com";
const RELEASE_ARTIFACT_BASENAME = "cinatoken-ring-transition-runner";
const REQUIRED_MODULE_PATHS = Object.freeze([
  ".gitattributes",
  "Cargo.lock",
  "Cargo.toml",
  "bun.lock",
  "crates/ring-transition-runner/Cargo.toml",
  "crates/ring-transition-runner/src/lib.rs",
  "crates/ring-transition-runner/src/main.rs",
  "crates/ring-transition-runner/src/orchestrator.rs",
  "crates/ring-transition-runner/src/release.rs",
  "crates/ring-transition-runner/tests/cli.rs",
  "package.json",
  "tests/relay-container-ring-transition-release-source.test.mjs",
  "tests/relay-container-ring-transition-release.test.mjs",
  "tools/collect_ring_transition_runner_release_source.mjs",
  "tools/relay_container_p5_evidence_contract.mjs",
  "tools/relay_container_ring_transition_contract.mjs",
  "tools/relay_container_ring_transition_release_contract.mjs",
  "tools/verify_relay_container_ring_transition_release.mjs",
]);
const TARGETS = Object.freeze([
  "x86_64-pc-windows-msvc",
  "x86_64-unknown-linux-musl",
]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VERSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MODULE_PATH_PATTERN = /^[A-Za-z0-9.][A-Za-z0-9._/-]{0,239}$/;

export function describeRingTransitionRunnerReleaseContract() {
  return {
    ok: true,
    schemaVersion: 1,
    manifestContract: RING_TRANSITION_RUNNER_RELEASE_MANIFEST_CONTRACT,
    packetContract: RING_TRANSITION_RUNNER_RELEASE_PACKET_CONTRACT,
    policyContract: RING_TRANSITION_RUNNER_RELEASE_POLICY_CONTRACT,
    moduleInventoryContract: RING_TRANSITION_RUNNER_MODULE_INVENTORY_CONTRACT,
    dssePayloadType: RING_TRANSITION_RUNNER_DSSE_PAYLOAD_TYPE,
    environment: "staging",
    releaseForm: "detached-signed-packet",
    selfHashCycleAvoided: true,
    requiredModulePaths: REQUIRED_MODULE_PATHS,
    constraints: {
      canonicalJsonRequired: true,
      exactlyOneEd25519SignatureRequired: true,
      externalPolicyRequired: true,
      compiledPolicyAndKeyPinsRequiredForExecution: true,
      twoBuildsMustBeIdentical: true,
      artifactMustBePacketSibling: true,
      symlinksAndHardlinksAllowed: false,
      credentialsRead: false,
      networkRequestsPerformed: false,
      shellCommandsExecuted: false,
      filesWritten: false,
      releaseInstallAuthorized: false,
      remoteMutationAuthorized: false,
      customerTrafficAuthorized: false,
      productionCutoverAuthorized: false,
    },
  };
}

export async function verifyRingTransitionRunnerRelease({
  packetPath,
  trustPolicyPath,
  now = new Date(),
  pinnedPolicySha256 = null,
  pinnedReleaseKeySpkiSha256 = null,
}) {
  const verifierNow = requireDate(now, "[time] verifier now");
  validateOptionalPin(pinnedPolicySha256, "[pin] release policy digest");
  validateOptionalPin(
    pinnedReleaseKeySpkiSha256,
    "[pin] release key SPKI fingerprint",
  );
  const packetFile = await readCanonicalJsonEvidence(
    packetPath,
    "runner release packet",
    MAX_PACKET_BYTES,
  );
  const policyFile = await readCanonicalJsonEvidence(
    trustPolicyPath,
    "runner release policy",
    MAX_POLICY_BYTES,
  );
  const policySha256 = sha256Hex(policyFile.bytes);
  const policy = validateReleasePolicy(policyFile.value, verifierNow);
  if (
    pinnedPolicySha256 !== null &&
    pinnedPolicySha256 !== policySha256
  ) {
    throw new Error("[pin] release policy digest mismatch");
  }
  if (
    pinnedReleaseKeySpkiSha256 !== null &&
    pinnedReleaseKeySpkiSha256 !== policy.releaseKeySpkiSha256
  ) {
    throw new Error("[pin] release key SPKI fingerprint mismatch");
  }
  const packet = requireObject(packetFile.value, "[packet]");
  exactKeys(
    packet,
    ["schemaVersion", "contract", "envelope", "moduleInventory"],
    "[packet]",
  );
  requireExact(packet.schemaVersion, 1, "[packet] schema version");
  requireExact(
    packet.contract,
    RING_TRANSITION_RUNNER_RELEASE_PACKET_CONTRACT,
    "[packet] contract",
  );
  const inventory = validateModuleInventory(packet.moduleInventory);
  const envelope = validateDsseEnvelope(packet.envelope, policy);
  const manifestBytes = decodeBase64(
    envelope.payload,
    "[packet] DSSE payload",
    2,
    MAX_PACKET_BYTES,
  );
  const manifest = parseCanonicalPayload(manifestBytes);
  const validatedManifest = validateReleaseManifest({
    manifest,
    inventory,
    policy,
    policySha256,
    now: verifierNow,
  });
  const publicKey = importEd25519PublicKey(policy);
  const signature = decodeBase64(
    envelope.signatures[0].sig,
    "[packet] DSSE signature",
    64,
    64,
  );
  const pae = dssePreAuthenticationEncoding(
    envelope.payloadType,
    manifestBytes,
  );
  if (!verifySignature(null, pae, publicKey, signature)) {
    throw new Error("[packet] DSSE signature verification failed");
  }
  const packetDirectory = path.dirname(packetFile.resolved);
  const artifactPath = path.resolve(
    packetDirectory,
    validatedManifest.artifact.fileName,
  );
  if (path.dirname(artifactPath) !== packetDirectory) {
    throw new Error("[artifact] must be a packet sibling");
  }
  const artifact = await readBoundedRegularFile(
    artifactPath,
    "[artifact]",
    MAX_ARTIFACT_BYTES,
  );
  if (
    artifact.bytes.length !== validatedManifest.artifact.byteLength ||
    sha256Hex(artifact.bytes) !== validatedManifest.artifact.sha256
  ) {
    throw new Error("[artifact] identity mismatch");
  }
  const pinsVerified =
    pinnedPolicySha256 !== null &&
    pinnedReleaseKeySpkiSha256 !== null;
  return {
    ok: true,
    schemaVersion: 1,
    contract: RING_TRANSITION_RUNNER_RELEASE_PACKET_CONTRACT,
    environment: "staging",
    sourceCommit: validatedManifest.source.commitSha,
    gitTreeSha: validatedManifest.source.gitTreeSha,
    manifestSha256: sha256Hex(manifestBytes),
    packetSha256: sha256Hex(packetFile.bytes),
    policySha256,
    releaseKeySpkiSha256: policy.releaseKeySpkiSha256,
    artifactFileName: validatedManifest.artifact.fileName,
    artifactSha256: validatedManifest.artifact.sha256,
    moduleInventorySha256:
      validatedManifest.source.moduleInventorySha256,
    moduleCount: inventory.moduleCount,
    moduleBytes: inventory.moduleBytes,
    issuedAt: validatedManifest.issuedAt,
    expiresAt: validatedManifest.expiresAt,
    signatureVerified: true,
    artifactVerified: true,
    twoBuildsIdentical: true,
    externalPinsVerified: pinsVerified,
    compiledLauncherTrustVerified: false,
    releaseInstallAuthorized: false,
    credentialsRead: false,
    networkRequestsPerformed: false,
    shellCommandsExecuted: false,
    filesWritten: false,
    remoteMutationAuthorized: false,
    customerTrafficAuthorized: false,
    productionCutoverAuthorized: false,
  };
}

export function dssePreAuthenticationEncoding(payloadType, payloadBytes) {
  if (
    typeof payloadType !== "string" ||
    payloadType !== RING_TRANSITION_RUNNER_DSSE_PAYLOAD_TYPE
  ) {
    throw new Error("[DSSE] payload type mismatch");
  }
  const typeBytes = Buffer.from(payloadType, "utf8");
  const payload = Buffer.from(payloadBytes);
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${typeBytes.length} `, "utf8"),
    typeBytes,
    Buffer.from(` ${payload.length} `, "utf8"),
    payload,
  ]);
}

function validateReleasePolicy(value, now) {
  const policy = requireObject(value, "[policy]");
  exactKeys(
    policy,
    [
      "schemaVersion",
      "contract",
      "environment",
      "payloadType",
      "keyId",
      "releaseKeySpkiBase64url",
      "releaseKeySpkiSha256",
      "validFrom",
      "validUntil",
      "maximumReleaseLifetimeSeconds",
      "forbiddenKeySpkiSha256",
    ],
    "[policy]",
  );
  requireExact(policy.schemaVersion, 1, "[policy] schema version");
  requireExact(
    policy.contract,
    RING_TRANSITION_RUNNER_RELEASE_POLICY_CONTRACT,
    "[policy] contract",
  );
  requireExact(policy.environment, "staging", "[policy] environment");
  requireExact(
    policy.payloadType,
    RING_TRANSITION_RUNNER_DSSE_PAYLOAD_TYPE,
    "[policy] payload type",
  );
  requireToken(policy.keyId, KEY_ID_PATTERN, "[policy] key ID");
  const spki = decodeBase64Url(
    policy.releaseKeySpkiBase64url,
    "[policy] release key SPKI",
    32,
    512,
  );
  requireSha256(
    policy.releaseKeySpkiSha256,
    "[policy] release key SPKI fingerprint",
  );
  if (sha256Hex(spki) !== policy.releaseKeySpkiSha256) {
    throw new Error("[policy] release key SPKI fingerprint mismatch");
  }
  const validFrom = requireWholeSecondTimestamp(
    policy.validFrom,
    "[policy] validFrom",
  );
  const validUntil = requireWholeSecondTimestamp(
    policy.validUntil,
    "[policy] validUntil",
  );
  if (
    validUntil.getTime() <= validFrom.getTime() ||
    now.getTime() + MAX_CLOCK_SKEW_SECONDS * 1000 < validFrom.getTime() ||
    now.getTime() - MAX_CLOCK_SKEW_SECONDS * 1000 > validUntil.getTime()
  ) {
    throw new Error("[policy] validity window is inactive");
  }
  requireInteger(
    policy.maximumReleaseLifetimeSeconds,
    60,
    MAX_RELEASE_LIFETIME_SECONDS,
    "[policy] maximum release lifetime",
  );
  if (
    !Array.isArray(policy.forbiddenKeySpkiSha256) ||
    policy.forbiddenKeySpkiSha256.length < 3 ||
    policy.forbiddenKeySpkiSha256.length > 32
  ) {
    throw new Error("[policy] forbidden key inventory is invalid");
  }
  let previous = null;
  for (const [index, fingerprint] of
    policy.forbiddenKeySpkiSha256.entries()) {
    requireSha256(
      fingerprint,
      `[policy] forbidden key fingerprint ${index}`,
    );
    if (
      fingerprint === policy.releaseKeySpkiSha256 ||
      (previous !== null && fingerprint <= previous)
    ) {
      throw new Error(
        "[policy] release key must be distinct from a sorted unique key inventory",
      );
    }
    previous = fingerprint;
  }
  return policy;
}

function validateDsseEnvelope(value, policy) {
  const envelope = requireObject(value, "[packet] DSSE envelope");
  exactKeys(
    envelope,
    ["payloadType", "payload", "signatures"],
    "[packet] DSSE envelope",
  );
  requireExact(
    envelope.payloadType,
    policy.payloadType,
    "[packet] DSSE payload type",
  );
  decodeBase64(
    envelope.payload,
    "[packet] DSSE payload",
    2,
    MAX_PACKET_BYTES,
  );
  if (!Array.isArray(envelope.signatures) || envelope.signatures.length !== 1) {
    throw new Error("[packet] DSSE requires exactly one signature");
  }
  const signature = requireObject(
    envelope.signatures[0],
    "[packet] DSSE signature",
  );
  exactKeys(signature, ["keyid", "sig"], "[packet] DSSE signature");
  requireExact(signature.keyid, policy.keyId, "[packet] DSSE key ID");
  decodeBase64(signature.sig, "[packet] DSSE signature", 64, 64);
  return envelope;
}

function validateReleaseManifest({
  manifest,
  inventory,
  policy,
  policySha256,
  now,
}) {
  const value = requireObject(manifest, "[manifest]");
  exactKeys(
    value,
    [
      "schemaVersion",
      "contract",
      "environment",
      "issuedAt",
      "expiresAt",
      "sourceDateEpoch",
      "source",
      "build",
      "trust",
      "evidence",
      "artifact",
    ],
    "[manifest]",
  );
  requireExact(value.schemaVersion, 1, "[manifest] schema version");
  requireExact(
    value.contract,
    RING_TRANSITION_RUNNER_RELEASE_MANIFEST_CONTRACT,
    "[manifest] contract",
  );
  requireExact(value.environment, "staging", "[manifest] environment");
  const issuedAt = requireWholeSecondTimestamp(
    value.issuedAt,
    "[manifest] issuedAt",
  );
  const expiresAt = requireWholeSecondTimestamp(
    value.expiresAt,
    "[manifest] expiresAt",
  );
  const lifetimeSeconds = (expiresAt.getTime() - issuedAt.getTime()) / 1000;
  if (
    lifetimeSeconds <= 0 ||
    lifetimeSeconds > policy.maximumReleaseLifetimeSeconds ||
    issuedAt.getTime() < new Date(policy.validFrom).getTime() ||
    expiresAt.getTime() > new Date(policy.validUntil).getTime() ||
    issuedAt.getTime() > now.getTime() + MAX_CLOCK_SKEW_SECONDS * 1000 ||
    expiresAt.getTime() < now.getTime() - MAX_CLOCK_SKEW_SECONDS * 1000
  ) {
    throw new Error("[manifest] release validity window is invalid");
  }
  const sourceDateEpoch = requireInteger(
    value.sourceDateEpoch,
    1,
    Math.floor(issuedAt.getTime() / 1000),
    "[manifest] SOURCE_DATE_EPOCH",
  );
  const source = validateSource(value.source, inventory);
  const build = validateBuild(value.build);
  const trust = validateTrust(value.trust, policy, policySha256);
  const evidence = validateEvidence(value.evidence);
  const artifact = validateArtifact(value.artifact, build);
  if (sourceDateEpoch > Math.floor(issuedAt.getTime() / 1000)) {
    throw new Error("[manifest] SOURCE_DATE_EPOCH exceeds issue time");
  }
  return {
    ...value,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    source,
    build,
    trust,
    evidence,
    artifact,
  };
}

function validateSource(value, inventory) {
  const source = requireObject(value, "[manifest] source");
  exactKeys(
    source,
    [
      "commitSha",
      "gitTreeSha",
      "sourceArchiveSha256",
      "cargoLockSha256",
      "bunLockSha256",
      "packageJsonSha256",
      "moduleInventorySha256",
      "moduleCount",
      "moduleBytes",
    ],
    "[manifest] source",
  );
  requireToken(source.commitSha, GIT_SHA_PATTERN, "[manifest] source commit");
  requireToken(source.gitTreeSha, GIT_SHA_PATTERN, "[manifest] Git tree");
  for (const field of [
    "sourceArchiveSha256",
    "cargoLockSha256",
    "bunLockSha256",
    "packageJsonSha256",
    "moduleInventorySha256",
  ]) {
    requireSha256(source[field], `[manifest] source ${field}`);
  }
  requireExact(
    source.moduleInventorySha256,
    inventory.digestSha256,
    "[manifest] module inventory digest",
  );
  requireExact(
    source.moduleCount,
    inventory.moduleCount,
    "[manifest] module count",
  );
  requireExact(
    source.moduleBytes,
    inventory.moduleBytes,
    "[manifest] module bytes",
  );
  for (const [field, modulePath] of [
    ["cargoLockSha256", "Cargo.lock"],
    ["bunLockSha256", "bun.lock"],
    ["packageJsonSha256", "package.json"],
  ]) {
    requireExact(
      source[field],
      inventory.byPath.get(modulePath).sha256,
      `[manifest] ${modulePath} digest`,
    );
  }
  return source;
}

function validateBuild(value) {
  const build = requireObject(value, "[manifest] build");
  exactKeys(
    build,
    [
      "targetTriple",
      "profile",
      "rustcVersion",
      "cargoVersion",
      "bunVersion",
      "buildArgumentsSha256",
      "buildEnvironmentAllowlistSha256",
      "runnerBuildSha256",
      "firstBuildSha256",
      "secondBuildSha256",
      "reproducibleBuildSha256",
      "twoBuildsIdentical",
    ],
    "[manifest] build",
  );
  requireEnum(build.targetTriple, TARGETS, "[manifest] target triple");
  requireExact(build.profile, "release", "[manifest] build profile");
  for (const field of ["rustcVersion", "cargoVersion", "bunVersion"]) {
    requireBoundedAscii(build[field], 1, 256, `[manifest] ${field}`);
  }
  for (const field of [
    "buildArgumentsSha256",
    "buildEnvironmentAllowlistSha256",
    "runnerBuildSha256",
    "firstBuildSha256",
    "secondBuildSha256",
    "reproducibleBuildSha256",
  ]) {
    requireSha256(build[field], `[manifest] build ${field}`);
  }
  requireExact(
    build.twoBuildsIdentical,
    true,
    "[manifest] two-build reproducibility",
  );
  if (
    new Set([
      build.runnerBuildSha256,
      build.firstBuildSha256,
      build.secondBuildSha256,
      build.reproducibleBuildSha256,
    ]).size !== 1
  ) {
    throw new Error("[manifest] repeated build digests differ");
  }
  return build;
}

function validateTrust(value, policy, policySha256) {
  const trust = requireObject(value, "[manifest] trust");
  exactKeys(
    trust,
    [
      "trustConfigSha256",
      "releasePolicySha256",
      "releaseKeySpkiSha256",
      "authorityOrigin",
      "authorityVersionId",
      "permitSpkiSha256",
    ],
    "[manifest] trust",
  );
  for (const field of [
    "trustConfigSha256",
    "releasePolicySha256",
    "releaseKeySpkiSha256",
    "permitSpkiSha256",
  ]) {
    requireSha256(trust[field], `[manifest] trust ${field}`);
  }
  requireExact(
    trust.releasePolicySha256,
    policySha256,
    "[manifest] release policy digest",
  );
  requireExact(
    trust.releaseKeySpkiSha256,
    policy.releaseKeySpkiSha256,
    "[manifest] release key SPKI fingerprint",
  );
  if (
    trust.permitSpkiSha256 === policy.releaseKeySpkiSha256 ||
    !policy.forbiddenKeySpkiSha256.includes(trust.permitSpkiSha256)
  ) {
    throw new Error(
      "[manifest] permit key must be present in the release-key separation inventory",
    );
  }
  requireExact(
    trust.authorityOrigin,
    STAGING_AUTHORITY_ORIGIN,
    "[manifest] Authority origin",
  );
  requireToken(
    trust.authorityVersionId,
    VERSION_ID_PATTERN,
    "[manifest] Authority version",
  );
  return trust;
}

function validateEvidence(value) {
  const evidence = requireObject(value, "[manifest] evidence");
  exactKeys(
    evidence,
    [
      "testEvidenceSha256",
      "faultEvidenceSha256",
      "securityEvidenceSha256",
      "noSecretEvidenceSha256",
    ],
    "[manifest] evidence",
  );
  for (const field of Object.keys(evidence)) {
    requireSha256(evidence[field], `[manifest] evidence ${field}`);
  }
  return evidence;
}

function validateArtifact(value, build) {
  const artifact = requireObject(value, "[manifest] artifact");
  exactKeys(
    artifact,
    ["fileName", "byteLength", "sha256"],
    "[manifest] artifact",
  );
  const expectedName =
    build.targetTriple === "x86_64-pc-windows-msvc"
      ? `${RELEASE_ARTIFACT_BASENAME}.exe`
      : RELEASE_ARTIFACT_BASENAME;
  requireExact(artifact.fileName, expectedName, "[manifest] artifact file name");
  requireInteger(
    artifact.byteLength,
    1,
    MAX_ARTIFACT_BYTES,
    "[manifest] artifact byte length",
  );
  requireSha256(artifact.sha256, "[manifest] artifact digest");
  requireExact(
    artifact.sha256,
    build.runnerBuildSha256,
    "[manifest] runner/artifact digest",
  );
  return artifact;
}

function validateModuleInventory(value) {
  const inventory = requireObject(value, "[inventory]");
  exactKeys(
    inventory,
    ["schemaVersion", "contract", "files"],
    "[inventory]",
  );
  requireExact(inventory.schemaVersion, 1, "[inventory] schema version");
  requireExact(
    inventory.contract,
    RING_TRANSITION_RUNNER_MODULE_INVENTORY_CONTRACT,
    "[inventory] contract",
  );
  if (
    !Array.isArray(inventory.files) ||
    inventory.files.length < REQUIRED_MODULE_PATHS.length ||
    inventory.files.length > MAX_INVENTORY_FILES
  ) {
    throw new Error("[inventory] file count is invalid");
  }
  const byPath = new Map();
  let previousPath = null;
  let moduleBytes = 0;
  for (const [index, candidate] of inventory.files.entries()) {
    const record = requireObject(candidate, `[inventory] file ${index}`);
    exactKeys(
      record,
      ["path", "byteLength", "sha256"],
      `[inventory] file ${index}`,
    );
    validateModulePath(record.path, `[inventory] file ${index} path`);
    if (previousPath !== null && record.path <= previousPath) {
      throw new Error("[inventory] paths must be sorted and unique");
    }
    previousPath = record.path;
    requireInteger(
      record.byteLength,
      1,
      MAX_INVENTORY_BYTES,
      `[inventory] file ${index} byte length`,
    );
    requireSha256(record.sha256, `[inventory] file ${index} digest`);
    moduleBytes += record.byteLength;
    if (moduleBytes > MAX_INVENTORY_BYTES) {
      throw new Error("[inventory] total bytes exceed the bound");
    }
    byPath.set(record.path, record);
  }
  for (const requiredPath of REQUIRED_MODULE_PATHS) {
    if (!byPath.has(requiredPath)) {
      throw new Error(`[inventory] required path missing: ${requiredPath}`);
    }
  }
  return {
    moduleCount: inventory.files.length,
    moduleBytes,
    digestSha256: sha256Hex(
      Buffer.from(canonicalJson(inventory), "utf8"),
    ),
    byPath,
  };
}

function validateModulePath(value, label) {
  if (
    typeof value !== "string" ||
    !MODULE_PATH_PATTERN.test(value) ||
    value.includes("\\") ||
    value.includes("//") ||
    value.startsWith("/") ||
    value.endsWith("/")
  ) {
    throw new Error(`${label} is invalid`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "." || part === "..")) {
    throw new Error(`${label} escapes the source root`);
  }
  return value;
}

function parseCanonicalPayload(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("[manifest] DSSE payload must be valid UTF-8");
  }
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw new Error("[manifest] DSSE payload must be valid JSON");
  }
  if (text !== canonicalJson(manifest)) {
    throw new Error("[manifest] DSSE payload must be canonical JSON");
  }
  return manifest;
}

function importEd25519PublicKey(policy) {
  const spki = decodeBase64Url(
    policy.releaseKeySpkiBase64url,
    "[policy] release key SPKI",
    32,
    512,
  );
  let key;
  try {
    key = createPublicKey({
      key: spki,
      format: "der",
      type: "spki",
    });
  } catch {
    throw new Error("[policy] release public key is invalid");
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("[policy] release public key must be Ed25519");
  }
  return key;
}

async function readBoundedRegularFile(file, label, maximumBytes) {
  const resolved = path.resolve(file);
  const initial = await lstat(resolved, { bigint: true }).catch(() => null);
  if (
    !initial ||
    !initial.isFile() ||
    initial.isSymbolicLink() ||
    initial.nlink !== 1n ||
    initial.size <= 0n ||
    initial.size > BigInt(maximumBytes)
  ) {
    throw new Error(`${label} must be a bounded regular non-linked file`);
  }
  let handle;
  try {
    handle = await open(resolved, "r");
  } catch {
    throw new Error(`${label} could not be opened`);
  }
  let bytes;
  let openedRealPath;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFileSnapshot(initial, opened)) {
      throw new Error(`${label} changed before it was opened`);
    }
    openedRealPath = await realpath(resolved);
    const realStats = await lstat(openedRealPath, { bigint: true });
    if (!sameFileIdentity(opened, realStats)) {
      throw new Error(`${label} real path changed before it was read`);
    }
    bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const finalStats = await lstat(resolved, { bigint: true }).catch(() => null);
    const finalRealPath = await realpath(resolved).catch(() => null);
    if (
      !finalStats ||
      !finalStats.isFile() ||
      finalStats.isSymbolicLink() ||
      finalStats.nlink !== 1n ||
      !sameFileSnapshot(opened, after) ||
      !sameFileSnapshot(opened, finalStats) ||
      bytes.length !== Number(opened.size) ||
      finalRealPath !== openedRealPath
    ) {
      throw new Error(`${label} changed while it was read`);
    }
  } finally {
    await handle.close();
  }
  return { resolved, realPath: openedRealPath, bytes };
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(left, right) {
  return (
    sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function decodeBase64(value, label, minimumBytes, maximumBytes) {
  if (
    typeof value !== "string" ||
    !BASE64_PATTERN.test(value) ||
    value.length === 0
  ) {
    throw new Error(`${label} must be canonical padded base64`);
  }
  let bytes;
  try {
    bytes = Buffer.from(value, "base64");
  } catch {
    throw new Error(`${label} is invalid base64`);
  }
  if (
    bytes.length < minimumBytes ||
    bytes.length > maximumBytes ||
    bytes.toString("base64") !== value
  ) {
    throw new Error(`${label} has invalid canonical bytes`);
  }
  return bytes;
}

function decodeBase64Url(value, label, minimumBytes, maximumBytes) {
  if (
    typeof value !== "string" ||
    !BASE64URL_PATTERN.test(value) ||
    value.includes("=")
  ) {
    throw new Error(`${label} must be unpadded base64url`);
  }
  let bytes;
  try {
    bytes = Buffer.from(value, "base64url");
  } catch {
    throw new Error(`${label} is invalid base64url`);
  }
  if (
    bytes.length < minimumBytes ||
    bytes.length > maximumBytes ||
    bytes.toString("base64url") !== value
  ) {
    throw new Error(`${label} has invalid canonical bytes`);
  }
  return bytes;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireExact(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} mismatch`);
  return actual;
}

function requireToken(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requireSha256(value, label) {
  return requireToken(value, SHA256_PATTERN, label);
}

function requireEnum(value, allowed, label) {
  if (!allowed.includes(value)) throw new Error(`${label} is invalid`);
  return value;
}

function requireInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is out of range`);
  }
  return value;
}

function requireBoundedAscii(value, minimum, maximum, label) {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    !/^[\x20-\x7e]+$/.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requireDate(value, label) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`${label} must be a valid Date`);
  }
  return value;
}

function requireWholeSecondTimestamp(value, label) {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  const timestamp = new Date(value);
  if (
    Number.isNaN(timestamp.getTime()) ||
    timestamp.toISOString() !== value ||
    timestamp.getUTCMilliseconds() !== 0
  ) {
    throw new Error(`${label} must be a whole-second ISO timestamp`);
  }
  return timestamp;
}

function validateOptionalPin(value, label) {
  if (value !== null) requireSha256(value, label);
}
