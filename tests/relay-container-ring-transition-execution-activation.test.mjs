import { describe, expect, test } from "bun:test";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";

import { canonicalJson } from "../tools/relay_container_p5_evidence_contract.mjs";
import {
  RING_TRANSITION_AUTHORITY_ORIGIN,
  RING_TRANSITION_CLAIM_PERMIT_CONTRACT,
  RING_TRANSITION_CLAIM_DISPATCH_CONTRACT,
  RING_TRANSITION_CLAIM_REQUEST_CONTRACT,
  RING_TRANSITION_CLAIMS_PATH,
  RING_TRANSITION_EXECUTION_ACTIVATION_CONTRACT,
  RING_TRANSITION_EXECUTION_ACTIVATION_TRUST_CONTRACT,
  RING_TRANSITION_EXECUTION_CLAIM_CONTRACT,
  computeRingTransitionExecutionClaimDigest,
  describeRingTransitionExecutionActivationContract,
  ringTransitionClaimPermitMessage,
  verifyRingTransitionClaimDispatch,
  verifyRingTransitionExecutionActivation,
} from "../tools/relay_container_ring_transition_execution_activation_contract.mjs";

const NOW = 2_000_000_000;
const CLAIM_DIGEST =
  "378a7c0f1ca0500ff127a13c20e8e7887900568c5d8b5d66517e7d9018814085";
const ACTIVATION_SHA256 =
  "7654ae29d633a2ec759b906bd2bbfce5ce3ee5170c2dc2e77dfbfdf50ce54994";
const CLAIM_REQUEST_SHA256 =
  "93172b98f2afd9aafe5dd4c8e4e658090634001df60cbc276182a5443ff0e83e";
const ED25519_PKCS8_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);

describe("ring-transition fixed execution activation", () => {
  test("matches the frozen Rust vectors from deterministic seed [7;32]", () => {
    const value = fixture();

    expect(value.activation.claimRequest.claim.claimDigestSha256).toBe(
      CLAIM_DIGEST,
    );
    expect(sha256(value.activationBytes)).toBe(ACTIVATION_SHA256);
    expect(
      sha256(
        Buffer.from(canonicalJson(value.activation.claimRequest), "utf8"),
      ),
    ).toBe(CLAIM_REQUEST_SHA256);

    const verified = verify(value);
    expect(verified).toMatchObject({
      ok: true,
      activationSha256: ACTIVATION_SHA256,
      publicationManifestSha256: "b".repeat(64),
      activationSequence: 1,
      authorizationIdSha256: "1".repeat(64),
      executionNonceSha256: "2".repeat(64),
      claimDigestSha256: CLAIM_DIGEST,
      claimOwnerSha256: "6".repeat(64),
      claimRequestSha256: CLAIM_REQUEST_SHA256,
      claimGeneratedAt: NOW - 1,
      permitExpiresAt: NOW + 59,
      claimExpiresAt: NOW + 120,
    });
    expect(Buffer.from(verified.claimRequestBytes).toString("utf8")).toBe(
      canonicalJson(value.activation.claimRequest),
    );
  });

  test("rejects non-canonical, duplicate, and unknown fields", () => {
    const value = fixture();
    const pretty = Buffer.from(
      JSON.stringify(value.activation, null, 2),
      "utf8",
    );
    expect(() => verify(value, { activationBytes: pretty })).toThrow(
      "must be canonical",
    );

    const duplicate = Buffer.from(
      canonicalJson(value.activation).replace(
        /^\{/,
        '{"schemaVersion":1,',
      ),
      "utf8",
    );
    expect(() => verify(value, { activationBytes: duplicate })).toThrow(
      "duplicate fields",
    );

    const unknownRoot = mutate(value.activation, (activation) => {
      activation.callerSelectedPath = "/tmp/activation.json";
    });
    expect(() => verify(value, { activationBytes: unknownRoot })).toThrow(
      "unknown field callerSelectedPath",
    );

    const unknownNested = mutate(value.activation, (activation) => {
      activation.claimRequest.permit.authorizationHeader = "forbidden";
    });
    expect(() => verify(value, { activationBytes: unknownNested })).toThrow(
      "unknown field authorizationHeader",
    );
  });

  test("enforces publication, fixed Authority locator, and trust joins", () => {
    const value = fixture();
    const publicationDrift = mutate(value.activation, (activation) => {
      activation.publication.publicationManifestSha256 = "0".repeat(64);
    });
    expect(() =>
      verify(value, { activationBytes: publicationDrift }),
    ).toThrow("publication publicationManifestSha256 mismatch");

    const locatorDrift = mutate(value.activation, (activation) => {
      activation.locator.path = "/caller/path";
    });
    expect(() => verify(value, { activationBytes: locatorDrift })).toThrow(
      "locator path mismatch",
    );

    const originDrift = structuredClone(value.trust);
    originDrift.authorityOrigin = "https://caller.example";
    expect(() => verify(value, { trust: originDrift })).toThrow(
      "Authority origin mismatch",
    );

    const publicationTrustDrift = structuredClone(value.publication);
    publicationTrustDrift.release.trustConfigSha256 = "9".repeat(64);
    expect(() =>
      verify(value, { publication: publicationTrustDrift }),
    ).toThrow("publication configuration mismatch");

    const claimTrustDrift = structuredClone(value.trust);
    claimTrustDrift.accountIdSha256 = "9".repeat(64);
    expect(() => verify(value, { trust: claimTrustDrift })).toThrow(
      "trust join accountIdSha256 mismatch",
    );
  });

  test("recomputes the exact orchestrator claim digest", () => {
    const value = fixture();
    expect(
      computeRingTransitionExecutionClaimDigest(
        value.activation.claimRequest.claim,
      ),
    ).toBe(CLAIM_DIGEST);

    const drift = mutate(value.activation, (activation) => {
      activation.claimRequest.claim.candidateSha256 = "0".repeat(64);
    });
    expect(() => verify(value, { activationBytes: drift })).toThrow(
      "digest mismatch",
    );
  });

  test("verifies SPKI SHA-256 and the Ed25519 domain-separated permit", () => {
    const value = fixture();
    expect(verify(value).ok).toBe(true);

    const spkiDrift = mutate(value.activation, (activation) => {
      activation.permitSpkiBase64url = Buffer.alloc(44, 7).toString(
        "base64url",
      );
    });
    expect(() => verify(value, { activationBytes: spkiDrift })).toThrow(
      "not Ed25519 SPKI",
    );

    const signatureDrift = mutate(value.activation, (activation) => {
      const signature = Buffer.from(
        activation.claimRequest.permit.signatureBase64url,
        "base64url",
      );
      signature[0] ^= 1;
      activation.claimRequest.permit.signatureBase64url =
        signature.toString("base64url");
    });
    expect(() => verify(value, { activationBytes: signatureDrift })).toThrow(
      "signature is invalid",
    );

    const wrongDomain = structuredClone(value.activation);
    wrongDomain.claimRequest.permit.signatureBase64url = sign(
      null,
      Buffer.from(
        `caller-domain\n${canonicalJson(
          permitSubject(wrongDomain.claimRequest.permit),
        )}`,
        "utf8",
      ),
      value.privateKey,
    ).toString("base64url");
    expect(() =>
      verify(value, {
        activationBytes: Buffer.from(canonicalJson(wrongDomain), "utf8"),
      }),
    ).toThrow("signature is invalid");
  });

  test("enforces permit and claim time windows without side effects", () => {
    const value = fixture();
    expect(() => verify(value, { now: NOW + 60 })).toThrow(
      "validity window is invalid",
    );

    const expired = mutate(value.activation, (activation) => {
      activation.claimRequest.permit.expiresAt = NOW - 1;
    });
    expect(() => verify(value, { activationBytes: expired })).toThrow(
      "validity window is invalid",
    );

    const description = describeRingTransitionExecutionActivationContract();
    expect(description.constraints).toMatchObject({
      credentialsRead: false,
      environmentRead: false,
      filesRead: false,
      filesWritten: false,
      networkRequestsPerformed: false,
      remoteMutationAuthorized: false,
    });
  });

  test("independently verifies the create-new claim dispatch guard", () => {
    const value = fixture();
    const activation = verify(value);
    const dispatch = {
      schemaVersion: 1,
      contract: RING_TRANSITION_CLAIM_DISPATCH_CONTRACT,
      environment: "staging",
      activationSha256: activation.activationSha256,
      publicationManifestSha256:
        activation.publicationManifestSha256,
      activationSequence: activation.activationSequence,
      authorizationIdSha256: activation.authorizationIdSha256,
      claimDigestSha256: activation.claimDigestSha256,
      claimOwnerSha256: activation.claimOwnerSha256,
      claimRequestSha256: activation.claimRequestSha256,
      postRequestIdSha256: sha256(
        Buffer.from("claim-post-request-001", "utf8"),
      ),
      reservedAt: NOW,
    };
    const bytes = Buffer.from(canonicalJson(dispatch), "utf8");
    expect(
      verifyRingTransitionClaimDispatch({
        dispatchBytes: bytes,
        activation,
      }),
    ).toMatchObject({
      ok: true,
      contract: RING_TRANSITION_CLAIM_DISPATCH_CONTRACT,
      activationSha256: ACTIVATION_SHA256,
      authorizationIdSha256: "1".repeat(64),
      claimDigestSha256: CLAIM_DIGEST,
      postRequestIdSha256: dispatch.postRequestIdSha256,
      reservedAt: NOW,
      dispatchSha256: sha256(bytes),
    });

    const unknown = { ...dispatch, retry: true };
    expect(() =>
      verifyRingTransitionClaimDispatch({
        dispatchBytes: Buffer.from(canonicalJson(unknown), "utf8"),
        activation,
      }),
    ).toThrow("unknown field retry");

    const drift = {
      ...dispatch,
      claimRequestSha256: "0".repeat(64),
    };
    expect(() =>
      verifyRingTransitionClaimDispatch({
        dispatchBytes: Buffer.from(canonicalJson(drift), "utf8"),
        activation,
      }),
    ).toThrow("claimRequestSha256 mismatch");

    const late = {
      ...dispatch,
      reservedAt: activation.permitExpiresAt,
    };
    expect(() =>
      verifyRingTransitionClaimDispatch({
        dispatchBytes: Buffer.from(canonicalJson(late), "utf8"),
        activation,
      }),
    ).toThrow("reservation window is invalid");

    expect(() =>
      verifyRingTransitionClaimDispatch({
        dispatchBytes: Buffer.from(
          JSON.stringify(dispatch, null, 2),
          "utf8",
        ),
        activation,
      }),
    ).toThrow("must be canonical");

    expect(() =>
      verifyRingTransitionClaimDispatch({
        dispatchBytes: Buffer.from(
          canonicalJson(dispatch).replace(
            /^\{/,
            '{"schemaVersion":1,',
          ),
          "utf8",
        ),
        activation,
      }),
    ).toThrow("duplicate fields");
  });
});

function fixture() {
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.alloc(32, 7)]),
    format: "der",
    type: "pkcs8",
  });
  const spki = createPublicKey(privateKey).export({
    format: "der",
    type: "spki",
  });
  const permitSpkiSha256 = sha256(spki);
  const publication = buildPublication(permitSpkiSha256);
  const trust = buildTrust(permitSpkiSha256);
  const claim = {
    schemaVersion: 1,
    contract: RING_TRANSITION_EXECUTION_CLAIM_CONTRACT,
    claimAuthority: "d1-unique-claim-v1",
    claimScope: "staging-worker-ring-transition",
    environment: "staging",
    authorizationIdSha256: "1".repeat(64),
    executionNonceSha256: "2".repeat(64),
    authorizationManifestSha256: "3".repeat(64),
    authorizationSubjectSha256: "4".repeat(64),
    authorizationPolicySha256: "5".repeat(64),
    transitionManifestSha256: "6".repeat(64),
    transitionSubjectSha256: "7".repeat(64),
    transitionPolicySha256: "8".repeat(64),
    transitionPlanSha256: "9".repeat(64),
    candidateSha256: "a".repeat(64),
    executionPlanSha256: "b".repeat(64),
    accountIdSha256: "c".repeat(64),
    ledgerIdentitySha256: "d".repeat(64),
    readCredentialIdSha256: "e".repeat(64),
    claimCredentialIdSha256: "f".repeat(64),
    deployCredentialIdSha256: "0".repeat(64),
    controller: {
      serviceName: "controller-staging",
      previousVersionId: "controller-version-001",
      previousDeploymentSetSha256: "1".repeat(64),
      targetVersionId: "controller-version-002",
    },
    edge: {
      serviceName: "edge-staging",
      previousVersionId: "edge-version-001",
      previousDeploymentSetSha256: "2".repeat(64),
      targetVersionId: "edge-version-002",
    },
    runnerBuildSha256: publication.release.artifactSha256,
    runnerTrustConfigSha256: "4".repeat(64),
    claimOwnerSha256: "6".repeat(64),
    generatedAt: NOW - 1,
    expiresAt: NOW + 120,
  };
  claim.claimDigestSha256 =
    computeRingTransitionExecutionClaimDigest(claim);
  const permit = {
    schemaVersion: 1,
    contract: RING_TRANSITION_CLAIM_PERMIT_CONTRACT,
    issuer: "cinatoken-ring-permit-staging",
    keyId: "permit-v1",
    authorizationIdSha256: claim.authorizationIdSha256,
    claimDigestSha256: claim.claimDigestSha256,
    claimOwnerSha256: claim.claimOwnerSha256,
    ledgerIdentitySha256: claim.ledgerIdentitySha256,
    claimCredentialIdSha256: claim.claimCredentialIdSha256,
    issuedAt: NOW - 1,
    expiresAt: NOW + 59,
  };
  permit.signatureBase64url = sign(
    null,
    ringTransitionClaimPermitMessage(permit),
    privateKey,
  ).toString("base64url");
  const activation = {
    schemaVersion: 1,
    contract: RING_TRANSITION_EXECUTION_ACTIVATION_CONTRACT,
    environment: "staging",
    publication: {
      publicationManifestSha256: publication.publicationManifestSha256,
      publicationPacketSha256: publication.publicationPacketSha256,
      generationSha256: publication.generationSha256,
      activationSequence: publication.activationSequence,
      runnerBuildSha256: publication.release.artifactSha256,
      runnerTrustConfigSha256: publication.release.trustConfigSha256,
    },
    locator: {
      method: "POST",
      authorityOrigin: RING_TRANSITION_AUTHORITY_ORIGIN,
      path: RING_TRANSITION_CLAIMS_PATH,
      retry: false,
      timeoutMilliseconds: 10_000,
      maximumResponseBytes: 256 * 1024,
      accessServiceTokenRequired: true,
    },
    permitSpkiBase64url: spki.toString("base64url"),
    claimRequest: {
      schemaVersion: 1,
      contract: RING_TRANSITION_CLAIM_REQUEST_CONTRACT,
      claim,
      permit,
    },
  };
  return {
    activation,
    activationBytes: Buffer.from(canonicalJson(activation), "utf8"),
    trust,
    publication,
    privateKey,
  };
}

function buildPublication(permitSpkiSha256) {
  return {
    release: {
      sourceCommit: "1".repeat(40),
      gitTreeSha: "2".repeat(40),
      targetTriple: "x86_64-unknown-linux-gnu",
      manifestSha256: "5".repeat(64),
      packetSha256: "6".repeat(64),
      policySha256: "7".repeat(64),
      releaseKeyId: "release-v1",
      releaseKeySpkiBase64url: "release-spki",
      releaseKeySpkiSha256: "8".repeat(64),
      artifactFileName: "cinatoken-ring-transition-runner",
      artifactByteLength: 1,
      artifactSha256: "3".repeat(64),
      moduleInventorySha256: "9".repeat(64),
      moduleCount: 28,
      moduleBytes: 1,
      authorityVersionId: "authority-version-001",
      permitSpkiSha256,
      trustConfigSha256: "4".repeat(64),
      issuedAt: "2033-05-18T03:33:19Z",
      expiresAt: "2033-05-18T03:43:19Z",
    },
    publicationManifestSha256: "b".repeat(64),
    publicationPacketSha256: "c".repeat(64),
    generationSha256: "d".repeat(64),
    publicationDirectoryName: `publication-${"b".repeat(64)}`,
    activationSequence: 1,
    previousPublicationManifestSha256: null,
    publishedAt: "2033-05-18T03:33:19.000Z",
    expiresAt: "2033-05-18T03:43:19.000Z",
  };
}

function buildTrust(permitSpkiSha256) {
  return {
    schemaVersion: 1,
    contract: RING_TRANSITION_EXECUTION_ACTIVATION_TRUST_CONTRACT,
    enabled: true,
    environment: "staging",
    authorityOrigin: RING_TRANSITION_AUTHORITY_ORIGIN,
    claimPath: RING_TRANSITION_CLAIMS_PATH,
    permitIssuer: "cinatoken-ring-permit-staging",
    permitKeyId: "permit-v1",
    permitSpkiSha256,
    ledgerIdentitySha256: "d".repeat(64),
    transitionPolicySha256: "8".repeat(64),
    authorizationPolicySha256: "5".repeat(64),
    accountIdSha256: "c".repeat(64),
    readCredentialIdSha256: "e".repeat(64),
    claimCredentialIdSha256: "f".repeat(64),
    deployCredentialIdSha256: "0".repeat(64),
    controllerServiceName: "controller-staging",
    edgeServiceName: "edge-staging",
    runnerTrustConfigSha256: "4".repeat(64),
  };
}

function verify(value, overrides = {}) {
  return verifyRingTransitionExecutionActivation({
    activationBytes: overrides.activationBytes ?? value.activationBytes,
    trust: overrides.trust ?? value.trust,
    publication: overrides.publication ?? value.publication,
    now: overrides.now ?? NOW,
  });
}

function permitSubject(permit) {
  const subject = { ...permit };
  delete subject.signatureBase64url;
  return subject;
}

function mutate(value, callback) {
  const copy = structuredClone(value);
  callback(copy);
  return Buffer.from(canonicalJson(copy), "utf8");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
