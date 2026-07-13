use cinatoken_core::format_matching_model_name;
use cinatoken_relay::{channel_type_supported, clamp_i64_to_i32 as d1_i32, csv_contains};
use cinatoken_storage::{AuditLogEvent, AuthenticatedToken, RelayAuditLog, RelayChannel};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use worker::{D1Database, D1Result, D1Type};

pub(crate) const BILLING_MODE_OPTION_KEY: &str = "billing_setting.billing_mode";
pub(crate) const BILLING_EXPR_OPTION_KEY: &str = "billing_setting.billing_expr";
pub(crate) const GROUP_RATIO_OPTION_KEY: &str = "group_ratio_setting.group_ratio";
pub(crate) const LEGACY_GROUP_RATIO_OPTION_KEY: &str = "GroupRatio";
pub(crate) const GROUP_GROUP_RATIO_OPTION_KEY: &str = "group_ratio_setting.group_group_ratio";
pub(crate) const LEGACY_GROUP_GROUP_RATIO_OPTION_KEY: &str = "GroupGroupRatio";
const BILLING_MODE_TIERED_EXPR: &str = "tiered_expr";
pub(crate) const REALTIME_BILLING_ORPHAN_RECOVERY_GRACE_SECONDS: i64 = 300;
pub(crate) const REALTIME_BILLING_GLOBAL_RECOVERY_MIGRATION: &str =
    "0022_realtime_billing_global_recovery.sql";
pub(crate) const RELAY_BILLING_RESERVATION_MIGRATION: &str = "0023_relay_billing_reservations.sql";
pub(crate) const RELAY_BILLING_ORPHAN_RECOVERY_GRACE_SECONDS: i64 = 300;
const RELAY_BILLING_ORPHAN_SWEEP_MAX_LIMIT: i64 = 64;
const RELAY_BILLING_ORPHAN_RETRY_INITIAL_SECONDS: i64 = 60;
const RELAY_BILLING_ORPHAN_RETRY_MAX_SECONDS: i64 = 3_600;
const REALTIME_BILLING_ORPHAN_SWEEP_MAX_LIMIT: i64 = 64;
const REALTIME_BILLING_ORPHAN_RETRY_INITIAL_SECONDS: i64 = 60;
const REALTIME_BILLING_ORPHAN_RETRY_MAX_SECONDS: i64 = 3_600;

#[derive(Debug, Clone, Copy)]
pub struct RelayBillingReservationRecord<'a> {
    pub reservation_key: &'a str,
    pub user_id: i64,
    pub token_id: i64,
    pub model_name: &'a str,
    pub endpoint_path: &'a str,
    pub request_id_hash: &'a str,
    pub expr_hash: &'a str,
    pub candidate_group_count: i64,
    pub reservation_strategy: &'a str,
    pub pre_consumed_quota: i64,
    pub created_at: i64,
    pub lease_expires_at: i64,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct RelayBillingReservation {
    pub reservation_key: String,
    pub user_id: i64,
    pub token_id: i64,
    pub model_name: String,
    pub endpoint_path: String,
    pub request_id_hash: String,
    pub expr_hash: String,
    pub candidate_group_count: i64,
    pub reservation_strategy: String,
    pub pre_consumed_quota: i64,
    pub status: String,
    pub channel_id: i64,
    pub selected_group: String,
    pub selected_at: i64,
    pub final_quota: i64,
    pub finalization_reason: String,
    pub request_accounted: i64,
    pub lease_expires_at: i64,
    pub recovery_attempt_count: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelayBillingReservationWriteOutcome {
    Applied,
    Duplicate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelayBillingReservationFinalizationOutcome {
    Applied,
    MatchingSettled,
    MatchingRefund,
    SettlementWon,
    RefundWon,
    Conflict,
    NotFound,
    LeaseActive,
    DeadlineExpired,
    RecoveryRequired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelayBillingRequestAccounting {
    Skip,
    Account,
}

impl RelayBillingRequestAccounting {
    fn value(self) -> i32 {
        match self {
            Self::Skip => 0,
            Self::Account => 1,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelayBillingSelectionOutcome {
    Applied,
    MatchingSelection,
    AlreadyFinalized,
    Conflict,
    NotFound,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct RelayBillingExpiredLeaseCandidate {
    pub reservation_key: String,
    pub channel_id: i64,
    pub selected_group: String,
    pub selected_at: i64,
    pub lease_expires_at: i64,
    pub recovery_attempt_count: i64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RelayBillingOrphanSweepSummary {
    pub candidates: u32,
    pub refunded: u32,
    pub recovery_required: u32,
    pub already_finalized: u32,
    pub lease_active: u32,
    pub not_found: u32,
    pub failed: u32,
    pub deferred: u32,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct RelayBillingLedgerStatusRow {
    pub reservation_key: String,
    pub user_id: i64,
    pub token_id: i64,
    pub status: String,
    pub channel_id: i64,
    pub selected_at: i64,
    pub request_accounted: i64,
    pub lease_expires_at: i64,
    pub updated_at: i64,
    pub settled_at: i64,
    pub refunded_at: i64,
    pub recovery_required_at: i64,
    pub recovery_attempt_count: i64,
    pub recovery_next_attempt_at: i64,
    pub recovery_last_attempt_at: i64,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct RelayBillingRecoveryStateRow {
    pub last_started_at: i64,
    pub last_completed_at: i64,
    pub last_success_at: i64,
    pub last_candidates: i64,
    pub last_refunded: i64,
    pub last_recovery_required: i64,
    pub last_failed: i64,
    pub last_deferred: i64,
}

fn relay_billing_settlement_deadline_allows(lease_expires_at: i64, applied_at: i64) -> bool {
    lease_expires_at > 0
        && applied_at
            <= lease_expires_at.saturating_add(RELAY_BILLING_ORPHAN_RECOVERY_GRACE_SECONDS)
}

fn realtime_billing_settlement_deadline_allows(lease_expires_at: i64, applied_at: i64) -> bool {
    lease_expires_at > 0
        && applied_at
            <= lease_expires_at.saturating_add(REALTIME_BILLING_ORPHAN_RECOVERY_GRACE_SECONDS)
}
// Auto cross-group selection settings (Go option keys, see model/option.go).
const AUTO_GROUPS_OPTION_KEY: &str = "AutoGroups";
const USER_USABLE_GROUPS_OPTION_KEY: &str = "UserUsableGroups";
const GROUP_SPECIAL_USABLE_GROUP_OPTION_KEY: &str =
    "group_ratio_setting.group_special_usable_group";
const DEFAULT_USER_USABLE_GROUPS: &[(&str, &str)] = &[("default", "默认分组"), ("vip", "vip分组")];

#[derive(Debug, Deserialize)]
struct OptionValueRow {
    value: String,
}

#[derive(Debug, Deserialize)]
struct QuotaStateRow {
    token_status: i32,
    expired_time: i64,
    remain_quota: i64,
    unlimited_quota: i32,
    user_status: i32,
    user_quota: i64,
}

#[derive(Debug, Clone, Copy)]
pub struct RealtimeBillingReservationRecord<'a> {
    pub reservation_key: &'a str,
    pub session: &'a str,
    pub bridge_segment: &'a str,
    pub client_event_id_hash: &'a str,
    pub reservation_sequence: i64,
    pub user_id: i64,
    pub token_id: i64,
    pub channel_id: i64,
    pub selected_group: &'a str,
    pub model_name: &'a str,
    pub pre_consumed_quota: i64,
    pub snapshot_json: &'a str,
    pub request_json: &'a str,
    pub username: &'a str,
    pub token_name: &'a str,
    pub client_ip: &'a str,
    pub request_id: &'a str,
    pub started_at: i64,
    pub endpoint_path: &'a str,
    pub created_at: i64,
    pub lease_expires_at: i64,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct RealtimeBillingReservation {
    pub reservation_key: String,
    pub session: String,
    pub bridge_segment: String,
    pub client_event_id_hash: String,
    pub reservation_sequence: i64,
    pub user_id: i64,
    pub token_id: i64,
    pub channel_id: i64,
    pub selected_group: String,
    pub model_name: String,
    pub pre_consumed_quota: i64,
    pub snapshot_json: String,
    pub request_json: String,
    pub username: String,
    pub token_name: String,
    pub client_ip: String,
    pub request_id: String,
    pub started_at: i64,
    pub endpoint_path: String,
    pub status: String,
    pub upstream_response_id_hash: String,
    pub replay_key: String,
    pub final_quota: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub lease_expires_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RealtimeBillingReservationWriteOutcome {
    Applied,
    Duplicate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RealtimeBillingReservationLeaseIdentity {
    pub reservation_sequence: i64,
    pub lease_expires_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RealtimeBillingReservationRefundOutcome {
    Applied,
    AlreadyFinalized,
    NotFound,
    LeaseActive {
        reservation_sequence: i64,
        lease_expires_at: i64,
    },
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct RealtimeBillingExpiredLeaseCandidate {
    pub reservation_key: String,
    pub reservation_sequence: i64,
    pub lease_expires_at: i64,
    pub recovery_attempt_count: i64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RealtimeBillingOrphanSweepSummary {
    pub candidates: u32,
    pub refunded: u32,
    pub already_finalized: u32,
    pub lease_active: u32,
    pub not_found: u32,
    pub failed: u32,
    pub deferred: u32,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct RealtimeBillingLedgerStatusRow {
    pub reservation_key: String,
    pub session: String,
    pub bridge_segment: String,
    pub status: String,
    pub reservation_sequence: i64,
    pub lease_expires_at: i64,
    pub updated_at: i64,
    pub settled_at: i64,
    pub refunded_at: i64,
    pub recovery_attempt_count: i64,
    pub recovery_next_attempt_at: i64,
    pub recovery_last_attempt_at: i64,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct RealtimeBillingRecoveryStateRow {
    pub last_started_at: i64,
    pub last_completed_at: i64,
    pub last_success_at: i64,
    pub last_candidates: i64,
    pub last_refunded: i64,
    pub last_failed: i64,
    pub last_deferred: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RealtimeBillingResponseBindOutcome {
    Applied,
    Duplicate,
    NotFound,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RealtimeSettlementReplayRecord<'a> {
    pub replay_key: &'a str,
    pub session: &'a str,
    pub user_id: i64,
    pub token_id: i64,
    pub channel_id: i64,
    pub model_name: &'a str,
    pub pre_consumed_quota: i64,
    pub final_quota: i64,
    pub created_at: i64,
    pub applied_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RealtimeSettlementBatchOutcome {
    Applied,
    DuplicateReplay,
}

#[derive(Debug, Deserialize)]
struct RealtimeSettlementReplayCountRow {
    count: i64,
}

pub async fn authenticate_token(
    db: &D1Database,
    api_key: &str,
) -> worker::Result<Option<AuthenticatedToken>> {
    let stmt = db.prepare(
        r#"
        SELECT
          t.id AS token_id,
          t.user_id AS user_id,
          t.name AS token_name,
          t.status AS token_status,
          t.expired_time AS expired_time,
          t.remain_quota AS remain_quota,
          t.unlimited_quota AS unlimited_quota,
          t.model_limits_enabled AS model_limits_enabled,
          t.model_limits AS model_limits,
          t.allow_ips AS allow_ips,
          t."group" AS token_group,
          t.cross_group_retry AS cross_group_retry,
          u.username AS username,
          u.status AS user_status,
          u.quota AS user_quota,
          u."group" AS user_group
        FROM tokens t
        JOIN users u ON u.id = t.user_id
        WHERE t."key" = ?1
          AND t.deleted_at IS NULL
          AND u.deleted_at IS NULL
        LIMIT 1
        "#,
    );
    let key_arg = D1Type::Text(api_key);
    stmt.bind_refs(&key_arg)?
        .first::<AuthenticatedToken>(None)
        .await
}

pub async fn refresh_authenticated_token_quota_state(
    db: &D1Database,
    auth: &mut AuthenticatedToken,
) -> worker::Result<bool> {
    let args = [
        D1Type::Integer(d1_i32(auth.token_id)),
        D1Type::Integer(d1_i32(auth.user_id)),
    ];
    let row = db
        .prepare(
            r#"
            SELECT
              t.status AS token_status,
              t.expired_time AS expired_time,
              t.remain_quota AS remain_quota,
              t.unlimited_quota AS unlimited_quota,
              u.status AS user_status,
              u.quota AS user_quota
            FROM tokens t
            JOIN users u ON u.id = t.user_id
            WHERE t.id = ?1
              AND u.id = ?2
              AND t.deleted_at IS NULL
              AND u.deleted_at IS NULL
            LIMIT 1
            "#,
        )
        .bind_refs(&args)?
        .first::<QuotaStateRow>(None)
        .await?;
    let Some(row) = row else {
        return Ok(false);
    };

    auth.token_status = row.token_status;
    auth.expired_time = row.expired_time;
    auth.remain_quota = row.remain_quota;
    auth.unlimited_quota = row.unlimited_quota;
    auth.user_status = row.user_status;
    auth.user_quota = row.user_quota;
    Ok(true)
}

pub async fn mark_token_status(
    db: &D1Database,
    token_id: i64,
    status: i32,
    accessed_time: i64,
) -> worker::Result<()> {
    let args = [
        D1Type::Integer(status),
        D1Type::Integer(d1_i32(accessed_time)),
        D1Type::Integer(d1_i32(token_id)),
    ];
    db.prepare("UPDATE tokens SET status = ?1, accessed_time = ?2 WHERE id = ?3")
        .bind_refs(&args)?
        .run()
        .await?;
    Ok(())
}

/// Return relay channel candidates for the given model/group, ordered the same
/// way the Go gateway orders them: by descending ability priority, then
/// descending ability weight, then descending channel priority, then ascending
/// channel id. Abilities-backed candidates come first; channels that match the
/// requested model only through the `channels.models` CSV (and therefore have
/// no ability row) are appended afterwards.
///
/// The returned vector preserves the order in which retry attempts should be
/// made. Callers should iterate and apply their own retry/auto-ban policy.
pub async fn select_relay_channels(
    db: &D1Database,
    model: &str,
    group: &str,
    supported_channel_types: &[i32],
) -> worker::Result<Vec<RelayChannel>> {
    let mut candidates =
        select_channels_from_abilities(db, model, group, supported_channel_types).await?;
    // Go `GetRandomSatisfiedChannel` (model/channel_cache.go:107-113) tries the
    // exact requested model first, then falls back to the NORMALIZED model —
    // this is how thinking-budget / gizmo models route: a request for
    // `gemini-2.5-flash-thinking-8192` has no exact ability row, but the
    // normalized `gemini-2.5-flash-thinking-*` wildcard matches the ability
    // seeded for the wildcard. Only re-query when normalization actually
    // changed the name, so the common exact-match path stays one round-trip.
    if candidates.is_empty() {
        if let Some(normalized) = normalized_fallback_model(model) {
            candidates =
                select_channels_from_abilities(db, &normalized, group, supported_channel_types)
                    .await?;
        }
    }
    if candidates.is_empty() {
        // Only fall back to the channel-CSV scan when abilities had nothing
        // for this group/model (exact or normalized), mirroring the historical
        // single-select path. NOTE: Go also normalizes in channel_satisfy.go
        // for this scan, but it only runs when abilities are entirely empty,
        // so the gap is negligible here.
        candidates =
            select_channels_from_channel_csv(db, model, group, supported_channel_types).await?;
    }
    Ok(candidates
        .into_iter()
        .filter(|channel| channel_type_supported(channel.channel_type, supported_channel_types))
        .collect())
}

/// Return one enabled relay channel by id for origin-task-locked task submits
/// (for example OpenAI video remix). The shape matches [`RelayChannel`] so the
/// submit path can reuse the same provider dispatch as regular selection.
pub async fn find_enabled_relay_channel_by_id(
    db: &D1Database,
    channel_id: i64,
) -> worker::Result<Option<RelayChannel>> {
    let arg = D1Type::Integer(d1_i32(channel_id));
    db.prepare(
        r#"
        SELECT
          id,
          type AS channel_type,
          "key",
          name,
          base_url,
          models,
          "group" AS channel_group,
          model_mapping,
          openai_organization,
          other,
          other_info,
          COALESCE(priority, 0) AS priority,
          COALESCE(weight, 0) AS weight
        FROM channels
        WHERE id = ?1
          AND status = 1
        LIMIT 1
        "#,
    )
    .bind_refs(&[arg])?
    .first::<RelayChannel>(None)
    .await
}

/// The normalized model name to retry when an exact ability match misses, or
/// `None` when normalization would not change the name (so there is nothing to
/// retry). Mirrors Go's `normalizedModel := FormatMatchingModelName(model)`
/// fallback condition. Pure so the routing logic is unit-testable without a D1.
fn normalized_fallback_model(model: &str) -> Option<String> {
    let normalized = format_matching_model_name(model);
    if normalized == model {
        None
    } else {
        Some(normalized)
    }
}

/// Best-effort automatic channel disable. Used by the relay retry loop when a
/// channel returns a status code in the auto-disable set (default: 401) or
/// exceeds the Redis error counter threshold. Failures are logged but never
/// propagated, because the request must still complete for the customer.
pub async fn disable_channel_best_effort(
    db: &D1Database,
    channel_id: i64,
    reason: &str,
) -> worker::Result<()> {
    let args = [D1Type::Integer(d1_i32(channel_id)), D1Type::Text(reason)];
    db.prepare(
        r#"
        UPDATE channels
        SET status = 2,
            other_info = CASE
                WHEN other_info = '' OR other_info = '{}' THEN ?
                ELSE other_info
            END
        WHERE id = ?
        "#,
    )
    .bind_refs(&args)?
    .run()
    .await
    .map(|_| ())
    .or_else(|err| {
        worker::console_error!("failed to auto-disable channel {channel_id} ({reason}): {err}",);
        Ok(())
    })
}

async fn select_channels_from_abilities(
    db: &D1Database,
    model: &str,
    group: &str,
    supported_channel_types: &[i32],
) -> worker::Result<Vec<RelayChannel>> {
    let group_arg = D1Type::Text(group);
    let model_arg = D1Type::Text(model);
    let args = [group_arg, model_arg];
    let channel_type_filter = channel_type_filter_sql(supported_channel_types)?;
    let rows = db
        .prepare(&format!(
            r#"
            SELECT
              c.id,
              c.type AS channel_type,
              c."key",
              c.name,
              c.base_url,
              c.models,
              c."group" AS channel_group,
              c.model_mapping,
              c.openai_organization,
              c.other,
              c.other_info,
              COALESCE(a.priority, 0) AS priority,
              COALESCE(a.weight, 0) AS weight
            FROM abilities a
            JOIN channels c ON c.id = a.channel_id
            WHERE a.group_name = ?1
              AND a.model = ?2
              AND a.enabled = 1
              AND c.status = 1
              AND c.type IN ({channel_type_filter})
            ORDER BY a.priority DESC, a.weight DESC, c.priority DESC, c.id ASC
            LIMIT 50
            "#
        ))
        .bind_refs(&args)?
        .all()
        .await?
        .results::<RelayChannel>()?;

    Ok(rows)
}

async fn select_channels_from_channel_csv(
    db: &D1Database,
    model: &str,
    group: &str,
    supported_channel_types: &[i32],
) -> worker::Result<Vec<RelayChannel>> {
    let channel_type_filter = channel_type_filter_sql(supported_channel_types)?;
    let rows = db
        .prepare(&format!(
            r#"
            SELECT
              id,
              type AS channel_type,
              "key",
              name,
              base_url,
              models,
              "group" AS channel_group,
              model_mapping,
              openai_organization,
              other,
              other_info,
              COALESCE(priority, 0) AS priority,
              COALESCE(weight, 0) AS weight
            FROM channels
            WHERE status = 1
              AND type IN ({channel_type_filter})
            ORDER BY priority DESC, id ASC
            LIMIT 50
            "#
        ))
        .all()
        .await?
        .results::<RelayChannel>()?;

    Ok(rows
        .into_iter()
        .filter(|channel| {
            csv_contains(&channel.channel_group, group)
                && (channel.models.trim().is_empty() || csv_contains(&channel.models, model))
        })
        .collect())
}

fn channel_type_filter_sql(supported_channel_types: &[i32]) -> worker::Result<String> {
    if supported_channel_types.is_empty() {
        return Err(worker::Error::RustError(
            "supported channel type list cannot be empty".to_string(),
        ));
    }
    Ok(supported_channel_types
        .iter()
        .map(i32::to_string)
        .collect::<Vec<_>>()
        .join(", "))
}

pub async fn touch_token(db: &D1Database, token_id: i64, accessed_time: i64) -> worker::Result<()> {
    let args = [
        D1Type::Integer(d1_i32(accessed_time)),
        D1Type::Integer(d1_i32(token_id)),
    ];
    db.prepare("UPDATE tokens SET accessed_time = ?1 WHERE id = ?2")
        .bind_refs(&args)?
        .run()
        .await?;
    Ok(())
}

pub async fn increment_user_request_count(db: &D1Database, user_id: i64) -> worker::Result<()> {
    increment_user_request_count_statement(db, user_id)?
        .run()
        .await?;
    Ok(())
}

pub async fn insert_audit_log_event(db: &D1Database, event: &AuditLogEvent) -> worker::Result<()> {
    let args = [
        D1Type::Integer(d1_i32(event.user_id)),
        D1Type::Integer(d1_i32(event.created_at)),
        D1Type::Integer(event.log_type),
        D1Type::Text(&event.content),
        D1Type::Text(&event.username),
        D1Type::Text(&event.token_name),
        D1Type::Text(&event.model_name),
        D1Type::Integer(d1_i32(event.quota)),
        D1Type::Integer(event.prompt_tokens),
        D1Type::Integer(event.completion_tokens),
        D1Type::Integer(d1_i32(event.use_time)),
        D1Type::Integer(event.is_stream),
        D1Type::Integer(d1_i32(event.channel_id)),
        D1Type::Integer(d1_i32(event.token_id)),
        D1Type::Text(&event.group),
        D1Type::Text(&event.ip),
        D1Type::Text(&event.request_id),
        D1Type::Text(&event.upstream_request_id),
        D1Type::Text(&event.other),
    ];
    let sql = if event.terminal_relay_attempt_audit_id().is_some() {
        r#"
        INSERT INTO logs (
          user_id, created_at, type, content, username, token_name, model_name,
          quota, prompt_tokens, completion_tokens, use_time, is_stream,
          channel_id, token_id, "group", ip, request_id, upstream_request_id, other
        )
        SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19
        WHERE NOT EXISTS (
          SELECT 1 FROM logs WHERE type = ?3 AND other = ?19
        )
        "#
    } else {
        r#"
        INSERT INTO logs (
          user_id, created_at, type, content, username, token_name, model_name,
          quota, prompt_tokens, completion_tokens, use_time, is_stream,
          channel_id, token_id, "group", ip, request_id, upstream_request_id, other
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19
        )
        "#
    };
    db.prepare(sql).bind_refs(&args)?.run().await?;
    Ok(())
}

fn insert_relay_audit_log_statement(
    db: &D1Database,
    created_at: i64,
    content: &str,
    audit_log: &RelayAuditLog<'_>,
) -> worker::Result<worker::D1PreparedStatement> {
    let log_args = [
        D1Type::Integer(d1_i32(audit_log.user_id)),
        D1Type::Integer(d1_i32(created_at)),
        D1Type::Integer(2),
        D1Type::Text(content),
        D1Type::Text(audit_log.username),
        D1Type::Text(audit_log.token_name),
        D1Type::Text(audit_log.model),
        D1Type::Integer(d1_i32(audit_log.quota)),
        D1Type::Integer(audit_log.prompt_tokens),
        D1Type::Integer(audit_log.completion_tokens),
        D1Type::Integer(d1_i32(audit_log.use_time_seconds)),
        D1Type::Integer(i32::from(audit_log.is_stream)),
        D1Type::Integer(d1_i32(audit_log.channel_id)),
        D1Type::Integer(d1_i32(audit_log.token_id)),
        D1Type::Text(audit_log.group),
        D1Type::Text(audit_log.ip),
        D1Type::Text(audit_log.request_id),
        D1Type::Text(audit_log.upstream_request_id),
        D1Type::Text(audit_log.other),
    ];
    db.prepare(
        r#"
        INSERT INTO logs (
          user_id, created_at, type, content, username, token_name, model_name,
          quota, prompt_tokens, completion_tokens, use_time, is_stream,
          channel_id, token_id, "group", ip, request_id, upstream_request_id, other
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19
        )
        "#,
    )
    .bind_refs(&log_args)
}

pub async fn apply_relay_quota_usage(
    db: &D1Database,
    user_id: i64,
    token_id: i64,
    channel_id: i64,
    quota: i64,
    accessed_time: i64,
) -> worker::Result<()> {
    let quota = quota_i32(quota)?;
    debit_user_quota_usage_and_request_count(db, user_id, quota).await?;
    if token_id > 0 {
        if let Err(err) = debit_token_quota_usage(db, token_id, quota, accessed_time).await {
            if let Err(compensate_err) =
                credit_user_quota_usage_and_request_count(db, user_id, quota).await
            {
                worker::console_error!(
                    "failed to compensate user quota after token quota debit failure: {}",
                    compensate_err
                );
            }
            return Err(err);
        }
    }
    if let Err(err) = increment_channel_used_quota(db, channel_id, quota).await {
        if token_id > 0 {
            if let Err(compensate_err) =
                credit_token_quota_usage(db, token_id, quota, accessed_time).await
            {
                worker::console_error!(
                    "failed to compensate token quota after channel quota update failure: {}",
                    compensate_err
                );
            }
        }
        if let Err(compensate_err) =
            credit_user_quota_usage_and_request_count(db, user_id, quota).await
        {
            worker::console_error!(
                "failed to compensate user quota after channel quota update failure: {}",
                compensate_err
            );
        }
        return Err(err);
    }
    Ok(())
}

pub async fn reserve_relay_quota(
    db: &D1Database,
    user_id: i64,
    token_id: i64,
    quota: i64,
    accessed_time: i64,
) -> worker::Result<()> {
    let quota = quota_i32(quota)?;
    if quota == 0 {
        if token_id > 0 {
            touch_token(db, token_id, accessed_time).await?;
        }
        return Ok(());
    }

    if token_id <= 0 {
        let result = reserve_user_quota_statement(db, user_id, quota)?
            .run()
            .await?;
        return require_one_change(result, "user quota is not enough");
    }

    let results = db
        .batch(vec![
            reserve_user_quota_statement(db, user_id, quota)?,
            debit_token_quota_usage_statement(db, token_id, quota, accessed_time)?,
        ])
        .await?;
    // The user and token debits have independent guards (`quota >= ?` /
    // `remain_quota >= ?`). A D1 batch is atomic only on SQL error, and a
    // guarded UPDATE that matches 0 rows is NOT an error, so when exactly one
    // guard fails the batch still commits the other debit. Without
    // compensation that committed debit is leaked: a token with
    // `0 < remain_quota < estimate` passes the `remain_quota <= 0` auth gate,
    // then the user account is debited here while the request is rejected.
    // Refund the committed side before returning the rejection so a rejected
    // request never costs the user (or token) quota.
    let user_reserved = batch_changed(&results, 0)?;
    let token_reserved = batch_changed(&results, 1)?;
    match (user_reserved, token_reserved) {
        (true, true) => Ok(()),
        (true, false) => {
            credit_user_quota_statement(db, user_id, quota)?
                .run()
                .await?;
            Err(worker::Error::RustError(
                "token quota is not enough".to_string(),
            ))
        }
        (false, true) => {
            credit_token_quota_usage_statement(db, token_id, quota, accessed_time)?
                .run()
                .await?;
            Err(worker::Error::RustError(
                "user quota is not enough".to_string(),
            ))
        }
        (false, false) => Err(worker::Error::RustError(
            "user quota is not enough".to_string(),
        )),
    }
}

pub async fn refund_reserved_relay_quota(
    db: &D1Database,
    user_id: i64,
    token_id: i64,
    quota: i64,
    accessed_time: i64,
) -> worker::Result<()> {
    let quota = quota_i32(quota)?;
    if quota == 0 {
        if token_id > 0 {
            touch_token(db, token_id, accessed_time).await?;
        }
        return Ok(());
    }

    if token_id <= 0 {
        let result = credit_user_quota_statement(db, user_id, quota)?
            .run()
            .await?;
        return require_one_change(result, "user no longer exists");
    }

    let results = db
        .batch(vec![
            credit_user_quota_statement(db, user_id, quota)?,
            credit_token_quota_usage_statement(db, token_id, quota, accessed_time)?,
        ])
        .await?;
    require_batch_change(&results, 0, "user no longer exists")?;
    require_batch_change(&results, 1, "token no longer exists")
}

pub async fn reserve_relay_billing_quota(
    db: &D1Database,
    record: RelayBillingReservationRecord<'_>,
) -> worker::Result<RelayBillingReservationWriteOutcome> {
    let reservation_key = non_empty_relay_reservation_field(record.reservation_key, "key")?;
    let model_name = non_empty_relay_reservation_field(record.model_name, "model name")?;
    let reservation_strategy =
        non_empty_relay_reservation_field(record.reservation_strategy, "strategy")?;
    if record.user_id <= 0
        || record.token_id < 0
        || record.candidate_group_count <= 0
        || record.lease_expires_at <= record.created_at
    {
        return Err(worker::Error::RustError(
            "relay billing reservation identity is invalid".to_string(),
        ));
    }
    let quota = quota_i32(record.pre_consumed_quota)?;
    let args = [
        D1Type::Text(reservation_key),
        D1Type::Integer(d1_i32(record.user_id)),
        D1Type::Integer(d1_i32(record.token_id)),
        D1Type::Text(model_name),
        D1Type::Text(record.endpoint_path.trim()),
        D1Type::Text(record.request_id_hash.trim()),
        D1Type::Text(record.expr_hash.trim()),
        D1Type::Integer(d1_i32(record.candidate_group_count)),
        D1Type::Text(reservation_strategy),
        D1Type::Integer(quota),
        D1Type::Integer(d1_i32(record.created_at)),
        D1Type::Integer(d1_i32(record.lease_expires_at)),
    ];
    let insert = db
        .prepare(
            r#"
            INSERT INTO relay_billing_reservations (
              reservation_key, user_id, token_id, model_name, endpoint_path, request_id_hash,
              expr_hash, candidate_group_count, reservation_strategy,
              pre_consumed_quota, status, created_at, updated_at, lease_expires_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'reserved', ?11, ?11, ?12)
            "#,
        )
        .bind_refs(&args)?;

    let mut statements = vec![insert];
    let mut checked = vec![(0usize, "relay billing reservation marker failed")];
    push_relay_reservation_guarded_statement(
        db,
        &mut statements,
        &mut checked,
        reserve_user_quota_statement(db, record.user_id, quota)?,
        reservation_key,
        "user quota is not enough",
    )?;
    if record.token_id > 0 {
        push_relay_reservation_guarded_statement(
            db,
            &mut statements,
            &mut checked,
            debit_token_quota_usage_statement(db, record.token_id, quota, record.created_at)?,
            reservation_key,
            "token quota is not enough",
        )?;
    }

    let results = match db.batch(statements).await {
        Ok(results) => results,
        Err(err) => {
            if relay_billing_reservation(db, reservation_key)
                .await
                .ok()
                .flatten()
                .is_some()
            {
                return Ok(RelayBillingReservationWriteOutcome::Duplicate);
            }
            return Err(err);
        }
    };
    for (index, message) in checked {
        require_batch_change(&results, index, message)?;
    }
    Ok(RelayBillingReservationWriteOutcome::Applied)
}

pub async fn bind_relay_billing_selected_attempt(
    db: &D1Database,
    reservation_key: &str,
    channel_id: i64,
    selected_group: &str,
    selected_at: i64,
    lease_expires_at: i64,
) -> worker::Result<RelayBillingSelectionOutcome> {
    let reservation_key = non_empty_relay_reservation_field(reservation_key, "key")?;
    let selected_group = non_empty_relay_reservation_field(selected_group, "selected group")?;
    if channel_id <= 0 || lease_expires_at <= selected_at {
        return Err(worker::Error::RustError(
            "relay billing selected-attempt identity is invalid".to_string(),
        ));
    }
    let Some(record) = relay_billing_reservation(db, reservation_key).await? else {
        return Ok(RelayBillingSelectionOutcome::NotFound);
    };
    if record.status != "reserved" {
        return Ok(RelayBillingSelectionOutcome::AlreadyFinalized);
    }
    if record.channel_id == channel_id
        && record.selected_group == selected_group
        && record.selected_at > 0
    {
        return Ok(RelayBillingSelectionOutcome::MatchingSelection);
    }
    if record.channel_id != 0 || !record.selected_group.is_empty() || record.selected_at != 0 {
        return Ok(RelayBillingSelectionOutcome::Conflict);
    }
    let args = [
        D1Type::Text(reservation_key),
        D1Type::Integer(d1_i32(channel_id)),
        D1Type::Text(selected_group),
        D1Type::Integer(d1_i32(selected_at)),
        D1Type::Integer(d1_i32(lease_expires_at)),
    ];
    let result = db
        .prepare(
            r#"
            UPDATE relay_billing_reservations
            SET channel_id = ?2, selected_group = ?3, selected_at = ?4,
                lease_expires_at = MAX(lease_expires_at, ?5), updated_at = ?4
            WHERE reservation_key = ?1 AND status = 'reserved'
              AND channel_id = 0 AND selected_group = '' AND selected_at = 0
            "#,
        )
        .bind_refs(&args)?
        .run()
        .await;
    match result {
        Ok(result) if result.meta()?.and_then(|meta| meta.changes).unwrap_or(0) == 1 => {
            Ok(RelayBillingSelectionOutcome::Applied)
        }
        Ok(_) | Err(_) => match relay_billing_reservation(db, reservation_key).await? {
            None => Ok(RelayBillingSelectionOutcome::NotFound),
            Some(current) if current.status != "reserved" => {
                Ok(RelayBillingSelectionOutcome::AlreadyFinalized)
            }
            Some(current)
                if current.channel_id == channel_id
                    && current.selected_group == selected_group
                    && current.selected_at > 0 =>
            {
                Ok(RelayBillingSelectionOutcome::MatchingSelection)
            }
            Some(_) => Ok(RelayBillingSelectionOutcome::Conflict),
        },
    }
}

pub async fn settle_relay_billing_reservation(
    db: &D1Database,
    reservation_key: &str,
    channel_id: i64,
    selected_group: &str,
    final_quota: i64,
    finalization_reason: &str,
    settled_at: i64,
) -> worker::Result<RelayBillingReservationFinalizationOutcome> {
    let reservation_key = non_empty_relay_reservation_field(reservation_key, "key")?;
    let selected_group = non_empty_relay_reservation_field(selected_group, "selected group")?;
    let finalization_reason =
        non_empty_relay_reservation_field(finalization_reason, "finalization reason")?;
    if channel_id <= 0 {
        return Err(worker::Error::RustError(
            "relay billing settlement channel is invalid".to_string(),
        ));
    }
    let Some(record) = relay_billing_reservation(db, reservation_key).await? else {
        return Ok(RelayBillingReservationFinalizationOutcome::NotFound);
    };
    if record.status != "reserved" {
        return Ok(classify_relay_settlement_outcome(
            &record,
            channel_id,
            selected_group,
            final_quota,
            finalization_reason,
        ));
    }
    if record.channel_id != channel_id || record.selected_group != selected_group {
        return Ok(RelayBillingReservationFinalizationOutcome::Conflict);
    }
    if !relay_billing_settlement_deadline_allows(record.lease_expires_at, settled_at) {
        return Ok(RelayBillingReservationFinalizationOutcome::DeadlineExpired);
    }
    let pre_consumed_quota = quota_i32(record.pre_consumed_quota)?;
    let final_quota = quota_i32(final_quota)?;
    let delta = final_quota.saturating_sub(pre_consumed_quota);
    let args = [
        D1Type::Text(reservation_key),
        D1Type::Integer(d1_i32(channel_id)),
        D1Type::Text(selected_group),
        D1Type::Integer(final_quota),
        D1Type::Text(finalization_reason),
        D1Type::Integer(d1_i32(settled_at)),
        D1Type::Integer(d1_i32(RELAY_BILLING_ORPHAN_RECOVERY_GRACE_SECONDS)),
    ];
    let status_update = db
        .prepare(
            r#"
            UPDATE relay_billing_reservations
            SET status = 'settled', final_quota = ?4, finalization_reason = ?5,
                request_accounted = 1, updated_at = ?6, settled_at = ?6
            WHERE reservation_key = ?1 AND status = 'reserved'
              AND channel_id = ?2 AND selected_group = ?3
              AND ?6 <= lease_expires_at + ?7
            "#,
        )
        .bind_refs(&args)?;
    let mut statements = Vec::new();
    let mut checked = Vec::new();
    push_relay_reservation_guarded_statement(
        db,
        &mut statements,
        &mut checked,
        status_update,
        reservation_key,
        "relay billing reservation settlement state transition failed",
    )?;

    if delta > 0 {
        push_relay_reservation_guarded_statement(
            db,
            &mut statements,
            &mut checked,
            reserve_user_quota_statement(db, record.user_id, delta)?,
            reservation_key,
            "user quota settlement failed",
        )?;
        if record.token_id > 0 {
            push_relay_reservation_guarded_statement(
                db,
                &mut statements,
                &mut checked,
                debit_token_quota_usage_statement(db, record.token_id, delta, settled_at)?,
                reservation_key,
                "token quota settlement failed",
            )?;
        }
    } else if delta < 0 {
        let refund = delta.saturating_abs();
        push_relay_reservation_guarded_statement(
            db,
            &mut statements,
            &mut checked,
            credit_user_quota_statement(db, record.user_id, refund)?,
            reservation_key,
            "user quota refund failed",
        )?;
        if record.token_id > 0 {
            push_relay_reservation_guarded_statement(
                db,
                &mut statements,
                &mut checked,
                credit_token_quota_usage_statement(db, record.token_id, refund, settled_at)?,
                reservation_key,
                "token quota refund failed",
            )?;
        }
    } else if record.token_id > 0 {
        push_relay_reservation_guarded_statement(
            db,
            &mut statements,
            &mut checked,
            touch_token_statement(db, record.token_id, settled_at)?,
            reservation_key,
            "token touch settlement failed",
        )?;
    }
    push_relay_reservation_guarded_statement(
        db,
        &mut statements,
        &mut checked,
        increment_user_used_quota_and_request_count_statement(db, record.user_id, final_quota)?,
        reservation_key,
        "user quota usage settlement failed",
    )?;
    push_relay_reservation_guarded_statement(
        db,
        &mut statements,
        &mut checked,
        increment_channel_used_quota_statement(db, channel_id, final_quota)?,
        reservation_key,
        "relay channel quota settlement failed",
    )?;

    finalize_relay_billing_batch(
        db,
        reservation_key,
        statements,
        checked,
        RelayBillingFinalizationExpectation::Settle {
            channel_id,
            selected_group,
            final_quota: i64::from(final_quota),
            finalization_reason,
        },
    )
    .await
}

pub async fn refund_relay_billing_reservation(
    db: &D1Database,
    reservation_key: &str,
    finalization_reason: &str,
    request_accounting: RelayBillingRequestAccounting,
    refunded_at: i64,
) -> worker::Result<RelayBillingReservationFinalizationOutcome> {
    refund_relay_billing_reservation_inner(
        db,
        reservation_key,
        finalization_reason,
        request_accounting,
        refunded_at,
        None,
    )
    .await
}

pub async fn relay_billing_reservation_schema_ready(db: &D1Database) -> worker::Result<bool> {
    let args = [D1Type::Text(RELAY_BILLING_RESERVATION_MIGRATION)];
    let row = db
        .prepare("SELECT COUNT(1) AS count FROM d1_migrations WHERE name = ?1")
        .bind_refs(&args)?
        .first::<CountRow>(None)
        .await?;
    Ok(row.map(|row| row.count == 1).unwrap_or(false))
}

pub async fn sweep_expired_relay_billing_reservations(
    db: &D1Database,
    now: i64,
    limit: i64,
) -> worker::Result<RelayBillingOrphanSweepSummary> {
    let cutoff = now.saturating_sub(RELAY_BILLING_ORPHAN_RECOVERY_GRACE_SECONDS);
    let args = [
        D1Type::Integer(d1_i32(cutoff)),
        D1Type::Integer(d1_i32(now)),
        D1Type::Integer(d1_i32(limit.clamp(1, RELAY_BILLING_ORPHAN_SWEEP_MAX_LIMIT))),
    ];
    let candidates = db
        .prepare(
            r#"
            SELECT reservation_key, channel_id, selected_group, selected_at,
                   lease_expires_at, recovery_attempt_count
            FROM relay_billing_reservations
            WHERE status = 'reserved'
              AND lease_expires_at < ?1
              AND recovery_next_attempt_at <= ?2
            ORDER BY lease_expires_at ASC, reservation_key ASC
            LIMIT ?3
            "#,
        )
        .bind_refs(&args)?
        .all()
        .await?
        .results::<RelayBillingExpiredLeaseCandidate>()?;
    let mut summary = RelayBillingOrphanSweepSummary {
        candidates: u32::try_from(candidates.len()).unwrap_or(u32::MAX),
        ..RelayBillingOrphanSweepSummary::default()
    };
    for candidate in candidates {
        if candidate.channel_id > 0
            && !candidate.selected_group.is_empty()
            && candidate.selected_at > 0
        {
            match mark_relay_billing_recovery_required(db, &candidate, now).await {
                Ok(RelayBillingReservationFinalizationOutcome::Applied) => {
                    summary.recovery_required = summary.recovery_required.saturating_add(1)
                }
                Ok(
                    RelayBillingReservationFinalizationOutcome::RecoveryRequired
                    | RelayBillingReservationFinalizationOutcome::MatchingSettled
                    | RelayBillingReservationFinalizationOutcome::MatchingRefund,
                ) => summary.already_finalized = summary.already_finalized.saturating_add(1),
                Ok(RelayBillingReservationFinalizationOutcome::LeaseActive) => {
                    summary.lease_active = summary.lease_active.saturating_add(1)
                }
                Ok(RelayBillingReservationFinalizationOutcome::NotFound) => {
                    summary.not_found = summary.not_found.saturating_add(1)
                }
                Ok(
                    RelayBillingReservationFinalizationOutcome::SettlementWon
                    | RelayBillingReservationFinalizationOutcome::RefundWon
                    | RelayBillingReservationFinalizationOutcome::DeadlineExpired
                    | RelayBillingReservationFinalizationOutcome::Conflict,
                ) => summary.failed = summary.failed.saturating_add(1),
                Err(_) => {
                    summary.failed = summary.failed.saturating_add(1);
                    if defer_relay_billing_orphan_recovery(db, &candidate, now)
                        .await
                        .unwrap_or(false)
                    {
                        summary.deferred = summary.deferred.saturating_add(1);
                    }
                    worker::console_error!(
                        "relay billing orphan sweep: bound reservation quarantine failed"
                    );
                }
            }
            continue;
        }
        match refund_relay_billing_reservation_inner(
            db,
            &candidate.reservation_key,
            "recovery_expired",
            RelayBillingRequestAccounting::Skip,
            now,
            Some(candidate.lease_expires_at),
        )
        .await
        {
            Ok(RelayBillingReservationFinalizationOutcome::Applied) => {
                summary.refunded = summary.refunded.saturating_add(1)
            }
            Ok(
                RelayBillingReservationFinalizationOutcome::MatchingRefund
                | RelayBillingReservationFinalizationOutcome::SettlementWon,
            ) => summary.already_finalized = summary.already_finalized.saturating_add(1),
            Ok(RelayBillingReservationFinalizationOutcome::LeaseActive) => {
                summary.lease_active = summary.lease_active.saturating_add(1)
            }
            Ok(RelayBillingReservationFinalizationOutcome::NotFound) => {
                summary.not_found = summary.not_found.saturating_add(1)
            }
            Ok(
                RelayBillingReservationFinalizationOutcome::MatchingSettled
                | RelayBillingReservationFinalizationOutcome::RefundWon
                | RelayBillingReservationFinalizationOutcome::DeadlineExpired
                | RelayBillingReservationFinalizationOutcome::RecoveryRequired
                | RelayBillingReservationFinalizationOutcome::Conflict,
            ) => summary.failed = summary.failed.saturating_add(1),
            Err(_) => {
                summary.failed = summary.failed.saturating_add(1);
                if defer_relay_billing_orphan_recovery(db, &candidate, now)
                    .await
                    .unwrap_or(false)
                {
                    summary.deferred = summary.deferred.saturating_add(1);
                }
                worker::console_error!("relay billing orphan sweep: candidate refund failed");
            }
        }
    }
    Ok(summary)
}

pub async fn mark_relay_billing_recovery_started(
    db: &D1Database,
    started_at: i64,
) -> worker::Result<()> {
    let args = [D1Type::Integer(d1_i32(started_at))];
    db.prepare(
        "UPDATE relay_billing_recovery_state SET last_started_at = ?1, updated_at = ?1 WHERE id = 1",
    )
    .bind_refs(&args)?
    .run()
    .await?;
    Ok(())
}

pub async fn mark_relay_billing_recovery_completed(
    db: &D1Database,
    completed_at: i64,
    summary: RelayBillingOrphanSweepSummary,
) -> worker::Result<()> {
    let successful_at = if summary.failed == 0 { completed_at } else { 0 };
    let args = [
        D1Type::Integer(d1_i32(completed_at)),
        D1Type::Integer(d1_i32(successful_at)),
        D1Type::Integer(d1_i32(i64::from(summary.candidates))),
        D1Type::Integer(d1_i32(i64::from(summary.refunded))),
        D1Type::Integer(d1_i32(i64::from(summary.recovery_required))),
        D1Type::Integer(d1_i32(i64::from(summary.failed))),
        D1Type::Integer(d1_i32(i64::from(summary.deferred))),
    ];
    db.prepare(
        r#"
        UPDATE relay_billing_recovery_state
        SET last_completed_at = ?1,
            last_success_at = CASE WHEN ?2 > 0 THEN ?2 ELSE last_success_at END,
            last_candidates = ?3, last_refunded = ?4,
            last_recovery_required = ?5, last_failed = ?6,
            last_deferred = ?7, updated_at = ?1
        WHERE id = 1
        "#,
    )
    .bind_refs(&args)?
    .run()
    .await?;
    Ok(())
}

pub async fn relay_billing_recovery_state(
    db: &D1Database,
) -> worker::Result<Option<RelayBillingRecoveryStateRow>> {
    db.prepare(
        r#"
        SELECT last_started_at, last_completed_at, last_success_at,
               last_candidates, last_refunded, last_recovery_required,
               last_failed, last_deferred
        FROM relay_billing_recovery_state
        WHERE id = 1
        "#,
    )
    .first::<RelayBillingRecoveryStateRow>(None)
    .await
}

pub async fn recent_relay_billing_ledger_status(
    db: &D1Database,
    limit: i64,
) -> worker::Result<Vec<RelayBillingLedgerStatusRow>> {
    let args = [D1Type::Integer(d1_i32(limit.clamp(1, 100)))];
    db.prepare(
        r#"
        SELECT reservation_key, user_id, token_id, status, channel_id, selected_at,
               request_accounted, lease_expires_at, updated_at, settled_at,
               refunded_at, recovery_required_at, recovery_attempt_count,
               recovery_next_attempt_at, recovery_last_attempt_at
        FROM relay_billing_reservations
        ORDER BY updated_at DESC, reservation_key ASC
        LIMIT ?1
        "#,
    )
    .bind_refs(&args)?
    .all()
    .await?
    .results::<RelayBillingLedgerStatusRow>()
}

async fn refund_relay_billing_reservation_inner(
    db: &D1Database,
    reservation_key: &str,
    finalization_reason: &str,
    request_accounting: RelayBillingRequestAccounting,
    refunded_at: i64,
    expected_lease_expires_at: Option<i64>,
) -> worker::Result<RelayBillingReservationFinalizationOutcome> {
    let reservation_key = non_empty_relay_reservation_field(reservation_key, "key")?;
    let finalization_reason =
        non_empty_relay_reservation_field(finalization_reason, "finalization reason")?;
    let Some(record) = relay_billing_reservation(db, reservation_key).await? else {
        return Ok(RelayBillingReservationFinalizationOutcome::NotFound);
    };
    if record.status != "reserved" {
        return Ok(classify_relay_refund_outcome(
            &record,
            finalization_reason,
            request_accounting,
        ));
    }
    if expected_lease_expires_at.is_some_and(|expected| {
        record.lease_expires_at != expected || record.lease_expires_at > refunded_at
    }) {
        return Ok(RelayBillingReservationFinalizationOutcome::LeaseActive);
    }
    let quota = quota_i32(record.pre_consumed_quota)?;
    let args = [
        D1Type::Text(reservation_key),
        D1Type::Integer(d1_i32(refunded_at)),
        D1Type::Integer(d1_i32(expected_lease_expires_at.unwrap_or_default())),
        D1Type::Text(finalization_reason),
        D1Type::Integer(request_accounting.value()),
    ];
    let status_update = db
        .prepare(
            r#"
            UPDATE relay_billing_reservations
            SET status = 'refunded', finalization_reason = ?4,
                request_accounted = ?5, updated_at = ?2, refunded_at = ?2
            WHERE reservation_key = ?1 AND status = 'reserved'
              AND (
                ?3 = 0 OR (
                  lease_expires_at = ?3 AND lease_expires_at <= ?2
                  AND channel_id = 0 AND selected_group = '' AND selected_at = 0
                )
              )
            "#,
        )
        .bind_refs(&args)?;
    let mut statements = Vec::new();
    let mut checked = Vec::new();
    push_relay_reservation_guarded_statement(
        db,
        &mut statements,
        &mut checked,
        status_update,
        reservation_key,
        "relay billing reservation refund state transition failed",
    )?;
    push_relay_reservation_guarded_statement(
        db,
        &mut statements,
        &mut checked,
        credit_user_quota_statement(db, record.user_id, quota)?,
        reservation_key,
        "user no longer exists",
    )?;
    if record.token_id > 0 {
        push_relay_reservation_guarded_statement(
            db,
            &mut statements,
            &mut checked,
            credit_token_quota_usage_statement(db, record.token_id, quota, refunded_at)?,
            reservation_key,
            "token no longer exists",
        )?;
    }
    if request_accounting == RelayBillingRequestAccounting::Account {
        push_relay_reservation_guarded_statement(
            db,
            &mut statements,
            &mut checked,
            increment_user_request_count_statement(db, record.user_id)?,
            reservation_key,
            "user request count refund settlement failed",
        )?;
    }
    finalize_relay_billing_batch(
        db,
        reservation_key,
        statements,
        checked,
        RelayBillingFinalizationExpectation::Refund {
            finalization_reason,
            request_accounting,
        },
    )
    .await
}

#[derive(Clone, Copy)]
enum RelayBillingFinalizationExpectation<'a> {
    Settle {
        channel_id: i64,
        selected_group: &'a str,
        final_quota: i64,
        finalization_reason: &'a str,
    },
    Refund {
        finalization_reason: &'a str,
        request_accounting: RelayBillingRequestAccounting,
    },
}

async fn finalize_relay_billing_batch(
    db: &D1Database,
    reservation_key: &str,
    statements: Vec<worker::D1PreparedStatement>,
    checked: Vec<(usize, &'static str)>,
    expectation: RelayBillingFinalizationExpectation<'_>,
) -> worker::Result<RelayBillingReservationFinalizationOutcome> {
    let results = match db.batch(statements).await {
        Ok(results) => results,
        Err(err) => {
            return match relay_billing_reservation(db, reservation_key).await? {
                None => Ok(RelayBillingReservationFinalizationOutcome::NotFound),
                Some(current) if current.status != "reserved" => {
                    Ok(classify_relay_finalization_outcome(&current, expectation))
                }
                Some(_) => Err(err),
            };
        }
    };
    for (index, message) in checked {
        require_batch_change(&results, index, message)?;
    }
    Ok(RelayBillingReservationFinalizationOutcome::Applied)
}

fn classify_relay_finalization_outcome(
    record: &RelayBillingReservation,
    expectation: RelayBillingFinalizationExpectation<'_>,
) -> RelayBillingReservationFinalizationOutcome {
    match expectation {
        RelayBillingFinalizationExpectation::Settle {
            channel_id,
            selected_group,
            final_quota,
            finalization_reason,
        } => classify_relay_settlement_outcome(
            record,
            channel_id,
            selected_group,
            final_quota,
            finalization_reason,
        ),
        RelayBillingFinalizationExpectation::Refund {
            finalization_reason,
            request_accounting,
        } => classify_relay_refund_outcome(record, finalization_reason, request_accounting),
    }
}

fn classify_relay_settlement_outcome(
    record: &RelayBillingReservation,
    channel_id: i64,
    selected_group: &str,
    final_quota: i64,
    finalization_reason: &str,
) -> RelayBillingReservationFinalizationOutcome {
    match record.status.as_str() {
        "settled"
            if record.channel_id == channel_id
                && record.selected_group == selected_group
                && record.final_quota == final_quota
                && record.finalization_reason == finalization_reason
                && record.request_accounted == 1 =>
        {
            RelayBillingReservationFinalizationOutcome::MatchingSettled
        }
        "settled" => RelayBillingReservationFinalizationOutcome::Conflict,
        "refunded" => RelayBillingReservationFinalizationOutcome::RefundWon,
        "recovery_required" => RelayBillingReservationFinalizationOutcome::RecoveryRequired,
        _ => RelayBillingReservationFinalizationOutcome::Conflict,
    }
}

fn classify_relay_refund_outcome(
    record: &RelayBillingReservation,
    finalization_reason: &str,
    request_accounting: RelayBillingRequestAccounting,
) -> RelayBillingReservationFinalizationOutcome {
    match record.status.as_str() {
        "refunded"
            if record.finalization_reason == finalization_reason
                && record.request_accounted == i64::from(request_accounting.value()) =>
        {
            RelayBillingReservationFinalizationOutcome::MatchingRefund
        }
        "refunded" => RelayBillingReservationFinalizationOutcome::Conflict,
        "settled" => RelayBillingReservationFinalizationOutcome::SettlementWon,
        "recovery_required" => RelayBillingReservationFinalizationOutcome::RecoveryRequired,
        _ => RelayBillingReservationFinalizationOutcome::Conflict,
    }
}

async fn mark_relay_billing_recovery_required(
    db: &D1Database,
    candidate: &RelayBillingExpiredLeaseCandidate,
    now: i64,
) -> worker::Result<RelayBillingReservationFinalizationOutcome> {
    let args = [
        D1Type::Text(candidate.reservation_key.as_str()),
        D1Type::Integer(d1_i32(candidate.lease_expires_at)),
        D1Type::Integer(d1_i32(candidate.channel_id)),
        D1Type::Text(candidate.selected_group.as_str()),
        D1Type::Integer(d1_i32(candidate.selected_at)),
        D1Type::Integer(d1_i32(now)),
    ];
    let result = db
        .prepare(
            r#"
            UPDATE relay_billing_reservations
            SET status = 'recovery_required',
                finalization_reason = 'bound_usage_missing',
                recovery_last_attempt_at = ?6,
                recovery_required_at = ?6,
                updated_at = ?6
            WHERE reservation_key = ?1 AND status = 'reserved'
              AND lease_expires_at = ?2 AND channel_id = ?3
              AND selected_group = ?4 AND selected_at = ?5
            "#,
        )
        .bind_refs(&args)?
        .run()
        .await;
    if let Ok(result) = &result {
        if result.meta()?.and_then(|meta| meta.changes).unwrap_or(0) == 1 {
            return Ok(RelayBillingReservationFinalizationOutcome::Applied);
        }
    }
    match relay_billing_reservation(db, &candidate.reservation_key).await? {
        None => Ok(RelayBillingReservationFinalizationOutcome::NotFound),
        Some(current) => match current.status.as_str() {
            "recovery_required" => Ok(RelayBillingReservationFinalizationOutcome::RecoveryRequired),
            "settled" => Ok(RelayBillingReservationFinalizationOutcome::MatchingSettled),
            "refunded" => Ok(RelayBillingReservationFinalizationOutcome::MatchingRefund),
            "reserved" => match result {
                Ok(_) => Ok(RelayBillingReservationFinalizationOutcome::LeaseActive),
                Err(err) => Err(err),
            },
            _ => Ok(RelayBillingReservationFinalizationOutcome::Conflict),
        },
    }
}

async fn relay_billing_reservation(
    db: &D1Database,
    reservation_key: &str,
) -> worker::Result<Option<RelayBillingReservation>> {
    let reservation_key = non_empty_relay_reservation_field(reservation_key, "key")?;
    let args = [D1Type::Text(reservation_key)];
    db.prepare(
        r#"
        SELECT reservation_key, user_id, token_id, model_name, endpoint_path, request_id_hash,
               expr_hash, candidate_group_count, reservation_strategy,
               pre_consumed_quota, status, channel_id, selected_group,
               selected_at, final_quota, finalization_reason, request_accounted,
               lease_expires_at, recovery_attempt_count,
               created_at, updated_at
        FROM relay_billing_reservations
        WHERE reservation_key = ?1
        LIMIT 1
        "#,
    )
    .bind_refs(&args)?
    .first::<RelayBillingReservation>(None)
    .await
}

async fn defer_relay_billing_orphan_recovery(
    db: &D1Database,
    candidate: &RelayBillingExpiredLeaseCandidate,
    now: i64,
) -> worker::Result<bool> {
    let attempt_count = candidate.recovery_attempt_count.saturating_add(1);
    let exponent = attempt_count.saturating_sub(1).clamp(0, 6) as u32;
    let retry_after = RELAY_BILLING_ORPHAN_RETRY_INITIAL_SECONDS
        .saturating_mul(1_i64 << exponent)
        .min(RELAY_BILLING_ORPHAN_RETRY_MAX_SECONDS);
    let args = [
        D1Type::Text(candidate.reservation_key.as_str()),
        D1Type::Integer(d1_i32(candidate.lease_expires_at)),
        D1Type::Integer(d1_i32(now)),
        D1Type::Integer(d1_i32(now.saturating_add(retry_after))),
    ];
    let result = db
        .prepare(
            r#"
            UPDATE relay_billing_reservations
            SET recovery_attempt_count = recovery_attempt_count + 1,
                recovery_last_attempt_at = ?3,
                recovery_next_attempt_at = ?4,
                updated_at = MAX(updated_at, ?3)
            WHERE reservation_key = ?1 AND status = 'reserved' AND lease_expires_at = ?2
            "#,
        )
        .bind_refs(&args)?
        .run()
        .await?;
    Ok(result.meta()?.and_then(|meta| meta.changes).unwrap_or(0) == 1)
}

pub async fn reserve_realtime_billing_quota(
    db: &D1Database,
    record: RealtimeBillingReservationRecord<'_>,
) -> worker::Result<RealtimeBillingReservationWriteOutcome> {
    let reservation_key = non_empty_realtime_reservation_key(record.reservation_key)?;
    let session = non_empty_realtime_reservation_field(record.session, "session")?;
    let bridge_segment =
        non_empty_realtime_reservation_field(record.bridge_segment, "bridge segment")?;
    let model_name = non_empty_realtime_reservation_field(record.model_name, "model name")?;
    let snapshot_json =
        non_empty_realtime_reservation_field(record.snapshot_json, "snapshot JSON")?;
    let request_json = non_empty_realtime_reservation_field(record.request_json, "request JSON")?;
    if record.reservation_sequence <= 0
        || record.user_id <= 0
        || record.channel_id <= 0
        || record.lease_expires_at <= record.created_at
    {
        return Err(worker::Error::RustError(
            "realtime billing reservation identity is invalid".to_string(),
        ));
    }
    if record.token_id < 0 {
        return Err(worker::Error::RustError(
            "realtime billing reservation token id is invalid".to_string(),
        ));
    }
    let quota = quota_i32(record.pre_consumed_quota)?;
    let args = [
        D1Type::Text(reservation_key),
        D1Type::Text(session),
        D1Type::Text(bridge_segment),
        D1Type::Text(record.client_event_id_hash.trim()),
        D1Type::Integer(d1_i32(record.reservation_sequence)),
        D1Type::Integer(d1_i32(record.user_id)),
        D1Type::Integer(d1_i32(record.token_id)),
        D1Type::Integer(d1_i32(record.channel_id)),
        D1Type::Text(record.selected_group.trim()),
        D1Type::Text(model_name),
        D1Type::Integer(quota),
        D1Type::Text(snapshot_json),
        D1Type::Text(request_json),
        D1Type::Text(record.username.trim()),
        D1Type::Text(record.token_name.trim()),
        D1Type::Text(record.client_ip.trim()),
        D1Type::Text(record.request_id.trim()),
        D1Type::Integer(d1_i32(record.started_at)),
        D1Type::Text(record.endpoint_path.trim()),
        D1Type::Integer(d1_i32(record.created_at)),
        D1Type::Integer(d1_i32(record.lease_expires_at)),
    ];
    let insert = db
        .prepare(
            r#"
            INSERT INTO realtime_billing_reservations (
              reservation_key, session, bridge_segment,
              client_event_id_hash, reservation_sequence,
              user_id, token_id, channel_id, selected_group, model_name,
              pre_consumed_quota, snapshot_json, request_json,
              username, token_name, client_ip, request_id, started_at,
              endpoint_path, status, created_at, updated_at, lease_expires_at
            ) VALUES (
              ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
              ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, 'reserved', ?20, ?20, ?21
            )
            "#,
        )
        .bind_refs(&args)?;

    let mut statements = vec![insert];
    let mut checked_statement_indices = vec![(0usize, "realtime reservation marker failed")];
    if quota > 0 {
        push_realtime_reservation_guarded_statement(
            db,
            &mut statements,
            &mut checked_statement_indices,
            reserve_user_quota_statement(db, record.user_id, quota)?,
            reservation_key,
            "user quota is not enough",
        )?;
        if record.token_id > 0 {
            push_realtime_reservation_guarded_statement(
                db,
                &mut statements,
                &mut checked_statement_indices,
                debit_token_quota_usage_statement(db, record.token_id, quota, record.created_at)?,
                reservation_key,
                "token quota is not enough",
            )?;
        }
    } else if record.token_id > 0 {
        push_realtime_reservation_guarded_statement(
            db,
            &mut statements,
            &mut checked_statement_indices,
            touch_token_statement(db, record.token_id, record.created_at)?,
            reservation_key,
            "token no longer exists",
        )?;
    }

    let results = match db.batch(statements).await {
        Ok(results) => results,
        Err(err) => {
            if realtime_billing_reservation(db, reservation_key)
                .await
                .ok()
                .flatten()
                .is_some()
            {
                return Ok(RealtimeBillingReservationWriteOutcome::Duplicate);
            }
            return Err(err);
        }
    };
    for (index, message) in checked_statement_indices {
        require_batch_change(&results, index, message)?;
    }
    Ok(RealtimeBillingReservationWriteOutcome::Applied)
}

pub async fn reserved_realtime_billing_for_segment(
    db: &D1Database,
    session: &str,
    bridge_segment: &str,
) -> worker::Result<Vec<RealtimeBillingReservation>> {
    let session = non_empty_realtime_reservation_field(session, "session")?;
    let bridge_segment = non_empty_realtime_reservation_field(bridge_segment, "bridge segment")?;
    let args = [D1Type::Text(session), D1Type::Text(bridge_segment)];
    db.prepare(
        r#"
        SELECT
          reservation_key, session, bridge_segment,
          client_event_id_hash, reservation_sequence,
          user_id, token_id, channel_id, selected_group, model_name,
          pre_consumed_quota, snapshot_json, request_json,
          username, token_name, client_ip, request_id, started_at,
          endpoint_path, status, upstream_response_id_hash, replay_key,
          final_quota, created_at, updated_at, lease_expires_at
        FROM realtime_billing_reservations
        WHERE session = ?1 AND bridge_segment = ?2 AND status = 'reserved'
        ORDER BY reservation_sequence ASC, reservation_key ASC
        "#,
    )
    .bind_refs(&args)?
    .all()
    .await?
    .results::<RealtimeBillingReservation>()
}

pub async fn realtime_billing_reservation_for_response(
    db: &D1Database,
    session: &str,
    bridge_segment: &str,
    upstream_response_id_hash: &str,
) -> worker::Result<Option<RealtimeBillingReservation>> {
    let session = non_empty_realtime_reservation_field(session, "session")?;
    let bridge_segment = non_empty_realtime_reservation_field(bridge_segment, "bridge segment")?;
    let upstream_response_id_hash = non_empty_realtime_reservation_field(
        upstream_response_id_hash,
        "upstream response identity hash",
    )?;
    let args = [
        D1Type::Text(session),
        D1Type::Text(bridge_segment),
        D1Type::Text(upstream_response_id_hash),
    ];
    db.prepare(
        r#"
        SELECT
          reservation_key, session, bridge_segment,
          client_event_id_hash, reservation_sequence,
          user_id, token_id, channel_id, selected_group, model_name,
          pre_consumed_quota, snapshot_json, request_json,
          username, token_name, client_ip, request_id, started_at,
          endpoint_path, status, upstream_response_id_hash, replay_key,
          final_quota, created_at, updated_at, lease_expires_at
        FROM realtime_billing_reservations
        WHERE session = ?1 AND bridge_segment = ?2 AND upstream_response_id_hash = ?3
        LIMIT 1
        "#,
    )
    .bind_refs(&args)?
    .first::<RealtimeBillingReservation>(None)
    .await
}

pub async fn bind_realtime_response_to_reservation(
    db: &D1Database,
    session: &str,
    bridge_segment: &str,
    upstream_response_id_hash: &str,
    updated_at: i64,
) -> worker::Result<RealtimeBillingResponseBindOutcome> {
    let session = non_empty_realtime_reservation_field(session, "session")?;
    let bridge_segment = non_empty_realtime_reservation_field(bridge_segment, "bridge segment")?;
    let upstream_response_id_hash = non_empty_realtime_reservation_field(
        upstream_response_id_hash,
        "upstream response identity hash",
    )?;
    if realtime_billing_reservation_for_response(
        db,
        session,
        bridge_segment,
        upstream_response_id_hash,
    )
    .await?
    .is_some()
    {
        return Ok(RealtimeBillingResponseBindOutcome::Duplicate);
    }
    let args = [
        D1Type::Text(session),
        D1Type::Text(bridge_segment),
        D1Type::Text(upstream_response_id_hash),
        D1Type::Integer(d1_i32(updated_at)),
    ];
    let result = db
        .prepare(
            r#"
            UPDATE realtime_billing_reservations
            SET upstream_response_id_hash = ?3, updated_at = ?4
            WHERE reservation_key = (
              SELECT reservation_key
              FROM realtime_billing_reservations
              WHERE session = ?1
                AND bridge_segment = ?2
                AND status = 'reserved'
                AND upstream_response_id_hash = ''
              ORDER BY reservation_sequence ASC, reservation_key ASC
              LIMIT 1
            )
              AND status = 'reserved'
              AND bridge_segment = ?2
              AND upstream_response_id_hash = ''
            "#,
        )
        .bind_refs(&args)?
        .run()
        .await;
    match result {
        Ok(result) => {
            let changes = result.meta()?.and_then(|meta| meta.changes).unwrap_or(0);
            if changes == 1 {
                Ok(RealtimeBillingResponseBindOutcome::Applied)
            } else {
                Ok(RealtimeBillingResponseBindOutcome::NotFound)
            }
        }
        Err(err) => {
            if realtime_billing_reservation_for_response(
                db,
                session,
                bridge_segment,
                upstream_response_id_hash,
            )
            .await?
            .is_some()
            {
                Ok(RealtimeBillingResponseBindOutcome::Duplicate)
            } else {
                Err(err)
            }
        }
    }
}

pub async fn realtime_response_settlement_applied(
    db: &D1Database,
    session: &str,
    bridge_segment: &str,
    upstream_response_id_hash: &str,
) -> worker::Result<bool> {
    let session = non_empty_realtime_reservation_field(session, "session")?;
    let bridge_segment = non_empty_realtime_reservation_field(bridge_segment, "bridge segment")?;
    let upstream_response_id_hash = non_empty_realtime_reservation_field(
        upstream_response_id_hash,
        "upstream response identity hash",
    )?;
    let args = [
        D1Type::Text(session),
        D1Type::Text(bridge_segment),
        D1Type::Text(upstream_response_id_hash),
    ];
    let row = db
        .prepare(
            r#"
            SELECT COUNT(1) AS count
            FROM realtime_billing_reservations
            WHERE session = ?1
              AND bridge_segment = ?2
              AND upstream_response_id_hash = ?3
              AND status IN ('settled', 'refunded')
            "#,
        )
        .bind_refs(&args)?
        .first::<RealtimeSettlementReplayCountRow>(None)
        .await?;
    Ok(row.map(|row| row.count > 0).unwrap_or(false))
}

pub async fn refund_realtime_billing_reservation(
    db: &D1Database,
    reservation_key: &str,
    refunded_at: i64,
) -> worker::Result<RealtimeBillingReservationRefundOutcome> {
    refund_realtime_billing_reservation_inner(db, reservation_key, "", refunded_at, None).await
}

pub async fn expired_realtime_billing_reservations(
    db: &D1Database,
    now: i64,
    limit: i64,
) -> worker::Result<Vec<RealtimeBillingExpiredLeaseCandidate>> {
    let cutoff = now.saturating_sub(REALTIME_BILLING_ORPHAN_RECOVERY_GRACE_SECONDS);
    let args = [
        D1Type::Integer(d1_i32(cutoff)),
        D1Type::Integer(d1_i32(now)),
        D1Type::Integer(d1_i32(
            limit.clamp(1, REALTIME_BILLING_ORPHAN_SWEEP_MAX_LIMIT),
        )),
    ];
    db.prepare(
        r#"
        SELECT reservation_key, reservation_sequence, lease_expires_at,
               recovery_attempt_count
        FROM realtime_billing_reservations
        WHERE status = 'reserved'
          AND lease_expires_at > 0
          AND lease_expires_at < ?1
          AND recovery_next_attempt_at <= ?2
        ORDER BY lease_expires_at ASC, reservation_sequence ASC, reservation_key ASC
        LIMIT ?3
        "#,
    )
    .bind_refs(&args)?
    .all()
    .await?
    .results::<RealtimeBillingExpiredLeaseCandidate>()
}

pub async fn realtime_billing_global_recovery_schema_ready(
    db: &D1Database,
) -> worker::Result<bool> {
    let args = [D1Type::Text(REALTIME_BILLING_GLOBAL_RECOVERY_MIGRATION)];
    let row = db
        .prepare("SELECT COUNT(1) AS count FROM d1_migrations WHERE name = ?1")
        .bind_refs(&args)?
        .first::<CountRow>(None)
        .await?;
    Ok(row.map(|row| row.count == 1).unwrap_or(false))
}

pub async fn sweep_expired_realtime_billing_reservations(
    db: &D1Database,
    now: i64,
    limit: i64,
) -> worker::Result<RealtimeBillingOrphanSweepSummary> {
    let candidates = expired_realtime_billing_reservations(db, now, limit).await?;
    let mut summary = RealtimeBillingOrphanSweepSummary {
        candidates: u32::try_from(candidates.len()).unwrap_or(u32::MAX),
        ..RealtimeBillingOrphanSweepSummary::default()
    };
    for candidate in candidates {
        match refund_expired_realtime_billing_reservation(
            db,
            &candidate.reservation_key,
            candidate.reservation_sequence,
            candidate.lease_expires_at,
            now,
        )
        .await
        {
            Ok(RealtimeBillingReservationRefundOutcome::Applied) => {
                summary.refunded = summary.refunded.saturating_add(1);
            }
            Ok(RealtimeBillingReservationRefundOutcome::AlreadyFinalized) => {
                summary.already_finalized = summary.already_finalized.saturating_add(1);
            }
            Ok(RealtimeBillingReservationRefundOutcome::LeaseActive { .. }) => {
                summary.lease_active = summary.lease_active.saturating_add(1);
            }
            Ok(RealtimeBillingReservationRefundOutcome::NotFound) => {
                summary.not_found = summary.not_found.saturating_add(1);
            }
            Err(_) => {
                summary.failed = summary.failed.saturating_add(1);
                match defer_realtime_billing_orphan_recovery(db, &candidate, now).await {
                    Ok(true) => summary.deferred = summary.deferred.saturating_add(1),
                    Ok(false) => {}
                    Err(_) => worker::console_error!(
                        "realtime billing orphan sweep: retry deferral failed"
                    ),
                }
                worker::console_error!("realtime billing orphan sweep: candidate refund failed");
            }
        }
    }
    Ok(summary)
}

async fn defer_realtime_billing_orphan_recovery(
    db: &D1Database,
    candidate: &RealtimeBillingExpiredLeaseCandidate,
    now: i64,
) -> worker::Result<bool> {
    let retry_after = realtime_billing_orphan_retry_delay_seconds(
        candidate.recovery_attempt_count.saturating_add(1),
    );
    let args = [
        D1Type::Text(candidate.reservation_key.as_str()),
        D1Type::Integer(d1_i32(candidate.reservation_sequence)),
        D1Type::Integer(d1_i32(candidate.lease_expires_at)),
        D1Type::Integer(d1_i32(now)),
        D1Type::Integer(d1_i32(now.saturating_add(retry_after))),
    ];
    let result = db
        .prepare(
            r#"
            UPDATE realtime_billing_reservations
            SET recovery_attempt_count = recovery_attempt_count + 1,
                recovery_last_attempt_at = ?4,
                recovery_next_attempt_at = ?5,
                updated_at = MAX(updated_at, ?4)
            WHERE reservation_key = ?1
              AND status = 'reserved'
              AND reservation_sequence = ?2
              AND lease_expires_at = ?3
            "#,
        )
        .bind_refs(&args)?
        .run()
        .await?;
    Ok(result.meta()?.and_then(|meta| meta.changes).unwrap_or(0) == 1)
}

fn realtime_billing_orphan_retry_delay_seconds(attempt_count: i64) -> i64 {
    let exponent = attempt_count.saturating_sub(1).clamp(0, 6) as u32;
    REALTIME_BILLING_ORPHAN_RETRY_INITIAL_SECONDS
        .saturating_mul(1_i64 << exponent)
        .min(REALTIME_BILLING_ORPHAN_RETRY_MAX_SECONDS)
}

pub async fn mark_realtime_billing_recovery_started(
    db: &D1Database,
    started_at: i64,
) -> worker::Result<()> {
    let args = [D1Type::Integer(d1_i32(started_at))];
    db.prepare(
        "UPDATE realtime_billing_recovery_state SET last_started_at = ?1, updated_at = ?1 WHERE id = 1",
    )
    .bind_refs(&args)?
    .run()
    .await?;
    Ok(())
}

pub async fn mark_realtime_billing_recovery_completed(
    db: &D1Database,
    completed_at: i64,
    summary: RealtimeBillingOrphanSweepSummary,
) -> worker::Result<()> {
    let successful_at = if summary.failed == 0 { completed_at } else { 0 };
    let args = [
        D1Type::Integer(d1_i32(completed_at)),
        D1Type::Integer(d1_i32(successful_at)),
        D1Type::Integer(d1_i32(i64::from(summary.candidates))),
        D1Type::Integer(d1_i32(i64::from(summary.refunded))),
        D1Type::Integer(d1_i32(i64::from(summary.failed))),
        D1Type::Integer(d1_i32(i64::from(summary.deferred))),
    ];
    db.prepare(
        r#"
        UPDATE realtime_billing_recovery_state
        SET last_completed_at = ?1,
            last_success_at = CASE WHEN ?2 > 0 THEN ?2 ELSE last_success_at END,
            last_candidates = ?3,
            last_refunded = ?4,
            last_failed = ?5,
            last_deferred = ?6,
            updated_at = ?1
        WHERE id = 1
        "#,
    )
    .bind_refs(&args)?
    .run()
    .await?;
    Ok(())
}

pub async fn realtime_billing_recovery_state(
    db: &D1Database,
) -> worker::Result<Option<RealtimeBillingRecoveryStateRow>> {
    db.prepare(
        r#"
        SELECT last_started_at, last_completed_at, last_success_at,
               last_candidates, last_refunded, last_failed, last_deferred
        FROM realtime_billing_recovery_state
        WHERE id = 1
        "#,
    )
    .first::<RealtimeBillingRecoveryStateRow>(None)
    .await
}

pub async fn recent_realtime_billing_ledger_status(
    db: &D1Database,
    limit: i64,
) -> worker::Result<Vec<RealtimeBillingLedgerStatusRow>> {
    let args = [D1Type::Integer(d1_i32(limit.clamp(1, 100)))];
    db.prepare(
        r#"
        SELECT
          reservation_key, session, bridge_segment, status,
          reservation_sequence, lease_expires_at, updated_at, settled_at, refunded_at,
          recovery_attempt_count, recovery_next_attempt_at, recovery_last_attempt_at
        FROM realtime_billing_reservations
        ORDER BY updated_at DESC, reservation_sequence DESC, reservation_key ASC
        LIMIT ?1
        "#,
    )
    .bind_refs(&args)?
    .all()
    .await?
    .results::<RealtimeBillingLedgerStatusRow>()
}

pub async fn refund_expired_realtime_billing_reservation(
    db: &D1Database,
    reservation_key: &str,
    reservation_sequence: i64,
    lease_expires_at: i64,
    refunded_at: i64,
) -> worker::Result<RealtimeBillingReservationRefundOutcome> {
    refund_realtime_billing_reservation_inner(
        db,
        reservation_key,
        "",
        refunded_at,
        Some((reservation_sequence, lease_expires_at)),
    )
    .await
}

pub async fn realtime_billing_reservation_lease_identity(
    db: &D1Database,
    reservation_key: &str,
) -> worker::Result<Option<RealtimeBillingReservationLeaseIdentity>> {
    Ok(realtime_billing_reservation(db, reservation_key)
        .await?
        .filter(|record| record.status == "reserved")
        .map(|record| RealtimeBillingReservationLeaseIdentity {
            reservation_sequence: record.reservation_sequence,
            lease_expires_at: record.lease_expires_at,
        }))
}

pub async fn refund_realtime_billing_reservation_for_response(
    db: &D1Database,
    reservation_key: &str,
    upstream_response_id_hash: &str,
    refunded_at: i64,
) -> worker::Result<RealtimeBillingReservationRefundOutcome> {
    let upstream_response_id_hash = non_empty_realtime_reservation_field(
        upstream_response_id_hash,
        "upstream response identity hash",
    )?;
    refund_realtime_billing_reservation_inner(
        db,
        reservation_key,
        upstream_response_id_hash,
        refunded_at,
        None,
    )
    .await
}

async fn refund_realtime_billing_reservation_inner(
    db: &D1Database,
    reservation_key: &str,
    upstream_response_id_hash: &str,
    refunded_at: i64,
    expected_lease: Option<(i64, i64)>,
) -> worker::Result<RealtimeBillingReservationRefundOutcome> {
    let reservation_key = non_empty_realtime_reservation_key(reservation_key)?;
    let Some(record) = realtime_billing_reservation(db, reservation_key).await? else {
        return Ok(RealtimeBillingReservationRefundOutcome::NotFound);
    };
    if record.status != "reserved" {
        return Ok(RealtimeBillingReservationRefundOutcome::AlreadyFinalized);
    }
    if let Some((reservation_sequence, lease_expires_at)) = expected_lease {
        if record.reservation_sequence != reservation_sequence
            || record.lease_expires_at != lease_expires_at
            || record.lease_expires_at > refunded_at
        {
            return Ok(RealtimeBillingReservationRefundOutcome::LeaseActive {
                reservation_sequence: record.reservation_sequence,
                lease_expires_at: record.lease_expires_at,
            });
        }
    }
    let quota = quota_i32(record.pre_consumed_quota)?;
    let status_args = [
        D1Type::Text(reservation_key),
        D1Type::Integer(d1_i32(refunded_at)),
        D1Type::Text(upstream_response_id_hash),
        D1Type::Integer(d1_i32(
            expected_lease.map(|value| value.0).unwrap_or_default(),
        )),
        D1Type::Integer(d1_i32(
            expected_lease.map(|value| value.1).unwrap_or_default(),
        )),
    ];
    let status_update = db
        .prepare(
            r#"
            UPDATE realtime_billing_reservations
            SET status = 'refunded',
                upstream_response_id_hash = CASE
                  WHEN ?3 = '' THEN upstream_response_id_hash
                  ELSE ?3
                END,
                snapshot_json = '{}',
                request_json = '{}',
                username = '',
                token_name = '',
                client_ip = '',
                request_id = '',
                updated_at = ?2,
                refunded_at = ?2
            WHERE reservation_key = ?1
              AND status = 'reserved'
              AND (
                ?4 = 0 OR (
                  reservation_sequence = ?4
                  AND lease_expires_at = ?5
                  AND lease_expires_at <= ?2
                )
              )
            "#,
        )
        .bind_refs(&status_args)?;
    let mut statements = Vec::new();
    let mut checked_statement_indices = Vec::new();
    push_realtime_reservation_guarded_statement(
        db,
        &mut statements,
        &mut checked_statement_indices,
        status_update,
        reservation_key,
        "realtime reservation is no longer refundable",
    )?;
    if quota > 0 {
        push_realtime_reservation_guarded_statement(
            db,
            &mut statements,
            &mut checked_statement_indices,
            credit_user_quota_statement(db, record.user_id, quota)?,
            reservation_key,
            "user no longer exists",
        )?;
        if record.token_id > 0 {
            push_realtime_reservation_guarded_statement(
                db,
                &mut statements,
                &mut checked_statement_indices,
                credit_token_quota_usage_statement(db, record.token_id, quota, refunded_at)?,
                reservation_key,
                "token no longer exists",
            )?;
        }
    } else if record.token_id > 0 {
        push_realtime_reservation_guarded_statement(
            db,
            &mut statements,
            &mut checked_statement_indices,
            touch_token_statement(db, record.token_id, refunded_at)?,
            reservation_key,
            "token no longer exists",
        )?;
    }

    let results = match db.batch(statements).await {
        Ok(results) => results,
        Err(err) => {
            return match realtime_billing_reservation(db, reservation_key).await? {
                None => Ok(RealtimeBillingReservationRefundOutcome::NotFound),
                Some(current) if current.status != "reserved" => {
                    Ok(RealtimeBillingReservationRefundOutcome::AlreadyFinalized)
                }
                Some(current)
                    if expected_lease.is_some_and(
                        |(reservation_sequence, lease_expires_at)| {
                            current.reservation_sequence != reservation_sequence
                                || current.lease_expires_at != lease_expires_at
                                || current.lease_expires_at > refunded_at
                        },
                    ) =>
                {
                    Ok(RealtimeBillingReservationRefundOutcome::LeaseActive {
                        reservation_sequence: current.reservation_sequence,
                        lease_expires_at: current.lease_expires_at,
                    })
                }
                Some(_) => Err(err),
            };
        }
    };
    for (index, message) in checked_statement_indices {
        require_batch_change(&results, index, message)?;
    }
    Ok(RealtimeBillingReservationRefundOutcome::Applied)
}

async fn realtime_billing_reservation(
    db: &D1Database,
    reservation_key: &str,
) -> worker::Result<Option<RealtimeBillingReservation>> {
    let reservation_key = non_empty_realtime_reservation_key(reservation_key)?;
    let args = [D1Type::Text(reservation_key)];
    db.prepare(
        r#"
        SELECT
          reservation_key, session, bridge_segment,
          client_event_id_hash, reservation_sequence,
          user_id, token_id, channel_id, selected_group, model_name,
          pre_consumed_quota, snapshot_json, request_json,
          username, token_name, client_ip, request_id, started_at,
          endpoint_path, status, upstream_response_id_hash, replay_key,
          final_quota, created_at, updated_at, lease_expires_at
        FROM realtime_billing_reservations
        WHERE reservation_key = ?1
        LIMIT 1
        "#,
    )
    .bind_refs(&args)?
    .first::<RealtimeBillingReservation>(None)
    .await
}

pub async fn realtime_settlement_replay_applied(
    db: &D1Database,
    replay_key: &str,
) -> worker::Result<bool> {
    let replay_key = non_empty_realtime_replay_key(replay_key)?;
    let args = [D1Type::Text(replay_key)];
    let row = db
        .prepare(
            r#"
            SELECT COUNT(1) AS count
            FROM realtime_settlement_replays
            WHERE replay_key = ?1
              AND status = 'applied'
            "#,
        )
        .bind_refs(&args)?
        .first::<RealtimeSettlementReplayCountRow>(None)
        .await?;
    Ok(row.map(|row| row.count > 0).unwrap_or(false))
}

pub async fn apply_realtime_reserved_settlement_batch(
    db: &D1Database,
    reservation_key: &str,
    upstream_response_id_hash: &str,
    record: RealtimeSettlementReplayRecord<'_>,
    audit_content: &str,
    audit_log: &RelayAuditLog<'_>,
) -> worker::Result<RealtimeSettlementBatchOutcome> {
    let reservation_key = non_empty_realtime_reservation_key(reservation_key)?;
    let upstream_response_id_hash = non_empty_realtime_reservation_field(
        upstream_response_id_hash,
        "upstream response identity hash",
    )?;
    let Some(reservation) = realtime_billing_reservation(db, reservation_key).await? else {
        return Err(worker::Error::RustError(
            "realtime billing reservation does not exist".to_string(),
        ));
    };
    if reservation.status == "settled" && reservation.replay_key == record.replay_key {
        return Ok(RealtimeSettlementBatchOutcome::DuplicateReplay);
    }
    if reservation.status != "reserved" {
        return Err(worker::Error::RustError(format!(
            "realtime billing reservation is already {}",
            reservation.status
        )));
    }
    if !realtime_billing_settlement_deadline_allows(reservation.lease_expires_at, record.applied_at)
    {
        return Err(worker::Error::RustError(
            "realtime billing reservation settlement deadline expired".to_string(),
        ));
    }
    if reservation.session != record.session
        || reservation.user_id != record.user_id
        || reservation.token_id != record.token_id
        || reservation.channel_id != record.channel_id
        || reservation.model_name != record.model_name
        || reservation.pre_consumed_quota != record.pre_consumed_quota
        || (!reservation.upstream_response_id_hash.is_empty()
            && reservation.upstream_response_id_hash != upstream_response_id_hash)
    {
        return Err(worker::Error::RustError(
            "realtime settlement does not match its reservation".to_string(),
        ));
    }
    apply_realtime_settlement_batch_inner(
        db,
        (reservation_key, upstream_response_id_hash),
        record,
        audit_content,
        audit_log,
    )
    .await
}

async fn apply_realtime_settlement_batch_inner(
    db: &D1Database,
    reservation: (&str, &str),
    record: RealtimeSettlementReplayRecord<'_>,
    audit_content: &str,
    audit_log: &RelayAuditLog<'_>,
) -> worker::Result<RealtimeSettlementBatchOutcome> {
    let replay_key = non_empty_realtime_replay_key(record.replay_key)?;
    let pre_consumed_quota = quota_i32(record.pre_consumed_quota)?;
    let final_quota = quota_i32(record.final_quota)?;
    if audit_log.user_id != record.user_id
        || audit_log.token_id != record.token_id
        || audit_log.channel_id != record.channel_id
        || audit_log.quota != record.final_quota
        || audit_log.model != record.model_name
    {
        return Err(worker::Error::RustError(
            "realtime settlement audit log does not match replay record".to_string(),
        ));
    }
    if realtime_settlement_replay_applied(db, replay_key).await? {
        return Ok(RealtimeSettlementBatchOutcome::DuplicateReplay);
    }

    let mut statements = vec![insert_realtime_settlement_replay_statement(db, record)?];
    let mut checked_statement_indices = vec![(0usize, "realtime settlement replay marker failed")];
    {
        let (reservation_key, upstream_response_id_hash) = reservation;
        let reservation_args = [
            D1Type::Text(reservation_key),
            D1Type::Text(upstream_response_id_hash),
            D1Type::Text(replay_key),
            D1Type::Integer(final_quota),
            D1Type::Integer(d1_i32(record.applied_at)),
            D1Type::Integer(d1_i32(REALTIME_BILLING_ORPHAN_RECOVERY_GRACE_SECONDS)),
        ];
        let reservation_update = db
            .prepare(
                r#"
                UPDATE realtime_billing_reservations
                SET status = 'settled',
                    upstream_response_id_hash = ?2,
                    replay_key = ?3,
                    final_quota = ?4,
                    snapshot_json = '{}',
                    request_json = '{}',
                    username = '',
                    token_name = '',
                    client_ip = '',
                    request_id = '',
                    updated_at = ?5,
                    settled_at = ?5
                WHERE reservation_key = ?1
                  AND status = 'reserved'
                  AND (upstream_response_id_hash = '' OR upstream_response_id_hash = ?2)
                  AND lease_expires_at > 0
                  AND ?5 <= lease_expires_at + ?6
                "#,
            )
            .bind_refs(&reservation_args)?;
        push_realtime_reservation_guarded_statement(
            db,
            &mut statements,
            &mut checked_statement_indices,
            reservation_update,
            reservation_key,
            "realtime reservation settlement state transition failed",
        )?;
    }
    let delta = final_quota.saturating_sub(pre_consumed_quota);

    if record.token_id <= 0 {
        if delta > 0 {
            push_realtime_settlement_guarded_statement(
                db,
                &mut statements,
                &mut checked_statement_indices,
                reserve_user_quota_statement(db, record.user_id, delta)?,
                replay_key,
                "user quota settlement failed",
            )?;
        } else if delta < 0 {
            push_realtime_settlement_guarded_statement(
                db,
                &mut statements,
                &mut checked_statement_indices,
                credit_user_quota_statement(db, record.user_id, delta.saturating_abs())?,
                replay_key,
                "user quota refund failed",
            )?;
        }
        push_realtime_settlement_guarded_statement(
            db,
            &mut statements,
            &mut checked_statement_indices,
            increment_user_used_quota_and_request_count_statement(db, record.user_id, final_quota)?,
            replay_key,
            "user quota usage settlement failed",
        )?;
        push_realtime_settlement_guarded_statement(
            db,
            &mut statements,
            &mut checked_statement_indices,
            increment_channel_used_quota_statement(db, record.channel_id, final_quota)?,
            replay_key,
            "relay channel quota settlement failed",
        )?;
    } else {
        if delta > 0 {
            push_realtime_settlement_guarded_statement(
                db,
                &mut statements,
                &mut checked_statement_indices,
                reserve_user_quota_statement(db, record.user_id, delta)?,
                replay_key,
                "user quota settlement failed",
            )?;
            push_realtime_settlement_guarded_statement(
                db,
                &mut statements,
                &mut checked_statement_indices,
                debit_token_quota_usage_statement(db, record.token_id, delta, record.applied_at)?,
                replay_key,
                "token quota settlement failed",
            )?;
        } else if delta < 0 {
            let refund = delta.saturating_abs();
            push_realtime_settlement_guarded_statement(
                db,
                &mut statements,
                &mut checked_statement_indices,
                credit_user_quota_statement(db, record.user_id, refund)?,
                replay_key,
                "user quota refund failed",
            )?;
            push_realtime_settlement_guarded_statement(
                db,
                &mut statements,
                &mut checked_statement_indices,
                credit_token_quota_usage_statement(db, record.token_id, refund, record.applied_at)?,
                replay_key,
                "token quota refund failed",
            )?;
        } else {
            push_realtime_settlement_guarded_statement(
                db,
                &mut statements,
                &mut checked_statement_indices,
                touch_token_statement(db, record.token_id, record.applied_at)?,
                replay_key,
                "token touch settlement failed",
            )?;
        }
        push_realtime_settlement_guarded_statement(
            db,
            &mut statements,
            &mut checked_statement_indices,
            increment_user_used_quota_and_request_count_statement(db, record.user_id, final_quota)?,
            replay_key,
            "user quota usage settlement failed",
        )?;
        push_realtime_settlement_guarded_statement(
            db,
            &mut statements,
            &mut checked_statement_indices,
            increment_channel_used_quota_statement(db, record.channel_id, final_quota)?,
            replay_key,
            "relay channel quota settlement failed",
        )?;
    }

    push_realtime_settlement_guarded_statement(
        db,
        &mut statements,
        &mut checked_statement_indices,
        insert_relay_audit_log_statement(db, record.applied_at, audit_content, audit_log)?,
        replay_key,
        "realtime settlement audit log failed",
    )?;

    let results = match db.batch(statements).await {
        Ok(results) => results,
        Err(err) => {
            if realtime_settlement_replay_applied(db, replay_key)
                .await
                .unwrap_or(false)
            {
                return Ok(RealtimeSettlementBatchOutcome::DuplicateReplay);
            }
            if realtime_billing_reservation(db, reservation.0)
                .await
                .ok()
                .flatten()
                .is_some_and(|current| {
                    current.status == "settled" && current.replay_key == replay_key
                })
            {
                return Ok(RealtimeSettlementBatchOutcome::DuplicateReplay);
            }
            return Err(err);
        }
    };
    for (index, message) in checked_statement_indices {
        require_batch_change(&results, index, message)?;
    }
    Ok(RealtimeSettlementBatchOutcome::Applied)
}

fn insert_realtime_settlement_replay_statement(
    db: &D1Database,
    record: RealtimeSettlementReplayRecord<'_>,
) -> worker::Result<worker::D1PreparedStatement> {
    let replay_key = non_empty_realtime_replay_key(record.replay_key)?;
    let session = record.session.trim();
    let model_name = record.model_name.trim();
    let pre_consumed_quota = quota_i32(record.pre_consumed_quota)?;
    let final_quota = quota_i32(record.final_quota)?;
    let args = [
        D1Type::Text(replay_key),
        D1Type::Text(session),
        D1Type::Integer(d1_i32(record.user_id)),
        D1Type::Integer(d1_i32(record.token_id)),
        D1Type::Integer(d1_i32(record.channel_id)),
        D1Type::Text(model_name),
        D1Type::Integer(pre_consumed_quota),
        D1Type::Integer(final_quota),
        D1Type::Integer(d1_i32(record.created_at)),
        D1Type::Integer(d1_i32(record.applied_at)),
    ];
    db.prepare(
        r#"
        INSERT INTO realtime_settlement_replays (
          replay_key,
          session,
          user_id,
          token_id,
          channel_id,
          model_name,
          pre_consumed_quota,
          final_quota,
          status,
          created_at,
          applied_at,
          error
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'applied', ?9, ?10, '')
        "#,
    )
    .bind_refs(&args)
}

fn push_realtime_settlement_guarded_statement(
    db: &D1Database,
    statements: &mut Vec<worker::D1PreparedStatement>,
    checked_statement_indices: &mut Vec<(usize, &'static str)>,
    statement: worker::D1PreparedStatement,
    replay_key: &str,
    message: &'static str,
) -> worker::Result<()> {
    let index = statements.len();
    statements.push(statement);
    checked_statement_indices.push((index, message));
    statements.push(assert_realtime_settlement_previous_statement_statement(
        db, replay_key,
    )?);
    Ok(())
}

fn non_empty_relay_reservation_field<'a>(value: &'a str, field: &str) -> worker::Result<&'a str> {
    let value = value.trim();
    if value.is_empty() {
        Err(worker::Error::RustError(format!(
            "relay billing reservation {field} is required"
        )))
    } else {
        Ok(value)
    }
}

fn push_relay_reservation_guarded_statement(
    db: &D1Database,
    statements: &mut Vec<worker::D1PreparedStatement>,
    checked_statement_indices: &mut Vec<(usize, &'static str)>,
    statement: worker::D1PreparedStatement,
    reservation_key: &str,
    message: &'static str,
) -> worker::Result<()> {
    let index = statements.len();
    statements.push(statement);
    checked_statement_indices.push((index, message));
    let args = [D1Type::Text(reservation_key)];
    statements.push(
        db.prepare(
            r#"
            INSERT INTO relay_billing_reservations (
              reservation_key, user_id, model_name, pre_consumed_quota,
              lease_expires_at, created_at, updated_at
            )
            SELECT ?1, 0, '', 0, 0, 0, 0
            WHERE changes() != 1
            "#,
        )
        .bind_refs(&args)?,
    );
    Ok(())
}

fn assert_realtime_settlement_previous_statement_statement(
    db: &D1Database,
    replay_key: &str,
) -> worker::Result<worker::D1PreparedStatement> {
    let replay_key = non_empty_realtime_replay_key(replay_key)?;
    let args = [D1Type::Text(replay_key)];
    db.prepare(
        r#"
        INSERT INTO realtime_settlement_replays (replay_key)
        SELECT ?1
        WHERE changes() != 1
        "#,
    )
    .bind_refs(&args)
}

fn push_realtime_reservation_guarded_statement(
    db: &D1Database,
    statements: &mut Vec<worker::D1PreparedStatement>,
    checked_statement_indices: &mut Vec<(usize, &'static str)>,
    statement: worker::D1PreparedStatement,
    reservation_key: &str,
    message: &'static str,
) -> worker::Result<()> {
    let index = statements.len();
    statements.push(statement);
    checked_statement_indices.push((index, message));
    statements.push(assert_realtime_reservation_previous_statement_statement(
        db,
        reservation_key,
    )?);
    Ok(())
}

fn assert_realtime_reservation_previous_statement_statement(
    db: &D1Database,
    reservation_key: &str,
) -> worker::Result<worker::D1PreparedStatement> {
    let reservation_key = non_empty_realtime_reservation_key(reservation_key)?;
    let args = [D1Type::Text(reservation_key)];
    db.prepare(
        r#"
        INSERT INTO realtime_billing_reservations (
          reservation_key, session, user_id, channel_id, model_name,
          snapshot_json, request_json
        )
        SELECT ?1, '', 0, 0, '', '{}', '{}'
        WHERE changes() != 1
        "#,
    )
    .bind_refs(&args)
}

async fn debit_user_quota_usage_and_request_count(
    db: &D1Database,
    user_id: i64,
    quota: i32,
) -> worker::Result<()> {
    let result = debit_user_quota_usage_and_request_count_statement(db, user_id, quota)?
        .run()
        .await?;
    require_one_change(result, "user quota is not enough")
}

async fn credit_user_quota_usage_and_request_count(
    db: &D1Database,
    user_id: i64,
    quota: i32,
) -> worker::Result<()> {
    let args = [D1Type::Integer(quota), D1Type::Integer(d1_i32(user_id))];
    db.prepare(
        r#"
        UPDATE users
        SET quota = quota + ?1,
            used_quota = MAX(used_quota - ?1, 0),
            request_count = MAX(request_count - 1, 0)
        WHERE id = ?2
        "#,
    )
    .bind_refs(&args)?
    .run()
    .await?;
    Ok(())
}

async fn debit_token_quota_usage(
    db: &D1Database,
    token_id: i64,
    quota: i32,
    accessed_time: i64,
) -> worker::Result<()> {
    let result = debit_token_quota_usage_statement(db, token_id, quota, accessed_time)?
        .run()
        .await?;
    require_one_change(result, "token quota is not enough")
}

async fn credit_token_quota_usage(
    db: &D1Database,
    token_id: i64,
    quota: i32,
    accessed_time: i64,
) -> worker::Result<()> {
    credit_token_quota_usage_statement(db, token_id, quota, accessed_time)?
        .run()
        .await?;
    Ok(())
}

async fn increment_channel_used_quota(
    db: &D1Database,
    channel_id: i64,
    quota: i32,
) -> worker::Result<()> {
    let result = increment_channel_used_quota_statement(db, channel_id, quota)?
        .run()
        .await?;
    require_one_change(result, "relay channel no longer exists")
}

fn reserve_user_quota_statement(
    db: &D1Database,
    user_id: i64,
    quota: i32,
) -> worker::Result<worker::D1PreparedStatement> {
    let args = [D1Type::Integer(quota), D1Type::Integer(d1_i32(user_id))];
    db.prepare(
        r#"
        UPDATE users
        SET quota = quota - ?1
        WHERE id = ?2
          AND quota >= ?1
        "#,
    )
    .bind_refs(&args)
}

fn credit_user_quota_statement(
    db: &D1Database,
    user_id: i64,
    quota: i32,
) -> worker::Result<worker::D1PreparedStatement> {
    let args = [D1Type::Integer(quota), D1Type::Integer(d1_i32(user_id))];
    db.prepare("UPDATE users SET quota = quota + ?1 WHERE id = ?2")
        .bind_refs(&args)
}

fn increment_user_used_quota_and_request_count_statement(
    db: &D1Database,
    user_id: i64,
    quota: i32,
) -> worker::Result<worker::D1PreparedStatement> {
    let args = [D1Type::Integer(quota), D1Type::Integer(d1_i32(user_id))];
    db.prepare(
        r#"
        UPDATE users
        SET used_quota = used_quota + ?1,
            request_count = request_count + 1
        WHERE id = ?2
        "#,
    )
    .bind_refs(&args)
}

fn increment_user_request_count_statement(
    db: &D1Database,
    user_id: i64,
) -> worker::Result<worker::D1PreparedStatement> {
    let args = [D1Type::Integer(d1_i32(user_id))];
    db.prepare("UPDATE users SET request_count = request_count + 1 WHERE id = ?1")
        .bind_refs(&args)
}

fn debit_user_quota_usage_and_request_count_statement(
    db: &D1Database,
    user_id: i64,
    quota: i32,
) -> worker::Result<worker::D1PreparedStatement> {
    let args = [D1Type::Integer(quota), D1Type::Integer(d1_i32(user_id))];
    db.prepare(
        r#"
        UPDATE users
        SET quota = quota - ?1,
            used_quota = used_quota + ?1,
            request_count = request_count + 1
        WHERE id = ?2
          AND quota >= ?1
        "#,
    )
    .bind_refs(&args)
}

fn debit_token_quota_usage_statement(
    db: &D1Database,
    token_id: i64,
    quota: i32,
    accessed_time: i64,
) -> worker::Result<worker::D1PreparedStatement> {
    let args = [
        D1Type::Integer(quota),
        D1Type::Integer(d1_i32(accessed_time)),
        D1Type::Integer(d1_i32(token_id)),
    ];
    db.prepare(
        r#"
        UPDATE tokens
        SET remain_quota = remain_quota - ?1,
            used_quota = used_quota + ?1,
            accessed_time = ?2
        WHERE id = ?3
          AND (unlimited_quota != 0 OR remain_quota >= ?1)
        "#,
    )
    .bind_refs(&args)
}

fn credit_token_quota_usage_statement(
    db: &D1Database,
    token_id: i64,
    quota: i32,
    accessed_time: i64,
) -> worker::Result<worker::D1PreparedStatement> {
    let args = [
        D1Type::Integer(quota),
        D1Type::Integer(d1_i32(accessed_time)),
        D1Type::Integer(d1_i32(token_id)),
    ];
    db.prepare(
        r#"
        UPDATE tokens
        SET remain_quota = remain_quota + ?1,
            used_quota = MAX(used_quota - ?1, 0),
            accessed_time = ?2
        WHERE id = ?3
        "#,
    )
    .bind_refs(&args)
}

fn increment_channel_used_quota_statement(
    db: &D1Database,
    channel_id: i64,
    quota: i32,
) -> worker::Result<worker::D1PreparedStatement> {
    let args = [D1Type::Integer(quota), D1Type::Integer(d1_i32(channel_id))];
    db.prepare("UPDATE channels SET used_quota = used_quota + ?1 WHERE id = ?2")
        .bind_refs(&args)
}

fn touch_token_statement(
    db: &D1Database,
    token_id: i64,
    accessed_time: i64,
) -> worker::Result<worker::D1PreparedStatement> {
    let args = [
        D1Type::Integer(d1_i32(accessed_time)),
        D1Type::Integer(d1_i32(token_id)),
    ];
    db.prepare("UPDATE tokens SET accessed_time = ?1 WHERE id = ?2")
        .bind_refs(&args)
}

fn require_one_change(result: D1Result, message: &str) -> worker::Result<()> {
    let changes = result.meta()?.and_then(|meta| meta.changes).unwrap_or(0);
    if changes == 1 {
        Ok(())
    } else {
        Err(worker::Error::RustError(message.to_string()))
    }
}

fn require_batch_change(results: &[D1Result], index: usize, message: &str) -> worker::Result<()> {
    if batch_changed(results, index)? {
        Ok(())
    } else {
        Err(worker::Error::RustError(message.to_string()))
    }
}

/// True when the batch statement at `index` affected exactly one row. Used to
/// detect a divergent partial commit (one guarded debit applied, the other
/// no-op) so the committed side can be compensated.
fn batch_changed(results: &[D1Result], index: usize) -> worker::Result<bool> {
    let Some(result) = results.get(index) else {
        return Err(worker::Error::RustError(format!(
            "missing D1 batch result at index {index}"
        )));
    };
    let changes = result.meta()?.and_then(|meta| meta.changes).unwrap_or(0);
    Ok(changes == 1)
}

fn quota_i32(quota: i64) -> worker::Result<i32> {
    if quota < 0 {
        return Err(worker::Error::RustError(
            "quota must be non-negative".to_string(),
        ));
    }
    i32::try_from(quota).map_err(|_| {
        worker::Error::RustError(format!("quota {quota} exceeds D1 integer binding range"))
    })
}

fn non_empty_realtime_replay_key(replay_key: &str) -> worker::Result<&str> {
    let replay_key = replay_key.trim();
    if replay_key.is_empty() {
        return Err(worker::Error::RustError(
            "realtime settlement replay key is required".to_string(),
        ));
    }
    Ok(replay_key)
}

fn non_empty_realtime_reservation_key(reservation_key: &str) -> worker::Result<&str> {
    non_empty_realtime_reservation_field(reservation_key, "reservation key")
}

fn non_empty_realtime_reservation_field<'a>(
    value: &'a str,
    field: &str,
) -> worker::Result<&'a str> {
    let value = value.trim();
    if value.is_empty() {
        return Err(worker::Error::RustError(format!(
            "realtime billing {field} is required"
        )));
    }
    Ok(value)
}

pub async fn tiered_billing_expr_for_model(
    db: &D1Database,
    model: &str,
) -> worker::Result<Option<String>> {
    let values = option_values(db, &[BILLING_MODE_OPTION_KEY, BILLING_EXPR_OPTION_KEY]).await?;
    resolve_tiered_billing_expr_for_model(model, values[0].as_deref(), values[1].as_deref())
}

pub async fn group_ratio_for_group(db: &D1Database, group: &str) -> worker::Result<f64> {
    if let Some(raw) = option_value(db, GROUP_RATIO_OPTION_KEY).await? {
        if let Some(ratio) = resolve_group_ratio(group, &raw)? {
            return Ok(ratio);
        }
    }
    if let Some(raw) = option_value(db, LEGACY_GROUP_RATIO_OPTION_KEY).await? {
        if let Some(ratio) = resolve_group_ratio(group, &raw)? {
            return Ok(ratio);
        }
    }
    Ok(1.0)
}

/// Resolve every possible serving group's effective ratio in one D1 option
/// read. Go gives `GroupGroupRatio[user_group][using_group]` precedence over
/// the ordinary using-group ratio; canonical config keys take precedence over
/// legacy option aliases while still allowing a missing entry to fall through.
pub async fn group_ratios_for_user_and_groups(
    db: &D1Database,
    user_group: &str,
    groups: &[String],
) -> worker::Result<HashMap<String, f64>> {
    let values = option_values(
        db,
        &[
            GROUP_GROUP_RATIO_OPTION_KEY,
            LEGACY_GROUP_GROUP_RATIO_OPTION_KEY,
            GROUP_RATIO_OPTION_KEY,
            LEGACY_GROUP_RATIO_OPTION_KEY,
        ],
    )
    .await?;
    resolve_effective_group_ratios_from_options(
        user_group,
        groups,
        values[0].as_deref(),
        values[1].as_deref(),
        values[2].as_deref(),
        values[3].as_deref(),
    )
}

async fn option_value(db: &D1Database, key: &str) -> worker::Result<Option<String>> {
    let key_arg = D1Type::Text(key);
    db.prepare(r#"SELECT value FROM options WHERE "key" = ?1 LIMIT 1"#)
        .bind_refs(&key_arg)?
        .first::<OptionValueRow>(None)
        .await
        .map(|row| row.map(|row| row.value))
}

/// Read multiple option values in one D1 round-trip, preserving the caller's
/// key order and returning `None` for absent rows. Used by billing and the
/// public frontend-status whitelist.
pub async fn option_values(db: &D1Database, keys: &[&str]) -> worker::Result<Vec<Option<String>>> {
    if keys.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = (1..=keys.len())
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(", ");
    let args = keys.iter().map(|key| D1Type::Text(key)).collect::<Vec<_>>();
    let rows = db
        .prepare(&format!(
            r#"SELECT "key", value FROM options WHERE "key" IN ({placeholders})"#
        ))
        .bind_refs(&args)?
        .all()
        .await?
        .results::<OptionRow>()?;
    let values = rows
        .into_iter()
        .map(|row| (row.key, row.value))
        .collect::<HashMap<_, _>>();
    Ok(keys.iter().map(|key| values.get(*key).cloned()).collect())
}

fn resolve_tiered_billing_expr_for_model(
    model: &str,
    billing_mode: Option<&str>,
    billing_expr: Option<&str>,
) -> worker::Result<Option<String>> {
    let modes = parse_string_map_option(BILLING_MODE_OPTION_KEY, billing_mode)?;
    if modes.get(model).map(String::as_str).map(str::trim) != Some(BILLING_MODE_TIERED_EXPR) {
        return Ok(None);
    }

    let expressions = parse_string_map_option(BILLING_EXPR_OPTION_KEY, billing_expr)?;
    Ok(expressions
        .get(model)
        .map(String::as_str)
        .map(str::trim)
        .filter(|expr| !expr.is_empty())
        .map(str::to_string))
}

fn parse_string_map_option(
    key: &str,
    raw: Option<&str>,
) -> worker::Result<HashMap<String, String>> {
    let Some(raw) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(HashMap::new());
    };
    serde_json::from_str::<HashMap<String, String>>(raw).map_err(|err| {
        worker::Error::RustError(format!("option {key} must be a JSON string map: {err}"))
    })
}

// Auto cross-group resolution layer, consumed by the relay retry loop's
// `is_auto` path (see source-channel-selection-parity.md).
/// Parse the `AutoGroups` option (a JSON array of group names). Missing or
/// malformed config yields an empty list (auto selection is then "not enabled",
/// matching Go's behavior when no auto groups are configured).
fn parse_auto_groups_option(raw: Option<&str>) -> Vec<String> {
    raw.map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| serde_json::from_str::<Vec<String>>(value).ok())
        .unwrap_or_default()
}

/// Parse the `group_ratio_setting.group_special_usable_group` option: a JSON
/// object mapping a user group to its special usable-group overrides
/// (`{ userGroup: { "+:g"|"-:g"|"g": desc } }`). Missing/malformed -> empty.
fn parse_special_usable_groups_option(
    raw: Option<&str>,
) -> HashMap<String, HashMap<String, String>> {
    raw.map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| {
            serde_json::from_str::<HashMap<String, HashMap<String, String>>>(value).ok()
        })
        .unwrap_or_default()
}

/// Pure resolution of a user's auto groups from the raw option values — port of
/// `service.GetUserAutoGroup` glue. Returns the ordered auto-group list (empty
/// when auto groups are not configured). Exposed (via the async wrapper) for the
/// relay loop's cross-group retry.
fn parse_user_usable_groups_option(raw: Option<&str>) -> HashMap<String, String> {
    raw.map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| serde_json::from_str::<HashMap<String, String>>(value).ok())
        .unwrap_or_else(|| {
            DEFAULT_USER_USABLE_GROUPS
                .iter()
                .map(|(group, desc)| (group.to_string(), desc.to_string()))
                .collect()
        })
}

fn resolve_user_usable_groups_from_options(
    user_group: &str,
    user_usable_groups_raw: Option<&str>,
    special_usable_groups_raw: Option<&str>,
) -> HashMap<String, String> {
    let base = parse_user_usable_groups_option(user_usable_groups_raw);
    let special = parse_special_usable_groups_option(special_usable_groups_raw)
        .remove(user_group)
        .unwrap_or_default();
    cinatoken_core::groups::user_usable_groups(user_group, &base, &special)
}

/// Resolve every group a user may select, including the user's own group and
/// any per-user-group `+:`/`-:` overrides from the canonical Go options.
pub async fn resolve_user_usable_groups(
    db: &D1Database,
    user_group: &str,
) -> worker::Result<HashMap<String, String>> {
    let values = option_values(
        db,
        &[
            USER_USABLE_GROUPS_OPTION_KEY,
            GROUP_SPECIAL_USABLE_GROUP_OPTION_KEY,
        ],
    )
    .await?;
    Ok(resolve_user_usable_groups_from_options(
        user_group,
        values[0].as_deref(),
        values[1].as_deref(),
    ))
}

/// Return whether `target_group` is usable for a user in `user_group`, mirroring
/// Go `service.GroupInUserUsableGroups` over D1-backed options.
pub async fn user_can_use_group(
    db: &D1Database,
    user_group: &str,
    target_group: &str,
) -> worker::Result<bool> {
    let target_group = target_group.trim();
    if target_group.is_empty() {
        return Ok(false);
    }
    let usable = resolve_user_usable_groups(db, user_group).await?;
    Ok(usable.contains_key(target_group))
}

fn resolve_user_auto_groups_from_options(
    user_group: &str,
    auto_groups_raw: Option<&str>,
    user_usable_groups_raw: Option<&str>,
    special_usable_groups_raw: Option<&str>,
) -> Vec<String> {
    let auto_groups = parse_auto_groups_option(auto_groups_raw);
    if auto_groups.is_empty() {
        return Vec::new();
    }
    let base = parse_user_usable_groups_option(user_usable_groups_raw);
    let special = parse_special_usable_groups_option(special_usable_groups_raw)
        .remove(user_group)
        .unwrap_or_default();
    cinatoken_core::groups::user_auto_groups(user_group, &auto_groups, &base, &special)
}

/// Resolve the ordered list of auto groups a user may use, reading the
/// `AutoGroups`, `UserUsableGroups`, and special-usable-group options from D1.
/// Empty when auto selection is not configured for this user.
pub async fn resolve_user_auto_groups(
    db: &D1Database,
    user_group: &str,
) -> worker::Result<Vec<String>> {
    let values = option_values(
        db,
        &[
            AUTO_GROUPS_OPTION_KEY,
            USER_USABLE_GROUPS_OPTION_KEY,
            GROUP_SPECIAL_USABLE_GROUP_OPTION_KEY,
        ],
    )
    .await?;
    Ok(resolve_user_auto_groups_from_options(
        user_group,
        values[0].as_deref(),
        values[1].as_deref(),
        values[2].as_deref(),
    ))
}

fn resolve_group_ratio(group: &str, raw: &str) -> worker::Result<Option<f64>> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(None);
    }
    let values = serde_json::from_str::<HashMap<String, Value>>(raw).map_err(|err| {
        worker::Error::RustError(format!("group ratio option must be a JSON object: {err}"))
    })?;
    let Some(value) = values.get(group) else {
        return Ok(None);
    };
    let ratio = value
        .as_f64()
        .or_else(|| value.as_str().and_then(|value| value.trim().parse().ok()))
        .ok_or_else(|| {
            worker::Error::RustError(format!("group ratio for {group} must be numeric"))
        })?;
    Ok(Some(ratio.max(0.0)))
}

fn resolve_group_group_ratio(
    user_group: &str,
    using_group: &str,
    raw: &str,
) -> worker::Result<Option<f64>> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(None);
    }
    let values =
        serde_json::from_str::<HashMap<String, HashMap<String, Value>>>(raw).map_err(|err| {
            worker::Error::RustError(format!(
                "group-group ratio option must be a nested JSON object: {err}"
            ))
        })?;
    let Some(value) = values
        .get(user_group)
        .and_then(|using_groups| using_groups.get(using_group))
    else {
        return Ok(None);
    };
    let ratio = value
        .as_f64()
        .or_else(|| value.as_str().and_then(|value| value.trim().parse().ok()))
        .ok_or_else(|| {
            worker::Error::RustError(format!(
                "group-group ratio for {user_group}/{using_group} must be numeric"
            ))
        })?;
    Ok(Some(ratio.max(0.0)))
}

pub(crate) fn resolve_effective_group_ratios_from_options(
    user_group: &str,
    groups: &[String],
    group_group_ratio: Option<&str>,
    legacy_group_group_ratio: Option<&str>,
    group_ratio: Option<&str>,
    legacy_group_ratio: Option<&str>,
) -> worker::Result<HashMap<String, f64>> {
    let mut resolved = HashMap::new();
    for group in groups {
        if resolved.contains_key(group) {
            continue;
        }
        let mut ratio = None;
        if let Some(raw) = group_group_ratio {
            ratio = resolve_group_group_ratio(user_group, group, raw)?;
        }
        if ratio.is_none() {
            if let Some(raw) = legacy_group_group_ratio {
                ratio = resolve_group_group_ratio(user_group, group, raw)?;
            }
        }
        if ratio.is_none() {
            if let Some(raw) = group_ratio {
                ratio = resolve_group_ratio(group, raw)?;
            }
        }
        if ratio.is_none() {
            if let Some(raw) = legacy_group_ratio {
                ratio = resolve_group_ratio(group, raw)?;
            }
        }
        let ratio = ratio.unwrap_or(1.0);
        resolved.insert(group.clone(), ratio);
    }
    Ok(resolved)
}

// ---------------------------------------------------------------------------
// Admin audit log writer (G5/G6 security).
//
// Writes `type=3` (LogTypeManage) rows into the shared `logs` table,
// mirroring Go's `model.RecordOperationAuditLog`. Each row carries the
// operator identity in `other.admin_info` and the action+params in
// `other.op`. Self-log queries (`/api/log/self`) strip `other` so target
// users see the action but not the operator identity (see
// `admin_crud::mut_strip_self_log`).
//
// Secret values (option values, token keys) are NEVER written into the
// audit `params` — only the key name / token id / token name is recorded.
// ---------------------------------------------------------------------------

/// Operator identity attached to every admin audit row. Mirrors Go's
/// `admin_info` JSON object.
#[derive(Debug, Clone)]
pub struct AdminAuditInfo {
    pub admin_id: i64,
    pub admin_username: String,
    pub admin_role: i32,
    /// Auth method: "session" (Rust currently only supports cookie sessions;
    /// the Go `access_token` path is not yet ported).
    pub auth_method: String,
    pub ip: String,
}

/// Log type constant for manage/admin audit rows. Mirrors Go `LogTypeManage`.
pub const LOG_TYPE_MANAGE: i32 = 3;

/// Insert an admin audit log row. `target_user_id`/`target_username` are the
/// affected user (for user-scoped actions like `user.quota_add`); for
/// channel/option actions they are `None` and the row is attributed to the
/// operator. The `params` JSON carries action-specific metadata (but never
/// secret values).
pub async fn insert_admin_audit_log(
    db: &D1Database,
    target_user_id: Option<i64>,
    target_username: Option<&str>,
    actor_username: &str,
    action: &str,
    content: &str,
    params: &serde_json::Value,
    admin_info: &AdminAuditInfo,
    now: i64,
) -> worker::Result<()> {
    let user_id = target_user_id.unwrap_or(admin_info.admin_id);
    let username = target_username.unwrap_or(actor_username);
    let other = serde_json::json!({
        "op": {
            "action": action,
            "params": params,
        },
        "admin_info": {
            "admin_id": admin_info.admin_id,
            "admin_username": admin_info.admin_username,
            "admin_role": admin_info.admin_role,
            "auth_method": admin_info.auth_method,
        },
    });
    let other_str = other.to_string();
    let args = [
        D1Type::Integer(d1_i32(user_id)),
        D1Type::Integer(d1_i32(now)),
        D1Type::Integer(LOG_TYPE_MANAGE),
        D1Type::Text(content),
        D1Type::Text(username),
        D1Type::Text(admin_info.ip.as_str()),
        D1Type::Text(other_str.as_str()),
    ];
    db.prepare(
        r#"
        INSERT INTO logs (
          user_id, created_at, type, content, username, ip, other
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7
        )
        "#,
    )
    .bind_refs(&args)?
    .run()
    .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Admin user / setup queries (login, self, setup bootstrap).
//
// These back the `/api/user/login`, `/api/user/logout`, `/api/user/self`,
// `/api/setup` routes introduced for G5 (admin/frontend parity). Mirrors the
// Go gateway's `controller/user.go` and `controller/setup.go` behavior while
// keeping SQL behind this repository module.
// ---------------------------------------------------------------------------

/// Full row needed by `/api/user/self` and login success responses. Mirrors
/// the Go `GetUser`/`setupLogin` field selection.
#[derive(Debug, Deserialize, PartialEq)]
pub struct AdminUserRow {
    pub id: i64,
    pub username: String,
    pub display_name: String,
    pub role: i32,
    pub status: i32,
    pub email: String,
    pub github_id: String,
    pub discord_id: String,
    pub oidc_id: String,
    pub wechat_id: String,
    pub telegram_id: String,
    pub linux_do_id: String,
    pub password: String,
    pub quota: i64,
    pub used_quota: i64,
    pub request_count: i64,
    pub group: String,
    pub aff_count: i64,
    pub aff_quota: i64,
    pub aff_history_quota: i64,
    pub created_at: i64,
    pub last_login_at: i64,
}

/// Columns selected for `/api/user/self`. The shape matches Go
/// `controller/user.go:433` so the existing React dashboard renders without
/// field-name changes. Sensitive columns (`password`, `access_token`,
/// `remark`) are excluded from this projection.
const ADMIN_USER_SELF_COLUMNS: &str = r#"
  id, username, display_name, role, status, email, github_id, discord_id,
  oidc_id, wechat_id, telegram_id, linux_do_id, password, quota, used_quota,
  request_count, "group", aff_count, aff_quota, aff_history AS aff_history_quota,
  created_at, last_login_at
"#;

/// Find an enabled user by username or email (login lookup). Mirrors Go
/// `model/user.go:607` (`WHERE username = ? OR email = ?`).
pub async fn find_user_by_username_or_email(
    db: &D1Database,
    username_or_email: &str,
) -> worker::Result<Option<AdminUserRow>> {
    let arg = D1Type::Text(username_or_email);
    db.prepare(&format!(
        r#"
        SELECT {ADMIN_USER_SELF_COLUMNS}
        FROM users
        WHERE (username = ?1 OR email = ?1)
          AND deleted_at IS NULL
        LIMIT 1
        "#,
    ))
    .bind_refs(&[arg])?
    .first::<AdminUserRow>(None)
    .await
}

/// Return whether an email is already present on any user row, including
/// soft-deleted accounts. Mirrors Go `IsEmailAlreadyTaken` (`Unscoped()`).
pub async fn email_exists_any_status(db: &D1Database, email: &str) -> worker::Result<bool> {
    let email = email.trim();
    if email.is_empty() {
        return Ok(false);
    }
    #[derive(Deserialize)]
    struct CountRow {
        count: i64,
    }

    Ok(db
        .prepare("SELECT COUNT(*) AS count FROM users WHERE email = ?1")
        .bind_refs(&[D1Type::Text(email)])?
        .first::<CountRow>(None)
        .await?
        .map(|row| row.count > 0)
        .unwrap_or(false))
}

/// Find an enabled user by their linked GitHub id (the GitHub login string).
/// Mirrors Go `FillUserByGitHubId` — empty ids never match.
pub async fn find_user_by_github_id(
    db: &D1Database,
    github_id: &str,
) -> worker::Result<Option<AdminUserRow>> {
    if github_id.is_empty() {
        return Ok(None);
    }
    db.prepare(&format!(
        r#"
        SELECT {ADMIN_USER_SELF_COLUMNS}
        FROM users
        WHERE github_id = ?1 AND deleted_at IS NULL
        LIMIT 1
        "#,
    ))
    .bind_refs(&[D1Type::Text(github_id)])?
    .first::<AdminUserRow>(None)
    .await
}

/// Create a user from a GitHub OAuth login (Go GitHubOAuth register branch).
/// `github_id` is the GitHub login; `username` and `aff_code` must be unique
/// (the caller generates a CSPRNG `aff_code`). The account has no password
/// (login is via GitHub only). Returns the new user id.
pub async fn create_github_user(
    db: &D1Database,
    username: &str,
    github_id: &str,
    display_name: &str,
    email: &str,
    aff_code: &str,
    now: i64,
) -> worker::Result<i64> {
    db.prepare(
        r#"
        INSERT INTO users (
          username, password, display_name, github_id, email, role, status,
          quota, "group", aff_code, created_at, last_login_at
        )
        VALUES (?1, '', ?2, ?3, ?4, 1, 1, 0, 'default', ?5, ?6, ?6)
        "#,
    )
    .bind_refs(&[
        D1Type::Text(username),
        D1Type::Text(display_name),
        D1Type::Text(github_id),
        D1Type::Text(email),
        D1Type::Text(aff_code),
        D1Type::Integer(d1_i32(now)),
    ])?
    .run()
    .await?;
    let row = find_user_by_github_id(db, github_id).await?;
    row.map(|user| user.id)
        .ok_or_else(|| worker::Error::RustError("github user insert not found after create".into()))
}

/// Link a GitHub login to an existing user account (OAuth bind). Mirrors Go
/// `GitHubBind`. The caller verifies the login is not already linked elsewhere.
pub async fn bind_github_id(db: &D1Database, user_id: i64, github_id: &str) -> worker::Result<()> {
    db.prepare("UPDATE users SET github_id = ?2 WHERE id = ?1")
        .bind_refs(&[D1Type::Integer(d1_i32(user_id)), D1Type::Text(github_id)])?
        .run()
        .await?;
    Ok(())
}

/// Find an enabled user by their linked OIDC subject (`sub`). Empty ids never
/// match. OIDC backs Google and any generic OpenID Connect provider.
pub async fn find_user_by_oidc_id(
    db: &D1Database,
    oidc_id: &str,
) -> worker::Result<Option<AdminUserRow>> {
    if oidc_id.is_empty() {
        return Ok(None);
    }
    db.prepare(&format!(
        r#"
        SELECT {ADMIN_USER_SELF_COLUMNS}
        FROM users
        WHERE oidc_id = ?1 AND deleted_at IS NULL
        LIMIT 1
        "#,
    ))
    .bind_refs(&[D1Type::Text(oidc_id)])?
    .first::<AdminUserRow>(None)
    .await
}

/// Create a user from an OIDC login. `oidc_id` is the subject; `username` and
/// `aff_code` must be unique (the caller generates a CSPRNG `aff_code`). No
/// password (login is via the provider only). Returns the new user id.
pub async fn create_oidc_user(
    db: &D1Database,
    username: &str,
    oidc_id: &str,
    display_name: &str,
    email: &str,
    aff_code: &str,
    now: i64,
) -> worker::Result<i64> {
    db.prepare(
        r#"
        INSERT INTO users (
          username, password, display_name, oidc_id, email, role, status,
          quota, "group", aff_code, created_at, last_login_at
        )
        VALUES (?1, '', ?2, ?3, ?4, 1, 1, 0, 'default', ?5, ?6, ?6)
        "#,
    )
    .bind_refs(&[
        D1Type::Text(username),
        D1Type::Text(display_name),
        D1Type::Text(oidc_id),
        D1Type::Text(email),
        D1Type::Text(aff_code),
        D1Type::Integer(d1_i32(now)),
    ])?
    .run()
    .await?;
    let row = find_user_by_oidc_id(db, oidc_id).await?;
    row.map(|user| user.id)
        .ok_or_else(|| worker::Error::RustError("oidc user insert not found after create".into()))
}

/// Link an OIDC subject to an existing user account (OAuth bind). The caller
/// verifies the subject is not already linked elsewhere.
pub async fn bind_oidc_id(db: &D1Database, user_id: i64, oidc_id: &str) -> worker::Result<()> {
    db.prepare("UPDATE users SET oidc_id = ?2 WHERE id = ?1")
        .bind_refs(&[D1Type::Integer(d1_i32(user_id)), D1Type::Text(oidc_id)])?
        .run()
        .await?;
    Ok(())
}

/// Find an enabled user by their linked Discord id. Empty ids never match.
pub async fn find_user_by_discord_id(
    db: &D1Database,
    discord_id: &str,
) -> worker::Result<Option<AdminUserRow>> {
    if discord_id.is_empty() {
        return Ok(None);
    }
    db.prepare(&format!(
        r#"
        SELECT {ADMIN_USER_SELF_COLUMNS}
        FROM users
        WHERE discord_id = ?1 AND deleted_at IS NULL
        LIMIT 1
        "#,
    ))
    .bind_refs(&[D1Type::Text(discord_id)])?
    .first::<AdminUserRow>(None)
    .await
}

/// Create a user from a Discord login. `discord_id` is the Discord user id;
/// `username` and `aff_code` must be unique (the caller generates a CSPRNG
/// `aff_code`). No password (login is via the provider only).
pub async fn create_discord_user(
    db: &D1Database,
    username: &str,
    discord_id: &str,
    display_name: &str,
    email: &str,
    aff_code: &str,
    now: i64,
) -> worker::Result<i64> {
    db.prepare(
        r#"
        INSERT INTO users (
          username, password, display_name, discord_id, email, role, status,
          quota, "group", aff_code, created_at, last_login_at
        )
        VALUES (?1, '', ?2, ?3, ?4, 1, 1, 0, 'default', ?5, ?6, ?6)
        "#,
    )
    .bind_refs(&[
        D1Type::Text(username),
        D1Type::Text(display_name),
        D1Type::Text(discord_id),
        D1Type::Text(email),
        D1Type::Text(aff_code),
        D1Type::Integer(d1_i32(now)),
    ])?
    .run()
    .await?;
    let row = find_user_by_discord_id(db, discord_id).await?;
    row.map(|user| user.id).ok_or_else(|| {
        worker::Error::RustError("discord user insert not found after create".into())
    })
}

/// Link a Discord id to an existing user account (OAuth bind). The caller
/// verifies the id is not already linked elsewhere.
pub async fn bind_discord_id(
    db: &D1Database,
    user_id: i64,
    discord_id: &str,
) -> worker::Result<()> {
    db.prepare("UPDATE users SET discord_id = ?2 WHERE id = ?1")
        .bind_refs(&[D1Type::Integer(d1_i32(user_id)), D1Type::Text(discord_id)])?
        .run()
        .await?;
    Ok(())
}

/// Return whether a WeChat id is present on any user row, including
/// soft-deleted rows. Mirrors Go `IsWeChatIdAlreadyTaken` (`Unscoped()`).
pub async fn wechat_id_exists_any_status(db: &D1Database, wechat_id: &str) -> worker::Result<bool> {
    let wechat_id = wechat_id.trim();
    if wechat_id.is_empty() {
        return Ok(false);
    }
    #[derive(Deserialize)]
    struct CountRow {
        count: i64,
    }

    Ok(db
        .prepare("SELECT COUNT(*) AS count FROM users WHERE wechat_id = ?1")
        .bind_refs(&[D1Type::Text(wechat_id)])?
        .first::<CountRow>(None)
        .await?
        .map(|row| row.count > 0)
        .unwrap_or(false))
}

/// Find an active user by their linked WeChat id. Empty ids never match.
pub async fn find_user_by_wechat_id(
    db: &D1Database,
    wechat_id: &str,
) -> worker::Result<Option<AdminUserRow>> {
    let wechat_id = wechat_id.trim();
    if wechat_id.is_empty() {
        return Ok(None);
    }
    db.prepare(&format!(
        r#"
        SELECT {ADMIN_USER_SELF_COLUMNS}
        FROM users
        WHERE wechat_id = ?1 AND deleted_at IS NULL
        LIMIT 1
        "#,
    ))
    .bind_refs(&[D1Type::Text(wechat_id)])?
    .first::<AdminUserRow>(None)
    .await
}

/// Largest current user id, used to keep Go's `wechat_<max+1>` username shape.
pub async fn max_user_id(db: &D1Database) -> worker::Result<i64> {
    #[derive(Deserialize)]
    struct MaxRow {
        max_id: Option<i64>,
    }

    Ok(db
        .prepare("SELECT MAX(id) AS max_id FROM users")
        .first::<MaxRow>(None)
        .await?
        .and_then(|row| row.max_id)
        .unwrap_or(0))
}

/// Create a user from the non-standard WeChat QR/code login flow. Mirrors Go's
/// `WeChatAuth` register branch: no password, common role, enabled status,
/// default group, and `WeChat User` display name from the caller.
pub async fn create_wechat_user(
    db: &D1Database,
    username: &str,
    wechat_id: &str,
    display_name: &str,
    aff_code: &str,
    quota: i64,
    now: i64,
) -> worker::Result<i64> {
    db.prepare(
        r#"
        INSERT INTO users (
          username, password, display_name, wechat_id, role, status,
          quota, "group", aff_code, created_at, last_login_at
        )
        VALUES (?1, '', ?2, ?3, 1, 1, ?4, 'default', ?5, ?6, ?6)
        "#,
    )
    .bind_refs(&[
        D1Type::Text(username),
        D1Type::Text(display_name),
        D1Type::Text(wechat_id),
        D1Type::Integer(d1_i32(quota)),
        D1Type::Text(aff_code),
        D1Type::Integer(d1_i32(now)),
    ])?
    .run()
    .await?;
    let row = find_user_by_wechat_id(db, wechat_id).await?;
    row.map(|user| user.id)
        .ok_or_else(|| worker::Error::RustError("wechat user insert not found after create".into()))
}

/// Link a WeChat id to an existing active user account. The caller verifies the
/// id is not already linked elsewhere.
pub async fn bind_wechat_id(
    db: &D1Database,
    user_id: i64,
    wechat_id: &str,
) -> worker::Result<bool> {
    let result = db
        .prepare("UPDATE users SET wechat_id = ?2 WHERE id = ?1 AND deleted_at IS NULL")
        .bind_refs(&[D1Type::Integer(d1_i32(user_id)), D1Type::Text(wechat_id)])?
        .run()
        .await?;
    Ok(result.meta()?.and_then(|meta| meta.changes).unwrap_or(0) > 0)
}

/// Find a user by primary key (`/api/user/self`, admin user management).
pub async fn find_user_by_id(db: &D1Database, id: i64) -> worker::Result<Option<AdminUserRow>> {
    let arg = D1Type::Integer(d1_i32(id));
    db.prepare(&format!(
        r#"
        SELECT {ADMIN_USER_SELF_COLUMNS}
        FROM users
        WHERE id = ?1
          AND deleted_at IS NULL
        LIMIT 1
        "#,
    ))
    .bind_refs(&[arg])?
    .first::<AdminUserRow>(None)
    .await
}

/// Clear a built-in account binding column (`users.github_id`, etc.) using the
/// same binding type names as Go `User.ClearBinding`. The dynamic SQL column is
/// selected from a closed whitelist before interpolation.
pub async fn clear_user_builtin_binding(
    db: &D1Database,
    id: i64,
    binding_type: &str,
) -> worker::Result<Option<bool>> {
    let column = match binding_type {
        "email" => "email",
        "github" => "github_id",
        "discord" => "discord_id",
        "oidc" => "oidc_id",
        "wechat" => "wechat_id",
        "telegram" => "telegram_id",
        "linuxdo" => "linux_do_id",
        _ => return Ok(None),
    };
    let sql = format!("UPDATE users SET {column} = '' WHERE id = ?1");
    let result = db
        .prepare(&sql)
        .bind_refs(&[D1Type::Integer(d1_i32(id))])?
        .run()
        .await?;
    Ok(Some(
        result.meta()?.and_then(|meta| meta.changes).unwrap_or(0) > 0,
    ))
}

// ---------------------------------------------------------------------------
// Two-factor authentication (2FA / TOTP) — schema in 0006_two_fa.sql.
// ---------------------------------------------------------------------------

/// A user's 2FA configuration row.
#[derive(Debug, Deserialize, PartialEq)]
pub struct TwoFaRow {
    pub id: i64,
    pub user_id: i64,
    pub secret: String,
    pub is_enabled: i64,
    pub failed_attempts: i64,
    /// Unix-seconds until which verification is locked (anti-brute-force);
    /// `None` when not locked.
    pub locked_until: Option<i64>,
}

/// An unused backup-code row (id + bcrypt hash) for login verification.
#[derive(Debug, Deserialize, PartialEq)]
pub struct BackupCodeRow {
    pub id: i64,
    pub code_hash: String,
}

/// Fetch a user's 2FA config (`None` when not enrolled).
pub async fn find_two_fa_by_user(
    db: &D1Database,
    user_id: i64,
) -> worker::Result<Option<TwoFaRow>> {
    db.prepare(
        "SELECT id, user_id, secret, is_enabled, failed_attempts, locked_until \
         FROM two_fa WHERE user_id = ?1 LIMIT 1",
    )
    .bind_refs(&[D1Type::Integer(d1_i32(user_id))])?
    .first::<TwoFaRow>(None)
    .await
}

/// Record a failed 2FA attempt: increment `failed_attempts` and, once it
/// reaches `max_attempts`, lock verification until `now + lockout_secs`
/// (anti-brute-force; Go `IncrementFailedAttempts`). Atomic in one UPDATE.
pub async fn record_two_fa_failure(
    db: &D1Database,
    user_id: i64,
    now: i64,
    max_attempts: i64,
    lockout_secs: i64,
) -> worker::Result<()> {
    db.prepare(
        "UPDATE two_fa \
         SET failed_attempts = failed_attempts + 1, \
             locked_until = CASE WHEN failed_attempts + 1 >= ?3 THEN ?2 ELSE locked_until END \
         WHERE user_id = ?1",
    )
    .bind_refs(&[
        D1Type::Integer(d1_i32(user_id)),
        D1Type::Integer(d1_i32(now + lockout_secs)),
        D1Type::Integer(d1_i32(max_attempts)),
    ])?
    .run()
    .await?;
    Ok(())
}

/// Reset the failed-attempt counter and clear any lock (Go
/// `ResetFailedAttempts`), called after a successful verification.
pub async fn reset_two_fa_attempts(db: &D1Database, user_id: i64) -> worker::Result<()> {
    db.prepare("UPDATE two_fa SET failed_attempts = 0, locked_until = NULL WHERE user_id = ?1")
        .bind_refs(&[D1Type::Integer(d1_i32(user_id))])?
        .run()
        .await?;
    Ok(())
}

/// Provision a new (disabled) TOTP secret for a user at enrollment setup. Any
/// existing config + backup codes are hard-deleted first so re-enrollment
/// replaces a stale/pending secret cleanly.
pub async fn upsert_two_fa_secret(
    db: &D1Database,
    user_id: i64,
    secret: &str,
    now: i64,
) -> worker::Result<()> {
    delete_two_fa(db, user_id).await?;
    db.prepare(
        r#"
        INSERT INTO two_fa (user_id, secret, is_enabled, failed_attempts, created_at, updated_at)
        VALUES (?1, ?2, 0, 0, ?3, ?3)
        "#,
    )
    .bind_refs(&[
        D1Type::Integer(d1_i32(user_id)),
        D1Type::Text(secret),
        D1Type::Integer(d1_i32(now)),
    ])?
    .run()
    .await?;
    Ok(())
}

/// Enable a user's 2FA after a confirming TOTP code.
pub async fn enable_two_fa(db: &D1Database, user_id: i64, now: i64) -> worker::Result<()> {
    db.prepare("UPDATE two_fa SET is_enabled = 1, updated_at = ?2 WHERE user_id = ?1")
        .bind_refs(&[
            D1Type::Integer(d1_i32(user_id)),
            D1Type::Integer(d1_i32(now)),
        ])?
        .run()
        .await?;
    Ok(())
}

/// Hard-delete a user's 2FA config and all its backup codes (disable). The TOTP
/// secret is removed entirely (divergence from Go's soft-delete; see migration
/// 0006).
pub async fn delete_two_fa(db: &D1Database, user_id: i64) -> worker::Result<()> {
    let arg = [D1Type::Integer(d1_i32(user_id))];
    db.prepare("DELETE FROM two_fa_backup_codes WHERE user_id = ?1")
        .bind_refs(&arg)?
        .run()
        .await?;
    db.prepare("DELETE FROM two_fa WHERE user_id = ?1")
        .bind_refs(&arg)?
        .run()
        .await?;
    Ok(())
}

/// Replace a user's backup codes with a fresh set of bcrypt hashes (generated
/// at enable time and shown to the user once in plaintext).
pub async fn replace_backup_codes(
    db: &D1Database,
    user_id: i64,
    code_hashes: &[String],
    now: i64,
) -> worker::Result<()> {
    db.prepare("DELETE FROM two_fa_backup_codes WHERE user_id = ?1")
        .bind_refs(&[D1Type::Integer(d1_i32(user_id))])?
        .run()
        .await?;
    for hash in code_hashes {
        db.prepare(
            "INSERT INTO two_fa_backup_codes (user_id, code_hash, is_used, created_at) VALUES (?1, ?2, 0, ?3)",
        )
        .bind_refs(&[
            D1Type::Integer(d1_i32(user_id)),
            D1Type::Text(hash),
            D1Type::Integer(d1_i32(now)),
        ])?
        .run()
        .await?;
    }
    Ok(())
}

/// All unused backup codes for a user (for login verification).
pub async fn find_unused_backup_codes(
    db: &D1Database,
    user_id: i64,
) -> worker::Result<Vec<BackupCodeRow>> {
    let rows = db
        .prepare("SELECT id, code_hash FROM two_fa_backup_codes WHERE user_id = ?1 AND is_used = 0")
        .bind_refs(&[D1Type::Integer(d1_i32(user_id))])?
        .all()
        .await?
        .results::<BackupCodeRow>()?;
    Ok(rows)
}

/// Count unused backup codes for the 2FA status response.
pub async fn count_unused_backup_codes(db: &D1Database, user_id: i64) -> worker::Result<i64> {
    #[derive(Deserialize)]
    struct CountRow {
        count: i64,
    }

    Ok(db
        .prepare(
            "SELECT COUNT(*) AS count FROM two_fa_backup_codes \
             WHERE user_id = ?1 AND is_used = 0",
        )
        .bind_refs(&[D1Type::Integer(d1_i32(user_id))])?
        .first::<CountRow>(None)
        .await?
        .map(|row| row.count)
        .unwrap_or(0))
}

/// Mark a backup code consumed (single-use).
pub async fn mark_backup_code_used(db: &D1Database, id: i64, now: i64) -> worker::Result<()> {
    db.prepare("UPDATE two_fa_backup_codes SET is_used = 1, used_at = ?2 WHERE id = ?1")
        .bind_refs(&[D1Type::Integer(d1_i32(id)), D1Type::Integer(d1_i32(now))])?
        .run()
        .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Passkey credentials — schema in 0016_passkey_credentials.sql.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
pub struct PasskeyCredentialRow {
    pub id: i64,
    pub user_id: i64,
    pub credential_id: String,
    pub public_key: String,
    pub attestation_type: String,
    pub aaguid: String,
    pub sign_count: u32,
    pub clone_warning: i32,
    pub user_present: i32,
    pub user_verified: i32,
    pub backup_eligible: i32,
    pub backup_state: i32,
    pub transports: String,
    pub attachment: String,
    pub last_used_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
}

/// Validated Passkey credential values written after a registration ceremony.
/// Binary WebAuthn values use the Go model's standard-base64 representation.
#[derive(Debug, Clone, Copy)]
pub struct PasskeyCredentialWrite<'a> {
    pub user_id: i64,
    pub credential_id: &'a str,
    pub public_key: &'a str,
    pub attestation_type: &'a str,
    pub aaguid: &'a str,
    pub sign_count: u32,
    pub clone_warning: bool,
    pub user_present: bool,
    pub user_verified: bool,
    pub backup_eligible: bool,
    pub backup_state: bool,
    pub transports: &'a str,
    pub attachment: &'a str,
    pub last_used_at: Option<i64>,
}

const FIND_PASSKEY_BY_USER_SQL: &str = r#"
    SELECT id, user_id, credential_id, public_key, attestation_type, aaguid,
           sign_count, clone_warning, user_present, user_verified,
           backup_eligible, backup_state, transports, attachment, last_used_at,
           created_at, updated_at, deleted_at
    FROM passkey_credentials
    WHERE user_id = ?1 AND deleted_at IS NULL
    LIMIT 1
"#;

const FIND_PASSKEY_BY_CREDENTIAL_ID_SQL: &str = r#"
    SELECT id, user_id, credential_id, public_key, attestation_type, aaguid,
           sign_count, clone_warning, user_present, user_verified,
           backup_eligible, backup_state, transports, attachment, last_used_at,
           created_at, updated_at, deleted_at
    FROM passkey_credentials
    WHERE credential_id = ?1 AND deleted_at IS NULL
    LIMIT 1
"#;

const INSERT_PASSKEY_CREDENTIAL_SQL: &str = r#"
    INSERT INTO passkey_credentials (
        user_id, credential_id, public_key, attestation_type, aaguid,
        sign_count, clone_warning, user_present, user_verified,
        backup_eligible, backup_state, transports, attachment, last_used_at,
        created_at, updated_at, deleted_at
    ) VALUES (
        ?1, ?2, ?3, ?4, ?5,
        ?6, ?7, ?8, ?9,
        ?10, ?11, ?12, ?13, ?14,
        ?15, ?15, NULL
    )
"#;

const UPDATE_PASSKEY_AFTER_AUTHENTICATION_SQL: &str = r#"
    UPDATE passkey_credentials
    SET sign_count = ?1,
        clone_warning = ?2,
        user_present = ?3,
        user_verified = ?4,
        backup_eligible = ?5,
        backup_state = ?6,
        last_used_at = ?7,
        updated_at = ?7
    WHERE user_id = ?8
      AND credential_id = ?9
      AND sign_count = ?10
      AND deleted_at IS NULL
"#;

fn d1_passkey_sign_count(value: u32) -> D1Type<'static> {
    if value <= i32::MAX as u32 {
        D1Type::Integer(value as i32)
    } else {
        // JavaScript numbers represent the full u32 range exactly.
        D1Type::Real(value as f64)
    }
}

fn d1_passkey_timestamp(value: i64) -> D1Type<'static> {
    if let Ok(value) = i32::try_from(value) {
        D1Type::Integer(value)
    } else {
        // Unix timestamps remain exactly representable as JavaScript numbers
        // well beyond the lifetime of this schema.
        D1Type::Real(value as f64)
    }
}

fn d1_optional_timestamp(value: Option<i64>) -> D1Type<'static> {
    value.map(d1_passkey_timestamp).unwrap_or(D1Type::Null)
}

/// Return whether the user has a non-deleted Passkey credential. Go reads via
/// GORM's default scope, so soft-deleted imported rows are ignored here.
pub async fn passkey_exists_by_user(db: &D1Database, user_id: i64) -> worker::Result<bool> {
    #[derive(Deserialize)]
    struct CountRow {
        count: i64,
    }

    Ok(db
        .prepare(
            "SELECT COUNT(*) AS count FROM passkey_credentials \
             WHERE user_id = ?1 AND deleted_at IS NULL",
        )
        .bind_refs(&[D1Type::Integer(d1_i32(user_id))])?
        .first::<CountRow>(None)
        .await?
        .map(|row| row.count > 0)
        .unwrap_or(false))
}

/// Return the active Passkey credential needed by status and begin challenge
/// routes. Binary WebAuthn fields stay base64-encoded as imported from Go.
pub async fn find_passkey_by_user(
    db: &D1Database,
    user_id: i64,
) -> worker::Result<Option<PasskeyCredentialRow>> {
    db.prepare(FIND_PASSKEY_BY_USER_SQL)
        .bind_refs(&[D1Type::Integer(d1_i32(user_id))])?
        .first::<PasskeyCredentialRow>(None)
        .await
}

/// Return an active Passkey credential by its standard-base64 credential id.
pub async fn find_passkey_by_credential_id(
    db: &D1Database,
    credential_id: &str,
) -> worker::Result<Option<PasskeyCredentialRow>> {
    db.prepare(FIND_PASSKEY_BY_CREDENTIAL_ID_SQL)
        .bind_refs(&[D1Type::Text(credential_id)])?
        .first::<PasskeyCredentialRow>(None)
        .await
}

/// Atomically replace the user's single Passkey credential after registration.
/// The plain insert intentionally fails on a credential id owned by another
/// user; D1 rolls the preceding delete back with the rest of the batch.
pub async fn replace_passkey_credential(
    db: &D1Database,
    credential: PasskeyCredentialWrite<'_>,
    now: i64,
) -> worker::Result<()> {
    let delete = db
        .prepare("DELETE FROM passkey_credentials WHERE user_id = ?1")
        .bind_refs(&[D1Type::Integer(d1_i32(credential.user_id))])?;
    let args = [
        D1Type::Integer(d1_i32(credential.user_id)),
        D1Type::Text(credential.credential_id),
        D1Type::Text(credential.public_key),
        D1Type::Text(credential.attestation_type),
        D1Type::Text(credential.aaguid),
        d1_passkey_sign_count(credential.sign_count),
        D1Type::Boolean(credential.clone_warning),
        D1Type::Boolean(credential.user_present),
        D1Type::Boolean(credential.user_verified),
        D1Type::Boolean(credential.backup_eligible),
        D1Type::Boolean(credential.backup_state),
        D1Type::Text(credential.transports),
        D1Type::Text(credential.attachment),
        d1_optional_timestamp(credential.last_used_at),
        d1_passkey_timestamp(now),
    ];
    let insert = db.prepare(INSERT_PASSKEY_CREDENTIAL_SQL).bind_refs(&args)?;
    let results = db.batch(vec![delete, insert]).await?;
    require_batch_change(&results, 1, "passkey credential insert failed")
}

/// Persist authenticator state after a successful assertion. The previously
/// read sign counter is an optimistic concurrency guard against stale writes.
pub async fn update_passkey_after_authentication(
    db: &D1Database,
    user_id: i64,
    credential_id: &str,
    expected_sign_count: u32,
    sign_count: u32,
    clone_warning: bool,
    user_present: bool,
    user_verified: bool,
    backup_eligible: bool,
    backup_state: bool,
    now: i64,
) -> worker::Result<bool> {
    let args = [
        d1_passkey_sign_count(sign_count),
        D1Type::Boolean(clone_warning),
        D1Type::Boolean(user_present),
        D1Type::Boolean(user_verified),
        D1Type::Boolean(backup_eligible),
        D1Type::Boolean(backup_state),
        d1_passkey_timestamp(now),
        D1Type::Integer(d1_i32(user_id)),
        D1Type::Text(credential_id),
        d1_passkey_sign_count(expected_sign_count),
    ];
    let result = db
        .prepare(UPDATE_PASSKEY_AFTER_AUTHENTICATION_SQL)
        .bind_refs(&args)?
        .run()
        .await?;
    Ok(result.meta()?.and_then(|meta| meta.changes).unwrap_or(0) == 1)
}

/// Hard-delete all Passkey credentials for the user, matching Go
/// `DeletePasskeyByUserID`'s `Unscoped()` delete.
pub async fn delete_passkey_by_user(db: &D1Database, user_id: i64) -> worker::Result<bool> {
    let result = db
        .prepare("DELETE FROM passkey_credentials WHERE user_id = ?1")
        .bind_refs(&[D1Type::Integer(d1_i32(user_id))])?
        .run()
        .await?;
    Ok(result.meta()?.and_then(|meta| meta.changes).unwrap_or(0) > 0)
}

/// Return `true` if a root user (`role = 100`) exists. Used by `/api/setup`
/// to decide whether initial bootstrap is still allowed.
pub async fn root_user_exists(db: &D1Database) -> worker::Result<bool> {
    #[derive(Deserialize)]
    struct Count {
        count: i64,
    }
    let row = db
        .prepare(
            r#"
            SELECT COUNT(*) AS count
            FROM users
            WHERE role = 100
              AND deleted_at IS NULL
            "#,
        )
        .first::<Count>(None)
        .await?;
    Ok(row.map(|row| row.count > 0).unwrap_or(false))
}

/// Create the initial root user during `/api/setup`. Mirrors Go
/// `controller/setup.go:113-122`. Returns the new user id.
pub async fn create_root_user(
    db: &D1Database,
    username: &str,
    password_hash: &str,
    display_name: &str,
    quota: i64,
    created_at: i64,
) -> worker::Result<i64> {
    let args = [
        D1Type::Text(username),
        D1Type::Text(password_hash),
        D1Type::Text(display_name),
        D1Type::Integer(d1_i32(quota)),
        D1Type::Integer(d1_i32(created_at)),
    ];
    db.prepare(
        r#"
        INSERT INTO users (
          username, password, display_name, role, status, quota,
          "group", aff_code, created_at, last_login_at
        )
        VALUES (?1, ?2, ?3, 100, 1, ?4, 'default', '', ?5, 0)
        "#,
    )
    .bind_refs(&args)?
    .run()
    .await?;
    // D1 does not always surface LAST_INSERT_ROWID through the worker binding
    // in a portable way; re-read by username to recover the id.
    let row = find_user_by_username_or_email(db, username).await?;
    Ok(row.map(|row| row.id).ok_or_else(|| {
        worker::Error::RustError("root user insert not found after create".into())
    })?)
}

/// Update `last_login_at` after a successful login (best-effort).
pub async fn update_last_login_at(db: &D1Database, id: i64, timestamp: i64) -> worker::Result<()> {
    let args = [
        D1Type::Integer(d1_i32(timestamp)),
        D1Type::Integer(d1_i32(id)),
    ];
    db.prepare("UPDATE users SET last_login_at = ?1 WHERE id = ?2")
        .bind_refs(&args)?
        .run()
        .await?;
    Ok(())
}

/// Read the `setup.completed` option. Returns `false` when absent.
pub async fn setup_completed(db: &D1Database) -> worker::Result<bool> {
    Ok(option_value(db, SETUP_COMPLETED_OPTION_KEY)
        .await?
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(false))
}

/// Mark setup as completed. Idempotent.
pub async fn mark_setup_completed(db: &D1Database, completed_at: i64) -> worker::Result<()> {
    upsert_option(db, SETUP_COMPLETED_OPTION_KEY, "true").await?;
    upsert_option(db, SETUP_COMPLETED_AT_OPTION_KEY, &completed_at.to_string()).await
}

const SETUP_COMPLETED_OPTION_KEY: &str = "setup.completed";
const SETUP_COMPLETED_AT_OPTION_KEY: &str = "setup.completed_at";

async fn upsert_option(db: &D1Database, key: &str, value: &str) -> worker::Result<()> {
    let args = [D1Type::Text(key), D1Type::Text(value)];
    db.prepare(
        r#"
        INSERT INTO options ("key", value)
        VALUES (?1, ?2)
        ON CONFLICT("key") DO UPDATE SET value = excluded.value
        "#,
    )
    .bind_refs(&args)?
    .run()
    .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Admin log queries (G5 P0): list, count, stat, delete.
//
// Mirror Go `controller/log.go` and `model/log.go` (GetAllLogs, GetUserLogs,
// SumUsedQuota, DeleteOldLog). Filters build a parameterized WHERE clause; the
// `(created_at, type)` composite index added in 0002 backs the time-window +
// type scans that drive both the list pages and the rpm/tpm stat.
// ---------------------------------------------------------------------------

/// Row shape for admin log list responses. Mirrors Go `model/log.go:34`.
#[derive(Debug, Deserialize, PartialEq, serde::Serialize)]
pub struct LogRow {
    pub id: i64,
    pub user_id: i64,
    pub created_at: i64,
    #[serde(rename = "type")]
    pub kind: i32,
    pub content: String,
    pub username: String,
    pub token_name: String,
    pub model_name: String,
    pub quota: i64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub use_time: i64,
    pub is_stream: i32,
    pub channel_id: i64,
    pub token_id: i64,
    pub group: String,
    pub ip: String,
    pub request_id: String,
    pub upstream_request_id: String,
    pub other: String,
}

/// Filters applied to log list/count/stat. Any `None` field is omitted from
/// the WHERE clause. `user_id` is `Some` for the `/api/log/self` path and
/// forces the user scope (admins cannot use `/api/log/self` to read other
/// users' logs).
#[derive(Debug, Clone, Default)]
pub struct LogFilter {
    pub user_id: Option<i64>,
    pub kind: Option<i32>,
    pub start_timestamp: Option<i64>,
    pub end_timestamp: Option<i64>,
    pub username: Option<String>,
    pub token_name: Option<String>,
    pub model_name: Option<String>,
    pub channel_id: Option<i64>,
    pub group: Option<String>,
    pub request_id: Option<String>,
    pub upstream_request_id: Option<String>,
}

/// Aggregated stats over a log filter window. `quota` is the sum of `quota`
/// over all matching rows; `rpm` and `tpm` are the request count and token
/// sum over the last 60 seconds of matching `type=2` (consume) rows.
#[derive(Debug, Default, serde::Serialize)]
pub struct LogsStat {
    pub quota: i64,
    pub rpm: i64,
    pub tpm: i64,
}

const LOG_TYPE_CONSUME: i32 = 2;
const LOG_STAT_WINDOW_SECONDS: i64 = 60;

/// Build the WHERE clause and bind parameters for a [`LogFilter`]. Returns
/// the (sql, args) pair. Parameter placeholders are `?N` starting at N=1.
fn log_filter_clause<'a>(filter: &'a LogFilter) -> (String, Vec<D1Type<'a>>) {
    let mut conditions: Vec<String> = Vec::new();
    let mut args: Vec<D1Type<'a>> = Vec::new();
    let mut idx;
    if let Some(user_id) = filter.user_id {
        idx = args.len() + 1;
        conditions.push(format!("user_id = ?{idx}"));
        args.push(D1Type::Integer(d1_i32(user_id)));
    }
    if let Some(kind) = filter.kind {
        idx = args.len() + 1;
        conditions.push(format!("type = ?{idx}"));
        args.push(D1Type::Integer(kind));
    }
    if let Some(start) = filter.start_timestamp {
        idx = args.len() + 1;
        conditions.push(format!("created_at >= ?{idx}"));
        args.push(D1Type::Integer(d1_i32(start)));
    }
    if let Some(end) = filter.end_timestamp {
        idx = args.len() + 1;
        conditions.push(format!("created_at <= ?{idx}"));
        args.push(D1Type::Integer(d1_i32(end)));
    }
    if let Some(username) = filter.username.as_deref() {
        let trimmed = username.trim();
        if !trimmed.is_empty() {
            idx = args.len() + 1;
            conditions.push(format!("username = ?{idx}"));
            args.push(D1Type::Text(trimmed));
        }
    }
    if let Some(token_name) = filter.token_name.as_deref() {
        let trimmed = token_name.trim();
        if !trimmed.is_empty() {
            idx = args.len() + 1;
            conditions.push(format!("token_name = ?{idx}"));
            args.push(D1Type::Text(trimmed));
        }
    }
    if let Some(model_name) = filter.model_name.as_deref() {
        let trimmed = model_name.trim();
        if !trimmed.is_empty() {
            idx = args.len() + 1;
            conditions.push(format!("model_name = ?{idx}"));
            args.push(D1Type::Text(trimmed));
        }
    }
    if let Some(channel_id) = filter.channel_id {
        idx = args.len() + 1;
        conditions.push(format!("channel_id = ?{idx}"));
        args.push(D1Type::Integer(d1_i32(channel_id)));
    }
    if let Some(group) = filter.group.as_deref() {
        let trimmed = group.trim();
        if !trimmed.is_empty() {
            idx = args.len() + 1;
            conditions.push(format!("\"group\" = ?{idx}"));
            args.push(D1Type::Text(trimmed));
        }
    }
    if let Some(request_id) = filter.request_id.as_deref() {
        let trimmed = request_id.trim();
        if !trimmed.is_empty() {
            idx = args.len() + 1;
            conditions.push(format!("request_id = ?{idx}"));
            args.push(D1Type::Text(trimmed));
        }
    }
    if let Some(upstream_request_id) = filter.upstream_request_id.as_deref() {
        let trimmed = upstream_request_id.trim();
        if !trimmed.is_empty() {
            idx = args.len() + 1;
            conditions.push(format!("upstream_request_id = ?{idx}"));
            args.push(D1Type::Text(trimmed));
        }
    }
    let sql = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };
    (sql, args)
}

/// List logs matching `filter`, paginated. `page` is 1-indexed; `page_size`
/// is clamped to `[1, 100]`.
pub async fn list_logs(
    db: &D1Database,
    filter: &LogFilter,
    page: u32,
    page_size: u32,
) -> worker::Result<Vec<LogRow>> {
    let page = page.max(1);
    let page_size = page_size.clamp(1, 100);
    let offset = (page - 1) * page_size;
    let (where_sql, args) = log_filter_clause(filter);
    let limit_index = args.len() + 1;
    let offset_index = limit_index + 1;
    let mut full_args = args;
    full_args.push(D1Type::Integer(page_size as i32));
    full_args.push(D1Type::Integer(offset as i32));
    let sql = format!(
        r#"
        SELECT id, user_id, created_at, type, content, username, token_name,
               model_name, quota, prompt_tokens, completion_tokens, use_time,
               is_stream, channel_id, token_id, "group", ip, request_id,
               upstream_request_id, other
        FROM logs
        {where_sql}
        ORDER BY id DESC
        LIMIT ?{limit_index} OFFSET ?{offset_index}
        "#,
    );
    Ok(db
        .prepare(&sql)
        .bind_refs(&full_args)?
        .all()
        .await?
        .results::<LogRow>()?)
}

/// Count logs matching `filter`.
pub async fn count_logs(db: &D1Database, filter: &LogFilter) -> worker::Result<i64> {
    #[derive(Deserialize)]
    struct Count {
        count: i64,
    }
    let (where_sql, args) = log_filter_clause(filter);
    let sql = format!("SELECT COUNT(*) AS count FROM logs {where_sql}");
    let row = db
        .prepare(&sql)
        .bind_refs(&args)?
        .first::<Count>(None)
        .await?;
    Ok(row.map(|r| r.count).unwrap_or(0))
}

/// Aggregate stats over a log filter. `quota` is the window total; `rpm` and
/// `tpm` are computed over the last 60 seconds of consume rows. Mirrors Go
/// `model/log.go::SumUsedQuota`.
pub async fn logs_stat(
    db: &D1Database,
    filter: &LogFilter,
    now_unix: i64,
) -> worker::Result<LogsStat> {
    // Quota total over the filter window.
    #[derive(Deserialize)]
    struct QuotaSum {
        quota: Option<i64>,
    }
    let (where_sql, args) = log_filter_clause(filter);
    let quota_sql = format!("SELECT COALESCE(SUM(quota), 0) AS quota FROM logs {where_sql}");
    let quota_row = db
        .prepare(&quota_sql)
        .bind_refs(&args)?
        .first::<QuotaSum>(None)
        .await?;
    let quota_total = quota_row.and_then(|r| r.quota).unwrap_or(0);

    // rpm/tpm over the last 60s of consume rows, applying the same filter
    // (minus the time window, which we override).
    let mut recent_filter = filter.clone();
    recent_filter.kind = Some(LOG_TYPE_CONSUME);
    recent_filter.start_timestamp = Some(now_unix - LOG_STAT_WINDOW_SECONDS);
    recent_filter.end_timestamp = None;
    let (recent_where, recent_args) = log_filter_clause(&recent_filter);
    #[derive(Deserialize)]
    struct RateStat {
        rpm: Option<i64>,
        tpm: Option<i64>,
    }
    let rate_sql = format!(
        r#"
        SELECT COUNT(*) AS rpm,
               COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tpm
        FROM logs
        {recent_where}
        "#,
    );
    let rate_row = db
        .prepare(&rate_sql)
        .bind_refs(&recent_args)?
        .first::<RateStat>(None)
        .await?;
    let rate = rate_row.unwrap_or(RateStat {
        rpm: None,
        tpm: None,
    });
    Ok(LogsStat {
        quota: quota_total,
        rpm: rate.rpm.unwrap_or(0),
        tpm: rate.tpm.unwrap_or(0),
    })
}

/// Delete logs older than `target_timestamp`. Returns the number of deleted
/// rows. Mirrors Go `DeleteOldLog`. D1 does not surface affected-rows
/// reliably for DELETE through the worker binding, so the count is read via a
/// preceding COUNT.
pub async fn delete_logs_before(db: &D1Database, target_timestamp: i64) -> worker::Result<i64> {
    #[derive(Deserialize)]
    struct Count {
        count: i64,
    }
    let arg = D1Type::Integer(d1_i32(target_timestamp));
    let count = db
        .prepare("SELECT COUNT(*) AS count FROM logs WHERE created_at < ?1")
        .bind_refs(&[arg])?
        .first::<Count>(None)
        .await?
        .map(|r| r.count)
        .unwrap_or(0);
    let arg2 = D1Type::Integer(d1_i32(target_timestamp));
    db.prepare("DELETE FROM logs WHERE created_at < ?1")
        .bind_refs(&[arg2])?
        .run()
        .await?;
    Ok(count)
}

// ---------------------------------------------------------------------------
// Admin option queries (G5 P0): list (filtered), get, upsert.
//
// Mirrors Go `controller/option.go::GetOptions`. Sensitive keys
// (*Token/*Secret/*Key/*secret/api_key) are filtered out of list responses so
// a root admin's eyeball on the settings page cannot accidentally read stored
// credentials. `upsert_option` is reused for `PUT /api/option/`.
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, PartialEq, serde::Serialize)]
pub struct OptionRow {
    pub key: String,
    pub value: String,
}

/// Read every option row. The caller is responsible for filtering sensitive
/// keys before returning them to the client (see
/// `is_sensitive_option_key`).
pub async fn list_all_options(db: &D1Database) -> worker::Result<Vec<OptionRow>> {
    let empty: &[D1Type<'_>] = &[];
    Ok(db
        .prepare(r#"SELECT "key", value FROM options ORDER BY "key" ASC"#)
        .bind_refs(empty)?
        .all()
        .await?
        .results::<OptionRow>()?)
}

/// Read a single option value by key.
#[allow(dead_code)] // wired by future option-specific admin routes
pub async fn get_option(db: &D1Database, key: &str) -> worker::Result<Option<String>> {
    option_value(db, key).await
}

/// Upsert an option value. Now public so `PUT /api/option/` can call it
/// directly.
pub async fn upsert_option_pub(db: &D1Database, key: &str, value: &str) -> worker::Result<()> {
    upsert_option(db, key, value).await
}

/// Upsert multiple option values in one D1 batch.
pub async fn upsert_options_pub(db: &D1Database, values: &[(&str, String)]) -> worker::Result<()> {
    if values.is_empty() {
        return Ok(());
    }
    let mut statements = Vec::with_capacity(values.len());
    for (key, value) in values {
        let args = [D1Type::Text(*key), D1Type::Text(value.as_str())];
        statements.push(
            db.prepare(
                r#"
                INSERT INTO options ("key", value)
                VALUES (?1, ?2)
                ON CONFLICT("key") DO UPDATE SET value = excluded.value
                "#,
            )
            .bind_refs(&args)?,
        );
    }
    db.batch(statements).await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Custom OAuth provider config (G5 auth-admin slice).
//
// Mirrors Go `model/custom_oauth_provider.go` and
// `model/user_oauth_binding.go` for the root-admin provider CRUD surface. The
// secret-bearing row stays internal; handler responses must not return
// `client_secret`.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct CustomOAuthProviderRow {
    pub id: i64,
    pub name: String,
    pub slug: String,
    pub icon: String,
    pub enabled: i32,
    pub client_id: String,
    pub client_secret: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub user_info_endpoint: String,
    pub scopes: String,
    pub user_id_field: String,
    pub username_field: String,
    pub display_name_field: String,
    pub email_field: String,
    pub well_known: String,
    pub auth_style: i32,
    pub access_policy: String,
    pub access_denied_message: String,
    pub created_at: i64,
    pub updated_at: i64,
}

const CUSTOM_OAUTH_PROVIDER_COLUMNS: &str = r#"
  id, name, slug, icon, enabled, client_id, client_secret,
  authorization_endpoint, token_endpoint, user_info_endpoint, scopes,
  user_id_field, username_field, display_name_field, email_field, well_known,
  auth_style, access_policy, access_denied_message, created_at, updated_at
"#;

#[derive(Debug, Clone)]
pub struct CreateCustomOAuthProvider<'a> {
    pub name: &'a str,
    pub slug: &'a str,
    pub icon: &'a str,
    pub enabled: bool,
    pub client_id: &'a str,
    pub client_secret: &'a str,
    pub authorization_endpoint: &'a str,
    pub token_endpoint: &'a str,
    pub user_info_endpoint: &'a str,
    pub scopes: &'a str,
    pub user_id_field: &'a str,
    pub username_field: &'a str,
    pub display_name_field: &'a str,
    pub email_field: &'a str,
    pub well_known: &'a str,
    pub auth_style: i32,
    pub access_policy: &'a str,
    pub access_denied_message: &'a str,
    pub now: i64,
}

#[derive(Debug, Clone, Default)]
pub struct UpdateCustomOAuthProvider<'a> {
    pub id: i64,
    pub name: Option<&'a str>,
    pub slug: Option<&'a str>,
    pub icon: Option<&'a str>,
    pub enabled: Option<bool>,
    pub client_id: Option<&'a str>,
    pub client_secret: Option<&'a str>,
    pub authorization_endpoint: Option<&'a str>,
    pub token_endpoint: Option<&'a str>,
    pub user_info_endpoint: Option<&'a str>,
    pub scopes: Option<&'a str>,
    pub user_id_field: Option<&'a str>,
    pub username_field: Option<&'a str>,
    pub display_name_field: Option<&'a str>,
    pub email_field: Option<&'a str>,
    pub well_known: Option<&'a str>,
    pub auth_style: Option<i32>,
    pub access_policy: Option<&'a str>,
    pub access_denied_message: Option<&'a str>,
    pub updated_at: i64,
}

pub async fn list_custom_oauth_providers(
    db: &D1Database,
) -> worker::Result<Vec<CustomOAuthProviderRow>> {
    let sql = format!(
        "SELECT {CUSTOM_OAUTH_PROVIDER_COLUMNS} FROM custom_oauth_providers ORDER BY id ASC"
    );
    Ok(db
        .prepare(&sql)
        .bind_refs(&[] as &[D1Type<'_>])?
        .all()
        .await?
        .results::<CustomOAuthProviderRow>()?)
}

pub async fn list_enabled_custom_oauth_providers(
    db: &D1Database,
) -> worker::Result<Vec<CustomOAuthProviderRow>> {
    let sql = format!(
        "SELECT {CUSTOM_OAUTH_PROVIDER_COLUMNS} FROM custom_oauth_providers WHERE enabled = 1 ORDER BY id ASC"
    );
    Ok(db
        .prepare(&sql)
        .bind_refs(&[] as &[D1Type<'_>])?
        .all()
        .await?
        .results::<CustomOAuthProviderRow>()?)
}

pub async fn find_custom_oauth_provider_by_id(
    db: &D1Database,
    id: i64,
) -> worker::Result<Option<CustomOAuthProviderRow>> {
    let arg = D1Type::Integer(d1_i32(id));
    let sql = format!(
        "SELECT {CUSTOM_OAUTH_PROVIDER_COLUMNS} FROM custom_oauth_providers WHERE id = ?1 LIMIT 1"
    );
    db.prepare(&sql)
        .bind_refs(&[arg])?
        .first::<CustomOAuthProviderRow>(None)
        .await
}

pub async fn find_enabled_custom_oauth_provider_by_slug_or_id(
    db: &D1Database,
    provider: &str,
) -> worker::Result<Option<CustomOAuthProviderRow>> {
    let provider = provider.trim();
    if provider.is_empty() {
        return Ok(None);
    }
    let sql_by_id = format!(
        "SELECT {CUSTOM_OAUTH_PROVIDER_COLUMNS} FROM custom_oauth_providers WHERE id = ?1 AND enabled = 1 LIMIT 1"
    );
    if let Ok(id) = provider.parse::<i64>() {
        if id > 0 && id <= i32::MAX as i64 {
            let row = db
                .prepare(&sql_by_id)
                .bind_refs(&[D1Type::Integer(d1_i32(id))])?
                .first::<CustomOAuthProviderRow>(None)
                .await?;
            if row.is_some() {
                return Ok(row);
            }
        }
    }
    let sql_by_slug = format!(
        "SELECT {CUSTOM_OAUTH_PROVIDER_COLUMNS} FROM custom_oauth_providers WHERE slug = ?1 AND enabled = 1 LIMIT 1"
    );
    db.prepare(&sql_by_slug)
        .bind_refs(&[D1Type::Text(provider)])?
        .first::<CustomOAuthProviderRow>(None)
        .await
}

pub async fn custom_oauth_slug_taken(
    db: &D1Database,
    slug: &str,
    exclude_id: Option<i64>,
) -> worker::Result<bool> {
    #[derive(Deserialize)]
    struct Count {
        count: i64,
    }
    let mut args = vec![D1Type::Text(slug)];
    let mut sql =
        "SELECT COUNT(*) AS count FROM custom_oauth_providers WHERE slug = ?1".to_string();
    if let Some(id) = exclude_id {
        sql.push_str(" AND id != ?2");
        args.push(D1Type::Integer(d1_i32(id)));
    }
    let row = db
        .prepare(&sql)
        .bind_refs(&args)?
        .first::<Count>(None)
        .await?;
    Ok(row.map(|r| r.count).unwrap_or(0) > 0)
}

pub async fn create_custom_oauth_provider(
    db: &D1Database,
    params: CreateCustomOAuthProvider<'_>,
) -> worker::Result<i64> {
    let args = [
        D1Type::Text(params.name),
        D1Type::Text(params.slug),
        D1Type::Text(params.icon),
        D1Type::Integer(if params.enabled { 1 } else { 0 }),
        D1Type::Text(params.client_id),
        D1Type::Text(params.client_secret),
        D1Type::Text(params.authorization_endpoint),
        D1Type::Text(params.token_endpoint),
        D1Type::Text(params.user_info_endpoint),
        D1Type::Text(params.scopes),
        D1Type::Text(params.user_id_field),
        D1Type::Text(params.username_field),
        D1Type::Text(params.display_name_field),
        D1Type::Text(params.email_field),
        D1Type::Text(params.well_known),
        D1Type::Integer(params.auth_style),
        D1Type::Text(params.access_policy),
        D1Type::Text(params.access_denied_message),
        D1Type::Integer(d1_i32(params.now)),
        D1Type::Integer(d1_i32(params.now)),
    ];
    db.prepare(
        r#"
        INSERT INTO custom_oauth_providers (
          name, slug, icon, enabled, client_id, client_secret,
          authorization_endpoint, token_endpoint, user_info_endpoint, scopes,
          user_id_field, username_field, display_name_field, email_field,
          well_known, auth_style, access_policy, access_denied_message,
          created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
          ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20
        )
        "#,
    )
    .bind_refs(&args)?
    .run()
    .await?;
    #[derive(Deserialize)]
    struct Id {
        id: i64,
    }
    let row = db
        .prepare("SELECT id FROM custom_oauth_providers WHERE slug = ?1 LIMIT 1")
        .bind_refs(&[D1Type::Text(params.slug)])?
        .first::<Id>(None)
        .await?;
    Ok(row.map(|r| r.id).unwrap_or(0))
}

pub async fn update_custom_oauth_provider(
    db: &D1Database,
    params: UpdateCustomOAuthProvider<'_>,
) -> worker::Result<bool> {
    let mut sets: Vec<String> = Vec::new();
    let mut args: Vec<D1Type<'_>> = Vec::new();

    macro_rules! push_text {
        ($field:literal, $value:expr) => {
            if let Some(value) = $value {
                let idx = args.len() + 1;
                sets.push(format!("{} = ?{}", $field, idx));
                args.push(D1Type::Text(value));
            }
        };
    }

    push_text!("name", params.name);
    push_text!("slug", params.slug);
    push_text!("icon", params.icon);
    if let Some(enabled) = params.enabled {
        let idx = args.len() + 1;
        sets.push(format!("enabled = ?{idx}"));
        args.push(D1Type::Integer(if enabled { 1 } else { 0 }));
    }
    push_text!("client_id", params.client_id);
    push_text!("client_secret", params.client_secret);
    push_text!("authorization_endpoint", params.authorization_endpoint);
    push_text!("token_endpoint", params.token_endpoint);
    push_text!("user_info_endpoint", params.user_info_endpoint);
    push_text!("scopes", params.scopes);
    push_text!("user_id_field", params.user_id_field);
    push_text!("username_field", params.username_field);
    push_text!("display_name_field", params.display_name_field);
    push_text!("email_field", params.email_field);
    push_text!("well_known", params.well_known);
    if let Some(auth_style) = params.auth_style {
        let idx = args.len() + 1;
        sets.push(format!("auth_style = ?{idx}"));
        args.push(D1Type::Integer(auth_style));
    }
    push_text!("access_policy", params.access_policy);
    push_text!("access_denied_message", params.access_denied_message);

    let idx = args.len() + 1;
    sets.push(format!("updated_at = ?{idx}"));
    args.push(D1Type::Integer(d1_i32(params.updated_at)));

    let id_index = args.len() + 1;
    args.push(D1Type::Integer(d1_i32(params.id)));
    let sql = format!(
        "UPDATE custom_oauth_providers SET {} WHERE id = ?{}",
        sets.join(", "),
        id_index
    );
    let result = db.prepare(&sql).bind_refs(&args)?.run().await?;
    Ok(result.meta()?.and_then(|meta| meta.changes).unwrap_or(0) > 0)
}

pub async fn delete_custom_oauth_provider(db: &D1Database, id: i64) -> worker::Result<bool> {
    let result = db
        .prepare("DELETE FROM custom_oauth_providers WHERE id = ?1")
        .bind_refs(&[D1Type::Integer(d1_i32(id))])?
        .run()
        .await?;
    Ok(result.meta()?.and_then(|meta| meta.changes).unwrap_or(0) > 0)
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct UserOAuthBindingJoinedRow {
    pub provider_id: i64,
    pub provider_name: String,
    pub provider_slug: String,
    pub provider_icon: String,
    pub provider_user_id: String,
}

pub async fn list_user_oauth_bindings(
    db: &D1Database,
    user_id: i64,
) -> worker::Result<Vec<UserOAuthBindingJoinedRow>> {
    Ok(db
        .prepare(
            r#"
            SELECT
              b.provider_id,
              p.name AS provider_name,
              p.slug AS provider_slug,
              p.icon AS provider_icon,
              b.provider_user_id
            FROM user_oauth_bindings b
            JOIN custom_oauth_providers p ON p.id = b.provider_id
            WHERE b.user_id = ?1
            ORDER BY b.provider_id ASC
            "#,
        )
        .bind_refs(&[D1Type::Integer(d1_i32(user_id))])?
        .all()
        .await?
        .results::<UserOAuthBindingJoinedRow>()?)
}

pub async fn find_user_by_custom_oauth_binding(
    db: &D1Database,
    provider_id: i64,
    provider_user_id: &str,
) -> worker::Result<Option<AdminUserRow>> {
    if provider_id <= 0 || provider_user_id.trim().is_empty() {
        return Ok(None);
    }
    db.prepare(
        r#"
        SELECT
          u.id, u.username, u.display_name, u.role, u.status, u.email,
          u.github_id, u.discord_id, u.oidc_id, u.wechat_id, u.telegram_id,
          u.linux_do_id, u.password, u.quota, u.used_quota,
          u.request_count, u."group", u.aff_count, u.aff_quota,
          u.aff_history AS aff_history_quota, u.created_at, u.last_login_at
        FROM user_oauth_bindings b
        JOIN users u ON u.id = b.user_id
        WHERE b.provider_id = ?1
          AND b.provider_user_id = ?2
          AND u.deleted_at IS NULL
        LIMIT 1
        "#,
    )
    .bind_refs(&[
        D1Type::Integer(d1_i32(provider_id)),
        D1Type::Text(provider_user_id),
    ])?
    .first::<AdminUserRow>(None)
    .await
}

pub async fn create_custom_oauth_user_with_binding(
    db: &D1Database,
    username: &str,
    display_name: &str,
    email: &str,
    aff_code: &str,
    provider_id: i64,
    provider_user_id: &str,
    now: i64,
) -> worker::Result<i64> {
    let user_args = [
        D1Type::Text(username),
        D1Type::Text(display_name),
        D1Type::Text(email),
        D1Type::Text(aff_code),
        D1Type::Integer(d1_i32(now)),
    ];
    let user_stmt = db
        .prepare(
            r#"
            INSERT INTO users (
              username, password, display_name, email, role, status,
              quota, "group", aff_code, created_at, last_login_at
            )
            VALUES (?1, '', ?2, ?3, 1, 1, 0, 'default', ?4, ?5, ?5)
            "#,
        )
        .bind_refs(&user_args)?;

    let binding_args = [
        D1Type::Text(username),
        D1Type::Integer(d1_i32(provider_id)),
        D1Type::Text(provider_user_id),
        D1Type::Integer(d1_i32(now)),
    ];
    let binding_stmt = db
        .prepare(
            r#"
            INSERT INTO user_oauth_bindings (
              user_id, provider_id, provider_user_id, created_at
            )
            SELECT id, ?2, ?3, ?4
              FROM users
             WHERE username = ?1
             ORDER BY id DESC
             LIMIT 1
            "#,
        )
        .bind_refs(&binding_args)?;

    let results = db.batch(vec![user_stmt, binding_stmt]).await?;
    require_batch_change(
        &results,
        0,
        "custom OAuth user insert did not create a user",
    )?;
    require_batch_change(
        &results,
        1,
        "custom OAuth binding insert did not create a binding",
    )?;

    #[derive(Deserialize)]
    struct Id {
        id: i64,
    }
    let row = db
        .prepare("SELECT id FROM users WHERE username = ?1 ORDER BY id DESC LIMIT 1")
        .bind_refs(&[D1Type::Text(username)])?
        .first::<Id>(None)
        .await?;
    Ok(row.map(|r| r.id).ok_or_else(|| {
        worker::Error::RustError("custom OAuth user insert not found after batch create".into())
    })?)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CustomOAuthBindingUpsert {
    Inserted,
    Updated,
    Unchanged,
    Conflict,
}

pub async fn upsert_user_oauth_binding(
    db: &D1Database,
    user_id: i64,
    provider_id: i64,
    provider_user_id: &str,
    now: i64,
) -> worker::Result<CustomOAuthBindingUpsert> {
    #[derive(Deserialize)]
    struct BindingOwner {
        user_id: i64,
    }
    let provider_user_id = provider_user_id.trim();
    if user_id <= 0 || provider_id <= 0 || provider_user_id.is_empty() {
        return Err(worker::Error::RustError(
            "invalid custom OAuth binding input".to_string(),
        ));
    }
    let owner = db
        .prepare(
            "SELECT user_id FROM user_oauth_bindings WHERE provider_id = ?1 AND provider_user_id = ?2 LIMIT 1",
        )
        .bind_refs(&[
            D1Type::Integer(d1_i32(provider_id)),
            D1Type::Text(provider_user_id),
        ])?
        .first::<BindingOwner>(None)
        .await?;
    if let Some(owner) = owner {
        if owner.user_id == user_id {
            return Ok(CustomOAuthBindingUpsert::Unchanged);
        }
        return Ok(CustomOAuthBindingUpsert::Conflict);
    }

    #[derive(Deserialize)]
    struct ExistingBinding {
        provider_user_id: String,
    }
    let existing = db
        .prepare(
            "SELECT provider_user_id FROM user_oauth_bindings WHERE user_id = ?1 AND provider_id = ?2 LIMIT 1",
        )
        .bind_refs(&[
            D1Type::Integer(d1_i32(user_id)),
            D1Type::Integer(d1_i32(provider_id)),
        ])?
        .first::<ExistingBinding>(None)
        .await?;
    if let Some(existing) = existing {
        if existing.provider_user_id == provider_user_id {
            return Ok(CustomOAuthBindingUpsert::Unchanged);
        }
        db.prepare(
            "UPDATE user_oauth_bindings SET provider_user_id = ?3 WHERE user_id = ?1 AND provider_id = ?2",
        )
        .bind_refs(&[
            D1Type::Integer(d1_i32(user_id)),
            D1Type::Integer(d1_i32(provider_id)),
            D1Type::Text(provider_user_id),
        ])?
        .run()
        .await?;
        return Ok(CustomOAuthBindingUpsert::Updated);
    }

    db.prepare(
        "INSERT INTO user_oauth_bindings (user_id, provider_id, provider_user_id, created_at) VALUES (?1, ?2, ?3, ?4)",
    )
    .bind_refs(&[
        D1Type::Integer(d1_i32(user_id)),
        D1Type::Integer(d1_i32(provider_id)),
        D1Type::Text(provider_user_id),
        D1Type::Integer(d1_i32(now)),
    ])?
    .run()
    .await?;
    Ok(CustomOAuthBindingUpsert::Inserted)
}

pub async fn delete_user_oauth_binding(
    db: &D1Database,
    user_id: i64,
    provider_id: i64,
) -> worker::Result<bool> {
    let args = [
        D1Type::Integer(d1_i32(user_id)),
        D1Type::Integer(d1_i32(provider_id)),
    ];
    let result = db
        .prepare("DELETE FROM user_oauth_bindings WHERE user_id = ?1 AND provider_id = ?2")
        .bind_refs(&args)?
        .run()
        .await?;
    Ok(result.meta()?.and_then(|meta| meta.changes).unwrap_or(0) > 0)
}

pub async fn count_custom_oauth_bindings(db: &D1Database, provider_id: i64) -> worker::Result<i64> {
    #[derive(Deserialize)]
    struct Count {
        count: i64,
    }
    let row = db
        .prepare("SELECT COUNT(*) AS count FROM user_oauth_bindings WHERE provider_id = ?1")
        .bind_refs(&[D1Type::Integer(d1_i32(provider_id))])?
        .first::<Count>(None)
        .await?;
    Ok(row.map(|r| r.count).unwrap_or(0))
}

/// Return true when an option key likely guards a secret (API keys, OAuth
/// client secrets, payment secrets, etc.). Mirrors the Go `GetOptions`
/// sensitive-key filter regex.
pub fn is_sensitive_option_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    lower.ends_with("token")
        || lower.ends_with("secret")
        || lower.ends_with("key")
        || lower.ends_with("api_key")
        || lower.contains("password")
}

// ---------------------------------------------------------------------------
// Admin token queries (G5 P0): list, search, get, create, update, delete.
//
// All queries are scoped by `user_id` so a user can only see and mutate their
// own tokens. Mirrors Go `controller/token.go`. Keys are returned in full
// only by `find_token_by_id_and_user` and `find_token_keys_by_ids_and_user`
// (used by reveal endpoints); list and search responses mask the key in the
// handler layer.
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, PartialEq, serde::Serialize)]
pub struct TokenRow {
    pub id: i64,
    pub user_id: i64,
    pub key: String,
    pub status: i32,
    pub name: String,
    pub created_time: i64,
    pub accessed_time: i64,
    pub expired_time: i64,
    pub remain_quota: i64,
    pub unlimited_quota: i32,
    pub model_limits_enabled: i32,
    pub model_limits: String,
    pub allow_ips: String,
    pub used_quota: i64,
    pub group: String,
    pub cross_group_retry: i32,
}

/// Minimal secret-bearing row for the batch key reveal endpoint. The name is
/// included only so each successful reveal can be audited without recording
/// the key itself.
#[derive(Debug, Deserialize, PartialEq)]
pub struct TokenKeyRow {
    pub id: i64,
    pub key: String,
    pub name: String,
}

/// List a user's tokens, newest first, paginated. `page` is 1-indexed.
pub async fn list_tokens(
    db: &D1Database,
    user_id: i64,
    page: u32,
    page_size: u32,
) -> worker::Result<Vec<TokenRow>> {
    let page = page.max(1);
    let page_size = page_size.clamp(1, 100);
    let offset = (page - 1) * page_size;
    let args = [
        D1Type::Integer(d1_i32(user_id)),
        D1Type::Integer(page_size as i32),
        D1Type::Integer(offset as i32),
    ];
    Ok(db
        .prepare(
            r#"
        SELECT id, user_id, "key", status, name, created_time, accessed_time,
               expired_time, remain_quota, unlimited_quota, model_limits_enabled,
               model_limits, allow_ips, used_quota, "group", cross_group_retry
        FROM tokens
        WHERE user_id = ?1 AND deleted_at IS NULL
        ORDER BY id DESC
        LIMIT ?2 OFFSET ?3
        "#,
        )
        .bind_refs(&args)?
        .all()
        .await?
        .results::<TokenRow>()?)
}

/// Search a user's tokens by keyword (matches name or key suffix).
pub async fn search_tokens(
    db: &D1Database,
    user_id: i64,
    keyword: &str,
    page: u32,
    page_size: u32,
) -> worker::Result<Vec<TokenRow>> {
    let page = page.max(1);
    let page_size = page_size.clamp(1, 100);
    let offset = (page - 1) * page_size;
    let like = format!("%{}%", keyword.trim());
    let args = [
        D1Type::Integer(d1_i32(user_id)),
        D1Type::Text(like.as_str()),
        D1Type::Text(like.as_str()),
        D1Type::Integer(page_size as i32),
        D1Type::Integer(offset as i32),
    ];
    Ok(db
        .prepare(
            r#"
        SELECT id, user_id, "key", status, name, created_time, accessed_time,
               expired_time, remain_quota, unlimited_quota, model_limits_enabled,
               model_limits, allow_ips, used_quota, "group", cross_group_retry
        FROM tokens
        WHERE user_id = ?1
          AND deleted_at IS NULL
          AND (name LIKE ?2 OR "key" LIKE ?3)
        ORDER BY id DESC
        LIMIT ?4 OFFSET ?5
        "#,
        )
        .bind_refs(&args)?
        .all()
        .await?
        .results::<TokenRow>()?)
}

pub async fn count_tokens(db: &D1Database, user_id: i64) -> worker::Result<i64> {
    #[derive(Deserialize)]
    struct Count {
        count: i64,
    }
    let arg = D1Type::Integer(d1_i32(user_id));
    let row = db
        .prepare("SELECT COUNT(*) AS count FROM tokens WHERE user_id = ?1 AND deleted_at IS NULL")
        .bind_refs(&[arg])?
        .first::<Count>(None)
        .await?;
    Ok(row.map(|r| r.count).unwrap_or(0))
}

/// Find a token by id, scoped to `user_id`. Returns the full key — callers
/// must only use this for reveal or internal mutation, never for list
/// responses. Returns `None` if the token does not exist, belongs to a
/// different user, or is soft-deleted.
pub async fn find_token_by_id_and_user(
    db: &D1Database,
    id: i64,
    user_id: i64,
) -> worker::Result<Option<TokenRow>> {
    let args = [
        D1Type::Integer(d1_i32(id)),
        D1Type::Integer(d1_i32(user_id)),
    ];
    db.prepare(
        r#"
        SELECT id, user_id, "key", status, name, created_time, accessed_time,
               expired_time, remain_quota, unlimited_quota, model_limits_enabled,
               model_limits, allow_ips, used_quota, "group", cross_group_retry
        FROM tokens
        WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL
        LIMIT 1
        "#,
    )
    .bind_refs(&args)?
    .first::<TokenRow>(None)
    .await
}

/// Find full keys for up to 100 token ids owned by `user_id`. Unknown,
/// soft-deleted, and other users' ids are omitted, matching Go's batch reveal
/// behavior without exposing whether an inaccessible token exists.
pub async fn find_token_keys_by_ids_and_user(
    db: &D1Database,
    ids: &[i64],
    user_id: i64,
) -> worker::Result<Vec<TokenKeyRow>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    if ids.len() > 100 {
        return Err(worker::Error::RustError(
            "at most 100 token ids are allowed".to_string(),
        ));
    }

    let mut args = Vec::with_capacity(ids.len() + 1);
    args.push(D1Type::Integer(d1_i32(user_id)));
    args.extend(ids.iter().map(|id| D1Type::Integer(d1_i32(*id))));

    Ok(db
        .prepare(&token_keys_by_ids_query(ids.len()))
        .bind_refs(&args)?
        .all()
        .await?
        .results::<TokenKeyRow>()?)
}

fn token_keys_by_ids_query(id_count: usize) -> String {
    let placeholders: Vec<String> = (0..id_count).map(|i| format!("?{}", i + 2)).collect();
    format!(
        r#"
        SELECT id, "key", name
        FROM tokens
        WHERE user_id = ?1
          AND deleted_at IS NULL
          AND id IN ({})
        ORDER BY id ASC
        "#,
        placeholders.join(", "),
    )
}

/// Fields for creating a token. Mirrors Go `controller/token.go::AddToken`.
#[derive(Debug, Clone)]
pub struct CreateToken<'a> {
    pub user_id: i64,
    pub key: &'a str,
    pub name: &'a str,
    pub expired_time: i64,
    pub remain_quota: i64,
    pub unlimited_quota: i32,
    pub model_limits_enabled: i32,
    pub model_limits: &'a str,
    pub allow_ips: &'a str,
    pub group: &'a str,
    pub cross_group_retry: i32,
    pub created_time: i64,
}

/// Create a new token. Returns the new token id by re-reading the row.
pub async fn create_token(db: &D1Database, params: CreateToken<'_>) -> worker::Result<i64> {
    let args = [
        D1Type::Integer(d1_i32(params.user_id)),
        D1Type::Text(params.key),
        D1Type::Text(params.name),
        D1Type::Integer(d1_i32(params.expired_time)),
        D1Type::Integer(d1_i32(params.remain_quota)),
        D1Type::Integer(params.unlimited_quota),
        D1Type::Integer(params.model_limits_enabled),
        D1Type::Text(params.model_limits),
        D1Type::Text(params.allow_ips),
        D1Type::Text(params.group),
        D1Type::Integer(params.cross_group_retry),
        D1Type::Integer(d1_i32(params.created_time)),
    ];
    db.prepare(
        r#"
        INSERT INTO tokens (
          user_id, "key", status, name, created_time, accessed_time,
          expired_time, remain_quota, unlimited_quota, model_limits_enabled,
          model_limits, allow_ips, used_quota, "group", cross_group_retry
        )
        VALUES (
          ?1, ?2, 1, ?3, ?12, 0, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?11
        )
        "#,
    )
    .bind_refs(&args)?
    .run()
    .await?;
    // Recover the id by reading the just-inserted key.
    let key_arg = D1Type::Text(params.key);
    #[derive(Deserialize)]
    struct Id {
        id: i64,
    }
    let row = db
        .prepare(r#"SELECT id FROM tokens WHERE "key" = ?1 LIMIT 1"#)
        .bind_refs(&[key_arg])?
        .first::<Id>(None)
        .await?;
    Ok(row
        .map(|r| r.id)
        .ok_or_else(|| worker::Error::RustError("token insert not found after create".into()))?)
}

/// Update token fields. Only the rows owned by `user_id` are touched. When
/// `status_only` is true, only `status` is updated (used by the frontend
/// quick enable/disable toggle). Returns true when a row was updated.
#[derive(Debug, Clone, Default)]
pub struct UpdateToken<'a> {
    pub id: i64,
    pub user_id: i64,
    pub status_only: bool,
    pub name: Option<&'a str>,
    pub status: Option<i32>,
    pub expired_time: Option<i64>,
    pub remain_quota: Option<i64>,
    pub unlimited_quota: Option<i32>,
    pub model_limits_enabled: Option<i32>,
    pub model_limits: Option<&'a str>,
    pub allow_ips: Option<&'a str>,
    pub group: Option<&'a str>,
    pub cross_group_retry: Option<i32>,
}

pub async fn update_token(db: &D1Database, params: UpdateToken<'_>) -> worker::Result<bool> {
    let mut sets: Vec<String> = Vec::new();
    let mut args: Vec<D1Type> = Vec::new();
    let mut idx;
    if params.status_only {
        if let Some(status) = params.status {
            idx = args.len() + 1;
            sets.push(format!("status = ?{idx}"));
            args.push(D1Type::Integer(status));
        } else {
            return Ok(false);
        }
    } else {
        if let Some(name) = params.name {
            idx = args.len() + 1;
            sets.push(format!("name = ?{idx}"));
            args.push(D1Type::Text(name));
        }
        if let Some(status) = params.status {
            idx = args.len() + 1;
            sets.push(format!("status = ?{idx}"));
            args.push(D1Type::Integer(status));
        }
        if let Some(expired_time) = params.expired_time {
            idx = args.len() + 1;
            sets.push(format!("expired_time = ?{idx}"));
            args.push(D1Type::Integer(d1_i32(expired_time)));
        }
        if let Some(remain_quota) = params.remain_quota {
            idx = args.len() + 1;
            sets.push(format!("remain_quota = ?{idx}"));
            args.push(D1Type::Integer(d1_i32(remain_quota)));
        }
        if let Some(unlimited_quota) = params.unlimited_quota {
            idx = args.len() + 1;
            sets.push(format!("unlimited_quota = ?{idx}"));
            args.push(D1Type::Integer(unlimited_quota));
        }
        if let Some(enabled) = params.model_limits_enabled {
            idx = args.len() + 1;
            sets.push(format!("model_limits_enabled = ?{idx}"));
            args.push(D1Type::Integer(enabled));
        }
        if let Some(limits) = params.model_limits {
            idx = args.len() + 1;
            sets.push(format!("model_limits = ?{idx}"));
            args.push(D1Type::Text(limits));
        }
        if let Some(ips) = params.allow_ips {
            idx = args.len() + 1;
            sets.push(format!("allow_ips = ?{idx}"));
            args.push(D1Type::Text(ips));
        }
        if let Some(group) = params.group {
            idx = args.len() + 1;
            sets.push(format!("\"group\" = ?{idx}"));
            args.push(D1Type::Text(group));
        }
        if let Some(retry) = params.cross_group_retry {
            idx = args.len() + 1;
            sets.push(format!("cross_group_retry = ?{idx}"));
            args.push(D1Type::Integer(retry));
        }
    }
    if sets.is_empty() {
        return Ok(false);
    }
    idx = args.len() + 1;
    let id_index = idx;
    args.push(D1Type::Integer(d1_i32(params.id)));
    idx = args.len() + 1;
    let user_index = idx;
    args.push(D1Type::Integer(d1_i32(params.user_id)));
    let sql = format!(
        r#"
        UPDATE tokens SET {} WHERE id = ?{} AND user_id = ?{} AND deleted_at IS NULL
        "#,
        sets.join(", "),
        id_index,
        user_index,
    );
    let result = db.prepare(&sql).bind_refs(&args)?.run().await?;
    let changes = result.meta()?.and_then(|m| m.changes).unwrap_or(0);
    Ok(changes > 0)
}

/// Soft-delete a token owned by `user_id`. Returns true when a row was
/// updated.
pub async fn delete_token(
    db: &D1Database,
    id: i64,
    user_id: i64,
    now_unix: i64,
) -> worker::Result<bool> {
    let args = [
        D1Type::Integer(d1_i32(now_unix)),
        D1Type::Integer(d1_i32(id)),
        D1Type::Integer(d1_i32(user_id)),
    ];
    let result = db
        .prepare(
            r#"
            UPDATE tokens SET deleted_at = ?1
            WHERE id = ?2 AND user_id = ?3 AND deleted_at IS NULL
            "#,
        )
        .bind_refs(&args)?
        .run()
        .await?;
    let changes = result.meta()?.and_then(|m| m.changes).unwrap_or(0);
    Ok(changes > 0)
}

/// Soft-delete multiple tokens owned by `user_id`. Returns the count of
/// updated rows.
pub async fn delete_tokens_batch(
    db: &D1Database,
    user_id: i64,
    ids: &[i64],
    now_unix: i64,
) -> worker::Result<usize> {
    if ids.is_empty() {
        return Ok(0);
    }
    let mut total = 0usize;
    for chunk in ids.chunks(50) {
        let placeholders: Vec<String> = (0..chunk.len()).map(|i| format!("?{}", i + 2)).collect();
        let mut args = vec![
            D1Type::Integer(d1_i32(now_unix)),
            D1Type::Integer(d1_i32(user_id)),
        ];
        for id in chunk {
            args.push(D1Type::Integer(d1_i32(*id)));
        }
        let sql = format!(
            r#"
            UPDATE tokens SET deleted_at = ?1
            WHERE user_id = ?2 AND deleted_at IS NULL AND id IN ({})
            "#,
            placeholders.join(", "),
        );
        let result = db.prepare(&sql).bind_refs(&args)?.run().await?;
        let changes = result.meta()?.and_then(|m| m.changes).unwrap_or(0);
        total += changes as usize;
    }
    Ok(total)
}

// ---------------------------------------------------------------------------
// Admin channel CRUD (G5): list, search, get, create, update, delete, batch
// delete, fix abilities.
//
// Mirrors Go `controller/channel.go` Tier 1 routes. Every write operation
// (create/update/delete/batch-delete/fix) MUST keep the `abilities` table in
// sync, because the relay's `select_channels_from_abilities` is the primary
// channel lookup. Failure to maintain abilities means new/edited channels are
// invisible to relay traffic.
//
// Abilities sync is best-effort on the Worker D1 binding: a channel write
// succeeds first, then abilities rows are added/rebuilt; if the abilities
// step fails, the error is logged and the operator can run `POST
// /api/channel/fix` to rebuild. This differs from the Go gateway, which uses
// a GORM transaction, but the Worker D1 batch API does not give us a
// practical equivalent.
// ---------------------------------------------------------------------------

/// Full channel row. `key` is included because create/update and the future
/// reveal route need it; list/search/get responses clear it in the handler
/// layer (see `mask_channel_key`).
#[derive(Debug, Deserialize, PartialEq, serde::Serialize)]
pub struct ChannelRow {
    pub id: i64,
    #[serde(rename = "type")]
    pub kind: i32,
    pub key: String,
    pub openai_organization: Option<String>,
    pub test_model: Option<String>,
    pub status: i32,
    pub name: String,
    pub weight: i32,
    pub created_time: i64,
    pub test_time: i64,
    pub response_time: i64,
    pub base_url: String,
    pub other: String,
    pub balance: f64,
    pub balance_updated_time: i64,
    pub models: String,
    pub channel_group: String,
    pub used_quota: i64,
    pub model_mapping: Option<String>,
    pub status_code_mapping: String,
    pub priority: i32,
    pub auto_ban: i32,
    pub other_info: String,
    pub tag: Option<String>,
    pub setting: Option<String>,
    pub param_override: Option<String>,
    pub header_override: Option<String>,
    pub remark: Option<String>,
    pub channel_info: String,
    pub settings: String,
}

/// Columns selected for admin list/search/get responses. `key` is selected
/// but cleared in the handler (Go behavior: never return the upstream key in
/// a list response).
const CHANNEL_ADMIN_COLUMNS: &str = r#"
  id, type, "key", openai_organization, test_model, status, name, weight,
  created_time, test_time, response_time, base_url, other, balance,
  balance_updated_time, models, "group" AS channel_group, used_quota,
  model_mapping, status_code_mapping, priority, auto_ban, other_info, tag,
  setting, param_override, header_override, remark, channel_info, settings
"#;

/// Filter for channel list/search. Mirrors the Go `buildChannelListQuery`
/// parameters.
#[derive(Debug, Clone, Default)]
pub struct ChannelFilter {
    pub group: Option<String>,
    pub status: Option<i32>,
    pub kind: Option<i32>,
    /// `Some("enabled")` / `Some("disabled")` filter by tag presence; any
    /// other value is treated as an exact tag match.
    pub tag_mode: Option<String>,
}

fn channel_filter_clause<'a>(filter: &'a ChannelFilter) -> (String, Vec<D1Type<'a>>) {
    let mut conditions: Vec<String> = vec!["deleted_at IS NULL".to_string()];
    let mut args: Vec<D1Type<'a>> = Vec::new();
    let mut idx;
    if let Some(group) = filter.group.as_deref() {
        let trimmed = group.trim();
        if !trimmed.is_empty() {
            idx = args.len() + 1;
            // Group is a CSV column; match any containing segment. Use SQL
            // string concatenation for the LIKE wildcards so the bound
            // parameter is just the trimmed group value (avoids borrowing a
            // temporary String).
            conditions.push(format!("\"group\" LIKE '%' || ?{idx} || '%'"));
            args.push(D1Type::Text(trimmed));
        }
    }
    if let Some(status) = filter.status {
        idx = args.len() + 1;
        conditions.push(format!("status = ?{idx}"));
        args.push(D1Type::Integer(status));
    }
    if let Some(kind) = filter.kind {
        idx = args.len() + 1;
        conditions.push(format!("type = ?{idx}"));
        args.push(D1Type::Integer(kind));
    }
    if let Some(tag_mode) = filter.tag_mode.as_deref() {
        let trimmed = tag_mode.trim();
        if trimmed.eq_ignore_ascii_case("enabled") {
            conditions.push("tag IS NOT NULL AND tag != ''".to_string());
        } else if trimmed.eq_ignore_ascii_case("disabled") {
            conditions.push("(tag IS NULL OR tag = '')".to_string());
        } else if !trimmed.is_empty() {
            idx = args.len() + 1;
            conditions.push(format!("tag = ?{idx}"));
            args.push(D1Type::Text(trimmed));
        }
    }
    let sql = format!("WHERE {}", conditions.join(" AND "));
    (sql, args)
}

pub async fn list_channels(
    db: &D1Database,
    filter: &ChannelFilter,
    page: u32,
    page_size: u32,
) -> worker::Result<Vec<ChannelRow>> {
    let page = page.max(1);
    let page_size = page_size.clamp(1, 100);
    let offset = (page - 1) * page_size;
    let (where_sql, mut args) = channel_filter_clause(filter);
    let limit_index = args.len() + 1;
    let offset_index = limit_index + 1;
    args.push(D1Type::Integer(page_size as i32));
    args.push(D1Type::Integer(offset as i32));
    let sql = format!(
        r#"
        SELECT {CHANNEL_ADMIN_COLUMNS}
        FROM channels
        {where_sql}
        ORDER BY id DESC
        LIMIT ?{limit_index} OFFSET ?{offset_index}
        "#,
    );
    Ok(db
        .prepare(&sql)
        .bind_refs(&args)?
        .all()
        .await?
        .results::<ChannelRow>()?)
}

/// Enabled channels in ascending id order for bounded all-channel maintenance
/// slices. Handlers request one extra row when they need a `has_more` signal.
pub async fn list_enabled_channels_after_id(
    db: &D1Database,
    after_id: i64,
    limit: u32,
) -> worker::Result<Vec<ChannelRow>> {
    let limit = limit.clamp(1, 101);
    let args = [
        D1Type::Integer(d1_i32(after_id.max(0))),
        D1Type::Integer(limit as i32),
    ];
    let sql = format!(
        r#"
        SELECT {CHANNEL_ADMIN_COLUMNS}
        FROM channels
        WHERE status = 1 AND id > ?1
        ORDER BY id ASC
        LIMIT ?2
        "#,
    );
    Ok(db
        .prepare(&sql)
        .bind_refs(&args)?
        .all()
        .await?
        .results::<ChannelRow>()?)
}

pub async fn search_channels(
    db: &D1Database,
    keyword: &str,
    filter: &ChannelFilter,
    page: u32,
    page_size: u32,
) -> worker::Result<Vec<ChannelRow>> {
    let page = page.max(1);
    let page_size = page_size.clamp(1, 100);
    let offset = (page - 1) * page_size;
    let like = format!("%{}%", keyword.trim());
    let (where_sql, mut args) = channel_filter_clause(filter);
    let like_index = args.len() + 1;
    args.push(D1Type::Text(like.as_str()));
    let limit_index = args.len() + 1;
    let offset_index = limit_index + 1;
    args.push(D1Type::Integer(page_size as i32));
    args.push(D1Type::Integer(offset as i32));
    let sql = format!(
        r#"
        SELECT {CHANNEL_ADMIN_COLUMNS}
        FROM channels
        {where_sql}
          AND (name LIKE ?{like_index} OR models LIKE ?{like_index} OR base_url LIKE ?{like_index})
        ORDER BY id DESC
        LIMIT ?{limit_index} OFFSET ?{offset_index}
        "#,
    );
    Ok(db
        .prepare(&sql)
        .bind_refs(&args)?
        .all()
        .await?
        .results::<ChannelRow>()?)
}

pub async fn count_channels(db: &D1Database, filter: &ChannelFilter) -> worker::Result<i64> {
    #[derive(Deserialize)]
    struct Count {
        count: i64,
    }
    let (where_sql, args) = channel_filter_clause(filter);
    let sql = format!("SELECT COUNT(*) AS count FROM channels {where_sql}");
    let row = db
        .prepare(&sql)
        .bind_refs(&args)?
        .first::<Count>(None)
        .await?;
    Ok(row.map(|r| r.count).unwrap_or(0))
}

/// Count channels grouped by type, ignoring the type filter so the result
/// reflects all types in the same group/status scope. Mirrors Go
/// `type_counts`. Tag mode is intentionally ignored here to match the Go
/// behavior (the aggregation query drops tag filtering).
pub async fn count_channels_by_type(
    db: &D1Database,
    group: Option<&str>,
    status: Option<i32>,
) -> worker::Result<Vec<TypeCount>> {
    #[derive(Deserialize)]
    struct Row {
        #[serde(rename = "type")]
        kind: i32,
        count: i64,
    }
    let mut conditions: Vec<String> = vec!["deleted_at IS NULL".to_string()];
    let mut args: Vec<D1Type<'_>> = Vec::new();
    let mut idx;
    if let Some(group) = group {
        let trimmed = group.trim();
        if !trimmed.is_empty() {
            idx = args.len() + 1;
            conditions.push(format!("\"group\" LIKE '%' || ?{idx} || '%'"));
            args.push(D1Type::Text(trimmed));
        }
    }
    if let Some(status) = status {
        idx = args.len() + 1;
        conditions.push(format!("status = ?{idx}"));
        args.push(D1Type::Integer(status));
    }
    let sql = format!(
        r#"
        SELECT type, COUNT(*) AS count
        FROM channels
        WHERE {}
        GROUP BY type
        "#,
        conditions.join(" AND "),
    );
    let rows = db
        .prepare(&sql)
        .bind_refs(&args)?
        .all()
        .await?
        .results::<Row>()?;
    Ok(rows
        .into_iter()
        .map(|r| TypeCount {
            kind: r.kind,
            count: r.count,
        })
        .collect())
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TypeCount {
    #[serde(rename = "type")]
    pub kind: i32,
    pub count: i64,
}

pub async fn find_channel_by_id(db: &D1Database, id: i64) -> worker::Result<Option<ChannelRow>> {
    let arg = D1Type::Integer(d1_i32(id));
    let sql = format!(
        // Channels are hard-deleted in Go (the `Channel` model has no
        // `gorm.DeletedAt`, unlike users/tokens), so there is no `deleted_at`
        // column to filter on.
        "SELECT {CHANNEL_ADMIN_COLUMNS} FROM channels WHERE id = ?1 LIMIT 1"
    );
    db.prepare(&sql)
        .bind_refs(&[arg])?
        .first::<ChannelRow>(None)
        .await
}

/// Set a nullable tag on the selected channels. Returns the number of rows
/// updated across all chunks.
pub async fn set_channels_tag_batch(
    db: &D1Database,
    ids: &[i64],
    tag: Option<&str>,
) -> worker::Result<usize> {
    if ids.is_empty() {
        return Ok(0);
    }

    let mut total = 0usize;
    for chunk in ids.chunks(50) {
        let placeholders: Vec<String> = (0..chunk.len())
            .map(|index| format!("?{}", index + 2))
            .collect();
        let mut args: Vec<D1Type<'_>> = Vec::with_capacity(chunk.len() + 1);
        args.push(tag.map(D1Type::Text).unwrap_or(D1Type::Null));
        args.extend(chunk.iter().map(|id| D1Type::Integer(d1_i32(*id))));
        let sql = format!(
            "UPDATE channels SET tag = ?1 WHERE id IN ({})",
            placeholders.join(", ")
        );
        let result = db.prepare(&sql).bind_refs(&args)?.run().await?;
        total += result
            .meta()?
            .and_then(|metadata| metadata.changes)
            .unwrap_or(0) as usize;
    }
    Ok(total)
}

/// Return the original `models` CSV from the channel under `tag` with the
/// greatest number of comma-separated items. Ties retain the first channel in
/// Go's default channel order (priority descending).
pub async fn longest_channel_models_by_tag(db: &D1Database, tag: &str) -> worker::Result<String> {
    #[derive(Deserialize)]
    struct ModelsRow {
        models: String,
    }

    let rows = db
        .prepare(
            r#"SELECT COALESCE(models, '') AS models
               FROM channels
               WHERE tag = ?1
               ORDER BY priority DESC"#,
        )
        .bind_refs(&[D1Type::Text(tag)])?
        .all()
        .await?
        .results::<ModelsRow>()?;
    Ok(longest_models_csv(rows.into_iter().map(|row| row.models)))
}

fn longest_models_csv(models_values: impl IntoIterator<Item = String>) -> String {
    let mut longest = String::new();
    let mut max_items = 0usize;
    for models in models_values {
        if models.is_empty() {
            continue;
        }
        let item_count = models.split(',').count();
        if item_count > max_items {
            max_items = item_count;
            longest = models;
        }
    }
    longest
}

// ---------------------------------------------------------------------------
// Channel writes
// ---------------------------------------------------------------------------

/// Set the status of every channel carrying `tag` and mirror the enabled flag
/// onto their abilities (Go `DisableChannelByTag` / `EnableChannelByTag` +
/// `UpdateAbilityStatusByTag`). `status` is 1 (enabled) or 2 (manually
/// disabled); `abilities_enabled` matches.
pub async fn set_channels_status_by_tag(
    db: &D1Database,
    tag: &str,
    status: i32,
    abilities_enabled: bool,
) -> worker::Result<()> {
    let channel_args = [D1Type::Integer(status), D1Type::Text(tag)];
    db.prepare(r#"UPDATE channels SET status = ?1 WHERE tag = ?2"#)
        .bind_refs(&channel_args)?
        .run()
        .await?;
    let ability_args = [
        D1Type::Integer(if abilities_enabled { 1 } else { 0 }),
        D1Type::Text(tag),
    ];
    db.prepare(
        r#"UPDATE abilities SET enabled = ?1
           WHERE channel_id IN (SELECT id FROM channels WHERE tag = ?2)"#,
    )
    .bind_refs(&ability_args)?
    .run()
    .await?;
    Ok(())
}

/// Record a successful channel test (Go `TestChannel`): latency in ms +
/// test timestamp.
pub async fn record_channel_test(
    db: &D1Database,
    id: i64,
    response_time_ms: i64,
    tested_at: i64,
) -> worker::Result<()> {
    let args = [
        D1Type::Integer(d1_i32(response_time_ms)),
        D1Type::Integer(d1_i32(tested_at)),
        D1Type::Integer(d1_i32(id)),
    ];
    db.prepare(r#"UPDATE channels SET response_time = ?1, test_time = ?2 WHERE id = ?3"#)
        .bind_refs(&args)?
        .run()
        .await?;
    Ok(())
}

/// Persist a bounded set of successful channel probes in one D1 batch. The
/// return value is the number of channels that still existed when the batch
/// was applied.
pub async fn record_channel_tests_batch(
    db: &D1Database,
    measurements: &[(i64, i64, i64)],
) -> worker::Result<usize> {
    if measurements.is_empty() {
        return Ok(0);
    }
    let mut statements = Vec::with_capacity(measurements.len());
    for (id, response_time_ms, tested_at) in measurements {
        let args = [
            D1Type::Integer(d1_i32(*response_time_ms)),
            D1Type::Integer(d1_i32(*tested_at)),
            D1Type::Integer(d1_i32(*id)),
        ];
        statements.push(
            db.prepare(
                r#"UPDATE channels
                   SET response_time = ?1, test_time = ?2
                   WHERE id = ?3"#,
            )
            .bind_refs(&args)?,
        );
    }
    let results = db.batch(statements).await?;
    let mut changed = 0usize;
    for result in results {
        changed += result
            .meta()?
            .and_then(|metadata| metadata.changes)
            .unwrap_or(0) as usize;
    }
    Ok(changed)
}

/// Persist a successfully fetched upstream balance and its refresh timestamp.
/// Returns false when the channel disappeared before the write completed.
pub async fn update_channel_balance(
    db: &D1Database,
    id: i64,
    balance: f64,
    updated_at: i64,
) -> worker::Result<bool> {
    let args = [
        D1Type::Real(balance),
        D1Type::Integer(d1_i32(updated_at)),
        D1Type::Integer(d1_i32(id)),
    ];
    let result = db
        .prepare(
            "UPDATE channels
             SET balance = ?1, balance_updated_time = ?2
             WHERE id = ?3",
        )
        .bind_refs(&args)?
        .run()
        .await?;
    Ok(result.meta()?.and_then(|meta| meta.changes).unwrap_or(0) > 0)
}

/// Persist a bounded set of validated upstream balances in one D1 batch.
/// Values are never interpolated into SQL, and only finite values are accepted.
pub async fn update_channel_balances_batch(
    db: &D1Database,
    balances: &[(i64, f64, i64)],
) -> worker::Result<usize> {
    if balances.is_empty() {
        return Ok(0);
    }
    let mut statements = Vec::with_capacity(balances.len());
    for (id, balance, updated_at) in balances {
        if !balance.is_finite() {
            return Err(worker::Error::RustError(
                "channel balance batch contains a non-finite value".to_string(),
            ));
        }
        let args = [
            D1Type::Real(*balance),
            D1Type::Integer(d1_i32(*updated_at)),
            D1Type::Integer(d1_i32(*id)),
        ];
        statements.push(
            db.prepare(
                r#"UPDATE channels
                   SET balance = ?1, balance_updated_time = ?2
                   WHERE id = ?3"#,
            )
            .bind_refs(&args)?,
        );
    }
    let results = db.batch(statements).await?;
    let mut changed = 0usize;
    for result in results {
        changed += result
            .meta()?
            .and_then(|metadata| metadata.changes)
            .unwrap_or(0) as usize;
    }
    Ok(changed)
}

/// Atomically replace a multi-key channel's key payload and channel-info JSON.
/// The old values form an optimistic concurrency guard so two admin actions
/// cannot silently overwrite one another.
pub async fn update_multi_key_channel(
    db: &D1Database,
    id: i64,
    expected_key: &str,
    expected_channel_info: &str,
    new_key: &str,
    new_channel_info: &str,
) -> worker::Result<bool> {
    let args = [
        D1Type::Text(new_key),
        D1Type::Text(new_channel_info),
        D1Type::Integer(d1_i32(id)),
        D1Type::Text(expected_key),
        D1Type::Text(expected_channel_info),
    ];
    let result = db
        .prepare(
            r#"UPDATE channels
               SET "key" = ?1, channel_info = ?2
               WHERE id = ?3 AND "key" = ?4 AND channel_info = ?5"#,
        )
        .bind_refs(&args)?
        .run()
        .await?;
    Ok(result.meta()?.and_then(|meta| meta.changes).unwrap_or(0) > 0)
}

/// Atomically replace a channel key, guarded by the key value read before an
/// external credential refresh. This prevents a refresh response from
/// overwriting an admin's concurrent channel edit.
pub async fn update_channel_key_if_current(
    db: &D1Database,
    id: i64,
    expected_key: &str,
    new_key: &str,
) -> worker::Result<bool> {
    let args = [
        D1Type::Text(new_key),
        D1Type::Integer(d1_i32(id)),
        D1Type::Text(expected_key),
    ];
    let result = db
        .prepare(
            r#"UPDATE channels
               SET "key" = ?1
               WHERE id = ?2 AND "key" = ?3"#,
        )
        .bind_refs(&args)?
        .run()
        .await?;
    Ok(result.meta()?.and_then(|meta| meta.changes).unwrap_or(0) > 0)
}

/// Atomically replace the upstream-model state guarded by the channel values
/// used to calculate it. This prevents a detect/apply request from overwriting
/// a concurrent channel edit or another upstream-model operation.
pub async fn update_channel_upstream_model_state(
    db: &D1Database,
    id: i64,
    expected_models: &str,
    expected_settings: &str,
    new_models: &str,
    new_settings: &str,
) -> worker::Result<bool> {
    let args = [
        D1Type::Text(new_models),
        D1Type::Text(new_settings),
        D1Type::Integer(d1_i32(id)),
        D1Type::Text(expected_models),
        D1Type::Text(expected_settings),
    ];
    let result = db
        .prepare(
            r#"UPDATE channels
               SET models = ?1, settings = ?2
               WHERE id = ?3 AND models = ?4 AND settings = ?5"#,
        )
        .bind_refs(&args)?
        .run()
        .await?;
    Ok(result.meta()?.and_then(|meta| meta.changes).unwrap_or(0) > 0)
}

/// Optional fields for a bulk edit of the channels carrying a tag (Go
/// `EditChannelByTag`). `None` fields are left unchanged.
#[derive(Debug, Default)]
pub struct EditChannelsByTag<'a> {
    pub new_tag: Option<&'a str>,
    pub model_mapping: Option<&'a str>,
    pub models: Option<&'a str>,
    pub group: Option<&'a str>,
    pub priority: Option<i64>,
    pub weight: Option<i64>,
    pub param_override: Option<&'a str>,
    pub header_override: Option<&'a str>,
}

/// Apply an `EditChannelsByTag` to every channel with `tag` (dynamic SET of only
/// the provided fields). No-op when nothing is set. `new_tag` retags the rows.
pub async fn edit_channels_by_tag(
    db: &D1Database,
    tag: &str,
    edit: &EditChannelsByTag<'_>,
) -> worker::Result<()> {
    let mut sets: Vec<String> = Vec::new();
    let mut args: Vec<D1Type<'_>> = Vec::new();
    if let Some(v) = edit.new_tag {
        args.push(D1Type::Text(v));
        sets.push(format!("tag = ?{}", args.len()));
    }
    if let Some(v) = edit.model_mapping {
        args.push(D1Type::Text(v));
        sets.push(format!("model_mapping = ?{}", args.len()));
    }
    if let Some(v) = edit.models {
        args.push(D1Type::Text(v));
        sets.push(format!("models = ?{}", args.len()));
    }
    if let Some(v) = edit.group {
        args.push(D1Type::Text(v));
        sets.push(format!("\"group\" = ?{}", args.len()));
    }
    if let Some(v) = edit.priority {
        args.push(D1Type::Integer(d1_i32(v)));
        sets.push(format!("priority = ?{}", args.len()));
    }
    if let Some(v) = edit.weight {
        args.push(D1Type::Integer(d1_i32(v)));
        sets.push(format!("weight = ?{}", args.len()));
    }
    if let Some(v) = edit.param_override {
        args.push(D1Type::Text(v));
        sets.push(format!("param_override = ?{}", args.len()));
    }
    if let Some(v) = edit.header_override {
        args.push(D1Type::Text(v));
        sets.push(format!("header_override = ?{}", args.len()));
    }
    if sets.is_empty() {
        return Ok(());
    }
    args.push(D1Type::Text(tag));
    let sql = format!(
        "UPDATE channels SET {} WHERE tag = ?{}",
        sets.join(", "),
        args.len()
    );
    db.prepare(&sql).bind_refs(&args)?.run().await?;
    Ok(())
}

/// A channel's ability-relevant fields, fetched by tag for rebuilds.
#[derive(Debug, Deserialize)]
pub struct ChannelAbilitySource {
    pub id: i64,
    pub models: String,
    pub group: String,
    pub status: i32,
    pub priority: i64,
    pub weight: i64,
}

/// Fetch the ability-relevant fields of every channel with `tag`.
pub async fn channels_by_tag(
    db: &D1Database,
    tag: &str,
) -> worker::Result<Vec<ChannelAbilitySource>> {
    let arg = D1Type::Text(tag);
    db.prepare(
        r#"SELECT id, models, "group" AS "group", status, priority, weight
           FROM channels WHERE tag = ?1"#,
    )
    .bind_refs(&[arg])?
    .all()
    .await?
    .results::<ChannelAbilitySource>()
}

/// Update the `priority` / `weight` of the abilities for every channel with
/// `tag` (Go `UpdateAbilityByTag`, minus the tag column the Rust abilities table
/// does not carry). Only the provided fields are set; no-op when both are None.
pub async fn update_abilities_priority_weight_by_tag(
    db: &D1Database,
    tag: &str,
    priority: Option<i64>,
    weight: Option<i64>,
) -> worker::Result<()> {
    let mut sets: Vec<String> = Vec::new();
    let mut args: Vec<D1Type<'_>> = Vec::new();
    if let Some(p) = priority {
        args.push(D1Type::Integer(d1_i32(p)));
        sets.push(format!("priority = ?{}", args.len()));
    }
    if let Some(w) = weight {
        args.push(D1Type::Integer(d1_i32(w)));
        sets.push(format!("weight = ?{}", args.len()));
    }
    if sets.is_empty() {
        return Ok(());
    }
    args.push(D1Type::Text(tag));
    let sql = format!(
        "UPDATE abilities SET {} WHERE channel_id IN (SELECT id FROM channels WHERE tag = ?{})",
        sets.join(", "),
        args.len()
    );
    db.prepare(&sql).bind_refs(&args)?.run().await?;
    Ok(())
}

/// Delete all disabled channels (status 2 manual or 3 auto) and their abilities
/// (Go `DeleteDisabledChannel`). Returns the number of channels deleted.
pub async fn delete_disabled_channels(db: &D1Database) -> worker::Result<i64> {
    let empty: &[D1Type<'_>] = &[];
    db.prepare(
        r#"DELETE FROM abilities
           WHERE channel_id IN (SELECT id FROM channels WHERE status IN (2, 3))"#,
    )
    .bind_refs(empty)?
    .run()
    .await?;
    let result = db
        .prepare(r#"DELETE FROM channels WHERE status IN (2, 3)"#)
        .bind_refs(empty)?
        .run()
        .await?;
    Ok(result.meta()?.and_then(|meta| meta.changes).unwrap_or(0) as i64)
}

/// Fields for creating a channel (single mode only). Mirrors the Go
/// `AddChannelRequest` with `mode="single"`.
#[derive(Debug, Clone)]
pub struct CreateChannel<'a> {
    pub kind: i32,
    pub key: &'a str,
    pub name: &'a str,
    pub base_url: &'a str,
    pub models: &'a str,
    pub group: &'a str,
    pub model_mapping: Option<&'a str>,
    pub priority: i32,
    pub weight: i32,
    pub status: i32,
    pub auto_ban: i32,
    pub tag: Option<&'a str>,
    pub openai_organization: Option<&'a str>,
    pub test_model: Option<&'a str>,
    pub other: &'a str,
    pub status_code_mapping: &'a str,
    pub other_info: &'a str,
    pub setting: Option<&'a str>,
    pub settings: &'a str,
    pub param_override: Option<&'a str>,
    pub header_override: Option<&'a str>,
    pub remark: Option<&'a str>,
    pub created_time: i64,
}

pub async fn create_channel(db: &D1Database, params: CreateChannel<'_>) -> worker::Result<i64> {
    let full_args: Vec<D1Type<'_>> = vec![
        D1Type::Integer(params.kind),
        D1Type::Text(params.key),
        D1Type::Text(params.name),
        D1Type::Integer(params.priority),
        D1Type::Integer(params.weight),
        D1Type::Integer(params.status),
        D1Type::Integer(d1_i32(params.created_time)),
        D1Type::Text(params.base_url),
        D1Type::Text(params.other),
        D1Type::Text(params.models),
        D1Type::Text(params.group),
        D1Type::Text(params.status_code_mapping),
        D1Type::Integer(params.auto_ban),
        D1Type::Text(params.other_info),
        params
            .model_mapping
            .map(D1Type::Text)
            .unwrap_or(D1Type::Null),
        params.tag.map(D1Type::Text).unwrap_or(D1Type::Null),
        params
            .openai_organization
            .map(D1Type::Text)
            .unwrap_or(D1Type::Null),
        params.test_model.map(D1Type::Text).unwrap_or(D1Type::Null),
        params.setting.map(D1Type::Text).unwrap_or(D1Type::Null),
        params
            .param_override
            .map(D1Type::Text)
            .unwrap_or(D1Type::Null),
        params
            .header_override
            .map(D1Type::Text)
            .unwrap_or(D1Type::Null),
        params.remark.map(D1Type::Text).unwrap_or(D1Type::Null),
        D1Type::Text("{}"), // channel_info
        D1Type::Text(params.settings),
    ];
    let sql = r#"
        INSERT INTO channels (
          type, "key", name, priority, weight, status, created_time,
          base_url, other, models, "group", status_code_mapping, auto_ban,
          other_info, model_mapping, tag, openai_organization, test_model,
          setting, param_override, header_override, remark, channel_info,
          settings
        )
        VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
          ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24
        )
    "#;
    db.prepare(sql).bind_refs(&full_args)?.run().await?;
    // Recover the id by reading the just-inserted key.
    let key_arg = D1Type::Text(params.key);
    #[derive(Deserialize)]
    struct Id {
        id: i64,
    }
    let row = db
        .prepare(r#"SELECT id FROM channels WHERE "key" = ?1 ORDER BY id DESC LIMIT 1"#)
        .bind_refs(&[key_arg])?
        .first::<Id>(None)
        .await?;
    Ok(row
        .map(|r| r.id)
        .ok_or_else(|| worker::Error::RustError("channel insert not found after create".into()))?)
}

const COPY_CHANNEL_SQL: &str = r#"
    INSERT INTO channels (
      type, "key", openai_organization, test_model, status, name, weight,
      created_time, test_time, response_time, base_url, other, balance,
      balance_updated_time, models, "group", used_quota, model_mapping,
      status_code_mapping, priority, auto_ban, other_info, tag, setting,
      param_override, header_override, remark, channel_info, settings
    )
    SELECT
      type, "key", openai_organization, test_model, status, ?2, weight,
      ?3, 0, 0, base_url, other,
      CASE WHEN ?4 = 1 THEN 0 ELSE balance END,
      balance_updated_time, models, "group",
      CASE WHEN ?4 = 1 THEN 0 ELSE used_quota END,
      model_mapping, status_code_mapping, priority, auto_ban, other_info, tag,
      setting, param_override, header_override, remark, channel_info, settings
    FROM channels
    WHERE id = ?1
"#;

/// Clone one channel with its encrypted/plain upstream key retained in D1 but
/// never returned to the handler. The SQL copies every Go-compatible channel
/// field while resetting test latency metadata and optionally balance/quota.
pub async fn copy_channel(
    db: &D1Database,
    source_id: i64,
    new_name: &str,
    created_time: i64,
    reset_balance: bool,
) -> worker::Result<Option<i64>> {
    let args = [
        D1Type::Integer(d1_i32(source_id)),
        D1Type::Text(new_name),
        D1Type::Integer(d1_i32(created_time)),
        D1Type::Integer(if reset_balance { 1 } else { 0 }),
    ];
    let result = db.prepare(COPY_CHANNEL_SQL).bind_refs(&args)?.run().await?;
    let Some(metadata) = result.meta()? else {
        return Err(worker::Error::RustError(
            "channel copy did not return D1 metadata".to_string(),
        ));
    };
    if metadata.changes.unwrap_or(0) == 0 {
        return Ok(None);
    }
    metadata.last_row_id.map(Some).ok_or_else(|| {
        worker::Error::RustError("channel copy did not return the inserted id".to_string())
    })
}

/// Update fields for an existing channel. Only provided fields are updated.
/// `models` and `group` changes trigger an abilities rebuild.
#[derive(Debug, Clone, Default)]
pub struct UpdateChannel<'a> {
    pub id: i64,
    pub kind: Option<i32>,
    pub key: Option<&'a str>,
    pub name: Option<&'a str>,
    pub base_url: Option<&'a str>,
    pub models: Option<&'a str>,
    pub group: Option<&'a str>,
    pub model_mapping: Option<Option<&'a str>>,
    pub priority: Option<i32>,
    pub weight: Option<i32>,
    pub status: Option<i32>,
    pub auto_ban: Option<i32>,
    pub tag: Option<Option<&'a str>>,
    pub other: Option<&'a str>,
    pub status_code_mapping: Option<&'a str>,
    pub other_info: Option<&'a str>,
    pub setting: Option<Option<&'a str>>,
    pub settings: Option<&'a str>,
    pub param_override: Option<Option<&'a str>>,
    pub header_override: Option<Option<&'a str>>,
    pub remark: Option<Option<&'a str>>,
    pub openai_organization: Option<Option<&'a str>>,
    pub test_model: Option<Option<&'a str>>,
}

pub async fn update_channel(db: &D1Database, params: UpdateChannel<'_>) -> worker::Result<bool> {
    let mut sets: Vec<String> = Vec::new();
    let mut args: Vec<D1Type<'_>> = Vec::new();
    let mut idx;
    macro_rules! set_int {
        ($field:expr, $col:expr) => {
            if let Some(v) = $field {
                idx = args.len() + 1;
                sets.push(format!("{} = ?{idx}", $col));
                args.push(D1Type::Integer(v));
            }
        };
    }
    macro_rules! set_text {
        ($field:expr, $col:expr) => {
            if let Some(v) = $field {
                idx = args.len() + 1;
                sets.push(format!("{} = ?{idx}", $col));
                args.push(D1Type::Text(v));
            }
        };
    }
    macro_rules! set_opt_text {
        ($field:expr, $col:expr) => {
            if let Some(v) = $field {
                idx = args.len() + 1;
                sets.push(format!("{} = ?{idx}", $col));
                match v {
                    Some(s) => args.push(D1Type::Text(s)),
                    None => args.push(D1Type::Null),
                }
            }
        };
    }
    set_int!(params.kind, "type");
    set_text!(params.key, "\"key\"");
    set_text!(params.name, "name");
    set_text!(params.base_url, "base_url");
    set_text!(params.models, "models");
    set_text!(params.group, "\"group\"");
    set_opt_text!(params.model_mapping, "model_mapping");
    set_int!(params.priority, "priority");
    set_int!(params.weight, "weight");
    set_int!(params.status, "status");
    set_int!(params.auto_ban, "auto_ban");
    set_opt_text!(params.tag, "tag");
    set_text!(params.other, "other");
    set_text!(params.status_code_mapping, "status_code_mapping");
    set_text!(params.other_info, "other_info");
    set_opt_text!(params.setting, "setting");
    set_text!(params.settings, "settings");
    set_opt_text!(params.param_override, "param_override");
    set_opt_text!(params.header_override, "header_override");
    set_opt_text!(params.remark, "remark");
    set_opt_text!(params.openai_organization, "openai_organization");
    set_opt_text!(params.test_model, "test_model");
    if sets.is_empty() {
        return Ok(false);
    }
    idx = args.len() + 1;
    let id_index = idx;
    args.push(D1Type::Integer(d1_i32(params.id)));
    let sql = format!(
        r#"
        UPDATE channels SET {}
        WHERE id = ?{} AND deleted_at IS NULL
        "#,
        sets.join(", "),
        id_index,
    );
    let result = db.prepare(&sql).bind_refs(&args)?.run().await?;
    let changes = result.meta()?.and_then(|m| m.changes).unwrap_or(0);
    Ok(changes > 0)
}

/// Hard-delete a channel (Go behavior: channels are hard-deleted, not
/// soft-deleted; abilities are also removed). Returns true when a row was
/// deleted.
pub async fn delete_channel(db: &D1Database, id: i64) -> worker::Result<bool> {
    let arg = D1Type::Integer(d1_i32(id));
    let result = db
        .prepare("DELETE FROM channels WHERE id = ?1")
        .bind_refs(&[arg])?
        .run()
        .await?;
    let changes = result.meta()?.and_then(|m| m.changes).unwrap_or(0);
    Ok(changes > 0)
}

pub async fn delete_channels_batch(db: &D1Database, ids: &[i64]) -> worker::Result<usize> {
    if ids.is_empty() {
        return Ok(0);
    }
    let mut total = 0usize;
    for chunk in ids.chunks(50) {
        let placeholders: Vec<String> = (0..chunk.len()).map(|i| format!("?{}", i + 1)).collect();
        let mut args: Vec<D1Type<'_>> = chunk
            .iter()
            .map(|id| D1Type::Integer(d1_i32(*id)))
            .collect();
        let _ = &mut args;
        let sql = format!(
            "DELETE FROM channels WHERE id IN ({})",
            placeholders.join(", ")
        );
        let result = db.prepare(&sql).bind_refs(&args)?.run().await?;
        let changes = result.meta()?.and_then(|m| m.changes).unwrap_or(0);
        total += changes as usize;
    }
    Ok(total)
}

// ---------------------------------------------------------------------------
// Abilities sync (load-bearing for relay channel selection)
// ---------------------------------------------------------------------------

/// Build the cross-product of `models_csv` × `group_csv` and insert one
/// ability row per (group, model, channel_id) tuple. Deduplicates on
/// (group_name, model, channel_id). `enabled` is 1 when the channel status
/// is enabled (1). Mirrors Go `model/ability.go::AddAbilities`.
pub async fn add_abilities_for_channel(
    db: &D1Database,
    channel_id: i64,
    models_csv: &str,
    group_csv: &str,
    status: i32,
    priority: i32,
    weight: i32,
) -> worker::Result<()> {
    let models: Vec<&str> = models_csv
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    let groups: Vec<&str> = group_csv
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    if models.is_empty() || groups.is_empty() {
        return Ok(());
    }
    let enabled = if status == 1 { 1 } else { 0 };
    // Deduplicate on (group, model).
    let mut seen: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
    for group in &groups {
        for model in &models {
            let key = (group.to_string(), model.to_string());
            if !seen.insert(key) {
                continue;
            }
            let args = [
                D1Type::Text(*group),
                D1Type::Text(*model),
                D1Type::Integer(d1_i32(channel_id)),
                D1Type::Integer(enabled),
                D1Type::Integer(priority),
                D1Type::Integer(weight),
            ];
            db.prepare(
                r#"
                INSERT INTO abilities (group_name, model, channel_id, enabled, priority, weight)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                ON CONFLICT(id) DO NOTHING
                "#,
            )
            .bind_refs(&args)?
            .run()
            .await?;
        }
    }
    Ok(())
}

/// Rebuild abilities for a single channel: delete its existing ability rows,
/// then re-insert from its current `models` × `group`. Mirrors Go
/// `UpdateAbilities`.
pub async fn update_abilities_for_channel(
    db: &D1Database,
    channel_id: i64,
    models_csv: &str,
    group_csv: &str,
    status: i32,
    priority: i32,
    weight: i32,
) -> worker::Result<()> {
    delete_abilities_for_channel(db, channel_id).await?;
    add_abilities_for_channel(
        db, channel_id, models_csv, group_csv, status, priority, weight,
    )
    .await
}

pub async fn delete_abilities_for_channel(db: &D1Database, channel_id: i64) -> worker::Result<()> {
    let arg = D1Type::Integer(d1_i32(channel_id));
    db.prepare("DELETE FROM abilities WHERE channel_id = ?1")
        .bind_refs(&[arg])?
        .run()
        .await?;
    Ok(())
}

/// Rebuild the entire `abilities` table from `channels.models × channels.group`.
/// Returns `(success_count, fail_count)`. Mirrors Go `FixChannelsAbilities`.
pub async fn fix_abilities(db: &D1Database) -> worker::Result<(usize, usize)> {
    // Truncate.
    let empty: &[D1Type<'_>] = &[];
    db.prepare("DELETE FROM abilities")
        .bind_refs(empty)?
        .run()
        .await?;
    // Load channels needed for the rebuild (only the fields abilities cares
    // about, to keep the row size down).
    #[derive(Deserialize)]
    struct ChannelAbilitiesSource {
        id: i64,
        models: String,
        #[serde(rename = "group")]
        group: String,
        status: i32,
        priority: i32,
        weight: i32,
    }
    let empty: &[D1Type<'_>] = &[];
    let channels = db
        // Channels are hard-deleted (no `deleted_at` column); load them all.
        .prepare(r#"SELECT id, models, "group", status, priority, weight FROM channels"#)
        .bind_refs(empty)?
        .all()
        .await?
        .results::<ChannelAbilitiesSource>()?;
    let mut success = 0usize;
    let mut fails = 0usize;
    for channel in channels {
        match add_abilities_for_channel(
            db,
            channel.id,
            &channel.models,
            &channel.group,
            channel.status,
            channel.priority,
            channel.weight,
        )
        .await
        {
            Ok(()) => success += 1,
            Err(err) => {
                worker::console_warn!(
                    "fix_abilities: failed to rebuild abilities for channel {}: {}",
                    channel.id,
                    err
                );
                fails += 1;
            }
        }
    }
    Ok((success, fails))
}

// ---------------------------------------------------------------------------
// Admin user CRUD (G5 P0): list, search, get, create, edit, delete, manage.
//
// Mirrors Go `controller/user.go` admin surface. Permission rules (caller
// role vs target role) are enforced in the handler layer via the
// `cinatoken_auth` helpers; these repository functions are unconditional.
//
// `AdminUserFullRow` is a wider projection than `AdminUserRow` (used by
// login/self) because the admin pages surface affiliation, remark, and
// binding fields. `password` is NEVER selected by these queries (SQL-level
// omit, mirroring Go's `.Omit("password")`); `access_token` is selected but
// the handler redacts it from responses.
// ---------------------------------------------------------------------------

/// Full user row for admin list/search/get responses. Excludes `password`
/// (never selected) and redacts `access_token` at the handler layer.
#[derive(Debug, Deserialize, PartialEq, serde::Serialize)]
pub struct AdminUserFullRow {
    pub id: i64,
    pub username: String,
    pub display_name: String,
    pub role: i32,
    pub status: i32,
    pub email: String,
    pub github_id: String,
    pub discord_id: String,
    pub oidc_id: String,
    pub wechat_id: String,
    pub telegram_id: String,
    pub linux_do_id: String,
    pub quota: i64,
    pub used_quota: i64,
    pub request_count: i64,
    pub channel_group: String,
    pub aff_code: String,
    pub aff_count: i64,
    pub aff_quota: i64,
    pub aff_history_quota: i64,
    pub inviter_id: i64,
    pub setting: String,
    pub remark: String,
    pub stripe_customer: String,
    pub created_at: i64,
    pub last_login_at: i64,
    pub deleted_at: Option<i64>,
}

/// Columns selected for admin user responses. `password` is deliberately
/// absent; `access_token` is also absent (it is never useful in an admin
/// response and would leak a credential).
const ADMIN_USER_FULL_COLUMNS: &str = r#"
  id, username, display_name, role, status, email, github_id, discord_id,
  oidc_id, wechat_id, telegram_id, linux_do_id, quota, used_quota,
  request_count, "group" AS channel_group, aff_code, aff_count, aff_quota,
  aff_history AS aff_history_quota, inviter_id, setting, remark,
  stripe_customer, created_at, last_login_at, deleted_at
"#;

/// List all users (including soft-deleted), newest first, paginated.
pub async fn list_users(
    db: &D1Database,
    page: u32,
    page_size: u32,
) -> worker::Result<Vec<AdminUserFullRow>> {
    let page = page.max(1);
    let page_size = page_size.clamp(1, 100);
    let offset = (page - 1) * page_size;
    let args = [
        D1Type::Integer(page_size as i32),
        D1Type::Integer(offset as i32),
    ];
    let sql = format!(
        r#"
        SELECT {ADMIN_USER_FULL_COLUMNS}
        FROM users
        ORDER BY id DESC
        LIMIT ?1 OFFSET ?2
        "#,
    );
    Ok(db
        .prepare(&sql)
        .bind_refs(&args)?
        .all()
        .await?
        .results::<AdminUserFullRow>()?)
}

/// Search users by keyword (id / username / email / display_name), optionally
/// filtered by group/role/status. `status == Some(-1)` selects only
/// soft-deleted users; any other `Some(n)` selects live users with that
/// status. Mirrors Go `model/user.go::SearchUsers`.
pub async fn search_users(
    db: &D1Database,
    keyword: Option<&str>,
    group: Option<&str>,
    role: Option<i32>,
    status: Option<i32>,
    page: u32,
    page_size: u32,
) -> worker::Result<Vec<AdminUserFullRow>> {
    let page = page.max(1);
    let page_size = page_size.clamp(1, 100);
    let offset = (page - 1) * page_size;

    let mut conditions: Vec<String> = Vec::new();
    let mut args: Vec<D1Type<'_>> = Vec::new();
    let mut idx;
    if let Some(keyword) = keyword {
        let trimmed = keyword.trim();
        if !trimmed.is_empty() {
            idx = args.len() + 1;
            let id_match = trimmed.parse::<i64>().ok();
            if let Some(numeric_id) = id_match {
                conditions.push(format!(
                    "(id = ?{idx} OR username LIKE '%' || ?{id_idx} || '%' OR email LIKE '%' || ?{email_idx} || '%' OR display_name LIKE '%' || ?{name_idx} || '%')",
                    id_idx = idx,
                    email_idx = idx,
                    name_idx = idx
                ));
                args.push(D1Type::Integer(d1_i32(numeric_id)));
                args.push(D1Type::Text(trimmed));
                args.push(D1Type::Text(trimmed));
                args.push(D1Type::Text(trimmed));
            } else {
                conditions.push(format!(
                    "(username LIKE '%' || ?{idx} || '%' OR email LIKE '%' || ?{idx} || '%' OR display_name LIKE '%' || ?{idx} || '%')"
                ));
                args.push(D1Type::Text(trimmed));
            }
        }
    }
    if let Some(group) = group {
        let trimmed = group.trim();
        if !trimmed.is_empty() {
            idx = args.len() + 1;
            conditions.push(format!("\"group\" LIKE '%' || ?{idx} || '%'"));
            args.push(D1Type::Text(trimmed));
        }
    }
    if let Some(role) = role {
        idx = args.len() + 1;
        conditions.push(format!("role = ?{idx}"));
        args.push(D1Type::Integer(role));
    }
    if let Some(status) = status {
        if status == -1 {
            conditions.push("deleted_at IS NOT NULL".to_string());
        } else {
            idx = args.len() + 1;
            conditions.push(format!("deleted_at IS NULL AND status = ?{idx}"));
            args.push(D1Type::Integer(status));
        }
    }
    let where_sql = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };
    idx = args.len() + 1;
    let limit_index = idx;
    args.push(D1Type::Integer(page_size as i32));
    idx = args.len() + 1;
    let offset_index = idx;
    args.push(D1Type::Integer(offset as i32));
    let sql = format!(
        r#"
        SELECT {ADMIN_USER_FULL_COLUMNS}
        FROM users
        {where_sql}
        ORDER BY id DESC
        LIMIT ?{limit_index} OFFSET ?{offset_index}
        "#,
    );
    Ok(db
        .prepare(&sql)
        .bind_refs(&args)?
        .all()
        .await?
        .results::<AdminUserFullRow>()?)
}

pub async fn count_users(db: &D1Database) -> worker::Result<i64> {
    #[derive(Deserialize)]
    struct Count {
        count: i64,
    }
    let empty: &[D1Type<'_>] = &[];
    let row = db
        .prepare("SELECT COUNT(*) AS count FROM users")
        .bind_refs(empty)?
        .first::<Count>(None)
        .await?;
    Ok(row.map(|r| r.count).unwrap_or(0))
}

pub async fn count_search_users(
    db: &D1Database,
    keyword: Option<&str>,
    group: Option<&str>,
    role: Option<i32>,
    status: Option<i32>,
) -> worker::Result<i64> {
    #[derive(Deserialize)]
    struct Count {
        count: i64,
    }
    let mut conditions: Vec<String> = Vec::new();
    let mut args: Vec<D1Type<'_>> = Vec::new();
    let mut idx;
    if let Some(keyword) = keyword {
        let trimmed = keyword.trim();
        if !trimmed.is_empty() {
            idx = args.len() + 1;
            let id_match = trimmed.parse::<i64>().ok();
            if let Some(numeric_id) = id_match {
                conditions.push(format!(
                    "(id = ?{idx} OR username LIKE '%' || ?{id_idx} || '%' OR email LIKE '%' || ?{email_idx} || '%' OR display_name LIKE '%' || ?{name_idx} || '%')",
                    id_idx = idx,
                    email_idx = idx,
                    name_idx = idx
                ));
                args.push(D1Type::Integer(d1_i32(numeric_id)));
                args.push(D1Type::Text(trimmed));
                args.push(D1Type::Text(trimmed));
                args.push(D1Type::Text(trimmed));
            } else {
                conditions.push(format!(
                    "(username LIKE '%' || ?{idx} || '%' OR email LIKE '%' || ?{idx} || '%' OR display_name LIKE '%' || ?{idx} || '%')"
                ));
                args.push(D1Type::Text(trimmed));
            }
        }
    }
    if let Some(group) = group {
        let trimmed = group.trim();
        if !trimmed.is_empty() {
            idx = args.len() + 1;
            conditions.push(format!("\"group\" LIKE '%' || ?{idx} || '%'"));
            args.push(D1Type::Text(trimmed));
        }
    }
    if let Some(role) = role {
        idx = args.len() + 1;
        conditions.push(format!("role = ?{idx}"));
        args.push(D1Type::Integer(role));
    }
    if let Some(status) = status {
        if status == -1 {
            conditions.push("deleted_at IS NOT NULL".to_string());
        } else {
            idx = args.len() + 1;
            conditions.push(format!("deleted_at IS NULL AND status = ?{idx}"));
            args.push(D1Type::Integer(status));
        }
    }
    let where_sql = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };
    let sql = format!("SELECT COUNT(*) AS count FROM users {where_sql}");
    let row = db
        .prepare(&sql)
        .bind_refs(&args)?
        .first::<Count>(None)
        .await?;
    Ok(row.map(|r| r.count).unwrap_or(0))
}

/// Find a user by id, including soft-deleted rows (admin view). Omits
/// `password`.
pub async fn find_user_by_id_full(
    db: &D1Database,
    id: i64,
) -> worker::Result<Option<AdminUserFullRow>> {
    let arg = D1Type::Integer(d1_i32(id));
    let sql = format!("SELECT {ADMIN_USER_FULL_COLUMNS} FROM users WHERE id = ?1 LIMIT 1");
    db.prepare(&sql)
        .bind_refs(&[arg])?
        .first::<AdminUserFullRow>(None)
        .await
}

/// Load the role + status of a user by id (for permission checks before
/// loading the full row). Includes soft-deleted rows.
#[derive(Debug, Deserialize)]
pub struct UserRoleStatus {
    pub id: i64,
    pub username: String,
    pub role: i32,
    pub status: i32,
    pub group: String,
    pub session_epoch: i64,
    pub deleted_at: Option<i64>,
}

pub async fn find_user_role_status(
    db: &D1Database,
    id: i64,
) -> worker::Result<Option<UserRoleStatus>> {
    let arg = D1Type::Integer(d1_i32(id));
    db.prepare(r#"SELECT id, username, role, status, "group", session_epoch, deleted_at FROM users WHERE id = ?1 LIMIT 1"#)
        .bind_refs(&[arg])?
        .first::<UserRoleStatus>(None)
        .await
}

/// Create params for a new user. `password_hash` is pre-bcrypt'd by the
/// caller. `aff_code` is a pre-generated 4-char affiliation code.
#[derive(Debug, Clone)]
pub struct CreateUser<'a> {
    pub username: &'a str,
    pub password_hash: &'a str,
    pub display_name: &'a str,
    pub email: &'a str,
    pub role: i32,
    pub group: &'a str,
    pub aff_code: &'a str,
    pub quota: i64,
    /// The inviting user's id (Go `User.InviterId`), or 0 when there is no
    /// inviter. Set from the registrant's affiliation code.
    pub inviter_id: i64,
    pub created_at: i64,
}

pub async fn create_user(db: &D1Database, params: CreateUser<'_>) -> worker::Result<i64> {
    let args = [
        D1Type::Text(params.username),
        D1Type::Text(params.password_hash),
        D1Type::Text(params.display_name),
        D1Type::Text(params.email),
        D1Type::Integer(params.role),
        D1Type::Integer(d1_i32(params.quota)),
        D1Type::Text(params.group),
        D1Type::Text(params.aff_code),
        D1Type::Integer(d1_i32(params.created_at)),
        D1Type::Integer(d1_i32(params.inviter_id)),
    ];
    db.prepare(
        r#"
        INSERT INTO users (
          username, password, display_name, email, role, status, quota, used_quota,
          request_count, "group", aff_code, aff_count, aff_quota,
          aff_history, inviter_id, setting, created_at, last_login_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, 0, 0, ?7, ?8, 0, 0, 0, ?10, '{}', ?9, 0)
        "#,
    )
    .bind_refs(&args)?
    .run()
    .await?;
    let arg = D1Type::Text(params.username);
    #[derive(Deserialize)]
    struct Id {
        id: i64,
    }
    let row = db
        .prepare("SELECT id FROM users WHERE username = ?1 ORDER BY id DESC LIMIT 1")
        .bind_refs(&[arg])?
        .first::<Id>(None)
        .await?;
    Ok(row
        .map(|r| r.id)
        .ok_or_else(|| worker::Error::RustError("user insert not found after create".into()))?)
}

/// Resolve an affiliation code to the owning user's id (Go
/// `GetUserIdByAffCode`). An empty code or no match returns `None`.
pub async fn find_user_id_by_aff_code(
    db: &D1Database,
    aff_code: &str,
) -> worker::Result<Option<i64>> {
    if aff_code.is_empty() {
        return Ok(None);
    }
    #[derive(Deserialize)]
    struct Id {
        id: i64,
    }
    let arg = D1Type::Text(aff_code);
    let row = db
        .prepare("SELECT id FROM users WHERE aff_code = ?1 AND deleted_at IS NULL LIMIT 1")
        .bind_refs(&[arg])?
        .first::<Id>(None)
        .await?;
    Ok(row.map(|r| r.id))
}

/// Record an inviter's affiliation reward tracking on a successful referral
/// (Go `inviteUser`): bump `aff_count` and accrue `aff_quota` / `aff_history`
/// by `quota_for_inviter`. Note that Go does NOT credit the inviter's spendable
/// quota here (that `IncreaseUserQuota` call is commented out upstream) — only
/// the affiliation counters move.
pub async fn record_inviter_aff(
    db: &D1Database,
    inviter_id: i64,
    quota_for_inviter: i64,
) -> worker::Result<()> {
    let args = [
        D1Type::Integer(d1_i32(quota_for_inviter)),
        D1Type::Integer(d1_i32(inviter_id)),
    ];
    db.prepare(
        r#"
        UPDATE users
        SET aff_count = aff_count + 1,
            aff_quota = aff_quota + ?1,
            aff_history = aff_history + ?1
        WHERE id = ?2
        "#,
    )
    .bind_refs(&args)?
    .run()
    .await?;
    Ok(())
}

/// Read a user's affiliation code (may be empty for legacy rows). `None` when
/// the user does not exist / is soft-deleted.
pub async fn get_user_aff_code(db: &D1Database, id: i64) -> worker::Result<Option<String>> {
    #[derive(Deserialize)]
    struct AffCode {
        aff_code: String,
    }
    let arg = D1Type::Integer(d1_i32(id));
    let row = db
        .prepare(r#"SELECT aff_code FROM users WHERE id = ?1 AND deleted_at IS NULL LIMIT 1"#)
        .bind_refs(&[arg])?
        .first::<AffCode>(None)
        .await?;
    Ok(row.map(|r| r.aff_code))
}

/// Set a user's affiliation code (used to lazily backfill an empty code).
pub async fn update_user_aff_code(db: &D1Database, id: i64, aff_code: &str) -> worker::Result<()> {
    let args = [D1Type::Text(aff_code), D1Type::Integer(d1_i32(id))];
    db.prepare(r#"UPDATE users SET aff_code = ?1 WHERE id = ?2"#)
        .bind_refs(&args)?
        .run()
        .await?;
    Ok(())
}

/// Move `amount` from a user's affiliation quota into their spendable quota
/// (Go `TransferAffQuotaToQuota`). CAS-guarded on `aff_quota >= amount` so it is
/// atomic without a lock: returns `true` iff the transfer applied (the guard
/// held), `false` on insufficient affiliation quota.
pub async fn transfer_aff_quota(db: &D1Database, id: i64, amount: i64) -> worker::Result<bool> {
    let amount = quota_i32(amount)?;
    let args = [D1Type::Integer(amount), D1Type::Integer(d1_i32(id))];
    let result = db
        .prepare(
            r#"
            UPDATE users
            SET aff_quota = aff_quota - ?1,
                quota = quota + ?1
            WHERE id = ?2 AND aff_quota >= ?1
            "#,
        )
        .bind_refs(&args)?
        .run()
        .await?;
    let changes = result.meta()?.and_then(|m| m.changes).unwrap_or(0);
    Ok(changes > 0)
}

/// Distinct enabled model names available to a group (Go
/// `GetGroupEnabledModels`): `SELECT DISTINCT model FROM abilities WHERE
/// group_name = ? AND enabled = 1`. Ordered for a stable display list.
pub async fn distinct_enabled_models_for_group(
    db: &D1Database,
    group: &str,
) -> worker::Result<Vec<String>> {
    #[derive(Deserialize)]
    struct ModelRow {
        model: String,
    }
    let arg = D1Type::Text(group);
    db.prepare(
        r#"SELECT DISTINCT model FROM abilities WHERE group_name = ?1 AND enabled = 1 ORDER BY model"#,
    )
    .bind_refs(&[arg])?
    .all()
    .await?
    .results::<ModelRow>()
    .map(|rows| rows.into_iter().map(|row| row.model).collect())
}

const DISTINCT_CHAT_MODELS_SQL: &str = r#"
    WITH requested_groups(group_name) AS (
        SELECT CAST(value AS TEXT) FROM json_each(?1)
    ),
    requested_channel_types(channel_type) AS (
        SELECT CAST(value AS INTEGER) FROM json_each(?2)
    )
    SELECT DISTINCT a.model
    FROM abilities AS a
    INNER JOIN channels AS c ON c.id = a.channel_id
    INNER JOIN requested_groups AS rg ON rg.group_name = a.group_name
    INNER JOIN requested_channel_types AS rt ON rt.channel_type = c.type
    WHERE a.enabled = 1
      AND c.status = 1
      AND TRIM(a.model) != ''
    ORDER BY a.model
"#;

/// Distinct models that are usable through at least one enabled channel whose
/// adapter supports the requested route family. The caller supplies channel
/// types from the static provider capability registry, while every value is
/// still D1-bound rather than interpolated into SQL.
pub async fn distinct_enabled_models_for_groups_and_channel_types(
    db: &D1Database,
    groups: &[String],
    channel_types: &[i32],
) -> worker::Result<Vec<String>> {
    #[derive(Deserialize)]
    struct ModelRow {
        model: String,
    }

    if groups.is_empty() || channel_types.is_empty() {
        return Ok(Vec::new());
    }
    let groups_json = serde_json::to_string(groups).map_err(|err| {
        worker::Error::RustError(format!("failed to encode usable groups for D1: {err}"))
    })?;
    let channel_types_json = serde_json::to_string(channel_types).map_err(|err| {
        worker::Error::RustError(format!("failed to encode channel types for D1: {err}"))
    })?;
    let args = [
        D1Type::Text(&groups_json),
        D1Type::Text(&channel_types_json),
    ];

    db.prepare(DISTINCT_CHAT_MODELS_SQL)
        .bind_refs(&args)?
        .all()
        .await?
        .results::<ModelRow>()
        .map(|rows| rows.into_iter().map(|row| row.model).collect())
}

/// Read a user's `setting` JSON blob (Go `User.Setting`). `None` when the user
/// does not exist / is soft-deleted; the column itself defaults to `{}`.
pub async fn get_user_setting(db: &D1Database, id: i64) -> worker::Result<Option<String>> {
    #[derive(Deserialize)]
    struct Setting {
        setting: String,
    }
    let arg = D1Type::Integer(d1_i32(id));
    let row = db
        .prepare(r#"SELECT setting FROM users WHERE id = ?1 AND deleted_at IS NULL LIMIT 1"#)
        .bind_refs(&[arg])?
        .first::<Setting>(None)
        .await?;
    Ok(row.map(|r| r.setting))
}

/// Persist a user's `setting` JSON blob.
pub async fn update_user_setting(db: &D1Database, id: i64, setting: &str) -> worker::Result<()> {
    let args = [D1Type::Text(setting), D1Type::Integer(d1_i32(id))];
    db.prepare(r#"UPDATE users SET setting = ?1 WHERE id = ?2"#)
        .bind_refs(&args)?
        .run()
        .await?;
    Ok(())
}

/// One enabled ability row joined with its channel's type (Go
/// `GetAllEnableAbilityWithChannels`, trimmed to the pricing-relevant fields).
#[derive(Debug, Deserialize)]
pub struct AbilityWithChannelType {
    pub model: String,
    pub group_name: String,
    pub channel_type: i32,
}

/// All enabled abilities with their channel type (pricing source query).
pub async fn enabled_abilities_with_channel_type(
    db: &D1Database,
) -> worker::Result<Vec<AbilityWithChannelType>> {
    let empty: &[D1Type<'_>] = &[];
    db.prepare(
        r#"SELECT a.model AS model, a.group_name AS group_name,
                  COALESCE(c.type, 0) AS channel_type
           FROM abilities a LEFT JOIN channels c ON a.channel_id = c.id
           WHERE a.enabled = 1"#,
    )
    .bind_refs(empty)?
    .all()
    .await?
    .results::<AbilityWithChannelType>()
}

/// A live `models` metadata row (Go `model.Model`, pricing-relevant fields).
#[derive(Debug, Clone, Deserialize)]
pub struct ModelMetaRow {
    pub model_name: String,
    pub description: String,
    pub icon: String,
    pub tags: String,
    pub vendor_id: i64,
    pub endpoints: String,
    pub status: i32,
    pub name_rule: i32,
}

/// All live model-metadata rows.
pub async fn list_model_meta(db: &D1Database) -> worker::Result<Vec<ModelMetaRow>> {
    let empty: &[D1Type<'_>] = &[];
    db.prepare(
        r#"SELECT model_name, description, icon, tags, vendor_id, endpoints,
                  status, name_rule
           FROM models WHERE deleted_at IS NULL"#,
    )
    .bind_refs(empty)?
    .all()
    .await?
    .results::<ModelMetaRow>()
}

/// A live `vendors` row (Go `model.Vendor`, pricing-relevant fields).
#[derive(Debug, Deserialize, serde::Serialize)]
pub struct VendorRow {
    pub id: i64,
    pub name: String,
    pub description: String,
    pub icon: String,
}

/// All live vendor rows.
pub async fn list_vendors(db: &D1Database) -> worker::Result<Vec<VendorRow>> {
    let empty: &[D1Type<'_>] = &[];
    db.prepare(r#"SELECT id, name, description, icon FROM vendors WHERE deleted_at IS NULL"#)
        .bind_refs(empty)?
        .all()
        .await?
        .results::<VendorRow>()
}

/// A full `models` metadata row for the admin CRUD (Go `model.Model`).
#[derive(Debug, Deserialize, serde::Serialize)]
pub struct ModelMetaFull {
    pub id: i64,
    pub model_name: String,
    pub description: String,
    pub icon: String,
    pub tags: String,
    pub vendor_id: i64,
    pub endpoints: String,
    pub status: i32,
    pub sync_official: i32,
    pub name_rule: i32,
    pub created_time: i64,
    pub updated_time: i64,
}

const MODEL_META_COLUMNS: &str = r#"id, model_name, description, icon, tags, vendor_id,
    endpoints, status, sync_official, name_rule, created_time, updated_time"#;

/// A channel bound to one enabled ability for a model (Go `model.BoundChannel`).
#[derive(Debug, Clone, Deserialize, serde::Serialize, PartialEq, Eq, Hash)]
pub struct BoundChannel {
    pub name: String,
    #[serde(rename = "type")]
    pub channel_type: i32,
}

#[derive(Debug, Deserialize)]
struct BoundChannelByModel {
    model: String,
    name: String,
    channel_type: i32,
}

/// Page of live model-metadata rows filtered by an optional keyword
/// (model_name/description/tags LIKE), optional vendor id, and optional
/// status/sync flags. Returns `(rows, total)` for the shared filter.
pub async fn list_models_meta(
    db: &D1Database,
    keyword: Option<&str>,
    vendor_id: Option<i64>,
    status: Option<i32>,
    sync_official: Option<i32>,
    offset: u32,
    limit: u32,
) -> worker::Result<(Vec<ModelMetaFull>, i64)> {
    let mut wheres = vec!["deleted_at IS NULL".to_string()];
    let mut args: Vec<D1Type<'_>> = Vec::new();
    let pattern;
    if let Some(keyword) = keyword.filter(|keyword| !keyword.is_empty()) {
        pattern = format!("%{keyword}%");
        args.push(D1Type::Text(&pattern));
        let n = args.len();
        wheres.push(format!(
            "(model_name LIKE ?{n} OR description LIKE ?{n} OR tags LIKE ?{n})"
        ));
    }
    if let Some(vendor_id) = vendor_id {
        args.push(D1Type::Integer(d1_i32(vendor_id)));
        wheres.push(format!("vendor_id = ?{}", args.len()));
    }
    if let Some(status) = status {
        if status == 1 {
            args.push(D1Type::Integer(1));
            wheres.push(format!("status = ?{}", args.len()));
        } else {
            wheres.push("status != 1".to_string());
        }
    }
    if let Some(sync_official) = sync_official {
        if sync_official == 1 {
            args.push(D1Type::Integer(1));
            wheres.push(format!("sync_official = ?{}", args.len()));
        } else {
            wheres.push("sync_official != 1".to_string());
        }
    }
    let where_sql = wheres.join(" AND ");

    #[derive(Deserialize)]
    struct Count {
        total: i64,
    }
    let total = db
        .prepare(&format!(
            "SELECT COUNT(*) AS total FROM models WHERE {where_sql}"
        ))
        .bind_refs(&args)?
        .first::<Count>(None)
        .await?
        .map(|count| count.total)
        .unwrap_or(0);

    args.push(D1Type::Integer(d1_i32(i64::from(limit))));
    let limit_n = args.len();
    args.push(D1Type::Integer(d1_i32(i64::from(offset))));
    let offset_n = args.len();
    let rows = db
        .prepare(&format!(
            "SELECT {MODEL_META_COLUMNS} FROM models WHERE {where_sql}
             ORDER BY id DESC LIMIT ?{limit_n} OFFSET ?{offset_n}"
        ))
        .bind_refs(&args)?
        .all()
        .await?
        .results::<ModelMetaFull>()?;
    Ok((rows, total))
}

/// Batch-load channels bound to enabled ability rows for the given models.
/// This mirrors Go `GetBoundChannelsByModelsMap` without per-row lookups.
pub async fn bound_channels_by_models(
    db: &D1Database,
    models: &[String],
) -> worker::Result<HashMap<String, Vec<BoundChannel>>> {
    let mut normalized = Vec::<String>::new();
    for model in models {
        let model = model.trim();
        if model.is_empty() || normalized.iter().any(|existing| existing == model) {
            continue;
        }
        normalized.push(model.to_string());
    }
    if normalized.is_empty() {
        return Ok(HashMap::new());
    }

    let placeholders = (1..=normalized.len())
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(", ");
    let args = normalized
        .iter()
        .map(|model| D1Type::Text(model))
        .collect::<Vec<_>>();
    let rows = db
        .prepare(&format!(
            r#"SELECT DISTINCT a.model AS model, c.name AS name,
                      COALESCE(c.type, 0) AS channel_type
               FROM abilities a
               JOIN channels c ON c.id = a.channel_id
               WHERE a.enabled = 1 AND a.model IN ({placeholders})
               ORDER BY a.model ASC, c.name ASC, c.type ASC"#
        ))
        .bind_refs(&args)?
        .all()
        .await?
        .results::<BoundChannelByModel>()?;

    let mut by_model = HashMap::<String, Vec<BoundChannel>>::new();
    for row in rows {
        by_model.entry(row.model).or_default().push(BoundChannel {
            name: row.name,
            channel_type: row.channel_type,
        });
    }
    Ok(by_model)
}

/// Count live metadata rows per vendor for the model-management vendor filter.
pub async fn vendor_model_counts(db: &D1Database) -> worker::Result<HashMap<String, i64>> {
    #[derive(Deserialize)]
    struct VendorModelCount {
        vendor_id: i64,
        total: i64,
    }
    let rows = db
        .prepare(
            r#"SELECT vendor_id AS vendor_id, COUNT(*) AS total
               FROM models
               WHERE deleted_at IS NULL
               GROUP BY vendor_id"#,
        )
        .bind_refs(&[] as &[D1Type<'_>])?
        .all()
        .await?
        .results::<VendorModelCount>()?;
    let mut counts = HashMap::new();
    let mut all = 0;
    for row in rows {
        all += row.total;
        counts.insert(row.vendor_id.to_string(), row.total);
    }
    counts.insert("all".to_string(), all);
    Ok(counts)
}

/// One live model-metadata row by id.
pub async fn get_model_meta(db: &D1Database, id: i64) -> worker::Result<Option<ModelMetaFull>> {
    let arg = D1Type::Integer(d1_i32(id));
    db.prepare(&format!(
        "SELECT {MODEL_META_COLUMNS} FROM models WHERE id = ?1 AND deleted_at IS NULL LIMIT 1"
    ))
    .bind_refs(&[arg])?
    .first::<ModelMetaFull>(None)
    .await
}

/// Is a live model-metadata row (other than `exclude_id`) already using `name`?
pub async fn model_meta_name_duplicated(
    db: &D1Database,
    exclude_id: i64,
    name: &str,
) -> worker::Result<bool> {
    #[derive(Deserialize)]
    struct Count {
        total: i64,
    }
    let args = [D1Type::Text(name), D1Type::Integer(d1_i32(exclude_id))];
    let total = db
        .prepare(
            r#"SELECT COUNT(*) AS total FROM models
               WHERE model_name = ?1 AND id != ?2 AND deleted_at IS NULL"#,
        )
        .bind_refs(&args)?
        .first::<Count>(None)
        .await?
        .map(|count| count.total)
        .unwrap_or(0);
    Ok(total > 0)
}

/// Insert a model-metadata row; returns the new id.
pub async fn insert_model_meta(db: &D1Database, row: &ModelMetaFull) -> worker::Result<i64> {
    let args = [
        D1Type::Text(&row.model_name),
        D1Type::Text(&row.description),
        D1Type::Text(&row.icon),
        D1Type::Text(&row.tags),
        D1Type::Integer(d1_i32(row.vendor_id)),
        D1Type::Text(&row.endpoints),
        D1Type::Integer(row.status),
        D1Type::Integer(row.sync_official),
        D1Type::Integer(row.name_rule),
        D1Type::Integer(d1_i32(row.created_time)),
        D1Type::Integer(d1_i32(row.updated_time)),
    ];
    db.prepare(
        r#"INSERT INTO models (model_name, description, icon, tags, vendor_id,
             endpoints, status, sync_official, name_rule, created_time, updated_time)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)"#,
    )
    .bind_refs(&args)?
    .run()
    .await?;
    #[derive(Deserialize)]
    struct Id {
        id: i64,
    }
    let row = db
        .prepare("SELECT id FROM models ORDER BY id DESC LIMIT 1")
        .bind_refs(&[] as &[D1Type<'_>])?
        .first::<Id>(None)
        .await?;
    Ok(row.map(|r| r.id).unwrap_or(0))
}

/// Full update of a model-metadata row (all mutable fields).
pub async fn update_model_meta(db: &D1Database, row: &ModelMetaFull) -> worker::Result<()> {
    let args = [
        D1Type::Text(&row.model_name),
        D1Type::Text(&row.description),
        D1Type::Text(&row.icon),
        D1Type::Text(&row.tags),
        D1Type::Integer(d1_i32(row.vendor_id)),
        D1Type::Text(&row.endpoints),
        D1Type::Integer(row.status),
        D1Type::Integer(row.sync_official),
        D1Type::Integer(row.name_rule),
        D1Type::Integer(d1_i32(row.updated_time)),
        D1Type::Integer(d1_i32(row.id)),
    ];
    db.prepare(
        r#"UPDATE models SET model_name = ?1, description = ?2, icon = ?3, tags = ?4,
             vendor_id = ?5, endpoints = ?6, status = ?7, sync_official = ?8,
             name_rule = ?9, updated_time = ?10
           WHERE id = ?11 AND deleted_at IS NULL"#,
    )
    .bind_refs(&args)?
    .run()
    .await?;
    Ok(())
}

/// Status-only update (Go `UpdateModelMeta?status_only=true`).
pub async fn update_model_meta_status(db: &D1Database, id: i64, status: i32) -> worker::Result<()> {
    let args = [D1Type::Integer(status), D1Type::Integer(d1_i32(id))];
    db.prepare(r#"UPDATE models SET status = ?1 WHERE id = ?2 AND deleted_at IS NULL"#)
        .bind_refs(&args)?
        .run()
        .await?;
    Ok(())
}

/// Soft-delete a model-metadata row (Go gorm soft delete).
pub async fn soft_delete_model_meta(db: &D1Database, id: i64, now: i64) -> worker::Result<()> {
    let args = [D1Type::Integer(d1_i32(now)), D1Type::Integer(d1_i32(id))];
    db.prepare(r#"UPDATE models SET deleted_at = ?1 WHERE id = ?2 AND deleted_at IS NULL"#)
        .bind_refs(&args)?
        .run()
        .await?;
    Ok(())
}

/// A full `vendors` row for the admin CRUD (Go `model.Vendor`).
#[derive(Debug, Deserialize, serde::Serialize)]
pub struct VendorFull {
    pub id: i64,
    pub name: String,
    pub description: String,
    pub icon: String,
    pub status: i32,
    pub created_time: i64,
    pub updated_time: i64,
}

/// Page of live vendors filtered by an optional keyword. `(rows, total)`.
pub async fn list_vendors_page(
    db: &D1Database,
    keyword: Option<&str>,
    offset: u32,
    limit: u32,
) -> worker::Result<(Vec<VendorFull>, i64)> {
    let mut wheres = vec!["deleted_at IS NULL".to_string()];
    let mut args: Vec<D1Type<'_>> = Vec::new();
    let pattern;
    if let Some(keyword) = keyword.filter(|keyword| !keyword.is_empty()) {
        pattern = format!("%{keyword}%");
        args.push(D1Type::Text(&pattern));
        let n = args.len();
        wheres.push(format!("(name LIKE ?{n} OR description LIKE ?{n})"));
    }
    let where_sql = wheres.join(" AND ");
    #[derive(Deserialize)]
    struct Count {
        total: i64,
    }
    let total = db
        .prepare(&format!(
            "SELECT COUNT(*) AS total FROM vendors WHERE {where_sql}"
        ))
        .bind_refs(&args)?
        .first::<Count>(None)
        .await?
        .map(|count| count.total)
        .unwrap_or(0);
    args.push(D1Type::Integer(d1_i32(i64::from(limit))));
    let limit_n = args.len();
    args.push(D1Type::Integer(d1_i32(i64::from(offset))));
    let offset_n = args.len();
    let rows = db
        .prepare(&format!(
            "SELECT id, name, description, icon, status, created_time, updated_time
             FROM vendors WHERE {where_sql} ORDER BY id DESC LIMIT ?{limit_n} OFFSET ?{offset_n}"
        ))
        .bind_refs(&args)?
        .all()
        .await?
        .results::<VendorFull>()?;
    Ok((rows, total))
}

/// One live vendor by id.
pub async fn get_vendor(db: &D1Database, id: i64) -> worker::Result<Option<VendorFull>> {
    let arg = D1Type::Integer(d1_i32(id));
    db.prepare(
        r#"SELECT id, name, description, icon, status, created_time, updated_time
           FROM vendors WHERE id = ?1 AND deleted_at IS NULL LIMIT 1"#,
    )
    .bind_refs(&[arg])?
    .first::<VendorFull>(None)
    .await
}

/// Is a live vendor (other than `exclude_id`) already using `name`?
pub async fn vendor_name_duplicated(
    db: &D1Database,
    exclude_id: i64,
    name: &str,
) -> worker::Result<bool> {
    #[derive(Deserialize)]
    struct Count {
        total: i64,
    }
    let args = [D1Type::Text(name), D1Type::Integer(d1_i32(exclude_id))];
    let total = db
        .prepare(
            r#"SELECT COUNT(*) AS total FROM vendors
               WHERE name = ?1 AND id != ?2 AND deleted_at IS NULL"#,
        )
        .bind_refs(&args)?
        .first::<Count>(None)
        .await?
        .map(|count| count.total)
        .unwrap_or(0);
    Ok(total > 0)
}

/// Insert a vendor; returns the new id.
pub async fn insert_vendor(db: &D1Database, row: &VendorFull) -> worker::Result<i64> {
    let args = [
        D1Type::Text(&row.name),
        D1Type::Text(&row.description),
        D1Type::Text(&row.icon),
        D1Type::Integer(row.status),
        D1Type::Integer(d1_i32(row.created_time)),
        D1Type::Integer(d1_i32(row.updated_time)),
    ];
    db.prepare(
        r#"INSERT INTO vendors (name, description, icon, status, created_time, updated_time)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)"#,
    )
    .bind_refs(&args)?
    .run()
    .await?;
    #[derive(Deserialize)]
    struct Id {
        id: i64,
    }
    let row = db
        .prepare("SELECT id FROM vendors ORDER BY id DESC LIMIT 1")
        .bind_refs(&[] as &[D1Type<'_>])?
        .first::<Id>(None)
        .await?;
    Ok(row.map(|r| r.id).unwrap_or(0))
}

/// Full update of a vendor row.
pub async fn update_vendor(db: &D1Database, row: &VendorFull) -> worker::Result<()> {
    let args = [
        D1Type::Text(&row.name),
        D1Type::Text(&row.description),
        D1Type::Text(&row.icon),
        D1Type::Integer(row.status),
        D1Type::Integer(d1_i32(row.updated_time)),
        D1Type::Integer(d1_i32(row.id)),
    ];
    db.prepare(
        r#"UPDATE vendors SET name = ?1, description = ?2, icon = ?3, status = ?4,
             updated_time = ?5
           WHERE id = ?6 AND deleted_at IS NULL"#,
    )
    .bind_refs(&args)?
    .run()
    .await?;
    Ok(())
}

/// Soft-delete a vendor row.
pub async fn soft_delete_vendor(db: &D1Database, id: i64, now: i64) -> worker::Result<()> {
    let args = [D1Type::Integer(d1_i32(now)), D1Type::Integer(d1_i32(id))];
    db.prepare(r#"UPDATE vendors SET deleted_at = ?1 WHERE id = ?2 AND deleted_at IS NULL"#)
        .bind_refs(&args)?
        .run()
        .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Prefill groups
// ---------------------------------------------------------------------------

/// A live reusable prefill group (Go `model.PrefillGroup`).
///
/// D1 returns the JSON `items` column as text. The custom deserializer restores
/// the original JSON shape so arrays remain arrays and JSON strings remain
/// strings in the frontend response.
#[derive(Debug, Clone, Deserialize, serde::Serialize, PartialEq)]
pub struct PrefillGroup {
    pub id: i64,
    pub name: String,
    #[serde(rename = "type")]
    pub group_type: String,
    #[serde(default, deserialize_with = "deserialize_prefill_group_items")]
    pub items: Value,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub description: String,
    pub created_time: i64,
    pub updated_time: i64,
}

fn deserialize_prefill_group_items<'de, D>(deserializer: D) -> std::result::Result<Value, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    match value {
        Value::String(raw) => serde_json::from_str(&raw).map_err(serde::de::Error::custom),
        value => Ok(value),
    }
}

const PREFILL_GROUP_COLUMNS: &str =
    "id, name, type, items, description, created_time, updated_time";

fn list_prefill_groups_sql(filtered: bool) -> String {
    let type_filter = if filtered { " AND type = ?1" } else { "" };
    format!(
        "SELECT {PREFILL_GROUP_COLUMNS} FROM prefill_groups \
         WHERE deleted_at IS NULL{type_filter} ORDER BY updated_time DESC"
    )
}

/// All live prefill groups, optionally filtered by exact type.
pub async fn list_prefill_groups(
    db: &D1Database,
    group_type: Option<&str>,
) -> worker::Result<Vec<PrefillGroup>> {
    let sql = list_prefill_groups_sql(group_type.is_some());
    let args = group_type
        .map(|group_type| vec![D1Type::Text(group_type)])
        .unwrap_or_default();
    db.prepare(&sql)
        .bind_refs(&args)?
        .all()
        .await?
        .results::<PrefillGroup>()
}

/// One live prefill group by id.
pub async fn get_prefill_group(db: &D1Database, id: i64) -> worker::Result<Option<PrefillGroup>> {
    let arg = D1Type::Integer(d1_i32(id));
    db.prepare(&format!(
        "SELECT {PREFILL_GROUP_COLUMNS} FROM prefill_groups \
         WHERE id = ?1 AND deleted_at IS NULL LIMIT 1"
    ))
    .bind_refs(&[arg])?
    .first::<PrefillGroup>(None)
    .await
}

/// Is a live group other than `exclude_id` already using `name`?
pub async fn prefill_group_name_duplicated(
    db: &D1Database,
    exclude_id: i64,
    name: &str,
) -> worker::Result<bool> {
    if name.is_empty() {
        return Ok(false);
    }

    #[derive(Deserialize)]
    struct Count {
        total: i64,
    }

    let args = [D1Type::Text(name), D1Type::Integer(d1_i32(exclude_id))];
    let total = db
        .prepare(
            r#"SELECT COUNT(*) AS total FROM prefill_groups
               WHERE name = ?1 AND id != ?2 AND deleted_at IS NULL"#,
        )
        .bind_refs(&args)?
        .first::<Count>(None)
        .await?
        .map(|count| count.total)
        .unwrap_or(0);
    Ok(total > 0)
}

fn serialize_prefill_group_items(items: &Value) -> Option<String> {
    match items {
        Value::Null => None,
        value => Some(value.to_string()),
    }
}

/// Insert a prefill group. A non-zero id is retained for Go database imports
/// and direct API parity; zero uses SQLite's auto-generated row id.
pub async fn insert_prefill_group(db: &D1Database, row: &PrefillGroup) -> worker::Result<i64> {
    let items_json = serialize_prefill_group_items(&row.items);
    let items_arg = items_json
        .as_deref()
        .map(D1Type::Text)
        .unwrap_or(D1Type::Null);
    let common_args = [
        D1Type::Text(&row.name),
        D1Type::Text(&row.group_type),
        items_arg,
        D1Type::Text(&row.description),
        D1Type::Integer(d1_i32(row.created_time)),
        D1Type::Integer(d1_i32(row.updated_time)),
    ];

    if row.id == 0 {
        let result = db
            .prepare(
                r#"INSERT INTO prefill_groups
                   (name, type, items, description, created_time, updated_time)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6)"#,
            )
            .bind_refs(&common_args)?
            .run()
            .await?;
        return result
            .meta()?
            .and_then(|metadata| metadata.last_row_id)
            .ok_or_else(|| {
                worker::Error::RustError(
                    "D1 insert metadata did not include a prefill group row id".to_string(),
                )
            });
    }

    let args = [
        D1Type::Integer(d1_i32(row.id)),
        D1Type::Text(&row.name),
        D1Type::Text(&row.group_type),
        items_json
            .as_deref()
            .map(D1Type::Text)
            .unwrap_or(D1Type::Null),
        D1Type::Text(&row.description),
        D1Type::Integer(d1_i32(row.created_time)),
        D1Type::Integer(d1_i32(row.updated_time)),
    ];
    db.prepare(
        r#"INSERT INTO prefill_groups
           (id, name, type, items, description, created_time, updated_time)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"#,
    )
    .bind_refs(&args)?
    .run()
    .await?;
    Ok(row.id)
}

/// Save all fields for a prefill group, matching Go's `gorm.DB.Save` update
/// semantics (including insertion when the supplied id does not yet exist).
pub async fn save_prefill_group(db: &D1Database, row: &PrefillGroup) -> worker::Result<()> {
    let items_json = serialize_prefill_group_items(&row.items);
    let args = [
        D1Type::Integer(d1_i32(row.id)),
        D1Type::Text(&row.name),
        D1Type::Text(&row.group_type),
        items_json
            .as_deref()
            .map(D1Type::Text)
            .unwrap_or(D1Type::Null),
        D1Type::Text(&row.description),
        D1Type::Integer(d1_i32(row.created_time)),
        D1Type::Integer(d1_i32(row.updated_time)),
    ];
    db.prepare(
        r#"INSERT INTO prefill_groups
           (id, name, type, items, description, created_time, updated_time)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             type = excluded.type,
             items = excluded.items,
             description = excluded.description,
             created_time = excluded.created_time,
             updated_time = excluded.updated_time,
             deleted_at = NULL"#,
    )
    .bind_refs(&args)?
    .run()
    .await?;
    Ok(())
}

/// Soft-delete a prefill group. Missing/already-deleted ids are successful,
/// matching GORM's `Delete` behavior.
pub async fn soft_delete_prefill_group(db: &D1Database, id: i64, now: i64) -> worker::Result<()> {
    let args = [D1Type::Integer(d1_i32(now)), D1Type::Integer(d1_i32(id))];
    db.prepare(
        r#"UPDATE prefill_groups
           SET deleted_at = ?1
           WHERE id = ?2 AND deleted_at IS NULL"#,
    )
    .bind_refs(&args)?
    .run()
    .await?;
    Ok(())
}

/// All distinct enabled model names across every group (Go `GetEnabledModels`):
/// `SELECT DISTINCT model FROM abilities WHERE enabled = 1`. Ordered.
pub async fn distinct_all_enabled_models(db: &D1Database) -> worker::Result<Vec<String>> {
    #[derive(Deserialize)]
    struct ModelRow {
        model: String,
    }
    let empty: &[D1Type<'_>] = &[];
    db.prepare(r#"SELECT DISTINCT model FROM abilities WHERE enabled = 1 ORDER BY model"#)
        .bind_refs(empty)?
        .all()
        .await?
        .results::<ModelRow>()
        .map(|rows| rows.into_iter().map(|row| row.model).collect())
}

/// Set a user's system access token (Go `GenerateAccessToken`). Distinct from
/// relay API keys; stored in `users.access_token`.
pub async fn update_user_access_token(db: &D1Database, id: i64, token: &str) -> worker::Result<()> {
    let args = [D1Type::Text(token), D1Type::Integer(d1_i32(id))];
    db.prepare(r#"UPDATE users SET access_token = ?1 WHERE id = ?2"#)
        .bind_refs(&args)?
        .run()
        .await?;
    Ok(())
}

/// Bind/replace a user's email after an out-of-band verification code succeeds.
pub async fn update_user_email(db: &D1Database, id: i64, email: &str) -> worker::Result<bool> {
    let email = email.trim();
    if email.is_empty() {
        return Ok(false);
    }
    let result = db
        .prepare("UPDATE users SET email = ?1 WHERE id = ?2 AND deleted_at IS NULL")
        .bind_refs(&[D1Type::Text(email), D1Type::Integer(d1_i32(id))])?
        .run()
        .await?;
    Ok(result.meta()?.and_then(|meta| meta.changes).unwrap_or(0) > 0)
}

/// Reset a user's password by email. Returns false when no active row matched.
pub async fn reset_user_password_by_email(
    db: &D1Database,
    email: &str,
    password_hash: &str,
) -> worker::Result<bool> {
    let result = db
        .prepare("UPDATE users SET password = ?1 WHERE email = ?2 AND deleted_at IS NULL")
        .bind_refs(&[D1Type::Text(password_hash), D1Type::Text(email.trim())])?
        .run()
        .await?;
    Ok(result.meta()?.and_then(|meta| meta.changes).unwrap_or(0) > 0)
}

/// Edit a subset of user fields. Mirrors Go `Edit`: only username,
/// display_name, group, remark, and (optionally) password are updated.
/// role/status/quota are intentionally NOT touched here.
pub async fn edit_user(
    db: &D1Database,
    id: i64,
    username: Option<&str>,
    display_name: Option<&str>,
    group: Option<&str>,
    remark: Option<&str>,
    password_hash: Option<&str>,
) -> worker::Result<bool> {
    let mut sets: Vec<String> = Vec::new();
    let mut args: Vec<D1Type<'_>> = Vec::new();
    let mut idx;
    if let Some(username) = username {
        idx = args.len() + 1;
        sets.push(format!("username = ?{idx}"));
        args.push(D1Type::Text(username));
    }
    if let Some(display_name) = display_name {
        idx = args.len() + 1;
        sets.push(format!("display_name = ?{idx}"));
        args.push(D1Type::Text(display_name));
    }
    if let Some(group) = group {
        idx = args.len() + 1;
        sets.push(format!("\"group\" = ?{idx}"));
        args.push(D1Type::Text(group));
    }
    if let Some(remark) = remark {
        idx = args.len() + 1;
        sets.push(format!("remark = ?{idx}"));
        args.push(D1Type::Text(remark));
    }
    if let Some(password_hash) = password_hash {
        idx = args.len() + 1;
        sets.push(format!("password = ?{idx}"));
        args.push(D1Type::Text(password_hash));
    }
    if sets.is_empty() {
        return Ok(false);
    }
    idx = args.len() + 1;
    let id_index = idx;
    args.push(D1Type::Integer(d1_i32(id)));
    let sql = format!(
        "UPDATE users SET {} WHERE id = ?{id_index}",
        sets.join(", ")
    );
    let result = db.prepare(&sql).bind_refs(&args)?.run().await?;
    let changes = result.meta()?.and_then(|m| m.changes).unwrap_or(0);
    Ok(changes > 0)
}

pub async fn soft_delete_user(db: &D1Database, id: i64, now_unix: i64) -> worker::Result<bool> {
    let args = [
        D1Type::Integer(d1_i32(now_unix)),
        D1Type::Integer(d1_i32(id)),
    ];
    let result = db
        .prepare("UPDATE users SET deleted_at = ?1 WHERE id = ?2 AND deleted_at IS NULL")
        .bind_refs(&args)?
        .run()
        .await?;
    let changes = result.meta()?.and_then(|m| m.changes).unwrap_or(0);
    Ok(changes > 0)
}

pub async fn set_user_status(db: &D1Database, id: i64, status: i32) -> worker::Result<bool> {
    let args = [D1Type::Integer(status), D1Type::Integer(d1_i32(id))];
    let result = db
        .prepare("UPDATE users SET status = ?1 WHERE id = ?2")
        .bind_refs(&args)?
        .run()
        .await?;
    let changes = result.meta()?.and_then(|m| m.changes).unwrap_or(0);
    Ok(changes > 0)
}

pub async fn set_user_role(db: &D1Database, id: i64, role: i32) -> worker::Result<bool> {
    let args = [D1Type::Integer(role), D1Type::Integer(d1_i32(id))];
    let result = db
        .prepare("UPDATE users SET role = ?1 WHERE id = ?2")
        .bind_refs(&args)?
        .run()
        .await?;
    let changes = result.meta()?.and_then(|m| m.changes).unwrap_or(0);
    Ok(changes > 0)
}

pub async fn bump_user_session_epoch(
    db: &D1Database,
    id: i64,
    session_epoch: i64,
) -> worker::Result<bool> {
    let args = [
        D1Type::Integer(d1_i32(session_epoch)),
        D1Type::Integer(d1_i32(id)),
    ];
    let result = db
        .prepare(
            r#"
            UPDATE users
            SET session_epoch = CASE
                WHEN session_epoch > ?1 THEN session_epoch
                ELSE ?1
            END
            WHERE id = ?2
            "#,
        )
        .bind_refs(&args)?
        .run()
        .await?;
    let changes = result.meta()?.and_then(|m| m.changes).unwrap_or(0);
    Ok(changes > 0)
}

/// Atomically add to a user's quota: `UPDATE users SET quota = quota + ?`.
pub async fn increase_user_quota(db: &D1Database, id: i64, delta: i64) -> worker::Result<bool> {
    let args = [D1Type::Integer(d1_i32(delta)), D1Type::Integer(d1_i32(id))];
    let result = db
        .prepare("UPDATE users SET quota = quota + ?1 WHERE id = ?2")
        .bind_refs(&args)?
        .run()
        .await?;
    let changes = result.meta()?.and_then(|m| m.changes).unwrap_or(0);
    Ok(changes > 0)
}

// ---------------------------------------------------------------------------
// User daily check-in (Go model.Checkin).
// ---------------------------------------------------------------------------

/// Log type constant for user/system events. Mirrors Go `LogTypeSystem`.
pub const LOG_TYPE_SYSTEM: i32 = 4;

#[derive(Debug, Deserialize, serde::Serialize)]
pub struct CheckinRecordRow {
    pub checkin_date: String,
    pub quota_awarded: i64,
}

#[derive(Debug, Deserialize)]
struct CountRow {
    count: i64,
}

#[derive(Debug, Deserialize)]
struct SumRow {
    total: i64,
}

pub async fn list_user_checkins(
    db: &D1Database,
    user_id: i64,
    start_date: &str,
    end_date: &str,
) -> worker::Result<Vec<CheckinRecordRow>> {
    let args = [
        D1Type::Integer(d1_i32(user_id)),
        D1Type::Text(start_date),
        D1Type::Text(end_date),
    ];
    db.prepare(
        r#"
        SELECT checkin_date, quota_awarded
        FROM checkins
        WHERE user_id = ?1 AND checkin_date >= ?2 AND checkin_date <= ?3
        ORDER BY checkin_date DESC
        "#,
    )
    .bind_refs(&args)?
    .all()
    .await?
    .results::<CheckinRecordRow>()
}

pub async fn has_user_checkin(
    db: &D1Database,
    user_id: i64,
    checkin_date: &str,
) -> worker::Result<bool> {
    let args = [D1Type::Integer(d1_i32(user_id)), D1Type::Text(checkin_date)];
    let row = db
        .prepare(
            r#"
            SELECT COUNT(*) AS count
            FROM checkins
            WHERE user_id = ?1 AND checkin_date = ?2
            "#,
        )
        .bind_refs(&args)?
        .first::<CountRow>(None)
        .await?;
    Ok(row.map(|row| row.count > 0).unwrap_or(false))
}

pub async fn count_user_checkins(db: &D1Database, user_id: i64) -> worker::Result<i64> {
    let arg = D1Type::Integer(d1_i32(user_id));
    let row = db
        .prepare("SELECT COUNT(*) AS count FROM checkins WHERE user_id = ?1")
        .bind_refs(&arg)?
        .first::<CountRow>(None)
        .await?;
    Ok(row.map(|row| row.count).unwrap_or(0))
}

pub async fn sum_user_checkin_quota(db: &D1Database, user_id: i64) -> worker::Result<i64> {
    let arg = D1Type::Integer(d1_i32(user_id));
    let row = db
        .prepare(
            r#"
            SELECT COALESCE(SUM(quota_awarded), 0) AS total
            FROM checkins
            WHERE user_id = ?1
            "#,
        )
        .bind_refs(&arg)?
        .first::<SumRow>(None)
        .await?;
    Ok(row.map(|row| row.total).unwrap_or(0))
}

/// Insert one daily check-in row. Returns `false` when the unique daily guard
/// already exists.
pub async fn insert_user_checkin(
    db: &D1Database,
    user_id: i64,
    checkin_date: &str,
    quota_awarded: i64,
    created_at: i64,
) -> worker::Result<bool> {
    let args = [
        D1Type::Integer(d1_i32(user_id)),
        D1Type::Text(checkin_date),
        D1Type::Integer(d1_i32(quota_awarded)),
        D1Type::Integer(d1_i32(created_at)),
    ];
    let result = db
        .prepare(
            r#"
            INSERT OR IGNORE INTO checkins
              (user_id, checkin_date, quota_awarded, created_at)
            VALUES (?1, ?2, ?3, ?4)
            "#,
        )
        .bind_refs(&args)?
        .run()
        .await?;
    let changes = result.meta()?.and_then(|meta| meta.changes).unwrap_or(0);
    Ok(changes > 0)
}

pub async fn delete_user_checkin(
    db: &D1Database,
    user_id: i64,
    checkin_date: &str,
) -> worker::Result<()> {
    let args = [D1Type::Integer(d1_i32(user_id)), D1Type::Text(checkin_date)];
    db.prepare("DELETE FROM checkins WHERE user_id = ?1 AND checkin_date = ?2")
        .bind_refs(&args)?
        .run()
        .await?;
    Ok(())
}

pub async fn insert_system_log(
    db: &D1Database,
    user_id: i64,
    username: &str,
    content: &str,
    now: i64,
) -> worker::Result<()> {
    let args = [
        D1Type::Integer(d1_i32(user_id)),
        D1Type::Integer(d1_i32(now)),
        D1Type::Integer(LOG_TYPE_SYSTEM),
        D1Type::Text(content),
        D1Type::Text(username),
    ];
    db.prepare(
        r#"
        INSERT INTO logs (user_id, created_at, type, content, username)
        VALUES (?1, ?2, ?3, ?4, ?5)
        "#,
    )
    .bind_refs(&args)?
    .run()
    .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Subscriptions (Go model/subscription.go).
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct SubscriptionPlanRow {
    pub id: i64,
    pub title: String,
    pub subtitle: String,
    pub price_amount: f64,
    pub currency: String,
    pub duration_unit: String,
    pub duration_value: i64,
    pub custom_seconds: i64,
    pub enabled: i32,
    pub sort_order: i64,
    pub allow_balance_pay: i32,
    pub stripe_price_id: String,
    pub creem_product_id: String,
    pub waffo_pancake_product_id: String,
    pub max_purchase_per_user: i64,
    pub upgrade_group: String,
    pub total_amount: i64,
    pub quota_reset_period: String,
    pub quota_reset_custom_seconds: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone)]
pub struct SubscriptionPlanWrite<'a> {
    pub title: &'a str,
    pub subtitle: &'a str,
    pub price_amount: f64,
    pub currency: &'a str,
    pub duration_unit: &'a str,
    pub duration_value: i64,
    pub custom_seconds: i64,
    pub enabled: bool,
    pub sort_order: i64,
    pub allow_balance_pay: bool,
    pub stripe_price_id: &'a str,
    pub creem_product_id: &'a str,
    pub waffo_pancake_product_id: &'a str,
    pub max_purchase_per_user: i64,
    pub upgrade_group: &'a str,
    pub total_amount: i64,
    pub quota_reset_period: &'a str,
    pub quota_reset_custom_seconds: i64,
    pub now: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct UserSubscriptionRow {
    pub id: i64,
    pub user_id: i64,
    pub plan_id: i64,
    pub amount_total: i64,
    pub amount_used: i64,
    pub start_time: i64,
    pub end_time: i64,
    pub status: String,
    pub source: String,
    pub last_reset_time: i64,
    pub next_reset_time: i64,
    pub upgrade_group: String,
    pub prev_user_group: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone)]
pub struct UserSubscriptionWrite<'a> {
    pub user_id: i64,
    pub plan_id: i64,
    pub amount_total: i64,
    pub amount_used: i64,
    pub start_time: i64,
    pub end_time: i64,
    pub status: &'a str,
    pub source: &'a str,
    pub last_reset_time: i64,
    pub next_reset_time: i64,
    pub upgrade_group: &'a str,
    pub prev_user_group: &'a str,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SubscriptionUserState {
    pub quota: i64,
    pub group_name: String,
}

#[derive(Debug, Clone)]
pub struct SubscriptionOrderWrite<'a> {
    pub user_id: i64,
    pub plan_id: i64,
    pub money: f64,
    pub trade_no: &'a str,
    pub payment_method: &'a str,
    pub payment_provider: &'a str,
    pub status: &'a str,
    pub create_time: i64,
    pub complete_time: i64,
    pub provider_payload: &'a str,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct SubscriptionOrderRow {
    pub id: i64,
    pub user_id: i64,
    pub plan_id: i64,
    pub money: f64,
    pub trade_no: String,
    pub payment_method: String,
    pub payment_provider: String,
    pub status: String,
    pub create_time: i64,
    pub complete_time: i64,
    pub provider_payload: String,
}

#[derive(Debug, Clone)]
pub struct SubscriptionOrderSettlementWrite<'a> {
    pub subscription: UserSubscriptionWrite<'a>,
    pub trade_no: &'a str,
    pub expected_provider: &'a str,
    pub from_status: &'a str,
    pub to_status: &'a str,
    pub actual_payment_method: &'a str,
    pub provider_payload: &'a str,
    pub money: f64,
    pub create_time: i64,
    pub complete_time: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SubscriptionOrderSettlementBatchResult {
    pub subscription_inserted: bool,
    pub group_updated: bool,
    pub topup_inserted: bool,
    pub topup_updated: bool,
    pub order_marked: bool,
}

impl SubscriptionOrderSettlementBatchResult {
    pub fn topup_recorded(self) -> bool {
        self.topup_inserted || self.topup_updated
    }
}

const SUBSCRIPTION_PLAN_COLUMNS: &str = r#"
  id, title, subtitle, price_amount, currency, duration_unit, duration_value,
  custom_seconds, enabled, sort_order, allow_balance_pay, stripe_price_id,
  creem_product_id, waffo_pancake_product_id, max_purchase_per_user,
  upgrade_group, total_amount, quota_reset_period, quota_reset_custom_seconds,
  created_at, updated_at
"#;

const USER_SUBSCRIPTION_COLUMNS: &str = r#"
  id, user_id, plan_id, amount_total, amount_used, start_time, end_time,
  status, source, last_reset_time, next_reset_time, upgrade_group,
  prev_user_group, created_at, updated_at
"#;

const SUBSCRIPTION_ORDER_COLUMNS: &str = r#"
  id, user_id, plan_id, money, trade_no, payment_method, payment_provider,
  status, create_time, complete_time, provider_payload
"#;

pub async fn list_subscription_plans(
    db: &D1Database,
    include_disabled: bool,
) -> worker::Result<Vec<SubscriptionPlanRow>> {
    let sql = if include_disabled {
        format!(
            r#"
            SELECT {SUBSCRIPTION_PLAN_COLUMNS}
            FROM subscription_plans
            ORDER BY sort_order DESC, id DESC
            "#
        )
    } else {
        format!(
            r#"
            SELECT {SUBSCRIPTION_PLAN_COLUMNS}
            FROM subscription_plans
            WHERE enabled = 1
            ORDER BY sort_order DESC, id DESC
            "#
        )
    };
    db.prepare(&sql)
        .all()
        .await?
        .results::<SubscriptionPlanRow>()
}

pub async fn find_subscription_plan_by_id(
    db: &D1Database,
    id: i64,
) -> worker::Result<Option<SubscriptionPlanRow>> {
    let arg = D1Type::Integer(d1_i32(id));
    db.prepare(&format!(
        r#"
        SELECT {SUBSCRIPTION_PLAN_COLUMNS}
        FROM subscription_plans
        WHERE id = ?1
        LIMIT 1
        "#
    ))
    .bind_refs(&[arg])?
    .first::<SubscriptionPlanRow>(None)
    .await
}

pub async fn insert_subscription_plan(
    db: &D1Database,
    plan: &SubscriptionPlanWrite<'_>,
) -> worker::Result<i64> {
    let args = subscription_plan_write_args(plan, false, None)?;
    let result = db
        .prepare(
            r#"
            INSERT INTO subscription_plans (
              title, subtitle, price_amount, currency, duration_unit,
              duration_value, custom_seconds, enabled, sort_order,
              allow_balance_pay, stripe_price_id, creem_product_id,
              waffo_pancake_product_id, max_purchase_per_user, upgrade_group,
              total_amount, quota_reset_period, quota_reset_custom_seconds,
              created_at, updated_at
            )
            VALUES (
              ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
              ?15, ?16, ?17, ?18, ?19, ?20
            )
            "#,
        )
        .bind_refs(&args)?
        .run()
        .await?;
    result
        .meta()?
        .and_then(|metadata| metadata.last_row_id)
        .ok_or_else(|| {
            worker::Error::RustError(
                "D1 insert metadata did not include a subscription plan row id".to_string(),
            )
        })
}

pub async fn update_subscription_plan(
    db: &D1Database,
    id: i64,
    plan: &SubscriptionPlanWrite<'_>,
) -> worker::Result<bool> {
    let args = subscription_plan_write_args(plan, true, Some(id))?;
    let result = db
        .prepare(
            r#"
            UPDATE subscription_plans
               SET title = ?1,
                   subtitle = ?2,
                   price_amount = ?3,
                   currency = ?4,
                   duration_unit = ?5,
                   duration_value = ?6,
                   custom_seconds = ?7,
                   enabled = ?8,
                   sort_order = ?9,
                   allow_balance_pay = ?10,
                   stripe_price_id = ?11,
                   creem_product_id = ?12,
                   waffo_pancake_product_id = ?13,
                   max_purchase_per_user = ?14,
                   upgrade_group = ?15,
                   total_amount = ?16,
                   quota_reset_period = ?17,
                   quota_reset_custom_seconds = ?18,
                   updated_at = ?19
             WHERE id = ?20
            "#,
        )
        .bind_refs(&args)?
        .run()
        .await?;
    Ok(result.meta()?.and_then(|meta| meta.changes).unwrap_or(0) > 0)
}

pub async fn update_subscription_plan_status(
    db: &D1Database,
    id: i64,
    enabled: bool,
    updated_at: i64,
) -> worker::Result<bool> {
    let args = [
        D1Type::Integer(if enabled { 1 } else { 0 }),
        D1Type::Integer(d1_i32(updated_at)),
        D1Type::Integer(d1_i32(id)),
    ];
    let result = db
        .prepare("UPDATE subscription_plans SET enabled = ?1, updated_at = ?2 WHERE id = ?3")
        .bind_refs(&args)?
        .run()
        .await?;
    Ok(result.meta()?.and_then(|meta| meta.changes).unwrap_or(0) > 0)
}

fn subscription_plan_write_args<'a>(
    plan: &'a SubscriptionPlanWrite<'a>,
    update: bool,
    id: Option<i64>,
) -> worker::Result<Vec<D1Type<'a>>> {
    let mut args = vec![
        D1Type::Text(plan.title),
        D1Type::Text(plan.subtitle),
        D1Type::Real(plan.price_amount),
        D1Type::Text(plan.currency),
        D1Type::Text(plan.duration_unit),
        D1Type::Integer(d1_i32(plan.duration_value)),
        D1Type::Integer(d1_i32(plan.custom_seconds)),
        D1Type::Integer(if plan.enabled { 1 } else { 0 }),
        D1Type::Integer(d1_i32(plan.sort_order)),
        D1Type::Integer(if plan.allow_balance_pay { 1 } else { 0 }),
        D1Type::Text(plan.stripe_price_id),
        D1Type::Text(plan.creem_product_id),
        D1Type::Text(plan.waffo_pancake_product_id),
        D1Type::Integer(d1_i32(plan.max_purchase_per_user)),
        D1Type::Text(plan.upgrade_group),
        D1Type::Integer(d1_i32(plan.total_amount)),
        D1Type::Text(plan.quota_reset_period),
        D1Type::Integer(d1_i32(plan.quota_reset_custom_seconds)),
    ];
    if !update {
        args.push(D1Type::Integer(d1_i32(plan.now)));
    }
    args.push(D1Type::Integer(d1_i32(plan.now)));
    if let Some(id) = id {
        args.push(D1Type::Integer(d1_i32(id)));
    }
    Ok(args)
}

pub async fn list_user_subscriptions(
    db: &D1Database,
    user_id: i64,
    active_only: bool,
    now: i64,
) -> worker::Result<Vec<UserSubscriptionRow>> {
    let (sql, args) = if active_only {
        (
            format!(
                r#"
                SELECT {USER_SUBSCRIPTION_COLUMNS}
                FROM user_subscriptions
                WHERE user_id = ?1 AND status = 'active' AND end_time > ?2
                ORDER BY end_time DESC, id DESC
                "#
            ),
            vec![
                D1Type::Integer(d1_i32(user_id)),
                D1Type::Integer(d1_i32(now)),
            ],
        )
    } else {
        (
            format!(
                r#"
                SELECT {USER_SUBSCRIPTION_COLUMNS}
                FROM user_subscriptions
                WHERE user_id = ?1
                ORDER BY end_time DESC, id DESC
                "#
            ),
            vec![D1Type::Integer(d1_i32(user_id))],
        )
    };
    db.prepare(&sql)
        .bind_refs(&args)?
        .all()
        .await?
        .results::<UserSubscriptionRow>()
}

pub async fn count_user_subscriptions_by_plan(
    db: &D1Database,
    user_id: i64,
    plan_id: i64,
) -> worker::Result<i64> {
    let args = [
        D1Type::Integer(d1_i32(user_id)),
        D1Type::Integer(d1_i32(plan_id)),
    ];
    let row = db
        .prepare(
            r#"
            SELECT COUNT(*) AS count
            FROM user_subscriptions
            WHERE user_id = ?1 AND plan_id = ?2
            "#,
        )
        .bind_refs(&args)?
        .first::<CountRow>(None)
        .await?;
    Ok(row.map(|row| row.count).unwrap_or(0))
}

pub async fn find_user_subscription_by_id(
    db: &D1Database,
    id: i64,
) -> worker::Result<Option<UserSubscriptionRow>> {
    let arg = D1Type::Integer(d1_i32(id));
    db.prepare(&format!(
        r#"
        SELECT {USER_SUBSCRIPTION_COLUMNS}
        FROM user_subscriptions
        WHERE id = ?1
        LIMIT 1
        "#
    ))
    .bind_refs(&[arg])?
    .first::<UserSubscriptionRow>(None)
    .await
}

pub async fn insert_user_subscription(
    db: &D1Database,
    sub: &UserSubscriptionWrite<'_>,
) -> worker::Result<i64> {
    let args = [
        D1Type::Integer(d1_i32(sub.user_id)),
        D1Type::Integer(d1_i32(sub.plan_id)),
        D1Type::Integer(d1_i32(sub.amount_total)),
        D1Type::Integer(d1_i32(sub.amount_used)),
        D1Type::Integer(d1_i32(sub.start_time)),
        D1Type::Integer(d1_i32(sub.end_time)),
        D1Type::Text(sub.status),
        D1Type::Text(sub.source),
        D1Type::Integer(d1_i32(sub.last_reset_time)),
        D1Type::Integer(d1_i32(sub.next_reset_time)),
        D1Type::Text(sub.upgrade_group),
        D1Type::Text(sub.prev_user_group),
        D1Type::Integer(d1_i32(sub.created_at)),
        D1Type::Integer(d1_i32(sub.updated_at)),
    ];
    let result = db
        .prepare(
            r#"
            INSERT INTO user_subscriptions (
              user_id, plan_id, amount_total, amount_used, start_time, end_time,
              status, source, last_reset_time, next_reset_time, upgrade_group,
              prev_user_group, created_at, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
            "#,
        )
        .bind_refs(&args)?
        .run()
        .await?;
    result
        .meta()?
        .and_then(|metadata| metadata.last_row_id)
        .ok_or_else(|| {
            worker::Error::RustError(
                "D1 insert metadata did not include a user subscription row id".to_string(),
            )
        })
}

pub async fn cancel_user_subscription(db: &D1Database, id: i64, now: i64) -> worker::Result<bool> {
    let args = [D1Type::Integer(d1_i32(now)), D1Type::Integer(d1_i32(id))];
    let result = db
        .prepare(
            r#"
            UPDATE user_subscriptions
               SET status = 'cancelled', end_time = ?1, updated_at = ?1
             WHERE id = ?2
            "#,
        )
        .bind_refs(&args)?
        .run()
        .await?;
    Ok(result.meta()?.and_then(|meta| meta.changes).unwrap_or(0) > 0)
}

pub async fn delete_user_subscription(db: &D1Database, id: i64) -> worker::Result<bool> {
    let result = db
        .prepare("DELETE FROM user_subscriptions WHERE id = ?1")
        .bind_refs(&[D1Type::Integer(d1_i32(id))])?
        .run()
        .await?;
    Ok(result.meta()?.and_then(|meta| meta.changes).unwrap_or(0) > 0)
}

pub async fn active_upgrade_subscription_exists_excluding(
    db: &D1Database,
    user_id: i64,
    excluding_id: i64,
    now: i64,
) -> worker::Result<bool> {
    let args = [
        D1Type::Integer(d1_i32(user_id)),
        D1Type::Integer(d1_i32(now)),
        D1Type::Integer(d1_i32(excluding_id)),
    ];
    let row = db
        .prepare(
            r#"
            SELECT COUNT(*) AS count
            FROM user_subscriptions
            WHERE user_id = ?1
              AND status = 'active'
              AND end_time > ?2
              AND id <> ?3
              AND upgrade_group <> ''
            "#,
        )
        .bind_refs(&args)?
        .first::<CountRow>(None)
        .await?;
    Ok(row.map(|row| row.count > 0).unwrap_or(false))
}

pub async fn find_subscription_user_state(
    db: &D1Database,
    user_id: i64,
) -> worker::Result<Option<SubscriptionUserState>> {
    let arg = D1Type::Integer(d1_i32(user_id));
    db.prepare(
        r#"
        SELECT quota, "group" AS group_name
        FROM users
        WHERE id = ?1 AND deleted_at IS NULL
        LIMIT 1
        "#,
    )
    .bind_refs(&[arg])?
    .first::<SubscriptionUserState>(None)
    .await
}

pub async fn update_user_group(db: &D1Database, user_id: i64, group: &str) -> worker::Result<bool> {
    let args = [D1Type::Text(group), D1Type::Integer(d1_i32(user_id))];
    let result = db
        .prepare(r#"UPDATE users SET "group" = ?1 WHERE id = ?2 AND deleted_at IS NULL"#)
        .bind_refs(&args)?
        .run()
        .await?;
    Ok(result.meta()?.and_then(|meta| meta.changes).unwrap_or(0) > 0)
}

pub async fn decrease_user_quota_if_enough(
    db: &D1Database,
    user_id: i64,
    quota: i64,
) -> worker::Result<bool> {
    let quota = quota_i32(quota)?;
    let args = [D1Type::Integer(quota), D1Type::Integer(d1_i32(user_id))];
    let result = db
        .prepare(
            r#"
            UPDATE users
               SET quota = quota - ?1
             WHERE id = ?2 AND deleted_at IS NULL AND quota >= ?1
            "#,
        )
        .bind_refs(&args)?
        .run()
        .await?;
    Ok(result.meta()?.and_then(|meta| meta.changes).unwrap_or(0) > 0)
}

pub async fn insert_subscription_order(
    db: &D1Database,
    order: &SubscriptionOrderWrite<'_>,
) -> worker::Result<i64> {
    let amount = format!("{:.6}", order.money);
    let args = [
        D1Type::Integer(d1_i32(order.user_id)),
        D1Type::Text(order.payment_provider),
        D1Type::Text(order.trade_no),
        D1Type::Integer(d1_i32(order.plan_id)),
        D1Type::Text(order.status),
        D1Type::Text(&amount),
        D1Type::Text("USD"),
        D1Type::Integer(d1_i32(order.create_time)),
        D1Type::Integer(d1_i32(order.complete_time)),
        D1Type::Real(order.money),
        D1Type::Text(order.payment_method),
        D1Type::Text(order.provider_payload),
    ];
    let result = db
        .prepare(
            r#"
            INSERT INTO subscription_orders (
              user_id, provider, order_no, plan_id, status, amount, currency,
              created_at, updated_at, money, trade_no, payment_method,
              payment_provider, create_time, complete_time, provider_payload
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?3, ?11, ?2, ?8, ?9, ?12)
            "#,
        )
        .bind_refs(&args)?
        .run()
        .await?;
    result
        .meta()?
        .and_then(|metadata| metadata.last_row_id)
        .ok_or_else(|| {
            worker::Error::RustError(
                "D1 insert metadata did not include a subscription order row id".to_string(),
            )
        })
}

pub async fn find_subscription_order_by_trade_no(
    db: &D1Database,
    trade_no: &str,
) -> worker::Result<Option<SubscriptionOrderRow>> {
    let arg = D1Type::Text(trade_no);
    db.prepare(&format!(
        r#"
        SELECT {SUBSCRIPTION_ORDER_COLUMNS}
        FROM subscription_orders
        WHERE trade_no = ?1
        LIMIT 1
        "#
    ))
    .bind_refs(&[arg])?
    .first::<SubscriptionOrderRow>(None)
    .await
}

pub async fn mark_subscription_order_status_for_provider(
    db: &D1Database,
    trade_no: &str,
    expected_provider: &str,
    from_status: &str,
    to_status: &str,
    complete_time: i64,
    provider_payload: &str,
    actual_payment_method: &str,
) -> worker::Result<bool> {
    let args = [
        D1Type::Text(trade_no),
        D1Type::Text(expected_provider),
        D1Type::Text(from_status),
        D1Type::Text(to_status),
        D1Type::Integer(d1_i32(complete_time)),
        D1Type::Text(provider_payload),
        D1Type::Text(actual_payment_method),
    ];
    let result = db
        .prepare(
            r#"
            UPDATE subscription_orders
               SET status = ?4,
                   complete_time = ?5,
                   updated_at = ?5,
                   provider_payload = CASE WHEN ?6 <> '' THEN ?6 ELSE provider_payload END,
                   payment_method = CASE WHEN ?7 <> '' THEN ?7 ELSE payment_method END
             WHERE trade_no = ?1
               AND payment_provider = ?2
               AND status = ?3
            "#,
        )
        .bind_refs(&args)?
        .run()
        .await?;
    Ok(result.meta()?.and_then(|meta| meta.changes).unwrap_or(0) > 0)
}

pub async fn complete_subscription_order_batch(
    db: &D1Database,
    settlement: &SubscriptionOrderSettlementWrite<'_>,
) -> worker::Result<SubscriptionOrderSettlementBatchResult> {
    let sub = &settlement.subscription;
    let insert_sub_args = [
        D1Type::Integer(d1_i32(sub.user_id)),
        D1Type::Integer(d1_i32(sub.plan_id)),
        D1Type::Integer(d1_i32(sub.amount_total)),
        D1Type::Integer(d1_i32(sub.amount_used)),
        D1Type::Integer(d1_i32(sub.start_time)),
        D1Type::Integer(d1_i32(sub.end_time)),
        D1Type::Text(sub.status),
        D1Type::Text(sub.source),
        D1Type::Integer(d1_i32(sub.last_reset_time)),
        D1Type::Integer(d1_i32(sub.next_reset_time)),
        D1Type::Text(sub.upgrade_group),
        D1Type::Text(sub.prev_user_group),
        D1Type::Integer(d1_i32(sub.created_at)),
        D1Type::Integer(d1_i32(sub.updated_at)),
        D1Type::Text(settlement.trade_no),
        D1Type::Text(settlement.expected_provider),
        D1Type::Text(settlement.from_status),
    ];
    let insert_sub_stmt = db
        .prepare(
            r#"
            INSERT INTO user_subscriptions (
              user_id, plan_id, amount_total, amount_used, start_time, end_time,
              status, source, last_reset_time, next_reset_time, upgrade_group,
              prev_user_group, created_at, updated_at
            )
            SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14
            WHERE EXISTS (
              SELECT 1 FROM subscription_orders
              WHERE trade_no = ?15 AND payment_provider = ?16 AND status = ?17
            )
            "#,
        )
        .bind_refs(&insert_sub_args)?;

    let group_args = [
        D1Type::Text(sub.upgrade_group),
        D1Type::Integer(d1_i32(sub.user_id)),
        D1Type::Text(settlement.trade_no),
        D1Type::Text(settlement.expected_provider),
        D1Type::Text(settlement.from_status),
    ];
    let group_stmt = db
        .prepare(
            r#"
            UPDATE users
               SET "group" = ?1
             WHERE id = ?2
               AND deleted_at IS NULL
               AND ?1 <> ''
               AND "group" <> ?1
               AND EXISTS (
                 SELECT 1 FROM subscription_orders
                 WHERE trade_no = ?3 AND payment_provider = ?4 AND status = ?5
               )
            "#,
        )
        .bind_refs(&group_args)?;

    let topup_args = [
        D1Type::Integer(d1_i32(sub.user_id)),
        D1Type::Real(settlement.money),
        D1Type::Text(settlement.trade_no),
        D1Type::Text(settlement.actual_payment_method),
        D1Type::Text(settlement.expected_provider),
        D1Type::Integer(d1_i32(settlement.create_time)),
        D1Type::Integer(d1_i32(settlement.complete_time)),
        D1Type::Text(settlement.from_status),
    ];
    let insert_topup_stmt = db
        .prepare(
            r#"
            INSERT OR IGNORE INTO topups (
              user_id, amount, money, trade_no, payment_method, payment_provider,
              status, create_time, complete_time, credited
            )
            SELECT ?1, 0, ?2, ?3, ?4, ?5, 1, ?6, ?7, 1
            WHERE EXISTS (
              SELECT 1 FROM subscription_orders
              WHERE trade_no = ?3 AND payment_provider = ?5 AND status = ?8
            )
            "#,
        )
        .bind_refs(&topup_args)?;
    let update_topup_stmt = db
        .prepare(
            r#"
            UPDATE topups
               SET amount = 0,
                   money = ?2,
                   payment_method = ?4,
                   payment_provider = ?5,
                   status = 1,
                   create_time = ?6,
                   complete_time = ?7,
                   credited = 1
             WHERE trade_no = ?3
               AND payment_provider = ?5
               AND EXISTS (
                 SELECT 1 FROM subscription_orders
                 WHERE trade_no = ?3 AND payment_provider = ?5 AND status = ?8
               )
            "#,
        )
        .bind_refs(&topup_args)?;

    let order_args = [
        D1Type::Text(settlement.trade_no),
        D1Type::Text(settlement.expected_provider),
        D1Type::Text(settlement.from_status),
        D1Type::Text(settlement.to_status),
        D1Type::Integer(d1_i32(settlement.complete_time)),
        D1Type::Text(settlement.provider_payload),
        D1Type::Text(settlement.actual_payment_method),
    ];
    let order_stmt = db
        .prepare(
            r#"
            UPDATE subscription_orders
               SET status = ?4,
                   complete_time = ?5,
                   updated_at = ?5,
                   provider_payload = ?6,
                   payment_method = CASE WHEN ?7 <> '' THEN ?7 ELSE payment_method END
             WHERE trade_no = ?1
               AND payment_provider = ?2
               AND status = ?3
            "#,
        )
        .bind_refs(&order_args)?;

    let results = db
        .batch(vec![
            insert_sub_stmt,
            group_stmt,
            insert_topup_stmt,
            update_topup_stmt,
            order_stmt,
        ])
        .await?;
    let result = SubscriptionOrderSettlementBatchResult {
        subscription_inserted: batch_changed(&results, 0)?,
        group_updated: batch_changed(&results, 1)?,
        topup_inserted: batch_changed(&results, 2)?,
        topup_updated: batch_changed(&results, 3)?,
        order_marked: batch_changed(&results, 4)?,
    };
    Ok(result)
}

// ---------------------------------------------------------------------------
// Admin redemption-code management (Go model.Redemption).
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, Serialize)]
pub struct RedemptionRow {
    pub id: i64,
    pub user_id: i64,
    pub key: String,
    pub status: i32,
    pub name: String,
    pub quota: i64,
    pub created_time: i64,
    pub redeemed_time: i64,
    pub expired_time: i64,
    pub used_user_id: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RedeemRedemptionResult {
    Credited { id: i64, quota: i64 },
    Invalid,
    Used,
    Expired,
}

#[derive(Debug)]
pub struct CreateRedemption<'a> {
    pub user_id: i64,
    pub key: &'a str,
    pub status: i32,
    pub name: &'a str,
    pub quota: i64,
    pub created_time: i64,
    pub expired_time: i64,
}

const REDEMPTION_STATUS_ENABLED: i32 = 1;
const REDEMPTION_STATUS_USED: i32 = 3;
const REDEMPTION_COLUMNS: &str = r#"
  id, user_id, "key", status, name, quota, created_time, redeemed_time,
  expired_time, used_user_id
"#;

pub async fn list_redemptions(
    db: &D1Database,
    page: u32,
    page_size: u32,
) -> worker::Result<(Vec<RedemptionRow>, i64)> {
    let limit = i64::from(page_size);
    let offset = i64::from(page.saturating_sub(1).saturating_mul(page_size));
    let args = [
        D1Type::Integer(d1_i32(limit)),
        D1Type::Integer(d1_i32(offset)),
    ];
    let rows = db
        .prepare(&format!(
            r#"
            SELECT {REDEMPTION_COLUMNS}
            FROM redemptions
            WHERE deleted_at IS NULL
            ORDER BY id DESC
            LIMIT ?1 OFFSET ?2
            "#
        ))
        .bind_refs(&args)?
        .all()
        .await?
        .results::<RedemptionRow>()?;
    let total = count_live_redemptions(db).await?;
    Ok((rows, total))
}

pub async fn search_redemptions(
    db: &D1Database,
    keyword: &str,
    page: u32,
    page_size: u32,
) -> worker::Result<(Vec<RedemptionRow>, i64)> {
    let trimmed = keyword.trim();
    let like = format!("{trimmed}%");
    let limit = i64::from(page_size);
    let offset = i64::from(page.saturating_sub(1).saturating_mul(page_size));
    if let Ok(id) = trimmed.parse::<i64>() {
        let args = [
            D1Type::Integer(d1_i32(id)),
            D1Type::Text(&like),
            D1Type::Integer(d1_i32(limit)),
            D1Type::Integer(d1_i32(offset)),
        ];
        let rows = db
            .prepare(&format!(
                r#"
                SELECT {REDEMPTION_COLUMNS}
                FROM redemptions
                WHERE deleted_at IS NULL AND (id = ?1 OR name LIKE ?2)
                ORDER BY id DESC
                LIMIT ?3 OFFSET ?4
                "#
            ))
            .bind_refs(&args)?
            .all()
            .await?
            .results::<RedemptionRow>()?;
        let total = count_search_redemptions_by_id_or_name(db, id, &like).await?;
        Ok((rows, total))
    } else {
        let args = [
            D1Type::Text(&like),
            D1Type::Integer(d1_i32(limit)),
            D1Type::Integer(d1_i32(offset)),
        ];
        let rows = db
            .prepare(&format!(
                r#"
                SELECT {REDEMPTION_COLUMNS}
                FROM redemptions
                WHERE deleted_at IS NULL AND name LIKE ?1
                ORDER BY id DESC
                LIMIT ?2 OFFSET ?3
                "#
            ))
            .bind_refs(&args)?
            .all()
            .await?
            .results::<RedemptionRow>()?;
        let total = count_search_redemptions_by_name(db, &like).await?;
        Ok((rows, total))
    }
}

pub async fn find_redemption_by_id(
    db: &D1Database,
    id: i64,
) -> worker::Result<Option<RedemptionRow>> {
    let arg = D1Type::Integer(d1_i32(id));
    db.prepare(&format!(
        r#"
        SELECT {REDEMPTION_COLUMNS}
        FROM redemptions
        WHERE id = ?1 AND deleted_at IS NULL
        LIMIT 1
        "#
    ))
    .bind_refs(&arg)?
    .first::<RedemptionRow>(None)
    .await
}

async fn find_redemption_by_key(
    db: &D1Database,
    key: &str,
) -> worker::Result<Option<RedemptionRow>> {
    let arg = D1Type::Text(key);
    db.prepare(&format!(
        r#"
        SELECT {REDEMPTION_COLUMNS}
        FROM redemptions
        WHERE "key" = ?1 AND deleted_at IS NULL
        LIMIT 1
        "#
    ))
    .bind_refs(&arg)?
    .first::<RedemptionRow>(None)
    .await
}

pub async fn insert_redemption(db: &D1Database, row: &CreateRedemption<'_>) -> worker::Result<()> {
    let args = [
        D1Type::Integer(d1_i32(row.user_id)),
        D1Type::Text(row.key),
        D1Type::Integer(row.status),
        D1Type::Text(row.name),
        D1Type::Integer(d1_i32(row.quota)),
        D1Type::Integer(d1_i32(row.created_time)),
        D1Type::Integer(d1_i32(row.expired_time)),
    ];
    db.prepare(
        r#"
        INSERT INTO redemptions
          (user_id, "key", status, name, quota, created_time, expired_time)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        "#,
    )
    .bind_refs(&args)?
    .run()
    .await?;
    Ok(())
}

pub async fn update_redemption_fields(
    db: &D1Database,
    id: i64,
    name: &str,
    quota: i64,
    expired_time: i64,
) -> worker::Result<bool> {
    let args = [
        D1Type::Text(name),
        D1Type::Integer(d1_i32(quota)),
        D1Type::Integer(d1_i32(expired_time)),
        D1Type::Integer(d1_i32(id)),
    ];
    let result = db
        .prepare(
            r#"
            UPDATE redemptions
               SET name = ?1, quota = ?2, expired_time = ?3
             WHERE id = ?4 AND deleted_at IS NULL
            "#,
        )
        .bind_refs(&args)?
        .run()
        .await?;
    let changes = result.meta()?.and_then(|meta| meta.changes).unwrap_or(0);
    Ok(changes > 0)
}

pub async fn update_redemption_status(
    db: &D1Database,
    id: i64,
    status: i32,
) -> worker::Result<bool> {
    let args = [D1Type::Integer(status), D1Type::Integer(d1_i32(id))];
    let result = db
        .prepare(
            r#"
            UPDATE redemptions
               SET status = ?1,
                   credited = CASE
                     WHEN status = 3 OR ?1 = 3 THEN 1
                     ELSE credited
                   END
             WHERE id = ?2 AND deleted_at IS NULL
            "#,
        )
        .bind_refs(&args)?
        .run()
        .await?;
    let changes = result.meta()?.and_then(|meta| meta.changes).unwrap_or(0);
    Ok(changes > 0)
}

pub async fn soft_delete_redemption(
    db: &D1Database,
    id: i64,
    deleted_at: i64,
) -> worker::Result<bool> {
    let args = [
        D1Type::Integer(d1_i32(deleted_at)),
        D1Type::Integer(d1_i32(id)),
    ];
    let result = db
        .prepare(
            r#"
            UPDATE redemptions
               SET deleted_at = ?1
             WHERE id = ?2 AND deleted_at IS NULL
            "#,
        )
        .bind_refs(&args)?
        .run()
        .await?;
    let changes = result.meta()?.and_then(|meta| meta.changes).unwrap_or(0);
    Ok(changes > 0)
}

pub async fn soft_delete_invalid_redemptions(db: &D1Database, now: i64) -> worker::Result<i64> {
    let args = [D1Type::Integer(d1_i32(now)), D1Type::Integer(d1_i32(now))];
    let result = db
        .prepare(
            r#"
            UPDATE redemptions
               SET deleted_at = ?1
             WHERE deleted_at IS NULL
               AND (
                 status IN (2, 3)
                 OR (status = 1 AND expired_time != 0 AND expired_time < ?2)
               )
            "#,
        )
        .bind_refs(&args)?
        .run()
        .await?;
    Ok(result.meta()?.and_then(|meta| meta.changes).unwrap_or(0) as i64)
}

/// Atomically redeem a public redemption code and credit the user's quota.
///
/// The `credited` column is a D1-only idempotency anchor. It avoids the
/// same-second replay problem that timestamp-only guards have: statement 2
/// credits only while `credited = 0`, and statement 3 flips the anchor in the
/// same D1 batch. A replay or concurrent request observes `credited = 1` and
/// no-ops.
pub async fn redeem_redemption_code(
    db: &D1Database,
    key: &str,
    user_id: i64,
    now: i64,
) -> worker::Result<RedeemRedemptionResult> {
    let trimmed = key.trim();
    let Some(row) = find_redemption_by_key(db, trimmed).await? else {
        return Ok(RedeemRedemptionResult::Invalid);
    };
    if row.status != REDEMPTION_STATUS_ENABLED {
        return Ok(RedeemRedemptionResult::Used);
    }
    if row.expired_time != 0 && row.expired_time < now {
        return Ok(RedeemRedemptionResult::Expired);
    }
    if row.quota <= 0 || row.quota > i64::from(i32::MAX) {
        return Ok(RedeemRedemptionResult::Invalid);
    }
    let quota = row.quota as i32;

    let redeem_args = [
        D1Type::Integer(REDEMPTION_STATUS_USED),
        D1Type::Integer(d1_i32(now)),
        D1Type::Integer(d1_i32(user_id)),
        D1Type::Integer(d1_i32(row.id)),
        D1Type::Integer(REDEMPTION_STATUS_ENABLED),
        D1Type::Integer(d1_i32(now)),
    ];
    let redeem_stmt = db
        .prepare(
            r#"
            UPDATE redemptions
               SET status = ?1,
                   redeemed_time = ?2,
                   used_user_id = ?3
             WHERE id = ?4
               AND status = ?5
               AND deleted_at IS NULL
               AND (expired_time = 0 OR expired_time >= ?6)
               AND credited = 0
            "#,
        )
        .bind_refs(&redeem_args)?;

    let credit_args = [
        D1Type::Integer(quota),
        D1Type::Integer(d1_i32(user_id)),
        D1Type::Integer(d1_i32(row.id)),
        D1Type::Integer(REDEMPTION_STATUS_USED),
    ];
    let credit_stmt = db
        .prepare(
            r#"
            UPDATE users
               SET quota = quota + ?1
             WHERE id = ?2
               AND EXISTS (
                 SELECT 1 FROM redemptions
                  WHERE id = ?3
                    AND status = ?4
                    AND used_user_id = ?2
                    AND credited = 0
                    AND deleted_at IS NULL
               )
            "#,
        )
        .bind_refs(&credit_args)?;

    let mark_args = [
        D1Type::Integer(d1_i32(row.id)),
        D1Type::Integer(REDEMPTION_STATUS_USED),
        D1Type::Integer(d1_i32(user_id)),
    ];
    let mark_stmt = db
        .prepare(
            r#"
            UPDATE redemptions
               SET credited = 1
             WHERE id = ?1
               AND status = ?2
               AND used_user_id = ?3
               AND credited = 0
               AND deleted_at IS NULL
            "#,
        )
        .bind_refs(&mark_args)?;

    let results = db.batch(vec![redeem_stmt, credit_stmt, mark_stmt]).await?;
    let redeemed = batch_changed(&results, 0)?;
    let credited = batch_changed(&results, 1)?;
    let marked = batch_changed(&results, 2)?;
    if redeemed && credited && marked {
        return Ok(RedeemRedemptionResult::Credited {
            id: row.id,
            quota: row.quota,
        });
    }

    let Some(current) = find_redemption_by_key(db, trimmed).await? else {
        return Ok(RedeemRedemptionResult::Invalid);
    };
    if current.status != REDEMPTION_STATUS_ENABLED {
        Ok(RedeemRedemptionResult::Used)
    } else if current.expired_time != 0 && current.expired_time < now {
        Ok(RedeemRedemptionResult::Expired)
    } else {
        Ok(RedeemRedemptionResult::Invalid)
    }
}

/// Log type constant for top-up events. Mirrors Go `LogTypeTopup`.
pub const LOG_TYPE_TOPUP: i32 = 1;

pub async fn insert_topup_log(
    db: &D1Database,
    user_id: i64,
    username: &str,
    content: &str,
    ip: &str,
    other: &serde_json::Value,
    now: i64,
) -> worker::Result<()> {
    let other = serde_json::to_string(other).unwrap_or_else(|_| "{}".to_string());
    let args = [
        D1Type::Integer(d1_i32(user_id)),
        D1Type::Integer(d1_i32(now)),
        D1Type::Integer(LOG_TYPE_TOPUP),
        D1Type::Text(content),
        D1Type::Text(username),
        D1Type::Text(ip),
        D1Type::Text(&other),
    ];
    db.prepare(
        r#"
        INSERT INTO logs (user_id, created_at, type, content, username, ip, other)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        "#,
    )
    .bind_refs(&args)?
    .run()
    .await?;
    Ok(())
}

async fn count_live_redemptions(db: &D1Database) -> worker::Result<i64> {
    let row = db
        .prepare("SELECT COUNT(*) AS count FROM redemptions WHERE deleted_at IS NULL")
        .first::<CountRow>(None)
        .await?;
    Ok(row.map(|row| row.count).unwrap_or(0))
}

async fn count_search_redemptions_by_id_or_name(
    db: &D1Database,
    id: i64,
    like: &str,
) -> worker::Result<i64> {
    let args = [D1Type::Integer(d1_i32(id)), D1Type::Text(like)];
    let row = db
        .prepare(
            r#"
            SELECT COUNT(*) AS count
            FROM redemptions
            WHERE deleted_at IS NULL AND (id = ?1 OR name LIKE ?2)
            "#,
        )
        .bind_refs(&args)?
        .first::<CountRow>(None)
        .await?;
    Ok(row.map(|row| row.count).unwrap_or(0))
}

async fn count_search_redemptions_by_name(db: &D1Database, like: &str) -> worker::Result<i64> {
    let arg = D1Type::Text(like);
    let row = db
        .prepare(
            r#"
            SELECT COUNT(*) AS count
            FROM redemptions
            WHERE deleted_at IS NULL AND name LIKE ?1
            "#,
        )
        .bind_refs(&arg)?
        .first::<CountRow>(None)
        .await?;
    Ok(row.map(|row| row.count).unwrap_or(0))
}

/// Atomically subtract from a user's quota: `UPDATE users SET quota = quota - ?`.
pub async fn decrease_user_quota(db: &D1Database, id: i64, delta: i64) -> worker::Result<bool> {
    let args = [D1Type::Integer(d1_i32(delta)), D1Type::Integer(d1_i32(id))];
    let result = db
        .prepare("UPDATE users SET quota = quota - ?1 WHERE id = ?2")
        .bind_refs(&args)?
        .run()
        .await?;
    let changes = result.meta()?.and_then(|m| m.changes).unwrap_or(0);
    Ok(changes > 0)
}

/// Override a user's quota to an absolute value.
pub async fn override_user_quota(db: &D1Database, id: i64, value: i64) -> worker::Result<bool> {
    let args = [D1Type::Integer(d1_i32(value)), D1Type::Integer(d1_i32(id))];
    let result = db
        .prepare("UPDATE users SET quota = ?1 WHERE id = ?2")
        .bind_refs(&args)?
        .run()
        .await?;
    let changes = result.meta()?.and_then(|m| m.changes).unwrap_or(0);
    Ok(changes > 0)
}

// ---------------------------------------------------------------------------
// Topup / payment queries (Scenario C): Stripe checkout + webhook + credit.
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, PartialEq, serde::Serialize)]
pub struct TopupRow {
    pub id: i64,
    pub user_id: i64,
    pub amount: i64,
    pub money: f64,
    pub trade_no: String,
    pub payment_method: String,
    pub payment_provider: String,
    pub status: i32,
    pub create_time: i64,
    pub complete_time: i64,
    pub credited: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TopupCreditBatchResult {
    pub completed: bool,
    pub credited: bool,
    pub marked: bool,
}

impl TopupCreditBatchResult {
    pub fn credited_now(self) -> bool {
        self.completed && self.credited && self.marked
    }

    pub fn partial_completion(self) -> bool {
        self.completed && !self.credited_now()
    }
}

const TOPUP_QUERY_WINDOW_SECONDS: i64 = 30 * 24 * 60 * 60;
const TOPUP_SEARCH_COUNT_HARD_LIMIT: i32 = 10_000;

pub async fn create_topup(
    db: &D1Database,
    user_id: i64,
    amount: i64,
    money: f64,
    trade_no: &str,
    payment_method: &str,
    payment_provider: &str,
    create_time: i64,
) -> worker::Result<i64> {
    let args = [
        D1Type::Integer(d1_i32(user_id)),
        D1Type::Integer(d1_i32(amount)),
        D1Type::Real(money),
        D1Type::Text(trade_no),
        D1Type::Text(payment_method),
        D1Type::Text(payment_provider),
        D1Type::Integer(d1_i32(create_time)),
    ];
    db.prepare(
        r#"
        INSERT INTO topups (
            user_id, amount, money, trade_no, payment_method, payment_provider,
            status, create_time, complete_time
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, 0)
        "#,
    )
    .bind_refs(&args)?
    .run()
    .await?;
    let trade_arg = D1Type::Text(trade_no);
    #[derive(Deserialize)]
    struct Id {
        id: i64,
    }
    let row = db
        .prepare("SELECT id FROM topups WHERE trade_no = ?1 LIMIT 1")
        .bind_refs(&[trade_arg])?
        .first::<Id>(None)
        .await?;
    Ok(row
        .map(|r| r.id)
        .ok_or_else(|| worker::Error::RustError("topup insert not found after create".into()))?)
}

pub async fn find_topup_by_trade_no(
    db: &D1Database,
    trade_no: &str,
) -> worker::Result<Option<TopupRow>> {
    let arg = D1Type::Text(trade_no);
    db.prepare(
        r#"
        SELECT id, user_id, amount, money, trade_no, payment_method, payment_provider,
               status, create_time, complete_time, credited
        FROM topups WHERE trade_no = ?1 LIMIT 1
        "#,
    )
    .bind_refs(&[arg])?
    .first::<TopupRow>(None)
    .await
}

/// Atomically complete a topup: sets status from pending (0) to success (1)
/// only if currently pending. Returns `true` when the row was updated (i.e.
/// this is the first completion — the caller should credit quota). Returns
/// `false` when already completed (idempotent skip).
pub async fn update_pending_topup_status_for_provider(
    db: &D1Database,
    trade_no: &str,
    expected_provider: &str,
    target_status: i32,
) -> worker::Result<bool> {
    let args = [
        D1Type::Integer(target_status),
        D1Type::Text(trade_no),
        D1Type::Text(expected_provider),
    ];
    let result = db
        .prepare(
            r#"
            UPDATE topups
            SET status = ?1
            WHERE trade_no = ?2
              AND payment_provider = ?3
              AND status = 0
            "#,
        )
        .bind_refs(&args)?
        .run()
        .await?;
    let changes = result.meta()?.and_then(|m| m.changes).unwrap_or(0);
    Ok(changes > 0)
}

pub async fn update_user_email_if_empty(
    db: &D1Database,
    user_id: i64,
    email: &str,
) -> worker::Result<bool> {
    let email = email.trim();
    if email.is_empty() {
        return Ok(false);
    }
    let args = [D1Type::Text(email), D1Type::Integer(d1_i32(user_id))];
    let result = db
        .prepare(
            r#"
            UPDATE users
            SET email = ?1
            WHERE id = ?2
              AND email = ''
            "#,
        )
        .bind_refs(&args)?
        .run()
        .await?;
    let changes = result.meta()?.and_then(|m| m.changes).unwrap_or(0);
    Ok(changes > 0)
}

pub async fn complete_topup(db: &D1Database, trade_no: &str, now: i64) -> worker::Result<bool> {
    let args = [D1Type::Integer(d1_i32(now)), D1Type::Text(trade_no)];
    let result = db
        .prepare(
            "UPDATE topups SET status = 1, complete_time = ?1 WHERE trade_no = ?2 AND status = 0",
        )
        .bind_refs(&args)?
        .run()
        .await?;
    let changes = result.meta()?.and_then(|m| m.changes).unwrap_or(0);
    Ok(changes > 0)
}

/// Atomically complete a pending top-up (status 0 -> 1) and credit the user's
/// quota in a single D1 batch, so a crash can never leave a top-up "completed"
/// but uncredited (the failure mode of doing the two writes separately).
///
/// Idempotency: the `WHERE status = 0` clause on the topup is the credit-once
/// gate; the user-quota credit is additionally guarded by `complete_time = ?1`
/// so a replay (status already 1, carrying its original complete_time) matches
/// neither statement and never double-credits. Returns `true` iff THIS call
/// transitioned the top-up (and therefore credited the quota).
pub async fn complete_topup_and_credit(
    db: &D1Database,
    trade_no: &str,
    now: i64,
) -> worker::Result<bool> {
    let args = [D1Type::Integer(d1_i32(now)), D1Type::Text(trade_no)];
    // s1: compare-and-swap the order pending(0) -> success(1). The `status = 0`
    // guard makes this an atomic CAS — only the first delivery flips it.
    let complete_stmt = db
        .prepare(
            "UPDATE topups SET status = 1, complete_time = ?1 WHERE trade_no = ?2 AND status = 0",
        )
        .bind_refs(&args)?;
    // s2: credit the quota, gated on `credited = 0` (NOT a timestamp). Two
    // webhook deliveries in the same unix second both satisfy a
    // `complete_time = ?now` guard and would double-credit; the `credited` flag
    // is the durable idempotency anchor that a same-second replay cannot beat.
    let credit_stmt = db
        .prepare(
            r#"
            UPDATE users
            SET quota = quota + COALESCE(
                (SELECT amount FROM topups WHERE trade_no = ?2 AND status = 1 AND credited = 0), 0)
            WHERE id = (SELECT user_id FROM topups WHERE trade_no = ?2 AND status = 1 AND credited = 0)
            "#,
        )
        .bind_refs(&args)?;
    // s3: set the `credited` anchor AFTER the credit, in the same atomic D1
    // batch, so the credit is applied exactly once. A replay finds credited = 1
    // and every statement no-ops. Relies only on intra-transaction visibility
    // (s2 sees s1's flip; s3 sees credit done) — not on `changes()` semantics.
    let mark_stmt = db
        .prepare(
            "UPDATE topups SET credited = 1 WHERE trade_no = ?2 AND status = 1 AND credited = 0",
        )
        .bind_refs(&args)?;
    let results = db
        .batch(vec![complete_stmt, credit_stmt, mark_stmt])
        .await?;
    let result = TopupCreditBatchResult {
        completed: batch_changed(&results, 0)?,
        credited: batch_changed(&results, 1)?,
        marked: batch_changed(&results, 2)?,
    };
    if result.partial_completion() {
        return Err(worker::Error::RustError(format!(
            "topup {trade_no} completed without matching credit/mark changes"
        )));
    }
    Ok(result.credited_now())
}

/// Provider-aware top-up completion used by form/webhook gateways such as Epay.
///
/// The compare-and-swap statement checks the provider family and the expected
/// order amount before flipping `status = 0 -> 1`; the following credit and
/// mark statements are gated on the same `credited = 0` anchor as
/// [`complete_topup_and_credit`]. `topups.amount` is already the final quota to
/// credit in the Rust schema, so provider-specific quota formulas must run at
/// order creation before calling [`create_topup`].
pub async fn complete_topup_and_credit_for_provider(
    db: &D1Database,
    trade_no: &str,
    expected_provider: &str,
    actual_payment_method: &str,
    expected_money: f64,
    now: i64,
) -> worker::Result<TopupCreditBatchResult> {
    let args = [
        D1Type::Integer(d1_i32(now)),
        D1Type::Text(trade_no),
        D1Type::Text(expected_provider),
        D1Type::Text(actual_payment_method),
        D1Type::Real(expected_money),
    ];
    let complete_stmt = db
        .prepare(
            r#"
            UPDATE topups
            SET status = 1, complete_time = ?1, payment_method = ?4
            WHERE trade_no = ?2
              AND status = 0
              AND payment_provider = ?3
              AND ABS(money - ?5) < 0.000001
            "#,
        )
        .bind_refs(&args)?;
    let credit_stmt = db
        .prepare(
            r#"
            UPDATE users
            SET quota = quota + COALESCE(
                (SELECT amount FROM topups
                 WHERE trade_no = ?2
                   AND status = 1
                   AND payment_provider = ?3
                   AND credited = 0), 0)
            WHERE id = (
                SELECT user_id FROM topups
                WHERE trade_no = ?2
                  AND status = 1
                  AND payment_provider = ?3
                  AND credited = 0
            )
            "#,
        )
        .bind_refs(&args)?;
    let mark_stmt = db
        .prepare(
            r#"
            UPDATE topups
            SET credited = 1
            WHERE trade_no = ?2
              AND status = 1
              AND payment_provider = ?3
              AND credited = 0
            "#,
        )
        .bind_refs(&args)?;
    let results = db
        .batch(vec![complete_stmt, credit_stmt, mark_stmt])
        .await?;
    let result = TopupCreditBatchResult {
        completed: batch_changed(&results, 0)?,
        credited: batch_changed(&results, 1)?,
        marked: batch_changed(&results, 2)?,
    };
    if result.partial_completion() {
        return Err(worker::Error::RustError(format!(
            "provider topup {trade_no} completed without matching credit/mark changes"
        )));
    }
    Ok(result)
}

/// Insert a payment_event row for webhook idempotency. The UNIQUE
/// (provider, event_id) constraint prevents duplicates.
pub async fn insert_payment_event(
    db: &D1Database,
    provider: &str,
    event_id: &str,
    order_id: &str,
    status: &str,
    raw_payload: &str,
    created_at: i64,
) -> worker::Result<bool> {
    let args = [
        D1Type::Text(provider),
        D1Type::Text(event_id),
        D1Type::Text(order_id),
        D1Type::Text(status),
        D1Type::Text(raw_payload),
        D1Type::Integer(d1_i32(created_at)),
    ];
    let result = db
        .prepare(
            r#"
            INSERT OR IGNORE INTO payment_events (provider, event_id, order_id, status, raw_payload, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            "#,
        )
        .bind_refs(&args)?
        .run()
        .await?;
    let changes = result.meta()?.and_then(|m| m.changes).unwrap_or(0);
    Ok(changes > 0)
}

/// Load Stripe payment config from D1 options. Returns defaults when keys
/// are absent.
pub async fn load_stripe_config(
    db: &D1Database,
) -> worker::Result<cinatoken_payments::StripeConfig> {
    let keys = [
        "StripeApiSecret",
        "StripeWebhookSecret",
        "StripeUnitPrice",
        "StripeMinTopUp",
    ];
    let values = option_values(db, &keys).await?;
    let mut config = cinatoken_payments::StripeConfig::default();
    if let Some(ref v) = values[0] {
        config.api_secret = v.clone();
    }
    if let Some(ref v) = values[1] {
        config.webhook_secret = v.clone();
    }
    if let Some(ref v) = values[2] {
        if let Ok(price) = v.trim().parse::<f64>() {
            if price > 0.0 {
                config.unit_price = price;
            }
        }
    }
    if let Some(ref v) = values[3] {
        if let Ok(min) = v.trim().parse::<f64>() {
            if min > 0.0 {
                config.min_topup = min;
            }
        }
    }
    Ok(config)
}

/// List a user's recent topups, newest first.
pub async fn list_user_topups(
    db: &D1Database,
    user_id: i64,
    limit: u32,
) -> worker::Result<Vec<TopupRow>> {
    let limit = limit.clamp(1, 100);
    let args = [
        D1Type::Integer(d1_i32(user_id)),
        D1Type::Integer(limit as i32),
    ];
    Ok(db
        .prepare(
            r#"
            SELECT id, user_id, amount, money, trade_no, payment_method, payment_provider,
                   status, create_time, complete_time, credited
            FROM topups WHERE user_id = ?1 ORDER BY id DESC LIMIT ?2
            "#,
        )
        .bind_refs(&args)?
        .all()
        .await?
        .results::<TopupRow>()?)
}

/// List a user's topups with Go-compatible paging.
///
/// Self-service history is limited to the most recent 30 days, mirroring
/// Go `model.GetUserTopUps` / `SearchUserTopUps`.
pub async fn list_user_topups_page(
    db: &D1Database,
    user_id: i64,
    page: u32,
    page_size: u32,
    keyword_pattern: Option<&str>,
    now: i64,
) -> worker::Result<(Vec<TopupRow>, i64)> {
    let cutoff = now.saturating_sub(TOPUP_QUERY_WINDOW_SECONDS);
    let args = vec![
        D1Type::Integer(d1_i32(user_id)),
        D1Type::Integer(d1_i32(cutoff)),
    ];
    let where_sql = "user_id = ?1 AND create_time >= ?2".to_string();
    list_topups_page(db, where_sql, args, page, page_size, keyword_pattern).await
}

/// List all topups for admin billing history. Unlike self-service history,
/// this intentionally has no 30-day cutoff.
pub async fn list_all_topups_page(
    db: &D1Database,
    page: u32,
    page_size: u32,
    keyword_pattern: Option<&str>,
) -> worker::Result<(Vec<TopupRow>, i64)> {
    list_topups_page(
        db,
        "1 = 1".to_string(),
        Vec::new(),
        page,
        page_size,
        keyword_pattern,
    )
    .await
}

async fn list_topups_page(
    db: &D1Database,
    mut where_sql: String,
    mut args: Vec<D1Type<'_>>,
    page: u32,
    page_size: u32,
    keyword_pattern: Option<&str>,
) -> worker::Result<(Vec<TopupRow>, i64)> {
    let has_keyword = keyword_pattern.is_some();
    if let Some(pattern) = keyword_pattern {
        let next = args.len() + 1;
        where_sql.push_str(&format!(" AND trade_no LIKE ?{next} ESCAPE '!'"));
        args.push(D1Type::Text(pattern));
    }

    #[derive(Deserialize)]
    struct Count {
        count: i64,
    }

    let count_sql = if has_keyword {
        format!(
            "SELECT COUNT(*) AS count FROM (SELECT 1 FROM topups WHERE {where_sql} LIMIT {TOPUP_SEARCH_COUNT_HARD_LIMIT})"
        )
    } else {
        format!("SELECT COUNT(*) AS count FROM topups WHERE {where_sql}")
    };
    let total = db
        .prepare(&count_sql)
        .bind_refs(&args)?
        .first::<Count>(None)
        .await?
        .map(|row| row.count)
        .unwrap_or(0);

    let page = page.max(1);
    let page_size = page_size.clamp(1, 100);
    let offset = page.saturating_sub(1).saturating_mul(page_size);
    let limit_index = args.len() + 1;
    let offset_index = args.len() + 2;
    let mut list_args = args;
    list_args.push(D1Type::Integer(d1_i32(i64::from(page_size))));
    list_args.push(D1Type::Integer(d1_i32(i64::from(offset))));

    let rows = db
        .prepare(&format!(
            r#"
            SELECT id, user_id, amount, money, trade_no, payment_method, payment_provider,
                   status, create_time, complete_time, credited
            FROM topups
            WHERE {where_sql}
            ORDER BY id DESC
            LIMIT ?{limit_index} OFFSET ?{offset_index}
            "#
        ))
        .bind_refs(&list_args)?
        .all()
        .await?
        .results::<TopupRow>()?;

    Ok((rows, total))
}

//
// These power the React dashboard's charts. Unlike Go (which uses a
// pre-aggregated `quota_data` table fed by a background flush job), the
// Rust port computes trends live from the `logs` table. D1's
// `(created_at, type)` composite index makes the time-window scan efficient.
// A future Cron Trigger + `quota_data` table can replace this for very
// high-traffic deployments.
//
// All queries filter `type=2` (consume) and floor `created_at` to the hour
// via `(created_at / 3600) * 3600` so the frontend receives ready-to-chart
// hourly buckets.
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, PartialEq, serde::Serialize)]
pub struct QuotaTrendRow {
    /// Model name (for by-model queries) or username (for by-user queries).
    pub key: String,
    /// Hour-floored Unix timestamp.
    pub created_at: i64,
    pub quota: i64,
    pub token_used: i64,
    pub count: i64,
}

const LOG_TYPE_CONSUME_VALUE: i32 = 2;
const SECONDS_PER_HOUR: i64 = 3600;

/// Ranking totals grouped by model over one time window.
#[derive(Debug, Clone, Deserialize, PartialEq, serde::Serialize)]
pub struct RankingQuotaTotal {
    pub model_name: String,
    pub total_tokens: i64,
}

/// Ranking token totals grouped by model and bucket.
#[derive(Debug, Clone, Deserialize, PartialEq, serde::Serialize)]
pub struct RankingQuotaBucket {
    pub model_name: String,
    pub bucket: i64,
    pub tokens: i64,
}

/// Quota trend grouped by model_name, hour-floored. Optional `username`
/// filter narrows to a single user's usage.
pub async fn quota_trend_by_model(
    db: &D1Database,
    start: i64,
    end: i64,
    username_filter: Option<&str>,
) -> worker::Result<Vec<QuotaTrendRow>> {
    let base_where = "type = ?1 AND created_at >= ?2 AND created_at <= ?3";
    let (where_sql, args) = if let Some(username) = username_filter {
        (
            format!("{base_where} AND username = ?4 GROUP BY model_name, hour"),
            vec![
                D1Type::Integer(LOG_TYPE_CONSUME_VALUE),
                D1Type::Integer(d1_i32(start)),
                D1Type::Integer(d1_i32(end)),
                D1Type::Text(username),
            ],
        )
    } else {
        (
            format!("{base_where} GROUP BY model_name, hour"),
            vec![
                D1Type::Integer(LOG_TYPE_CONSUME_VALUE),
                D1Type::Integer(d1_i32(start)),
                D1Type::Integer(d1_i32(end)),
            ],
        )
    };
    let sql = format!(
        r#"
        SELECT model_name AS key,
               (created_at / {SECONDS_PER_HOUR}) * {SECONDS_PER_HOUR} AS created_at,
               SUM(quota) AS quota,
               SUM(prompt_tokens + completion_tokens) AS token_used,
               COUNT(*) AS count
        FROM logs
        WHERE {where_sql}
        ORDER BY created_at ASC
        "#,
    );
    Ok(db
        .prepare(&sql)
        .bind_refs(&args)?
        .all()
        .await?
        .results::<QuotaTrendRow>()?)
}

/// Quota trend grouped by username, hour-floored. Admin view.
pub async fn quota_trend_by_user(
    db: &D1Database,
    start: i64,
    end: i64,
) -> worker::Result<Vec<QuotaTrendRow>> {
    let args = [
        D1Type::Integer(LOG_TYPE_CONSUME_VALUE),
        D1Type::Integer(d1_i32(start)),
        D1Type::Integer(d1_i32(end)),
    ];
    let sql = format!(
        r#"
        SELECT username AS key,
               (created_at / {SECONDS_PER_HOUR}) * {SECONDS_PER_HOUR} AS created_at,
               SUM(quota) AS quota,
               SUM(prompt_tokens + completion_tokens) AS token_used,
               COUNT(*) AS count
        FROM logs
        WHERE type = ?1 AND created_at >= ?2 AND created_at <= ?3
        GROUP BY username, hour
        ORDER BY created_at ASC
        "#,
    );
    Ok(db
        .prepare(&sql)
        .bind_refs(&args)?
        .all()
        .await?
        .results::<QuotaTrendRow>()?)
}

/// Quota trend for a single user (self view). Returns raw per-(model, hour)
/// rows without further grouping, mirroring Go `GetQuotaDataByUserId`.
pub async fn quota_trend_by_user_id(
    db: &D1Database,
    user_id: i64,
    start: i64,
    end: i64,
) -> worker::Result<Vec<QuotaTrendRow>> {
    let args = [
        D1Type::Integer(LOG_TYPE_CONSUME_VALUE),
        D1Type::Integer(d1_i32(user_id)),
        D1Type::Integer(d1_i32(start)),
        D1Type::Integer(d1_i32(end)),
    ];
    let sql = format!(
        r#"
        SELECT model_name AS key,
               (created_at / {SECONDS_PER_HOUR}) * {SECONDS_PER_HOUR} AS created_at,
               SUM(quota) AS quota,
               SUM(prompt_tokens + completion_tokens) AS token_used,
               COUNT(*) AS count
        FROM logs
        WHERE type = ?1 AND user_id = ?2 AND created_at >= ?3 AND created_at <= ?4
        GROUP BY model_name, hour
        ORDER BY created_at ASC
        "#,
    );
    Ok(db
        .prepare(&sql)
        .bind_refs(&args)?
        .all()
        .await?
        .results::<QuotaTrendRow>()?)
}

/// Ranking totals over a period. This mirrors Go's `quota_data` aggregation,
/// but uses the Worker-native live `logs` source just like the dashboard
/// quota charts.
pub async fn ranking_quota_totals(
    db: &D1Database,
    start: i64,
    end: i64,
) -> worker::Result<Vec<RankingQuotaTotal>> {
    let args = [
        D1Type::Integer(LOG_TYPE_CONSUME_VALUE),
        D1Type::Integer(d1_i32(start)),
        D1Type::Integer(d1_i32(end)),
    ];
    db.prepare(
        r#"
        SELECT model_name AS model_name,
               COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS total_tokens
        FROM logs
        WHERE type = ?1
          AND created_at >= ?2
          AND created_at <= ?3
          AND TRIM(model_name) != ''
        GROUP BY model_name
        HAVING COALESCE(SUM(prompt_tokens + completion_tokens), 0) > 0
        ORDER BY total_tokens DESC, model_name ASC
        "#,
    )
    .bind_refs(&args)?
    .all()
    .await?
    .results::<RankingQuotaTotal>()
}

/// Ranking buckets over a period. `bucket_size` is supplied by the validated
/// period config; clamp defensively so the generated SQL never divides by zero.
pub async fn ranking_quota_buckets(
    db: &D1Database,
    start: i64,
    end: i64,
    bucket_size: i64,
) -> worker::Result<Vec<RankingQuotaBucket>> {
    let bucket_size = bucket_size.max(1);
    let args = [
        D1Type::Integer(LOG_TYPE_CONSUME_VALUE),
        D1Type::Integer(d1_i32(start)),
        D1Type::Integer(d1_i32(end)),
    ];
    let sql = format!(
        r#"
        SELECT model_name AS model_name,
               (created_at / {bucket_size}) * {bucket_size} AS bucket,
               COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens
        FROM logs
        WHERE type = ?1
          AND created_at >= ?2
          AND created_at <= ?3
          AND TRIM(model_name) != ''
        GROUP BY model_name, bucket
        HAVING COALESCE(SUM(prompt_tokens + completion_tokens), 0) > 0
        ORDER BY bucket ASC, tokens DESC, model_name ASC
        "#
    );
    db.prepare(&sql)
        .bind_refs(&args)?
        .all()
        .await?
        .results::<RankingQuotaBucket>()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passkey_migration_has_go_compatible_fields_and_uniqueness() {
        let migration = include_str!("../../../migrations/d1/0016_passkey_credentials.sql");
        for field in [
            "user_id",
            "credential_id",
            "public_key",
            "attestation_type",
            "aaguid",
            "sign_count",
            "clone_warning",
            "user_present",
            "user_verified",
            "backup_eligible",
            "backup_state",
            "transports",
            "attachment",
            "last_used_at",
            "created_at",
            "updated_at",
            "deleted_at",
        ] {
            assert!(migration.contains(field), "missing Passkey field {field}");
        }
        assert!(migration.contains("user_id INTEGER NOT NULL UNIQUE"));
        assert!(migration.contains("credential_id TEXT NOT NULL UNIQUE"));
    }

    #[test]
    fn passkey_queries_are_parameterized_and_ignore_soft_deleted_rows() {
        assert!(FIND_PASSKEY_BY_USER_SQL.contains("user_id = ?1"));
        assert!(FIND_PASSKEY_BY_CREDENTIAL_ID_SQL.contains("credential_id = ?1"));
        assert!(FIND_PASSKEY_BY_USER_SQL.contains("deleted_at IS NULL"));
        assert!(FIND_PASSKEY_BY_CREDENTIAL_ID_SQL.contains("deleted_at IS NULL"));
        assert!(INSERT_PASSKEY_CREDENTIAL_SQL.contains("?15, ?15, NULL"));
        assert!(!INSERT_PASSKEY_CREDENTIAL_SQL.contains("OR REPLACE"));
    }

    #[test]
    fn passkey_authentication_update_uses_sign_count_cas() {
        assert!(UPDATE_PASSKEY_AFTER_AUTHENTICATION_SQL.contains("user_id = ?8"));
        assert!(UPDATE_PASSKEY_AFTER_AUTHENTICATION_SQL.contains("credential_id = ?9"));
        assert!(UPDATE_PASSKEY_AFTER_AUTHENTICATION_SQL.contains("sign_count = ?10"));
        assert!(UPDATE_PASSKEY_AFTER_AUTHENTICATION_SQL.contains("deleted_at IS NULL"));
        assert!(UPDATE_PASSKEY_AFTER_AUTHENTICATION_SQL.contains("last_used_at = ?7"));
        assert!(UPDATE_PASSKEY_AFTER_AUTHENTICATION_SQL.contains("updated_at = ?7"));
    }

    #[test]
    fn passkey_sign_count_preserves_full_u32_range() {
        assert!(matches!(
            d1_passkey_sign_count(i32::MAX as u32),
            D1Type::Integer(i32::MAX)
        ));
        assert!(matches!(
            d1_passkey_sign_count(u32::MAX),
            D1Type::Real(value) if value == u32::MAX as f64
        ));
        assert!(matches!(
            d1_passkey_timestamp(i64::from(i32::MAX) + 1),
            D1Type::Real(value) if value == (i64::from(i32::MAX) + 1) as f64
        ));
    }

    #[test]
    fn realtime_billing_reservation_migration_has_atomic_state_indexes() {
        let migration =
            include_str!("../../../migrations/d1/0019_realtime_billing_reservations.sql");
        let lease_migration =
            include_str!("../../../migrations/d1/0020_realtime_billing_reservation_leases.sql");
        let segment_migration =
            include_str!("../../../migrations/d1/0021_realtime_billing_bridge_segments.sql");
        let recovery_migration =
            include_str!("../../../migrations/d1/0022_realtime_billing_global_recovery.sql");
        assert!(migration.contains("CREATE TABLE IF NOT EXISTS realtime_billing_reservations"));
        assert!(migration.contains("CHECK (status IN ('reserved', 'settled', 'refunded'))"));
        assert!(migration.contains("reservation_sequence"));
        assert!(migration.contains("idx_realtime_billing_reservations_session_status"));
        assert!(migration.contains(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_realtime_billing_reservations_replay_key"
        ));
        assert!(migration.contains(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_realtime_billing_reservations_response"
        ));
        assert!(migration
            .contains("ON realtime_billing_reservations(session, upstream_response_id_hash)"));
        assert!(lease_migration.contains("CHECK (active_count = 0)"));
        assert!(lease_migration.contains("WHERE status = 'reserved'"));
        assert!(lease_migration.contains("DROP TABLE migration_0020_realtime_reservation_guard"));
        assert!(lease_migration.contains("ADD COLUMN lease_expires_at"));
        assert!(lease_migration.contains("idx_realtime_billing_reservations_lease"));
        assert!(lease_migration.contains("WHERE status = 'reserved' AND lease_expires_at > 0"));
        assert!(segment_migration.contains("CHECK (active_count = 0)"));
        assert!(segment_migration.contains("DROP TABLE migration_0021_realtime_segment_guard"));
        assert!(segment_migration.contains("ADD COLUMN bridge_segment"));
        assert!(segment_migration.contains("idx_realtime_billing_reservations_segment_status"));
        assert!(recovery_migration.contains("idx_realtime_billing_reservations_global_lease"));
        assert!(recovery_migration.contains("WHERE status = 'reserved' AND lease_expires_at > 0"));
        assert!(recovery_migration.contains("idx_realtime_billing_reservations_recent_outcome"));
        assert!(recovery_migration.contains("ADD COLUMN recovery_attempt_count"));
        assert!(recovery_migration.contains("ADD COLUMN recovery_next_attempt_at"));
        assert!(recovery_migration
            .contains("CREATE TABLE IF NOT EXISTS realtime_billing_recovery_state"));
    }

    fn relay_billing_test_reservation(status: &str) -> RelayBillingReservation {
        RelayBillingReservation {
            reservation_key: "relayreserve-test".to_string(),
            user_id: 1,
            token_id: 2,
            model_name: "gpt-test".to_string(),
            endpoint_path: "chat/completions".to_string(),
            request_id_hash: "sha256:test".to_string(),
            expr_hash: "expr".to_string(),
            candidate_group_count: 2,
            reservation_strategy: "max_candidate_group".to_string(),
            pre_consumed_quota: 100,
            status: status.to_string(),
            channel_id: 7,
            selected_group: "vip".to_string(),
            selected_at: 10,
            final_quota: 80,
            finalization_reason: "usage_settlement".to_string(),
            request_accounted: 1,
            lease_expires_at: 100,
            recovery_attempt_count: 0,
            created_at: 1,
            updated_at: 20,
        }
    }

    #[test]
    fn relay_billing_reservation_migration_has_recovery_and_selection_contract() {
        let migration = include_str!("../../../migrations/d1/0023_relay_billing_reservations.sql");
        for field in [
            "request_id_hash",
            "selected_at",
            "finalization_reason",
            "recovery_next_attempt_at",
        ] {
            assert!(
                migration.contains(field),
                "missing relay ledger field {field}"
            );
        }
        assert!(migration.contains("idx_relay_billing_reservations_global_lease"));
        assert!(migration.contains("idx_relay_billing_reservations_recent_outcome"));
        assert!(migration.contains(
            "CHECK (status IN ('reserved', 'settled', 'refunded', 'recovery_required'))"
        ));
        assert!(migration.contains("idx_relay_billing_reservations_recovery_required"));
    }

    #[test]
    fn relay_billing_finalization_classifies_matching_replay_and_race_winners() {
        let settled = relay_billing_test_reservation("settled");
        assert_eq!(
            classify_relay_settlement_outcome(&settled, 7, "vip", 80, "usage_settlement"),
            RelayBillingReservationFinalizationOutcome::MatchingSettled
        );
        assert_eq!(
            classify_relay_settlement_outcome(&settled, 8, "vip", 80, "usage_settlement"),
            RelayBillingReservationFinalizationOutcome::Conflict
        );
        assert_eq!(
            classify_relay_refund_outcome(
                &settled,
                "missing_usage",
                RelayBillingRequestAccounting::Account,
            ),
            RelayBillingReservationFinalizationOutcome::SettlementWon
        );

        let mut refunded = relay_billing_test_reservation("refunded");
        refunded.final_quota = 0;
        refunded.finalization_reason = "missing_usage".to_string();
        refunded.request_accounted = 1;
        assert_eq!(
            classify_relay_refund_outcome(
                &refunded,
                "missing_usage",
                RelayBillingRequestAccounting::Account,
            ),
            RelayBillingReservationFinalizationOutcome::MatchingRefund
        );
        assert_eq!(
            classify_relay_refund_outcome(
                &refunded,
                "missing_usage",
                RelayBillingRequestAccounting::Skip,
            ),
            RelayBillingReservationFinalizationOutcome::Conflict
        );
        assert_eq!(
            classify_relay_settlement_outcome(&refunded, 7, "vip", 80, "usage_settlement"),
            RelayBillingReservationFinalizationOutcome::RefundWon
        );

        let mut recovery_required = relay_billing_test_reservation("recovery_required");
        recovery_required.finalization_reason = "bound_usage_missing".to_string();
        recovery_required.request_accounted = 0;
        assert_eq!(
            classify_relay_settlement_outcome(&recovery_required, 7, "vip", 80, "usage_settlement",),
            RelayBillingReservationFinalizationOutcome::RecoveryRequired
        );
        assert_eq!(
            classify_relay_refund_outcome(
                &recovery_required,
                "missing_usage",
                RelayBillingRequestAccounting::Account,
            ),
            RelayBillingReservationFinalizationOutcome::RecoveryRequired
        );
    }

    #[test]
    fn relay_billing_settlement_and_recovery_have_a_deterministic_deadline() {
        assert!(relay_billing_settlement_deadline_allows(900, 1_200));
        assert!(!relay_billing_settlement_deadline_allows(900, 1_201));
        assert!(!relay_billing_settlement_deadline_allows(0, 1));
        assert_eq!(RELAY_BILLING_ORPHAN_RECOVERY_GRACE_SECONDS, 300);
    }

    #[test]
    fn realtime_settlement_and_global_recovery_have_a_deterministic_deadline() {
        assert!(realtime_billing_settlement_deadline_allows(900, 1_200));
        assert!(!realtime_billing_settlement_deadline_allows(900, 1_201));
        assert!(!realtime_billing_settlement_deadline_allows(0, 1));
        assert_eq!(REALTIME_BILLING_ORPHAN_RECOVERY_GRACE_SECONDS, 300);
        assert_eq!(realtime_billing_orphan_retry_delay_seconds(1), 60);
        assert_eq!(realtime_billing_orphan_retry_delay_seconds(2), 120);
        assert_eq!(realtime_billing_orphan_retry_delay_seconds(7), 3_600);
        assert_eq!(realtime_billing_orphan_retry_delay_seconds(100), 3_600);
    }

    #[test]
    fn token_keys_by_ids_query_is_user_scoped_and_parameterized() {
        let sql = token_keys_by_ids_query(3);
        assert!(sql.contains("user_id = ?1"));
        assert!(sql.contains("deleted_at IS NULL"));
        assert!(sql.contains("id IN (?2, ?3, ?4)"));
        assert!(!sql.contains("SELECT id, user_id"));
    }

    #[test]
    fn log_filter_clause_matches_log_schema_without_soft_delete() {
        let empty_filter = LogFilter::default();
        let (empty_sql, empty_args) = log_filter_clause(&empty_filter);
        assert_eq!(empty_sql, "");
        assert!(empty_args.is_empty());

        let filter = LogFilter {
            kind: Some(LOG_TYPE_CONSUME),
            start_timestamp: Some(100),
            end_timestamp: Some(200),
            ..LogFilter::default()
        };
        let (sql, args) = log_filter_clause(&filter);
        assert!(sql.contains("type = ?1"));
        assert!(sql.contains("created_at >= ?2"));
        assert!(sql.contains("created_at <= ?3"));
        assert!(!sql.contains("deleted_at"));
        assert_eq!(args.len(), 3);
    }

    #[test]
    fn parse_auto_groups_option_reads_json_array() {
        assert_eq!(
            parse_auto_groups_option(Some(r#"["default","vip"]"#)),
            vec!["default".to_string(), "vip".to_string()]
        );
        // Missing / blank / malformed -> empty (auto selection disabled).
        assert!(parse_auto_groups_option(None).is_empty());
        assert!(parse_auto_groups_option(Some("   ")).is_empty());
        assert!(parse_auto_groups_option(Some("not json")).is_empty());
    }

    #[test]
    fn resolve_user_auto_groups_intersects_usable_and_special() {
        let auto = Some(r#"["default","vip","svip"]"#);
        let usable = Some(r#"{"default":"默认分组","vip":"vip分组"}"#);
        // user group "u" gets svip added and vip removed via special overrides.
        let special = Some(r#"{"u":{"+:svip":"超级","-:vip":""}}"#);
        // default + svip are usable; vip removed; order follows the auto list.
        assert_eq!(
            resolve_user_auto_groups_from_options("u", auto, usable, special),
            vec!["default".to_string(), "svip".to_string()]
        );
        // A different user group has no specials: default + vip remain.
        assert_eq!(
            resolve_user_auto_groups_from_options("other", auto, usable, special),
            vec!["default".to_string(), "vip".to_string()]
        );
    }

    #[test]
    fn resolve_user_usable_groups_adds_own_group_and_specials() {
        let usable = Some(r#"{"default":"default group","vip":"vip group"}"#);
        let special = Some(r#"{"u":{"+:svip":"super vip","-:vip":""}}"#);
        let groups = resolve_user_usable_groups_from_options("u", usable, special);
        assert!(groups.contains_key("default"));
        assert!(groups.contains_key("svip"));
        assert!(groups.contains_key("u"));
        assert!(!groups.contains_key("vip"));

        let fallback = resolve_user_usable_groups_from_options("other", None, None);
        assert!(fallback.contains_key("default"));
        assert!(fallback.contains_key("vip"));
        assert!(fallback.contains_key("other"));
    }

    #[test]
    fn chat_model_discovery_query_is_joined_filtered_and_parameterized() {
        let sql = DISTINCT_CHAT_MODELS_SQL;
        assert!(sql.contains("INNER JOIN channels AS c ON c.id = a.channel_id"));
        assert!(sql.contains("json_each(?1)"));
        assert!(sql.contains("json_each(?2)"));
        assert!(sql.contains("a.enabled = 1"));
        assert!(sql.contains("c.status = 1"));
        assert!(sql.contains("rg.group_name = a.group_name"));
        assert!(sql.contains("rt.channel_type = c.type"));
        assert!(sql.contains("TRIM(a.model) != ''"));
    }

    #[test]
    fn resolve_user_auto_groups_empty_when_auto_not_configured() {
        let usable = Some(r#"{"default":"x"}"#);
        assert!(resolve_user_auto_groups_from_options("u", None, usable, None).is_empty());
        assert!(resolve_user_auto_groups_from_options("u", Some("[]"), usable, None).is_empty());
    }

    #[test]
    fn normalized_fallback_model_collapses_thinking_budget() {
        // A thinking-budget gemini request has no exact ability row; the
        // normalized wildcard is the retry target Go uses.
        assert_eq!(
            normalized_fallback_model("gemini-2.5-flash-thinking-8192").as_deref(),
            Some("gemini-2.5-flash-thinking-*")
        );
        assert_eq!(
            normalized_fallback_model("gemini-2.5-pro-thinking-32768").as_deref(),
            Some("gemini-2.5-pro-thinking-*")
        );
        assert_eq!(
            normalized_fallback_model("gemini-2.5-flash-lite-thinking-1").as_deref(),
            Some("gemini-2.5-flash-lite-thinking-*")
        );
    }

    #[test]
    fn normalized_fallback_model_collapses_gizmo() {
        assert_eq!(
            normalized_fallback_model("gpt-4-gizmo-g-abc").as_deref(),
            Some("gpt-4-gizmo-*")
        );
        assert_eq!(
            normalized_fallback_model("gpt-4o-gizmo-g-xyz").as_deref(),
            Some("gpt-4o-gizmo-*")
        );
    }

    #[test]
    fn normalized_fallback_model_is_none_when_unchanged() {
        // Plain / already-normal models have no retry target — the exact match
        // is the only query, so the common path stays one round-trip.
        assert_eq!(normalized_fallback_model("gpt-4o"), None);
        assert_eq!(normalized_fallback_model("claude-3-5-sonnet"), None);
        assert_eq!(normalized_fallback_model("gemini-2.5-flash"), None);
        // A name WITHOUT the thinking-budget marker is unchanged even though it
        // shares a prefix with a collapsible family.
        assert_eq!(normalized_fallback_model("gemini-2.5-flash-002"), None);
    }

    #[test]
    fn resolves_tiered_billing_expr_from_go_option_maps() {
        let expr = resolve_tiered_billing_expr_for_model(
            "gpt-test",
            Some(r#"{"gpt-test":"tiered_expr","other":"ratio"}"#),
            Some(r#"{"gpt-test":" tier(\"base\", p * 2 + c * 10) "}"#),
        )
        .unwrap();

        assert_eq!(expr.as_deref(), Some(r#"tier("base", p * 2 + c * 10)"#));
    }

    #[test]
    fn ignores_non_tiered_or_missing_billing_expr() {
        assert_eq!(
            resolve_tiered_billing_expr_for_model(
                "gpt-test",
                Some(r#"{"gpt-test":"ratio"}"#),
                Some(r#"{"gpt-test":"tier(\"base\", p)"}"#),
            )
            .unwrap(),
            None
        );
        assert_eq!(
            resolve_tiered_billing_expr_for_model(
                "gpt-test",
                Some(r#"{"gpt-test":"tiered_expr"}"#),
                Some(r#"{"gpt-test":"   "}"#),
            )
            .unwrap(),
            None
        );
    }

    #[test]
    fn resolves_group_ratio_from_numeric_or_string_values() {
        assert_eq!(
            resolve_group_ratio("vip", r#"{"default":1,"vip":1.5}"#).unwrap(),
            Some(1.5)
        );
        assert_eq!(
            resolve_group_ratio("vip", r#"{"vip":"2.25"}"#).unwrap(),
            Some(2.25)
        );
        assert_eq!(
            resolve_group_ratio("missing", r#"{"vip":2}"#).unwrap(),
            None
        );
    }

    #[test]
    fn resolves_effective_group_ratios_with_go_precedence() {
        let groups = vec![
            "default".to_string(),
            "vip".to_string(),
            "legacy".to_string(),
            "missing".to_string(),
        ];
        let ratios = resolve_effective_group_ratios_from_options(
            "member",
            &groups,
            Some(r#"{"member":{"vip":"0.75"}}"#),
            Some(r#"{"member":{"legacy":1.25,"vip":9}}"#),
            Some(r#"{"default":1.5,"vip":2,"legacy":3}"#),
            Some(r#"{"default":8,"legacy":4}"#),
        )
        .unwrap();

        assert_eq!(ratios["default"], 1.5);
        assert_eq!(ratios["vip"], 0.75);
        assert_eq!(ratios["legacy"], 1.25);
        assert_eq!(ratios["missing"], 1.0);
    }

    #[test]
    fn effective_group_ratio_rejects_invalid_special_override() {
        let err = resolve_effective_group_ratios_from_options(
            "member",
            &["vip".to_string()],
            Some(r#"{"member":{"vip":"not-a-number"}}"#),
            None,
            Some(r#"{"vip":2}"#),
            None,
        )
        .unwrap_err();

        assert!(err.to_string().contains("member/vip must be numeric"));
    }

    #[test]
    fn effective_group_ratio_stops_after_highest_priority_match() {
        let ratios = resolve_effective_group_ratios_from_options(
            "member",
            &["vip".to_string()],
            Some(r#"{"member":{"vip":0.8}}"#),
            Some("not-json"),
            Some("not-json"),
            Some("not-json"),
        )
        .unwrap();

        assert_eq!(ratios["vip"], 0.8);
    }

    #[test]
    fn channel_type_filter_sql_accepts_internal_type_lists_only() {
        assert_eq!(channel_type_filter_sql(&[1, 20, 53]).unwrap(), "1, 20, 53");
        assert!(channel_type_filter_sql(&[]).is_err());
    }

    #[test]
    fn channel_copy_sql_is_parameterized_and_preserves_go_reset_semantics() {
        for parameter in ["?1", "?2", "?3", "?4"] {
            assert!(COPY_CHANNEL_SQL.contains(parameter));
        }
        assert!(COPY_CHANNEL_SQL.contains("type, \"key\", openai_organization"));
        assert!(COPY_CHANNEL_SQL.contains("?3, 0, 0, base_url"));
        assert!(COPY_CHANNEL_SQL.contains("CASE WHEN ?4 = 1 THEN 0 ELSE balance END"));
        assert!(COPY_CHANNEL_SQL.contains("CASE WHEN ?4 = 1 THEN 0 ELSE used_quota END"));
        assert!(COPY_CHANNEL_SQL.contains("channel_info, settings"));
        assert!(COPY_CHANNEL_SQL.contains("WHERE id = ?1"));
    }

    #[test]
    fn longest_models_csv_counts_comma_separated_items() {
        assert_eq!(
            longest_models_csv(vec![
                String::new(),
                "gpt-4o".to_string(),
                "gpt-4o,claude-3-5-sonnet,gemini-2.5-pro".to_string(),
                "a,b".to_string(),
            ]),
            "gpt-4o,claude-3-5-sonnet,gemini-2.5-pro"
        );
    }

    #[test]
    fn longest_models_csv_keeps_first_value_on_ties() {
        assert_eq!(
            longest_models_csv(vec!["first,model".to_string(), "second,model".to_string()]),
            "first,model"
        );
        assert_eq!(longest_models_csv(Vec::<String>::new()), "");
    }

    #[test]
    fn quota_i32_accepts_non_negative_d1_range() {
        assert_eq!(quota_i32(0).unwrap(), 0);
        assert_eq!(quota_i32(i64::from(i32::MAX)).unwrap(), i32::MAX);
        assert!(quota_i32(-1).is_err());
        assert!(quota_i32(i64::from(i32::MAX) + 1).is_err());
    }

    #[test]
    fn prefill_group_list_sql_filters_live_rows_and_orders_like_go() {
        let all = list_prefill_groups_sql(false);
        assert!(all.contains("WHERE deleted_at IS NULL"));
        assert!(!all.contains("type = ?1"));
        assert!(all.ends_with("ORDER BY updated_time DESC"));

        let filtered = list_prefill_groups_sql(true);
        assert!(filtered.contains("AND type = ?1"));
        assert!(filtered.ends_with("ORDER BY updated_time DESC"));
    }

    #[test]
    fn prefill_group_items_restore_native_json_shape() {
        let array: PrefillGroup = serde_json::from_value(serde_json::json!({
            "id": 1,
            "name": "models",
            "type": "model",
            "items": "[\"gpt-4o\",\"o3\"]",
            "description": "",
            "created_time": 10,
            "updated_time": 20
        }))
        .unwrap();
        assert_eq!(array.items, serde_json::json!(["gpt-4o", "o3"]));

        let string: PrefillGroup = serde_json::from_value(serde_json::json!({
            "id": 2,
            "name": "endpoint",
            "type": "endpoint",
            "items": "\"{\\\"chat\\\":true}\"",
            "description": "endpoint defaults",
            "created_time": 10,
            "updated_time": 20
        }))
        .unwrap();
        assert_eq!(string.items, serde_json::json!("{\"chat\":true}"));
    }

    #[test]
    fn prefill_group_serialization_matches_frontend_fields() {
        let row = PrefillGroup {
            id: 7,
            name: "tags".to_string(),
            group_type: "tag".to_string(),
            items: serde_json::json!(["reasoning"]),
            description: String::new(),
            created_time: 10,
            updated_time: 20,
        };
        assert_eq!(
            serde_json::to_value(row).unwrap(),
            serde_json::json!({
                "id": 7,
                "name": "tags",
                "type": "tag",
                "items": ["reasoning"],
                "created_time": 10,
                "updated_time": 20
            })
        );
    }

    #[test]
    fn prefill_group_migration_enforces_unique_live_names() {
        let migration = include_str!("../../../migrations/d1/0009_prefill_groups.sql");
        assert!(migration.contains("CREATE UNIQUE INDEX IF NOT EXISTS uk_prefill_name"));
        assert!(migration.contains("WHERE deleted_at IS NULL"));
    }
}
