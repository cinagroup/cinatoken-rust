import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalJson,
  sha256Canonical,
} from "../tools/container_runtime_json_compatibility_campaign.mjs";
import {
  JSON_COMPATIBILITY_ACCOUNT_BINDING_RAW_CAPTURE_TERMINAL_CONTRACT as COLLECTOR_RAW_CAPTURE_TERMINAL_CONTRACT,
  JsonCompatibilityAccountBindingCliError,
  createJsonCompatibilityAccountBindingRawPageSink,
  parseAccountBindingCollectorArgs,
  runAccountBindingCollectorCli,
  validateJsonCompatibilityAccountBindingRawCaptureTerminal as validateRawCaptureTerminalFromCollector,
} from "../tools/collect_container_runtime_json_compatibility_account_bindings.mjs";
import {
  JSON_COMPATIBILITY_ACCOUNT_BINDING_RAW_CAPTURE_TERMINAL_CONTRACT,
  validateJsonCompatibilityAccountBindingRawCaptureTerminal,
} from "../tools/container_runtime_json_compatibility_account_binding_raw_capture.mjs";
import {
  buildJsonCompatibilityAccountBindingCollectionProfile,
  buildJsonCompatibilityAccountBindingPageReceipt,
} from "../tools/container_runtime_json_compatibility_account_binding_evidence.mjs";
import {
  collectJsonCompatibilityAccountBindingArtifact,
} from "../tools/lib/container_runtime_json_compatibility_account_binding_collector.mjs";
import {
  createAccountBindingCredentialProvenanceFixture,
  createSourceAuthenticationFixture,
} from "./fixtures/container-runtime-json-compatibility-source-authentication.mjs";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const COLLECTION_TOKEN = "collection-read-token-fixture-0001";
const COLLECTION_TOKEN_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const READBACK_TOKEN_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ZONE_ID = "cccccccccccccccccccccccccccccccc";

describe("JSON compatibility account binding collector CLI", () => {
  test("dry-run does not read credentials, access the network, or write files", async () => {
    const output = [];
    const forbiddenEnvironment = new Proxy({}, {
      get() {
        throw new Error("dry-run read the environment");
      },
      getOwnPropertyDescriptor() {
        throw new Error("dry-run inspected the environment");
      },
      has() {
        throw new Error("dry-run inspected the environment");
      },
      ownKeys() {
        throw new Error("dry-run enumerated the environment");
      },
    });
    const result = await runAccountBindingCollectorCli({
      argv: ["--mode", "collection", "--dry-run"],
      environment: forbiddenEnvironment,
      fetchImpl: () => {
        throw new Error("dry-run accessed the network");
      },
      stdout: { write: (value) => output.push(value) },
    });

    expect(result.mode).toBe("collection");
    expect(result.networkRequests).toBe(0);
    expect(result.fileWrites).toBe(0);
    expect(result.forbiddenCredentialEnvironment).toContain("CF_API_KEY");
    expect(output).toHaveLength(1);
  });

  test("self-test remains credential-free and side-effect-free", async () => {
    const output = [];
    const result = await runAccountBindingCollectorCli({
      argv: ["--self-test"],
      environment: new Proxy({}, {
        get() {
          throw new Error("self-test read the environment");
        },
      }),
      fetchImpl: () => {
        throw new Error("self-test accessed the network");
      },
      stdout: { write: (value) => output.push(value) },
    });

    expect(result).toMatchObject({
      mode: "self-test",
      passed: true,
      credentialAccess: "none",
      networkRequests: 0,
      fileWrites: 0,
    });
    expect(output).toHaveLength(1);
  });

  test("rejects token arguments and mode option smuggling", () => {
    expect(() => parseAccountBindingCollectorArgs([
      "--mode",
      "collection",
      "--api-token",
      "must-not-be-accepted",
    ])).toThrow(JsonCompatibilityAccountBindingCliError);
    expect(() => parseAccountBindingCollectorArgs([
      "--mode",
      "finalize",
      "--dry-run",
      "--output",
      "artifact.json",
    ])).toThrow(/dry_run_accepts_only_mode/);
  });

  test("requires physical credential separation before reading input files", async () => {
    await expect(runAccountBindingCollectorCli({
      argv: [
        "--mode", "collection",
        "--campaign-plan", "missing-campaign.json",
        "--state-plan", "missing-state.json",
        "--collection-profile", "missing-profile.json",
        "--collector-identity", "missing-collector.json",
        "--account-id", "0123456789abcdef0123456789abcdef",
        "--credential-trust-policy-sha256", "a".repeat(64),
        "--credential-revocation-state-sha256", "b".repeat(64),
        "--minimum-revocation-sequence", "1",
        "--raw-page-dir", "must-not-be-created",
        "--output", "must-not-be-created.json",
      ],
      environment: {
        CLOUDFLARE_ACCOUNT_BINDING_COLLECTION_TOKEN:
          "collection-token-that-is-long-enough",
        CLOUDFLARE_ACCOUNT_BINDING_READBACK_TOKEN:
          "readback-token-that-is-long-enough",
      },
      stdout: { write() {} },
    })).rejects.toThrow(/forbidden_credential_environment_present/);
  });

  test("raw capture terminal validator has a pure import boundary", async () => {
    expect(validateRawCaptureTerminalFromCollector)
      .toBe(validateJsonCompatibilityAccountBindingRawCaptureTerminal);
    expect(COLLECTOR_RAW_CAPTURE_TERMINAL_CONTRACT)
      .toBe(JSON_COMPATIBILITY_ACCOUNT_BINDING_RAW_CAPTURE_TERMINAL_CONTRACT);
    const source = await readFile(new URL(
      "../tools/container_runtime_json_compatibility_account_binding_raw_capture.mjs",
      import.meta.url,
    ), "utf8");
    expect([...source.matchAll(/^import .* from "([^"]+)";$/gm)]
      .map((match) => match[1])).toEqual(["node:crypto"]);
    expect(source).not.toMatch(
      /node:(?:fs|path)|\bfetch\s*\(|process\.(?:env|argv)|CLOUDFLARE_/,
    );
  });

  test("finalize creates one canonical artifact and refuses overwrite", async () => {
    const fixture = await createSourceAuthenticationFixture();
    const evidence = fixture.bundle.accountBindingEvidence;
    const directory = await mkdtemp(join(tmpdir(), "cinatoken-account-binding-"));
    const paths = Object.fromEntries([
      ["campaign", fixture.campaignPlan],
      ["state", fixture.statePlan],
      ["profile", evidence.collectionProfile],
      ["collection", evidence.collection],
      ["readback", evidence.independentReadback],
    ].map(([name, value]) => [name, {
      path: join(directory, `${name}.json`),
      value,
    }]));
    const outputPath = join(directory, "finalized.json");
    const argv = [
      "--mode", "finalize",
      "--campaign-plan", paths.campaign.path,
      "--state-plan", paths.state.path,
      "--collection-profile", paths.profile.path,
      "--collection-artifact", paths.collection.path,
      "--readback-artifact", paths.readback.path,
      "--output", outputPath,
    ];
    try {
      await Promise.all(Object.values(paths).map(({ path, value }) =>
        writeFile(path, `${canonicalJson(value)}\n`, { flag: "wx" })));
      const result = await runAccountBindingCollectorCli({
        argv,
        environment: {},
        fetchImpl: () => {
          throw new Error("finalize accessed the network");
        },
        stdout: { write() {} },
      });
      const finalized = JSON.parse(await readFile(outputPath, "utf8"));
      expect(result.finalizationSha256).toBe(finalized.finalizationSha256);
      expect(finalized.evidence.accountBindingEvidenceSha256)
        .toBe(evidence.accountBindingEvidenceSha256);
      expect(await readFile(outputPath, "utf8"))
        .toBe(`${canonicalJson(finalized)}\n`);
      await expect(runAccountBindingCollectorCli({
        argv,
        environment: {},
        stdout: { write() {} },
      })).rejects.toThrow(/create_once_output_exists/);

      const campaignBytes = new TextEncoder().encode(
        `${canonicalJson(paths.campaign.value)}\n`,
      );
      const bomCampaignBytes = new Uint8Array(campaignBytes.byteLength + 3);
      bomCampaignBytes.set([0xef, 0xbb, 0xbf]);
      bomCampaignBytes.set(campaignBytes, 3);
      await writeFile(paths.campaign.path, bomCampaignBytes, { flag: "w" });
      const bomOutputPath = join(directory, "must-not-exist.json");
      await expect(runAccountBindingCollectorCli({
        argv: [...argv.slice(0, -1), bomOutputPath],
        environment: {},
        stdout: { write() {} },
      })).rejects.toThrow(/campaign_plan_utf8_invalid/);
      expect(await readdir(directory)).not.toContain("must-not-exist.json");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("raw capture closes a complete canonical object set exactly once", async () => {
    const { artifact, fixture, pages } = await collectedRawFixture();
    const parent = await mkdtemp(join(tmpdir(), "cinatoken-raw-capture-"));
    const directory = join(parent, "capture");
    const identity = captureIdentity(artifact);
    try {
      const sink = await createJsonCompatibilityAccountBindingRawPageSink(
        directory,
        identity,
        captureValidationContext(fixture),
      );
      await sink(pages[0]);
      await expect(sink(pages[0])).rejects.toThrow(/raw_page_sequence_invalid/);
      for (const page of pages.slice(1)) await sink(page);

      const terminal = await sink.finalize(artifact);
      const files = (await readdir(directory)).sort();
      expect(files).toHaveLength((pages.length * 2) + 2);
      expect(files).toContain("capture-manifest.json");
      expect(files).toContain("capture-terminal.json");
      const bodyPath = join(directory, files.find((name) =>
        name.endsWith(".body.json")));
      expect(new Uint8Array(await readFile(bodyPath))).toEqual(pages[0].body);

      const manifestSubject = {
        schemaVersion: 1,
        contract:
          "cinatoken-container-runtime-json-compatibility-account-binding-raw-capture-v1",
        environment: "staging",
        ...identity,
      };
      const manifest = JSON.parse(await readFile(
        join(directory, "capture-manifest.json"),
        "utf8",
      ));
      expect(manifest).toEqual({
        ...manifestSubject,
        captureManifestSha256: sha256Canonical(manifestSubject),
      });

      const terminalText = await readFile(
        join(directory, "capture-terminal.json"),
        "utf8",
      );
      expect(terminalText).toBe(`${canonicalJson(terminal)}\n`);
      expect(terminal).toMatchObject({
        collectionArtifactSha256: artifact.collectionArtifactSha256,
        pageCount: pages.length,
        pageChainHeadSha256: artifact.snapshot.pageChainHeadSha256,
        rawObjectCount: pages.length * 2,
        captureManifestSha256: manifest.captureManifestSha256,
      });
      expect(terminal.rawObjectTotalBytes).toBe(pages.reduce(
        (total, page) => total + page.body.byteLength
          + canonicalByteLength(page.receipt),
        0,
      ));
      expect(terminal.rawObjectSetSha256)
        .toBe(sha256Canonical(terminal.rawObjects));
      expect(terminal.collectionArtifactFileSha256)
        .toBe(sha256Bytes(new TextEncoder().encode(
          `${canonicalJson(artifact)}\n`,
        )));
      expect(new Set(terminal.rawObjects.map((value) => value.fileName)).size)
        .toBe(terminal.rawObjectCount);
      expect(terminal.rawObjects[0]).toMatchObject({
        sequence: 1,
        resourceFamily: pages[0].resourceFamily,
        objectKind: "body",
        byteLength: pages[0].body.byteLength,
        contentSha256: pages[0].responseBodySha256,
        pageReceiptSha256: pages[0].receipt.pageReceiptSha256,
      });
      const validatedTerminal =
        validateJsonCompatibilityAccountBindingRawCaptureTerminal(terminal);
      expect(validatedTerminal).toEqual(terminal);
      expect(validatedTerminal).not.toBe(terminal);
      expect(validatedTerminal.rawObjects).not.toBe(terminal.rawObjects);
      await expect(sink.finalize(artifact))
        .rejects.toThrow(/raw_capture_terminal_already_attempted/);
      await expect(sink(pages.at(-1)))
        .rejects.toThrow(/raw_capture_directory_consumed/);
      await expect(createJsonCompatibilityAccountBindingRawPageSink(
        directory,
        identity,
        captureValidationContext(fixture),
      )).rejects.toThrow(/raw_page_directory_exists/);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("raw capture terminal validator rejects structural and digest drift", async () => {
    const terminal = await rawCaptureTerminalFixture();
    const stableIdentity = {
      mode: terminal.mode,
      accountIdSha256: terminal.accountIdSha256,
      collectionProfileSha256: terminal.collectionProfileSha256,
      collectorIdentitySha256: terminal.collectorIdentitySha256,
      captureManifestSha256: terminal.captureManifestSha256,
    };

    const changedBodyDigest = cloneTerminal(terminal);
    changedBodyDigest.rawObjects[0].contentSha256 = alternateSha256(
      changedBodyDigest.rawObjects[0].contentSha256,
    );
    resealTerminal(changedBodyDigest, { rawObjects: true });

    const changedRawSetDigest = cloneTerminal(terminal);
    changedRawSetDigest.rawObjectSetSha256 = alternateSha256(
      changedRawSetDigest.rawObjectSetSha256,
    );
    resealTerminal(changedRawSetDigest);

    const changedFileDigest = cloneTerminal(terminal);
    changedFileDigest.collectionArtifactFileSha256 = alternateSha256(
      changedFileDigest.collectionArtifactFileSha256,
    );

    const changedArtifactDigest = cloneTerminal(terminal);
    changedArtifactDigest.collectionArtifactSha256 = alternateSha256(
      changedArtifactDigest.collectionArtifactSha256,
    );

    for (const changed of [
      changedBodyDigest,
      changedRawSetDigest,
      changedFileDigest,
      changedArtifactDigest,
    ]) {
      expect(changed).toMatchObject(stableIdentity);
      expect(() =>
        validateJsonCompatibilityAccountBindingRawCaptureTerminal(changed))
        .toThrow();
    }

    const duplicate = cloneTerminal(terminal);
    for (const rawObject of duplicate.rawObjects.slice(2, 4)) {
      rawObject.pageReceiptSha256 =
        duplicate.rawObjects[0].pageReceiptSha256;
      rawObject.fileName = rawCaptureFileName(rawObject);
    }
    resealTerminal(duplicate, { rawObjects: true });

    const missing = cloneTerminal(terminal);
    missing.rawObjects.pop();
    resealTerminal(missing, { rawObjects: true, aggregates: true });

    const reordered = cloneTerminal(terminal);
    [reordered.rawObjects[0], reordered.rawObjects[1]] =
      [reordered.rawObjects[1], reordered.rawObjects[0]];
    resealTerminal(reordered, { rawObjects: true });

    const wrongFileName = cloneTerminal(terminal);
    wrongFileName.rawObjects[0].fileName = "safe-but-not-canonical.body.json";
    resealTerminal(wrongFileName, { rawObjects: true });

    const extraTerminalField = cloneTerminal(terminal);
    extraTerminalField.unexpected = true;
    resealTerminal(extraTerminalField);

    const extraDescriptorField = cloneTerminal(terminal);
    extraDescriptorField.rawObjects[0].unexpected = true;
    resealTerminal(extraDescriptorField, { rawObjects: true });

    for (const changed of [
      duplicate,
      missing,
      reordered,
      wrongFileName,
      extraTerminalField,
      extraDescriptorField,
    ]) {
      expect(() =>
        validateJsonCompatibilityAccountBindingRawCaptureTerminal(changed))
        .toThrow();
    }

    for (const field of [
      "accountIdSha256",
      "collectionProfileSha256",
      "collectorIdentitySha256",
      "collectionArtifactSha256",
      "collectionArtifactFileSha256",
    ]) {
      const malformed = cloneTerminal(terminal);
      malformed[field] = "not-a-sha256";
      resealTerminal(malformed);
      expect(() =>
        validateJsonCompatibilityAccountBindingRawCaptureTerminal(malformed))
        .toThrow();
    }

    const nonPlain = Object.assign(Object.create(null), terminal);
    expect(() =>
      validateJsonCompatibilityAccountBindingRawCaptureTerminal(nonPlain))
      .toThrow();
  });

  test("terminal closure rejects missing and extra page receipts", async () => {
    const { artifact, fixture, pages } = await collectedRawFixture();
    const parent = await mkdtemp(join(tmpdir(), "cinatoken-raw-cardinality-"));
    const missingDirectory = join(parent, "missing");
    const extraDirectory = join(parent, "extra");
    const identity = captureIdentity(artifact);
    try {
      const missingSink = await createJsonCompatibilityAccountBindingRawPageSink(
        missingDirectory,
        identity,
        captureValidationContext(fixture),
      );
      for (const page of pages.slice(0, -1)) await missingSink(page);
      await expect(missingSink.finalize(artifact))
        .rejects.toThrow(/raw_capture_page_receipt_count_mismatch/);
      expect(await readdir(missingDirectory)).not.toContain(
        "capture-terminal.json",
      );
      await expect(missingSink.finalize(artifact))
        .rejects.toThrow(/raw_capture_terminal_already_attempted/);
      await expect(missingSink(pages.at(-1)))
        .rejects.toThrow(/raw_capture_directory_consumed/);

      const extraSink = await createJsonCompatibilityAccountBindingRawPageSink(
        extraDirectory,
        identity,
        captureValidationContext(fixture),
      );
      for (const page of pages) await extraSink(page);
      const body = new TextEncoder().encode('{"result":[]}');
      const lastReceipt = pages.at(-1).receipt;
      const receipt = buildJsonCompatibilityAccountBindingPageReceipt({
        ...lastReceipt,
        sequence: pages.length + 1,
        responseBodySha256: sha256Bytes(body),
        responseByteLength: body.byteLength,
        predecessorSha256: lastReceipt.pageReceiptSha256,
      });
      await extraSink({
        sequence: receipt.sequence,
        resourceFamily: receipt.resourceFamily,
        requestPathSha256: receipt.requestPathSha256,
        responseBodySha256: receipt.responseBodySha256,
        body,
        receipt,
      });
      await expect(extraSink.finalize(artifact))
        .rejects.toThrow(/raw_capture_page_receipt_count_mismatch/);
      expect(await readdir(extraDirectory)).not.toContain(
        "capture-terminal.json",
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("terminal closure consumes a capture whose raw readback was changed", async () => {
    const { artifact, fixture, pages } = await collectedRawFixture();
    const parent = await mkdtemp(join(tmpdir(), "cinatoken-raw-readback-"));
    const directory = join(parent, "capture");
    try {
      const sink = await createJsonCompatibilityAccountBindingRawPageSink(
        directory,
        captureIdentity(artifact),
        captureValidationContext(fixture),
      );
      for (const page of pages) await sink(page);
      const bodyFile = (await readdir(directory)).find((name) =>
        name.endsWith(".body.json"));
      await writeFile(join(directory, bodyFile), "{}", { flag: "w" });
      await expect(sink.finalize(artifact))
        .rejects.toThrow(/raw_capture_object_readback_mismatch/);
      expect(await readdir(directory)).not.toContain("capture-terminal.json");
      await expect(sink.finalize(artifact))
        .rejects.toThrow(/raw_capture_terminal_already_attempted/);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("CLI reports success only after artifact output and closure succeed", async () => {
    const { fixture } = await collectedRawFixture();
    const parent = await mkdtemp(join(tmpdir(), "cinatoken-cli-closure-"));
    const rawDirectory = join(parent, "capture");
    const failedRawDirectory = join(parent, "failed-capture");
    const pollutedRawDirectory = join(parent, "polluted-capture");
    const outputPath = join(parent, "collection-artifact.json");
    const occupiedOutputPath = join(parent, "occupied-output.json");
    const paths = {
      campaign: join(parent, "campaign.json"),
      state: join(parent, "state.json"),
      profile: join(parent, "profile.json"),
      collector: join(parent, "collector.json"),
    };
    const successOutput = [];
    const successTransport = fakeCloudflareTransport(fixture, {
      token: COLLECTION_TOKEN,
      tokenId: COLLECTION_TOKEN_ID,
    });
    try {
      await Promise.all([
        writeCanonical(paths.campaign, fixture.inputs.campaignPlan),
        writeCanonical(paths.state, fixture.inputs.statePlan),
        writeCanonical(paths.profile, fixture.inputs.collectionProfile),
        writeCanonical(paths.collector, fixture.inputs.collectorIdentity),
        writeFile(occupiedOutputPath, "occupied\n", { flag: "wx" }),
      ]);
      const success = await runAccountBindingCollectorCli({
        argv: collectionCliArgv(
          fixture,
          paths,
          rawDirectory,
          outputPath,
        ),
        environment: {
          CLOUDFLARE_ACCOUNT_BINDING_COLLECTION_TOKEN: COLLECTION_TOKEN,
        },
        stdout: { write: (value) => successOutput.push(value) },
        fetchImpl: successTransport.fetch,
        clock: () => fixture.now,
        monotonicClock: () => 0,
      });
      expect(successOutput).toEqual([`${canonicalJson(success)}\n`]);
      const artifactText = await readFile(outputPath, "utf8");
      const artifact = JSON.parse(artifactText);
      expect(artifactText).toBe(`${canonicalJson(artifact)}\n`);
      const terminalText = await readFile(
        join(rawDirectory, "capture-terminal.json"),
        "utf8",
      );
      const terminal = JSON.parse(terminalText);
      expect(terminalText).toBe(`${canonicalJson(terminal)}\n`);
      expect(terminal.pageCount).toBe(35);
      expect(terminal.rawObjectCount).toBe(70);
      expect(success.collectionArtifactSha256)
        .toBe(artifact.collectionArtifactSha256);
      expect(success.captureTerminalSha256)
        .toBe(terminal.captureTerminalSha256);

      const failedOutput = [];
      const failedTransport = fakeCloudflareTransport(fixture, {
        token: COLLECTION_TOKEN,
        tokenId: COLLECTION_TOKEN_ID,
      });
      await expect(runAccountBindingCollectorCli({
        argv: collectionCliArgv(
          fixture,
          paths,
          failedRawDirectory,
          occupiedOutputPath,
        ),
        environment: {
          CLOUDFLARE_ACCOUNT_BINDING_COLLECTION_TOKEN: COLLECTION_TOKEN,
        },
        stdout: { write: (value) => failedOutput.push(value) },
        fetchImpl: failedTransport.fetch,
        clock: () => fixture.now,
        monotonicClock: () => 0,
      })).rejects.toThrow(/create_once_output_exists/);
      expect(failedOutput).toEqual([]);
      expect(await readFile(occupiedOutputPath, "utf8")).toBe("occupied\n");
      expect(await readdir(failedRawDirectory)).not.toContain(
        "capture-terminal.json",
      );

      const pollutedOutput = [];
      const pollutedTransport = fakeCloudflareTransport(fixture, {
        token: COLLECTION_TOKEN,
        tokenId: COLLECTION_TOKEN_ID,
      });
      const nestedOutputPath = join(
        pollutedRawDirectory,
        "collection-artifact.json",
      );
      await expect(runAccountBindingCollectorCli({
        argv: collectionCliArgv(
          fixture,
          paths,
          pollutedRawDirectory,
          nestedOutputPath,
        ),
        environment: {
          CLOUDFLARE_ACCOUNT_BINDING_COLLECTION_TOKEN: COLLECTION_TOKEN,
        },
        stdout: { write: (value) => pollutedOutput.push(value) },
        fetchImpl: pollutedTransport.fetch,
        clock: () => fixture.now,
        monotonicClock: () => 0,
      })).rejects.toThrow(/raw_capture_directory_contents_mismatch/);
      expect(pollutedOutput).toEqual([]);
      expect(JSON.parse(await readFile(nestedOutputPath, "utf8")))
        .toHaveProperty("collectionArtifactSha256");
      expect(await readdir(pollutedRawDirectory)).not.toContain(
        "capture-terminal.json",
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalByteLength(value) {
  return new TextEncoder().encode(`${canonicalJson(value)}\n`).byteLength;
}

function writeCanonical(path, value) {
  return writeFile(path, `${canonicalJson(value)}\n`, { flag: "wx" });
}

function collectionCliArgv(fixture, paths, rawDirectory, outputPath) {
  return [
    "--mode", "collection",
    "--campaign-plan", paths.campaign,
    "--state-plan", paths.state,
    "--collection-profile", paths.profile,
    "--collector-identity", paths.collector,
    "--account-id", ACCOUNT_ID,
    "--credential-trust-policy-sha256",
    fixture.inputs.expectedTrustPolicySha256,
    "--credential-revocation-state-sha256",
    fixture.inputs.expectedRevocationStateSha256,
    "--minimum-revocation-sequence",
    String(fixture.inputs.minimumRevocationSequence),
    "--raw-page-dir", rawDirectory,
    "--output", outputPath,
  ];
}

function captureIdentity(artifact) {
  return {
    mode: artifact.mode,
    accountIdSha256: artifact.accountIdSha256,
    collectionProfileSha256: artifact.collectionProfileSha256,
    collectorIdentitySha256:
      artifact.collectorIdentity.collectorIdentitySha256,
  };
}

function captureValidationContext(fixture) {
  return {
    campaignPlan: fixture.inputs.campaignPlan,
    statePlan: fixture.inputs.statePlan,
    collectionProfile: fixture.inputs.collectionProfile,
  };
}

function cloneTerminal(value) {
  return JSON.parse(canonicalJson(value));
}

function alternateSha256(value) {
  return value === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64);
}

function rawCaptureFileName(rawObject) {
  return [
    String(rawObject.sequence).padStart(6, "0"),
    rawObject.resourceFamily,
    `${rawObject.pageReceiptSha256}.${rawObject.objectKind}.json`,
  ].join("-");
}

function resealTerminal(value, {
  rawObjects = false,
  aggregates = false,
} = {}) {
  if (aggregates) {
    value.rawObjectCount = value.rawObjects.length;
    value.rawObjectTotalBytes = value.rawObjects.reduce(
      (total, rawObject) => total + rawObject.byteLength,
      0,
    );
  }
  if (rawObjects) {
    value.rawObjectSetSha256 = sha256Canonical(value.rawObjects);
  }
  const { captureTerminalSha256: _digest, ...subject } = value;
  value.captureTerminalSha256 = sha256Canonical(subject);
  return value;
}

function rawCaptureTerminalFixture() {
  const identity = {
    mode: "collection",
    accountIdSha256: "1".repeat(64),
    collectionProfileSha256: "2".repeat(64),
    collectorIdentitySha256: "3".repeat(64),
  };
  const pageReceiptSha256 = "4".repeat(64);
  const responseBodySha256 = "5".repeat(64);
  const requestPathSha256 = "6".repeat(64);
  const secondPageReceiptSha256 = "a".repeat(64);
  const secondResponseBodySha256 = "b".repeat(64);
  const secondRequestPathSha256 = "c".repeat(64);
  const rawObjects = [
    {
      sequence: 1,
      resourceFamily: "workers-scripts",
      objectKind: "body",
      fileName:
        `000001-workers-scripts-${pageReceiptSha256}.body.json`,
      byteLength: 13,
      contentSha256: responseBodySha256,
      pageReceiptSha256,
      requestPathSha256,
      responseBodySha256,
    },
    {
      sequence: 1,
      resourceFamily: "workers-scripts",
      objectKind: "receipt",
      fileName:
        `000001-workers-scripts-${pageReceiptSha256}.receipt.json`,
      byteLength: 257,
      contentSha256: "7".repeat(64),
      pageReceiptSha256,
      requestPathSha256,
      responseBodySha256,
    },
    {
      sequence: 2,
      resourceFamily: "account-zones",
      objectKind: "body",
      fileName:
        `000002-account-zones-${secondPageReceiptSha256}.body.json`,
      byteLength: 17,
      contentSha256: secondResponseBodySha256,
      pageReceiptSha256: secondPageReceiptSha256,
      requestPathSha256: secondRequestPathSha256,
      responseBodySha256: secondResponseBodySha256,
    },
    {
      sequence: 2,
      resourceFamily: "account-zones",
      objectKind: "receipt",
      fileName:
        `000002-account-zones-${secondPageReceiptSha256}.receipt.json`,
      byteLength: 267,
      contentSha256: "d".repeat(64),
      pageReceiptSha256: secondPageReceiptSha256,
      requestPathSha256: secondRequestPathSha256,
      responseBodySha256: secondResponseBodySha256,
    },
  ];
  const captureManifestSubject = {
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-json-compatibility-account-binding-raw-capture-v1",
    environment: "staging",
    ...identity,
  };
  const terminalSubject = {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_ACCOUNT_BINDING_RAW_CAPTURE_TERMINAL_CONTRACT,
    kind:
      "container-runtime-json-compatibility-account-binding-raw-capture-terminal",
    environment: "staging",
    ...identity,
    captureManifestSha256: sha256Canonical(captureManifestSubject),
    collectionArtifactSha256: "8".repeat(64),
    collectionArtifactFileSha256: "9".repeat(64),
    pageCount: 2,
    pageChainHeadSha256: secondPageReceiptSha256,
    rawObjectCount: rawObjects.length,
    rawObjectTotalBytes: rawObjects.reduce(
      (total, rawObject) => total + rawObject.byteLength,
      0,
    ),
    rawObjectSetSha256: sha256Canonical(rawObjects),
    rawObjects,
  };
  return {
    ...terminalSubject,
    captureTerminalSha256: sha256Canonical(terminalSubject),
  };
}

let collectedRawFixturePromise;

function collectedRawFixture() {
  collectedRawFixturePromise ??= (async () => {
    const fixture = await collectorFixture();
    const transport = fakeCloudflareTransport(fixture, {
      token: COLLECTION_TOKEN,
      tokenId: COLLECTION_TOKEN_ID,
    });
    const pages = [];
    const artifact = await collectJsonCompatibilityAccountBindingArtifact({
      ...fixture.inputs,
      mode: "collection",
      accountId: ACCOUNT_ID,
      apiToken: COLLECTION_TOKEN,
      rawPageSink: async (page) => pages.push({
        ...page,
        body: Uint8Array.from(page.body),
      }),
      fetchImpl: transport.fetch,
      clock: () => fixture.now,
      monotonicClock: () => 0,
    });
    return { artifact, fixture, pages };
  })();
  return collectedRawFixturePromise;
}

async function collectorFixture() {
  const source = await createSourceAuthenticationFixture();
  const sourceEvidence = source.bundle.accountBindingEvidence;
  const now = source.now - 120;
  const credentialProvenance =
    createAccountBindingCredentialProvenanceFixture({
      accountIdSha256: sha256Bytes(ACCOUNT_ID),
      collectionCredentialIdSha256: sha256Bytes(COLLECTION_TOKEN_ID),
      readbackCredentialIdSha256: sha256Bytes(READBACK_TOKEN_ID),
      now,
    });
  const collectionProfile =
    buildJsonCompatibilityAccountBindingCollectionProfile({
      campaignPlan: source.campaignPlan,
      statePlan: source.statePlan,
      accountIdSha256: sha256Bytes(ACCOUNT_ID),
      collectorIdentitySha256:
        sourceEvidence.collection.collectorIdentity.collectorIdentitySha256,
      credentialProvenance,
      credentialProvenanceApprovedAt: now,
      allowedCampaignBindingEdges:
        sourceEvidence.collectionProfile.allowedCampaignBindingEdges,
    });
  return {
    now,
    sourceEvidence,
    inputs: {
      campaignPlan: source.campaignPlan,
      statePlan: source.statePlan,
      collectionProfile,
      collectorIdentity: sourceEvidence.collection.collectorIdentity,
      expectedTrustPolicySha256:
        credentialProvenance.credentialTrustPolicySha256,
      expectedRevocationStateSha256:
        credentialProvenance.credentialRevocationStateSha256,
      minimumRevocationSequence:
        credentialProvenance.revocation.subject.sequence,
    },
  };
}

function fakeCloudflareTransport(fixture, { token, tokenId }) {
  let ray = 0;
  const services = fixture.sourceEvidence.collection.snapshot.services;
  const edges = fixture.sourceEvidence.collection.snapshot.serviceBindingEdges;
  const fetch = async (input, init) => {
    const url = new URL(input);
    if (init.method !== "GET" || init.redirect !== "error") {
      throw new Error("unexpected request options");
    }
    if (init.headers.Authorization !== `Bearer ${token}`) {
      throw new Error("unexpected authorization header");
    }
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    let result;
    let resultInfo;
    if (parts.at(-2) === "tokens" && parts.at(-1) === "verify") {
      result = { id: tokenId, status: "active" };
    } else if (parts.at(-2) === "workers" && parts.at(-1) === "scripts") {
      result = services.map((service) => ({ id: service.serviceName }));
    } else if (parts.at(-1) === "deployments") {
      const serviceName = parts.at(-2);
      const service = services.find((value) => value.serviceName === serviceName);
      result = {
        deployments: [{
          id: `deployment-${service.activeVersionIds[0]}`,
          strategy: "percentage",
          versions: [{
            version_id: service.activeVersionIds[0],
            percentage: 100,
          }],
        }],
      };
    } else if (parts.at(-2) === "versions") {
      const serviceName = parts.at(-3);
      const versionId = parts.at(-1);
      result = {
        id: versionId,
        resources: {
          bindings: edges
            .filter((edge) =>
              edge.callerServiceName === serviceName
              && edge.callerVersionId === versionId)
            .map(apiBindingFromEdge),
        },
      };
    } else if (parts.at(-1) === "subdomain") {
      result = { enabled: false, previews_enabled: false };
    } else if (parts.at(-2) === "workers" && parts.at(-1) === "domains") {
      result = [];
      resultInfo = {
        page: 1,
        per_page: 20,
        count: 0,
        total_count: 0,
        total_pages: 1,
      };
    } else if (parts.length === 3 && parts.at(-1) === "zones") {
      result = [{ id: ZONE_ID, account: { id: ACCOUNT_ID } }];
      resultInfo = {
        page: 1,
        per_page: 50,
        count: 1,
        total_count: 1,
        total_pages: 1,
      };
    } else if (parts.at(-2) === "workers" && parts.at(-1) === "routes") {
      result = [];
    } else {
      throw new Error(`unexpected Cloudflare request: ${url.href}`);
    }
    const body = JSON.stringify({
      success: true,
      errors: [],
      messages: [],
      result,
      ...(resultInfo === undefined ? {} : { result_info: resultInfo }),
    });
    ray += 1;
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
        "cf-ray": `fixture-ray-${ray}`,
      },
    });
  };
  return { fetch };
}

function apiBindingFromEdge(edge) {
  if (edge.bindingType !== "service") {
    throw new Error(`unsupported fixture binding type: ${edge.bindingType}`);
  }
  return {
    type: "service",
    name: edge.bindingName,
    service: edge.targetServiceName,
    ...(edge.targetEnvironment === null
      ? {}
      : { environment: edge.targetEnvironment }),
    ...(edge.targetEntrypoint === null
      ? {}
      : { entrypoint: edge.targetEntrypoint }),
  };
}
