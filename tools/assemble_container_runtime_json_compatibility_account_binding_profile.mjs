#!/usr/bin/env bun

import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { Buffer } from "node:buffer";
import path from "node:path";

import {
  canonicalJson,
} from "./container_runtime_json_compatibility_campaign.mjs";
import {
  buildJsonCompatibilityAccountBindingCredentialProvenance,
} from "./container_runtime_json_compatibility_account_binding_credentials.mjs";
import {
  buildJsonCompatibilityAccountBindingCollectionProfile,
  validateJsonCompatibilityAccountBindingCollectorIdentity,
} from "./container_runtime_json_compatibility_account_binding_evidence.mjs";
import {
  verifyJsonCompatibilityAccountBindingCredentialProvenance,
} from "./lib/container_runtime_json_compatibility_account_binding_credentials.mjs";
import {
  readBoundedUtf8File,
} from "./lib/bounded_json_file.mjs";

const MAX_INPUT_BYTES = 12 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
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

export async function runJsonCompatibilityAccountBindingProfileAssembler({
  campaignPlanPath,
  statePlanPath,
  collectorIdentityPath,
  trustPolicyPath,
  collectionReceiptPath,
  readbackReceiptPath,
  revocationPath,
  allowedEdgesPath,
  approvedAt,
  expectedTrustPolicySha256,
  expectedRevocationStateSha256,
  minimumRevocationSequence,
  outputPath,
  environment = process.env,
}) {
  assertCredentialFreeEnvironment(environment);
  assertAnchorInputs({
    expectedTrustPolicySha256,
    expectedRevocationStateSha256,
    minimumRevocationSequence,
  });
  const [
    campaignPlan,
    statePlan,
    collectorIdentityInput,
    trustPolicy,
    collectionReceipt,
    readbackReceipt,
    revocation,
    allowedCampaignBindingEdges,
  ] = await Promise.all([
    readCanonicalJson(campaignPlanPath, "campaign plan"),
    readCanonicalJson(statePlanPath, "deployment state plan"),
    readCanonicalJson(collectorIdentityPath, "collector identity"),
    readCanonicalJson(trustPolicyPath, "credential trust policy"),
    readCanonicalJson(collectionReceiptPath, "collection credential receipt"),
    readCanonicalJson(readbackReceiptPath, "readback credential receipt"),
    readCanonicalJson(revocationPath, "credential revocation state"),
    readCanonicalJson(allowedEdgesPath, "allowed campaign binding edges"),
  ]);
  const collectorIdentity =
    validateJsonCompatibilityAccountBindingCollectorIdentity(
      collectorIdentityInput,
    );
  const credentialProvenance =
    buildJsonCompatibilityAccountBindingCredentialProvenance({
      trustPolicy,
      collectionReceipt,
      readbackReceipt,
      revocation,
    });
  verifyJsonCompatibilityAccountBindingCredentialProvenance(
    credentialProvenance,
    {
      now: approvedAt,
      expectedTrustPolicySha256,
      expectedRevocationStateSha256,
      minimumRevocationSequence,
    },
  );
  const profile = buildJsonCompatibilityAccountBindingCollectionProfile({
    campaignPlan,
    statePlan,
    accountIdSha256: credentialProvenance.accountIdSha256,
    collectorIdentitySha256: collectorIdentity.collectorIdentitySha256,
    credentialProvenance,
    credentialProvenanceApprovedAt: approvedAt,
    allowedCampaignBindingEdges,
  });
  await writeCanonicalJsonExclusive(outputPath, profile);
  return {
    schemaVersion: 1,
    mode: "offline-account-binding-profile-assembly",
    collectionProfileSha256: profile.collectionProfileSha256,
    credentialProvenanceSha256:
      credentialProvenance.credentialProvenanceSha256,
    collectionCredentialReceiptSha256:
      credentialProvenance.collectionCredentialReceiptSha256,
    readbackCredentialReceiptSha256:
      credentialProvenance.readbackCredentialReceiptSha256,
    credentialRevocationStateSha256:
      credentialProvenance.credentialRevocationStateSha256,
    minimumRevocationSequence,
    outputCreated: true,
    credentialSecretRead: false,
    networkRequestsPerformed: false,
    cloudflareMutationPerformed: false,
  };
}

export function parseJsonCompatibilityAccountBindingProfileAssemblerArgs(argv) {
  if (argv.length === 1 && argv[0] === "--describe") return { describe: true };
  const valueOptions = new Set([
    "--campaign-plan",
    "--state-plan",
    "--collector-identity",
    "--trust-policy",
    "--collection-receipt",
    "--readback-receipt",
    "--revocation",
    "--allowed-edges",
    "--approved-at",
    "--expected-trust-policy-sha256",
    "--expected-revocation-state-sha256",
    "--minimum-revocation-sequence",
    "--out",
  ]);
  const values = new Map();
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--json") {
      if (json) throw new Error("--json must not repeat");
      json = true;
      continue;
    }
    if (!valueOptions.has(argument)) throw new Error("unknown assembler option");
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
  const approvedAt = Number(values.get("--approved-at"));
  if (!Number.isSafeInteger(approvedAt) || approvedAt < 0) {
    throw new Error("--approved-at must be a nonnegative whole-second epoch");
  }
  const expectedTrustPolicySha256 = values.get(
    "--expected-trust-policy-sha256",
  );
  const expectedRevocationStateSha256 = values.get(
    "--expected-revocation-state-sha256",
  );
  const minimumRevocationSequence = Number(values.get(
    "--minimum-revocation-sequence",
  ));
  assertAnchorInputs({
    expectedTrustPolicySha256,
    expectedRevocationStateSha256,
    minimumRevocationSequence,
  });
  return {
    json,
    campaignPlanPath: values.get("--campaign-plan"),
    statePlanPath: values.get("--state-plan"),
    collectorIdentityPath: values.get("--collector-identity"),
    trustPolicyPath: values.get("--trust-policy"),
    collectionReceiptPath: values.get("--collection-receipt"),
    readbackReceiptPath: values.get("--readback-receipt"),
    revocationPath: values.get("--revocation"),
    allowedEdgesPath: values.get("--allowed-edges"),
    approvedAt,
    expectedTrustPolicySha256,
    expectedRevocationStateSha256,
    minimumRevocationSequence,
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

function assertCredentialFreeEnvironment(environment) {
  if (FORBIDDEN_CREDENTIAL_ENVIRONMENT.some((name) =>
    Object.hasOwn(environment, name))) {
    throw new Error("credential environment is forbidden during profile assembly");
  }
}

function assertAnchorInputs({
  expectedTrustPolicySha256,
  expectedRevocationStateSha256,
  minimumRevocationSequence,
}) {
  if (!SHA256.test(expectedTrustPolicySha256)) {
    throw new Error("expected trust policy digest must be lowercase SHA-256");
  }
  if (!SHA256.test(expectedRevocationStateSha256)) {
    throw new Error("expected revocation state digest must be lowercase SHA-256");
  }
  if (!Number.isSafeInteger(minimumRevocationSequence)
    || minimumRevocationSequence < 1) {
    throw new Error("minimum revocation sequence must be a positive integer");
  }
}

function describe() {
  return {
    schemaVersion: 1,
    mode: "offline-account-binding-profile-assembly",
    inputMustBeCanonical: true,
    signatureVerificationRequired: true,
    distinctCredentialIdsRequired: true,
    distinctCustodiansRequired: true,
    currentRevocationRequired: true,
    externalTrustPolicyDigestRequired: true,
    externalRevocationDigestRequired: true,
    minimumRevocationSequenceRequired: true,
    outputMustNotExist: true,
    forbiddenCredentialEnvironment:
      [...FORBIDDEN_CREDENTIAL_ENVIRONMENT],
    credentialSecretRead: false,
    networkRequestsPerformed: false,
    cloudflareMutationPerformed: false,
  };
}

function usage() {
  return [
    "Usage:",
    "  bun tools/assemble_container_runtime_json_compatibility_account_binding_profile.mjs --describe",
    "  bun tools/assemble_container_runtime_json_compatibility_account_binding_profile.mjs --campaign-plan <canonical.json> --state-plan <canonical.json> --collector-identity <canonical.json> --trust-policy <canonical.json> --collection-receipt <canonical.json> --readback-receipt <canonical.json> --revocation <canonical.json> --allowed-edges <canonical.json> --approved-at <epoch-seconds> --expected-trust-policy-sha256 <approved-sha256> --expected-revocation-state-sha256 <approved-sha256> --minimum-revocation-sequence <positive-integer> --out <new-profile.json> [--json]",
    "",
    "Assembly is credential-free, verifies all Ed25519 provenance, and writes one create-only canonical profile without network access.",
  ].join("\n");
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseJsonCompatibilityAccountBindingProfileAssemblerArgs(argv);
    if (options.help) return process.stdout.write(`${usage()}\n`);
    if (options.describe) {
      return process.stdout.write(`${canonicalJson(describe())}\n`);
    }
    const result = await runJsonCompatibilityAccountBindingProfileAssembler(
      options,
    );
    process.stdout.write(
      options.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : `Account binding collection profile created: ${result.collectionProfileSha256}\n`,
    );
  } catch {
    process.stderr.write("Account binding profile assembly failed\n");
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
