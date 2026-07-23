#!/usr/bin/env bun

import {
  MAX_RING_TRANSITION_AUTHORIZATION_SECONDS,
  MIN_RING_TRANSITION_AUTHORIZATION_LEAD_SECONDS,
  RING_TRANSITION_AUTHORIZATION_APPROVAL_DOMAIN,
  RING_TRANSITION_AUTHORIZATION_DECISION,
  RING_TRANSITION_AUTHORIZATION_EVIDENCE_CONTRACT,
  RING_TRANSITION_AUTHORIZATION_EVIDENCE_KINDS,
  RING_TRANSITION_AUTHORIZATION_MANIFEST_CONTRACT,
  RING_TRANSITION_AUTHORIZATION_ROLES,
  RING_TRANSITION_AUTHORIZATION_TRUST_POLICY_CONTRACT,
  verifyRingTransitionMutationAuthorization,
} from "./relay_container_ring_transition_authorization_contract.mjs";

try {
  const options = parseArgs(process.argv.slice(2));
  const result = options.describe
    ? describeContract()
    : await verifyRingTransitionMutationAuthorization({
        transitionManifestPath: options.transitionManifest,
        transitionTrustPolicyPath: options.transitionTrustPolicy,
        authorizationManifestPath: options.authorizationManifest,
        authorizationTrustPolicyPath: options.authorizationTrustPolicy,
      });
  printResult(result, options.json);
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : "ring transition mutation authorization verification failed",
  );
  process.exit(1);
}

function parseArgs(argv) {
  const values = new Map();
  const seenFlags = new Set();
  let describe = false;
  let json = false;
  const pathOptions = new Set([
    "--transition-manifest",
    "--transition-trust-policy",
    "--authorization-manifest",
    "--authorization-trust-policy",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") usage(0);
    if (argument === "--describe" || argument === "--json") {
      if (seenFlags.has(argument)) {
        usage(2, `[input] ${argument} must not be repeated`);
      }
      seenFlags.add(argument);
      if (argument === "--describe") describe = true;
      if (argument === "--json") json = true;
      continue;
    }
    if (!pathOptions.has(argument)) {
      usage(2, `[input] unknown option: ${argument}`);
    }
    if (values.has(argument)) {
      usage(2, `[input] ${argument} must not be repeated`);
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) {
      usage(2, `[input] ${argument} requires a path`);
    }
    values.set(argument, value);
  }
  if (describe) {
    if (values.size > 0) {
      usage(2, "[input] --describe does not accept evidence paths");
    }
    return { describe: true, json };
  }
  for (const option of pathOptions) {
    if (!values.has(option)) usage(2, `[input] ${option} is required`);
  }
  return {
    describe: false,
    json,
    transitionManifest: values.get("--transition-manifest"),
    transitionTrustPolicy: values.get("--transition-trust-policy"),
    authorizationManifest: values.get("--authorization-manifest"),
    authorizationTrustPolicy: values.get("--authorization-trust-policy"),
  };
}

function describeContract() {
  return {
    ok: true,
    schemaVersion: 1,
    describe: true,
    manifestContract: RING_TRANSITION_AUTHORIZATION_MANIFEST_CONTRACT,
    trustPolicyContract:
      RING_TRANSITION_AUTHORIZATION_TRUST_POLICY_CONTRACT,
    evidenceContract: RING_TRANSITION_AUTHORIZATION_EVIDENCE_CONTRACT,
    approvalDomain: RING_TRANSITION_AUTHORIZATION_APPROVAL_DOMAIN,
    approvalRoles: RING_TRANSITION_AUTHORIZATION_ROLES,
    evidenceKinds: RING_TRANSITION_AUTHORIZATION_EVIDENCE_KINDS,
    environment: "staging",
    decision: RING_TRANSITION_AUTHORIZATION_DECISION,
    constraints: {
      maximumAuthorizationSeconds:
        MAX_RING_TRANSITION_AUTHORIZATION_SECONDS,
      minimumExecutionLeadSeconds:
        MIN_RING_TRANSITION_AUTHORIZATION_LEAD_SECONDS,
      transitionReviewReverified: true,
      externalDistinctTrustPolicyRequired: true,
      canonicalEvidenceArtifactsRequired: true,
      distinctReadClaimDeployCredentialsRequired: true,
      claimLedgerMigration:
        "0060_relay_container_ring_transition_authority.sql",
      atomicSingleUseRemoteClaimRequired: true,
      authenticatedT1ReadbackRequired: true,
      controllerFirstRequired: true,
      controllerPostReadbackRequired: true,
      edgePreReadbackRequired: true,
      edgePostReadbackRequired: true,
      applicationLevelOptimisticCasOnly: true,
      cloudflareNativeAtomicCasClaimed: false,
      offlineSignedAuthorizationVerified: true,
      trustedPolicyAnchorVerified: false,
      runnerTrustedPolicyAnchorRequired: true,
      authorizesRemoteMutation: false,
      credentialsReadByVerifier: false,
      networkRequestsPerformedByVerifier: false,
      filesWrittenByVerifier: false,
      shellCommandsExecutedByVerifier: false,
      mutationPerformedByVerifier: false,
      customerTrafficAuthorized: false,
      paidProviderCallsAuthorized: false,
      productionCutoverAuthorized: false,
      versionUploadAuthorized: false,
      resourceMutationAuthorized: false,
      secretMutationAuthorized: false,
      cleanupMutationAuthorized: false,
      deploymentDeletionAuthorized: false,
      generationRollbackAuthorized: false,
      goVpsShutdownAuthorized: false,
    },
  };
}

function usage(exitCode, error) {
  if (error) console.error(error);
  console.error(
    [
      "Usage:",
      "  bun tools/verify_relay_container_ring_transition_authorization.mjs --transition-manifest <manifest.json> --transition-trust-policy <policy.json> --authorization-manifest <authorization.json> --authorization-trust-policy <policy.json> [--json]",
      "  bun tools/verify_relay_container_ring_transition_authorization.mjs --describe [--json]",
      "",
      "The verifier is credential-free, offline, and read-only. It validates signatures but does not establish a runner trust root or authorize remote mutation.",
      "A future staging runner must pin both policy digests outside caller control, atomically claim the nonce, and repeat authenticated deployment-set readbacks around every mutation.",
      "Production, customer/provider traffic, version upload, resource/secret mutation, cleanup, deletion, and generation rollback remain unauthorized.",
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
        "Relay Container ring transition mutation authorization contract",
        `manifest_contract: ${result.manifestContract}`,
        `approval_roles: ${result.approvalRoles.join(",")}`,
        `maximum_authorization_seconds: ${result.constraints.maximumAuthorizationSeconds}`,
        "application_level_optimistic_cas_only: true",
        "cloudflare_native_atomic_cas_claimed: false",
        "trusted_policy_anchor_verified: false",
        "authorizes_remote_mutation: false",
        "mutation_performed_by_verifier: false",
        "production_cutover_authorized: false",
      ].join("\n"),
    );
    return;
  }
  console.log(
    [
      "Relay Container ring transition mutation authorization verification",
      `ok: ${result.ok}`,
      `decision: ${result.decision}`,
      `authorization_id_sha256: ${result.authorizationIdSha256}`,
      `execution_plan_digest_sha256: ${result.executionPlanDigestSha256}`,
      `remote_mutation_authorized: ${result.remoteMutationAuthorized}`,
      `atomic_remote_claim_required: ${result.atomicRemoteClaimRequired}`,
      `mutation_performed_by_verifier: ${result.mutationPerformedByVerifier}`,
      `production_cutover_authorized: ${result.productionCutoverAuthorized}`,
      `expires_at: ${result.expiresAt}`,
    ].join("\n"),
  );
}
