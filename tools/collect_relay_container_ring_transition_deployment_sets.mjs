#!/usr/bin/env bun

import {
  MAX_DEPLOYMENT_READBACK_OBSERVATION_SECONDS,
  MIN_DEPLOYMENT_READBACK_OBSERVATION_SECONDS,
  collectRingTransitionDeploymentSetReadback,
} from "./relay_container_ring_transition_deployment_set_collector.mjs";
import {
  verifyRingTransitionBundle,
} from "./relay_container_ring_transition_contract.mjs";

const READ_TOKEN_ENV = "CINATOKEN_RING_TRANSITION_READ_TOKEN";
const ACCOUNT_ID_ENV = "CLOUDFLARE_ACCOUNT_ID";
const REVOCATION_EVIDENCE_ENV =
  "CINATOKEN_EXPOSED_CREDENTIAL_REVOCATION_EVIDENCE_SHA256";
const READ_TOKEN_ID_ENV =
  "CINATOKEN_RING_TRANSITION_READ_TOKEN_ID_SHA256";
const sha256Pattern = /^[0-9a-f]{64}$/;

try {
  const options = parseArgs(process.argv.slice(2));
  const transition = await verifyRingTransitionBundle({
    manifestPath: options.transitionManifest,
    trustPolicyPath: options.transitionTrustPolicy,
  });
  if (options.dryRun) {
    printResult(
      {
        ok: true,
        schemaVersion: 1,
        mode: "dry-run",
        environment: "staging",
        authorizationIdSha256: options.authorizationIdSha256,
        executionNonceSha256: options.executionNonceSha256,
        transitionSubjectDigestSha256: transition.subjectDigestSha256,
        transitionPlanDigestSha256: transition.planDigestSha256,
        services: [
          transition.serviceIdentities.controllerWorker,
          transition.serviceIdentities.edgeWorker,
        ],
        observationSeconds: options.observationSeconds,
        requestsPlanned: 9,
        deploymentMutationAuthorized: false,
        deploymentMutationPerformed: false,
        credentialsRead: false,
        networkRequestsPerformed: false,
        filesWritten: false,
      },
      options.json,
    );
  } else {
    requireLiveConfirmations(options.confirmations);
    requireSha256Environment(REVOCATION_EVIDENCE_ENV);
    const readCredentialIdSha256 =
      requireSha256Environment(READ_TOKEN_ID_ENV);
    const apiToken = requireEnvironment(READ_TOKEN_ENV);
    const accountId = requireEnvironment(ACCOUNT_ID_ENV);
    const result = await collectRingTransitionDeploymentSetReadback({
      transitionManifestPath: options.transitionManifest,
      transitionTrustPolicyPath: options.transitionTrustPolicy,
      authorizationIdSha256: options.authorizationIdSha256,
      executionNonceSha256: options.executionNonceSha256,
      readCredentialIdSha256,
      accountId,
      apiToken,
      observationSeconds: options.observationSeconds,
    });
    printResult(result, options.json);
  }
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : "ring transition deployment-set collection failed",
  );
  process.exit(1);
}

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  const valueOptions = new Set([
    "--transition-manifest",
    "--transition-trust-policy",
    "--authorization-id-sha256",
    "--execution-nonce-sha256",
    "--observation-seconds",
  ]);
  const flagOptions = new Set([
    "--dry-run",
    "--json",
    "--confirm-staging-readback",
    "--confirm-replacement-read-token",
    "--confirm-exposed-credential-revoked",
    "--confirm-no-mutation",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") usage(0);
    if (flagOptions.has(argument)) {
      if (flags.has(argument)) {
        usage(2, `[input] ${argument} must not be repeated`);
      }
      flags.add(argument);
      continue;
    }
    if (!valueOptions.has(argument)) {
      usage(2, `[input] unknown option: ${argument}`);
    }
    if (values.has(argument)) {
      usage(2, `[input] ${argument} must not be repeated`);
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) {
      usage(2, `[input] ${argument} requires a value`);
    }
    values.set(argument, value);
  }
  for (const option of [
    "--transition-manifest",
    "--transition-trust-policy",
    "--authorization-id-sha256",
    "--execution-nonce-sha256",
  ]) {
    if (!values.has(option)) usage(2, `[input] ${option} is required`);
  }
  const authorizationIdSha256 = requireSha256(
    values.get("--authorization-id-sha256"),
    "--authorization-id-sha256",
  );
  const executionNonceSha256 = requireSha256(
    values.get("--execution-nonce-sha256"),
    "--execution-nonce-sha256",
  );
  if (authorizationIdSha256 === executionNonceSha256) {
    usage(2, "[input] authorization ID and execution nonce must differ");
  }
  const observationSeconds = values.has("--observation-seconds")
    ? Number(values.get("--observation-seconds"))
    : MIN_DEPLOYMENT_READBACK_OBSERVATION_SECONDS;
  if (
    !Number.isSafeInteger(observationSeconds) ||
    observationSeconds < MIN_DEPLOYMENT_READBACK_OBSERVATION_SECONDS ||
    observationSeconds > MAX_DEPLOYMENT_READBACK_OBSERVATION_SECONDS
  ) {
    usage(
      2,
      `[input] --observation-seconds must be ${MIN_DEPLOYMENT_READBACK_OBSERVATION_SECONDS}-${MAX_DEPLOYMENT_READBACK_OBSERVATION_SECONDS}`,
    );
  }
  const confirmations = new Set(
    [...flags].filter((flag) => flag.startsWith("--confirm-")),
  );
  if (flags.has("--dry-run") && confirmations.size > 0) {
    usage(2, "[input] --dry-run does not accept live confirmations");
  }
  return {
    transitionManifest: values.get("--transition-manifest"),
    transitionTrustPolicy: values.get("--transition-trust-policy"),
    authorizationIdSha256,
    executionNonceSha256,
    observationSeconds,
    dryRun: flags.has("--dry-run"),
    json: flags.has("--json"),
    confirmations,
  };
}

function requireLiveConfirmations(confirmations) {
  for (const flag of [
    "--confirm-staging-readback",
    "--confirm-replacement-read-token",
    "--confirm-exposed-credential-revoked",
    "--confirm-no-mutation",
  ]) {
    if (!confirmations.has(flag)) {
      throw new Error(`[confirmation] live collection requires ${flag}`);
    }
  }
}

function requireEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`[credential] ${name} is required for live collection`);
  }
  return value;
}

function requireSha256Environment(name) {
  const value = requireEnvironment(name);
  return requireSha256(value, name);
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    throw new Error(`[input] ${label} must be lowercase SHA-256`);
  }
  return value;
}

function usage(exitCode, error) {
  if (error) console.error(error);
  console.error(
    [
      "Usage:",
      "  bun tools/collect_relay_container_ring_transition_deployment_sets.mjs --transition-manifest <manifest.json> --transition-trust-policy <policy.json> --authorization-id-sha256 <sha256> --execution-nonce-sha256 <sha256> --dry-run [--observation-seconds 5] [--json]",
      "  bun tools/collect_relay_container_ring_transition_deployment_sets.mjs --transition-manifest <manifest.json> --transition-trust-policy <policy.json> --authorization-id-sha256 <sha256> --execution-nonce-sha256 <sha256> --confirm-staging-readback --confirm-replacement-read-token --confirm-exposed-credential-revoked --confirm-no-mutation [--observation-seconds 5] [--json]",
      "",
      `Live mode reads only ${READ_TOKEN_ENV}, ${ACCOUNT_ID_ENV}, ${REVOCATION_EVIDENCE_ENV}, and ${READ_TOKEN_ID_ENV}.`,
      "The token is accepted only from the environment, used only in in-memory GET Authorization headers, and never printed or written.",
      "The collector verifies the account-owned read-token identity, then performs eight deployment/version GET requests; all nine responses are bounded and never retried.",
    ].join("\n"),
  );
  process.exit(exitCode);
}

function printResult(result, json) {
  if (json || result.mode !== "dry-run") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(
    [
      "Relay Container ring transition deployment-set collector dry-run",
      `transition_subject_digest_sha256: ${result.transitionSubjectDigestSha256}`,
      `services: ${result.services.join(",")}`,
      `observation_seconds: ${result.observationSeconds}`,
      `requests_planned: ${result.requestsPlanned}`,
      "credentials_read: false",
      "network_requests_performed: false",
      "deployment_mutation_performed: false",
    ].join("\n"),
  );
}
