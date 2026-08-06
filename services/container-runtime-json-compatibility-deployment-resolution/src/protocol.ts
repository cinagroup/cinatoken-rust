import {
  buildJsonCompatibilityDeploymentResolverIdentity,
  validateJsonCompatibilityDeploymentResolutionAuthorization,
  type JsonCompatibilityAuthorizedDeploymentResolutionV1,
  type JsonCompatibilityDeploymentResolverIdentityV1,
} from "../../../tools/container_runtime_json_compatibility_deployment_resolution.mjs";
import {
  validateJsonCompatibilityDeploymentTransitionMutationIntent,
  validateJsonCompatibilityDeploymentTransitionMutationOutcome,
  validateJsonCompatibilityDeploymentTransitionReadback,
  validateJsonCompatibilityDeploymentTransitionRecoveryContext,
  type JsonCompatibilityAuthorizedDeploymentTransitionV2,
  type JsonCompatibilityDeploymentTransitionMutationIntentV2,
  type JsonCompatibilityDeploymentTransitionReadbackV2,
} from "../../../tools/container_runtime_json_compatibility_deployment_transition.mjs";

import { canonicalJson } from "../../container-runtime-json-compatibility-deployment-transition/src/canonical";

export const RESOLUTION_SERVICE_NAME =
  "cinatoken-container-runtime-json-compatibility-deployment-resolution-staging";
export const RESOLUTION_ENTRYPOINT =
  "JsonCompatibilityDeploymentTransitionResolutionEntrypoint";
export const RESOLUTION_PROFILE_VERSION = 1;

const MAX_INVOCATION_BYTES = 2 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_VERSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface DeploymentResolutionInvocation {
  readonly campaignPlan: unknown;
  readonly statePlan: unknown;
  readonly authorizedTransition: unknown;
  readonly authorizedResolution: unknown;
  readonly sourceAuthentication: unknown;
  readonly executionDisabledEvidence: unknown;
}

export interface ResolutionIdentityEnv {
  readonly CF_VERSION_METADATA: { readonly id: string };
  readonly ENVIRONMENT: string;
  readonly JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_PROFILE_VERSION: string;
  readonly JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_SERVICE_NAME: string;
  readonly JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_ACCOUNT_ID_SHA256: string;
  readonly JSON_COMPATIBILITY_DEPLOYMENT_READBACK_SERVICE_NAME: string;
}

export interface ResolutionJournalEventRow {
  readonly event_ordinal: number;
  readonly event_kind: string;
  readonly event_digest_sha256: string;
  readonly event_json: string;
  readonly recorded_at: number;
}

export interface ValidatedDeploymentResolutionContext {
  readonly invocation: DeploymentResolutionInvocation;
  readonly authorizedTransition:
    JsonCompatibilityAuthorizedDeploymentTransitionV2;
  readonly authorizedResolution:
    JsonCompatibilityAuthorizedDeploymentResolutionV1;
  readonly sourceAuthentication: unknown;
  readonly resolverIdentity: JsonCompatibilityDeploymentResolverIdentityV1;
}

export interface ResolutionJournalCheckpoint {
  readonly originalSourceAuthentication: Readonly<Record<string, unknown>> | null;
  readonly sourceReadbacks:
    readonly JsonCompatibilityDeploymentTransitionReadbackV2[];
  readonly mutationIntent:
    JsonCompatibilityDeploymentTransitionMutationIntentV2 | null;
  readonly mutationOutcome: Readonly<Record<string, unknown>> | null;
}

export function parseDeploymentResolutionInvocation(
  input: unknown,
): DeploymentResolutionInvocation {
  const value = record(input, "deployment resolution invocation");
  exactKeys(value, [
    "campaignPlan",
    "statePlan",
    "authorizedTransition",
    "authorizedResolution",
    "sourceAuthentication",
    "executionDisabledEvidence",
  ], "deployment resolution invocation");
  const bytes = new TextEncoder().encode(canonicalJson(value)).byteLength;
  if (bytes < 2 || bytes > MAX_INVOCATION_BYTES) {
    throw new Error("deployment resolution invocation is outside its byte limit");
  }
  return {
    campaignPlan: value.campaignPlan,
    statePlan: value.statePlan,
    authorizedTransition: value.authorizedTransition,
    authorizedResolution: value.authorizedResolution,
    sourceAuthentication: value.sourceAuthentication,
    executionDisabledEvidence: value.executionDisabledEvidence,
  };
}

export function requireDeploymentResolverIdentity(
  env: ResolutionIdentityEnv,
): JsonCompatibilityDeploymentResolverIdentityV1 {
  if (
    env.ENVIRONMENT !== "staging"
    || env.JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_PROFILE_VERSION !== "1"
    || env.JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_SERVICE_NAME
      !== RESOLUTION_SERVICE_NAME
  ) {
    throw new Error("deployment resolver runtime profile is invalid");
  }
  requireSha256(
    env.JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_ACCOUNT_ID_SHA256,
    "deployment resolver account ID",
  );
  if (
    env.JSON_COMPATIBILITY_DEPLOYMENT_READBACK_SERVICE_NAME
      !== "cinatoken-container-runtime-json-compatibility-deployment-readback-staging"
  ) {
    throw new Error("deployment resolver Reader service is invalid");
  }
  const versionId = env.CF_VERSION_METADATA?.id;
  if (typeof versionId !== "string" || !SAFE_VERSION_ID.test(versionId)) {
    throw new Error("deployment resolver version metadata is invalid");
  }
  return buildJsonCompatibilityDeploymentResolverIdentity({
    accountIdSha256:
      env.JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_ACCOUNT_ID_SHA256,
    serviceName: RESOLUTION_SERVICE_NAME,
    entrypoint: RESOLUTION_ENTRYPOINT,
    versionId,
    profileVersion: RESOLUTION_PROFILE_VERSION,
    privateRpcOnly: true,
    capability: "resolve-readback-only",
  });
}

export function validateDeploymentResolutionContext(
  invocation: DeploymentResolutionInvocation,
  resolverIdentity: JsonCompatibilityDeploymentResolverIdentityV1,
  now: number,
  requireUsableWindow: boolean,
): ValidatedDeploymentResolutionContext {
  const authorizedResolution =
    validateJsonCompatibilityDeploymentResolutionAuthorization(
      invocation.campaignPlan,
      invocation.statePlan,
      invocation.authorizedTransition,
      invocation.authorizedResolution,
      {
        now: new Date(now * 1000),
        requireUsableWindow,
        requireCompleteLeaseWindow: requireUsableWindow,
      },
    );
  if (
    canonicalJson(authorizedResolution.request.resolver)
      !== canonicalJson(resolverIdentity)
  ) {
    throw new Error("deployment resolver identity is not owner authorized");
  }
  const recovery = validateJsonCompatibilityDeploymentTransitionRecoveryContext(
    {
      campaignPlan: invocation.campaignPlan,
      statePlan: invocation.statePlan,
      authorizedTransition: invocation.authorizedTransition,
      sourceAuthentication: invocation.sourceAuthentication,
    },
    { now: new Date(now * 1000) },
  );
  if (
    recovery.sourceAuthentication.sourceAuthenticationDigestSha256
      !== authorizedResolution.request.sourceAuthenticationDigestSha256
    || recovery.sourceAuthentication.verifiedAt
      !== authorizedResolution.request.sourceAuthenticationVerifiedAt
  ) {
    throw new Error(
      "deployment resolution source authentication is not owner authorized",
    );
  }
  return {
    invocation,
    authorizedTransition: recovery.authorizedTransition,
    authorizedResolution,
    sourceAuthentication: recovery.sourceAuthentication,
    resolverIdentity,
  };
}

export function parseResolutionJournalCheckpoint(
  rows: readonly ResolutionJournalEventRow[],
  authorizedResolution: JsonCompatibilityAuthorizedDeploymentResolutionV1,
): ResolutionJournalCheckpoint {
  const request = authorizedResolution.request;
  if (rows.length !== request.journalHead.ordinal) {
    throw new Error("deployment resolution journal head ordinal drifted");
  }
  const events = rows.map((row, index) => {
    if (
      row.event_ordinal !== index + 1
      || !Number.isSafeInteger(row.recorded_at)
      || row.recorded_at < 0
      || !SHA256.test(row.event_digest_sha256)
    ) {
      throw new Error("deployment resolution journal row is invalid");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.event_json);
    } catch {
      throw new Error("deployment resolution journal event is invalid JSON");
    }
    const event = record(parsed, "deployment resolution journal event");
    exactKeys(event, ["kind", "digestSha256", "payload"],
      "deployment resolution journal event");
    if (
      event.kind !== row.event_kind
      || event.digestSha256 !== row.event_digest_sha256
    ) {
      throw new Error("deployment resolution journal event drifted");
    }
    return {
      kind: row.event_kind,
      digestSha256: row.event_digest_sha256,
      payload: event.payload,
    };
  });
  const head = events.at(-1) ?? null;
  if (
    (head?.digestSha256 ?? null) !== request.journalHead.digestSha256
  ) {
    throw new Error("deployment resolution journal head digest drifted");
  }

  const sourceAuthenticationEvent = events.find(
    (event) => event.kind === "source_authentication",
  );
  const originalSourceAuthentication = sourceAuthenticationEvent === undefined
    ? null
    : sourceAuthentication(sourceAuthenticationEvent.payload);
  if (
    originalSourceAuthentication !== null
    && originalSourceAuthentication.sourceAuthenticationDigestSha256
      !== sourceAuthenticationEvent?.digestSha256
  ) {
    throw new Error("deployment resolution source authentication drifted");
  }

  if (request.pendingMutationIntentSha256 === null) {
    if (events.some((event) => event.kind === "mutation_intent")) {
      throw new Error("deployment resolution pending intent is detached");
    }
    return {
      originalSourceAuthentication,
      sourceReadbacks: [],
      mutationIntent: null,
      mutationOutcome: null,
    };
  }

  const intentIndex = events.findIndex((event) =>
    event.kind === "mutation_intent"
    && event.digestSha256 === request.pendingMutationIntentSha256);
  if (intentIndex < 2) {
    throw new Error("deployment resolution pending intent is absent");
  }
  if (
    events.slice(intentIndex + 1).some((event) =>
      event.kind === "mutation_intent")
  ) {
    throw new Error("deployment resolution pending intent is not the journal tail");
  }
  const mutationIntent =
    validateJsonCompatibilityDeploymentTransitionMutationIntent(
      events[intentIndex]?.payload,
    );
  if (
    mutationIntent.mutationIntentSha256
      !== request.pendingMutationIntentSha256
  ) {
    throw new Error("deployment resolution mutation intent drifted");
  }
  const sourceRows = events.slice(intentIndex - 2, intentIndex);
  if (sourceRows.some((event) => event.kind !== "source_readback")) {
    throw new Error("deployment resolution source readback checkpoint is absent");
  }
  const sourceReadbacks = sourceRows.map((event) => {
    const readback = validateJsonCompatibilityDeploymentTransitionReadback(
      event.payload,
    );
    if (readback.observationDigestSha256 !== event.digestSha256) {
      throw new Error("deployment resolution source readback drifted");
    }
    return readback;
  });
  const following = events.slice(intentIndex + 1);
  const outcomeEvent = following.find((event) =>
    event.kind === "mutation_outcome");
  const mutationOutcome = outcomeEvent === undefined
    ? null
    : mutationOutcomeRecord(outcomeEvent.payload, mutationIntent, outcomeEvent);
  const hasTargetReadback = following.some((event) =>
    event.kind === "target_readback");
  if (
    (hasTargetReadback && outcomeEvent === undefined)
    ||
    following.some((event, index) => {
      if (index === 0 && event.kind === "mutation_outcome") return false;
      return event.kind !== "target_readback";
    })
    || following.filter((event) => event.kind === "target_readback").length > 2
  ) {
    throw new Error("deployment resolution journal tail is invalid");
  }
  return {
    originalSourceAuthentication,
    sourceReadbacks,
    mutationIntent,
    mutationOutcome,
  };
}

function sourceAuthentication(
  input: unknown,
): Readonly<Record<string, unknown>> {
  const value = record(input, "deployment resolution source authentication");
  requireSha256(
    value.sourceAuthenticationDigestSha256,
    "deployment resolution source authentication",
  );
  return value;
}

function mutationOutcomeRecord(
  input: unknown,
  intent: JsonCompatibilityDeploymentTransitionMutationIntentV2,
  event: { readonly digestSha256: string },
): Readonly<Record<string, unknown>> {
  const value = validateJsonCompatibilityDeploymentTransitionMutationOutcome(
    input,
    intent,
  );
  if (
    value.mutationIntentSha256 !== intent.mutationIntentSha256
    || value.outcomeDigestSha256 !== event.digestSha256
  ) {
    throw new Error("deployment resolution mutation outcome drifted");
  }
  requireSha256(
    value.outcomeDigestSha256,
    "deployment resolution mutation outcome",
  );
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  if (
    canonicalJson(Object.keys(value).sort())
      !== canonicalJson([...expected].sort())
  ) {
    throw new Error(`${label} fields are invalid`);
  }
}

function requireSha256(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} is invalid`);
  }
}
