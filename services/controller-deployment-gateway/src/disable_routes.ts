import {
  buildDisableDeploymentMutation,
  createDisableDeploymentOnce,
  readDisableDeploymentStatus,
  type DisableCloudflareGatewayEnv,
} from "./disable_cloudflare_client";
import {
  disableDeploymentStateDigest,
  isDisableTargetStable,
} from "./disable_deployment_state";
import {
  disableHmacIdentityConfigValid,
  parseDisableCreateRequest,
  parseFrozenControllerDisableCommand,
  verifyDisableHmacRequest,
  type DisableGatewaySecurityEnv,
  type FrozenControllerDisableCommand,
} from "./disable_protocol";
import {
  appendDisableObservation,
  appendDisableOutcome,
  readDisableObservationReplay,
  reserveDisableOperationAndDispatch,
  type DisableObservationRow,
  type DisableOperationSnapshot,
} from "./disable_repository";
import {
  ProtocolError,
  canonicalJson,
  readBoundedJson,
  requireEmptyBody,
  sha256Canonical,
  sha256Hex,
} from "./protocol";

const DISABLE_CREATE_PATH =
  /^\/internal\/v1\/controller-deployment-disables\/([0-9a-f]{64})\/create-once$/;
const DISABLE_STATUS_PATH =
  /^\/internal\/v1\/controller-deployment-disables\/([0-9a-f]{64})\/status-readback$/;
const DISABLE_PATH_PREFIX =
  "/internal/v1/controller-deployment-disables/";
const SHA256 = /^[0-9a-f]{64}$/;
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SERVICE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const KEY_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_RESPONSE_BYTES = 8 * 1024;

export interface DisableRouteEnv
  extends DisableGatewaySecurityEnv, DisableCloudflareGatewayEnv {
  DB: D1Database;
  CF_VERSION_METADATA: WorkerVersionMetadata;
  CONTROLLER_DEPLOYMENT_GATEWAY_PROFILE_VERSION: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_CONTROLLER_SERVICE_NAME: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_CREATE_ENABLED: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_READ_ENABLED: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_REMOTE_MUTATION_ENABLED: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_REMOTE_READ_ENABLED: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_STABILITY_MIN_SECONDS: string;
  CLOUDFLARE_ACCOUNT_ID_SHA256: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_CURRENT_KID: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
    string;
  CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_CURRENT_SECRET?: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_PREVIOUS_KID: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256:
    string;
  CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_PREVIOUS_SECRET?: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_CURRENT_KID: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
    string;
  CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_CURRENT_SECRET?: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_PREVIOUS_KID: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256:
    string;
  CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_PREVIOUS_SECRET?: string;
}

export type DisableRoute =
  | {
      kind: "disable_create";
      idempotencyKeySha256: string;
    }
  | {
      kind: "disable_status";
      idempotencyKeySha256: string;
      commandDigestSha256: string;
    };

export function matchDisableRoute(request: Request): DisableRoute | null {
  const url = new URL(request.url);
  const create = DISABLE_CREATE_PATH.exec(url.pathname);
  if (request.method === "POST" && create !== null) {
    if (url.search.length !== 0) {
      throw new ProtocolError("invalid_disable_query", 400);
    }
    return {
      kind: "disable_create",
      idempotencyKeySha256: create[1]!,
    };
  }
  const status = DISABLE_STATUS_PATH.exec(url.pathname);
  if (request.method === "POST" && status !== null) {
    const entries = [...url.searchParams.entries()];
    if (
      entries.length !== 1
      || entries[0]?.[0] !== "commandDigestSha256"
      || !SHA256.test(entries[0]?.[1] ?? "")
    ) {
      throw new ProtocolError("invalid_disable_query", 400);
    }
    return {
      kind: "disable_status",
      idempotencyKeySha256: status[1]!,
      commandDigestSha256: entries[0]![1],
    };
  }
  if (url.pathname.startsWith(DISABLE_PATH_PREFIX)) {
    throw new ProtocolError("disable_route_not_found", 404);
  }
  return null;
}

export async function handleDisableRoute(
  request: Request,
  env: DisableRouteEnv,
  route: DisableRoute,
): Promise<Response> {
  await requireDisableConfigIdentity(env);
  if (route.kind === "disable_create") {
    requireGate(
      env.CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_CREATE_ENABLED,
      "disable_create_disabled",
    );
    requireGate(
      env.CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_REMOTE_MUTATION_ENABLED,
      "disable_remote_mutation_disabled",
    );
    return handleDisableCreate(request, env, route.idempotencyKeySha256);
  }
  requireGate(
    env.CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_READ_ENABLED,
    "disable_status_read_disabled",
  );
  requireGate(
    env.CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_REMOTE_READ_ENABLED,
    "disable_remote_read_disabled",
  );
  return handleDisableStatus(
    request,
    env,
    route.idempotencyKeySha256,
    route.commandDigestSha256,
  );
}

async function handleDisableCreate(
  request: Request,
  env: DisableRouteEnv,
  idempotencyKeySha256: string,
): Promise<Response> {
  const body = await readBoundedJson(request);
  const authentication = await verifyDisableHmacRequest(
    request,
    body,
    "disable_create",
    env,
  );
  const create = await parseDisableCreateRequest(body);
  if (create.gatewayDisableIdempotencyKeySha256 !== idempotencyKeySha256) {
    throw new ProtocolError("disable_path_identity_mismatch", 400);
  }
  if (
    create.command.controllerServiceName
      !== env.CONTROLLER_DEPLOYMENT_GATEWAY_CONTROLLER_SERVICE_NAME
  ) {
    throw new ProtocolError("disable_controller_service_mismatch", 403);
  }
  const mutation = await buildDisableDeploymentMutation(
    env.CLOUDFLARE_ACCOUNT_ID,
    create.command,
  );
  const requestIdSha256 = await sha256Hex(
    new TextEncoder().encode(authentication.requestId),
  );
  const reservation = await reserveDisableOperationAndDispatch(env.DB, {
    request: create,
    mutation,
    accountIdSha256: env.CLOUDFLARE_ACCOUNT_ID_SHA256,
    gatewayProfileVersion: 1,
    disableCreateCredentialIdSha256: authentication.credentialIdSha256,
    disableCreateRequestIdSha256: requestIdSha256,
  });
  if (reservation.classification === "exact_replay") {
    return disableJsonResponse(200, {
      controllerDisableCommandDigestSha256:
        reservation.snapshot.operation.command_digest_sha256,
      gatewayDisableIdempotencyKeySha256: idempotencyKeySha256,
      gatewayVersionId: env.CF_VERSION_METADATA.id,
      mutationRequestSha256:
        reservation.snapshot.dispatch.mutation_request_sha256,
      networkRequestSent: false,
      outcome: publicDisableOutcome(reservation.snapshot),
      recoveryAction: "status_only",
      requestId: authentication.requestId,
      result: "disable_exact_replay",
    });
  }

  const outcome = await createDisableDeploymentOnce(
    env,
    create.command,
    mutation,
  );
  const persisted = await appendDisableOutcome(
    env.DB,
    idempotencyKeySha256,
    outcome,
  );
  return disableJsonResponse(201, {
    controllerDisableCommandDigestSha256:
      create.controllerDisableCommandDigestSha256,
    gatewayDisableIdempotencyKeySha256: idempotencyKeySha256,
    gatewayVersionId: env.CF_VERSION_METADATA.id,
    mutationRequestSha256: mutation.mutationRequestSha256,
    networkRequestSent: true,
    outcome: {
      classification: persisted.outcome.classification,
      httpStatus: persisted.outcome.http_status,
      recordedAt: persisted.outcome.recorded_at,
      responseBodySha256: persisted.outcome.response_body_sha256,
      responseBytes: persisted.outcome.response_bytes,
      responseRequestIdSha256:
        persisted.outcome.response_request_id_sha256,
    },
    recoveryAction: "status_only",
    requestId: authentication.requestId,
    result: "disable_mutation_attempt_recorded",
  });
}

async function handleDisableStatus(
  request: Request,
  env: DisableRouteEnv,
  idempotencyKeySha256: string,
  commandDigestSha256: string,
): Promise<Response> {
  const body = await requireEmptyBody(request);
  const authentication = await verifyDisableHmacRequest(
    request,
    body,
    "disable_status",
    env,
  );
  const requestIdSha256 = await sha256Hex(
    new TextEncoder().encode(authentication.requestId),
  );
  const replay = await readDisableObservationReplay(
    env.DB,
    idempotencyKeySha256,
    commandDigestSha256,
    env.CLOUDFLARE_ACCOUNT_ID_SHA256,
    authentication.credentialIdSha256,
    requestIdSha256,
  );
  const command = commandFromSnapshot(replay.snapshot);
  requireExpectedControllerService(env, command);
  const stabilityMinimumSeconds = Number(
    env.CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_STABILITY_MIN_SECONDS,
  );
  if (replay.observation !== null) {
    return disableStatusResponse(
      200,
      env,
      authentication.requestId,
      commandDigestSha256,
      replay.observation,
      replay.previousObservation,
      stabilityMinimumSeconds,
      false,
      "disable_status_observation_replayed",
    );
  }

  const remote = await readDisableDeploymentStatus(env, command);
  const remoteObservationDigestSha256 = await sha256Canonical({
    schemaVersion: 1,
    contract:
      "cinatoken-controller-deployment-gateway-disable-remote-observation-v1",
    ...remote,
  });
  const stateDigestSha256 = await disableDeploymentStateDigest(
    idempotencyKeySha256,
    commandDigestSha256,
    command,
    remote,
  );
  const observationDigestSha256 = await sha256Canonical({
    schemaVersion: 1,
    contract:
      "cinatoken-controller-deployment-gateway-disable-status-event-v1",
    gatewayDisableIdempotencyKeySha256: idempotencyKeySha256,
    disableStatusCredentialIdSha256: authentication.credentialIdSha256,
    disableStatusRequestIdSha256: requestIdSha256,
    remoteObservationDigestSha256,
    stateDigestSha256,
  });
  const persisted = await appendDisableObservation(
    env.DB,
    idempotencyKeySha256,
    {
      ...remote,
      remoteObservationDigestSha256,
      stateDigestSha256,
      observationDigestSha256,
    },
    authentication.credentialIdSha256,
    requestIdSha256,
  );
  return disableStatusResponse(
    persisted.classification === "recorded" ? 201 : 200,
    env,
    authentication.requestId,
    commandDigestSha256,
    persisted.observation,
    persisted.previousObservation,
    stabilityMinimumSeconds,
    true,
    persisted.classification === "recorded"
      ? "disable_status_observation_recorded"
      : "disable_status_observation_replayed",
  );
}

function disableStatusResponse(
  status: number,
  env: DisableRouteEnv,
  requestId: string,
  commandDigestSha256: string,
  observation: DisableObservationRow,
  previousObservation: DisableObservationRow | null,
  stabilityMinimumSeconds: number,
  remoteReadSent: boolean,
  result: string,
): Response {
  const targetStable = isDisableTargetStable(
    {
      classification: observation.classification,
      recordedAt: observation.recorded_at,
      stateDigestSha256: observation.state_digest_sha256,
      statusRequestIdSha256:
        observation.disable_status_request_id_sha256,
    },
    previousObservation === null
      ? null
      : {
        classification: previousObservation.classification,
        recordedAt: previousObservation.recorded_at,
        stateDigestSha256: previousObservation.state_digest_sha256,
        statusRequestIdSha256:
          previousObservation.disable_status_request_id_sha256,
      },
    stabilityMinimumSeconds,
  );
  return disableJsonResponse(status, {
    controllerDisableCommandDigestSha256: commandDigestSha256,
    gatewayDisableIdempotencyKeySha256:
      observation.gateway_disable_idempotency_key_sha256,
    gatewayVersionId: env.CF_VERSION_METADATA.id,
    observation: {
      baselineVersionHttpStatus:
        observation.baseline_version_http_status,
      baselineVersionSha256: observation.baseline_version_sha256,
      classification: observation.classification,
      deploymentsHttpStatus: observation.deployments_http_status,
      deploymentSetSha256: observation.deployment_set_sha256,
      observationDigestSha256: observation.observation_digest_sha256,
      recordedAt: observation.recorded_at,
      responseRequestIdSha256:
        observation.response_request_id_sha256,
      stateDigestSha256: observation.state_digest_sha256,
    },
    remoteMutationSent: false,
    remoteReadSent,
    requestId,
    requiredMatchingObservations: 2,
    result,
    stabilityMinimumSeconds,
    targetStable,
  });
}

async function requireDisableConfigIdentity(
  env: DisableRouteEnv,
): Promise<void> {
  const stabilityMinimumSeconds = Number(
    env.CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_STABILITY_MIN_SECONDS,
  );
  if (
    env.CONTROLLER_DEPLOYMENT_GATEWAY_PROFILE_VERSION !== "1"
    || !ACCOUNT_ID.test(env.CLOUDFLARE_ACCOUNT_ID)
    || !SHA256.test(env.CLOUDFLARE_ACCOUNT_ID_SHA256)
    || await sha256Hex(new TextEncoder().encode(env.CLOUDFLARE_ACCOUNT_ID))
      !== env.CLOUDFLARE_ACCOUNT_ID_SHA256
    || !SERVICE_NAME.test(
      env.CONTROLLER_DEPLOYMENT_GATEWAY_CONTROLLER_SERVICE_NAME,
    )
    || !Number.isSafeInteger(stabilityMinimumSeconds)
    || stabilityMinimumSeconds < 5
    || stabilityMinimumSeconds > 120
    || !disableHmacIdentityConfigValid(env)
    || !disableIdentitiesAreIsolated(env)
  ) {
    throw new ProtocolError("disable_gateway_config_identity_invalid", 503);
  }
}

function disableIdentitiesAreIsolated(env: DisableRouteEnv): boolean {
  const disableKids = configuredValues([
    env.CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_CREATE_HMAC_CURRENT_KID,
    env.CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_CREATE_HMAC_PREVIOUS_KID,
    env.CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_HMAC_CURRENT_KID,
    env.CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_HMAC_PREVIOUS_KID,
  ]);
  const enableKids = configuredValues([
    env.CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_CURRENT_KID,
    env.CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_PREVIOUS_KID,
    env.CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_CURRENT_KID,
    env.CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_PREVIOUS_KID,
  ]);
  const disableCredentials = configuredValues([
    env
      .CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_CREATE_HMAC_CURRENT_CREDENTIAL_ID_SHA256,
    env
      .CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_CREATE_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256,
    env
      .CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_HMAC_CURRENT_CREDENTIAL_ID_SHA256,
    env
      .CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256,
  ]);
  const enableCredentials = configuredValues([
    env
      .CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_CURRENT_CREDENTIAL_ID_SHA256,
    env
      .CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256,
    env
      .CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_CURRENT_CREDENTIAL_ID_SHA256,
    env
      .CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256,
  ]);
  const disableSecrets = configuredValues([
    env.CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_CREATE_HMAC_CURRENT_SECRET ?? "",
    env.CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_CREATE_HMAC_PREVIOUS_SECRET ?? "",
    env.CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_HMAC_CURRENT_SECRET ?? "",
    env.CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_HMAC_PREVIOUS_SECRET ?? "",
  ]);
  const enableSecrets = configuredValues([
    env.CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_CURRENT_SECRET ?? "",
    env.CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_PREVIOUS_SECRET ?? "",
    env.CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_CURRENT_SECRET ?? "",
    env.CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_PREVIOUS_SECRET ?? "",
  ]);
  return disableKids.every((value) => KEY_ID.test(value))
    && disableCredentials.every((value) => SHA256.test(value))
    && disableKids.every((value) => !enableKids.includes(value))
    && disableCredentials.every(
      (value) => !enableCredentials.includes(value),
    )
    && disableSecrets.every((value) => !enableSecrets.includes(value));
}

function configuredValues(values: string[]): string[] {
  return values.filter((value) => value !== "");
}

function commandFromSnapshot(
  snapshot: DisableOperationSnapshot,
): FrozenControllerDisableCommand {
  let value: unknown;
  try {
    value = JSON.parse(snapshot.operation.command_json);
  } catch {
    throw new ProtocolError("disable_repository_command_invalid", 503);
  }
  return parseFrozenControllerDisableCommand(value);
}

function requireExpectedControllerService(
  env: DisableRouteEnv,
  command: FrozenControllerDisableCommand,
): void {
  if (
    command.controllerServiceName
      !== env.CONTROLLER_DEPLOYMENT_GATEWAY_CONTROLLER_SERVICE_NAME
  ) {
    throw new ProtocolError("disable_controller_service_mismatch", 409);
  }
}

function publicDisableOutcome(
  snapshot: DisableOperationSnapshot,
): Record<string, unknown> | null {
  const outcome = snapshot.outcome;
  if (outcome === null) return null;
  return {
    classification: outcome.classification,
    httpStatus: outcome.http_status,
    recordedAt: outcome.recorded_at,
    responseBodySha256: outcome.response_body_sha256,
    responseBytes: outcome.response_bytes,
    responseRequestIdSha256: outcome.response_request_id_sha256,
  };
}

function requireGate(value: string, code: string): void {
  if (value !== "true") throw new ProtocolError(code, 503);
}

function disableJsonResponse(
  status: number,
  value: Record<string, unknown>,
): Response {
  const body = canonicalJson(value);
  if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) {
    throw new ProtocolError("disable_response_too_large", 500);
  }
  return new Response(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}
