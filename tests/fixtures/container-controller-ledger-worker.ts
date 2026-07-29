import { DurableObject } from "cloudflare:workers";

import {
  RelayShardLedger,
  type ClaimResult,
  type DispatchProviderAttemptOutcome,
  type OperationRow,
  type OperationRecoveryIntent,
  type OperationRecoveryIntentOutcome,
  type OperationStatus,
  type PrepareProviderAttemptOutcome,
  type ProviderEgressIdentity,
  type ProviderAttemptTerminal,
  type ProviderRetryPolicy,
  type ReadinessCompletion,
  type RecordProviderAttemptOutcome,
  type RecordStorageResultOutcome,
  type RelayShardLedgerPolicy,
  type ShardDrainSnapshot,
  type ShardReadinessSnapshot,
  type StorageAccessGrant,
  type StorageResultRecord,
} from "../../services/container-controller/src/ledger";
import {
  ProtocolError,
  type ConfiguredRingTransition,
  type OperationEnvelope,
  type OperationRingAdmission,
  type OperationShard,
} from "../../services/container-controller/src/protocol";
import type { RelayShardAlarmIntentV1 } from "../../services/container-controller/src/relay_shard_durable_state";

type ClaimOutcome =
  | { ok: true; result: ClaimResult }
  | { ok: false; error: { code: string; status: number } };

type ReadinessBeginOutcome =
  | { ok: true; generation: number }
  | { ok: false; error: { code: string; status: number } };

type StorageAccessOutcome =
  | { ok: true; grant: StorageAccessGrant }
  | { ok: false; error: { code: string; status: number } };

type StorageResultOutcome =
  | { ok: true; result: RecordStorageResultOutcome }
  | { ok: false; error: { code: string; status: number } };

type FinalizeOperationOutcome =
  | { ok: true; result: OperationRow }
  | { ok: false; error: { code: string; status: number } };

type PrepareProviderAttemptRpcOutcome =
  | { ok: true; result: PrepareProviderAttemptOutcome }
  | { ok: false; error: { code: string; status: number } };

type DispatchProviderAttemptRpcOutcome =
  | { ok: true; result: DispatchProviderAttemptOutcome }
  | { ok: false; error: { code: string; status: number } };

type RecordProviderAttemptRpcOutcome =
  | { ok: true; result: RecordProviderAttemptOutcome }
  | { ok: false; error: { code: string; status: number } };

interface LedgerWorkerEnv {
  CONTAINER_CONTROLLER_LEDGER: DurableObjectNamespace<ContainerControllerLedgerTestObject>;
}

export class ContainerControllerLedgerTestObject extends DurableObject<LedgerWorkerEnv> {
  private readonly ledger: RelayShardLedger;

  constructor(ctx: DurableObjectState, env: LedgerWorkerEnv) {
    super(ctx, env);
    this.ledger = new RelayShardLedger(ctx.storage);
    this.ledger.ensureSchema();
  }

  async claim(
    envelope: OperationEnvelope,
    envelopeSha256: string,
    dispatchId: string,
    policy: RelayShardLedgerPolicy,
    now: number,
  ): Promise<ClaimResult> {
    return this.ledger.claimOperation(
      envelope,
      { role: "current", transition: null },
      envelopeSha256,
      dispatchId,
      policy,
      now,
    );
  }

  async claimWithRingAdmission(
    envelope: OperationEnvelope,
    ringAdmission: OperationRingAdmission,
    envelopeSha256: string,
    dispatchId: string,
    policy: RelayShardLedgerPolicy,
    now: number,
  ): Promise<ClaimResult> {
    return this.ledger.claimOperation(
      envelope,
      ringAdmission,
      envelopeSha256,
      dispatchId,
      policy,
      now,
    );
  }

  async claimWithRingAdmissionOutcome(
    envelope: OperationEnvelope,
    ringAdmission: OperationRingAdmission,
    envelopeSha256: string,
    dispatchId: string,
    policy: RelayShardLedgerPolicy,
    now: number,
  ): Promise<ClaimOutcome> {
    try {
      return {
        ok: true,
        result: this.ledger.claimOperation(
          envelope,
          ringAdmission,
          envelopeSha256,
          dispatchId,
          policy,
          now,
        ),
      };
    } catch (error) {
      if (error instanceof ProtocolError) {
        return { ok: false, error: { code: error.code, status: error.status } };
      }
      throw error;
    }
  }

  async claimWithRecoveryIntent(
    envelope: OperationEnvelope,
    envelopeSha256: string,
    dispatchId: string,
    policy: RelayShardLedgerPolicy,
    now: number,
  ): Promise<ClaimResult> {
    return this.ledger.claimOperation(
      envelope,
      { role: "current", transition: null },
      envelopeSha256,
      dispatchId,
      policy,
      now,
      true,
    );
  }

  async ensureOperationRecoveryIntent(
    envelope: OperationEnvelope,
    now: number,
  ): Promise<OperationRecoveryIntent> {
    return this.ledger.ensureOperationRecoveryIntent(envelope, now);
  }

  async readOperationRecoveryIntent(
    operationId: string,
    ownerGeneration: number,
  ): Promise<OperationRecoveryIntent | null> {
    return this.ledger.readOperationRecoveryIntent(operationId, ownerGeneration);
  }

  async listUnarmedOperationRecoveryIntents(): Promise<OperationRecoveryIntent[]> {
    return this.ledger.listUnarmedOperationRecoveryIntents();
  }

  async markOperationRecoveryIntentArmed(
    payload: RelayShardAlarmIntentV1,
    now: number,
  ): Promise<boolean> {
    return this.ledger.markOperationRecoveryIntentArmed(payload, now);
  }

  async reconcileOperationRecoveryIntent(
    payload: RelayShardAlarmIntentV1,
    now: number,
  ): Promise<OperationRecoveryIntentOutcome> {
    return this.ledger.reconcileOperationRecoveryIntent(payload, now);
  }

  async retryOperationRecoveryIntent(
    payload: RelayShardAlarmIntentV1,
    now: number,
    errorCode: string,
  ): Promise<OperationRecoveryIntent | null> {
    return this.ledger.retryOperationRecoveryIntent(payload, now, errorCode);
  }

  async quarantineOperationRecoveryIntent(
    payload: RelayShardAlarmIntentV1,
    now: number,
    errorCode: string,
  ): Promise<boolean> {
    return this.ledger.quarantineOperationRecoveryIntent(payload, now, errorCode);
  }

  async claimOutcome(
    envelope: OperationEnvelope,
    envelopeSha256: string,
    dispatchId: string,
    policy: RelayShardLedgerPolicy,
    now: number,
  ): Promise<ClaimOutcome> {
    try {
      return {
        ok: true,
        result: this.ledger.claimOperation(
          envelope,
          { role: "current", transition: null },
          envelopeSha256,
          dispatchId,
          policy,
          now,
        ),
      };
    } catch (error) {
      if (error instanceof ProtocolError) {
        return { ok: false, error: { code: error.code, status: error.status } };
      }
      throw error;
    }
  }

  async transition(
    operationId: string,
    ownerGeneration: number,
    expectedStatus: OperationStatus,
    status: OperationStatus,
    responseStatus: number | null,
    now: number,
    requireBeforeDeadline = false,
  ): Promise<boolean> {
    return this.ledger.transitionOperation(
      operationId,
      ownerGeneration,
      expectedStatus,
      status,
      responseStatus,
      now,
      requireBeforeDeadline,
    );
  }

  async finalizeOutcome(
    operationId: string,
    ownerGeneration: number,
    expectedStatus: "claimed" | "running",
    status: "completed" | "failed" | "recovery_required",
    responseStatus: number,
    responseCode: string | null,
    now: number,
    requireBeforeDeadline: boolean,
  ): Promise<FinalizeOperationOutcome> {
    try {
      return {
        ok: true,
        result: this.ledger.finalizeOperation(
          operationId,
          ownerGeneration,
          expectedStatus,
          status,
          responseStatus,
          responseCode,
          now,
          requireBeforeDeadline,
        ),
      };
    } catch (error) {
      if (error instanceof ProtocolError) {
        return { ok: false, error: { code: error.code, status: error.status } };
      }
      throw error;
    }
  }

  async readOutcome(operationId: string): Promise<OperationRow | null> {
    return this.ledger.readOperationOutcome(operationId);
  }

  async prepareProviderAttemptOutcome(
    operationId: string,
    ownerGeneration: number,
    maxAttempts: number,
    now: number,
  ): Promise<PrepareProviderAttemptRpcOutcome> {
    try {
      return {
        ok: true,
        result: this.ledger.prepareProviderAttempt(
          operationId,
          ownerGeneration,
          maxAttempts,
          now,
        ),
      };
    } catch (error) {
      if (error instanceof ProtocolError) {
        return { ok: false, error: { code: error.code, status: error.status } };
      }
      throw error;
    }
  }

  async startOperationWithProviderAttemptOutcome(
    operationId: string,
    ownerGeneration: number,
    policy: ProviderRetryPolicy,
    now: number,
  ): Promise<PrepareProviderAttemptRpcOutcome> {
    try {
      return {
        ok: true,
        result: this.ledger.startOperationWithProviderAttempt(
          operationId,
          ownerGeneration,
          policy,
          now,
        ),
      };
    } catch (error) {
      if (error instanceof ProtocolError) {
        return { ok: false, error: { code: error.code, status: error.status } };
      }
      throw error;
    }
  }

  async expireOperation(
    operationId: string,
    ownerGeneration: number,
    now: number,
  ): Promise<boolean> {
    return this.ledger.expireOperation(operationId, ownerGeneration, now);
  }

  async dispatchProviderAttemptOutcome(
    operationId: string,
    ownerGeneration: number,
    attemptGeneration: number,
    now: number,
  ): Promise<DispatchProviderAttemptRpcOutcome> {
    try {
      return {
        ok: true,
        result: this.ledger.dispatchProviderAttempt(
          operationId,
          ownerGeneration,
          attemptGeneration,
          now,
        ),
      };
    } catch (error) {
      if (error instanceof ProtocolError) {
        return { ok: false, error: { code: error.code, status: error.status } };
      }
      throw error;
    }
  }

  async dispatchProviderAttemptV2Outcome(
    operationId: string,
    ownerGeneration: number,
    attemptGeneration: number,
    identity: ProviderEgressIdentity,
    now: number,
  ): Promise<DispatchProviderAttemptRpcOutcome> {
    try {
      return {
        ok: true,
        result: this.ledger.dispatchProviderAttemptWithEgressIdentity(
          operationId,
          ownerGeneration,
          attemptGeneration,
          identity,
          now,
        ),
      };
    } catch (error) {
      if (error instanceof ProtocolError) {
        return { ok: false, error: { code: error.code, status: error.status } };
      }
      throw error;
    }
  }

  async recordProviderAttemptOutcome(
    operationId: string,
    ownerGeneration: number,
    attemptGeneration: number,
    terminal: ProviderAttemptTerminal,
    now: number,
  ): Promise<RecordProviderAttemptRpcOutcome> {
    try {
      return {
        ok: true,
        result: this.ledger.recordProviderAttemptOutcome(
          operationId,
          ownerGeneration,
          attemptGeneration,
          terminal,
          now,
        ),
      };
    } catch (error) {
      if (error instanceof ProtocolError) {
        return { ok: false, error: { code: error.code, status: error.status } };
      }
      throw error;
    }
  }

  async lifecycle(state: string, detail: string | null, now: number): Promise<void> {
    this.ledger.recordLifecycle(state, detail, now);
  }

  async initializeReadiness(shard: OperationShard, now: number): Promise<void> {
    this.ledger.initializeShardForReadiness(shard, now);
  }

  async initializeReadinessWithRingTransition(
    shard: OperationShard,
    now: number,
    ringTransition: ConfiguredRingTransition,
  ): Promise<void> {
    this.ledger.initializeShardForReadiness(shard, now, ringTransition);
  }

  async initializeReadinessOutcome(
    shard: OperationShard,
    now: number,
  ): Promise<{ ok: true } | { ok: false; error: { code: string; status: number } }> {
    try {
      this.ledger.initializeShardForReadiness(shard, now);
      return { ok: true };
    } catch (error) {
      if (error instanceof ProtocolError) {
        return { ok: false, error: { code: error.code, status: error.status } };
      }
      throw error;
    }
  }

  async beginReadinessOutcome(
    shard: OperationShard,
    probeId: string,
    nowMs: number,
    deadlineAtMs: number,
    cooldownMs: number,
  ): Promise<ReadinessBeginOutcome> {
    try {
      return {
        ok: true,
        generation: this.ledger.beginReadinessProbe(
          shard,
          probeId,
          nowMs,
          deadlineAtMs,
          cooldownMs,
        ),
      };
    } catch (error) {
      if (error instanceof ProtocolError) {
        return { ok: false, error: { code: error.code, status: error.status } };
      }
      throw error;
    }
  }

  async completeReadiness(
    generation: number,
    completedAtMs: number,
    completion: ReadinessCompletion,
  ): Promise<boolean> {
    return this.ledger.completeReadinessProbe(generation, completedAtMs, completion);
  }

  async readinessSnapshot(shard: OperationShard, now: number): Promise<ShardReadinessSnapshot> {
    return this.ledger.readShardReadiness(shard, now);
  }

  async drainSnapshot(shard: OperationShard, now: number): Promise<ShardDrainSnapshot> {
    return this.ledger.readShardDrainSnapshot(shard, now);
  }

  async authorizeStorageOutcome(
    operationId: string,
    ownerGeneration: number,
    now: number,
  ): Promise<StorageAccessOutcome> {
    try {
      return {
        ok: true,
        grant: this.ledger.authorizeStorageAccess(operationId, ownerGeneration, now),
      };
    } catch (error) {
      if (error instanceof ProtocolError) {
        return { ok: false, error: { code: error.code, status: error.status } };
      }
      throw error;
    }
  }

  async recordStorageResultOutcome(
    operationId: string,
    ownerGeneration: number,
    result: StorageResultRecord,
    now: number,
    providerAttemptGeneration?: number,
  ): Promise<StorageResultOutcome> {
    try {
      return {
        ok: true,
        result: this.ledger.recordStorageResult(
          operationId,
          ownerGeneration,
          result,
          now,
          providerAttemptGeneration,
        ),
      };
    } catch (error) {
      if (error instanceof ProtocolError) {
        return { ok: false, error: { code: error.code, status: error.status } };
      }
      throw error;
    }
  }

  async recordProviderUsageResultOutcome(
    operationId: string,
    ownerGeneration: number,
    result: StorageResultRecord,
    attemptGeneration: number,
    usageReceiptSha256: string,
    now: number,
  ): Promise<StorageResultOutcome> {
    try {
      return {
        ok: true,
        result: this.ledger.recordProviderUsageResult(
          operationId,
          ownerGeneration,
          result,
          attemptGeneration,
          usageReceiptSha256,
          now,
        ),
      };
    } catch (error) {
      if (error instanceof ProtocolError) {
        return { ok: false, error: { code: error.code, status: error.status } };
      }
      throw error;
    }
  }
}

export default {
  fetch(): Response {
    return new Response(null, { status: 204 });
  },
};
