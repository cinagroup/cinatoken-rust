import { WorkerEntrypoint } from "cloudflare:workers";
import {
  executeJsonCompatibilityPhase,
  type JsonCompatibilityExecutorEnv,
  type JsonCompatibilityPhaseProbeReceiptV2,
} from "./executor";

export { JsonCompatibilityCampaignAuthority } from "./campaign_authority";

export class JsonCompatibilityCampaignExecutorEntrypoint extends WorkerEntrypoint<JsonCompatibilityExecutorEnv> {
  async executePhase(input: unknown): Promise<JsonCompatibilityPhaseProbeReceiptV2> {
    return await executeJsonCompatibilityPhase(this.env, input);
  }
}

export default JsonCompatibilityCampaignExecutorEntrypoint;
