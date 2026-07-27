import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, test } from "bun:test";

import {
  OBJECT_VERIFIER_ACCESS_KEY_ENV,
  OBJECT_VERIFIER_SECRET_KEY_ENV,
  WORM_DATA_RECEIPT_CONTRACT,
  WORM_DATA_SCHEMA_VERSION,
  WORM_OBJECTS,
  buildDataDryRunReceipt,
  collectIndependentReadback,
  describeDataCollector,
  normalizeArtifactDescriptors,
  normalizePublishPredecessors,
  normalizeReadbackPredecessor,
  publishCreateOnlyObjects,
  readDataCredentials,
} from "../tools/lib/container_runtime_worm_data.mjs";
import {
  PUBLISHER_ACCESS_KEY_ENV,
  PUBLISHER_SECRET_KEY_ENV,
  WORM_STAGING_RECEIPT_CONTRACT,
  WORM_STAGING_SCHEMA_VERSION,
  canonicalJson,
} from "../tools/lib/container_runtime_worm_staging.mjs";
import {
  WORM_LIFECYCLE_RECEIPT_CONTRACT,
  WORM_LIFECYCLE_SCHEMA_VERSION,
} from "../tools/lib/container_runtime_worm_lifecycle.mjs";

const accountId = "0123456789abcdef0123456789abcdef";
const publisherAccessKey = "publisher-access-key-0000000001";
const publisherSecret = "publisher-secret-key-0000000001";
const verifierAccessKey = "verifier-access-key-00000000001";
const verifierSecret = "verifier-secret-key-00000000001";
const lockCredentialIdSha256 = "d".repeat(64);
const commitSha = "1".repeat(40);
const cliPath = join(
  import.meta.dir,
  "../tools/collect_container_runtime_worm_data.mjs",
);

describe("container runtime WORM data collector", () => {
  test("describe and dry-run remain credential-free and deny authority", () => {
    const fixture = predecessorFixture();
    const target = normalizePredecessors(fixture);
    const artifacts = artifactDescriptors(fixture.objectBytes);
    const description = describeDataCollector();
    const publish = buildDataDryRunReceipt(
      "publish",
      target,
      artifacts,
    );
    const readback = buildDataDryRunReceipt("readback", target);

    expect(description.schemaVersion).toBe(WORM_DATA_SCHEMA_VERSION);
    expect(description.contract).toBe(WORM_DATA_RECEIPT_CONTRACT);
    expect(description.phases.map((value) => value.phase)).toEqual([
      "publish",
      "readback",
    ]);
    expect(publish.requestPlan).toHaveLength(6);
    expect(
      publish.requestPlan.every(
        (value) => value.condition === "If-None-Match:*",
      ),
    ).toBe(true);
    for (const receipt of [publish, readback]) {
      expect(receipt.networkRequests).toBe(false);
      expect(receipt.credentialsRead).toBe(false);
      expect(receipt.writesFiles).toBe(false);
      expect(Object.values(receipt.downstreamAuthority)).toEqual(
        Array(7).fill(false),
      );
    }
  });

  test("credential loading reads only the selected role pair", () => {
    const env = {
      [PUBLISHER_ACCESS_KEY_ENV]: publisherAccessKey,
      [PUBLISHER_SECRET_KEY_ENV]: publisherSecret,
      [OBJECT_VERIFIER_ACCESS_KEY_ENV]: verifierAccessKey,
      [OBJECT_VERIFIER_SECRET_KEY_ENV]: verifierSecret,
    };
    const accessed = [];
    const proxy = new Proxy(env, {
      get(target, property) {
        accessed.push(property);
        return target[property];
      },
    });
    const publisher = readDataCredentials("publish", proxy);
    expect(accessed).toEqual([
      PUBLISHER_ACCESS_KEY_ENV,
      PUBLISHER_SECRET_KEY_ENV,
    ]);
    expect(publisher.credentialIdSha256).toBe(
      sha256(publisherAccessKey),
    );
    accessed.length = 0;
    const verifier = readDataCredentials("readback", proxy);
    expect(accessed).toEqual([
      OBJECT_VERIFIER_ACCESS_KEY_ENV,
      OBJECT_VERIFIER_SECRET_KEY_ENV,
    ]);
    expect(verifier.credentialIdSha256).toBe(
      sha256(verifierAccessKey),
    );
  });

  test("B4 predecessor binding requires exact baseline and revocation chains", () => {
    const fixture = predecessorFixture();
    const target = normalizePredecessors(fixture);
    expect(target.publisherCredentialIdSha256).toBe(
      sha256(publisherAccessKey),
    );
    expect(target.lockOperatorCredentialIdSha256).toBe(
      lockCredentialIdSha256,
    );
    expect(target.baselineReceiptSha256).toBe(
      sha256(canonicalText(fixture.baseline)),
    );
    expect(target.lockRevocationReceiptSha256).toBe(
      sha256(canonicalText(fixture.lockRevocation)),
    );

    for (const mutate of [
      (value) => {
        value.baseline.facts.providerRequestIdsComplete = false;
      },
      (value) => {
        value.lockRevocation.target.statementSha256 = "f".repeat(64);
      },
      (value) => {
        value.lockRevocation.authority.selfVerifiedAt =
          value.lockRevocation.target.revokeCapturedAt;
      },
      (value) => {
        value.lockRevocation.facts.independentReadbackErrorCodes = [1001];
      },
      (value) => {
        value.lockRevocation.downstreamAuthority.s3Complete = true;
      },
    ]) {
      const invalid = predecessorFixture();
      mutate(invalid);
      expect(() => normalizePredecessors(invalid)).toThrow(
        /predecessor|chronology|target|authority|facts/i,
      );
    }
  });

  test("artifact descriptors pin exact names, bounds and statement digest", () => {
    const fixture = predecessorFixture();
    const target = normalizePredecessors(fixture);
    const artifacts = artifactDescriptors(fixture.objectBytes);
    expect(normalizeArtifactDescriptors(artifacts, target)).toHaveLength(6);

    const reordered = [...artifacts];
    [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
    expect(() =>
      normalizeArtifactDescriptors(reordered, target),
    ).toThrow(/descriptor drifted/i);

    const wrongStatement = artifactDescriptors(fixture.objectBytes);
    wrongStatement[2].sha256 = "f".repeat(64);
    expect(() =>
      normalizeArtifactDescriptors(wrongStatement, target),
    ).toThrow(/statement digest/i);
  });

  test("publish performs six exact create-only writes", async () => {
    const fixture = predecessorFixture();
    const target = normalizePredecessors(fixture);
    const artifacts = artifactDescriptors(fixture.objectBytes);
    const inputs = [];
    let call = 0;
    const receipt = await publishCreateOnlyObjects({
      target,
      artifacts,
      credentials: publisherCredentials(),
      commitSha,
      s3: {
        async putObject(input) {
          inputs.push(input);
          const index = call++;
          return {
            ETag: `"etag-${index}"`,
            $metadata: {
              httpStatusCode: 200,
              requestId: `put-request-${index}`,
            },
          };
        },
      },
      now: sequenceNow(
        WORM_OBJECTS.map(
          (_, index) =>
            `2026-07-27T00:04:0${index}.000Z`,
        ),
      ),
    });

    expect(inputs).toHaveLength(6);
    expect(inputs.map((value) => value.IfNoneMatch)).toEqual(
      Array(6).fill("*"),
    );
    expect(inputs.map((value) => value.ContentMD5)).toEqual(
      artifacts.map((value) => value.contentMd5Base64),
    );
    expect(inputs.map((value) => value.Metadata)).toEqual(
      artifacts.map((value) => ({
        contract:
          "cinatoken-container-runtime-worm-retention-manifest-v2",
        repositorycommit: commitSha,
        sha256: value.sha256,
      })),
    );
    expect(receipt.facts.createOnlyWritesVerified).toBe(true);
    expect(receipt.facts.awsS3ObjectLockHeadersUsed).toBe(false);
    expect(receipt.providerOperations).toHaveLength(6);
    expect(receipt.downstreamAuthority.s3Complete).toBe(false);
    expect(canonicalJson(receipt)).not.toContain(publisherAccessKey);
    expect(canonicalJson(receipt)).not.toContain(publisherSecret);
  });

  test("publish rejects credential, provider metadata and ETag ambiguity", async () => {
    const fixture = predecessorFixture();
    const target = normalizePredecessors(fixture);
    const artifacts = artifactDescriptors(fixture.objectBytes);
    await expect(
      publishCreateOnlyObjects({
        target,
        artifacts,
        credentials: {
          ...publisherCredentials(),
          credentialIdSha256: "f".repeat(64),
        },
        commitSha,
        s3: successPublishAdapter(),
      }),
    ).rejects.toThrow(/credential/i);
    await expect(
      publishCreateOnlyObjects({
        target,
        artifacts,
        credentials: publisherCredentials(),
        commitSha,
        s3: successPublishAdapter({ requestId: null }),
      }),
    ).rejects.toThrow(/metadata/i);
    await expect(
      publishCreateOnlyObjects({
        target,
        artifacts,
        credentials: publisherCredentials(),
        commitSha,
        s3: successPublishAdapter({ etag: null }),
      }),
    ).rejects.toThrow(/ETag/i);
  });

  test("readback exhausts inventory and streams six exact objects", async () => {
    const fixture = predecessorFixture();
    const publish = await validPublish(fixture);
    const target = normalizeReadbackPredecessor({
      accountId,
      publishReceipt: publish,
      publishReceiptText: canonicalText(publish),
    });
    const sink = memorySink();
    const adapter = readbackAdapter(target, fixture.objectBytes);
    const receipt = await collectIndependentReadback({
      target,
      credentials: verifierCredentials(),
      s3: adapter,
      sink,
      now: sequenceNow(
        WORM_OBJECTS.map(
          (_, index) =>
            `2026-07-27T00:05:0${index}.000Z`,
        ),
      ),
    });

    expect(receipt.facts.objects).toHaveLength(6);
    expect(receipt.facts.finalPaginationComplete).toBe(true);
    expect(receipt.facts.multipartUploadCount).toBe(0);
    expect(receipt.facts.unknownObjectCount).toBe(0);
    expect(receipt.credential.credentialIdSha256).toBe(
      sha256(verifierAccessKey),
    );
    expect(receipt.providerOperations).toHaveLength(8);
    expect(adapter.getInputs.map((value) => value.IfMatch)).toEqual(
      target.objects.map((value) => value.etag),
    );
    for (const [kind, bytes] of fixture.objectBytes) {
      expect(sink.values.get(kind)).toEqual(bytes);
    }
    expect(receipt.downstreamAuthority.wormRetentionVerified).toBe(false);
  });

  test("readback rejects publisher reuse, unknown objects and multipart residue", async () => {
    const fixture = predecessorFixture();
    const publish = await validPublish(fixture);
    const target = normalizeReadbackPredecessor({
      accountId,
      publishReceipt: publish,
      publishReceiptText: canonicalText(publish),
    });
    await expect(
      collectIndependentReadback({
        target,
        credentials: publisherCredentials(),
        s3: readbackAdapter(target, fixture.objectBytes),
        sink: memorySink(),
      }),
    ).rejects.toThrow(/must differ/i);

    const unknown = readbackAdapter(target, fixture.objectBytes);
    unknown.listObjectsV2 = async () => ({
      Name: target.bucketName,
      Prefix: target.prefix,
      KeyCount: 7,
      Contents: [
        ...listedObjects(target),
        {
          Key: `${target.prefix}unexpected`,
          Size: 1,
          ETag: '"unexpected"',
        },
      ],
      IsTruncated: false,
      $metadata: { httpStatusCode: 200, requestId: "list-unknown" },
    });
    await expect(
      collectIndependentReadback({
        target,
        credentials: verifierCredentials(),
        s3: unknown,
        sink: memorySink(),
      }),
    ).rejects.toThrow(/inventory count/i);

    const multipart = readbackAdapter(target, fixture.objectBytes);
    multipart.listMultipartUploads = async () => ({
      Bucket: target.bucketName,
      Prefix: target.prefix,
      Uploads: [
        {
          Key: `${target.prefix}${WORM_OBJECTS[0].fileName}`,
          UploadId: "upload-1",
        },
      ],
      IsTruncated: false,
      $metadata: { httpStatusCode: 200, requestId: "multipart-1" },
    });
    await expect(
      collectIndependentReadback({
        target,
        credentials: verifierCredentials(),
        s3: multipart,
        sink: memorySink(),
      }),
    ).rejects.toThrow(/multipart/i);
  });

  test("readback rejects metadata, ETag and body drift before authority", async () => {
    const fixture = predecessorFixture();
    const publish = await validPublish(fixture);
    const target = normalizeReadbackPredecessor({
      accountId,
      publishReceipt: publish,
      publishReceiptText: canonicalText(publish),
    });
    for (const mutate of [
      (response) => {
        response.Metadata.sha256 = "f".repeat(64);
      },
      (response) => {
        response.ETag = '"drifted"';
      },
      (response) => {
        response.Body = Readable.from([Buffer.from("drifted")]);
      },
      (response) => {
        response.$metadata.requestId = null;
      },
    ]) {
      const adapter = readbackAdapter(target, fixture.objectBytes, mutate);
      await expect(
        collectIndependentReadback({
          target,
          credentials: verifierCredentials(),
          s3: adapter,
          sink: memorySink(),
          now: sequenceNow(
            WORM_OBJECTS.map(
              (_, index) =>
                `2026-07-27T00:05:0${index}.000Z`,
            ),
          ),
        }),
      ).rejects.toThrow(/metadata|headers|body|provider/i);
    }
  });

  test("publish receipt parser rejects condition, ordering and overclaim drift", async () => {
    const fixture = predecessorFixture();
    for (const mutate of [
      (receipt) => {
        receipt.providerOperations[0].condition = "none";
      },
      (receipt) => {
        receipt.facts.objects[0].uploadedAt =
          receipt.predecessors.lockRevocationObservedAt;
      },
      (receipt) => {
        receipt.facts.objects.reverse();
      },
      (receipt) => {
        receipt.downstreamAuthority.s3Complete = true;
      },
    ]) {
      const publish = await validPublish(fixture);
      mutate(publish);
      expect(() =>
        normalizeReadbackPredecessor({
          accountId,
          publishReceipt: publish,
          publishReceiptText: canonicalText(publish),
        }),
      ).toThrow(/predecessor|operation|upload|authority/i);
    }
  });

  test("CLI dry-runs validate real predecessor and artifact file boundaries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cinatoken-worm-data-"));
    try {
      const fixture = predecessorFixture();
      const baselinePath = join(directory, "baseline.json");
      const revocationPath = join(directory, "lock-revocation.json");
      const publishPath = join(directory, "publish.json");
      const artifactDir = join(directory, "artifacts");
      const outputDir = join(directory, "readback");
      await mkdir(artifactDir);
      await mkdir(outputDir);
      await writeFile(
        baselinePath,
        canonicalText(fixture.baseline),
        "utf8",
      );
      await writeFile(
        revocationPath,
        canonicalText(fixture.lockRevocation),
        "utf8",
      );
      for (const object of WORM_OBJECTS) {
        await writeFile(
          join(artifactDir, object.fileName),
          fixture.objectBytes.get(object.kind),
        );
      }
      const publishDryRun = runCli([
        "--phase",
        "publish",
        "--account-id",
        accountId,
        "--baseline-receipt",
        baselinePath,
        "--lock-revocation-receipt",
        revocationPath,
        "--artifact-dir",
        artifactDir,
        "--commit-sha",
        commitSha,
        "--dry-run",
      ]);
      expect(publishDryRun.exitCode).toBe(0);
      expect(JSON.parse(publishDryRun.stdout).networkRequests).toBe(false);

      const publish = await validPublish(fixture);
      await writeFile(publishPath, canonicalText(publish), "utf8");
      const readbackDryRun = runCli([
        "--phase",
        "readback",
        "--account-id",
        accountId,
        "--publish-receipt",
        publishPath,
        "--output-dir",
        outputDir,
        "--dry-run",
      ]);
      expect(readbackDryRun.exitCode).toBe(0);
      expect(JSON.parse(readbackDryRun.stdout).writesFiles).toBe(false);

      const unconfirmed = runCli([
        "--phase",
        "publish",
        "--account-id",
        accountId,
        "--baseline-receipt",
        baselinePath,
        "--lock-revocation-receipt",
        revocationPath,
        "--artifact-dir",
        artifactDir,
        "--commit-sha",
        commitSha,
        "--live",
      ]);
      expect(unconfirmed.exitCode).toBe(1);
      expect(unconfirmed.stderr).toContain(
        "requires --confirm-staging-target",
      );
      expect(unconfirmed.stderr).not.toContain(publisherAccessKey);

      await link(baselinePath, join(directory, "baseline-hardlink.json"));
      const linked = runCli([
        "--phase",
        "publish",
        "--account-id",
        accountId,
        "--baseline-receipt",
        baselinePath,
        "--lock-revocation-receipt",
        revocationPath,
        "--artifact-dir",
        artifactDir,
        "--commit-sha",
        commitSha,
      ]);
      expect(linked.exitCode).toBe(1);
      expect(linked.stderr).toContain("outside its file bound");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function predecessorFixture() {
  const statementBytes = Buffer.from(
    '{"_type":"https://in-toto.io/Statement/v1"}\n',
  );
  const statementSha256 = sha256(statementBytes);
  const prefix = `container-runtime/s3/v1/${statementSha256}/`;
  const target = {
    accountIdSha256: sha256(accountId),
    bucketName: "cinatoken-worm-staging",
    jurisdiction: "default",
    prefix,
    statementSha256,
  };
  const baseline = {
    schemaVersion: WORM_STAGING_SCHEMA_VERSION,
    contract: WORM_STAGING_RECEIPT_CONTRACT,
    source: "cinatoken-container-runtime-worm-staging-collector",
    environment: "staging",
    phase: "baseline",
    mode: "live",
    ok: true,
    capturedAt: "2026-07-27T00:00:00.000Z",
    networkRequests: true,
    credentialsRead: true,
    writesFiles: false,
    phaseMutationConfirmed: false,
    mutationPerformed: false,
    target,
    credential: {
      role: "publisher",
      credentialType: "r2-object-read-write-api-token",
      credentialIdSha256: sha256(publisherAccessKey),
    },
    facts: {
      baselineObservedAt: "2026-07-27T00:00:00.000Z",
      baselinePaginationComplete: true,
      preexistingObjectCount: 0,
      multipartUploadCount: 0,
      objectPages: 1,
      multipartPages: 1,
      providerRequestIdsComplete: true,
    },
    providerOperations: [
      {
        operation: "ListObjectsV2",
        page: 1,
        httpStatus: 200,
        providerRequestId: "baseline-objects-1",
      },
      {
        operation: "ListMultipartUploads",
        page: 1,
        httpStatus: 200,
        providerRequestId: "baseline-multipart-1",
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
  const lockRevocation = {
    schemaVersion: WORM_LIFECYCLE_SCHEMA_VERSION,
    contract: WORM_LIFECYCLE_RECEIPT_CONTRACT,
    source: "cinatoken-container-runtime-worm-lifecycle-collector",
    environment: "staging",
    phase: "verify",
    mode: "live",
    ok: true,
    capturedAt: "2026-07-27T00:03:01.000Z",
    networkRequests: true,
    credentialsRead: true,
    writesFiles: false,
    phaseMutationConfirmed: false,
    mutationPerformed: false,
    target: {
      ...target,
      targetRole: "lock-operator",
      targetCredentialIdSha256: lockCredentialIdSha256,
      lockReceiptSha256: "2".repeat(64),
      lockCapturedAt: "2026-07-27T00:01:00.000Z",
      revokeReceiptSha256: "3".repeat(64),
      revokeCapturedAt: "2026-07-27T00:02:00.000Z",
      lifecycleOperatorCredentialIdSha256: "4".repeat(64),
      operatorReadbackErrorCodes: [1000],
    },
    authority: {
      role: "lifecycle-verifier",
      credentialType: "cloudflare-account-api-token-read",
      credentialIdSha256: "5".repeat(64),
      selfVerifiedAt: "2026-07-27T00:03:00.000Z",
      expiresAt: "2026-07-27T00:30:00.000Z",
      remainingLifetimeSeconds: 1_620,
    },
    facts: {
      apiSurface: "cloudflare-account-token-api",
      independentReadbackAt: "2026-07-27T00:03:01.000Z",
      independentReadbackErrorCodes: [1000],
      independentReadbackHttpStatus: 404,
      independentReadbackRequestId: "verify-absence-request",
      independentReadbackResponseBodySha256: "6".repeat(64),
      operatorAndVerifierCredentialIdsDistinct: true,
      targetAbsenceIndependentlyObserved: true,
    },
    providerOperations: [
      {
        method: "GET",
        operation: "lifecycle-verifier-preflight",
        httpStatus: 200,
        providerRequestId: "verify-preflight-request",
        responseBodySha256: "7".repeat(64),
      },
      {
        method: "GET",
        operation: "independent-revocation-readback",
        httpStatus: 404,
        providerRequestId: "verify-absence-request",
        responseBodySha256: "6".repeat(64),
      },
    ],
    limits: {
      requestTimeoutMs: 30_000,
      responseBytes: 1024 * 1024,
      predecessorReceiptBytes: 1024 * 1024,
      mutableCredentialRemainingSeconds: 3_600,
    },
    downstreamAuthority: downstreamAuthority(),
  };
  const objectBytes = new Map(
    WORM_OBJECTS.map((value, index) => [
      value.kind,
      value.kind === "provenance-statement"
        ? statementBytes
        : Buffer.from(`${value.kind}-${index}\n`),
    ]),
  );
  return { baseline, lockRevocation, objectBytes };
}

function normalizePredecessors(fixture) {
  return normalizePublishPredecessors({
    accountId,
    baselineReceipt: fixture.baseline,
    baselineReceiptText: canonicalText(fixture.baseline),
    lockRevocationReceipt: fixture.lockRevocation,
    lockRevocationReceiptText: canonicalText(
      fixture.lockRevocation,
    ),
  });
}

function artifactDescriptors(objectBytes) {
  return WORM_OBJECTS.map((value) => {
    const bytes = objectBytes.get(value.kind);
    return {
      ...value,
      bytes: bytes.length,
      sha256: sha256(bytes),
      contentMd5Base64: createHash("md5")
        .update(bytes)
        .digest("base64"),
      bodyFactory() {
        return Readable.from([bytes]);
      },
    };
  });
}

function publisherCredentials() {
  return {
    accessKeyId: publisherAccessKey,
    secretAccessKey: publisherSecret,
    credentialIdSha256: sha256(publisherAccessKey),
  };
}

function verifierCredentials() {
  return {
    accessKeyId: verifierAccessKey,
    secretAccessKey: verifierSecret,
    credentialIdSha256: sha256(verifierAccessKey),
  };
}

function successPublishAdapter(overrides = {}) {
  let index = 0;
  return {
    async putObject() {
      const value = {
        ETag: `"etag-${index}"`,
        $metadata: {
          httpStatusCode: 200,
          requestId: `put-request-${index}`,
        },
      };
      index += 1;
      if (Object.hasOwn(overrides, "etag")) value.ETag = overrides.etag;
      if (Object.hasOwn(overrides, "requestId")) {
        value.$metadata.requestId = overrides.requestId;
      }
      return value;
    },
  };
}

async function validPublish(fixture) {
  return publishCreateOnlyObjects({
    target: normalizePredecessors(fixture),
    artifacts: artifactDescriptors(fixture.objectBytes),
    credentials: publisherCredentials(),
    commitSha,
    s3: successPublishAdapter(),
    now: sequenceNow(
      WORM_OBJECTS.map(
        (_, index) => `2026-07-27T00:04:0${index}.000Z`,
      ),
    ),
  });
}

function listedObjects(target) {
  return target.objects.map((value) => ({
    Key: value.key,
    Size: value.bytes,
    ETag: value.etag,
  }));
}

function readbackAdapter(target, objectBytes, mutateFirst = null) {
  let getIndex = 0;
  const getInputs = [];
  return {
    getInputs,
    async listObjectsV2() {
      return {
        Name: target.bucketName,
        Prefix: target.prefix,
        KeyCount: target.objects.length,
        Contents: listedObjects(target),
        IsTruncated: false,
        $metadata: { httpStatusCode: 200, requestId: "objects-page-1" },
      };
    },
    async listMultipartUploads() {
      return {
        Bucket: target.bucketName,
        Prefix: target.prefix,
        Uploads: [],
        IsTruncated: false,
        $metadata: {
          httpStatusCode: 200,
          requestId: "multipart-page-1",
        },
      };
    },
    async getObject(input) {
      getInputs.push(input);
      const object = target.objects.find(
        (value) => value.key === input.Key,
      );
      const bytes = objectBytes.get(object.kind);
      const response = {
        Body: Readable.from([bytes]),
        ContentLength: object.bytes,
        ContentType: object.contentType,
        ETag: object.etag,
        Metadata: {
          contract:
            "cinatoken-container-runtime-worm-retention-manifest-v2",
          repositorycommit: commitSha,
          sha256: object.sha256,
        },
        $metadata: {
          httpStatusCode: 200,
          requestId: `get-request-${getIndex}`,
        },
      };
      if (getIndex === 0 && mutateFirst) mutateFirst(response);
      getIndex += 1;
      return response;
    },
  };
}

function memorySink() {
  const values = new Map();
  return {
    values,
    async beginObject(object) {
      const chunks = [];
      return {
        async write(chunk) {
          chunks.push(Buffer.from(chunk));
        },
        async commit() {
          values.set(object.kind, Buffer.concat(chunks));
        },
        async abort() {
          chunks.length = 0;
        },
      };
    },
  };
}

function sequenceNow(values) {
  let index = 0;
  return () => new Date(values[index++]);
}

function canonicalText(value) {
  return `${canonicalJson(value)}\n`;
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
