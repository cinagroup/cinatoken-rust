export const JSON_COMPATIBILITY_ACCOUNT_BINDING_RAW_CAPTURE_TERMINAL_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-account-binding-raw-capture-terminal-v1";

export type JsonCompatibilityAccountBindingRawCaptureResourceFamily =
  | "credential-verification"
  | "workers-scripts"
  | "worker-deployments"
  | "worker-version"
  | "worker-subdomain"
  | "account-worker-domains"
  | "account-zones"
  | "zone-worker-routes";

export interface JsonCompatibilityAccountBindingRawObjectDescriptorV1 {
  readonly sequence: number;
  readonly resourceFamily:
    JsonCompatibilityAccountBindingRawCaptureResourceFamily;
  readonly objectKind: "body" | "receipt";
  readonly fileName: string;
  readonly byteLength: number;
  readonly contentSha256: string;
  readonly pageReceiptSha256: string;
  readonly requestPathSha256: string;
  readonly responseBodySha256: string;
}

export interface JsonCompatibilityAccountBindingRawCaptureTerminalV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-account-binding-raw-capture-terminal-v1";
  readonly kind:
    "container-runtime-json-compatibility-account-binding-raw-capture-terminal";
  readonly environment: "staging";
  readonly mode: "collection" | "independent-readback";
  readonly accountIdSha256: string;
  readonly collectionProfileSha256: string;
  readonly collectorIdentitySha256: string;
  readonly captureManifestSha256: string;
  readonly collectionArtifactSha256: string;
  readonly collectionArtifactFileSha256: string;
  readonly pageCount: number;
  readonly pageChainHeadSha256: string;
  readonly rawObjectCount: number;
  readonly rawObjectTotalBytes: number;
  readonly rawObjectSetSha256: string;
  readonly rawObjects:
    readonly JsonCompatibilityAccountBindingRawObjectDescriptorV1[];
  readonly captureTerminalSha256: string;
}

export class JsonCompatibilityAccountBindingRawCaptureError extends Error {
  constructor(code: string, message?: string);
  readonly code: string;
}

export function validateJsonCompatibilityAccountBindingRawCaptureTerminal(
  input: unknown,
): JsonCompatibilityAccountBindingRawCaptureTerminalV1;
