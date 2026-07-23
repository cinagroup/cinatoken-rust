import type { Claim, ExpiryEvent, Step } from "./protocol";

const CLAIM_COLUMNS = `
  authorization_id_sha256, execution_nonce_sha256, claim_contract, claim_scope,
  environment, authorization_manifest_sha256, authorization_subject_sha256,
  authorization_policy_sha256, transition_manifest_sha256,
  transition_subject_sha256, transition_policy_sha256, transition_plan_sha256,
  candidate_sha256, execution_plan_sha256, account_id_sha256,
  ledger_identity_sha256, read_credential_id_sha256,
  claim_credential_id_sha256, deploy_credential_id_sha256,
  controller_service_name, controller_previous_version_id,
  controller_previous_deployment_set_sha256, controller_target_version_id,
  edge_service_name, edge_previous_version_id,
  edge_previous_deployment_set_sha256, edge_target_version_id,
  runner_build_sha256, runner_trust_config_sha256, claim_owner_sha256,
  claim_digest_sha256, status, state_version, generated_at, claimed_at,
  expires_at, updated_at, terminal_at
`;

const INSERT_CLAIM_SQL = `
INSERT INTO relay_container_ring_transition_claims (
  authorization_id_sha256, execution_nonce_sha256, claim_contract, claim_scope,
  environment, authorization_manifest_sha256, authorization_subject_sha256,
  authorization_policy_sha256, transition_manifest_sha256,
  transition_subject_sha256, transition_policy_sha256, transition_plan_sha256,
  candidate_sha256, execution_plan_sha256, account_id_sha256,
  ledger_identity_sha256, read_credential_id_sha256,
  claim_credential_id_sha256, deploy_credential_id_sha256,
  controller_service_name, controller_previous_version_id,
  controller_previous_deployment_set_sha256, controller_target_version_id,
  edge_service_name, edge_previous_version_id,
  edge_previous_deployment_set_sha256, edge_target_version_id,
  runner_build_sha256, runner_trust_config_sha256, claim_owner_sha256,
  claim_digest_sha256, status, state_version, generated_at, claimed_at,
  expires_at, updated_at, terminal_at
) VALUES (
  ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
  ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28,
  ?29, ?30, ?31, 'claimed', 0, ?32, unixepoch(), ?33, unixepoch(), NULL
)`;

const INSERT_STEP_SQL = `
INSERT INTO relay_container_ring_transition_steps (
  authorization_id_sha256, state_version, step_code, from_status, to_status,
  actor_execution_id_sha256, mutation_request_sha256,
  cloudflare_request_id_sha256, deployment_set_sha256, evidence_sha256,
  failure_class, step_digest_sha256, recorded_at, transport_outcome
) VALUES (
  ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, unixepoch(), ?13
)`;

const INSERT_EXPIRY_SQL = `
INSERT INTO relay_container_ring_transition_expiry_events (
  authorization_id_sha256, state_version, from_status, to_status,
  authority_actor_id_sha256, evidence_sha256, expiry_event_digest_sha256,
  failure_class, recorded_at
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, unixepoch())`;

export interface ClaimRow {
  authorization_id_sha256: string;
  execution_nonce_sha256: string;
  claim_contract: string;
  claim_scope: string;
  environment: string;
  authorization_manifest_sha256: string;
  authorization_subject_sha256: string;
  authorization_policy_sha256: string;
  transition_manifest_sha256: string;
  transition_subject_sha256: string;
  transition_policy_sha256: string;
  transition_plan_sha256: string;
  candidate_sha256: string;
  execution_plan_sha256: string;
  account_id_sha256: string;
  ledger_identity_sha256: string;
  read_credential_id_sha256: string;
  claim_credential_id_sha256: string;
  deploy_credential_id_sha256: string;
  controller_service_name: string;
  controller_previous_version_id: string;
  controller_previous_deployment_set_sha256: string;
  controller_target_version_id: string;
  edge_service_name: string;
  edge_previous_version_id: string;
  edge_previous_deployment_set_sha256: string;
  edge_target_version_id: string;
  runner_build_sha256: string;
  runner_trust_config_sha256: string;
  claim_owner_sha256: string;
  claim_digest_sha256: string;
  status: string;
  state_version: number;
  generated_at: number;
  claimed_at: number;
  expires_at: number;
  updated_at: number;
  terminal_at: number | null;
}

export interface StepRow {
  authorization_id_sha256: string;
  state_version: number;
  step_code: string;
  from_status: string;
  to_status: string;
  actor_execution_id_sha256: string;
  mutation_request_sha256: string | null;
  cloudflare_request_id_sha256: string | null;
  deployment_set_sha256: string | null;
  evidence_sha256: string;
  failure_class: string;
  step_digest_sha256: string;
  recorded_at: number;
  transport_outcome: string;
}

export interface ExpiryRow {
  authorization_id_sha256: string;
  state_version: number;
  from_status: string;
  to_status: string;
  authority_actor_id_sha256: string;
  evidence_sha256: string;
  expiry_event_digest_sha256: string;
  failure_class: string;
  recorded_at: number;
}

export interface ClaimSnapshot {
  claim: ClaimRow;
  steps: StepRow[];
  expiryEvents: ExpiryRow[];
}

export class RepositoryConflictError extends Error {
  constructor(readonly code = "claim_conflict") {
    super(code);
    this.name = "RepositoryConflictError";
  }
}

export class RepositoryNotFoundError extends Error {
  constructor() {
    super("claim_not_found");
    this.name = "RepositoryNotFoundError";
  }
}

export class RepositoryUnavailableError extends Error {
  constructor(readonly outcomeUnknown: boolean) {
    super("repository_unavailable");
    this.name = "RepositoryUnavailableError";
  }
}

export async function createClaim(
  database: D1Database,
  claim: Claim,
  authenticatedCredentialIdSha256: string,
): Promise<{ classification: "created" | "exact_replay"; claim: ClaimRow }> {
  if (claim.claimCredentialIdSha256 !== authenticatedCredentialIdSha256) {
    throw new RepositoryConflictError("credential_identity_mismatch");
  }
  const session = database.withSession("first-primary");
  let writeSucceeded = false;
  try {
    const result = await session
      .prepare(INSERT_CLAIM_SQL)
      .bind(
        claim.authorizationIdSha256,
        claim.executionNonceSha256,
        claim.claimAuthority,
        claim.claimScope,
        claim.environment,
        claim.authorizationManifestSha256,
        claim.authorizationSubjectSha256,
        claim.authorizationPolicySha256,
        claim.transitionManifestSha256,
        claim.transitionSubjectSha256,
        claim.transitionPolicySha256,
        claim.transitionPlanSha256,
        claim.candidateSha256,
        claim.executionPlanSha256,
        claim.accountIdSha256,
        claim.ledgerIdentitySha256,
        claim.readCredentialIdSha256,
        claim.claimCredentialIdSha256,
        claim.deployCredentialIdSha256,
        claim.controller.serviceName,
        claim.controller.previousVersionId,
        claim.controller.previousDeploymentSetSha256,
        claim.controller.targetVersionId,
        claim.edge.serviceName,
        claim.edge.previousVersionId,
        claim.edge.previousDeploymentSetSha256,
        claim.edge.targetVersionId,
        claim.runnerBuildSha256,
        claim.runnerTrustConfigSha256,
        claim.claimOwnerSha256,
        claim.claimDigestSha256,
        claim.generatedAt,
        claim.expiresAt,
      )
      .run();
    writeSucceeded = result.success;
  } catch {
    writeSucceeded = false;
  }
  const exact = await exactClaimReadback(
    session,
    claim.authorizationIdSha256,
    claim.claimDigestSha256,
    claim.claimOwnerSha256,
    claim.ledgerIdentitySha256,
    authenticatedCredentialIdSha256,
  );
  if (exact !== null) {
    return {
      classification: writeSucceeded ? "created" : "exact_replay",
      claim: exact,
    };
  }
  if (writeSucceeded) throw new RepositoryUnavailableError(true);
  throw new RepositoryConflictError();
}

export async function readExactClaim(
  database: D1Database,
  authorizationIdSha256: string,
  claimDigestSha256: string,
  claimOwnerSha256: string,
  authenticatedCredentialIdSha256: string,
): Promise<ClaimSnapshot> {
  const session = database.withSession("first-primary");
  let claim: ClaimRow | null;
  try {
    claim = await session
      .prepare(
        `SELECT ${CLAIM_COLUMNS}
         FROM relay_container_ring_transition_claims
         WHERE authorization_id_sha256 = ?1
           AND claim_digest_sha256 = ?2
           AND claim_owner_sha256 = ?3
           AND claim_credential_id_sha256 = ?4
         LIMIT 1`,
      )
      .bind(
        authorizationIdSha256,
        claimDigestSha256,
        claimOwnerSha256,
        authenticatedCredentialIdSha256,
      )
      .first<ClaimRow>();
  } catch {
    throw new RepositoryUnavailableError(false);
  }
  if (claim === null) {
    await classifyMissingClaim(session, authorizationIdSha256);
  }
  try {
    const steps = await session
      .prepare(
        `SELECT authorization_id_sha256, state_version, step_code, from_status,
           to_status, actor_execution_id_sha256, mutation_request_sha256,
           cloudflare_request_id_sha256, deployment_set_sha256, evidence_sha256,
           failure_class, step_digest_sha256, recorded_at, transport_outcome
         FROM relay_container_ring_transition_steps
         WHERE authorization_id_sha256 = ?1
         ORDER BY state_version`,
      )
      .bind(authorizationIdSha256)
      .all<StepRow>();
    const expiryEvents = await session
      .prepare(
        `SELECT authorization_id_sha256, state_version, from_status, to_status,
           authority_actor_id_sha256, evidence_sha256,
           expiry_event_digest_sha256, failure_class, recorded_at
         FROM relay_container_ring_transition_expiry_events
         WHERE authorization_id_sha256 = ?1
         ORDER BY state_version`,
      )
      .bind(authorizationIdSha256)
      .all<ExpiryRow>();
    return {
      claim: claim!,
      steps: steps.results,
      expiryEvents: expiryEvents.results,
    };
  } catch {
    throw new RepositoryUnavailableError(false);
  }
}

export async function appendStep(
  database: D1Database,
  authorizationIdSha256: string,
  step: Step,
  authenticatedCredentialIdSha256: string,
): Promise<{
  classification: "step_appended" | "step_replayed";
  claim: ClaimRow;
  step: StepRow;
}> {
  const session = database.withSession("first-primary");
  const claim = await requireClaimForMutation(
    session,
    authorizationIdSha256,
    step.claimDigestSha256,
    step.ledgerIdentitySha256,
    authenticatedCredentialIdSha256,
  );
  let writeSucceeded = false;
  try {
    const result = await session
      .prepare(INSERT_STEP_SQL)
      .bind(
        authorizationIdSha256,
        step.stateVersion,
        step.stepCode,
        step.fromStatus,
        step.toStatus,
        claim.claim_owner_sha256,
        step.mutationRequestSha256,
        step.cloudflareRequestIdSha256,
        step.deploymentSetSha256,
        step.evidenceSha256,
        step.failureClass,
        step.stepDigestSha256,
        step.transportOutcome,
      )
      .run();
    writeSucceeded = result.success;
  } catch {
    writeSucceeded = false;
  }
  const persistedStep = await readStep(session, authorizationIdSha256, step.stateVersion);
  if (persistedStep === null || !matchesStep(persistedStep, step, claim.claim_owner_sha256)) {
    if (writeSucceeded) throw new RepositoryUnavailableError(true);
    throw new RepositoryConflictError("step_conflict");
  }
  const updatedClaim = await exactClaimReadback(
    session,
    authorizationIdSha256,
    step.claimDigestSha256,
    claim.claim_owner_sha256,
    step.ledgerIdentitySha256,
    authenticatedCredentialIdSha256,
  );
  if (
    updatedClaim === null ||
    updatedClaim.state_version !== step.stateVersion ||
    updatedClaim.status !== step.toStatus
  ) {
    throw new RepositoryUnavailableError(true);
  }
  return {
    classification: writeSucceeded ? "step_appended" : "step_replayed",
    claim: updatedClaim,
    step: persistedStep,
  };
}

export async function expireClaim(
  database: D1Database,
  authorizationIdSha256: string,
  event: ExpiryEvent,
  authenticatedCredentialIdSha256: string,
  authorityActorIdSha256: string,
): Promise<{
  classification: "claim_expired" | "expiry_replayed";
  claim: ClaimRow;
  expiryEvent: ExpiryRow;
}> {
  const session = database.withSession("first-primary");
  const claim = await requireClaimForMutation(
    session,
    authorizationIdSha256,
    event.claimDigestSha256,
    event.ledgerIdentitySha256,
    authenticatedCredentialIdSha256,
  );
  if (claim.claim_owner_sha256 === authorityActorIdSha256) {
    throw new RepositoryConflictError("authority_actor_conflict");
  }
  let writeSucceeded = false;
  try {
    const result = await session
      .prepare(INSERT_EXPIRY_SQL)
      .bind(
        authorizationIdSha256,
        event.stateVersion,
        event.fromStatus,
        event.toStatus,
        authorityActorIdSha256,
        event.evidenceSha256,
        event.expiryEventDigestSha256,
        event.failureClass,
      )
      .run();
    writeSucceeded = result.success;
  } catch {
    writeSucceeded = false;
  }
  const persistedEvent = await readExpiryEvent(
    session,
    authorizationIdSha256,
    event.stateVersion,
  );
  if (
    persistedEvent === null ||
    !matchesExpiry(persistedEvent, event, authorityActorIdSha256)
  ) {
    if (writeSucceeded) throw new RepositoryUnavailableError(true);
    throw new RepositoryConflictError("expiry_conflict");
  }
  const updatedClaim = await exactClaimReadback(
    session,
    authorizationIdSha256,
    event.claimDigestSha256,
    claim.claim_owner_sha256,
    event.ledgerIdentitySha256,
    authenticatedCredentialIdSha256,
  );
  if (
    updatedClaim === null ||
    updatedClaim.state_version !== event.stateVersion ||
    updatedClaim.status !== event.toStatus
  ) {
    throw new RepositoryUnavailableError(true);
  }
  return {
    classification: writeSucceeded ? "claim_expired" : "expiry_replayed",
    claim: updatedClaim,
    expiryEvent: persistedEvent,
  };
}

async function requireClaimForMutation(
  session: D1DatabaseSession,
  authorizationIdSha256: string,
  claimDigestSha256: string,
  ledgerIdentitySha256: string,
  authenticatedCredentialIdSha256: string,
): Promise<ClaimRow> {
  let claim: ClaimRow | null;
  try {
    claim = await session
      .prepare(
        `SELECT ${CLAIM_COLUMNS}
         FROM relay_container_ring_transition_claims
         WHERE authorization_id_sha256 = ?1
           AND claim_digest_sha256 = ?2
           AND ledger_identity_sha256 = ?3
           AND claim_credential_id_sha256 = ?4
         LIMIT 1`,
      )
      .bind(
        authorizationIdSha256,
        claimDigestSha256,
        ledgerIdentitySha256,
        authenticatedCredentialIdSha256,
      )
      .first<ClaimRow>();
  } catch {
    throw new RepositoryUnavailableError(false);
  }
  if (claim === null) await classifyMissingClaim(session, authorizationIdSha256);
  return claim!;
}

async function exactClaimReadback(
  session: D1DatabaseSession,
  authorizationIdSha256: string,
  claimDigestSha256: string,
  claimOwnerSha256: string,
  ledgerIdentitySha256: string,
  authenticatedCredentialIdSha256: string,
): Promise<ClaimRow | null> {
  try {
    return await session
      .prepare(
        `SELECT ${CLAIM_COLUMNS}
         FROM relay_container_ring_transition_claims
         WHERE authorization_id_sha256 = ?1
           AND claim_digest_sha256 = ?2
           AND claim_owner_sha256 = ?3
           AND ledger_identity_sha256 = ?4
           AND claim_credential_id_sha256 = ?5
         LIMIT 1`,
      )
      .bind(
        authorizationIdSha256,
        claimDigestSha256,
        claimOwnerSha256,
        ledgerIdentitySha256,
        authenticatedCredentialIdSha256,
      )
      .first<ClaimRow>();
  } catch {
    throw new RepositoryUnavailableError(true);
  }
}

async function classifyMissingClaim(
  session: D1DatabaseSession,
  authorizationIdSha256: string,
): Promise<never> {
  let exists: { present: number } | null;
  try {
    exists = await session
      .prepare(
        `SELECT 1 AS present
         FROM relay_container_ring_transition_claims
         WHERE authorization_id_sha256 = ?1
         LIMIT 1`,
      )
      .bind(authorizationIdSha256)
      .first<{ present: number }>();
  } catch {
    throw new RepositoryUnavailableError(false);
  }
  if (exists === null) throw new RepositoryNotFoundError();
  throw new RepositoryConflictError("exact_claim_mismatch");
}

async function readStep(
  session: D1DatabaseSession,
  authorizationIdSha256: string,
  stateVersion: number,
): Promise<StepRow | null> {
  try {
    return await session
      .prepare(
        `SELECT authorization_id_sha256, state_version, step_code, from_status,
           to_status, actor_execution_id_sha256, mutation_request_sha256,
           cloudflare_request_id_sha256, deployment_set_sha256, evidence_sha256,
           failure_class, step_digest_sha256, recorded_at, transport_outcome
         FROM relay_container_ring_transition_steps
         WHERE authorization_id_sha256 = ?1 AND state_version = ?2
         LIMIT 1`,
      )
      .bind(authorizationIdSha256, stateVersion)
      .first<StepRow>();
  } catch {
    throw new RepositoryUnavailableError(true);
  }
}

async function readExpiryEvent(
  session: D1DatabaseSession,
  authorizationIdSha256: string,
  stateVersion: number,
): Promise<ExpiryRow | null> {
  try {
    return await session
      .prepare(
        `SELECT authorization_id_sha256, state_version, from_status, to_status,
           authority_actor_id_sha256, evidence_sha256,
           expiry_event_digest_sha256, failure_class, recorded_at
         FROM relay_container_ring_transition_expiry_events
         WHERE authorization_id_sha256 = ?1 AND state_version = ?2
         LIMIT 1`,
      )
      .bind(authorizationIdSha256, stateVersion)
      .first<ExpiryRow>();
  } catch {
    throw new RepositoryUnavailableError(true);
  }
}

function matchesStep(row: StepRow, step: Step, actorExecutionIdSha256: string): boolean {
  return (
    row.state_version === step.stateVersion &&
    row.step_code === step.stepCode &&
    row.from_status === step.fromStatus &&
    row.to_status === step.toStatus &&
    row.actor_execution_id_sha256 === actorExecutionIdSha256 &&
    row.mutation_request_sha256 === step.mutationRequestSha256 &&
    row.cloudflare_request_id_sha256 === step.cloudflareRequestIdSha256 &&
    row.deployment_set_sha256 === step.deploymentSetSha256 &&
    row.evidence_sha256 === step.evidenceSha256 &&
    row.failure_class === step.failureClass &&
    row.transport_outcome === step.transportOutcome &&
    row.step_digest_sha256 === step.stepDigestSha256
  );
}

function matchesExpiry(
  row: ExpiryRow,
  event: ExpiryEvent,
  authorityActorIdSha256: string,
): boolean {
  return (
    row.state_version === event.stateVersion &&
    row.from_status === event.fromStatus &&
    row.to_status === event.toStatus &&
    row.authority_actor_id_sha256 === authorityActorIdSha256 &&
    row.evidence_sha256 === event.evidenceSha256 &&
    row.expiry_event_digest_sha256 === event.expiryEventDigestSha256 &&
    row.failure_class === event.failureClass
  );
}

export const repositorySqlForTest = {
  insertClaim: INSERT_CLAIM_SQL,
  insertStep: INSERT_STEP_SQL,
  insertExpiry: INSERT_EXPIRY_SQL,
} as const;
