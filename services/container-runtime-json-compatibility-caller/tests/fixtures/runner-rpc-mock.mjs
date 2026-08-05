import { WorkerEntrypoint } from "cloudflare:workers";

let invocationReceipt;
let statusReceipt;
let invocationCalls = 0;
let statusCalls = 0;

export class JsonCompatibilityCampaignRunnerEntrypoint
  extends WorkerEntrypoint {
  async invokePhase() {
    invocationCalls += 1;
    if (invocationReceipt === undefined) {
      throw new Error("runner mock invocation receipt is not configured");
    }
    return structuredClone(invocationReceipt);
  }

  async getPhaseStatus() {
    statusCalls += 1;
    if (statusReceipt === undefined) {
      throw new Error("runner mock status receipt is not configured");
    }
    return structuredClone(statusReceipt);
  }
}

export class JsonCompatibilityRunnerMockControlEntrypoint
  extends WorkerEntrypoint {
  async reset() {
    invocationReceipt = undefined;
    statusReceipt = undefined;
    invocationCalls = 0;
    statusCalls = 0;
  }

  async setInvocationReceipt(value) {
    invocationReceipt = structuredClone(value);
  }

  async setStatusReceipt(value) {
    statusReceipt = structuredClone(value);
  }

  async getCallCounts() {
    return { invocationCalls, statusCalls };
  }
}

export default class JsonCompatibilityRunnerMockDefaultEntrypoint
  extends WorkerEntrypoint {}
