import {
  ProtocolError,
  canonicalJson,
  sha256Hex,
  type AuthenticatedRequest,
} from "./protocol";

export const EXECUTION_CLAIMS_PATH =
  "/internal/v1/shard-placement/execution-claims";
export const EXECUTION_CLAIM_CONTRACT =
  "cinatoken-relay-container-shard-placement-execution-claim-v1";
export const EXECUTION_RECEIPT_CONTRACT =
  "cinatoken-relay-container-shard-placement-execution-receipt-v1";
export const EXECUTION_CLAIM_SCOPE =
  "staging-controller-placement-v1";
export const EXECUTION_OPERATION_COUNT = 11;
export const EXECUTION_FIRST_OPERATION_ORDINAL = 4;
export const EXECUTION_LAST_OPERATION_ORDINAL = 14;
export const EXECUTION_RECEIPT_LIMIT = 64;
export const EXECUTION_LEASE_SECONDS = 60;
export const EXECUTION_RECOVERY_SECONDS = 600;

const SHA256 = /^[0-9a-f]{64}$/;
const CLAIM_FIELDS = [
  "schemaVersion",
  "contract",
  "claimScope",
  "environment",
  "authorizationIdSha256",
  "executionNonceSha256",
  "permitSubjectDigestSha256",
  "applicationTicketIdSha256",
  "applicationTicketDigestSha256",
  "applicationDatabaseIdentitySha256",
  "authorityDatabaseIdentitySha256",
  "campaignId",
  "campaignNonceSha256",
  "executionPlanSha256",
  "releaseSha256",
  "publicationSha256",
  "executionActivationSha256",
  "runnerBuildSha256",
  "claimOwnerSha256",
  "ledgerIdentitySha256",
  "baselineOperationIdSha256",
  "baselineTerminalReceiptSha256",
  "preparationOperationIdSha256",
  "claimOperationIdSha256",
  "leaseTokenSha256",
  "claimCredentialIdSha256",
  "requestIdSha256",
  "generatedAt",
  "normalDeadlineAt",
  "operationScheduleSha256",
  "operations",
  "claimDigestSha256",
  "claimAcquiredReceiptSha256",
] as const;
const OPERATION_FIELDS = [
  "ordinal",
  "operationIdSha256",
  "kind",
  "shardIndex",
] as const;
const RECEIPT_FIELDS = [
  "schemaVersion",
  "contract",
  "eventKind",
  "authorizationIdSha256",
  "claimDigestSha256",
  "executionPlanSha256",
  "ledgerIdentitySha256",
  "sequence",
  "predecessorReceiptSha256",
  "leaseGeneration",
  "leaseTokenSha256",
  "leaseDurationSeconds",
  "actorOwnerSha256",
  "actorCredentialIdSha256",
  "requestIdSha256",
  "operationOrdinal",
  "operationIdSha256",
  "operationKind",
  "shardIndex",
  "outcome",
  "requestSha256",
  "responseSha256",
  "evidenceSha256",
  "cloudflareRequestIdSha256",
  "safetyReason",
  "receiptDigestSha256",
] as const;
const OPERATION_KINDS = new Set([
  "create_authority_claim",
  "activate_execution_ticket",
  "enable_controller_deployment",
  "probe_shard_readiness",
  "disable_controller_deployment",
]);
const EVENT_KINDS = new Set([
  "lease_renewed",
  "lease_taken_over",
  "operation_started",
  "operation_terminal",
  "safety_diverted",
]);
const OPERATION_OUTCOMES = new Set([
  "pending",
  "exact_success",
  "exact_replay",
  "ambiguous_recovered",
  "rejected",
  "unresolved",
  "disable_required",
]);
const SAFETY_REASONS = new Set([
  "operation_failed",
  "lease_expired",
  "lease_revoked",
]);

export interface ExecutionOperation {
  ordinal: number;
  operationIdSha256: string;
  kind:
    | "activate_execution_ticket"
    | "enable_controller_deployment"
    | "probe_shard_readiness"
    | "disable_controller_deployment";
  shardIndex: number | null;
}

export interface ExecutionClaim {
  schemaVersion: 1;
  contract: typeof EXECUTION_CLAIM_CONTRACT;
  claimScope: typeof EXECUTION_CLAIM_SCOPE;
  environment: "staging";
  authorizationIdSha256: string;
  executionNonceSha256: string;
  permitSubjectDigestSha256: string;
  applicationTicketIdSha256: string;
  applicationTicketDigestSha256: string;
  applicationDatabaseIdentitySha256: string;
  authorityDatabaseIdentitySha256: string;
  campaignId: string;
  campaignNonceSha256: string;
  executionPlanSha256: string;
  releaseSha256: string;
  publicationSha256: string;
  executionActivationSha256: string;
  runnerBuildSha256: string;
  claimOwnerSha256: string;
  ledgerIdentitySha256: string;
  baselineOperationIdSha256: string;
  baselineTerminalReceiptSha256: string;
  preparationOperationIdSha256: string;
  claimOperationIdSha256: string;
  leaseTokenSha256: string;
  claimCredentialIdSha256: string;
  requestIdSha256: string;
  generatedAt: number;
  normalDeadlineAt: number;
  operationScheduleSha256: string;
  operations: readonly ExecutionOperation[];
  claimDigestSha256: string;
  claimAcquiredReceiptSha256: string;
}

export type ExecutionEventKind =
  | "lease_renewed"
  | "lease_taken_over"
  | "operation_started"
  | "operation_terminal"
  | "safety_diverted";

export interface ExecutionReceipt {
  schemaVersion: 1;
  contract: typeof EXECUTION_RECEIPT_CONTRACT;
  eventKind: ExecutionEventKind;
  authorizationIdSha256: string;
  claimDigestSha256: string;
  executionPlanSha256: string;
  ledgerIdentitySha256: string;
  sequence: number;
  predecessorReceiptSha256: string;
  leaseGeneration: number;
  leaseTokenSha256: string;
  leaseDurationSeconds: number | null;
  actorOwnerSha256: string;
  actorCredentialIdSha256: string;
  requestIdSha256: string;
  operationOrdinal: number;
  operationIdSha256: string;
  operationKind: ExecutionOperation["kind"] | "create_authority_claim";
  shardIndex: number | null;
  outcome:
    | "pending"
    | "exact_success"
    | "exact_replay"
    | "ambiguous_recovered"
    | "rejected"
    | "unresolved"
    | "disable_required";
  requestSha256: string;
  responseSha256: string | null;
  evidenceSha256: string;
  cloudflareRequestIdSha256: string | null;
  safetyReason:
    | "operation_failed"
    | "lease_expired"
    | "lease_revoked"
    | null;
  receiptDigestSha256: string;
}

export async function parseExecutionClaim(
  body: Uint8Array,
  authentication: AuthenticatedRequest,
  now = Math.floor(Date.now() / 1_000),
): Promise<ExecutionClaim> {
  const value = parseCanonicalObject(body);
  assertExactKeys(value, CLAIM_FIELDS);
  const operations = parseOperations(value.operations);
  const claim: ExecutionClaim = {
    schemaVersion: requireLiteral(value.schemaVersion, 1),
    contract: requireLiteral(value.contract, EXECUTION_CLAIM_CONTRACT),
    claimScope: requireLiteral(value.claimScope, EXECUTION_CLAIM_SCOPE),
    environment: requireLiteral(value.environment, "staging"),
    authorizationIdSha256: requireSha256(value.authorizationIdSha256),
    executionNonceSha256: requireSha256(value.executionNonceSha256),
    permitSubjectDigestSha256:
      requireSha256(value.permitSubjectDigestSha256),
    applicationTicketIdSha256:
      requireSha256(value.applicationTicketIdSha256),
    applicationTicketDigestSha256:
      requireSha256(value.applicationTicketDigestSha256),
    applicationDatabaseIdentitySha256:
      requireSha256(value.applicationDatabaseIdentitySha256),
    authorityDatabaseIdentitySha256:
      requireSha256(value.authorityDatabaseIdentitySha256),
    campaignId: requireSha256(value.campaignId),
    campaignNonceSha256: requireSha256(value.campaignNonceSha256),
    executionPlanSha256: requireSha256(value.executionPlanSha256),
    releaseSha256: requireSha256(value.releaseSha256),
    publicationSha256: requireSha256(value.publicationSha256),
    executionActivationSha256:
      requireSha256(value.executionActivationSha256),
    runnerBuildSha256: requireSha256(value.runnerBuildSha256),
    claimOwnerSha256: requireSha256(value.claimOwnerSha256),
    ledgerIdentitySha256: requireSha256(value.ledgerIdentitySha256),
    baselineOperationIdSha256:
      requireSha256(value.baselineOperationIdSha256),
    baselineTerminalReceiptSha256:
      requireSha256(value.baselineTerminalReceiptSha256),
    preparationOperationIdSha256:
      requireSha256(value.preparationOperationIdSha256),
    claimOperationIdSha256:
      requireSha256(value.claimOperationIdSha256),
    leaseTokenSha256: requireSha256(value.leaseTokenSha256),
    claimCredentialIdSha256:
      requireSha256(value.claimCredentialIdSha256),
    requestIdSha256: requireSha256(value.requestIdSha256),
    generatedAt: requireInteger(value.generatedAt, 1, Number.MAX_SAFE_INTEGER),
    normalDeadlineAt: requireInteger(
      value.normalDeadlineAt,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    operationScheduleSha256:
      requireSha256(value.operationScheduleSha256),
    operations,
    claimDigestSha256: requireSha256(value.claimDigestSha256),
    claimAcquiredReceiptSha256:
      requireSha256(value.claimAcquiredReceiptSha256),
  };
  await requireAuthenticationBinding(claim, authentication);
  if (
    claim.generatedAt > now + 5
    || now - claim.generatedAt > 60
    || claim.normalDeadlineAt < now + EXECUTION_LEASE_SECONDS
    || claim.normalDeadlineAt > claim.generatedAt + 600
  ) {
    throw new ProtocolError("claim_time_window", 403);
  }
  const identities = [
    claim.authorizationIdSha256,
    claim.executionNonceSha256,
    claim.permitSubjectDigestSha256,
    claim.applicationTicketIdSha256,
    claim.applicationTicketDigestSha256,
    claim.applicationDatabaseIdentitySha256,
    claim.authorityDatabaseIdentitySha256,
    claim.campaignId,
    claim.campaignNonceSha256,
    claim.executionPlanSha256,
    claim.claimOwnerSha256,
    claim.ledgerIdentitySha256,
    claim.baselineOperationIdSha256,
    claim.baselineTerminalReceiptSha256,
    claim.preparationOperationIdSha256,
    claim.claimOperationIdSha256,
    claim.leaseTokenSha256,
    ...claim.operations.map((operation) => operation.operationIdSha256),
  ];
  if (new Set(identities).size !== identities.length) {
    throw new ProtocolError("claim_identity_collision", 400);
  }
  const expectedScheduleDigest = await digestCanonical({
    baselineOperationIdSha256: claim.baselineOperationIdSha256,
    preparationOperationIdSha256: claim.preparationOperationIdSha256,
    claimOperationIdSha256: claim.claimOperationIdSha256,
    operations: claim.operations,
  });
  if (claim.operationScheduleSha256 !== expectedScheduleDigest) {
    throw new ProtocolError("operation_schedule_digest_mismatch", 400);
  }
  const digestInput = { ...claim } as Record<string, unknown>;
  delete digestInput.claimDigestSha256;
  delete digestInput.claimAcquiredReceiptSha256;
  const expectedClaimDigest = await digestCanonical(digestInput);
  if (claim.claimDigestSha256 !== expectedClaimDigest) {
    throw new ProtocolError("execution_claim_digest_mismatch", 400);
  }
  const expectedAcquiredDigest = await digestCanonical(
    claimAcquiredDigestInput(claim),
  );
  if (claim.claimAcquiredReceiptSha256 !== expectedAcquiredDigest) {
    throw new ProtocolError("claim_acquired_digest_mismatch", 400);
  }
  return claim;
}

export async function parseExecutionReceipt(
  body: Uint8Array,
  authentication: AuthenticatedRequest,
  acceptedKinds: ReadonlySet<ExecutionEventKind>,
): Promise<ExecutionReceipt> {
  const value = parseCanonicalObject(body);
  assertExactKeys(value, RECEIPT_FIELDS);
  const eventKind = requireSetString(
    value.eventKind,
    EVENT_KINDS,
  ) as ExecutionEventKind;
  if (!acceptedKinds.has(eventKind)) {
    throw new ProtocolError("execution_event_role_mismatch", 403);
  }
  const receipt: ExecutionReceipt = {
    schemaVersion: requireLiteral(value.schemaVersion, 1),
    contract: requireLiteral(value.contract, EXECUTION_RECEIPT_CONTRACT),
    eventKind,
    authorizationIdSha256: requireSha256(value.authorizationIdSha256),
    claimDigestSha256: requireSha256(value.claimDigestSha256),
    executionPlanSha256: requireSha256(value.executionPlanSha256),
    ledgerIdentitySha256: requireSha256(value.ledgerIdentitySha256),
    sequence: requireInteger(value.sequence, 2, EXECUTION_RECEIPT_LIMIT),
    predecessorReceiptSha256:
      requireSha256(value.predecessorReceiptSha256),
    leaseGeneration: requireInteger(
      value.leaseGeneration,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    leaseTokenSha256: requireSha256(value.leaseTokenSha256),
    leaseDurationSeconds: value.leaseDurationSeconds === null
      ? null
      : requireLiteral(
          value.leaseDurationSeconds,
          EXECUTION_LEASE_SECONDS,
        ),
    actorOwnerSha256: requireSha256(value.actorOwnerSha256),
    actorCredentialIdSha256:
      requireSha256(value.actorCredentialIdSha256),
    requestIdSha256: requireSha256(value.requestIdSha256),
    operationOrdinal:
      requireInteger(value.operationOrdinal, 3, 14),
    operationIdSha256: requireSha256(value.operationIdSha256),
    operationKind: requireSetString(
      value.operationKind,
      OPERATION_KINDS,
    ) as ExecutionReceipt["operationKind"],
    shardIndex: requireNullableInteger(value.shardIndex, 0, 7),
    outcome: requireSetString(
      value.outcome,
      OPERATION_OUTCOMES,
    ) as ExecutionReceipt["outcome"],
    requestSha256: requireSha256(value.requestSha256),
    responseSha256: requireNullableSha256(value.responseSha256),
    evidenceSha256: requireSha256(value.evidenceSha256),
    cloudflareRequestIdSha256:
      requireNullableSha256(value.cloudflareRequestIdSha256),
    safetyReason: value.safetyReason === null
      ? null
      : requireSetString(
          value.safetyReason,
          SAFETY_REASONS,
        ) as NonNullable<ExecutionReceipt["safetyReason"]>,
    receiptDigestSha256: requireSha256(value.receiptDigestSha256),
  };
  await requireAuthenticationBinding(receipt, authentication);
  validateReceiptShape(receipt);
  const digestInput = { ...receipt } as Record<string, unknown>;
  delete digestInput.receiptDigestSha256;
  if (
    receipt.receiptDigestSha256
      !== await digestCanonical(digestInput)
  ) {
    throw new ProtocolError("execution_receipt_digest_mismatch", 400);
  }
  return receipt;
}

export function parseExactExecutionClaimQuery(url: URL): {
  claimDigestSha256: string;
  claimOwnerSha256: string;
} {
  const entries = [...url.searchParams.entries()];
  if (
    entries.length !== 2
    || entries[0]?.[0] !== "claimDigestSha256"
    || entries[1]?.[0] !== "claimOwnerSha256"
  ) {
    throw new ProtocolError("invalid_query", 400);
  }
  return {
    claimDigestSha256: requireSha256(entries[0]![1]),
    claimOwnerSha256: requireSha256(entries[1]![1]),
  };
}

export async function requestIdSha256(requestId: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(requestId));
}

export function claimAcquiredDigestInput(
  claim: Pick<
    ExecutionClaim,
    | "authorizationIdSha256"
    | "claimDigestSha256"
    | "executionPlanSha256"
    | "ledgerIdentitySha256"
    | "baselineTerminalReceiptSha256"
    | "claimOwnerSha256"
    | "claimCredentialIdSha256"
    | "requestIdSha256"
    | "claimOperationIdSha256"
    | "leaseTokenSha256"
  >,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    contract: EXECUTION_RECEIPT_CONTRACT,
    eventKind: "claim_acquired",
    authorizationIdSha256: claim.authorizationIdSha256,
    claimDigestSha256: claim.claimDigestSha256,
    executionPlanSha256: claim.executionPlanSha256,
    ledgerIdentitySha256: claim.ledgerIdentitySha256,
    sequence: 1,
    predecessorReceiptSha256:
      claim.baselineTerminalReceiptSha256,
    leaseGeneration: 1,
    leaseTokenSha256: claim.leaseTokenSha256,
    leaseDurationSeconds: EXECUTION_LEASE_SECONDS,
    actorOwnerSha256: claim.claimOwnerSha256,
    actorCredentialIdSha256: claim.claimCredentialIdSha256,
    requestIdSha256: claim.requestIdSha256,
    operationOrdinal: 3,
    operationIdSha256: claim.claimOperationIdSha256,
    operationKind: "create_authority_claim",
    shardIndex: null,
    outcome: "exact_success",
    requestSha256: claim.claimDigestSha256,
    responseSha256: null,
    evidenceSha256: claim.claimDigestSha256,
    cloudflareRequestIdSha256: null,
    safetyReason: null,
  };
}

async function requireAuthenticationBinding(
  value: {
    claimCredentialIdSha256?: string;
    actorCredentialIdSha256?: string;
    requestIdSha256: string;
  },
  authentication: AuthenticatedRequest,
): Promise<void> {
  const credential =
    value.claimCredentialIdSha256
    ?? value.actorCredentialIdSha256;
  if (
    credential !== authentication.credentialIdSha256
    || value.requestIdSha256
      !== await requestIdSha256(authentication.requestId)
  ) {
    throw new ProtocolError("execution_authentication_mismatch", 403);
  }
}

function validateReceiptShape(receipt: ExecutionReceipt): void {
  if (
    receipt.eventKind === "lease_renewed"
    || receipt.eventKind === "lease_taken_over"
  ) {
    const valid =
      receipt.operationOrdinal === 3
      && receipt.operationKind === "create_authority_claim"
      && receipt.shardIndex === null
      && receipt.outcome === "exact_success"
      && receipt.responseSha256 === null
      && receipt.cloudflareRequestIdSha256 === null
      && receipt.safetyReason === null
      && receipt.leaseDurationSeconds === EXECUTION_LEASE_SECONDS;
    if (!valid) throw new ProtocolError("lease_event_invalid", 400);
    return;
  }
  if (receipt.eventKind === "safety_diverted") {
    if (
      receipt.operationOrdinal !== 14
      || receipt.operationKind !== "disable_controller_deployment"
      || receipt.shardIndex !== null
      || receipt.outcome !== "disable_required"
      || receipt.responseSha256 !== null
      || receipt.cloudflareRequestIdSha256 !== null
      || receipt.safetyReason === null
      || receipt.leaseDurationSeconds !== null
    ) {
      throw new ProtocolError("safety_event_invalid", 400);
    }
    return;
  }
  if (
    receipt.operationOrdinal < 4
    || receipt.operationKind === "create_authority_claim"
    || receipt.leaseDurationSeconds !== null
    || receipt.safetyReason !== null
  ) {
    throw new ProtocolError("operation_receipt_invalid", 400);
  }
  validateOperationShape({
    ordinal: receipt.operationOrdinal,
    kind: receipt.operationKind,
    shardIndex: receipt.shardIndex,
  });
  if (
    receipt.eventKind === "operation_started"
    && (
      receipt.outcome !== "pending"
      || receipt.responseSha256 !== null
      || receipt.cloudflareRequestIdSha256 !== null
    )
  ) {
    throw new ProtocolError("operation_receipt_invalid", 400);
  }
  if (
    receipt.eventKind === "operation_terminal"
    && (
      receipt.outcome === "pending"
      || receipt.outcome === "disable_required"
      || receipt.responseSha256 === null
    )
  ) {
    throw new ProtocolError("operation_receipt_invalid", 400);
  }
}

function parseOperations(value: unknown): readonly ExecutionOperation[] {
  if (!Array.isArray(value) || value.length !== EXECUTION_OPERATION_COUNT) {
    throw new ProtocolError("operation_schedule_invalid", 400);
  }
  const operations = value.map((entry) => {
    const operation = requireObject(entry);
    assertExactKeys(operation, OPERATION_FIELDS);
    return {
      ordinal: requireInteger(operation.ordinal, 4, 14),
      operationIdSha256: requireSha256(operation.operationIdSha256),
      kind: requireSetString(
        operation.kind,
        OPERATION_KINDS,
      ) as ExecutionOperation["kind"],
      shardIndex: requireNullableInteger(operation.shardIndex, 0, 7),
    };
  });
  for (let index = 0; index < operations.length; index += 1) {
    const expectedOrdinal = EXECUTION_FIRST_OPERATION_ORDINAL + index;
    if (operations[index]!.ordinal !== expectedOrdinal) {
      throw new ProtocolError("operation_schedule_invalid", 400);
    }
    validateOperationShape(operations[index]!);
  }
  if (
    new Set(operations.map((operation) => operation.operationIdSha256)).size
      !== operations.length
  ) {
    throw new ProtocolError("operation_schedule_invalid", 400);
  }
  return operations;
}

function validateOperationShape(value: {
  ordinal: number;
  kind: string;
  shardIndex: number | null;
}): void {
  const valid =
    (value.ordinal === 4
      && value.kind === "activate_execution_ticket"
      && value.shardIndex === null)
    || (value.ordinal === 5
      && value.kind === "enable_controller_deployment"
      && value.shardIndex === null)
    || (value.ordinal >= 6
      && value.ordinal <= 13
      && value.kind === "probe_shard_readiness"
      && value.shardIndex === value.ordinal - 6)
    || (value.ordinal === 14
      && value.kind === "disable_controller_deployment"
      && value.shardIndex === null);
  if (!valid) {
    throw new ProtocolError("operation_schedule_invalid", 400);
  }
}

function parseCanonicalObject(body: Uint8Array): Record<string, unknown> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(body);
  } catch {
    throw new ProtocolError("invalid_utf8", 400);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProtocolError("invalid_json", 400);
  }
  const object = requireObject(value);
  if (canonicalJson(object) !== text) {
    throw new ProtocolError("noncanonical_json", 400);
  }
  return object;
}

function requireObject(value: unknown): Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) {
    throw new ProtocolError("invalid_shape", 400);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    throw new ProtocolError("invalid_shape", 400);
  }
}

function requireLiteral<T extends string | number>(
  value: unknown,
  expected: T,
): T {
  if (value !== expected) throw new ProtocolError("invalid_shape", 400);
  return expected;
}

function requireSha256(value: unknown): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new ProtocolError("invalid_shape", 400);
  }
  return value;
}

function requireNullableSha256(value: unknown): string | null {
  return value === null ? null : requireSha256(value);
}

function requireInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < minimum
    || (value as number) > maximum
  ) {
    throw new ProtocolError("invalid_shape", 400);
  }
  return value as number;
}

function requireNullableInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null {
  return value === null
    ? null
    : requireInteger(value, minimum, maximum);
}

function requireSetString(
  value: unknown,
  allowed: ReadonlySet<string>,
): string {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new ProtocolError("invalid_shape", 400);
  }
  return value;
}

async function digestCanonical(value: unknown): Promise<string> {
  return sha256Hex(
    new TextEncoder().encode(canonicalJson(value)),
  );
}
