import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import protobuf from "protobufjs";

const require = createRequire(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contractRoot = path.join(repositoryRoot, "contracts", "container-runtime", "v1");
const protoPath = path.join(contractRoot, "container_runtime.proto");
const descriptorModulePath = path.join(
  contractRoot,
  "generated",
  "container-runtime.protobuf.ts",
);
const descriptorSetPath = path.join(
  contractRoot,
  "generated",
  "container-runtime.pb",
);
const conformanceCasesPath = path.join(
  contractRoot,
  "conformance",
  "operation-protobuf-cases.json",
);
const packageName = "cinatoken.container.runtime.v1";
const expectedProtobufjsVersion = "8.7.1";
const expectedBufVersion = "1.72.0";

function invariant(condition, message) {
  if (!condition) throw new Error(`protobuf artifact generation failed: ${message}`);
}

function compareAscii(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sortObject(value, containerName = "") {
  if (Array.isArray(value)) return value.map((child) => sortObject(child));
  if (value === null || typeof value !== "object") return value;
  // protobufjs emits jsonName beside the equivalent options.json_name, but
  // its public IField descriptor type does not declare that redundant key.
  const entries = Object.entries(value).filter(([key]) => key !== "jsonName");
  if (containerName === "fields") {
    entries.sort(
      ([leftName, left], [rightName, right]) =>
        left.id - right.id || compareAscii(leftName, rightName),
    );
  } else if (containerName === "values") {
    entries.sort(
      ([leftName, left], [rightName, right]) =>
        left - right || compareAscii(leftName, rightName),
    );
  } else {
    entries.sort(([left], [right]) => compareAscii(left, right));
  }
  return Object.fromEntries(
    entries.map(([key, child]) => [key, sortObject(child, key)]),
  );
}

function jsonWithNewline(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function encodeCanonical(type, value) {
  const message = type.fromObject(value);
  const verificationError = type.verify(message);
  invariant(
    verificationError === null,
    `${type.fullName} fixture is invalid: ${verificationError}`,
  );
  return Buffer.from(type.encode(message).finish());
}

function replacePrefix(buffer, expectedPrefix, replacementPrefix) {
  invariant(
    buffer.subarray(0, expectedPrefix.length).equals(expectedPrefix),
    `wire fixture does not start with ${expectedPrefix.toString("hex")}`,
  );
  return Buffer.concat([replacementPrefix, buffer.subarray(expectedPrefix.length)]);
}

function acceptedCase(name, messageType, value, type) {
  return {
    name,
    accepted: true,
    message_type: `${packageName}.${messageType}`,
    wire_hex: encodeCanonical(type, value).toString("hex"),
    value,
  };
}

function rejectedCase(name, messageType, bytes, rejection) {
  return {
    name,
    accepted: false,
    message_type: `${packageName}.${messageType}`,
    wire_hex: Buffer.from(bytes).toString("hex"),
    rejection,
  };
}

function buildConformanceCases(protoRoot) {
  const operationEnvelopeType = protoRoot.lookupType(`${packageName}.OperationEnvelope`);
  const operationResponseType = protoRoot.lookupType(`${packageName}.OperationResponse`);
  const errorResponseType = protoRoot.lookupType(`${packageName}.ErrorResponse`);

  const operationEnvelope = {
    protocol_version: 1,
    operation_id: "operation-inline-1",
    operation_kind: "health_probe",
    owner_generation: 1,
    owner_lease_expires_at: 2_000_000_120,
    execution_deadline_at: 2_000_000_060,
    provider_operation_id: "provider-operation-inline-1",
    admission_sha256: "a".repeat(64),
    input: {
      mode: "OPERATION_INPUT_MODE_INLINE",
      sha256: "b".repeat(64),
      size: 0,
      content_type: "application/json",
    },
    shard: {
      contract_version: 1,
      ring_generation: 7,
      shard_count: 8,
      shard_index: 3,
      instance_name: "cinatoken-relay-shard-v1-0003",
    },
    trace_id: "trace-inline-1",
  };
  const completedResponse = {
    protocol_version: 1,
    operation_id: "operation-response-1",
    status: "OPERATION_OUTCOME_STATUS_COMPLETED",
    result: {
      object_key: "container-results/v1/operation-response-1/7/result.json",
      object_version: "result-version-1",
      sha256: "c".repeat(64),
      size: 42,
      content_type: "application/json",
    },
    trace_id: "trace-response-1",
  };
  const rejectedResponse = {
    protocol_version: 1,
    operation_id: "operation-response-1",
    status: "OPERATION_OUTCOME_STATUS_REJECTED",
    code: "provider_typed_error",
    classification: "PROVIDER_RESPONSE_CLASSIFICATION_TYPED_ERROR",
    provider_status: 200,
    client_status: 200,
    client_artifact: {
      object_key:
        "container-client-artifacts/v1/operation-response-1/7/" + "d".repeat(64),
      object_version: "client-artifact-version-1",
      client_response_artifact_sha256: "d".repeat(64),
      sha256: "e".repeat(64),
      size: 128,
      content_type: "application/json",
    },
    trace_id: "trace-response-1",
  };
  const recoveryResponse = {
    protocol_version: 1,
    operation_id: "operation-response-1",
    status: "OPERATION_OUTCOME_STATUS_RECOVERY_REQUIRED",
    code: "ambiguous_execution",
    trace_id: "trace-response-1",
  };
  const errorResponse = {
    code: "invalid_operation_envelope",
    message: "request body must match the operation envelope",
  };

  const canonicalEnvelopeBytes = encodeCanonical(operationEnvelopeType, operationEnvelope);
  const completedResponseBytes = encodeCanonical(operationResponseType, completedResponse);
  const missingOperationId = structuredClone(operationEnvelope);
  delete missingOperationId.operation_id;
  const invalidEnumResponse = {
    ...completedResponse,
    status: 99,
  };

  return {
    schema_version: 1,
    cases: [
      acceptedCase(
        "operation_envelope_canonical",
        "OperationEnvelope",
        operationEnvelope,
        operationEnvelopeType,
      ),
      acceptedCase(
        "operation_response_completed",
        "OperationResponse",
        completedResponse,
        operationResponseType,
      ),
      acceptedCase(
        "operation_response_rejected",
        "OperationResponse",
        rejectedResponse,
        operationResponseType,
      ),
      acceptedCase(
        "operation_response_recovery_required",
        "OperationResponse",
        recoveryResponse,
        operationResponseType,
      ),
      acceptedCase("error_response", "ErrorResponse", errorResponse, errorResponseType),
      rejectedCase(
        "reject_operation_envelope_unknown_field",
        "OperationEnvelope",
        Buffer.concat([canonicalEnvelopeBytes, Buffer.from([0xf8, 0x07, 0x01])]),
        "unknown_field",
      ),
      rejectedCase(
        "reject_operation_envelope_duplicate_field",
        "OperationEnvelope",
        Buffer.concat([canonicalEnvelopeBytes, Buffer.from([0x08, 0x01])]),
        "duplicate_field",
      ),
      rejectedCase(
        "reject_operation_envelope_noncanonical_varint",
        "OperationEnvelope",
        replacePrefix(
          canonicalEnvelopeBytes,
          Buffer.from([0x08, 0x01]),
          Buffer.from([0x08, 0x81, 0x00]),
        ),
        "noncanonical_varint",
      ),
      rejectedCase(
        "reject_operation_response_invalid_enum",
        "OperationResponse",
        operationResponseType.encode(operationResponseType.fromObject(invalidEnumResponse)).finish(),
        "invalid_enum",
      ),
      rejectedCase(
        "reject_operation_envelope_missing_semantic_field",
        "OperationEnvelope",
        encodeCanonical(operationEnvelopeType, missingOperationId),
        "missing_semantic_field",
      ),
      rejectedCase(
        "reject_operation_envelope_truncated_length_delimited",
        "OperationEnvelope",
        Buffer.from([0x12, 0x05, 0x61]),
        "malformed_wire",
      ),
    ],
  };
}

function buildDescriptorModule(protoRoot) {
  const descriptor = sortObject(protoRoot.toJSON());
  return `/*
 * Generated by tools/generate_container_runtime_protobuf_artifacts.mjs.
 * Source: contracts/container-runtime/v1/container_runtime.proto
 * Generator: protobufjs ${expectedProtobufjsVersion}. Do not edit directly.
 */
import type { INamespace } from "protobufjs";

export const containerRuntimeProtobufDescriptor: INamespace = ${JSON.stringify(
    descriptor,
    null,
    2,
  )};

export default containerRuntimeProtobufDescriptor;
`;
}

function buildDescriptorSet() {
  const bufCliPath = path.join(repositoryRoot, "node_modules", "@bufbuild", "buf", "bin", "buf");
  const result = spawnSync(
    process.execPath,
    [
      bufCliPath,
      "build",
      "--path",
      "contracts/container-runtime/v1/container_runtime.proto",
      "--as-file-descriptor-set",
      "--exclude-source-info",
      "--output",
      "-",
    ],
    {
      cwd: repositoryRoot,
      encoding: null,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    },
  );
  invariant(result.error === undefined, `Buf could not start: ${result.error?.message}`);
  invariant(
    result.status === 0,
    `Buf descriptor build exited ${result.status}: ${result.stderr.toString("utf8").trim()}`,
  );
  invariant(result.stdout.length > 0, "Buf produced an empty FileDescriptorSet");
  return Buffer.from(result.stdout);
}

function checkOrWrite(outputs, check) {
  const drift = [];
  for (const [outputPath, expected] of outputs) {
    if (check) {
      if (!fs.existsSync(outputPath)) {
        drift.push(`${path.relative(repositoryRoot, outputPath)} is missing`);
        continue;
      }
      const actual = fs.readFileSync(outputPath);
      const expectedBytes = Buffer.isBuffer(expected) ? expected : Buffer.from(expected, "utf8");
      if (!actual.equals(expectedBytes)) {
        drift.push(`${path.relative(repositoryRoot, outputPath)} is stale`);
      }
      continue;
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const expectedBytes = Buffer.isBuffer(expected) ? expected : Buffer.from(expected, "utf8");
    if (!fs.existsSync(outputPath) || !fs.readFileSync(outputPath).equals(expectedBytes)) {
      fs.writeFileSync(outputPath, expectedBytes);
    }
  }
  invariant(
    drift.length === 0,
    `${drift.join("; ")}; run \"bun run generate:container-runtime:protobuf\"`,
  );
}

const args = process.argv.slice(2);
invariant(
  args.length === 0 || (args.length === 1 && args[0] === "--check"),
  "usage: node tools/generate_container_runtime_protobuf_artifacts.mjs [--check]",
);
const check = args[0] === "--check";
const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
const installedProtobufjsVersion = require("protobufjs/package.json").version;
const installedBufVersion = require("@bufbuild/buf/package.json").version;
invariant(
  packageJson.devDependencies?.protobufjs === expectedProtobufjsVersion &&
    installedProtobufjsVersion === expectedProtobufjsVersion,
  `protobufjs must be pinned and installed at ${expectedProtobufjsVersion}`,
);
invariant(
  packageJson.devDependencies?.["@bufbuild/buf"] === expectedBufVersion &&
    installedBufVersion === expectedBufVersion,
  `@bufbuild/buf must be pinned and installed at ${expectedBufVersion}`,
);

const protoSource = fs.readFileSync(protoPath, "utf8");
const { root: protoRoot } = protobuf.parse(protoSource, { keepCase: true });
protoRoot.resolveAll();
const outputs = new Map([
  [descriptorModulePath, buildDescriptorModule(protoRoot)],
  [descriptorSetPath, buildDescriptorSet()],
  [conformanceCasesPath, jsonWithNewline(buildConformanceCases(protoRoot))],
]);
checkOrWrite(outputs, check);

console.log(
  JSON.stringify({
    status: "ok",
    mode: check ? "check" : "generate",
    protobufjs: installedProtobufjsVersion,
    buf: installedBufVersion,
    artifacts: [...outputs.keys()].map((outputPath) =>
      path.relative(repositoryRoot, outputPath).replaceAll(path.sep, "/"),
    ),
  }),
);
