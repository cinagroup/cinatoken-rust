import { beforeAll, describe, expect, test, vi } from "vitest";

import { mutateDeploymentOnce } from "../src/mutator.ts";
import {
  acceptedCloudflareResponse,
  createMutationEnvelopeFixture,
} from "./fixtures/mutation-envelope.mjs";

class InMemoryJournal {
  constructor(claimedAt) {
    this.claimedAt = claimedAt;
    this.claim = null;
    this.outcome = null;
    this.reserveCalls = 0;
    this.recordCalls = 0;
    this.failRecord = false;
  }

  async reserve(mutation) {
    this.reserveCalls += 1;
    if (this.claim === null) {
      this.claim = mutation;
      return { classification: "fresh", row: { claimed_at: this.claimedAt } };
    }
    if (this.claim.mutationRpcRequestSha256 !== mutation.mutationRpcRequestSha256) {
      throw new Error("mutation_journal_conflict");
    }
    return {
      classification: "exact_replay",
      row: { claimed_at: this.claimedAt },
    };
  }

  async recordOutcome(_mutationIntentSha256, outcome) {
    this.recordCalls += 1;
    if (this.failRecord) throw new Error("simulated response loss");
    this.outcome = outcome;
    return { outcome_digest_sha256: outcome.outcomeDigestSha256 };
  }
}

let fixture;

beforeAll(async () => {
  fixture = await createMutationEnvelopeFixture({
    operationSeed: "mutator-tests",
  });
});

describe("deployment mutation orchestration", () => {
  test("concurrent exact calls claim once and issue one network request", async () => {
    const journal = new InMemoryJournal(fixture.now);
    let tokenReads = 0;
    const env = testEnv(fixture, () => {
      tokenReads += 1;
      return "test-deployment-mutation-token-000000000000";
    });
    const fetch = vi.fn(async () =>
      acceptedCloudflareResponse(journal.claim)
    );
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () =>
        mutateDeploymentOnce(env, fixture.envelope, runtime(journal, fetch))),
    );
    expect(outcomes.filter((value) => value.classification === "accepted"))
      .toHaveLength(1);
    expect(outcomes.filter((value) => value.classification === "ambiguous"))
      .toHaveLength(7);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(tokenReads).toBe(8);
    expect(journal.recordCalls).toBe(1);
  });

  test("response-loss recovery and replay never send a second request", async () => {
    const journal = new InMemoryJournal(fixture.now);
    journal.failRecord = true;
    let tokenReads = 0;
    const env = testEnv(fixture, () => {
      tokenReads += 1;
      return "test-deployment-mutation-token-000000000000";
    });
    const fetch = vi.fn(async () =>
      acceptedCloudflareResponse(journal.claim)
    );
    const first = await mutateDeploymentOnce(
      env,
      fixture.envelope,
      runtime(journal, fetch),
    );
    const replay = await mutateDeploymentOnce(
      env,
      fixture.envelope,
      runtime(journal, fetch),
    );
    expect(first.classification).toBe("ambiguous");
    expect(replay.classification).toBe("ambiguous");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(tokenReads).toBe(2);
  });

  test("rejects readback drift before journal, credential, or network access", async () => {
    const journal = new InMemoryJournal(fixture.now);
    let tokenReads = 0;
    const env = testEnv(fixture, () => {
      tokenReads += 1;
      return "test-deployment-mutation-token-000000000000";
    });
    const input = structuredClone(fixture.envelope);
    input.sourceReadbacks[1].versionId = "drifted-version";
    const fetch = vi.fn();
    await expect(mutateDeploymentOnce(
      env,
      input,
      runtime(journal, fetch),
    )).rejects.toThrow("mutation_envelope_rejected");
    expect(journal.reserveCalls).toBe(0);
    expect(tokenReads).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("rejects the retired external inventory field before token access", async () => {
    const journal = new InMemoryJournal(fixture.now);
    let tokenReads = 0;
    const env = testEnv(fixture, () => {
      tokenReads += 1;
      return "test-deployment-mutation-token-000000000000";
    });
    const input = structuredClone(fixture.envelope);
    input.artifactInventoryReadback =
      input.authorizedTransition.request.artifactInventoryReadback;
    const fetch = vi.fn();
    await expect(mutateDeploymentOnce(
      env,
      input,
      runtime(journal, fetch),
    )).rejects.toThrow("mutation_envelope_rejected");
    expect(tokenReads).toBe(0);
    expect(journal.reserveCalls).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("rejects self-identity drift before reading the credential", async () => {
    const journal = new InMemoryJournal(fixture.now);
    let tokenReads = 0;
    const env = testEnv(fixture, () => {
      tokenReads += 1;
      return "test-deployment-mutation-token-000000000000";
    });
    env.JSON_COMPATIBILITY_DEPLOYMENT_MUTATION_CREDENTIAL_ID_SHA256 =
      "0".repeat(64);
    const fetch = vi.fn();
    await expect(mutateDeploymentOnce(
      env,
      fixture.envelope,
      runtime(journal, fetch),
    )).rejects.toThrow("mutation_envelope_rejected");
    expect(journal.reserveCalls).toBe(0);
    expect(tokenReads).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([undefined, "short"])(
    "a missing or invalid token (%s) fails closed before consuming the intent",
    async (token) => {
    const journal = new InMemoryJournal(fixture.now);
    const env = testEnv(fixture, () => token);
    const fetch = vi.fn();
    await expect(mutateDeploymentOnce(
      env,
      fixture.envelope,
      runtime(journal, fetch),
    )).rejects.toThrow("mutation_credential_unavailable");
    expect(fetch).not.toHaveBeenCalled();
    expect(journal.reserveCalls).toBe(0);
    expect(journal.recordCalls).toBe(0);
    },
  );
});

function testEnv(value, tokenGetter) {
  const env = {
    DB: { withSession() { throw new Error("test journal is injected"); } },
    CF_VERSION_METADATA: { id: value.versionId },
    ENVIRONMENT: "staging",
    CLOUDFLARE_ACCOUNT_ID: value.accountId,
    JSON_COMPATIBILITY_DEPLOYMENT_MUTATION_ENABLED: "true",
    JSON_COMPATIBILITY_DEPLOYMENT_MUTATION_REMOTE_ENABLED: "true",
    JSON_COMPATIBILITY_DEPLOYMENT_MUTATION_PROFILE_VERSION: "1",
    JSON_COMPATIBILITY_DEPLOYMENT_MUTATION_SERVICE_NAME:
      "cinatoken-container-runtime-json-compatibility-deployment-mutation-staging",
    JSON_COMPATIBILITY_DEPLOYMENT_MUTATION_CREDENTIAL_ID_SHA256:
      value.credentialIdSha256,
    JSON_COMPATIBILITY_DEPLOYMENT_MUTATION_ACCOUNT_ID_SHA256:
      value.accountIdSha256,
  };
  Object.defineProperty(env, "CLOUDFLARE_DEPLOYMENT_MUTATION_API_TOKEN", {
    configurable: true,
    enumerable: true,
    get: tokenGetter,
  });
  return env;
}

function runtime(journal, fetch) {
  return {
    now: () => fixture.now,
    journal: () => journal,
    fetch,
  };
}
