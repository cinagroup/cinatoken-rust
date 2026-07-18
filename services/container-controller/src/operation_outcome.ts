import {
  operationStorageResult,
  type ClientResponseArtifactManifest,
  type OperationRow,
  type OperationStatusSnapshot,
  type OperationStatusV4Snapshot,
  type ProviderAttemptRow,
  type ProviderResponseArtifactAttachmentRow,
  type ProviderResponseEvidenceManifest,
  type StorageResultRecord,
  type TerminalAckLedgerOutcome,
} from "./ledger";
import {
  ProtocolError,
  type OperationEnvelope,
  type TerminalAckRequestV3,
} from "./protocol";

export interface ContainerOperationOutcome {
  status: "completed" | "rejected" | "recovery_required";
  code: string | null;
  result: StorageResultRecord | null;
  classification: ProviderResponseClassification | null;
  provider_status: number | null;
  client_status: number | null;
  client_artifact: ClientResponseArtifactManifest | null;
}

export type ProviderResponseClassification = "typed_error" | "http_error" | "invalid_body";

export interface OperationOutcomePayload {
  protocol_version: 1;
  operation_id: string;
  status: OperationRow["status"];
  code?: string;
  trace_id: string;
  result?: StorageResultRecord;
}

export interface ProviderAttemptStatusPayload {
  attempt_generation: number;
  provider_operation_id: string;
  admission_sha256: string;
  request_sha256: string;
  status: ProviderAttemptRow["status"];
  response_status: number | null;
  response_code: string | null;
  result: StorageResultRecord | null;
  prepared_at: number;
  dispatched_at: number | null;
  terminal_at: number | null;
}

export interface OperationStatusPayload extends OperationOutcomePayload {
  provider_attempt: ProviderAttemptStatusPayload | null;
}

export interface ProviderAttemptStatusV3Payload extends ProviderAttemptStatusPayload {
  provider_usage_receipt_sha256: string | null;
  provider_usage_receipt_attached_at: number | null;
}

export interface OperationStatusV3Payload extends OperationOutcomePayload {
  status_contract_version: 3;
  provider_usage_receipt_sha256: string | null;
  provider_attempt: ProviderAttemptStatusV3Payload | null;
}

export interface OperationStatusV4Payload
  extends Omit<OperationStatusV3Payload, "status_contract_version"> {
  status_contract_version: 4;
  provider_response_artifacts: ProviderResponseArtifactAttachmentRow | null;
}

export interface TerminalAckV3Response {
  protocol_version: 1;
  terminal_ack_contract_version: 3;
  financial_terminal_contract_version: 2;
  billing_event_id: string;
  operation_id: string;
  reconciliation_revision: 1 | 2;
  terminal_contract_sha256: string;
  client_response_artifact_sha256: string;
  status: "acknowledged" | "duplicate";
  final_ack: true;
  acknowledged_at: number;
}

export interface SerializedOperationOutcome {
  http_status: number;
  payload: OperationOutcomePayload;
}

const IDENTIFIER = /^[A-Za-z0-9._:-]+$/;
const OPERATION_KIND = /^[a-z0-9_:-]+$/;
const RESPONSE_CODE = /^[a-z0-9_:-]+$/;

export function parseContainerOperationResponse(
  response: Response,
  body: Uint8Array,
  envelope: Pick<
    OperationEnvelope,
    "protocol_version" | "operation_id" | "operation_kind" | "owner_generation" | "trace_id"
  >,
): ContainerOperationOutcome {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw invalidContainerResponse();

  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body),
    );
  } catch {
    throw invalidContainerResponse();
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidContainerResponse();
  }

  const record = value as Record<string, unknown>;
  const allowed = [
    "protocol_version",
    "operation_id",
    "status",
    "code",
    "result",
    "classification",
    "provider_status",
    "client_status",
    "client_artifact",
    "trace_id",
  ];
  if (
    Object.keys(record).some((key) => !allowed.includes(key)) ||
    !["protocol_version", "operation_id", "status", "trace_id"].every((key) => key in record) ||
    record.protocol_version !== envelope.protocol_version ||
    record.operation_id !== envelope.operation_id ||
    record.trace_id !== envelope.trace_id ||
    !["completed", "rejected", "recovery_required"].includes(String(record.status))
  ) {
    throw invalidContainerResponse();
  }

  const status = record.status as ContainerOperationOutcome["status"];
  const code = record.code === undefined ? null : record.code;
  const hasProviderRejection =
    record.classification !== undefined ||
    record.provider_status !== undefined ||
    record.client_status !== undefined ||
    record.client_artifact !== undefined;
  if (
    (status === "completed" &&
      (!response.ok || response.status === 202 || code !== null || hasProviderRejection)) ||
    (status === "rejected" &&
      (response.ok ||
        !validResponseCode(code) ||
        record.result !== undefined ||
        (hasProviderRejection && response.status !== 422))) ||
    (status === "recovery_required" &&
      (response.status !== 202 ||
        !validResponseCode(code) ||
        record.result !== undefined ||
        hasProviderRejection))
  ) {
    throw invalidContainerResponse();
  }

  const result = record.result === undefined ? null : parseContainerResult(record.result);
  if (
    (status !== "completed" && result !== null) ||
    (status === "completed" && envelope.operation_kind === "health_probe" && result !== null) ||
    (status === "completed" && envelope.operation_kind !== "health_probe" && result === null)
  ) {
    throw invalidContainerResponse();
  }
  let classification: ProviderResponseClassification | null = null;
  let providerStatus: number | null = null;
  let clientStatus: number | null = null;
  let clientArtifact: ClientResponseArtifactManifest | null = null;
  if (hasProviderRejection) {
    classification = parseProviderResponseClassification(record.classification);
    providerStatus = parseProviderResponseStatus(record.provider_status);
    clientStatus = parseProviderResponseStatus(record.client_status);
    clientArtifact = parseClientResponseArtifactManifest(
      record.client_artifact,
      envelope.operation_id,
      envelope.owner_generation,
    );
    if (!providerRejectionStatusesMatch(classification, providerStatus, clientStatus)) {
      throw invalidContainerResponse();
    }
  }
  return {
    status,
    code: typeof code === "string" ? code : null,
    result,
    classification,
    provider_status: providerStatus,
    client_status: clientStatus,
    client_artifact: clientArtifact,
  };
}

export function serializeOperationOutcome(row: OperationRow): SerializedOperationOutcome {
  const result = operationStorageResult(row);
  validateOperationIdentity(row);

  let httpStatus: number;
  switch (row.status) {
    case "claimed":
      if (row.response_status !== null || row.response_code !== null || result !== null) {
        throw corruptOutcome();
      }
      httpStatus = 202;
      break;
    case "running":
      if (row.response_status !== null || row.response_code !== null) {
        throw corruptOutcome();
      }
      httpStatus = 202;
      break;
    case "completed":
      if (
        row.response_status === null ||
        !Number.isSafeInteger(row.response_status) ||
        row.response_status < 200 ||
        row.response_status > 299 ||
        row.response_code !== null ||
        (row.operation_kind !== "health_probe" && result === null)
      ) {
        throw corruptOutcome();
      }
      httpStatus = row.response_status;
      break;
    case "failed":
      if (
        row.response_status === null ||
        !Number.isSafeInteger(row.response_status) ||
        row.response_status < 400 ||
        row.response_status > 599 ||
        !validResponseCode(row.response_code)
      ) {
        throw corruptOutcome();
      }
      httpStatus = row.response_status;
      break;
    case "recovery_required":
      if (row.response_status !== 202 || !validResponseCode(row.response_code)) {
        throw corruptOutcome();
      }
      httpStatus = 202;
      break;
    default:
      throw corruptOutcome();
  }

  return {
    http_status: httpStatus,
    payload: {
      protocol_version: 1,
      operation_id: row.operation_id,
      status: row.status,
      ...(row.response_code === null ? {} : { code: row.response_code }),
      trace_id: row.trace_id,
      ...(result === null ? {} : { result }),
    },
  };
}

export function operationOutcomeResponse(row: OperationRow): Response {
  const outcome = serializeOperationOutcome(row);
  return new Response(JSON.stringify(outcome.payload), {
    status: outcome.http_status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

export function terminalAckV3Response(
  ack: TerminalAckRequestV3,
  outcome: TerminalAckLedgerOutcome,
): Response {
  if (
    !outcome.finalAck ||
    outcome.acknowledgedAt === null ||
    !Number.isSafeInteger(outcome.acknowledgedAt) ||
    outcome.acknowledgedAt < 1
  ) {
    throw new ProtocolError("terminal_ack_outcome_corrupt", 503);
  }
  const payload: TerminalAckV3Response = {
    protocol_version: ack.protocol_version,
    terminal_ack_contract_version: ack.terminal_ack_contract_version,
    financial_terminal_contract_version: ack.financial_terminal_contract_version,
    billing_event_id: ack.billing_event_id,
    operation_id: ack.operation_id,
    reconciliation_revision: ack.reconciliation_revision,
    terminal_contract_sha256: ack.terminal_contract_sha256,
    client_response_artifact_sha256:
      ack.provider_response_binding.client_response_artifact_sha256,
    status: outcome.kind,
    final_ack: true,
    acknowledged_at: outcome.acknowledgedAt,
  };
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

export function operationStatusResponse(snapshot: OperationStatusSnapshot): Response {
  const outcome = serializeOperationOutcome(snapshot.operation);
  const attempt = snapshot.provider_attempt;
  if (
    attempt !== null &&
    (attempt.operation_id !== snapshot.operation.operation_id ||
      attempt.owner_generation !== snapshot.operation.owner_generation ||
      snapshot.operation.status === "claimed" ||
      (snapshot.operation.status === "running" &&
        (attempt.status === "ambiguous" || attempt.status === "cancelled")) ||
      (snapshot.operation.status === "completed" && attempt.status !== "succeeded") ||
      (snapshot.operation.status === "failed" &&
        attempt.status !== "definite_reject" &&
        attempt.status !== "cancelled") ||
      (snapshot.operation.status === "recovery_required" && attempt.status !== "ambiguous"))
  ) {
    throw corruptOutcome();
  }
  const attemptResult = attempt === null ? null : operationStorageResult(attempt);
  const operationResult = outcome.payload.result ?? null;
  if (
    attemptResult !== null &&
    (operationResult === null || !storageResultsMatch(attemptResult, operationResult))
  ) {
    throw corruptOutcome();
  }
  const payload: OperationStatusPayload = {
    ...outcome.payload,
    provider_attempt:
      attempt === null
        ? null
        : {
            attempt_generation: attempt.attempt_generation,
            provider_operation_id: attempt.provider_operation_id,
            admission_sha256: attempt.admission_sha256,
            request_sha256: attempt.request_sha256,
            status: attempt.status,
            response_status: attempt.response_status,
            response_code: attempt.response_code,
            result: attemptResult,
            prepared_at: attempt.prepared_at,
            dispatched_at: attempt.dispatched_at,
            terminal_at: attempt.terminal_at,
          },
  };
  return new Response(JSON.stringify(payload), {
    status: outcome.http_status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

export function operationStatusResponseV3(snapshot: OperationStatusSnapshot): Response {
  const outcome = serializeOperationOutcome(snapshot.operation);
  const attempt = snapshot.provider_attempt;
  if (
    attempt !== null &&
    (attempt.operation_id !== snapshot.operation.operation_id ||
      attempt.owner_generation !== snapshot.operation.owner_generation ||
      snapshot.operation.status === "claimed" ||
      (snapshot.operation.status === "running" &&
        (attempt.status === "ambiguous" || attempt.status === "cancelled")) ||
      (snapshot.operation.status === "completed" && attempt.status !== "succeeded") ||
      (snapshot.operation.status === "failed" &&
        attempt.status !== "definite_reject" &&
        attempt.status !== "cancelled") ||
      (snapshot.operation.status === "recovery_required" && attempt.status !== "ambiguous"))
  ) {
    throw corruptOutcome();
  }
  const attemptResult = attempt === null ? null : operationStorageResult(attempt);
  const operationResult = outcome.payload.result ?? null;
  if (
    attemptResult !== null &&
    (operationResult === null || !storageResultsMatch(attemptResult, operationResult))
  ) {
    throw corruptOutcome();
  }

  const receiptSha256 = snapshot.operation.provider_usage_receipt_sha256;
  if (
    (receiptSha256 !== null && !/^[0-9a-f]{64}$/.test(receiptSha256)) ||
    (receiptSha256 === null &&
      attempt !== null &&
      (attempt.provider_usage_receipt_sha256 !== null ||
        attempt.provider_usage_receipt_attached_at !== null)) ||
    (receiptSha256 !== null &&
      (operationResult === null ||
        attempt === null ||
        attempt.provider_usage_receipt_sha256 !== receiptSha256 ||
        attempt.provider_usage_receipt_attached_at === null ||
        !Number.isSafeInteger(attempt.provider_usage_receipt_attached_at) ||
        attempt.provider_usage_receipt_attached_at < 1 ||
        attempt.dispatched_at === null ||
        attempt.provider_usage_receipt_attached_at < attempt.dispatched_at ||
        (attempt.terminal_at !== null &&
          attempt.provider_usage_receipt_attached_at > attempt.terminal_at) ||
        !["dispatched", "succeeded", "ambiguous"].includes(attempt.status)))
  ) {
    throw corruptOutcome();
  }

  const payload: OperationStatusV3Payload = {
    status_contract_version: 3,
    ...outcome.payload,
    provider_usage_receipt_sha256: receiptSha256,
    provider_attempt:
      attempt === null
        ? null
        : {
            attempt_generation: attempt.attempt_generation,
            provider_operation_id: attempt.provider_operation_id,
            admission_sha256: attempt.admission_sha256,
            request_sha256: attempt.request_sha256,
            status: attempt.status,
            response_status: attempt.response_status,
            response_code: attempt.response_code,
            result: attemptResult,
            provider_usage_receipt_sha256: attempt.provider_usage_receipt_sha256,
            provider_usage_receipt_attached_at:
              attempt.provider_usage_receipt_attached_at,
            prepared_at: attempt.prepared_at,
            dispatched_at: attempt.dispatched_at,
            terminal_at: attempt.terminal_at,
          },
  };
  return new Response(JSON.stringify(payload), {
    status: outcome.http_status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

export function operationStatusResponseV4(snapshot: OperationStatusV4Snapshot): Response {
  const outcome = serializeOperationOutcome(snapshot.operation);
  const attempt = snapshot.provider_attempt;
  if (
    attempt !== null &&
    (attempt.operation_id !== snapshot.operation.operation_id ||
      attempt.owner_generation !== snapshot.operation.owner_generation ||
      snapshot.operation.status === "claimed" ||
      (snapshot.operation.status === "running" &&
        (attempt.status === "ambiguous" || attempt.status === "cancelled")) ||
      (snapshot.operation.status === "completed" && attempt.status !== "succeeded") ||
      (snapshot.operation.status === "failed" &&
        attempt.status !== "definite_reject" &&
        attempt.status !== "cancelled") ||
      (snapshot.operation.status === "recovery_required" && attempt.status !== "ambiguous"))
  ) {
    throw corruptOutcome();
  }
  const attemptResult = attempt === null ? null : operationStorageResult(attempt);
  const operationResult = outcome.payload.result ?? null;
  if (
    attemptResult !== null &&
    (operationResult === null || !storageResultsMatch(attemptResult, operationResult))
  ) {
    throw corruptOutcome();
  }

  const receiptSha256 = snapshot.operation.provider_usage_receipt_sha256;
  if (
    (receiptSha256 !== null && !/^[0-9a-f]{64}$/.test(receiptSha256)) ||
    (receiptSha256 === null &&
      attempt !== null &&
      (attempt.provider_usage_receipt_sha256 !== null ||
        attempt.provider_usage_receipt_attached_at !== null)) ||
    (receiptSha256 !== null &&
      (operationResult === null ||
        attempt === null ||
        attempt.provider_usage_receipt_sha256 !== receiptSha256 ||
        attempt.provider_usage_receipt_attached_at === null ||
        !Number.isSafeInteger(attempt.provider_usage_receipt_attached_at) ||
        attempt.provider_usage_receipt_attached_at < 1 ||
        attempt.dispatched_at === null ||
        attempt.provider_usage_receipt_attached_at < attempt.dispatched_at ||
        (attempt.terminal_at !== null &&
          attempt.provider_usage_receipt_attached_at > attempt.terminal_at) ||
        !["dispatched", "succeeded", "ambiguous"].includes(attempt.status)))
  ) {
    throw corruptOutcome();
  }

  const artifacts = snapshot.provider_response_artifacts;
  if (
    !providerResponseArtifactsMatchV4(
      artifacts,
      snapshot.operation,
      attempt,
      operationResult,
      attemptResult,
    )
  ) {
    throw corruptOutcome();
  }

  const payload: OperationStatusV4Payload = {
    status_contract_version: 4,
    ...outcome.payload,
    provider_usage_receipt_sha256: receiptSha256,
    provider_attempt:
      attempt === null
        ? null
        : {
            attempt_generation: attempt.attempt_generation,
            provider_operation_id: attempt.provider_operation_id,
            admission_sha256: attempt.admission_sha256,
            request_sha256: attempt.request_sha256,
            status: attempt.status,
            response_status: attempt.response_status,
            response_code: attempt.response_code,
            result: attemptResult,
            provider_usage_receipt_sha256: attempt.provider_usage_receipt_sha256,
            provider_usage_receipt_attached_at:
              attempt.provider_usage_receipt_attached_at,
            prepared_at: attempt.prepared_at,
            dispatched_at: attempt.dispatched_at,
            terminal_at: attempt.terminal_at,
          },
    provider_response_artifacts:
      artifacts === null ? null : serializeProviderResponseArtifacts(artifacts),
  };
  return new Response(JSON.stringify(payload), {
    status: outcome.http_status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function providerResponseArtifactsMatchV4(
  artifacts: ProviderResponseArtifactAttachmentRow | null,
  operation: OperationRow,
  attempt: ProviderAttemptRow | null,
  operationResult: StorageResultRecord | null,
  attemptResult: StorageResultRecord | null,
): boolean {
  if (artifacts === null) return true;
  if (
    attempt === null ||
    artifacts.operation_id !== operation.operation_id ||
    artifacts.owner_generation !== operation.owner_generation ||
    artifacts.attempt_generation !== attempt.attempt_generation ||
    artifacts.provider_operation_id !== attempt.provider_operation_id ||
    artifacts.admission_sha256 !== attempt.admission_sha256 ||
    artifacts.request_sha256 !== attempt.request_sha256 ||
    artifacts.egress_profile !== attempt.egress_profile ||
    artifacts.egress_worker_version_id !== attempt.egress_worker_version_id ||
    artifacts.egress_profile !== "openai-chat-completions-canary-v1" ||
    !validEgressVersion(artifacts.egress_worker_version_id) ||
    !Number.isSafeInteger(artifacts.attached_at) ||
    artifacts.attached_at < 1 ||
    !validArtifactAttemptTimeline(attempt, artifacts.attached_at) ||
    !attachmentStatusMatchesAttempt(artifacts.status, attempt.status)
  ) {
    return false;
  }

  const rawManifestValid = validProviderResponseEvidenceManifestV4(
    artifacts.raw_manifest,
    operation.operation_id,
    operation.owner_generation,
    attempt.attempt_generation,
  );
  const clientManifestValid = validClientResponseArtifactManifestV4(
    artifacts.client_manifest,
    operation.operation_id,
    operation.owner_generation,
  );

  if (artifacts.status === "succeeded") {
    const receipt = artifacts.provider_usage_receipt_sha256;
    return (
      artifacts.provider_status === 200 &&
      artifacts.client_status === 200 &&
      artifacts.response_class === "success" &&
      artifacts.response_code === null &&
      rawManifestValid &&
      clientManifestValid &&
      receipt !== null &&
      /^[0-9a-f]{64}$/.test(receipt) &&
      operation.provider_usage_receipt_sha256 === receipt &&
      attempt.provider_usage_receipt_sha256 === receipt &&
      attempt.provider_usage_receipt_attached_at !== null &&
      attempt.provider_usage_receipt_attached_at <= artifacts.attached_at &&
      operationResult !== null &&
      operationResult.object_key ===
        `container-results/v1/${operation.operation_id}/${operation.owner_generation}/${operationResult.sha256}` &&
      clientBodyMatchesResult(artifacts.client_manifest, operationResult) &&
      (attempt.status === "dispatched"
        ? attemptResult === null
        : attemptResult !== null && storageResultsMatch(attemptResult, operationResult))
    );
  }

  const hasNoFinancialEvidence =
    operationResult === null &&
    attemptResult === null &&
    operation.provider_usage_receipt_sha256 === null &&
    attempt.provider_usage_receipt_sha256 === null &&
    attempt.provider_usage_receipt_attached_at === null &&
    artifacts.provider_usage_receipt_sha256 === null;
  if (artifacts.status === "interpreted_reject") {
    return (
      hasNoFinancialEvidence &&
      rawManifestValid &&
      clientManifestValid &&
      validResponseCode(artifacts.response_code) &&
      providerRejectionStatusesMatch(
        artifacts.response_class,
        artifacts.provider_status,
        artifacts.client_status,
      )
    );
  }

  return (
    hasNoFinancialEvidence &&
    artifacts.provider_status === null &&
    artifacts.client_status === null &&
    artifacts.response_class === null &&
    validResponseCode(artifacts.response_code) &&
    artifacts.raw_manifest === null &&
    artifacts.client_manifest === null
  );
}

function attachmentStatusMatchesAttempt(
  attachmentStatus: ProviderResponseArtifactAttachmentRow["status"],
  attemptStatus: ProviderAttemptRow["status"],
): boolean {
  switch (attachmentStatus) {
    case "succeeded":
      return ["dispatched", "succeeded", "ambiguous"].includes(attemptStatus);
    case "interpreted_reject":
      return ["dispatched", "definite_reject", "ambiguous"].includes(attemptStatus);
    case "ambiguous":
      return attemptStatus === "dispatched" || attemptStatus === "ambiguous";
    default:
      return false;
  }
}

function validArtifactAttemptTimeline(
  attempt: ProviderAttemptRow,
  attachedAt: number,
): boolean {
  if (
    !Number.isSafeInteger(attempt.prepared_at) ||
    attempt.prepared_at < 1 ||
    attempt.dispatched_at === null ||
    !Number.isSafeInteger(attempt.dispatched_at) ||
    attempt.dispatched_at < attempt.prepared_at ||
    attachedAt < attempt.dispatched_at ||
    !Number.isSafeInteger(attempt.updated_at) ||
    attempt.updated_at < attempt.prepared_at
  ) {
    return false;
  }
  if (attempt.status === "dispatched") {
    return (
      attempt.terminal_at === null &&
      attempt.response_status === null &&
      attempt.response_code === null &&
      attempt.updated_at === attempt.dispatched_at
    );
  }
  if (
    attempt.terminal_at === null ||
    !Number.isSafeInteger(attempt.terminal_at) ||
    attempt.terminal_at < attachedAt ||
    attempt.updated_at !== attempt.terminal_at
  ) {
    return false;
  }
  switch (attempt.status) {
    case "succeeded":
      return attempt.response_status === 200 && attempt.response_code === null;
    case "definite_reject":
      return (
        attempt.response_status !== null &&
        attempt.response_status >= 400 &&
        attempt.response_status <= 599 &&
        validResponseCode(attempt.response_code)
      );
    case "ambiguous":
      return attempt.response_status === 202 && validResponseCode(attempt.response_code);
    default:
      return false;
  }
}

function validProviderResponseEvidenceManifestV4(
  manifest: ProviderResponseEvidenceManifest | null,
  operationId: string,
  ownerGeneration: number,
  attemptGeneration: number,
): manifest is ProviderResponseEvidenceManifest {
  return (
    manifest !== null &&
    typeof manifest === "object" &&
    typeof manifest.object_key === "string" &&
    typeof manifest.object_version === "string" &&
    typeof manifest.provider_response_evidence_sha256 === "string" &&
    typeof manifest.sha256 === "string" &&
    typeof manifest.size === "number" &&
    typeof manifest.content_type === "string" &&
    manifest.object_key ===
      `container-provider-evidence/v1/${operationId}/${ownerGeneration}/${attemptGeneration}/${manifest.sha256}` &&
    validArtifactObjectVersion(manifest.object_version) &&
    /^[0-9a-f]{64}$/.test(manifest.provider_response_evidence_sha256) &&
    /^[0-9a-f]{64}$/.test(manifest.sha256) &&
    Number.isSafeInteger(manifest.size) &&
    manifest.size >= 0 &&
    manifest.size <= 4 * 1024 * 1024 &&
    validArtifactContentType(manifest.content_type)
  );
}

function validClientResponseArtifactManifestV4(
  manifest: ClientResponseArtifactManifest | null,
  operationId: string,
  ownerGeneration: number,
): manifest is ClientResponseArtifactManifest {
  return (
    manifest !== null &&
    typeof manifest === "object" &&
    typeof manifest.object_key === "string" &&
    typeof manifest.object_version === "string" &&
    typeof manifest.client_response_artifact_sha256 === "string" &&
    typeof manifest.sha256 === "string" &&
    typeof manifest.size === "number" &&
    manifest.object_key ===
      `container-client-artifacts/v1/${operationId}/${ownerGeneration}/${manifest.client_response_artifact_sha256}` &&
    validArtifactObjectVersion(manifest.object_version) &&
    /^[0-9a-f]{64}$/.test(manifest.client_response_artifact_sha256) &&
    /^[0-9a-f]{64}$/.test(manifest.sha256) &&
    Number.isSafeInteger(manifest.size) &&
    manifest.size >= 2 &&
    manifest.size <= 4 * 1024 * 1024 &&
    manifest.content_type === "application/json"
  );
}

function validArtifactObjectVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    IDENTIFIER.test(value)
  );
}

function validArtifactContentType(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 3 &&
    value.length <= 128 &&
    /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:;[ -~]+)?$/.test(value)
  );
}

function validEgressVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    /^[A-Za-z0-9._:/@-]+$/.test(value)
  );
}

function clientBodyMatchesResult(
  manifest: ClientResponseArtifactManifest,
  result: StorageResultRecord,
): boolean {
  return (
    manifest.sha256 === result.sha256 &&
    manifest.size === result.size &&
    manifest.content_type === result.content_type
  );
}

function serializeProviderResponseArtifacts(
  row: ProviderResponseArtifactAttachmentRow,
): ProviderResponseArtifactAttachmentRow {
  const identity = {
    operation_id: row.operation_id,
    owner_generation: row.owner_generation,
    attempt_generation: row.attempt_generation,
    provider_operation_id: row.provider_operation_id,
    admission_sha256: row.admission_sha256,
    request_sha256: row.request_sha256,
    egress_profile: row.egress_profile,
    egress_worker_version_id: row.egress_worker_version_id,
    attached_at: row.attached_at,
  };
  if (row.status === "ambiguous") {
    return {
      status: "ambiguous",
      provider_status: null,
      client_status: null,
      response_class: null,
      response_code: row.response_code,
      raw_manifest: null,
      client_manifest: null,
      provider_usage_receipt_sha256: null,
      ...identity,
    };
  }
  const rawManifest = serializeProviderResponseEvidenceManifest(row.raw_manifest);
  const clientManifest = serializeClientResponseArtifactManifest(row.client_manifest);
  if (row.status === "succeeded") {
    return {
      status: "succeeded",
      provider_status: 200,
      client_status: 200,
      response_class: "success",
      response_code: null,
      raw_manifest: rawManifest,
      client_manifest: clientManifest,
      provider_usage_receipt_sha256: row.provider_usage_receipt_sha256,
      ...identity,
    };
  }
  return {
    status: "interpreted_reject",
    provider_status: row.provider_status,
    client_status: row.client_status,
    response_class: row.response_class,
    response_code: row.response_code,
    raw_manifest: rawManifest,
    client_manifest: clientManifest,
    provider_usage_receipt_sha256: null,
    ...identity,
  };
}

function serializeProviderResponseEvidenceManifest(
  manifest: ProviderResponseEvidenceManifest,
): ProviderResponseEvidenceManifest {
  return {
    object_key: manifest.object_key,
    object_version: manifest.object_version,
    provider_response_evidence_sha256:
      manifest.provider_response_evidence_sha256,
    sha256: manifest.sha256,
    size: manifest.size,
    content_type: manifest.content_type,
  };
}

function serializeClientResponseArtifactManifest(
  manifest: ClientResponseArtifactManifest,
): ClientResponseArtifactManifest {
  return {
    object_key: manifest.object_key,
    object_version: manifest.object_version,
    client_response_artifact_sha256:
      manifest.client_response_artifact_sha256,
    sha256: manifest.sha256,
    size: manifest.size,
    content_type: "application/json",
  };
}

function storageResultsMatch(left: StorageResultRecord, right: StorageResultRecord): boolean {
  return (
    left.object_key === right.object_key &&
    left.object_version === right.object_version &&
    left.sha256 === right.sha256 &&
    left.size === right.size &&
    left.content_type === right.content_type
  );
}

function validateOperationIdentity(row: OperationRow): void {
  if (
    row.operation_id.length < 1 ||
    row.operation_id.length > 128 ||
    !IDENTIFIER.test(row.operation_id) ||
    !Number.isSafeInteger(row.owner_generation) ||
    row.owner_generation < 1 ||
    row.operation_kind.length < 1 ||
    row.operation_kind.length > 64 ||
    !OPERATION_KIND.test(row.operation_kind) ||
    row.trace_id.length < 1 ||
    row.trace_id.length > 128 ||
    !IDENTIFIER.test(row.trace_id)
  ) {
    throw corruptOutcome();
  }
}

function validResponseCode(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 64 && RESPONSE_CODE.test(value);
}

function parseProviderResponseClassification(value: unknown): ProviderResponseClassification {
  if (value === "typed_error" || value === "http_error" || value === "invalid_body") {
    return value;
  }
  throw invalidContainerResponse();
}

function parseProviderResponseStatus(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 100 || (value as number) > 599) {
    throw invalidContainerResponse();
  }
  return value as number;
}

function providerRejectionStatusesMatch(
  classification: ProviderResponseClassification,
  providerStatus: number,
  clientStatus: number,
): boolean {
  switch (classification) {
    case "typed_error":
      return providerStatus === 200 && clientStatus === 200;
    case "http_error":
      return providerStatus !== 200 && clientStatus === providerStatus;
    case "invalid_body":
      return providerStatus === 200 && clientStatus === 500;
  }
}

function parseClientResponseArtifactManifest(
  value: unknown,
  operationId: string,
  ownerGeneration: number,
): ClientResponseArtifactManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidContainerResponse();
  }
  const record = value as Record<string, unknown>;
  const expected = [
    "object_key",
    "object_version",
    "client_response_artifact_sha256",
    "sha256",
    "size",
    "content_type",
  ];
  if (
    Object.keys(record).length !== expected.length ||
    expected.some((key) => !(key in record)) ||
    typeof record.object_key !== "string" ||
    typeof record.object_version !== "string" ||
    typeof record.client_response_artifact_sha256 !== "string" ||
    typeof record.sha256 !== "string" ||
    typeof record.size !== "number" ||
    record.content_type !== "application/json" ||
    !/^[0-9a-f]{64}$/.test(record.client_response_artifact_sha256) ||
    !/^[0-9a-f]{64}$/.test(record.sha256) ||
    !Number.isSafeInteger(record.size) ||
    record.size < 2 ||
    record.size > 4 * 1024 * 1024 ||
    record.object_version.length < 1 ||
    record.object_version.length > 128 ||
    !IDENTIFIER.test(record.object_version) ||
    record.object_key !==
      `container-client-artifacts/v1/${operationId}/${ownerGeneration}/${record.client_response_artifact_sha256}`
  ) {
    throw invalidContainerResponse();
  }
  return {
    object_key: record.object_key,
    object_version: record.object_version,
    client_response_artifact_sha256: record.client_response_artifact_sha256,
    sha256: record.sha256,
    size: record.size,
    content_type: record.content_type,
  };
}

function parseContainerResult(value: unknown): StorageResultRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidContainerResponse();
  }
  const record = value as Record<string, unknown>;
  const expected = ["object_key", "object_version", "sha256", "size", "content_type"];
  if (
    Object.keys(record).length !== expected.length ||
    expected.some((key) => !(key in record)) ||
    typeof record.object_key !== "string" ||
    typeof record.object_version !== "string" ||
    typeof record.sha256 !== "string" ||
    typeof record.size !== "number" ||
    typeof record.content_type !== "string"
  ) {
    throw invalidContainerResponse();
  }
  return {
    object_key: record.object_key,
    object_version: record.object_version,
    sha256: record.sha256,
    size: record.size,
    content_type: record.content_type,
  };
}

function invalidContainerResponse(): ProtocolError {
  return new ProtocolError("invalid_container_response", 502);
}

function corruptOutcome(): ProtocolError {
  return new ProtocolError("operation_outcome_corrupt", 503);
}
