#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  LOCK_OPERATOR_TOKEN_ENV,
  PUBLISHER_ACCESS_KEY_ENV,
  PUBLISHER_SECRET_KEY_ENV,
  WORM_STAGING_RECEIPT_CONTRACT,
  WORM_STAGING_SCHEMA_VERSION,
  WormStagingCollectorError,
  buildDryRunReceipt,
  canonicalJson,
  collectAndConfigureLock,
  collectEmptyBaseline,
  describeCollector,
  normalizeTarget,
  normalizeWormPolicy,
  r2S3Endpoint,
  readPhaseCredentials,
} from "./lib/container_runtime_worm_staging.mjs";

const policyUrl = new URL(
  "../config/container-runtime-worm-retention-policy.json",
  import.meta.url,
);

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.mode === "describe") {
      process.stdout.write(`${canonicalJson(describeCollector())}\n`);
      return;
    }
    if (args.mode === "self-test") {
      process.stdout.write(`${canonicalJson(await runSelfTest())}\n`);
      return;
    }
    const policy = await loadPolicy();
    const target = normalizeTarget(
      {
        accountId: args.values.get("account-id"),
        bucketName: args.values.get("bucket"),
        jurisdiction: args.values.get("jurisdiction"),
        statementSha256: args.values.get("statement-sha256"),
      },
      policy,
    );
    if (!args.live) {
      process.stdout.write(
        `${canonicalJson(buildDryRunReceipt(args.phase, target))}\n`,
      );
      return;
    }
    requireLiveConfirmation(args);
    const credentials = readPhaseCredentials(args.phase, process.env);
    let receipt;
    if (args.phase === "baseline") {
      const client = new S3Client({
        region: "auto",
        endpoint: r2S3Endpoint(target),
        forcePathStyle: true,
        maxAttempts: 1,
        credentials: {
          accessKeyId: credentials.accessKeyId,
          secretAccessKey: credentials.secretAccessKey,
        },
      });
      try {
        receipt = await collectEmptyBaseline({
          target,
          credentials,
          s3: awsS3Adapter(client),
        });
      } finally {
        client.destroy();
      }
    } else {
      receipt = await collectAndConfigureLock({
        target,
        credentials,
      });
    }
    process.stdout.write(`${canonicalJson(receipt)}\n`);
  } catch (error) {
    const message =
      error instanceof WormStagingCollectorError
        ? error.message
        : process.argv.includes("--self-test") && error instanceof Error
          ? `[self-test] ${error.message}`
        : "[collector] operation failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
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
    "bucket",
    "jurisdiction",
    "phase",
    "statement-sha256",
  ]);
  const knownFlags = new Set([
    "confirm-lock-mutation",
    "confirm-readonly-baseline",
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
    if (!knownValues.has(key)) {
      usage(2, "[input] unknown option");
    }
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
      "confirm-lock-mutation",
      "confirm-readonly-baseline",
      "confirm-staging-target",
    ].some((flag) => flags.has(flag))
  ) {
    usage(2, "[input] live confirmation flags require --live");
  }
  for (const key of [
    "account-id",
    "bucket",
    "jurisdiction",
    "phase",
    "statement-sha256",
  ]) {
    if (!values.has(key)) usage(2, `[input] --${key} is required`);
  }
  const phase = values.get("phase");
  if (phase !== "baseline" && phase !== "lock") {
    usage(2, "[input] --phase must be baseline or lock");
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
    throw new WormStagingCollectorError(
      "[confirmation] live collection requires --confirm-staging-target",
    );
  }
  if (
    args.phase === "baseline" &&
    !args.flags.has("confirm-readonly-baseline")
  ) {
    throw new WormStagingCollectorError(
      "[confirmation] baseline requires --confirm-readonly-baseline",
    );
  }
  if (
    args.phase === "lock" &&
    !args.flags.has("confirm-lock-mutation")
  ) {
    throw new WormStagingCollectorError(
      "[confirmation] lock phase requires --confirm-lock-mutation",
    );
  }
  if (
    args.phase === "baseline" &&
    args.flags.has("confirm-lock-mutation")
  ) {
    throw new WormStagingCollectorError(
      "[confirmation] lock confirmation is invalid for baseline",
    );
  }
  if (
    args.phase === "lock" &&
    args.flags.has("confirm-readonly-baseline")
  ) {
    throw new WormStagingCollectorError(
      "[confirmation] baseline confirmation is invalid for lock phase",
    );
  }
}

function awsS3Adapter(client) {
  return {
    listObjectsV2(input, abortSignal) {
      return client.send(new ListObjectsV2Command(input), { abortSignal });
    },
    listMultipartUploads(input, abortSignal) {
      return client.send(new ListMultipartUploadsCommand(input), {
        abortSignal,
      });
    },
  };
}

async function loadPolicy() {
  let value;
  try {
    value = JSON.parse(await readFile(policyUrl, "utf8"));
  } catch {
    throw new WormStagingCollectorError(
      "[policy] unable to read the pinned WORM protocol policy",
    );
  }
  return normalizeWormPolicy(value);
}

async function runSelfTest() {
  const policy = await loadPolicy();
  const target = normalizeTarget(
    {
      accountId: "0123456789abcdef0123456789abcdef",
      bucketName: "cinatoken-worm-staging",
      jurisdiction: "default",
      statementSha256:
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    policy,
  );
  const publisher = {
    accessKeyId: "self-test-publisher-access-key",
    secretAccessKey: "self-test-publisher-secret-key",
    credentialIdSha256:
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  };
  const baseline = await collectEmptyBaseline({
    target,
    credentials: publisher,
    s3: {
      async listObjectsV2(input) {
        return {
          $metadata: { httpStatusCode: 200, requestId: "self-test-object" },
          Name: target.bucketName,
          Prefix: input.Prefix,
          MaxKeys: input.MaxKeys,
          Contents: [],
          CommonPrefixes: [],
          KeyCount: 0,
          IsTruncated: false,
        };
      },
      async listMultipartUploads(input) {
        return {
          $metadata: {
            httpStatusCode: 200,
            requestId: "self-test-multipart",
          },
          Bucket: target.bucketName,
          Prefix: input.Prefix,
          MaxUploads: input.MaxUploads,
          Uploads: [],
          CommonPrefixes: [],
          IsTruncated: false,
        };
      },
    },
    now: () => new Date("2026-07-27T00:00:00.000Z"),
  });
  const lockToken = "self-test-lock-operator-token";
  const lock = await collectAndConfigureLock({
    target,
    credentials: {
      apiToken: lockToken,
      credentialIdSha256:
        "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    },
    fetchImpl: selfTestLockFetch(target, lockToken),
    now: sequenceNow([
      "2026-07-27T00:01:00.000Z",
      "2026-07-27T00:01:01.000Z",
    ]),
  });
  const dryRun = buildDryRunReceipt("lock", target);
  if (
    baseline.downstreamAuthority.wormRetentionVerified !== false ||
    lock.downstreamAuthority.s3Complete !== false ||
    dryRun.networkRequests !== false ||
    canonicalJson([baseline, lock, dryRun]).includes(lockToken)
  ) {
    throw new WormStagingCollectorError("[self-test] invariant failed");
  }
  return {
    ok: true,
    schemaVersion: WORM_STAGING_SCHEMA_VERSION,
    contract: WORM_STAGING_RECEIPT_CONTRACT,
    cases: 3,
    expectations: 12,
    networkRequests: false,
    credentialsRead: false,
    writesFiles: false,
    downstreamAuthority: baseline.downstreamAuthority,
  };
}

function selfTestLockFetch(target, token) {
  const expectedRule = {
    id: `cinatoken-s3-${target.statementSha256.slice(0, 24)}`,
    condition: {
      type: "Age",
      maxAgeSeconds: target.policy.minimumRetentionSeconds,
    },
    enabled: true,
    prefix: target.prefix,
  };
  const responses = [
    lockResponse([], "self-test-before"),
    lockResponse([expectedRule], "self-test-configure"),
    lockResponse([expectedRule], "self-test-after"),
  ];
  return async (_url, init) => {
    if (init.headers.Authorization !== `Bearer ${token}`) {
      throw new Error("unexpected authorization");
    }
    const response = responses.shift();
    if (!response) throw new Error("unexpected request");
    return response;
  };
}

function lockResponse(rules, ray) {
  const body = canonicalJson({
    success: true,
    errors: [],
    messages: [],
    result: { rules },
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cf-ray": ray,
    },
  });
}

function sequenceNow(values) {
  let index = 0;
  return () => new Date(values[index++]);
}

function usage(exitCode, error) {
  if (error) process.stderr.write(`${error}\n`);
  process.stderr.write(
    [
      "Usage:",
      "  node tools/collect_container_runtime_worm_staging.mjs",
      "  node tools/collect_container_runtime_worm_staging.mjs --describe",
      "  node tools/collect_container_runtime_worm_staging.mjs --self-test",
      "  node tools/collect_container_runtime_worm_staging.mjs --phase <baseline|lock> --account-id <32-hex> --bucket <name> --jurisdiction <default|eu|fedramp> --statement-sha256 <sha256> [--dry-run]",
      "  node tools/collect_container_runtime_worm_staging.mjs --phase baseline ... --live --confirm-staging-target --confirm-readonly-baseline",
      "  node tools/collect_container_runtime_worm_staging.mjs --phase lock ... --live --confirm-staging-target --confirm-lock-mutation",
      "",
      "No phase is live unless --live is present. Output is one canonical, redacted JSON receipt and no files are written.",
      `Baseline reads only ${PUBLISHER_ACCESS_KEY_ENV} and ${PUBLISHER_SECRET_KEY_ENV}.`,
      `Lock reads only ${LOCK_OPERATOR_TOKEN_ENV}.`,
    ].join("\n"),
  );
  process.exit(exitCode);
}
