import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  LOCK_OPERATOR_TOKEN_ENV,
  PUBLISHER_ACCESS_KEY_ENV,
  PUBLISHER_SECRET_KEY_ENV,
  buildDryRunReceipt,
  canonicalJson,
  collectAndConfigureLock,
  collectEmptyBaseline,
  describeCollector,
  expectedLockRule,
  normalizeTarget,
  readPhaseCredentials,
} from "../tools/lib/container_runtime_worm_staging.mjs";

const repoRoot = join(import.meta.dir, "..");
const cliPath = join(
  repoRoot,
  "tools",
  "collect_container_runtime_worm_staging.mjs",
);
const policy = JSON.parse(
  await readFile(
    join(
      repoRoot,
      "config",
      "container-runtime-worm-retention-policy.json",
    ),
    "utf8",
  ),
);
const packageJson = JSON.parse(
  await readFile(join(repoRoot, "package.json"), "utf8"),
);
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
const publisherCredentials = {
  accessKeyId: "publisher-access-key-for-tests",
  secretAccessKey: "publisher-secret-key-for-tests",
  credentialIdSha256:
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
};
const lockCredentials = {
  apiToken: "lock-operator-token-for-tests",
};
const lockProviderTokenId = "d".repeat(32);

describe("container runtime WORM staging collector", () => {
  test("describe and phase dry-runs remain credential-free and deny downstream authority", () => {
    const description = describeCollector();
    const baseline = buildDryRunReceipt("baseline", target);
    const lock = buildDryRunReceipt("lock", target);

    expect(description.defaultMode).toBe("dry-run");
    expect(description.schemaVersion).toBe(2);
    expect(description.contract).toBe(
      "cinatoken-container-runtime-worm-staging-phase-receipt-v2",
    );
    expect(description.writesFiles).toBe(false);
    expect(description.phases.map((value) => value.credentialRole)).toEqual([
      "publisher",
      "lock-operator",
    ]);
    expect(packageJson.dependencies["@aws-sdk/client-s3"]).toBe("3.1095.0");
    expect(packageJson.scripts.check).toContain(
      "check:container-runtime:worm-staging-collector",
    );
    expect(
      packageJson.scripts[
        "check:container-runtime:worm-staging-collector"
      ],
    ).toContain("--self-test");
    for (const receipt of [baseline, lock]) {
      expect(receipt.networkRequests).toBe(false);
      expect(receipt.credentialsRead).toBe(false);
      expect(receipt.mutationPerformed).toBe(false);
      expect(receipt.downstreamAuthority.wormRetentionVerified).toBe(false);
      expect(receipt.downstreamAuthority.productionCutoverAuthorized).toBe(
        false,
      );
    }
  });

  test("credential loading reads only the selected phase environment keys", () => {
    const accessed = [];
    const env = new Proxy(
      {
        [PUBLISHER_ACCESS_KEY_ENV]: publisherCredentials.accessKeyId,
        [PUBLISHER_SECRET_KEY_ENV]:
          publisherCredentials.secretAccessKey,
        [LOCK_OPERATOR_TOKEN_ENV]: lockCredentials.apiToken,
      },
      {
        get(object, key) {
          accessed.push(key);
          return object[key];
        },
      },
    );

    readPhaseCredentials("baseline", env);
    expect(accessed).toEqual([
      PUBLISHER_ACCESS_KEY_ENV,
      PUBLISHER_SECRET_KEY_ENV,
    ]);
    accessed.length = 0;
    readPhaseCredentials("lock", env);
    expect(accessed).toEqual([LOCK_OPERATOR_TOKEN_ENV]);
  });

  test("baseline exhausts object and multipart pagination with the exact prefix", async () => {
    const objectInputs = [];
    const multipartInputs = [];
    const objectPages = [
      s3Page({
        Prefix: target.prefix,
        Contents: [],
        CommonPrefixes: [],
        KeyCount: 0,
        IsTruncated: true,
        NextContinuationToken: "objects-next",
      }, "objects-one"),
      s3Page({
        Prefix: target.prefix,
        Contents: [],
        CommonPrefixes: [],
        KeyCount: 0,
        IsTruncated: false,
      }, "objects-two"),
    ];
    const multipartPages = [
      s3Page({
        Prefix: target.prefix,
        Uploads: [],
        CommonPrefixes: [],
        IsTruncated: true,
        NextKeyMarker: `${target.prefix}next`,
        NextUploadIdMarker: "upload-next",
      }, "multipart-one"),
      s3Page({
        Prefix: target.prefix,
        Uploads: [],
        CommonPrefixes: [],
        IsTruncated: false,
      }, "multipart-two"),
    ];
    const receipt = await collectEmptyBaseline({
      target,
      credentials: publisherCredentials,
      s3: {
        async listObjectsV2(input, signal) {
          expect(signal).toBeInstanceOf(AbortSignal);
          objectInputs.push(input);
          return objectPages.shift();
        },
        async listMultipartUploads(input, signal) {
          expect(signal).toBeInstanceOf(AbortSignal);
          multipartInputs.push(input);
          return multipartPages.shift();
        },
      },
      now: () => new Date("2026-07-27T01:00:00.000Z"),
    });

    expect(receipt.facts).toEqual({
      baselineObservedAt: "2026-07-27T01:00:00.000Z",
      baselinePaginationComplete: true,
      preexistingObjectCount: 0,
      multipartUploadCount: 0,
      objectPages: 2,
      multipartPages: 2,
      providerRequestIdsComplete: true,
    });
    expect(objectInputs.map((value) => value.Prefix)).toEqual([
      target.prefix,
      target.prefix,
    ]);
    expect(objectInputs[1].ContinuationToken).toBe("objects-next");
    expect(objectInputs.every((value) => value.MaxKeys === 1_000)).toBe(
      true,
    );
    expect(multipartInputs[1].KeyMarker).toBe(`${target.prefix}next`);
    expect(multipartInputs[1].UploadIdMarker).toBe("upload-next");
    expect(
      multipartInputs.every((value) => value.MaxUploads === 1_000),
    ).toBe(true);
    expect(canonicalJson(receipt)).not.toContain(
      publisherCredentials.accessKeyId,
    );
    expect(canonicalJson(receipt)).not.toContain(
      publisherCredentials.secretAccessKey,
    );
    expect(canonicalJson(receipt)).not.toContain(target.accountId);
  });

  test("baseline records incomplete provider correlation without inventing request IDs", async () => {
    const receipt = await collectEmptyBaseline({
      target,
      credentials: publisherCredentials,
      s3: emptyS3({ requestId: undefined }),
      now: () => new Date("2026-07-27T01:01:00.000Z"),
    });

    expect(receipt.facts.providerRequestIdsComplete).toBe(false);
    expect(
      receipt.providerOperations.every(
        (operation) => operation.providerRequestId === null,
      ),
    ).toBe(true);
  });

  test("baseline rejects preexisting objects, multipart uploads, and prefix escape", async () => {
    await expect(
      collectEmptyBaseline({
        target,
        credentials: publisherCredentials,
        s3: emptyS3({
          objectContents: [{ Key: `${target.prefix}existing.json` }],
        }),
      }),
    ).rejects.toThrow("prefix is not empty");

    await expect(
      collectEmptyBaseline({
        target,
        credentials: publisherCredentials,
        s3: emptyS3({
          multipartUploads: [
            {
              Key: `${target.prefix}pending.json`,
              UploadId: "pending-upload",
            },
          ],
        }),
      }),
    ).rejects.toThrow("multipart uploads");

    await expect(
      collectEmptyBaseline({
        target,
        credentials: publisherCredentials,
        s3: emptyS3({
          objectContents: [{ Key: "attacker/escaped.json" }],
        }),
      }),
    ).rejects.toThrow("escaped the requested prefix");

    await expect(
      collectEmptyBaseline({
        target,
        credentials: publisherCredentials,
        s3: {
          ...emptyS3(),
          async listObjectsV2(input) {
            return {
              ...s3Page({
                Prefix: input.Prefix,
                Contents: [],
                KeyCount: 0,
                IsTruncated: false,
              }),
              Name: "attacker-bucket",
            };
          },
        },
      }),
    ).rejects.toThrow("bucket or prefix drifted");
  });

  test("baseline rejects repeated or contradictory pagination state", async () => {
    const repeated = [
      s3Page({
        Prefix: target.prefix,
        Contents: [],
        KeyCount: 0,
        IsTruncated: true,
        NextContinuationToken: "repeat",
      }, "repeat-one"),
      s3Page({
        Prefix: target.prefix,
        Contents: [],
        KeyCount: 0,
        IsTruncated: true,
        NextContinuationToken: "repeat",
      }, "repeat-two"),
    ];
    await expect(
      collectEmptyBaseline({
        target,
        credentials: publisherCredentials,
        s3: {
          async listObjectsV2() {
            return repeated.shift();
          },
          async listMultipartUploads() {
            throw new Error("must not reach multipart listing");
          },
        },
      }),
    ).rejects.toThrow("continuation token was absent or repeated");

    await expect(
      collectEmptyBaseline({
        target,
        credentials: publisherCredentials,
        s3: {
          async listObjectsV2() {
            return s3Page({
              Prefix: target.prefix,
              Contents: [],
              KeyCount: 0,
              IsTruncated: false,
              NextContinuationToken: "contradiction",
            });
          },
          async listMultipartUploads() {
            throw new Error("must not reach multipart listing");
          },
        },
      }),
    ).rejects.toThrow("completed object listing");
  });

  test("lock phase preserves unrelated rules and proves PUT plus final GET readback", async () => {
    const existing = {
      id: "existing-audit-rule",
      condition: { type: "Indefinite" },
      enabled: true,
      prefix: "audit/",
    };
    const wanted = expectedLockRule(target);
    const calls = [];
    const responses = [
      tokenVerificationResponse("ray-credential"),
      cloudflareResponse([existing], "ray-before"),
      cloudflareResponse([existing, wanted], "ray-configure"),
      cloudflareResponse([wanted, existing], "ray-after"),
    ];
    const receipt = await collectAndConfigureLock({
      target,
      credentials: lockCredentials,
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return responses.shift();
      },
      now: sequenceNow([
        "2026-07-27T01:59:59.000Z",
        "2026-07-27T02:00:00.000Z",
        "2026-07-27T02:00:01.000Z",
      ]),
    });

    expect(calls.map((call) => call.init.method)).toEqual([
      "GET",
      "GET",
      "PUT",
      "GET",
    ]);
    expect(calls[0].url).toContain("/tokens/verify");
    expect(JSON.parse(calls[2].init.body)).toEqual({
      rules: [existing, wanted],
    });
    expect(receipt.credential.credentialIdSha256).toBe(
      sha256(lockProviderTokenId),
    );
    expect(receipt.credential.credentialIdSha256).not.toBe(
      sha256(lockCredentials.apiToken),
    );
    expect(receipt.credential.remainingLifetimeSeconds).toBe(1_801);
    expect(
      receipt.providerOperations.map((value) => value.operation),
    ).toEqual([
      "credential-preflight",
      "lock-before",
      "lock-configure",
      "lock-after",
    ]);
    expect(receipt.facts.unrelatedRulesPreserved).toBe(true);
    expect(receipt.facts.selectedRuleId).toBe(wanted.id);
    expect(receipt.facts.configurationRequestId).toBe("ray-configure");
    expect(receipt.facts.readbackRequestId).toBe("ray-after");
    expect(receipt.downstreamAuthority.lockOperatorRevocationVerified).toBe(
      false,
    );
    expect(receipt.downstreamAuthority.wormRetentionVerified).toBe(false);
    expect(canonicalJson(receipt)).not.toContain(lockCredentials.apiToken);
    expect(canonicalJson(receipt)).not.toContain(lockProviderTokenId);
    expect(canonicalJson(receipt)).not.toContain(target.accountId);
  });

  test("lock phase refuses ambiguous reruns before mutation", async () => {
    const calls = [];
    const responses = [
      tokenVerificationResponse(),
      cloudflareResponse([expectedLockRule(target)], "ray-before"),
    ];
    await expect(
      collectAndConfigureLock({
        target,
        credentials: lockCredentials,
        fetchImpl: async (_url, init) => {
          calls.push(init.method);
          return responses.shift();
        },
        now: () => new Date("2026-07-27T02:00:00.000Z"),
      }),
    ).rejects.toThrow("selected rule already exists");
    expect(calls).toEqual(["GET", "GET"]);
  });

  test("lock phase rejects redirect, absent correlation, and unknown envelopes", async () => {
    const redirected = cloudflareResponse([], "ray-redirect");
    Object.defineProperty(redirected, "redirected", { value: true });
    await expect(
      collectAndConfigureLock({
        target,
        credentials: lockCredentials,
        fetchImpl: async () => redirected,
      }),
    ).rejects.toThrow("redirects are forbidden");

    await expect(
      collectAndConfigureLock({
        target,
        credentials: lockCredentials,
        fetchImpl: async () =>
          cloudflareResponse([], null),
      }),
    ).rejects.toThrow("correlation ID is absent");

    await expect(
      collectAndConfigureLock({
        target,
        credentials: lockCredentials,
        fetchImpl: async () =>
          jsonResponse(
            {
              success: true,
              errors: [],
              messages: [],
              result: { rules: [] },
              result_info: {},
            },
            "ray-unknown",
          ),
      }),
    ).rejects.toThrow("envelope fields drifted");
  });

  test("lock phase rejects credential reflection and redacts provider exceptions", async () => {
    await expect(
      collectAndConfigureLock({
        target,
        credentials: lockCredentials,
        fetchImpl: async () =>
          jsonResponse(
            {
              success: true,
              errors: [],
              messages: [],
              result: {
                rules: [],
                reflected: lockCredentials.apiToken,
              },
            },
            "ray-reflection",
          ),
      }),
    ).rejects.toThrow("provider reflected the credential");

    let message = "";
    try {
      await collectAndConfigureLock({
        target,
        credentials: lockCredentials,
        fetchImpl: async () => {
          throw new Error(lockCredentials.apiToken);
        },
      });
    } catch (error) {
      message = error.message;
    }
    expect(message).toBe(
      "[credential-preflight] provider request failed",
    );
    expect(message).not.toContain(lockCredentials.apiToken);

    const bodyFailure = {
      status: 200,
      redirected: false,
      url: "",
      headers: new Headers({
        "content-type": "application/json",
        "cf-ray": "ray-body-failure",
      }),
      body: {
        async *[Symbol.asyncIterator]() {
          throw new Error(lockCredentials.apiToken);
        },
      },
    };
    await expect(
      collectAndConfigureLock({
        target,
        credentials: lockCredentials,
        fetchImpl: async () => bodyFailure,
      }),
    ).rejects.toThrow(
      "[credential-preflight] response body read failed",
    );
  });

  test("lock phase rejects unusable or overlong mutable credentials", async () => {
    const cases = [
      {
        result: { status: "disabled" },
        error: "token identity, status, or expiry is invalid",
      },
      {
        result: { status: "expired" },
        error: "token identity, status, or expiry is invalid",
      },
      {
        result: { expires_on: undefined },
        error: "token identity, status, or expiry is invalid",
      },
      {
        result: { expires_on: "2026-07-27T03:00:01.000Z" },
        error: "mutable credential lifetime is outside the bound",
      },
      {
        result: { expires_on: "2026-07-27T03:00:00.001Z" },
        error: "mutable credential lifetime is outside the bound",
      },
      {
        result: { expires_on: "2026-07-27T01:59:59.000Z" },
        error: "mutable credential lifetime is outside the bound",
      },
      {
        result: { expires_on: "2026-07-27T02:00:00.999Z" },
        error: "mutable credential lifetime is outside the bound",
      },
      {
        result: { not_before: "2026-07-27T02:00:01.000Z" },
        error: "token is not active yet",
      },
    ];

    for (const value of cases) {
      const calls = [];
      await expect(
        collectAndConfigureLock({
          target,
          credentials: lockCredentials,
          fetchImpl: async () => {
            calls.push("GET");
            return tokenVerificationResponse(
              "ray-credential",
              value.result,
            );
          },
          now: () => new Date("2026-07-27T02:00:00.000Z"),
        }),
      ).rejects.toThrow(value.error);
      expect(calls).toEqual(["GET"]);
    }
  });

  test("lock phase rejects token identity and verification field drift", async () => {
    const cases = [
      {
        result: { id: "not-a-provider-token-id" },
        error: "token identity, status, or expiry is invalid",
      },
      {
        result: { unexpected: true },
        error: "token verification fields drifted",
      },
    ];

    for (const value of cases) {
      await expect(
        collectAndConfigureLock({
          target,
          credentials: lockCredentials,
          fetchImpl: async () =>
            tokenVerificationResponse(
              "ray-credential",
              value.result,
            ),
          now: () => new Date("2026-07-27T02:00:00.000Z"),
        }),
      ).rejects.toThrow(value.error);
    }
  });

  test("lock phase rejects post-mutation rule drift", async () => {
    const wanted = expectedLockRule(target);
    const drifted = structuredClone(wanted);
    drifted.condition.maxAgeSeconds -= 1;
    const responses = [
      tokenVerificationResponse(),
      cloudflareResponse([], "ray-before"),
      cloudflareResponse([drifted], "ray-configure"),
    ];

    await expect(
      collectAndConfigureLock({
        target,
        credentials: lockCredentials,
        fetchImpl: async () => responses.shift(),
        now: sequenceNow([
          "2026-07-27T02:09:59.000Z",
          "2026-07-27T02:10:00.000Z",
        ]),
      }),
    ).rejects.toThrow("provider lock rule set drifted");
  });

  test("CLI defaults to describe and phase execution defaults to dry-run", () => {
    const secretSentinel = "do-not-reflect-this-test-secret-value";
    const description = runCli([], {
      [PUBLISHER_ACCESS_KEY_ENV]: secretSentinel,
      [PUBLISHER_SECRET_KEY_ENV]: secretSentinel,
      [LOCK_OPERATOR_TOKEN_ENV]: secretSentinel,
    });
    expect(description.exitCode).toBe(0);
    expect(description.stdout).not.toContain(secretSentinel);
    expect(JSON.parse(description.stdout).defaultMode).toBe("dry-run");

    const dryRun = runCli(phaseArgs("lock"), {
      [LOCK_OPERATOR_TOKEN_ENV]: secretSentinel,
    });
    expect(dryRun.exitCode).toBe(0);
    expect(dryRun.stdout.trim()).toBe(
      canonicalJson(JSON.parse(dryRun.stdout)),
    );
    expect(JSON.parse(dryRun.stdout).credentialsRead).toBe(false);
    expect(dryRun.stdout).not.toContain(secretSentinel);
  });

  test("CLI rejects shell-like identity input and live execution without exact confirmation", () => {
    const invalidArgs = phaseArgs("baseline");
    invalidArgs[invalidArgs.indexOf("--bucket") + 1] =
      "cinatoken;whoami";
    const invalid = runCli(invalidArgs);
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr).toContain("bucket name is invalid");

    const missingConfirmation = runCli([
      ...phaseArgs("lock"),
      "--live",
      "--confirm-staging-target",
    ], {
      [LOCK_OPERATOR_TOKEN_ENV]: lockCredentials.apiToken,
    });
    expect(missingConfirmation.exitCode).toBe(1);
    expect(missingConfirmation.stderr).toContain(
      "requires --confirm-lock-mutation",
    );
    expect(missingConfirmation.stderr).not.toContain(
      lockCredentials.apiToken,
    );

    const accidentalArgument = "accidental-sensitive-argv-value";
    const unknown = runCli([`--${accidentalArgument}`]);
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stderr).toContain("unknown option");
    expect(unknown.stderr).not.toContain(accidentalArgument);

    const dryRunConfirmation = runCli([
      ...phaseArgs("lock"),
      "--confirm-staging-target",
    ]);
    expect(dryRunConfirmation.exitCode).toBe(2);
    expect(dryRunConfirmation.stderr).toContain(
      "live confirmation flags require --live",
    );
  });

  test("target validation pins account, bucket, jurisdiction, and statement digest", () => {
    expect(() =>
      normalizeTarget(
        {
          accountId: "0123456789abcdef0123456789abcdef",
          bucketName: "valid-bucket",
          jurisdiction: "mars",
          statementSha256: "a".repeat(64),
        },
        policy,
      ),
    ).toThrow("jurisdiction is unsupported");
    expect(() =>
      normalizeTarget(
        {
          accountId: "not-an-account",
          bucketName: "valid-bucket",
          jurisdiction: "default",
          statementSha256: "a".repeat(64),
        },
        policy,
      ),
    ).toThrow("account ID is invalid");
    expect(() =>
      normalizeTarget(
        {
          accountId: "0123456789abcdef0123456789abcdef",
          bucketName: "valid-bucket",
          jurisdiction: "default",
          statementSha256: "../attacker",
        },
        policy,
      ),
    ).toThrow("statement SHA-256 is invalid");
  });
});

function emptyS3(options = {}) {
  const requestId =
    "requestId" in options ? options.requestId : "request-id";
  return {
    async listObjectsV2(input) {
      const contents = options.objectContents || [];
      return s3Page({
        Prefix: input.Prefix,
        Contents: contents,
        CommonPrefixes: [],
        KeyCount: contents.length,
        IsTruncated: false,
      }, requestId);
    },
    async listMultipartUploads(input) {
      return s3Page({
        Prefix: input.Prefix,
        Uploads: options.multipartUploads || [],
        CommonPrefixes: [],
        IsTruncated: false,
      }, requestId);
    },
  };
}

function s3Page(value, requestId) {
  if (arguments.length === 1) requestId = "request-id";
  const multipart =
    "Uploads" in value ||
    "NextKeyMarker" in value ||
    "NextUploadIdMarker" in value;
  return {
    $metadata: {
      httpStatusCode: 200,
      ...(requestId === undefined ? {} : { requestId }),
    },
    ...(multipart
      ? { Bucket: target.bucketName, MaxUploads: 1_000 }
      : { Name: target.bucketName, MaxKeys: 1_000 }),
    ...value,
  };
}

function cloudflareResponse(rules, ray) {
  return jsonResponse(
    {
      success: true,
      errors: [],
      messages: [],
      result: { rules },
    },
    ray,
  );
}

function tokenVerificationResponse(ray = "ray-credential", overrides = {}) {
  const result = {
    id: lockProviderTokenId,
    status: "active",
    expires_on: "2026-07-27T02:30:00.000Z",
    not_before: "2026-07-27T01:00:00.000Z",
    ...overrides,
  };
  for (const key of Object.keys(result)) {
    if (result[key] === undefined) delete result[key];
  }
  return jsonResponse(
    {
      success: true,
      errors: [],
      messages: [],
      result,
    },
    ray,
  );
}

function jsonResponse(value, ray) {
  const headers = { "content-type": "application/json" };
  if (ray !== null) headers["cf-ray"] = ray;
  return new Response(canonicalJson(value), {
    status: 200,
    headers,
  });
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sequenceNow(values) {
  let index = 0;
  return () => new Date(values[index++]);
}

function phaseArgs(phase) {
  return [
    "--phase",
    phase,
    "--account-id",
    target.accountId,
    "--bucket",
    target.bucketName,
    "--jurisdiction",
    target.jurisdiction,
    "--statement-sha256",
    target.statementSha256,
  ];
}

function runCli(args, extraEnv = {}) {
  const result = Bun.spawnSync({
    cmd: ["node", cliPath, ...args],
    cwd: repoRoot,
    env: {
      ...process.env,
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8"),
  };
}
