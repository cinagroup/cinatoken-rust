import { createHash } from "node:crypto";

export const RING_TRANSITION_EXECUTION_RECEIPT_CONTRACT =
  "cinatoken-ring-transition-runner-execution-receipt-v1";
export const RING_TRANSITION_OPERATION_RECEIPT_CONTRACT =
  "cinatoken-ring-transition-runner-operation-receipt-v1";
export const RING_TRANSITION_OPERATION_ID_CONTRACT =
  "cinatoken-ring-transition-runner-operation-id-v1";
export const RING_TRANSITION_OPERATION_CAPACITY_RESERVATION_CONTRACT =
  "cinatoken-ring-transition-runner-operation-capacity-reservation-v1";
export const RING_TRANSITION_READ_OPERATION_REQUEST_CONTRACT =
  "cinatoken-ring-transition-runner-read-operation-request-v1";
export const STEP_CONTRACT =
  "cinatoken-relay-container-ring-transition-execution-step-v1";
export const EXPIRY_CONTRACT =
  "cinatoken-relay-container-ring-transition-expiry-event-v1";
export const MAX_RING_TRANSITION_RECEIPT_BYTES = 64 * 1024;
export const MAX_RING_TRANSITION_RECEIPTS_PER_CHAIN = 128;
export const MAX_RING_TRANSITION_OPERATION_RECEIPTS_PER_CHAIN = 2;
export const MAX_RING_TRANSITION_OPERATION_CHAINS_PER_AUTHORIZATION = 128;
export const MAX_RING_TRANSITION_READ_RECOVERY_SECONDS = 600;

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CLAIM_STATUSES = new Set([
  "claimed",
  "t1_verified",
  "controller_inflight",
  "controller_verified",
  "edge_prechecked",
  "edge_inflight",
  "completed",
  "recovery_required",
  "aborted",
  "expired",
]);
const TERMINAL_CLAIM_STATUSES = new Set([
  "completed",
  "recovery_required",
  "aborted",
  "expired",
]);
const STEP_CODES = new Set([
  "t1_readback",
  "controller_mutation_intent",
  "controller_post_readback",
  "edge_pre_readback",
  "edge_mutation_intent",
  "edge_post_readback",
  "terminal",
]);
const TRANSPORT_OUTCOMES = new Set([
  "not_applicable",
  "success",
  "ambiguous",
  "rejected",
]);
const FAILURE_CLASSES = new Set([
  "",
  "authorization_expired",
  "operator_abort",
  "transport_response_lost",
  "http_rejected",
  "readback_drift",
  "target_not_stable",
]);
const OPERATION_KINDS = new Set([
  "authority_claim_create",
  "authority_claim_read",
  "authority_preflight_read",
  "authority_step_append",
  "cloudflare_deployment",
  "cloudflare_deploy_token_verify_read",
  "cloudflare_deployment_read",
  "cloudflare_token_verify_read",
  "cloudflare_version_read",
]);
const READ_OPERATION_KINDS = new Set([
  "authority_claim_read",
  "authority_preflight_read",
  "cloudflare_deploy_token_verify_read",
  "cloudflare_deployment_read",
  "cloudflare_token_verify_read",
  "cloudflare_version_read",
]);
const RECOVERY_OPERATION_KINDS = new Set([
  "authority_claim_read",
  "authority_preflight_read",
  "cloudflare_deploy_token_verify_read",
  "cloudflare_token_verify_read",
]);
const OPERATION_OUTCOMES = new Set([
  "accepted",
  "rejected",
  "ambiguous",
]);
const FORBIDDEN_FIELD_NAMES = new Set([
  "accessclientsecret",
  "apikey",
  "apisecret",
  "apitoken",
  "authorization",
  "authorizationheader",
  "cookie",
  "credentialvalue",
  "hmac",
  "password",
  "requestbody",
  "responsebody",
  "secret",
  "setcookie",
  "token",
]);
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const textEncoder = new TextEncoder();

const RECEIPT_KEYS = [
  "schemaVersion",
  "contract",
  "environment",
  "sequence",
  "predecessorReceiptSha256",
  "recordedAt",
  "release",
  "credentialIdentity",
  "claim",
  "event",
];
const RELEASE_KEYS = [
  "sourceCommit",
  "gitTreeSha",
  "releaseManifestSha256",
  "releasePacketSha256",
  "releasePolicySha256",
  "artifactSha256",
  "moduleInventorySha256",
  "moduleCount",
  "publicationManifestSha256",
  "publicationPacketSha256",
  "generationSha256",
  "activationSequence",
  "previousPublicationManifestSha256",
  "publishedAt",
  "expiresAt",
];
const CREDENTIAL_IDENTITY_KEYS = [
  "accountIdSha256",
  "readCredentialIdSha256",
  "claimCredentialIdSha256",
  "deployCredentialIdSha256",
  "accessClientIdSha256",
  "authorityVersionId",
  "permitSpkiSha256",
  "trustConfigSha256",
  "runnerBuildSha256",
  "controllerServiceName",
  "edgeServiceName",
  "stableReadbackObservationSeconds",
];
const CLAIM_KEYS = [
  "authorizationIdSha256",
  "claimDigestSha256",
  "ledgerIdentitySha256",
  "claimOwnerSha256",
  "accountIdSha256",
  "generatedAt",
  "claimedAt",
  "expiresAt",
];
const STEP_KEYS = [
  "stateVersion",
  "stepCode",
  "fromStatus",
  "toStatus",
  "actorExecutionIdSha256",
  "mutationRequestSha256",
  "cloudflareRequestIdSha256",
  "deploymentSetSha256",
  "evidenceSha256",
  "failureClass",
  "transportOutcome",
  "stepDigestSha256",
];
const EXPIRY_KEYS = [
  "stateVersion",
  "fromStatus",
  "toStatus",
  "authorityActorIdSha256",
  "evidenceSha256",
  "expiryEventDigestSha256",
  "failureClass",
];
const OPERATION_RECEIPT_KEYS = [
  "schemaVersion",
  "contract",
  "environment",
  "sequence",
  "predecessorReceiptSha256",
  "recordedAt",
  "context",
  "operation",
  "event",
];
const OPERATION_CONTEXT_KEYS = [
  "sourceCommit",
  "gitTreeSha",
  "releaseManifestSha256",
  "releasePacketSha256",
  "releasePolicySha256",
  "artifactSha256",
  "moduleInventorySha256",
  "moduleCount",
  "publicationManifestSha256",
  "publicationPacketSha256",
  "generationSha256",
  "activationSha256",
  "activationSequence",
  "authorizationIdSha256",
  "claimDigestSha256",
  "ledgerIdentitySha256",
  "claimOwnerSha256",
  "accountIdSha256",
  "readCredentialIdSha256",
  "claimCredentialIdSha256",
  "deployCredentialIdSha256",
  "accessClientIdSha256",
  "authorityVersionId",
  "permitSpkiSha256",
  "trustConfigSha256",
  "controllerServiceName",
  "edgeServiceName",
  "generatedAt",
  "expiresAt",
];
const OPERATION_IDENTITY_KEYS = [
  "operationIdSha256",
  "kind",
  "stateVersion",
  "method",
  "targetSha256",
  "requestSha256",
];

export function describeRingTransitionExecutionReceiptContract() {
  return {
    ok: true,
    schemaVersion: 1,
    contract: RING_TRANSITION_EXECUTION_RECEIPT_CONTRACT,
    environment: "staging",
    maximumReceiptBytes: MAX_RING_TRANSITION_RECEIPT_BYTES,
    maximumReceiptsPerChain: MAX_RING_TRANSITION_RECEIPTS_PER_CHAIN,
    constraints: {
      canonicalJsonRequired: true,
      duplicateAndUnknownFieldsAllowed: false,
      predecessorSha256Required: true,
      sharedIdentityRequired: true,
      monotonicRecordedAtRequired: true,
      terminalSealRequired: true,
      unsealedPrefixVerificationSupported: true,
      credentialsRead: false,
      networkRequestsPerformed: false,
      filesWritten: false,
      remoteMutationAuthorized: false,
    },
  };
}

export function describeRingTransitionOperationReceiptContract() {
  return {
    ok: true,
    schemaVersion: 1,
    contract: RING_TRANSITION_OPERATION_RECEIPT_CONTRACT,
    environment: "staging",
    maximumReceiptBytes: MAX_RING_TRANSITION_RECEIPT_BYTES,
    maximumReceiptsPerChain:
      MAX_RING_TRANSITION_OPERATION_RECEIPTS_PER_CHAIN,
    maximumOperationChainsPerAuthorization:
      MAX_RING_TRANSITION_OPERATION_CHAINS_PER_AUTHORIZATION,
    maximumReadRecoverySeconds:
      MAX_RING_TRANSITION_READ_RECOVERY_SECONDS,
    verificationScope: "single_operation_chain",
    aggregateCapacityVerified: false,
    absoluteHttpsTargetVerified: false,
    constraints: {
      canonicalJsonRequired: true,
      duplicateAndUnknownFieldsAllowed: false,
      deterministicOperationIdRequired: true,
      createNewCapacityMarkersRequired: true,
      strandedCapacityMarkersAreNonAuthorizing: true,
      readRequestsUseUniqueRequestBoundOperationIds: true,
      readOperationsAreNonAuthorizing: true,
      requestStartRequiredBeforeMutation: true,
      createNewReservationRequired: true,
      restartAfterReservationIsReadOnly: true,
      firstTerminalFinishWins: true,
      credentialsRead: false,
      networkRequestsPerformed: false,
      filesWritten: false,
      remoteMutationAuthorized: false,
    },
  };
}

export function canonicalReceiptJson(value) {
  return writeCanonical(value);
}

export function canonicalReceiptBytes(value) {
  return textEncoder.encode(canonicalReceiptJson(value));
}

export function sha256ReceiptBytes(value) {
  const bytes = requireByteArray(value, "[receipt] bytes");
  return createHash("sha256").update(bytes).digest("hex");
}

export function computeRingTransitionOperationId({
  context,
  kind,
  stateVersion,
  method,
  targetSha256,
  requestSha256,
}) {
  const identity = requireObject(context, "[operation id] context");
  requireSha256(
    identity.activationSha256,
    "[operation id] activationSha256",
  );
  requireSha256(
    identity.authorizationIdSha256,
    "[operation id] authorizationIdSha256",
  );
  requireSha256(
    identity.claimDigestSha256,
    "[operation id] claimDigestSha256",
  );
  validateOperationShape(
    { kind, stateVersion, method, targetSha256, requestSha256 },
    "[operation id]",
  );
  return sha256ReceiptBytes(
    canonicalReceiptBytes({
      schemaVersion: 1,
      contract: RING_TRANSITION_OPERATION_ID_CONTRACT,
      activationSha256: identity.activationSha256,
      authorizationIdSha256: identity.authorizationIdSha256,
      claimDigestSha256: identity.claimDigestSha256,
      kind,
      stateVersion,
      method,
      targetSha256,
      requestSha256,
    }),
  );
}

export function computeRingTransitionReadOperationRequestSha256({
  targetSha256,
  requestIdSha256,
}) {
  requireSha256(targetSha256, "[read operation request] targetSha256");
  requireSha256(
    requestIdSha256,
    "[read operation request] requestIdSha256",
  );
  return sha256ReceiptBytes(
    canonicalReceiptBytes({
      schemaVersion: 1,
      contract: RING_TRANSITION_READ_OPERATION_REQUEST_CONTRACT,
      method: "GET",
      targetSha256,
      requestIdSha256,
    }),
  );
}

export function computeRingTransitionStepDigest({ claim, step }) {
  const claimIdentity = requireObject(claim, "[step digest] claim");
  const historyStep = requireObject(step, "[step digest] step");
  requireSha256(
    claimIdentity.ledgerIdentitySha256,
    "[step digest] ledgerIdentitySha256",
  );
  requireSha256(
    claimIdentity.claimDigestSha256,
    "[step digest] claimDigestSha256",
  );
  return sha256ReceiptBytes(
    canonicalReceiptBytes({
      schemaVersion: 1,
      contract: STEP_CONTRACT,
      ledgerIdentitySha256: claimIdentity.ledgerIdentitySha256,
      claimDigestSha256: claimIdentity.claimDigestSha256,
      stateVersion: historyStep.stateVersion,
      stepCode: historyStep.stepCode,
      fromStatus: historyStep.fromStatus,
      toStatus: historyStep.toStatus,
      mutationRequestSha256: historyStep.mutationRequestSha256,
      cloudflareRequestIdSha256: historyStep.cloudflareRequestIdSha256,
      deploymentSetSha256: historyStep.deploymentSetSha256,
      evidenceSha256: historyStep.evidenceSha256,
      failureClass: historyStep.failureClass,
      transportOutcome: historyStep.transportOutcome,
    }),
  );
}

export function computeRingTransitionExpiryDigest({ claim, expiry }) {
  const claimIdentity = requireObject(claim, "[expiry digest] claim");
  const expiryEvent = requireObject(expiry, "[expiry digest] expiry");
  requireSha256(
    claimIdentity.ledgerIdentitySha256,
    "[expiry digest] ledgerIdentitySha256",
  );
  requireSha256(
    claimIdentity.claimDigestSha256,
    "[expiry digest] claimDigestSha256",
  );
  return sha256ReceiptBytes(
    canonicalReceiptBytes({
      schemaVersion: 1,
      contract: EXPIRY_CONTRACT,
      ledgerIdentitySha256: claimIdentity.ledgerIdentitySha256,
      claimDigestSha256: claimIdentity.claimDigestSha256,
      stateVersion: expiryEvent.stateVersion,
      fromStatus: expiryEvent.fromStatus,
      toStatus: expiryEvent.toStatus,
      evidenceSha256: expiryEvent.evidenceSha256,
      failureClass: expiryEvent.failureClass,
    }),
  );
}

export function verifyRingTransitionOperationReceiptChain(
  canonicalByteArrays,
) {
  if (!Array.isArray(canonicalByteArrays)) {
    throw new TypeError(
      "[operation chain] expected an array of canonical byte arrays",
    );
  }
  if (
    canonicalByteArrays.length < 1 ||
    canonicalByteArrays.length >
      MAX_RING_TRANSITION_OPERATION_RECEIPTS_PER_CHAIN
  ) {
    throw new Error("[operation chain] receipt count must be between 1 and 2");
  }

  const receipts = canonicalByteArrays.map((value, index) =>
    parseCanonicalOperationReceipt(value, index + 1),
  );
  const start = receipts[0];
  if (
    start.record.sequence !== 1 ||
    start.record.predecessorReceiptSha256 !== null ||
    start.record.event.kind !== "request_started"
  ) {
    throw new Error("[operation chain] invalid request-start receipt");
  }

  const sharedContext = canonicalReceiptJson(start.record.context);
  const sharedOperation = canonicalReceiptJson(start.record.operation);
  let previous = null;
  for (let index = 0; index < receipts.length; index += 1) {
    const receipt = receipts[index];
    const expectedSequence = index + 1;
    if (receipt.record.sequence !== expectedSequence) {
      throw new Error(
        `[operation chain] sequence gap at ${expectedSequence}: received ${receipt.record.sequence}`,
      );
    }
    if (
      receipt.record.predecessorReceiptSha256 !==
      (previous?.sha256 ?? null)
    ) {
      throw new Error(
        `[operation chain] predecessor SHA-256 mismatch at sequence ${expectedSequence}`,
      );
    }
    if (
      canonicalReceiptJson(receipt.record.context) !== sharedContext ||
      canonicalReceiptJson(receipt.record.operation) !== sharedOperation
    ) {
      throw new Error(
        `[operation chain] shared context or operation identity drift at sequence ${expectedSequence}`,
      );
    }
    if (
      previous !== null &&
      receipt.record.recordedAt < previous.record.recordedAt
    ) {
      throw new Error(
        `[operation chain] recordedAt is not monotonic at sequence ${expectedSequence}`,
      );
    }
    if (
      (expectedSequence === 1 &&
        receipt.record.event.kind !== "request_started") ||
      (expectedSequence === 2 &&
        receipt.record.event.kind !== "request_finished")
    ) {
      throw new Error(
        `[operation chain] event kind is invalid at sequence ${expectedSequence}`,
      );
    }
    previous = receipt;
  }

  return Object.freeze({
    ok: true,
    verificationScope: "single_operation_chain",
    aggregateCapacityVerified: false,
    absoluteHttpsTargetVerified: false,
    operationIdSha256: start.record.operation.operationIdSha256,
    receiptCount: receipts.length,
    headSha256: previous.sha256,
    outcome:
      receipts.length === 2 ? receipts[1].record.event.outcome : null,
  });
}

export function verifyRingTransitionExecutionReceiptChain(canonicalByteArrays) {
  const verified = verifyRingTransitionExecutionReceiptSequence(
    canonicalByteArrays,
  );
  if (!verified.sealed) {
    throw new Error("[chain] terminal seal is missing");
  }
  return verified;
}

export function verifyRingTransitionExecutionReceiptPrefix(
  canonicalByteArrays,
) {
  return verifyRingTransitionExecutionReceiptSequence(canonicalByteArrays);
}

function verifyRingTransitionExecutionReceiptSequence(canonicalByteArrays) {
  if (!Array.isArray(canonicalByteArrays)) {
    throw new TypeError("[chain] expected an array of canonical byte arrays");
  }
  if (
    canonicalByteArrays.length < 1 ||
    canonicalByteArrays.length > MAX_RING_TRANSITION_RECEIPTS_PER_CHAIN
  ) {
    throw new Error("[chain] receipt count must be between 1 and 128");
  }

  const receipts = canonicalByteArrays.map((value, index) =>
    parseCanonicalReceipt(value, index + 1),
  );
  const genesis = receipts[0].record;
  if (
    genesis.sequence !== 1 ||
    genesis.predecessorReceiptSha256 !== null ||
    genesis.event.kind !== "claim_observed" ||
    genesis.event.status !== "claimed" ||
    genesis.event.stateVersion !== 0
  ) {
    throw new Error("[chain] invalid genesis receipt");
  }

  const sharedRelease = canonicalReceiptJson(genesis.release);
  const sharedCredentials = canonicalReceiptJson(genesis.credentialIdentity);
  const sharedClaim = canonicalReceiptJson(genesis.claim);
  let previous = null;
  let sealed = false;
  let status = "claimed";
  let stateVersion = 0;

  for (let index = 0; index < receipts.length; index += 1) {
    const receipt = receipts[index];
    const expectedSequence = index + 1;
    if (sealed) {
      throw new Error("[chain] receipt found after terminal seal");
    }
    if (receipt.record.sequence !== expectedSequence) {
      throw new Error(
        `[chain] sequence gap at ${expectedSequence}: received ${receipt.record.sequence}`,
      );
    }

    const expectedPredecessor = previous?.sha256 ?? null;
    if (
      receipt.record.predecessorReceiptSha256 !== expectedPredecessor
    ) {
      throw new Error(
        `[chain] predecessor SHA-256 mismatch at sequence ${expectedSequence}`,
      );
    }
    if (
      canonicalReceiptJson(receipt.record.release) !== sharedRelease ||
      canonicalReceiptJson(receipt.record.credentialIdentity) !==
        sharedCredentials ||
      canonicalReceiptJson(receipt.record.claim) !== sharedClaim
    ) {
      throw new Error(
        `[chain] shared release, credential, or claim identity drift at sequence ${expectedSequence}`,
      );
    }
    if (
      previous !== null &&
      receipt.record.recordedAt < previous.record.recordedAt
    ) {
      throw new Error(
        `[chain] recordedAt is not monotonic at sequence ${expectedSequence}`,
      );
    }

    if (
      receipt.record.event.kind === "terminal_seal" &&
      index !== receipts.length - 1
    ) {
      throw new Error("[chain] terminal seal must be the final receipt");
    }
    ({ status, stateVersion } = validateEventProgress({
      event: receipt.record.event,
      index,
      receiptCount: receipts.length,
      status,
      stateVersion,
    }));
    sealed = receipt.record.event.kind === "terminal_seal";
    if (sealed) {
      if (index !== receipts.length - 1) {
        throw new Error("[chain] terminal seal must be the final receipt");
      }
      if (
        receipt.record.event.chainLength !== canonicalByteArrays.length
      ) {
        throw new Error("[chain] terminal seal chainLength mismatch");
      }
      if (
        receipt.record.event.terminalAt !== receipt.record.recordedAt
      ) {
        throw new Error("[chain] terminal seal time mismatch");
      }
    }
    previous = receipt;
  }

  if (TERMINAL_CLAIM_STATUSES.has(status) && !sealed) {
    throw new Error("[chain] terminal seal is missing");
  }

  return Object.freeze({
    ok: true,
    authorizationIdSha256: genesis.claim.authorizationIdSha256,
    receiptCount: receipts.length,
    headSha256: previous.sha256,
    sealed,
  });
}

function parseCanonicalOperationReceipt(value, sequence) {
  const bytes = requireByteArray(
    value,
    `[operation receipt ${sequence}] bytes`,
  );
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_RING_TRANSITION_RECEIPT_BYTES
  ) {
    throw new Error(
      `[operation receipt ${sequence}] byte length must be between 1 and 65536`,
    );
  }

  let json;
  try {
    json = textDecoder.decode(bytes);
  } catch {
    throw new Error(
      `[operation receipt ${sequence}] JSON is not valid UTF-8`,
    );
  }
  rejectDuplicateJsonFields(json, `[operation receipt ${sequence}]`);

  let record;
  try {
    record = JSON.parse(json);
  } catch {
    throw new Error(`[operation receipt ${sequence}] JSON is invalid`);
  }
  rejectForbiddenFields(record, `[operation receipt ${sequence}]`);
  validateOperationReceipt(record, `[operation receipt ${sequence}]`);

  const canonicalBytes = canonicalReceiptBytes(record);
  if (!equalBytes(bytes, canonicalBytes)) {
    throw new Error(
      `[operation receipt ${sequence}] JSON is not canonical`,
    );
  }
  return {
    record,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function validateOperationReceipt(record, label) {
  const receipt = requireObject(record, label);
  exactKeys(receipt, OPERATION_RECEIPT_KEYS, label);
  requireExact(receipt.schemaVersion, 1, `${label} schemaVersion`);
  requireExact(
    receipt.contract,
    RING_TRANSITION_OPERATION_RECEIPT_CONTRACT,
    `${label} contract`,
  );
  requireExact(receipt.environment, "staging", `${label} environment`);
  requireInteger(receipt.sequence, 1, 2, `${label} sequence`);
  requireInteger(receipt.recordedAt, 0, MAX_SAFE_INTEGER, `${label} recordedAt`);
  if (receipt.sequence === 1) {
    requireExact(
      receipt.predecessorReceiptSha256,
      null,
      `${label} predecessorReceiptSha256`,
    );
  } else {
    requireSha256(
      receipt.predecessorReceiptSha256,
      `${label} predecessorReceiptSha256`,
    );
  }

  validateOperationContext(receipt.context, `${label} context`);
  validateOperationIdentity(
    receipt.operation,
    receipt.context,
    `${label} operation`,
  );
  validateOperationEvent(
    receipt.event,
    receipt.operation.kind,
    `${label} event`,
  );
  if (receipt.recordedAt < receipt.context.generatedAt) {
    throw new Error(`${label} time binding is invalid`);
  }
  if (
    receipt.event.kind === "request_started" &&
    (receipt.sequence !== 1 ||
      (receipt.recordedAt >= receipt.context.expiresAt &&
        (!RECOVERY_OPERATION_KINDS.has(receipt.operation.kind) ||
          receipt.recordedAt - receipt.context.expiresAt >
            MAX_RING_TRANSITION_READ_RECOVERY_SECONDS)))
  ) {
    throw new Error(`${label} request-start binding is invalid`);
  }
  if (
    receipt.event.kind === "request_started" &&
    READ_OPERATION_KINDS.has(receipt.operation.kind) &&
    receipt.operation.requestSha256 !==
      computeRingTransitionReadOperationRequestSha256({
        targetSha256: receipt.operation.targetSha256,
        requestIdSha256: receipt.event.request_id_sha256,
      })
  ) {
    throw new Error(`${label} read request SHA-256 mismatch`);
  }
  if (
    receipt.event.kind === "request_finished" &&
    receipt.sequence !== 2
  ) {
    throw new Error(`${label} request-finish binding is invalid`);
  }
}

function validateOperationContext(value, label) {
  const context = requireObject(value, label);
  exactKeys(context, OPERATION_CONTEXT_KEYS, label);
  requireLowerHex(context.sourceCommit, 40, `${label} sourceCommit`);
  requireLowerHex(context.gitTreeSha, 40, `${label} gitTreeSha`);
  for (const field of [
    "releaseManifestSha256",
    "releasePacketSha256",
    "releasePolicySha256",
    "artifactSha256",
    "moduleInventorySha256",
    "publicationManifestSha256",
    "publicationPacketSha256",
    "generationSha256",
    "activationSha256",
    "authorizationIdSha256",
    "claimDigestSha256",
    "ledgerIdentitySha256",
    "claimOwnerSha256",
    "accountIdSha256",
    "readCredentialIdSha256",
    "claimCredentialIdSha256",
    "deployCredentialIdSha256",
    "accessClientIdSha256",
    "permitSpkiSha256",
    "trustConfigSha256",
  ]) {
    requireSha256(context[field], `${label} ${field}`);
  }
  requireInteger(context.moduleCount, 1, MAX_SAFE_INTEGER, `${label} moduleCount`);
  requireInteger(
    context.activationSequence,
    1,
    MAX_SAFE_INTEGER,
    `${label} activationSequence`,
  );
  requireToken(
    context.authorityVersionId,
    1,
    128,
    `${label} authorityVersionId`,
  );
  requireServiceName(
    context.controllerServiceName,
    `${label} controllerServiceName`,
  );
  requireServiceName(
    context.edgeServiceName,
    `${label} edgeServiceName`,
  );
  requireInteger(context.generatedAt, 0, MAX_SAFE_INTEGER, `${label} generatedAt`);
  requireInteger(context.expiresAt, 0, MAX_SAFE_INTEGER, `${label} expiresAt`);
  if (context.generatedAt >= context.expiresAt) {
    throw new Error(`${label} time range is invalid`);
  }
}

function validateOperationIdentity(value, context, label) {
  const operation = requireObject(value, label);
  exactKeys(operation, OPERATION_IDENTITY_KEYS, label);
  requireSha256(operation.operationIdSha256, `${label} operationIdSha256`);
  validateOperationShape(operation, label);
  const expectedId = computeRingTransitionOperationId({
    context,
    kind: operation.kind,
    stateVersion: operation.stateVersion,
    method: operation.method,
    targetSha256: operation.targetSha256,
    requestSha256: operation.requestSha256,
  });
  if (operation.operationIdSha256 !== expectedId) {
    throw new Error(`${label} operation ID mismatch`);
  }
}

function validateOperationShape(value, label) {
  requireEnum(value.kind, OPERATION_KINDS, `${label} kind`);
  requireInteger(value.stateVersion, 0, 255, `${label} stateVersion`);
  requireExact(
    value.method,
    READ_OPERATION_KINDS.has(value.kind) ? "GET" : "POST",
    `${label} method`,
  );
  requireSha256(value.targetSha256, `${label} targetSha256`);
  requireSha256(value.requestSha256, `${label} requestSha256`);
  if (
    ([
      "authority_claim_create",
      "authority_claim_read",
      "authority_preflight_read",
      "cloudflare_deploy_token_verify_read",
      "cloudflare_token_verify_read",
    ].includes(value.kind) &&
      value.stateVersion !== 0) ||
    (value.kind === "authority_step_append" &&
      value.stateVersion === 0) ||
    (value.kind === "cloudflare_deployment" &&
      value.stateVersion !== 2 &&
      value.stateVersion !== 5) ||
    ([
      "cloudflare_deployment_read",
      "cloudflare_version_read",
    ].includes(value.kind) &&
      ![1, 3, 4, 6].includes(value.stateVersion))
  ) {
    throw new Error(`${label} stateVersion is invalid for operation kind`);
  }
}

function validateOperationEvent(value, operationKind, label) {
  const event = requireObject(value, label);
  requireString(event.kind, `${label} kind`);
  switch (event.kind) {
    case "request_started":
      exactKeys(event, ["kind", "request_id_sha256"], label);
      requireSha256(event.request_id_sha256, `${label} request_id_sha256`);
      return;
    case "request_finished":
      exactKeys(
        event,
        [
          "kind",
          "outcome",
          "http_status",
          "response_body_sha256",
          "response_id_sha256",
        ],
        label,
      );
      requireEnum(event.outcome, OPERATION_OUTCOMES, `${label} outcome`);
      requireOptionalInteger(
        event.http_status,
        100,
        599,
        `${label} http_status`,
      );
      requireOptionalSha256(
        event.response_body_sha256,
        `${label} response_body_sha256`,
      );
      requireOptionalSha256(
        event.response_id_sha256,
        `${label} response_id_sha256`,
      );
      if (
        event.outcome === "accepted" &&
        !operationAcceptedStatusMatches(operationKind, event.http_status)
      ) {
        throw new Error(
          `${label} accepted outcome has an invalid status for operation kind`,
        );
      }
      if (
        event.outcome === "rejected" &&
        !operationRejectedStatusMatches(operationKind, event.http_status)
      ) {
        throw new Error(
          `${label} rejected outcome has an invalid status for operation kind`,
        );
      }
      return;
    default:
      throw new Error(`${label} kind is invalid`);
  }
}

function operationAcceptedStatusMatches(operationKind, status) {
  if (!Number.isInteger(status)) {
    return false;
  }
  if (READ_OPERATION_KINDS.has(operationKind)) {
    return status === 200;
  }
  if (
    operationKind === "authority_claim_create" ||
    operationKind === "authority_step_append"
  ) {
    return status === 200 || status === 201;
  }
  return operationKind === "cloudflare_deployment" &&
    status >= 200 &&
    status <= 299;
}

function operationRejectedStatusMatches(operationKind, status) {
  if (
    !Number.isInteger(status) ||
    status < 400 ||
    status > 499 ||
    status === 408 ||
    status === 425 ||
    status === 429
  ) {
    return false;
  }
  return !(
    (operationKind === "authority_claim_create" ||
      operationKind === "authority_step_append") &&
    status === 409
  );
}

function parseCanonicalReceipt(value, sequence) {
  const bytes = requireByteArray(value, `[receipt ${sequence}] bytes`);
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_RING_TRANSITION_RECEIPT_BYTES
  ) {
    throw new Error(
      `[receipt ${sequence}] byte length must be between 1 and 65536`,
    );
  }

  let json;
  try {
    json = textDecoder.decode(bytes);
  } catch {
    throw new Error(`[receipt ${sequence}] JSON is not valid UTF-8`);
  }
  rejectDuplicateJsonFields(json, `[receipt ${sequence}]`);

  let record;
  try {
    record = JSON.parse(json);
  } catch {
    throw new Error(`[receipt ${sequence}] JSON is invalid`);
  }
  rejectForbiddenFields(record, `[receipt ${sequence}]`);
  validateReceipt(record, `[receipt ${sequence}]`);

  const canonicalBytes = canonicalReceiptBytes(record);
  if (!equalBytes(bytes, canonicalBytes)) {
    throw new Error(`[receipt ${sequence}] JSON is not canonical`);
  }
  return {
    record,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function validateReceipt(record, label) {
  const receipt = requireObject(record, label);
  exactKeys(receipt, RECEIPT_KEYS, label);
  requireExact(receipt.schemaVersion, 1, `${label} schemaVersion`);
  requireExact(
    receipt.contract,
    RING_TRANSITION_EXECUTION_RECEIPT_CONTRACT,
    `${label} contract`,
  );
  requireExact(receipt.environment, "staging", `${label} environment`);
  requireInteger(receipt.sequence, 1, 128, `${label} sequence`);
  requireInteger(receipt.recordedAt, 0, MAX_SAFE_INTEGER, `${label} recordedAt`);
  if (receipt.sequence === 1) {
    requireExact(
      receipt.predecessorReceiptSha256,
      null,
      `${label} predecessorReceiptSha256`,
    );
  } else {
    requireSha256(
      receipt.predecessorReceiptSha256,
      `${label} predecessorReceiptSha256`,
    );
  }

  validateRelease(receipt.release, `${label} release`);
  validateCredentialIdentity(
    receipt.credentialIdentity,
    `${label} credentialIdentity`,
  );
  validateClaim(receipt.claim, `${label} claim`);
  validateEvent(receipt.event, `${label} event`);
  if (
    receipt.claim.accountIdSha256 !==
      receipt.credentialIdentity.accountIdSha256 ||
    receipt.release.artifactSha256 !==
      receipt.credentialIdentity.runnerBuildSha256 ||
    receipt.release.moduleCount === 0 ||
    receipt.release.activationSequence === 0 ||
    receipt.credentialIdentity.stableReadbackObservationSeconds < 5 ||
    receipt.credentialIdentity.stableReadbackObservationSeconds > 120
  ) {
    throw new Error(`${label} identity binding is invalid`);
  }
  if (
    receipt.recordedAt < receipt.claim.claimedAt ||
    receipt.recordedAt > MAX_SAFE_INTEGER
  ) {
    throw new Error(`${label} time binding is invalid`);
  }
  if (
    receipt.event.kind === "claim_observed" &&
    (receipt.sequence !== 1 ||
      receipt.recordedAt !== receipt.claim.claimedAt)
  ) {
    throw new Error(`${label} claim_observed binding is invalid`);
  }
  if (
    receipt.event.kind === "terminal_seal" &&
    receipt.event.terminalAt !== receipt.recordedAt
  ) {
    throw new Error(`${label} terminal seal time binding is invalid`);
  }
  if (
    receipt.event.kind === "terminal_seal" &&
    receipt.event.chainLength !== receipt.sequence
  ) {
    throw new Error(`${label} terminal seal chainLength mismatch`);
  }
  validateHistoryBinding(receipt, label);
  return receipt;
}

function validateRelease(value, label) {
  const release = requireObject(value, label);
  exactKeys(release, RELEASE_KEYS, label);
  for (const field of [
    "publishedAt",
    "expiresAt",
  ]) {
    requireString(release[field], `${label} ${field}`);
  }
  requireLowerHex(release.sourceCommit, 40, `${label} sourceCommit`);
  requireLowerHex(release.gitTreeSha, 40, `${label} gitTreeSha`);
  for (const field of [
    "releaseManifestSha256",
    "releasePacketSha256",
    "releasePolicySha256",
    "artifactSha256",
    "moduleInventorySha256",
    "publicationManifestSha256",
    "publicationPacketSha256",
    "generationSha256",
  ]) {
    requireSha256(release[field], `${label} ${field}`);
  }
  requireInteger(release.moduleCount, 0, MAX_SAFE_INTEGER, `${label} moduleCount`);
  requireInteger(
    release.activationSequence,
    0,
    MAX_SAFE_INTEGER,
    `${label} activationSequence`,
  );
  requireOptionalSha256(
    release.previousPublicationManifestSha256,
    `${label} previousPublicationManifestSha256`,
  );
  const publishedAt = parseWholeSecondTimestamp(
    release.publishedAt,
    `${label} publishedAt`,
  );
  const expiresAt = parseWholeSecondTimestamp(
    release.expiresAt,
    `${label} expiresAt`,
  );
  if (publishedAt >= expiresAt) {
    throw new Error(`${label} release time range is invalid`);
  }
}

function validateCredentialIdentity(value, label) {
  const identity = requireObject(value, label);
  exactKeys(identity, CREDENTIAL_IDENTITY_KEYS, label);
  for (const field of [
    "accountIdSha256",
    "readCredentialIdSha256",
    "claimCredentialIdSha256",
    "deployCredentialIdSha256",
    "accessClientIdSha256",
    "permitSpkiSha256",
    "trustConfigSha256",
    "runnerBuildSha256",
  ]) {
    requireSha256(identity[field], `${label} ${field}`);
  }
  for (const field of [
    "controllerServiceName",
    "edgeServiceName",
  ]) {
    requireString(identity[field], `${label} ${field}`);
  }
  requireToken(
    identity.authorityVersionId,
    1,
    128,
    `${label} authorityVersionId`,
  );
  requireServiceName(
    identity.controllerServiceName,
    `${label} controllerServiceName`,
  );
  requireServiceName(
    identity.edgeServiceName,
    `${label} edgeServiceName`,
  );
  requireInteger(
    identity.stableReadbackObservationSeconds,
    0,
    65_535,
    `${label} stableReadbackObservationSeconds`,
  );
}

function validateClaim(value, label) {
  const claim = requireObject(value, label);
  exactKeys(claim, CLAIM_KEYS, label);
  for (const field of [
    "authorizationIdSha256",
    "claimDigestSha256",
    "ledgerIdentitySha256",
    "claimOwnerSha256",
    "accountIdSha256",
  ]) {
    requireSha256(claim[field], `${label} ${field}`);
  }
  for (const field of ["generatedAt", "claimedAt", "expiresAt"]) {
    requireInteger(claim[field], 0, MAX_SAFE_INTEGER, `${label} ${field}`);
  }
  if (
    claim.generatedAt > claim.claimedAt ||
    claim.claimedAt > claim.expiresAt
  ) {
    throw new Error(`${label} time binding is invalid`);
  }
}

function validateEvent(value, label) {
  const event = requireObject(value, label);
  requireString(event.kind, `${label} kind`);
  switch (event.kind) {
    case "claim_observed":
      exactKeys(event, ["kind", "status", "stateVersion"], label);
      requireExact(event.status, "claimed", `${label} status`);
      requireInteger(event.stateVersion, 0, 255, `${label} stateVersion`);
      requireExact(event.stateVersion, 0, `${label} stateVersion`);
      return;
    case "authority_step":
      exactKeys(event, ["kind", "step"], label);
      validateStep(event.step, `${label} step`);
      return;
    case "authority_expiry":
      exactKeys(event, ["kind", "expiry"], label);
      validateExpiry(event.expiry, `${label} expiry`);
      return;
    case "terminal_seal":
      exactKeys(
        event,
        [
          "kind",
          "status",
          "stateVersion",
          "terminalAt",
          "finalSnapshotSha256",
          "finalSnapshotBytes",
          "historySha256",
          "chainLength",
        ],
        label,
      );
      requireEnum(event.status, TERMINAL_CLAIM_STATUSES, `${label} status`);
      requireInteger(event.stateVersion, 0, 255, `${label} stateVersion`);
      requireInteger(event.terminalAt, 0, MAX_SAFE_INTEGER, `${label} terminalAt`);
      requireSha256(event.finalSnapshotSha256, `${label} finalSnapshotSha256`);
      requireInteger(
        event.finalSnapshotBytes,
        1,
        256 * 1024,
        `${label} finalSnapshotBytes`,
      );
      requireSha256(event.historySha256, `${label} historySha256`);
      requireInteger(event.chainLength, 1, 128, `${label} chainLength`);
      return;
    default:
      throw new Error(`${label} kind is invalid`);
  }
}

function validateStep(value, label) {
  const step = requireObject(value, label);
  exactKeys(step, STEP_KEYS, label);
  requireInteger(step.stateVersion, 0, 255, `${label} stateVersion`);
  if (step.stateVersion === 0) {
    throw new Error(`${label} stateVersion must be positive`);
  }
  requireEnum(step.stepCode, STEP_CODES, `${label} stepCode`);
  requireEnum(step.fromStatus, CLAIM_STATUSES, `${label} fromStatus`);
  requireEnum(step.toStatus, CLAIM_STATUSES, `${label} toStatus`);
  requireSha256(
    step.actorExecutionIdSha256,
    `${label} actorExecutionIdSha256`,
  );
  for (const field of [
    "mutationRequestSha256",
    "cloudflareRequestIdSha256",
    "deploymentSetSha256",
  ]) {
    requireOptionalSha256(step[field], `${label} ${field}`);
  }
  requireSha256(step.evidenceSha256, `${label} evidenceSha256`);
  requireEnum(step.failureClass, FAILURE_CLASSES, `${label} failureClass`);
  requireEnum(
    step.transportOutcome,
    TRANSPORT_OUTCOMES,
    `${label} transportOutcome`,
  );
  requireSha256(step.stepDigestSha256, `${label} stepDigestSha256`);
}

function validateExpiry(value, label) {
  const expiry = requireObject(value, label);
  exactKeys(expiry, EXPIRY_KEYS, label);
  requireInteger(expiry.stateVersion, 0, 255, `${label} stateVersion`);
  if (expiry.stateVersion === 0) {
    throw new Error(`${label} stateVersion must be positive`);
  }
  requireEnum(expiry.fromStatus, CLAIM_STATUSES, `${label} fromStatus`);
  requireEnum(expiry.toStatus, CLAIM_STATUSES, `${label} toStatus`);
  requireSha256(
    expiry.authorityActorIdSha256,
    `${label} authorityActorIdSha256`,
  );
  requireSha256(expiry.evidenceSha256, `${label} evidenceSha256`);
  requireSha256(
    expiry.expiryEventDigestSha256,
    `${label} expiryEventDigestSha256`,
  );
  requireExact(
    expiry.failureClass,
    "authorization_expired",
    `${label} failureClass`,
  );
}

function validateHistoryBinding(receipt, label) {
  if (receipt.event.kind === "authority_step") {
    const step = receipt.event.step;
    if (
      step.actorExecutionIdSha256 !== receipt.claim.claimOwnerSha256
    ) {
      throw new Error(`${label} authority step actor does not own the claim`);
    }
    if (
      receipt.recordedAt >= receipt.claim.expiresAt &&
      step.fromStatus !== "controller_inflight" &&
      step.fromStatus !== "edge_inflight"
    ) {
      throw new Error(
        `${label} non-inflight authority step was recorded after expiry`,
      );
    }
    if (!validStepShape(step)) {
      throw new Error(`${label} authority step shape is invalid`);
    }
    const expected = computeRingTransitionStepDigest({
      claim: receipt.claim,
      step,
    });
    if (step.stepDigestSha256 !== expected) {
      throw new Error(`${label} authority step digest mismatch`);
    }
  }

  if (receipt.event.kind === "authority_expiry") {
    const expiry = receipt.event.expiry;
    if (
      expiry.authorityActorIdSha256 === receipt.claim.claimOwnerSha256
    ) {
      throw new Error(`${label} authority expiry actor must be independent`);
    }
    if (receipt.recordedAt < receipt.claim.expiresAt) {
      throw new Error(`${label} authority expiry was recorded before expiry`);
    }
    if (!validExpiryShape(expiry)) {
      throw new Error(`${label} authority expiry shape is invalid`);
    }
    const expected = computeRingTransitionExpiryDigest({
      claim: receipt.claim,
      expiry,
    });
    if (expiry.expiryEventDigestSha256 !== expected) {
      throw new Error(`${label} authority expiry digest mismatch`);
    }
  }
}

function validStepShape(step) {
  const readOnly =
    step.mutationRequestSha256 === null &&
    step.cloudflareRequestIdSha256 === null &&
    step.transportOutcome === "not_applicable";
  switch (step.stepCode) {
    case "t1_readback":
      return (
        step.stateVersion === 1 &&
        step.fromStatus === "claimed" &&
        (step.toStatus === "t1_verified" ||
          step.toStatus === "aborted") &&
        readOnly &&
        step.deploymentSetSha256 !== null &&
        ((step.toStatus === "t1_verified" &&
          step.failureClass === "") ||
          (step.toStatus === "aborted" &&
            step.failureClass === "readback_drift"))
      );
    case "controller_mutation_intent":
      return (
        step.stateVersion === 2 &&
        step.fromStatus === "t1_verified" &&
        step.toStatus === "controller_inflight" &&
        step.mutationRequestSha256 !== null &&
        step.cloudflareRequestIdSha256 === null &&
        step.deploymentSetSha256 === null &&
        step.failureClass === "" &&
        step.transportOutcome === "not_applicable"
      );
    case "controller_post_readback":
      return (
        step.stateVersion === 3 &&
        step.fromStatus === "controller_inflight" &&
        (step.toStatus === "controller_verified" ||
          step.toStatus === "recovery_required") &&
        validPostReadback(step)
      );
    case "edge_pre_readback":
      return (
        step.stateVersion === 4 &&
        step.fromStatus === "controller_verified" &&
        (step.toStatus === "edge_prechecked" ||
          step.toStatus === "recovery_required") &&
        readOnly &&
        step.deploymentSetSha256 !== null &&
        ((step.toStatus === "edge_prechecked" &&
          step.failureClass === "") ||
          (step.toStatus === "recovery_required" &&
            step.failureClass === "readback_drift"))
      );
    case "edge_mutation_intent":
      return (
        step.stateVersion === 5 &&
        step.fromStatus === "edge_prechecked" &&
        step.toStatus === "edge_inflight" &&
        step.mutationRequestSha256 !== null &&
        step.cloudflareRequestIdSha256 === null &&
        step.deploymentSetSha256 === null &&
        step.failureClass === "" &&
        step.transportOutcome === "not_applicable"
      );
    case "edge_post_readback":
      return (
        step.stateVersion === 6 &&
        step.fromStatus === "edge_inflight" &&
        (step.toStatus === "completed" ||
          step.toStatus === "recovery_required") &&
        validPostReadback(step)
      );
    case "terminal":
      return (
        readOnly &&
        step.deploymentSetSha256 === null &&
        (((step.fromStatus === "claimed" ||
          step.fromStatus === "t1_verified") &&
          step.toStatus === "aborted" &&
          step.failureClass === "operator_abort") ||
          (step.fromStatus === "edge_prechecked" &&
            step.toStatus === "recovery_required" &&
            step.failureClass === "operator_abort"))
      );
    default:
      return false;
  }
}

function validPostReadback(step) {
  if (
    step.mutationRequestSha256 === null ||
    step.deploymentSetSha256 === null
  ) {
    return false;
  }
  return (
    ((step.toStatus === "controller_verified" ||
      step.toStatus === "completed") &&
      (step.transportOutcome === "success" ||
        step.transportOutcome === "ambiguous") &&
      step.failureClass === "") ||
    (step.toStatus === "recovery_required" &&
      step.transportOutcome === "rejected" &&
      step.failureClass === "http_rejected") ||
    (step.toStatus === "recovery_required" &&
      (step.transportOutcome === "success" ||
        step.transportOutcome === "ambiguous") &&
      (step.failureClass === "transport_response_lost" ||
        step.failureClass === "readback_drift" ||
        step.failureClass === "target_not_stable"))
  );
}

function validExpiryShape(expiry) {
  return (
    expiry.failureClass === "authorization_expired" &&
    (((expiry.fromStatus === "claimed" ||
      expiry.fromStatus === "t1_verified") &&
      expiry.toStatus === "expired") ||
      ((expiry.fromStatus === "controller_verified" ||
        expiry.fromStatus === "edge_prechecked") &&
        expiry.toStatus === "recovery_required"))
  );
}

function validateEventProgress({
  event,
  index,
  receiptCount,
  status,
  stateVersion,
}) {
  switch (event.kind) {
    case "claim_observed":
      if (index !== 0) {
        throw new Error("[chain] claim_observed may only be the genesis");
      }
      return { status, stateVersion };
    case "authority_step":
      if (
        event.step.stateVersion !== stateVersion + 1 ||
        event.step.fromStatus !== status
      ) {
        throw new Error("[chain] authority step state progression is invalid");
      }
      return {
        status: event.step.toStatus,
        stateVersion: event.step.stateVersion,
      };
    case "authority_expiry":
      if (
        event.expiry.stateVersion !== stateVersion + 1 ||
        event.expiry.fromStatus !== status
      ) {
        throw new Error("[chain] authority expiry state progression is invalid");
      }
      return {
        status: event.expiry.toStatus,
        stateVersion: event.expiry.stateVersion,
      };
    case "terminal_seal":
      if (
        index + 1 !== receiptCount ||
        event.status !== status ||
        event.stateVersion !== stateVersion ||
        event.chainLength !== receiptCount
      ) {
        throw new Error("[chain] terminal seal state progression is invalid");
      }
      return { status, stateVersion };
    default:
      throw new Error("[chain] event kind is invalid");
  }
}

function rejectForbiddenFields(value, label) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      rejectForbiddenFields(entry, `${label}[${index}]`),
    );
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    const normalized = key.replaceAll(/[-_]/g, "").toLowerCase();
    if (FORBIDDEN_FIELD_NAMES.has(normalized)) {
      throw new Error(`${label} contains forbidden secret-like field ${key}`);
    }
    rejectForbiddenFields(entry, `${label}.${key}`);
  }
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value);
  const allowed = new Set(expected);
  const unknown = actual.find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    throw new Error(`${label} contains unknown field ${unknown}`);
  }
  const missing = expected.find(
    (key) => !Object.prototype.hasOwnProperty.call(value, key),
  );
  if (missing !== undefined || actual.length !== expected.length) {
    throw new Error(`${label} is missing field ${missing ?? "unknown"}`);
  }
}

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  requireUnicodeScalarString(value, label);
  return value;
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function requireLowerHex(value, length, label) {
  const pattern = new RegExp(`^[0-9a-f]{${length}}$`);
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${label} must be ${length} lowercase hexadecimal characters`);
  }
  return value;
}

function requireOptionalSha256(value, label) {
  if (value !== null) {
    requireSha256(value, label);
  }
}

function requireOptionalInteger(value, minimum, maximum, label) {
  if (value !== null) {
    requireInteger(value, minimum, maximum, label);
  }
}

function requireInteger(value, minimum, maximum, label) {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function requireEnum(value, allowed, label) {
  requireString(value, label);
  if (!allowed.has(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requireExact(value, expected, label) {
  if (value !== expected) {
    throw new Error(`${label} must equal ${JSON.stringify(expected)}`);
  }
  return value;
}

function requireToken(value, minimum, maximum, label) {
  requireString(value, label);
  if (
    value.length < minimum ||
    value.length > maximum ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  ) {
    throw new Error(`${label} is not a valid token`);
  }
  return value;
}

function requireServiceName(value, label) {
  requireString(value, label);
  if (value.length > 63 || !/^[a-z0-9][a-z0-9_-]*$/.test(value)) {
    throw new Error(`${label} is not a valid service name`);
  }
  return value;
}

function parseWholeSecondTimestamp(value, label) {
  requireString(value, label);
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.000Z$/.test(value)) {
    throw new Error(`${label} is not a whole-second timestamp`);
  }
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value ||
    milliseconds < 0
  ) {
    throw new Error(`${label} is not a valid timestamp`);
  }
  return milliseconds / 1_000;
}

function requireByteArray(value, label) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (
    Array.isArray(value) &&
    value.every(
      (byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255,
    )
  ) {
    return Uint8Array.from(value);
  }
  throw new TypeError(`${label} must be a byte array`);
}

function writeCanonical(value) {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error("[canonical] numbers must be safe integers");
    }
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (typeof value === "string") {
    requireUnicodeScalarString(value, "[canonical] string");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => writeCanonical(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).sort(compareUtf8);
    return `{${keys
      .map((key) => {
        requireUnicodeScalarString(key, "[canonical] key");
        return `${JSON.stringify(key)}:${writeCanonical(value[key])}`;
      })
      .join(",")}}`;
  }
  throw new Error("[canonical] value is not JSON serializable");
}

function compareUtf8(left, right) {
  const leftBytes = textEncoder.encode(left);
  const rightBytes = textEncoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) {
      return leftBytes[index] - rightBytes[index];
    }
  }
  return leftBytes.length - rightBytes.length;
}

function requireUnicodeScalarString(value, label) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) {
        throw new Error(`${label} contains an unpaired surrogate`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error(`${label} contains an unpaired surrogate`);
    }
  }
}

function equalBytes(left, right) {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function rejectDuplicateJsonFields(json, label) {
  let index = 0;

  function fail() {
    throw new Error(`${label} JSON is invalid or contains duplicate fields`);
  }

  function skipWhitespace() {
    while (
      index < json.length &&
      (json[index] === " " ||
        json[index] === "\n" ||
        json[index] === "\r" ||
        json[index] === "\t")
    ) {
      index += 1;
    }
  }

  function scanString() {
    if (json[index] !== '"') {
      fail();
    }
    const start = index;
    index += 1;
    while (index < json.length) {
      const code = json.charCodeAt(index);
      if (code === 0x22) {
        index += 1;
        const token = json.slice(start, index);
        try {
          return JSON.parse(token);
        } catch {
          fail();
        }
      }
      if (code < 0x20) {
        fail();
      }
      if (code === 0x5c) {
        index += 1;
        if (index >= json.length) {
          fail();
        }
        if (json[index] === "u") {
          const escape = json.slice(index + 1, index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(escape)) {
            fail();
          }
          index += 5;
          continue;
        }
        if (!'"\\/bfnrt'.includes(json[index])) {
          fail();
        }
      }
      index += 1;
    }
    fail();
  }

  function scanNumber() {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      json.slice(index),
    );
    if (match === null) {
      fail();
    }
    index += match[0].length;
  }

  function scanValue() {
    skipWhitespace();
    const token = json[index];
    if (token === "{") {
      scanObject();
      return;
    }
    if (token === "[") {
      scanArray();
      return;
    }
    if (token === '"') {
      scanString();
      return;
    }
    for (const literal of ["true", "false", "null"]) {
      if (json.startsWith(literal, index)) {
        index += literal.length;
        return;
      }
    }
    scanNumber();
  }

  function scanObject() {
    index += 1;
    skipWhitespace();
    const fields = new Set();
    if (json[index] === "}") {
      index += 1;
      return;
    }
    while (index < json.length) {
      skipWhitespace();
      const field = scanString();
      if (fields.has(field)) {
        fail();
      }
      fields.add(field);
      skipWhitespace();
      if (json[index] !== ":") {
        fail();
      }
      index += 1;
      scanValue();
      skipWhitespace();
      if (json[index] === "}") {
        index += 1;
        return;
      }
      if (json[index] !== ",") {
        fail();
      }
      index += 1;
    }
    fail();
  }

  function scanArray() {
    index += 1;
    skipWhitespace();
    if (json[index] === "]") {
      index += 1;
      return;
    }
    while (index < json.length) {
      scanValue();
      skipWhitespace();
      if (json[index] === "]") {
        index += 1;
        return;
      }
      if (json[index] !== ",") {
        fail();
      }
      index += 1;
    }
    fail();
  }

  scanValue();
  skipWhitespace();
  if (index !== json.length) {
    fail();
  }
}
