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
    sha256: resultSha256,
    size: inputBytes.byteLength,
    content_type: "application/json",
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
    gateway_version: "1",
    operation_id: grant.operation_id,
    owner_generation: String(grant.owner_generation),
    provider_operation_id: grant.provider_operation_id,
    admission_sha256: grant.admission_sha256,
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

  test("uses a parameterized owner-fenced D1 query and exposes only the minimal snapshot", async () => {
    const prepared: string[] = [];
    const bound: unknown[][] = [];
    let currentValues: unknown[] = [];
    const statement = {
      bind(...values: unknown[]) {
        currentValues = values;
        bound.push(values);
        return statement;
      },
      async first<T>() {
        if (currentValues[1] !== 7) return null;
        return {
          status: "reserved",
          lease_expires_at: 1_800_000_100,
          owner_generation: 7,
        } as T;
      },
    };
    const database = {
      prepare(sql: string) {
        prepared.push(sql);
        return statement;
      },
    } as unknown as Pick<D1Database, "prepare">;
    const grant: D1AdmissionGetGrant = {
      action: STORAGE_GATEWAY_ACTIONS.D1_ADMISSION_GET,
      operation_id: "op-123",
      owner_generation: 7,
    };
    const request = () => new Request(`https://${D1_ADMISSION_HOST}${D1_ADMISSION_PATH}`);
    const env = enabledEnv({ CONTAINER_STORAGE_ADMISSION_DB: database });

    const response = await handleStorageGatewayRequest(env, request(), grant);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "reserved",
      lease_expires_at: 1_800_000_100,
      owner_generation: 7,
    });
    expect(prepared[0]).toContain("FROM relay_billing_reservations");
    expect(prepared[0]).toContain("reservation_key = ?1 AND owner_generation = ?2");
    expect(prepared[0]).not.toMatch(/user_id|quota|channel_id/i);
    expect(bound[0]).toEqual([grant.operation_id, grant.owner_generation]);

    const fenced = await handleStorageGatewayRequest(
      env,
      request(),
      { ...grant, owner_generation: 8 },
    );
    expect(fenced.status).toBe(404);
    expect(await errorCode(fenced)).toBe("admission_snapshot_not_found");
    expect(bound[1]).toEqual([grant.operation_id, 8]);
  });
});
