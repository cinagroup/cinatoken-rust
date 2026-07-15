import mainConfig from "../wrangler.toml";
import outboundConfig from "../crates/wfp-outbound/wrangler.toml";

export const WFP_EXTERNAL_BINDING_ENVIRONMENTS = Object.freeze([
  "base",
  "staging",
  "production",
]);

const REPLAY_BINDING_NAME = "WFP_AUTHORITY_REPLAY";
const REPLAY_CLASS_NAME = "WfpAuthorityReplay";

function environmentConfig(config, environment) {
  return environment === "base" ? config : config.env?.[environment];
}

function replayBindings(config, environment) {
  const scoped = environmentConfig(config, environment);
  const bindings = scoped?.durable_objects?.bindings;
  if (!Array.isArray(bindings)) return [];
  return bindings.filter((binding) => binding.name === REPLAY_BINDING_NAME);
}

export function auditWfpExternalBindingConfig(mainWorker, outboundWorker) {
  const checks = WFP_EXTERNAL_BINDING_ENVIRONMENTS.map((environment) => {
    const main = environmentConfig(mainWorker, environment);
    const outbound = environmentConfig(outboundWorker, environment);
    const bindings = replayBindings(outboundWorker, environment);
    const binding = bindings.length === 1 ? bindings[0] : undefined;
    const expectedScript = main?.name;
    const actualScript = binding?.script_name;
    const errors = [];

    if (typeof expectedScript !== "string" || expectedScript.length === 0) {
      errors.push("main_script_missing");
    }
    if (bindings.length === 0) {
      errors.push("replay_binding_missing");
    } else if (bindings.length > 1) {
      errors.push("replay_binding_duplicate");
    }
    if (binding && binding.class_name !== REPLAY_CLASS_NAME) {
      errors.push("replay_class_mismatch");
    }
    if (binding && actualScript !== expectedScript) {
      errors.push("replay_script_mismatch");
    }

    return {
      environment,
      main_script: expectedScript ?? null,
      outbound_script: outbound?.name ?? outboundWorker?.name ?? null,
      replay_binding: binding?.name ?? null,
      replay_class: binding?.class_name ?? null,
      replay_script: actualScript ?? null,
      valid: errors.length === 0,
      errors,
    };
  });

  return {
    contract_version: 1,
    valid: checks.every((check) => check.valid),
    checks,
  };
}

export function auditExitCode(result) {
  return result.valid ? 0 : 1;
}

if (import.meta.main) {
  const json = process.argv.includes("--json");
  const result = auditWfpExternalBindingConfig(mainConfig, outboundConfig);

  if (json) {
    console.log(JSON.stringify(result));
  } else {
    for (const check of result.checks) {
      const errors = check.errors.length > 0 ? `, errors=${check.errors.join(",")}` : "";
      console.log(
        `${check.environment}: ${check.valid ? "ok" : "invalid"} ` +
          `(main=${check.main_script ?? "missing"}, replay=${check.replay_script ?? "missing"}${errors})`,
      );
    }
  }

  process.exitCode = auditExitCode(result);
}
