import { WorkerEntrypoint } from "cloudflare:workers";

import {
  mutateDeploymentOnce,
  type JsonCompatibilityDeploymentMutationEnv,
} from "./mutator";
import type { JsonRecord } from "./protocol";

export class JsonCompatibilityDeploymentMutationEntrypoint
  extends WorkerEntrypoint<JsonCompatibilityDeploymentMutationEnv> {
  async mutateDeploymentOnce(input: unknown): Promise<JsonRecord> {
    return await mutateDeploymentOnce(this.env, input);
  }
}

export default class JsonCompatibilityDeploymentMutationDefaultEntrypoint
  extends WorkerEntrypoint<JsonCompatibilityDeploymentMutationEnv> {}
