import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  FOUNDATION_CAPTURE_CONTRACT,
  canonicalJson,
  p5CandidateDigestSha256,
} from "../tools/relay_container_p5_evidence_contract.mjs";
import {
  FOUNDATION_MAX_INPUT_BYTES,
  FOUNDATION_REQUEST_CONTRACT,
  FOUNDATION_SOURCES_CONTRACT,
  collectP5Foundation,
  buildFoundationDryRun,
  parseCliArgs,
  validateFoundationRequest,
  validateFoundationSources,
} from "../tools/collect_relay_container_p5_foundation.mjs";
import {
  assertReadOnlyCloudflareRequest,
  buildCloudflareReadbackPlan,
  executeCloudflareReadback,
  sha256,
} from "../tools/lib/cloudflare_readback.mjs";
import {
  SHARD_ACTIVATION_CAMPAIGN_CONTRACT,
  SHARD_ACTIVATION_LEDGER_CONTRACT,
  activationDigestSha256,
  buildActivationSnapshot,
  buildCampaignSnapshot,
  buildShardRegistryCapture,
  campaignConsumptionDigestSha256,
  sha256Canonical,
} from "../tools/lib/relay_container_shard_registry.mjs";

const replacementToken = "rotated-readback-token-value-001";
const collectorDigest = "f".repeat(64);

describe("Relay Container P5 foundation collector", () => {
  test("accepts only the strict staging request contract", () => {
    const request = requestFixture();
    expect(validateFoundationRequest(request)).toEqual(request);

    expect(() =>
      validateFoundationRequest({ ...request, environment: "production" }),
    ).toThrow(/environment mismatch/);
    expect(() =>
      validateFoundationRequest({ ...request, token: replacementToken }),
    ).toThrow(/unknown or missing fields/);
    expect(() =>
      validateFoundationRequest({
        ...request,
        configKvNamespaceId: "c".repeat(32),
      }),
    ).toThrow(/namespace digest mismatch/);
    expect(() =>
      validateFoundationRequest({ ...request, observationSeconds: 299 }),
    ).toThrow(/observationSeconds is out of range/);
  });

  test("builds a credential-free, staging-only dry-run plan", async () => {
    const request = requestFixture();
    const report = await buildFoundationDryRun({
      request,
      dependencies: { collectorArtifactDigest: collectorDigest },
    });

    expect(report.ok).toBe(true);
    expect(report.decision).toBe("not-proven");
    expect(report.p5Eligible).toBe(false);
    expect(report.requestKeys).toHaveLength(13);
    expect(report.safetyBoundary.credentialsRead).toBe(false);
    expect(report.safetyBoundary.networkReadbackPerformed).toBe(false);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(request.accountId);
    expect(serialized).not.toContain(request.configKvNamespaceId);
    expect(serialized).not.toContain(replacementToken);
  });

  test("uses only the fixed read-only Cloudflare API allowlist", () => {
    const request = requestFixture();
    const { plan } = buildCloudflareReadbackPlan(request);
    expect(plan).toHaveLength(13);
    for (const item of plan) {
      expect(() => assertReadOnlyCloudflareRequest(item)).not.toThrow();
      expect(item.transport).toBe("cloudflare-api");
      expect(item.method).toBe("GET");
      expect(new URL(item.url).origin).toBe("https://api.cloudflare.com");
      expect(item.headers).toBeUndefined();
      expect(item.apiToken).toBeUndefined();
    }
    expect(
      plan
        .filter((item) => item.paginationMode === "page-number")
        .map((item) => item.key),
    ).toEqual(["kv-namespaces"]);
    expect(
      plan
        .filter((item) => item.paginationMode === "page-token")
        .map((item) => item.key),
    ).toEqual(["container-applications", "container-instances"]);
    expect(() =>
      assertReadOnlyCloudflareRequest({
        ...plan[0],
        method: "POST",
      }),
    ).toThrow(/direct GET/);
    expect(() =>
      assertReadOnlyCloudflareRequest({
        ...plan[0],
        url: plan[0].url.replace(
          "https://api.cloudflare.com",
          "https://example.invalid",
        ),
      }),
    ).toThrow(/Cloudflare API origin/);
    expect(() =>
      assertReadOnlyCloudflareRequest({
        ...plan[0],
        url: `${plan[0].url}?delete=true`,
      }),
    ).toThrow(/fixed allowlist/);
    expect(() =>
      assertReadOnlyCloudflareRequest({
        ...plan[0],
        headers: { Authorization: `Bearer ${replacementToken}` },
      }),
    ).toThrow(/must not contain credentials/);
    expect(() =>
      assertReadOnlyCloudflareRequest({
        ...plan[0],
        expectedValues: ["different-version"],
      }),
    ).toThrow(/Worker version path drifted/);
    const deployment = plan.find((item) => item.key === "container-deployments");
    expect(() =>
      assertReadOnlyCloudflareRequest({
        ...deployment,
        expectedContainerImageDigest: null,
      }),
    ).toThrow(/image contract drifted/);
  });

  test("uses the replacement token only in direct Authorization headers", async () => {
    const request = requestFixture();
    const plan = buildCloudflareReadbackPlan(request);
    const mock = successfulApiFetch(plan);
    const report = await executeCloudflareReadback(plan, {
      apiToken: replacementToken,
      fetchImpl: mock.fetchImpl,
    });

    expect(report.complete).toBe(true);
    expect(report.paginationComplete).toBe(true);
    expect(mock.calls).toHaveLength(13);
    for (const call of mock.calls) {
      expect(call.url).not.toContain(replacementToken);
      expect(call.options.method).toBe("GET");
      expect(call.options.redirect).toBe("error");
      expect(call.options.headers.Authorization).toBe(
        `Bearer ${replacementToken}`,
      );
    }
    expect(JSON.stringify(report)).not.toContain(replacementToken);
    expect(JSON.stringify(report)).not.toContain(request.accountId);
  });

  test("binds the Container application to the exact deployed image digest", async () => {
    const request = requestFixture();
    const plan = buildCloudflareReadbackPlan(request);
    const info = plan.plan.find((item) => item.key === "container-info");
    expect(info.expectedContainerImageDigest).toBe(
      request.candidate.containerImageDigest,
    );
    expect(
      plan.plan.find((item) => item.key === "container-deployments"),
    ).toBeDefined();

    const mock = successfulApiFetch(plan, {
      responseFor: (item) => {
        if (item.key !== "container-info") return null;
        return cloudflareResponse({
          result: {
            id: request.containerApplicationId,
            configuration: {
              image: `registry.invalid/app@sha256:${"9".repeat(64)}`,
            },
          },
        });
      },
    });
    const report = await executeCloudflareReadback(plan, {
      apiToken: replacementToken,
      fetchImpl: mock.fetchImpl,
    });
    const infoSummary = report.commands.find(
      (item) => item.key === "container-info",
    );
    expect(infoSummary.expectedValuesPresent).toBe(true);
    expect(infoSummary.expectedContainerImageDigestPresent).toBe(false);
    expect(infoSummary.status).toBe("not-proven");
    expect(report.complete).toBe(false);
  });

  test("walks every page-number and opaque-token page to an explicit terminal", async () => {
    const request = requestFixture();
    const fullPlan = buildCloudflareReadbackPlan(request);
    const plan = {
      ...fullPlan,
      plan: fullPlan.plan.filter((item) =>
        ["kv-namespaces", "container-applications", "container-instances"].includes(
          item.key,
        ),
      ),
    };
    const mock = successfulApiFetch(plan, {
      responseFor: (item, url) => paginatedResponse(item, url),
    });
    const report = await executeCloudflareReadback(plan, {
      apiToken: replacementToken,
      fetchImpl: mock.fetchImpl,
    });

    expect(report.complete).toBe(true);
    expect(report.paginationComplete).toBe(true);
    expect(report.commands.map((item) => item.pageCount)).toEqual([2, 2, 2]);
    expect(report.commands.map((item) => item.itemCount)).toEqual([101, 2, 3]);
    expect(mock.calls).toHaveLength(6);
    expect(mock.calls.some((call) => new URL(call.url).searchParams.get("page") === "2"))
      .toBe(true);
    expect(
      mock.calls.some(
        (call) => new URL(call.url).searchParams.get("page_token") === "apps-next",
      ),
    ).toBe(true);
    expect(JSON.stringify(report)).not.toContain("apps-next");
    expect(JSON.stringify(report)).not.toContain(request.configKvNamespaceId);
  });

  test("fails closed on repeated cursors and page metadata drift", async () => {
    const request = requestFixture();
    const fullPlan = buildCloudflareReadbackPlan(request);
    const applicationsPlan = {
      ...fullPlan,
      plan: fullPlan.plan.filter((item) => item.key === "container-applications"),
    };
    let appPage = 0;
    const repeatedCursor = await executeCloudflareReadback(applicationsPlan, {
      apiToken: replacementToken,
      fetchImpl: async () => {
        appPage += 1;
        return cloudflareResponse({
          result: [{ id: `application-${appPage}` }],
          result_info: { next_page_token: "repeated-token" },
        });
      },
    });
    expect(repeatedCursor.complete).toBe(false);
    expect(repeatedCursor.commands[0].reason).toBe("page-token-invalid");

    const kvPlan = {
      ...fullPlan,
      plan: fullPlan.plan.filter((item) => item.key === "kv-namespaces"),
    };
    const drifted = await executeCloudflareReadback(kvPlan, {
      apiToken: replacementToken,
      fetchImpl: async (url) => {
        const page = Number(new URL(url).searchParams.get("page"));
        const count = page === 1 ? 100 : 1;
        return cloudflareResponse({
          result: Array.from({ length: count }, (_, index) => ({
            id: `kv-${page}-${index}`,
          })),
          result_info: {
            page,
            per_page: 100,
            count,
            total_count: page === 1 ? 101 : 102,
            total_pages: 2,
          },
        });
      },
    });
    expect(drifted.complete).toBe(false);
    expect(drifted.commands[0].reason).toBe("page-snapshot-drift");
  });

  test("requires explicit token terminals and enforces per-page bounds", async () => {
    const request = requestFixture();
    const fullPlan = buildCloudflareReadbackPlan(request);
    const applicationsPlan = {
      ...fullPlan,
      plan: fullPlan.plan.filter((item) => item.key === "container-applications"),
    };

    const missingTerminal = await executeCloudflareReadback(applicationsPlan, {
      apiToken: replacementToken,
      fetchImpl: async () =>
        cloudflareResponse({
          result: [{ id: request.containerApplicationId }],
          result_info: {},
        }),
    });
    expect(missingTerminal.commands[0].reason).toBe(
      "page-token-terminal-missing",
    );

    const emptyTerminal = await executeCloudflareReadback(applicationsPlan, {
      apiToken: replacementToken,
      fetchImpl: async () =>
        cloudflareResponse({
          result: [{ id: request.containerApplicationId }],
          result_info: { next_page_token: "" },
        }),
    });
    expect(emptyTerminal.commands[0].reason).toBe("page-token-invalid");

    let cyclePage = 0;
    const cycle = await executeCloudflareReadback(applicationsPlan, {
      apiToken: replacementToken,
      fetchImpl: async () => {
        const tokens = ["cursor-a", "cursor-b", "cursor-a"];
        const response = cloudflareResponse({
          result: [{ id: `application-cycle-${cyclePage}` }],
          result_info: { next_page_token: tokens[cyclePage] },
        });
        cyclePage += 1;
        return response;
      },
    });
    expect(cycle.commands[0].reason).toBe("page-token-invalid");

    const oversizedPage = await executeCloudflareReadback(applicationsPlan, {
      apiToken: replacementToken,
      fetchImpl: async () =>
        cloudflareResponse({
          result: Array.from({ length: 101 }, (_, index) => ({
            id: `application-${index}`,
          })),
          result_info: { next_page_token: null },
        }),
    });
    expect(oversizedPage.commands[0].reason).toBe("page-item-limit");

    const instancesPlan = {
      ...fullPlan,
      plan: fullPlan.plan.filter((item) => item.key === "container-instances"),
    };
    const oversizedCombinedPage = await executeCloudflareReadback(instancesPlan, {
      apiToken: replacementToken,
      fetchImpl: async () =>
        cloudflareResponse({
          result: {
            durable_objects: Array.from({ length: 51 }, (_, index) => ({
              id: `durable-object-${index}`,
            })),
            instances: Array.from({ length: 50 }, (_, index) => ({
              id: `instance-${index}`,
            })),
          },
          result_info: { next_page_token: null },
        }),
    });
    expect(oversizedCombinedPage.commands[0].reason).toBe("page-item-limit");

    let unboundedPage = 0;
    const unbounded = await executeCloudflareReadback(applicationsPlan, {
      apiToken: replacementToken,
      fetchImpl: async () => {
        unboundedPage += 1;
        return cloudflareResponse({
          result: [{ id: `application-unbounded-${unboundedPage}` }],
          result_info: { next_page_token: `cursor-${unboundedPage}` },
        });
      },
    });
    expect(unboundedPage).toBe(1024);
    expect(unbounded.commands[0].reason).toBe("page-limit");
  });

  test("rejects duplicate pages and impossible numbered pagination", async () => {
    const request = requestFixture();
    const fullPlan = buildCloudflareReadbackPlan(request);
    const applicationsPlan = {
      ...fullPlan,
      plan: fullPlan.plan.filter((item) => item.key === "container-applications"),
    };
    const duplicate = await executeCloudflareReadback(applicationsPlan, {
      apiToken: replacementToken,
      fetchImpl: async () =>
        cloudflareResponse({
          result: [{ id: "duplicate" }, { id: "duplicate" }],
          result_info: { next_page_token: null },
        }),
    });
    expect(duplicate.commands[0].reason).toBe("page-duplicate-item");

    let duplicatePage = 0;
    const crossPageDuplicate = await executeCloudflareReadback(applicationsPlan, {
      apiToken: replacementToken,
      fetchImpl: async () => {
        duplicatePage += 1;
        return cloudflareResponse({
          result: [{ id: "cross-page-duplicate" }],
          result_info: {
            next_page_token: duplicatePage === 1 ? "duplicate-next" : null,
          },
        });
      },
    });
    expect(crossPageDuplicate.commands[0].reason).toBe("page-duplicate-item");

    const kvPlan = {
      ...fullPlan,
      plan: fullPlan.plan.filter((item) => item.key === "kv-namespaces"),
    };
    const impossible = await executeCloudflareReadback(kvPlan, {
      apiToken: replacementToken,
      fetchImpl: async () =>
        cloudflareResponse({
          result: [{ id: request.configKvNamespaceId }],
          result_info: {
            page: 1,
            per_page: 100,
            count: 1,
            total_count: 1,
            total_pages: 2,
          },
        }),
    });
    expect(impossible.commands[0].reason).toBe("page-metadata-inconsistent");
  });

  test("requires active Worker and Container deployment identity", async () => {
    const request = requestFixture();
    const fullPlan = buildCloudflareReadbackPlan(request);
    const workerPlan = {
      ...fullPlan,
      plan: fullPlan.plan.filter((item) => item.key === "edge-deployments"),
    };
    const historicalOnly = await executeCloudflareReadback(workerPlan, {
      apiToken: replacementToken,
      fetchImpl: async () =>
        cloudflareResponse({
          result: {
            deployments: [
              {
                id: "active-other",
                versions: [{ percentage: 100, version_id: "other-version" }],
              },
              {
                id: "historical-candidate",
                versions: [
                  {
                    percentage: 100,
                    version_id: request.candidate.edgeWorkerVersionId,
                  },
                ],
              },
            ],
          },
        }),
    });
    expect(historicalOnly.commands[0].status).toBe("not-proven");

    const partialTraffic = await executeCloudflareReadback(workerPlan, {
      apiToken: replacementToken,
      fetchImpl: async () =>
        cloudflareResponse({
          result: {
            deployments: [
              {
                id: "active-gradual",
                versions: [
                  {
                    percentage: 50,
                    version_id: request.candidate.edgeWorkerVersionId,
                  },
                  { percentage: 50, version_id: "other-version" },
                ],
              },
            ],
          },
        }),
    });
    expect(partialTraffic.commands[0].status).toBe("not-proven");

    const versionPlan = { ...fullPlan, plan: [fullPlan.plan[0]] };
    const scalarVersion = await executeCloudflareReadback(versionPlan, {
      apiToken: replacementToken,
      fetchImpl: async () =>
        cloudflareResponse({ result: request.candidate.edgeWorkerVersionId }),
    });
    expect(scalarVersion.commands[0].reason).toBe("worker-version result-invalid");

    const containerPlan = {
      ...fullPlan,
      plan: fullPlan.plan.filter((item) => item.key === "container-deployments"),
    };
    const empty = await executeCloudflareReadback(containerPlan, {
      apiToken: replacementToken,
      fetchImpl: async () => cloudflareResponse({ result: [] }),
    });
    expect(empty.commands[0].expectedContainerImageDigestPresent).toBe(false);
    expect(empty.commands[0].status).toBe("not-proven");

    const wrongActiveImage = await executeCloudflareReadback(containerPlan, {
      apiToken: replacementToken,
      fetchImpl: async () =>
        cloudflareResponse({
          result: [
            {
              id: "current-other-image",
              image: `registry.invalid/app@sha256:${"8".repeat(64)}`,
              current_placement: { status: { health: "healthy" } },
            },
            {
              id: "historical-candidate-image",
              image: `registry.invalid/app@${request.candidate.containerImageDigest}`,
              current_placement: null,
            },
          ],
        }),
    });
    expect(wrongActiveImage.commands[0].status).toBe("not-proven");
  });

  test("applies one deadline to the complete readback", async () => {
    const request = requestFixture();
    const fullPlan = buildCloudflareReadbackPlan(request);
    const plan = { ...fullPlan, plan: fullPlan.plan.slice(0, 2) };
    let clock = 0;
    const report = await executeCloudflareReadback(plan, {
      apiToken: replacementToken,
      now: () => clock,
      fetchImpl: async (url) => {
        const item = plan.plan.find(
          (candidate) =>
            new URL(candidate.url).pathname === new URL(url).pathname,
        );
        clock += 200_000;
        return successfulApiResponse(item, new URL(url));
      },
    });
    expect(report.commands[0].status).toBe("pass");
    expect(report.commands[1].reason).toBe("readback-timeout");
    expect(report.complete).toBe(false);
  });

  test("rejects credential reflection and unsafe HTTP envelopes", async () => {
    const request = requestFixture();
    const fullPlan = buildCloudflareReadbackPlan(request);
    const plan = { ...fullPlan, plan: [fullPlan.plan[0]] };
    await expect(
      executeCloudflareReadback(plan, {
        apiToken: replacementToken,
        fetchImpl: async () =>
          cloudflareResponse({ result: { value: replacementToken } }),
      }),
    ).rejects.toThrow(/contained the readback credential/);

    const escapedToken = [...replacementToken]
      .map((character) =>
        `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
      )
      .join("");
    await expect(
      executeCloudflareReadback(plan, {
        apiToken: replacementToken,
        fetchImpl: async () =>
          new Response(
            `{"success":true,"errors":[],"messages":[],"result":{"value":"${escapedToken}"}}`,
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      }),
    ).rejects.toThrow(/contained the readback credential/);

    const applicationsPlan = {
      ...fullPlan,
      plan: fullPlan.plan.filter((item) => item.key === "container-applications"),
    };
    let reflectedPage = 0;
    await expect(
      executeCloudflareReadback(applicationsPlan, {
        apiToken: replacementToken,
        fetchImpl: async () => {
          reflectedPage += 1;
          if (reflectedPage === 1) {
            return cloudflareResponse({
              result: [{ id: request.containerApplicationId }],
              result_info: { next_page_token: "reflected-next" },
            });
          }
          return new Response(
            `{"success":true,"errors":[],"messages":[],"result":[{"id":"${escapedToken}"}],"result_info":{"next_page_token":null}}`,
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        },
      }),
    ).rejects.toThrow(/contained the readback credential/);
    expect(reflectedPage).toBe(2);

    const badContentType = await executeCloudflareReadback(plan, {
      apiToken: replacementToken,
      fetchImpl: async () =>
        new Response("not-json", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    });
    expect(badContentType.complete).toBe(false);
    expect(badContentType.commands[0].reason).toBe("content-type-invalid");

    const jsonpContentType = await executeCloudflareReadback(plan, {
      apiToken: replacementToken,
      fetchImpl: async () =>
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/jsonp" },
        }),
    });
    expect(jsonpContentType.commands[0].reason).toBe("content-type-invalid");

    const oversized = await executeCloudflareReadback(plan, {
      apiToken: replacementToken,
      fetchImpl: async () =>
        new Response("{}", {
          status: 200,
          headers: {
            "content-length": String(4 * 1024 * 1024 + 1),
            "content-type": "application/json",
          },
        }),
    });
    expect(oversized.complete).toBe(false);
    expect(oversized.commands[0].reason).toBe("response-size-invalid");

    let streamPulls = 0;
    let streamCancelled = false;
    const oversizedStream = await executeCloudflareReadback(plan, {
      apiToken: replacementToken,
      fetchImpl: async () =>
        new Response(
          new ReadableStream(
            {
              pull(controller) {
                streamPulls += 1;
                controller.enqueue(new Uint8Array(3 * 1024 * 1024));
              },
              cancel() {
                streamCancelled = true;
              },
            },
            { highWaterMark: 0 },
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    expect(oversizedStream.complete).toBe(false);
    expect(oversizedStream.commands[0].reason).toBe("response-size-invalid");
    expect(streamPulls).toBe(2);
    expect(streamCancelled).toBe(true);

    const oversizedFallback = await executeCloudflareReadback(plan, {
      apiToken: replacementToken,
      fetchImpl: async () => ({
        status: 200,
        ok: true,
        redirected: false,
        url: "",
        headers: {
          get(name) {
            return name === "content-type" ? "application/json" : null;
          },
        },
        body: null,
        arrayBuffer: async () => new Uint8Array(4 * 1024 * 1024 + 1).buffer,
      }),
    });
    expect(oversizedFallback.commands[0].reason).toBe("response-size-invalid");

    const apiFailure = await executeCloudflareReadback(plan, {
      apiToken: replacementToken,
      fetchImpl: async () =>
        cloudflareResponse(
          { success: false, errors: [{ code: 1 }], result: null },
          { rawEnvelope: true },
        ),
    });
    expect(apiFailure.complete).toBe(false);
    expect(apiFailure.commands[0].reason).toBe("api-envelope-failed");
  });

  test("enforces the aggregate response bound across pages", async () => {
    const request = requestFixture();
    const fullPlan = buildCloudflareReadbackPlan(request);
    const plan = {
      ...fullPlan,
      plan: fullPlan.plan.filter((item) => item.key === "container-applications"),
    };
    let page = 0;
    const report = await executeCloudflareReadback(plan, {
      apiToken: replacementToken,
      fetchImpl: async () => {
        page += 1;
        const result = Array.from({ length: 100 }, (_, index) => ({
          id:
            page === 1 && index === 0
              ? request.containerApplicationId
              : `application-large-${page}-${index}`,
          padding: "x".repeat(39_000),
        }));
        return cloudflareResponse({
          result,
          result_info: {
            next_page_token: page < 5 ? `large-page-${page}` : null,
          },
        });
      },
    });
    expect(page).toBe(5);
    expect(report.commands[0].reason).toBe("aggregate-output-limit");
  });

  test("allows official non-paginated responses to pass as one terminal page", async () => {
    const request = requestFixture();
    const fullPlan = buildCloudflareReadbackPlan(request);
    const singleResponsePlan = {
      ...fullPlan,
      plan: fullPlan.plan.filter(
        (item) => item.paginationMode === "single-response",
      ),
    };
    const mock = successfulApiFetch(singleResponsePlan);
    const report = await executeCloudflareReadback(singleResponsePlan, {
      apiToken: replacementToken,
      fetchImpl: mock.fetchImpl,
    });

    expect(report.commands).toHaveLength(10);
    expect(report.commands.every((item) => item.status === "pass")).toBe(true);
    expect(report.commands.every((item) => item.pageCount === 1)).toBe(true);
    expect(report.complete).toBe(true);
    expect(report.paginationComplete).toBe(true);
  });

  test("keeps missing external inventories not-proven", async () => {
    const request = requestFixture();
    const result = await collectWith({ request, sourceBundle: undefined });

    expect(result.subject.foundationEvidenceReady).toBe(false);
    expect(result.subject.decision).toBe("not-proven");
    expect(result.subject.p5Eligible).toBe(false);
    expect(result.binding.paginationComplete).toBe(false);
    expect(result.subject.blockers).toContain("shard-registry-source-absent");
    expect(result.subject.blockers).toContain("r2-inventory-source-absent");
    expect(result.subject.blockers).toContain("traffic-source-absent");
    expect(result.subject.blockers).toContain("sbom-source-absent");
    expect(result.subject.evidenceFacts).toBeNull();
  });

  test("emits reviewable foundation facts only when every source is complete", async () => {
    const request = requestFixture();
    const sources = sourcesFixture(request);
    const result = await collectWith({ request, sourceBundle: sources });

    expect(result.subject.foundationEvidenceReady).toBe(true);
    expect(result.subject.blockers).toEqual([]);
    expect(result.binding.paginationComplete).toBe(true);
    expect(result.subject.p5Eligible).toBe(false);
    expect(result.subject.productionEligible).toBe(false);
    expect(result.subject.customerTrafficEligible).toBe(false);
    expect(result.subject.evidenceFacts.remoteInventory.verifiedShardCount).toBe(8);
    expect(result.subject.evidenceFacts.remoteInventory.unknownWriterCount).toBe(0);
    expect(result.subject.evidenceFacts.candidateFreeze.allActionGatesFalse).toBe(true);
    expect(
      result.subject.evidenceFacts.remoteInventory.shardActivationCampaign.state,
    ).toBe("sealed_complete");
    expect(
      result.subject.evidenceFacts.remoteInventory.shardActivationCampaign.receiptCount,
    ).toBe(8);
    expect(result.foundationCaptureSha256).toBe(digest(result.subject));
    expect(result.binding.foundationCaptureSha256).toBe(
      result.foundationCaptureSha256,
    );
    expect(JSON.stringify(result)).not.toContain(replacementToken);
    expect(JSON.stringify(result)).not.toContain(request.accountId);
    expect(JSON.stringify(result)).not.toContain(request.configKvNamespaceId);
    expect(JSON.stringify(result)).not.toContain(request.containerApplicationId);
  });

  test("measures the bounded observation between complete readback snapshots", async () => {
    const request = requestFixture();
    request.observationSeconds = 7200;
    const sources = retimeShardCapture(
      sourcesFixture(request),
      "2026-07-19T10:01:00.000Z",
      "2026-07-19T12:01:00.000Z",
    );
    sources.capturedAt = "2026-07-19T12:01:00.000Z";
    const result = await collectWith({
      request,
      sourceBundle: sources,
      readbackDurationsMs: [60_000, 120_000],
    });
    expect(result.subject.observationStartedAt).toBe(
      "2026-07-19T10:01:00.000Z",
    );
    expect(result.subject.observationEndedAt).toBe(
      "2026-07-19T12:01:00.000Z",
    );
    expect(result.subject.observationSeconds).toBe(7200);
    expect(result.subject.foundationEvidenceReady).toBe(true);
  });

  test("fails foundation readiness on readback drift", async () => {
    const request = requestFixture();
    const result = await collectWith({
      request,
      sourceBundle: sourcesFixture(request),
      snapshots: [readbackFixture("a"), readbackFixture("b")],
    });
    expect(result.subject.foundationEvidenceReady).toBe(false);
    expect(result.subject.blockers).toContain("cloudflare-readback-drift");
  });

  test("rejects structurally incomplete readback summaries", async () => {
    const request = requestFixture();
    const forged = readbackFixture("a");
    delete forged.commands[0].transport;
    forged.digestSha256 = sha256(canonicalJson(forged.commands));
    await expect(
      collectWith({
        request,
        sourceBundle: sourcesFixture(request),
        snapshots: [forged, readbackFixture("a")],
      }),
    ).rejects.toThrow(/readback command.*fields/i);
  });

  test("fails foundation readiness on unknown writers, traffic, or source status", async () => {
    const request = requestFixture();
    const sources = sourcesFixture(request);
    sources.sources.r2Inventory.unknownWriterCount = 1;
    sources.sources.traffic.customerTrafficCount = 1;
    sources.sources.shardRegistry.status = "unknown";
    refreshSourceDigest(sources.sources.r2Inventory);
    refreshSourceDigest(sources.sources.traffic);
    const result = await collectWith({ request, sourceBundle: sources });
    expect(result.subject.foundationEvidenceReady).toBe(false);
    expect(result.subject.blockers).toContain("unknown-r2-writers");
    expect(result.subject.blockers).toContain("customer-traffic-present");
    expect(result.subject.blockers).toContain("shardRegistry-source-not-pass");

    const crossVersion = sourcesFixture(request);
    crossVersion.sources.actionGates.controllerVersionId = "controller-version-002";
    refreshSourceDigest(crossVersion.sources.actionGates);
    const crossVersionResult = await collectWith({
      request,
      sourceBundle: crossVersion,
    });
    expect(crossVersionResult.subject.blockers).toContain(
      "action-gates-controller-version-mismatch",
    );
  });

  test("requires source capture to overlap the bounded observation", async () => {
    const request = requestFixture();
    const sources = sourcesFixture(request);
    sources.capturedAt = "2026-07-19T09:00:00.000Z";
    const result = await collectWith({ request, sourceBundle: sources });
    expect(result.subject.blockers).toContain(
      "source-capture-outside-observation-window",
    );

    const staleShardSources = retimeShardCapture(
      sourcesFixture(request),
      "2026-07-19T09:00:00.000Z",
      "2026-07-19T09:05:00.000Z",
    );
    const staleShard = await collectWith({
      request,
      sourceBundle: staleShardSources,
    });
    expect(staleShard.subject.blockers).toContain(
      "shard-registry-window-does-not-cover-foundation",
    );
  });

  test("validates the strict source bundle and candidate binding", () => {
    const request = requestFixture();
    const candidateDigest = p5CandidateDigestSha256(request.candidate);
    const sources = sourcesFixture(request);
    expect(
      validateFoundationSources(sources, candidateDigest, request.candidate),
    ).toEqual(sources);
    expect(() =>
      validateFoundationSources(
        { ...sources, candidateDigestSha256: "0".repeat(64) },
        candidateDigest,
        request.candidate,
      ),
    ).toThrow(/candidate digest mismatch/);
    expect(() =>
      validateFoundationSources(
        { ...sources, rawPayload: "unsafe" },
        candidateDigest,
        request.candidate,
      ),
    ).toThrow(/unknown or missing fields/);
  });

  test("fits the full 1024-shard capture inside the bounded source input", () => {
    const request = requestFixture();
    request.candidate.shardCount = 1_024;
    const sources = sourcesFixture(request);
    expect(Buffer.byteLength(`${canonicalJson(sources)}\n`, "utf8")).toBeLessThanOrEqual(
      FOUNDATION_MAX_INPUT_BYTES,
    );
  });

  test("requires explicit live confirmations and rejects CLI ambiguity", () => {
    expect(parseCliArgs(["--request", "request.json", "--dry-run"]).mode).toBe(
      "dry-run",
    );
    expect(() => parseCliArgs(["--request", "request.json", "--deploy"])).toThrow(
      /unknown option/,
    );
    expect(() =>
      parseCliArgs([
        "--request",
        "request.json",
        "--dry-run",
        "--confirm-staging-readback",
      ]),
    ).toThrow(/does not accept live confirmations/);
    expect(() => parseCliArgs(["--self-test", "--dry-run"])).toThrow(
      /does not accept other options/,
    );
  });
});

async function collectWith({
  request,
  sourceBundle,
  snapshots,
  readbackDurationsMs = [],
} = {}) {
  let nowMs = new Date("2026-07-19T10:00:00.000Z").getTime();
  const readbacks = snapshots ?? [readbackFixture("a"), readbackFixture("a")];
  let readbackIndex = 0;
  return await collectP5Foundation(
    {
      request,
      sourceBundle,
      apiToken: replacementToken,
    },
    {
      now: () => new Date(nowMs),
      sleep: async (ms) => {
        nowMs += ms;
      },
      executeReadback: async () => {
        const index = readbackIndex++;
        const result = readbacks[index];
        nowMs += readbackDurationsMs[index] ?? 0;
        return result;
      },
      collectorArtifactDigest: collectorDigest,
    },
  );
}

function readbackFixture(marker) {
  const plan = buildCloudflareReadbackPlan(requestFixture()).plan;
  const commands = plan.map((item, index) => ({
    key: item.key,
    status: "pass",
    transport: "cloudflare-api",
    requestSha256: sha256(`${item.method}\0${item.url}`),
    outputSha256: sha256(`${marker}:output:${index}`),
    outputBytes: 10,
    stderrSha256: null,
    stderrEmpty: true,
    expectedValuesPresent: true,
    expectedContainerImageDigestPresent:
      item.expectedContainerImageDigest === null ? null : true,
    itemCount: 1,
    paginationMode: item.paginationMode,
    pageCount: 1,
    paginationEvidenceSha256: sha256(`${marker}:pagination:${index}`),
    paginationComplete: true,
  }));
  return {
    commands,
    digestSha256: sha256(canonicalJson(commands)),
    complete: true,
    paginationComplete: true,
    stderrEmpty: true,
  };
}

function successfulApiFetch(plan, { responseFor } = {}) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options) => {
      const requested = new URL(url);
      const item = plan.plan.find(
        (candidate) => new URL(candidate.url).pathname === requested.pathname,
      );
      if (!item) throw new Error("unexpected API request");
      calls.push({ url: requested.href, options, key: item.key });
      const override = responseFor?.(item, requested, options, calls);
      return override ?? successfulApiResponse(item, requested);
    },
  };
}

function successfulApiResponse(item, url) {
  if (item.paginationMode === "page-number") {
    const result = item.expectedValues.map((id) => ({ id }));
    return cloudflareResponse({
      result,
      result_info: {
        page: Number(url.searchParams.get("page")),
        per_page: 100,
        count: result.length,
        total_count: result.length,
        total_pages: 1,
      },
    });
  }
  if (item.paginationMode === "page-token") {
    const result =
      item.resultShape === "container-instances"
        ? { durable_objects: [], instances: [] }
        : item.expectedValues.map((id) => ({ id }));
    return cloudflareResponse({
      result,
      result_info: { next_page_token: null },
    });
  }
  if (item.key.endsWith("-version")) {
    return cloudflareResponse({
      result: { id: item.expectedValues[0], name: item.expectedValues[1] },
    });
  }
  if (item.resultShape === "worker-deployments") {
    return cloudflareResponse({
      result: {
        deployments: item.expectedValues.map((versionId, index) => ({
          id: `deployment-${index + 1}`,
          versions: [{ percentage: 100, version_id: versionId }],
        })),
      },
    });
  }
  if (item.resultShape === "container-deployments") {
    return cloudflareResponse({
      result: [
        {
          id: "container-deployment-active",
          image: `registry.invalid/app@${item.expectedContainerImageDigest}`,
          current_placement: { status: { health: "healthy" } },
        },
      ],
    });
  }
  if (item.key === "d1-info") {
    return cloudflareResponse({
      result: { name: item.expectedValues[0], uuid: item.expectedValues[1] },
    });
  }
  if (item.key === "r2-info") {
    return cloudflareResponse({ result: { name: item.expectedValues[0] } });
  }
  if (item.key === "container-info") {
    return cloudflareResponse({
      result: {
        id: item.expectedValues[0],
        configuration: {
          image: `registry.invalid/app@${item.expectedContainerImageDigest}`,
        },
      },
    });
  }
  return cloudflareResponse({ result: { values: item.expectedValues } });
}

function paginatedResponse(item, url) {
  if (item.key === "kv-namespaces") {
    const page = Number(url.searchParams.get("page"));
    const result =
      page === 1
        ? [
            { id: item.expectedValues[0] },
            ...Array.from({ length: 99 }, (_, index) => ({
              id: `kv-page-one-${String(index).padStart(3, "0")}`,
            })),
          ]
        : [{ id: "kv-page-two-terminal" }];
    return cloudflareResponse({
      result,
      result_info: {
        page,
        per_page: 100,
        count: result.length,
        total_count: 101,
        total_pages: 2,
      },
    });
  }
  if (item.key === "container-applications") {
    const token = url.searchParams.get("page_token");
    return token === null
      ? cloudflareResponse({
          result: [{ id: item.expectedValues[0] }],
          result_info: { next_page_token: "apps-next" },
        })
      : cloudflareResponse({
          result: [{ id: "application-terminal" }],
          result_info: { next_page_token: null },
        });
  }
  if (item.key === "container-instances") {
    const token = url.searchParams.get("page_token");
    return token === null
      ? cloudflareResponse({
          result: {
            durable_objects: [{ id: "durable-object-one" }],
            instances: [{ id: "instance-one" }],
          },
          result_info: { next_page_token: "instances-next" },
        })
      : cloudflareResponse({
          result: {
            durable_objects: [],
            instances: [{ id: "instance-two" }],
          },
          result_info: { next_page_token: null },
        });
  }
  return null;
}

function cloudflareResponse(
  payload,
  { rawEnvelope = false, status = 200 } = {},
) {
  const body = rawEnvelope
    ? payload
    : {
        success: true,
        errors: [],
        messages: [],
        ...payload,
      };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function requestFixture() {
  const configKvNamespaceId = "0123456789abcdef0123456789abcdef";
  return {
    schemaVersion: 1,
    contract: FOUNDATION_REQUEST_CONTRACT,
    environment: "staging",
    observationSeconds: 300,
    accountId: "fedcba9876543210fedcba9876543210",
    configKvNamespaceId,
    containerApplicationId: "container-app-staging-001",
    candidate: {
      repository: "cinagroup/cinatoken-rust",
      commitSha: "404ae9ad3d217194922692b585c967fe2ba2a086",
      goSourceCommit: "73652508abc5cb09214dde02d51d69d1d1ccc703",
      vibeSourceCommit: "918e97480ee44e357abe99bf33c27259d6ac7ebd",
      edgeWorkerVersionId: "edge-version-001",
      controllerWorkerVersionId: "controller-version-001",
      providerEgressWorkerVersionId: "egress-version-001",
      containerImageDigest: `sha256:${"4".repeat(64)}`,
      containerRuntimeBuildId: "a".repeat(64),
      containerImageProvenanceSha256: "b".repeat(64),
      containerSbomSha256: "5".repeat(64),
      d1DatabaseName: "cinatoken-rust-db-staging",
      d1DatabaseId: "c285553f-7f98-4ec2-b4d6-f84a3b409f3e",
      r2BucketName: "cinatoken-rust-files-staging",
      configKvNamespaceIdSha256: sha256(configKvNamespaceId),
      controllerServiceName: "cinatoken-container-controller-staging",
      providerEgressServiceName: "cinatoken-container-egress-staging",
      doNamespaceIdSha256: "7".repeat(64),
      doBinding: "RELAY_SHARDS",
      doClass: "RelayShardContainer",
      containerClass: "RelayShardContainer",
      ringGeneration: 1,
      shardCount: 8,
      migrationHead: "0058_relay_http_stream_client_abort_watchdogs.sql",
      migrationCount: 58,
      responseProtocolVersion: 3,
      statusContractVersion: 4,
      financialTerminalContractVersion: 2,
      terminalAckContractVersion: 3,
    },
  };
}

function sourcesFixture(request) {
  const base = () => ({
    status: "pass",
    collectorId: "source-collector-v1",
    collectorVersion: "1.0.0",
    sourceArtifactSha256: "8".repeat(64),
  });
  const shardCapture = shardRegistryCaptureFixture(request);
  const sources = {
    schemaVersion: 3,
    contract: FOUNDATION_SOURCES_CONTRACT,
    environment: "staging",
    candidateDigestSha256: p5CandidateDigestSha256(request.candidate),
    capturedAt: "2026-07-19T10:05:00.000Z",
    accountIdSha256: sha256(request.accountId),
    paginationComplete: true,
    sources: {
      actionGates: {
        ...base(),
        controllerVersionId: request.candidate.controllerWorkerVersionId,
        actionGateInventorySha256: "9".repeat(64),
        actionGateCount: 22,
        allActionGatesFalse: true,
      },
      sbom: {
        ...base(),
        containerImageDigest: request.candidate.containerImageDigest,
        containerRuntimeBuildId: request.candidate.containerRuntimeBuildId,
        containerImageProvenanceSha256:
          request.candidate.containerImageProvenanceSha256,
        containerSbomSha256: request.candidate.containerSbomSha256,
        containerSignatureVerified: true,
        runtimeImageProvenanceVerified: true,
        unapprovedCriticalVulnerabilities: 0,
        unapprovedHighVulnerabilities: 0,
      },
      shardRegistry: {
        ...base(),
        sourceArtifactSha256: sha256Canonical(shardCapture),
        doNamespaceIdSha256: request.candidate.doNamespaceIdSha256,
        capture: shardCapture,
      },
      r2Inventory: {
        ...base(),
        unknownWriterCount: 0,
        unknownObjectCount: 0,
      },
      traffic: {
        ...base(),
        customerTrafficCount: 0,
        environmentIsolationVerified: true,
      },
    },
  };
  for (const name of ["actionGates", "sbom", "r2Inventory", "traffic"]) {
    refreshSourceDigest(sources.sources[name]);
  }
  return sources;
}

function shardRegistryCaptureFixture(request) {
  const candidate = {
    controllerVersionId: request.candidate.controllerWorkerVersionId,
    runtimeBuildId: request.candidate.containerRuntimeBuildId,
    containerImageDigest: request.candidate.containerImageDigest,
    imageProvenanceSha256:
      request.candidate.containerImageProvenanceSha256,
    ringGeneration: request.candidate.ringGeneration,
    shardCount: request.candidate.shardCount,
  };
  const campaign = campaignFixture(candidate);
  const records = campaign.receipts.map((receipt, shardIndex) =>
    activationRecordFromReceipt(receipt, shardIndex + 1),
  );
  const highWatermark = records.at(-1).registry_event_sequence;
  const pages = [];
  for (let offset = 0; offset < records.length; offset += 64) {
    const pageRecords = records.slice(offset, offset + 64);
    const terminal = offset + pageRecords.length === records.length;
    pages.push({
      contract_version: 1,
      ledger_contract: SHARD_ACTIVATION_LEDGER_CONTRACT,
      controller_version_id: candidate.controllerVersionId,
      ring_generation: candidate.ringGeneration,
      high_watermark: highWatermark,
      total_records: records.length,
      count: pageRecords.length,
      next_cursor: terminal
        ? null
        : String(pageRecords.at(-1).registry_event_sequence),
      pagination_complete: terminal,
      records: pageRecords,
    });
  }
  const before = buildActivationSnapshot({
    capturedAt: "2026-07-19T10:00:00.000Z",
    pages,
  });
  const after = {
    ...before,
    capturedAt: "2026-07-19T10:05:00.000Z",
  };
  return buildShardRegistryCapture({
    candidate,
    observationStartedAt: before.capturedAt,
    observationEndedAt: after.capturedAt,
    campaignBefore: buildCampaignSnapshot({
      capturedAt: before.capturedAt,
      campaign,
      expected: candidate,
    }),
    campaignAfter: buildCampaignSnapshot({
      capturedAt: after.capturedAt,
      campaign,
      expected: candidate,
    }),
    before,
    after,
  });
}

function retimeShardCapture(sources, observationStartedAt, observationEndedAt) {
  const current = sources.sources.shardRegistry.capture;
  const before = {
    ...current.before,
    capturedAt: observationStartedAt,
  };
  const after = {
    ...current.after,
    capturedAt: observationEndedAt,
  };
  const campaignBefore = {
    ...current.campaign,
    capturedAt: observationStartedAt,
  };
  const campaignAfter = {
    ...current.campaign,
    capturedAt: observationEndedAt,
  };
  const capture = buildShardRegistryCapture({
    candidate: current.candidate,
    observationStartedAt,
    observationEndedAt,
    campaignBefore,
    campaignAfter,
    before,
    after,
  });
  sources.sources.shardRegistry.capture = capture;
  sources.sources.shardRegistry.sourceArtifactSha256 = sha256Canonical(capture);
  return sources;
}

function campaignFixture(candidate) {
  const campaign = {
    contract_version: 1,
    campaign_contract: SHARD_ACTIVATION_CAMPAIGN_CONTRACT,
    state: "sealed_complete",
    campaign_id: "c".repeat(64),
    controller_version_id: candidate.controllerVersionId,
    action_gate_inventory_sha256: "9".repeat(64),
    action_gate_count: 22,
    all_action_gates_false: true,
    foundation_manifest_sha256: "6".repeat(64),
    runtime_build_id: candidate.runtimeBuildId,
    ring_generation: candidate.ringGeneration,
    shard_count: candidate.shardCount,
    shard_contract_version: 1,
    runtime_protocol_version: 1,
    runtime_contract_version: 1,
    activation_generation: 1,
    environment: "staging",
    campaign_digest_sha256: "d".repeat(64),
    created_at: epoch("2026-07-19T09:55:00.000Z"),
    expires_at: epoch("2026-07-19T10:55:00.000Z"),
    claimed_shard_count: candidate.shardCount,
    consumed_shard_count: candidate.shardCount,
    seal_reason: "complete",
    seal_detail_code: "all_shards_consumed",
    last_consumption_digest_sha256: "",
    sealed_at: epoch("2026-07-19T09:59:30.000Z"),
    receipts: [],
  };
  campaign.receipts = Array.from({ length: candidate.shardCount }, (_, shardIndex) =>
    receiptFixture(campaign, shardIndex),
  );
  campaign.last_consumption_digest_sha256 = campaign.receipts.at(-1).consumption_digest_sha256;
  return campaign;
}

function receiptFixture(campaign, shardIndex) {
  const receipt = {
    campaign_id: campaign.campaign_id,
    shard_index: shardIndex,
    claim_digest_sha256: digest(`claim:${shardIndex}`),
    probe_id: digest(`probe:${shardIndex}`),
    campaign_digest_sha256: campaign.campaign_digest_sha256,
    controller_version_id: campaign.controller_version_id,
    action_gate_inventory_sha256: campaign.action_gate_inventory_sha256,
    action_gate_count: 22,
    all_action_gates_false: true,
    foundation_manifest_sha256: campaign.foundation_manifest_sha256,
    ring_generation: campaign.ring_generation,
    shard_count: campaign.shard_count,
    instance_name: `cinatoken-relay-shard-v1-${String(shardIndex).padStart(4, "0")}`,
    shard_contract_version: 1,
    runtime_protocol_version: 1,
    runtime_contract_version: 1,
    runtime_build_id: campaign.runtime_build_id,
    activation_generation: 1,
    activation_probe_generation: shardIndex + 1,
    environment: "staging",
    container_status: "healthy",
    readiness_result_code: "process_ready_execution_disabled",
    readiness_result_sha256: digest(`readiness:${shardIndex}`),
    process_ready: true,
    runtime_execution_enabled: false,
    controller_execution_enabled: false,
    activation_digest_sha256: "",
    consumption_digest_sha256: "",
    readiness_checked_at: campaign.sealed_at - 1,
    consumed_at: shardIndex + 1 === campaign.shard_count ? campaign.sealed_at : campaign.sealed_at - 1,
  };
  receipt.activation_digest_sha256 = activationDigestSha256({
    controllerVersionId: receipt.controller_version_id,
    ringGeneration: receipt.ring_generation,
    record: activationRecordFromReceipt(receipt, shardIndex + 1),
  });
  receipt.consumption_digest_sha256 = campaignConsumptionDigestSha256(receipt);
  return receipt;
}

function activationRecordFromReceipt(receipt, sequence) {
  return {
    registry_event_sequence: sequence,
    shard_count: receipt.shard_count,
    shard_index: receipt.shard_index,
    instance_name: receipt.instance_name,
    shard_contract_version: receipt.shard_contract_version,
    runtime_protocol_version: receipt.runtime_protocol_version,
    runtime_contract_version: receipt.runtime_contract_version,
    runtime_build_id: receipt.runtime_build_id,
    activation_generation: receipt.activation_generation,
    activation_probe_generation: receipt.activation_probe_generation,
    environment: receipt.environment,
    container_status: receipt.container_status,
    readiness_result_code: receipt.readiness_result_code,
    process_ready: receipt.process_ready,
    runtime_execution_enabled: receipt.runtime_execution_enabled,
    controller_execution_enabled: receipt.controller_execution_enabled,
    activation_digest_sha256: receipt.activation_digest_sha256,
    activated_at: receipt.readiness_checked_at,
  };
}

function epoch(value) {
  return Math.floor(Date.parse(value) / 1_000);
}

function refreshSourceDigest(source) {
  const digestInput = { ...source };
  delete digestInput.sourceArtifactSha256;
  source.sourceArtifactSha256 = sha256Canonical(digestInput);
}

function digest(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
