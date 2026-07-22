import { createHash } from "node:crypto";

const MOCK_BASE_URL = "http://127.0.0.1";
const RUNTIME_BASE_URL = "http://runtime.cinatoken.internal:8080";
const INPUT = Buffer.from(process.env.MOCK_INPUT_BASE64 ?? "", "base64");
const INPUT_SHA256 = process.env.MOCK_INPUT_SHA256 ?? "";

requireCondition(INPUT.length > 0, "probe input is empty");
requireCondition(/^[a-f0-9]{64}$/.test(INPUT_SHA256), "probe input hash is invalid");
requireCondition(
  createHash("sha256").update(INPUT).digest("hex") === INPUT_SHA256,
  "probe input hash does not match bytes",
);

const probeMode = process.env.PROBE_MODE ?? "";
requireCondition(
  probeMode === "primary" || probeMode === "restart",
  "probe mode must be primary or restart",
);
const report = probeMode === "restart" ? await runRestartProbe() : await runPrimaryProbe();
process.stdout.write(`${JSON.stringify(report)}\n`);

async function runPrimaryProbe() {
  await waitForJson(`${MOCK_BASE_URL}/control/state`, (value) => value.mode === "success");
  const health = await waitForJson(
    `${RUNTIME_BASE_URL}/healthz`,
    (value) => value.status === "ok",
  );
  const readiness = await waitForJson(
    `${RUNTIME_BASE_URL}/readyz`,
    (value) =>
      value.status === "ready" &&
      value.execution_enabled === true &&
      /^[a-f0-9]{64}$/.test(value.runtime_build_id),
  );
  requireCondition(health.status === "ok", "runtime health probe failed");

  const probe = await postOperation("linux-health", "health_probe");
  requireResponse(probe, 200, "completed");

  await setMockMode("success");
  const completed = await postOperation(
    "linux-provider-success",
    "chat_completions_canary",
  );
  requireResponse(completed, 200, "completed");
  requireCondition(
    completed.body.result?.object_version === "version-linux-gate",
    "result object version is missing",
  );
  let mockState = await getJson(`${MOCK_BASE_URL}/control/state`);
  requireCondition(
    mockState.body.r2Calls === 1 && mockState.body.providerCalls === 1,
    "success must perform exactly one R2 read and one provider attempt",
  );

  await setMockMode("ambiguous");
  const ambiguous = await postOperation(
    "linux-provider-ambiguous",
    "chat_completions_canary",
  );
  requireResponse(ambiguous, 202, "recovery_required", "ambiguous_execution");
  mockState = await getJson(`${MOCK_BASE_URL}/control/state`);
  requireCondition(
    mockState.body.r2Calls === 2 && mockState.body.providerCalls === 2,
    "ambiguous execution must not retry the provider",
  );

  await setMockMode("input_hash_mismatch");
  const inputMismatch = await postOperation(
    "linux-input-mismatch",
    "chat_completions_canary",
  );
  requireResponse(inputMismatch, 503, "rejected", "provider_input_unavailable");
  mockState = await getJson(`${MOCK_BASE_URL}/control/state`);
  requireCondition(
    mockState.body.r2Calls === 3 && mockState.body.providerCalls === 2,
    "input mismatch must fail before provider dispatch",
  );

  return {
    status: "passed",
    mode: "primary",
    runtimeBuildId: readiness.runtime_build_id,
    healthProbe: "passed",
    providerSuccessSingleAttempt: true,
    ambiguousExecutionNoRetry: true,
    inputHashMismatchFailClosed: true,
  };
}

async function runRestartProbe() {
  const expectedRuntimeBuildId = process.env.EXPECTED_RUNTIME_BUILD_ID ?? "";
  requireCondition(
    /^[a-f0-9]{64}$/.test(expectedRuntimeBuildId),
    "expected runtime build id is invalid",
  );
  const readiness = await waitForJson(
    `${RUNTIME_BASE_URL}/readyz`,
    (value) =>
      value.status === "ready" && /^[a-f0-9]{64}$/.test(value.runtime_build_id),
  );
  requireCondition(
    readiness.runtime_build_id === expectedRuntimeBuildId,
    "same image restart changed runtime build identity",
  );
  return {
    status: "passed",
    mode: "restart",
    runtimeBuildId: readiness.runtime_build_id,
    sameImageRestartIdentityStable: true,
  };
}

async function setMockMode(mode) {
  const response = await getJson(`${MOCK_BASE_URL}/control/mode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  requireCondition(
    response.status === 200 && response.body.mode === mode,
    "mock mode update failed",
  );
}

async function postOperation(operationId, kind) {
  return await getJson(`${RUNTIME_BASE_URL}/v1/operations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cinatoken-container-protocol": "1",
    },
    body: JSON.stringify(buildOperationEnvelope(operationId, kind)),
  });
}

function buildOperationEnvelope(operationId, kind) {
  const now = Math.floor(Date.now() / 1000);
  const healthProbe = kind === "health_probe";
  return {
    protocol_version: 1,
    operation_id: operationId,
    operation_kind: kind,
    owner_generation: 1,
    owner_lease_expires_at: now + 120,
    execution_deadline_at: now + 60,
    provider_operation_id: `provider-${operationId}`,
    admission_sha256: "a".repeat(64),
    input: healthProbe
      ? {
          mode: "inline",
          sha256: createHash("sha256").update("").digest("hex"),
          size: 0,
          content_type: "application/json",
          request_object_key: null,
          object_version: null,
        }
      : {
          mode: "r2",
          sha256: INPUT_SHA256,
          size: INPUT.length,
          content_type: "application/json",
          request_object_key: `container-inputs/v1/${operationId}/input.json`,
          object_version: "version-linux-gate",
        },
    shard: {
      contract_version: 1,
      ring_generation: 1,
      shard_count: 8,
      shard_index: 3,
      instance_name: "cinatoken-relay-shard-v1-0003",
    },
    trace_id: operationId,
  };
}

function requireResponse(response, expectedStatus, expectedOutcome, expectedCode = null) {
  requireCondition(response.status === expectedStatus, `unexpected HTTP status ${response.status}`);
  requireCondition(response.body.status === expectedOutcome, "unexpected operation outcome");
  if (expectedCode !== null) {
    requireCondition(response.body.code === expectedCode, "unexpected operation code");
  }
}

async function waitForJson(url, predicate) {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await getJson(url);
      if (response.status === 200 && predicate(response.body)) return response.body;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`timed out waiting for ${url}: ${lastError?.message ?? "not ready"}`);
}

async function getJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(3_000),
  });
  const text = await response.text();
  requireCondition(text.length <= 64 * 1024, "HTTP response exceeds probe limit");
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("HTTP response is not JSON");
  }
  return { status: response.status, body };
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}
