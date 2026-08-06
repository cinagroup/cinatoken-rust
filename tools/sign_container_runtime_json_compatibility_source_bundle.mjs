#!/usr/bin/env bun

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import { Buffer } from "node:buffer";
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

import { canonicalJson } from
  "./container_runtime_json_compatibility_campaign.mjs";
import {
  JSON_COMPATIBILITY_SOURCE_SIGNATURE_DOMAIN,
  buildJsonCompatibilitySourceSignatureEnvelope,
  buildJsonCompatibilitySourceVerifierPolicy,
  sourceSignatureSigningPayload,
  validateJsonCompatibilitySourceSignatureSubject,
} from "./container_runtime_json_compatibility_source_authentication.mjs";
import { readBoundedUtf8File } from "./lib/bounded_json_file.mjs";

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_PRIVATE_KEY_BYTES = 64 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const PRIVATE_KEY_PEM_HEADER = Buffer.from("-----BEGIN PRIVATE KEY-----");
const FORBIDDEN_CREDENTIAL_ENVIRONMENT = Object.freeze([
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_EMAIL",
  "CF_API_TOKEN",
  "CF_API_KEY",
  "CF_EMAIL",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "CLOUDFLARE_ACCOUNT_BINDING_COLLECTION_TOKEN",
  "CLOUDFLARE_ACCOUNT_BINDING_READBACK_TOKEN",
]);

export async function runJsonCompatibilitySourceBundleSigner({
  subjectPath,
  verifierPolicyPath,
  expectedVerifierPolicySha256,
  outputPath,
  privateKeyBytes,
}) {
  const [subjectInput, verifierPolicyInput] = await Promise.all([
    readCanonicalJson(subjectPath, "source signing subject"),
    readCanonicalJson(verifierPolicyPath, "source verifier policy"),
  ]);
  const subject = validateJsonCompatibilitySourceSignatureSubject(subjectInput);
  const verifierPolicy = validateVerifierPolicy(verifierPolicyInput);
  if (
    !SHA256.test(expectedVerifierPolicySha256)
    || verifierPolicy.sourceVerifierPolicySha256
      !== expectedVerifierPolicySha256
    || subject.sourceVerifierPolicySha256 !== expectedVerifierPolicySha256
  ) throw new Error("source verifier policy anchor does not match");

  const privateKey = parsePrivateKey(privateKeyBytes);
  const publicKey = createPublicKey(privateKey);
  const spki = Buffer.from(publicKey.export({ format: "der", type: "spki" }));
  const spkiSha256 = createHash("sha256").update(spki).digest("hex");
  const trustedKey = subject.keyId === verifierPolicy.current.keyId
    ? verifierPolicy.current
    : verifierPolicy.previous?.keyId === subject.keyId
      ? verifierPolicy.previous
      : null;
  if (trustedKey === null || trustedKey.spkiSha256 !== spkiSha256) {
    throw new Error("private key does not match the approved C4 trust slot");
  }
  if (
    Object.hasOwn(trustedKey, "acceptUntil")
    && subject.expiresAt > trustedKey.acceptUntil
  ) throw new Error("source signature exceeds the previous-key acceptance window");

  const payload = sourceSignatureSigningPayload(subject);
  const signature = sign(null, payload, privateKey);
  if (!verify(null, payload, publicKey, signature)) {
    throw new Error("source signature self-verification failed");
  }
  const envelope = buildJsonCompatibilitySourceSignatureEnvelope({
    subject,
    signerSpkiBase64url: spki.toString("base64url"),
    signatureBase64url: signature.toString("base64url"),
  });
  const envelopeSha256 = createHash("sha256")
    .update(canonicalJson(envelope), "utf8")
    .digest("hex");
  await writeCanonicalJsonExclusive(outputPath, envelope);
  return {
    schemaVersion: 1,
    mode: "offline-ed25519-source-bundle-signing",
    keyId: subject.keyId,
    signerSpkiSha256: spkiSha256,
    subjectSha256: envelope.subjectSha256,
    envelopeSha256,
    verifierPolicySha256: expectedVerifierPolicySha256,
    outputCreated: true,
    privateKeySource: "caller-supplied-bytes",
    privateKeyInputAttested: false,
    privateKeyPersistedBySigner: false,
    credentialSecretRead: false,
    networkRequestsPerformed: false,
    cloudflareMutationPerformed: false,
  };
}

export function parseJsonCompatibilitySourceBundleSignerArgs(argv) {
  if (argv.length === 1 && argv[0] === "--describe") return { describe: true };
  const values = new Map();
  const valueOptions = new Set([
    "--subject",
    "--verifier-policy",
    "--expected-verifier-policy-sha256",
    "--out",
  ]);
  let privateKeyStdin = false;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--private-key-stdin") {
      if (privateKeyStdin) throw new Error("--private-key-stdin must not repeat");
      privateKeyStdin = true;
      continue;
    }
    if (argument === "--json") {
      if (json) throw new Error("--json must not repeat");
      json = true;
      continue;
    }
    if (!valueOptions.has(argument)) throw new Error("unknown source signer option");
    if (values.has(argument)) throw new Error(`${argument} must not repeat`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    values.set(argument, value);
  }
  for (const name of valueOptions) {
    if (!values.has(name)) throw new Error(`${name} is required`);
  }
  if (!privateKeyStdin) throw new Error("--private-key-stdin is required");
  const expectedVerifierPolicySha256 = values.get(
    "--expected-verifier-policy-sha256",
  );
  if (!SHA256.test(expectedVerifierPolicySha256)) {
    throw new Error(
      "--expected-verifier-policy-sha256 must be lowercase SHA-256",
    );
  }
  return {
    json,
    privateKeyStdin,
    subjectPath: values.get("--subject"),
    verifierPolicyPath: values.get("--verifier-policy"),
    expectedVerifierPolicySha256,
    outputPath: values.get("--out"),
  };
}

function validateVerifierPolicy(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("source verifier policy is invalid");
  }
  let rebuilt;
  try {
    rebuilt = buildJsonCompatibilitySourceVerifierPolicy({
      serviceName: input.serviceName,
      profileVersion: input.profileVersion,
      keyPrefix: input.keyPrefix,
      issuer: input.issuer,
      audience: input.audience,
      externalWormArchivePolicySha256:
        input.externalWormArchivePolicySha256,
      current: input.current,
      previous: input.previous,
    });
  } catch {
    throw new Error("source verifier policy is invalid");
  }
  if (canonicalJson(rebuilt) !== canonicalJson(input)) {
    throw new Error("source verifier policy is not canonical for its contract");
  }
  return rebuilt;
}

async function readCanonicalJson(filePath, label) {
  const text = await readBoundedUtf8File(filePath, MAX_INPUT_BYTES, label);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
  if (`${canonicalJson(value)}\n` !== text) {
    throw new Error(`${label} must be canonical JSON with one trailing LF`);
  }
  return value;
}

function parsePrivateKey(input) {
  if (!(input instanceof Uint8Array) || input.byteLength < 16) {
    throw new Error("private key input is invalid");
  }
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  let key;
  let exported;
  try {
    if (bytes.subarray(0, PRIVATE_KEY_PEM_HEADER.byteLength)
      .equals(PRIVATE_KEY_PEM_HEADER)) {
      key = createPrivateKey({ key: bytes, format: "pem" });
      exported = Buffer.from(key.export({ format: "pem", type: "pkcs8" }));
      const canonicalWithoutLf = exported.at(-1) === 0x0a
        ? exported.subarray(0, exported.byteLength - 1)
        : exported;
      if (!bytes.equals(exported) && !bytes.equals(canonicalWithoutLf)) {
        throw new Error("noncanonical PEM");
      }
    } else {
      key = createPrivateKey({ key: bytes, format: "der", type: "pkcs8" });
      exported = Buffer.from(key.export({ format: "der", type: "pkcs8" }));
      if (!bytes.equals(exported)) throw new Error("noncanonical DER");
    }
  } catch {
    throw new Error(
      "private key must be one canonical Ed25519 PKCS8 DER or PEM object",
    );
  } finally {
    exported?.fill(0);
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("private key must be Ed25519");
  }
  return key;
}

async function readBoundedPrivateKeyStdin() {
  if (process.stdin.isTTY) {
    throw new Error("private key stdin must be a non-TTY stream");
  }
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > MAX_PRIVATE_KEY_BYTES) {
        bytes.fill(0);
        throw new Error("private key stdin exceeds its byte bound");
      }
      chunks.push(bytes);
      if (ArrayBuffer.isView(chunk) && typeof chunk.fill === "function") {
        chunk.fill(0);
      }
    }
    if (total === 0) throw new Error("private key stdin is empty");
    return Buffer.concat(chunks, total);
  } finally {
    for (const value of chunks) value.fill(0);
  }
}

async function writeCanonicalJsonExclusive(filePath, value) {
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  const handle = await open(
    path.resolve(filePath),
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
      | (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function describe() {
  return {
    schemaVersion: 1,
    mode: "offline-ed25519-source-bundle-signing",
    signatureDomain: JSON_COMPATIBILITY_SOURCE_SIGNATURE_DOMAIN,
    privateKeyInput: "stdin-only",
    privateKeyInArgv: false,
    privateKeyInEnvironment: false,
    forbiddenCredentialEnvironment: [...FORBIDDEN_CREDENTIAL_ENVIRONMENT],
    externalVerifierPolicyDigestRequired: true,
    previousKeyWindowBoundedBySubjectExpiry: true,
    outputMustNotExist: true,
    credentialSecretRead: false,
    networkRequestsPerformed: false,
    cloudflareMutationPerformed: false,
  };
}

function usage() {
  return [
    "Usage:",
    "  bun tools/sign_container_runtime_json_compatibility_source_bundle.mjs --describe",
    "  <secret-manager-command> | bun tools/sign_container_runtime_json_compatibility_source_bundle.mjs --subject <canonical.json> --verifier-policy <canonical.json> --expected-verifier-policy-sha256 <approved-sha256> --private-key-stdin --out <new-envelope.json> [--json]",
    "",
    "The isolated C4 signer accepts one non-TTY Ed25519 key stream, writes one create-only canonical envelope, and performs no network request.",
  ].join("\n");
}

export function assertJsonCompatibilitySourceSignerCredentialFreeEnvironment(
  environment,
) {
  if (FORBIDDEN_CREDENTIAL_ENVIRONMENT.some((name) =>
    Object.hasOwn(environment, name))) {
    throw new Error("credential environment is forbidden during C4 signing");
  }
}

async function main(argv = process.argv.slice(2)) {
  let privateKeyBytes = null;
  try {
    const options = parseJsonCompatibilitySourceBundleSignerArgs(argv);
    if (options.help) return process.stdout.write(`${usage()}\n`);
    if (options.describe) {
      return process.stdout.write(`${canonicalJson(describe())}\n`);
    }
    assertJsonCompatibilitySourceSignerCredentialFreeEnvironment(process.env);
    privateKeyBytes = await readBoundedPrivateKeyStdin();
    const result = await runJsonCompatibilitySourceBundleSigner({
      ...options,
      privateKeyBytes,
    });
    process.stdout.write(
      options.json
        ? `${JSON.stringify({
            ...result,
            privateKeySource: "stdin",
            privateKeyInputAttested: true,
          }, null, 2)}\n`
        : `Source signature envelope created: ${result.envelopeSha256}\n`,
    );
  } catch {
    process.stderr.write("Source bundle signing failed\n");
    process.exitCode = 1;
  } finally {
    privateKeyBytes?.fill(0);
  }
}

if (import.meta.main) await main();
