import {
  activateExecutionTicket,
  parseActivateTicketCommand,
} from "./activate_ticket";
import {
  validateApplicationActivationClientConfig,
  type ApplicationActivationClientEnv,
} from "./application_activation_client";
import {
  validateApplicationAuthorityAckClientConfig,
  type ApplicationAuthorityAckClientEnv,
} from "./application_ack_client";
import {
  beginControllerEnable,
  parseBeginEnableCommand,
} from "./begin_enable";
import {
  parsePrepareEnableDispatchCommand,
  prepareControllerEnableDispatch,
} from "./prepare_enable_dispatch";
import {
  EXECUTION_CLAIMS_PATH,
  parseExactExecutionClaimQuery,
  parseExecutionClaim,
  parseExecutionReceipt,
} from "./execution_protocol";
import {
  appendExecutionReceipt,
  createExecutionClaim,
  readExactExecutionClaim,
  type ExecutionClaimSnapshot,
} from "./execution_repository";
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

export interface AuthorityEnv
  extends
    ShardPlacementAuthoritySecurityEnv,
    ApplicationActivationClientEnv,
    ApplicationAuthorityAckClientEnv {
  DB: D1Database;
  CF_VERSION_METADATA: WorkerVersionMetadata;
  ENVIRONMENT: string;
  SHARD_PLACEMENT_AUTHORITY_ENABLED: string;
  SHARD_PLACEMENT_AUTHORITY_READ_ENABLED: string;
  SHARD_PLACEMENT_AUTHORITY_ISSUE_WRITE_ENABLED: string;
  SHARD_PLACEMENT_AUTHORITY_REVOKE_WRITE_ENABLED: string;
  SHARD_PLACEMENT_AUTHORITY_CLAIM_WRITE_ENABLED: string;
  SHARD_PLACEMENT_AUTHORITY_RECEIPT_WRITE_ENABLED: string;
  SHARD_PLACEMENT_AUTHORITY_RECOVERY_WRITE_ENABLED: string;
  SHARD_PLACEMENT_AUTHORITY_ACTIVATION_READ_ENABLED: string;
  SHARD_PLACEMENT_AUTHORITY_ACTIVATION_WRITE_ENABLED: string;
  SHARD_PLACEMENT_AUTHORITY_PRE_ENABLE_READ_ENABLED: string;
  SHARD_PLACEMENT_AUTHORITY_ENABLE_INTENT_WRITE_ENABLED: string;
  SHARD_PLACEMENT_AUTHORITY_PRE_DISPATCH_READ_ENABLED: string;
  SHARD_PLACEMENT_AUTHORITY_DISPATCH_OUTBOX_WRITE_ENABLED: string;
  SHARD_PLACEMENT_APPLICATION_DATABASE_IDENTITY_SHA256: string;
  SHARD_PLACEMENT_AUTHORITY_DATABASE_IDENTITY_SHA256: string;
  SHARD_PLACEMENT_AUTHORITY_LEDGER_IDENTITY_SHA256: string;
}

const AUTHORIZATION_ID_PATH =
  /^\/internal\/v1\/shard-placement\/authorizations\/([0-9a-f]{64})$/;
const REVOCATION_PATH =
  /^\/internal\/v1\/shard-placement\/authorizations\/([0-9a-f]{64})\/revoke$/;
const EXECUTION_CLAIM_ID_PATH =
  /^\/internal\/v1\/shard-placement\/execution-claims\/([0-9a-f]{64})$/;
const EXECUTION_RECEIPT_PATH =
  /^\/internal\/v1\/shard-placement\/execution-claims\/([0-9a-f]{64})\/receipts$/;
const EXECUTION_RENEW_PATH =
  /^\/internal\/v1\/shard-placement\/execution-claims\/([0-9a-f]{64})\/renew$/;
const EXECUTION_TAKEOVER_PATH =
  /^\/internal\/v1\/shard-placement\/execution-claims\/([0-9a-f]{64})\/takeover$/;
const EXECUTION_SAFETY_DIVERT_PATH =
  /^\/internal\/v1\/shard-placement\/execution-claims\/([0-9a-f]{64})\/safety-divert$/;
const EXECUTION_ACTIVATE_TICKET_PATH =
  /^\/internal\/v1\/shard-placement\/execution-claims\/([0-9a-f]{64})\/activate-ticket$/;
const EXECUTION_BEGIN_ENABLE_PATH =
  /^\/internal\/v1\/shard-placement\/execution-claims\/([0-9a-f]{64})\/begin-enable$/;
const EXECUTION_PREPARE_ENABLE_DISPATCH_PATH =
  /^\/internal\/v1\/shard-placement\/execution-claims\/([0-9a-f]{64})\/prepare-enable-dispatch$/;
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
          applicationDatabaseIdentitySha256:
            env.SHARD_PLACEMENT_APPLICATION_DATABASE_IDENTITY_SHA256,
          authorityDatabaseIdentitySha256:
            env.SHARD_PLACEMENT_AUTHORITY_DATABASE_IDENTITY_SHA256,
          authorityLedgerIdentitySha256:
            env.SHARD_PLACEMENT_AUTHORITY_LEDGER_IDENTITY_SHA256,
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

      if (route.kind === "execution_claim_create") {
        const claim = await parseExecutionClaim(
          body,
          authentication,
        );
        if (
          claim.applicationDatabaseIdentitySha256
            !== env.SHARD_PLACEMENT_APPLICATION_DATABASE_IDENTITY_SHA256
          || claim.authorityDatabaseIdentitySha256
            !== env.SHARD_PLACEMENT_AUTHORITY_DATABASE_IDENTITY_SHA256
          || claim.ledgerIdentitySha256
            !== env.SHARD_PLACEMENT_AUTHORITY_LEDGER_IDENTITY_SHA256
        ) {
          throw new ProtocolError(
            "execution_claim_database_identity_mismatch",
            403,
          );
        }
        const result = await createExecutionClaim(env.DB, claim);
        return jsonResponse(
          result.classification === "created" ? 201 : 200,
          {
            result: result.classification,
            requestId: authentication.requestId,
            snapshot: publicExecutionSnapshot(result.snapshot),
            authorityVersionId: env.CF_VERSION_METADATA.id,
          },
        );
      }

      if (route.kind === "execution_claim_read") {
        const snapshot = await readExactExecutionClaim(
          env.DB,
          route.authorizationIdSha256,
          route.claimDigestSha256,
          route.claimOwnerSha256,
        );
        return jsonResponse(200, {
          result: "exact_execution_claim",
          requestId: authentication.requestId,
          snapshot: publicExecutionSnapshot(snapshot),
          authorityVersionId: env.CF_VERSION_METADATA.id,
        });
      }

      if (route.kind === "execution_activate_ticket") {
        const command = parseActivateTicketCommand(body);
        if (
          command.authorizationIdSha256
            !== route.authorizationIdSha256
        ) {
          throw new ProtocolError("operation4_path_mismatch", 400);
        }
        const result = await activateExecutionTicket(
          env,
          command,
          authentication,
        );
        return jsonResponse(
          result.result === "activated" ? 201 : 200,
          {
            contract:
              "cinatoken-shard-placement-authority-activate-ticket-result-v1",
            ...result,
          },
        );
      }

      if (route.kind === "execution_begin_enable") {
        const command = parseBeginEnableCommand(body);
        if (
          command.authorizationIdSha256
            !== route.authorizationIdSha256
        ) {
          throw new ProtocolError("operation_five_path_mismatch", 400);
        }
        const result = await beginControllerEnable(
          env,
          command,
          authentication,
        );
        return jsonResponse(
          result.result === "enable_intent_recorded" ? 201 : 200,
          {
            contract:
              "cinatoken-shard-placement-authority-begin-enable-result-v1",
            ...result,
          },
        );
      }

      if (route.kind === "execution_prepare_enable_dispatch") {
        const command = parsePrepareEnableDispatchCommand(body);
        if (
          command.authorizationIdSha256
            !== route.authorizationIdSha256
        ) {
          throw new ProtocolError(
            "operation_five_dispatch_path_mismatch",
            400,
          );
        }
        const result = await prepareControllerEnableDispatch(
          env,
          command,
          authentication,
        );
        return jsonResponse(
          result.result === "dispatch_outbox_prepared" ? 201 : 200,
          {
            contract:
              "cinatoken-shard-placement-authority-prepare-enable-dispatch-result-v1",
            ...result,
          },
        );
      }

      if (route.kind === "execution_receipt_append") {
        const receipt = await parseExecutionReceipt(
          body,
          authentication,
          new Set(["operation_started", "operation_terminal"]),
        );
        if (
          receipt.operationOrdinal === 4
          || receipt.operationOrdinal === 5
        ) {
          throw new ProtocolError(
            "dedicated_operation_route_required",
            409,
          );
        }
        const result = await appendExecutionReceipt(
          env.DB,
          route.authorizationIdSha256,
          receipt,
          authentication.credentialIdSha256,
        );
        return jsonResponse(
          result.classification === "receipt_appended" ? 201 : 200,
          {
            result: result.classification,
            requestId: authentication.requestId,
            authorizationIdSha256:
              result.claim.authorization_id_sha256,
            claimDigestSha256: result.claim.claim_digest_sha256,
            status: result.claim.status,
            nextOperationOrdinal:
              nextExecutionOperation(result.claim),
            receiptCount: result.claim.ledger_version,
            receiptHeadSha256:
              result.claim.ledger_head_sha256,
            receiptDigestSha256:
              result.receipt.receipt_digest_sha256,
            applicationActivationDigestSha256:
              result.claim.application_activation_digest_sha256,
            ticketActivationConfirmed:
              result.claim.ticket_activation_confirmed === 1,
            authorityVersionId: env.CF_VERSION_METADATA.id,
          },
        );
      }

      if (
        route.kind === "execution_lease_renew"
        || route.kind === "execution_lease_takeover"
        || route.kind === "execution_safety_divert"
      ) {
        const expectedKind =
          route.kind === "execution_lease_renew"
            ? "lease_renewed"
            : route.kind === "execution_lease_takeover"
            ? "lease_taken_over"
            : "safety_diverted";
        const receipt = await parseExecutionReceipt(
          body,
          authentication,
          new Set([expectedKind]),
        );
        const result = await appendExecutionReceipt(
          env.DB,
          route.authorizationIdSha256,
          receipt,
          authentication.credentialIdSha256,
        );
        return jsonResponse(
          result.classification === "receipt_appended" ? 201 : 200,
          {
            result: result.classification,
            requestId: authentication.requestId,
            eventKind: receipt.eventKind,
            authorizationIdSha256:
              result.claim.authorization_id_sha256,
            claimDigestSha256: result.claim.claim_digest_sha256,
            status: result.claim.status,
            leaseGeneration: result.claim.lease_generation,
            leaseExpiresAt: result.claim.lease_expires_at,
            receiptCount: result.claim.ledger_version,
            receiptHeadSha256:
              result.claim.ledger_head_sha256,
            receiptDigestSha256:
              result.receipt.receipt_digest_sha256,
            authorityVersionId: env.CF_VERSION_METADATA.id,
          },
        );
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
    }
  | { kind: "execution_claim_create" }
  | {
      kind: "execution_claim_read";
      authorizationIdSha256: string;
      claimDigestSha256: string;
      claimOwnerSha256: string;
    }
  | {
      kind: "execution_receipt_append";
      authorizationIdSha256: string;
    }
  | {
      kind: "execution_lease_renew";
      authorizationIdSha256: string;
    }
  | {
      kind: "execution_lease_takeover";
      authorizationIdSha256: string;
    }
  | {
      kind: "execution_safety_divert";
      authorizationIdSha256: string;
    }
  | {
      kind: "execution_activate_ticket";
      authorizationIdSha256: string;
    }
  | {
      kind: "execution_begin_enable";
      authorizationIdSha256: string;
    }
  | {
      kind: "execution_prepare_enable_dispatch";
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
  if (request.method === "POST" && url.pathname === EXECUTION_CLAIMS_PATH) {
    if (url.search.length !== 0) {
      throw new ProtocolError("invalid_query", 400);
    }
    return { kind: "execution_claim_create" };
  }
  const executionClaimMatch =
    EXECUTION_CLAIM_ID_PATH.exec(url.pathname);
  if (request.method === "GET" && executionClaimMatch !== null) {
    return {
      kind: "execution_claim_read",
      authorizationIdSha256: executionClaimMatch[1]!,
      ...parseExactExecutionClaimQuery(url),
    };
  }
  const executionReceiptMatch =
    EXECUTION_RECEIPT_PATH.exec(url.pathname);
  if (request.method === "POST" && executionReceiptMatch !== null) {
    if (url.search.length !== 0) {
      throw new ProtocolError("invalid_query", 400);
    }
    return {
      kind: "execution_receipt_append",
      authorizationIdSha256: executionReceiptMatch[1]!,
    };
  }
  const executionRenewMatch =
    EXECUTION_RENEW_PATH.exec(url.pathname);
  if (request.method === "POST" && executionRenewMatch !== null) {
    if (url.search.length !== 0) {
      throw new ProtocolError("invalid_query", 400);
    }
    return {
      kind: "execution_lease_renew",
      authorizationIdSha256: executionRenewMatch[1]!,
    };
  }
  const executionTakeoverMatch =
    EXECUTION_TAKEOVER_PATH.exec(url.pathname);
  if (request.method === "POST" && executionTakeoverMatch !== null) {
    if (url.search.length !== 0) {
      throw new ProtocolError("invalid_query", 400);
    }
    return {
      kind: "execution_lease_takeover",
      authorizationIdSha256: executionTakeoverMatch[1]!,
    };
  }
  const executionSafetyDivertMatch =
    EXECUTION_SAFETY_DIVERT_PATH.exec(url.pathname);
  if (
    request.method === "POST"
    && executionSafetyDivertMatch !== null
  ) {
    if (url.search.length !== 0) {
      throw new ProtocolError("invalid_query", 400);
    }
    return {
      kind: "execution_safety_divert",
      authorizationIdSha256: executionSafetyDivertMatch[1]!,
    };
  }
  const executionActivateTicketMatch =
    EXECUTION_ACTIVATE_TICKET_PATH.exec(url.pathname);
  if (
    request.method === "POST"
    && executionActivateTicketMatch !== null
  ) {
    if (url.search.length !== 0) {
      throw new ProtocolError("invalid_query", 400);
    }
    return {
      kind: "execution_activate_ticket",
      authorizationIdSha256: executionActivateTicketMatch[1]!,
    };
  }
  const executionBeginEnableMatch =
    EXECUTION_BEGIN_ENABLE_PATH.exec(url.pathname);
  if (
    request.method === "POST"
    && executionBeginEnableMatch !== null
  ) {
    if (url.search.length !== 0) {
      throw new ProtocolError("invalid_query", 400);
    }
    return {
      kind: "execution_begin_enable",
      authorizationIdSha256: executionBeginEnableMatch[1]!,
    };
  }
  const executionPrepareEnableDispatchMatch =
    EXECUTION_PREPARE_ENABLE_DISPATCH_PATH.exec(url.pathname);
  if (
    request.method === "POST"
    && executionPrepareEnableDispatchMatch !== null
  ) {
    if (url.search.length !== 0) {
      throw new ProtocolError("invalid_query", 400);
    }
    return {
      kind: "execution_prepare_enable_dispatch",
      authorizationIdSha256:
        executionPrepareEnableDispatchMatch[1]!,
    };
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
  if (kind === "execution_claim_create") return "claim";
  if (kind === "execution_activate_ticket") return "activate";
  if (kind === "execution_begin_enable") return "enable";
  if (kind === "execution_prepare_enable_dispatch") {
    return "dispatch";
  }
  if (kind === "execution_receipt_append") return "receipt";
  if (
    kind === "execution_lease_renew"
    || kind === "execution_lease_takeover"
    || kind === "execution_safety_divert"
  ) {
    return "recovery";
  }
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
    (
      kind === "preflight"
      || kind === "issuance_read"
      || kind === "execution_claim_read"
    )
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
  if (
    kind === "execution_claim_create"
    && env.SHARD_PLACEMENT_AUTHORITY_CLAIM_WRITE_ENABLED !== "true"
  ) {
    throw new ProtocolError("authority_claim_disabled", 503);
  }
  if (
    kind === "execution_activate_ticket"
    && env.SHARD_PLACEMENT_AUTHORITY_ACTIVATION_READ_ENABLED !== "true"
  ) {
    throw new ProtocolError("authority_activation_reads_disabled", 503);
  }
  if (
    kind === "execution_activate_ticket"
    && env.SHARD_PLACEMENT_AUTHORITY_ACTIVATION_WRITE_ENABLED !== "true"
  ) {
    throw new ProtocolError("authority_activation_write_disabled", 503);
  }
  if (
    kind === "execution_begin_enable"
    && env.SHARD_PLACEMENT_AUTHORITY_PRE_ENABLE_READ_ENABLED !== "true"
  ) {
    throw new ProtocolError("authority_pre_enable_reads_disabled", 503);
  }
  if (
    kind === "execution_begin_enable"
    && env.SHARD_PLACEMENT_AUTHORITY_ENABLE_INTENT_WRITE_ENABLED
      !== "true"
  ) {
    throw new ProtocolError(
      "authority_enable_intent_write_disabled",
      503,
    );
  }
  if (
    kind === "execution_prepare_enable_dispatch"
    && env.SHARD_PLACEMENT_AUTHORITY_PRE_DISPATCH_READ_ENABLED
      !== "true"
  ) {
    throw new ProtocolError(
      "authority_pre_dispatch_reads_disabled",
      503,
    );
  }
  if (
    kind === "execution_prepare_enable_dispatch"
    && env.SHARD_PLACEMENT_AUTHORITY_DISPATCH_OUTBOX_WRITE_ENABLED
      !== "true"
  ) {
    throw new ProtocolError(
      "authority_dispatch_outbox_write_disabled",
      503,
    );
  }
  if (
    kind === "execution_receipt_append"
    && env.SHARD_PLACEMENT_AUTHORITY_RECEIPT_WRITE_ENABLED !== "true"
  ) {
    throw new ProtocolError("authority_receipt_disabled", 503);
  }
  if (
    (
      kind === "execution_lease_renew"
      || kind === "execution_lease_takeover"
      || kind === "execution_safety_divert"
    )
    && env.SHARD_PLACEMENT_AUTHORITY_RECOVERY_WRITE_ENABLED !== "true"
  ) {
    throw new ProtocolError("authority_recovery_disabled", 503);
  }
}

export function validateRuntimeTrustConfiguration(
  env: AuthorityEnv,
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
  const databaseIdentities = [
    env.SHARD_PLACEMENT_APPLICATION_DATABASE_IDENTITY_SHA256,
    env.SHARD_PLACEMENT_AUTHORITY_DATABASE_IDENTITY_SHA256,
    env.SHARD_PLACEMENT_AUTHORITY_LEDGER_IDENTITY_SHA256,
  ];
  if (
    databaseIdentities.some((value) => !SHA256.test(value))
    || new Set(databaseIdentities).size !== databaseIdentities.length
  ) {
    throw new ProtocolError("authority_database_identity_unavailable", 503);
  }
  requireHmacCredentialIsolation(env);
  if (
    env.SHARD_PLACEMENT_AUTHORITY_ACTIVATION_READ_ENABLED === "true"
  ) {
    validateApplicationActivationClientConfig(env);
  }
  if (
    env.SHARD_PLACEMENT_AUTHORITY_PRE_ENABLE_READ_ENABLED === "true"
    || env.SHARD_PLACEMENT_AUTHORITY_PRE_DISPATCH_READ_ENABLED
      === "true"
  ) {
    validateApplicationAuthorityAckClientConfig(env);
  }
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
  for (
    const role of [
      "READ",
      "ISSUE",
      "REVOKE",
      "CLAIM",
      "ACTIVATE",
      "ENABLE",
      "DISPATCH",
      "RECEIPT",
      "RECOVERY",
    ] as const
  ) {
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

function publicExecutionSnapshot(
  snapshot: ExecutionClaimSnapshot,
): Record<string, unknown> {
  const row = snapshot.claim;
  return {
    schemaVersion: 1,
    contract:
      "cinatoken-relay-container-shard-placement-execution-snapshot-v1",
    claim: {
      authorizationIdSha256: row.authorization_id_sha256,
      permitSubjectDigestSha256:
        row.permit_subject_digest_sha256,
      executionNonceSha256: row.execution_nonce_sha256,
      applicationTicketIdSha256:
        row.application_ticket_id_sha256,
      applicationTicketDigestSha256:
        row.application_ticket_digest_sha256,
      applicationDatabaseIdentitySha256:
        row.application_database_identity_sha256,
      authorityDatabaseIdentitySha256:
        row.authority_database_identity_sha256,
      campaignId: row.campaign_id,
      campaignNonceSha256: row.campaign_nonce_sha256,
      claimScope: row.claim_scope,
      executionPlanSha256: row.execution_plan_sha256,
      releaseSha256: row.release_sha256,
      publicationSha256: row.publication_sha256,
      executionActivationSha256:
        row.execution_activation_sha256,
      runnerBuildSha256: row.runner_build_sha256,
      claimOwnerSha256: row.claim_owner_sha256,
      leaseOwnerSha256: row.lease_owner_sha256,
      ledgerIdentitySha256: row.ledger_identity_sha256,
      baselineOperationIdSha256:
        row.baseline_operation_id_sha256,
      baselineTerminalReceiptSha256:
        row.baseline_terminal_digest_sha256,
      preparationOperationIdSha256:
        row.preparation_operation_id_sha256,
      claimOperationIdSha256: row.claim_operation_id_sha256,
      operationScheduleSha256:
        row.operation_schedule_sha256,
      claimCredentialIdSha256:
        row.claim_credential_id_sha256,
      claimRequestIdSha256: row.claim_request_id_sha256,
      claimDigestSha256: row.claim_digest_sha256,
      claimAcquiredReceiptSha256:
        row.claim_acquired_receipt_digest_sha256,
      generatedAt: row.generated_at,
      permitExpiresAt: row.permit_expires_at,
      normalDeadlineAt: row.normal_deadline_at,
      recoveryDeadlineAt: row.recovery_deadline_at,
      claimedAt: row.claimed_at,
    },
    state: {
      status: row.status,
      leaseGeneration: row.lease_generation,
      leaseExpiresAt: row.lease_expires_at,
      nextOperationOrdinal: nextExecutionOperation(row),
      activeOperationOrdinal: row.inflight_operation_ordinal,
      inflightReadbackOnly: row.inflight_readback_only === 1,
      receiptCount: row.ledger_version,
      receiptHeadSha256: row.ledger_head_sha256,
      controllerEnableIntentRecorded:
        row.enable_intent_seen === 1,
      controllerDisabledVerified:
        row.disable_confirmed === 1,
      applicationActivationDigestSha256:
        row.application_activation_digest_sha256,
      ticketActivationConfirmed:
        row.ticket_activation_confirmed === 1,
      renewalCount: row.renewal_count,
      takeoverCount: row.takeover_count,
      updatedAt: row.updated_at,
      terminalAt: row.terminal_at,
    },
    operations: snapshot.operations.map((operation) => ({
      ordinal: operation.ordinal,
      operationIdSha256: operation.operation_id_sha256,
      kind: operation.kind,
      shardIndex: operation.shard_index,
    })),
    receipts: snapshot.receipts.map((receipt) => ({
      sequence: receipt.sequence,
      eventKind: receipt.event_kind,
      claimDigestSha256: receipt.claim_digest_sha256,
      executionPlanSha256: receipt.execution_plan_sha256,
      ledgerIdentitySha256: receipt.ledger_identity_sha256,
      operationOrdinal: receipt.operation_ordinal,
      operationIdSha256: receipt.operation_id_sha256,
      operationKind: receipt.operation_kind,
      shardIndex: receipt.shard_index,
      predecessorReceiptSha256:
        receipt.predecessor_receipt_sha256,
      requestSha256: receipt.request_sha256,
      responseSha256: receipt.response_sha256,
      cloudflareRequestIdSha256:
        receipt.cloudflare_request_id_sha256,
      evidenceSha256: receipt.evidence_sha256,
      safetyReason: receipt.safety_reason,
      outcome: receipt.outcome,
      leaseOwnerSha256: receipt.lease_owner_sha256,
      leaseTokenSha256: receipt.lease_token_sha256,
      leaseGeneration: receipt.lease_generation,
      leaseExpiresAt: receipt.lease_expires_at,
      receiptCredentialIdSha256:
        receipt.receipt_credential_id_sha256,
      requestIdSha256: receipt.request_id_sha256,
      receiptDigestSha256: receipt.receipt_digest_sha256,
      recordedAt: receipt.recorded_at,
    })),
  };
}

function nextExecutionOperation(
  row: ExecutionClaimSnapshot["claim"],
): number | null {
  if (row.inflight_operation_ordinal !== null) {
    return row.inflight_operation_ordinal;
  }
  if (
    row.status === "completed"
    || row.status === "aborted"
    || row.status === "revoked"
    || row.status === "recovery_required"
  ) {
    return null;
  }
  if (row.status === "disable_required") return 14;
  return Math.min(row.last_completed_ordinal + 1, 14);
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
