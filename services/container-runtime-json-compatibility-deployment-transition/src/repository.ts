import type {
  JsonCompatibilityDeploymentTransitionJournalEventV1,
  JsonCompatibilityDeploymentTransitionOperationV1,
  JsonCompatibilityDeploymentTransitionReceiptV1,
} from "../../../tools/container_runtime_json_compatibility_deployment_transition.mjs";

import { canonicalJson } from "./canonical";

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_OPERATION_BYTES = 8 * 1024;
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

const RECEIPT_COLUMNS = `
  operation_id_sha256, receipt_digest_sha256, result, receipt_json,
  archived_at
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

export interface TransitionRepositoryIdentity {
  readonly coordinatorVersionId: string;
  readonly coordinatorProfileVersion: 1;
  readonly deploymentLeafServiceName: string;
  readonly sourceVerifierServiceName: string;
}

export interface TransitionStatusSnapshot {
  readonly classification: "not_found" | "inflight" | "terminal";
  readonly operation: {
    readonly operationIdSha256: string;
    readonly operationDigestSha256: string;
    readonly authorizedRequestSha256: string;
    readonly campaignPlanDigestSha256: string;
    readonly statePlanDigestSha256: string;
    readonly transitionId: string;
    readonly coordinatorVersionId: string;
    readonly coordinatorProfileVersion: number;
    readonly deploymentLeafServiceName: string;
    readonly sourceVerifierServiceName: string;
    readonly createdAt: number;
  } | null;
  readonly events: readonly TransitionEventRow[];
  readonly receipt: JsonCompatibilityDeploymentTransitionReceiptV1 | null;
  readonly archivedAt: number | null;
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
    this.operationIdSha256 = operation.operationIdSha256;
    const operationJson = boundedCanonicalJson(
      operation,
      MAX_OPERATION_BYTES,
      "transition operation",
    );
    const session = this.database.withSession("first-primary");
    let inserted = false;
    try {
      const result = await session.prepare(
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
        this.identity.deploymentLeafServiceName,
        this.identity.sourceVerifierServiceName,
      ).run();
      inserted = result.success === true && result.meta.changes === 1;
    } catch {
      // A concurrent writer may already have reserved this exact operation.
    }

    const persisted = await readOperation(session, operation.operationIdSha256);
    if (persisted === null) {
      const conflict = await findOperationConflict(session, operation);
      if (conflict) return { classification: "conflict", receipt: null };
      throw new TransitionRepositoryUnavailableError(false);
    }
    if (!operationMatches(persisted, operationJson, operation, this.identity)) {
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
  const operation = await readOperation(session, operationIdSha256);
  if (operation === null) {
    return {
      classification: "not_found",
      operation: null,
      events: [],
      receipt: null,
      archivedAt: null,
    };
  }
  if (operation.operation_digest_sha256 !== expectedOperationDigestSha256) {
    throw new TransitionRepositoryConflictError();
  }
  let events: TransitionEventRow[];
  try {
    const result = await session.prepare(
      `SELECT ${EVENT_COLUMNS}
       FROM json_compatibility_deployment_transition_events
       WHERE operation_id_sha256 = ?1
       ORDER BY event_ordinal ASC`,
    ).bind(operationIdSha256).all<TransitionEventRow>();
    events = result.results;
  } catch {
    throw new TransitionRepositoryUnavailableError(false);
  }
  const receiptRow = await readReceipt(session, operationIdSha256);
  return {
    classification: receiptRow === null ? "inflight" : "terminal",
    operation: publicOperation(operation),
    events,
    receipt: receiptRow === null ? null : parseReceipt(receiptRow),
    archivedAt: receiptRow?.archived_at ?? null,
  };
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
  operationJson: string,
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
    && row.deployment_leaf_service_name === identity.deploymentLeafServiceName
    && row.source_verifier_service_name === identity.sourceVerifierServiceName;
}

function publicOperation(row: OperationRow): NonNullable<
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
    deploymentLeafServiceName: row.deployment_leaf_service_name,
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
