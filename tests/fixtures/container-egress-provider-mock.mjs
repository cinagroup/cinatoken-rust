export default {
  async fetch() {
    return new Response(JSON.stringify({ id: "provider-mock-response", choices: [] }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-request-id": "provider-mock-call",
      },
    });
  },
};
