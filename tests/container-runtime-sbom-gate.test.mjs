import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { runBoundedSubprocess } from "../tools/lib/bounded_subprocess.mjs";
import {
  SBOM_GATE_CONTRACT_VERSION,
  SBOM_INPUT_REFERENCE,
  SBOM_SOURCE_NAME,
  SBOM_SOURCE_REFERENCE,
  SYFT_IMAGE,
  SYFT_SCHEMA_VERSION,
  SYFT_VERSION,
  auditRepositoryContract,
  parseArgs,
  runSbomGate,
  validateGeneratorFunction,
  validateOciReport,
  validateSyftSbom,
} from "../tools/verify_container_runtime_sbom.mjs";

const OCI_MANIFEST_MEDIA_TYPE =
  "application/vnd.oci.image.manifest.v1+json";
const OCI_CONFIG_MEDIA_TYPE =
  "application/vnd.oci.image.config.v1+json";
const OCI_LAYER_MEDIA_TYPE =
  "application/vnd.oci.image.layer.v1.tar+gzip";
const temporaryDirectories = new Set();

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
  temporaryDirectories.clear();
});

describe("container runtime SBOM release gate", () => {
  test("pins Syft and isolates two catalogs of the verified OCI archives", async () => {
    const workflow = await Bun.file(
      new URL(
        "../.github/workflows/container-runtime-oci.yml",
        import.meta.url,
      ),
    ).text();

    expect(SYFT_IMAGE).toMatch(
      /^ghcr\.io\/anchore\/syft:v1\.49\.0@sha256:[a-f0-9]{64}$/,
    );
    expect(workflow).toContain(`SYFT_IMAGE: ${SYFT_IMAGE}`);
    expect(workflow).toContain(
      'docker pull --platform linux/amd64 "${SYFT_IMAGE}"',
    );
    expect(workflow.match(/^\s*generate_sbom\s+\\$/gm)).toHaveLength(2);
    for (const option of [
      "--pull never",
      "--platform linux/amd64",
      "--network none",
      "--read-only",
      "--cap-drop ALL",
      "--security-opt no-new-privileges=true",
      '--user "$(id -u):$(id -g)"',
      "--pids-limit 256",
      "--memory 1g",
      "--cpus 2",
      "--ulimit nofile=1024:1024",
      "--ulimit fsize=67108864:67108864",
      "--tmpfs /tmp:rw,noexec,nosuid,nodev,size=128m,mode=1777",
      "--scope squashed",
      `--source-name ${SBOM_SOURCE_NAME}`,
      '--source-version "${OCI_MANIFEST_DIGEST}"',
      "--output syft-json=/output/container-runtime.sbom.syft.json",
    ]) {
      expect(workflow).toContain(option);
    }
    expect(workflow).toContain(`"${SBOM_INPUT_REFERENCE}"`);
    expect(workflow).toContain(
      '--mount "type=bind,src=${output_file},dst=/output/container-runtime.sbom.syft.json"',
    );
    expect(workflow).toContain(
      "node tools/verify_container_runtime_sbom.mjs",
    );
    expect(workflow).not.toMatch(
      /\bid-token:\s*write\b|\bpackages:\s*write\b|\$\{\{\s*secrets\./i,
    );
    expect(workflow).not.toMatch(
      /docker login|registry login|cosign sign|wrangler|cloudflare api/i,
    );
  });

  test("rejects conflicting privileged cataloger options", async () => {
    const workflow = await Bun.file(
      new URL(
        "../.github/workflows/container-runtime-oci.yml",
        import.meta.url,
      ),
    ).text();
    const block = workflow.match(
      /^\s{10}generate_sbom\(\) \{\n[\s\S]*?^\s{10}\}$/m,
    )?.[0];
    expect(block).toBeDefined();
    validateGeneratorFunction(block);

    for (const fragment of [
      "              --privileged \\",
      "              --network host \\",
      "              --user 0:0 \\",
      "              --cap-add SYS_ADMIN \\",
      "              --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \\",
    ]) {
      const drifted = block.replace(
        "              --pull never \\",
        `              --pull never \\\n${fragment}`,
      );
      expect(() => validateGeneratorFunction(drifted)).toThrow(
        /conflicting privileged|exactly one/i,
      );
    }
  });

  test("keeps self-test and complete real-gate CLI modes exclusive", () => {
    expect(parseArgs(["--self-test", "--json"])).toEqual({
      selfTest: true,
      sbomA: null,
      sbomB: null,
      ociReport: null,
      json: true,
    });
    expect(
      parseArgs([
        "--sbom-a",
        "a.json",
        "--sbom-b",
        "b.json",
        "--oci-report",
        "oci.json",
      ]),
    ).toEqual({
      selfTest: false,
      sbomA: "a.json",
      sbomB: "b.json",
      ociReport: "oci.json",
      json: false,
    });
    expect(() => parseArgs([])).toThrow(/select --self-test/i);
    expect(() =>
      parseArgs(["--sbom-a", "a.json", "--sbom-b", "b.json"]),
    ).toThrow(/all --sbom-a/i);
    expect(() =>
      parseArgs([
        "--self-test",
        "--sbom-a",
        "a.json",
        "--sbom-b",
        "b.json",
        "--oci-report",
        "oci.json",
      ]),
    ).toThrow(/select --self-test/i);
    expect(() =>
      parseArgs([
        "--sbom-a",
        "-a.json",
        "--sbom-b",
        "b.json",
        "--oci-report",
        "oci.json",
      ]),
    ).toThrow(/must not start/i);
    expect(() => parseArgs(["--unknown"])).toThrow(/unknown argument/i);
  });

  test("self-test preserves all unproven supply-chain and production facts", async () => {
    const report = await auditRepositoryContract();
    expect(report).toMatchObject({
      contractVersion: SBOM_GATE_CONTRACT_VERSION,
      status: "passed",
      reportKind: "container-runtime-sbom-contract-audit",
      decision: {
        scope: "local-sbom-reproducibility-only",
        formalP5Evidence: false,
        vulnerabilityDecision: "not-performed",
        productionDecision: "not-authorized",
      },
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
      imageSignatureVerificationPerformed: false,
      imageSignatureVerified: false,
      registryReadbackVerified: false,
      cloudflareDeploymentDigestVerified: false,
      transparencyLogVerified: false,
      wormRetentionVerified: false,
      p5SbomSourceGenerated: false,
      p5Eligible: false,
      remoteMutationAuthorized: false,
      customerTrafficAuthorized: false,
      productionCutoverAuthorized: false,
    });

    const command = await runBoundedSubprocess(
      "node",
      [
        "tools/verify_container_runtime_sbom.mjs",
        "--self-test",
        "--json",
      ],
      { timeoutMs: 10_000 },
    );
    expect(command.exitCode).toBe(0);
    expect(command.timedOut).toBe(false);
    expect(command.outputLimitExceeded).toBe(false);
    expect(JSON.parse(command.stdout)).toEqual(report);
  });

  test("binds a byte-identical Syft inventory to the complete OCI subject", async () => {
    const fixture = buildFixture();
    const facts = validateSyftSbom(fixture.sbom, fixture.ociReport);

    expect(facts).toEqual({
      packageCount: 2,
      relationshipCount: 1,
      sourceId: fixture.sbom.source.id,
      sourceManifestDigest: fixture.ociReport.ociManifestDigest,
      sourceConfigDigest: fixture.ociReport.ociConfigDigest,
      sourceMediaType: OCI_MANIFEST_MEDIA_TYPE,
      sourcePlatformMetadataPresent: true,
      sourceLayerDigestKind: "uncompressed-diff-id",
      sourceLayerCount: 2,
    });

    const paths = await writeGateFixture(fixture);
    const report = await runSbomGate(
      paths.sbomA,
      paths.sbomB,
      paths.ociReport,
    );
    expect(report).toMatchObject({
      contractVersion: SBOM_GATE_CONTRACT_VERSION,
      status: "passed",
      reportKind: "container-runtime-sbom-reproducibility",
      decision: {
        scope: "local-sbom-reproducibility-only",
        formalP5Evidence: false,
        vulnerabilityDecision: "not-performed",
        productionDecision: "not-authorized",
      },
      subject: {
        archiveSha256:
          fixture.ociReport.reproducibility.archiveSha256,
        ociManifestDigest: fixture.ociReport.ociManifestDigest,
        ociConfigDigest: fixture.ociReport.ociConfigDigest,
        compressedLayerDigests:
          fixture.ociReport.compressedLayerDigests,
        uncompressedLayerDiffIds:
          fixture.ociReport.uncompressedLayerDiffIds,
        runtimeBinarySha256:
          fixture.ociReport.runtimeBinarySha256,
      },
      generator: {
        image: SYFT_IMAGE,
        name: "syft",
        version: SYFT_VERSION,
        schemaVersion: SYFT_SCHEMA_VERSION,
        inputReference: SBOM_INPUT_REFERENCE,
        sourceReference: SBOM_SOURCE_REFERENCE,
        networkDisabled: true,
        runsAsRoot: false,
      },
      sbom: {
        sha256: sha256Hex(paths.sbomBytes),
        bytes: paths.sbomBytes.length,
        exactIndependentMatch: true,
        packageCount: 2,
        relationshipCount: 1,
        sourceLayerCount: 2,
        sourceMediaType: OCI_MANIFEST_MEDIA_TYPE,
        sourcePlatformMetadataPresent: true,
        sourceLayerDigestKind: "uncompressed-diff-id",
      },
      generatedSbomPresent: true,
      generatedProvenancePresent: false,
      vulnerabilityScanPresent: false,
      unapprovedCriticalVulnerabilities: null,
      unapprovedHighVulnerabilities: null,
      canonicalContainerImageDigest: null,
      imageSignatureVerificationPerformed: false,
      p5SbomSourceGenerated: false,
      p5Eligible: false,
      productionCutoverAuthorized: false,
    });
    assertNoFormalP5Fields(report);
  });

  test("rejects nonidentical independent SBOM bytes", async () => {
    const fixture = buildFixture();
    const paths = await writeGateFixture(fixture);
    const drifted = structuredClone(fixture.sbom);
    drifted.artifacts[0].name = "drifted-package";
    await writeFile(paths.sbomB, `${JSON.stringify(drifted)}\n`);

    await expect(
      runSbomGate(paths.sbomA, paths.sbomB, paths.ociReport),
    ).rejects.toThrow(/not byte-identical/i);
  });

  test("rejects OCI reports without complete reproducibility proof", () => {
    const fixture = buildFixture();
    validateOciReport(fixture.ociReport);

    for (const field of [
      "exactArchiveMatch",
      "exactIndexMatch",
      "exactManifestMatch",
      "exactConfigMatch",
      "exactCompressedLayerMatch",
      "exactDiffIdMatch",
      "exactRuntimeBinaryMatch",
    ]) {
      const drifted = structuredClone(fixture.ociReport);
      drifted.reproducibility[field] = false;
      expect(() => validateOciReport(drifted)).toThrow(
        /complete archive reproducibility/i,
      );
    }
  });

  test("rejects generator, schema, source, and platform drift", () => {
    const fixture = buildFixture();
    const omittedPlatform = structuredClone(fixture.sbom);
    omittedPlatform.source.metadata.architecture = "";
    omittedPlatform.source.metadata.os = "";
    expect(
      validateSyftSbom(omittedPlatform, fixture.ociReport)
        .sourcePlatformMetadataPresent,
    ).toBe(false);

    const cases = [
      [
        (value) => {
          value.schema.version = "16.1.9";
        },
        /schema identity/i,
      ],
      [
        (value) => {
          value.descriptor.version = "1.48.0";
        },
        /generator identity/i,
      ],
      [
        (value) => {
          value.source.name = "other-runtime";
        },
        /source name.*bound|source name, version, or type/i,
      ],
      [
        (value) => {
          value.source.metadata.userInput = "docker:mutable-tag";
        },
        /fixed OCI archive boundary/i,
      ],
      [
        (value) => {
          value.source.metadata.manifestDigest =
            digest("different-manifest");
        },
        /manifest digest.*OCI report/i,
      ],
      [
        (value) => {
          value.source.metadata.architecture = "arm64";
        },
        /platform drifted/i,
      ],
      [
        (value) => {
          value.source.metadata.repoDigests = [
            "registry.invalid/runtime@sha256:" + "1".repeat(64),
          ];
        },
        /must not claim registry/i,
      ],
    ];
    for (const [mutate, pattern] of cases) {
      const drifted = structuredClone(fixture.sbom);
      mutate(drifted);
      expect(() =>
        validateSyftSbom(drifted, fixture.ociReport),
      ).toThrow(pattern);
    }
  });

  test("rejects raw manifest, config, layer, and package inventory drift", () => {
    const fixture = buildFixture();
    const cases = [
      [
        (value) => {
          value.source.metadata.manifest =
            Buffer.from("{}").toString("base64");
        },
        /raw manifest digest/i,
      ],
      [
        (value) => {
          value.source.metadata.config =
            Buffer.from("{}").toString("base64");
        },
        /raw config digest/i,
      ],
      [
        (value) => {
          value.source.metadata.layers[0].digest =
            digest("different-layer");
        },
        /layer 0.*not bound/i,
      ],
      [
        (value) => {
          value.artifacts = [];
        },
        /nonempty package inventory/i,
      ],
      [
        (value) => {
          value.artifacts[1].id = value.artifacts[0].id;
        },
        /package IDs must be unique/i,
      ],
    ];
    for (const [mutate, pattern] of cases) {
      const drifted = structuredClone(fixture.sbom);
      mutate(drifted);
      expect(() =>
        validateSyftSbom(drifted, fixture.ociReport),
      ).toThrow(pattern);
    }
  });
});

function buildFixture() {
  const layerBytes = [
    Buffer.from("compressed-layer-a"),
    Buffer.from("compressed-layer-b"),
  ];
  const layerDigests = layerBytes.map((bytes) => `sha256:${sha256Hex(bytes)}`);
  const diffIds = [
    digest("uncompressed-layer-a"),
    digest("uncompressed-layer-b"),
  ];
  const rawConfig = Buffer.from(
    JSON.stringify({
      architecture: "amd64",
      os: "linux",
      rootfs: {
        type: "layers",
        diff_ids: diffIds,
      },
    }),
  );
  const configDigest = `sha256:${sha256Hex(rawConfig)}`;
  const rawManifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: OCI_MANIFEST_MEDIA_TYPE,
      config: {
        mediaType: OCI_CONFIG_MEDIA_TYPE,
        digest: configDigest,
        size: rawConfig.length,
      },
      layers: layerBytes.map((bytes, index) => ({
        mediaType: OCI_LAYER_MEDIA_TYPE,
        digest: layerDigests[index],
        size: bytes.length,
      })),
    }),
  );
  const manifestDigest = `sha256:${sha256Hex(rawManifest)}`;
  const ociReport = {
    contractVersion: 1,
    status: "passed",
    ociIndexDigest: digest("index"),
    ociManifestDigest: manifestDigest,
    ociConfigDigest: configDigest,
    compressedLayerDigests: layerDigests,
    uncompressedLayerDiffIds: diffIds,
    runtimeBinarySha256: sha256Hex("runtime-binary"),
    reproducibility: {
      archiveSha256: sha256Hex("archive"),
      exactArchiveMatch: true,
      exactIndexMatch: true,
      exactManifestMatch: true,
      exactConfigMatch: true,
      exactCompressedLayerMatch: true,
      exactDiffIdMatch: true,
      exactRuntimeBinaryMatch: true,
    },
  };
  const sbom = {
    artifacts: [
      {
        id: sha256Hex("package-a"),
        name: "base-files",
        version: "1",
        type: "deb",
        foundBy: "dpkg-db-cataloger",
        locations: [
          {
            path: "/var/lib/dpkg/status",
            layerID: layerDigests[0],
            accessPath: "/var/lib/dpkg/status",
          },
        ],
        licenses: [],
        language: "",
        cpes: [],
        purl: "pkg:deb/debian/base-files@1",
      },
      {
        id: sha256Hex("package-b"),
        name: "ca-certificates",
        version: "2",
        type: "deb",
        foundBy: "dpkg-db-cataloger",
        locations: [
          {
            path: "/var/lib/dpkg/status",
            layerID: layerDigests[1],
            accessPath: "/var/lib/dpkg/status",
          },
        ],
        licenses: [],
        language: "",
        cpes: [],
        purl: "pkg:deb/debian/ca-certificates@2",
      },
    ],
    artifactRelationships: [
      {
        parent: sha256Hex("package-a"),
        child: sha256Hex("package-b"),
        type: "contains",
      },
    ],
    source: {
      id: sha256Hex("source"),
      name: SBOM_SOURCE_NAME,
      version: manifestDigest,
      type: "image",
      metadata: {
        userInput: SBOM_SOURCE_REFERENCE,
        imageID: configDigest,
        manifestDigest,
        mediaType: OCI_MANIFEST_MEDIA_TYPE,
        tags: [],
        imageSize: 4096,
        layers: layerBytes.map((bytes, index) => ({
          mediaType: OCI_LAYER_MEDIA_TYPE,
          digest: diffIds[index],
          size: 0,
        })),
        manifest: rawManifest.toString("base64"),
        config: rawConfig.toString("base64"),
        repoDigests: [],
        architecture: "amd64",
        os: "linux",
      },
    },
    distro: {},
    descriptor: {
      name: "syft",
      version: SYFT_VERSION,
      configuration: {
        search: {
          scope: "squashed",
        },
      },
    },
    schema: {
      version: SYFT_SCHEMA_VERSION,
      url: `https://raw.githubusercontent.com/anchore/syft/main/schema/json/schema-${SYFT_SCHEMA_VERSION}.json`,
    },
  };
  return { ociReport, sbom };
}

async function writeGateFixture(fixture) {
  const directory = await mkdtemp(join(tmpdir(), "cinatoken-sbom-test-"));
  temporaryDirectories.add(directory);
  const sbomA = join(directory, "sbom-a.json");
  const sbomB = join(directory, "sbom-b.json");
  const ociReport = join(directory, "oci-report.json");
  const sbomBytes = Buffer.from(`${JSON.stringify(fixture.sbom)}\n`);
  await Promise.all([
    writeFile(sbomA, sbomBytes),
    writeFile(sbomB, sbomBytes),
    writeFile(ociReport, `${JSON.stringify(fixture.ociReport)}\n`),
  ]);
  expect(await readFile(sbomA)).toEqual(await readFile(sbomB));
  return { directory, sbomA, sbomB, ociReport, sbomBytes };
}

function digest(value) {
  return `sha256:${sha256Hex(value)}`;
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertNoFormalP5Fields(value) {
  const forbidden = new Set([
    "containerImageDigest",
    "containerImageProvenanceSha256",
    "containerSbomSha256",
    "containerSignatureVerified",
    "runtimeImageProvenanceVerified",
    "candidateDigestSha256",
    "sources",
  ]);
  const visit = (node) => {
    if (node === null || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      expect(forbidden.has(key)).toBe(false);
      visit(child);
    }
  };
  visit(value);
}
