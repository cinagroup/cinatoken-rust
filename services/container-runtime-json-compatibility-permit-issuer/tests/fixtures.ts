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
  JSON_COMPATIBILITY_PERMIT_ISSUE_AUTHORITY_CLAIMS_CONTRACT,
  JSON_COMPATIBILITY_PERMIT_ISSUE_INTENT_CONTRACT,
  JSON_COMPATIBILITY_PERMIT_ISSUE_REQUEST_CONTRACT,
  JSON_COMPATIBILITY_PERMIT_ISSUER_SERVICE_NAME,
  createPermitIssueAuthorityEnvelope,
  type JsonCompatibilityPermitIssueIntentV1,
  type JsonCompatibilityPermitIssueRequestV1,
  type JsonCompatibilityPermitIssuerEnv,
} from "../src/protocol";

export const NOW_MS = Date.parse("2026-08-04T02:00:00Z");
export const NOW_SECONDS = Math.floor(NOW_MS / 1000);
export const AUTHORITY_SECRET = "issuer-authority-secret-32-bytes-minimum-value";
export const AUTHORITY_KEY_ID = "json-invoker-current-2026-08";
export const AUTHORITY_CREDENTIAL_ID_SHA256 = "a1".repeat(32);
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
      campaignIdSha256: "11".repeat(32),
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
      versionId: "invoker-version-001",
    },
    authorizationIdSha256: "88".repeat(32),
    topologyReadbackSha256: "99".repeat(32),
    beforeContextSha256: "aa".repeat(32),
    issuedAt: NOW_SECONDS,
    notBefore: NOW_SECONDS,
    expiresAt: NOW_SECONDS + 300,
  };
}

export async function validIssueRequest(
  intent = validIntent(),
): Promise<JsonCompatibilityPermitIssueRequestV1> {
  const issueIntentSha256 = await sha256Hex(canonicalJson(intent));
  const authority = await createPermitIssueAuthorityEnvelope(
    AUTHORITY_SECRET,
    AUTHORITY_KEY_ID,
    {
      schemaVersion: 1,
      contract: JSON_COMPATIBILITY_PERMIT_ISSUE_AUTHORITY_CLAIMS_CONTRACT,
      issuer: JSON_COMPATIBILITY_INVOKER_SERVICE_NAME,
      audience: JSON_COMPATIBILITY_PERMIT_ISSUER_SERVICE_NAME,
      credentialIdSha256: AUTHORITY_CREDENTIAL_ID_SHA256,
      requestIdSha256: "bb".repeat(32),
      issueIntentSha256,
      issuedAt: NOW_SECONDS,
      expiresAt: NOW_SECONDS + 60,
    },
  );
  return {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_PERMIT_ISSUE_REQUEST_CONTRACT,
    intent,
    authority,
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

export function issuerEnv(
  recordIssuance: (input: unknown) => Promise<unknown>,
): JsonCompatibilityPermitIssuerEnv {
  return {
    ENVIRONMENT: "staging",
    JSON_COMPATIBILITY_PERMIT_ISSUER_ENABLED: "true",
    JSON_COMPATIBILITY_ISSUER_AUTHORITY_ISSUER:
      JSON_COMPATIBILITY_INVOKER_SERVICE_NAME,
    JSON_COMPATIBILITY_ISSUER_AUTHORITY_AUDIENCE:
      JSON_COMPATIBILITY_PERMIT_ISSUER_SERVICE_NAME,
    JSON_COMPATIBILITY_ISSUER_AUTHORITY_CURRENT_KID: AUTHORITY_KEY_ID,
    JSON_COMPATIBILITY_ISSUER_AUTHORITY_CURRENT_CREDENTIAL_ID_SHA256:
      AUTHORITY_CREDENTIAL_ID_SHA256,
    JSON_COMPATIBILITY_ISSUER_AUTHORITY_PREVIOUS_KID: "",
    JSON_COMPATIBILITY_ISSUER_AUTHORITY_PREVIOUS_CREDENTIAL_ID_SHA256: "",
    JSON_COMPATIBILITY_PERMIT_ISSUER:
      "cinatoken-json-compatibility-permit-issuer-staging",
    JSON_COMPATIBILITY_PERMIT_AUDIENCE:
      "cinatoken-container-runtime-json-compatibility-executor-staging",
    JSON_COMPATIBILITY_PERMIT_KEY_ID: PERMIT_KEY_ID,
    JSON_COMPATIBILITY_PERMIT_SPKI_SHA256: PERMIT_SPKI_SHA256,
    JSON_COMPATIBILITY_ISSUER_AUTHORITY_CURRENT_SECRET: AUTHORITY_SECRET,
    JSON_COMPATIBILITY_PERMIT_PKCS8_BASE64URL: encodeBase64url(PERMIT_PKCS8),
    JSON_COMPATIBILITY_PERMIT_SPKI_BASE64URL: encodeBase64url(PERMIT_SPKI),
    CF_VERSION_METADATA: { id: "permit-issuer-version-001" },
    JSON_COMPATIBILITY_PERMIT_ISSUANCE_AUTHORITY: {
      getByName: () => ({ recordIssuance }),
    } as never,
  };
}
