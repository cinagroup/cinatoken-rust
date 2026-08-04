import { WorkerEntrypoint } from "cloudflare:workers";

import {
  invokeJsonCompatibilityOperatorPhase,
  type JsonCompatibilityOperatorEnv,
  type JsonCompatibilityOperatorInvocationReceiptV1,
} from "./operator";

export class JsonCompatibilityCampaignOperatorEntrypoint
  extends WorkerEntrypoint<JsonCompatibilityOperatorEnv> {
  async invokePhase(
    input: unknown,
  ): Promise<JsonCompatibilityOperatorInvocationReceiptV1> {
    return await invokeJsonCompatibilityOperatorPhase(this.env, input);
  }
}

export default JsonCompatibilityCampaignOperatorEntrypoint;
