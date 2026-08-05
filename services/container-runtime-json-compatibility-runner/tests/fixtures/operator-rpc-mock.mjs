import { WorkerEntrypoint } from "cloudflare:workers";

let invocationReceipt;
let statusReceipt;

export class JsonCompatibilityCampaignOperatorEntrypoint
  extends WorkerEntrypoint {
  async invokePhase() {
    if (invocationReceipt === undefined) {
      throw new Error("operator mock invocation receipt is not configured");
    }
    return structuredClone(invocationReceipt);
  }

  async getPhaseStatus() {
    if (statusReceipt === undefined) {
      throw new Error("operator mock status receipt is not configured");
    }
    return structuredClone(statusReceipt);
  }
}

export class JsonCompatibilityOperatorMockControlEntrypoint
  extends WorkerEntrypoint {
  async reset() {
    invocationReceipt = undefined;
    statusReceipt = undefined;
  }

  async setInvocationReceipt(value) {
    invocationReceipt = structuredClone(value);
  }

  async setStatusReceipt(value) {
    statusReceipt = structuredClone(value);
  }
}

export default class JsonCompatibilityOperatorMockDefaultEntrypoint
  extends WorkerEntrypoint {}
