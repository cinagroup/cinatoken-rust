//! Final-boundary one-time consumption for WFP paid-request authority envelopes.
//!
//! The outbound Worker selects the canonical shard after exact-request checks;
//! this platform-owned DO authenticates the central v3 signature and atomically
//! consumes the request ID before the outbound bearer can be injected.
//!
//! The tenant forwards the opaque envelope. The outbound Worker validates the
//! exact request and invokes this Durable Object before any paid egress.

use cinatoken_wfp_authority::{
    authority_replay_bucket, authority_replay_cleanup_at, verify_authority_claims,
    AUTHORITY_HEADER, AUTHORITY_REPLAY_BINDING, AUTHORITY_SECRET_ENV,
};
use sha2::{Digest, Sha256};
use std::time::Duration;
use wasm_bindgen::JsValue;
use worker::{
    durable_object, Env, Error, Method, Request, Response, Result as WorkerResult, State,
};

const CONSUME_PATH: &str = "/consume";
const WORKER_HEADER: &str = "x-cinatoken-wfp-worker";
const REPLAY_ERROR_MARKER: &str = "cinatoken_wfp_authority_replay";
const STORAGE_PREFIX: &str = "used:";

#[durable_object]
pub struct WfpAuthorityReplay {
    state: State,
    env: Env,
}

#[durable_object]
impl DurableObject for WfpAuthorityReplay {
    fn new(state: State, env: Env) -> Self {
        Self { state, env }
    }

    async fn fetch(&mut self, req: Request) -> WorkerResult<Response> {
        if req.method() != Method::Post || req.path() != CONSUME_PATH {
            return Response::error("not found", 404);
        }
        let Some(worker_name) = header(&req, WORKER_HEADER) else {
            return Response::error("worker identity required", 403);
        };
        let Some(authority) = header(&req, AUTHORITY_HEADER) else {
            return Response::error("authority required", 403);
        };
        let Some(secret) = secret_or_var(&self.env, AUTHORITY_SECRET_ENV) else {
            return Response::error("authority verifier unavailable", 503);
        };
        let now = unix_timestamp();
        let claims = match verify_authority_claims(secret.as_bytes(), &authority, &worker_name, now)
        {
            Ok(claims) => claims,
            Err(_) => return Response::error("invalid authority", 403),
        };
        let bucket = match authority_replay_bucket(&worker_name, claims.issued_at) {
            Ok(bucket) => bucket,
            Err(_) => return Response::error("invalid replay bucket", 403),
        };
        let expected_id = self
            .env
            .durable_object(AUTHORITY_REPLAY_BINDING)?
            .id_from_name(&bucket)?
            .to_string();
        if !canonical_object_matches(&expected_id, &self.state.id().to_string()) {
            return Response::error("non-canonical replay object", 403);
        }

        let digest = replay_digest(&claims.request_id);
        let expires_at = claims.expires_at;
        let mut storage = self.state.storage();
        let consumed = storage
            .transaction(move |mut transaction| async move {
                let key = replay_storage_key(&digest);
                let existing = transaction.get_multiple(vec![key.clone()]).await?;
                if existing.has(&JsValue::from_str(&key)) {
                    return Err(Error::RustError(REPLAY_ERROR_MARKER.to_string()));
                }
                transaction.put(&key, expires_at).await
            })
            .await;
        match consumed {
            Ok(()) => {}
            Err(err) if err.to_string().contains(REPLAY_ERROR_MARKER) => {
                return Response::error("authority already consumed", 409);
            }
            Err(err) => return Err(err),
        }

        let cleanup_at = authority_replay_cleanup_at(claims.issued_at)
            .map_err(|err| Error::RustError(format!("invalid replay cleanup window: {err}")))?;
        let delay_seconds = cleanup_at.saturating_sub(now).max(1) as u64;
        self.state
            .storage()
            .set_alarm(Duration::from_secs(delay_seconds))
            .await?;
        Response::empty()
    }

    async fn alarm(&mut self) -> WorkerResult<Response> {
        self.state.storage().delete_all().await?;
        Response::empty()
    }
}

pub(crate) fn replay_contract_compiled() -> bool {
    AUTHORITY_REPLAY_BINDING == "WFP_AUTHORITY_REPLAY"
        && CONSUME_PATH == "/consume"
        && replay_storage_key(&replay_digest("request-1")).starts_with(STORAGE_PREFIX)
        && !replay_storage_key(&replay_digest("request-1")).contains("request-1")
        && canonical_object_matches("object-a", "object-a")
        && !canonical_object_matches("object-a", "object-b")
}

fn canonical_object_matches(expected_id: &str, current_id: &str) -> bool {
    expected_id == current_id
}

fn replay_digest(request_id: &str) -> [u8; 32] {
    Sha256::digest(request_id.as_bytes()).into()
}

fn replay_storage_key(digest: &[u8; 32]) -> String {
    format!(
        "{STORAGE_PREFIX}{}",
        digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

fn header(req: &Request, name: &str) -> Option<String> {
    req.headers()
        .get(name)
        .ok()
        .flatten()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn secret_or_var(env: &Env, name: &str) -> Option<String> {
    env.secret(name)
        .map(|value| value.to_string())
        .ok()
        .or_else(|| env.var(name).ok().map(|value| value.to_string()))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn unix_timestamp() -> i64 {
    (js_sys::Date::now() / 1000.0) as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replay_storage_keys_are_fixed_secret_free_hashes() {
        let key = replay_storage_key(&replay_digest("request-secret-value"));
        assert_eq!(key.len(), STORAGE_PREFIX.len() + 64);
        assert!(!key.contains("request-secret-value"));
        assert_ne!(key, replay_storage_key(&replay_digest("request-other")));
    }

    #[test]
    fn replay_contract_is_fail_closed_and_platform_owned() {
        assert!(replay_contract_compiled());
        assert_eq!(AUTHORITY_REPLAY_BINDING, "WFP_AUTHORITY_REPLAY");
        assert_eq!(CONSUME_PATH, "/consume");
        assert!(REPLAY_ERROR_MARKER.contains("authority_replay"));
        assert!(canonical_object_matches("expected", "expected"));
        assert!(!canonical_object_matches("expected", "alternate"));
    }
}
