import {
  PasskeyCeremony,
  QuotaCoordinator,
  RealtimeSession,
  TaskRunner,
  WfpAuthorityReplay,
} from "../../crates/worker/build/index.js";
import WorkerEntrypoint from "../../crates/worker/build/index.js";

export {
  PasskeyCeremony,
  QuotaCoordinator,
  RealtimeSession,
  TaskRunner,
  WfpAuthorityReplay,
};
export function scheduled(controller, env, ctx) {
  const worker = new WorkerEntrypoint(ctx, env);
  return worker.scheduled(controller);
}
export function queue(batch, env, ctx) {
  const worker = new WorkerEntrypoint(ctx, env);
  return worker.queue(batch);
}

export default WorkerEntrypoint;
