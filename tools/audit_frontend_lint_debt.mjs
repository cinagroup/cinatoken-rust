import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultBaselinePath = path.join(repoRoot, "tools", "frontend_lint_debt_baseline.json");

const args = process.argv.slice(2);
const options = {
  baseline: defaultBaselinePath,
  failOnRegression: false,
  json: false,
  summary: false,
};

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--baseline") {
    const value = args[++i];
    if (!value) usage("--baseline requires a value");
    options.baseline = path.resolve(repoRoot, value);
  } else if (arg === "--fail-on-regression") {
    options.failOnRegression = true;
  } else if (arg === "--json") {
    options.json = true;
  } else if (arg === "--summary") {
    options.summary = true;
  } else if (arg === "--help" || arg === "-h") {
    usage();
  } else {
    usage(`Unknown argument: ${arg}`);
  }
}

function usage(error) {
  if (error) console.error(error);
  console.error(
    [
      "Usage: bun tools/audit_frontend_lint_debt.mjs [--summary] [--json] [--fail-on-regression] [--baseline <path>]",
      "",
      "Runs frontend ESLint and fails only when imported lint debt regresses beyond the tracked baseline.",
    ].join("\n"),
  );
  process.exit(error ? 2 : 0);
}

async function main() {
  const baseline = JSON.parse(await readFile(options.baseline, "utf8"));
  const frontendDir = path.resolve(repoRoot, baseline.frontend_dir);
  const eslintResult = spawnSync(
    "bun",
    ["node_modules/eslint/bin/eslint.js", ".", "--format", "json"],
    {
      cwd: frontendDir,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      shell: process.platform === "win32",
    },
  );

  if (eslintResult.error) {
    throw eslintResult.error;
  }

  let lintResults;
  try {
    lintResults = JSON.parse(eslintResult.stdout);
  } catch (error) {
    console.error("Failed to parse ESLint JSON output.");
    if (eslintResult.stdout) console.error(eslintResult.stdout.slice(0, 4000));
    if (eslintResult.stderr) console.error(eslintResult.stderr.slice(0, 4000));
    throw error;
  }

  const actual = summarizeLint(lintResults, frontendDir);
  const regressions = compareWithBaseline(actual, baseline);
  const result = {
    frontend_dir: path.relative(repoRoot, frontendDir).replaceAll(path.sep, "/"),
    baseline: path.relative(repoRoot, options.baseline).replaceAll(path.sep, "/"),
    actual,
    expected: {
      totals: baseline.totals,
      by_rule: baseline.by_rule,
    },
    regressions,
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHuman(result);
  }

  if (options.failOnRegression && regressions.length > 0) {
    process.exit(1);
  }
}

function summarizeLint(lintResults, frontendDir) {
  const totals = {
    errors: 0,
    warnings: 0,
    fixable_errors: 0,
    fixable_warnings: 0,
    files_with_findings: 0,
  };
  const byRule = {};

  for (const result of lintResults) {
    totals.errors += result.errorCount;
    totals.warnings += result.warningCount;
    totals.fixable_errors += result.fixableErrorCount;
    totals.fixable_warnings += result.fixableWarningCount;
    if (result.errorCount > 0 || result.warningCount > 0) {
      totals.files_with_findings += 1;
    }

    for (const message of result.messages) {
      const rule = message.ruleId ?? "<fatal>";
      byRule[rule] ??= { errors: 0, warnings: 0 };
      if (message.severity === 2) byRule[rule].errors += 1;
      if (message.severity === 1) byRule[rule].warnings += 1;
    }
  }

  return {
    totals,
    by_rule: sortObject(byRule),
  };
}

function compareWithBaseline(actual, baseline) {
  const regressions = [];
  for (const metric of Object.keys(baseline.totals)) {
    const actualValue = actual.totals[metric] ?? 0;
    const expectedValue = baseline.totals[metric] ?? 0;
    if (actualValue > expectedValue) {
      regressions.push({
        type: "total",
        metric,
        actual: actualValue,
        expected: expectedValue,
      });
    }
  }

  const rules = new Set([
    ...Object.keys(actual.by_rule),
    ...Object.keys(baseline.by_rule ?? {}),
  ]);
  for (const rule of [...rules].sort()) {
    const actualRule = actual.by_rule[rule] ?? { errors: 0, warnings: 0 };
    const expectedRule = baseline.by_rule?.[rule] ?? { errors: 0, warnings: 0 };
    for (const metric of ["errors", "warnings"]) {
      if ((actualRule[metric] ?? 0) > (expectedRule[metric] ?? 0)) {
        regressions.push({
          type: "rule",
          rule,
          metric,
          actual: actualRule[metric] ?? 0,
          expected: expectedRule[metric] ?? 0,
        });
      }
    }
  }

  return regressions;
}

function sortObject(object) {
  return Object.fromEntries(Object.entries(object).sort(([left], [right]) => left.localeCompare(right)));
}

function printHuman(result) {
  const totals = result.actual.totals;
  const status = result.regressions.length === 0 ? "passed" : "failed";
  const regressionText =
    result.regressions.length === 0
      ? "0 regressions"
      : `${result.regressions.length} regression(s)`;
  console.log(
    `Frontend lint debt audit ${status}: ${totals.errors} errors, ${totals.warnings} warnings, ${totals.files_with_findings} files with findings in ${result.frontend_dir}; ${regressionText}.`,
  );

  for (const [rule, counts] of Object.entries(result.actual.by_rule)) {
    console.log(`- ${rule}: ${counts.errors} errors, ${counts.warnings} warnings`);
  }

  if (!options.summary && result.regressions.length > 0) {
    console.error("Regressions:");
    for (const regression of result.regressions) {
      if (regression.type === "rule") {
        console.error(
          `- ${regression.rule} ${regression.metric}: ${regression.actual} > ${regression.expected}`,
        );
      } else {
        console.error(
          `- ${regression.metric}: ${regression.actual} > ${regression.expected}`,
        );
      }
    }
  }
}

await main();
