import { sha256Bytes, sha256Text } from "./canonical";
import type { PreparedDeploymentMutation } from "./protocol";

export const CLOUDFLARE_API_ORIGIN = "https://api.cloudflare.com";
export const MAX_RESPONSE_BYTES = 64 * 1024;
export const REQUEST_DEADLINE_MILLISECONDS = 3_000;

const REQUEST_ID_HEADERS = ["cf-ray", "cf-request-id"] as const;

export type MutationClassification = "accepted" | "rejected" | "ambiguous";

export interface MutationTransportOutcome {
  readonly classification: MutationClassification;
  readonly httpStatus: number | null;
  readonly responseBodySha256: string | null;
  readonly responseRequestIdSha256: string | null;
  readonly responseBytes: number | null;
}

export interface MutationClientRuntime {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

const DEFAULT_RUNTIME: MutationClientRuntime = {
  fetch: async (input, init) => await fetch(input, init),
};

export async function postDeploymentMutationOnce(
  apiToken: string,
  mutation: PreparedDeploymentMutation,
  runtime: MutationClientRuntime = DEFAULT_RUNTIME,
): Promise<MutationTransportOutcome> {
  if (apiToken.length < 20 || apiToken.length > 4096) {
    return ambiguousOutcome();
  }
  let response: Response;
  try {
    response = await runtime.fetch(
      `${CLOUDFLARE_API_ORIGIN}${mutation.endpointPath}`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${apiToken}`,
          "content-type": "application/json",
        },
        body: mutation.requestBody,
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_DEADLINE_MILLISECONDS),
      },
    );
  } catch {
    return ambiguousOutcome();
  }

  const evidence = await boundedResponseEvidence(response);
  if (evidence === null) {
    return { ...ambiguousOutcome(), httpStatus: response.status };
  }
  const responseRequestIdSha256 = await requestIdSha256(response);
  if (ambiguousStatus(response.status)) {
    return {
      classification: "ambiguous",
      httpStatus: response.status,
      responseBodySha256: evidence.sha256,
      responseRequestIdSha256,
      responseBytes: evidence.bytes,
    };
  }
  const parsed = parseJsonObject(evidence.body);
  if (parsed === null) {
    return {
      classification: "ambiguous",
      httpStatus: response.status,
      responseBodySha256: evidence.sha256,
      responseRequestIdSha256,
      responseBytes: evidence.bytes,
    };
  }
  if (response.ok) {
    return {
      classification: validAcceptedResponse(parsed, mutation)
        ? "accepted"
        : "ambiguous",
      httpStatus: response.status,
      responseBodySha256: evidence.sha256,
      responseRequestIdSha256,
      responseBytes: evidence.bytes,
    };
  }
  return {
    classification: validRejectedResponse(parsed) ? "rejected" : "ambiguous",
    httpStatus: response.status,
    responseBodySha256: evidence.sha256,
    responseRequestIdSha256,
    responseBytes: evidence.bytes,
  };
}

interface ResponseEvidence {
  readonly body: Uint8Array;
  readonly bytes: number;
  readonly sha256: string;
}

async function boundedResponseEvidence(
  response: Response,
): Promise<ResponseEvidence | null> {
  const contentEncoding = response.headers.get("content-encoding");
  const declaredLength = response.headers.get("content-length");
  if (
    contentEncoding !== null
    || (
      declaredLength !== null
      && (
        !/^\d+$/.test(declaredLength)
        || Number(declaredLength) > MAX_RESPONSE_BYTES
      )
    )
  ) {
    await response.body?.cancel("response_not_admissible");
    return null;
  }
  if (response.body === null) {
    const body = new Uint8Array();
    return { body, bytes: 0, sha256: await sha256Bytes(body) };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel("response_too_large");
        return null;
      }
      chunks.push(next.value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body, bytes: total, sha256: await sha256Bytes(body) };
}

function validAcceptedResponse(
  response: Record<string, unknown>,
  mutation: PreparedDeploymentMutation,
): boolean {
  if (response.success !== true || !emptyArray(response.errors)) return false;
  const result = objectOrNull(response.result);
  if (
    result === null
    || typeof result.id !== "string"
    || result.id.length === 0
    || result.id.length > 128
    || result.strategy !== "percentage"
  ) {
    return false;
  }
  const annotations = objectOrNull(result.annotations);
  if (annotations?.["workers/message"] !== mutation.mutationAnnotation) {
    return false;
  }
  if (!Array.isArray(result.versions) || result.versions.length !== 1) {
    return false;
  }
  const version = objectOrNull(result.versions[0]);
  return version?.version_id === mutation.targetVersionId
    && version.percentage === 100;
}

function validRejectedResponse(response: Record<string, unknown>): boolean {
  if (response.success !== false || !Array.isArray(response.errors)) return false;
  if (response.errors.length === 0 || response.errors.length > 64) return false;
  return response.errors.every((value) => {
    const error = objectOrNull(value);
    return error !== null
      && Number.isSafeInteger(error.code)
      && typeof error.message === "string"
      && error.message.length > 0
      && error.message.length <= 4096;
  });
}

function parseJsonObject(body: Uint8Array): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body),
    );
    return objectOrNull(parsed);
  } catch {
    return null;
  }
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function emptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

function ambiguousStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function requestIdSha256(response: Response): Promise<string | null> {
  for (const header of REQUEST_ID_HEADERS) {
    const value = response.headers.get(header);
    if (value !== null && value.length > 0 && value.length <= 256) {
      return await sha256Text(`${header}:${value}`);
    }
  }
  return null;
}

export function ambiguousOutcome(): MutationTransportOutcome {
  return {
    classification: "ambiguous",
    httpStatus: null,
    responseBodySha256: null,
    responseRequestIdSha256: null,
    responseBytes: null,
  };
}
