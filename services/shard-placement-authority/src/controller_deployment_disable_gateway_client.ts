import {
  ProtocolError,
  canonicalJson,
  sha256Hex,
} from "./protocol";

export const CONTROLLER_DISABLE_COMMAND_CONTRACT =
  "cinatoken-controller-deployment-gateway-disable-command-v1";
export const CONTROLLER_DISABLE_CREATE_REQUEST_CONTRACT =
  "cinatoken-controller-deployment-gateway-disable-create-request-v1";
export const CONTROLLER_DISABLE_IDEMPOTENCY_CONTRACT =
  "cinatoken-controller-deployment-gateway-disable-idempotency-v1";

const INTERNAL_ORIGIN = "https://controller-deployment-gateway.internal";
const DISABLE_PATH_PREFIX =
  "/internal/v1/controller-deployment-disables";
const HMAC_DOMAIN =
  "cinatoken-controller-deployment-gateway-disable-v1\n";
const HMAC_HEADER =
  "x-cinatoken-controller-deployment-gateway-disable";
const HMAC_TYPE =
  "CINATOKEN-CONTROLLER-DEPLOYMENT-GATEWAY-DISABLE";
const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const REQUEST_TIMEOUT_MILLISECONDS = 4_000;
const MAX_REQUEST_BODY_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024;
const HMAC_WINDOW_SECONDS = 60;
const SHA256 = /^[0-9a-f]{64}$/;
const IDENTITY = /^[A-Za-z0-9._:@/-]{1,256}$/;
const KEY_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SERVICE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const VERSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const encoder = new TextEncoder();

export interface ControllerDeploymentDisableGatewayServiceBinding {
  fetch(request: Request): Promise<Response>;
}

export interface ControllerDeploymentDisableGatewayClientEnv {
  CONTROLLER_DEPLOYMENT_GATEWAY:
    ControllerDeploymentDisableGatewayServiceBinding;
  CONTROLLER_DEPLOYMENT_GATEWAY_ISSUER: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_AUDIENCE: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_CREATE_HMAC_CURRENT_KID: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_CREATE_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
    string;
  CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_CREATE_HMAC_CURRENT_SECRET?: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_CREATE_HMAC_PREVIOUS_KID: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_CREATE_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256:
    string;
  CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_CREATE_HMAC_PREVIOUS_SECRET?: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_HMAC_CURRENT_KID: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
    string;
  CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_HMAC_CURRENT_SECRET?: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_HMAC_PREVIOUS_KID: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256:
    string;
  CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_HMAC_PREVIOUS_SECRET?: string;
}

export interface FrozenControllerDisableCommand {
  schemaVersion: 1;
  contract: typeof CONTROLLER_DISABLE_COMMAND_CONTRACT;
  authorizationIdSha256: string;
  claimDigestSha256: string;
  operation14IdSha256: string;
  authorityDatabaseIdentitySha256: string;
  authorityLedgerIdentitySha256: string;
  authorityLedgerHeadSha256: string;
  authorityVersionId: string;
  leaseOwnerSha256: string;
  leaseTokenSha256: string;
  leaseGeneration: number;
  controllerServiceName: string;
  controllerEnabledSourceVersionId: string;
  controllerBaselineTargetVersionId: string;
  sendAttemptLimit: 1;
  retryLimit: 0;
}

export interface ControllerDisableCreateInput {
  command: FrozenControllerDisableCommand;
  controllerDisableCommandDigestSha256: string;
  gatewayDisableIdempotencyKeySha256: string;
  authorityAttemptDigestSha256: string;
  sendStartedEventDigestSha256: string;
}

export interface ControllerDisableStatusInput {
  gatewayDisableIdempotencyKeySha256: string;
  controllerDisableCommandDigestSha256: string;
}

export interface ControllerDisableGatewayCallOptions {
  requestId: string;
  credentialGeneration?: "current" | "previous";
  now?: number;
}

export interface ControllerDisableMutationOutcome {
  classification: "accepted" | "rejected" | "ambiguous";
  httpStatus: number | null;
  responseBodySha256: string | null;
  responseRequestIdSha256: string | null;
  responseBytes: number | null;
  recordedAt: number;
}

export interface ControllerDisableCreateResult {
  result:
    | "disable_mutation_attempt_recorded"
    | "disable_exact_replay";
  requestId: string;
  gatewayDisableIdempotencyKeySha256: string;
  controllerDisableCommandDigestSha256: string;
  mutationRequestSha256: string;
  networkRequestSent: boolean;
  recoveryAction: "status_only";
  outcome: ControllerDisableMutationOutcome | null;
  gatewayVersionId: string;
}

export interface ControllerDisableStatusObservation {
  classification:
    | "exact_disable_observed"
    | "enabled_source_observed"
    | "deployment_drift"
    | "ambiguous";
  deploymentsHttpStatus: number | null;
  baselineVersionHttpStatus: number | null;
  deploymentSetSha256: string | null;
  baselineVersionSha256: string | null;
  responseRequestIdSha256: string | null;
  stateDigestSha256: string;
  observationDigestSha256: string;
  recordedAt: number;
}

export interface ControllerDisableStatusResult {
  result:
    | "disable_status_observation_recorded"
    | "disable_status_observation_replayed";
  requestId: string;
  gatewayDisableIdempotencyKeySha256: string;
  controllerDisableCommandDigestSha256: string;
  remoteMutationSent: false;
  remoteReadSent: boolean;
  targetStable: boolean;
  requiredMatchingObservations: 2;
  stabilityMinimumSeconds: number;
  observation: ControllerDisableStatusObservation;
  gatewayVersionId: string;
}

export interface ControllerDisableGatewayCallEvidence<T> {
  value: T;
  gatewayCredentialIdSha256: string;
  gatewayRequestIdSha256: string;
  gatewayResponseSha256: string;
  gatewayResponseBytes: number;
}

export class ControllerDeploymentDisableGatewayClientError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly classification:
      | "request_invalid"
      | "create_outcome_unknown"
      | "status_unavailable"
      | "invalid_response",
    readonly recoveryAction: "none" | "status_only" | "retry_status_only",
  ) {
    super(code);
    this.name = "ControllerDeploymentDisableGatewayClientError";
  }
}

export async function createControllerDisableOnceWithEvidence(
  env: ControllerDeploymentDisableGatewayClientEnv,
  input: ControllerDisableCreateInput,
  options: ControllerDisableGatewayCallOptions,
): Promise<
  ControllerDisableGatewayCallEvidence<ControllerDisableCreateResult>
> {
  validateControllerDeploymentDisableGatewayClientConfig(env);
  const body = await buildCreateBody(input);
  const pathAndQuery =
    `${DISABLE_PATH_PREFIX}/${input.gatewayDisableIdempotencyKeySha256}`
    + "/create-once";
  const signed = await signedRequest(
    env,
    "disable_create",
    pathAndQuery,
    body,
    options,
  );
  return fetchOnce(
    env,
    signed,
    "disable_create",
    async (response) => {
      await requireResponseMetadata(response, [200, 201]);
      const bytes = await readBoundedResponse(response);
      return {
        value: await parseCreateResponse(
          bytes,
          response.status,
          input,
          options.requestId,
        ),
        ...await callEvidence(
          env,
          "disable_create",
          options,
          bytes,
        ),
      };
    },
  );
}

export async function readControllerDisableStatusWithEvidence(
  env: ControllerDeploymentDisableGatewayClientEnv,
  input: ControllerDisableStatusInput,
  options: ControllerDisableGatewayCallOptions,
): Promise<
  ControllerDisableGatewayCallEvidence<ControllerDisableStatusResult>
> {
  validateControllerDeploymentDisableGatewayClientConfig(env);
  requireSha256(
    input.gatewayDisableIdempotencyKeySha256,
    "controller_disable_status_command_invalid",
  );
  requireSha256(
    input.controllerDisableCommandDigestSha256,
    "controller_disable_status_command_invalid",
  );
  const pathAndQuery =
    `${DISABLE_PATH_PREFIX}/${input.gatewayDisableIdempotencyKeySha256}`
    + "/status-readback"
    + `?commandDigestSha256=${input.controllerDisableCommandDigestSha256}`;
  const signed = await signedRequest(
    env,
    "disable_status",
    pathAndQuery,
    new Uint8Array(),
    options,
  );
  return fetchOnce(
    env,
    signed,
    "disable_status",
    async (response) => {
      await requireResponseMetadata(response, [200, 201]);
      const bytes = await readBoundedResponse(response);
      return {
        value: parseStatusResponse(
          bytes,
          input,
          options.requestId,
        ),
        ...await callEvidence(
          env,
          "disable_status",
          options,
          bytes,
        ),
      };
    },
  );
}

export async function controllerDisableMutationRequestSha256(
  command: FrozenControllerDisableCommand,
): Promise<string> {
  validateFrozenCommand(command);
  const intentSha256 = await digestCanonical({
    schemaVersion: 1,
    contract:
      "cinatoken-controller-deployment-gateway-disable-mutation-intent-v1",
    authorizationIdSha256: command.authorizationIdSha256,
    operation14IdSha256: command.operation14IdSha256,
    controllerServiceName: command.controllerServiceName,
    controllerEnabledSourceVersionId:
      command.controllerEnabledSourceVersionId,
    controllerBaselineTargetVersionId:
      command.controllerBaselineTargetVersionId,
  });
  return digestCanonical({
    annotations: {
      "workers/message":
        `cinatoken-controller-disable-v1:${command.operation14IdSha256}:${intentSha256}`,
    },
    strategy: "percentage",
    versions: [{
      percentage: 100,
      version_id: command.controllerBaselineTargetVersionId,
    }],
  });
}

export async function controllerDisableCommandDigestSha256(
  command: FrozenControllerDisableCommand,
): Promise<string> {
  validateFrozenCommand(command);
  return digestCanonical(command);
}

export async function controllerDisableIdempotencyKeySha256(
  command: FrozenControllerDisableCommand,
): Promise<string> {
  return digestCanonical({
    schemaVersion: 1,
    contract: CONTROLLER_DISABLE_IDEMPOTENCY_CONTRACT,
    attemptGeneration: 1,
    authorizationIdSha256: command.authorizationIdSha256,
    claimDigestSha256: command.claimDigestSha256,
    controllerDisableCommandDigestSha256:
      await controllerDisableCommandDigestSha256(command),
    operation14IdSha256: command.operation14IdSha256,
  });
}

export function validateControllerDeploymentDisableGatewayClientConfig(
  env: ControllerDeploymentDisableGatewayClientEnv,
): void {
  if (
    env.CONTROLLER_DEPLOYMENT_GATEWAY === undefined
    || typeof env.CONTROLLER_DEPLOYMENT_GATEWAY.fetch !== "function"
    || !IDENTITY.test(env.CONTROLLER_DEPLOYMENT_GATEWAY_ISSUER)
    || !IDENTITY.test(env.CONTROLLER_DEPLOYMENT_GATEWAY_AUDIENCE)
  ) {
    throw clientError(
      "controller_disable_gateway_client_config_invalid",
      503,
      "request_invalid",
      "none",
    );
  }
  const identities = [
    credential(env, "disable_create", "current"),
    credential(env, "disable_status", "current"),
  ];
  for (const role of ["disable_create", "disable_status"] as const) {
    const previous = credential(env, role, "previous");
    if (
      previous.kid !== ""
      || previous.credentialIdSha256 !== ""
      || previous.secret !== ""
    ) {
      identities.push(previous);
    }
  }
  if (
    identities.some(
      (identity) =>
        !KEY_ID.test(identity.kid)
        || !SHA256.test(identity.credentialIdSha256)
        || encoder.encode(identity.secret).byteLength < 32
        || encoder.encode(identity.secret).byteLength > 256,
    )
    || new Set(identities.map((identity) => identity.kid)).size
      !== identities.length
    || new Set(
      identities.map((identity) => identity.credentialIdSha256),
    ).size !== identities.length
    || new Set(identities.map((identity) => identity.secret)).size
      !== identities.length
  ) {
    throw clientError(
      "controller_disable_gateway_client_config_invalid",
      503,
      "request_invalid",
      "none",
    );
  }
}

async function buildCreateBody(
  input: ControllerDisableCreateInput,
): Promise<Uint8Array> {
  validateFrozenCommand(input.command);
  for (const digest of [
    input.controllerDisableCommandDigestSha256,
    input.gatewayDisableIdempotencyKeySha256,
    input.authorityAttemptDigestSha256,
    input.sendStartedEventDigestSha256,
  ]) {
    requireSha256(digest, "controller_disable_create_command_invalid");
  }
  if (
    input.controllerDisableCommandDigestSha256
      !== await controllerDisableCommandDigestSha256(input.command)
    || input.gatewayDisableIdempotencyKeySha256
      !== await controllerDisableIdempotencyKeySha256(input.command)
  ) {
    throw clientError(
      "controller_disable_create_digest_mismatch",
      409,
      "request_invalid",
      "none",
    );
  }
  const body = encoder.encode(canonicalJson({
    schemaVersion: 1,
    contract: CONTROLLER_DISABLE_CREATE_REQUEST_CONTRACT,
    command: input.command,
    controllerDisableCommandDigestSha256:
      input.controllerDisableCommandDigestSha256,
    gatewayDisableIdempotencyKeySha256:
      input.gatewayDisableIdempotencyKeySha256,
    authorityAttemptDigestSha256:
      input.authorityAttemptDigestSha256,
    sendStartedEventDigestSha256:
      input.sendStartedEventDigestSha256,
  }));
  if (body.byteLength > MAX_REQUEST_BODY_BYTES) {
    throw clientError(
      "controller_disable_create_request_too_large",
      413,
      "request_invalid",
      "none",
    );
  }
  return body;
}

async function signedRequest(
  env: ControllerDeploymentDisableGatewayClientEnv,
  role: "disable_create" | "disable_status",
  pathAndQuery: string,
  body: Uint8Array,
  options: ControllerDisableGatewayCallOptions,
): Promise<Request> {
  const now = options.now ?? Math.floor(Date.now() / 1_000);
  if (
    !IDENTITY.test(options.requestId)
    || !Number.isSafeInteger(now)
    || now <= 0
  ) {
    throw clientError(
      "controller_disable_gateway_request_identity_invalid",
      400,
      "request_invalid",
      "none",
    );
  }
  const selected = credential(
    env,
    role,
    options.credentialGeneration ?? "current",
  );
  if (
    !KEY_ID.test(selected.kid)
    || !SHA256.test(selected.credentialIdSha256)
    || encoder.encode(selected.secret).byteLength < 32
  ) {
    throw clientError(
      "controller_disable_gateway_credential_unavailable",
      503,
      "request_invalid",
      "none",
    );
  }
  const bodySha256 = body.byteLength === 0
    ? EMPTY_SHA256
    : await sha256Hex(body);
  const headerPart = encodeBase64Url(encoder.encode(canonicalJson({
    alg: "HS256",
    kid: selected.kid,
    typ: HMAC_TYPE,
  })));
  const claimsPart = encodeBase64Url(encoder.encode(canonicalJson({
    issuer: env.CONTROLLER_DEPLOYMENT_GATEWAY_ISSUER,
    audience: env.CONTROLLER_DEPLOYMENT_GATEWAY_AUDIENCE,
    role,
    credential_id_sha256: selected.credentialIdSha256,
    request_id: options.requestId,
    method: "POST",
    path_and_query: pathAndQuery,
    body_sha256: bodySha256,
    issued_at: now,
    expires_at: now + HMAC_WINDOW_SECONDS,
  })));
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(selected.secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = new Uint8Array(await crypto.subtle.sign(
      "HMAC",
      key,
      copyArrayBuffer(
        encoder.encode(`${HMAC_DOMAIN}${headerPart}.${claimsPart}`),
      ),
    ));
    const headers: Record<string, string> = {
      accept: "application/json",
      [HMAC_HEADER]:
        `${headerPart}.${claimsPart}.${encodeBase64Url(signature)}`,
    };
    if (body.byteLength > 0) headers["content-type"] = "application/json";
    return new Request(`${INTERNAL_ORIGIN}${pathAndQuery}`, {
      method: "POST",
      redirect: "manual",
      headers,
      body: body.byteLength === 0 ? undefined : body,
    });
  } catch {
    throw clientError(
      "controller_disable_gateway_client_unavailable",
      503,
      "request_invalid",
      "none",
    );
  }
}

async function fetchOnce<T>(
  env: ControllerDeploymentDisableGatewayClientEnv,
  request: Request,
  role: "disable_create" | "disable_status",
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort("controller_disable_gateway_timeout"),
    REQUEST_TIMEOUT_MILLISECONDS,
  );
  try {
    const response = await env.CONTROLLER_DEPLOYMENT_GATEWAY.fetch(
      new Request(request, { signal: controller.signal }),
    );
    return await consume(response);
  } catch (error) {
    if (error instanceof ControllerDeploymentDisableGatewayClientError) {
      throw error;
    }
    if (role === "disable_create") {
      throw clientError(
        "controller_disable_gateway_create_outcome_unknown",
        controller.signal.aborted ? 504 : 503,
        "create_outcome_unknown",
        "status_only",
      );
    }
    throw clientError(
      controller.signal.aborted
        ? "controller_disable_gateway_status_timeout"
        : "controller_disable_gateway_status_unavailable",
      controller.signal.aborted ? 504 : 503,
      "status_unavailable",
      "retry_status_only",
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function requireResponseMetadata(
  response: Response,
  statuses: readonly number[],
): Promise<void> {
  const contentLength = response.headers.get("content-length");
  const validLength = contentLength === null
    || (/^\d+$/.test(contentLength)
      && Number(contentLength) <= MAX_RESPONSE_BYTES);
  if (
    !statuses.includes(response.status)
    || response.redirected
    || response.headers.has("content-encoding")
    || !validLength
    || response.headers.get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() !== "application/json"
    || !hasNoStore(response.headers.get("cache-control"))
  ) {
    throw clientError(
      "controller_disable_gateway_invalid_response",
      502,
      "invalid_response",
      "status_only",
    );
  }
}

async function readBoundedResponse(response: Response): Promise<Uint8Array> {
  if (response.body === null) throw invalidResponse();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel("controller_disable_gateway_response_too_large");
        throw invalidResponse();
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof ControllerDeploymentDisableGatewayClientError) {
      throw error;
    }
    throw invalidResponse();
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw invalidResponse();
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function parseCreateResponse(
  bytes: Uint8Array,
  status: number,
  input: ControllerDisableCreateInput,
  requestId: string,
): Promise<ControllerDisableCreateResult> {
  const value = parseCanonicalObject(bytes);
  assertExactKeys(value, [
    "controllerDisableCommandDigestSha256",
    "gatewayDisableIdempotencyKeySha256",
    "gatewayVersionId",
    "mutationRequestSha256",
    "networkRequestSent",
    "outcome",
    "recoveryAction",
    "requestId",
    "result",
  ]);
  const result = requireSetString(value.result, new Set([
    "disable_mutation_attempt_recorded",
    "disable_exact_replay",
  ])) as ControllerDisableCreateResult["result"];
  const parsed: ControllerDisableCreateResult = {
    result,
    requestId: requireString(value.requestId, IDENTITY),
    gatewayDisableIdempotencyKeySha256:
      requireResponseSha256(value.gatewayDisableIdempotencyKeySha256),
    controllerDisableCommandDigestSha256:
      requireResponseSha256(value.controllerDisableCommandDigestSha256),
    mutationRequestSha256:
      requireResponseSha256(value.mutationRequestSha256),
    networkRequestSent: requireBoolean(value.networkRequestSent),
    recoveryAction: requireLiteral(value.recoveryAction, "status_only"),
    outcome: value.outcome === null
      ? null
      : parseMutationOutcome(requireObject(value.outcome)),
    gatewayVersionId: requireString(value.gatewayVersionId, VERSION_ID),
  };
  const exactReplay =
    status === 200
    && parsed.result === "disable_exact_replay"
    && parsed.networkRequestSent === false;
  const fresh =
    status === 201
    && parsed.result === "disable_mutation_attempt_recorded"
    && parsed.networkRequestSent === true
    && parsed.outcome !== null;
  if (
    (!fresh && !exactReplay)
    || parsed.requestId !== requestId
    || parsed.gatewayDisableIdempotencyKeySha256
      !== input.gatewayDisableIdempotencyKeySha256
    || parsed.controllerDisableCommandDigestSha256
      !== input.controllerDisableCommandDigestSha256
    || parsed.mutationRequestSha256
      !== await controllerDisableMutationRequestSha256(input.command)
  ) {
    throw invalidResponse();
  }
  return parsed;
}

function parseStatusResponse(
  bytes: Uint8Array,
  input: ControllerDisableStatusInput,
  requestId: string,
): ControllerDisableStatusResult {
  const value = parseCanonicalObject(bytes);
  assertExactKeys(value, [
    "controllerDisableCommandDigestSha256",
    "gatewayDisableIdempotencyKeySha256",
    "gatewayVersionId",
    "observation",
    "remoteMutationSent",
    "remoteReadSent",
    "requestId",
    "requiredMatchingObservations",
    "result",
    "stabilityMinimumSeconds",
    "targetStable",
  ]);
  const result = requireSetString(value.result, new Set([
    "disable_status_observation_recorded",
    "disable_status_observation_replayed",
  ])) as ControllerDisableStatusResult["result"];
  const parsed: ControllerDisableStatusResult = {
    result,
    requestId: requireString(value.requestId, IDENTITY),
    gatewayDisableIdempotencyKeySha256:
      requireResponseSha256(value.gatewayDisableIdempotencyKeySha256),
    controllerDisableCommandDigestSha256:
      requireResponseSha256(value.controllerDisableCommandDigestSha256),
    remoteMutationSent: requireLiteral(value.remoteMutationSent, false),
    remoteReadSent: requireBoolean(value.remoteReadSent),
    targetStable: requireBoolean(value.targetStable),
    requiredMatchingObservations:
      requireLiteral(value.requiredMatchingObservations, 2),
    stabilityMinimumSeconds:
      requireInteger(value.stabilityMinimumSeconds, 5, 120),
    observation:
      parseStatusObservation(requireObject(value.observation)),
    gatewayVersionId: requireString(value.gatewayVersionId, VERSION_ID),
  };
  if (
    parsed.requestId !== requestId
    || parsed.gatewayDisableIdempotencyKeySha256
      !== input.gatewayDisableIdempotencyKeySha256
    || parsed.controllerDisableCommandDigestSha256
      !== input.controllerDisableCommandDigestSha256
    || (
      parsed.result === "disable_status_observation_recorded"
        ? parsed.remoteReadSent !== true
        : parsed.remoteReadSent !== false
    )
    || (
      parsed.targetStable
      && parsed.observation.classification
        !== "exact_disable_observed"
    )
  ) {
    throw invalidResponse();
  }
  return parsed;
}

function parseMutationOutcome(
  value: Record<string, unknown>,
): ControllerDisableMutationOutcome {
  assertExactKeys(value, [
    "classification",
    "httpStatus",
    "recordedAt",
    "responseBodySha256",
    "responseBytes",
    "responseRequestIdSha256",
  ]);
  return {
    classification: requireSetString(value.classification, new Set([
      "accepted",
      "rejected",
      "ambiguous",
    ])) as ControllerDisableMutationOutcome["classification"],
    httpStatus: requireNullableInteger(value.httpStatus, 100, 599),
    responseBodySha256: requireNullableSha256(value.responseBodySha256),
    responseRequestIdSha256:
      requireNullableSha256(value.responseRequestIdSha256),
    responseBytes: requireNullableInteger(
      value.responseBytes,
      0,
      64 * 1024,
    ),
    recordedAt: requireInteger(value.recordedAt, 1, Number.MAX_SAFE_INTEGER),
  };
}

function parseStatusObservation(
  value: Record<string, unknown>,
): ControllerDisableStatusObservation {
  assertExactKeys(value, [
    "baselineVersionHttpStatus",
    "baselineVersionSha256",
    "classification",
    "deploymentsHttpStatus",
    "deploymentSetSha256",
    "observationDigestSha256",
    "recordedAt",
    "responseRequestIdSha256",
    "stateDigestSha256",
  ]);
  const observation: ControllerDisableStatusObservation = {
    classification: requireSetString(value.classification, new Set([
      "exact_disable_observed",
      "enabled_source_observed",
      "deployment_drift",
      "ambiguous",
    ])) as ControllerDisableStatusObservation["classification"],
    deploymentsHttpStatus:
      requireNullableInteger(value.deploymentsHttpStatus, 100, 599),
    baselineVersionHttpStatus:
      requireNullableInteger(value.baselineVersionHttpStatus, 100, 599),
    deploymentSetSha256:
      requireNullableSha256(value.deploymentSetSha256),
    baselineVersionSha256:
      requireNullableSha256(value.baselineVersionSha256),
    responseRequestIdSha256:
      requireNullableSha256(value.responseRequestIdSha256),
    stateDigestSha256:
      requireResponseSha256(value.stateDigestSha256),
    observationDigestSha256:
      requireResponseSha256(value.observationDigestSha256),
    recordedAt: requireInteger(value.recordedAt, 1, Number.MAX_SAFE_INTEGER),
  };
  if (
    observation.classification === "exact_disable_observed"
    && (
      observation.deploymentsHttpStatus === null
      || observation.baselineVersionHttpStatus === null
      || observation.deploymentSetSha256 === null
      || observation.baselineVersionSha256 === null
    )
  ) {
    throw invalidResponse();
  }
  return observation;
}

function validateFrozenCommand(command: FrozenControllerDisableCommand): void {
  if (
    command.schemaVersion !== 1
    || command.contract !== CONTROLLER_DISABLE_COMMAND_CONTRACT
    || !SHA256.test(command.authorizationIdSha256)
    || !SHA256.test(command.claimDigestSha256)
    || !SHA256.test(command.operation14IdSha256)
    || !SHA256.test(command.authorityDatabaseIdentitySha256)
    || !SHA256.test(command.authorityLedgerIdentitySha256)
    || !SHA256.test(command.authorityLedgerHeadSha256)
    || !VERSION_ID.test(command.authorityVersionId)
    || !SHA256.test(command.leaseOwnerSha256)
    || !SHA256.test(command.leaseTokenSha256)
    || !Number.isSafeInteger(command.leaseGeneration)
    || command.leaseGeneration < 1
    || !SERVICE_NAME.test(command.controllerServiceName)
    || !VERSION_ID.test(command.controllerEnabledSourceVersionId)
    || !VERSION_ID.test(command.controllerBaselineTargetVersionId)
    || command.controllerEnabledSourceVersionId
      === command.controllerBaselineTargetVersionId
    || command.sendAttemptLimit !== 1
    || command.retryLimit !== 0
  ) {
    throw clientError(
      "controller_disable_command_invalid",
      400,
      "request_invalid",
      "none",
    );
  }
}

async function callEvidence(
  env: ControllerDeploymentDisableGatewayClientEnv,
  role: "disable_create" | "disable_status",
  options: ControllerDisableGatewayCallOptions,
  bytes: Uint8Array,
): Promise<
  Omit<ControllerDisableGatewayCallEvidence<unknown>, "value">
> {
  const selected = credential(
    env,
    role,
    options.credentialGeneration ?? "current",
  );
  return {
    gatewayCredentialIdSha256: selected.credentialIdSha256,
    gatewayRequestIdSha256:
      await sha256Hex(encoder.encode(options.requestId)),
    gatewayResponseSha256: await sha256Hex(bytes),
    gatewayResponseBytes: bytes.byteLength,
  };
}

function credential(
  env: ControllerDeploymentDisableGatewayClientEnv,
  role: "disable_create" | "disable_status",
  generation: "current" | "previous",
): { kid: string; credentialIdSha256: string; secret: string } {
  const prefix = role === "disable_create"
    ? "CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_CREATE_HMAC"
    : "CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_HMAC";
  const suffix = generation === "current" ? "CURRENT" : "PREVIOUS";
  const record = env as unknown as Record<string, unknown>;
  return {
    kid: String(record[`${prefix}_${suffix}_KID`] ?? ""),
    credentialIdSha256: String(
      record[`${prefix}_${suffix}_CREDENTIAL_ID_SHA256`] ?? "",
    ),
    secret: String(record[`${prefix}_${suffix}_SECRET`] ?? ""),
  };
}

function parseCanonicalObject(bytes: Uint8Array): Record<string, unknown> {
  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    throw invalidResponse();
  }
  if (canonicalJson(value) !== text) throw invalidResponse();
  return requireObject(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (
    actual.length !== sorted.length
    || actual.some((key, index) => key !== sorted[index])
  ) {
    throw invalidResponse();
  }
}

function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidResponse();
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw invalidResponse();
  }
  return value;
}

function requireResponseSha256(value: unknown): string {
  return requireString(value, SHA256);
}

function requireNullableSha256(value: unknown): string | null {
  return value === null ? null : requireResponseSha256(value);
}

function requireBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw invalidResponse();
  return value;
}

function requireLiteral<T extends string | number | boolean>(
  value: unknown,
  expected: T,
): T {
  if (value !== expected) throw invalidResponse();
  return expected;
}

function requireSetString(
  value: unknown,
  values: ReadonlySet<string>,
): string {
  if (typeof value !== "string" || !values.has(value)) {
    throw invalidResponse();
  }
  return value;
}

function requireInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    throw invalidResponse();
  }
  return value;
}

function requireNullableInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null {
  return value === null
    ? null
    : requireInteger(value, minimum, maximum);
}

function requireSha256(value: string, code: string): void {
  if (!SHA256.test(value)) {
    throw clientError(code, 400, "request_invalid", "none");
  }
}

async function digestCanonical(value: unknown): Promise<string> {
  return sha256Hex(encoder.encode(canonicalJson(value)));
}

function hasNoStore(value: string | null): boolean {
  return value?.split(",").some(
    (directive) => directive.trim().toLowerCase() === "no-store",
  ) === true;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function invalidResponse(): ControllerDeploymentDisableGatewayClientError {
  return clientError(
    "controller_disable_gateway_invalid_response",
    502,
    "invalid_response",
    "status_only",
  );
}

function clientError(
  code: string,
  status: number,
  classification:
    | "request_invalid"
    | "create_outcome_unknown"
    | "status_unavailable"
    | "invalid_response",
  recoveryAction: "none" | "status_only" | "retry_status_only",
): ControllerDeploymentDisableGatewayClientError {
  return new ControllerDeploymentDisableGatewayClientError(
    code,
    status,
    classification,
    recoveryAction,
  );
}
