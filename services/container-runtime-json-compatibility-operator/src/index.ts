import { WorkerEntrypoint } from "cloudflare:workers";

import {
  invokeJsonCompatibilityOperatorPhase,
  type JsonCompatibilityOperatorEnv,
  type JsonCompatibilityOperatorInvocationReceiptV2,
} from "./operator";

export class JsonCompatibilityCampaignOperatorEntrypoint
  extends WorkerEntrypoint<JsonCompatibilityOperatorEnv> {
  async invokePhase(
    input: unknown,
  ): Promise<JsonCompatibilityOperatorInvocationReceiptV2> {
    return await invokeJsonCompatibilityOperatorPhase(this.env, input);
  }
}

export default JsonCompatibilityCampaignOperatorEntrypoint;
