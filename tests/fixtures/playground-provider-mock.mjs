function json(value, status = 200) {
  return Response.json(value, { status });
}

export default {
  async fetch(request) {
    if (request.method !== "POST") {
      return json({ error: { message: "method not allowed" } }, 405);
    }
    if (request.headers.get("authorization") !== "Bearer runtime-upstream-key") {
      return json({ error: { message: "upstream authorization missing" } }, 401);
    }

    const body = await request.json();
    if (Object.hasOwn(body, "group")) {
      return json({ error: { message: "local group leaked upstream" } }, 400);
    }
    if (body.stream === true) {
      const events = [
        {
          id: "chatcmpl-playground-stream",
          object: "chat.completion.chunk",
          model: body.model,
          choices: [
            { index: 0, delta: { content: "streamed" }, finish_reason: null },
          ],
        },
        {
          id: "chatcmpl-playground-stream",
          object: "chat.completion.chunk",
          model: body.model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        },
      ];
      const payload = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
      return new Response(payload, {
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      });
    }

    return json({
      id: "chatcmpl-playground-json",
      object: "chat.completion",
      model: body.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "completed" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    });
  },
};
