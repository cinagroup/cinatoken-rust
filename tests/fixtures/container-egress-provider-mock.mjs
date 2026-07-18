export default {
  async fetch(request) {
    const input = await request.json();
    const scenario = input.mock_case;
    const response =
      scenario === "typed_200"
        ? { status: 200, body: JSON.stringify({ error: { type: "invalid_request_error", message: "typed rejection" } }) }
        : scenario === "http_202"
          ? { status: 202, body: JSON.stringify({ id: "provider-mock-queued" }) }
          : scenario === "invalid_body"
            ? { status: 200, body: new Uint8Array([0xff, 0x00]) }
            : {
                status: 200,
                body: JSON.stringify({
                  id: "provider-mock-response",
                  choices: [],
                  usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
                }),
              };
    return new Response(response.body, {
      status: response.status,
      headers: {
        "content-type": "application/json",
        "x-request-id": "provider-mock-call",
      },
    });
  },
};
