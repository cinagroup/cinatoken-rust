const requestKeys = [
  "billing_event_id",
  "operation_from_status",
  "operation_id",
  "operation_status",
  "owner_generation",
  "predecessor_billing_event_id",
  "protocol_version",
  "provider_usage_binding",
  "reconciliation_id",
  "reconciliation_revision",
  "response_code",
  "response_status",
  "result",
  "shard",
  "terminal_contract_sha256",
  "trace_id",
];

const jsonHeaders = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};

const acknowledgedEvents = new Set();

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (
      request.method !== "POST" ||
      url.pathname !== "/internal/v2/operations/terminal-ack"
    ) {
      return json({ error: "route_not_found" }, 404);
    }
    if (!request.headers.get("x-cinatoken-container-authority")) {
      return json({ error: "authority_rejected" }, 403);
    }
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_terminal_ack", retryable: false }, 400);
    }
    if (
      body === null ||
      Array.isArray(body) ||
      typeof body !== "object" ||
      JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(requestKeys)
    ) {
      return json({ error: "invalid_terminal_ack", retryable: false }, 400);
    }
    const serialized = JSON.stringify(body);
    for (const forbidden of [
      "audit_payload",
      "client_response",
      "billing_reason",
      "user_quota_delta",
      "token_quota_delta",
      "authorization",
    ]) {
      if (serialized.includes(forbidden)) {
        return json({ error: "invalid_terminal_ack", retryable: false }, 400);
      }
    }
    if (body.operation_id.includes("retry")) {
      return json({ error: "controller_unavailable", retryable: true }, 503);
    }
    if (body.operation_id.includes("conflict")) {
      return json({ error: "terminal_ack_conflict", retryable: false }, 409);
    }
    const duplicate = acknowledgedEvents.has(body.billing_event_id);
    acknowledgedEvents.add(body.billing_event_id);
    const finalAck = body.operation_status !== "recovery_required";
    return json({
      protocol_version: body.protocol_version,
      billing_event_id: body.billing_event_id,
      operation_id: body.operation_id,
      reconciliation_revision: body.reconciliation_revision,
      status: duplicate ? "duplicate" : "acknowledged",
      final_ack: finalAck,
      acknowledged_at: finalAck ? Math.floor(Date.now() / 1000) : null,
    });
  },
};
