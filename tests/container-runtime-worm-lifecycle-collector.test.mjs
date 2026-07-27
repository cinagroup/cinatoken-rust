import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { link, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LIFECYCLE_OPERATOR_TOKEN_ENV,
  LIFECYCLE_TARGET_TOKEN_ID_ENV,
  LIFECYCLE_VERIFIER_TOKEN_ENV,
  WORM_LIFECYCLE_RECEIPT_CONTRACT,
  buildLifecycleDryRunReceipt,
  describeLifecycleCollector,
  normalizeLockPredecessor,
  normalizeRevokePredecessor,
  readLifecycleCredentials,
  revokeLockOperator,
  verifyLockOperatorRevocation,
} from "../tools/lib/container_runtime_worm_lifecycle.mjs";
import {
  WORM_STAGING_RECEIPT_CONTRACT,
  WORM_STAGING_SCHEMA_VERSION,
  canonicalJson,
  collectAndConfigureLock,
  expectedLockRule,
} from "../tools/lib/container_runtime_worm_staging.mjs";

const accountId = "0123456789abcdef0123456789abcdef";
const targetTokenId = "d".repeat(32);
const operatorTokenId = "e".repeat(32);
const verifierTokenId = "f".repeat(32);
const operatorToken = "lifecycle-operator-token-for-tests";
const verifierToken = "lifecycle-verifier-token-for-tests";
const cliPath = join(
  import.meta.dir,
  "..",
  "tools",
  "collect_container_runtime_worm_lifecycle.mjs",
);

describe("container runtime WORM lifecycle collector", () => {
  test("describe and dry-run remain credential-free and deny downstream authority", () => {
    const description = describeLifecycleCollector();
    const target = lockTarget();
    const revoke = buildLifecycleDryRunReceipt("revoke", target);
    const verifyTarget = {
      ...target,
      lifecycleOperatorCredentialIdSha256: sha256(operatorTokenId),
      revokeReceiptSha256: "b".repeat(64),
      revokeCapturedAt: "2026-07-27T00:02:02.000Z",
    };
    const verify = buildLifecycleDryRunReceipt("verify", verifyTarget);

    expect(description.defaultMode).toBe("dry-run");
    expect(description.contract).toBe(WORM_LIFECYCLE_RECEIPT_CONTRACT);
    expect(description.phases.map((value) => value.phase)).toEqual([
      "revoke",
      "verify",
    ]);
    expect(description.phases.map((value) => value.credentialRole)).toEqual([
      "lifecycle-operator",
      "lifecycle-verifier",
    ]);
    for (const receipt of [revoke, verify]) {
      expect(receipt.networkRequests).toBe(false);
      expect(receipt.credentialsRead).toBe(false);
      expect(receipt.mutationPerformed).toBe(false);
      expect(receipt.downstreamAuthority.lockOperatorRevocationVerified).toBe(
        false,
      );
      expect(receipt.downstreamAuthority.productionCutoverAuthorized).toBe(
        false,
      );
    }
  });

  test("credential loading reads only target ID and the selected role token", () => {
    const accessed = [];
    const env = new Proxy(
      {
        [LIFECYCLE_TARGET_TOKEN_ID_ENV]: targetTokenId,
        [LIFECYCLE_OPERATOR_TOKEN_ENV]: operatorToken,
        [LIFECYCLE_VERIFIER_TOKEN_ENV]: verifierToken,
      },
      {
        get(object, key) {
          accessed.push(key);
          return object[key];
        },
      },
    );

    expect(readLifecycleCredentials("revoke", env)).toEqual({
      apiToken: operatorToken,
      targetTokenId,
    });
    expect(accessed).toEqual([
      LIFECYCLE_TARGET_TOKEN_ID_ENV,
      LIFECYCLE_OPERATOR_TOKEN_ENV,
    ]);
    accessed.length = 0;
    expect(readLifecycleCredentials("verify", env)).toEqual({
      apiToken: verifierToken,
      targetTokenId,
    });
    expect(accessed).toEqual([
      LIFECYCLE_TARGET_TOKEN_ID_ENV,
      LIFECYCLE_VERIFIER_TOKEN_ENV,
    ]);
  });

  test("lock predecessor requires canonical v2 live receipt and exact account binding", () => {
    const lock = lockReceiptFixture();
    const text = canonicalText(lock);
    const target = normalizeLockPredecessor({
      accountId,
      receipt: lock,
      receiptText: text,
    });

    expect(target.targetCredentialIdSha256).toBe(sha256(targetTokenId));
    expect(target.lockReceiptSha256).toBe(sha256(text));
    expect(target.accountIdSha256).toBe(sha256(accountId));

    expect(() =>
      normalizeLockPredecessor({
        accountId,
        receipt: lock,
        receiptText: canonicalJson(lock),
      }),
    ).toThrow("canonical JSON plus one newline");

    const oldContract = structuredClone(lock);
    oldContract.schemaVersion = 1;
    oldContract.contract =
      "cinatoken-container-runtime-worm-staging-phase-receipt-v1";
    expect(() =>
      normalizeLockPredecessor({
        accountId,
        receipt: oldContract,
        receiptText: canonicalText(oldContract),
      }),
    ).toThrow("authority is invalid");

    expect(() =>
      normalizeLockPredecessor({
        accountId: "0".repeat(32),
        receipt: lock,
        receiptText: text,
      }),
    ).toThrow("lock target drifted");

    const overclaim = structuredClone(lock);
    overclaim.downstreamAuthority.lockOperatorRevocationVerified = true;
    expect(() =>
      normalizeLockPredecessor({
        accountId,
        receipt: overclaim,
        receiptText: canonicalText(overclaim),
      }),
    ).toThrow("overclaimed downstream authority");
  });

  test("lifecycle predecessor accepts the real staging lock receipt shape", async () => {
    const stagingTarget = {
      accountId,
      accountIdSha256: sha256(accountId),
      bucketName: "cinatoken-worm-staging",
      jurisdiction: "default",
      statementSha256: "a".repeat(64),
      prefix: `container-runtime/s3/v1/${"a".repeat(64)}/`,
      policy: { minimumRetentionSeconds: 31_536_000 },
    };
    const wanted = expectedLockRule(stagingTarget);
    const lock = await collectAndConfigureLock({
      target: stagingTarget,
      credentials: { apiToken: "staging-lock-token-for-tests" },
      fetchImpl: sequenceFetch([
        tokenVerificationResponse(targetTokenId, "ray-staging-credential"),
        lockResponse([], "ray-staging-before"),
        lockResponse([wanted], "ray-staging-configure"),
        lockResponse([wanted], "ray-staging-after"),
      ]),
      now: sequenceNow([
        "2026-07-27T00:00:30.000Z",
        "2026-07-27T00:01:00.000Z",
        "2026-07-27T00:01:01.000Z",
      ]),
    });
    const target = normalizeLockPredecessor({
      accountId,
      receipt: lock,
      receiptText: canonicalText(lock),
    });
    expect(target.targetCredentialIdSha256).toBe(sha256(targetTokenId));
    expect(target.lockCapturedAt).toBe(lock.capturedAt);
  });

  test("lock predecessor rejects nested facts, operations, limits, and time drift", () => {
    const cases = [
      [
        (value) => {
          delete value.facts.readbackRequestId;
        },
        "lock facts fields drifted",
      ],
      [
        (value) => {
          value.facts.rules[0].condition.maxAgeSeconds -= 1;
        },
        "selected lock rule drifted",
      ],
      [
        (value) => {
          value.providerOperations[2].providerRequestId = "ray-wrong";
        },
        "lock operation drifted",
      ],
      [
        (value) => {
          value.limits.lockRules = 999;
        },
        "lock limits drifted",
      ],
      [
        (value) => {
          value.credential.remainingLifetimeSeconds += 1;
        },
        "lock credential is invalid",
      ],
      [
        (value) => {
          value.capturedAt = "2026-07-27T00:01:01+00:00";
          value.facts.observedAt = value.capturedAt;
        },
        "must be canonical UTC",
      ],
    ];
    for (const [mutate, error] of cases) {
      const lock = lockReceiptFixture();
      mutate(lock);
      expect(() =>
        normalizeLockPredecessor({
          accountId,
          receipt: lock,
          receiptText: canonicalText(lock),
        }),
      ).toThrow(error);
    }
  });

  test("revoke deletes the exact lock token and proves operator-side 404 readback", async () => {
    const target = lockTarget();
    const calls = [];
    const responses = [
      tokenVerificationResponse(operatorTokenId, "ray-operator"),
      deletionResponse(targetTokenId, "ray-delete"),
      absenceResponse("ray-operator-readback"),
    ];
    const receipt = await revokeLockOperator({
      target,
      credentials: {
        apiToken: operatorToken,
        targetTokenId,
      },
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return responses.shift();
      },
      now: sequenceNow([
        "2026-07-27T00:02:00.000Z",
        "2026-07-27T00:02:01.000Z",
        "2026-07-27T00:02:02.000Z",
      ]),
    });

    expect(calls.map((value) => value.init.method)).toEqual([
      "GET",
      "DELETE",
      "GET",
    ]);
    expect(calls[0].url).toEndWith("/tokens/verify");
    expect(calls[1].url).toEndWith(`/tokens/${targetTokenId}`);
    expect(
      calls.every(
        (value) =>
          value.init.headers.Authorization === `Bearer ${operatorToken}`,
      ),
    ).toBe(true);
    expect(receipt.authority.credentialIdSha256).toBe(
      sha256(operatorTokenId),
    );
    expect(receipt.authority.credentialType).toBe(
      "cloudflare-account-api-token-read-edit",
    );
    expect(receipt.facts.deletionResultIdSha256).toBe(
      sha256(targetTokenId),
    );
    expect(receipt.facts.targetAbsentAfterDelete).toBe(true);
    expect(receipt.facts.operatorReadbackHttpStatus).toBe(404);
    expect(receipt.facts.operatorReadbackErrorCodes).toEqual([1000]);
    expect(
      receipt.providerOperations.map((value) => value.operation),
    ).toEqual([
      "lifecycle-operator-preflight",
      "lock-operator-delete",
      "operator-revocation-readback",
    ]);
    expect(receipt.downstreamAuthority.lockOperatorRevocationVerified).toBe(
      false,
    );
    assertSecretsAbsent(receipt, [
      accountId,
      targetTokenId,
      operatorToken,
      operatorTokenId,
    ]);
  });

  test("independent verifier binds the revoke receipt and proves a second 404", async () => {
    const { revoke, target } = await validRevokeReceipt();
    const revokeText = canonicalText(revoke);
    const verifyTarget = normalizeRevokePredecessor({
      accountId,
      receipt: revoke,
      receiptText: revokeText,
    });
    const calls = [];
    const responses = [
      tokenVerificationResponse(verifierTokenId, "ray-verifier"),
      absenceResponse("ray-independent"),
    ];
    const receipt = await verifyLockOperatorRevocation({
      target: verifyTarget,
      credentials: {
        apiToken: verifierToken,
        targetTokenId,
      },
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return responses.shift();
      },
      now: sequenceNow([
        "2026-07-27T00:03:00.000Z",
        "2026-07-27T00:03:01.000Z",
      ]),
    });

    expect(verifyTarget.revokeReceiptSha256).toBe(sha256(revokeText));
    expect(verifyTarget.targetCredentialIdSha256).toBe(
      target.targetCredentialIdSha256,
    );
    expect(calls.map((value) => value.init.method)).toEqual(["GET", "GET"]);
    expect(receipt.authority.credentialIdSha256).toBe(
      sha256(verifierTokenId),
    );
    expect(receipt.authority.credentialType).toBe(
      "cloudflare-account-api-token-read",
    );
    expect(
      receipt.target.lifecycleOperatorCredentialIdSha256,
    ).toBe(sha256(operatorTokenId));
    expect(receipt.facts.targetAbsenceIndependentlyObserved).toBe(true);
    expect(
      receipt.facts.operatorAndVerifierCredentialIdsDistinct,
    ).toBe(true);
    expect(receipt.facts.independentReadbackHttpStatus).toBe(404);
    expect(receipt.downstreamAuthority.lockOperatorRevocationVerified).toBe(
      false,
    );
    assertSecretsAbsent(receipt, [
      accountId,
      targetTokenId,
      operatorTokenId,
      verifierToken,
      verifierTokenId,
    ]);
  });

  test("target digest mismatch fails before any provider request", async () => {
    let calls = 0;
    await expect(
      revokeLockOperator({
        target: lockTarget(),
        credentials: {
          apiToken: operatorToken,
          targetTokenId: "c".repeat(32),
        },
        fetchImpl: async () => {
          calls += 1;
          return tokenVerificationResponse(operatorTokenId);
        },
      }),
    ).rejects.toThrow("does not match the predecessor");
    expect(calls).toBe(0);
  });

  test("operator and verifier identities must be distinct from the target chain", async () => {
    await expect(
      revokeLockOperator({
        target: lockTarget(),
        credentials: {
          apiToken: operatorToken,
          targetTokenId,
        },
        fetchImpl: sequenceFetch([
          tokenVerificationResponse(targetTokenId),
        ]),
        now: () => new Date("2026-07-27T00:02:00.000Z"),
      }),
    ).rejects.toThrow("operator and target identities must differ");

    const { revoke } = await validRevokeReceipt();
    const verifyTarget = normalizeRevokePredecessor({
      accountId,
      receipt: revoke,
      receiptText: canonicalText(revoke),
    });
    for (const duplicateId of [targetTokenId, operatorTokenId]) {
      await expect(
        verifyLockOperatorRevocation({
          target: verifyTarget,
          credentials: {
            apiToken: verifierToken,
            targetTokenId,
          },
          fetchImpl: sequenceFetch([
            tokenVerificationResponse(duplicateId),
          ]),
          now: () => new Date("2026-07-27T00:03:00.000Z"),
        }),
      ).rejects.toThrow("verifier identity is not independent");
    }
  });

  test("lifecycle authority tokens must be active, effective, and short-lived", async () => {
    const cases = [
      {
        override: { status: "disabled" },
        error: "identity, status, or expiry is invalid",
      },
      {
        override: { expires_on: undefined },
        error: "identity, status, or expiry is invalid",
      },
      {
        override: { expires_on: "2026-07-27T01:02:00.001Z" },
        error: "lifetime is outside the bound",
      },
      {
        override: { expires_on: "2026-07-27T00:02:00.999Z" },
        error: "lifetime is outside the bound",
      },
      {
        override: { not_before: "2026-07-27T00:02:00.001Z" },
        error: "token is not active yet",
      },
      {
        override: { unexpected: true },
        error: "verification fields drifted",
      },
    ];
    for (const value of cases) {
      await expect(
        revokeLockOperator({
          target: lockTarget(),
          credentials: {
            apiToken: operatorToken,
            targetTokenId,
          },
          fetchImpl: sequenceFetch([
            tokenVerificationResponse(
              operatorTokenId,
              "ray-preflight",
              value.override,
            ),
          ]),
          now: () => new Date("2026-07-27T00:02:00.000Z"),
        }),
      ).rejects.toThrow(value.error);
    }
  });

  test("delete and readback reject provider ambiguity and reflected input", async () => {
    const target = lockTarget();
    await expect(
      revokeLockOperator({
        target,
        credentials: { apiToken: operatorToken, targetTokenId },
        fetchImpl: sequenceFetch([
          tokenVerificationResponse(operatorTokenId),
          deletionResponse("c".repeat(32)),
        ]),
        now: sequenceNow([
          "2026-07-27T00:02:00.000Z",
          "2026-07-27T00:02:01.000Z",
        ]),
      }),
    ).rejects.toThrow("deleted an unexpected token");

    await expect(
      revokeLockOperator({
        target,
        credentials: { apiToken: operatorToken, targetTokenId },
        fetchImpl: sequenceFetch([
          tokenVerificationResponse(operatorTokenId),
          deletionResponse(targetTokenId),
          jsonResponse(
            200,
            {
              success: true,
              errors: [],
              messages: [],
              result: {},
            },
            "ray-not-absent",
          ),
        ]),
        now: sequenceNow([
          "2026-07-27T00:02:00.000Z",
          "2026-07-27T00:02:01.000Z",
        ]),
      }),
    ).rejects.toThrow("status is not the expected result");

    await expect(
      revokeLockOperator({
        target,
        credentials: { apiToken: operatorToken, targetTokenId },
        fetchImpl: sequenceFetch([
          tokenVerificationResponse(operatorTokenId),
          deletionResponse(targetTokenId),
          absenceResponse("ray-reflected", {
            message: `Token ${targetTokenId} not found`,
          }),
        ]),
        now: sequenceNow([
          "2026-07-27T00:02:00.000Z",
          "2026-07-27T00:02:01.000Z",
        ]),
      }),
    ).rejects.toThrow("reflected sensitive input");

    await expect(
      revokeLockOperator({
        target,
        credentials: { apiToken: operatorToken, targetTokenId },
        fetchImpl: sequenceFetch([
          tokenVerificationResponse(operatorTokenId),
          deletionResponse(targetTokenId),
          absenceResponse("ray-error-drift", {
            documentation_url: "https://example.invalid",
          }),
        ]),
        now: sequenceNow([
          "2026-07-27T00:02:00.000Z",
          "2026-07-27T00:02:01.000Z",
        ]),
      }),
    ).rejects.toThrow("provider error fields drifted");
  });

  test("provider redirects, absent correlation, and unknown envelopes fail closed", async () => {
    const redirected = tokenVerificationResponse(operatorTokenId);
    Object.defineProperty(redirected, "redirected", { value: true });
    await expect(
      revokeLockOperator({
        target: lockTarget(),
        credentials: { apiToken: operatorToken, targetTokenId },
        fetchImpl: sequenceFetch([redirected]),
      }),
    ).rejects.toThrow("redirects are forbidden");

    await expect(
      revokeLockOperator({
        target: lockTarget(),
        credentials: { apiToken: operatorToken, targetTokenId },
        fetchImpl: sequenceFetch([
          tokenVerificationResponse(operatorTokenId, null),
        ]),
      }),
    ).rejects.toThrow("correlation ID is absent");

    await expect(
      revokeLockOperator({
        target: lockTarget(),
        credentials: { apiToken: operatorToken, targetTokenId },
        fetchImpl: sequenceFetch([
          jsonResponse(
            200,
            {
              success: true,
              errors: [],
              messages: [],
              result: {
                id: operatorTokenId,
                status: "active",
                expires_on: "2026-07-27T00:30:00.000Z",
              },
              result_info: {},
            },
            "ray-drift",
          ),
        ]),
      }),
    ).rejects.toThrow("envelope fields drifted");
  });

  test("revoke predecessor rejects chronology and target evidence drift", async () => {
    const { revoke } = await validRevokeReceipt();
    const drifted = [
      [
        (value) => {
          value.facts.deletionResultIdSha256 = "a".repeat(64);
        },
        "revoke facts are invalid",
      ],
      [
        (value) => {
          value.facts.operatorReadbackHttpStatus = 200;
        },
        "revoke facts are invalid",
      ],
      [
        (value) => {
          value.capturedAt = "2026-07-27T00:02:01.000Z";
        },
        "revoke facts are invalid",
      ],
      [
        (value) => {
          value.target.targetCredentialIdSha256 = "a".repeat(64);
        },
        "revoke facts are invalid",
      ],
      [
        (value) => {
          value.providerOperations[1].method = "GET";
        },
        "revoke operation drifted",
      ],
      [
        (value) => {
          value.providerOperations[2].responseBodySha256 =
            "a".repeat(64);
        },
        "revoke operation drifted",
      ],
      [
        (value) => {
          value.limits.requestTimeoutMs = 1;
        },
        "revoke limits drifted",
      ],
      [
        (value) => {
          value.authority.credentialIdSha256 =
            value.target.targetCredentialIdSha256;
        },
        "identities overlap",
      ],
      [
        (value) => {
          value.authority.remainingLifetimeSeconds += 1;
        },
        "lifecycle authority drifted",
      ],
    ];
    for (const [mutate, error] of drifted) {
      const changed = structuredClone(revoke);
      mutate(changed);
      expect(() =>
        normalizeRevokePredecessor({
          accountId,
          receipt: changed,
          receiptText: canonicalText(changed),
        }),
      ).toThrow(error);
    }
  });

  test("independent readback must match the operator-side absence code", async () => {
    const { revoke } = await validRevokeReceipt();
    const verifyTarget = normalizeRevokePredecessor({
      accountId,
      receipt: revoke,
      receiptText: canonicalText(revoke),
    });
    await expect(
      verifyLockOperatorRevocation({
        target: verifyTarget,
        credentials: {
          apiToken: verifierToken,
          targetTokenId,
        },
        fetchImpl: sequenceFetch([
          tokenVerificationResponse(verifierTokenId),
          absenceResponse("ray-independent", {
            code: 1001,
            message: "Different absence classification",
          }),
        ]),
        now: sequenceNow([
          "2026-07-27T00:03:00.000Z",
          "2026-07-27T00:03:01.000Z",
        ]),
      }),
    ).rejects.toThrow("absence error codes drifted");
  });

  test("CLI describe, self-test, and canonical dry-run remain secret-free", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cinatoken-worm-"));
    const lockPath = join(directory, "lock.json");
    try {
      await writeFile(lockPath, canonicalText(lockReceiptFixture()), "utf8");
      const description = runCli([]);
      expect(description.exitCode).toBe(0);
      expect(JSON.parse(description.stdout).defaultMode).toBe("dry-run");

      const selfTest = runCli(["--self-test"]);
      expect(selfTest.exitCode).toBe(0);
      expect(JSON.parse(selfTest.stdout).ok).toBe(true);

      const secret = "must-not-appear-in-cli-output";
      const dryRun = runCli(
        [
          "--phase",
          "revoke",
          "--account-id",
          accountId,
          "--lock-receipt",
          lockPath,
        ],
        {
          [LIFECYCLE_OPERATOR_TOKEN_ENV]: secret,
          [LIFECYCLE_TARGET_TOKEN_ID_ENV]: targetTokenId,
        },
      );
      expect(dryRun.exitCode).toBe(0);
      expect(JSON.parse(dryRun.stdout).credentialsRead).toBe(false);
      expect(dryRun.stdout).not.toContain(secret);
      expect(dryRun.stdout.trim()).toBe(
        canonicalJson(JSON.parse(dryRun.stdout)),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("CLI rejects multiply linked predecessor files before parsing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cinatoken-worm-"));
    const lockPath = join(directory, "lock.json");
    const hardlinkPath = join(directory, "lock-hardlink.json");
    try {
      await writeFile(lockPath, canonicalText(lockReceiptFixture()), "utf8");
      await link(lockPath, hardlinkPath);
      const rejected = runCli([
        "--phase",
        "revoke",
        "--account-id",
        accountId,
        "--lock-receipt",
        hardlinkPath,
      ]);
      expect(rejected.exitCode).toBe(1);
      expect(rejected.stderr).toContain("outside its file bound");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("CLI rejects cross-phase predecessors and incomplete live confirmation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cinatoken-worm-"));
    const lockPath = join(directory, "lock.json");
    try {
      await writeFile(lockPath, canonicalText(lockReceiptFixture()), "utf8");
      const crossPhase = runCli([
        "--phase",
        "verify",
        "--account-id",
        accountId,
        "--lock-receipt",
        lockPath,
      ]);
      expect(crossPhase.exitCode).toBe(2);
      expect(crossPhase.stderr).toContain(
        "verify requires only --revoke-receipt",
      );

      const missing = runCli([
        "--phase",
        "revoke",
        "--account-id",
        accountId,
        "--lock-receipt",
        lockPath,
        "--live",
        "--confirm-staging-target",
      ]);
      expect(missing.exitCode).toBe(1);
      expect(missing.stderr).toContain(
        "requires --confirm-lock-operator-revocation",
      );
      expect(missing.stderr).not.toContain(operatorToken);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function lockTarget() {
  const lock = lockReceiptFixture();
  return normalizeLockPredecessor({
    accountId,
    receipt: lock,
    receiptText: canonicalText(lock),
  });
}

async function validRevokeReceipt() {
  const target = lockTarget();
  const revoke = await revokeLockOperator({
    target,
    credentials: { apiToken: operatorToken, targetTokenId },
    fetchImpl: sequenceFetch([
      tokenVerificationResponse(operatorTokenId),
      deletionResponse(targetTokenId),
      absenceResponse(),
    ]),
    now: sequenceNow([
      "2026-07-27T00:02:00.000Z",
      "2026-07-27T00:02:01.000Z",
      "2026-07-27T00:02:02.000Z",
    ]),
  });
  return { revoke, target };
}

function lockReceiptFixture() {
  const statementSha256 = "a".repeat(64);
  const prefix = `container-runtime/s3/v1/${statementSha256}/`;
  const selectedRuleId = `cinatoken-s3-${statementSha256.slice(0, 24)}`;
  return {
    schemaVersion: WORM_STAGING_SCHEMA_VERSION,
    contract: WORM_STAGING_RECEIPT_CONTRACT,
    source: "cinatoken-container-runtime-worm-staging-collector",
    environment: "staging",
    phase: "lock",
    mode: "live",
    ok: true,
    capturedAt: "2026-07-27T00:01:01.000Z",
    networkRequests: true,
    credentialsRead: true,
    writesFiles: false,
    phaseMutationConfirmed: true,
    mutationPerformed: true,
    target: {
      accountIdSha256: sha256(accountId),
      bucketName: "cinatoken-worm-staging",
      jurisdiction: "default",
      prefix,
      statementSha256,
    },
    credential: {
      role: "lock-operator",
      credentialType: "cloudflare-r2-admin-read-write-api-token",
      credentialIdSha256: sha256(targetTokenId),
      selfVerifiedAt: "2026-07-27T00:00:30.000Z",
      expiresAt: "2026-07-27T00:30:00.000Z",
      remainingLifetimeSeconds: 1_770,
    },
    facts: {
      mechanism: "cloudflare-r2-bucket-lock-api",
      awsS3ObjectLockHeadersUsed: false,
      configuredAt: "2026-07-27T00:01:00.000Z",
      configurationRequestId: "ray-lock-configure",
      observedAt: "2026-07-27T00:01:01.000Z",
      readbackRequestId: "ray-lock-after",
      httpStatus: 200,
      selectedRuleId,
      rules: [
        {
          id: selectedRuleId,
          condition: {
            type: "Age",
            maxAgeSeconds: 31_536_000,
          },
          enabled: true,
          prefix,
        },
      ],
      preconfigurationRequestId: "ray-lock-before",
      preexistingRuleCount: 0,
      unrelatedRulesPreserved: true,
    },
    providerOperations: [
      {
        method: "GET",
        operation: "credential-preflight",
        httpStatus: 200,
        providerRequestId: "ray-lock-credential",
      },
      {
        method: "GET",
        operation: "lock-before",
        httpStatus: 200,
        providerRequestId: "ray-lock-before",
      },
      {
        method: "PUT",
        operation: "lock-configure",
        httpStatus: 200,
        providerRequestId: "ray-lock-configure",
      },
      {
        method: "GET",
        operation: "lock-after",
        httpStatus: 200,
        providerRequestId: "ray-lock-after",
      },
    ],
    limits: {
      requestTimeoutMs: 30_000,
      responseBytes: 1024 * 1024,
      mutableCredentialRemainingSeconds: 3_600,
      listPages: 1_000,
      listItems: 10_000,
      lockRules: 1_000,
    },
    downstreamAuthority: downstreamAuthority(),
  };
}

function tokenVerificationResponse(
  id,
  ray = "ray-preflight",
  overrides = {},
) {
  const result = {
    id,
    status: "active",
    expires_on: "2026-07-27T00:30:00.000Z",
    not_before: "2026-07-27T00:00:00.000Z",
    ...overrides,
  };
  for (const key of Object.keys(result)) {
    if (result[key] === undefined) delete result[key];
  }
  return jsonResponse(
    200,
    {
      success: true,
      errors: [],
      messages: [],
      result,
    },
    ray,
  );
}

function deletionResponse(id, ray = "ray-delete") {
  return jsonResponse(
    200,
    {
      success: true,
      errors: [],
      messages: [],
      result: { id },
    },
    ray,
  );
}

function lockResponse(rules, ray) {
  return jsonResponse(
    200,
    {
      success: true,
      errors: [],
      messages: [],
      result: { rules },
    },
    ray,
  );
}

function absenceResponse(
  ray = "ray-absence",
  error = { code: 1000, message: "Token not found" },
) {
  return jsonResponse(
    404,
    {
      success: false,
      errors: [{ code: 1000, ...error }],
      messages: [],
      result: null,
    },
    ray,
  );
}

function jsonResponse(status, value, ray) {
  const headers = { "content-type": "application/json" };
  if (ray !== null) headers["cf-ray"] = ray;
  return new Response(canonicalJson(value), { status, headers });
}

function sequenceFetch(responses) {
  return async () => {
    const response = responses.shift();
    if (!response) throw new Error("unexpected test request");
    return response;
  };
}

function sequenceNow(values) {
  let index = 0;
  return () => new Date(values[index++]);
}

function canonicalText(value) {
  return `${canonicalJson(value)}\n`;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function downstreamAuthority() {
  return {
    lockOperatorRevocationVerified: false,
    publisherRevocationVerified: false,
    wormRetentionVerified: false,
    s3Complete: false,
    formalP5Evidence: false,
    customerTrafficAuthorized: false,
    productionCutoverAuthorized: false,
  };
}

function assertSecretsAbsent(value, secrets) {
  const serialized = canonicalJson(value);
  for (const secret of secrets) expect(serialized).not.toContain(secret);
}

function runCli(args, extraEnv = {}) {
  const result = Bun.spawnSync({
    cmd: ["node", cliPath, ...args],
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8"),
  };
}
