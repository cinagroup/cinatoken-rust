import { WorkerEntrypoint } from "cloudflare:workers";

import {
  readDeploymentState,
  readDeploymentStateForResolution,
  type JsonCompatibilityDeploymentReadbackEnv,
} from "./reader";

export class JsonCompatibilityDeploymentReadbackEntrypoint
  extends WorkerEntrypoint<JsonCompatibilityDeploymentReadbackEnv> {
  async readDeploymentState(input: unknown) {
    return await readDeploymentState(this.env, input);
  }

  async readDeploymentStateForResolution(input: unknown) {
    return await readDeploymentStateForResolution(this.env, input);
  }
}

export default class JsonCompatibilityDeploymentReadbackDefaultEntrypoint
  extends WorkerEntrypoint<JsonCompatibilityDeploymentReadbackEnv> {}
