#!/usr/bin/env bun

import {
  EVIDENCE_CONTRACT,
  EVIDENCE_STATUSES,
  MANIFEST_CONTRACT,
  PINNED_GO_HEAD,
  REQUIRED_BATCH_MAPS,
  REQUIRED_EVIDENCE_KINDS,
  REQUIRED_PENDING_WORK_KINDS,
  REQUIRED_PROTOCOLS,
  REQUIRED_RECONCILIATION_DOMAINS,
  REQUIRED_ROLLBACK_COMPONENTS,
  REQUIRED_SYNC_DIRECTIONS,
  canonicalJson,
  verifyGoVpsCutoverEvidence,
} from "./go_vps_cutover_evidence_contract.mjs";

let jsonRequested = false;
try {
  const options = parseArgs(process.argv.slice(2));
  jsonRequested = options.json;
  const result = options.describe
    ? describeContract()
    : await verifyGoVpsCutoverEvidence({ manifestPath: options.manifest });
  printResult(result, options.json);
  if (!options.describe && result.decision === "not-proven") {
    process.exitCode = 1;
  }
} catch (error) {
  const message =
    error instanceof Error ? error.message : "cutover evidence verification failed";
  const failure = {
    schemaVersion: 1,
    contract: MANIFEST_CONTRACT,
    ok: false,
    decision: "not-proven",
    productionCutoverAuthorized: false,
    error: message,
  };
  if (jsonRequested) {
    console.error(canonicalJson(failure));
  } else {
    console.error(
      [
        "Go/VPS production cutover evidence verification",
        "ok: false",
        "decision: not-proven",
        "production_cutover_authorized: false",
        `error: ${message}`,
      ].join("\n"),
    );
  }
  process.exitCode = 1;
}

function parseArgs(argv) {
  let manifest;
  let json = false;
  let describe = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") usage(0);
    if (argument === "--json") {
      if (json) usage(2, "[input] --json must not be repeated");
      json = true;
      continue;
    }
    if (argument === "--describe") {
      if (describe) usage(2, "[input] --describe must not be repeated");
      describe = true;
      continue;
    }
    if (argument !== "--manifest") {
      usage(2, "[input] unknown option");
    }
    if (manifest !== undefined) {
      usage(2, "[input] --manifest must not be repeated");
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) {
      usage(2, "[input] --manifest requires a path");
    }
    manifest = value;
  }
  if (describe) {
    if (manifest !== undefined) {
      usage(2, "[input] --describe does not accept a manifest");
    }
    return { describe: true, json };
  }
  if (manifest === undefined) usage(2, "[input] --manifest is required");
  return { describe: false, json, manifest };
}

function usage(exitCode, error) {
  if (error) console.error(error);
  console.error(
    [
      "Usage:",
      "  bun tools/verify_go_vps_cutover_evidence.mjs --manifest <manifest.json> [--json]",
      "  bun tools/verify_go_vps_cutover_evidence.mjs --describe [--json]",
      "",
      "This verifier reads only a canonical manifest and its referenced pre-generated redacted JSON evidence files.",
      "It performs no shell command, SQL statement, network request, credential read, file write, or production mutation.",
      "Even a complete packet is only eligible for production-cutover review; this CLI never authorizes cutover.",
    ].join("\n"),
  );
  process.exit(exitCode);
}

function describeContract() {
  return {
    schemaVersion: 1,
    describe: true,
    manifestContract: MANIFEST_CONTRACT,
    evidenceContract: EVIDENCE_CONTRACT,
    pinnedGoHead: PINNED_GO_HEAD,
    productionCutoverAuthorized: false,
    decisionVocabulary: [
      "not-proven",
      "eligible-for-production-cutover-review",
    ],
    evidenceStatuses: EVIDENCE_STATUSES,
    evidenceKinds: REQUIRED_EVIDENCE_KINDS,
    requiredProtocols: REQUIRED_PROTOCOLS,
    requiredBatchMaps: REQUIRED_BATCH_MAPS,
    requiredSyncDirections: REQUIRED_SYNC_DIRECTIONS,
    requiredReconciliationDomains: REQUIRED_RECONCILIATION_DOMAINS,
    requiredPendingWorkKinds: REQUIRED_PENDING_WORK_KINDS,
    requiredRollbackComponents: REQUIRED_ROLLBACK_COMPONENTS,
    constraints: {
      canonicalJsonRequired: true,
      candidateAndCohortDigestsRequired: true,
      evidenceReferencesRequired: true,
      safeIntegersRequired: true,
      strictFieldsRequired: true,
      stableSingleHandleReadsRequired: true,
      credentialsRead: false,
      linePayloadsEmitted: false,
      networkRequests: false,
      productionCutoverAuthorized: false,
      remoteMutation: false,
      shellOrSqlExecution: false,
      writesFiles: false,
    },
  };
}

function printResult(result, json) {
  if (json) {
    console.log(canonicalJson(result));
    return;
  }
  if (result.describe) {
    console.log(
      [
        "Go/VPS production cutover evidence contract",
        `manifest_contract: ${result.manifestContract}`,
        `evidence_contract: ${result.evidenceContract}`,
        `pinned_go_head: ${result.pinnedGoHead}`,
        `evidence_kinds: ${result.evidenceKinds.join(",")}`,
        "production_cutover_authorized: false",
      ].join("\n"),
    );
    return;
  }
  console.log(
    [
      "Go/VPS production cutover evidence verification",
      `ok: ${result.ok}`,
      `decision: ${result.decision}`,
      `candidate_digest_sha256: ${result.candidateDigestSha256}`,
      `cohort_digest_sha256: ${result.cohortDigestSha256}`,
      `evidence_count: ${result.evidenceCount}`,
      `blocker_count: ${result.blockers.length}`,
      "production_cutover_authorized: false",
      `expires_at: ${result.expiresAt}`,
    ].join("\n"),
  );
}
