import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wranglerPath = path.join(repoRoot, "wrangler.toml");
const queueSourcePath = path.join(
  repoRoot,
  "crates",
  "worker",
  "src",
  "relay_billing_queue.rs",
);
const [wranglerSource, queueSource] = await Promise.all([
  readFile(wranglerPath, "utf8"),
  readFile(queueSourcePath, "utf8"),
]);

const config = parseTomlSections(wranglerSource);
const environments = [
  {
    name: "default",
    vars: "vars",
    producers: "queues.producers",
    consumers: "queues.consumers",
    queue: "cinatoken-rust-billing-finalization",
    dlq: "cinatoken-rust-billing-finalization-dlq",
  },
  {
    name: "staging",
    vars: "env.staging.vars",
    producers: "env.staging.queues.producers",
    consumers: "env.staging.queues.consumers",
    queue: "cinatoken-rust-billing-finalization-staging",
    dlq: "cinatoken-rust-billing-finalization-dlq-staging",
  },
  {
    name: "production",
    vars: "env.production.vars",
    producers: "env.production.queues.producers",
    consumers: "env.production.queues.consumers",
    queue: "cinatoken-rust-billing-finalization",
    dlq: "cinatoken-rust-billing-finalization-dlq",
  },
];

for (const environment of environments) {
  const vars = singleSection(config, environment.vars);
  assert(
    vars.RELAY_BILLING_FINALIZATION_QUEUE_ENABLED === "false",
    `${environment.vars} must keep relay billing Queue finalization default-off`,
  );

  const producers = sections(config, environment.producers).filter(
    (section) => section.binding === "BILLING_QUEUE",
  );
  assert(
    producers.length === 1,
    `${environment.producers} must contain exactly one BILLING_QUEUE producer`,
  );
  assert(
    producers[0].queue === environment.queue,
    `${environment.name} BILLING_QUEUE must target ${environment.queue}`,
  );

  const consumers = sections(config, environment.consumers).filter(
    (section) => section.queue === environment.queue,
  );
  assert(
    consumers.length === 1,
    `${environment.consumers} must contain exactly one billing finalization consumer`,
  );
  const consumer = consumers[0];
  assert(
    Number(consumer.max_batch_size) > 0 && Number(consumer.max_batch_size) <= 100,
    `${environment.name} billing consumer batch size must be bounded to 1..100`,
  );
  assert(
    Number(consumer.max_batch_timeout) >= 0 && Number(consumer.max_batch_timeout) <= 60,
    `${environment.name} billing consumer timeout must be bounded to 0..60 seconds`,
  );
  assert(
    Number(consumer.max_retries) >= 1,
    `${environment.name} billing consumer must retry before dead-lettering`,
  );
  assert(
    consumer.dead_letter_queue === environment.dlq && environment.dlq !== environment.queue,
    `${environment.name} billing consumer must use the environment-specific DLQ`,
  );
  assert(
    queueSource.includes(`"${environment.queue}"`),
    `Rust queue ownership must explicitly recognize ${environment.queue}`,
  );
}

assert(
  queueSource.includes("const BILLING_FINALIZATION_MAX_EVENT_BYTES: usize = 64 * 1024;"),
  "billing finalization events must stay below the Cloudflare Queue message limit",
);

const report = {
  ok: true,
  config: "wrangler.toml",
  binding: "BILLING_QUEUE",
  defaultOff: true,
  environments: environments.map(({ name, queue, dlq }) => ({ name, queue, dlq })),
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(
    `Billing Queue config ok: ${environments.length} environments, default-off producer/consumer/DLQ contract`,
  );
}

function parseTomlSections(source) {
  const parsed = new Map();
  let current = null;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    const arrayTable = /^\[\[([^\]]+)\]\]$/.exec(line);
    const table = /^\[([^\]]+)\]$/.exec(line);
    if (arrayTable || table) {
      const name = (arrayTable ?? table)[1];
      current = {};
      const values = parsed.get(name) ?? [];
      values.push(current);
      parsed.set(name, values);
      continue;
    }
    if (!current || line === "" || line.startsWith("#")) continue;
    const assignment = /^([A-Za-z0-9_]+)\s*=\s*(?:"([^"]*)"|([^#\s]+))(?:\s*#.*)?$/.exec(
      line,
    );
    if (assignment) current[assignment[1]] = assignment[2] ?? assignment[3];
  }
  return parsed;
}

function sections(config, name) {
  return config.get(name) ?? [];
}

function singleSection(config, name) {
  const matches = sections(config, name);
  assert(matches.length === 1, `${name} must exist exactly once`);
  return matches[0];
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
