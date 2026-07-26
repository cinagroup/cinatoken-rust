import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const VULNERABILITY_GATE_CONTRACT_VERSION = 1;
export const GRYPE_VERSION = "0.116.0";
export const GRYPE_IMAGE =
  "ghcr.io/anchore/grype:v0.116.0@sha256:fd4ab4d1042b522c896e73bdf09ab8bf384fa417df99d6dd0d6e1008c7e7c821";
export const GRYPE_DB_ARCHIVE_URL =
  "https://grype.anchore.io/databases/v6/vulnerability-db_v6.1.9_2026-07-26T00:41:33Z_1785049634.tar.zst";
export const GRYPE_DB_ARCHIVE_SHA256 =
  "766bec0ec8f8f0a475b1cd2dfd8f2f6a2883346963600816ce89f323c96c70bc";
export const GRYPE_DB_SCHEMA_VERSION = "v6.1.9";
export const GRYPE_DB_BUILT = "2026-07-26T07:07:14Z";
export const GRYPE_SOURCE_REFERENCE =
  "sbom:/input/container-runtime.sbom.syft.json";
export const GRYPE_SOURCE_TARGET =
  "/input/container-runtime.sbom.syft.json";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const WORKFLOW = resolve(ROOT, ".github/workflows/container-runtime-oci.yml");
const PACKAGE_JSON = resolve(ROOT, "package.json");
const DATABASE_METADATA = resolve(
  ROOT,
  "config/container-runtime-vulnerability-db.json",
);
const MAX_SCAN_BYTES = 128 * 1024 * 1024;
const MAX_SBOM_REPORT_BYTES = 2 * 1024 * 1024;
const MAX_DB_STATUS_BYTES = 64 * 1024;
const MAX_DB_METADATA_BYTES = 64 * 1024;
const MAX_DB_ARCHIVE_BYTES = 512 * 1024 * 1024;
const LOCAL_EVIDENCE_SCOPE = "local-vulnerability-scan-only";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const RFC3339_UTC_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const SEVERITIES = [
  "Unknown",
  "Negligible",
  "Low",
  "Medium",
  "High",
  "Critical",
];

export function parseArgs(argv) {
  const options = {
    selfTest: false,
    scanA: null,
    scanB: null,
    sbomReport: null,
    dbStatusA: null,
    dbStatusB: null,
    dbArchive: null,
    dbMetadata: null,
    observedAt: null,
    json: false,
  };
  const pathFlags = new Map([
    ["--scan-a", "scanA"],
    ["--scan-b", "scanB"],
    ["--sbom-report", "sbomReport"],
    ["--db-status-a", "dbStatusA"],
    ["--db-status-b", "dbStatusB"],
    ["--db-archive", "dbArchive"],
    ["--db-metadata", "dbMetadata"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--self-test") {
      options.selfTest = true;
    } else if (argument === "--json") {
      options.json = true;
    } else if (argument === "--observed-at") {
      options.observedAt = argv[index + 1] ?? null;
      index += 1;
    } else if (pathFlags.has(argument)) {
      options[pathFlags.get(argument)] = argv[index + 1] ?? null;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }

  const required = [
    options.scanA,
    options.scanB,
    options.sbomReport,
    options.dbStatusA,
    options.dbStatusB,
    options.dbArchive,
    options.dbMetadata,
    options.observedAt,
  ];
  const realGateSelected = required.every((value) => value !== null);
  const anyRealGateValue = required.some((value) => value !== null);
  if (
    options.selfTest === realGateSelected ||
    (anyRealGateValue && !realGateSelected)
  ) {
    throw new Error(
      "select --self-test or every vulnerability gate evidence argument",
    );
  }
  for (const value of required.slice(0, -1)) {
    if (value !== null && !validPath(value)) {
      throw new Error(
        "input path must be bounded, contain no NUL, and must not start with '-'",
      );
    }
  }
  if (
    options.observedAt !== null &&
    !RFC3339_UTC_PATTERN.test(options.observedAt)
  ) {
    throw new Error("--observed-at must be a UTC RFC3339 second");
  }
  return options;
}

export async function auditRepositoryContract() {
  const [workflowText, packageJsonText, metadataText] = await Promise.all([
    readFile(WORKFLOW, "utf8"),
    readFile(PACKAGE_JSON, "utf8"),
    readFile(DATABASE_METADATA, "utf8"),
  ]);
  const workflow = workflowText.replaceAll("\r\n", "\n");
  const packageJson = JSON.parse(packageJsonText);
  const metadata = parseJsonObject(
    Buffer.from(metadataText),
    "vulnerability database metadata",
  );
  validateDatabaseMetadata(metadata);

  requireCondition(
    workflow.includes(`GRYPE_IMAGE: ${GRYPE_IMAGE}`) &&
      workflow.includes(
        `GRYPE_DB_ARCHIVE_URL: ${GRYPE_DB_ARCHIVE_URL}`,
      ) &&
      workflow.includes(
        `GRYPE_DB_ARCHIVE_SHA256: ${GRYPE_DB_ARCHIVE_SHA256}`,
      ) &&
      workflow.includes(
        `GRYPE_DB_SCHEMA_VERSION: ${GRYPE_DB_SCHEMA_VERSION}`,
      ) &&
      workflow.includes(`GRYPE_DB_BUILT: "${GRYPE_DB_BUILT}"`) &&
      workflow.includes(
        "config/container-runtime-vulnerability-db.json",
      ),
    "vulnerability workflow and metadata must pin one scanner and database",
  );
  requireCondition(
    /^ghcr\.io\/anchore\/grype:v[0-9.]+@sha256:[a-f0-9]{64}$/.test(
      GRYPE_IMAGE,
    ) &&
      workflow.includes(
        'docker pull --platform linux/amd64 "${GRYPE_IMAGE}"',
      ) &&
      workflow.includes('docker image inspect "${GRYPE_IMAGE}"'),
    "vulnerability workflow must pull and record the pinned Grype image",
  );
  requireCondition(
    countMatches(workflow, /^\s*import_database\s+\\$/gm) === 2 &&
      countMatches(workflow, /^\s*scan_sbom\s+\\$/gm) === 2 &&
      countMatches(workflow, /^\s{10}import_database\(\) \{$/gm) === 1 &&
      countMatches(workflow, /^\s{10}scan_sbom\(\) \{$/gm) === 1,
    "vulnerability workflow must independently import and scan exactly twice",
  );
  const importBlock = extractShellFunction(workflow, "import_database");
  const scanBlock = extractShellFunction(workflow, "scan_sbom");
  validateImportFunction(importBlock);
  validateScanFunction(scanBlock);
  requireCondition(
    workflow.includes("--proto '=https'") &&
      workflow.includes("--tlsv1.2") &&
      workflow.includes("--retry 5") &&
      workflow.includes('"${GRYPE_DB_ARCHIVE_URL}"') &&
      workflow.includes(
        'echo "${GRYPE_DB_ARCHIVE_SHA256}  ${GRYPE_DB_ARCHIVE}" | sha256sum --check --strict -',
      ) &&
      workflow.includes(
        "node tools/verify_container_runtime_vulnerabilities.mjs",
      ) &&
      workflow.includes("--observed-at") &&
      workflow.includes("container-runtime-vulnerability-verification.json") &&
      workflow.includes("retention-days: 30") &&
      workflow.includes("if: always()"),
    "vulnerability workflow must verify and retain scanner, DB, and decision evidence",
  );
  requireCondition(
    workflow.includes("permissions:\n  contents: read") &&
      !/\bid-token:\s*write\b/i.test(workflow) &&
      !/\bpackages:\s*write\b/i.test(workflow) &&
      !/\$\{\{\s*secrets\./i.test(workflow) &&
      !/docker login|registry login|cosign sign|wrangler|cloudflare api|customer traffic/i.test(
        workflow,
      ),
    "vulnerability workflow must remain credential-free and read-only",
  );
  requireCondition(
    packageJson.scripts[
      "check:container-runtime:vulnerabilities-contract"
    ]?.includes("tests/container-runtime-vulnerability-gate.test.mjs") &&
      packageJson.scripts[
        "check:container-runtime:vulnerabilities-contract"
      ]?.includes("--self-test") &&
      packageJson.scripts["check:container-runtime:vulnerabilities"] ===
        "node tools/verify_container_runtime_vulnerabilities.mjs" &&
      packageJson.scripts.check?.includes(
        "check:container-runtime:vulnerabilities-contract",
      ) &&
      !packageJson.scripts.check?.includes(
        "check:container-runtime:vulnerabilities &&",
      ),
    "package scripts must separate offline vulnerability checks from Linux evidence",
  );

  return {
    contractVersion: VULNERABILITY_GATE_CONTRACT_VERSION,
    status: "passed",
    reportKind: "container-runtime-vulnerability-contract-audit",
    decision: {
      scope: LOCAL_EVIDENCE_SCOPE,
      formalP5Evidence: false,
      vulnerabilityDecision: "not-performed",
      productionDecision: "not-authorized",
    },
    scanner: {
      image: GRYPE_IMAGE,
      version: GRYPE_VERSION,
      imagePinnedByDigest: true,
      networkDisabledDuringImportAndScan: true,
      runsAsRoot: false,
      independentDatabaseImportsRequired: 2,
      independentScansRequired: 2,
      exactScanBytesRequired: true,
    },
    database: metadata,
    generatedSbomPresent: false,
    generatedProvenancePresent: false,
    vulnerabilityScanPresent: false,
    unapprovedCriticalVulnerabilities: null,
    unapprovedHighVulnerabilities: null,
    canonicalContainerImageDigest: null,
    imageSignatureVerificationPerformed: false,
    imageSignatureVerified: false,
    registryDigestAuthorized: false,
    registryReadbackVerified: false,
    cloudflareDeploymentDigestVerified: false,
    transparencyLogVerified: false,
    wormRetentionVerified: false,
    p5SbomSourceGenerated: false,
    p5Eligible: false,
    remoteMutationAuthorized: false,
    customerTrafficAuthorized: false,
    productionCutoverAuthorized: false,
  };
}

export function validateImportFunction(block) {
  validateDockerFunction(
    block,
    [
      "local database_root=\"$1\"",
      "mkdir -p \"${database_root}\"",
      "docker run --rm",
      "--pull never",
      "--platform linux/amd64",
      "--network none",
      "--read-only",
      "--cap-drop ALL",
      "--security-opt no-new-privileges=true",
      '--user "$(id -u):$(id -g)"',
      "--pids-limit 256",
      "--memory 2g",
      "--cpus 2",
      "--ulimit nofile=1024:1024",
      "--ulimit fsize=2147483648:2147483648",
      "--tmpfs /tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777",
      "--env HOME=/tmp",
      "--env XDG_CACHE_HOME=/tmp/cache",
      "--env GRYPE_CHECK_FOR_APP_UPDATE=false",
      "--env GRYPE_DB_AUTO_UPDATE=false",
      "--env GRYPE_DB_VALIDATE_BY_HASH_ON_START=true",
      "--env GRYPE_DB_VALIDATE_AGE=false",
      "--env GRYPE_DB_REQUIRE_UPDATE_CHECK=false",
      "--env GRYPE_DB_CACHE_DIR=/grype-db",
      '--mount "type=bind,src=${GRYPE_DB_ARCHIVE},dst=/input/grype-db.tar.zst,readonly"',
      '--mount "type=bind,src=${database_root},dst=/grype-db"',
      '"${GRYPE_IMAGE}"',
      "db import /input/grype-db.tar.zst",
    ],
    2,
    "database importer",
  );
  validateDockerRuntimeCounts(block, 1, 2, "database importer");
}

export function validateScanFunction(block) {
  validateDockerFunction(
    block,
    [
      "local database_root=\"$1\"",
      "local sbom_file=\"$2\"",
      "local status_file=\"$3\"",
      "local output_file=\"$4\"",
      ': > "${status_file}"',
      ': > "${output_file}"',
      "docker run --rm",
      "--pull never",
      "--platform linux/amd64",
      "--network none",
      "--read-only",
      "--cap-drop ALL",
      "--security-opt no-new-privileges=true",
      '--user "$(id -u):$(id -g)"',
      "--pids-limit 256",
      "--memory 2g",
      "--cpus 2",
      "--ulimit nofile=1024:1024",
      "--ulimit fsize=134217728:134217728",
      "--tmpfs /tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777",
      "--env HOME=/tmp",
      "--env XDG_CACHE_HOME=/tmp/cache",
      "--env GRYPE_CHECK_FOR_APP_UPDATE=false",
      "--env GRYPE_DB_AUTO_UPDATE=false",
      "--env GRYPE_DB_VALIDATE_BY_HASH_ON_START=true",
      "--env GRYPE_DB_VALIDATE_AGE=false",
      "--env GRYPE_DB_REQUIRE_UPDATE_CHECK=false",
      "--env GRYPE_DB_CACHE_DIR=/grype-db",
      "--env GRYPE_TIMESTAMP=false",
      '--mount "type=bind,src=${database_root},dst=/grype-db"',
      '--mount "type=bind,src=${sbom_file},dst=/input/container-runtime.sbom.syft.json,readonly"',
      '"${GRYPE_IMAGE}"',
      "db status --output json",
      `"${GRYPE_SOURCE_REFERENCE}"`,
      "--output json=/output/container-runtime.vulnerabilities.grype.json",
    ],
    4,
    "vulnerability scanner",
  );
  validateDockerRuntimeCounts(block, 2, 4, "vulnerability scanner");
  requireCondition(
    !/--ignore\b|--ignore-states\b|--only-fixed\b|--only-notfixed\b|--exclude\b|--vex\b|--vex-add\b|--add-cpes-if-none\b/i.test(
      block,
    ),
    "vulnerability scanner must not suppress or synthesize findings",
  );
}

function validateDockerFunction(block, fragments, maximumMounts, label) {
  requireCondition(
    typeof block === "string" && block.length <= 32 * 1024,
    `${label} must be a bounded static shell block`,
  );
  for (const fragment of fragments) {
    requireCondition(
      block.includes(fragment),
      `${label} must contain ${fragment}`,
    );
  }
  requireCondition(
    countMatches(block, /--mount /g) <= maximumMounts &&
      !/--privileged\b|--cap-add\b|--device\b|--network(?:=|\s+)(?:host|bridge)\b|--user(?:=|\s+)0(?::0)?\b|--pid(?:=|\s+)host\b|--ipc(?:=|\s+)host\b|--uts(?:=|\s+)host\b|--entrypoint\b|seccomp=unconfined|apparmor=unconfined|docker\.sock|type=volume|src=\/(?:,|")/i.test(
        block,
      ),
    `${label} contains an unsafe Docker option`,
  );
}

function validateDockerRuntimeCounts(
  block,
  expectedRuns,
  expectedMounts,
  label,
) {
  for (const fragment of [
    "docker run --rm",
    "--pull never",
    "--platform linux/amd64",
    "--network none",
    "--read-only",
    "--cap-drop ALL",
    "--security-opt no-new-privileges=true",
    '--user "$(id -u):$(id -g)"',
    "--pids-limit 256",
    "--memory 2g",
    "--cpus 2",
    "--ulimit nofile=1024:1024",
    "--tmpfs /tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777",
    "--env HOME=/tmp",
    "--env XDG_CACHE_HOME=/tmp/cache",
    "--env GRYPE_CHECK_FOR_APP_UPDATE=false",
    "--env GRYPE_DB_AUTO_UPDATE=false",
    "--env GRYPE_DB_VALIDATE_BY_HASH_ON_START=true",
    "--env GRYPE_DB_VALIDATE_AGE=false",
    "--env GRYPE_DB_REQUIRE_UPDATE_CHECK=false",
    "--env GRYPE_DB_CACHE_DIR=/grype-db",
    '"${GRYPE_IMAGE}"',
  ]) {
    requireCondition(
      countMatches(block, new RegExp(escapeRegex(fragment), "g")) ===
        expectedRuns,
      `${label} must apply ${fragment} to every container`,
    );
  }
  requireCondition(
    countMatches(block, /--mount /g) === expectedMounts,
    `${label} must expose exactly ${expectedMounts} bounded mounts`,
  );
}

export async function runVulnerabilityGate(paths) {
  await auditRepositoryContract();
  const [
    scanABytes,
    scanBBytes,
    sbomReportBytes,
    dbStatusABytes,
    dbStatusBBytes,
    metadataBytes,
    archive,
  ] = await Promise.all([
    readBoundedFile(paths.scanA, MAX_SCAN_BYTES, "Grype scan A"),
    readBoundedFile(paths.scanB, MAX_SCAN_BYTES, "Grype scan B"),
    readBoundedFile(
      paths.sbomReport,
      MAX_SBOM_REPORT_BYTES,
      "SBOM verification report",
    ),
    readBoundedFile(
      paths.dbStatusA,
      MAX_DB_STATUS_BYTES,
      "Grype DB status A",
    ),
    readBoundedFile(
      paths.dbStatusB,
      MAX_DB_STATUS_BYTES,
      "Grype DB status B",
    ),
    readBoundedFile(
      paths.dbMetadata,
      MAX_DB_METADATA_BYTES,
      "vulnerability database metadata",
    ),
    hashBoundedFile(
      paths.dbArchive,
      MAX_DB_ARCHIVE_BYTES,
      "Grype DB archive",
    ),
  ]);
  requireCondition(
    scanABytes.equals(scanBBytes),
    "independent vulnerability scans are not byte-identical",
  );
  requireCondition(
    dbStatusABytes.equals(dbStatusBBytes),
    "independent vulnerability database statuses are not byte-identical",
  );

  const metadata = parseJsonObject(
    metadataBytes,
    "vulnerability database metadata",
  );
  validateDatabaseMetadata(metadata);
  requireCondition(
    archive.sha256 === metadata.archiveSha256,
    "vulnerability database archive hash does not match the frozen metadata",
  );
  const dbStatus = parseJsonObject(
    dbStatusABytes,
    "Grype database status",
  );
  const dbFacts = validateDatabaseStatus(
    dbStatus,
    metadata,
    paths.observedAt,
  );
  const sbomReport = parseJsonObject(
    sbomReportBytes,
    "SBOM verification report",
  );
  const sbomFacts = validateSbomReport(sbomReport);
  const scan = parseJsonObject(scanABytes, "Grype vulnerability scan");
  const scanFacts = validateGrypeScan(scan);
  return buildVulnerabilityDecision({
    archive,
    dbFacts,
    metadata,
    observedAt: paths.observedAt,
    sbomFacts,
    scanFacts,
    scanSha256: sha256Hex(scanABytes),
    scanBytes: scanABytes.length,
  });
}

export function validateDatabaseMetadata(metadata) {
  requireAllowedKeys(
    metadata,
    [
      "contractVersion",
      "provider",
      "sourceLatestUrl",
      "listingObservedAt",
      "listingSha256",
      "archiveUrl",
      "archiveSha256",
      "schemaVersion",
      "built",
      "maximumCandidateAgeSeconds",
      "policy",
    ],
    "vulnerability database metadata",
  );
  requireCondition(
    metadata.contractVersion === VULNERABILITY_GATE_CONTRACT_VERSION &&
      metadata.provider === "anchore-grype-db-v6" &&
      metadata.sourceLatestUrl ===
        "https://grype.anchore.io/databases/v6/latest.json" &&
      validUtcTimestamp(metadata.listingObservedAt) &&
      validSha256(metadata.listingSha256) &&
      metadata.archiveUrl === GRYPE_DB_ARCHIVE_URL &&
      metadata.archiveSha256 === GRYPE_DB_ARCHIVE_SHA256 &&
      metadata.schemaVersion === GRYPE_DB_SCHEMA_VERSION &&
      metadata.built === GRYPE_DB_BUILT &&
      Number.isSafeInteger(metadata.maximumCandidateAgeSeconds) &&
      metadata.maximumCandidateAgeSeconds > 0 &&
      metadata.maximumCandidateAgeSeconds <= 7 * 24 * 60 * 60,
    "vulnerability database metadata does not match the frozen DB",
  );
  const policy = requireObject(
    metadata.policy,
    "vulnerability database policy",
  );
  requireAllowedKeys(
    policy,
    ["blockedSeverities", "approvedFindings"],
    "vulnerability database policy",
  );
  requireCondition(
    Array.isArray(policy.blockedSeverities) &&
      policy.blockedSeverities.length === 2 &&
      policy.blockedSeverities[0] === "Critical" &&
      policy.blockedSeverities[1] === "High" &&
      Array.isArray(policy.approvedFindings) &&
      policy.approvedFindings.length === 0,
    "initial vulnerability policy must block all high/critical findings without ignores",
  );
  return metadata;
}

export function validateDatabaseStatus(status, metadata, observedAt) {
  requireAllowedKeys(
    status,
    ["schemaVersion", "from", "built", "path", "valid", "error"],
    "Grype database status",
  );
  requireCondition(
    status.schemaVersion === metadata.schemaVersion &&
      status.built === metadata.built &&
      status.valid === true &&
      status.error === undefined &&
      typeof status.path === "string" &&
      status.path.startsWith("/grype-db/") &&
      status.path.length <= 4096,
    "Grype database status is invalid or does not bind the frozen database",
  );
  const builtMs = Date.parse(metadata.built);
  const observedMs = Date.parse(observedAt);
  requireCondition(
    Number.isFinite(observedMs) &&
      observedMs >= builtMs &&
      observedMs - builtMs <=
        metadata.maximumCandidateAgeSeconds * 1000,
    "vulnerability database is outside the candidate freshness window",
  );
  return {
    schemaVersion: status.schemaVersion,
    built: status.built,
    path: status.path,
    valid: true,
    ageSeconds: Math.floor((observedMs - builtMs) / 1000),
  };
}

export function validateSbomReport(report) {
  const subject = requireObject(report.subject, "SBOM report subject");
  const sbom = requireObject(report.sbom, "SBOM report catalog");
  const decision = requireObject(report.decision, "SBOM report decision");
  requireCondition(
    report.contractVersion === 1 &&
      report.status === "passed" &&
      report.reportKind === "container-runtime-sbom-reproducibility" &&
      decision.scope === "local-sbom-reproducibility-only" &&
      decision.formalP5Evidence === false &&
      report.generatedSbomPresent === true &&
      report.vulnerabilityScanPresent === false &&
      report.unapprovedCriticalVulnerabilities === null &&
      report.unapprovedHighVulnerabilities === null &&
      report.p5Eligible === false &&
      report.productionCutoverAuthorized === false,
    "SBOM report is not an accepted fail-closed S1 result",
  );
  for (const [label, value] of [
    ["archive SHA-256", subject.archiveSha256],
    ["runtime binary SHA-256", subject.runtimeBinarySha256],
    ["SBOM SHA-256", sbom.sha256],
  ]) {
    requireCondition(validSha256(value), `${label} is invalid`);
  }
  for (const [label, value] of [
    ["OCI index digest", subject.ociIndexDigest],
    ["OCI manifest digest", subject.ociManifestDigest],
    ["OCI config digest", subject.ociConfigDigest],
  ]) {
    requireCondition(validDigest(value), `${label} is invalid`);
  }
  requireCondition(
    sbom.format === "syft-json" &&
      sbom.exactIndependentMatch === true &&
      Number.isSafeInteger(sbom.bytes) &&
      sbom.bytes > 0 &&
      Number.isSafeInteger(sbom.packageCount) &&
      sbom.packageCount > 0,
    "SBOM report catalog facts are invalid",
  );
  return {
    archiveSha256: subject.archiveSha256,
    ociIndexDigest: subject.ociIndexDigest,
    ociManifestDigest: subject.ociManifestDigest,
    ociConfigDigest: subject.ociConfigDigest,
    runtimeBinarySha256: subject.runtimeBinarySha256,
    sbomSha256: sbom.sha256,
    sbomBytes: sbom.bytes,
    packageCount: sbom.packageCount,
  };
}

export function validateGrypeScan(scan) {
  requireAllowedKeys(
    scan,
    [
      "matches",
      "ignoredMatches",
      "alertsByPackage",
      "source",
      "distro",
      "descriptor",
    ],
    "Grype scan",
  );
  const descriptor = requireObject(scan.descriptor, "Grype descriptor");
  requireCondition(
    descriptor.name === "grype" &&
      descriptor.version === GRYPE_VERSION &&
      (descriptor.timestamp === undefined || descriptor.timestamp === ""),
    "Grype descriptor identity or deterministic timestamp policy is invalid",
  );
  validateGrypeConfiguration(descriptor.configuration);
  const descriptorDatabase = requireObject(
    descriptor.db,
    "Grype descriptor database",
  );
  requireCondition(
    descriptorDatabase.schemaVersion === GRYPE_DB_SCHEMA_VERSION &&
      descriptorDatabase.built === GRYPE_DB_BUILT &&
      descriptorDatabase.valid === true &&
      descriptorDatabase.error === undefined,
    "Grype scan descriptor does not bind the frozen valid database",
  );
  const source = requireObject(scan.source, "Grype source");
  requireCondition(
    source.type === "sbom-file" && source.target === GRYPE_SOURCE_TARGET,
    "Grype scan is not bound to the expected SBOM file",
  );
  requireObject(scan.distro, "Grype distro");
  const ignoredMatches =
    scan.ignoredMatches === undefined
      ? []
      : requireArray(scan.ignoredMatches, "Grype ignored matches");
  requireCondition(
    ignoredMatches.length === 0,
    "vulnerability scan contains ignored findings without an approval policy",
  );
  const matches = requireArray(scan.matches, "Grype matches");
  requireCondition(
    matches.length <= 1_000_000,
    "Grype match inventory exceeds the bound",
  );
  const severityCounts = Object.fromEntries(
    SEVERITIES.map((severity) => [severity, 0]),
  );
  const findingKeys = new Set();
  for (const [index, rawMatch] of matches.entries()) {
    const match = requireObject(rawMatch, `Grype match ${index}`);
    const vulnerability = requireObject(
      match.vulnerability,
      `Grype match ${index} vulnerability`,
    );
    const artifact = requireObject(
      match.artifact,
      `Grype match ${index} artifact`,
    );
    requireBoundedString(
      vulnerability.id,
      `Grype match ${index} vulnerability ID`,
      1024,
    );
    requireCondition(
      SEVERITIES.includes(vulnerability.severity),
      `Grype match ${index} severity is invalid`,
    );
    for (const [label, value] of [
      ["artifact ID", artifact.id],
      ["artifact name", artifact.name],
      ["artifact version", artifact.version],
      ["artifact type", artifact.type],
    ]) {
      requireBoundedString(
        value,
        `Grype match ${index} ${label}`,
        8192,
      );
    }
    requireCondition(
      Array.isArray(match.matchDetails) &&
        match.matchDetails.length > 0 &&
        match.matchDetails.length <= 100_000,
      `Grype match ${index} details are invalid`,
    );
    const namespace =
      typeof vulnerability.namespace === "string"
        ? vulnerability.namespace
        : "";
    const key = [
      vulnerability.id,
      namespace,
      artifact.id,
    ].join("\0");
    requireCondition(
      !findingKeys.has(key),
      "Grype scan contains duplicate vulnerability findings",
    );
    findingKeys.add(key);
    severityCounts[vulnerability.severity] += 1;
  }
  return {
    matchCount: matches.length,
    uniqueFindingCount: findingKeys.size,
    ignoredMatchCount: ignoredMatches.length,
    severityCounts,
  };
}

function validateGrypeConfiguration(configuration) {
  const value = requireObject(
    configuration,
    "Grype descriptor configuration",
  );
  for (const key of [
    "ignore",
    "vex-documents",
    "vex-add",
    "exclude",
  ]) {
    if (value[key] !== undefined) {
      requireCondition(
        Array.isArray(value[key]) && value[key].length === 0,
        `Grype configuration ${key} must be empty`,
      );
    }
  }
  for (const key of ["only-fixed", "only-notfixed", "add-cpes-if-none"]) {
    requireCondition(
      value[key] === undefined || value[key] === false,
      `Grype configuration ${key} must be false`,
    );
  }
  requireCondition(
    value.timestamp === false &&
      value["check-for-app-update"] === false,
    "Grype configuration must disable timestamps and update checks",
  );
  const database = requireObject(
    value.db,
    "Grype descriptor database configuration",
  );
  requireCondition(
    database["auto-update"] === false &&
      database["validate-by-hash-on-start"] === true &&
      database["validate-age"] === false &&
      database["require-update-check"] === false &&
      database["cache-dir"] === "/grype-db",
    "Grype database configuration is not deterministic and offline",
  );
}

export function buildVulnerabilityDecision(facts) {
  const unapprovedCritical =
    facts.scanFacts.severityCounts.Critical;
  const unapprovedHigh = facts.scanFacts.severityCounts.High;
  const policyPassed =
    unapprovedCritical === 0 && unapprovedHigh === 0;
  return {
    contractVersion: VULNERABILITY_GATE_CONTRACT_VERSION,
    status: policyPassed ? "passed" : "failed",
    reportKind: "container-runtime-vulnerability-decision",
    decision: {
      scope: LOCAL_EVIDENCE_SCOPE,
      formalP5Evidence: false,
      vulnerabilityDecision: policyPassed
        ? "passed-zero-unapproved-high-critical"
        : "failed-unapproved-high-critical",
      productionDecision: "not-authorized",
    },
    subject: facts.sbomFacts,
    scanner: {
      image: GRYPE_IMAGE,
      name: "grype",
      version: GRYPE_VERSION,
      inputReference: GRYPE_SOURCE_REFERENCE,
      sourceTarget: GRYPE_SOURCE_TARGET,
      networkDisabled: true,
      runsAsRoot: false,
      exactIndependentMatch: true,
    },
    database: {
      provider: facts.metadata.provider,
      sourceLatestUrl: facts.metadata.sourceLatestUrl,
      listingObservedAt: facts.metadata.listingObservedAt,
      listingSha256: facts.metadata.listingSha256,
      archiveUrl: facts.metadata.archiveUrl,
      archiveSha256: facts.archive.sha256,
      archiveBytes: facts.archive.bytes,
      schemaVersion: facts.dbFacts.schemaVersion,
      built: facts.dbFacts.built,
      observedAt: facts.observedAt,
      ageSeconds: facts.dbFacts.ageSeconds,
      maximumCandidateAgeSeconds:
        facts.metadata.maximumCandidateAgeSeconds,
      valid: facts.dbFacts.valid,
      exactIndependentStatusMatch: true,
    },
    scan: {
      format: "grype-json",
      sha256: facts.scanSha256,
      bytes: facts.scanBytes,
      exactIndependentMatch: true,
      ...facts.scanFacts,
    },
    generatedSbomPresent: true,
    generatedProvenancePresent: false,
    vulnerabilityScanPresent: true,
    unapprovedCriticalVulnerabilities: unapprovedCritical,
    unapprovedHighVulnerabilities: unapprovedHigh,
    canonicalContainerImageDigest: null,
    imageSignatureVerificationPerformed: false,
    imageSignatureVerified: false,
    registryDigestAuthorized: false,
    registryReadbackVerified: false,
    cloudflareDeploymentDigestVerified: false,
    transparencyLogVerified: false,
    wormRetentionVerified: false,
    p5SbomSourceGenerated: false,
    p5Eligible: false,
    remoteMutationAuthorized: false,
    customerTrafficAuthorized: false,
    productionCutoverAuthorized: false,
  };
}

async function readBoundedFile(path, maximumBytes, label) {
  const resolved = resolve(path);
  let handle;
  try {
    handle = await open(
      resolved,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
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
        after.mtimeMs === before.mtimeMs,
      `${label} changed while it was being read`,
    );
    return bytes;
  } finally {
    await handle?.close();
  }
}

async function hashBoundedFile(path, maximumBytes, label) {
  const resolved = resolve(path);
  let handle;
  try {
    handle = await open(
      resolved,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const before = await handle.stat();
    requireCondition(
      before.isFile() &&
        before.size > 0 &&
        before.size <= maximumBytes,
      `${label} must be a nonempty bounded regular file`,
    );
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const length = Math.min(buffer.length, before.size - offset);
      const { bytesRead } = await handle.read(
        buffer,
        0,
        length,
        offset,
      );
      requireCondition(bytesRead > 0, `${label} ended unexpectedly`);
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    requireCondition(
      after.size === before.size && after.mtimeMs === before.mtimeMs,
      `${label} changed while it was being hashed`,
    );
    return {
      bytes: before.size,
      sha256: hash.digest("hex"),
    };
  } finally {
    await handle?.close();
  }
}

function parseJsonObject(bytes, label) {
  let value;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} must be valid UTF-8 JSON`);
  }
  return requireObject(value, label);
}

function extractShellFunction(workflow, name) {
  const expression = new RegExp(
    `^\\s{10}${name}\\(\\) \\{\\n([\\s\\S]*?)^\\s{10}\\}$`,
    "gm",
  );
  const matches = [...workflow.matchAll(expression)];
  requireCondition(
    matches.length === 1,
    `workflow must declare exactly one ${name} function`,
  );
  return matches[0][0];
}

function validPath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1024 &&
    !value.startsWith("-") &&
    !value.includes("\0")
  );
}

function validUtcTimestamp(value) {
  return (
    typeof value === "string" &&
    RFC3339_UTC_PATTERN.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function validSha256(value) {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function validDigest(value) {
  return typeof value === "string" && SHA256_DIGEST_PATTERN.test(value);
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireBoundedString(value, label, maximumLength) {
  requireCondition(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= maximumLength &&
      !value.includes("\0"),
    `${label} must be a bounded nonempty string`,
  );
}

function requireArray(value, label) {
  requireCondition(Array.isArray(value), `${label} must be an array`);
  return value;
}

function requireAllowedKeys(value, keys, label) {
  const object = requireObject(value, label);
  const allowed = new Set(keys);
  requireCondition(
    Object.keys(object).every((key) => allowed.has(key)),
    `${label} contains an unsupported key`,
  );
}

function requireObject(value, label) {
  requireCondition(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value;
}

function countMatches(value, expression) {
  return value.match(expression)?.length ?? 0;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = options.selfTest
    ? await auditRepositoryContract()
    : await runVulnerabilityGate({
        scanA: options.scanA,
        scanB: options.scanB,
        sbomReport: options.sbomReport,
        dbStatusA: options.dbStatusA,
        dbStatusB: options.dbStatusB,
        dbArchive: options.dbArchive,
        dbMetadata: options.dbMetadata,
        observedAt: options.observedAt,
      });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(
      `container runtime vulnerability gate: ${report.status}\n`,
    );
  }
  if (report.status !== "passed") process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(
      `container runtime vulnerability gate failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
