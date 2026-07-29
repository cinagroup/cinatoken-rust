import {
  buildDeploymentMutation,
  createDeploymentOnce,
  readDeploymentStatus,
  type CloudflareGatewayEnv,
  type StatusObservation,
} from "./cloudflare_client";
import {
  ProtocolError,
  parseCreateDeploymentRequest,
  readBoundedJson,
  requireEmptyBody,
  sha256Canonical,
  sha256Hex,
  verifyHmacRequest,
  type FrozenControllerEnableCommand,
  type GatewaySecurityEnv,
} from "./protocol";
import {
  deploymentStateDigest,
  isTargetStable,
  type DeploymentStateObservation,
} from "./deployment_state";
import {
  RepositoryConflictError,
  RepositoryNotFoundError,
  RepositoryUnavailableError,
  appendObservation,
  appendOutcome,
  readExactOperation,
  reserveOperationAndDispatch,
  type OperationSnapshot,
} from "./repository";

interface GatewayEnv extends GatewaySecurityEnv, CloudflareGatewayEnv {
  DB: D1Database;
  CF_VERSION_METADATA: WorkerVersionMetadata;
  ENVIRONMENT: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_ENABLED: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_ENABLED: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_READ_ENABLED: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_REMOTE_MUTATION_ENABLED: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_REMOTE_READ_ENABLED: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_PROFILE_VERSION: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_STABILITY_MIN_SECONDS: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_CONTROLLER_SERVICE_NAME: string;
  CLOUDFLARE_ACCOUNT_ID_SHA256: string;
}

const PREFLIGHT_PATH =
  "/internal/v1/controller-deployments/preflight";
const CREATE_PATH =
  /^\/internal\/v1\/controller-deployments\/([0-9a-f]{64})\/create-once$/;
const STATUS_PATH =
  /^\/internal\/v1\/controller-deployments\/([0-9a-f]{64})\/status-readback$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,128}$/;

export default {
  async fetch(request: Request, env: GatewayEnv): Promise<Response> {
    try {
      const route = matchRoute(request);
      rejectAmbientHeaders(request);
      requireGatewayEnabled(env);
      await requireConfigIdentity(env);
      if (route.kind === "create") {
        requireGate(
          env.CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_ENABLED,
          "create_disabled",
        );
        requireGate(
          env.CONTROLLER_DEPLOYMENT_GATEWAY_REMOTE_MUTATION_ENABLED,
          "remote_mutation_disabled",
        );
        return await handleCreate(request, env, route.idempotencyKeySha256);
      }
      if (route.kind === "status") {
        requireGate(
          env.CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_READ_ENABLED,
          "status_read_disabled",
        );
        requireGate(
          env.CONTROLLER_DEPLOYMENT_GATEWAY_REMOTE_READ_ENABLED,
          "remote_read_disabled",
        );
        return await handleStatus(
          request,
          env,
          route.idempotencyKeySha256,
          route.commandDigestSha256,
        );
      }
      const body = await requireEmptyBody(request);
      const authentication = await verifyHmacRequest(
        request,
        body,
        "status",
        env,
      );
      return jsonResponse(200, {
        result: "gateway_ready",
        requestId: authentication.requestId,
        credentialIdSha256: authentication.credentialIdSha256,
        gatewayProfileVersion: 1,
        remoteMutationEnabled:
          env.CONTROLLER_DEPLOYMENT_GATEWAY_REMOTE_MUTATION_ENABLED === "true",
        remoteReadEnabled:
          env.CONTROLLER_DEPLOYMENT_GATEWAY_REMOTE_READ_ENABLED === "true",
        gatewayVersionId: env.CF_VERSION_METADATA.id,
      });
    } catch (error) {
      return errorResponse(error);
    }
  },
} satisfies ExportedHandler<GatewayEnv>;

async function handleCreate(
  request: Request,
  env: GatewayEnv,
  idempotencyKeySha256: string,
): Promise<Response> {
  const body = await readBoundedJson(request);
  const authentication = await verifyHmacRequest(
    request,
    body,
    "create",
    env,
  );
  const create = await parseCreateDeploymentRequest(body);
  if (create.gatewayIdempotencyKeySha256 !== idempotencyKeySha256) {
    throw new ProtocolError("path_identity_mismatch", 400);
  }
  if (
    create.command.controllerServiceName
      !== env.CONTROLLER_DEPLOYMENT_GATEWAY_CONTROLLER_SERVICE_NAME
  ) {
    throw new ProtocolError("controller_service_mismatch", 403);
  }
  const mutation = await buildDeploymentMutation(
    env.CLOUDFLARE_ACCOUNT_ID,
    create.command,
  );
  const createRequestIdSha256 = await sha256Hex(
    new TextEncoder().encode(authentication.requestId),
  );
  const reservation = await reserveOperationAndDispatch(env.DB, {
    request: create,
    mutation,
    accountIdSha256: env.CLOUDFLARE_ACCOUNT_ID_SHA256,
    gatewayProfileVersion: 1,
    createCredentialIdSha256: authentication.credentialIdSha256,
    createRequestIdSha256,
  });
  if (reservation.classification === "exact_replay") {
    return jsonResponse(200, {
      result: "exact_replay",
      requestId: authentication.requestId,
      gatewayIdempotencyKeySha256: idempotencyKeySha256,
      controllerCommandDigestSha256:
        reservation.snapshot.operation.command_digest_sha256,
      mutationRequestSha256:
        reservation.snapshot.dispatch.mutation_request_sha256,
      networkRequestSent: false,
      recoveryAction: "status_only",
      outcome: publicOutcome(reservation.snapshot),
      gatewayVersionId: env.CF_VERSION_METADATA.id,
    });
  }

  const outcome = await createDeploymentOnce(env, create.command, mutation);
  const persisted = await appendOutcome(
    env.DB,
    idempotencyKeySha256,
    outcome,
  );
  return jsonResponse(201, {
    result: "mutation_attempt_recorded",
    requestId: authentication.requestId,
    gatewayIdempotencyKeySha256: idempotencyKeySha256,
    controllerCommandDigestSha256: create.controllerCommandDigestSha256,
    mutationRequestSha256: mutation.mutationRequestSha256,
    networkRequestSent: true,
    recoveryAction:
      outcome.classification === "accepted" ? "status_readback" : "status_only",
    outcome: {
      classification: persisted.outcome.classification,
      httpStatus: persisted.outcome.http_status,
      responseBodySha256: persisted.outcome.response_body_sha256,
      responseRequestIdSha256:
        persisted.outcome.response_request_id_sha256,
      responseBytes: persisted.outcome.response_bytes,
      recordedAt: persisted.outcome.recorded_at,
    },
    gatewayVersionId: env.CF_VERSION_METADATA.id,
  });
}

async function handleStatus(
  request: Request,
  env: GatewayEnv,
  idempotencyKeySha256: string,
  commandDigestSha256: string,
): Promise<Response> {
  const body = await requireEmptyBody(request);
  const authentication = await verifyHmacRequest(
    request,
    body,
    "status",
    env,
  );
  const snapshot = await readExactOperation(
    env.DB,
    idempotencyKeySha256,
    commandDigestSha256,
    env.CLOUDFLARE_ACCOUNT_ID_SHA256,
  );
  if (
    snapshot.operation.controller_service_name
      !== env.CONTROLLER_DEPLOYMENT_GATEWAY_CONTROLLER_SERVICE_NAME
  ) {
    throw new RepositoryConflictError("controller_service_mismatch");
  }
  const command = commandFromSnapshot(snapshot);
  const remoteObservation = await readDeploymentStatus(env, command);
  const requestIdSha256 = await sha256Hex(
    new TextEncoder().encode(authentication.requestId),
  );
  const observation: StatusObservation = {
    ...remoteObservation,
    observationDigestSha256: await sha256Canonical({
      schemaVersion: 1,
      contract:
        "cinatoken-controller-deployment-gateway-status-event-v1",
      gatewayIdempotencyKeySha256: idempotencyKeySha256,
      statusCredentialIdSha256: authentication.credentialIdSha256,
      statusRequestIdSha256: requestIdSha256,
      remoteObservationDigestSha256:
        remoteObservation.observationDigestSha256,
    }),
  };
  const persisted = await appendObservation(
    env.DB,
    idempotencyKeySha256,
    observation,
    authentication.credentialIdSha256,
    requestIdSha256,
  );
  const stabilityMinimumSeconds = Number(
    env.CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_STABILITY_MIN_SECONDS,
  );
  const currentStateDigestSha256 = await deploymentStateDigest(
    idempotencyKeySha256,
    commandDigestSha256,
    command,
    deploymentStateFromRow(persisted.observation),
  );
  const previousObservation = persisted.previousObservation;
  const previousStateDigestSha256 = previousObservation === null
    ? null
    : await deploymentStateDigest(
      idempotencyKeySha256,
      commandDigestSha256,
      command,
      deploymentStateFromRow(previousObservation),
    );
  const targetStable = isTargetStable(
    {
      classification: persisted.observation.classification,
      statusRequestIdSha256:
        persisted.observation.status_request_id_sha256,
      recordedAt: persisted.observation.recorded_at,
      deploymentStateDigestSha256: currentStateDigestSha256,
    },
    previousObservation === null || previousStateDigestSha256 === null
      ? null
      : {
        classification: previousObservation.classification,
        statusRequestIdSha256:
          previousObservation.status_request_id_sha256,
        recordedAt: previousObservation.recorded_at,
        deploymentStateDigestSha256: previousStateDigestSha256,
      },
    stabilityMinimumSeconds,
  );
  return jsonResponse(
    persisted.classification === "recorded" ? 201 : 200,
    {
      result: persisted.classification === "recorded"
        ? "status_observation_recorded"
        : "status_observation_replayed",
      requestId: authentication.requestId,
      gatewayIdempotencyKeySha256: idempotencyKeySha256,
      controllerCommandDigestSha256: commandDigestSha256,
      remoteMutationSent: false,
      statusRequestCount: 2,
      targetStable,
      requiredMatchingObservations: 2,
      stabilityMinimumSeconds,
      observation: {
        classification: persisted.observation.classification,
        deploymentsHttpStatus:
          persisted.observation.deployments_http_status,
        versionHttpStatus: persisted.observation.version_http_status,
        deploymentSetSha256:
          persisted.observation.deployment_set_sha256,
        targetVersionSha256:
          persisted.observation.target_version_sha256,
        responseRequestIdSha256:
          persisted.observation.response_request_id_sha256,
        observationDigestSha256: currentStateDigestSha256,
        recordedAt: persisted.observation.recorded_at,
      },
      gatewayVersionId: env.CF_VERSION_METADATA.id,
    },
  );
}

function deploymentStateFromRow(
  observation: OperationSnapshot["observations"][number],
): DeploymentStateObservation {
  return {
    classification: observation.classification,
    deploymentsHttpStatus: observation.deployments_http_status,
    versionHttpStatus: observation.version_http_status,
    deploymentSetSha256: observation.deployment_set_sha256,
    targetVersionSha256: observation.target_version_sha256,
  };
}

type Route =
  | { kind: "preflight" }
  | { kind: "create"; idempotencyKeySha256: string }
  | {
      kind: "status";
      idempotencyKeySha256: string;
      commandDigestSha256: string;
    };

function matchRoute(request: Request): Route {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === PREFLIGHT_PATH) {
    if (url.search.length !== 0) throw new ProtocolError("invalid_query", 400);
    return { kind: "preflight" };
  }
  const create = CREATE_PATH.exec(url.pathname);
  if (request.method === "POST" && create !== null) {
    if (url.search.length !== 0) throw new ProtocolError("invalid_query", 400);
    return { kind: "create", idempotencyKeySha256: create[1]! };
  }
  const status = STATUS_PATH.exec(url.pathname);
  if (request.method === "POST" && status !== null) {
    const entries = [...url.searchParams.entries()];
    if (
      entries.length !== 1
      || entries[0]?.[0] !== "commandDigestSha256"
      || !SHA256.test(entries[0]?.[1] ?? "")
    ) {
      throw new ProtocolError("invalid_query", 400);
    }
    return {
      kind: "status",
      idempotencyKeySha256: status[1]!,
      commandDigestSha256: entries[0]![1],
    };
  }
  throw new ProtocolError("route_not_found", 404);
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

function requireGatewayEnabled(env: GatewayEnv): void {
  if (
    env.ENVIRONMENT !== "staging"
    || env.CONTROLLER_DEPLOYMENT_GATEWAY_ENABLED !== "true"
    || env.CONTROLLER_DEPLOYMENT_GATEWAY_PROFILE_VERSION !== "1"
  ) {
    throw new ProtocolError("gateway_disabled", 503);
  }
}

async function requireConfigIdentity(env: GatewayEnv): Promise<void> {
  const stabilityMinimumSeconds = Number(
    env.CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_STABILITY_MIN_SECONDS,
  );
  if (
    !ACCOUNT_ID.test(env.CLOUDFLARE_ACCOUNT_ID)
    || !SHA256.test(env.CLOUDFLARE_ACCOUNT_ID_SHA256)
    || await sha256Hex(new TextEncoder().encode(env.CLOUDFLARE_ACCOUNT_ID))
      !== env.CLOUDFLARE_ACCOUNT_ID_SHA256
    || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      env.CONTROLLER_DEPLOYMENT_GATEWAY_CONTROLLER_SERVICE_NAME,
    )
    || !Number.isSafeInteger(stabilityMinimumSeconds)
    || stabilityMinimumSeconds < 5
    || stabilityMinimumSeconds > 120
    || !hmacIdentityConfigValid(env)
  ) {
    throw new ProtocolError("gateway_config_identity_invalid", 503);
  }
}

function hmacIdentityConfigValid(env: GatewayEnv): boolean {
  const identities: Array<{
    keyId: string;
    credentialIdSha256: string;
    secret: string;
  }> = [];
  const configuredIdentities = [
    {
      generation: "current",
      keyId: env.CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_CURRENT_KID,
      credentialIdSha256:
        env
          .CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_CURRENT_CREDENTIAL_ID_SHA256,
      secret:
        env.CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_CURRENT_SECRET ?? "",
    },
    {
      generation: "previous",
      keyId: env.CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_PREVIOUS_KID,
      credentialIdSha256:
        env
          .CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256,
      secret:
        env.CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_PREVIOUS_SECRET ?? "",
    },
    {
      generation: "current",
      keyId: env.CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_CURRENT_KID,
      credentialIdSha256:
        env
          .CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_CURRENT_CREDENTIAL_ID_SHA256,
      secret:
        env.CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_CURRENT_SECRET ?? "",
    },
    {
      generation: "previous",
      keyId: env.CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_PREVIOUS_KID,
      credentialIdSha256:
        env
          .CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256,
      secret:
        env.CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_PREVIOUS_SECRET ?? "",
    },
  ] as const;
  for (const identity of configuredIdentities) {
    if (
      identity.generation === "previous"
      && identity.keyId === ""
      && identity.credentialIdSha256 === ""
    ) {
      if (identity.secret !== "") return false;
      continue;
    }
    if (
      !/^[A-Za-z0-9._:-]{1,128}$/.test(identity.keyId)
      || !SHA256.test(identity.credentialIdSha256)
      || identity.secret.length < 32
    ) {
      return false;
    }
    identities.push(identity);
  }
  return identities.length >= 2
    && new Set(identities.map((identity) => identity.keyId)).size
      === identities.length
    && new Set(
      identities.map((identity) => identity.credentialIdSha256),
    ).size === identities.length
    && new Set(identities.map((identity) => identity.secret)).size
      === identities.length;
}

function requireGate(value: string, code: string): void {
  if (value !== "true") throw new ProtocolError(code, 503);
}

function commandFromSnapshot(
  snapshot: OperationSnapshot,
): FrozenControllerEnableCommand {
  let value: unknown;
  try {
    value = JSON.parse(snapshot.operation.command_json);
  } catch {
    throw new RepositoryUnavailableError(false);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RepositoryUnavailableError(false);
  }
  return value as FrozenControllerEnableCommand;
}

function publicOutcome(snapshot: OperationSnapshot): Record<string, unknown> | null {
  const outcome = snapshot.outcome;
  if (outcome === null) return null;
  return {
    classification: outcome.classification,
    httpStatus: outcome.http_status,
    responseBodySha256: outcome.response_body_sha256,
    responseRequestIdSha256: outcome.response_request_id_sha256,
    responseBytes: outcome.response_bytes,
    recordedAt: outcome.recorded_at,
  };
}

function jsonResponse(
  status: number,
  value: Record<string, unknown>,
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

function errorResponse(error: unknown): Response {
  if (error instanceof ProtocolError) {
    return jsonResponse(error.status, { error: error.code });
  }
  if (error instanceof RepositoryNotFoundError) {
    return jsonResponse(404, { error: "operation_not_found" });
  }
  if (error instanceof RepositoryConflictError) {
    return jsonResponse(409, { error: error.code });
  }
  if (error instanceof RepositoryUnavailableError) {
    return jsonResponse(503, {
      error: error.outcomeUnknown
        ? "repository_outcome_unknown"
        : "repository_unavailable",
      recoveryAction: error.outcomeUnknown ? "status_only" : "retry_status_only",
    });
  }
  return jsonResponse(500, { error: "internal_error" });
}
