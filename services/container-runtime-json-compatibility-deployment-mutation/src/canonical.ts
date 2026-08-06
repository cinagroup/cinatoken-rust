export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export async function sha256Canonical(value: unknown): Promise<string> {
  return await sha256Bytes(new TextEncoder().encode(canonicalJson(value)));
}

export async function sha256Text(value: string): Promise<string> {
  return await sha256Bytes(new TextEncoder().encode(value));
}

export async function sha256Bytes(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

export function cloneCanonical<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function canonicalize(value: unknown): JsonValue {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("canonical JSON cannot contain non-finite numbers");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const output: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      const child: unknown = Reflect.get(value, key);
      if (child === undefined) {
        throw new Error("canonical JSON cannot contain undefined");
      }
      output[key] = canonicalize(child);
    }
    return output;
  }
  throw new Error("canonical JSON contains an unsupported value");
}
