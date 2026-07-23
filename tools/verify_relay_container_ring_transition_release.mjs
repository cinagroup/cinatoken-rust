#!/usr/bin/env bun

import {
  describeRingTransitionRunnerReleaseContract,
  verifyRingTransitionRunnerRelease,
} from "./relay_container_ring_transition_release_contract.mjs";

try {
  const options = parseArgs(process.argv.slice(2));
  const result = options.describe
    ? describeRingTransitionRunnerReleaseContract()
    : await verifyRingTransitionRunnerRelease({
        packetPath: options.packet,
        trustPolicyPath: options.trustPolicy,
      });
  printResult(result, options.json);
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : "runner release verification failed closed",
  );
  process.exit(1);
}

function parseArgs(argv) {
  const values = new Map();
  const seenFlags = new Set();
  let describe = false;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") usage(0);
    if (argument === "--json" || argument === "--describe") {
      if (seenFlags.has(argument)) {
        usage(2, `[input] ${argument} must not be repeated`);
      }
      seenFlags.add(argument);
      if (argument === "--json") json = true;
      if (argument === "--describe") describe = true;
      continue;
    }
    if (argument !== "--packet" && argument !== "--trust-policy") {
      usage(2, `[input] unknown option: ${argument}`);
    }
    if (values.has(argument)) {
      usage(2, `[input] ${argument} must not be repeated`);
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) {
      usage(2, `[input] ${argument} requires a path`);
    }
    values.set(argument, value);
  }
  if (describe) {
    if (values.size !== 0) {
      usage(2, "[input] --describe does not accept release paths");
    }
    return { describe: true, json };
  }
  if (!values.has("--packet") || !values.has("--trust-policy")) {
    usage(2, "[input] --packet and --trust-policy are required");
  }
  return {
    describe: false,
    json,
    packet: values.get("--packet"),
    trustPolicy: values.get("--trust-policy"),
  };
}

function printResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.releaseForm) {
    console.log(
      [
        "Relay Container ring-transition runner release contract",
        `manifest_contract: ${result.manifestContract}`,
        `packet_contract: ${result.packetContract}`,
        `policy_contract: ${result.policyContract}`,
        `release_form: ${result.releaseForm}`,
        "release_install_authorized: false",
        "remote_mutation_authorized: false",
      ].join("\n"),
    );
    return;
  }
  console.log(
    [
      "Relay Container ring-transition runner release verification",
      `ok: ${result.ok}`,
      `source_commit: ${result.sourceCommit}`,
      `manifest_sha256: ${result.manifestSha256}`,
      `artifact_sha256: ${result.artifactSha256}`,
      `signature_verified: ${result.signatureVerified}`,
      `artifact_verified: ${result.artifactVerified}`,
      `external_pins_verified: ${result.externalPinsVerified}`,
      "compiled_launcher_trust_verified: false",
      "release_install_authorized: false",
      "remote_mutation_authorized: false",
    ].join("\n"),
  );
}

function usage(exitCode, error) {
  if (error) console.error(error);
  console.error(
    [
      "Usage:",
      "  bun tools/verify_relay_container_ring_transition_release.mjs --describe [--json]",
      "  bun tools/verify_relay_container_ring_transition_release.mjs --packet <release.json> --trust-policy <policy.json> [--json]",
      "",
      "The verifier is offline and read-only. It reads no credential environment variables, performs no network request, executes no shell command, and writes no file.",
      "CLI verification proves packet consistency only. It does not supply compiled trust pins, authorize artifact installation, enable the runner, or authorize Cloudflare mutation.",
    ].join("\n"),
  );
  process.exit(exitCode);
}
