export const JSON_COMPATIBILITY_EXECUTE_PHASE_REQUEST_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-execute-phase-request-v2" as const;
export const JSON_COMPATIBILITY_PHASE_PROBE_RECEIPT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-phase-probe-receipt-v2" as const;
export const JSON_COMPATIBILITY_PHASE_PERMIT_SUBJECT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-phase-permit-subject-v1" as const;
export const JSON_COMPATIBILITY_PHASE_PERMIT_ENVELOPE_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-phase-permit-envelope-v1" as const;

export const JSON_COMPATIBILITY_PHASE_IDS = Object.freeze([
  "baseline-n-minus-one",
  "mixed-n-n-minus-one",
  "candidate-n",
  "rollback-n-minus-one",
] as const);

export const JSON_COMPATIBILITY_RUNTIME_GENERATIONS = Object.freeze([
  "n",
  "n-minus-one",
] as const);

export const JSON_COMPATIBILITY_SHARD_COUNT = 8 as const;
export const JSON_COMPATIBILITY_MAX_CONCURRENCY = 4 as const;
export const JSON_COMPATIBILITY_CONTROLLER_SERVICE_NAME =
  "cinatoken-container-controller-staging" as const;
export const JSON_COMPATIBILITY_CONTROLLER_ENTRYPOINT =
  "JsonCompatibilityProbeEntrypoint" as const;
export const JSON_COMPATIBILITY_EXECUTOR_SERVICE_NAME =
  "cinatoken-container-runtime-json-compatibility-executor-staging" as const;

const LOWER_SHA256 = /^[0-9a-f]{64}$/;
const OCI_SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BASE64URL_ED25519_SIGNATURE = /^[A-Za-z0-9_-]{86}$/;

export type JsonCompatibilityPhaseId =
  (typeof JSON_COMPATIBILITY_PHASE_IDS)[number];
export type JsonCompatibilityPhaseOrdinal = 1 | 2 | 3 | 4;
export type JsonCompatibilityRuntimeGeneration =
  (typeof JSON_COMPATIBILITY_RUNTIME_GENERATIONS)[number];

export interface JsonCompatibilityRuntimeIdentityV1 {
  readonly buildIdSha256: string;
  readonly imageDigest: string;
}

export interface JsonCompatibilityTopologyOverrideV1 {
  readonly shardIndex: number;
  readonly runtime: JsonCompatibilityRuntimeGeneration;
}

export interface JsonCompatibilityTopologyV1 {
  readonly defaultRuntime: JsonCompatibilityRuntimeGeneration;
  readonly overrides: readonly JsonCompatibilityTopologyOverrideV1[];
}

export interface JsonCompatibilityPhasePermitSubjectV1 {
  readonly schemaVersion: 1;
  readonly contract: typeof JSON_COMPATIBILITY_PHASE_PERMIT_SUBJECT_CONTRACT;
  readonly issuer: string;
  readonly audience: string;
  readonly keyId: string;
  readonly permitIdSha256: string;
  readonly campaignIdSha256: string;
  readonly planDigestSha256: string;
  readonly phaseExecutionId: string;
  readonly controller: {
    readonly serviceName: typeof JSON_COMPATIBILITY_CONTROLLER_SERVICE_NAME;
    readonly versionId: string;
    readonly configSha256: string;
  };
  readonly executor: {
    readonly serviceName: typeof JSON_COMPATIBILITY_EXECUTOR_SERVICE_NAME;
    readonly versionId: string;
  };
  readonly runtimes: {
    readonly n: JsonCompatibilityRuntimeIdentityV1;
    readonly nMinusOne: JsonCompatibilityRuntimeIdentityV1;
  };
  readonly ring: {
    readonly generation: number;
    readonly shardCount: 8;
    readonly candidateShardIndex: number;
  };
  readonly phase: {
    readonly ordinal: JsonCompatibilityPhaseOrdinal;
    readonly id: JsonCompatibilityPhaseId;
    readonly topology: JsonCompatibilityTopologyV1;
  };
  readonly issuedAt: number;
  readonly notBefore: number;
  readonly expiresAt: number;
}

export interface JsonCompatibilityPhasePermitEnvelopeV1 {
  readonly schemaVersion: 1;
  readonly contract: typeof JSON_COMPATIBILITY_PHASE_PERMIT_ENVELOPE_CONTRACT;
  readonly algorithm: "Ed25519";
  readonly subject: JsonCompatibilityPhasePermitSubjectV1;
  readonly subjectSha256: string;
  readonly signatureBase64url: string;
}

export interface JsonCompatibilityExecutePhaseRequestV2 {
  readonly schemaVersion: 2;
  readonly contract: typeof JSON_COMPATIBILITY_EXECUTE_PHASE_REQUEST_CONTRACT;
  readonly kind: "container-runtime-json-compatibility-phase-execution";
  readonly environment: "staging";
  readonly campaignIdSha256: string;
  readonly planDigestSha256: string;
  readonly phaseExecutionId: string;
  readonly controller: {
    readonly serviceName: typeof JSON_COMPATIBILITY_CONTROLLER_SERVICE_NAME;
    readonly versionId: string;
    readonly configSha256: string;
  };
  readonly runtimes: {
    readonly n: JsonCompatibilityRuntimeIdentityV1;
    readonly nMinusOne: JsonCompatibilityRuntimeIdentityV1;
  };
  readonly ring: {
    readonly generation: number;
    readonly shardCount: 8;
    readonly candidateShardIndex: number;
  };
  readonly phase: {
    readonly ordinal: JsonCompatibilityPhaseOrdinal;
    readonly id: JsonCompatibilityPhaseId;
    readonly topology: JsonCompatibilityTopologyV1;
  };
  readonly authorization: JsonCompatibilityPhasePermitEnvelopeV1;
}

export type JsonCompatibilityExecutePhaseRequestSubjectV2 = Omit<
  JsonCompatibilityExecutePhaseRequestV2,
  "authorization"
>;

export class JsonCompatibilityExecutorProtocolError extends Error {
  constructor(
    readonly code:
      | "invalid_execute_phase_request"
      | "executor_disabled"
      | "executor_staging_only"
      | "executor_configuration_error"
      | "invalid_probe_result"
      | "invalid_phase_permit"
      | "phase_permit_time_window"
      | "phase_permit_verifier_unavailable"
      | "campaign_authority_unavailable"
      | "campaign_authority_conflict"
      | "campaign_permit_replayed"
      | "campaign_phase_order_conflict"
      | "campaign_terminal",
    message: string,
  ) {
    super(message);
    this.name = "JsonCompatibilityExecutorProtocolError";
  }
}

export function parseJsonCompatibilityExecutePhaseRequestV2(
  input: unknown,
): JsonCompatibilityExecutePhaseRequestV2 {
  const value = requireRecord(input, "executePhase request");
  requireExactKeys(value, [
    "schemaVersion",
    "contract",
    "kind",
    "environment",
    "campaignIdSha256",
    "planDigestSha256",
    "phaseExecutionId",
    "controller",
    "runtimes",
    "ring",
    "phase",
    "authorization",
  ], "executePhase request");
  const authorization = parsePermitEnvelope(value.authorization);
  const { authorization: _authorization, ...subjectInput } = value;
  const request = {
    ...parseJsonCompatibilityExecutePhaseRequestSubjectV2(subjectInput),
    authorization,
  };
  requirePermitSubjectBinding(request);
  return request;
}

export function parseJsonCompatibilityExecutePhaseRequestSubjectV2(
  input: unknown,
): JsonCompatibilityExecutePhaseRequestSubjectV2 {
  const value = requireRecord(input, "executePhase request subject");
  requireExactKeys(value, [
    "schemaVersion",
    "contract",
    "kind",
    "environment",
    "campaignIdSha256",
    "planDigestSha256",
    "phaseExecutionId",
    "controller",
    "runtimes",
    "ring",
    "phase",
  ], "executePhase request subject");
  requireEqual(value.schemaVersion, 2, "executePhase schema version");
  requireEqual(
    value.contract,
    JSON_COMPATIBILITY_EXECUTE_PHASE_REQUEST_CONTRACT,
    "executePhase contract",
  );
  requireEqual(
    value.kind,
    "container-runtime-json-compatibility-phase-execution",
    "executePhase kind",
  );
  requireEqual(value.environment, "staging", "executePhase environment");
  const campaignIdSha256 = requireSha256(
    value.campaignIdSha256,
    "executePhase campaign ID",
  );
  const planDigestSha256 = requireSha256(
    value.planDigestSha256,
    "executePhase plan digest",
  );
  const phaseExecutionId = requireSafeToken(
    value.phaseExecutionId,
    "executePhase execution ID",
  );
  const controller = parseController(value.controller);
  const runtimes = parseRuntimes(value.runtimes);
  const ring = parseRing(value.ring);
  const phase = parsePhase(value.phase, ring.candidateShardIndex);
  return {
    schemaVersion: 2 as const,
    contract: JSON_COMPATIBILITY_EXECUTE_PHASE_REQUEST_CONTRACT,
    kind: "container-runtime-json-compatibility-phase-execution" as const,
    environment: "staging" as const,
    campaignIdSha256,
    planDigestSha256,
    phaseExecutionId,
    controller,
    runtimes,
    ring,
    phase,
  };
}

export function expectedRuntimeGeneration(
  phaseId: JsonCompatibilityPhaseId,
  candidateShardIndex: number,
  shardIndex: number,
): JsonCompatibilityRuntimeGeneration {
  requirePhaseId(phaseId, "phase ID");
  requireInteger(
    candidateShardIndex,
    0,
    JSON_COMPATIBILITY_SHARD_COUNT - 1,
    "candidate shard index",
  );
  requireInteger(
    shardIndex,
    0,
    JSON_COMPATIBILITY_SHARD_COUNT - 1,
    "shard index",
  );
  switch (phaseId) {
    case "baseline-n-minus-one":
    case "rollback-n-minus-one":
      return "n-minus-one";
    case "mixed-n-n-minus-one":
      return shardIndex === candidateShardIndex ? "n" : "n-minus-one";
    case "candidate-n":
      return "n";
  }
}

export function jsonCompatibilityShardInstanceName(shardIndex: number): string {
  requireInteger(
    shardIndex,
    0,
    JSON_COMPATIBILITY_SHARD_COUNT - 1,
    "shard index",
  );
  return `cinatoken-relay-shard-v1-${shardIndex.toString().padStart(4, "0")}`;
}

function parseController(
  input: unknown,
): JsonCompatibilityExecutePhaseRequestV2["controller"] {
  const value = requireRecord(input, "executePhase Controller");
  requireExactKeys(
    value,
    ["serviceName", "versionId", "configSha256"],
    "executePhase Controller",
  );
  requireEqual(
    value.serviceName,
    JSON_COMPATIBILITY_CONTROLLER_SERVICE_NAME,
    "executePhase Controller service name",
  );
  return {
    serviceName: JSON_COMPATIBILITY_CONTROLLER_SERVICE_NAME,
    versionId: requireSafeToken(
      value.versionId,
      "executePhase Controller version ID",
    ),
    configSha256: requireSha256(
      value.configSha256,
      "executePhase Controller config digest",
    ),
  };
}

function parseRuntimes(
  input: unknown,
): JsonCompatibilityExecutePhaseRequestV2["runtimes"] {
  const value = requireRecord(input, "executePhase runtimes");
  requireExactKeys(value, ["n", "nMinusOne"], "executePhase runtimes");
  const n = parseRuntimeIdentity(value.n, "executePhase runtime N");
  const nMinusOne = parseRuntimeIdentity(
    value.nMinusOne,
    "executePhase runtime N-1",
  );
  if (n.buildIdSha256 === nMinusOne.buildIdSha256) {
    throw invalidRequest("runtime N and N-1 build IDs must differ");
  }
  if (n.imageDigest === nMinusOne.imageDigest) {
    throw invalidRequest("runtime N and N-1 image digests must differ");
  }
  return { n, nMinusOne };
}

function parseRuntimeIdentity(
  input: unknown,
  label: string,
): JsonCompatibilityRuntimeIdentityV1 {
  const value = requireRecord(input, label);
  requireExactKeys(value, ["buildIdSha256", "imageDigest"], label);
  const imageDigest = value.imageDigest;
  if (typeof imageDigest !== "string" || !OCI_SHA256.test(imageDigest)) {
    throw invalidRequest(`${label} image digest must be a sha256 OCI digest`);
  }
  return {
    buildIdSha256: requireSha256(value.buildIdSha256, `${label} build ID`),
    imageDigest,
  };
}

function parseRing(
  input: unknown,
): JsonCompatibilityExecutePhaseRequestV2["ring"] {
  const value = requireRecord(input, "executePhase ring");
  requireExactKeys(
    value,
    ["generation", "shardCount", "candidateShardIndex"],
    "executePhase ring",
  );
  const generation = requireInteger(
    value.generation,
    1,
    Number.MAX_SAFE_INTEGER,
    "executePhase ring generation",
  );
  requireEqual(
    value.shardCount,
    JSON_COMPATIBILITY_SHARD_COUNT,
    "executePhase shard count",
  );
  return {
    generation,
    shardCount: JSON_COMPATIBILITY_SHARD_COUNT,
    candidateShardIndex: requireInteger(
      value.candidateShardIndex,
      0,
      JSON_COMPATIBILITY_SHARD_COUNT - 1,
      "executePhase candidate shard index",
    ),
  };
}

function parsePhase(
  input: unknown,
  candidateShardIndex: number,
): JsonCompatibilityExecutePhaseRequestV2["phase"] {
  const value = requireRecord(input, "executePhase phase");
  requireExactKeys(value, ["ordinal", "id", "topology"], "executePhase phase");
  const id = requirePhaseId(value.id, "executePhase phase ID");
  const ordinal = requireInteger(
    value.ordinal,
    1,
    JSON_COMPATIBILITY_PHASE_IDS.length,
    "executePhase phase ordinal",
  ) as JsonCompatibilityPhaseOrdinal;
  if (JSON_COMPATIBILITY_PHASE_IDS[ordinal - 1] !== id) {
    throw invalidRequest("executePhase phase ordinal does not match phase ID");
  }
  const topology = parseTopology(value.topology);
  const expected = topologyForPhase(id, candidateShardIndex);
  if (JSON.stringify(topology) !== JSON.stringify(expected)) {
    throw invalidRequest(
      "executePhase topology does not match the approved phase and candidate shard",
    );
  }
  return { ordinal, id, topology };
}

function parsePermitEnvelope(
  input: unknown,
): JsonCompatibilityPhasePermitEnvelopeV1 {
  const value = requireRecord(input, "executePhase authorization");
  requireExactKeys(value, [
    "schemaVersion",
    "contract",
    "algorithm",
    "subject",
    "subjectSha256",
    "signatureBase64url",
  ], "executePhase authorization");
  requireEqual(value.schemaVersion, 1, "authorization schema version");
  requireEqual(
    value.contract,
    JSON_COMPATIBILITY_PHASE_PERMIT_ENVELOPE_CONTRACT,
    "authorization contract",
  );
  requireEqual(value.algorithm, "Ed25519", "authorization algorithm");
  const signatureBase64url = value.signatureBase64url;
  if (
    typeof signatureBase64url !== "string"
    || !BASE64URL_ED25519_SIGNATURE.test(signatureBase64url)
  ) {
    throw invalidRequest(
      "authorization signature must be a 64-byte base64url Ed25519 signature",
    );
  }
  return {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_PHASE_PERMIT_ENVELOPE_CONTRACT,
    algorithm: "Ed25519",
    subject: parsePermitSubject(value.subject),
    subjectSha256: requireSha256(
      value.subjectSha256,
      "authorization subject digest",
    ),
    signatureBase64url,
  };
}

function parsePermitSubject(
  input: unknown,
): JsonCompatibilityPhasePermitSubjectV1 {
  const value = requireRecord(input, "executePhase permit subject");
  requireExactKeys(value, [
    "schemaVersion",
    "contract",
    "issuer",
    "audience",
    "keyId",
    "permitIdSha256",
    "campaignIdSha256",
    "planDigestSha256",
    "phaseExecutionId",
    "controller",
    "executor",
    "runtimes",
    "ring",
    "phase",
    "issuedAt",
    "notBefore",
    "expiresAt",
  ], "executePhase permit subject");
  requireEqual(value.schemaVersion, 1, "permit subject schema version");
  requireEqual(
    value.contract,
    JSON_COMPATIBILITY_PHASE_PERMIT_SUBJECT_CONTRACT,
    "permit subject contract",
  );
  const executor = requireRecord(value.executor, "permit subject executor");
  requireExactKeys(
    executor,
    ["serviceName", "versionId"],
    "permit subject executor",
  );
  requireEqual(
    executor.serviceName,
    JSON_COMPATIBILITY_EXECUTOR_SERVICE_NAME,
    "permit subject executor service name",
  );
  const ring = parseRing(value.ring);
  return {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_PHASE_PERMIT_SUBJECT_CONTRACT,
    issuer: requireSafeToken(value.issuer, "permit subject issuer"),
    audience: requireSafeToken(value.audience, "permit subject audience"),
    keyId: requireKeyId(value.keyId, "permit subject key ID"),
    permitIdSha256: requireSha256(
      value.permitIdSha256,
      "permit subject permit ID",
    ),
    campaignIdSha256: requireSha256(
      value.campaignIdSha256,
      "permit subject campaign ID",
    ),
    planDigestSha256: requireSha256(
      value.planDigestSha256,
      "permit subject plan digest",
    ),
    phaseExecutionId: requireSafeToken(
      value.phaseExecutionId,
      "permit subject phase execution ID",
    ),
    controller: parseController(value.controller),
    executor: {
      serviceName: JSON_COMPATIBILITY_EXECUTOR_SERVICE_NAME,
      versionId: requireSafeToken(
        executor.versionId,
        "permit subject executor version ID",
      ),
    },
    runtimes: parseRuntimes(value.runtimes),
    ring,
    phase: parsePhase(value.phase, ring.candidateShardIndex),
    issuedAt: requireInteger(
      value.issuedAt,
      1,
      Number.MAX_SAFE_INTEGER,
      "permit subject issued time",
    ),
    notBefore: requireInteger(
      value.notBefore,
      1,
      Number.MAX_SAFE_INTEGER,
      "permit subject not-before time",
    ),
    expiresAt: requireInteger(
      value.expiresAt,
      1,
      Number.MAX_SAFE_INTEGER,
      "permit subject expiry time",
    ),
  };
}

function requirePermitSubjectBinding(
  request: JsonCompatibilityExecutePhaseRequestV2,
): void {
  const subject = request.authorization.subject;
  if (
    subject.campaignIdSha256 !== request.campaignIdSha256
    || subject.planDigestSha256 !== request.planDigestSha256
    || subject.phaseExecutionId !== request.phaseExecutionId
    || JSON.stringify(subject.controller) !== JSON.stringify(request.controller)
    || JSON.stringify(subject.runtimes) !== JSON.stringify(request.runtimes)
    || JSON.stringify(subject.ring) !== JSON.stringify(request.ring)
    || JSON.stringify(subject.phase) !== JSON.stringify(request.phase)
  ) {
    throw invalidRequest(
      "authorization subject must bind the exact executePhase request",
    );
  }
}

function parseTopology(input: unknown): JsonCompatibilityTopologyV1 {
  const value = requireRecord(input, "executePhase topology");
  requireExactKeys(
    value,
    ["defaultRuntime", "overrides"],
    "executePhase topology",
  );
  const defaultRuntime = requireRuntimeGeneration(
    value.defaultRuntime,
    "executePhase topology default runtime",
  );
  if (!Array.isArray(value.overrides) || value.overrides.length > 1) {
    throw invalidRequest("executePhase topology overrides must contain at most one entry");
  }
  const overrides = value.overrides.map((inputOverride, index) => {
    const label = `executePhase topology override ${index + 1}`;
    const entry = requireRecord(inputOverride, label);
    requireExactKeys(entry, ["shardIndex", "runtime"], label);
    return {
      shardIndex: requireInteger(
        entry.shardIndex,
        0,
        JSON_COMPATIBILITY_SHARD_COUNT - 1,
        `${label} shard index`,
      ),
      runtime: requireRuntimeGeneration(entry.runtime, `${label} runtime`),
    };
  });
  return { defaultRuntime, overrides };
}

function topologyForPhase(
  phaseId: JsonCompatibilityPhaseId,
  candidateShardIndex: number,
): JsonCompatibilityTopologyV1 {
  switch (phaseId) {
    case "baseline-n-minus-one":
    case "rollback-n-minus-one":
      return { defaultRuntime: "n-minus-one", overrides: [] };
    case "mixed-n-n-minus-one":
      return {
        defaultRuntime: "n-minus-one",
        overrides: [{ shardIndex: candidateShardIndex, runtime: "n" }],
      };
    case "candidate-n":
      return { defaultRuntime: "n", overrides: [] };
  }
}

function requireRecord(input: unknown, label: string): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw invalidRequest(`${label} must be an object`);
  }
  return input as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw invalidRequest(`${label} fields must be exactly ${wanted.join(", ")}`);
  }
}

function requireEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw invalidRequest(`${label} must equal ${String(expected)}`);
  }
}

function requireInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw invalidRequest(
      `${label} must be an integer from ${minimum} through ${maximum}`,
    );
  }
  return value;
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !LOWER_SHA256.test(value)) {
    throw invalidRequest(`${label} must be lowercase SHA-256 hex`);
  }
  return value;
}

function requireSafeToken(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_TOKEN.test(value)) {
    throw invalidRequest(`${label} must be a safe opaque token`);
  }
  return value;
}

function requireKeyId(value: unknown, label: string): string {
  if (typeof value !== "string" || !KEY_ID.test(value)) {
    throw invalidRequest(`${label} must be a safe key ID`);
  }
  return value;
}

function requirePhaseId(value: unknown, label: string): JsonCompatibilityPhaseId {
  if (
    typeof value !== "string" ||
    !JSON_COMPATIBILITY_PHASE_IDS.includes(value as JsonCompatibilityPhaseId)
  ) {
    throw invalidRequest(`${label} is not an approved compatibility phase`);
  }
  return value as JsonCompatibilityPhaseId;
}

function requireRuntimeGeneration(
  value: unknown,
  label: string,
): JsonCompatibilityRuntimeGeneration {
  if (
    typeof value !== "string" ||
    !JSON_COMPATIBILITY_RUNTIME_GENERATIONS.includes(
      value as JsonCompatibilityRuntimeGeneration,
    )
  ) {
    throw invalidRequest(`${label} must be n or n-minus-one`);
  }
  return value as JsonCompatibilityRuntimeGeneration;
}

function invalidRequest(message: string): JsonCompatibilityExecutorProtocolError {
  return new JsonCompatibilityExecutorProtocolError(
    "invalid_execute_phase_request",
    message,
  );
}
