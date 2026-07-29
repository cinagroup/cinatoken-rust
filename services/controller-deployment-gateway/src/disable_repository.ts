import {
  DISABLE_DISPATCH_SEMANTICS,
  type DisableDeploymentMutation,
  type DisableMutationOutcome,
  type DisableStatusObservation,
} from "./disable_cloudflare_client";
import type { DisableCreateRequest } from "./disable_protocol";
import { canonicalJson } from "./protocol";

const OPERATION_COLUMNS = `
  gateway_disable_idempotency_key_sha256, command_digest_sha256, command_json,
  authorization_id_sha256, claim_digest_sha256, operation14_id_sha256,
  authority_database_identity_sha256, authority_ledger_identity_sha256,
  authority_ledger_head_sha256, authority_version_id, lease_owner_sha256,
  lease_token_sha256, lease_generation, controller_service_name,
  enabled_source_version_id, baseline_target_version_id,
  authority_attempt_digest_sha256, send_started_event_digest_sha256,
  account_id_sha256, gateway_profile_version,
  disable_create_credential_id_sha256, disable_create_request_id_sha256,
  created_at
`;

const DISPATCH_COLUMNS = `
  gateway_disable_idempotency_key_sha256, mutation_request_sha256,
  mutation_body, mutation_annotation, intent_digest_sha256, endpoint_path,
  dispatch_semantics, authorized_at
`;

const OUTCOME_COLUMNS = `
  gateway_disable_idempotency_key_sha256, classification, http_status,
  response_body_sha256, response_request_id_sha256, response_bytes, recorded_at
`;

const OBSERVATION_COLUMNS = `
  observation_id, gateway_disable_idempotency_key_sha256,
  disable_status_credential_id_sha256, disable_status_request_id_sha256,
  classification, deployments_http_status, baseline_version_http_status,
  deployment_set_sha256, baseline_version_sha256,
  response_request_id_sha256, remote_observation_digest_sha256,
  state_digest_sha256, observation_digest_sha256, recorded_at
`;

export interface DisableOperationRow {
  gateway_disable_idempotency_key_sha256: string;
  command_digest_sha256: string;
  command_json: string;
  authorization_id_sha256: string;
  claim_digest_sha256: string;
  operation14_id_sha256: string;
  authority_database_identity_sha256: string;
  authority_ledger_identity_sha256: string;
  authority_ledger_head_sha256: string;
  authority_version_id: string;
  lease_owner_sha256: string;
  lease_token_sha256: string;
  lease_generation: number;
  controller_service_name: string;
  enabled_source_version_id: string;
  baseline_target_version_id: string;
  authority_attempt_digest_sha256: string;
  send_started_event_digest_sha256: string;
  account_id_sha256: string;
  gateway_profile_version: number;
  disable_create_credential_id_sha256: string;
  disable_create_request_id_sha256: string;
  created_at: number;
}

export interface DisableDispatchRow {
  gateway_disable_idempotency_key_sha256: string;
  mutation_request_sha256: string;
  mutation_body: string;
  mutation_annotation: string;
  intent_digest_sha256: string;
  endpoint_path: string;
  dispatch_semantics: string;
  authorized_at: number;
}

export interface DisableOutcomeRow {
  gateway_disable_idempotency_key_sha256: string;
  classification: string;
  http_status: number | null;
  response_body_sha256: string | null;
  response_request_id_sha256: string | null;
  response_bytes: number | null;
  recorded_at: number;
}

export interface DisableObservationRow {
  observation_id: number;
  gateway_disable_idempotency_key_sha256: string;
  disable_status_credential_id_sha256: string;
  disable_status_request_id_sha256: string;
  classification: string;
  deployments_http_status: number | null;
  baseline_version_http_status: number | null;
  deployment_set_sha256: string | null;
  baseline_version_sha256: string | null;
  response_request_id_sha256: string | null;
  remote_observation_digest_sha256: string;
  state_digest_sha256: string;
  observation_digest_sha256: string;
  recorded_at: number;
}

export interface DisableOperationSnapshot {
  operation: DisableOperationRow;
  dispatch: DisableDispatchRow;
  outcome: DisableOutcomeRow | null;
  observations: DisableObservationRow[];
}

export interface DisableOperationReservation {
  request: DisableCreateRequest;
  mutation: DisableDeploymentMutation;
  accountIdSha256: string;
  gatewayProfileVersion: 1;
  disableCreateCredentialIdSha256: string;
  disableCreateRequestIdSha256: string;
}

export interface DisableObservationEvidence extends DisableStatusObservation {
  remoteObservationDigestSha256: string;
  stateDigestSha256: string;
  observationDigestSha256: string;
}

export class DisableRepositoryConflictError extends Error {
  constructor(readonly code = "disable_operation_conflict") {
    super(code);
    this.name = "DisableRepositoryConflictError";
  }
}

export class DisableRepositoryNotFoundError extends Error {
  constructor() {
    super("disable_operation_not_found");
    this.name = "DisableRepositoryNotFoundError";
  }
}

export class DisableRepositoryUnavailableError extends Error {
  constructor(readonly outcomeUnknown: boolean) {
    super("disable_repository_unavailable");
    this.name = "DisableRepositoryUnavailableError";
  }
}

export async function reserveDisableOperationAndDispatch(
  database: D1Database,
  reservation: DisableOperationReservation,
): Promise<{
  classification: "created" | "exact_replay";
  snapshot: DisableOperationSnapshot;
}> {
  const { request, mutation } = reservation;
  const session = database.withSession("first-primary");
  let definitelyFresh = false;
  try {
    const results = await session.batch([
      session.prepare(
        `INSERT INTO controller_deployment_gateway_disable_operations (
          gateway_disable_idempotency_key_sha256, command_digest_sha256,
          command_json, authorization_id_sha256, claim_digest_sha256,
          operation14_id_sha256, authority_database_identity_sha256,
          authority_ledger_identity_sha256, authority_ledger_head_sha256,
          authority_version_id, lease_owner_sha256, lease_token_sha256,
          lease_generation, controller_service_name, enabled_source_version_id,
          baseline_target_version_id, authority_attempt_digest_sha256,
          send_started_event_digest_sha256, account_id_sha256,
          gateway_profile_version, disable_create_credential_id_sha256,
          disable_create_request_id_sha256, created_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
          ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, unixepoch()
        )`,
      ).bind(
        request.gatewayDisableIdempotencyKeySha256,
        request.controllerDisableCommandDigestSha256,
        canonicalJson(request.command),
        request.command.authorizationIdSha256,
        request.command.claimDigestSha256,
        request.command.operation14IdSha256,
        request.command.authorityDatabaseIdentitySha256,
        request.command.authorityLedgerIdentitySha256,
        request.command.authorityLedgerHeadSha256,
        request.command.authorityVersionId,
        request.command.leaseOwnerSha256,
        request.command.leaseTokenSha256,
        request.command.leaseGeneration,
        request.command.controllerServiceName,
        request.command.controllerEnabledSourceVersionId,
        request.command.controllerBaselineTargetVersionId,
        request.authorityAttemptDigestSha256,
        request.sendStartedEventDigestSha256,
        reservation.accountIdSha256,
        reservation.gatewayProfileVersion,
        reservation.disableCreateCredentialIdSha256,
        reservation.disableCreateRequestIdSha256,
      ),
      session.prepare(
        `INSERT INTO controller_deployment_gateway_disable_dispatches (
          gateway_disable_idempotency_key_sha256, mutation_request_sha256,
          mutation_body, mutation_annotation, intent_digest_sha256,
          endpoint_path, dispatch_semantics, authorized_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, unixepoch())`,
      ).bind(
        request.gatewayDisableIdempotencyKeySha256,
        mutation.mutationRequestSha256,
        mutation.body,
        mutation.mutationAnnotation,
        mutation.intentDigestSha256,
        mutation.endpointPath,
        DISABLE_DISPATCH_SEMANTICS,
      ),
    ]);
    definitelyFresh = results.length === 2 && results.every(
      (result) => result.success === true && result.meta.changes === 1,
    );
  } catch {
    definitelyFresh = false;
  }
  const snapshot = await readDisableOperationSnapshot(
    session,
    request.gatewayDisableIdempotencyKeySha256,
  );
  if (!matchesReservation(snapshot, reservation)) {
    throw new DisableRepositoryConflictError();
  }
  return {
    classification: definitelyFresh ? "created" : "exact_replay",
    snapshot,
  };
}

export async function readExactDisableOperation(
  database: D1Database,
  gatewayDisableIdempotencyKeySha256: string,
  commandDigestSha256: string,
  accountIdSha256: string,
): Promise<DisableOperationSnapshot> {
  const snapshot = await readDisableOperationSnapshot(
    database.withSession("first-primary"),
    gatewayDisableIdempotencyKeySha256,
  );
  if (
    snapshot.operation.command_digest_sha256 !== commandDigestSha256
    || snapshot.operation.account_id_sha256 !== accountIdSha256
  ) {
    throw new DisableRepositoryConflictError();
  }
  return snapshot;
}

export async function readDisableObservationReplay(
  database: D1Database,
  gatewayDisableIdempotencyKeySha256: string,
  commandDigestSha256: string,
  accountIdSha256: string,
  credentialIdSha256: string,
  requestIdSha256: string,
): Promise<{
  snapshot: DisableOperationSnapshot;
  observation: DisableObservationRow | null;
  previousObservation: DisableObservationRow | null;
}> {
  const session = database.withSession("first-primary");
  const snapshot = await readDisableOperationSnapshot(
    session,
    gatewayDisableIdempotencyKeySha256,
  );
  if (
    snapshot.operation.command_digest_sha256 !== commandDigestSha256
    || snapshot.operation.account_id_sha256 !== accountIdSha256
  ) {
    throw new DisableRepositoryConflictError();
  }
  let observation: DisableObservationRow | null;
  try {
    observation = await session.prepare(
      `SELECT ${OBSERVATION_COLUMNS}
       FROM controller_deployment_gateway_disable_observations
       WHERE gateway_disable_idempotency_key_sha256 = ?1
         AND disable_status_request_id_sha256 = ?2
       LIMIT 1`,
    ).bind(
      gatewayDisableIdempotencyKeySha256,
      requestIdSha256,
    ).first<DisableObservationRow>();
  } catch {
    throw new DisableRepositoryUnavailableError(false);
  }
  if (
    observation !== null
    && observation.disable_status_credential_id_sha256 !== credentialIdSha256
  ) {
    throw new DisableRepositoryConflictError(
      "disable_status_request_conflict",
    );
  }
  const previousObservation = observation === null
    ? null
    : await readPreviousObservation(session, observation);
  return { snapshot, observation, previousObservation };
}

export async function appendDisableOutcome(
  database: D1Database,
  gatewayDisableIdempotencyKeySha256: string,
  outcome: DisableMutationOutcome,
): Promise<{
  classification: "recorded" | "exact_replay";
  outcome: DisableOutcomeRow;
}> {
  const session = database.withSession("first-primary");
  let writeSucceeded = false;
  try {
    const result = await session.prepare(
      `INSERT INTO controller_deployment_gateway_disable_outcomes (
        gateway_disable_idempotency_key_sha256, classification, http_status,
        response_body_sha256, response_request_id_sha256, response_bytes,
        recorded_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, unixepoch())`,
    ).bind(
      gatewayDisableIdempotencyKeySha256,
      outcome.classification,
      outcome.httpStatus,
      outcome.responseBodySha256,
      outcome.responseRequestIdSha256,
      outcome.responseBytes,
    ).run();
    writeSucceeded = result.success && result.meta.changes === 1;
  } catch {
    writeSucceeded = false;
  }
  let persisted: DisableOutcomeRow | null;
  try {
    persisted = await session.prepare(
      `SELECT ${OUTCOME_COLUMNS}
       FROM controller_deployment_gateway_disable_outcomes
       WHERE gateway_disable_idempotency_key_sha256 = ?1
       LIMIT 1`,
    ).bind(gatewayDisableIdempotencyKeySha256).first<DisableOutcomeRow>();
  } catch {
    throw new DisableRepositoryUnavailableError(true);
  }
  if (persisted === null || !matchesOutcome(persisted, outcome)) {
    if (persisted !== null) {
      throw new DisableRepositoryConflictError("disable_outcome_conflict");
    }
    throw new DisableRepositoryUnavailableError(true);
  }
  return {
    classification: writeSucceeded ? "recorded" : "exact_replay",
    outcome: persisted,
  };
}

export async function appendDisableObservation(
  database: D1Database,
  gatewayDisableIdempotencyKeySha256: string,
  observation: DisableObservationEvidence,
  credentialIdSha256: string,
  requestIdSha256: string,
): Promise<{
  classification: "recorded" | "exact_replay";
  observation: DisableObservationRow;
  previousObservation: DisableObservationRow | null;
}> {
  const session = database.withSession("first-primary");
  let writeSucceeded = false;
  try {
    const result = await session.prepare(
      `INSERT INTO controller_deployment_gateway_disable_observations (
        gateway_disable_idempotency_key_sha256,
        disable_status_credential_id_sha256,
        disable_status_request_id_sha256, classification,
        deployments_http_status, baseline_version_http_status,
        deployment_set_sha256, baseline_version_sha256,
        response_request_id_sha256, remote_observation_digest_sha256,
        state_digest_sha256, observation_digest_sha256, recorded_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, unixepoch()
      )`,
    ).bind(
      gatewayDisableIdempotencyKeySha256,
      credentialIdSha256,
      requestIdSha256,
      observation.classification,
      observation.deploymentsHttpStatus,
      observation.baselineVersionHttpStatus,
      observation.deploymentSetSha256,
      observation.baselineVersionSha256,
      observation.responseRequestIdSha256,
      observation.remoteObservationDigestSha256,
      observation.stateDigestSha256,
      observation.observationDigestSha256,
    ).run();
    writeSucceeded = result.success && result.meta.changes === 1;
  } catch {
    writeSucceeded = false;
  }
  let persisted: DisableObservationRow | null;
  try {
    persisted = await session.prepare(
      `SELECT ${OBSERVATION_COLUMNS}
       FROM controller_deployment_gateway_disable_observations
       WHERE gateway_disable_idempotency_key_sha256 = ?1
         AND disable_status_request_id_sha256 = ?2
       LIMIT 1`,
    ).bind(
      gatewayDisableIdempotencyKeySha256,
      requestIdSha256,
    ).first<DisableObservationRow>();
  } catch {
    throw new DisableRepositoryUnavailableError(false);
  }
  if (
    persisted === null
    || !matchesObservation(
      persisted,
      observation,
      credentialIdSha256,
      requestIdSha256,
    )
  ) {
    if (persisted !== null) {
      throw new DisableRepositoryConflictError(
        "disable_observation_conflict",
      );
    }
    throw new DisableRepositoryUnavailableError(false);
  }
  return {
    classification: writeSucceeded ? "recorded" : "exact_replay",
    observation: persisted,
    previousObservation: await readPreviousObservation(session, persisted),
  };
}

async function readDisableOperationSnapshot(
  session: D1DatabaseSession,
  gatewayDisableIdempotencyKeySha256: string,
): Promise<DisableOperationSnapshot> {
  try {
    const operation = await session.prepare(
      `SELECT ${OPERATION_COLUMNS}
       FROM controller_deployment_gateway_disable_operations
       WHERE gateway_disable_idempotency_key_sha256 = ?1
       LIMIT 1`,
    ).bind(
      gatewayDisableIdempotencyKeySha256,
    ).first<DisableOperationRow>();
    if (operation === null) throw new DisableRepositoryNotFoundError();
    const dispatch = await session.prepare(
      `SELECT ${DISPATCH_COLUMNS}
       FROM controller_deployment_gateway_disable_dispatches
       WHERE gateway_disable_idempotency_key_sha256 = ?1
       LIMIT 1`,
    ).bind(
      gatewayDisableIdempotencyKeySha256,
    ).first<DisableDispatchRow>();
    if (dispatch === null) throw new DisableRepositoryUnavailableError(true);
    const outcome = await session.prepare(
      `SELECT ${OUTCOME_COLUMNS}
       FROM controller_deployment_gateway_disable_outcomes
       WHERE gateway_disable_idempotency_key_sha256 = ?1
       LIMIT 1`,
    ).bind(
      gatewayDisableIdempotencyKeySha256,
    ).first<DisableOutcomeRow>();
    const observations = await session.prepare(
      `SELECT ${OBSERVATION_COLUMNS}
       FROM controller_deployment_gateway_disable_observations
       WHERE gateway_disable_idempotency_key_sha256 = ?1
       ORDER BY observation_id DESC
       LIMIT 2`,
    ).bind(gatewayDisableIdempotencyKeySha256).all<DisableObservationRow>();
    return {
      operation,
      dispatch,
      outcome,
      observations: observations.results,
    };
  } catch (error) {
    if (
      error instanceof DisableRepositoryNotFoundError
      || error instanceof DisableRepositoryUnavailableError
    ) {
      throw error;
    }
    throw new DisableRepositoryUnavailableError(false);
  }
}

async function readPreviousObservation(
  session: D1DatabaseSession,
  observation: DisableObservationRow,
): Promise<DisableObservationRow | null> {
  try {
    return await session.prepare(
      `SELECT ${OBSERVATION_COLUMNS}
       FROM controller_deployment_gateway_disable_observations
       WHERE gateway_disable_idempotency_key_sha256 = ?1
         AND observation_id < ?2
       ORDER BY observation_id DESC
       LIMIT 1`,
    ).bind(
      observation.gateway_disable_idempotency_key_sha256,
      observation.observation_id,
    ).first<DisableObservationRow>();
  } catch {
    throw new DisableRepositoryUnavailableError(false);
  }
}

function matchesReservation(
  snapshot: DisableOperationSnapshot,
  reservation: DisableOperationReservation,
): boolean {
  const { operation, dispatch } = snapshot;
  const { request, mutation } = reservation;
  return (
    operation.gateway_disable_idempotency_key_sha256
      === request.gatewayDisableIdempotencyKeySha256
    && operation.command_digest_sha256
      === request.controllerDisableCommandDigestSha256
    && operation.command_json === canonicalJson(request.command)
    && operation.authorization_id_sha256
      === request.command.authorizationIdSha256
    && operation.claim_digest_sha256 === request.command.claimDigestSha256
    && operation.operation14_id_sha256 === request.command.operation14IdSha256
    && operation.authority_database_identity_sha256
      === request.command.authorityDatabaseIdentitySha256
    && operation.authority_ledger_identity_sha256
      === request.command.authorityLedgerIdentitySha256
    && operation.authority_ledger_head_sha256
      === request.command.authorityLedgerHeadSha256
    && operation.authority_version_id === request.command.authorityVersionId
    && operation.lease_owner_sha256 === request.command.leaseOwnerSha256
    && operation.lease_token_sha256 === request.command.leaseTokenSha256
    && operation.lease_generation === request.command.leaseGeneration
    && operation.controller_service_name
      === request.command.controllerServiceName
    && operation.enabled_source_version_id
      === request.command.controllerEnabledSourceVersionId
    && operation.baseline_target_version_id
      === request.command.controllerBaselineTargetVersionId
    && operation.authority_attempt_digest_sha256
      === request.authorityAttemptDigestSha256
    && operation.send_started_event_digest_sha256
      === request.sendStartedEventDigestSha256
    && operation.account_id_sha256 === reservation.accountIdSha256
    && operation.gateway_profile_version === reservation.gatewayProfileVersion
    && dispatch.gateway_disable_idempotency_key_sha256
      === request.gatewayDisableIdempotencyKeySha256
    && dispatch.mutation_request_sha256 === mutation.mutationRequestSha256
    && dispatch.mutation_body === mutation.body
    && dispatch.mutation_annotation === mutation.mutationAnnotation
    && dispatch.intent_digest_sha256 === mutation.intentDigestSha256
    && dispatch.endpoint_path === mutation.endpointPath
    && dispatch.dispatch_semantics === DISABLE_DISPATCH_SEMANTICS
  );
}

function matchesOutcome(
  persisted: DisableOutcomeRow,
  outcome: DisableMutationOutcome,
): boolean {
  return persisted.classification === outcome.classification
    && persisted.http_status === outcome.httpStatus
    && persisted.response_body_sha256 === outcome.responseBodySha256
    && persisted.response_request_id_sha256 === outcome.responseRequestIdSha256
    && persisted.response_bytes === outcome.responseBytes;
}

function matchesObservation(
  persisted: DisableObservationRow,
  observation: DisableObservationEvidence,
  credentialIdSha256: string,
  requestIdSha256: string,
): boolean {
  return (
    persisted.disable_status_credential_id_sha256 === credentialIdSha256
    && persisted.disable_status_request_id_sha256 === requestIdSha256
    && persisted.classification === observation.classification
    && persisted.deployments_http_status
      === observation.deploymentsHttpStatus
    && persisted.baseline_version_http_status
      === observation.baselineVersionHttpStatus
    && persisted.deployment_set_sha256 === observation.deploymentSetSha256
    && persisted.baseline_version_sha256
      === observation.baselineVersionSha256
    && persisted.response_request_id_sha256
      === observation.responseRequestIdSha256
    && persisted.remote_observation_digest_sha256
      === observation.remoteObservationDigestSha256
    && persisted.state_digest_sha256 === observation.stateDigestSha256
    && persisted.observation_digest_sha256
      === observation.observationDigestSha256
  );
}
