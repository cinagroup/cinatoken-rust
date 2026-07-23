import { describe, expect, test } from "bun:test";

import {
  DEPLOYMENT_PINNED_RING_TRANSITION_TRUST,
  buildClaimAuthorityReadRequest,
  buildCloudflareDeploymentMutationRequest,
  ringTransitionTrustConfigDigestSha256,
} from "../tools/relay_container_ring_transition_execution_contract.mjs";
import {
  RING_TRANSITION_AUTHORITY_HEADER,
} from "../tools/relay_container_ring_transition_execution_contract.mjs";
import {
  RING_TRANSITION_TRANSPORT_ENV,
  createRingTransitionNativeTransport,
  describeRingTransitionNativeTransport,
} from "../tools/relay_container_ring_transition_native_transport.mjs";
import { sha256Hex } from "../tools/relay_container_p5_evidence_contract.mjs";

const ACCOUNT_ID = "a".repeat(32);
const READ_TOKEN = "read-token-value-0000000000000001";
const CLAIM_SECRET = "claim-hmac-secret-00000000000001";
const DEPLOY_TOKEN = "deploy-token-value-00000000000001";
const READ_TOKEN_ID = "read-token-identity-v1";
const DEPLOY_TOKEN_ID = "deploy-token-identity-v1";
const CLAIM_CREDENTIAL_ID = "b".repeat(64);

describe("Relay Container native ring-transition transport", () => {
  test("keeps the transport free of ambient secrets, logging, and helper subprocesses", async () => {
    const source = await Bun.file(
      new URL(
        "../tools/relay_container_ring_transition_native_transport.mjs",
        import.meta.url,
      ),
    ).text();

    for (const forbidden of [
      "process.env",
      "console.",
      "response.text(",
      "response.json(",
      "response.arrayBuffer(",
      "Math.random(",
      "passThroughOnException",
      "child_process",
      "wrangler",
    ]) {
      expect(source).not.toContain(forbidden);
    }
    expect(source.match(/await fetchImpl\(/g)).toHaveLength(1);
  });

  test("describes a credential-free, zero-retry boundary", () => {
    const result = describeRingTransitionNativeTransport();
    expect(result).toMatchObject({
      environment: "staging",
      redirectsFollowed: false,
      postRetries: 0,
      credentialsRead: false,
      networkRequestsPerformed: false,
      mutationPerformed: false,
    });
    expect(result.credentialEnvironmentBindings).toEqual(
      Object.values(RING_TRANSITION_TRANSPORT_ENV),
    );
    expect(JSON.stringify(result)).not.toContain(READ_TOKEN);
    expect(JSON.stringify(result)).not.toContain(CLAIM_SECRET);
    expect(JSON.stringify(result)).not.toContain(DEPLOY_TOKEN);
  });

  test("reads only fixed secret handles and binds the raw account to trust", () => {
    const anchors = publishedAnchors();
    const environment = credentialEnvironment();
    environment.UNRELATED_POISON_TOKEN = "poison-must-not-be-read";
    const transport = createRingTransitionNativeTransport({
      anchors,
      credentialIds: credentialIds(),
      environment,
      fetchImpl: async () => {
        throw new Error("network must not run during construction");
      },
    });
    expect(transport.describe()).toMatchObject({
      credentialsRead: true,
      accountIdentityMatched: true,
      readCredentialVerified: false,
      deployCredentialVerified: false,
    });
    expect(JSON.stringify(transport)).toBe("{}");
    expect(JSON.stringify(transport.describe())).not.toContain(
      "poison-must-not-be-read",
    );

    expect(() =>
      createRingTransitionNativeTransport({
        anchors,
        credentialIds: credentialIds(),
        environment: {
          ...credentialEnvironment(),
          [RING_TRANSITION_TRANSPORT_ENV.accountId]: "f".repeat(32),
        },
      }),
    ).toThrow(/account_identity_mismatch/);
    expect(() =>
      createRingTransitionNativeTransport({
        anchors,
        credentialIds: {
          ...credentialIds(),
          deploy: credentialIds().read,
        },
        environment,
      }),
    ).toThrow(/credential_ids_must_be_distinct/);
  });

  test("verifies read/deploy token identities before pinned read and mutation", async () => {
    const calls = [];
    const anchors = publishedAnchors();
    const fetchImpl = successfulFetch(calls, anchors);
    const transport = createRingTransitionNativeTransport({
      anchors,
      credentialIds: credentialIds(),
      environment: credentialEnvironment(),
      fetchImpl,
    });

    await expect(transport.readDeployment(anchors.controllerServiceName)).rejects.toThrow(
      /read_credential_not_verified/,
    );
    const identities = await transport.verifyCredentialIdentities();
    expect(identities).toEqual({
      readCredentialIdSha256: credentialIds().read,
      claimCredentialIdSha256: credentialIds().claim,
      deployCredentialIdSha256: credentialIds().deploy,
      allDistinct: true,
      allCredentialsVerified: true,
    });

    const deployment = await transport.readDeployment(
      anchors.controllerServiceName,
    );
    expect(deployment).toMatchObject({
      serviceName: anchors.controllerServiceName,
      mutationAnnotation: "cinatoken staging ring transition 1111111111111111",
      activeVersions: [
        { versionId: "controller-version-002", percentage: 100 },
      ],
    });
    const version = await transport.readVersion(
      anchors.controllerServiceName,
      "controller-version-002",
    );
    expect(version.versionDetailSha256).toMatch(/^[0-9a-f]{64}$/);

    const mutation = buildCloudflareDeploymentMutationRequest({
      anchors,
      accountId: ACCOUNT_ID,
      serviceName: anchors.controllerServiceName,
      targetVersionId: "controller-version-002",
      authorizationIdSha256: "1".repeat(64),
    });
    const result = await transport.deployOnce(mutation);
    expect(result).toMatchObject({
      transportOutcome: "success",
      httpStatus: 200,
      retry: false,
    });

    const tokenVerifyCalls = calls.filter(({ url }) =>
      url.endsWith("/tokens/verify"),
    );
    expect(tokenVerifyCalls).toHaveLength(2);
    expect(tokenVerifyCalls[0].options.headers.authorization).toBe(
      `Bearer ${READ_TOKEN}`,
    );
    expect(tokenVerifyCalls[1].options.headers.authorization).toBe(
      `Bearer ${DEPLOY_TOKEN}`,
    );
    const deploymentPost = calls.find(
      ({ options }) => options.method === "POST",
    );
    expect(deploymentPost.options.headers.authorization).toBe(
      `Bearer ${DEPLOY_TOKEN}`,
    );
    expect(deploymentPost.options.redirect).toBe("error");
    expect(calls.every(({ options }) => options.signal instanceof AbortSignal)).toBe(
      true,
    );
  });

  test("commits no Cloudflare credential state when Authority preflight fails", async () => {
    const anchors = publishedAnchors();
    const transport = createRingTransitionNativeTransport({
      anchors,
      credentialIds: credentialIds(),
      environment: credentialEnvironment(),
      fetchImpl: async (url, options) => {
        if (url.endsWith("/tokens/verify")) {
          const id = options.headers.authorization.includes(READ_TOKEN)
            ? READ_TOKEN_ID
            : DEPLOY_TOKEN_ID;
          return jsonResponse({ success: true, result: { id, status: "active" } });
        }
        const response = authorityPreflightResponse(options, anchors);
        const payload = await response.json();
        payload.authorityVersionId = "authority-version-unreviewed";
        return jsonResponse(payload);
      },
    });

    await expect(transport.verifyCredentialIdentities()).rejects.toThrow(
      /authority_response_identity_mismatch/,
    );
    expect(transport.describe()).toMatchObject({
      readCredentialVerified: false,
      claimCredentialVerified: false,
      deployCredentialVerified: false,
    });
    await expect(
      transport.readDeployment(anchors.controllerServiceName),
    ).rejects.toThrow(/read_credential_not_verified/);
    await expect(
      transport.deployOnce(
        buildCloudflareDeploymentMutationRequest({
          anchors,
          accountId: ACCOUNT_ID,
          serviceName: anchors.controllerServiceName,
          targetVersionId: "controller-version-002",
          authorizationIdSha256: "1".repeat(64),
        }),
      ),
    ).rejects.toThrow(/deploy_credential_not_verified/);
  });

  test("builds an Authority-compatible HMAC without exposing the secret", async () => {
    const calls = [];
    const anchors = publishedAnchors();
    const transport = createRingTransitionNativeTransport({
      anchors,
      credentialIds: credentialIds(),
      environment: credentialEnvironment(),
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        if (url.endsWith("/preflight")) {
          return authorityPreflightResponse(options, anchors);
        }
        return authoritySuccessResponse(
          options,
          anchors,
          { result: "exact_claim", snapshot: {} },
        );
      },
      clockImpl: () => new Date("2026-07-23T10:00:00.000Z"),
      requestIdFactory: sequentialRequestIds([
        "runner-request-preflight",
        "runner-request-read",
      ]),
    });
    await transport.preflightAuthority();
    const request = buildClaimAuthorityReadRequest({
      anchors,
      authorizationIdSha256: "1".repeat(64),
      claimDigestSha256: "2".repeat(64),
      claimOwnerSha256: "3".repeat(64),
      authorityToken: "placeholder.".padEnd(64, "x"),
    });
    const result = await transport.sendAuthorityRequest(request);
    expect(result.transportOutcome).toBe("success");
    expect(calls).toHaveLength(2);
    const token = calls[1].options.headers[RING_TRANSITION_AUTHORITY_HEADER];
    const [headerPart, claimsPart, signaturePart] = token.split(".");
    expect(JSON.parse(Buffer.from(headerPart, "base64url").toString())).toEqual({
      alg: "HS256",
      kid: anchors.claimAuthorityHmacKeyId,
      typ: "CINATOKEN-RING-AUTHORITY",
    });
    expect(JSON.parse(Buffer.from(claimsPart, "base64url").toString())).toMatchObject({
      issuer: anchors.claimAuthorityIssuer,
      audience: anchors.claimAuthorityAudience,
      credential_id_sha256: CLAIM_CREDENTIAL_ID,
      request_id: "runner-request-read",
      method: "GET",
      path_and_query: new URL(request.url).pathname + new URL(request.url).search,
    });
    expect(Buffer.from(signaturePart, "base64url")).toHaveLength(32);
    expect(token).not.toContain(CLAIM_SECRET);
    expect(calls[1].options.redirect).toBe("error");
  });

  test("treats Authority outcome_unknown as ambiguous without a second POST", async () => {
    const calls = [];
    const anchors = publishedAnchors();
    const transport = createRingTransitionNativeTransport({
      anchors,
      credentialIds: credentialIds(),
      environment: credentialEnvironment(),
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        if (url.endsWith("/preflight")) {
          return authorityPreflightResponse(options, anchors);
        }
        return jsonResponse(
          { error: "outcome_unknown", outcomeUnknown: true },
          503,
        );
      },
      requestIdFactory: () => "runner-request-ambiguous",
    });
    await transport.preflightAuthority();
    const request = {
      method: "POST",
      url: `${anchors.claimAuthorityOrigin}/internal/v1/ring-transition/claims/${"1".repeat(64)}/steps`,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        [RING_TRANSITION_AUTHORITY_HEADER]: "placeholder.".padEnd(64, "x"),
      },
      body: "{}",
      retry: false,
      timeoutMilliseconds: 10_000,
      maximumResponseBytes: 256 * 1024,
    };
    expect(await transport.sendAuthorityRequest(request)).toMatchObject({
      transportOutcome: "ambiguous",
      httpStatus: 503,
      outcomeUnknown: true,
      retry: false,
    });
    expect(calls.filter(({ options }) => options.method === "POST")).toHaveLength(1);
  });

  test("pins Authority version and permit SPKI before claim traffic", async () => {
    const anchors = publishedAnchors();
    for (const drift of ["authority_version", "permit_spki"]) {
      const transport = createRingTransitionNativeTransport({
        anchors,
        credentialIds: credentialIds(),
        environment: credentialEnvironment(),
        fetchImpl: async (_url, options) => {
          const response = authorityPreflightResponse(options, anchors);
          const payload = await response.json();
          if (drift === "authority_version") {
            payload.authorityVersionId = "authority-version-unreviewed";
          } else {
            payload.permitSpkiSha256 = "f".repeat(64);
          }
          return jsonResponse(payload);
        },
      });
      await expect(transport.preflightAuthority()).rejects.toThrow(
        /authority_(?:response_identity|preflight_identity)_mismatch/,
      );
    }
  });

  test("classifies one POST response loss as ambiguous and never retries", async () => {
    const anchors = publishedAnchors();
    const calls = [];
    const transport = createRingTransitionNativeTransport({
      anchors,
      credentialIds: credentialIds(),
      environment: credentialEnvironment(),
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        if (url.endsWith("/tokens/verify")) {
          const id = options.headers.authorization.includes(READ_TOKEN)
            ? READ_TOKEN_ID
            : DEPLOY_TOKEN_ID;
          return jsonResponse({ success: true, result: { id, status: "active" } });
        }
        if (url.endsWith("/preflight")) {
          return authorityPreflightResponse(options, anchors);
        }
        throw new Error("controlled response loss");
      },
    });
    await transport.verifyCredentialIdentities();
    const mutation = buildCloudflareDeploymentMutationRequest({
      anchors,
      accountId: ACCOUNT_ID,
      serviceName: anchors.edgeServiceName,
      targetVersionId: "edge-version-002",
      authorizationIdSha256: "1".repeat(64),
    });
    const result = await transport.deployOnce(mutation);
    expect(result).toEqual({
      transportOutcome: "ambiguous",
      httpStatus: null,
      payload: null,
      responseBodySha256: null,
      responseIdSha256: null,
      retry: false,
    });
    expect(calls.filter(({ options }) => options.method === "POST")).toHaveLength(1);
  });

  test("rejects HTTP failures and refuses unpinned or oversized requests", async () => {
    const anchors = publishedAnchors();
    const calls = [];
    const transport = createRingTransitionNativeTransport({
      anchors,
      credentialIds: credentialIds(),
      environment: credentialEnvironment(),
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        if (url.endsWith("/tokens/verify")) {
          const id = options.headers.authorization.includes(READ_TOKEN)
            ? READ_TOKEN_ID
            : DEPLOY_TOKEN_ID;
          return jsonResponse({ success: true, result: { id, status: "active" } });
        }
        if (url.endsWith("/preflight")) {
          return authorityPreflightResponse(options, anchors);
        }
        return jsonResponse(
          { success: false, errors: [{ code: 10000 }] },
          403,
        );
      },
    });
    await transport.verifyCredentialIdentities();
    const mutation = buildCloudflareDeploymentMutationRequest({
      anchors,
      accountId: ACCOUNT_ID,
      serviceName: anchors.controllerServiceName,
      targetVersionId: "controller-version-002",
      authorizationIdSha256: "1".repeat(64),
    });
    await expect(
      transport.deployOnce({
        ...mutation,
        url: mutation.url.replace(
          anchors.controllerServiceName,
          "unreviewed-service-staging",
        ),
      }),
    ).rejects.toThrow(/cloudflare_mutation_path_forbidden/);
    expect(await transport.deployOnce(mutation)).toMatchObject({
      transportOutcome: "rejected",
      httpStatus: 403,
      retry: false,
    });
    await expect(
      transport.deployOnce({
        ...mutation,
        body: `${mutation.body}${" ".repeat(20 * 1024)}`,
      }),
    ).rejects.toThrow(/cloudflare_mutation_body_too_large/);
    await expect(
      transport.deployOnce({
        ...mutation,
        requestDigestSha256: "f".repeat(64),
      }),
    ).rejects.toThrow(/cloudflare_mutation_digest_mismatch/);

    const oversizedTransport = createRingTransitionNativeTransport({
      anchors,
      credentialIds: credentialIds(),
      environment: credentialEnvironment(),
      fetchImpl: async () =>
        new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": String(3 * 1024 * 1024),
          },
        }),
    });
    await expect(oversizedTransport.verifyCredentialIdentities()).rejects.toThrow(
      /response_too_large/,
    );
  });

  test("treats throttling, timeout-like statuses, and 5xx as ambiguous", async () => {
    for (const status of [408, 425, 429, 500, 503]) {
      const anchors = publishedAnchors();
      const transport = createRingTransitionNativeTransport({
        anchors,
        credentialIds: credentialIds(),
        environment: credentialEnvironment(),
        fetchImpl: async (url, options) => {
          if (url.endsWith("/tokens/verify")) {
            const id = options.headers.authorization.includes(READ_TOKEN)
              ? READ_TOKEN_ID
              : DEPLOY_TOKEN_ID;
            return jsonResponse({ success: true, result: { id, status: "active" } });
          }
          if (url.endsWith("/preflight")) {
            return authorityPreflightResponse(options, anchors);
          }
          return jsonResponse({ success: false, errors: [{ code: 10000 }] }, status);
        },
      });
      await transport.verifyCredentialIdentities();
      const mutation = buildCloudflareDeploymentMutationRequest({
        anchors,
        accountId: ACCOUNT_ID,
        serviceName: anchors.edgeServiceName,
        targetVersionId: "edge-version-002",
        authorizationIdSha256: "1".repeat(64),
      });
      expect(await transport.deployOnce(mutation)).toMatchObject({
        transportOutcome: "ambiguous",
        httpStatus: status,
        retry: false,
      });
    }
  });
});

function publishedAnchors() {
  const anchors = {
    ...DEPLOYMENT_PINNED_RING_TRANSITION_TRUST,
    enabled: true,
    claimAuthorityOrigin: "https://ring-transition-authority-staging.example.com",
    claimAuthorityVersionId: "authority-version-001",
    claimAuthorityIssuer: "cinatoken-ring-runner-staging",
    claimAuthorityAudience: "cinatoken-ring-transition-authority-staging",
    claimAuthorityHmacKeyId: "claim-hmac-v1",
    claimPermitIssuer: "cinatoken-ring-permit-staging",
    claimPermitKeyId: "permit-v1",
    claimPermitSpkiSha256: "c".repeat(64),
    accountIdSha256: sha256Hex(Buffer.from(ACCOUNT_ID, "utf8")),
    ledgerIdentitySha256: "1".repeat(64),
    transitionPolicySha256: "2".repeat(64),
    authorizationPolicySha256: "3".repeat(64),
    transitionApprovalKeyFingerprintsSha256: ["4".repeat(64), "5".repeat(64)],
    authorizationApprovalKeyFingerprintsSha256: ["6".repeat(64), "7".repeat(64)],
    runnerSourceCommit: "8".repeat(40),
    runnerBuildSha256: "9".repeat(64),
    runnerTrustConfigSha256: "0".repeat(64),
    releaseEvidenceSha256: "a".repeat(64),
  };
  anchors.runnerTrustConfigSha256 =
    ringTransitionTrustConfigDigestSha256(anchors);
  return anchors;
}

function credentialIds() {
  return {
    read: sha256Hex(Buffer.from(READ_TOKEN_ID, "utf8")),
    claim: CLAIM_CREDENTIAL_ID,
    deploy: sha256Hex(Buffer.from(DEPLOY_TOKEN_ID, "utf8")),
  };
}

function credentialEnvironment() {
  return {
    [RING_TRANSITION_TRANSPORT_ENV.accountId]: ACCOUNT_ID,
    [RING_TRANSITION_TRANSPORT_ENV.readToken]: READ_TOKEN,
    [RING_TRANSITION_TRANSPORT_ENV.claimHmacSecret]: CLAIM_SECRET,
    [RING_TRANSITION_TRANSPORT_ENV.deployToken]: DEPLOY_TOKEN,
  };
}

function successfulFetch(calls, anchors) {
  return async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/tokens/verify")) {
      const id = options.headers.authorization.includes(READ_TOKEN)
        ? READ_TOKEN_ID
        : DEPLOY_TOKEN_ID;
      return jsonResponse({ success: true, result: { id, status: "active" } });
    }
    if (url.endsWith("/preflight")) {
      return authorityPreflightResponse(options, anchors);
    }
    if (url.includes("/versions/")) {
      return jsonResponse({
        success: true,
        result: { id: "controller-version-002", compatibility_date: "2026-07-23" },
      });
    }
    if (options.method === "POST") {
      return jsonResponse(
        { success: true, result: { id: "deployment-controller-002" } },
        200,
        { "cf-ray": "test-ray-001" },
      );
    }
    return jsonResponse({
      success: true,
      result: {
        deployments: [
          {
            id: "deployment-controller-002",
            strategy: "percentage",
            versions: [
              { version_id: "controller-version-002", percentage: 100 },
            ],
            annotations: {
              "workers/message":
                "cinatoken staging ring transition 1111111111111111",
            },
          },
        ],
      },
    });
  };
}

function authorityPreflightResponse(options, anchors) {
  return authoritySuccessResponse(options, anchors, {
    result: "authority_ready",
    credentialIdSha256: CLAIM_CREDENTIAL_ID,
    permitSpkiSha256: anchors.claimPermitSpkiSha256,
  });
}

function authoritySuccessResponse(options, anchors, payload) {
  const token = options.headers[RING_TRANSITION_AUTHORITY_HEADER];
  const claims = JSON.parse(
    Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
  );
  return jsonResponse({
    ...payload,
    requestId: claims.request_id,
    authorityVersionId: anchors.claimAuthorityVersionId,
  });
}

function sequentialRequestIds(values) {
  let index = 0;
  return () => values[index++] ?? `unexpected-request-${index}`;
}

function jsonResponse(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}
