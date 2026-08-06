import {
  buildJsonCompatibilityDeploymentResolutionReceipt,
  JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_MAX_DISABLE_EVIDENCE_AGE_SECONDS,
  validateJsonCompatibilityDeploymentExecutionDisabledEvidence,
  validateJsonCompatibilityDeploymentResolutionAuthorization,
  validateJsonCompatibilityDeploymentResolutionReceipt,
  type JsonCompatibilityDeploymentResolutionRequestV1,
  type JsonCompatibilityDeploymentResolutionReceiptV1,
} from "../../../tools/container_runtime_json_compatibility_deployment_resolution.mjs";
import {
  buildJsonCompatibilityDeploymentTransitionRecoveryReadbackRequest,
  classifyJsonCompatibilityDeploymentTransitionReadbackPair,
  validateJsonCompatibilityDeploymentTransitionReadback,
  type JsonCompatibilityDeploymentTransitionExpectedReadbackV2,
  type JsonCompatibilityDeploymentTransitionReadbackRequestV2,
  type JsonCompatibilityDeploymentTransitionReadbackV2,
} from "../../../tools/container_runtime_json_compatibility_deployment_transition.mjs";

import { canonicalJson, sha256Canonical } from
  "../../container-runtime-json-compatibility-deployment-transition/src/canonical";
import {
  D1ResolutionRepository,
  ResolutionRepositoryConflictError,
  ResolutionRepositoryUnavailableError,
  type ResolutionSnapshot,
  type ResolutionAppendResult,
  type ResolutionClaimInput,
  type ResolutionClaimResult,
  type ResolutionFinalizeInput,
  type ResolutionFinalizeResult,
  type ResolutionObservationInput,
} from "./repository";
import {
  RESOLUTION_ENTRYPOINT,
  parseDeploymentResolutionInvocation,
  parseResolutionJournalCheckpoint,
  requireDeploymentResolverIdentity,
  validateDeploymentResolutionContext,
  type DeploymentResolutionInvocation,
  type ResolutionIdentityEnv,
} from "./protocol";

export const JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_STATUS_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-deployment-resolution-status-v1";

const STABILITY_PADDING_MILLISECONDS = 1_000;
const STABILITY_SECONDS = 5;
const FORBIDDEN_RUNTIME_CAPABILITIES = [
  "JSON_COMPATIBILITY_DEPLOYMENT_MUTATION",
  "JSON_COMPATIBILITY_SOURCE_VERIFIER",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_DEPLOYMENT_READ_API_TOKEN",
  "CLOUDFLARE_DEPLOYMENT_MUTATION_API_TOKEN",
] as const;

export interface DeploymentResolutionReadbackBinding {
  readDeploymentStateForResolution(input: unknown): Promise<unknown>;
}

type WidenGeneratedStringBindings<GeneratedEnv> = {
  [Key in keyof GeneratedEnv]: GeneratedEnv[Key] extends string
    ? string
    : GeneratedEnv[Key];
};

export type DeploymentTransitionResolutionEnv = Omit<
  WidenGeneratedStringBindings<
    JsonCompatibilityDeploymentResolutionGeneratedEnv
  >,
  "CF_VERSION_METADATA" | "DB" | "JSON_COMPATIBILITY_DEPLOYMENT_READBACK"
> & ResolutionIdentityEnv & {
  readonly DB: D1Database;
  readonly JSON_COMPATIBILITY_DEPLOYMENT_READBACK:
    DeploymentResolutionReadbackBinding;
};

export type ReceiptV1 = JsonCompatibilityDeploymentResolutionReceiptV1;

export interface StatusV1 {
  readonly schemaVersion: 1;
  readonly contract:
    typeof JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_STATUS_CONTRACT;
  readonly environment: "staging";
  readonly classification:
    | "not_found"
    | "inflight"
    | "resolution_claimed"
    | "readback_inconclusive"
    | "terminal_receipt"
    | "final_resolution";
  readonly operationIdSha256: string;
  readonly operationDigestSha256: string;
  readonly claimGeneration: number;
  readonly resolver: {
    readonly serviceName: string;
    readonly entrypoint: typeof RESOLUTION_ENTRYPOINT;
    readonly versionId: string;
    readonly identitySha256: string;
    readonly privateRpcOnly: true;
    readonly mutationBindingPresent: false;
    readonly sourceVerifierBindingPresent: false;
  };
  readonly claim: unknown | null;
  readonly observationCount: number;
  readonly resolution: ReceiptV1 | null;
  readonly sourceVerifierCalled: false;
  readonly deploymentReadbackCalled: false;
  readonly deploymentMutationCalled: false;
  readonly executionRetryPermitted: false;
  readonly observedAt: number;
  readonly statusDigestSha256: string;
}

export interface DeploymentResolutionRuntime {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
  repository(database: D1Database): DeploymentResolutionRepository;
}

export interface DeploymentResolutionRepository {
  readSnapshot(
    operationIdSha256: string,
    expectedOperationDigestSha256: string,
  ): Promise<ResolutionSnapshot>;
  claim(input: ResolutionClaimInput): Promise<ResolutionClaimResult>;
  appendObservation(
    input: ResolutionObservationInput,
  ): Promise<ResolutionAppendResult>;
  finalize(input: ResolutionFinalizeInput): Promise<ResolutionFinalizeResult>;
}

const DEFAULT_RUNTIME: DeploymentResolutionRuntime = {
  now: () => Math.floor(Date.now() / 1_000),
  sleep: async (milliseconds) => {
    await scheduler.wait(milliseconds);
  },
  repository: (database) => new D1ResolutionRepository(database),
};

export async function resolveDeploymentTransitionInflight(
  env: DeploymentTransitionResolutionEnv,
  input: unknown,
  runtime: DeploymentResolutionRuntime = DEFAULT_RUNTIME,
): Promise<ReceiptV1> {
  const invocation = parseDeploymentResolutionInvocation(input);
  const configuration = requireExecutionConfiguration(env);
  const resolverIdentity = requireDeploymentResolverIdentity(env);
  const startedAt = runtimeNow(runtime);
  const context = validateDeploymentResolutionContext(
    invocation,
    resolverIdentity,
    startedAt,
    true,
  );
  const executionDisabledEvidence =
    validateJsonCompatibilityDeploymentExecutionDisabledEvidence(
      invocation.executionDisabledEvidence,
    );
  const authority = context.authorizedTransition.request.executionAuthority;
  const request = context.authorizedResolution.request;
  if (
    executionDisabledEvidence.evidenceSha256
      !== request.executionDisabledEvidenceSha256
    || executionDisabledEvidence.accountIdSha256 !== authority.accountIdSha256
    || executionDisabledEvidence.coordinatorServiceName
      !== authority.coordinator.serviceName
    || executionDisabledEvidence.coordinatorEntrypoint
      !== authority.coordinator.entrypoint
    || executionDisabledEvidence.coordinatorVersionId
      !== authority.coordinator.versionId
    || executionDisabledEvidence.coordinatorIdentitySha256
      !== authority.coordinator.identitySha256
    || executionDisabledEvidence.executionDisabledAt !== request.quiescedAt
    || executionDisabledEvidence.requiredQuiescenceSeconds
      !== request.requiredQuiescenceSeconds
    || executionDisabledEvidence.quiescenceSatisfiedAt
      !== request.settleNotBefore
    || executionDisabledEvidence.observedAt > startedAt
    || startedAt - executionDisabledEvidence.observedAt
      > JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_MAX_DISABLE_EVIDENCE_AGE_SECONDS
  ) {
    throw new DeploymentResolutionWorkerError(
      "deployment_resolution_execution_disabled_evidence_mismatch",
    );
  }
  const disabledEvidenceDigestSha256 =
    executionDisabledEvidence.evidenceSha256;
  const repository = runtime.repository(env.DB);
  const snapshot = await repository.readSnapshot(
    request.operation.operationIdSha256,
    request.operation.operationDigestSha256,
  );
  const existing = reusableResolution(
    snapshot,
    request.claimGeneration,
  );
  if (existing !== null) return existing;
  validateSnapshot(snapshot, context.authorizedResolution.request);
  const journal = snapshot.journal;
  if (journal === null) {
    throw new DeploymentResolutionWorkerError(
      "deployment_resolution_snapshot_mismatch",
    );
  }
  const checkpoint = parseResolutionJournalCheckpoint(
    snapshot.events,
    context.authorizedResolution,
  );
  if (
    checkpoint.originalSourceAuthentication === null
    || checkpoint.mutationIntent === null
    || checkpoint.sourceReadbacks.length !== 2
    || journal.pendingMutationIntentOrdinal === null
  ) {
    throw new DeploymentResolutionWorkerError(
      "deployment_resolution_checkpoint_not_readable",
    );
  }

  const firstRequest =
    buildJsonCompatibilityDeploymentTransitionRecoveryReadbackRequest({
      campaignPlan: invocation.campaignPlan,
      statePlan: invocation.statePlan,
      authorizedTransition: invocation.authorizedTransition,
      sourceAuthentication: invocation.sourceAuthentication,
      originalSourceAuthentication: checkpoint.originalSourceAuthentication,
      mutationIntent: checkpoint.mutationIntent,
      sourceReadbacks: checkpoint.sourceReadbacks,
      observationOrdinal: 1,
    }, { now: new Date(startedAt * 1_000) });
  const expectedTargetStateSha256 = await expectedRemoteStateSha256(
    firstRequest.expected,
    context.authorizedTransition.request.executionAuthority.readback
      .identitySha256,
  );
  const claimSubject = {
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-json-compatibility-deployment-resolution-claim-v1",
    resolutionRequestSha256: request.resolutionRequestSha256,
    operationIdSha256: request.operation.operationIdSha256,
    operationDigestSha256: request.operation.operationDigestSha256,
    generation: request.claimGeneration,
    journalHead: request.journalHead,
    pendingMutationIntentSha256: request.pendingMutationIntentSha256,
    sourceAuthenticationDigestSha256:
      request.sourceAuthenticationDigestSha256,
    sourceAuthenticationExpiresAt:
      request.sourceAuthenticationExpiresAt,
    authorizationExpiresAt:
      resolutionApprovalExpiresAt(context.authorizedResolution.approval),
    expectedTargetStateSha256,
    resolverIdentitySha256: resolverIdentity.identitySha256,
  };
  const claimDigestSha256 = await sha256Canonical(claimSubject);
  const authorizationDigestSha256 = approvalSubjectDigest(
    context.authorizedResolution.approval,
  );
  const claimResult = await repository.claim({
    operationIdSha256: request.operation.operationIdSha256,
    operationDigestSha256: request.operation.operationDigestSha256,
    generation: request.claimGeneration,
    claimDigestSha256,
    authorizationDigestSha256,
    resolverIdentitySha256: resolverIdentity.identitySha256,
    journalHeadOrdinal: request.journalHead.ordinal,
    journalHeadDigestSha256: requireDigest(
      request.journalHead.digestSha256,
      "resolution journal head",
    ),
    pendingMutationIntentOrdinal:
      journal.pendingMutationIntentOrdinal,
    pendingMutationIntentDigestSha256: requireDigest(
      request.pendingMutationIntentSha256,
      "resolution pending mutation intent",
    ),
    expectedTargetStateSha256,
    executionDisabledEvidenceDigestSha256:
      disabledEvidenceDigestSha256,
    executionDisabledEvidence,
    claim: claimSubject,
    quiescedAt: request.quiescedAt,
    settleNotBefore: request.settleNotBefore,
    sourceAuthenticationExpiresAt:
      request.sourceAuthenticationExpiresAt,
    authorizationExpiresAt:
      resolutionApprovalExpiresAt(context.authorizedResolution.approval),
    claimLeaseSeconds: request.claimLeaseSeconds,
  });
  if (claimResult.classification !== "created" || claimResult.claim === null) {
    throw new DeploymentResolutionWorkerError(
      claimResult.classification === "exact_replay"
        ? "deployment_resolution_claim_inflight"
        : `deployment_resolution_claim_${claimResult.classification}`,
    );
  }

  const readbackRequests:
    JsonCompatibilityDeploymentTransitionReadbackRequestV2[] = [];
  const observations: JsonCompatibilityDeploymentTransitionReadbackV2[] = [];
  for (const observationOrdinal of [1, 2] as const) {
    if (observationOrdinal === 2) {
      await runtime.sleep(
        STABILITY_SECONDS * 1_000 + STABILITY_PADDING_MILLISECONDS,
      );
    }
    const now = runtimeNow(runtime);
    const readbackRequest = observationOrdinal === 1
      ? firstRequest
      : buildJsonCompatibilityDeploymentTransitionRecoveryReadbackRequest({
          campaignPlan: invocation.campaignPlan,
          statePlan: invocation.statePlan,
          authorizedTransition: invocation.authorizedTransition,
          sourceAuthentication: invocation.sourceAuthentication,
          originalSourceAuthentication:
            checkpoint.originalSourceAuthentication,
          mutationIntent: checkpoint.mutationIntent,
          sourceReadbacks: checkpoint.sourceReadbacks,
          observationOrdinal,
        }, { now: new Date(now * 1_000) });
    const raw = await configuration.readback.readDeploymentStateForResolution({
      campaignPlan: invocation.campaignPlan,
      statePlan: invocation.statePlan,
      authorizedTransition: invocation.authorizedTransition,
      authorizedResolution: invocation.authorizedResolution,
      sourceAuthentication: invocation.sourceAuthentication,
      originalSourceAuthentication: checkpoint.originalSourceAuthentication,
      mutationIntent: checkpoint.mutationIntent,
      sourceReadbacks: checkpoint.sourceReadbacks,
      readbackRequest,
    });
    readbackRequests.push(readbackRequest);
    const observation =
      validateJsonCompatibilityDeploymentTransitionReadback(raw);
    if (observation.readbackRequestSha256 !== readbackRequest.readbackRequestSha256) {
      throw new DeploymentResolutionWorkerError(
        "deployment_resolution_readback_request_mismatch",
      );
    }
    if (
      observation.readbackServiceIdentitySha256
        !== context.authorizedTransition.request.executionAuthority.readback
          .identitySha256
    ) {
      throw new DeploymentResolutionWorkerError(
        "deployment_resolution_readback_identity_mismatch",
      );
    }
    const persisted = await repository.appendObservation({
      operationIdSha256: request.operation.operationIdSha256,
      operationDigestSha256: request.operation.operationDigestSha256,
      generation: request.claimGeneration,
      claimDigestSha256,
      observationOrdinal,
      requestDigestSha256: readbackRequest.readbackRequestSha256,
      request: readbackRequest,
      observationDigestSha256: observation.observationDigestSha256,
      observation,
      observedStateSha256:
        observation.remoteStateSha256 ?? observation.observationDigestSha256,
      readbackVersionId: request.readback.versionId as string,
      readbackIdentitySha256:
        context.authorizedTransition.request.executionAuthority.readback
          .identitySha256,
    });
    if (persisted.classification === "conflict" || persisted.observation === null) {
      throw new DeploymentResolutionWorkerError(
        "deployment_resolution_observation_conflict",
      );
    }
    observations.push(
      validateJsonCompatibilityDeploymentTransitionReadback(
        persisted.observation.observation,
      ),
    );
  }

  const pair = classifyJsonCompatibilityDeploymentTransitionReadbackPair(
    observations,
    firstRequest.expected,
  );
  const [classification, reasonCode] = resolutionClassification(pair);
  const finishedAt = runtimeNow(runtime);
  const receipt = buildJsonCompatibilityDeploymentResolutionReceipt({
    campaignPlan: invocation.campaignPlan,
    statePlan: invocation.statePlan,
    authorizedTransition: invocation.authorizedTransition,
    authorizedResolution: invocation.authorizedResolution,
    sourceAuthentication: invocation.sourceAuthentication,
    originalSourceAuthentication: checkpoint.originalSourceAuthentication,
    sourceReadbacks: checkpoint.sourceReadbacks,
    mutationIntent: checkpoint.mutationIntent,
    mutationOutcome: checkpoint.mutationOutcome,
    targetReadbackRequests: readbackRequests,
    targetReadbacks: observations,
    startedAt,
    finishedAt,
    classification,
    reasonCode,
  });
  const finalized = await repository.finalize({
    operationIdSha256: request.operation.operationIdSha256,
    operationDigestSha256: request.operation.operationDigestSha256,
    generation: request.claimGeneration,
    claimDigestSha256,
    classification,
    observationOneDigestSha256: observations[0]?.observationDigestSha256 ?? null,
    observationTwoDigestSha256: observations[1]?.observationDigestSha256 ?? null,
    resolutionDigestSha256: receipt.resolutionReceiptSha256,
    resolution: receipt,
  });
  if (finalized.classification === "conflict" || finalized.outcome === null) {
    throw new DeploymentResolutionWorkerError(
      "deployment_resolution_finalize_conflict",
    );
  }
  const persisted = validateJsonCompatibilityDeploymentResolutionReceipt(
    finalized.outcome.resolution,
  );
  if (canonicalJson(persisted) !== canonicalJson(receipt)) {
    throw new DeploymentResolutionWorkerError(
      "deployment_resolution_finalize_mismatch",
    );
  }
  return persisted;
}

export async function getDeploymentTransitionResolutionStatus(
  env: DeploymentTransitionResolutionEnv,
  input: unknown,
  runtime: DeploymentResolutionRuntime = DEFAULT_RUNTIME,
): Promise<StatusV1> {
  const invocation = parseDeploymentResolutionInvocation(input);
  requireStatusConfiguration(env);
  const resolverIdentity = requireDeploymentResolverIdentity(env);
  const authorization =
    validateJsonCompatibilityDeploymentResolutionAuthorization(
      invocation.campaignPlan,
      invocation.statePlan,
      invocation.authorizedTransition,
      invocation.authorizedResolution,
    );
  if (
    canonicalJson(authorization.request.resolver)
      !== canonicalJson(resolverIdentity)
  ) {
    throw new DeploymentResolutionWorkerError(
      "deployment_resolution_identity_mismatch",
    );
  }
  const repository = runtime.repository(env.DB);
  const snapshot = await repository.readSnapshot(
    authorization.request.operation.operationIdSha256,
    authorization.request.operation.operationDigestSha256,
  );
  const resolution = snapshot.outcome === null
    ? null
    : validateJsonCompatibilityDeploymentResolutionReceipt(
        snapshot.outcome.resolution,
      );
  const observedAt = runtimeNow(runtime);
  const body: Omit<StatusV1, "statusDigestSha256"> = {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_STATUS_CONTRACT,
    environment: "staging",
    classification: snapshot.classification,
    operationIdSha256: authorization.request.operation.operationIdSha256,
    operationDigestSha256: authorization.request.operation.operationDigestSha256,
    claimGeneration: authorization.request.claimGeneration,
    resolver: {
      serviceName: resolverIdentity.serviceName,
      entrypoint: RESOLUTION_ENTRYPOINT,
      versionId: resolverIdentity.versionId,
      identitySha256: resolverIdentity.identitySha256,
      privateRpcOnly: true,
      mutationBindingPresent: false,
      sourceVerifierBindingPresent: false,
    },
    claim: snapshot.claim,
    observationCount: snapshot.observations.length,
    resolution,
    sourceVerifierCalled: false,
    deploymentReadbackCalled: false,
    deploymentMutationCalled: false,
    executionRetryPermitted: false,
    observedAt,
  };
  return { ...body, statusDigestSha256: await sha256Canonical(body) };
}

function requireBaseConfiguration(
  env: DeploymentTransitionResolutionEnv,
): { readonly readback: DeploymentResolutionReadbackBinding } {
  for (const binding of FORBIDDEN_RUNTIME_CAPABILITIES) {
    if (binding in env) {
      throw new DeploymentResolutionWorkerError(
        "deployment_resolution_forbidden_capability_present",
      );
    }
  }
  if (
    env.ENVIRONMENT !== "staging"
    || env.JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_ENABLED !== "true"
  ) {
    throw new DeploymentResolutionWorkerError(
      "deployment_resolution_worker_disabled",
    );
  }
  if (
    env.JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_ENTRYPOINT
      !== RESOLUTION_ENTRYPOINT
    || env.JSON_COMPATIBILITY_DEPLOYMENT_READBACK_ENTRYPOINT
      !== "JsonCompatibilityDeploymentReadbackEntrypoint"
    || env.DB === null
    || typeof env.DB !== "object"
    || typeof env.DB.withSession !== "function"
    || env.JSON_COMPATIBILITY_DEPLOYMENT_READBACK === null
    || typeof env.JSON_COMPATIBILITY_DEPLOYMENT_READBACK !== "object"
    || typeof env.JSON_COMPATIBILITY_DEPLOYMENT_READBACK
      .readDeploymentStateForResolution !== "function"
  ) {
    throw new DeploymentResolutionWorkerError(
      "deployment_resolution_binding_invalid",
    );
  }
  return { readback: env.JSON_COMPATIBILITY_DEPLOYMENT_READBACK };
}

function requireExecutionConfiguration(
  env: DeploymentTransitionResolutionEnv,
): { readonly readback: DeploymentResolutionReadbackBinding } {
  if (
    env.JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_EXECUTION_ENABLED !== "true"
  ) {
    throw new DeploymentResolutionWorkerError(
      "deployment_resolution_execution_disabled",
    );
  }
  return requireBaseConfiguration(env);
}

function requireStatusConfiguration(
  env: DeploymentTransitionResolutionEnv,
): void {
  if (
    env.JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_STATUS_READ_ENABLED !== "true"
  ) {
    throw new DeploymentResolutionWorkerError(
      "deployment_resolution_status_disabled",
    );
  }
  requireBaseConfiguration(env);
}

function validateSnapshot(
  snapshot: ResolutionSnapshot,
  request: JsonCompatibilityDeploymentResolutionRequestV1,
): void {
  if (snapshot.classification === "not_found" || snapshot.operation === null) {
    throw new DeploymentResolutionWorkerError(
      "deployment_resolution_operation_not_found",
    );
  }
  if (snapshot.classification === "terminal_receipt") {
    throw new DeploymentResolutionWorkerError(
      "deployment_resolution_not_required",
    );
  }
  const operation = request.operation;
  const readback = request.readback;
  const journalHead = request.journalHead;
  if (
    snapshot.operation.operationIdSha256 !== operation.operationIdSha256
    || snapshot.operation.operationDigestSha256 !== operation.operationDigestSha256
    || snapshot.operation.createdAt !== request.operationCreatedAt
    || snapshot.operation.executionAuthorityDigestSha256
      !== request.executionAuthoritySha256
    || snapshot.operation.readbackVersionId !== readback.versionId
    || snapshot.operation.readbackIdentitySha256 !== readback.identitySha256
    || snapshot.journal === null
    || snapshot.journal.headOrdinal !== journalHead.ordinal
    || snapshot.journal.headDigestSha256 !== journalHead.digestSha256
    || snapshot.journal.pendingMutationIntentDigestSha256
      !== request.pendingMutationIntentSha256
  ) {
    throw new DeploymentResolutionWorkerError(
      "deployment_resolution_snapshot_mismatch",
    );
  }
}

function reusableResolution(
  snapshot: ResolutionSnapshot,
  requestedGeneration: number,
): ReceiptV1 | null {
  if (snapshot.outcome === null) return null;
  if (
    snapshot.outcome.classification === "readback_inconclusive"
    && snapshot.outcome.generation !== requestedGeneration
  ) return null;
  return validateJsonCompatibilityDeploymentResolutionReceipt(
    snapshot.outcome.resolution,
  );
}

async function expectedRemoteStateSha256(
  expected: JsonCompatibilityDeploymentTransitionExpectedReadbackV2,
  readbackServiceIdentitySha256: string,
): Promise<string> {
  return await sha256Canonical({
    environment: expected.environment,
    accountIdSha256: expected.accountIdSha256,
    serviceName: expected.serviceName,
    entrypoint: expected.entrypoint,
    versionId: expected.versionId,
    configSha256: expected.configSha256,
    deploymentState: expected.deploymentState,
    gates: expected.gates,
    privateRpcOnly: expected.privateRpcOnly,
    workersDev: expected.workersDev,
    previewUrls: expected.previewUrls,
    bindingSetSha256: expected.bindingSetSha256,
    routeSetSha256: expected.routeSetSha256,
    secretNameSetSha256: expected.secretNameSetSha256,
    durableObjectMigrationSetSha256:
      expected.durableObjectMigrationSetSha256,
    readbackServiceIdentitySha256,
    authenticationIdentitySha256: expected.authenticationIdentitySha256,
  });
}

function resolutionClassification(
  pair: "stable" | "ambiguous" | "drift" | "unstable",
): readonly [
  "target_confirmed" | "manual_review_required" | "readback_inconclusive",
  "target_state_confirmed" | "target_state_drift" | "target_state_ambiguous"
    | "target_state_unstable",
] {
  if (pair === "stable") return ["target_confirmed", "target_state_confirmed"];
  if (pair === "drift") {
    return ["manual_review_required", "target_state_drift"];
  }
  return [
    "readback_inconclusive",
    pair === "ambiguous" ? "target_state_ambiguous" : "target_state_unstable",
  ];
}

function approvalSubjectDigest(
  approval: Readonly<Record<string, unknown>>,
): string {
  return requireDigest(
    approval.subjectSha256,
    "resolution authorization digest",
  );
}

function resolutionApprovalExpiresAt(
  approval: Readonly<Record<string, unknown>>,
): number {
  const subject = approval.subject;
  if (typeof subject !== "object" || subject === null || Array.isArray(subject)) {
    throw new DeploymentResolutionWorkerError(
      "deployment_resolution_authorization_invalid",
    );
  }
  const expiresAt = (subject as Readonly<Record<string, unknown>>).expiresAt;
  if (!Number.isSafeInteger(expiresAt) || (expiresAt as number) < 0) {
    throw new DeploymentResolutionWorkerError(
      "deployment_resolution_authorization_invalid",
    );
  }
  return expiresAt as number;
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new DeploymentResolutionWorkerError(
      "deployment_resolution_authorization_invalid",
      label,
    );
  }
  return value;
}

function runtimeNow(runtime: DeploymentResolutionRuntime): number {
  const value = runtime.now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DeploymentResolutionWorkerError(
      "deployment_resolution_clock_invalid",
    );
  }
  return value;
}

export class DeploymentResolutionWorkerError extends Error {
  constructor(readonly code: string, detail: string | null = null) {
    super(detail === null ? code : `${code}: ${detail}`);
    this.name = "DeploymentResolutionWorkerError";
  }
}

export function deploymentResolutionWorkerErrorCode(error: unknown): string {
  if (error instanceof DeploymentResolutionWorkerError) return error.code;
  if (error instanceof ResolutionRepositoryConflictError) return error.code;
  if (error instanceof ResolutionRepositoryUnavailableError) {
    return error.outcomeUnknown
      ? "deployment_resolution_repository_outcome_unknown"
      : "deployment_resolution_repository_unavailable";
  }
  return "deployment_resolution_worker_internal_error";
}
