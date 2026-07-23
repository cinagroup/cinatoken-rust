import { describe, expect, test } from "bun:test";

import {
  DEPLOYMENT_PINNED_RING_TRANSITION_TRUST,
  buildClaimAuthorityReadRequest,
  buildClaimAuthorityStepRequest,
  buildCloudflareDeploymentMutationRequest,
  ringTransitionTrustConfigDigestSha256,
  validatePublishedRingTransitionTrust,
} from "../tools/relay_container_ring_transition_execution_contract.mjs";
import {
  RING_TRANSITION_AUTHORITY_HEADER,
} from "../tools/relay_container_ring_transition_execution_contract.mjs";
import {
  RING_TRANSITION_TRANSPORT_ENV,
  createRingTransitionAuthorityToken,
  createRingTransitionNativeTransport,
  describeRingTransitionNativeTransport,
} from "../tools/relay_container_ring_transition_native_transport.mjs";
import {
  canonicalJson,
  sha256Hex,
} from "../tools/relay_container_p5_evidence_contract.mjs";

const ACCOUNT_ID = "a".repeat(32);
const READ_TOKEN = "read-token-value-0000000000000001";
const CLAIM_SECRET = "claim-hmac-secret-00000000000001";
const DEPLOY_TOKEN = "deploy-token-value-00000000000001";
const READ_TOKEN_ID = "read-token-identity-v1";
const DEPLOY_TOKEN_ID = "deploy-token-identity-v1";
const CLAIM_CREDENTIAL_ID = "b".repeat(64);
const RUST_HMAC_VECTOR =
  "eyJhbGciOiJIUzI1NiIsImtpZCI6ImN1cnJlbnQtdjEiLCJ0eXAiOiJDSU5BVE9LRU4tUklORy1BVVRIT1JJVFkifQ.eyJhdWRpZW5jZSI6ImF1dGhvcml0eS1zdGFnaW5nIiwiYm9keV9zaGEyNTYiOiJlM2IwYzQ0Mjk4ZmMxYzE0OWFmYmY0Yzg5OTZmYjkyNDI3YWU0MWU0NjQ5YjkzNGNhNDk1OTkxYjc4NTJiODU1IiwiY3JlZGVudGlhbF9pZF9zaGEyNTYiOiJhMDFiZmVmZDZhMjVkOTEwN2U5NDcyODA5OTczMDUyYTdlM2YwOTI2NjYxNmVhZTJkZTBhZTVjZjA5ZmIyYmYzIiwiZXhwaXJlc19hdCI6MTgwMDAwMDAzMCwiaXNzdWVkX2F0IjoxODAwMDAwMDAwLCJpc3N1ZXIiOiJydW5uZXItc3RhZ2luZyIsIm1ldGhvZCI6IkdFVCIsInBhdGhfYW5kX3F1ZXJ5IjoiL2ludGVybmFsL3YxL3JpbmctdHJhbnNpdGlvbi9wcmVmbGlnaHQiLCJyZXF1ZXN0X2lkIjoicmVxdWVzdC0xIn0.ar2B2dDPZLGvIOwK930i5TOHmv8EBKgF1HQWowJxq2c";

describe("Relay Container native ring-transition transport", () => {
  test("matches the Rust and Authority fixed HMAC vector", async () => {
    const token = await createRingTransitionAuthorityToken({
      request: {
        method: "GET",
        url:
          "https://ring-transition-authority-staging.cinatoken.com" +
          "/internal/v1/ring-transition/preflight",
        headers: { accept: "application/json" },
        body: null,
      },
      issuer: "runner-staging",
      audience: "authority-staging",
      keyId: "current-v1",
      credentialIdSha256:
        "a01bfefd6a25d9107e9472809973052a7e3f09266616eae2de0ae5cf09fb2bf3",
      secret: "0123456789abcdef0123456789abcdef",
      now: new Date(1_800_000_000_000),
      requestId: "request-1",
    });
    expect(token).toBe(RUST_HMAC_VECTOR);
  });

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
      claimCredentialVerified: false,
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

  test("matches Authority HMAC key ID and UTF-8 secret boundaries", async () => {
    const validAnchors = publishedAnchors({
      claimAuthorityHmacKeyId: "k".repeat(32),
    });
    const calls = [];
    const transport = createRingTransitionNativeTransport({
      anchors: validAnchors,
      credentialIds: credentialIds(),
      environment: {
        ...credentialEnvironment(),
        [RING_TRANSITION_TRANSPORT_ENV.claimHmacSecret]: "\u00e9".repeat(16),
      },
      fetchImpl: successfulFetch(calls, validAnchors),
    });
    await expect(transport.verifyCredentialIdentities()).resolves.toMatchObject({
      allCredentialsVerified: true,
    });
    const preflightCall = calls.find(({ url }) => url.endsWith("/preflight"));
    const token =
      preflightCall.options.headers[RING_TRANSITION_AUTHORITY_HEADER];
    const header = JSON.parse(
      Buffer.from(token.split(".")[0], "base64url").toString("utf8"),
    );
    expect(header.kid).toBe("k".repeat(32));

    expect(() =>
      createRingTransitionNativeTransport({
        anchors: validAnchors,
        credentialIds: credentialIds(),
        environment: {
          ...credentialEnvironment(),
          [RING_TRANSITION_TRANSPORT_ENV.claimHmacSecret]: "s".repeat(4096),
        },
      }),
    ).not.toThrow();

    for (const claimHmacSecret of [
      "s".repeat(31),
      "s".repeat(4097),
      `${"s".repeat(31)} `,
    ]) {
      expect(() =>
        createRingTransitionNativeTransport({
          anchors: validAnchors,
          credentialIds: credentialIds(),
          environment: {
            ...credentialEnvironment(),
            [RING_TRANSITION_TRANSPORT_ENV.claimHmacSecret]: claimHmacSecret,
          },
        }),
      ).toThrow(/missing_or_invalid_cinatoken_ring_transition_claim_hmac_secret/);
    }

    expect(() =>
      createRingTransitionNativeTransport({
        anchors: publishedAnchors({
          claimAuthorityHmacKeyId: "k".repeat(33),
        }),
        credentialIds: credentialIds(),
        environment: credentialEnvironment(),
      }),
    ).toThrow(/invalid_hmac_key_id/);
  });

  test("keeps preflight private and blocks claim traffic before all proofs", async () => {
    const anchors = publishedAnchors();
    const calls = [];
    const transport = createRingTransitionNativeTransport({
      anchors,
      credentialIds: credentialIds(),
      environment: credentialEnvironment(),
      fetchImpl: async (...args) => {
        calls.push(args);
        throw new Error("network must remain blocked");
      },
    });
    expect(transport.preflightAuthority).toBeUndefined();

    await expect(
      transport.sendAuthorityRequest({
        method: "GET",
        url: `${anchors.claimAuthorityOrigin}/internal/v1/ring-transition/preflight`,
        headers: { accept: "application/json" },
        body: null,
        retry: false,
        timeoutMilliseconds: 10_000,
        maximumResponseBytes: 256 * 1024,
      }),
    ).rejects.toThrow(/authority_preflight_private/);
    await expect(
      transport.sendAuthorityRequest(
        buildClaimAuthorityReadRequest({
          anchors,
          authorizationIdSha256: "1".repeat(64),
          claimDigestSha256: "2".repeat(64),
          claimOwnerSha256: "3".repeat(64),
          authorityToken: "placeholder.".padEnd(64, "x"),
        }),
      ),
    ).rejects.toThrow(/claim_credential_not_verified/);
    expect(calls).toHaveLength(0);
  });

  test("snapshots and freezes validated trust before caller mutation", async () => {
    const anchors = publishedAnchors();
    const snapshot = validatePublishedRingTransitionTrust(anchors);
    expect(snapshot).not.toBe(anchors);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(
      Object.isFrozen(snapshot.transitionApprovalKeyFingerprintsSha256),
    ).toBe(true);

    const calls = [];
    const expectedAnchors = publishedAnchors();
    const transport = createRingTransitionNativeTransport({
      anchors,
      credentialIds: credentialIds(),
      environment: credentialEnvironment(),
      fetchImpl: successfulFetch(calls, expectedAnchors),
    });
    anchors.controllerServiceName = "unreviewed-service-staging";
    anchors.transitionApprovalKeyFingerprintsSha256[0] = "f".repeat(64);

    await transport.verifyCredentialIdentities();
    await expect(
      transport.readDeployment(expectedAnchors.controllerServiceName),
    ).resolves.toMatchObject({
      serviceName: expectedAnchors.controllerServiceName,
    });
    await expect(
      transport.readDeployment(anchors.controllerServiceName),
    ).rejects.toThrow(/service_outside_pinned_ring/);
    expect(calls.some(({ url }) => url.includes("unreviewed-service"))).toBe(
      false,
    );

    const getterAnchors = publishedAnchors();
    const stableOrigin = getterAnchors.claimAuthorityOrigin;
    let reads = 0;
    Object.defineProperty(getterAnchors, "claimAuthorityOrigin", {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? stableOrigin : "https://drift.invalid";
      },
    });
    const getterSnapshot =
      validatePublishedRingTransitionTrust(getterAnchors);
    expect(getterSnapshot.claimAuthorityOrigin).toBe(stableOrigin);
    expect(reads).toBe(1);
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

    const authorized = await authorizeMutation(
      transport,
      anchors,
      "controller",
    );
    const result = await transport.deployOnce(authorized);
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
      ({ url, options }) =>
        options.method === "POST" && url.startsWith("https://api.cloudflare.com"),
    );
    expect(deploymentPost.options.headers.authorization).toBe(
      `Bearer ${DEPLOY_TOKEN}`,
    );
    expect(deploymentPost.options.redirect).toBe("error");
    expect(calls.every(({ options }) => options.signal instanceof AbortSignal)).toBe(
      true,
    );
  });

  test("clears every proof after read, deploy, or preflight revalidation failure", async () => {
    for (const failure of ["read", "deploy", "preflight"]) {
      const anchors = publishedAnchors();
      let failRevalidation = false;
      const transport = createRingTransitionNativeTransport({
        anchors,
        credentialIds: credentialIds(),
        environment: credentialEnvironment(),
        fetchImpl: async (url, options) => {
          if (url.endsWith("/tokens/verify")) {
            const credentialClass = options.headers.authorization.includes(
              READ_TOKEN,
            )
              ? "read"
              : "deploy";
            const id =
              failRevalidation && failure === credentialClass
                ? "unreviewed-token-identity"
                : credentialClass === "read"
                  ? READ_TOKEN_ID
                  : DEPLOY_TOKEN_ID;
            return jsonResponse({
              success: true,
              result: { id, status: "active" },
            });
          }
          const response = authorityPreflightResponse(options, anchors);
          const payload = await response.json();
          if (failRevalidation && failure === "preflight") {
            payload.authorityVersionId = "authority-version-unreviewed";
          }
          return jsonResponse(payload);
        },
      });

      await transport.verifyCredentialIdentities();
      expect(transport.describe()).toMatchObject({
        readCredentialVerified: true,
        claimCredentialVerified: true,
        deployCredentialVerified: true,
      });

      failRevalidation = true;
      await expect(transport.verifyCredentialIdentities()).rejects.toThrow(
        failure === "preflight"
          ? /authority_response_identity_mismatch/
          : new RegExp(`${failure}_credential_identity_mismatch`),
      );
      expect(transport.describe()).toMatchObject({
        readCredentialVerified: false,
        claimCredentialVerified: false,
        deployCredentialVerified: false,
      });
      await expect(
        transport.readDeployment(anchors.controllerServiceName),
      ).rejects.toThrow(/read_credential_not_verified/);
      await expect(transport.deployOnce({})).rejects.toThrow(
        /deploy_credential_not_verified/,
      );
      await expect(
        transport.sendAuthorityRequest(
          buildClaimAuthorityReadRequest({
            anchors,
            authorizationIdSha256: "1".repeat(64),
            claimDigestSha256: "2".repeat(64),
            claimOwnerSha256: "3".repeat(64),
            authorityToken: "placeholder.".padEnd(64, "x"),
          }),
        ),
      ).rejects.toThrow(/claim_credential_not_verified/);
    }
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
        if (url.endsWith("/tokens/verify")) {
          const id = options.headers.authorization.includes(READ_TOKEN)
            ? READ_TOKEN_ID
            : DEPLOY_TOKEN_ID;
          return jsonResponse({ success: true, result: { id, status: "active" } });
        }
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
    await transport.verifyCredentialIdentities();
    const request = buildClaimAuthorityReadRequest({
      anchors,
      authorizationIdSha256: "1".repeat(64),
      claimDigestSha256: "2".repeat(64),
      claimOwnerSha256: "3".repeat(64),
      authorityToken: "placeholder.".padEnd(64, "x"),
    });
    const result = await transport.sendAuthorityRequest(request);
    expect(result.transportOutcome).toBe("success");
    expect(calls).toHaveLength(4);
    const authorityCall = calls.at(-1);
    const token =
      authorityCall.options.headers[RING_TRANSITION_AUTHORITY_HEADER];
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
    expect(authorityCall.options.redirect).toBe("error");
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
          { error: "outcome_unknown", outcomeUnknown: true },
          503,
        );
      },
      requestIdFactory: () => "runner-request-ambiguous",
    });
    await transport.verifyCredentialIdentities();
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
        fetchImpl: async (url, options) => {
          if (url.endsWith("/tokens/verify")) {
            const id = options.headers.authorization.includes(READ_TOKEN)
              ? READ_TOKEN_ID
              : DEPLOY_TOKEN_ID;
            return jsonResponse({
              success: true,
              result: { id, status: "active" },
            });
          }
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
      await expect(transport.verifyCredentialIdentities()).rejects.toThrow(
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
        if (url.endsWith("/steps")) {
          return authorityStepAppendResponse(url, options, anchors);
        }
        throw new Error("controlled response loss");
      },
    });
    await transport.verifyCredentialIdentities();
    const authorized = await authorizeMutation(transport, anchors, "edge");
    const result = await transport.deployOnce(authorized);
    expect(result).toEqual({
      transportOutcome: "ambiguous",
      httpStatus: null,
      payload: null,
      responseBodySha256: null,
      responseIdSha256: null,
      retry: false,
    });
    expect(
      calls.filter(
        ({ url, options }) =>
          options.method === "POST" && url.startsWith("https://api.cloudflare.com"),
      ),
    ).toHaveLength(1);
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
        if (url.endsWith("/steps")) {
          return authorityStepAppendResponse(url, options, anchors);
        }
        return jsonResponse(
          { success: false, errors: [{ code: 10000 }] },
          403,
        );
      },
    });
    await transport.verifyCredentialIdentities();
    let authorized = await authorizeMutation(
      transport,
      anchors,
      "controller",
    );
    await expect(
      transport.deployOnce({
        ...authorized,
        request: {
          ...authorized.request,
          url: authorized.request.url.replace(
            anchors.controllerServiceName,
            "unreviewed-service-staging",
          ),
        },
      }),
    ).rejects.toThrow(/cloudflare_mutation_path_forbidden/);
    authorized = await authorizeMutation(transport, anchors, "controller");
    expect(await transport.deployOnce(authorized)).toMatchObject({
      transportOutcome: "rejected",
      httpStatus: 403,
      retry: false,
    });
    authorized = await authorizeMutation(transport, anchors, "controller");
    await expect(
      transport.deployOnce({
        ...authorized,
        request: {
          ...authorized.request,
          body: `${authorized.request.body}${" ".repeat(20 * 1024)}`,
        },
      }),
    ).rejects.toThrow(/cloudflare_mutation_body_too_large/);
    authorized = await authorizeMutation(transport, anchors, "controller");
    await expect(
      transport.deployOnce({
        ...authorized,
        request: {
          ...authorized.request,
          requestDigestSha256: "f".repeat(64),
        },
      }),
    ).rejects.toThrow(/mutation_request_not_authorized/);

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

  test("binds a fresh Authority intent to one exact deployment request", async () => {
    const anchors = publishedAnchors();
    const calls = [];
    const transport = createRingTransitionNativeTransport({
      anchors,
      credentialIds: credentialIds(),
      environment: credentialEnvironment(),
      fetchImpl: successfulFetch(calls, anchors),
    });
    await transport.verifyCredentialIdentities();

    let authorized = await authorizeMutation(transport, anchors, "controller");
    const changedBody = JSON.parse(authorized.request.body);
    changedBody.versions[0].version_id = "controller-version-unapproved";
    const changedBodyText = canonicalJson(changedBody);
    await expect(
      transport.deployOnce({
        ...authorized,
        request: {
          ...authorized.request,
          body: changedBodyText,
          requestDigestSha256: sha256Hex(
            Buffer.from(changedBodyText, "utf8"),
          ),
        },
      }),
    ).rejects.toThrow(/mutation_request_not_authorized/);
    expect(cloudflareDeploymentPosts(calls)).toHaveLength(0);

    authorized = await authorizeMutation(transport, anchors, "controller");
    await expect(transport.deployOnce(authorized)).resolves.toMatchObject({
      transportOutcome: "success",
    });
    await expect(transport.deployOnce(authorized)).rejects.toThrow(
      /fresh_intent_permit_required/,
    );
    expect(cloudflareDeploymentPosts(calls)).toHaveLength(1);
  });

  test("a replayed Authority intent never creates a mutation capability", async () => {
    const anchors = publishedAnchors();
    const calls = [];
    const baseFetch = successfulFetch(calls, anchors);
    const transport = createRingTransitionNativeTransport({
      anchors,
      credentialIds: credentialIds(),
      environment: credentialEnvironment(),
      fetchImpl: async (url, options) => {
        if (url.endsWith("/steps")) {
          calls.push({ url, options });
          return authorityStepAppendResponse(
            url,
            options,
            anchors,
            "step_replayed",
          );
        }
        return baseFetch(url, options);
      },
    });
    await transport.verifyCredentialIdentities();
    const authorization = mutationAuthorization(anchors, "edge");
    const result = await transport.sendAuthorityRequest(
      authorization.authorityRequest,
    );
    expect(result).toMatchObject({
      transportOutcome: "success",
      payload: { result: "step_replayed" },
    });
    expect(result.freshIntentPermit).toBeUndefined();
    await expect(
      transport.deployOnce({
        claim: authorization.claim,
        freshIntentPermit: {},
        request: authorization.request,
      }),
    ).rejects.toThrow(/fresh_intent_permit_required/);
    expect(cloudflareDeploymentPosts(calls)).toHaveLength(0);
  });

  test("spends a fresh intent without sending when the claim expires", async () => {
    const anchors = publishedAnchors();
    const calls = [];
    let clock = new Date();
    const transport = createRingTransitionNativeTransport({
      anchors,
      credentialIds: credentialIds(),
      environment: credentialEnvironment(),
      fetchImpl: successfulFetch(calls, anchors),
      clockImpl: () => clock,
    });
    await transport.verifyCredentialIdentities();
    const authorized = await authorizeMutation(
      transport,
      anchors,
      "controller",
    );
    clock = new Date(authorized.claim.expiresAt * 1000);
    await expect(transport.deployOnce(authorized)).rejects.toThrow(
      /mutation_claim_expired/,
    );
    await expect(transport.deployOnce(authorized)).rejects.toThrow(
      /fresh_intent_permit_required/,
    );
    expect(cloudflareDeploymentPosts(calls)).toHaveLength(0);
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
          if (url.endsWith("/steps")) {
            return authorityStepAppendResponse(url, options, anchors);
          }
          return jsonResponse({ success: false, errors: [{ code: 10000 }] }, status);
        },
      });
      await transport.verifyCredentialIdentities();
      const authorized = await authorizeMutation(transport, anchors, "edge");
      expect(await transport.deployOnce(authorized)).toMatchObject({
        transportOutcome: "ambiguous",
        httpStatus: status,
        retry: false,
      });
    }
  });
});

function publishedAnchors(overrides = {}) {
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
    ...overrides,
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

async function authorizeMutation(transport, anchors, phase) {
  const authorization = mutationAuthorization(anchors, phase);
  const result = await transport.sendAuthorityRequest(
    authorization.authorityRequest,
  );
  expect(result.transportOutcome).toBe("success");
  expect(result.freshIntentPermit).toBeDefined();
  return {
    claim: authorization.claim,
    freshIntentPermit: result.freshIntentPermit,
    request: authorization.request,
  };
}

function mutationAuthorization(anchors, phase) {
  const claim = mutationClaim(anchors);
  const stateVersion = phase === "controller" ? 2 : 5;
  const request = buildCloudflareDeploymentMutationRequest({
    anchors,
    accountId: ACCOUNT_ID,
    claim,
    phase,
    stateVersion,
  });
  const unsignedStep = {
    schemaVersion: 1,
    contract: "cinatoken-relay-container-ring-transition-execution-step-v1",
    ledgerIdentitySha256: claim.ledgerIdentitySha256,
    claimDigestSha256: claim.claimDigestSha256,
    stateVersion,
    stepCode: `${phase}_mutation_intent`,
    fromStatus: phase === "controller" ? "t1_verified" : "edge_prechecked",
    toStatus: phase === "controller" ? "controller_inflight" : "edge_inflight",
    mutationRequestSha256: request.requestDigestSha256,
    cloudflareRequestIdSha256: null,
    deploymentSetSha256: null,
    evidenceSha256: "d".repeat(64),
    failureClass: "",
    transportOutcome: "not_applicable",
  };
  const step = {
    ...unsignedStep,
    stepDigestSha256: sha256Hex(
      Buffer.from(canonicalJson(unsignedStep), "utf8"),
    ),
  };
  return {
    claim,
    request,
    authorityRequest: buildClaimAuthorityStepRequest({
      anchors,
      authorizationIdSha256: claim.authorizationIdSha256,
      step,
      authorityToken: "placeholder.".padEnd(64, "x"),
    }),
  };
}

function mutationClaim(anchors) {
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    schemaVersion: 1,
    contract: "cinatoken-relay-container-ring-transition-execution-claim-v1",
    claimAuthority: "d1-unique-claim-v1",
    claimScope: "staging-worker-ring-transition",
    environment: "staging",
    authorizationIdSha256: "1".repeat(64),
    executionNonceSha256: "2".repeat(64),
    authorizationManifestSha256: "3".repeat(64),
    authorizationSubjectSha256: "4".repeat(64),
    authorizationPolicySha256: anchors.authorizationPolicySha256,
    transitionManifestSha256: "5".repeat(64),
    transitionSubjectSha256: "6".repeat(64),
    transitionPolicySha256: anchors.transitionPolicySha256,
    transitionPlanSha256: "7".repeat(64),
    candidateSha256: "8".repeat(64),
    executionPlanSha256: "9".repeat(64),
    accountIdSha256: anchors.accountIdSha256,
    ledgerIdentitySha256: anchors.ledgerIdentitySha256,
    readCredentialIdSha256: credentialIds().read,
    claimCredentialIdSha256: credentialIds().claim,
    deployCredentialIdSha256: credentialIds().deploy,
    controller: {
      serviceName: anchors.controllerServiceName,
      previousVersionId: "controller-version-001",
      previousDeploymentSetSha256: "a".repeat(64),
      targetVersionId: "controller-version-002",
    },
    edge: {
      serviceName: anchors.edgeServiceName,
      previousVersionId: "edge-version-001",
      previousDeploymentSetSha256: "b".repeat(64),
      targetVersionId: "edge-version-002",
    },
    runnerBuildSha256: anchors.runnerBuildSha256,
    runnerTrustConfigSha256: anchors.runnerTrustConfigSha256,
    claimOwnerSha256: "c".repeat(64),
    generatedAt: now - 1,
    expiresAt: now + 299,
  };
  return {
    ...claim,
    claimDigestSha256: sha256Hex(
      Buffer.from(canonicalJson(claim), "utf8"),
    ),
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
    if (url.endsWith("/steps")) {
      return authorityStepAppendResponse(url, options, anchors);
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

function cloudflareDeploymentPosts(calls) {
  return calls.filter(
    ({ url, options }) =>
      options.method === "POST" &&
      url.startsWith("https://api.cloudflare.com/") &&
      url.endsWith("/deployments"),
  );
}

function authorityStepAppendResponse(url, options, anchors, result = "step_appended") {
  const step = JSON.parse(options.body);
  const authorizationIdSha256 = new URL(url).pathname.split("/").at(-2);
  return authoritySuccessResponse(
    options,
    anchors,
    {
      result,
      authorizationIdSha256,
      claimDigestSha256: step.claimDigestSha256,
      status: step.toStatus,
      stateVersion: step.stateVersion,
      stepDigestSha256: step.stepDigestSha256,
    },
    result === "step_appended" ? 201 : 200,
  );
}

function authorityPreflightResponse(options, anchors) {
  return authoritySuccessResponse(options, anchors, {
    result: "authority_ready",
    credentialIdSha256: CLAIM_CREDENTIAL_ID,
    permitSpkiSha256: anchors.claimPermitSpkiSha256,
  });
}

function authoritySuccessResponse(options, anchors, payload, status = 200) {
  const token = options.headers[RING_TRANSITION_AUTHORITY_HEADER];
  const claims = JSON.parse(
    Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
  );
  return jsonResponse(
    {
      ...payload,
      requestId: claims.request_id,
      authorityVersionId: anchors.claimAuthorityVersionId,
    },
    status,
  );
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
