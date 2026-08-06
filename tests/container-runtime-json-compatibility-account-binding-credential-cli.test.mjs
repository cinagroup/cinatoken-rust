import {
  createHash,
  generateKeyPairSync,
} from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import {
  parseJsonCompatibilityAccountBindingProfileAssemblerArgs,
  runJsonCompatibilityAccountBindingProfileAssembler,
} from "../tools/assemble_container_runtime_json_compatibility_account_binding_profile.mjs";
import {
  buildJsonCompatibilityAccountBindingCredentialReceiptSubject,
  buildJsonCompatibilityAccountBindingCredentialRevocationSubject,
  buildJsonCompatibilityAccountBindingCredentialTrustPolicy,
} from "../tools/container_runtime_json_compatibility_account_binding_credentials.mjs";
import {
  canonicalJson,
} from "../tools/container_runtime_json_compatibility_campaign.mjs";
import {
  parseJsonCompatibilityAccountBindingCredentialSignerArgs,
  runJsonCompatibilityAccountBindingCredentialSigner,
} from "../tools/sign_container_runtime_json_compatibility_account_binding_credential.mjs";
import {
  createSourceAuthenticationFixture,
} from "./fixtures/container-runtime-json-compatibility-source-authentication.mjs";
import {
  digest,
} from "./fixtures/container-runtime-json-compatibility-deployment-transition.mjs";

const NOW = 1_786_200_000;

describe("JSON compatibility account binding credential CLIs", () => {
  test("accepts private keys only through the explicit stdin mode", () => {
    expect(() => parseJsonCompatibilityAccountBindingCredentialSignerArgs([
      "--subject", "subject.json",
      "--trust-policy", "policy.json",
      "--expected-trust-policy-sha256", "a".repeat(64),
      "--private-key", "secret",
      "--out", "receipt.json",
    ])).toThrow(/unknown signer option/);
    expect(() => parseJsonCompatibilityAccountBindingCredentialSignerArgs([
      "--subject", "subject.json",
      "--trust-policy", "policy.json",
      "--expected-trust-policy-sha256", "a".repeat(64),
      "--out", "receipt.json",
    ])).toThrow(/private-key-stdin is required/);
    expect(parseJsonCompatibilityAccountBindingCredentialSignerArgs([
      "--subject", "subject.json",
      "--trust-policy", "policy.json",
      "--expected-trust-policy-sha256", "a".repeat(64),
      "--private-key-stdin",
      "--out", "receipt.json",
    ]).privateKeyStdin).toBe(true);
  });

  test("signs both receipts and revocation then assembles one create-only profile", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "cinatoken-account-binding-credential-cli-"),
    );
    let privateKeyBytes = null;
    let privateKeyPemBytes = null;
    try {
      const source = await createSourceAuthenticationFixture();
      const keys = generateKeyPairSync("ed25519");
      privateKeyBytes = keys.privateKey.export({
        format: "der",
        type: "pkcs8",
      });
      privateKeyPemBytes = Buffer.from(keys.privateKey.export({
        format: "pem",
        type: "pkcs8",
      }));
      const spki = keys.publicKey.export({ format: "der", type: "spki" });
      const keyId = "account-binding-credential-cli-test";
      const trustPolicy =
        buildJsonCompatibilityAccountBindingCredentialTrustPolicy({
          effectiveAt: NOW - 120,
          current: {
            keyId,
            spkiSha256: createHash("sha256").update(spki).digest("hex"),
            spkiBase64url: Buffer.from(spki).toString("base64url"),
          },
        });
      const accountIdSha256 = digest("credential-cli-account");
      const collectionSubject = receiptSubject({
        accountIdSha256,
        role: "collection",
        credentialIdSha256: digest("credential-cli-collection"),
        custodianIdentitySha256: digest("credential-cli-custodian-a"),
        keyId,
      });
      const readbackSubject = receiptSubject({
        accountIdSha256,
        role: "independent-readback",
        credentialIdSha256: digest("credential-cli-readback"),
        custodianIdentitySha256: digest("credential-cli-custodian-b"),
        keyId,
      });
      const revocationSubject =
        buildJsonCompatibilityAccountBindingCredentialRevocationSubject({
          sequence: 1,
          revokedCredentialIdSha256s: [],
          revokedReceiptSubjectSha256s: [],
          issuedAt: NOW,
          expiresAt: NOW + 15 * 60,
          keyId,
        });
      const trustPath = await writeCanonical(directory, "trust.json", trustPolicy);
      const collectionSubjectPath = await writeCanonical(
        directory,
        "collection-subject.json",
        collectionSubject,
      );
      const readbackSubjectPath = await writeCanonical(
        directory,
        "readback-subject.json",
        readbackSubject,
      );
      const revocationSubjectPath = await writeCanonical(
        directory,
        "revocation-subject.json",
        revocationSubject,
      );
      const collectionReceiptPath = path.join(directory, "collection-receipt.json");
      const readbackReceiptPath = path.join(directory, "readback-receipt.json");
      const revocationPath = path.join(directory, "revocation.json");
      for (const [subjectPath, outputPath] of [
        [collectionSubjectPath, collectionReceiptPath],
        [readbackSubjectPath, readbackReceiptPath],
        [revocationSubjectPath, revocationPath],
      ]) {
        const result =
          await runJsonCompatibilityAccountBindingCredentialSigner({
            subjectPath,
            trustPolicyPath: trustPath,
            expectedTrustPolicySha256:
              trustPolicy.credentialTrustPolicySha256,
            outputPath,
            privateKeyBytes,
          });
        expect(result.privateKeySource).toBe("caller-supplied-bytes");
        expect(result.privateKeyInputAttested).toBe(false);
        expect(result.privateKeyPersistedBySigner).toBe(false);
        expect(result.networkRequestsPerformed).toBe(false);
      }
      const processOutputPath = path.join(directory, "process-receipt.json");
      const processResult = await runSignerProcess({
        subjectPath: collectionSubjectPath,
        trustPolicyPath: trustPath,
        expectedTrustPolicySha256:
          trustPolicy.credentialTrustPolicySha256,
        outputPath: processOutputPath,
        privateKeyBytes,
      });
      expect(processResult.exitCode).toBe(0);
      expect(processResult.stderr).toBe("");
      expect(JSON.parse(processResult.stdout).privateKeySource).toBe("stdin");
      expect(JSON.parse(processResult.stdout).privateKeyInputAttested).toBe(true);

      const pemOutputPath = path.join(directory, "pem-process-receipt.json");
      const pemResult = await runSignerProcess({
        subjectPath: collectionSubjectPath,
        trustPolicyPath: trustPath,
        expectedTrustPolicySha256:
          trustPolicy.credentialTrustPolicySha256,
        outputPath: pemOutputPath,
        privateKeyBytes: privateKeyPemBytes,
      });
      expect(pemResult.exitCode).toBe(0);

      const ambientOutputPath = path.join(directory, "ambient-receipt.json");
      const ambientResult = await runSignerProcess({
        subjectPath: collectionSubjectPath,
        trustPolicyPath: trustPath,
        expectedTrustPolicySha256:
          trustPolicy.credentialTrustPolicySha256,
        outputPath: ambientOutputPath,
        privateKeyBytes,
        environment: { CF_API_TOKEN: "must-not-be-readable" },
      });
      expect(ambientResult.exitCode).toBe(1);
      await expect(readFile(ambientOutputPath)).rejects.toThrow();

      const tailedOutputPath = path.join(directory, "tailed-receipt.json");
      const tailedPrivateKey = Buffer.concat([
        privateKeyBytes,
        Buffer.from("unexpected-tail", "utf8"),
      ]);
      try {
        const tailedResult = await runSignerProcess({
          subjectPath: collectionSubjectPath,
          trustPolicyPath: trustPath,
          expectedTrustPolicySha256:
            trustPolicy.credentialTrustPolicySha256,
          outputPath: tailedOutputPath,
          privateKeyBytes: tailedPrivateKey,
        });
        expect(tailedResult.exitCode).toBe(1);
        expect(tailedResult.stderr)
          .toBe("Account binding credential signing failed\n");
        await expect(readFile(tailedOutputPath)).rejects.toThrow();
      } finally {
        tailedPrivateKey.fill(0);
      }

      const oversizedOutputPath = path.join(directory, "oversized-receipt.json");
      const oversizedResult = await runSignerProcess({
        subjectPath: collectionSubjectPath,
        trustPolicyPath: trustPath,
        expectedTrustPolicySha256:
          trustPolicy.credentialTrustPolicySha256,
        outputPath: oversizedOutputPath,
        privateKeyBytes: Buffer.alloc(64 * 1024 + 1, 0x41),
      });
      expect(oversizedResult.exitCode).toBe(1);
      await expect(readFile(oversizedOutputPath)).rejects.toThrow();

      const revocationEnvelope = JSON.parse(
        await readFile(revocationPath, "utf8"),
      );
      const evidence = source.bundle.accountBindingEvidence;
      const campaignPlanPath = await writeCanonical(
        directory,
        "campaign-plan.json",
        source.campaignPlan,
      );
      const statePlanPath = await writeCanonical(
        directory,
        "state-plan.json",
        source.statePlan,
      );
      const collectorIdentityPath = await writeCanonical(
        directory,
        "collector-identity.json",
        evidence.collection.collectorIdentity,
      );
      const allowedEdgesPath = await writeCanonical(
        directory,
        "allowed-edges.json",
        evidence.collectionProfile.allowedCampaignBindingEdges,
      );
      const outputPath = path.join(directory, "collection-profile.json");
      const options = {
        campaignPlanPath,
        statePlanPath,
        collectorIdentityPath,
        trustPolicyPath: trustPath,
        collectionReceiptPath,
        readbackReceiptPath,
        revocationPath,
        allowedEdgesPath,
        approvedAt: NOW,
        expectedTrustPolicySha256:
          trustPolicy.credentialTrustPolicySha256,
        expectedRevocationStateSha256:
          revocationEnvelope.credentialRevocationEnvelopeSha256,
        minimumRevocationSequence: 1,
        outputPath,
        environment: {},
      };
      const result =
        await runJsonCompatibilityAccountBindingProfileAssembler(options);
      const profile = JSON.parse(await readFile(outputPath, "utf8"));
      expect(result.collectionProfileSha256)
        .toBe(profile.collectionProfileSha256);
      expect(profile.accountIdSha256).toBe(accountIdSha256);
      expect(profile.collectionCredentialIdSha256)
        .toBe(collectionSubject.credentialIdSha256);
      expect(profile.readbackCredentialIdSha256)
        .toBe(readbackSubject.credentialIdSha256);
      expect(profile.credentialProvenance.revocation.subject.sequence).toBe(1);
      await expect(runJsonCompatibilityAccountBindingProfileAssembler(options))
        .rejects.toThrow(/EEXIST/);
    } finally {
      privateKeyBytes?.fill(0);
      privateKeyPemBytes?.fill(0);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("refuses ambient Cloudflare credentials before reading any input file", async () => {
    for (const name of [
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_API_KEY",
      "CLOUDFLARE_EMAIL",
      "CF_API_TOKEN",
      "CF_API_KEY",
      "CF_EMAIL",
      "CLOUDFLARE_ACCOUNT_BINDING_COLLECTION_TOKEN",
      "CLOUDFLARE_ACCOUNT_BINDING_READBACK_TOKEN",
    ]) {
      await expect(runJsonCompatibilityAccountBindingProfileAssembler({
        campaignPlanPath: "missing-campaign.json",
        statePlanPath: "missing-state.json",
        collectorIdentityPath: "missing-collector.json",
        trustPolicyPath: "missing-policy.json",
        collectionReceiptPath: "missing-collection.json",
        readbackReceiptPath: "missing-readback.json",
        revocationPath: "missing-revocation.json",
        allowedEdgesPath: "missing-edges.json",
        approvedAt: NOW,
        expectedTrustPolicySha256: "a".repeat(64),
        expectedRevocationStateSha256: "b".repeat(64),
        minimumRevocationSequence: 1,
        outputPath: "missing-output.json",
        environment: { [name]: "not-read" },
      })).rejects.toThrow(/credential environment is forbidden/);
    }
  });

  test("assembler parser rejects incomplete or smuggled option sets", () => {
    expect(() => parseJsonCompatibilityAccountBindingProfileAssemblerArgs([
      "--private-key", "secret",
    ])).toThrow(/unknown assembler option/);
    expect(() => parseJsonCompatibilityAccountBindingProfileAssemblerArgs([
      "--approved-at", "not-a-time",
    ])).toThrow(/campaign-plan is required/);
  });
});

function receiptSubject({
  accountIdSha256,
  role,
  credentialIdSha256,
  custodianIdentitySha256,
  keyId,
}) {
  return buildJsonCompatibilityAccountBindingCredentialReceiptSubject({
    accountIdSha256,
    role,
    credentialIdSha256,
    permissionGrants: [
      {
        permissionGroupId: "workers-scripts-read",
        name: "Workers Scripts Read",
        access: "read",
      },
      {
        permissionGroupId: "workers-routes-read",
        name: "Workers Routes Read",
        access: "read",
      },
      {
        permissionGroupId: "zone-read",
        name: "Zone Read",
        access: "read",
      },
    ],
    createdAt: NOW - 60,
    expiresAt: NOW + 30 * 60,
    issuingPrincipalIdentitySha256: digest("credential-cli-issuer"),
    custodianIdentitySha256,
    approverIdentitySha256s: [
      digest("credential-cli-approver-a"),
      digest("credential-cli-approver-b"),
    ],
    approvalPolicySha256: digest("credential-cli-approval-policy"),
    keyId,
  });
}

async function writeCanonical(directory, name, value) {
  const filePath = path.join(directory, name);
  await writeFile(filePath, `${canonicalJson(value)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return filePath;
}

async function runSignerProcess({
  subjectPath,
  trustPolicyPath,
  expectedTrustPolicySha256,
  outputPath,
  privateKeyBytes,
  environment = {},
}) {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      path.resolve(
        "tools/sign_container_runtime_json_compatibility_account_binding_credential.mjs",
      ),
      "--subject", subjectPath,
      "--trust-policy", trustPolicyPath,
      "--expected-trust-policy-sha256", expectedTrustPolicySha256,
      "--private-key-stdin",
      "--out", outputPath,
      "--json",
    ],
    cwd: path.resolve("."),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...environment },
  });
  child.stdin.write(privateKeyBytes);
  child.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}
