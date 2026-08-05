import { WorkerEntrypoint } from "cloudflare:workers";

let invocationCalls = 0;
let statusCalls = 0;

export class JsonCompatibilityCampaignInvokerEntrypoint
  extends WorkerEntrypoint {
  async invokePhase() {
    invocationCalls += 1;
    return {};
  }

  async getPhaseStatus() {
    statusCalls += 1;
    return {};
  }
}

export class JsonCompatibilityInvokerMockControlEntrypoint
  extends WorkerEntrypoint {
  async reset() {
    invocationCalls = 0;
    statusCalls = 0;
  }

  async invocationCallCount() {
    return invocationCalls;
  }

  async statusCallCount() {
    return statusCalls;
  }
}

export default class JsonCompatibilityInvokerMockDefaultEntrypoint
  extends WorkerEntrypoint {}
