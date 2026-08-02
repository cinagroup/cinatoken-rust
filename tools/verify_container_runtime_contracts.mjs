import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import protobuf from "protobufjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contractRoot = path.join(repositoryRoot, "contracts", "container-runtime", "v1");
const openApiPath = path.join(contractRoot, "container-runtime.openapi.json");
const protoPath = path.join(contractRoot, "container_runtime.proto");
const generatedTypesPath = path.join(
  contractRoot,
  "generated",
  "container-runtime.openapi.ts",
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
const packageName = "cinatoken.container.runtime.v1";

const openApi = JSON.parse(fs.readFileSync(openApiPath, "utf8"));
const protoSource = fs.readFileSync(protoPath, "utf8");
const generatedTypesSource = fs.readFileSync(generatedTypesPath, "utf8");
const controllerContractSource = fs.readFileSync(controllerContractPath, "utf8");
const controllerProtocolSource = fs.readFileSync(controllerProtocolPath, "utf8");
const vectors = JSON.parse(fs.readFileSync(vectorsPath, "utf8"));
const responseVectors = JSON.parse(fs.readFileSync(responseVectorsPath, "utf8"));
const { root: protoRoot } = protobuf.parse(protoSource, { keepCase: true });

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
  mediaTypes["application/x-protobuf"]?.status === "target-not-implemented",
  "protobuf must remain explicitly disabled until transport conformance is implemented",
);

assertExactSet(Object.keys(openApi.paths), ["/healthz", "/readyz", "/v1/operations"], "paths");
const operation = openApi.paths["/v1/operations"].post;
assertExactSet(Object.keys(operation.requestBody.content), ["application/json"], "request media types");
invariant(
  operation["x-cinatoken-protobuf-target"]?.status === "target-not-implemented",
  "operation protobuf target status drifted",
);
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

console.log(
  JSON.stringify({
    status: "ok",
    openapi: openApi.info.version,
    protobuf_package: packageName,
    messages_checked: Object.keys(openApiFields).length,
    conformance_cases: vectors.cases.length,
    response_conformance_cases: responseVectors.cases.length,
    protobuf_transport: "target-not-implemented",
  }),
);
