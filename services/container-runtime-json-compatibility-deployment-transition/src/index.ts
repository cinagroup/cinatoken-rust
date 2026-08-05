import { WorkerEntrypoint } from "cloudflare:workers";

import {
  executeDeploymentTransition,
  getDeploymentTransitionStatus,
  type DeploymentTransitionEnv,
  type DeploymentTransitionStatusV1,
} from "./coordinator";
import type {
  JsonCompatibilityDeploymentTransitionReceiptV1,
} from "../../../tools/container_runtime_json_compatibility_deployment_transition.mjs";

export class JsonCompatibilityDeploymentTransitionEntrypoint
  extends WorkerEntrypoint<DeploymentTransitionEnv> {
  async executeTransition(
    input: unknown,
  ): Promise<JsonCompatibilityDeploymentTransitionReceiptV1> {
    return await executeDeploymentTransition(this.env, input);
  }

  async getTransitionStatus(
    input: unknown,
  ): Promise<DeploymentTransitionStatusV1> {
    return await getDeploymentTransitionStatus(this.env, input);
  }
}

export default class JsonCompatibilityDeploymentTransitionDefaultEntrypoint
  extends WorkerEntrypoint<DeploymentTransitionEnv> {}
