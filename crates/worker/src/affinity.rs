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

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use worker::{durable_object, Env, Request, Response, Result, State};

/// Storage key for the single affinity record held by each per-key DO instance.
const RECORD_KEY: &str = "affinity";
/// Durable Object binding name (see `wrangler.toml`).
pub const AFFINITY_BINDING: &str = "CHANNEL_AFFINITY";
/// Env flag that turns affinity on. Off (absent / not "true"/"1") = no-op.
pub const AFFINITY_ENABLED_ENV: &str = "RELAY_CHANNEL_AFFINITY_ENABLED";
/// Fixed sticky TTL. Go uses a per-rule TTL; this port uses one constant.
pub const AFFINITY_TTL_SECONDS: u64 = 600;
/// KV binding used only for admin-visible index metadata. The source of truth
/// remains the per-key Durable Object record.
pub const AFFINITY_INDEX_KV_BINDING: &str = "CACHE_KV";
/// Namespaced KV prefix for affinity index entries.
pub const AFFINITY_INDEX_PREFIX: &str = "affinity:index:";
/// Rust's current fixed-rule name. Go supports configurable rules; this subset
/// intentionally exposes its single built-in rule so the admin UI can be honest.
pub const AFFINITY_RULE_NAME: &str = "rust-minimal-user-model-group";
/// Scope label for stats and docs.
pub const AFFINITY_SCOPE: &str = "rust_minimal_user_model_group";
/// Bound admin list/clear calls so a Worker request never becomes a long scan.
pub const AFFINITY_INDEX_SCAN_LIMIT: usize = 1_000;
const AFFINITY_INDEX_PAGE_LIMIT: u64 = 100;

#[derive(Serialize, Deserialize)]
struct AffinityRecord {
    channel_id: i64,
    /// Unix epoch milliseconds at which this record expires.
    expires_at_ms: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AffinityIndexEntry {
    /// Original Durable Object instance name. It is metadata, not a secret, but
    /// the KV key stores only a URL-safe encoding to keep list output tidy.
    pub key: String,
    pub channel_id: i64,
    #[serde(default = "default_affinity_rule_name")]
    pub rule_name: String,
    #[serde(default = "default_affinity_scope")]
    pub scope: String,
    pub recorded_at_ms: f64,
    pub expires_at_ms: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct AffinityIndexedItem {
    pub index_key: String,
    pub entry: AffinityIndexEntry,
}

#[derive(Clone, Debug, Serialize)]
pub struct AffinityIndexListing {
    pub entries: Vec<AffinityIndexedItem>,
    pub malformed: usize,
    #[serde(skip_serializing)]
    pub malformed_keys: Vec<String>,
    pub scanned: usize,
    pub truncated: bool,
    pub cursor: Option<String>,
    pub scan_limit: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct AffinityCacheStats {
    pub enabled: bool,
    pub total: usize,
    pub unknown: usize,
    pub by_rule_name: BTreeMap<String, usize>,
    pub cache_capacity: usize,
    pub cache_algo: String,
    pub active: usize,
    pub expired: usize,
    pub malformed: usize,
    pub by_channel_id: BTreeMap<String, usize>,
    pub scope: String,
    pub rust_rule_name: String,
    pub kv_binding: String,
    pub truncated: bool,
    pub cursor: Option<String>,
    pub scan_limit: usize,
    pub note: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct AffinityClearResult {
    pub deleted: usize,
    pub do_deleted: usize,
    pub kv_deleted: usize,
    pub failed: usize,
    pub skipped_rule: usize,
    pub malformed: usize,
    pub truncated: bool,
    pub cursor: Option<String>,
    pub scan_limit: usize,
    pub rule_name: Option<String>,
    pub all: bool,
    pub scope: String,
}

/// Per-key Durable Object holding one preferred-channel record. Addressed by
/// [`affinity_key`] via `id_from_name`, so each `(user, model, group)` maps to
/// its own instance. Internal RPC uses GET `/get` and GET `/put?channel&ttl`
/// (plain `fetch_with_str`, no request body to construct). Admin clear uses
/// GET `/delete` for the same per-key instance.
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
            "/delete" => {
                self.state.storage().delete(RECORD_KEY).await?;
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

pub fn affinity_index_key(key: &str) -> String {
    format!("{AFFINITY_INDEX_PREFIX}{}", URL_SAFE_NO_PAD.encode(key))
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
    let Ok(response) = stub.fetch_with_str(&url).await else {
        return;
    };
    if response.status_code() != 200 {
        return;
    }
    if let Err(err) = record_affinity_index(env, key, channel_id, ttl_seconds).await {
        worker::console_warn!("failed to record channel affinity index: {}", err);
    }
}

pub async fn delete_preferred_channel(env: &Env, key: &str) -> Result<bool> {
    let namespace = env.durable_object(AFFINITY_BINDING)?;
    let stub = namespace.id_from_name(key)?.get_stub()?;
    let response = stub.fetch_with_str("https://affinity/delete").await?;
    Ok(response.status_code() == 200)
}

pub async fn affinity_cache_stats(
    env: &Env,
    cursor: Option<String>,
    scan_limit: usize,
) -> Result<AffinityCacheStats> {
    let listing = list_affinity_index(env, cursor, scan_limit).await?;
    let enabled = affinity_enabled(
        env.var(AFFINITY_ENABLED_ENV)
            .map(|value| value.to_string())
            .ok(),
    );
    let now_ms = js_sys::Date::now();
    let mut by_rule_name = BTreeMap::new();
    by_rule_name.insert(AFFINITY_RULE_NAME.to_string(), 0);
    let mut by_channel_id = BTreeMap::new();
    let mut active = 0;
    let mut expired = 0;
    let mut unknown = listing.malformed;

    for item in &listing.entries {
        if item.entry.rule_name != AFFINITY_RULE_NAME {
            unknown += 1;
            continue;
        }
        if item.entry.expires_at_ms <= now_ms {
            expired += 1;
            continue;
        }
        active += 1;
        *by_rule_name
            .entry(item.entry.rule_name.clone())
            .or_insert(0) += 1;
        *by_channel_id
            .entry(item.entry.channel_id.to_string())
            .or_insert(0) += 1;
    }

    Ok(AffinityCacheStats {
        enabled,
        total: listing.scanned,
        unknown,
        by_rule_name,
        cache_capacity: listing.scan_limit,
        cache_algo: "durable-object+kv-index:bounded-scan".to_string(),
        active,
        expired,
        malformed: listing.malformed,
        by_channel_id,
        scope: AFFINITY_SCOPE.to_string(),
        rust_rule_name: AFFINITY_RULE_NAME.to_string(),
        kv_binding: AFFINITY_INDEX_KV_BINDING.to_string(),
        truncated: listing.truncated,
        cursor: listing.cursor,
        scan_limit: listing.scan_limit,
        note: "Cloudflare Rust subset: stats cover indexed Durable Object affinity entries only; Go rule-template and usage-stat caches are not synthesized.".to_string(),
    })
}

pub async fn clear_affinity_cache(
    env: &Env,
    rule_name: Option<&str>,
    scan_limit: usize,
) -> Result<AffinityClearResult> {
    let rule_name = rule_name.map(str::trim).filter(|value| !value.is_empty());
    let listing = list_affinity_index(env, None, scan_limit).await?;
    let kv = env.kv(AFFINITY_INDEX_KV_BINDING)?;
    let mut result = AffinityClearResult {
        deleted: 0,
        do_deleted: 0,
        kv_deleted: 0,
        failed: 0,
        skipped_rule: 0,
        malformed: listing.malformed,
        truncated: listing.truncated,
        cursor: listing.cursor,
        scan_limit: listing.scan_limit,
        rule_name: rule_name.map(ToOwned::to_owned),
        all: rule_name.is_none(),
        scope: AFFINITY_SCOPE.to_string(),
    };

    let clear_all = rule_name.is_none();

    for item in listing.entries {
        if !matches_rule_filter(rule_name, &item.entry.rule_name) {
            result.skipped_rule += 1;
            continue;
        }
        match delete_preferred_channel(env, &item.entry.key).await {
            Ok(true) => {
                result.do_deleted += 1;
            }
            Ok(false) => {
                result.failed += 1;
                continue;
            }
            Err(err) => {
                worker::console_warn!("failed to delete channel affinity DO record: {}", err);
                result.failed += 1;
                continue;
            }
        }
        match kv.delete(&item.index_key).await {
            Ok(()) => {
                result.kv_deleted += 1;
                result.deleted += 1;
            }
            Err(err) => {
                worker::console_warn!("failed to delete channel affinity KV index: {}", err);
                result.failed += 1;
            }
        }
    }

    if clear_all {
        for key in listing.malformed_keys {
            match kv.delete(&key).await {
                Ok(()) => {
                    result.kv_deleted += 1;
                    result.deleted += 1;
                }
                Err(err) => {
                    worker::console_warn!(
                        "failed to delete malformed channel affinity KV index: {}",
                        err
                    );
                    result.failed += 1;
                }
            }
        }
    }

    Ok(result)
}

async fn record_affinity_index(
    env: &Env,
    key: &str,
    channel_id: i64,
    ttl_seconds: u64,
) -> Result<()> {
    let ttl_seconds = ttl_seconds.max(60);
    let now_ms = js_sys::Date::now();
    let entry = AffinityIndexEntry {
        key: key.to_string(),
        channel_id,
        rule_name: AFFINITY_RULE_NAME.to_string(),
        scope: AFFINITY_SCOPE.to_string(),
        recorded_at_ms: now_ms,
        expires_at_ms: now_ms + ttl_seconds as f64 * 1000.0,
    };
    let value = serde_json::to_string(&entry)
        .map_err(|err| worker::Error::RustError(format!("channel-affinity index encode: {err}")))?;
    env.kv(AFFINITY_INDEX_KV_BINDING)?
        .put(&affinity_index_key(key), &value)
        .map_err(|err| worker::Error::RustError(format!("channel-affinity KV put: {err}")))?
        .metadata(&entry)
        .map_err(|err| worker::Error::RustError(format!("channel-affinity KV metadata: {err}")))?
        .expiration_ttl(ttl_seconds)
        .execute()
        .await
        .map_err(|err| worker::Error::RustError(format!("channel-affinity KV put: {err}")))
}

async fn list_affinity_index(
    env: &Env,
    cursor: Option<String>,
    scan_limit: usize,
) -> Result<AffinityIndexListing> {
    let scan_limit = scan_limit.clamp(1, AFFINITY_INDEX_SCAN_LIMIT);
    let kv = env.kv(AFFINITY_INDEX_KV_BINDING)?;
    let mut entries = Vec::new();
    let mut malformed_keys = Vec::new();
    let mut malformed = 0;
    let mut scanned = 0;
    let mut next_cursor = cursor;
    let mut truncated = false;

    loop {
        if scanned >= scan_limit {
            truncated = true;
            break;
        }
        let page_limit = (scan_limit - scanned).min(AFFINITY_INDEX_PAGE_LIMIT as usize) as u64;
        let mut request = kv
            .list()
            .prefix(AFFINITY_INDEX_PREFIX.to_string())
            .limit(page_limit);
        if let Some(cursor) = next_cursor.take() {
            request = request.cursor(cursor);
        }
        let response = request
            .execute()
            .await
            .map_err(|err| worker::Error::RustError(format!("channel-affinity KV list: {err}")))?;
        let has_more = !response.list_complete;
        next_cursor = response.cursor;

        for key in response.keys {
            scanned += 1;
            match key.metadata {
                Some(metadata) => match serde_json::from_value::<AffinityIndexEntry>(metadata) {
                    Ok(entry) => entries.push(AffinityIndexedItem {
                        index_key: key.name,
                        entry,
                    }),
                    Err(_) => {
                        malformed += 1;
                        malformed_keys.push(key.name);
                    }
                },
                None => {
                    malformed += 1;
                    malformed_keys.push(key.name);
                }
            }
        }

        if !has_more {
            break;
        }
    }

    Ok(AffinityIndexListing {
        entries,
        malformed,
        malformed_keys,
        scanned,
        truncated,
        cursor: next_cursor,
        scan_limit,
    })
}

fn matches_rule_filter(rule_name: Option<&str>, entry_rule_name: &str) -> bool {
    rule_name
        .map(|rule_name| rule_name == entry_rule_name)
        .unwrap_or(true)
}

fn default_affinity_rule_name() -> String {
    AFFINITY_RULE_NAME.to_string()
}

fn default_affinity_scope() -> String {
    AFFINITY_SCOPE.to_string()
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
    fn affinity_index_key_is_namespaced_and_url_safe() {
        let index_key = affinity_index_key("u:7|m:gpt-4o|g:default");
        assert!(index_key.starts_with(AFFINITY_INDEX_PREFIX));
        let encoded = index_key.trim_start_matches(AFFINITY_INDEX_PREFIX);
        assert!(!encoded.contains('|'));
        assert!(!encoded.contains(':'));
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

    #[test]
    fn rule_filter_matches_only_requested_rule() {
        assert!(matches_rule_filter(None, AFFINITY_RULE_NAME));
        assert!(matches_rule_filter(
            Some(AFFINITY_RULE_NAME),
            AFFINITY_RULE_NAME
        ));
        assert!(!matches_rule_filter(
            Some("custom-go-rule"),
            AFFINITY_RULE_NAME
        ));
    }
}
