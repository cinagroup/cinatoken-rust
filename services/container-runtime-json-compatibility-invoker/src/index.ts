import { WorkerEntrypoint } from "cloudflare:workers";

import {
  getJsonCompatibilityPhaseStatus,
  invokeJsonCompatibilityPhase,
  type JsonCompatibilityInvokerEnv,
  type JsonCompatibilityPrivateInvocationStatusReceiptV1,
  type JsonCompatibilityPrivateInvocationReceiptV1,
} from "./invoker";

export { JsonCompatibilityInvocationAuthority } from "./invocation_authority";

export class JsonCompatibilityCampaignInvokerEntrypoint
  extends WorkerEntrypoint<JsonCompatibilityInvokerEnv> {
  async invokePhase(
    input: unknown,
  ): Promise<JsonCompatibilityPrivateInvocationReceiptV1> {
    return await invokeJsonCompatibilityPhase(this.env, input);
  }

  async getPhaseStatus(
    input: unknown,
  ): Promise<JsonCompatibilityPrivateInvocationStatusReceiptV1> {
    return await getJsonCompatibilityPhaseStatus(this.env, input);
  }
}

export default class JsonCompatibilityInvokerDefaultEntrypoint
  extends WorkerEntrypoint<JsonCompatibilityInvokerEnv> {}
