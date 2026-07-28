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
      error: "execution_receipt_conflict",
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
    expect((await appendExecutionReceipt(
      claim.value.authorizationIdSha256,
      "receipts",
      started,
    )).status).toBe(201);

    const terminal = await placementExecutionReceipt({
      claim: claim.value,
      sequence: 3,
      eventKind: "operation_terminal",
      operationOrdinal: 4,
      predecessorReceiptSha256: started.value.receiptDigestSha256,
      outcome: "exact_success",
      evidenceSha256: applicationActivationDigestSha256,
      requestId: operationFourRequestId,
    });
    const activated = await appendExecutionReceipt(
      claim.value.authorizationIdSha256,
      "receipts",
      terminal,
    );
    expect(activated.status).toBe(201);
    expect(await activated.json()).toMatchObject({
      nextOperationOrdinal: 5,
      ticketActivationConfirmed: true,
      applicationActivationDigestSha256:
        terminal.value.evidenceSha256,
    });

    const enableStart = await placementExecutionReceipt({
      claim: claim.value,
      sequence: 4,
      eventKind: "operation_started",
      operationOrdinal: 5,
      predecessorReceiptSha256: terminal.value.receiptDigestSha256,
    });
    expect((await appendExecutionReceipt(
      claim.value.authorizationIdSha256,
      "receipts",
      enableStart,
    )).status).toBe(201);

    const enableTerminal = await placementExecutionReceipt({
      claim: claim.value,
      sequence: 5,
      eventKind: "operation_terminal",
      operationOrdinal: 5,
      predecessorReceiptSha256:
        enableStart.value.receiptDigestSha256,
      outcome: "exact_success",
    });
    expect((await appendExecutionReceipt(
      claim.value.authorizationIdSha256,
      "receipts",
      enableTerminal,
    )).status).toBe(201);

    await waitForDatabaseTimeAfter(
      claimPayloads[0].snapshot.state.leaseExpiresAt - 60,
    );
    const renewal = await placementExecutionReceipt({
      claim: claim.value,
      sequence: 6,
      eventKind: "lease_renewed",
      predecessorReceiptSha256:
        enableTerminal.value.receiptDigestSha256,
    });
    const renewed = await appendExecutionReceipt(
      claim.value.authorizationIdSha256,
      "renew",
      renewal,
    );
    expect(renewed.status).toBe(201);
    const renewedPayload = await renewed.json();
    expect(renewedPayload).toMatchObject({
      result: "receipt_appended",
      eventKind: "lease_renewed",
      leaseGeneration: 1,
      receiptCount: 6,
      receiptDigestSha256: renewal.value.receiptDigestSha256,
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

    const forbiddenNext = await placementExecutionReceipt({
      claim: claim.value,
      sequence: 7,
      eventKind: "operation_started",
      operationOrdinal: 6,
      predecessorReceiptSha256:
        renewal.value.receiptDigestSha256,
    });
    const rejected = await appendExecutionReceipt(
      claim.value.authorizationIdSha256,
      "receipts",
      forbiddenNext,
    );
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({
      error: "execution_receipt_conflict",
    });

    const safety = await placementExecutionReceipt({
      claim: claim.value,
      sequence: 7,
      eventKind: "safety_diverted",
      predecessorReceiptSha256:
        renewal.value.receiptDigestSha256,
      safetyReason: "lease_revoked",
    });
    const diverted = await appendExecutionReceipt(
      claim.value.authorizationIdSha256,
      "safety-divert",
      safety,
    );
    expect(diverted.status).toBe(201);
    expect(await diverted.json()).toMatchObject({
      eventKind: "safety_diverted",
      status: "disable_required",
      receiptCount: 7,
    });

    const disableStart = await placementExecutionReceipt({
      claim: claim.value,
      sequence: 8,
      eventKind: "operation_started",
      operationOrdinal: 14,
      predecessorReceiptSha256: safety.value.receiptDigestSha256,
    });
    const disable = await appendExecutionReceipt(
      claim.value.authorizationIdSha256,
      "receipts",
      disableStart,
    );
    expect(disable.status).toBe(201);
    expect(await disable.json()).toMatchObject({
      status: "disable_required",
      nextOperationOrdinal: 14,
      receiptCount: 8,
    });

    const lateReplay = await createClaim(claim);
    expect(lateReplay.status).toBe(200);
    expect(await lateReplay.json()).toMatchObject({
      result: "exact_replay",
      snapshot: {
        state: {
          status: "disable_required",
          receiptCount: 8,
        },
      },
    });
  });
});

async function waitForDatabaseTimeAfter(previousSecond) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const row = await env.DB.prepare(
      "SELECT unixepoch() AS database_now",
    ).first();
    if (row?.database_now > previousSecond) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("D1 database time did not advance");
}

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
