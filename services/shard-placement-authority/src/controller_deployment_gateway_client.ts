import {
  ProtocolError,
  canonicalJson,
  sha256Hex,
} from "./protocol";
import type {
  FrozenControllerEnableCommand,
} from "./start_enable_dispatch_send";

export const CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_REQUEST_CONTRACT =
  "cinatoken-controller-deployment-gateway-create-request-v1";
export const CONTROLLER_DEPLOYMENT_GATEWAY_IDEMPOTENCY_CONTRACT =
  "cinatoken-controller-deployment-gateway-idempotency-v1";
export const CONTROLLER_DEPLOYMENT_GATEWAY_MUTATION_INTENT_CONTRACT =
  "cinatoken-controller-deployment-gateway-mutation-intent-v1";

const INTERNAL_ORIGIN = "https://controller-deployment-gateway.internal";
const CREATE_PATH_PREFIX =
  "/internal/v1/controller-deployments";
const HMAC_DOMAIN = "cinatoken-controller-deployment-gateway-v1\n";
const HMAC_HEADER = "x-cinatoken-controller-deployment-gateway";
const HMAC_TYPE = "CINATOKEN-CONTROLLER-DEPLOYMENT-GATEWAY";
const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const MAX_REQUEST_BODY_BYTES = 4 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MILLISECONDS = 3_000;
const HMAC_WINDOW_SECONDS = 60;
const SHA256 = /^[0-9a-f]{64}$/;
const KEY_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const IDENTITY = /^[A-Za-z0-9._:@/-]{1,256}$/;
const SERVICE_NAME =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const VERSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

const COMMAND_FIELDS = [
  "schemaVersion",
  "contract",
  "authorizationIdSha256",
  "claimDigestSha256",
  "dispatchClaimDigestSha256",
  "dispatchConsumptionReceiptDigestSha256",
  "applicationDispatchConsumptionDigestSha256",
  "applicationTicketIdSha256",
  "campaignId",
  "applicationDatabaseIdentitySha256",
  "applicationVersionId",
  "authorityDatabaseIdentitySha256",
  "authorityLedgerIdentitySha256",
  "authorityLedgerHeadSha256",
  "authorityVersionId",
  "dispatchOwnerSha256",
  "leaseTokenSha256",
  "leaseGeneration",
  "controllerServiceName",
  "controllerEnableOperationIdSha256",
  "controllerBaselineVersionId",
  "controllerEnabledVersionId",
  "sendAttemptLimit",
  "retryLimit",
] as const;

export interface ControllerDeploymentGatewayServiceBinding {
  fetch(request: Request): Promise<Response>;
}

export interface ControllerDeploymentGatewayClientEnv {
  CONTROLLER_DEPLOYMENT_GATEWAY:
    ControllerDeploymentGatewayServiceBinding;
  CONTROLLER_DEPLOYMENT_GATEWAY_ISSUER: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_AUDIENCE: string;
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

export type ControllerDeploymentGatewayCredentialGeneration =
  | "current"
  | "previous";

export interface ControllerDeploymentGatewayCallOptions {
  requestId: string;
  credentialGeneration?: ControllerDeploymentGatewayCredentialGeneration;
  now?: number;
}

export interface ControllerDeploymentGatewayCallEvidence<T> {
  value: T;
  gatewayCredentialIdSha256: string;
  gatewayRequestIdSha256: string;
  gatewayResponseSha256: string;
  gatewayResponseBytes: number;
}

export interface ControllerDeploymentGatewayCreateInput {
  command: FrozenControllerEnableCommand;
  controllerCommandDigestSha256: string;
  gatewayIdempotencyKeySha256: string;
  authorityAttemptDigestSha256: string;
  sendStartedEventDigestSha256: string;
}

export interface ControllerDeploymentGatewayStatusInput {
  gatewayIdempotencyKeySha256: string;
  controllerCommandDigestSha256: string;
}

export interface ControllerDeploymentGatewayMutationOutcome {
  classification: "accepted" | "rejected" | "ambiguous";
  httpStatus: number | null;
  responseBodySha256: string | null;
  responseRequestIdSha256: string | null;
  responseBytes: number | null;
  recordedAt: number;
}

interface ControllerDeploymentGatewayCreateBase {
  requestId: string;
  gatewayIdempotencyKeySha256: string;
  controllerCommandDigestSha256: string;
  mutationRequestSha256: string;
  outcome: ControllerDeploymentGatewayMutationOutcome | null;
  gatewayVersionId: string;
}

export interface ControllerDeploymentGatewayMutationRecorded
  extends ControllerDeploymentGatewayCreateBase {
  result: "mutation_attempt_recorded";
  networkRequestSent: true;
  recoveryAction: "status_readback" | "status_only";
  outcome: ControllerDeploymentGatewayMutationOutcome;
}

export interface ControllerDeploymentGatewayExactReplay
  extends ControllerDeploymentGatewayCreateBase {
  result: "exact_replay";
  networkRequestSent: false;
  recoveryAction: "status_only";
}

export type ControllerDeploymentGatewayCreateResult =
  | ControllerDeploymentGatewayMutationRecorded
  | ControllerDeploymentGatewayExactReplay;

export interface ControllerDeploymentGatewayObservation {
  classification:
    | "target_observed"
    | "baseline_observed"
    | "deployment_drift"
    | "ambiguous";
  deploymentsHttpStatus: number | null;
  versionHttpStatus: number | null;
  deploymentSetSha256: string | null;
  targetVersionSha256: string | null;
  responseRequestIdSha256: string | null;
  observationDigestSha256: string;
  recordedAt: number;
}

export interface ControllerDeploymentGatewayStatusResult {
  result:
    | "status_observation_recorded"
    | "status_observation_replayed";
  requestId: string;
  gatewayIdempotencyKeySha256: string;
  controllerCommandDigestSha256: string;
  remoteMutationSent: false;
  statusRequestCount: 2;
  targetStable: boolean;
  requiredMatchingObservations: 2;
  stabilityMinimumSeconds: number;
  observation: ControllerDeploymentGatewayObservation;
  gatewayVersionId: string;
}

export type ControllerDeploymentGatewayFailureClassification =
  | "request_invalid"
  | "client_unavailable"
  | "create_outcome_unknown"
  | "status_unavailable";

export type ControllerDeploymentGatewayRecoveryAction =
  | "none"
  | "status_only"
  | "retry_status_only";

export class ControllerDeploymentGatewayClientError
  extends ProtocolError {
  constructor(
    code: string,
    status: number,
    readonly classification:
      ControllerDeploymentGatewayFailureClassification,
    readonly recoveryAction:
      ControllerDeploymentGatewayRecoveryAction,
  ) {
    super(code, status);
    this.name = "ControllerDeploymentGatewayClientError";
  }
}

interface HmacCredential {
  role: "create" | "status";
  generation: ControllerDeploymentGatewayCredentialGeneration;
  kid: string;
  credentialIdSha256: string;
  secret: string;
}

interface CreateRequestPayload {
  schemaVersion: 1;
  contract:
    typeof CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_REQUEST_CONTRACT;
  command: FrozenControllerEnableCommand;
  controllerCommandDigestSha256: string;
  gatewayIdempotencyKeySha256: string;
  authorityAttemptDigestSha256: string;
  sendStartedEventDigestSha256: string;
}

export function validateControllerDeploymentGatewayClientConfig(
  env: ControllerDeploymentGatewayClientEnv,
): void {
  const credentials = [
    credentialFromEnv(env, "create", "current"),
    credentialFromEnv(env, "create", "previous"),
    credentialFromEnv(env, "status", "current"),
    credentialFromEnv(env, "status", "previous"),
  ];
  const currentCredentials = credentials.filter(
    (credential) => credential.generation === "current",
  );
  const configured = credentials.filter(isConfiguredCredential);
  if (
    typeof env.CONTROLLER_DEPLOYMENT_GATEWAY?.fetch !== "function"
    || !IDENTITY.test(env.CONTROLLER_DEPLOYMENT_GATEWAY_ISSUER)
    || !IDENTITY.test(env.CONTROLLER_DEPLOYMENT_GATEWAY_AUDIENCE)
    || currentCredentials.some(
      (credential) => !validCredential(credential),
    )
    || credentials.some(
      (credential) =>
        credential.generation === "previous"
        && !emptyCredential(credential)
        && !validCredential(credential),
    )
    || new Set(configured.map((credential) => credential.kid)).size
      !== configured.length
    || new Set(
      configured.map((credential) => credential.credentialIdSha256),
    ).size !== configured.length
    || new Set(configured.map((credential) => credential.secret)).size
      !== configured.length
  ) {
    throw clientError(
      "controller_deployment_gateway_client_unavailable",
      503,
      "client_unavailable",
      "none",
    );
  }
}

export async function createControllerDeploymentOnce(
  env: ControllerDeploymentGatewayClientEnv,
  input: ControllerDeploymentGatewayCreateInput,
  options: ControllerDeploymentGatewayCallOptions,
): Promise<ControllerDeploymentGatewayCreateResult> {
  return (
    await createControllerDeploymentOnceWithEvidence(
      env,
      input,
      options,
    )
  ).value;
}

export async function createControllerDeploymentOnceWithEvidence(
  env: ControllerDeploymentGatewayClientEnv,
  input: ControllerDeploymentGatewayCreateInput,
  options: ControllerDeploymentGatewayCallOptions,
): Promise<
  ControllerDeploymentGatewayCallEvidence<
    ControllerDeploymentGatewayCreateResult
  >
> {
  validateControllerDeploymentGatewayClientConfig(env);
  const body = await buildCreatePayload(input);
  const expectedMutationRequestSha256 =
    await controllerDeploymentMutationRequestSha256(input.command);
  const pathAndQuery =
    `${CREATE_PATH_PREFIX}/${input.gatewayIdempotencyKeySha256}/create-once`;
  const request = await signedRequest(
    env,
    "create",
    pathAndQuery,
    body,
    options,
  );
  return fetchOnce(
    env.CONTROLLER_DEPLOYMENT_GATEWAY,
    request,
    "create",
    async (response) => {
      await requireResponseMetadata(response, "create", [200, 201]);
      const bytes = await readBoundedResponse(response, "create");
      return {
        value: parseCreateResponse(
          bytes,
          response.status,
          input,
          options.requestId,
          expectedMutationRequestSha256,
        ),
        gatewayCredentialIdSha256: selectCredential(
          env,
          "create",
          options.credentialGeneration ?? "current",
        ).credentialIdSha256,
        gatewayRequestIdSha256: await sha256Hex(
          new TextEncoder().encode(options.requestId),
        ),
        gatewayResponseSha256: await sha256Hex(bytes),
        gatewayResponseBytes: bytes.byteLength,
      };
    },
  );
}

export async function readControllerDeploymentStatus(
  env: ControllerDeploymentGatewayClientEnv,
  input: ControllerDeploymentGatewayStatusInput,
  options: ControllerDeploymentGatewayCallOptions,
): Promise<ControllerDeploymentGatewayStatusResult> {
  return (
    await readControllerDeploymentStatusWithEvidence(
      env,
      input,
      options,
    )
  ).value;
}

export async function readControllerDeploymentStatusWithEvidence(
  env: ControllerDeploymentGatewayClientEnv,
  input: ControllerDeploymentGatewayStatusInput,
  options: ControllerDeploymentGatewayCallOptions,
): Promise<
  ControllerDeploymentGatewayCallEvidence<
    ControllerDeploymentGatewayStatusResult
  >
> {
  validateControllerDeploymentGatewayClientConfig(env);
  requireSha256Input(
    input.gatewayIdempotencyKeySha256,
    "controller_deployment_gateway_status_command_invalid",
  );
  requireSha256Input(
    input.controllerCommandDigestSha256,
    "controller_deployment_gateway_status_command_invalid",
  );
  const pathAndQuery =
    `${CREATE_PATH_PREFIX}/${input.gatewayIdempotencyKeySha256}`
    + "/status-readback"
    + `?commandDigestSha256=${input.controllerCommandDigestSha256}`;
  const request = await signedRequest(
    env,
    "status",
    pathAndQuery,
    new Uint8Array(),
    options,
  );
  return fetchOnce(
    env.CONTROLLER_DEPLOYMENT_GATEWAY,
    request,
    "status",
    async (response) => {
      await requireResponseMetadata(response, "status", [200, 201]);
      const bytes = await readBoundedResponse(response, "status");
      return {
        value: parseStatusResponse(
          bytes,
          response.status,
          input,
          options.requestId,
        ),
        gatewayCredentialIdSha256: selectCredential(
          env,
          "status",
          options.credentialGeneration ?? "current",
        ).credentialIdSha256,
        gatewayRequestIdSha256: await sha256Hex(
          new TextEncoder().encode(options.requestId),
        ),
        gatewayResponseSha256: await sha256Hex(bytes),
        gatewayResponseBytes: bytes.byteLength,
      };
    },
  );
}

export async function controllerDeploymentMutationRequestSha256(
  command: FrozenControllerEnableCommand,
): Promise<string> {
  requireFrozenCommand(command);
  const intentSha256 = await sha256Hex(
    new TextEncoder().encode(canonicalJson({
      schemaVersion: 1,
      contract:
        CONTROLLER_DEPLOYMENT_GATEWAY_MUTATION_INTENT_CONTRACT,
      authorizationIdSha256: command.authorizationIdSha256,
      controllerEnableOperationIdSha256:
        command.controllerEnableOperationIdSha256,
      controllerServiceName: command.controllerServiceName,
      controllerEnabledVersionId: command.controllerEnabledVersionId,
    })),
  );
  return sha256Hex(new TextEncoder().encode(canonicalJson({
    annotations: {
      "workers/message":
        `cinatoken-controller-enable-v1:${command.controllerEnableOperationIdSha256}:${intentSha256}`,
    },
    strategy: "percentage",
    versions: [{
      percentage: 100,
      version_id: command.controllerEnabledVersionId,
    }],
  })));
}

async function buildCreatePayload(
  input: ControllerDeploymentGatewayCreateInput,
): Promise<Uint8Array> {
  const value: CreateRequestPayload = {
    schemaVersion: 1,
    contract:
      CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_REQUEST_CONTRACT,
    command: input.command,
    controllerCommandDigestSha256:
      input.controllerCommandDigestSha256,
    gatewayIdempotencyKeySha256:
      input.gatewayIdempotencyKeySha256,
    authorityAttemptDigestSha256:
      input.authorityAttemptDigestSha256,
    sendStartedEventDigestSha256:
      input.sendStartedEventDigestSha256,
  };
  let body: Uint8Array;
  try {
    body = new TextEncoder().encode(canonicalJson(value));
  } catch {
    throw clientError(
      "controller_deployment_gateway_create_command_invalid",
      400,
      "request_invalid",
      "none",
    );
  }
  if (body.byteLength > MAX_REQUEST_BODY_BYTES) {
    throw clientError(
      "controller_deployment_gateway_create_request_too_large",
      413,
      "request_invalid",
      "none",
    );
  }
  requireFrozenCommand(input.command);
  for (const digest of [
    input.controllerCommandDigestSha256,
    input.gatewayIdempotencyKeySha256,
    input.authorityAttemptDigestSha256,
    input.sendStartedEventDigestSha256,
  ]) {
    requireSha256Input(
      digest,
      "controller_deployment_gateway_create_command_invalid",
    );
  }
  const commandDigestSha256 = await sha256Hex(
    new TextEncoder().encode(canonicalJson(input.command)),
  );
  if (
    commandDigestSha256 !== input.controllerCommandDigestSha256
  ) {
    throw clientError(
      "controller_deployment_gateway_controller_command_digest_mismatch",
      409,
      "request_invalid",
      "none",
    );
  }
  const expectedIdempotencyKeySha256 = await sha256Hex(
    new TextEncoder().encode(canonicalJson({
      schemaVersion: 1,
      contract: CONTROLLER_DEPLOYMENT_GATEWAY_IDEMPOTENCY_CONTRACT,
      attemptGeneration: 1,
      authorizationIdSha256: input.command.authorizationIdSha256,
      dispatchConsumptionReceiptDigestSha256:
        input.command.dispatchConsumptionReceiptDigestSha256,
      controllerCommandDigestSha256: commandDigestSha256,
      controllerEnableOperationIdSha256:
        input.command.controllerEnableOperationIdSha256,
    })),
  );
  if (
    expectedIdempotencyKeySha256
      !== input.gatewayIdempotencyKeySha256
  ) {
    throw clientError(
      "controller_deployment_gateway_idempotency_digest_mismatch",
      409,
      "request_invalid",
      "none",
    );
  }
  return body;
}

async function signedRequest(
  env: ControllerDeploymentGatewayClientEnv,
  role: "create" | "status",
  pathAndQuery: string,
  body: Uint8Array,
  options: ControllerDeploymentGatewayCallOptions,
): Promise<Request> {
  const now = options.now ?? Math.floor(Date.now() / 1_000);
  if (
    !IDENTITY.test(options.requestId)
    || !Number.isSafeInteger(now)
    || now <= 0
    || (
      options.credentialGeneration !== undefined
      && options.credentialGeneration !== "current"
      && options.credentialGeneration !== "previous"
    )
  ) {
    throw clientError(
      "controller_deployment_gateway_request_identity_invalid",
      400,
      "request_invalid",
      "none",
    );
  }
  const credential = selectCredential(
    env,
    role,
    options.credentialGeneration ?? "current",
  );
  const bodySha256 = body.byteLength === 0
    ? EMPTY_SHA256
    : await sha256Hex(body);
  const headerPart = encodeBase64Url(
    new TextEncoder().encode(canonicalJson({
      typ: HMAC_TYPE,
      alg: "HS256",
      kid: credential.kid,
    })),
  );
  const claimsPart = encodeBase64Url(
    new TextEncoder().encode(canonicalJson({
      issuer: env.CONTROLLER_DEPLOYMENT_GATEWAY_ISSUER,
      audience: env.CONTROLLER_DEPLOYMENT_GATEWAY_AUDIENCE,
      role,
      credential_id_sha256: credential.credentialIdSha256,
      request_id: options.requestId,
      method: "POST",
      path_and_query: pathAndQuery,
      body_sha256: bodySha256,
      issued_at: now,
      expires_at: now + HMAC_WINDOW_SECONDS,
    })),
  );
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(credential.secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(
          `${HMAC_DOMAIN}${headerPart}.${claimsPart}`,
        ),
      ),
    );
    const headers: Record<string, string> = {
      accept: "application/json",
      [HMAC_HEADER]:
        `${headerPart}.${claimsPart}.${encodeBase64Url(signature)}`,
    };
    if (body.byteLength > 0) {
      headers["content-type"] = "application/json";
    }
    return new Request(`${INTERNAL_ORIGIN}${pathAndQuery}`, {
      method: "POST",
      redirect: "manual",
      headers,
      body: body.byteLength === 0 ? undefined : body,
    });
  } catch {
    throw clientError(
      "controller_deployment_gateway_client_unavailable",
      503,
      "client_unavailable",
      "none",
    );
  }
}

async function fetchOnce<T>(
  binding: ControllerDeploymentGatewayServiceBinding,
  request: Request,
  role: "create" | "status",
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort("controller_deployment_gateway_timeout"),
    REQUEST_TIMEOUT_MILLISECONDS,
  );
  const forwarded = new Request(request, { signal: controller.signal });
  try {
    const response = await binding.fetch(forwarded);
    return await consume(response);
  } catch (error) {
    if (error instanceof ControllerDeploymentGatewayClientError) {
      throw error;
    }
    if (role === "create") {
      throw clientError(
        "controller_deployment_gateway_create_outcome_unknown",
        controller.signal.aborted ? 504 : 503,
        "create_outcome_unknown",
        "status_only",
      );
    }
    throw clientError(
      controller.signal.aborted
        ? "controller_deployment_gateway_status_timeout"
        : "controller_deployment_gateway_status_unavailable",
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
  role: "create" | "status",
  expectedStatuses: readonly number[],
): Promise<void> {
  const valid =
    expectedStatuses.includes(response.status)
    && !response.redirected
    && !response.headers.has("content-encoding")
    && validContentLength(response.headers.get("content-length"))
    && response.headers.get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() === "application/json"
    && hasNoStore(response.headers.get("cache-control"));
  if (!valid) throw responseFailure(role, "invalid_response");
}

async function readBoundedResponse(
  response: Response,
  role: "create" | "status",
): Promise<Uint8Array> {
  if (response.body === null) {
    throw responseFailure(role, "invalid_response");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel(
          "controller_deployment_gateway_response_too_large",
        );
        throw responseFailure(role, "response_too_large");
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof ControllerDeploymentGatewayClientError) {
      throw error;
    }
    throw responseFailure(role, "invalid_response");
  } finally {
    reader.releaseLock();
  }
  if (total === 0) {
    throw responseFailure(role, "invalid_response");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseCreateResponse(
  bytes: Uint8Array,
  status: number,
  input: ControllerDeploymentGatewayCreateInput,
  requestId: string,
  expectedMutationRequestSha256: string,
): ControllerDeploymentGatewayCreateResult {
  const object = parseResponseObject(bytes, "create");
  assertExactResponseKeys(object, [
    "result",
    "requestId",
    "gatewayIdempotencyKeySha256",
    "controllerCommandDigestSha256",
    "mutationRequestSha256",
    "networkRequestSent",
    "recoveryAction",
    "outcome",
    "gatewayVersionId",
  ], "create");
  const outcome = object.outcome === null
    ? null
    : parseMutationOutcome(object.outcome);
  const base = {
    requestId: requireResponseString(
      object.requestId,
      IDENTITY,
      "create",
    ),
    gatewayIdempotencyKeySha256: requireResponseSha256(
      object.gatewayIdempotencyKeySha256,
      "create",
    ),
    controllerCommandDigestSha256: requireResponseSha256(
      object.controllerCommandDigestSha256,
      "create",
    ),
    mutationRequestSha256: requireResponseSha256(
      object.mutationRequestSha256,
      "create",
    ),
    outcome,
    gatewayVersionId: requireResponseString(
      object.gatewayVersionId,
      VERSION_ID,
      "create",
    ),
  };
  if (
    base.requestId !== requestId
    || base.gatewayIdempotencyKeySha256
      !== input.gatewayIdempotencyKeySha256
    || base.controllerCommandDigestSha256
      !== input.controllerCommandDigestSha256
    || base.mutationRequestSha256
      !== expectedMutationRequestSha256
  ) {
    throw responseFailure("create", "response_mismatch");
  }
  if (
    status === 201
    && object.result === "mutation_attempt_recorded"
    && object.networkRequestSent === true
    && outcome !== null
    && (
      (
        outcome.classification === "accepted"
        && object.recoveryAction === "status_readback"
      )
      || (
        outcome.classification !== "accepted"
        && object.recoveryAction === "status_only"
      )
    )
  ) {
    return {
      ...base,
      result: "mutation_attempt_recorded",
      networkRequestSent: true,
      recoveryAction: object.recoveryAction,
      outcome,
    };
  }
  if (
    status === 200
    && object.result === "exact_replay"
    && object.networkRequestSent === false
    && object.recoveryAction === "status_only"
  ) {
    return {
      ...base,
      result: "exact_replay",
      networkRequestSent: false,
      recoveryAction: "status_only",
    };
  }
  throw responseFailure("create", "invalid_response");
}

function parseStatusResponse(
  bytes: Uint8Array,
  status: number,
  input: ControllerDeploymentGatewayStatusInput,
  requestId: string,
): ControllerDeploymentGatewayStatusResult {
  const object = parseResponseObject(bytes, "status");
  assertExactResponseKeys(object, [
    "result",
    "requestId",
    "gatewayIdempotencyKeySha256",
    "controllerCommandDigestSha256",
    "remoteMutationSent",
    "statusRequestCount",
    "targetStable",
    "requiredMatchingObservations",
    "stabilityMinimumSeconds",
    "observation",
    "gatewayVersionId",
  ], "status");
  const result = object.result === "status_observation_recorded"
    ? "status_observation_recorded"
    : object.result === "status_observation_replayed"
    ? "status_observation_replayed"
    : null;
  const parsed: ControllerDeploymentGatewayStatusResult = {
    result: result ?? responseValueFailure("status"),
    requestId: requireResponseString(
      object.requestId,
      IDENTITY,
      "status",
    ),
    gatewayIdempotencyKeySha256: requireResponseSha256(
      object.gatewayIdempotencyKeySha256,
      "status",
    ),
    controllerCommandDigestSha256: requireResponseSha256(
      object.controllerCommandDigestSha256,
      "status",
    ),
    remoteMutationSent: requireResponseLiteral(
      object.remoteMutationSent,
      false,
      "status",
    ),
    statusRequestCount: requireResponseLiteral(
      object.statusRequestCount,
      2,
      "status",
    ),
    targetStable: requireResponseBoolean(
      object.targetStable,
      "status",
    ),
    requiredMatchingObservations: requireResponseLiteral(
      object.requiredMatchingObservations,
      2,
      "status",
    ),
    stabilityMinimumSeconds: requireResponseInteger(
      object.stabilityMinimumSeconds,
      5,
      120,
      "status",
    ),
    observation: parseObservation(object.observation),
    gatewayVersionId: requireResponseString(
      object.gatewayVersionId,
      VERSION_ID,
      "status",
    ),
  };
  if (
    parsed.requestId !== requestId
    || parsed.gatewayIdempotencyKeySha256
      !== input.gatewayIdempotencyKeySha256
    || parsed.controllerCommandDigestSha256
      !== input.controllerCommandDigestSha256
    || (
      status === 201
        ? parsed.result !== "status_observation_recorded"
        : parsed.result !== "status_observation_replayed"
    )
    || (
      parsed.targetStable
      && parsed.observation.classification !== "target_observed"
    )
  ) {
    throw responseFailure("status", "response_mismatch");
  }
  return parsed;
}

function parseMutationOutcome(
  value: unknown,
): ControllerDeploymentGatewayMutationOutcome {
  const object = requireResponseObject(value, "create");
  assertExactResponseKeys(object, [
    "classification",
    "httpStatus",
    "responseBodySha256",
    "responseRequestIdSha256",
    "responseBytes",
    "recordedAt",
  ], "create");
  const classification =
    object.classification === "accepted"
      || object.classification === "rejected"
      || object.classification === "ambiguous"
      ? object.classification
      : responseValueFailure("create");
  const outcome: ControllerDeploymentGatewayMutationOutcome = {
    classification,
    httpStatus: requireNullableResponseInteger(
      object.httpStatus,
      100,
      599,
      "create",
    ),
    responseBodySha256: requireNullableResponseSha256(
      object.responseBodySha256,
      "create",
    ),
    responseRequestIdSha256: requireNullableResponseSha256(
      object.responseRequestIdSha256,
      "create",
    ),
    responseBytes: requireNullableResponseInteger(
      object.responseBytes,
      0,
      MAX_RESPONSE_BYTES,
      "create",
    ),
    recordedAt: requireResponseInteger(
      object.recordedAt,
      1,
      Number.MAX_SAFE_INTEGER,
      "create",
    ),
  };
  const hasBody = outcome.responseBodySha256 !== null
    && outcome.responseBytes !== null;
  const hasNoBody = outcome.responseBodySha256 === null
    && outcome.responseBytes === null;
  const accepted = classification === "accepted"
    && outcome.httpStatus !== null
    && outcome.httpStatus >= 200
    && outcome.httpStatus <= 299
    && hasBody;
  const rejected = classification === "rejected"
    && outcome.httpStatus !== null
    && outcome.httpStatus >= 300
    && outcome.httpStatus <= 499
    && ![408, 425, 429].includes(outcome.httpStatus)
    && hasBody;
  if (
    (!hasBody && !hasNoBody)
    || (classification === "accepted" && !accepted)
    || (classification === "rejected" && !rejected)
  ) {
    throw responseFailure("create", "invalid_response");
  }
  return outcome;
}

function parseObservation(
  value: unknown,
): ControllerDeploymentGatewayObservation {
  const object = requireResponseObject(value, "status");
  assertExactResponseKeys(object, [
    "classification",
    "deploymentsHttpStatus",
    "versionHttpStatus",
    "deploymentSetSha256",
    "targetVersionSha256",
    "responseRequestIdSha256",
    "observationDigestSha256",
    "recordedAt",
  ], "status");
  const classification =
    object.classification === "target_observed"
      || object.classification === "baseline_observed"
      || object.classification === "deployment_drift"
      || object.classification === "ambiguous"
      ? object.classification
      : responseValueFailure("status");
  const observation: ControllerDeploymentGatewayObservation = {
    classification,
    deploymentsHttpStatus: requireNullableResponseInteger(
      object.deploymentsHttpStatus,
      100,
      599,
      "status",
    ),
    versionHttpStatus: requireNullableResponseInteger(
      object.versionHttpStatus,
      100,
      599,
      "status",
    ),
    deploymentSetSha256: requireNullableResponseSha256(
      object.deploymentSetSha256,
      "status",
    ),
    targetVersionSha256: requireNullableResponseSha256(
      object.targetVersionSha256,
      "status",
    ),
    responseRequestIdSha256: requireNullableResponseSha256(
      object.responseRequestIdSha256,
      "status",
    ),
    observationDigestSha256: requireResponseSha256(
      object.observationDigestSha256,
      "status",
    ),
    recordedAt: requireResponseInteger(
      object.recordedAt,
      1,
      Number.MAX_SAFE_INTEGER,
      "status",
    ),
  };
  if (
    classification !== "ambiguous"
    && (
      observation.deploymentsHttpStatus === null
      || observation.deploymentsHttpStatus < 200
      || observation.deploymentsHttpStatus > 299
      || observation.versionHttpStatus === null
      || observation.versionHttpStatus < 200
      || observation.versionHttpStatus > 299
      || observation.deploymentSetSha256 === null
      || observation.targetVersionSha256 === null
    )
  ) {
    throw responseFailure("status", "invalid_response");
  }
  return observation;
}

function requireFrozenCommand(
  value: unknown,
): void {
  if (!plainObject(value)) {
    throw requestInvalid("create");
  }
  const object = value;
  const actual = Object.keys(object).sort();
  const expected = [...COMMAND_FIELDS].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
    || object.schemaVersion !== 1
    || object.contract
      !== "cinatoken-controller-deployment-gateway-enable-command-v1"
    || !isSha256(object.authorizationIdSha256)
    || !isSha256(object.claimDigestSha256)
    || !isSha256(object.dispatchClaimDigestSha256)
    || !isSha256(object.dispatchConsumptionReceiptDigestSha256)
    || !isSha256(object.applicationDispatchConsumptionDigestSha256)
    || !isSha256(object.applicationTicketIdSha256)
    || !isSha256(object.campaignId)
    || !isSha256(object.applicationDatabaseIdentitySha256)
    || typeof object.applicationVersionId !== "string"
    || !VERSION_ID.test(object.applicationVersionId)
    || !isSha256(object.authorityDatabaseIdentitySha256)
    || !isSha256(object.authorityLedgerIdentitySha256)
    || !isSha256(object.authorityLedgerHeadSha256)
    || typeof object.authorityVersionId !== "string"
    || !VERSION_ID.test(object.authorityVersionId)
    || !isSha256(object.dispatchOwnerSha256)
    || !isSha256(object.leaseTokenSha256)
    || object.leaseGeneration !== 1
    || typeof object.controllerServiceName !== "string"
    || !SERVICE_NAME.test(object.controllerServiceName)
    || !isSha256(object.controllerEnableOperationIdSha256)
    || typeof object.controllerBaselineVersionId !== "string"
    || !VERSION_ID.test(object.controllerBaselineVersionId)
    || typeof object.controllerEnabledVersionId !== "string"
    || !VERSION_ID.test(object.controllerEnabledVersionId)
    || object.controllerBaselineVersionId
      === object.controllerEnabledVersionId
    || object.sendAttemptLimit !== 1
    || object.retryLimit !== 0
  ) {
    throw requestInvalid("create");
  }
}

function selectCredential(
  env: ControllerDeploymentGatewayClientEnv,
  role: "create" | "status",
  generation: ControllerDeploymentGatewayCredentialGeneration,
): HmacCredential {
  const credential = credentialFromEnv(env, role, generation);
  if (!validCredential(credential)) {
    throw clientError(
      "controller_deployment_gateway_client_unavailable",
      503,
      "client_unavailable",
      "none",
    );
  }
  return credential;
}

function credentialFromEnv(
  env: ControllerDeploymentGatewayClientEnv,
  role: "create" | "status",
  generation: ControllerDeploymentGatewayCredentialGeneration,
): HmacCredential {
  if (role === "create" && generation === "current") {
    return {
      role,
      generation,
      kid:
        env.CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_CURRENT_KID,
      credentialIdSha256:
        env
          .CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_CURRENT_CREDENTIAL_ID_SHA256,
      secret:
        env.CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_CURRENT_SECRET
        ?? "",
    };
  }
  if (role === "create") {
    return {
      role,
      generation,
      kid:
        env.CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_PREVIOUS_KID,
      credentialIdSha256:
        env
          .CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256,
      secret:
        env.CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_PREVIOUS_SECRET
        ?? "",
    };
  }
  if (generation === "current") {
    return {
      role,
      generation,
      kid:
        env.CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_CURRENT_KID,
      credentialIdSha256:
        env
          .CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_CURRENT_CREDENTIAL_ID_SHA256,
      secret:
        env.CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_CURRENT_SECRET
        ?? "",
    };
  }
  return {
    role,
    generation,
    kid:
      env.CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_PREVIOUS_KID,
    credentialIdSha256:
      env
        .CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256,
    secret:
      env.CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_PREVIOUS_SECRET
      ?? "",
  };
}

function validCredential(value: HmacCredential): boolean {
  return KEY_ID.test(value.kid)
    && SHA256.test(value.credentialIdSha256)
    && value.secret.length >= 32
    && value.secret.length <= 256;
}

function emptyCredential(value: HmacCredential): boolean {
  return value.kid.length === 0
    && value.credentialIdSha256.length === 0
    && value.secret.length === 0;
}

function isConfiguredCredential(value: HmacCredential): boolean {
  return !emptyCredential(value);
}

function parseResponseObject(
  bytes: Uint8Array,
  role: "create" | "status",
): Record<string, unknown> {
  try {
    const value = JSON.parse(new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes));
    return requireResponseObject(value, role);
  } catch (error) {
    if (error instanceof ControllerDeploymentGatewayClientError) {
      throw error;
    }
    throw responseFailure(role, "invalid_response");
  }
}

function requireResponseObject(
  value: unknown,
  role: "create" | "status",
): Record<string, unknown> {
  if (!plainObject(value)) {
    throw responseFailure(role, "invalid_response");
  }
  return value;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertExactResponseKeys(
  object: Record<string, unknown>,
  expected: readonly string[],
  role: "create" | "status",
): void {
  const actual = Object.keys(object).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    throw responseFailure(role, "invalid_response");
  }
}

function requireResponseString(
  value: unknown,
  pattern: RegExp,
  role: "create" | "status",
): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw responseFailure(role, "invalid_response");
  }
  return value;
}

function requireResponseSha256(
  value: unknown,
  role: "create" | "status",
): string {
  return requireResponseString(value, SHA256, role);
}

function requireNullableResponseSha256(
  value: unknown,
  role: "create" | "status",
): string | null {
  return value === null ? null : requireResponseSha256(value, role);
}

function requireResponseInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  role: "create" | "status",
): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    throw responseFailure(role, "invalid_response");
  }
  return value;
}

function requireNullableResponseInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  role: "create" | "status",
): number | null {
  return value === null
    ? null
    : requireResponseInteger(value, minimum, maximum, role);
}

function requireResponseBoolean(
  value: unknown,
  role: "create" | "status",
): boolean {
  if (typeof value !== "boolean") {
    throw responseFailure(role, "invalid_response");
  }
  return value;
}

function requireResponseLiteral<T extends string | number | boolean>(
  value: unknown,
  expected: T,
  role: "create" | "status",
): T {
  if (value !== expected) {
    throw responseFailure(role, "invalid_response");
  }
  return expected;
}

function requireSha256Input(value: string, code: string): void {
  if (!SHA256.test(value)) {
    throw clientError(
      code,
      400,
      "request_invalid",
      "none",
    );
  }
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function requestInvalid(
  role: "create" | "status",
): ControllerDeploymentGatewayClientError {
  return clientError(
    `controller_deployment_gateway_${role}_command_invalid`,
    400,
    "request_invalid",
    "none",
  );
}

function responseValueFailure(
  role: "create" | "status",
): never {
  throw responseFailure(role, "invalid_response");
}

function responseFailure(
  role: "create" | "status",
  suffix: "invalid_response" | "response_too_large" | "response_mismatch",
): ControllerDeploymentGatewayClientError {
  return role === "create"
    ? clientError(
      `controller_deployment_gateway_create_${suffix}`,
      502,
      "create_outcome_unknown",
      "status_only",
    )
    : clientError(
      `controller_deployment_gateway_status_${suffix}`,
      502,
      "status_unavailable",
      "retry_status_only",
    );
}

function clientError(
  code: string,
  status: number,
  classification: ControllerDeploymentGatewayFailureClassification,
  recoveryAction: ControllerDeploymentGatewayRecoveryAction,
): ControllerDeploymentGatewayClientError {
  return new ControllerDeploymentGatewayClientError(
    code,
    status,
    classification,
    recoveryAction,
  );
}

function hasNoStore(value: string | null): boolean {
  return value !== null
    && value.split(",").some((directive) =>
      directive.trim().toLowerCase() === "no-store");
}

function validContentLength(value: string | null): boolean {
  if (value === null) return true;
  if (!/^(?:0|[1-9][0-9]{0,9})$/.test(value)) return false;
  const length = Number(value);
  return Number.isSafeInteger(length)
    && length > 0
    && length <= MAX_RESPONSE_BYTES;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
