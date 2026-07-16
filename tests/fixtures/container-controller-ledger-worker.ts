import { DurableObject } from "cloudflare:workers";

import {
  RelayShardLedger,
  type ClaimResult,
  type OperationStatus,
  type ReadinessCompletion,
  type RelayShardLedgerPolicy,
  type ShardReadinessSnapshot,
} from "../../services/container-controller/src/ledger";
import {
  ProtocolError,
  type OperationEnvelope,
  type OperationShard,
} from "../../services/container-controller/src/protocol";

type ClaimOutcome =
  | { ok: true; result: ClaimResult }
  | { ok: false; error: { code: string; status: number } };

type ReadinessBeginOutcome =
  | { ok: true; generation: number }
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
    return this.ledger.claimOperation(envelope, envelopeSha256, dispatchId, policy, now);
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
        result: this.ledger.claimOperation(envelope, envelopeSha256, dispatchId, policy, now),
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

  async lifecycle(state: string, detail: string | null, now: number): Promise<void> {
    this.ledger.recordLifecycle(state, detail, now);
  }

  async initializeReadiness(shard: OperationShard, now: number): Promise<void> {
    this.ledger.initializeShardForReadiness(shard, now);
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
}

export default {
  fetch(): Response {
    return new Response(null, { status: 204 });
  },
};
