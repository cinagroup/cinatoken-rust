import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  open,
  readdir,
  readFile,
  realpath,
} from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

import {
  canonicalJson,
  validateSigstoreBundle,
} from "./verify_container_runtime_provenance.mjs";

export const WORM_RETENTION_CONTRACT_VERSION = 2;
export const PROTOCOL_POLICY_CONTRACT =
  "cinatoken-container-runtime-worm-retention-protocol-policy-v2";
export const TRUST_POLICY_CONTRACT =
  "cinatoken-container-runtime-worm-retention-trust-policy-v2";
export const MANIFEST_CONTRACT =
  "cinatoken-container-runtime-worm-retention-manifest-v2";
export const EVIDENCE_CONTRACT =
  "cinatoken-container-runtime-worm-retention-evidence-v2";
export const ANCHOR_DOMAIN =
  "cinatoken-container-runtime-worm-retention-anchor-v2";

export const REQUIRED_APPROVAL_ROLES = Object.freeze([
  "operations",
  "security",
]);
export const REQUIRED_EVIDENCE_KINDS = Object.freeze([
  "authority-boundary",
  "lock-operator-revocation",
  "object-readback",
  "enforcement-probes",
  "publisher-revocation",
  "lock-readback",
]);
export const REQUIRED_AUTHORITY_ROLES = Object.freeze([
  "publisher",
  "lock-operator",
  "object-verifier",
  "lock-verifier",
  "lifecycle-operator",
  "lifecycle-verifier",
]);
export const REQUIRED_REVOCATION_TARGET_ROLES = Object.freeze([
  "lock-operator",
  "publisher",
]);
export const REQUIRED_OBJECT_KINDS = Object.freeze([
  "source-evidence-packet",
  "provenance-evidence-packet",
  "provenance-statement",
  "sigstore-bundle",
  "provenance-report",
  "cosign-verification-log",
]);

const EXPECTED_AUTHORITIES = Object.freeze([
  {
    role: "publisher",
    credentialType: "r2-object-read-write-api-token",
    scopeType: "r2-bucket-prefix",
    permissions: ["r2-object-read", "r2-object-write"],
    capabilities: {
      r2ObjectRead: true,
      r2ObjectWrite: true,
      r2LockRead: false,
      r2LockWrite: false,
      accountTokenRead: false,
      accountTokenEdit: false,
    },
  },
  {
    role: "lock-operator",
    credentialType: "cloudflare-r2-admin-read-write-api-token",
    scopeType: "r2-bucket-prefix",
    permissions: ["r2-admin-read-write"],
    capabilities: {
      r2ObjectRead: true,
      r2ObjectWrite: true,
      r2LockRead: true,
      r2LockWrite: true,
      accountTokenRead: false,
      accountTokenEdit: false,
    },
  },
  {
    role: "object-verifier",
    credentialType: "r2-object-read-api-token",
    scopeType: "r2-bucket-prefix",
    permissions: ["r2-object-read"],
    capabilities: {
      r2ObjectRead: true,
      r2ObjectWrite: false,
      r2LockRead: false,
      r2LockWrite: false,
      accountTokenRead: false,
      accountTokenEdit: false,
    },
  },
  {
    role: "lock-verifier",
    credentialType: "cloudflare-r2-admin-read-api-token",
    scopeType: "r2-bucket-prefix",
    permissions: ["r2-admin-read"],
    capabilities: {
      r2ObjectRead: true,
      r2ObjectWrite: false,
      r2LockRead: true,
      r2LockWrite: false,
      accountTokenRead: false,
      accountTokenEdit: false,
    },
  },
  {
    role: "lifecycle-operator",
    credentialType: "cloudflare-account-api-token-read-edit",
    scopeType: "cloudflare-account",
    permissions: ["account-api-token-read", "account-api-token-edit"],
    capabilities: {
      r2ObjectRead: false,
      r2ObjectWrite: false,
      r2LockRead: false,
      r2LockWrite: false,
      accountTokenRead: true,
      accountTokenEdit: true,
    },
  },
  {
    role: "lifecycle-verifier",
    credentialType: "cloudflare-account-api-token-read",
    scopeType: "cloudflare-account",
    permissions: ["account-api-token-read"],
    capabilities: {
      r2ObjectRead: false,
      r2ObjectWrite: false,
      r2LockRead: false,
      r2LockWrite: false,
      accountTokenRead: true,
      accountTokenEdit: false,
    },
  },
]);

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const PROTOCOL_POLICY_PATH = resolve(
  ROOT,
  "config/container-runtime-worm-retention-policy.json",
);
const PACKAGE_JSON_PATH = resolve(ROOT, "package.json");
const TEST_PATH = resolve(
  ROOT,
  "tests/container-runtime-worm-retention-gate.test.mjs",
);
const VERIFIER_PATH = fileURLToPath(import.meta.url);

const STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
const PREDICATE_TYPE = "https://slsa.dev/provenance/v1";
const BUILD_TYPE =
  "https://github.com/cinagroup/cinatoken-rust/blob/main/docs/container-runtime-provenance-build-type-v1.md";
const BUNDLE_MEDIA_TYPE = "application/vnd.dev.sigstore.bundle.v0.3+json";
const MINIMUM_RETENTION_SECONDS = 365 * 24 * 60 * 60;
const MAXIMUM_CREDENTIAL_REMAINING_SECONDS = 3_600;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_TRUST_POLICY_BYTES = 256 * 1024;
const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;
const MAX_OBJECT_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_OBJECT_BYTES = 768 * 1024 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 200_000;
const MAX_STRING_BYTES = 256 * 1024;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const BUCKET_PATTERN =
  /^(?=.{3,63}$)(?!.*\.\.)(?!\d{1,3}(?:\.\d{1,3}){3}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/;
const RULE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/;
const POLICY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const RFC3339_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const EVIDENCE_PATH_PATTERN =
  /^evidence\/[a-z0-9][a-z0-9-]{0,63}\.json$/;
const OBJECT_PATH_PATTERN =
  /^objects\/[a-z0-9][a-z0-9._-]{0,127}$/;

const OBJECT_FILE_NAMES = Object.freeze({
  "source-evidence-packet": "container-runtime-source-evidence.zip",
  "provenance-evidence-packet":
    "container-runtime-provenance-evidence.zip",
  "provenance-statement": "container-runtime.provenance.slsa.json",
  "sigstore-bundle": "container-runtime.provenance.sigstore.json",
  "provenance-report":
    "container-runtime-provenance-verification.json",
  "cosign-verification-log": "cosign-verification.log",
});
const OBJECT_CONTENT_TYPES = Object.freeze({
  "source-evidence-packet": "application/zip",
  "provenance-evidence-packet": "application/zip",
  "provenance-statement": "application/json",
  "sigstore-bundle": "application/json",
  "provenance-report": "application/json",
  "cosign-verification-log": "text/plain; charset=utf-8",
});

const PROVENANCE_SUBJECTS = Object.freeze([
  ["container-runtime.oci.tar", "archiveSha256"],
  ["container-runtime.oci.index.json", "ociIndexSha256"],
  ["container-runtime.oci.manifest.json", "ociManifestSha256"],
  ["container-runtime.oci.config.json", "ociConfigSha256"],
  [
    "usr/local/bin/cinatoken-container-runtime",
    "runtimeBinarySha256",
  ],
  ["container-runtime.sbom.syft.json", "sbomSha256"],
  [
    "container-runtime.vulnerabilities.grype.json",
    "vulnerabilityScanSha256",
  ],
]);

const MAX_RESPONSE_BYTES = 1024 * 1024;
const PROHIBITED_FIELD_NAMES = new Set([
  "accesskey",
  "accesskeyid",
  "apikey",
  "apitoken",
  "authorization",
  "clientsecret",
  "cookie",
  "headers",
  "password",
  "privatekey",
  "requestbody",
  "responsebody",
  "secret",
  "secretaccesskey",
  "setcookie",
  "token",
  "tokenvalue",
]);

export function parseArgs(argv) {
  const options = {
    selfTest: false,
    manifestPath: null,
    trustPolicyPath: null,
    now: null,
    json: false,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--self-test") {
      requireUnique(seen, argument);
      options.selfTest = true;
    } else if (argument === "--json") {
      requireUnique(seen, argument);
      options.json = true;
    } else if (
      argument === "--manifest" ||
      argument === "--trust-policy" ||
      argument === "--now"
    ) {
      requireUnique(seen, argument);
      const value = argv[index + 1];
      requireCondition(
        typeof value === "string" &&
          value.length > 0 &&
          !value.startsWith("--"),
        `${argument} requires a value`,
      );
      index += 1;
      if (argument === "--manifest") options.manifestPath = value;
      if (argument === "--trust-policy") options.trustPolicyPath = value;
      if (argument === "--now") options.now = value;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }

  if (options.selfTest) {
    requireCondition(
      options.manifestPath === null &&
        options.trustPolicyPath === null &&
        options.now === null,
      "--self-test cannot be combined with remote evidence inputs",
    );
  } else {
    requireCondition(
      options.manifestPath !== null && options.trustPolicyPath !== null,
      "--manifest and --trust-policy are required",
    );
    if (options.now !== null) {
      requireTimestamp(options.now, "--now");
    }
  }
  return options;
}

export async function auditRepositoryContract() {
  const [policyBytes, packageBytes, verifierSource, testSource] =
    await Promise.all([
      readFile(PROTOCOL_POLICY_PATH),
      readFile(PACKAGE_JSON_PATH),
      readFile(VERIFIER_PATH, "utf8"),
      readFile(TEST_PATH, "utf8"),
    ]);
  const policy = validateProtocolPolicy(
    parseJson(policyBytes, "protocol policy"),
  );
  const packageJson = parseJson(packageBytes, "package.json");
  const scripts = requireObject(packageJson.scripts, "package scripts");
  const expectedScript =
    'bun test --path-ignore-patterns="target/**" ' +
    "tests/container-runtime-worm-retention-gate.test.mjs && " +
    "node tools/verify_container_runtime_worm_retention.mjs " +
    "--self-test --json";
  requireCondition(
    scripts["check:container-runtime:worm-retention-contract"] ===
      expectedScript,
    "WORM retention package script drifted",
  );
  requireCondition(
    typeof scripts.check === "string" &&
      scripts.check.includes(
        "bun run check:container-runtime:worm-retention-contract",
      ),
    "aggregate check does not include WORM retention",
  );
  for (const fragment of [
    "verifyWormRetentionBundle",
    "validateProtocolPolicy",
    "validateLifecycleRevocation",
    "validateLockReadback",
    "validateEnforcementProbes",
    "verifyAnchorApprovals",
    "validateExactBundleLayout",
    "wormRetentionVerified: true",
    "productionCutoverAuthorized: false",
  ]) {
    requireCondition(
      verifierSource.includes(fragment),
      `WORM retention verifier is missing ${fragment}`,
    );
  }
  for (const fragment of [
    "rejects authority overlap",
    "rejects incomplete or ambiguous lifecycle revocation evidence",
    "rejects weak or mismatched lock evidence",
    "rejects ambiguous enforcement probes",
    "rejects stale evidence and forged approvals",
  ]) {
    requireCondition(
      testSource.includes(fragment),
      `WORM retention negative suite is missing ${fragment}`,
    );
  }

  return {
    contractVersion: WORM_RETENTION_CONTRACT_VERSION,
    status: "passed",
    reportKind: "container-runtime-worm-retention-contract-audit",
    policy: {
      contract: policy.contract,
      provider: policy.provider,
      prefixRoot: policy.prefixRoot,
      minimumRetentionSeconds: policy.minimumRetentionSeconds,
      maximumCredentialRemainingSeconds:
        policy.maximumCredentialRemainingSeconds,
      requiredApprovalRoles: policy.requiredApprovalRoles,
      requiredEvidenceKinds: policy.requiredEvidenceKinds,
      requiredAuthorityRoles: policy.requiredAuthorityRoles,
      requiredRevocationTargetRoles:
        policy.requiredRevocationTargetRoles,
      requiredObjectKinds: policy.requiredObjectKinds,
    },
    credentialFree: true,
    remoteEvidenceVerified: false,
    evidenceStorageMutationPerformed: false,
    s3CryptographicEvidence: false,
    wormRetentionVerified: false,
    s3Complete: false,
    registryDigestAuthorized: false,
    cloudflareDeploymentDigestVerified: false,
    p5Eligible: false,
    customerTrafficAuthorized: false,
    productionCutoverAuthorized: false,
  };
}

export function validateProtocolPolicy(value) {
  const policy = requireObject(value, "protocol policy");
  exactKeys(
    policy,
    [
      "schemaVersion",
      "contract",
      "repository",
      "environment",
      "enforcementProbePolicy",
      "provider",
      "prefixRoot",
      "minimumRetentionSeconds",
      "maximumClockSkewSeconds",
      "maximumManifestLifetimeSeconds",
      "maximumEvidenceAgeSeconds",
      "maximumCredentialRemainingSeconds",
      "requiredApprovalRoles",
      "requiredEvidenceKinds",
      "requiredAuthorityRoles",
      "requiredRevocationTargetRoles",
      "requiredObjectKinds",
      "supportedJurisdictions",
      "sourceWorkflow",
      "provenanceWorkflow",
      "provenanceCertificateIdentity",
      "provenanceOidcIssuer",
      "provenanceBuilderId",
      "cosignVersion",
      "cosignLinuxAmd64Sha256",
      "cloudflareBucketLockDocs",
      "cloudflareR2TokenDocs",
      "cloudflareS3ApiDocs",
    ],
    "protocol policy",
  );
  requireCondition(
    policy.schemaVersion === 2 &&
      policy.contract === PROTOCOL_POLICY_CONTRACT &&
      policy.repository === "cinagroup/cinatoken-rust" &&
      policy.environment === "staging" &&
      policy.provider === "cloudflare-r2" &&
      policy.prefixRoot === "container-runtime/s3/v1/" &&
      validEnforcementProbePolicy(policy.enforcementProbePolicy) &&
      policy.minimumRetentionSeconds === MINIMUM_RETENTION_SECONDS &&
      policy.maximumClockSkewSeconds === 300 &&
      policy.maximumManifestLifetimeSeconds === 1800 &&
      policy.maximumEvidenceAgeSeconds === 3600 &&
      policy.maximumCredentialRemainingSeconds ===
        MAXIMUM_CREDENTIAL_REMAINING_SECONDS &&
      sameJson(policy.requiredApprovalRoles, REQUIRED_APPROVAL_ROLES) &&
      sameJson(policy.requiredEvidenceKinds, REQUIRED_EVIDENCE_KINDS) &&
      sameJson(policy.requiredAuthorityRoles, REQUIRED_AUTHORITY_ROLES) &&
      sameJson(
        policy.requiredRevocationTargetRoles,
        REQUIRED_REVOCATION_TARGET_ROLES,
      ) &&
      sameJson(policy.requiredObjectKinds, REQUIRED_OBJECT_KINDS) &&
      sameJson(policy.supportedJurisdictions, [
        "default",
        "eu",
        "fedramp",
      ]) &&
      policy.sourceWorkflow ===
        ".github/workflows/container-runtime-oci.yml" &&
      policy.provenanceWorkflow ===
        ".github/workflows/container-runtime-provenance.yml" &&
      policy.provenanceCertificateIdentity ===
        "https://github.com/cinagroup/cinatoken-rust/.github/workflows/container-runtime-provenance.yml@refs/heads/main" &&
      policy.provenanceOidcIssuer ===
        "https://token.actions.githubusercontent.com" &&
      policy.provenanceBuilderId ===
        "https://github.com/actions/runner/github-hosted" &&
      policy.cosignVersion === "v3.1.2" &&
      policy.cosignLinuxAmd64Sha256 ===
        "f7622ed3cf22e55e1ae6377c080979ff77a22da9981c11df222a2e444991e7cf" &&
      policy.cloudflareBucketLockDocs ===
        "https://developers.cloudflare.com/r2/buckets/bucket-locks/" &&
      policy.cloudflareR2TokenDocs ===
        "https://developers.cloudflare.com/r2/api/tokens/" &&
      policy.cloudflareS3ApiDocs ===
        "https://developers.cloudflare.com/r2/api/s3/api/",
    "protocol policy identity drifted",
  );
  return policy;
}

function validEnforcementProbePolicy(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }
  try {
    exactKeys(
      value,
      [
        "publisherPreflight",
        "overwrite",
        "delete",
        "responseContentTypes",
        "requestIdSources",
      ],
      "enforcement probe policy",
    );
    for (const [name, status, code] of [
      ["publisherPreflight", 412, "PreconditionFailed"],
      ["overwrite", 403, "AccessDenied"],
      ["delete", 403, "AccessDenied"],
    ]) {
      const tuple = requireObject(
        value[name],
        `${name} probe policy`,
      );
      exactKeys(
        tuple,
        ["httpStatus", "errorCodes"],
        `${name} probe policy`,
      );
      if (
        tuple.httpStatus !== status ||
        !sameJson(tuple.errorCodes, [code])
      ) {
        return false;
      }
    }
    return (
      sameJson(value.responseContentTypes, ["application/xml"]) &&
      sameJson(value.requestIdSources, [
        "cf-ray",
        "x-amz-request-id",
      ])
    );
  } catch {
    return false;
  }
}

export async function verifyWormRetentionBundle({
  manifestPath,
  trustPolicyPath,
  now = new Date(),
}) {
  requireCondition(
    now instanceof Date && Number.isFinite(now.getTime()),
    "verifier now must be a valid Date",
  );
  const protocolBytes = await readFile(PROTOCOL_POLICY_PATH);
  const protocolPolicy = validateProtocolPolicy(
    parseJson(protocolBytes, "protocol policy"),
  );
  const protocolPolicySha256 = sha256Hex(
    Buffer.from(canonicalJson(protocolPolicy), "utf8"),
  );
  const manifestFile = await readCanonicalJson(
    manifestPath,
    "retention manifest",
    MAX_MANIFEST_BYTES,
  );
  const trustFile = await readCanonicalJson(
    trustPolicyPath,
    "retention trust policy",
    MAX_TRUST_POLICY_BYTES,
  );
  const manifestRoot = dirname(manifestFile.realPath);
  requireCondition(
    trustFile.realPath !== manifestRoot &&
      !isWithin(manifestRoot, trustFile.realPath),
    "trust policy must be outside the evidence bundle",
  );
  await validateExactBundleLayout(manifestRoot, manifestFile.realPath);
  rejectProhibitedFields(manifestFile.value, "retention manifest");
  rejectProhibitedFields(trustFile.value, "retention trust policy");

  const trust = validateTrustPolicy(
    trustFile.value,
    protocolPolicy,
    protocolPolicySha256,
    now,
  );
  const manifest = validateManifestEnvelope(
    manifestFile.value,
    protocolPolicy,
    trust,
    now,
  );
  const evidence = await readEvidenceRecords({
    records: manifest.subject.evidence,
    manifestRoot,
    subject: manifest.subject,
    trust,
    now,
  });
  const authority = validateAuthorityBoundary(
    evidence.get("authority-boundary"),
    manifest.subject,
  );
  const lockOperatorRevocation = validateLifecycleRevocation(
    evidence.get("lock-operator-revocation"),
    manifest.subject,
    authority,
    "lock-operator",
  );
  const objects = await validateObjectReadback(
    evidence.get("object-readback"),
    manifestRoot,
    manifest.subject,
    authority,
  );
  const probes = validateEnforcementProbes(
    evidence.get("enforcement-probes"),
    manifest.subject,
    objects,
    authority,
    protocolPolicy.enforcementProbePolicy,
  );
  const publisherRevocation = validateLifecycleRevocation(
    evidence.get("publisher-revocation"),
    manifest.subject,
    authority,
    "publisher",
  );
  const lock = validateLockReadback(
    evidence.get("lock-readback"),
    manifest.subject,
    trust,
    objects,
    probes,
    authority,
  );
  validateEvidenceOrdering(
    evidence,
    authority,
    lockOperatorRevocation,
    objects,
    probes,
    publisherRevocation,
    lock,
    manifest.subject,
  );
  const provenance = validateRetainedProvenance({
    objects,
    subject: manifest.subject,
    protocolPolicy,
  });
  const approvalRoles = verifyAnchorApprovals(
    manifest,
    trust,
    manifest.subjectDigestSha256,
  );
  await validateExactBundleLayout(manifestRoot, manifestFile.realPath);

  return {
    contractVersion: WORM_RETENTION_CONTRACT_VERSION,
    status: "passed",
    reportKind: "container-runtime-worm-retention-verification",
    decision: {
      scope: "cloudflare-r2-bucket-lock-retention-only",
      s3CryptographicEvidence: true,
      immutableRetentionEvidence: true,
      s3Decision: "complete",
      registryDecision: "not-authorized",
      cloudflareRuntimeDecision: "not-authorized",
      productionDecision: "not-authorized",
    },
    repository: manifest.subject.repository,
    commit: manifest.subject.commitSha,
    ceremonyId: manifest.subject.ceremonyId,
    policyId: trust.policyId,
    subjectDigestSha256: manifest.subjectDigestSha256,
    target: {
      provider: manifest.subject.provider,
      accountIdSha256: manifest.subject.accountIdSha256,
      bucketName: manifest.subject.bucketName,
      jurisdiction: manifest.subject.jurisdiction,
      prefix: manifest.subject.prefix,
    },
    provenance: {
      sourceRunId: manifest.subject.provenance.sourceRunId,
      signerRunId: manifest.subject.provenance.signerRunId,
      statementSha256: provenance.statementSha256,
      bundleSha256: provenance.bundleSha256,
      transparencyLogIndex: provenance.transparencyLogIndex,
      signedTimestampCount: provenance.signedTimestampCount,
      exactSubjectBindingVerified: true,
    },
    retention: {
      mechanism: "cloudflare-r2-bucket-lock-api",
      ruleId: lock.rule.id,
      condition: lock.rule.condition,
      configuredAt: lock.configuredAt,
      observedAt: lock.observedAt,
      minimumRetentionUntil: lock.minimumRetentionUntil,
      indefinite: lock.indefinite,
      objectCount: objects.records.length,
      objectReadbackVerified: true,
      overwriteRejectedByProvider: true,
      deleteRejectedByProvider: true,
      postProbeObjectUnchanged: true,
    },
    authority: {
      separated: true,
      secretMaterialCaptured: false,
      permissionInventoriesReviewed: true,
      lifecycleAuthoritySeparatedFromR2: true,
      lockOperatorRevocationVerified: true,
      publisherRevocationVerified: true,
      writeCredentialsRevokedBeforeDecision: true,
      approvalRoles,
    },
    evidenceStorageMutationVerified: true,
    applicationRemoteMutationAuthorized: false,
    imageSignatureVerified: false,
    wormRetentionVerified: true,
    s3Complete: true,
    canonicalContainerImageDigest: null,
    registryDigestAuthorized: false,
    registryReadbackVerified: false,
    cloudflareDeploymentDigestVerified: false,
    p5Eligible: false,
    customerTrafficAuthorized: false,
    productionCutoverAuthorized: false,
  };
}

export function validateTrustPolicy(
  value,
  protocol,
  protocolPolicySha256,
  now,
) {
  const policy = requireObject(value, "trust policy");
  exactKeys(
    policy,
    [
      "schemaVersion",
      "contract",
      "policyId",
      "protocolPolicySha256",
      "repository",
      "environment",
      "provider",
      "target",
      "minimumRetentionSeconds",
      "maximumClockSkewSeconds",
      "maximumManifestLifetimeSeconds",
      "maximumEvidenceAgeSeconds",
      "requiredApprovalRoles",
      "keys",
    ],
    "trust policy",
  );
  requireCondition(
    policy.schemaVersion === 2 &&
      policy.contract === TRUST_POLICY_CONTRACT &&
      POLICY_ID_PATTERN.test(policy.policyId) &&
      policy.protocolPolicySha256 === protocolPolicySha256 &&
      policy.repository === protocol.repository &&
      policy.environment === protocol.environment &&
      policy.provider === protocol.provider &&
      Number.isSafeInteger(policy.minimumRetentionSeconds) &&
      policy.minimumRetentionSeconds >= protocol.minimumRetentionSeconds &&
      Number.isSafeInteger(policy.maximumClockSkewSeconds) &&
      policy.maximumClockSkewSeconds > 0 &&
      policy.maximumClockSkewSeconds <=
        protocol.maximumClockSkewSeconds &&
      Number.isSafeInteger(policy.maximumManifestLifetimeSeconds) &&
      policy.maximumManifestLifetimeSeconds > 0 &&
      policy.maximumManifestLifetimeSeconds <=
        protocol.maximumManifestLifetimeSeconds &&
      Number.isSafeInteger(policy.maximumEvidenceAgeSeconds) &&
      policy.maximumEvidenceAgeSeconds > 0 &&
      policy.maximumEvidenceAgeSeconds <=
        protocol.maximumEvidenceAgeSeconds &&
      sameJson(policy.requiredApprovalRoles, REQUIRED_APPROVAL_ROLES),
    "trust policy boundary drifted",
  );
  const target = requireObject(policy.target, "trust policy target");
  exactKeys(
    target,
    [
      "accountIdSha256",
      "bucketName",
      "jurisdiction",
      "prefixRoot",
    ],
    "trust policy target",
  );
  requireSha256(target.accountIdSha256, "trust account digest");
  requireCondition(
    BUCKET_PATTERN.test(target.bucketName) &&
      protocol.supportedJurisdictions.includes(target.jurisdiction) &&
      target.prefixRoot === protocol.prefixRoot,
    "trust policy target is invalid",
  );
  requireCondition(
    Array.isArray(policy.keys) &&
      policy.keys.length >= REQUIRED_APPROVAL_ROLES.length &&
      policy.keys.length <= 16,
    "trust policy keyring size is invalid",
  );
  const keyIds = new Set();
  const publicKeys = new Set();
  const roles = new Set();
  const keyring = new Map();
  for (const entry of policy.keys) {
    const key = requireObject(entry, "trust policy key");
    exactKeys(
      key,
      [
        "keyId",
        "role",
        "algorithm",
        "publicKeySpkiBase64",
        "notBefore",
        "notAfter",
      ],
      "trust policy key",
    );
    requireCondition(
      KEY_ID_PATTERN.test(key.keyId) &&
        REQUIRED_APPROVAL_ROLES.includes(key.role) &&
        key.algorithm === "ed25519" &&
        validBase64(key.publicKeySpkiBase64, 32, 4096),
      "trust policy key identity is invalid",
    );
    const notBefore = requireTimestamp(key.notBefore, "key notBefore");
    const notAfter = requireTimestamp(key.notAfter, "key notAfter");
    requireCondition(
      notBefore < notAfter &&
        now.getTime() >=
          notBefore.getTime() - policy.maximumClockSkewSeconds * 1000 &&
        now.getTime() <=
          notAfter.getTime() + policy.maximumClockSkewSeconds * 1000,
      "trust policy key is outside its validity window",
    );
    requireCondition(
      !keyIds.has(key.keyId) &&
        !publicKeys.has(key.publicKeySpkiBase64),
      "trust policy keyring contains a duplicate identity",
    );
    let publicKey;
    try {
      publicKey = createPublicKey({
        key: Buffer.from(key.publicKeySpkiBase64, "base64"),
        format: "der",
        type: "spki",
      });
    } catch {
      throw new Error("trust policy public key is malformed");
    }
    requireCondition(
      publicKey.asymmetricKeyType === "ed25519",
      "trust policy key is not Ed25519",
    );
    keyIds.add(key.keyId);
    publicKeys.add(key.publicKeySpkiBase64);
    roles.add(key.role);
    keyring.set(key.keyId, { ...key, publicKey });
  }
  requireCondition(
    sameJson([...roles].sort(), REQUIRED_APPROVAL_ROLES),
    "trust policy does not cover every approval role",
  );
  return { ...policy, target, keyring };
}

function validateManifestEnvelope(value, protocol, trust, now) {
  const manifest = requireObject(value, "retention manifest");
  exactKeys(
    manifest,
    [
      "schemaVersion",
      "contract",
      "subject",
      "subjectDigestSha256",
      "approvals",
    ],
    "retention manifest",
  );
  requireCondition(
    manifest.schemaVersion === 2 && manifest.contract === MANIFEST_CONTRACT,
    "retention manifest identity drifted",
  );
  const subject = validateManifestSubject(
    manifest.subject,
    protocol,
    trust,
    now,
  );
  const digest = sha256Hex(Buffer.from(canonicalJson(subject), "utf8"));
  requireCondition(
    manifest.subjectDigestSha256 === digest,
    "retention manifest subject digest mismatch",
  );
  requireCondition(
    Array.isArray(manifest.approvals),
    "retention manifest approvals must be an array",
  );
  return { ...manifest, subject };
}

function validateManifestSubject(value, protocol, trust, now) {
  const subject = requireObject(value, "retention subject");
  exactKeys(
    subject,
    [
      "environment",
      "repository",
      "commitSha",
      "ceremonyId",
      "generatedAt",
      "expiresAt",
      "provider",
      "accountIdSha256",
      "bucketName",
      "jurisdiction",
      "prefix",
      "policyId",
      "provenance",
      "evidence",
    ],
    "retention subject",
  );
  requireCondition(
    subject.environment === protocol.environment &&
      subject.repository === protocol.repository &&
      GIT_SHA_PATTERN.test(subject.commitSha) &&
      UUID_PATTERN.test(subject.ceremonyId) &&
      subject.provider === protocol.provider &&
      subject.accountIdSha256 === trust.target.accountIdSha256 &&
      subject.bucketName === trust.target.bucketName &&
      subject.jurisdiction === trust.target.jurisdiction &&
      subject.policyId === trust.policyId,
    "retention subject identity drifted",
  );
  const generatedAt = requireTimestamp(
    subject.generatedAt,
    "manifest generatedAt",
  );
  const expiresAt = requireTimestamp(
    subject.expiresAt,
    "manifest expiresAt",
  );
  const skewMs = trust.maximumClockSkewSeconds * 1000;
  requireCondition(
    generatedAt < expiresAt &&
      expiresAt.getTime() - generatedAt.getTime() <=
        trust.maximumManifestLifetimeSeconds * 1000 &&
      generatedAt.getTime() <= now.getTime() + skewMs &&
      expiresAt.getTime() >= now.getTime() - skewMs,
    "retention manifest validity window is invalid",
  );
  const provenance = validateProvenanceIdentity(
    subject.provenance,
    subject.commitSha,
  );
  requireCondition(
    subject.prefix ===
      `${trust.target.prefixRoot}${provenance.statementSha256}/`,
    "retention prefix is not content-addressed by the statement",
  );
  requireCondition(
    Array.isArray(subject.evidence) &&
      subject.evidence.length === REQUIRED_EVIDENCE_KINDS.length,
    "retention evidence inventory is incomplete",
  );
  const kinds = subject.evidence.map((entry) => entry?.kind);
  requireCondition(
    sameJson(kinds, REQUIRED_EVIDENCE_KINDS),
    "retention evidence order or kind drifted",
  );
  const paths = new Set();
  for (const record of subject.evidence) {
    validateEvidenceRecord(record, paths);
  }
  return { ...subject, provenance };
}

function validateProvenanceIdentity(value, commitSha) {
  const provenance = requireObject(value, "retained provenance identity");
  exactKeys(
    provenance,
    [
      "sourceRunId",
      "signerRunId",
      "sourceArtifactSha256",
      "provenanceArtifactSha256",
      "statementSha256",
      "bundleSha256",
      "subject",
    ],
    "retained provenance identity",
  );
  requireCondition(
    Number.isSafeInteger(provenance.sourceRunId) &&
      provenance.sourceRunId > 0 &&
      Number.isSafeInteger(provenance.signerRunId) &&
      provenance.signerRunId > 0 &&
      provenance.sourceRunId !== provenance.signerRunId,
    "retained provenance run identities are invalid",
  );
  for (const field of [
    "sourceArtifactSha256",
    "provenanceArtifactSha256",
    "statementSha256",
    "bundleSha256",
  ]) {
    requireSha256(provenance[field], `retained provenance ${field}`);
  }
  const subject = requireObject(
    provenance.subject,
    "retained provenance subject",
  );
  exactKeys(
    subject,
    [
      "archiveSha256",
      "ociIndexSha256",
      "ociManifestSha256",
      "ociConfigSha256",
      "runtimeBinarySha256",
      "sbomSha256",
      "vulnerabilityScanSha256",
    ],
    "retained provenance subject",
  );
  for (const field of Object.keys(subject)) {
    requireSha256(subject[field], `retained subject ${field}`);
  }
  requireCondition(GIT_SHA_PATTERN.test(commitSha), "commit SHA is invalid");
  return { ...provenance, subject };
}

function validateEvidenceRecord(recordValue, paths) {
  const record = requireObject(recordValue, "evidence record");
  exactKeys(
    record,
    ["kind", "path", "bytes", "sha256", "capturedAt", "expiresAt"],
    "evidence record",
  );
  requireCondition(
    REQUIRED_EVIDENCE_KINDS.includes(record.kind) &&
      record.path === `evidence/${record.kind}.json` &&
      EVIDENCE_PATH_PATTERN.test(record.path) &&
      Number.isSafeInteger(record.bytes) &&
      record.bytes > 0 &&
      record.bytes <= MAX_EVIDENCE_BYTES,
    "evidence record identity is invalid",
  );
  requireSha256(record.sha256, `${record.kind} evidence digest`);
  requireTimestamp(record.capturedAt, `${record.kind} capturedAt`);
  requireTimestamp(record.expiresAt, `${record.kind} expiresAt`);
  requireCondition(!paths.has(record.path), "evidence path is duplicated");
  paths.add(record.path);
}

async function readEvidenceRecords({
  records,
  manifestRoot,
  subject,
  trust,
  now,
}) {
  const result = new Map();
  for (const record of records) {
    const file = await readCanonicalJson(
      boundedBundlePath(manifestRoot, record.path, EVIDENCE_PATH_PATTERN),
      `${record.kind} evidence`,
      MAX_EVIDENCE_BYTES,
    );
    requireCondition(
      isWithin(manifestRoot, file.realPath) &&
      file.bytes.length === record.bytes &&
        sha256Hex(file.bytes) === record.sha256,
      `${record.kind} evidence digest or size mismatch`,
    );
    rejectProhibitedFields(file.value, `${record.kind} evidence`);
    const envelope = validateEvidenceEnvelope(
      file.value,
      record.kind,
      subject,
      trust,
      now,
    );
    requireCondition(
      envelope.capturedAt === record.capturedAt &&
        envelope.expiresAt === record.expiresAt,
      `${record.kind} evidence time binding drifted`,
    );
    result.set(record.kind, envelope);
  }
  return result;
}

function validateEvidenceEnvelope(value, expectedKind, subject, trust, now) {
  const evidence = requireObject(value, `${expectedKind} evidence`);
  exactKeys(
    evidence,
    [
      "schemaVersion",
      "contract",
      "kind",
      "ceremonyId",
      "capturedAt",
      "expiresAt",
      "status",
      "facts",
    ],
    `${expectedKind} evidence`,
  );
  requireCondition(
    evidence.schemaVersion === 2 &&
      evidence.contract === EVIDENCE_CONTRACT &&
      evidence.kind === expectedKind &&
      evidence.ceremonyId === subject.ceremonyId &&
      evidence.status === "pass",
    `${expectedKind} evidence identity drifted`,
  );
  const capturedAt = requireTimestamp(
    evidence.capturedAt,
    `${expectedKind} capturedAt`,
  );
  const expiresAt = requireTimestamp(
    evidence.expiresAt,
    `${expectedKind} expiresAt`,
  );
  const generatedAt = requireTimestamp(
    subject.generatedAt,
    "manifest generatedAt",
  );
  const subjectExpiresAt = requireTimestamp(
    subject.expiresAt,
    "manifest expiresAt",
  );
  const skewMs = trust.maximumClockSkewSeconds * 1000;
  requireCondition(
    capturedAt < expiresAt &&
      capturedAt.getTime() <= generatedAt.getTime() &&
      generatedAt.getTime() - capturedAt.getTime() <=
        trust.maximumEvidenceAgeSeconds * 1000 &&
      capturedAt.getTime() <= now.getTime() + skewMs &&
      expiresAt.getTime() >= subjectExpiresAt.getTime(),
    `${expectedKind} evidence validity window is invalid`,
  );
  requireObject(evidence.facts, `${expectedKind} facts`);
  return evidence;
}

function validateAuthorityBoundary(evidence, subject) {
  const facts = evidence.facts;
  exactKeys(
    facts,
    [
      "accountIdSha256",
      "bucketName",
      "prefix",
      "secretMaterialCaptured",
      "allCredentialIdsDistinct",
      "permissionInventoriesReviewed",
      "authorities",
    ],
    "authority-boundary facts",
  );
  requireTarget(facts, subject, "authority-boundary");
  requireCondition(
    facts.secretMaterialCaptured === false &&
      facts.allCredentialIdsDistinct === true &&
      facts.permissionInventoriesReviewed === true &&
      Array.isArray(facts.authorities) &&
      facts.authorities.length === EXPECTED_AUTHORITIES.length,
    "authority boundary is not least privilege",
  );
  const capturedAtDate = requireTimestamp(
    evidence.capturedAt,
    "authority evidence time",
  );
  const credentialIds = new Set();
  const byRole = new Map();
  for (let index = 0; index < EXPECTED_AUTHORITIES.length; index += 1) {
    const authority = requireObject(
      facts.authorities[index],
      "authority identity",
    );
    exactKeys(
      authority,
      [
        "role",
        "credentialType",
        "credentialIdSha256",
        "scopeType",
        "accountIdSha256",
        "bucketName",
        "prefix",
        "permissions",
        "capabilities",
        "expiresAt",
      ],
      "authority identity",
    );
    const wanted = EXPECTED_AUTHORITIES[index];
    const r2Scoped = wanted.scopeType === "r2-bucket-prefix";
    requireCondition(
      authority.role === wanted.role &&
        authority.credentialType === wanted.credentialType &&
        authority.scopeType === wanted.scopeType &&
        authority.accountIdSha256 === subject.accountIdSha256 &&
        (r2Scoped
          ? authority.bucketName === subject.bucketName &&
            authority.prefix === subject.prefix
          : authority.bucketName === null && authority.prefix === null) &&
        sameJson(authority.permissions, wanted.permissions) &&
        sameJson(authority.capabilities, wanted.capabilities),
      `authority ${wanted.role} capability drifted`,
    );
    requireSha256(
      authority.credentialIdSha256,
      `${wanted.role} credential digest`,
    );
    requireCondition(
      !credentialIds.has(authority.credentialIdSha256),
      "authority credentials are not distinct",
    );
    credentialIds.add(authority.credentialIdSha256);
    const expiresAt = requireTimestamp(
      authority.expiresAt,
      `${wanted.role} credential expiry`,
    );
    requireCondition(
      expiresAt >=
        requireTimestamp(subject.expiresAt, "manifest expiry") &&
        expiresAt > capturedAtDate &&
        expiresAt.getTime() - capturedAtDate.getTime() <=
          MAXIMUM_CREDENTIAL_REMAINING_SECONDS * 1_000,
      `${wanted.role} credential lifetime is invalid`,
    );
    byRole.set(wanted.role, {
      ...authority,
      expiresAtDate: expiresAt,
    });
  }
  return {
    byRole,
    capturedAtDate,
  };
}

function validateLifecycleRevocation(
  evidence,
  subject,
  authority,
  targetRole,
) {
  const expectedKind = `${targetRole}-revocation`;
  requireCondition(
    evidence.kind === expectedKind,
    `${targetRole} lifecycle evidence kind drifted`,
  );
  const facts = evidence.facts;
  exactKeys(
    facts,
    [
      "accountIdSha256",
      "bucketName",
      "prefix",
      "targetRole",
      "targetCredentialIdSha256",
      "lifecycleOperatorCredentialIdSha256",
      "lifecycleVerifierCredentialIdSha256",
      "apiSurface",
      "targetBindingSha256",
      "predecessorReceiptFileSha256",
      "revokeReceiptFileSha256",
      "verifyReceiptFileSha256",
      "operatorSelfVerifiedAt",
      "deletion",
      "operatorReadback",
      "verifierSelfVerifiedAt",
      "independentReadback",
      "targetAbsenceIndependentlyObserved",
    ],
    `${targetRole} lifecycle facts`,
  );
  requireTarget(facts, subject, `${targetRole} lifecycle`);
  const targetAuthority = authority.byRole.get(targetRole);
  const lifecycleOperator = authority.byRole.get("lifecycle-operator");
  const lifecycleVerifier = authority.byRole.get("lifecycle-verifier");
  requireCondition(
    targetAuthority !== undefined &&
      lifecycleOperator !== undefined &&
      lifecycleVerifier !== undefined &&
      facts.targetRole === targetRole &&
      facts.targetCredentialIdSha256 ===
        targetAuthority.credentialIdSha256 &&
      facts.lifecycleOperatorCredentialIdSha256 ===
        lifecycleOperator.credentialIdSha256 &&
      facts.lifecycleVerifierCredentialIdSha256 ===
        lifecycleVerifier.credentialIdSha256 &&
      facts.apiSurface === "cloudflare-account-token-api" &&
      facts.targetAbsenceIndependentlyObserved === true,
    `${targetRole} lifecycle authority binding drifted`,
  );
  const targetBindingSha256 = sha256Hex(
    Buffer.from(
      canonicalJson({
        apiSurface: facts.apiSurface,
        accountIdSha256: subject.accountIdSha256,
        targetCredentialIdSha256:
          targetAuthority.credentialIdSha256,
      }),
      "utf8",
    ),
  );
  requireCondition(
    facts.targetBindingSha256 === targetBindingSha256,
    `${targetRole} lifecycle target binding drifted`,
  );
  const receiptDigests = [
    facts.predecessorReceiptFileSha256,
    facts.revokeReceiptFileSha256,
    facts.verifyReceiptFileSha256,
  ];
  for (const [index, digest] of receiptDigests.entries()) {
    requireSha256(
      digest,
      `${targetRole} lifecycle receipt digest ${index}`,
    );
  }
  requireCondition(
    new Set(receiptDigests).size === receiptDigests.length,
    `${targetRole} lifecycle receipt digests are not distinct`,
  );

  const deletion = requireObject(
    facts.deletion,
    `${targetRole} deletion`,
  );
  exactKeys(
    deletion,
    [
      "at",
      "httpStatus",
      "providerRequestId",
      "responseBodySha256",
      "resultIdSha256",
    ],
    `${targetRole} deletion`,
  );
  const operatorReadback = requireObject(
    facts.operatorReadback,
    `${targetRole} operator readback`,
  );
  exactKeys(
    operatorReadback,
    [
      "at",
      "httpStatus",
      "providerRequestId",
      "responseBodySha256",
      "errorCodes",
    ],
    `${targetRole} operator readback`,
  );
  const independentReadback = requireObject(
    facts.independentReadback,
    `${targetRole} independent readback`,
  );
  exactKeys(
    independentReadback,
    [
      "at",
      "httpStatus",
      "providerRequestId",
      "responseBodySha256",
      "errorCodes",
    ],
    `${targetRole} independent readback`,
  );
  const operatorSelfVerifiedAt = requireTimestamp(
    facts.operatorSelfVerifiedAt,
    `${targetRole} lifecycle operator verification`,
  );
  const deletedAt = requireTimestamp(
    deletion.at,
    `${targetRole} deletion time`,
  );
  const operatorReadbackAt = requireTimestamp(
    operatorReadback.at,
    `${targetRole} operator readback time`,
  );
  const verifierSelfVerifiedAt = requireTimestamp(
    facts.verifierSelfVerifiedAt,
    `${targetRole} lifecycle verifier verification`,
  );
  const independentReadbackAt = requireTimestamp(
    independentReadback.at,
    `${targetRole} independent readback time`,
  );
  const capturedAt = requireTimestamp(
    evidence.capturedAt,
    `${targetRole} lifecycle evidence time`,
  );
  requireCondition(
    operatorSelfVerifiedAt < deletedAt &&
      deletedAt < operatorReadbackAt &&
      operatorReadbackAt < verifierSelfVerifiedAt &&
      verifierSelfVerifiedAt < independentReadbackAt &&
      independentReadbackAt.getTime() === capturedAt.getTime() &&
      operatorReadbackAt < lifecycleOperator.expiresAtDate &&
      independentReadbackAt < lifecycleVerifier.expiresAtDate &&
      lifecycleOperator.expiresAtDate.getTime() -
        operatorSelfVerifiedAt.getTime() <=
        MAXIMUM_CREDENTIAL_REMAINING_SECONDS * 1_000 &&
      lifecycleVerifier.expiresAtDate.getTime() -
        verifierSelfVerifiedAt.getTime() <=
        MAXIMUM_CREDENTIAL_REMAINING_SECONDS * 1_000,
    `${targetRole} lifecycle chronology is invalid`,
  );
  requireCondition(
    deletion.httpStatus === 200 &&
      deletion.resultIdSha256 ===
        targetAuthority.credentialIdSha256 &&
      OPAQUE_ID_PATTERN.test(deletion.providerRequestId) &&
      SHA256_PATTERN.test(deletion.responseBodySha256) &&
      operatorReadback.httpStatus === 404 &&
      OPAQUE_ID_PATTERN.test(operatorReadback.providerRequestId) &&
      SHA256_PATTERN.test(operatorReadback.responseBodySha256) &&
      independentReadback.httpStatus === 404 &&
      OPAQUE_ID_PATTERN.test(
        independentReadback.providerRequestId,
      ) &&
      SHA256_PATTERN.test(
        independentReadback.responseBodySha256,
      ) &&
      validLifecycleErrorCodes(operatorReadback.errorCodes) &&
      validLifecycleErrorCodes(independentReadback.errorCodes) &&
      sameJson(
        operatorReadback.errorCodes,
        independentReadback.errorCodes,
      ) &&
      new Set([
        deletion.providerRequestId,
        operatorReadback.providerRequestId,
        independentReadback.providerRequestId,
      ]).size === 3,
    `${targetRole} lifecycle provider evidence is invalid`,
  );
  return {
    targetRole,
    operatorSelfVerifiedAt,
    deletedAt,
    operatorReadbackAt,
    verifierSelfVerifiedAt,
    independentReadbackAt,
    capturedAt,
  };
}

function validLifecycleErrorCodes(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 32 &&
    value.every(
      (entry) => Number.isSafeInteger(entry) && entry >= 0,
    ) &&
    new Set(value).size === value.length
  );
}

async function validateObjectReadback(
  evidence,
  manifestRoot,
  subject,
  authority,
) {
  const facts = evidence.facts;
  exactKeys(
    facts,
    [
      "accountIdSha256",
      "bucketName",
      "jurisdiction",
      "prefix",
      "objectVerifierCredentialIdSha256",
      "baselineObservedAt",
      "baselinePaginationComplete",
      "preexistingObjectCount",
      "multipartUploadCount",
      "unknownObjectCount",
      "finalPaginationComplete",
      "createOnlyWritesVerified",
      "awsS3ObjectLockHeadersUsed",
      "objects",
    ],
    "object-readback facts",
  );
  requireTarget(facts, subject, "object-readback", true);
  const objectVerifier = authority.byRole.get("object-verifier");
  requireCondition(
    objectVerifier !== undefined &&
      facts.objectVerifierCredentialIdSha256 ===
        objectVerifier.credentialIdSha256 &&
      facts.baselinePaginationComplete === true &&
      facts.preexistingObjectCount === 0 &&
      facts.multipartUploadCount === 0 &&
      facts.unknownObjectCount === 0 &&
      facts.finalPaginationComplete === true &&
      facts.createOnlyWritesVerified === true &&
      facts.awsS3ObjectLockHeadersUsed === false &&
      Array.isArray(facts.objects) &&
      facts.objects.length === REQUIRED_OBJECT_KINDS.length,
    "object readback inventory is incomplete",
  );
  const baselineObservedAt = requireTimestamp(
    facts.baselineObservedAt,
    "object baseline time",
  );
  const records = [];
  const byKind = new Map();
  let totalBytes = 0;
  for (let index = 0; index < REQUIRED_OBJECT_KINDS.length; index += 1) {
    const expectedKind = REQUIRED_OBJECT_KINDS[index];
    const record = validateObjectRecord(
      facts.objects[index],
      expectedKind,
      subject,
    );
    requireCondition(
      baselineObservedAt <= record.uploadedAtDate,
      `${expectedKind} was uploaded before the empty baseline`,
    );
    const file = await readStableFile(
      boundedBundlePath(
        manifestRoot,
        record.path,
        OBJECT_PATH_PATTERN,
      ),
      `${expectedKind} retained object`,
      MAX_OBJECT_BYTES,
      true,
    );
    totalBytes += file.bytes.length;
    requireCondition(
      isWithin(manifestRoot, file.realPath) &&
      totalBytes <= MAX_TOTAL_OBJECT_BYTES,
      "retained objects exceed their aggregate byte bound",
    );
    requireCondition(
      file.bytes.length === record.bytes &&
        sha256Hex(file.bytes) === record.sha256,
      `${expectedKind} local readback digest or size mismatch`,
    );
    records.push({ ...record, bytesValue: file.bytes });
    byKind.set(expectedKind, { ...record, bytesValue: file.bytes });
  }
  return { records, byKind, baselineObservedAt };
}

function validateObjectRecord(value, expectedKind, subject) {
  const record = requireObject(value, `${expectedKind} object record`);
  exactKeys(
    record,
    [
      "kind",
      "path",
      "key",
      "bytes",
      "sha256",
      "etag",
      "contentType",
      "uploadedAt",
      "uploadHttpStatus",
      "uploadRequestId",
      "readBackAt",
      "httpStatus",
      "providerRequestId",
      "customMetadata",
    ],
    `${expectedKind} object record`,
  );
  const fileName = OBJECT_FILE_NAMES[expectedKind];
  requireCondition(
    record.kind === expectedKind &&
      record.path === `objects/${fileName}` &&
      OBJECT_PATH_PATTERN.test(record.path) &&
      record.key === `${subject.prefix}${fileName}` &&
      record.contentType === OBJECT_CONTENT_TYPES[expectedKind] &&
      Number.isSafeInteger(record.bytes) &&
      record.bytes > 0 &&
      record.bytes <= MAX_OBJECT_BYTES &&
      Number.isSafeInteger(record.uploadHttpStatus) &&
      record.uploadHttpStatus >= 200 &&
      record.uploadHttpStatus <= 299 &&
      OPAQUE_ID_PATTERN.test(record.uploadRequestId) &&
      typeof record.etag === "string" &&
      record.etag.length > 0 &&
      record.etag.length <= 256 &&
      record.httpStatus === 200 &&
      OPAQUE_ID_PATTERN.test(record.providerRequestId),
    `${expectedKind} object identity or readback is invalid`,
  );
  requireSha256(record.sha256, `${expectedKind} object digest`);
  const uploadedAtDate = requireTimestamp(
    record.uploadedAt,
    `${expectedKind} uploadedAt`,
  );
  const readBackAtDate = requireTimestamp(
    record.readBackAt,
    `${expectedKind} readBackAt`,
  );
  requireCondition(
    uploadedAtDate <= readBackAtDate,
    `${expectedKind} readback predates upload`,
  );
  const metadata = requireObject(
    record.customMetadata,
    `${expectedKind} custom metadata`,
  );
  exactKeys(
    metadata,
    ["contract", "repositoryCommit", "sha256"],
    `${expectedKind} custom metadata`,
  );
  requireCondition(
    metadata.contract === MANIFEST_CONTRACT &&
      metadata.repositoryCommit === subject.commitSha &&
      metadata.sha256 === record.sha256,
    `${expectedKind} custom metadata drifted`,
  );
  return { ...record, uploadedAtDate, readBackAtDate };
}

export function validateEnforcementProbes(
  evidence,
  subject,
  objects,
  authority,
  policy,
) {
  const facts = evidence.facts;
  exactKeys(
    facts,
    [
      "accountIdSha256",
      "bucketName",
      "jurisdiction",
      "prefix",
      "publisherCredentialIdSha256",
      "objectVerifierCredentialIdSha256",
      "targetObjectKind",
      "targetKey",
      "originalSha256",
      "originalBytes",
      "publisherPreflight",
      "overwrite",
      "delete",
      "finalReadback",
    ],
    "enforcement-probes facts",
  );
  requireTarget(facts, subject, "enforcement-probes", true);
  const publisher = authority.byRole.get("publisher");
  const objectVerifier = authority.byRole.get("object-verifier");
  requireCondition(
    publisher !== undefined &&
      objectVerifier !== undefined &&
      facts.publisherCredentialIdSha256 ===
        publisher.credentialIdSha256 &&
      facts.objectVerifierCredentialIdSha256 ===
        objectVerifier.credentialIdSha256,
    "enforcement probe credential binding drifted",
  );
  const target = objects.byKind.get("provenance-evidence-packet");
  requireCondition(
    facts.targetObjectKind === "provenance-evidence-packet" &&
      facts.targetKey === target.key &&
      facts.originalSha256 === target.sha256 &&
      facts.originalBytes === target.bytes,
    "enforcement probe target drifted",
  );
  const publisherPreflight = validateProbeOperation(
    facts.publisherPreflight,
    "put-object-create-only-preflight",
    target,
    policy.publisherPreflight,
    policy,
    "If-None-Match:*",
  );
  const overwrite = validateProbeOperation(
    facts.overwrite,
    "put-object",
    target,
    policy.overwrite,
    policy,
  );
  const deletion = validateProbeOperation(
    facts.delete,
    "delete-object",
    target,
    policy.delete,
    policy,
  );
  requireCondition(
    publisherPreflight.attemptedBytes > 0 &&
      publisherPreflight.completedAtDate <
        overwrite.attemptedAtDate &&
      overwrite.attemptedSha256 !== target.sha256 &&
      overwrite.attemptedBytes > 0 &&
      overwrite.completedAtDate < deletion.attemptedAtDate,
    "overwrite probe did not attempt different content",
  );
  const finalReadback = requireObject(
    facts.finalReadback,
    "post-probe readback",
  );
  exactKeys(
    finalReadback,
    [
      "readBackAt",
      "httpStatus",
      "providerRequestId",
      "bytes",
      "sha256",
      "etag",
    ],
    "post-probe readback",
  );
  const readBackAt = requireTimestamp(
    finalReadback.readBackAt,
    "post-probe readback time",
  );
  const capturedAt = requireTimestamp(
    evidence.capturedAt,
    "enforcement probe evidence time",
  );
  requireCondition(
    finalReadback.httpStatus === 200 &&
      OPAQUE_ID_PATTERN.test(finalReadback.providerRequestId) &&
      finalReadback.bytes === target.bytes &&
      finalReadback.sha256 === target.sha256 &&
      finalReadback.etag === target.etag &&
      readBackAt > overwrite.completedAtDate &&
      readBackAt > deletion.completedAtDate &&
      capturedAt >= readBackAt &&
      new Set([
        publisherPreflight.providerRequestId,
        overwrite.providerRequestId,
        deletion.providerRequestId,
        finalReadback.providerRequestId,
      ]).size === 4,
    "post-probe object readback drifted",
  );
  return {
    publisherPreflight,
    overwrite,
    deletion,
    finalReadback: { ...finalReadback, readBackAtDate: readBackAt },
  };
}

function validateProbeOperation(
  value,
  expectedOperation,
  target,
  rejectionPolicy,
  policy,
  condition = null,
) {
  const probe = requireObject(value, `${expectedOperation} probe`);
  exactKeys(
    probe,
    [
      "operation",
      ...(condition === null ? [] : ["condition"]),
      "attemptedAt",
      "completedAt",
      "attemptedBytes",
      "attemptedSha256",
      "transportCompleted",
      "timedOut",
      "clientSideOnly",
      "providerRejected",
      "httpStatus",
      "errorCode",
      "providerRequestId",
      "requestIdSource",
      "responseContentType",
      "responseBytes",
      "responseBodySha256",
    ],
    `${expectedOperation} probe`,
  );
  const attemptedAtDate = requireTimestamp(
    probe.attemptedAt,
    `${expectedOperation} attemptedAt`,
  );
  const completedAtDate = requireTimestamp(
    probe.completedAt,
    `${expectedOperation} completedAt`,
  );
  requireCondition(
    probe.operation === expectedOperation &&
      (condition === null || probe.condition === condition) &&
      Number.isSafeInteger(probe.attemptedBytes) &&
      probe.attemptedBytes >= 0 &&
      attemptedAtDate < completedAtDate &&
      probe.transportCompleted === true &&
      probe.timedOut === false &&
      probe.clientSideOnly === false &&
      probe.providerRejected === true &&
      probe.httpStatus === rejectionPolicy.httpStatus &&
      rejectionPolicy.errorCodes.includes(probe.errorCode) &&
      OPAQUE_ID_PATTERN.test(probe.providerRequestId) &&
      policy.requestIdSources.includes(probe.requestIdSource) &&
      policy.responseContentTypes.includes(
        probe.responseContentType,
      ) &&
      Number.isSafeInteger(probe.responseBytes) &&
      probe.responseBytes > 0 &&
      probe.responseBytes <= MAX_RESPONSE_BYTES &&
      attemptedAtDate >= target.readBackAtDate,
    `${expectedOperation} was not an unambiguous provider rejection`,
  );
  requireSha256(
    probe.attemptedSha256,
    `${expectedOperation} attempted digest`,
  );
  requireSha256(
    probe.responseBodySha256,
    `${expectedOperation} response digest`,
  );
  if (expectedOperation === "delete-object") {
    requireCondition(
      probe.attemptedBytes === 0 &&
        probe.attemptedSha256 === target.sha256,
      "delete probe target binding drifted",
    );
  }
  return { ...probe, attemptedAtDate, completedAtDate };
}

export function validateLockReadback(
  evidence,
  subject,
  trust,
  objects,
  probes,
  authority,
) {
  const facts = evidence.facts;
  exactKeys(
    facts,
    [
      "mechanism",
      "awsS3ObjectLockHeadersUsed",
      "accountIdSha256",
      "bucketName",
      "jurisdiction",
      "prefix",
      "lockVerifierCredentialIdSha256",
      "configuredAt",
      "configurationRequestId",
      "observedAt",
      "readbackRequestId",
      "httpStatus",
      "selectedRuleId",
      "rules",
    ],
    "lock-readback facts",
  );
  requireTarget(facts, subject, "lock-readback", true);
  const lockVerifier = authority.byRole.get("lock-verifier");
  const configuredAt = requireTimestamp(
    facts.configuredAt,
    "lock configuredAt",
  );
  const observedAt = requireTimestamp(
    facts.observedAt,
    "lock observedAt",
  );
  requireCondition(
    lockVerifier !== undefined &&
      facts.lockVerifierCredentialIdSha256 ===
        lockVerifier.credentialIdSha256 &&
      facts.mechanism === "cloudflare-r2-bucket-lock-api" &&
      facts.awsS3ObjectLockHeadersUsed === false &&
      OPAQUE_ID_PATTERN.test(facts.configurationRequestId) &&
      OPAQUE_ID_PATTERN.test(facts.readbackRequestId) &&
      facts.configurationRequestId !== facts.readbackRequestId &&
      facts.httpStatus === 200 &&
      RULE_ID_PATTERN.test(facts.selectedRuleId) &&
      facts.observedAt === evidence.capturedAt &&
      configuredAt <= observedAt &&
      Array.isArray(facts.rules) &&
      facts.rules.length >= 1 &&
      facts.rules.length <= 1000,
    "lock readback identity is invalid",
  );
  const ruleIds = new Set();
  let selected = null;
  for (const rawRule of facts.rules) {
    const rule = validateLockRule(rawRule);
    requireCondition(!ruleIds.has(rule.id), "lock rule ID is duplicated");
    ruleIds.add(rule.id);
    if (rule.id === facts.selectedRuleId) selected = rule;
  }
  requireCondition(
    selected !== null &&
      selected.enabled === true &&
      selected.prefix === subject.prefix,
    "selected lock rule is absent, disabled, or scoped incorrectly",
  );
  const earliestUpload = new Date(
    Math.min(...objects.records.map((record) => record.uploadedAtDate)),
  );
  requireCondition(
    configuredAt <= earliestUpload,
    "bucket lock was not configured before object publication",
  );
  const decisionTime = requireTimestamp(
    subject.generatedAt,
    "manifest generatedAt",
  );
  const minimumRequired = new Date(
    decisionTime.getTime() + trust.minimumRetentionSeconds * 1000,
  );
  let minimumRetentionUntil = null;
  let indefinite = false;
  if (selected.condition.type === "Indefinite") {
    indefinite = true;
  } else if (selected.condition.type === "Date") {
    const until = requireTimestamp(
      selected.condition.date,
      "lock retention date",
    );
    requireCondition(
      until >= minimumRequired,
      "date lock does not meet the minimum remaining retention",
    );
    minimumRetentionUntil = until.toISOString();
  } else {
    const deadlines = objects.records.map(
      (record) =>
        new Date(
          record.uploadedAtDate.getTime() +
            selected.condition.maxAgeSeconds * 1000,
        ),
    );
    const earliestDeadline = new Date(
      Math.min(...deadlines.map((deadline) => deadline.getTime())),
    );
    requireCondition(
      earliestDeadline >= minimumRequired,
      "age lock does not meet the minimum remaining retention",
    );
    minimumRetentionUntil = earliestDeadline.toISOString();
  }
  requireCondition(
    observedAt >= probes.finalReadback.readBackAtDate,
    "final lock readback predates the enforcement probes",
  );
  return {
    configuredAt: facts.configuredAt,
    observedAt: facts.observedAt,
    rule: selected,
    minimumRetentionUntil,
    indefinite,
  };
}

function validateLockRule(value) {
  const rule = requireObject(value, "bucket lock rule");
  exactKeys(
    rule,
    ["id", "condition", "enabled", "prefix"],
    "bucket lock rule",
  );
  requireCondition(
    RULE_ID_PATTERN.test(rule.id) &&
      typeof rule.enabled === "boolean" &&
      typeof rule.prefix === "string" &&
      rule.prefix.length <= 512,
    "bucket lock rule identity is invalid",
  );
  const condition = requireObject(rule.condition, "bucket lock condition");
  if (condition.type === "Age") {
    exactKeys(
      condition,
      ["type", "maxAgeSeconds"],
      "age lock condition",
    );
    requireCondition(
      Number.isSafeInteger(condition.maxAgeSeconds) &&
        condition.maxAgeSeconds > 0,
      "age lock duration is invalid",
    );
  } else if (condition.type === "Date") {
    exactKeys(condition, ["type", "date"], "date lock condition");
    requireTimestamp(condition.date, "date lock condition");
  } else if (condition.type === "Indefinite") {
    exactKeys(condition, ["type"], "indefinite lock condition");
  } else {
    throw new Error("bucket lock condition type is unsupported");
  }
  return rule;
}

function validateEvidenceOrdering(
  evidence,
  authority,
  lockOperatorRevocation,
  objects,
  probes,
  publisherRevocation,
  lock,
  subject,
) {
  const objectTime = requireTimestamp(
    evidence.get("object-readback").capturedAt,
    "object evidence time",
  );
  const probeTime = requireTimestamp(
    evidence.get("enforcement-probes").capturedAt,
    "probe evidence time",
  );
  const lockTime = requireTimestamp(
    evidence.get("lock-readback").capturedAt,
    "lock evidence time",
  );
  const generatedAt = requireTimestamp(
    subject.generatedAt,
    "manifest generatedAt",
  );
  const earliestUpload = new Date(
    Math.min(
      ...objects.records.map((record) =>
        record.uploadedAtDate.getTime(),
      ),
    ),
  );
  requireCondition(
    lockOperatorRevocation.operatorSelfVerifiedAt >=
      requireTimestamp(lock.configuredAt, "lock configuredAt") &&
      lockOperatorRevocation.independentReadbackAt < earliestUpload &&
      publisherRevocation.operatorSelfVerifiedAt >
        probes.overwrite.completedAtDate &&
      publisherRevocation.operatorSelfVerifiedAt >
        probes.deletion.completedAtDate &&
      publisherRevocation.independentReadbackAt <
        probes.finalReadback.readBackAtDate &&
      authority.capturedAtDate >= lockTime &&
      authority.capturedAtDate >=
        lockOperatorRevocation.capturedAt &&
      authority.capturedAtDate >= publisherRevocation.capturedAt &&
      authority.capturedAtDate <= generatedAt,
    "mutable ceremony credentials were not revoked in order",
  );
  requireCondition(
    objects.baselineObservedAt <=
      Math.min(...objects.records.map((record) => record.uploadedAtDate)) &&
      objectTime <= probeTime &&
      probeTime <= lockTime &&
      lockTime <= generatedAt &&
      probes.finalReadback.readBackAtDate <= lockTime &&
      requireTimestamp(lock.observedAt, "lock observedAt").getTime() ===
        lockTime.getTime(),
    "retention ceremony evidence ordering is invalid",
  );
}

function validateRetainedProvenance({
  objects,
  subject,
  protocolPolicy,
}) {
  const get = (kind) => {
    const value = objects.byKind.get(kind);
    requireCondition(value !== undefined, `missing ${kind} object`);
    return value;
  };
  const sourcePacket = get("source-evidence-packet");
  const provenancePacket = get("provenance-evidence-packet");
  const statementObject = get("provenance-statement");
  const bundleObject = get("sigstore-bundle");
  const reportObject = get("provenance-report");
  const cosignLogObject = get("cosign-verification-log");
  const expected = subject.provenance;
  requireCondition(
    sourcePacket.sha256 === expected.sourceArtifactSha256 &&
      provenancePacket.sha256 === expected.provenanceArtifactSha256 &&
      statementObject.sha256 === expected.statementSha256 &&
      bundleObject.sha256 === expected.bundleSha256,
    "retained provenance object identity drifted",
  );
  const statement = parseJson(
    statementObject.bytesValue,
    "retained provenance statement",
  );
  validateRetainedStatement(statement, expected, protocolPolicy);
  const bundle = parseJson(
    bundleObject.bytesValue,
    "retained Sigstore bundle",
  );
  const bundleFacts = validateSigstoreBundle(
    bundle,
    statementObject.bytesValue,
  );
  const report = parseJson(
    reportObject.bytesValue,
    "retained provenance report",
  );
  validateRetainedProvenanceReport({
    report,
    expected,
    subject,
    protocolPolicy,
    statementObject,
    bundleObject,
    bundleFacts,
    cosignLogObject,
  });
  requireCondition(
    cosignLogObject.bytesValue.equals(Buffer.from("Verified OK\n", "utf8")),
    "retained Cosign verification log is not the exact success record",
  );
  return {
    statementSha256: statementObject.sha256,
    bundleSha256: bundleObject.sha256,
    transparencyLogIndex: bundleFacts.transparencyLogIndex,
    signedTimestampCount: bundleFacts.signedTimestampCount,
  };
}

function validateRetainedStatement(statementValue, expected, protocol) {
  const statement = requireObject(
    statementValue,
    "retained provenance statement",
  );
  exactKeys(
    statement,
    ["_type", "predicate", "predicateType", "subject"],
    "retained provenance statement",
  );
  requireCondition(
    statement._type === STATEMENT_TYPE &&
      statement.predicateType === PREDICATE_TYPE &&
      Array.isArray(statement.subject) &&
      statement.subject.length === PROVENANCE_SUBJECTS.length,
    "retained provenance statement identity drifted",
  );
  for (let index = 0; index < PROVENANCE_SUBJECTS.length; index += 1) {
    const [name, field] = PROVENANCE_SUBJECTS[index];
    const entry = requireObject(
      statement.subject[index],
      "retained statement subject",
    );
    exactKeys(entry, ["name", "digest"], "retained statement subject");
    const digest = requireObject(
      entry.digest,
      "retained statement subject digest",
    );
    exactKeys(
      digest,
      ["sha256"],
      "retained statement subject digest",
    );
    requireCondition(
      entry.name === name && digest.sha256 === expected.subject[field],
      `retained provenance subject ${name} drifted`,
    );
  }
  const predicate = requireObject(
    statement.predicate,
    "retained provenance predicate",
  );
  exactKeys(
    predicate,
    ["buildDefinition", "runDetails"],
    "retained provenance predicate",
  );
  const definition = requireObject(
    predicate.buildDefinition,
    "retained build definition",
  );
  exactKeys(
    definition,
    [
      "buildType",
      "externalParameters",
      "internalParameters",
      "resolvedDependencies",
    ],
    "retained build definition",
  );
  const external = requireObject(
    definition.externalParameters,
    "retained external parameters",
  );
  exactKeys(
    external,
    ["repository", "ref", "eventName"],
    "retained external parameters",
  );
  const runDetails = requireObject(
    predicate.runDetails,
    "retained run details",
  );
  exactKeys(
    runDetails,
    ["builder", "byproducts", "metadata"],
    "retained run details",
  );
  const builder = requireObject(
    runDetails.builder,
    "retained builder",
  );
  exactKeys(builder, ["id"], "retained builder");
  requireObject(runDetails.metadata, "retained build metadata");
  requireCondition(
    Array.isArray(definition.resolvedDependencies) &&
      Array.isArray(runDetails.byproducts),
    "retained provenance dependencies or byproducts are invalid",
  );
  requireCondition(
    definition.buildType === BUILD_TYPE &&
      external.repository === protocol.repository &&
      external.ref === "refs/heads/main" &&
      ["push", "workflow_dispatch"].includes(external.eventName) &&
      builder.id === protocol.provenanceBuilderId,
    "retained provenance build definition drifted",
  );
}

function validateRetainedProvenanceReport({
  report,
  expected,
  subject,
  protocolPolicy,
  statementObject,
  bundleObject,
  bundleFacts,
  cosignLogObject,
}) {
  exactKeys(
    report,
    [
      "artifactAttestationVerified",
      "canonicalContainerImageDigest",
      "cloudflareDeploymentDigestVerified",
      "contractVersion",
      "customerTrafficAuthorized",
      "decision",
      "generatedProvenancePresent",
      "githubArtifactRetentionDays",
      "imageSignatureVerified",
      "p5Eligible",
      "productionCutoverAuthorized",
      "registryDigestAuthorized",
      "registryReadbackVerified",
      "remoteMutationAuthorized",
      "reportKind",
      "s3Complete",
      "signatureVerificationPerformed",
      "signedTimestampVerified",
      "signer",
      "sigstore",
      "source",
      "statement",
      "status",
      "subject",
      "transparencyLogVerified",
      "wormRetentionVerified",
    ],
    "retained provenance report",
  );
  requireCondition(
    report.contractVersion === 1 &&
      report.status === "passed" &&
      report.reportKind ===
        "container-runtime-provenance-verification" &&
      report.generatedProvenancePresent === true &&
      report.signatureVerificationPerformed === true &&
      report.artifactAttestationVerified === true &&
      report.imageSignatureVerified === false &&
      report.transparencyLogVerified === true &&
      report.signedTimestampVerified === true &&
      report.githubArtifactRetentionDays === 90 &&
      report.wormRetentionVerified === false &&
      report.s3Complete === false &&
      report.canonicalContainerImageDigest === null &&
      report.registryDigestAuthorized === false &&
      report.registryReadbackVerified === false &&
      report.cloudflareDeploymentDigestVerified === false &&
      report.p5Eligible === false &&
      report.remoteMutationAuthorized === false &&
      report.customerTrafficAuthorized === false &&
      report.productionCutoverAuthorized === false,
    "retained provenance report overclaims downstream authority",
  );
  const decision = requireObject(report.decision, "provenance decision");
  exactKeys(
    decision,
    [
      "formalP5Evidence",
      "immutableRetentionDecision",
      "productionDecision",
      "s3CryptographicEvidence",
      "s3Decision",
      "scope",
    ],
    "provenance decision",
  );
  requireCondition(
    decision.scope === "github-sigstore-provenance-only" &&
      decision.formalP5Evidence === false &&
      decision.s3CryptographicEvidence === true &&
      decision.immutableRetentionDecision === "not-verified" &&
      decision.s3Decision ===
        "cryptographic-subgate-passed-worm-pending" &&
      decision.productionDecision === "not-authorized",
    "retained provenance decision drifted",
  );
  const source = requireObject(report.source, "provenance source");
  exactKeys(
    source,
    [
      "commit",
      "event",
      "ref",
      "repository",
      "runAttempt",
      "runId",
      "workflow",
    ],
    "provenance source",
  );
  requireCondition(
    source.repository === protocolPolicy.repository &&
      source.workflow === protocolPolicy.sourceWorkflow &&
      source.runId === expected.sourceRunId &&
      Number.isSafeInteger(source.runAttempt) &&
      source.runAttempt > 0 &&
      ["push", "workflow_dispatch"].includes(source.event) &&
      source.ref === "refs/heads/main" &&
      source.commit === subject.commitSha,
    "retained provenance source binding drifted",
  );
  const signer = requireObject(report.signer, "provenance signer");
  exactKeys(
    signer,
    [
      "certificateIdentity",
      "certificateOidcIssuer",
      "commit",
      "cosignLinuxAmd64Sha256",
      "cosignVersion",
      "runAttempt",
      "runId",
      "workflow",
    ],
    "provenance signer",
  );
  requireCondition(
      signer.workflow === protocolPolicy.provenanceWorkflow &&
      signer.runId === expected.signerRunId &&
      Number.isSafeInteger(signer.runAttempt) &&
      signer.runAttempt > 0 &&
      signer.commit === subject.commitSha &&
      signer.cosignVersion === protocolPolicy.cosignVersion &&
      signer.cosignLinuxAmd64Sha256 ===
        protocolPolicy.cosignLinuxAmd64Sha256 &&
      signer.certificateIdentity ===
        protocolPolicy.provenanceCertificateIdentity &&
      signer.certificateOidcIssuer ===
        protocolPolicy.provenanceOidcIssuer,
    "retained provenance signer binding drifted",
  );
  const reportStatement = requireObject(
    report.statement,
    "provenance statement report",
  );
  exactKeys(
    reportStatement,
    [
      "buildType",
      "bytes",
      "canonicalJson",
      "exactByproductBindingVerified",
      "exactSubjectBindingVerified",
      "predicateType",
      "sha256",
      "type",
    ],
    "provenance statement report",
  );
  requireCondition(
    reportStatement.type === STATEMENT_TYPE &&
      reportStatement.predicateType === PREDICATE_TYPE &&
      reportStatement.buildType === BUILD_TYPE &&
      reportStatement.sha256 === statementObject.sha256 &&
      reportStatement.bytes === statementObject.bytes &&
      reportStatement.canonicalJson === true &&
      reportStatement.exactSubjectBindingVerified === true &&
      reportStatement.exactByproductBindingVerified === true,
    "retained statement report drifted",
  );
  const sigstore = requireObject(report.sigstore, "Sigstore report");
  exactKeys(
    sigstore,
    [
      "bundleBytes",
      "bundleMediaType",
      "bundleSha256",
      "certificateIdentityVerified",
      "certificateOidcIssuerVerified",
      "certificateTransparencySctVerified",
      "cosignVerificationLogBytes",
      "cosignVerificationLogSha256",
      "dssePayloadSha256",
      "githubWorkflowClaimsVerified",
      "inclusionPromisePresent",
      "inclusionProofPresent",
      "signatureCount",
      "signedTimestampCount",
      "signedTimestampVerified",
      "transparencyIntegratedTime",
      "transparencyLogIndex",
      "transparencyLogVerified",
    ],
    "Sigstore report",
  );
  requireCondition(
    sigstore.bundleMediaType === BUNDLE_MEDIA_TYPE &&
      sigstore.bundleSha256 === bundleObject.sha256 &&
      sigstore.bundleBytes === bundleObject.bytes &&
      sigstore.dssePayloadSha256 === statementObject.sha256 &&
      sigstore.signatureCount === 1 &&
      sigstore.certificateIdentityVerified === true &&
      sigstore.certificateOidcIssuerVerified === true &&
      sigstore.githubWorkflowClaimsVerified === true &&
      sigstore.certificateTransparencySctVerified === true &&
      sigstore.transparencyLogVerified === true &&
      sigstore.transparencyLogIndex ===
        bundleFacts.transparencyLogIndex &&
      sigstore.transparencyIntegratedTime ===
        bundleFacts.transparencyIntegratedTime &&
      sigstore.inclusionPromisePresent === true &&
      sigstore.inclusionProofPresent === true &&
      sigstore.signedTimestampVerified === true &&
      sigstore.signedTimestampCount ===
        bundleFacts.signedTimestampCount &&
      sigstore.cosignVerificationLogSha256 === cosignLogObject.sha256 &&
      sigstore.cosignVerificationLogBytes === cosignLogObject.bytes,
    "retained Sigstore report drifted",
  );
  const reportSubject = requireObject(
    report.subject,
    "provenance report subject",
  );
  exactKeys(
    reportSubject,
    [
      "archiveSha256",
      "ociConfigDigest",
      "ociIndexDigest",
      "ociManifestDigest",
      "runtimeBinarySha256",
      "sbomSha256",
      "vulnerabilityScanSha256",
    ],
    "provenance report subject",
  );
  requireCondition(
    reportSubject.archiveSha256 === expected.subject.archiveSha256 &&
      stripSha256(reportSubject.ociIndexDigest) ===
        expected.subject.ociIndexSha256 &&
      stripSha256(reportSubject.ociManifestDigest) ===
        expected.subject.ociManifestSha256 &&
      stripSha256(reportSubject.ociConfigDigest) ===
        expected.subject.ociConfigSha256 &&
      reportSubject.runtimeBinarySha256 ===
        expected.subject.runtimeBinarySha256 &&
      reportSubject.sbomSha256 === expected.subject.sbomSha256 &&
      reportSubject.vulnerabilityScanSha256 ===
        expected.subject.vulnerabilityScanSha256,
    "retained provenance report subject drifted",
  );
}

export function verifyAnchorApprovals(
  manifest,
  trust,
  subjectDigestSha256,
) {
  requireCondition(
    manifest.subject.policyId === trust.policyId &&
      Array.isArray(manifest.approvals) &&
      manifest.approvals.length === REQUIRED_APPROVAL_ROLES.length,
    "retention anchor approvals are incomplete",
  );
  const message = Buffer.from(
    `${ANCHOR_DOMAIN}\n${trust.policyId}\n${subjectDigestSha256}\n`,
    "utf8",
  );
  const roles = [];
  const keyIds = new Set();
  for (let index = 0; index < REQUIRED_APPROVAL_ROLES.length; index += 1) {
    const role = REQUIRED_APPROVAL_ROLES[index];
    const approval = requireObject(
      manifest.approvals[index],
      "retention anchor approval",
    );
    exactKeys(
      approval,
      ["role", "keyId", "algorithm", "signatureBase64Url"],
      "retention anchor approval",
    );
    requireCondition(
      approval.role === role &&
        approval.algorithm === "ed25519" &&
        KEY_ID_PATTERN.test(approval.keyId) &&
        !keyIds.has(approval.keyId) &&
        validBase64Url(approval.signatureBase64Url, 64, 64),
      `retention ${role} approval identity is invalid`,
    );
    const key = trust.keyring.get(approval.keyId);
    requireCondition(
      key?.role === role,
      `retention ${role} approval key is not trusted`,
    );
    const signature = Buffer.from(
      approval.signatureBase64Url,
      "base64url",
    );
    requireCondition(
      verifySignature(null, message, key.publicKey, signature),
      `retention ${role} approval signature is invalid`,
    );
    keyIds.add(approval.keyId);
    roles.push(role);
  }
  return roles;
}

function requireTarget(value, subject, label, includeJurisdiction = false) {
  requireCondition(
    value.accountIdSha256 === subject.accountIdSha256 &&
      value.bucketName === subject.bucketName &&
      value.prefix === subject.prefix &&
      (!includeJurisdiction ||
        value.jurisdiction === subject.jurisdiction),
    `${label} target drifted`,
  );
}

async function validateExactBundleLayout(
  manifestRoot,
  manifestRealPath,
) {
  requireCondition(
    basename(manifestRealPath) === "manifest.json",
    "retention bundle manifest must be named manifest.json",
  );
  const expectedManifest = await realpath(
    resolve(manifestRoot, "manifest.json"),
  ).catch(() => null);
  requireCondition(
    expectedManifest === manifestRealPath,
    "retention bundle manifest identity drifted",
  );
  await validateExactDirectory(
    manifestRoot,
    ["evidence", "manifest.json", "objects"],
    new Set(["evidence", "objects"]),
    "retention bundle root",
  );
  await validateExactDirectory(
    resolve(manifestRoot, "evidence"),
    REQUIRED_EVIDENCE_KINDS.map((kind) => `${kind}.json`),
    new Set(),
    "retention evidence directory",
  );
  await validateExactDirectory(
    resolve(manifestRoot, "objects"),
    Object.values(OBJECT_FILE_NAMES),
    new Set(),
    "retention object directory",
  );
}

async function validateExactDirectory(
  directory,
  expectedNames,
  expectedDirectories,
  label,
) {
  const directoryStat = await lstat(directory).catch(() => null);
  requireCondition(
    directoryStat?.isDirectory() && !directoryStat.isSymbolicLink(),
    `${label} must be a real directory`,
  );
  const entries = await readdir(directory, { withFileTypes: true });
  requireCondition(
    sameJson(
      entries.map((entry) => entry.name).sort(),
      [...expectedNames].sort(),
    ),
    `${label} layout drifted`,
  );
  for (const entry of entries) {
    const expectedDirectory = expectedDirectories.has(entry.name);
    requireCondition(
      !entry.isSymbolicLink() &&
        (expectedDirectory ? entry.isDirectory() : entry.isFile()),
      `${label} entry type drifted`,
    );
  }
}

async function readCanonicalJson(file, label, maxBytes) {
  const read = await readStableFile(file, label, maxBytes, true);
  const value = parseJson(read.bytes, label);
  auditJsonShape(value, label);
  const expected = `${canonicalJson(value)}\n`;
  requireCondition(
    read.bytes.equals(Buffer.from(expected, "utf8")),
    `${label} must use canonical JSON plus one newline`,
  );
  return { ...read, value };
}

async function readStableFile(file, label, maxBytes, requireSingleLink) {
  const requested = resolve(file);
  const initial = await lstat(requested, { bigint: true }).catch(
    () => null,
  );
  requireCondition(
    initial?.isFile() &&
      !initial.isSymbolicLink() &&
      initial.size > 0n &&
      initial.size <= BigInt(maxBytes) &&
      (!requireSingleLink || initial.nlink === 1n),
    `${label} must be a bounded regular single-link file`,
  );
  const handle = await open(
    requested,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat({ bigint: true });
    const bytes = await handle.readFile();
    const openedRealPath = await realpath(requested);
    const after = await handle.stat({ bigint: true });
    const final = await lstat(requested, { bigint: true }).catch(
      () => null,
    );
    const finalRealPath = await realpath(requested).catch(() => null);
    requireCondition(
      before.isFile() &&
        before.dev === after.dev &&
        before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeNs === after.mtimeNs &&
        BigInt(bytes.length) === before.size &&
        final?.dev === before.dev &&
        final?.ino === before.ino &&
        final?.size === before.size &&
        final?.mtimeNs === before.mtimeNs &&
        finalRealPath === openedRealPath,
      `${label} changed while reading`,
    );
    return { bytes, realPath: openedRealPath };
  } finally {
    await handle.close();
  }
}

function boundedBundlePath(root, value, pattern) {
  requireCondition(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= 256 &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      pattern.test(value),
    "bundle path is malformed",
  );
  const resolved = resolve(root, ...value.split("/"));
  const relativePath = relative(root, resolved);
  requireCondition(
    relativePath !== "" &&
      relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`),
    "bundle path escapes its root",
  );
  return resolved;
}

function isWithin(root, candidate) {
  const value = relative(root, candidate);
  return (
    value !== "" &&
    value !== ".." &&
    !value.startsWith(`..${sep}`)
  );
}

function auditJsonShape(value, label) {
  let nodes = 0;
  const visit = (entry, depth) => {
    nodes += 1;
    requireCondition(
      depth <= MAX_JSON_DEPTH && nodes <= MAX_JSON_NODES,
      `${label} exceeds JSON complexity bounds`,
    );
    if (typeof entry === "string") {
      requireCondition(
        Buffer.byteLength(entry, "utf8") <= MAX_STRING_BYTES,
        `${label} contains an oversized string`,
      );
    } else if (Array.isArray(entry)) {
      for (const item of entry) visit(item, depth + 1);
    } else if (entry !== null && typeof entry === "object") {
      for (const [key, item] of Object.entries(entry)) {
        requireCondition(
          Buffer.byteLength(key, "utf8") <= 256,
          `${label} contains an oversized key`,
        );
        visit(item, depth + 1);
      }
    } else {
      requireCondition(
        entry === null ||
          typeof entry === "boolean" ||
          typeof entry === "string" ||
          (typeof entry === "number" && Number.isFinite(entry)),
        `${label} contains an unsupported JSON value`,
      );
    }
  };
  visit(value, 0);
}

function rejectProhibitedFields(value, label) {
  const visit = (entry) => {
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
      return;
    }
    if (entry === null || typeof entry !== "object") return;
    for (const [key, item] of Object.entries(entry)) {
      const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
      requireCondition(
        !PROHIBITED_FIELD_NAMES.has(normalized),
        `${label} contains prohibited secret or payload field ${key}`,
      );
      visit(item);
    }
  };
  visit(value);
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    throw new Error(`${label} is not valid UTF-8 JSON`);
  }
}

function exactKeys(value, keys, label) {
  const actual = Object.keys(requireObject(value, label)).sort();
  const expected = [...keys].sort();
  requireCondition(
    sameJson(actual, expected),
    `${label} keys drifted`,
  );
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function requireObject(value, label) {
  requireCondition(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value;
}

function requireSha256(value, label) {
  requireCondition(
    typeof value === "string" && SHA256_PATTERN.test(value),
    `${label} is not a SHA-256 digest`,
  );
  return value;
}

function stripSha256(value) {
  requireCondition(
    typeof value === "string" &&
      value.startsWith("sha256:") &&
      SHA256_PATTERN.test(value.slice(7)),
    "OCI digest is malformed",
  );
  return value.slice(7);
}

function requireTimestamp(value, label) {
  const date =
    typeof value === "string" && RFC3339_PATTERN.test(value)
      ? new Date(value)
      : null;
  const expected =
    date !== null && Number.isFinite(date.getTime())
      ? value.includes(".")
        ? date.toISOString()
        : date.toISOString().replace(".000Z", "Z")
      : null;
  requireCondition(
    expected === value,
    `${label} is not a canonical UTC timestamp`,
  );
  return date;
}

function validBase64(value, minimumBytes, maximumBytes) {
  if (
    typeof value !== "string" ||
    value.length % 4 !== 0 ||
    !BASE64_PATTERN.test(value)
  ) {
    return false;
  }
  const bytes = Buffer.from(value, "base64");
  return (
    bytes.length >= minimumBytes &&
    bytes.length <= maximumBytes &&
    bytes.toString("base64") === value
  );
}

function validBase64Url(value, minimumBytes, maximumBytes) {
  if (
    typeof value !== "string" ||
    !BASE64URL_PATTERN.test(value) ||
    value.includes("=")
  ) {
    return false;
  }
  const bytes = Buffer.from(value, "base64url");
  return (
    bytes.length >= minimumBytes &&
    bytes.length <= maximumBytes &&
    bytes.toString("base64url") === value
  );
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireUnique(seen, argument) {
  requireCondition(!seen.has(argument), `duplicate argument: ${argument}`);
  seen.add(argument);
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let report;
  if (options.selfTest) {
    report = await auditRepositoryContract();
  } else {
    report = await verifyWormRetentionBundle({
      manifestPath: options.manifestPath,
      trustPolicyPath: options.trustPolicyPath,
      now:
        options.now === null ? new Date() : new Date(options.now),
    });
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(
      `container runtime WORM retention gate: ${report.status}\n`,
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(
      `container runtime WORM retention gate failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
