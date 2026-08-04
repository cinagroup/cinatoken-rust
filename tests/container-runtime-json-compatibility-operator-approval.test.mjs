import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildJsonCompatibilityCampaignPlan,
  canonicalJson,
  parseStrictJsonObject,
  sha256Canonical,
} from "../tools/container_runtime_json_compatibility_campaign.mjs";
import {
  signJsonCompatibilityOperatorApproval,
  validateJsonCompatibilityOperatorApprovalArtifact,
} from "../tools/container_runtime_json_compatibility_operator_approval.mjs";
import {
  deriveJsonCompatibilityOperatorCommandIdSha256,
} from "../tools/container_runtime_json_compatibility_operator_invocation.mjs";
import {
  prepareJsonCompatibilityOperatorConfig,
} from "../tools/prepare_container_runtime_json_compatibility_operator_config.mjs";
import {
  parseJsonCompatibilityOperatorApprovalSignerArgs,
  runJsonCompatibilityOperatorApprovalSigner,
} from "../tools/sign_container_runtime_json_compatibility_operator_approval.mjs";

const TEST_SPKI_SHA256 =
  "471850d2dcfe546734941e2d44fde594cb3e4445900da72536ac9683f6be5d10";
const TEST_PKCS8_BASE64URL =
  "MC4CAQAwBQYDK2VwBCIEIM79XI3U3zwizihw3d_2C1BkrjVK11rROOfxqGj5nW5v";
const NOW = new Date("2026-08-04T08:00:00Z");
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function fixture() {
  const directory = await mkdtemp(
    path.join(tmpdir(), "cinatoken-operator-approval-"),
  );
  temporaryDirectories.push(directory);
  const operatorConfigPath = path.join(directory, "operator.jsonc");
  await prepareJsonCompatibilityOperatorConfig({
    outPath: operatorConfigPath,
    currentKid: "operator-hmac-001",
    currentCredentialIdSha256: "c1".repeat(32),
    approvalCurrentKid: "operator-approval-001",
    approvalCurrentSpkiSha256: TEST_SPKI_SHA256,
    approvalPreviousKid: "",
    approvalPreviousSpkiSha256: "",
    invokerVersionId: "invoker-version-001",
  });
  const operatorConfig = parseStrictJsonObject(
    await readFile(operatorConfigPath, "utf8"),
    "operator config fixture",
  );
  const controllerConfig = JSON.parse(
    await readFile(
      path.resolve("services/container-controller/wrangler.staging.jsonc"),
      "utf8",
    ),
  );
  controllerConfig.vars.CONTAINER_JSON_COMPATIBILITY_PROBE_ENABLED = "true";
  const plan = buildJsonCompatibilityCampaignPlan({
    config: controllerConfig,
    campaignIdSha256: "11".repeat(32),
    controllerVersionId: "controller-version-001",
    runnerVersionId: "runner-version-001",
    runnerConfigSha256: "a1".repeat(32),
    operatorVersionId: "operator-version-001",
    operatorConfigSha256: sha256Canonical(operatorConfig),
    operatorApprovalKeyId: "operator-approval-001",
    operatorApprovalSpkiSha256: TEST_SPKI_SHA256,
    invokerVersionId: "invoker-version-001",
    invokerConfigSha256: "a2".repeat(32),
    permitIssuerVersionId: "permit-issuer-version-001",
    permitIssuerConfigSha256: "a3".repeat(32),
    executorVersionId: "executor-version-001",
    executorConfigSha256: "a4".repeat(32),
    runtimeNBuildIdSha256: "22".repeat(32),
    runtimeNImageDigest: `sha256:${"33".repeat(32)}`,
    runtimeNMinusOneBuildIdSha256: "44".repeat(32),
    runtimeNMinusOneImageDigest: `sha256:${"55".repeat(32)}`,
    candidateShardIndex: 3,
  });
  const phase = plan.phases[0];
  const request = {
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-json-compatibility-operator-phase-request-v1",
    execution: {
      schemaVersion: 2,
      contract:
        "cinatoken-container-runtime-json-compatibility-execute-phase-request-v2",
      kind: "container-runtime-json-compatibility-phase-execution",
      environment: "staging",
      campaignIdSha256: plan.campaignIdSha256,
      planDigestSha256: plan.planDigestSha256,
      phaseExecutionId: "phase-execution-001",
      controller: {
        serviceName: plan.controller.serviceName,
        versionId: plan.controller.versionId,
        configSha256: plan.controller.configSha256,
      },
      runtimes: structuredClone(plan.runtimes),
      ring: structuredClone(plan.ring),
      phase: {
        ordinal: phase.ordinal,
        id: phase.id,
        topology: structuredClone(phase.topology),
      },
    },
    executor: {
      serviceName:
        "cinatoken-container-runtime-json-compatibility-executor-staging",
      versionId: plan.privateServices.executor.versionId,
    },
    invoker: {
      serviceName:
        "cinatoken-container-runtime-json-compatibility-invoker-staging",
      versionId: plan.privateServices.invoker.versionId,
    },
    topologyReadbackSha256: "88".repeat(32),
    beforeContextSha256: "99".repeat(32),
  };
  return {
    directory,
    operatorConfigPath,
    operatorConfig,
    plan,
    request,
    privateKeyBytes: Buffer.from(TEST_PKCS8_BASE64URL, "base64url"),
  };
}

describe("offline JSON compatibility operator approval", () => {
  test("binds the final plan, exact runner, phase request, and command", async () => {
    const value = await fixture();
    const authorized = signJsonCompatibilityOperatorApproval({
      ...value,
      now: NOW,
    });
    expect(validateJsonCompatibilityOperatorApprovalArtifact(
      value.plan,
      authorized,
    )).toEqual(authorized);
    expect(authorized.approval.subject).toMatchObject({
      planDigestSha256: value.plan.planDigestSha256,
      caller: value.plan.privateServices.runner,
      operator: {
        serviceName:
          "cinatoken-container-runtime-json-compatibility-operator-staging",
        versionId: value.plan.privateServices.operator.versionId,
      },
      topologyReadbackSha256: value.request.topologyReadbackSha256,
      beforeContextSha256: value.request.beforeContextSha256,
      issuedAt: Math.floor(NOW.getTime() / 1000),
      expiresAt: Math.floor(NOW.getTime() / 1000) + 600,
    });
    expect(authorized.approval.subject.commandIdSha256).toBe(
      deriveJsonCompatibilityOperatorCommandIdSha256(
        value.request,
        value.plan.privateServices.operator.versionId,
      ),
    );
  });

  test("rejects request, caller, signature, config, and trust-anchor drift", async () => {
    const value = await fixture();
    const authorized = signJsonCompatibilityOperatorApproval({
      ...value,
      now: NOW,
    });
    for (const mutate of [
      (candidate) => { candidate.request.beforeContextSha256 = "aa".repeat(32); },
      (candidate) => { candidate.approval.subject.caller.versionId = "runner-drift"; },
      (candidate) => { candidate.approval.subject.unreviewed = true; },
      (candidate) => {
        candidate.approval.subject.operator.serviceName = "operator-drift";
      },
      (candidate) => {
        candidate.approval.signatureBase64url =
          `${candidate.approval.signatureBase64url.slice(0, -1)}B`;
      },
    ]) {
      const candidate = structuredClone(authorized);
      mutate(candidate);
      expect(() =>
        validateJsonCompatibilityOperatorApprovalArtifact(value.plan, candidate),
      ).toThrow();
    }

    const configDrift = structuredClone(value.operatorConfig);
    configDrift.vars.JSON_COMPATIBILITY_OPERATOR_INVOKER_VERSION_ID =
      "invoker-version-drift";
    expect(() => signJsonCompatibilityOperatorApproval({
      ...value,
      operatorConfig: configDrift,
      now: NOW,
    })).toThrow(/operator config digest|pinned invoker/u);

    const trustDrift = structuredClone(value.plan);
    trustDrift.operatorApproval.signerSpkiSha256 = "ab".repeat(32);
    const subject = structuredClone(trustDrift);
    delete subject.planDigestSha256;
    trustDrift.planDigestSha256 = sha256Canonical(subject);
    const trustDriftRequest = structuredClone(value.request);
    trustDriftRequest.execution.planDigestSha256 = trustDrift.planDigestSha256;
    expect(() => signJsonCompatibilityOperatorApproval({
      ...value,
      plan: trustDrift,
      request: trustDriftRequest,
      now: NOW,
    })).toThrow(/SPKI digest/u);
  });

  test("writes create-only canonical output and never accepts a key argv option", async () => {
    const value = await fixture();
    const planPath = path.join(value.directory, "plan.json");
    const requestPath = path.join(value.directory, "request.json");
    const outPath = path.join(value.directory, "authorized.json");
    await writeFile(planPath, canonicalJson(value.plan), "utf8");
    await writeFile(requestPath, canonicalJson(value.request), "utf8");
    const result = await runJsonCompatibilityOperatorApprovalSigner({
      planPath,
      operatorConfigPath: value.operatorConfigPath,
      requestPath,
      outPath,
      keySlot: "current",
      privateKeyBytes: value.privateKeyBytes,
      now: NOW,
    });
    const source = await readFile(outPath, "utf8");
    const authorized = parseStrictJsonObject(source, "authorized request output");
    expect(source).toBe(`${canonicalJson(authorized)}\n`);
    expect(result).toMatchObject({
      ok: true,
      privateKeySource: "stdin",
      privateKeyPersisted: false,
      networkRequestsPerformed: false,
    });
    await expect(runJsonCompatibilityOperatorApprovalSigner({
      planPath,
      operatorConfigPath: value.operatorConfigPath,
      requestPath,
      outPath,
      keySlot: "current",
      privateKeyBytes: value.privateKeyBytes,
      now: NOW,
    })).rejects.toThrow();
    expect(() => parseJsonCompatibilityOperatorApprovalSignerArgs([
      "--private-key",
      "secret",
    ])).toThrow(/unknown option/u);
  });
});
