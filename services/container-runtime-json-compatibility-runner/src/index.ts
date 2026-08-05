import { WorkerEntrypoint } from "cloudflare:workers";

import {
  getJsonCompatibilityRunnerPhaseStatus,
  invokeJsonCompatibilityRunnerPhase,
  type JsonCompatibilityRunnerEnv,
  type JsonCompatibilityRunnerInvocationReceiptV1,
  type JsonCompatibilityRunnerStatusReceiptV1,
} from "./runner";

export class JsonCompatibilityCampaignRunnerEntrypoint
  extends WorkerEntrypoint<JsonCompatibilityRunnerEnv> {
  async invokePhase(
    input: unknown,
  ): Promise<JsonCompatibilityRunnerInvocationReceiptV1> {
    return await invokeJsonCompatibilityRunnerPhase(this.env, input);
  }

  async getPhaseStatus(
    input: unknown,
  ): Promise<JsonCompatibilityRunnerStatusReceiptV1> {
    return await getJsonCompatibilityRunnerPhaseStatus(this.env, input);
  }
}

export default class JsonCompatibilityRunnerDefaultEntrypoint
  extends WorkerEntrypoint<JsonCompatibilityRunnerEnv> {}
