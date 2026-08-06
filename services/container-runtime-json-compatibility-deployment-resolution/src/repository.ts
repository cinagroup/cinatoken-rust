import { canonicalJson } from
  "../../container-runtime-json-compatibility-deployment-transition/src/canonical";
import {
  validateJsonCompatibilityDeploymentTransitionReadback,
} from "../../../tools/container_runtime_json_compatibility_deployment_transition.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_CLAIM_BYTES = 64 * 1024;
const MAX_TRANSITION_EVENT_BYTES = 128 * 1024;
const MAX_EXECUTION_DISABLED_EVIDENCE_BYTES = 32 * 1024;
const MAX_READBACK_REQUEST_BYTES = 64 * 1024;
const MAX_OBSERVATION_BYTES = 128 * 1024;
const MAX_RESOLUTION_BYTES = 256 * 1024;
const MINIMUM_OBSERVATION_SPACING_SECONDS = 5;
const CLAIM_LEASE_SECONDS = 45;

const CLAIM_COLUMNS = `
  operation_id_sha256, operation_digest_sha256, generation,
  claim_digest_sha256, authorization_digest_sha256,
  resolver_identity_sha256, journal_head_ordinal,
  journal_head_digest_sha256, pending_mutation_intent_ordinal,
  pending_mutation_intent_digest_sha256, expected_target_state_sha256,
  execution_disabled_evidence_digest_sha256,
  execution_disabled_evidence_json, claim_json, quiesced_at,
  settle_not_before, source_authentication_expires_at,
  authorization_expires_at, lease_expires_at, claimed_at
`;

const OBSERVATION_COLUMNS = `
  operation_id_sha256, generation, observation_ordinal,
  claim_digest_sha256, request_digest_sha256, request_json,
  observation_digest_sha256, observation_json, observed_state_sha256,
  readback_version_id, readback_identity_sha256, observed_at
`;

const OUTCOME_COLUMNS = `
  operation_id_sha256, generation, claim_digest_sha256, classification,
  observation_one_digest_sha256, observation_two_digest_sha256,
  resolution_digest_sha256, resolution_json, resolved_at
`;

export type ResolutionOutcomeClassification =
  | "target_confirmed"
  | "manual_review_required"
  | "readback_inconclusive";

export type ResolutionSnapshotClassification =
  | "not_found"
  | "inflight"
  | "resolution_claimed"
  | "readback_inconclusive"
  | "terminal_receipt"
  | "final_resolution";

export interface ResolutionClaimInput {
  readonly operationIdSha256: string;
  readonly operationDigestSha256: string;
  readonly generation: number;
  readonly claimDigestSha256: string;
  readonly authorizationDigestSha256: string;
  readonly resolverIdentitySha256: string;
  readonly journalHeadOrdinal: number;
  readonly journalHeadDigestSha256: string;
  readonly pendingMutationIntentOrdinal: number;
  readonly pendingMutationIntentDigestSha256: string;
  readonly expectedTargetStateSha256: string;
  readonly executionDisabledEvidenceDigestSha256: string;
  readonly executionDisabledEvidence: unknown;
  readonly claim: unknown;
  readonly quiescedAt: number;
  readonly settleNotBefore: number;
  readonly sourceAuthenticationExpiresAt: number;
  readonly authorizationExpiresAt: number;
  readonly claimLeaseSeconds: 45;
}

export interface ResolutionObservationInput {
  readonly operationIdSha256: string;
  readonly operationDigestSha256: string;
  readonly generation: number;
  readonly claimDigestSha256: string;
  readonly observationOrdinal: 1 | 2;
  readonly requestDigestSha256: string;
  readonly request: unknown;
  readonly observationDigestSha256: string;
  readonly observation: unknown;
  readonly observedStateSha256: string;
  readonly readbackVersionId: string;
  readonly readbackIdentitySha256: string;
}

export interface ResolutionFinalizeInput {
  readonly operationIdSha256: string;
  readonly operationDigestSha256: string;
  readonly generation: number;
  readonly claimDigestSha256: string;
  readonly classification: ResolutionOutcomeClassification;
  readonly observationOneDigestSha256: string;
  readonly observationTwoDigestSha256: string;
  readonly resolutionDigestSha256: string;
  readonly resolution: unknown;
}

export interface ResolutionClaimRecord
  extends Readonly<Record<string, unknown>> {
  readonly operationIdSha256: string;
  readonly operationDigestSha256: string;
  readonly generation: number;
  readonly claimDigestSha256: string;
  readonly authorizationDigestSha256: string;
  readonly resolverIdentitySha256: string;
  readonly journalHeadOrdinal: number;
  readonly journalHeadDigestSha256: string;
  readonly pendingMutationIntentOrdinal: number;
  readonly pendingMutationIntentDigestSha256: string;
  readonly expectedTargetStateSha256: string;
  readonly executionDisabledEvidenceDigestSha256: string;
  readonly executionDisabledEvidence: unknown;
  readonly claim: unknown;
  readonly quiescedAt: number;
  readonly settleNotBefore: number;
  readonly sourceAuthenticationExpiresAt: number;
  readonly authorizationExpiresAt: number;
  readonly leaseExpiresAt: number;
  readonly claimedAt: number;
}

export interface ResolutionObservationRecord {
  readonly operationIdSha256: string;
  readonly generation: number;
  readonly observationOrdinal: 1 | 2;
  readonly claimDigestSha256: string;
  readonly requestDigestSha256: string;
  readonly request: unknown;
  readonly observationDigestSha256: string;
  readonly observation: unknown;
  readonly observedStateSha256: string;
  readonly readbackVersionId: string;
  readonly readbackIdentitySha256: string;
  readonly observedAt: number;
}

export interface ResolutionOutcomeRecord {
  readonly operationIdSha256: string;
  readonly generation: number;
  readonly claimDigestSha256: string;
  readonly classification: ResolutionOutcomeClassification;
  readonly observationOneDigestSha256: string;
  readonly observationTwoDigestSha256: string;
  readonly resolutionDigestSha256: string;
  readonly resolution: unknown;
  readonly resolvedAt: number;
}

export interface ResolutionTransitionEventRow {
  readonly operation_id_sha256: string;
  readonly event_ordinal: number;
  readonly event_kind:
    | "source_authentication"
    | "source_readback"
    | "mutation_intent"
    | "mutation_outcome"
    | "target_readback";
  readonly event_digest_sha256: string;
  readonly event_json: string;
  readonly recorded_at: number;
}

export interface ResolutionSnapshot {
  readonly classification: ResolutionSnapshotClassification;
  readonly databaseNow: number;
  readonly operation: {
    readonly operationIdSha256: string;
    readonly operationDigestSha256: string;
    readonly executionAuthorityDigestSha256: string;
    readonly readbackVersionId: string;
    readonly readbackIdentitySha256: string;
    readonly mutationIdentitySha256: string;
    readonly createdAt: number;
  } | null;
  readonly journal: {
    readonly headOrdinal: number;
    readonly headDigestSha256: string | null;
    readonly pendingMutationIntentOrdinal: number | null;
    readonly pendingMutationIntentDigestSha256: string | null;
  };
  readonly normalReceipt: {
    readonly receiptDigestSha256: string;
    readonly archivedAt: number;
  } | null;
  readonly claim: ResolutionClaimRecord | null;
  readonly claimExpired: boolean;
  readonly claimable: boolean;
  readonly events: readonly ResolutionTransitionEventRow[];
  readonly observations: readonly ResolutionObservationRecord[];
  readonly outcome: ResolutionOutcomeRecord | null;
}

export interface ResolutionClaimResult {
  readonly classification:
    | "created"
    | "exact_replay"
    | "conflict"
    | "terminal"
    | "not_found";
  readonly claim: ResolutionClaimRecord | null;
}

export interface ResolutionAppendResult {
  readonly classification: "appended" | "exact_replay" | "conflict";
  readonly observation: ResolutionObservationRecord | null;
}

export interface ResolutionFinalizeResult {
  readonly classification: "created" | "exact_replay" | "conflict";
  readonly outcome: ResolutionOutcomeRecord | null;
}

export class ResolutionRepositoryUnavailableError extends Error {
  constructor(readonly outcomeUnknown: boolean) {
    super("deployment resolution repository unavailable");
    this.name = "ResolutionRepositoryUnavailableError";
  }
}

export class ResolutionRepositoryConflictError extends Error {
  constructor(readonly code = "deployment_resolution_operation_conflict") {
    super(code);
    this.name = "ResolutionRepositoryConflictError";
  }
}

export class D1ResolutionRepository {
  constructor(private readonly database: D1Database) {}

  async readSnapshot(
    operationIdSha256: string,
    expectedOperationDigestSha256: string,
  ): Promise<ResolutionSnapshot> {
    digest(operationIdSha256, "resolution operation ID");
    digest(expectedOperationDigestSha256, "resolution operation digest");
    const session = this.database.withSession("first-primary");
    let results: D1Result<Record<string, unknown>>[];
    try {
      results = await session.batch<Record<string, unknown>>([
        session.prepare("SELECT unixepoch() AS database_now"),
        session.prepare(
          `SELECT
             operation.operation_id_sha256,
             operation.operation_digest_sha256,
             operation.created_at,
             authority.authority_digest_sha256,
             authority.readback_version_id,
             authority.readback_identity_sha256,
             authority.mutation_identity_sha256
           FROM json_compatibility_deployment_transition_operations AS operation
           LEFT JOIN json_compatibility_deployment_transition_authorities AS authority
             ON authority.operation_id_sha256 = operation.operation_id_sha256
           WHERE operation.operation_id_sha256 = ?1
           LIMIT 1`,
        ).bind(operationIdSha256),
        session.prepare(
          `SELECT receipt_digest_sha256, archived_at
           FROM json_compatibility_deployment_transition_receipts
           WHERE operation_id_sha256 = ?1
           LIMIT 1`,
        ).bind(operationIdSha256),
        session.prepare(
          `SELECT
             COALESCE((
               SELECT MAX(event_ordinal)
               FROM json_compatibility_deployment_transition_events
               WHERE operation_id_sha256 = ?1
             ), 0) AS head_ordinal,
             (
               SELECT event_digest_sha256
               FROM json_compatibility_deployment_transition_events
               WHERE operation_id_sha256 = ?1
               ORDER BY event_ordinal DESC
               LIMIT 1
             ) AS head_digest_sha256,
             (
               SELECT intent.event_ordinal
               FROM json_compatibility_deployment_transition_events AS intent
               WHERE intent.operation_id_sha256 = ?1
                 AND intent.event_kind = 'mutation_intent'
                 AND NOT EXISTS (
                   SELECT 1
                   FROM json_compatibility_deployment_transition_events AS later
                   WHERE later.operation_id_sha256 = intent.operation_id_sha256
                     AND later.event_ordinal > intent.event_ordinal
                     AND later.event_kind = 'mutation_intent'
                 )
               ORDER BY intent.event_ordinal DESC
               LIMIT 1
             ) AS pending_mutation_intent_ordinal,
             (
               SELECT intent.event_digest_sha256
               FROM json_compatibility_deployment_transition_events AS intent
               WHERE intent.operation_id_sha256 = ?1
                 AND intent.event_kind = 'mutation_intent'
                 AND NOT EXISTS (
                   SELECT 1
                   FROM json_compatibility_deployment_transition_events AS later
                   WHERE later.operation_id_sha256 = intent.operation_id_sha256
                     AND later.event_ordinal > intent.event_ordinal
                     AND later.event_kind = 'mutation_intent'
                 )
               ORDER BY intent.event_ordinal DESC
               LIMIT 1
             ) AS pending_mutation_intent_digest_sha256`,
        ).bind(operationIdSha256),
        session.prepare(
          `SELECT
             operation_id_sha256, event_ordinal, event_kind,
             event_digest_sha256, event_json, recorded_at
           FROM json_compatibility_deployment_transition_events
           WHERE operation_id_sha256 = ?1
           ORDER BY event_ordinal ASC`,
        ).bind(operationIdSha256),
        session.prepare(
          `SELECT ${CLAIM_COLUMNS}
           FROM json_compatibility_deployment_transition_resolution_claims
           WHERE operation_id_sha256 = ?1
           ORDER BY generation DESC
           LIMIT 1`,
        ).bind(operationIdSha256),
        session.prepare(
          `SELECT ${OBSERVATION_COLUMNS}
           FROM json_compatibility_deployment_transition_resolution_observations
           WHERE operation_id_sha256 = ?1
             AND generation = COALESCE((
               SELECT MAX(generation)
               FROM json_compatibility_deployment_transition_resolution_claims
               WHERE operation_id_sha256 = ?1
             ), 0)
           ORDER BY observation_ordinal ASC`,
        ).bind(operationIdSha256),
        session.prepare(
          `SELECT ${OUTCOME_COLUMNS}
           FROM json_compatibility_deployment_transition_resolution_outcomes
           WHERE operation_id_sha256 = ?1
           ORDER BY generation DESC
           LIMIT 1`,
        ).bind(operationIdSha256),
      ]);
    } catch {
      throw new ResolutionRepositoryUnavailableError(false);
    }
    if (results.length !== 8 || results.some((result) => !result.success)) {
      throw new ResolutionRepositoryUnavailableError(false);
    }

    const clockRow = exactlyOneRow(results[0], "resolution database clock");
    const databaseNow = rowInteger(clockRow, "database_now");
    const operationRow = optionalOneRow(results[1], "resolution operation");
    if (operationRow === null) {
      return emptySnapshot(databaseNow);
    }
    const operationDigestSha256 = rowString(
      operationRow,
      "operation_digest_sha256",
    );
    if (operationDigestSha256 !== expectedOperationDigestSha256) {
      throw new ResolutionRepositoryConflictError();
    }

    const operation = {
      operationIdSha256: rowString(operationRow, "operation_id_sha256"),
      operationDigestSha256,
      executionAuthorityDigestSha256: rowString(
        operationRow,
        "authority_digest_sha256",
      ),
      readbackVersionId: rowString(operationRow, "readback_version_id"),
      readbackIdentitySha256: rowString(
        operationRow,
        "readback_identity_sha256",
      ),
      mutationIdentitySha256: rowString(
        operationRow,
        "mutation_identity_sha256",
      ),
      createdAt: rowInteger(operationRow, "created_at"),
    };
    const receiptRow = optionalOneRow(results[2], "normal transition receipt");
    const normalReceipt = receiptRow === null
      ? null
      : {
        receiptDigestSha256: rowString(
          receiptRow,
          "receipt_digest_sha256",
        ),
        archivedAt: rowInteger(receiptRow, "archived_at"),
      };
    const journalRow = exactlyOneRow(results[3], "resolution journal head");
    const journal = {
      headOrdinal: rowInteger(journalRow, "head_ordinal"),
      headDigestSha256: rowNullableString(
        journalRow,
        "head_digest_sha256",
      ),
      pendingMutationIntentOrdinal: rowNullableInteger(
        journalRow,
        "pending_mutation_intent_ordinal",
      ),
      pendingMutationIntentDigestSha256: rowNullableString(
        journalRow,
        "pending_mutation_intent_digest_sha256",
      ),
    };
    const events = results[4].results.map(transitionEventRow);
    validateTransitionEventSequence(events, operation.operationIdSha256);
    const lastEvent = events.at(-1) ?? null;
    if (
      journal.headOrdinal !== events.length
      || journal.headDigestSha256 !== (lastEvent?.event_digest_sha256 ?? null)
    ) {
      throw new ResolutionRepositoryUnavailableError(true);
    }
    const claimRow = optionalOneRow(results[5], "resolution claim");
    const claim = claimRow === null ? null : claimRecord(claimRow);
    const observations = results[6].results.map(observationRecord);
    const outcomeRow = optionalOneRow(results[7], "resolution outcome");
    const outcome = outcomeRow === null ? null : outcomeRecord(outcomeRow);
    if (normalReceipt !== null && outcome !== null) {
      throw new ResolutionRepositoryUnavailableError(true);
    }
    const claimExpired = claim !== null && claim.leaseExpiresAt <= databaseNow;
    const finalResolution = outcome !== null && isFinal(outcome.classification);
    const claimable = normalReceipt === null
      && !finalResolution
      && journal.pendingMutationIntentOrdinal !== null
      && journal.pendingMutationIntentDigestSha256 !== null
      && (claim === null || claimExpired);

    return {
      classification: snapshotClassification(
        normalReceipt !== null,
        claim,
        outcome,
      ),
      databaseNow,
      operation,
      journal,
      normalReceipt,
      claim,
      claimExpired,
      claimable,
      events,
      observations,
      outcome,
    };
  }

  async claim(input: ResolutionClaimInput): Promise<ResolutionClaimResult> {
    validateClaimInput(input);
    const claimJson = boundedCanonicalJson(
      input.claim,
      MAX_CLAIM_BYTES,
      "resolution claim",
    );
    const disabledEvidenceJson = boundedCanonicalJson(
      input.executionDisabledEvidence,
      MAX_EXECUTION_DISABLED_EVIDENCE_BYTES,
      "resolution execution-disabled evidence",
    );
    const session = this.database.withSession("first-primary");
    let inserted = false;
    try {
      const result = await session.prepare(
        `INSERT INTO json_compatibility_deployment_transition_resolution_claims (
           operation_id_sha256, operation_digest_sha256, generation,
           claim_digest_sha256, authorization_digest_sha256,
           resolver_identity_sha256, journal_head_ordinal,
           journal_head_digest_sha256, pending_mutation_intent_ordinal,
           pending_mutation_intent_digest_sha256, expected_target_state_sha256,
           execution_disabled_evidence_digest_sha256,
           execution_disabled_evidence_json, claim_json, quiesced_at,
           settle_not_before, source_authentication_expires_at,
           authorization_expires_at, lease_expires_at, claimed_at
         )
         SELECT
           operation.operation_id_sha256, operation.operation_digest_sha256,
           ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
           ?16, ?17, ?18, unixepoch() + ?19, unixepoch()
         FROM json_compatibility_deployment_transition_operations AS operation
         JOIN json_compatibility_deployment_transition_authorities AS authority
           ON authority.operation_id_sha256 = operation.operation_id_sha256
         WHERE operation.operation_id_sha256 = ?1
           AND operation.operation_digest_sha256 = ?2
           AND authority.mutation_identity_sha256 <> ?6
           AND ?3 = COALESCE((
             SELECT MAX(generation) + 1
             FROM json_compatibility_deployment_transition_resolution_claims
             WHERE operation_id_sha256 = ?1
           ), 1)
           AND NOT EXISTS (
             SELECT 1
             FROM json_compatibility_deployment_transition_receipts
             WHERE operation_id_sha256 = ?1
           )
           AND NOT EXISTS (
             SELECT 1
             FROM json_compatibility_deployment_transition_resolution_outcomes
             WHERE operation_id_sha256 = ?1
               AND classification IN (
                 'target_confirmed', 'manual_review_required'
               )
           )
           AND NOT EXISTS (
             SELECT 1
             FROM json_compatibility_deployment_transition_resolution_claims
             WHERE operation_id_sha256 = ?1
               AND lease_expires_at > unixepoch()
           )
           AND ?7 = (
             SELECT COUNT(*)
             FROM json_compatibility_deployment_transition_events
             WHERE operation_id_sha256 = ?1
           )
           AND ?7 = COALESCE((
             SELECT MAX(event_ordinal)
             FROM json_compatibility_deployment_transition_events
             WHERE operation_id_sha256 = ?1
           ), 0)
           AND ?8 = (
             SELECT event_digest_sha256
             FROM json_compatibility_deployment_transition_events
             WHERE operation_id_sha256 = ?1
             ORDER BY event_ordinal DESC
             LIMIT 1
           )
           AND EXISTS (
             SELECT 1
             FROM json_compatibility_deployment_transition_events
             WHERE operation_id_sha256 = ?1
               AND event_ordinal = ?9
               AND event_kind = 'mutation_intent'
               AND event_digest_sha256 = ?10
           )
           AND NOT EXISTS (
             SELECT 1
             FROM json_compatibility_deployment_transition_events
             WHERE operation_id_sha256 = ?1
               AND event_ordinal > ?9
               AND event_kind = 'mutation_intent'
           )
           AND ?15 <= unixepoch()
           AND ?16 <= unixepoch()
           AND unixepoch() + ?19 <= ?17
           AND unixepoch() + ?19 <= ?18`,
      ).bind(
        input.operationIdSha256,
        input.operationDigestSha256,
        input.generation,
        input.claimDigestSha256,
        input.authorizationDigestSha256,
        input.resolverIdentitySha256,
        input.journalHeadOrdinal,
        input.journalHeadDigestSha256,
        input.pendingMutationIntentOrdinal,
        input.pendingMutationIntentDigestSha256,
        input.expectedTargetStateSha256,
        input.executionDisabledEvidenceDigestSha256,
        disabledEvidenceJson,
        claimJson,
        input.quiescedAt,
        input.settleNotBefore,
        input.sourceAuthenticationExpiresAt,
        input.authorizationExpiresAt,
        input.claimLeaseSeconds,
      ).run();
      inserted = result.success === true && result.meta.changes > 0;
    } catch {
      inserted = false;
    }

    const persisted = await readClaim(
      session,
      input.operationIdSha256,
      input.generation,
    );
    if (persisted !== null) {
      if (!claimMatches(persisted, input, claimJson, disabledEvidenceJson)) {
        return { classification: "conflict", claim: null };
      }
      return {
        classification: inserted ? "created" : "exact_replay",
        claim: claimRecord(persisted),
      };
    }

    const snapshot = await this.readSnapshot(
      input.operationIdSha256,
      input.operationDigestSha256,
    );
    if (snapshot.classification === "not_found") {
      return { classification: "not_found", claim: null };
    }
    if (
      snapshot.classification === "terminal_receipt"
      || snapshot.classification === "final_resolution"
    ) {
      return { classification: "terminal", claim: null };
    }
    return { classification: "conflict", claim: null };
  }

  async appendObservation(
    input: ResolutionObservationInput,
  ): Promise<ResolutionAppendResult> {
    validateObservationInput(input);
    const requestJson = boundedCanonicalJson(
      input.request,
      MAX_READBACK_REQUEST_BYTES,
      "resolution readback request",
    );
    const observationJson = boundedCanonicalJson(
      input.observation,
      MAX_OBSERVATION_BYTES,
      "resolution observation",
    );
    const session = this.database.withSession("first-primary");
    let inserted = false;
    try {
      const result = await session.prepare(
        `INSERT INTO json_compatibility_deployment_transition_resolution_observations (
           operation_id_sha256, generation, observation_ordinal,
           claim_digest_sha256, request_digest_sha256, request_json,
           observation_digest_sha256, observation_json,
           observed_state_sha256, readback_version_id,
           readback_identity_sha256, observed_at
         )
         SELECT
           claim.operation_id_sha256, claim.generation, ?5,
           claim.claim_digest_sha256, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
           unixepoch()
         FROM json_compatibility_deployment_transition_resolution_claims AS claim
         JOIN json_compatibility_deployment_transition_operations AS operation
           ON operation.operation_id_sha256 = claim.operation_id_sha256
         JOIN json_compatibility_deployment_transition_authorities AS authority
           ON authority.operation_id_sha256 = claim.operation_id_sha256
         WHERE claim.operation_id_sha256 = ?1
           AND operation.operation_digest_sha256 = ?2
           AND claim.generation = ?3
           AND claim.claim_digest_sha256 = ?4
           AND claim.generation = (
             SELECT MAX(generation)
             FROM json_compatibility_deployment_transition_resolution_claims
             WHERE operation_id_sha256 = ?1
           )
           AND authority.readback_version_id = ?11
           AND authority.readback_identity_sha256 = ?12
           AND unixepoch() >= claim.settle_not_before
           AND unixepoch() < claim.lease_expires_at
           AND NOT EXISTS (
             SELECT 1
             FROM json_compatibility_deployment_transition_resolution_outcomes
             WHERE operation_id_sha256 = ?1
               AND generation = ?3
           )
           AND (
             (
               ?5 = 1
               AND NOT EXISTS (
                 SELECT 1
                 FROM json_compatibility_deployment_transition_resolution_observations
                 WHERE operation_id_sha256 = ?1
                   AND generation = ?3
               )
             )
             OR (
               ?5 = 2
               AND EXISTS (
                 SELECT 1
                 FROM json_compatibility_deployment_transition_resolution_observations
                 WHERE operation_id_sha256 = ?1
                   AND generation = ?3
                   AND observation_ordinal = 1
                   AND observed_at <= unixepoch() - ?13
               )
               AND NOT EXISTS (
                 SELECT 1
                 FROM json_compatibility_deployment_transition_resolution_observations
                 WHERE operation_id_sha256 = ?1
                   AND generation = ?3
                   AND observation_ordinal = 2
               )
             )
           )`,
      ).bind(
        input.operationIdSha256,
        input.operationDigestSha256,
        input.generation,
        input.claimDigestSha256,
        input.observationOrdinal,
        input.requestDigestSha256,
        requestJson,
        input.observationDigestSha256,
        observationJson,
        input.observedStateSha256,
        input.readbackVersionId,
        input.readbackIdentitySha256,
        MINIMUM_OBSERVATION_SPACING_SECONDS,
      ).run();
      inserted = result.success === true && result.meta.changes > 0;
    } catch {
      inserted = false;
    }

    const persisted = await readObservation(
      session,
      input.operationIdSha256,
      input.generation,
      input.observationOrdinal,
    );
    if (persisted === null) {
      return { classification: "conflict", observation: null };
    }
    if (!observationMatches(persisted, input, requestJson, observationJson)) {
      return { classification: "conflict", observation: null };
    }
    return {
      classification: inserted ? "appended" : "exact_replay",
      observation: observationRecord(persisted),
    };
  }

  async finalize(
    input: ResolutionFinalizeInput,
  ): Promise<ResolutionFinalizeResult> {
    validateFinalizeInput(input);
    const resolutionJson = boundedCanonicalJson(
      input.resolution,
      MAX_RESOLUTION_BYTES,
      "deployment resolution",
    );
    const session = this.database.withSession("first-primary");
    let inserted = false;
    try {
      const result = await session.prepare(
        `INSERT INTO json_compatibility_deployment_transition_resolution_outcomes (
           operation_id_sha256, generation, claim_digest_sha256,
           classification, observation_one_digest_sha256,
           observation_two_digest_sha256, resolution_digest_sha256,
           resolution_json, resolved_at
         )
         SELECT
           claim.operation_id_sha256, claim.generation,
           claim.claim_digest_sha256, ?5, ?6, ?7, ?8, ?9, unixepoch()
         FROM json_compatibility_deployment_transition_resolution_claims AS claim
         JOIN json_compatibility_deployment_transition_operations AS operation
           ON operation.operation_id_sha256 = claim.operation_id_sha256
         WHERE claim.operation_id_sha256 = ?1
           AND operation.operation_digest_sha256 = ?2
           AND claim.generation = ?3
           AND claim.claim_digest_sha256 = ?4
           AND claim.generation = (
             SELECT MAX(generation)
             FROM json_compatibility_deployment_transition_resolution_claims
             WHERE operation_id_sha256 = ?1
           )
           AND unixepoch() >= claim.settle_not_before
           AND unixepoch() < claim.lease_expires_at
           AND NOT EXISTS (
             SELECT 1
             FROM json_compatibility_deployment_transition_receipts
             WHERE operation_id_sha256 = ?1
           )
           AND NOT EXISTS (
             SELECT 1
             FROM json_compatibility_deployment_transition_resolution_outcomes
             WHERE operation_id_sha256 = ?1
               AND classification IN (
                 'target_confirmed', 'manual_review_required'
               )
           )`,
      ).bind(
        input.operationIdSha256,
        input.operationDigestSha256,
        input.generation,
        input.claimDigestSha256,
        input.classification,
        input.observationOneDigestSha256,
        input.observationTwoDigestSha256,
        input.resolutionDigestSha256,
        resolutionJson,
      ).run();
      inserted = result.success === true && result.meta.changes > 0;
    } catch {
      inserted = false;
    }

    const persisted = await readOutcome(
      session,
      input.operationIdSha256,
      input.generation,
    );
    if (persisted === null) {
      return { classification: "conflict", outcome: null };
    }
    if (!outcomeMatches(persisted, input, resolutionJson)) {
      return { classification: "conflict", outcome: null };
    }
    return {
      classification: inserted ? "created" : "exact_replay",
      outcome: outcomeRecord(persisted),
    };
  }
}

async function readClaim(
  session: D1DatabaseSession,
  operationIdSha256: string,
  generation: number,
): Promise<Record<string, unknown> | null> {
  try {
    return await session.prepare(
      `SELECT ${CLAIM_COLUMNS}
       FROM json_compatibility_deployment_transition_resolution_claims
       WHERE operation_id_sha256 = ?1 AND generation = ?2
       LIMIT 1`,
    ).bind(operationIdSha256, generation).first<Record<string, unknown>>();
  } catch {
    throw new ResolutionRepositoryUnavailableError(true);
  }
}

async function readObservation(
  session: D1DatabaseSession,
  operationIdSha256: string,
  generation: number,
  observationOrdinal: 1 | 2,
): Promise<Record<string, unknown> | null> {
  try {
    return await session.prepare(
      `SELECT observation.*,
              claim.operation_digest_sha256 AS operation_digest_sha256
       FROM json_compatibility_deployment_transition_resolution_observations
         AS observation
       JOIN json_compatibility_deployment_transition_resolution_claims AS claim
         ON claim.operation_id_sha256 = observation.operation_id_sha256
         AND claim.generation = observation.generation
       WHERE observation.operation_id_sha256 = ?1
         AND observation.generation = ?2
         AND observation.observation_ordinal = ?3
       LIMIT 1`,
    ).bind(
      operationIdSha256,
      generation,
      observationOrdinal,
    ).first<Record<string, unknown>>();
  } catch {
    throw new ResolutionRepositoryUnavailableError(true);
  }
}

async function readOutcome(
  session: D1DatabaseSession,
  operationIdSha256: string,
  generation: number,
): Promise<Record<string, unknown> | null> {
  try {
    return await session.prepare(
      `SELECT outcome.*,
              claim.operation_digest_sha256 AS operation_digest_sha256
       FROM json_compatibility_deployment_transition_resolution_outcomes AS outcome
       JOIN json_compatibility_deployment_transition_resolution_claims AS claim
         ON claim.operation_id_sha256 = outcome.operation_id_sha256
         AND claim.generation = outcome.generation
       WHERE outcome.operation_id_sha256 = ?1 AND outcome.generation = ?2
       LIMIT 1`,
    ).bind(operationIdSha256, generation).first<Record<string, unknown>>();
  } catch {
    throw new ResolutionRepositoryUnavailableError(true);
  }
}

function claimRecord(row: Record<string, unknown>): ResolutionClaimRecord {
  return {
    operationIdSha256: rowString(row, "operation_id_sha256"),
    operationDigestSha256: rowString(row, "operation_digest_sha256"),
    generation: rowInteger(row, "generation"),
    claimDigestSha256: rowString(row, "claim_digest_sha256"),
    authorizationDigestSha256: rowString(
      row,
      "authorization_digest_sha256",
    ),
    resolverIdentitySha256: rowString(row, "resolver_identity_sha256"),
    journalHeadOrdinal: rowInteger(row, "journal_head_ordinal"),
    journalHeadDigestSha256: rowString(row, "journal_head_digest_sha256"),
    pendingMutationIntentOrdinal: rowInteger(
      row,
      "pending_mutation_intent_ordinal",
    ),
    pendingMutationIntentDigestSha256: rowString(
      row,
      "pending_mutation_intent_digest_sha256",
    ),
    expectedTargetStateSha256: rowString(
      row,
      "expected_target_state_sha256",
    ),
    executionDisabledEvidenceDigestSha256: rowString(
      row,
      "execution_disabled_evidence_digest_sha256",
    ),
    executionDisabledEvidence: parseCanonicalJson(
      rowString(row, "execution_disabled_evidence_json"),
      MAX_EXECUTION_DISABLED_EVIDENCE_BYTES,
      "persisted resolution execution-disabled evidence",
    ),
    claim: parseCanonicalJson(
      rowString(row, "claim_json"),
      MAX_CLAIM_BYTES,
      "persisted resolution claim",
    ),
    quiescedAt: rowInteger(row, "quiesced_at"),
    settleNotBefore: rowInteger(row, "settle_not_before"),
    sourceAuthenticationExpiresAt: rowInteger(
      row,
      "source_authentication_expires_at",
    ),
    authorizationExpiresAt: rowInteger(row, "authorization_expires_at"),
    leaseExpiresAt: rowInteger(row, "lease_expires_at"),
    claimedAt: rowInteger(row, "claimed_at"),
  };
}

function observationRecord(
  row: Record<string, unknown>,
): ResolutionObservationRecord {
  const ordinal = rowInteger(row, "observation_ordinal");
  if (ordinal !== 1 && ordinal !== 2) {
    throw new ResolutionRepositoryUnavailableError(true);
  }
  return {
    operationIdSha256: rowString(row, "operation_id_sha256"),
    generation: rowInteger(row, "generation"),
    observationOrdinal: ordinal,
    claimDigestSha256: rowString(row, "claim_digest_sha256"),
    requestDigestSha256: rowString(row, "request_digest_sha256"),
    request: parseCanonicalJson(
      rowString(row, "request_json"),
      MAX_READBACK_REQUEST_BYTES,
      "persisted resolution readback request",
    ),
    observationDigestSha256: rowString(
      row,
      "observation_digest_sha256",
    ),
    observation: parseCanonicalJson(
      rowString(row, "observation_json"),
      MAX_OBSERVATION_BYTES,
      "persisted resolution observation",
    ),
    observedStateSha256: rowString(row, "observed_state_sha256"),
    readbackVersionId: rowString(row, "readback_version_id"),
    readbackIdentitySha256: rowString(row, "readback_identity_sha256"),
    observedAt: rowInteger(row, "observed_at"),
  };
}

function outcomeRecord(row: Record<string, unknown>): ResolutionOutcomeRecord {
  const classification = outcomeClassification(
    rowString(row, "classification"),
  );
  return {
    operationIdSha256: rowString(row, "operation_id_sha256"),
    generation: rowInteger(row, "generation"),
    claimDigestSha256: rowString(row, "claim_digest_sha256"),
    classification,
    observationOneDigestSha256:
      rowString(row, "observation_one_digest_sha256"),
    observationTwoDigestSha256:
      rowString(row, "observation_two_digest_sha256"),
    resolutionDigestSha256: rowString(row, "resolution_digest_sha256"),
    resolution: parseCanonicalJson(
      rowString(row, "resolution_json"),
      MAX_RESOLUTION_BYTES,
      "persisted deployment resolution",
    ),
    resolvedAt: rowInteger(row, "resolved_at"),
  };
}

function claimMatches(
  row: Record<string, unknown>,
  input: ResolutionClaimInput,
  claimJson: string,
  disabledEvidenceJson: string,
): boolean {
  return row.operation_id_sha256 === input.operationIdSha256
    && row.operation_digest_sha256 === input.operationDigestSha256
    && row.generation === input.generation
    && row.claim_digest_sha256 === input.claimDigestSha256
    && row.authorization_digest_sha256 === input.authorizationDigestSha256
    && row.resolver_identity_sha256 === input.resolverIdentitySha256
    && row.journal_head_ordinal === input.journalHeadOrdinal
    && row.journal_head_digest_sha256 === input.journalHeadDigestSha256
    && row.pending_mutation_intent_ordinal
      === input.pendingMutationIntentOrdinal
    && row.pending_mutation_intent_digest_sha256
      === input.pendingMutationIntentDigestSha256
    && row.expected_target_state_sha256 === input.expectedTargetStateSha256
    && row.execution_disabled_evidence_digest_sha256
      === input.executionDisabledEvidenceDigestSha256
    && row.execution_disabled_evidence_json === disabledEvidenceJson
    && row.claim_json === claimJson
    && row.quiesced_at === input.quiescedAt
    && row.settle_not_before === input.settleNotBefore
    && row.source_authentication_expires_at
      === input.sourceAuthenticationExpiresAt
    && row.authorization_expires_at === input.authorizationExpiresAt
    && typeof row.claimed_at === "number"
    && row.lease_expires_at
      === row.claimed_at + input.claimLeaseSeconds;
}

function observationMatches(
  row: Record<string, unknown>,
  input: ResolutionObservationInput,
  requestJson: string,
  observationJson: string,
): boolean {
  return row.operation_id_sha256 === input.operationIdSha256
    && row.operation_digest_sha256 === input.operationDigestSha256
    && row.generation === input.generation
    && row.observation_ordinal === input.observationOrdinal
    && row.claim_digest_sha256 === input.claimDigestSha256
    && row.request_digest_sha256 === input.requestDigestSha256
    && row.request_json === requestJson
    && row.observation_digest_sha256 === input.observationDigestSha256
    && row.observation_json === observationJson
    && row.observed_state_sha256 === input.observedStateSha256
    && row.readback_version_id === input.readbackVersionId
    && row.readback_identity_sha256 === input.readbackIdentitySha256;
}

function outcomeMatches(
  row: Record<string, unknown>,
  input: ResolutionFinalizeInput,
  resolutionJson: string,
): boolean {
  return row.operation_id_sha256 === input.operationIdSha256
    && row.operation_digest_sha256 === input.operationDigestSha256
    && row.generation === input.generation
    && row.claim_digest_sha256 === input.claimDigestSha256
    && row.classification === input.classification
    && row.observation_one_digest_sha256
      === input.observationOneDigestSha256
    && row.observation_two_digest_sha256
      === input.observationTwoDigestSha256
    && row.resolution_digest_sha256 === input.resolutionDigestSha256
    && row.resolution_json === resolutionJson;
}

function validateClaimInput(input: ResolutionClaimInput): void {
  for (const [label, value] of [
    ["operation ID", input.operationIdSha256],
    ["operation digest", input.operationDigestSha256],
    ["claim digest", input.claimDigestSha256],
    ["authorization digest", input.authorizationDigestSha256],
    ["resolver identity", input.resolverIdentitySha256],
    ["journal head digest", input.journalHeadDigestSha256],
    ["pending mutation intent", input.pendingMutationIntentDigestSha256],
    ["expected target state", input.expectedTargetStateSha256],
    ["execution-disabled evidence",
      input.executionDisabledEvidenceDigestSha256],
  ] as const) digest(value, `resolution ${label}`);
  positiveInteger(input.generation, "resolution generation");
  positiveInteger(input.journalHeadOrdinal, "resolution journal head ordinal");
  positiveInteger(
    input.pendingMutationIntentOrdinal,
    "resolution pending mutation intent ordinal",
  );
  if (input.pendingMutationIntentOrdinal > input.journalHeadOrdinal) {
    throw new Error("resolution pending mutation intent follows journal head");
  }
  timestamp(input.quiescedAt, "resolution quiescence time");
  timestamp(input.settleNotBefore, "resolution settle time");
  timestamp(
    input.sourceAuthenticationExpiresAt,
    "resolution source authentication expiry",
  );
  timestamp(input.authorizationExpiresAt, "resolution authorization expiry");
  if (input.quiescedAt >= input.settleNotBefore) {
    throw new Error("resolution claim time window is invalid");
  }
  if (input.claimLeaseSeconds !== CLAIM_LEASE_SECONDS) {
    throw new Error("resolution claim lease is invalid");
  }
  if (
    input.settleNotBefore + input.claimLeaseSeconds
      > input.sourceAuthenticationExpiresAt
    || input.settleNotBefore + input.claimLeaseSeconds
      > input.authorizationExpiresAt
  ) {
    throw new Error("resolution claim lease exceeds signed authority");
  }
  if (
    input.claimDigestSha256 === input.authorizationDigestSha256
    || input.claimDigestSha256 === input.resolverIdentitySha256
    || input.authorizationDigestSha256 === input.resolverIdentitySha256
  ) {
    throw new Error("resolution claim digest domains are not independent");
  }
  requireJsonObject(input.claim, "resolution claim");
  requireJsonObject(
    input.executionDisabledEvidence,
    "resolution execution-disabled evidence",
  );
  if (
    input.executionDisabledEvidence.evidenceSha256
      !== input.executionDisabledEvidenceDigestSha256
    || input.executionDisabledEvidence.executionDisabledAt !== input.quiescedAt
    || input.executionDisabledEvidence.quiescenceSatisfiedAt
      !== input.settleNotBefore
  ) {
    throw new Error(
      "resolution execution-disabled evidence is not claim-bound",
    );
  }
}

function validateObservationInput(input: ResolutionObservationInput): void {
  for (const [label, value] of [
    ["operation ID", input.operationIdSha256],
    ["operation digest", input.operationDigestSha256],
    ["claim digest", input.claimDigestSha256],
    ["request digest", input.requestDigestSha256],
    ["observation digest", input.observationDigestSha256],
    ["observed state", input.observedStateSha256],
    ["readback identity", input.readbackIdentitySha256],
  ] as const) digest(value, `resolution observation ${label}`);
  positiveInteger(input.generation, "resolution observation generation");
  if (input.observationOrdinal !== 1 && input.observationOrdinal !== 2) {
    throw new Error("resolution observation ordinal is invalid");
  }
  if (input.requestDigestSha256 === input.observationDigestSha256) {
    throw new Error("resolution request and observation digests must differ");
  }
  token(input.readbackVersionId, "resolution readback version");
  requireJsonObject(input.request, "resolution readback request");
  const request = input.request;
  const observation =
    validateJsonCompatibilityDeploymentTransitionReadback(input.observation);
  if (
    request.phase !== "target"
    || request.observationOrdinal !== input.observationOrdinal
    || request.readbackRequestSha256 !== input.requestDigestSha256
    || observation.readbackRequestSha256 !== input.requestDigestSha256
    || observation.observationDigestSha256
      !== input.observationDigestSha256
    || observation.readbackServiceIdentitySha256
      !== input.readbackIdentitySha256
    || (observation.remoteStateSha256 ?? observation.observationDigestSha256)
      !== input.observedStateSha256
  ) {
    throw new Error("resolution observation columns are not payload-bound");
  }
}

function validateFinalizeInput(input: ResolutionFinalizeInput): void {
  for (const [label, value] of [
    ["operation ID", input.operationIdSha256],
    ["operation digest", input.operationDigestSha256],
    ["claim digest", input.claimDigestSha256],
    ["resolution digest", input.resolutionDigestSha256],
  ] as const) digest(value, `resolution outcome ${label}`);
  positiveInteger(input.generation, "resolution outcome generation");
  outcomeClassification(input.classification);
  digest(input.observationOneDigestSha256, "resolution first observation");
  digest(input.observationTwoDigestSha256, "resolution second observation");
  if (input.observationOneDigestSha256 === input.observationTwoDigestSha256) {
    throw new Error("resolution observations are not independent");
  }
  requireJsonObject(input.resolution, "deployment resolution");
  const resolution = input.resolution;
  const targetReadbacks = resolution.targetReadbacks;
  if (
    resolution.operationIdSha256 !== input.operationIdSha256
    || resolution.operationDigestSha256 !== input.operationDigestSha256
    || resolution.claimGeneration !== input.generation
    || resolution.classification !== input.classification
    || resolution.resolutionReceiptSha256 !== input.resolutionDigestSha256
    || !Array.isArray(targetReadbacks)
    || targetReadbacks.length !== 2
    || targetReadbacks[0]?.observationDigestSha256
      !== input.observationOneDigestSha256
    || targetReadbacks[1]?.observationDigestSha256
      !== input.observationTwoDigestSha256
  ) {
    throw new Error("resolution outcome columns are not payload-bound");
  }
}

function snapshotClassification(
  hasNormalReceipt: boolean,
  claim: ResolutionClaimRecord | null,
  outcome: ResolutionOutcomeRecord | null,
): ResolutionSnapshotClassification {
  if (hasNormalReceipt) return "terminal_receipt";
  if (outcome !== null && isFinal(outcome.classification)) {
    return "final_resolution";
  }
  if (
    claim !== null
    && (outcome === null || claim.generation > outcome.generation)
  ) {
    return "resolution_claimed";
  }
  if (outcome?.classification === "readback_inconclusive") {
    return "readback_inconclusive";
  }
  if (claim !== null) return "resolution_claimed";
  return "inflight";
}

function emptySnapshot(databaseNow: number): ResolutionSnapshot {
  return {
    classification: "not_found",
    databaseNow,
    operation: null,
    journal: {
      headOrdinal: 0,
      headDigestSha256: null,
      pendingMutationIntentOrdinal: null,
      pendingMutationIntentDigestSha256: null,
    },
    normalReceipt: null,
    claim: null,
    claimExpired: false,
    claimable: false,
    events: [],
    observations: [],
    outcome: null,
  };
}

function isFinal(classification: ResolutionOutcomeClassification): boolean {
  return classification === "target_confirmed"
    || classification === "manual_review_required";
}

function transitionEventRow(
  row: Record<string, unknown>,
): ResolutionTransitionEventRow {
  const kind = rowString(row, "event_kind");
  if (
    kind !== "source_authentication"
    && kind !== "source_readback"
    && kind !== "mutation_intent"
    && kind !== "mutation_outcome"
    && kind !== "target_readback"
  ) {
    throw new ResolutionRepositoryUnavailableError(true);
  }
  const eventJson = rowString(row, "event_json");
  parseCanonicalJson(
    eventJson,
    MAX_TRANSITION_EVENT_BYTES,
    "persisted transition event",
  );
  const eventDigestSha256 = rowString(row, "event_digest_sha256");
  digest(eventDigestSha256, "persisted transition event digest");
  return {
    operation_id_sha256: rowString(row, "operation_id_sha256"),
    event_ordinal: rowInteger(row, "event_ordinal"),
    event_kind: kind,
    event_digest_sha256: eventDigestSha256,
    event_json: eventJson,
    recorded_at: rowInteger(row, "recorded_at"),
  };
}

function validateTransitionEventSequence(
  events: readonly ResolutionTransitionEventRow[],
  operationIdSha256: string,
): void {
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (
      event === undefined
      || event.operation_id_sha256 !== operationIdSha256
      || event.event_ordinal !== index + 1
    ) {
      throw new ResolutionRepositoryUnavailableError(true);
    }
  }
}

function outcomeClassification(value: string): ResolutionOutcomeClassification {
  if (
    value === "target_confirmed"
    || value === "manual_review_required"
    || value === "readback_inconclusive"
  ) return value;
  throw new ResolutionRepositoryUnavailableError(true);
}

function exactlyOneRow(
  result: D1Result<Record<string, unknown>>,
  label: string,
): Record<string, unknown> {
  if (result.results.length !== 1) {
    throw new ResolutionRepositoryUnavailableError(false);
  }
  const row = result.results[0];
  if (row === undefined) {
    throw new Error(`${label} is unavailable`);
  }
  return row;
}

function optionalOneRow(
  result: D1Result<Record<string, unknown>>,
  _label: string,
): Record<string, unknown> | null {
  if (result.results.length > 1) {
    throw new ResolutionRepositoryUnavailableError(false);
  }
  return result.results[0] ?? null;
}

function rowString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new ResolutionRepositoryUnavailableError(true);
  }
  return value;
}

function rowNullableString(
  row: Record<string, unknown>,
  key: string,
): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new ResolutionRepositoryUnavailableError(true);
  }
  return value;
}

function rowInteger(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ResolutionRepositoryUnavailableError(true);
  }
  return value;
}

function rowNullableInteger(
  row: Record<string, unknown>,
  key: string,
): number | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ResolutionRepositoryUnavailableError(true);
  }
  return value;
}

function boundedCanonicalJson(
  value: unknown,
  maximumBytes: number,
  label: string,
): string {
  const text = canonicalJson(value);
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes < 2 || bytes > maximumBytes) {
    throw new Error(`${label} is outside its byte limit`);
  }
  return text;
}

function parseCanonicalJson(
  text: string,
  maximumBytes: number,
  label: string,
): unknown {
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes < 2 || bytes > maximumBytes) {
    throw new ResolutionRepositoryUnavailableError(true);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
    if (canonicalJson(value) !== text) {
      throw new Error(`${label} is not canonical`);
    }
  } catch {
    throw new ResolutionRepositoryUnavailableError(true);
  }
  return value;
}

function digest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} is invalid`);
  }
}

function token(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_TOKEN.test(value)) {
    throw new Error(`${label} is invalid`);
  }
}

function positiveInteger(value: unknown, label: string): asserts value is number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 1
  ) {
    throw new Error(`${label} is invalid`);
  }
}

function timestamp(value: unknown, label: string): asserts value is number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
  ) {
    throw new Error(`${label} is invalid`);
  }
}

function requireJsonObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
}
