import { WorkerEntrypoint } from "cloudflare:workers";

import {
  getJsonCompatibilityCallerPhaseStatus,
  invokeJsonCompatibilityCallerPhase,
  type JsonCompatibilityCallerEnv,
  type JsonCompatibilityCallerInvocationReceiptV1,
  type JsonCompatibilityCallerStatusReceiptV1,
} from "./caller";

export class JsonCompatibilityCampaignCallerEntrypoint
  extends WorkerEntrypoint<JsonCompatibilityCallerEnv> {
  async invokePhase(
    input: unknown,
  ): Promise<JsonCompatibilityCallerInvocationReceiptV1> {
    return await invokeJsonCompatibilityCallerPhase(this.env, input);
  }

  async getPhaseStatus(
    input: unknown,
  ): Promise<JsonCompatibilityCallerStatusReceiptV1> {
    return await getJsonCompatibilityCallerPhaseStatus(this.env, input);
  }
}

export default class JsonCompatibilityCallerDefaultEntrypoint
  extends WorkerEntrypoint<JsonCompatibilityCallerEnv> {}
