import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const baseUrl = new URL(
  process.argv[2] ?? process.env.CINATOKEN_BASE_URL ?? "http://127.0.0.1:8787",
);
const requestTimeoutMs = 20_000;

const spaRoutes = [
  "/",
  "/setup",
  "/sign-in",
  "/dashboard",
  "/playground",
  "/keys",
  "/channels",
  "/users",
  "/usage-logs/common",
  "/models/metadata",
  "/system-settings/site",
  "/profile",
];

const publicEnvelopeRoutes = [
  "/api/notice",
  "/api/about",
  "/api/home_page_content",
  "/api/user-agreement",
  "/api/privacy-policy",
  "/api/midjourney",
  "/api/pricing",
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function resolveUrl(route) {
  return new URL(route, baseUrl);
}

async function request(route, init = {}) {
  const response = await fetch(resolveUrl(route), {
    redirect: "manual",
    signal: AbortSignal.timeout(requestTimeoutMs),
    ...init,
  });
  return response;
}

async function jsonEnvelope(route, expectedStatuses = [200]) {
  const response = await request(route);
  assert(
    expectedStatuses.includes(response.status),
    `${route}: expected ${expectedStatuses.join("/")}, received ${response.status}`,
  );
  const contentType = response.headers.get("content-type") ?? "";
  assert(
    contentType.includes("application/json"),
    `${route}: expected JSON, received ${contentType || "no content type"}`,
  );
  const body = await response.json();
  assert(body && typeof body === "object", `${route}: body is not an object`);
  assert(
    typeof body.success === "boolean" && Object.hasOwn(body, "data"),
    `${route}: missing Go-compatible {success,data} envelope`,
  );
  return body;
}

function parseJsonOption(value, name) {
  assert(typeof value === "string", `${name}: expected serialized JSON string`);
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${name}: invalid serialized JSON: ${error.message}`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const checks = [];
function passed(name, detail) {
  checks.push({ name, status: "PASS", detail });
}

const status = await jsonEnvelope("/api/status");
assert(status.success, `/api/status: ${status.message || "unsuccessful"}`);
assert(status.data?.service === "cinatoken-rust", "/api/status: wrong service");
assert(Array.isArray(status.data.features), "/api/status: features missing");

const header = parseJsonOption(
  status.data.HeaderNavModules,
  "HeaderNavModules",
);
assert(
  header.rankings?.enabled === true && header.rankings?.requireAuth === false,
  "rankings must be available by default",
);
const sidebar = parseJsonOption(
  status.data.SidebarModulesAdmin,
  "SidebarModulesAdmin",
);
for (const [section, module] of [
  ["console", "midjourney"],
  ["console", "task"],
  ["personal", "topup"],
  ["admin", "subscription"],
]) {
  assert(
    sidebar[section]?.[module] === false,
    `${section}.${module} must remain capability-hidden`,
  );
}
assert(
  sidebar.chat?.playground === true,
  "chat.playground must be available by default",
);
assert(
  status.data.enable_deployments === false,
  "io.net deployments must remain capability-hidden",
);
passed(
  "status capability contract",
  `${status.data.environment}: playground and rankings available; unsupported modules hidden`,
);

const setup = await jsonEnvelope("/api/setup");
assert(setup.success, `/api/setup: ${setup.message || "unsuccessful"}`);
assert(
  typeof setup.data?.status === "boolean" &&
    typeof setup.data?.root_init === "boolean" &&
    setup.data?.database_type === "d1",
  "/api/setup: incompatible data contract",
);
passed(
  "setup contract",
  `complete=${setup.data.status}, root_init=${setup.data.root_init}`,
);

const rootResponse = await request("/");
assert(rootResponse.ok, `/: expected 2xx, received ${rootResponse.status}`);
assert(
  (rootResponse.headers.get("content-type") ?? "").includes("text/html"),
  "/: expected text/html",
);
const rootHtml = await rootResponse.text();
assert(rootHtml.includes('<div id="root"></div>'), "/: React root is missing");
assert(
  !rootHtml.includes("localhost:") && !rootHtml.includes("127.0.0.1"),
  "/: local development URL leaked into HTML",
);
const rootHash = sha256(rootHtml);

for (const route of spaRoutes.slice(1)) {
  const response = await request(route);
  assert(response.ok, `${route}: expected 2xx, received ${response.status}`);
  assert(
    (response.headers.get("content-type") ?? "").includes("text/html"),
    `${route}: expected text/html`,
  );
  const html = await response.text();
  assert(sha256(html) === rootHash, `${route}: SPA shell differs from /`);
}
passed(
  "SPA hard refresh",
  `${spaRoutes.length} routes share the deployed shell`,
);

const assetPaths = [...rootHtml.matchAll(/(?:src|href)="([^"]+)"/g)]
  .map((match) => match[1])
  .filter((value) => !/^(?:https?:|data:|#)/.test(value));
assert(assetPaths.length > 0, "/: no static asset references found");
await Promise.all(
  assetPaths.map(async (assetPath) => {
    const response = await request(assetPath, { method: "HEAD" });
    assert(
      response.ok,
      `${assetPath}: expected asset 2xx, received ${response.status}`,
    );
  }),
);
passed("static assets", `${assetPaths.length} referenced assets return 2xx`);

const localIndexPath = path.join(repoRoot, "apps", "web", "dist", "index.html");
try {
  const localHtml = await readFile(localIndexPath, "utf8");
  assert(
    sha256(localHtml.trim()) === sha256(rootHtml.trim()),
    "deployed index.html does not match apps/web/dist/index.html",
  );
  passed(
    "artifact identity",
    "deployed index matches the local production build",
  );
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  passed("artifact identity", "skipped: apps/web/dist/index.html is absent");
}

for (const route of publicEnvelopeRoutes) {
  const envelope = await jsonEnvelope(route);
  assert(envelope.success, `${route}: ${envelope.message || "unsuccessful"}`);
}
const ratioConfig = await jsonEnvelope("/api/ratio_config", [200, 403]);
assert(
  ratioConfig.success || ratioConfig.message,
  "/api/ratio_config: disabled response must explain the gate",
);
passed(
  "public API envelopes",
  `${publicEnvelopeRoutes.length + 1} public routes return compatible JSON`,
);

for (const route of ["/api/does-not-exist", "/v1/does-not-exist"]) {
  const response = await request(route);
  const contentType = response.headers.get("content-type") ?? "";
  assert(
    response.status === 404,
    `${route}: expected 404, received ${response.status}`,
  );
  assert(
    !contentType.includes("text/html"),
    `${route}: API miss fell through to SPA`,
  );
}
passed("API/SPA precedence", "unknown API routes return 404 outside the SPA");

console.table(checks);
console.log(
  JSON.stringify(
    {
      base_url: baseUrl.origin,
      environment: status.data.environment,
      checks: checks.length,
      spa_routes: spaRoutes.length,
      public_envelopes: publicEnvelopeRoutes.length + 3,
      index_sha256: rootHash,
    },
    null,
    2,
  ),
);
