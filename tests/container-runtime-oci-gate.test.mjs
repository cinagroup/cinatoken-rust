import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, test } from "bun:test";

import { runBoundedSubprocess } from "../tools/lib/bounded_subprocess.mjs";
import {
  BUILDKIT_IMAGE,
  OCI_CONFIG_MEDIA_TYPE,
  OCI_GATE_CONTRACT_VERSION,
  OCI_INDEX_MEDIA_TYPE,
  OCI_LAYER_MEDIA_TYPE,
  OCI_LAYOUT_VERSION,
  OCI_MANIFEST_MEDIA_TYPE,
  SOURCE_DATE_EPOCH,
  auditRepositoryContract,
  compareOciReports,
  parseArgs,
  validateOciLayout,
} from "../tools/verify_container_runtime_oci.mjs";

const RUNTIME_BINARY_PATH =
  "usr/local/bin/cinatoken-container-runtime";
const RUNTIME_ENTRYPOINT = `/${RUNTIME_BINARY_PATH}`;
const EPOCH_TIMESTAMP = "1970-01-01T00:00:00Z";
const temporaryDirectories = new Set();

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
  temporaryDirectories.clear();
});

describe("container runtime OCI release gate", () => {
  test("pins actions and BuildKit while producing exactly two deterministic OCI archives", async () => {
    const workflow = await Bun.file(
      new URL(
        "../.github/workflows/container-runtime-oci.yml",
        import.meta.url,
      ),
    ).text();
    const actionReferences = [
      ...workflow.matchAll(/^\s*uses:\s*(\S+)\s*$/gm),
    ].map((match) => match[1]);

    expect(actionReferences.length).toBeGreaterThanOrEqual(2);
    for (const reference of actionReferences) {
      expect(reference).toMatch(/^[^@\s]+@[a-f0-9]{40}$/);
    }
    expect(BUILDKIT_IMAGE).toMatch(
      /^moby\/buildkit:[^@\s]+@sha256:[a-f0-9]{64}$/,
    );
    expect(workflow).toContain(`BUILDKIT_IMAGE: ${BUILDKIT_IMAGE}`);
    expect(workflow).toContain('image=${BUILDKIT_IMAGE}');
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow.match(/docker buildx build\b/g)).toHaveLength(2);
    expect(workflow.match(/--no-cache\b/g)).toHaveLength(2);
    expect(workflow.match(/--output\s+"?type=oci,/g)).toHaveLength(2);
    expect(workflow.match(/rewrite-timestamp=true/g)).toHaveLength(2);
    expect(workflow.match(/compression=gzip/g)).toHaveLength(2);
    expect(workflow.match(/compression-level=9/g)).toHaveLength(2);
    expect(workflow.match(/force-compression=true/g)).toHaveLength(2);
    expect(workflow.match(/oci-mediatypes=true/g)).toHaveLength(2);
    expect(workflow.match(/compatibility-version=20/g)).toHaveLength(2);
    expect(workflow.match(/--provenance=false/g)).toHaveLength(2);
    expect(workflow.match(/--sbom=false/g)).toHaveLength(2);
    expect(workflow.match(/--build-arg SOURCE_DATE_EPOCH=0/g)).toHaveLength(2);
    expect(workflow).toContain(
      "node tools/verify_container_runtime_oci.mjs",
    );
    expect(workflow).toContain("--archive-a");
    expect(workflow).toContain("--archive-b");
    expect(workflow).not.toMatch(
      /\$\{\{\s*secrets\.|--secret(?:=|\s)|secret-envs\s*:|secret-files\s*:/i,
    );
    expect(workflow).not.toMatch(
      /docker\/login-action|push=true|wrangler|cloudflare api/i,
    );
  });

  test("keeps self-test and dual-archive CLI modes mutually exclusive", () => {
    expect(parseArgs(["--self-test", "--json"])).toEqual({
      selfTest: true,
      archiveA: null,
      archiveB: null,
      json: true,
    });
    expect(
      parseArgs([
        "--archive-a",
        "runtime-a.oci.tar",
        "--archive-b",
        "runtime-b.oci.tar",
      ]),
    ).toEqual({
      selfTest: false,
      archiveA: "runtime-a.oci.tar",
      archiveB: "runtime-b.oci.tar",
      json: false,
    });

    expect(() => parseArgs([])).toThrow(/select --self-test|archive mode/i);
    expect(() => parseArgs(["--archive-a"])).toThrow(
      /both|archive-a.*archive-b/i,
    );
    expect(() =>
      parseArgs(["--archive-a", "runtime-a.oci.tar"]),
    ).toThrow(/both|archive-b/i);
    expect(() =>
      parseArgs([
        "--archive-b",
        "runtime-b.oci.tar",
      ]),
    ).toThrow(/both|archive-a/i);
    expect(() =>
      parseArgs([
        "--self-test",
        "--archive-a",
        "runtime-a.oci.tar",
        "--archive-b",
        "runtime-b.oci.tar",
      ]),
    ).toThrow(/mutually exclusive|select --self-test/i);
    expect(() =>
      parseArgs([
        "--archive-a",
        "--not-an-archive",
        "--archive-b",
        "runtime-b.oci.tar",
      ]),
    ).toThrow(/must not start|archive reference/i);
    expect(() =>
      parseArgs([
        "--archive-a",
        "runtime-a.oci.tar",
        "--archive-b",
        "-runtime-b.oci.tar",
      ]),
    ).toThrow(/must not start|archive reference/i);
    expect(() => parseArgs(["--unknown"])).toThrow(/unknown argument/i);
  });

  test("self-test audits only the credential-free offline repository contract", async () => {
    const report = await auditRepositoryContract();
    expect(report).toMatchObject({
      contractVersion: OCI_GATE_CONTRACT_VERSION,
      status: "passed",
      buildkitImage: BUILDKIT_IMAGE,
      buildkitPinnedByDigest: true,
      independentOciBuildsRequired: 2,
      sourceDateEpoch: SOURCE_DATE_EPOCH,
      compression: "gzip",
      compressionLevel: 9,
      compatibilityVersion: 20,
      exactArchiveBytesRequired: true,
      exactIndexManifestConfigLayersRequired: true,
      defaultProvenanceDisabled: true,
      defaultSbomDisabled: true,
      generatedProvenancePresent: false,
      generatedSbomPresent: false,
      registryDigestAuthorized: false,
      remoteMutationAuthorized: false,
      customerTrafficAuthorized: false,
      productionCutoverAuthorized: false,
    });

    const command = await runBoundedSubprocess(
      "node",
      ["tools/verify_container_runtime_oci.mjs", "--self-test", "--json"],
      { timeoutMs: 10_000 },
    );
    expect(command.exitCode).toBe(0);
    expect(command.timedOut).toBe(false);
    expect(command.outputLimitExceeded).toBe(false);
    expect(JSON.parse(command.stdout)).toEqual(report);
  });

  test("validates the complete descriptor graph, gzip diff IDs, and runtime binary", async () => {
    const fixture = await buildOciLayoutFixture();
    const report = await validateFixture(fixture);

    expect(report).toMatchObject({
      archiveSha256: fixture.archiveSha256,
      archiveBytes: fixture.archiveBytes,
      layoutVersion: OCI_LAYOUT_VERSION,
      indexSha256: fixture.indexSha256,
      manifestDigest: fixture.manifestDescriptor.digest,
      manifestBytes: fixture.manifestDescriptor.size,
      configDigest: fixture.configDescriptor.digest,
      configBytes: fixture.configDescriptor.size,
      architecture: "amd64",
      os: "linux",
      created: EPOCH_TIMESTAMP,
      layerCount: 2,
      layerDigests: fixture.layers.map(
        (layer) => layer.descriptor.digest,
      ),
      diffIds: fixture.layers.map((layer) => layer.diffId),
      runtimeBinarySha256: fixture.runtimeBinarySha256,
    });
    expect(report.layerDigests).toHaveLength(2);
    expect(report.diffIds).toHaveLength(2);
  });

  test("rejects descriptor size and content-hash drift", async () => {
    const sizeDrift = await buildOciLayoutFixture();
    const index = JSON.parse(
      await readFile(join(sizeDrift.root, "index.json"), "utf8"),
    );
    index.manifests[0].size += 1;
    await writeJson(join(sizeDrift.root, "index.json"), index);
    await expect(validateFixture(sizeDrift)).rejects.toThrow(
      /manifest descriptor.*size|size mismatch|size drifted/i,
    );

    const hashDrift = await buildOciLayoutFixture();
    const manifestPath = blobPath(
      hashDrift.root,
      hashDrift.manifestDescriptor.digest,
    );
    const manifestBytes = await readFile(manifestPath);
    manifestBytes[manifestBytes.length - 2] ^= 1;
    await writeFile(manifestPath, manifestBytes);
    await expect(validateFixture(hashDrift)).rejects.toThrow(
      /manifest.*digest|digest mismatch|hash mismatch/i,
    );
  });

  test("rejects config platform, epoch, identity, cwd, and entrypoint drift", async () => {
    const cases = [
      [
        "architecture",
        { architecture: "arm64" },
        /platform|creation epoch/i,
      ],
      ["os", { os: "windows" }, /platform|creation epoch/i],
      [
        "created",
        { created: "1970-01-01T00:00:01Z" },
        /platform|creation epoch/i,
      ],
      [
        "user",
        { config: { User: "0:0" } },
        /runtime user|working directory|entrypoint/i,
      ],
      [
        "cwd",
        { config: { WorkingDir: "/tmp" } },
        /runtime user|working directory|entrypoint/i,
      ],
      [
        "entrypoint",
        { config: { Entrypoint: ["/bin/sh"] } },
        /runtime user|working directory|entrypoint/i,
      ],
    ];

    for (const [label, configOverrides, errorPattern] of cases) {
      const fixture = await buildOciLayoutFixture({ configOverrides });
      await expect(validateFixture(fixture), label).rejects.toThrow(
        errorPattern,
      );
    }
  });

  test("requires exact archive and complete OCI identity across independent builds", async () => {
    const primaryFixture = await buildOciLayoutFixture();
    const secondaryFixture = await buildOciLayoutFixture({
      archiveSha256: primaryFixture.archiveSha256,
      archiveBytes: primaryFixture.archiveBytes,
    });
    const primary = await validateFixture(primaryFixture);
    const secondary = await validateFixture(secondaryFixture);

    expect(compareOciReports(primary, secondary)).toMatchObject({
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
    });

    const driftCases = [
      [
        "archive",
        (report) => {
          report.archiveSha256 = sha256Hex(
            Buffer.from("archive-drift"),
          );
        },
        /archive/i,
      ],
      [
        "index",
        (report) => {
          report.indexSha256 = sha256Hex(Buffer.from("index-drift"));
        },
        /index/i,
      ],
      [
        "manifest",
        (report) => {
          report.manifestDigest = digestOf("manifest-drift");
        },
        /manifest/i,
      ],
      [
        "config",
        (report) => {
          report.configDigest = digestOf("config-drift");
        },
        /config/i,
      ],
      [
        "layer",
        (report) => {
          report.layerDigests[0] = digestOf("layer-drift");
        },
        /layer/i,
      ],
      [
        "diff ID",
        (report) => {
          report.diffIds[0] = digestOf("diff-id-drift");
        },
        /diff.?id/i,
      ],
      [
        "binary",
        (report) => {
          report.runtimeBinarySha256 = sha256Hex(
            Buffer.from("binary-drift"),
          );
        },
        /binary/i,
      ],
    ];

    for (const [label, mutate, errorPattern] of driftCases) {
      const drifted = structuredClone(secondary);
      mutate(drifted);
      expect(
        () => compareOciReports(primary, drifted),
        label,
      ).toThrow(errorPattern);
    }
  });

  test("rejects orphan blobs, malformed digests, and empty layers", async () => {
    const orphanFixture = await buildOciLayoutFixture();
    const orphan = Buffer.from("unreferenced-blob");
    await writeFile(
      blobPath(orphanFixture.root, digestFor(orphan)),
      orphan,
    );
    await expect(validateFixture(orphanFixture)).rejects.toThrow(
      /extra blob|orphan|unreferenced|unattested/i,
    );

    const malformedFixture = await buildOciLayoutFixture();
    const malformedIndex = JSON.parse(
      await readFile(join(malformedFixture.root, "index.json"), "utf8"),
    );
    malformedIndex.manifests[0].digest = "sha256:not-a-digest";
    await writeJson(
      join(malformedFixture.root, "index.json"),
      malformedIndex,
    );
    await expect(validateFixture(malformedFixture)).rejects.toThrow(
      /malformed digest|invalid digest|is malformed|sha256/i,
    );

    const emptyLayerFixture = await buildOciLayoutFixture({
      emptyAppLayer: true,
    });
    await expect(validateFixture(emptyLayerFixture)).rejects.toThrow(
      /empty.*layer|layer.*empty/i,
    );
  });
});

async function validateFixture(fixture) {
  return validateOciLayout(fixture.root, {
    archiveSha256: fixture.archiveSha256,
    archiveBytes: fixture.archiveBytes,
  });
}

async function buildOciLayoutFixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "cinatoken-oci-gate-"));
  temporaryDirectories.add(root);
  await mkdir(join(root, "blobs", "sha256"), { recursive: true });

  const runtimeBinary = Buffer.from(
    "\x7fELF-cinatoken-container-runtime-fixture\n",
    "binary",
  );
  const baseLayer = tarArchive([
    {
      path: "etc/cinatoken-release",
      body: Buffer.from("cinatoken-runtime-fixture\n"),
      mode: 0o644,
    },
  ]);
  const appLayer = options.emptyAppLayer
    ? Buffer.alloc(1024)
    : tarArchive([
        {
          path: "usr",
          body: Buffer.alloc(0),
          mode: 0o755,
          type: "directory",
        },
        {
          path: "usr/local",
          body: Buffer.alloc(0),
          mode: 0o755,
          type: "directory",
        },
        {
          path: "usr/local/bin",
          body: Buffer.alloc(0),
          mode: 0o755,
          type: "directory",
        },
        {
          path: RUNTIME_BINARY_PATH,
          body: runtimeBinary,
          mode: 0o755,
        },
      ]);
  const layers = await Promise.all(
    [baseLayer, appLayer].map(async (uncompressed) => {
      const compressed = gzipSync(uncompressed, {
        level: 9,
        mtime: SOURCE_DATE_EPOCH,
      });
      const descriptor = await writeBlob(
        root,
        compressed,
        OCI_LAYER_MEDIA_TYPE,
      );
      return {
        compressed,
        descriptor,
        diffId: digestFor(uncompressed),
        uncompressed,
      };
    }),
  );

  const config = mergeConfig(
    {
      architecture: "amd64",
      config: {
        Entrypoint: [RUNTIME_ENTRYPOINT],
        User: "nonroot:nonroot",
        WorkingDir: "/",
      },
      created: EPOCH_TIMESTAMP,
      history: layers.map(() => ({
        created: EPOCH_TIMESTAMP,
        created_by: "cinatoken OCI gate fixture",
      })),
      os: "linux",
      rootfs: {
        diff_ids: layers.map((layer) => layer.diffId),
        type: "layers",
      },
    },
    options.configOverrides ?? {},
  );
  const configDescriptor = await writeJsonBlob(
    root,
    config,
    OCI_CONFIG_MEDIA_TYPE,
  );
  const manifest = {
    config: configDescriptor,
    layers: layers.map((layer) => layer.descriptor),
    mediaType: OCI_MANIFEST_MEDIA_TYPE,
    schemaVersion: 2,
  };
  const manifestBytes = jsonBytes(manifest);
  const manifestDescriptor = await writeBlob(
    root,
    manifestBytes,
    OCI_MANIFEST_MEDIA_TYPE,
  );
  const index = {
    manifests: [
      {
        ...manifestDescriptor,
        platform: {
          architecture: "amd64",
          os: "linux",
        },
      },
    ],
    mediaType: OCI_INDEX_MEDIA_TYPE,
    schemaVersion: 2,
  };
  const indexBytes = jsonBytes(index);
  await writeFile(join(root, "index.json"), indexBytes);
  await writeJson(join(root, "oci-layout"), {
    imageLayoutVersion: OCI_LAYOUT_VERSION,
  });

  const archiveIdentity = Buffer.concat([
    Buffer.from("fixture-oci-archive-v1\0"),
    indexBytes,
    manifestBytes,
    ...layers.map((layer) => layer.compressed),
  ]);

  return {
    archiveSha256:
      options.archiveSha256 ?? sha256Hex(archiveIdentity),
    archiveBytes: options.archiveBytes ?? archiveIdentity.length,
    configDescriptor,
    indexBytes,
    indexSha256: sha256Hex(indexBytes),
    layers,
    manifestDescriptor,
    root,
    runtimeBinarySha256: sha256Hex(runtimeBinary),
  };
}

function mergeConfig(base, overrides) {
  return {
    ...base,
    ...overrides,
    config: {
      ...base.config,
      ...(overrides.config ?? {}),
    },
    rootfs: {
      ...base.rootfs,
      ...(overrides.rootfs ?? {}),
    },
  };
}

async function writeJsonBlob(root, value, mediaType) {
  return writeBlob(root, jsonBytes(value), mediaType);
}

async function writeBlob(root, bytes, mediaType) {
  const digest = digestFor(bytes);
  await writeFile(blobPath(root, digest), bytes);
  return {
    digest,
    mediaType,
    size: bytes.length,
  };
}

function blobPath(root, digest) {
  const match = /^sha256:([a-f0-9]{64})$/.exec(digest);
  if (!match) {
    throw new Error(`fixture digest is malformed: ${digest}`);
  }
  return join(root, "blobs", "sha256", match[1]);
}

function tarArchive(entries) {
  const parts = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    writeTarString(header, 0, 100, entry.path);
    writeTarOctal(header, 100, 8, entry.mode);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, entry.body.length);
    writeTarOctal(header, 136, 12, SOURCE_DATE_EPOCH);
    header.fill(0x20, 148, 156);
    header[156] =
      entry.type === "directory"
        ? "5".charCodeAt(0)
        : "0".charCodeAt(0);
    writeTarString(header, 257, 6, "ustar");
    writeTarString(header, 263, 2, "00");
    writeTarString(header, 265, 32, "root");
    writeTarString(header, 297, 32, "root");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    const checksumText = `${checksum.toString(8).padStart(6, "0")}\0 `;
    header.write(checksumText, 148, 8, "ascii");

    parts.push(header, entry.body);
    const remainder = entry.body.length % 512;
    if (remainder !== 0) {
      parts.push(Buffer.alloc(512 - remainder));
    }
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

function writeTarString(buffer, offset, length, value) {
  const encoded = Buffer.from(value, "ascii");
  if (encoded.length > length) {
    throw new Error(`tar fixture field is too long: ${value}`);
  }
  encoded.copy(buffer, offset);
}

function writeTarOctal(buffer, offset, length, value) {
  const encoded = `${value.toString(8).padStart(length - 1, "0")}\0`;
  buffer.write(encoded, offset, length, "ascii");
}

function jsonBytes(value) {
  return Buffer.from(JSON.stringify(value));
}

async function writeJson(path, value) {
  await writeFile(path, jsonBytes(value));
}

function digestFor(bytes) {
  return `sha256:${sha256Hex(bytes)}`;
}

function digestOf(value) {
  return digestFor(Buffer.from(value));
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
