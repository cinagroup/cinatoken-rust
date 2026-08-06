import { WorkerEntrypoint } from "cloudflare:workers";

import {
  publishSourceBundle,
  type JsonCompatibilitySourcePublisherEnv,
} from "./publisher";

export class JsonCompatibilitySourcePublisherEntrypoint
  extends WorkerEntrypoint<JsonCompatibilitySourcePublisherEnv> {
  async publishSourceBundle(input: unknown) {
    return await publishSourceBundle(this.env, input);
  }
}

export default class JsonCompatibilitySourcePublisherDefaultEntrypoint
  extends WorkerEntrypoint<JsonCompatibilitySourcePublisherEnv> {}
