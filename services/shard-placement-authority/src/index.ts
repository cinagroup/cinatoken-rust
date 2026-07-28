import {
  AUTHORIZATIONS_PATH,
  PREFLIGHT_PATH,
  ProtocolError,
  canonicalJson,
  parseExactAuthorizationQuery,
  parseIssuanceRequest,
  parseRevocationRequest,
  readBoundedJson,
  requireEmptyBody,
  verifyHmacRequest,
  type HmacRole,
  type ShardPlacementAuthoritySecurityEnv,
} from "./protocol";
import {
  RepositoryConflictError,
  RepositoryNotFoundError,
  RepositoryUnavailableError,
  createIssuance,
  readExactIssuance,
  revokeIssuance,
  type IssuanceRow,
} from "./repository";

export interface AuthorityEnv extends ShardPlacementAuthoritySecurityEnv {
  DB: D1Database;
  CF_VERSION_METADATA: WorkerVersionMetadata;
  ENVIRONMENT: string;
  SHARD_PLACEMENT_AUTHORITY_ENABLED: string;
  SHARD_PLACEMENT_AUTHORITY_READ_ENABLED: string;
  SHARD_PLACEMENT_AUTHORITY_ISSUE_WRITE_ENABLED: string;
  SHARD_PLACEMENT_AUTHORITY_REVOKE_WRITE_ENABLED: string;
}

const AUTHORIZATION_ID_PATH =
  /^\/internal\/v1\/shard-placement\/authorizations\/([0-9a-f]{64})$/;
const REVOCATION_PATH =
  /^\/internal\/v1\/shard-placement\/authorizations\/([0-9a-f]{64})\/revoke$/;
const SHA256 = /^[0-9a-f]{64}$/;
const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export default {
  async fetch(request: Request, env: AuthorityEnv): Promise<Response> {
    try {
      const route = matchRoute(request);
      rejectAmbientHeaders(request);
      requireAuthorityEnabled(env);
      requireRouteGate(route.kind, env);
      validateRuntimeTrustConfiguration(env);

      const body =
        request.method === "GET"
          ? await requireEmptyBody(request)
          : await readBoundedJson(request);
      const authentication = await verifyHmacRequest(
        request,
        body,
        routeRole(route.kind),
        env,
      );

      if (route.kind === "preflight") {
        return jsonResponse(200, {
          result: "authority_ready",
          requestId: authentication.requestId,
          credentialIdSha256: authentication.credentialIdSha256,
          policyId: env.SHARD_PLACEMENT_AUTHORITY_POLICY_ID,
          policySha256: env.SHARD_PLACEMENT_AUTHORITY_POLICY_SHA256,
          permitSpkiSha256:
            env.SHARD_PLACEMENT_PERMIT_SPKI_SHA256,
          approvalSpkiSha256: {
            security: env.SHARD_PLACEMENT_SECURITY_SPKI_SHA256,
            operations: env.SHARD_PLACEMENT_OPERATIONS_SPKI_SHA256,
            release: env.SHARD_PLACEMENT_RELEASE_SPKI_SHA256,
            rollback: env.SHARD_PLACEMENT_ROLLBACK_SPKI_SHA256,
          },
          authorityVersionId: env.CF_VERSION_METADATA.id,
        });
      }

      if (route.kind === "issuance_create") {
        const issuance = await parseIssuanceRequest(body, env);
        const result = await createIssuance(
          env.DB,
          issuance,
          authentication.credentialIdSha256,
          env.CF_VERSION_METADATA.id,
        );
        return jsonResponse(
          result.classification === "created" ? 201 : 200,
          {
            result: result.classification,
            requestId: authentication.requestId,
            authorization: publicIssuance(result.issuance),
          },
        );
      }

      if (route.kind === "issuance_read") {
        const row = await readExactIssuance(
          env.DB,
          route.authorizationIdSha256,
          route.permitSubjectDigestSha256,
          route.campaignId,
        );
        return jsonResponse(200, {
          result: "exact_authorization",
          requestId: authentication.requestId,
          authorization: publicIssuance(row),
        });
      }

      const revocation = await parseRevocationRequest(body);
      if (
        revocation.authorizationIdSha256
        !== route.authorizationIdSha256
      ) {
        throw new ProtocolError("revocation_path_mismatch", 400);
      }
      const result = await revokeIssuance(
        env.DB,
        revocation,
        authentication.credentialIdSha256,
      );
      return jsonResponse(
        result.classification === "revoked" ? 201 : 200,
        {
          result: result.classification,
          requestId: authentication.requestId,
          authorizationIdSha256:
            result.revocation.authorization_id_sha256,
          permitSubjectDigestSha256:
            result.revocation.permit_subject_digest_sha256,
          reasonCode: result.revocation.reason_code,
          evidenceSha256: result.revocation.evidence_sha256,
          revocationEventSha256:
            result.revocation.revocation_event_sha256,
          recordedAt: result.revocation.recorded_at,
          authorityVersionId: env.CF_VERSION_METADATA.id,
        },
      );
    } catch (error) {
      return errorResponse(error);
    }
  },
} satisfies ExportedHandler<AuthorityEnv>;

type Route =
  | { kind: "preflight" }
  | { kind: "issuance_create" }
  | {
      kind: "issuance_read";
      authorizationIdSha256: string;
      permitSubjectDigestSha256: string;
      campaignId: string;
    }
  | {
      kind: "issuance_revoke";
      authorizationIdSha256: string;
    };

function matchRoute(request: Request): Route {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === PREFLIGHT_PATH) {
    if (url.search.length !== 0) {
      throw new ProtocolError("invalid_query", 400);
    }
    return { kind: "preflight" };
  }
  if (request.method === "POST" && url.pathname === AUTHORIZATIONS_PATH) {
    if (url.search.length !== 0) {
      throw new ProtocolError("invalid_query", 400);
    }
    return { kind: "issuance_create" };
  }
  const authorizationMatch = AUTHORIZATION_ID_PATH.exec(url.pathname);
  if (request.method === "GET" && authorizationMatch !== null) {
    return {
      kind: "issuance_read",
      authorizationIdSha256: authorizationMatch[1]!,
      ...parseExactAuthorizationQuery(url),
    };
  }
  const revocationMatch = REVOCATION_PATH.exec(url.pathname);
  if (request.method === "POST" && revocationMatch !== null) {
    if (url.search.length !== 0) {
      throw new ProtocolError("invalid_query", 400);
    }
    return {
      kind: "issuance_revoke",
      authorizationIdSha256: revocationMatch[1]!,
    };
  }
  throw new ProtocolError("route_not_found", 404);
}

function routeRole(kind: Route["kind"]): HmacRole {
  if (kind === "issuance_create") return "issue";
  if (kind === "issuance_revoke") return "revoke";
  return "read";
}

function rejectAmbientHeaders(request: Request): void {
  if (
    request.headers.has("content-encoding")
    || request.headers.has("cookie")
    || request.headers.has("origin")
  ) {
    throw new ProtocolError("forbidden_request_header", 400);
  }
}

function requireAuthorityEnabled(env: AuthorityEnv): void {
  if (
    env.ENVIRONMENT !== "staging"
    || env.SHARD_PLACEMENT_AUTHORITY_ENABLED !== "true"
  ) {
    throw new ProtocolError("authority_disabled", 503);
  }
}

function requireRouteGate(
  kind: Route["kind"],
  env: AuthorityEnv,
): void {
  if (
    (kind === "preflight" || kind === "issuance_read")
    && env.SHARD_PLACEMENT_AUTHORITY_READ_ENABLED !== "true"
  ) {
    throw new ProtocolError("authority_reads_disabled", 503);
  }
  if (
    kind === "issuance_create"
    && env.SHARD_PLACEMENT_AUTHORITY_ISSUE_WRITE_ENABLED !== "true"
  ) {
    throw new ProtocolError("authority_issuance_disabled", 503);
  }
  if (
    kind === "issuance_revoke"
    && env.SHARD_PLACEMENT_AUTHORITY_REVOKE_WRITE_ENABLED !== "true"
  ) {
    throw new ProtocolError("authority_revocation_disabled", 503);
  }
}

export function validateRuntimeTrustConfiguration(
  env: ShardPlacementAuthoritySecurityEnv,
): void {
  const policyIdentity = [
    env.SHARD_PLACEMENT_AUTHORITY_POLICY_ID,
    env.SHARD_PLACEMENT_PERMIT_KEY_ID,
    env.SHARD_PLACEMENT_SECURITY_KEY_ID,
    env.SHARD_PLACEMENT_OPERATIONS_KEY_ID,
    env.SHARD_PLACEMENT_RELEASE_KEY_ID,
    env.SHARD_PLACEMENT_ROLLBACK_KEY_ID,
  ];
  if (
    !POLICY_KEY_ID(env.SHARD_PLACEMENT_AUTHORITY_POLICY_ID)
    || !IDENTITY.test(env.SHARD_PLACEMENT_AUTHORITY_ISSUER)
    || !IDENTITY.test(env.SHARD_PLACEMENT_AUTHORITY_AUDIENCE)
    || !IDENTITY.test(env.SHARD_PLACEMENT_PERMIT_ISSUER)
    || policyIdentity.slice(1).some((value) => !KEY_ID.test(value))
    || new Set(policyIdentity.slice(1)).size !== 5
  ) {
    throw new ProtocolError("authority_trust_unavailable", 503);
  }
  const fingerprints = [
    env.SHARD_PLACEMENT_AUTHORITY_POLICY_SHA256,
    env.SHARD_PLACEMENT_PERMIT_SPKI_SHA256,
    env.SHARD_PLACEMENT_SECURITY_SPKI_SHA256,
    env.SHARD_PLACEMENT_OPERATIONS_SPKI_SHA256,
    env.SHARD_PLACEMENT_RELEASE_SPKI_SHA256,
    env.SHARD_PLACEMENT_ROLLBACK_SPKI_SHA256,
  ];
  if (
    fingerprints.some((value) => !SHA256.test(value))
    || new Set(fingerprints.slice(1)).size !== 5
  ) {
    throw new ProtocolError("authority_trust_unavailable", 503);
  }
  requireHmacCredentialIsolation(env);
}

function POLICY_KEY_ID(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value);
}

function requireHmacCredentialIsolation(
  env: ShardPlacementAuthoritySecurityEnv,
): void {
  const values = env as unknown as Record<string, string | undefined>;
  const active: Array<{
    kid: string;
    credentialIdSha256: string;
    secret: string;
  }> = [];
  for (const role of ["READ", "ISSUE", "REVOKE"] as const) {
    const prefix = `SHARD_PLACEMENT_${role}_HMAC`;
    const current = {
      kid: values[`${prefix}_CURRENT_KID`] ?? "",
      credentialIdSha256:
        values[`${prefix}_CURRENT_CREDENTIAL_ID_SHA256`] ?? "",
      secret: values[`${prefix}_CURRENT_SECRET`] ?? "",
    };
    if (!validHmacCredential(current)) {
      throw new ProtocolError(
        "authority_credential_isolation_unavailable",
        503,
      );
    }
    active.push(current);

    const previous = {
      kid: values[`${prefix}_PREVIOUS_KID`] ?? "",
      credentialIdSha256:
        values[`${prefix}_PREVIOUS_CREDENTIAL_ID_SHA256`] ?? "",
      secret: values[`${prefix}_PREVIOUS_SECRET`] ?? "",
    };
    const previousConfigured = Object.values(previous).some(
      (value) => value.length > 0,
    );
    if (previousConfigured) {
      if (!validHmacCredential(previous)) {
        throw new ProtocolError(
          "authority_credential_isolation_unavailable",
          503,
        );
      }
      active.push(previous);
    }
  }
  if (
    new Set(active.map((credential) => credential.kid)).size
      !== active.length
    || new Set(
      active.map((credential) => credential.credentialIdSha256),
    ).size !== active.length
    || new Set(active.map((credential) => credential.secret)).size
      !== active.length
  ) {
    throw new ProtocolError(
      "authority_credential_isolation_unavailable",
      503,
    );
  }
}

function validHmacCredential(value: {
  kid: string;
  credentialIdSha256: string;
  secret: string;
}): boolean {
  return (
    KEY_ID.test(value.kid)
    && SHA256.test(value.credentialIdSha256)
    && value.secret.length >= 32
    && value.secret.length <= 256
  );
}

function publicIssuance(row: IssuanceRow): Record<string, unknown> {
  const revoked = row.revoked_at !== null;
  const expired = row.database_now >= row.permit_expires_at;
  return {
    schemaVersion: 1,
    contract:
      "cinatoken-relay-shard-placement-mutation-authority-readback-v1",
    status: revoked ? "revoked" : expired ? "expired" : "active",
    authorizationIdSha256: row.authorization_id_sha256,
    executionNonceSha256: row.execution_nonce_sha256,
    campaignId: row.campaign_id,
    campaignNonceSha256: row.campaign_nonce_sha256,
    permitSubjectDigestSha256:
      row.permit_subject_digest_sha256,
    issuanceRequestSha256: row.issuance_request_sha256,
    approvalsDigestSha256: row.approvals_digest_sha256,
    policyId: row.policy_id,
    policySha256: row.policy_sha256,
    permitIssuer: row.permit_issuer,
    permitKeyId: row.permit_key_id,
    permitSignerSpkiSha256: row.permit_signer_spki_sha256,
    environment: row.environment,
    controllerServiceName: row.controller_service_name,
    controllerVersionId: row.controller_version_id,
    actionGateInventorySha256:
      row.action_gate_inventory_sha256,
    foundationManifestSha256:
      row.foundation_manifest_sha256,
    runtimeBuildId: row.runtime_build_id,
    ringGeneration: row.ring_generation,
    shardCount: row.shard_count,
    campaignLifetimeSeconds: row.campaign_lifetime_seconds,
    permitIssuedAt: row.permit_issued_at,
    permitExpiresAt: row.permit_expires_at,
    approvals: [
      publicApproval(row, "security"),
      publicApproval(row, "operations"),
      publicApproval(row, "release"),
      publicApproval(row, "rollback"),
    ],
    issueCredentialIdSha256: row.issue_credential_id_sha256,
    authorityVersionId: row.authority_version_id,
    recordedAt: row.recorded_at,
    revocation: revoked
      ? {
          reasonCode: row.revocation_reason_code,
          evidenceSha256: row.revocation_evidence_sha256,
          revocationEventSha256: row.revocation_event_sha256,
          revokeCredentialIdSha256:
            row.revoke_credential_id_sha256,
          recordedAt: row.revoked_at,
        }
      : null,
  };
}

function publicApproval(
  row: IssuanceRow,
  role: "security" | "operations" | "release" | "rollback",
): Record<string, unknown> {
  return {
    role,
    keyId: row[`${role}_key_id`],
    spkiSha256: row[`${role}_spki_sha256`],
    signedAt: row[`${role}_signed_at`],
    expiresAt: row[`${role}_expires_at`],
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
    return jsonResponse(404, { error: "authorization_not_found" });
  }
  if (error instanceof RepositoryUnavailableError) {
    return jsonResponse(503, {
      error: error.outcomeUnknown
        ? "outcome_unknown"
        : "repository_unavailable",
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
