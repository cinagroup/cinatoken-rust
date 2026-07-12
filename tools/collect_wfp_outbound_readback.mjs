#!/usr/bin/env bun

const schemaVersion = 1;
const cloudflareApiBase = "https://api.cloudflare.com/client/v4";
const replacementTokenEnv = "CINATOKEN_WFP_READBACK_TOKEN";
const expectedOutboundSecret = "CINATOKEN_WFP_OUTBOUND_AI_TOKEN";
const accountBindingName = "CLOUDFLARE_ACCOUNT_ID";
const requestTimeoutMs = 30_000;
const maxJsonBytes = 1024 * 1024;

try {
  const args = parseArgs(process.argv.slice(2));
  let result;
  if (args.flags.has("self-test")) {
    result = await runSelfTest();
  } else {
    const identity = normalizeIdentity(args);
    if (args.flags.has("dry-run")) {
      result = buildDryRun(identity);
    } else {
      requireLiveConfirmation(args);
      const apiToken = requireReplacementToken(
        process.env[replacementTokenEnv],
      );
      result = await collectReadback({ ...identity, apiToken });
    }
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "[collector] operation failed",
  );
  process.exit(1);
}

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  const knownValues = new Set([
    "account-id",
    "namespace",
    "dispatcher-script",
    "outbound-script",
    "dispatcher-binding",
  ]);
  const knownFlags = new Set([
    "confirm-readback",
    "confirm-replacement-token",
    "dry-run",
    "self-test",
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") usage(0);
    if (!arg.startsWith("--")) usage(2, `[input] unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (knownFlags.has(key)) {
      flags.add(key);
      continue;
    }
    if (!knownValues.has(key)) usage(2, `[input] unknown option: ${arg}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) {
      usage(2, `[input] ${arg} requires a value`);
    }
    if (values.has(key)) usage(2, `[input] ${arg} must not be repeated`);
    values.set(key, value);
  }

  if (flags.has("self-test") && (values.size > 0 || flags.size > 1)) {
    usage(2, "[input] --self-test does not accept any other options");
  }
  if (flags.has("dry-run") && flags.has("self-test")) {
    usage(2, "[input] --dry-run and --self-test are mutually exclusive");
  }
  return { values, flags };
}

function usage(exitCode, error) {
  if (error) console.error(error);
  console.error(
    [
      "Usage:",
      "  bun tools/collect_wfp_outbound_readback.mjs --account-id <id> --namespace <name> --dispatcher-script <name> [--outbound-script <name>] [--dispatcher-binding <name>] --confirm-readback --confirm-replacement-token",
      "  bun tools/collect_wfp_outbound_readback.mjs --account-id <id> --namespace <name> --dispatcher-script <name> --dry-run",
      "  bun tools/collect_wfp_outbound_readback.mjs --self-test",
      "",
      "Live collection reads only CINATOKEN_WFP_READBACK_TOKEN. The token must be a rotated replacement credential.",
      "CLOUDFLARE_ACCOUNT_ID, WFP_DISPATCH_NAMESPACE, WFP_DISPATCHER_SCRIPT_NAME, and WFP_OUTBOUND_SCRIPT_NAME may replace identity flags.",
      "The outbound script defaults to cinatoken-wfp-outbound and the dispatcher binding defaults to DISPATCHER.",
      "The collector is read-only, writes no files, and emits one redacted JSON object to stdout.",
    ].join("\n"),
  );
  process.exit(exitCode);
}

function normalizeIdentity(args) {
  return {
    accountId: requireAccountId(
      args.values.get("account-id") || process.env.CLOUDFLARE_ACCOUNT_ID,
    ),
    namespace: requireNamespace(
      args.values.get("namespace") || process.env.WFP_DISPATCH_NAMESPACE,
    ),
    dispatcherScript: requireWorkerName(
      args.values.get("dispatcher-script") ||
        process.env.WFP_DISPATCHER_SCRIPT_NAME,
      "dispatcher-script",
    ),
    outboundScript: requireWorkerName(
      args.values.get("outbound-script") ||
        process.env.WFP_OUTBOUND_SCRIPT_NAME ||
        "cinatoken-wfp-outbound",
      "outbound-script",
    ),
    dispatcherBinding: requireBindingName(
      args.values.get("dispatcher-binding") || "DISPATCHER",
      "dispatcher-binding",
    ),
  };
}

function requireLiveConfirmation(args) {
  if (!args.flags.has("confirm-readback")) {
    throw new Error(
      "[confirmation] live collection requires --confirm-readback",
    );
  }
  if (!args.flags.has("confirm-replacement-token")) {
    throw new Error(
      "[confirmation] live collection requires --confirm-replacement-token after credential rotation",
    );
  }
}

function requireReplacementToken(value) {
  if (typeof value !== "string" || value.length < 20 || value.length > 4096) {
    throw new Error(
      `[credentials] ${replacementTokenEnv} must contain a replacement token`,
    );
  }
  if (/[^\x21-\x7e]/.test(value)) {
    throw new Error(
      `[credentials] ${replacementTokenEnv} contains invalid characters`,
    );
  }
  return value;
}

function buildDryRun(identity) {
  return {
    ok: true,
    schemaVersion,
    dryRun: true,
    networkRequests: false,
    credentialsRead: false,
    writesFiles: false,
    source: "cloudflare-wfp-outbound-readback",
    identity: normalizeEvidenceIdentity(identity),
    requests: [
      "namespace-before",
      "dispatcher-settings",
      "dispatcher-secrets",
      "outbound-settings",
      "outbound-secrets",
      "namespace-after",
    ],
    limits: { jsonBytes: maxJsonBytes, timeoutMs: requestTimeoutMs },
  };
}

async function collectReadback(options, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const now = dependencies.now || (() => new Date());
  if (typeof fetchImpl !== "function") {
    throw new Error("[collector] fetch is unavailable");
  }

  const urls = buildUrls(options);
  const namespaceBefore = validateNamespace(
    await fetchJson(
      urls.namespace,
      "namespace-before",
      options.apiToken,
      fetchImpl,
      "object",
    ),
    options,
    "namespace-before",
  );
  const dispatcher = validateDispatcherSettings(
    await fetchJson(
      urls.dispatcherSettings,
      "dispatcher-settings",
      options.apiToken,
      fetchImpl,
      "object",
    ),
    options,
  );
  const dispatcherSecrets = validateSecretInventory(
    await fetchJson(
      urls.dispatcherSecrets,
      "dispatcher-secrets",
      options.apiToken,
      fetchImpl,
      "array",
    ),
    "dispatcher",
  );
  const outbound = validateOutboundSettings(
    await fetchJson(
      urls.outboundSettings,
      "outbound-settings",
      options.apiToken,
      fetchImpl,
      "object",
    ),
    options,
  );
  const outboundSecrets = validateSecretInventory(
    await fetchJson(
      urls.outboundSecrets,
      "outbound-secrets",
      options.apiToken,
      fetchImpl,
      "array",
    ),
    "outbound",
  );
  validateSecretOwnership(dispatcherSecrets, outboundSecrets, outbound);
  const namespaceAfter = validateNamespace(
    await fetchJson(
      urls.namespace,
      "namespace-after",
      options.apiToken,
      fetchImpl,
      "object",
    ),
    options,
    "namespace-after",
  );
  if (stableJson(namespaceBefore) !== stableJson(namespaceAfter)) {
    throw new Error(
      "[identity] dispatch namespace changed while readback was being collected",
    );
  }

  const evidence = {
    schemaVersion,
    source: "cloudflare-wfp-outbound-readback",
    capturedAt: requireTimestamp(now()),
    verified: true,
    identity: normalizeEvidenceIdentity(options),
    namespace: namespaceAfter,
    dispatcher: {
      binding: dispatcher,
      secretNames: dispatcherSecrets.map((secret) => secret.name),
    },
    outbound: {
      accountIdBindingVerified: true,
      secretBindingNames: outbound.secretBindingNames,
      secretNames: outboundSecrets.map((secret) => secret.name),
    },
    checks: [
      "namespace-untrusted",
      "namespace-stable",
      "dispatcher-binding-exact",
      "outbound-service-exact",
      "outbound-account-id-exact",
      "outbound-secret-present",
      "dispatcher-outbound-secret-absent",
      "deploy-readback-secrets-absent",
    ],
  };
  assertCredentialAbsent(evidence, options.apiToken);
  return evidence;
}

function buildUrls(options) {
  const accountBase = `${cloudflareApiBase}/accounts/${encodeURIComponent(options.accountId)}`;
  const workerBase = `${accountBase}/workers/scripts`;
  return {
    namespace: `${accountBase}/workers/dispatch/namespaces/${encodeURIComponent(options.namespace)}`,
    dispatcherSettings: `${workerBase}/${encodeURIComponent(options.dispatcherScript)}/settings`,
    dispatcherSecrets: `${workerBase}/${encodeURIComponent(options.dispatcherScript)}/secrets`,
    outboundSettings: `${workerBase}/${encodeURIComponent(options.outboundScript)}/settings`,
    outboundSecrets: `${workerBase}/${encodeURIComponent(options.outboundScript)}/secrets`,
  };
}

async function fetchJson(
  url,
  label,
  apiToken,
  fetchImpl,
  expectedResult,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiToken}`,
      },
      redirect: "manual",
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timeout);
    throw new Error(`[${label}] request failed`);
  }

  try {
    if (
      response.redirected ||
      response.url !== url ||
      (response.status >= 300 && response.status < 400)
    ) {
      throw new Error(`[${label}] redirects are forbidden`);
    }
    if (
      !Number.isInteger(response.status) ||
      response.status < 200 ||
      response.status >= 300
    ) {
      throw new Error(`[${label}] Cloudflare returned a non-2xx status`);
    }
    const contentType = response.headers.get("content-type") || "";
    if (!isJsonContentType(contentType)) {
      throw new Error(`[${label}] expected an application/json response`);
    }
    const declaredLength = response.headers.get("content-length");
    if (
      declaredLength != null &&
      (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxJsonBytes)
    ) {
      throw new Error(`[${label}] response exceeded the byte limit`);
    }
    const bytes = await readBoundedBody(response.body, maxJsonBytes, label);
    if (bytes.length === 0) throw new Error(`[${label}] response body was empty`);
    let value;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error(`[${label}] response was not valid JSON`);
    }
    return requireCloudflareEnvelope(value, label, expectedResult);
  } finally {
    clearTimeout(timeout);
  }
}

async function readBoundedBody(body, limit, label) {
  if (!body || typeof body.getReader !== "function") {
    throw new Error(`[${label}] response body was unavailable`);
  }
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new Error(`[${label}] malformed body stream`);
      }
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw new Error(`[${label}] response exceeded the byte limit`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function requireCloudflareEnvelope(value, label, expectedResult) {
  const envelope = requireObject(value, `[${label}] envelope`);
  if (envelope.success !== true) {
    throw new Error(`[${label}] envelope did not report success=true`);
  }
  if (!Array.isArray(envelope.errors) || envelope.errors.length !== 0) {
    throw new Error(`[${label}] envelope contained errors`);
  }
  if (!Array.isArray(envelope.messages)) {
    throw new Error(`[${label}] envelope messages must be an array`);
  }
  if (expectedResult === "array") {
    if (!Array.isArray(envelope.result)) {
      throw new Error(`[${label}] result must be an array`);
    }
  } else {
    requireObject(envelope.result, `[${label}] result`);
  }
  return envelope;
}

function validateNamespace(envelope, expected, label) {
  const result = requireObject(envelope.result, `[${label}] result`);
  if (result.namespace_name !== expected.namespace) {
    throw new Error(`[identity] ${label} returned the wrong namespace`);
  }
  const namespaceId = requireSingleLine(
    result.namespace_id,
    `[${label}] namespace_id`,
  );
  if (namespaceId.length > 64) {
    throw new Error(`[${label}] namespace_id was too long`);
  }
  if (!Number.isInteger(result.script_count) || result.script_count < 0) {
    throw new Error(`[${label}] script_count must be a nonnegative integer`);
  }
  if (result.trusted_workers !== false) {
    throw new Error(`[security] ${label} namespace must remain untrusted`);
  }
  return {
    namespaceId,
    namespaceName: result.namespace_name,
    scriptCount: result.script_count,
    trustedWorkers: false,
    modifiedOn: optionalTimestamp(result.modified_on, `[${label}] modified_on`),
  };
}

function validateDispatcherSettings(envelope, expected) {
  const bindings = requireBindings(envelope.result, "dispatcher-settings");
  const matches = bindings.filter(
    (binding) => binding && binding.name === expected.dispatcherBinding,
  );
  if (matches.length !== 1) {
    throw new Error(
      "[dispatcher] expected exactly one named dispatch namespace binding",
    );
  }
  const binding = requireObject(matches[0], "[dispatcher] binding");
  if (
    binding.type !== "dispatch_namespace" ||
    binding.namespace !== expected.namespace
  ) {
    throw new Error(
      "[dispatcher] binding type or namespace did not match the expected attachment",
    );
  }
  const outbound = requireObject(binding.outbound, "[dispatcher] outbound");
  const worker = requireObject(outbound.worker, "[dispatcher] outbound.worker");
  if (worker.service !== expected.outboundScript) {
    throw new Error("[dispatcher] outbound service did not match");
  }
  if (worker.entrypoint != null || worker.environment != null) {
    throw new Error(
      "[dispatcher] outbound worker must not override entrypoint or environment",
    );
  }
  const params = outbound.params ?? [];
  if (!Array.isArray(params) || params.length !== 0) {
    throw new Error("[dispatcher] outbound parameters must remain empty");
  }
  return {
    name: binding.name,
    type: binding.type,
    namespace: binding.namespace,
    outboundService: worker.service,
    outboundParameters: [],
  };
}

function validateOutboundSettings(envelope, expected) {
  const bindings = requireBindings(envelope.result, "outbound-settings");
  const accountBindings = bindings.filter(
    (binding) => binding && binding.name === accountBindingName,
  );
  if (accountBindings.length !== 1) {
    throw new Error("[outbound] expected exactly one account-id binding");
  }
  const accountBinding = requireObject(
    accountBindings[0],
    "[outbound] account-id binding",
  );
  if (
    accountBinding.type !== "plain_text" ||
    accountBinding.text !== expected.accountId
  ) {
    throw new Error("[outbound] account-id binding did not match");
  }

  const secretBindings = bindings
    .filter((binding) => binding && binding.type === "secret_text")
    .map((binding) =>
      requireBindingName(binding.name, "outbound secret binding"),
    )
    .sort();
  if (new Set(secretBindings).size !== secretBindings.length) {
    throw new Error("[outbound] secret bindings contained duplicates");
  }
  if (!secretBindings.includes(expectedOutboundSecret)) {
    throw new Error("[outbound] expected AI token secret binding was absent");
  }
  rejectForbiddenPlatformSecrets(secretBindings, "outbound");
  return { secretBindingNames: secretBindings };
}

function validateSecretInventory(envelope, owner) {
  const result = envelope.result;
  const secrets = result.map((entry, index) => {
    const secret = requireObject(entry, `[${owner}-secrets] result[${index}]`);
    const name = requireBindingName(secret.name, `${owner} secret name`);
    if (secret.type !== "secret_text" && secret.type !== "secret_key") {
      throw new Error(`[${owner}] secret inventory contained an invalid type`);
    }
    return { name, type: secret.type };
  });
  secrets.sort((left, right) => left.name.localeCompare(right.name));
  if (new Set(secrets.map((secret) => secret.name)).size !== secrets.length) {
    throw new Error(`[${owner}] secret inventory contained duplicates`);
  }
  return secrets;
}

function validateSecretOwnership(dispatcherSecrets, outboundSecrets, outbound) {
  const dispatcherNames = dispatcherSecrets.map((secret) => secret.name);
  const outboundNames = outboundSecrets.map((secret) => secret.name);
  if (dispatcherNames.includes(expectedOutboundSecret)) {
    throw new Error("[security] dispatcher owns the outbound AI token");
  }
  rejectForbiddenPlatformSecrets(dispatcherNames, "dispatcher");
  rejectForbiddenPlatformSecrets(outboundNames, "outbound");
  if (!outboundNames.includes(expectedOutboundSecret)) {
    throw new Error("[security] outbound secret inventory omitted the AI token");
  }
  const inventoryToken = outboundSecrets.find(
    (secret) => secret.name === expectedOutboundSecret,
  );
  if (inventoryToken.type !== "secret_text") {
    throw new Error("[security] outbound AI token must be a secret_text binding");
  }
  if (!outbound.secretBindingNames.includes(expectedOutboundSecret)) {
    throw new Error("[security] outbound settings omitted the AI token");
  }
  for (const name of outboundNames) {
    if (!outbound.secretBindingNames.includes(name)) {
      throw new Error(
        "[security] outbound secret inventory and settings did not match",
      );
    }
  }
}

function rejectForbiddenPlatformSecrets(names, owner) {
  const forbidden = new Set([
    "CF_API_TOKEN",
    "CLOUDFLARE_API_TOKEN",
    "CINATOKEN_WFP_READBACK_TOKEN",
    "WFP_TENANT_CF_API_TOKEN",
  ]);
  if (owner === "outbound") forbidden.add("CLOUDFLARE_AI_GATEWAY_TOKEN");
  const found = names.find((name) => forbidden.has(name));
  if (found) {
    throw new Error(`[security] ${owner} owns forbidden deploy/readback bearer`);
  }
}

function requireBindings(result, label) {
  const settings = requireObject(result, `[${label}] result`);
  if (!Array.isArray(settings.bindings)) {
    throw new Error(`[${label}] bindings must be an array`);
  }
  return settings.bindings;
}

function normalizeEvidenceIdentity(identity) {
  return {
    accountId: redactAccountId(identity.accountId),
    namespace: identity.namespace,
    dispatcherScript: identity.dispatcherScript,
    outboundScript: identity.outboundScript,
    dispatcherBinding: identity.dispatcherBinding,
  };
}

function assertCredentialAbsent(value, apiToken) {
  const serialized = JSON.stringify(value);
  const encoded = Buffer.from(apiToken, "utf8").toString("base64");
  if (serialized.includes(apiToken) || serialized.includes(encoded)) {
    throw new Error(
      "[redaction] collector credential appeared in output evidence",
    );
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireAccountId(value) {
  if (typeof value !== "string" || !/^[A-Fa-f0-9]{32}$/.test(value)) {
    throw new Error(
      "[input] account-id must be a 32-character account identifier",
    );
  }
  return value;
}

function requireNamespace(value) {
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !/^[a-z0-9_-]+$/.test(value)
  ) {
    throw new Error("[input] namespace must be a valid dispatch namespace");
  }
  return value;
}

function requireWorkerName(value, label) {
  if (
    typeof value !== "string" ||
    value.length > 63 ||
    !/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/.test(value)
  ) {
    throw new Error(`[input] ${label} must be a valid Worker name`);
  }
  return value;
}

function requireBindingName(value, label) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
  ) {
    throw new Error(`[input] ${label} must be a valid binding name`);
  }
  return value;
}

function requireSingleLine(value, label) {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    /[\r\n\0]/.test(value)
  ) {
    throw new Error(`${label} must be a nonempty single-line string`);
  }
  return value;
}

function optionalTimestamp(value, label) {
  if (value == null) return null;
  const text = requireSingleLine(value, label);
  if (Number.isNaN(Date.parse(text))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return text;
}

function requireTimestamp(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("[collector] clock returned an invalid timestamp");
  }
  return value.toISOString();
}

function isJsonContentType(value) {
  return /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|$)/i.test(value);
}

function stableJson(value) {
  return JSON.stringify(value);
}

function redactAccountId(value) {
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

async function runSelfTest() {
  const cases = [];
  const fixture = selfTestFixture();
  const valid = await collectReadback(fixture.options, {
    fetchImpl: queueFetch(fixture.responses),
    now: () => new Date("2026-07-12T00:00:00.000Z"),
  });
  if (
    valid.verified !== true ||
    valid.dispatcher.binding.outboundService !== fixture.options.outboundScript ||
    valid.outbound.secretNames[0] !== expectedOutboundSecret ||
    JSON.stringify(valid).includes(fixture.options.accountId) ||
    JSON.stringify(valid).includes(fixture.options.apiToken) ||
    JSON.stringify(valid).includes(fixture.secretValue)
  ) {
    throw new Error("[self-test] valid evidence was not normalized and redacted");
  }
  cases.push({ name: "valid-redacted-evidence", passed: true });

  const dryRun = buildDryRun(fixture.options);
  if (
    dryRun.networkRequests !== false ||
    dryRun.credentialsRead !== false ||
    dryRun.writesFiles !== false ||
    JSON.stringify(dryRun).includes(fixture.options.accountId)
  ) {
    throw new Error("[self-test] dry run was not credential-free and redacted");
  }
  cases.push({ name: "credential-free-dry-run", passed: true });

  await expectFailure("trusted-namespace", fixture, (responses) => {
    responses[0].value.result.trusted_workers = true;
  }, /must remain untrusted/, cases);
  await expectFailure("namespace-drift", fixture, (responses) => {
    responses[5].value.result.script_count += 1;
  }, /namespace changed/, cases);
  await expectFailure("missing-dispatch-binding", fixture, (responses) => {
    responses[1].value.result.bindings = [];
  }, /exactly one named/, cases);
  await expectFailure("wrong-dispatch-namespace", fixture, (responses) => {
    responses[1].value.result.bindings[0].namespace = "wrong-namespace";
  }, /type or namespace/, cases);
  await expectFailure("wrong-outbound-service", fixture, (responses) => {
    responses[1].value.result.bindings[0].outbound.worker.service = "wrong-service";
  }, /outbound service/, cases);
  await expectFailure("outbound-parameters", fixture, (responses) => {
    responses[1].value.result.bindings[0].outbound.params = [{ name: "tenant" }];
  }, /parameters must remain empty/, cases);
  await expectFailure("dispatcher-owns-outbound-token", fixture, (responses) => {
    responses[2].value.result.push({
      name: expectedOutboundSecret,
      type: "secret_text",
    });
  }, /dispatcher owns the outbound/, cases);
  await expectFailure("missing-account-binding", fixture, (responses) => {
    responses[3].value.result.bindings.shift();
  }, /exactly one account-id/, cases);
  await expectFailure("wrong-account-binding", fixture, (responses) => {
    responses[3].value.result.bindings[0].text = "f".repeat(32);
  }, /account-id binding did not match/, cases);
  await expectFailure("missing-secret-binding", fixture, (responses) => {
    responses[3].value.result.bindings.pop();
  }, /expected AI token secret binding/, cases);
  await expectFailure("missing-secret-inventory", fixture, (responses) => {
    responses[4].value.result = [];
  }, /inventory omitted the AI token/, cases);
  await expectFailure("forbidden-deploy-bearer", fixture, (responses) => {
    responses[4].value.result.push({
      name: "CLOUDFLARE_API_TOKEN",
      type: "secret_text",
    });
  }, /forbidden deploy\/readback bearer/, cases);
  await expectFailure("redirect", fixture, (responses) => {
    responses[0] = rawResponse("", { status: 302, contentType: "text/plain" });
  }, /redirects are forbidden/, cases);
  await expectFailure("non-2xx", fixture, (responses) => {
    responses[1] = rawResponse("denied", { status: 403, contentType: "text/plain" });
  }, /non-2xx/, cases);
  await expectFailure("malformed-envelope", fixture, (responses) => {
    responses[1].value = { success: true, errors: [], messages: [] };
  }, /result.*object/, cases);
  await expectFailure("declared-size-limit", fixture, (responses) => {
    responses[1].contentLength = maxJsonBytes + 1;
  }, /byte limit/, cases);
  await expectFailure("streamed-size-limit", fixture, (responses) => {
    responses[1] = rawResponse(Buffer.alloc(maxJsonBytes + 1, 1), {
      status: 200,
      contentType: "application/json",
    });
  }, /byte limit/, cases);
  await expectFailure("non-json-response", fixture, (responses) => {
    responses[1].contentType = "text/plain";
  }, /expected an application\/json/, cases);

  const credentialEcho = selfTestFixture();
  credentialEcho.options.dispatcherScript = credentialEcho.options.apiToken;
  try {
    await collectReadback(credentialEcho.options, {
      fetchImpl: queueFetch(credentialEcho.responses),
    });
  } catch (error) {
    if (!/collector credential appeared/.test(String(error))) throw error;
    cases.push({ name: "credential-echo", passed: true });
  }
  if (!cases.some((item) => item.name === "credential-echo")) {
    throw new Error("[self-test] credential echo unexpectedly passed");
  }

  return { ok: true, schemaVersion, cases, passed: cases.length };
}

async function expectFailure(name, fixture, mutate, expected, cases) {
  const responses = cloneResponses(fixture.responses);
  mutate(responses);
  try {
    await collectReadback(fixture.options, {
      fetchImpl: queueFetch(responses),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!expected.test(message)) {
      throw new Error(`[self-test] ${name} failed unexpectedly: ${message}`);
    }
    cases.push({ name, passed: true });
    return;
  }
  throw new Error(`[self-test] ${name} unexpectedly passed`);
}

function selfTestFixture() {
  const options = {
    accountId: "0123456789abcdef0123456789abcdef",
    namespace: "cinatoken-rust-tenants-staging",
    dispatcherScript: "cinatoken-rust-api-staging",
    outboundScript: "cinatoken-wfp-outbound",
    dispatcherBinding: "DISPATCHER",
    apiToken: "self-test-replacement-token-value",
  };
  const secretValue = "must-never-appear-in-evidence";
  const namespace = envelope({
    namespace_id: "11111111-2222-3333-4444-555555555555",
    namespace_name: options.namespace,
    script_count: 1,
    trusted_workers: false,
    modified_on: "2026-07-12T00:00:00.000Z",
  });
  const dispatcherSettings = envelope({
    bindings: [
      {
        name: options.dispatcherBinding,
        type: "dispatch_namespace",
        namespace: options.namespace,
        outbound: {
          params: [],
          worker: { service: options.outboundScript },
        },
      },
    ],
  });
  const dispatcherSecrets = envelope([
    { name: "SESSION_SECRET", type: "secret_text" },
  ]);
  const outboundSettings = envelope({
    bindings: [
      { name: accountBindingName, type: "plain_text", text: options.accountId },
      {
        name: expectedOutboundSecret,
        type: "secret_text",
        text: secretValue,
      },
    ],
  });
  const outboundSecrets = envelope([
    {
      name: expectedOutboundSecret,
      type: "secret_text",
      text: secretValue,
    },
  ]);
  return {
    options,
    secretValue,
    responses: [
      jsonResponse(namespace),
      jsonResponse(dispatcherSettings),
      jsonResponse(dispatcherSecrets),
      jsonResponse(outboundSettings),
      jsonResponse(outboundSecrets),
      jsonResponse(namespace),
    ],
  };
}

function envelope(result) {
  return { success: true, errors: [], messages: [], result };
}

function jsonResponse(value, options = {}) {
  return {
    value: structuredClone(value),
    status: options.status ?? 200,
    contentType: options.contentType ?? "application/json",
    contentLength: options.contentLength,
  };
}

function rawResponse(body, options) {
  return {
    rawBody: Buffer.isBuffer(body) ? Buffer.from(body) : Buffer.from(body, "utf8"),
    status: options.status,
    contentType: options.contentType,
    contentLength: options.contentLength,
  };
}

function cloneResponses(responses) {
  return responses.map((response) => ({
    ...response,
    value: response.value == null ? undefined : structuredClone(response.value),
    rawBody:
      response.rawBody == null ? undefined : Buffer.from(response.rawBody),
  }));
}

function queueFetch(rawResponses) {
  const responses = cloneResponses(rawResponses);
  return async (url) => {
    const response = responses.shift();
    if (!response) throw new Error("unexpected request");
    const body =
      response.rawBody ?? Buffer.from(JSON.stringify(response.value), "utf8");
    const headers = new Headers({ "content-type": response.contentType });
    if (response.contentLength != null) {
      headers.set("content-length", String(response.contentLength));
    }
    return {
      status: response.status,
      redirected: false,
      url:
        response.status >= 300 && response.status < 400
          ? `${url}/redirected`
          : url,
      headers,
      body: new Response(body).body,
    };
  };
}
