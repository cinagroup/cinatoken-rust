import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  BUILDKIT_IMAGE,
  runOciGate,
} from "./verify_container_runtime_oci.mjs";
import {
  DISTROLESS_RUNTIME_IMAGE,
  RUST_BUILDER_IMAGE,
  RUST_MUSL_TARGET_IMAGE,
} from "./verify_container_runtime_linux.mjs";
import {
  SYFT_IMAGE,
  runSbomGate,
} from "./verify_container_runtime_sbom.mjs";
import {
  GRYPE_DB_ARCHIVE_SHA256,
  GRYPE_DB_ARCHIVE_URL,
  GRYPE_DB_FILE_BYTES,
  GRYPE_DB_FILE_SHA256,
  GRYPE_DB_FILE_XXH64,
  GRYPE_IMAGE,
  GRYPE_IMAGE_AMD64_MANIFEST_DIGEST,
  GRYPE_IMAGE_INDEX_DIGEST,
  validateDatabaseImportMetadata,
  validateDatabaseListing,
  validateDatabaseMetadata,
  validateDatabaseStatus,
  validateGrypeScan,
  validateIndependentEvidenceBindings,
  validateInputSnapshots,
  validateSbomReport,
  validateScannerImageIdentity,
  validateVulnerabilityApprovals,
  validateVulnerabilityPolicy,
} from "./verify_container_runtime_vulnerabilities.mjs";

export const PROVENANCE_GATE_CONTRACT_VERSION = 1;
export const PROVENANCE_POLICY_CONTRACT =
  "cinatoken-container-runtime-provenance-policy-v1";
export const SIGSTORE_BUNDLE_MEDIA_TYPE =
  "application/vnd.dev.sigstore.bundle.v0.3+json";
export const DSSE_PAYLOAD_TYPE = "application/vnd.in-toto+json";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const WORKFLOW = resolve(
  ROOT,
  ".github/workflows/container-runtime-provenance.yml",
);
const SOURCE_WORKFLOW = resolve(
  ROOT,
  ".github/workflows/container-runtime-oci.yml",
);
const POLICY_PATH = resolve(
  ROOT,
  "config/container-runtime-provenance-policy.json",
);
const PACKAGE_JSON = resolve(ROOT, "package.json");
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;
const RFC3339_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.[0-9]{1,9})?Z$/;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_LOG_BYTES = 1024 * 1024;

const EVIDENCE_FILES = Object.freeze([
  ["container-runtime-a.tar", 512 * 1024 * 1024, "application/vnd.oci.image.layout.v1.tar"],
  ["container-runtime-b.tar", 512 * 1024 * 1024, "application/vnd.oci.image.layout.v1.tar"],
  ["container-runtime-oci-verification.json", MAX_JSON_BYTES, "application/json"],
  ["syft-image-inspect.json", MAX_JSON_BYTES, "application/json"],
  ["sbom-a/container-runtime.sbom.syft.json", 64 * 1024 * 1024, "application/vnd.syft+json"],
  ["sbom-b/container-runtime.sbom.syft.json", 64 * 1024 * 1024, "application/vnd.syft+json"],
  ["container-runtime-sbom-verification.json", MAX_JSON_BYTES, "application/json"],
  ["grype-image-index.json", MAX_JSON_BYTES, "application/json"],
  ["grype-image-inspect.json", MAX_JSON_BYTES, "application/json"],
  ["grype-db.tar.zst", 512 * 1024 * 1024, "application/zstd"],
  ["grype-db-status-a.json", MAX_JSON_BYTES, "application/json"],
  ["grype-db-status-b.json", MAX_JSON_BYTES, "application/json"],
  ["grype-db-a-archive-listing.txt", MAX_LOG_BYTES, "text/plain"],
  ["grype-db-b-archive-listing.txt", MAX_LOG_BYTES, "text/plain"],
  ["grype-db-a-inventory.txt", MAX_LOG_BYTES, "text/plain"],
  ["grype-db-b-inventory.txt", MAX_LOG_BYTES, "text/plain"],
  ["vulnerability-scan-inputs-before.txt", MAX_LOG_BYTES, "text/plain"],
  ["vulnerability-scan-inputs-after.txt", MAX_LOG_BYTES, "text/plain"],
  ["grype-db-a/6/import.json", MAX_JSON_BYTES, "application/json"],
  ["grype-db-b/6/import.json", MAX_JSON_BYTES, "application/json"],
  ["scan-a/container-runtime.vulnerabilities.grype.json", 128 * 1024 * 1024, "application/vnd.grype+json"],
  ["scan-b/container-runtime.vulnerabilities.grype.json", 128 * 1024 * 1024, "application/vnd.grype+json"],
  ["container-runtime-vulnerability-verification.json", MAX_JSON_BYTES, "application/json"],
]);

const SOURCE_DEPENDENCIES = Object.freeze([
  [".github/workflows/container-runtime-oci.yml", "application/yaml"],
  ["Cargo.lock", "text/plain"],
  ["crates/container-runtime/Dockerfile", "text/plain"],
  ["config/container-runtime-vulnerability-db.json", "application/json"],
  ["config/container-runtime-vulnerability-db-listing.json", "application/json"],
  ["config/container-runtime-vulnerability-policy.json", "application/json"],
  ["config/container-runtime-vulnerability-approvals.json", "application/json"],
  ["config/container-runtime-provenance-policy.json", "application/json"],
]);

export function parseArgs(argv) {
  const options = {
    selfTest: false,
    mode: null,
    evidenceDir: null,
    eventPath: null,
    statementPath: null,
    bundlePath: null,
    cosignVerificationLogPath: null,
    reportPath: null,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--self-test") {
      options.selfTest = true;
    } else if (argument === "--generate" || argument === "--verify") {
      requireCondition(options.mode === null, "select exactly one provenance mode");
      options.mode = argument.slice(2);
    } else if (argument === "--evidence-dir") {
      options.evidenceDir = argv[++index] ?? null;
    } else if (argument === "--event") {
      options.eventPath = argv[++index] ?? null;
    } else if (argument === "--statement") {
      options.statementPath = argv[++index] ?? null;
    } else if (argument === "--bundle") {
      options.bundlePath = argv[++index] ?? null;
    } else if (argument === "--cosign-verification-log") {
      options.cosignVerificationLogPath = argv[++index] ?? null;
    } else if (argument === "--report") {
      options.reportPath = argv[++index] ?? null;
    } else if (argument === "--json") {
      options.json = true;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }

  if (options.selfTest) {
    requireCondition(
      options.mode === null &&
        options.evidenceDir === null &&
        options.eventPath === null &&
        options.statementPath === null &&
        options.bundlePath === null &&
        options.cosignVerificationLogPath === null &&
        options.reportPath === null,
      "--self-test cannot be combined with evidence arguments",
    );
    return options;
  }
  requireCondition(
    options.mode !== null &&
      options.evidenceDir !== null &&
      options.eventPath !== null &&
      options.statementPath !== null &&
      options.reportPath !== null,
    "real provenance mode requires evidence, event, statement, and report paths",
  );
  if (options.mode === "verify") {
    requireCondition(
      options.bundlePath !== null &&
        options.cosignVerificationLogPath !== null,
      "verify mode requires bundle and Cosign verification log paths",
    );
  } else {
    requireCondition(
      options.bundlePath === null &&
        options.cosignVerificationLogPath === null,
      "generate mode must run before a bundle exists",
    );
  }
  return options;
}

export async function auditRepositoryContract() {
  const [workflowText, sourceWorkflowText, policyBytes, packageBytes] =
    await Promise.all([
      readFile(WORKFLOW, "utf8"),
      readFile(SOURCE_WORKFLOW, "utf8"),
      readFile(POLICY_PATH),
      readFile(PACKAGE_JSON),
    ]);
  const workflow = workflowText.replaceAll("\r\n", "\n");
  const sourceWorkflow = sourceWorkflowText.replaceAll("\r\n", "\n");
  const policy = validateProvenancePolicy(parseJson(policyBytes, "policy"));
  const packageJson = parseJson(packageBytes, "package.json");

  for (const fragment of [
    "workflow_run:",
    `workflows: ["${policy.sourceWorkflowName}"]`,
    "types: [completed]",
    "conclusion == 'success'",
    "head_branch == 'main'",
    "head_sha == github.sha",
    `uses: ${policy.checkoutAction}`,
    `uses: ${policy.downloadArtifactAction}`,
    `uses: ${policy.cosignInstallerAction}`,
    `uses: ${policy.uploadArtifactAction}`,
    `cosign-release: ${policy.cosignVersion}`,
    "persist-credentials: false",
    "digest-mismatch: error",
    "id-token: write",
    "actions: read",
    "contents: read",
    "cosign attest-blob",
    "--statement",
    "--bundle",
    "--oidc-provider github-actions",
    "cosign verify-blob-attestation",
    "--certificate-identity",
    "--certificate-oidc-issuer",
    "--certificate-github-workflow-trigger workflow_run",
    "--certificate-github-workflow-sha",
    "--certificate-github-workflow-repository",
    "--certificate-github-workflow-ref refs/heads/main",
    "--type slsaprovenance1",
    "--use-signed-timestamps",
    "retention-days: 90",
    "node tools/verify_container_runtime_provenance.mjs",
  ]) {
    requireCondition(
      workflow.includes(fragment),
      `provenance workflow is missing ${fragment}`,
    );
  }
  requireCondition(
    countOccurrences(workflow, "id-token: write") === 1 &&
      countOccurrences(workflow, "cosign attest-blob") === 1 &&
      countOccurrences(workflow, "cosign verify-blob-attestation") === 1 &&
      !/pull_request:|packages:\s*write|attestations:\s*write|\$\{\{\s*secrets\.|docker\s+(?:login|push)|wrangler|cloudflare|customer traffic/i.test(
        workflow,
      ),
    "provenance workflow permissions or remote boundary drifted",
  );
  requireCondition(
    !/\bid-token:\s*write\b|\bpackages:\s*write\b|\$\{\{\s*secrets\./i.test(
      sourceWorkflow,
    ),
    "source OCI workflow must remain OIDC-free and credential-free",
  );
  for (const path of [
    ".github/workflows/container-runtime-provenance.yml",
    "tools/verify_container_runtime_provenance.mjs",
    "tests/container-runtime-provenance-gate.test.mjs",
    "config/container-runtime-provenance-policy.json",
    "docs/container-runtime-provenance-build-type-v1.md",
  ]) {
    requireCondition(
      countOccurrences(sourceWorkflow, `- "${path}"`) === 2,
      `source workflow must trigger on S3 contract drift for ${path}`,
    );
  }
  requireCondition(
    packageJson.scripts["check:container-runtime:provenance-contract"]?.includes(
      "tests/container-runtime-provenance-gate.test.mjs",
    ) &&
      packageJson.scripts[
        "check:container-runtime:provenance-contract"
      ]?.includes("--self-test") &&
      packageJson.scripts.check?.includes(
        "check:container-runtime:provenance-contract",
      ),
    "package scripts must include the offline provenance contract",
  );

  return {
    contractVersion: PROVENANCE_GATE_CONTRACT_VERSION,
    status: "passed",
    reportKind: "container-runtime-provenance-contract-audit",
    policy,
    statementGenerated: false,
    signatureVerificationPerformed: false,
    transparencyLogVerified: false,
    signedTimestampVerified: false,
    wormRetentionVerified: false,
    s3Complete: false,
    registryDigestAuthorized: false,
    cloudflareDeploymentAuthorized: false,
    p5Eligible: false,
    customerTrafficAuthorized: false,
    productionCutoverAuthorized: false,
  };
}

export function validateProvenancePolicy(value) {
  const policy = requireObject(value, "provenance policy");
  requireExactKeys(
    policy,
    [
      "allowedSourceEvents",
      "artifactRetentionDays",
      "builderId",
      "buildType",
      "certificateIdentity",
      "certificateOidcIssuer",
      "checkoutAction",
      "contract",
      "cosignInstallerAction",
      "cosignLinuxAmd64Sha256",
      "cosignVersion",
      "downloadArtifactAction",
      "predicateType",
      "provenanceWorkflowName",
      "provenanceWorkflowPath",
      "repository",
      "runner",
      "schemaVersion",
      "sourceBranch",
      "sourceRef",
      "sourceWorkflowName",
      "sourceWorkflowPath",
      "statementType",
      "uploadArtifactAction",
    ],
    "provenance policy",
  );
  requireCondition(
    policy.schemaVersion === 1 &&
      policy.contract === PROVENANCE_POLICY_CONTRACT &&
      policy.repository === "cinagroup/cinatoken-rust" &&
      policy.sourceBranch === "main" &&
      policy.sourceRef === "refs/heads/main" &&
      policy.sourceWorkflowName === "container-runtime-oci" &&
      policy.sourceWorkflowPath ===
        ".github/workflows/container-runtime-oci.yml" &&
      canonicalJson(policy.allowedSourceEvents) ===
        canonicalJson(["push", "workflow_dispatch"]) &&
      policy.provenanceWorkflowName === "container-runtime-provenance" &&
      policy.provenanceWorkflowPath ===
        ".github/workflows/container-runtime-provenance.yml" &&
      policy.certificateIdentity ===
        "https://github.com/cinagroup/cinatoken-rust/.github/workflows/container-runtime-provenance.yml@refs/heads/main" &&
      policy.certificateOidcIssuer ===
        "https://token.actions.githubusercontent.com" &&
      policy.statementType === "https://in-toto.io/Statement/v1" &&
      policy.predicateType === "https://slsa.dev/provenance/v1" &&
      policy.buildType ===
        "https://github.com/cinagroup/cinatoken-rust/blob/main/docs/container-runtime-provenance-build-type-v1.md" &&
      policy.builderId === "https://github.com/actions/runner/github-hosted" &&
      policy.checkoutAction ===
        "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0" &&
      policy.downloadArtifactAction ===
        "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c" &&
      policy.uploadArtifactAction ===
        "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02" &&
      policy.cosignInstallerAction ===
        "sigstore/cosign-installer@6f9f17788090df1f26f669e9d70d6ae9567deba6" &&
      policy.cosignVersion === "v3.1.2" &&
      policy.cosignLinuxAmd64Sha256 ===
        "f7622ed3cf22e55e1ae6377c080979ff77a22da9981c11df222a2e444991e7cf" &&
      policy.runner === "ubuntu-24.04" &&
      policy.artifactRetentionDays === 90,
    "provenance policy identity drifted",
  );
  return policy;
}

export function validateWorkflowRunEvent(value, environment, policy) {
  const event = requireObject(value, "workflow_run event");
  const repository = requireObject(event.repository, "event repository");
  const run = requireObject(event.workflow_run, "source workflow run");
  const headRepository = requireObject(
    run.head_repository,
    "source head repository",
  );
  requireCondition(
    repository.full_name === policy.repository &&
      headRepository.full_name === policy.repository &&
      repository.id === headRepository.id &&
      environment.GITHUB_REPOSITORY === policy.repository,
    "source workflow run repository identity drifted",
  );
  requireCondition(
    run.name === policy.sourceWorkflowName &&
      run.path === policy.sourceWorkflowPath &&
      run.conclusion === "success" &&
      run.status === "completed" &&
      run.head_branch === policy.sourceBranch &&
      run.head_sha === environment.GITHUB_SHA &&
      environment.GITHUB_REF === policy.sourceRef &&
      policy.allowedSourceEvents.includes(run.event),
    "source workflow run is not an accepted same-commit main result",
  );
  requireCondition(
    Number.isSafeInteger(run.id) &&
      run.id > 0 &&
      Number.isSafeInteger(run.run_attempt) &&
      run.run_attempt > 0 &&
      validGitSha(run.head_sha) &&
      validTimestamp(run.run_started_at) &&
      validTimestamp(run.updated_at) &&
      Date.parse(run.updated_at) >= Date.parse(run.run_started_at),
    "source workflow run metadata is malformed",
  );
  const expectedWorkflowRef =
    `${policy.repository}/${policy.provenanceWorkflowPath}` +
    `@${policy.sourceRef}`;
  requireCondition(
    environment.GITHUB_WORKFLOW_REF === expectedWorkflowRef &&
      environment.GITHUB_WORKFLOW_SHA === environment.GITHUB_SHA &&
      environment.GITHUB_EVENT_NAME === "workflow_run" &&
      validPositiveIntegerString(environment.GITHUB_RUN_ID) &&
      validPositiveIntegerString(environment.GITHUB_RUN_ATTEMPT),
    "provenance signer workflow context drifted",
  );
  return {
    sourceRunId: run.id,
    sourceRunAttempt: run.run_attempt,
    sourceRunUrl: run.html_url,
    sourceEvent: run.event,
    sourceHeadSha: run.head_sha,
    startedOn: run.run_started_at,
    finishedOn: run.updated_at,
    signerRunId: Number(environment.GITHUB_RUN_ID),
    signerRunAttempt: Number(environment.GITHUB_RUN_ATTEMPT),
    signerSha: environment.GITHUB_SHA,
    signerWorkflowRef: environment.GITHUB_WORKFLOW_REF,
  };
}

export async function generateProvenance(options, environment = process.env) {
  await auditRepositoryContract();
  const policy = validateProvenancePolicy(
    parseJson(
      await readBoundedFile(POLICY_PATH, MAX_JSON_BYTES, "provenance policy"),
      "provenance policy",
    ),
  );
  const event = parseJson(
    await readBoundedFile(
      options.eventPath,
      MAX_JSON_BYTES,
      "workflow event",
    ),
    "workflow event",
  );
  const invocation = validateWorkflowRunEvent(event, environment, policy);
  const evidence = await validateEvidence(options.evidenceDir);
  const dependencies = await fingerprintSourceDependencies(invocation);
  const statement = buildProvenanceStatement({
    policy,
    invocation,
    evidence,
    dependencies,
  });
  validateProvenanceStatement(statement, {
    policy,
    invocation,
    evidence,
    dependencies,
  });
  const statementBytes = Buffer.from(canonicalJson(statement), "utf8");
  await writeFile(options.statementPath, statementBytes, { mode: 0o600 });
  const report = buildReport({
    policy,
    invocation,
    evidence,
    statementBytes,
    bundleFacts: null,
  });
  await writeCanonicalJson(options.reportPath, report);
  return report;
}

export async function verifyProvenance(options, environment = process.env) {
  await auditRepositoryContract();
  const policy = validateProvenancePolicy(
    parseJson(
      await readBoundedFile(POLICY_PATH, MAX_JSON_BYTES, "provenance policy"),
      "provenance policy",
    ),
  );
  const event = parseJson(
    await readBoundedFile(
      options.eventPath,
      MAX_JSON_BYTES,
      "workflow event",
    ),
    "workflow event",
  );
  const invocation = validateWorkflowRunEvent(event, environment, policy);
  const evidence = await validateEvidence(options.evidenceDir);
  const dependencies = await fingerprintSourceDependencies(invocation);
  const statementBytes = await readBoundedFile(
    options.statementPath,
    MAX_JSON_BYTES,
    "provenance statement",
  );
  requireCondition(
    statementBytes.equals(
      Buffer.from(
        canonicalJson(parseJson(statementBytes, "provenance statement")),
        "utf8",
      ),
    ),
    "provenance statement is not canonical JSON",
  );
  const statement = parseJson(statementBytes, "provenance statement");
  validateProvenanceStatement(statement, {
    policy,
    invocation,
    evidence,
    dependencies,
  });
  const bundleBytes = await readBoundedFile(
    options.bundlePath,
    MAX_JSON_BYTES,
    "Sigstore bundle",
  );
  const bundleFacts = validateSigstoreBundle(
    parseJson(bundleBytes, "Sigstore bundle"),
    statementBytes,
  );
  const verificationLog = await readBoundedFile(
    options.cosignVerificationLogPath,
    MAX_LOG_BYTES,
    "Cosign verification log",
  );
  const verificationText = new TextDecoder("utf-8", { fatal: true }).decode(
    verificationLog,
  );
  requireCondition(
    /(?:^|\n)Verified OK(?:\r?\n|$)/.test(verificationText),
    "Cosign verification log does not contain an exact success marker",
  );
  const report = buildReport({
    policy,
    invocation,
    evidence,
    statementBytes,
    bundleFacts: {
      ...bundleFacts,
      sha256: sha256Hex(bundleBytes),
      bytes: bundleBytes.length,
      cosignVerificationLogSha256: sha256Hex(verificationLog),
      cosignVerificationLogBytes: verificationLog.length,
    },
  });
  await writeCanonicalJson(options.reportPath, report);
  return report;
}

async function validateEvidence(evidenceDirectory) {
  const root = resolve(evidenceDirectory);
  const fingerprints = new Map();
  for (const [path, maximumBytes, mediaType] of EVIDENCE_FILES) {
    const fingerprint = await fingerprintFile(
      boundedEvidencePath(root, path),
      maximumBytes,
      `evidence ${path}`,
    );
    fingerprints.set(path, { ...fingerprint, mediaType });
  }

  const ociReport = parseJson(
    await readBoundedFile(
      boundedEvidencePath(root, "container-runtime-oci-verification.json"),
      MAX_JSON_BYTES,
      "OCI report",
    ),
    "OCI report",
  );
  const replayedOciReport = await runOciGate(
    boundedEvidencePath(root, "container-runtime-a.tar"),
    boundedEvidencePath(root, "container-runtime-b.tar"),
  );
  validateOciReplay(ociReport, replayedOciReport);

  const sbomReport = parseJson(
    await readBoundedFile(
      boundedEvidencePath(root, "container-runtime-sbom-verification.json"),
      MAX_JSON_BYTES,
      "SBOM report",
    ),
    "SBOM report",
  );
  const replayedSbomReport = await runSbomGate(
    boundedEvidencePath(root, "sbom-a/container-runtime.sbom.syft.json"),
    boundedEvidencePath(root, "sbom-b/container-runtime.sbom.syft.json"),
    boundedEvidencePath(root, "container-runtime-oci-verification.json"),
  );
  requireCondition(
    canonicalJson(sbomReport) === canonicalJson(replayedSbomReport),
    "retained SBOM report does not reproduce exactly",
  );
  const vulnerabilityFacts = await validateAcceptedVulnerabilityEvidence(
    root,
    sbomReport,
    fingerprints,
  );
  return {
    root,
    fingerprints,
    ociReport,
    sbomReport,
    vulnerabilityReport: vulnerabilityFacts.report,
    vulnerabilityFacts,
  };
}

export async function validateAcceptedVulnerabilityEvidence(
  root,
  sbomReport,
  fingerprints,
) {
  const readJsonEvidence = async (path, label) =>
    parseJson(
      await readBoundedFile(
        boundedEvidencePath(root, path),
        MAX_JSON_BYTES,
        label,
      ),
      label,
    );
  const [
    report,
    metadataBytes,
    listingBytes,
    policyBytes,
    approvalsBytes,
    scanABytes,
    scanBBytes,
    statusA,
    statusB,
    importA,
    importB,
    snapshotBefore,
    snapshotAfter,
    scannerIndexBytes,
    scannerInspectBytes,
  ] = await Promise.all([
    readJsonEvidence(
      "container-runtime-vulnerability-verification.json",
      "vulnerability report",
    ),
    readBoundedFile(
      resolve(ROOT, "config/container-runtime-vulnerability-db.json"),
      MAX_JSON_BYTES,
      "database metadata",
    ),
    readBoundedFile(
      resolve(ROOT, "config/container-runtime-vulnerability-db-listing.json"),
      MAX_JSON_BYTES,
      "database listing",
    ),
    readBoundedFile(
      resolve(ROOT, "config/container-runtime-vulnerability-policy.json"),
      MAX_JSON_BYTES,
      "vulnerability policy",
    ),
    readBoundedFile(
      resolve(ROOT, "config/container-runtime-vulnerability-approvals.json"),
      MAX_JSON_BYTES,
      "vulnerability approvals",
    ),
    readBoundedFile(
      boundedEvidencePath(
        root,
        "scan-a/container-runtime.vulnerabilities.grype.json",
      ),
      128 * 1024 * 1024,
      "scan A",
    ),
    readBoundedFile(
      boundedEvidencePath(
        root,
        "scan-b/container-runtime.vulnerabilities.grype.json",
      ),
      128 * 1024 * 1024,
      "scan B",
    ),
    readJsonEvidence("grype-db-status-a.json", "database status A"),
    readJsonEvidence("grype-db-status-b.json", "database status B"),
    readJsonEvidence("grype-db-a/6/import.json", "database import A"),
    readJsonEvidence("grype-db-b/6/import.json", "database import B"),
    readBoundedFile(
      boundedEvidencePath(root, "vulnerability-scan-inputs-before.txt"),
      MAX_LOG_BYTES,
      "scan input snapshot before",
    ),
    readBoundedFile(
      boundedEvidencePath(root, "vulnerability-scan-inputs-after.txt"),
      MAX_LOG_BYTES,
      "scan input snapshot after",
    ),
    readBoundedFile(
      boundedEvidencePath(root, "grype-image-index.json"),
      MAX_JSON_BYTES,
      "scanner index",
    ),
    readBoundedFile(
      boundedEvidencePath(root, "grype-image-inspect.json"),
      MAX_JSON_BYTES,
      "scanner inspect",
    ),
  ]);
  const metadata = validateDatabaseMetadata(
    parseJson(metadataBytes, "database metadata"),
  );
  const listingFacts = validateDatabaseListing(
    parseJson(listingBytes, "database listing"),
    metadata,
    listingBytes,
  );
  const vulnerabilityPolicy = validateVulnerabilityPolicy(
    parseJson(policyBytes, "vulnerability policy"),
  );
  const approvals = validateVulnerabilityApprovals(
    parseJson(approvalsBytes, "vulnerability approvals"),
    vulnerabilityPolicy,
  );
  const sbomFacts = validateSbomReport(sbomReport);
  const scannerFacts = validateScannerImageIdentity(
    scannerIndexBytes,
    scannerInspectBytes,
  );
  requireCondition(
    scanABytes.equals(scanBBytes),
    "retained vulnerability scans are not byte-identical",
  );
  const observedAt = requireObject(
    report.database,
    "vulnerability report database",
  ).observedAt;
  const databaseFacts = {
    path: "/grype-db/6/vulnerability.db",
    valid: true,
  };
  const dbStatusA = validateDatabaseStatus(statusA, metadata, observedAt);
  const dbStatusB = validateDatabaseStatus(statusB, metadata, observedAt);
  requireCondition(
    canonicalJson(dbStatusA) === canonicalJson(dbStatusB),
    "retained database statuses differ",
  );
  const importFactsA = validateDatabaseImportMetadata(importA, metadata);
  const importFactsB = validateDatabaseImportMetadata(importB, metadata);
  requireCondition(
    canonicalJson(importFactsA) === canonicalJson(importFactsB),
    "retained database import metadata differs",
  );
  const scanFacts = validateGrypeScan(parseJson(scanABytes, "scan A"), {
    metadata,
    dbFacts: databaseFacts,
    sbomFacts,
  });
  const sbomA = fingerprints.get(
    "sbom-a/container-runtime.sbom.syft.json",
  );
  const sbomB = fingerprints.get(
    "sbom-b/container-runtime.sbom.syft.json",
  );
  const databaseA = {
    sha256: metadata.importedFileSha256,
    bytes: metadata.importedFileBytes,
  };
  const databaseB = { ...databaseA };
  const importAFingerprint = fingerprints.get("grype-db-a/6/import.json");
  const importBFingerprint = fingerprints.get("grype-db-b/6/import.json");
  validateIndependentEvidenceBindings({
    sbomA,
    sbomB,
    sbomFacts,
    databaseA,
    databaseB,
    metadata,
  });
  const inputSnapshot = validateInputSnapshots(
    snapshotBefore,
    snapshotAfter,
    {
      sbomA,
      sbomB,
      databaseA,
      databaseB,
      importA: importAFingerprint,
      importB: importBFingerprint,
    },
  );
  validateAcceptedVulnerabilityReport(report, {
    approvals,
    approvalsBytes,
    databaseArchive: fingerprints.get("grype-db.tar.zst"),
    dbStatusA,
    importFactsA,
    inputSnapshot,
    listingFacts,
    metadata,
    policy: vulnerabilityPolicy,
    policyBytes,
    scanBytes: scanABytes,
    scanFacts,
    scannerFacts,
    sbomFacts,
  });
  return { report, sbomFacts, scanFacts, inputSnapshot };
}

export function validateAcceptedVulnerabilityReport(reportValue, facts) {
  const report = requireObject(reportValue, "vulnerability report");
  const decision = requireObject(report.decision, "vulnerability decision");
  const database = requireObject(report.database, "vulnerability database");
  const policy = requireObject(report.policy, "vulnerability policy");
  const scan = requireObject(report.scan, "vulnerability scan");
  requireCondition(
    report.contractVersion === 3 &&
      report.status === "passed" &&
      report.reportKind === "container-runtime-vulnerability-decision" &&
      decision.scope === "local-vulnerability-scan-only" &&
      decision.formalP5Evidence === false &&
      decision.vulnerabilityDecision ===
        "passed-zero-unapproved-unknown-high-critical" &&
      decision.productionDecision === "not-authorized" &&
      canonicalJson(report.subject) === canonicalJson(facts.sbomFacts) &&
      report.generatedSbomPresent === true &&
      report.generatedProvenancePresent === false &&
      report.vulnerabilityScanPresent === true &&
      report.unapprovedUnknownVulnerabilities === 0 &&
      report.unapprovedCriticalVulnerabilities === 0 &&
      report.unapprovedHighVulnerabilities === 0 &&
      report.canonicalContainerImageDigest === null &&
      report.imageSignatureVerificationPerformed === false &&
      report.imageSignatureVerified === false &&
      report.registryDigestAuthorized === false &&
      report.registryReadbackVerified === false &&
      report.cloudflareDeploymentDigestVerified === false &&
      report.transparencyLogVerified === false &&
      report.wormRetentionVerified === false &&
      report.p5Eligible === false &&
      report.remoteMutationAuthorized === false &&
      report.customerTrafficAuthorized === false &&
      report.productionCutoverAuthorized === false,
    "vulnerability report is not an accepted fail-closed S2 result",
  );
  requireCondition(
    report.scanner.image === GRYPE_IMAGE &&
      report.scanner.indexDigest === GRYPE_IMAGE_INDEX_DIGEST &&
      report.scanner.amd64ManifestDigest ===
        GRYPE_IMAGE_AMD64_MANIFEST_DIGEST &&
      report.scanner.localImageId === facts.scannerFacts.localImageId &&
      report.scanner.networkDisabled === true &&
      report.scanner.runsAsRoot === false &&
      report.scanner.exactIndependentMatch === true,
    "vulnerability scanner identity drifted",
  );
  requireCondition(
    database.archiveUrl === GRYPE_DB_ARCHIVE_URL &&
      database.archiveSha256 === GRYPE_DB_ARCHIVE_SHA256 &&
      database.archiveSha256 === facts.databaseArchive.sha256 &&
      database.archiveBytes === facts.databaseArchive.bytes &&
      database.importedFileSha256 === GRYPE_DB_FILE_SHA256 &&
      database.importedFileBytes === GRYPE_DB_FILE_BYTES &&
      database.importedFileXxh64 === GRYPE_DB_FILE_XXH64 &&
      database.valid === true &&
      database.exactIndependentStatusMatch === true &&
      database.exactIndependentFileMatch === true &&
      canonicalJson(database.listing) === canonicalJson(facts.listingFacts) &&
      canonicalJson(database.importMetadata) ===
        canonicalJson(facts.importFactsA),
    "vulnerability database report drifted",
  );
  requireCondition(
    policy.policySha256 === sha256Hex(facts.policyBytes) &&
      policy.policyBytes === facts.policyBytes.length &&
      policy.approvalsSha256 === sha256Hex(facts.approvalsBytes) &&
      policy.approvalsBytes === facts.approvalsBytes.length &&
      policy.approvalCount === facts.approvals.length &&
      facts.approvals.length === 0,
    "vulnerability policy or approvals report drifted",
  );
  requireCondition(
    scan.format === "grype-json" &&
      scan.sha256 === sha256Hex(facts.scanBytes) &&
      scan.bytes === facts.scanBytes.length &&
      scan.exactIndependentMatch === true &&
      scan.matchCount === 0 &&
      scan.ignoredMatchCount === 0 &&
      scan.uniqueFindingCount === 0 &&
      canonicalJson(scan.severityCounts) ===
        canonicalJson(facts.scanFacts.severityCounts) &&
      canonicalJson(report.scanInputSnapshot) ===
        canonicalJson(facts.inputSnapshot),
    "vulnerability scan report drifted",
  );
  return report;
}

function validateOciReplay(source, replay) {
  const fields = [
    "ociIndexDigest",
    "ociManifestDigest",
    "ociConfigDigest",
    "compressedLayerDigests",
    "uncompressedLayerDiffIds",
    "runtimeBinarySha256",
  ];
  requireCondition(
    source.status === "passed" &&
      replay.status === "passed" &&
      fields.every(
        (field) => canonicalJson(source[field]) === canonicalJson(replay[field]),
      ) &&
      canonicalJson(source.reproducibility) ===
        canonicalJson(replay.reproducibility),
    "retained OCI report does not reproduce the exact subject",
  );
}

async function fingerprintSourceDependencies(invocation) {
  const result = [];
  for (const [path, mediaType] of SOURCE_DEPENDENCIES) {
    const fingerprint = await fingerprintFile(
      resolve(ROOT, path),
      MAX_JSON_BYTES,
      `source dependency ${path}`,
    );
    result.push({
      uri:
        `git+https://github.com/cinagroup/cinatoken-rust@` +
        `${invocation.sourceHeadSha}#${path}`,
      name: path,
      digest: { sha256: fingerprint.sha256 },
      mediaType,
      annotations: { bytes: fingerprint.bytes },
    });
  }
  return result;
}

export function buildProvenanceStatement({
  policy,
  invocation,
  evidence,
  dependencies,
}) {
  const oci = evidence.ociReport;
  const sbom = evidence.sbomReport;
  const vulnerability = evidence.vulnerabilityReport;
  const subjects = [
    subject("container-runtime.oci.tar", oci.reproducibility.archiveSha256),
    subject("container-runtime.oci.index.json", stripDigest(oci.ociIndexDigest)),
    subject(
      "container-runtime.oci.manifest.json",
      stripDigest(oci.ociManifestDigest),
    ),
    subject("container-runtime.oci.config.json", stripDigest(oci.ociConfigDigest)),
    subject(
      "usr/local/bin/cinatoken-container-runtime",
      oci.runtimeBinarySha256,
    ),
    subject(
      "container-runtime.sbom.syft.json",
      sbom.sbom.sha256,
    ),
    subject(
      "container-runtime.vulnerabilities.grype.json",
      vulnerability.scan.sha256,
    ),
  ];
  const byproducts = [...evidence.fingerprints.entries()].map(
    ([path, fingerprint]) => ({
      uri:
        `https://github.com/${policy.repository}/actions/runs/` +
        `${invocation.sourceRunId}/artifacts#${path}`,
      name: path,
      digest: { sha256: fingerprint.sha256 },
      mediaType: fingerprint.mediaType,
      annotations: { bytes: fingerprint.bytes },
    }),
  );
  const resolvedDependencies = [
    {
      uri:
        `git+https://github.com/${policy.repository}@${policy.sourceRef}`,
      name: policy.repository,
      digest: { gitCommit: invocation.sourceHeadSha },
    },
    ...dependencies,
    imageDependency(BUILDKIT_IMAGE, "BuildKit"),
    imageDependency(RUST_MUSL_TARGET_IMAGE, "Rust musl target"),
    imageDependency(RUST_BUILDER_IMAGE, "Rust builder"),
    imageDependency(DISTROLESS_RUNTIME_IMAGE, "distroless runtime"),
    imageDependency(SYFT_IMAGE, "Syft"),
    imageDependency(GRYPE_IMAGE, "Grype"),
    {
      uri: GRYPE_DB_ARCHIVE_URL,
      name: "frozen Grype vulnerability database",
      digest: { sha256: GRYPE_DB_ARCHIVE_SHA256 },
    },
  ];
  const builderDependencies = [
    actionDependency(policy.checkoutAction),
    actionDependency(policy.downloadArtifactAction),
    actionDependency(policy.uploadArtifactAction),
    actionDependency(policy.cosignInstallerAction),
    {
      uri: `https://github.com/sigstore/cosign/releases/tag/${policy.cosignVersion}`,
      name: `cosign ${policy.cosignVersion}`,
      digest: { sha256: policy.cosignLinuxAmd64Sha256 },
    },
  ];
  return {
    _type: policy.statementType,
    subject: subjects,
    predicateType: policy.predicateType,
    predicate: {
      buildDefinition: {
        buildType: policy.buildType,
        externalParameters: {
          repository: policy.repository,
          ref: policy.sourceRef,
          eventName: invocation.sourceEvent,
          workflowPath: policy.sourceWorkflowPath,
        },
        internalParameters: {
          sourceRunId: invocation.sourceRunId,
          sourceRunAttempt: invocation.sourceRunAttempt,
          sourceJob: "reproducible-linux-amd64-oci",
          platform: "linux/amd64",
          sourceDateEpoch: 0,
          independentBuilds: 2,
        },
        resolvedDependencies,
      },
      runDetails: {
        builder: {
          id: policy.builderId,
          builderDependencies,
          version: {
            githubActionsWorkflow: invocation.signerSha,
            runner: policy.runner,
          },
        },
        metadata: {
          invocationId: invocation.sourceRunUrl,
          startedOn: invocation.startedOn,
          finishedOn: invocation.finishedOn,
        },
        byproducts,
      },
    },
  };
}

export function validateProvenanceStatement(statementValue, expected) {
  const statement = requireObject(statementValue, "provenance statement");
  requireExactKeys(
    statement,
    ["_type", "predicate", "predicateType", "subject"],
    "provenance statement",
  );
  const rebuilt = buildProvenanceStatement(expected);
  requireCondition(
    canonicalJson(statement) === canonicalJson(rebuilt),
    "provenance statement does not exactly match the accepted source evidence",
  );
  requireCondition(
    statement.subject.length === 7 &&
      new Set(statement.subject.map((entry) => entry.name)).size === 7 &&
      statement.subject.every(
        (entry) =>
          Object.keys(entry.digest).length === 1 &&
          validSha256(entry.digest.sha256),
      ),
    "provenance subjects are incomplete or ambiguous",
  );
  return statement;
}

export function validateSigstoreBundle(bundleValue, statementBytes) {
  const bundle = requireObject(bundleValue, "Sigstore bundle");
  requireExactKeys(
    bundle,
    ["dsseEnvelope", "mediaType", "verificationMaterial"],
    "Sigstore bundle",
  );
  requireCondition(
    bundle.mediaType === SIGSTORE_BUNDLE_MEDIA_TYPE,
    "Sigstore bundle media type drifted",
  );
  const envelope = requireObject(bundle.dsseEnvelope, "DSSE envelope");
  requireExactKeys(
    envelope,
    ["payload", "payloadType", "signatures"],
    "DSSE envelope",
  );
  requireCondition(
    envelope.payloadType === DSSE_PAYLOAD_TYPE &&
      Array.isArray(envelope.signatures) &&
      envelope.signatures.length === 1,
    "Sigstore bundle must contain one in-toto DSSE signature",
  );
  const signature = requireObject(envelope.signatures[0], "DSSE signature");
  requireAllowedKeys(signature, ["keyid", "sig"], "DSSE signature");
  requireCondition(
    validBase64(signature.sig, 64, 2048),
    "DSSE signature is malformed",
  );
  const payload = decodeBase64(envelope.payload, "DSSE payload", MAX_JSON_BYTES);
  requireCondition(
    payload.equals(statementBytes),
    "DSSE payload does not exactly match the canonical provenance statement",
  );

  const verification = requireObject(
    bundle.verificationMaterial,
    "Sigstore verification material",
  );
  requireAllowedKeys(
    verification,
    ["certificate", "timestampVerificationData", "tlogEntries"],
    "Sigstore verification material",
  );
  const certificate = requireObject(
    verification.certificate,
    "Fulcio certificate",
  );
  requireExactKeys(certificate, ["rawBytes"], "Fulcio certificate");
  requireCondition(
    validBase64(certificate.rawBytes, 256, 16 * 1024),
    "Fulcio certificate bytes are malformed",
  );
  requireCondition(
    Array.isArray(verification.tlogEntries) &&
      verification.tlogEntries.length === 1,
    "Sigstore bundle must contain exactly one transparency entry",
  );
  const tlog = requireObject(
    verification.tlogEntries[0],
    "transparency entry",
  );
  requireExactKeys(
    tlog,
    [
      "canonicalizedBody",
      "inclusionPromise",
      "inclusionProof",
      "integratedTime",
      "kindVersion",
      "logId",
      "logIndex",
    ],
    "transparency entry",
  );
  const logId = requireObject(tlog.logId, "transparency log ID");
  requireExactKeys(logId, ["keyId"], "transparency log ID");
  const kindVersion = requireObject(
    tlog.kindVersion,
    "transparency kind/version",
  );
  requireExactKeys(
    kindVersion,
    ["kind", "version"],
    "transparency kind/version",
  );
  const proof = requireObject(tlog.inclusionProof, "transparency proof");
  requireExactKeys(
    proof,
    ["checkpoint", "hashes", "logIndex", "rootHash", "treeSize"],
    "transparency proof",
  );
  const promise = requireObject(
    tlog.inclusionPromise,
    "transparency promise",
  );
  requireExactKeys(
    promise,
    ["signedEntryTimestamp"],
    "transparency promise",
  );
  const checkpoint = requireObject(
    proof.checkpoint,
    "transparency checkpoint",
  );
  requireExactKeys(checkpoint, ["envelope"], "transparency checkpoint");
  requireCondition(
    kindVersion.kind === "dsse" &&
      kindVersion.version === "0.0.1" &&
      validBase64(logId.keyId, 32, 1024) &&
      validPositiveIntegerString(tlog.logIndex) &&
      validPositiveIntegerString(tlog.integratedTime) &&
      validBase64(tlog.canonicalizedBody, 32, MAX_JSON_BYTES) &&
      validBase64(promise.signedEntryTimestamp, 32, 16 * 1024) &&
      validPositiveIntegerString(proof.logIndex) &&
      validPositiveIntegerString(proof.treeSize) &&
      validBase64(proof.rootHash, 32, 1024) &&
      Array.isArray(proof.hashes) &&
      proof.hashes.every((value) => validBase64(value, 32, 1024)) &&
      typeof checkpoint.envelope === "string" &&
      checkpoint.envelope.length > 0 &&
      checkpoint.envelope.length <= 64 * 1024,
    "Sigstore transparency evidence is incomplete",
  );
  const timestampData = requireObject(
    verification.timestampVerificationData,
    "timestamp verification data",
  );
  requireExactKeys(
    timestampData,
    ["rfc3161Timestamps"],
    "timestamp verification data",
  );
  requireCondition(
    Array.isArray(timestampData.rfc3161Timestamps) &&
      timestampData.rfc3161Timestamps.length >= 1 &&
      timestampData.rfc3161Timestamps.every((entry) => {
        const timestamp = requireObject(entry, "RFC3161 timestamp");
        requireExactKeys(
          timestamp,
          ["signedTimestamp"],
          "RFC3161 timestamp",
        );
        return validBase64(timestamp.signedTimestamp, 64, 128 * 1024);
      }),
    "Sigstore bundle does not contain a signed RFC3161 timestamp",
  );
  return {
    dssePayloadSha256: sha256Hex(payload),
    signatureCount: 1,
    certificatePresent: true,
    transparencyEntryCount: 1,
    transparencyLogIndex: tlog.logIndex,
    transparencyIntegratedTime: tlog.integratedTime,
    inclusionPromisePresent: true,
    inclusionProofPresent: true,
    signedTimestampCount: timestampData.rfc3161Timestamps.length,
  };
}

function buildReport({
  policy,
  invocation,
  evidence,
  statementBytes,
  bundleFacts,
}) {
  const verified = bundleFacts !== null;
  return {
    contractVersion: PROVENANCE_GATE_CONTRACT_VERSION,
    status: "passed",
    reportKind: verified
      ? "container-runtime-provenance-verification"
      : "container-runtime-provenance-pre-signing",
    decision: {
      scope: "github-sigstore-provenance-only",
      formalP5Evidence: false,
      s3CryptographicEvidence: verified,
      immutableRetentionDecision: "not-verified",
      s3Decision: verified
        ? "cryptographic-subgate-passed-worm-pending"
        : "not-signed",
      productionDecision: "not-authorized",
    },
    source: {
      repository: policy.repository,
      workflow: policy.sourceWorkflowPath,
      runId: invocation.sourceRunId,
      runAttempt: invocation.sourceRunAttempt,
      event: invocation.sourceEvent,
      ref: policy.sourceRef,
      commit: invocation.sourceHeadSha,
    },
    signer: {
      workflow: policy.provenanceWorkflowPath,
      runId: invocation.signerRunId,
      runAttempt: invocation.signerRunAttempt,
      commit: invocation.signerSha,
      certificateIdentity: policy.certificateIdentity,
      certificateOidcIssuer: policy.certificateOidcIssuer,
      cosignVersion: policy.cosignVersion,
      cosignLinuxAmd64Sha256: policy.cosignLinuxAmd64Sha256,
    },
    subject: {
      archiveSha256: evidence.ociReport.reproducibility.archiveSha256,
      ociIndexDigest: evidence.ociReport.ociIndexDigest,
      ociManifestDigest: evidence.ociReport.ociManifestDigest,
      ociConfigDigest: evidence.ociReport.ociConfigDigest,
      runtimeBinarySha256: evidence.ociReport.runtimeBinarySha256,
      sbomSha256: evidence.sbomReport.sbom.sha256,
      vulnerabilityScanSha256: evidence.vulnerabilityReport.scan.sha256,
    },
    statement: {
      type: policy.statementType,
      predicateType: policy.predicateType,
      buildType: policy.buildType,
      sha256: sha256Hex(statementBytes),
      bytes: statementBytes.length,
      canonicalJson: true,
      exactSubjectBindingVerified: true,
      exactByproductBindingVerified: true,
    },
    sigstore: verified
      ? {
          bundleMediaType: SIGSTORE_BUNDLE_MEDIA_TYPE,
          bundleSha256: bundleFacts.sha256,
          bundleBytes: bundleFacts.bytes,
          dssePayloadSha256: bundleFacts.dssePayloadSha256,
          signatureCount: bundleFacts.signatureCount,
          certificateIdentityVerified: true,
          certificateOidcIssuerVerified: true,
          githubWorkflowClaimsVerified: true,
          certificateTransparencySctVerified: true,
          transparencyLogVerified: true,
          transparencyLogIndex: bundleFacts.transparencyLogIndex,
          transparencyIntegratedTime: bundleFacts.transparencyIntegratedTime,
          inclusionPromisePresent: bundleFacts.inclusionPromisePresent,
          inclusionProofPresent: bundleFacts.inclusionProofPresent,
          signedTimestampVerified: true,
          signedTimestampCount: bundleFacts.signedTimestampCount,
          cosignVerificationLogSha256:
            bundleFacts.cosignVerificationLogSha256,
          cosignVerificationLogBytes:
            bundleFacts.cosignVerificationLogBytes,
        }
      : null,
    generatedProvenancePresent: true,
    signatureVerificationPerformed: verified,
    artifactAttestationVerified: verified,
    imageSignatureVerified: false,
    transparencyLogVerified: verified,
    signedTimestampVerified: verified,
    githubArtifactRetentionDays: policy.artifactRetentionDays,
    wormRetentionVerified: false,
    s3Complete: false,
    canonicalContainerImageDigest: null,
    registryDigestAuthorized: false,
    registryReadbackVerified: false,
    cloudflareDeploymentDigestVerified: false,
    p5Eligible: false,
    remoteMutationAuthorized: false,
    customerTrafficAuthorized: false,
    productionCutoverAuthorized: false,
  };
}

function subject(name, sha256) {
  requireCondition(validSha256(sha256), `subject ${name} digest is invalid`);
  return { name, digest: { sha256 } };
}

function imageDependency(reference, name) {
  const match = /@sha256:([a-f0-9]{64})$/.exec(reference);
  requireCondition(match !== null, `${name} image is not digest-pinned`);
  return { uri: `pkg:docker/${reference}`, name, digest: { sha256: match[1] } };
}

function actionDependency(reference) {
  const match = /^([^@]+)@([a-f0-9]{40})$/.exec(reference);
  requireCondition(match !== null, `action reference is not commit-pinned: ${reference}`);
  return {
    uri: `git+https://github.com/${match[1]}@${match[2]}`,
    name: match[1],
    digest: { gitCommit: match[2] },
  };
}

async function fingerprintFile(path, maximumBytes, label) {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await handle.stat();
    requireCondition(
      before.isFile() &&
        before.size > 0 &&
        before.size <= maximumBytes,
      `${label} must be a nonempty bounded regular file`,
    );
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < before.size) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, before.size - position),
        position,
      );
      requireCondition(bytesRead > 0, `${label} changed while hashing`);
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    requireCondition(
      after.size === before.size &&
        after.mtimeMs === before.mtimeMs &&
        after.ino === before.ino,
      `${label} changed while hashing`,
    );
    return { sha256: hash.digest("hex"), bytes: before.size };
  } finally {
    await handle?.close();
  }
}

async function readBoundedFile(path, maximumBytes, label) {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await handle.stat();
    requireCondition(
      before.isFile() &&
        before.size > 0 &&
        before.size <= maximumBytes,
      `${label} must be a nonempty bounded regular file`,
    );
    const bytes = await handle.readFile();
    const after = await handle.stat();
    requireCondition(
      bytes.length === before.size &&
        after.size === before.size &&
        after.mtimeMs === before.mtimeMs &&
        after.ino === before.ino,
      `${label} changed while reading`,
    );
    return bytes;
  } finally {
    await handle?.close();
  }
}

function boundedEvidencePath(root, path) {
  requireCondition(
    typeof path === "string" &&
      path.length > 0 &&
      path.length <= 256 &&
      !path.includes("\\") &&
      !path.includes("\0"),
    "evidence path is malformed",
  );
  const resolved = resolve(root, path);
  const relativePath = relative(root, resolved);
  requireCondition(
    relativePath !== "" &&
      relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`),
    "evidence path escapes its root",
  );
  return resolved;
}

async function writeCanonicalJson(path, value) {
  await writeFile(path, Buffer.from(canonicalJson(value), "utf8"), {
    mode: 0o600,
  });
}

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  requireCondition(
    value !== undefined &&
      (value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"),
    "canonical JSON contains an unsupported value",
  );
  return JSON.stringify(value);
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

function decodeBase64(value, label, maximumBytes) {
  requireCondition(
    validBase64(value, 1, Math.ceil((maximumBytes * 4) / 3) + 4),
    `${label} is not strict bounded base64`,
  );
  const bytes = Buffer.from(value, "base64");
  requireCondition(bytes.length <= maximumBytes, `${label} is too large`);
  return bytes;
}

function validBase64(value, minimumLength, maximumLength) {
  if (
    typeof value !== "string" ||
    value.length < minimumLength ||
    value.length > maximumLength ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    return false;
  }
  return Buffer.from(value, "base64").toString("base64") === value;
}

function stripDigest(value) {
  requireCondition(validDigest(value), "OCI digest is malformed");
  return value.slice("sha256:".length);
}

function validSha256(value) {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function validDigest(value) {
  return typeof value === "string" && SHA256_DIGEST_PATTERN.test(value);
}

function validGitSha(value) {
  return typeof value === "string" && GIT_SHA_PATTERN.test(value);
}

function validPositiveIntegerString(value) {
  return (
    (typeof value === "string" && POSITIVE_INTEGER_PATTERN.test(value)) ||
    (Number.isSafeInteger(value) && value > 0)
  );
}

function validTimestamp(value) {
  return (
    typeof value === "string" &&
    RFC3339_PATTERN.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireAllowedKeys(value, keys, label) {
  const object = requireObject(value, label);
  const allowed = new Set(keys);
  requireCondition(
    Object.keys(object).every((key) => allowed.has(key)),
    `${label} contains an unsupported key`,
  );
}

function requireExactKeys(value, keys, label) {
  const object = requireObject(value, label);
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  requireCondition(
    canonicalJson(actual) === canonicalJson(expected),
    `${label} keys drifted`,
  );
}

function requireObject(value, label) {
  requireCondition(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value;
}

function countOccurrences(value, fragment) {
  return value.split(fragment).length - 1;
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let report;
  if (options.selfTest) {
    report = await auditRepositoryContract();
  } else if (options.mode === "generate") {
    report = await generateProvenance(options);
  } else {
    report = await verifyProvenance(options);
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`container runtime provenance gate: ${report.status}\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(
      `container runtime provenance gate failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
