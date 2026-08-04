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

export const JSON_COMPATIBILITY_PERMIT_ISSUANCE_RECEIPT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-permit-issuance-receipt-v1" as const;

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface JsonCompatibilityPermitIssuanceRecordV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-permit-issuance-record-v1";
  readonly campaignIdSha256: string;
  readonly campaignBindingSha256: string;
  readonly planDigestSha256: string;
  readonly phaseOrdinal: JsonCompatibilityPhaseOrdinal;
  readonly phaseId: JsonCompatibilityPhaseId;
  readonly phaseExecutionId: string;
  readonly issueIntentSha256: string;
  readonly authorityRequestIdSha256: string;
  readonly permitIdSha256: string;
  readonly permitSubjectSha256: string;
  readonly permitEnvelopeSha256: string;
  readonly issuerVersionId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}
export interface JsonCompatibilityPermitIssuanceReceiptV1 {
  readonly schemaVersion: 1;
  readonly contract: typeof JSON_COMPATIBILITY_PERMIT_ISSUANCE_RECEIPT_CONTRACT;
  readonly status: "permit_issuance_recorded";
  readonly campaignIdSha256: string;
  readonly campaignBindingSha256: string;
  readonly planDigestSha256: string;
  readonly phaseOrdinal: JsonCompatibilityPhaseOrdinal;
  readonly phaseId: JsonCompatibilityPhaseId;
  readonly phaseExecutionId: string;
  readonly issueIntentSha256: string;
  readonly authorityRequestIdSha256: string;
  readonly permitIdSha256: string;
  readonly permitSubjectSha256: string;
  readonly permitEnvelopeSha256: string;
  readonly issuerVersionId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly onePermitPerPhasePersisted: true;
  readonly phaseIssuanceOrderEnforced: true;
  readonly ambiguousRetryRejected: true;
  readonly receiptSha256: string;
}

export type JsonCompatibilityPermitIssuanceErrorCode =
  | "invalid_permit_issuance_record"
  | "permit_issuance_replayed"
  | "permit_issuance_binding_conflict"
  | "permit_issuance_phase_conflict";

export type JsonCompatibilityPermitIssuanceResult =
  | { readonly ok: true; readonly receipt: JsonCompatibilityPermitIssuanceReceiptV1 }
  | {
      readonly ok: false;
      readonly error: { readonly code: JsonCompatibilityPermitIssuanceErrorCode };
    };

interface CampaignRow {
  [key: string]: string | number;
  campaign_id_sha256: string;
  campaign_binding_sha256: string;
  plan_digest_sha256: string;
  next_phase_ordinal: number;
}

interface JsonCompatibilityPermitIssuanceAuthorityEnv {}

export class JsonCompatibilityPermitIssuanceAuthority
  extends DurableObject<JsonCompatibilityPermitIssuanceAuthorityEnv> {
  constructor(
    ctx: DurableObjectState,
    env: JsonCompatibilityPermitIssuanceAuthorityEnv,
  ) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ensureSchema();
    });
  }

  async recordIssuance(
    raw: JsonCompatibilityPermitIssuanceRecordV1,
  ): Promise<JsonCompatibilityPermitIssuanceResult> {
    let input: JsonCompatibilityPermitIssuanceRecordV1;
    try {
      input = parseRecord(raw);
    } catch {
      return denied("invalid_permit_issuance_record");
    }
    const receiptSubject = {
      schemaVersion: 1 as const,
      contract: JSON_COMPATIBILITY_PERMIT_ISSUANCE_RECEIPT_CONTRACT,
      status: "permit_issuance_recorded" as const,
      campaignIdSha256: input.campaignIdSha256,
      campaignBindingSha256: input.campaignBindingSha256,
      planDigestSha256: input.planDigestSha256,
      phaseOrdinal: input.phaseOrdinal,
      phaseId: input.phaseId,
      phaseExecutionId: input.phaseExecutionId,
      issueIntentSha256: input.issueIntentSha256,
      authorityRequestIdSha256: input.authorityRequestIdSha256,
      permitIdSha256: input.permitIdSha256,
      permitSubjectSha256: input.permitSubjectSha256,
      permitEnvelopeSha256: input.permitEnvelopeSha256,
      issuerVersionId: input.issuerVersionId,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
      onePermitPerPhasePersisted: true as const,
      phaseIssuanceOrderEnforced: true as const,
      ambiguousRetryRejected: true as const,
    };
    const receipt: JsonCompatibilityPermitIssuanceReceiptV1 = {
      ...receiptSubject,
      receiptSha256: await sha256Hex(canonicalJson(receiptSubject)),
    };

    return this.ctx.storage.transactionSync(() => {
      if (this.recordExists(input)) {
        return denied("permit_issuance_replayed");
      }
      const current = this.readCampaign();
      if (current === null) {
        if (input.phaseOrdinal !== 1) {
          return denied("permit_issuance_phase_conflict");
        }
        this.ctx.storage.sql.exec(
          `INSERT INTO json_compatibility_permit_issuance_campaign (
             singleton, campaign_id_sha256, campaign_binding_sha256,
             plan_digest_sha256, next_phase_ordinal, updated_at
           ) VALUES (1, ?1, ?2, ?3, 1, ?4)`,
          input.campaignIdSha256,
          input.campaignBindingSha256,
          input.planDigestSha256,
          input.issuedAt,
        );
      } else {
        if (
          current.campaign_id_sha256 !== input.campaignIdSha256
          || current.campaign_binding_sha256 !== input.campaignBindingSha256
          || current.plan_digest_sha256 !== input.planDigestSha256
        ) {
          return denied("permit_issuance_binding_conflict");
        }
        if (current.next_phase_ordinal !== input.phaseOrdinal) {
          return denied("permit_issuance_phase_conflict");
        }
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO json_compatibility_permit_issuance_records (
           phase_ordinal, phase_id, phase_execution_id, issue_intent_sha256,
           authority_request_id_sha256, permit_id_sha256,
           permit_subject_sha256, permit_envelope_sha256, issuer_version_id,
           issued_at, expires_at, receipt_sha256
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
        input.phaseOrdinal,
        input.phaseId,
        input.phaseExecutionId,
        input.issueIntentSha256,
        input.authorityRequestIdSha256,
        input.permitIdSha256,
        input.permitSubjectSha256,
        input.permitEnvelopeSha256,
        input.issuerVersionId,
        input.issuedAt,
        input.expiresAt,
        receipt.receiptSha256,
      );
      this.ctx.storage.sql.exec(
        `UPDATE json_compatibility_permit_issuance_campaign
            SET next_phase_ordinal = ?1, updated_at = ?2
          WHERE singleton = 1`,
        input.phaseOrdinal + 1,
        input.issuedAt,
      );
      return { ok: true as const, receipt };
    });
  }

  private ensureSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS json_compatibility_permit_issuance_campaign (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        campaign_id_sha256 TEXT NOT NULL,
        campaign_binding_sha256 TEXT NOT NULL,
        plan_digest_sha256 TEXT NOT NULL,
        next_phase_ordinal INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS json_compatibility_permit_issuance_records (
        phase_ordinal INTEGER PRIMARY KEY CHECK (phase_ordinal BETWEEN 1 AND 4),
        phase_id TEXT NOT NULL UNIQUE,
        phase_execution_id TEXT NOT NULL UNIQUE,
        issue_intent_sha256 TEXT NOT NULL UNIQUE,
        authority_request_id_sha256 TEXT NOT NULL UNIQUE,
        permit_id_sha256 TEXT NOT NULL UNIQUE,
        permit_subject_sha256 TEXT NOT NULL UNIQUE,
        permit_envelope_sha256 TEXT NOT NULL UNIQUE,
        issuer_version_id TEXT NOT NULL,
        issued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        receipt_sha256 TEXT NOT NULL UNIQUE
      );
    `);
  }

  private readCampaign(): CampaignRow | null {
    return this.ctx.storage.sql.exec<CampaignRow>(
      `SELECT campaign_id_sha256, campaign_binding_sha256,
              plan_digest_sha256, next_phase_ordinal
         FROM json_compatibility_permit_issuance_campaign
        WHERE singleton = 1`,
    ).toArray()[0] ?? null;
  }

  private recordExists(input: JsonCompatibilityPermitIssuanceRecordV1): boolean {
    const rows = this.ctx.storage.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count
         FROM json_compatibility_permit_issuance_records
        WHERE phase_ordinal = ?1 OR phase_execution_id = ?2
           OR issue_intent_sha256 = ?3 OR authority_request_id_sha256 = ?4
           OR permit_id_sha256 = ?5 OR permit_subject_sha256 = ?6
           OR permit_envelope_sha256 = ?7`,
      input.phaseOrdinal,
      input.phaseExecutionId,
      input.issueIntentSha256,
      input.authorityRequestIdSha256,
      input.permitIdSha256,
      input.permitSubjectSha256,
      input.permitEnvelopeSha256,
    ).one();
    return rows.count !== 0;
  }
}

function parseRecord(input: unknown): JsonCompatibilityPermitIssuanceRecordV1 {
  const value = object(input);
  exactKeys(value, [
    "schemaVersion", "contract", "campaignIdSha256", "campaignBindingSha256",
    "planDigestSha256", "phaseOrdinal", "phaseId", "phaseExecutionId",
    "issueIntentSha256", "authorityRequestIdSha256", "permitIdSha256",
    "permitSubjectSha256", "permitEnvelopeSha256", "issuerVersionId",
    "issuedAt", "expiresAt",
  ]);
  literal(value.schemaVersion, 1);
  literal(
    value.contract,
    "cinatoken-container-runtime-json-compatibility-permit-issuance-record-v1",
  );
  const phaseOrdinal = integer(value.phaseOrdinal, 1, 4) as JsonCompatibilityPhaseOrdinal;
  const phaseId = value.phaseId;
  if (phaseId !== JSON_COMPATIBILITY_PHASE_IDS[phaseOrdinal - 1]) {
    throw new Error("invalid phase");
  }
  const issuedAt = integer(value.issuedAt, 1, Number.MAX_SAFE_INTEGER);
  const expiresAt = integer(value.expiresAt, issuedAt + 1, Number.MAX_SAFE_INTEGER);
  return {
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-json-compatibility-permit-issuance-record-v1",
    campaignIdSha256: sha256(value.campaignIdSha256),
    campaignBindingSha256: sha256(value.campaignBindingSha256),
    planDigestSha256: sha256(value.planDigestSha256),
    phaseOrdinal,
    phaseId: phaseId as JsonCompatibilityPhaseId,
    phaseExecutionId: token(value.phaseExecutionId),
    issueIntentSha256: sha256(value.issueIntentSha256),
    authorityRequestIdSha256: sha256(value.authorityRequestIdSha256),
    permitIdSha256: sha256(value.permitIdSha256),
    permitSubjectSha256: sha256(value.permitSubjectSha256),
    permitEnvelopeSha256: sha256(value.permitEnvelopeSha256),
    issuerVersionId: token(value.issuerVersionId),
    issuedAt,
    expiresAt,
  };
}

function denied(
  code: JsonCompatibilityPermitIssuanceErrorCode,
): { readonly ok: false; readonly error: { readonly code: JsonCompatibilityPermitIssuanceErrorCode } } {
  return { ok: false, error: { code } };
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid record");
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
