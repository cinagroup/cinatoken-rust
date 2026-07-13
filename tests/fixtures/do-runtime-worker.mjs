export {
  RealtimeSession,
  TaskRunner,
  WfpAuthorityReplay,
} from "../../crates/worker/build/index.js";

export default {
  fetch() {
    return new Response("DO runtime fixture", { status: 404 });
  },
};
