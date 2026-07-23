import {
  CLAIMS_PATH,
  ProtocolError,
  canonicalJson,
  parseClaimRequest,
  parseExactClaimQuery,
  parseExpiryRequest,
  parseStepRequest,
  readBoundedJson,
  requireEmptyBody,
  verifyHmacRequest,
  type AuthoritySecurityEnv,
} from "./protocol";
import {
  RepositoryConflictError,
  RepositoryNotFoundError,
  RepositoryUnavailableError,
  appendStep,
  createClaim,
  expireClaim,
  readExactClaim,
  type ClaimRow,
  type ClaimSnapshot,
} from "./repository";

interface AuthorityEnv extends AuthoritySecurityEnv {
  DB: D1Database;
  CF_VERSION_METADATA: WorkerVersionMetadata;
  ENVIRONMENT: string;
  RING_TRANSITION_AUTHORITY_ENABLED: string;
  RING_TRANSITION_CLAIM_WRITE_ENABLED: string;
  RING_TRANSITION_STEP_WRITE_ENABLED: string;
  RING_TRANSITION_EXPIRY_WRITE_ENABLED: string;
}

const CLAIM_ID_PATH =
  /^\/internal\/v1\/ring-transition\/claims\/([0-9a-f]{64})$/;
const STEP_PATH =
  /^\/internal\/v1\/ring-transition\/claims\/([0-9a-f]{64})\/steps$/;
const EXPIRY_PATH =
  /^\/internal\/v1\/ring-transition\/claims\/([0-9a-f]{64})\/expire$/;
const SHA256 = /^[0-9a-f]{64}$/;

export default {
  async fetch(request: Request, env: AuthorityEnv): Promise<Response> {
    try {
      const route = matchRoute(request);
      rejectAmbientHeaders(request);
      requireAuthorityEnabled(env);
      if (
        route.kind === "claim_create" &&
        env.RING_TRANSITION_CLAIM_WRITE_ENABLED !== "true"
      ) {
        throw new ProtocolError("claim_writes_disabled", 503);
      }
      if (
        route.kind === "step_append" &&
        env.RING_TRANSITION_STEP_WRITE_ENABLED !== "true"
      ) {
        throw new ProtocolError("step_writes_disabled", 503);
      }
      if (
        route.kind === "claim_expire" &&
        env.RING_TRANSITION_EXPIRY_WRITE_ENABLED !== "true"
      ) {
        throw new ProtocolError("expiry_writes_disabled", 503);
      }

      const body =
        request.method === "GET"
          ? await requireEmptyBody(request)
          : await readBoundedJson(request);
      const authentication = await verifyHmacRequest(request, body, env);

      if (route.kind === "claim_create") {
        const claim = await parseClaimRequest(
          body,
          authentication.credentialIdSha256,
          env,
        );
        const result = await createClaim(
          env.DB,
          claim,
          authentication.credentialIdSha256,
        );
        return jsonResponse(
          result.classification === "created" ? 201 : 200,
          {
            result: result.classification,
            requestId: authentication.requestId,
            claim: publicClaimState(result.claim),
            authorityVersionId: env.CF_VERSION_METADATA.id,
          },
        );
      }

      if (route.kind === "claim_read") {
        const snapshot = await readExactClaim(
          env.DB,
          route.authorizationIdSha256,
          route.claimDigestSha256,
          route.claimOwnerSha256,
          authentication.credentialIdSha256,
        );
        return jsonResponse(200, {
          result: "exact_claim",
          requestId: authentication.requestId,
          snapshot: publicSnapshot(snapshot),
          authorityVersionId: env.CF_VERSION_METADATA.id,
        });
      }

      if (route.kind === "step_append") {
        const step = await parseStepRequest(body);
        const result = await appendStep(
          env.DB,
          route.authorizationIdSha256,
          step,
          authentication.credentialIdSha256,
        );
        return jsonResponse(
          result.classification === "step_appended" ? 201 : 200,
          {
            result: result.classification,
            requestId: authentication.requestId,
            authorizationIdSha256: result.claim.authorization_id_sha256,
            claimDigestSha256: result.claim.claim_digest_sha256,
            status: result.claim.status,
            stateVersion: result.claim.state_version,
            stepDigestSha256: result.step.step_digest_sha256,
            authorityVersionId: env.CF_VERSION_METADATA.id,
          },
        );
      }

      const event = await parseExpiryRequest(body);
      if (!SHA256.test(env.RING_TRANSITION_AUTHORITY_ACTOR_ID_SHA256)) {
        throw new ProtocolError("authority_actor_unavailable", 503);
      }
      const result = await expireClaim(
        env.DB,
        route.authorizationIdSha256,
        event,
        authentication.credentialIdSha256,
        env.RING_TRANSITION_AUTHORITY_ACTOR_ID_SHA256,
      );
      return jsonResponse(
        result.classification === "claim_expired" ? 201 : 200,
        {
          result: result.classification,
          requestId: authentication.requestId,
          authorizationIdSha256: result.claim.authorization_id_sha256,
          claimDigestSha256: result.claim.claim_digest_sha256,
          status: result.claim.status,
          stateVersion: result.claim.state_version,
          expiryEventDigestSha256:
            result.expiryEvent.expiry_event_digest_sha256,
          authorityVersionId: env.CF_VERSION_METADATA.id,
        },
      );
    } catch (error) {
      return errorResponse(error);
    }
  },
} satisfies ExportedHandler<AuthorityEnv>;

type Route =
  | { kind: "claim_create" }
  | {
      kind: "claim_read";
      authorizationIdSha256: string;
      claimDigestSha256: string;
      claimOwnerSha256: string;
    }
  | { kind: "step_append"; authorizationIdSha256: string }
  | { kind: "claim_expire"; authorizationIdSha256: string };

function matchRoute(request: Request): Route {
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === CLAIMS_PATH) {
    if (url.search.length !== 0) throw new ProtocolError("invalid_query", 400);
    return { kind: "claim_create" };
  }
  const claimMatch = CLAIM_ID_PATH.exec(url.pathname);
  if (request.method === "GET" && claimMatch !== null) {
    return { kind: "claim_read", ...parseExactClaimQuery(url) };
  }
  const stepMatch = STEP_PATH.exec(url.pathname);
  if (request.method === "POST" && stepMatch !== null) {
    if (url.search.length !== 0) throw new ProtocolError("invalid_query", 400);
    return { kind: "step_append", authorizationIdSha256: stepMatch[1]! };
  }
  const expiryMatch = EXPIRY_PATH.exec(url.pathname);
  if (request.method === "POST" && expiryMatch !== null) {
    if (url.search.length !== 0) throw new ProtocolError("invalid_query", 400);
    return { kind: "claim_expire", authorizationIdSha256: expiryMatch[1]! };
  }
  throw new ProtocolError("route_not_found", 404);
}

function rejectAmbientHeaders(request: Request): void {
  if (
    request.headers.has("content-encoding") ||
    request.headers.has("cookie") ||
    request.headers.has("origin")
  ) {
    throw new ProtocolError("forbidden_request_header", 400);
  }
}

function requireAuthorityEnabled(env: AuthorityEnv): void {
  if (
    env.ENVIRONMENT !== "staging" ||
    env.RING_TRANSITION_AUTHORITY_ENABLED !== "true"
  ) {
    throw new ProtocolError("authority_disabled", 503);
  }
}

function publicClaimState(row: ClaimRow): Record<string, unknown> {
  return {
    authorizationIdSha256: row.authorization_id_sha256,
    claimDigestSha256: row.claim_digest_sha256,
    claimOwnerSha256: row.claim_owner_sha256,
    ledgerIdentitySha256: row.ledger_identity_sha256,
    claimCredentialIdSha256: row.claim_credential_id_sha256,
    status: row.status,
    stateVersion: row.state_version,
    generatedAt: row.generated_at,
    claimedAt: row.claimed_at,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
    terminalAt: row.terminal_at,
  };
}

function publicSnapshot(snapshot: ClaimSnapshot): Record<string, unknown> {
  const row = snapshot.claim;
  return {
    claim: {
      schemaVersion: 1,
      claimAuthority: row.claim_contract,
      claimScope: row.claim_scope,
      environment: row.environment,
      authorizationIdSha256: row.authorization_id_sha256,
      executionNonceSha256: row.execution_nonce_sha256,
      authorizationManifestSha256: row.authorization_manifest_sha256,
      authorizationSubjectSha256: row.authorization_subject_sha256,
      authorizationPolicySha256: row.authorization_policy_sha256,
      transitionManifestSha256: row.transition_manifest_sha256,
      transitionSubjectSha256: row.transition_subject_sha256,
      transitionPolicySha256: row.transition_policy_sha256,
      transitionPlanSha256: row.transition_plan_sha256,
      candidateSha256: row.candidate_sha256,
      executionPlanSha256: row.execution_plan_sha256,
      accountIdSha256: row.account_id_sha256,
      ledgerIdentitySha256: row.ledger_identity_sha256,
      readCredentialIdSha256: row.read_credential_id_sha256,
      claimCredentialIdSha256: row.claim_credential_id_sha256,
      deployCredentialIdSha256: row.deploy_credential_id_sha256,
      controller: {
        serviceName: row.controller_service_name,
        previousVersionId: row.controller_previous_version_id,
        previousDeploymentSetSha256:
          row.controller_previous_deployment_set_sha256,
        targetVersionId: row.controller_target_version_id,
      },
      edge: {
        serviceName: row.edge_service_name,
        previousVersionId: row.edge_previous_version_id,
        previousDeploymentSetSha256:
          row.edge_previous_deployment_set_sha256,
        targetVersionId: row.edge_target_version_id,
      },
      runnerBuildSha256: row.runner_build_sha256,
      runnerTrustConfigSha256: row.runner_trust_config_sha256,
      claimOwnerSha256: row.claim_owner_sha256,
      claimDigestSha256: row.claim_digest_sha256,
      generatedAt: row.generated_at,
      expiresAt: row.expires_at,
    },
    state: publicClaimState(row),
    steps: snapshot.steps.map((step) => ({
      stateVersion: step.state_version,
      stepCode: step.step_code,
      fromStatus: step.from_status,
      toStatus: step.to_status,
      actorExecutionIdSha256: step.actor_execution_id_sha256,
      mutationRequestSha256: step.mutation_request_sha256,
      cloudflareRequestIdSha256: step.cloudflare_request_id_sha256,
      deploymentSetSha256: step.deployment_set_sha256,
      evidenceSha256: step.evidence_sha256,
      failureClass: step.failure_class,
      transportOutcome: step.transport_outcome,
      stepDigestSha256: step.step_digest_sha256,
      recordedAt: step.recorded_at,
    })),
    expiryEvents: snapshot.expiryEvents.map((event) => ({
      stateVersion: event.state_version,
      fromStatus: event.from_status,
      toStatus: event.to_status,
      authorityActorIdSha256: event.authority_actor_id_sha256,
      evidenceSha256: event.evidence_sha256,
      expiryEventDigestSha256: event.expiry_event_digest_sha256,
      failureClass: event.failure_class,
      recordedAt: event.recorded_at,
    })),
  };
}

function errorResponse(error: unknown): Response {
  if (error instanceof ProtocolError) {
    return jsonResponse(error.status, { error: error.code });
  }
  if (error instanceof RepositoryConflictError) {
    return jsonResponse(409, { error: error.code });
  }
  if (error instanceof RepositoryNotFoundError) {
    return jsonResponse(404, { error: "claim_not_found" });
  }
  if (error instanceof RepositoryUnavailableError) {
    return jsonResponse(503, {
      error: error.outcomeUnknown ? "outcome_unknown" : "repository_unavailable",
      outcomeUnknown: error.outcomeUnknown,
    });
  }
  return jsonResponse(503, { error: "service_unavailable" });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(canonicalJson(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}
