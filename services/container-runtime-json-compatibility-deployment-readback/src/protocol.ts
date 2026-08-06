import {
  canonicalJson,
  sha256Canonical,
} from "./shared_protocol_adapter.mjs";
import {
  buildJsonCompatibilityDeploymentLeafServiceIdentity,
  buildJsonCompatibilityDeploymentTransitionReadback,
  validateJsonCompatibilityDeploymentTransitionReadbackExecution,
  validateJsonCompatibilityDeploymentTransitionRecoveryReadbackExecution,
} from "../../../tools/container_runtime_json_compatibility_deployment_transition.mjs";
import {
  validateJsonCompatibilityDeploymentResolutionAuthorization,
} from "../../../tools/container_runtime_json_compatibility_deployment_resolution.mjs";

export const READBACK_SERVICE_NAME =
  "cinatoken-container-runtime-json-compatibility-deployment-readback-staging";
export const READBACK_ENTRYPOINT =
  "JsonCompatibilityDeploymentReadbackEntrypoint";
export const READBACK_PROFILE_VERSION = 1;

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ACCOUNT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ZERO_ACCOUNT_ID = "0".repeat(32);
const ZERO_SHA256 = "0".repeat(64);

const FIXED_SERVICES = {
  controller: {
    serviceName: "cinatoken-container-controller-staging",
    entrypoint: "JsonCompatibilityProbeEntrypoint",
  },
  executor: {
    serviceName:
      "cinatoken-container-runtime-json-compatibility-executor-staging",
    entrypoint: "JsonCompatibilityCampaignExecutorEntrypoint",
  },
  permitIssuer: {
    serviceName:
      "cinatoken-container-runtime-json-compatibility-permit-issuer-staging",
    entrypoint: "JsonCompatibilityPermitIssuerEntrypoint",
  },
  invoker: {
    serviceName:
      "cinatoken-container-runtime-json-compatibility-invoker-staging",
    entrypoint: "JsonCompatibilityCampaignInvokerEntrypoint",
  },
  operator: {
    serviceName:
      "cinatoken-container-runtime-json-compatibility-operator-staging",
    entrypoint: "JsonCompatibilityCampaignOperatorEntrypoint",
  },
  runner: {
    serviceName:
      "cinatoken-container-runtime-json-compatibility-runner-staging",
    entrypoint: "JsonCompatibilityCampaignRunnerEntrypoint",
  },
  caller: {
    serviceName:
      "cinatoken-container-runtime-json-compatibility-caller-staging",
    entrypoint: "JsonCompatibilityCampaignCallerEntrypoint",
  },
} as const;

export interface JsonCompatibilityDeploymentReadbackEnv {
  readonly CF_VERSION_METADATA: { readonly id: string };
  readonly ENVIRONMENT: string;
  readonly JSON_COMPATIBILITY_DEPLOYMENT_READBACK_ENABLED: string;
  readonly JSON_COMPATIBILITY_DEPLOYMENT_READBACK_PROFILE_VERSION: string;
  readonly JSON_COMPATIBILITY_DEPLOYMENT_READBACK_SERVICE_NAME: string;
  readonly JSON_COMPATIBILITY_DEPLOYMENT_READBACK_ENTRYPOINT: string;
  readonly CLOUDFLARE_ACCOUNT_ID: string;
  readonly CLOUDFLARE_ACCOUNT_ID_SHA256: string;
  readonly CLOUDFLARE_DEPLOYMENT_READ_CREDENTIAL_ID_SHA256: string;
  readonly CLOUDFLARE_DEPLOYMENT_READ_API_TOKEN?: string;
}

export interface ExpectedReadback {
  readonly environment: "staging";
  readonly accountIdSha256: string;
  readonly serviceName: string;
  readonly entrypoint: string;
  readonly versionId: string;
  readonly configSha256: string;
  readonly deploymentState: "dark" | "status-only" | "execution";
  readonly gates: Readonly<Record<string, boolean>>;
  readonly privateRpcOnly: boolean;
  readonly workersDev: boolean;
  readonly previewUrls: boolean;
  readonly bindingSetSha256: string;
  readonly routeSetSha256: string;
  readonly secretNameSetSha256: string;
  readonly durableObjectMigrationSetSha256: string;
  readonly authenticationIdentitySha256: string;
}

interface ReadbackAuthority {
  readonly serviceName: string;
  readonly entrypoint: string;
  readonly versionId: string;
  readonly profileVersion: number;
  readonly privateRpcOnly: boolean;
  readonly capability: string;
  readonly credentialIdSha256: string;
  readonly identitySha256: string;
}

interface ReadbackExecutionContext {
  readonly statePlan: {
    readonly services: Readonly<Record<string, {
      readonly serviceName: string;
      readonly entrypoint: string;
    }>>;
  };
  readonly authorizedTransition: {
    readonly request: {
      readonly executionAuthority: {
        readonly accountIdSha256: string;
        readonly readback: ReadbackAuthority;
      };
    };
  };
  readonly artifactInventoryReadback: unknown;
  readonly sourceAuthentication: {
    readonly sourceAuthenticationDigestSha256: string;
    readonly verifiedAt: number;
  };
  readonly readbackRequest: {
    readonly readbackRequestSha256: string;
    readonly step: { readonly role: string };
  };
  readonly expected: ExpectedReadback;
}

export interface ValidatedReadbackInvocation {
  readonly accountId: string;
  readonly context: ReadbackExecutionContext;
  readonly readbackServiceIdentitySha256: string;
}

export interface AmbiguousReadbackEvidence {
  readonly code: string;
  readonly endpointPath?: string;
  readonly httpStatus?: number;
  readonly responseBytes?: number;
  readonly responseRequestIdSha256?: string;
}

export async function validateReadbackInvocation(
  env: JsonCompatibilityDeploymentReadbackEnv,
  input: unknown,
  nowMilliseconds: number,
): Promise<ValidatedReadbackInvocation> {
  if (env.JSON_COMPATIBILITY_DEPLOYMENT_READBACK_ENABLED !== "true") {
    throw new Error("deployment readback is disabled");
  }
  if (!Number.isFinite(nowMilliseconds)) {
    throw new Error("deployment readback clock is invalid");
  }

  const context = validateJsonCompatibilityDeploymentTransitionReadbackExecution(
    input as Readonly<Record<string, unknown>>,
    { now: new Date(nowMilliseconds) },
  ) as unknown as ReadbackExecutionContext;

  assertFixedServicePlan(context);
  const runtimeIdentity = await validateRuntimeIdentity(env, context);
  return {
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    context,
    readbackServiceIdentitySha256: runtimeIdentity,
  };
}

export async function validateRecoveryReadbackInvocation(
  env: JsonCompatibilityDeploymentReadbackEnv,
  input: unknown,
  nowMilliseconds: number,
): Promise<ValidatedReadbackInvocation> {
  if (env.JSON_COMPATIBILITY_DEPLOYMENT_READBACK_ENABLED !== "true") {
    throw new Error("deployment readback is disabled");
  }
  if (!Number.isFinite(nowMilliseconds)) {
    throw new Error("deployment readback clock is invalid");
  }

  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("deployment recovery readback envelope is invalid");
  }
  const value = input as Readonly<Record<string, unknown>>;
  const expectedKeys = [
    "authorizedResolution",
    "authorizedTransition",
    "campaignPlan",
    "mutationIntent",
    "originalSourceAuthentication",
    "readbackRequest",
    "sourceAuthentication",
    "sourceReadbacks",
    "statePlan",
  ];
  if (
    canonicalJson(Object.keys(value).sort())
      !== canonicalJson(expectedKeys)
  ) {
    throw new Error("deployment recovery readback envelope fields are invalid");
  }
  const authorizedResolution =
    validateJsonCompatibilityDeploymentResolutionAuthorization(
    value.campaignPlan,
    value.statePlan,
    value.authorizedTransition,
    value.authorizedResolution,
    { now: new Date(nowMilliseconds), requireUsableWindow: true },
  );
  const context =
    validateJsonCompatibilityDeploymentTransitionRecoveryReadbackExecution(
      {
        campaignPlan: value.campaignPlan,
        statePlan: value.statePlan,
        authorizedTransition: value.authorizedTransition,
        sourceAuthentication: value.sourceAuthentication,
        originalSourceAuthentication: value.originalSourceAuthentication,
        mutationIntent: value.mutationIntent,
        sourceReadbacks: value.sourceReadbacks,
        readbackRequest: value.readbackRequest,
      },
      { now: new Date(nowMilliseconds) },
    ) as unknown as ReadbackExecutionContext;
  if (
    context.sourceAuthentication.sourceAuthenticationDigestSha256
      !== authorizedResolution.request.sourceAuthenticationDigestSha256
    || context.sourceAuthentication.verifiedAt
      !== authorizedResolution.request.sourceAuthenticationVerifiedAt
  ) {
    throw new Error(
      "deployment recovery source authentication is not owner authorized",
    );
  }

  assertFixedServicePlan(context);
  const runtimeIdentity = await validateRuntimeIdentity(env, context);
  return {
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    context,
    readbackServiceIdentitySha256: runtimeIdentity,
  };
}

export function buildAmbiguousReadback(
  invocation: ValidatedReadbackInvocation,
  observedAt: number,
  evidence: AmbiguousReadbackEvidence,
): Record<string, unknown> {
  const { context, readbackServiceIdentitySha256 } = invocation;
  const expected = context.expected;
  const readbackRequestIdSha256 = sha256Canonical({
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-json-compatibility-deployment-readback-attempt-v1",
    readbackRequestSha256: context.readbackRequest.readbackRequestSha256,
    readbackServiceIdentitySha256,
    observedAt,
    failureCode: evidence.code,
  });
  const remoteEvidenceSha256 = sha256Canonical({
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-json-compatibility-deployment-readback-remote-failure-v1",
    readbackRequestSha256: context.readbackRequest.readbackRequestSha256,
    ...evidence,
  });
  const authenticationEvidenceSha256 = sha256Canonical({
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-json-compatibility-deployment-readback-authentication-evidence-v1",
    credentialIdSha256: expected.authenticationIdentitySha256,
    classification: evidence.code === "credential_unavailable"
      ? "unavailable"
      : "present",
    readbackRequestIdSha256,
  });
  return buildJsonCompatibilityDeploymentTransitionReadback({
    readbackRequestSha256: context.readbackRequest.readbackRequestSha256,
    readbackServiceIdentitySha256,
    classification: "ambiguous",
    accountIdSha256: expected.accountIdSha256,
    serviceName: expected.serviceName,
    entrypoint: expected.entrypoint,
    authenticationIdentitySha256: expected.authenticationIdentitySha256,
    readbackRequestIdSha256,
    remoteEvidenceSha256,
    authenticationEvidenceSha256,
    observedAt,
  }) as unknown as Record<string, unknown>;
}

export function buildObservedReadback(
  invocation: ValidatedReadbackInvocation,
  observation: {
    readonly workersDev: boolean;
    readonly previewUrls: boolean;
    readonly routeSetSha256: string;
    readonly readbackRequestIdSha256: string;
    readonly remoteEvidenceSha256: string;
    readonly authenticationEvidenceSha256: string;
    readonly observedAt: number;
  },
): Record<string, unknown> {
  const { context, readbackServiceIdentitySha256 } = invocation;
  const expected = context.expected;

  // A Worker version is immutable. The live deployment and exact-version reads
  // join that version ID to the signed artifact inventory; mutable subdomain
  // flags come from the live subdomain response below.
  return buildJsonCompatibilityDeploymentTransitionReadback({
    readbackRequestSha256: context.readbackRequest.readbackRequestSha256,
    readbackServiceIdentitySha256,
    classification: "observed",
    accountIdSha256: expected.accountIdSha256,
    serviceName: expected.serviceName,
    entrypoint: expected.entrypoint,
    versionId: expected.versionId,
    configSha256: expected.configSha256,
    deploymentState: expected.deploymentState,
    gates: expected.gates,
    privateRpcOnly: expected.privateRpcOnly,
    workersDev: observation.workersDev,
    previewUrls: observation.previewUrls,
    bindingSetSha256: expected.bindingSetSha256,
    routeSetSha256: observation.routeSetSha256,
    secretNameSetSha256: expected.secretNameSetSha256,
    durableObjectMigrationSetSha256:
      expected.durableObjectMigrationSetSha256,
    authenticationIdentitySha256: expected.authenticationIdentitySha256,
    readbackRequestIdSha256: observation.readbackRequestIdSha256,
    remoteEvidenceSha256: observation.remoteEvidenceSha256,
    authenticationEvidenceSha256: observation.authenticationEvidenceSha256,
    observedAt: observation.observedAt,
  }) as unknown as Record<string, unknown>;
}

function assertFixedServicePlan(context: ReadbackExecutionContext): void {
  const roles = Object.keys(context.statePlan.services).sort();
  const expectedRoles = Object.keys(FIXED_SERVICES).sort();
  if (canonicalJson(roles) !== canonicalJson(expectedRoles)) {
    throw new Error("deployment readback service set is not the fixed D0 set");
  }
  for (const role of expectedRoles) {
    const fixed = FIXED_SERVICES[role as keyof typeof FIXED_SERVICES];
    const actual = context.statePlan.services[role];
    if (
      actual?.serviceName !== fixed.serviceName
      || actual.entrypoint !== fixed.entrypoint
    ) {
      throw new Error(`deployment readback service ${role} is not allowlisted`);
    }
  }

  const requestRole = context.readbackRequest.step.role;
  const fixedTarget = FIXED_SERVICES[requestRole as keyof typeof FIXED_SERVICES];
  if (
    fixedTarget === undefined
    || context.expected.serviceName !== fixedTarget.serviceName
    || context.expected.entrypoint !== fixedTarget.entrypoint
  ) {
    throw new Error("deployment readback target service is not allowlisted");
  }
}

async function validateRuntimeIdentity(
  env: JsonCompatibilityDeploymentReadbackEnv,
  context: ReadbackExecutionContext,
): Promise<string> {
  if (env.ENVIRONMENT !== "staging") {
    throw new Error("deployment readback environment is not staging");
  }
  if (
    env.JSON_COMPATIBILITY_DEPLOYMENT_READBACK_SERVICE_NAME
      !== READBACK_SERVICE_NAME
    || env.JSON_COMPATIBILITY_DEPLOYMENT_READBACK_ENTRYPOINT
      !== READBACK_ENTRYPOINT
    || env.JSON_COMPATIBILITY_DEPLOYMENT_READBACK_PROFILE_VERSION
      !== String(READBACK_PROFILE_VERSION)
  ) {
    throw new Error("deployment readback runtime profile is invalid");
  }
  if (!SAFE_ACCOUNT_ID.test(env.CLOUDFLARE_ACCOUNT_ID)) {
    throw new Error("deployment readback account ID is invalid");
  }
  requireSha256(env.CLOUDFLARE_ACCOUNT_ID_SHA256, "account ID digest");
  requireSha256(
    env.CLOUDFLARE_DEPLOYMENT_READ_CREDENTIAL_ID_SHA256,
    "credential ID digest",
  );
  if (
    env.CLOUDFLARE_ACCOUNT_ID === ZERO_ACCOUNT_ID
    || env.CLOUDFLARE_ACCOUNT_ID_SHA256 === ZERO_SHA256
    || env.CLOUDFLARE_DEPLOYMENT_READ_CREDENTIAL_ID_SHA256 === ZERO_SHA256
  ) {
    throw new Error("deployment readback placeholder identity is forbidden");
  }
  const calculatedAccountIdSha256 = await sha256Utf8(
    env.CLOUDFLARE_ACCOUNT_ID,
  );
  if (calculatedAccountIdSha256 !== env.CLOUDFLARE_ACCOUNT_ID_SHA256) {
    throw new Error("deployment readback account ID digest is invalid");
  }

  const versionId = env.CF_VERSION_METADATA?.id;
  if (typeof versionId !== "string" || versionId.length === 0) {
    throw new Error("deployment readback Worker version metadata is absent");
  }
  const leafIdentity = buildJsonCompatibilityDeploymentLeafServiceIdentity({
    accountIdSha256: env.CLOUDFLARE_ACCOUNT_ID_SHA256,
    serviceName: READBACK_SERVICE_NAME,
    entrypoint: READBACK_ENTRYPOINT,
    versionId,
    profileVersion: READBACK_PROFILE_VERSION,
    privateRpcOnly: true,
    capability: "read-only",
    credentialIdSha256:
      env.CLOUDFLARE_DEPLOYMENT_READ_CREDENTIAL_ID_SHA256,
  });
  const authorityProjection = {
    serviceName: leafIdentity.serviceName,
    entrypoint: leafIdentity.entrypoint,
    versionId: leafIdentity.versionId,
    profileVersion: leafIdentity.profileVersion,
    privateRpcOnly: leafIdentity.privateRpcOnly,
    capability: leafIdentity.capability,
    credentialIdSha256: leafIdentity.credentialIdSha256,
    identitySha256: leafIdentity.identitySha256,
  };
  const signedAuthority = context.authorizedTransition.request.executionAuthority;
  if (
    signedAuthority.accountIdSha256 !== env.CLOUDFLARE_ACCOUNT_ID_SHA256
    || canonicalJson(signedAuthority.readback)
      !== canonicalJson(authorityProjection)
  ) {
    throw new Error("signed deployment readback authority does not match runtime");
  }
  if (
    context.expected.authenticationIdentitySha256
      !== env.CLOUDFLARE_DEPLOYMENT_READ_CREDENTIAL_ID_SHA256
  ) {
    throw new Error("deployment readback credential is detached from request");
  }
  return String(leafIdentity.identitySha256);
}

async function sha256Utf8(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((entry) => entry.toString(16).padStart(2, "0"))
    .join("");
}

function requireSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`deployment readback ${label} is invalid`);
  }
}
