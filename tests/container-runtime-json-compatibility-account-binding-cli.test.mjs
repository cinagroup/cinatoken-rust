import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalJson,
} from "../tools/container_runtime_json_compatibility_campaign.mjs";
import {
  JsonCompatibilityAccountBindingCliError,
  createJsonCompatibilityAccountBindingRawPageSink,
  parseAccountBindingCollectorArgs,
  runAccountBindingCollectorCli,
} from "../tools/collect_container_runtime_json_compatibility_account_bindings.mjs";
import {
  buildJsonCompatibilityAccountBindingPageReceipt,
} from "../tools/container_runtime_json_compatibility_account_binding_evidence.mjs";
import {
  createSourceAuthenticationFixture,
} from "./fixtures/container-runtime-json-compatibility-source-authentication.mjs";

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
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("raw capture binds identity, verifies bytes, and creates each page once", async () => {
    const parent = await mkdtemp(join(tmpdir(), "cinatoken-raw-capture-"));
    const directory = join(parent, "capture");
    const body = new TextEncoder().encode('{"result":[]}');
    const receipt = buildJsonCompatibilityAccountBindingPageReceipt({
      sequence: 1,
      resourceFamily: "workers-scripts",
      resourceIdentitySha256: "1".repeat(64),
      requestPathSha256: "2".repeat(64),
      responseBodySha256: sha256Bytes(body),
      responseByteLength: body.byteLength,
      resultCount: 0,
      pageNumber: null,
      totalPages: null,
      requestIdSha256: "3".repeat(64),
      predecessorSha256: null,
      observedAt: 1,
    });
    const identity = {
      mode: "collection",
      accountIdSha256: "4".repeat(64),
      collectionProfileSha256: "5".repeat(64),
      collectorIdentitySha256: "6".repeat(64),
    };
    try {
      const sink = await createJsonCompatibilityAccountBindingRawPageSink(
        directory,
        identity,
      );
      await sink({
        sequence: 1,
        resourceFamily: "workers-scripts",
        requestPathSha256: receipt.requestPathSha256,
        responseBodySha256: receipt.responseBodySha256,
        body,
        receipt,
      });
      const files = (await readdir(directory)).sort();
      expect(files).toHaveLength(3);
      expect(files).toContain("capture-manifest.json");
      const bodyPath = join(directory, files.find((name) =>
        name.endsWith(".body.json")));
      expect(new Uint8Array(await readFile(bodyPath))).toEqual(body);
      await expect(sink({
        sequence: 1,
        resourceFamily: "workers-scripts",
        body: new TextEncoder().encode('{"result":[1]}'),
        receipt,
      })).rejects.toThrow(/raw_page_receipt_body_mismatch/);
      await expect(createJsonCompatibilityAccountBindingRawPageSink(
        directory,
        identity,
      )).rejects.toThrow(/raw_page_directory_exists/);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}
