import { WorkerEntrypoint } from "cloudflare:workers";

import {
  invokeJsonCompatibilityPhase,
  type JsonCompatibilityInvokerEnv,
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
}

export default JsonCompatibilityCampaignInvokerEntrypoint;
