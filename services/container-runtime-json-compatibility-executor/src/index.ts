import { WorkerEntrypoint } from "cloudflare:workers";
import {
  executeJsonCompatibilityPhase,
  type JsonCompatibilityExecutorEnv,
  type JsonCompatibilityPhaseProbeReceiptV1,
} from "./executor";

export default class JsonCompatibilityCampaignExecutorEntrypoint extends WorkerEntrypoint<JsonCompatibilityExecutorEnv> {
  async executePhase(input: unknown): Promise<JsonCompatibilityPhaseProbeReceiptV1> {
    return await executeJsonCompatibilityPhase(this.env, input);
  }
}
