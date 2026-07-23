#!/usr/bin/env bun

import {
  DEPLOYMENT_PINNED_RING_TRANSITION_TRUST,
  describeRingTransitionMutationRunner,
} from "./relay_container_ring_transition_execution_contract.mjs";

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.describe) {
    printResult(describeRingTransitionMutationRunner(), options.json);
  } else {
    execute();
  }
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : "ring transition mutation runner failed closed",
  );
  process.exit(1);
}

function parseArgs(argv) {
  let describe = false;
  let executeRequested = false;
  let json = false;
  const seen = new Set();
  for (const argument of argv) {
    if (argument === "--help" || argument === "-h") usage(0);
    if (!["--describe", "--execute", "--json"].includes(argument)) {
      usage(2, `[input] unknown option: ${argument}`);
    }
    if (seen.has(argument)) {
      usage(2, `[input] ${argument} must not be repeated`);
    }
    seen.add(argument);
    if (argument === "--describe") describe = true;
    if (argument === "--execute") executeRequested = true;
    if (argument === "--json") json = true;
  }
  if (describe === executeRequested) {
    usage(2, "[input] choose exactly one of --describe or --execute");
  }
  return { describe, executeRequested, json };
}

function execute() {
  if (!DEPLOYMENT_PINNED_RING_TRANSITION_TRUST.enabled) {
    throw new Error(
      "[disabled] deployment-pinned staging trust roots are not published",
    );
  }
  throw new Error(
    "[disabled] the live mutation transport is not present in this runner build",
  );
}

function printResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(
    [
      "Relay Container staging ring transition mutation runner",
      `trust_contract: ${result.trustContract}`,
      `trust_roots_published: ${result.trustRootsPublished}`,
      `execution_mode: ${result.executionMode}`,
      `remote_mutation_authorized: ${result.remoteMutationAuthorized}`,
      `network_requests_performed: ${result.networkRequestsPerformed}`,
      `mutation_performed: ${result.mutationPerformed}`,
    ].join("\n"),
  );
}

function usage(exitCode, error) {
  if (error) console.error(error);
  console.error(
    [
      "Usage:",
      "  bun tools/run_relay_container_ring_transition_mutation.mjs --describe [--json]",
      "  bun tools/run_relay_container_ring_transition_mutation.mjs --execute [--json]",
      "",
      "The checked-in runner is fail-closed. Execution remains disabled until a",
      "reviewed release artifact publishes immutable staging trust roots and the",
      "bounded claim/read/deploy transport implementation.",
      "Credential values and endpoint overrides are never accepted as CLI arguments.",
    ].join("\n"),
  );
  process.exit(exitCode);
}
