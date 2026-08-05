type CanonicalValue =
  | null
  | string
  | boolean
  | number
  | CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export async function sha256Canonical(value: unknown): Promise<string> {
  return await sha256Bytes(new TextEncoder().encode(canonicalJson(value)));
}

export async function sha256Bytes(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer;
}

function canonicalize(value: unknown): CanonicalValue {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("canonical JSON cannot contain non-finite numbers");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const input = value as Record<string, unknown>;
    const result: Record<string, CanonicalValue> = {};
    for (const key of Object.keys(input).sort()) {
      const child = input[key];
      if (child === undefined) {
        throw new Error("canonical JSON cannot contain undefined");
      }
      result[key] = canonicalize(child);
    }
    return result;
  }
  throw new Error("canonical JSON contains an unsupported value");
}
