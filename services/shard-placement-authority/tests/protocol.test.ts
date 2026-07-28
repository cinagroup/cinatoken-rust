import { describe, expect, it } from "vitest";

import {
  ProtocolError,
  canonicalJson,
  parseExactAuthorizationQuery,
  parseIssuanceRequest,
  parseRevocationRequest,
  sha256Hex,
  verifyHmacRequest,
} from "../src/protocol";
import { validateRuntimeTrustConfiguration } from "../src/index";
import {
  parseExecutionClaim,
  parseExecutionReceipt,
  parseExactExecutionClaimQuery,
} from "../src/execution_protocol";
import {
  placementExecutionClaim,
  placementExecutionReceipt,
  placementAuthorityRevocation,
  shardPlacementAuthorityEnv,
  signedAuthorityRequest,
  signedPlacementAuthorityIssuance,
} from "../../../tests/fixtures/shard-placement-authority-fixture.mjs";

describe("shard placement Authority protocol", () => {
  it("verifies the exact permit and four isolated approvals", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const fixture = await signedPlacementAuthorityIssuance({ now });
    const verified = await parseIssuanceRequest(
      new TextEncoder().encode(fixture.body),
      shardPlacementAuthorityEnv(),
      now,
    );

    expect(verified.permitSubjectDigestSha256).toBe(
      fixture.permitSubjectDigestSha256,
    );
    expect(verified.approvals.map((approval) => approval.role)).toEqual([
      "security",
      "operations",
      "release",
      "rollback",
    ]);
    expect(new Set(
      verified.approvals.map((approval) => approval.spkiSha256),
    ).size).toBe(4);
    expect(JSON.stringify(verified)).not.toContain("signature_base64url");
    expect(JSON.stringify(verified)).not.toContain("spki_base64url");
    expect(JSON.stringify(verified)).not.toContain("private");
  });

  it("rejects permit, policy, approval, and key-isolation drift", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const fixture = await signedPlacementAuthorityIssuance({ now });

    const tamperedPermit = structuredClone(fixture.envelope);
    tamperedPermit.permit.controller_version_id = "tampered-version";
    await expect(parseIssuanceRequest(
      new TextEncoder().encode(canonicalJson(tamperedPermit)),
      shardPlacementAuthorityEnv(),
      now,
    )).rejects.toMatchObject({ code: "invalid_permit", status: 403 });

    const wrongPolicy = structuredClone(fixture.envelope);
    wrongPolicy.policy_sha256 = "0".repeat(64);
    await expect(parseIssuanceRequest(
      new TextEncoder().encode(canonicalJson(wrongPolicy)),
      shardPlacementAuthorityEnv(),
      now,
    )).rejects.toMatchObject({ code: "policy_mismatch", status: 403 });

    const reordered = structuredClone(fixture.envelope);
    [reordered.approvals[0], reordered.approvals[1]] = [
      reordered.approvals[1],
      reordered.approvals[0],
    ];
    await expect(parseIssuanceRequest(
      new TextEncoder().encode(canonicalJson(reordered)),
      shardPlacementAuthorityEnv(),
      now,
    )).rejects.toMatchObject({
      code: "approval_role_order_invalid",
      status: 403,
    });

    await expect(parseIssuanceRequest(
      new TextEncoder().encode(fixture.body),
      shardPlacementAuthorityEnv({
        SHARD_PLACEMENT_OPERATIONS_SPKI_BASE64URL:
          shardPlacementAuthorityEnv()
            .SHARD_PLACEMENT_SECURITY_SPKI_BASE64URL,
        SHARD_PLACEMENT_OPERATIONS_SPKI_SHA256:
          shardPlacementAuthorityEnv()
            .SHARD_PLACEMENT_SECURITY_SPKI_SHA256,
      }),
      now,
    )).rejects.toMatchObject({
      code: "invalid_approval",
      status: 403,
    });
  });

  it("enforces permit and approval windows", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const expired = await signedPlacementAuthorityIssuance({
      now,
      permitOverrides: {
        issued_at: now - 601,
        expires_at: now - 1,
      },
    });
    await expect(parseIssuanceRequest(
      new TextEncoder().encode(expired.body),
      shardPlacementAuthorityEnv(),
      now,
    )).rejects.toMatchObject({ code: "permit_time_window", status: 403 });

    const approvalExpired = await signedPlacementAuthorityIssuance({
      now,
      approvalOverrides: {
        security: { expires_at: now + 299 },
      },
    });
    await expect(parseIssuanceRequest(
      new TextEncoder().encode(approvalExpired.body),
      shardPlacementAuthorityEnv(),
      now,
    )).rejects.toMatchObject({
      code: "approval_time_window",
      status: 403,
    });
  });

  it("requires canonical bounded JSON", async () => {
    const fixture = await signedPlacementAuthorityIssuance();
    await expect(parseIssuanceRequest(
      new TextEncoder().encode(` ${fixture.body}`),
      shardPlacementAuthorityEnv(),
    )).rejects.toMatchObject({ code: "noncanonical_json", status: 400 });

    const unknown = structuredClone(fixture.envelope);
    unknown.extra = true;
    await expect(parseIssuanceRequest(
      new TextEncoder().encode(canonicalJson(unknown)),
      shardPlacementAuthorityEnv(),
    )).rejects.toMatchObject({ code: "invalid_shape", status: 400 });
  });

  it("binds HMAC role, path, body, and credential identity", async () => {
    const fixture = await signedPlacementAuthorityIssuance();
    const request = await signedAuthorityRequest({
      method: "POST",
      pathAndQuery: "/internal/v1/shard-placement/authorizations",
      role: "issue",
      body: fixture.body,
      requestId: "issue-protocol-1",
    });
    const verified = await verifyHmacRequest(
      request,
      new TextEncoder().encode(fixture.body),
      "issue",
      shardPlacementAuthorityEnv(),
    );
    expect(verified).toMatchObject({
      role: "issue",
      requestId: "issue-protocol-1",
      credentialIdSha256: "b".repeat(64),
    });

    await expect(verifyHmacRequest(
      request,
      new TextEncoder().encode(fixture.body),
      "read",
      shardPlacementAuthorityEnv(),
    )).rejects.toBeInstanceOf(ProtocolError);
  });

  it("requires complete and globally isolated HMAC rotation slots", () => {
    expect(() => validateRuntimeTrustConfiguration(
      shardPlacementAuthorityEnv(),
    )).not.toThrow();

    for (const environment of [
      shardPlacementAuthorityEnv({
        SHARD_PLACEMENT_REVOKE_HMAC_CURRENT_SECRET:
          shardPlacementAuthorityEnv()
            .SHARD_PLACEMENT_ISSUE_HMAC_CURRENT_SECRET,
      }),
      shardPlacementAuthorityEnv({
        SHARD_PLACEMENT_REVOKE_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
          shardPlacementAuthorityEnv()
            .SHARD_PLACEMENT_ISSUE_HMAC_CURRENT_CREDENTIAL_ID_SHA256,
      }),
      shardPlacementAuthorityEnv({
        SHARD_PLACEMENT_READ_HMAC_PREVIOUS_KID: "read-previous-test-v1",
      }),
      shardPlacementAuthorityEnv({
        SHARD_PLACEMENT_READ_HMAC_PREVIOUS_KID: "read-previous-test-v1",
        SHARD_PLACEMENT_READ_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256:
          "d".repeat(64),
        SHARD_PLACEMENT_READ_HMAC_PREVIOUS_SECRET:
          shardPlacementAuthorityEnv()
            .SHARD_PLACEMENT_READ_HMAC_CURRENT_SECRET,
      }),
    ]) {
      expect(() => validateRuntimeTrustConfiguration(
        environment,
      )).toThrowError(ProtocolError);
    }
  });

  it("validates exact read queries and revocation digests", async () => {
    const fixture = await signedPlacementAuthorityIssuance();
    const query = new URL(
      `https://authority.test/path?permitSubjectDigestSha256=${fixture.permitSubjectDigestSha256}&campaignId=${fixture.permit.campaign_id}`,
    );
    expect(parseExactAuthorizationQuery(query)).toEqual({
      permitSubjectDigestSha256: fixture.permitSubjectDigestSha256,
      campaignId: fixture.permit.campaign_id,
    });

    const revocation = await placementAuthorityRevocation({
      authorizationIdSha256:
        fixture.permit.authorization_id_sha256,
      permitSubjectDigestSha256:
        fixture.permitSubjectDigestSha256,
    });
    expect(await parseRevocationRequest(
      new TextEncoder().encode(revocation.body),
    )).toMatchObject({
      reasonCode: "operator_abort",
      authorizationIdSha256:
        fixture.permit.authorization_id_sha256,
    });

    const tampered = {
      ...revocation.value,
      evidenceSha256: "0".repeat(64),
    };
    await expect(parseRevocationRequest(
      new TextEncoder().encode(canonicalJson(tampered)),
    )).rejects.toMatchObject({
      code: "revocation_digest_mismatch",
      status: 400,
    });
  });

  it("freezes the exact 11-operation execution claim", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const fixture = await placementExecutionClaim({ now });
    const claim = await parseExecutionClaim(
      new TextEncoder().encode(fixture.body),
      {
        role: "claim",
        credentialIdSha256: "d".repeat(64),
        keyId: "claim-hmac-test-v1",
        bodySha256: await sha256Hex(
          new TextEncoder().encode(fixture.body),
        ),
        requestId: fixture.requestId,
      },
      now,
    );
    expect(claim.operations).toHaveLength(11);
    expect(claim.operations[0]).toMatchObject({
      ordinal: 4,
      kind: "activate_execution_ticket",
      shardIndex: null,
    });
    expect(claim.operations[1]).toMatchObject({
      ordinal: 5,
      kind: "enable_controller_deployment",
      shardIndex: null,
    });
    expect(claim.operations.slice(2, 10).map(
      (operation) => operation.shardIndex,
    )).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(claim.operations[10]).toMatchObject({
      ordinal: 14,
      kind: "disable_controller_deployment",
      shardIndex: null,
    });

    const drifted = structuredClone(fixture.value);
    drifted.operations[2].shardIndex = 7;
    await expect(parseExecutionClaim(
      new TextEncoder().encode(canonicalJson(drifted)),
      {
        role: "claim",
        credentialIdSha256: "d".repeat(64),
        keyId: "claim-hmac-test-v1",
        bodySha256: await sha256Hex(
          new TextEncoder().encode(canonicalJson(drifted)),
        ),
        requestId: fixture.requestId,
      },
      now,
    )).rejects.toMatchObject({
      code: "operation_schedule_invalid",
      status: 400,
    });
  });

  it("binds every execution receipt to its predecessor and phase", async () => {
    const claimFixture = await placementExecutionClaim();
    const started = await placementExecutionReceipt({
      claim: claimFixture.value,
      sequence: 2,
      operationOrdinal: 4,
      eventKind: "operation_started",
    });
    expect(await parseExecutionReceipt(
      new TextEncoder().encode(started.body),
      {
        role: "receipt",
        credentialIdSha256: "e".repeat(64),
        keyId: "receipt-hmac-test-v1",
        bodySha256: await sha256Hex(
          new TextEncoder().encode(started.body),
        ),
        requestId: started.requestId,
      },
      new Set(["operation_started", "operation_terminal"]),
    )).toMatchObject({
      sequence: 2,
      eventKind: "operation_started",
      outcome: "pending",
    });

    const invalid = structuredClone(started.value);
    invalid.outcome = "exact_success";
    invalid.receiptDigestSha256 = await sha256Hex(
      new TextEncoder().encode(canonicalJson(
        Object.fromEntries(
          Object.entries(invalid).filter(
            ([key]) => key !== "receiptDigestSha256",
          ),
        ),
      )),
    );
    await expect(parseExecutionReceipt(
      new TextEncoder().encode(canonicalJson(invalid)),
      {
        role: "receipt",
        credentialIdSha256: "e".repeat(64),
        keyId: "receipt-hmac-test-v1",
        bodySha256: await sha256Hex(
          new TextEncoder().encode(canonicalJson(invalid)),
        ),
        requestId: started.requestId,
      },
      new Set(["operation_started", "operation_terminal"]),
    )).rejects.toMatchObject({
      code: "operation_receipt_invalid",
      status: 400,
    });

    const query = new URL(
      `https://authority.test/path?claimDigestSha256=${claimFixture.value.claimDigestSha256}`
      + `&claimOwnerSha256=${claimFixture.value.claimOwnerSha256}`,
    );
    expect(parseExactExecutionClaimQuery(query)).toEqual({
      claimDigestSha256: claimFixture.value.claimDigestSha256,
      claimOwnerSha256: claimFixture.value.claimOwnerSha256,
    });
  });

  it("separates lease recovery from normal operation receipts", async () => {
    const claimFixture = await placementExecutionClaim();
    const takeoverToken = await sha256Hex(
      new TextEncoder().encode("placement-lease-token-generation-2"),
    );
    const renewed = await placementExecutionReceipt({
      claim: claimFixture.value,
      sequence: 2,
      eventKind: "lease_renewed",
    });
    const authentication = {
      role: "recovery" as const,
      credentialIdSha256: "f".repeat(64),
      keyId: "recovery-hmac-test-v1",
      bodySha256: await sha256Hex(
        new TextEncoder().encode(renewed.body),
      ),
      requestId: renewed.requestId,
    };
    await expect(parseExecutionReceipt(
      new TextEncoder().encode(renewed.body),
      authentication,
      new Set(["lease_renewed", "lease_taken_over"]),
    )).resolves.toMatchObject({
      eventKind: "lease_renewed",
      leaseGeneration: 1,
      leaseTokenSha256: claimFixture.value.leaseTokenSha256,
      operationOrdinal: 3,
      operationKind: "create_authority_claim",
    });
    await expect(parseExecutionReceipt(
      new TextEncoder().encode(renewed.body),
      authentication,
      new Set(["operation_started", "operation_terminal"]),
    )).rejects.toMatchObject({
      code: "execution_event_role_mismatch",
      status: 403,
    });

    const takeover = await placementExecutionReceipt({
      claim: claimFixture.value,
      sequence: 2,
      eventKind: "lease_taken_over",
      leaseGeneration: 2,
      leaseTokenSha256: takeoverToken,
      actorOwnerSha256: "0".repeat(64),
    });
    await expect(parseExecutionReceipt(
      new TextEncoder().encode(takeover.body),
      {
        ...authentication,
        bodySha256: await sha256Hex(
          new TextEncoder().encode(takeover.body),
        ),
        requestId: takeover.requestId,
      },
      new Set(["lease_renewed", "lease_taken_over"]),
    )).resolves.toMatchObject({
      eventKind: "lease_taken_over",
      leaseGeneration: 2,
      actorOwnerSha256: "0".repeat(64),
    });

    const safety = await placementExecutionReceipt({
      claim: claimFixture.value,
      sequence: 2,
      eventKind: "safety_diverted",
      safetyReason: "lease_revoked",
    });
    await expect(parseExecutionReceipt(
      new TextEncoder().encode(safety.body),
      {
        ...authentication,
        bodySha256: await sha256Hex(
          new TextEncoder().encode(safety.body),
        ),
        requestId: safety.requestId,
      },
      new Set(["safety_diverted"]),
    )).resolves.toMatchObject({
      eventKind: "safety_diverted",
      operationOrdinal: 14,
      operationKind: "disable_controller_deployment",
      outcome: "disable_required",
      safetyReason: "lease_revoked",
    });
  });
});
