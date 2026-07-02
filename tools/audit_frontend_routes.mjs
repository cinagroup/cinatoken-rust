import { createRequire } from "node:module";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const frontendRoot = path.join(
  repoRoot,
  "apps",
  "web",
  "source",
  "default",
  "src",
);
const workerRouterPath = path.join(
  repoRoot,
  "crates",
  "worker",
  "src",
  "lib.rs",
);
const require = createRequire(import.meta.url);
const ts = require(
  path.join(
    repoRoot,
    "apps",
    "web",
    "source",
    "default",
    "node_modules",
    "typescript",
  ),
);

const apiPrefixes = [
  "/api",
  "/v1",
  "/v1beta",
  "/dashboard",
  "/mj",
  "/suno",
  "/kling",
  "/jimeng",
  "/pg",
];
const methodNames = new Map([
  ["get", "GET"],
  ["post", "POST"],
  ["put", "PUT"],
  ["delete", "DELETE"],
  ["patch", "PATCH"],
]);

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(fullPath);
      return /\.(?:ts|tsx|js|jsx)$/.test(entry.name) ? [fullPath] : [];
    }),
  );
  return nested.flat();
}

function expressionText(node) {
  if (!node) return null;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      value += ":param";
      value += span.literal.text;
    }
    return value;
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = expressionText(node.left);
    const right = expressionText(node.right);
    if (left == null && right == null) return null;
    return `${left ?? ":param"}${right ?? ":param"}`;
  }
  return null;
}

function objectProperty(object, name) {
  if (!object || !ts.isObjectLiteralExpression(object)) return null;
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const propertyName = property.name.getText().replace(/^['"]|['"]$/g, "");
    if (propertyName === name) return property.initializer;
  }
  return null;
}

function methodFromCall(node) {
  if (ts.isPropertyAccessExpression(node.expression)) {
    return methodNames.get(node.expression.name.text) ?? "ANY";
  }
  if (ts.isElementAccessExpression(node.expression)) {
    const key = expressionText(node.expression.argumentExpression);
    return methodNames.get(key) ?? "ANY";
  }
  if (ts.isIdentifier(node.expression) && node.expression.text === "fetch") {
    const method = expressionText(objectProperty(node.arguments[1], "method"));
    return method?.toUpperCase() ?? "GET";
  }
  return "ANY";
}

function pathFromCall(node) {
  const direct = node.arguments[0] && expressionText(node.arguments[0]);
  if (direct) return direct;
  const config = node.arguments.find(ts.isObjectLiteralExpression);
  return expressionText(objectProperty(config, "url"));
}

function normalizePath(value) {
  if (!value) return null;
  let normalized = value.trim();
  if (!apiPrefixes.some((prefix) => normalized.startsWith(prefix))) return null;
  normalized = normalized.split(/[?#]/, 1)[0];
  normalized = normalized.replace(/:param(?::param)+/g, ":param");
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/, "");
  return normalized;
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
}

async function frontendCalls() {
  const calls = new Map();
  for (const file of await sourceFiles(frontendRoot)) {
    const source = await readFile(file, "utf8");
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const route = normalizePath(pathFromCall(node));
        if (route) {
          const method = methodFromCall(node);
          const key = `${method} ${route}`;
          const location = `${path.relative(repoRoot, file).replaceAll("\\", "/")}:${lineOf(sourceFile, node)}`;
          if (!calls.has(key)) calls.set(key, []);
          calls.get(key).push(location);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return calls;
}

function workerRoutes(source) {
  const routes = [];
  const regex = /\.(get|post|put|delete|patch)(?:_async)?\(\s*"([^"]+)"/g;
  for (const match of source.matchAll(regex)) {
    routes.push({
      method: match[1].toUpperCase(),
      path: normalizePath(match[2]) ?? match[2].replace(/\/+$/, ""),
    });
  }
  return routes;
}

function pathMatches(registered, requested) {
  const registeredParts = registered.split("/").filter(Boolean);
  const requestedParts = requested.split("/").filter(Boolean);
  if (registeredParts.length !== requestedParts.length) return false;
  return registeredParts.every(
    (part, index) =>
      part.startsWith(":") ||
      part.startsWith("*") ||
      requestedParts[index] === ":param" ||
      part === requestedParts[index],
  );
}

function isRegistered(call, routes) {
  const [method, requestedPath] = call.split(" ", 2);
  return routes.some(
    (route) =>
      (method === "ANY" || route.method === method) &&
      pathMatches(route.path, requestedPath),
  );
}

const calls = await frontendCalls();
const routerSource = await readFile(workerRouterPath, "utf8");
const routes = workerRoutes(routerSource);
const missing = [...calls.entries()]
  .filter(([call]) => !isRegistered(call, routes))
  .map(([call, locations]) => ({ call, locations }))
  .sort((left, right) => left.call.localeCompare(right.call));

console.log(
  JSON.stringify(
    {
      frontend_calls: calls.size,
      worker_routes: routes.length,
      missing_calls: missing.length,
      missing,
    },
    null,
    2,
  ),
);

if (process.argv.includes("--fail-on-missing") && missing.length > 0) {
  process.exitCode = 1;
}
