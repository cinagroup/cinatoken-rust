import {
  canonicalJson,
  sha256Hex,
  type AuthoritySecurityEnv,
  type Claim,
} from "../src/protocol";
import type { ClaimRow } from "../src/repository";

export const NOW = 2_000_000_000;
export const CURRENT_SECRET = "c".repeat(48);
export const PREVIOUS_SECRET = "p".repeat(48);
export const CURRENT_CREDENTIAL = "c".repeat(64);
export const PREVIOUS_CREDENTIAL = "d".repeat(64);
export const OWNER = "e".repeat(64);
export const AUTHORIZATION_ID = "a".repeat(64);
export const LEDGER = "b".repeat(64);

export async function buildClaim(
  overrides: Partial<Claim> = {},
): Promise<Claim> {
  const claimWithoutDigest = {
    schemaVersion: 1 as const,
    contract:
      "cinatoken-relay-container-ring-transition-execution-claim-v1" as const,
    claimAuthority: "d1-unique-claim-v1" as const,
    claimScope: "staging-worker-ring-transition" as const,
    environment: "staging" as const,
    authorizationIdSha256: AUTHORIZATION_ID,
    executionNonceSha256: "1".repeat(64),
    authorizationManifestSha256: "2".repeat(64),
    authorizationSubjectSha256: "3".repeat(64),
    authorizationPolicySha256: "4".repeat(64),
    transitionManifestSha256: "5".repeat(64),
    transitionSubjectSha256: "6".repeat(64),
    transitionPolicySha256: "7".repeat(64),
    transitionPlanSha256: "8".repeat(64),
    candidateSha256: "9".repeat(64),
    executionPlanSha256: "0".repeat(64),
    accountIdSha256: "a".repeat(64),
    ledgerIdentitySha256: LEDGER,
    readCredentialIdSha256: "f".repeat(64),
    claimCredentialIdSha256: CURRENT_CREDENTIAL,
    deployCredentialIdSha256: "1".repeat(64),
    controller: {
      serviceName: "cinatoken-container-controller-staging",
      previousVersionId: "controller-old",
      previousDeploymentSetSha256: "2".repeat(64),
      targetVersionId: "controller-new",
    },
    edge: {
      serviceName: "cinatoken-edge-staging",
      previousVersionId: "edge-old",
      previousDeploymentSetSha256: "3".repeat(64),
      targetVersionId: "edge-new",
    },
    runnerBuildSha256: "4".repeat(64),
    runnerTrustConfigSha256: "5".repeat(64),
    claimOwnerSha256: OWNER,
    generatedAt: NOW - 1,
    expiresAt: NOW + 120,
  };
  const merged = { ...claimWithoutDigest, ...overrides };
  const claimDigestSha256 = await sha256Hex(
    new TextEncoder().encode(canonicalJson(merged)),
  );
  return { ...merged, claimDigestSha256 } as Claim;
}

export function claimRow(claim: Claim): ClaimRow {
  return {
    authorization_id_sha256: claim.authorizationIdSha256,
    execution_nonce_sha256: claim.executionNonceSha256,
    claim_contract: claim.claimAuthority,
    claim_scope: claim.claimScope,
    environment: claim.environment,
    authorization_manifest_sha256: claim.authorizationManifestSha256,
    authorization_subject_sha256: claim.authorizationSubjectSha256,
    authorization_policy_sha256: claim.authorizationPolicySha256,
    transition_manifest_sha256: claim.transitionManifestSha256,
    transition_subject_sha256: claim.transitionSubjectSha256,
    transition_policy_sha256: claim.transitionPolicySha256,
    transition_plan_sha256: claim.transitionPlanSha256,
    candidate_sha256: claim.candidateSha256,
    execution_plan_sha256: claim.executionPlanSha256,
    account_id_sha256: claim.accountIdSha256,
    ledger_identity_sha256: claim.ledgerIdentitySha256,
    read_credential_id_sha256: claim.readCredentialIdSha256,
    claim_credential_id_sha256: claim.claimCredentialIdSha256,
    deploy_credential_id_sha256: claim.deployCredentialIdSha256,
    controller_service_name: claim.controller.serviceName,
    controller_previous_version_id: claim.controller.previousVersionId,
    controller_previous_deployment_set_sha256:
      claim.controller.previousDeploymentSetSha256,
    controller_target_version_id: claim.controller.targetVersionId,
    edge_service_name: claim.edge.serviceName,
    edge_previous_version_id: claim.edge.previousVersionId,
    edge_previous_deployment_set_sha256:
      claim.edge.previousDeploymentSetSha256,
    edge_target_version_id: claim.edge.targetVersionId,
    runner_build_sha256: claim.runnerBuildSha256,
    runner_trust_config_sha256: claim.runnerTrustConfigSha256,
    claim_owner_sha256: claim.claimOwnerSha256,
    claim_digest_sha256: claim.claimDigestSha256,
    status: "claimed",
    state_version: 0,
    generated_at: claim.generatedAt,
    claimed_at: NOW,
    expires_at: claim.expiresAt,
    updated_at: NOW,
    terminal_at: null,
  };
}

export function securityEnv(
  overrides: Partial<AuthoritySecurityEnv> = {},
): AuthoritySecurityEnv {
  return {
    RING_TRANSITION_AUTHORITY_ISSUER: "runner-staging",
    RING_TRANSITION_AUTHORITY_AUDIENCE: "authority-staging",
    RING_TRANSITION_HMAC_CURRENT_KID: "current-v1",
    RING_TRANSITION_HMAC_CURRENT_CREDENTIAL_ID_SHA256: CURRENT_CREDENTIAL,
    RING_TRANSITION_HMAC_CURRENT_SECRET: CURRENT_SECRET,
    RING_TRANSITION_HMAC_PREVIOUS_KID: "previous-v1",
    RING_TRANSITION_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256: PREVIOUS_CREDENTIAL,
    RING_TRANSITION_HMAC_PREVIOUS_SECRET: PREVIOUS_SECRET,
    RING_TRANSITION_PERMIT_ISSUER: "permit-issuer",
    RING_TRANSITION_PERMIT_KEY_ID: "permit-v1",
    RING_TRANSITION_PERMIT_SPKI_BASE64URL: "",
    RING_TRANSITION_PERMIT_SPKI_SHA256: "",
    RING_TRANSITION_AUTHORITY_ACTOR_ID_SHA256: "6".repeat(64),
    ...overrides,
  };
}
