import { WorkerEntrypoint } from "cloudflare:workers";

import {
  issueJsonCompatibilityPhasePermit,
  type JsonCompatibilityPermitIssueReceiptV1,
  type JsonCompatibilityPermitIssuerEnv,
} from "./protocol";

export { JsonCompatibilityPermitIssuanceAuthority } from "./issuance_authority";

export class JsonCompatibilityPermitIssuerEntrypoint
  extends WorkerEntrypoint<JsonCompatibilityPermitIssuerEnv> {
  async issuePhasePermit(
    input: unknown,
  ): Promise<JsonCompatibilityPermitIssueReceiptV1> {
    return await issueJsonCompatibilityPhasePermit(this.env, input);
  }
}

export default JsonCompatibilityPermitIssuerEntrypoint;
