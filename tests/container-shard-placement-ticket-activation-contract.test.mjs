import { describe, expect, test } from "bun:test";

const rootConfig = Bun.TOML.parse(
  await Bun.file(new URL("../wrangler.toml", import.meta.url)).text(),
);
const packageJson = await Bun.file(
  new URL("../package.json", import.meta.url),
).json();
const libSource = await Bun.file(
  new URL("../crates/worker/src/lib.rs", import.meta.url),
).text();
const routeSource = await Bun.file(
  new URL(
    "../crates/worker/src/container_shard_placement_execution_ticket_admin.rs",
    import.meta.url,
  ),
).text();
const clientSource = await Bun.file(
  new URL(
    "../crates/worker/src/shard_placement_authority_client.rs",
    import.meta.url,
  ),
).text();
const repositorySource = await Bun.file(
  new URL("../crates/worker/src/d1_repositories.rs", import.meta.url),
).text();
const activationReadSource = await Bun.file(
  new URL(
    "../crates/worker/src/container_shard_placement_activation_read.rs",
    import.meta.url,
  ),
).text();
const acknowledgementSource = await Bun.file(
  new URL(
    "../crates/worker/src/container_shard_placement_authority_ack_admin.rs",
    import.meta.url,
  ),
).text();
const authorityActivationSource = await Bun.file(
  new URL(
    "../services/shard-placement-authority/src/activate_ticket.ts",
    import.meta.url,
  ),
).text();
const authorityClientSource = await Bun.file(
  new URL(
    "../services/shard-placement-authority/src/application_activation_client.ts",
    import.meta.url,
  ),
).text();
const authorityLocalConfig = JSON.parse(
  await Bun.file(
    new URL(
      "../services/shard-placement-authority/wrangler.jsonc",
      import.meta.url,
    ),
  ).text(),
);
const authorityStagingConfig = JSON.parse(
  await Bun.file(
    new URL(
      "../services/shard-placement-authority/wrangler.staging.jsonc",
      import.meta.url,
    ),
  ).text(),
);

const activationPath =
  "/api/platform/container/shards/placement-execution-tickets/:ticket_id/activate";

describe("application placement execution ticket activation contract", () => {
  test("registers one root-only bounded activation route", () => {
    expect(libSource).toContain(`"${activationPath}"`);
    expect(routeSource).toContain("require_root_auth(&req, &env)");
    expect(routeSource).toContain(
      "require_secure_verification(&req, &env, claims.id)",
    );
    expect(routeSource.indexOf("require_root_auth(&req, &env)")).toBeLessThan(
      routeSource.indexOf("read_request(&mut req)"),
    );
    expect(
      routeSource.indexOf(
        "require_secure_verification(&req, &env, claims.id)",
      ),
    ).toBeLessThan(routeSource.indexOf("read_request(&mut req)"));
    expect(routeSource).toContain("const BODY_LIMIT_BYTES: usize = 4 * 1024");
    expect(routeSource).toContain(
      'response.headers_mut().set("Cache-Control", "no-store")',
    );
  });

  test("does not accept deployment-owned authority facts from the caller", () => {
    const requestShape = routeSource
      .split("struct ActivateTicketRequest {")[1]
      .split("}")[0];
    expect(requestShape).toContain("authorization_id_sha256");
    expect(requestShape).toContain("authority_claim_digest_sha256");
    expect(requestShape).toContain("authority_claim_owner_sha256");
    expect(requestShape).toContain("activation_request_id");
    expect(requestShape).not.toContain("database_identity");
    expect(requestShape).not.toContain("ledger_identity");
    expect(requestShape).not.toContain("authority_version");
    expect(requestShape).not.toContain("receipt_sha256");
    expect(routeSource).toContain(
      'deployment_identity_sha256(&env, APPLICATION_DATABASE_IDENTITY_ENV)',
    );
    expect(routeSource).toContain(
      'deployment_identity_sha256(&env, AUTHORITY_DATABASE_IDENTITY_ENV)',
    );
    expect(routeSource).toContain(
      'deployment_identity_sha256(&env, AUTHORITY_LEDGER_IDENTITY_ENV)',
    );
  });

  test("reads the exact private Authority claim before any create-only write", () => {
    expect(routeSource).toContain("read_exact_execution_claim(");
    expect(routeSource).toContain("authority_claim_identity_matches(");
    expect(routeSource).toContain("authority_claim_is_activatable(");
    expect(routeSource).toContain("probe_container_controller(&env, runtime)");
    expect(routeSource).toContain(
      "activate_relay_container_shard_placement_execution_ticket(",
    );
    expect(
      routeSource.indexOf("read_exact_execution_claim("),
    ).toBeLessThan(
      routeSource.lastIndexOf(
        "activate_relay_container_shard_placement_execution_ticket(",
      ),
    );
    expect(
      routeSource.indexOf("authority_claim_is_activatable("),
    ).toBeLessThan(
      routeSource.lastIndexOf(
        "activate_relay_container_shard_placement_execution_ticket(",
      ),
    );
    expect(routeSource).toContain('result: "exact_replay"');
    expect(routeSource).toContain(
      "claim.claim_digest_sha256 == expected_claim_digest_sha256",
    );
    expect(routeSource).toContain("let admin_id = admin_id.to_string()");
    expect(routeSource.indexOf("if let Some(existing) = existing")).toBeLessThan(
      routeSource.indexOf("if !runtime_flag(&env, WRITE_ENABLED_ENV)"),
    );
  });

  test("uses a signed bounded Service Binding read instead of public HTTP", () => {
    expect(clientSource).toContain(
      'pub const SHARD_PLACEMENT_AUTHORITY_BINDING: &str = "SHARD_PLACEMENT_AUTHORITY"',
    );
    expect(clientSource).toContain(
      ".service(SHARD_PLACEMENT_AUTHORITY_BINDING)",
    );
    expect(clientSource).toContain(
      "cinatoken-shard-placement-authority-v1\\n",
    );
    expect(clientSource).toContain("Hmac::<Sha256>::new_from_slice");
    expect(clientSource).toContain(
      "RELAY_CONTAINER_SHARD_PLACEMENT_AUTHORITY_READ_HMAC_CURRENT_SECRET",
    );
    expect(clientSource).toContain(
      ".secret(SHARD_PLACEMENT_AUTHORITY_READ_HMAC_SECRET_ENV)",
    );
    expect(clientSource).toContain("READ_RESPONSE_MAX_BYTES");
    expect(clientSource).toContain("read_response_bytes_limited");
    expect(clientSource).toContain("RequestRedirect::Error");
    expect(clientSource).not.toContain("CLOUDFLARE_API_TOKEN");
  });

  test("keeps the private binding and both writers absent or default-off", () => {
    for (const [scope, authorityService] of [
      [rootConfig, "cinatoken-shard-placement-authority-local"],
      [rootConfig.env.staging, "cinatoken-shard-placement-authority-staging"],
    ]) {
      expect(scope.services).toContainEqual({
        binding: "SHARD_PLACEMENT_AUTHORITY",
        service: authorityService,
      });
      expect(
        scope.vars.RELAY_CONTAINER_SHARD_PLACEMENT_AUTHORITY_READ_ENABLED,
      ).toBe("false");
      expect(
        scope.vars
          .RELAY_CONTAINER_SHARD_PLACEMENT_TICKET_ACTIVATION_WRITE_ENABLED,
      ).toBe("false");
      expect(
        scope.vars
          .RELAY_CONTAINER_SHARD_PLACEMENT_AUTHORITY_READ_HMAC_CURRENT_SECRET,
      ).toBeUndefined();
    }
    expect(rootConfig.env.production.services).not.toContainEqual(
      expect.objectContaining({ binding: "SHARD_PLACEMENT_AUTHORITY" }),
    );
    for (const name of [
      "RELAY_CONTAINER_SHARD_PLACEMENT_AUTHORITY_READ_ENABLED",
      "RELAY_CONTAINER_SHARD_PLACEMENT_AUTHORITY_ISSUER",
      "RELAY_CONTAINER_SHARD_PLACEMENT_AUTHORITY_AUDIENCE",
      "RELAY_CONTAINER_SHARD_PLACEMENT_AUTHORITY_READ_HMAC_CURRENT_KID",
      "RELAY_CONTAINER_SHARD_PLACEMENT_AUTHORITY_READ_HMAC_CURRENT_CREDENTIAL_ID_SHA256",
      "RELAY_CONTAINER_SHARD_PLACEMENT_AUTHORITY_READ_HMAC_CURRENT_SECRET",
      "RELAY_CONTAINER_SHARD_PLACEMENT_TICKET_ACTIVATION_WRITE_ENABLED",
      "RELAY_CONTAINER_SHARD_APPLICATION_DATABASE_IDENTITY_SHA256",
      "RELAY_CONTAINER_SHARD_AUTHORITY_DATABASE_IDENTITY_SHA256",
      "RELAY_CONTAINER_SHARD_AUTHORITY_LEDGER_IDENTITY_SHA256",
    ]) {
      expect(rootConfig.env.production.vars[name]).toBeUndefined();
    }
  });

  test("writes activation, admin audit, and exact readback in one D1 batch", () => {
    expect(repositorySource).toContain(
      "INSERT INTO relay_container_shard_placement_execution_ticket_activations",
    );
    expect(repositorySource).not.toContain(
      "INSERT OR IGNORE INTO relay_container_shard_placement_execution_ticket_activations",
    );
    expect(repositorySource).toContain(
      "CAST(?12 AS INTEGER), unixepoch()",
    );
    expect(repositorySource).toContain(
      "db.batch(vec![insert, admin_audit, readback])",
    );
    expect(repositorySource).toContain("if results.len() != 3");
    expect(repositorySource).not.toContain(
      '.expect("shard placement execution ticket activation readback exists")',
    );
    expect(repositorySource).toContain(
      "relay_container_shard_placement_execution_ticket_activation_context",
    );
    expect(repositorySource).toContain(
      "LEFT JOIN relay_container_shard_activation_campaign_seals AS seal",
    );
  });

  test("exposes one strict application activation read boundary", () => {
    expect(libSource).toContain(
      '"/internal/v1/shard-placement/execution-ticket-activations/:ticket_id"',
    );
    expect(activationReadSource).toContain(
      '"x-cinatoken-shard-placement-application"',
    );
    expect(activationReadSource).toContain(
      "cinatoken-shard-placement-application-v1\\n",
    );
    expect(activationReadSource).toContain(
      'claims.role != "activation_read"',
    );
    expect(activationReadSource).toContain(
      "request_has_forbidden_ambient_headers(&req)",
    );
    expect(activationReadSource.indexOf("verify_token(")).toBeLessThan(
      activationReadSource.indexOf('env.d1("DB")'),
    );
    expect(activationReadSource).toContain(
      "relay_container_shard_placement_execution_ticket_activation_read_snapshot",
    );
    expect(activationReadSource).toContain(
      'response.headers_mut().set("Cache-Control", "no-store")',
    );
  });

  test("persists Authority operation-4 start before application read", () => {
    const startAppend = authorityActivationSource.indexOf(
      "const appended = await dependencies.appendReceipt(",
    );
    const applicationRead = authorityActivationSource.indexOf(
      "const readback = await dependencies.readActivation(",
    );
    const terminalBuild = authorityActivationSource.indexOf(
      "const terminal = await buildOperationReceipt(",
    );
    expect(startAppend).toBeGreaterThan(-1);
    expect(startAppend).toBeLessThan(applicationRead);
    expect(applicationRead).toBeLessThan(terminalBuild);
    expect(authorityActivationSource).toContain(
      "requireRecoverableOperationFour(snapshot, operation, requestSha256)",
    );
    expect(authorityActivationSource).toContain(
      "SHARD_PLACEMENT_AUTHORITY_ACTIVATION_WRITE_ENABLED",
    );
    expect(authorityClientSource).toContain(
      "SHARD_PLACEMENT_APPLICATION.fetch",
    );
    expect(authorityClientSource).toContain(
      '"x-cinatoken-shard-placement-application": token',
    );
    expect(authorityClientSource).toContain(
      "responseSha256: await sha256Hex(bytes)",
    );
  });

  test("records the exact Authority terminal in application D1", () => {
    const acknowledgementPath =
      "/api/platform/container/shards/placement-execution-tickets/:ticket_id/acknowledge-authority";
    expect(libSource).toContain(`"${acknowledgementPath}"`);
    expect(acknowledgementSource).toContain("require_root_auth(&req, &env)");
    expect(acknowledgementSource).toContain(
      "require_secure_verification(&req, &env, claims.id)",
    );
    expect(acknowledgementSource).toContain(
      "exact_operation_four_terminal(",
    );
    expect(acknowledgementSource).toContain(
      "fresh_operation_four_terminal(",
    );
    expect(acknowledgementSource).toContain(
      "acknowledge_relay_container_shard_placement_execution_ticket_authority",
    );
    expect(repositorySource).toContain(
      "INSERT INTO relay_container_shard_placement_execution_ticket_authority_acks",
    );
    expect(repositorySource).not.toContain(
      "INSERT OR IGNORE INTO relay_container_shard_placement_execution_ticket_authority_acks",
    );
  });

  test("keeps both operation-4 directions default-off and production-absent", () => {
    for (const config of [authorityLocalConfig, authorityStagingConfig]) {
      expect(config.services).toHaveLength(1);
      expect(config.services[0].binding).toBe(
        "SHARD_PLACEMENT_APPLICATION",
      );
      expect(
        config.vars.SHARD_PLACEMENT_AUTHORITY_ACTIVATION_READ_ENABLED,
      ).toBe("false");
      expect(
        config.vars.SHARD_PLACEMENT_AUTHORITY_ACTIVATION_WRITE_ENABLED,
      ).toBe("false");
      expect(
        config.vars
          .SHARD_PLACEMENT_APPLICATION_ACTIVATION_READ_HMAC_CURRENT_SECRET,
      ).toBeUndefined();
    }
    for (const scope of [rootConfig, rootConfig.env.staging]) {
      expect(
        scope.vars.RELAY_CONTAINER_SHARD_PLACEMENT_ACTIVATION_READ_ENABLED,
      ).toBe("false");
      expect(
        scope.vars
          .RELAY_CONTAINER_SHARD_PLACEMENT_TICKET_AUTHORITY_ACK_WRITE_ENABLED,
      ).toBe("false");
    }
    for (const name of [
      "RELAY_CONTAINER_SHARD_PLACEMENT_ACTIVATION_READ_ENABLED",
      "RELAY_CONTAINER_SHARD_PLACEMENT_TICKET_AUTHORITY_ACK_WRITE_ENABLED",
      "RELAY_CONTAINER_SHARD_PLACEMENT_ACTIVATION_READ_HMAC_CURRENT_SECRET",
    ]) {
      expect(rootConfig.env.production.vars[name]).toBeUndefined();
    }
  });

  test("is included in the aggregate scheduler/config gate", () => {
    expect(packageJson.scripts["check:container-scheduler-config"]).toBe(
      'bun test --path-ignore-patterns="target/**" tests/container-scheduler-config.test.mjs tests/container-shard-placement-ticket-activation-contract.test.mjs',
    );
    expect(packageJson.scripts.check).toContain(
      "bun run check:container-scheduler-config",
    );
  });
});
