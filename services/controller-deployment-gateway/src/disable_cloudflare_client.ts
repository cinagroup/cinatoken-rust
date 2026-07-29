import {
  canonicalJson,
  sha256Canonical,
  sha256Hex,
} from "./protocol";
import type { FrozenControllerDisableCommand } from "./disable_protocol";

export const DISABLE_MUTATION_INTENT_CONTRACT =
  "cinatoken-controller-deployment-gateway-disable-intent-v1";
export const DISABLE_DISPATCH_SEMANTICS =
  "unique_disable_mutation_authority_persisted_network_may_not_have_occurred";

const API_ORIGIN = "https://api.cloudflare.com";
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_BUDGET_MS = 3_000;
const REQUEST_ID_HEADERS = ["cf-ray", "cf-request-id"] as const;

export type DisableMutationClassification =
  | "accepted"
  | "rejected"
  | "ambiguous";
export type DisableObservationClassification =
  | "exact_disable_observed"
  | "enabled_source_observed"
  | "deployment_drift"
  | "ambiguous";

export interface DisableCloudflareGatewayEnv {
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_DEPLOY_API_TOKEN?: string;
  CLOUDFLARE_READ_API_TOKEN?: string;
}

export interface DisableDeploymentMutation {
  body: string;
  mutationRequestSha256: string;
  mutationAnnotation: string;
  intentDigestSha256: string;
  endpointPath: string;
}

export interface DisableMutationOutcome {
  classification: DisableMutationClassification;
  httpStatus: number | null;
  responseBodySha256: string | null;
  responseRequestIdSha256: string | null;
  responseBytes: number | null;
}

export interface DisableStatusObservation {
  classification: DisableObservationClassification;
  deploymentsHttpStatus: number | null;
  baselineVersionHttpStatus: number | null;
  deploymentSetSha256: string | null;
  baselineVersionSha256: string | null;
  responseRequestIdSha256: string | null;
}

export interface DisableCloudflareClientDependencies {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  now(): number;
}

const DEFAULT_DEPENDENCIES: DisableCloudflareClientDependencies = {
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
};

export async function buildDisableDeploymentMutation(
  accountId: string,
  command: FrozenControllerDisableCommand,
): Promise<DisableDeploymentMutation> {
  const intentDigestSha256 = await sha256Canonical({
    schemaVersion: 1,
    contract: DISABLE_MUTATION_INTENT_CONTRACT,
    authorizationIdSha256: command.authorizationIdSha256,
    claimDigestSha256: command.claimDigestSha256,
    operation14IdSha256: command.operation14IdSha256,
    authorityDatabaseIdentitySha256:
      command.authorityDatabaseIdentitySha256,
    authorityLedgerIdentitySha256:
      command.authorityLedgerIdentitySha256,
    authorityLedgerHeadSha256: command.authorityLedgerHeadSha256,
    authorityVersionId: command.authorityVersionId,
    leaseOwnerSha256: command.leaseOwnerSha256,
    leaseTokenSha256: command.leaseTokenSha256,
    leaseGeneration: command.leaseGeneration,
    controllerServiceName: command.controllerServiceName,
    controllerEnabledSourceVersionId:
      command.controllerEnabledSourceVersionId,
    controllerBaselineTargetVersionId:
      command.controllerBaselineTargetVersionId,
  });
  const mutationAnnotation =
    `cinatoken-controller-disable-v1:${command.operation14IdSha256}:` +
    intentDigestSha256;
  const body = canonicalJson({
    annotations: {
      "workers/message": mutationAnnotation,
    },
    strategy: "percentage",
    versions: [
      {
        percentage: 100,
        version_id: command.controllerBaselineTargetVersionId,
      },
    ],
  });
  return {
    body,
    mutationRequestSha256:
      await sha256Hex(new TextEncoder().encode(body)),
    mutationAnnotation,
    intentDigestSha256,
    endpointPath: deploymentPath(accountId, command.controllerServiceName),
  };
}

export async function createDisableDeploymentOnce(
  env: DisableCloudflareGatewayEnv,
  command: FrozenControllerDisableCommand,
  mutation: DisableDeploymentMutation,
  dependencies: DisableCloudflareClientDependencies = DEFAULT_DEPENDENCIES,
): Promise<DisableMutationOutcome> {
  const token = env.CLOUDFLARE_DEPLOY_API_TOKEN;
  if (token === undefined || token.length < 20) return ambiguousOutcome();
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
    return { ...ambiguousOutcome(), httpStatus: response.status };
  }
  const requestIdSha256 = await responseRequestIdSha256(response);
  if (response.ok) {
    return {
      classification: validDisableCreateResponse(
        evidence.body,
        command,
        mutation,
      )
        ? "accepted"
        : "ambiguous",
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

export async function readDisableDeploymentStatus(
  env: DisableCloudflareGatewayEnv,
  command: FrozenControllerDisableCommand,
  dependencies: DisableCloudflareClientDependencies = DEFAULT_DEPENDENCIES,
): Promise<DisableStatusObservation> {
  const token = env.CLOUDFLARE_READ_API_TOKEN;
  if (token === undefined || token.length < 20) {
    return ambiguousObservation();
  }
  const deploymentEndpoint = deploymentPath(
    env.CLOUDFLARE_ACCOUNT_ID,
    command.controllerServiceName,
  );
  const baselineVersionEndpoint =
    `${scriptPath(env.CLOUDFLARE_ACCOUNT_ID, command.controllerServiceName)}` +
    `/versions/${
      encodeURIComponent(command.controllerBaselineTargetVersionId)
    }`;
  const deadline = dependencies.now() + REQUEST_BUDGET_MS;
  const deployments = await boundedGet(
    `${API_ORIGIN}${deploymentEndpoint}`,
    token,
    dependencies,
    deadline,
  );
  const baselineVersion = await boundedGet(
    `${API_ORIGIN}${baselineVersionEndpoint}`,
    token,
    dependencies,
    deadline,
  );
  const responseRequestIdSha256 = await combinedRequestIdSha256([
    deployments.response,
    baselineVersion.response,
  ]);
  if (
    deployments.evidence === null
    || baselineVersion.evidence === null
    || deployments.response?.ok !== true
    || baselineVersion.response?.ok !== true
  ) {
    return {
      classification: "ambiguous",
      deploymentsHttpStatus: deployments.response?.status ?? null,
      baselineVersionHttpStatus: baselineVersion.response?.status ?? null,
      deploymentSetSha256: deployments.evidence?.sha256 ?? null,
      baselineVersionSha256: baselineVersion.evidence?.sha256 ?? null,
      responseRequestIdSha256,
    };
  }
  const expectedMutation = await buildDisableDeploymentMutation(
    env.CLOUDFLARE_ACCOUNT_ID,
    command,
  );
  const activeDeployment = latestDeployment(deployments.evidence.body);
  const active = activeDeployment?.versions ?? [];
  const baselineReadable = validVersionResponse(
    baselineVersion.evidence.body,
    command.controllerBaselineTargetVersionId,
  );
  let classification: DisableObservationClassification;
  if (activeDeployment === null || !baselineReadable) {
    classification = "ambiguous";
  } else if (
    activeDeployment.annotation === expectedMutation.mutationAnnotation
    && active.length === 1
    && active[0]?.versionId === command.controllerBaselineTargetVersionId
    && active[0]?.percentage === 100
  ) {
    classification = "exact_disable_observed";
  } else if (
    active.length === 1
    && active[0]?.versionId === command.controllerEnabledSourceVersionId
    && active[0]?.percentage === 100
  ) {
    classification = "enabled_source_observed";
  } else {
    classification = "deployment_drift";
  }
  return {
    classification,
    deploymentsHttpStatus: deployments.response.status,
    baselineVersionHttpStatus: baselineVersion.response.status,
    deploymentSetSha256: await sha256Canonical(active),
    baselineVersionSha256: await sha256Canonical({
      id: command.controllerBaselineTargetVersionId,
    }),
    responseRequestIdSha256,
  };
}

async function boundedGet(
  url: string,
  token: string,
  dependencies: DisableCloudflareClientDependencies,
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
      signal: AbortSignal.timeout(
        Math.max(1, deadline - dependencies.now()),
      ),
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

function validDisableCreateResponse(
  body: Uint8Array,
  command: FrozenControllerDisableCommand,
  mutation: DisableDeploymentMutation,
): boolean {
  const parsed = parseJsonObject(body);
  if (parsed === null || parsed.success !== true) return false;
  const result = parsed.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return false;
  }
  const record = result as Record<string, unknown>;
  const annotations = record.annotations;
  if (
    typeof record.id !== "string"
    || record.id.length === 0
    || record.strategy !== "percentage"
    || typeof annotations !== "object"
    || annotations === null
    || Array.isArray(annotations)
    || (annotations as Record<string, unknown>)["workers/message"]
      !== mutation.mutationAnnotation
    || !Array.isArray(record.versions)
    || record.versions.length !== 1
  ) {
    return false;
  }
  const version = record.versions[0];
  return (
    typeof version === "object"
    && version !== null
    && !Array.isArray(version)
    && (version as Record<string, unknown>).version_id
      === command.controllerBaselineTargetVersionId
    && (version as Record<string, unknown>).percentage === 100
  );
}

function validVersionResponse(body: Uint8Array, versionId: string): boolean {
  const parsed = parseJsonObject(body);
  if (parsed === null || parsed.success !== true) return false;
  const result = parsed.result;
  return (
    typeof result === "object"
    && result !== null
    && !Array.isArray(result)
    && (result as Record<string, unknown>).id === versionId
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
  for (const version of versions) {
    if (
      typeof version !== "object"
      || version === null
      || Array.isArray(version)
    ) {
      return null;
    }
    const versionRecord = version as Record<string, unknown>;
    if (
      typeof versionRecord.version_id !== "string"
      || typeof versionRecord.percentage !== "number"
      || !Number.isFinite(versionRecord.percentage)
      || versionRecord.percentage <= 0
      || versionRecord.percentage > 100
    ) {
      return null;
    }
    active.push({
      versionId: versionRecord.version_id,
      percentage: versionRecord.percentage,
    });
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

function ambiguousOutcome(): DisableMutationOutcome {
  return {
    classification: "ambiguous",
    httpStatus: null,
    responseBodySha256: null,
    responseRequestIdSha256: null,
    responseBytes: null,
  };
}

function ambiguousObservation(): DisableStatusObservation {
  return {
    classification: "ambiguous",
    deploymentsHttpStatus: null,
    baselineVersionHttpStatus: null,
    deploymentSetSha256: null,
    baselineVersionSha256: null,
    responseRequestIdSha256: null,
  };
}

function deploymentPath(accountId: string, serviceName: string): string {
  return `${scriptPath(accountId, serviceName)}/deployments`;
}

function scriptPath(accountId: string, serviceName: string): string {
  return `/client/v4/accounts/${encodeURIComponent(accountId)}` +
    `/workers/scripts/${encodeURIComponent(serviceName)}`;
}
