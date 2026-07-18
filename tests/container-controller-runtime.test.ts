import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  ProtocolError,
  type OperationEnvelope,
  type OperationStatusQuery,
  type TerminalAckRequest,
  type TerminalAckRequestV2,
} from "../services/container-controller/src/protocol";
import {
  RelayShardLedger,
  operationRecoveryIntentPayload,
  type ClientResponseArtifactManifest,
  type OperationStatus,
  type ProviderResponseArtifactAttachment,
  type ProviderResponseEvidenceManifest,
  type RelayShardLedgerPolicy,
  type StorageResultRecord,
} from "../services/container-controller/src/ledger";
import type { ContainerControllerLedgerTestObject } from "./fixtures/container-controller-ledger-worker";

declare global {
  namespace Cloudflare {
    interface Env {
      CONTAINER_CONTROLLER_LEDGER: DurableObjectNamespace<ContainerControllerLedgerTestObject>;
    }
  }
}

interface OperationSqlRow {
  [key: string]: SqlStorageValue;
  operation_id: string;
  status: OperationStatus;
  response_status: number | null;
  response_code: string | null;
  updated_at: number;
}

interface LifecycleSqlRow {
  [key: string]: SqlStorageValue;
  lifecycle_state: string;
  lifecycle_detail: string | null;
  updated_at: number;
}

const BASE_NOW = 1_800_000_000;
const PROVIDER_EGRESS_IDENTITY = {
  profile: "openai-chat-completions-canary-v1",
  worker_version_id: "worker-version-v3",
};

function sha256(character: string): string {
  return character.repeat(64);
}

function operationEnvelope(
  operationId: string,
  overrides: Partial<OperationEnvelope> = {},
): OperationEnvelope {
  return {
    protocol_version: 1,
    operation_id: operationId,
    operation_kind: "relay",
    owner_generation: 1,
    owner_lease_expires_at: BASE_NOW + 600,
    execution_deadline_at: BASE_NOW + 300,
    provider_operation_id: `provider-${operationId}`,
    admission_sha256: sha256("a"),
    input: {
      mode: "inline",
      sha256: sha256("b"),
      size: 2,
      content_type: "application/json",
    },
    shard: {
      contract_version: 1,
      ring_generation: 1,
      shard_count: 8,
      shard_index: 3,
      instance_name: "cinatoken-relay-shard-v1-0003",
    },
    trace_id: `trace-${operationId}`,
    ...overrides,
  };
}

function operationStatusQuery(
  operation: OperationEnvelope,
  overrides: Partial<OperationStatusQuery> = {},
): OperationStatusQuery {
  return {
    protocol_version: operation.protocol_version,
    operation_id: operation.operation_id,
    owner_generation: operation.owner_generation,
    shard: operation.shard,
    trace_id: operation.trace_id,
    ...overrides,
  };
}

function ledgerPolicy(
  overrides: Partial<RelayShardLedgerPolicy> = {},
): RelayShardLedgerPolicy {
  return {
    maxInFlight: 4,
    dispatchRetentionSeconds: 60,
    terminalRetentionSeconds: 300,
    maxTerminalOperations: 100,
    globalTerminalCompactionEnabled: false,
    ...overrides,
  };
}

async function authorizeTerminalCompactionForTest(
  stub: DurableObjectStub<ContainerControllerLedgerTestObject>,
  operationIds: readonly string[],
  now: number,
): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    for (const operationId of operationIds) {
      state.storage.sql.exec(
        `INSERT INTO cinatoken_shard_terminal_acks
           (operation_id, owner_generation, billing_event_id,
            terminal_contract_sha256, reconciliation_id, reconciliation_revision,
            predecessor_billing_event_id, ack_payload_json, recovery_payload_json,
            final_acked_at, compaction_authorized_at, created_at, updated_at)
         VALUES (?1, 1, ?2, ?3, ?4, 1, NULL, '{}', NULL, ?5, ?5, ?5, ?5)`,
        operationId,
        sha256("1"),
        sha256("2"),
        sha256("3"),
        now,
      );
    }
  });
}

function operationResult(operation: OperationEnvelope): StorageResultRecord {
  const resultSha256 = sha256("c");
  return {
    object_key:
      `container-results/v1/${operation.operation_id}/${operation.owner_generation}/${resultSha256}`,
    object_version: "result-version-1",
    sha256: resultSha256,
    size: 2,
    content_type: "application/json",
  };
}

function providerEvidenceManifest(
  operation: OperationEnvelope,
  digestCharacter = "d",
  bodySha256 = sha256("c"),
  attemptGeneration = 1,
  overrides: Partial<ProviderResponseEvidenceManifest> = {},
): ProviderResponseEvidenceManifest {
  const sha = overrides.sha256 ?? bodySha256;
  return {
    object_key:
      `container-provider-evidence/v1/${operation.operation_id}/` +
      `${operation.owner_generation}/${attemptGeneration}/${sha}`,
    object_version: `provider-evidence-version-${digestCharacter}`,
    provider_response_evidence_sha256: sha256(digestCharacter),
    sha256: sha,
    size: 2,
    content_type: "application/json",
    ...overrides,
  };
}

function clientArtifactManifest(
  operation: OperationEnvelope,
  digestCharacter = "e",
  bodySha256 = sha256("c"),
  overrides: Partial<ClientResponseArtifactManifest> = {},
): ClientResponseArtifactManifest {
  const artifactSha256 =
    overrides.client_response_artifact_sha256 ?? sha256(digestCharacter);
  return {
    object_key:
      `container-client-artifacts/v1/${operation.operation_id}/` +
      `${operation.owner_generation}/${artifactSha256}`,
    object_version: `client-artifact-version-${digestCharacter}`,
    client_response_artifact_sha256: artifactSha256,
    sha256: bodySha256,
    size: 2,
    content_type: "application/json",
    ...overrides,
  };
}

function successAttachment(
  operation: OperationEnvelope,
  digestCharacters = "de",
  overrides: Partial<ProviderResponseArtifactAttachment> = {},
): ProviderResponseArtifactAttachment {
  return {
    status: "succeeded",
    provider_status: 200,
    client_status: 200,
    response_class: "success",
    response_code: null,
    raw_manifest: providerEvidenceManifest(operation, digestCharacters[0]!),
    client_manifest: clientArtifactManifest(operation, digestCharacters[1]!),
    provider_usage_receipt_sha256: null,
    ...overrides,
  } as ProviderResponseArtifactAttachment;
}

function interpretedRejectAttachment(
  operation: OperationEnvelope,
  responseClass: "typed_error" | "http_error" | "invalid_body",
  providerStatus: number,
  clientStatus: number,
  digestCharacters = "ab",
): ProviderResponseArtifactAttachment {
  return {
    status: "interpreted_reject",
    provider_status: providerStatus,
    client_status: clientStatus,
    response_class: responseClass,
    response_code: `provider_${responseClass}`,
    raw_manifest: providerEvidenceManifest(operation, digestCharacters[0]!),
    client_manifest: clientArtifactManifest(
      operation,
      digestCharacters[1]!,
      sha256(digestCharacters[1]!),
    ),
    provider_usage_receipt_sha256: null,
  };
}

function ambiguousAttachment(): ProviderResponseArtifactAttachment {
  return {
    status: "ambiguous",
    provider_status: null,
    client_status: null,
    response_class: null,
    response_code: "provider_response_ambiguous",
    raw_manifest: null,
    client_manifest: null,
    provider_usage_receipt_sha256: null,
  };
}

async function dispatchVersionedProviderAttempt(
  stub: DurableObjectStub<ContainerControllerLedgerTestObject>,
  operation: OperationEnvelope,
  now = BASE_NOW,
): Promise<void> {
  await stub.claim(
    operation,
    sha256("9"),
    `dispatch-${operation.operation_id}`,
    ledgerPolicy(),
    now,
  );
  await stub.startOperationWithProviderAttemptOutcome(
    operation.operation_id,
    operation.owner_generation,
    { maxAttempts: 1, retryEnabled: false },
    now + 1,
  );
  await stub.dispatchProviderAttemptV2Outcome(
    operation.operation_id,
    operation.owner_generation,
    1,
    PROVIDER_EGRESS_IDENTITY,
    now + 2,
  );
}

async function attachProviderResponse(
  stub: DurableObjectStub<ContainerControllerLedgerTestObject>,
  operation: OperationEnvelope,
  attachment: ProviderResponseArtifactAttachment,
  now: number,
  ownerGeneration = operation.owner_generation,
  attemptGeneration = 1,
) {
  return runInDurableObject(stub, (_instance, state) => {
    try {
      return {
        ok: true as const,
        result: new RelayShardLedger(state.storage).attachProviderResponseArtifacts(
          operation.operation_id,
          ownerGeneration,
          attemptGeneration,
          attachment,
          now,
        ),
      };
    } catch (error) {
      if (error instanceof ProtocolError) {
        return {
          ok: false as const,
          error: { code: error.code, status: error.status },
        };
      }
      throw error;
    }
  });
}

function terminalAck(
  operation: OperationEnvelope,
  overrides: Partial<TerminalAckRequest> = {},
): TerminalAckRequest {
  return {
    protocol_version: 1,
    billing_event_id: sha256("d"),
    terminal_contract_sha256: sha256("e"),
    reconciliation_id: sha256("f"),
    reconciliation_revision: 1,
    predecessor_billing_event_id: null,
    operation_id: operation.operation_id,
    owner_generation: operation.owner_generation,
    operation_from_status: "dispatched",
    operation_status: "completed",
    response_status: 200,
    response_code: null,
    result: operationResult(operation),
    shard: operation.shard,
    trace_id: operation.trace_id,
    ...overrides,
  };
}

async function acknowledgeTerminal(
  stub: DurableObjectStub<ContainerControllerLedgerTestObject>,
  ack: TerminalAckRequest,
  now: number,
) {
  return runInDurableObject(stub, (_instance, state) => {
    try {
      return {
        ok: true as const,
        result: new RelayShardLedger(state.storage).acknowledgeGlobalTerminal(ack, now),
      };
    } catch (error) {
      if (error instanceof ProtocolError) {
        return { ok: false as const, error: { code: error.code, status: error.status } };
      }
      throw error;
    }
  });
}

function ledgerStub(name: string): DurableObjectStub<ContainerControllerLedgerTestObject> {
  return env.CONTAINER_CONTROLLER_LEDGER.getByName(name);
}

function readinessCompletion(resultCode: string, processReady = false) {
  return {
    resultCode,
    containerStatus: processReady ? "healthy" : "stopped",
    containerLastChangeMs: BASE_NOW * 1_000,
    containerExitCode: null,
    runtimeProtocolVersion: processReady ? 1 : null,
    runtimeContractVersion: processReady ? 1 : null,
    runtimeExecutionEnabled: processReady ? false : null,
    processReady,
  };
}

describe("RelayShardLedger in Workerd", () => {
  it("serializes max + 1 concurrent claims without exceeding capacity", async () => {
    const stub = ledgerStub("concurrent-capacity");
    const maxInFlight = 3;
    const policy = ledgerPolicy({ maxInFlight });

    const results = await Promise.all(
      Array.from({ length: maxInFlight + 1 }, (_, index) =>
        stub.claim(
          operationEnvelope(`capacity-${index}`),
          sha256(index.toString(16)),
          `dispatch-capacity-${index}`,
          policy,
          BASE_NOW,
        ),
      ),
    );

    expect(results.map(({ kind }) => kind).sort()).toEqual([
      "capacity",
      "new",
      "new",
      "new",
    ]);
    await runInDurableObject(stub, (_instance, state) => {
      const rows = state.storage.sql
        .exec<OperationSqlRow>(
          `SELECT operation_id, status, response_status, response_code, updated_at
             FROM cinatoken_shard_operations ORDER BY operation_id`,
        )
        .toArray();
      expect(rows).toHaveLength(maxInFlight);
      expect(rows.every(({ status }) => status === "claimed")).toBe(true);
    });

    await stub.transition("capacity-0", 1, "claimed", "completed", 200, BASE_NOW + 1);
    await expect(
      stub.claim(
        operationEnvelope("capacity-retry"),
        sha256("9"),
        "dispatch-capacity-retry",
        policy,
        BASE_NOW + 2,
      ),
    ).resolves.toEqual({ kind: "new" });
  });

  it("returns an existing claim for the same operation and rejects owner or envelope conflicts", async () => {
    const stub = ledgerStub("operation-idempotency");
    const envelope = operationEnvelope("operation-idempotent");
    const envelopeSha256 = sha256("c");
    const policy = ledgerPolicy();

    await expect(
      stub.claim(envelope, envelopeSha256, "dispatch-original", policy, BASE_NOW),
    ).resolves.toEqual({ kind: "new" });
    await expect(
      stub.claim(envelope, envelopeSha256, "dispatch-original", policy, BASE_NOW + 1),
    ).resolves.toMatchObject({
      kind: "existing",
      row: {
        operation_id: envelope.operation_id,
        owner_generation: 1,
        envelope_sha256: envelopeSha256,
        status: "claimed",
        response_status: null,
      },
    });
    await expect(
      stub.claim(envelope, envelopeSha256, "dispatch-retry", policy, BASE_NOW + 2),
    ).resolves.toMatchObject({ kind: "existing" });

    await expect(
      stub.claimOutcome(
        operationEnvelope(envelope.operation_id, { owner_generation: 2 }),
        envelopeSha256,
        "dispatch-owner-conflict",
        policy,
        BASE_NOW + 3,
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: "operation_owner_conflict", status: 409 },
    });
    await expect(
      stub.claimOutcome(
        envelope,
        sha256("d"),
        "dispatch-envelope-conflict",
        policy,
        BASE_NOW + 4,
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: "operation_owner_conflict", status: 409 },
    });

    await runInDurableObject(stub, (_instance, state) => {
      const operationCount = state.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM cinatoken_shard_operations")
        .one().count;
      const dispatchCount = state.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM cinatoken_shard_dispatches")
        .one().count;
      expect({ operationCount, dispatchCount }).toEqual({ operationCount: 1, dispatchCount: 2 });
    });
  });

  it("persists one-shot provider dispatch authority across retries and eviction", async () => {
    const stub = ledgerStub("provider-attempt-one-shot");
    const operation = operationEnvelope("provider-attempt-one-shot", {
      operation_kind: "chat_completion",
    });
    await stub.claim(operation, sha256("c"), "dispatch-provider-attempt", ledgerPolicy(), BASE_NOW);
    await expect(
      stub.prepareProviderAttemptOutcome(operation.operation_id, 1, 1, BASE_NOW + 1),
    ).resolves.toEqual({
      ok: false,
      error: { code: "provider_attempt_not_authorized", status: 409 },
    });
    await expect(
      stub.startOperationWithProviderAttemptOutcome(
        operation.operation_id,
        1,
        { maxAttempts: 1, retryEnabled: false },
        BASE_NOW + 1,
      ),
    ).resolves.toMatchObject({
      ok: true,
      result: { kind: "prepared", row: { attempt_generation: 1, status: "prepared" } },
    });
    await expect(
      stub.startOperationWithProviderAttemptOutcome(
        operation.operation_id,
        1,
        { maxAttempts: 1, retryEnabled: false },
        BASE_NOW + 2,
      ),
    ).resolves.toMatchObject({
      ok: true,
      result: { kind: "existing", row: { attempt_generation: 1, status: "prepared" } },
    });
    await expect(
      stub.dispatchProviderAttemptOutcome(operation.operation_id, 1, 1, BASE_NOW + 4),
    ).resolves.toMatchObject({
      ok: true,
      result: { kind: "dispatched", row: { attempt_generation: 1, status: "dispatched" } },
    });
    await expect(
      stub.dispatchProviderAttemptOutcome(operation.operation_id, 1, 1, BASE_NOW + 5),
    ).resolves.toMatchObject({
      ok: true,
      result: { kind: "existing", row: { attempt_generation: 1, status: "dispatched" } },
    });

    await evictDurableObject(stub);
    const snapshot = await runInDurableObject(stub, (_instance, state) => {
      const ledger = new RelayShardLedger(state.storage);
      return ledger.readOperationStatusSnapshot(operationStatusQuery(operation));
    });
    expect(snapshot.provider_attempt).toMatchObject({
      operation_id: operation.operation_id,
      owner_generation: 1,
      attempt_generation: 1,
      provider_operation_id: operation.provider_operation_id,
      admission_sha256: operation.admission_sha256,
      request_sha256: operation.input.sha256,
      egress_profile: null,
      egress_worker_version_id: null,
      status: "dispatched",
      prepared_at: BASE_NOW + 1,
      dispatched_at: BASE_NOW + 4,
    });
  });

  it("persists immutable provider egress version identity at dispatch", async () => {
    const stub = ledgerStub("provider-attempt-version-identity");
    const operation = operationEnvelope("provider-attempt-version-identity", {
      operation_kind: "chat_completion",
    });
    const egressIdentity = {
      profile: "openai-chat-completions-canary-v1",
      worker_version_id: "worker-version-1",
    };
    await stub.claim(operation, sha256("v"), "dispatch-provider-version", ledgerPolicy(), BASE_NOW);
    await stub.startOperationWithProviderAttemptOutcome(
      operation.operation_id,
      1,
      { maxAttempts: 1, retryEnabled: false },
      BASE_NOW + 1,
    );
    await expect(
      stub.dispatchProviderAttemptV2Outcome(
        operation.operation_id,
        1,
        1,
        egressIdentity,
        BASE_NOW + 2,
      ),
    ).resolves.toMatchObject({
      ok: true,
      result: {
        kind: "dispatched",
        row: {
          egress_profile: egressIdentity.profile,
          egress_worker_version_id: egressIdentity.worker_version_id,
        },
      },
    });
    await expect(
      stub.dispatchProviderAttemptV2Outcome(
        operation.operation_id,
        1,
        1,
        egressIdentity,
        BASE_NOW + 3,
      ),
    ).resolves.toMatchObject({ ok: true, result: { kind: "existing" } });
    await expect(
      stub.dispatchProviderAttemptV2Outcome(
        operation.operation_id,
        1,
        1,
        { ...egressIdentity, worker_version_id: "worker-version-2" },
        BASE_NOW + 4,
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: "provider_attempt_egress_identity_conflict", status: 409 },
    });

    await evictDurableObject(stub);
    const persisted = await runInDurableObject(stub, (_instance, state) => {
      const event = state.storage.sql
        .exec<{ egress_profile: string | null; egress_worker_version_id: string | null }>(
          `SELECT egress_profile, egress_worker_version_id
             FROM cinatoken_shard_provider_attempt_events
            WHERE operation_id = ?1 AND owner_generation = 1
              AND attempt_generation = 1 AND event_sequence = 2`,
          operation.operation_id,
        )
        .one();
      let immutable = false;
      try {
        state.storage.sql.exec(
          `UPDATE cinatoken_shard_provider_attempts
              SET egress_worker_version_id = 'worker-version-2'
            WHERE operation_id = ?1`,
          operation.operation_id,
        );
      } catch {
        immutable = true;
      }
      const attempt = new RelayShardLedger(state.storage).readOperationStatusSnapshot(
        operationStatusQuery(operation),
      ).provider_attempt;
      return { event, immutable, attempt };
    });
    expect(persisted).toMatchObject({
      event: {
        egress_profile: egressIdentity.profile,
        egress_worker_version_id: egressIdentity.worker_version_id,
      },
      immutable: true,
      attempt: {
        egress_profile: egressIdentity.profile,
        egress_worker_version_id: egressIdentity.worker_version_id,
      },
    });
  });

  it("attaches immutable provider/client artifacts with exact replay across eviction", async () => {
    const stub = ledgerStub("provider-response-artifact-replay");
    const operation = operationEnvelope("provider-response-artifact-replay", {
      operation_kind: "chat_completion",
    });
    await dispatchVersionedProviderAttempt(stub, operation);
    const attachment = successAttachment(operation);

    await expect(
      attachProviderResponse(stub, operation, attachment, BASE_NOW + 3),
    ).resolves.toMatchObject({
      ok: true,
      result: {
        kind: "attached",
        row: {
          operation_id: operation.operation_id,
          owner_generation: 1,
          attempt_generation: 1,
          provider_operation_id: operation.provider_operation_id,
          admission_sha256: operation.admission_sha256,
          request_sha256: operation.input.sha256,
          egress_profile: PROVIDER_EGRESS_IDENTITY.profile,
          egress_worker_version_id: PROVIDER_EGRESS_IDENTITY.worker_version_id,
          status: "succeeded",
          provider_status: 200,
          client_status: 200,
          response_class: "success",
          attached_at: BASE_NOW + 3,
          raw_manifest: attachment.raw_manifest,
          client_manifest: attachment.client_manifest,
        },
      },
    });

    await evictDurableObject(stub);
    const persisted = await runInDurableObject(stub, (_instance, state) =>
      new RelayShardLedger(state.storage).readProviderResponseArtifactAttachment(
        operation.operation_id,
        1,
        1,
      ),
    );
    expect(persisted).toMatchObject({
      status: "succeeded",
      attached_at: BASE_NOW + 3,
      raw_manifest: attachment.raw_manifest,
      client_manifest: attachment.client_manifest,
    });
    await expect(
      attachProviderResponse(stub, operation, attachment, BASE_NOW + 301),
    ).resolves.toMatchObject({
      ok: true,
      result: { kind: "duplicate", row: { attached_at: BASE_NOW + 3 } },
    });

    const conflictingAttachment = {
      ...attachment,
      client_manifest: {
        ...attachment.client_manifest!,
        object_version: "client-artifact-version-conflict",
      },
    } as ProviderResponseArtifactAttachment;
    await expect(
      attachProviderResponse(
        stub,
        operation,
        conflictingAttachment,
        BASE_NOW + 4,
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: "provider_response_attachment_conflict", status: 409 },
    });

    const staleOwnerOperation = { ...operation, owner_generation: 2 };
    await expect(
      attachProviderResponse(
        stub,
        operation,
        successAttachment(staleOwnerOperation, "12"),
        BASE_NOW + 4,
        2,
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: "provider_response_attachment_conflict", status: 409 },
    });
    const staleAttemptAttachment = successAttachment(operation, "34", {
      raw_manifest: providerEvidenceManifest(operation, "3", sha256("c"), 2),
    });
    await expect(
      attachProviderResponse(
        stub,
        operation,
        staleAttemptAttachment,
        BASE_NOW + 4,
        1,
        2,
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: "provider_response_attachment_conflict", status: 409 },
    });

    const guards = await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("PRAGMA recursive_triggers = OFF");
      let updateRejected = false;
      let deleteRejected = false;
      let replaceRejected = false;
      let identityReplaceRejected = false;
      let identityUpdateRejected = false;
      let identityDeleteRejected = false;
      try {
        state.storage.sql.exec(
          `UPDATE cinatoken_shard_provider_response_attachments
              SET client_status = client_status
            WHERE operation_id = ?1`,
          operation.operation_id,
        );
      } catch {
        updateRejected = true;
      }
      try {
        state.storage.sql.exec(
          `DELETE FROM cinatoken_shard_provider_response_attachments
            WHERE operation_id = ?1`,
          operation.operation_id,
        );
      } catch {
        deleteRejected = true;
      }
      try {
        state.storage.sql.exec(
          `INSERT OR REPLACE INTO cinatoken_shard_provider_response_attachments
           SELECT * FROM cinatoken_shard_provider_response_attachments
            WHERE operation_id = ?1`,
          operation.operation_id,
        );
      } catch {
        replaceRejected = true;
      }
      try {
        state.storage.sql.exec(
          `INSERT OR REPLACE INTO
             cinatoken_shard_provider_response_attachment_identities
           SELECT *
             FROM cinatoken_shard_provider_response_attachment_identities
            WHERE operation_id = ?1`,
          operation.operation_id,
        );
      } catch {
        identityReplaceRejected = true;
      }
      try {
        state.storage.sql.exec(
          `UPDATE cinatoken_shard_provider_response_attachment_identities
              SET owner_generation = owner_generation
            WHERE operation_id = ?1`,
          operation.operation_id,
        );
      } catch {
        identityUpdateRejected = true;
      }
      try {
        state.storage.sql.exec(
          `DELETE FROM cinatoken_shard_provider_response_attachment_identities
            WHERE operation_id = ?1`,
          operation.operation_id,
        );
      } catch {
        identityDeleteRejected = true;
      }
      const attachmentCount = state.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM cinatoken_shard_provider_response_attachments",
        )
        .one().count;
      const identityCount = state.storage.sql
        .exec<{ count: number }>(
          `SELECT COUNT(*) AS count
             FROM cinatoken_shard_provider_response_attachment_identities`,
        )
        .one().count;
      state.storage.sql.exec("PRAGMA recursive_triggers = ON");
      return {
        updateRejected,
        deleteRejected,
        replaceRejected,
        identityReplaceRejected,
        identityUpdateRejected,
        identityDeleteRejected,
        attachmentCount,
        identityCount,
      };
    });
    expect(guards).toEqual({
      updateRejected: true,
      deleteRejected: true,
      replaceRejected: true,
      identityReplaceRejected: true,
      identityUpdateRejected: true,
      identityDeleteRejected: true,
      attachmentCount: 1,
      identityCount: 1,
    });

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "DELETE FROM cinatoken_shard_operations WHERE operation_id = ?1",
        operation.operation_id,
      );
    });
    await evictDurableObject(stub);
    await expect(
      attachProviderResponse(stub, operation, attachment, BASE_NOW + 302),
    ).resolves.toMatchObject({
      ok: true,
      result: { kind: "duplicate", row: { attached_at: BASE_NOW + 3 } },
    });
    const compacted = await runInDurableObject(stub, (_instance, state) => ({
      operations: state.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM cinatoken_shard_operations",
        )
        .one().count,
      attempts: state.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM cinatoken_shard_provider_attempts",
        )
        .one().count,
      attachments: state.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM cinatoken_shard_provider_response_attachments",
        )
        .one().count,
    }));
    expect(compacted).toEqual({ operations: 0, attempts: 0, attachments: 1 });
  });

  it("keeps provider/client status and response class distinct for v3 terminal shapes", async () => {
    const stub = ledgerStub("provider-response-terminal-shapes");
    const typed = operationEnvelope("provider-response-typed-reject", {
      operation_kind: "chat_completion",
    });
    const http202 = operationEnvelope("provider-response-http-202", {
      operation_kind: "chat_completion",
    });
    const invalidBody = operationEnvelope("provider-response-invalid-body", {
      operation_kind: "chat_completion",
    });
    const ambiguous = operationEnvelope("provider-response-ambiguous-v3", {
      operation_kind: "chat_completion",
    });
    for (const operation of [typed, http202, invalidBody, ambiguous]) {
      await dispatchVersionedProviderAttempt(stub, operation);
    }

    const invalidSuccess = successAttachment(typed, "01", {
      provider_status: 202,
    } as Partial<ProviderResponseArtifactAttachment>);
    await expect(
      attachProviderResponse(stub, typed, invalidSuccess, BASE_NOW + 3),
    ).resolves.toEqual({
      ok: false,
      error: { code: "invalid_provider_response_attachment", status: 400 },
    });
    const typedAttachment = interpretedRejectAttachment(
      typed,
      "typed_error",
      200,
      200,
      "12",
    );
    await expect(
      attachProviderResponse(stub, typed, typedAttachment, BASE_NOW + 3),
    ).resolves.toMatchObject({
      ok: true,
      result: {
        kind: "attached",
        row: {
          status: "interpreted_reject",
          provider_status: 200,
          client_status: 200,
          response_class: "typed_error",
        },
      },
    });

    const http202Attachment = interpretedRejectAttachment(
      http202,
      "http_error",
      202,
      202,
      "34",
    );
    await expect(
      attachProviderResponse(stub, http202, http202Attachment, BASE_NOW + 3),
    ).resolves.toMatchObject({
      ok: true,
      result: {
        row: {
          status: "interpreted_reject",
          provider_status: 202,
          client_status: 202,
          response_class: "http_error",
        },
      },
    });
    await expect(
      attachProviderResponse(
        stub,
        invalidBody,
        interpretedRejectAttachment(
          invalidBody,
          "invalid_body",
          200,
          500,
          "56",
        ),
        BASE_NOW + 3,
      ),
    ).resolves.toMatchObject({
      ok: true,
      result: {
        row: {
          status: "interpreted_reject",
          provider_status: 200,
          client_status: 500,
          response_class: "invalid_body",
        },
      },
    });
    await expect(
      attachProviderResponse(
        stub,
        ambiguous,
        {
          ...ambiguousAttachment(),
          status: "definite_reject",
        } as unknown as ProviderResponseArtifactAttachment,
        BASE_NOW + 3,
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: "invalid_provider_response_attachment", status: 400 },
    });
    await expect(
      attachProviderResponse(
        stub,
        ambiguous,
        ambiguousAttachment(),
        BASE_NOW * 1_000,
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: "invalid_provider_response_attachment", status: 400 },
    });
    await expect(
      attachProviderResponse(
        stub,
        ambiguous,
        ambiguousAttachment(),
        BASE_NOW + 3,
      ),
    ).resolves.toMatchObject({
      ok: true,
      result: {
        row: {
          status: "ambiguous",
          provider_status: null,
          client_status: null,
          response_class: null,
          raw_manifest: null,
          client_manifest: null,
        },
      },
    });

    const rows = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{
          operation_id: string;
          status: string;
          provider_status: number | null;
          client_status: number | null;
          response_class: string | null;
        }>(
          `SELECT operation_id, status, provider_status, client_status, response_class
             FROM cinatoken_shard_provider_response_attachments
            ORDER BY operation_id`,
        )
        .toArray(),
    );
    expect(rows).toEqual([
      {
        operation_id: ambiguous.operation_id,
        status: "ambiguous",
        provider_status: null,
        client_status: null,
        response_class: null,
      },
      {
        operation_id: http202.operation_id,
        status: "interpreted_reject",
        provider_status: 202,
        client_status: 202,
        response_class: "http_error",
      },
      {
        operation_id: invalidBody.operation_id,
        status: "interpreted_reject",
        provider_status: 200,
        client_status: 500,
        response_class: "invalid_body",
      },
      {
        operation_id: typed.operation_id,
        status: "interpreted_reject",
        provider_status: 200,
        client_status: 200,
        response_class: "typed_error",
      },
    ]);
  });

  it("binds an optional success receipt to the exact completed result body", async () => {
    const stub = ledgerStub("provider-response-success-receipt");
    const operation = operationEnvelope("provider-response-success-receipt", {
      operation_kind: "chat_completion",
    });
    await dispatchVersionedProviderAttempt(stub, operation);
    const result = operationResult(operation);
    const receiptSha256 = sha256("b");
    await expect(
      stub.recordProviderUsageResultOutcome(
        operation.operation_id,
        1,
        result,
        1,
        receiptSha256,
        BASE_NOW + 3,
      ),
    ).resolves.toMatchObject({ ok: true, result: "recorded" });
    const attachment = successAttachment(operation, "cd", {
      raw_manifest: providerEvidenceManifest(operation, "c", result.sha256),
      client_manifest: clientArtifactManifest(operation, "d", result.sha256, {
        size: result.size,
      }),
      provider_usage_receipt_sha256: receiptSha256,
    });
    await expect(
      attachProviderResponse(
        stub,
        operation,
        { ...attachment, provider_usage_receipt_sha256: sha256("a") },
        BASE_NOW + 4,
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: "provider_response_attachment_conflict", status: 409 },
    });
    await expect(
      attachProviderResponse(stub, operation, attachment, BASE_NOW + 4),
    ).resolves.toMatchObject({
      ok: true,
      result: {
        kind: "attached",
        row: { provider_usage_receipt_sha256: receiptSha256 },
      },
    });
  });

  it("atomically starts the DO-owned attempt and safely cancels it before provider dispatch", async () => {
    const stub = ledgerStub("provider-attempt-do-owner");
    const operation = operationEnvelope("provider-attempt-do-owner", {
      operation_kind: "chat_completion",
      execution_deadline_at: BASE_NOW + 10,
    });
    await stub.claim(operation, sha256("1"), "dispatch-provider-do-owner", ledgerPolicy(), BASE_NOW);
    const starts = await Promise.all([
      stub.startOperationWithProviderAttemptOutcome(
        operation.operation_id,
        1,
        { maxAttempts: 1, retryEnabled: false },
        BASE_NOW + 1,
      ),
      stub.startOperationWithProviderAttemptOutcome(
        operation.operation_id,
        1,
        { maxAttempts: 1, retryEnabled: false },
        BASE_NOW + 1,
      ),
    ]);
    expect(starts.map((outcome) => (outcome.ok ? outcome.result.kind : "error")).sort()).toEqual([
      "existing",
      "prepared",
    ]);

    await expect(
      stub.expireOperation(operation.operation_id, 1, BASE_NOW + 11),
    ).resolves.toBe(true);
    await expect(stub.readOutcome(operation.operation_id)).resolves.toMatchObject({
      status: "failed",
      response_status: 504,
      response_code: "provider_attempt_not_dispatched",
    });
    const persisted = await runInDurableObject(stub, (_instance, state) => {
      const attempt = state.storage.sql
        .exec<{
          status: string;
          dispatched_at: number | null;
          terminal_at: number | null;
        }>(
          `SELECT status, dispatched_at, terminal_at
             FROM cinatoken_shard_provider_attempts
            WHERE operation_id = ?1 AND owner_generation = 1 AND attempt_generation = 1`,
          operation.operation_id,
        )
        .one();
      const retry = state.storage.sql
        .exec<{ state: string; active_attempt_generation: number | null }>(
          `SELECT state, active_attempt_generation
             FROM cinatoken_shard_provider_retry_state
            WHERE operation_id = ?1 AND owner_generation = 1`,
          operation.operation_id,
        )
        .one();
      const events = state.storage.sql
        .exec<{ event_sequence: number; from_status: string | null; to_status: string }>(
          `SELECT event_sequence, from_status, to_status
             FROM cinatoken_shard_provider_attempt_events
            WHERE operation_id = ?1 AND owner_generation = 1
            ORDER BY event_sequence`,
          operation.operation_id,
        )
        .toArray();
      let immutable = false;
      try {
        state.storage.sql.exec(
          `UPDATE cinatoken_shard_provider_attempt_events
              SET to_status = 'ambiguous'
            WHERE operation_id = ?1`,
          operation.operation_id,
        );
      } catch {
        immutable = true;
      }
      const statusAttempt = new RelayShardLedger(state.storage).readOperationStatusSnapshot(
        operationStatusQuery(operation),
      ).provider_attempt;
      return { attempt, retry, events, immutable, statusAttempt };
    });
    expect(persisted).toEqual({
      attempt: {
        status: "cancelled",
        dispatched_at: null,
        terminal_at: BASE_NOW + 11,
      },
      retry: { state: "terminal", active_attempt_generation: null },
      events: [
        { event_sequence: 1, from_status: null, to_status: "prepared" },
        { event_sequence: 2, from_status: "prepared", to_status: "cancelled" },
      ],
      immutable: true,
      statusAttempt: expect.objectContaining({
        attempt_generation: 1,
        status: "cancelled",
        dispatched_at: null,
        terminal_at: BASE_NOW + 11,
      }),
    });
  });

  it("allows a bounded retry only after a definite rejection", async () => {
    const stub = ledgerStub("provider-attempt-bounded-retry");
    const operation = operationEnvelope("provider-attempt-bounded-retry", {
      operation_kind: "chat_completion",
    });
    await stub.claim(operation, sha256("d"), "dispatch-provider-retry", ledgerPolicy(), BASE_NOW);
    await expect(
      stub.startOperationWithProviderAttemptOutcome(
        operation.operation_id,
        1,
        { maxAttempts: 2, retryEnabled: true },
        BASE_NOW + 1,
      ),
    ).resolves.toMatchObject({ ok: true, result: { kind: "prepared" } });
    await stub.dispatchProviderAttemptOutcome(operation.operation_id, 1, 1, BASE_NOW + 2);
    const rejection = {
      status: "definite_reject" as const,
      response_status: 429,
      response_code: "provider_rate_limited",
    };
    await expect(
      stub.recordProviderAttemptOutcome(operation.operation_id, 1, 1, rejection, BASE_NOW + 4),
    ).resolves.toMatchObject({ ok: true, result: { kind: "recorded" } });
    await expect(
      stub.recordProviderAttemptOutcome(operation.operation_id, 1, 1, rejection, BASE_NOW + 5),
    ).resolves.toMatchObject({ ok: true, result: { kind: "duplicate" } });
    await expect(
      stub.recordProviderAttemptOutcome(
        operation.operation_id,
        1,
        1,
        { status: "ambiguous", response_status: 202, response_code: "provider_unknown" },
        BASE_NOW + 6,
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: "provider_attempt_outcome_conflict", status: 409 },
    });
    await expect(
      stub.prepareProviderAttemptOutcome(operation.operation_id, 1, 2, BASE_NOW + 18),
    ).resolves.toEqual({
      ok: false,
      error: { code: "provider_retry_not_due", status: 409 },
    });
    await expect(
      stub.prepareProviderAttemptOutcome(operation.operation_id, 1, 2, BASE_NOW + 19),
    ).resolves.toMatchObject({
      ok: true,
      result: { kind: "prepared", row: { attempt_generation: 2 } },
    });
    await stub.dispatchProviderAttemptOutcome(operation.operation_id, 1, 2, BASE_NOW + 20);
    await stub.recordProviderAttemptOutcome(operation.operation_id, 1, 2, rejection, BASE_NOW + 21);
    await expect(
      stub.prepareProviderAttemptOutcome(operation.operation_id, 1, 2, BASE_NOW + 22),
    ).resolves.toEqual({
      ok: false,
      error: { code: "provider_attempt_limit_exhausted", status: 409 },
    });
  });

  it("moves an ambiguous provider attempt and its operation into recovery", async () => {
    const stub = ledgerStub("provider-attempt-ambiguous");
    const operation = operationEnvelope("provider-attempt-ambiguous", {
      operation_kind: "chat_completion",
    });
    await stub.claim(operation, sha256("e"), "dispatch-provider-ambiguous", ledgerPolicy(), BASE_NOW);
    await stub.startOperationWithProviderAttemptOutcome(
      operation.operation_id,
      1,
      { maxAttempts: 1, retryEnabled: false },
      BASE_NOW + 1,
    );
    await stub.dispatchProviderAttemptOutcome(operation.operation_id, 1, 1, BASE_NOW + 2);
    await expect(
      stub.recordProviderAttemptOutcome(
        operation.operation_id,
        1,
        1,
        {
          status: "ambiguous",
          response_status: 202,
          response_code: "provider_response_unknown",
        },
        BASE_NOW + 3,
      ),
    ).resolves.toMatchObject({
      ok: true,
      result: { kind: "recorded", row: { status: "ambiguous" } },
    });
    await expect(stub.readOutcome(operation.operation_id)).resolves.toMatchObject({
      status: "recovery_required",
      response_status: 202,
      response_code: "provider_response_unknown",
    });
    await expect(
      stub.prepareProviderAttemptOutcome(operation.operation_id, 1, 1, BASE_NOW + 4),
    ).resolves.toEqual({
      ok: false,
      error: { code: "provider_attempt_not_authorized", status: 409 },
    });
  });

  it("requires a durable result before a provider success can complete", async () => {
    const stub = ledgerStub("provider-attempt-success");
    const operation = operationEnvelope("provider-attempt-success", {
      operation_kind: "chat_completion",
    });
    const result = {
      object_key: `container-results/v1/${operation.operation_id}/1/${sha256("f")}`,
      object_version: "result-version-provider-attempt",
      sha256: sha256("f"),
      size: 256,
      content_type: "application/json",
    };
    const usageReceiptSha256 = sha256("c");
    const egressIdentity = {
      profile: "openai-chat-completions-canary-v1",
      worker_version_id: "worker-version-1",
    };
    await stub.claim(operation, sha256("f"), "dispatch-provider-success", ledgerPolicy(), BASE_NOW);
    await stub.startOperationWithProviderAttemptOutcome(
      operation.operation_id,
      1,
      { maxAttempts: 1, retryEnabled: false },
      BASE_NOW + 1,
    );
    await stub.dispatchProviderAttemptV2Outcome(
      operation.operation_id,
      1,
      1,
      egressIdentity,
      BASE_NOW + 2,
    );
    await expect(
      stub.recordProviderAttemptOutcome(
        operation.operation_id,
        1,
        1,
        { status: "succeeded", response_status: 200, response_code: null },
        BASE_NOW + 3,
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: "provider_attempt_result_conflict", status: 409 },
    });
    await expect(
      stub.recordStorageResultOutcome(operation.operation_id, 1, result, BASE_NOW + 4, 2),
    ).resolves.toEqual({
      ok: false,
      error: { code: "provider_usage_result_required", status: 409 },
    });
    await expect(
      stub.recordStorageResultOutcome(operation.operation_id, 1, result, BASE_NOW + 4, 1),
    ).resolves.toEqual({
      ok: false,
      error: { code: "provider_usage_result_required", status: 409 },
    });
    await expect(
      stub.recordStorageResultOutcome(operation.operation_id, 1, result, BASE_NOW + 4),
    ).resolves.toEqual({
      ok: false,
      error: { code: "provider_usage_result_required", status: 409 },
    });
    await expect(
      stub.recordProviderUsageResultOutcome(
        operation.operation_id,
        1,
        result,
        2,
        usageReceiptSha256,
        BASE_NOW + 4,
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: "provider_attempt_result_conflict", status: 409 },
    });
    await expect(
      stub.recordProviderUsageResultOutcome(
        operation.operation_id,
        1,
        result,
        1,
        usageReceiptSha256,
        BASE_NOW + 4,
      ),
    ).resolves.toMatchObject({ ok: true, result: "recorded" });
    await expect(
      stub.recordProviderUsageResultOutcome(
        operation.operation_id,
        1,
        result,
        1,
        usageReceiptSha256,
        BASE_NOW + 4,
      ),
    ).resolves.toMatchObject({ ok: true, result: "duplicate" });
    await expect(
      stub.recordProviderUsageResultOutcome(
        operation.operation_id,
        1,
        result,
        1,
        sha256("d"),
        BASE_NOW + 4,
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: "provider_usage_result_conflict", status: 409 },
    });
    await evictDurableObject(stub);
    await expect(stub.authorizeStorageOutcome(operation.operation_id, 1, BASE_NOW + 5)).resolves
      .toMatchObject({
        ok: true,
        grant: {
          result,
          provider_usage_receipt_sha256: usageReceiptSha256,
          provider_attempt: {
            status: "dispatched",
            provider_usage_receipt_sha256: usageReceiptSha256,
            provider_usage_receipt_attached_at: BASE_NOW + 4,
          },
        },
      });
    await expect(
      stub.recordProviderAttemptOutcome(
        operation.operation_id,
        1,
        1,
        { status: "succeeded", response_status: 200, response_code: null },
        BASE_NOW + 6,
      ),
    ).resolves.toMatchObject({ ok: true, result: { kind: "recorded" } });
    await expect(
      stub.finalizeOutcome(
        operation.operation_id,
        1,
        "running",
        "completed",
        200,
        null,
        BASE_NOW + 7,
        true,
      ),
    ).resolves.toMatchObject({ ok: true, result: { status: "completed" } });

    const legacyAck = terminalAck(operation, { result });
    await expect(acknowledgeTerminal(stub, legacyAck, BASE_NOW + 8)).resolves.toEqual({
      ok: false,
      error: { code: "terminal_ack_conflict", status: 409 },
    });
    const boundAck: TerminalAckRequestV2 = {
      ...legacyAck,
      provider_usage_binding: {
        attempt_generation: 1,
        receipt_sha256: usageReceiptSha256,
        result_sha256: result.sha256,
      },
    };
    await expect(
      acknowledgeTerminal(
        stub,
        {
          ...boundAck,
          provider_usage_binding: {
            ...boundAck.provider_usage_binding!,
            receipt_sha256: sha256("d"),
          },
        },
        BASE_NOW + 8,
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: "terminal_ack_conflict", status: 409 },
    });
    await expect(acknowledgeTerminal(stub, boundAck, BASE_NOW + 8)).resolves.toEqual({
      ok: true,
      result: { kind: "acknowledged", finalAck: true, acknowledgedAt: BASE_NOW + 8 },
    });
    await expect(acknowledgeTerminal(stub, boundAck, BASE_NOW + 9)).resolves.toEqual({
      ok: true,
      result: { kind: "duplicate", finalAck: true, acknowledgedAt: BASE_NOW + 8 },
    });
    const providerEvents = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{
          event_sequence: number;
          to_status: string;
          provider_usage_receipt_sha256: string | null;
        }>(
          `SELECT event_sequence, to_status, provider_usage_receipt_sha256
             FROM cinatoken_shard_provider_attempt_events
            WHERE operation_id = ?1 AND owner_generation = 1
            ORDER BY event_sequence`,
          operation.operation_id,
        )
        .toArray(),
    );
    expect(providerEvents).toEqual([
      {
        event_sequence: 1,
        to_status: "prepared",
        provider_usage_receipt_sha256: null,
      },
      {
        event_sequence: 2,
        to_status: "dispatched",
        provider_usage_receipt_sha256: null,
      },
      {
        event_sequence: 3,
        to_status: "succeeded",
        provider_usage_receipt_sha256: usageReceiptSha256,
      },
    ]);
  });

  it("reads claimed, running, and post-deadline terminal outcomes without ledger writes", async () => {
    const stub = ledgerStub("operation-status-read-only");
    const operation = operationEnvelope("operation-status", {
      operation_kind: "health_probe",
      execution_deadline_at: BASE_NOW + 10,
    });
    const query = operationStatusQuery(operation);
    await stub.claim(operation, sha256("f"), "dispatch-operation-status", ledgerPolicy(), BASE_NOW);

    const claimed = await runInDurableObject(stub, (_instance, state) => {
      const ledger = new RelayShardLedger(state.storage);
      return ledger.readOperationStatus(query);
    });
    expect(claimed.status).toBe("claimed");

    await stub.transition(
      operation.operation_id,
      operation.owner_generation,
      "claimed",
      "running",
      null,
      BASE_NOW + 1,
      true,
    );
    const running = await runInDurableObject(stub, (_instance, state) => {
      const ledger = new RelayShardLedger(state.storage);
      return ledger.readOperationStatus(query);
    });
    expect(running.status).toBe("running");

    await expect(
      stub.finalizeOutcome(
        operation.operation_id,
        operation.owner_generation,
        "running",
        "completed",
        200,
        null,
        BASE_NOW + 5,
        true,
      ),
    ).resolves.toMatchObject({ ok: true, result: { status: "completed" } });
    const observedAt = BASE_NOW + 11;
    expect(observedAt).toBeGreaterThan(operation.execution_deadline_at);

    const terminalRead = await runInDurableObject(stub, (_instance, state) => {
      const totalChanges = () =>
        state.storage.sql
          .exec<{ count: number }>("SELECT total_changes() AS count")
          .toArray()[0]?.count ?? -1;
      const before = totalChanges();
      const ledger = new RelayShardLedger(state.storage);
      const first = ledger.readOperationStatus(query);
      const replay = ledger.readOperationStatus(query);
      const after = totalChanges();
      return { before, after, first, replay };
    });
    expect(terminalRead.first).toEqual(terminalRead.replay);
    expect(terminalRead.first).toMatchObject({
      operation_id: operation.operation_id,
      owner_generation: operation.owner_generation,
      status: "completed",
      response_status: 200,
      trace_id: operation.trace_id,
    });
    expect(terminalRead.after).toBe(terminalRead.before);
  });

  it("fails closed when an operation status owner, shard fence, or trace does not match", async () => {
    const stub = ledgerStub("operation-status-authority");
    const operation = operationEnvelope("operation-status-authority");
    const query = operationStatusQuery(operation);
    await stub.claim(operation, sha256("e"), "dispatch-status-authority", ledgerPolicy(), BASE_NOW);

    const denied = await runInDurableObject(stub, (_instance, state) => {
      const ledger = new RelayShardLedger(state.storage);
      const attempt = (candidate: OperationStatusQuery) => {
        try {
          ledger.readOperationStatus(candidate);
          return { code: "unexpected_success", status: 200 };
        } catch (error) {
          return error instanceof ProtocolError
            ? { code: error.code, status: error.status }
            : { code: "unexpected_error", status: 500 };
        }
      };
      return [
        attempt({ ...query, owner_generation: query.owner_generation + 1 }),
        attempt({
          ...query,
          shard: {
            ...query.shard,
            shard_index: 4,
            instance_name: "cinatoken-relay-shard-v1-0004",
          },
        }),
        attempt({ ...query, trace_id: "trace-other-operation" }),
      ];
    });
    expect(denied).toEqual([
      { code: "operation_status_not_found", status: 404 },
      { code: "operation_status_not_found", status: 404 },
      { code: "operation_status_not_found", status: 404 },
    ]);
  });

  it("rejects a dispatch replay that targets a different operation", async () => {
    const stub = ledgerStub("dispatch-replay-conflict");
    const policy = ledgerPolicy();

    await expect(
      stub.claim(
        operationEnvelope("dispatch-first"),
        sha256("e"),
        "dispatch-shared",
        policy,
        BASE_NOW,
      ),
    ).resolves.toEqual({ kind: "new" });
    await expect(
      stub.claimOutcome(
        operationEnvelope("dispatch-second"),
        sha256("f"),
        "dispatch-shared",
        policy,
        BASE_NOW + 1,
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: "dispatch_replay_conflict", status: 409 },
    });

    await runInDurableObject(stub, (_instance, state) => {
      const operations = state.storage.sql
        .exec<{ operation_id: string }>(
          "SELECT operation_id FROM cinatoken_shard_operations ORDER BY operation_id",
        )
        .toArray();
      const dispatches = state.storage.sql
        .exec<{ dispatch_id: string; operation_id: string }>(
          "SELECT dispatch_id, operation_id FROM cinatoken_shard_dispatches",
        )
        .toArray();
      expect(operations).toEqual([{ operation_id: "dispatch-first" }]);
      expect(dispatches).toEqual([
        { dispatch_id: "dispatch-shared", operation_id: "dispatch-first" },
      ]);
    });
  });

  it("expires in-flight work as 504 and releases its capacity", async () => {
    const stub = ledgerStub("expired-in-flight");
    const policy = ledgerPolicy({ maxInFlight: 1 });

    await expect(
      stub.claim(
        operationEnvelope("expired-operation", {
          execution_deadline_at: BASE_NOW + 10,
        }),
        sha256("1"),
        "dispatch-expired",
        policy,
        BASE_NOW,
      ),
    ).resolves.toEqual({ kind: "new" });
    await expect(
      stub.claim(
        operationEnvelope("replacement-operation"),
        sha256("2"),
        "dispatch-replacement",
        policy,
        BASE_NOW + 11,
      ),
    ).resolves.toEqual({ kind: "new" });

    await runInDurableObject(stub, (_instance, state) => {
      const rows = state.storage.sql
        .exec<OperationSqlRow>(
          `SELECT operation_id, status, response_status, response_code, updated_at
             FROM cinatoken_shard_operations ORDER BY operation_id`,
        )
        .toArray();
      expect(rows).toEqual([
        {
          operation_id: "expired-operation",
          status: "failed",
          response_status: 504,
          response_code: "container_execution_deadline_expired",
          updated_at: BASE_NOW + 11,
        },
        {
          operation_id: "replacement-operation",
          status: "claimed",
          response_status: null,
          response_code: null,
          updated_at: BASE_NOW + 11,
        },
      ]);
    });
  });

  it("acks journal-disabled outcomes and retains them across age/count maintenance", async () => {
    const stub = ledgerStub("terminal-ack-retained");
    const operation = operationEnvelope("terminal-ack-retained");
    await stub.claim(operation, sha256("1"), "dispatch-terminal-ack", ledgerPolicy(), BASE_NOW);
    await stub.transition(
      operation.operation_id,
      operation.owner_generation,
      "claimed",
      "running",
      null,
      BASE_NOW + 1,
      true,
    );
    await stub.recordStorageResultOutcome(
      operation.operation_id,
      operation.owner_generation,
      operationResult(operation),
      BASE_NOW + 2,
    );
    await stub.finalizeOutcome(
      operation.operation_id,
      operation.owner_generation,
      "running",
      "completed",
      200,
      null,
      BASE_NOW + 3,
      true,
    );

    const ack = terminalAck(operation);
    await expect(acknowledgeTerminal(stub, ack, BASE_NOW + 4)).resolves.toEqual({
      ok: true,
      result: { kind: "acknowledged", finalAck: true, acknowledgedAt: BASE_NOW + 4 },
    });
    await expect(acknowledgeTerminal(stub, ack, BASE_NOW + 5)).resolves.toEqual({
      ok: true,
      result: { kind: "duplicate", finalAck: true, acknowledgedAt: BASE_NOW + 4 },
    });
    await expect(
      acknowledgeTerminal(
        stub,
        { ...ack, terminal_contract_sha256: sha256("a") },
        BASE_NOW + 6,
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: "terminal_ack_conflict", status: 409 },
    });

    await expect(
      stub.claim(
        operationEnvelope("terminal-ack-age-maintenance", {
          owner_lease_expires_at: BASE_NOW + 1_600,
          execution_deadline_at: BASE_NOW + 1_300,
        }),
        sha256("2"),
        "dispatch-terminal-ack-age-maintenance",
        ledgerPolicy({
          dispatchRetentionSeconds: 10,
          terminalRetentionSeconds: 30,
        }),
        BASE_NOW + 1_000,
      ),
    ).resolves.toEqual({ kind: "new" });
    await stub.transition(
      "terminal-ack-age-maintenance",
      1,
      "claimed",
      "completed",
      200,
      BASE_NOW + 1_001,
    );
    await expect(
      stub.claim(
        operationEnvelope("terminal-ack-count-maintenance", {
          owner_lease_expires_at: BASE_NOW + 1_600,
          execution_deadline_at: BASE_NOW + 1_300,
        }),
        sha256("3"),
        "dispatch-terminal-ack-count-maintenance",
        ledgerPolicy({
          dispatchRetentionSeconds: 10,
          terminalRetentionSeconds: 30,
          maxTerminalOperations: 1,
        }),
        BASE_NOW + 1_002,
      ),
    ).resolves.toEqual({ kind: "new" });
    await runInDurableObject(stub, (_instance, state) => {
      const operationRows = state.storage.sql
        .exec<{ operation_id: string }>(
          `SELECT operation_id FROM cinatoken_shard_operations
            WHERE operation_id IN (?1, ?2) ORDER BY operation_id`,
          operation.operation_id,
          "terminal-ack-age-maintenance",
        )
        .toArray();
      const ackRow = state.storage.sql
        .exec<{
          final_acked_at: number | null;
          compaction_authorized_at: number | null;
        }>(
          `SELECT final_acked_at, compaction_authorized_at
             FROM cinatoken_shard_terminal_acks
            WHERE operation_id = ?1 AND owner_generation = ?2`,
          operation.operation_id,
          operation.owner_generation,
        )
        .one();
      const retryCount = state.storage.sql
        .exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM cinatoken_shard_provider_retry_state
            WHERE operation_id = ?1 AND owner_generation = ?2`,
          operation.operation_id,
          operation.owner_generation,
        )
        .one().count;
      expect(operationRows).toEqual([
        { operation_id: "terminal-ack-age-maintenance" },
        { operation_id: operation.operation_id },
      ]);
      expect(ackRow).toEqual({
        final_acked_at: BASE_NOW + 4,
        compaction_authorized_at: null,
      });
      expect(retryCount).toBe(0);
    });
  });

  it("acks result-free health probes but requires the stored result for relay completion", async () => {
    const healthStub = ledgerStub("terminal-ack-health-probe");
    const healthOperation = operationEnvelope("terminal-ack-health-probe", {
      operation_kind: "health_probe",
    });
    await healthStub.claim(
      healthOperation,
      sha256("1"),
      "dispatch-terminal-ack-health-probe",
      ledgerPolicy(),
      BASE_NOW,
    );
    await healthStub.transition(
      healthOperation.operation_id,
      healthOperation.owner_generation,
      "claimed",
      "completed",
      200,
      BASE_NOW + 1,
    );
    await expect(
      acknowledgeTerminal(
        healthStub,
        terminalAck(healthOperation, { result: null }),
        BASE_NOW + 2,
      ),
    ).resolves.toEqual({
      ok: true,
      result: { kind: "acknowledged", finalAck: true, acknowledgedAt: BASE_NOW + 2 },
    });

    const relayStub = ledgerStub("terminal-ack-relay-result-required");
    const relayOperation = operationEnvelope("terminal-ack-relay-result-required");
    await relayStub.claim(
      relayOperation,
      sha256("2"),
      "dispatch-terminal-ack-relay-result-required",
      ledgerPolicy(),
      BASE_NOW,
    );
    await relayStub.transition(
      relayOperation.operation_id,
      relayOperation.owner_generation,
      "claimed",
      "completed",
      200,
      BASE_NOW + 1,
    );
    await expect(
      acknowledgeTerminal(
        relayStub,
        terminalAck(relayOperation, { result: null }),
        BASE_NOW + 2,
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: "terminal_ack_conflict", status: 409 },
    });
  });

  it("orders recovery revision 1 before a revision 2 final acknowledgement", async () => {
    const stub = ledgerStub("terminal-ack-two-phase");
    const operation = operationEnvelope("terminal-ack-two-phase");
    await stub.claim(operation, sha256("3"), "dispatch-terminal-recovery", ledgerPolicy(), BASE_NOW);
    await stub.transition(
      operation.operation_id,
      operation.owner_generation,
      "claimed",
      "running",
      null,
      BASE_NOW + 1,
      true,
    );
    const result = operationResult(operation);
    await stub.recordStorageResultOutcome(
      operation.operation_id,
      operation.owner_generation,
      result,
      BASE_NOW + 2,
    );
    await stub.finalizeOutcome(
      operation.operation_id,
      operation.owner_generation,
      "running",
      "recovery_required",
      202,
      "container_execution_ambiguous",
      BASE_NOW + 3,
      true,
    );

    const recovery = terminalAck(operation, {
      billing_event_id: sha256("4"),
      terminal_contract_sha256: sha256("5"),
      operation_status: "recovery_required",
      response_status: 202,
      response_code: "container_execution_ambiguous",
      result,
    });
    await expect(acknowledgeTerminal(stub, recovery, BASE_NOW + 4)).resolves.toEqual({
      ok: true,
      result: { kind: "acknowledged", finalAck: false, acknowledgedAt: null },
    });

    const resolution = terminalAck(operation, {
      billing_event_id: sha256("6"),
      terminal_contract_sha256: sha256("7"),
      reconciliation_revision: 2,
      predecessor_billing_event_id: recovery.billing_event_id,
      operation_from_status: "recovery_required",
      operation_status: "completed",
      response_status: 200,
      response_code: null,
      result,
    });
    await expect(
      acknowledgeTerminal(
        stub,
        { ...resolution, predecessor_billing_event_id: sha256("8") },
        BASE_NOW + 5,
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: "terminal_ack_conflict", status: 409 },
    });
    await expect(acknowledgeTerminal(stub, resolution, BASE_NOW + 6)).resolves.toEqual({
      ok: true,
      result: { kind: "acknowledged", finalAck: true, acknowledgedAt: BASE_NOW + 6 },
    });
    await expect(acknowledgeTerminal(stub, recovery, BASE_NOW + 7)).resolves.toEqual({
      ok: true,
      result: { kind: "duplicate", finalAck: false, acknowledgedAt: null },
    });
    await expect(acknowledgeTerminal(stub, resolution, BASE_NOW + 8)).resolves.toEqual({
      ok: true,
      result: { kind: "duplicate", finalAck: true, acknowledgedAt: BASE_NOW + 6 },
    });
    await runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql
        .exec<{
          status: string;
          billing_event_id: string;
          predecessor_billing_event_id: string;
          final_acked_at: number;
          compaction_authorized_at: number | null;
        }>(
          `SELECT operation.status, ack.billing_event_id,
                  ack.predecessor_billing_event_id,
                  ack.final_acked_at,
                  ack.compaction_authorized_at
             FROM cinatoken_shard_operations AS operation
             JOIN cinatoken_shard_terminal_acks AS ack
               ON ack.operation_id = operation.operation_id
              AND ack.owner_generation = operation.owner_generation
            WHERE operation.operation_id = ?1`,
          operation.operation_id,
        )
        .one();
      expect(row).toEqual({
        status: "recovery_required",
        billing_event_id: resolution.billing_event_id,
        predecessor_billing_event_id: recovery.billing_event_id,
        final_acked_at: BASE_NOW + 6,
        compaction_authorized_at: null,
      });
    });
  });

  it("adds the terminal-ack table to an old schema and preserves it across eviction", async () => {
    const stub = ledgerStub("terminal-ack-schema-upgrade");
    const expectedColumns = [
      "operation_id",
      "owner_generation",
      "billing_event_id",
      "terminal_contract_sha256",
      "reconciliation_id",
      "reconciliation_revision",
      "predecessor_billing_event_id",
      "ack_payload_json",
      "recovery_payload_json",
      "final_acked_at",
      "compaction_authorized_at",
    ];
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("DROP TABLE cinatoken_shard_terminal_acks");
      new RelayShardLedger(state.storage).ensureSchema();
      const columns = state.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(cinatoken_shard_terminal_acks)")
        .toArray()
        .map(({ name }) => name);
      expect(expectedColumns.every((name) => columns.includes(name))).toBe(true);
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, (_instance, state) => {
      const columns = state.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(cinatoken_shard_terminal_acks)")
        .toArray()
        .map(({ name }) => name);
      expect(expectedColumns.every((name) => columns.includes(name))).toBe(true);
    });
  });

  it("compacts terminal operations by age and maximum row count", async () => {
    const stub = ledgerStub("terminal-compaction");
    const seedPolicy = ledgerPolicy({
      maxInFlight: 8,
      dispatchRetentionSeconds: 1_000,
      terminalRetentionSeconds: 1_000,
      maxTerminalOperations: 100,
    });
    const terminalOperations = [
      { id: "expired-by-time", hash: "3", updatedAt: BASE_NOW + 69 },
      { id: "removed-by-cap", hash: "4", updatedAt: BASE_NOW + 70 },
      { id: "newest-a", hash: "5", updatedAt: BASE_NOW + 80 },
      { id: "newest-b", hash: "6", updatedAt: BASE_NOW + 90 },
    ];

    for (const operation of terminalOperations) {
      await stub.claim(
        operationEnvelope(operation.id),
        sha256(operation.hash),
        `dispatch-${operation.id}`,
        seedPolicy,
        BASE_NOW,
      );
      await stub.transition(
        operation.id,
        1,
        "claimed",
        "completed",
        200,
        operation.updatedAt,
      );
    }
    await authorizeTerminalCompactionForTest(
      stub,
      terminalOperations.map(({ id }) => id),
      BASE_NOW + 95,
    );

    await expect(
      stub.claim(
        operationEnvelope("maintenance-trigger"),
        sha256("7"),
        "dispatch-maintenance-trigger",
        ledgerPolicy({
          maxInFlight: 8,
          dispatchRetentionSeconds: 10,
          terminalRetentionSeconds: 30,
          maxTerminalOperations: 2,
          globalTerminalCompactionEnabled: true,
        }),
        BASE_NOW + 100,
      ),
    ).resolves.toEqual({ kind: "new" });

    await runInDurableObject(stub, (_instance, state) => {
      const terminalRows = state.storage.sql
        .exec<OperationSqlRow>(
          `SELECT operation_id, status, response_status, updated_at
             FROM cinatoken_shard_operations
            WHERE status IN ('completed', 'failed')
            ORDER BY updated_at`,
        )
        .toArray();
      expect(terminalRows).toEqual([
        {
          operation_id: "newest-a",
          status: "completed",
          response_status: 200,
          updated_at: BASE_NOW + 80,
        },
        {
          operation_id: "newest-b",
          status: "completed",
          response_status: 200,
          updated_at: BASE_NOW + 90,
        },
      ]);
    });
  });

  it("preserves replay-protected terminal rows and backpressures until compaction is safe", async () => {
    const stub = ledgerStub("replay-protected-capacity");
    const policy = ledgerPolicy({
      maxInFlight: 1,
      dispatchRetentionSeconds: 60,
      terminalRetentionSeconds: 300,
      maxTerminalOperations: 2,
      globalTerminalCompactionEnabled: true,
    });

    for (let index = 0; index < 3; index += 1) {
      const operationId = `protected-${index}`;
      await expect(
        stub.claim(
          operationEnvelope(operationId),
          sha256((index + 10).toString(16)),
          `dispatch-${operationId}`,
          policy,
          BASE_NOW + index * 2,
        ),
      ).resolves.toEqual({ kind: "new" });
      await stub.transition(
        operationId,
        1,
        "claimed",
        "completed",
        200,
        BASE_NOW + index * 2 + 1,
      );
    }

    await expect(
      stub.claim(
        operationEnvelope("protected-overflow"),
        sha256("d"),
        "dispatch-protected-overflow",
        policy,
        BASE_NOW + 6,
      ),
    ).resolves.toEqual({ kind: "capacity" });
    await expect(
      stub.claim(
        operationEnvelope("protected-0"),
        sha256("a"),
        "dispatch-protected-0",
        policy,
        BASE_NOW + 7,
      ),
    ).resolves.toMatchObject({ kind: "existing", row: { status: "completed" } });
    await authorizeTerminalCompactionForTest(
      stub,
      ["protected-0", "protected-1", "protected-2"],
      BASE_NOW + 8,
    );

    await expect(
      stub.claim(
        operationEnvelope("protected-after-window"),
        sha256("e"),
        "dispatch-protected-after-window",
        policy,
        BASE_NOW + 70,
      ),
    ).resolves.toEqual({ kind: "new" });
    await runInDurableObject(stub, (_instance, state) => {
      const operationIds = state.storage.sql
        .exec<{ operation_id: string }>(
          "SELECT operation_id FROM cinatoken_shard_operations ORDER BY operation_id",
        )
        .toArray()
        .map(({ operation_id }) => operation_id);
      expect(operationIds).toEqual([
        "protected-1",
        "protected-2",
        "protected-after-window",
      ]);
    });
  });

  it("keeps an old terminal operation while a refreshed dispatch is replay-protected", async () => {
    const stub = ledgerStub("refreshed-dispatch-protection");
    const policy = ledgerPolicy({
      dispatchRetentionSeconds: 60,
      terminalRetentionSeconds: 60,
    });
    const envelope = operationEnvelope("refreshed-operation");
    const envelopeSha256 = sha256("f");

    await stub.claim(envelope, envelopeSha256, "dispatch-original", policy, BASE_NOW);
    await stub.transition(
      envelope.operation_id,
      1,
      "claimed",
      "completed",
      200,
      BASE_NOW + 1,
    );
    await expect(
      stub.claim(
        envelope,
        envelopeSha256,
        "dispatch-refreshed",
        policy,
        BASE_NOW + 50,
      ),
    ).resolves.toMatchObject({ kind: "existing", row: { status: "completed" } });

    await stub.claim(
      operationEnvelope("refreshed-maintenance-trigger"),
      sha256("1"),
      "dispatch-refreshed-maintenance",
      policy,
      BASE_NOW + 70,
    );
    await expect(
      stub.claim(
        envelope,
        envelopeSha256,
        "dispatch-refreshed",
        policy,
        BASE_NOW + 71,
      ),
    ).resolves.toMatchObject({ kind: "existing", row: { status: "completed" } });
  });

  it("moves an expired running operation to recovery instead of definite failure", async () => {
    const stub = ledgerStub("late-completion-cas");
    const policy = ledgerPolicy({ maxInFlight: 1 });
    const envelope = operationEnvelope("late-completion", {
      execution_deadline_at: BASE_NOW + 10,
    });

    await stub.claim(envelope, sha256("2"), "dispatch-late", policy, BASE_NOW);
    await expect(
      stub.transition("late-completion", 1, "claimed", "running", null, BASE_NOW, true),
    ).resolves.toBe(true);
    await stub.claim(
      operationEnvelope("late-completion-trigger"),
      sha256("3"),
      "dispatch-late-trigger",
      policy,
      BASE_NOW + 11,
    );
    await expect(
      stub.transition(
        "late-completion",
        1,
        "running",
        "completed",
        200,
        BASE_NOW + 12,
        true,
      ),
    ).resolves.toBe(false);

    await runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql
        .exec<OperationSqlRow>(
          `SELECT operation_id, status, response_status, response_code, updated_at
             FROM cinatoken_shard_operations WHERE operation_id = 'late-completion'`,
        )
        .one();
      expect(row).toEqual({
        operation_id: "late-completion",
        status: "recovery_required",
        response_status: 202,
        response_code: "container_execution_ambiguous",
        updated_at: BASE_NOW + 11,
      });
    });
  });

  it("migrates legacy capacity rejections into bounded failed terminal rows", async () => {
    const stub = ledgerStub("legacy-capacity-migration");
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO cinatoken_shard_operations
           (operation_id, owner_generation, provider_operation_id, envelope_sha256, dispatch_id,
            status, response_status, deadline_at, created_at, updated_at)
         VALUES ('legacy-capacity', 1, 'provider-legacy', ?1, 'dispatch-legacy',
                 'capacity_rejected', 503, ?2, ?3, ?3)`,
        sha256("4"),
        BASE_NOW + 300,
        BASE_NOW,
      );
      state.storage.sql.exec(
        `INSERT INTO cinatoken_shard_dispatches
           (dispatch_id, operation_id, envelope_sha256, created_at)
         VALUES ('dispatch-legacy', 'legacy-capacity', ?1, ?2)`,
        sha256("4"),
        BASE_NOW,
      );
    });
    await evictDurableObject(stub);
    await stub.claim(
      operationEnvelope("legacy-migration-trigger"),
      sha256("5"),
      "dispatch-legacy-trigger",
      ledgerPolicy(),
      BASE_NOW + 1,
    );

    await runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql
        .exec<OperationSqlRow>(
          `SELECT operation_id, status, response_status, updated_at
             FROM cinatoken_shard_operations WHERE operation_id = 'legacy-capacity'`,
        )
        .one();
      expect(row).toEqual({
        operation_id: "legacy-capacity",
        status: "failed",
        response_status: 503,
        updated_at: BASE_NOW,
      });
    });
  });

  it("preserves operation and lifecycle state after Durable Object eviction", async () => {
    const stub = ledgerStub("eviction-persistence");
    const envelope = operationEnvelope("persistent-operation");
    const envelopeSha256 = sha256("8");
    const policy = ledgerPolicy();

    await stub.claim(envelope, envelopeSha256, "dispatch-persistent", policy, BASE_NOW);
    await stub.transition(
      envelope.operation_id,
      1,
      "claimed",
      "completed",
      201,
      BASE_NOW + 1,
    );
    await stub.lifecycle("running", "container-123", BASE_NOW + 2);
    await evictDurableObject(stub);

    await expect(
      stub.claim(
        envelope,
        envelopeSha256,
        "dispatch-persistent",
        policy,
        BASE_NOW + 3,
      ),
    ).resolves.toMatchObject({
      kind: "existing",
      row: {
        operation_id: envelope.operation_id,
        status: "completed",
        response_status: 201,
      },
    });
    await runInDurableObject(stub, (_instance, state) => {
      const operation = state.storage.sql
        .exec<OperationSqlRow>(
          `SELECT operation_id, status, response_status, updated_at
             FROM cinatoken_shard_operations WHERE operation_id = ?1`,
          envelope.operation_id,
        )
        .one();
      const lifecycle = state.storage.sql
        .exec<LifecycleSqlRow>(
          `SELECT lifecycle_state, lifecycle_detail, updated_at
             FROM cinatoken_shard_state WHERE singleton = 1`,
        )
        .one();
      expect(operation).toEqual({
        operation_id: envelope.operation_id,
        status: "completed",
        response_status: 201,
        updated_at: BASE_NOW + 1,
      });
      expect(lifecycle).toEqual({
        lifecycle_state: "running",
        lifecycle_detail: "container-123",
        updated_at: BASE_NOW + 2,
      });
    });
  });

  it("keeps ledger-only readiness inspection side-effect free", async () => {
    const stub = ledgerStub("readiness-ledger-only");
    await expect(
      stub.readinessSnapshot(operationEnvelope("readiness-ledger").shard, BASE_NOW),
    ).resolves.toEqual({
      initialized: false,
      lifecycle_state: null,
      lifecycle_detail: null,
      lifecycle_updated_at: null,
      active_in_flight_operations: 0,
      expired_in_flight_operations: 0,
      terminal_operations: 0,
      readiness: {
        generation: 0,
        phase: "idle",
        last_probe_id: null,
        started_at_ms: null,
        deadline_at_ms: null,
        completed_at_ms: null,
        result_code: null,
        container_status: null,
        container_last_change_ms: null,
        container_exit_code: null,
        runtime_protocol_version: null,
        runtime_contract_version: null,
        runtime_execution_enabled: null,
        last_ready_at_ms: null,
      },
    });
  });

  it("serializes live readiness generations, rejects replay, and CAS-protects completion", async () => {
    const stub = ledgerStub("readiness-generation-cas");
    const shard = operationEnvelope("readiness-generation").shard;
    const nowMs = BASE_NOW * 1_000;
    await stub.initializeReadiness(shard, BASE_NOW);
    await expect(
      stub.beginReadinessOutcome(shard, "probe-1", nowMs, nowMs + 10_000, 5_000),
    ).resolves.toEqual({ ok: true, generation: 1 });
    await expect(
      stub.beginReadinessOutcome(shard, "probe-2", nowMs + 1, nowMs + 10_001, 5_000),
    ).resolves.toEqual({
      ok: false,
      error: { code: "readiness_probe_in_progress", status: 409 },
    });
    await expect(
      stub.completeReadiness(1, nowMs + 100, readinessCompletion("process_ready", true)),
    ).resolves.toBe(true);
    await expect(
      stub.completeReadiness(1, nowMs + 101, readinessCompletion("stale")),
    ).resolves.toBe(false);
    await expect(
      stub.beginReadinessOutcome(shard, "probe-1", nowMs + 5_100, nowMs + 15_100, 5_000),
    ).resolves.toEqual({
      ok: false,
      error: { code: "readiness_probe_replay", status: 409 },
    });
    await expect(
      stub.beginReadinessOutcome(shard, "probe-3", nowMs + 4_999, nowMs + 14_999, 5_000),
    ).resolves.toEqual({
      ok: false,
      error: { code: "readiness_probe_cooldown", status: 429 },
    });
    await expect(
      stub.beginReadinessOutcome(shard, "probe-4", nowMs + 5_100, nowMs + 15_100, 5_000),
    ).resolves.toEqual({ ok: true, generation: 2 });
  });

  it("rejects new claims while draining and advances readiness fences only when drained", async () => {
    const stub = ledgerStub("readiness-fence-and-drain");
    const policy = ledgerPolicy();
    const oldShard = operationEnvelope("old-ring").shard;
    await stub.claim(operationEnvelope("old-ring"), sha256("a"), "dispatch-old", policy, BASE_NOW);
    await stub.lifecycle("draining", null, BASE_NOW + 1);
    await expect(
      stub.beginReadinessOutcome(
        oldShard,
        "probe-during-drain",
        (BASE_NOW + 1) * 1_000,
        (BASE_NOW + 11) * 1_000,
        5_000,
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: "shard_draining", status: 503 },
    });
    await expect(
      stub.claimOutcome(
        operationEnvelope("old-ring"),
        sha256("a"),
        "dispatch-old",
        policy,
        BASE_NOW + 2,
      ),
    ).resolves.toMatchObject({ ok: true, result: { kind: "existing" } });
    await expect(
      stub.claimOutcome(
        operationEnvelope("blocked-during-drain"),
        sha256("b"),
        "dispatch-blocked",
        policy,
        BASE_NOW + 2,
      ),
    ).resolves.toEqual({ ok: false, error: { code: "shard_draining", status: 503 } });
    const newShard = { ...oldShard, ring_generation: 2, shard_count: 16 };
    await expect(stub.initializeReadinessOutcome(newShard, BASE_NOW + 3)).resolves.toEqual({
      ok: false,
      error: { code: "ring_generation_in_flight", status: 409 },
    });
    await stub.transition("old-ring", 1, "claimed", "completed", 200, BASE_NOW + 4);
    await expect(stub.initializeReadinessOutcome(newShard, BASE_NOW + 5)).resolves.toEqual({
      ok: true,
    });
    await expect(stub.readinessSnapshot(newShard, BASE_NOW + 5)).resolves.toMatchObject({
      initialized: true,
      lifecycle_state: "draining",
    });
  });

  it("fences shared-storage access by running owner generation and persists result identity", async () => {
    const stub = ledgerStub("storage-owner-fence");
    const operation = operationEnvelope("storage-operation", {
      operation_kind: "chat_completion",
      input: {
        mode: "r2",
        sha256: sha256("c"),
        size: 4096,
        content_type: "application/json",
        request_object_key: `container-inputs/v1/${sha256("c")}`,
        object_version: "input-version-1",
      },
    });
    const result = {
      object_key: `container-results/v1/${operation.operation_id}/1/${sha256("d")}`,
      object_version: "result-version-1",
      sha256: sha256("d"),
      size: 8192,
      content_type: "application/json",
    };

    await stub.claim(operation, sha256("e"), "dispatch-storage", ledgerPolicy(), BASE_NOW);
    await expect(
      stub.authorizeStorageOutcome(operation.operation_id, 1, BASE_NOW),
    ).resolves.toEqual({
      ok: false,
      error: { code: "storage_access_denied", status: 403 },
    });
    await stub.transition(operation.operation_id, 1, "claimed", "running", null, BASE_NOW, true);
    await expect(
      stub.authorizeStorageOutcome(operation.operation_id, 2, BASE_NOW + 1),
    ).resolves.toEqual({
      ok: false,
      error: { code: "storage_access_denied", status: 403 },
    });
    await expect(
      stub.authorizeStorageOutcome(operation.operation_id, 1, BASE_NOW + 1),
    ).resolves.toMatchObject({
      ok: true,
      grant: {
        protocol_version: operation.protocol_version,
        operation_id: operation.operation_id,
        owner_generation: 1,
        owner_lease_expires_at: operation.owner_lease_expires_at,
        operation_kind: "chat_completion",
        provider_operation_id: operation.provider_operation_id,
        admission_sha256: operation.admission_sha256,
        deadline_at: operation.execution_deadline_at,
        input: operation.input,
        shard: operation.shard,
        trace_id: operation.trace_id,
        result: null,
      },
    });
    await expect(
      stub.recordStorageResultOutcome(
        operation.operation_id,
        1,
        { ...result, object_version: "v".repeat(129) },
        BASE_NOW + 2,
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: "invalid_storage_result", status: 400 },
    });
    await expect(
      stub.recordStorageResultOutcome(operation.operation_id, 1, result, BASE_NOW + 2),
    ).resolves.toEqual({ ok: true, result: "recorded" });
    await expect(
      stub.recordStorageResultOutcome(operation.operation_id, 1, result, BASE_NOW + 3),
    ).resolves.toEqual({ ok: true, result: "duplicate" });
    await expect(
      stub.recordStorageResultOutcome(
        operation.operation_id,
        1,
        { ...result, content_type: "application/octet-stream" },
        BASE_NOW + 4,
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: "storage_result_conflict", status: 409 },
    });

    await evictDurableObject(stub);
    await expect(
      stub.authorizeStorageOutcome(operation.operation_id, 1, BASE_NOW + 5),
    ).resolves.toMatchObject({ ok: true, grant: { result } });
    await expect(
      stub.finalizeOutcome(
        operation.operation_id,
        1,
        "running",
        "completed",
        200,
        null,
        BASE_NOW + 6,
        true,
      ),
    ).resolves.toMatchObject({
      ok: true,
      result: {
        operation_id: operation.operation_id,
        operation_kind: "chat_completion",
        trace_id: operation.trace_id,
        status: "completed",
        response_status: 200,
        response_code: null,
        result_object_key: result.object_key,
        result_object_version: result.object_version,
        result_sha256: result.sha256,
        result_size: result.size,
        result_content_type: result.content_type,
      },
    });
    await evictDurableObject(stub);
    await expect(stub.readOutcome(operation.operation_id)).resolves.toMatchObject({
      trace_id: operation.trace_id,
      status: "completed",
      result_object_version: result.object_version,
    });
    await expect(
      stub.authorizeStorageOutcome(operation.operation_id, 1, BASE_NOW + 7),
    ).resolves.toEqual({
      ok: false,
      error: { code: "storage_access_denied", status: 403 },
    });
  });

  it("refuses to complete a relay operation before its durable result is attached", async () => {
    const stub = ledgerStub("result-required-before-completion");
    const operation = operationEnvelope("result-required", {
      operation_kind: "chat_completion",
    });
    await stub.claim(operation, sha256("f"), "dispatch-result-required", ledgerPolicy(), BASE_NOW);
    await stub.transition(operation.operation_id, 1, "claimed", "running", null, BASE_NOW, true);
    await expect(
      stub.finalizeOutcome(
        operation.operation_id,
        1,
        "running",
        "completed",
        200,
        null,
        BASE_NOW + 1,
        true,
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: "operation_result_required", status: 409 },
    });
    await expect(stub.readOutcome(operation.operation_id)).resolves.toMatchObject({
      status: "running",
      response_status: null,
      result_object_key: null,
    });
  });

  it("upgrades a schema-2 Durable Object to immutable response attachments", async () => {
    const stub = ledgerStub("provider-response-schema-upgrade");
    await stub.listUnarmedOperationRecoveryIntents();
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "DROP TRIGGER cinatoken_shard_schema_migration_update_guard",
      );
      state.storage.sql.exec(
        "DROP TRIGGER cinatoken_shard_schema_migration_delete_guard",
      );
      state.storage.sql.exec(
        "DELETE FROM cinatoken_shard_schema_migrations WHERE schema_version = 3",
      );
      state.storage.sql.exec(
        "DROP TABLE cinatoken_shard_provider_response_attachment_identities",
      );
      state.storage.sql.exec(
        "DROP TABLE cinatoken_shard_provider_response_attachments",
      );
    });

    await evictDurableObject(stub);
    await expect(stub.listUnarmedOperationRecoveryIntents()).resolves.toEqual([]);
    const upgraded = await runInDurableObject(stub, (_instance, state) => {
      const migrations = state.storage.sql
        .exec<{ schema_version: number; migration_name: string }>(
          `SELECT schema_version, migration_name
             FROM cinatoken_shard_schema_migrations
            ORDER BY schema_version`,
        )
        .toArray();
      const tables = state.storage.sql
        .exec<{ name: string }>(
          `SELECT name FROM sqlite_master
            WHERE type = 'table'
              AND name LIKE 'cinatoken_shard_provider_response_attachment%'
            ORDER BY name`,
        )
        .toArray();
      return { migrations, tables };
    });
    expect(upgraded).toEqual({
      migrations: [
        { schema_version: 1, migration_name: "0001_legacy_schema_observed" },
        {
          schema_version: 2,
          migration_name: "0002_operation_deadline_alarm_intent_v1",
        },
        {
          schema_version: 3,
          migration_name: "0003_provider_response_artifact_attachment_v1",
        },
      ],
      tables: [
        { name: "cinatoken_shard_provider_response_attachment_identities" },
        { name: "cinatoken_shard_provider_response_attachments" },
      ],
    });
  });

  it("records an immutable local schema migration ledger", async () => {
    const stub = ledgerStub("operation-recovery-schema-ledger");
    await stub.listUnarmedOperationRecoveryIntents();
    const result = await runInDurableObject(stub, (_instance, state) => {
      const rows = state.storage.sql
        .exec<{ schema_version: number; migration_name: string }>(
          `SELECT schema_version, migration_name
             FROM cinatoken_shard_schema_migrations
            ORDER BY schema_version ASC`,
        )
        .toArray();
      let updateRejected = false;
      let deleteRejected = false;
      let futureSchemaRejected = false;
      try {
        state.storage.sql.exec(
          `UPDATE cinatoken_shard_schema_migrations
              SET migration_name = migration_name
            WHERE schema_version = 2`,
        );
      } catch {
        updateRejected = true;
      }
      try {
        state.storage.sql.exec(
          "DELETE FROM cinatoken_shard_schema_migrations WHERE schema_version = 3",
        );
      } catch {
        deleteRejected = true;
      }
      state.storage.sql.exec(
        `INSERT INTO cinatoken_shard_schema_migrations
           (schema_version, migration_name, applied_at)
         VALUES (4, '0004_future_schema', ?1)`,
        BASE_NOW,
      );
      try {
        new RelayShardLedger(state.storage).ensureSchema();
      } catch (error) {
        futureSchemaRejected =
          error instanceof ProtocolError &&
          error.code === "shard_schema_migration_conflict";
      }
      return { rows, updateRejected, deleteRejected, futureSchemaRejected };
    });

    expect(result).toEqual({
      rows: [
        { schema_version: 1, migration_name: "0001_legacy_schema_observed" },
        {
          schema_version: 2,
          migration_name: "0002_operation_deadline_alarm_intent_v1",
        },
        {
          schema_version: 3,
          migration_name: "0003_provider_response_artifact_attachment_v1",
        },
      ],
      updateRejected: true,
      deleteRejected: true,
      futureSchemaRejected: true,
    });
  });

  it("atomically persists an unarmed recovery intent before scheduling and survives eviction", async () => {
    const stub = ledgerStub("operation-recovery-crash-gap");
    const operation = operationEnvelope("operation-recovery-crash-gap");

    await expect(
      stub.claimWithRecoveryIntent(
        operation,
        sha256("a"),
        "dispatch-operation-recovery-crash-gap",
        ledgerPolicy(),
        BASE_NOW,
      ),
    ).resolves.toEqual({ kind: "new" });
    const intent = await stub.readOperationRecoveryIntent(operation.operation_id, 1);
    expect(intent).toMatchObject({
      payload_version: 1,
      intent_kind: "operation_deadline",
      operation_id: operation.operation_id,
      owner_generation: 1,
      deadline_at: operation.execution_deadline_at,
      delivery_generation: 1,
      delivery_count: 0,
      state: "pending",
      armed_at: null,
      next_delivery_at: operation.execution_deadline_at + 1,
      last_error_code: null,
      shard_contract_version: 1,
      ring_generation: 1,
      shard_count: 8,
      shard_index: 3,
      instance_name: "cinatoken-relay-shard-v1-0003",
    });

    await evictDurableObject(stub);
    await expect(stub.listUnarmedOperationRecoveryIntents()).resolves.toHaveLength(1);
    const payload = operationRecoveryIntentPayload(intent!);
    await expect(
      stub.markOperationRecoveryIntentArmed(payload, BASE_NOW + 1),
    ).resolves.toBe(true);
    await evictDurableObject(stub);
    await expect(
      stub.readOperationRecoveryIntent(operation.operation_id, 1),
    ).resolves.toMatchObject({ state: "pending", armed_at: BASE_NOW + 1 });
    const guards = await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("PRAGMA recursive_triggers = OFF");
      let deleteRejected = false;
      let replaceRejected = false;
      let generationNineRejected = false;
      let generationGapRejected = false;
      try {
        state.storage.sql.exec(
          "DELETE FROM cinatoken_shard_alarm_intents WHERE operation_id = ?1",
          operation.operation_id,
        );
      } catch {
        deleteRejected = true;
      }
      try {
        state.storage.sql.exec(
          `INSERT OR REPLACE INTO cinatoken_shard_alarm_intents
           SELECT * FROM cinatoken_shard_alarm_intents WHERE operation_id = ?1`,
          operation.operation_id,
        );
      } catch {
        replaceRejected = true;
      }
      const insertInvalidIntent = (
        operationId: string,
        deliveryGeneration: number,
        deliveryCount: number,
      ) =>
        state.storage.sql.exec(
          `INSERT INTO cinatoken_shard_alarm_intents
             (operation_id, owner_generation, payload_version, intent_kind, deadline_at,
              delivery_generation, delivery_count, state, armed_at, next_delivery_at,
              last_error_code, shard_contract_version, ring_generation, shard_count,
              shard_index, instance_name, created_at, updated_at)
           VALUES (?1, 1, 1, 'operation_deadline', ?2, ?3, ?4, 'pending', NULL, ?5,
                   NULL, 1, 1, 8, 3, 'cinatoken-relay-shard-v1-0003', ?6, ?6)`,
          operationId,
          BASE_NOW + 300,
          deliveryGeneration,
          deliveryCount,
          BASE_NOW + 301,
          BASE_NOW,
        );
      try {
        insertInvalidIntent("invalid-generation-nine", 9, 8);
      } catch {
        generationNineRejected = true;
      }
      try {
        insertInvalidIntent("invalid-generation-gap", 2, 0);
      } catch {
        generationGapRejected = true;
      }
      const beforeCleanup = state.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM cinatoken_shard_alarm_intents WHERE operation_id = ?1",
          operation.operation_id,
        )
        .toArray()[0]?.count;
      state.storage.sql.exec(
        "DELETE FROM cinatoken_shard_operations WHERE operation_id = ?1",
        operation.operation_id,
      );
      const afterCleanup = state.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM cinatoken_shard_alarm_intents WHERE operation_id = ?1",
          operation.operation_id,
        )
        .toArray()[0]?.count;
      return {
        deleteRejected,
        replaceRejected,
        generationNineRejected,
        generationGapRejected,
        beforeCleanup,
        afterCleanup,
      };
    });
    expect(guards).toEqual({
      deleteRejected: true,
      replaceRejected: true,
      generationNineRejected: true,
      generationGapRejected: true,
      beforeCleanup: 1,
      afterCleanup: 0,
    });
  });

  it("terminalizes a due operation exactly once without creating provider state", async () => {
    const stub = ledgerStub("operation-recovery-due-idempotent");
    const operation = operationEnvelope("operation-recovery-due-idempotent", {
      execution_deadline_at: BASE_NOW + 10,
    });
    await stub.claimWithRecoveryIntent(
      operation,
      sha256("b"),
      "dispatch-operation-recovery-due-idempotent",
      ledgerPolicy(),
      BASE_NOW,
    );
    const intent = await stub.readOperationRecoveryIntent(operation.operation_id, 1);
    const payload = operationRecoveryIntentPayload(intent!);
    await stub.markOperationRecoveryIntentArmed(payload, BASE_NOW + 1);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE cinatoken_shard_alarm_intents
            SET delivery_count = delivery_generation, armed_at = NULL, updated_at = ?1
          WHERE operation_id = ?2 AND owner_generation = 1`,
        BASE_NOW + 2,
        operation.operation_id,
      );
    });
    await evictDurableObject(stub);

    await expect(
      stub.reconcileOperationRecoveryIntent(payload, operation.execution_deadline_at),
    ).resolves.toBe("completed");
    await expect(
      stub.reconcileOperationRecoveryIntent(payload, operation.execution_deadline_at + 1),
    ).resolves.toBe("duplicate");
    await expect(stub.readOutcome(operation.operation_id)).resolves.toMatchObject({
      status: "failed",
      response_status: 504,
      response_code: "container_execution_deadline_expired",
    });
    await expect(
      stub.readOperationRecoveryIntent(operation.operation_id, 1),
    ).resolves.toMatchObject({ state: "completed", armed_at: null, delivery_count: 1 });
    await runInDurableObject(stub, (_instance, state) => {
      const providerAttempts = state.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM cinatoken_shard_provider_attempts",
        )
        .toArray()[0]?.count;
      const providerRetryStates = state.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM cinatoken_shard_provider_retry_state",
        )
        .toArray()[0]?.count;
      expect(providerAttempts).toBe(0);
      expect(providerRetryStates).toBe(0);
    });
  });

  it("treats a normally terminal operation as a duplicate alarm", async () => {
    const stub = ledgerStub("operation-recovery-normal-terminal");
    const operation = operationEnvelope("operation-recovery-normal-terminal");
    await stub.claimWithRecoveryIntent(
      operation,
      sha256("c"),
      "dispatch-operation-recovery-normal-terminal",
      ledgerPolicy(),
      BASE_NOW,
    );
    const intent = await stub.readOperationRecoveryIntent(operation.operation_id, 1);
    const payload = operationRecoveryIntentPayload(intent!);
    await stub.transition(
      operation.operation_id,
      1,
      "claimed",
      "failed",
      503,
      BASE_NOW + 1,
    );

    await expect(
      stub.reconcileOperationRecoveryIntent(payload, operation.execution_deadline_at + 1),
    ).resolves.toBe("duplicate");
    await expect(stub.readOutcome(operation.operation_id)).resolves.toMatchObject({
      status: "failed",
      response_status: 503,
    });
    await expect(
      stub.readOperationRecoveryIntent(operation.operation_id, 1),
    ).resolves.toMatchObject({ state: "completed", armed_at: null });
  });

  it("reschedules an early delivery with a new generation and fences the old payload", async () => {
    const stub = ledgerStub("operation-recovery-early-delivery");
    const operation = operationEnvelope("operation-recovery-early-delivery", {
      execution_deadline_at: BASE_NOW + 20,
    });
    await stub.claimWithRecoveryIntent(
      operation,
      sha256("d"),
      "dispatch-operation-recovery-early-delivery",
      ledgerPolicy(),
      BASE_NOW,
    );
    const firstIntent = await stub.readOperationRecoveryIntent(operation.operation_id, 1);
    const firstPayload = operationRecoveryIntentPayload(firstIntent!);
    await stub.markOperationRecoveryIntentArmed(firstPayload, BASE_NOW + 1);

    await expect(
      stub.reconcileOperationRecoveryIntent(firstPayload, BASE_NOW + 10),
    ).resolves.toBe("not_due");
    const secondIntent = await stub.readOperationRecoveryIntent(operation.operation_id, 1);
    expect(secondIntent).toMatchObject({
      state: "pending",
      armed_at: null,
      delivery_generation: 2,
      delivery_count: 1,
      next_delivery_at: operation.execution_deadline_at + 1,
    });
    await expect(
      stub.reconcileOperationRecoveryIntent(firstPayload, operation.execution_deadline_at),
    ).resolves.toBe("stale");
    await expect(
      stub.reconcileOperationRecoveryIntent(
        operationRecoveryIntentPayload(secondIntent!),
        operation.execution_deadline_at,
      ),
    ).resolves.toBe("completed");
  });

  it("quarantines a current-generation shard mismatch without mutating the operation", async () => {
    const stub = ledgerStub("operation-recovery-shard-mismatch");
    const operation = operationEnvelope("operation-recovery-shard-mismatch");
    await stub.claimWithRecoveryIntent(
      operation,
      sha256("e"),
      "dispatch-operation-recovery-shard-mismatch",
      ledgerPolicy(),
      BASE_NOW,
    );
    const intent = await stub.readOperationRecoveryIntent(operation.operation_id, 1);
    const payload = operationRecoveryIntentPayload(intent!);
    const mismatchedPayload = {
      ...payload,
      shard: { ...payload.shard, ring_generation: payload.shard.ring_generation + 1 },
    };

    await expect(
      stub.reconcileOperationRecoveryIntent(mismatchedPayload, BASE_NOW + 1),
    ).resolves.toBe("quarantined");
    await expect(stub.readOutcome(operation.operation_id)).resolves.toMatchObject({
      status: "claimed",
      response_status: null,
    });
    await expect(
      stub.readOperationRecoveryIntent(operation.operation_id, 1),
    ).resolves.toMatchObject({
      state: "quarantined",
      armed_at: null,
      delivery_count: 1,
      last_error_code: "operation_recovery_payload_mismatch",
    });
  });

  it("bounds callback retries at eight deliveries and leaves financial paths untouched", async () => {
    const stub = ledgerStub("operation-recovery-retry-ceiling");
    const operation = operationEnvelope("operation-recovery-retry-ceiling", {
      execution_deadline_at: BASE_NOW + 10,
    });
    await stub.claimWithRecoveryIntent(
      operation,
      sha256("f"),
      "dispatch-operation-recovery-retry-ceiling",
      ledgerPolicy(),
      BASE_NOW,
    );
    let intent = await stub.readOperationRecoveryIntent(operation.operation_id, 1);
    const firstPayload = operationRecoveryIntentPayload(intent!);
    let now = operation.execution_deadline_at + 1;
    while (intent?.state === "pending") {
      const next = await stub.retryOperationRecoveryIntent(
        operationRecoveryIntentPayload(intent),
        now,
        "operation_recovery_callback_failed",
      );
      now += 301;
      if (next === null) break;
      intent = next;
    }

    await expect(
      stub.reconcileOperationRecoveryIntent(firstPayload, now),
    ).resolves.toBe("quarantined");
    await expect(
      stub.readOperationRecoveryIntent(operation.operation_id, 1),
    ).resolves.toMatchObject({
      state: "quarantined",
      delivery_generation: 8,
      delivery_count: 8,
      armed_at: null,
      last_error_code: "operation_recovery_callback_failed",
    });
    await expect(stub.readOutcome(operation.operation_id)).resolves.toMatchObject({
      status: "claimed",
      response_status: null,
    });
    await runInDurableObject(stub, (_instance, state) => {
      const tables = [
        "cinatoken_shard_provider_attempts",
        "cinatoken_shard_provider_retry_state",
        "cinatoken_shard_terminal_acks",
      ];
      for (const table of tables) {
        expect(
          state.storage.sql
            .exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`)
            .toArray()[0]?.count,
        ).toBe(0);
      }
    });
  });
});
