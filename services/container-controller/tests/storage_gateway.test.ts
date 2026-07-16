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
  requireD1OperationAdmission,
  type D1AdmissionGetGrant,
  type KvConfigGetGrant,
  type R2InputGetGrant,
  type R2ResultPutGrant,
  type StorageGatewayEnvironment,
} from "../src/storage_gateway";

const inputBytes = new TextEncoder().encode("hello");
const inputSha256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const resultSha256 = "a".repeat(64);

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
  return {
    reservation_key: "reservation-123",
    operation_reservation_key: "reservation-123",
    reservation_status: "reserved",
    lease_expires_at: grant.owner_lease_expires_at + 30,
    owner_deadline_at: grant.execution_deadline_at + 10,
    reservation_owner_generation: grant.owner_generation,
    reservation_channel_id: 11,
    reservation_selected_group: "premium",
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
  return {
    gateway_version: grant.attempt_generation === null ? "1" : "2",
    operation_id: grant.operation_id,
    owner_generation: String(grant.owner_generation),
    provider_operation_id: grant.provider_operation_id,
    admission_sha256: grant.admission_sha256,
    ...(grant.attempt_generation === null
      ? {}
      : { attempt_generation: String(grant.attempt_generation) }),
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
