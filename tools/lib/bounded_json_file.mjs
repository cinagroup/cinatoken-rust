import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

export const JSON_COMPATIBILITY_CONFIG_MAX_BYTES = 512 * 1024;
export const JSON_COMPATIBILITY_PLAN_MAX_BYTES = 256 * 1024;
export const JSON_COMPATIBILITY_RECEIPT_MAX_BYTES = 1024 * 1024;
export const JSON_COMPATIBILITY_PRIVATE_INVOCATION_RECEIPT_MAX_BYTES =
  1536 * 1024;
export const JSON_COMPATIBILITY_OPERATOR_INVOCATION_RECEIPT_MAX_BYTES =
  1792 * 1024;
export const JSON_COMPATIBILITY_RUNNER_RECEIPT_MAX_BYTES = 1984 * 1024;
export const JSON_COMPATIBILITY_CALLER_RECEIPT_MAX_BYTES = 2016 * 1024;
export const JSON_COMPATIBILITY_CONTEXT_MAX_BYTES = 512 * 1024;
export const JSON_COMPATIBILITY_PHASE_SOURCE_MAX_BYTES = 2 * 1024 * 1024;
export const JSON_COMPATIBILITY_SOURCE_MANIFEST_MAX_BYTES = 8 * 1024 * 1024;
export const JSON_COMPATIBILITY_EVIDENCE_MAX_BYTES = 8 * 1024 * 1024;

export async function readBoundedUtf8File(filePath, maximumBytes, label) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new Error(`${label} path is required`);
  }
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error(`${label} byte limit is invalid`);
  }

  const resolved = path.resolve(filePath);
  let handle;
  try {
    handle = await open(
      resolved,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.size < 1 ||
      before.size > maximumBytes
    ) {
      throw new Error(
        `${label} must be a nonempty regular file no larger than ${maximumBytes} bytes`,
      );
    }

    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      bytes.byteLength !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error(`${label} changed while it was being read`);
    }
    if (
      bytes.byteLength >= 3 &&
      bytes[0] === 0xef &&
      bytes[1] === 0xbb &&
      bytes[2] === 0xbf
    ) {
      throw new Error(`${label} must not contain a UTF-8 BOM`);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`${label} must be valid UTF-8`);
    }
  } finally {
    await handle?.close();
  }
}
