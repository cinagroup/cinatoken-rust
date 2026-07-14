CREATE TRIGGER relay_billing_contract_immutable_guard
BEFORE UPDATE OF
  user_id,
  token_id,
  model_name,
  endpoint_path,
  request_id_hash,
  expr_hash,
  billing_kind,
  billing_snapshot_json,
  candidate_group_count,
  reservation_strategy,
  pre_consumed_quota
ON relay_billing_reservations
WHEN
  NEW.user_id IS NOT OLD.user_id OR
  NEW.token_id IS NOT OLD.token_id OR
  NEW.model_name IS NOT OLD.model_name OR
  NEW.endpoint_path IS NOT OLD.endpoint_path OR
  NEW.request_id_hash IS NOT OLD.request_id_hash OR
  NEW.expr_hash IS NOT OLD.expr_hash OR
  NEW.billing_kind IS NOT OLD.billing_kind OR
  NEW.billing_snapshot_json IS NOT OLD.billing_snapshot_json OR
  NEW.candidate_group_count IS NOT OLD.candidate_group_count OR
  NEW.reservation_strategy IS NOT OLD.reservation_strategy OR
  NEW.pre_consumed_quota IS NOT OLD.pre_consumed_quota
BEGIN
  SELECT RAISE(ABORT, 'relay billing contract is immutable');
END;
