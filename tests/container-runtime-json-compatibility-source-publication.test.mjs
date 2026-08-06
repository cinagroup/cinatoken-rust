import {
  createHash,
  generateKeyPairSync,
  verify,
} from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import {
  assembleJsonCompatibilitySourceSignatureSubject,
} from "../tools/assemble_container_runtime_json_compatibility_source_signature_subject.mjs";
import {
  assembleJsonCompatibilitySourcePublication,
  parseJsonCompatibilitySourcePublicationAssemblerArgs,
} from "../tools/assemble_container_runtime_json_compatibility_source_publication.mjs";
import { canonicalJson } from
  "../tools/container_runtime_json_compatibility_campaign.mjs";
import {
  JSON_COMPATIBILITY_SOURCE_SIGNATURE_AUDIENCE,
  JSON_COMPATIBILITY_SOURCE_SIGNATURE_ISSUER,
  buildJsonCompatibilitySourceVerifierPolicy,
  buildJsonCompatibilitySourceSignatureSubjectFromIntent,
  buildJsonCompatibilitySourceSigningIntent,
  sourceSignatureSigningPayload,
  validateJsonCompatibilitySourceSignatureEnvelope,
} from "../tools/container_runtime_json_compatibility_source_authentication.mjs";
import {
  buildJsonCompatibilitySourcePublicationPacket,
  validateJsonCompatibilitySourcePublicationPacket,
} from "../tools/container_runtime_json_compatibility_source_publication.mjs";
import {
  assertJsonCompatibilitySourceSignerCredentialFreeEnvironment,
  parseJsonCompatibilitySourceBundleSignerArgs,
  runJsonCompatibilitySourceBundleSigner,
} from "../tools/sign_container_runtime_json_compatibility_source_bundle.mjs";
import {
  createSourceAuthenticationFixture,
} from "./fixtures/container-runtime-json-compatibility-source-authentication.mjs";
import { digest } from
  "./fixtures/container-runtime-json-compatibility-deployment-transition.mjs";

const NOW = 1_786_300_000;

describe("JSON compatibility C4 source publication", () => {
  test("builds one canonical packet without feeding publication digests into C4", async () => {
    const fixture = await createSourceAuthenticationFixture({ now: NOW });
    const packet = buildJsonCompatibilitySourcePublicationPacket({
      sourceAuthenticationRequest: fixture.sourceAuthenticationRequest,
      bundle: fixture.bundle,
    }, { now: NOW });
    expect(validateJsonCompatibilitySourcePublicationPacket(
      packet,
      { now: NOW },
    )).toEqual(packet);
    expect(packet).toMatchObject({
      bundleKey: fixture.bundleKey,
      bundleSha256: fixture.bundle.bundleSha256,
      sourceSignatureEnvelopeSha256:
        fixture.sourceSignatureEnvelopeSha256,
      objectMetadata: {
        contract:
          "cinatoken-container-runtime-json-compatibility-source-authentication-bundle-v3",
        bundleSha256: fixture.bundle.bundleSha256,
        sourceSignatureEnvelopeSha256:
          fixture.sourceSignatureEnvelopeSha256,
      },
    });
    expect(packet.bodyByteLength).toBe(
      Buffer.byteLength(fixture.bundleBody, "utf8"),
    );
    expect(packet.bundle.sourceSignatureEnvelope.subject).not.toHaveProperty(
      "publicationPacketSha256",
    );
    expect(packet.bundle.sourceSignatureEnvelope.subject).not.toHaveProperty(
      "writeReceiptSha256",
    );
    expect(packet.bundle.sourceSignatureEnvelope.subject).not.toHaveProperty(
      "readbackReceiptSha256",
    );

    const drifted = structuredClone(packet);
    drifted.objectMetadata.bundleSha256 = "f".repeat(64);
    expect(() => validateJsonCompatibilitySourcePublicationPacket(
      drifted,
      { now: NOW },
    )).toThrow(/source publication packet/);
  });

  test("assembles the C4 subject from an acyclic anchored intent", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "cinatoken-c4-source-intent-"),
    );
    try {
      const fixture = await createSourceAuthenticationFixture({
        now: NOW,
        operationSeed: "source-signing-intent-operation",
      });
      const {
        sourceSignatureEnvelopeSha256: _envelopeSha256,
        ...sourceEvidence
      } = fixture.sourceAuthenticationRequest.sourceEvidence;
      const signedSubject = fixture.bundle.sourceSignatureEnvelope.subject;
      const intent = buildJsonCompatibilitySourceSigningIntent({
        operationIdSha256:
          fixture.sourceAuthenticationRequest.operationIdSha256,
        campaignPlanDigestSha256:
          fixture.sourceAuthenticationRequest.campaignPlanDigestSha256,
        statePlanDigestSha256:
          fixture.sourceAuthenticationRequest.statePlanDigestSha256,
        transition: fixture.sourceAuthenticationRequest.transition,
        sourceEvidence,
        accountBindingEvidenceSha256:
          fixture.bundle.accountBindingEvidence.accountBindingEvidenceSha256,
        keyId: signedSubject.keyId,
        issuedAt: signedSubject.issuedAt,
        notBefore: signedSubject.notBefore,
        expiresAt: signedSubject.expiresAt,
      });
      expect(buildJsonCompatibilitySourceSignatureSubjectFromIntent(intent))
        .toEqual(signedSubject);
      expect(intent).not.toHaveProperty("operationDigestSha256");
      expect(intent).not.toHaveProperty("authorizedTransitionSha256");
      expect(intent.sourceEvidence).not.toHaveProperty(
        "sourceSignatureEnvelopeSha256",
      );

      const intentPath = await writeCanonical(
        directory,
        "intent.json",
        intent,
      );
      const outputPath = path.join(directory, "subject.json");
      const result = await assembleJsonCompatibilitySourceSignatureSubject({
        intentPath,
        expectedIntentSha256: intent.sourceSigningIntentSha256,
        expectedVerifierPolicySha256:
          signedSubject.sourceVerifierPolicySha256,
        expectedVerifierIdentitySha256:
          signedSubject.sourceVerifierIdentitySha256,
        outputPath,
      });
      expect(result).toMatchObject({
        sourceSigningIntentSha256: intent.sourceSigningIntentSha256,
        sourceSignatureSubjectSha256: intent.sourceSignatureSubjectSha256,
        placeholderDigestInputAccepted: false,
        outputCreated: true,
      });
      expect(JSON.parse(await readFile(outputPath, "utf8")))
        .toEqual(signedSubject);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("signs one reviewed subject with an externally anchored C4 key", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "cinatoken-c4-source-signer-"),
    );
    let privateKeyBytes = null;
    try {
      const keys = generateKeyPairSync("ed25519");
      privateKeyBytes = Buffer.from(keys.privateKey.export({
        format: "der",
        type: "pkcs8",
      }));
      const spki = Buffer.from(keys.publicKey.export({
        format: "der",
        type: "spki",
      }));
      const spkiSha256 = createHash("sha256").update(spki).digest("hex");
      const keyId = "c4-source-publication-test";
      const policy = buildJsonCompatibilitySourceVerifierPolicy({
        serviceName: JSON_COMPATIBILITY_SOURCE_SIGNATURE_AUDIENCE,
        profileVersion: 1,
        keyPrefix:
          "container-runtime/json-compatibility/source-authentication/v3/sha256",
        issuer: JSON_COMPATIBILITY_SOURCE_SIGNATURE_ISSUER,
        audience: JSON_COMPATIBILITY_SOURCE_SIGNATURE_AUDIENCE,
        externalWormArchivePolicySha256: digest("c4-worm-policy"),
        current: { keyId, spkiSha256 },
        previous: null,
      });
      const subject = sourceSubject({
        keyId,
        sourceVerifierPolicySha256: policy.sourceVerifierPolicySha256,
      });
      const subjectPath = await writeCanonical(
        directory,
        "subject.json",
        subject,
      );
      const policyPath = await writeCanonical(
        directory,
        "policy.json",
        policy,
      );
      const outputPath = path.join(directory, "envelope.json");
      const result = await runJsonCompatibilitySourceBundleSigner({
        subjectPath,
        verifierPolicyPath: policyPath,
        expectedVerifierPolicySha256: policy.sourceVerifierPolicySha256,
        outputPath,
        privateKeyBytes,
      });
      const envelope = validateJsonCompatibilitySourceSignatureEnvelope(
        JSON.parse(await readFile(outputPath, "utf8")),
      );
      expect(result).toMatchObject({
        mode: "offline-ed25519-source-bundle-signing",
        keyId,
        signerSpkiSha256: spkiSha256,
        verifierPolicySha256: policy.sourceVerifierPolicySha256,
        outputCreated: true,
        privateKeyPersistedBySigner: false,
        networkRequestsPerformed: false,
        cloudflareMutationPerformed: false,
      });
      expect(verify(
        null,
        sourceSignatureSigningPayload(envelope.subject),
        keys.publicKey,
        Buffer.from(envelope.signatureBase64url, "base64url"),
      )).toBe(true);
      await expect(runJsonCompatibilitySourceBundleSigner({
        subjectPath,
        verifierPolicyPath: policyPath,
        expectedVerifierPolicySha256: policy.sourceVerifierPolicySha256,
        outputPath,
        privateKeyBytes,
      })).rejects.toThrow();
    } finally {
      privateKeyBytes?.fill(0);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("requires stdin mode and rejects ambient cloud credentials", async () => {
    expect(() => parseJsonCompatibilitySourceBundleSignerArgs([
      "--subject", "subject.json",
      "--verifier-policy", "policy.json",
      "--expected-verifier-policy-sha256", "a".repeat(64),
      "--private-key", "secret",
      "--out", "envelope.json",
    ])).toThrow(/unknown source signer option/);
    expect(() => parseJsonCompatibilitySourceBundleSignerArgs([
      "--subject", "subject.json",
      "--verifier-policy", "policy.json",
      "--expected-verifier-policy-sha256", "a".repeat(64),
      "--out", "envelope.json",
    ])).toThrow(/private-key-stdin is required/);
    expect(() =>
      assertJsonCompatibilitySourceSignerCredentialFreeEnvironment({
        CLOUDFLARE_API_TOKEN: "must-not-be-used",
      })).toThrow(/credential environment is forbidden/);
    const processResult = await runSignerDescribeProcess({
      CLOUDFLARE_API_TOKEN: "must-not-be-used",
    });
    expect(processResult.exitCode).toBe(0);
    expect(JSON.parse(processResult.stdout)).toMatchObject({
      privateKeyInput: "stdin-only",
      networkRequestsPerformed: false,
      cloudflareMutationPerformed: false,
    });
    expect(processResult.stdout).not.toContain("must-not-be-used");
  });

  test("assembles a create-only packet only against both verifier anchors", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "cinatoken-source-publication-assembler-"),
    );
    try {
      const fixture = await createSourceAuthenticationFixture({ now: NOW });
      const requestPath = await writeCanonical(
        directory,
        "request.json",
        fixture.sourceAuthenticationRequest,
      );
      const bundlePath = await writeCanonical(
        directory,
        "bundle.json",
        fixture.bundle,
      );
      const outputPath = path.join(directory, "publication.json");
      const result = await assembleJsonCompatibilitySourcePublication({
        requestPath,
        bundlePath,
        expectedVerifierPolicySha256:
          fixture.sourceVerifierIdentity.sourceVerifierPolicySha256,
        expectedVerifierIdentitySha256:
          fixture.sourceVerifierIdentity.sourceVerifierIdentitySha256,
        now: NOW,
        outputPath,
      });
      expect(result).toMatchObject({
        bundleKey: fixture.bundleKey,
        outputCreated: true,
        credentialSecretRead: false,
        networkRequestsPerformed: false,
      });
      expect(`${canonicalJson(JSON.parse(
        await readFile(outputPath, "utf8"),
      ))}\n`).toBe(await readFile(outputPath, "utf8"));
      await expect(assembleJsonCompatibilitySourcePublication({
        requestPath,
        bundlePath,
        expectedVerifierPolicySha256: "a".repeat(64),
        expectedVerifierIdentitySha256:
          fixture.sourceVerifierIdentity.sourceVerifierIdentitySha256,
        now: NOW,
        outputPath: path.join(directory, "drift.json"),
      })).rejects.toThrow(/policy anchor/);
      expect(parseJsonCompatibilitySourcePublicationAssemblerArgs([
        "--request", "request.json",
        "--bundle", "bundle.json",
        "--expected-verifier-policy-sha256", "a".repeat(64),
        "--expected-verifier-identity-sha256", "b".repeat(64),
        "--now", String(NOW),
        "--out", "publication.json",
      ]).now).toBe(NOW);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function sourceSubject({ keyId, sourceVerifierPolicySha256 }) {
  return {
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-json-compatibility-source-signature-subject-v2",
    environment: "staging",
    issuer: JSON_COMPATIBILITY_SOURCE_SIGNATURE_ISSUER,
    audience: JSON_COMPATIBILITY_SOURCE_SIGNATURE_AUDIENCE,
    keyId,
    profile: "release-v1",
    operationIdSha256: digest("c4-operation"),
    campaignPlanDigestSha256: digest("c4-campaign-plan"),
    statePlanDigestSha256: digest("c4-state-plan"),
    transitionId: "activate-status-caller-to-callee",
    transitionOrdinal: 1,
    fromState: "dark",
    toState: "statusOnly",
    transitionSha256: digest("c4-transition"),
    accountIdSha256: digest("c4-account"),
    sourceVerifierPolicySha256,
    sourceVerifierIdentitySha256: digest("c4-verifier-identity"),
    transitionSourceManifestSha256: digest("c4-transition-source"),
    phaseSourceManifestSha256: null,
    artifactInventoryReadbackSha256: digest("c4-artifact-inventory"),
    accountBindingEvidenceSha256: digest("c4-account-binding-evidence"),
    accountBindingInventorySha256: digest("c4-account-binding-inventory"),
    immutableSourceArchiveReceiptSha256: digest("c4-archive-receipt"),
    issuedAt: NOW,
    notBefore: NOW,
    expiresAt: NOW + 24 * 60 * 60,
  };
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

async function runSignerDescribeProcess(environment) {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      path.resolve(
        "tools/sign_container_runtime_json_compatibility_source_bundle.mjs",
      ),
      "--describe",
    ],
    cwd: path.resolve("."),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...environment },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}
