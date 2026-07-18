import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  FOUNDATION_CAPTURE_CONTRACT,
  canonicalJson,
  p5CandidateDigestSha256,
} from "../tools/relay_container_p5_evidence_contract.mjs";
import {
  FOUNDATION_REQUEST_CONTRACT,
  FOUNDATION_SOURCES_CONTRACT,
  collectP5Foundation,
  buildFoundationDryRun,
  parseCliArgs,
  validateFoundationRequest,
  validateFoundationSources,
} from "../tools/collect_relay_container_p5_foundation.mjs";
import {
  assertReadOnlyWranglerCommand,
  buildCloudflareReadbackPlan,
  executeCloudflareReadback,
  sha256,
} from "../tools/lib/cloudflare_readback.mjs";

const replacementToken = "rotated-readback-token-value-001";
const collectorDigest = "f".repeat(64);

describe("Relay Container P5 foundation collector", () => {
  test("accepts only the strict staging request contract", () => {
    const request = requestFixture();
    expect(validateFoundationRequest(request)).toEqual(request);

    expect(() =>
      validateFoundationRequest({ ...request, environment: "production" }),
    ).toThrow(/environment mismatch/);
    expect(() =>
      validateFoundationRequest({ ...request, token: replacementToken }),
    ).toThrow(/unknown or missing fields/);
    expect(() =>
      validateFoundationRequest({
        ...request,
        configKvNamespaceId: "c".repeat(32),
      }),
    ).toThrow(/namespace digest mismatch/);
    expect(() =>
      validateFoundationRequest({ ...request, observationSeconds: 299 }),
    ).toThrow(/observationSeconds is out of range/);
  });

  test("builds a credential-free, staging-only dry-run plan", async () => {
    const request = requestFixture();
    const report = await buildFoundationDryRun({
      request,
      dependencies: { collectorArtifactDigest: collectorDigest },
    });

    expect(report.ok).toBe(true);
    expect(report.decision).toBe("not-proven");
    expect(report.p5Eligible).toBe(false);
    expect(report.commandKeys).toHaveLength(13);
    expect(report.safetyBoundary.credentialsRead).toBe(false);
    expect(report.safetyBoundary.networkReadbackPerformed).toBe(false);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(request.accountId);
    expect(serialized).not.toContain(request.configKvNamespaceId);
    expect(serialized).not.toContain(replacementToken);
  });

  test("uses only the fixed read-only Wrangler allowlist", () => {
    const request = requestFixture();
    const { plan } = buildCloudflareReadbackPlan(request);
    expect(plan).toHaveLength(13);
    for (const item of plan) {
      expect(() => assertReadOnlyWranglerCommand(item)).not.toThrow();
      expect(item.args).not.toContain("deploy");
      expect(item.args).not.toContain("delete");
      expect(item.args).not.toContain("ssh");
      expect(item.args).not.toContain("wake");
    }
    expect(() =>
      assertReadOnlyWranglerCommand({
        ...plan[0],
        args: [plan[0].wranglerCliPath, "deploy", "--name", "unsafe"],
      }),
    ).toThrow(/read-only allowlist|mutating/);
    expect(() =>
      assertReadOnlyWranglerCommand({
        ...plan[0],
        command: pathLikeAbsolute("untrusted-runtime"),
      }),
    ).toThrow(/repository-pinned path/);
    expect(() =>
      assertReadOnlyWranglerCommand({
        ...plan[0],
        wranglerCliPath: pathLikeAbsolute("untrusted-wrangler.js"),
        args: [pathLikeAbsolute("untrusted-wrangler.js"), ...plan[0].args.slice(1)],
      }),
    ).toThrow(/repository-pinned path/);
  });

  test("maps only the dedicated replacement token into the child environment", async () => {
    const request = requestFixture();
    const plan = buildCloudflareReadbackPlan(request);
    const calls = [];
    const report = await executeCloudflareReadback(plan, {
      apiToken: replacementToken,
      runCommand: async (command, args, options) => {
        const item = plan.plan[calls.length];
        calls.push({ command, args, options });
        return successfulCommandResult(item);
      },
    });

    expect(report.complete).toBe(true);
    expect(report.paginationComplete).toBe(true);
    expect(calls).toHaveLength(13);
    for (const call of calls) {
      expect(call.args.join(" ")).not.toContain(replacementToken);
      expect(call.options.env.CLOUDFLARE_API_TOKEN).toBe(replacementToken);
      expect(call.options.env.CLOUDFLARE_ACCOUNT_ID).toBe(request.accountId);
      expect(call.options.env.CINATOKEN_P5_READBACK_TOKEN).toBeUndefined();
      expect(call.options.env.HOME).toBeUndefined();
      expect(call.options.env.USERPROFILE).toBeUndefined();
    }
    expect(JSON.stringify(report)).not.toContain(replacementToken);
  });

  test("binds the Container application to the exact deployed image digest", async () => {
    const request = requestFixture();
    const plan = buildCloudflareReadbackPlan(request);
    const info = plan.plan.find((item) => item.key === "container-info");
    const images = plan.plan.find((item) => item.key === "container-images");
    expect(info.format).toBe("json");
    expect(info.expectedContainerImageDigest).toBe(
      request.candidate.containerImageDigest,
    );
    expect(images.expectedValues).toEqual([]);

    let callIndex = 0;
    const report = await executeCloudflareReadback(plan, {
      apiToken: replacementToken,
      runCommand: async () => {
        const item = plan.plan[callIndex++];
        if (item.key !== "container-info") return successfulCommandResult(item);
        return {
          ...successfulCommandResult(item),
          stdout: `${JSON.stringify({
            id: request.containerApplicationId,
            configuration: { image: `registry.invalid/app@sha256:${"9".repeat(64)}` },
          })}\n`,
        };
      },
    });
    const infoSummary = report.commands.find(
      (item) => item.key === "container-info",
    );
    expect(infoSummary.expectedValuesPresent).toBe(true);
    expect(infoSummary.expectedContainerImageDigestPresent).toBe(false);
    expect(infoSummary.status).toBe("not-proven");
    expect(report.complete).toBe(false);
  });

  test("rejects credential reflection and marks full pages incomplete", async () => {
    const request = requestFixture();
    const plan = buildCloudflareReadbackPlan(request);
    await expect(
      executeCloudflareReadback(plan, {
        apiToken: replacementToken,
        runCommand: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({ value: replacementToken }),
          stderr: "",
        }),
      }),
    ).rejects.toThrow(/contained the readback credential/);

    let callIndex = 0;
    const incomplete = await executeCloudflareReadback(plan, {
      apiToken: replacementToken,
      runCommand: async () => {
        const item = plan.plan[callIndex++];
        if (item.key === "container-applications") {
          return {
            exitCode: 0,
            stdout: JSON.stringify(
              Array.from({ length: 100 }, (_, index) =>
                index === 0 ? item.expectedValues : [`application-${index}`],
              ).flat(),
            ),
            stderr: "",
          };
        }
        return successfulCommandResult(item);
      },
    });
    expect(incomplete.paginationComplete).toBe(false);
    expect(
      incomplete.commands.find((item) => item.key === "container-applications")
        .status,
    ).toBe("not-proven");
  });

  test("keeps missing external inventories not-proven", async () => {
    const request = requestFixture();
    const result = await collectWith({ request, sourceBundle: undefined });

    expect(result.subject.foundationEvidenceReady).toBe(false);
    expect(result.subject.decision).toBe("not-proven");
    expect(result.subject.p5Eligible).toBe(false);
    expect(result.binding.paginationComplete).toBe(false);
    expect(result.subject.blockers).toContain("shard-registry-source-absent");
    expect(result.subject.blockers).toContain("r2-inventory-source-absent");
    expect(result.subject.blockers).toContain("traffic-source-absent");
    expect(result.subject.blockers).toContain("sbom-source-absent");
    expect(result.subject.evidenceFacts).toBeNull();
  });

  test("emits reviewable foundation facts only when every source is complete", async () => {
    const request = requestFixture();
    const sources = sourcesFixture(request);
    const result = await collectWith({ request, sourceBundle: sources });

    expect(result.subject.foundationEvidenceReady).toBe(true);
    expect(result.subject.blockers).toEqual([]);
    expect(result.binding.paginationComplete).toBe(true);
    expect(result.subject.p5Eligible).toBe(false);
    expect(result.subject.productionEligible).toBe(false);
    expect(result.subject.customerTrafficEligible).toBe(false);
    expect(result.subject.evidenceFacts.remoteInventory.verifiedShardCount).toBe(8);
    expect(result.subject.evidenceFacts.remoteInventory.unknownWriterCount).toBe(0);
    expect(result.subject.evidenceFacts.candidateFreeze.allActionGatesFalse).toBe(true);
    expect(result.foundationCaptureSha256).toBe(digest(result.subject));
    expect(result.binding.foundationCaptureSha256).toBe(
      result.foundationCaptureSha256,
    );
    expect(JSON.stringify(result)).not.toContain(replacementToken);
    expect(JSON.stringify(result)).not.toContain(request.accountId);
    expect(JSON.stringify(result)).not.toContain(request.configKvNamespaceId);
    expect(JSON.stringify(result)).not.toContain(request.containerApplicationId);
  });

  test("measures the bounded observation between complete readback snapshots", async () => {
    const request = requestFixture();
    request.observationSeconds = 7200;
    const result = await collectWith({
      request,
      sourceBundle: sourcesFixture(request),
      readbackDurationsMs: [60_000, 120_000],
    });
    expect(result.subject.observationStartedAt).toBe(
      "2026-07-19T10:01:00.000Z",
    );
    expect(result.subject.observationEndedAt).toBe(
      "2026-07-19T12:01:00.000Z",
    );
    expect(result.subject.observationSeconds).toBe(7200);
    expect(result.subject.foundationEvidenceReady).toBe(true);
  });

  test("fails foundation readiness on readback drift", async () => {
    const request = requestFixture();
    const result = await collectWith({
      request,
      sourceBundle: sourcesFixture(request),
      snapshots: [readbackFixture("a"), readbackFixture("b")],
    });
    expect(result.subject.foundationEvidenceReady).toBe(false);
    expect(result.subject.blockers).toContain("cloudflare-readback-drift");
  });

  test("fails foundation readiness on unknown writers, traffic, or source status", async () => {
    const request = requestFixture();
    const sources = sourcesFixture(request);
    sources.sources.r2Inventory.unknownWriterCount = 1;
    sources.sources.traffic.customerTrafficCount = 1;
    sources.sources.shardRegistry.status = "unknown";
    const result = await collectWith({ request, sourceBundle: sources });
    expect(result.subject.foundationEvidenceReady).toBe(false);
    expect(result.subject.blockers).toContain("unknown-r2-writers");
    expect(result.subject.blockers).toContain("customer-traffic-present");
    expect(result.subject.blockers).toContain("shardRegistry-source-not-pass");
  });

  test("requires source capture to overlap the bounded observation", async () => {
    const request = requestFixture();
    const sources = sourcesFixture(request);
    sources.capturedAt = "2026-07-19T09:00:00.000Z";
    const result = await collectWith({ request, sourceBundle: sources });
    expect(result.subject.blockers).toContain(
      "source-capture-outside-observation-window",
    );
  });

  test("validates the strict source bundle and candidate binding", () => {
    const request = requestFixture();
    const candidateDigest = p5CandidateDigestSha256(request.candidate);
    const sources = sourcesFixture(request);
    expect(validateFoundationSources(sources, candidateDigest)).toEqual(sources);
    expect(() =>
      validateFoundationSources(
        { ...sources, candidateDigestSha256: "0".repeat(64) },
        candidateDigest,
      ),
    ).toThrow(/candidate digest mismatch/);
    expect(() =>
      validateFoundationSources({ ...sources, rawPayload: "unsafe" }, candidateDigest),
    ).toThrow(/unknown or missing fields/);
  });

  test("requires explicit live confirmations and rejects CLI ambiguity", () => {
    expect(parseCliArgs(["--request", "request.json", "--dry-run"]).mode).toBe(
      "dry-run",
    );
    expect(() => parseCliArgs(["--request", "request.json", "--deploy"])).toThrow(
      /unknown option/,
    );
    expect(() =>
      parseCliArgs([
        "--request",
        "request.json",
        "--dry-run",
        "--confirm-staging-readback",
      ]),
    ).toThrow(/does not accept live confirmations/);
    expect(() => parseCliArgs(["--self-test", "--dry-run"])).toThrow(
      /does not accept other options/,
    );
  });
});

async function collectWith({
  request,
  sourceBundle,
  snapshots,
  readbackDurationsMs = [],
} = {}) {
  let nowMs = new Date("2026-07-19T10:00:00.000Z").getTime();
  const readbacks = snapshots ?? [readbackFixture("a"), readbackFixture("a")];
  let readbackIndex = 0;
  return await collectP5Foundation(
    {
      request,
      sourceBundle,
      apiToken: replacementToken,
    },
    {
      now: () => new Date(nowMs),
      sleep: async (ms) => {
        nowMs += ms;
      },
      executeReadback: async () => {
        const index = readbackIndex++;
        const result = readbacks[index];
        nowMs += readbackDurationsMs[index] ?? 0;
        return result;
      },
      collectorArtifactDigest: collectorDigest,
    },
  );
}

function readbackFixture(marker) {
  const commands = Array.from({ length: 13 }, (_, index) => ({
    key: `command-${index}`,
    status: "pass",
    outputSha256: marker.repeat(64),
    outputBytes: 10,
    stderrSha256: null,
    stderrEmpty: true,
    expectedValuesPresent: true,
    itemCount: 1,
    paginationComplete: true,
  }));
  return {
    commands,
    digestSha256: marker.repeat(64),
    complete: true,
    paginationComplete: true,
    stderrEmpty: true,
  };
}

function successfulCommandResult(item) {
  let stdout;
  if (item.expectedContainerImageDigest !== null) {
    stdout = `${JSON.stringify({
      id: item.expectedValues[0],
      configuration: {
        image: `registry.invalid/app@${item.expectedContainerImageDigest}`,
      },
    })}\n`;
  } else if (item.format === "text") {
    stdout = `${item.expectedValues.join(" ")}\n`;
  } else {
    stdout = `${JSON.stringify({ items: item.expectedValues })}\n`;
  }
  return {
    exitCode: 0,
    stdout,
    stderr: "",
    outputLimitExceeded: false,
    timedOut: false,
    invalidUtf8: false,
  };
}

function requestFixture() {
  const configKvNamespaceId = "0123456789abcdef0123456789abcdef";
  return {
    schemaVersion: 1,
    contract: FOUNDATION_REQUEST_CONTRACT,
    environment: "staging",
    observationSeconds: 300,
    accountId: "fedcba9876543210fedcba9876543210",
    configKvNamespaceId,
    containerApplicationId: "container-app-staging-001",
    candidate: {
      repository: "cinagroup/cinatoken-rust",
      commitSha: "404ae9ad3d217194922692b585c967fe2ba2a086",
      goSourceCommit: "73652508abc5cb09214dde02d51d69d1d1ccc703",
      vibeSourceCommit: "918e97480ee44e357abe99bf33c27259d6ac7ebd",
      edgeWorkerVersionId: "edge-version-001",
      controllerWorkerVersionId: "controller-version-001",
      providerEgressWorkerVersionId: "egress-version-001",
      containerImageDigest: `sha256:${"4".repeat(64)}`,
      containerSbomSha256: "5".repeat(64),
      d1DatabaseName: "cinatoken-rust-db-staging",
      d1DatabaseId: "c285553f-7f98-4ec2-b4d6-f84a3b409f3e",
      r2BucketName: "cinatoken-rust-files-staging",
      configKvNamespaceIdSha256: sha256(configKvNamespaceId),
      controllerServiceName: "cinatoken-container-controller-staging",
      providerEgressServiceName: "cinatoken-container-egress-staging",
      doNamespaceIdSha256: "7".repeat(64),
      doBinding: "RELAY_SHARDS",
      doClass: "RelayShardContainer",
      containerClass: "RelayShardContainer",
      ringGeneration: 1,
      shardCount: 8,
      migrationHead: "0053_relay_container_financial_terminal_v2.sql",
      migrationCount: 53,
      responseProtocolVersion: 3,
      statusContractVersion: 4,
      financialTerminalContractVersion: 2,
      terminalAckContractVersion: 3,
    },
  };
}

function sourcesFixture(request) {
  const base = () => ({
    status: "pass",
    collectorId: "source-collector-v1",
    collectorVersion: "1.0.0",
    sourceArtifactSha256: "8".repeat(64),
  });
  return {
    schemaVersion: 1,
    contract: FOUNDATION_SOURCES_CONTRACT,
    environment: "staging",
    candidateDigestSha256: p5CandidateDigestSha256(request.candidate),
    capturedAt: "2026-07-19T10:02:00.000Z",
    accountIdSha256: sha256(request.accountId),
    paginationComplete: true,
    sources: {
      actionGates: {
        ...base(),
        allActionGatesFalse: true,
      },
      sbom: {
        ...base(),
        containerImageDigest: request.candidate.containerImageDigest,
        containerSbomSha256: request.candidate.containerSbomSha256,
        containerSignatureVerified: true,
        unapprovedCriticalVulnerabilities: 0,
        unapprovedHighVulnerabilities: 0,
      },
      shardRegistry: {
        ...base(),
        doNamespaceIdSha256: request.candidate.doNamespaceIdSha256,
        ringGeneration: request.candidate.ringGeneration,
        shardCount: request.candidate.shardCount,
        verifiedShardCount: request.candidate.shardCount,
      },
      r2Inventory: {
        ...base(),
        unknownWriterCount: 0,
        unknownObjectCount: 0,
      },
      traffic: {
        ...base(),
        customerTrafficCount: 0,
        environmentIsolationVerified: true,
      },
    },
  };
}

function digest(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function pathLikeAbsolute(name) {
  return process.platform === "win32" ? `C:\\untrusted\\${name}` : `/untrusted/${name}`;
}
