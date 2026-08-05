import {
  JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_OPERATION_CONTRACT,
  JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_STABILITY_MINIMUM_SECONDS,
  executeJsonCompatibilityDeploymentTransition,
  validateJsonCompatibilityDeploymentTransitionAuthorization,
  validateJsonCompatibilityDeploymentTransitionReceipt,
  type JsonCompatibilityDeploymentTransitionReceiptV1,
} from "../../../tools/container_runtime_json_compatibility_deployment_transition.mjs";

import { canonicalJson, sha256Canonical } from "./canonical";
import {
  D1DeploymentTransitionJournal,
  TransitionRepositoryConflictError,
  TransitionRepositoryUnavailableError,
  readTransitionStatus,
  type TransitionRepositoryIdentity,
} from "./repository";

export const JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_STATUS_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-deployment-transition-status-v1";

const MAX_INVOCATION_BYTES = 1024 * 1024;
const STABILITY_CLOCK_GRANULARITY_PADDING_MILLISECONDS = 1000;
const SAFE_SERVICE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const SAFE_VERSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface DeploymentTransitionInvocation {
  readonly campaignPlan: unknown;
  readonly statePlan: unknown;
  readonly authorizedTransition: unknown;
}

export interface DeploymentTransitionLeafBinding {
  readDeploymentState(input: unknown): Promise<unknown>;
  mutateDeploymentOnce(input: unknown): Promise<unknown>;
}

export interface DeploymentTransitionSourceVerifierBinding {
  authenticateTransitionSource(input: unknown): Promise<unknown>;
}

type WidenGeneratedStringBindings<GeneratedEnv> = {
  [Key in keyof GeneratedEnv]: GeneratedEnv[Key] extends string
    ? string
    : GeneratedEnv[Key];
};

export type DeploymentTransitionEnv = Omit<
  WidenGeneratedStringBindings<
    JsonCompatibilityDeploymentTransitionGeneratedEnv
  >,
  | "CF_VERSION_METADATA"
  | "DB"
  | "JSON_COMPATIBILITY_DEPLOYMENT_LEAF"
  | "JSON_COMPATIBILITY_SOURCE_VERIFIER"
> & {
  readonly CF_VERSION_METADATA: { readonly id: string };
  readonly DB: D1Database;
  readonly JSON_COMPATIBILITY_DEPLOYMENT_LEAF:
    DeploymentTransitionLeafBinding;
  readonly JSON_COMPATIBILITY_SOURCE_VERIFIER:
    DeploymentTransitionSourceVerifierBinding;
};

export interface DeploymentTransitionRuntime {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

export interface DeploymentTransitionStatusV1 {
  readonly schemaVersion: 1;
  readonly contract:
    typeof JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_STATUS_CONTRACT;
  readonly environment: "staging";
  readonly classification: "not_found" | "inflight" | "terminal";
  readonly transitionResult: "completed" | "stopped" | null;
  readonly operationIdSha256: string;
  readonly operationDigestSha256: string;
  readonly authorizedRequestSha256: string;
  readonly coordinator: {
    readonly serviceName: string;
    readonly entrypoint: "JsonCompatibilityDeploymentTransitionEntrypoint";
    readonly versionId: string;
    readonly profileVersion: 1;
    readonly privateRpcOnly: true;
  };
  readonly operation: Readonly<Record<string, unknown>> | null;
  readonly events: readonly {
    readonly ordinal: number;
    readonly kind: string;
    readonly digestSha256: string;
    readonly recordedAt: number;
  }[];
  readonly eventCount: number;
  readonly mutationIntentCount: number;
  readonly mutationOutcomeCount: number;
  readonly sourceVerifierCalled: false;
  readonly deploymentLeafReadCalled: false;
  readonly deploymentLeafMutationCalled: false;
  readonly executionRetryPermitted: false;
  readonly receipt: JsonCompatibilityDeploymentTransitionReceiptV1 | null;
  readonly archivedAt: number | null;
  readonly observedAt: number;
  readonly statusDigestSha256: string;
}

const DEFAULT_RUNTIME: DeploymentTransitionRuntime = {
  now: () => Math.floor(Date.now() / 1000),
  sleep: async (milliseconds) => {
    await scheduler.wait(milliseconds);
  },
};

export async function executeDeploymentTransition(
  env: DeploymentTransitionEnv,
  input: unknown,
  runtime: DeploymentTransitionRuntime = DEFAULT_RUNTIME,
): Promise<JsonCompatibilityDeploymentTransitionReceiptV1> {
  const invocation = parseInvocation(input);
  const configuration = requireConfiguration(env, "execute");
  const journal = new D1DeploymentTransitionJournal(
    env.DB,
    repositoryIdentity(configuration),
  );
  return await executeJsonCompatibilityDeploymentTransition({
    campaignPlan: invocation.campaignPlan,
    statePlan: invocation.statePlan,
    authorizedTransition: invocation.authorizedTransition,
    dependencies: {
      now: () => runtimeNow(runtime),
      authenticateSource: async (sourceAuthenticationRequest) => {
        return await env.JSON_COMPATIBILITY_SOURCE_VERIFIER
          .authenticateTransitionSource(sourceAuthenticationRequest);
      },
      readback: async (readbackInput) => {
        if (readbackOrdinal(readbackInput) === 2) {
          await runtime.sleep(
            JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_STABILITY_MINIMUM_SECONDS
              * 1000
              + STABILITY_CLOCK_GRANULARITY_PADDING_MILLISECONDS,
          );
        }
        return await env.JSON_COMPATIBILITY_DEPLOYMENT_LEAF
          .readDeploymentState(readbackInput);
      },
      mutateOnce: async (mutationIntent) => {
        return await env.JSON_COMPATIBILITY_DEPLOYMENT_LEAF
          .mutateDeploymentOnce(mutationIntent);
      },
      journal,
    },
  });
}

export async function getDeploymentTransitionStatus(
  env: DeploymentTransitionEnv,
  input: unknown,
  runtime: DeploymentTransitionRuntime = DEFAULT_RUNTIME,
): Promise<DeploymentTransitionStatusV1> {
  const invocation = parseInvocation(input);
  const configuration = requireConfiguration(env, "status");
  const authorized = validateJsonCompatibilityDeploymentTransitionAuthorization(
    invocation.campaignPlan,
    invocation.statePlan,
    invocation.authorizedTransition,
  );
  const authorizedRequestSha256 = await sha256Canonical(authorized);
  const operationSubject = {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_OPERATION_CONTRACT,
    operationIdSha256: authorized.request.operationIdSha256,
    authorizedRequestSha256,
    campaignPlanDigestSha256:
      authorized.request.campaignPlan.planDigestSha256,
    statePlanDigestSha256: authorized.request.statePlan.planDigestSha256,
    transitionId: authorized.request.transition.id,
  };
  const operationDigestSha256 = await sha256Canonical(operationSubject);
  const snapshot = await readTransitionStatus(
    env.DB,
    authorized.request.operationIdSha256,
    operationDigestSha256,
  );
  let receipt: JsonCompatibilityDeploymentTransitionReceiptV1 | null = null;
  if (snapshot.receipt !== null) {
    receipt = validateJsonCompatibilityDeploymentTransitionReceipt(
      invocation.campaignPlan,
      invocation.statePlan,
      authorized,
      snapshot.receipt,
    );
  }
  const observedAt = runtimeNow(runtime);
  const body: Omit<
    DeploymentTransitionStatusV1,
    "statusDigestSha256"
  > = {
    schemaVersion: 1 as const,
    contract: JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_STATUS_CONTRACT,
    environment: "staging" as const,
    classification: snapshot.classification,
    transitionResult: receipt?.result ?? null,
    operationIdSha256: authorized.request.operationIdSha256,
    operationDigestSha256,
    authorizedRequestSha256,
    coordinator: {
      serviceName: configuration.serviceName,
      entrypoint:
        "JsonCompatibilityDeploymentTransitionEntrypoint" as const,
      versionId: configuration.versionId,
      profileVersion: 1 as const,
      privateRpcOnly: true as const,
    },
    operation: snapshot.operation,
    events: snapshot.events.map((event) => ({
      ordinal: event.event_ordinal,
      kind: event.event_kind,
      digestSha256: event.event_digest_sha256,
      recordedAt: event.recorded_at,
    })),
    eventCount: snapshot.events.length,
    mutationIntentCount: snapshot.events.filter(
      (event) => event.event_kind === "mutation_intent",
    ).length,
    mutationOutcomeCount: snapshot.events.filter(
      (event) => event.event_kind === "mutation_outcome",
    ).length,
    sourceVerifierCalled: false as const,
    deploymentLeafReadCalled: false as const,
    deploymentLeafMutationCalled: false as const,
    executionRetryPermitted: false as const,
    receipt,
    archivedAt: snapshot.archivedAt,
    observedAt,
  };
  return {
    ...body,
    statusDigestSha256: await sha256Canonical(body),
  };
}

interface TransitionConfiguration {
  readonly serviceName: string;
  readonly versionId: string;
  readonly deploymentLeafServiceName: string;
  readonly sourceVerifierServiceName: string;
}

function requireConfiguration(
  env: DeploymentTransitionEnv,
  purpose: "execute" | "status",
): TransitionConfiguration {
  if (
    env.ENVIRONMENT !== "staging"
    || env.JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_ENABLED !== "true"
    || env.JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_PROFILE_VERSION !== "1"
  ) {
    throw new DeploymentTransitionWorkerError("transition_worker_disabled");
  }
  if (
    purpose === "execute"
    && env.JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_EXECUTION_ENABLED
      !== "true"
  ) {
    throw new DeploymentTransitionWorkerError("transition_execution_disabled");
  }
  if (
    purpose === "status"
    && env.JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_STATUS_READ_ENABLED
      !== "true"
  ) {
    throw new DeploymentTransitionWorkerError("transition_status_disabled");
  }
  const serviceName = serviceNameValue(
    env.JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_SERVICE_NAME,
    "coordinator service name",
  );
  const deploymentLeafServiceName = serviceNameValue(
    env.JSON_COMPATIBILITY_DEPLOYMENT_LEAF_SERVICE_NAME,
    "deployment leaf service name",
  );
  const sourceVerifierServiceName = serviceNameValue(
    env.JSON_COMPATIBILITY_SOURCE_VERIFIER_SERVICE_NAME,
    "source verifier service name",
  );
  const versionId = versionValue(env.CF_VERSION_METADATA?.id);
  if (
    env.JSON_COMPATIBILITY_DEPLOYMENT_LEAF === null
    || typeof env.JSON_COMPATIBILITY_DEPLOYMENT_LEAF !== "object"
    || typeof env.JSON_COMPATIBILITY_DEPLOYMENT_LEAF.readDeploymentState
      !== "function"
    || typeof env.JSON_COMPATIBILITY_DEPLOYMENT_LEAF.mutateDeploymentOnce
      !== "function"
    || env.JSON_COMPATIBILITY_SOURCE_VERIFIER === null
    || typeof env.JSON_COMPATIBILITY_SOURCE_VERIFIER !== "object"
    || typeof env.JSON_COMPATIBILITY_SOURCE_VERIFIER
      .authenticateTransitionSource !== "function"
    || env.DB === null
    || typeof env.DB !== "object"
    || typeof env.DB.withSession !== "function"
  ) {
    throw new DeploymentTransitionWorkerError(
      "transition_worker_binding_invalid",
    );
  }
  return {
    serviceName,
    versionId,
    deploymentLeafServiceName,
    sourceVerifierServiceName,
  };
}

function repositoryIdentity(
  configuration: TransitionConfiguration,
): TransitionRepositoryIdentity {
  return {
    coordinatorVersionId: configuration.versionId,
    coordinatorProfileVersion: 1,
    deploymentLeafServiceName: configuration.deploymentLeafServiceName,
    sourceVerifierServiceName: configuration.sourceVerifierServiceName,
  };
}

function parseInvocation(input: unknown): DeploymentTransitionInvocation {
  if (!isRecord(input)) {
    throw new DeploymentTransitionWorkerError("invalid_transition_invocation");
  }
  const keys = Object.keys(input).sort();
  if (
    canonicalJson(keys)
      !== canonicalJson([
        "authorizedTransition",
        "campaignPlan",
        "statePlan",
      ])
  ) {
    throw new DeploymentTransitionWorkerError("invalid_transition_invocation");
  }
  let bytes: number;
  try {
    bytes = new TextEncoder().encode(canonicalJson(input)).byteLength;
  } catch {
    throw new DeploymentTransitionWorkerError("invalid_transition_invocation");
  }
  if (bytes < 2 || bytes > MAX_INVOCATION_BYTES) {
    throw new DeploymentTransitionWorkerError("transition_invocation_too_large");
  }
  return {
    campaignPlan: input.campaignPlan,
    statePlan: input.statePlan,
    authorizedTransition: input.authorizedTransition,
  };
}

function readbackOrdinal(input: unknown): number {
  if (!isRecord(input) || !Number.isSafeInteger(input.observationOrdinal)) {
    throw new DeploymentTransitionWorkerError("invalid_leaf_readback_request");
  }
  return input.observationOrdinal as number;
}

function runtimeNow(runtime: DeploymentTransitionRuntime): number {
  const now = runtime.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new DeploymentTransitionWorkerError("transition_clock_invalid");
  }
  return now;
}

function serviceNameValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_SERVICE_NAME.test(value)) {
    throw new DeploymentTransitionWorkerError(
      "transition_worker_identity_invalid",
      label,
    );
  }
  return value;
}

function versionValue(value: unknown): string {
  if (typeof value !== "string" || !SAFE_VERSION_ID.test(value)) {
    throw new DeploymentTransitionWorkerError(
      "transition_worker_identity_invalid",
      "coordinator version ID",
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class DeploymentTransitionWorkerError extends Error {
  constructor(readonly code: string, detail: string | null = null) {
    super(detail === null ? code : `${code}: ${detail}`);
    this.name = "DeploymentTransitionWorkerError";
  }
}

export function transitionWorkerErrorCode(error: unknown): string {
  if (error instanceof DeploymentTransitionWorkerError) return error.code;
  if (error instanceof TransitionRepositoryConflictError) return error.code;
  if (error instanceof TransitionRepositoryUnavailableError) {
    return error.outcomeUnknown
      ? "transition_repository_outcome_unknown"
      : "transition_repository_unavailable";
  }
  return "transition_worker_internal_error";
}
