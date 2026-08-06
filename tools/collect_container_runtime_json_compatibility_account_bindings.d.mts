import type {
  JsonCompatibilityAccountBindingEvidenceV1,
} from "./container_runtime_json_compatibility_account_binding_evidence.mjs";
import type {
  JsonCompatibilityAccountBindingRawPageSink,
} from "./lib/container_runtime_json_compatibility_account_binding_collector.mjs";
import type {
  JsonCompatibilitySourceAccountBindingInventoryV1,
} from "./container_runtime_json_compatibility_source_authentication.mjs";

export const JSON_COMPATIBILITY_ACCOUNT_BINDING_FINALIZATION_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-account-binding-finalization-v1";

export interface JsonCompatibilityAccountBindingFinalizationV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-account-binding-finalization-v1";
  readonly kind:
    "container-runtime-json-compatibility-account-binding-finalization";
  readonly environment: "staging";
  readonly evidence: JsonCompatibilityAccountBindingEvidenceV1;
  readonly inventory: JsonCompatibilitySourceAccountBindingInventoryV1;
  readonly finalizationSha256: string;
}

export interface JsonCompatibilityAccountBindingCaptureIdentityV1 {
  readonly mode: "collection" | "independent-readback";
  readonly accountIdSha256: string;
  readonly collectionProfileSha256: string;
  readonly collectorIdentitySha256: string;
}

export interface JsonCompatibilityAccountBindingCliPlanV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-account-binding-cli-plan-v1";
  readonly mode: "collection" | "independent-readback" | "finalize";
  readonly credentialAccess: string;
  readonly networkRequests: 0;
  readonly fileWrites: 0;
  readonly createOnceOutput: true;
  readonly requiredInputs: readonly string[];
  readonly forbiddenCredentialEnvironment?: readonly string[];
  readonly httpMethodAllowlist?: readonly ["GET"];
  readonly hiddenRetries?: false;
  readonly rawPageCreateOnce?: true;
}

export type JsonCompatibilityAccountBindingParsedArgs =
  | { readonly mode: "help" | "self-test" }
  | {
      readonly mode: "dry-run";
      readonly operation: "collection" | "independent-readback" | "finalize";
    }
  | {
      readonly mode: "collection" | "independent-readback";
      readonly campaignPlanPath: string;
      readonly statePlanPath: string;
      readonly collectionProfilePath: string;
      readonly collectorIdentityPath: string;
      readonly accountId: string;
      readonly expectedTrustPolicySha256: string;
      readonly expectedRevocationStateSha256: string;
      readonly minimumRevocationSequence: number;
      readonly rawPageDirectory: string;
      readonly outputPath: string;
    }
  | {
      readonly mode: "finalize";
      readonly campaignPlanPath: string;
      readonly statePlanPath: string;
      readonly collectionProfilePath: string;
      readonly collectionArtifactPath: string;
      readonly readbackArtifactPath: string;
      readonly outputPath: string;
    };

export class JsonCompatibilityAccountBindingCliError extends Error {
  constructor(code: string, message?: string);
  readonly code: string;
}

export function buildAccountBindingCollectorDryRunPlan(
  mode: "collection" | "independent-readback" | "finalize",
): JsonCompatibilityAccountBindingCliPlanV1;

export function parseAccountBindingCollectorArgs(
  argv: readonly string[],
): JsonCompatibilityAccountBindingParsedArgs;

export function createJsonCompatibilityAccountBindingRawPageSink(
  directory: string,
  captureIdentity: JsonCompatibilityAccountBindingCaptureIdentityV1,
): Promise<JsonCompatibilityAccountBindingRawPageSink>;

export function runAccountBindingCollectorCli(options?: {
  readonly argv?: readonly string[];
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly stdout?: { write(value: string): unknown };
  readonly fetchImpl?: typeof fetch;
  readonly clock?: () => number;
  readonly monotonicClock?: () => number;
}): Promise<Readonly<Record<string, unknown>>>;
