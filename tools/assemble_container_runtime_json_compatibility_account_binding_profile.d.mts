export interface JsonCompatibilityAccountBindingProfileAssemblerResultV1 {
  readonly schemaVersion: 1;
  readonly mode: "offline-account-binding-profile-assembly";
  readonly collectionProfileSha256: string;
  readonly credentialProvenanceSha256: string;
  readonly collectionCredentialReceiptSha256: string;
  readonly readbackCredentialReceiptSha256: string;
  readonly credentialRevocationStateSha256: string;
  readonly minimumRevocationSequence: number;
  readonly outputCreated: true;
  readonly credentialSecretRead: false;
  readonly networkRequestsPerformed: false;
  readonly cloudflareMutationPerformed: false;
}

export type JsonCompatibilityAccountBindingProfileAssemblerParsedArgs =
  | { readonly describe: true }
  | { readonly help: true }
  | {
      readonly json: boolean;
      readonly campaignPlanPath: string;
      readonly statePlanPath: string;
      readonly collectorIdentityPath: string;
      readonly trustPolicyPath: string;
      readonly collectionReceiptPath: string;
      readonly readbackReceiptPath: string;
      readonly revocationPath: string;
      readonly allowedEdgesPath: string;
      readonly approvedAt: number;
      readonly expectedTrustPolicySha256: string;
      readonly expectedRevocationStateSha256: string;
      readonly minimumRevocationSequence: number;
      readonly outputPath: string;
    };

export function runJsonCompatibilityAccountBindingProfileAssembler(input: {
  readonly campaignPlanPath: string;
  readonly statePlanPath: string;
  readonly collectorIdentityPath: string;
  readonly trustPolicyPath: string;
  readonly collectionReceiptPath: string;
  readonly readbackReceiptPath: string;
  readonly revocationPath: string;
  readonly allowedEdgesPath: string;
  readonly approvedAt: number;
  readonly expectedTrustPolicySha256: string;
  readonly expectedRevocationStateSha256: string;
  readonly minimumRevocationSequence: number;
  readonly outputPath: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): Promise<JsonCompatibilityAccountBindingProfileAssemblerResultV1>;

export function parseJsonCompatibilityAccountBindingProfileAssemblerArgs(
  argv: readonly string[],
): JsonCompatibilityAccountBindingProfileAssemblerParsedArgs;
