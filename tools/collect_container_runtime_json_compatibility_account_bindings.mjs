import { createHash } from "node:crypto";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import {
  canonicalJson,
  sha256Canonical,
} from "./container_runtime_json_compatibility_campaign.mjs";
import {
  validateJsonCompatibilityAccountBindingPageReceipt,
  validateJsonCompatibilityAccountBindingCollectionProfile,
  validateJsonCompatibilityAccountBindingCollectorIdentity,
} from "./container_runtime_json_compatibility_account_binding_evidence.mjs";
import {
  collectJsonCompatibilityAccountBindingArtifact,
  finalizeJsonCompatibilityAccountBindingEvidence,
} from "./lib/container_runtime_json_compatibility_account_binding_collector.mjs";

export const JSON_COMPATIBILITY_ACCOUNT_BINDING_FINALIZATION_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-account-binding-finalization-v1";

const COLLECTION_TOKEN_ENV =
  "CLOUDFLARE_ACCOUNT_BINDING_COLLECTION_TOKEN";
const READBACK_TOKEN_ENV =
  "CLOUDFLARE_ACCOUNT_BINDING_READBACK_TOKEN";
const GENERIC_CREDENTIAL_ENVIRONMENT = Object.freeze([
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_EMAIL",
  "CF_API_TOKEN",
  "CF_API_KEY",
  "CF_EMAIL",
]);
const MAX_INPUT_BYTES = 12 * 1024 * 1024;
const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const VALUE_OPTIONS = new Set([
  "--mode",
  "--campaign-plan",
  "--state-plan",
  "--collection-profile",
  "--collector-identity",
  "--account-id",
  "--credential-trust-policy-sha256",
  "--credential-revocation-state-sha256",
  "--minimum-revocation-sequence",
  "--raw-page-dir",
  "--collection-artifact",
  "--readback-artifact",
  "--output",
]);
const FLAG_OPTIONS = new Set(["--dry-run", "--help", "--self-test"]);

export class JsonCompatibilityAccountBindingCliError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "JsonCompatibilityAccountBindingCliError";
    this.code = code;
  }
}

export function buildAccountBindingCollectorDryRunPlan(mode) {
  oneOf(
    mode,
    ["collection", "independent-readback", "finalize"],
    "mode",
  );
  if (mode === "finalize") {
    return {
      schemaVersion: 1,
      contract:
        "cinatoken-container-runtime-json-compatibility-account-binding-cli-plan-v1",
      mode,
      credentialAccess: "none",
      networkRequests: 0,
      fileWrites: 0,
      createOnceOutput: true,
      requiredInputs: [
        "campaign-plan",
        "state-plan",
        "collection-profile",
        "collection-artifact",
        "readback-artifact",
      ],
    };
  }
  return {
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-json-compatibility-account-binding-cli-plan-v1",
    mode,
    credentialAccess: mode === "collection"
      ? COLLECTION_TOKEN_ENV
      : READBACK_TOKEN_ENV,
    forbiddenCredentialEnvironment: [
      ...GENERIC_CREDENTIAL_ENVIRONMENT,
      mode === "collection" ? READBACK_TOKEN_ENV : COLLECTION_TOKEN_ENV,
    ],
    httpMethodAllowlist: ["GET"],
    hiddenRetries: false,
    networkRequests: 0,
    fileWrites: 0,
    rawPageCreateOnce: true,
    createOnceOutput: true,
    requiredInputs: [
      "campaign-plan",
      "state-plan",
      "collection-profile",
      "collector-identity",
      "account-id",
      "credential-trust-policy-sha256",
      "credential-revocation-state-sha256",
      "minimum-revocation-sequence",
      "raw-page-dir",
    ],
  };
}

export function parseAccountBindingCollectorArgs(argv) {
  if (!Array.isArray(argv)) fail("argv_invalid");
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (FLAG_OPTIONS.has(argument)) {
      if (flags.has(argument)) fail("option_repeated");
      flags.add(argument);
      continue;
    }
    if (!VALUE_OPTIONS.has(argument)) fail("option_unknown");
    if (values.has(argument)) fail("option_repeated");
    const value = argv[index + 1];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      fail("option_value_missing");
    }
    values.set(argument, value);
    index += 1;
  }
  const standalone = ["--help", "--self-test"].filter((flag) =>
    flags.has(flag));
  if (standalone.length > 0) {
    if (standalone.length !== 1 || values.size !== 0 || flags.size !== 1) {
      fail("standalone_mode_has_other_options");
    }
    return { mode: standalone[0].slice(2) };
  }
  const mode = values.get("--mode");
  oneOf(mode, ["collection", "independent-readback", "finalize"], "mode");
  if (flags.has("--dry-run")) {
    if (values.size !== 1 || flags.size !== 1) {
      fail("dry_run_accepts_only_mode");
    }
    return { mode: "dry-run", operation: mode };
  }
  const common = {
    mode,
    campaignPlanPath: required(values, "--campaign-plan"),
    statePlanPath: required(values, "--state-plan"),
    collectionProfilePath: required(values, "--collection-profile"),
    outputPath: required(values, "--output"),
  };
  if (mode === "finalize") {
    exactOptions(values, [
      "--mode",
      "--campaign-plan",
      "--state-plan",
      "--collection-profile",
      "--collection-artifact",
      "--readback-artifact",
      "--output",
    ]);
    return {
      ...common,
      collectionArtifactPath: required(values, "--collection-artifact"),
      readbackArtifactPath: required(values, "--readback-artifact"),
    };
  }
  exactOptions(values, [
    "--mode",
    "--campaign-plan",
    "--state-plan",
    "--collection-profile",
    "--collector-identity",
    "--account-id",
    "--credential-trust-policy-sha256",
    "--credential-revocation-state-sha256",
    "--minimum-revocation-sequence",
    "--raw-page-dir",
    "--output",
  ]);
  const accountId = required(values, "--account-id");
  if (!ACCOUNT_ID.test(accountId)) fail("account_id_invalid");
  const expectedTrustPolicySha256 = required(
    values,
    "--credential-trust-policy-sha256",
  );
  const expectedRevocationStateSha256 = required(
    values,
    "--credential-revocation-state-sha256",
  );
  if (!SHA256.test(expectedTrustPolicySha256)) {
    fail("credential_trust_policy_sha256_invalid");
  }
  if (!SHA256.test(expectedRevocationStateSha256)) {
    fail("credential_revocation_state_sha256_invalid");
  }
  const minimumRevocationSequence = Number(required(
    values,
    "--minimum-revocation-sequence",
  ));
  if (!Number.isSafeInteger(minimumRevocationSequence)
    || minimumRevocationSequence < 1) {
    fail("minimum_revocation_sequence_invalid");
  }
  return {
    ...common,
    collectorIdentityPath: required(values, "--collector-identity"),
    accountId,
    expectedTrustPolicySha256,
    expectedRevocationStateSha256,
    minimumRevocationSequence,
    rawPageDirectory: required(values, "--raw-page-dir"),
  };
}

export async function runAccountBindingCollectorCli({
  argv = process.argv.slice(2),
  environment = process.env,
  stdout = process.stdout,
  fetchImpl = globalThis.fetch,
  clock,
  monotonicClock,
} = {}) {
  const args = parseAccountBindingCollectorArgs(argv);
  if (args.mode === "help") {
    stdout.write(`${usage()}\n`);
    return { mode: "help" };
  }
  if (args.mode === "self-test") {
    const result = runSelfTest();
    stdout.write(`${canonicalJson(result)}\n`);
    return result;
  }
  if (args.mode === "dry-run") {
    const result = buildAccountBindingCollectorDryRunPlan(args.operation);
    stdout.write(`${canonicalJson(result)}\n`);
    return result;
  }

  assertCredentialEnvironment(args.mode, environment);
  const [campaignPlan, statePlan, collectionProfileInput] = await Promise.all([
    readCanonicalJson(args.campaignPlanPath, "campaign plan"),
    readCanonicalJson(args.statePlanPath, "state plan"),
    readCanonicalJson(args.collectionProfilePath, "collection profile"),
  ]);
  if (args.mode === "finalize") {
    const [collection, independentReadback] = await Promise.all([
      readCanonicalJson(args.collectionArtifactPath, "collection artifact"),
      readCanonicalJson(args.readbackArtifactPath, "readback artifact"),
    ]);
    const finalized = finalizeJsonCompatibilityAccountBindingEvidence({
      campaignPlan,
      statePlan,
      collectionProfile: collectionProfileInput,
      collection,
      independentReadback,
    });
    const subject = {
      schemaVersion: 1,
      contract: JSON_COMPATIBILITY_ACCOUNT_BINDING_FINALIZATION_CONTRACT,
      kind:
        "container-runtime-json-compatibility-account-binding-finalization",
      environment: "staging",
      evidence: finalized.evidence,
      inventory: finalized.inventory,
    };
    const output = {
      ...subject,
      finalizationSha256: sha256Canonical(subject),
    };
    await writeCanonicalCreateOnce(args.outputPath, output);
    const result = {
      mode: args.mode,
      finalizationSha256: output.finalizationSha256,
      outputPath: resolve(args.outputPath),
    };
    stdout.write(`${canonicalJson(result)}\n`);
    return result;
  }

  const collectorIdentity = validateJsonCompatibilityAccountBindingCollectorIdentity(
    await readCanonicalJson(
      args.collectorIdentityPath,
      "collector identity",
    ),
  );
  const collectionProfile =
    validateJsonCompatibilityAccountBindingCollectionProfile(
      campaignPlan,
      statePlan,
      collectionProfileInput,
    );
  if (collectionProfile.accountIdSha256 !== sha256Text(args.accountId)) {
    fail("collector_account_identity_mismatch");
  }
  const tokenName = args.mode === "collection"
    ? COLLECTION_TOKEN_ENV
    : READBACK_TOKEN_ENV;
  const apiToken = requiredSecretEnvironment(environment, tokenName);
  const rawPageSink =
    await createJsonCompatibilityAccountBindingRawPageSink(
      args.rawPageDirectory,
      {
        mode: args.mode,
        accountIdSha256: collectionProfile.accountIdSha256,
        collectionProfileSha256: collectionProfile.collectionProfileSha256,
        collectorIdentitySha256: collectorIdentity.collectorIdentitySha256,
      },
    );
  const artifact = await collectJsonCompatibilityAccountBindingArtifact({
    campaignPlan,
    statePlan,
    collectionProfile,
    collectorIdentity,
    mode: args.mode,
    accountId: args.accountId,
    apiToken,
    expectedTrustPolicySha256: args.expectedTrustPolicySha256,
    expectedRevocationStateSha256: args.expectedRevocationStateSha256,
    minimumRevocationSequence: args.minimumRevocationSequence,
    rawPageSink,
    fetchImpl,
    ...(clock === undefined ? {} : { clock }),
    ...(monotonicClock === undefined ? {} : { monotonicClock }),
  });
  await writeCanonicalCreateOnce(args.outputPath, artifact);
  const result = {
    mode: args.mode,
    collectionArtifactSha256: artifact.collectionArtifactSha256,
    rawPageCount: artifact.snapshot.pageReceipts.length,
    rawPageDirectory: resolve(args.rawPageDirectory),
    outputPath: resolve(args.outputPath),
  };
  stdout.write(`${canonicalJson(result)}\n`);
  return result;
}

export async function createJsonCompatibilityAccountBindingRawPageSink(
  directoryInput,
  captureIdentity,
) {
  oneOf(
    captureIdentity?.mode,
    ["collection", "independent-readback"],
    "capture mode",
  );
  for (const [label, value] of [
    ["capture account ID", captureIdentity.accountIdSha256],
    ["capture collection profile", captureIdentity.collectionProfileSha256],
    ["capture collector identity", captureIdentity.collectorIdentitySha256],
  ]) {
    if (typeof value !== "string" || !SHA256.test(value)) {
      fail(`${label.replaceAll(" ", "_")}_invalid`);
    }
  }
  const directory = resolve(directoryInput);
  try {
    await mkdir(directory, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") fail("raw_page_directory_exists");
    throw error;
  }
  const captureManifest = {
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-json-compatibility-account-binding-raw-capture-v1",
    environment: "staging",
    mode: captureIdentity.mode,
    accountIdSha256: captureIdentity.accountIdSha256,
    collectionProfileSha256: captureIdentity.collectionProfileSha256,
    collectorIdentitySha256: captureIdentity.collectorIdentitySha256,
  };
  await writeCanonicalCreateOnce(
    resolve(directory, "capture-manifest.json"),
    {
      ...captureManifest,
      captureManifestSha256: sha256Canonical(captureManifest),
    },
  );
  return async ({ sequence, resourceFamily, body, receipt: receiptInput }) => {
    if (!(body instanceof Uint8Array)) fail("raw_page_body_invalid");
    const receipt = validateJsonCompatibilityAccountBindingPageReceipt(
      receiptInput,
    );
    if (
      receipt.sequence !== sequence
      || receipt.resourceFamily !== resourceFamily
      || receipt.responseByteLength !== body.byteLength
      || receipt.responseBodySha256 !== sha256Bytes(body)
    ) fail("raw_page_receipt_body_mismatch");
    const prefix = [
      String(sequence).padStart(6, "0"),
      resourceFamily,
      receipt.pageReceiptSha256,
    ].join("-");
    await writeBytesCreateOnce(
      resolve(directory, `${prefix}.body.json`),
      body,
    );
    await writeCanonicalCreateOnce(
      resolve(directory, `${prefix}.receipt.json`),
      receipt,
    );
  };
}

async function readCanonicalJson(pathInput, label) {
  const path = resolve(pathInput);
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size < 2 || metadata.size > MAX_INPUT_BYTES) {
    fail(`${label.replaceAll(" ", "_")}_file_invalid`);
  }
  const bytes = await readFile(path);
  if (bytes.byteLength !== metadata.size) fail("input_file_changed_during_read");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(`${label.replaceAll(" ", "_")}_utf8_invalid`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail(`${label.replaceAll(" ", "_")}_json_invalid`);
  }
  if (`${canonicalJson(value)}\n` !== text) {
    fail(`${label.replaceAll(" ", "_")}_not_canonical`);
  }
  return value;
}

async function writeCanonicalCreateOnce(pathInput, value) {
  return writeBytesCreateOnce(
    resolve(pathInput),
    new TextEncoder().encode(`${canonicalJson(value)}\n`),
  );
}

async function writeBytesCreateOnce(path, bytes) {
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    if (error?.code === "EEXIST") fail("create_once_output_exists");
    throw error;
  } finally {
    await handle?.close();
  }
}

function assertCredentialEnvironment(mode, environment) {
  const forbidden = mode === "finalize"
    ? [
        ...GENERIC_CREDENTIAL_ENVIRONMENT,
        COLLECTION_TOKEN_ENV,
        READBACK_TOKEN_ENV,
      ]
    : [
        ...GENERIC_CREDENTIAL_ENVIRONMENT,
        mode === "collection" ? READBACK_TOKEN_ENV : COLLECTION_TOKEN_ENV,
      ];
  if (forbidden.some((name) => Object.hasOwn(environment, name))) {
    fail("forbidden_credential_environment_present");
  }
}

function requiredSecretEnvironment(environment, name) {
  const value = environment[name];
  if (
    typeof value !== "string" || value.length < 20 || value.length > 4_096
    || /\s/.test(value)
  ) fail("required_credential_environment_invalid");
  return value;
}

function runSelfTest() {
  const plans = [
    buildAccountBindingCollectorDryRunPlan("collection"),
    buildAccountBindingCollectorDryRunPlan("independent-readback"),
    buildAccountBindingCollectorDryRunPlan("finalize"),
  ];
  if (
    plans.some((plan) => plan.networkRequests !== 0 || plan.fileWrites !== 0)
    || plans[0].credentialAccess === plans[1].credentialAccess
    || plans[2].credentialAccess !== "none"
  ) fail("self_test_safety_boundary_failed");
  const planSetSha256 = createHash("sha256")
    .update(canonicalJson(plans), "utf8")
    .digest("hex");
  return {
    mode: "self-test",
    passed: true,
    credentialAccess: "none",
    networkRequests: 0,
    fileWrites: 0,
    planSetSha256,
  };
}

function exactOptions(values, expected) {
  if (
    values.size !== expected.length
    || expected.some((name) => !values.has(name))
  ) fail("mode_option_set_invalid");
}

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function required(values, name) {
  const value = values.get(name);
  if (typeof value !== "string" || value.length === 0) fail("option_required");
  return value;
}

function oneOf(value, choices, label) {
  if (!choices.includes(value)) fail(`${label.replaceAll(" ", "_")}_invalid`);
}

function usage() {
  return [
    "Usage:",
    "  bun tools/collect_container_runtime_json_compatibility_account_bindings.mjs --self-test",
    "  bun tools/collect_container_runtime_json_compatibility_account_bindings.mjs --mode <collection|independent-readback|finalize> --dry-run",
    "  bun tools/collect_container_runtime_json_compatibility_account_bindings.mjs --mode <collection|independent-readback> --campaign-plan <canonical.json> --state-plan <canonical.json> --collection-profile <canonical.json> --collector-identity <canonical.json> --account-id <32hex> --credential-trust-policy-sha256 <approved-sha256> --credential-revocation-state-sha256 <approved-sha256> --minimum-revocation-sequence <positive-integer> --raw-page-dir <new-directory> --output <new-canonical.json>",
    "  bun tools/collect_container_runtime_json_compatibility_account_bindings.mjs --mode finalize --campaign-plan <canonical.json> --state-plan <canonical.json> --collection-profile <canonical.json> --collection-artifact <canonical.json> --readback-artifact <canonical.json> --output <new-canonical.json>",
    `Collection credential: ${COLLECTION_TOKEN_ENV}`,
    `Independent readback credential: ${READBACK_TOKEN_ENV}`,
    "Tokens are accepted only through the mode-specific environment variable.",
  ].join("\n");
}

function fail(code) {
  throw new JsonCompatibilityAccountBindingCliError(code);
}

if (import.meta.main) {
  runAccountBindingCollectorCli().catch((error) => {
    const code = error instanceof JsonCompatibilityAccountBindingCliError
      ? error.code
      : "account_binding_collector_failed";
    process.stderr.write(`[account-binding-collector] ${code}\n`);
    process.exitCode = 1;
  });
}
