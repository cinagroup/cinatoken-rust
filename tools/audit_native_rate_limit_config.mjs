import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configs = [
  {
    path: path.join(repoRoot, "wrangler.toml"),
    tables: [
      "ratelimits",
      "env.staging.ratelimits",
      "env.production.ratelimits",
    ],
    vars: ["vars", "env.staging.vars", "env.production.vars"],
  },
  {
    path: path.join(repoRoot, "wrangler.realtime-local.toml"),
    tables: ["ratelimits"],
    vars: ["vars"],
  },
];

const expectedBindings = new Map([
  ["RELAY_TOKEN_RATE_LIMITER", { limit: 120, period: 60 }],
  ["RELAY_IP_RATE_LIMITER", { limit: 600, period: 60 }],
]);
const namespaceIds = new Map();
const reports = [];

for (const target of configs) {
  const source = await readFile(target.path, "utf8");
  const parsed = parseConfig(source);
  for (const table of target.tables) {
    const bindings = parsed.ratelimits.filter((entry) => entry.table === table);
    assert(
      bindings.length === expectedBindings.size,
      `${label(target.path)} ${table} must contain exactly ${expectedBindings.size} rate limit bindings`,
    );
    for (const binding of bindings) {
      const expected = expectedBindings.get(binding.values.name);
      assert(expected, `${label(target.path)} ${table} has unexpected binding ${binding.values.name}`);
      assert(
        /^\d+$/.test(binding.values.namespace_id ?? "") &&
          Number(binding.values.namespace_id) > 0,
        `${label(target.path)} ${table}.${binding.values.name} namespace_id must be a positive integer string`,
      );
      assert(
        binding.simple.limit === expected.limit,
        `${label(target.path)} ${table}.${binding.values.name} limit must be ${expected.limit}`,
      );
      assert(
        binding.simple.period === expected.period,
        `${label(target.path)} ${table}.${binding.values.name} period must be ${expected.period}`,
      );

      const namespaceOwner = namespaceIds.get(binding.values.namespace_id);
      const isSharedLocalShape =
        namespaceOwner?.file === "wrangler.toml" &&
        namespaceOwner.table === "ratelimits" &&
        label(target.path) === "wrangler.realtime-local.toml" &&
        table === "ratelimits" &&
        namespaceOwner.name === binding.values.name;
      assert(
        !namespaceOwner || isSharedLocalShape,
        `${label(target.path)} ${table}.${binding.values.name} reuses namespace_id ${binding.values.namespace_id}`,
      );
      if (!namespaceOwner) {
        namespaceIds.set(binding.values.namespace_id, {
          file: label(target.path),
          table,
          name: binding.values.name,
        });
      }
    }
  }

  for (const varsTable of target.vars) {
    assert(
      parsed.vars.get(varsTable)?.RELAY_RATE_LIMIT_BACKEND === "native",
      `${label(target.path)} ${varsTable} must set RELAY_RATE_LIMIT_BACKEND=native`,
    );
  }

  reports.push({
    config: label(target.path),
    tables: target.tables.length,
    bindings: parsed.ratelimits.filter((entry) => target.tables.includes(entry.table)).length,
    nativeVars: target.vars.length,
  });
}

const report = {
  ok: true,
  backend: "native",
  bindings: [...expectedBindings.entries()].map(([name, simple]) => ({ name, ...simple })),
  namespaceCount: namespaceIds.size,
  configs: reports,
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(
    `Native rate limit config ok: ${report.namespaceCount} environment-scoped namespaces across ${reports.length} Wrangler configs`,
  );
}

function parseConfig(source) {
  const ratelimits = [];
  const vars = new Map();
  let currentRateLimit = null;
  let currentVars = null;

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const arrayTable = /^\[\[([^\]]+)\]\]$/.exec(line);
    if (arrayTable) {
      currentVars = null;
      currentRateLimit = arrayTable[1].endsWith("ratelimits")
        ? { table: arrayTable[1], values: {}, simple: {} }
        : null;
      if (currentRateLimit) ratelimits.push(currentRateLimit);
      continue;
    }

    const table = /^\[([^\]]+)\]$/.exec(line);
    if (table) {
      currentRateLimit = null;
      currentVars = null;
      if (table[1].endsWith("ratelimits.simple")) {
        const ownerTable = table[1].slice(0, -".simple".length);
        currentRateLimit = [...ratelimits]
          .reverse()
          .find((entry) => entry.table === ownerTable);
        assert(currentRateLimit, `simple table ${table[1]} has no preceding rate limit`);
      } else if (table[1] === "vars" || /^env\.[^.]+\.vars$/.test(table[1])) {
        currentVars = {};
        vars.set(table[1], currentVars);
      }
      continue;
    }

    const assignment = /^([A-Za-z0-9_]+)\s*=\s*("[^"]*"|-?\d+(?:\.\d+)?)\s*(?:#.*)?$/.exec(
      line,
    );
    if (!assignment) continue;
    const value = assignment[2].startsWith('"')
      ? assignment[2].slice(1, -1)
      : Number(assignment[2]);
    if (currentRateLimit) {
      const destination = line.includes("limit") || line.includes("period")
        ? currentRateLimit.simple
        : currentRateLimit.values;
      destination[assignment[1]] = value;
    } else if (currentVars) {
      currentVars[assignment[1]] = value;
    }
  }

  return { ratelimits, vars };
}

function label(filePath) {
  return path.relative(repoRoot, filePath).replaceAll("\\", "/");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
