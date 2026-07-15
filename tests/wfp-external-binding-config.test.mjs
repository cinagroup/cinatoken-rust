import { describe, expect, test } from "bun:test";

import {
  auditExitCode,
  auditWfpExternalBindingConfig,
  WFP_EXTERNAL_BINDING_ENVIRONMENTS,
} from "../tools/audit_wfp_external_binding_config.mjs";

function mainFixture() {
  return {
    name: "cinatoken-rust-api",
    env: {
      staging: { name: "cinatoken-rust-api-staging" },
      production: { name: "cinatoken-rust-api" },
    },
  };
}

function replayBinding(scriptName, className = "WfpAuthorityReplay") {
  return {
    name: "WFP_AUTHORITY_REPLAY",
    class_name: className,
    script_name: scriptName,
  };
}

function outboundFixture() {
  return {
    name: "cinatoken-wfp-outbound",
    durable_objects: {
      bindings: [replayBinding("cinatoken-rust-api")],
    },
    env: {
      staging: {
        durable_objects: {
          bindings: [replayBinding("cinatoken-rust-api-staging")],
        },
      },
      production: {
        durable_objects: {
          bindings: [replayBinding("cinatoken-rust-api")],
        },
      },
    },
  };
}

describe("WFP external Durable Object binding audit", () => {
  test("requires matching base, staging, and production script names", () => {
    const result = auditWfpExternalBindingConfig(
      mainFixture(),
      outboundFixture(),
    );

    expect(result.valid).toBe(true);
    expect(result.checks.map((check) => check.environment)).toEqual([
      ...WFP_EXTERNAL_BINDING_ENVIRONMENTS,
    ]);
    expect(auditExitCode(result)).toBe(0);
  });

  test("production cannot target a nonexistent -production worker", () => {
    const outbound = outboundFixture();
    outbound.env.production.durable_objects.bindings[0].script_name =
      "cinatoken-rust-api-production";

    const result = auditWfpExternalBindingConfig(mainFixture(), outbound);
    const production = result.checks.find(
      (check) => check.environment === "production",
    );

    expect(result.valid).toBe(false);
    expect(production.valid).toBe(false);
    expect(production.errors).toEqual(["replay_script_mismatch"]);
    expect(auditExitCode(result)).toBe(1);
  });

  test("rejects a wrong Durable Object class", () => {
    const outbound = outboundFixture();
    outbound.env.staging.durable_objects.bindings[0].class_name = "WrongClass";

    const result = auditWfpExternalBindingConfig(mainFixture(), outbound);

    expect(result.valid).toBe(false);
    expect(result.checks[1].errors).toContain("replay_class_mismatch");
    expect(auditExitCode(result)).toBe(1);
  });

  test("rejects missing or duplicate environment bindings", () => {
    const outbound = outboundFixture();
    outbound.env.staging.durable_objects.bindings = [];
    outbound.env.production.durable_objects.bindings.push(
      replayBinding("cinatoken-rust-api"),
    );

    const result = auditWfpExternalBindingConfig(mainFixture(), outbound);

    expect(result.valid).toBe(false);
    expect(result.checks[1].errors).toContain("replay_binding_missing");
    expect(result.checks[2].errors).toContain("replay_binding_duplicate");
    expect(auditExitCode(result)).toBe(1);
  });
});
