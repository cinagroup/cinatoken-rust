#!/usr/bin/env bun

import {
  MANIFEST_CONTRACT,
  REQUIRED_APPROVAL_ROLES,
  REQUIRED_EVIDENCE_KINDS,
  TRUST_POLICY_CONTRACT,
  verifyP5Bundle,
} from "./relay_container_p5_evidence_contract.mjs";

try {
  const options = parseArgs(process.argv.slice(2));
  const result = options.describe
    ? describeContract()
    : await verifyP5Bundle({
        manifestPath: options.manifest,
        trustPolicyPath: options.trustPolicy,
      });
  printResult(result, options.json);
} catch (error) {
  console.error(error instanceof Error ? error.message : "P5 evidence verification failed");
  process.exit(1);
}

function parseArgs(argv) {
  const values = new Map();
  let json = false;
  let describe = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") usage(0);
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--describe") {
      describe = true;
      continue;
    }
    if (argument !== "--manifest" && argument !== "--trust-policy") {
      usage(2, `[input] unknown option: ${argument}`);
    }
    if (values.has(argument)) usage(2, `[input] ${argument} must not be repeated`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) {
      usage(2, `[input] ${argument} requires a path`);
    }
    values.set(argument, value);
  }
  const manifest = values.get("--manifest");
  const trustPolicy = values.get("--trust-policy");
  if (describe) {
    if (values.size > 0) usage(2, "[input] --describe does not accept evidence paths");
    return { describe: true, json };
  }
  if (!manifest || !trustPolicy) {
    usage(2, "[input] --manifest and --trust-policy are required");
  }
  return { describe: false, manifest, trustPolicy, json };
}

function usage(exitCode, error) {
  if (error) console.error(error);
  console.error(
    [
      "Usage:",
      "  bun tools/verify_relay_container_p5_evidence.mjs --manifest <manifest.json> --trust-policy <trust-policy.json> [--json]",
      "  bun tools/verify_relay_container_p5_evidence.mjs --describe [--json]",
      "",
      "The verifier is offline and read-only. It reads no credential environment variables, performs no network request, and writes no file.",
      "A valid packet permits only review of an isolated staging synthetic canary. It never authorizes customer traffic, production cutover, or remote mutation.",
      "The trust policy must be supplied independently of the evidence bundle and contain no private keys.",
    ].join("\n"),
  );
  process.exit(exitCode);
}

function describeContract() {
  return {
    ok: true,
    schemaVersion: 1,
    describe: true,
    manifestContract: MANIFEST_CONTRACT,
    trustPolicyContract: TRUST_POLICY_CONTRACT,
    environment: "staging",
    decision: "isolated-staging-synthetic-canary",
    evidenceKinds: REQUIRED_EVIDENCE_KINDS,
    approvalRoles: REQUIRED_APPROVAL_ROLES,
    constraints: {
      canonicalJsonRequired: true,
      trustPolicyMustBeExternal: true,
      distinctApprovalKeysRequired: true,
      distinctApprovalPublicKeysRequired: true,
      singleHandleFileSnapshotsRequired: true,
      nonElapsedCohortRequired: true,
      credentialsRead: false,
      networkRequests: false,
      writesFiles: false,
      authorizesRemoteMutation: false,
      authorizesCustomerTraffic: false,
      authorizesProductionCutover: false,
    },
  };
}

function printResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(
    result.describe
      ? [
          "Relay Container P5 evidence contract",
          `manifest_contract: ${result.manifestContract}`,
          `trust_policy_contract: ${result.trustPolicyContract}`,
          `evidence_kinds: ${result.evidenceKinds.join(",")}`,
          `approval_roles: ${result.approvalRoles.join(",")}`,
          "authorizes_remote_mutation: false",
          "authorizes_customer_traffic: false",
          "authorizes_production_cutover: false",
        ].join("\n")
      :
    [
      "Relay Container P5 evidence verification",
      `ok: ${result.ok}`,
      `decision: ${result.decision}`,
      `commit: ${result.commitSha}`,
      `candidate_digest_sha256: ${result.candidateDigestSha256}`,
      `subject_digest_sha256: ${result.subjectDigestSha256}`,
      `evidence_count: ${result.evidenceCount}`,
      `production_eligible: ${result.productionEligible}`,
      `customer_traffic_eligible: ${result.customerTrafficEligible}`,
      `expires_at: ${result.expiresAt}`,
    ].join("\n"),
  );
}
