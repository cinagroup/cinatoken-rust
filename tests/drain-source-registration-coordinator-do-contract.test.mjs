import {
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { describe, expect, it } from "bun:test";

const sourcePath =
  "crates/worker/src/container_drain_source_registration_coordinator_do.rs";
const source = readFileSync(sourcePath, "utf8");
const workerEntrypoint = readFileSync("crates/worker/src/lib.rs", "utf8");
const runtimeFixture = readFileSync(
  "tests/fixtures/do-runtime-worker.mjs",
  "utf8",
);
const runtimeConfig = readFileSync("vitest.do.config.mjs", "utf8");

const binding = "DRAIN_SOURCE_REGISTRATION_COORDINATORS";
const className = "DrainSourceRegistrationCoordinator";
const authorityPrefix = "DRAIN_SOURCE_REGISTRATION_COORDINATOR_";

describe("drain-source registration coordinator DO source contract", () => {
  it("is exported only through the isolated SQLite Workerd binding", () => {
    expect(workerEntrypoint).toContain(
      "mod container_drain_source_registration_coordinator_do;",
    );
    expect(runtimeFixture).toContain(className);
    expect(runtimeConfig).toContain(`${binding}: {`);
    expect(runtimeConfig).toContain(`className: "${className}"`);
    expect(runtimeConfig).toContain("useSQLite: true");

    for (const path of trackedWranglerConfigurations(".")) {
      const value = readFileSync(path, "utf8");
      expect(value, `${path} must not bind the coordinator`).not.toContain(
        binding,
      );
      expect(
        value,
        `${path} must not configure coordinator authority`,
      ).not.toContain(authorityPrefix);
      expect(value, `${path} must not migrate the coordinator class`).not.toContain(
        className,
      );
    }
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
      /container_drain_source_registration_coordinator_do/gu,
    )).toHaveLength(1);
    expect(source).not.toContain("Router::");
    expect(source).not.toContain("route_async(");
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
