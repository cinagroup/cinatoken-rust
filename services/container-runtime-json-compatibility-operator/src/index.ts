import { WorkerEntrypoint } from "cloudflare:workers";

import {
  getJsonCompatibilityOperatorPhaseStatus,
  invokeJsonCompatibilityOperatorPhase,
  type JsonCompatibilityOperatorEnv,
  type JsonCompatibilityOperatorInvocationReceiptV2,
  type JsonCompatibilityOperatorPhaseStatusReceiptV1,
} from "./operator";

export class JsonCompatibilityCampaignOperatorEntrypoint
  extends WorkerEntrypoint<JsonCompatibilityOperatorEnv> {
  async invokePhase(
    input: unknown,
  ): Promise<JsonCompatibilityOperatorInvocationReceiptV2> {
    return await invokeJsonCompatibilityOperatorPhase(this.env, input);
  }

  async getPhaseStatus(
    input: unknown,
  ): Promise<JsonCompatibilityOperatorPhaseStatusReceiptV1> {
    return await getJsonCompatibilityOperatorPhaseStatus(this.env, input);
  }
}

export default class JsonCompatibilityOperatorDefaultEntrypoint
  extends WorkerEntrypoint<JsonCompatibilityOperatorEnv> {}
