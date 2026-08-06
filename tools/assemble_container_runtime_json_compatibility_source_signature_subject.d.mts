export interface JsonCompatibilitySourceSignatureSubjectAssemblerResultV1 {
  readonly schemaVersion: 1;
  readonly mode: "credential-free-source-signature-subject-assembly";
  readonly sourceSigningIntentSha256: string;
  readonly sourceSignatureSubjectSha256: string;
  readonly verifierPolicySha256: string;
  readonly verifierIdentitySha256: string;
  readonly outputCreated: true;
  readonly placeholderDigestInputAccepted: false;
  readonly credentialSecretRead: false;
  readonly networkRequestsPerformed: false;
  readonly cloudflareMutationPerformed: false;
}

export function assembleJsonCompatibilitySourceSignatureSubject(input: {
  readonly intentPath: string;
  readonly expectedIntentSha256: string;
  readonly expectedVerifierPolicySha256: string;
  readonly expectedVerifierIdentitySha256: string;
  readonly outputPath: string;
}): Promise<JsonCompatibilitySourceSignatureSubjectAssemblerResultV1>;

export function parseJsonCompatibilitySourceSignatureSubjectAssemblerArgs(
  argv: readonly string[],
):
  | { readonly help: true }
  | { readonly describe: true }
  | {
      readonly json: boolean;
      readonly intentPath: string;
      readonly expectedIntentSha256: string;
      readonly expectedVerifierPolicySha256: string;
      readonly expectedVerifierIdentitySha256: string;
      readonly outputPath: string;
    };
