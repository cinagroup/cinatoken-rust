import {
  readCloudflareDeploymentState,
  RemoteReadbackAmbiguity,
  type CloudflareReadbackDependencies,
} from "./cloudflare";
import {
  buildAmbiguousReadback,
  buildObservedReadback,
  type JsonCompatibilityDeploymentReadbackEnv,
  type ValidatedReadbackInvocation,
  validateReadbackInvocation,
  validateRecoveryReadbackInvocation,
} from "./protocol";

export type { JsonCompatibilityDeploymentReadbackEnv } from "./protocol";

export interface ReadbackDependencies extends CloudflareReadbackDependencies {}

export async function readDeploymentState(
  env: JsonCompatibilityDeploymentReadbackEnv,
  input: unknown,
  dependencies: ReadbackDependencies = {},
): Promise<Record<string, unknown>> {
  return await readDeploymentStateWithValidator(
    env,
    input,
    dependencies,
    validateReadbackInvocation,
  );
}

export async function readDeploymentStateForResolution(
  env: JsonCompatibilityDeploymentReadbackEnv,
  input: unknown,
  dependencies: ReadbackDependencies = {},
): Promise<Record<string, unknown>> {
  return await readDeploymentStateWithValidator(
    env,
    input,
    dependencies,
    validateRecoveryReadbackInvocation,
  );
}

async function readDeploymentStateWithValidator(
  env: JsonCompatibilityDeploymentReadbackEnv,
  input: unknown,
  dependencies: ReadbackDependencies,
  validateInvocation: (
    env: JsonCompatibilityDeploymentReadbackEnv,
    input: unknown,
    nowMilliseconds: number,
  ) => Promise<ValidatedReadbackInvocation>,
): Promise<Record<string, unknown>> {
  const nowMilliseconds = dependencies.nowMilliseconds ?? Date.now;
  const validationTime = nowMilliseconds();

  // This completes every authority, digest, artifact, and runtime identity check
  // before the capability token property is touched.
  const invocation = await validateInvocation(
    env,
    input,
    validationTime,
  );

  const apiToken = env.CLOUDFLARE_DEPLOYMENT_READ_API_TOKEN;
  if (!validApiToken(apiToken)) {
    return buildAmbiguousReadback(
      invocation,
      Math.floor(nowMilliseconds() / 1000),
      { code: "credential_unavailable" },
    );
  }

  try {
    const observation = await readCloudflareDeploymentState(
      {
        accountId: invocation.accountId,
        apiToken,
        credentialIdSha256:
          invocation.context.expected.authenticationIdentitySha256,
        readbackRequestSha256:
          invocation.context.readbackRequest.readbackRequestSha256,
        expected: invocation.context.expected,
      },
      dependencies,
    );
    return buildObservedReadback(invocation, observation);
  } catch (error) {
    const evidence = error instanceof RemoteReadbackAmbiguity
      ? {
          code: error.code,
          ...(error.endpointPath === undefined
            ? {}
            : { endpointPath: error.endpointPath }),
          ...(error.httpStatus === undefined
            ? {}
            : { httpStatus: error.httpStatus }),
          ...(error.responseBytes === undefined
            ? {}
            : { responseBytes: error.responseBytes }),
          ...(error.responseRequestIdSha256 === undefined
            ? {}
            : {
                responseRequestIdSha256:
                  error.responseRequestIdSha256,
              }),
        }
      : { code: "unclassified_remote_failure" };
    return buildAmbiguousReadback(
      invocation,
      Math.floor(nowMilliseconds() / 1000),
      evidence,
    );
  }
}

function validApiToken(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 4096
    && value.trim() === value
    && !/\s/.test(value)
    && !value.startsWith("Bearer ");
}
