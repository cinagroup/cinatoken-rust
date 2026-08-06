import type {
  JsonCompatibilityAccountBindingCredentialProvenanceV1,
  JsonCompatibilityAccountBindingCredentialReceiptEnvelopeV1,
  JsonCompatibilityAccountBindingCredentialRevocationEnvelopeV1,
  JsonCompatibilityAccountBindingCredentialTrustPolicyV1,
} from "../container_runtime_json_compatibility_account_binding_credentials.mjs";

export function verifyJsonCompatibilityAccountBindingCredentialProvenance(
  input: unknown,
  options: {
    readonly now: number;
    readonly expectedTrustPolicySha256: string;
    readonly expectedRevocationStateSha256: string;
    readonly minimumRevocationSequence: number;
  },
): JsonCompatibilityAccountBindingCredentialProvenanceV1;

export function verifyJsonCompatibilityAccountBindingCredentialEnvelope(
  input:
    | {
        readonly trustPolicy: JsonCompatibilityAccountBindingCredentialTrustPolicyV1;
        readonly envelope: JsonCompatibilityAccountBindingCredentialReceiptEnvelopeV1;
        readonly kind: "receipt";
        readonly now: number;
        readonly expectedTrustPolicySha256: string;
      }
    | {
        readonly trustPolicy: JsonCompatibilityAccountBindingCredentialTrustPolicyV1;
        readonly envelope: JsonCompatibilityAccountBindingCredentialRevocationEnvelopeV1;
        readonly kind: "revocation";
        readonly now: number;
        readonly expectedTrustPolicySha256: string;
      },
):
  | JsonCompatibilityAccountBindingCredentialReceiptEnvelopeV1
  | JsonCompatibilityAccountBindingCredentialRevocationEnvelopeV1;
