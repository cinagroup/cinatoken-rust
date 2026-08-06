#!/usr/bin/env bun

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";
import { Buffer } from "node:buffer";
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

import {
  JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_RECEIPT_SUBJECT_CONTRACT,
  JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_REVOCATION_SUBJECT_CONTRACT,
  JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_SIGNATURE_DOMAIN,
  accountBindingCredentialSigningPayload,
  buildJsonCompatibilityAccountBindingCredentialReceiptEnvelope,
  buildJsonCompatibilityAccountBindingCredentialRevocationEnvelope,
  validateJsonCompatibilityAccountBindingCredentialReceiptSubject,
  validateJsonCompatibilityAccountBindingCredentialRevocationSubject,
  validateJsonCompatibilityAccountBindingCredentialTrustPolicy,
} from "./container_runtime_json_compatibility_account_binding_credentials.mjs";
import {
  canonicalJson,
} from "./container_runtime_json_compatibility_campaign.mjs";
import {
  verifyJsonCompatibilityAccountBindingCredentialEnvelope,
} from "./lib/container_runtime_json_compatibility_account_binding_credentials.mjs";
import {
  readBoundedUtf8File,
} from "./lib/bounded_json_file.mjs";

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
  "CLOUDFLARE_ACCOUNT_BINDING_COLLECTION_TOKEN",
  "CLOUDFLARE_ACCOUNT_BINDING_READBACK_TOKEN",
]);

export async function runJsonCompatibilityAccountBindingCredentialSigner({
  subjectPath,
  trustPolicyPath,
  expectedTrustPolicySha256,
  outputPath,
  privateKeyBytes,
}) {
  const [subjectInput, trustPolicyInput] = await Promise.all([
    readCanonicalJson(subjectPath, "credential signing subject"),
    readCanonicalJson(trustPolicyPath, "credential trust policy"),
  ]);
  const trustPolicy =
    validateJsonCompatibilityAccountBindingCredentialTrustPolicy(
      trustPolicyInput,
    );
  if (
    !SHA256.test(expectedTrustPolicySha256)
    || trustPolicy.credentialTrustPolicySha256
      !== expectedTrustPolicySha256
  ) throw new Error("credential trust policy anchor does not match");
  let kind;
  let subject;
  if (subjectInput.contract ===
    JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_RECEIPT_SUBJECT_CONTRACT) {
    kind = "receipt";
    subject =
      validateJsonCompatibilityAccountBindingCredentialReceiptSubject(
        subjectInput,
      );
  } else if (subjectInput.contract ===
    JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_REVOCATION_SUBJECT_CONTRACT) {
    kind = "revocation";
    subject =
      validateJsonCompatibilityAccountBindingCredentialRevocationSubject(
        subjectInput,
      );
  } else {
    throw new Error("credential signing subject contract is invalid");
  }
  const privateKey = parsePrivateKey(privateKeyBytes);
  const publicKey = createPublicKey(privateKey);
  const spki = publicKey.export({ format: "der", type: "spki" });
  const trustedKey = subject.keyId === trustPolicy.current.keyId
    ? trustPolicy.current
    : trustPolicy.previous?.keyId === subject.keyId
      ? trustPolicy.previous
      : null;
  if (
    trustedKey === null
    || createHash("sha256").update(spki).digest("hex")
      !== trustedKey.spkiSha256
    || Buffer.from(spki).toString("base64url") !== trustedKey.spkiBase64url
  ) throw new Error("private key does not match the approved trust slot");
  if (kind === "revocation" && subject.keyId !== trustPolicy.current.keyId) {
    throw new Error("revocation must use the current trust key");
  }
  const signatureBase64url = sign(
    null,
    accountBindingCredentialSigningPayload(subject),
    privateKey,
  ).toString("base64url");
  const envelope = kind === "receipt"
    ? buildJsonCompatibilityAccountBindingCredentialReceiptEnvelope({
        subject,
        signatureBase64url,
      })
    : buildJsonCompatibilityAccountBindingCredentialRevocationEnvelope({
        subject,
        signatureBase64url,
      });
  verifyJsonCompatibilityAccountBindingCredentialEnvelope({
    trustPolicy,
    envelope,
    kind,
    now: kind === "receipt" ? subject.createdAt : subject.issuedAt,
    expectedTrustPolicySha256,
  });
  await writeCanonicalJsonExclusive(outputPath, envelope);
  return {
    schemaVersion: 1,
    mode: "offline-ed25519-account-binding-credential-signing",
    kind,
    keyId: subject.keyId,
    subjectSha256: envelope.subjectSha256,
    envelopeSha256: kind === "receipt"
      ? envelope.credentialReceiptEnvelopeSha256
      : envelope.credentialRevocationEnvelopeSha256,
    outputCreated: true,
    privateKeySource: "caller-supplied-bytes",
    privateKeyInputAttested: false,
    privateKeyPersistedBySigner: false,
    credentialSecretRead: false,
    networkRequestsPerformed: false,
    cloudflareMutationPerformed: false,
  };
}

export function parseJsonCompatibilityAccountBindingCredentialSignerArgs(argv) {
  if (argv.length === 1 && argv[0] === "--describe") return { describe: true };
  const values = new Map();
  const valueOptions = new Set([
    "--subject",
    "--trust-policy",
    "--expected-trust-policy-sha256",
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
    if (!valueOptions.has(argument)) throw new Error("unknown signer option");
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
  const expectedTrustPolicySha256 = values.get(
    "--expected-trust-policy-sha256",
  );
  if (!SHA256.test(expectedTrustPolicySha256)) {
    throw new Error("--expected-trust-policy-sha256 must be lowercase SHA-256");
  }
  return {
    json,
    privateKeyStdin,
    subjectPath: values.get("--subject"),
    trustPolicyPath: values.get("--trust-policy"),
    expectedTrustPolicySha256,
    outputPath: values.get("--out"),
  };
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
    if (
      bytes.subarray(0, PRIVATE_KEY_PEM_HEADER.byteLength)
        .equals(PRIVATE_KEY_PEM_HEADER)
    ) {
      key = createPrivateKey({ key: bytes, format: "pem" });
      exported = Buffer.from(key.export({ format: "pem", type: "pkcs8" }));
      const canonicalWithoutLf = exported[exported.byteLength - 1] === 0x0a
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
    throw new Error("private key must be one canonical Ed25519 PKCS8 DER or PEM object");
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
      try {
        total += bytes.byteLength;
        if (total > MAX_PRIVATE_KEY_BYTES) {
          throw new Error("private key stdin exceeds its byte bound");
        }
        chunks.push(bytes);
      } catch (error) {
        bytes.fill(0);
        throw error;
      } finally {
        if (ArrayBuffer.isView(chunk) && typeof chunk.fill === "function") {
          chunk.fill(0);
        }
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
    mode: "offline-ed25519-account-binding-credential-signing",
    supportedSubjectContracts: [
      JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_RECEIPT_SUBJECT_CONTRACT,
      JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_REVOCATION_SUBJECT_CONTRACT,
    ],
    signatureDomain:
      JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_SIGNATURE_DOMAIN,
    privateKeyInput: "stdin-only",
    privateKeyInArgv: false,
    privateKeyInEnvironment: false,
    forbiddenCredentialEnvironment:
      [...FORBIDDEN_CREDENTIAL_ENVIRONMENT],
    externalTrustPolicyDigestRequired: true,
    credentialSecretRead: false,
    outputMustNotExist: true,
    networkRequestsPerformed: false,
    cloudflareMutationPerformed: false,
  };
}

function usage() {
  return [
    "Usage:",
    "  bun tools/sign_container_runtime_json_compatibility_account_binding_credential.mjs --describe",
    "  <secret-manager-command> | bun tools/sign_container_runtime_json_compatibility_account_binding_credential.mjs --subject <canonical.json> --trust-policy <canonical.json> --expected-trust-policy-sha256 <approved-sha256> --private-key-stdin --out <new-envelope.json> [--json]",
    "",
    "The signer accepts only a non-TTY Ed25519 private key stream, writes one create-only canonical envelope, and performs no network request.",
  ].join("\n");
}

function assertCredentialFreeEnvironment(environment) {
  if (FORBIDDEN_CREDENTIAL_ENVIRONMENT.some((name) =>
    Object.hasOwn(environment, name))) {
    throw new Error("credential environment is forbidden during signing");
  }
}

async function main(argv = process.argv.slice(2)) {
  let privateKeyBytes = null;
  let options;
  try {
    options = parseJsonCompatibilityAccountBindingCredentialSignerArgs(argv);
    if (options.help) return process.stdout.write(`${usage()}\n`);
    if (options.describe) {
      return process.stdout.write(`${canonicalJson(describe())}\n`);
    }
    assertCredentialFreeEnvironment(process.env);
    privateKeyBytes = await readBoundedPrivateKeyStdin();
    const coreResult = await runJsonCompatibilityAccountBindingCredentialSigner({
      ...options,
      privateKeyBytes,
    });
    const result = {
      ...coreResult,
      privateKeySource: "stdin",
      privateKeyInputAttested: true,
    };
    process.stdout.write(
      options.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : `Credential provenance envelope created: ${result.envelopeSha256}\n`,
    );
  } catch (error) {
    process.stderr.write("Account binding credential signing failed\n");
    process.exitCode = 1;
  } finally {
    privateKeyBytes?.fill(0);
  }
}

if (import.meta.main) await main();
