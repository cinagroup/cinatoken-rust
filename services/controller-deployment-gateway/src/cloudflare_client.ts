import {
  canonicalJson,
  sha256Canonical,
  sha256Hex,
  type FrozenControllerEnableCommand,
} from "./protocol";

export const MUTATION_INTENT_CONTRACT =
  "cinatoken-controller-deployment-gateway-mutation-intent-v1";
export const DISPATCH_SEMANTICS =
  "unique_mutation_authority_persisted_network_may_not_have_occurred";

const API_ORIGIN = "https://api.cloudflare.com";
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_BUDGET_MS = 3_000;
const REQUEST_ID_HEADERS = ["cf-ray", "cf-request-id"] as const;

export type MutationClassification = "accepted" | "rejected" | "ambiguous";
export type ObservationClassification =
  | "target_observed"
  | "baseline_observed"
  | "deployment_drift"
  | "ambiguous";

export interface CloudflareGatewayEnv {
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_DEPLOY_API_TOKEN?: string;
  CLOUDFLARE_READ_API_TOKEN?: string;
}

export interface DeploymentMutation {
  body: string;
  mutationRequestSha256: string;
  mutationAnnotation: string;
  endpointPath: string;
}

export interface MutationOutcome {
  classification: MutationClassification;
  httpStatus: number | null;
  responseBodySha256: string | null;
  responseRequestIdSha256: string | null;
  responseBytes: number | null;
}

export interface StatusObservation {
  classification: ObservationClassification;
  deploymentsHttpStatus: number | null;
  versionHttpStatus: number | null;
  deploymentSetSha256: string | null;
  targetVersionSha256: string | null;
  responseRequestIdSha256: string | null;
  observationDigestSha256: string;
}

export interface CloudflareClientDependencies {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

const DEFAULT_DEPENDENCIES: CloudflareClientDependencies = {
  fetch: (input, init) => fetch(input, init),
};

export async function buildDeploymentMutation(
  accountId: string,
  command: FrozenControllerEnableCommand,
): Promise<DeploymentMutation> {
  const intentSha256 = await sha256Canonical({
    schemaVersion: 1,
    contract: MUTATION_INTENT_CONTRACT,
    authorizationIdSha256: command.authorizationIdSha256,
    controllerEnableOperationIdSha256:
      command.controllerEnableOperationIdSha256,
    controllerServiceName: command.controllerServiceName,
    controllerEnabledVersionId: command.controllerEnabledVersionId,
  });
  const mutationAnnotation =
    `cinatoken-controller-enable-v1:${command.controllerEnableOperationIdSha256}:${intentSha256}`;
  const body = canonicalJson({
    annotations: {
      "workers/message": mutationAnnotation,
    },
    strategy: "percentage",
    versions: [
      {
        percentage: 100,
        version_id: command.controllerEnabledVersionId,
      },
    ],
  });
  return {
    body,
    mutationRequestSha256:
      await sha256Hex(new TextEncoder().encode(body)),
    mutationAnnotation,
    endpointPath: deploymentPath(accountId, command.controllerServiceName),
  };
}

export async function createDeploymentOnce(
  env: CloudflareGatewayEnv,
  command: FrozenControllerEnableCommand,
  mutation: DeploymentMutation,
  dependencies: CloudflareClientDependencies = DEFAULT_DEPENDENCIES,
): Promise<MutationOutcome> {
  const token = env.CLOUDFLARE_DEPLOY_API_TOKEN;
  if (token === undefined || token.length < 20) {
    return ambiguousOutcome();
  }
  let response: Response;
  try {
    response = await dependencies.fetch(
      `${API_ORIGIN}${mutation.endpointPath}`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: mutation.body,
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
      },
    );
  } catch {
    return ambiguousOutcome();
  }
  const evidence = await responseEvidence(response);
  if (evidence === null) {
    return {
      ...ambiguousOutcome(),
      httpStatus: response.status,
    };
  }
  const requestIdSha256 = await responseRequestIdSha256(response);
  if (response.ok) {
    const valid = validDeploymentCreateResponse(
      evidence.body,
      command,
      mutation,
    );
    return {
      classification: valid ? "accepted" : "ambiguous",
      httpStatus: response.status,
      responseBodySha256: evidence.sha256,
      responseRequestIdSha256: requestIdSha256,
      responseBytes: evidence.bytes,
    };
  }
  return {
    classification: ambiguousHttpStatus(response.status)
      ? "ambiguous"
      : "rejected",
    httpStatus: response.status,
    responseBodySha256: evidence.sha256,
    responseRequestIdSha256: requestIdSha256,
    responseBytes: evidence.bytes,
  };
}

export async function readDeploymentStatus(
  env: CloudflareGatewayEnv,
  command: FrozenControllerEnableCommand,
  dependencies: CloudflareClientDependencies = DEFAULT_DEPENDENCIES,
): Promise<StatusObservation> {
  const token = env.CLOUDFLARE_READ_API_TOKEN;
  if (token === undefined || token.length < 20) {
    return buildObservation({
      classification: "ambiguous",
      deploymentsHttpStatus: null,
      versionHttpStatus: null,
      deploymentSetSha256: null,
      targetVersionSha256: null,
      responseRequestIdSha256: null,
    });
  }
  const basePath = deploymentPath(
    env.CLOUDFLARE_ACCOUNT_ID,
    command.controllerServiceName,
  );
  const versionPath =
    `${scriptPath(env.CLOUDFLARE_ACCOUNT_ID, command.controllerServiceName)}` +
    `/versions/${encodeURIComponent(command.controllerEnabledVersionId)}`;
  const deadline = Date.now() + REQUEST_BUDGET_MS;
  const deployments = await boundedGet(
    `${API_ORIGIN}${basePath}`,
    token,
    dependencies,
    deadline,
  );
  const version = await boundedGet(
    `${API_ORIGIN}${versionPath}`,
    token,
    dependencies,
    deadline,
  );
  const requestIdSha256 = await combinedRequestIdSha256([
    deployments.response,
    version.response,
  ]);
  if (
    deployments.evidence === null
    || version.evidence === null
    || deployments.response?.ok !== true
    || version.response?.ok !== true
  ) {
    return buildObservation({
      classification: "ambiguous",
      deploymentsHttpStatus: deployments.response?.status ?? null,
      versionHttpStatus: version.response?.status ?? null,
      deploymentSetSha256: deployments.evidence?.sha256 ?? null,
      targetVersionSha256: version.evidence?.sha256 ?? null,
      responseRequestIdSha256: requestIdSha256,
    });
  }
  const expectedMutation = await buildDeploymentMutation(
    env.CLOUDFLARE_ACCOUNT_ID,
    command,
  );
  const activeDeployment = latestDeployment(deployments.evidence.body);
  const active = activeDeployment?.versions ?? [];
  const targetVersionIsReadable = validVersionResponse(
    version.evidence.body,
    command.controllerEnabledVersionId,
  );
  let classification: ObservationClassification;
  if (activeDeployment === null || !targetVersionIsReadable) {
    classification = "ambiguous";
  } else if (
    targetVersionIsReadable
    && activeDeployment.annotation === expectedMutation.mutationAnnotation
    && active.length === 1
    && active[0]?.versionId === command.controllerEnabledVersionId
    && active[0]?.percentage === 100
  ) {
    classification = "target_observed";
  } else if (
    active.length === 1
    && active[0]?.versionId === command.controllerBaselineVersionId
    && active[0]?.percentage === 100
  ) {
    classification = "baseline_observed";
  } else {
    classification = "deployment_drift";
  }
  return buildObservation({
    classification,
    deploymentsHttpStatus: deployments.response.status,
    versionHttpStatus: version.response.status,
    deploymentSetSha256: await sha256Canonical(active),
    targetVersionSha256: version.evidence.sha256,
    responseRequestIdSha256: requestIdSha256,
  });
}

async function boundedGet(
  url: string,
  token: string,
  dependencies: CloudflareClientDependencies,
  deadline: number,
): Promise<{ response: Response | null; evidence: ResponseEvidence | null }> {
  let response: Response;
  try {
    response = await dependencies.fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    });
  } catch {
    return { response: null, evidence: null };
  }
  return { response, evidence: await responseEvidence(response) };
}

interface ResponseEvidence {
  body: Uint8Array;
  bytes: number;
  sha256: string;
}

async function responseEvidence(
  response: Response,
): Promise<ResponseEvidence | null> {
  const contentEncoding = response.headers.get("content-encoding");
  const declaredLength = response.headers.get("content-length");
  if (
    contentEncoding !== null
    || (
      declaredLength !== null
      && (
        !/^\d+$/.test(declaredLength)
        || Number(declaredLength) > MAX_RESPONSE_BYTES
      )
    )
  ) {
    await response.body?.cancel("response_not_admissible");
    return null;
  }
  if (response.body === null) {
    const empty = new Uint8Array();
    return { body: empty, bytes: 0, sha256: await sha256Hex(empty) };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel("response_too_large");
        return null;
      }
      chunks.push(next.value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body, bytes: total, sha256: await sha256Hex(body) };
}

function validDeploymentCreateResponse(
  body: Uint8Array,
  command: FrozenControllerEnableCommand,
  mutation: DeploymentMutation,
): boolean {
  const parsed = parseJsonObject(body);
  if (parsed === null || parsed.success !== true) return false;
  const result = parsed.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return false;
  }
  const record = result as Record<string, unknown>;
  if (
    typeof record.id !== "string"
    || record.id.length === 0
    || record.strategy !== "percentage"
  ) {
    return false;
  }
  const annotations = record.annotations;
  if (
    typeof annotations !== "object"
    || annotations === null
    || Array.isArray(annotations)
    || (annotations as Record<string, unknown>)["workers/message"]
      !== mutation.mutationAnnotation
  ) {
    return false;
  }
  if (!Array.isArray(record.versions) || record.versions.length !== 1) {
    return false;
  }
  const version = record.versions[0];
  return (
    typeof version === "object"
    && version !== null
    && !Array.isArray(version)
    && (version as Record<string, unknown>).version_id
      === command.controllerEnabledVersionId
    && (version as Record<string, unknown>).percentage === 100
  );
}

function validVersionResponse(body: Uint8Array, targetVersionId: string): boolean {
  const parsed = parseJsonObject(body);
  if (parsed === null || parsed.success !== true) return false;
  const result = parsed.result;
  return (
    typeof result === "object"
    && result !== null
    && !Array.isArray(result)
    && (result as Record<string, unknown>).id === targetVersionId
  );
}

interface ActiveVersion {
  versionId: string;
  percentage: number;
}

interface ActiveDeployment {
  annotation: string;
  createdOn: string;
  versions: ActiveVersion[];
}

function latestDeployment(body: Uint8Array): ActiveDeployment | null {
  const parsed = parseJsonObject(body);
  if (
    parsed === null
    || parsed.success !== true
    || typeof parsed.result !== "object"
    || parsed.result === null
    || Array.isArray(parsed.result)
    || !Array.isArray(
      (parsed.result as Record<string, unknown>).deployments,
    )
  ) {
    return null;
  }
  const deployments: ActiveDeployment[] = [];
  for (
    const value of
    (parsed.result as Record<string, unknown>).deployments as unknown[]
  ) {
    const deployment = parseDeployment(value);
    if (deployment === null) return null;
    deployments.push(deployment);
  }
  deployments.sort((left, right) => right.createdOn.localeCompare(left.createdOn));
  if (
    deployments.length === 0
    || (
      deployments.length > 1
      && deployments[0]?.createdOn === deployments[1]?.createdOn
    )
  ) {
    return null;
  }
  return deployments[0] ?? null;
}

function parseDeployment(value: unknown): ActiveDeployment | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const createdOn = record.created_on;
  const annotations = record.annotations;
  const versions = record.versions;
  if (
    typeof createdOn !== "string"
    || !Number.isFinite(Date.parse(createdOn))
    || typeof annotations !== "object"
    || annotations === null
    || Array.isArray(annotations)
    || typeof (annotations as Record<string, unknown>)["workers/message"]
      !== "string"
    || !Array.isArray(versions)
  ) {
    return null;
  }
  const active: ActiveVersion[] = [];
  for (const value of versions) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    const versionId = record.version_id;
    const percentage = record.percentage;
    if (
      typeof versionId !== "string"
      || typeof percentage !== "number"
      || !Number.isFinite(percentage)
      || percentage <= 0
      || percentage > 100
    ) {
      return null;
    }
    active.push({ versionId, percentage });
  }
  return {
    annotation:
      (annotations as Record<string, unknown>)["workers/message"] as string,
    createdOn: new Date(createdOn).toISOString(),
    versions:
      active.sort((left, right) => left.versionId.localeCompare(right.versionId)),
  };
}

function parseJsonObject(body: Uint8Array): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body),
    );
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function buildObservation(
  evidence: Omit<StatusObservation, "observationDigestSha256">,
): Promise<StatusObservation> {
  return {
    ...evidence,
    observationDigestSha256: await sha256Canonical({
      schemaVersion: 1,
      contract:
        "cinatoken-controller-deployment-gateway-status-observation-v1",
      ...evidence,
    }),
  };
}

async function responseRequestIdSha256(
  response: Response,
): Promise<string | null> {
  for (const header of REQUEST_ID_HEADERS) {
    const value = response.headers.get(header);
    if (value !== null && value.length > 0 && value.length <= 256) {
      return sha256Hex(new TextEncoder().encode(`${header}:${value}`));
    }
  }
  return null;
}

async function combinedRequestIdSha256(
  responses: Array<Response | null>,
): Promise<string | null> {
  const digests: string[] = [];
  for (const response of responses) {
    if (response === null) continue;
    const digest = await responseRequestIdSha256(response);
    if (digest !== null) digests.push(digest);
  }
  return digests.length === 0 ? null : sha256Canonical(digests);
}

function ambiguousHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function ambiguousOutcome(): MutationOutcome {
  return {
    classification: "ambiguous",
    httpStatus: null,
    responseBodySha256: null,
    responseRequestIdSha256: null,
    responseBytes: null,
  };
}

function deploymentPath(accountId: string, serviceName: string): string {
  return `${scriptPath(accountId, serviceName)}/deployments`;
}

function scriptPath(accountId: string, serviceName: string): string {
  return `/client/v4/accounts/${encodeURIComponent(accountId)}` +
    `/workers/scripts/${encodeURIComponent(serviceName)}`;
}
