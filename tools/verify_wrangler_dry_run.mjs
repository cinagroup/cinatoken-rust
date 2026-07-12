#!/usr/bin/env bun

import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL("..", import.meta.url)));
const node = Bun.which("node");
if (!node) throw new Error("Node.js is required to run the locked Wrangler CLI");

const wrangler = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const completionMarker = "--dry-run: exiting now.";
const requiredOutput = [
  "env.RELAY_TOKEN_RATE_LIMITER (120 requests/60s)",
  "env.RELAY_IP_RATE_LIMITER (600 requests/60s)",
  "env.RELAY_RATE_LIMIT_BACKEND (\"native\")",
];
const child = Bun.spawn(
  [
    node,
    wrangler,
    "deploy",
    "--config",
    join(root, "wrangler.toml"),
    "--env=",
    "--dry-run",
    "--outdir",
    join(root, ".wrangler", "dry-run"),
    "--minify",
  ],
  { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
);

let output = "";
let completionResolve;
const completion = new Promise((resolve) => {
  completionResolve = resolve;
});
const stdout = drain(child.stdout, process.stdout);
const stderr = drain(child.stderr, process.stderr);
const exited = child.exited.then((code) => ({ kind: "exit", code }));
const completed = completion.then(() => ({ kind: "complete" }));
let timeoutId;
const timedOut = new Promise((resolve) => {
  timeoutId = setTimeout(() => resolve({ kind: "timeout" }), 10 * 60_000);
});

const first = await Promise.race([exited, completed, timedOut]);
clearTimeout(timeoutId);
let forcedAfterCompletion = false;
let exitCode = child.exitCode;

if (first.kind === "timeout") {
  terminateTree(child.pid);
  await child.exited;
  throw new Error("Wrangler dry-run timed out before its completion marker");
}

if (first.kind === "complete") {
  await Bun.sleep(2_000);
  if (child.exitCode === null) {
    forcedAfterCompletion = true;
    terminateTree(child.pid);
  }
  exitCode = await child.exited;
} else {
  exitCode = first.code;
}

await Promise.all([stdout, stderr]);
if (!output.includes(completionMarker)) {
  throw new Error(`Wrangler dry-run exited with code ${exitCode} before completion`);
}
for (const expected of requiredOutput) {
  if (!output.includes(expected)) {
    throw new Error(`Wrangler dry-run output is missing ${expected}`);
  }
}
if (!forcedAfterCompletion && exitCode !== 0) {
  throw new Error(`Wrangler dry-run failed with exit code ${exitCode}`);
}

console.log(
  JSON.stringify({
    ok: true,
    wranglerDryRun: true,
    nativeRateLimitBindings: true,
    forcedExitAfterCompletion: forcedAfterCompletion,
  }),
);

async function drain(stream, target) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    output += text;
    target.write(text);
    if (output.includes(completionMarker)) completionResolve();
  }
  const tail = decoder.decode();
  if (tail) {
    output += tail;
    target.write(tail);
  }
}

function terminateTree(pid) {
  if (process.platform === "win32") {
    Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], {
      stdout: "ignore",
      stderr: "ignore",
    });
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // The process exited between the completion check and termination.
    }
  }
}
