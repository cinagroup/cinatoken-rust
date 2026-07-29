import { describe, expect, it, vi } from "vitest";

import {
  type ControllerDeploymentGatewayCallEvidence,
  type ControllerDeploymentGatewayCreateResult,
  type ControllerDeploymentGatewayStatusResult,
} from "../src/controller_deployment_gateway_client";
import {
  type OperationFiveGatewayEvent,
  type OperationFiveGatewayEventRow,
  type OperationFiveSendAttempt,
  type OperationFiveSendAttemptPair,
  type OperationFiveSendStartedEvent,
} from "../src/execution_repository";
import {
  READ_ENABLE_DISPATCH_STATUS_CONTRACT,
  readControllerEnableDispatchGatewayStatus,
  startControllerEnableDispatchThroughGateway,
  type OperationFiveGatewayDispatchDependencies,
  type OperationFiveGatewayDispatchEnv,
  type ReadEnableDispatchStatusCommand,
} from "../src/operation_five_gateway_dispatch";
import { requestIdSha256 } from "../src/execution_protocol";
import {
  canonicalJson,
  sha256Hex,
  type AuthenticatedRequest,
} from "../src/protocol";
import {
  CONTROLLER_ENABLE_COMMAND_CONTRACT,
  GATEWAY_IDEMPOTENCY_CONTRACT,
  OPERATION_FIVE_SEND_ATTEMPT_CONTRACT,
  OPERATION_FIVE_SEND_ATTEMPT_EVENT_CONTRACT,
  SEND_STARTED_EVENT_SEMANTICS,
  START_ENABLE_DISPATCH_SEND_CONTRACT,
  ZERO_EVENT_DIGEST_SHA256,
  type StartEnableDispatchSendCommand,
} from "../src/start_enable_dispatch_send";
import {
  authorityRoutingForTest,
  type AuthorityEnv,
} from "../src/index";

const NOW = 1_900_000_000;
const digest = (value: string): string => value.repeat(64);

function attempt(): OperationFiveSendAttempt {
  return {
    authorizationIdSha256: digest("1"),
    attemptContract: OPERATION_FIVE_SEND_ATTEMPT_CONTRACT,
    attemptGeneration: 1,
    retryCount: 0,
    retryLimit: 0,
    sendAttemptLimit: 1,
    sendAuthorityState: "granted",
    claimDigestSha256: digest("2"),
    authorityDispatchClaimDigestSha256: digest("3"),
    dispatchConsumptionReceiptDigestSha256: digest("4"),
    applicationDispatchConsumptionDigestSha256: digest("5"),
    applicationTicketIdSha256: digest("6"),
    campaignId: digest("7"),
    applicationDatabaseIdentitySha256: digest("8"),
    applicationVersionId: "application-version-1",
    authorityDatabaseIdentitySha256: digest("9"),
    authorityLedgerIdentitySha256: digest("a"),
    authorityLedgerHeadSha256: digest("b"),
    authorityVersionId: "authority-version-1",
    dispatchOwnerSha256: digest("c"),
    leaseTokenSha256: digest("d"),
    leaseGeneration: 1,
    controllerServiceName: "container-controller-staging",
    controllerEnableOperationIdSha256: digest("e"),
    controllerBaselineVersionId: "controller-baseline-v1",
    controllerEnabledVersionId: "controller-enabled-v1",
    controllerCommandContract: CONTROLLER_ENABLE_COMMAND_CONTRACT,
    controllerCommandDigestSha256: digest("f"),
    gatewayIdempotencyContract: GATEWAY_IDEMPOTENCY_CONTRACT,
    gatewayIdempotencyKeySha256: digest("0"),
    sendCredentialIdSha256: digest("1"),
    sendRequestIdSha256: digest("2"),
    commandSendAttemptRequestIdSha256: digest("3"),
    controllerRequestSent: 0,
    gatewayRequestSent: 0,
    attemptDigestSha256: digest("4"),
  };
}

function sendStartedEvent(
  value: OperationFiveSendAttempt,
): OperationFiveSendStartedEvent {
  return {
    authorizationIdSha256: value.authorizationIdSha256,
    attemptDigestSha256: value.attemptDigestSha256,
    eventSequence: 1,
    eventContract: OPERATION_FIVE_SEND_ATTEMPT_EVENT_CONTRACT,
    eventKind: "send_started",
    fromState: "consumption_receipted",
    toState: "send_started",
    eventSemantics: SEND_STARTED_EVENT_SEMANTICS,
    predecessorEventDigestSha256: ZERO_EVENT_DIGEST_SHA256,
    dispatchConsumptionReceiptDigestSha256:
      value.dispatchConsumptionReceiptDigestSha256,
    controllerCommandDigestSha256:
      value.controllerCommandDigestSha256,
    gatewayIdempotencyKeySha256:
      value.gatewayIdempotencyKeySha256,
    controllerRequestSent: 0,
    gatewayRequestSent: 0,
    eventDigestSha256: digest("5"),
  };
}

function pair(
  value: OperationFiveSendAttempt,
  event: OperationFiveSendStartedEvent,
): OperationFiveSendAttemptPair {
  return {
    attempt: {
      authorization_id_sha256: value.authorizationIdSha256,
      contract_version: 1,
      attempt_contract: value.attemptContract,
      attempt_generation: 1,
      retry_count: 0,
      retry_limit: 0,
      send_attempt_limit: 1,
      send_authority_state: "granted",
      claim_digest_sha256: value.claimDigestSha256,
      authority_dispatch_claim_digest_sha256:
        value.authorityDispatchClaimDigestSha256,
      dispatch_consumption_receipt_digest_sha256:
        value.dispatchConsumptionReceiptDigestSha256,
      application_dispatch_consumption_digest_sha256:
        value.applicationDispatchConsumptionDigestSha256,
      application_ticket_id_sha256: value.applicationTicketIdSha256,
      campaign_id: value.campaignId,
      application_database_identity_sha256:
        value.applicationDatabaseIdentitySha256,
      application_version_id: value.applicationVersionId,
      authority_database_identity_sha256:
        value.authorityDatabaseIdentitySha256,
      authority_ledger_identity_sha256:
        value.authorityLedgerIdentitySha256,
      authority_ledger_head_sha256:
        value.authorityLedgerHeadSha256,
      authority_version_id: value.authorityVersionId,
      dispatch_owner_sha256: value.dispatchOwnerSha256,
      lease_token_sha256: value.leaseTokenSha256,
      lease_generation: 1,
      controller_service_name: value.controllerServiceName,
      controller_enable_operation_id_sha256:
        value.controllerEnableOperationIdSha256,
      controller_baseline_version_id:
        value.controllerBaselineVersionId,
      controller_enabled_version_id:
        value.controllerEnabledVersionId,
      controller_command_contract:
        value.controllerCommandContract,
      controller_command_digest_sha256:
        value.controllerCommandDigestSha256,
      gateway_idempotency_contract:
        value.gatewayIdempotencyContract,
      gateway_idempotency_key_sha256:
        value.gatewayIdempotencyKeySha256,
      send_credential_id_sha256: value.sendCredentialIdSha256,
      send_request_id_sha256: value.sendRequestIdSha256,
      command_send_attempt_request_id_sha256:
        value.commandSendAttemptRequestIdSha256,
      controller_request_sent: 0,
      gateway_request_sent: 0,
      attempt_digest_sha256: value.attemptDigestSha256,
      created_at: NOW,
    },
    event: {
      authorization_id_sha256: event.authorizationIdSha256,
      attempt_digest_sha256: event.attemptDigestSha256,
      event_sequence: 1,
      contract_version: 1,
      event_contract: event.eventContract,
      event_kind: "send_started",
      from_state: "consumption_receipted",
      to_state: "send_started",
      event_semantics: SEND_STARTED_EVENT_SEMANTICS,
      predecessor_event_digest_sha256:
        event.predecessorEventDigestSha256,
      dispatch_consumption_receipt_digest_sha256:
        event.dispatchConsumptionReceiptDigestSha256,
      controller_command_digest_sha256:
        event.controllerCommandDigestSha256,
      gateway_idempotency_key_sha256:
        event.gatewayIdempotencyKeySha256,
      controller_request_sent: 0,
      gateway_request_sent: 0,
      event_digest_sha256: event.eventDigestSha256,
      recorded_at: NOW,
    },
  };
}

function gatewayRow(
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
    recorded_at: NOW,
  };
}

function env(): OperationFiveGatewayDispatchEnv {
  return {
    DB: {} as D1Database,
    SHARD_PLACEMENT_AUTHORITY_SEND_ATTEMPT_WRITE_ENABLED: "true",
    SHARD_PLACEMENT_AUTHORITY_GATEWAY_EVENT_WRITE_ENABLED: "true",
    SHARD_PLACEMENT_AUTHORITY_GATEWAY_CREATE_ENABLED: "true",
    SHARD_PLACEMENT_AUTHORITY_GATEWAY_STATUS_READ_ENABLED: "true",
    SHARD_PLACEMENT_APPLICATION_DATABASE_IDENTITY_SHA256: digest("8"),
    SHARD_PLACEMENT_AUTHORITY_DATABASE_IDENTITY_SHA256: digest("9"),
    SHARD_PLACEMENT_AUTHORITY_LEDGER_IDENTITY_SHA256: digest("a"),
    CONTROLLER_DEPLOYMENT_GATEWAY: { fetch: vi.fn() },
    CONTROLLER_DEPLOYMENT_GATEWAY_ISSUER: "authority-staging",
    CONTROLLER_DEPLOYMENT_GATEWAY_AUDIENCE: "gateway-staging",
    CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_CURRENT_KID:
      "create-current-v1",
    CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
      digest("6"),
    CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_CURRENT_SECRET:
      "create-current-secret-000000000000000000000000",
    CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_PREVIOUS_KID: "",
    CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256:
      "",
    CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_PREVIOUS_SECRET: "",
    CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_CURRENT_KID:
      "status-current-v1",
    CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
      digest("7"),
    CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_CURRENT_SECRET:
      "status-current-secret-000000000000000000000000",
    CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_PREVIOUS_KID: "",
    CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256:
      "",
    CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_PREVIOUS_SECRET: "",
  };
}

function authentication(
  role: "send" | "recovery" = "send",
  requestId = "authority-operation-five-request-1",
): AuthenticatedRequest {
  return {
    role,
    credentialIdSha256: digest("8"),
    keyId: `${role}-current-v1`,
    bodySha256: digest("9"),
    requestId,
  };
}

function command(
  value: OperationFiveSendAttempt,
): StartEnableDispatchSendCommand {
  return {
    schemaVersion: 1,
    contract: START_ENABLE_DISPATCH_SEND_CONTRACT,
    authorizationIdSha256: value.authorizationIdSha256,
    claimDigestSha256: value.claimDigestSha256,
    dispatchOwnerSha256: value.dispatchOwnerSha256,
    dispatchClaimDigestSha256:
      value.authorityDispatchClaimDigestSha256,
    dispatchConsumptionReceiptDigestSha256:
      value.dispatchConsumptionReceiptDigestSha256,
    controllerCommandDigestSha256:
      value.controllerCommandDigestSha256,
    gatewayIdempotencyKeySha256:
      value.gatewayIdempotencyKeySha256,
    sendAttemptRequestIdSha256: digest("a"),
  };
}

function createEvidence(
  value: OperationFiveSendAttempt,
): ControllerDeploymentGatewayCallEvidence<
  ControllerDeploymentGatewayCreateResult
> {
  return {
    value: {
      result: "mutation_attempt_recorded",
      requestId: "authority-create-request",
      gatewayIdempotencyKeySha256:
        value.gatewayIdempotencyKeySha256,
      controllerCommandDigestSha256:
        value.controllerCommandDigestSha256,
      mutationRequestSha256: digest("b"),
      networkRequestSent: true,
      recoveryAction: "status_readback",
      outcome: {
        classification: "accepted",
        httpStatus: 201,
        responseBodySha256: digest("c"),
        responseRequestIdSha256: digest("d"),
        responseBytes: 128,
        recordedAt: NOW,
      },
      gatewayVersionId: "gateway-version-1",
    },
    gatewayCredentialIdSha256: digest("6"),
    gatewayRequestIdSha256: digest("e"),
    gatewayResponseSha256: digest("f"),
    gatewayResponseBytes: 512,
  };
}

function dependencies(
  classification: "created" | "exact_replay" = "created",
): OperationFiveGatewayDispatchDependencies {
  const value = attempt();
  const event = sendStartedEvent(value);
  let dispatch: OperationFiveGatewayEventRow | null = null;
  const startSend: OperationFiveGatewayDispatchDependencies["startSend"] =
    vi.fn(async (_env, _command, _authentication, startDependencies) => {
      const persisted = await startDependencies.createPair(
        _env.DB,
        value,
        event,
      );
      return {
        result: persisted.classification === "created"
          ? "send_attempt_created"
          : "exact_replay",
        authorizationIdSha256: value.authorizationIdSha256,
        claimDigestSha256: value.claimDigestSha256,
        dispatchClaimDigestSha256:
          value.authorityDispatchClaimDigestSha256,
        dispatchConsumptionReceiptDigestSha256:
          value.dispatchConsumptionReceiptDigestSha256,
        attemptDigestSha256: value.attemptDigestSha256,
        sendStartedEventDigestSha256: event.eventDigestSha256,
        controllerCommandDigestSha256:
          value.controllerCommandDigestSha256,
        gatewayIdempotencyKeySha256:
          value.gatewayIdempotencyKeySha256,
        attemptGeneration: 1,
        retryLimit: 0,
        sendAttemptLimit: 1,
        sendAttemptCreated:
          persisted.classification === "created",
        controllerRequestSent: false,
        gatewayRequestSent: false,
      };
    });
  const createDispatchTriple = vi.fn(
    async (
      _database: D1Database,
      attempted: OperationFiveSendAttempt,
      started: OperationFiveSendStartedEvent,
      gatewayEvent: OperationFiveGatewayEvent,
    ) => {
      dispatch = gatewayRow(gatewayEvent);
      return {
        classification,
        triple: {
          pair: pair(attempted, started),
          dispatch,
        },
      };
    },
  );
  const appendEvent = vi.fn(
    async (_database: D1Database, gatewayEvent: OperationFiveGatewayEvent) => ({
      classification: "created" as const,
      event: gatewayRow(gatewayEvent),
    }),
  );
  return {
    startSend,
    readReceipt: vi.fn(),
    readRecovery: vi.fn(),
    createDispatchTriple,
    appendEvent,
    readSendAttemptPair: vi.fn().mockResolvedValue(pair(value, event)),
    readEventChain: vi.fn(async () => dispatch === null ? [] : [dispatch]),
    createGateway: vi.fn().mockResolvedValue(createEvidence(value)),
    readGatewayStatus: vi.fn(),
  };
}

describe("operation-five Authority to deployment gateway orchestration", () => {
  it("persists unique create authority atomically before one Gateway call", async () => {
    const value = attempt();
    const deps = dependencies();
    const result = await startControllerEnableDispatchThroughGateway(
      env(),
      command(value),
      authentication(),
      deps,
    );

    expect(deps.createDispatchTriple).toHaveBeenCalledOnce();
    expect(deps.createGateway).toHaveBeenCalledOnce();
    expect(deps.appendEvent).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      result: "send_attempt_created",
      sendAttemptCreated: true,
      gatewayRequestSent: true,
      gatewayRemoteMutationSent: true,
      gatewayCreateClassification: "accepted",
      gatewayRecoveryAction: "status_readback",
      gatewayEventSequence: 3,
    });
    const dispatch =
      vi.mocked(deps.createDispatchTriple).mock.calls[0]![3];
    expect(dispatch).toMatchObject({
      eventSequence: 2,
      eventKind: "gateway_create_dispatched",
      gatewayCredentialRole: "create",
      gatewayResponseSha256: null,
      resultClassification: null,
    });
    expect(dispatch.mutationRequestSha256).toMatch(/^[0-9a-f]{64}$/);
    const resultEvent =
      vi.mocked(deps.appendEvent).mock.calls[0]![1];
    expect(resultEvent).toMatchObject({
      eventSequence: 3,
      eventKind: "gateway_create_accepted",
      resultClassification: "accepted",
      resultHttpStatus: 201,
      gatewayResponseBytes: 512,
    });
  });

  it("does not call Gateway create on an exact Authority replay", async () => {
    const value = attempt();
    const deps = dependencies("exact_replay");
    const result = await startControllerEnableDispatchThroughGateway(
      env(),
      command(value),
      authentication(),
      deps,
    );

    expect(deps.createDispatchTriple).toHaveBeenCalledOnce();
    expect(deps.createGateway).not.toHaveBeenCalled();
    expect(deps.appendEvent).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      result: "exact_replay",
      sendAttemptCreated: false,
      gatewayRequestSent: false,
      gatewayRemoteMutationSent: false,
      gatewayRecoveryAction: "status_only",
      gatewayEventSequence: 2,
    });
  });

  it("records response loss as ambiguous and never retries create", async () => {
    const value = attempt();
    const deps = dependencies();
    vi.mocked(deps.createGateway).mockRejectedValue(
      new Error("response lost"),
    );
    const result = await startControllerEnableDispatchThroughGateway(
      env(),
      command(value),
      authentication(),
      deps,
    );

    expect(deps.createGateway).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      gatewayRequestSent: true,
      gatewayRemoteMutationSent: null,
      gatewayCreateClassification: "ambiguous",
      gatewayRecoveryAction: "status_only",
    });
    expect(
      vi.mocked(deps.appendEvent).mock.calls[0]![1],
    ).toMatchObject({
      eventKind: "gateway_create_ambiguous",
      gatewayResponseSha256: null,
      resultClassification: "ambiguous",
    });
  });

  it("keeps replay create-free after result-event persistence fails", async () => {
    const value = attempt();
    const first = dependencies();
    vi.mocked(first.appendEvent).mockRejectedValue(
      new Error("D1 result write failed"),
    );
    await expect(
      startControllerEnableDispatchThroughGateway(
        env(),
        command(value),
        authentication(),
        first,
      ),
    ).rejects.toThrow("D1 result write failed");
    expect(first.createGateway).toHaveBeenCalledOnce();

    const replay = dependencies("exact_replay");
    await startControllerEnableDispatchThroughGateway(
      env(),
      command(value),
      authentication(),
      replay,
    );
    expect(replay.createGateway).not.toHaveBeenCalled();
  });

  it("uses only status readback and records a stable second target observation", async () => {
    const value = attempt();
    const started = sendStartedEvent(value);
    const basePair = pair(value, started);
    const deps = dependencies();
    const dispatch = gatewayRow({
      ...emptyGatewayEvent(value, started),
      eventSequence: 2,
      eventKind: "gateway_create_dispatched",
      predecessorEventDigestSha256: started.eventDigestSha256,
      gatewayCredentialRole: "create",
      gatewayCredentialIdSha256: digest("6"),
      gatewayRequestIdSha256: digest("7"),
      mutationRequestSha256: digest("8"),
      eventDigestSha256: digest("9"),
    });
    const accepted = gatewayRow({
      ...emptyGatewayEvent(value, started),
      eventSequence: 3,
      eventKind: "gateway_create_accepted",
      predecessorEventDigestSha256: dispatch.event_digest_sha256,
      gatewayCredentialRole: "create",
      gatewayCredentialIdSha256: digest("6"),
      gatewayRequestIdSha256: digest("7"),
      gatewayResponseSha256: digest("a"),
      gatewayResponseBytes: 256,
      gatewayVersionId: "gateway-version-1",
      mutationRequestSha256: digest("8"),
      resultClassification: "accepted",
      resultHttpStatus: 201,
      resultResponseBodySha256: digest("b"),
      resultResponseRequestIdSha256: digest("c"),
      resultResponseBytes: 128,
      gatewayRecordedAt: NOW - 10,
      eventDigestSha256: digest("d"),
    });
    const target = gatewayRow({
      ...emptyGatewayEvent(value, started),
      eventSequence: 4,
      eventKind: "gateway_status_target",
      predecessorEventDigestSha256: accepted.event_digest_sha256,
      gatewayCredentialRole: "status",
      gatewayCredentialIdSha256: digest("7"),
      gatewayRequestIdSha256: digest("e"),
      gatewayResponseSha256: digest("f"),
      gatewayResponseBytes: 256,
      gatewayVersionId: "gateway-version-1",
      statusClassification: "target_observed",
      deploymentsHttpStatus: 200,
      versionHttpStatus: 200,
      deploymentSetSha256: digest("1"),
      targetVersionSha256: digest("2"),
      statusResponseRequestIdSha256: digest("3"),
      observationDigestSha256: digest("4"),
      gatewayRecordedAt: NOW - 5,
      targetStable: 0,
      requiredMatchingObservations: 2,
      stabilityMinimumSeconds: 5,
      eventDigestSha256: digest("5"),
    });
    vi.mocked(deps.readSendAttemptPair).mockResolvedValue(basePair);
    vi.mocked(deps.readEventChain).mockResolvedValue([
      dispatch,
      accepted,
      target,
    ]);
    const statusEvidence: ControllerDeploymentGatewayCallEvidence<
      ControllerDeploymentGatewayStatusResult
    > = {
      value: {
        result: "status_observation_recorded",
        requestId: "gateway-status-request",
        gatewayIdempotencyKeySha256:
          value.gatewayIdempotencyKeySha256,
        controllerCommandDigestSha256:
          value.controllerCommandDigestSha256,
        remoteMutationSent: false,
        statusRequestCount: 2,
        targetStable: true,
        requiredMatchingObservations: 2,
        stabilityMinimumSeconds: 5,
        observation: {
          classification: "target_observed",
          deploymentsHttpStatus: 200,
          versionHttpStatus: 200,
          deploymentSetSha256: digest("1"),
          targetVersionSha256: digest("2"),
          responseRequestIdSha256: digest("3"),
          observationDigestSha256: digest("4"),
          recordedAt: NOW,
        },
        gatewayVersionId: "gateway-version-1",
      },
      gatewayCredentialIdSha256: digest("7"),
      gatewayRequestIdSha256: digest("6"),
      gatewayResponseSha256: digest("8"),
      gatewayResponseBytes: 512,
    };
    vi.mocked(deps.readGatewayStatus).mockResolvedValue(statusEvidence);
    const requestId = "authority-status-request-2";
    const statusCommand: ReadEnableDispatchStatusCommand = {
      schemaVersion: 1,
      contract: READ_ENABLE_DISPATCH_STATUS_CONTRACT,
      authorizationIdSha256: value.authorizationIdSha256,
      claimDigestSha256: value.claimDigestSha256,
      attemptDigestSha256: value.attemptDigestSha256,
      controllerCommandDigestSha256:
        value.controllerCommandDigestSha256,
      gatewayIdempotencyKeySha256:
        value.gatewayIdempotencyKeySha256,
      statusRequestIdSha256: await requestIdSha256(requestId),
    };
    const expectedCommandDigest =
      await controllerCommandDigest(value);
    basePair.attempt.controller_command_digest_sha256 =
      expectedCommandDigest;
    statusCommand.controllerCommandDigestSha256 =
      expectedCommandDigest;
    statusEvidence.value.controllerCommandDigestSha256 =
      expectedCommandDigest;

    const result = await readControllerEnableDispatchGatewayStatus(
      env(),
      statusCommand,
      authentication("recovery", requestId),
      deps,
    );

    expect(deps.createGateway).not.toHaveBeenCalled();
    expect(deps.readGatewayStatus).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      result: "status_observation_recorded",
      gatewayRequestSent: true,
      remoteMutationSent: false,
      statusClassification: "target_observed",
      targetStable: true,
      recoveryAction: "none",
      gatewayEventSequence: 5,
    });
    expect(
      vi.mocked(deps.appendEvent).mock.calls[0]![1],
    ).toMatchObject({
      eventKind: "gateway_status_stable",
      observationDigestSha256: digest("4"),
      stabilityPredecessorObservationDigestSha256: digest("4"),
      stabilityPredecessorRecordedAt: NOW - 5,
    });
  });

  it("normalizes a dispatch-only crash before status-only recovery", async () => {
    const value = attempt();
    const started = sendStartedEvent(value);
    const basePair = pair(value, started);
    const expectedCommandDigest =
      await controllerCommandDigest(value);
    basePair.attempt.controller_command_digest_sha256 =
      expectedCommandDigest;
    const dispatch = gatewayRow({
      ...emptyGatewayEvent(value, started),
      controllerCommandDigestSha256: expectedCommandDigest,
      eventSequence: 2,
      eventKind: "gateway_create_dispatched",
      predecessorEventDigestSha256: started.eventDigestSha256,
      gatewayCredentialRole: "create",
      gatewayCredentialIdSha256: digest("6"),
      gatewayRequestIdSha256: digest("7"),
      mutationRequestSha256: digest("8"),
      eventDigestSha256: digest("9"),
    });
    const deps = dependencies();
    vi.mocked(deps.readSendAttemptPair).mockResolvedValue(basePair);
    vi.mocked(deps.readEventChain).mockResolvedValue([dispatch]);
    const requestId = "authority-status-after-dispatch-crash";
    const statusCommand: ReadEnableDispatchStatusCommand = {
      schemaVersion: 1,
      contract: READ_ENABLE_DISPATCH_STATUS_CONTRACT,
      authorizationIdSha256: value.authorizationIdSha256,
      claimDigestSha256: value.claimDigestSha256,
      attemptDigestSha256: value.attemptDigestSha256,
      controllerCommandDigestSha256: expectedCommandDigest,
      gatewayIdempotencyKeySha256:
        value.gatewayIdempotencyKeySha256,
      statusRequestIdSha256: await requestIdSha256(requestId),
    };
    vi.mocked(deps.readGatewayStatus).mockResolvedValue({
      value: {
        result: "status_observation_recorded",
        requestId: "gateway-status-after-crash",
        gatewayIdempotencyKeySha256:
          value.gatewayIdempotencyKeySha256,
        controllerCommandDigestSha256: expectedCommandDigest,
        remoteMutationSent: false,
        statusRequestCount: 2,
        targetStable: false,
        requiredMatchingObservations: 2,
        stabilityMinimumSeconds: 5,
        observation: {
          classification: "target_observed",
          deploymentsHttpStatus: 200,
          versionHttpStatus: 200,
          deploymentSetSha256: digest("a"),
          targetVersionSha256: digest("b"),
          responseRequestIdSha256: digest("c"),
          observationDigestSha256: digest("d"),
          recordedAt: NOW,
        },
        gatewayVersionId: "gateway-version-1",
      },
      gatewayCredentialIdSha256: digest("7"),
      gatewayRequestIdSha256: digest("e"),
      gatewayResponseSha256: digest("f"),
      gatewayResponseBytes: 512,
    });

    const result = await readControllerEnableDispatchGatewayStatus(
      env(),
      statusCommand,
      authentication("recovery", requestId),
      deps,
    );

    expect(deps.createGateway).not.toHaveBeenCalled();
    expect(deps.readGatewayStatus).toHaveBeenCalledOnce();
    expect(deps.appendEvent).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(deps.appendEvent).mock.calls[0]![1],
    ).toMatchObject({
      eventSequence: 3,
      eventKind: "gateway_create_ambiguous",
      resultClassification: "ambiguous",
    });
    expect(
      vi.mocked(deps.appendEvent).mock.calls[1]![1],
    ).toMatchObject({
      eventSequence: 4,
      eventKind: "gateway_status_target",
      statusClassification: "target_observed",
    });
    expect(result).toMatchObject({
      gatewayRequestSent: true,
      remoteMutationSent: false,
      statusClassification: "target_observed",
      targetStable: false,
      gatewayEventSequence: 4,
    });
  });

  it("keeps status recovery on a distinct recovery-HMAC route and gates", () => {
    const request = new Request(
      `https://authority.test/internal/v1/shard-placement/execution-claims/${digest("1")}/read-enable-dispatch-status`,
      { method: "POST" },
    );
    expect(authorityRoutingForTest.match(request)).toEqual({
      kind: "execution_read_enable_dispatch_status",
      role: "recovery",
    });
    expect(() =>
      authorityRoutingForTest.requireGate(
        "execution_read_enable_dispatch_status",
        {
          SHARD_PLACEMENT_AUTHORITY_GATEWAY_EVENT_WRITE_ENABLED:
            "true",
          SHARD_PLACEMENT_AUTHORITY_GATEWAY_STATUS_READ_ENABLED:
            "false",
        } as AuthorityEnv,
      )
    ).toThrowError("authority_gateway_status_disabled");
  });
});

function emptyGatewayEvent(
  value: OperationFiveSendAttempt,
  event: OperationFiveSendStartedEvent,
): OperationFiveGatewayEvent {
  return {
    authorizationIdSha256: value.authorizationIdSha256,
    attemptDigestSha256: value.attemptDigestSha256,
    sendStartedEventDigestSha256: event.eventDigestSha256,
    eventSequence: 2,
    eventContract:
      "cinatoken-shard-placement-authority-operation-five-gateway-event-v1",
    eventKind: "gateway_create_dispatched",
    predecessorEventDigestSha256: event.eventDigestSha256,
    gatewayIdempotencyKeySha256:
      value.gatewayIdempotencyKeySha256,
    controllerCommandDigestSha256:
      value.controllerCommandDigestSha256,
    gatewayCredentialRole: "create",
    gatewayCredentialIdSha256: digest("6"),
    gatewayRequestIdSha256: digest("7"),
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
    eventDigestSha256: digest("8"),
  };
}

async function controllerCommandDigest(
  value: OperationFiveSendAttempt,
): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalJson({
    schemaVersion: 1,
    contract: CONTROLLER_ENABLE_COMMAND_CONTRACT,
    authorizationIdSha256: value.authorizationIdSha256,
    claimDigestSha256: value.claimDigestSha256,
    dispatchClaimDigestSha256:
      value.authorityDispatchClaimDigestSha256,
    dispatchConsumptionReceiptDigestSha256:
      value.dispatchConsumptionReceiptDigestSha256,
    applicationDispatchConsumptionDigestSha256:
      value.applicationDispatchConsumptionDigestSha256,
    applicationTicketIdSha256: value.applicationTicketIdSha256,
    campaignId: value.campaignId,
    applicationDatabaseIdentitySha256:
      value.applicationDatabaseIdentitySha256,
    applicationVersionId: value.applicationVersionId,
    authorityDatabaseIdentitySha256:
      value.authorityDatabaseIdentitySha256,
    authorityLedgerIdentitySha256:
      value.authorityLedgerIdentitySha256,
    authorityLedgerHeadSha256: value.authorityLedgerHeadSha256,
    authorityVersionId: value.authorityVersionId,
    dispatchOwnerSha256: value.dispatchOwnerSha256,
    leaseTokenSha256: value.leaseTokenSha256,
    leaseGeneration: 1,
    controllerServiceName: value.controllerServiceName,
    controllerEnableOperationIdSha256:
      value.controllerEnableOperationIdSha256,
    controllerBaselineVersionId:
      value.controllerBaselineVersionId,
    controllerEnabledVersionId:
      value.controllerEnabledVersionId,
    sendAttemptLimit: 1,
    retryLimit: 0,
  })));
}
