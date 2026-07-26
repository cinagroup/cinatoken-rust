import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

import { runBoundedSubprocess } from "./lib/bounded_subprocess.mjs";

export const OCI_GATE_CONTRACT_VERSION = 1;
export const OCI_LAYOUT_VERSION = "1.0.0";
export const OCI_INDEX_MEDIA_TYPE =
  "application/vnd.oci.image.index.v1+json";
export const OCI_MANIFEST_MEDIA_TYPE =
  "application/vnd.oci.image.manifest.v1+json";
export const OCI_CONFIG_MEDIA_TYPE =
  "application/vnd.oci.image.config.v1+json";
export const OCI_LAYER_MEDIA_TYPE =
  "application/vnd.oci.image.layer.v1.tar+gzip";
export const SOURCE_DATE_EPOCH = 0;
export const BUILDKIT_IMAGE =
  "moby/buildkit:v0.31.2@sha256:2f5adac4ecd194d9f8c10b7b5d7bceb5186853db1b26e5abd3a657af0b7e26ec";
export const CHECKOUT_ACTION =
  "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0";
export const UPLOAD_ARTIFACT_ACTION =
  "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const WORKFLOW = resolve(ROOT, ".github/workflows/container-runtime-oci.yml");
const DOCKERFILE = resolve(ROOT, "crates/container-runtime/Dockerfile");
const PACKAGE_JSON = resolve(ROOT, "package.json");
const RUNTIME_BINARY_PATH = "usr/local/bin/cinatoken-container-runtime";
const EPOCH_TIMESTAMP = "1970-01-01T00:00:00Z";
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_LAYER_BYTES = 128 * 1024 * 1024;
const ALLOWED_LAYOUT_DIRECTORIES = new Set(["blobs", "blobs/sha256"]);
const ALLOWED_APPLICATION_DIRECTORIES = new Set([
  "usr",
  "usr/local",
  "usr/local/bin",
]);

export function parseArgs(argv) {
  const options = {
    selfTest: false,
    archiveA: null,
    archiveB: null,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--self-test") {
      options.selfTest = true;
    } else if (argument === "--json") {
      options.json = true;
    } else if (argument === "--archive-a") {
      options.archiveA = argv[index + 1] ?? null;
      index += 1;
    } else if (argument === "--archive-b") {
      options.archiveB = argv[index + 1] ?? null;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }

  const realGateSelected =
    options.archiveA !== null && options.archiveB !== null;
  if (
    options.selfTest === realGateSelected ||
    (options.archiveA === null) !== (options.archiveB === null)
  ) {
    throw new Error(
      "select --self-test or both --archive-a and --archive-b paths",
    );
  }
  for (const archive of [options.archiveA, options.archiveB]) {
    if (archive !== null && !validArchivePath(archive)) {
      throw new Error(
        "archive path must be bounded, contain no NUL, and must not start with '-'",
      );
    }
  }
  return options;
}

export async function auditRepositoryContract() {
  const [workflowText, dockerfileText, packageJsonText] = await Promise.all([
    readFile(WORKFLOW, "utf8"),
    readFile(DOCKERFILE, "utf8"),
    readFile(PACKAGE_JSON, "utf8"),
  ]);
  const workflow = workflowText.replaceAll("\r\n", "\n");
  const dockerfile = dockerfileText.replaceAll("\r\n", "\n");
  const packageJson = JSON.parse(packageJsonText);
  const independentBuilds =
    workflow.match(/docker buildx build/g) ?? [];
  const buildBlocks = [
    ...workflow.matchAll(
      /docker buildx build \\\n([\s\S]*?)\n\s+\./g,
    ),
  ].map((match) => match[0]);
  const pinnedBuilderArguments =
    workflow.match(/--builder "\$\{BUILDX_BUILDER_[AB]\}"/g) ?? [];
  const noCacheArguments = workflow.match(/--no-cache/g) ?? [];
  const epochArguments =
    workflow.match(/--build-arg SOURCE_DATE_EPOCH=0/g) ?? [];
  const ociOutputs =
    workflow.match(/type=oci,[^\r\n]*rewrite-timestamp=true/g) ?? [];
  const provenanceDisabled = workflow.match(/--provenance=false/g) ?? [];
  const sbomDisabled = workflow.match(/--sbom=false/g) ?? [];

  requireCondition(
    workflow.includes(`uses: ${CHECKOUT_ACTION}`) &&
      workflow.includes(`uses: ${UPLOAD_ARTIFACT_ACTION}`) &&
      workflow.includes("persist-credentials: false") &&
      workflow.includes("runs-on: ubuntu-24.04") &&
      workflow.includes(`BUILDKIT_IMAGE: ${BUILDKIT_IMAGE}`) &&
      workflow.includes('image=${BUILDKIT_IMAGE}'),
    "OCI workflow must pin checkout, upload, runner, and BuildKit image identities",
  );
  requireCondition(
    independentBuilds.length === 2 &&
      buildBlocks.length === 2 &&
      buildBlocks.every((block) =>
        block.includes("--platform linux/amd64"),
      ) &&
      pinnedBuilderArguments.length === 2 &&
      noCacheArguments.length === 2 &&
      epochArguments.length === 2 &&
      ociOutputs.length === 2 &&
      provenanceDisabled.length === 2 &&
      sbomDisabled.length === 2 &&
      workflow.includes("compression=gzip") &&
      workflow.includes("compression-level=9") &&
      workflow.includes("force-compression=true") &&
      workflow.includes("oci-mediatypes=true") &&
      workflow.includes("compatibility-version=20"),
    "OCI workflow must perform two deterministic no-cache exports with default attestations disabled",
  );
  requireCondition(
      workflow.includes("node tools/verify_container_runtime_oci.mjs") &&
      workflow.includes("--archive-a") &&
      workflow.includes("--archive-b") &&
      workflow.includes("container-runtime-oci-verification.json") &&
      workflow.includes("builder-a-info.log") &&
      workflow.includes("builder-b-info.log") &&
      workflow.includes("buildx-version.log") &&
      workflow.includes("docker-version.log") &&
      workflow.includes("retention-days: 30") &&
      workflow.includes("if: always()") &&
      workflow.includes(
        'docker buildx rm --force "${BUILDX_BUILDER_A}" || true',
      ) &&
      workflow.includes(
        'docker buildx rm --force "${BUILDX_BUILDER_B}" || true',
      ),
    "OCI workflow must execute, retain, and clean up the real archive gate",
  );
  requireCondition(
    workflow.includes("permissions:\n  contents: read") &&
      !/\$\{\{\s*secrets\./i.test(workflow) &&
      !/docker login|registry login|wrangler|cloudflare api|customer traffic/i.test(
        workflow,
      ),
    "OCI workflow must remain read-only and credential-free",
  );
  requireCondition(
    dockerfile.startsWith(`ARG SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}\n`) &&
      dockerfile.includes(
        "ENV CARGO_INCREMENTAL=0 SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}",
      ) &&
      dockerfile.includes(
        "install -D -m 0755 /build/target/release/cinatoken-container-runtime",
      ) &&
      dockerfile.includes(
        'find /runtime-root -exec touch --date="@${SOURCE_DATE_EPOCH}" {} +',
      ) &&
      dockerfile.includes(
        "COPY --from=builder --chown=0:0 /runtime-root/ /",
      ),
    "runtime Dockerfile must retain the normalized reproducible root contract",
  );
  requireCondition(
    packageJson.scripts["check:container-runtime:oci-contract"]?.includes(
      "tests/container-runtime-oci-gate.test.mjs",
    ) &&
      packageJson.scripts["check:container-runtime:oci-contract"]?.includes(
        "--self-test",
      ) &&
      packageJson.scripts["check:container-runtime:oci"] ===
        "node tools/verify_container_runtime_oci.mjs" &&
      workflow.includes(
        "node tools/verify_container_runtime_oci.mjs",
      ) &&
      packageJson.scripts.check?.includes(
        "check:container-runtime:oci-contract",
      ) &&
      !packageJson.scripts.check?.includes(
        "check:container-runtime:oci &&",
      ),
    "package scripts must keep the offline OCI contract in aggregate checks and the real archive gate in Linux CI",
  );

  return {
    contractVersion: OCI_GATE_CONTRACT_VERSION,
    status: "passed",
    buildkitImage: BUILDKIT_IMAGE,
    buildkitPinnedByDigest: true,
    sourceDateEpoch: SOURCE_DATE_EPOCH,
    compatibilityVersion: 20,
    compression: "gzip",
    compressionLevel: 9,
    independentOciBuildsRequired: 2,
    independentBuildkitInstancesRequired: 2,
    independentRunnerReproductionVerified: false,
    exactArchiveBytesRequired: true,
    exactIndexManifestConfigLayersRequired: true,
    defaultProvenanceDisabled: true,
    defaultSbomDisabled: true,
    generatedProvenancePresent: false,
    generatedSbomPresent: false,
    vulnerabilityScanPresent: false,
    unapprovedCriticalVulnerabilities: null,
    unapprovedHighVulnerabilities: null,
    imageSignatureVerified: false,
    registryDigestAuthorized: false,
    registryReadbackVerified: false,
    cloudflareDeploymentDigestVerified: false,
    transparencyLogVerified: false,
    wormRetentionVerified: false,
    p5Eligible: false,
    remoteMutationAuthorized: false,
    customerTrafficAuthorized: false,
    productionCutoverAuthorized: false,
  };
}

export async function runOciGate(archiveA, archiveB) {
  await auditRepositoryContract();
  requireCondition(
    process.platform === "linux" && process.arch === "x64",
    "real OCI archive gate requires a Linux x64 host",
  );
  const [primary, secondary] = await Promise.all([
    inspectOciArchive(archiveA),
    inspectOciArchive(archiveB),
  ]);
  const reproducibility = compareOciReports(primary, secondary);
  return {
    contractVersion: OCI_GATE_CONTRACT_VERSION,
    status: "passed",
    buildkitImage: BUILDKIT_IMAGE,
    sourceDateEpoch: SOURCE_DATE_EPOCH,
    compatibilityVersion: 20,
    archiveA,
    archiveB,
    ociIndexDigest: `sha256:${primary.indexSha256}`,
    ociManifestDigest: primary.manifestDigest,
    ociConfigDigest: primary.configDigest,
    compressedLayerDigests: primary.layerDigests,
    uncompressedLayerDiffIds: primary.diffIds,
    runtimeBinarySha256: primary.runtimeBinarySha256,
    reproducibility,
    generatedProvenancePresent: false,
    generatedSbomPresent: false,
    vulnerabilityScanPresent: false,
    unapprovedCriticalVulnerabilities: null,
    unapprovedHighVulnerabilities: null,
    imageSignatureVerified: false,
    registryDigestAuthorized: false,
    registryReadbackVerified: false,
    cloudflareDeploymentDigestVerified: false,
    independentRunnerReproductionVerified: false,
    transparencyLogVerified: false,
    wormRetentionVerified: false,
    p5Eligible: false,
    remoteMutationAuthorized: false,
    customerTrafficAuthorized: false,
    productionCutoverAuthorized: false,
  };
}

export async function inspectOciArchive(archivePath) {
  const archive = resolve(archivePath);
  const archiveStat = await stat(archive);
  requireCondition(
    archiveStat.isFile() &&
      archiveStat.size > 0 &&
      archiveStat.size <= MAX_ARCHIVE_BYTES,
    "OCI archive must be a nonempty bounded regular file",
  );
  const listing = await runChecked(
    "tar",
    ["--list", "--file", archive],
    60_000,
    4 * 1024 * 1024,
  );
  const members = listing.stdout
    .split(/\r?\n/)
    .filter((value) => value.length > 0)
    .map(normalizeArchiveMember);
  requireCondition(members.length > 0, "OCI archive member list is empty");
  requireCondition(
    new Set(members).size === members.length,
    "OCI archive contains duplicate member paths",
  );

  const extractionRoot = await mkdtemp(join(tmpdir(), "cinatoken-oci-"));
  try {
    await mkdir(join(extractionRoot, "blobs", "sha256"), {
      recursive: true,
    });
    await runChecked(
      "tar",
      [
        "--extract",
        "--file",
        archive,
        "--directory",
        extractionRoot,
        "--no-same-owner",
        "--no-same-permissions",
        "--skip-old-files",
      ],
      120_000,
      4 * 1024 * 1024,
    );
    const archiveSha256 = await hashFile(archive);
    return await validateOciLayout(extractionRoot, {
      archiveSha256,
      archiveBytes: archiveStat.size,
      archiveMembers: members,
    });
  } finally {
    await rm(extractionRoot, { recursive: true, force: true });
  }
}

export async function validateOciLayout(
  layoutDirectory,
  {
    archiveSha256 = null,
    archiveBytes = null,
    archiveMembers = null,
  } = {},
) {
  const layoutRoot = resolve(layoutDirectory);
  const inventory = await collectLayoutInventory(layoutRoot);
  const expectedRootFiles = new Set(["index.json", "oci-layout"]);
  const blobFiles = inventory.files.filter((path) =>
    /^blobs\/sha256\/[a-f0-9]{64}$/.test(path),
  );
  requireCondition(
    inventory.directories.length === ALLOWED_LAYOUT_DIRECTORIES.size &&
      inventory.directories.every((path) =>
        ALLOWED_LAYOUT_DIRECTORIES.has(path),
      ),
    "OCI layout contains an unexpected directory",
  );
  requireCondition(
    inventory.files.length === blobFiles.length + expectedRootFiles.size &&
      inventory.files.every(
        (path) => expectedRootFiles.has(path) || blobFiles.includes(path),
      ),
    "OCI layout contains an unexpected file",
  );

  const layout = await readBoundedJson(
    join(layoutRoot, "oci-layout"),
    "OCI layout marker",
  );
  requireExactKeys(layout, ["imageLayoutVersion"], "OCI layout marker");
  requireCondition(
    layout.imageLayoutVersion === OCI_LAYOUT_VERSION,
    "OCI layout version drifted",
  );

  const indexBytes = await readBoundedFile(
    join(layoutRoot, "index.json"),
    "OCI index",
  );
  const index = parseJson(indexBytes, "OCI index");
  requireExactKeys(
    index,
    ["manifests", "mediaType", "schemaVersion"],
    "OCI index",
  );
  requireCondition(
    index.schemaVersion === 2 && index.mediaType === OCI_INDEX_MEDIA_TYPE,
    "OCI index media contract drifted",
  );
  requireCondition(
    Array.isArray(index.manifests) && index.manifests.length === 1,
    "OCI index must contain exactly one image manifest",
  );
  const manifestDescriptor = validateDescriptor(
    index.manifests[0],
    OCI_MANIFEST_MEDIA_TYPE,
    "OCI manifest descriptor",
  );
  const platform = requireObject(
    manifestDescriptor.platform,
    "OCI manifest platform",
  );
  requireCondition(
    platform.architecture === "amd64" && platform.os === "linux",
    "OCI manifest platform must be linux/amd64",
  );

  const manifestBytes = await readAndVerifyBlob(
    layoutRoot,
    manifestDescriptor,
    "OCI manifest",
  );
  const manifest = parseJson(manifestBytes, "OCI manifest");
  requireAllowedKeys(
    manifest,
    ["annotations", "config", "layers", "mediaType", "schemaVersion"],
    "OCI manifest",
  );
  requireCondition(
    manifest.schemaVersion === 2 &&
      manifest.mediaType === OCI_MANIFEST_MEDIA_TYPE,
    "OCI manifest media contract drifted",
  );
  const configDescriptor = validateDescriptor(
    manifest.config,
    OCI_CONFIG_MEDIA_TYPE,
    "OCI config descriptor",
  );
  requireCondition(
    Array.isArray(manifest.layers) && manifest.layers.length > 0,
    "OCI manifest must contain at least one layer",
  );
  const layerDescriptors = manifest.layers.map((value, index) =>
    validateDescriptor(
      value,
      OCI_LAYER_MEDIA_TYPE,
      `OCI layer descriptor ${index}`,
    ),
  );

  const configBytes = await readAndVerifyBlob(
    layoutRoot,
    configDescriptor,
    "OCI config",
  );
  const config = parseJson(configBytes, "OCI config");
  validateImageConfig(config, layerDescriptors.length);

  const layerDigests = [];
  const diffIds = [];
  let runtimeBinarySha256 = null;
  for (let index = 0; index < layerDescriptors.length; index += 1) {
    const descriptor = layerDescriptors[index];
    const compressed = await readAndVerifyBlob(
      layoutRoot,
      descriptor,
      `OCI layer ${index}`,
      MAX_LAYER_BYTES,
    );
    let uncompressed;
    try {
      uncompressed = gunzipSync(compressed, {
        maxOutputLength: MAX_LAYER_BYTES,
      });
    } catch {
      throw new Error(`OCI layer ${index} is not bounded valid gzip`);
    }
    const diffId = `sha256:${sha256Hex(uncompressed)}`;
    requireCondition(
      config.rootfs.diff_ids[index] === diffId,
      `OCI layer ${index} uncompressed diff ID drifted`,
    );
    layerDigests.push(descriptor.digest);
    diffIds.push(diffId);
    if (index === layerDescriptors.length - 1) {
      runtimeBinarySha256 = validateApplicationLayer(uncompressed);
    }
  }

  const expectedBlobDigests = new Set([
    manifestDescriptor.digest,
    configDescriptor.digest,
    ...layerDigests,
  ]);
  const actualBlobDigests = new Set(
    blobFiles.map((path) => `sha256:${path.slice("blobs/sha256/".length)}`),
  );
  requireCondition(
    equalSets(expectedBlobDigests, actualBlobDigests),
    "OCI layout blob inventory is incomplete or contains unattested blobs",
  );

  if (archiveSha256 !== null) requireSha256(archiveSha256, "archive SHA-256");
  if (archiveBytes !== null) {
    requireCondition(
      Number.isSafeInteger(archiveBytes) &&
        archiveBytes > 0 &&
        archiveBytes <= MAX_ARCHIVE_BYTES,
      "archive byte length is invalid",
    );
  }
  if (archiveMembers !== null) {
    requireCondition(
      Array.isArray(archiveMembers) &&
        archiveMembers.every((value) => typeof value === "string"),
      "archive member evidence is invalid",
    );
  }

  return {
    archiveSha256,
    archiveBytes,
    archiveMemberCount:
      archiveMembers === null
        ? inventory.files.length + inventory.directories.length
        : archiveMembers.length,
    layoutVersion: layout.imageLayoutVersion,
    indexSha256: sha256Hex(indexBytes),
    manifestDigest: manifestDescriptor.digest,
    manifestBytes: manifestDescriptor.size,
    configDigest: configDescriptor.digest,
    configBytes: configDescriptor.size,
    architecture: config.architecture,
    os: config.os,
    created: config.created,
    layerCount: layerDescriptors.length,
    layerDigests,
    diffIds,
    runtimeBinarySha256,
  };
}

export function compareOciReports(primaryValue, secondaryValue) {
  const primary = requireObject(primaryValue, "primary OCI report");
  const secondary = requireObject(secondaryValue, "secondary OCI report");
  const exactArchiveMatch =
    validSha256(primary.archiveSha256) &&
    validSha256(secondary.archiveSha256) &&
    primary.archiveSha256 === secondary.archiveSha256 &&
    primary.archiveBytes === secondary.archiveBytes;
  const exactIndexMatch =
    validSha256(primary.indexSha256) &&
    primary.indexSha256 === secondary.indexSha256;
  const exactManifestMatch =
    validDigest(primary.manifestDigest) &&
    primary.manifestDigest === secondary.manifestDigest &&
    primary.manifestBytes === secondary.manifestBytes;
  const exactConfigMatch =
    validDigest(primary.configDigest) &&
    primary.configDigest === secondary.configDigest &&
    primary.configBytes === secondary.configBytes;
  const exactCompressedLayerMatch =
    validDigestArray(primary.layerDigests) &&
    validDigestArray(secondary.layerDigests) &&
    JSON.stringify(primary.layerDigests) ===
      JSON.stringify(secondary.layerDigests);
  const exactDiffIdMatch =
    validDigestArray(primary.diffIds) &&
    validDigestArray(secondary.diffIds) &&
    JSON.stringify(primary.diffIds) === JSON.stringify(secondary.diffIds);
  const exactRuntimeBinaryMatch =
    validSha256(primary.runtimeBinarySha256) &&
    primary.runtimeBinarySha256 === secondary.runtimeBinarySha256;
  requireCondition(
    exactArchiveMatch &&
      exactIndexMatch &&
      exactManifestMatch &&
      exactConfigMatch &&
      exactCompressedLayerMatch &&
      exactDiffIdMatch &&
      exactRuntimeBinaryMatch,
    `independent OCI exports must be byte-identical and structurally identical (${JSON.stringify(
      {
        exactArchiveMatch,
        exactIndexMatch,
        exactManifestMatch,
        exactConfigMatch,
        exactCompressedLayerMatch,
        exactDiffIdMatch,
        exactRuntimeBinaryMatch,
      },
    )})`,
  );
  return {
    independentBuilds: 2,
    archiveSha256: primary.archiveSha256,
    archiveBytes: primary.archiveBytes,
    indexDigest: `sha256:${primary.indexSha256}`,
    manifestDigest: primary.manifestDigest,
    configDigest: primary.configDigest,
    layerCount: primary.layerCount,
    runtimeBinarySha256: primary.runtimeBinarySha256,
    exactArchiveMatch: true,
    exactIndexMatch: true,
    exactManifestMatch: true,
    exactConfigMatch: true,
    exactCompressedLayerMatch: true,
    exactDiffIdMatch: true,
    exactRuntimeBinaryMatch: true,
  };
}

function validateImageConfig(configValue, layerCount) {
  const config = requireObject(configValue, "OCI image config");
  requireCondition(
    config.architecture === "amd64" &&
      config.os === "linux" &&
      config.created === EPOCH_TIMESTAMP,
    "OCI image config platform or creation epoch drifted",
  );
  const runtime = requireObject(config.config, "OCI runtime config");
  requireCondition(
    runtime.User === "nonroot:nonroot" &&
      runtime.WorkingDir === "/" &&
      JSON.stringify(runtime.Entrypoint) ===
        JSON.stringify(["/usr/local/bin/cinatoken-container-runtime"]),
    "OCI runtime user, working directory, or entrypoint drifted",
  );
  const rootfs = requireObject(config.rootfs, "OCI rootfs config");
  requireCondition(
    rootfs.type === "layers" &&
      Array.isArray(rootfs.diff_ids) &&
      rootfs.diff_ids.length === layerCount &&
      rootfs.diff_ids.every(validDigest),
    "OCI rootfs diff ID inventory drifted",
  );
  requireCondition(
    Array.isArray(config.history) &&
      config.history.length > 0 &&
      config.history.every(
        (entry) =>
          isNonArrayObject(entry) &&
          (entry.created === undefined || entry.created === EPOCH_TIMESTAMP),
      ),
    "OCI image history timestamps drifted",
  );
}

function validateApplicationLayer(tarBytes) {
  const entries = parseTarEntries(tarBytes);
  let binary = null;
  const directories = new Set();
  for (const entry of entries) {
    if (entry.type === "directory") {
      requireCondition(
        ALLOWED_APPLICATION_DIRECTORIES.has(entry.path) &&
          entry.mode === 0o755 &&
          entry.uid === 0 &&
          entry.gid === 0 &&
          entry.mtime === SOURCE_DATE_EPOCH,
        `runtime application directory metadata drifted for ${entry.path}`,
      );
      directories.add(entry.path);
      continue;
    }
    requireCondition(
      entry.type === "file" &&
        entry.path === RUNTIME_BINARY_PATH &&
        entry.mode === 0o755 &&
        entry.uid === 0 &&
        entry.gid === 0 &&
        entry.mtime === SOURCE_DATE_EPOCH,
      `runtime application layer contains an unexpected entry: ${entry.path}`,
    );
    requireCondition(binary === null, "runtime application layer repeats binary");
    binary = entry;
  }
  requireCondition(
    equalSets(directories, ALLOWED_APPLICATION_DIRECTORIES),
    "runtime application layer directory inventory drifted",
  );
  requireCondition(binary !== null, "runtime binary is missing from final OCI layer");
  return sha256Hex(binary.content);
}

function parseTarEntries(bytes) {
  requireCondition(Buffer.isBuffer(bytes), "tar input must be bytes");
  const entries = [];
  let offset = 0;
  let terminated = false;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) {
      requireCondition(
        bytes.subarray(offset).every((value) => value === 0),
        "runtime application layer has data after its tar terminator",
      );
      terminated = true;
      break;
    }
    const expectedChecksum = tarOctal(
      header.subarray(148, 156),
      "header checksum",
    );
    let actualChecksum = 0;
    for (let index = 0; index < header.length; index += 1) {
      actualChecksum +=
        index >= 148 && index < 156 ? 0x20 : header[index];
    }
    requireCondition(
      actualChecksum === expectedChecksum,
      "runtime application layer tar checksum drifted",
    );
    const name = tarString(header.subarray(0, 100));
    const prefix = tarString(header.subarray(345, 500));
    const path = normalizeTarPath(prefix.length > 0 ? `${prefix}/${name}` : name);
    const mode = tarOctal(header.subarray(100, 108), "mode");
    const uid = tarOctal(header.subarray(108, 116), "uid");
    const gid = tarOctal(header.subarray(116, 124), "gid");
    const size = tarOctal(header.subarray(124, 136), "size");
    const mtime = tarOctal(header.subarray(136, 148), "mtime");
    const typeFlag = header[156];
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    requireCondition(dataEnd <= bytes.length, "tar entry exceeds layer bytes");
    let type;
    if (typeFlag === 0 || typeFlag === 48) type = "file";
    else if (typeFlag === 53) type = "directory";
    else throw new Error(`runtime application layer has unsupported tar type ${typeFlag}`);
    entries.push({
      path,
      type,
      mode,
      uid,
      gid,
      mtime,
      content:
        type === "file" ? Buffer.from(bytes.subarray(dataStart, dataEnd)) : null,
    });
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  requireCondition(
    terminated,
    "runtime application layer tar has no zero-block terminator",
  );
  requireCondition(entries.length > 0, "runtime application layer tar is empty");
  requireCondition(
    new Set(entries.map((entry) => entry.path)).size === entries.length,
    "runtime application layer repeats a path",
  );
  return entries;
}

async function collectLayoutInventory(root) {
  const files = [];
  const directories = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const logical = relative(root, absolute).replaceAll("\\", "/");
      const metadata = await lstat(absolute);
      requireCondition(
        !metadata.isSymbolicLink(),
        `OCI layout contains a symbolic link: ${logical}`,
      );
      if (metadata.isDirectory()) {
        directories.push(logical);
        await walk(absolute);
      } else {
        requireCondition(
          metadata.isFile(),
          `OCI layout contains a non-regular file: ${logical}`,
        );
        files.push(logical);
      }
    }
  }
  await walk(root);
  files.sort();
  directories.sort();
  return { files, directories };
}

async function readAndVerifyBlob(
  root,
  descriptor,
  label,
  maximumBytes = MAX_JSON_BYTES,
) {
  const digest = descriptor.digest.slice("sha256:".length);
  const bytes = await readBoundedFile(
    join(root, "blobs", "sha256", digest),
    label,
    maximumBytes,
  );
  requireCondition(bytes.length === descriptor.size, `${label} size drifted`);
  requireCondition(sha256Hex(bytes) === digest, `${label} digest drifted`);
  return bytes;
}

function validateDescriptor(value, mediaType, label) {
  const descriptor = requireObject(value, label);
  requireAllowedKeys(
    descriptor,
    ["annotations", "digest", "mediaType", "platform", "size"],
    label,
  );
  requireCondition(
    descriptor.mediaType === mediaType &&
      validDigest(descriptor.digest) &&
      Number.isSafeInteger(descriptor.size) &&
      descriptor.size > 0 &&
      descriptor.size <= MAX_LAYER_BYTES,
    `${label} is malformed`,
  );
  return descriptor;
}

async function readBoundedJson(path, label) {
  return parseJson(await readBoundedFile(path, label), label);
}

async function readBoundedFile(path, label, maximumBytes = MAX_JSON_BYTES) {
  const metadata = await stat(path);
  requireCondition(
    metadata.isFile() && metadata.size > 0 && metadata.size <= maximumBytes,
    `${label} must be a nonempty bounded regular file`,
  );
  return await readFile(path);
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`${label} is not valid UTF-8 JSON`);
  }
}

async function hashFile(path) {
  const hash = createHash("sha256");
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", rejectPromise);
    stream.once("end", resolvePromise);
  });
  return hash.digest("hex");
}

async function runChecked(command, args, timeoutMs, maxOutputBytes) {
  const result = await runBoundedSubprocess(command, args, {
    cwd: ROOT,
    timeoutMs,
    maxOutputBytes,
    killGraceMs: 2_000,
    env: { ...process.env, LC_ALL: "C" },
  });
  requireCondition(
    result.exitCode === 0 &&
      !result.timedOut &&
      !result.outputLimitExceeded &&
      !result.invalidUtf8,
    `${command} failed while reading OCI evidence`,
  );
  return result;
}

function normalizeArchiveMember(value) {
  requireCondition(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= 256 &&
      !value.includes("\\") &&
      !value.includes("\0"),
    "OCI archive contains an invalid member path",
  );
  let normalized = value;
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  normalized = normalized.replace(/\/+$/, "");
  requireCondition(
    normalized.length > 0 &&
      !normalized.startsWith("/") &&
      normalized.split("/").every((segment) => segment !== "" && segment !== ".." && segment !== "."),
    "OCI archive member path escaped the layout",
  );
  requireCondition(
    normalized === "index.json" ||
      normalized === "oci-layout" ||
      ALLOWED_LAYOUT_DIRECTORIES.has(normalized) ||
      /^blobs\/sha256\/[a-f0-9]{64}$/.test(normalized),
    `OCI archive contains an unexpected member: ${normalized}`,
  );
  return normalized;
}

function normalizeTarPath(value) {
  requireCondition(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= 256 &&
      !value.includes("\\") &&
      !value.includes("\0"),
    "runtime application layer contains an invalid path",
  );
  let normalized = value;
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  normalized = normalized.replace(/\/+$/, "");
  requireCondition(
    normalized.length > 0 &&
      !normalized.startsWith("/") &&
      normalized.split("/").every((segment) => segment !== "" && segment !== ".." && segment !== "."),
    "runtime application layer path escaped root",
  );
  return normalized;
}

function tarString(bytes) {
  const end = bytes.indexOf(0);
  const bounded = end === -1 ? bytes : bytes.subarray(0, end);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bounded);
  } catch {
    throw new Error("runtime application layer tar path is invalid UTF-8");
  }
}

function tarOctal(bytes, label) {
  const value = tarString(bytes).trim();
  requireCondition(/^[0-7]+$/.test(value), `tar ${label} is not octal`);
  const parsed = Number.parseInt(value, 8);
  requireCondition(Number.isSafeInteger(parsed), `tar ${label} is out of range`);
  return parsed;
}

function requireExactKeys(value, keys, label) {
  const object = requireObject(value, label);
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  requireCondition(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label} keys drifted`,
  );
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
  requireCondition(isNonArrayObject(value), `${label} must be an object`);
  return value;
}

function isNonArrayObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validArchivePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1024 &&
    !value.startsWith("-") &&
    !value.includes("\0")
  );
}

function validDigest(value) {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function validDigestArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(validDigest);
}

function validSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function requireSha256(value, label) {
  requireCondition(validSha256(value), `${label} must be lowercase SHA-256`);
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function equalSets(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = options.selfTest
    ? await auditRepositoryContract()
    : await runOciGate(options.archiveA, options.archiveB);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`container runtime OCI gate: ${report.status}\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(
      `container runtime OCI gate failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
