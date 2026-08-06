export interface JsonCompatibilitySourceBundleSignerResultV1 {
  readonly schemaVersion: 1;
  readonly mode: "offline-ed25519-source-bundle-signing";
  readonly keyId: string;
  readonly signerSpkiSha256: string;
  readonly subjectSha256: string;
  readonly envelopeSha256: string;
  readonly verifierPolicySha256: string;
  readonly outputCreated: true;
  readonly privateKeySource: "caller-supplied-bytes";
  readonly privateKeyInputAttested: false;
  readonly privateKeyPersistedBySigner: false;
  readonly credentialSecretRead: false;
  readonly networkRequestsPerformed: false;
  readonly cloudflareMutationPerformed: false;
}

export function runJsonCompatibilitySourceBundleSigner(input: {
  readonly subjectPath: string;
  readonly verifierPolicyPath: string;
  readonly expectedVerifierPolicySha256: string;
  readonly outputPath: string;
  readonly privateKeyBytes: Uint8Array;
}): Promise<JsonCompatibilitySourceBundleSignerResultV1>;

export function parseJsonCompatibilitySourceBundleSignerArgs(
  argv: readonly string[],
):
  | { readonly help: true }
  | { readonly describe: true }
  | {
      readonly json: boolean;
      readonly privateKeyStdin: true;
      readonly subjectPath: string;
      readonly verifierPolicyPath: string;
      readonly expectedVerifierPolicySha256: string;
      readonly outputPath: string;
    };

export function assertJsonCompatibilitySourceSignerCredentialFreeEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): void;
