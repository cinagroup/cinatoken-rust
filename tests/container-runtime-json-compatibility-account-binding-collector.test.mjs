import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import {
  sha256Canonical,
} from "../tools/container_runtime_json_compatibility_campaign.mjs";
import {
  buildJsonCompatibilityAccountBindingCollectionProfile,
} from "../tools/container_runtime_json_compatibility_account_binding_evidence.mjs";
import {
  collectJsonCompatibilityAccountBindingArtifact,
  finalizeJsonCompatibilityAccountBindingEvidence,
  normalizeVersionDetail,
} from "../tools/lib/container_runtime_json_compatibility_account_binding_collector.mjs";
import {
  createSourceAuthenticationFixture,
} from "./fixtures/container-runtime-json-compatibility-source-authentication.mjs";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const COLLECTION_TOKEN = "collection-read-token-fixture-0001";
const READBACK_TOKEN = "readback-read-token-fixture-0002";
const COLLECTION_TOKEN_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const READBACK_TOKEN_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ZONE_ID = "cccccccccccccccccccccccccccccccc";

describe("JSON compatibility account binding Cloudflare collector", () => {
  test("enumerates all read-only resource families twice and finalizes evidence", async () => {
    const fixture = await collectorFixture();
    const collectionTransport = fakeCloudflareTransport(fixture, {
      token: COLLECTION_TOKEN,
      tokenId: COLLECTION_TOKEN_ID,
    });
    const collectionPages = [];
    const collection = await collectJsonCompatibilityAccountBindingArtifact({
      ...fixture.inputs,
      mode: "collection",
      accountId: ACCOUNT_ID,
      apiToken: COLLECTION_TOKEN,
      rawPageSink: async (page) => collectionPages.push(page),
      fetchImpl: collectionTransport.fetch,
      clock: () => fixture.now,
      monotonicClock: () => 0,
    });

    const readbackTransport = fakeCloudflareTransport(fixture, {
      token: READBACK_TOKEN,
      tokenId: READBACK_TOKEN_ID,
    });
    const readbackPages = [];
    const independentReadback =
      await collectJsonCompatibilityAccountBindingArtifact({
        ...fixture.inputs,
        mode: "independent-readback",
        accountId: ACCOUNT_ID,
        apiToken: READBACK_TOKEN,
        rawPageSink: async (page) => readbackPages.push(page),
        fetchImpl: readbackTransport.fetch,
        clock: () => fixture.now + 5,
        monotonicClock: () => 0,
      });

    expect(collection.snapshot.accountServiceCount).toBe(10);
    expect(collection.snapshot.accountServiceBindingEdgeCount).toBe(8);
    expect(collection.snapshot.cloudflareApiRequestCount).toBe(35);
    expect(collectionPages).toHaveLength(35);
    expect(collectionTransport.calls).toHaveLength(35);
    expect(readbackPages).toHaveLength(35);
    expect(readbackTransport.calls).toHaveLength(35);
    expect(collectionPages.every((page) => page.body instanceof Uint8Array))
      .toBe(true);
    expect(collection.snapshot.serviceBindingEdges.every(
      (edge) => edge.bindingType === "service",
    )).toBe(true);
    expect(collection.authenticationIdentity.permissionSetSha256).toBe(
      fixture.inputs.collectionProfile.collectionPermissionSetSha256,
    );
    expect(independentReadback.authenticationIdentity.permissionSetSha256)
      .toBe(fixture.inputs.collectionProfile.readbackPermissionSetSha256);
    expect(tokenRequestPaths(collectionTransport.calls)).toEqual([
      `/client/v4/accounts/${ACCOUNT_ID}/tokens/verify`,
    ]);
    expect(tokenRequestPaths(readbackTransport.calls)).toEqual([
      `/client/v4/accounts/${ACCOUNT_ID}/tokens/verify`,
    ]);
    const zoneListUrl = new URL(collectionTransport.calls.find(({ url }) =>
      new URL(url).pathname === "/client/v4/zones").url);
    expect(Object.fromEntries(zoneListUrl.searchParams)).toEqual({
      "account.id": ACCOUNT_ID,
      page: "1",
      per_page: "50",
      order: "name",
      direction: "asc",
      match: "all",
    });

    const finalized = finalizeJsonCompatibilityAccountBindingEvidence({
      campaignPlan: fixture.inputs.campaignPlan,
      statePlan: fixture.inputs.statePlan,
      collectionProfile: fixture.inputs.collectionProfile,
      collection,
      independentReadback,
    });
    expect(finalized.evidence.campaignPrivateRpcOnly).toBe(true);
    expect(finalized.evidence.cloudflareApiRequestCount).toBe(70);
    expect(finalized.inventory.accountServiceCount).toBe(10);
    expect(finalized.inventory.accountBindingInventorySha256).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  test("rejects reflected credentials and never retries a failed response", async () => {
    const fixture = await collectorFixture();
    const transport = fakeCloudflareTransport(fixture, {
      token: COLLECTION_TOKEN,
      tokenId: COLLECTION_TOKEN_ID,
      mutatePayload({ family, payload }) {
        if (family === "workers-scripts") {
          payload.messages.push({ diagnostic: COLLECTION_TOKEN });
        }
      },
    });

    await expect(collectJsonCompatibilityAccountBindingArtifact({
      ...fixture.inputs,
      mode: "collection",
      accountId: ACCOUNT_ID,
      apiToken: COLLECTION_TOKEN,
      rawPageSink: async () => {},
      fetchImpl: transport.fetch,
      clock: () => fixture.now,
      monotonicClock: () => 0,
    })).rejects.toThrow(/cloudflare_api_credential_reflected/);
    expect(transport.calls).toHaveLength(2);
  });

  test("rejects incomplete account-domain pagination", async () => {
    const fixture = await collectorFixture();
    const transport = fakeCloudflareTransport(fixture, {
      token: COLLECTION_TOKEN,
      tokenId: COLLECTION_TOKEN_ID,
      mutatePayload({ family, payload }) {
        if (family === "account-worker-domains") {
          payload.result_info.total_pages = 2;
          payload.result_info.total_count = 1;
        }
      },
    });

    await expect(collectJsonCompatibilityAccountBindingArtifact({
      ...fixture.inputs,
      mode: "collection",
      accountId: ACCOUNT_ID,
      apiToken: COLLECTION_TOKEN,
      rawPageSink: async () => {},
      fetchImpl: transport.fetch,
      clock: () => fixture.now,
      monotonicClock: () => 0,
    })).rejects.toThrow(/single_response_pagination_incomplete/);
    expect(transport.calls).toHaveLength(33);
  });

  test("adds bindingType to normalized service binding edges", () => {
    expect(normalizeVersionDetail({
      id: "fixture-version-1",
      resources: {
        bindings: [{
          type: "service",
          name: "TARGET_SERVICE",
          service: "cinatoken-rust-api-staging",
        }],
      },
    }, "cinatoken-container-egress-staging", "fixture-version-1"))
      .toEqual({
        serviceBindingEdges: [{
          bindingType: "service",
          callerServiceName: "cinatoken-container-egress-staging",
          callerVersionId: "fixture-version-1",
          bindingName: "TARGET_SERVICE",
          targetServiceName: "cinatoken-rust-api-staging",
          targetEnvironment: null,
          targetEntrypoint: null,
        }],
      });
  });

  test("rejects inherited cross-script bindings instead of skipping them", () => {
    expect(() => normalizeVersionDetail({
      id: "fixture-version-1",
      resources: {
        bindings: [{
          type: "inherit",
          name: "INHERITED_SERVICE_BINDING",
        }],
      },
    }, "cinatoken-container-egress-staging", "fixture-version-1"))
      .toThrow(/inherited_binding_not_resolved/);
  });

  test("rejects unknown cross-script binding shapes instead of skipping them", () => {
    expect(() => normalizeVersionDetail({
      id: "fixture-version-1",
      resources: {
        bindings: [{
          type: "future_cross_script",
          name: "UNKNOWN_CROSS_SCRIPT_BINDING",
          script_name: "cinatoken-rust-api-staging",
        }],
      },
    }, "cinatoken-container-egress-staging", "fixture-version-1"))
      .toThrow(/unknown_binding_type_not_proven_non_cross_script/);
  });

  test("rejects a Content-Length value that does not match the body", async () => {
    const fixture = await collectorFixture();
    const transport = fakeCloudflareTransport(fixture, {
      token: COLLECTION_TOKEN,
      tokenId: COLLECTION_TOKEN_ID,
      contentLengthDelta: 1,
    });

    await expect(collectJsonCompatibilityAccountBindingArtifact({
      ...fixture.inputs,
      mode: "collection",
      accountId: ACCOUNT_ID,
      apiToken: COLLECTION_TOKEN,
      rawPageSink: async () => {},
      fetchImpl: transport.fetch,
      clock: () => fixture.now,
      monotonicClock: () => 0,
    })).rejects.toThrow(/cloudflare_api_content_length_mismatch/);
    expect(transport.calls).toHaveLength(1);
  });

  test("requires durable raw-page retention before advancing the chain", async () => {
    const fixture = await collectorFixture();
    const transport = fakeCloudflareTransport(fixture, {
      token: COLLECTION_TOKEN,
      tokenId: COLLECTION_TOKEN_ID,
    });
    let sinkCalls = 0;

    await expect(collectJsonCompatibilityAccountBindingArtifact({
      ...fixture.inputs,
      mode: "collection",
      accountId: ACCOUNT_ID,
      apiToken: COLLECTION_TOKEN,
      rawPageSink: async () => {
        sinkCalls += 1;
        throw new Error("archive sink unavailable");
      },
      fetchImpl: transport.fetch,
      clock: () => fixture.now,
      monotonicClock: () => 0,
    })).rejects.toThrow(/archive sink unavailable/);
    expect(sinkCalls).toBe(1);
    expect(transport.calls).toHaveLength(1);
  });
});

async function collectorFixture() {
  const source = await createSourceAuthenticationFixture();
  const sourceEvidence = source.bundle.accountBindingEvidence;
  const collectionProfile =
    buildJsonCompatibilityAccountBindingCollectionProfile({
      campaignPlan: source.campaignPlan,
      statePlan: source.statePlan,
      accountIdSha256: sha256(ACCOUNT_ID),
      collectorIdentitySha256:
        sourceEvidence.collection.collectorIdentity.collectorIdentitySha256,
      collectionPermissionSetSha256:
        signedReadOnlyPermissionSetSha256("collection"),
      readbackPermissionSetSha256:
        signedReadOnlyPermissionSetSha256("independent-readback"),
      allowedCampaignBindingEdges:
        sourceEvidence.collectionProfile.allowedCampaignBindingEdges,
    });
  return {
    now: source.now - 120,
    sourceEvidence,
    inputs: {
      campaignPlan: source.campaignPlan,
      statePlan: source.statePlan,
      collectionProfile,
      collectorIdentity: sourceEvidence.collection.collectorIdentity,
    },
  };
}

function fakeCloudflareTransport(fixture, options) {
  const calls = [];
  let ray = 0;
  const services = fixture.sourceEvidence.collection.snapshot.services;
  const edges = fixture.sourceEvidence.collection.snapshot.serviceBindingEdges;
  const fetch = async (input, init) => {
    const url = new URL(input);
    calls.push({ url: url.href, init });
    if (init.method !== "GET" || init.redirect !== "error") {
      throw new Error("unexpected request options");
    }
    if (init.headers.Authorization !== `Bearer ${options.token}`) {
      throw new Error("unexpected authorization header");
    }
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    let family;
    let result;
    let resultInfo;
    if (parts.at(-2) === "tokens" && parts.at(-1) === "verify") {
      family = "credential-verification";
      result = { id: options.tokenId, status: "active" };
    } else if (parts.at(-2) === "workers" && parts.at(-1) === "scripts") {
      family = "workers-scripts";
      result = services.map((service) => ({ id: service.serviceName }));
    } else if (parts.at(-1) === "deployments") {
      family = "worker-deployments";
      const serviceName = parts.at(-2);
      const service = services.find((value) => value.serviceName === serviceName);
      result = {
        deployments: [{
          id: `deployment-${service.activeVersionIds[0]}`,
          strategy: "percentage",
          versions: [{
            version_id: service.activeVersionIds[0],
            percentage: 100,
          }],
        }],
      };
    } else if (parts.at(-2) === "versions") {
      family = "worker-version";
      const serviceName = parts.at(-3);
      const versionId = parts.at(-1);
      result = {
        id: versionId,
        resources: {
          bindings: edges
            .filter((edge) =>
              edge.callerServiceName === serviceName
              && edge.callerVersionId === versionId)
            .map(apiBindingFromEdge),
        },
      };
    } else if (parts.at(-1) === "subdomain") {
      family = "worker-subdomain";
      result = { enabled: false, previews_enabled: false };
    } else if (parts.at(-2) === "workers" && parts.at(-1) === "domains") {
      family = "account-worker-domains";
      result = [];
      resultInfo = {
        page: 1,
        per_page: 20,
        count: 0,
        total_count: 0,
        total_pages: 1,
      };
    } else if (parts.length === 3 && parts.at(-1) === "zones") {
      family = "account-zones";
      result = [{ id: ZONE_ID, account: { id: ACCOUNT_ID } }];
      resultInfo = {
        page: 1,
        per_page: 50,
        count: 1,
        total_count: 1,
        total_pages: 1,
      };
    } else if (parts.at(-2) === "workers" && parts.at(-1) === "routes") {
      family = "zone-worker-routes";
      result = [];
    } else {
      throw new Error(`unexpected Cloudflare request: ${url.href}`);
    }
    const payload = {
      success: true,
      errors: [],
      messages: [],
      result,
      ...(resultInfo === undefined ? {} : { result_info: resultInfo }),
    };
    options.mutatePayload?.({ family, payload, url });
    const body = JSON.stringify(payload);
    const contentLength = Buffer.byteLength(body) +
      (options.contentLengthDelta ?? 0);
    ray += 1;
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": String(contentLength),
        "cf-ray": `fixture-ray-${ray}`,
      },
    });
  };
  return { calls, fetch };
}

function apiBindingFromEdge(edge) {
  if (edge.bindingType !== "service") {
    throw new Error(`unsupported fixture binding type: ${edge.bindingType}`);
  }
  return {
    type: "service",
    name: edge.bindingName,
    service: edge.targetServiceName,
    ...(edge.targetEnvironment === null
      ? {}
      : { environment: edge.targetEnvironment }),
    ...(edge.targetEntrypoint === null
      ? {}
      : { entrypoint: edge.targetEntrypoint }),
  };
}

function signedReadOnlyPermissionSetSha256(role) {
  return sha256Canonical({
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-json-compatibility-read-only-permission-set-v1",
    environment: "staging",
    role,
    accountIdSha256: sha256(ACCOUNT_ID),
    permissionGroups: [
      "Workers Routes Read",
      "Workers Scripts Read",
      "Zone Read",
    ],
  });
}

function tokenRequestPaths(calls) {
  return calls
    .map(({ url }) => new URL(url).pathname)
    .filter((path) => path.includes("/tokens/"));
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
