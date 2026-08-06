import { canonicalJson } from "./canonical";
import {
  MUTATION_DISPATCH_SEMANTICS,
  type JsonRecord,
  type PreparedDeploymentMutation,
} from "./protocol";

const CLAIM_COLUMNS = `
  mutation_intent_sha256, mutation_rpc_request_sha256,
  operation_id_sha256, operation_digest_sha256, authorized_request_sha256,
  campaign_plan_digest_sha256, state_plan_digest_sha256,
  execution_authority_sha256, source_authentication_digest_sha256,
  source_readback_set_sha256, canonical_intent, exact_request_body,
  mutation_request_sha256, mutation_annotation, mutation_annotation_sha256,
  endpoint_path, endpoint_sha256, target_role, target_service_name,
  target_entrypoint, target_version_id, target_config_sha256,
  mutation_service_identity_json, mutation_service_identity_sha256,
  credential_id_sha256, authentication_identity_sha256, account_id_sha256,
  mutator_service_name, mutator_entrypoint, mutator_version_id,
  mutator_profile_version, dispatch_semantics, claimed_at
`;

const OUTCOME_COLUMNS = `
  mutation_intent_sha256, outcome_json, outcome_digest_sha256, classification,
  http_status, response_body_sha256, response_request_id_sha256,
  response_bytes, recorded_at
`;

export interface MutationClaimRow {
  mutation_intent_sha256: string;
  mutation_rpc_request_sha256: string;
  operation_id_sha256: string;
  operation_digest_sha256: string;
  authorized_request_sha256: string;
  campaign_plan_digest_sha256: string;
  state_plan_digest_sha256: string;
  execution_authority_sha256: string;
  source_authentication_digest_sha256: string;
  source_readback_set_sha256: string;
  canonical_intent: string;
  exact_request_body: string;
  mutation_request_sha256: string;
  mutation_annotation: string;
  mutation_annotation_sha256: string;
  endpoint_path: string;
  endpoint_sha256: string;
  target_role: string;
  target_service_name: string;
  target_entrypoint: string;
  target_version_id: string;
  target_config_sha256: string;
  mutation_service_identity_json: string;
  mutation_service_identity_sha256: string;
  credential_id_sha256: string;
  authentication_identity_sha256: string;
  account_id_sha256: string;
  mutator_service_name: string;
  mutator_entrypoint: string;
  mutator_version_id: string;
  mutator_profile_version: number;
  dispatch_semantics: string;
  claimed_at: number;
}

export interface MutationOutcomeRow {
  mutation_intent_sha256: string;
  outcome_json: string;
  outcome_digest_sha256: string;
  classification: string;
  http_status: number | null;
  response_body_sha256: string | null;
  response_request_id_sha256: string | null;
  response_bytes: number | null;
  recorded_at: number;
}

export interface MutationClaim {
  readonly classification: "fresh" | "exact_replay";
  readonly row: MutationClaimRow;
}

export interface MutationJournal {
  reserve(mutation: PreparedDeploymentMutation): Promise<MutationClaim>;
  recordOutcome(
    mutationIntentSha256: string,
    outcome: JsonRecord,
  ): Promise<MutationOutcomeRow>;
}

export class MutationRepositoryConflictError extends Error {
  constructor(readonly code = "mutation_journal_conflict") {
    super(code);
    this.name = "MutationRepositoryConflictError";
  }
}

export class MutationRepositoryUnavailableError extends Error {
  constructor(readonly outcomeUnknown: boolean) {
    super("mutation_journal_unavailable");
    this.name = "MutationRepositoryUnavailableError";
  }
}

export class D1MutationJournal implements MutationJournal {
  constructor(private readonly database: D1Database) {}

  async reserve(
    mutation: PreparedDeploymentMutation,
  ): Promise<MutationClaim> {
    const session = this.database.withSession("first-primary");
    let definitelyFresh = false;
    try {
      const result = await session.prepare(
        `INSERT INTO json_compatibility_deployment_mutation_claims (
          mutation_intent_sha256, mutation_rpc_request_sha256,
          operation_id_sha256, operation_digest_sha256,
          authorized_request_sha256, campaign_plan_digest_sha256,
          state_plan_digest_sha256, execution_authority_sha256,
          source_authentication_digest_sha256, source_readback_set_sha256,
          canonical_intent, exact_request_body, mutation_request_sha256,
          mutation_annotation, mutation_annotation_sha256, endpoint_path,
          endpoint_sha256, target_role, target_service_name,
          target_entrypoint, target_version_id, target_config_sha256,
          mutation_service_identity_json, mutation_service_identity_sha256,
          credential_id_sha256, authentication_identity_sha256,
          account_id_sha256, mutator_service_name, mutator_entrypoint,
          mutator_version_id, mutator_profile_version, dispatch_semantics,
          claimed_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
          ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24,
          ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32, unixepoch()
        )`,
      ).bind(
        mutation.mutationIntentSha256,
        mutation.mutationRpcRequestSha256,
        mutation.operationIdSha256,
        mutation.operationDigestSha256,
        mutation.authorizedRequestSha256,
        mutation.campaignPlanDigestSha256,
        mutation.statePlanDigestSha256,
        mutation.executionAuthoritySha256,
        mutation.sourceAuthenticationDigestSha256,
        mutation.sourceReadbackSetSha256,
        mutation.mutationIntentJson,
        mutation.requestBody,
        mutation.mutationRequestSha256,
        mutation.mutationAnnotation,
        mutation.mutationAnnotationSha256,
        mutation.endpointPath,
        mutation.endpointSha256,
        mutation.role,
        mutation.targetServiceName,
        mutation.targetEntrypoint,
        mutation.targetVersionId,
        mutation.targetConfigSha256,
        mutation.mutationServiceIdentityJson,
        mutation.mutationServiceIdentitySha256,
        mutation.credentialIdSha256,
        mutation.authenticationIdentitySha256,
        mutation.accountIdSha256,
        mutation.mutatorServiceName,
        mutation.mutatorEntrypoint,
        mutation.mutatorVersionId,
        mutation.mutatorProfileVersion,
        MUTATION_DISPATCH_SEMANTICS,
      ).run();
      definitelyFresh = result.success === true && result.meta.changes === 1;
    } catch {
      definitelyFresh = false;
    }
    const row = await readClaim(
      session,
      mutation.mutationIntentSha256,
      !definitelyFresh,
    );
    if (!matchesMutation(row, mutation)) {
      throw new MutationRepositoryConflictError();
    }
    return {
      classification: definitelyFresh ? "fresh" : "exact_replay",
      row,
    };
  }

  async recordOutcome(
    mutationIntentSha256: string,
    outcome: JsonRecord,
  ): Promise<MutationOutcomeRow> {
    const session = this.database.withSession("first-primary");
    const outcomeDigestSha256 = stringValue(
      outcome.outcomeDigestSha256,
      "outcome digest",
    );
    const outcomeJson = canonicalJson(outcome);
    try {
      await session.prepare(
        `INSERT INTO json_compatibility_deployment_mutation_outcomes (
          mutation_intent_sha256, outcome_json, outcome_digest_sha256,
          classification, http_status, response_body_sha256,
          response_request_id_sha256, response_bytes, recorded_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, unixepoch())`,
      ).bind(
        mutationIntentSha256,
        outcomeJson,
        outcomeDigestSha256,
        outcome.classification,
        outcome.httpStatus,
        outcome.responseBodySha256,
        outcome.responseRequestIdSha256,
        outcome.responseBytes,
      ).run();
    } catch {
      // Read-after-write distinguishes an exact persisted result from loss.
    }
    let row: MutationOutcomeRow | null;
    try {
      row = await session.prepare(
        `SELECT ${OUTCOME_COLUMNS}
         FROM json_compatibility_deployment_mutation_outcomes
         WHERE mutation_intent_sha256 = ?1
         LIMIT 1`,
      ).bind(mutationIntentSha256).first<MutationOutcomeRow>();
    } catch {
      throw new MutationRepositoryUnavailableError(true);
    }
    if (row === null) throw new MutationRepositoryUnavailableError(true);
    if (
      row.outcome_digest_sha256 !== outcomeDigestSha256
      || row.outcome_json !== outcomeJson
    ) {
      throw new MutationRepositoryConflictError("mutation_outcome_conflict");
    }
    return row;
  }
}

export async function readMutationSnapshot(
  database: D1Database,
  mutationIntentSha256: string,
): Promise<{
  readonly claim: MutationClaimRow;
  readonly outcome: MutationOutcomeRow | null;
}> {
  const session = database.withSession("first-primary");
  const claim = await readClaim(session, mutationIntentSha256, false);
  let outcome: MutationOutcomeRow | null;
  try {
    outcome = await session.prepare(
      `SELECT ${OUTCOME_COLUMNS}
       FROM json_compatibility_deployment_mutation_outcomes
       WHERE mutation_intent_sha256 = ?1
       LIMIT 1`,
    ).bind(mutationIntentSha256).first<MutationOutcomeRow>();
  } catch {
    throw new MutationRepositoryUnavailableError(false);
  }
  return { claim, outcome };
}

async function readClaim(
  session: D1DatabaseSession,
  mutationIntentSha256: string,
  outcomeUnknown: boolean,
): Promise<MutationClaimRow> {
  let row: MutationClaimRow | null;
  try {
    row = await session.prepare(
      `SELECT ${CLAIM_COLUMNS}
       FROM json_compatibility_deployment_mutation_claims
       WHERE mutation_intent_sha256 = ?1
       LIMIT 1`,
    ).bind(mutationIntentSha256).first<MutationClaimRow>();
  } catch {
    throw new MutationRepositoryUnavailableError(outcomeUnknown);
  }
  if (row === null) {
    throw new MutationRepositoryUnavailableError(outcomeUnknown);
  }
  return row;
}

function matchesMutation(
  row: MutationClaimRow,
  mutation: PreparedDeploymentMutation,
): boolean {
  const expected: Omit<MutationClaimRow, "claimed_at"> = {
    mutation_intent_sha256: mutation.mutationIntentSha256,
    mutation_rpc_request_sha256: mutation.mutationRpcRequestSha256,
    operation_id_sha256: mutation.operationIdSha256,
    operation_digest_sha256: mutation.operationDigestSha256,
    authorized_request_sha256: mutation.authorizedRequestSha256,
    campaign_plan_digest_sha256: mutation.campaignPlanDigestSha256,
    state_plan_digest_sha256: mutation.statePlanDigestSha256,
    execution_authority_sha256: mutation.executionAuthoritySha256,
    source_authentication_digest_sha256:
      mutation.sourceAuthenticationDigestSha256,
    source_readback_set_sha256: mutation.sourceReadbackSetSha256,
    canonical_intent: mutation.mutationIntentJson,
    exact_request_body: mutation.requestBody,
    mutation_request_sha256: mutation.mutationRequestSha256,
    mutation_annotation: mutation.mutationAnnotation,
    mutation_annotation_sha256: mutation.mutationAnnotationSha256,
    endpoint_path: mutation.endpointPath,
    endpoint_sha256: mutation.endpointSha256,
    target_role: mutation.role,
    target_service_name: mutation.targetServiceName,
    target_entrypoint: mutation.targetEntrypoint,
    target_version_id: mutation.targetVersionId,
    target_config_sha256: mutation.targetConfigSha256,
    mutation_service_identity_json: mutation.mutationServiceIdentityJson,
    mutation_service_identity_sha256: mutation.mutationServiceIdentitySha256,
    credential_id_sha256: mutation.credentialIdSha256,
    authentication_identity_sha256: mutation.authenticationIdentitySha256,
    account_id_sha256: mutation.accountIdSha256,
    mutator_service_name: mutation.mutatorServiceName,
    mutator_entrypoint: mutation.mutatorEntrypoint,
    mutator_version_id: mutation.mutatorVersionId,
    mutator_profile_version: mutation.mutatorProfileVersion,
    dispatch_semantics: MUTATION_DISPATCH_SEMANTICS,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (row[key as keyof MutationClaimRow] !== value) return false;
  }
  return Number.isSafeInteger(row.claimed_at) && row.claimed_at >= 0;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  return value;
}
