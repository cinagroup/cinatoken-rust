import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  canonicalJson,
  parseStrictJsonObject,
} from "../tools/container_runtime_json_compatibility_campaign.mjs";
import {
  parseJsonCompatibilityPermitIssuerConfigArgs,
  prepareJsonCompatibilityPermitIssuerConfig,
  validateJsonCompatibilityPermitIssuerConfig,
} from "../tools/prepare_container_runtime_json_compatibility_permit_issuer_config.mjs";
import {
  parseJsonCompatibilityInvokerConfigArgs,
  prepareJsonCompatibilityInvokerConfig,
  validateJsonCompatibilityInvokerConfig,
} from "../tools/prepare_container_runtime_json_compatibility_invoker_config.mjs";
import {
  parseJsonCompatibilityOperatorConfigArgs,
  prepareJsonCompatibilityOperatorConfig,
  validateJsonCompatibilityOperatorConfig,
} from "../tools/prepare_container_runtime_json_compatibility_operator_config.mjs";

const temporaryDirectories = [];
const digest = (byte) => byte.repeat(64);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function temporaryFile(name) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "cinatoken-json-private-config-"),
  );
  temporaryDirectories.push(directory);
  return path.join(directory, name);
}

describe("JSON compatibility private service config preparers", () => {
  test("creates an issuer campaign config without serializing secrets", async () => {
    const outPath = await temporaryFile("issuer.jsonc");
    const options = {
      outPath,
      authorityCurrentKid: "issuer-authority-2026-08",
      authorityCurrentCredentialIdSha256: digest("1"),
      permitKeyId: "permit-ed25519-2026-08",
      permitSpkiSha256: digest("2"),
    };
    const result = await prepareJsonCompatibilityPermitIssuerConfig(options);
    const source = await readFile(outPath, "utf8");
    const config = parseStrictJsonObject(source, "prepared issuer config");
    expect(source).toBe(canonicalJson(config));
    expect(validateJsonCompatibilityPermitIssuerConfig(config, options)).toMatchObject({
      enabled: true,
      campaignScopedDurableObject: true,
    });
    expect(config.vars.JSON_COMPATIBILITY_PERMIT_ISSUER_ENABLED).toBe("true");
    expect(source).not.toContain("CURRENT_SECRET");
    expect(source).not.toContain("PKCS8_BASE64URL");
    expect(result).toMatchObject({
      ok: true,
      credentialsRead: false,
      networkRequestsPerformed: false,
      deploymentMutationPerformed: false,
    });
  });

  test("creates an invoker campaign config with pinned identities only", async () => {
    const outPath = await temporaryFile("invoker.jsonc");
    const options = {
      outPath,
      operatorCurrentKid: "operator-2026-08",
      operatorCurrentCredentialIdSha256: digest("3"),
      issuerHmacKid: "invoker-issuer-2026-08",
      issuerHmacCredentialIdSha256: digest("4"),
      permitKeyId: "permit-ed25519-2026-08",
      permitSpkiSha256: digest("2"),
    };
    const result = await prepareJsonCompatibilityInvokerConfig(options);
    const source = await readFile(outPath, "utf8");
    const config = parseStrictJsonObject(source, "prepared invoker config");
    expect(source).toBe(canonicalJson(config));
    expect(validateJsonCompatibilityInvokerConfig(config, options)).toMatchObject({
      enabled: true,
      privateServiceBindings: true,
    });
    expect(config.vars.JSON_COMPATIBILITY_INVOKER_ENABLED).toBe("true");
    expect(source).not.toContain("CURRENT_SECRET");
    expect(source).not.toContain("HMAC_SECRET");
    expect(result.secretsRequired).toEqual([
      "JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_SECRET",
      "JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_SECRET",
      "JSON_COMPATIBILITY_PERMIT_SPKI_BASE64URL",
    ]);
  });

  test("creates an operator campaign config pinned to one invoker version", async () => {
    const outPath = await temporaryFile("operator.jsonc");
    const options = {
      outPath,
      currentKid: "operator-2026-08",
      currentCredentialIdSha256: digest("5"),
      invokerVersionId: "invoker-version-001",
    };
    const result = await prepareJsonCompatibilityOperatorConfig(options);
    const source = await readFile(outPath, "utf8");
    const config = parseStrictJsonObject(source, "prepared operator config");
    expect(source).toBe(canonicalJson(config));
    expect(validateJsonCompatibilityOperatorConfig(config, options)).toMatchObject({
      enabled: true,
      privateServiceBinding: true,
    });
    expect(config.vars).toMatchObject({
      JSON_COMPATIBILITY_OPERATOR_ENABLED: "true",
      JSON_COMPATIBILITY_OPERATOR_CURRENT_KID: options.currentKid,
      JSON_COMPATIBILITY_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256:
        options.currentCredentialIdSha256,
      JSON_COMPATIBILITY_OPERATOR_INVOKER_VERSION_ID:
        options.invokerVersionId,
    });
    expect(source).not.toContain("CURRENT_SECRET");
    expect(result.secretsRequired).toEqual([
      "JSON_COMPATIBILITY_OPERATOR_CURRENT_SECRET",
    ]);
  });

  test("is create-only and rejects secret-shaped CLI options", async () => {
    const outPath = await temporaryFile("existing.jsonc");
    await writeFile(outPath, "sentinel", "utf8");
    await expect(
      prepareJsonCompatibilityPermitIssuerConfig({
        outPath,
        authorityCurrentKid: "issuer-authority-2026-08",
        authorityCurrentCredentialIdSha256: digest("1"),
        permitKeyId: "permit-ed25519-2026-08",
        permitSpkiSha256: digest("2"),
      }),
    ).rejects.toThrow();
    expect(await readFile(outPath, "utf8")).toBe("sentinel");
    expect(() => parseJsonCompatibilityPermitIssuerConfigArgs([
      "--authority-current-secret",
      "not-accepted",
    ])).toThrow(/unknown option/);
    expect(() => parseJsonCompatibilityInvokerConfigArgs([
      "--operator-current-secret",
      "not-accepted",
    ])).toThrow(/unknown option/);
    expect(() => parseJsonCompatibilityOperatorConfigArgs([
      "--hmac-secret",
      "not-accepted",
    ])).toThrow(/unknown option/);
  });
});
