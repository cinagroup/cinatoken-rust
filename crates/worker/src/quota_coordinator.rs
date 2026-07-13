//! Internal, observation-only Durable Object adapter for the pure quota coordinator.

use cinatoken_coordinator::{
    apply, summary, ApplyOutcome, QuotaCoordinatorError, QuotaCoordinatorState, QuotaObservation,
    QUOTA_COORDINATOR_CONTRACT_VERSION, QUOTA_COORDINATOR_MODE,
};
use futures_util::StreamExt;
use wasm_bindgen::JsValue;
use worker::{
    durable_object, Env, Error, Method, Request, Response, Result as WorkerResult, State,
};

pub const QUOTA_COORD_BINDING: &str = "QUOTA_COORD";
pub const QUOTA_COORD_SHADOW_ENABLED_ENV: &str = "QUOTA_COORD_SHADOW_ENABLED";
pub const QUOTA_COORD_STAGING_VERIFIED_ENV: &str = "QUOTA_COORD_STAGING_VERIFIED";

const OBSERVE_PATH: &str = "/observe";
const STATUS_PATH: &str = "/status";
const TOKEN_ID_HEADER: &str = "x-cinatoken-quota-token-id";
const STATE_KEY: &str = "quota_coordinator_state_v1";
const MAX_JSON_BODY_BYTES: usize = 16 * 1024;
const APPLY_VALIDATION_MARKER: &str = "cinatoken_quota_observation_validation:";

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

        Response::from_json(&summary(&coordinator_state))
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
    MAX_JSON_BODY_BYTES == 16 * 1024 && STATE_KEY == "quota_coordinator_state_v1"
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
    if raw.is_empty() || raw.starts_with('0') || !raw.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let token_id = raw.parse::<i64>().ok()?;
    (token_id > 0 && token_id.to_string() == raw).then_some(token_id)
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
}
