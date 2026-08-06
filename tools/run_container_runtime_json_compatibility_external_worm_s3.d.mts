import type {
  JsonCompatibilityExternalWormS3Adapter,
  JsonCompatibilityExternalWormS3PublicationObserved,
  JsonCompatibilityExternalWormS3ReadbackObserved,
  JsonCompatibilityExternalWormS3RoleCredentials,
} from "./lib/container_runtime_json_compatibility_external_worm_s3.mjs";

export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_CLI_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-external-worm-s3-cli-v1";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_REQUEST_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-external-worm-s3-single-object-request-v1";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_CLI_RESULT_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-external-worm-s3-cli-result-v1";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_REQUEST_MAX_BYTES: number;
export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_PUBLICATION_MAX_BYTES: number;

export type JsonCompatibilityExternalWormS3CliMode =
  | "publish"
  | "independent-readback";

export interface JsonCompatibilityExternalWormS3SingleObjectRequest {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-external-worm-s3-single-object-request-v1";
  readonly provider: "amazon-s3";
  readonly region: string;
  readonly bucket: string;
  readonly key: string;
  readonly expectedBucketOwner: string;
  readonly contentLength: number;
  readonly contentSha256: string;
  readonly contentType: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly retainUntil: string;
}

export interface JsonCompatibilityExternalWormS3CliDescription {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-external-worm-s3-cli-v1";
  readonly provider: "amazon-s3";
  readonly modes: readonly JsonCompatibilityExternalWormS3CliMode[];
  readonly requestContract:
    "cinatoken-container-runtime-json-compatibility-external-worm-s3-single-object-request-v1";
  readonly requestFields: readonly string[];
  readonly roleCredentialEnvironment: Readonly<{
    readonly writer: Readonly<Record<string, string>>;
    readonly reader: Readonly<Record<string, string>>;
  }>;
  readonly credentialArgumentsAccepted: false;
  readonly adapterMaxAttempts: 1;
  readonly cliRetries: 0;
  readonly createOnceOutput: true;
  readonly outputObservationContract:
    "cinatoken-container-runtime-json-compatibility-external-worm-s3-provider-observation-v1";
  readonly outputAuthorizesC2Closure: false;
  readonly maximumBodyBytes: number;
}

export interface JsonCompatibilityExternalWormS3CliDryRunPlan {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-external-worm-s3-cli-v1";
  readonly mode: JsonCompatibilityExternalWormS3CliMode;
  readonly credentialAccess: "none";
  readonly fileReads: 0;
  readonly fileWrites: 0;
  readonly networkRequests: 0;
  readonly adapterCreations: 0;
  readonly cliRetries: 0;
  readonly createOnceOutput: true;
  readonly authorizesC2Closure: false;
  readonly requiredLiveInputs: readonly string[];
}

export type JsonCompatibilityExternalWormS3CliParsedArgs =
  | { readonly mode: "help" }
  | { readonly mode: "describe" }
  | {
    readonly mode: "dry-run";
    readonly operation: JsonCompatibilityExternalWormS3CliMode;
  }
  | {
    readonly mode: "publish";
    readonly requestPath: string;
    readonly bodyPath: string;
    readonly outputPath: string;
  }
  | {
    readonly mode: "independent-readback";
    readonly requestPath: string;
    readonly publicationPath: string;
    readonly outputPath: string;
  };

export interface JsonCompatibilityExternalWormS3CliWriter {
  write(value: string): unknown;
}

export type JsonCompatibilityExternalWormS3CliMaybePromise<T> =
  T | PromiseLike<T>;

export interface JsonCompatibilityExternalWormS3CliDependencies {
  readonly argv?: readonly string[];
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly stdout?: JsonCompatibilityExternalWormS3CliWriter;
  readonly adapterFactory?: (input: {
    readonly region: string;
    readonly credentials: JsonCompatibilityExternalWormS3RoleCredentials;
  }) => JsonCompatibilityExternalWormS3CliMaybePromise<
    JsonCompatibilityExternalWormS3Adapter
  >;
  readonly clock?: () => number;
}

export class JsonCompatibilityExternalWormS3CliError extends Error {
  constructor(code: string);
  readonly code: string;
}

export class JsonCompatibilityExternalWormS3CliObservationError
  extends Error {
  constructor(classification: "ambiguous" | "mismatch");
  readonly code:
    | "provider_observation_ambiguous"
    | "provider_observation_mismatch";
  readonly classification: "ambiguous" | "mismatch";
}

export function describeJsonCompatibilityExternalWormS3Cli():
  JsonCompatibilityExternalWormS3CliDescription;

export function buildJsonCompatibilityExternalWormS3DryRunPlan(
  mode: JsonCompatibilityExternalWormS3CliMode,
): JsonCompatibilityExternalWormS3CliDryRunPlan;

export function parseJsonCompatibilityExternalWormS3CliArgs(
  argv: readonly string[],
): JsonCompatibilityExternalWormS3CliParsedArgs;

export function readBoundedJsonCompatibilityExternalWormS3Body(
  filePath: string,
  maximumBytes?: number,
): Promise<Uint8Array>;

export function runJsonCompatibilityExternalWormS3Cli(
  dependencies?: JsonCompatibilityExternalWormS3CliDependencies,
): Promise<
  | JsonCompatibilityExternalWormS3CliDescription
  | JsonCompatibilityExternalWormS3CliDryRunPlan
  | { readonly mode: "help"; readonly usage: string }
  | JsonCompatibilityExternalWormS3PublicationObserved
  | JsonCompatibilityExternalWormS3ReadbackObserved
>;

export function jsonCompatibilityExternalWormS3CliUsage(): string;
