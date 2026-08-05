import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signSignature,
  verify as verifySignature,
} from "node:crypto";

import {
  JSON_COMPATIBILITY_OPERATOR_APPROVAL_MAX_LIFETIME_SECONDS,
  JSON_COMPATIBILITY_PLAN_CONTRACT,
  canonicalJson,
  sha256Canonical,
  validateJsonCompatibilityCampaignPlan,
} from "./container_runtime_json_compatibility_campaign.mjs";
import {
  JSON_COMPATIBILITY_OPERATOR_APPROVAL_ISSUER,
  JSON_COMPATIBILITY_OPERATOR_APPROVAL_SIGNATURE_DOMAIN,
  JSON_COMPATIBILITY_OPERATOR_AUTHORIZED_PHASE_REQUEST_CONTRACT,
  JSON_COMPATIBILITY_OPERATOR_PHASE_APPROVAL_ENVELOPE_CONTRACT,
  JSON_COMPATIBILITY_OPERATOR_PHASE_APPROVAL_SUBJECT_CONTRACT,
  deriveJsonCompatibilityOperatorCommandIdSha256,
  validateJsonCompatibilityOperatorPhaseRequest,
} from "./container_runtime_json_compatibility_operator_invocation.mjs";
import {
  validateJsonCompatibilityOperatorConfig,
} from "./prepare_container_runtime_json_compatibility_operator_config.mjs";

export {
  JSON_COMPATIBILITY_OPERATOR_APPROVAL_SIGNATURE_DOMAIN,
  JSON_COMPATIBILITY_OPERATOR_PHASE_APPROVAL_ENVELOPE_CONTRACT,
  JSON_COMPATIBILITY_OPERATOR_PHASE_APPROVAL_SUBJECT_CONTRACT,
};
export const JSON_COMPATIBILITY_OPERATOR_APPROVAL_SCHEMA_VERSION = 2;
export const JSON_COMPATIBILITY_OPERATOR_APPROVAL_PLAN_SCHEMA_VERSION = 4;

const OPERATOR_SERVICE =
  "cinatoken-container-runtime-json-compatibility-operator-staging";
const MAX_PRIVATE_KEY_BYTES = 64 * 1024;

export function signJsonCompatibilityOperatorApproval({
  plan: planInput,
  operatorConfig: configInput,
  request: requestInput,
  privateKeyBytes: privateKeyInput,
  keySlot = "current",
  now = new Date(),
}) {
  const plan = validateCurrentApprovalPlan(
    planInput,
    "operator approval signing",
  );
  const request = validateJsonCompatibilityOperatorPhaseRequest(
    plan,
    requestInput,
  );
  const config = validateOperatorConfigForPlan(configInput, plan);
  const selected = selectApprovalKey(config.vars, keySlot);
  requireEqual(
    selected.keyId,
    plan.operatorApproval.keyId,
    "approved plan key ID",
  );
  requireEqual(
    selected.spkiSha256,
    plan.operatorApproval.signerSpkiSha256,
    "approved plan SPKI digest",
  );
  const nowDate = requireDate(now);
  const issuedAt = Math.floor(nowDate.getTime() / 1000);
  const requestSha256 = sha256Canonical(request);
  const operatorVersionId = plan.privateServices.operator.versionId;
  const commandIdSha256 = deriveJsonCompatibilityOperatorCommandIdSha256(
    request,
    operatorVersionId,
  );

  const privateKeyBytes = Buffer.from(privateKeyInput ?? []);
  if (
    privateKeyBytes.length === 0
    || privateKeyBytes.length > MAX_PRIVATE_KEY_BYTES
  ) {
    throw new Error("operator approval private key is empty or oversized");
  }
  let privateKey;
  try {
    privateKey = createPrivateKey(privateKeyBytes);
  } catch {
    try {
      privateKey = createPrivateKey({
        key: privateKeyBytes,
        format: "der",
        type: "pkcs8",
      });
    } catch {
      throw new Error("operator approval private key is malformed");
    }
  } finally {
    privateKeyBytes.fill(0);
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("operator approval private key must be Ed25519");
  }
  const publicKey = createPublicKey(privateKey);
  const spki = publicKey.export({ format: "der", type: "spki" });
  const signerSpkiSha256 = createHash("sha256").update(spki).digest("hex");
  requireEqual(
    signerSpkiSha256,
    selected.spkiSha256,
    "operator approval private key SPKI digest",
  );

  const subject = {
    schemaVersion: JSON_COMPATIBILITY_OPERATOR_APPROVAL_SCHEMA_VERSION,
    contract: JSON_COMPATIBILITY_OPERATOR_PHASE_APPROVAL_SUBJECT_CONTRACT,
    environment: "staging",
    issuer: JSON_COMPATIBILITY_OPERATOR_APPROVAL_ISSUER,
    audience: OPERATOR_SERVICE,
    keyId: selected.keyId,
    operator: {
      serviceName: OPERATOR_SERVICE,
      versionId: operatorVersionId,
    },
    caller: structuredClone(plan.privateServices.runner),
    campaignIdSha256: request.execution.campaignIdSha256,
    planContract: JSON_COMPATIBILITY_PLAN_CONTRACT,
    planSchemaVersion: JSON_COMPATIBILITY_OPERATOR_APPROVAL_PLAN_SCHEMA_VERSION,
    planDigestSha256: request.execution.planDigestSha256,
    phaseExecutionId: request.execution.phaseExecutionId,
    phaseOrdinal: request.execution.phase.ordinal,
    phaseId: request.execution.phase.id,
    requestSha256,
    commandIdSha256,
    topologyReadbackSha256: request.topologyReadbackSha256,
    beforeContextSha256: request.beforeContextSha256,
    issuedAt,
    notBefore: issuedAt,
    expiresAt:
      issuedAt + JSON_COMPATIBILITY_OPERATOR_APPROVAL_MAX_LIFETIME_SECONDS,
  };
  const payload = Buffer.from(
    `${JSON_COMPATIBILITY_OPERATOR_APPROVAL_SIGNATURE_DOMAIN}${canonicalJson(subject)}`,
    "utf8",
  );
  const signature = signSignature(null, payload, privateKey);
  if (
    signature.length !== 64
    || !verifySignature(null, payload, publicKey, signature)
  ) {
    throw new Error("operator approval signature self-verification failed");
  }
  const approval = {
    schemaVersion: JSON_COMPATIBILITY_OPERATOR_APPROVAL_SCHEMA_VERSION,
    contract: JSON_COMPATIBILITY_OPERATOR_PHASE_APPROVAL_ENVELOPE_CONTRACT,
    algorithm: "Ed25519",
    subject,
    subjectSha256: sha256Canonical(subject),
    signerSpkiBase64url: spki.toString("base64url"),
    signatureBase64url: signature.toString("base64url"),
  };
  const authorized = {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_OPERATOR_AUTHORIZED_PHASE_REQUEST_CONTRACT,
    request,
    approval,
  };
  validateJsonCompatibilityOperatorApprovalArtifact(plan, authorized);
  return authorized;
}

export function validateJsonCompatibilityOperatorApprovalArtifact(
  planInput,
  input,
) {
  const plan = validateCurrentApprovalPlan(
    planInput,
    "operator approval artifact validation",
  );
  const value = record(input, "authorized operator request");
  exactKeys(
    value,
    ["schemaVersion", "contract", "request", "approval"],
    "authorized operator request",
  );
  requireEqual(value.schemaVersion, 1, "authorized request schema");
  requireEqual(
    value.contract,
    JSON_COMPATIBILITY_OPERATOR_AUTHORIZED_PHASE_REQUEST_CONTRACT,
    "authorized request contract",
  );
  const request = validateJsonCompatibilityOperatorPhaseRequest(
    plan,
    value.request,
  );
  const approval = record(value.approval, "operator approval envelope");
  exactKeys(approval, [
    "schemaVersion",
    "contract",
    "algorithm",
    "subject",
    "subjectSha256",
    "signerSpkiBase64url",
    "signatureBase64url",
  ], "operator approval envelope");
  requireEqual(
    approval.schemaVersion,
    JSON_COMPATIBILITY_OPERATOR_APPROVAL_SCHEMA_VERSION,
    "operator approval envelope schema",
  );
  requireEqual(
    approval.contract,
    JSON_COMPATIBILITY_OPERATOR_PHASE_APPROVAL_ENVELOPE_CONTRACT,
    "operator approval envelope contract",
  );
  requireEqual(approval.algorithm, "Ed25519", "operator approval algorithm");
  const subject = record(approval.subject, "operator approval subject");
  exactKeys(subject, [
    "schemaVersion", "contract", "environment", "issuer", "audience",
    "keyId", "operator", "caller", "campaignIdSha256",
    "planContract", "planSchemaVersion", "planDigestSha256",
    "phaseExecutionId", "phaseOrdinal", "phaseId",
    "requestSha256", "commandIdSha256", "topologyReadbackSha256",
    "beforeContextSha256", "issuedAt", "notBefore", "expiresAt",
  ], "operator approval subject");
  requireEqual(
    subject.schemaVersion,
    JSON_COMPATIBILITY_OPERATOR_APPROVAL_SCHEMA_VERSION,
    "operator approval subject schema",
  );
  requireEqual(
    subject.contract,
    JSON_COMPATIBILITY_OPERATOR_PHASE_APPROVAL_SUBJECT_CONTRACT,
    "operator approval subject contract",
  );
  requireEqual(subject.environment, "staging", "approval environment");
  requireEqual(subject.issuer, plan.operatorApproval.issuer, "approval issuer");
  requireEqual(subject.audience, plan.operatorApproval.audience, "approval audience");
  requireEqual(subject.keyId, plan.operatorApproval.keyId, "approval key ID");
  requireEqual(
    subject.planContract,
    JSON_COMPATIBILITY_PLAN_CONTRACT,
    "approval plan contract",
  );
  requireEqual(
    subject.planSchemaVersion,
    JSON_COMPATIBILITY_OPERATOR_APPROVAL_PLAN_SCHEMA_VERSION,
    "approval plan schema version",
  );
  canonicalEqual(subject.operator, {
    serviceName: OPERATOR_SERVICE,
    versionId: plan.privateServices.operator.versionId,
  }, "approval operator");
  canonicalEqual(subject.caller, plan.privateServices.runner, "approval caller");
  const expectedRequestSha256 = sha256Canonical(request);
  const expectedCommandIdSha256 =
    deriveJsonCompatibilityOperatorCommandIdSha256(
      request,
      plan.privateServices.operator.versionId,
    );
  for (const [name, expected] of [
    ["campaignIdSha256", request.execution.campaignIdSha256],
    ["planDigestSha256", plan.planDigestSha256],
    ["phaseExecutionId", request.execution.phaseExecutionId],
    ["phaseOrdinal", request.execution.phase.ordinal],
    ["phaseId", request.execution.phase.id],
    ["requestSha256", expectedRequestSha256],
    ["commandIdSha256", expectedCommandIdSha256],
    ["topologyReadbackSha256", request.topologyReadbackSha256],
    ["beforeContextSha256", request.beforeContextSha256],
  ]) requireEqual(subject[name], expected, `approval ${name}`);
  requireEqual(
    approval.subjectSha256,
    sha256Canonical(subject),
    "approval subject digest",
  );
  if (
    !Number.isSafeInteger(subject.issuedAt)
    || !Number.isSafeInteger(subject.notBefore)
    || !Number.isSafeInteger(subject.expiresAt)
    || subject.issuedAt < 0
    || subject.notBefore < 0
    || subject.expiresAt < 0
    || subject.notBefore < subject.issuedAt
    || subject.expiresAt <= subject.notBefore
    || subject.expiresAt - subject.issuedAt
      > plan.operatorApproval.maxLifetimeSeconds
  ) {
    throw new Error("operator approval time window is invalid");
  }
  const spki = canonicalBase64urlBytes(
    approval.signerSpkiBase64url,
    512,
    "operator approval SPKI",
  );
  const signature = canonicalBase64urlBytes(
    approval.signatureBase64url,
    64,
    "operator approval signature",
    64,
  );
  requireEqual(
    createHash("sha256").update(spki).digest("hex"),
    plan.operatorApproval.signerSpkiSha256,
    "operator approval SPKI digest",
  );
  let publicKey;
  try {
    publicKey = createPublicKey({ key: spki, format: "der", type: "spki" });
  } catch {
    throw new Error("operator approval SPKI is malformed");
  }
  const payload = Buffer.from(
    `${JSON_COMPATIBILITY_OPERATOR_APPROVAL_SIGNATURE_DOMAIN}${canonicalJson(subject)}`,
    "utf8",
  );
  if (
    publicKey.asymmetricKeyType !== "ed25519"
    || !verifySignature(null, payload, publicKey, signature)
  ) {
    throw new Error("operator approval signature is invalid");
  }
  return value;
}

function validateCurrentApprovalPlan(planInput, operation) {
  const plan = validateJsonCompatibilityCampaignPlan(planInput);
  if (
    plan.schemaVersion !== JSON_COMPATIBILITY_OPERATOR_APPROVAL_PLAN_SCHEMA_VERSION
    || plan.contract !== JSON_COMPATIBILITY_PLAN_CONTRACT
  ) {
    throw new Error(`${operation} requires the current plan contract and schema`);
  }
  return plan;
}

function validateOperatorConfigForPlan(configInput, plan) {
  const config = record(configInput, "operator campaign config");
  const vars = record(config.vars, "operator campaign config vars");
  const campaign = {
    currentKid: vars.JSON_COMPATIBILITY_OPERATOR_CURRENT_KID,
    currentCredentialIdSha256:
      vars.JSON_COMPATIBILITY_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256,
    statusCurrentKid:
      vars.JSON_COMPATIBILITY_OPERATOR_STATUS_CURRENT_KID,
    statusCurrentCredentialIdSha256:
      vars.JSON_COMPATIBILITY_OPERATOR_STATUS_CURRENT_CREDENTIAL_ID_SHA256,
    approvalCurrentKid:
      vars.JSON_COMPATIBILITY_OPERATOR_APPROVAL_CURRENT_KID,
    approvalCurrentSpkiSha256:
      vars.JSON_COMPATIBILITY_OPERATOR_APPROVAL_CURRENT_SPKI_SHA256,
    approvalPreviousKid:
      vars.JSON_COMPATIBILITY_OPERATOR_APPROVAL_PREVIOUS_KID,
    approvalPreviousSpkiSha256:
      vars.JSON_COMPATIBILITY_OPERATOR_APPROVAL_PREVIOUS_SPKI_SHA256,
    invokerVersionId:
      vars.JSON_COMPATIBILITY_OPERATOR_INVOKER_VERSION_ID,
  };
  validateJsonCompatibilityOperatorConfig(config, campaign);
  requireEqual(
    sha256Canonical(config),
    plan.privateServices.operator.configSha256,
    "operator config digest",
  );
  requireEqual(
    campaign.invokerVersionId,
    plan.privateServices.invoker.versionId,
    "operator pinned invoker version",
  );
  const executionAuthority = plan.statusRecovery?.statusAuthority?.execution;
  const statusAuthority = plan.statusRecovery?.statusAuthority?.status;
  if (executionAuthority !== undefined || statusAuthority !== undefined) {
    requireEqual(
      campaign.currentKid,
      executionAuthority?.keyId,
      "operator planned execution HMAC key ID",
    );
    requireEqual(
      campaign.currentCredentialIdSha256,
      executionAuthority?.credentialIdSha256,
      "operator planned execution HMAC credential digest",
    );
    requireEqual(
      campaign.statusCurrentKid,
      statusAuthority?.keyId,
      "operator planned status HMAC key ID",
    );
    requireEqual(
      campaign.statusCurrentCredentialIdSha256,
      statusAuthority?.credentialIdSha256,
      "operator planned status HMAC credential digest",
    );
  }
  return config;
}

function selectApprovalKey(vars, slot) {
  if (slot !== "current" && slot !== "previous") {
    throw new Error("operator approval key slot must be current or previous");
  }
  const prefix = slot === "current" ? "CURRENT" : "PREVIOUS";
  const keyId = vars[`JSON_COMPATIBILITY_OPERATOR_APPROVAL_${prefix}_KID`];
  const spkiSha256 =
    vars[`JSON_COMPATIBILITY_OPERATOR_APPROVAL_${prefix}_SPKI_SHA256`];
  if (typeof keyId !== "string" || keyId === "" || typeof spkiSha256 !== "string" || spkiSha256 === "") {
    throw new Error(`operator approval ${slot} key is not configured`);
  }
  return { keyId, spkiSha256 };
}

function requireDate(value) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("operator approval signing time is invalid");
  }
  return value;
}

function canonicalBase64urlBytes(value, maximumBytes, label, exactBytes) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`${label} must be canonical base64url`);
  }
  const bytes = Buffer.from(value, "base64url");
  if (
    bytes.length === 0
    || bytes.length > maximumBytes
    || (exactBytes !== undefined && bytes.length !== exactBytes)
    || bytes.toString("base64url") !== value
  ) {
    throw new Error(`${label} must be canonical bounded base64url`);
  }
  return bytes;
}

function record(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson([...expected].sort())) {
    throw new Error(`${label} fields do not match`);
  }
}

function canonicalEqual(actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${label} does not match`);
  }
}

function requireEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} does not match`);
}
