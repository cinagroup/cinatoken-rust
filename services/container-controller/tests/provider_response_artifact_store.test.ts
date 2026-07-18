import { describe, expect, test } from "bun:test";

import {
  PROVIDER_RESPONSE_ARTIFACT_CONTRACT,
  RESPONSE_ARTIFACT_STORAGE_CONTENT_TYPE_FALLBACK,
  persistClientResponseArtifact,
  persistProviderResponseArtifacts,
  persistRawProviderEvidence,
  preflightProviderResponseArtifactStore,
  readProviderResponseArtifactRecoveryState,
  type ProviderResponseArtifactPersistenceBoundary,
} from "../src/provider_response_artifact_store";
import {
  PROVIDER_RESPONSE_V3_EGRESS_PROFILE,
  PROVIDER_RESPONSE_V3_INTERPRETER_CONTRACT,
  PROVIDER_RESPONSE_V3_INTERPRETER_SOURCE_COMMIT,
  parseProviderResponseV3,
  type ProviderResponseClassV3,
  type ProviderResponseEnvelopeV3,
  type VerifiedProviderResponseV3,
} from "../src/provider_response_v3";
import {
  R2_CLIENT_ARTIFACT_KEY_PREFIX,
  R2_PROVIDER_EVIDENCE_KEY_PREFIX,
  R2_RESULT_KEY_PREFIX,
  type D1AdmissionSnapshot,
  type ProviderUsageReceipt,
  type StorageGatewayEnvironment,
} from "../src/storage_gateway";

const encoder = new TextEncoder();
const operationId = "artifact-operation-1";
const providerOperationId = "artifact-provider-operation-1";
const workerVersionId = "artifact-worker-version-1";
const requestSha256 = "1".repeat(64);
const admissionSha256 = "2".repeat(64);
const atomicAdmissionSha256 = "3".repeat(64);
const completedAt = 1_784_313_600_000;
const completedAtSeconds = completedAt / 1_000;

const RAW_COLUMNS = [
  "operation_id", "reservation_key", "owner_generation", "attempt_generation",
  "provider_operation_id", "atomic_admission_sha256", "admission_sha256",
  "request_sha256", "channel_id", "selected_group", "model_name", "endpoint_path",
  "egress_profile", "egress_worker_version_id", "raw_response_status",
  "raw_response_content_type", "raw_response_headers_json",
  "raw_response_headers_sha256", "raw_response_object_key",
  "raw_response_object_version", "raw_response_sha256", "raw_response_size",
  "provider_request_id", "provider_completed_at", "interpreter_source_commit",
  "response_contract", "provider_response_evidence_sha256", "recorded_at",
] as const;

const CLIENT_COLUMNS = [
  "operation_id", "owner_generation", "attempt_generation",
  "provider_response_evidence_sha256", "response_contract", "response_class",
  "client_response_status", "client_response_content_type",
  "client_response_headers_json", "client_response_headers_sha256",
  "client_response_object_key", "client_response_object_version",
  "client_response_sha256", "client_response_size",
  "provider_usage_receipt_sha256", "client_response_artifact_sha256", "created_at",
] as const;

const RECEIPT_COLUMNS = [
  "operation_id", "reservation_key", "owner_generation", "attempt_generation",
  "provider_operation_id", "admission_sha256", "request_sha256", "egress_profile",
  "egress_worker_version_id", "billing_kind", "billing_contract_hash",
  "billing_snapshot_sha256", "provider_response_status", "provider_response_sha256",
  "provider_request_id", "provider_completed_at", "result_object_key",
  "result_object_version", "result_sha256", "result_size", "result_content_type",
  "usage_schema_version", "usage_parser_contract", "usage_normalization_contract",
  "usage_present", "reported_usage_fields", "usage_estimated", "usage_receipt_json",
  "usage_receipt_sha256", "persisted_at",
] as const;

interface StoredR2Object {
  key: string;
  version: string;
  bytes: Uint8Array;
  size: number;
  contentType: string;
  sha256: string;
  customMetadata: Record<string, string>;
}

class InMemoryR2 {
  readonly objects = new Map<string, StoredR2Object>();
  readonly createCounts = new Map<string, number>();
  putCalls = 0;

  async put(
    key: string,
    value: unknown,
    options: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
      sha256?: string;
    },
  ): Promise<R2Object | null> {
    this.putCalls += 1;
    if (this.objects.has(key)) return null;
    const bytes = await r2ValueBytes(value);
    const sha256 = options.sha256 ?? await sha256Hex(bytes);
    if ((await sha256Hex(bytes)) !== sha256) throw new Error("R2 checksum mismatch");
    const stored: StoredR2Object = {
      key,
      version: `artifact-version-${this.objects.size + 1}`,
      bytes: bytes.slice(),
      size: bytes.byteLength,
      contentType: options.httpMetadata?.contentType ?? "",
      sha256,
      customMetadata: { ...(options.customMetadata ?? {}) },
    };
    this.objects.set(key, stored);
    this.createCounts.set(key, (this.createCounts.get(key) ?? 0) + 1);
    return r2Object(stored);
  }

  async head(key: string): Promise<R2Object | null> {
    const stored = this.objects.get(key);
    return stored === undefined ? null : r2Object(stored);
  }

  seedConflict(key: string): void {
    this.objects.set(key, {
      key,
      version: "conflicting-version",
      bytes: encoder.encode("conflict"),
      size: 8,
      contentType: "application/json",
      sha256: "f".repeat(64),
      customMetadata: { conflict: "true" },
    });
  }
}

class FakeD1Statement {
  private values: unknown[] = [];

  constructor(
    private readonly database: InMemoryD1,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): FakeD1Statement {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return this.database.first(this.sql, this.values) as T | null;
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    return this.database.run(this.sql, this.values);
  }
}

class InMemoryD1 {
  readonly sessionModes: string[] = [];
  readonly events: string[];
  artifactSchema = artifactSchemaReadyRow();
  receiptSchema = receiptSchemaReadyRow();
  authorityReadable = true;
  rawRow: Record<string, unknown> | null = null;
  clientRow: Record<string, unknown> | null = null;
  receiptRow: Record<string, unknown> | null = null;
  rawInsertCount = 0;
  clientInsertCount = 0;
  receiptInsertCount = 0;

  constructor(events: string[]) {
    this.events = events;
  }

  prepare(sql: string): FakeD1Statement {
    return new FakeD1Statement(this, sql);
  }

  withSession(mode: string): InMemoryD1 {
    this.sessionModes.push(mode);
    return this;
  }

  first(sql: string, _values: unknown[]): Record<string, unknown> | null {
    if (sql.includes("AS raw_table_count")) return { ...this.artifactSchema };
    if (sql.includes("AS table_count") && sql.includes("provider_usage_receipts")) {
      return { ...this.receiptSchema };
    }
    if (sql.includes("FROM relay_container_atomic_admissions AS atomic")) {
      return this.authorityReadable
        ? {
            reservation_key: operationId,
            operation_id: operationId,
            owner_generation: 2,
            provider_attempt_generation: 1,
            atomic_admission_sha256: atomicAdmissionSha256,
            operation_admission_sha256: admissionSha256,
            response_artifact_contract: PROVIDER_RESPONSE_ARTIFACT_CONTRACT,
          }
        : null;
    }
    if (sql.includes("FROM relay_container_provider_response_evidence")) {
      return cloneRow(this.rawRow);
    }
    if (sql.includes("FROM relay_container_client_response_artifacts")) {
      return cloneRow(this.clientRow);
    }
    if (sql.includes("FROM relay_container_provider_usage_receipts")) {
      return cloneRow(this.receiptRow);
    }
    throw new Error(`unexpected D1 first: ${sql.slice(0, 80)}`);
  }

  run(
    sql: string,
    values: unknown[],
  ): { success: true; meta: { changes: number } } {
    if (sql.startsWith("INSERT OR IGNORE INTO relay_container_provider_response_evidence")) {
      if (this.rawRow !== null) return writeResult(0);
      this.rawRow = rowFromBindings(RAW_COLUMNS, values);
      this.rawInsertCount += 1;
      this.events.push("d1:raw");
      return writeResult(1);
    }
    if (sql.startsWith("INSERT OR IGNORE INTO relay_container_client_response_artifacts")) {
      if (this.clientRow !== null) return writeResult(0);
      this.clientRow = rowFromBindings(CLIENT_COLUMNS, values);
      this.clientInsertCount += 1;
      this.events.push("d1:client");
      return writeResult(1);
    }
    if (sql.startsWith("INSERT OR IGNORE INTO relay_container_provider_usage_receipts")) {
      if (this.receiptRow !== null) return writeResult(0);
      this.receiptRow = rowFromBindings(RECEIPT_COLUMNS, values);
      this.receiptInsertCount += 1;
      this.events.push("d1:receipt");
      return writeResult(1);
    }
    throw new Error(`unexpected D1 run: ${sql.slice(0, 80)}`);
  }
}

class RecordingR2 extends InMemoryR2 {
  constructor(private readonly events: string[]) {
    super();
  }

  override async put(
    key: string,
    value: unknown,
    options: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
      sha256?: string;
    },
  ): Promise<R2Object | null> {
    const existed = this.objects.has(key);
    const result = await super.put(key, value, options);
    if (!existed && result !== null) this.events.push(`r2:${namespaceForKey(key)}`);
    return result;
  }
}

interface Harness {
  env: StorageGatewayEnvironment;
  d1: InMemoryD1;
  r2: RecordingR2;
  events: string[];
  admission: D1AdmissionSnapshot;
}

function harness(): Harness {
  const events: string[] = [];
  const d1 = new InMemoryD1(events);
  const r2 = new RecordingR2(events);
  return {
    env: {
      CONTAINER_STORAGE_GATEWAY_ENABLED: "true",
      CONTAINER_STORAGE_RESULT_R2: r2 as unknown as Pick<R2Bucket, "head" | "put">,
      CONTAINER_STORAGE_ADMISSION_DB: d1 as unknown as NonNullable<
        StorageGatewayEnvironment["CONTAINER_STORAGE_ADMISSION_DB"]
      >,
    },
    d1,
    r2,
    events,
    admission: admissionSnapshot(),
  };
}

describe("provider response artifact preflight", () => {
  test("uses first-primary schema and atomic admission authority readback", async () => {
    const context = harness();
    const authority = await preflightProviderResponseArtifactStore(
      context.env,
      context.admission,
    );

    expect(authority.atomic_admission_sha256).toBe(atomicAdmissionSha256);
    expect(authority.response_artifact_contract).toBe(PROVIDER_RESPONSE_ARTIFACT_CONTRACT);
    expect(authority.recovery_state).toEqual({ kind: "none" });
    expect(context.d1.sessionModes).toEqual(["first-primary", "first-primary"]);
    expect(context.r2.putCalls).toBe(0);
  });

  test("fails closed with stable ProtocolError when 0052 schema is incomplete", async () => {
    const context = harness();
    context.d1.artifactSchema.required_trigger_count = 19;

    await expect(
      preflightProviderResponseArtifactStore(context.env, context.admission),
    ).rejects.toMatchObject({
      code: "provider_response_artifact_schema_unavailable",
      status: 503,
    });
    expect(context.r2.putCalls).toBe(0);
  });

  test("rejects a missing atomic admission identity without storage writes", async () => {
    const context = harness();
    context.d1.authorityReadable = false;

    await expect(
      preflightProviderResponseArtifactStore(context.env, context.admission),
    ).rejects.toMatchObject({
      code: "provider_response_artifact_authority_mismatch",
      status: 409,
    });
    expect(context.r2.putCalls).toBe(0);
  });
});

describe("provider response artifact pre-dispatch recovery state", () => {
  test("distinguishes raw_only so a gateway can quarantine without resend", async () => {
    const context = harness();
    const verified = await responseFixture({ responseClass: "typed_error" });
    const authority = await preflightProviderResponseArtifactStore(
      context.env,
      context.admission,
    );
    const persistedRaw = await persistRawProviderEvidence(
      context.env,
      authority,
      verified,
    );
    const r2CallsBeforeRecoveryRead = context.r2.putCalls;

    const refreshed = await readProviderResponseArtifactRecoveryState(
      context.env,
      authority,
    );
    const nextPreflight = await preflightProviderResponseArtifactStore(
      context.env,
      context.admission,
    );

    expect(refreshed).toEqual({
      kind: "raw_only",
      raw_manifest: persistedRaw.manifest,
      provider_status: 200,
      provider_response_evidence_sha256:
        verified.envelope.provider_response_evidence_sha256,
      recorded_at: completedAt,
    });
    expect(nextPreflight.recovery_state).toEqual(refreshed);
    expect(context.r2.putCalls).toBe(r2CallsBeforeRecoveryRead);
  });

  test("reconstructs a canonical complete attachment using D1 only", async () => {
    const context = harness();
    const verified = await responseFixture({
      responseClass: "http_error",
      providerStatus: 202,
      clientStatus: 202,
    });
    const authority = await preflightProviderResponseArtifactStore(
      context.env,
      context.admission,
    );
    const persisted = await persistProviderResponseArtifacts(
      context.env,
      authority,
      verified,
    );
    const r2CallsBeforeRecoveryRead = context.r2.putCalls;

    const recovered = await readProviderResponseArtifactRecoveryState(
      context.env,
      authority,
    );
    const nextPreflight = await preflightProviderResponseArtifactStore(
      context.env,
      context.admission,
    );

    expect(recovered.kind).toBe("complete");
    if (recovered.kind !== "complete") throw new Error("complete recovery missing");
    expect(recovered.attachment).toEqual(persisted.attachment);
    expect(recovered).toMatchObject({
      classification: "http_error",
      provider_status: 202,
      client_status: 202,
      status: "interpreted_reject",
      provider_usage_receipt_sha256: null,
    });
    expect(nextPreflight.recovery_state).toEqual(recovered);
    expect(context.r2.putCalls).toBe(r2CallsBeforeRecoveryRead);
  });

  test("reconstructs complete success with the frozen 0048 receipt digest", async () => {
    const context = harness();
    const verified = await responseFixture();
    const authority = await preflightProviderResponseArtifactStore(
      context.env,
      context.admission,
    );
    const persisted = await persistProviderResponseArtifacts(
      context.env,
      authority,
      verified,
    );
    const r2CallsBeforeRecoveryRead = context.r2.putCalls;

    const recovered = await readProviderResponseArtifactRecoveryState(
      context.env,
      authority,
    );

    expect(recovered.kind).toBe("complete");
    if (recovered.kind !== "complete") throw new Error("complete recovery missing");
    expect(recovered.attachment).toEqual(persisted.attachment);
    expect(recovered).toMatchObject({
      classification: "success",
      status: "succeeded",
      provider_usage_receipt_sha256: verified.usage_receipt_sha256,
    });
    expect(context.r2.putCalls).toBe(r2CallsBeforeRecoveryRead);
  });

  test("fails closed on client-only or attestation-corrupt D1 recovery rows", async () => {
    const clientOnly = harness();
    const verified = await responseFixture({ responseClass: "typed_error" });
    const clientOnlyAuthority = await preflightProviderResponseArtifactStore(
      clientOnly.env,
      clientOnly.admission,
    );
    await persistProviderResponseArtifacts(clientOnly.env, clientOnlyAuthority, verified);
    clientOnly.d1.rawRow = null;
    await expect(
      readProviderResponseArtifactRecoveryState(clientOnly.env, clientOnlyAuthority),
    ).rejects.toMatchObject({
      code: "provider_response_artifact_recovery_readback_invalid",
      status: 502,
    });

    const corrupt = harness();
    const corruptAuthority = await preflightProviderResponseArtifactStore(
      corrupt.env,
      corrupt.admission,
    );
    await persistProviderResponseArtifacts(corrupt.env, corruptAuthority, verified);
    if (corrupt.d1.clientRow === null) throw new Error("client fixture missing");
    corrupt.d1.clientRow.client_response_artifact_sha256 = "0".repeat(64);
    await expect(
      readProviderResponseArtifactRecoveryState(corrupt.env, corruptAuthority),
    ).rejects.toMatchObject({
      code: "provider_response_artifact_recovery_readback_invalid",
      status: 502,
    });
  });
});

describe("provider response artifact create, replay, and conflict", () => {
  test("creates then exactly replays both R2 objects and both D1 rows", async () => {
    const context = harness();
    const verified = await responseFixture({ responseClass: "typed_error" });
    const authority = await preflightProviderResponseArtifactStore(context.env, context.admission);

    const firstRaw = await persistRawProviderEvidence(context.env, authority, verified);
    const firstClient = await persistClientResponseArtifact(
      context.env,
      authority,
      verified,
      firstRaw,
    );
    const replayRaw = await persistRawProviderEvidence(context.env, authority, verified);
    const replayClient = await persistClientResponseArtifact(
      context.env,
      authority,
      verified,
      replayRaw,
    );

    expect(firstRaw.r2_replayed).toBe(false);
    expect(firstRaw.d1_replayed).toBe(false);
    expect(firstClient.client_r2_replayed).toBe(false);
    expect(firstClient.client_d1_replayed).toBe(false);
    expect(replayRaw.r2_replayed).toBe(true);
    expect(replayRaw.d1_replayed).toBe(true);
    expect(replayClient.client_r2_replayed).toBe(true);
    expect(replayClient.client_d1_replayed).toBe(true);
    expect(context.d1.rawInsertCount).toBe(1);
    expect(context.d1.clientInsertCount).toBe(1);
    expect(context.d1.receiptInsertCount).toBe(0);
    expect(totalR2Creates(context.r2)).toBe(2);
  });

  test("reports raw and client R2 create-only conflicts as 409", async () => {
    const rawContext = harness();
    const verified = await responseFixture({ responseClass: "typed_error" });
    const rawAuthority = await preflightProviderResponseArtifactStore(
      rawContext.env,
      rawContext.admission,
    );
    rawContext.r2.seedConflict(rawObjectKey(verified));
    await expect(
      persistRawProviderEvidence(rawContext.env, rawAuthority, verified),
    ).rejects.toMatchObject({ code: "provider_response_evidence_conflict", status: 409 });
    expect(rawContext.d1.rawRow).toBeNull();

    const clientContext = harness();
    const clientAuthority = await preflightProviderResponseArtifactStore(
      clientContext.env,
      clientContext.admission,
    );
    const raw = await persistRawProviderEvidence(
      clientContext.env,
      clientAuthority,
      verified,
    );
    clientContext.r2.seedConflict(clientObjectKey(verified));
    await expect(
      persistClientResponseArtifact(
        clientContext.env,
        clientAuthority,
        verified,
        raw,
      ),
    ).rejects.toMatchObject({ code: "client_response_artifact_conflict", status: 409 });
    expect(clientContext.d1.clientRow).toBeNull();
    expect([...clientContext.r2.objects.keys()].some((key) => key.startsWith(`${R2_RESULT_KEY_PREFIX}/`)))
      .toBe(false);
  });

  test("accepts only field-identical D1 replay and rejects raw/client drift", async () => {
    const rawContext = harness();
    const verified = await responseFixture({ responseClass: "typed_error" });
    const rawAuthority = await preflightProviderResponseArtifactStore(
      rawContext.env,
      rawContext.admission,
    );
    await persistRawProviderEvidence(rawContext.env, rawAuthority, verified);
    if (rawContext.d1.rawRow === null) throw new Error("raw fixture missing");
    rawContext.d1.rawRow.raw_response_headers_sha256 = "a".repeat(64);
    await expect(
      persistRawProviderEvidence(rawContext.env, rawAuthority, verified),
    ).rejects.toMatchObject({ code: "provider_response_evidence_conflict", status: 409 });

    const clientContext = harness();
    const clientAuthority = await preflightProviderResponseArtifactStore(
      clientContext.env,
      clientContext.admission,
    );
    await persistProviderResponseArtifacts(clientContext.env, clientAuthority, verified);
    if (clientContext.d1.clientRow === null) throw new Error("client fixture missing");
    clientContext.d1.clientRow.client_response_status = 201;
    await expect(
      persistProviderResponseArtifacts(clientContext.env, clientAuthority, verified),
    ).rejects.toMatchObject({ code: "client_response_artifact_conflict", status: 409 });
  });
});

describe("provider response artifact classification and compatibility", () => {
  for (const scenario of [
    { responseClass: "typed_error" as const, providerStatus: 200, clientStatus: 200 },
    { responseClass: "http_error" as const, providerStatus: 202, clientStatus: 202 },
    { responseClass: "invalid_body" as const, providerStatus: 200, clientStatus: 500 },
  ]) {
    test(`persists ${scenario.responseClass} without a legacy result or receipt`, async () => {
      const context = harness();
      const verified = await responseFixture(scenario);
      const authority = await preflightProviderResponseArtifactStore(
        context.env,
        context.admission,
      );
      const result = await persistProviderResponseArtifacts(context.env, authority, verified);

      expect(result.status).toBe("interpreted_reject");
      expect(result.classification).toBe(scenario.responseClass);
      expect(result.provider_status).toBe(scenario.providerStatus);
      expect(result.client_status).toBe(scenario.clientStatus);
      expect(result.provider_usage_receipt_sha256).toBeNull();
      expect(result.compatibility_result).toBeNull();
      expect(result.attachment).toMatchObject({
        status: "interpreted_reject",
        response_class: scenario.responseClass,
        provider_usage_receipt_sha256: null,
      });
      expect(context.d1.receiptInsertCount).toBe(0);
      expect([...context.r2.objects.keys()].some((key) => key.startsWith(`${R2_RESULT_KEY_PREFIX}/`)))
        .toBe(false);
    });
  }

  test("writes a byte-identical success compatibility result and receipt before client D1", async () => {
    const context = harness();
    const verified = await responseFixture();
    const authority = await preflightProviderResponseArtifactStore(context.env, context.admission);
    const result = await persistProviderResponseArtifacts(context.env, authority, verified);

    const rawObject = requireStored(context.r2, result.raw_manifest.object_key);
    const clientObject = requireStored(context.r2, result.client_manifest.object_key);
    const legacy = requireStored(context.r2, requireNonNull(result.compatibility_result).object_key);
    expect(rawObject.bytes).toEqual(verified.raw_body);
    expect(clientObject.bytes).toEqual(verified.client_body);
    expect(legacy.bytes).toEqual(verified.raw_body);
    expect(legacy.contentType).toBe("application/json");
    expect(legacy.customMetadata.content_type).toBe("application/json");
    expect(result.compatibility_result?.content_type).toBe("application/json");
    expect(result.compatibility_result?.object_key.startsWith(`${R2_RESULT_KEY_PREFIX}/`)).toBe(true);
    expect(result.compatibility_result?.object_key).not.toBe(result.client_manifest.object_key);
    expect(result.provider_usage_receipt_sha256).toBe(verified.usage_receipt_sha256);
    expect(context.events).toEqual([
      "r2:raw",
      "d1:raw",
      "r2:client",
      "r2:legacy",
      "d1:receipt",
      "d1:client",
    ]);
  });

  test("normalizes the success compatibility alias content type without changing raw evidence", async () => {
    const context = harness();
    const verified = await responseFixture({
      rawHeaders: {
        "content-type": "application/json; charset=utf-8",
        "x-request-id": "request-artifact-charset",
      },
    });
    const authority = await preflightProviderResponseArtifactStore(context.env, context.admission);
    const result = await persistProviderResponseArtifacts(context.env, authority, verified);

    expect(result.raw_manifest.content_type).toBe("application/json; charset=utf-8");
    expect(result.compatibility_result?.content_type).toBe("application/json");
    expect(context.d1.receiptRow?.result_content_type).toBe("application/json");
  });

  test("rejects receiptless success before any raw evidence write", async () => {
    const context = harness();
    const verified = await responseFixture({ includeReceipt: false });
    const authority = await preflightProviderResponseArtifactStore(context.env, context.admission);

    await expect(
      persistRawProviderEvidence(context.env, authority, verified),
    ).rejects.toMatchObject({
      code: "provider_response_success_receipt_required",
      status: 409,
    });
    expect(context.r2.putCalls).toBe(0);
    expect(context.d1.rawRow).toBeNull();
  });

  test("stores empty raw evidence with metadata fallback while D1 remains null", async () => {
    const context = harness();
    const verified = await responseFixture({
      responseClass: "invalid_body",
      rawBody: new Uint8Array(),
      clientBody: encoder.encode("{}"),
      rawHeaders: {},
      rawContentType: null,
    });
    const authority = await preflightProviderResponseArtifactStore(context.env, context.admission);
    const result = await persistProviderResponseArtifacts(context.env, authority, verified);

    const rawObject = requireStored(context.r2, result.raw_manifest.object_key);
    expect(rawObject.bytes.byteLength).toBe(0);
    expect(rawObject.contentType).toBe(RESPONSE_ARTIFACT_STORAGE_CONTENT_TYPE_FALLBACK);
    expect(result.raw_manifest.content_type).toBe(RESPONSE_ARTIFACT_STORAGE_CONTENT_TYPE_FALLBACK);
    expect(context.d1.rawRow?.raw_response_content_type).toBeNull();
    expect(result.client_manifest.size).toBe(2);
  });

  test("accepts the exact 4 MiB client artifact boundary", async () => {
    const context = harness();
    const clientBody = new Uint8Array(4_194_304);
    clientBody[0] = 0x7b;
    clientBody[clientBody.length - 1] = 0x7d;
    const verified = await responseFixture({
      responseClass: "invalid_body",
      rawBody: new Uint8Array(),
      clientBody,
      rawHeaders: {},
      rawContentType: null,
    });
    const authority = await preflightProviderResponseArtifactStore(context.env, context.admission);
    const result = await persistProviderResponseArtifacts(context.env, authority, verified);

    expect(result.client_manifest.size).toBe(4_194_304);
    expect(requireStored(context.r2, result.client_manifest.object_key).bytes.byteLength)
      .toBe(4_194_304);
  });
});

describe("provider response artifact crash-boundary reentry", () => {
  const boundaries: ProviderResponseArtifactPersistenceBoundary[] = [
    "before_raw_r2",
    "after_raw_r2",
    "before_raw_d1_insert",
    "after_raw_d1_insert",
    "after_raw_d1_readback",
    "before_client_r2",
    "after_client_r2",
    "before_compatibility_r2",
    "after_compatibility_r2",
    "before_usage_receipt_d1",
    "after_usage_receipt_d1",
    "before_client_d1_insert",
    "after_client_d1_insert",
    "after_client_d1_readback",
  ];

  for (const boundary of boundaries) {
    test(`reenters ${boundary} with one durable create per identity`, async () => {
      const context = harness();
      const verified = await responseFixture();
      const authority = await preflightProviderResponseArtifactStore(
        context.env,
        context.admission,
      );
      let interrupted = false;
      await expect(
        persistProviderResponseArtifacts(context.env, authority, verified, {
          onBoundary(current) {
            if (!interrupted && current === boundary) {
              interrupted = true;
              throw new Error(`crash:${boundary}`);
            }
          },
        }),
      ).rejects.toThrow(`crash:${boundary}`);

      const recovered = await persistProviderResponseArtifacts(
        context.env,
        authority,
        verified,
      );
      expect(recovered.status).toBe("succeeded");
      expect(totalR2Creates(context.r2)).toBe(3);
      expect(context.d1.rawInsertCount).toBe(1);
      expect(context.d1.receiptInsertCount).toBe(1);
      expect(context.d1.clientInsertCount).toBe(1);
      expect(context.events).toEqual([
        "r2:raw",
        "d1:raw",
        "r2:client",
        "r2:legacy",
        "d1:receipt",
        "d1:client",
      ]);
    });
  }
});

interface FixtureOptions {
  responseClass?: ProviderResponseClassV3;
  providerStatus?: number;
  clientStatus?: number;
  rawBody?: Uint8Array;
  clientBody?: Uint8Array;
  rawHeaders?: Record<string, string>;
  rawContentType?: string | null;
  includeReceipt?: boolean;
}

async function responseFixture(
  options: FixtureOptions = {},
): Promise<VerifiedProviderResponseV3> {
  const responseClass = options.responseClass ?? "success";
  const providerStatus = options.providerStatus ?? (responseClass === "http_error" ? 500 : 200);
  const clientStatus = options.clientStatus ??
    (responseClass === "invalid_body" ? 500 : providerStatus);
  const auditStatus = responseClass === "success"
    ? 200
    : responseClass === "http_error" && providerStatus >= 400
      ? providerStatus
      : 500;
  const rawBody = options.rawBody ?? encoder.encode(
    '{"id":"chatcmpl-artifact","usage":{"prompt_tokens":7,"completion_tokens":5,"total_tokens":12}}',
  );
  const clientBody = options.clientBody ??
    (responseClass === "success" ? rawBody : encoder.encode('{"error":{"message":"failed"}}'));
  const rawHeaders = options.rawHeaders ?? {
    "content-type": "application/json",
    "x-request-id": "request-artifact-1",
  };
  const rawContentType = Object.prototype.hasOwnProperty.call(options, "rawContentType")
    ? options.rawContentType ?? null
    : rawHeaders["content-type"] ?? null;
  const rawHeadersJson = canonicalHeaders(rawHeaders);
  const clientHeaders = responseClass === "success"
    ? Object.fromEntries(Object.entries({
        ...rawHeaders,
        "cache-control": "no-store",
        "content-type": "application/json",
      }).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
    : { "cache-control": "no-store", "content-type": "application/json" };
  const clientHeadersJson = canonicalHeaders(clientHeaders);
  const rawSha256 = await sha256Hex(rawBody);
  const clientSha256 = await sha256Hex(clientBody);
  const providerRequestId = rawHeaders["x-request-id"] ??
    rawHeaders["openai-request-id"] ?? rawHeaders["request-id"] ?? null;
  const identity = {
    operation_id: operationId,
    owner_generation: 2,
    attempt_generation: 1,
    provider_operation_id: providerOperationId,
    request_sha256: requestSha256,
    egress_profile: PROVIDER_RESPONSE_V3_EGRESS_PROFILE,
    egress_worker_version_id: workerVersionId,
  } as const;
  const interpretation = {
    contract: PROVIDER_RESPONSE_V3_INTERPRETER_CONTRACT,
    source_commit: PROVIDER_RESPONSE_V3_INTERPRETER_SOURCE_COMMIT,
    response_class: responseClass,
    provider_status: providerStatus,
    client_status: clientStatus,
    audit_status: auditStatus,
  } as const;
  const receipt = responseClass === "success" && options.includeReceipt !== false
    ? usageReceipt(providerStatus, rawSha256, providerRequestId)
    : null;
  const receiptJson = receipt === null ? null : JSON.stringify(receipt);
  const receiptSha256 = receiptJson === null ? null : await sha256Hex(encoder.encode(receiptJson));
  const providerEvidenceSha256 = await sha256Hex(encoder.encode(JSON.stringify({
    contract: "cinatoken-provider-evidence-attestation-v1",
    identity,
    interpretation,
    raw: {
      content_type: rawContentType,
      headers_length: encoder.encode(rawHeadersJson).byteLength,
      headers_sha256: await sha256Hex(encoder.encode(rawHeadersJson)),
      body_length: rawBody.byteLength,
      body_sha256: rawSha256,
      provider_request_id: providerRequestId,
      completed_at: completedAt,
    },
  })));
  const bodySameAsRaw = bytesEqual(rawBody, clientBody);
  const clientArtifactSha256 = await sha256Hex(encoder.encode(JSON.stringify({
    contract: "cinatoken-client-response-attestation-v1",
    identity,
    provider_response_evidence_sha256: providerEvidenceSha256,
    interpretation,
    client: {
      content_type: "application/json",
      headers_length: encoder.encode(clientHeadersJson).byteLength,
      headers_sha256: await sha256Hex(encoder.encode(clientHeadersJson)),
      body_length: clientBody.byteLength,
      body_sha256: clientSha256,
      body_same_as_raw: bodySameAsRaw,
    },
    usage_receipt_sha256: receiptSha256,
  })));
  const envelope: ProviderResponseEnvelopeV3 = {
    protocol_version: 3,
    identity,
    interpretation,
    raw: {
      content_type: rawContentType,
      headers_json: rawHeadersJson,
      headers_length: encoder.encode(rawHeadersJson).byteLength,
      headers_sha256: await sha256Hex(encoder.encode(rawHeadersJson)),
      body_length: rawBody.byteLength,
      body_sha256: rawSha256,
      body_base64: base64UrlNoPad(rawBody),
      provider_request_id: providerRequestId,
      completed_at: completedAt,
    },
    client: {
      content_type: "application/json",
      headers_json: clientHeadersJson,
      headers_length: encoder.encode(clientHeadersJson).byteLength,
      headers_sha256: await sha256Hex(encoder.encode(clientHeadersJson)),
      body_length: clientBody.byteLength,
      body_sha256: clientSha256,
      body_same_as_raw: bodySameAsRaw,
      body_base64: bodySameAsRaw ? null : base64UrlNoPad(clientBody),
    },
    usage_receipt: receipt,
    provider_response_evidence_sha256: providerEvidenceSha256,
    client_response_artifact_sha256: clientArtifactSha256,
  };
  return parseProviderResponseV3(encoder.encode(JSON.stringify(envelope)));
}

function usageReceipt(
  providerStatus: number,
  rawSha256: string,
  providerRequestId: string | null,
): ProviderUsageReceipt {
  return {
    schema_version: 1,
    parser_contract: "openai-chat-completions-usage-v1",
    normalization_contract: "billing-token-normalization-v1",
    source: "provider_response",
    estimated: false,
    operation_id: operationId,
    owner_generation: 2,
    attempt_generation: 1,
    provider_operation_id: providerOperationId,
    request_sha256: requestSha256,
    egress_profile: PROVIDER_RESPONSE_V3_EGRESS_PROFILE,
    egress_worker_version_id: workerVersionId,
    provider_response_status: providerStatus,
    provider_response_sha256: rawSha256,
    provider_request_id: providerRequestId,
    provider_completed_at: completedAt,
    usage_present: true,
    reported_usage_fields: 7,
    prompt_tokens: 7,
    completion_tokens: 5,
    total_tokens: 12,
    cached_tokens: 0,
    cache_creation_tokens: 0,
    cache_creation_tokens_5m: 0,
    cache_creation_tokens_1h: 0,
    image_input_tokens: 0,
    image_output_tokens: 0,
    audio_input_tokens: 0,
    audio_output_tokens: 0,
    is_anthropic_usage_semantic: false,
    usage_semantic_source: "openai_default",
    provider_cost_usd: null,
    cache_creation_source: "none",
    responses_web_search_calls: 0,
    responses_file_search_calls: 0,
    claude_web_search_calls: 0,
    image_generation_quality: null,
    image_generation_size: null,
  };
}

function admissionSnapshot(): D1AdmissionSnapshot {
  return {
    reservation_key: operationId,
    operation_reservation_key: operationId,
    reservation_status: "reserved",
    lease_expires_at: completedAtSeconds + 900,
    owner_deadline_at: completedAtSeconds + 800,
    reservation_owner_generation: 2,
    reservation_channel_id: 11,
    reservation_selected_group: "premium",
    reservation_selected_at: completedAtSeconds - 20,
    model_name: "canary-model",
    endpoint_path: "v1/chat/completions",
    billing_kind: "tiered_expr",
    billing_contract_hash: "c".repeat(64),
    billing_snapshot_json: '{"canary":"tiered"}',
    operation_id: operationId,
    owner_generation: 2,
    owner_lease_expires_at: completedAtSeconds + 700,
    channel_id: 11,
    selected_group: "premium",
    operation_kind: "chat_completions_canary",
    provider_operation_id: providerOperationId,
    admission_sha256: admissionSha256,
    protocol_version: 1,
    shard_contract_version: 1,
    ring_generation: 1,
    shard_count: 1,
    shard_index: 0,
    instance_name: "cinatoken-relay-shard-v1-0000",
    execution_deadline_at: completedAtSeconds + 600,
    input_mode: "r2",
    input_object_key: `container-inputs/v1/${operationId}/2/${requestSha256}`,
    input_object_version: "input-version-1",
    input_sha256: requestSha256,
    input_size: 2,
    input_content_type: "application/json",
    trace_id: "artifact-trace-1",
    operation_status: "dispatched",
    operation_created_at: completedAtSeconds - 10,
    operation_updated_at: completedAtSeconds - 5,
  };
}

function artifactSchemaReadyRow(): Record<string, number> {
  return {
    raw_table_count: 1,
    raw_column_count: 28,
    raw_required_column_count: 28,
    raw_identity_table_count: 1,
    raw_identity_column_count: 7,
    raw_identity_required_column_count: 7,
    client_table_count: 1,
    client_column_count: 17,
    client_required_column_count: 17,
    client_identity_table_count: 1,
    client_identity_column_count: 7,
    client_identity_required_column_count: 7,
    operation_contract_column_count: 1,
    terminal_artifact_column_count: 1,
    atomic_identity_column_count: 6,
    receipt_identity_column_count: 4,
    required_index_count: 5,
    atomic_identity_index_column_count: 6,
    receipt_identity_index_column_count: 4,
    raw_recorded_index_column_count: 3,
    client_created_index_column_count: 3,
    terminal_artifact_index_column_count: 1,
    required_trigger_count: 20,
    raw_foreign_key_column_count: 9,
    client_foreign_key_column_count: 8,
  };
}

function receiptSchemaReadyRow(): Record<string, number> {
  return {
    table_count: 1,
    column_count: 30,
    required_column_count: 30,
    identity_table_count: 1,
    identity_column_count: 6,
    identity_required_column_count: 6,
    insert_guard_count: 1,
    update_guard_count: 1,
    delete_guard_count: 1,
    identity_guard_count: 1,
    identity_update_guard_count: 1,
    identity_delete_guard_count: 1,
    terminal_event_column_count: 3,
    terminal_event_guard_count: 1,
    operation_completion_guard_count: 1,
  };
}

function rowFromBindings(
  columns: readonly string[],
  values: readonly unknown[],
): Record<string, unknown> {
  return Object.fromEntries(columns.map((column, index) => [column, values[index]]));
}

function cloneRow(value: Record<string, unknown> | null): Record<string, unknown> | null {
  return value === null ? null : { ...value };
}

function writeResult(changes: number): { success: true; meta: { changes: number } } {
  return { success: true, meta: { changes } };
}

function r2Object(stored: StoredR2Object): R2Object {
  return {
    key: stored.key,
    version: stored.version,
    size: stored.size,
    etag: `etag-${stored.version}`,
    httpEtag: `"etag-${stored.version}"`,
    uploaded: new Date(0),
    storageClass: "Standard",
    httpMetadata: { contentType: stored.contentType },
    customMetadata: { ...stored.customMetadata },
    checksums: {
      sha256: hexBuffer(stored.sha256),
      toJSON: () => ({ sha256: stored.sha256 }),
    },
    writeHttpMetadata: () => undefined,
  } as unknown as R2Object;
}

async function r2ValueBytes(value: unknown): Promise<Uint8Array> {
  if (value === null || value === undefined) return new Uint8Array();
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(await new Response(value as BodyInit).arrayBuffer());
}

function hexBuffer(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes.buffer;
}

function namespaceForKey(key: string): string {
  if (key.startsWith(`${R2_PROVIDER_EVIDENCE_KEY_PREFIX}/`)) return "raw";
  if (key.startsWith(`${R2_CLIENT_ARTIFACT_KEY_PREFIX}/`)) return "client";
  if (key.startsWith(`${R2_RESULT_KEY_PREFIX}/`)) return "legacy";
  throw new Error(`unexpected R2 key: ${key}`);
}

function totalR2Creates(r2: InMemoryR2): number {
  return [...r2.createCounts.values()].reduce((total, count) => total + count, 0);
}

function requireStored(r2: InMemoryR2, key: string): StoredR2Object {
  const stored = r2.objects.get(key);
  if (stored === undefined) throw new Error(`R2 object missing: ${key}`);
  return stored;
}

function rawObjectKey(verified: VerifiedProviderResponseV3): string {
  const { identity, raw } = verified.envelope;
  return `${R2_PROVIDER_EVIDENCE_KEY_PREFIX}/${identity.operation_id}/${identity.owner_generation}/${identity.attempt_generation}/${raw.body_sha256}`;
}

function clientObjectKey(verified: VerifiedProviderResponseV3): string {
  const { identity } = verified.envelope;
  return `${R2_CLIENT_ARTIFACT_KEY_PREFIX}/${identity.operation_id}/${identity.owner_generation}/${verified.envelope.client_response_artifact_sha256}`;
}

function canonicalHeaders(headers: Record<string, string>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(headers).sort(
    ([left], [right]) => left < right ? -1 : left > right ? 1 : 0,
  )));
}

function base64UrlNoPad(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index]);
}

function requireNonNull<T>(value: T | null): T {
  if (value === null) throw new Error("fixture value missing");
  return value;
}
