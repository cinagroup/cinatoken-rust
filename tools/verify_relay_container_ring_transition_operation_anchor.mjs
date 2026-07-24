#!/usr/bin/env bun

import {
  lstat,
  open,
  realpath,
} from "node:fs/promises";
import path from "node:path";

import {
  MAX_RING_TRANSITION_OPERATION_HEAD_BYTES,
  describeRingTransitionOperationAnchorContract,
  verifyRingTransitionOperationHeadLocalSeal,
} from "./relay_container_ring_transition_operation_anchor_contract.mjs";

try {
  const options = parseArgs(process.argv.slice(2));
  const result = options.describe
    ? describeRingTransitionOperationAnchorContract()
    : verifyRingTransitionOperationHeadLocalSeal({
        headSetBytes: await readStableFile(options.headSet, "head set"),
        localSealBytes: await readStableFile(
          options.localSeal,
          "local seal",
        ),
      });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : "operation anchor verification failed closed",
  );
  process.exit(1);
}

function parseArgs(argv) {
  const values = new Map();
  let describe = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      usage(0);
    }
    if (argument === "--describe") {
      if (describe) {
        usage(2, "[input] --describe must not be repeated");
      }
      describe = true;
      continue;
    }
    if (argument !== "--head-set" && argument !== "--local-seal") {
      usage(2, `[input] unknown option: ${argument}`);
    }
    if (values.has(argument)) {
      usage(2, `[input] ${argument} must not be repeated`);
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) {
      usage(2, `[input] ${argument} requires a path`);
    }
    values.set(argument, value);
  }
  if (describe) {
    if (values.size !== 0) {
      usage(2, "[input] --describe does not accept document paths");
    }
    return { describe: true };
  }
  if (!values.has("--head-set") || !values.has("--local-seal")) {
    usage(2, "[input] --head-set and --local-seal are required");
  }
  return {
    describe: false,
    headSet: values.get("--head-set"),
    localSeal: values.get("--local-seal"),
  };
}

async function readStableFile(file, label) {
  const resolved = path.resolve(file);
  const before = await lstat(resolved, { bigint: true }).catch(() => null);
  if (
    !before ||
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size <= 0n ||
    before.size > BigInt(MAX_RING_TRANSITION_OPERATION_HEAD_BYTES)
  ) {
    throw new Error(`[input] ${label} must be one bounded, non-linked regular file`);
  }
  const handle = await open(resolved, "r");
  try {
    const opened = await handle.stat({ bigint: true });
    const openedRealPath = await realpath(resolved);
    if (!sameSnapshot(before, opened)) {
      throw new Error(`[input] ${label} changed before open`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const final = await lstat(resolved, { bigint: true }).catch(() => null);
    const finalRealPath = await realpath(resolved).catch(() => null);
    if (
      !final ||
      !final.isFile() ||
      final.isSymbolicLink() ||
      final.nlink !== 1n ||
      !sameSnapshot(opened, after) ||
      !sameSnapshot(opened, final) ||
      bytes.length !== Number(opened.size) ||
      finalRealPath !== openedRealPath
    ) {
      throw new Error(`[input] ${label} changed while read`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function sameSnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function usage(exitCode, error) {
  if (error) {
    console.error(error);
  }
  console.error(
    [
      "Usage:",
      "  bun tools/verify_relay_container_ring_transition_operation_anchor.mjs --describe",
      "  bun tools/verify_relay_container_ring_transition_operation_anchor.mjs --head-set <operation-head-set.json> --local-seal <operation-head-local-seal.json>",
      "",
      "The verifier is offline and read-only. It verifies only the structure of the supplied canonical head-set document, its binding to the supplied local-seal document, and any supplied terminal-candidate operation binding within those documents.",
      "It does not verify the execution chain, operation-context preimage, operation receipt heads, terminal snapshot candidate content, capacity-marker filesystem completeness, local filesystem completeness, a detached signature, WORM storage, or external anchoring.",
    ].join("\n"),
  );
  process.exit(exitCode);
}
