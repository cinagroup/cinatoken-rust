import {
  SELF,
  applyD1Migrations,
  env,
  reset,
} from "cloudflare:test";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  placementAuthorityRevocation,
  placementExecutionClaim,
  placementExecutionReceipt,
  signedAuthorityRequest,
  signedPlacementAuthorityIssuance,
} from "./fixtures/shard-placement-authority-fixture.mjs";

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_D1_MIGRATIONS);
});

afterEach(async () => {
  await reset();
});

describe("shard placement Authority Workerd runtime", () => {
  it("preflights, issues once, exactly reads, and revokes", async () => {
    const preflightRequest = await signedAuthorityRequest({
      method: "GET",
      pathAndQuery: "/internal/v1/shard-placement/preflight",
      role: "read",
      requestId: "placement-preflight-1",
    });
    const preflight = await SELF.fetch(preflightRequest);
    expect(preflight.status).toBe(200);
    expect(await preflight.json()).toMatchObject({
      result: "authority_ready",
      requestId: "placement-preflight-1",
      credentialIdSha256: "a".repeat(64),
      authorityVersionId:
        "shard-placement-authority-runtime-test-version",
    });
    expect(preflight.headers.get("cache-control")).toBe("no-store");

    const fixture = await signedPlacementAuthorityIssuance();
    const concurrent = await Promise.all([
      issue(fixture.body, "placement-issue-1"),
      issue(fixture.body, "placement-issue-2"),
    ]);
    expect(concurrent.map((response) => response.status).sort()).toEqual([
      200, 201,
    ]);
    const payloads = await Promise.all(
      concurrent.map((response) => response.json()),
    );
    expect(payloads.map((payload) => payload.result).sort()).toEqual([
      "created",
      "exact_replay",
    ]);
    expect(payloads[0].authorization).toMatchObject({
      status: "active",
      authorizationIdSha256:
        fixture.permit.authorization_id_sha256,
      campaignId: fixture.permit.campaign_id,
      permitSubjectDigestSha256:
        fixture.permitSubjectDigestSha256,
      approvals: [
        { role: "security" },
        { role: "operations" },
        { role: "release" },
        { role: "rollback" },
      ],
    });
    expect(JSON.stringify(payloads)).not.toContain(
      "signature_base64url",
    );
    expect(JSON.stringify(payloads)).not.toContain("spki_base64url");

    const query =
      `?permitSubjectDigestSha256=${fixture.permitSubjectDigestSha256}`
      + `&campaignId=${fixture.permit.campaign_id}`;
    const readRequest = await signedAuthorityRequest({
      method: "GET",
      pathAndQuery:
        `/internal/v1/shard-placement/authorizations/${fixture.permit.authorization_id_sha256}${query}`,
      role: "read",
      requestId: "placement-read-1",
    });
    const read = await SELF.fetch(readRequest);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      result: "exact_authorization",
      authorization: { status: "active" },
    });

    const revocation = await placementAuthorityRevocation({
      authorizationIdSha256:
        fixture.permit.authorization_id_sha256,
      permitSubjectDigestSha256:
        fixture.permitSubjectDigestSha256,
    });
    const revokePath =
      `/internal/v1/shard-placement/authorizations/${fixture.permit.authorization_id_sha256}/revoke`;
    const revokeRequest = await signedAuthorityRequest({
      method: "POST",
      pathAndQuery: revokePath,
      role: "revoke",
      body: revocation.body,
      requestId: "placement-revoke-1",
    });
    const revoke = await SELF.fetch(revokeRequest);
    expect(revoke.status).toBe(201);
    expect(await revoke.json()).toMatchObject({
      result: "revoked",
      reasonCode: "operator_abort",
    });

    const readAfterRevoke = await SELF.fetch(
      await signedAuthorityRequest({
        method: "GET",
        pathAndQuery:
          `/internal/v1/shard-placement/authorizations/${fixture.permit.authorization_id_sha256}${query}`,
        role: "read",
        requestId: "placement-read-2",
      }),
    );
    expect(await readAfterRevoke.json()).toMatchObject({
      authorization: {
        status: "revoked",
        revocation: {
          reasonCode: "operator_abort",
          evidenceSha256: "8".repeat(64),
        },
      },
    });
  });

  it("rejects wrong-role HMAC and conflicting replay", async () => {
    const fixture = await signedPlacementAuthorityIssuance();
    const wrongRoleRequest = await signedAuthorityRequest({
      method: "POST",
      pathAndQuery: "/internal/v1/shard-placement/authorizations",
      role: "read",
      body: fixture.body,
      requestId: "wrong-role-1",
    });
    const wrongRole = await SELF.fetch(wrongRoleRequest);
    expect(wrongRole.status).toBe(403);
    expect(await wrongRole.json()).toEqual({
      error: "invalid_authority",
    });

    expect((await issue(fixture.body, "first-issue")).status).toBe(201);
    const conflict = await signedPlacementAuthorityIssuance({
      permitOverrides: {
        execution_nonce_sha256: "e".repeat(64),
      },
    });
    const conflicting = await issue(
      conflict.body,
      "conflicting-issue",
    );
    expect(conflicting.status).toBe(409);
    expect(await conflicting.json()).toEqual({
      error: "authorization_conflict",
    });
  });

  it("keeps operation-5 dispatch preparation default-off", async () => {
    const authorizationIdSha256 = "a".repeat(64);
    const pathAndQuery =
      `/internal/v1/shard-placement/execution-claims/${authorizationIdSha256}/prepare-enable-dispatch`;
    const request = await signedAuthorityRequest({
      method: "POST",
      pathAndQuery,
      role: "dispatch",
      body: "{}",
      requestId: "dispatch-default-off-1",
    });
    const response = await SELF.fetch(request);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "authority_pre_dispatch_reads_disabled",
    });
  });

  it("linearizes execution claims and enforces disable-first recovery", async () => {
    const issuance = await signedPlacementAuthorityIssuance();
    expect((await issue(issuance.body, "execution-issue")).status).toBe(201);

    const claim = await placementExecutionClaim({ issuance });
    const claimResponses = await Promise.all([
      createClaim(claim),
      createClaim(claim),
    ]);
    expect(claimResponses.map((response) => response.status).sort()).toEqual([
      200, 201,
    ]);
    const claimPayloads = await Promise.all(
      claimResponses.map((response) => response.json()),
    );
    expect(claimPayloads.map((payload) => payload.result).sort()).toEqual([
      "created",
      "exact_replay",
    ]);
    expect(claimPayloads[0].snapshot).toMatchObject({
      claim: {
        authorizationIdSha256:
          issuance.permit.authorization_id_sha256,
        claimDigestSha256: claim.value.claimDigestSha256,
      },
      state: {
        status: "claimed",
        leaseGeneration: 1,
        nextOperationOrdinal: 4,
        receiptCount: 1,
        receiptHeadSha256:
          claim.value.claimAcquiredReceiptSha256,
      },
    });

    const prematureEnable = await placementExecutionReceipt({
      claim: claim.value,
      sequence: 2,
      eventKind: "operation_started",
      operationOrdinal: 5,
    });
    const prematureEnableResponse = await appendExecutionReceipt(
      claim.value.authorizationIdSha256,
      "receipts",
      prematureEnable,
    );
    expect(prematureEnableResponse.status).toBe(409);
    expect(await prematureEnableResponse.json()).toEqual({
      error: "dedicated_operation_route_required",
    });

    const applicationActivationDigestSha256 = "d".repeat(64);
    const operationFourRequestId = "placement-operation4-activation-1";
    const started = await placementExecutionReceipt({
      claim: claim.value,
      sequence: 2,
      eventKind: "operation_started",
      operationOrdinal: 4,
      evidenceSha256: applicationActivationDigestSha256,
      requestId: operationFourRequestId,
    });
    const genericOperationFour = await appendExecutionReceipt(
      claim.value.authorizationIdSha256,
      "receipts",
      started,
    );
    expect(genericOperationFour.status).toBe(409);
    expect(await genericOperationFour.json()).toEqual({
      error: "dedicated_operation_route_required",
    });

    const revocation = await placementAuthorityRevocation({
      authorizationIdSha256:
        issuance.permit.authorization_id_sha256,
      permitSubjectDigestSha256:
        issuance.permitSubjectDigestSha256,
    });
    const revoke = await SELF.fetch(await signedAuthorityRequest({
      method: "POST",
      pathAndQuery:
        `/internal/v1/shard-placement/authorizations/${issuance.permit.authorization_id_sha256}/revoke`,
      role: "revoke",
      body: revocation.body,
      requestId: "execution-revoke",
    }));
    expect(revoke.status).toBe(201);
    const fenced = await env.DB.prepare(
      `SELECT status, ledger_version, enable_intent_seen,
              ticket_activation_confirmed
       FROM shard_placement_authority_execution_claims
       WHERE authorization_id_sha256 = ?1`,
    )
      .bind(claim.value.authorizationIdSha256)
      .first();
    expect(fenced).toEqual({
      status: "revoked",
      ledger_version: 1,
      enable_intent_seen: 0,
      ticket_activation_confirmed: 0,
    });
  });
});

async function issue(body, requestId) {
  return SELF.fetch(await signedAuthorityRequest({
    method: "POST",
    pathAndQuery: "/internal/v1/shard-placement/authorizations",
    role: "issue",
    body,
    requestId,
  }));
}

async function createClaim(fixture) {
  return SELF.fetch(await signedAuthorityRequest({
    method: "POST",
    pathAndQuery:
      "/internal/v1/shard-placement/execution-claims",
    role: "claim",
    body: fixture.body,
    requestId: fixture.requestId,
  }));
}

async function appendExecutionReceipt(
  authorizationIdSha256,
  action,
  fixture,
) {
  return SELF.fetch(await signedAuthorityRequest({
    method: "POST",
    pathAndQuery:
      `/internal/v1/shard-placement/execution-claims/${authorizationIdSha256}/${action}`,
    role: fixture.role,
    body: fixture.body,
    requestId: fixture.requestId,
  }));
}
