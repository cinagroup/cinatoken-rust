import { DurableObject } from "cloudflare:workers";

import {
  canonicalJson,
  sha256Hex,
} from "../../container-controller/src/json_compatibility_probe";
import {
  JSON_COMPATIBILITY_PHASE_IDS,
  type JsonCompatibilityPhaseId,
  type JsonCompatibilityPhaseOrdinal,
} from "./protocol";

export const JSON_COMPATIBILITY_CAMPAIGN_LEASE_RECEIPT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-campaign-lease-receipt-v1" as const;

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface JsonCompatibilityCampaignLeaseBeginV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-campaign-lease-begin-v1";
  readonly campaignIdSha256: string;
  readonly campaignBindingSha256: string;
  readonly planDigestSha256: string;
  readonly permitIdSha256: string;
  readonly permitSubjectSha256: string;
  readonly permitEnvelopeSha256: string;
  readonly permitExpiresAt: number;
  readonly phaseOrdinal: JsonCompatibilityPhaseOrdinal;
  readonly phaseId: JsonCompatibilityPhaseId;
  readonly phaseExecutionId: string;
  readonly leaseIdSha256: string;
  readonly executorVersionId: string;
  readonly acquiredAt: number;
}

export interface JsonCompatibilityCampaignLeaseReceiptV1 {
  readonly schemaVersion: 1;
  readonly contract: typeof JSON_COMPATIBILITY_CAMPAIGN_LEASE_RECEIPT_CONTRACT;
  readonly status: "phase_lease_acquired";
  readonly campaignIdSha256: string;
  readonly campaignBindingSha256: string;
  readonly planDigestSha256: string;
  readonly permitIdSha256: string;
  readonly permitSubjectSha256: string;
  readonly permitEnvelopeSha256: string;
  readonly phaseOrdinal: JsonCompatibilityPhaseOrdinal;
  readonly phaseId: JsonCompatibilityPhaseId;
  readonly phaseExecutionId: string;
  readonly leaseIdSha256: string;
  readonly executorVersionId: string;
  readonly acquiredAt: number;
  readonly permitExpiresAt: number;
  readonly singleUsePermitPersisted: true;
  readonly phaseOrderEnforced: true;
  readonly concurrentPhaseRejected: true;
  readonly leaseReceiptSha256: string;
}

export interface JsonCompatibilityCampaignLeaseCompleteV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-campaign-lease-complete-v1";
  readonly campaignIdSha256: string;
  readonly permitIdSha256: string;
  readonly phaseOrdinal: JsonCompatibilityPhaseOrdinal;
  readonly phaseExecutionId: string;
  readonly leaseIdSha256: string;
  readonly receiptSha256: string;
  readonly completedAt: number;
}

export interface JsonCompatibilityCampaignLeaseFailV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-campaign-lease-fail-v1";
  readonly campaignIdSha256: string;
  readonly permitIdSha256: string;
  readonly phaseOrdinal: JsonCompatibilityPhaseOrdinal;
  readonly phaseExecutionId: string;
  readonly leaseIdSha256: string;
  readonly failureCode: string;
  readonly failedAt: number;
}

export type JsonCompatibilityCampaignAuthorityErrorCode =
  | "invalid_campaign_authority_command"
  | "campaign_permit_replayed"
  | "campaign_binding_conflict"
  | "campaign_phase_order_conflict"
  | "campaign_lease_active"
  | "campaign_terminal"
  | "campaign_lease_conflict";

export type JsonCompatibilityCampaignLeaseBeginResult =
  | { readonly ok: true; readonly receipt: JsonCompatibilityCampaignLeaseReceiptV1 }
  | {
      readonly ok: false;
      readonly error: { readonly code: JsonCompatibilityCampaignAuthorityErrorCode };
    };

export type JsonCompatibilityCampaignLeaseTerminalResult =
  | {
      readonly ok: true;
      readonly status: "phase_completed" | "campaign_completed" | "campaign_failed";
    }
  | {
      readonly ok: false;
      readonly error: { readonly code: JsonCompatibilityCampaignAuthorityErrorCode };
    };

interface CampaignStateRow {
  [key: string]: string | number | null;
  campaign_id_sha256: string;
  campaign_binding_sha256: string;
  plan_digest_sha256: string;
  next_phase_ordinal: number;
  status: "active" | "failed" | "completed";
  active_permit_id_sha256: string | null;
  active_phase_ordinal: number | null;
  active_phase_execution_id: string | null;
  active_lease_id_sha256: string | null;
}

interface PermitRow {
  [key: string]: string;
  permit_id_sha256: string;
  status: "active" | "completed" | "failed";
}

interface JsonCompatibilityCampaignAuthorityEnv {}

export class JsonCompatibilityCampaignAuthority
  extends DurableObject<JsonCompatibilityCampaignAuthorityEnv> {
  constructor(
    ctx: DurableObjectState,
    env: JsonCompatibilityCampaignAuthorityEnv,
  ) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ensureSchema();
    });
  }

  async beginPhase(
    raw: JsonCompatibilityCampaignLeaseBeginV1,
  ): Promise<JsonCompatibilityCampaignLeaseBeginResult> {
    let input: JsonCompatibilityCampaignLeaseBeginV1;
    try {
      input = parseBegin(raw);
    } catch {
      return denied("invalid_campaign_authority_command");
    }
    const receiptSubject = {
      schemaVersion: 1 as const,
      contract: JSON_COMPATIBILITY_CAMPAIGN_LEASE_RECEIPT_CONTRACT,
      status: "phase_lease_acquired" as const,
      campaignIdSha256: input.campaignIdSha256,
      campaignBindingSha256: input.campaignBindingSha256,
      planDigestSha256: input.planDigestSha256,
      permitIdSha256: input.permitIdSha256,
      permitSubjectSha256: input.permitSubjectSha256,
      permitEnvelopeSha256: input.permitEnvelopeSha256,
      phaseOrdinal: input.phaseOrdinal,
      phaseId: input.phaseId,
      phaseExecutionId: input.phaseExecutionId,
      leaseIdSha256: input.leaseIdSha256,
      executorVersionId: input.executorVersionId,
      acquiredAt: input.acquiredAt,
      permitExpiresAt: input.permitExpiresAt,
      singleUsePermitPersisted: true as const,
      phaseOrderEnforced: true as const,
      concurrentPhaseRejected: true as const,
    };
    const receipt: JsonCompatibilityCampaignLeaseReceiptV1 = {
      ...receiptSubject,
      leaseReceiptSha256: await sha256Hex(canonicalJson(receiptSubject)),
    };

    return this.ctx.storage.transactionSync(() => {
      const consumed = this.readPermit(input.permitIdSha256);
      if (consumed !== null) return denied("campaign_permit_replayed");

      const current = this.readCampaign();
      if (current === null) {
        if (input.phaseOrdinal !== 1) {
          return denied("campaign_phase_order_conflict");
        }
        this.ctx.storage.sql.exec(
          `INSERT INTO json_compatibility_campaign_state (
             singleton, campaign_id_sha256, campaign_binding_sha256,
             plan_digest_sha256, next_phase_ordinal, status,
             active_permit_id_sha256, active_phase_ordinal,
             active_phase_execution_id, active_lease_id_sha256, updated_at
           ) VALUES (1, ?1, ?2, ?3, 1, 'active', NULL, NULL, NULL, NULL, ?4)`,
          input.campaignIdSha256,
          input.campaignBindingSha256,
          input.planDigestSha256,
          input.acquiredAt,
        );
      } else {
        if (
          current.campaign_id_sha256 !== input.campaignIdSha256
          || current.campaign_binding_sha256 !== input.campaignBindingSha256
          || current.plan_digest_sha256 !== input.planDigestSha256
        ) {
          return denied("campaign_binding_conflict");
        }
        if (current.status !== "active") {
          return denied("campaign_terminal");
        }
        if (current.active_permit_id_sha256 !== null) {
          return denied("campaign_lease_active");
        }
        if (current.next_phase_ordinal !== input.phaseOrdinal) {
          return denied("campaign_phase_order_conflict");
        }
      }

      this.ctx.storage.sql.exec(
        `INSERT INTO json_compatibility_campaign_permits (
           permit_id_sha256, permit_subject_sha256, permit_envelope_sha256,
           phase_ordinal, phase_id, phase_execution_id, lease_id_sha256,
           lease_receipt_sha256, status, acquired_at, permit_expires_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'active', ?9, ?10)`,
        input.permitIdSha256,
        input.permitSubjectSha256,
        input.permitEnvelopeSha256,
        input.phaseOrdinal,
        input.phaseId,
        input.phaseExecutionId,
        input.leaseIdSha256,
        receipt.leaseReceiptSha256,
        input.acquiredAt,
        input.permitExpiresAt,
      );
      this.ctx.storage.sql.exec(
        `UPDATE json_compatibility_campaign_state
            SET active_permit_id_sha256 = ?1,
                active_phase_ordinal = ?2,
                active_phase_execution_id = ?3,
                active_lease_id_sha256 = ?4,
                updated_at = ?5
          WHERE singleton = 1`,
        input.permitIdSha256,
        input.phaseOrdinal,
        input.phaseExecutionId,
        input.leaseIdSha256,
        input.acquiredAt,
      );
      return { ok: true as const, receipt };
    });
  }

  completePhase(
    raw: JsonCompatibilityCampaignLeaseCompleteV1,
  ): JsonCompatibilityCampaignLeaseTerminalResult {
    let input: JsonCompatibilityCampaignLeaseCompleteV1;
    try {
      input = parseComplete(raw);
    } catch {
      return denied("invalid_campaign_authority_command");
    }
    return this.ctx.storage.transactionSync(() => {
      const current = this.readCampaign();
      const permit = this.readPermit(input.permitIdSha256);
      if (!matchesActiveLease(current, permit, input)) {
        return denied("campaign_lease_conflict");
      }
      const campaignCompleted = input.phaseOrdinal === JSON_COMPATIBILITY_PHASE_IDS.length;
      this.ctx.storage.sql.exec(
        `UPDATE json_compatibility_campaign_permits
            SET status = 'completed', receipt_sha256 = ?1, terminal_at = ?2
          WHERE permit_id_sha256 = ?3 AND status = 'active'`,
        input.receiptSha256,
        input.completedAt,
        input.permitIdSha256,
      );
      this.ctx.storage.sql.exec(
        `UPDATE json_compatibility_campaign_state
            SET next_phase_ordinal = ?1,
                status = ?2,
                active_permit_id_sha256 = NULL,
                active_phase_ordinal = NULL,
                active_phase_execution_id = NULL,
                active_lease_id_sha256 = NULL,
                updated_at = ?3
          WHERE singleton = 1`,
        input.phaseOrdinal + 1,
        campaignCompleted ? "completed" : "active",
        input.completedAt,
      );
      return {
        ok: true as const,
        status: campaignCompleted
          ? "campaign_completed" as const
          : "phase_completed" as const,
      };
    });
  }

  failPhase(
    raw: JsonCompatibilityCampaignLeaseFailV1,
  ): JsonCompatibilityCampaignLeaseTerminalResult {
    let input: JsonCompatibilityCampaignLeaseFailV1;
    try {
      input = parseFail(raw);
    } catch {
      return denied("invalid_campaign_authority_command");
    }
    return this.ctx.storage.transactionSync(() => {
      const current = this.readCampaign();
      const permit = this.readPermit(input.permitIdSha256);
      if (!matchesActiveLease(current, permit, input)) {
        return denied("campaign_lease_conflict");
      }
      this.ctx.storage.sql.exec(
        `UPDATE json_compatibility_campaign_permits
            SET status = 'failed', failure_code = ?1, terminal_at = ?2
          WHERE permit_id_sha256 = ?3 AND status = 'active'`,
        input.failureCode,
        input.failedAt,
        input.permitIdSha256,
      );
      this.ctx.storage.sql.exec(
        `UPDATE json_compatibility_campaign_state
            SET status = 'failed', failure_code = ?1,
                active_permit_id_sha256 = NULL,
                active_phase_ordinal = NULL,
                active_phase_execution_id = NULL,
                active_lease_id_sha256 = NULL,
                updated_at = ?2
          WHERE singleton = 1`,
        input.failureCode,
        input.failedAt,
      );
      return { ok: true as const, status: "campaign_failed" as const };
    });
  }

  private ensureSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS json_compatibility_campaign_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        campaign_id_sha256 TEXT NOT NULL,
        campaign_binding_sha256 TEXT NOT NULL,
        plan_digest_sha256 TEXT NOT NULL,
        next_phase_ordinal INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'failed', 'completed')),
        active_permit_id_sha256 TEXT,
        active_phase_ordinal INTEGER,
        active_phase_execution_id TEXT,
        active_lease_id_sha256 TEXT,
        failure_code TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS json_compatibility_campaign_permits (
        permit_id_sha256 TEXT PRIMARY KEY,
        permit_subject_sha256 TEXT NOT NULL,
        permit_envelope_sha256 TEXT NOT NULL,
        phase_ordinal INTEGER NOT NULL,
        phase_id TEXT NOT NULL,
        phase_execution_id TEXT NOT NULL,
        lease_id_sha256 TEXT NOT NULL UNIQUE,
        lease_receipt_sha256 TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'failed')),
        acquired_at INTEGER NOT NULL,
        permit_expires_at INTEGER NOT NULL,
        receipt_sha256 TEXT,
        failure_code TEXT,
        terminal_at INTEGER
      );
    `);
  }

  private readCampaign(): CampaignStateRow | null {
    const rows = this.ctx.storage.sql.exec<CampaignStateRow>(
      `SELECT campaign_id_sha256, campaign_binding_sha256,
              plan_digest_sha256, next_phase_ordinal, status,
              active_permit_id_sha256, active_phase_ordinal,
              active_phase_execution_id, active_lease_id_sha256
         FROM json_compatibility_campaign_state WHERE singleton = 1`,
    ).toArray();
    return rows[0] ?? null;
  }

  private readPermit(permitIdSha256: string): PermitRow | null {
    const rows = this.ctx.storage.sql.exec<PermitRow>(
      `SELECT permit_id_sha256, status
         FROM json_compatibility_campaign_permits
        WHERE permit_id_sha256 = ?1`,
      permitIdSha256,
    ).toArray();
    return rows[0] ?? null;
  }
}

function parseBegin(input: unknown): JsonCompatibilityCampaignLeaseBeginV1 {
  const value = record(input);
  exactKeys(value, [
    "schemaVersion", "contract", "campaignIdSha256",
    "campaignBindingSha256", "planDigestSha256", "permitIdSha256",
    "permitSubjectSha256", "permitEnvelopeSha256", "permitExpiresAt",
    "phaseOrdinal", "phaseId", "phaseExecutionId", "leaseIdSha256",
    "executorVersionId", "acquiredAt",
  ]);
  literal(value.schemaVersion, 1);
  literal(
    value.contract,
    "cinatoken-container-runtime-json-compatibility-campaign-lease-begin-v1",
  );
  const phaseOrdinal = integer(value.phaseOrdinal, 1, 4) as JsonCompatibilityPhaseOrdinal;
  const phaseId = phase(value.phaseId, phaseOrdinal);
  const acquiredAt = integer(value.acquiredAt, 1, Number.MAX_SAFE_INTEGER);
  const permitExpiresAt = integer(
    value.permitExpiresAt,
    acquiredAt + 1,
    Number.MAX_SAFE_INTEGER,
  );
  return {
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-json-compatibility-campaign-lease-begin-v1",
    campaignIdSha256: sha256(value.campaignIdSha256),
    campaignBindingSha256: sha256(value.campaignBindingSha256),
    planDigestSha256: sha256(value.planDigestSha256),
    permitIdSha256: sha256(value.permitIdSha256),
    permitSubjectSha256: sha256(value.permitSubjectSha256),
    permitEnvelopeSha256: sha256(value.permitEnvelopeSha256),
    permitExpiresAt,
    phaseOrdinal,
    phaseId,
    phaseExecutionId: token(value.phaseExecutionId),
    leaseIdSha256: sha256(value.leaseIdSha256),
    executorVersionId: token(value.executorVersionId),
    acquiredAt,
  };
}

function parseComplete(
  input: unknown,
): JsonCompatibilityCampaignLeaseCompleteV1 {
  const value = record(input);
  exactKeys(value, [
    "schemaVersion", "contract", "campaignIdSha256", "permitIdSha256",
    "phaseOrdinal", "phaseExecutionId", "leaseIdSha256", "receiptSha256",
    "completedAt",
  ]);
  literal(value.schemaVersion, 1);
  literal(
    value.contract,
    "cinatoken-container-runtime-json-compatibility-campaign-lease-complete-v1",
  );
  return {
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-json-compatibility-campaign-lease-complete-v1",
    campaignIdSha256: sha256(value.campaignIdSha256),
    permitIdSha256: sha256(value.permitIdSha256),
    phaseOrdinal: integer(value.phaseOrdinal, 1, 4) as JsonCompatibilityPhaseOrdinal,
    phaseExecutionId: token(value.phaseExecutionId),
    leaseIdSha256: sha256(value.leaseIdSha256),
    receiptSha256: sha256(value.receiptSha256),
    completedAt: integer(value.completedAt, 1, Number.MAX_SAFE_INTEGER),
  };
}

function parseFail(input: unknown): JsonCompatibilityCampaignLeaseFailV1 {
  const value = record(input);
  exactKeys(value, [
    "schemaVersion", "contract", "campaignIdSha256", "permitIdSha256",
    "phaseOrdinal", "phaseExecutionId", "leaseIdSha256", "failureCode",
    "failedAt",
  ]);
  literal(value.schemaVersion, 1);
  literal(
    value.contract,
    "cinatoken-container-runtime-json-compatibility-campaign-lease-fail-v1",
  );
  return {
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-json-compatibility-campaign-lease-fail-v1",
    campaignIdSha256: sha256(value.campaignIdSha256),
    permitIdSha256: sha256(value.permitIdSha256),
    phaseOrdinal: integer(value.phaseOrdinal, 1, 4) as JsonCompatibilityPhaseOrdinal,
    phaseExecutionId: token(value.phaseExecutionId),
    leaseIdSha256: sha256(value.leaseIdSha256),
    failureCode: token(value.failureCode),
    failedAt: integer(value.failedAt, 1, Number.MAX_SAFE_INTEGER),
  };
}

function matchesActiveLease(
  current: CampaignStateRow | null,
  permit: PermitRow | null,
  input: {
    campaignIdSha256: string;
    permitIdSha256: string;
    phaseOrdinal: JsonCompatibilityPhaseOrdinal;
    phaseExecutionId: string;
    leaseIdSha256: string;
  },
): boolean {
  return current !== null
    && current.status === "active"
    && current.campaign_id_sha256 === input.campaignIdSha256
    && current.active_permit_id_sha256 === input.permitIdSha256
    && current.active_phase_ordinal === input.phaseOrdinal
    && current.active_phase_execution_id === input.phaseExecutionId
    && current.active_lease_id_sha256 === input.leaseIdSha256
    && permit?.status === "active";
}

function denied(
  code: JsonCompatibilityCampaignAuthorityErrorCode,
): { readonly ok: false; readonly error: { readonly code: JsonCompatibilityCampaignAuthorityErrorCode } } {
  return { ok: false, error: { code } };
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid campaign authority command");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (
    JSON.stringify(Object.keys(value).sort())
    !== JSON.stringify([...expected].sort())
  ) {
    throw new Error("invalid campaign authority command fields");
  }
}

function literal<T>(value: unknown, expected: T): T {
  if (value !== expected) throw new Error("invalid campaign authority literal");
  return expected;
}

function sha256(value: unknown): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error("invalid SHA-256 digest");
  }
  return value;
}

function token(value: unknown): string {
  if (typeof value !== "string" || !SAFE_TOKEN.test(value)) {
    throw new Error("invalid safe token");
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

function phase(
  value: unknown,
  ordinal: JsonCompatibilityPhaseOrdinal,
): JsonCompatibilityPhaseId {
  if (value !== JSON_COMPATIBILITY_PHASE_IDS[ordinal - 1]) {
    throw new Error("phase ID does not match phase ordinal");
  }
  return value as JsonCompatibilityPhaseId;
}
