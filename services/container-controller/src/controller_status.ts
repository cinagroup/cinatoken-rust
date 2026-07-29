const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

export interface ControllerStatusV1Payload {
  controller_enabled: boolean;
  execution_enabled: boolean;
  protocol_version: number;
  ring_generation: number;
  shard_count: number;
  ring_transition_configured: boolean;
  ring_transition_valid: boolean;
  previous_ring_generation: number | null;
  previous_shard_count: number | null;
  previous_ring_admission_started_at: number | null;
  previous_ring_admission_until: number | null;
  previous_ring_admission_open: boolean;
  controller_version_id: string;
  durable_object_jurisdiction: string;
  durable_object_jurisdiction_restricted: boolean;
  durable_object_jurisdiction_enabled: boolean;
  durable_object_jurisdiction_staging_verified: boolean;
  shard_activation_write_enabled: boolean;
  shard_activation_candidate_build_configured: boolean;
  shard_placement_attestation_write_enabled: boolean;
  shard_placement_attestation_staging_verified: boolean;
  controller_service_name: string;
  all_action_gates_false: boolean;
  action_gate_inventory_sha256: string;
  authority_current_secret_configured: boolean;
  authority_previous_secret_configured: boolean;
}

export function controllerStatusV1Response(
  payload: ControllerStatusV1Payload,
): Response {
  const body: ControllerStatusV1Payload = {
    controller_enabled: payload.controller_enabled,
    execution_enabled: payload.execution_enabled,
    protocol_version: payload.protocol_version,
    ring_generation: payload.ring_generation,
    shard_count: payload.shard_count,
    ring_transition_configured: payload.ring_transition_configured,
    ring_transition_valid: payload.ring_transition_valid,
    previous_ring_generation: payload.previous_ring_generation,
    previous_shard_count: payload.previous_shard_count,
    previous_ring_admission_started_at:
      payload.previous_ring_admission_started_at,
    previous_ring_admission_until: payload.previous_ring_admission_until,
    previous_ring_admission_open: payload.previous_ring_admission_open,
    controller_version_id: payload.controller_version_id,
    durable_object_jurisdiction: payload.durable_object_jurisdiction,
    durable_object_jurisdiction_restricted:
      payload.durable_object_jurisdiction_restricted,
    durable_object_jurisdiction_enabled:
      payload.durable_object_jurisdiction_enabled,
    durable_object_jurisdiction_staging_verified:
      payload.durable_object_jurisdiction_staging_verified,
    shard_activation_write_enabled: payload.shard_activation_write_enabled,
    shard_activation_candidate_build_configured:
      payload.shard_activation_candidate_build_configured,
    shard_placement_attestation_write_enabled:
      payload.shard_placement_attestation_write_enabled,
    shard_placement_attestation_staging_verified:
      payload.shard_placement_attestation_staging_verified,
    controller_service_name: payload.controller_service_name,
    all_action_gates_false: payload.all_action_gates_false,
    action_gate_inventory_sha256: payload.action_gate_inventory_sha256,
    authority_current_secret_configured:
      payload.authority_current_secret_configured,
    authority_previous_secret_configured:
      payload.authority_previous_secret_configured,
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: JSON_HEADERS,
  });
}
