import { WorkerEntrypoint } from "cloudflare:workers";

import {
  getDeploymentTransitionResolutionStatus,
  resolveDeploymentTransitionInflight,
  type DeploymentTransitionResolutionEnv,
  type ReceiptV1,
  type StatusV1,
} from "./resolver";

export class JsonCompatibilityDeploymentTransitionResolutionEntrypoint
  extends WorkerEntrypoint<DeploymentTransitionResolutionEnv> {
  async resolveDeploymentTransitionInflight(input: unknown): Promise<ReceiptV1> {
    return await resolveDeploymentTransitionInflight(this.env, input);
  }

  async getDeploymentTransitionResolutionStatus(
    input: unknown,
  ): Promise<StatusV1> {
    return await getDeploymentTransitionResolutionStatus(this.env, input);
  }
}

export default class JsonCompatibilityDeploymentTransitionResolutionDefaultEntrypoint
  extends WorkerEntrypoint<DeploymentTransitionResolutionEnv> {}
