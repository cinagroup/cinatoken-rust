#!/usr/bin/env bun

import { Buffer } from "node:buffer";
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

import { canonicalJson } from
  "./container_runtime_json_compatibility_campaign.mjs";
import {
  buildJsonCompatibilitySourceSignatureSubjectFromIntent,
} from "./container_runtime_json_compatibility_source_authentication.mjs";
import { readBoundedUtf8File } from "./lib/bounded_json_file.mjs";

const MAX_INPUT_BYTES = 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
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

export async function assembleJsonCompatibilitySourceSignatureSubject({
  intentPath,
  expectedIntentSha256,
  expectedVerifierPolicySha256,
  expectedVerifierIdentitySha256,
  outputPath,
}) {
  const intent = await readCanonicalJson(intentPath, "source signing intent");
  if (intent.sourceSigningIntentSha256 !== expectedIntentSha256) {
    throw new Error("source signing intent anchor does not match");
  }
  const subject = buildJsonCompatibilitySourceSignatureSubjectFromIntent(
    intent,
  );
  if (subject.sourceVerifierPolicySha256 !== expectedVerifierPolicySha256) {
    throw new Error("source verifier policy anchor does not match");
  }
  if (subject.sourceVerifierIdentitySha256 !== expectedVerifierIdentitySha256) {
    throw new Error("source verifier identity anchor does not match");
  }
  await writeCanonicalJsonExclusive(outputPath, subject);
  return {
    schemaVersion: 1,
    mode: "credential-free-source-signature-subject-assembly",
    sourceSigningIntentSha256: intent.sourceSigningIntentSha256,
    sourceSignatureSubjectSha256: intent.sourceSignatureSubjectSha256,
    verifierPolicySha256: subject.sourceVerifierPolicySha256,
    verifierIdentitySha256: subject.sourceVerifierIdentitySha256,
    outputCreated: true,
    placeholderDigestInputAccepted: false,
    credentialSecretRead: false,
    networkRequestsPerformed: false,
    cloudflareMutationPerformed: false,
  };
}

export function parseJsonCompatibilitySourceSignatureSubjectAssemblerArgs(
  argv,
) {
  if (argv.length === 1 && argv[0] === "--describe") return { describe: true };
  const values = new Map();
  const valueOptions = new Set([
    "--intent",
    "--expected-intent-sha256",
    "--expected-verifier-policy-sha256",
    "--expected-verifier-identity-sha256",
    "--out",
  ]);
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--json") {
      if (json) throw new Error("--json must not repeat");
      json = true;
      continue;
    }
    if (!valueOptions.has(argument)) {
      throw new Error("unknown source subject assembler option");
    }
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
  for (const name of [
    "--expected-intent-sha256",
    "--expected-verifier-policy-sha256",
    "--expected-verifier-identity-sha256",
  ]) {
    if (!SHA256.test(values.get(name))) {
      throw new Error(`${name} must be lowercase SHA-256`);
    }
  }
  return {
    json,
    intentPath: values.get("--intent"),
    expectedIntentSha256: values.get("--expected-intent-sha256"),
    expectedVerifierPolicySha256: values.get(
      "--expected-verifier-policy-sha256",
    ),
    expectedVerifierIdentitySha256: values.get(
      "--expected-verifier-identity-sha256",
    ),
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
    mode: "credential-free-source-signature-subject-assembly",
    canonicalIntentRequired: true,
    externalIntentDigestRequired: true,
    externalVerifierPolicyDigestRequired: true,
    externalVerifierIdentityDigestRequired: true,
    placeholderDigestInputAccepted: false,
    outputMustNotExist: true,
    forbiddenCredentialEnvironment: [...FORBIDDEN_CREDENTIAL_ENVIRONMENT],
    credentialSecretRead: false,
    networkRequestsPerformed: false,
    cloudflareMutationPerformed: false,
  };
}

function usage() {
  return [
    "Usage:",
    "  bun tools/assemble_container_runtime_json_compatibility_source_signature_subject.mjs --describe",
    "  bun tools/assemble_container_runtime_json_compatibility_source_signature_subject.mjs --intent <canonical.json> --expected-intent-sha256 <approved-sha256> --expected-verifier-policy-sha256 <approved-sha256> --expected-verifier-identity-sha256 <approved-sha256> --out <new-subject.json> [--json]",
  ].join("\n");
}

function assertCredentialFreeEnvironment(environment) {
  if (FORBIDDEN_CREDENTIAL_ENVIRONMENT.some((name) =>
    Object.hasOwn(environment, name))) {
    throw new Error("credential environment is forbidden during assembly");
  }
}

async function main(argv = process.argv.slice(2)) {
  try {
    const options =
      parseJsonCompatibilitySourceSignatureSubjectAssemblerArgs(argv);
    if (options.help) return process.stdout.write(`${usage()}\n`);
    if (options.describe) {
      return process.stdout.write(`${canonicalJson(describe())}\n`);
    }
    assertCredentialFreeEnvironment(process.env);
    const result = await assembleJsonCompatibilitySourceSignatureSubject(
      options,
    );
    process.stdout.write(
      options.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : `Source signature subject created: ${result.sourceSignatureSubjectSha256}\n`,
    );
  } catch {
    process.stderr.write("Source signature subject assembly failed\n");
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
