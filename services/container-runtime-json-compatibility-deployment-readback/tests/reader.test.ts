import { beforeAll, describe, expect, test, vi } from "vitest";

import type { FetchLike } from "../src/cloudflare";
import {
  READBACK_ENTRYPOINT,
  READBACK_SERVICE_NAME,
  type JsonCompatibilityDeploymentReadbackEnv,
} from "../src/protocol";
import { readDeploymentState } from "../src/reader";
import {
  buildJsonCompatibilityDeploymentTransitionOperation,
  buildJsonCompatibilityDeploymentTransitionReadbackRequest,
  buildJsonCompatibilityDeploymentTransitionSourceAuthentication,
} from "../../../tools/container_runtime_json_compatibility_deployment_transition.mjs";
import { sha256Canonical } from "../src/shared_protocol_adapter.mjs";
import { createSourceAuthenticationFixture } from "./fixture_adapter.mjs";

const TOKEN = "test-read-only-cloudflare-token";

interface Scenario {
  readonly nowMilliseconds: number;
  readonly env: JsonCompatibilityDeploymentReadbackEnv;
  readonly envelope: any;
  readonly expected: any;
  readonly authority: any;
}

let scenario: Scenario;

beforeAll(async () => {
  scenario = await createScenario();
});

describe("deployment readback Reader", () => {
  test("rejects a detached readback request before reading the token or network", async () => {
    const envelope = structuredClone(scenario.envelope);
    envelope.readbackRequest.expected.versionId = "detached-version";
    const tokenRead = vi.fn(() => {
      throw new Error("token must not be read");
    });
    const env = { ...scenario.env } as Record<string, unknown>;
    delete env.CLOUDFLARE_DEPLOYMENT_READ_API_TOKEN;
    Object.defineProperty(env, "CLOUDFLARE_DEPLOYMENT_READ_API_TOKEN", {
      get: tokenRead,
    });
    const fetchImpl = vi.fn(async () => {
      throw new Error("network must not be reached");
    });

    await expect(readDeploymentState(
      env as unknown as JsonCompatibilityDeploymentReadbackEnv,
      envelope,
      {
        fetch: fetchImpl as FetchLike,
        nowMilliseconds: () => scenario.nowMilliseconds,
      },
    )).rejects.toThrow(/readback/);
    expect(tokenRead).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("rejects the legacy six-field envelope before reading the token", async () => {
    const envelope = {
      ...structuredClone(scenario.envelope),
      artifactInventoryReadback: structuredClone(
        scenario.envelope.authorizedTransition.request
          .artifactInventoryReadback,
      ),
    };
    const tokenRead = vi.fn(() => {
      throw new Error("token must not be read");
    });
    const env = { ...scenario.env } as Record<string, unknown>;
    delete env.CLOUDFLARE_DEPLOYMENT_READ_API_TOKEN;
    Object.defineProperty(env, "CLOUDFLARE_DEPLOYMENT_READ_API_TOKEN", {
      get: tokenRead,
    });
    const fetchImpl = vi.fn(async () => {
      throw new Error("network must not be reached");
    });

    await expect(readDeploymentState(
      env as unknown as JsonCompatibilityDeploymentReadbackEnv,
      envelope,
      {
        fetch: fetchImpl as FetchLike,
        nowMilliseconds: () => scenario.nowMilliseconds,
      },
    )).rejects.toThrow(/envelope/);
    expect(tokenRead).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("rejects tracked placeholder identities before reading the token", async () => {
    const tokenRead = vi.fn(() => {
      throw new Error("token must not be read");
    });
    const env = {
      ...scenario.env,
      CLOUDFLARE_ACCOUNT_ID: "0".repeat(32),
      CLOUDFLARE_ACCOUNT_ID_SHA256:
        "84e0c0eafaa95a34c293f278ac52e45ce537bab5e752a00e6959a13ae103b65a",
      CLOUDFLARE_DEPLOYMENT_READ_CREDENTIAL_ID_SHA256: "0".repeat(64),
    } as Record<string, unknown>;
    delete env.CLOUDFLARE_DEPLOYMENT_READ_API_TOKEN;
    Object.defineProperty(env, "CLOUDFLARE_DEPLOYMENT_READ_API_TOKEN", {
      get: tokenRead,
    });
    const fetchImpl = vi.fn(async () => {
      throw new Error("network must not be reached");
    });

    await expect(readDeploymentState(
      env as unknown as JsonCompatibilityDeploymentReadbackEnv,
      scenario.envelope,
      {
        fetch: fetchImpl as FetchLike,
        nowMilliseconds: () => scenario.nowMilliseconds,
      },
    )).rejects.toThrow(/placeholder identity/);
    expect(tokenRead).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("returns a canonical ambiguous v2 readback when the token is absent", async () => {
    const env = { ...scenario.env } as Record<string, unknown>;
    delete env.CLOUDFLARE_DEPLOYMENT_READ_API_TOKEN;
    const fetchImpl = vi.fn(async () => {
      throw new Error("network must not be reached");
    });

    const output = await readDeploymentState(
      env as unknown as JsonCompatibilityDeploymentReadbackEnv,
      scenario.envelope,
      {
        fetch: fetchImpl as FetchLike,
        nowMilliseconds: () => scenario.nowMilliseconds,
      },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(output).toMatchObject({
      schemaVersion: 2,
      contract:
        "cinatoken-container-runtime-json-compatibility-deployment-transition-readback-v2",
      classification: "ambiguous",
      readbackRequestSha256:
        scenario.envelope.readbackRequest.readbackRequestSha256,
      readbackServiceIdentitySha256: scenario.authority.identitySha256,
      authenticationIdentitySha256:
        scenario.authority.credentialIdSha256,
      versionId: null,
      configSha256: null,
      remoteStateSha256: null,
    });
  });

  test("uses only the allowlisted deployment and complete route-read GET paths", async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetchImpl = validFetch(scenario, calls);

    const output = await readDeploymentState(
      scenario.env,
      scenario.envelope,
      {
        fetch: fetchImpl,
        nowMilliseconds: () => scenario.nowMilliseconds,
        timeoutSignal: () => new AbortController().signal,
      },
    );

    const base = "https://api.cloudflare.com/client/v4/accounts/"
      + "cloudflare-account-staging/workers/scripts/"
      + scenario.expected.serviceName;
    expect(calls.map((entry) => entry.url)).toEqual([
      `${base}/deployments`,
      `${base}/versions/${scenario.expected.versionId}`,
      `${base}/subdomain`,
      "https://api.cloudflare.com/client/v4/accounts/"
        + "cloudflare-account-staging/workers/domains",
      "https://api.cloudflare.com/client/v4/zones?"
        + "account.id=cloudflare-account-staging&page=1&per_page=50"
        + "&order=name&direction=asc&match=all",
      "https://api.cloudflare.com/client/v4/zones/zone-001/workers/routes",
    ]);
    for (const call of calls) {
      const headers = new Headers(call.init.headers);
      expect(call.init.method).toBe("GET");
      expect(call.init.redirect).toBe("manual");
      expect(call.init.body).toBeUndefined();
      expect([...headers.keys()].sort()).toEqual(["accept", "authorization"]);
      expect(headers.get("accept")).toBe("application/json");
      expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    }
    expect(output).toMatchObject({
      classification: "observed",
      readbackRequestSha256:
        scenario.envelope.readbackRequest.readbackRequestSha256,
      readbackServiceIdentitySha256: scenario.authority.identitySha256,
      authenticationIdentitySha256:
        scenario.authority.credentialIdSha256,
      accountIdSha256: scenario.expected.accountIdSha256,
      serviceName: scenario.expected.serviceName,
      entrypoint: scenario.expected.entrypoint,
      versionId: scenario.expected.versionId,
      configSha256: scenario.expected.configSha256,
      bindingSetSha256: scenario.expected.bindingSetSha256,
      routeSetSha256: scenario.expected.routeSetSha256,
      workersDev: false,
      previewUrls: false,
    });
    expect(String(output.observationDigestSha256)).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(output)).not.toContain(TOKEN);
  });

  test("classifies a response exceeding the shared 64 KiB budget as ambiguous", async () => {
    const fetchImpl = vi.fn(async () => new Response("x".repeat(65_537), {
      status: 200,
      headers: {
        "cf-ray": "oversize-request-id",
        "content-length": "65537",
        "content-type": "application/json",
      },
    }));

    const output = await readDeploymentState(
      scenario.env,
      scenario.envelope,
      {
        fetch: fetchImpl as FetchLike,
        nowMilliseconds: () => scenario.nowMilliseconds,
      },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(output.classification).toBe("ambiguous");
    expect(output.remoteStateSha256).toBeNull();
  });

  test("does not follow redirects", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: 302,
      headers: {
        "cf-ray": "redirect-request-id",
        location: "https://example.invalid/steal-token",
      },
    }));

    const output = await readDeploymentState(
      scenario.env,
      scenario.envelope,
      {
        fetch: fetchImpl as FetchLike,
        nowMilliseconds: () => scenario.nowMilliseconds,
      },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(output.classification).toBe("ambiguous");
  });

  test("returns ambiguous when the exact-version response drifts", async () => {
    let call = 0;
    const fetchImpl: FetchLike = async () => {
      call += 1;
      if (call === 1) return deploymentsResponse(scenario, "drift-deployments");
      return apiResponse(
        {
          id: "different-version",
          resources: { bindings: [] },
        },
        "drift-version",
      );
    };

    const output = await readDeploymentState(
      scenario.env,
      scenario.envelope,
      {
        fetch: fetchImpl,
        nowMilliseconds: () => scenario.nowMilliseconds,
      },
    );

    expect(call).toBe(2);
    expect(output.classification).toBe("ambiguous");
    expect(output.versionId).toBeNull();
  });

  test("returns observed live subdomain drift instead of echoing expected flags", async () => {
    const fetchImpl = validFetch(scenario, [], {
      subdomain: { enabled: true, previews_enabled: true },
    });

    const output = await readDeploymentState(
      scenario.env,
      scenario.envelope,
      {
        fetch: fetchImpl,
        nowMilliseconds: () => scenario.nowMilliseconds,
      },
    );

    expect(scenario.expected.workersDev).toBe(false);
    expect(scenario.expected.previewUrls).toBe(false);
    expect(output).toMatchObject({
      classification: "observed",
      workersDev: true,
      previewUrls: true,
      readbackServiceIdentitySha256: scenario.authority.identitySha256,
    });
  });

  test.each([
    [
      "custom domain",
      {
        domains: [{
          id: "domain-001",
          zone_id: "zone-001",
          hostname: "api.example.test",
          service: "__TARGET__",
        }],
      },
    ],
    [
      "zone route",
      {
        zoneRoutes: [{
          id: "route-001",
          pattern: "example.test/api/*",
          script: "__TARGET__",
        }],
      },
    ],
  ])("returns observed %s drift from live route inventory", async (_, override) => {
    const prepared = structuredClone(override) as {
      domains?: Array<Record<string, unknown>>;
      zoneRoutes?: Array<Record<string, unknown>>;
    };
    for (const item of [
      ...(prepared.domains ?? []),
      ...(prepared.zoneRoutes ?? []),
    ]) {
      if (item.service === "__TARGET__") {
        item.service = scenario.expected.serviceName;
      }
      if (item.script === "__TARGET__") {
        item.script = scenario.expected.serviceName;
      }
    }
    const output = await readDeploymentState(
      scenario.env,
      scenario.envelope,
      {
        fetch: validFetch(scenario, [], prepared),
        nowMilliseconds: () => scenario.nowMilliseconds,
        timeoutSignal: () => new AbortController().signal,
      },
    );
    expect(output.classification).toBe("observed");
    expect(output.routeSetSha256).not.toBe(scenario.expected.routeSetSha256);
  });
});

async function createScenario(): Promise<Scenario> {
  const fixture = await createSourceAuthenticationFixture();
  const operation = buildJsonCompatibilityDeploymentTransitionOperation({
    campaignPlan: fixture.campaignPlan,
    statePlan: fixture.statePlan,
    authorizedTransition: fixture.authorizedTransition,
  });
  const sourceAuthentication =
    buildJsonCompatibilityDeploymentTransitionSourceAuthentication({
      sourceAuthenticationRequest: fixture.sourceAuthenticationRequest,
      classification: "authenticated",
      reasonCode: null,
      verifierIdentitySha256:
        fixture.sourceAuthenticationRequest.sourceEvidence
          .sourceVerifierIdentitySha256,
      evidenceSha256: sha256Canonical({ fixture: "reader-source-proof" }),
      verifiedAt: fixture.now,
    });
  const transition = fixture.authorizedTransition.request.transition;
  const step = transition.steps[0];
  const artifactKey = step.fromArtifact === "status-only"
    ? "statusOnly"
    : step.fromArtifact;
  const inventory = fixture.bundle.artifactInventoryReadback;
  const artifact = inventory.artifacts.find((entry: any) =>
    entry.role === step.role && entry.artifact === artifactKey);
  if (artifact === undefined) throw new Error("Reader fixture artifact is absent");
  const authority = fixture.authorizedTransition.request.executionAuthority.readback;
  const expected = {
    environment: "staging",
    accountIdSha256: inventory.accountIdSha256,
    serviceName: artifact.serviceName,
    entrypoint: artifact.entrypoint,
    versionId: artifact.versionId,
    configSha256: artifact.configSha256,
    deploymentState: artifact.deploymentState,
    gates: artifact.gates,
    privateRpcOnly: artifact.privateRpcOnly,
    workersDev: artifact.workersDev,
    previewUrls: artifact.previewUrls,
    bindingSetSha256: artifact.bindingSetSha256,
    routeSetSha256: artifact.routeSetSha256,
    secretNameSetSha256: artifact.secretNameSetSha256,
    durableObjectMigrationSetSha256:
      artifact.durableObjectMigrationSetSha256,
    authenticationIdentitySha256: authority.credentialIdSha256,
  };
  const readbackRequest =
    buildJsonCompatibilityDeploymentTransitionReadbackRequest({
      operation,
      sourceAuthenticationDigestSha256:
        sourceAuthentication.sourceAuthenticationDigestSha256,
      transition: { id: transition.id, ordinal: transition.ordinal },
      step,
      phase: "source",
      observationOrdinal: 1,
      expected,
    });
  return {
    nowMilliseconds: fixture.now * 1000,
    envelope: {
      campaignPlan: fixture.campaignPlan,
      statePlan: fixture.statePlan,
      authorizedTransition: fixture.authorizedTransition,
      sourceAuthentication,
      readbackRequest,
    },
    expected,
    authority,
    env: {
      CF_VERSION_METADATA: { id: authority.versionId },
      ENVIRONMENT: "staging",
      JSON_COMPATIBILITY_DEPLOYMENT_READBACK_ENABLED: "true",
      JSON_COMPATIBILITY_DEPLOYMENT_READBACK_PROFILE_VERSION: "1",
      JSON_COMPATIBILITY_DEPLOYMENT_READBACK_SERVICE_NAME:
        READBACK_SERVICE_NAME,
      JSON_COMPATIBILITY_DEPLOYMENT_READBACK_ENTRYPOINT: READBACK_ENTRYPOINT,
      CLOUDFLARE_ACCOUNT_ID: "cloudflare-account-staging",
      CLOUDFLARE_ACCOUNT_ID_SHA256: inventory.accountIdSha256,
      CLOUDFLARE_DEPLOYMENT_READ_CREDENTIAL_ID_SHA256:
        authority.credentialIdSha256,
      CLOUDFLARE_DEPLOYMENT_READ_API_TOKEN: TOKEN,
    },
  };
}

function validFetch(
  current: Scenario,
  calls: Array<{ readonly url: string; readonly init: RequestInit }>,
  overrides: {
    readonly subdomain?: {
      readonly enabled: boolean;
      readonly previews_enabled: boolean;
    };
    readonly domains?: Array<Record<string, unknown>>;
    readonly zoneRoutes?: Array<Record<string, unknown>>;
  } = {},
): FetchLike {
  return async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/deployments")) {
      return deploymentsResponse(current, `request-${calls.length}`);
    }
    if (url.includes("/versions/")) {
      return apiResponse(
        {
          id: current.expected.versionId,
          resources: {
            bindings: [{ name: "_INTERNAL", type: "plain_text" }],
          },
        },
        `request-${calls.length}`,
      );
    }
    if (url.endsWith("/subdomain")) {
      return apiResponse(
        overrides.subdomain
          ?? { enabled: false, previews_enabled: false },
        `request-${calls.length}`,
      );
    }
    if (url.endsWith("/workers/domains")) {
      const domains = overrides.domains ?? [];
      return apiResponse(
        domains,
        `request-${calls.length}`,
        {
          page: 1,
          per_page: 100,
          count: domains.length,
          total_count: domains.length,
          total_pages: 1,
        },
      );
    }
    if (url.includes("/client/v4/zones?")) {
      return apiResponse(
        [{ id: "zone-001", account: { id: "cloudflare-account-staging" } }],
        `request-${calls.length}`,
        {
          page: 1,
          per_page: 50,
          count: 1,
          total_count: 1,
          total_pages: 1,
        },
      );
    }
    if (url.endsWith("/zones/zone-001/workers/routes")) {
      return apiResponse(
        overrides.zoneRoutes ?? [],
        `request-${calls.length}`,
      );
    }
    throw new Error(`unexpected test URL: ${url}`);
  };
}

function deploymentsResponse(current: Scenario, requestId: string): Response {
  return apiResponse({
    deployments: [{
      id: "deployment-2026-08",
      created_on: "2026-08-06T00:00:00.000Z",
      strategy: "percentage",
      versions: [{
        version_id: current.expected.versionId,
        percentage: 100,
      }],
    }],
  }, requestId);
}

function apiResponse(
  result: unknown,
  requestId: string,
  resultInfo?: Record<string, unknown>,
): Response {
  return new Response(JSON.stringify({
    success: true,
    errors: [],
    messages: [],
    result,
    ...(resultInfo === undefined ? {} : { result_info: resultInfo }),
  }), {
    status: 200,
    headers: {
      "cf-ray": requestId,
      "content-type": "application/json; charset=utf-8",
    },
  });
}
