import { describe, expect, test } from "bun:test";

import {
  DSSE_PAYLOAD_TYPE,
  SIGSTORE_BUNDLE_MEDIA_TYPE,
  SOURCE_DEPENDENCIES,
  auditRepositoryContract,
  buildProvenanceStatement,
  canonicalJson,
  parseArgs,
  validateProvenancePolicy,
  validateProvenanceStatement,
  validateSigstoreBundle,
  validateWorkflowRunEvent,
} from "../tools/verify_container_runtime_provenance.mjs";

describe("container runtime provenance gate", () => {
  test("fingerprints every non-Cargo build-context dependency", () => {
    expect(SOURCE_DEPENDENCIES).toContainEqual([".dockerignore", "text/plain"]);
    expect(SOURCE_DEPENDENCIES).toContainEqual([
      "contracts/container-runtime/v1/generated/container-runtime.pb",
      "application/x-protobuf",
    ]);
  });

  test("keeps offline and real modes mutually exclusive", () => {
    expect(parseArgs(["--self-test", "--json"])).toMatchObject({
      selfTest: true,
      mode: null,
      json: true,
    });
    expect(
      parseArgs([
        "--generate",
        "--evidence-dir",
        "/tmp/evidence",
        "--event",
        "/tmp/event.json",
        "--statement",
        "/tmp/statement.json",
        "--report",
        "/tmp/report.json",
        "--json",
      ]),
    ).toMatchObject({
      selfTest: false,
      mode: "generate",
      bundlePath: null,
    });
    expect(
      parseArgs([
        "--verify",
        "--evidence-dir",
        "/tmp/evidence",
        "--event",
        "/tmp/event.json",
        "--statement",
        "/tmp/statement.json",
        "--bundle",
        "/tmp/bundle.json",
        "--cosign-verification-log",
        "/tmp/cosign.log",
        "--report",
        "/tmp/report.json",
      ]),
    ).toMatchObject({
      mode: "verify",
      bundlePath: "/tmp/bundle.json",
    });
    expect(() => parseArgs(["--self-test", "--generate"])).toThrow(
      /cannot be combined/i,
    );
    expect(() =>
      parseArgs([
        "--verify",
        "--evidence-dir",
        "/tmp/evidence",
        "--event",
        "/tmp/event.json",
        "--statement",
        "/tmp/statement.json",
        "--report",
        "/tmp/report.json",
      ]),
    ).toThrow(/bundle/i);
  });

  test("pins the least-privilege workflow and immutable tool identities", async () => {
    const report = await auditRepositoryContract();
    expect(report).toMatchObject({
      status: "passed",
      statementGenerated: false,
      signatureVerificationPerformed: false,
      transparencyLogVerified: false,
      wormRetentionVerified: false,
      s3Complete: false,
      registryDigestAuthorized: false,
      cloudflareDeploymentAuthorized: false,
      productionCutoverAuthorized: false,
    });
    expect(report.policy.cosignVersion).toBe("v3.1.2");
    expect(report.policy.cosignLinuxAmd64Sha256).toBe(
      "f7622ed3cf22e55e1ae6377c080979ff77a22da9981c11df222a2e444991e7cf",
    );
  });

  test("rejects signer policy drift", async () => {
    const policy = await loadPolicy();
    expect(validateProvenancePolicy(policy)).toEqual(policy);
    for (const mutate of [
      (value) => {
        value.repository = "attacker/repository";
      },
      (value) => {
        value.allowedSourceEvents.push("pull_request");
      },
      (value) => {
        value.certificateIdentity =
          "https://github.com/attacker/workflow.yml@refs/heads/main";
      },
      (value) => {
        value.cosignLinuxAmd64Sha256 = "0".repeat(64);
      },
      (value) => {
        value.artifactRetentionDays = 1;
      },
      (value) => {
        value.unreviewed = true;
      },
    ]) {
      const drifted = structuredClone(policy);
      mutate(drifted);
      expect(() => validateProvenancePolicy(drifted)).toThrow(/policy/i);
    }
  });

  test("accepts only a successful same-repository same-commit main source run", async () => {
    const policy = await loadPolicy();
    const { event, environment } = workflowRunFixture(policy);
    expect(validateWorkflowRunEvent(event, environment, policy)).toMatchObject({
      sourceRunId: 30229751845,
      sourceRunAttempt: 1,
      sourceHeadSha: "1".repeat(40),
      signerSha: "1".repeat(40),
      sourceEvent: "push",
    });
    for (const mutate of [
      (value) => {
        value.event.workflow_run.event = "pull_request";
      },
      (value) => {
        value.event.workflow_run.head_repository.full_name =
          "attacker/repository";
      },
      (value) => {
        value.event.workflow_run.head_sha = "2".repeat(40);
      },
      (value) => {
        value.event.workflow_run.conclusion = "failure";
      },
      (value) => {
        value.environment.GITHUB_WORKFLOW_REF =
          "attacker/repository/.github/workflows/a.yml@refs/heads/main";
      },
    ]) {
      const drifted = structuredClone({ event, environment });
      mutate(drifted);
      expect(() =>
        validateWorkflowRunEvent(
          drifted.event,
          drifted.environment,
          policy,
        ),
      ).toThrow(/source workflow|signer workflow/i);
    }
  });

  test("builds one exact SLSA v1 statement over all release subjects", async () => {
    const fixture = await statementFixture();
    const statement = buildProvenanceStatement(fixture);
    expect(validateProvenanceStatement(statement, fixture)).toEqual(statement);
    expect(statement).toMatchObject({
      _type: "https://in-toto.io/Statement/v1",
      predicateType: "https://slsa.dev/provenance/v1",
      predicate: {
        buildDefinition: {
          externalParameters: {
            repository: "cinagroup/cinatoken-rust",
            ref: "refs/heads/main",
            eventName: "push",
          },
        },
        runDetails: {
          builder: {
            id: "https://github.com/actions/runner/github-hosted",
          },
        },
      },
    });
    expect(statement.subject.map((entry) => entry.name)).toEqual([
      "container-runtime.oci.tar",
      "container-runtime.oci.index.json",
      "container-runtime.oci.manifest.json",
      "container-runtime.oci.config.json",
      "usr/local/bin/cinatoken-container-runtime",
      "container-runtime.sbom.syft.json",
      "container-runtime.vulnerabilities.grype.json",
    ]);
  });

  test("rejects subject, source, dependency and byproduct drift", async () => {
    const fixture = await statementFixture();
    const statement = buildProvenanceStatement(fixture);
    for (const mutate of [
      (value) => {
        value.subject[0].digest.sha256 = "0".repeat(64);
      },
      (value) => {
        value.subject[0].name = "attacker.tar";
      },
      (value) => {
        value.predicate.buildDefinition.externalParameters.ref =
          "refs/heads/feature";
      },
      (value) => {
        value.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit =
          "2".repeat(40);
      },
      (value) => {
        value.predicate.runDetails.byproducts[0].digest.sha256 =
          "0".repeat(64);
      },
      (value) => {
        value.predicate.runDetails.unreviewed = true;
      },
    ]) {
      const drifted = structuredClone(statement);
      mutate(drifted);
      expect(() =>
        validateProvenanceStatement(drifted, fixture),
      ).toThrow(/exactly match/i);
    }
  });

  test("requires exact DSSE payload, one signature, Rekor inclusion and RFC3161", async () => {
    const fixture = await statementFixture();
    const statement = buildProvenanceStatement(fixture);
    const statementBytes = Buffer.from(canonicalJson(statement), "utf8");
    const bundle = bundleFixture(statementBytes);
    expect(validateSigstoreBundle(bundle, statementBytes)).toMatchObject({
      signatureCount: 1,
      certificatePresent: true,
      transparencyEntryCount: 1,
      inclusionPromisePresent: true,
      inclusionProofPresent: true,
      signedTimestampCount: 1,
    });

    const payloadDrift = structuredClone(bundle);
    payloadDrift.dsseEnvelope.payload = Buffer.from(
      `${canonicalJson(statement)} `,
      "utf8",
    ).toString("base64");
    expect(() =>
      validateSigstoreBundle(payloadDrift, statementBytes),
    ).toThrow(/payload/i);

    const multiple = structuredClone(bundle);
    multiple.dsseEnvelope.signatures.push(
      structuredClone(multiple.dsseEnvelope.signatures[0]),
    );
    expect(() => validateSigstoreBundle(multiple, statementBytes)).toThrow(
      /one.*signature/i,
    );

    const noTransparency = structuredClone(bundle);
    noTransparency.verificationMaterial.tlogEntries = [];
    expect(() =>
      validateSigstoreBundle(noTransparency, statementBytes),
    ).toThrow(/transparency/i);

    const noTimestamp = structuredClone(bundle);
    noTimestamp.verificationMaterial.timestampVerificationData.rfc3161Timestamps =
      [];
    expect(() => validateSigstoreBundle(noTimestamp, statementBytes)).toThrow(
      /timestamp/i,
    );
  });

  test("rejects message-signature bundles and unsupported bundle fields", async () => {
    const fixture = await statementFixture();
    const statementBytes = Buffer.from(
      canonicalJson(buildProvenanceStatement(fixture)),
      "utf8",
    );
    const messageSignature = bundleFixture(statementBytes);
    messageSignature.messageSignature = {
      messageDigest: {
        algorithm: "SHA2_256",
        digest: Buffer.alloc(32).toString("base64"),
      },
      signature: Buffer.alloc(64).toString("base64"),
    };
    delete messageSignature.dsseEnvelope;
    expect(() =>
      validateSigstoreBundle(messageSignature, statementBytes),
    ).toThrow(/keys drifted/i);

    const extra = bundleFixture(statementBytes);
    extra.verificationMaterial.unreviewed = true;
    expect(() => validateSigstoreBundle(extra, statementBytes)).toThrow(
      /unsupported key/i,
    );
  });
});

async function loadPolicy() {
  return JSON.parse(
    await Bun.file(
      new URL(
        "../config/container-runtime-provenance-policy.json",
        import.meta.url,
      ),
    ).text(),
  );
}

function workflowRunFixture(policy) {
  const sha = "1".repeat(40);
  return {
    event: {
      repository: {
        id: 123,
        full_name: policy.repository,
      },
      workflow_run: {
        id: 30229751845,
        run_attempt: 1,
        name: policy.sourceWorkflowName,
        path: policy.sourceWorkflowPath,
        event: "push",
        status: "completed",
        conclusion: "success",
        head_branch: policy.sourceBranch,
        head_sha: sha,
        run_started_at: "2026-07-27T01:24:01Z",
        updated_at: "2026-07-27T01:27:29Z",
        html_url:
          "https://github.com/cinagroup/cinatoken-rust/actions/runs/30229751845",
        repository: {
          id: 123,
          full_name: policy.repository,
        },
        head_repository: {
          id: 123,
          full_name: policy.repository,
        },
      },
    },
    environment: {
      GITHUB_REPOSITORY: policy.repository,
      GITHUB_SHA: sha,
      GITHUB_REF: policy.sourceRef,
      GITHUB_EVENT_NAME: "workflow_run",
      GITHUB_RUN_ID: "30240000000",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_WORKFLOW_REF:
        `${policy.repository}/${policy.provenanceWorkflowPath}` +
        `@${policy.sourceRef}`,
      GITHUB_WORKFLOW_SHA: sha,
    },
  };
}

async function statementFixture() {
  const policy = await loadPolicy();
  const { event, environment } = workflowRunFixture(policy);
  const invocation = validateWorkflowRunEvent(event, environment, policy);
  const sha = (character) => character.repeat(64);
  const evidence = {
    ociReport: {
      status: "passed",
      reproducibility: { archiveSha256: sha("a") },
      ociIndexDigest: `sha256:${sha("b")}`,
      ociManifestDigest: `sha256:${sha("c")}`,
      ociConfigDigest: `sha256:${sha("d")}`,
      runtimeBinarySha256: sha("e"),
    },
    sbomReport: {
      sbom: { sha256: sha("f") },
    },
    vulnerabilityReport: {
      scan: { sha256: sha("0") },
    },
    fingerprints: new Map([
      [
        "container-runtime-oci-verification.json",
        {
          sha256: sha("1"),
          bytes: 100,
          mediaType: "application/json",
        },
      ],
      [
        "container-runtime-sbom-verification.json",
        {
          sha256: sha("2"),
          bytes: 200,
          mediaType: "application/json",
        },
      ],
    ]),
  };
  const dependencies = [
    {
      uri:
        `git+https://github.com/${policy.repository}@` +
        `${invocation.sourceHeadSha}#Cargo.lock`,
      name: "Cargo.lock",
      digest: { sha256: sha("3") },
      mediaType: "text/plain",
      annotations: { bytes: 300 },
    },
  ];
  return { policy, invocation, evidence, dependencies };
}

function bundleFixture(statementBytes) {
  const base64 = (length, fill) =>
    Buffer.alloc(length, fill).toString("base64");
  return {
    mediaType: SIGSTORE_BUNDLE_MEDIA_TYPE,
    verificationMaterial: {
      certificate: {
        rawBytes: base64(512, 1),
      },
      tlogEntries: [
        {
          logIndex: "2190554392",
          logId: { keyId: base64(32, 2) },
          kindVersion: { kind: "dsse", version: "0.0.1" },
          integratedTime: "1784300419",
          inclusionPromise: {
            signedEntryTimestamp: base64(64, 3),
          },
          inclusionProof: {
            logIndex: "2068650130",
            rootHash: base64(32, 4),
            treeSize: "2068650137",
            hashes: [base64(32, 5)],
            checkpoint: { envelope: "rekor checkpoint" },
          },
          canonicalizedBody: base64(128, 6),
        },
      ],
      timestampVerificationData: {
        rfc3161Timestamps: [
          {
            signedTimestamp: base64(256, 7),
          },
        ],
      },
    },
    dsseEnvelope: {
      payload: statementBytes.toString("base64"),
      payloadType: DSSE_PAYLOAD_TYPE,
      signatures: [
        {
          sig: base64(64, 8),
        },
      ],
    },
  };
}
