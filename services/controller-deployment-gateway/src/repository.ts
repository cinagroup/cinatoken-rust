import {
  DISPATCH_SEMANTICS,
  type DeploymentMutation,
  type MutationOutcome,
  type StatusObservation,
} from "./cloudflare_client";
import {
  canonicalJson,
  type CreateDeploymentRequest,
} from "./protocol";

const OPERATION_COLUMNS = `
  gateway_idempotency_key_sha256, command_digest_sha256, command_json,
  authorization_id_sha256, controller_enable_operation_id_sha256,
  authority_attempt_digest_sha256, send_started_event_digest_sha256,
  controller_service_name, baseline_version_id, target_version_id,
  account_id_sha256, gateway_profile_version, create_credential_id_sha256,
  create_request_id_sha256, created_at
`;

const DISPATCH_COLUMNS = `
  gateway_idempotency_key_sha256, mutation_request_sha256, mutation_body,
  mutation_annotation, endpoint_path, dispatch_semantics, authorized_at
`;

const OUTCOME_COLUMNS = `
  gateway_idempotency_key_sha256, classification, http_status,
  response_body_sha256, response_request_id_sha256, response_bytes, recorded_at
`;

const OBSERVATION_COLUMNS = `
  observation_id, gateway_idempotency_key_sha256,
  status_credential_id_sha256, status_request_id_sha256, classification,
  deployments_http_status, version_http_status, deployment_set_sha256,
  target_version_sha256, response_request_id_sha256,
  observation_digest_sha256, recorded_at
`;

export interface OperationRow {
  gateway_idempotency_key_sha256: string;
  command_digest_sha256: string;
  command_json: string;
  authorization_id_sha256: string;
  controller_enable_operation_id_sha256: string;
  authority_attempt_digest_sha256: string;
  send_started_event_digest_sha256: string;
  controller_service_name: string;
  baseline_version_id: string;
  target_version_id: string;
  account_id_sha256: string;
  gateway_profile_version: number;
  create_credential_id_sha256: string;
  create_request_id_sha256: string;
  created_at: number;
}

export interface DispatchRow {
  gateway_idempotency_key_sha256: string;
  mutation_request_sha256: string;
  mutation_body: string;
  mutation_annotation: string;
  endpoint_path: string;
  dispatch_semantics: string;
  authorized_at: number;
}

export interface OutcomeRow {
  gateway_idempotency_key_sha256: string;
  classification: string;
  http_status: number | null;
  response_body_sha256: string | null;
  response_request_id_sha256: string | null;
  response_bytes: number | null;
  recorded_at: number;
}

export interface ObservationRow {
  observation_id: number;
  gateway_idempotency_key_sha256: string;
  status_credential_id_sha256: string;
  status_request_id_sha256: string;
  classification: string;
  deployments_http_status: number | null;
  version_http_status: number | null;
  deployment_set_sha256: string | null;
  target_version_sha256: string | null;
  response_request_id_sha256: string | null;
  observation_digest_sha256: string;
  recorded_at: number;
}

export interface OperationSnapshot {
  operation: OperationRow;
  dispatch: DispatchRow;
  outcome: OutcomeRow | null;
  observations: ObservationRow[];
}

export interface OperationReservation {
  request: CreateDeploymentRequest;
  mutation: DeploymentMutation;
  accountIdSha256: string;
  gatewayProfileVersion: 1;
  createCredentialIdSha256: string;
  createRequestIdSha256: string;
}

export class RepositoryConflictError extends Error {
  constructor(readonly code = "operation_conflict") {
    super(code);
    this.name = "RepositoryConflictError";
  }
}

export class RepositoryNotFoundError extends Error {
  constructor() {
    super("operation_not_found");
    this.name = "RepositoryNotFoundError";
  }
}

export class RepositoryUnavailableError extends Error {
  constructor(readonly outcomeUnknown: boolean) {
    super("repository_unavailable");
    this.name = "RepositoryUnavailableError";
  }
}

export async function reserveOperationAndDispatch(
  database: D1Database,
  reservation: OperationReservation,
): Promise<{
  classification: "created" | "exact_replay";
  snapshot: OperationSnapshot;
}> {
  const { request, mutation } = reservation;
  const session = database.withSession("first-primary");
  let definitelyFresh = false;
  try {
    const results = await session.batch([
      session.prepare(
        `INSERT INTO controller_deployment_gateway_operations (
          gateway_idempotency_key_sha256, command_digest_sha256, command_json,
          authorization_id_sha256, controller_enable_operation_id_sha256,
          authority_attempt_digest_sha256, send_started_event_digest_sha256,
          controller_service_name, baseline_version_id, target_version_id,
          account_id_sha256, gateway_profile_version,
          create_credential_id_sha256, create_request_id_sha256, created_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
          unixepoch()
        )`,
      ).bind(
        request.gatewayIdempotencyKeySha256,
        request.controllerCommandDigestSha256,
        canonicalJson(request.command),
        request.command.authorizationIdSha256,
        request.command.controllerEnableOperationIdSha256,
        request.authorityAttemptDigestSha256,
        request.sendStartedEventDigestSha256,
        request.command.controllerServiceName,
        request.command.controllerBaselineVersionId,
        request.command.controllerEnabledVersionId,
        reservation.accountIdSha256,
        reservation.gatewayProfileVersion,
        reservation.createCredentialIdSha256,
        reservation.createRequestIdSha256,
      ),
      session.prepare(
        `INSERT INTO controller_deployment_gateway_dispatches (
          gateway_idempotency_key_sha256, mutation_request_sha256,
          mutation_body, mutation_annotation, endpoint_path,
          dispatch_semantics, authorized_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, unixepoch())`,
      ).bind(
        request.gatewayIdempotencyKeySha256,
        mutation.mutationRequestSha256,
        mutation.body,
        mutation.mutationAnnotation,
        mutation.endpointPath,
        DISPATCH_SEMANTICS,
      ),
    ]);
    definitelyFresh = results.length === 2 && results.every(
      (result) => result.success === true && result.meta.changes === 1,
    );
  } catch {
    definitelyFresh = false;
  }
  const snapshot = await readOperationSnapshot(
    session,
    request.gatewayIdempotencyKeySha256,
  );
  if (!matchesReservation(snapshot, reservation)) {
    throw new RepositoryConflictError();
  }
  return {
    classification: definitelyFresh ? "created" : "exact_replay",
    snapshot,
  };
}

export async function readExactOperation(
  database: D1Database,
  gatewayIdempotencyKeySha256: string,
  commandDigestSha256: string,
  accountIdSha256: string,
): Promise<OperationSnapshot> {
  const snapshot = await readOperationSnapshot(
    database.withSession("first-primary"),
    gatewayIdempotencyKeySha256,
  );
  if (
    snapshot.operation.command_digest_sha256 !== commandDigestSha256
    || snapshot.operation.account_id_sha256 !== accountIdSha256
  ) {
    throw new RepositoryConflictError();
  }
  return snapshot;
}

export async function appendOutcome(
  database: D1Database,
  gatewayIdempotencyKeySha256: string,
  outcome: MutationOutcome,
): Promise<{
  classification: "recorded" | "exact_replay";
  outcome: OutcomeRow;
}> {
  const session = database.withSession("first-primary");
  let writeSucceeded = false;
  try {
    const result = await session.prepare(
      `INSERT INTO controller_deployment_gateway_outcomes (
        gateway_idempotency_key_sha256, classification, http_status,
        response_body_sha256, response_request_id_sha256, response_bytes,
        recorded_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, unixepoch())`,
    ).bind(
      gatewayIdempotencyKeySha256,
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
  let persisted: OutcomeRow | null;
  try {
    persisted = await session.prepare(
      `SELECT ${OUTCOME_COLUMNS}
       FROM controller_deployment_gateway_outcomes
       WHERE gateway_idempotency_key_sha256 = ?1
       LIMIT 1`,
    ).bind(gatewayIdempotencyKeySha256).first<OutcomeRow>();
  } catch {
    throw new RepositoryUnavailableError(true);
  }
  if (persisted === null || !matchesOutcome(persisted, outcome)) {
    if (persisted !== null) throw new RepositoryConflictError("outcome_conflict");
    throw new RepositoryUnavailableError(true);
  }
  return {
    classification: writeSucceeded ? "recorded" : "exact_replay",
    outcome: persisted,
  };
}

export async function appendObservation(
  database: D1Database,
  gatewayIdempotencyKeySha256: string,
  observation: StatusObservation,
  statusCredentialIdSha256: string,
  statusRequestIdSha256: string,
): Promise<{
  classification: "recorded" | "exact_replay";
  observation: ObservationRow;
  previousObservation: ObservationRow | null;
}> {
  const session = database.withSession("first-primary");
  let writeSucceeded = false;
  try {
    const result = await session.prepare(
      `INSERT INTO controller_deployment_gateway_observations (
        gateway_idempotency_key_sha256, status_credential_id_sha256,
        status_request_id_sha256, classification, deployments_http_status,
        version_http_status, deployment_set_sha256, target_version_sha256,
        response_request_id_sha256, observation_digest_sha256, recorded_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, unixepoch())`,
    ).bind(
      gatewayIdempotencyKeySha256,
      statusCredentialIdSha256,
      statusRequestIdSha256,
      observation.classification,
      observation.deploymentsHttpStatus,
      observation.versionHttpStatus,
      observation.deploymentSetSha256,
      observation.targetVersionSha256,
      observation.responseRequestIdSha256,
      observation.observationDigestSha256,
    ).run();
    writeSucceeded = result.success && result.meta.changes === 1;
  } catch {
    writeSucceeded = false;
  }
  let persisted: ObservationRow | null;
  try {
    persisted = await session.prepare(
      `SELECT ${OBSERVATION_COLUMNS}
       FROM controller_deployment_gateway_observations
       WHERE gateway_idempotency_key_sha256 = ?1
         AND observation_digest_sha256 = ?2
       LIMIT 1`,
    ).bind(
      gatewayIdempotencyKeySha256,
      observation.observationDigestSha256,
    ).first<ObservationRow>();
  } catch {
    throw new RepositoryUnavailableError(false);
  }
  if (
    persisted === null
    || !matchesObservation(
      persisted,
      observation,
      statusCredentialIdSha256,
      statusRequestIdSha256,
    )
  ) {
    if (persisted !== null) {
      throw new RepositoryConflictError("observation_conflict");
    }
    throw new RepositoryUnavailableError(false);
  }
  let previousObservation: ObservationRow | null;
  try {
    previousObservation = await session.prepare(
      `SELECT ${OBSERVATION_COLUMNS}
       FROM controller_deployment_gateway_observations
       WHERE gateway_idempotency_key_sha256 = ?1
         AND observation_id < ?2
       ORDER BY observation_id DESC
       LIMIT 1`,
    ).bind(
      gatewayIdempotencyKeySha256,
      persisted.observation_id,
    ).first<ObservationRow>();
  } catch {
    throw new RepositoryUnavailableError(false);
  }
  return {
    classification: writeSucceeded ? "recorded" : "exact_replay",
    observation: persisted,
    previousObservation,
  };
}

async function readOperationSnapshot(
  session: D1DatabaseSession,
  gatewayIdempotencyKeySha256: string,
): Promise<OperationSnapshot> {
  try {
    const operation = await session.prepare(
      `SELECT ${OPERATION_COLUMNS}
       FROM controller_deployment_gateway_operations
       WHERE gateway_idempotency_key_sha256 = ?1
       LIMIT 1`,
    ).bind(gatewayIdempotencyKeySha256).first<OperationRow>();
    if (operation === null) {
      throw new RepositoryNotFoundError();
    }
    const dispatch = await session.prepare(
      `SELECT ${DISPATCH_COLUMNS}
       FROM controller_deployment_gateway_dispatches
       WHERE gateway_idempotency_key_sha256 = ?1
       LIMIT 1`,
    ).bind(gatewayIdempotencyKeySha256).first<DispatchRow>();
    if (dispatch === null) throw new RepositoryUnavailableError(true);
    const outcome = await session.prepare(
      `SELECT ${OUTCOME_COLUMNS}
       FROM controller_deployment_gateway_outcomes
       WHERE gateway_idempotency_key_sha256 = ?1
       LIMIT 1`,
    ).bind(gatewayIdempotencyKeySha256).first<OutcomeRow>();
    const observations = await session.prepare(
      `SELECT ${OBSERVATION_COLUMNS}
       FROM controller_deployment_gateway_observations
       WHERE gateway_idempotency_key_sha256 = ?1
       ORDER BY observation_id DESC
       LIMIT 2`,
    ).bind(gatewayIdempotencyKeySha256).all<ObservationRow>();
    return {
      operation,
      dispatch,
      outcome,
      observations: observations.results,
    };
  } catch (error) {
    if (
      error instanceof RepositoryNotFoundError
      || error instanceof RepositoryUnavailableError
    ) {
      throw error;
    }
    throw new RepositoryUnavailableError(false);
  }
}

function matchesReservation(
  snapshot: OperationSnapshot,
  reservation: OperationReservation,
): boolean {
  const { operation, dispatch } = snapshot;
  const { request, mutation } = reservation;
  return (
    operation.gateway_idempotency_key_sha256
      === request.gatewayIdempotencyKeySha256
    && operation.command_digest_sha256
      === request.controllerCommandDigestSha256
    && operation.command_json === canonicalJson(request.command)
    && operation.authorization_id_sha256
      === request.command.authorizationIdSha256
    && operation.controller_enable_operation_id_sha256
      === request.command.controllerEnableOperationIdSha256
    && operation.authority_attempt_digest_sha256
      === request.authorityAttemptDigestSha256
    && operation.send_started_event_digest_sha256
      === request.sendStartedEventDigestSha256
    && operation.controller_service_name
      === request.command.controllerServiceName
    && operation.baseline_version_id
      === request.command.controllerBaselineVersionId
    && operation.target_version_id
      === request.command.controllerEnabledVersionId
    && operation.account_id_sha256 === reservation.accountIdSha256
    && operation.gateway_profile_version === reservation.gatewayProfileVersion
    && dispatch.gateway_idempotency_key_sha256
      === request.gatewayIdempotencyKeySha256
    && dispatch.mutation_request_sha256 === mutation.mutationRequestSha256
    && dispatch.mutation_body === mutation.body
    && dispatch.mutation_annotation === mutation.mutationAnnotation
    && dispatch.endpoint_path === mutation.endpointPath
    && dispatch.dispatch_semantics === DISPATCH_SEMANTICS
  );
}

function matchesOutcome(
  persisted: OutcomeRow,
  outcome: MutationOutcome,
): boolean {
  return (
    persisted.classification === outcome.classification
    && persisted.http_status === outcome.httpStatus
    && persisted.response_body_sha256 === outcome.responseBodySha256
    && persisted.response_request_id_sha256 === outcome.responseRequestIdSha256
    && persisted.response_bytes === outcome.responseBytes
  );
}

function matchesObservation(
  persisted: ObservationRow,
  observation: StatusObservation,
  credentialIdSha256: string,
  requestIdSha256: string,
): boolean {
  return (
    persisted.status_credential_id_sha256 === credentialIdSha256
    && persisted.status_request_id_sha256 === requestIdSha256
    && persisted.classification === observation.classification
    && persisted.deployments_http_status
      === observation.deploymentsHttpStatus
    && persisted.version_http_status === observation.versionHttpStatus
    && persisted.deployment_set_sha256 === observation.deploymentSetSha256
    && persisted.target_version_sha256 === observation.targetVersionSha256
    && persisted.response_request_id_sha256
      === observation.responseRequestIdSha256
    && persisted.observation_digest_sha256
      === observation.observationDigestSha256
  );
}
