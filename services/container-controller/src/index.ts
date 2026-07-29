import { Container, ContainerProxy } from "@cloudflare/containers";
import {
  DISPATCH_REPLAY_RETENTION_SECONDS,
  RelayShardLedger,
  operationRecoveryIntentPayload,
  operationStorageResult,
  type AttachProviderResponseArtifactsOutcome,
  type ProviderResponseArtifactAttachment,
  type ProviderResponseArtifactAttachmentRow,
  type OperationRecoveryIntent,
  type OperationRecoveryIntentOutcome,
  type OperationRow,
  type DispatchProviderAttemptOutcome,
  type ProviderEgressIdentity,
  type ProviderAttemptTerminal,
  type ProviderRetryPolicy,
  type RecordProviderAttemptOutcome,
  type RecordStorageResultOutcome,
  type ReadinessProbeCompletedReplay,
  type ReadinessProbeJournalCompletion,
  type ReadinessProbeWakePermit,
  type RelayShardLedgerPolicy,
  type StorageAccessGrant,
  type StorageResultRecord,
  type TerminalAckLedgerOutcome,
} from "./ledger";
import {
  AUTHORITY_HEADER,
  INTERNAL_OPERATION_PATH,
  INTERNAL_OPERATION_TERMINAL_ACK_PATH,
  INTERNAL_OPERATION_TERMINAL_ACK_V2_PATH,
  INTERNAL_OPERATION_TERMINAL_ACK_V3_PATH,
  INTERNAL_OPERATION_STATUS_PATH,
  INTERNAL_OPERATION_STATUS_V2_PATH,
  INTERNAL_OPERATION_STATUS_V3_PATH,
  INTERNAL_OPERATION_STATUS_V4_PATH,
  INTERNAL_READINESS_PATH,
  INTERNAL_STATUS_PATH,
  MAX_OPERATION_BODY_BYTES,
  MAX_STORAGE_OBJECT_VERSION_BYTES,
  ProtocolError,
  type AuthorityEnvironment,
  type OperationEnvelope,
  type OperationShard,
  type OperationStatusQuery,
  type ShardReadinessProbe,
  type TerminalAckRequest,
  type TerminalAckRequestV3,
  configuredRingTransition,
  inspectRingTransition,
  verifyOperationRequest,
  verifyReadinessRequest,
  verifyStatusRequest,
  verifyTerminalAckV3Request,
} from "./protocol";
import {
  operationOutcomeResponse,
  parseContainerOperationResponse,
  terminalAckV3Response,
} from "./operation_outcome";
import { controllerStatusV1Response } from "./controller_status";
import {
  handleOperationStatusRequest,
  handleOperationStatusV2Request,
  handleOperationStatusV3Request,
  handleOperationStatusV4Request,
  type ShardOperationStatusRpcResult,
  type ShardOperationStatusV2RpcResult,
  type ShardOperationStatusV3RpcResult,
  type ShardOperationStatusV4RpcResult,
} from "./operation_status";
import {
  handleTerminalAckRequest,
  handleTerminalAckV2Request,
  type ShardTerminalAckRpcResult,
} from "./terminal_ack";
import {
  PROVIDER_ATTEMPT_HOST,
  handleProviderAttemptGatewayRequest,
} from "./provider_attempt_gateway";
import {
  PROVIDER_EGRESS_HOST,
  handleProviderEgressGatewayRequest,
  type ProviderEgressGatewayEnvironment,
} from "./provider_egress_gateway";
import {
  CONTENT_SHA256_HEADER,
  D1_ADMISSION_HOST,
  KV_CONFIG_HOST,
  MAX_R2_OBJECT_BYTES,
  OPERATION_ID_HEADER,
  OWNER_GENERATION_HEADER,
  PROVIDER_ATTEMPT_GENERATION_HEADER,
  R2_INPUT_HOST,
  R2_OBJECT_VERSION_HEADER,
  R2_RESULT_HOST,
  STORAGE_GATEWAY_ACTIONS,
  deriveR2ResultKey,
  handleStorageGatewayRequest,
  requireD1OperationAdmission,
  type R2ResultPutGrant,
  type StorageAccessGrant as GatewayStorageAccessGrant,
  type StorageGatewayAction,
  type StorageGatewayEnvironment,
} from "./storage_gateway";
import {
  parseOperationRecoverySchedule,
  type LegacyOperationRecoverySchedule,
  type RelayShardAlarmIntentV1,
} from "./relay_shard_durable_state";
import {
  assertRelayShardObjectJurisdiction,
  relayShardJurisdictionPolicy,
  selectRelayShardNamespace,
  type RelayShardJurisdictionEnvironment,
} from "./relay_shard_jurisdiction";
import {
  SHARD_ACTIVATION_WRITE_ENABLED_ENV,
} from "./shard_activation";
import {
  campaignActionGateInventory,
  claimShardActivationCampaign,
  finalizeShardActivationCampaign,
  readExistingShardActivationCampaignClaim,
  sealShardActivationCampaignFailure,
  type ShardActivationCampaignAcquire,
  type ShardActivationCampaignClaim,
  type ShardActivationCampaignClaimInput,
} from "./shard_activation_campaign";
import {
  SHARD_PLACEMENT_READINESS_PROBE_PATH,
  SHARD_PLACEMENT_READINESS_READBACK_PATH,
  assertShardPlacementReadinessContext,
  assertShardPlacementReadinessControllerIdentity,
  shardPlacementReadinessResponse,
  verifyShardPlacementReadinessRequest,
  type ShardPlacementReadinessJournalEvidence,
  type ShardPlacementReadinessEnvironment,
  type ShardPlacementReadinessRequest,
  type ShardPlacementReadinessRole,
} from "./shard_placement_readiness";
import {
  CONTROLLER_DISABLE_ATTESTATION_PATH,
  handleControllerDisableAttestationRequest,
  type ControllerDisableAttestationEnvironment,
} from "./controller_disable_attestation";
import {
  createShardPlacementAttestationV1,
  shardPlacementAttestationDigest,
  shardPlacementAttestationWriterPolicy,
  verifyShardPlacementAttestationRpcV1,
  type ShardPlacementAttestationRpcResultV1,
  type ShardPlacementAttestationWriterEnvironment,
} from "./shard_placement_attestation";
import {
  recordShardPlacementAttestation,
  requireShardPlacementMutationAuthorization,
} from "./shard_placement_ledger";

export { ContainerProxy };

interface ControllerRuntimeEnvironment
  extends
    AuthorityEnvironment,
    RelayShardJurisdictionEnvironment,
    ShardPlacementAttestationWriterEnvironment,
    ShardPlacementReadinessEnvironment,
    ControllerDisableAttestationEnvironment {
  ENVIRONMENT: string;
  CONTAINER_CONTROLLER_SERVICE_NAME: string;
  CONTAINER_CONTROLLER_ENABLED: string;
  CONTAINER_EXECUTION_ENABLED: string;
  CONTAINER_READINESS_PROBE_ENABLED: string;
  CONTAINER_READINESS_WAKE_ENABLED: string;
  CONTAINER_STORAGE_R2_READ_ENABLED: string;
  CONTAINER_STORAGE_R2_WRITE_ENABLED: string;
  CONTAINER_STORAGE_KV_READ_ENABLED: string;
  CONTAINER_STORAGE_D1_READ_ENABLED: string;
  CONTAINER_PROVIDER_ATTEMPT_JOURNAL_ENABLED: string;
  CONTAINER_PROVIDER_CLIENT_ENABLED: string;
  CONTAINER_PROVIDER_EGRESS_ENABLED: string;
  CONTAINER_PROVIDER_RESPONSE_V3_PARSE_ENABLED: string;
  CONTAINER_PROVIDER_RESPONSE_RAW_WRITE_ENABLED: string;
  CONTAINER_PROVIDER_RESPONSE_CLIENT_WRITE_ENABLED: string;
  CONTAINER_PROVIDER_RESPONSE_TERMINAL_ENABLED: string;
  CONTAINER_PROVIDER_RETRY_ENABLED: string;
  CONTAINER_PROVIDER_ATTEMPT_STAGING_VERIFIED: string;
  CONTAINER_GLOBAL_TERMINAL_ACK_ENABLED: string;
  CONTAINER_GLOBAL_TERMINAL_COMPACTION_ENABLED: string;
  CONTAINER_OPERATION_RECOVERY_INTENT_V1_ENABLED: string;
  CONTAINER_OPERATION_RECOVERY_INTENT_V1_STAGING_VERIFIED: string;
  CONTAINER_SHARD_ACTIVATION_WRITE_ENABLED: string;
  CONTAINER_SHARD_ACTIVATION_EXPECTED_RUNTIME_BUILD_ID: string;
  CONTAINER_MAX_PROVIDER_ATTEMPTS: string;
  CONTAINER_MAX_IN_FLIGHT_PER_SHARD: string;
  CONTAINER_TERMINAL_RETENTION_SECONDS: string;
  CONTAINER_MAX_TERMINAL_OPERATIONS: string;
  CONTAINER_PREVIOUS_RING_GENERATION: string;
  CONTAINER_PREVIOUS_SHARD_COUNT: string;
  CONTAINER_PREVIOUS_RING_ADMISSION_STARTED_AT: string;
  CONTAINER_PREVIOUS_RING_ADMISSION_UNTIL: string;
  CONTAINER_AUTHORITY_CURRENT_SECRET: string;
  CONTAINER_AUTHORITY_PREVIOUS_SECRET?: string;
}

type ControllerEnv = Omit<
  ContainerControllerEnv,
  keyof ControllerRuntimeEnvironment | "RELAY_SHARDS"
> & ControllerRuntimeEnvironment & {
  RELAY_SHARDS: DurableObjectNamespace<RelayShardContainer>;
};

function operationRecoveryIntentWriterEnabled(env: ControllerRuntimeEnvironment): boolean {
  return (
    env.CONTAINER_OPERATION_RECOVERY_INTENT_V1_ENABLED === "true" &&
    env.CONTAINER_OPERATION_RECOVERY_INTENT_V1_STAGING_VERIFIED === "true"
  );
}

interface ContainerStorageRuntimeEnvironment {
  CONTAINER_STORAGE_R2_READ_ENABLED: string;
  CONTAINER_STORAGE_R2_WRITE_ENABLED: string;
  CONTAINER_STORAGE_KV_READ_ENABLED: string;
  CONTAINER_STORAGE_D1_READ_ENABLED: string;
}

const jsonHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const READINESS_TIMEOUT_MS = 10_000;
const READINESS_COOLDOWN_MS = 5_000;
const READINESS_RESPONSE_MAX_BYTES = 1024;

interface ContainerStateSnapshot {
  status: "running" | "healthy" | "stopping" | "stopped" | "stopped_with_code";
  last_change_ms: number;
  exit_code: number | null;
}

interface RuntimeReadinessSnapshot {
  process_ready: boolean;
  execution_ready: boolean;
  protocol_version: number;
  shard_contract_version: number;
  runtime_build_id: string | null;
  execution_enabled: boolean;
}

export interface ShardReadinessResult {
  checked_at: number;
  mode: "ledger" | "live";
  ready: boolean;
  verdict: "unknown" | "ready" | "not_ready";
  result_code: string;
  shard: OperationShard;
  wake_requested: boolean;
  container_state: ContainerStateSnapshot | null;
  ledger: import("./ledger").ShardReadinessSnapshot;
  runtime: RuntimeReadinessSnapshot | null;
}

type ShardReadinessRpcResult =
  | { ok: true; result: ShardReadinessResult }
  | { ok: false; error: { code: string; status: number } };

type ShardReadinessRpcResultV2 =
  | {
      ok: true;
      result: ShardReadinessResult;
      result_sha256: string;
      journal: ShardPlacementReadinessJournalEvidence;
    }
  | { ok: false; error: { code: string; status: number } };

interface ReadinessObservation {
  completedAtMs: number;
  resultCode: string;
  containerState: ContainerStateSnapshot | null;
  runtime: RuntimeReadinessSnapshot | null;
}

export type ShardStorageAccessRpcResult =
  | { ok: true; grant: StorageAccessGrant }
  | { ok: false; error: { code: string; status: number } };

export type ShardStorageResultRpcResult =
  | { ok: true; result: RecordStorageResultOutcome }
  | { ok: false; error: { code: string; status: number } };

export type ShardDispatchProviderAttemptRpcResult =
  | { ok: true; result: DispatchProviderAttemptOutcome }
  | { ok: false; error: { code: string; status: number } };

export type ShardRecordProviderAttemptRpcResult =
  | { ok: true; result: RecordProviderAttemptOutcome }
  | { ok: false; error: { code: string; status: number } };

export type ShardAttachProviderResponseArtifactsRpcResult =
  | { ok: true; result: AttachProviderResponseArtifactsOutcome }
  | { ok: false; error: { code: string; status: number } };

export type ShardReadProviderResponseArtifactsRpcResult =
  | { ok: true; row: ProviderResponseArtifactAttachmentRow | null }
  | { ok: false; error: { code: string; status: number } };

export type ShardTerminalAckV3RpcResult =
  | { ok: true; result: TerminalAckLedgerOutcome }
  | { ok: false; error: { code: string; status: number } };

export type {
  ShardOperationStatusRpcResult,
  ShardOperationStatusV2RpcResult,
  ShardOperationStatusV3RpcResult,
  ShardOperationStatusV4RpcResult,
} from "./operation_status";
export type {
  ShardTerminalAckRpcResult,
  TerminalAckErrorResponse,
  TerminalAckProviderUsageBinding,
  TerminalAckRequest,
  TerminalAckRequestV1,
  TerminalAckRequestV2,
  TerminalAckResponse,
  TerminalAckResultManifest,
} from "./terminal_ack";
export type {
  TerminalAckProviderResponseBinding,
  TerminalAckRequestV3,
} from "./protocol";
export type { TerminalAckV3Response } from "./operation_outcome";

export class RelayShardContainer extends Container<ControllerEnv> {
  override defaultPort = 8080;
  override requiredPorts = [8080];
  override sleepAfter = "10m";
  override entrypoint = ["/usr/local/bin/cinatoken-container-runtime"];
  override envVars: Record<string, string> = {
    CINATOKEN_CONTAINER_PORT: "8080",
    CINATOKEN_CONTAINER_PROVIDER_CLIENT_ENABLED:
      this.env.CONTAINER_PROVIDER_CLIENT_ENABLED === "true" ? "true" : "false",
  };
  override enableInternet = false;
  override interceptHttps = true;
  override allowedHosts: string[] = [
    R2_INPUT_HOST,
    R2_RESULT_HOST,
    KV_CONFIG_HOST,
    D1_ADMISSION_HOST,
    PROVIDER_ATTEMPT_HOST,
    PROVIDER_EGRESS_HOST,
  ];
  override pingEndpoint = "/healthz";

  static override outbound = (): Response => jsonError("container_egress_denied", 403);

  private readonly ledger: RelayShardLedger;
  private readonly durableObjectId: string;

  constructor(ctx: DurableObjectState<{}>, env: ControllerEnv) {
    super(ctx, env);
    assertRelayShardObjectJurisdiction(env, ctx.id.jurisdiction);
    this.durableObjectId = ctx.id.toString();
    this.ledger = new RelayShardLedger(ctx.storage);
    ctx.blockConcurrencyWhile(async () => {
      this.ledger.ensureSchema();
      await this.rearmPendingOperationRecoveryIntents();
    });
  }

  private async armOperationRecoveryIntent(intent: OperationRecoveryIntent): Promise<void> {
    const payload = operationRecoveryIntentPayload(intent);
    await this.schedule(
      new Date(intent.next_delivery_at * 1000),
      "reconcileOperationDeadline",
      payload,
    );
    if (
      !this.ledger.markOperationRecoveryIntentArmed(
        payload,
        Math.floor(Date.now() / 1000),
      )
    ) {
      throw new ProtocolError("operation_recovery_intent_arm_conflict", 409);
    }
  }

  private async rearmPendingOperationRecoveryIntents(): Promise<void> {
    for (const intent of this.ledger.listUnarmedOperationRecoveryIntents()) {
      await this.armOperationRecoveryIntent(intent);
    }
  }

  private async rearmOperationRecoveryIntentIfNeeded(
    operationId: string,
    ownerGeneration: number,
  ): Promise<void> {
    const intent = this.ledger.readOperationRecoveryIntent(operationId, ownerGeneration);
    if (intent === null || intent.state !== "pending" || intent.armed_at !== null) return;
    await this.armOperationRecoveryIntent(intent);
  }

  async authorizeStorageAccess(
    operationId: string,
    ownerGeneration: number,
  ): Promise<ShardStorageAccessRpcResult> {
    try {
      return {
        ok: true,
        grant: this.ledger.authorizeStorageAccess(
          operationId,
          ownerGeneration,
          Math.floor(Date.now() / 1000),
          this.env.CONTAINER_PROVIDER_ATTEMPT_JOURNAL_ENABLED === "true",
        ),
      };
    } catch (error) {
      if (error instanceof ProtocolError) {
        return { ok: false, error: { code: error.code, status: error.status } };
      }
      return { ok: false, error: { code: "storage_access_unavailable", status: 503 } };
    }
  }

  async recordStorageResult(
    operationId: string,
    ownerGeneration: number,
    result: StorageResultRecord,
    providerAttemptGeneration?: number,
  ): Promise<ShardStorageResultRpcResult> {
    try {
      return {
        ok: true,
        result: this.ledger.recordStorageResult(
          operationId,
          ownerGeneration,
          result,
          Math.floor(Date.now() / 1000),
          providerAttemptGeneration,
        ),
      };
    } catch (error) {
      if (error instanceof ProtocolError) {
        return { ok: false, error: { code: error.code, status: error.status } };
      }
      return { ok: false, error: { code: "storage_result_unavailable", status: 503 } };
    }
  }

  async recordProviderUsageResult(
    operationId: string,
    ownerGeneration: number,
    result: StorageResultRecord,
    attemptGeneration: number,
    usageReceiptSha256: string,
  ): Promise<ShardStorageResultRpcResult> {
    try {
      return {
        ok: true,
        result: this.ledger.recordProviderUsageResult(
          operationId,
          ownerGeneration,
          result,
          attemptGeneration,
          usageReceiptSha256,
          Math.floor(Date.now() / 1000),
        ),
      };
    } catch (error) {
      if (error instanceof ProtocolError) {
        return { ok: false, error: { code: error.code, status: error.status } };
      }
      return { ok: false, error: { code: "storage_result_unavailable", status: 503 } };
    }
  }

  async dispatchProviderAttempt(
    operationId: string,
    ownerGeneration: number,
    attemptGeneration: number,
  ): Promise<ShardDispatchProviderAttemptRpcResult> {
    if (this.env.CONTAINER_PROVIDER_ATTEMPT_JOURNAL_ENABLED !== "true") {
      return {
        ok: false,
        error: { code: "provider_attempt_journal_disabled", status: 503 },
      };
    }
    try {
      return {
        ok: true,
        result: this.ledger.dispatchProviderAttempt(
          operationId,
          ownerGeneration,
          attemptGeneration,
          Math.floor(Date.now() / 1000),
        ),
      };
    } catch (error) {
      return providerAttemptRpcError(error);
    }
  }

  async dispatchProviderAttemptV2(
    operationId: string,
    ownerGeneration: number,
    attemptGeneration: number,
    identity: ProviderEgressIdentity,
  ): Promise<ShardDispatchProviderAttemptRpcResult> {
    if (this.env.CONTAINER_PROVIDER_ATTEMPT_JOURNAL_ENABLED !== "true") {
      return {
        ok: false,
        error: { code: "provider_attempt_journal_disabled", status: 503 },
      };
    }
    try {
      return {
        ok: true,
        result: this.ledger.dispatchProviderAttemptWithEgressIdentity(
          operationId,
          ownerGeneration,
          attemptGeneration,
          identity,
          Math.floor(Date.now() / 1000),
        ),
      };
    } catch (error) {
      return providerAttemptRpcError(error);
    }
  }

  async recordProviderAttemptOutcome(
    operationId: string,
    ownerGeneration: number,
    attemptGeneration: number,
    terminal: ProviderAttemptTerminal,
  ): Promise<ShardRecordProviderAttemptRpcResult> {
    if (this.env.CONTAINER_PROVIDER_ATTEMPT_JOURNAL_ENABLED !== "true") {
      return {
        ok: false,
        error: { code: "provider_attempt_journal_disabled", status: 503 },
      };
    }
    try {
      return {
        ok: true,
        result: this.ledger.recordProviderAttemptOutcome(
          operationId,
          ownerGeneration,
          attemptGeneration,
          terminal,
          Math.floor(Date.now() / 1000),
        ),
      };
    } catch (error) {
      return providerAttemptRpcError(error);
    }
  }

  async attachProviderResponseArtifacts(
    operationId: string,
    ownerGeneration: number,
    attemptGeneration: number,
    attachment: ProviderResponseArtifactAttachment,
  ): Promise<ShardAttachProviderResponseArtifactsRpcResult> {
    if (
      this.env.CONTAINER_PROVIDER_ATTEMPT_JOURNAL_ENABLED !== "true" ||
      this.env.CONTAINER_PROVIDER_RESPONSE_V3_PARSE_ENABLED !== "true" ||
      this.env.CONTAINER_PROVIDER_RESPONSE_RAW_WRITE_ENABLED !== "true" ||
      this.env.CONTAINER_PROVIDER_RESPONSE_CLIENT_WRITE_ENABLED !== "true"
    ) {
      return {
        ok: false,
        error: { code: "provider_response_artifact_attachment_disabled", status: 503 },
      };
    }
    try {
      return {
        ok: true,
        result: this.ledger.attachProviderResponseArtifacts(
          operationId,
          ownerGeneration,
          attemptGeneration,
          attachment,
          Math.floor(Date.now() / 1000),
        ),
      };
    } catch (error) {
      if (error instanceof ProtocolError) {
        return { ok: false, error: { code: error.code, status: error.status } };
      }
      return {
        ok: false,
        error: { code: "provider_response_artifact_attachment_unavailable", status: 503 },
      };
    }
  }

  async readProviderResponseArtifacts(
    operationId: string,
    ownerGeneration: number,
    attemptGeneration: number,
  ): Promise<ShardReadProviderResponseArtifactsRpcResult> {
    try {
      return {
        ok: true,
        row: this.ledger.readProviderResponseArtifactAttachment(
          operationId,
          ownerGeneration,
          attemptGeneration,
        ),
      };
    } catch (error) {
      if (error instanceof ProtocolError) {
        return { ok: false, error: { code: error.code, status: error.status } };
      }
      return {
        ok: false,
        error: { code: "provider_response_artifact_attachment_unavailable", status: 503 },
      };
    }
  }

  async readOperationStatus(
    query: OperationStatusQuery,
  ): Promise<ShardOperationStatusRpcResult> {
    try {
      return { ok: true, row: this.ledger.readOperationStatus(query) };
    } catch (error) {
      if (error instanceof ProtocolError) {
        return { ok: false, error: { code: error.code, status: error.status } };
      }
      return { ok: false, error: { code: "operation_status_unavailable", status: 503 } };
    }
  }

  async readOperationStatusV2(
    query: OperationStatusQuery,
  ): Promise<ShardOperationStatusV2RpcResult> {
    try {
      return { ok: true, snapshot: this.ledger.readOperationStatusSnapshot(query) };
    } catch (error) {
      if (error instanceof ProtocolError) {
        return { ok: false, error: { code: error.code, status: error.status } };
      }
      return { ok: false, error: { code: "operation_status_unavailable", status: 503 } };
    }
  }

  async readOperationStatusV3(
    query: OperationStatusQuery,
  ): Promise<ShardOperationStatusV3RpcResult> {
    try {
      return { ok: true, snapshot: this.ledger.readOperationStatusSnapshot(query) };
    } catch (error) {
      if (error instanceof ProtocolError) {
        return { ok: false, error: { code: error.code, status: error.status } };
      }
      return { ok: false, error: { code: "operation_status_unavailable", status: 503 } };
    }
  }

  async readOperationStatusV4(
    query: OperationStatusQuery,
  ): Promise<ShardOperationStatusV4RpcResult> {
    try {
      return { ok: true, snapshot: this.ledger.readOperationStatusV4Snapshot(query) };
    } catch (error) {
      if (error instanceof ProtocolError) {
        return { ok: false, error: { code: error.code, status: error.status } };
      }
      return { ok: false, error: { code: "operation_status_unavailable", status: 503 } };
    }
  }

  async acknowledgeGlobalTerminal(
    ack: TerminalAckRequest,
  ): Promise<ShardTerminalAckRpcResult> {
    if (this.env.CONTAINER_GLOBAL_TERMINAL_ACK_ENABLED !== "true") {
      return {
        ok: false,
        error: { code: "container_global_terminal_ack_disabled", status: 503 },
      };
    }
    try {
      return {
        ok: true,
        result: this.ledger.acknowledgeGlobalTerminal(
          ack,
          Math.floor(Date.now() / 1000),
        ),
      };
    } catch (error) {
      if (error instanceof ProtocolError) {
        return { ok: false, error: { code: error.code, status: error.status } };
      }
      return { ok: false, error: { code: "terminal_ack_unavailable", status: 503 } };
    }
  }

  async acknowledgeGlobalTerminalV3(
    ack: TerminalAckRequestV3,
  ): Promise<ShardTerminalAckV3RpcResult> {
    if (this.env.CONTAINER_GLOBAL_TERMINAL_ACK_ENABLED !== "true") {
      return {
        ok: false,
        error: { code: "container_global_terminal_ack_disabled", status: 503 },
      };
    }
    try {
      return {
        ok: true,
        result: this.ledger.acknowledgeGlobalTerminalV3(
          ack,
          Math.floor(Date.now() / 1000),
        ),
      };
    } catch (error) {
      if (error instanceof ProtocolError) {
        return { ok: false, error: { code: error.code, status: error.status } };
      }
      return { ok: false, error: { code: "terminal_ack_unavailable", status: 503 } };
    }
  }

  async reconcileOperationDeadline(payload: unknown): Promise<void> {
    const schedule = parseOperationRecoverySchedule(payload);
    const now = Math.floor(Date.now() / 1000);
    if (schedule.payload_version === 0) {
      if (schedule.deadline_at > now) {
        try {
          await this.schedule(
            new Date((schedule.deadline_at + 1) * 1000),
            "reconcileOperationDeadline",
            legacyOperationRecoverySchedule(schedule),
          );
        } catch {
          this.ctx.abort("legacy operation recovery reschedule failed");
        }
        return;
      }
      try {
        this.ledger.expireOperation(schedule.operation_id, schedule.owner_generation, now);
      } catch {
        this.ctx.abort("legacy operation recovery persistence failed");
      }
      return;
    }

    let outcome: OperationRecoveryIntentOutcome;
    try {
      outcome = this.ledger.reconcileOperationRecoveryIntent(schedule, now);
    } catch (error) {
      const errorCode = operationRecoveryCallbackErrorCode(error);
      let retry: OperationRecoveryIntent | null = null;
      try {
        retry = this.ledger.retryOperationRecoveryIntent(schedule, now, errorCode);
      } catch {
        this.ctx.abort("operation recovery retry persistence failed");
        return;
      }
      if (retry === null) return;
      try {
        const retryPayload = operationRecoveryIntentPayload(retry);
        await this.schedule(
          new Date(retry.next_delivery_at * 1000),
          "reconcileOperationDeadline",
          retryPayload,
        );
        if (!this.ledger.markOperationRecoveryIntentArmed(retryPayload, now)) {
          throw new ProtocolError("operation_recovery_intent_arm_conflict", 409);
        }
      } catch {
        this.ctx.abort("operation recovery reschedule failed");
      }
      return;
    }
    if (outcome !== "not_due") return;
    const intent = this.ledger.readOperationRecoveryIntent(
      schedule.operation_id,
      schedule.owner_generation,
    );
    if (intent === null || intent.state !== "pending" || intent.armed_at !== null) return;
    try {
      await this.armOperationRecoveryIntent(intent);
    } catch {
      this.ctx.abort("operation recovery reschedule failed");
    }
  }

  async readinessProbe(
    probe: ShardReadinessProbe,
    probeId: string,
  ): Promise<ShardReadinessRpcResult> {
    const startedAtMs = Date.now();
    try {
      if (!probe.wake_container) {
        return {
          ok: true,
          result: {
            checked_at: Math.floor(startedAtMs / 1000),
            mode: "ledger",
            ready: false,
            verdict: "unknown",
            result_code: "ledger_snapshot",
            shard: probe.shard,
            wake_requested: false,
            container_state: null,
            ledger: this.ledger.readShardReadiness(probe.shard, Math.floor(startedAtMs / 1000)),
            runtime: null,
          },
        };
      }

      const now = Math.floor(startedAtMs / 1000);
      this.ledger.initializeShardForReadiness(
        probe.shard,
        now,
        configuredRingTransition(this.env, now),
      );
      const replay = this.ledger.recoverReadinessProbe(probe.shard, probeId, startedAtMs);
      if (replay !== null) {
        const containerState: ContainerStateSnapshot | null =
          replay.containerStatus === null
            ? null
            : {
                status: replay.containerStatus,
                last_change_ms: replay.containerLastChangeMs as number,
                exit_code: replay.containerExitCode,
              };
        const runtime: RuntimeReadinessSnapshot | null =
          replay.runtimeProtocolVersion === null
            ? null
            : {
                process_ready: replay.processReady,
                execution_ready: replay.executionReady,
                protocol_version: replay.runtimeProtocolVersion,
                shard_contract_version: replay.runtimeContractVersion as number,
                runtime_build_id: replay.runtimeBuildId,
                execution_enabled: replay.runtimeExecutionEnabled as boolean,
              };
        return {
          ok: true,
          result: {
            checked_at: Math.floor(replay.completedAtMs / 1000),
            mode: "live",
            ready: replay.executionReady,
            verdict: replay.executionReady ? "ready" : "not_ready",
            result_code: replay.resultCode,
            shard: probe.shard,
            wake_requested: true,
            container_state: containerState,
            ledger: this.ledger.readShardReadiness(
              probe.shard,
              Math.floor(startedAtMs / 1000),
            ),
            runtime,
          },
        };
      }
      const generation = this.ledger.beginReadinessProbe(
        probe.shard,
        probeId,
        startedAtMs,
        startedAtMs + READINESS_TIMEOUT_MS,
        READINESS_COOLDOWN_MS,
      );
      const { completedAtMs, resultCode, containerState, runtime } =
        await this.observeContainerReadiness(probe, startedAtMs);
      const completed = this.ledger.completeReadinessProbe(generation, completedAtMs, {
        resultCode,
        containerStatus: containerState?.status ?? null,
        containerLastChangeMs: containerState?.last_change_ms ?? null,
        containerExitCode: containerState?.exit_code ?? null,
        runtimeProtocolVersion: runtime?.protocol_version ?? null,
        runtimeContractVersion: runtime?.shard_contract_version ?? null,
        runtimeBuildId: runtime?.runtime_build_id ?? null,
        runtimeExecutionEnabled: runtime?.execution_enabled ?? null,
        processReady: runtime?.process_ready ?? false,
        executionReady: runtime?.execution_ready ?? false,
      });
      if (!completed) throw new ProtocolError("readiness_probe_superseded", 409);
      const executionReady = runtime?.execution_ready ?? false;
      return {
        ok: true,
        result: {
          checked_at: Math.floor(completedAtMs / 1000),
          mode: "live",
          ready: executionReady,
          verdict: executionReady ? "ready" : "not_ready",
          result_code: resultCode,
          shard: probe.shard,
          wake_requested: true,
          container_state: containerState,
          ledger: this.ledger.readShardReadiness(
            probe.shard,
            Math.floor(completedAtMs / 1000),
          ),
          runtime,
        },
      };
    } catch (error) {
      if (error instanceof ProtocolError) {
        return { ok: false, error: { code: error.code, status: error.status } };
      }
      return {
        ok: false,
        error: { code: "container_readiness_unavailable", status: 504 },
      };
    }
  }

  async readinessProbeV2(
    probe: ShardReadinessProbe,
    probeId: string,
    claimDigestSha256: string,
    replayOnly: boolean,
  ): Promise<ShardReadinessRpcResultV2> {
    const startedAtMs = Date.now();
    try {
      if (
        !probe.wake_container ||
        probe.activation_campaign !== undefined ||
        typeof replayOnly !== "boolean"
      ) {
        throw new ProtocolError("invalid_readiness_probe_journal", 400);
      }
      this.ledger.initializeShardForReadiness(
        probe.shard,
        Math.floor(startedAtMs / 1_000),
        configuredRingTransition(this.env, Math.floor(startedAtMs / 1_000)),
      );
      const journal = replayOnly
        ? await this.ledger.replayReadinessProbeJournal(
            probe.shard,
            probeId,
            claimDigestSha256,
            startedAtMs,
          )
        : await this.ledger.beginOrReplayReadinessProbe(
            probe.shard,
            probeId,
            claimDigestSha256,
            startedAtMs,
            startedAtMs + READINESS_TIMEOUT_MS,
            true,
          );
      if (journal.kind === "completed") {
        return readinessJournalRpcSuccess(probe, journal, "exact_replay");
      }

      const observation = await this.observeContainerReadiness(probe, startedAtMs);
      const completion = await readinessJournalCompletion(
        this.ledger,
        probe,
        journal,
        observation,
      );
      const replay = await this.ledger.completeReadinessProbeJournal(
        probe.shard,
        journal,
        observation.completedAtMs,
        completion,
      );
      return readinessJournalRpcSuccess(probe, replay, "fresh");
    } catch (error) {
      if (error instanceof ProtocolError) {
        return { ok: false, error: { code: error.code, status: error.status } };
      }
      return {
        ok: false,
        error: { code: "readiness_probe_journal_unavailable", status: 503 },
      };
    }
  }

  async shardPlacementAttestationV1(
    shard: OperationShard,
    probeId: string,
    claimDigestSha256: string,
    readinessResultSha256: string,
  ): Promise<ShardPlacementAttestationRpcResultV1> {
    try {
      if (
        !/^[0-9a-f]{64}$/.test(probeId) ||
        !/^[0-9a-f]{64}$/.test(claimDigestSha256) ||
        !/^[0-9a-f]{64}$/.test(readinessResultSha256)
      ) {
        throw new ProtocolError("invalid_shard_placement_attestation", 400);
      }
      if (!shardPlacementAttestationWriterPolicy(this.env).enabled) {
        throw new ProtocolError("shard_placement_attestation_disabled", 503);
      }
      const replay = await this.ledger.replayReadinessProbeJournal(
        shard,
        probeId,
        claimDigestSha256,
        Date.now(),
      );
      if (replay.resultSha256 !== readinessResultSha256) {
        throw new ProtocolError("readiness_probe_result_mismatch", 502);
      }
      const attestation = await createShardPlacementAttestationV1({
        environment: shardPlacementEnvironment(this.env.ENVIRONMENT),
        controllerServiceName: this.env.CONTAINER_CONTROLLER_SERVICE_NAME,
        controllerVersionId: this.env.CF_VERSION_METADATA.id,
        jurisdiction: relayShardJurisdictionPolicy(this.env).jurisdiction,
        durableObjectId: this.durableObjectId,
        shard,
      });
      return {
        ok: true,
        attestation,
        attestation_digest_sha256:
          await shardPlacementAttestationDigest(attestation),
      };
    } catch (error) {
      if (error instanceof ProtocolError) {
        return { ok: false, error: { code: error.code, status: error.status } };
      }
      return {
        ok: false,
        error: {
          code: "shard_placement_attestation_unavailable",
          status: 503,
        },
      };
    }
  }

  private async observeContainerReadiness(
    probe: ShardReadinessProbe,
    startedAtMs: number,
  ): Promise<ReadinessObservation> {
    let containerState: ContainerStateSnapshot | null = null;
    let runtime: RuntimeReadinessSnapshot | null = null;
    let resultCode = "container_readiness_unavailable";
    try {
      const deadlineAtMs = startedAtMs + READINESS_TIMEOUT_MS;
      const response = await this.containerFetch("http://container/readyz", {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(Math.max(1, deadlineAtMs - Date.now())),
      });
      const body = await readBoundedResponse(
        response,
        READINESS_RESPONSE_MAX_BYTES,
        deadlineAtMs,
      );
      if (response.status !== 200) {
        throw new ProtocolError(
          response.status === 429
            ? "container_start_rate_limited"
            : response.status === 503
              ? "container_start_unavailable"
              : "container_readiness_rejected",
          response.status === 429 ? 429 : 503,
        );
      }
      const readiness = validateRuntimeReadinessResponse(response, body);
      containerState = containerStateSnapshot(
        await withAbsoluteDeadline(
          this.getState(),
          deadlineAtMs,
          "container_readiness_timeout",
          504,
        ),
      );
      const processReady = containerState.status === "healthy";
      const ledgerBeforeCompletion = this.ledger.readShardReadiness(
        probe.shard,
        Math.floor(Date.now() / 1000),
      );
      const lifecycleAccepting = !["draining", "stopped", "error"].includes(
        ledgerBeforeCompletion.lifecycle_state ?? "",
      );
      const capacityAvailable =
        ledgerBeforeCompletion.active_in_flight_operations <
        controllerLedgerPolicy(this.env).maxInFlight;
      const recoveryIntentWriterReady = operationRecoveryIntentWriterEnabled(this.env);
      const executionReady =
        processReady &&
        readiness.execution_enabled &&
        this.env.CONTAINER_EXECUTION_ENABLED === "true" &&
        recoveryIntentWriterReady &&
        lifecycleAccepting &&
        capacityAvailable;
      runtime = {
        process_ready: processReady,
        execution_ready: executionReady,
        protocol_version: readiness.protocol_version,
        shard_contract_version: readiness.shard_contract_version,
        runtime_build_id: readiness.runtime_build_id,
        execution_enabled: readiness.execution_enabled,
      };
      resultCode = !processReady
        ? "container_not_healthy"
        : !readiness.execution_enabled
          ? "process_ready_execution_disabled"
          : this.env.CONTAINER_EXECUTION_ENABLED !== "true"
            ? "controller_execution_disabled"
            : !recoveryIntentWriterReady
              ? "operation_recovery_intent_v1_disabled"
              : !lifecycleAccepting
                ? "shard_not_accepting"
                : !capacityAvailable
                  ? "shard_capacity_exhausted"
                  : "execution_ready";
    } catch (error) {
      resultCode = error instanceof ProtocolError ? error.code : "container_readiness_unavailable";
      try {
        containerState = containerStateSnapshot(await this.getState());
      } catch {
        containerState = null;
      }
    }
    return { completedAtMs: Date.now(), resultCode, containerState, runtime };
  }

  override async fetch(request: Request): Promise<Response> {
    try {
      const verified = await verifyOperationRequest(request, this.env);
      const now = Math.floor(Date.now() / 1000);
      const executionEnabled = this.env.CONTAINER_EXECUTION_ENABLED === "true";
      if (executionEnabled && !operationRecoveryIntentWriterEnabled(this.env)) {
        throw new ProtocolError("operation_recovery_intent_v1_disabled", 503);
      }
      if (executionEnabled && verified.ring_admission.role !== "previous_replay_only") {
        if (this.env.CONTAINER_STORAGE_D1_READ_ENABLED !== "true") {
          throw new ProtocolError("admission_gateway_disabled", 503);
        }
        await requireD1OperationAdmission(
          storageGatewayEnv(this.env),
          verified.envelope,
          now,
        );
      }
      const claim = this.ledger.claimOperation(
        verified.envelope,
        verified.ring_admission,
        verified.claims.body_sha256,
        verified.claims.dispatch_id,
        controllerLedgerPolicy(this.env),
        now,
        executionEnabled,
      );
      if (claim.kind === "existing") {
        await this.rearmOperationRecoveryIntentIfNeeded(
          verified.envelope.operation_id,
          verified.envelope.owner_generation,
        );
        return responseForExisting(claim.row);
      }
      if (claim.kind === "capacity") {
        return new Response(JSON.stringify({ error: "container_capacity_exhausted", retryable: true }), {
          status: 503,
          headers: { ...jsonHeaders, "retry-after": "1" },
        });
      }
      if (!executionEnabled) {
        const outcome = finalizeOperationOutcome(
          this.ledger,
          verified.envelope.operation_id,
          verified.envelope.owner_generation,
          "claimed",
          "failed",
          503,
          "container_execution_disabled",
          now,
          false,
        );
        return operationOutcomeResponse(outcome);
      }

      let recoveryIntentPayload: RelayShardAlarmIntentV1 | null = null;
      try {
        const intent = this.ledger.readOperationRecoveryIntent(
          verified.envelope.operation_id,
          verified.envelope.owner_generation,
        );
        if (intent === null || intent.state !== "pending") {
          throw new ProtocolError("operation_recovery_intent_unavailable", 503);
        }
        recoveryIntentPayload = operationRecoveryIntentPayload(intent);
        await this.armOperationRecoveryIntent(intent);
      } catch {
        if (recoveryIntentPayload !== null) {
          try {
            this.ledger.quarantineOperationRecoveryIntent(
              recoveryIntentPayload,
              Math.floor(Date.now() / 1000),
              "operation_recovery_initial_schedule_failed",
            );
          } catch {
            console.error("operation recovery initial quarantine persistence failed");
          }
        }
        const outcome = finalizeOperationOutcome(
          this.ledger,
          verified.envelope.operation_id,
          verified.envelope.owner_generation,
          "claimed",
          "failed",
          503,
          "container_recovery_schedule_unavailable",
          Math.floor(Date.now() / 1000),
          false,
        );
        return operationOutcomeResponse(outcome);
      }
      const providerAttemptJournalEnabled =
        this.env.CONTAINER_PROVIDER_ATTEMPT_JOURNAL_ENABLED === "true" &&
        verified.envelope.operation_kind !== "health_probe";
      const started = providerAttemptJournalEnabled
        ? this.ledger.startOperationWithProviderAttempt(
            verified.envelope.operation_id,
            verified.envelope.owner_generation,
            controllerProviderRetryPolicy(this.env),
            now,
          ).kind === "prepared"
        : this.ledger.transitionOperation(
            verified.envelope.operation_id,
            verified.envelope.owner_generation,
            "claimed",
            "running",
            null,
            now,
            true,
          );
      if (!started) {
        this.ledger.expireOperation(
          verified.envelope.operation_id,
          verified.envelope.owner_generation,
          now,
        );
        const outcome = this.ledger.readOperationOutcome(verified.envelope.operation_id);
        return outcome === null
          ? jsonError("operation_completion_conflict", 409)
          : operationOutcomeResponse(outcome);
      }
      const remainingMs = Math.max(
        1,
        (verified.envelope.execution_deadline_at - Math.floor(Date.now() / 1000)) * 1000,
      );
      try {
        const upstream = await this.containerFetch("http://container/v1/operations", {
          method: "POST",
          headers: { "content-type": "application/json", "x-cinatoken-container-protocol": "1" },
          body: copyArrayBuffer(verified.body),
          signal: AbortSignal.timeout(remainingMs),
        });
        const body = await readBoundedResponse(upstream, MAX_OPERATION_BODY_BYTES);
        const containerOutcome = parseContainerOperationResponse(
          upstream,
          body,
          verified.envelope,
        );
        validatePersistedContainerResult(this.ledger, verified.envelope, containerOutcome.result);
        const outcome = finalizeOperationOutcome(
          this.ledger,
          verified.envelope.operation_id,
          verified.envelope.owner_generation,
          "running",
          containerOutcome.status === "completed"
            ? "completed"
            : containerOutcome.status === "rejected"
              ? "failed"
              : "recovery_required",
          containerOutcome.status === "recovery_required" ? 202 : upstream.status,
          containerOutcome.code,
          Math.floor(Date.now() / 1000),
          containerOutcome.status !== "recovery_required",
        );
        return operationOutcomeResponse(outcome);
      } catch {
        const outcome = finalizeOperationOutcome(
          this.ledger,
          verified.envelope.operation_id,
          verified.envelope.owner_generation,
          "running",
          "recovery_required",
          202,
          "container_execution_ambiguous",
          Math.floor(Date.now() / 1000),
          false,
        );
        return operationOutcomeResponse(outcome);
      }
    } catch (error) {
      return protocolErrorResponse(error);
    }
  }

  override onStart(): void {
    this.ledger.recordLifecycle("running", null, Math.floor(Date.now() / 1000));
  }

  override onStop(params: { exitCode?: number; reason?: string }): void {
    this.ledger.recordLifecycle(
      "stopped",
      `${params.exitCode ?? "unknown"}:${boundedLogValue(params.reason)}`,
      Math.floor(Date.now() / 1000),
    );
  }

  override onError(error: unknown): unknown {
    this.ledger.recordLifecycle(
      "error",
      boundedLogValue(error instanceof Error ? error.name : typeof error),
      Math.floor(Date.now() / 1000),
    );
    throw error;
  }

  override async onActivityExpired(): Promise<void> {
    this.ledger.recordLifecycle("draining", null, Math.floor(Date.now() / 1000));
    await this.stop("SIGTERM");
  }
}

async function readinessJournalCompletion(
  ledger: RelayShardLedger,
  probe: ShardReadinessProbe,
  permit: ReadinessProbeWakePermit,
  observation: ReadinessObservation,
): Promise<ReadinessProbeJournalCompletion> {
  const { completedAtMs, resultCode, containerState, runtime } = observation;
  const ledgerSnapshot = ledger.readShardReadiness(
    probe.shard,
    Math.floor(completedAtMs / 1_000),
  );
  const result: ShardReadinessResult = {
    checked_at: Math.floor(completedAtMs / 1_000),
    mode: "live",
    ready: runtime?.execution_ready ?? false,
    verdict: runtime?.execution_ready ? "ready" : "not_ready",
    result_code: resultCode,
    shard: probe.shard,
    wake_requested: true,
    container_state: containerState,
    ledger: {
      ...ledgerSnapshot,
      readiness: {
        generation: permit.generation,
        phase: "complete",
        last_probe_id: permit.probeId,
        started_at_ms: permit.startedAtMs,
        deadline_at_ms: permit.deadlineAtMs,
        completed_at_ms: completedAtMs,
        result_code: resultCode,
        container_status: containerState?.status ?? null,
        container_last_change_ms: containerState?.last_change_ms ?? null,
        container_exit_code: containerState?.exit_code ?? null,
        runtime_protocol_version: runtime?.protocol_version ?? null,
        runtime_contract_version: runtime?.shard_contract_version ?? null,
        runtime_execution_enabled: runtime?.execution_enabled ?? null,
        last_ready_at_ms:
          runtime?.process_ready === true
            ? completedAtMs
            : ledgerSnapshot.readiness.last_ready_at_ms,
      },
    },
    runtime,
  };
  const resultJson = JSON.stringify(result);
  return {
    resultCode,
    containerStatus: containerState?.status ?? null,
    containerLastChangeMs: containerState?.last_change_ms ?? null,
    containerExitCode: containerState?.exit_code ?? null,
    runtimeProtocolVersion: runtime?.protocol_version ?? null,
    runtimeContractVersion: runtime?.shard_contract_version ?? null,
    runtimeBuildId: runtime?.runtime_build_id ?? null,
    runtimeExecutionEnabled: runtime?.execution_enabled ?? null,
    processReady: runtime?.process_ready ?? false,
    executionReady: runtime?.execution_ready ?? false,
    resultJson,
    resultSha256: await sha256Utf8(resultJson),
  };
}

function readinessJournalRpcSuccess(
  probe: ShardReadinessProbe,
  replay: ReadinessProbeCompletedReplay,
  replayKind: "fresh" | "exact_replay",
): ShardReadinessRpcResultV2 {
  const parsed: unknown = JSON.parse(replay.resultJson);
  if (
    JSON.stringify(parsed) !== replay.resultJson ||
    !isJournalReadinessResult(parsed, probe.shard, replay)
  ) {
    throw new ProtocolError("readiness_probe_result_corrupt", 500);
  }
  return {
    ok: true,
    result: parsed,
    result_sha256: replay.resultSha256,
    journal: {
      replay: replayKind,
      generation: replay.generation,
      started_at_ms: replay.startedAtMs,
      deadline_at_ms: replay.deadlineAtMs,
      retention_until_ms: replay.retentionUntilMs,
      completed_at_ms: replay.completedAtMs,
    },
  };
}

function isJournalReadinessResult(
  value: unknown,
  shard: OperationShard,
  replay: ReadinessProbeCompletedReplay,
): value is ShardReadinessResult {
  if (!isRecord(value) || !hasExactKeys(value, [
    "checked_at",
    "mode",
    "ready",
    "verdict",
    "result_code",
    "shard",
    "wake_requested",
    "container_state",
    "ledger",
    "runtime",
  ])) return false;
  if (!isRecord(value.shard) || !operationShardEquals(value.shard, shard)) return false;
  if (!isRecord(value.ledger) || !isRecord(value.ledger.readiness)) return false;
  const readiness = value.ledger.readiness;
  if (
    value.checked_at !== Math.floor(replay.completedAtMs / 1_000) ||
    value.mode !== "live" ||
    typeof value.ready !== "boolean" ||
    value.verdict !== (value.ready ? "ready" : "not_ready") ||
    typeof value.result_code !== "string" ||
    value.result_code.length < 1 ||
    value.result_code.length > 128 ||
    value.wake_requested !== true ||
    value.ledger.initialized !== true ||
    !nonNegativeInteger(value.ledger.active_in_flight_operations) ||
    !nonNegativeInteger(value.ledger.expired_in_flight_operations) ||
    !nonNegativeInteger(value.ledger.terminal_operations) ||
    readiness.generation !== replay.generation ||
    readiness.phase !== "complete" ||
    readiness.last_probe_id !== replay.probeId ||
    readiness.started_at_ms !== replay.startedAtMs ||
    readiness.deadline_at_ms !== replay.deadlineAtMs ||
    readiness.completed_at_ms !== replay.completedAtMs ||
    readiness.result_code !== value.result_code
  ) {
    return false;
  }
  if (value.container_state !== null) {
    if (!isRecord(value.container_state)) return false;
    if (
      !["running", "healthy", "stopping", "stopped", "stopped_with_code"].includes(
        typeof value.container_state.status === "string" ? value.container_state.status : "",
      ) ||
      !nonNegativeInteger(value.container_state.last_change_ms) ||
      !nullableInteger(value.container_state.exit_code)
    ) {
      return false;
    }
  }
  if (value.runtime === null) return value.ready === false;
  if (!isRecord(value.runtime)) return false;
  return (
    typeof value.runtime.process_ready === "boolean" &&
    typeof value.runtime.execution_ready === "boolean" &&
    value.ready === value.runtime.execution_ready &&
    positiveInteger(value.runtime.protocol_version) &&
    positiveInteger(value.runtime.shard_contract_version) &&
    (value.runtime.runtime_build_id === null ||
      (typeof value.runtime.runtime_build_id === "string" &&
        /^[0-9a-f]{64}$/.test(value.runtime.runtime_build_id))) &&
    typeof value.runtime.execution_enabled === "boolean"
  );
}

function operationShardEquals(value: Record<string, unknown>, shard: OperationShard): boolean {
  return (
    hasExactKeys(value, [
      "contract_version",
      "ring_generation",
      "shard_count",
      "shard_index",
      "instance_name",
    ]) &&
    value.contract_version === shard.contract_version &&
    value.ring_generation === shard.ring_generation &&
    value.shard_count === shard.shard_count &&
    value.shard_index === shard.shard_index &&
    value.instance_name === shard.instance_name
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nullableInteger(value: unknown): value is number | null {
  return value === null || Number.isSafeInteger(value);
}

async function sha256Utf8(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

RelayShardContainer.outboundByHost = {
  [R2_INPUT_HOST]: storageOutboundHandler(STORAGE_GATEWAY_ACTIONS.R2_INPUT_GET),
  [R2_RESULT_HOST]: storageOutboundHandler(STORAGE_GATEWAY_ACTIONS.R2_RESULT_PUT),
  [KV_CONFIG_HOST]: storageOutboundHandler(STORAGE_GATEWAY_ACTIONS.KV_CONFIG_GET),
  [D1_ADMISSION_HOST]: storageOutboundHandler(STORAGE_GATEWAY_ACTIONS.D1_ADMISSION_GET),
  [PROVIDER_ATTEMPT_HOST]: providerAttemptOutboundHandler,
  [PROVIDER_EGRESS_HOST]: providerEgressOutboundHandler,
};

async function handleTerminalAckV3Request(
  request: Request,
  env: ControllerEnv,
  now = Math.floor(Date.now() / 1000),
): Promise<Response> {
  try {
    const verified = await verifyTerminalAckV3Request(request, env, now);
    if (env.CONTAINER_GLOBAL_TERMINAL_ACK_ENABLED !== "true") {
      return jsonError("container_global_terminal_ack_disabled", 503);
    }
    const stub = selectRelayShardNamespace(env).getByName(
      verified.ack.shard.instance_name,
    );
    const outcome = await stub.acknowledgeGlobalTerminalV3(verified.ack);
    if (!outcome.ok) return jsonError(outcome.error.code, outcome.error.status);
    return terminalAckV3Response(verified.ack, outcome.result);
  } catch (error) {
    if (error instanceof ProtocolError) return jsonError(error.code, error.status);
    return jsonError("terminal_ack_unavailable", 503);
  }
}

async function prepareShardActivationCampaignClaimInput(
  env: ControllerEnv,
  probe: ShardReadinessProbe,
  probeId: string,
): Promise<{
  input: ShardActivationCampaignClaimInput;
  actionGates: Awaited<ReturnType<typeof campaignActionGateInventory>>;
}> {
  const campaign = probe.activation_campaign;
  if (campaign === undefined) {
    throw new ProtocolError("shard_activation_campaign_required", 400);
  }
  const placementPolicy = shardPlacementAttestationWriterPolicy(env);
  if (relayShardJurisdictionPolicy(env).restricted) {
    throw new ProtocolError(
      "shard_activation_jurisdiction_contract_unavailable",
      503,
    );
  }
  const actionGateInventory = await campaignActionGateInventory(env);
  if (
    !actionGateInventory.allActionGatesFalse ||
    /^[0-9a-f]{64}$/.test(
      env.CONTAINER_SHARD_ACTIVATION_EXPECTED_RUNTIME_BUILD_ID,
    )
  ) {
    throw new ProtocolError("shard_activation_campaign_action_gate_enabled", 409);
  }
  if (env.ENVIRONMENT !== "staging" && env.ENVIRONMENT !== "production") {
    throw new ProtocolError("shard_activation_environment_invalid", 503);
  }
  if (placementPolicy.enabled) {
    if (env.ENVIRONMENT !== "staging") {
      throw new ProtocolError(
        "shard_placement_mutation_authorization_environment_invalid",
        503,
      );
    }
    await requireShardPlacementMutationAuthorization(env.DB, {
      campaignId: campaign.campaign_id,
      controllerVersionId: env.CF_VERSION_METADATA.id,
      actionGateInventorySha256: actionGateInventory.digestSha256,
      ringGeneration: probe.shard.ring_generation,
      shardCount: probe.shard.shard_count,
      environment: env.ENVIRONMENT,
    });
  }
  return {
    input: {
      credential: campaign,
      controllerVersionId: env.CF_VERSION_METADATA.id,
      actionGateInventory,
      shard: probe.shard,
      runtimeProtocolVersion: probe.protocol_version,
      environment: env.ENVIRONMENT,
      probeId,
    },
    actionGates: actionGateInventory,
  };
}

async function claimShardActivationCampaignBeforeWake(
  env: ControllerEnv,
  probe: ShardReadinessProbe,
  probeId: string,
): Promise<ShardActivationCampaignAcquire | null> {
  const campaign = probe.activation_campaign;
  if (campaign === undefined) {
    if (env[SHARD_ACTIVATION_WRITE_ENABLED_ENV] === "true") {
      throw new ProtocolError("shard_activation_legacy_writer_retired", 503);
    }
    return null;
  }
  const prepared = await prepareShardActivationCampaignClaimInput(
    env,
    probe,
    probeId,
  );
  return claimShardActivationCampaign(env.DB, prepared.input);
}

async function recordClaimedShardPlacementAttestation(
  env: ControllerEnv,
  stub: DurableObjectStub<RelayShardContainer>,
  claim: ShardActivationCampaignClaim,
  readinessResultSha256: string,
): Promise<void> {
  if (!shardPlacementAttestationWriterPolicy(env).enabled) return;
  assertRelayShardObjectJurisdiction(env, stub.id.jurisdiction);
  let outcome: ShardPlacementAttestationRpcResultV1;
  try {
    outcome = await stub.shardPlacementAttestationV1(
      claim.shard,
      claim.probeId,
      claim.claimDigestSha256,
      readinessResultSha256,
    );
  } catch {
    throw new ProtocolError(
      "shard_placement_attestation_rpc_unavailable",
      503,
    );
  }
  if (!outcome.ok) {
    throw new ProtocolError(outcome.error.code, outcome.error.status);
  }
  const verified = await verifyShardPlacementAttestationRpcV1(outcome, {
    environment: shardPlacementEnvironment(env.ENVIRONMENT),
    controllerServiceName: env.CONTAINER_CONTROLLER_SERVICE_NAME,
    controllerVersionId: env.CF_VERSION_METADATA.id,
    jurisdiction: relayShardJurisdictionPolicy(env).jurisdiction,
    durableObjectId: stub.id.toString(),
    shard: claim.shard,
  });
  const record = await recordShardPlacementAttestation(
    env.DB,
    claim,
    readinessResultSha256,
    verified,
  );
  console.log(
    JSON.stringify({
      event: "relay_container_shard_placement_attestation_recorded",
      campaign_id: claim.campaignId,
      claim_digest_sha256: claim.claimDigestSha256,
      readiness_result_sha256: readinessResultSha256,
      placement_attestation_digest_sha256:
        verified.attestationDigestSha256,
      activation_digest_sha256: record.activationDigestSha256,
      consumption_digest_sha256: record.consumptionDigestSha256,
      placement_event_sequence: record.placementEventSequence,
      activation_id: record.activationId,
      recorded_at: record.recordedAt,
      duplicate: record.duplicate,
      controller_version_id: env.CF_VERSION_METADATA.id,
      jurisdiction: verified.attestation.jurisdiction,
      ring_generation: claim.shard.ring_generation,
      shard_index: claim.shard.shard_index,
    }),
  );
}

function shardPlacementEnvironment(
  value: string,
): "staging" | "production" {
  if (value === "staging" || value === "production") return value;
  throw new ProtocolError(
    "shard_placement_attestation_environment_invalid",
    503,
  );
}

async function finalizeClaimedShardActivationCampaign(
  env: ControllerEnv,
  result: ShardReadinessResult,
  claim: ShardActivationCampaignClaim,
  readinessResultSha256: string,
): Promise<void> {
  const probeGeneration = campaignReadinessProbeGeneration(result, claim);
  let outcome;
  try {
    outcome = await finalizeShardActivationCampaign(env.DB, claim, {
      controllerVersionId: env.CF_VERSION_METADATA.id,
      shard: result.shard,
      runtimeProtocolVersion: result.runtime!.protocol_version,
      runtimeContractVersion: result.runtime!.shard_contract_version,
      runtimeBuildId: result.runtime!.runtime_build_id!,
      activationGeneration: 1,
      activationProbeGeneration: probeGeneration,
      environment: claim.environment,
      containerStatus: "healthy",
      readinessResultCode: "process_ready_execution_disabled",
      processReady: true,
      runtimeExecutionEnabled: false,
      controllerExecutionEnabled: false,
      activatedAt: result.checked_at,
    }, readinessResultSha256);
  } catch (error) {
    if (
      error instanceof ProtocolError &&
      [
        "shard_activation_campaign_readiness_ineligible",
        "shard_activation_campaign_candidate_mismatch",
        "shard_activation_campaign_claim_missing",
        "shard_activation_campaign_conflict",
      ].includes(error.code)
    ) {
      await sealCampaignFailureBestEffort(env, claim.campaignId, "claim_execution_failed");
    }
    throw error;
  }
  console.log(
    JSON.stringify({
      event: "relay_container_shard_activation_campaign_consumed",
      campaign_id: outcome.campaignId,
      campaign_digest_sha256: outcome.campaignDigestSha256,
      claim_digest_sha256: outcome.claimDigestSha256,
      consumption_digest_sha256: outcome.consumptionDigestSha256,
      readiness_result_sha256: readinessResultSha256,
      claimed_shard_count: outcome.claimedShardCount,
      consumed_shard_count: outcome.consumedShardCount,
      campaign_sealed: outcome.sealed,
      controller_version_id: env.CF_VERSION_METADATA.id,
      ring_generation: result.shard.ring_generation,
      shard_index: result.shard.shard_index,
    }),
  );
}

function campaignReadinessProbeGeneration(
  result: ShardReadinessResult,
  claim: ShardActivationCampaignClaim,
): number {
  if (
    result.mode !== "live" ||
    result.wake_requested !== true ||
    result.ready ||
    result.verdict !== "not_ready" ||
    result.container_state?.status !== "healthy" ||
    result.runtime?.process_ready !== true ||
    result.runtime.execution_ready ||
    result.runtime.runtime_build_id === null ||
    result.result_code !== "process_ready_execution_disabled" ||
    result.runtime.execution_enabled ||
    result.ledger.readiness.phase !== "complete" ||
    result.ledger.readiness.last_probe_id !== claim.probeId ||
    result.ledger.readiness.result_code !== result.result_code
  ) {
    throw new ProtocolError("shard_activation_campaign_readiness_ineligible", 409);
  }
  const probeGeneration = result.ledger.readiness.generation;
  if (!Number.isSafeInteger(probeGeneration) || probeGeneration < 1) {
    throw new ProtocolError("shard_activation_probe_invalid", 502);
  }
  return probeGeneration;
}

async function sealCampaignFailureBestEffort(
  env: ControllerEnv,
  campaignId: string,
  detail: "claim_execution_failed" | "readiness_rejected",
): Promise<void> {
  try {
    await sealShardActivationCampaignFailure(env.DB, campaignId, detail);
  } catch (error) {
    console.error(JSON.stringify({
      event: "relay_container_shard_activation_campaign_failure_seal",
      status: "unavailable",
      campaign_id: campaignId,
      detail_code: detail,
      error: error instanceof ProtocolError ? error.code : "unknown",
    }));
  }
}

function readinessResponse(
  probe: ShardReadinessProbe,
  probeId: string,
  result: ShardReadinessResult,
  readinessResultSha256?: string,
): Response {
  return new Response(
    JSON.stringify({
      protocol_version: probe.protocol_version,
      probe_id: probeId,
      ...(readinessResultSha256 === undefined
        ? {}
        : { readiness_result_sha256: readinessResultSha256 }),
      ...result,
    }),
    { status: 200, headers: jsonHeaders },
  );
}

async function handleShardPlacementReadinessRequest(
  request: Request,
  env: ControllerEnv,
  role: ShardPlacementReadinessRole,
): Promise<Response> {
  const verified = await verifyShardPlacementReadinessRequest(
    request,
    env,
    role,
  );
  assertShardPlacementReadinessControllerIdentity(verified.request, env);
  const shardProbe: ShardReadinessProbe = {
    protocol_version: Number(env.CONTAINER_PROTOCOL_VERSION),
    shard: verified.request.shard,
    wake_container: true,
    activation_campaign: verified.request.activation_campaign,
  };
  const prepared = await prepareShardActivationCampaignClaimInput(
    env,
    shardProbe,
    verified.request.probe_id_sha256,
  );
  const campaignAcquire =
    role === "readiness_probe"
      ? await claimShardActivationCampaign(env.DB, prepared.input)
      : await readExistingShardActivationCampaignClaim(
          env.DB,
          prepared.input,
        );
  const claim = campaignAcquire.claim;
  assertShardPlacementReadinessContext(
    verified.request,
    claim,
    prepared.actionGates,
    env,
  );

  const journalProbe: ShardReadinessProbe = {
    protocol_version: shardProbe.protocol_version,
    shard: shardProbe.shard,
    wake_container: true,
  };
  const stub = selectRelayShardNamespace(env).getByName(
    verified.request.shard.instance_name,
  );
  let outcome: ShardReadinessRpcResultV2;
  try {
    outcome = await stub.readinessProbeV2(
      journalProbe,
      verified.request.probe_id_sha256,
      claim.claimDigestSha256,
      role === "readiness_readback" ||
        campaignAcquire.kind === "completed",
    );
  } catch {
    return jsonError("readiness_probe_journal_unavailable", 503);
  }
  if (!outcome.ok) {
    if (
      campaignAcquire.kind === "claimed" &&
      [
        "readiness_probe_ambiguous",
        "readiness_probe_superseded",
        "readiness_probe_claim_mismatch",
        "readiness_probe_result_corrupt",
        "invalid_readiness_probe_result",
        "readiness_probe_completion_conflict",
      ].includes(outcome.error.code)
    ) {
      await sealCampaignFailureBestEffort(
        env,
        claim.campaignId,
        "claim_execution_failed",
      );
    }
    return jsonError(outcome.error.code, outcome.error.status);
  }
  if (
    campaignAcquire.kind === "completed" &&
    campaignAcquire.readinessResultSha256 !== outcome.result_sha256
  ) {
    return jsonError("readiness_probe_result_mismatch", 502);
  }
  if (campaignAcquire.kind === "completed") {
    campaignReadinessProbeGeneration(outcome.result, claim);
  } else {
    try {
      await finalizeClaimedShardActivationCampaign(
        env,
        outcome.result,
        claim,
        outcome.result_sha256,
      );
    } catch (error) {
      if (
        error instanceof ProtocolError &&
        [
          "shard_activation_campaign_readiness_ineligible",
          "shard_activation_probe_invalid",
        ].includes(error.code)
      ) {
        await sealCampaignFailureBestEffort(
          env,
          claim.campaignId,
          "readiness_rejected",
        );
      }
      throw error;
    }
  }
  await recordClaimedShardPlacementAttestation(
    env,
    stub,
    claim,
    outcome.result_sha256,
  );
  return shardPlacementReadinessResponse(
    verified,
    claim,
    prepared.actionGates,
    outcome,
    env,
  );
}

const handler: ExportedHandler<ControllerEnv> = {
  async fetch(request, env): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path === CONTROLLER_DISABLE_ATTESTATION_PATH) {
        return handleControllerDisableAttestationRequest(request, env);
      }
      if (path === SHARD_PLACEMENT_READINESS_PROBE_PATH) {
        return handleShardPlacementReadinessRequest(
          request,
          env,
          "readiness_probe",
        );
      }
      if (path === SHARD_PLACEMENT_READINESS_READBACK_PATH) {
        return handleShardPlacementReadinessRequest(
          request,
          env,
          "readiness_readback",
        );
      }
      if (path === INTERNAL_OPERATION_STATUS_PATH) {
        return handleOperationStatusRequest(request, env);
      }
      if (path === INTERNAL_OPERATION_STATUS_V2_PATH) {
        return handleOperationStatusV2Request(request, env);
      }
      if (path === INTERNAL_OPERATION_STATUS_V3_PATH) {
        return handleOperationStatusV3Request(request, env);
      }
      if (path === INTERNAL_OPERATION_STATUS_V4_PATH) {
        return handleOperationStatusV4Request(request, env);
      }
      if (path === INTERNAL_OPERATION_TERMINAL_ACK_PATH) {
        return handleTerminalAckRequest(request, env);
      }
      if (path === INTERNAL_OPERATION_TERMINAL_ACK_V2_PATH) {
        return handleTerminalAckV2Request(request, env);
      }
      if (path === INTERNAL_OPERATION_TERMINAL_ACK_V3_PATH) {
        return handleTerminalAckV3Request(request, env);
      }
      if (path === INTERNAL_STATUS_PATH) {
        await verifyStatusRequest(request, env);
        const actionGates = await campaignActionGateInventory(env);
        const jurisdictionPolicy = relayShardJurisdictionPolicy(env);
        const placementPolicy =
          shardPlacementAttestationWriterPolicy(env);
        const ringTransition = inspectRingTransition(
          env,
          Math.floor(Date.now() / 1000),
        );
        return controllerStatusV1Response({
          controller_enabled: env.CONTAINER_CONTROLLER_ENABLED === "true",
          execution_enabled: env.CONTAINER_EXECUTION_ENABLED === "true",
          protocol_version: Number(env.CONTAINER_PROTOCOL_VERSION),
          ring_generation: Number(env.CONTAINER_RING_GENERATION),
          shard_count: Number(env.CONTAINER_SHARD_COUNT),
          ring_transition_configured: ringTransition.configured,
          ring_transition_valid: ringTransition.valid,
          previous_ring_generation: ringTransition.previous_ring_generation,
          previous_shard_count: ringTransition.previous_shard_count,
          previous_ring_admission_started_at: ringTransition.admission_started_at,
          previous_ring_admission_until: ringTransition.admission_until,
          previous_ring_admission_open: ringTransition.admission_open,
          controller_version_id: env.CF_VERSION_METADATA.id,
          durable_object_jurisdiction: jurisdictionPolicy.jurisdiction,
          durable_object_jurisdiction_restricted: jurisdictionPolicy.restricted,
          durable_object_jurisdiction_enabled:
            env.CONTAINER_DURABLE_OBJECT_JURISDICTION_ENABLED === "true",
          durable_object_jurisdiction_staging_verified:
            env.CONTAINER_DURABLE_OBJECT_JURISDICTION_STAGING_VERIFIED === "true",
          shard_activation_write_enabled:
            env[SHARD_ACTIVATION_WRITE_ENABLED_ENV] === "true",
          shard_activation_candidate_build_configured: /^[0-9a-f]{64}$/.test(
            env.CONTAINER_SHARD_ACTIVATION_EXPECTED_RUNTIME_BUILD_ID,
          ),
          shard_placement_attestation_write_enabled: placementPolicy.enabled,
          shard_placement_attestation_staging_verified:
            placementPolicy.staging_verified,
          controller_service_name: env.CONTAINER_CONTROLLER_SERVICE_NAME,
          all_action_gates_false: actionGates.allActionGatesFalse,
          action_gate_inventory_sha256: actionGates.digestSha256,
          authority_current_secret_configured: authoritySecretConfigured(
            env.CONTAINER_AUTHORITY_CURRENT_SECRET,
          ),
          authority_previous_secret_configured:
            env.CONTAINER_AUTHORITY_PREVIOUS_SECRET !== undefined &&
            authoritySecretConfigured(env.CONTAINER_AUTHORITY_PREVIOUS_SECRET),
        });
      }
      if (path === INTERNAL_READINESS_PATH) {
        const verified = await verifyReadinessRequest(request, env);
        const campaignAcquire = await claimShardActivationCampaignBeforeWake(
          env,
          verified.probe,
          verified.claims.dispatch_id,
        );
        if (campaignAcquire === null) {
          if (env.CONTAINER_CONTROLLER_ENABLED !== "true") {
            return jsonError("container_controller_disabled", 503);
          }
          if (env.CONTAINER_READINESS_PROBE_ENABLED !== "true") {
            return jsonError("container_readiness_probe_disabled", 503);
          }
          if (
            verified.probe.wake_container &&
            env.CONTAINER_READINESS_WAKE_ENABLED !== "true"
          ) {
            return jsonError("container_readiness_wake_disabled", 503);
          }
          const stub = selectRelayShardNamespace(env).getByName(
            verified.probe.shard.instance_name,
          );
          const outcome = await stub.readinessProbe(
            verified.probe,
            verified.claims.dispatch_id,
          );
          if (!outcome.ok) return jsonError(outcome.error.code, outcome.error.status);
          return readinessResponse(verified.probe, verified.claims.dispatch_id, outcome.result);
        }

        const claim = campaignAcquire.claim;
        const shardProbe: ShardReadinessProbe = {
          protocol_version: verified.probe.protocol_version,
          shard: verified.probe.shard,
          wake_container: verified.probe.wake_container,
        };
        const stub = selectRelayShardNamespace(env).getByName(
          verified.probe.shard.instance_name,
        );
        let outcome: ShardReadinessRpcResultV2;
        try {
          outcome = await stub.readinessProbeV2(
            shardProbe,
            verified.claims.dispatch_id,
            claim.claimDigestSha256,
            campaignAcquire.kind === "completed",
          );
        } catch {
          return jsonError("readiness_probe_journal_unavailable", 503);
        }
        if (!outcome.ok) {
          if (
            campaignAcquire.kind === "claimed" &&
            [
              "readiness_probe_ambiguous",
              "readiness_probe_superseded",
              "readiness_probe_claim_mismatch",
              "readiness_probe_result_corrupt",
              "invalid_readiness_probe_result",
              "readiness_probe_completion_conflict",
            ].includes(outcome.error.code)
          ) {
            await sealCampaignFailureBestEffort(
              env,
              claim.campaignId,
              "claim_execution_failed",
            );
          }
          return jsonError(outcome.error.code, outcome.error.status);
        }
        if (
          campaignAcquire.kind === "completed" &&
          campaignAcquire.readinessResultSha256 !== outcome.result_sha256
        ) {
          return jsonError("readiness_probe_result_mismatch", 502);
        }
        if (campaignAcquire.kind === "completed") {
          campaignReadinessProbeGeneration(outcome.result, claim);
        } else {
          try {
            await finalizeClaimedShardActivationCampaign(
              env,
              outcome.result,
              claim,
              outcome.result_sha256,
            );
          } catch (error) {
            if (
              error instanceof ProtocolError &&
              [
                "shard_activation_campaign_readiness_ineligible",
                "shard_activation_probe_invalid",
              ].includes(error.code)
            ) {
              await sealCampaignFailureBestEffort(
                env,
                claim.campaignId,
                "readiness_rejected",
              );
            }
            throw error;
          }
        }
        await recordClaimedShardPlacementAttestation(
          env,
          stub,
          claim,
          outcome.result_sha256,
        );
        return readinessResponse(
          verified.probe,
          verified.claims.dispatch_id,
          outcome.result,
          outcome.result_sha256,
        );
      }
      if (path !== INTERNAL_OPERATION_PATH) return jsonError("route_not_found", 404);
      const verified = await verifyOperationRequest(request, env);
      if (env.CONTAINER_CONTROLLER_ENABLED !== "true") {
        return jsonError("container_controller_disabled", 503);
      }
      if (env.CONTAINER_EXECUTION_ENABLED !== "true") {
        return jsonError("container_execution_disabled", 503);
      }
      if (!operationRecoveryIntentWriterEnabled(env)) {
        return jsonError("operation_recovery_intent_v1_disabled", 503);
      }
      const stub = selectRelayShardNamespace(env).getByName(
        verified.envelope.shard.instance_name,
      );
      return await stub.fetch(
        new Request(`https://relay-shard.internal${INTERNAL_OPERATION_PATH}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [AUTHORITY_HEADER]: request.headers.get(AUTHORITY_HEADER) ?? "",
          },
          body: copyArrayBuffer(verified.body),
        }),
      );
    } catch (error) {
      return protocolErrorResponse(error);
    }
  },
};

export default handler;

function responseForExisting(row: OperationRow): Response {
  return operationOutcomeResponse(row);
}

interface LegacyOperationRecoveryPayload {
  operation_id: string;
  owner_generation: number;
  deadline_at: number;
}

function legacyOperationRecoverySchedule(
  schedule: LegacyOperationRecoverySchedule,
): LegacyOperationRecoveryPayload {
  return {
    operation_id: schedule.operation_id,
    owner_generation: schedule.owner_generation,
    deadline_at: schedule.deadline_at,
  };
}

function operationRecoveryCallbackErrorCode(error: unknown): string {
  if (
    error instanceof ProtocolError &&
    error.code.length <= 96 &&
    /^[a-z0-9_]+$/.test(error.code)
  ) {
    return error.code;
  }
  return "operation_recovery_callback_failed";
}

function finalizeOperationOutcome(
  ledger: RelayShardLedger,
  operationId: string,
  ownerGeneration: number,
  expectedStatus: "claimed" | "running",
  status: "completed" | "failed" | "recovery_required",
  responseStatus: number,
  responseCode: string | null,
  now: number,
  requireBeforeDeadline: boolean,
): OperationRow {
  try {
    return ledger.finalizeOperation(
      operationId,
      ownerGeneration,
      expectedStatus,
      status,
      responseStatus,
      responseCode,
      now,
      requireBeforeDeadline,
    );
  } catch (error) {
    if (error instanceof ProtocolError && error.code === "operation_completion_conflict") {
      const current = ledger.readOperationOutcome(operationId);
      if (
        current !== null &&
        current.owner_generation === ownerGeneration &&
        ["completed", "failed", "recovery_required"].includes(current.status)
      ) {
        return current;
      }
    }
    throw error;
  }
}

async function providerAttemptOutboundHandler(
  request: Request,
  env: Cloudflare.Env,
  context: { containerId: string },
): Promise<Response> {
  if (String(env.CONTAINER_PROVIDER_ATTEMPT_JOURNAL_ENABLED) !== "true") {
    await cancelRequestBody(request);
    return jsonError("provider_attempt_journal_disabled", 503);
  }
  const identity = storageOperationIdentity(request);
  if (identity === null) {
    await cancelRequestBody(request);
    return jsonError("provider_attempt_access_denied", 403);
  }
  let stub: DurableObjectStub<RelayShardContainer>;
  try {
    stub = relayShardStubByContainerId(env, context.containerId);
  } catch (error) {
    await cancelRequestBody(request);
    if (error instanceof ProtocolError) {
      return jsonError(error.code, error.status);
    }
    return jsonError("provider_attempt_access_denied", 403);
  }
  return handleProviderAttemptGatewayRequest(request, stub, identity);
}

async function providerEgressOutboundHandler(
  request: Request,
  env: Cloudflare.Env,
  context: { containerId: string },
): Promise<Response> {
  const identity = storageOperationIdentity(request);
  if (identity === null) {
    await cancelRequestBody(request);
    return jsonError("provider_egress_access_denied", 403);
  }
  let stub: DurableObjectStub<RelayShardContainer>;
  try {
    stub = relayShardStubByContainerId(env, context.containerId);
  } catch (error) {
    await cancelRequestBody(request);
    if (error instanceof ProtocolError) {
      return jsonError(error.code, error.status);
    }
    return jsonError("provider_egress_access_denied", 403);
  }
  return handleProviderEgressGatewayRequest(
    request,
    providerEgressEnv(env),
    stub,
    identity,
  );
}

function storageOutboundHandler(action: StorageGatewayAction) {
  return async (
    request: Request,
    env: Cloudflare.Env,
    context: { containerId: string },
  ): Promise<Response> => {
    if (!storageActionEnabled(action, env)) {
      await cancelRequestBody(request);
      return jsonError("storage_gateway_disabled", 503);
    }
    const identity = storageOperationIdentity(request);
    if (identity === null) {
      await cancelRequestBody(request);
      return jsonError("storage_access_denied", 403);
    }
    let stub: DurableObjectStub<RelayShardContainer>;
    try {
      stub = relayShardStubByContainerId(env, context.containerId);
    } catch (error) {
      await cancelRequestBody(request);
      if (error instanceof ProtocolError) {
        return jsonError(error.code, error.status);
      }
      return jsonError("storage_access_denied", 403);
    }
    const access = await stub.authorizeStorageAccess(
      identity.operationId,
      identity.ownerGeneration,
    );
    if (!access.ok) {
      await cancelRequestBody(request);
      return jsonError(access.error.code, access.error.status);
    }
    const gatewayGrant = gatewayStorageGrant(action, request, access.grant);
    if (gatewayGrant === null) {
      await cancelRequestBody(request);
      return jsonError("storage_access_denied", 403);
    }
    const response = await handleStorageGatewayRequest(storageGatewayEnv(env), request, gatewayGrant);
    if (gatewayGrant.action !== STORAGE_GATEWAY_ACTIONS.R2_RESULT_PUT || !response.ok) {
      return response;
    }
    return persistStorageResultResponse(stub, response, gatewayGrant);
  };
}

function relayShardStubByContainerId(
  env: Cloudflare.Env,
  containerId: string,
): DurableObjectStub<RelayShardContainer> {
  const namespace = selectRelayShardNamespace(env);
  return namespace.get(namespace.idFromString(containerId));
}

function storageActionEnabled(
  action: StorageGatewayAction,
  env: ContainerStorageRuntimeEnvironment,
): boolean {
  const value =
    action === STORAGE_GATEWAY_ACTIONS.R2_INPUT_GET
      ? env.CONTAINER_STORAGE_R2_READ_ENABLED
      : action === STORAGE_GATEWAY_ACTIONS.R2_RESULT_PUT
        ? env.CONTAINER_STORAGE_R2_WRITE_ENABLED
        : action === STORAGE_GATEWAY_ACTIONS.KV_CONFIG_GET
          ? env.CONTAINER_STORAGE_KV_READ_ENABLED
          : env.CONTAINER_STORAGE_D1_READ_ENABLED;
  return value === "true";
}

function storageOperationIdentity(
  request: Request,
): { operationId: string; ownerGeneration: number } | null {
  const operationId = request.headers.get(OPERATION_ID_HEADER);
  const generation = request.headers.get(OWNER_GENERATION_HEADER);
  if (
    operationId === null ||
    operationId.length < 1 ||
    operationId.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/.test(operationId) ||
    generation === null ||
    !/^[1-9]\d{0,15}$/.test(generation)
  ) {
    return null;
  }
  const ownerGeneration = Number(generation);
  return Number.isSafeInteger(ownerGeneration) ? { operationId, ownerGeneration } : null;
}

function gatewayStorageGrant(
  action: StorageGatewayAction,
  request: Request,
  grant: StorageAccessGrant,
): GatewayStorageAccessGrant | null {
  switch (action) {
    case STORAGE_GATEWAY_ACTIONS.R2_INPUT_GET:
      return grant.input.mode === "r2" &&
        grant.input.request_object_key !== null &&
        grant.input.object_version !== null
        ? {
            action,
            key: grant.input.request_object_key,
            version: grant.input.object_version,
            sha256: grant.input.sha256,
            size: grant.input.size,
            content_type: grant.input.content_type,
          }
        : null;
    case STORAGE_GATEWAY_ACTIONS.R2_RESULT_PUT: {
      const attemptGeneration = grant.provider_attempt?.attempt_generation ?? null;
      if (grant.provider_attempt !== null) {
        const requestedGeneration = request.headers.get(PROVIDER_ATTEMPT_GENERATION_HEADER);
        if (
          grant.provider_attempt.status !== "dispatched" ||
          requestedGeneration === null ||
          !/^[1-9]\d{0,2}$/.test(requestedGeneration) ||
          Number(requestedGeneration) !== attemptGeneration
        ) {
          return null;
        }
      }
      if (grant.result !== null) {
        return {
          action,
          operation_id: grant.operation_id,
          owner_generation: grant.owner_generation,
          provider_operation_id: grant.provider_operation_id,
          admission_sha256: grant.admission_sha256,
          attempt_generation: attemptGeneration,
          egress_profile: grant.provider_attempt?.egress_profile ?? null,
          egress_worker_version_id:
            grant.provider_attempt?.egress_worker_version_id ?? null,
          sha256: grant.result.sha256,
          size: grant.result.size,
          content_type: grant.result.content_type,
        };
      }
      const sha256 = request.headers.get(CONTENT_SHA256_HEADER);
      const contentLength = request.headers.get("content-length");
      const contentType = request.headers.get("content-type");
      if (
        sha256 === null ||
        !/^[0-9a-f]{64}$/.test(sha256) ||
        contentLength === null ||
        !/^\d+$/.test(contentLength) ||
        contentType === null
      ) {
        return null;
      }
      const size = Number(contentLength);
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_R2_OBJECT_BYTES) return null;
      return {
        action,
        operation_id: grant.operation_id,
        owner_generation: grant.owner_generation,
        provider_operation_id: grant.provider_operation_id,
        admission_sha256: grant.admission_sha256,
        attempt_generation: attemptGeneration,
        egress_profile: grant.provider_attempt?.egress_profile ?? null,
        egress_worker_version_id:
          grant.provider_attempt?.egress_worker_version_id ?? null,
        sha256,
        size,
        content_type: contentType,
      };
    }
    case STORAGE_GATEWAY_ACTIONS.KV_CONFIG_GET:
      return { action, operation_kind: grant.operation_kind };
    case STORAGE_GATEWAY_ACTIONS.D1_ADMISSION_GET:
      return {
        action,
        protocol_version: grant.protocol_version,
        operation_id: grant.operation_id,
        operation_kind: grant.operation_kind,
        owner_generation: grant.owner_generation,
        owner_lease_expires_at: grant.owner_lease_expires_at,
        execution_deadline_at: grant.deadline_at,
        provider_operation_id: grant.provider_operation_id,
        admission_sha256: grant.admission_sha256,
        input: {
          mode: grant.input.mode,
          sha256: grant.input.sha256,
          size: grant.input.size,
          content_type: grant.input.content_type,
          ...(grant.input.request_object_key === null
            ? {}
            : { request_object_key: grant.input.request_object_key }),
          ...(grant.input.object_version === null
            ? {}
            : { object_version: grant.input.object_version }),
        },
        shard: grant.shard,
        trace_id: grant.trace_id,
      };
  }
}

function storageGatewayEnv(
  env: Pick<ControllerEnv, "FILE_BUCKET" | "CONFIG_KV" | "DB">,
): StorageGatewayEnvironment {
  return {
    CONTAINER_STORAGE_GATEWAY_ENABLED: "true",
    CONTAINER_STORAGE_INPUT_R2: env.FILE_BUCKET,
    CONTAINER_STORAGE_RESULT_R2: env.FILE_BUCKET,
    CONTAINER_STORAGE_CONFIG_KV: env.CONFIG_KV,
    CONTAINER_STORAGE_ADMISSION_DB: env.DB,
  };
}

function providerEgressEnv(
  env: Pick<
    ControllerEnv,
    | "FILE_BUCKET"
    | "CONFIG_KV"
    | "DB"
    | "PROVIDER_EGRESS"
    | "CONTAINER_PROVIDER_EGRESS_ENABLED"
    | "CONTAINER_PROVIDER_RESPONSE_V3_PARSE_ENABLED"
    | "CONTAINER_PROVIDER_RESPONSE_RAW_WRITE_ENABLED"
    | "CONTAINER_PROVIDER_RESPONSE_CLIENT_WRITE_ENABLED"
    | "CONTAINER_PROVIDER_RESPONSE_TERMINAL_ENABLED"
  >,
): ProviderEgressGatewayEnvironment {
  return {
    ...storageGatewayEnv(env),
    CONTAINER_PROVIDER_EGRESS_ENABLED: env.CONTAINER_PROVIDER_EGRESS_ENABLED,
    CONTAINER_PROVIDER_RESPONSE_V3_PARSE_ENABLED:
      env.CONTAINER_PROVIDER_RESPONSE_V3_PARSE_ENABLED,
    CONTAINER_PROVIDER_RESPONSE_RAW_WRITE_ENABLED:
      env.CONTAINER_PROVIDER_RESPONSE_RAW_WRITE_ENABLED,
    CONTAINER_PROVIDER_RESPONSE_CLIENT_WRITE_ENABLED:
      env.CONTAINER_PROVIDER_RESPONSE_CLIENT_WRITE_ENABLED,
    CONTAINER_PROVIDER_RESPONSE_TERMINAL_ENABLED:
      env.CONTAINER_PROVIDER_RESPONSE_TERMINAL_ENABLED,
    PROVIDER_EGRESS: env.PROVIDER_EGRESS,
  };
}

async function persistStorageResultResponse(
  stub: DurableObjectStub<RelayShardContainer>,
  response: Response,
  grant: R2ResultPutGrant,
): Promise<Response> {
  const status = response.status;
  const headers = new Headers(response.headers);
  const objectVersion = response.headers.get(R2_OBJECT_VERSION_HEADER);
  if (
    objectVersion === null ||
    objectVersion.length < 1 ||
    objectVersion.length > MAX_STORAGE_OBJECT_VERSION_BYTES ||
    !/^[A-Za-z0-9._:-]+$/.test(objectVersion)
  ) {
    await response.body?.cancel("storage_result_invalid").catch(() => undefined);
    return jsonError("storage_result_invalid", 502);
  }
  let body: Uint8Array;
  try {
    body = await readBoundedResponse(response, 1024);
  } catch {
    return jsonError("storage_result_invalid", 502);
  }
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body),
    );
  } catch {
    return jsonError("storage_result_invalid", 502);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return jsonError("storage_result_invalid", 502);
  }
  const record = value as Record<string, unknown>;
  const expectedKey = deriveR2ResultKey(grant);
  if (
    record.key !== expectedKey ||
    record.sha256 !== grant.sha256 ||
    record.size !== grant.size ||
    typeof record.replayed !== "boolean" ||
    Object.keys(record).some(
      (key) => !["key", "sha256", "size", "replayed"].includes(key),
    )
  ) {
    return jsonError("storage_result_invalid", 502);
  }
  const persisted = await stub.recordStorageResult(grant.operation_id, grant.owner_generation, {
    object_key: expectedKey,
    object_version: objectVersion,
    sha256: grant.sha256,
    size: grant.size,
    content_type: grant.content_type,
  }, grant.attempt_generation ?? undefined);
  if (!persisted.ok) return jsonError(persisted.error.code, persisted.error.status);
  headers.set("content-length", String(body.byteLength));
  return new Response(body, { status, headers });
}

async function cancelRequestBody(request: Request): Promise<void> {
  if (request.body === null || request.bodyUsed) return;
  await request.body.cancel("storage_request_rejected").catch(() => undefined);
}

function providerAttemptRpcError(
  error: unknown,
): { ok: false; error: { code: string; status: number } } {
  if (error instanceof ProtocolError) {
    return { ok: false, error: { code: error.code, status: error.status } };
  }
  return { ok: false, error: { code: "provider_attempt_unavailable", status: 503 } };
}

function protocolErrorResponse(error: unknown): Response {
  if (error instanceof ProtocolError) return jsonError(error.code, error.status);
  console.error(JSON.stringify({ event: "container_controller_error", error_type: error instanceof Error ? error.name : typeof error }));
  return jsonError("container_controller_failure", 503);
}

function jsonError(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), { status, headers: jsonHeaders });
}

function configuredInteger(value: string, min: number, max: number): number {
  if (!/^\d+$/.test(value)) throw new ProtocolError("controller_misconfigured", 503);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ProtocolError("controller_misconfigured", 503);
  }
  return parsed;
}

function controllerLedgerPolicy(env: ControllerRuntimeEnvironment): RelayShardLedgerPolicy {
  return {
    maxInFlight: configuredInteger(env.CONTAINER_MAX_IN_FLIGHT_PER_SHARD, 1, 64),
    dispatchRetentionSeconds: DISPATCH_REPLAY_RETENTION_SECONDS,
    terminalRetentionSeconds: configuredInteger(
      env.CONTAINER_TERMINAL_RETENTION_SECONDS,
      DISPATCH_REPLAY_RETENTION_SECONDS,
      31_536_000,
    ),
    maxTerminalOperations: configuredInteger(env.CONTAINER_MAX_TERMINAL_OPERATIONS, 1, 1_000_000),
    globalTerminalCompactionEnabled:
      env.CONTAINER_GLOBAL_TERMINAL_COMPACTION_ENABLED === "true",
  };
}

function controllerProviderRetryPolicy(
  env: ControllerRuntimeEnvironment,
): ProviderRetryPolicy {
  const maxAttempts = configuredInteger(env.CONTAINER_MAX_PROVIDER_ATTEMPTS, 1, 3);
  const retryEnabled = env.CONTAINER_PROVIDER_RETRY_ENABLED === "true";
  // The DO retry scheduler and atomic provider egress broker are not live yet.
  if (retryEnabled || maxAttempts !== 1) {
    throw new ProtocolError("controller_misconfigured", 503);
  }
  return { maxAttempts, retryEnabled };
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function readBoundedResponse(
  response: Response,
  limit: number,
  deadlineAtMs?: number,
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > limit)) {
    throw new ProtocolError("container_response_too_large", 502);
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = deadlineAtMs === undefined
          ? await reader.read()
          : await withAbsoluteDeadline(
              reader.read(),
              deadlineAtMs,
              "container_readiness_timeout",
              504,
            );
      } catch (error) {
        await reader.cancel("container_response_aborted").catch(() => undefined);
        throw error;
      }
      if (next.done) break;
      total += next.value.byteLength;
      if (total > limit) {
        await reader.cancel("container_response_too_large");
        throw new ProtocolError("container_response_too_large", 502);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function withAbsoluteDeadline<T>(
  operation: Promise<T>,
  deadlineAtMs: number,
  code: string,
  status: number,
): Promise<T> {
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= 0) throw new ProtocolError(code, status);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new ProtocolError(code, status)), remainingMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function boundedLogValue(value: unknown): string {
  return String(value ?? "unknown").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 64);
}

function validatePersistedContainerResult(
  ledger: RelayShardLedger,
  envelope: OperationEnvelope,
  reported: StorageResultRecord | null,
): void {
  const row = ledger.readOperationOutcome(envelope.operation_id);
  if (row === null || row.owner_generation !== envelope.owner_generation) {
    throw new ProtocolError("container_result_unavailable", 502);
  }
  const persisted = operationStorageResult(row);
  if (reported === null && persisted === null) return;
  if (
    reported === null ||
    persisted === null ||
    reported.object_key !== persisted.object_key ||
    reported.object_version !== persisted.object_version ||
    reported.sha256 !== persisted.sha256 ||
    reported.size !== persisted.size ||
    reported.content_type !== persisted.content_type
  ) {
    throw new ProtocolError("container_result_mismatch", 502);
  }
}

function authoritySecretConfigured(secret: string): boolean {
  return new TextEncoder().encode(secret).length >= 32;
}

function containerStateSnapshot(state: Awaited<ReturnType<RelayShardContainer["getState"]>>): ContainerStateSnapshot {
  return {
    status: state.status,
    last_change_ms: state.lastChange,
    exit_code: "exitCode" in state ? state.exitCode ?? null : null,
  };
}

function validateRuntimeReadinessResponse(
  response: Response,
  body: Uint8Array,
): {
  protocol_version: number;
  shard_contract_version: number;
  runtime_build_id: string | null;
  execution_enabled: boolean;
} {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ProtocolError("invalid_container_readiness", 502);
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body));
  } catch {
    throw new ProtocolError("invalid_container_readiness", 502);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError("invalid_container_readiness", 502);
  }
  const record = value as Record<string, unknown>;
  const legacyKeys = [
    "status",
    "protocol_version",
    "shard_contract_version",
    "execution_enabled",
  ];
  const candidateKeys = [...legacyKeys, "runtime_build_id"];
  const keys = Object.keys(record);
  const exactLegacy =
    keys.length === legacyKeys.length && legacyKeys.every((key) => key in record);
  const exactCandidate =
    keys.length === candidateKeys.length && candidateKeys.every((key) => key in record);
  if (
    (!exactLegacy && !exactCandidate) ||
    record.status !== "ready" ||
    record.protocol_version !== 1 ||
    record.shard_contract_version !== 1 ||
    (exactCandidate &&
      (typeof record.runtime_build_id !== "string" ||
        !/^[0-9a-f]{64}$/.test(record.runtime_build_id))) ||
    typeof record.execution_enabled !== "boolean"
  ) {
    throw new ProtocolError("invalid_container_readiness", 502);
  }
  return {
    protocol_version: record.protocol_version,
    shard_contract_version: record.shard_contract_version,
    runtime_build_id: exactCandidate ? (record.runtime_build_id as string) : null,
    execution_enabled: record.execution_enabled,
  };
}
