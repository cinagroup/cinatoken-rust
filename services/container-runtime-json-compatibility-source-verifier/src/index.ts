import { WorkerEntrypoint } from "cloudflare:workers";

import {
  authenticateTransitionSource,
  readBackSourcePublication,
  type JsonCompatibilitySourceVerifierEnv,
} from "./verifier";

export class JsonCompatibilitySourceVerifierEntrypoint
  extends WorkerEntrypoint<JsonCompatibilitySourceVerifierEnv> {
  async authenticateTransitionSource(input: unknown) {
    return await authenticateTransitionSource(this.env, input);
  }

  async readBackSourcePublication(input: unknown) {
    return await readBackSourcePublication(this.env, input);
  }
}

export default class JsonCompatibilitySourceVerifierDefaultEntrypoint
  extends WorkerEntrypoint<JsonCompatibilitySourceVerifierEnv> {}
