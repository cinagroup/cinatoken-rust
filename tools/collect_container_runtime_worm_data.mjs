#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  link,
  open,
  readdir,
  realpath,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GetObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import {
  WORM_OBJECTS,
  WormDataCollectorError,
  buildDataDryRunReceipt,
  collectIndependentReadback,
  describeDataCollector,
  normalizeArtifactDescriptors,
  normalizePublishPredecessors,
  normalizeReadbackPredecessor,
  publishCreateOnlyObjects,
  readDataCredentials,
} from "./lib/container_runtime_worm_data.mjs";
import {
  canonicalJson,
  normalizeTarget,
  normalizeWormPolicy,
  r2S3Endpoint,
} from "./lib/container_runtime_worm_staging.mjs";
import {
  readCanonicalReceiptFile,
} from "./lib/container_runtime_worm_receipt_file.mjs";

const policyUrl = new URL(
  "../config/container-runtime-worm-retention-policy.json",
  import.meta.url,
);
const MAX_RECEIPT_BYTES = 2 * 1024 * 1024;
const MAX_OBJECT_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_OBJECT_BYTES = 768 * 1024 * 1024;
const HASH_BUFFER_BYTES = 1024 * 1024;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}

async function main() {
  let artifactSet = null;
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.mode === "describe") {
      process.stdout.write(`${canonicalJson(describeDataCollector())}\n`);
      return;
    }
    if (args.mode === "self-test") {
      process.stdout.write(`${canonicalJson(await runSelfTest())}\n`);
      return;
    }
    const policy = await loadPolicy();
    let target;
    if (args.phase === "publish") {
      const baseline = await readCanonicalReceipt(
        args.values.get("baseline-receipt"),
        "baseline receipt",
      );
      const lockRevocation = await readCanonicalReceipt(
        args.values.get("lock-revocation-receipt"),
        "lock revocation receipt",
      );
      target = normalizePublishPredecessors({
        accountId: args.values.get("account-id"),
        baselineReceipt: baseline.value,
        baselineReceiptText: baseline.text,
        lockRevocationReceipt: lockRevocation.value,
        lockRevocationReceiptText: lockRevocation.text,
      });
      requirePolicyTarget(target, policy);
      artifactSet = await openArtifactSet(
        args.values.get("artifact-dir"),
        target,
      );
      const artifacts = normalizeArtifactDescriptors(
        artifactSet.descriptors,
        target,
      );
      if (!args.live) {
        process.stdout.write(
          `${canonicalJson(
            buildDataDryRunReceipt("publish", target, artifacts),
          )}\n`,
        );
        return;
      }
      requireLiveConfirmation(args);
      const credentials = readDataCredentials("publish", process.env);
      const client = createS3Client(target, credentials);
      let receipt;
      try {
        receipt = await publishCreateOnlyObjects({
          target,
          artifacts,
          credentials,
          commitSha: args.values.get("commit-sha"),
          s3: awsS3Adapter(client),
        });
        await artifactSet.verifyStable();
      } finally {
        client.destroy();
      }
      process.stdout.write(`${canonicalJson(receipt)}\n`);
      return;
    }

    const publish = await readCanonicalReceipt(
      args.values.get("publish-receipt"),
      "publish receipt",
    );
    target = normalizeReadbackPredecessor({
      accountId: args.values.get("account-id"),
      publishReceipt: publish.value,
      publishReceiptText: publish.text,
    });
    requirePolicyTarget(target, policy);
    if (!args.live) {
      process.stdout.write(
        `${canonicalJson(buildDataDryRunReceipt("readback", target))}\n`,
      );
      return;
    }
    requireLiveConfirmation(args);
    const sink = await createSecureOutputSink(
      args.values.get("output-dir"),
    );
    const credentials = readDataCredentials("readback", process.env);
    const client = createS3Client(target, credentials);
    let receipt;
    try {
      receipt = await collectIndependentReadback({
        target,
        credentials,
        s3: awsS3Adapter(client),
        sink,
      });
      await sink.verifyComplete();
    } finally {
      client.destroy();
    }
    process.stdout.write(`${canonicalJson(receipt)}\n`);
  } catch (error) {
    const message =
      error instanceof WormDataCollectorError
        ? error.message
        : process.argv.includes("--self-test") && error instanceof Error
          ? `[self-test] ${error.message}`
          : "[data-collector] operation failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  } finally {
    if (artifactSet) await artifactSet.close();
  }
}

function parseArgs(argv) {
  if (argv.length === 0) {
    return {
      mode: "describe",
      live: false,
      phase: null,
      values: new Map(),
      flags: new Set(),
    };
  }
  const values = new Map();
  const flags = new Set();
  const knownValues = new Set([
    "account-id",
    "artifact-dir",
    "baseline-receipt",
    "commit-sha",
    "lock-revocation-receipt",
    "output-dir",
    "phase",
    "publish-receipt",
  ]);
  const knownFlags = new Set([
    "confirm-create-only-publication",
    "confirm-readback-files",
    "confirm-staging-target",
    "describe",
    "dry-run",
    "live",
    "self-test",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") usage(0);
    if (!argument.startsWith("--")) {
      usage(2, "[input] unexpected positional argument");
    }
    const key = argument.slice(2);
    if (knownFlags.has(key)) {
      if (flags.has(key)) usage(2, `[input] ${argument} must not repeat`);
      flags.add(key);
      continue;
    }
    if (!knownValues.has(key)) usage(2, "[input] unknown option");
    const value = argv[++index];
    if (!value || value.startsWith("--")) {
      usage(2, `[input] ${argument} requires a value`);
    }
    if (values.has(key)) usage(2, `[input] ${argument} must not repeat`);
    values.set(key, value);
  }
  const standalone = ["describe", "self-test"].filter((flag) =>
    flags.has(flag),
  );
  if (standalone.length > 0) {
    if (standalone.length !== 1 || flags.size !== 1 || values.size !== 0) {
      usage(2, "[input] --describe and --self-test must be standalone");
    }
    return {
      mode: standalone[0],
      live: false,
      phase: null,
      values,
      flags,
    };
  }
  if (flags.has("live") && flags.has("dry-run")) {
    usage(2, "[input] --live and --dry-run are mutually exclusive");
  }
  if (
    !flags.has("live") &&
    [
      "confirm-create-only-publication",
      "confirm-readback-files",
      "confirm-staging-target",
    ].some((flag) => flags.has(flag))
  ) {
    usage(2, "[input] live confirmation flags require --live");
  }
  for (const key of ["account-id", "phase"]) {
    if (!values.has(key)) usage(2, `[input] --${key} is required`);
  }
  const phase = values.get("phase");
  if (phase !== "publish" && phase !== "readback") {
    usage(2, "[input] --phase must be publish or readback");
  }
  const publishValues = [
    "artifact-dir",
    "baseline-receipt",
    "commit-sha",
    "lock-revocation-receipt",
  ];
  const readbackValues = ["output-dir", "publish-receipt"];
  const required = phase === "publish" ? publishValues : readbackValues;
  const forbidden = phase === "publish" ? readbackValues : publishValues;
  for (const key of required) {
    if (!values.has(key)) usage(2, `[input] --${key} is required`);
  }
  for (const key of forbidden) {
    if (values.has(key)) {
      usage(2, `[input] --${key} is invalid for ${phase}`);
    }
  }
  return {
    mode: "phase",
    live: flags.has("live"),
    phase,
    values,
    flags,
  };
}

function requireLiveConfirmation(args) {
  if (!args.flags.has("confirm-staging-target")) {
    throw new WormDataCollectorError(
      "[confirmation] live data collection requires --confirm-staging-target",
    );
  }
  if (
    args.phase === "publish" &&
    !args.flags.has("confirm-create-only-publication")
  ) {
    throw new WormDataCollectorError(
      "[confirmation] publish requires --confirm-create-only-publication",
    );
  }
  if (
    args.phase === "readback" &&
    !args.flags.has("confirm-readback-files")
  ) {
    throw new WormDataCollectorError(
      "[confirmation] readback requires --confirm-readback-files",
    );
  }
  if (
    args.phase === "publish" &&
    args.flags.has("confirm-readback-files")
  ) {
    throw new WormDataCollectorError(
      "[confirmation] readback confirmation is invalid for publish",
    );
  }
  if (
    args.phase === "readback" &&
    args.flags.has("confirm-create-only-publication")
  ) {
    throw new WormDataCollectorError(
      "[confirmation] publication confirmation is invalid for readback",
    );
  }
}

function createS3Client(target, credentials) {
  return new S3Client({
    region: "auto",
    endpoint: r2S3Endpoint(target),
    forcePathStyle: true,
    maxAttempts: 1,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    },
  });
}

function awsS3Adapter(client) {
  return {
    putObject(input, abortSignal) {
      return client.send(new PutObjectCommand(input), { abortSignal });
    },
    listObjectsV2(input, abortSignal) {
      return client.send(new ListObjectsV2Command(input), { abortSignal });
    },
    listMultipartUploads(input, abortSignal) {
      return client.send(new ListMultipartUploadsCommand(input), {
        abortSignal,
      });
    },
    getObject(input, abortSignal) {
      return client.send(new GetObjectCommand(input), { abortSignal });
    },
  };
}

async function loadPolicy() {
  let value;
  try {
    value = JSON.parse(await readFileUrl(policyUrl));
  } catch {
    throw new WormDataCollectorError(
      "[policy] unable to read the pinned WORM protocol policy",
    );
  }
  try {
    return normalizeWormPolicy(value);
  } catch (error) {
    throw new WormDataCollectorError(
      error instanceof Error ? error.message : "[policy] policy drifted",
    );
  }
}

async function readFileUrl(url) {
  const handle = await open(fileURLToPath(url), fsConstants.O_RDONLY);
  try {
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function requirePolicyTarget(target, policy) {
  let normalized;
  try {
    normalized = normalizeTarget(
      {
        accountId: target.accountId,
        bucketName: target.bucketName,
        jurisdiction: target.jurisdiction,
        statementSha256: target.statementSha256,
      },
      policy,
    );
  } catch (error) {
    throw new WormDataCollectorError(
      error instanceof Error
        ? error.message
        : "[policy] target is outside policy",
    );
  }
  if (
    normalized.accountIdSha256 !== target.accountIdSha256 ||
    normalized.prefix !== target.prefix
  ) {
    throw new WormDataCollectorError(
      "[policy] predecessor target drifted from policy",
    );
  }
}

async function readCanonicalReceipt(file, label) {
  return readCanonicalReceiptFile(file, {
    label,
    maxBytes: MAX_RECEIPT_BYTES,
    errorFactory: (message) => new WormDataCollectorError(message),
  });
}

async function openArtifactSet(directory, target) {
  const root = await requireExactDirectory(directory, "artifact");
  const expectedNames = WORM_OBJECTS.map((value) => value.fileName);
  const entries = await readdir(root);
  if (canonicalJson([...entries].sort()) !== canonicalJson([...expectedNames].sort())) {
    throw new WormDataCollectorError(
      "[artifacts] directory must contain exactly the six required files",
    );
  }
  const handles = [];
  const descriptors = [];
  let totalBytes = 0;
  try {
    for (const definition of WORM_OBJECTS) {
      const file = path.join(root, definition.fileName);
      const initial = await lstat(file, { bigint: true }).catch(() => null);
      if (
        !initial ||
        !initial.isFile() ||
        initial.isSymbolicLink() ||
        initial.nlink !== 1n ||
        initial.size <= 0n ||
        initial.size > BigInt(MAX_OBJECT_BYTES)
      ) {
        throw new WormDataCollectorError(
          `[artifacts] ${definition.fileName} is outside its file bound`,
        );
      }
      totalBytes += Number(initial.size);
      if (totalBytes > MAX_TOTAL_OBJECT_BYTES) {
        throw new WormDataCollectorError(
          "[artifacts] aggregate byte bound exceeded",
        );
      }
      const handle = await open(
        file,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      ).catch(() => null);
      if (!handle) {
        throw new WormDataCollectorError(
          `[artifacts] ${definition.fileName} could not be opened`,
        );
      }
      handles.push({ handle, initial, file, used: false });
      const opened = await handle.stat({ bigint: true });
      const actualPath = await realpath(file);
      if (!sameSnapshot(initial, opened) || !samePath(file, actualPath)) {
        throw new WormDataCollectorError(
          `[artifacts] ${definition.fileName} changed before hashing`,
        );
      }
      const hashes = await hashFileHandle(handle, Number(opened.size));
      const afterHash = await handle.stat({ bigint: true });
      if (!sameSnapshot(opened, afterHash)) {
        throw new WormDataCollectorError(
          `[artifacts] ${definition.fileName} changed during hashing`,
        );
      }
      const entry = handles.at(-1);
      descriptors.push({
        kind: definition.kind,
        fileName: definition.fileName,
        contentType: definition.contentType,
        bytes: Number(opened.size),
        sha256: hashes.sha256,
        contentMd5Base64: hashes.md5Base64,
        bodyFactory() {
          if (entry.used) {
            throw new WormDataCollectorError(
              `[artifacts] ${definition.fileName} body was reused`,
            );
          }
          entry.used = true;
          return entry.handle.createReadStream({
            autoClose: false,
            start: 0,
            end: Number(opened.size) - 1,
          });
        },
      });
    }
    normalizeArtifactDescriptors(descriptors, target);
    return {
      descriptors,
      async verifyStable() {
        for (const entry of handles) {
          const current = await entry.handle.stat({ bigint: true });
          if (!sameSnapshot(entry.initial, current)) {
            throw new WormDataCollectorError(
              "[artifacts] a source file changed during publication",
            );
          }
        }
      },
      async close() {
        for (const entry of handles.splice(0)) {
          await entry.handle.close().catch(() => {});
        }
      },
    };
  } catch (error) {
    for (const entry of handles) {
      await entry.handle.close().catch(() => {});
    }
    throw error;
  }
}

async function hashFileHandle(handle, size) {
  const sha256 = createHash("sha256");
  const md5 = createHash("md5");
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  let offset = 0;
  while (offset < size) {
    const length = Math.min(buffer.length, size - offset);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    if (bytesRead <= 0) {
      throw new WormDataCollectorError(
        "[artifacts] source file ended during hashing",
      );
    }
    const chunk = buffer.subarray(0, bytesRead);
    sha256.update(chunk);
    md5.update(chunk);
    offset += bytesRead;
  }
  return {
    sha256: sha256.digest("hex"),
    md5Base64: md5.digest("base64"),
  };
}

async function createSecureOutputSink(directory) {
  const root = await requireExactDirectory(directory, "output");
  const entries = await readdir(root);
  if (entries.length !== 0) {
    throw new WormDataCollectorError(
      "[output] readback directory must be empty",
    );
  }
  const expected = new Set(WORM_OBJECTS.map((value) => value.fileName));
  const expectedRecords = new Map();
  const completed = new Set();
  return {
    async beginObject(object) {
      if (
        !expected.has(object.fileName) ||
        completed.has(object.fileName)
      ) {
        throw new WormDataCollectorError(
          "[output] object filename is unexpected or repeated",
        );
      }
      expectedRecords.set(object.fileName, {
        bytes: object.bytes,
        sha256: object.sha256,
      });
      const finalPath = path.join(root, object.fileName);
      const partialPath = `${finalPath}.partial`;
      const handle = await open(
        partialPath,
        fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_WRONLY |
          fsConstants.O_NOFOLLOW,
        0o600,
      ).catch(() => null);
      if (!handle) {
        throw new WormDataCollectorError(
          `[output] ${object.fileName} could not be created`,
        );
      }
      let closed = false;
      let offset = 0;
      const close = async () => {
        if (!closed) {
          closed = true;
          await handle.close();
        }
      };
      return {
        async write(chunk) {
          let written = 0;
          while (written < chunk.length) {
            const result = await handle.write(
              chunk,
              written,
              chunk.length - written,
              offset,
            );
            if (result.bytesWritten <= 0) {
              throw new WormDataCollectorError(
                `[output] ${object.fileName} write stalled`,
              );
            }
            written += result.bytesWritten;
            offset += result.bytesWritten;
          }
        },
        async commit() {
          if (offset !== object.bytes) {
            throw new WormDataCollectorError(
              `[output] ${object.fileName} size drifted`,
            );
          }
          await handle.sync();
          await close();
          await link(partialPath, finalPath);
          await unlink(partialPath);
          completed.add(object.fileName);
        },
        async abort() {
          await close().catch(() => {});
          await unlink(partialPath).catch(() => {});
        },
      };
    },
    async verifyComplete() {
      const actual = await readdir(root);
      if (
        completed.size !== expected.size ||
        canonicalJson([...actual].sort()) !==
          canonicalJson([...expected].sort())
      ) {
        throw new WormDataCollectorError(
          "[output] readback file set is incomplete",
        );
      }
      for (const [fileName, object] of expectedRecords) {
        const file = path.join(root, fileName);
        const initial = await lstat(file, { bigint: true }).catch(
          () => null,
        );
        if (
          !initial ||
          !initial.isFile() ||
          initial.isSymbolicLink() ||
          initial.nlink !== 1n ||
          initial.size !== BigInt(object.bytes)
        ) {
          throw new WormDataCollectorError(
            `[output] ${fileName} final file drifted`,
          );
        }
        const handle = await open(
          file,
          fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
        ).catch(() => null);
        if (!handle) {
          throw new WormDataCollectorError(
            `[output] ${fileName} could not be verified`,
          );
        }
        try {
          const opened = await handle.stat({ bigint: true });
          const digest = await hashFileHandle(handle, object.bytes);
          const after = await handle.stat({ bigint: true });
          if (
            !sameSnapshot(initial, opened) ||
            !sameSnapshot(opened, after) ||
            digest.sha256 !== object.sha256
          ) {
            throw new WormDataCollectorError(
              `[output] ${fileName} final digest drifted`,
            );
          }
        } finally {
          await handle.close();
        }
      }
    },
  };
}

async function requireExactDirectory(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new WormDataCollectorError(`[${label}] directory is required`);
  }
  const resolved = path.resolve(value);
  const stat = await lstat(resolved, { bigint: true }).catch(() => null);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new WormDataCollectorError(
      `[${label}] directory is invalid`,
    );
  }
  const actual = await realpath(resolved);
  if (!samePath(resolved, actual)) {
    throw new WormDataCollectorError(
      `[${label}] directory path is not canonical`,
    );
  }
  return resolved;
}

async function runSelfTest() {
  const policy = await loadPolicy();
  const statementSha256 = "a".repeat(64);
  const normalized = normalizeTarget(
    {
      accountId: "0123456789abcdef0123456789abcdef",
      bucketName: "cinatoken-worm-staging",
      jurisdiction: "default",
      statementSha256,
    },
    policy,
  );
  const target = {
    ...normalized,
    publisherCredentialIdSha256: "b".repeat(64),
    baselineObservedAt: "2026-07-27T00:00:00.000Z",
    baselineReceiptSha256: "c".repeat(64),
    lockCapturedAt: "2026-07-27T00:01:00.000Z",
    lockOperatorCredentialIdSha256: "d".repeat(64),
    lockRevocationObservedAt: "2026-07-27T00:02:00.000Z",
    lockRevocationReceiptSha256: "e".repeat(64),
  };
  const artifacts = WORM_OBJECTS.map((value, index) => ({
    ...value,
    bytes: index + 1,
    sha256:
      value.kind === "provenance-statement"
        ? statementSha256
        : String(index + 1).repeat(64),
    contentMd5Base64: Buffer.alloc(16, index + 1).toString("base64"),
    bodyFactory() {
      return Buffer.alloc(index + 1);
    },
  }));
  const publish = buildDataDryRunReceipt(
    "publish",
    target,
    normalizeArtifactDescriptors(artifacts, target),
  );
  const readback = buildDataDryRunReceipt("readback", target);
  if (
    publish.networkRequests !== false ||
    publish.credentialsRead !== false ||
    publish.writesFiles !== false ||
    readback.networkRequests !== false ||
    readback.credentialsRead !== false ||
    readback.writesFiles !== false
  ) {
    throw new WormDataCollectorError(
      "[self-test] dry-run authority drifted",
    );
  }
  return {
    ok: true,
    schemaVersion: publish.schemaVersion,
    contract: publish.contract,
    cases: 2,
    expectations: 12,
    networkRequests: false,
    credentialsRead: false,
    writesFiles: false,
    downstreamAuthority: publish.downstreamAuthority,
  };
}

function sameSnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function samePath(left, right) {
  const normalize = (value) =>
    process.platform === "win32" ? value.toLowerCase() : value;
  return normalize(path.resolve(left)) === normalize(path.resolve(right));
}

function usage(exitCode, error) {
  if (error) process.stderr.write(`${error}\n`);
  process.stderr.write(
    [
      "Usage:",
      "  node tools/collect_container_runtime_worm_data.mjs --describe",
      "  node tools/collect_container_runtime_worm_data.mjs --self-test",
      "  node tools/collect_container_runtime_worm_data.mjs --phase publish --account-id <id> --baseline-receipt <file> --lock-revocation-receipt <file> --artifact-dir <dir> --commit-sha <sha> [--dry-run]",
      "  node tools/collect_container_runtime_worm_data.mjs --phase readback --account-id <id> --publish-receipt <file> --output-dir <empty-dir> [--dry-run]",
      "  Add --live --confirm-staging-target and the phase-specific confirmation for live collection.",
    ].join("\n") + "\n",
  );
  process.exit(exitCode);
}
