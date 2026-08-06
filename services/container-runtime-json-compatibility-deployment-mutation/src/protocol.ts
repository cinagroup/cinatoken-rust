import {
  buildJsonCompatibilityDeploymentLeafServiceIdentity,
  validateJsonCompatibilityDeploymentTransitionMutationExecution,
} from "../../../tools/container_runtime_json_compatibility_deployment_transition.mjs";

import {
  SHA256_PATTERN,
  canonicalJson,
  cloneCanonical,
  sha256Canonical,
  sha256Text,
} from "./canonical";

export type JsonRecord = Record<string, unknown>;

export const MUTATION_ENTRYPOINT =
  "JsonCompatibilityDeploymentMutationEntrypoint";
export const MUTATION_SERVICE_NAME =
  "cinatoken-container-runtime-json-compatibility-deployment-mutation-staging";
export const MUTATION_PROFILE_VERSION = 1;
export const MUTATION_DISPATCH_SEMANTICS =
  "fresh_create_once_claim_only_network_may_not_have_occurred";

const MAX_ENVELOPE_BYTES = 2 * 1024 * 1024;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const TARGETS = Object.freeze({
  controller: Object.freeze({
    serviceName: "cinatoken-container-controller-staging",
    entrypoint: "JsonCompatibilityProbeEntrypoint",
  }),
  executor: Object.freeze({
    serviceName:
      "cinatoken-container-runtime-json-compatibility-executor-staging",
    entrypoint: "JsonCompatibilityCampaignExecutorEntrypoint",
  }),
  permitIssuer: Object.freeze({
    serviceName:
      "cinatoken-container-runtime-json-compatibility-permit-issuer-staging",
    entrypoint: "JsonCompatibilityPermitIssuerEntrypoint",
  }),
  invoker: Object.freeze({
    serviceName:
      "cinatoken-container-runtime-json-compatibility-invoker-staging",
    entrypoint: "JsonCompatibilityCampaignInvokerEntrypoint",
  }),
  operator: Object.freeze({
    serviceName:
      "cinatoken-container-runtime-json-compatibility-operator-staging",
    entrypoint: "JsonCompatibilityCampaignOperatorEntrypoint",
  }),
  runner: Object.freeze({
    serviceName:
      "cinatoken-container-runtime-json-compatibility-runner-staging",
    entrypoint: "JsonCompatibilityCampaignRunnerEntrypoint",
  }),
  caller: Object.freeze({
    serviceName:
      "cinatoken-container-runtime-json-compatibility-caller-staging",
    entrypoint: "JsonCompatibilityCampaignCallerEntrypoint",
  }),
});

export type MutationEnvelope = Readonly<Record<string, unknown>> & {
  readonly campaignPlan: unknown;
  readonly statePlan: unknown;
  readonly authorizedTransition: unknown;
  readonly sourceAuthentication: unknown;
  readonly mutationIntent: unknown;
  readonly sourceReadbacks: unknown;
};

export interface MutationIdentityConfiguration {
  readonly accountId: string;
  readonly accountIdSha256: string;
  readonly serviceName: string;
  readonly entrypoint: typeof MUTATION_ENTRYPOINT;
  readonly versionId: string;
  readonly profileVersion: 1;
  readonly credentialIdSha256: string;
}

export interface PreparedDeploymentMutation {
  readonly envelope: MutationEnvelope;
  readonly mutationIntent: JsonRecord;
  readonly mutationIntentJson: string;
  readonly mutationIntentSha256: string;
  readonly mutationRpcRequestSha256: string;
  readonly operationIdSha256: string;
  readonly operationDigestSha256: string;
  readonly authorizedRequestSha256: string;
  readonly campaignPlanDigestSha256: string;
  readonly statePlanDigestSha256: string;
  readonly executionAuthoritySha256: string;
  readonly sourceAuthenticationDigestSha256: string;
  readonly sourceReadbackSetSha256: string;
  readonly role: string;
  readonly targetServiceName: string;
  readonly targetEntrypoint: string;
  readonly targetVersionId: string;
  readonly targetConfigSha256: string;
  readonly requestBody: string;
  readonly mutationRequestSha256: string;
  readonly mutationAnnotation: string;
  readonly mutationAnnotationSha256: string;
  readonly endpointPath: string;
  readonly endpointSha256: string;
  readonly mutationServiceIdentity: JsonRecord;
  readonly mutationServiceIdentityJson: string;
  readonly mutationServiceIdentitySha256: string;
  readonly credentialIdSha256: string;
  readonly authenticationIdentitySha256: string;
  readonly accountIdSha256: string;
  readonly mutatorServiceName: string;
  readonly mutatorEntrypoint: string;
  readonly mutatorVersionId: string;
  readonly mutatorProfileVersion: 1;
}

export async function prepareDeploymentMutation(
  configuration: MutationIdentityConfiguration,
  input: unknown,
  now: number,
): Promise<PreparedDeploymentMutation> {
  const envelope = parseEnvelope(input);
  const execution =
    validateJsonCompatibilityDeploymentTransitionMutationExecution(
      envelope,
      { now: new Date(now * 1000) },
    );
  const authorized = record(
    execution.authorizedTransition,
    "authorized transition",
  );
  const authorizedRequest = record(
    authorized.request,
    "authorized transition request",
  );
  const authority = record(
    authorizedRequest.executionAuthority,
    "execution authority",
  );
  const mutationAuthority = record(
    authority.mutation,
    "mutation execution authority",
  );
  await validateSelfIdentity(configuration, authority, mutationAuthority);

  const intent = record(execution.mutationIntent, "mutation intent");
  const role = safeToken(intent.role, "mutation role");
  const target = targetForRole(role);
  equal(intent.serviceName, target.serviceName, "allowlisted target service");
  equal(intent.entrypoint, target.entrypoint, "allowlisted target entrypoint");
  equal(
    intent.mutationServiceIdentitySha256,
    mutationAuthority.identitySha256,
    "mutation intent service identity",
  );
  const statePlan = record(execution.statePlan, "state plan");
  const services = record(statePlan.services, "state plan services");
  const targetService = record(services[role], "state plan target service");
  equal(targetService.serviceName, target.serviceName, "state plan target service");
  equal(targetService.entrypoint, target.entrypoint, "state plan target entrypoint");

  const accountIdSha256 = sha256Value(
    authority.accountIdSha256,
    "execution authority account ID",
  );
  const mutationIntentSha256 = sha256Value(
    intent.mutationIntentSha256,
    "mutation intent digest",
  );
  const targetVersionId = safeToken(
    intent.targetVersionId,
    "target version ID",
  );
  const targetConfigSha256 = sha256Value(
    intent.targetConfigSha256,
    "target config digest",
  );
  const mutationAnnotation =
    `cinatoken-json-compatibility-deployment-mutation-v2:${mutationIntentSha256}`;
  const requestBody = canonicalJson({
    annotations: { "workers/message": mutationAnnotation },
    strategy: "percentage",
    versions: [{ percentage: 100, version_id: targetVersionId }],
  });
  const endpointPath =
    `/client/v4/accounts/${encodeURIComponent(configuration.accountId)}`
    + `/workers/scripts/${encodeURIComponent(target.serviceName)}/deployments`;
  const authenticationIdentitySha256 = configuration.credentialIdSha256;
  const mutationIntentJson = canonicalJson(intent);
  const mutationServiceIdentityJson = canonicalJson(mutationAuthority);

  return {
    envelope: cloneCanonical(envelope),
    mutationIntent: cloneCanonical(intent),
    mutationIntentJson,
    mutationIntentSha256,
    mutationRpcRequestSha256: await sha256Canonical(envelope),
    operationIdSha256: sha256Value(intent.operationIdSha256, "operation ID"),
    operationDigestSha256: sha256Value(
      intent.operationDigestSha256,
      "operation digest",
    ),
    authorizedRequestSha256: sha256Value(
      intent.authorizedRequestSha256,
      "authorized request digest",
    ),
    campaignPlanDigestSha256: sha256Value(
      intent.campaignPlanDigestSha256,
      "campaign plan digest",
    ),
    statePlanDigestSha256: sha256Value(
      intent.statePlanDigestSha256,
      "state plan digest",
    ),
    executionAuthoritySha256: sha256Value(
      intent.executionAuthoritySha256,
      "execution authority digest",
    ),
    sourceAuthenticationDigestSha256: sha256Value(
      intent.sourceAuthenticationDigestSha256,
      "source authentication digest",
    ),
    sourceReadbackSetSha256: sha256Value(
      intent.sourceReadbackSetSha256,
      "source readback set digest",
    ),
    role,
    targetServiceName: target.serviceName,
    targetEntrypoint: target.entrypoint,
    targetVersionId,
    targetConfigSha256,
    requestBody,
    mutationRequestSha256: await sha256Text(requestBody),
    mutationAnnotation,
    mutationAnnotationSha256: await sha256Text(mutationAnnotation),
    endpointPath,
    endpointSha256: await sha256Text(endpointPath),
    mutationServiceIdentity: cloneCanonical(mutationAuthority),
    mutationServiceIdentityJson,
    mutationServiceIdentitySha256: sha256Value(
      mutationAuthority.identitySha256,
      "mutation service identity",
    ),
    credentialIdSha256: configuration.credentialIdSha256,
    authenticationIdentitySha256,
    accountIdSha256,
    mutatorServiceName: configuration.serviceName,
    mutatorEntrypoint: configuration.entrypoint,
    mutatorVersionId: configuration.versionId,
    mutatorProfileVersion: configuration.profileVersion,
  };
}

function parseEnvelope(input: unknown): MutationEnvelope {
  const value = record(input, "mutation envelope");
  exactKeys(value, [
    "campaignPlan",
    "statePlan",
    "authorizedTransition",
    "sourceAuthentication",
    "mutationIntent",
    "sourceReadbacks",
  ], "mutation envelope");
  const bytes = new TextEncoder().encode(canonicalJson(value)).byteLength;
  if (bytes < 2 || bytes > MAX_ENVELOPE_BYTES) {
    throw new Error("mutation envelope is empty or oversized");
  }
  return {
    campaignPlan: value.campaignPlan,
    statePlan: value.statePlan,
    authorizedTransition: value.authorizedTransition,
    sourceAuthentication: value.sourceAuthentication,
    mutationIntent: value.mutationIntent,
    sourceReadbacks: value.sourceReadbacks,
  };
}

async function validateSelfIdentity(
  configuration: MutationIdentityConfiguration,
  authority: JsonRecord,
  mutationAuthority: JsonRecord,
): Promise<void> {
  const computedAccountIdSha256 = await sha256Text(configuration.accountId);
  equal(
    configuration.accountIdSha256,
    computedAccountIdSha256,
    "configured account ID digest",
  );
  equal(
    authority.accountIdSha256,
    computedAccountIdSha256,
    "signed execution account ID",
  );
  const expected = buildJsonCompatibilityDeploymentLeafServiceIdentity({
    accountIdSha256: computedAccountIdSha256,
    serviceName: configuration.serviceName,
    entrypoint: configuration.entrypoint,
    versionId: configuration.versionId,
    profileVersion: configuration.profileVersion,
    privateRpcOnly: true,
    capability: "mutation-only",
    credentialIdSha256: configuration.credentialIdSha256,
  });
  for (const key of [
    "serviceName",
    "entrypoint",
    "versionId",
    "profileVersion",
    "privateRpcOnly",
    "capability",
    "credentialIdSha256",
    "identitySha256",
  ]) {
    equal(
      mutationAuthority[key],
      Reflect.get(expected, key),
      `signed mutation execution authority ${key}`,
    );
  }
}

function targetForRole(role: string): {
  readonly serviceName: string;
  readonly entrypoint: string;
} {
  if (!Object.hasOwn(TARGETS, role)) {
    throw new Error("mutation role is outside the fixed seven-service allowlist");
  }
  return TARGETS[role as keyof typeof TARGETS];
}

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(wanted)) {
    throw new Error(`${label} has unexpected fields`);
  }
}

function equal(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label} does not match`);
}

function sha256Value(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} is not a SHA-256 digest`);
  }
  return value;
}

function safeToken(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_TOKEN.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}
