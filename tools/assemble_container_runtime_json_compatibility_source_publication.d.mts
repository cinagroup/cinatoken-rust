export interface JsonCompatibilitySourcePublicationAssemblerResultV1 {
  readonly schemaVersion: 1;
  readonly mode: "credential-free-source-publication-assembly";
  readonly publicationPacketSha256: string;
  readonly bundleKey: string;
  readonly bundleSha256: string;
  readonly bodySha256: string;
  readonly bodyByteLength: number;
  readonly sourceSignatureEnvelopeSha256: string;
  readonly outputCreated: true;
  readonly credentialSecretRead: false;
  readonly networkRequestsPerformed: false;
  readonly cloudflareMutationPerformed: false;
}

export function assembleJsonCompatibilitySourcePublication(input: {
  readonly requestPath: string;
  readonly bundlePath: string;
  readonly expectedVerifierPolicySha256: string;
  readonly expectedVerifierIdentitySha256: string;
  readonly now: number;
  readonly outputPath: string;
}): Promise<JsonCompatibilitySourcePublicationAssemblerResultV1>;

export function parseJsonCompatibilitySourcePublicationAssemblerArgs(
  argv: readonly string[],
):
  | { readonly help: true }
  | { readonly describe: true }
  | {
      readonly json: boolean;
      readonly requestPath: string;
      readonly bundlePath: string;
      readonly expectedVerifierPolicySha256: string;
      readonly expectedVerifierIdentitySha256: string;
      readonly now: number;
      readonly outputPath: string;
    };
