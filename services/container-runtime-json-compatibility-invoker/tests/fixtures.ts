import {
  canonicalJson,
  sha256Hex,
} from "../../container-controller/src/json_compatibility_probe";
import {
  JSON_COMPATIBILITY_EXECUTE_PHASE_REQUEST_CONTRACT,
  type JsonCompatibilityPhaseId,
  type JsonCompatibilityTopologyV1,
} from "../../container-runtime-json-compatibility-executor/src/protocol";
import {
  JSON_COMPATIBILITY_INVOKER_SERVICE_NAME,
  JSON_COMPATIBILITY_PERMIT_ISSUE_INTENT_CONTRACT,
  type JsonCompatibilityPermitIssueIntentV1,
} from "../../container-runtime-json-compatibility-permit-issuer/src/protocol";
import {
  JSON_COMPATIBILITY_INVOKE_AUTHORITY_CLAIMS_CONTRACT,
  JSON_COMPATIBILITY_INVOKE_COMMAND_CONTRACT,
  JSON_COMPATIBILITY_INVOKE_COMMAND_SUBJECT_CONTRACT,
  JSON_COMPATIBILITY_INVOCATION_STATUS_AUTHORITY_CLAIMS_CONTRACT,
  JSON_COMPATIBILITY_INVOCATION_STATUS_QUERY_CONTRACT,
  JSON_COMPATIBILITY_INVOCATION_STATUS_QUERY_SUBJECT_CONTRACT,
  JSON_COMPATIBILITY_INVOCATION_STATUS_TARGET_CONTRACT,
  createInvocationStatusAuthorityEnvelope,
  createInvokeAuthorityEnvelope,
  deriveJsonCompatibilityInvocationStatusQueryId,
  type JsonCompatibilityInvocationStatusQueryV1,
  type JsonCompatibilityInvocationStatusTargetV1,
  type JsonCompatibilityInvokerStatusOperatorEnv,
  type JsonCompatibilityInvokeCommandV1,
  type JsonCompatibilityInvokerOperatorEnv,
} from "../src/authorization";

export const NOW_MS = Date.parse("2026-08-04T03:00:00Z");
export const NOW_SECONDS = Math.floor(NOW_MS / 1000);
export const INVOKER_VERSION_ID = "invoker-version-001";
export const OPERATOR_ISSUER =
  "cinatoken-json-compatibility-campaign-operator-staging";
export const OPERATOR_SECRET =
  "json-compatibility-operator-secret-32-byte-minimum";
export const OPERATOR_KEY_ID = "json-campaign-operator-current-2026-08";
export const OPERATOR_CREDENTIAL_ID_SHA256 = "b1".repeat(32);
export const STATUS_OPERATOR_ISSUER =
  "cinatoken-json-compatibility-campaign-operator-status-staging";
export const STATUS_OPERATOR_SECRET =
  "json-compatibility-status-operator-secret-minimum";
export const STATUS_OPERATOR_KEY_ID =
  "json-campaign-status-operator-current-2026-08";
export const STATUS_OPERATOR_CREDENTIAL_ID_SHA256 = "b3".repeat(32);
export const ISSUER_HMAC_SECRET =
  "json-compatibility-invoker-issuer-secret-minimum";
export const ISSUER_HMAC_KEY_ID = "json-invoker-issuer-current-2026-08";
export const ISSUER_HMAC_CREDENTIAL_ID_SHA256 = "b2".repeat(32);
export const PERMIT_KEY_ID = "json-permit-signing-2026-08";

export const PERMIT_KEY_PAIR = await crypto.subtle.generateKey(
  { name: "Ed25519" },
  true,
  ["sign", "verify"],
);
export const PERMIT_PKCS8 = new Uint8Array(
  await crypto.subtle.exportKey("pkcs8", PERMIT_KEY_PAIR.privateKey),
);
export const PERMIT_SPKI = new Uint8Array(
  await crypto.subtle.exportKey("spki", PERMIT_KEY_PAIR.publicKey),
);
export const PERMIT_SPKI_SHA256 = await sha256Hex(PERMIT_SPKI);

export function topologyFor(
  phaseId: JsonCompatibilityPhaseId,
  candidateShardIndex = 3,
): JsonCompatibilityTopologyV1 {
  if (phaseId === "mixed-n-n-minus-one") {
    return {
      defaultRuntime: "n-minus-one",
      overrides: [{ shardIndex: candidateShardIndex, runtime: "n" }],
    };
  }
  return {
    defaultRuntime: phaseId === "candidate-n" ? "n" : "n-minus-one",
    overrides: [],
  };
}

export function validIntent(
  phaseId: JsonCompatibilityPhaseId = "baseline-n-minus-one",
  campaignIdSha256 = "11".repeat(32),
): JsonCompatibilityPermitIssueIntentV1 {
  const ordinal = ([
    "baseline-n-minus-one",
    "mixed-n-n-minus-one",
    "candidate-n",
    "rollback-n-minus-one",
  ].indexOf(phaseId) + 1) as 1 | 2 | 3 | 4;
  return {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_PERMIT_ISSUE_INTENT_CONTRACT,
    execution: {
      schemaVersion: 2,
      contract: JSON_COMPATIBILITY_EXECUTE_PHASE_REQUEST_CONTRACT,
      kind: "container-runtime-json-compatibility-phase-execution",
      environment: "staging",
      campaignIdSha256,
      planDigestSha256: "22".repeat(32),
      phaseExecutionId: `json-compat-${phaseId}-001`,
      controller: {
        serviceName: "cinatoken-container-controller-staging",
        versionId: "controller-version-001",
        configSha256: "33".repeat(32),
      },
      runtimes: {
        n: {
          buildIdSha256: "44".repeat(32),
          imageDigest: `sha256:${"55".repeat(32)}`,
        },
        nMinusOne: {
          buildIdSha256: "66".repeat(32),
          imageDigest: `sha256:${"77".repeat(32)}`,
        },
      },
      ring: { generation: 9, shardCount: 8, candidateShardIndex: 3 },
      phase: { ordinal, id: phaseId, topology: topologyFor(phaseId) },
    },
    executor: {
      serviceName:
        "cinatoken-container-runtime-json-compatibility-executor-staging",
      versionId: "executor-version-001",
    },
    invoker: {
      serviceName: JSON_COMPATIBILITY_INVOKER_SERVICE_NAME,
      versionId: INVOKER_VERSION_ID,
    },
    authorizationIdSha256: "88".repeat(32),
    topologyReadbackSha256: "99".repeat(32),
    beforeContextSha256: "aa".repeat(32),
    issuedAt: NOW_SECONDS,
    notBefore: NOW_SECONDS,
    expiresAt: NOW_SECONDS + 300,
  };
}

export function operatorEnv(): JsonCompatibilityInvokerOperatorEnv {
  return {
    JSON_COMPATIBILITY_INVOKER_OPERATOR_ISSUER: OPERATOR_ISSUER,
    JSON_COMPATIBILITY_INVOKER_OPERATOR_AUDIENCE:
      JSON_COMPATIBILITY_INVOKER_SERVICE_NAME,
    JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_KID: OPERATOR_KEY_ID,
    JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256:
      OPERATOR_CREDENTIAL_ID_SHA256,
    JSON_COMPATIBILITY_INVOKER_OPERATOR_PREVIOUS_KID: "",
    JSON_COMPATIBILITY_INVOKER_OPERATOR_PREVIOUS_CREDENTIAL_ID_SHA256: "",
    JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_SECRET: OPERATOR_SECRET,
  };
}

export function statusOperatorEnv(): JsonCompatibilityInvokerStatusOperatorEnv {
  return {
    JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_ISSUER: STATUS_OPERATOR_ISSUER,
    JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_AUDIENCE:
      JSON_COMPATIBILITY_INVOKER_SERVICE_NAME,
    JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_CURRENT_KID:
      STATUS_OPERATOR_KEY_ID,
    JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256:
      STATUS_OPERATOR_CREDENTIAL_ID_SHA256,
    JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_PREVIOUS_KID: "",
    JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_PREVIOUS_CREDENTIAL_ID_SHA256:
      "",
    JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_CURRENT_SECRET:
      STATUS_OPERATOR_SECRET,
  };
}

export async function validInvokeCommand(
  intent = validIntent(),
  secret = OPERATOR_SECRET,
  keyId = OPERATOR_KEY_ID,
  credentialIdSha256 = OPERATOR_CREDENTIAL_ID_SHA256,
): Promise<JsonCompatibilityInvokeCommandV1> {
  const subject = {
    schemaVersion: 1 as const,
    contract: JSON_COMPATIBILITY_INVOKE_COMMAND_SUBJECT_CONTRACT,
    commandIdSha256: intent.authorizationIdSha256,
    issueIntent: intent,
  };
  const authority = await createInvokeAuthorityEnvelope(secret, keyId, {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_INVOKE_AUTHORITY_CLAIMS_CONTRACT,
    issuer: OPERATOR_ISSUER,
    audience: JSON_COMPATIBILITY_INVOKER_SERVICE_NAME,
    credentialIdSha256,
    commandIdSha256: subject.commandIdSha256,
    commandSubjectSha256: await sha256Hex(canonicalJson(subject)),
    issuedAt: NOW_SECONDS,
    expiresAt: NOW_SECONDS + 60,
  });
  return {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_INVOKE_COMMAND_CONTRACT,
    subject,
    authority,
  };
}

export function validStatusTarget(
  intent = validIntent(),
): JsonCompatibilityInvocationStatusTargetV1 {
  return {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_INVOCATION_STATUS_TARGET_CONTRACT,
    campaignIdSha256: intent.execution.campaignIdSha256,
    planDigestSha256: intent.execution.planDigestSha256,
    phaseOrdinal: intent.execution.phase.ordinal,
    phaseId: intent.execution.phase.id,
    phaseExecutionId: intent.execution.phaseExecutionId,
    commandIdSha256: intent.authorizationIdSha256,
    operatorRequestSha256: "c3".repeat(32),
    approvalEnvelopeSha256: "c4".repeat(32),
    operatorVersionId: "operator-version-001",
    invokerVersionId: intent.invoker.versionId,
  };
}

export async function validStatusQuery(
  target = validStatusTarget(),
  issuedAt = NOW_SECONDS,
): Promise<JsonCompatibilityInvocationStatusQueryV1> {
  const statusQueryIdSha256 =
    await deriveJsonCompatibilityInvocationStatusQueryId(target, issuedAt);
  const subject = {
    schemaVersion: 1 as const,
    contract: JSON_COMPATIBILITY_INVOCATION_STATUS_QUERY_SUBJECT_CONTRACT,
    statusQueryIdSha256,
    target,
  };
  return {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_INVOCATION_STATUS_QUERY_CONTRACT,
    subject,
    authority: await createInvocationStatusAuthorityEnvelope(
      STATUS_OPERATOR_SECRET,
      STATUS_OPERATOR_KEY_ID,
      {
        schemaVersion: 1,
        contract:
          JSON_COMPATIBILITY_INVOCATION_STATUS_AUTHORITY_CLAIMS_CONTRACT,
        issuer: STATUS_OPERATOR_ISSUER,
        audience: JSON_COMPATIBILITY_INVOKER_SERVICE_NAME,
        credentialIdSha256: STATUS_OPERATOR_CREDENTIAL_ID_SHA256,
        statusQueryIdSha256,
        statusQuerySubjectSha256: await sha256Hex(canonicalJson(subject)),
        issuedAt,
        expiresAt: issuedAt + 30,
      },
    ),
  };
}

export function encodeBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}
