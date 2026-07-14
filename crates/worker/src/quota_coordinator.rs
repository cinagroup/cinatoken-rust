//! Internal, observation-only Durable Object adapter for the pure quota coordinator.

use cinatoken_coordinator::{
    apply, summary, ApplyOutcome, QuotaCoordinatorError, QuotaCoordinatorState,
    QuotaCoordinatorSummary, QuotaObservation, DEFAULT_MAX_ACTIVE_RESERVATIONS,
    DEFAULT_MAX_TERMINAL_RESERVATIONS, MAX_PERSISTED_STATE_JSON_BYTES,
    QUOTA_COORDINATOR_CONTRACT_VERSION, QUOTA_COORDINATOR_MODE,
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use wasm_bindgen::JsValue;
use worker::{
    durable_object, Context, D1Database, Env, Error, Headers, Method, Request, RequestInit,
    Response, Result as WorkerResult, State,
};

pub const QUOTA_COORD_BINDING: &str = "QUOTA_COORD";
pub const QUOTA_COORD_SHADOW_ENABLED_ENV: &str = "QUOTA_COORD_SHADOW_ENABLED";
pub const QUOTA_COORD_SHADOW_TOKEN_IDS_ENV: &str = "QUOTA_COORD_SHADOW_TOKEN_IDS";
pub const QUOTA_COORD_RETENTION_VERIFIED_ENV: &str = "QUOTA_COORD_RETENTION_VERIFIED";
pub const QUOTA_COORD_STAGING_VERIFIED_ENV: &str = "QUOTA_COORD_STAGING_VERIFIED";

const OBSERVE_PATH: &str = "/observe";
const STATUS_PATH: &str = "/status";
const TOKEN_ID_HEADER: &str = "x-cinatoken-quota-token-id";
const STATE_KEY: &str = "quota_coordinator_state_v1";
const MAX_JSON_BODY_BYTES: usize = 16 * 1024;
const MAX_SHADOW_TOKEN_IDS: usize = 64;
const APPLY_VALIDATION_MARKER: &str = "cinatoken_quota_observation_validation:";
const STATE_SIZE_MARKER: &str = "cinatoken_quota_state_size:";
const RESERVATION_FINGERPRINT_DOMAIN: &str = "cinatoken-quota-reservation-v1";
const OPERATION_ID_DOMAIN: &str = "cinatoken-quota-operation-v1";
const TOKEN_SCOPE_FINGERPRINT_DOMAIN: &str = "cinatoken-quota-token-scope-v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct QuotaCoordinatorShadowScopeStatus {
    pub configured: bool,
    pub valid: bool,
    pub token_count: usize,
}

#[derive(Debug, Default, PartialEq, Eq)]
struct QuotaCoordinatorShadowScope {
    token_ids: BTreeSet<i64>,
    valid: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct QuotaCoordinatorStatus {
    #[serde(flatten)]
    summary: QuotaCoordinatorSummary,
    persisted_state_json_bytes: usize,
    persisted_state_json_limit_bytes: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct QuotaAccountingProjection {
    reserve_count: i64,
    settle_count: i64,
    refund_count: i64,
    active_reservations: i64,
    terminal_reservations: i64,
    outstanding_quota: i64,
    reserved_quota: i64,
    final_quota: i64,
    refunded_quota: i64,
    user_net_delta: i64,
    token_net_delta: i64,
    channel_used_quota: i64,
    request_count: i64,
}

#[derive(Debug, Serialize)]
struct QuotaAccountingDifference {
    reserve_count: i64,
    settle_count: i64,
    refund_count: i64,
    active_reservations: i64,
    terminal_reservations: i64,
    outstanding_quota: i64,
    reserved_quota: i64,
    final_quota: i64,
    refunded_quota: i64,
    user_net_delta: i64,
    token_net_delta: i64,
    channel_used_quota: i64,
    request_count: i64,
}

#[derive(Debug, Serialize)]
struct QuotaCoordinatorDiagnostics {
    contract_version: u32,
    observation_count: u64,
    applied_count: u64,
    replay_count: u64,
    conflict_count: u64,
    retained_terminal_reservations: u64,
    compacted_terminal_reservations: u64,
    legacy_terminal_reservations: u64,
    retention_watermark_committed_at: u64,
    persisted_state_json_bytes: usize,
    persisted_state_json_limit_bytes: usize,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum QuotaReconciliationStatus {
    Matched,
    Mismatch,
    ObserverStateMissing,
    SourceChanged,
}

#[derive(Debug, Serialize)]
struct QuotaReconciliationReport {
    contract_version: u32,
    status: QuotaReconciliationStatus,
    token_scope_hash: String,
    source_stable: bool,
    observer_healthy: bool,
    d1: crate::d1_repositories::RelayBillingQuotaProjection,
    observer: Option<QuotaAccountingProjection>,
    difference: Option<QuotaAccountingDifference>,
    observer_diagnostics: Option<QuotaCoordinatorDiagnostics>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct QuotaReconciliationRequest {
    token_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Route {
    Observe,
    Status,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BodyReadError {
    InvalidContentLength,
    MissingBody,
    TooLarge,
    ReadFailed,
}

#[durable_object]
pub struct QuotaCoordinator {
    state: State,
    env: Env,
}

#[durable_object]
impl DurableObject for QuotaCoordinator {
    fn new(state: State, env: Env) -> Self {
        Self { state, env }
    }

    async fn fetch(&mut self, mut req: Request) -> WorkerResult<Response> {
        let route = match route_for(&req) {
            Ok(route) => route,
            Err(response) => return Ok(response),
        };

        let token_id = match quota_token_id(&req) {
            Some(token_id) => token_id,
            None => return Response::error("valid quota token identity required", 422),
        };
        let expected_id = self
            .env
            .durable_object(QUOTA_COORD_BINDING)?
            .id_from_name(&format!("token:{token_id}"))?
            .to_string();
        if expected_id != self.state.id().to_string() {
            return Response::error("non-canonical quota coordinator object", 409);
        }

        match route {
            Route::Observe => self.observe(&mut req).await,
            Route::Status => self.status().await,
        }
    }
}

impl QuotaCoordinator {
    async fn observe(&mut self, req: &mut Request) -> WorkerResult<Response> {
        if !has_json_content_type(req) {
            return Response::error("content-type must be application/json", 415);
        }

        let body = match read_bounded_body(req).await {
            Ok(body) => body,
            Err(BodyReadError::InvalidContentLength) => {
                return Response::error("invalid content-length", 422)
            }
            Err(BodyReadError::MissingBody) => {
                return Response::error("invalid quota observation", 422)
            }
            Err(BodyReadError::TooLarge) => {
                return Response::error("quota observation body too large", 413)
            }
            Err(BodyReadError::ReadFailed) => {
                return Err(Error::RustError(
                    "failed to read quota observation body".to_string(),
                ))
            }
        };
        if serde_json::from_slice::<QuotaObservation>(&body).is_err() {
            return Response::error("invalid quota observation", 422);
        }

        // worker-rs 0.5 requires transaction closures to be Copy. Keep the
        // already-bounded payload in a fixed array so retries can parse the
        // observation without leaking request memory or capturing external I/O.
        let mut transaction_body = [0_u8; MAX_JSON_BODY_BYTES];
        transaction_body[..body.len()].copy_from_slice(&body);
        let transaction_body_len = body.len();
        let mut storage = self.state.storage();
        let applied = storage
            .transaction(move |mut transaction| async move {
                let values = transaction.get_multiple(vec![STATE_KEY]).await?;
                let state_key = JsValue::from_str(STATE_KEY);
                let mut coordinator_state = if values.has(&state_key) {
                    serde_wasm_bindgen::from_value::<QuotaCoordinatorState>(values.get(&state_key))
                        .map_err(|error| {
                            Error::RustError(format!(
                                "failed to decode QuotaCoordinator storage: {error}"
                            ))
                        })?
                } else {
                    QuotaCoordinatorState::default()
                };
                let observation = serde_json::from_slice::<QuotaObservation>(
                    &transaction_body[..transaction_body_len],
                )
                .map_err(|error| {
                    Error::RustError(format!(
                        "failed to decode validated quota observation: {error}"
                    ))
                })?;

                if let Err(error) = apply(&mut coordinator_state, observation) {
                    return match error {
                        error @ QuotaCoordinatorError::InvalidObservation(_) => Err(
                            Error::RustError(format!("{APPLY_VALIDATION_MARKER}{error}")),
                        ),
                        error => Err(Error::RustError(format!(
                            "failed to apply quota observation: {error}"
                        ))),
                    };
                }

                let persisted_bytes = serde_json::to_vec(&coordinator_state).map_err(|error| {
                    Error::RustError(format!("failed to size QuotaCoordinator storage: {error}"))
                })?;
                if persisted_bytes.len() > MAX_PERSISTED_STATE_JSON_BYTES {
                    return Err(Error::RustError(format!(
                        "{STATE_SIZE_MARKER}{} exceeds {MAX_PERSISTED_STATE_JSON_BYTES}",
                        persisted_bytes.len()
                    )));
                }

                transaction.put(STATE_KEY, coordinator_state).await
            })
            .await;

        match applied {
            Ok(()) => {}
            Err(error) if error.to_string().contains(APPLY_VALIDATION_MARKER) => {
                return Response::error("invalid quota observation", 422);
            }
            Err(error) => return Err(error),
        }
        drop(storage);

        // `Storage::transaction` in worker-rs 0.5 returns only `()`. Probe a
        // clone of the committed state with the same observation to distinguish
        // a persisted conflict from applied/replayed success without another
        // write or any external I/O. A successful application is now an exact
        // replay; conflicts remain conflicts.
        let mut persisted = self
            .state
            .storage()
            .get::<QuotaCoordinatorState>(STATE_KEY)
            .await?;
        let observation = serde_json::from_slice::<QuotaObservation>(&body).map_err(|error| {
            Error::RustError(format!(
                "failed to decode validated quota observation: {error}"
            ))
        })?;
        let classification = apply(&mut persisted, observation).map_err(|error| {
            Error::RustError(format!("failed to classify quota observation: {error}"))
        })?;
        match classification {
            ApplyOutcome::Conflict { .. } => {
                Response::error("quota observation conflicts with coordinator state", 409)
            }
            ApplyOutcome::Applied { .. } | ApplyOutcome::Replay { .. } => {
                Ok(Response::empty()?.with_status(204))
            }
        }
    }

    async fn status(&self) -> WorkerResult<Response> {
        let values = self.state.storage().get_multiple(vec![STATE_KEY]).await?;
        let state_key = JsValue::from_str(STATE_KEY);
        if !values.has(&state_key) {
            return Response::error("quota coordinator state missing", 409);
        }
        let coordinator_state =
            serde_wasm_bindgen::from_value::<QuotaCoordinatorState>(values.get(&state_key))
                .map_err(|error| {
                    Error::RustError(format!(
                        "failed to decode QuotaCoordinator storage: {error}"
                    ))
                })?;
        let persisted_state_json_bytes = serde_json::to_vec(&coordinator_state)
            .map_err(|error| {
                Error::RustError(format!("failed to size QuotaCoordinator storage: {error}"))
            })?
            .len();
        Response::from_json(&QuotaCoordinatorStatus {
            summary: summary(&coordinator_state).clone(),
            persisted_state_json_bytes,
            persisted_state_json_limit_bytes: MAX_PERSISTED_STATE_JSON_BYTES,
        })
    }
}

pub(crate) fn quota_coordinator_contract_version() -> u32 {
    QUOTA_COORDINATOR_CONTRACT_VERSION
}

pub(crate) fn quota_coordinator_foundation_compiled() -> bool {
    QUOTA_COORDINATOR_CONTRACT_VERSION == 1
        && QUOTA_COORDINATOR_MODE == "tiered_expression_shadow_only"
}

pub(crate) fn quota_coordinator_observer_contract_compiled() -> bool {
    MAX_JSON_BODY_BYTES == 16 * 1024
        && STATE_KEY == "quota_coordinator_state_v1"
        && quota_coordinator_retention_compaction_compiled()
}

pub(crate) fn quota_coordinator_retention_compaction_compiled() -> bool {
    DEFAULT_MAX_ACTIVE_RESERVATIONS == 512
        && DEFAULT_MAX_TERMINAL_RESERVATIONS == 1_536
        && MAX_PERSISTED_STATE_JSON_BYTES == 1_500_000
}

pub(crate) fn quota_coordinator_reserve_observation_compiled() -> bool {
    RESERVATION_FINGERPRINT_DOMAIN == "cinatoken-quota-reservation-v1"
}

pub(crate) fn quota_coordinator_finalization_observation_compiled() -> bool {
    OPERATION_ID_DOMAIN == "cinatoken-quota-operation-v1"
}

pub(crate) fn quota_coordinator_recovery_observation_compiled() -> bool {
    MAX_SHADOW_TOKEN_IDS == 64
}

pub(crate) fn quota_coordinator_relay_observation_compiled() -> bool {
    quota_coordinator_reserve_observation_compiled()
        && quota_coordinator_finalization_observation_compiled()
        && quota_coordinator_recovery_observation_compiled()
}

pub(crate) fn quota_coordinator_reconciliation_compiled() -> bool {
    TOKEN_SCOPE_FINGERPRINT_DOMAIN == "cinatoken-quota-token-scope-v1"
        && quota_coordinator_relay_observation_compiled()
}

/// Compare a stable D1 tiered-ledger snapshot with the observation-only DO.
/// The probe is admin-only, read-only, allowlist-scoped, and unavailable until
/// the same shadow and retention gates used by observation delivery are open.
pub(crate) async fn quota_coordinator_reconciliation(
    mut req: Request,
    env: Env,
) -> WorkerResult<Response> {
    if let Err(response) = crate::admin::require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let body = match crate::admin::read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let request = match serde_json::from_value::<QuotaReconciliationRequest>(body) {
        Ok(request) => request,
        Err(_) => {
            return Ok(crate::admin::envelope_error_response(
                422,
                "A valid quota reconciliation request is required",
            ))
        }
    };
    let Some(token_id) = canonical_positive_i64(&request.token_id) else {
        return Ok(crate::admin::envelope_error_response(
            422,
            "A valid quota token identity is required",
        ));
    };
    if !quota_coordinator_reconciliation_allowed(&env, token_id) {
        return Ok(crate::admin::envelope_error_response(
            409,
            "Quota coordinator reconciliation is not enabled for this token",
        ));
    }

    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(error) => {
            worker::console_error!("QuotaCoordinator reconciliation D1 unavailable: {error}");
            return Ok(crate::admin::envelope_error_response(
                503,
                "Quota coordinator reconciliation is unavailable",
            ));
        }
    };
    let before = match crate::d1_repositories::relay_billing_quota_projection(&db, token_id).await {
        Ok(snapshot) => snapshot,
        Err(error) => {
            worker::console_error!("QuotaCoordinator reconciliation query failed: {error}");
            return Ok(crate::admin::envelope_error_response(
                503,
                "Quota coordinator reconciliation is unavailable",
            ));
        }
    };
    let observer = match fetch_quota_coordinator_status(&env, token_id).await {
        Ok(status) => status,
        Err(error) => {
            worker::console_error!("QuotaCoordinator reconciliation status failed: {error}");
            return Ok(crate::admin::envelope_error_response(
                503,
                "Quota coordinator reconciliation is unavailable",
            ));
        }
    };
    let after = match crate::d1_repositories::relay_billing_quota_projection(&db, token_id).await {
        Ok(snapshot) => snapshot,
        Err(error) => {
            worker::console_error!("QuotaCoordinator reconciliation recheck failed: {error}");
            return Ok(crate::admin::envelope_error_response(
                503,
                "Quota coordinator reconciliation is unavailable",
            ));
        }
    };

    let token_scope_hash =
        quota_identity_hash(TOKEN_SCOPE_FINGERPRINT_DOMAIN, &[&token_id.to_string()]);
    let report = if before != after {
        QuotaReconciliationReport {
            contract_version: QUOTA_COORDINATOR_CONTRACT_VERSION,
            status: QuotaReconciliationStatus::SourceChanged,
            token_scope_hash,
            source_stable: false,
            observer_healthy: false,
            d1: after,
            observer: observer.as_ref().and_then(observer_projection),
            difference: None,
            observer_diagnostics: observer.as_ref().map(observer_diagnostics),
        }
    } else if let Some(observer) = observer {
        let d1_projection = match d1_projection(&after) {
            Some(projection) => projection,
            None => {
                return Ok(crate::admin::envelope_error_response(
                    503,
                    "Quota coordinator reconciliation is unavailable",
                ))
            }
        };
        let Some(observer_projection) = observer_projection(&observer) else {
            return Ok(crate::admin::envelope_error_response(
                503,
                "Quota coordinator reconciliation is unavailable",
            ));
        };
        let Some(difference) = projection_difference(&d1_projection, &observer_projection) else {
            return Ok(crate::admin::envelope_error_response(
                503,
                "Quota coordinator reconciliation is unavailable",
            ));
        };
        let observer_healthy = observer.summary.contract_version
            == QUOTA_COORDINATOR_CONTRACT_VERSION
            && observer.summary.conflict_count == 0
            && observer.summary.legacy_terminal_reservations == 0
            && observer.persisted_state_json_bytes <= observer.persisted_state_json_limit_bytes;
        let status = if difference.is_zero() && observer_healthy {
            QuotaReconciliationStatus::Matched
        } else {
            QuotaReconciliationStatus::Mismatch
        };
        QuotaReconciliationReport {
            contract_version: QUOTA_COORDINATOR_CONTRACT_VERSION,
            status,
            token_scope_hash,
            source_stable: true,
            observer_healthy,
            d1: after,
            observer: Some(observer_projection),
            difference: Some(difference),
            observer_diagnostics: Some(observer_diagnostics(&observer)),
        }
    } else {
        QuotaReconciliationReport {
            contract_version: QUOTA_COORDINATOR_CONTRACT_VERSION,
            status: QuotaReconciliationStatus::ObserverStateMissing,
            token_scope_hash,
            source_stable: true,
            observer_healthy: false,
            d1: after,
            observer: None,
            difference: None,
            observer_diagnostics: None,
        }
    };

    let mut response = crate::admin::envelope_ok_response(&report)?;
    response.headers_mut().set("Cache-Control", "no-store")?;
    Ok(response)
}

pub(crate) fn quota_coordinator_shadow_scope_status(
    env: &Env,
) -> QuotaCoordinatorShadowScopeStatus {
    let scope = quota_coordinator_shadow_scope(env);
    QuotaCoordinatorShadowScopeStatus {
        configured: !scope.token_ids.is_empty(),
        valid: scope.valid,
        token_count: scope.token_ids.len(),
    }
}

fn quota_coordinator_reconciliation_allowed(env: &Env, token_id: i64) -> bool {
    if !quota_coordinator_observation_runtime_enabled(env) {
        return false;
    }
    let scope = quota_coordinator_shadow_scope(env);
    scope.valid && scope.token_ids.contains(&token_id)
}

/// Project one committed tiered reservation into the observation-only DO.
/// Every error is logged and swallowed: D1 has already committed and remains
/// the sole financial writer. Terminal projection always replays reserve first
/// so delayed Queue and recovery delivery can reconstruct a missing observer.
pub(crate) async fn observe_committed_relay_billing_reservation(
    env: &Env,
    db: &D1Database,
    reservation_key: &str,
) {
    if !quota_coordinator_observation_runtime_enabled(env) {
        return;
    }
    let scope = quota_coordinator_shadow_scope(env);
    if !scope.valid {
        worker::console_error!(
            "QuotaCoordinator observation skipped: {} is invalid",
            QUOTA_COORD_SHADOW_TOKEN_IDS_ENV
        );
        return;
    }
    if scope.token_ids.is_empty() {
        return;
    }

    let record = match crate::d1_repositories::relay_billing_reservation(db, reservation_key).await
    {
        Ok(Some(record)) => record,
        Ok(None) => {
            worker::console_error!(
                "QuotaCoordinator observation skipped: committed reservation is missing"
            );
            return;
        }
        Err(error) => {
            worker::console_error!(
                "QuotaCoordinator observation readback failed after D1 commit: {error}"
            );
            return;
        }
    };
    if !scope.token_ids.contains(&record.token_id) {
        return;
    }

    let observations = match relay_observations_for_reservation(&record) {
        Ok(observations) => observations,
        Err(error) => {
            worker::console_error!(
                "QuotaCoordinator observation projection failed after D1 commit: {error}"
            );
            return;
        }
    };
    for observation in observations {
        if let Err(error) = send_observation(env, record.token_id, &observation).await {
            worker::console_error!(
                "QuotaCoordinator observation delivery failed after D1 commit: {error}"
            );
            return;
        }
    }
}

/// Keep observation off the fetch response path when an execution context is
/// available. Queue, scheduled, and offline callers pass no fetch context and
/// await delivery directly within their own already-asynchronous lifecycle.
pub(crate) async fn observe_or_defer_committed_relay_billing_reservation(
    context: Option<&Context>,
    env: &Env,
    db: &D1Database,
    reservation_key: &str,
) {
    if !quota_coordinator_observation_runtime_enabled(env) {
        return;
    }
    if let Some(context) = context {
        let env = env.clone();
        let reservation_key = reservation_key.to_string();
        context.wait_until(async move {
            let db = match env.d1("DB") {
                Ok(db) => db,
                Err(error) => {
                    worker::console_error!(
                        "QuotaCoordinator deferred observation cannot open D1: {error}"
                    );
                    return;
                }
            };
            observe_committed_relay_billing_reservation(&env, &db, &reservation_key).await;
        });
        return;
    }
    observe_committed_relay_billing_reservation(env, db, reservation_key).await;
}

fn quota_coordinator_observation_runtime_enabled(env: &Env) -> bool {
    quota_coordinator_observation_gates_open(
        quota_coordinator_env_flag(env, QUOTA_COORD_SHADOW_ENABLED_ENV),
        quota_coordinator_env_flag(env, QUOTA_COORD_RETENTION_VERIFIED_ENV),
    )
}

fn quota_coordinator_observation_gates_open(
    shadow_enabled: bool,
    retention_verified: bool,
) -> bool {
    shadow_enabled && retention_verified
}

fn quota_coordinator_env_flag(env: &Env, name: &str) -> bool {
    env.var(name)
        .ok()
        .map(|value| value.to_string())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("true"))
}

fn quota_coordinator_shadow_scope(env: &Env) -> QuotaCoordinatorShadowScope {
    let Some(raw) = env
        .var(QUOTA_COORD_SHADOW_TOKEN_IDS_ENV)
        .ok()
        .map(|value| value.to_string())
    else {
        return QuotaCoordinatorShadowScope {
            valid: true,
            ..QuotaCoordinatorShadowScope::default()
        };
    };
    parse_quota_coordinator_shadow_scope(&raw)
}

fn parse_quota_coordinator_shadow_scope(raw: &str) -> QuotaCoordinatorShadowScope {
    let raw = raw.trim();
    if raw.is_empty() {
        return QuotaCoordinatorShadowScope {
            valid: true,
            ..QuotaCoordinatorShadowScope::default()
        };
    }
    let mut token_ids = BTreeSet::new();
    for part in raw.split(',') {
        let part = part.trim();
        let Some(token_id) = canonical_positive_i64(part) else {
            return QuotaCoordinatorShadowScope {
                token_ids,
                valid: false,
            };
        };
        if !token_ids.insert(token_id) || token_ids.len() > MAX_SHADOW_TOKEN_IDS {
            return QuotaCoordinatorShadowScope {
                token_ids,
                valid: false,
            };
        }
    }
    QuotaCoordinatorShadowScope {
        token_ids,
        valid: true,
    }
}

fn relay_observations_for_reservation(
    record: &crate::d1_repositories::RelayBillingReservation,
) -> Result<Vec<QuotaObservation>, String> {
    if record.token_id <= 0 {
        return Ok(Vec::new());
    }
    let fingerprint =
        quota_identity_hash(RESERVATION_FINGERPRINT_DOMAIN, &[&record.reservation_key]);
    let reserve_committed_at = u64::try_from(record.created_at)
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| "reservation created_at is outside the retention domain".to_string())?;
    let reserve = QuotaObservation::reserve(
        quota_identity_hash(OPERATION_ID_DOMAIN, &["reserve", &record.reservation_key]),
        fingerprint.clone(),
        record.pre_consumed_quota,
        reserve_committed_at,
    )
    .map_err(|error| error.to_string())?;
    let mut observations = vec![reserve];
    let request_count = u64::try_from(record.request_accounted)
        .ok()
        .filter(|value| *value <= 1)
        .ok_or_else(|| "reservation request accounting is outside the v1 domain".to_string())?;
    let generation = u64::try_from(record.owner_generation)
        .map_err(|_| "reservation owner generation is outside the v1 domain".to_string())?;
    let terminal_committed_at = u64::try_from(record.updated_at)
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| "reservation updated_at is outside the retention domain".to_string())?;
    let terminal = match record.status.as_str() {
        "reserved" | "recovery_required" => None,
        "settled" => Some(
            QuotaObservation::settle(
                quota_identity_hash(
                    OPERATION_ID_DOMAIN,
                    &[
                        "settle",
                        &record.reservation_key,
                        &record.owner_generation.to_string(),
                    ],
                ),
                fingerprint,
                generation,
                record.pre_consumed_quota,
                record.final_quota,
                request_count,
                terminal_committed_at,
            )
            .map_err(|error| error.to_string())?,
        ),
        "refunded" => Some(
            QuotaObservation::refund(
                quota_identity_hash(
                    OPERATION_ID_DOMAIN,
                    &[
                        "refund",
                        &record.reservation_key,
                        &record.owner_generation.to_string(),
                    ],
                ),
                fingerprint,
                generation,
                record.pre_consumed_quota,
                request_count,
                terminal_committed_at,
            )
            .map_err(|error| error.to_string())?,
        ),
        _ => return Err("reservation status is outside the observer contract".to_string()),
    };
    if let Some(terminal) = terminal {
        observations.push(terminal);
    }
    Ok(observations)
}

async fn fetch_quota_coordinator_status(
    env: &Env,
    token_id: i64,
) -> WorkerResult<Option<QuotaCoordinatorStatus>> {
    let namespace = env.durable_object(QUOTA_COORD_BINDING)?;
    let stub = namespace
        .id_from_name(&format!("token:{token_id}"))?
        .get_stub()?;
    let mut headers = Headers::new();
    headers.set(TOKEN_ID_HEADER, &token_id.to_string())?;
    let mut init = RequestInit::new();
    init.with_method(Method::Get).with_headers(headers);
    let request = Request::new_with_init("https://quota-coordinator.internal/status", &init)?;
    let mut response = stub.fetch_with_request(request).await?;
    match response.status_code() {
        200 => response.json::<QuotaCoordinatorStatus>().await.map(Some),
        409 => Ok(None),
        status => Err(Error::RustError(format!(
            "QuotaCoordinator returned status {status}"
        ))),
    }
}

fn d1_projection(
    value: &crate::d1_repositories::RelayBillingQuotaProjection,
) -> Option<QuotaAccountingProjection> {
    if [
        value.reserve_count,
        value.settle_count,
        value.refund_count,
        value.active_reservations,
        value.terminal_reservations,
        value.request_count,
    ]
    .into_iter()
    .any(|value| value < 0)
    {
        return None;
    }
    Some(QuotaAccountingProjection {
        reserve_count: value.reserve_count,
        settle_count: value.settle_count,
        refund_count: value.refund_count,
        active_reservations: value.active_reservations,
        terminal_reservations: value.terminal_reservations,
        outstanding_quota: value.outstanding_quota,
        reserved_quota: value.reserved_quota,
        final_quota: value.final_quota,
        refunded_quota: value.refunded_quota,
        user_net_delta: value.user_net_delta,
        token_net_delta: value.token_net_delta,
        channel_used_quota: value.channel_used_quota,
        request_count: value.request_count,
    })
}

fn observer_projection(value: &QuotaCoordinatorStatus) -> Option<QuotaAccountingProjection> {
    Some(QuotaAccountingProjection {
        reserve_count: i64::try_from(value.summary.reserve_count).ok()?,
        settle_count: i64::try_from(value.summary.settle_count).ok()?,
        refund_count: i64::try_from(value.summary.refund_count).ok()?,
        active_reservations: i64::try_from(value.summary.active_reservations).ok()?,
        terminal_reservations: i64::try_from(value.summary.terminal_reservations).ok()?,
        outstanding_quota: value.summary.outstanding_quota,
        reserved_quota: value.summary.reserved_quota,
        final_quota: value.summary.final_quota,
        refunded_quota: value.summary.refunded_quota,
        user_net_delta: value.summary.user_net_delta,
        token_net_delta: value.summary.token_net_delta,
        channel_used_quota: value.summary.channel_used_quota,
        request_count: i64::try_from(value.summary.request_count).ok()?,
    })
}

fn projection_difference(
    d1: &QuotaAccountingProjection,
    observer: &QuotaAccountingProjection,
) -> Option<QuotaAccountingDifference> {
    Some(QuotaAccountingDifference {
        reserve_count: d1.reserve_count.checked_sub(observer.reserve_count)?,
        settle_count: d1.settle_count.checked_sub(observer.settle_count)?,
        refund_count: d1.refund_count.checked_sub(observer.refund_count)?,
        active_reservations: d1
            .active_reservations
            .checked_sub(observer.active_reservations)?,
        terminal_reservations: d1
            .terminal_reservations
            .checked_sub(observer.terminal_reservations)?,
        outstanding_quota: d1
            .outstanding_quota
            .checked_sub(observer.outstanding_quota)?,
        reserved_quota: d1.reserved_quota.checked_sub(observer.reserved_quota)?,
        final_quota: d1.final_quota.checked_sub(observer.final_quota)?,
        refunded_quota: d1.refunded_quota.checked_sub(observer.refunded_quota)?,
        user_net_delta: d1.user_net_delta.checked_sub(observer.user_net_delta)?,
        token_net_delta: d1.token_net_delta.checked_sub(observer.token_net_delta)?,
        channel_used_quota: d1
            .channel_used_quota
            .checked_sub(observer.channel_used_quota)?,
        request_count: d1.request_count.checked_sub(observer.request_count)?,
    })
}

impl QuotaAccountingDifference {
    fn is_zero(&self) -> bool {
        self.reserve_count == 0
            && self.settle_count == 0
            && self.refund_count == 0
            && self.active_reservations == 0
            && self.terminal_reservations == 0
            && self.outstanding_quota == 0
            && self.reserved_quota == 0
            && self.final_quota == 0
            && self.refunded_quota == 0
            && self.user_net_delta == 0
            && self.token_net_delta == 0
            && self.channel_used_quota == 0
            && self.request_count == 0
    }
}

fn observer_diagnostics(value: &QuotaCoordinatorStatus) -> QuotaCoordinatorDiagnostics {
    QuotaCoordinatorDiagnostics {
        contract_version: value.summary.contract_version,
        observation_count: value.summary.observation_count,
        applied_count: value.summary.applied_count,
        replay_count: value.summary.replay_count,
        conflict_count: value.summary.conflict_count,
        retained_terminal_reservations: value.summary.retained_terminal_reservations,
        compacted_terminal_reservations: value.summary.compacted_terminal_reservations,
        legacy_terminal_reservations: value.summary.legacy_terminal_reservations,
        retention_watermark_committed_at: value.summary.retention_watermark_committed_at,
        persisted_state_json_bytes: value.persisted_state_json_bytes,
        persisted_state_json_limit_bytes: value.persisted_state_json_limit_bytes,
    }
}

async fn send_observation(
    env: &Env,
    token_id: i64,
    observation: &QuotaObservation,
) -> WorkerResult<()> {
    let payload = serde_json::to_string(observation).map_err(|error| {
        Error::RustError(format!("failed to encode quota observation: {error}"))
    })?;
    if payload.len() > MAX_JSON_BODY_BYTES {
        return Err(Error::RustError(
            "encoded quota observation exceeds the bounded contract".to_string(),
        ));
    }
    let namespace = env.durable_object(QUOTA_COORD_BINDING)?;
    let stub = namespace
        .id_from_name(&format!("token:{token_id}"))?
        .get_stub()?;
    let mut headers = Headers::new();
    headers.set("Content-Type", "application/json")?;
    headers.set(TOKEN_ID_HEADER, &token_id.to_string())?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(JsValue::from_str(&payload)));
    let request = Request::new_with_init("https://quota-coordinator.internal/observe", &init)?;
    let response = stub.fetch_with_request(request).await?;
    if response.status_code() == 204 {
        Ok(())
    } else {
        Err(Error::RustError(format!(
            "QuotaCoordinator returned status {}",
            response.status_code()
        )))
    }
}

fn quota_identity_hash(domain: &str, parts: &[&str]) -> String {
    let mut digest = Sha256::new();
    digest.update(domain.as_bytes());
    for part in parts {
        digest.update([0]);
        digest.update(part.as_bytes());
    }
    format!("{:x}", digest.finalize())
}

fn canonical_positive_i64(raw: &str) -> Option<i64> {
    if raw.is_empty() || raw.starts_with('0') || !raw.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let value = raw.parse::<i64>().ok()?;
    (value > 0 && value.to_string() == raw).then_some(value)
}

fn route_for(req: &Request) -> Result<Route, Response> {
    match (req.path().as_str(), req.method()) {
        (OBSERVE_PATH, Method::Post) => Ok(Route::Observe),
        (STATUS_PATH, Method::Get) => Ok(Route::Status),
        (OBSERVE_PATH, _) => Err(method_not_allowed("POST")),
        (STATUS_PATH, _) => Err(method_not_allowed("GET")),
        _ => Err(Response::error("not found", 404).expect("static response is valid")),
    }
}

fn method_not_allowed(allow: &str) -> Response {
    let mut response =
        Response::error("method not allowed", 405).expect("static response is valid");
    response
        .headers_mut()
        .set("Allow", allow)
        .expect("static header is valid");
    response
}

fn quota_token_id(req: &Request) -> Option<i64> {
    let raw = req.headers().get(TOKEN_ID_HEADER).ok().flatten()?;
    canonical_positive_i64(&raw)
}

fn has_json_content_type(req: &Request) -> bool {
    let Some(value) = req.headers().get("Content-Type").ok().flatten() else {
        return false;
    };
    let mut parts = value.split(';').map(str::trim);
    if !parts
        .next()
        .is_some_and(|media_type| media_type.eq_ignore_ascii_case("application/json"))
    {
        return false;
    }
    match (parts.next(), parts.next()) {
        (None, None) => true,
        (Some(parameter), None) => parameter.eq_ignore_ascii_case("charset=utf-8"),
        _ => false,
    }
}

async fn read_bounded_body(req: &mut Request) -> Result<Vec<u8>, BodyReadError> {
    if let Some(raw) = req.headers().get("Content-Length").ok().flatten() {
        let content_length = raw
            .parse::<usize>()
            .map_err(|_| BodyReadError::InvalidContentLength)?;
        if content_length > MAX_JSON_BODY_BYTES {
            return Err(BodyReadError::TooLarge);
        }
    }

    let mut stream = req.stream().map_err(|error| {
        if error.to_string().contains("no body for request") {
            BodyReadError::MissingBody
        } else {
            BodyReadError::ReadFailed
        }
    })?;
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| BodyReadError::ReadFailed)?;
        if body.len().saturating_add(chunk.len()) > MAX_JSON_BODY_BYTES {
            return Err(BodyReadError::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use cinatoken_coordinator::QuotaObservationKind;

    use super::{
        d1_projection, parse_quota_coordinator_shadow_scope, projection_difference,
        quota_coordinator_observation_gates_open, quota_identity_hash,
        relay_observations_for_reservation, OPERATION_ID_DOMAIN,
    };

    #[test]
    fn observation_requires_shadow_and_retention_gates() {
        assert!(!quota_coordinator_observation_gates_open(false, false));
        assert!(!quota_coordinator_observation_gates_open(true, false));
        assert!(!quota_coordinator_observation_gates_open(false, true));
        assert!(quota_coordinator_observation_gates_open(true, true));
    }

    #[test]
    fn token_identity_is_strictly_canonical() {
        for valid in ["1", "42", "9223372036854775807"] {
            assert_eq!(valid.parse::<i64>().unwrap().to_string(), valid);
        }
        for invalid in [
            "",
            "0",
            "01",
            "+1",
            "-1",
            " 1",
            "1 ",
            "1.0",
            "9223372036854775808",
        ] {
            assert!(invalid
                .parse::<i64>()
                .map_or(true, |value| value <= 0 || value.to_string() != invalid));
        }
    }

    #[test]
    fn shadow_scope_is_bounded_canonical_and_duplicate_free() {
        let scope = parse_quota_coordinator_shadow_scope("7, 11,42");
        assert!(scope.valid);
        assert_eq!(scope.token_ids.into_iter().collect::<Vec<_>>(), [7, 11, 42]);
        for invalid in ["0", "01", "7,7", "-1", "+1", "1,,2", "1, x"] {
            assert!(!parse_quota_coordinator_shadow_scope(invalid).valid);
        }
        let oversized = (1..=65)
            .map(|value| value.to_string())
            .collect::<Vec<_>>()
            .join(",");
        assert!(!parse_quota_coordinator_shadow_scope(&oversized).valid);
    }

    #[test]
    fn reconciliation_difference_is_d1_minus_observer() {
        let d1 = crate::d1_repositories::RelayBillingQuotaProjection {
            reserve_count: 2,
            settle_count: 1,
            refund_count: 0,
            active_reservations: 1,
            terminal_reservations: 1,
            outstanding_quota: 50,
            reserved_quota: 150,
            final_quota: 70,
            refunded_quota: 30,
            user_net_delta: -120,
            token_net_delta: -120,
            channel_used_quota: 70,
            request_count: 1,
            max_updated_at: 200,
            owner_generation_sum: 4,
        };
        let authoritative = d1_projection(&d1).unwrap();
        let mut observer = authoritative.clone();
        observer.reserve_count = 1;
        observer.reserved_quota = 100;
        let difference = projection_difference(&authoritative, &observer).unwrap();
        assert_eq!(difference.reserve_count, 1);
        assert_eq!(difference.reserved_quota, 50);
        assert!(!difference.is_zero());
        assert!(projection_difference(&authoritative, &authoritative)
            .unwrap()
            .is_zero());
    }

    #[test]
    fn committed_terminal_projection_replays_reserve_first() {
        let settled = reservation("settled", 3, 75, 1);
        let observations = relay_observations_for_reservation(&settled).unwrap();
        assert_eq!(observations.len(), 2);
        assert_eq!(observations[0].kind, QuotaObservationKind::Reserve);
        assert_eq!(observations[0].generation, 1);
        assert_eq!(observations[0].reserved_quota, 120);
        assert_eq!(observations[1].kind, QuotaObservationKind::Settle);
        assert_eq!(observations[1].generation, 3);
        assert_eq!(observations[1].final_quota, 75);
        assert_eq!(observations[1].request_count, 1);
        assert_eq!(
            observations[0].reservation_fingerprint,
            observations[1].reservation_fingerprint
        );
        assert_eq!(
            observations[1].operation_id,
            quota_identity_hash(OPERATION_ID_DOMAIN, &["settle", "reservation-a", "3"])
        );
        assert_eq!(
            observations,
            relay_observations_for_reservation(&settled).unwrap()
        );
    }

    #[test]
    fn projection_distinguishes_active_refund_and_ineligible_token() {
        let active =
            relay_observations_for_reservation(&reservation("recovery_required", 3, 0, 0)).unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].kind, QuotaObservationKind::Reserve);

        let refunded =
            relay_observations_for_reservation(&reservation("refunded", 2, 0, 0)).unwrap();
        assert_eq!(refunded.len(), 2);
        assert_eq!(refunded[1].kind, QuotaObservationKind::Refund);
        assert_eq!(refunded[1].generation, 2);

        let mut tokenless = reservation("settled", 3, 75, 1);
        tokenless.token_id = 0;
        assert!(relay_observations_for_reservation(&tokenless)
            .unwrap()
            .is_empty());
    }

    fn reservation(
        status: &str,
        owner_generation: i64,
        final_quota: i64,
        request_accounted: i64,
    ) -> crate::d1_repositories::RelayBillingReservation {
        crate::d1_repositories::RelayBillingReservation {
            reservation_key: "reservation-a".to_string(),
            user_id: 9,
            token_id: 7,
            model_name: "model-a".to_string(),
            endpoint_path: "chat/completions".to_string(),
            request_id_hash: String::new(),
            expr_hash: "expr-a".to_string(),
            candidate_group_count: 1,
            reservation_strategy: "selected_group".to_string(),
            pre_consumed_quota: 120,
            status: status.to_string(),
            channel_id: 5,
            selected_group: "default".to_string(),
            selected_at: 100,
            final_quota,
            finalization_reason: "test".to_string(),
            request_accounted,
            lease_expires_at: 200,
            owner_generation,
            owner_deadline_at: 200,
            owner_lease_renewed_at: 0,
            recovery_attempt_count: 0,
            created_at: 100,
            updated_at: 101,
        }
    }
}
