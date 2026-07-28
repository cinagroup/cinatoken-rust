#!/usr/bin/env node

import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SignatureV4 } from "@smithy/signature-v4";
import { XMLParser, XMLValidator } from "fast-xml-parser";

import {
  WORM_ENFORCEMENT_RECEIPT_CONTRACT,
  WORM_ENFORCEMENT_SCHEMA_VERSION,
  WormEnforcementCollectorError,
  buildEnforcementDryRunReceipt,
  collectEnforcementProbes,
  collectFinalLockReadback,
  collectPostProbeReadback,
  describeEnforcementCollector,
  normalizeFinalLockPredecessors,
  normalizeEmergencyRevokeReceipt,
  normalizeEmergencyVerifyReceipt,
  normalizePostReadbackReceipt,
  normalizeProbePredecessors,
  normalizeProbeReceipt,
  normalizePublisherRevokeReceipt,
  normalizePublisherVerifyReceipt,
  readEnforcementCredentials,
  revokePublisherEmergency,
  revokePublisher,
  verifyEmergencyRevocation,
  verifyPublisherRevocation,
} from "./lib/container_runtime_worm_enforcement.mjs";
import {
  readCanonicalReceiptFile,
} from "./lib/container_runtime_worm_receipt_file.mjs";
import {
  canonicalJson,
  normalizeWormPolicy,
  r2S3Endpoint,
} from "./lib/container_runtime_worm_staging.mjs";

const policyUrl = new URL(
  "../config/container-runtime-worm-retention-policy.json",
  import.meta.url,
);
const MAX_RECEIPT_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9._:/-]{1,256}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.mode === "describe") {
      process.stdout.write(
        `${canonicalJson(describeEnforcementCollector())}\n`,
      );
      return;
    }
    if (args.mode === "self-test") {
      process.stdout.write(`${canonicalJson(await runSelfTest())}\n`);
      return;
    }
    const policy = await loadPolicy();
    const target = await loadPhaseTarget(args, policy);
    if (!args.live) {
      process.stdout.write(
        `${canonicalJson(
          buildEnforcementDryRunReceipt(args.phase, target),
        )}\n`,
      );
      return;
    }
    requireLiveConfirmation(args);
    const credentials = readEnforcementCredentials(
      args.phase,
      process.env,
    );
    let receipt;
    if (args.phase === "probe") {
      receipt = await collectEnforcementProbes({
        target,
        credentials,
        probe: createRawS3ProbeAdapter(target, credentials),
      });
    } else if (args.phase === "revoke") {
      receipt = await revokePublisher({
        target,
        credentials,
        lifecycle: createLifecycleAdapter(),
      });
    } else if (args.phase === "verify-revocation") {
      receipt = await verifyPublisherRevocation({
        target,
        credentials,
        lifecycle: createLifecycleAdapter(),
      });
    } else if (args.phase === "object-readback") {
      const client = createS3Client(target, credentials);
      try {
        receipt = await collectPostProbeReadback({
          target,
          credentials,
          s3: {
            getObject(input, abortSignal) {
              return client.send(new GetObjectCommand(input), {
                abortSignal,
              });
            },
          },
        });
      } finally {
        client.destroy();
      }
    } else if (args.phase === "lock-readback") {
      receipt = await collectFinalLockReadback({
        target,
        credentials,
        lockApi: createLockApiAdapter(),
      });
    } else if (args.phase === "emergency-revoke") {
      receipt = await revokePublisherEmergency({
        target,
        credentials,
        incidentSha256: target.incidentSha256,
        lifecycle: createLifecycleAdapter(),
      });
    } else {
      receipt = await verifyEmergencyRevocation({
        target,
        credentials,
        lifecycle: createLifecycleAdapter(),
      });
    }
    process.stdout.write(`${canonicalJson(receipt)}\n`);
  } catch (error) {
    const message =
      error instanceof WormEnforcementCollectorError
        ? error.message
        : process.argv.includes("--self-test") && error instanceof Error
          ? `[self-test] ${error.message}`
          : "[enforcement-collector] operation failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

function parseArgs(argv) {
  if (argv.length === 0) {
    return {
      mode: "describe",
      live: false,
      phase: null,
      values: new Map(),
      flags: new Set(),
    };
  }
  const values = new Map();
  const flags = new Set();
  const knownValues = new Set([
    "account-id",
    "lock-receipt",
    "lock-revocation-receipt",
    "emergency-revoke-receipt",
    "incident-sha256",
    "object-readback-receipt",
    "phase",
    "post-readback-receipt",
    "probe-receipt",
    "publish-receipt",
    "revoke-receipt",
    "verify-revocation-receipt",
  ]);
  const phaseConfirmations = [
    "confirm-publisher-preflight",
    "confirm-overwrite-probe",
    "confirm-delete-probe",
    "confirm-publisher-revocation",
    "confirm-independent-revocation-readback",
    "confirm-post-probe-readback",
    "confirm-final-lock-readback",
    "confirm-emergency-publisher-revocation",
    "confirm-emergency-revocation-readback",
  ];
  const knownFlags = new Set([
    ...phaseConfirmations,
    "confirm-staging-target",
    "describe",
    "dry-run",
    "live",
    "self-test",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") usage(0);
    if (!argument.startsWith("--")) {
      usage(2, "[input] unexpected positional argument");
    }
    const key = argument.slice(2);
    if (knownFlags.has(key)) {
      if (flags.has(key)) {
        usage(2, `[input] ${argument} must not repeat`);
      }
      flags.add(key);
      continue;
    }
    if (!knownValues.has(key)) usage(2, "[input] unknown option");
    const value = argv[++index];
    if (!value || value.startsWith("--")) {
      usage(2, `[input] ${argument} requires a value`);
    }
    if (values.has(key)) {
      usage(2, `[input] ${argument} must not repeat`);
    }
    values.set(key, value);
  }
  const standalone = ["describe", "self-test"].filter((value) =>
    flags.has(value),
  );
  if (standalone.length > 0) {
    if (standalone.length !== 1 || flags.size !== 1 || values.size !== 0) {
      usage(2, "[input] --describe and --self-test must be standalone");
    }
    return {
      mode: standalone[0],
      live: false,
      phase: null,
      values,
      flags,
    };
  }
  if (flags.has("live") && flags.has("dry-run")) {
    usage(2, "[input] --live and --dry-run are mutually exclusive");
  }
  if (!flags.has("live") && phaseConfirmations.some((key) => flags.has(key))) {
    usage(2, "[input] live confirmations require --live");
  }
  for (const key of [
    "account-id",
    "lock-revocation-receipt",
    "object-readback-receipt",
    "phase",
    "publish-receipt",
  ]) {
    if (!values.has(key)) usage(2, `[input] --${key} is required`);
  }
  const phase = values.get("phase");
  const phases = [
    "probe",
    "revoke",
    "verify-revocation",
    "object-readback",
    "lock-readback",
    "emergency-revoke",
    "emergency-verify",
  ];
  if (!phases.includes(phase)) {
    usage(2, "[input] --phase is unsupported");
  }
  const predecessorRequirements = {
    "probe-receipt": [
      "revoke",
      "verify-revocation",
      "object-readback",
      "lock-readback",
    ],
    "revoke-receipt": [
      "verify-revocation",
      "object-readback",
      "lock-readback",
    ],
    "verify-revocation-receipt": [
      "object-readback",
      "lock-readback",
    ],
    "post-readback-receipt": ["lock-readback"],
    "lock-receipt": ["lock-readback"],
    "emergency-revoke-receipt": ["emergency-verify"],
    "incident-sha256": ["emergency-revoke"],
  };
  for (const [key, requiredPhases] of Object.entries(
    predecessorRequirements,
  )) {
    const required = requiredPhases.includes(phase);
    if (required !== values.has(key)) {
      usage(
        2,
        `[input] --${key} is ${required ? "required" : "invalid"} for ${phase}`,
      );
    }
  }
  return {
    mode: "phase",
    live: flags.has("live"),
    phase,
    values,
    flags,
  };
}

function requireLiveConfirmation(args) {
  if (!args.flags.has("confirm-staging-target")) {
    throw new WormEnforcementCollectorError(
      "[confirmation] live collection requires --confirm-staging-target",
    );
  }
  const required = {
    probe: [
      "confirm-publisher-preflight",
      "confirm-overwrite-probe",
      "confirm-delete-probe",
    ],
    revoke: ["confirm-publisher-revocation"],
    "verify-revocation": [
      "confirm-independent-revocation-readback",
    ],
    "object-readback": ["confirm-post-probe-readback"],
    "lock-readback": ["confirm-final-lock-readback"],
    "emergency-revoke": [
      "confirm-emergency-publisher-revocation",
    ],
    "emergency-verify": [
      "confirm-emergency-revocation-readback",
    ],
  }[args.phase];
  for (const flag of required) {
    if (!args.flags.has(flag)) {
      throw new WormEnforcementCollectorError(
        `[confirmation] ${args.phase} requires --${flag}`,
      );
    }
  }
  const allPhaseFlags = [
    "confirm-publisher-preflight",
    "confirm-overwrite-probe",
    "confirm-delete-probe",
    "confirm-publisher-revocation",
    "confirm-independent-revocation-readback",
    "confirm-post-probe-readback",
    "confirm-final-lock-readback",
    "confirm-emergency-publisher-revocation",
    "confirm-emergency-revocation-readback",
  ];
  const unexpected = allPhaseFlags.filter(
    (flag) => args.flags.has(flag) && !required.includes(flag),
  );
  if (unexpected.length > 0) {
    throw new WormEnforcementCollectorError(
      "[confirmation] phase received an unrelated confirmation",
    );
  }
}

async function loadPhaseTarget(args, policy) {
  const load = (key, label) =>
    readCanonicalReceiptFile(args.values.get(key), {
      label,
      maxBytes: MAX_RECEIPT_BYTES,
      errorFactory: (message) =>
        new WormEnforcementCollectorError(message),
    });
  const [publish, objectReadback, lockRevocation] = await Promise.all([
    load("publish-receipt", "publish receipt"),
    load("object-readback-receipt", "object readback receipt"),
    load("lock-revocation-receipt", "lock revocation receipt"),
  ]);
  let target = normalizeProbePredecessors({
    accountId: args.values.get("account-id"),
    policy,
    publishReceipt: publish.value,
    publishReceiptText: publish.text,
    readbackReceipt: objectReadback.value,
    readbackReceiptText: objectReadback.text,
    lockRevocationReceipt: lockRevocation.value,
    lockRevocationReceiptText: lockRevocation.text,
  });
  if (args.phase === "emergency-revoke") {
    const incidentSha256 = args.values.get("incident-sha256");
    if (!SHA256_PATTERN.test(incidentSha256)) {
      throw new WormEnforcementCollectorError(
        "[input] --incident-sha256 is malformed",
      );
    }
    return { ...target, incidentSha256 };
  }
  if (args.phase === "emergency-verify") {
    const emergencyRevoke = await load(
      "emergency-revoke-receipt",
      "emergency revoke receipt",
    );
    return normalizeEmergencyRevokeReceipt({
      target,
      receipt: emergencyRevoke.value,
      receiptText: emergencyRevoke.text,
    });
  }
  if (args.phase === "probe") return target;
  const probe = await load("probe-receipt", "probe receipt");
  target = normalizeProbeReceipt({
    target,
    receipt: probe.value,
    receiptText: probe.text,
  });
  if (args.phase === "revoke") return target;
  const revoke = await load("revoke-receipt", "revoke receipt");
  target = normalizePublisherRevokeReceipt({
    target,
    receipt: revoke.value,
    receiptText: revoke.text,
  });
  if (args.phase === "verify-revocation") return target;
  const verification = await load(
    "verify-revocation-receipt",
    "revocation verification receipt",
  );
  target = normalizePublisherVerifyReceipt({
    target,
    receipt: verification.value,
    receiptText: verification.text,
  });
  if (args.phase === "object-readback") return target;
  const [postReadback, lock] = await Promise.all([
    load("post-readback-receipt", "post-probe readback receipt"),
    load("lock-receipt", "lock receipt"),
  ]);
  target = normalizePostReadbackReceipt({
    target,
    receipt: postReadback.value,
    receiptText: postReadback.text,
  });
  return normalizeFinalLockPredecessors({
    target,
    lockReceipt: lock.value,
    lockReceiptText: lock.text,
  });
}

export function createRawS3ProbeAdapter(
  target,
  credentials,
  fetchImpl = globalThis.fetch,
) {
  const signer = new SignatureV4({
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    },
    region: "auto",
    service: "s3",
    sha256: NodeSha256,
  });
  return {
    putObject(input) {
      return sendRawS3Probe({
        target,
        signer,
        fetchImpl,
        method: "PUT",
        ...input,
      });
    },
    deleteObject(input) {
      return sendRawS3Probe({
        target,
        signer,
        fetchImpl,
        method: "DELETE",
        ...input,
      });
    },
  };
}

async function sendRawS3Probe(options) {
  const endpoint = new URL(r2S3Endpoint(options.target));
  const objectPath = options.key
    .split("/")
    .map((value) => encodeURIComponent(value))
    .join("/");
  const path =
    `/${encodeURIComponent(options.bucketName)}/${objectPath}`;
  const body = options.body || Buffer.alloc(0);
  const headers = {
    host: endpoint.host,
    "content-length": String(body.length),
    ...(options.contentType
      ? { "content-type": options.contentType }
      : {}),
    ...(options.ifNoneMatch
      ? { "if-none-match": options.ifNoneMatch }
      : {}),
  };
  const signed = await options.signer.sign({
    method: options.method,
    protocol: endpoint.protocol,
    hostname: endpoint.hostname,
    port: endpoint.port || undefined,
    path,
    query: {},
    headers,
    body,
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await options.fetchImpl(
      `${endpoint.protocol}//${endpoint.host}${path}`,
      {
        method: options.method,
        headers: signed.headers,
        body: options.method === "PUT" ? body : undefined,
        redirect: "manual",
        signal: controller.signal,
      },
    );
    if (response.status >= 300 && response.status <= 399) {
      throw new WormEnforcementCollectorError(
        "[probe] provider redirects are forbidden",
      );
    }
    const rawBody = await readBoundedBody(
      response.body,
      response.headers.get("content-length"),
    );
    const responseContentType = normalizeMediaType(
      response.headers.get("content-type"),
    );
    const parsedError = parseS3Error(rawBody);
    const correlation = selectS3RequestId(response.headers);
    if (
      parsedError.bodyRequestId !== null &&
      (correlation.source !== "x-amz-request-id" ||
        parsedError.bodyRequestId !== correlation.value)
    ) {
      throw new WormEnforcementCollectorError(
        "[probe] provider XML request ID does not match the response header",
      );
    }
    return {
      transportCompleted: true,
      timedOut: false,
      clientSideOnly: false,
      providerRejected: response.status >= 400,
      httpStatus: response.status,
      errorCode: parsedError.errorCode,
      providerRequestId: correlation.value,
      requestIdSource: correlation.source,
      responseContentType,
      responseBytes: rawBody.length,
      responseBodySha256: sha256(rawBody),
    };
  } catch (error) {
    if (error instanceof WormEnforcementCollectorError) throw error;
    if (error?.name === "AbortError") {
      throw new WormEnforcementCollectorError(
        "[probe] provider response timed out",
      );
    }
    throw new WormEnforcementCollectorError(
      "[probe] provider transport failed",
    );
  } finally {
    clearTimeout(timeout);
  }
}

function parseS3Error(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new WormEnforcementCollectorError(
      "[probe] provider response must be UTF-8",
    );
  }
  if (
    /<!DOCTYPE|<!ENTITY/i.test(text) ||
    XMLValidator.validate(text) !== true
  ) {
    throw new WormEnforcementCollectorError(
      "[probe] provider XML is unsafe or malformed",
    );
  }
  let value;
  try {
    value = new XMLParser({
      processEntities: false,
      ignoreAttributes: false,
      allowBooleanAttributes: false,
      parseTagValue: false,
      trimValues: false,
    }).parse(text);
  } catch {
    throw new WormEnforcementCollectorError(
      "[probe] provider XML could not be parsed",
    );
  }
  const error = value?.Error;
  if (
    error === null ||
    typeof error !== "object" ||
    Array.isArray(error) ||
    typeof error.Code !== "string" ||
    !PROVIDER_ID_PATTERN.test(error.Code) ||
    Object.entries(error).some(
      ([key, entry]) =>
        !["Code", "Message", "Resource", "RequestId"].includes(key) ||
        typeof entry !== "string",
    )
  ) {
    throw new WormEnforcementCollectorError(
      "[probe] provider XML error envelope drifted",
    );
  }
  return {
    errorCode: error.Code,
    bodyRequestId:
      typeof error.RequestId === "string" ? error.RequestId : null,
  };
}

function selectS3RequestId(headers) {
  for (const source of ["x-amz-request-id", "cf-ray"]) {
    const value = headers.get(source);
    if (value && PROVIDER_ID_PATTERN.test(value)) {
      return { source, value };
    }
  }
  throw new WormEnforcementCollectorError(
    "[probe] provider request ID is absent",
  );
}

function createLifecycleAdapter() {
  return {
    async verifySelf({ accountId, apiToken }) {
      const response = await requestCloudflareJson({
        url: `https://api.cloudflare.com/client/v4/accounts/${accountId}/tokens/verify`,
        apiToken,
        method: "GET",
        expectedStatus: 200,
      });
      const result = requireExactObject(
        response.value.result,
        ["id", "status", "expires_on", "not_before"],
        "[lifecycle] verification result",
      );
      return {
        ...providerResponse(response),
        credentialId: result.id,
        status: result.status,
        expiresAt: result.expires_on,
        notBefore: result.not_before,
      };
    },
    async deleteToken({ accountId, apiToken, targetTokenId }) {
      const response = await requestCloudflareJson({
        url: `https://api.cloudflare.com/client/v4/accounts/${accountId}/tokens/${encodeURIComponent(targetTokenId)}`,
        apiToken,
        method: "DELETE",
        expectedStatus: 200,
      });
      const result = requireExactObject(
        response.value.result,
        ["id"],
        "[lifecycle] deletion result",
      );
      return {
        ...providerResponse(response),
        resultId: result.id,
      };
    },
    async readToken({ accountId, apiToken, targetTokenId }) {
      const response = await requestCloudflareJson({
        url: `https://api.cloudflare.com/client/v4/accounts/${accountId}/tokens/${encodeURIComponent(targetTokenId)}`,
        apiToken,
        method: "GET",
        expectedStatus: 404,
      });
      return {
        ...providerResponse(response),
        errorCodes: response.value.errors.map((entry) => entry.code),
      };
    },
  };
}

function createLockApiAdapter() {
  const lifecycle = createLifecycleAdapter();
  return {
    verifySelf: lifecycle.verifySelf,
    async readLock({ accountId, apiToken, bucketName }) {
      const response = await requestCloudflareJson({
        url: `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucketName)}/lock`,
        apiToken,
        method: "GET",
        expectedStatus: 200,
      });
      const result = requireExactObject(
        response.value.result,
        ["rules"],
        "[lock-readback] result",
      );
      return {
        ...providerResponse(response),
        rules: result.rules,
      };
    },
  };
}

async function requestCloudflareJson(options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(options.url, {
      method: options.method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${options.apiToken}`,
        "User-Agent": "cinatoken-rust-worm-enforcement-collector/1",
      },
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status <= 399) {
      throw new WormEnforcementCollectorError(
        "[provider] redirects are forbidden",
      );
    }
    const bytes = await readBoundedBody(
      response.body,
      response.headers.get("content-length"),
    );
    if (
      normalizeMediaType(response.headers.get("content-type")) !==
      "application/json"
    ) {
      throw new WormEnforcementCollectorError(
        "[provider] response content type drifted",
      );
    }
    let text;
    let value;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      value = JSON.parse(text);
    } catch {
      throw new WormEnforcementCollectorError(
        "[provider] response is not strict JSON",
      );
    }
    validateCloudflareEnvelope(value, options.expectedStatus);
    const providerRequestId = response.headers.get("cf-ray");
    if (
      response.status !== options.expectedStatus ||
      !providerRequestId ||
      !PROVIDER_ID_PATTERN.test(providerRequestId)
    ) {
      throw new WormEnforcementCollectorError(
        "[provider] status or request ID drifted",
      );
    }
    if (
      [options.apiToken].some(
        (secret) => text.includes(secret),
      )
    ) {
      throw new WormEnforcementCollectorError(
        "[provider] response reflected sensitive input",
      );
    }
    return {
      httpStatus: response.status,
      providerRequestId,
      responseBodySha256: sha256(bytes),
      value,
    };
  } catch (error) {
    if (error instanceof WormEnforcementCollectorError) throw error;
    if (error?.name === "AbortError") {
      throw new WormEnforcementCollectorError(
        "[provider] response timed out",
      );
    }
    throw new WormEnforcementCollectorError(
      "[provider] request failed",
    );
  } finally {
    clearTimeout(timeout);
  }
}

function validateCloudflareEnvelope(value, status) {
  const envelope = requireExactObject(
    value,
    ["success", "errors", "messages", "result"],
    "[provider] envelope",
  );
  if (
    !Array.isArray(envelope.errors) ||
    !Array.isArray(envelope.messages) ||
    envelope.errors.length > 32 ||
    envelope.messages.length > 32
  ) {
    throw new WormEnforcementCollectorError(
      "[provider] envelope collections drifted",
    );
  }
  if (status === 404) {
    if (
      envelope.success !== false ||
      envelope.result !== null ||
      envelope.errors.length === 0 ||
      envelope.errors.some(
        (entry) =>
          !Number.isSafeInteger(entry?.code) ||
          typeof entry?.message !== "string" ||
          canonicalJson(Object.keys(entry).sort()) !==
            canonicalJson(["code", "message"]),
      )
    ) {
      throw new WormEnforcementCollectorError(
        "[provider] absence envelope drifted",
      );
    }
  } else if (
    envelope.success !== true ||
    envelope.errors.length !== 0 ||
    envelope.messages.length !== 0 ||
    envelope.result === null ||
    typeof envelope.result !== "object" ||
    Array.isArray(envelope.result)
  ) {
    throw new WormEnforcementCollectorError(
      "[provider] success envelope drifted",
    );
  }
}

async function readBoundedBody(body, contentLength) {
  const declared =
    contentLength === null ? null : Number.parseInt(contentLength, 10);
  if (
    contentLength !== null &&
    (!Number.isSafeInteger(declared) ||
      declared < 1 ||
      declared > MAX_RESPONSE_BYTES)
  ) {
    throw new WormEnforcementCollectorError(
      "[provider] response length is invalid",
    );
  }
  if (!body || typeof body[Symbol.asyncIterator] !== "function") {
    throw new WormEnforcementCollectorError(
      "[provider] response body is not streamable",
    );
  }
  const chunks = [];
  let bytes = 0;
  for await (const rawChunk of body) {
    const chunk =
      Buffer.isBuffer(rawChunk)
        ? rawChunk
        : rawChunk instanceof Uint8Array
          ? Buffer.from(
              rawChunk.buffer,
              rawChunk.byteOffset,
              rawChunk.byteLength,
            )
          : null;
    if (!chunk || chunk.length === 0) {
      throw new WormEnforcementCollectorError(
        "[provider] response body chunk is invalid",
      );
    }
    bytes += chunk.length;
    if (bytes > MAX_RESPONSE_BYTES) {
      throw new WormEnforcementCollectorError(
        "[provider] response exceeded its byte bound",
      );
    }
    chunks.push(chunk);
  }
  if (bytes === 0 || (declared !== null && bytes !== declared)) {
    throw new WormEnforcementCollectorError(
      "[provider] response body is empty or truncated",
    );
  }
  return Buffer.concat(chunks, bytes);
}

function createS3Client(target, credentials) {
  return new S3Client({
    region: "auto",
    endpoint: r2S3Endpoint(target),
    forcePathStyle: true,
    maxAttempts: 1,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    },
  });
}

async function loadPolicy() {
  let value;
  try {
    value = JSON.parse(await readFile(policyUrl, "utf8"));
  } catch {
    throw new WormEnforcementCollectorError(
      "[policy] unable to read the pinned WORM policy",
    );
  }
  return normalizeWormPolicy(value);
}

async function runSelfTest() {
  const policy = await loadPolicy();
  const target = selfTestTarget(policy);
  const probe = await collectEnforcementProbes({
    target,
    credentials: {
      accessKeyId: "self-test-publisher-access-key",
      secretAccessKey: "self-test-publisher-secret-key",
      credentialIdSha256: target.publisherCredentialIdSha256,
    },
    probe: selfTestProbeAdapter(),
    now: sequenceNow([
      "2026-07-27T00:05:00.000Z",
      "2026-07-27T00:05:01.000Z",
      "2026-07-27T00:05:02.000Z",
      "2026-07-27T00:05:03.000Z",
      "2026-07-27T00:05:04.000Z",
      "2026-07-27T00:05:05.000Z",
      "2026-07-27T00:05:06.000Z",
    ]),
  });
  const probeTarget = normalizeProbeReceipt({
    target,
    receipt: probe,
    receiptText: `${canonicalJson(probe)}\n`,
  });
  const lifecycle = selfTestLifecycleAdapter();
  const revoke = await revokePublisher({
    target: probeTarget,
    credentials: {
      apiToken: "self-test-lifecycle-operator-token",
      targetTokenId: target.publisherTokenId,
    },
    lifecycle,
    now: sequenceNow([
      "2026-07-27T00:06:00.000Z",
      "2026-07-27T00:06:01.000Z",
      "2026-07-27T00:06:02.000Z",
    ]),
  });
  const revokeTarget = normalizePublisherRevokeReceipt({
    target: probeTarget,
    receipt: revoke,
    receiptText: `${canonicalJson(revoke)}\n`,
  });
  const verification = await verifyPublisherRevocation({
    target: revokeTarget,
    credentials: {
      apiToken: "self-test-lifecycle-verifier-token",
      targetTokenId: target.publisherTokenId,
    },
    lifecycle,
    now: sequenceNow([
      "2026-07-27T00:07:00.000Z",
      "2026-07-27T00:07:01.000Z",
    ]),
  });
  const verifyTarget = normalizePublisherVerifyReceipt({
    target: revokeTarget,
    receipt: verification,
    receiptText: `${canonicalJson(verification)}\n`,
  });
  const objectReadback = await collectPostProbeReadback({
    target: verifyTarget,
    credentials: {
      accessKeyId: "self-test-object-verifier-key",
      secretAccessKey: "self-test-object-verifier-secret",
      credentialIdSha256:
        target.objectVerifierCredentialIdSha256,
    },
    s3: selfTestObjectAdapter(target.probeObject),
    now: () => new Date("2026-07-27T00:08:00.000Z"),
  });
  const postTarget = normalizePostReadbackReceipt({
    target: verifyTarget,
    receipt: objectReadback,
    receiptText: `${canonicalJson(objectReadback)}\n`,
  });
  const finalTarget = {
    ...postTarget,
    lockConfiguredAt: "2026-07-27T00:01:00.000Z",
    lockConfigurationRequestId: "self-test-lock-configure",
    lockSelectedRuleId: "cinatoken-s3-self-test",
    lockRules: [
      {
        id: "cinatoken-s3-self-test",
        condition: {
          type: "Age",
          maxAgeSeconds: policy.lockRetentionSeconds,
        },
        enabled: true,
        prefix: target.prefix,
      },
    ],
  };
  const lockReadback = await collectFinalLockReadback({
    target: finalTarget,
    credentials: {
      apiToken: "self-test-lock-verifier-token",
    },
    lockApi: selfTestLockAdapter(finalTarget),
    now: sequenceNow([
      "2026-07-27T00:09:00.000Z",
      "2026-07-27T00:09:01.000Z",
    ]),
  });
  const incidentSha256 = "6".repeat(64);
  const emergencyRevoke = await revokePublisherEmergency({
    target,
    credentials: {
      apiToken: "self-test-emergency-operator-token",
      targetTokenId: target.publisherTokenId,
    },
    incidentSha256,
    lifecycle,
    now: sequenceNow([
      "2026-07-27T00:10:00.000Z",
      "2026-07-27T00:10:01.000Z",
      "2026-07-27T00:10:02.000Z",
    ]),
  });
  const emergencyTarget = normalizeEmergencyRevokeReceipt({
    target,
    receipt: emergencyRevoke,
    receiptText: `${canonicalJson(emergencyRevoke)}\n`,
  });
  const emergencyVerify = await verifyEmergencyRevocation({
    target: emergencyTarget,
    credentials: {
      apiToken: "self-test-emergency-verifier-token",
      targetTokenId: target.publisherTokenId,
    },
    lifecycle,
    now: sequenceNow([
      "2026-07-27T00:11:00.000Z",
      "2026-07-27T00:11:01.000Z",
    ]),
  });
  const emergencyDecision = normalizeEmergencyVerifyReceipt({
    target: emergencyTarget,
    receipt: emergencyVerify,
    receiptText: `${canonicalJson(emergencyVerify)}\n`,
  });
  const serialized = canonicalJson([
    probe,
    revoke,
    verification,
    objectReadback,
    lockReadback,
    emergencyRevoke,
    emergencyVerify,
  ]);
  if (
    lockReadback.facts.rules.length !== 1 ||
    objectReadback.facts.finalReadback.sha256 !==
      target.probeObject.sha256 ||
    verification.facts.targetAbsenceIndependentlyObserved !== true ||
    emergencyDecision.emergencyRevocationIndependentlyVerified !==
      true ||
    emergencyDecision.positiveEvidenceEligible !== false ||
    [
      "self-test-publisher-secret-key",
      "self-test-lifecycle-operator-token",
      "self-test-lifecycle-verifier-token",
      "self-test-object-verifier-secret",
      "self-test-lock-verifier-token",
      "self-test-emergency-operator-token",
      "self-test-emergency-verifier-token",
      target.publisherTokenId,
    ].some((secret) => serialized.includes(secret)) ||
    Object.values(lockReadback.downstreamAuthority).some(Boolean)
  ) {
    throw new WormEnforcementCollectorError(
      "[self-test] enforcement invariant failed",
    );
  }
  return {
    schemaVersion: WORM_ENFORCEMENT_SCHEMA_VERSION,
    contract: WORM_ENFORCEMENT_RECEIPT_CONTRACT,
    cases: 7,
    expectations: 22,
    networkRequests: false,
    credentialsRead: false,
    writesFiles: false,
    ok: true,
    downstreamAuthority: lockReadback.downstreamAuthority,
  };
}

function selfTestTarget(policy) {
  const publisherTokenId = "a".repeat(32);
  const body = Buffer.from("self-test-provenance-evidence\n", "utf8");
  const statementSha256 = "f".repeat(64);
  const prefix = `container-runtime/s3/v1/${statementSha256}/`;
  const identities = ["a", "b", "c", "d", "e"].map((value) =>
    sha256Text(value.repeat(32)),
  );
  return {
    accountId: "0123456789abcdef0123456789abcdef",
    accountIdSha256: sha256Text(
      "0123456789abcdef0123456789abcdef",
    ),
    bucketName: "cinatoken-worm-staging",
    jurisdiction: "default",
    prefix,
    statementSha256,
    publisherTokenId,
    publisherCredentialIdSha256: identities[0],
    lockOperatorCredentialIdSha256: identities[1],
    objectVerifierCredentialIdSha256: identities[2],
    lifecycleOperatorCredentialIdSha256: identities[3],
    lifecycleVerifierCredentialIdSha256: identities[4],
    enforcementProbePolicy: policy.enforcementProbePolicy,
    lockRevocationReceiptSha256: "1".repeat(64),
    publishReceiptSha256: "2".repeat(64),
    objectReadbackReceiptSha256: "3".repeat(64),
    objectReadbackCapturedAt: "2026-07-27T00:04:00.000Z",
    lockReceiptSha256: "4".repeat(64),
    probeObject: {
      kind: "provenance-evidence-packet",
      key: `${prefix}provenance-evidence.tar.zst`,
      bytes: body.length,
      sha256: sha256(body),
      etag: '"self-test-etag"',
      contentType: "application/zstd",
      customMetadata: {
        contract:
          "cinatoken-container-runtime-worm-retention-manifest-v2",
        repositoryCommit: "a".repeat(40),
        sha256: sha256(body),
      },
    },
  };
}

function selfTestProbeAdapter() {
  const responses = [
    probeResponse(412, "PreconditionFailed", "self-test-preflight"),
    probeResponse(403, "AccessDenied", "self-test-overwrite"),
    probeResponse(403, "AccessDenied", "self-test-delete"),
  ];
  return {
    async putObject() {
      return responses.shift();
    },
    async deleteObject() {
      return responses.shift();
    },
  };
}

function probeResponse(httpStatus, errorCode, providerRequestId) {
  return {
    transportCompleted: true,
    timedOut: false,
    clientSideOnly: false,
    providerRejected: true,
    httpStatus,
    errorCode,
    providerRequestId,
    requestIdSource: "cf-ray",
    responseContentType: "application/xml",
    responseBytes: 64,
    responseBodySha256: sha256Text(providerRequestId),
  };
}

function selfTestLifecycleAdapter() {
  let verifyCalls = 0;
  return {
    async verifySelf({ role }) {
      verifyCalls += 1;
      const credentialId =
        role === "lifecycle-operator"
          ? "d".repeat(32)
          : "e".repeat(32);
      return {
        httpStatus: 200,
        providerRequestId: `self-test-lifecycle-${verifyCalls}`,
        responseBodySha256: sha256Text(`verify-${verifyCalls}`),
        credentialId,
        status: "active",
        expiresAt: "2026-07-27T00:30:00.000Z",
        notBefore: "2026-07-27T00:00:00.000Z",
      };
    },
    async deleteToken({ targetTokenId }) {
      return {
        httpStatus: 200,
        providerRequestId: "self-test-publisher-delete",
        responseBodySha256: sha256Text("publisher-delete"),
        resultId: targetTokenId,
      };
    },
    async readToken({ role }) {
      return {
        httpStatus: 404,
        providerRequestId:
          role === "lifecycle-operator"
            ? "self-test-operator-readback"
            : "self-test-independent-readback",
        responseBodySha256: sha256Text(`absence-${role}`),
        errorCodes: [1000],
      };
    },
  };
}

function selfTestObjectAdapter(object) {
  const body = Buffer.from("self-test-provenance-evidence\n", "utf8");
  return {
    async getObject() {
      return {
        $metadata: {
          httpStatusCode: 200,
          requestId: "self-test-post-readback",
        },
        ContentLength: body.length,
        ETag: object.etag,
        ContentType: object.contentType,
        Metadata: {
          contract: object.customMetadata.contract,
          repositorycommit:
            object.customMetadata.repositoryCommit,
          sha256: object.sha256,
        },
        Body: Readable.from([body]),
      };
    },
  };
}

function selfTestLockAdapter(target) {
  return {
    async verifySelf() {
      return {
        httpStatus: 200,
        providerRequestId: "self-test-lock-verifier",
        responseBodySha256: sha256Text("lock-verifier"),
        credentialId: "f".repeat(32),
        status: "active",
        expiresAt: "2026-07-27T00:30:00.000Z",
        notBefore: "2026-07-27T00:00:00.000Z",
      };
    },
    async readLock() {
      return {
        httpStatus: 200,
        providerRequestId: "self-test-final-lock",
        responseBodySha256: sha256Text("final-lock"),
        rules: structuredClone(target.lockRules),
      };
    },
  };
}

function requireExactObject(value, keys, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    canonicalJson(Object.keys(value).sort()) !==
      canonicalJson([...keys].sort())
  ) {
    throw new WormEnforcementCollectorError(`${label} fields drifted`);
  }
  return value;
}

function providerResponse(value) {
  return {
    httpStatus: value.httpStatus,
    providerRequestId: value.providerRequestId,
    responseBodySha256: value.responseBodySha256,
  };
}

function normalizeMediaType(value) {
  if (typeof value !== "string") return null;
  const mediaType = value.split(";", 1)[0].trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType)
    ? mediaType
    : null;
}

function sequenceNow(values) {
  let index = 0;
  return () => new Date(values[index++]);
}

class NodeSha256 {
  constructor(secret) {
    this.hash = secret
      ? createHmac("sha256", secret)
      : createHash("sha256");
  }

  update(value) {
    this.hash.update(value);
  }

  async digest() {
    return this.hash.digest();
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Text(value) {
  return sha256(Buffer.from(value, "utf8"));
}

function usage(exitCode, message = null) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write(
    "Usage: node tools/collect_container_runtime_worm_enforcement.mjs --phase <probe|revoke|verify-revocation|object-readback|lock-readback|emergency-revoke|emergency-verify> --account-id <id> --publish-receipt <file> --object-readback-receipt <file> --lock-revocation-receipt <file> [phase predecessor files] [--dry-run|--live confirmations]\n",
  );
  process.exit(exitCode);
}
