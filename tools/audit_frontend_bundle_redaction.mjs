import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const defaultDistDirs = [
  path.join(repoRoot, "apps", "web", "source", "default", "dist"),
  path.join(repoRoot, "apps", "web", "dist"),
];

const textExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".map",
  ".mjs",
  ".svg",
  ".txt",
  ".webmanifest",
  ".xml",
]);

const secretPatterns = [
  {
    id: "private-key",
    description: "PEM private key material",
    regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  {
    id: "openai-secret-key",
    description: "OpenAI-style sk secret key",
    regex: /\bsk-(?:proj-|ant-api03-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: "stripe-secret-key",
    description: "Stripe secret, restricted, or webhook key",
    regex: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b|\bwhsec_[A-Za-z0-9]{16,}\b/g,
  },
  {
    id: "github-token",
    description: "GitHub access token",
    regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  },
  {
    id: "gitlab-token",
    description: "GitLab access token",
    regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: "google-api-key",
    description: "Google API key",
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    id: "huggingface-token",
    description: "Hugging Face access token",
    regex: /\bhf_[A-Za-z0-9]{30,}\b/g,
  },
  {
    id: "anthropic-secret-key",
    description: "Anthropic API key",
    regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: "xai-secret-key",
    description: "xAI API key",
    regex: /\bxai-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: "bearer-literal",
    description: "Literal bearer token value",
    regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{32,}\b/g,
  },
  {
    id: "basic-auth-url",
    description: "URL containing username and password",
    regex: /\bhttps?:\/\/[^/\s:@]{2,}:[^/\s:@]{6,}@/g,
  },
];

const args = process.argv.slice(2);
const options = {
  dirs: [],
  failOnFindings: false,
  json: false,
  summary: false,
};

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--dir") {
    const value = args[++i];
    if (!value) usage("--dir requires a value");
    options.dirs.push(path.resolve(repoRoot, value));
  } else if (arg === "--fail-on-findings") {
    options.failOnFindings = true;
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

if (options.dirs.length === 0) {
  options.dirs = defaultDistDirs;
}

function usage(error) {
  if (error) console.error(error);
  console.error(
    [
      "Usage: bun tools/audit_frontend_bundle_redaction.mjs [--summary] [--json] [--fail-on-findings] [--dir <path>]",
      "",
      "Scans built frontend static assets for high-confidence secret/token values.",
    ].join("\n"),
  );
  process.exit(error ? 2 : 0);
}

async function main() {
  const existingDirs = [];
  for (const dir of options.dirs) {
    try {
      const info = await stat(dir);
      if (info.isDirectory()) existingDirs.push(dir);
    } catch {
      // Ignore absent optional dist directories. At least one must exist.
    }
  }

  if (existingDirs.length === 0) {
    console.error(
      `No frontend dist directories found. Checked: ${options.dirs
        .map((dir) => path.relative(repoRoot, dir))
        .join(", ")}`,
    );
    process.exit(2);
  }

  const files = (await Promise.all(existingDirs.map((dir) => listFiles(dir)))).flat();
  const textFiles = files.filter((file) => textExtensions.has(path.extname(file).toLowerCase()));
  const findings = [];
  let scannedBytes = 0;

  for (const file of textFiles) {
    const content = await readFile(file, "utf8");
    scannedBytes += Buffer.byteLength(content);
    for (const pattern of secretPatterns) {
      pattern.regex.lastIndex = 0;
      for (const match of content.matchAll(pattern.regex)) {
        const value = match[0];
        findings.push({
          file: path.relative(repoRoot, file).replaceAll(path.sep, "/"),
          pattern: pattern.id,
          description: pattern.description,
          location: locationFor(content, match.index ?? 0),
          match: redact(value),
          snippet: snippet(content, match.index ?? 0, value.length),
        });
      }
    }
  }

  const result = {
    scanned_dirs: existingDirs.map((dir) => path.relative(repoRoot, dir).replaceAll(path.sep, "/")),
    scanned_files: textFiles.length,
    scanned_bytes: scannedBytes,
    findings_count: findings.length,
    findings,
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHuman(result);
  }

  if (options.failOnFindings && findings.length > 0) {
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

function locationFor(content, index) {
  const prefix = content.slice(0, index);
  const lines = prefix.split(/\r\n|\r|\n/);
  return {
    line: lines.length,
    column: lines.at(-1).length + 1,
  };
}

function redact(value) {
  if (value.length <= 12) return "<redacted>";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function snippet(content, index, length) {
  const start = Math.max(0, index - 24);
  const end = Math.min(content.length, index + length + 24);
  const raw = content.slice(start, end).replace(/\s+/g, " ");
  return raw.replace(content.slice(index, index + length), redact(content.slice(index, index + length)));
}

function printHuman(result) {
  const dirs = result.scanned_dirs.join(", ");
  if (result.findings_count === 0) {
    console.log(
      `Frontend bundle redaction audit passed: scanned ${result.scanned_files} files (${result.scanned_bytes} bytes) in ${dirs}; 0 findings.`,
    );
    return;
  }

  console.error(
    `Frontend bundle redaction audit found ${result.findings_count} potential secret value(s) in ${dirs}:`,
  );
  for (const finding of result.findings) {
    console.error(
      `- ${finding.file}:${finding.location.line}:${finding.location.column} ${finding.pattern} (${finding.description}) ${finding.match}`,
    );
    if (!options.summary) {
      console.error(`  ${finding.snippet}`);
    }
  }
}

await main();
