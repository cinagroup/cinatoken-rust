import {
  ProtocolError,
  canonicalJson,
  sha256Hex,
} from "./protocol";

export const CONTROLLER_DISABLE_ATTESTATION_PATH =
  "/internal/v1/shard-placement/disable-attestation";
export const CONTROLLER_DISABLE_ATTESTATION_CONTRACT =
  "cinatoken-container-controller-disable-attestation-v1";

const INTERNAL_ORIGIN = "https://container-controller.internal";
const AUTHORITY_HEADER =
  "x-cinatoken-controller-disable-attestation-authority";
const AUTHORITY_DOMAIN =
  "cinatoken:container-controller:disable-attestation-authority:v1\0";
const CREDENTIAL_DOMAIN =
  "cinatoken:container-controller:disable-attestation-credential:v1\0";
const AUTHORITY_TYPE =
  "CINATOKEN-CONTROLLER-DISABLE-ATTESTATION-AUTH";
const ROLE = "disable_attestation";
const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const MAX_RESPONSE_BYTES = 16 * 1024;
const REQUEST_TIMEOUT_MILLISECONDS = 3_000;
const SHA256 = /^[0-9a-f]{64}$/;
const KEY_ID = /^[a-z0-9-]+$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SERVICE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const VERSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const encoder = new TextEncoder();

export interface ControllerDisableAttestationBinding {
  fetch(request: Request): Promise<Response>;
}

export interface ControllerDisableAttestationClientEnv {
  CONTAINER_CONTROLLER: ControllerDisableAttestationBinding;
  CONTROLLER_DISABLE_ATTESTATION_AUTHORITY_ISSUER: string;
  CONTROLLER_DISABLE_ATTESTATION_AUTHORITY_AUDIENCE: string;
  CONTROLLER_DISABLE_ATTESTATION_CURRENT_KID: string;
  CONTROLLER_DISABLE_ATTESTATION_CURRENT_SECRET?: string;
  CONTROLLER_DISABLE_ATTESTATION_PREVIOUS_KID: string;
  CONTROLLER_DISABLE_ATTESTATION_PREVIOUS_SECRET?: string;
}

export interface ControllerDisableAttestationExpected {
  controllerServiceName: string;
  controllerVersionId: string;
  actionGateInventorySha256: string;
  actionGateCount: number;
}

export interface ControllerDisableAttestationCallOptions {
  requestId: string;
  credentialGeneration?: "current" | "previous";
  now?: number;
}

export interface ControllerDisableAttestationResult {
  schemaVersion: 1;
  contract: typeof CONTROLLER_DISABLE_ATTESTATION_CONTRACT;
  requestIdSha256: string;
  controllerServiceName: string;
  controllerVersionId: string;
  controllerEnabled: false;
  executionEnabled: false;
  allActionGatesFalse: true;
  actionGates: {
    allActionGatesFalse: true;
    count: number;
    digestSha256: string;
    inventory: readonly {
      enabled: false;
      name: string;
    }[];
  };
}

export interface ControllerDisableAttestationEvidence {
  value: ControllerDisableAttestationResult;
  credentialIdSha256: string;
  requestIdSha256: string;
  responseSha256: string;
  responseBytes: number;
}

export class ControllerDisableAttestationClientError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly classification:
      | "request_invalid"
      | "attestation_unavailable"
      | "attestation_invalid",
  ) {
    super(code);
    this.name = "ControllerDisableAttestationClientError";
  }
}

export async function readControllerDisableAttestation(
  env: ControllerDisableAttestationClientEnv,
  expected: ControllerDisableAttestationExpected,
  options: ControllerDisableAttestationCallOptions,
): Promise<ControllerDisableAttestationEvidence> {
  validateControllerDisableAttestationClientConfig(env);
  validateExpected(expected);
  if (!IDENTITY.test(options.requestId)) {
    throw clientError(
      "controller_disable_attestation_request_invalid",
      400,
      "request_invalid",
    );
  }
  const now = options.now ?? Math.floor(Date.now() / 1_000);
  if (!Number.isSafeInteger(now) || now <= 0) {
    throw clientError(
      "controller_disable_attestation_request_invalid",
      400,
      "request_invalid",
    );
  }
  const selected = selectCredential(
    env,
    options.credentialGeneration ?? "current",
  );
  const requestIdSha256 =
    await sha256Hex(encoder.encode(options.requestId));
  const credentialIdSha256 =
    await controllerDisableAttestationCredentialIdSha256(selected.kid);
  const headerPart = encodeBase64Url(encoder.encode(canonicalJson({
    alg: "HS256",
    kid: selected.kid,
    typ: AUTHORITY_TYPE,
  })));
  const claimsPart = encodeBase64Url(encoder.encode(canonicalJson({
    audience: env.CONTROLLER_DISABLE_ATTESTATION_AUTHORITY_AUDIENCE,
    authority_version: 1,
    body_sha256: EMPTY_SHA256,
    credential_id_sha256: credentialIdSha256,
    expires_at: now + 30,
    issued_at: now,
    issuer: env.CONTROLLER_DISABLE_ATTESTATION_AUTHORITY_ISSUER,
    method: "POST",
    path_and_query: CONTROLLER_DISABLE_ATTESTATION_PATH,
    request_id_sha256: requestIdSha256,
    role: ROLE,
  })));
  let token: string;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(selected.secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = new Uint8Array(await crypto.subtle.sign(
      "HMAC",
      key,
      copyArrayBuffer(encoder.encode(
        `${AUTHORITY_DOMAIN}${ROLE}\0${headerPart}.${claimsPart}`,
      )),
    ));
    token =
      `${headerPart}.${claimsPart}.${encodeBase64Url(signature)}`;
  } catch {
    throw clientError(
      "controller_disable_attestation_client_unavailable",
      503,
      "attestation_unavailable",
    );
  }

  const request = new Request(
    `${INTERNAL_ORIGIN}${CONTROLLER_DISABLE_ATTESTATION_PATH}`,
    {
      method: "POST",
      redirect: "manual",
      headers: {
        accept: "application/json",
        [AUTHORITY_HEADER]: token,
      },
    },
  );
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort("controller_disable_attestation_timeout"),
    REQUEST_TIMEOUT_MILLISECONDS,
  );
  try {
    const response = await env.CONTAINER_CONTROLLER.fetch(
      new Request(request, { signal: controller.signal }),
    );
    requireResponseMetadata(response);
    const bytes = await readBoundedResponse(response);
    const value = parseAttestation(bytes, expected, requestIdSha256);
    return {
      value,
      credentialIdSha256,
      requestIdSha256,
      responseSha256: await sha256Hex(bytes),
      responseBytes: bytes.byteLength,
    };
  } catch (error) {
    if (error instanceof ControllerDisableAttestationClientError) {
      throw error;
    }
    throw clientError(
      controller.signal.aborted
        ? "controller_disable_attestation_timeout"
        : "controller_disable_attestation_unavailable",
      controller.signal.aborted ? 504 : 503,
      "attestation_unavailable",
    );
  } finally {
    clearTimeout(timeout);
  }
}

export function validateControllerDisableAttestationClientConfig(
  env: ControllerDisableAttestationClientEnv,
): void {
  if (
    env.CONTAINER_CONTROLLER === undefined
    || typeof env.CONTAINER_CONTROLLER.fetch !== "function"
    || !IDENTITY.test(env.CONTROLLER_DISABLE_ATTESTATION_AUTHORITY_ISSUER)
    || !IDENTITY.test(env.CONTROLLER_DISABLE_ATTESTATION_AUTHORITY_AUDIENCE)
  ) {
    throw invalidConfig();
  }
  const current = selectCredential(env, "current", false);
  if (
    !KEY_ID.test(current.kid)
    || encoder.encode(current.secret).byteLength < 32
    || encoder.encode(current.secret).byteLength > 256
  ) {
    throw invalidConfig();
  }
  const previousKid = env.CONTROLLER_DISABLE_ATTESTATION_PREVIOUS_KID;
  const previousSecret =
    env.CONTROLLER_DISABLE_ATTESTATION_PREVIOUS_SECRET ?? "";
  if (
    (previousKid === "") !== (previousSecret === "")
    || (
      previousKid !== ""
      && (
        !KEY_ID.test(previousKid)
        || encoder.encode(previousSecret).byteLength < 32
        || encoder.encode(previousSecret).byteLength > 256
        || previousKid === current.kid
        || previousSecret === current.secret
      )
    )
  ) {
    throw invalidConfig();
  }
}

export async function controllerDisableAttestationCredentialIdSha256(
  kid: string,
): Promise<string> {
  if (!KEY_ID.test(kid)) {
    throw clientError(
      "controller_disable_attestation_kid_invalid",
      400,
      "request_invalid",
    );
  }
  return sha256Hex(encoder.encode(
    `${CREDENTIAL_DOMAIN}${ROLE}\0${kid}`,
  ));
}

function parseAttestation(
  bytes: Uint8Array,
  expected: ControllerDisableAttestationExpected,
  requestIdSha256: string,
): ControllerDisableAttestationResult {
  const value = parseCanonicalObject(bytes);
  assertExactKeys(value, [
    "action_gates",
    "all_action_gates_false",
    "contract",
    "controller_enabled",
    "controller_service_name",
    "controller_version_id",
    "execution_enabled",
    "request_id_sha256",
    "schema_version",
  ]);
  const gatesValue = requireObject(value.action_gates);
  assertExactKeys(gatesValue, [
    "all_action_gates_false",
    "count",
    "digest_sha256",
    "inventory",
  ]);
  if (!Array.isArray(gatesValue.inventory)) throw invalidAttestation();
  const inventory = gatesValue.inventory.map((entry) => {
    const gate = requireObject(entry);
    assertExactKeys(gate, ["enabled", "name"]);
    if (
      gate.enabled !== false
      || typeof gate.name !== "string"
      || !/^[A-Z][A-Z0-9_]{1,127}$/.test(gate.name)
    ) {
      throw invalidAttestation();
    }
    return { enabled: false as const, name: gate.name };
  });
  const count = requireInteger(gatesValue.count, 1, 128);
  const digestSha256 = requireSha256(gatesValue.digest_sha256);
  const parsed: ControllerDisableAttestationResult = {
    schemaVersion: requireLiteral(value.schema_version, 1),
    contract: requireLiteral(
      value.contract,
      CONTROLLER_DISABLE_ATTESTATION_CONTRACT,
    ),
    requestIdSha256: requireSha256(value.request_id_sha256),
    controllerServiceName:
      requireString(value.controller_service_name, SERVICE_NAME),
    controllerVersionId:
      requireString(value.controller_version_id, VERSION_ID),
    controllerEnabled: requireLiteral(value.controller_enabled, false),
    executionEnabled: requireLiteral(value.execution_enabled, false),
    allActionGatesFalse:
      requireLiteral(value.all_action_gates_false, true),
    actionGates: {
      allActionGatesFalse:
        requireLiteral(gatesValue.all_action_gates_false, true),
      count,
      digestSha256,
      inventory,
    },
  };
  if (
    parsed.requestIdSha256 !== requestIdSha256
    || parsed.controllerServiceName !== expected.controllerServiceName
    || parsed.controllerVersionId !== expected.controllerVersionId
    || parsed.actionGates.digestSha256
      !== expected.actionGateInventorySha256
    || parsed.actionGates.count !== expected.actionGateCount
    || parsed.actionGates.inventory.length !== expected.actionGateCount
    || new Set(
      parsed.actionGates.inventory.map((gate) => gate.name),
    ).size !== expected.actionGateCount
  ) {
    throw invalidAttestation();
  }
  return parsed;
}

function requireResponseMetadata(response: Response): void {
  const contentLength = response.headers.get("content-length");
  if (
    response.status !== 200
    || response.redirected
    || response.headers.has("content-encoding")
    || (
      contentLength !== null
      && (
        !/^\d+$/.test(contentLength)
        || Number(contentLength) > MAX_RESPONSE_BYTES
      )
    )
    || response.headers.get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() !== "application/json"
    || !hasNoStore(response.headers.get("cache-control"))
  ) {
    throw invalidAttestation();
  }
}

async function readBoundedResponse(response: Response): Promise<Uint8Array> {
  if (response.body === null) throw invalidAttestation();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel("controller_disable_attestation_too_large");
        throw invalidAttestation();
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof ControllerDisableAttestationClientError) {
      throw error;
    }
    throw invalidAttestation();
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw invalidAttestation();
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function validateExpected(
  value: ControllerDisableAttestationExpected,
): void {
  if (
    !SERVICE_NAME.test(value.controllerServiceName)
    || !VERSION_ID.test(value.controllerVersionId)
    || !SHA256.test(value.actionGateInventorySha256)
    || !Number.isSafeInteger(value.actionGateCount)
    || value.actionGateCount < 1
    || value.actionGateCount > 128
  ) {
    throw clientError(
      "controller_disable_attestation_expected_invalid",
      400,
      "request_invalid",
    );
  }
}

function selectCredential(
  env: ControllerDisableAttestationClientEnv,
  generation: "current" | "previous",
  validate = true,
): { kid: string; secret: string } {
  const selected = generation === "current"
    ? {
      kid: env.CONTROLLER_DISABLE_ATTESTATION_CURRENT_KID,
      secret: env.CONTROLLER_DISABLE_ATTESTATION_CURRENT_SECRET ?? "",
    }
    : {
      kid: env.CONTROLLER_DISABLE_ATTESTATION_PREVIOUS_KID,
      secret: env.CONTROLLER_DISABLE_ATTESTATION_PREVIOUS_SECRET ?? "",
    };
  if (
    validate
    && (
      !KEY_ID.test(selected.kid)
      || encoder.encode(selected.secret).byteLength < 32
    )
  ) {
    throw invalidConfig();
  }
  return selected;
}

function parseCanonicalObject(bytes: Uint8Array): Record<string, unknown> {
  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    throw invalidAttestation();
  }
  if (canonicalJson(value) !== text) throw invalidAttestation();
  return requireObject(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (
    actual.length !== sorted.length
    || actual.some((key, index) => key !== sorted[index])
  ) {
    throw invalidAttestation();
  }
}

function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidAttestation();
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw invalidAttestation();
  }
  return value;
}

function requireSha256(value: unknown): string {
  return requireString(value, SHA256);
}

function requireInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    throw invalidAttestation();
  }
  return value;
}

function requireLiteral<T extends string | number | boolean>(
  value: unknown,
  expected: T,
): T {
  if (value !== expected) throw invalidAttestation();
  return expected;
}

function hasNoStore(value: string | null): boolean {
  return value?.split(",").some(
    (directive) => directive.trim().toLowerCase() === "no-store",
  ) === true;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function invalidConfig(): ControllerDisableAttestationClientError {
  return clientError(
    "controller_disable_attestation_client_config_invalid",
    503,
    "request_invalid",
  );
}

function invalidAttestation(): ControllerDisableAttestationClientError {
  return clientError(
    "controller_disable_attestation_invalid_response",
    502,
    "attestation_invalid",
  );
}

function clientError(
  code: string,
  status: number,
  classification:
    | "request_invalid"
    | "attestation_unavailable"
    | "attestation_invalid",
): ControllerDisableAttestationClientError {
  return new ControllerDisableAttestationClientError(
    code,
    status,
    classification,
  );
}
