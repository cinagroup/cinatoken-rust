import { createRequire } from "node:module";
import { createHash } from "node:crypto";
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
const debtBaselinePath = path.join(
  repoRoot,
  "tools",
  "frontend_route_debt_baseline.json",
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

function expressionText(node, checker, seen = new Set()) {
  if (!node) return null;
  node = unwrapExpression(node);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) {
    const object = expressionTarget(node.expression, checker, seen);
    return expressionText(
      objectProperty(object, node.name.text, checker),
      checker,
      seen,
    );
  }
  if (ts.isElementAccessExpression(node)) {
    const object = expressionTarget(node.expression, checker, seen);
    const key = expressionText(node.argumentExpression, checker, seen);
    return expressionText(objectProperty(object, key, checker), checker, seen);
  }
  if (ts.isIdentifier(node) && checker) {
    const symbol = resolvedSymbol(checker, node);
    if (symbol && !seen.has(symbol)) {
      const nextSeen = new Set(seen);
      nextSeen.add(symbol);
      for (const declaration of symbol.declarations ?? []) {
        if (
          ts.isVariableDeclaration(declaration) &&
          declaration.initializer
        ) {
          const resolved = expressionText(
            declaration.initializer,
            checker,
            nextSeen,
          );
          if (resolved != null) return resolved;
        }
      }
    }
  }
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
    const left = expressionText(node.left, checker, seen);
    const right = expressionText(node.right, checker, seen);
    if (left == null && right == null) return null;
    return `${left ?? ":param"}${right ?? ":param"}`;
  }
  if (ts.isConditionalExpression(node)) {
    const whenTrue = expressionText(node.whenTrue, checker, seen);
    const whenFalse = expressionText(node.whenFalse, checker, seen);
    if (whenTrue === whenFalse) return whenTrue;
    const truePath = whenTrue?.split(/[?#]/, 1)[0];
    const falsePath = whenFalse?.split(/[?#]/, 1)[0];
    if (truePath && truePath === falsePath) return truePath;
  }
  return null;
}

function unwrapExpression(node) {
  while (
    node &&
    (ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isNonNullExpression(node))
  ) {
    node = node.expression;
  }
  return node;
}

function resolvedSymbol(checker, node) {
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return null;
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    return checker.getAliasedSymbol(symbol);
  }
  return symbol;
}

function expressionTarget(node, checker, seen) {
  node = unwrapExpression(node);
  if (!node || !checker) return node;
  if (ts.isIdentifier(node)) {
    const symbol = resolvedSymbol(checker, node);
    if (!symbol || seen.has(symbol)) return node;
    const nextSeen = new Set(seen);
    nextSeen.add(symbol);
    for (const declaration of symbol.declarations ?? []) {
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        return unwrapExpression(declaration.initializer);
      }
    }
  }
  return node;
}

function objectProperty(object, name, checker) {
  object = unwrapExpression(object);
  if (!name || !object || !ts.isObjectLiteralExpression(object)) return null;
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const propertyName = propertyNameText(property.name, checker);
    if (propertyName === name) return property.initializer;
  }
  return null;
}

function propertyNameText(name, checker) {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  if (ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    return expressionText(name.expression, checker);
  }
  return name.getText().replace(/^['"]|['"]$/g, "");
}

function methodFromLocalHelper(node, checker) {
  if (!ts.isIdentifier(node.expression)) return null;
  const symbol = checker.getSymbolAtLocation(node.expression);
  if (!symbol) return null;

  const methods = new Set();
  const inspect = (candidate) => {
    if (ts.isCallExpression(candidate)) {
      if (ts.isPropertyAccessExpression(candidate.expression)) {
        const method = methodNames.get(candidate.expression.name.text);
        if (method) methods.add(method);
      } else if (
        ts.isIdentifier(candidate.expression) &&
        candidate.expression.text === "fetch"
      ) {
        const method = expressionText(
          objectProperty(candidate.arguments[1], "method"),
          checker,
        );
        methods.add(method?.toUpperCase() ?? "GET");
      }
    }
    ts.forEachChild(candidate, inspect);
  };

  for (const declaration of symbol.declarations ?? []) {
    if (ts.isFunctionDeclaration(declaration) && declaration.body) {
      inspect(declaration.body);
    } else if (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      (ts.isArrowFunction(declaration.initializer) ||
        ts.isFunctionExpression(declaration.initializer))
    ) {
      inspect(declaration.initializer.body);
    }
  }
  return methods.size === 1 ? [...methods][0] : null;
}

function methodFromCall(node, checker) {
  if (ts.isPropertyAccessExpression(node.expression)) {
    return methodNames.get(node.expression.name.text) ?? null;
  }
  if (ts.isElementAccessExpression(node.expression)) {
    const key = expressionText(node.expression.argumentExpression, checker);
    return methodNames.get(key) ?? null;
  }
  if (ts.isIdentifier(node.expression) && node.expression.text === "fetch") {
    const method = expressionText(
      objectProperty(node.arguments[1], "method"),
      checker,
    );
    return method?.toUpperCase() ?? "GET";
  }
  return methodFromLocalHelper(node, checker);
}

function pathFromCall(node, checker) {
  const direct =
    node.arguments[0] && expressionText(node.arguments[0], checker);
  if (direct) return direct;
  const config = node.arguments.find(ts.isObjectLiteralExpression);
  return expressionText(objectProperty(config, "url"), checker);
}

function methodFromNewExpression(node, checker) {
  const name = constructorName(node.expression);
  if (name === "EventSource") return "GET";
  if (name !== "SSE") return null;
  const method = expressionText(
    objectProperty(node.arguments?.[1], "method"),
    checker,
  );
  return method?.toUpperCase() ?? "GET";
}

function pathFromNewExpression(node, checker) {
  return node.arguments?.[0]
    ? expressionText(node.arguments[0], checker)
    : null;
}

function constructorName(expression) {
  expression = unwrapExpression(expression);
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

function pathFromJsxAttribute(node, checker) {
  if (!["href", "src"].includes(node.name.text)) return null;
  if (!node.initializer) return null;
  if (ts.isStringLiteral(node.initializer)) return node.initializer.text;
  if (ts.isJsxExpression(node.initializer)) {
    return expressionText(node.initializer.expression, checker);
  }
  return null;
}

function pathFromNavigationCall(node, checker) {
  if (!ts.isPropertyAccessExpression(node.expression)) return null;
  const property = node.expression.name.text;
  if (property === "open" && isWindowExpression(node.expression.expression)) {
    return node.arguments[0]
      ? expressionText(node.arguments[0], checker)
      : null;
  }
  if (
    ["assign", "replace"].includes(property) &&
    isLocationExpression(node.expression.expression)
  ) {
    return node.arguments[0]
      ? expressionText(node.arguments[0], checker)
      : null;
  }
  return null;
}

function pathFromNavigationAssignment(node, checker) {
  if (
    !ts.isBinaryExpression(node) ||
    node.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !isLocationHref(node.left)
  ) {
    return null;
  }
  return expressionText(node.right, checker);
}

function isLocationHref(node) {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "href" &&
    isLocationExpression(node.expression)
  );
}

function isLocationExpression(node) {
  node = unwrapExpression(node);
  if (ts.isIdentifier(node)) return node.text === "location";
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "location" &&
    isWindowExpression(node.expression)
  );
}

function isWindowExpression(node) {
  node = unwrapExpression(node);
  return ts.isIdentifier(node) && node.text === "window";
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
  const detectionKinds = new Map();
  const files = await sourceFiles(frontendRoot);
  const program = ts.createProgram(files, {
    allowJs: true,
    jsx: ts.JsxEmit.ReactJSX,
    noLib: true,
    noEmit: true,
    noResolve: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.Latest,
  });
  const checker = program.getTypeChecker();
  const addRoute = (sourceFile, file, node, method, route, kind) => {
    if (!method || !route) return;
    const key = `${method} ${route}`;
    const location = `${path
      .relative(repoRoot, file)
      .replaceAll("\\", "/")}:${lineOf(sourceFile, node)}`;
    if (!calls.has(key)) calls.set(key, []);
    calls.get(key).push(location);
    detectionKinds.set(kind, (detectionKinds.get(kind) ?? 0) + 1);
  };
  for (const file of files) {
    const sourceFile = program.getSourceFile(file);
    if (!sourceFile) continue;
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const route = normalizePath(pathFromCall(node, checker));
        if (route) {
          const method = methodFromCall(node, checker);
          if (method) addRoute(sourceFile, file, node, method, route, "call");
        }

        const navigationRoute = normalizePath(
          pathFromNavigationCall(node, checker),
        );
        if (navigationRoute) {
          addRoute(
            sourceFile,
            file,
            node,
            "GET",
            navigationRoute,
            "navigation",
          );
        }
      }
      if (ts.isNewExpression(node)) {
        const route = normalizePath(pathFromNewExpression(node, checker));
        if (route) {
          const method = methodFromNewExpression(node, checker);
          if (method) addRoute(sourceFile, file, node, method, route, "stream");
        }
      }
      if (ts.isBinaryExpression(node)) {
        const route = normalizePath(pathFromNavigationAssignment(node, checker));
        if (route) {
          addRoute(sourceFile, file, node, "GET", route, "navigation");
        }
      }
      if (ts.isJsxAttribute(node)) {
        const route = normalizePath(pathFromJsxAttribute(node, checker));
        if (route) {
          addRoute(sourceFile, file, node, "GET", route, "jsx-attribute");
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return {
    calls,
    detectionKinds: Object.fromEntries(
      [...detectionKinds.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  };
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

function routePath(call) {
  return call.slice(call.indexOf(" ") + 1);
}

function startsWithAny(value, prefixes) {
  return prefixes.some(
    (prefix) => value === prefix || value.startsWith(`${prefix}/`),
  );
}

function classifyMissing(call) {
  const [method] = call.split(" ", 1);
  const route = routePath(call);
  if (method === "ANY") return "parser-limitation";

  if (
    startsWithAny(route, [
      "/api/redemption",
      "/api/subscription",
      "/api/deployments",
      "/api/user/checkin",
      "/api/mj",
      "/api/task",
    ])
  ) {
    return "capability-hidden-product";
  }

  if (
    startsWithAny(route, [
      "/api/prefill_group",
      "/api/channel",
      "/api/models/sync_upstream",
      "/api/option/channel_affinity_cache",
      "/api/log/channel_affinity_usage_cache",
    ])
  ) {
    return "visible-admin-debt";
  }

  if (
    startsWithAny(route, [
      "/api/perf-metrics",
      "/api/performance",
      "/api/ratio_sync",
      "/api/uptime",
    ])
  ) {
    return "operations-debt";
  }

  if (
    startsWithAny(route, [
      "/api/custom-oauth-provider",
      "/api/oauth",
      "/api/reset_password",
      "/api/verification",
      "/api/user/passkey",
      "/api/user/oauth",
    ]) ||
    /^\/api\/user\/:param\/(?:bindings|oauth\/bindings|reset_passkey)/.test(
      route,
    ) ||
    route === "/api/user/reset"
  ) {
    return "auth-deferred";
  }

  if (
    startsWithAny(route, [
      "/api/option/waffo-pancake",
      "/api/user/topup",
    ]) ||
    /^\/api\/user\/(?:amount|pay|stripe\/amount|creem\/pay|waffo(?:-pancake)?\/(?:amount|pay))$/.test(
      route,
    )
  ) {
    return "payment-deferred";
  }

  return "unclassified";
}

function sha256(values) {
  return createHash("sha256").update(values.join("\n")).digest("hex");
}

const { calls, detectionKinds } = await frontendCalls();
const routerSource = await readFile(workerRouterPath, "utf8");
const routes = workerRoutes(routerSource);
const missing = [...calls.entries()]
  .filter(([call]) => !isRegistered(call, routes))
  .map(([call, locations]) => ({
    call,
    category: classifyMissing(call),
    locations,
  }))
  .sort((left, right) => left.call.localeCompare(right.call));
const categoryCounts = Object.fromEntries(
  [...new Set(missing.map((entry) => entry.category))]
    .sort()
    .map((category) => [
      category,
      missing.filter((entry) => entry.category === category).length,
    ]),
);
const missingDigest = sha256(missing.map((entry) => entry.call));
const summaryOnly = process.argv.includes("--summary");

console.log(
  JSON.stringify(
    {
      frontend_calls: calls.size,
      frontend_detection_kinds: detectionKinds,
      worker_routes: routes.length,
      missing_calls: missing.length,
      missing_sha256: missingDigest,
      categories: categoryCounts,
      ...(summaryOnly ? {} : { missing }),
    },
    null,
    2,
  ),
);

if (process.argv.includes("--fail-on-missing") && missing.length > 0) {
  process.exitCode = 1;
}

if (
  process.argv.includes("--fail-on-unclassified") &&
  categoryCounts.unclassified
) {
  process.exitCode = 1;
}

if (process.argv.includes("--check-baseline")) {
  const baseline = JSON.parse(await readFile(debtBaselinePath, "utf8"));
  const errors = [];
  if (
    Object.hasOwn(baseline, "frontend_calls") &&
    baseline.frontend_calls !== calls.size
  ) {
    errors.push(
      `frontend_calls changed: expected ${baseline.frontend_calls}, received ${calls.size}`,
    );
  }
  if (
    Object.hasOwn(baseline, "frontend_detection_kinds") &&
    JSON.stringify(baseline.frontend_detection_kinds) !==
      JSON.stringify(detectionKinds)
  ) {
    errors.push(
      `frontend detection kinds changed: expected ${JSON.stringify(
        baseline.frontend_detection_kinds,
      )}, received ${JSON.stringify(detectionKinds)}`,
    );
  }
  if (baseline.missing_calls !== missing.length) {
    errors.push(
      `missing_calls changed: expected ${baseline.missing_calls}, received ${missing.length}`,
    );
  }
  if (baseline.missing_sha256 !== missingDigest) {
    errors.push(
      `missing route set changed: expected ${baseline.missing_sha256}, received ${missingDigest}`,
    );
  }
  if (
    JSON.stringify(baseline.categories) !== JSON.stringify(categoryCounts)
  ) {
    errors.push(
      `category counts changed: expected ${JSON.stringify(baseline.categories)}, received ${JSON.stringify(categoryCounts)}`,
    );
  }
  if (errors.length > 0) {
    for (const error of errors) console.error(`route debt baseline: ${error}`);
    console.error(
      "Review the route delta, then update tools/frontend_route_debt_baseline.json intentionally.",
    );
    process.exitCode = 1;
  }
}
