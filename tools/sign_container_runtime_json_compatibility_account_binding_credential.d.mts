export interface JsonCompatibilityAccountBindingCredentialSignerResultV1 {
  readonly schemaVersion: 1;
  readonly mode: "offline-ed25519-account-binding-credential-signing";
  readonly kind: "receipt" | "revocation";
  readonly keyId: string;
  readonly subjectSha256: string;
  readonly envelopeSha256: string;
  readonly outputCreated: true;
  readonly privateKeySource: "caller-supplied-bytes";
  readonly privateKeyInputAttested: false;
  readonly privateKeyPersistedBySigner: false;
  readonly credentialSecretRead: false;
  readonly networkRequestsPerformed: false;
  readonly cloudflareMutationPerformed: false;
}

export type JsonCompatibilityAccountBindingCredentialSignerParsedArgs =
  | { readonly describe: true }
  | { readonly help: true }
  | {
      readonly json: boolean;
      readonly privateKeyStdin: true;
      readonly subjectPath: string;
      readonly trustPolicyPath: string;
      readonly expectedTrustPolicySha256: string;
      readonly outputPath: string;
    };

export function runJsonCompatibilityAccountBindingCredentialSigner(input: {
  readonly subjectPath: string;
  readonly trustPolicyPath: string;
  readonly expectedTrustPolicySha256: string;
  readonly outputPath: string;
  readonly privateKeyBytes: Uint8Array;
}): Promise<JsonCompatibilityAccountBindingCredentialSignerResultV1>;

export function parseJsonCompatibilityAccountBindingCredentialSignerArgs(
  argv: readonly string[],
): JsonCompatibilityAccountBindingCredentialSignerParsedArgs;
