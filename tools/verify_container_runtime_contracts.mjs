import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import protobuf from "protobufjs";

const require = createRequire(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contractRoot = path.join(repositoryRoot, "contracts", "container-runtime", "v1");
const openApiPath = path.join(contractRoot, "container-runtime.openapi.json");
const protoPath = path.join(contractRoot, "container_runtime.proto");
const generatedTypesPath = path.join(
  contractRoot,
  "generated",
  "container-runtime.openapi.ts",
);
const generatedProtobufDescriptorPath = path.join(
  contractRoot,
  "generated",
  "container-runtime.protobuf.ts",
);
const generatedProtobufDescriptorSetPath = path.join(
  contractRoot,
  "generated",
  "container-runtime.pb",
);
const protobufGeneratorPath = path.join(
  repositoryRoot,
  "tools",
  "generate_container_runtime_protobuf_artifacts.mjs",
);
const controllerContractPath = path.join(
  repositoryRoot,
  "services",
  "container-controller",
  "src",
  "container_runtime_contract.ts",
);
const controllerProtocolPath = path.join(
  repositoryRoot,
  "services",
  "container-controller",
  "src",
  "protocol.ts",
);
const vectorsPath = path.join(
  contractRoot,
  "conformance",
  "operation-envelope-cases.json",
);
const responseVectorsPath = path.join(
  contractRoot,
  "conformance",
  "operation-response-cases.json",
);
const protobufVectorsPath = path.join(
  contractRoot,
  "conformance",
  "operation-protobuf-cases.json",
);
const packageName = "cinatoken.container.runtime.v1";

const openApi = JSON.parse(fs.readFileSync(openApiPath, "utf8"));
const protoSource = fs.readFileSync(protoPath, "utf8");
const generatedTypesSource = fs.readFileSync(generatedTypesPath, "utf8");
const generatedProtobufDescriptorSource = fs.readFileSync(
  generatedProtobufDescriptorPath,
  "utf8",
);
const generatedProtobufDescriptorSet = fs.readFileSync(generatedProtobufDescriptorSetPath);
const controllerContractSource = fs.readFileSync(controllerContractPath, "utf8");
const controllerProtocolSource = fs.readFileSync(controllerProtocolPath, "utf8");
const vectors = JSON.parse(fs.readFileSync(vectorsPath, "utf8"));
const responseVectors = JSON.parse(fs.readFileSync(responseVectorsPath, "utf8"));
const protobufVectors = JSON.parse(fs.readFileSync(protobufVectorsPath, "utf8"));
const { root: protoRoot } = protobuf.parse(protoSource, { keepCase: true });
protoRoot.resolveAll();
const descriptorRoot = require("protobufjs/ext/descriptor");
const descriptorAssignment =
  "export const containerRuntimeProtobufDescriptor: INamespace = ";
const descriptorStart = generatedProtobufDescriptorSource.indexOf(descriptorAssignment);
const descriptorEnd = generatedProtobufDescriptorSource.indexOf(
  ";\n\nexport default containerRuntimeProtobufDescriptor;",
);
invariant(
  descriptorStart >= 0 && descriptorEnd > descriptorStart,
  "generated protobuf descriptor module shape drifted",
);
const generatedProtobufNamespace = JSON.parse(
  generatedProtobufDescriptorSource.slice(
    descriptorStart + descriptorAssignment.length,
    descriptorEnd,
  ),
);
const generatedProtoRoot = protobuf.Root.fromJSON(generatedProtobufNamespace);
generatedProtoRoot.resolveAll();

function invariant(condition, message) {
  if (!condition) throw new Error(`container runtime contract invariant failed: ${message}`);
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function assertExactSet(actual, expected, label) {
  const actualSorted = sorted(actual);
  const expectedSorted = sorted(expected);
  invariant(
    JSON.stringify(actualSorted) === JSON.stringify(expectedSorted),
    `${label}: expected ${expectedSorted.join(", ")}; got ${actualSorted.join(", ")}`,
  );
}

function resolveLocalReference(document, reference) {
  invariant(reference.startsWith("#/"), `only local OpenAPI references are allowed: ${reference}`);
  return reference
    .slice(2)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((current, segment) => {
      invariant(
        current !== null && typeof current === "object" && segment in current,
        `unresolved OpenAPI reference: ${reference}`,
      );
      return current[segment];
    }, document);
}

function validateReferences(value) {
  if (Array.isArray(value)) {
    for (const item of value) validateReferences(item);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (typeof value.$ref === "string") resolveLocalReference(openApi, value.$ref);
  for (const child of Object.values(value)) validateReferences(child);
}

function propertyNames(schemaName) {
  const schema = openApi.components.schemas[schemaName];
  invariant(schema && typeof schema === "object", `missing OpenAPI schema ${schemaName}`);
  invariant(
    schema.properties && typeof schema.properties === "object",
    `OpenAPI schema ${schemaName} has no properties`,
  );
  return Object.keys(schema.properties);
}

function requireClosedObject(schemaName, requireEveryProperty = true) {
  const schema = openApi.components.schemas[schemaName];
  invariant(schema.type === "object", `${schemaName} must be an object schema`);
  invariant(schema.additionalProperties === false, `${schemaName} must reject unknown fields`);
  if (requireEveryProperty) {
    assertExactSet(schema.required ?? [], propertyNames(schemaName), `${schemaName} required fields`);
  }
}

function protoFields(messageName) {
  return protoRoot.lookupType(`${packageName}.${messageName}`).fieldsArray;
}

function requireProtoFieldNumbers(messageName, expected) {
  const fields = protoFields(messageName);
  assertExactSet(
    fields.map((field) => field.name),
    Object.keys(expected),
    `${messageName} protobuf fields`,
  );
  for (const field of fields) {
    invariant(
      field.id === expected[field.name],
      `${messageName}.${field.name} must retain field number ${expected[field.name]}`,
    );
  }
}

function requireEnum(enumName, expected) {
  const enumeration = protoRoot.lookupEnum(`${packageName}.${enumName}`);
  invariant(
    JSON.stringify(enumeration.values) === JSON.stringify(expected),
    `${enumName} values or numbers changed`,
  );
}

function requireGeneratedProtobufArtifactsCurrent() {
  const result = spawnSync(process.execPath, [protobufGeneratorPath, "--check"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  invariant(result.error === undefined, `protobuf artifact check failed to start: ${result.error}`);
  invariant(
    result.status === 0,
    `generated protobuf artifacts drifted: ${(result.stderr || result.stdout).trim()}`,
  );
}

function requireBinaryMedia(content, expectedMessages, label) {
  invariant(content && typeof content === "object", `${label} content is missing`);
  const media = content["application/x-protobuf"];
  invariant(media && typeof media === "object", `${label} protobuf media is missing`);
  assertExactSet(Object.keys(media.schema ?? {}), ["type", "format"], `${label} binary schema`);
  invariant(media.schema.type === "string", `${label} protobuf schema must be a string`);
  invariant(media.schema.format === "binary", `${label} protobuf schema format must be binary`);
  if (expectedMessages.length === 1) {
    invariant(
      media["x-cinatoken-protobuf-message"] === expectedMessages[0],
      `${label} protobuf message mapping drifted`,
    );
    invariant(
      media["x-cinatoken-protobuf-messages"] === undefined,
      `${label} must use the singular protobuf message mapping`,
    );
    return;
  }
  invariant(
    media["x-cinatoken-protobuf-message"] === undefined,
    `${label} must use the plural protobuf message mapping`,
  );
  assertExactSet(
    media["x-cinatoken-protobuf-messages"] ?? [],
    expectedMessages,
    `${label} protobuf message mappings`,
  );
}

function readWireVarint(bytes, startOffset) {
  let offset = startOffset;
  let value = 0n;
  for (let index = 0; index < 10; index += 1) {
    invariant(offset < bytes.length, "truncated protobuf varint");
    const byte = bytes[offset];
    offset += 1;
    invariant(index < 9 || byte <= 1, "protobuf varint exceeds 64 bits");
    value |= BigInt(byte & 0x7f) << BigInt(index * 7);
    if ((byte & 0x80) === 0) {
      let canonicalLength = 1;
      for (let remaining = value; remaining >= 0x80n; remaining >>= 7n) {
        canonicalLength += 1;
      }
      return {
        value,
        offset,
        canonical: offset - startOffset === canonicalLength,
      };
    }
  }
  throw new Error("container runtime contract invariant failed: unterminated protobuf varint");
}

function scanTopLevelWire(bytes) {
  const records = [];
  let offset = 0;
  while (offset < bytes.length) {
    const key = readWireVarint(bytes, offset);
    offset = key.offset;
    const fieldNumber = Number(key.value >> 3n);
    const wireType = Number(key.value & 0x07n);
    invariant(
      fieldNumber > 0 && fieldNumber <= 536_870_911,
      `invalid protobuf field number ${fieldNumber}`,
    );
    let canonical = key.canonical;
    if (wireType === 0) {
      const value = readWireVarint(bytes, offset);
      offset = value.offset;
      canonical &&= value.canonical;
    } else if (wireType === 1) {
      invariant(offset + 8 <= bytes.length, "truncated fixed64 protobuf field");
      offset += 8;
    } else if (wireType === 2) {
      const length = readWireVarint(bytes, offset);
      offset = length.offset;
      canonical &&= length.canonical;
      invariant(length.value <= BigInt(bytes.length - offset), "truncated length-delimited field");
      offset += Number(length.value);
    } else if (wireType === 5) {
      invariant(offset + 4 <= bytes.length, "truncated fixed32 protobuf field");
      offset += 4;
    } else {
      throw new Error(
        `container runtime contract invariant failed: unsupported protobuf wire type ${wireType}`,
      );
    }
    records.push({ fieldNumber, wireType, canonical });
  }
  return records;
}

function semanticWireRejection(messageType, message) {
  if (messageType === `${packageName}.OperationEnvelope`) {
    if (
      message.protocol_version !== 1 ||
      typeof message.operation_id !== "string" ||
      message.operation_id.length === 0 ||
      typeof message.operation_kind !== "string" ||
      message.operation_kind.length === 0 ||
      message.input === null ||
      message.input === undefined ||
      message.shard === null ||
      message.shard === undefined ||
      typeof message.trace_id !== "string" ||
      message.trace_id.length === 0
    ) {
      return "missing_semantic_field";
    }
    if (![1, 2].includes(message.input.mode)) return "invalid_enum";
    return null;
  }
  if (messageType === `${packageName}.OperationResponse`) {
    if (![1, 2, 3].includes(message.status)) return "invalid_enum";
    if (
      message.protocol_version !== 1 ||
      typeof message.operation_id !== "string" ||
      message.operation_id.length === 0 ||
      typeof message.trace_id !== "string" ||
      message.trace_id.length === 0
    ) {
      return "missing_semantic_field";
    }
    const hasCode = Object.hasOwn(message, "code") && message.code.length > 0;
    const hasResult = message.result !== null && message.result !== undefined;
    const hasProviderFields = ["classification", "provider_status", "client_status"].map(
      (field) => Object.hasOwn(message, field),
    );
    const hasClientArtifact =
      message.client_artifact !== null && message.client_artifact !== undefined;
    if (hasProviderFields[0] && ![1, 2, 3].includes(message.classification)) {
      return "invalid_enum";
    }
    if (message.status === 1) {
      return hasCode || hasProviderFields.some(Boolean) || hasClientArtifact
        ? "invalid_presence"
        : null;
    }
    if (message.status === 2) {
      const allProviderFields = hasProviderFields.every(Boolean) && hasClientArtifact;
      const noProviderFields = hasProviderFields.every((present) => !present) && !hasClientArtifact;
      return hasCode && !hasResult && (allProviderFields || noProviderFields)
        ? null
        : "invalid_presence";
    }
    return hasCode && !hasResult && hasProviderFields.every((present) => !present) &&
      !hasClientArtifact
      ? null
      : "invalid_presence";
  }
  if (messageType === `${packageName}.ErrorResponse`) {
    return typeof message.code === "string" &&
      message.code.length > 0 &&
      typeof message.message === "string" &&
      message.message.length > 0
      ? null
      : "missing_semantic_field";
  }
  return "unsupported_message_type";
}

function classifyRejectedWire(messageType, type, bytes) {
  let records;
  try {
    records = scanTopLevelWire(bytes);
  } catch {
    return "malformed_wire";
  }
  if (records.some((record) => !record.canonical)) return "noncanonical_varint";
  const knownFields = new Set(type.fieldsArray.map((field) => field.id));
  if (records.some((record) => !knownFields.has(record.fieldNumber))) return "unknown_field";
  const seen = new Set();
  for (const record of records) {
    if (seen.has(record.fieldNumber)) return "duplicate_field";
    seen.add(record.fieldNumber);
  }
  let decoded;
  try {
    decoded = type.decode(bytes);
  } catch {
    return "malformed_wire";
  }
  const canonical = Buffer.from(type.encode(decoded).finish());
  if (!canonical.equals(bytes)) return "noncanonical_wire";
  return semanticWireRejection(messageType, decoded);
}

requireGeneratedProtobufArtifactsCurrent();

invariant(openApi.openapi === "3.1.0", "OpenAPI version must be 3.1.0");
invariant(openApi.info?.version === "1.0.0", "HTTP contract version must be 1.0.0");
invariant(openApi.info?.license?.identifier === "AGPL-3.0-only", "license identifier drifted");
validateReferences(openApi);
invariant(
  openApi.components?.schemas?.ErrorResponse?.properties?.code?.$ref ===
    "#/components/schemas/OutcomeCode",
  "protocol ErrorResponse code must use the persisted outcome-code alphabet",
);

invariant(
  generatedTypesSource.includes("This file was auto-generated by openapi-typescript"),
  "generated TypeScript contract must retain the generator header",
);
invariant(
  generatedProtobufDescriptorSource.includes(
    "Generated by tools/generate_container_runtime_protobuf_artifacts.mjs",
  ) && generatedProtobufDescriptorSource.includes("INamespace"),
  "generated protobuf TypeScript descriptor must retain its generator and INamespace markers",
);
const descriptorSet = descriptorRoot.FileDescriptorSet.decode(
  generatedProtobufDescriptorSet,
);
invariant(descriptorSet.file.length === 1, "protobuf FileDescriptorSet must contain one file");
const descriptorFile = descriptorSet.file[0];
invariant(descriptorFile.name === "container_runtime.proto", "descriptor proto filename drifted");
invariant(descriptorFile.package === packageName, "descriptor package drifted");
invariant(descriptorFile.syntax === "proto3", "descriptor syntax must remain proto3");
invariant(
  descriptorFile.sourceCodeInfo === null || descriptorFile.sourceCodeInfo === undefined,
  "deterministic descriptor set must exclude source info",
);
assertExactSet(
  descriptorFile.messageType.map((message) => message.name),
  [
    "OperationEnvelope",
    "OperationInput",
    "OperationShard",
    "OperationResponse",
    "OperationResultManifest",
    "ClientResponseArtifactManifest",
    "HealthResponse",
    "ReadinessResponse",
    "ErrorResponse",
  ],
  "descriptor messages",
);
assertExactSet(
  descriptorFile.enumType.map((enumeration) => enumeration.name),
  [
    "OperationInputMode",
    "OperationOutcomeStatus",
    "ProviderResponseClassification",
  ],
  "descriptor enums",
);
for (const typeName of [
  "OperationEnvelope",
  "OperationInput",
  "OperationShard",
  "ReadinessResponse",
  "CompletedOperationResponse",
  "ProviderRejectedOperationResponse",
  "RecoveryRequiredOperationResponse",
  "SimpleRejectedOperationResponse",
]) {
  invariant(
    generatedTypesSource.includes(`export type ${typeName} =`),
    `generated TypeScript contract is missing root type ${typeName}`,
  );
}
invariant(
  controllerContractSource.includes(
    "../../../contracts/container-runtime/v1/generated/container-runtime.openapi",
  ),
  "container controller must consume the generated OpenAPI contract boundary",
);
invariant(
  controllerProtocolSource.includes('from "./container_runtime_contract"'),
  "container protocol must import the generated contract boundary",
);
invariant(
  !/export interface Operation(?:Envelope|Input|Shard)\b/.test(controllerProtocolSource),
  "container protocol must not restore handwritten runtime wire types",
);

const contractMetadata = openApi["x-cinatoken-contract"];
invariant(contractMetadata.protocolVersion === 1, "protocol version must be 1");
invariant(contractMetadata.shardContractVersion === 1, "shard contract version must be 1");
invariant(
  contractMetadata.protocolHeader === "x-cinatoken-container-protocol",
  "protocol header drifted",
);
invariant(contractMetadata.maximumRequestBodyBytes === 65_536, "body limit must remain 64 KiB");

const mediaTypes = openApi["x-cinatoken-media-types"];
invariant(mediaTypes["application/json"]?.status === "implemented", "JSON v1 must be implemented");
invariant(
  mediaTypes["application/x-protobuf"]?.status === "implemented",
  "protobuf HTTP transport must be implemented",
);
invariant(
  mediaTypes["application/x-protobuf"]?.controllerActivation === "default-off",
  "controller protobuf activation must remain default-off",
);
for (const [field, message] of Object.entries({
  requestMessage: `${packageName}.OperationEnvelope`,
  operationResponseMessage: `${packageName}.OperationResponse`,
  errorResponseMessage: `${packageName}.ErrorResponse`,
})) {
  invariant(
    mediaTypes["application/x-protobuf"]?.[field] === message,
    `top-level protobuf ${field} mapping drifted`,
  );
}

assertExactSet(Object.keys(openApi.paths), ["/healthz", "/readyz", "/v1/operations"], "paths");
assertExactSet(Object.keys(openApi.components.responses), ["ProtocolError"], "response components");
const operation = openApi.paths["/v1/operations"].post;
assertExactSet(
  Object.keys(operation.requestBody.content),
  ["application/json", "application/x-protobuf"],
  "request media types",
);
requireBinaryMedia(
  operation.requestBody.content,
  [`${packageName}.OperationEnvelope`],
  "operation request",
);
invariant(
  operation["x-cinatoken-protobuf-target"]?.status === "implemented",
  "operation protobuf transport must be implemented",
);
invariant(
  operation["x-cinatoken-protobuf-target"]?.controllerActivation === "default-off",
  "operation protobuf controller activation must remain default-off",
);
for (const [field, message] of Object.entries({
  requestMessage: `${packageName}.OperationEnvelope`,
  successResponseMessage: `${packageName}.OperationResponse`,
  errorResponseMessage: `${packageName}.ErrorResponse`,
})) {
  invariant(
    operation["x-cinatoken-protobuf-target"]?.[field] === message,
    `operation protobuf ${field} mapping drifted`,
  );
}
const operationResponseMessage = `${packageName}.OperationResponse`;
const errorResponseMessage = `${packageName}.ErrorResponse`;
for (const [status, expectedMessages] of Object.entries({
  200: [operationResponseMessage],
  202: [operationResponseMessage],
  400: [errorResponseMessage],
  413: [errorResponseMessage],
  415: [errorResponseMessage],
  422: [errorResponseMessage, operationResponseMessage],
  426: [errorResponseMessage],
  500: [errorResponseMessage],
  501: [operationResponseMessage],
  503: [operationResponseMessage],
})) {
  const response = operation.responses[status];
  invariant(response && typeof response === "object", `operation response ${status} is missing`);
  const resolvedResponse = response.$ref
    ? resolveLocalReference(openApi, response.$ref)
    : response;
  assertExactSet(
    Object.keys(resolvedResponse.content ?? {}),
    ["application/json", "application/x-protobuf"],
    `operation response ${status} media types`,
  );
  requireBinaryMedia(
    resolvedResponse.content,
    expectedMessages,
    `operation response ${status}`,
  );
}
const protocolHeader = openApi.components.parameters.ContainerProtocolHeader;
invariant(protocolHeader.required === true, "protocol header must be required");
invariant(protocolHeader.schema?.const === "1", "protocol header value must be 1");

for (const schemaName of [
  "HealthResponse",
  "ReadinessResponse",
  "ErrorResponse",
  "OperationEnvelope",
  "InlineOperationInput",
  "R2OperationInput",
  "OperationShard",
  "OperationResultManifest",
  "ClientResponseArtifactManifest",
]) {
  requireClosedObject(schemaName);
}
for (const schemaName of [
  "CompletedOperationResponse",
  "SimpleRejectedOperationResponse",
  "ProviderRejectedOperationResponse",
  "RecoveryRequiredOperationResponse",
]) {
  requireClosedObject(schemaName, false);
}

const positiveSafeInteger = openApi.components.schemas.PositiveSafeInteger;
invariant(positiveSafeInteger.minimum === 1, "safe integers must be positive");
invariant(
  positiveSafeInteger.maximum === Number.MAX_SAFE_INTEGER,
  "safe integer maximum must match TypeScript",
);
const controllerContentType = openApi.components.schemas.ControllerContentType;
invariant(controllerContentType.maxLength === 128, "request content_type maximum must be 128");
const r2Input = openApi.components.schemas.R2OperationInput.properties;
invariant(r2Input.request_object_key.minLength === 8, "R2 key minimum must be 8");
invariant(r2Input.request_object_key.maxLength === 512, "R2 key maximum must be 512");
invariant(r2Input.object_version.maxLength === 128, "R2 version maximum must be 128");

const openApiFields = {
  OperationEnvelope: propertyNames("OperationEnvelope"),
  OperationInput: [...new Set([
    ...propertyNames("InlineOperationInput"),
    ...propertyNames("R2OperationInput"),
  ])],
  OperationShard: propertyNames("OperationShard"),
  OperationResponse: [...new Set([
    ...propertyNames("CompletedOperationResponse"),
    ...propertyNames("SimpleRejectedOperationResponse"),
    ...propertyNames("ProviderRejectedOperationResponse"),
    ...propertyNames("RecoveryRequiredOperationResponse"),
  ])],
  OperationResultManifest: propertyNames("OperationResultManifest"),
  ClientResponseArtifactManifest: propertyNames("ClientResponseArtifactManifest"),
  HealthResponse: propertyNames("HealthResponse"),
  ReadinessResponse: propertyNames("ReadinessResponse"),
  ErrorResponse: propertyNames("ErrorResponse"),
};
for (const [messageName, fields] of Object.entries(openApiFields)) {
  assertExactSet(
    protoFields(messageName).map((field) => field.name),
    fields,
    `${messageName} OpenAPI/protobuf parity`,
  );
}

requireProtoFieldNumbers("OperationEnvelope", {
  protocol_version: 1,
  operation_id: 2,
  operation_kind: 3,
  owner_generation: 4,
  owner_lease_expires_at: 5,
  execution_deadline_at: 6,
  provider_operation_id: 7,
  admission_sha256: 8,
  input: 9,
  shard: 10,
  trace_id: 11,
});
requireProtoFieldNumbers("OperationInput", {
  mode: 1,
  sha256: 2,
  size: 3,
  content_type: 4,
  request_object_key: 5,
  object_version: 6,
});
requireProtoFieldNumbers("OperationShard", {
  contract_version: 1,
  ring_generation: 2,
  shard_count: 3,
  shard_index: 4,
  instance_name: 5,
});
requireProtoFieldNumbers("OperationResponse", {
  protocol_version: 1,
  operation_id: 2,
  status: 3,
  code: 4,
  result: 5,
  classification: 6,
  provider_status: 7,
  client_status: 8,
  client_artifact: 9,
  trace_id: 10,
});
requireProtoFieldNumbers("OperationResultManifest", {
  object_key: 1,
  object_version: 2,
  sha256: 3,
  size: 4,
  content_type: 5,
});
requireProtoFieldNumbers("ClientResponseArtifactManifest", {
  object_key: 1,
  object_version: 2,
  client_response_artifact_sha256: 3,
  sha256: 4,
  size: 5,
  content_type: 6,
});
requireProtoFieldNumbers("HealthResponse", { status: 1 });
requireProtoFieldNumbers("ReadinessResponse", {
  status: 1,
  protocol_version: 2,
  shard_contract_version: 3,
  runtime_build_id: 4,
  execution_enabled: 5,
});
requireProtoFieldNumbers("ErrorResponse", { code: 1, message: 2 });

requireEnum("OperationInputMode", {
  OPERATION_INPUT_MODE_UNSPECIFIED: 0,
  OPERATION_INPUT_MODE_INLINE: 1,
  OPERATION_INPUT_MODE_R2: 2,
});
requireEnum("OperationOutcomeStatus", {
  OPERATION_OUTCOME_STATUS_UNSPECIFIED: 0,
  OPERATION_OUTCOME_STATUS_COMPLETED: 1,
  OPERATION_OUTCOME_STATUS_REJECTED: 2,
  OPERATION_OUTCOME_STATUS_RECOVERY_REQUIRED: 3,
});
requireEnum("ProviderResponseClassification", {
  PROVIDER_RESPONSE_CLASSIFICATION_UNSPECIFIED: 0,
  PROVIDER_RESPONSE_CLASSIFICATION_TYPED_ERROR: 1,
  PROVIDER_RESPONSE_CLASSIFICATION_HTTP_ERROR: 2,
  PROVIDER_RESPONSE_CLASSIFICATION_INVALID_BODY: 3,
});

for (const [messageName, fieldNames] of Object.entries({
  OperationEnvelope: ["input", "shard"],
  OperationResponse: ["result", "client_artifact"],
})) {
  const type = protoRoot.lookupType(`${packageName}.${messageName}`);
  for (const fieldName of fieldNames) {
    const field = type.fields[fieldName];
    invariant(
      field.resolvedType instanceof protobuf.Type,
      `${messageName}.${fieldName} must remain a message field with native presence`,
    );
    invariant(
      field.options?.proto3_optional !== true && field.partOf === null,
      `${messageName}.${fieldName} must not use proto3 optional`,
    );
  }
}
const proto3OptionalFields = [];
for (const messageName of Object.keys(openApiFields)) {
  for (const field of protoFields(messageName)) {
    if (field.options?.proto3_optional === true) {
      proto3OptionalFields.push(`${messageName}.${field.name}`);
    }
  }
}
assertExactSet(
  proto3OptionalFields,
  [
    "OperationInput.request_object_key",
    "OperationInput.object_version",
    "OperationResponse.code",
    "OperationResponse.classification",
    "OperationResponse.provider_status",
    "OperationResponse.client_status",
  ],
  "proto3 optional scalar fields",
);

invariant(vectors.schema_version === 1, "conformance vector schema must be version 1");
invariant(Number.isSafeInteger(vectors.now) && vectors.now > 0, "vector clock must be safe");
invariant(Array.isArray(vectors.cases) && vectors.cases.length >= 6, "missing conformance cases");
assertExactSet(
  vectors.cases.map((entry) => entry.name),
  [...new Set(vectors.cases.map((entry) => entry.name))],
  "unique conformance case names",
);
invariant(vectors.cases.some((entry) => entry.valid === true), "a valid vector is required");
invariant(vectors.cases.some((entry) => entry.valid === false), "an invalid vector is required");
invariant(
  vectors.cases.some(
    (entry) =>
      entry.envelope?.input?.request_object_key === null &&
      entry.envelope?.input?.object_version === null,
  ),
  "explicit-null rejection vector is required",
);

assertExactSet(
  Object.keys(responseVectors),
  ["schema_version", "envelope", "cases"],
  "response conformance vector fields",
);
invariant(
  responseVectors.schema_version === 1,
  "response conformance vector schema must be version 1",
);
invariant(
  responseVectors.envelope !== null &&
    typeof responseVectors.envelope === "object" &&
    !Array.isArray(responseVectors.envelope),
  "response conformance envelope must be an object",
);
assertExactSet(
  Object.keys(responseVectors.envelope),
  ["protocol_version", "operation_id", "owner_generation", "trace_id"],
  "response conformance envelope fields",
);
invariant(
  responseVectors.envelope.protocol_version === 1,
  "response conformance envelope protocol_version must be 1",
);
for (const field of ["operation_id", "trace_id"]) {
  invariant(
    typeof responseVectors.envelope[field] === "string" &&
      responseVectors.envelope[field].length > 0,
    `response conformance envelope ${field} must be non-empty`,
  );
}
invariant(
  Number.isSafeInteger(responseVectors.envelope.owner_generation) &&
    responseVectors.envelope.owner_generation > 0,
  "response conformance envelope owner_generation must be a positive safe integer",
);
invariant(
  Array.isArray(responseVectors.cases) && responseVectors.cases.length > 0,
  "missing response conformance cases",
);

const responseCaseFields = [
  "name",
  "operation_kind",
  "http_status",
  "content_type",
  "accepted",
  "body",
];
for (const [index, entry] of responseVectors.cases.entries()) {
  invariant(
    entry !== null && typeof entry === "object" && !Array.isArray(entry),
    `response conformance case ${index} must be an object`,
  );
  invariant(
    typeof entry.accepted === "boolean",
    `response conformance case ${index} accepted must be boolean`,
  );
  assertExactSet(
    Object.keys(entry),
    entry.accepted ? [...responseCaseFields, "expected_kind"] : responseCaseFields,
    `response conformance case ${index} fields`,
  );
  invariant(
    typeof entry.name === "string" && entry.name.length > 0,
    `response conformance case ${index} name must be non-empty`,
  );
  invariant(
    typeof entry.operation_kind === "string" && entry.operation_kind.length > 0,
    `response conformance case ${entry.name} operation_kind must be non-empty`,
  );
  invariant(
    Number.isSafeInteger(entry.http_status) &&
      entry.http_status >= 100 &&
      entry.http_status <= 599,
    `response conformance case ${entry.name} HTTP status is out of range`,
  );
  invariant(
    typeof entry.content_type === "string" && entry.content_type.length > 0,
    `response conformance case ${entry.name} content_type must be non-empty`,
  );
  if (entry.accepted) {
    invariant(
      entry.expected_kind === "outcome" || entry.expected_kind === "protocol_error",
      `response conformance case ${entry.name} expected_kind is invalid`,
    );
  }
}

invariant(
  new Set(responseVectors.cases.map((entry) => entry.name)).size ===
    responseVectors.cases.length,
  "response conformance case names must be unique",
);
invariant(
  responseVectors.cases.some(
    (entry) => entry.accepted && entry.expected_kind === "outcome",
  ),
  "an accepted outcome response vector is required",
);
invariant(
  responseVectors.cases.some(
    (entry) => entry.accepted && entry.expected_kind === "protocol_error",
  ),
  "an accepted protocol-error response vector is required",
);
invariant(
  responseVectors.cases.some((entry) => !entry.accepted),
  "an invalid response vector is required",
);
assertExactSet(
  [
    ...new Set(
      responseVectors.cases
        .filter((entry) => entry.accepted && entry.expected_kind === "protocol_error")
        .map((entry) => String(entry.http_status)),
    ),
  ],
  ["400", "413", "415", "422", "426", "500"],
  "protocol ErrorResponse HTTP statuses",
);
const outcomeStatuses = new Set(
  responseVectors.cases
    .filter((entry) => entry.accepted && entry.expected_kind === "outcome")
    .map((entry) => entry.body?.status),
);
for (const status of ["completed", "rejected", "recovery_required"]) {
  invariant(
    outcomeStatuses.has(status),
    `an accepted ${status} response vector is required`,
  );
}

assertExactSet(
  Object.keys(protobufVectors),
  ["schema_version", "cases"],
  "protobuf conformance vector fields",
);
invariant(
  protobufVectors.schema_version === 1,
  "protobuf conformance vector schema must be version 1",
);
invariant(
  Array.isArray(protobufVectors.cases) && protobufVectors.cases.length > 0,
  "protobuf conformance cases are missing",
);
const acceptedProtobufCases = {
  operation_envelope_canonical: `${packageName}.OperationEnvelope`,
  operation_response_completed: `${packageName}.OperationResponse`,
  operation_response_rejected: `${packageName}.OperationResponse`,
  operation_response_recovery_required: `${packageName}.OperationResponse`,
  error_response: `${packageName}.ErrorResponse`,
};
const rejectedProtobufCases = {
  reject_operation_envelope_unknown_field: {
    messageType: `${packageName}.OperationEnvelope`,
    rejection: "unknown_field",
  },
  reject_operation_envelope_duplicate_field: {
    messageType: `${packageName}.OperationEnvelope`,
    rejection: "duplicate_field",
  },
  reject_operation_envelope_noncanonical_varint: {
    messageType: `${packageName}.OperationEnvelope`,
    rejection: "noncanonical_varint",
  },
  reject_operation_response_invalid_enum: {
    messageType: `${packageName}.OperationResponse`,
    rejection: "invalid_enum",
  },
  reject_operation_envelope_missing_semantic_field: {
    messageType: `${packageName}.OperationEnvelope`,
    rejection: "missing_semantic_field",
  },
  reject_operation_envelope_truncated_length_delimited: {
    messageType: `${packageName}.OperationEnvelope`,
    rejection: "malformed_wire",
  },
};
assertExactSet(
  protobufVectors.cases.filter((entry) => entry.accepted).map((entry) => entry.name),
  Object.keys(acceptedProtobufCases),
  "accepted protobuf conformance cases",
);
assertExactSet(
  protobufVectors.cases.filter((entry) => !entry.accepted).map((entry) => entry.name),
  Object.keys(rejectedProtobufCases),
  "rejected protobuf conformance cases",
);
invariant(
  new Set(protobufVectors.cases.map((entry) => entry.name)).size ===
    protobufVectors.cases.length,
  "protobuf conformance case names must be unique",
);
invariant(
  new Set(protobufVectors.cases.map((entry) => entry.wire_hex)).size ===
    protobufVectors.cases.length,
  "protobuf conformance wire hex values must be unique",
);

for (const [index, entry] of protobufVectors.cases.entries()) {
  invariant(
    entry !== null && typeof entry === "object" && !Array.isArray(entry),
    `protobuf conformance case ${index} must be an object`,
  );
  invariant(
    typeof entry.accepted === "boolean",
    `protobuf conformance case ${index} accepted must be boolean`,
  );
  assertExactSet(
    Object.keys(entry),
    entry.accepted
      ? ["name", "accepted", "message_type", "wire_hex", "value"]
      : ["name", "accepted", "message_type", "wire_hex", "rejection"],
    `protobuf conformance case ${index} fields`,
  );
  invariant(
    typeof entry.name === "string" && entry.name.length > 0,
    `protobuf conformance case ${index} name must be non-empty`,
  );
  invariant(
    /^(?:[0-9a-f]{2})+$/.test(entry.wire_hex),
    `protobuf conformance case ${entry.name} wire_hex must be non-empty lowercase hex`,
  );
  const bytes = Buffer.from(entry.wire_hex, "hex");
  const type = protoRoot.lookupType(entry.message_type);
  if (entry.accepted) {
    invariant(
      acceptedProtobufCases[entry.name] === entry.message_type,
      `protobuf conformance case ${entry.name} message type drifted`,
    );
    invariant(
      entry.value !== null && typeof entry.value === "object" && !Array.isArray(entry.value),
      `protobuf conformance case ${entry.name} value must be an object`,
    );
    const message = type.fromObject(entry.value);
    invariant(
      type.verify(message) === null,
      `protobuf conformance case ${entry.name} value is not encodable`,
    );
    invariant(
      Buffer.from(type.encode(message).finish()).equals(bytes),
      `protobuf conformance case ${entry.name} value does not reproduce wire_hex`,
    );
    const generatedType = generatedProtoRoot.lookupType(entry.message_type);
    invariant(
      Buffer.from(
        generatedType.encode(generatedType.fromObject(entry.value)).finish(),
      ).equals(bytes),
      `generated INamespace does not reproduce ${entry.name} canonical bytes`,
    );
    const decoded = type.decode(bytes);
    invariant(
      Buffer.from(type.encode(decoded).finish()).equals(bytes),
      `protobuf conformance case ${entry.name} is not canonical`,
    );
    invariant(
      semanticWireRejection(entry.message_type, decoded) === null,
      `protobuf conformance case ${entry.name} violates semantic presence`,
    );
    continue;
  }

  const expected = rejectedProtobufCases[entry.name];
  invariant(expected?.messageType === entry.message_type, `${entry.name} message type drifted`);
  invariant(expected.rejection === entry.rejection, `${entry.name} rejection label drifted`);
  invariant(
    classifyRejectedWire(entry.message_type, type, bytes) === entry.rejection,
    `protobuf conformance case ${entry.name} does not exercise ${entry.rejection}`,
  );
}

console.log(
  JSON.stringify({
    status: "ok",
    openapi: openApi.info.version,
    protobuf_package: packageName,
    messages_checked: Object.keys(openApiFields).length,
    conformance_cases: vectors.cases.length,
    response_conformance_cases: responseVectors.cases.length,
    protobuf_conformance_cases: protobufVectors.cases.length,
    protobuf_transport: "implemented-default-off",
  }),
);
