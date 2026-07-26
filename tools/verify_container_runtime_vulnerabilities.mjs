import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const VULNERABILITY_GATE_CONTRACT_VERSION = 1;
export const GRYPE_VERSION = "0.116.0";
export const GRYPE_IMAGE =
  "ghcr.io/anchore/grype:v0.116.0@sha256:fd4ab4d1042b522c896e73bdf09ab8bf384fa417df99d6dd0d6e1008c7e7c821";
export const GRYPE_IMAGE_INDEX_DIGEST =
  "sha256:fd4ab4d1042b522c896e73bdf09ab8bf384fa417df99d6dd0d6e1008c7e7c821";
export const GRYPE_IMAGE_AMD64_MANIFEST_DIGEST =
  "sha256:3d08845e24eba657b8ea9bd28344a5a4e9dcd772818062a6522bf30137928616";
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
const DATABASE_LISTING = resolve(
  ROOT,
  "config/container-runtime-vulnerability-db-listing.json",
);
const VULNERABILITY_POLICY = resolve(
  ROOT,
  "config/container-runtime-vulnerability-policy.json",
);
const VULNERABILITY_APPROVALS = resolve(
  ROOT,
  "config/container-runtime-vulnerability-approvals.json",
);
const MAX_SCAN_BYTES = 128 * 1024 * 1024;
const MAX_SBOM_BYTES = 128 * 1024 * 1024;
const MAX_SBOM_REPORT_BYTES = 2 * 1024 * 1024;
const MAX_DB_STATUS_BYTES = 64 * 1024;
const MAX_DB_METADATA_BYTES = 64 * 1024;
const MAX_DB_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_DB_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_DB_IMPORT_BYTES = 64 * 1024;
const MAX_SCANNER_IDENTITY_BYTES = 2 * 1024 * 1024;
const MAX_POLICY_BYTES = 64 * 1024;
const GRYPE_DB_FILE_PATH = "/grype-db/6/vulnerability.db";
const SYFT_SOURCE_INPUT = "/input/container-runtime.tar";
const OCI_MANIFEST_MEDIA_TYPE =
  "application/vnd.oci.image.manifest.v1+json";
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
    sbomA: null,
    sbomB: null,
    sbomReport: null,
    dbStatusA: null,
    dbStatusB: null,
    dbArchive: null,
    dbFileA: null,
    dbFileB: null,
    dbImportA: null,
    dbImportB: null,
    dbMetadata: null,
    dbListing: null,
    policy: null,
    approvals: null,
    scannerIndex: null,
    scannerInspect: null,
    observedAt: null,
    json: false,
  };
  const pathFlags = new Map([
    ["--scan-a", "scanA"],
    ["--scan-b", "scanB"],
    ["--sbom-a", "sbomA"],
    ["--sbom-b", "sbomB"],
    ["--sbom-report", "sbomReport"],
    ["--db-status-a", "dbStatusA"],
    ["--db-status-b", "dbStatusB"],
    ["--db-archive", "dbArchive"],
    ["--db-file-a", "dbFileA"],
    ["--db-file-b", "dbFileB"],
    ["--db-import-a", "dbImportA"],
    ["--db-import-b", "dbImportB"],
    ["--db-metadata", "dbMetadata"],
    ["--db-listing", "dbListing"],
    ["--policy", "policy"],
    ["--approvals", "approvals"],
    ["--scanner-index", "scannerIndex"],
    ["--scanner-inspect", "scannerInspect"],
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
    options.sbomA,
    options.sbomB,
    options.sbomReport,
    options.dbStatusA,
    options.dbStatusB,
    options.dbArchive,
    options.dbFileA,
    options.dbFileB,
    options.dbImportA,
    options.dbImportB,
    options.dbMetadata,
    options.dbListing,
    options.policy,
    options.approvals,
    options.scannerIndex,
    options.scannerInspect,
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
  const [
    workflowText,
    packageJsonText,
    metadataText,
    listingBytes,
    policyText,
    approvalsText,
  ] = await Promise.all([
    readFile(WORKFLOW, "utf8"),
    readFile(PACKAGE_JSON, "utf8"),
    readFile(DATABASE_METADATA, "utf8"),
    readFile(DATABASE_LISTING),
    readFile(VULNERABILITY_POLICY, "utf8"),
    readFile(VULNERABILITY_APPROVALS, "utf8"),
  ]);
  const workflow = workflowText.replaceAll("\r\n", "\n");
  const packageJson = JSON.parse(packageJsonText);
  const metadata = parseJsonObject(
    Buffer.from(metadataText),
    "vulnerability database metadata",
  );
  validateDatabaseMetadata(metadata);
  const listing = parseJsonObject(
    listingBytes,
    "vulnerability database listing snapshot",
  );
  const listingFacts = validateDatabaseListing(listing, metadata, listingBytes);
  const policy = validateVulnerabilityPolicy(
    parseJsonObject(
      Buffer.from(policyText),
      "container vulnerability policy",
    ),
  );
  const approvals = validateVulnerabilityApprovals(
    parseJsonObject(
      Buffer.from(approvalsText),
      "container vulnerability approvals",
    ),
    policy,
  );

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
        `GRYPE_IMAGE_INDEX_DIGEST: ${GRYPE_IMAGE_INDEX_DIGEST}`,
      ) &&
      workflow.includes(
        `GRYPE_IMAGE_AMD64_MANIFEST_DIGEST: ${GRYPE_IMAGE_AMD64_MANIFEST_DIGEST}`,
      ) &&
      workflow.includes(
        "config/container-runtime-vulnerability-db.json",
      ) &&
      workflow.includes(
        "config/container-runtime-vulnerability-db-listing.json",
      ) &&
      workflow.includes(
        "config/container-runtime-vulnerability-policy.json",
      ) &&
      workflow.includes(
        "config/container-runtime-vulnerability-approvals.json",
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
      workflow.includes(
        'docker buildx imagetools inspect --raw "${GRYPE_IMAGE}"',
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
  for (const fragment of [
    '"${EVIDENCE_DIR}/grype-db-a"',
    '"${EVIDENCE_DIR}/grype-db-b"',
    '"${EVIDENCE_DIR}/sbom-a/container-runtime.sbom.syft.json"',
    '"${EVIDENCE_DIR}/sbom-b/container-runtime.sbom.syft.json"',
    '--db-file-a "${EVIDENCE_DIR}/grype-db-a/6/vulnerability.db"',
    '--db-file-b "${EVIDENCE_DIR}/grype-db-b/6/vulnerability.db"',
    '--db-import-a "${EVIDENCE_DIR}/grype-db-a/6/import.json"',
    '--db-import-b "${EVIDENCE_DIR}/grype-db-b/6/import.json"',
  ]) {
    requireCondition(
      workflow.includes(fragment),
      `vulnerability workflow must bind independent A/B evidence via ${fragment}`,
    );
  }
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
      workflow.includes("--sbom-a") &&
      workflow.includes("--db-file-a") &&
      workflow.includes("--db-import-a") &&
      workflow.includes("--scanner-index") &&
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
      actualSbomBytesRequired: true,
      actualDatabaseBytesRequired: true,
      databaseReadOnlyDuringScan: true,
      suppressedFindingsVisible: true,
    },
    database: {
      ...metadata,
      listing: listingFacts,
    },
    policy: {
      ...policy,
      approvalCount: approvals.length,
    },
    generatedSbomPresent: false,
    generatedProvenancePresent: false,
    vulnerabilityScanPresent: false,
    unapprovedUnknownVulnerabilities: null,
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
      "--env GRYPE_DB_VALIDATE_AGE=true",
      "--env GRYPE_DB_MAX_ALLOWED_BUILT_AGE=48h",
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
  const commands = extractDockerRuns(block);
  requireCondition(
    commands.length === 1,
    "database importer must contain exactly one Docker run",
  );
  validateDockerRun(
    commands[0],
    [
      '--mount "type=bind,src=${GRYPE_DB_ARCHIVE},dst=/input/grype-db.tar.zst,readonly"',
      '--mount "type=bind,src=${database_root},dst=/grype-db"',
    ],
    "database importer",
  );
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
      "--env GRYPE_DB_VALIDATE_AGE=true",
      "--env GRYPE_DB_MAX_ALLOWED_BUILT_AGE=48h",
      "--env GRYPE_DB_REQUIRE_UPDATE_CHECK=false",
      "--env GRYPE_DB_CACHE_DIR=/grype-db",
      "--env GRYPE_TIMESTAMP=false",
      '--mount "type=bind,src=${database_root},dst=/grype-db,readonly"',
      '--mount "type=bind,src=${sbom_file},dst=/input/container-runtime.sbom.syft.json,readonly"',
      '"${GRYPE_IMAGE}"',
      "db status --output json",
      `"${GRYPE_SOURCE_REFERENCE}"`,
      "--show-suppressed",
      "--output json=/output/container-runtime.vulnerabilities.grype.json",
    ],
    4,
    "vulnerability scanner",
  );
  const commands = extractDockerRuns(block);
  requireCondition(
    commands.length === 2,
    "vulnerability scanner must contain exactly two Docker runs",
  );
  validateDockerRun(
    commands[0],
    ['--mount "type=bind,src=${database_root},dst=/grype-db,readonly"'],
    "database status reader",
  );
  validateDockerRun(
    commands[1],
    [
      '--mount "type=bind,src=${database_root},dst=/grype-db,readonly"',
      '--mount "type=bind,src=${sbom_file},dst=/input/container-runtime.sbom.syft.json,readonly"',
      '--mount "type=bind,src=${output_file},dst=/output/container-runtime.vulnerabilities.grype.json"',
    ],
    "vulnerability scanner",
  );
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

function validateDockerRun(command, expectedMounts, label) {
  const commonFragments = [
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
    "--env GRYPE_DB_VALIDATE_AGE=true",
    "--env GRYPE_DB_MAX_ALLOWED_BUILT_AGE=48h",
    "--env GRYPE_DB_REQUIRE_UPDATE_CHECK=false",
    "--env GRYPE_DB_CACHE_DIR=/grype-db",
    '"${GRYPE_IMAGE}"',
  ];
  for (const fragment of commonFragments) {
    requireCondition(
      countMatches(command, new RegExp(escapeRegex(fragment), "g")) === 1,
      `${label} must apply ${fragment} exactly once`,
    );
  }
  for (const mount of expectedMounts) {
    requireCondition(
      countMatches(command, new RegExp(escapeRegex(mount), "g")) === 1,
      `${label} must apply ${mount} exactly once`,
    );
  }
  requireCondition(
    countMatches(command, /--mount /g) === expectedMounts.length,
    `${label} must expose exactly ${expectedMounts.length} bounded mounts`,
  );
  const environmentNames = [
    ...command.matchAll(/--env\s+([A-Z][A-Z0-9_]*)=/g),
  ].map((match) => match[1]);
  requireCondition(
    environmentNames.length === new Set(environmentNames).size,
    `${label} contains duplicate or conflicting environment arguments`,
  );
  const mountTargets = [
    ...command.matchAll(/--mount\s+"[^"]*dst=([^,"]+)/g),
  ].map((match) => match[1]);
  requireCondition(
    mountTargets.length === new Set(mountTargets).size,
    `${label} contains duplicate or conflicting mount targets`,
  );
}

function extractDockerRuns(block) {
  const lines = block.split("\n");
  const commands = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trimStart().startsWith("docker run --rm")) continue;
    const command = [lines[index]];
    while (command.at(-1).trimEnd().endsWith("\\")) {
      index += 1;
      requireCondition(
        index < lines.length,
        "Docker command continuation escaped its function",
      );
      command.push(lines[index]);
    }
    commands.push(command.join("\n"));
  }
  return commands;
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
    listingBytes,
    policyBytes,
    approvalsBytes,
    dbImportABytes,
    dbImportBBytes,
    scannerIndexBytes,
    scannerInspectBytes,
    sbomA,
    sbomB,
    archive,
    databaseA,
    databaseB,
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
    readBoundedFile(
      paths.dbListing,
      MAX_DB_METADATA_BYTES,
      "vulnerability database listing snapshot",
    ),
    readBoundedFile(
      paths.policy,
      MAX_POLICY_BYTES,
      "container vulnerability policy",
    ),
    readBoundedFile(
      paths.approvals,
      MAX_POLICY_BYTES,
      "container vulnerability approvals",
    ),
    readBoundedFile(
      paths.dbImportA,
      MAX_DB_IMPORT_BYTES,
      "Grype DB import metadata A",
    ),
    readBoundedFile(
      paths.dbImportB,
      MAX_DB_IMPORT_BYTES,
      "Grype DB import metadata B",
    ),
    readBoundedFile(
      paths.scannerIndex,
      MAX_SCANNER_IDENTITY_BYTES,
      "Grype image index",
    ),
    readBoundedFile(
      paths.scannerInspect,
      MAX_SCANNER_IDENTITY_BYTES,
      "Grype image inspect",
    ),
    hashBoundedFile(paths.sbomA, MAX_SBOM_BYTES, "Syft SBOM A"),
    hashBoundedFile(paths.sbomB, MAX_SBOM_BYTES, "Syft SBOM B"),
    hashBoundedFile(
      paths.dbArchive,
      MAX_DB_ARCHIVE_BYTES,
      "Grype DB archive",
    ),
    hashBoundedFile(
      paths.dbFileA,
      MAX_DB_FILE_BYTES,
      "imported Grype DB A",
    ),
    hashBoundedFile(
      paths.dbFileB,
      MAX_DB_FILE_BYTES,
      "imported Grype DB B",
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
  requireCondition(
    dbImportABytes.equals(dbImportBBytes),
    "independent vulnerability database import metadata differs",
  );

  const metadata = parseJsonObject(
    metadataBytes,
    "vulnerability database metadata",
  );
  validateDatabaseMetadata(metadata);
  const listingFacts = validateDatabaseListing(
    parseJsonObject(
      listingBytes,
      "vulnerability database listing snapshot",
    ),
    metadata,
    listingBytes,
  );
  const policy = validateVulnerabilityPolicy(
    parseJsonObject(policyBytes, "container vulnerability policy"),
  );
  const approvals = validateVulnerabilityApprovals(
    parseJsonObject(approvalsBytes, "container vulnerability approvals"),
    policy,
  );
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
  validateIndependentEvidenceBindings({
    databaseA,
    databaseB,
    sbomA,
    sbomB,
    sbomFacts,
  });
  const importFacts = validateDatabaseImportMetadata(
    parseJsonObject(dbImportABytes, "Grype database import metadata"),
    metadata,
  );
  const scannerFacts = validateScannerImageIdentity(
    scannerIndexBytes,
    scannerInspectBytes,
  );
  const scan = parseJsonObject(scanABytes, "Grype vulnerability scan");
  const scanFacts = validateGrypeScan(scan, {
    dbFacts,
    metadata,
    policy,
    sbomFacts,
  });
  return buildVulnerabilityDecision({
    approvals,
    archive,
    database: databaseA,
    dbFacts,
    importFacts: {
      ...importFacts,
      sha256: sha256Hex(dbImportABytes),
      bytes: dbImportABytes.length,
      exactIndependentMatch: true,
    },
    listingFacts,
    metadata,
    observedAt: paths.observedAt,
    policy,
    scannerFacts,
    sbomInput: {
      ...sbomA,
      exactIndependentMatch: true,
    },
    sbomFacts,
    scanFacts,
    scanSha256: sha256Hex(scanABytes),
    scanBytes: scanABytes.length,
  });
}

export function validateIndependentEvidenceBindings(facts) {
  requireCondition(
    facts.sbomA.sha256 === facts.sbomB.sha256 &&
      facts.sbomA.bytes === facts.sbomB.bytes,
    "actual SBOM inputs are not byte-identical",
  );
  requireCondition(
    facts.sbomA.sha256 === facts.sbomFacts.sbomSha256 &&
      facts.sbomA.bytes === facts.sbomFacts.sbomBytes,
    "actual SBOM bytes do not match the accepted S1 report",
  );
  requireCondition(
    facts.databaseA.sha256 === facts.databaseB.sha256 &&
      facts.databaseA.bytes === facts.databaseB.bytes,
    "independently imported vulnerability database files differ",
  );
  return {
    actualSbomBytesMatch: true,
    independentDatabaseFilesMatch: true,
  };
}

export function validateDatabaseMetadata(metadata) {
  requireAllowedKeys(
    metadata,
    [
      "contractVersion",
      "provider",
      "sourceLatestUrl",
      "listingPath",
      "listingObservedAt",
      "listingSourceBytes",
      "listingSha256",
      "listingSnapshotBytes",
      "listingSnapshotSha256",
      "archiveUrl",
      "archiveSha256",
      "schemaVersion",
      "built",
      "maximumCandidateAgeSeconds",
    ],
    "vulnerability database metadata",
  );
  requireCondition(
    metadata.contractVersion === VULNERABILITY_GATE_CONTRACT_VERSION &&
      metadata.provider === "anchore-grype-db-v6" &&
      metadata.sourceLatestUrl ===
        "https://grype.anchore.io/databases/v6/latest.json" &&
      metadata.listingPath ===
        "config/container-runtime-vulnerability-db-listing.json" &&
      validUtcTimestamp(metadata.listingObservedAt) &&
      metadata.listingSourceBytes === 249 &&
      validSha256(metadata.listingSha256) &&
      metadata.listingSnapshotBytes === 250 &&
      validSha256(metadata.listingSnapshotSha256) &&
      metadata.archiveUrl === GRYPE_DB_ARCHIVE_URL &&
      metadata.archiveSha256 === GRYPE_DB_ARCHIVE_SHA256 &&
      metadata.schemaVersion === GRYPE_DB_SCHEMA_VERSION &&
      metadata.built === GRYPE_DB_BUILT &&
      Number.isSafeInteger(metadata.maximumCandidateAgeSeconds) &&
      metadata.maximumCandidateAgeSeconds > 0 &&
      metadata.maximumCandidateAgeSeconds <= 7 * 24 * 60 * 60,
    "vulnerability database metadata does not match the frozen DB",
  );
  return metadata;
}

export function validateDatabaseListing(listing, metadata, bytes) {
  requireAllowedKeys(
    listing,
    ["status", "schemaVersion", "built", "path", "checksum"],
    "vulnerability database listing snapshot",
  );
  const archiveName = new URL(metadata.archiveUrl).pathname.split("/").at(-1);
  requireCondition(
    listing.status === "active" &&
      listing.schemaVersion === metadata.schemaVersion &&
      listing.built === metadata.built &&
      listing.path === archiveName &&
      listing.checksum === `sha256:${metadata.archiveSha256}`,
    "vulnerability database listing does not bind the frozen archive",
  );
  requireCondition(
    Buffer.isBuffer(bytes) &&
      bytes.length === metadata.listingSnapshotBytes &&
      sha256Hex(bytes) === metadata.listingSnapshotSha256 &&
      bytes.at(-1) === 0x0a,
    "tracked vulnerability database listing snapshot bytes drifted",
  );
  const sourceBytes = bytes.subarray(0, -1);
  requireCondition(
    sourceBytes.length === metadata.listingSourceBytes &&
      sha256Hex(sourceBytes) === metadata.listingSha256,
    "tracked database listing does not preserve the observed source bytes",
  );
  return {
    observedAt: metadata.listingObservedAt,
    sourceBytes: sourceBytes.length,
    sourceSha256: sha256Hex(sourceBytes),
    snapshotBytes: bytes.length,
    snapshotSha256: sha256Hex(bytes),
    active: true,
  };
}

export function validateVulnerabilityPolicy(policy) {
  requireAllowedKeys(
    policy,
    [
      "contractVersion",
      "blockedSeverities",
      "unknownApprovalsAllowed",
      "criticalApprovalsAllowed",
      "highApprovalMode",
      "wildcardsAllowed",
      "requiredHighApprovalBindings",
      "approvalsPath",
    ],
    "container vulnerability policy",
  );
  const requiredBindings = [
    "vulnerabilityId",
    "namespace",
    "artifactId",
    "purl",
    "version",
    "ociManifestDigest",
    "sbomSha256",
    "scannerImage",
    "databaseArchiveSha256",
    "owner",
    "reason",
    "externalRecord",
    "expiresAt",
  ];
  requireCondition(
    policy.contractVersion === VULNERABILITY_GATE_CONTRACT_VERSION &&
      JSON.stringify(policy.blockedSeverities) ===
        JSON.stringify(["Unknown", "Critical", "High"]) &&
      policy.unknownApprovalsAllowed === false &&
      policy.criticalApprovalsAllowed === false &&
      policy.highApprovalMode === "exact-finding-only" &&
      policy.wildcardsAllowed === false &&
      JSON.stringify(policy.requiredHighApprovalBindings) ===
        JSON.stringify(requiredBindings) &&
      policy.approvalsPath ===
        "config/container-runtime-vulnerability-approvals.json",
    "container vulnerability policy is not the fail-closed S2 policy",
  );
  return policy;
}

export function validateVulnerabilityApprovals(approvals, policy) {
  requireAllowedKeys(
    approvals,
    ["contractVersion", "approvals"],
    "container vulnerability approvals",
  );
  requireCondition(
    policy.highApprovalMode === "exact-finding-only" &&
      approvals.contractVersion === VULNERABILITY_GATE_CONTRACT_VERSION &&
      Array.isArray(approvals.approvals) &&
      approvals.approvals.length === 0,
    "initial S2 policy must not contain vulnerability approvals",
  );
  return approvals.approvals;
}

export function validateDatabaseImportMetadata(importMetadata, metadata) {
  requireAllowedKeys(
    importMetadata,
    ["digest", "source", "client_version"],
    "Grype database import metadata",
  );
  requireCondition(
    /^xxh64:[a-f0-9]{16}$/.test(importMetadata.digest) &&
      importMetadata.source === "manual import" &&
      importMetadata.client_version === metadata.schemaVersion,
    "Grype database import metadata does not bind the imported v6 database",
  );
  return {
    digest: importMetadata.digest,
    source: importMetadata.source,
    clientVersion: importMetadata.client_version,
  };
}

export function validateScannerImageIdentity(indexBytes, inspectBytes) {
  const index = parseJsonObject(indexBytes, "Grype image index");
  const normalizedIndexBytes =
    indexBytes.at(-1) === 0x0a ? indexBytes.subarray(0, -1) : indexBytes;
  requireCondition(
    `sha256:${sha256Hex(normalizedIndexBytes)}` ===
      GRYPE_IMAGE_INDEX_DIGEST,
    "Grype image index bytes do not match the pinned digest",
  );
  requireCondition(
    index.mediaType ===
        "application/vnd.docker.distribution.manifest.list.v2+json" &&
      Array.isArray(index.manifests),
    "Grype image index has an unsupported media type or manifest set",
  );
  const amd64Manifests = index.manifests.filter(
    (manifest) =>
      manifest?.platform?.os === "linux" &&
      manifest?.platform?.architecture === "amd64" &&
      (manifest.platform.variant === undefined ||
        manifest.platform.variant === ""),
  );
  requireCondition(
    amd64Manifests.length === 1 &&
      amd64Manifests[0].digest === GRYPE_IMAGE_AMD64_MANIFEST_DIGEST,
    "Grype image index does not bind exactly one pinned linux/amd64 manifest",
  );
  const inspect = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(inspectBytes),
  );
  requireCondition(
    Array.isArray(inspect) &&
      inspect.length === 1 &&
      Array.isArray(inspect[0]?.RepoDigests) &&
      inspect[0].RepoDigests.includes(
        `ghcr.io/anchore/grype@${GRYPE_IMAGE_INDEX_DIGEST}`,
      ) &&
      validDigest(inspect[0].Id),
    "local Grype image inspect does not bind the pinned index",
  );
  return {
    indexDigest: GRYPE_IMAGE_INDEX_DIGEST,
    indexBytes: normalizedIndexBytes.length,
    amd64ManifestDigest: GRYPE_IMAGE_AMD64_MANIFEST_DIGEST,
    localImageId: inspect[0].Id,
  };
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
      status.from === "manual import" &&
      status.valid === true &&
      status.error === undefined &&
      status.path === GRYPE_DB_FILE_PATH,
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
      report.generatedProvenancePresent === false &&
      report.vulnerabilityScanPresent === false &&
      report.unapprovedCriticalVulnerabilities === null &&
      report.unapprovedHighVulnerabilities === null &&
      report.canonicalContainerImageDigest === null &&
      report.imageSignatureVerificationPerformed === false &&
      report.imageSignatureVerified === false &&
      report.registryDigestAuthorized === false &&
      report.registryReadbackVerified === false &&
      report.cloudflareDeploymentDigestVerified === false &&
      report.transparencyLogVerified === false &&
      report.wormRetentionVerified === false &&
      report.p5SbomSourceGenerated === false &&
      report.p5Eligible === false &&
      report.remoteMutationAuthorized === false &&
      report.customerTrafficAuthorized === false &&
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
      sbom.packageCount > 0 &&
      sbom.sourceManifestDigest === subject.ociManifestDigest &&
      sbom.sourceConfigDigest === subject.ociConfigDigest &&
      sbom.sourceMediaType === OCI_MANIFEST_MEDIA_TYPE &&
      sbom.sourceLayerDigestKind === "uncompressed-diff-id",
    "SBOM report catalog facts are invalid",
  );
  const compressedLayerDigests = validateDigestArray(
    subject.compressedLayerDigests,
    "SBOM report compressed layer digests",
  );
  const uncompressedLayerDiffIds = validateDigestArray(
    subject.uncompressedLayerDiffIds,
    "SBOM report uncompressed layer diff IDs",
  );
  requireCondition(
    compressedLayerDigests.length === uncompressedLayerDiffIds.length &&
      compressedLayerDigests.length === sbom.sourceLayerCount,
    "SBOM report layer identities are inconsistent",
  );
  return {
    archiveSha256: subject.archiveSha256,
    ociIndexDigest: subject.ociIndexDigest,
    ociManifestDigest: subject.ociManifestDigest,
    ociConfigDigest: subject.ociConfigDigest,
    runtimeBinarySha256: subject.runtimeBinarySha256,
    compressedLayerDigests,
    uncompressedLayerDiffIds,
    sbomSha256: sbom.sha256,
    sbomBytes: sbom.bytes,
    packageCount: sbom.packageCount,
    sourceMediaType: sbom.sourceMediaType,
    sourcePlatformMetadataPresent: sbom.sourcePlatformMetadataPresent,
    sourceLayerCount: sbom.sourceLayerCount,
  };
}

export function validateGrypeScan(scan, expected = null) {
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
  const descriptorStatus = requireObject(
    descriptorDatabase.status,
    "Grype descriptor database status",
  );
  const expectedMetadata = expected?.metadata ?? {
    schemaVersion: GRYPE_DB_SCHEMA_VERSION,
    built: GRYPE_DB_BUILT,
  };
  const expectedDatabase = expected?.dbFacts ?? {
    path: GRYPE_DB_FILE_PATH,
    valid: true,
  };
  requireCondition(
    descriptorStatus.schemaVersion === expectedMetadata.schemaVersion &&
      descriptorStatus.built === expectedMetadata.built &&
      descriptorStatus.from === "manual import" &&
      descriptorStatus.path === expectedDatabase.path &&
      descriptorStatus.valid === true &&
      descriptorStatus.error === undefined &&
      requireObject(
        descriptorDatabase.providers,
        "Grype descriptor database providers",
      ) !== null,
    "Grype scan descriptor does not bind the frozen valid database",
  );
  const source = requireObject(scan.source, "Grype source");
  validateGrypeSource(source, expected?.sbomFacts);
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
  const blockedFindings = [];
  const blockedSeverities =
    expected?.policy?.blockedSeverities ?? ["Unknown", "Critical", "High"];
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
    requireBoundedString(
      artifact.purl,
      `Grype match ${index} artifact PURL`,
      8192,
    );
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
    if (blockedSeverities.includes(vulnerability.severity)) {
      blockedFindings.push({
        vulnerabilityId: vulnerability.id,
        namespace,
        severity: vulnerability.severity,
        artifactId: artifact.id,
        name: artifact.name,
        version: artifact.version,
        type: artifact.type,
        purl: artifact.purl,
      });
    }
  }
  blockedFindings.sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
  return {
    matchCount: matches.length,
    uniqueFindingCount: findingKeys.size,
    ignoredMatchCount: ignoredMatches.length,
    severityCounts,
    blockedFindingCount: blockedFindings.length,
    blockedFindings,
    findingSetSha256: sha256Hex(
      Buffer.from(`${[...findingKeys].sort().join("\n")}\n`),
    ),
  };
}

function validateGrypeConfiguration(configuration) {
  const value = requireObject(
    configuration,
    "Grype descriptor configuration",
  );
  validateBuiltInIgnoreRules(value.ignore);
  for (const key of ["vex-documents", "vex-add", "exclude"]) {
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
      value["check-for-app-update"] === false &&
      value["show-suppressed"] === true,
    "Grype configuration must disable timestamps and expose suppressed findings",
  );
  const database = requireObject(
    value.db,
    "Grype descriptor database configuration",
  );
  requireCondition(
      database["auto-update"] === false &&
      database["validate-by-hash-on-start"] === true &&
      database["validate-age"] === true &&
      database["max-allowed-built-age"] === 172800000000000 &&
      database["require-update-check"] === false &&
      database["cache-dir"] === "/grype-db",
    "Grype database configuration is not deterministic and offline",
  );
}

function validateBuiltInIgnoreRules(rules) {
  const value = requireArray(rules, "Grype built-in ignore rules");
  const expectedPackages = [
    ["kernel-headers", "rpm", "kernel"],
    ["linux(-.*)?-headers-.*", "deb", "linux.*"],
    ["linux-libc-dev", "deb", "linux"],
    ["linux-kbuild-.*", "deb", "linux.*"],
  ];
  requireCondition(
    value.length === expectedPackages.length,
    "Grype built-in ignore rule set drifted",
  );
  for (const [index, ruleValue] of value.entries()) {
    const rule = requireObject(
      ruleValue,
      `Grype built-in ignore rule ${index}`,
    );
    requireAllowedKeys(
      rule,
      [
        "vulnerability",
        "include-aliases",
        "reason",
        "namespace",
        "fix-state",
        "package",
        "vex-status",
        "vex-justification",
        "match-type",
      ],
      `Grype built-in ignore rule ${index}`,
    );
    const packageRule = requireObject(
      rule.package,
      `Grype built-in ignore rule ${index} package`,
    );
    requireAllowedKeys(
      packageRule,
      [
        "name",
        "version",
        "language",
        "type",
        "location",
        "upstream-name",
      ],
      `Grype built-in ignore rule ${index} package`,
    );
    requireCondition(
      rule.vulnerability === "" &&
        rule["include-aliases"] === false &&
        rule.reason === "" &&
        rule.namespace === "" &&
        rule["fix-state"] === "" &&
        rule["vex-status"] === "" &&
        rule["vex-justification"] === "" &&
        rule["match-type"] === "exact-indirect-match" &&
        packageRule.name === expectedPackages[index][0] &&
        packageRule.type === expectedPackages[index][1] &&
        packageRule["upstream-name"] === expectedPackages[index][2] &&
        packageRule.version === "" &&
        packageRule.language === "" &&
        packageRule.location === "",
      `Grype built-in ignore rule ${index} drifted`,
    );
  }
}

function validateGrypeSource(source, sbomFacts) {
  requireAllowedKeys(source, ["type", "target"], "Grype source");
  const target = requireObject(source.target, "Grype source target");
  requireAllowedKeys(
    target,
    [
      "userInput",
      "imageID",
      "manifestDigest",
      "mediaType",
      "tags",
      "imageSize",
      "layers",
      "manifest",
      "config",
      "repoDigests",
      "architecture",
      "os",
    ],
    "Grype source target",
  );
  requireCondition(
    source.type === "image" && target.userInput === SYFT_SOURCE_INPUT,
    "Grype scan is not bound to the expected SBOM-carried image source",
  );
  if (!sbomFacts) return;
  const layers = requireArray(target.layers, "Grype source layers");
  requireCondition(
    target.imageID === sbomFacts.ociConfigDigest &&
      target.manifestDigest === sbomFacts.ociManifestDigest &&
      target.mediaType === OCI_MANIFEST_MEDIA_TYPE &&
      Number.isSafeInteger(target.imageSize) &&
      target.imageSize > 0 &&
      layers.length === sbomFacts.uncompressedLayerDiffIds.length &&
      layers.every((layerValue, index) => {
        const layer = requireObject(
          layerValue,
          `Grype source layer ${index}`,
        );
        requireAllowedKeys(
          layer,
          ["mediaType", "digest", "size"],
          `Grype source layer ${index}`,
        );
        return (
          layer.mediaType ===
            "application/vnd.oci.image.layer.v1.tar+gzip" &&
          layer.digest === sbomFacts.uncompressedLayerDiffIds[index] &&
          Number.isSafeInteger(layer.size) &&
          layer.size >= 0
        );
      }),
    "Grype scan source does not bind the accepted S1 OCI subject",
  );
  requireCondition(
    `sha256:${sha256Hex(decodeBase64(target.manifest, "Grype source manifest"))}` ===
      sbomFacts.ociManifestDigest &&
      `sha256:${sha256Hex(decodeBase64(target.config, "Grype source config"))}` ===
        sbomFacts.ociConfigDigest,
    "Grype source embedded OCI bytes do not match the accepted S1 subject",
  );
  requireCondition(
    Array.isArray(target.tags) &&
      Array.isArray(target.repoDigests) &&
      target.tags.length === 0 &&
      target.repoDigests.length === 0 &&
      (sbomFacts.sourcePlatformMetadataPresent
        ? target.architecture === "amd64" && target.os === "linux"
        : target.architecture === "" && target.os === ""),
    "Grype source platform or mutable reference metadata drifted",
  );
}

export function buildVulnerabilityDecision(facts) {
  const unapprovedUnknown = facts.scanFacts.severityCounts.Unknown;
  const unapprovedCritical =
    facts.scanFacts.severityCounts.Critical;
  const unapprovedHigh = facts.scanFacts.severityCounts.High;
  const policyPassed =
    unapprovedUnknown === 0 &&
    unapprovedCritical === 0 &&
    unapprovedHigh === 0 &&
    facts.approvals.length === 0;
  return {
    contractVersion: VULNERABILITY_GATE_CONTRACT_VERSION,
    status: policyPassed ? "passed" : "failed",
    reportKind: "container-runtime-vulnerability-decision",
    decision: {
      scope: LOCAL_EVIDENCE_SCOPE,
      formalP5Evidence: false,
      vulnerabilityDecision: policyPassed
        ? "passed-zero-unapproved-unknown-high-critical"
        : "failed-unapproved-unknown-high-critical",
      productionDecision: "not-authorized",
    },
    subject: facts.sbomFacts,
    scanner: {
      image: GRYPE_IMAGE,
      name: "grype",
      version: GRYPE_VERSION,
      indexDigest: facts.scannerFacts.indexDigest,
      amd64ManifestDigest: facts.scannerFacts.amd64ManifestDigest,
      localImageId: facts.scannerFacts.localImageId,
      inputReference: GRYPE_SOURCE_REFERENCE,
      sourceTarget: GRYPE_SOURCE_TARGET,
      networkDisabled: true,
      runsAsRoot: false,
      exactIndependentMatch: true,
      suppressedFindingsVisible: true,
    },
    database: {
      provider: facts.metadata.provider,
      sourceLatestUrl: facts.metadata.sourceLatestUrl,
      listingObservedAt: facts.metadata.listingObservedAt,
      listingSha256: facts.metadata.listingSha256,
      listing: facts.listingFacts,
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
      importedFileSha256: facts.database.sha256,
      importedFileBytes: facts.database.bytes,
      exactIndependentFileMatch: true,
      importMetadata: facts.importFacts,
    },
    policy: {
      blockedSeverities: facts.policy.blockedSeverities,
      unknownApprovalsAllowed: facts.policy.unknownApprovalsAllowed,
      criticalApprovalsAllowed: facts.policy.criticalApprovalsAllowed,
      highApprovalMode: facts.policy.highApprovalMode,
      approvalCount: facts.approvals.length,
    },
    sbomInput: facts.sbomInput,
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
    unapprovedUnknownVulnerabilities: unapprovedUnknown,
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

function validateDigestArray(value, label) {
  const digests = requireArray(value, label);
  requireCondition(
    digests.length > 0 &&
      digests.length <= 1024 &&
      digests.every(validDigest) &&
      new Set(digests).size === digests.length,
    `${label} must contain unique lowercase SHA-256 digests`,
  );
  return digests;
}

function decodeBase64(value, label) {
  requireCondition(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= 64 * 1024 * 1024 &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(value),
    `${label} must be bounded canonical base64`,
  );
  const bytes = Buffer.from(value, "base64");
  requireCondition(
    bytes.length > 0 && bytes.toString("base64") === value,
    `${label} must be canonical base64`,
  );
  return bytes;
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
        sbomA: options.sbomA,
        sbomB: options.sbomB,
        sbomReport: options.sbomReport,
        dbStatusA: options.dbStatusA,
        dbStatusB: options.dbStatusB,
        dbArchive: options.dbArchive,
        dbFileA: options.dbFileA,
        dbFileB: options.dbFileB,
        dbImportA: options.dbImportA,
        dbImportB: options.dbImportB,
        dbMetadata: options.dbMetadata,
        dbListing: options.dbListing,
        policy: options.policy,
        approvals: options.approvals,
        scannerIndex: options.scannerIndex,
        scannerInspect: options.scannerInspect,
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
