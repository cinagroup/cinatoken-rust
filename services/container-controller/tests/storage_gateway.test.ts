import { describe, expect, test } from "bun:test";
import {
  CONTENT_SHA256_HEADER,
  D1_ADMISSION_HOST,
  D1_ADMISSION_PATH,
  KV_CONFIG_HOST,
  KV_CONFIG_PATH,
  KV_OPERATION_CONFIG_PREFIX,
  MAX_KV_CONFIG_BYTES,
  MAX_R2_OBJECT_BYTES,
  R2_INPUT_HOST,
  R2_INPUT_PATH,
  R2_OBJECT_VERSION_HEADER,
  R2_RESULT_HOST,
  R2_RESULT_KEY_PREFIX,
  R2_RESULT_PATH,
  STORAGE_GATEWAY_ACTIONS,
  deriveR2ResultKey,
  handleStorageGatewayRequest,
  isProviderUsageReceipt,
  requireD1OperationAdmission,
  requireD1ProviderEgressGrant,
  requireD1ProviderUsageReceipt,
  requireD1ProviderUsageReceiptSchema,
  type CanonicalProviderUsageReceipt,
  type D1AdmissionSnapshot,
  type D1AdmissionGetGrant,
  type KvConfigGetGrant,
  type ProviderEgressGrantIdentity,
  type ProviderUsageReceipt,
  type ProviderUsageReceiptResult,
  type R2InputGetGrant,
  type R2ResultPutGrant,
  type StorageGatewayEnvironment,
} from "../src/storage_gateway";

const inputBytes = new TextEncoder().encode("hello");
const inputSha256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const resultSha256 = "a".repeat(64);
const tieredBillingSnapshotJson = '{"canary":"tiered"}';
const tieredBillingSnapshotSha256 =
  "df3029b0f9ad33604ca660838f1e38aae61983e81f4b3ad0a8ac19c1bb92f867";
const flatBillingSnapshotJson = '{"canary":"flat"}';
const flatBillingSnapshotSha256 =
  "0806a22bd2a4233995e7a5979ab02384714e224886536b18b29871b59e9ca320";

function enabledEnv(overrides: Partial<StorageGatewayEnvironment> = {}): StorageGatewayEnvironment {
  return { CONTAINER_STORAGE_GATEWAY_ENABLED: "true", ...overrides };
}

function inputGrant(overrides: Partial<R2InputGetGrant> = {}): R2InputGetGrant {
  return {
    action: STORAGE_GATEWAY_ACTIONS.R2_INPUT_GET,
    key: "requests/op-123/input.json",
    version: "version-1",
    sha256: inputSha256,
    size: inputBytes.byteLength,
    content_type: "application/json",
    ...overrides,
  };
}

function resultGrant(overrides: Partial<R2ResultPutGrant> = {}): R2ResultPutGrant {
  return {
    action: STORAGE_GATEWAY_ACTIONS.R2_RESULT_PUT,
    operation_id: "op-123",
    owner_generation: 7,
    provider_operation_id: "provider-op-123",
    admission_sha256: "b".repeat(64),
    attempt_generation: null,
    egress_profile: null,
    egress_worker_version_id: null,
    sha256: resultSha256,
    size: inputBytes.byteLength,
    content_type: "application/json",
    ...overrides,
  };
}

function admissionGrant(overrides: Partial<D1AdmissionGetGrant> = {}): D1AdmissionGetGrant {
  const now = Math.floor(Date.now() / 1000);
  return {
    action: STORAGE_GATEWAY_ACTIONS.D1_ADMISSION_GET,
    protocol_version: 1,
    operation_id: "operation-op-123",
    operation_kind: "chat_completion",
    owner_generation: 7,
    owner_lease_expires_at: now + 180,
    execution_deadline_at: now + 120,
    provider_operation_id: "provider-op-123",
    admission_sha256: "b".repeat(64),
    input: {
      mode: "r2",
      sha256: inputSha256,
      size: inputBytes.byteLength,
      content_type: "application/json",
      request_object_key: `container-inputs/v1/operation-op-123/7/${inputSha256}`,
      object_version: "version-1",
    },
    shard: {
      contract_version: 1,
      ring_generation: 3,
      shard_count: 8,
      shard_index: 3,
      instance_name: "cinatoken-relay-shard-v1-0003",
    },
    trace_id: "trace-op-123",
    ...overrides,
  };
}

function admissionRow(grant: D1AdmissionGetGrant): Record<string, unknown> {
  const operationCreatedAt = grant.execution_deadline_at - 150;
  return {
    reservation_key: grant.operation_id,
    operation_reservation_key: grant.operation_id,
    reservation_status: "reserved",
    lease_expires_at: grant.owner_lease_expires_at + 30,
    owner_deadline_at: grant.execution_deadline_at + 10,
    reservation_owner_generation: grant.owner_generation,
    reservation_channel_id: 11,
    reservation_selected_group: "premium",
    reservation_selected_at: operationCreatedAt - 1,
    model_name: "canary-model",
    endpoint_path: "chat/completions",
    billing_kind: "tiered_expr",
    billing_contract_hash: "c".repeat(64),
    billing_snapshot_json: tieredBillingSnapshotJson,
    operation_id: grant.operation_id,
    owner_generation: grant.owner_generation,
    owner_lease_expires_at: grant.owner_lease_expires_at,
    channel_id: 11,
    selected_group: "premium",
    operation_kind: grant.operation_kind,
    provider_operation_id: grant.provider_operation_id,
    admission_sha256: grant.admission_sha256,
    protocol_version: grant.protocol_version,
    shard_contract_version: grant.shard.contract_version,
    ring_generation: grant.shard.ring_generation,
    shard_count: grant.shard.shard_count,
    shard_index: grant.shard.shard_index,
    instance_name: grant.shard.instance_name,
    execution_deadline_at: grant.execution_deadline_at,
    input_mode: grant.input.mode,
    input_object_key: grant.input.request_object_key,
    input_object_version: grant.input.object_version,
    input_sha256: grant.input.sha256,
    input_size: grant.input.size,
    input_content_type: grant.input.content_type,
    trace_id: grant.trace_id,
    operation_status: "prepared",
    operation_created_at: operationCreatedAt,
    operation_updated_at: operationCreatedAt + 1,
  };
}

function providerEgressGrantRow(
  admission: D1AdmissionSnapshot,
  identity: ProviderEgressGrantIdentity,
  authorizedAt: number,
): Record<string, unknown> {
  return {
    operation_id: admission.operation_id,
    reservation_key: admission.reservation_key,
    owner_generation: admission.owner_generation,
    attempt_generation: identity.attempt_generation,
    provider_operation_id: admission.provider_operation_id,
    admission_sha256: admission.admission_sha256,
    request_sha256: identity.request_sha256,
    egress_profile: identity.egress_profile,
    egress_worker_version_id: identity.egress_worker_version_id,
    channel_id: admission.channel_id,
    selected_group: admission.selected_group,
    model_name: admission.model_name,
    endpoint_path: admission.endpoint_path,
    input_mode: admission.input_mode,
    input_object_key: admission.input_object_key,
    input_object_version: admission.input_object_version,
    input_sha256: admission.input_sha256,
    input_size: admission.input_size,
    input_content_type: admission.input_content_type,
    billing_kind: admission.billing_kind,
    billing_contract_hash: admission.billing_contract_hash,
    billing_snapshot_sha256:
      admission.billing_kind === "flat"
        ? admission.billing_contract_hash.slice(-64)
        : tieredBillingSnapshotSha256,
    stream_policy: "non_streaming",
    operation_created_at: admission.operation_created_at,
    operation_dispatched_at: admission.operation_updated_at,
    authorized_at: authorizedAt,
    execution_deadline_at: admission.execution_deadline_at,
    owner_lease_expires_at: admission.owner_lease_expires_at,
    reservation_owner_deadline_at: admission.owner_deadline_at,
    reservation_lease_expires_at: admission.lease_expires_at,
  };
}

function providerUsageReceipt(
  admission: D1AdmissionSnapshot,
  result: ProviderUsageReceiptResult,
  overrides: Partial<ProviderUsageReceipt> = {},
): ProviderUsageReceipt {
  const receipt: ProviderUsageReceipt = {
    schema_version: 1,
    parser_contract: "openai-chat-completions-usage-v1",
    normalization_contract: "billing-token-normalization-v1",
    source: "provider_response",
    estimated: false,
    operation_id: admission.operation_id,
    owner_generation: admission.owner_generation,
    attempt_generation: 1,
    provider_operation_id: admission.provider_operation_id,
    request_sha256: admission.input_sha256,
    egress_profile: "openai-chat-completions-canary-v1",
    egress_worker_version_id: "worker-version-1",
    provider_response_status: 200,
    provider_response_sha256: result.sha256,
    provider_request_id: "request-1",
    provider_completed_at: Date.now() - 10,
    usage_present: false,
    reported_usage_fields: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
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
    ...overrides,
  };
  if (!isProviderUsageReceipt(receipt)) throw new Error("invalid provider usage receipt fixture");
  return receipt;
}

async function canonicalProviderUsageReceipt(
  receipt: ProviderUsageReceipt,
): Promise<CanonicalProviderUsageReceipt> {
  const json = JSON.stringify(receipt);
  return { receipt, json, sha256: await sha256Bytes(new TextEncoder().encode(json)) };
}

function providerUsageReceiptRowFromBindings(values: unknown[]): Record<string, unknown> {
  const names = [
    "operation_id",
    "reservation_key",
    "owner_generation",
    "attempt_generation",
    "provider_operation_id",
    "admission_sha256",
    "request_sha256",
    "egress_profile",
    "egress_worker_version_id",
    "billing_kind",
    "billing_contract_hash",
    "billing_snapshot_sha256",
    "provider_response_status",
    "provider_response_sha256",
    "provider_request_id",
    "provider_completed_at",
    "result_object_key",
    "result_object_version",
    "result_sha256",
    "result_size",
    "result_content_type",
    "usage_schema_version",
    "usage_parser_contract",
    "usage_normalization_contract",
    "usage_present",
    "reported_usage_fields",
    "usage_estimated",
    "usage_receipt_json",
    "usage_receipt_sha256",
    "persisted_at",
  ];
  return Object.fromEntries(names.map((name, index) => [name, values[index]]));
}

function providerUsageSchemaReadyRow(
  overrides: Record<string, number> = {},
): Record<string, number> {
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
    ...overrides,
  };
}

function inputRequest(path = R2_INPUT_PATH, method = "GET"): Request {
  return new Request(`https://${R2_INPUT_HOST}${path}`, { method });
}

function resultRequest(
  grant: R2ResultPutGrant,
  headerOverrides: Record<string, string | null> = {},
): Request {
  const headers = new Headers({
    "content-length": String(grant.size),
    "content-type": grant.content_type,
    [CONTENT_SHA256_HEADER]: grant.sha256,
  });
  for (const [name, value] of Object.entries(headerOverrides)) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  return new Request(`https://${R2_RESULT_HOST}${R2_RESULT_PATH}`, {
    method: "PUT",
    headers,
    body: grant.size === 0 ? undefined : new Uint8Array(grant.size),
  });
}

function hexBuffer(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes.buffer;
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface R2ObjectOptions {
  key: string;
  version?: string;
  bytes?: Uint8Array;
  size?: number;
  contentType?: string;
  sha256?: string;
  customMetadata?: Record<string, string>;
  cancel?: () => void;
  holdOpen?: boolean;
}

function r2Object(options: R2ObjectOptions): R2ObjectBody {
  const bytes = options.bytes ?? inputBytes;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      if (!options.holdOpen) controller.close();
    },
    cancel() {
      options.cancel?.();
    },
  });
  const sha256 = options.sha256 ?? inputSha256;
  return {
    key: options.key,
    version: options.version ?? "version-1",
    size: options.size ?? bytes.byteLength,
    etag: "etag-1",
    httpEtag: '"etag-1"',
    uploaded: new Date(0),
    storageClass: "Standard",
    httpMetadata: { contentType: options.contentType ?? "application/json" },
    customMetadata: options.customMetadata,
    checksums: {
      sha256: hexBuffer(sha256),
      toJSON: () => ({ sha256 }),
    },
    body: stream,
    bodyUsed: false,
    writeHttpMetadata: () => undefined,
  } as unknown as R2ObjectBody;
}

function resultMetadata(grant: R2ResultPutGrant): Record<string, string> {
  const egressMetadata =
    grant.egress_profile === null || grant.egress_worker_version_id === null
      ? {}
      : {
          egress_profile: grant.egress_profile,
          egress_worker_version_id: grant.egress_worker_version_id,
        };
  return {
    gateway_version:
      grant.usage_receipt_sha256 !== undefined
        ? "4"
        : grant.attempt_generation === null
        ? "1"
        : Object.keys(egressMetadata).length === 0
          ? "2"
          : "3",
    operation_id: grant.operation_id,
    owner_generation: String(grant.owner_generation),
    provider_operation_id: grant.provider_operation_id,
    admission_sha256: grant.admission_sha256,
    ...(grant.attempt_generation === null
      ? {}
      : { attempt_generation: String(grant.attempt_generation) }),
    ...egressMetadata,
    ...(grant.usage_receipt_sha256 === undefined
      ? {}
      : { usage_receipt_sha256: grant.usage_receipt_sha256 }),
    sha256: grant.sha256,
    size: String(grant.size),
    content_type: grant.content_type,
  };
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error: string }).error;
}

describe("container storage gateway", () => {
  test("is disabled by default and requires an explicit grant", async () => {
    const disabled = await handleStorageGatewayRequest({}, inputRequest(), inputGrant());
    expect(disabled.status).toBe(503);
    expect(await errorCode(disabled)).toBe("storage_gateway_disabled");

    const denied = await handleStorageGatewayRequest(enabledEnv(), inputRequest(), null);
    expect(denied.status).toBe(403);
    expect(await errorCode(denied)).toBe("storage_access_denied");
  });

  test("rejects the wrong method, path, host, and request-selected identity", async () => {
    const method = await handleStorageGatewayRequest(
      enabledEnv(),
      inputRequest(R2_INPUT_PATH, "POST"),
      inputGrant(),
    );
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("GET");
    expect(await errorCode(method)).toBe("storage_method_not_allowed");

    const path = await handleStorageGatewayRequest(
      enabledEnv(),
      inputRequest(`${R2_INPUT_PATH}/other`),
      inputGrant(),
    );
    expect(path.status).toBe(404);
    expect(await errorCode(path)).toBe("storage_route_not_found");

    const host = await handleStorageGatewayRequest(
      enabledEnv(),
      new Request(`https://${R2_RESULT_HOST}${R2_INPUT_PATH}`),
      inputGrant(),
    );
    expect(host.status).toBe(404);

    const query = await handleStorageGatewayRequest(
      enabledEnv(),
      new Request(`https://${R2_INPUT_HOST}${R2_INPUT_PATH}?operation_id=other`),
      inputGrant(),
    );
    expect(query.status).toBe(404);
  });

  test("streams only an exact R2 input object", async () => {
    const grant = inputGrant();
    const requestedKeys: string[] = [];
    const bucket = {
      async get(key: string) {
        requestedKeys.push(key);
        return r2Object({
          key: grant.key,
          version: grant.version,
          size: grant.size,
          contentType: grant.content_type,
          sha256: grant.sha256,
        });
      },
    } as unknown as Pick<R2Bucket, "get">;

    const response = await handleStorageGatewayRequest(
      enabledEnv({ CONTAINER_STORAGE_INPUT_R2: bucket }),
      inputRequest(),
      grant,
    );

    expect(response.status).toBe(200);
    expect(requestedKeys).toEqual([grant.key]);
    expect(response.headers.get("content-length")).toBe(String(grant.size));
    expect(response.headers.get("content-type")).toBe(grant.content_type);
    expect(response.headers.get(CONTENT_SHA256_HEADER)).toBe(grant.sha256);
    expect(response.headers.get(R2_OBJECT_VERSION_HEADER)).toBe(grant.version);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(inputBytes);
  });

  test("rejects and cancels R2 input size, hash, version, and metadata mismatches", async () => {
    const grant = inputGrant();
    const mismatches: R2ObjectOptions[] = [
      { key: grant.key, version: "version-2" },
      { key: grant.key, size: grant.size + 1 },
      { key: grant.key, sha256: "b".repeat(64) },
      { key: grant.key, contentType: "text/plain" },
    ];

    for (const mismatch of mismatches) {
      let cancelled = false;
      const bucket = {
        async get() {
          return r2Object({
            ...mismatch,
            holdOpen: true,
            cancel: () => {
              cancelled = true;
            },
          });
        },
      } as unknown as Pick<R2Bucket, "get">;
      const response = await handleStorageGatewayRequest(
        enabledEnv({ CONTAINER_STORAGE_INPUT_R2: bucket }),
        inputRequest(),
        grant,
      );
      expect(response.status).toBe(502);
      expect(await errorCode(response)).toBe("r2_input_integrity_mismatch");
      expect(cancelled).toBe(true);
    }
  });

  test("enforces the 64 MiB R2 limit before touching a binding", async () => {
    let called = false;
    const bucket = {
      async get() {
        called = true;
        return null;
      },
    } as unknown as Pick<R2Bucket, "get">;
    const response = await handleStorageGatewayRequest(
      enabledEnv({ CONTAINER_STORAGE_INPUT_R2: bucket }),
      inputRequest(),
      inputGrant({ size: MAX_R2_OBJECT_BYTES + 1 }),
    );
    expect(response.status).toBe(413);
    expect(await errorCode(response)).toBe("r2_object_too_large");
    expect(called).toBe(false);
  });

  test("requires exact result length, content type, and declared sha256", async () => {
    const grant = resultGrant();
    let puts = 0;
    const bucket = {
      async put() {
        puts += 1;
        return null;
      },
      async head() {
        return null;
      },
    } as unknown as Pick<R2Bucket, "head" | "put">;
    const env = enabledEnv({ CONTAINER_STORAGE_RESULT_R2: bucket });

    const badLength = await handleStorageGatewayRequest(
      env,
      resultRequest(grant, { "content-length": String(grant.size + 1) }),
      grant,
    );
    expect(await errorCode(badLength)).toBe("r2_result_length_mismatch");

    const badType = await handleStorageGatewayRequest(
      env,
      resultRequest(grant, { "content-type": "text/plain" }),
      grant,
    );
    expect(await errorCode(badType)).toBe("r2_result_content_type_mismatch");

    const badHash = await handleStorageGatewayRequest(
      env,
      resultRequest(grant, { [CONTENT_SHA256_HEADER]: "b".repeat(64) }),
      grant,
    );
    expect(await errorCode(badHash)).toBe("r2_result_sha256_mismatch");
    expect(puts).toBe(0);
  });

  test("rejects a partial provider egress identity before touching R2", async () => {
    const grant = resultGrant({
      attempt_generation: 1,
      egress_profile: "openai-chat-completions-canary-v1",
      egress_worker_version_id: null,
    });
    let called = false;
    const response = await handleStorageGatewayRequest(
      enabledEnv({
        CONTAINER_STORAGE_RESULT_R2: {
          async put() {
            called = true;
            return null;
          },
          async head() {
            called = true;
            return null;
          },
        } as unknown as Pick<R2Bucket, "head" | "put">,
      }),
      resultRequest(grant),
      grant,
    );

    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("storage_access_denied");
    expect(called).toBe(false);
  });

  test("creates an R2 result with a server-derived key, checksum, and create-only condition", async () => {
    const grant = resultGrant();
    const calls: Array<{ key: string; options: R2PutOptions }> = [];
    const expectedKey = deriveR2ResultKey(grant);
    const metadata = resultMetadata(grant);
    const bucket = {
      async put(key: string, _value: unknown, options: R2PutOptions) {
        calls.push({ key, options });
        return r2Object({
          key,
          version: "result-version-1",
          size: grant.size,
          contentType: grant.content_type,
          sha256: grant.sha256,
          customMetadata: metadata,
        });
      },
      async head() {
        throw new Error("head must not run after a successful create");
      },
    } as unknown as Pick<R2Bucket, "head" | "put">;

    const response = await handleStorageGatewayRequest(
      enabledEnv({ CONTAINER_STORAGE_RESULT_R2: bucket }),
      resultRequest(grant),
      grant,
    );
    expect(response.status).toBe(201);
    expect(response.headers.get(R2_OBJECT_VERSION_HEADER)).toBe("result-version-1");
    expect(await response.json()).toEqual({
      key: expectedKey,
      sha256: grant.sha256,
      size: grant.size,
      replayed: false,
    });
    expect(expectedKey).toBe(
      `${R2_RESULT_KEY_PREFIX}/${grant.operation_id}/${grant.owner_generation}/${grant.sha256}`,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.key).toBe(expectedKey);
    expect(calls[0]?.options.sha256).toBe(grant.sha256);
    expect((calls[0]?.options.onlyIf as Headers).get("if-none-match")).toBe("*");
    expect(calls[0]?.options.httpMetadata).toEqual({ contentType: grant.content_type });
    expect(calls[0]?.options.customMetadata).toEqual(metadata);
  });

  test("fences a journaled R2 result with provider-attempt metadata", async () => {
    const grant = resultGrant({ attempt_generation: 1 });
    let customMetadata: Record<string, string> | undefined;
    const bucket = {
      async put(key: string, _value: unknown, options: R2PutOptions) {
        customMetadata = options.customMetadata;
        return r2Object({
          key,
          version: "result-version-attempt-1",
          size: grant.size,
          contentType: grant.content_type,
          sha256: grant.sha256,
          customMetadata: resultMetadata(grant),
        });
      },
      async head() {
        throw new Error("head must not run after a successful create");
      },
    } as unknown as Pick<R2Bucket, "head" | "put">;

    const response = await handleStorageGatewayRequest(
      enabledEnv({ CONTAINER_STORAGE_RESULT_R2: bucket }),
      resultRequest(grant),
      grant,
    );

    expect(response.status).toBe(201);
    expect(customMetadata).toEqual({
      ...resultMetadata(grant),
      gateway_version: "2",
      attempt_generation: "1",
    });
  });

  test("binds versioned provider-attempt identity into R2 metadata v3", async () => {
    const grant = resultGrant({
      attempt_generation: 1,
      egress_profile: "openai-chat-completions-canary-v1",
      egress_worker_version_id: "worker-version-1",
    });
    let customMetadata: Record<string, string> | undefined;
    const bucket = {
      async put(key: string, _value: unknown, options: R2PutOptions) {
        customMetadata = options.customMetadata;
        return r2Object({
          key,
          version: "result-version-attempt-v3",
          size: grant.size,
          contentType: grant.content_type,
          sha256: grant.sha256,
          customMetadata: resultMetadata(grant),
        });
      },
      async head() {
        throw new Error("head must not run after a successful create");
      },
    } as unknown as Pick<R2Bucket, "head" | "put">;

    const response = await handleStorageGatewayRequest(
      enabledEnv({ CONTAINER_STORAGE_RESULT_R2: bucket }),
      resultRequest(grant),
      grant,
    );

    expect(response.status).toBe(201);
    expect(customMetadata).toEqual({
      ...resultMetadata(grant),
      gateway_version: "3",
      attempt_generation: "1",
      egress_profile: grant.egress_profile,
      egress_worker_version_id: grant.egress_worker_version_id,
    });
  });

  test("binds the canonical usage receipt digest into R2 metadata v4", async () => {
    const usageReceiptSha256 = "d".repeat(64);
    const grant = resultGrant({
      attempt_generation: 1,
      egress_profile: "openai-chat-completions-canary-v1",
      egress_worker_version_id: "worker-version-1",
      usage_receipt_sha256: usageReceiptSha256,
    });
    let customMetadata: Record<string, string> | undefined;
    const bucket = {
      async put(key: string, _value: unknown, options: R2PutOptions) {
        customMetadata = options.customMetadata;
        return r2Object({
          key,
          version: "result-version-attempt-v4",
          size: grant.size,
          contentType: grant.content_type,
          sha256: grant.sha256,
          customMetadata: resultMetadata(grant),
        });
      },
      async head() {
        throw new Error("head must not run after a successful create");
      },
    } as unknown as Pick<R2Bucket, "head" | "put">;

    const response = await handleStorageGatewayRequest(
      enabledEnv({ CONTAINER_STORAGE_RESULT_R2: bucket }),
      resultRequest(grant),
      grant,
    );

    expect(response.status).toBe(201);
    expect(customMetadata).toEqual({
      ...resultMetadata(grant),
      gateway_version: "4",
      usage_receipt_sha256: usageReceiptSha256,
    });
  });

  test("treats an identical create-only replay as idempotent", async () => {
    const grant = resultGrant();
    const key = deriveR2ResultKey(grant);
    const metadata = resultMetadata(grant);
    const bucket = {
      async put() {
        return null;
      },
      async head(requestedKey: string) {
        expect(requestedKey).toBe(key);
        return r2Object({
          key,
          version: "result-version-1",
          size: grant.size,
          contentType: grant.content_type,
          sha256: grant.sha256,
          customMetadata: metadata,
        });
      },
    } as unknown as Pick<R2Bucket, "head" | "put">;

    const response = await handleStorageGatewayRequest(
      enabledEnv({ CONTAINER_STORAGE_RESULT_R2: bucket }),
      resultRequest(grant),
      grant,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get(R2_OBJECT_VERSION_HEADER)).toBe("result-version-1");
    expect(await response.json()).toMatchObject({ key, replayed: true });
  });

  test("fails closed when a create-only result collides with different metadata", async () => {
    const grant = resultGrant();
    const key = deriveR2ResultKey(grant);
    const bucket = {
      async put() {
        return null;
      },
      async head() {
        return r2Object({
          key,
          size: grant.size,
          contentType: grant.content_type,
          sha256: grant.sha256,
          customMetadata: { ...resultMetadata(grant), owner_generation: "8" },
        });
      },
    } as unknown as Pick<R2Bucket, "head" | "put">;

    const response = await handleStorageGatewayRequest(
      enabledEnv({ CONTAINER_STORAGE_RESULT_R2: bucket }),
      resultRequest(grant),
      grant,
    );
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("r2_result_conflict");
  });

  test("derives the KV key only from operation_kind and returns a bounded no-store value", async () => {
    const grant: KvConfigGetGrant = {
      action: STORAGE_GATEWAY_ACTIONS.KV_CONFIG_GET,
      operation_kind: "health_probe",
    };
    const keys: string[] = [];
    const value = new Uint8Array(MAX_KV_CONFIG_BYTES);
    const namespace = {
      async get(key: string, type: string) {
        keys.push(key);
        expect(type).toBe("stream");
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(value);
            controller.close();
          },
        });
      },
    } as unknown as Pick<KVNamespace, "get">;
    const request = new Request(`https://${KV_CONFIG_HOST}${KV_CONFIG_PATH}`);

    const response = await handleStorageGatewayRequest(
      enabledEnv({ CONTAINER_STORAGE_CONFIG_KV: namespace }),
      request,
      grant,
    );
    expect(response.status).toBe(200);
    expect(keys).toEqual([`${KV_OPERATION_CONFIG_PREFIX}${grant.operation_kind}`]);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-length")).toBe(String(MAX_KV_CONFIG_BYTES));
    expect((await response.arrayBuffer()).byteLength).toBe(MAX_KV_CONFIG_BYTES);
  });

  test("cancels a KV value that exceeds 32 KiB", async () => {
    let cancelled = false;
    const namespace = {
      async get() {
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(MAX_KV_CONFIG_BYTES + 1));
          },
          cancel() {
            cancelled = true;
          },
        });
      },
    } as unknown as Pick<KVNamespace, "get">;
    const grant: KvConfigGetGrant = {
      action: STORAGE_GATEWAY_ACTIONS.KV_CONFIG_GET,
      operation_kind: "health_probe",
    };
    const response = await handleStorageGatewayRequest(
      enabledEnv({ CONTAINER_STORAGE_CONFIG_KV: namespace }),
      new Request(`https://${KV_CONFIG_HOST}${KV_CONFIG_PATH}`),
      grant,
    );
    expect(response.status).toBe(502);
    expect(await errorCode(response)).toBe("kv_config_too_large");
    expect(cancelled).toBe(true);
  });

  test("joins 0040 by operation id, owner-fences it, and exposes only the active snapshot", async () => {
    const prepared: string[] = [];
    const bound: unknown[][] = [];
    const grant = admissionGrant();
    let row: Record<string, unknown> | null = admissionRow(grant);
    const statement = {
      bind(...values: unknown[]) {
        bound.push(values);
        return statement;
      },
      async first<T>() {
        return row === null ? null : ({ ...row } as T);
      },
    };
    const database = {
      prepare(sql: string) {
        prepared.push(sql);
        return statement;
      },
    } as unknown as Pick<D1Database, "prepare">;
    const request = () => new Request(`https://${D1_ADMISSION_HOST}${D1_ADMISSION_PATH}`);
    const env = enabledEnv({ CONTAINER_STORAGE_ADMISSION_DB: database });

    const response = await handleStorageGatewayRequest(env, request(), grant);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "reserved",
      operation_status: "prepared",
      lease_expires_at: row?.lease_expires_at,
      owner_deadline_at: row?.owner_deadline_at,
      owner_generation: 7,
    });
    expect(prepared[0]).toContain("FROM relay_container_operations AS operation");
    expect(prepared[0]).toContain("JOIN relay_billing_reservations AS reservation");
    expect(prepared[0]).toContain("operation.operation_id = ?1");
    expect(prepared[0]).toContain("operation.owner_generation = ?2");
    expect(prepared[0]).toContain("reservation.owner_generation = ?2");
    expect(bound[0]).toEqual([grant.operation_id, grant.owner_generation]);

    row = { ...admissionRow(grant), reservation_status: "refunded" };
    const terminal = await handleStorageGatewayRequest(env, request(), grant);
    expect(terminal.status).toBe(409);
    expect(await errorCode(terminal)).toBe("admission_not_reserved");

    row = { ...admissionRow(grant), owner_deadline_at: 1 };
    const expired = await handleStorageGatewayRequest(env, request(), grant);
    expect(expired.status).toBe(409);
    expect(await errorCode(expired)).toBe("admission_lease_expired");

    row = null;
    const missing = await handleStorageGatewayRequest(env, request(), grant);
    expect(missing.status).toBe(404);
    expect(await errorCode(missing)).toBe("admission_snapshot_not_found");
  });

  test("probes the complete 0048 receipt schema and guards through a read-only primary session", async () => {
    let readiness = providerUsageSchemaReadyRow();
    const prepared: string[] = [];
    const constraints: unknown[] = [];
    const session = {
      prepare(sql: string) {
        prepared.push(sql);
        return {
          async first<T>() {
            return { ...readiness } as T;
          },
        };
      },
    };
    const database = {
      prepare() {
        throw new Error("schema probe must use the primary session");
      },
      withSession(constraint: unknown) {
        constraints.push(constraint);
        return session;
      },
    } as unknown as D1Database;
    const env = enabledEnv({ CONTAINER_STORAGE_ADMISSION_DB: database });

    await expect(requireD1ProviderUsageReceiptSchema(env)).resolves.toBeUndefined();
    expect(constraints).toEqual(["first-primary"]);
    expect(prepared[0]).toContain("relay_container_provider_usage_receipts");
    expect(prepared[0]).toContain("pragma_table_info('relay_container_provider_usage_receipts')");
    expect(prepared[0]).toContain("relay_container_provider_usage_receipt_insert_authority_guard");
    expect(prepared[0]).toContain("relay_container_provider_usage_receipt_identities");
    expect(prepared[0]).toContain("relay_container_provider_usage_receipt_identity_guard");
    expect(prepared[0]).toContain("relay_container_provider_usage_receipt_identity_update_guard");
    expect(prepared[0]).toContain("relay_container_provider_usage_receipt_identity_delete_guard");
    expect(prepared[0]).toContain("relay_container_terminal_event_provider_usage_guard");
    expect(prepared[0]).toContain(
      "relay_container_operation_provider_usage_terminal_guard",
    );

    for (const unavailable of [
      { identity_table_count: 0 },
      { identity_guard_count: 0 },
      { terminal_event_guard_count: 0 },
      { operation_completion_guard_count: 0 },
    ]) {
      readiness = providerUsageSchemaReadyRow(unavailable);
      await expect(requireD1ProviderUsageReceiptSchema(env)).rejects.toMatchObject({
        code: "provider_usage_receipt_schema_unavailable",
        status: 503,
      });
    }
    await expect(
      requireD1ProviderUsageReceiptSchema(enabledEnv()),
    ).rejects.toMatchObject({
      code: "provider_usage_receipt_schema_unavailable",
      status: 503,
    });
  });

  test("creates and exactly replays a canonical 0048 usage receipt", async () => {
    const grant = admissionGrant();
    const admission = {
      ...admissionRow(grant),
      operation_status: "dispatched",
    } as unknown as D1AdmissionSnapshot;
    const result: ProviderUsageReceiptResult = {
      object_key:
        `${R2_RESULT_KEY_PREFIX}/${admission.operation_id}/${admission.owner_generation}/${resultSha256}`,
      object_version: "result-version-1",
      sha256: resultSha256,
      size: inputBytes.byteLength,
      content_type: "application/json",
    };
    const evidence = await canonicalProviderUsageReceipt(
      providerUsageReceipt(admission, result),
    );
    const persistedAt = evidence.receipt.provider_completed_at + 1;
    const prepared: string[] = [];
    const constraints: unknown[] = [];
    const writeBindings: unknown[][] = [];
    let stored: Record<string, unknown> | null = null;
    const session = {
      prepare(sql: string) {
        prepared.push(sql);
        let values: unknown[] = [];
        const statement = {
          bind(...next: unknown[]) {
            values = next;
            return statement;
          },
          async run() {
            writeBindings.push(values);
            if (stored !== null) return { success: true, meta: { changes: 0 }, results: [] };
            stored = providerUsageReceiptRowFromBindings(values);
            return { success: true, meta: { changes: 1 }, results: [] };
          },
          async first<T>() {
            return (stored === null ? null : { ...stored }) as T | null;
          },
        };
        return statement;
      },
    };
    const database = {
      prepare() {
        throw new Error("receipt persistence must use the primary session");
      },
      withSession(constraint: unknown) {
        constraints.push(constraint);
        return session;
      },
    } as unknown as D1Database;
    const env = enabledEnv({ CONTAINER_STORAGE_ADMISSION_DB: database });

    await expect(
      requireD1ProviderUsageReceipt(env, admission, evidence, result, persistedAt),
    ).resolves.toEqual({ replayed: false, persisted_at: persistedAt });
    await expect(
      requireD1ProviderUsageReceipt(env, admission, evidence, result, persistedAt + 1),
    ).resolves.toEqual({ replayed: true, persisted_at: persistedAt });

    expect(constraints).toEqual(["first-primary", "first-primary"]);
    expect(prepared[0]).toContain(
      "INSERT OR IGNORE INTO relay_container_provider_usage_receipts",
    );
    expect(prepared[1]).toContain("FROM relay_container_provider_usage_receipts");
    expect(writeBindings[0]?.[11]).toBe(tieredBillingSnapshotSha256);
    expect(writeBindings[0]?.[24]).toBe(0);
    expect(writeBindings[0]?.[26]).toBe(0);
    expect(writeBindings[0]?.[27]).toBe(evidence.json);
    expect(writeBindings[0]?.[28]).toBe(evidence.sha256);
  });

  test("rejects 0048 result boundaries that D1 cannot store", async () => {
    const grant = admissionGrant();
    const admission = {
      ...admissionRow(grant),
      operation_status: "dispatched",
    } as unknown as D1AdmissionSnapshot;
    const result: ProviderUsageReceiptResult = {
      object_key:
        `${R2_RESULT_KEY_PREFIX}/${admission.operation_id}/${admission.owner_generation}/${resultSha256}`,
      object_version: "result-version-1",
      sha256: resultSha256,
      size: inputBytes.byteLength,
      content_type: "application/json",
    };
    const evidence = await canonicalProviderUsageReceipt(
      providerUsageReceipt(admission, result),
    );

    for (const invalidResult of [
      { ...result, object_version: "v".repeat(129) },
      { ...result, size: 1 },
    ]) {
      await expect(
        requireD1ProviderUsageReceipt(enabledEnv(), admission, evidence, invalidResult),
      ).rejects.toMatchObject({
        code: "provider_usage_receipt_authority_mismatch",
        status: 409,
      });
    }
  });

  test("fails closed on conflicting, malformed, and unavailable 0048 receipt persistence", async () => {
    const grant = admissionGrant();
    const admission = {
      ...admissionRow(grant),
      operation_status: "dispatched",
    } as unknown as D1AdmissionSnapshot;
    const result: ProviderUsageReceiptResult = {
      object_key:
        `${R2_RESULT_KEY_PREFIX}/${admission.operation_id}/${admission.owner_generation}/${resultSha256}`,
      object_version: "result-version-1",
      sha256: resultSha256,
      size: inputBytes.byteLength,
      content_type: "application/json",
    };
    const evidence = await canonicalProviderUsageReceipt(
      providerUsageReceipt(admission, result),
    );
    const persistedAt = evidence.receipt.provider_completed_at + 1;

    for (const scenario of ["conflict", "malformed"] as const) {
      let writeValues: unknown[] = [];
      const session = {
        prepare() {
          let values: unknown[] = [];
          const statement = {
            bind(...next: unknown[]) {
              values = next;
              return statement;
            },
            async run() {
              writeValues = values;
              return {
                success: true,
                meta: { changes: scenario === "malformed" ? 1 : 0 },
                results: [],
              };
            },
            async first<T>() {
              const row = providerUsageReceiptRowFromBindings(writeValues);
              if (scenario === "conflict") {
                const conflictingReceipt: ProviderUsageReceipt = {
                  ...evidence.receipt,
                  egress_worker_version_id: "different-worker-version",
                };
                const conflictingJson = JSON.stringify(conflictingReceipt);
                row.egress_worker_version_id = conflictingReceipt.egress_worker_version_id;
                row.usage_receipt_json = conflictingJson;
                row.usage_receipt_sha256 = await sha256Bytes(
                  new TextEncoder().encode(conflictingJson),
                );
              } else {
                row.persisted_at = "invalid";
              }
              return row as T;
            },
          };
          return statement;
        },
      };
      const database = {
        prepare: session.prepare,
        withSession() {
          return session;
        },
      } as unknown as D1Database;

      await expect(
        requireD1ProviderUsageReceipt(
          enabledEnv({ CONTAINER_STORAGE_ADMISSION_DB: database }),
          admission,
          evidence,
          result,
          persistedAt,
        ),
      ).rejects.toMatchObject({
        code:
          scenario === "conflict"
            ? "provider_usage_receipt_conflict"
            : "provider_usage_receipt_readback_invalid",
        status: scenario === "conflict" ? 409 : 502,
      });
    }

    await expect(
      requireD1ProviderUsageReceipt(
        enabledEnv(),
        admission,
        evidence,
        result,
        persistedAt,
      ),
    ).rejects.toMatchObject({ code: "provider_usage_receipt_unavailable", status: 503 });
  });

  test("creates and exactly replays the 0047 provider egress grant in a first-primary session", async () => {
    const grant = admissionGrant();
    const admission = {
      ...admissionRow(grant),
      operation_status: "dispatched",
    } as unknown as D1AdmissionSnapshot;
    const identity: ProviderEgressGrantIdentity = {
      attempt_generation: 1,
      request_sha256: grant.input.sha256,
      egress_profile: "openai-chat-completions-canary-v1",
      egress_worker_version_id: "worker-version-1",
    };
    const prepared: string[] = [];
    const constraints: unknown[] = [];
    const writeBindings: unknown[][] = [];
    let stored: Record<string, unknown> | null = null;
    const session = {
      prepare(sql: string) {
        prepared.push(sql);
        let values: unknown[] = [];
        const statement = {
          bind(...next: unknown[]) {
            values = next;
            return statement;
          },
          async run() {
            writeBindings.push(values);
            if (stored !== null) return { success: true, meta: { changes: 0 }, results: [] };
            stored = providerEgressGrantRow(admission, identity, values[6] as number);
            return { success: true, meta: { changes: 1 }, results: [] };
          },
          async first<T>() {
            return (stored === null ? null : { ...stored }) as T | null;
          },
        };
        return statement;
      },
    };
    const database = {
      prepare() {
        throw new Error("grant CAS must use the D1 session when available");
      },
      withSession(constraint: unknown) {
        constraints.push(constraint);
        return session;
      },
    } as unknown as D1Database;
    const env = enabledEnv({ CONTAINER_STORAGE_ADMISSION_DB: database });
    const authorizedAt = admission.operation_updated_at + 2;

    await expect(
      requireD1ProviderEgressGrant(env, admission, identity, authorizedAt),
    ).resolves.toEqual({ replayed: false, authorized_at: authorizedAt });
    await expect(
      requireD1ProviderEgressGrant(env, admission, identity, authorizedAt + 1),
    ).resolves.toEqual({ replayed: true, authorized_at: authorizedAt });

    expect(constraints).toEqual(["first-primary", "first-primary"]);
    expect(prepared[0]).toContain(
      "INSERT OR IGNORE INTO relay_container_provider_egress_grants",
    );
    expect(prepared[0]).toContain("FROM relay_container_operations AS operation");
    expect(prepared[0]).toContain("JOIN relay_billing_reservations AS reservation");
    expect(prepared[0]).toContain("reservation.billing_snapshot_json = ?23");
    expect(prepared[1]).toContain("FROM relay_container_provider_egress_grants");
    expect(writeBindings[0]?.slice(0, 7)).toEqual([
      admission.operation_id,
      admission.owner_generation,
      identity.attempt_generation,
      identity.request_sha256,
      identity.egress_profile,
      identity.egress_worker_version_id,
      authorizedAt,
    ]);
    expect(writeBindings[0]?.[22]).toBe(tieredBillingSnapshotJson);
    expect(writeBindings[0]?.[23]).toBe(tieredBillingSnapshotSha256);
  });

  test("hashes and binds the exact flat billing snapshot through a primary session", async () => {
    const grant = admissionGrant();
    const admission = {
      ...admissionRow(grant),
      operation_status: "dispatched",
      billing_kind: "flat",
      billing_contract_hash: `flat-v4:${flatBillingSnapshotSha256}`,
      billing_snapshot_json: flatBillingSnapshotJson,
    } as unknown as D1AdmissionSnapshot;
    const identity: ProviderEgressGrantIdentity = {
      attempt_generation: 1,
      request_sha256: grant.input.sha256,
      egress_profile: "openai-chat-completions-canary-v1",
      egress_worker_version_id: "worker-version-1",
    };
    const now = admission.operation_updated_at + 2;
    let writeValues: unknown[] = [];
    const session = {
      prepare(sql: string) {
        let values: unknown[] = [];
        const statement = {
          bind(...next: unknown[]) {
            values = next;
            return statement;
          },
          async run() {
            writeValues = values;
            return { success: true, meta: { changes: 1 }, results: [] };
          },
          async first<T>() {
            expect(sql).toContain("FROM relay_container_provider_egress_grants");
            return providerEgressGrantRow(admission, identity, now) as T;
          },
        };
        return statement;
      },
    };
    const database = {
      prepare: session.prepare,
      withSession() {
        return session;
      },
    } as unknown as D1Database;

    await expect(
      requireD1ProviderEgressGrant(
        enabledEnv({ CONTAINER_STORAGE_ADMISSION_DB: database }),
        admission,
        identity,
        now,
      ),
    ).resolves.toEqual({ replayed: false, authorized_at: now });
    expect(writeValues[22]).toBe(flatBillingSnapshotJson);
    expect(writeValues[23]).toBe(flatBillingSnapshotSha256);
  });

  test("fails closed on invalid changes and conflicting 0047 grant readback", async () => {
    const grant = admissionGrant();
    const admission = {
      ...admissionRow(grant),
      operation_status: "dispatched",
    } as unknown as D1AdmissionSnapshot;
    const identity: ProviderEgressGrantIdentity = {
      attempt_generation: 1,
      request_sha256: grant.input.sha256,
      egress_profile: "openai-chat-completions-canary-v1",
      egress_worker_version_id: "worker-version-1",
    };
    const now = admission.operation_updated_at + 2;

    for (const scenario of ["invalid_changes", "conflict"] as const) {
      const session = {
        prepare(sql: string) {
          const statement = {
            bind() {
              return statement;
            },
            async run() {
              return {
                success: true,
                meta: { changes: scenario === "invalid_changes" ? 2 : 0 },
                results: [],
              };
            },
            async first<T>() {
              const row = providerEgressGrantRow(admission, identity, now);
              row.egress_worker_version_id = "different-worker-version";
              return row as T;
            },
          };
          if (sql.includes("INSERT OR IGNORE")) return statement;
          return statement;
        },
      };
      const database = {
        prepare: session.prepare,
        withSession() {
          return session;
        },
      } as unknown as D1Database;

      await expect(
        requireD1ProviderEgressGrant(
          enabledEnv({ CONTAINER_STORAGE_ADMISSION_DB: database }),
          admission,
          identity,
          now,
        ),
      ).rejects.toMatchObject({
        code:
          scenario === "invalid_changes"
            ? "provider_egress_grant_write_invalid"
            : "provider_egress_grant_conflict",
        status: scenario === "invalid_changes" ? 502 : 409,
      });
    }
  });

  test("rejects every immutable 0040 authority field mismatch", async () => {
    const grant = admissionGrant();
    let row = admissionRow(grant);
    const statement = {
      bind() {
        return statement;
      },
      async first<T>() {
        return { ...row } as T;
      },
    };
    const database = {
      prepare() {
        return statement;
      },
    } as unknown as Pick<D1Database, "prepare">;
    const env = enabledEnv({ CONTAINER_STORAGE_ADMISSION_DB: database });
    const request = () => new Request(`https://${D1_ADMISSION_HOST}${D1_ADMISSION_PATH}`);
    const mismatches: Array<[string, unknown]> = [
      ["operation_reservation_key", "reservation-other"],
      ["reservation_owner_generation", 8],
      ["reservation_channel_id", 12],
      ["reservation_selected_group", "default"],
      ["operation_id", "operation-other"],
      ["owner_generation", 8],
      ["owner_lease_expires_at", grant.owner_lease_expires_at + 1],
      ["operation_kind", "responses"],
      ["provider_operation_id", "provider-other"],
      ["admission_sha256", "c".repeat(64)],
      ["protocol_version", 2],
      ["ring_generation", 4],
      ["shard_count", 16],
      ["execution_deadline_at", grant.execution_deadline_at + 1],
      ["input_object_key", "container-inputs/v1/op-other/input.json"],
      ["input_object_version", "version-2"],
      ["input_sha256", "d".repeat(64)],
      ["input_size", inputBytes.byteLength + 1],
      ["input_content_type", "application/octet-stream"],
      ["trace_id", "trace-other"],
    ];

    for (const [field, value] of mismatches) {
      row = { ...admissionRow(grant), [field]: value };
      const response = await handleStorageGatewayRequest(env, request(), grant);
      expect(response.status, field).toBe(409);
      expect(await errorCode(response), field).toBe("admission_authority_mismatch");
    }

    row = {
      ...admissionRow(grant),
      shard_index: 4,
      instance_name: "cinatoken-relay-shard-v1-0004",
    };
    const shardIndexMismatch = await handleStorageGatewayRequest(env, request(), grant);
    expect(shardIndexMismatch.status).toBe(409);
    expect(await errorCode(shardIndexMismatch)).toBe("admission_authority_mismatch");

    for (const [field, value] of [
      ["shard_contract_version", 2],
      ["instance_name", "cinatoken-relay-shard-v1-0004"],
      ["input_mode", "inline"],
    ] as const) {
      row = { ...admissionRow(grant), [field]: value };
      const invalid = await handleStorageGatewayRequest(env, request(), grant);
      expect(invalid.status, field).toBe(502);
      expect(await errorCode(invalid), field).toBe("admission_snapshot_invalid");
    }
  });

  test("rejects terminal operation authority and malformed D1 rows", async () => {
    const grant = admissionGrant();
    let row = { ...admissionRow(grant), operation_status: "completed" };
    const statement = {
      bind() {
        return statement;
      },
      async first<T>() {
        return { ...row } as T;
      },
    };
    const database = {
      prepare() {
        return statement;
      },
    } as unknown as Pick<D1Database, "prepare">;
    const env = enabledEnv({ CONTAINER_STORAGE_ADMISSION_DB: database });
    const request = () => new Request(`https://${D1_ADMISSION_HOST}${D1_ADMISSION_PATH}`);

    const terminal = await handleStorageGatewayRequest(env, request(), grant);
    expect(terminal.status).toBe(409);
    expect(await errorCode(terminal)).toBe("admission_operation_not_active");

    row = { ...admissionRow(grant), channel_id: "11" };
    const malformed = await handleStorageGatewayRequest(env, request(), grant);
    expect(malformed.status).toBe(502);
    expect(await errorCode(malformed)).toBe("admission_snapshot_invalid");
  });

  test("uses the same authoritative D1 check for the pre-execution envelope gate", async () => {
    const grant = admissionGrant();
    const { action: _action, ...envelope } = grant;
    let row = admissionRow(grant);
    const statement = {
      bind() {
        return statement;
      },
      async first<T>() {
        return { ...row } as T;
      },
    };
    const database = {
      prepare() {
        return statement;
      },
    } as unknown as Pick<D1Database, "prepare">;
    const env = enabledEnv({ CONTAINER_STORAGE_ADMISSION_DB: database });
    const now = Math.floor(Date.now() / 1000);

    await expect(requireD1OperationAdmission(env, envelope, now)).resolves.toBeUndefined();

    row = { ...admissionRow(grant), trace_id: "trace-conflict" };
    await expect(requireD1OperationAdmission(env, envelope, now)).rejects.toMatchObject({
      code: "admission_authority_mismatch",
      status: 409,
    });
  });
});
