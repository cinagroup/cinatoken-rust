import { createHash } from "node:crypto";
import {
  link,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, test } from "bun:test";

import {
  LOCK_VERIFIER_TOKEN_ENV,
  WORM_ENFORCEMENT_RECEIPT_CONTRACT,
  WORM_ENFORCEMENT_SCHEMA_VERSION,
  buildEnforcementDryRunReceipt,
  collectEnforcementProbes,
  collectFinalLockReadback,
  collectPostProbeReadback,
  describeEnforcementCollector,
  normalizePostReadbackReceipt,
  normalizeProbeReceipt,
  normalizeEmergencyRevokeReceipt,
  normalizeEmergencyVerifyReceipt,
  normalizePublisherRevokeReceipt,
  normalizePublisherVerifyReceipt,
  readEnforcementCredentials,
  revokePublisherEmergency,
  revokePublisher,
  verifyEmergencyRevocation,
  verifyPublisherRevocation,
} from "../tools/lib/container_runtime_worm_enforcement.mjs";
import {
  readCanonicalReceiptFile,
} from "../tools/lib/container_runtime_worm_receipt_file.mjs";
import {
  canonicalJson,
} from "../tools/lib/container_runtime_worm_staging.mjs";
import {
  createRawS3ProbeAdapter,
} from "../tools/collect_container_runtime_worm_enforcement.mjs";

const accountId = "0123456789abcdef0123456789abcdef";
const publisherTokenId = "a".repeat(32);
const lockOperatorId = "b".repeat(32);
const objectVerifierId = "c".repeat(32);
const lifecycleOperatorId = "d".repeat(32);
const lifecycleVerifierId = "e".repeat(32);
const lockVerifierId = "f".repeat(32);
const cliPath = join(
  import.meta.dir,
  "..",
  "tools",
  "collect_container_runtime_worm_enforcement.mjs",
);

describe("container runtime WORM enforcement collector", () => {
  test("describe and dry-run are credential-free and deny authority", () => {
    const target = baseTarget();
    const description = describeEnforcementCollector();
    const dryRun = buildEnforcementDryRunReceipt("probe", target);
    expect(description.phases).toHaveLength(7);
    expect(description.defaultMode).toBe("dry-run");
    expect(description.phases[0].requests).toEqual([
      "PutObject If-None-Match:* publisher-preflight",
      "PutObject unconditional-overwrite",
      "DeleteObject unconditional",
    ]);
    expect(dryRun.networkRequests).toBe(false);
    expect(dryRun.credentialsRead).toBe(false);
    expect(dryRun.writesFiles).toBe(false);
    expect(Object.values(dryRun.downstreamAuthority).every(
      (value) => value === false,
    )).toBe(true);
  });

  test("credential loading reads only the selected role", () => {
    const allowed = {
      probe: new Set([
        "CINATOKEN_WORM_PUBLISHER_R2_ACCESS_KEY_ID",
        "CINATOKEN_WORM_PUBLISHER_R2_SECRET_ACCESS_KEY",
      ]),
      revoke: new Set([
        "CINATOKEN_WORM_LIFECYCLE_OPERATOR_API_TOKEN",
        "CINATOKEN_WORM_LIFECYCLE_TARGET_TOKEN_ID",
      ]),
      "verify-revocation": new Set([
        "CINATOKEN_WORM_LIFECYCLE_VERIFIER_API_TOKEN",
        "CINATOKEN_WORM_LIFECYCLE_TARGET_TOKEN_ID",
      ]),
      "object-readback": new Set([
        "CINATOKEN_WORM_OBJECT_VERIFIER_R2_ACCESS_KEY_ID",
        "CINATOKEN_WORM_OBJECT_VERIFIER_R2_SECRET_ACCESS_KEY",
      ]),
      "lock-readback": new Set([LOCK_VERIFIER_TOKEN_ENV]),
      "emergency-revoke": new Set([
        "CINATOKEN_WORM_LIFECYCLE_OPERATOR_API_TOKEN",
        "CINATOKEN_WORM_LIFECYCLE_TARGET_TOKEN_ID",
      ]),
      "emergency-verify": new Set([
        "CINATOKEN_WORM_LIFECYCLE_VERIFIER_API_TOKEN",
        "CINATOKEN_WORM_LIFECYCLE_TARGET_TOKEN_ID",
      ]),
    };
    for (const [phase, keys] of Object.entries(allowed)) {
      const reads = [];
      const env = new Proxy(
        {
          CINATOKEN_WORM_PUBLISHER_R2_ACCESS_KEY_ID:
            publisherTokenId,
          CINATOKEN_WORM_PUBLISHER_R2_SECRET_ACCESS_KEY:
            "publisher-secret-value",
          CINATOKEN_WORM_LIFECYCLE_OPERATOR_API_TOKEN:
            "lifecycle-operator-token",
          CINATOKEN_WORM_LIFECYCLE_VERIFIER_API_TOKEN:
            "lifecycle-verifier-token",
          CINATOKEN_WORM_LIFECYCLE_TARGET_TOKEN_ID:
            publisherTokenId,
          CINATOKEN_WORM_OBJECT_VERIFIER_R2_ACCESS_KEY_ID:
            objectVerifierId,
          CINATOKEN_WORM_OBJECT_VERIFIER_R2_SECRET_ACCESS_KEY:
            "object-verifier-secret",
          [LOCK_VERIFIER_TOKEN_ENV]: "lock-verifier-api-token",
        },
        {
          get(target, key) {
            reads.push(key);
            if (!keys.has(key)) {
              throw new Error(`unexpected credential read: ${key}`);
            }
            return target[key];
          },
        },
      );
      readEnforcementCredentials(phase, env);
      expect(new Set(reads)).toEqual(keys);
    }
  });

  test("probe performs one conditional preflight and two unconditional probes", async () => {
    const target = baseTarget();
    const inputs = [];
    const adapter = probeAdapter({ inputs });
    const receipt = await collectEnforcementProbes({
      target,
      credentials: publisherCredentials(target),
      probe: adapter,
      now: probeTimes(),
    });

    expect(inputs).toHaveLength(3);
    expect(inputs[0].ifNoneMatch).toBe("*");
    expect(inputs[1].ifNoneMatch).toBeUndefined();
    expect(inputs[2].body).toBeUndefined();
    expect(receipt.facts.publisherPreflight.httpStatus).toBe(412);
    expect(receipt.facts.overwrite.httpStatus).toBe(403);
    expect(receipt.facts.delete.httpStatus).toBe(403);
    expect(receipt.facts.overwrite.completedAt).toBe(
      "2026-07-27T00:05:03.000Z",
    );
    expect(receipt.providerOperations).toHaveLength(3);
    expect(receipt.downstreamAuthority.wormRetentionVerified).toBe(false);
    expect(canonicalJson(receipt)).not.toContain(
      publisherCredentials(target).secretAccessKey,
    );
  });

  test("probe rejects auth, conditional, response, and chronology ambiguity", async () => {
    const cases = [
      {
        responses: [
          probeResponse(403, "AccessDenied", "preflight"),
        ],
        error: /preflight|put-object-create-only/i,
      },
      {
        responses: [
          probeResponse(412, "PreconditionFailed", "preflight"),
          probeResponse(401, "InvalidAccessKeyId", "overwrite"),
        ],
        error: /put-object/i,
      },
      {
        responses: [
          probeResponse(412, "PreconditionFailed", "preflight"),
          probeResponse(403, "SignatureDoesNotMatch", "overwrite"),
        ],
        error: /put-object/i,
      },
      {
        responses: [
          probeResponse(412, "PreconditionFailed", "preflight"),
          probeResponse(412, "PreconditionFailed", "overwrite"),
        ],
        error: /put-object/i,
      },
      {
        responses: [
          probeResponse(412, "PreconditionFailed", "preflight"),
          probeResponse(403, "AccessDenied", "overwrite", {
            responseBytes: 0,
          }),
        ],
        error: /put-object/i,
      },
      {
        responses: [
          probeResponse(412, "PreconditionFailed", "preflight"),
          probeResponse(403, "AccessDenied", "overwrite", {
            responseContentType: "text/html",
          }),
        ],
        error: /put-object/i,
      },
      {
        responses: [
          probeResponse(412, "PreconditionFailed", "same"),
          probeResponse(403, "AccessDenied", "same"),
          probeResponse(403, "AccessDenied", "delete"),
        ],
        error: /request IDs/i,
      },
    ];
    for (const value of cases) {
      await expect(
        collectEnforcementProbes({
          target: baseTarget(),
          credentials: publisherCredentials(baseTarget()),
          probe: sequenceProbe(value.responses),
          now: probeTimes(),
        }),
      ).rejects.toThrow(value.error);
    }

    await expect(
      collectEnforcementProbes({
        target: baseTarget(),
        credentials: publisherCredentials(baseTarget()),
        probe: probeAdapter(),
        now: sequenceNow([
          "2026-07-27T00:05:00.000Z",
          "2026-07-27T00:05:00.000Z",
        ]),
      }),
    ).rejects.toThrow(/preflight|put-object-create-only/i);
  });

  test("publisher lifecycle binds B4 access key and reuses reviewed lifecycle roles", async () => {
    const target = await validProbeTarget();
    const lifecycle = lifecycleAdapter();
    const revoke = await revokePublisher({
      target,
      credentials: lifecycleCredentials("operator"),
      lifecycle,
      now: sequenceNow([
        "2026-07-27T00:06:00.000Z",
        "2026-07-27T00:06:01.000Z",
        "2026-07-27T00:06:02.000Z",
      ]),
    });
    const revokeTarget = normalizePublisherRevokeReceipt({
      target,
      receipt: revoke,
      receiptText: canonicalText(revoke),
    });
    const verification = await verifyPublisherRevocation({
      target: revokeTarget,
      credentials: lifecycleCredentials("verifier"),
      lifecycle,
      now: sequenceNow([
        "2026-07-27T00:07:00.000Z",
        "2026-07-27T00:07:01.000Z",
      ]),
    });
    const verified = normalizePublisherVerifyReceipt({
      target: revokeTarget,
      receipt: verification,
      receiptText: canonicalText(verification),
    });

    expect(revoke.facts.deletionResultIdSha256).toBe(
      target.publisherCredentialIdSha256,
    );
    expect(revoke.facts.operatorReadbackHttpStatus).toBe(404);
    expect(
      verification.facts.independentReadbackErrorCodes,
    ).toEqual([1000]);
    expect(verified.verifyCapturedAt).toBe(
      "2026-07-27T00:07:01.000Z",
    );
    expect(
      new Set([
        target.publisherCredentialIdSha256,
        revoke.authority.credentialIdSha256,
        verification.authority.credentialIdSha256,
      ]).size,
    ).toBe(3);
  });

  test("publisher lifecycle rejects identity, target, absence, and equal-time drift", async () => {
    const target = await validProbeTarget();
    await expect(
      revokePublisher({
        target,
        credentials: {
          apiToken: "lifecycle-operator-token",
          targetTokenId: "9".repeat(32),
        },
        lifecycle: lifecycleAdapter(),
      }),
    ).rejects.toThrow(/does not match/i);

    await expect(
      revokePublisher({
        target,
        credentials: lifecycleCredentials("operator"),
        lifecycle: lifecycleAdapter({
          operatorId: publisherTokenId,
        }),
        now: sequenceNow([
          "2026-07-27T00:06:00.000Z",
        ]),
      }),
    ).rejects.toThrow(/identity drifted/i);

    const revokeTarget = await validRevokeTarget();
    await expect(
      verifyPublisherRevocation({
        target: revokeTarget,
        credentials: lifecycleCredentials("verifier"),
        lifecycle: lifecycleAdapter({
          independentErrorCodes: [1001],
        }),
        now: sequenceNow([
          "2026-07-27T00:07:00.000Z",
          "2026-07-27T00:07:01.000Z",
        ]),
      }),
    ).rejects.toThrow(/error codes drifted/i);

    await expect(
      verifyPublisherRevocation({
        target: revokeTarget,
        credentials: lifecycleCredentials("verifier"),
        lifecycle: lifecycleAdapter(),
        now: sequenceNow([
          revokeTarget.revokeCapturedAt,
          "2026-07-27T00:07:01.000Z",
        ]),
      }),
    ).rejects.toThrow(/chronology/i);
  });

  test("emergency revocation works without a positive probe receipt and cannot be promoted", async () => {
    const target = baseTarget();
    const incidentSha256 = "6".repeat(64);
    const revoke = await revokePublisherEmergency({
      target,
      credentials: lifecycleCredentials("operator"),
      incidentSha256,
      lifecycle: lifecycleAdapter(),
      now: sequenceNow([
        "2026-07-27T00:10:00.000Z",
        "2026-07-27T00:10:01.000Z",
        "2026-07-27T00:10:02.000Z",
      ]),
    });
    const revokeTarget = normalizeEmergencyRevokeReceipt({
      target,
      receipt: revoke,
      receiptText: canonicalText(revoke),
    });
    const verification = await verifyEmergencyRevocation({
      target: revokeTarget,
      credentials: lifecycleCredentials("verifier"),
      lifecycle: lifecycleAdapter(),
      now: sequenceNow([
        "2026-07-27T00:11:00.000Z",
        "2026-07-27T00:11:01.000Z",
      ]),
    });
    const decision = normalizeEmergencyVerifyReceipt({
      target: revokeTarget,
      receipt: verification,
      receiptText: canonicalText(verification),
    });

    expect(revoke.facts.emergency).toBe(true);
    expect(revoke.facts.positiveEvidenceEligible).toBe(false);
    expect(verification.facts.incidentSha256).toBe(incidentSha256);
    expect(
      decision.emergencyRevocationIndependentlyVerified,
    ).toBe(true);
    expect(decision.positiveEvidenceEligible).toBe(false);
    expect(
      Object.values(verification.downstreamAuthority).every(
        (value) => value === false,
      ),
    ).toBe(true);
    expect(() =>
      normalizePublisherRevokeReceipt({
        target,
        receipt: revoke,
        receiptText: canonicalText(revoke),
      }),
    ).toThrow(/revoke receipt|authority/i);
  });

  test("emergency revocation rejects invalid incident and dry-run stays non-authoritative", async () => {
    const target = baseTarget();
    await expect(
      revokePublisherEmergency({
        target,
        credentials: lifecycleCredentials("operator"),
        incidentSha256: "not-a-digest",
        lifecycle: lifecycleAdapter(),
      }),
    ).rejects.toThrow(/incident digest/i);

    const validProbe = await validProbeTarget();
    const dryRun = buildEnforcementDryRunReceipt(
      "emergency-revoke",
      {
        ...validProbe,
        incidentSha256: "7".repeat(64),
      },
    );
    expect(dryRun.incidentSha256).toBe("7".repeat(64));
    expect(dryRun.positiveEvidenceEligible).toBe(false);
    expect(dryRun.downstreamAuthority.wormRetentionVerified).toBe(
      false,
    );
  });

  test("post-probe readback uses exact ETag and proves the original body", async () => {
    const target = await validVerifyTarget();
    const inputs = [];
    const receipt = await collectPostProbeReadback({
      target,
      credentials: objectVerifierCredentials(target),
      s3: objectAdapter(target.probeObject, { inputs }),
      now: () => new Date("2026-07-27T00:08:00.000Z"),
    });
    const normalized = normalizePostReadbackReceipt({
      target,
      receipt,
      receiptText: canonicalText(receipt),
    });

    expect(inputs[0].IfMatch).toBe(target.probeObject.etag);
    expect(receipt.facts.finalReadback.sha256).toBe(
      target.probeObject.sha256,
    );
    expect(receipt.facts.finalReadback.bytes).toBe(
      target.probeObject.bytes,
    );
    expect(normalized.postReadbackCapturedAt).toBe(
      "2026-07-27T00:08:00.000Z",
    );
  });

  test("post-probe readback rejects reused identity and object drift", async () => {
    const target = await validVerifyTarget();
    await expect(
      collectPostProbeReadback({
        target,
        credentials: {
          accessKeyId: publisherTokenId,
          secretAccessKey: "wrong-secret-value",
          credentialIdSha256:
            target.publisherCredentialIdSha256,
        },
        s3: objectAdapter(target.probeObject),
      }),
    ).rejects.toThrow(/credential drifted/i);

    await expect(
      collectPostProbeReadback({
        target,
        credentials: objectVerifierCredentials(target),
        s3: objectAdapter(target.probeObject, {
          body: Buffer.from("drifted-body\n", "utf8"),
        }),
        now: () => new Date("2026-07-27T00:08:00.000Z"),
      }),
    ).rejects.toThrow(/digest or size drifted/i);
  });

  test("final lock readback binds a sixth identity and exact rule set", async () => {
    const target = await validPostTarget();
    const finalTarget = lockTarget(target);
    const receipt = await collectFinalLockReadback({
      target: finalTarget,
      credentials: { apiToken: "lock-verifier-api-token" },
      lockApi: lockAdapter(finalTarget),
      now: sequenceNow([
        "2026-07-27T00:09:00.000Z",
        "2026-07-27T00:09:01.000Z",
      ]),
    });

    expect(receipt.credential.credentialIdSha256).toBe(
      sha256(lockVerifierId),
    );
    expect(receipt.facts.lockVerifierCredentialIdSha256).toBe(
      sha256(lockVerifierId),
    );
    expect(receipt.facts.rules).toEqual(finalTarget.lockRules);
    expect(receipt.facts.readbackRequestId).not.toBe(
      finalTarget.lockConfigurationRequestId,
    );
  });

  test("final lock readback rejects identity overlap, request reuse, and rule drift", async () => {
    const target = lockTarget(await validPostTarget());
    await expect(
      collectFinalLockReadback({
        target,
        credentials: { apiToken: "lock-verifier-api-token" },
        lockApi: lockAdapter(target, {
          verifierId: objectVerifierId,
        }),
        now: sequenceNow([
          "2026-07-27T00:09:00.000Z",
        ]),
      }),
    ).rejects.toThrow(/not independent/i);

    await expect(
      collectFinalLockReadback({
        target,
        credentials: { apiToken: "lock-verifier-api-token" },
        lockApi: lockAdapter(target, {
          requestId: target.lockConfigurationRequestId,
        }),
        now: sequenceNow([
          "2026-07-27T00:09:00.000Z",
          "2026-07-27T00:09:01.000Z",
        ]),
      }),
    ).rejects.toThrow(/request IDs/i);

    const driftedRules = structuredClone(target.lockRules);
    driftedRules[0].enabled = false;
    await expect(
      collectFinalLockReadback({
        target,
        credentials: { apiToken: "lock-verifier-api-token" },
        lockApi: lockAdapter(target, { rules: driftedRules }),
        now: sequenceNow([
          "2026-07-27T00:09:00.000Z",
          "2026-07-27T00:09:01.000Z",
        ]),
      }),
    ).rejects.toThrow(/rules or chronology/i);
  });

  test("raw S3 transport signs one request and binds strict XML bytes", async () => {
    const calls = [];
    const target = baseTarget();
    const adapter = createRawS3ProbeAdapter(
      target,
      publisherCredentials(target),
      async (url, init) => {
        calls.push({ url, init });
        const xml =
          "<Error><Code>PreconditionFailed</Code><Message>locked</Message><RequestId>raw-request-1</RequestId></Error>";
        return new Response(xml, {
          status: 412,
          headers: {
            "content-type": "application/xml",
            "content-length": String(Buffer.byteLength(xml)),
            "x-amz-request-id": "raw-request-1",
          },
        });
      },
    );
    const result = await adapter.putObject({
      bucketName: target.bucketName,
      key: target.probeObject.key,
      body: Buffer.from("different", "utf8"),
      contentType: "application/octet-stream",
      ifNoneMatch: "*",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].init.method).toBe("PUT");
    expect(calls[0].init.redirect).toBe("manual");
    expect(calls[0].init.headers["if-none-match"]).toBe("*");
    expect(calls[0].init.headers.authorization).toStartWith(
      "AWS4-HMAC-SHA256 ",
    );
    expect(result.errorCode).toBe("PreconditionFailed");
    expect(result.providerRequestId).toBe("raw-request-1");
    expect(result.requestIdSource).toBe("x-amz-request-id");
    expect(result.responseBytes).toBeGreaterThan(0);
  });

  test("raw S3 transport rejects unsafe XML and truncated bodies", async () => {
    const target = baseTarget();
    for (const response of [
      new Response(
        '<!DOCTYPE x [<!ENTITY y "z">]><Error><Code>&y;</Code></Error>',
        {
          status: 403,
          headers: {
            "content-type": "application/xml",
            "x-amz-request-id": "unsafe-xml",
          },
        },
      ),
      new Response(
        "<Error><Code>AccessDenied</Code></Error>",
        {
          status: 403,
          headers: {
            "content-type": "application/xml",
            "content-length": "999",
            "x-amz-request-id": "truncated",
          },
        },
      ),
    ]) {
      const adapter = createRawS3ProbeAdapter(
        target,
        publisherCredentials(target),
        async () => response,
      );
      await expect(
        adapter.deleteObject({
          bucketName: target.bucketName,
          key: target.probeObject.key,
        }),
      ).rejects.toThrow(/XML|truncated/i);
    }
  });

  test("raw S3 transport rejects a body/header request ID mismatch", async () => {
    const target = baseTarget();
    const xml =
      "<Error><Code>AccessDenied</Code><Message>locked</Message><RequestId>body-request</RequestId></Error>";
    const adapter = createRawS3ProbeAdapter(
      target,
      publisherCredentials(target),
      async () =>
        new Response(xml, {
          status: 403,
          headers: {
            "content-type": "application/xml",
            "content-length": String(Buffer.byteLength(xml)),
            "x-amz-request-id": "header-request",
          },
        }),
    );

    await expect(
      adapter.deleteObject({
        bucketName: target.bucketName,
        key: target.probeObject.key,
      }),
    ).rejects.toThrow(/request ID.*match/i);
  });

  test("stable receipt reader rejects hard links and noncanonical JSON", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "cinatoken-worm-enforcement-"),
    );
    const canonicalPath = join(directory, "canonical.json");
    const linkedPath = join(directory, "linked.json");
    const loosePath = join(directory, "loose.json");
    try {
      await writeFile(
        canonicalPath,
        `${canonicalJson({ ok: true })}\n`,
        "utf8",
      );
      const loaded = await readCanonicalReceiptFile(canonicalPath);
      expect(loaded.value.ok).toBe(true);
      await link(canonicalPath, linkedPath);
      await expect(
        readCanonicalReceiptFile(linkedPath),
      ).rejects.toThrow(/file bound/i);
      await writeFile(loosePath, '{ "ok": true }\n', "utf8");
      await expect(
        readCanonicalReceiptFile(loosePath),
      ).rejects.toThrow(/canonical/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("CLI describe and self-test remain canonical and secret-free", () => {
    const description = runCli([]);
    expect(description.exitCode).toBe(0);
    expect(JSON.parse(description.stdout).phases).toHaveLength(7);
    const selfTest = runCli(["--self-test"], {
      [LOCK_VERIFIER_TOKEN_ENV]: "must-not-appear",
    });
    expect(selfTest.exitCode).toBe(0);
    expect(JSON.parse(selfTest.stdout).ok).toBe(true);
    expect(JSON.parse(selfTest.stdout).cases).toBe(7);
    expect(selfTest.stdout).not.toContain("must-not-appear");
    const mixed = runCli(["--self-test", "--live"]);
    expect(mixed.exitCode).toBe(2);
    expect(mixed.stderr).toContain("must be standalone");
  });
});

function baseTarget() {
  const body = probeBody();
  const statementSha256 = "f".repeat(64);
  const prefix = `container-runtime/s3/v1/${statementSha256}/`;
  return {
    accountId,
    accountIdSha256: sha256(accountId),
    bucketName: "cinatoken-worm-staging",
    jurisdiction: "default",
    prefix,
    statementSha256,
    publisherCredentialIdSha256: sha256(publisherTokenId),
    lockOperatorCredentialIdSha256: sha256(lockOperatorId),
    objectVerifierCredentialIdSha256: sha256(objectVerifierId),
    lifecycleOperatorCredentialIdSha256:
      sha256(lifecycleOperatorId),
    lifecycleVerifierCredentialIdSha256:
      sha256(lifecycleVerifierId),
    enforcementProbePolicy: {
      publisherPreflight: {
        httpStatus: 412,
        errorCodes: ["PreconditionFailed"],
      },
      overwrite: {
        httpStatus: 403,
        errorCodes: ["AccessDenied"],
      },
      delete: {
        httpStatus: 403,
        errorCodes: ["AccessDenied"],
      },
      responseContentTypes: ["application/xml"],
      requestIdSources: ["cf-ray", "x-amz-request-id"],
    },
    lockRevocationReceiptSha256: "1".repeat(64),
    publishReceiptSha256: "2".repeat(64),
    objectReadbackReceiptSha256: "3".repeat(64),
    objectReadbackCapturedAt: "2026-07-27T00:04:00.000Z",
    lockReceiptSha256: "4".repeat(64),
    probeObject: {
      kind: "provenance-evidence-packet",
      key: `${prefix}provenance-evidence.tar.zst`,
      bytes: body.length,
      sha256: sha256(body),
      etag: '"probe-etag"',
      contentType: "application/zstd",
      customMetadata: {
        contract:
          "cinatoken-container-runtime-worm-retention-manifest-v2",
        repositoryCommit: "a".repeat(40),
        sha256: sha256(body),
      },
    },
  };
}

async function validProbeTarget() {
  const target = baseTarget();
  const receipt = await collectEnforcementProbes({
    target,
    credentials: publisherCredentials(target),
    probe: probeAdapter(),
    now: probeTimes(),
  });
  return normalizeProbeReceipt({
    target,
    receipt,
    receiptText: canonicalText(receipt),
  });
}

async function validRevokeTarget() {
  const target = await validProbeTarget();
  const receipt = await revokePublisher({
    target,
    credentials: lifecycleCredentials("operator"),
    lifecycle: lifecycleAdapter(),
    now: sequenceNow([
      "2026-07-27T00:06:00.000Z",
      "2026-07-27T00:06:01.000Z",
      "2026-07-27T00:06:02.000Z",
    ]),
  });
  return normalizePublisherRevokeReceipt({
    target,
    receipt,
    receiptText: canonicalText(receipt),
  });
}

async function validVerifyTarget() {
  const target = await validRevokeTarget();
  const receipt = await verifyPublisherRevocation({
    target,
    credentials: lifecycleCredentials("verifier"),
    lifecycle: lifecycleAdapter(),
    now: sequenceNow([
      "2026-07-27T00:07:00.000Z",
      "2026-07-27T00:07:01.000Z",
    ]),
  });
  return normalizePublisherVerifyReceipt({
    target,
    receipt,
    receiptText: canonicalText(receipt),
  });
}

async function validPostTarget() {
  const target = await validVerifyTarget();
  const receipt = await collectPostProbeReadback({
    target,
    credentials: objectVerifierCredentials(target),
    s3: objectAdapter(target.probeObject),
    now: () => new Date("2026-07-27T00:08:00.000Z"),
  });
  return normalizePostReadbackReceipt({
    target,
    receipt,
    receiptText: canonicalText(receipt),
  });
}

function lockTarget(target) {
  return {
    ...target,
    lockConfiguredAt: "2026-07-27T00:01:00.000Z",
    lockConfigurationRequestId: "lock-configuration-request",
    lockSelectedRuleId: "cinatoken-s3-retention",
    lockRules: [
      {
        id: "cinatoken-s3-retention",
        condition: {
          type: "Age",
          maxAgeSeconds: 31_536_000,
        },
        enabled: true,
        prefix: target.prefix,
      },
    ],
  };
}

function publisherCredentials(target) {
  return {
    accessKeyId: publisherTokenId,
    secretAccessKey: "publisher-secret-access-key",
    credentialIdSha256: target.publisherCredentialIdSha256,
  };
}

function objectVerifierCredentials(target) {
  return {
    accessKeyId: objectVerifierId,
    secretAccessKey: "object-verifier-secret-key",
    credentialIdSha256:
      target.objectVerifierCredentialIdSha256,
  };
}

function lifecycleCredentials(role) {
  return {
    apiToken:
      role === "operator"
        ? "lifecycle-operator-api-token"
        : "lifecycle-verifier-api-token",
    targetTokenId: publisherTokenId,
  };
}

function probeAdapter({ inputs = [], responses = null } = {}) {
  const queue =
    responses ||
    [
      probeResponse(412, "PreconditionFailed", "probe-preflight"),
      probeResponse(403, "AccessDenied", "probe-overwrite"),
      probeResponse(403, "AccessDenied", "probe-delete"),
    ];
  return {
    async putObject(input) {
      inputs.push(input);
      return queue.shift();
    },
    async deleteObject(input) {
      inputs.push(input);
      return queue.shift();
    },
  };
}

function sequenceProbe(responses) {
  return probeAdapter({ responses: [...responses] });
}

function probeResponse(status, code, requestId, overrides = {}) {
  return {
    transportCompleted: true,
    timedOut: false,
    clientSideOnly: false,
    providerRejected: true,
    httpStatus: status,
    errorCode: code,
    providerRequestId: requestId,
    requestIdSource: "cf-ray",
    responseContentType: "application/xml",
    responseBytes: 64,
    responseBodySha256: sha256(requestId),
    ...overrides,
  };
}

function probeTimes() {
  return sequenceNow([
    "2026-07-27T00:05:00.000Z",
    "2026-07-27T00:05:01.000Z",
    "2026-07-27T00:05:02.000Z",
    "2026-07-27T00:05:03.000Z",
    "2026-07-27T00:05:04.000Z",
    "2026-07-27T00:05:05.000Z",
    "2026-07-27T00:05:06.000Z",
  ]);
}

function lifecycleAdapter(overrides = {}) {
  return {
    async verifySelf({ role }) {
      const id =
        role === "lifecycle-operator"
          ? overrides.operatorId || lifecycleOperatorId
          : overrides.verifierId || lifecycleVerifierId;
      return {
        httpStatus: 200,
        providerRequestId: `${role}-preflight`,
        responseBodySha256: sha256(`${role}-preflight`),
        credentialId: id,
        status: "active",
        expiresAt: "2026-07-27T00:30:00.000Z",
        notBefore: "2026-07-27T00:00:00.000Z",
      };
    },
    async deleteToken({ targetTokenId }) {
      return {
        httpStatus: 200,
        providerRequestId: "publisher-delete-request",
        responseBodySha256: sha256("publisher-delete-response"),
        resultId: targetTokenId,
      };
    },
    async readToken({ role }) {
      const independent = role === "lifecycle-verifier";
      return {
        httpStatus: 404,
        providerRequestId: independent
          ? "independent-readback-request"
          : "operator-readback-request",
        responseBodySha256: sha256(
          independent
            ? "independent-readback-response"
            : "operator-readback-response",
        ),
        errorCodes: independent
          ? overrides.independentErrorCodes || [1000]
          : [1000],
      };
    },
  };
}

function objectAdapter(object, options = {}) {
  const body = options.body || probeBody();
  const inputs = options.inputs || [];
  return {
    async getObject(input) {
      inputs.push(input);
      return {
        $metadata: {
          httpStatusCode: 200,
          requestId: "post-probe-readback-request",
        },
        ContentLength: object.bytes,
        ETag: object.etag,
        ContentType: object.contentType,
        Metadata: {
          contract: object.customMetadata.contract,
          repositorycommit:
            object.customMetadata.repositoryCommit,
          sha256: object.sha256,
        },
        Body: Readable.from([body]),
      };
    },
  };
}

function lockAdapter(target, overrides = {}) {
  return {
    async verifySelf() {
      return {
        httpStatus: 200,
        providerRequestId: "lock-verifier-preflight",
        responseBodySha256: sha256("lock-verifier-preflight"),
        credentialId: overrides.verifierId || lockVerifierId,
        status: "active",
        expiresAt: "2026-07-27T00:30:00.000Z",
        notBefore: "2026-07-27T00:00:00.000Z",
      };
    },
    async readLock() {
      return {
        httpStatus: 200,
        providerRequestId:
          overrides.requestId || "final-lock-readback-request",
        responseBodySha256: sha256("final-lock-readback"),
        rules: overrides.rules || structuredClone(target.lockRules),
      };
    },
  };
}

function probeBody() {
  return Buffer.from("self-test-provenance-evidence\n", "utf8");
}

function canonicalText(value) {
  return `${canonicalJson(value)}\n`;
}

function sequenceNow(values) {
  let index = 0;
  return () => new Date(values[index++]);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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

test("enforcement contract constants are pinned", () => {
  expect(WORM_ENFORCEMENT_SCHEMA_VERSION).toBe(1);
  expect(WORM_ENFORCEMENT_RECEIPT_CONTRACT).toBe(
    "cinatoken-container-runtime-worm-enforcement-phase-receipt-v1",
  );
});
