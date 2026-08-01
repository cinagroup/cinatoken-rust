import {
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { describe, expect, it } from "bun:test";

const sourcePath =
  "crates/drain-source-registration-coordinator/src/lib.rs";
const source = readFileSync(sourcePath, "utf8");
const workerEntrypoint = readFileSync("crates/worker/src/lib.rs", "utf8");
const applicationCeremonySource = readFileSync(
  "crates/worker/src/container_drain_source_registration_application_ceremony.rs",
  "utf8",
);
const applicationBeginSource = readFileSync(
  "crates/worker/src/container_drain_source_registration_application_begin.rs",
  "utf8",
);
const applicationBeginImplementation = applicationBeginSource.split(
  "#[cfg(test)]",
  1,
)[0];
const applicationOrchestratorSource = readFileSync(
  "crates/worker/src/container_drain_source_registration_application_orchestrator.rs",
  "utf8",
);
const applicationOrchestratorImplementation =
  applicationOrchestratorSource.split("#[cfg(test)]", 1)[0];
const applicationSessionSource = readFileSync(
  "crates/worker/src/container_drain_source_registration_application_session.rs",
  "utf8",
);
const applicationSessionImplementation = applicationSessionSource.split(
  "#[cfg(test)]",
  1,
)[0];
const passkeyCeremonySource = readFileSync(
  "crates/worker/src/passkey_ceremony.rs",
  "utf8",
);
const packageSource = readFileSync("package.json", "utf8");
const serviceSource = readFileSync(
  "services/drain-source-registration-coordinator/src/index.mjs",
  "utf8",
);
const serviceAdapterSource = readFileSync(
  "services/drain-source-registration-coordinator/src/adapter.mjs",
  "utf8",
);
const localServiceConfig = JSON.parse(
  readFileSync(
    "services/drain-source-registration-coordinator/wrangler.jsonc",
    "utf8",
  ),
);
const stagingServiceConfig = JSON.parse(
  readFileSync(
    "services/drain-source-registration-coordinator/wrangler.staging.jsonc",
    "utf8",
  ),
);
const applicationConfig = Bun.TOML.parse(
  readFileSync("wrangler.toml", "utf8"),
);
const runtimeFixture = readFileSync(
  "tests/fixtures/do-runtime-worker.mjs",
  "utf8",
);
const runtimeConfig = readFileSync("vitest.do.config.mjs", "utf8");

const binding = "DRAIN_SOURCE_REGISTRATION_COORDINATORS";
const className = "DrainSourceRegistrationCoordinator";

describe("drain-source registration coordinator DO source contract", () => {
  it("is hosted by an isolated route-free Worker and remains compatible with the DO test harness", () => {
    expect(workerEntrypoint).toContain(
      "pub use cinatoken_drain_source_registration_coordinator::DrainSourceRegistrationCoordinator;",
    );
    expect(runtimeFixture).toContain(className);
    expect(runtimeConfig).toContain(`${binding}: {`);
    expect(runtimeConfig).toContain(`className: "${className}"`);
    expect(runtimeConfig).toContain("useSQLite: true");
    expect(serviceSource).toContain(
      "../../../crates/drain-source-registration-coordinator/build/index.js",
    );
    expect(serviceSource).not.toContain("../../../crates/worker/build/index.js");
    expect(serviceAdapterSource).toContain("return await stub.fetch(");
    expect(serviceAdapterSource).toContain("async function verifyAuthority(");
    expect(serviceAdapterSource).toContain("async function verifyHmac(");
    expect(serviceAdapterSource).toContain(
      "async function coordinatorObjectName(",
    );
    expect(serviceAdapterSource).toContain("const MAX_BODY_BYTES = 16 * 1024;");
    expect(serviceAdapterSource).toContain(
      'request.headers.has("authorization")',
    );
    expect(serviceAdapterSource.indexOf("await verifyAuthority(")).toBeLessThan(
      serviceAdapterSource.indexOf(
        "namespace.getByName(authentication.objectName)",
      ),
    );
    expect(serviceSource).not.toContain("console.");
    expect(serviceAdapterSource).not.toContain("console.");

    for (const [environment, config] of [
      ["local", localServiceConfig],
      ["staging", stagingServiceConfig],
    ]) {
      expect(Object.keys(config).sort()).toEqual(
        [
          "$schema",
          "build",
          "compatibility_date",
          "durable_objects",
          "main",
          "migrations",
          "name",
          "observability",
          "preview_urls",
          "vars",
          "version_metadata",
          "workers_dev",
        ].sort(),
      );
      expect(config.name).toBe(
        `cinatoken-drain-source-registration-coordinator-${environment}`,
      );
      expect(config.main).toBe("src/index.mjs");
      expect(config.workers_dev).toBeFalse();
      expect(config.preview_urls).toBeFalse();
      expect(config.route).toBeUndefined();
      expect(config.routes).toBeUndefined();
      expect(config.build).toEqual({
        command:
          "bun tools/build_worker.mjs --crate drain-source-registration-coordinator --release",
        watch_dir: [
          "crates/drain-source-registration-coordinator",
          "services/drain-source-registration-coordinator/src",
        ],
      });
      expect(config.vars).toMatchObject({
        DRAIN_SOURCE_REGISTRATION_COORDINATOR_ENVIRONMENT: environment,
        DRAIN_SOURCE_REGISTRATION_COORDINATOR_ENABLED: "false",
      });
      expect(config.durable_objects).toEqual({
        bindings: [{ name: binding, class_name: className }],
      });
      expect(config.migrations).toEqual([
        {
          tag: "v1-drain-source-registration-coordinator",
          new_sqlite_classes: [className],
        },
      ]);
      for (const secret of [
        "DRAIN_SOURCE_REGISTRATION_COORDINATOR_HMAC_CURRENT_SECRET",
        "DRAIN_SOURCE_REGISTRATION_COORDINATOR_HMAC_PREVIOUS_SECRET",
      ]) {
        expect(config.vars[secret]).toBeUndefined();
      }
      for (const capability of [
        "ai",
        "assets",
        "containers",
        "d1_databases",
        "dispatch_namespaces",
        "kv_namespaces",
        "queues",
        "r2_buckets",
        "ratelimits",
        "services",
        "workflows",
      ]) {
        expect(config[capability]).toBeUndefined();
      }
    }

    expect(
      applicationConfig.services.find(({ binding: name }) => name ===
        "DRAIN_SOURCE_REGISTRATION_COORDINATOR"),
    ).toEqual({
      binding: "DRAIN_SOURCE_REGISTRATION_COORDINATOR",
      service: "cinatoken-drain-source-registration-coordinator-local",
    });
    expect(
      applicationConfig.env.staging.services.find(
        ({ binding: name }) =>
          name === "DRAIN_SOURCE_REGISTRATION_COORDINATOR",
      ),
    ).toEqual({
      binding: "DRAIN_SOURCE_REGISTRATION_COORDINATOR",
      service: "cinatoken-drain-source-registration-coordinator-staging",
    });
    for (const [scope, environment] of [
      [applicationConfig, "local"],
      [applicationConfig.env.staging, "staging"],
    ]) {
      expect(scope.vars).toMatchObject({
        DRAIN_SOURCE_REGISTRATION_COORDINATOR_CLIENT_ENABLED: "false",
        DRAIN_SOURCE_REGISTRATION_APPLICATION_BEGIN_ENABLED: "false",
        DRAIN_SOURCE_REGISTRATION_APPLICATION_CREDENTIAL_ID_SHA256: "",
        DRAIN_SOURCE_REGISTRATION_COORDINATOR_AUTHORITY_ISSUER:
          `cinatoken-rust-api-${environment}`,
        DRAIN_SOURCE_REGISTRATION_COORDINATOR_AUTHORITY_AUDIENCE:
          `cinatoken-drain-source-registration-coordinator-${environment}`,
        DRAIN_SOURCE_REGISTRATION_COORDINATOR_CALLER_IDENTITY_SHA256: "",
        DRAIN_SOURCE_REGISTRATION_COORDINATOR_HMAC_CURRENT_KID: "",
        DRAIN_SOURCE_REGISTRATION_PHASE_PROOF_CURRENT_KID: "",
        DRAIN_SOURCE_REGISTRATION_PHASE_PROOF_CURRENT_KEY_VERSION: "0",
      });
      expect(
        scope.vars.DRAIN_SOURCE_REGISTRATION_COORDINATOR_HMAC_CURRENT_SECRET,
      ).toBeUndefined();
      expect(
        scope.vars.DRAIN_SOURCE_REGISTRATION_PHASE_PROOF_CURRENT_SECRET,
      ).toBeUndefined();
    }
    expect(applicationConfig.env.production.services).not.toContainEqual(
      expect.objectContaining({
        binding: "DRAIN_SOURCE_REGISTRATION_COORDINATOR",
      }),
    );
    expect(
      Object.keys(applicationConfig.env.production.vars).filter((name) =>
        name.startsWith("DRAIN_SOURCE_REGISTRATION_"),
      ),
    ).toEqual([]);
    expect(
      trackedWranglerConfigurations(".").filter((path) =>
        /drain-source-registration-coordinator[\\/]wrangler/u.test(path),
      ),
    ).toHaveLength(2);
  });

  it("has no public Worker route or production call site", () => {
    for (const path of [
      "/v1/begin",
      "/v1/finish",
      "/v1/status",
      "/v1/recover",
    ]) {
      const escaped = path.replaceAll("/", "\\/");
      expect(workerEntrypoint).not.toMatch(
        new RegExp(`\\.post_async\\(\\s*"${escaped}"`, "u"),
      );
    }
    expect(workerEntrypoint.match(
      /cinatoken_drain_source_registration_coordinator/gu,
    )).toHaveLength(1);
    expect(source).not.toContain("Router::");
    expect(source).not.toContain("route_async(");
    const clientSource = readFileSync(
      "crates/worker/src/container_drain_source_registration_coordinator_client.rs",
      "utf8",
    );
    expect(workerEntrypoint).toContain(
      "mod container_drain_source_registration_coordinator_client;",
    );
    expect(clientSource).toContain(".service(COORDINATOR_SERVICE_BINDING)");
    expect(clientSource).toContain(
      "const CLIENT_TIMEOUT: Duration = Duration::from_secs(3);",
    );
    expect(clientSource).toContain(
      "read_response_bytes_limited(&mut response, MAX_RESPONSE_BYTES)",
    );
    expect(clientSource).toContain(".with_redirect(RequestRedirect::Error)");
    expect(clientSource).not.toContain("Router::");
    expect(clientSource).not.toContain("route_async(");
    expect(applicationOrchestratorImplementation).not.toContain("Router::");
    expect(applicationOrchestratorImplementation).not.toContain("route_async(");
    expect(applicationOrchestratorImplementation).not.toContain("Request::new");
    expect(applicationBeginImplementation).not.toContain("Router::");
    expect(applicationBeginImplementation).not.toContain("route_async(");
    expect(applicationBeginImplementation).not.toContain("Request::new");
    expect(applicationSessionImplementation).not.toContain("worker::Request");
    expect(applicationSessionImplementation).not.toContain("session_cookie(");
    expect(applicationSessionImplementation).not.toContain("username: String");
    expect(applicationSessionImplementation).not.toContain("group: String");
    expect(applicationSessionImplementation).not.toContain("session_id: String");
    expect(serviceSource).not.toContain("Router::");
    expect(serviceSource).not.toContain("route_async(");
    expect(serviceAdapterSource).not.toContain("Router::");
    expect(serviceAdapterSource).not.toContain("route_async(");
  });

  it("persists prepared application authority before bounded coordinator dispatch", () => {
    expect(applicationCeremonySource).toContain("Prepared,");
    expect(applicationCeremonySource).toContain("ChallengeIssued,");
    expect(applicationCeremonySource).toContain(
      "coordinator_status: Option<CoordinatorStatusResponseV1>",
    );
    expect(applicationCeremonySource).toContain(
      "pub(crate) async fn store_prepared_once(",
    );
    expect(applicationCeremonySource).toContain(
      "pub(crate) async fn load_prepared(",
    );
    expect(applicationCeremonySource).toContain(
      "pub(crate) async fn persist_challenge_issued(",
    );
    expect(applicationCeremonySource).toContain(
      "passkey_ceremony::put_once_json",
    );
    expect(applicationCeremonySource).toContain(
      "passkey_ceremony::replace_json_if",
    );
    expect(applicationCeremonySource).toContain(
      "validate_wire_request_v1(",
    );
    expect(applicationCeremonySource.indexOf("passkey_ceremony::read_json"))
      .toBeLessThan(applicationCeremonySource.indexOf("passkey_ceremony::claim_json"));
    expect(applicationOrchestratorSource).toContain(
      "pub(crate) async fn dispatch_prepared_begin(",
    );
    expect(applicationOrchestratorSource).toContain(
      "pub(crate) async fn reconcile_prepared_begin(",
    );
    expect(applicationOrchestratorSource.indexOf(".store_prepared_once(env)"))
      .toBeLessThan(
        applicationOrchestratorSource.indexOf(
          "dispatch_retained_prepared_begin(env, prepared).await",
        ),
      );
    expect(applicationOrchestratorSource).toContain(
      "issue_before_challenge_phase_proof(",
    );
    expect(applicationOrchestratorSource).toContain(
      ".get_binding::<WorkerVersionMetadata>(\"CF_VERSION_METADATA\")",
    );
    expect(applicationOrchestratorSource).toContain(
      ".secret(PHASE_PROOF_CURRENT_SECRET_ENV)",
    );
    expect(applicationOrchestratorSource).not.toContain(
      "DRAIN_SOURCE_REGISTRATION_PHASE_PROOF_CURRENT_SECRET =",
    );
    expect(applicationBeginSource).toContain(
      "VerifiedApplicationRootSessionV1::from_live_root_claims",
    );
    expect(applicationBeginSource).toContain(
      "relay_container_drain_source_registration_phase_snapshot(",
    );
    expect(applicationBeginSource).toContain(
      "issue_before_challenge_phase_proof(",
    );
    expect(applicationBeginSource).toContain(
      "freeze_application_checkpoint(materialized, &phase_proof)",
    );
    expect(applicationBeginSource).toContain(
      "derive_coordinator_begin_request_id_sha256(&begin_intent_sha256)",
    );
    expect(applicationBeginSource).toContain(
      "let prepared = prepare_application_begin(env, live_root_claims, draft).await?;",
    );
    expect(applicationBeginSource).toContain(
      "application_orchestrator::dispatch_prepared_begin(env, &prepared)",
    );
    expect(
      applicationBeginSource.indexOf(
        "let prepared = prepare_application_begin(env, live_root_claims, draft).await?;",
      ),
    ).toBeLessThan(
      applicationBeginSource.indexOf(
        "application_orchestrator::dispatch_prepared_begin(env, &prepared)",
      ),
    );
    expect(
      applicationBeginSource.indexOf(
        "application_orchestrator::preflight_fresh_application_begin(env)",
      ),
    ).toBeLessThan(
      applicationBeginSource.indexOf(
        "relay_container_drain_source_registration_phase_snapshot(",
      ),
    );
    expect(
      applicationBeginSource.indexOf(
        "relay_container_drain_source_registration_phase_snapshot(",
      ),
    ).toBeLessThan(
      applicationBeginSource.indexOf(
        "application_orchestrator::issue_before_challenge_phase_proof(",
      ),
    );
    expect(applicationBeginImplementation).not.toContain("Cookie");
    expect(applicationBeginImplementation).not.toContain("session_id:");

    for (const route of ["/put-once", "/read", "/replace", "/claim"]) {
      expect(passkeyCeremonySource).toContain(`\"${route}\"`);
    }
    expect(passkeyCeremonySource).toContain(
      "CEREMONY_EXPECTED_PAYLOAD_SHA256_HEADER",
    );
    expect(passkeyCeremonySource).toContain(
      "while let Some(chunk) = stream.next().await",
    );
    expect(passkeyCeremonySource).toContain(
      "read_response_bytes_limited(response, MAX_PAYLOAD_BYTES)",
    );
    expect(passkeyCeremonySource).toMatch(
      /transaction\s*\.put\(\s*CREATE_LOCK_KEY/u,
    );
    expect(passkeyCeremonySource).toMatch(
      /transaction\s*\.put\(\s*RECORD_KEY,\s*record\)/u,
    );

    const clientSource = readFileSync(
      "crates/worker/src/container_drain_source_registration_coordinator_client.rs",
      "utf8",
    );
    expect(clientSource).toContain("CoordinatorClientFailureClass");
    for (const failureClass of [
      "NotDispatched",
      "DeterministicRejection",
      "Indeterminate",
      "ProtocolViolation",
    ]) {
      expect(clientSource).toContain(failureClass);
    }
    expect(clientSource).toMatch(
      /#\[derive\(Clone\)\]\s*struct CoordinatorClientConfig/u,
    );
    expect(applicationCeremonySource).toMatch(
      /#\[derive\(Clone, Serialize, Deserialize, PartialEq, Eq\)\]\s*#\[serde\(deny_unknown_fields\)\]\s*pub\(crate\) struct DrainSourceRegistrationApplicationCeremonyV1/u,
    );
    expect(packageSource).toContain(
      "cargo test -p cinatoken-worker --lib container_drain_source_registration_",
    );
  });

  it("persists only bounded digest evidence with atomic journal records", () => {
    expect(source).toContain("const MAX_JSON_BODY_BYTES: usize = 16 * 1024;");
    expect(source).toContain("const MAX_RESPONSE_BYTES: usize = 8 * 1024;");
    expect(source).toContain("struct CoordinatorStateV1");
    expect(source).toContain("struct CoordinatorEventV1");
    expect(source).toContain("struct ReplayRecordV1");
    expect(source).toContain("transaction.put(STATE_KEY, &applied.state)");
    expect(source).toContain("event_key(applied.state.generation)");
    expect(source).toContain("replay_key(&replay.request_id_sha256)");
    expect(source).toContain("fn deadline_transition(");
    expect(source).toContain("CoordinatorPhase::RecoveryPending");
    expect(source).toContain("set_alarm(Duration::from_millis(delay_ms))");
    expect(source).toContain('"Cache-Control", "no-store"');

    const stateStart = source.indexOf("struct CoordinatorStateV1");
    const stateEnd = source.indexOf(
      "#[derive(Debug, Clone, Copy, Serialize",
      stateStart,
    );
    const persistedState = source.slice(stateStart, stateEnd);
    for (const forbidden of [
      "raw_cookie",
      "session_cookie",
      "raw_assertion",
      "private_key",
      "ip_address",
      "username",
    ]) {
      expect(persistedState).not.toContain(forbidden);
    }
  });

  it("binds method, path, object, request, body, caller, and key rotation", () => {
    for (const field of [
      "body_sha256",
      "caller_identity_sha256",
      "method",
      "object_name",
      "path",
      "request_id_sha256",
    ]) {
      expect(source).toContain(field);
    }
    expect(source).toContain("HMAC_CURRENT_KID");
    expect(source).toContain("HMAC_PREVIOUS_KID");
    expect(source).toContain("mac.verify_slice(&signature)");
    expect(source).toContain("decode_canonical_base64url");
    expect(source).toContain("canonical_json_value");
    expect(source).toMatch(/env\s*\.secret\(name\)/u);
    expect(source).toContain('if environment == "local"');
    expect(source).toContain(
      'error_response(500, "coordinator_storage_unavailable")',
    );
    expect(source).toContain("expected_id.to_string() != self.state.id().to_string()");
  });
});

function trackedWranglerConfigurations(root) {
  const paths = [];
  for (const name of readdirSync(root)) {
    if (
      name === ".git" ||
      name === ".tmp" ||
      name === "node_modules" ||
      name === "target"
    ) {
      continue;
    }
    const path = root === "." ? name : `${root}/${name}`;
    const metadata = statSync(path);
    if (metadata.isDirectory()) {
      paths.push(...trackedWranglerConfigurations(path));
    } else if (/wrangler(?:\.[a-z0-9-]+)?\.(?:toml|jsonc)$/u.test(name)) {
      paths.push(path);
    }
  }
  return paths;
}
