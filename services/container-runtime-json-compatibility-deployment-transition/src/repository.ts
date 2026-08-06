import type {
  JsonCompatibilityDeploymentTransitionJournalEventV1,
  JsonCompatibilityDeploymentTransitionOperationV1,
  JsonCompatibilityDeploymentTransitionReceiptV1,
} from "../../../tools/container_runtime_json_compatibility_deployment_transition.mjs";
import {
  validateJsonCompatibilityDeploymentResolutionReceipt,
  type JsonCompatibilityDeploymentResolutionReceiptV1,
} from "../../../tools/container_runtime_json_compatibility_deployment_resolution.mjs";

import { canonicalJson } from "./canonical";

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_OPERATION_BYTES = 8 * 1024;
const MAX_AUTHORITY_BYTES = 32 * 1024;
const MAX_EVENT_BYTES = 128 * 1024;
const MAX_RECEIPT_BYTES = 512 * 1024;

const OPERATION_COLUMNS = `
  operation_id_sha256, operation_digest_sha256,
  authorized_request_sha256, campaign_plan_digest_sha256,
  state_plan_digest_sha256, transition_id, operation_json,
  coordinator_version_id, coordinator_profile_version,
  deployment_leaf_service_name, source_verifier_service_name, created_at
`;

const EVENT_COLUMNS = `
  operation_id_sha256, event_ordinal, event_kind, event_digest_sha256,
  event_json, recorded_at
`;

const AUTHORITY_COLUMNS = `
  operation_id_sha256, authority_digest_sha256, authority_json,
  coordinator_service_name, coordinator_version_id,
  coordinator_identity_sha256, source_verifier_service_name,
  source_verifier_version_id, source_verifier_identity_sha256,
  readback_service_name, readback_version_id, readback_identity_sha256,
  readback_credential_id_sha256, mutation_service_name,
  mutation_version_id, mutation_identity_sha256,
  mutation_credential_id_sha256, created_at
`;

const RECEIPT_COLUMNS = `
  operation_id_sha256, receipt_digest_sha256, result, receipt_json,
  archived_at
`;

const RESOLUTION_COLUMNS = `
  operation_id_sha256, generation, classification,
  resolution_digest_sha256, resolution_json, resolved_at
`;

interface OperationRow {
  readonly operation_id_sha256: string;
  readonly operation_digest_sha256: string;
  readonly authorized_request_sha256: string;
  readonly campaign_plan_digest_sha256: string;
  readonly state_plan_digest_sha256: string;
  readonly transition_id: string;
  readonly operation_json: string;
  readonly coordinator_version_id: string;
  readonly coordinator_profile_version: number;
  readonly deployment_leaf_service_name: string;
  readonly source_verifier_service_name: string;
  readonly created_at: number;
}

export interface TransitionEventRow {
  readonly operation_id_sha256: string;
  readonly event_ordinal: number;
  readonly event_kind: string;
  readonly event_digest_sha256: string;
  readonly event_json: string;
  readonly recorded_at: number;
}

interface ReceiptRow {
  readonly operation_id_sha256: string;
  readonly receipt_digest_sha256: string;
  readonly result: "completed" | "stopped";
  readonly receipt_json: string;
  readonly archived_at: number;
}

interface ResolutionRow {
  readonly operation_id_sha256: string;
  readonly generation: number;
  readonly classification:
    | "target_confirmed"
    | "manual_review_required"
    | "readback_inconclusive";
  readonly resolution_digest_sha256: string;
  readonly resolution_json: string;
  readonly resolved_at: number;
}

interface AuthorityRow {
  readonly operation_id_sha256: string;
  readonly authority_digest_sha256: string;
  readonly authority_json: string;
  readonly coordinator_service_name: string;
  readonly coordinator_version_id: string;
  readonly coordinator_identity_sha256: string;
  readonly source_verifier_service_name: string;
  readonly source_verifier_version_id: string;
  readonly source_verifier_identity_sha256: string;
  readonly readback_service_name: string;
  readonly readback_version_id: string;
  readonly readback_identity_sha256: string;
  readonly readback_credential_id_sha256: string;
  readonly mutation_service_name: string;
  readonly mutation_version_id: string;
  readonly mutation_identity_sha256: string;
  readonly mutation_credential_id_sha256: string;
  readonly created_at: number;
}

type TransitionStatusRow =
  | OperationRow
  | AuthorityRow
  | TransitionEventRow
  | ReceiptRow
  | ResolutionRow;

interface RepositoryServiceAuthority {
  readonly serviceName: string;
  readonly versionId: string;
  readonly identitySha256: string;
  readonly credentialIdSha256: string | null;
}

interface RepositoryExecutionAuthority {
  readonly authorityDigestSha256: string;
  readonly coordinator: RepositoryServiceAuthority;
  readonly sourceVerifier: RepositoryServiceAuthority;
  readonly readback: RepositoryServiceAuthority;
  readonly mutation: RepositoryServiceAuthority;
}

export interface TransitionRepositoryIdentity {
  readonly coordinatorServiceName: string;
  readonly coordinatorVersionId: string;
  readonly coordinatorProfileVersion: 1;
  readonly deploymentReadbackServiceName: string;
  readonly deploymentMutationServiceName: string;
  readonly sourceVerifierServiceName: string;
  readonly executionAuthority: RepositoryExecutionAuthority;
}

export interface TransitionStatusSnapshot {
  readonly classification: "not_found" | "inflight" | "terminal" | "resolved";
  readonly operation: {
    readonly operationIdSha256: string;
    readonly operationDigestSha256: string;
    readonly authorizedRequestSha256: string;
    readonly campaignPlanDigestSha256: string;
    readonly statePlanDigestSha256: string;
    readonly transitionId: string;
    readonly coordinatorVersionId: string;
    readonly coordinatorProfileVersion: number;
    readonly executionAuthoritySha256: string;
    readonly deploymentReadbackServiceName: string;
    readonly deploymentMutationServiceName: string;
    readonly sourceVerifierServiceName: string;
    readonly createdAt: number;
  } | null;
  readonly events: readonly TransitionEventRow[];
  readonly receipt: JsonCompatibilityDeploymentTransitionReceiptV1 | null;
  readonly archivedAt: number | null;
  readonly resolution: JsonCompatibilityDeploymentResolutionReceiptV1 | null;
  readonly resolvedAt: number | null;
}

export class TransitionRepositoryUnavailableError extends Error {
  constructor(readonly outcomeUnknown: boolean) {
    super("transition repository unavailable");
    this.name = "TransitionRepositoryUnavailableError";
  }
}

export class TransitionRepositoryConflictError extends Error {
  constructor(readonly code = "transition_operation_conflict") {
    super(code);
    this.name = "TransitionRepositoryConflictError";
  }
}

export class D1DeploymentTransitionJournal {
  private operationIdSha256: string | null = null;

  constructor(
    private readonly database: D1Database,
    private readonly identity: TransitionRepositoryIdentity,
  ) {}

  async reserve(
    operation: JsonCompatibilityDeploymentTransitionOperationV1,
  ): Promise<{
    readonly classification:
      | "reserved"
      | "exact_replay"
      | "inflight"
      | "conflict";
    readonly receipt: JsonCompatibilityDeploymentTransitionReceiptV1 | null;
  }> {
    validateOperation(operation);
    validateRepositoryIdentity(this.identity);
    this.operationIdSha256 = operation.operationIdSha256;
    const operationJson = boundedCanonicalJson(
      operation,
      MAX_OPERATION_BYTES,
      "transition operation",
    );
    const session = this.database.withSession("first-primary");
    const authorityJson = boundedCanonicalJson(
      this.identity.executionAuthority,
      MAX_AUTHORITY_BYTES,
      "transition execution authority",
    );
    let inserted = false;
    try {
      const results = await session.batch([
        session.prepare(
          `INSERT INTO json_compatibility_deployment_transition_operations (
            operation_id_sha256, operation_digest_sha256,
            authorized_request_sha256, campaign_plan_digest_sha256,
            state_plan_digest_sha256, transition_id, operation_json,
            coordinator_version_id, coordinator_profile_version,
            deployment_leaf_service_name, source_verifier_service_name,
            created_at
          ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, unixepoch()
          )`,
        ).bind(
          operation.operationIdSha256,
          operation.operationDigestSha256,
          operation.authorizedRequestSha256,
          operation.campaignPlanDigestSha256,
          operation.statePlanDigestSha256,
          operation.transitionId,
          operationJson,
          this.identity.coordinatorVersionId,
          this.identity.coordinatorProfileVersion,
          this.identity.deploymentReadbackServiceName,
          this.identity.sourceVerifierServiceName,
        ),
        session.prepare(
          `INSERT INTO json_compatibility_deployment_transition_authorities (
            operation_id_sha256, authority_digest_sha256, authority_json,
            coordinator_service_name, coordinator_version_id,
            coordinator_identity_sha256, source_verifier_service_name,
            source_verifier_version_id, source_verifier_identity_sha256,
            readback_service_name, readback_version_id,
            readback_identity_sha256, readback_credential_id_sha256,
            mutation_service_name, mutation_version_id,
            mutation_identity_sha256, mutation_credential_id_sha256,
            created_at
          ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
            ?14, ?15, ?16, ?17, unixepoch()
          )`,
        ).bind(
          operation.operationIdSha256,
          this.identity.executionAuthority.authorityDigestSha256,
          authorityJson,
          this.identity.executionAuthority.coordinator.serviceName,
          this.identity.executionAuthority.coordinator.versionId,
          this.identity.executionAuthority.coordinator.identitySha256,
          this.identity.executionAuthority.sourceVerifier.serviceName,
          this.identity.executionAuthority.sourceVerifier.versionId,
          this.identity.executionAuthority.sourceVerifier.identitySha256,
          this.identity.executionAuthority.readback.serviceName,
          this.identity.executionAuthority.readback.versionId,
          this.identity.executionAuthority.readback.identitySha256,
          this.identity.executionAuthority.readback.credentialIdSha256,
          this.identity.executionAuthority.mutation.serviceName,
          this.identity.executionAuthority.mutation.versionId,
          this.identity.executionAuthority.mutation.identitySha256,
          this.identity.executionAuthority.mutation.credentialIdSha256,
        ),
      ]);
      inserted = results.length === 2 && results.every(
        (result) => result.success === true && result.meta.changes === 1,
      );
    } catch {
      // A concurrent writer may already have reserved this exact operation.
    }

    const persisted = await readOperation(session, operation.operationIdSha256);
    if (persisted === null) {
      const conflict = await findOperationConflict(session, operation);
      if (conflict) return { classification: "conflict", receipt: null };
      throw new TransitionRepositoryUnavailableError(false);
    }
    const authority = await readAuthority(session, operation.operationIdSha256);
    if (
      authority === null
      || !operationMatches(
        persisted,
        authority,
        operationJson,
        authorityJson,
        operation,
        this.identity,
      )
    ) {
      return { classification: "conflict", receipt: null };
    }
    if (inserted) return { classification: "reserved", receipt: null };

    const receipt = await readReceipt(session, operation.operationIdSha256);
    if (receipt === null) {
      return { classification: "inflight", receipt: null };
    }
    return {
      classification: "exact_replay",
      receipt: parseReceipt(receipt),
    };
  }

  async append(
    event: JsonCompatibilityDeploymentTransitionJournalEventV1,
  ): Promise<{ readonly classification: "appended" | "conflict" }> {
    const operationIdSha256 = this.requireOperationId();
    validateEvent(event);
    const eventJson = boundedCanonicalJson(
      event,
      MAX_EVENT_BYTES,
      "transition journal event",
    );
    const session = this.database.withSession("first-primary");
    try {
      await session.prepare(
        `INSERT INTO json_compatibility_deployment_transition_events (
          operation_id_sha256, event_ordinal, event_kind,
          event_digest_sha256, event_json, recorded_at
        )
        SELECT
          ?1,
          COALESCE(MAX(event_ordinal), 0) + 1,
          ?2,
          ?3,
          ?4,
          unixepoch()
        FROM json_compatibility_deployment_transition_events
        WHERE operation_id_sha256 = ?1`,
      ).bind(
        operationIdSha256,
        event.kind,
        event.digestSha256,
        eventJson,
      ).run();
    } catch {
      // A concurrent writer may already have appended this exact event.
    }
    const persisted = await readEvent(
      session,
      operationIdSha256,
      event.digestSha256,
    );
    if (persisted === null) {
      throw new TransitionRepositoryUnavailableError(true);
    }
    if (
      persisted.event_kind !== event.kind
      || persisted.event_json !== eventJson
    ) {
      return { classification: "conflict" };
    }
    return { classification: "appended" };
  }

  async finalize(
    receipt: JsonCompatibilityDeploymentTransitionReceiptV1,
  ): Promise<{
    readonly classification:
      | "created"
      | "exact_replay"
      | "conflict"
      | "ambiguous";
    readonly receipt: JsonCompatibilityDeploymentTransitionReceiptV1 | null;
  }> {
    const operationIdSha256 = this.requireOperationId();
    validateReceiptShape(receipt, operationIdSha256);
    const receiptJson = boundedCanonicalJson(
      receipt,
      MAX_RECEIPT_BYTES,
      "transition receipt",
    );
    const session = this.database.withSession("first-primary");
    let inserted = false;
    try {
      const result = await session.prepare(
        `INSERT INTO json_compatibility_deployment_transition_receipts (
          operation_id_sha256, receipt_digest_sha256, result, receipt_json,
          archived_at
        ) VALUES (?1, ?2, ?3, ?4, unixepoch())`,
      ).bind(
        operationIdSha256,
        receipt.receiptDigestSha256,
        receipt.result,
        receiptJson,
      ).run();
      inserted = result.success === true && result.meta.changes === 1;
    } catch {
      inserted = false;
    }
    let persisted: ReceiptRow | null;
    try {
      persisted = await readReceipt(session, operationIdSha256);
    } catch {
      return { classification: "ambiguous", receipt: null };
    }
    if (persisted === null) {
      return { classification: "ambiguous", receipt: null };
    }
    if (
      persisted.receipt_digest_sha256 !== receipt.receiptDigestSha256
      || persisted.result !== receipt.result
      || persisted.receipt_json !== receiptJson
    ) {
      return { classification: "conflict", receipt: null };
    }
    return {
      classification: inserted ? "created" : "exact_replay",
      receipt: parseReceipt(persisted),
    };
  }

  private requireOperationId(): string {
    if (this.operationIdSha256 === null) {
      throw new TransitionRepositoryUnavailableError(false);
    }
    return this.operationIdSha256;
  }
}

export async function readTransitionStatus(
  database: D1Database,
  operationIdSha256: string,
  expectedOperationDigestSha256: string,
): Promise<TransitionStatusSnapshot> {
  digest(operationIdSha256, "transition operation ID");
  digest(expectedOperationDigestSha256, "transition operation digest");
  const session = database.withSession("first-primary");
  let results: D1Result<TransitionStatusRow>[];
  try {
    results = await session.batch<TransitionStatusRow>([
      session.prepare(
        `SELECT ${OPERATION_COLUMNS}
         FROM json_compatibility_deployment_transition_operations
         WHERE operation_id_sha256 = ?1
         LIMIT 1`,
      ).bind(operationIdSha256),
      session.prepare(
        `SELECT ${AUTHORITY_COLUMNS}
         FROM json_compatibility_deployment_transition_authorities
         WHERE operation_id_sha256 = ?1
         LIMIT 1`,
      ).bind(operationIdSha256),
      session.prepare(
        `SELECT ${EVENT_COLUMNS}
         FROM json_compatibility_deployment_transition_events
         WHERE operation_id_sha256 = ?1
         ORDER BY event_ordinal ASC`,
      ).bind(operationIdSha256),
      session.prepare(
        `SELECT ${RECEIPT_COLUMNS}
         FROM json_compatibility_deployment_transition_receipts
         WHERE operation_id_sha256 = ?1
         LIMIT 1`,
      ).bind(operationIdSha256),
      session.prepare(
        `SELECT ${RESOLUTION_COLUMNS}
         FROM json_compatibility_deployment_transition_resolution_outcomes
         WHERE operation_id_sha256 = ?1
         ORDER BY generation DESC
         LIMIT 1`,
      ).bind(operationIdSha256),
    ]);
  } catch {
    throw new TransitionRepositoryUnavailableError(false);
  }
  if (results.length !== 5 || results.some((result) => !result.success)) {
    throw new TransitionRepositoryUnavailableError(false);
  }
  const operation = optionalStatusRow<OperationRow>(
    results[0],
    "transition status operation",
  );
  if (operation === null) {
    if (results.slice(1).some((result) => result.results.length !== 0)) {
      throw new TransitionRepositoryUnavailableError(false);
    }
    return {
      classification: "not_found",
      operation: null,
      events: [],
      receipt: null,
      archivedAt: null,
      resolution: null,
      resolvedAt: null,
    };
  }
  if (operation.operation_digest_sha256 !== expectedOperationDigestSha256) {
    throw new TransitionRepositoryConflictError();
  }
  const authority = optionalStatusRow<AuthorityRow>(
    results[1],
    "transition status authority",
  );
  if (authority === null) {
    throw new TransitionRepositoryUnavailableError(false);
  }
  const events = results[2].results as TransitionEventRow[];
  const receiptRow = optionalStatusRow<ReceiptRow>(
    results[3],
    "transition status receipt",
  );
  const resolutionRow = optionalStatusRow<ResolutionRow>(
    results[4],
    "transition status resolution",
  );
  if (receiptRow !== null && resolutionRow !== null) {
    throw new TransitionRepositoryUnavailableError(false);
  }
  const finalResolution = resolutionRow !== null
    && resolutionRow.classification !== "readback_inconclusive";
  return {
    classification: receiptRow !== null
      ? "terminal"
      : finalResolution ? "resolved" : "inflight",
    operation: publicOperation(operation, authority),
    events,
    receipt: receiptRow === null ? null : parseReceipt(receiptRow),
    archivedAt: receiptRow?.archived_at ?? null,
    resolution: resolutionRow === null
      ? null
      : parseResolution(resolutionRow),
    resolvedAt: resolutionRow?.resolved_at ?? null,
  };
}

function optionalStatusRow<Row extends TransitionStatusRow>(
  result: D1Result<TransitionStatusRow>,
  _label: string,
): Row | null {
  if (result.results.length > 1) {
    throw new TransitionRepositoryUnavailableError(false);
  }
  return (result.results[0] as Row | undefined) ?? null;
}

async function readOperation(
  session: D1DatabaseSession,
  operationIdSha256: string,
): Promise<OperationRow | null> {
  try {
    return await session.prepare(
      `SELECT ${OPERATION_COLUMNS}
       FROM json_compatibility_deployment_transition_operations
       WHERE operation_id_sha256 = ?1
       LIMIT 1`,
    ).bind(operationIdSha256).first<OperationRow>();
  } catch {
    throw new TransitionRepositoryUnavailableError(false);
  }
}

async function readAuthority(
  session: D1DatabaseSession,
  operationIdSha256: string,
): Promise<AuthorityRow | null> {
  try {
    return await session.prepare(
      `SELECT ${AUTHORITY_COLUMNS}
       FROM json_compatibility_deployment_transition_authorities
       WHERE operation_id_sha256 = ?1
       LIMIT 1`,
    ).bind(operationIdSha256).first<AuthorityRow>();
  } catch {
    throw new TransitionRepositoryUnavailableError(false);
  }
}

async function findOperationConflict(
  session: D1DatabaseSession,
  operation: JsonCompatibilityDeploymentTransitionOperationV1,
): Promise<boolean> {
  try {
    const row = await session.prepare(
      `SELECT operation_id_sha256
       FROM json_compatibility_deployment_transition_operations
       WHERE operation_digest_sha256 = ?1
          OR authorized_request_sha256 = ?2
       LIMIT 1`,
    ).bind(
      operation.operationDigestSha256,
      operation.authorizedRequestSha256,
    ).first<{ readonly operation_id_sha256: string }>();
    return row !== null;
  } catch {
    throw new TransitionRepositoryUnavailableError(false);
  }
}

async function readEvent(
  session: D1DatabaseSession,
  operationIdSha256: string,
  eventDigestSha256: string,
): Promise<TransitionEventRow | null> {
  try {
    return await session.prepare(
      `SELECT ${EVENT_COLUMNS}
       FROM json_compatibility_deployment_transition_events
       WHERE operation_id_sha256 = ?1
         AND event_digest_sha256 = ?2
       LIMIT 1`,
    ).bind(operationIdSha256, eventDigestSha256).first<TransitionEventRow>();
  } catch {
    throw new TransitionRepositoryUnavailableError(true);
  }
}

async function readReceipt(
  session: D1DatabaseSession,
  operationIdSha256: string,
): Promise<ReceiptRow | null> {
  try {
    return await session.prepare(
      `SELECT ${RECEIPT_COLUMNS}
       FROM json_compatibility_deployment_transition_receipts
       WHERE operation_id_sha256 = ?1
       LIMIT 1`,
    ).bind(operationIdSha256).first<ReceiptRow>();
  } catch {
    throw new TransitionRepositoryUnavailableError(true);
  }
}

function operationMatches(
  row: OperationRow,
  authority: AuthorityRow,
  operationJson: string,
  authorityJson: string,
  operation: JsonCompatibilityDeploymentTransitionOperationV1,
  identity: TransitionRepositoryIdentity,
): boolean {
  return row.operation_id_sha256 === operation.operationIdSha256
    && row.operation_digest_sha256 === operation.operationDigestSha256
    && row.authorized_request_sha256 === operation.authorizedRequestSha256
    && row.campaign_plan_digest_sha256 === operation.campaignPlanDigestSha256
    && row.state_plan_digest_sha256 === operation.statePlanDigestSha256
    && row.transition_id === operation.transitionId
    && row.operation_json === operationJson
    && row.coordinator_version_id === identity.coordinatorVersionId
    && row.coordinator_profile_version === identity.coordinatorProfileVersion
    && row.deployment_leaf_service_name
      === identity.deploymentReadbackServiceName
    && row.source_verifier_service_name === identity.sourceVerifierServiceName
    && authority.operation_id_sha256 === operation.operationIdSha256
    && authority.authority_digest_sha256
      === identity.executionAuthority.authorityDigestSha256
    && authority.authority_json === authorityJson
    && authority.coordinator_service_name === identity.coordinatorServiceName
    && authority.coordinator_version_id === identity.coordinatorVersionId
    && authority.coordinator_identity_sha256
      === identity.executionAuthority.coordinator.identitySha256
    && authority.source_verifier_service_name
      === identity.sourceVerifierServiceName
    && authority.source_verifier_version_id
      === identity.executionAuthority.sourceVerifier.versionId
    && authority.source_verifier_identity_sha256
      === identity.executionAuthority.sourceVerifier.identitySha256
    && authority.readback_service_name
      === identity.deploymentReadbackServiceName
    && authority.readback_version_id
      === identity.executionAuthority.readback.versionId
    && authority.readback_identity_sha256
      === identity.executionAuthority.readback.identitySha256
    && authority.readback_credential_id_sha256
      === identity.executionAuthority.readback.credentialIdSha256
    && authority.mutation_service_name
      === identity.deploymentMutationServiceName
    && authority.mutation_version_id
      === identity.executionAuthority.mutation.versionId
    && authority.mutation_identity_sha256
      === identity.executionAuthority.mutation.identitySha256
    && authority.mutation_credential_id_sha256
      === identity.executionAuthority.mutation.credentialIdSha256;
}

function publicOperation(row: OperationRow, authority: AuthorityRow): NonNullable<
  TransitionStatusSnapshot["operation"]
> {
  return {
    operationIdSha256: row.operation_id_sha256,
    operationDigestSha256: row.operation_digest_sha256,
    authorizedRequestSha256: row.authorized_request_sha256,
    campaignPlanDigestSha256: row.campaign_plan_digest_sha256,
    statePlanDigestSha256: row.state_plan_digest_sha256,
    transitionId: row.transition_id,
    coordinatorVersionId: row.coordinator_version_id,
    coordinatorProfileVersion: row.coordinator_profile_version,
    executionAuthoritySha256: authority.authority_digest_sha256,
    deploymentReadbackServiceName: authority.readback_service_name,
    deploymentMutationServiceName: authority.mutation_service_name,
    sourceVerifierServiceName: row.source_verifier_service_name,
    createdAt: row.created_at,
  };
}

function parseReceipt(row: ReceiptRow): JsonCompatibilityDeploymentTransitionReceiptV1 {
  let value: unknown;
  try {
    value = JSON.parse(row.receipt_json);
  } catch {
    throw new TransitionRepositoryUnavailableError(true);
  }
  if (!isRecord(value)) {
    throw new TransitionRepositoryUnavailableError(true);
  }
  return value as JsonCompatibilityDeploymentTransitionReceiptV1;
}

function parseResolution(
  row: ResolutionRow,
): JsonCompatibilityDeploymentResolutionReceiptV1 {
  let value: unknown;
  try {
    value = JSON.parse(row.resolution_json);
  } catch {
    throw new TransitionRepositoryUnavailableError(true);
  }
  try {
    const resolution = validateJsonCompatibilityDeploymentResolutionReceipt(
      value,
    );
    if (
      resolution.operationIdSha256 !== row.operation_id_sha256
      || resolution.claimGeneration !== row.generation
      || resolution.classification !== row.classification
      || resolution.resolutionReceiptSha256
        !== row.resolution_digest_sha256
    ) {
      throw new Error("persisted resolution row drifted");
    }
    return resolution;
  } catch {
    throw new TransitionRepositoryUnavailableError(true);
  }
}

function validateOperation(
  operation: JsonCompatibilityDeploymentTransitionOperationV1,
): void {
  if (!isRecord(operation)) throw new Error("transition operation is invalid");
  for (const value of [
    operation.operationIdSha256,
    operation.operationDigestSha256,
    operation.authorizedRequestSha256,
    operation.campaignPlanDigestSha256,
    operation.statePlanDigestSha256,
  ]) digest(value, "transition operation digest");
  token(operation.transitionId, "transition ID");
}

function validateRepositoryIdentity(
  identity: TransitionRepositoryIdentity,
): void {
  for (const [label, value] of [
    ["coordinator service", identity.coordinatorServiceName],
    ["coordinator version", identity.coordinatorVersionId],
    ["deployment readback service", identity.deploymentReadbackServiceName],
    ["deployment mutation service", identity.deploymentMutationServiceName],
    ["source verifier service", identity.sourceVerifierServiceName],
  ]) token(value, label);
  if (identity.coordinatorProfileVersion !== 1) {
    throw new Error("transition coordinator profile is invalid");
  }
  const authority = identity.executionAuthority;
  digest(authority.authorityDigestSha256, "transition execution authority");
  for (const [label, service] of [
    ["coordinator", authority.coordinator],
    ["source verifier", authority.sourceVerifier],
    ["readback", authority.readback],
    ["mutation", authority.mutation],
  ] as const) {
    token(service.serviceName, `${label} authority service`);
    token(service.versionId, `${label} authority version`);
    digest(service.identitySha256, `${label} authority identity`);
  }
  digest(
    authority.readback.credentialIdSha256,
    "readback authority credential",
  );
  digest(
    authority.mutation.credentialIdSha256,
    "mutation authority credential",
  );
  if (
    authority.coordinator.serviceName !== identity.coordinatorServiceName
    || authority.coordinator.versionId !== identity.coordinatorVersionId
    || authority.sourceVerifier.serviceName
      !== identity.sourceVerifierServiceName
    || authority.readback.serviceName
      !== identity.deploymentReadbackServiceName
    || authority.mutation.serviceName
      !== identity.deploymentMutationServiceName
  ) {
    throw new Error("transition repository authority identity is inconsistent");
  }
}

function validateEvent(
  event: JsonCompatibilityDeploymentTransitionJournalEventV1,
): void {
  if (!isRecord(event)) throw new Error("transition event is invalid");
  if (![
    "source_authentication",
    "source_readback",
    "mutation_intent",
    "mutation_outcome",
    "target_readback",
  ].includes(event.kind)) {
    throw new Error("transition event kind is invalid");
  }
  digest(event.digestSha256, "transition event digest");
}

function validateReceiptShape(
  receipt: JsonCompatibilityDeploymentTransitionReceiptV1,
  operationIdSha256: string,
): void {
  if (!isRecord(receipt)) throw new Error("transition receipt is invalid");
  if (receipt.operationIdSha256 !== operationIdSha256) {
    throw new Error("transition receipt operation mismatch");
  }
  digest(receipt.receiptDigestSha256, "transition receipt digest");
  if (receipt.result !== "completed" && receipt.result !== "stopped") {
    throw new Error("transition receipt result is invalid");
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
