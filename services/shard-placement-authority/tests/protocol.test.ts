import { describe, expect, it } from "vitest";

import {
  ProtocolError,
  canonicalJson,
  parseExactAuthorizationQuery,
  parseIssuanceRequest,
  parseRevocationRequest,
  verifyHmacRequest,
} from "../src/protocol";
import { validateRuntimeTrustConfiguration } from "../src/index";
import {
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
});
