import {
  ControllerDeploymentGatewayClientError,
  controllerDeploymentMutationRequestSha256,
  createControllerDeploymentOnceWithEvidence,
  readControllerDeploymentStatusWithEvidence,
  validateControllerDeploymentGatewayClientConfig,
  type ControllerDeploymentGatewayClientEnv,
  type ControllerDeploymentGatewayCreateResult,
  type ControllerDeploymentGatewayStatusResult,
} from "./controller_deployment_gateway_client";
import {
  appendOperationFiveGatewayEvent,
  createOperationFiveGatewayDispatchTriple,
  readExactOperationFiveDispatchConsumption,
  readExactOperationFiveDispatchConsumptionRecovery,
  readExactOperationFiveSendAttemptPair,
  readOperationFiveGatewayEventChain,
  type OperationFiveGatewayEvent,
  type OperationFiveGatewayEventKind,
  type OperationFiveGatewayEventRow,
  type OperationFiveSendAttempt,
  type OperationFiveSendAttemptPair,
  type OperationFiveSendAttemptRow,
  type OperationFiveSendStartedEvent,
} from "./execution_repository";
import { requestIdSha256 } from "./execution_protocol";
import {
  ProtocolError,
  canonicalJson,
  sha256Hex,
  type AuthenticatedRequest,
} from "./protocol";
import {
  CONTROLLER_ENABLE_COMMAND_CONTRACT,
  type FrozenControllerEnableCommand,
  type StartEnableDispatchSendCommand,
  type StartEnableDispatchSendEnv,
  type StartEnableDispatchSendResult,
  startControllerEnableDispatchSend,
} from "./start_enable_dispatch_send";

export const OPERATION_FIVE_GATEWAY_EVENT_CONTRACT =
  "cinatoken-shard-placement-authority-operation-five-gateway-event-v1";
export const READ_ENABLE_DISPATCH_STATUS_CONTRACT =
  "cinatoken-shard-placement-authority-read-enable-dispatch-status-v1";

const MAX_COMMAND_BYTES = 4 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const STATUS_COMMAND_FIELDS = [
  "schemaVersion",
  "contract",
  "authorizationIdSha256",
  "claimDigestSha256",
  "attemptDigestSha256",
  "controllerCommandDigestSha256",
  "gatewayIdempotencyKeySha256",
  "statusRequestIdSha256",
] as const;

export interface OperationFiveGatewayDispatchEnv
  extends
    StartEnableDispatchSendEnv,
    ControllerDeploymentGatewayClientEnv {
  SHARD_PLACEMENT_AUTHORITY_GATEWAY_EVENT_WRITE_ENABLED: string;
  SHARD_PLACEMENT_AUTHORITY_GATEWAY_CREATE_ENABLED: string;
  SHARD_PLACEMENT_AUTHORITY_GATEWAY_STATUS_READ_ENABLED: string;
}

export interface OperationFiveGatewayDispatchDependencies {
  startSend: typeof startControllerEnableDispatchSend;
  readReceipt: typeof readExactOperationFiveDispatchConsumption;
  readRecovery:
    typeof readExactOperationFiveDispatchConsumptionRecovery;
  createDispatchTriple:
    typeof createOperationFiveGatewayDispatchTriple;
  appendEvent: typeof appendOperationFiveGatewayEvent;
  readSendAttemptPair:
    typeof readExactOperationFiveSendAttemptPair;
  readEventChain: typeof readOperationFiveGatewayEventChain;
  createGateway:
    typeof createControllerDeploymentOnceWithEvidence;
  readGatewayStatus:
    typeof readControllerDeploymentStatusWithEvidence;
}

const DEFAULT_DEPENDENCIES: OperationFiveGatewayDispatchDependencies = {
  startSend: startControllerEnableDispatchSend,
  readReceipt: readExactOperationFiveDispatchConsumption,
  readRecovery:
    readExactOperationFiveDispatchConsumptionRecovery,
  createDispatchTriple:
    createOperationFiveGatewayDispatchTriple,
  appendEvent: appendOperationFiveGatewayEvent,
  readSendAttemptPair:
    readExactOperationFiveSendAttemptPair,
  readEventChain: readOperationFiveGatewayEventChain,
  createGateway: createControllerDeploymentOnceWithEvidence,
  readGatewayStatus:
    readControllerDeploymentStatusWithEvidence,
};

export interface StartEnableDispatchThroughGatewayResult
  extends Omit<StartEnableDispatchSendResult, "gatewayRequestSent"> {
  gatewayRequestSent: boolean;
  gatewayRemoteMutationSent: boolean | null;
  gatewayCreateClassification:
    | "accepted"
    | "rejected"
    | "ambiguous"
    | null;
  gatewayRecoveryAction: "status_readback" | "status_only";
  gatewayEventSequence: number;
  gatewayEventDigestSha256: string;
}

export interface ReadEnableDispatchStatusCommand {
  schemaVersion: 1;
  contract: typeof READ_ENABLE_DISPATCH_STATUS_CONTRACT;
  authorizationIdSha256: string;
  claimDigestSha256: string;
  attemptDigestSha256: string;
  controllerCommandDigestSha256: string;
  gatewayIdempotencyKeySha256: string;
  statusRequestIdSha256: string;
}

export interface ReadEnableDispatchStatusResult {
  result: "status_observation_recorded" | "exact_replay";
  authorizationIdSha256: string;
  claimDigestSha256: string;
  attemptDigestSha256: string;
  controllerCommandDigestSha256: string;
  gatewayIdempotencyKeySha256: string;
  gatewayRequestSent: boolean;
  remoteMutationSent: false;
  statusClassification:
    | "target_observed"
    | "baseline_observed"
    | "deployment_drift"
    | "ambiguous";
  targetStable: boolean;
  recoveryAction: "none" | "retry_status_only";
  gatewayEventSequence: number;
  gatewayEventDigestSha256: string;
}

export async function startControllerEnableDispatchThroughGateway(
  env: OperationFiveGatewayDispatchEnv,
  command: StartEnableDispatchSendCommand,
  authentication: AuthenticatedRequest,
  dependencies: OperationFiveGatewayDispatchDependencies =
    DEFAULT_DEPENDENCIES,
): Promise<StartEnableDispatchThroughGatewayResult> {
  requireCreateGates(env);
  validateControllerDeploymentGatewayClientConfig(env);

  let frozenCommand: FrozenControllerEnableCommand | null = null;
  let dispatchEvent: OperationFiveGatewayEvent | null = null;
  const base = await dependencies.startSend(
    env,
    command,
    authentication,
    {
      readReceipt: dependencies.readReceipt,
      readRecovery: dependencies.readRecovery,
      createPair: async (
        database,
        attempt,
        sendStartedEvent,
      ) => {
        frozenCommand = frozenCommandFromAttempt(attempt);
        const mutationRequestSha256 =
          await controllerDeploymentMutationRequestSha256(
            frozenCommand,
          );
        const gatewayRequestId = createGatewayRequestId(
          attempt.attemptDigestSha256,
        );
        dispatchEvent = await createDispatchEvent(
          env,
          attempt,
          sendStartedEvent,
          gatewayRequestId,
          mutationRequestSha256,
        );
        const persisted =
          await dependencies.createDispatchTriple(
            database,
            attempt,
            sendStartedEvent,
            dispatchEvent,
          );
        return {
          classification: persisted.classification,
          pair: persisted.triple.pair,
        };
      },
    },
  );
  if (frozenCommand === null || dispatchEvent === null) {
    throw new ProtocolError(
      "operation_five_gateway_dispatch_unavailable",
      503,
    );
  }
  const preparedCommand: FrozenControllerEnableCommand = frozenCommand;
  const preparedDispatch: OperationFiveGatewayEvent = dispatchEvent;
  if (!base.sendAttemptCreated) {
    const chain = await dependencies.readEventChain(
      env.DB,
      base.authorizationIdSha256,
      base.attemptDigestSha256,
    );
    const latest = chain.at(-1) ?? rowFromEvent(preparedDispatch);
    return {
      ...base,
      gatewayRequestSent: false,
      gatewayRemoteMutationSent: false,
      gatewayCreateClassification:
        latest.result_classification,
      gatewayRecoveryAction: "status_only",
      gatewayEventSequence: latest.event_sequence,
      gatewayEventDigestSha256: latest.event_digest_sha256,
    };
  }

  const gatewayRequestId = createGatewayRequestId(
    base.attemptDigestSha256,
  );
  let result: ControllerDeploymentGatewayCreateResult | null = null;
  let gatewayResponseSha256: string | null = null;
  let gatewayResponseBytes: number | null = null;
  let gatewayCredentialIdSha256 =
    env
      .CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_CURRENT_CREDENTIAL_ID_SHA256;
  let gatewayRequestIdSha256 =
    await requestIdSha256(gatewayRequestId);
  let failureClassification: "ambiguous" | null = null;
  try {
    const evidence =
      await dependencies.createGateway(
        env,
        {
          command: preparedCommand,
          controllerCommandDigestSha256:
            base.controllerCommandDigestSha256,
          gatewayIdempotencyKeySha256:
            base.gatewayIdempotencyKeySha256,
          authorityAttemptDigestSha256: base.attemptDigestSha256,
          sendStartedEventDigestSha256:
            base.sendStartedEventDigestSha256,
        },
        { requestId: gatewayRequestId },
      );
    result = evidence.value;
    gatewayResponseSha256 = evidence.gatewayResponseSha256;
    gatewayResponseBytes = evidence.gatewayResponseBytes;
    gatewayCredentialIdSha256 =
      evidence.gatewayCredentialIdSha256;
    gatewayRequestIdSha256 = evidence.gatewayRequestIdSha256;
  } catch (error) {
    if (
      error instanceof ControllerDeploymentGatewayClientError
      && error.classification === "request_invalid"
    ) {
      throw error;
    }
    failureClassification = "ambiguous";
  }

  const outcome = result?.outcome ?? null;
  const classification =
    outcome?.classification ?? failureClassification ?? "ambiguous";
  const resultEvent = await gatewayEventWithDigest({
    ...emptyGatewayEvent(base, preparedDispatch),
    eventSequence: 3,
    eventKind: createResultEventKind(classification),
    predecessorEventDigestSha256:
      preparedDispatch.eventDigestSha256,
    gatewayCredentialRole: "create",
    gatewayCredentialIdSha256,
    gatewayRequestIdSha256,
    gatewayResponseSha256,
    gatewayResponseBytes,
    gatewayVersionId: result?.gatewayVersionId ?? null,
    mutationRequestSha256:
      preparedDispatch.mutationRequestSha256,
    resultClassification: classification,
    resultHttpStatus: outcome?.httpStatus ?? null,
    resultResponseBodySha256:
      outcome?.responseBodySha256 ?? null,
    resultResponseRequestIdSha256:
      outcome?.responseRequestIdSha256 ?? null,
    resultResponseBytes: outcome?.responseBytes ?? null,
    gatewayRecordedAt: outcome?.recordedAt ?? null,
  });
  const persisted = await dependencies.appendEvent(
    env.DB,
    resultEvent,
  );
  return {
    ...base,
    gatewayRequestSent: true,
    gatewayRemoteMutationSent:
      result?.networkRequestSent ?? null,
    gatewayCreateClassification: classification,
    gatewayRecoveryAction:
      result?.recoveryAction ?? "status_only",
    gatewayEventSequence: persisted.event.event_sequence,
    gatewayEventDigestSha256:
      persisted.event.event_digest_sha256,
  };
}

export function parseReadEnableDispatchStatusCommand(
  body: Uint8Array,
): ReadEnableDispatchStatusCommand {
  if (body.byteLength > MAX_COMMAND_BYTES) {
    throw new ProtocolError(
      "operation_five_gateway_status_command_too_large",
      413,
    );
  }
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(body);
    value = JSON.parse(text);
    if (canonicalJson(value) !== text) {
      throw new ProtocolError("noncanonical_json", 400);
    }
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError("invalid_json", 400);
  }
  if (!plainObject(value)) {
    throw new ProtocolError("invalid_shape", 400);
  }
  const actual = Object.keys(value).sort();
  const expected = [...STATUS_COMMAND_FIELDS].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new ProtocolError("invalid_shape", 400);
  }
  return {
    schemaVersion: requireLiteral(value.schemaVersion, 1),
    contract: requireLiteral(
      value.contract,
      READ_ENABLE_DISPATCH_STATUS_CONTRACT,
    ),
    authorizationIdSha256:
      requireSha256(value.authorizationIdSha256),
    claimDigestSha256: requireSha256(value.claimDigestSha256),
    attemptDigestSha256:
      requireSha256(value.attemptDigestSha256),
    controllerCommandDigestSha256:
      requireSha256(value.controllerCommandDigestSha256),
    gatewayIdempotencyKeySha256:
      requireSha256(value.gatewayIdempotencyKeySha256),
    statusRequestIdSha256:
      requireSha256(value.statusRequestIdSha256),
  };
}

export async function readControllerEnableDispatchGatewayStatus(
  env: OperationFiveGatewayDispatchEnv,
  command: ReadEnableDispatchStatusCommand,
  authentication: AuthenticatedRequest,
  dependencies: OperationFiveGatewayDispatchDependencies =
    DEFAULT_DEPENDENCIES,
): Promise<ReadEnableDispatchStatusResult> {
  requireStatusGates(env);
  validateControllerDeploymentGatewayClientConfig(env);
  if (authentication.role !== "recovery") {
    throw new ProtocolError(
      "operation_five_gateway_status_role_mismatch",
      403,
    );
  }
  if (
    await requestIdSha256(authentication.requestId)
      !== command.statusRequestIdSha256
  ) {
    throw new ProtocolError(
      "operation_five_gateway_status_request_mismatch",
      409,
    );
  }
  const pair = await dependencies.readSendAttemptPair(
    env.DB,
    command.authorizationIdSha256,
    command.claimDigestSha256,
  );
  if (pair === null) {
    throw new ProtocolError(
      "operation_five_gateway_send_attempt_missing",
      409,
    );
  }
  requireStatusSource(command, pair);
  const reconstructedCommand = frozenCommandFromRow(pair.attempt);
  if (
    await sha256Hex(
      new TextEncoder().encode(canonicalJson(reconstructedCommand)),
    ) !== command.controllerCommandDigestSha256
  ) {
    throw new ProtocolError(
      "operation_five_gateway_status_command_digest_mismatch",
      409,
    );
  }
  const chain = await dependencies.readEventChain(
    env.DB,
    command.authorizationIdSha256,
    command.attemptDigestSha256,
  );
  let predecessor = requireGatewayChain(pair, chain);
  if (predecessor.event_sequence === 2) {
    predecessor = await persistUnknownCreateOutcome(
      env,
      pair,
      predecessor,
      dependencies,
    );
    chain.push(predecessor);
  }
  const gatewayRequestId = statusGatewayRequestId(
    command.statusRequestIdSha256,
  );
  const gatewayRequestIdDigest =
    await requestIdSha256(gatewayRequestId);
  const replay = chain.find(
    (event) =>
      event.gateway_credential_role === "status"
      && event.gateway_request_id_sha256
        === gatewayRequestIdDigest,
  );
  if (replay !== undefined) {
    return statusResultFromRow(
      command,
      replay,
      "exact_replay",
      false,
    );
  }

  let result: ControllerDeploymentGatewayStatusResult | null = null;
  let gatewayResponseSha256: string | null = null;
  let gatewayResponseBytes: number | null = null;
  let gatewayCredentialIdSha256 =
    env
      .CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_CURRENT_CREDENTIAL_ID_SHA256;
  let gatewayRequestIdSha256 = gatewayRequestIdDigest;
  let statusUnavailable = false;
  try {
    const evidence =
      await dependencies.readGatewayStatus(
        env,
        {
          gatewayIdempotencyKeySha256:
            command.gatewayIdempotencyKeySha256,
          controllerCommandDigestSha256:
            command.controllerCommandDigestSha256,
        },
        { requestId: gatewayRequestId },
      );
    result = evidence.value;
    gatewayResponseSha256 = evidence.gatewayResponseSha256;
    gatewayResponseBytes = evidence.gatewayResponseBytes;
    gatewayCredentialIdSha256 =
      evidence.gatewayCredentialIdSha256;
    gatewayRequestIdSha256 = evidence.gatewayRequestIdSha256;
  } catch (error) {
    if (
      error instanceof ControllerDeploymentGatewayClientError
      && error.classification === "request_invalid"
    ) {
      throw error;
    }
    statusUnavailable = true;
  }

  const observation = result?.observation ?? null;
  const stable = result !== null
    && result.targetStable
    && observation?.classification === "target_observed"
    && predecessor.status_classification === "target_observed"
    && predecessor.observation_digest_sha256
      === observation.observationDigestSha256
    && predecessor.gateway_recorded_at !== null
    && observation.recordedAt
      >= predecessor.gateway_recorded_at
        + result.stabilityMinimumSeconds;
  const eventKind = statusEventKind(
    observation?.classification ?? "ambiguous",
    stable,
  );
  const event = await gatewayEventWithDigest({
    ...emptyStatusEvent(command, pair, predecessor),
    eventSequence: predecessor.event_sequence + 1,
    eventKind,
    predecessorEventDigestSha256:
      predecessor.event_digest_sha256,
    gatewayCredentialRole: "status",
    gatewayCredentialIdSha256,
    gatewayRequestIdSha256,
    gatewayResponseSha256,
    gatewayResponseBytes,
    gatewayVersionId: result?.gatewayVersionId ?? null,
    statusClassification:
      observation?.classification ?? "ambiguous",
    deploymentsHttpStatus:
      observation?.deploymentsHttpStatus ?? null,
    versionHttpStatus: observation?.versionHttpStatus ?? null,
    deploymentSetSha256:
      observation?.deploymentSetSha256 ?? null,
    targetVersionSha256:
      observation?.targetVersionSha256 ?? null,
    statusResponseRequestIdSha256:
      observation?.responseRequestIdSha256 ?? null,
    observationDigestSha256:
      observation?.observationDigestSha256 ?? null,
    gatewayRecordedAt: observation?.recordedAt ?? null,
    targetStable: result === null ? null : stable ? 1 : 0,
    requiredMatchingObservations:
      result?.requiredMatchingObservations ?? null,
    stabilityMinimumSeconds:
      result?.stabilityMinimumSeconds ?? null,
    stabilityPredecessorObservationDigestSha256:
      stable ? predecessor.observation_digest_sha256 : null,
    stabilityPredecessorRecordedAt:
      stable ? predecessor.gateway_recorded_at : null,
  });
  const persisted = await dependencies.appendEvent(
    env.DB,
    event,
  );
  return {
    ...statusResultFromRow(
      command,
      persisted.event,
      "status_observation_recorded",
      true,
    ),
    recoveryAction: statusUnavailable
      ? "retry_status_only"
      : "none",
  };
}

export async function operationFiveGatewayEventDigest(
  event: Omit<OperationFiveGatewayEvent, "eventDigestSha256">,
): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalJson({
    schemaVersion: 1,
    ...event,
  })));
}

function requireCreateGates(
  env: OperationFiveGatewayDispatchEnv,
): void {
  if (
    env.SHARD_PLACEMENT_AUTHORITY_GATEWAY_EVENT_WRITE_ENABLED
      !== "true"
    || env.SHARD_PLACEMENT_AUTHORITY_GATEWAY_CREATE_ENABLED
      !== "true"
  ) {
    throw new ProtocolError(
      "authority_gateway_create_disabled",
      503,
    );
  }
}

function requireStatusGates(
  env: OperationFiveGatewayDispatchEnv,
): void {
  if (
    env.SHARD_PLACEMENT_AUTHORITY_GATEWAY_EVENT_WRITE_ENABLED
      !== "true"
    || env.SHARD_PLACEMENT_AUTHORITY_GATEWAY_STATUS_READ_ENABLED
      !== "true"
  ) {
    throw new ProtocolError(
      "authority_gateway_status_disabled",
      503,
    );
  }
}

async function createDispatchEvent(
  env: OperationFiveGatewayDispatchEnv,
  attempt: OperationFiveSendAttempt,
  sendStartedEvent: OperationFiveSendStartedEvent,
  gatewayRequestId: string,
  mutationRequestSha256: string,
): Promise<OperationFiveGatewayEvent> {
  return gatewayEventWithDigest({
    ...emptyGatewayEventFromAttempt(attempt, sendStartedEvent),
    eventSequence: 2,
    eventKind: "gateway_create_dispatched",
    predecessorEventDigestSha256:
      sendStartedEvent.eventDigestSha256,
    gatewayCredentialRole: "create",
    gatewayCredentialIdSha256:
      env
        .CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_CURRENT_CREDENTIAL_ID_SHA256,
    gatewayRequestIdSha256:
      await requestIdSha256(gatewayRequestId),
    mutationRequestSha256,
  });
}

async function gatewayEventWithDigest(
  event: Omit<OperationFiveGatewayEvent, "eventDigestSha256">,
): Promise<OperationFiveGatewayEvent> {
  return {
    ...event,
    eventDigestSha256:
      await operationFiveGatewayEventDigest(event),
  };
}

function emptyGatewayEvent(
  result: StartEnableDispatchSendResult,
  dispatch: OperationFiveGatewayEvent,
): Omit<
  OperationFiveGatewayEvent,
  "eventDigestSha256"
  | "eventSequence"
  | "eventKind"
  | "predecessorEventDigestSha256"
  | "gatewayCredentialRole"
  | "gatewayCredentialIdSha256"
  | "gatewayRequestIdSha256"
> {
  return {
    authorizationIdSha256: result.authorizationIdSha256,
    attemptDigestSha256: result.attemptDigestSha256,
    sendStartedEventDigestSha256:
      result.sendStartedEventDigestSha256,
    eventContract: OPERATION_FIVE_GATEWAY_EVENT_CONTRACT,
    gatewayIdempotencyKeySha256:
      result.gatewayIdempotencyKeySha256,
    controllerCommandDigestSha256:
      result.controllerCommandDigestSha256,
    gatewayResponseSha256: null,
    gatewayResponseBytes: null,
    gatewayVersionId: null,
    mutationRequestSha256: dispatch.mutationRequestSha256,
    resultClassification: null,
    resultHttpStatus: null,
    resultResponseBodySha256: null,
    resultResponseRequestIdSha256: null,
    resultResponseBytes: null,
    statusClassification: null,
    deploymentsHttpStatus: null,
    versionHttpStatus: null,
    deploymentSetSha256: null,
    targetVersionSha256: null,
    statusResponseRequestIdSha256: null,
    observationDigestSha256: null,
    gatewayRecordedAt: null,
    targetStable: null,
    requiredMatchingObservations: null,
    stabilityMinimumSeconds: null,
    stabilityPredecessorObservationDigestSha256: null,
    stabilityPredecessorRecordedAt: null,
  };
}

function emptyGatewayEventFromAttempt(
  attempt: OperationFiveSendAttempt,
  sendStartedEvent: OperationFiveSendStartedEvent,
): ReturnType<typeof emptyGatewayEvent> {
  return rowFromEventBase(attempt, sendStartedEvent);
}

function rowFromEventBase(
  attempt: OperationFiveSendAttempt,
  sendStartedEvent: OperationFiveSendStartedEvent,
): Omit<
  OperationFiveGatewayEvent,
  "eventDigestSha256"
  | "eventSequence"
  | "eventKind"
  | "predecessorEventDigestSha256"
  | "gatewayCredentialRole"
  | "gatewayCredentialIdSha256"
  | "gatewayRequestIdSha256"
> {
  return {
    authorizationIdSha256: attempt.authorizationIdSha256,
    attemptDigestSha256: attempt.attemptDigestSha256,
    sendStartedEventDigestSha256:
      sendStartedEvent.eventDigestSha256,
    eventContract: OPERATION_FIVE_GATEWAY_EVENT_CONTRACT,
    gatewayIdempotencyKeySha256:
      attempt.gatewayIdempotencyKeySha256,
    controllerCommandDigestSha256:
      attempt.controllerCommandDigestSha256,
    gatewayResponseSha256: null,
    gatewayResponseBytes: null,
    gatewayVersionId: null,
    mutationRequestSha256: null,
    resultClassification: null,
    resultHttpStatus: null,
    resultResponseBodySha256: null,
    resultResponseRequestIdSha256: null,
    resultResponseBytes: null,
    statusClassification: null,
    deploymentsHttpStatus: null,
    versionHttpStatus: null,
    deploymentSetSha256: null,
    targetVersionSha256: null,
    statusResponseRequestIdSha256: null,
    observationDigestSha256: null,
    gatewayRecordedAt: null,
    targetStable: null,
    requiredMatchingObservations: null,
    stabilityMinimumSeconds: null,
    stabilityPredecessorObservationDigestSha256: null,
    stabilityPredecessorRecordedAt: null,
  };
}

function emptyStatusEvent(
  command: ReadEnableDispatchStatusCommand,
  pair: OperationFiveSendAttemptPair,
  predecessor: OperationFiveGatewayEventRow,
): Omit<
  OperationFiveGatewayEvent,
  "eventDigestSha256"
  | "eventSequence"
  | "eventKind"
  | "predecessorEventDigestSha256"
  | "gatewayCredentialRole"
  | "gatewayCredentialIdSha256"
  | "gatewayRequestIdSha256"
> {
  return {
    authorizationIdSha256: command.authorizationIdSha256,
    attemptDigestSha256: command.attemptDigestSha256,
    sendStartedEventDigestSha256:
      pair.event.event_digest_sha256,
    eventContract: OPERATION_FIVE_GATEWAY_EVENT_CONTRACT,
    gatewayIdempotencyKeySha256:
      command.gatewayIdempotencyKeySha256,
    controllerCommandDigestSha256:
      command.controllerCommandDigestSha256,
    gatewayResponseSha256: null,
    gatewayResponseBytes: null,
    gatewayVersionId: null,
    mutationRequestSha256: null,
    resultClassification: null,
    resultHttpStatus: null,
    resultResponseBodySha256: null,
    resultResponseRequestIdSha256: null,
    resultResponseBytes: null,
    statusClassification: null,
    deploymentsHttpStatus: null,
    versionHttpStatus: null,
    deploymentSetSha256: null,
    targetVersionSha256: null,
    statusResponseRequestIdSha256: null,
    observationDigestSha256: null,
    gatewayRecordedAt: null,
    targetStable: null,
    requiredMatchingObservations: null,
    stabilityMinimumSeconds: null,
    stabilityPredecessorObservationDigestSha256: null,
    stabilityPredecessorRecordedAt: null,
  };
}

function frozenCommandFromAttempt(
  attempt: OperationFiveSendAttempt,
): FrozenControllerEnableCommand {
  return {
    schemaVersion: 1,
    contract: CONTROLLER_ENABLE_COMMAND_CONTRACT,
    authorizationIdSha256: attempt.authorizationIdSha256,
    claimDigestSha256: attempt.claimDigestSha256,
    dispatchClaimDigestSha256:
      attempt.authorityDispatchClaimDigestSha256,
    dispatchConsumptionReceiptDigestSha256:
      attempt.dispatchConsumptionReceiptDigestSha256,
    applicationDispatchConsumptionDigestSha256:
      attempt.applicationDispatchConsumptionDigestSha256,
    applicationTicketIdSha256: attempt.applicationTicketIdSha256,
    campaignId: attempt.campaignId,
    applicationDatabaseIdentitySha256:
      attempt.applicationDatabaseIdentitySha256,
    applicationVersionId: attempt.applicationVersionId,
    authorityDatabaseIdentitySha256:
      attempt.authorityDatabaseIdentitySha256,
    authorityLedgerIdentitySha256:
      attempt.authorityLedgerIdentitySha256,
    authorityLedgerHeadSha256: attempt.authorityLedgerHeadSha256,
    authorityVersionId: attempt.authorityVersionId,
    dispatchOwnerSha256: attempt.dispatchOwnerSha256,
    leaseTokenSha256: attempt.leaseTokenSha256,
    leaseGeneration: 1,
    controllerServiceName: attempt.controllerServiceName,
    controllerEnableOperationIdSha256:
      attempt.controllerEnableOperationIdSha256,
    controllerBaselineVersionId:
      attempt.controllerBaselineVersionId,
    controllerEnabledVersionId:
      attempt.controllerEnabledVersionId,
    sendAttemptLimit: 1,
    retryLimit: 0,
  };
}

function frozenCommandFromRow(
  attempt: OperationFiveSendAttemptRow,
): FrozenControllerEnableCommand {
  return {
    schemaVersion: 1,
    contract: CONTROLLER_ENABLE_COMMAND_CONTRACT,
    authorizationIdSha256: attempt.authorization_id_sha256,
    claimDigestSha256: attempt.claim_digest_sha256,
    dispatchClaimDigestSha256:
      attempt.authority_dispatch_claim_digest_sha256,
    dispatchConsumptionReceiptDigestSha256:
      attempt.dispatch_consumption_receipt_digest_sha256,
    applicationDispatchConsumptionDigestSha256:
      attempt.application_dispatch_consumption_digest_sha256,
    applicationTicketIdSha256: attempt.application_ticket_id_sha256,
    campaignId: attempt.campaign_id,
    applicationDatabaseIdentitySha256:
      attempt.application_database_identity_sha256,
    applicationVersionId: attempt.application_version_id,
    authorityDatabaseIdentitySha256:
      attempt.authority_database_identity_sha256,
    authorityLedgerIdentitySha256:
      attempt.authority_ledger_identity_sha256,
    authorityLedgerHeadSha256:
      attempt.authority_ledger_head_sha256,
    authorityVersionId: attempt.authority_version_id,
    dispatchOwnerSha256: attempt.dispatch_owner_sha256,
    leaseTokenSha256: attempt.lease_token_sha256,
    leaseGeneration: 1,
    controllerServiceName: attempt.controller_service_name,
    controllerEnableOperationIdSha256:
      attempt.controller_enable_operation_id_sha256,
    controllerBaselineVersionId:
      attempt.controller_baseline_version_id,
    controllerEnabledVersionId:
      attempt.controller_enabled_version_id,
    sendAttemptLimit: 1,
    retryLimit: 0,
  };
}

function requireStatusSource(
  command: ReadEnableDispatchStatusCommand,
  pair: OperationFiveSendAttemptPair,
): void {
  const attempt = pair.attempt;
  if (
    attempt.attempt_digest_sha256 !== command.attemptDigestSha256
    || attempt.controller_command_digest_sha256
      !== command.controllerCommandDigestSha256
    || attempt.gateway_idempotency_key_sha256
      !== command.gatewayIdempotencyKeySha256
    || attempt.controller_command_contract
      !== CONTROLLER_ENABLE_COMMAND_CONTRACT
  ) {
    throw new ProtocolError(
      "operation_five_gateway_status_source_mismatch",
      409,
    );
  }
}

function requireGatewayChain(
  pair: OperationFiveSendAttemptPair,
  chain: OperationFiveGatewayEventRow[],
): OperationFiveGatewayEventRow {
  if (
    chain.length === 0
    || chain[0]?.event_sequence !== 2
    || chain[0].event_kind !== "gateway_create_dispatched"
    || chain[0].predecessor_event_digest_sha256
      !== pair.event.event_digest_sha256
    || chain.some(
      (event, index) =>
        event.event_sequence !== index + 2
        || (
          index > 0
          && event.predecessor_event_digest_sha256
            !== chain[index - 1]?.event_digest_sha256
        ),
    )
  ) {
    throw new ProtocolError(
      "operation_five_gateway_event_chain_unavailable",
      503,
    );
  }
  return chain.at(-1)!;
}

async function persistUnknownCreateOutcome(
  env: OperationFiveGatewayDispatchEnv,
  pair: OperationFiveSendAttemptPair,
  dispatch: OperationFiveGatewayEventRow,
  dependencies: OperationFiveGatewayDispatchDependencies,
): Promise<OperationFiveGatewayEventRow> {
  const event = await gatewayEventWithDigest({
    authorizationIdSha256: dispatch.authorization_id_sha256,
    attemptDigestSha256: dispatch.attempt_digest_sha256,
    sendStartedEventDigestSha256:
      pair.event.event_digest_sha256,
    eventSequence: 3,
    eventContract: OPERATION_FIVE_GATEWAY_EVENT_CONTRACT,
    eventKind: "gateway_create_ambiguous",
    predecessorEventDigestSha256:
      dispatch.event_digest_sha256,
    gatewayIdempotencyKeySha256:
      dispatch.gateway_idempotency_key_sha256,
    controllerCommandDigestSha256:
      dispatch.controller_command_digest_sha256,
    gatewayCredentialRole: "create",
    gatewayCredentialIdSha256:
      dispatch.gateway_credential_id_sha256,
    gatewayRequestIdSha256: dispatch.gateway_request_id_sha256,
    gatewayResponseSha256: null,
    gatewayResponseBytes: null,
    gatewayVersionId: null,
    mutationRequestSha256: dispatch.mutation_request_sha256,
    resultClassification: "ambiguous",
    resultHttpStatus: null,
    resultResponseBodySha256: null,
    resultResponseRequestIdSha256: null,
    resultResponseBytes: null,
    statusClassification: null,
    deploymentsHttpStatus: null,
    versionHttpStatus: null,
    deploymentSetSha256: null,
    targetVersionSha256: null,
    statusResponseRequestIdSha256: null,
    observationDigestSha256: null,
    gatewayRecordedAt: null,
    targetStable: null,
    requiredMatchingObservations: null,
    stabilityMinimumSeconds: null,
    stabilityPredecessorObservationDigestSha256: null,
    stabilityPredecessorRecordedAt: null,
  });
  return (
    await dependencies.appendEvent(env.DB, event)
  ).event;
}

function createResultEventKind(
  classification: "accepted" | "rejected" | "ambiguous",
): OperationFiveGatewayEventKind {
  return `gateway_create_${classification}`;
}

function statusEventKind(
  classification:
    | "target_observed"
    | "baseline_observed"
    | "deployment_drift"
    | "ambiguous",
  stable: boolean,
): OperationFiveGatewayEventKind {
  if (stable) return "gateway_status_stable";
  if (classification === "target_observed") {
    return "gateway_status_target";
  }
  if (classification === "baseline_observed") {
    return "gateway_status_baseline";
  }
  if (classification === "deployment_drift") {
    return "gateway_status_drift";
  }
  return "gateway_status_ambiguous";
}

function createGatewayRequestId(attemptDigestSha256: string): string {
  return `authority-create:${attemptDigestSha256}`;
}

function statusGatewayRequestId(
  statusRequestIdSha256: string,
): string {
  return `authority-status:${statusRequestIdSha256}`;
}

function statusResultFromRow(
  command: ReadEnableDispatchStatusCommand,
  event: OperationFiveGatewayEventRow,
  result: ReadEnableDispatchStatusResult["result"],
  gatewayRequestSent: boolean,
): ReadEnableDispatchStatusResult {
  return {
    result,
    authorizationIdSha256: command.authorizationIdSha256,
    claimDigestSha256: command.claimDigestSha256,
    attemptDigestSha256: command.attemptDigestSha256,
    controllerCommandDigestSha256:
      command.controllerCommandDigestSha256,
    gatewayIdempotencyKeySha256:
      command.gatewayIdempotencyKeySha256,
    gatewayRequestSent,
    remoteMutationSent: false,
    statusClassification:
      event.status_classification ?? "ambiguous",
    targetStable: event.event_kind === "gateway_status_stable",
    recoveryAction:
      event.gateway_response_sha256 === null
        ? "retry_status_only"
        : "none",
    gatewayEventSequence: event.event_sequence,
    gatewayEventDigestSha256: event.event_digest_sha256,
  };
}

function rowFromEvent(
  event: OperationFiveGatewayEvent,
): OperationFiveGatewayEventRow {
  return {
    authorization_id_sha256: event.authorizationIdSha256,
    attempt_digest_sha256: event.attemptDigestSha256,
    send_started_event_digest_sha256:
      event.sendStartedEventDigestSha256,
    event_sequence: event.eventSequence,
    contract_version: 1,
    event_contract: event.eventContract,
    event_kind: event.eventKind,
    predecessor_event_digest_sha256:
      event.predecessorEventDigestSha256,
    gateway_idempotency_key_sha256:
      event.gatewayIdempotencyKeySha256,
    controller_command_digest_sha256:
      event.controllerCommandDigestSha256,
    gateway_credential_role: event.gatewayCredentialRole,
    gateway_credential_id_sha256:
      event.gatewayCredentialIdSha256,
    gateway_request_id_sha256: event.gatewayRequestIdSha256,
    gateway_response_sha256: event.gatewayResponseSha256,
    gateway_response_bytes: event.gatewayResponseBytes,
    gateway_version_id: event.gatewayVersionId,
    mutation_request_sha256: event.mutationRequestSha256,
    result_classification: event.resultClassification,
    result_http_status: event.resultHttpStatus,
    result_response_body_sha256:
      event.resultResponseBodySha256,
    result_response_request_id_sha256:
      event.resultResponseRequestIdSha256,
    result_response_bytes: event.resultResponseBytes,
    status_classification: event.statusClassification,
    deployments_http_status: event.deploymentsHttpStatus,
    version_http_status: event.versionHttpStatus,
    deployment_set_sha256: event.deploymentSetSha256,
    target_version_sha256: event.targetVersionSha256,
    status_response_request_id_sha256:
      event.statusResponseRequestIdSha256,
    observation_digest_sha256: event.observationDigestSha256,
    gateway_recorded_at: event.gatewayRecordedAt,
    target_stable: event.targetStable,
    required_matching_observations:
      event.requiredMatchingObservations,
    stability_minimum_seconds: event.stabilityMinimumSeconds,
    stability_predecessor_observation_digest_sha256:
      event.stabilityPredecessorObservationDigestSha256,
    stability_predecessor_recorded_at:
      event.stabilityPredecessorRecordedAt,
    event_digest_sha256: event.eventDigestSha256,
    recorded_at: Math.floor(Date.now() / 1_000),
  };
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function requireLiteral<T extends string | number>(
  value: unknown,
  expected: T,
): T {
  if (value !== expected) {
    throw new ProtocolError("invalid_shape", 400);
  }
  return expected;
}

function requireSha256(value: unknown): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new ProtocolError("invalid_shape", 400);
  }
  return value;
}
