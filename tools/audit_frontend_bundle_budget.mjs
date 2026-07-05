import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultConfigPath = path.join(repoRoot, "tools", "frontend_bundle_budget.json");

const args = process.argv.slice(2);
const options = {
  config: defaultConfigPath,
  dir: null,
  failOnBudget: false,
  json: false,
  summary: false,
  top: 10,
};

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--config") {
    const value = args[++i];
    if (!value) usage("--config requires a value");
    options.config = path.resolve(repoRoot, value);
  } else if (arg === "--dir") {
    const value = args[++i];
    if (!value) usage("--dir requires a value");
    options.dir = path.resolve(repoRoot, value);
  } else if (arg === "--fail-on-budget") {
    options.failOnBudget = true;
  } else if (arg === "--json") {
    options.json = true;
  } else if (arg === "--summary") {
    options.summary = true;
  } else if (arg === "--top") {
    const value = Number.parseInt(args[++i] ?? "", 10);
    if (!Number.isFinite(value) || value < 0) usage("--top requires a non-negative integer");
    options.top = value;
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
      "Usage: bun tools/audit_frontend_bundle_budget.mjs [--summary] [--json] [--fail-on-budget] [--dir <path>] [--config <path>] [--top <n>]",
      "",
      "Checks the built frontend bundle against raw and gzip size budgets.",
    ].join("\n"),
  );
  process.exit(error ? 2 : 0);
}

async function main() {
  const config = JSON.parse(await readFile(options.config, "utf8"));
  const distDir = options.dir ?? path.resolve(repoRoot, config.dist_dir ?? "");
  const info = await stat(distDir).catch(() => null);
  if (!info?.isDirectory()) {
    console.error(`Frontend dist directory not found: ${path.relative(repoRoot, distDir)}`);
    process.exit(2);
  }

  const files = await listFiles(distDir);
  if (files.length === 0) {
    console.error(`Frontend dist directory is empty: ${path.relative(repoRoot, distDir)}`);
    process.exit(2);
  }

  const assets = [];
  const totals = {
    file_count: 0,
    total_raw_bytes: 0,
    total_gzip_bytes: 0,
    js_raw_bytes: 0,
    js_gzip_bytes: 0,
    css_raw_bytes: 0,
    css_gzip_bytes: 0,
    initial_js_raw_bytes: 0,
    initial_js_gzip_bytes: 0,
    largest_js_raw_bytes: 0,
    largest_js_gzip_bytes: 0,
  };

  for (const file of files) {
    const bytes = await readFile(file);
    const gzipBytes = gzipSync(bytes, { level: 9 }).length;
    const rel = path.relative(distDir, file).replaceAll(path.sep, "/");
    const ext = path.extname(file).toLowerCase();
    const asset = {
      file: rel,
      raw_bytes: bytes.length,
      gzip_bytes: gzipBytes,
      extension: ext || "<none>",
      initial_js: isInitialJs(rel, ext),
    };

    assets.push(asset);
    totals.file_count += 1;
    totals.total_raw_bytes += asset.raw_bytes;
    totals.total_gzip_bytes += asset.gzip_bytes;

    if (ext === ".js") {
      totals.js_raw_bytes += asset.raw_bytes;
      totals.js_gzip_bytes += asset.gzip_bytes;
      if (asset.raw_bytes > totals.largest_js_raw_bytes) {
        totals.largest_js_raw_bytes = asset.raw_bytes;
        totals.largest_js_gzip_bytes = asset.gzip_bytes;
      }
      if (asset.initial_js) {
        totals.initial_js_raw_bytes += asset.raw_bytes;
        totals.initial_js_gzip_bytes += asset.gzip_bytes;
      }
    } else if (ext === ".css") {
      totals.css_raw_bytes += asset.raw_bytes;
      totals.css_gzip_bytes += asset.gzip_bytes;
    }
  }

  const budgetRows = budgetDefinitions(config.budgets ?? {}).map((budget) => {
    const actual = totals[budget.metric] ?? 0;
    return {
      metric: budget.metric,
      label: budget.label,
      actual,
      budget: budget.limit,
      ok: actual <= budget.limit,
    };
  });

  const failures = budgetRows.filter((budget) => !budget.ok);
  const topAssets = assets.sort((a, b) => b.raw_bytes - a.raw_bytes).slice(0, options.top);
  const result = {
    dist_dir: path.relative(repoRoot, distDir).replaceAll(path.sep, "/"),
    config: path.relative(repoRoot, options.config).replaceAll(path.sep, "/"),
    totals,
    budgets: budgetRows,
    failures,
    top_assets: topAssets,
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHuman(result);
  }

  if (options.failOnBudget && failures.length > 0) {
    process.exit(1);
  }
}

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return listFiles(fullPath);
      return entry.isFile() ? [fullPath] : [];
    }),
  );
  return nested.flat();
}

function isInitialJs(relativePath, ext) {
  return ext === ".js" && relativePath.startsWith("static/js/") && !relativePath.includes("/async/");
}

function budgetDefinitions(budgets) {
  return [
    ["total_raw_bytes", "total raw bytes"],
    ["total_gzip_bytes", "total gzip bytes"],
    ["js_raw_bytes", "JavaScript raw bytes"],
    ["js_gzip_bytes", "JavaScript gzip bytes"],
    ["css_raw_bytes", "CSS raw bytes"],
    ["css_gzip_bytes", "CSS gzip bytes"],
    ["initial_js_raw_bytes", "initial JavaScript raw bytes"],
    ["initial_js_gzip_bytes", "initial JavaScript gzip bytes"],
    ["largest_js_raw_bytes", "largest JavaScript chunk raw bytes"],
    ["largest_js_gzip_bytes", "largest JavaScript chunk gzip bytes"],
  ]
    .filter(([metric]) => Number.isFinite(budgets[metric]))
    .map(([metric, label]) => ({ metric, label, limit: budgets[metric] }));
}

function formatBytes(value) {
  const mb = value / 1_000_000;
  return `${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  }).format(mb)} MB`;
}

function printHuman(result) {
  const totals = result.totals;
  const status = result.failures.length === 0 ? "passed" : "failed";
  const failureText =
    result.failures.length === 0
      ? "0 budget failures"
      : `${result.failures.length} budget failure(s)`;
  console.log(
    `Frontend bundle budget audit ${status}: scanned ${totals.file_count} files (${formatBytes(
      totals.total_raw_bytes,
    )} raw, ${formatBytes(totals.total_gzip_bytes)} gzip) in ${result.dist_dir}; ${failureText}.`,
  );

  for (const budget of result.budgets) {
    const marker = budget.ok ? "OK" : "FAIL";
    console.log(
      `- ${marker} ${budget.label}: ${formatBytes(budget.actual)} / ${formatBytes(budget.budget)}`,
    );
  }

  if (!options.summary && result.top_assets.length > 0) {
    console.log("Top assets by raw size:");
    for (const asset of result.top_assets) {
      console.log(
        `- ${asset.file}: ${formatBytes(asset.raw_bytes)} raw, ${formatBytes(asset.gzip_bytes)} gzip`,
      );
    }
  }
}

await main();
