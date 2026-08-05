import { WorkerEntrypoint } from "cloudflare:workers";

let sourceAuthenticationCalls = 0;

export class JsonCompatibilitySourceVerifierProxyEntrypoint
  extends WorkerEntrypoint {
  async authenticateTransitionSource(input) {
    sourceAuthenticationCalls += 1;
    return await this.env.JSON_COMPATIBILITY_SOURCE_VERIFIER_ACTUAL
      .authenticateTransitionSource(input);
  }
}

export class JsonCompatibilitySourceVerifierProxyControlEntrypoint
  extends WorkerEntrypoint {
  async reset() {
    sourceAuthenticationCalls = 0;
  }

  async getCallCount() {
    return sourceAuthenticationCalls;
  }
}

export default class InertEntrypoint extends WorkerEntrypoint {}
