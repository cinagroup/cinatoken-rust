//! Strongly consistent, one-time storage for Passkey ceremony challenges.
//!
//! Each ceremony key maps to its own Durable Object. A take transaction moves
//! the record to a request-unique claim key before returning it, so concurrent
//! finish requests can never both consume the same challenge.

use serde::{Deserialize, Serialize};
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
const TAKE_PATH: &str = "/take";
const CEREMONY_KEY_HEADER: &str = "x-cinatoken-passkey-ceremony-key";
const CEREMONY_TTL_HEADER: &str = "x-cinatoken-passkey-ceremony-ttl";
const CEREMONY_CLAIM_HEADER: &str = "x-cinatoken-passkey-ceremony-claim";
const RECORD_KEY: &str = "ceremony";
const CREATE_LOCK_KEY: &str = "create-lock";
const CLAIM_PREFIX: &str = "claim:";
const MISSING_ERROR_MARKER: &str = "cinatoken_passkey_ceremony_missing";
const EXPIRED_ERROR_MARKER: &str = "cinatoken_passkey_ceremony_expired";
const ALREADY_EXISTS_ERROR_MARKER: &str = "cinatoken_passkey_ceremony_already_exists";
const MAX_KEY_BYTES: usize = 256;
const MAX_PAYLOAD_BYTES: usize = 16 * 1024;
const MAX_TTL_SECONDS: u64 = 300;
const CLAIM_BYTES: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PasskeyCeremonyError {
    BindingUnavailable,
    AlreadyExists,
    ExpiredOrConsumed,
    InvalidRequest(&'static str),
    Unavailable(String),
}

impl fmt::Display for PasskeyCeremonyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BindingUnavailable => formatter.write_str("Passkey ceremony binding unavailable"),
            Self::AlreadyExists => formatter.write_str("Passkey ceremony already exists"),
            Self::ExpiredOrConsumed => {
                formatter.write_str("Passkey ceremony expired or already consumed")
            }
            Self::InvalidRequest(message) => formatter.write_str(message),
            Self::Unavailable(_) => formatter.write_str("Passkey ceremony service unavailable"),
        }
    }
}

impl std::error::Error for PasskeyCeremonyError {}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct CeremonyRecord {
    payload: String,
    expires_at_ms: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
struct CeremonyCreateLock {
    expires_at_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TakeDecision {
    Available,
    Expired,
    Missing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CeremonyRoute {
    Put,
    PutOnce,
    Take,
    NotFound,
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
        if request_content_length(req).is_some_and(|length| length > MAX_PAYLOAD_BYTES) {
            return Response::error("ceremony payload too large", 413);
        }

        let payload = req.text().await?;
        if validate_json_payload(&payload).is_err() {
            return Response::error("invalid ceremony JSON payload", 400);
        }

        let now_ms = unix_timestamp_ms();
        let expires_at_ms = now_ms.saturating_add((ttl_seconds as i64).saturating_mul(1_000));
        let record = CeremonyRecord {
            payload,
            expires_at_ms,
        };

        // Arm cleanup before persisting. If the write fails, the harmless alarm
        // will remove the empty object; if it succeeds, expiry is still checked
        // synchronously by take and never depends on alarm timing.
        self.state
            .storage()
            .set_alarm(Duration::from_secs(ttl_seconds))
            .await?;
        if create_only {
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
                    Ok(())
                })
                .await;
            match lock {
                Ok(()) => {}
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
        self.state.storage().put(RECORD_KEY, record).await?;
        Ok(Response::empty()?.with_status(204))
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

        let mut response = Response::ok(record.payload)?;
        response
            .headers_mut()
            .set("Content-Type", "application/json; charset=utf-8")?;
        Ok(response)
    }
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
            let payload = response.text().await.map_err(unavailable)?;
            validate_json_payload(&payload)?;
            Ok(payload)
        }
        410 => Err(PasskeyCeremonyError::ExpiredOrConsumed),
        status => Err(PasskeyCeremonyError::Unavailable(format!(
            "Passkey ceremony take returned {status}"
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
        && TAKE_PATH == "/take"
        && ceremony_route(true, PUT_PATH) == CeremonyRoute::Put
        && ceremony_route(true, PUT_ONCE_PATH) == CeremonyRoute::PutOnce
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

fn ceremony_route(is_post: bool, path: &str) -> CeremonyRoute {
    match (is_post, path) {
        (true, PUT_PATH) => CeremonyRoute::Put,
        (true, PUT_ONCE_PATH) => CeremonyRoute::PutOnce,
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
        Some(_) => TakeDecision::Available,
    }
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
    }

    #[test]
    fn request_contract_only_accepts_post_put_and_take() {
        assert_eq!(ceremony_route(true, "/put"), CeremonyRoute::Put);
        assert_eq!(ceremony_route(true, "/put-once"), CeremonyRoute::PutOnce);
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
    fn public_errors_distinguish_binding_from_expiry_without_leaking_runtime_detail() {
        assert_ne!(
            PasskeyCeremonyError::BindingUnavailable,
            PasskeyCeremonyError::ExpiredOrConsumed
        );
        assert_ne!(
            PasskeyCeremonyError::AlreadyExists,
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
