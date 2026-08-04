import { DurableObject } from "cloudflare:workers";

import {
  canonicalJson,
  sha256Hex,
} from "../../container-controller/src/json_compatibility_probe";
import {
  JSON_COMPATIBILITY_PHASE_IDS,
  type JsonCompatibilityPhaseId,
  type JsonCompatibilityPhaseOrdinal,
} from "../../container-runtime-json-compatibility-executor/src/protocol";

export const JSON_COMPATIBILITY_INVOCATION_ATTEMPT_RECEIPT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-invocation-attempt-receipt-v1" as const;
export const JSON_COMPATIBILITY_INVOCATION_COMPLETION_RECEIPT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-invocation-completion-receipt-v1" as const;

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface JsonCompatibilityInvocationAttemptBeginV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-invocation-attempt-begin-v1";
  readonly campaignIdSha256: string;
  readonly campaignBindingSha256: string;
  readonly planDigestSha256: string;
  readonly phaseOrdinal: JsonCompatibilityPhaseOrdinal;
  readonly phaseId: JsonCompatibilityPhaseId;
  readonly phaseExecutionId: string;
  readonly commandIdSha256: string;
  readonly commandSubjectSha256: string;
  readonly commandAuthorityEnvelopeSha256: string;
  readonly issueIntentSha256: string;
  readonly topologyReadbackSha256: string;
  readonly beforeContextSha256: string;
  readonly attemptIdSha256: string;
  readonly invokerVersionId: string;
  readonly startedAt: number;
}

export interface JsonCompatibilityInvocationAttemptReceiptV1 {
  readonly schemaVersion: 1;
  readonly contract:
    typeof JSON_COMPATIBILITY_INVOCATION_ATTEMPT_RECEIPT_CONTRACT;
  readonly status: "invocation_attempt_recorded";
  readonly campaignIdSha256: string;
  readonly campaignBindingSha256: string;
  readonly planDigestSha256: string;
  readonly phaseOrdinal: JsonCompatibilityPhaseOrdinal;
  readonly phaseId: JsonCompatibilityPhaseId;
  readonly phaseExecutionId: string;
  readonly commandIdSha256: string;
  readonly commandSubjectSha256: string;
  readonly commandAuthorityEnvelopeSha256: string;
  readonly issueIntentSha256: string;
  readonly topologyReadbackSha256: string;
  readonly beforeContextSha256: string;
  readonly attemptIdSha256: string;
  readonly invokerVersionId: string;
  readonly startedAt: number;
  readonly oneAttemptPerPhasePersisted: true;
  readonly phaseOrderEnforced: true;
  readonly ambiguousRetryRejected: true;
  readonly receiptSha256: string;
}

export interface JsonCompatibilityInvocationAttemptCompleteV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-invocation-attempt-complete-v1";
  readonly campaignIdSha256: string;
  readonly phaseOrdinal: JsonCompatibilityPhaseOrdinal;
  readonly phaseExecutionId: string;
  readonly commandIdSha256: string;
  readonly attemptIdSha256: string;
  readonly permitIdSha256: string;
  readonly permitIssueReceiptSha256: string;
  readonly executorReceiptSha256: string;
  readonly invocationBodySha256: string;
  readonly completedAt: number;
}

export interface JsonCompatibilityInvocationCompletionReceiptV1 {
  readonly schemaVersion: 1;
  readonly contract:
    typeof JSON_COMPATIBILITY_INVOCATION_COMPLETION_RECEIPT_CONTRACT;
  readonly status:
    | "invocation_phase_completed"
    | "invocation_campaign_completed";
  readonly campaignIdSha256: string;
  readonly phaseOrdinal: JsonCompatibilityPhaseOrdinal;
  readonly phaseExecutionId: string;
  readonly commandIdSha256: string;
  readonly attemptIdSha256: string;
  readonly permitIdSha256: string;
  readonly permitIssueReceiptSha256: string;
  readonly executorReceiptSha256: string;
  readonly invocationBodySha256: string;
  readonly completedAt: number;
  readonly attemptCompletionPersisted: true;
  readonly phaseOrderAdvanced: true;
  readonly campaignTerminal: boolean;
  readonly receiptSha256: string;
}

export interface JsonCompatibilityInvocationAttemptFailV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-invocation-attempt-fail-v1";
  readonly campaignIdSha256: string;
  readonly phaseOrdinal: JsonCompatibilityPhaseOrdinal;
  readonly phaseExecutionId: string;
  readonly commandIdSha256: string;
  readonly attemptIdSha256: string;
  readonly failureCode: string;
  readonly failedAt: number;
}

export type JsonCompatibilityInvocationAuthorityErrorCode =
  | "invalid_invocation_authority_command"
  | "invocation_attempt_replayed"
  | "invocation_campaign_binding_conflict"
  | "invocation_phase_order_conflict"
  | "invocation_attempt_active"
  | "invocation_campaign_terminal"
  | "invocation_attempt_conflict";

export type JsonCompatibilityInvocationAttemptBeginResult =
  | { readonly ok: true; readonly receipt: JsonCompatibilityInvocationAttemptReceiptV1 }
  | {
      readonly ok: false;
      readonly error: { readonly code: JsonCompatibilityInvocationAuthorityErrorCode };
    };

export type JsonCompatibilityInvocationAttemptTerminalResult =
  | {
      readonly ok: true;
      readonly status:
        | "invocation_phase_completed"
        | "invocation_campaign_completed"
        | "invocation_campaign_failed";
      readonly receipt?: JsonCompatibilityInvocationCompletionReceiptV1;
    }
  | {
      readonly ok: false;
      readonly error: { readonly code: JsonCompatibilityInvocationAuthorityErrorCode };
    };

interface CampaignRow {
  [key: string]: string | number | null;
  campaign_id_sha256: string;
  campaign_binding_sha256: string;
  plan_digest_sha256: string;
  next_phase_ordinal: number;
  status: "active" | "failed" | "completed";
  active_command_id_sha256: string | null;
  active_phase_ordinal: number | null;
  active_phase_execution_id: string | null;
  active_attempt_id_sha256: string | null;
}

interface AttemptRow {
  [key: string]: string;
  command_id_sha256: string;
  status: "active" | "completed" | "failed";
}

interface JsonCompatibilityInvocationAuthorityEnv {}

export class JsonCompatibilityInvocationAuthority
  extends DurableObject<JsonCompatibilityInvocationAuthorityEnv> {
  constructor(
    ctx: DurableObjectState,
    env: JsonCompatibilityInvocationAuthorityEnv,
  ) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ensureSchema();
    });
  }

  async beginAttempt(
    raw: JsonCompatibilityInvocationAttemptBeginV1,
  ): Promise<JsonCompatibilityInvocationAttemptBeginResult> {
    let input: JsonCompatibilityInvocationAttemptBeginV1;
    try {
      input = parseBegin(raw);
    } catch {
      return denied("invalid_invocation_authority_command");
    }
    const receiptSubject = {
      schemaVersion: 1 as const,
      contract: JSON_COMPATIBILITY_INVOCATION_ATTEMPT_RECEIPT_CONTRACT,
      status: "invocation_attempt_recorded" as const,
      campaignIdSha256: input.campaignIdSha256,
      campaignBindingSha256: input.campaignBindingSha256,
      planDigestSha256: input.planDigestSha256,
      phaseOrdinal: input.phaseOrdinal,
      phaseId: input.phaseId,
      phaseExecutionId: input.phaseExecutionId,
      commandIdSha256: input.commandIdSha256,
      commandSubjectSha256: input.commandSubjectSha256,
      commandAuthorityEnvelopeSha256: input.commandAuthorityEnvelopeSha256,
      issueIntentSha256: input.issueIntentSha256,
      topologyReadbackSha256: input.topologyReadbackSha256,
      beforeContextSha256: input.beforeContextSha256,
      attemptIdSha256: input.attemptIdSha256,
      invokerVersionId: input.invokerVersionId,
      startedAt: input.startedAt,
      oneAttemptPerPhasePersisted: true as const,
      phaseOrderEnforced: true as const,
      ambiguousRetryRejected: true as const,
    };
    const receipt: JsonCompatibilityInvocationAttemptReceiptV1 = {
      ...receiptSubject,
      receiptSha256: await sha256Hex(canonicalJson(receiptSubject)),
    };
    return this.ctx.storage.transactionSync(() => {
      if (this.readAttempt(input.commandIdSha256) !== null) {
        return denied("invocation_attempt_replayed");
      }
      const current = this.readCampaign();
      if (current === null) {
        if (input.phaseOrdinal !== 1) {
          return denied("invocation_phase_order_conflict");
        }
        this.ctx.storage.sql.exec(
          `INSERT INTO json_compatibility_invocation_campaign (
             singleton, campaign_id_sha256, campaign_binding_sha256,
             plan_digest_sha256, next_phase_ordinal, status,
             active_command_id_sha256, active_phase_ordinal,
             active_phase_execution_id, active_attempt_id_sha256, updated_at
           ) VALUES (1, ?1, ?2, ?3, 1, 'active', NULL, NULL, NULL, NULL, ?4)`,
          input.campaignIdSha256,
          input.campaignBindingSha256,
          input.planDigestSha256,
          input.startedAt,
        );
      } else {
        if (
          current.campaign_id_sha256 !== input.campaignIdSha256
          || current.campaign_binding_sha256 !== input.campaignBindingSha256
          || current.plan_digest_sha256 !== input.planDigestSha256
        ) {
          return denied("invocation_campaign_binding_conflict");
        }
        if (current.status !== "active") {
          return denied("invocation_campaign_terminal");
        }
        if (current.active_command_id_sha256 !== null) {
          return denied("invocation_attempt_active");
        }
        if (current.next_phase_ordinal !== input.phaseOrdinal) {
          return denied("invocation_phase_order_conflict");
        }
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO json_compatibility_invocation_attempts (
           command_id_sha256, command_subject_sha256,
           command_authority_envelope_sha256, issue_intent_sha256,
           topology_readback_sha256, before_context_sha256, phase_ordinal,
           phase_id, phase_execution_id, attempt_id_sha256,
           invoker_version_id, status, started_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'active', ?12)`,
        input.commandIdSha256,
        input.commandSubjectSha256,
        input.commandAuthorityEnvelopeSha256,
        input.issueIntentSha256,
        input.topologyReadbackSha256,
        input.beforeContextSha256,
        input.phaseOrdinal,
        input.phaseId,
        input.phaseExecutionId,
        input.attemptIdSha256,
        input.invokerVersionId,
        input.startedAt,
      );
      this.ctx.storage.sql.exec(
        `UPDATE json_compatibility_invocation_campaign
            SET active_command_id_sha256 = ?1, active_phase_ordinal = ?2,
                active_phase_execution_id = ?3, active_attempt_id_sha256 = ?4,
                updated_at = ?5
          WHERE singleton = 1`,
        input.commandIdSha256,
        input.phaseOrdinal,
        input.phaseExecutionId,
        input.attemptIdSha256,
        input.startedAt,
      );
      return { ok: true as const, receipt };
    });
  }

  async completeAttempt(
    raw: JsonCompatibilityInvocationAttemptCompleteV1,
  ): Promise<JsonCompatibilityInvocationAttemptTerminalResult> {
    let input: JsonCompatibilityInvocationAttemptCompleteV1;
    try {
      input = parseComplete(raw);
    } catch {
      return denied("invalid_invocation_authority_command");
    }
    const campaignCompleted = input.phaseOrdinal === JSON_COMPATIBILITY_PHASE_IDS.length;
    const receiptSubject = {
      schemaVersion: 1 as const,
      contract: JSON_COMPATIBILITY_INVOCATION_COMPLETION_RECEIPT_CONTRACT,
      status: campaignCompleted
        ? "invocation_campaign_completed" as const
        : "invocation_phase_completed" as const,
      campaignIdSha256: input.campaignIdSha256,
      phaseOrdinal: input.phaseOrdinal,
      phaseExecutionId: input.phaseExecutionId,
      commandIdSha256: input.commandIdSha256,
      attemptIdSha256: input.attemptIdSha256,
      permitIdSha256: input.permitIdSha256,
      permitIssueReceiptSha256: input.permitIssueReceiptSha256,
      executorReceiptSha256: input.executorReceiptSha256,
      invocationBodySha256: input.invocationBodySha256,
      completedAt: input.completedAt,
      attemptCompletionPersisted: true as const,
      phaseOrderAdvanced: true as const,
      campaignTerminal: campaignCompleted,
    };
    const receipt: JsonCompatibilityInvocationCompletionReceiptV1 = {
      ...receiptSubject,
      receiptSha256: await sha256Hex(canonicalJson(receiptSubject)),
    };
    return this.ctx.storage.transactionSync(() => {
      const current = this.readCampaign();
      const attempt = this.readAttempt(input.commandIdSha256);
      if (!matchesActiveAttempt(current, attempt, input)) {
        return denied("invocation_attempt_conflict");
      }
      this.ctx.storage.sql.exec(
        `UPDATE json_compatibility_invocation_attempts
            SET status = 'completed', permit_id_sha256 = ?1,
                permit_issue_receipt_sha256 = ?2, executor_receipt_sha256 = ?3,
                invocation_body_sha256 = ?4, terminal_at = ?5
          WHERE command_id_sha256 = ?6 AND status = 'active'`,
        input.permitIdSha256,
        input.permitIssueReceiptSha256,
        input.executorReceiptSha256,
        input.invocationBodySha256,
        input.completedAt,
        input.commandIdSha256,
      );
      this.ctx.storage.sql.exec(
        `UPDATE json_compatibility_invocation_campaign
            SET next_phase_ordinal = ?1, status = ?2,
                active_command_id_sha256 = NULL,
                active_phase_ordinal = NULL,
                active_phase_execution_id = NULL,
                active_attempt_id_sha256 = NULL, updated_at = ?3
          WHERE singleton = 1`,
        input.phaseOrdinal + 1,
        campaignCompleted ? "completed" : "active",
        input.completedAt,
      );
      return {
        ok: true as const,
        status: receipt.status,
        receipt,
      };
    });
  }

  failAttempt(
    raw: JsonCompatibilityInvocationAttemptFailV1,
  ): JsonCompatibilityInvocationAttemptTerminalResult {
    let input: JsonCompatibilityInvocationAttemptFailV1;
    try {
      input = parseFail(raw);
    } catch {
      return denied("invalid_invocation_authority_command");
    }
    return this.ctx.storage.transactionSync(() => {
      const current = this.readCampaign();
      const attempt = this.readAttempt(input.commandIdSha256);
      if (!matchesActiveAttempt(current, attempt, input)) {
        return denied("invocation_attempt_conflict");
      }
      this.ctx.storage.sql.exec(
        `UPDATE json_compatibility_invocation_attempts
            SET status = 'failed', failure_code = ?1, terminal_at = ?2
          WHERE command_id_sha256 = ?3 AND status = 'active'`,
        input.failureCode,
        input.failedAt,
        input.commandIdSha256,
      );
      this.ctx.storage.sql.exec(
        `UPDATE json_compatibility_invocation_campaign
            SET status = 'failed', failure_code = ?1,
                active_command_id_sha256 = NULL,
                active_phase_ordinal = NULL,
                active_phase_execution_id = NULL,
                active_attempt_id_sha256 = NULL, updated_at = ?2
          WHERE singleton = 1`,
        input.failureCode,
        input.failedAt,
      );
      return { ok: true as const, status: "invocation_campaign_failed" as const };
    });
  }

  private ensureSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS json_compatibility_invocation_campaign (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        campaign_id_sha256 TEXT NOT NULL,
        campaign_binding_sha256 TEXT NOT NULL,
        plan_digest_sha256 TEXT NOT NULL,
        next_phase_ordinal INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'failed', 'completed')),
        active_command_id_sha256 TEXT,
        active_phase_ordinal INTEGER,
        active_phase_execution_id TEXT,
        active_attempt_id_sha256 TEXT,
        failure_code TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS json_compatibility_invocation_attempts (
        command_id_sha256 TEXT PRIMARY KEY,
        command_subject_sha256 TEXT NOT NULL UNIQUE,
        command_authority_envelope_sha256 TEXT NOT NULL UNIQUE,
        issue_intent_sha256 TEXT NOT NULL UNIQUE,
        topology_readback_sha256 TEXT NOT NULL,
        before_context_sha256 TEXT NOT NULL,
        phase_ordinal INTEGER NOT NULL UNIQUE,
        phase_id TEXT NOT NULL UNIQUE,
        phase_execution_id TEXT NOT NULL UNIQUE,
        attempt_id_sha256 TEXT NOT NULL UNIQUE,
        invoker_version_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'failed', 'completed')),
        permit_id_sha256 TEXT UNIQUE,
        permit_issue_receipt_sha256 TEXT UNIQUE,
        executor_receipt_sha256 TEXT UNIQUE,
        invocation_body_sha256 TEXT UNIQUE,
        failure_code TEXT,
        started_at INTEGER NOT NULL,
        terminal_at INTEGER
      );
    `);
  }

  private readCampaign(): CampaignRow | null {
    return this.ctx.storage.sql.exec<CampaignRow>(
      `SELECT campaign_id_sha256, campaign_binding_sha256,
              plan_digest_sha256, next_phase_ordinal, status,
              active_command_id_sha256, active_phase_ordinal,
              active_phase_execution_id, active_attempt_id_sha256
         FROM json_compatibility_invocation_campaign WHERE singleton = 1`,
    ).toArray()[0] ?? null;
  }

  private readAttempt(commandIdSha256: string): AttemptRow | null {
    return this.ctx.storage.sql.exec<AttemptRow>(
      `SELECT command_id_sha256, status
         FROM json_compatibility_invocation_attempts
        WHERE command_id_sha256 = ?1`,
      commandIdSha256,
    ).toArray()[0] ?? null;
  }
}

function matchesActiveAttempt(
  current: CampaignRow | null,
  attempt: AttemptRow | null,
  input: {
    campaignIdSha256: string;
    phaseOrdinal: JsonCompatibilityPhaseOrdinal;
    phaseExecutionId: string;
    commandIdSha256: string;
    attemptIdSha256: string;
  },
): boolean {
  return current !== null
    && current.status === "active"
    && current.campaign_id_sha256 === input.campaignIdSha256
    && current.active_command_id_sha256 === input.commandIdSha256
    && current.active_phase_ordinal === input.phaseOrdinal
    && current.active_phase_execution_id === input.phaseExecutionId
    && current.active_attempt_id_sha256 === input.attemptIdSha256
    && attempt?.status === "active";
}

function parseBegin(input: unknown): JsonCompatibilityInvocationAttemptBeginV1 {
  const value = object(input);
  exactKeys(value, [
    "schemaVersion", "contract", "campaignIdSha256", "campaignBindingSha256",
    "planDigestSha256", "phaseOrdinal", "phaseId", "phaseExecutionId",
    "commandIdSha256", "commandSubjectSha256", "commandAuthorityEnvelopeSha256",
    "issueIntentSha256", "topologyReadbackSha256", "beforeContextSha256",
    "attemptIdSha256", "invokerVersionId", "startedAt",
  ]);
  literal(value.schemaVersion, 1);
  literal(
    value.contract,
    "cinatoken-container-runtime-json-compatibility-invocation-attempt-begin-v1",
  );
  const phaseOrdinal = integer(value.phaseOrdinal, 1, 4) as JsonCompatibilityPhaseOrdinal;
  const phaseId = value.phaseId;
  if (phaseId !== JSON_COMPATIBILITY_PHASE_IDS[phaseOrdinal - 1]) {
    throw new Error("invalid phase");
  }
  return {
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-json-compatibility-invocation-attempt-begin-v1",
    campaignIdSha256: sha256(value.campaignIdSha256),
    campaignBindingSha256: sha256(value.campaignBindingSha256),
    planDigestSha256: sha256(value.planDigestSha256),
    phaseOrdinal,
    phaseId: phaseId as JsonCompatibilityPhaseId,
    phaseExecutionId: token(value.phaseExecutionId),
    commandIdSha256: sha256(value.commandIdSha256),
    commandSubjectSha256: sha256(value.commandSubjectSha256),
    commandAuthorityEnvelopeSha256: sha256(value.commandAuthorityEnvelopeSha256),
    issueIntentSha256: sha256(value.issueIntentSha256),
    topologyReadbackSha256: sha256(value.topologyReadbackSha256),
    beforeContextSha256: sha256(value.beforeContextSha256),
    attemptIdSha256: sha256(value.attemptIdSha256),
    invokerVersionId: token(value.invokerVersionId),
    startedAt: integer(value.startedAt, 1, Number.MAX_SAFE_INTEGER),
  };
}

function parseComplete(
  input: unknown,
): JsonCompatibilityInvocationAttemptCompleteV1 {
  const value = object(input);
  exactKeys(value, [
    "schemaVersion", "contract", "campaignIdSha256", "phaseOrdinal",
    "phaseExecutionId", "commandIdSha256", "attemptIdSha256",
    "permitIdSha256", "permitIssueReceiptSha256", "executorReceiptSha256",
    "invocationBodySha256", "completedAt",
  ]);
  literal(value.schemaVersion, 1);
  literal(
    value.contract,
    "cinatoken-container-runtime-json-compatibility-invocation-attempt-complete-v1",
  );
  return {
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-json-compatibility-invocation-attempt-complete-v1",
    campaignIdSha256: sha256(value.campaignIdSha256),
    phaseOrdinal: integer(value.phaseOrdinal, 1, 4) as JsonCompatibilityPhaseOrdinal,
    phaseExecutionId: token(value.phaseExecutionId),
    commandIdSha256: sha256(value.commandIdSha256),
    attemptIdSha256: sha256(value.attemptIdSha256),
    permitIdSha256: sha256(value.permitIdSha256),
    permitIssueReceiptSha256: sha256(value.permitIssueReceiptSha256),
    executorReceiptSha256: sha256(value.executorReceiptSha256),
    invocationBodySha256: sha256(value.invocationBodySha256),
    completedAt: integer(value.completedAt, 1, Number.MAX_SAFE_INTEGER),
  };
}

function parseFail(input: unknown): JsonCompatibilityInvocationAttemptFailV1 {
  const value = object(input);
  exactKeys(value, [
    "schemaVersion", "contract", "campaignIdSha256", "phaseOrdinal",
    "phaseExecutionId", "commandIdSha256", "attemptIdSha256", "failureCode",
    "failedAt",
  ]);
  literal(value.schemaVersion, 1);
  literal(
    value.contract,
    "cinatoken-container-runtime-json-compatibility-invocation-attempt-fail-v1",
  );
  return {
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-json-compatibility-invocation-attempt-fail-v1",
    campaignIdSha256: sha256(value.campaignIdSha256),
    phaseOrdinal: integer(value.phaseOrdinal, 1, 4) as JsonCompatibilityPhaseOrdinal,
    phaseExecutionId: token(value.phaseExecutionId),
    commandIdSha256: sha256(value.commandIdSha256),
    attemptIdSha256: sha256(value.attemptIdSha256),
    failureCode: token(value.failureCode),
    failedAt: integer(value.failedAt, 1, Number.MAX_SAFE_INTEGER),
  };
}

function denied(
  code: JsonCompatibilityInvocationAuthorityErrorCode,
): { readonly ok: false; readonly error: { readonly code: JsonCompatibilityInvocationAuthorityErrorCode } } {
  return { ok: false, error: { code } };
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error("invalid fields");
  }
}

function literal<T>(value: unknown, expected: T): T {
  if (value !== expected) throw new Error("invalid literal");
  return expected;
}

function sha256(value: unknown): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error("invalid digest");
  }
  return value;
}

function token(value: unknown): string {
  if (typeof value !== "string" || !SAFE_TOKEN.test(value)) {
    throw new Error("invalid token");
  }
  return value;
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    throw new Error("invalid integer");
  }
  return value;
}
