import { createHash } from "node:crypto";
import { createServer } from "node:http";

const MODES = new Set(["success", "ambiguous", "input_hash_mismatch"]);
const input = Buffer.from(process.env.MOCK_INPUT_BASE64 ?? "", "base64");
const inputSha256 = process.env.MOCK_INPUT_SHA256 ?? "";

if (
  input.length === 0 ||
  !/^[a-f0-9]{64}$/.test(inputSha256) ||
  createHash("sha256").update(input).digest("hex") !== inputSha256
) {
  throw new Error("mock input contract is invalid");
}

const state = {
  mode: "success",
  r2Calls: 0,
  providerCalls: 0,
  lastOperationId: null,
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://container-runtime-mock");
    if (request.method === "GET" && url.pathname === "/control/state") {
      return sendJson(response, 200, state);
    }
    if (request.method === "POST" && url.pathname === "/control/mode") {
      const body = await readJson(request, 1024);
      if (!MODES.has(body.mode)) return sendJson(response, 400, { error: "invalid_mode" });
      state.mode = body.mode;
      return sendJson(response, 200, state);
    }
    if (request.method === "GET" && url.pathname === "/v1/input") {
      state.r2Calls += 1;
      const operationId = requireHeader(request, "x-cinatoken-operation-id");
      requirePositiveIntegerHeader(request, "x-cinatoken-owner-generation");
      state.lastOperationId = operationId;
      const body =
        state.mode === "input_hash_mismatch" ? mismatchedBytes(input) : Buffer.from(input);
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(body.length),
        "x-cinatoken-content-sha256": inputSha256,
      });
      response.end(body);
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname === "/v1/provider-attempts/execute"
    ) {
      state.providerCalls += 1;
      const operationId = requireHeader(request, "x-cinatoken-operation-id");
      const ownerGeneration = requirePositiveIntegerHeader(
        request,
        "x-cinatoken-owner-generation",
      );
      if (requireHeader(request, "x-cinatoken-provider-attempt-generation") !== "1") {
        throw new Error("attempt generation must be 1");
      }
      if (requireHeader(request, "x-cinatoken-content-sha256") !== inputSha256) {
        throw new Error("provider input hash header mismatch");
      }
      const body = await readBody(request, input.length + 1);
      if (!body.equals(input)) throw new Error("provider body mismatch");
      state.lastOperationId = operationId;

      if (state.mode === "ambiguous") {
        return sendJson(response, 202, {
          protocol_version: 1,
          operation_id: operationId,
          owner_generation: ownerGeneration,
          attempt_generation: 1,
          status: "ambiguous",
          code: "ambiguous_execution",
          trace_id: operationId,
        });
      }

      return sendJson(response, 200, {
        protocol_version: 1,
        operation_id: operationId,
        owner_generation: ownerGeneration,
        attempt_generation: 1,
        status: "succeeded",
        provider_status: 200,
        result: {
          object_key: `container-results/v1/${operationId}/${ownerGeneration}/result`,
          object_version: "version-linux-gate",
          sha256: "c".repeat(64),
          size: 2,
          content_type: "application/json",
        },
        trace_id: operationId,
      });
    }
    return sendJson(response, 404, { error: "not_found" });
  } catch (error) {
    return sendJson(response, 400, {
      error: "invalid_mock_request",
      message: error instanceof Error ? error.message : "unknown error",
    });
  }
});

server.listen(80, "0.0.0.0");

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}

function mismatchedBytes(value) {
  const bytes = Buffer.from(value);
  bytes[0] ^= 0x01;
  return bytes;
}

function requireHeader(request, name) {
  const value = request.headers[name];
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

function requirePositiveIntegerHeader(request, name) {
  const value = requireHeader(request, name);
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${name} must be positive`);
  return Number(value);
}

async function readJson(request, limit) {
  return JSON.parse((await readBody(request, limit)).toString("utf8"));
}

async function readBody(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("request body exceeds mock limit");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    "cache-control": "no-store",
  });
  response.end(body);
}
