//! Default-off, observer-only inventory for Container-owned R2 artifacts.

use serde::Serialize;
use worker::{D1Database, Env, Include};

use crate::container_artifacts::{
    container_r2_inventory_object_contract_valid, ContainerR2InventoryArtifactKind,
};
use crate::d1_repositories::{
    begin_relay_container_r2_inventory_round, claim_relay_container_r2_inventory_run,
    classify_relay_container_r2_inventory_objects, complete_relay_container_r2_inventory_run,
    record_relay_container_r2_inventory_page, relay_container_r2_inventory_schema_ready,
    RelayContainerR2InventoryObject, RelayContainerR2InventoryPageStats,
    RelayContainerR2InventoryRunClaimOutcome, RelayContainerR2InventoryRunLease,
    RelayContainerR2ReferenceState,
};

pub const CONTAINER_R2_ORPHAN_INVENTORY_ENABLED_ENV: &str = "CONTAINER_R2_ORPHAN_INVENTORY_ENABLED";
pub const CONTAINER_R2_ORPHAN_INVENTORY_SCAN_LIMIT_ENV: &str =
    "CONTAINER_R2_ORPHAN_INVENTORY_SCAN_LIMIT";
pub const CONTAINER_R2_ORPHAN_INVENTORY_GRACE_SECONDS_ENV: &str =
    "CONTAINER_R2_ORPHAN_INVENTORY_GRACE_SECONDS";
pub const DEFAULT_CONTAINER_R2_ORPHAN_INVENTORY_SCAN_LIMIT: u32 = 4;
pub const MAX_CONTAINER_R2_ORPHAN_INVENTORY_SCAN_LIMIT: u32 = 8;
pub const DEFAULT_CONTAINER_R2_ORPHAN_INVENTORY_GRACE_SECONDS: i64 = 86_400;
pub const MAX_CONTAINER_R2_ORPHAN_INVENTORY_GRACE_SECONDS: i64 = 604_800;
const CONTAINER_R2_INVENTORY_RUN_LEASE_SECONDS: i64 = 45;
const CONTAINER_R2_INVENTORY_MAX_CURSOR_BYTES: usize = 4_096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ContainerR2InventoryRuntimeConfig {
    pub configured: bool,
    pub valid: bool,
    pub enabled: bool,
    pub scan_limit: u32,
    pub grace_seconds: i64,
}

#[derive(Debug, Clone, Copy)]
struct ContainerR2InventoryLane {
    name: &'static str,
    prefix: &'static str,
}

impl ContainerR2InventoryLane {
    fn artifact_kind(self) -> ContainerR2InventoryArtifactKind {
        match self.name {
            "input" => ContainerR2InventoryArtifactKind::Input,
            "result" => ContainerR2InventoryArtifactKind::Result,
            _ => ContainerR2InventoryArtifactKind::ClientResponse,
        }
    }
}

const CONTAINER_R2_INVENTORY_LANES: [ContainerR2InventoryLane; 3] = [
    ContainerR2InventoryLane {
        name: "input",
        prefix: "container-inputs/v1/",
    },
    ContainerR2InventoryLane {
        name: "result",
        prefix: "container-results/v1/",
    },
    ContainerR2InventoryLane {
        name: "client_response",
        prefix: "container-client-responses/v1/",
    },
];

#[derive(Debug, Clone)]
struct ContainerR2InventoryObservedObject {
    lane_name: &'static str,
    object_key: String,
    object_version: String,
    operation_id: String,
    owner_generation: i64,
    object_sha256: String,
    object_size: i64,
    content_type: String,
    provider_operation_id: String,
    admission_sha256: String,
    response_status: i64,
    headers_sha256: String,
    uploaded_at: i64,
    reference_state: Option<RelayContainerR2ReferenceState>,
}

impl ContainerR2InventoryObservedObject {
    fn repository_object(&self) -> RelayContainerR2InventoryObject<'_> {
        RelayContainerR2InventoryObject {
            lane_name: self.lane_name,
            object_key: &self.object_key,
            object_version: &self.object_version,
            operation_id: &self.operation_id,
            owner_generation: self.owner_generation,
            object_sha256: &self.object_sha256,
            object_size: self.object_size,
            content_type: &self.content_type,
            provider_operation_id: &self.provider_operation_id,
            admission_sha256: &self.admission_sha256,
            response_status: self.response_status,
            headers_sha256: &self.headers_sha256,
            uploaded_at: self.uploaded_at,
            reference_state: self.reference_state,
        }
    }

    fn contract_valid(&self) -> bool {
        !self.operation_id.is_empty() && self.owner_generation > 0 && self.object_sha256.len() == 64
    }
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct ContainerR2InventorySummary {
    pub lanes_acquired: u32,
    pub lanes_skipped: u32,
    pub pages: u32,
    pub rounds_completed: u32,
    pub scanned: u32,
    pub deferred_recent: u32,
    pub referenced: u32,
    pub anomalies: u32,
    pub resolved: u32,
    pub failed: u32,
}

pub fn container_r2_inventory_runtime_config(env: &Env) -> ContainerR2InventoryRuntimeConfig {
    let enabled = runtime_value(env, CONTAINER_R2_ORPHAN_INVENTORY_ENABLED_ENV);
    let scan_limit = runtime_value(env, CONTAINER_R2_ORPHAN_INVENTORY_SCAN_LIMIT_ENV);
    let grace_seconds = runtime_value(env, CONTAINER_R2_ORPHAN_INVENTORY_GRACE_SECONDS_ENV);
    parse_container_r2_inventory_runtime_config(
        enabled.as_deref(),
        scan_limit.as_deref(),
        grace_seconds.as_deref(),
    )
}

pub fn container_r2_inventory_compiled() -> bool {
    CONTAINER_R2_INVENTORY_LANES.len() == 3
        && DEFAULT_CONTAINER_R2_ORPHAN_INVENTORY_SCAN_LIMIT > 0
        && MAX_CONTAINER_R2_ORPHAN_INVENTORY_SCAN_LIMIT <= 8
        && DEFAULT_CONTAINER_R2_ORPHAN_INVENTORY_GRACE_SECONDS == 86_400
        && CONTAINER_R2_INVENTORY_RUN_LEASE_SECONDS > 30
        && CONTAINER_R2_INVENTORY_MAX_CURSOR_BYTES == 4_096
}

pub async fn run_container_r2_orphan_inventory(
    env: &Env,
    db: &D1Database,
    now: i64,
) -> worker::Result<ContainerR2InventorySummary> {
    let config = container_r2_inventory_runtime_config(env);
    if !config.valid || !config.enabled {
        return Err(inventory_error(
            "container R2 orphan inventory runtime is not enabled with a valid configuration",
        ));
    }
    if !relay_container_r2_inventory_schema_ready(db).await? {
        return Err(inventory_error(
            "container R2 orphan inventory schema is unavailable",
        ));
    }
    let bucket = env.bucket("FILE_BUCKET")?;
    let mut summary = ContainerR2InventorySummary::default();
    let mut failed = false;
    for lane in CONTAINER_R2_INVENTORY_LANES {
        match run_container_r2_inventory_lane(&bucket, db, lane, config, now).await {
            Ok(lane_summary) => summary.merge(lane_summary),
            Err(err) => {
                worker::console_error!(
                    "container R2 orphan inventory lane {} failed: {err}",
                    lane.name
                );
                summary.failed = summary.failed.saturating_add(1);
                failed = true;
            }
        }
    }
    if failed {
        Err(inventory_error(
            "one or more container R2 orphan inventory lanes failed",
        ))
    } else {
        Ok(summary)
    }
}

async fn run_container_r2_inventory_lane(
    bucket: &worker::Bucket,
    db: &D1Database,
    lane: ContainerR2InventoryLane,
    config: ContainerR2InventoryRuntimeConfig,
    now: i64,
) -> worker::Result<ContainerR2InventorySummary> {
    let run_owner = random_inventory_owner()?;
    let lease = match claim_relay_container_r2_inventory_run(
        db,
        lane.name,
        &run_owner,
        now,
        CONTAINER_R2_INVENTORY_RUN_LEASE_SECONDS,
    )
    .await?
    {
        RelayContainerR2InventoryRunClaimOutcome::Applied(lease) => lease,
        RelayContainerR2InventoryRunClaimOutcome::AlreadyRunning => {
            return Ok(ContainerR2InventorySummary {
                lanes_skipped: 1,
                ..ContainerR2InventorySummary::default()
            });
        }
        RelayContainerR2InventoryRunClaimOutcome::Conflict => {
            return Err(inventory_error(
                "container R2 orphan inventory run claim conflicted",
            ));
        }
    };
    let result = run_container_r2_inventory_lane_inner(bucket, db, lane, config, now, &lease).await;
    let completed_at = current_unix_seconds();
    let completed = complete_relay_container_r2_inventory_run(
        db,
        &lease,
        completed_at,
        result.is_ok(),
        if result.is_ok() {
            ""
        } else {
            "inventory_failed"
        },
    )
    .await;
    match (result, completed) {
        (Ok(summary), Ok(true)) => Ok(summary),
        (Ok(_), Ok(false)) => Err(inventory_error(
            "container R2 orphan inventory completion lost its fence",
        )),
        (Ok(_), Err(err)) => Err(err),
        (Err(err), _) => Err(err),
    }
}

async fn run_container_r2_inventory_lane_inner(
    bucket: &worker::Bucket,
    db: &D1Database,
    lane: ContainerR2InventoryLane,
    config: ContainerR2InventoryRuntimeConfig,
    now: i64,
    lease: &RelayContainerR2InventoryRunLease,
) -> worker::Result<ContainerR2InventorySummary> {
    if lease.lane_name != lane.name || lease.object_prefix != lane.prefix {
        return Err(inventory_error(
            "container R2 orphan inventory lane identity conflicted",
        ));
    }
    let lease = begin_relay_container_r2_inventory_round(db, lease, now).await?;
    let mut list = bucket
        .list()
        .limit(config.scan_limit)
        .prefix(lane.prefix)
        .include(vec![Include::HttpMetadata, Include::CustomMetadata]);
    if !lease.r2_cursor.is_empty() {
        list = list.cursor(&lease.r2_cursor);
    }
    let listed = list.execute().await?;
    let truncated = listed.truncated();
    let next_cursor = if truncated {
        Some(listed.cursor().filter(|cursor| {
            !cursor.is_empty() && cursor.len() <= CONTAINER_R2_INVENTORY_MAX_CURSOR_BYTES
        }))
        .flatten()
        .ok_or_else(|| inventory_error("truncated R2 inventory page has no valid cursor"))?
    } else {
        String::new()
    };
    let objects = listed.objects();
    if objects.len() > config.scan_limit as usize {
        return Err(inventory_error(
            "R2 inventory page exceeded the configured bound",
        ));
    }
    let grace_cutoff = now.saturating_sub(config.grace_seconds);
    let mut stats = RelayContainerR2InventoryPageStats {
        scanned: i64::try_from(objects.len()).unwrap_or(i64::MAX),
        ..RelayContainerR2InventoryPageStats::default()
    };
    let mut observed = Vec::with_capacity(objects.len());
    for object in objects {
        let uploaded_at = i64::try_from(object.uploaded().as_millis() / 1_000)
            .map_err(|_| inventory_error("R2 inventory object timestamp is out of range"))?;
        if uploaded_at > grace_cutoff {
            stats.deferred = stats.deferred.saturating_add(1);
            continue;
        }
        let object_size = i64::try_from(object.size())
            .map_err(|_| inventory_error("R2 inventory object size is out of range"))?;
        let object_key = object.key();
        let object_version = object.version();
        let content_type = object.http_metadata().content_type.unwrap_or_default();
        if object_key.is_empty()
            || object_key.len() > 1_024
            || object_version.is_empty()
            || object_version.len() > 256
            || uploaded_at <= 0
        {
            return Err(inventory_error(
                "R2 inventory object metadata is outside the durable contract",
            ));
        }
        let parsed = parse_container_r2_object_key(lane, &object_key);
        let contract_valid = parsed.as_ref().is_some_and(|parsed| {
            container_r2_inventory_object_contract_valid(
                &object,
                lane.artifact_kind(),
                &object_key,
                &parsed.operation_id,
                parsed.owner_generation,
                &parsed.object_sha256,
            )
        });
        let contract_metadata = contract_valid
            .then(|| object.custom_metadata().ok())
            .flatten();
        let provider_operation_id = contract_metadata
            .as_ref()
            .and_then(|metadata| metadata.get("provider_operation_id"))
            .cloned()
            .unwrap_or_default();
        let admission_sha256 = contract_metadata
            .as_ref()
            .and_then(|metadata| metadata.get("admission_sha256"))
            .cloned()
            .unwrap_or_default();
        let response_status = contract_metadata
            .as_ref()
            .and_then(|metadata| metadata.get("response_status"))
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or_default();
        let headers_sha256 = contract_metadata
            .as_ref()
            .and_then(|metadata| metadata.get("headers_sha256"))
            .cloned()
            .unwrap_or_default();
        observed.push(ContainerR2InventoryObservedObject {
            lane_name: lane.name,
            object_key,
            object_version,
            operation_id: contract_valid
                .then(|| parsed.as_ref().map(|value| value.operation_id.clone()))
                .flatten()
                .unwrap_or_default(),
            owner_generation: contract_valid
                .then(|| parsed.as_ref().map(|value| value.owner_generation))
                .flatten()
                .unwrap_or_default(),
            object_sha256: contract_valid
                .then(|| parsed.map(|value| value.object_sha256))
                .flatten()
                .unwrap_or_default(),
            object_size,
            content_type,
            provider_operation_id,
            admission_sha256,
            response_status,
            headers_sha256,
            uploaded_at,
            reference_state: None,
        });
    }
    let valid_indices = observed
        .iter()
        .enumerate()
        .filter_map(|(index, object)| object.contract_valid().then_some(index))
        .collect::<Vec<_>>();
    let reference_states = {
        let inputs = valid_indices
            .iter()
            .map(|index| observed[*index].repository_object())
            .collect::<Vec<_>>();
        classify_relay_container_r2_inventory_objects(db, &inputs).await?
    };
    if reference_states.len() != valid_indices.len() {
        return Err(inventory_error(
            "R2 inventory reference classification count conflicted",
        ));
    }
    for (index, state) in valid_indices.into_iter().zip(reference_states) {
        observed[index].reference_state = Some(state);
    }
    for object in &observed {
        match object.reference_state {
            Some(RelayContainerR2ReferenceState::Referenced) => {
                stats.referenced = stats.referenced.saturating_add(1);
            }
            Some(RelayContainerR2ReferenceState::ReferencedOpenFinding) => {
                stats.referenced = stats.referenced.saturating_add(1);
                stats.resolved = stats.resolved.saturating_add(1);
            }
            Some(RelayContainerR2ReferenceState::DeferredActiveOperation) => {
                stats.deferred = stats.deferred.saturating_add(1);
            }
            _ => stats.anomalies = stats.anomalies.saturating_add(1),
        }
    }
    let repository_objects = observed
        .iter()
        .map(ContainerR2InventoryObservedObject::repository_object)
        .collect::<Vec<_>>();
    let record_now = current_unix_seconds();
    if !record_relay_container_r2_inventory_page(
        db,
        &lease,
        &repository_objects,
        truncated.then_some(next_cursor.as_str()),
        stats,
        record_now,
    )
    .await?
    {
        return Err(inventory_error(
            "container R2 orphan inventory page lost its fence",
        ));
    }
    Ok(ContainerR2InventorySummary {
        lanes_acquired: 1,
        pages: 1,
        rounds_completed: u32::from(!truncated),
        scanned: u32::try_from(stats.scanned).unwrap_or(u32::MAX),
        deferred_recent: u32::try_from(stats.deferred).unwrap_or(u32::MAX),
        referenced: u32::try_from(stats.referenced).unwrap_or(u32::MAX),
        anomalies: u32::try_from(stats.anomalies).unwrap_or(u32::MAX),
        resolved: u32::try_from(stats.resolved).unwrap_or(u32::MAX),
        ..ContainerR2InventorySummary::default()
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedContainerR2ObjectKey {
    operation_id: String,
    owner_generation: i64,
    object_sha256: String,
}

fn parse_container_r2_object_key(
    lane: ContainerR2InventoryLane,
    object_key: &str,
) -> Option<ParsedContainerR2ObjectKey> {
    let suffix = object_key.strip_prefix(lane.prefix)?;
    let mut parts = suffix.split('/');
    let operation_id = parts.next()?;
    let generation = parts.next()?;
    let object_sha256 = parts.next()?;
    if parts.next().is_some()
        || operation_id.is_empty()
        || operation_id.len() > 128
        || !operation_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
        || generation.is_empty()
        || !generation.bytes().all(|byte| byte.is_ascii_digit())
        || object_sha256.len() != 64
        || !object_sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return None;
    }
    let owner_generation = generation
        .parse::<i64>()
        .ok()
        .filter(|value| (1..=2_147_483_647).contains(value))?;
    if generation != owner_generation.to_string() {
        return None;
    }
    Some(ParsedContainerR2ObjectKey {
        operation_id: operation_id.to_string(),
        owner_generation,
        object_sha256: object_sha256.to_string(),
    })
}

fn parse_container_r2_inventory_runtime_config(
    enabled: Option<&str>,
    scan_limit: Option<&str>,
    grace_seconds: Option<&str>,
) -> ContainerR2InventoryRuntimeConfig {
    let gate_valid = enabled.is_none() || matches!(enabled, Some("true" | "false"));
    let parsed_scan_limit = scan_limit.and_then(|value| value.trim().parse::<u32>().ok());
    let scan_limit_valid = scan_limit.is_none()
        || parsed_scan_limit.is_some_and(|value| {
            (1..=MAX_CONTAINER_R2_ORPHAN_INVENTORY_SCAN_LIMIT).contains(&value)
        });
    let parsed_grace_seconds = grace_seconds.and_then(|value| value.trim().parse::<i64>().ok());
    let grace_valid = grace_seconds.is_none()
        || parsed_grace_seconds.is_some_and(|value| {
            (0..=MAX_CONTAINER_R2_ORPHAN_INVENTORY_GRACE_SECONDS).contains(&value)
        });
    let valid = gate_valid && scan_limit_valid && grace_valid;
    ContainerR2InventoryRuntimeConfig {
        configured: enabled.is_some() && scan_limit.is_some() && grace_seconds.is_some(),
        valid,
        enabled: enabled == Some("true") && valid,
        scan_limit: if scan_limit_valid {
            parsed_scan_limit.unwrap_or(DEFAULT_CONTAINER_R2_ORPHAN_INVENTORY_SCAN_LIMIT)
        } else {
            DEFAULT_CONTAINER_R2_ORPHAN_INVENTORY_SCAN_LIMIT
        },
        grace_seconds: if grace_valid {
            parsed_grace_seconds.unwrap_or(DEFAULT_CONTAINER_R2_ORPHAN_INVENTORY_GRACE_SECONDS)
        } else {
            DEFAULT_CONTAINER_R2_ORPHAN_INVENTORY_GRACE_SECONDS
        },
    }
}

impl ContainerR2InventorySummary {
    fn merge(&mut self, other: Self) {
        self.lanes_acquired = self.lanes_acquired.saturating_add(other.lanes_acquired);
        self.lanes_skipped = self.lanes_skipped.saturating_add(other.lanes_skipped);
        self.pages = self.pages.saturating_add(other.pages);
        self.rounds_completed = self.rounds_completed.saturating_add(other.rounds_completed);
        self.scanned = self.scanned.saturating_add(other.scanned);
        self.deferred_recent = self.deferred_recent.saturating_add(other.deferred_recent);
        self.referenced = self.referenced.saturating_add(other.referenced);
        self.anomalies = self.anomalies.saturating_add(other.anomalies);
        self.resolved = self.resolved.saturating_add(other.resolved);
        self.failed = self.failed.saturating_add(other.failed);
    }
}

fn random_inventory_owner() -> worker::Result<String> {
    let mut bytes = [0_u8; 16];
    getrandom::getrandom(&mut bytes)
        .map_err(|_| inventory_error("container R2 inventory claim entropy is unavailable"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn current_unix_seconds() -> i64 {
    i64::try_from(worker::Date::now().as_millis() / 1_000).unwrap_or(i64::MAX)
}

fn runtime_value(env: &Env, name: &str) -> Option<String> {
    env.var(name)
        .ok()
        .map(|value| value.to_string())
        .filter(|value| !value.trim().is_empty())
}

fn inventory_error(message: &str) -> worker::Error {
    worker::Error::RustError(message.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inventory_runtime_is_default_off_strict_and_bounded() {
        let defaults = parse_container_r2_inventory_runtime_config(None, None, None);
        assert!(!defaults.configured);
        assert!(defaults.valid);
        assert!(!defaults.enabled);
        assert_eq!(defaults.scan_limit, 4);
        assert_eq!(defaults.grace_seconds, 86_400);

        let enabled =
            parse_container_r2_inventory_runtime_config(Some("true"), Some("8"), Some("0"));
        assert!(enabled.configured);
        assert!(enabled.valid);
        assert!(enabled.enabled);
        assert_eq!(enabled.scan_limit, 8);
        assert_eq!(enabled.grace_seconds, 0);

        for invalid in [
            parse_container_r2_inventory_runtime_config(Some("TRUE"), Some("8"), Some("3600")),
            parse_container_r2_inventory_runtime_config(Some("true"), Some("0"), Some("3600")),
            parse_container_r2_inventory_runtime_config(Some("true"), Some("9"), Some("3600")),
            parse_container_r2_inventory_runtime_config(Some("true"), Some("8"), Some("-1")),
        ] {
            assert!(!invalid.valid);
            assert!(!invalid.enabled);
        }
    }

    #[test]
    fn inventory_object_keys_are_lane_bound_and_canonical() {
        let lane = CONTAINER_R2_INVENTORY_LANES[0];
        let digest = "a".repeat(64);
        let key = format!("{}operation-1/2/{digest}", lane.prefix);
        let parsed = parse_container_r2_object_key(lane, &key).unwrap();
        assert_eq!(parsed.operation_id, "operation-1");
        assert_eq!(parsed.owner_generation, 2);
        assert_eq!(parsed.object_sha256, digest);

        for invalid in [
            format!("container-results/v1/operation-1/2/{digest}"),
            format!("{}operation-1/02/{digest}", lane.prefix),
            format!("{}operation/1/2/{digest}", lane.prefix),
            format!("{}operation-1/2/{}", lane.prefix, "A".repeat(64)),
            format!("{}operation-1/2/{digest}/extra", lane.prefix),
        ] {
            assert_eq!(parse_container_r2_object_key(lane, &invalid), None);
        }
    }

    #[test]
    fn inventory_uses_one_bounded_binding_page_and_never_mutates_r2() {
        let source = include_str!("container_r2_inventory.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        assert!(source.contains("env.bucket(\"FILE_BUCKET\")"));
        assert!(source.contains(".list()"));
        assert!(source.contains(".limit(config.scan_limit)"));
        assert!(source.contains("Include::HttpMetadata"));
        assert!(source.contains("Include::CustomMetadata"));
        assert!(source.contains("listed.truncated()"));
        assert!(source.contains("listed.cursor()"));
        assert!(!source.contains("bucket.delete"));
        assert!(!source.contains("bucket.put"));
        assert!(!source.contains("bucket.get"));
        assert!(!source.contains("CONTAINER_CONTROLLER"));
        assert!(!source.contains("dispatch_operation("));
        assert!(container_r2_inventory_compiled());
    }
}
