import {
  ambiguousOutcome,
  postDeploymentMutationOnce,
  type MutationClientRuntime,
  type MutationTransportOutcome,
} from "./cloudflare_client";
import {
  MUTATION_ENTRYPOINT,
  MUTATION_PROFILE_VERSION,
  MUTATION_SERVICE_NAME,
  prepareDeploymentMutation,
  type MutationIdentityConfiguration,
  type JsonRecord,
  type PreparedDeploymentMutation,
} from "./protocol";
import {
  D1MutationJournal,
  MutationRepositoryConflictError,
  MutationRepositoryUnavailableError,
  type MutationJournal,
} from "./repository";
import {
  buildJsonCompatibilityDeploymentTransitionMutationOutcome,
} from "../../../tools/container_runtime_json_compatibility_deployment_transition.mjs";

type MutationVariableBinding =
  | "ENVIRONMENT"
  | "CLOUDFLARE_ACCOUNT_ID"
  | "JSON_COMPATIBILITY_DEPLOYMENT_MUTATION_ENABLED"
  | "JSON_COMPATIBILITY_DEPLOYMENT_MUTATION_REMOTE_ENABLED"
  | "JSON_COMPATIBILITY_DEPLOYMENT_MUTATION_PROFILE_VERSION"
  | "JSON_COMPATIBILITY_DEPLOYMENT_MUTATION_SERVICE_NAME"
  | "JSON_COMPATIBILITY_DEPLOYMENT_MUTATION_CREDENTIAL_ID_SHA256"
  | "JSON_COMPATIBILITY_DEPLOYMENT_MUTATION_ACCOUNT_ID_SHA256";

export type JsonCompatibilityDeploymentMutationEnv = Omit<
  JsonCompatibilityDeploymentMutationGeneratedEnv,
  MutationVariableBinding
> & Readonly<Record<MutationVariableBinding, string>> & {
  readonly CLOUDFLARE_DEPLOYMENT_MUTATION_API_TOKEN?: string;
};

export interface MutationRuntime extends MutationClientRuntime {
  now(): number;
  journal(database: D1Database): MutationJournal;
}

const DEFAULT_RUNTIME: MutationRuntime = {
  now: () => Math.floor(Date.now() / 1000),
  journal: (database) => new D1MutationJournal(database),
  fetch: async (input, init) => await fetch(input, init),
};

export async function mutateDeploymentOnce(
  env: JsonCompatibilityDeploymentMutationEnv,
  input: unknown,
  runtime: MutationRuntime = DEFAULT_RUNTIME,
): Promise<JsonRecord> {
  const now = runtimeNow(runtime);
  const configuration = requireIdentityConfiguration(env);
  let mutation: PreparedDeploymentMutation;
  try {
    mutation = await prepareDeploymentMutation(configuration, input, now);
  } catch {
    throw new DeploymentMutationWorkerError("mutation_envelope_rejected");
  }

  const token = env.CLOUDFLARE_DEPLOYMENT_MUTATION_API_TOKEN;
  if (typeof token !== "string" || token.length < 20 || token.length > 4096) {
    throw new DeploymentMutationWorkerError("mutation_credential_unavailable");
  }

  const journal = runtime.journal(env.DB);
  let claim;
  try {
    claim = await journal.reserve(mutation);
  } catch (error) {
    if (error instanceof MutationRepositoryConflictError) {
      throw new DeploymentMutationWorkerError(error.code);
    }
    if (error instanceof MutationRepositoryUnavailableError) {
      throw new DeploymentMutationWorkerError(
        error.outcomeUnknown
          ? "mutation_journal_outcome_unknown"
          : "mutation_journal_unavailable",
      );
    }
    throw new DeploymentMutationWorkerError("mutation_journal_unavailable");
  }
  if (claim.classification !== "fresh") {
    return recoveryOutcome(mutation, claim.row.claimed_at);
  }

  const sentAt = runtimeNow(runtime);
  const transport = await postDeploymentMutationOnce(token, mutation, runtime);
  const outcome = mutationOutcome(mutation, sentAt, transport);
  try {
    await journal.recordOutcome(mutation.mutationIntentSha256, outcome);
  } catch {
    return recoveryOutcome(mutation, claim.row.claimed_at);
  }
  return outcome;
}

function requireIdentityConfiguration(
  env: JsonCompatibilityDeploymentMutationEnv,
): MutationIdentityConfiguration {
  if (
    env.ENVIRONMENT !== "staging"
    || env.JSON_COMPATIBILITY_DEPLOYMENT_MUTATION_ENABLED !== "true"
    || env.JSON_COMPATIBILITY_DEPLOYMENT_MUTATION_REMOTE_ENABLED !== "true"
  ) {
    throw new DeploymentMutationWorkerError("mutation_worker_disabled");
  }
  if (
    env.JSON_COMPATIBILITY_DEPLOYMENT_MUTATION_PROFILE_VERSION !== "1"
    || env.JSON_COMPATIBILITY_DEPLOYMENT_MUTATION_SERVICE_NAME
      !== MUTATION_SERVICE_NAME
  ) {
    throw new DeploymentMutationWorkerError("mutation_worker_identity_invalid");
  }
  const accountId = safeToken(env.CLOUDFLARE_ACCOUNT_ID, "account ID");
  const accountIdSha256 = sha256Value(
    env.JSON_COMPATIBILITY_DEPLOYMENT_MUTATION_ACCOUNT_ID_SHA256,
    "account ID digest",
  );
  const credentialIdSha256 = sha256Value(
    env.JSON_COMPATIBILITY_DEPLOYMENT_MUTATION_CREDENTIAL_ID_SHA256,
    "credential ID digest",
  );
  const versionId = safeToken(env.CF_VERSION_METADATA?.id, "version ID");
  if (
    env.DB === null
    || typeof env.DB !== "object"
    || typeof env.DB.withSession !== "function"
  ) {
    throw new DeploymentMutationWorkerError("mutation_journal_binding_invalid");
  }
  return {
    accountId,
    accountIdSha256,
    serviceName: MUTATION_SERVICE_NAME,
    entrypoint: MUTATION_ENTRYPOINT,
    versionId,
    profileVersion: MUTATION_PROFILE_VERSION,
    credentialIdSha256,
  };
}

function mutationOutcome(
  mutation: PreparedDeploymentMutation,
  sentAt: number,
  transport: MutationTransportOutcome,
): JsonRecord {
  return recordOutcome(buildJsonCompatibilityDeploymentTransitionMutationOutcome({
    mutationIntent: mutation.mutationIntent,
    mutationRpcRequestSha256: mutation.mutationRpcRequestSha256,
    mutationServiceIdentitySha256: mutation.mutationServiceIdentitySha256,
    authenticationIdentitySha256: mutation.authenticationIdentitySha256,
    mutationRequestSha256: mutation.mutationRequestSha256,
    mutationAnnotationSha256: mutation.mutationAnnotationSha256,
    endpointSha256: mutation.endpointSha256,
    sentAt,
    classification: transport.classification,
    httpStatus: transport.httpStatus,
    responseBodySha256: transport.responseBodySha256,
    responseRequestIdSha256: transport.responseRequestIdSha256,
    responseBytes: transport.responseBytes,
  }));
}

function recoveryOutcome(
  mutation: PreparedDeploymentMutation,
  claimedAt: number,
): JsonRecord {
  return mutationOutcome(mutation, claimedAt, ambiguousOutcome());
}

function runtimeNow(runtime: MutationRuntime): number {
  const now = runtime.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new DeploymentMutationWorkerError("mutation_clock_invalid");
  }
  return now;
}

function safeToken(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  ) {
    throw new DeploymentMutationWorkerError(
      "mutation_worker_identity_invalid",
      label,
    );
  }
  return value;
}

function sha256Value(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new DeploymentMutationWorkerError(
      "mutation_worker_identity_invalid",
      label,
    );
  }
  return value;
}

function recordOutcome(value: unknown): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DeploymentMutationWorkerError("mutation_outcome_invalid");
  }
  return value as JsonRecord;
}

export class DeploymentMutationWorkerError extends Error {
  constructor(readonly code: string, detail: string | null = null) {
    super(detail === null ? code : `${code}: ${detail}`);
    this.name = "DeploymentMutationWorkerError";
  }
}
