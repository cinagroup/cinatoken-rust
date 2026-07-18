import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  FOUNDATION_CAPTURE_CONTRACT,
  canonicalJson,
  p5CandidateDigestSha256,
} from "../tools/relay_container_p5_evidence_contract.mjs";
import {
  FOUNDATION_MAX_INPUT_BYTES,
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
import {
  SHARD_ACTIVATION_LEDGER_CONTRACT,
  activationDigestSha256,
  buildActivationSnapshot,
  buildShardRegistryCapture,
  sha256Canonical,
} from "../tools/lib/relay_container_shard_registry.mjs";

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
    const unverifiableListKeys = [
      "edge-deployments",
      "controller-deployments",
      "provider-egress-deployments",
      "kv-namespaces",
      "container-applications",
      "container-instances",
      "container-images",
    ];
    expect(plan).toHaveLength(13);
    for (const item of plan) {
      expect(() => assertReadOnlyWranglerCommand(item)).not.toThrow();
      expect(item.args).not.toContain("deploy");
      expect(item.args).not.toContain("delete");
      expect(item.args).not.toContain("ssh");
      expect(item.args).not.toContain("wake");
    }
    expect(
      plan
        .filter((item) => item.paginationMode === "unverifiable-list")
        .map((item) => item.key),
    ).toEqual(unverifiableListKeys);
    expect(
      plan
        .filter((item) => item.paginationMode === "single-object")
        .map((item) => item.key),
    ).toEqual(
      plan
        .map((item) => item.key)
        .filter((key) => !unverifiableListKeys.includes(key)),
    );
    expect(() =>
      assertReadOnlyWranglerCommand({
        ...plan.find((item) => item.key === "container-applications"),
        paginationMode: "single-object",
      }),
    ).toThrow(/pagination classification drifted/);
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

    expect(report.complete).toBe(false);
    expect(report.paginationComplete).toBe(false);
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

  test("rejects credential reflection and cannot prove a short first page is complete", async () => {
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
              Array.from({ length: 99 }, (_, index) =>
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
    const applications = incomplete.commands.find(
      (item) => item.key === "container-applications",
    );
    expect(applications.itemCount).toBe(99);
    expect(applications.paginationComplete).toBe(false);
    expect(applications.status).toBe("not-proven");
  });

  test("allows non-paginated single-object commands to pass", async () => {
    const request = requestFixture();
    const fullPlan = buildCloudflareReadbackPlan(request);
    const singleObjectPlan = {
      ...fullPlan,
      plan: fullPlan.plan.filter(
        (item) => item.paginationMode === "single-object",
      ),
    };
    let callIndex = 0;
    const report = await executeCloudflareReadback(singleObjectPlan, {
      apiToken: replacementToken,
      runCommand: async () =>
        successfulCommandResult(singleObjectPlan.plan[callIndex++]),
    });

    expect(report.commands).toHaveLength(6);
    expect(report.commands.every((item) => item.status === "pass")).toBe(true);
    expect(report.complete).toBe(true);
    expect(report.paginationComplete).toBe(true);
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
    const sources = retimeShardCapture(
      sourcesFixture(request),
      "2026-07-19T10:01:00.000Z",
      "2026-07-19T12:01:00.000Z",
    );
    sources.capturedAt = "2026-07-19T12:01:00.000Z";
    const result = await collectWith({
      request,
      sourceBundle: sources,
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
    refreshSourceDigest(sources.sources.r2Inventory);
    refreshSourceDigest(sources.sources.traffic);
    const result = await collectWith({ request, sourceBundle: sources });
    expect(result.subject.foundationEvidenceReady).toBe(false);
    expect(result.subject.blockers).toContain("unknown-r2-writers");
    expect(result.subject.blockers).toContain("customer-traffic-present");
    expect(result.subject.blockers).toContain("shardRegistry-source-not-pass");

    const crossVersion = sourcesFixture(request);
    crossVersion.sources.actionGates.controllerVersionId = "controller-version-002";
    refreshSourceDigest(crossVersion.sources.actionGates);
    const crossVersionResult = await collectWith({
      request,
      sourceBundle: crossVersion,
    });
    expect(crossVersionResult.subject.blockers).toContain(
      "action-gates-controller-version-mismatch",
    );
  });

  test("requires source capture to overlap the bounded observation", async () => {
    const request = requestFixture();
    const sources = sourcesFixture(request);
    sources.capturedAt = "2026-07-19T09:00:00.000Z";
    const result = await collectWith({ request, sourceBundle: sources });
    expect(result.subject.blockers).toContain(
      "source-capture-outside-observation-window",
    );

    const staleShardSources = retimeShardCapture(
      sourcesFixture(request),
      "2026-07-19T09:00:00.000Z",
      "2026-07-19T09:05:00.000Z",
    );
    const staleShard = await collectWith({
      request,
      sourceBundle: staleShardSources,
    });
    expect(staleShard.subject.blockers).toContain(
      "shard-registry-window-does-not-cover-foundation",
    );
  });

  test("validates the strict source bundle and candidate binding", () => {
    const request = requestFixture();
    const candidateDigest = p5CandidateDigestSha256(request.candidate);
    const sources = sourcesFixture(request);
    expect(
      validateFoundationSources(sources, candidateDigest, request.candidate),
    ).toEqual(sources);
    expect(() =>
      validateFoundationSources(
        { ...sources, candidateDigestSha256: "0".repeat(64) },
        candidateDigest,
        request.candidate,
      ),
    ).toThrow(/candidate digest mismatch/);
    expect(() =>
      validateFoundationSources(
        { ...sources, rawPayload: "unsafe" },
        candidateDigest,
        request.candidate,
      ),
    ).toThrow(/unknown or missing fields/);
  });

  test("fits the full 1024-shard capture inside the bounded source input", () => {
    const request = requestFixture();
    request.candidate.shardCount = 1_024;
    const sources = sourcesFixture(request);
    expect(Buffer.byteLength(`${canonicalJson(sources)}\n`, "utf8")).toBeLessThanOrEqual(
      FOUNDATION_MAX_INPUT_BYTES,
    );
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
      containerRuntimeBuildId: "a".repeat(64),
      containerImageProvenanceSha256: "b".repeat(64),
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
      migrationHead: "0054_relay_container_shard_activations.sql",
      migrationCount: 54,
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
  const shardCapture = shardRegistryCaptureFixture(request);
  const sources = {
    schemaVersion: 2,
    contract: FOUNDATION_SOURCES_CONTRACT,
    environment: "staging",
    candidateDigestSha256: p5CandidateDigestSha256(request.candidate),
    capturedAt: "2026-07-19T10:05:00.000Z",
    accountIdSha256: sha256(request.accountId),
    paginationComplete: true,
    sources: {
      actionGates: {
        ...base(),
        controllerVersionId: request.candidate.controllerWorkerVersionId,
        actionGateInventorySha256: "9".repeat(64),
        allActionGatesFalse: true,
      },
      sbom: {
        ...base(),
        containerImageDigest: request.candidate.containerImageDigest,
        containerRuntimeBuildId: request.candidate.containerRuntimeBuildId,
        containerImageProvenanceSha256:
          request.candidate.containerImageProvenanceSha256,
        containerSbomSha256: request.candidate.containerSbomSha256,
        containerSignatureVerified: true,
        runtimeImageProvenanceVerified: true,
        unapprovedCriticalVulnerabilities: 0,
        unapprovedHighVulnerabilities: 0,
      },
      shardRegistry: {
        ...base(),
        sourceArtifactSha256: sha256Canonical(shardCapture),
        doNamespaceIdSha256: request.candidate.doNamespaceIdSha256,
        capture: shardCapture,
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
  for (const name of ["actionGates", "sbom", "r2Inventory", "traffic"]) {
    refreshSourceDigest(sources.sources[name]);
  }
  return sources;
}

function shardRegistryCaptureFixture(request) {
  const candidate = {
    controllerVersionId: request.candidate.controllerWorkerVersionId,
    runtimeBuildId: request.candidate.containerRuntimeBuildId,
    containerImageDigest: request.candidate.containerImageDigest,
    imageProvenanceSha256:
      request.candidate.containerImageProvenanceSha256,
    ringGeneration: request.candidate.ringGeneration,
    shardCount: request.candidate.shardCount,
  };
  const records = Array.from({ length: candidate.shardCount }, (_, shardIndex) => {
    const record = {
      registry_event_sequence: shardIndex + 1,
      shard_count: candidate.shardCount,
      shard_index: shardIndex,
      instance_name: `cinatoken-relay-shard-v1-${String(shardIndex).padStart(4, "0")}`,
      shard_contract_version: 1,
      runtime_protocol_version: 1,
      runtime_contract_version: 1,
      runtime_build_id: candidate.runtimeBuildId,
      activation_generation: 1,
      activation_probe_generation: shardIndex + 1,
      environment: "staging",
      container_status: "healthy",
      readiness_result_code: "process_ready_execution_disabled",
      process_ready: true,
      runtime_execution_enabled: false,
      controller_execution_enabled: false,
      activation_digest_sha256: "",
      activated_at:
        Math.floor(Date.parse("2026-07-19T09:59:00.000Z") / 1_000) +
        (shardIndex % 30),
    };
    record.activation_digest_sha256 = activationDigestSha256({
      controllerVersionId: candidate.controllerVersionId,
      ringGeneration: candidate.ringGeneration,
      record,
    });
    return record;
  });
  const highWatermark = records.at(-1).registry_event_sequence;
  const pages = [];
  for (let offset = 0; offset < records.length; offset += 64) {
    const pageRecords = records.slice(offset, offset + 64);
    const terminal = offset + pageRecords.length === records.length;
    pages.push({
      contract_version: 1,
      ledger_contract: SHARD_ACTIVATION_LEDGER_CONTRACT,
      controller_version_id: candidate.controllerVersionId,
      ring_generation: candidate.ringGeneration,
      high_watermark: highWatermark,
      total_records: records.length,
      count: pageRecords.length,
      next_cursor: terminal
        ? null
        : String(pageRecords.at(-1).registry_event_sequence),
      pagination_complete: terminal,
      records: pageRecords,
    });
  }
  const before = buildActivationSnapshot({
    capturedAt: "2026-07-19T10:00:00.000Z",
    pages,
  });
  const after = {
    ...before,
    capturedAt: "2026-07-19T10:05:00.000Z",
  };
  return buildShardRegistryCapture({
    candidate,
    observationStartedAt: before.capturedAt,
    observationEndedAt: after.capturedAt,
    before,
    after,
  });
}

function retimeShardCapture(sources, observationStartedAt, observationEndedAt) {
  const current = sources.sources.shardRegistry.capture;
  const activatedAt = Math.floor(Date.parse(observationStartedAt) / 1_000) - 60;
  const records = current.before.records.map((record, index) => {
    const adjusted = {
      ...record,
      activated_at: activatedAt + (index % 30),
      activation_digest_sha256: "",
    };
    adjusted.activation_digest_sha256 = activationDigestSha256({
      controllerVersionId: current.candidate.controllerVersionId,
      ringGeneration: current.candidate.ringGeneration,
      record: adjusted,
    });
    return adjusted;
  });
  const entriesSha256 = sha256Canonical(records);
  const before = {
    ...current.before,
    capturedAt: observationStartedAt,
    entriesSha256,
    records,
  };
  const after = {
    ...current.after,
    capturedAt: observationEndedAt,
    entriesSha256,
    records,
  };
  const capture = buildShardRegistryCapture({
    candidate: current.candidate,
    observationStartedAt,
    observationEndedAt,
    before,
    after,
  });
  sources.sources.shardRegistry.capture = capture;
  sources.sources.shardRegistry.sourceArtifactSha256 = sha256Canonical(capture);
  return sources;
}

function refreshSourceDigest(source) {
  const digestInput = { ...source };
  delete digestInput.sourceArtifactSha256;
  source.sourceArtifactSha256 = sha256Canonical(digestInput);
}

function digest(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function pathLikeAbsolute(name) {
  return process.platform === "win32" ? `C:\\untrusted\\${name}` : `/untrusted/${name}`;
}
