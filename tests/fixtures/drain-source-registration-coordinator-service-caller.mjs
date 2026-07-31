export default {
  async fetch(request, env) {
    return await env.DRAIN_SOURCE_REGISTRATION_COORDINATOR.fetch(request);
  },
};
