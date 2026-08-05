import { WorkerEntrypoint } from "cloudflare:workers";

const SOURCE_AUTH_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-deployment-transition-source-authentication-v1";
const READBACK_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-deployment-transition-readback-v1";
const MUTATION_OUTCOME_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-deployment-transition-mutation-outcome-v1";

let sourceAuthenticationCalls = 0;
let readbackCalls = 0;
let mutationCalls = 0;
const observationBases = new Map();

export class JsonCompatibilitySourceVerifierEntrypoint
  extends WorkerEntrypoint {
  async authenticateTransitionSource(sourceEvidence) {
    sourceAuthenticationCalls += 1;
    const subject = {
      schemaVersion: 1,
      contract: SOURCE_AUTH_CONTRACT,
      classification: "authenticated",
      sourceEvidence,
      verifierIdentitySha256: await sha256Canonical({
        service: "runtime-source-verifier",
        version: 1,
      }),
      evidenceSha256: await sha256Canonical({
        sourceEvidence,
        verification: "runtime-fixture",
      }),
      verifiedAt: Math.floor(Date.now() / 1000),
    };
    return {
      ...subject,
      sourceAuthenticationDigestSha256: await sha256Canonical(subject),
    };
  }
}

export class JsonCompatibilityDeploymentLeafEntrypoint
  extends WorkerEntrypoint {
  async readDeploymentState(input) {
    readbackCalls += 1;
    const expected = input.expected;
    const observationKey = [
      input.operationIdSha256,
      input.step.ordinal,
      input.phase,
    ].join(":");
    if (!observationBases.has(observationKey)) {
      observationBases.set(observationKey, Math.floor(Date.now() / 1000));
    }
    const observedAt = observationBases.get(observationKey)
      + (input.observationOrdinal - 1) * 5;
    const bindingSetSha256 = await sha256Canonical({
      role: input.step.role,
      bindings: "runtime-fixture",
    });
    const secretNameSetSha256 = await sha256Canonical({
      role: input.step.role,
      secretNames: "runtime-fixture",
    });
    const durableObjectMigrationSetSha256 = await sha256Canonical({
      role: input.step.role,
      migrations: "runtime-fixture",
    });
    const authenticationIdentitySha256 = await sha256Canonical({
      credential: "runtime-readback",
    });
    const remoteStateSha256 = await sha256Canonical({
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
      bindingSetSha256,
      routeSetSha256: expected.routeSetSha256,
      secretNameSetSha256,
      durableObjectMigrationSetSha256,
      authenticationIdentitySha256,
    });
    const subject = {
      schemaVersion: 1,
      contract: READBACK_CONTRACT,
      classification: "observed",
      ...expected,
      bindingSetSha256,
      secretNameSetSha256,
      durableObjectMigrationSetSha256,
      authenticationIdentitySha256,
      readbackRequestIdSha256: await sha256Canonical({
        request: readbackCalls,
      }),
      remoteStateSha256,
      remoteEvidenceSha256: await sha256Canonical({
        remote: readbackCalls,
        expected,
      }),
      authenticationEvidenceSha256: await sha256Canonical({
        authentication: readbackCalls,
      }),
      observedAt,
    };
    return {
      ...subject,
      observationDigestSha256: await sha256Canonical(subject),
    };
  }

  async mutateDeploymentOnce(mutationIntent) {
    mutationCalls += 1;
    const subject = {
      schemaVersion: 1,
      contract: MUTATION_OUTCOME_CONTRACT,
      mutationIntentSha256: mutationIntent.mutationIntentSha256,
      classification: "accepted",
      httpStatus: 200,
      responseBodySha256: await sha256Canonical({
        mutation: mutationCalls,
        role: mutationIntent.role,
      }),
      responseRequestIdSha256: await sha256Canonical({
        request: `mutation-${mutationCalls}`,
      }),
      responseBytes: 128,
    };
    return {
      ...subject,
      outcomeDigestSha256: await sha256Canonical(subject),
    };
  }
}

export class JsonCompatibilityDeploymentTransitionMockControlEntrypoint
  extends WorkerEntrypoint {
  reset() {
    sourceAuthenticationCalls = 0;
    readbackCalls = 0;
    mutationCalls = 0;
    observationBases.clear();
  }

  getCallCounts() {
    return {
      sourceAuthenticationCalls,
      readbackCalls,
      mutationCalls,
    };
  }
}

export default class JsonCompatibilityDeploymentTransitionMockDefaultEntrypoint
  extends WorkerEntrypoint {}

async function sha256Canonical(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")).join("");
}

function canonicalize(value) {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  throw new Error("runtime fixture cannot canonicalize value");
}
