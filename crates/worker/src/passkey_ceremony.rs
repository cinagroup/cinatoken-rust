//! Strongly consistent storage for short-lived Passkey ceremony state.
//!
//! Each ceremony key maps to its own Durable Object. Create-only writes and
//! digest-guarded replacements support persist-before-dispatch workflows. A
//! deterministic claim remains replayable until expiry while excluding every
//! competing finish request.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt;
use std::time::Duration;
use wasm_bindgen::JsValue;
use worker::{
    durable_object, Env, Error, Headers, Method, Request, RequestInit, Response,
    Result as WorkerResult, State,
};

pub(crate) const PASSKEY_CEREMONIES_BINDING: &str = "PASSKEY_CEREMONIES";

const PUT_PATH: &str = "/put";
const PUT_ONCE_PATH: &str = "/put-once";
const READ_PATH: &str = "/read";
const REPLACE_PATH: &str = "/replace";
const CLAIM_PATH: &str = "/claim";
const TAKE_PATH: &str = "/take";
const CEREMONY_KEY_HEADER: &str = "x-cinatoken-passkey-ceremony-key";
const CEREMONY_TTL_HEADER: &str = "x-cinatoken-passkey-ceremony-ttl";
const CEREMONY_CLAIM_HEADER: &str = "x-cinatoken-passkey-ceremony-claim";
const CEREMONY_EXPECTED_PAYLOAD_SHA256_HEADER: &str =
    "x-cinatoken-passkey-ceremony-expected-payload-sha256";
const RECORD_KEY: &str = "ceremony";
const CREATE_LOCK_KEY: &str = "create-lock";
const CLAIM_PREFIX: &str = "claim:";
const MISSING_ERROR_MARKER: &str = "cinatoken_passkey_ceremony_missing";
const EXPIRED_ERROR_MARKER: &str = "cinatoken_passkey_ceremony_expired";
const ALREADY_EXISTS_ERROR_MARKER: &str = "cinatoken_passkey_ceremony_already_exists";
const STATE_CONFLICT_ERROR_MARKER: &str = "cinatoken_passkey_ceremony_state_conflict";
const CLAIM_CONFLICT_ERROR_MARKER: &str = "cinatoken_passkey_ceremony_claim_conflict";
const MAX_KEY_BYTES: usize = 256;
pub(crate) const MAX_PAYLOAD_BYTES: usize = 16 * 1024;
pub(crate) const MAX_TTL_SECONDS: u64 = 300;
const CLAIM_BYTES: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PasskeyCeremonyError {
    BindingUnavailable,
    AlreadyExists,
    StateConflict,
    ClaimConflict,
    ExpiredOrConsumed,
    InvalidRequest(&'static str),
    Unavailable(String),
}

impl fmt::Display for PasskeyCeremonyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BindingUnavailable => formatter.write_str("Passkey ceremony binding unavailable"),
            Self::AlreadyExists => formatter.write_str("Passkey ceremony already exists"),
            Self::StateConflict => formatter.write_str("Passkey ceremony state conflict"),
            Self::ClaimConflict => formatter.write_str("Passkey ceremony already claimed"),
            Self::ExpiredOrConsumed => {
                formatter.write_str("Passkey ceremony expired or already consumed")
            }
            Self::InvalidRequest(message) => formatter.write_str(message),
            Self::Unavailable(_) => formatter.write_str("Passkey ceremony service unavailable"),
        }
    }
}

impl std::error::Error for PasskeyCeremonyError {}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
struct CeremonyRecord {
    payload: String,
    expires_at_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    claim_id_sha256: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
struct CeremonyCreateLock {
    expires_at_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TakeDecision {
    Available,
    Claimed,
    Expired,
    Missing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ClaimDecision {
    Fresh,
    Replay,
    Conflict,
    Expired,
    Missing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CeremonyRoute {
    Put,
    PutOnce,
    Read,
    Replace,
    Claim,
    Take,
    NotFound,
}

enum BoundedPayloadError {
    TooLarge,
    InvalidEncoding,
}

#[durable_object]
pub struct PasskeyCeremony {
    state: State,
    env: Env,
}

#[durable_object]
impl DurableObject for PasskeyCeremony {
    fn new(state: State, env: Env) -> Self {
        Self { state, env }
    }

    async fn fetch(&mut self, mut req: Request) -> WorkerResult<Response> {
        let route = ceremony_route(req.method() == Method::Post, &req.path());
        if route == CeremonyRoute::NotFound {
            return Response::error("not found", 404);
        }

        let Some(ceremony_key) = header(&req, CEREMONY_KEY_HEADER) else {
            return Response::error("ceremony key required", 400);
        };
        if !valid_ceremony_key(&ceremony_key) {
            return Response::error("invalid ceremony key", 400);
        }
        let expected_id = self
            .env
            .durable_object(PASSKEY_CEREMONIES_BINDING)?
            .id_from_name(&ceremony_key)?
            .to_string();
        if expected_id != self.state.id().to_string() {
            return Response::error("non-canonical ceremony object", 403);
        }

        match route {
            CeremonyRoute::Put => self.put(&mut req, false).await,
            CeremonyRoute::PutOnce => self.put(&mut req, true).await,
            CeremonyRoute::Read => self.read().await,
            CeremonyRoute::Replace => self.replace(&mut req).await,
            CeremonyRoute::Claim => self.claim(&req).await,
            CeremonyRoute::Take => self.take(&req).await,
            CeremonyRoute::NotFound => Response::error("not found", 404),
        }
    }

    async fn alarm(&mut self) -> WorkerResult<Response> {
        self.state.storage().delete_all().await?;
        Response::empty()
    }
}

impl PasskeyCeremony {
    async fn put(&mut self, req: &mut Request, create_only: bool) -> WorkerResult<Response> {
        let Some(ttl_seconds) =
            header(req, CEREMONY_TTL_HEADER).and_then(|value| value.parse::<u64>().ok())
        else {
            return Response::error("ceremony TTL required", 400);
        };
        if !valid_ttl(ttl_seconds) {
            return Response::error("invalid ceremony TTL", 400);
        }
        let payload = match read_bounded_payload(req).await? {
            Ok(payload) => payload,
            Err(BoundedPayloadError::TooLarge) => {
                return Response::error("ceremony payload too large", 413);
            }
            Err(BoundedPayloadError::InvalidEncoding) => {
                return Response::error("invalid ceremony JSON payload", 400);
            }
        };
        if validate_json_payload(&payload).is_err() {
            return Response::error("invalid ceremony JSON payload", 400);
        }

        let now_ms = unix_timestamp_ms();
        let expires_at_ms = now_ms.saturating_add((ttl_seconds as i64).saturating_mul(1_000));
        // Arm cleanup before persisting. If the write fails, the harmless alarm
        // will remove the empty object; if it succeeds, expiry is still checked
        // synchronously by take and never depends on alarm timing.
        self.state
            .storage()
            .set_alarm(Duration::from_secs(ttl_seconds))
            .await?;
        if create_only {
            let payload_length = payload.len();
            let mut transaction_payload = [0_u8; MAX_PAYLOAD_BYTES];
            transaction_payload[..payload_length].copy_from_slice(payload.as_bytes());
            let mut storage = self.state.storage();
            let lock = storage
                .transaction(move |mut transaction| async move {
                    let values = transaction
                        .get_multiple(vec![RECORD_KEY, CREATE_LOCK_KEY])
                        .await?;
                    if values.has(&JsValue::from_str(RECORD_KEY))
                        || values.has(&JsValue::from_str(CREATE_LOCK_KEY))
                    {
                        return Err(Error::RustError(ALREADY_EXISTS_ERROR_MARKER.to_string()));
                    }
                    transaction
                        .put(CREATE_LOCK_KEY, CeremonyCreateLock { expires_at_ms })
                        .await?;
                    let payload = String::from_utf8(transaction_payload[..payload_length].to_vec())
                        .map_err(|_| {
                            Error::RustError(
                                "invalid Passkey ceremony payload encoding".to_string(),
                            )
                        })?;
                    transaction
                        .put(
                            RECORD_KEY,
                            CeremonyRecord {
                                payload,
                                expires_at_ms,
                                claim_id_sha256: None,
                            },
                        )
                        .await?;
                    Ok(())
                })
                .await;
            match lock {
                Ok(()) => return Ok(Response::empty()?.with_status(204)),
                Err(err) if err.to_string().contains(ALREADY_EXISTS_ERROR_MARKER) => {
                    return Response::error("ceremony already exists", 409);
                }
                Err(err) => return Err(err),
            }
        } else {
            let values = self
                .state
                .storage()
                .get_multiple(vec![CREATE_LOCK_KEY])
                .await?;
            if values.has(&JsValue::from_str(CREATE_LOCK_KEY)) {
                return Response::error("ceremony already exists", 409);
            }
        }
        self.state
            .storage()
            .put(
                RECORD_KEY,
                CeremonyRecord {
                    payload,
                    expires_at_ms,
                    claim_id_sha256: None,
                },
            )
            .await?;
        Ok(Response::empty()?.with_status(204))
    }

    async fn read(&self) -> WorkerResult<Response> {
        let storage = self.state.storage();
        let values = storage.get_multiple(vec![RECORD_KEY]).await?;
        let record_key = JsValue::from_str(RECORD_KEY);
        if !values.has(&record_key) {
            return Response::error("ceremony expired or already consumed", 410);
        }
        let record = serde_wasm_bindgen::from_value::<CeremonyRecord>(values.get(&record_key))
            .map_err(|err| {
                Error::RustError(format!("invalid Passkey ceremony storage record: {err}"))
            })?;
        if record.expires_at_ms <= unix_timestamp_ms() {
            return Response::error("ceremony expired or already consumed", 410);
        }
        json_payload_response(record.payload)
    }

    async fn replace(&mut self, req: &mut Request) -> WorkerResult<Response> {
        let Some(expected_payload_sha256) = header(req, CEREMONY_EXPECTED_PAYLOAD_SHA256_HEADER)
            .and_then(|value| parse_sha256(&value))
        else {
            return Response::error("expected payload digest required", 400);
        };
        let payload = match read_bounded_payload(req).await? {
            Ok(payload) => payload,
            Err(BoundedPayloadError::TooLarge) => {
                return Response::error("ceremony payload too large", 413);
            }
            Err(BoundedPayloadError::InvalidEncoding) => {
                return Response::error("invalid ceremony JSON payload", 400);
            }
        };
        if validate_json_payload(&payload).is_err() {
            return Response::error("invalid ceremony JSON payload", 400);
        }
        let payload_length = payload.len();
        let mut transaction_payload = [0_u8; MAX_PAYLOAD_BYTES];
        transaction_payload[..payload_length].copy_from_slice(payload.as_bytes());
        let now_ms = unix_timestamp_ms();
        let mut storage = self.state.storage();
        let replaced = storage
            .transaction(move |mut transaction| async move {
                let values = transaction.get_multiple(vec![RECORD_KEY]).await?;
                let record_key = JsValue::from_str(RECORD_KEY);
                if !values.has(&record_key) {
                    return Err(Error::RustError(MISSING_ERROR_MARKER.to_string()));
                }
                let mut record =
                    serde_wasm_bindgen::from_value::<CeremonyRecord>(values.get(&record_key))
                        .map_err(|err| {
                            Error::RustError(format!(
                                "invalid Passkey ceremony storage record: {err}"
                            ))
                        })?;
                if record.expires_at_ms <= now_ms {
                    return Err(Error::RustError(EXPIRED_ERROR_MARKER.to_string()));
                }
                if record.claim_id_sha256.is_some() {
                    return Err(Error::RustError(CLAIM_CONFLICT_ERROR_MARKER.to_string()));
                }
                let next_payload = String::from_utf8(
                    transaction_payload[..payload_length].to_vec(),
                )
                .map_err(|_| {
                    Error::RustError("invalid Passkey ceremony payload encoding".to_string())
                })?;
                if record.payload == next_payload {
                    return Ok(());
                }
                let current_payload_sha256: [u8; 32] =
                    Sha256::digest(record.payload.as_bytes()).into();
                if current_payload_sha256 != expected_payload_sha256 {
                    return Err(Error::RustError(STATE_CONFLICT_ERROR_MARKER.to_string()));
                }
                record.payload = next_payload;
                transaction.put(RECORD_KEY, record).await?;
                Ok(())
            })
            .await;
        match replaced {
            Ok(()) => Ok(Response::empty()?.with_status(204)),
            Err(err) if err.to_string().contains(STATE_CONFLICT_ERROR_MARKER) => {
                Response::error("ceremony state conflict", 409)
            }
            Err(err)
                if err.to_string().contains(MISSING_ERROR_MARKER)
                    || err.to_string().contains(EXPIRED_ERROR_MARKER) =>
            {
                Response::error("ceremony expired or already consumed", 410)
            }
            Err(err) => Err(err),
        }
    }

    async fn take(&mut self, req: &Request) -> WorkerResult<Response> {
        let Some(claim) = header(req, CEREMONY_CLAIM_HEADER).and_then(|value| parse_claim(&value))
        else {
            return Response::error("valid ceremony claim required", 400);
        };
        let now_ms = unix_timestamp_ms();
        let mut storage = self.state.storage();

        let claimed = storage
            .transaction(move |mut transaction| async move {
                let values = transaction.get_multiple(vec![RECORD_KEY]).await?;
                let record_key = JsValue::from_str(RECORD_KEY);
                if !values.has(&record_key) {
                    return Err(Error::RustError(MISSING_ERROR_MARKER.to_string()));
                }
                let record =
                    serde_wasm_bindgen::from_value::<CeremonyRecord>(values.get(&record_key))
                        .map_err(|err| {
                            Error::RustError(format!(
                                "invalid Passkey ceremony storage record: {err}"
                            ))
                        })?;
                if take_decision(Some(&record), now_ms) == TakeDecision::Expired {
                    return Err(Error::RustError(EXPIRED_ERROR_MARKER.to_string()));
                }
                if take_decision(Some(&record), now_ms) == TakeDecision::Claimed {
                    return Err(Error::RustError(MISSING_ERROR_MARKER.to_string()));
                }

                transaction.put(&claim_storage_key(&claim), record).await?;
                transaction.delete(RECORD_KEY).await?;
                Ok(())
            })
            .await;

        match claimed {
            Ok(()) => {}
            Err(err)
                if err.to_string().contains(MISSING_ERROR_MARKER)
                    || err.to_string().contains(EXPIRED_ERROR_MARKER) =>
            {
                return Response::error("ceremony expired or already consumed", 410);
            }
            Err(err) => return Err(err),
        }

        let claim_key = claim_storage_key(&claim);
        let record = storage.get::<CeremonyRecord>(&claim_key).await?;
        storage.delete(&claim_key).await?;

        json_payload_response(record.payload)
    }

    async fn claim(&mut self, req: &Request) -> WorkerResult<Response> {
        let Some(claim_id) =
            header(req, CEREMONY_CLAIM_HEADER).and_then(|value| parse_sha256(&value))
        else {
            return Response::error("valid ceremony claim required", 400);
        };
        let now_ms = unix_timestamp_ms();
        let mut storage = self.state.storage();
        let claimed = storage
            .transaction(move |mut transaction| async move {
                let claim_id_sha256 = encode_hex(&claim_id);
                let values = transaction.get_multiple(vec![RECORD_KEY]).await?;
                let record_key = JsValue::from_str(RECORD_KEY);
                if !values.has(&record_key) {
                    return Err(Error::RustError(MISSING_ERROR_MARKER.to_string()));
                }
                let mut record =
                    serde_wasm_bindgen::from_value::<CeremonyRecord>(values.get(&record_key))
                        .map_err(|err| {
                            Error::RustError(format!(
                                "invalid Passkey ceremony storage record: {err}"
                            ))
                        })?;
                match claim_decision(Some(&record), &claim_id_sha256, now_ms) {
                    ClaimDecision::Fresh => {
                        record.claim_id_sha256 = Some(claim_id_sha256);
                        transaction.put(RECORD_KEY, &record).await?;
                        Ok(())
                    }
                    ClaimDecision::Replay => Ok(()),
                    ClaimDecision::Conflict => {
                        Err(Error::RustError(CLAIM_CONFLICT_ERROR_MARKER.to_string()))
                    }
                    ClaimDecision::Expired => {
                        Err(Error::RustError(EXPIRED_ERROR_MARKER.to_string()))
                    }
                    ClaimDecision::Missing => {
                        Err(Error::RustError(MISSING_ERROR_MARKER.to_string()))
                    }
                }
            })
            .await;
        match claimed {
            Ok(()) => {}
            Err(err) if err.to_string().contains(CLAIM_CONFLICT_ERROR_MARKER) => {
                return Response::error("ceremony already claimed", 409);
            }
            Err(err)
                if err.to_string().contains(MISSING_ERROR_MARKER)
                    || err.to_string().contains(EXPIRED_ERROR_MARKER) =>
            {
                return Response::error("ceremony expired or already consumed", 410);
            }
            Err(err) => return Err(err),
        }
        let record = storage.get::<CeremonyRecord>(RECORD_KEY).await?;
        let claim_id_sha256 = encode_hex(&claim_id);
        if claim_decision(Some(&record), &claim_id_sha256, unix_timestamp_ms())
            != ClaimDecision::Replay
        {
            return Response::error("ceremony expired or already consumed", 410);
        }
        json_payload_response(record.payload)
    }
}

fn json_payload_response(payload: String) -> WorkerResult<Response> {
    let mut response = Response::ok(payload)?;
    response
        .headers_mut()
        .set("Content-Type", "application/json; charset=utf-8")?;
    response.headers_mut().set("Cache-Control", "no-store")?;
    response
        .headers_mut()
        .set("X-Content-Type-Options", "nosniff")?;
    Ok(response)
}

/// Store a bounded JSON payload for a short Passkey ceremony lifetime.
pub(crate) async fn put_json(
    env: &Env,
    ceremony_key: &str,
    payload: &str,
    ttl_seconds: u64,
) -> Result<(), PasskeyCeremonyError> {
    validate_caller_input(ceremony_key, payload, ttl_seconds)?;
    let stub = ceremony_stub(env, ceremony_key)?;

    let mut headers = Headers::new();
    headers
        .set("Content-Type", "application/json")
        .map_err(unavailable)?;
    headers
        .set(CEREMONY_KEY_HEADER, ceremony_key)
        .map_err(unavailable)?;
    headers
        .set(CEREMONY_TTL_HEADER, &ttl_seconds.to_string())
        .map_err(unavailable)?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(JsValue::from_str(payload)));
    let request =
        Request::new_with_init("https://passkey-ceremony/put", &init).map_err(unavailable)?;
    let response = stub
        .fetch_with_request(request)
        .await
        .map_err(unavailable)?;
    if response.status_code() == 204 {
        Ok(())
    } else {
        Err(PasskeyCeremonyError::Unavailable(format!(
            "Passkey ceremony put returned {}",
            response.status_code()
        )))
    }
}

/// Create a bounded JSON ceremony payload without replacing an active or
/// already-consumed challenge in the same object lifetime.
pub(crate) async fn put_once_json(
    env: &Env,
    ceremony_key: &str,
    payload: &str,
    ttl_seconds: u64,
) -> Result<(), PasskeyCeremonyError> {
    validate_caller_input(ceremony_key, payload, ttl_seconds)?;
    let stub = ceremony_stub(env, ceremony_key)?;

    let mut headers = Headers::new();
    headers
        .set("Content-Type", "application/json")
        .map_err(unavailable)?;
    headers
        .set(CEREMONY_KEY_HEADER, ceremony_key)
        .map_err(unavailable)?;
    headers
        .set(CEREMONY_TTL_HEADER, &ttl_seconds.to_string())
        .map_err(unavailable)?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(JsValue::from_str(payload)));
    let request =
        Request::new_with_init("https://passkey-ceremony/put-once", &init).map_err(unavailable)?;
    let response = stub
        .fetch_with_request(request)
        .await
        .map_err(unavailable)?;
    match response.status_code() {
        204 => Ok(()),
        409 => Err(PasskeyCeremonyError::AlreadyExists),
        status => Err(PasskeyCeremonyError::Unavailable(format!(
            "Passkey ceremony put-once returned {status}"
        ))),
    }
}

pub(crate) async fn read_json(
    env: &Env,
    ceremony_key: &str,
) -> Result<String, PasskeyCeremonyError> {
    if !valid_ceremony_key(ceremony_key) {
        return Err(PasskeyCeremonyError::InvalidRequest(
            "invalid Passkey ceremony key",
        ));
    }
    let stub = ceremony_stub(env, ceremony_key)?;
    let mut headers = Headers::new();
    headers
        .set(CEREMONY_KEY_HEADER, ceremony_key)
        .map_err(unavailable)?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post).with_headers(headers);
    let request =
        Request::new_with_init("https://passkey-ceremony/read", &init).map_err(unavailable)?;
    let mut response = stub
        .fetch_with_request(request)
        .await
        .map_err(unavailable)?;
    match response.status_code() {
        200 => {
            let payload = read_bounded_response_payload(&mut response).await?;
            Ok(payload)
        }
        410 => Err(PasskeyCeremonyError::ExpiredOrConsumed),
        status => Err(PasskeyCeremonyError::Unavailable(format!(
            "Passkey ceremony read returned {status}"
        ))),
    }
}

pub(crate) async fn replace_json_if(
    env: &Env,
    ceremony_key: &str,
    expected_payload_sha256: &str,
    payload: &str,
) -> Result<(), PasskeyCeremonyError> {
    if !valid_ceremony_key(ceremony_key) || !valid_sha256(expected_payload_sha256) {
        return Err(PasskeyCeremonyError::InvalidRequest(
            "invalid Passkey ceremony replacement",
        ));
    }
    validate_json_payload(payload)?;
    let stub = ceremony_stub(env, ceremony_key)?;
    let mut headers = Headers::new();
    headers
        .set("Content-Type", "application/json")
        .map_err(unavailable)?;
    headers
        .set(CEREMONY_KEY_HEADER, ceremony_key)
        .map_err(unavailable)?;
    headers
        .set(
            CEREMONY_EXPECTED_PAYLOAD_SHA256_HEADER,
            expected_payload_sha256,
        )
        .map_err(unavailable)?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(JsValue::from_str(payload)));
    let request =
        Request::new_with_init("https://passkey-ceremony/replace", &init).map_err(unavailable)?;
    let response = stub
        .fetch_with_request(request)
        .await
        .map_err(unavailable)?;
    match response.status_code() {
        204 => Ok(()),
        409 => Err(PasskeyCeremonyError::StateConflict),
        410 => Err(PasskeyCeremonyError::ExpiredOrConsumed),
        status => Err(PasskeyCeremonyError::Unavailable(format!(
            "Passkey ceremony replace returned {status}"
        ))),
    }
}

/// Atomically consume a Passkey ceremony payload. Exactly one concurrent take
/// can succeed; all later attempts return `ExpiredOrConsumed`.
pub(crate) async fn take_json(
    env: &Env,
    ceremony_key: &str,
) -> Result<String, PasskeyCeremonyError> {
    if !valid_ceremony_key(ceremony_key) {
        return Err(PasskeyCeremonyError::InvalidRequest(
            "invalid Passkey ceremony key",
        ));
    }
    let stub = ceremony_stub(env, ceremony_key)?;
    let claim = new_claim_id().map_err(unavailable)?;

    let mut headers = Headers::new();
    headers
        .set(CEREMONY_KEY_HEADER, ceremony_key)
        .map_err(unavailable)?;
    headers
        .set(CEREMONY_CLAIM_HEADER, &claim)
        .map_err(unavailable)?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post).with_headers(headers);
    let request =
        Request::new_with_init("https://passkey-ceremony/take", &init).map_err(unavailable)?;
    let mut response = stub
        .fetch_with_request(request)
        .await
        .map_err(unavailable)?;
    match response.status_code() {
        200 => {
            let payload = read_bounded_response_payload(&mut response).await?;
            Ok(payload)
        }
        410 => Err(PasskeyCeremonyError::ExpiredOrConsumed),
        status => Err(PasskeyCeremonyError::Unavailable(format!(
            "Passkey ceremony take returned {status}"
        ))),
    }
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct ClaimedCeremony {
    pub(crate) payload: String,
}

/// Claim a create-only ceremony without deleting its payload. The same
/// deterministic claim is replayable until expiry; another claim conflicts.
pub(crate) async fn claim_json(
    env: &Env,
    ceremony_key: &str,
    claim_id_sha256: &str,
) -> Result<ClaimedCeremony, PasskeyCeremonyError> {
    if !valid_ceremony_key(ceremony_key) || !valid_sha256(claim_id_sha256) {
        return Err(PasskeyCeremonyError::InvalidRequest(
            "invalid Passkey ceremony claim",
        ));
    }
    let stub = ceremony_stub(env, ceremony_key)?;
    let mut headers = Headers::new();
    headers
        .set(CEREMONY_KEY_HEADER, ceremony_key)
        .map_err(unavailable)?;
    headers
        .set(CEREMONY_CLAIM_HEADER, claim_id_sha256)
        .map_err(unavailable)?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post).with_headers(headers);
    let request =
        Request::new_with_init("https://passkey-ceremony/claim", &init).map_err(unavailable)?;
    let mut response = stub
        .fetch_with_request(request)
        .await
        .map_err(unavailable)?;
    match response.status_code() {
        200 => {
            let payload = read_bounded_response_payload(&mut response).await?;
            Ok(ClaimedCeremony { payload })
        }
        409 => Err(PasskeyCeremonyError::ClaimConflict),
        410 => Err(PasskeyCeremonyError::ExpiredOrConsumed),
        status => Err(PasskeyCeremonyError::Unavailable(format!(
            "Passkey ceremony claim returned {status}"
        ))),
    }
}

pub(crate) fn binding_available(env: &Env) -> bool {
    env.durable_object(PASSKEY_CEREMONIES_BINDING).is_ok()
}

pub(crate) fn ceremony_contract_compiled() -> bool {
    PASSKEY_CEREMONIES_BINDING == "PASSKEY_CEREMONIES"
        && PUT_PATH == "/put"
        && PUT_ONCE_PATH == "/put-once"
        && READ_PATH == "/read"
        && REPLACE_PATH == "/replace"
        && CLAIM_PATH == "/claim"
        && TAKE_PATH == "/take"
        && ceremony_route(true, PUT_PATH) == CeremonyRoute::Put
        && ceremony_route(true, PUT_ONCE_PATH) == CeremonyRoute::PutOnce
        && ceremony_route(true, READ_PATH) == CeremonyRoute::Read
        && ceremony_route(true, REPLACE_PATH) == CeremonyRoute::Replace
        && ceremony_route(true, CLAIM_PATH) == CeremonyRoute::Claim
        && ceremony_route(true, TAKE_PATH) == CeremonyRoute::Take
        && ceremony_route(false, TAKE_PATH) == CeremonyRoute::NotFound
        && MAX_TTL_SECONDS <= 300
        && MAX_PAYLOAD_BYTES <= 16 * 1024
}

fn ceremony_stub(env: &Env, ceremony_key: &str) -> Result<worker::Stub, PasskeyCeremonyError> {
    let namespace = env
        .durable_object(PASSKEY_CEREMONIES_BINDING)
        .map_err(|_| PasskeyCeremonyError::BindingUnavailable)?;
    let object_id = namespace.id_from_name(ceremony_key).map_err(unavailable)?;
    object_id.get_stub().map_err(unavailable)
}

fn validate_caller_input(
    ceremony_key: &str,
    payload: &str,
    ttl_seconds: u64,
) -> Result<(), PasskeyCeremonyError> {
    if !valid_ceremony_key(ceremony_key) {
        return Err(PasskeyCeremonyError::InvalidRequest(
            "invalid Passkey ceremony key",
        ));
    }
    if !valid_ttl(ttl_seconds) {
        return Err(PasskeyCeremonyError::InvalidRequest(
            "invalid Passkey ceremony TTL",
        ));
    }
    validate_json_payload(payload)
}

fn validate_json_payload(payload: &str) -> Result<(), PasskeyCeremonyError> {
    if payload.is_empty() || payload.len() > MAX_PAYLOAD_BYTES {
        return Err(PasskeyCeremonyError::InvalidRequest(
            "invalid Passkey ceremony payload size",
        ));
    }
    serde_json::from_str::<serde_json::Value>(payload)
        .map(|_| ())
        .map_err(|_| PasskeyCeremonyError::InvalidRequest("invalid Passkey ceremony JSON"))
}

async fn read_bounded_payload(
    req: &mut Request,
) -> WorkerResult<Result<String, BoundedPayloadError>> {
    if request_content_length(req).is_some_and(|length| length > MAX_PAYLOAD_BYTES) {
        return Ok(Err(BoundedPayloadError::TooLarge));
    }
    let mut stream = req.stream()?;
    let mut bytes = Vec::with_capacity(
        request_content_length(req)
            .map(|length| length.min(MAX_PAYLOAD_BYTES))
            .unwrap_or_default(),
    );
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        let Some(next_length) = bytes.len().checked_add(chunk.len()) else {
            return Ok(Err(BoundedPayloadError::TooLarge));
        };
        if next_length > MAX_PAYLOAD_BYTES {
            return Ok(Err(BoundedPayloadError::TooLarge));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8(bytes).map_err(|_| BoundedPayloadError::InvalidEncoding))
}

async fn read_bounded_response_payload(
    response: &mut Response,
) -> Result<String, PasskeyCeremonyError> {
    let bytes = crate::relay::read_response_bytes_limited(response, MAX_PAYLOAD_BYTES)
        .await
        .map_err(|_| {
            PasskeyCeremonyError::Unavailable(
                "Passkey ceremony response exceeded the bounded contract".to_string(),
            )
        })?;
    let payload = String::from_utf8(bytes).map_err(|_| {
        PasskeyCeremonyError::Unavailable(
            "Passkey ceremony response was not valid UTF-8".to_string(),
        )
    })?;
    validate_json_payload(&payload)?;
    Ok(payload)
}

fn ceremony_route(is_post: bool, path: &str) -> CeremonyRoute {
    match (is_post, path) {
        (true, PUT_PATH) => CeremonyRoute::Put,
        (true, PUT_ONCE_PATH) => CeremonyRoute::PutOnce,
        (true, READ_PATH) => CeremonyRoute::Read,
        (true, REPLACE_PATH) => CeremonyRoute::Replace,
        (true, CLAIM_PATH) => CeremonyRoute::Claim,
        (true, TAKE_PATH) => CeremonyRoute::Take,
        _ => CeremonyRoute::NotFound,
    }
}

fn valid_ceremony_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= MAX_KEY_BYTES
        && key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'-' | b'_' | b'.'))
}

fn valid_ttl(ttl_seconds: u64) -> bool {
    (1..=MAX_TTL_SECONDS).contains(&ttl_seconds)
}

fn take_decision(record: Option<&CeremonyRecord>, now_ms: i64) -> TakeDecision {
    match record {
        None => TakeDecision::Missing,
        Some(record) if record.expires_at_ms <= now_ms => TakeDecision::Expired,
        Some(record) if record.claim_id_sha256.is_some() => TakeDecision::Claimed,
        Some(_) => TakeDecision::Available,
    }
}

fn claim_decision(
    record: Option<&CeremonyRecord>,
    claim_id_sha256: &str,
    now_ms: i64,
) -> ClaimDecision {
    match record {
        None => ClaimDecision::Missing,
        Some(record) if record.expires_at_ms <= now_ms => ClaimDecision::Expired,
        Some(record) if record.claim_id_sha256.as_deref() == Some(claim_id_sha256) => {
            ClaimDecision::Replay
        }
        Some(record) if record.claim_id_sha256.is_some() => ClaimDecision::Conflict,
        Some(_) => ClaimDecision::Fresh,
    }
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn parse_sha256(value: &str) -> Option<[u8; 32]> {
    if !valid_sha256(value) {
        return None;
    }
    let mut bytes = [0u8; 32];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        let high = hex_value(pair[0])?;
        let low = hex_value(pair[1])?;
        bytes[index] = (high << 4) | low;
    }
    Some(bytes)
}

fn claim_storage_key(claim: &[u8; CLAIM_BYTES]) -> String {
    format!("{CLAIM_PREFIX}{}", encode_hex(claim))
}

fn new_claim_id() -> WorkerResult<String> {
    let mut bytes = [0u8; CLAIM_BYTES];
    getrandom::getrandom(&mut bytes)
        .map_err(|err| Error::RustError(format!("Passkey ceremony claim entropy failed: {err}")))?;
    Ok(encode_hex(&bytes))
}

fn parse_claim(value: &str) -> Option<[u8; CLAIM_BYTES]> {
    if value.len() != CLAIM_BYTES * 2 {
        return None;
    }
    let mut bytes = [0u8; CLAIM_BYTES];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        let high = hex_value(pair[0])?;
        let low = hex_value(pair[1])?;
        bytes[index] = (high << 4) | low;
    }
    Some(bytes)
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    }
}

fn request_content_length(req: &Request) -> Option<usize> {
    header(req, "content-length").and_then(|value| value.parse::<usize>().ok())
}

fn header(req: &Request, name: &str) -> Option<String> {
    req.headers()
        .get(name)
        .ok()
        .flatten()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn unix_timestamp_ms() -> i64 {
    js_sys::Date::now().max(0.0) as i64
}

fn unavailable(error: impl fmt::Display) -> PasskeyCeremonyError {
    PasskeyCeremonyError::Unavailable(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(expires_at_ms: i64) -> CeremonyRecord {
        CeremonyRecord {
            payload: r#"{"challenge":"value"}"#.to_string(),
            expires_at_ms,
            claim_id_sha256: None,
        }
    }

    #[test]
    fn take_decision_is_fail_closed_at_expiry_boundary() {
        assert_eq!(take_decision(None, 1_000), TakeDecision::Missing);
        assert_eq!(
            take_decision(Some(&record(1_000)), 1_000),
            TakeDecision::Expired
        );
        assert_eq!(
            take_decision(Some(&record(999)), 1_000),
            TakeDecision::Expired
        );
        assert_eq!(
            take_decision(Some(&record(1_001)), 1_000),
            TakeDecision::Available
        );
        let mut claimed = record(1_001);
        claimed.claim_id_sha256 = Some("01".repeat(32));
        assert_eq!(take_decision(Some(&claimed), 1_000), TakeDecision::Claimed);
    }

    #[test]
    fn request_contract_only_accepts_declared_post_routes() {
        assert_eq!(ceremony_route(true, "/put"), CeremonyRoute::Put);
        assert_eq!(ceremony_route(true, "/put-once"), CeremonyRoute::PutOnce);
        assert_eq!(ceremony_route(true, "/read"), CeremonyRoute::Read);
        assert_eq!(ceremony_route(true, "/replace"), CeremonyRoute::Replace);
        assert_eq!(ceremony_route(true, "/claim"), CeremonyRoute::Claim);
        assert_eq!(ceremony_route(true, "/take"), CeremonyRoute::Take);
        assert_eq!(ceremony_route(false, "/take"), CeremonyRoute::NotFound);
        assert_eq!(ceremony_route(true, "/unknown"), CeremonyRoute::NotFound);
        assert!(ceremony_contract_compiled());
    }

    #[test]
    fn caller_contract_bounds_keys_ttl_and_json() {
        assert!(validate_caller_input("login:flow-1", r#"{"challenge":"x"}"#, 120).is_ok());
        assert!(validate_caller_input("login/flow", "{}", 120).is_err());
        assert!(validate_caller_input("login:flow", "not-json", 120).is_err());
        assert!(validate_caller_input("login:flow", "{}", 0).is_err());
        assert!(validate_caller_input("login:flow", "{}", MAX_TTL_SECONDS + 1).is_err());
        assert!(validate_json_payload(&" ".repeat(MAX_PAYLOAD_BYTES + 1)).is_err());
    }

    #[test]
    fn claim_keys_are_unique_fixed_length_and_not_user_controlled() {
        let first = [0x01; CLAIM_BYTES];
        let second = [0x02; CLAIM_BYTES];
        assert_eq!(parse_claim(&encode_hex(&first)), Some(first));
        assert_eq!(
            claim_storage_key(&first).len(),
            CLAIM_PREFIX.len() + CLAIM_BYTES * 2
        );
        assert_ne!(claim_storage_key(&first), claim_storage_key(&second));
        assert!(parse_claim("short").is_none());
        assert!(parse_claim("0000000000000000000000000000000G").is_none());
    }

    #[test]
    fn retained_claim_is_replayable_but_exclusive_until_expiry() {
        let claim = "01".repeat(32);
        let other = "02".repeat(32);
        let mut active = record(1_001);
        assert_eq!(
            claim_decision(Some(&active), &claim, 1_000),
            ClaimDecision::Fresh
        );
        active.claim_id_sha256 = Some(claim.clone());
        assert_eq!(
            claim_decision(Some(&active), &claim, 1_000),
            ClaimDecision::Replay
        );
        assert_eq!(
            claim_decision(Some(&active), &other, 1_000),
            ClaimDecision::Conflict
        );
        assert_eq!(
            claim_decision(Some(&active), &claim, 1_001),
            ClaimDecision::Expired
        );
        assert_eq!(claim_decision(None, &claim, 1_000), ClaimDecision::Missing);
    }

    #[test]
    fn public_errors_distinguish_binding_from_expiry_without_leaking_runtime_detail() {
        assert_ne!(
            PasskeyCeremonyError::BindingUnavailable,
            PasskeyCeremonyError::ExpiredOrConsumed
        );
        assert_ne!(
            PasskeyCeremonyError::AlreadyExists,
            PasskeyCeremonyError::ExpiredOrConsumed
        );
        assert_ne!(
            PasskeyCeremonyError::StateConflict,
            PasskeyCeremonyError::ExpiredOrConsumed
        );
        assert_ne!(
            PasskeyCeremonyError::ClaimConflict,
            PasskeyCeremonyError::ExpiredOrConsumed
        );
        let unavailable = PasskeyCeremonyError::Unavailable("secret detail".to_string());
        assert_eq!(
            unavailable.to_string(),
            "Passkey ceremony service unavailable"
        );
        assert!(!unavailable.to_string().contains("secret detail"));
    }
}
