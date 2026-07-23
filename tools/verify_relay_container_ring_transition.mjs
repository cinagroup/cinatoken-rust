#!/usr/bin/env bun

import {
  MAX_RING_TRANSITION_WINDOW_SECONDS,
  MIN_RING_TRANSITION_PREFLIGHT_LEAD_SECONDS,
  RING_TRANSITION_DECISION,
  RING_TRANSITION_EVIDENCE_CONTRACT,
  RING_TRANSITION_EVIDENCE_KINDS,
  RING_TRANSITION_MANIFEST_CONTRACT,
  RING_TRANSITION_TRUST_POLICY_CONTRACT,
  ROUTING_CONTRACT_IDENTITY,
  routingContractDigestSha256,
  verifyRingTransitionBundle,
} from "./relay_container_ring_transition_contract.mjs";
import { REQUIRED_APPROVAL_ROLES } from "./relay_container_p5_evidence_contract.mjs";

try {
  const options = parseArgs(process.argv.slice(2));
  const result = options.describe
    ? describeContract()
    : await verifyRingTransitionBundle({
        manifestPath: options.manifest,
        trustPolicyPath: options.trustPolicy,
      });
  printResult(result, options.json);
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : "ring transition verification failed",
  );
  process.exit(1);
}

function parseArgs(argv) {
  const values = new Map();
  let json = false;
  let describe = false;
  const seenFlags = new Set();
  const pathOptions = new Set([
    "--manifest",
    "--trust-policy",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") usage(0);
    if (argument === "--json") {
      if (seenFlags.has(argument)) usage(2, "[input] --json must not be repeated");
      seenFlags.add(argument);
      json = true;
      continue;
    }
    if (argument === "--describe") {
      if (seenFlags.has(argument)) usage(2, "[input] --describe must not be repeated");
      seenFlags.add(argument);
      describe = true;
      continue;
    }
    if (!pathOptions.has(argument)) {
      usage(2, `[input] unknown option: ${argument}`);
    }
    if (values.has(argument)) usage(2, `[input] ${argument} must not be repeated`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) {
      usage(2, `[input] ${argument} requires a path`);
    }
    values.set(argument, value);
  }
  if (describe) {
    if (values.size > 0) usage(2, "[input] --describe does not accept evidence paths");
    return { describe: true, json };
  }
  for (const option of pathOptions) {
    if (!values.has(option)) usage(2, `[input] ${option} is required`);
  }
  return {
    describe: false,
    json,
    manifest: values.get("--manifest"),
    trustPolicy: values.get("--trust-policy"),
  };
}

function describeContract() {
  return {
    ok: true,
    schemaVersion: 1,
    describe: true,
    manifestContract: RING_TRANSITION_MANIFEST_CONTRACT,
    trustPolicyContract: RING_TRANSITION_TRUST_POLICY_CONTRACT,
    evidenceContract: RING_TRANSITION_EVIDENCE_CONTRACT,
    evidenceKinds: RING_TRANSITION_EVIDENCE_KINDS,
    environment: "staging",
    decision: RING_TRANSITION_DECISION,
    approvalRoles: REQUIRED_APPROVAL_ROLES,
    routingContract: {
      ...ROUTING_CONTRACT_IDENTITY,
      digestSha256: routingContractDigestSha256(),
    },
    constraints: {
      adjacentGenerationOnly: true,
      expandOnly: true,
      maximumAdmissionWindowSeconds: MAX_RING_TRANSITION_WINDOW_SECONDS,
      minimumPreflightLeadSeconds: MIN_RING_TRANSITION_PREFLIGHT_LEAD_SECONDS,
      canonicalJsonRequired: true,
      externalTrustPolicyRequired: true,
      postTransitionP5RequiredForPromotion: true,
      canonicalEvidenceArtifactsRequired: true,
      goVpsHotFallbackReadinessRequired: true,
      distinctApprovalKeysRequired: true,
      distinctApprovalPublicKeysRequired: true,
      credentialsRead: false,
      networkRequests: false,
      writesFiles: false,
      executesShellCommands: false,
      emitsExecutableDeployCommand: false,
      authorizesRemoteMutation: false,
      authorizesProviderCalls: false,
      authorizesCustomerTraffic: false,
      authorizesProductionCutover: false,
    },
  };
}

function usage(exitCode, error) {
  if (error) console.error(error);
  console.error(
    [
      "Usage:",
      "  bun tools/verify_relay_container_ring_transition.mjs --manifest <manifest.json> --trust-policy <trust-policy.json> [--json]",
      "  bun tools/verify_relay_container_ring_transition.mjs --describe [--json]",
      "",
      "The verifier is offline and read-only. It reads no credential environment variables, performs no network request, executes no shell command, and writes no file.",
      "A valid packet permits only independent review of an isolated staging adjacent-ring transition. It never authorizes remote mutation, paid provider calls, customer traffic, or production cutover.",
      "The emitted plan is non-executable and the transition trust policy must be supplied independently of the manifest bundle.",
    ].join("\n"),
  );
  process.exit(exitCode);
}

function printResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.describe) {
    console.log(
      [
        "Relay Container adjacent ring transition contract",
        `manifest_contract: ${result.manifestContract}`,
        `trust_policy_contract: ${result.trustPolicyContract}`,
        `approval_roles: ${result.approvalRoles.join(",")}`,
        `maximum_admission_window_seconds: ${result.constraints.maximumAdmissionWindowSeconds}`,
        "authorizes_remote_mutation: false",
        "authorizes_customer_traffic: false",
        "authorizes_production_cutover: false",
      ].join("\n"),
    );
    return;
  }
  console.log(
    [
      "Relay Container adjacent ring transition verification",
      `ok: ${result.ok}`,
      `decision: ${result.decision}`,
      `commit: ${result.commitSha}`,
      `subject_digest_sha256: ${result.subjectDigestSha256}`,
      `transition: ${result.transition.previousRingGeneration}/${result.transition.previousShardCount} -> ${result.transition.currentRingGeneration}/${result.transition.currentShardCount}`,
      `admission_started_at: ${result.transition.admissionStartedAt}`,
      `admission_until: ${result.transition.admissionUntil}`,
      `remote_mutation_authorized: ${result.remoteMutationAuthorized}`,
      `customer_traffic_authorized: ${result.customerTrafficAuthorized}`,
      `production_cutover_authorized: ${result.productionCutoverAuthorized}`,
      `expires_at: ${result.expiresAt}`,
    ].join("\n"),
  );
}
