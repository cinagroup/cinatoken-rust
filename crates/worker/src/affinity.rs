//! Channel affinity (sticky routing) on a Durable Object — a minimal,
//! faithful-subset port of Go's `service/channel_affinity.go`
//! (`GetPreferredChannelByAffinity` / `RecordChannelAffinity`). Parity target:
//! `docs/source-channel-selection-parity.md` (item 1.3, migration-plan §21.2).
//!
//! Scope vs Go (documented simplifications): Go has a configurable rule system
//! (key sources, regex match, override templates, an L1 in-memory + L2 Redis
//! hybrid cache, and stats). This port keeps the core behavior only — one sticky
//! preferred channel per `(user, model, group)` with a fixed TTL, stored in a
//! per-key Durable Object — and reads/writes it directly (no L1 cache, so it is
//! one DO round-trip per request when enabled). It is **off unless
//! `RELAY_CHANNEL_AFFINITY_ENABLED` is set**, so deploying the DO binding alone
//! changes nothing. It always **fails open**: any missing binding or DO error
//! falls back to normal selection.

use worker::{durable_object, Env, Request, Response, Result, State};

/// Storage key for the single affinity record held by each per-key DO instance.
const RECORD_KEY: &str = "affinity";
/// Durable Object binding name (see `wrangler.toml`).
pub const AFFINITY_BINDING: &str = "CHANNEL_AFFINITY";
/// Env flag that turns affinity on. Off (absent / not "true"/"1") = no-op.
pub const AFFINITY_ENABLED_ENV: &str = "RELAY_CHANNEL_AFFINITY_ENABLED";
/// Fixed sticky TTL. Go uses a per-rule TTL; this port uses one constant.
pub const AFFINITY_TTL_SECONDS: u64 = 600;

#[derive(serde::Serialize, serde::Deserialize)]
struct AffinityRecord {
    channel_id: i64,
    /// Unix epoch milliseconds at which this record expires.
    expires_at_ms: f64,
}

/// Per-key Durable Object holding one preferred-channel record. Addressed by
/// [`affinity_key`] via `id_from_name`, so each `(user, model, group)` maps to
/// its own instance. Internal RPC uses GET `/get` and GET `/put?channel&ttl`
/// (plain `fetch_with_str`, no request body to construct).
#[durable_object]
pub struct ChannelAffinity {
    state: State,
}

#[durable_object]
impl DurableObject for ChannelAffinity {
    fn new(state: State, _env: Env) -> Self {
        Self { state }
    }

    async fn fetch(&mut self, req: Request) -> Result<Response> {
        let url = req.url()?;
        let now_ms = js_sys::Date::now();
        match url.path() {
            "/get" => match self.state.storage().get::<AffinityRecord>(RECORD_KEY).await {
                Ok(record) if record.expires_at_ms > now_ms => {
                    Response::ok(record.channel_id.to_string())
                }
                // Missing, expired, or unreadable -> miss (caller falls open).
                _ => Response::error("affinity miss", 404),
            },
            "/put" => {
                let mut channel_id: Option<i64> = None;
                let mut ttl_seconds = AFFINITY_TTL_SECONDS as f64;
                for (key, value) in url.query_pairs() {
                    match key.as_ref() {
                        "channel" => channel_id = value.parse::<i64>().ok(),
                        "ttl" => {
                            if let Ok(seconds) = value.parse::<f64>() {
                                if seconds > 0.0 {
                                    ttl_seconds = seconds;
                                }
                            }
                        }
                        _ => {}
                    }
                }
                if let Some(channel_id) = channel_id {
                    let record = AffinityRecord {
                        channel_id,
                        expires_at_ms: now_ms + ttl_seconds * 1000.0,
                    };
                    self.state.storage().put(RECORD_KEY, record).await?;
                }
                Response::ok("ok")
            }
            _ => Response::error("not found", 404),
        }
    }
}

/// Whether affinity is enabled for this request (env flag opt-in).
pub fn affinity_enabled(value: Option<String>) -> bool {
    matches!(value.as_deref(), Some("true") | Some("1"))
}

/// The DO instance name for a client's sticky routing context. A subset of Go's
/// rule-derived cache key: one stable key per `(user, model, group)`.
pub fn affinity_key(user_id: i64, model: &str, group: &str) -> String {
    format!("u:{user_id}|m:{model}|g:{group}")
}

/// Move the affinity-preferred entry to the front of `items` if it is present
/// (so it is tried first, with the planned order as fallback). Pure and generic
/// over the item type for testability; relay passes the attempt plan and reads
/// each entry's channel id. No-op when `preferred_id` is `None` or absent.
pub fn move_preferred_to_front<T>(
    mut items: Vec<T>,
    preferred_id: Option<i64>,
    id_of: impl Fn(&T) -> i64,
) -> Vec<T> {
    let Some(preferred_id) = preferred_id else {
        return items;
    };
    if let Some(position) = items.iter().position(|item| id_of(item) == preferred_id) {
        if position != 0 {
            let entry = items.remove(position);
            items.insert(0, entry);
        }
    }
    items
}

/// Look up the preferred channel id for `key`, or `None`. Fails open: a missing
/// binding or any DO error yields `None` (normal selection).
pub async fn lookup_preferred_channel(env: &Env, key: &str) -> Option<i64> {
    let namespace = env.durable_object(AFFINITY_BINDING).ok()?;
    let stub = namespace.id_from_name(key).ok()?.get_stub().ok()?;
    let mut response = stub.fetch_with_str("https://affinity/get").await.ok()?;
    if response.status_code() != 200 {
        return None;
    }
    response.text().await.ok()?.trim().parse::<i64>().ok()
}

/// Record `channel_id` as the preferred channel for `key` (best-effort, fails
/// open). Called only after a successful relay (`status < 400`).
pub async fn record_preferred_channel(env: &Env, key: &str, channel_id: i64, ttl_seconds: u64) {
    let Ok(namespace) = env.durable_object(AFFINITY_BINDING) else {
        return;
    };
    let Ok(object_id) = namespace.id_from_name(key) else {
        return;
    };
    let Ok(stub) = object_id.get_stub() else {
        return;
    };
    let url = format!("https://affinity/put?channel={channel_id}&ttl={ttl_seconds}");
    let _ = stub.fetch_with_str(&url).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(items: &[i64]) -> Vec<i64> {
        items.to_vec()
    }

    #[test]
    fn affinity_key_is_stable_and_scoped() {
        assert_eq!(
            affinity_key(7, "gpt-4o", "default"),
            "u:7|m:gpt-4o|g:default"
        );
        assert_ne!(
            affinity_key(7, "gpt-4o", "default"),
            affinity_key(7, "gpt-4o", "vip")
        );
    }

    #[test]
    fn enabled_only_for_true_or_one() {
        assert!(affinity_enabled(Some("true".into())));
        assert!(affinity_enabled(Some("1".into())));
        assert!(!affinity_enabled(Some("false".into())));
        assert!(!affinity_enabled(Some("0".into())));
        assert!(!affinity_enabled(None));
    }

    #[test]
    fn preferred_moves_to_front_when_present() {
        let plan = vec![1, 2, 3];
        assert_eq!(
            ids(&move_preferred_to_front(plan, Some(3), |x| *x)),
            vec![3, 1, 2]
        );
    }

    #[test]
    fn preferred_absent_or_none_is_unchanged() {
        assert_eq!(
            move_preferred_to_front(vec![1, 2, 3], Some(9), |x| *x),
            vec![1, 2, 3]
        );
        assert_eq!(
            move_preferred_to_front(vec![1, 2, 3], None, |x| *x),
            vec![1, 2, 3]
        );
    }

    #[test]
    fn preferred_already_front_is_unchanged() {
        assert_eq!(
            move_preferred_to_front(vec![5, 1, 2], Some(5), |x| *x),
            vec![5, 1, 2]
        );
    }
}
