import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import { canonicalJson } from "./container_runtime_worm_staging.mjs";

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;
const MAX_STRING_BYTES = 1024 * 1024;

export async function readCanonicalReceiptFile(
  file,
  {
    label = "receipt",
    maxBytes = DEFAULT_MAX_BYTES,
    errorFactory = (message) => new Error(message),
  } = {},
) {
  const fail = (message) => {
    throw errorFactory(message);
  };
  if (
    typeof file !== "string" ||
    file.length === 0 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 2
  ) {
    fail(`[predecessor] ${label} path or byte bound is invalid`);
  }
  const resolved = path.resolve(file);
  const initial = await lstat(resolved, { bigint: true }).catch(
    () => null,
  );
  if (
    !initial ||
    !initial.isFile() ||
    initial.isSymbolicLink() ||
    initial.nlink !== 1n ||
    initial.size <= 0n ||
    initial.size > BigInt(maxBytes)
  ) {
    fail(`[predecessor] ${label} is outside its file bound`);
  }
  const handle = await open(
    resolved,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  ).catch(() => null);
  if (!handle) {
    fail(`[predecessor] ${label} could not be opened`);
  }
  let bytes;
  try {
    const opened = await handle.stat({ bigint: true });
    const openedPath = await realpath(resolved).catch(() => null);
    if (
      openedPath === null ||
      !sameSnapshot(initial, opened) ||
      !samePath(resolved, openedPath)
    ) {
      fail(`[predecessor] ${label} changed before read`);
    }
    bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (bytesRead === 0) {
        fail(`[predecessor] ${label} changed while read`);
      }
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const final = await lstat(resolved, { bigint: true }).catch(
      () => null,
    );
    const finalPath = await realpath(resolved).catch(() => null);
    if (
      !final ||
      final.isSymbolicLink() ||
      finalPath === null ||
      !sameSnapshot(opened, after) ||
      !sameSnapshot(opened, final) ||
      !samePath(resolved, finalPath)
    ) {
      fail(`[predecessor] ${label} changed while read`);
    }
  } finally {
    await handle.close();
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(`[predecessor] ${label} must be UTF-8`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail(`[predecessor] ${label} must be JSON`);
  }
  auditJsonShape(value, `[predecessor] ${label}`, fail);
  if (text !== `${canonicalJson(value)}\n`) {
    fail(
      `[predecessor] ${label} must be canonical JSON plus one newline`,
    );
  }
  return { path: resolved, text, value };
}

function sameSnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.nlink === right.nlink &&
    right.nlink === 1n
  );
}

function samePath(left, right) {
  const normalize = (value) => {
    const normalized = path.normalize(path.resolve(value));
    return process.platform === "win32"
      ? normalized.toLowerCase()
      : normalized;
  };
  return normalize(left) === normalize(right);
}

function auditJsonShape(value, label, fail) {
  let nodes = 0;
  const visit = (entry, depth) => {
    nodes += 1;
    if (depth > MAX_JSON_DEPTH || nodes > MAX_JSON_NODES) {
      fail(`${label} exceeds JSON complexity bounds`);
    }
    if (typeof entry === "string") {
      if (Buffer.byteLength(entry, "utf8") > MAX_STRING_BYTES) {
        fail(`${label} contains an oversized string`);
      }
      return;
    }
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item, depth + 1);
      return;
    }
    if (entry !== null && typeof entry === "object") {
      for (const [key, item] of Object.entries(entry)) {
        if (Buffer.byteLength(key, "utf8") > 256) {
          fail(`${label} contains an oversized key`);
        }
        visit(item, depth + 1);
      }
      return;
    }
    if (
      entry !== null &&
      typeof entry !== "boolean" &&
      typeof entry !== "number"
    ) {
      fail(`${label} contains an unsupported JSON value`);
    }
    if (typeof entry === "number" && !Number.isFinite(entry)) {
      fail(`${label} contains an unsupported JSON value`);
    }
  };
  visit(value, 0);
}
