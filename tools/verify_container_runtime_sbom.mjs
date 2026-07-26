import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SBOM_GATE_CONTRACT_VERSION = 1;
export const SYFT_VERSION = "1.49.0";
export const SYFT_SCHEMA_VERSION = "16.1.10";
export const SYFT_IMAGE =
  "ghcr.io/anchore/syft:v1.49.0@sha256:13b53ebabe3d215268c90cf8fb9b875f0183908245f376fd4b3a2cb69d21d484";
export const SBOM_SOURCE_REFERENCE =
  "oci-archive:/input/container-runtime.tar";
export const SBOM_SOURCE_NAME = "cinatoken-container-runtime";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const WORKFLOW = resolve(ROOT, ".github/workflows/container-runtime-oci.yml");
const PACKAGE_JSON = resolve(ROOT, "package.json");
const MAX_SBOM_BYTES = 64 * 1024 * 1024;
const MAX_OCI_REPORT_BYTES = 1024 * 1024;
const OCI_MANIFEST_MEDIA_TYPE =
  "application/vnd.oci.image.manifest.v1+json";
const OCI_LAYER_MEDIA_TYPE =
  "application/vnd.oci.image.layer.v1.tar+gzip";
const SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function parseArgs(argv) {
  const options = {
    selfTest: false,
    sbomA: null,
    sbomB: null,
    ociReport: null,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--self-test") {
      options.selfTest = true;
    } else if (argument === "--json") {
      options.json = true;
    } else if (argument === "--sbom-a") {
      options.sbomA = argv[index + 1] ?? null;
      index += 1;
    } else if (argument === "--sbom-b") {
      options.sbomB = argv[index + 1] ?? null;
      index += 1;
    } else if (argument === "--oci-report") {
      options.ociReport = argv[index + 1] ?? null;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }

  const realGateSelected =
    options.sbomA !== null &&
    options.sbomB !== null &&
    options.ociReport !== null;
  const anyRealGatePath =
    options.sbomA !== null ||
    options.sbomB !== null ||
    options.ociReport !== null;
  if (
    options.selfTest === realGateSelected ||
    (anyRealGatePath && !realGateSelected)
  ) {
    throw new Error(
      "select --self-test or all --sbom-a, --sbom-b, and --oci-report paths",
    );
  }
  for (const path of [
    options.sbomA,
    options.sbomB,
    options.ociReport,
  ]) {
    if (path !== null && !validPath(path)) {
      throw new Error(
        "input path must be bounded, contain no NUL, and must not start with '-'",
      );
    }
  }
  return options;
}

export async function auditRepositoryContract() {
  const [workflowText, packageJsonText] = await Promise.all([
    readFile(WORKFLOW, "utf8"),
    readFile(PACKAGE_JSON, "utf8"),
  ]);
  const workflow = workflowText.replaceAll("\r\n", "\n");
  const packageJson = JSON.parse(packageJsonText);
  const generatorCalls =
    workflow.match(/^\s*generate_sbom\s+\\$/gm) ?? [];

  requireCondition(
    workflow.includes(`SYFT_IMAGE: ${SYFT_IMAGE}`) &&
      /^ghcr\.io\/anchore\/syft:v[0-9.]+@sha256:[a-f0-9]{64}$/.test(
        SYFT_IMAGE,
      ) &&
      workflow.includes(
        'docker pull --platform linux/amd64 "${SYFT_IMAGE}"',
      ) &&
      workflow.includes('docker image inspect "${SYFT_IMAGE}"'),
    "SBOM workflow must pin and record the Syft image identity",
  );
  requireCondition(
    generatorCalls.length === 2 &&
      workflow.includes("docker run --rm") &&
      workflow.includes("--pull never") &&
      workflow.includes("--platform linux/amd64") &&
      workflow.includes("--network none") &&
      workflow.includes("--read-only") &&
      workflow.includes("--cap-drop ALL") &&
      workflow.includes("--security-opt no-new-privileges=true") &&
      workflow.includes('--user "$(id -u):$(id -g)"') &&
      workflow.includes("--pids-limit 256") &&
      workflow.includes("--memory 1g") &&
      workflow.includes("--cpus 2") &&
      workflow.includes("--ulimit nofile=1024:1024") &&
      workflow.includes(
        "--tmpfs /tmp:rw,noexec,nosuid,nodev,size=128m",
      ),
    "SBOM workflow must run two resource-bounded nonroot offline catalogers",
  );
  requireCondition(
    workflow.includes(
      "--mount \"type=bind,src=${archive},dst=/input/container-runtime.tar,readonly\"",
    ) &&
      workflow.includes(
        "--mount \"type=bind,src=${output_directory},dst=/output\"",
      ) &&
      workflow.includes(`"${SBOM_SOURCE_REFERENCE}"`) &&
      workflow.includes("--scope squashed") &&
      workflow.includes(`--source-name ${SBOM_SOURCE_NAME}`) &&
      workflow.includes('--source-version "${OCI_MANIFEST_DIGEST}"') &&
      workflow.includes(
        "--output syft-json=/output/container-runtime.sbom.syft.json",
      ),
    "SBOM workflow must scan only the verified archives through a fixed source boundary",
  );
  requireCondition(
    workflow.includes("node tools/verify_container_runtime_sbom.mjs") &&
      workflow.includes("--sbom-a") &&
      workflow.includes("--sbom-b") &&
      workflow.includes("--oci-report") &&
      workflow.includes("container-runtime-sbom-verification.json") &&
      workflow.includes("container-runtime-sbom-verification.log") &&
      workflow.includes("syft-image-inspect.json") &&
      workflow.includes("retention-days: 30") &&
      workflow.includes("if: always()"),
    "SBOM workflow must verify and retain the complete local evidence packet",
  );
  requireCondition(
    workflow.includes("permissions:\n  contents: read") &&
      !/\bid-token:\s*write\b/i.test(workflow) &&
      !/\bpackages:\s*write\b/i.test(workflow) &&
      !/\$\{\{\s*secrets\./i.test(workflow) &&
      !/docker login|registry login|cosign sign|wrangler|cloudflare api|customer traffic/i.test(
        workflow,
      ),
    "SBOM workflow must remain credential-free and read-only",
  );
  requireCondition(
    packageJson.scripts["check:container-runtime:sbom-contract"]?.includes(
      "tests/container-runtime-sbom-gate.test.mjs",
    ) &&
      packageJson.scripts[
        "check:container-runtime:sbom-contract"
      ]?.includes("--self-test") &&
      packageJson.scripts["check:container-runtime:sbom"] ===
        "node tools/verify_container_runtime_sbom.mjs" &&
      packageJson.scripts.check?.includes(
        "check:container-runtime:sbom-contract",
      ) &&
      !packageJson.scripts.check?.includes(
        "check:container-runtime:sbom &&",
      ),
    "package scripts must keep the offline SBOM contract in aggregate checks and the real gate in Linux CI",
  );

  return {
    contractVersion: SBOM_GATE_CONTRACT_VERSION,
    status: "passed",
    syftImage: SYFT_IMAGE,
    syftVersion: SYFT_VERSION,
    syftSchemaVersion: SYFT_SCHEMA_VERSION,
    syftImagePinnedByDigest: true,
    independentSbomCatalogsRequired: 2,
    exactSbomBytesRequired: true,
    ociSubjectBindingRequired: true,
    catalogerNetworkDisabled: true,
    catalogerRunsAsRoot: false,
    generatedSbomPresent: false,
    generatedProvenancePresent: false,
    vulnerabilityScanPresent: false,
    unapprovedCriticalVulnerabilities: null,
    unapprovedHighVulnerabilities: null,
    canonicalContainerImageDigest: null,
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

export async function runSbomGate(sbomAPath, sbomBPath, ociReportPath) {
  await auditRepositoryContract();
  const [sbomABytes, sbomBBytes, ociReportBytes] = await Promise.all([
    readBoundedFile(sbomAPath, MAX_SBOM_BYTES, "SBOM A"),
    readBoundedFile(sbomBPath, MAX_SBOM_BYTES, "SBOM B"),
    readBoundedFile(
      ociReportPath,
      MAX_OCI_REPORT_BYTES,
      "OCI verification report",
    ),
  ]);
  requireCondition(
    sbomABytes.equals(sbomBBytes),
    "independent SBOM catalogs are not byte-identical",
  );

  const ociReport = parseJsonObject(
    ociReportBytes,
    "OCI verification report",
  );
  validateOciReport(ociReport);
  const sbom = parseJsonObject(sbomABytes, "Syft SBOM");
  const sbomFacts = validateSyftSbom(sbom, ociReport);
  const sbomSha256 = sha256Hex(sbomABytes);

  return {
    contractVersion: SBOM_GATE_CONTRACT_VERSION,
    status: "passed",
    subject: {
      archiveSha256: ociReport.reproducibility.archiveSha256,
      ociIndexDigest: ociReport.ociIndexDigest,
      ociManifestDigest: ociReport.ociManifestDigest,
      ociConfigDigest: ociReport.ociConfigDigest,
      compressedLayerDigests: ociReport.compressedLayerDigests,
      uncompressedLayerDiffIds: ociReport.uncompressedLayerDiffIds,
      runtimeBinarySha256: ociReport.runtimeBinarySha256,
    },
    generator: {
      image: SYFT_IMAGE,
      name: "syft",
      version: SYFT_VERSION,
      schemaVersion: SYFT_SCHEMA_VERSION,
      sourceReference: SBOM_SOURCE_REFERENCE,
      scope: "squashed",
      networkDisabled: true,
      runsAsRoot: false,
    },
    sbom: {
      format: "syft-json",
      sha256: sbomSha256,
      bytes: sbomABytes.length,
      exactIndependentMatch: true,
      packageCount: sbomFacts.packageCount,
      relationshipCount: sbomFacts.relationshipCount,
      sourceId: sbomFacts.sourceId,
      sourceManifestDigest: sbomFacts.sourceManifestDigest,
      sourceConfigDigest: sbomFacts.sourceConfigDigest,
      sourceLayerCount: sbomFacts.sourceLayerCount,
    },
    generatedSbomPresent: true,
    generatedProvenancePresent: false,
    vulnerabilityScanPresent: false,
    unapprovedCriticalVulnerabilities: null,
    unapprovedHighVulnerabilities: null,
    canonicalContainerImageDigest: null,
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

export function validateOciReport(report) {
  requireObject(report, "OCI verification report");
  requireCondition(
    report.status === "passed",
    "OCI verification report did not pass",
  );
  for (const [field, value] of [
    ["OCI index digest", report.ociIndexDigest],
    ["OCI manifest digest", report.ociManifestDigest],
    ["OCI config digest", report.ociConfigDigest],
  ]) {
    requireCondition(
      validDigest(value),
      `${field} must be a lowercase SHA-256 digest`,
    );
  }
  requireDigestArray(
    report.compressedLayerDigests,
    "OCI compressed layer digests",
  );
  requireDigestArray(
    report.uncompressedLayerDiffIds,
    "OCI uncompressed layer diff IDs",
  );
  requireCondition(
    report.compressedLayerDigests.length ===
      report.uncompressedLayerDiffIds.length,
    "OCI layer and diff ID counts differ",
  );
  requireCondition(
    validSha256(report.runtimeBinarySha256),
    "OCI runtime binary digest must be lowercase SHA-256",
  );
  const reproducibility = requireObject(
    report.reproducibility,
    "OCI reproducibility",
  );
  requireCondition(
    validSha256(reproducibility.archiveSha256) &&
      reproducibility.exactArchiveMatch === true &&
      reproducibility.exactIndexMatch === true &&
      reproducibility.exactManifestMatch === true &&
      reproducibility.exactConfigMatch === true &&
      reproducibility.exactCompressedLayerMatch === true &&
      reproducibility.exactDiffIdMatch === true &&
      reproducibility.exactRuntimeBinaryMatch === true,
    "OCI report does not prove complete archive reproducibility",
  );
}

export function validateSyftSbom(sbom, ociReport) {
  requireObject(sbom, "Syft SBOM");
  const schema = requireObject(sbom.schema, "Syft SBOM schema");
  requireCondition(
    schema.version === SYFT_SCHEMA_VERSION &&
      schema.url ===
        `https://raw.githubusercontent.com/anchore/syft/main/schema/json/schema-${SYFT_SCHEMA_VERSION}.json`,
    "Syft SBOM schema identity drifted",
  );
  const descriptor = requireObject(
    sbom.descriptor,
    "Syft SBOM descriptor",
  );
  requireCondition(
    descriptor.name === "syft" && descriptor.version === SYFT_VERSION,
    "Syft generator identity drifted",
  );

  const source = requireObject(sbom.source, "Syft SBOM source");
  requireCondition(
    typeof source.id === "string" &&
      source.id.length > 0 &&
      source.id.length <= 256,
    "Syft source ID must be bounded and nonempty",
  );
  requireCondition(
    source.name === SBOM_SOURCE_NAME &&
      source.version === ociReport.ociManifestDigest &&
      source.type === "image",
    "Syft source name, version, or type is not bound to the OCI subject",
  );
  const metadata = requireObject(
    source.metadata,
    "Syft image metadata",
  );
  requireCondition(
    metadata.userInput === SBOM_SOURCE_REFERENCE,
    "Syft source reference escaped the fixed OCI archive boundary",
  );
  requireCondition(
    metadata.imageID === ociReport.ociConfigDigest &&
      metadata.manifestDigest === ociReport.ociManifestDigest,
    "Syft image or manifest digest does not match the OCI report",
  );
  requireCondition(
    metadata.mediaType === OCI_MANIFEST_MEDIA_TYPE &&
      metadata.architecture === "amd64" &&
      metadata.os === "linux",
    "Syft image media type or platform drifted",
  );
  requireCondition(
    Number.isSafeInteger(metadata.imageSize) &&
      metadata.imageSize > 0 &&
      metadata.imageSize <= 512 * 1024 * 1024,
    "Syft image size must be a positive bounded integer",
  );
  requireCondition(
    Array.isArray(metadata.tags) &&
      Array.isArray(metadata.repoDigests) &&
      metadata.tags.length === 0 &&
      metadata.repoDigests.length === 0,
    "local archive SBOM must not claim registry tags or repository digests",
  );

  const layers = requireArray(metadata.layers, "Syft image layers");
  requireCondition(
    layers.length === ociReport.compressedLayerDigests.length,
    "Syft layer count does not match the OCI report",
  );
  for (let index = 0; index < layers.length; index += 1) {
    const layer = requireObject(layers[index], `Syft layer ${index}`);
    requireCondition(
      layer.mediaType === OCI_LAYER_MEDIA_TYPE &&
        layer.digest === ociReport.compressedLayerDigests[index] &&
        Number.isSafeInteger(layer.size) &&
        layer.size > 0,
      `Syft layer ${index} is not bound to the OCI descriptor`,
    );
  }

  const manifestBytes = decodeCanonicalBase64(
    metadata.manifest,
    "Syft raw manifest",
    4 * 1024 * 1024,
  );
  const configBytes = decodeCanonicalBase64(
    metadata.config,
    "Syft raw config",
    4 * 1024 * 1024,
  );
  requireCondition(
    `sha256:${sha256Hex(manifestBytes)}` ===
      ociReport.ociManifestDigest,
    "Syft raw manifest digest does not match the OCI report",
  );
  requireCondition(
    `sha256:${sha256Hex(configBytes)}` === ociReport.ociConfigDigest,
    "Syft raw config digest does not match the OCI report",
  );

  const rawManifest = parseJsonObject(
    manifestBytes,
    "Syft raw manifest",
  );
  const rawConfig = parseJsonObject(configBytes, "Syft raw config");
  requireCondition(
    rawManifest.mediaType === OCI_MANIFEST_MEDIA_TYPE &&
      rawManifest.config?.digest === ociReport.ociConfigDigest,
    "Syft raw manifest config binding drifted",
  );
  const manifestLayers = requireArray(
    rawManifest.layers,
    "Syft raw manifest layers",
  );
  requireCondition(
    JSON.stringify(manifestLayers.map((layer) => layer?.digest)) ===
      JSON.stringify(ociReport.compressedLayerDigests),
    "Syft raw manifest layer digests drifted",
  );
  requireCondition(
    rawConfig.architecture === "amd64" && rawConfig.os === "linux",
    "Syft raw config platform drifted",
  );
  const rootfs = requireObject(rawConfig.rootfs, "Syft raw config rootfs");
  requireCondition(
    rootfs.type === "layers" &&
      JSON.stringify(rootfs.diff_ids) ===
        JSON.stringify(ociReport.uncompressedLayerDiffIds),
    "Syft raw config diff IDs drifted",
  );

  const artifacts = requireArray(sbom.artifacts, "Syft packages");
  requireCondition(
    artifacts.length > 0 && artifacts.length <= 1_000_000,
    "Syft SBOM must contain a bounded nonempty package inventory",
  );
  const artifactIds = new Set();
  for (const [index, artifact] of artifacts.entries()) {
    const pkg = requireObject(artifact, `Syft package ${index}`);
    requireBoundedString(pkg.id, `Syft package ${index} ID`, 256);
    requireBoundedString(pkg.name, `Syft package ${index} name`, 4096);
    requireBoundedString(pkg.type, `Syft package ${index} type`, 256);
    requireCondition(
      !artifactIds.has(pkg.id),
      "Syft package IDs must be unique",
    );
    artifactIds.add(pkg.id);
  }
  const relationships = requireArray(
    sbom.artifactRelationships,
    "Syft relationships",
  );
  requireCondition(
    relationships.length <= 4_000_000,
    "Syft relationship inventory exceeds the bound",
  );

  return {
    packageCount: artifacts.length,
    relationshipCount: relationships.length,
    sourceId: source.id,
    sourceManifestDigest: metadata.manifestDigest,
    sourceConfigDigest: metadata.imageID,
    sourceLayerCount: layers.length,
  };
}

async function readBoundedFile(path, maximumBytes, label) {
  const resolved = resolve(path);
  const fileStat = await stat(resolved);
  requireCondition(
    fileStat.isFile() &&
      fileStat.size > 0 &&
      fileStat.size <= maximumBytes,
    `${label} must be a nonempty bounded regular file`,
  );
  return readFile(resolved);
}

function parseJsonObject(bytes, label) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} must be valid UTF-8 JSON`);
  }
  return requireObject(value, label);
}

function decodeCanonicalBase64(value, label, maximumBytes) {
  requireCondition(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= maximumBytes * 2,
    `${label} must be a bounded base64 string`,
  );
  const decoded = Buffer.from(value, "base64");
  requireCondition(
    decoded.length > 0 &&
      decoded.length <= maximumBytes &&
      decoded.toString("base64") === value,
    `${label} must use canonical base64`,
  );
  return decoded;
}

function requireDigestArray(value, label) {
  const array = requireArray(value, label);
  requireCondition(
    array.length > 0 && array.every(validDigest),
    `${label} must be a nonempty lowercase SHA-256 digest array`,
  );
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

function requireObject(value, label) {
  requireCondition(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value;
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

function validDigest(value) {
  return typeof value === "string" && SHA256_DIGEST_PATTERN.test(value);
}

function validSha256(value) {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = options.selfTest
    ? await auditRepositoryContract()
    : await runSbomGate(
        options.sbomA,
        options.sbomB,
        options.ociReport,
      );
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`container runtime SBOM gate: ${report.status}\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(
      `container runtime SBOM gate failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
