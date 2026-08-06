#!/usr/bin/env bun

import { Buffer } from "node:buffer";
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

import { canonicalJson } from
  "./container_runtime_json_compatibility_campaign.mjs";
import {
  buildJsonCompatibilitySourcePublicationPacket,
} from "./container_runtime_json_compatibility_source_publication.mjs";
import { readBoundedUtf8File } from "./lib/bounded_json_file.mjs";

const MAX_INPUT_BYTES = 12 * 1024 * 1024 + 1024 * 1024;
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

export async function assembleJsonCompatibilitySourcePublication({
  requestPath,
  bundlePath,
  expectedVerifierPolicySha256,
  expectedVerifierIdentitySha256,
  now,
  outputPath,
}) {
  const [sourceAuthenticationRequest, bundle] = await Promise.all([
    readCanonicalJson(requestPath, "source authentication request"),
    readCanonicalJson(bundlePath, "source authentication bundle"),
  ]);
  const packet = buildJsonCompatibilitySourcePublicationPacket({
    sourceAuthenticationRequest,
    bundle,
  }, { now, requireUsableWindow: true });
  if (
    packet.sourceAuthenticationRequest.sourceEvidence
      .sourceVerifierPolicySha256 !== expectedVerifierPolicySha256
  ) throw new Error("source verifier policy anchor does not match");
  if (
    packet.sourceAuthenticationRequest.sourceEvidence
      .sourceVerifierIdentitySha256 !== expectedVerifierIdentitySha256
  ) throw new Error("source verifier identity anchor does not match");
  await writeCanonicalJsonExclusive(outputPath, packet);
  return {
    schemaVersion: 1,
    mode: "credential-free-source-publication-assembly",
    publicationPacketSha256: packet.publicationPacketSha256,
    bundleKey: packet.bundleKey,
    bundleSha256: packet.bundleSha256,
    bodySha256: packet.bodySha256,
    bodyByteLength: packet.bodyByteLength,
    sourceSignatureEnvelopeSha256:
      packet.sourceSignatureEnvelopeSha256,
    outputCreated: true,
    credentialSecretRead: false,
    networkRequestsPerformed: false,
    cloudflareMutationPerformed: false,
  };
}

export function parseJsonCompatibilitySourcePublicationAssemblerArgs(argv) {
  if (argv.length === 1 && argv[0] === "--describe") return { describe: true };
  const values = new Map();
  const valueOptions = new Set([
    "--request",
    "--bundle",
    "--expected-verifier-policy-sha256",
    "--expected-verifier-identity-sha256",
    "--now",
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
      throw new Error("unknown source publication assembler option");
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
  const expectedVerifierPolicySha256 = values.get(
    "--expected-verifier-policy-sha256",
  );
  const expectedVerifierIdentitySha256 = values.get(
    "--expected-verifier-identity-sha256",
  );
  if (!SHA256.test(expectedVerifierPolicySha256)) {
    throw new Error(
      "--expected-verifier-policy-sha256 must be lowercase SHA-256",
    );
  }
  if (!SHA256.test(expectedVerifierIdentitySha256)) {
    throw new Error(
      "--expected-verifier-identity-sha256 must be lowercase SHA-256",
    );
  }
  const now = Number(values.get("--now"));
  if (!Number.isSafeInteger(now) || now < 1) {
    throw new Error("--now must be a positive epoch-second integer");
  }
  return {
    json,
    requestPath: values.get("--request"),
    bundlePath: values.get("--bundle"),
    expectedVerifierPolicySha256,
    expectedVerifierIdentitySha256,
    now,
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
    mode: "credential-free-source-publication-assembly",
    canonicalRequestRequired: true,
    canonicalBundleRequired: true,
    externalVerifierPolicyDigestRequired: true,
    externalVerifierIdentityDigestRequired: true,
    usableSignatureWindowRequired: true,
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
    "  bun tools/assemble_container_runtime_json_compatibility_source_publication.mjs --describe",
    "  bun tools/assemble_container_runtime_json_compatibility_source_publication.mjs --request <canonical.json> --bundle <canonical.json> --expected-verifier-policy-sha256 <approved-sha256> --expected-verifier-identity-sha256 <approved-sha256> --now <epoch-seconds> --out <new-packet.json> [--json]",
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
    const options = parseJsonCompatibilitySourcePublicationAssemblerArgs(argv);
    if (options.help) return process.stdout.write(`${usage()}\n`);
    if (options.describe) {
      return process.stdout.write(`${canonicalJson(describe())}\n`);
    }
    assertCredentialFreeEnvironment(process.env);
    const result = await assembleJsonCompatibilitySourcePublication(options);
    process.stdout.write(
      options.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : `Source publication packet created: ${result.publicationPacketSha256}\n`,
    );
  } catch {
    process.stderr.write("Source publication assembly failed\n");
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
