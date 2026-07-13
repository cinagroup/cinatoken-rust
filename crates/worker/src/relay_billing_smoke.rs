//! Default-off, admin-only staging proof for relay actual-serving-group billing.
//!
//! The smoke owns only fixed fixture rows and fixed option-map entries. It is
//! unavailable in production and must be run against an isolated staging D1.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use worker::{D1Database, D1Type, Env, Request, Response, Result as WorkerResult};

use crate::admin::{
    envelope_error_response, envelope_ok_response, read_json_body, require_admin_auth,
};
use crate::relay::{
    execute_actual_group_billing_smoke_plan, ActualGroupBillingSmokeAction,
    ActualGroupBillingSmokeEvidence,
};

pub const RELAY_ACTUAL_GROUP_BILLING_STAGING_SMOKE_ENABLED_ENV: &str =
    "RELAY_ACTUAL_GROUP_BILLING_STAGING_SMOKE_ENABLED";

const USER_ID: i64 = 930_201;
const TOKEN_ID: i64 = 940_201;
const CHANNEL_ID: i64 = 950_201;
const USERNAME: &str = "ct_actual_group_billing_smoke";
const TOKEN_KEY: &str = "ct-actual-group-billing-smoke-token";
const USER_GROUP: &str = "ct_smoke_member";
const PRIMARY_MODEL: &str = "ct-smoke-primary-model";
const FALLBACK_MODEL: &str = "ct-smoke-fallback-model";
const PRIMARY_LOW_GROUP: &str = "ct_smoke_primary_low";
const PRIMARY_HIGH_GROUP: &str = "ct_smoke_primary_high";
const FALLBACK_LOW_GROUP: &str = "ct_smoke_fallback_low";
const FALLBACK_HIGH_GROUP: &str = "ct_smoke_fallback_high";
const INITIAL_QUOTA: i64 = 1_000_000;
const SMOKE_OPTION_KEYS: &[&str] = &[
    crate::d1_repositories::BILLING_MODE_OPTION_KEY,
    crate::d1_repositories::BILLING_EXPR_OPTION_KEY,
    crate::d1_repositories::GROUP_RATIO_OPTION_KEY,
    crate::d1_repositories::GROUP_GROUP_RATIO_OPTION_KEY,
];

#[derive(Debug, Deserialize)]
struct ActualGroupBillingSmokeRequest {
    scenario: String,
    confirm_live: bool,
    cleanup: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum ActualGroupBillingSmokeScenario {
    ActualGroupRefund,
    FallbackPlanReplacement,
    RetryExhaustionRefund,
}

impl ActualGroupBillingSmokeScenario {
    fn name(self) -> &'static str {
        match self {
            Self::ActualGroupRefund => "actual-group-refund",
            Self::FallbackPlanReplacement => "fallback-plan-replacement",
            Self::RetryExhaustionRefund => "retry-exhaustion-refund",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActualGroupBillingSmokeSnapshot {
    user_quota: i64,
    user_used_quota: i64,
    user_request_count: i64,
    token_remain_quota: i64,
    token_used_quota: i64,
    token_accessed_time: i64,
    channel_used_quota: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActualGroupBillingPlanEvidence {
    candidate_group_count: usize,
    reservation_strategy: &'static str,
    reserved_quota: i64,
    selected_group: Option<String>,
    selected_group_ratio: Option<f64>,
    selected_group_estimated_quota: Option<i64>,
    final_quota: i64,
    refund_quota: i64,
    additional_quota: i64,
}

impl From<ActualGroupBillingSmokeEvidence> for ActualGroupBillingPlanEvidence {
    fn from(value: ActualGroupBillingSmokeEvidence) -> Self {
        Self {
            candidate_group_count: value.candidate_group_count,
            reservation_strategy: value.reservation_strategy,
            reserved_quota: value.reserved_quota,
            selected_group: value.selected_group,
            selected_group_ratio: value.selected_group_ratio,
            selected_group_estimated_quota: value.selected_group_estimated_quota,
            final_quota: value.final_quota,
            refund_quota: value.refund_quota,
            additional_quota: value.additional_quota,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActualGroupBillingSmokeReport {
    scenario: &'static str,
    status: &'static str,
    binding_path: &'static str,
    confirmation: &'static str,
    cleanup_requested: bool,
    cleanup_performed: bool,
    cleanup_verified: bool,
    primary_plan: Option<ActualGroupBillingPlanEvidence>,
    fallback_plan: Option<ActualGroupBillingPlanEvidence>,
    setup_snapshot: ActualGroupBillingSmokeSnapshot,
    final_snapshot: ActualGroupBillingSmokeSnapshot,
    expected_snapshot: ActualGroupBillingSmokeSnapshot,
}

#[derive(Debug, Deserialize)]
struct OptionValueRow {
    value: String,
}

#[derive(Debug, Deserialize)]
struct UserSnapshotRow {
    quota: i64,
    used_quota: i64,
    request_count: i64,
}

#[derive(Debug, Deserialize)]
struct TokenSnapshotRow {
    remain_quota: i64,
    used_quota: i64,
    accessed_time: i64,
}

#[derive(Debug, Deserialize)]
struct ChannelSnapshotRow {
    used_quota: i64,
}

#[derive(Debug, Deserialize)]
struct CountRow {
    count: i64,
}

#[derive(Debug, Clone)]
struct SavedOption {
    key: &'static str,
    value: Option<String>,
}

pub async fn handler(mut req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    if runtime_value(&env, "ENVIRONMENT")
        .map(|value| matches!(value.as_str(), "production" | "prod"))
        .unwrap_or(false)
    {
        return Ok(envelope_error_response(
            403,
            "Actual-group billing smoke is not available in production",
        ));
    }
    if !smoke_enabled(&env) {
        return Ok(envelope_error_response(
            403,
            "Actual-group billing smoke is disabled",
        ));
    }

    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let input: ActualGroupBillingSmokeRequest = match serde_json::from_value(body) {
        Ok(input) => input,
        Err(err) => {
            return Ok(envelope_error_response(
                400,
                &format!("invalid actual-group billing smoke request: {err}"),
            ));
        }
    };
    if !input.confirm_live {
        return Ok(envelope_error_response(
            400,
            "Actual-group billing smoke requires confirm_live=true",
        ));
    }
    let Some(scenario) = smoke_scenario(&input.scenario) else {
        return Ok(envelope_error_response(
            400,
            "unknown actual-group billing smoke scenario",
        ));
    };
    if input.cleanup == Some(false) {
        return Ok(envelope_error_response(
            400,
            "Actual-group billing smoke requires cleanup=true",
        ));
    }

    let db = env.d1("DB")?;
    let cleanup_requested = true;
    let saved_options = load_saved_options(&db).await?;
    ensure_fixture_slots_owned(&db).await?;
    cleanup_fixture_rows(&db).await?;
    let result = run_smoke(&db, scenario, cleanup_requested, &saved_options).await;
    match result {
        Ok(mut report) => {
            if cleanup_requested {
                cleanup_fixture(&db, &saved_options).await?;
                report.cleanup_performed = true;
                report.cleanup_verified = verify_cleanup(&db, &saved_options).await?;
                if !report.cleanup_verified {
                    report.status = "FAIL";
                }
            }
            let mut response = envelope_ok_response(&report)?;
            response.headers_mut().set("Cache-Control", "no-store")?;
            Ok(response)
        }
        Err(err) => {
            let cleanup_error = cleanup_fixture(&db, &saved_options).await.err();
            let message = match cleanup_error {
                Some(cleanup_error) => {
                    format!(
                        "actual-group billing smoke failed: {err}; cleanup failed: {cleanup_error}"
                    )
                }
                None => format!("actual-group billing smoke failed: {err}"),
            };
            Ok(envelope_error_response(500, &message))
        }
    }
}

pub(crate) fn smoke_compiled() -> bool {
    smoke_scenarios().len() == 3
        && smoke_scenario("actual-group-refund").is_some()
        && smoke_scenario("fallback-plan-replacement").is_some()
        && smoke_scenario("retry-exhaustion-refund").is_some()
}

pub(crate) fn smoke_enabled(env: &Env) -> bool {
    matches!(
        runtime_value(env, RELAY_ACTUAL_GROUP_BILLING_STAGING_SMOKE_ENABLED_ENV).as_deref(),
        Some("true") | Some("1")
    )
}

pub(crate) fn smoke_ready(env: &Env, d1_ready: bool) -> bool {
    d1_ready && smoke_compiled() && smoke_enabled(env)
}

fn smoke_scenarios() -> [ActualGroupBillingSmokeScenario; 3] {
    [
        ActualGroupBillingSmokeScenario::ActualGroupRefund,
        ActualGroupBillingSmokeScenario::FallbackPlanReplacement,
        ActualGroupBillingSmokeScenario::RetryExhaustionRefund,
    ]
}

fn smoke_scenario(value: &str) -> Option<ActualGroupBillingSmokeScenario> {
    match value.trim() {
        "actual-group-refund" => Some(ActualGroupBillingSmokeScenario::ActualGroupRefund),
        "fallback-plan-replacement" => {
            Some(ActualGroupBillingSmokeScenario::FallbackPlanReplacement)
        }
        "retry-exhaustion-refund" => Some(ActualGroupBillingSmokeScenario::RetryExhaustionRefund),
        _ => None,
    }
}

async fn run_smoke(
    db: &D1Database,
    scenario: ActualGroupBillingSmokeScenario,
    cleanup_requested: bool,
    saved_options: &[SavedOption],
) -> WorkerResult<ActualGroupBillingSmokeReport> {
    install_fixture_options(db, saved_options).await?;
    seed_fixture_rows(db).await?;
    let setup_snapshot = fixture_snapshot(db).await?;
    let auth = crate::d1_repositories::authenticate_token(db, TOKEN_KEY)
        .await?
        .ok_or_else(|| worker::Error::RustError("smoke token authentication failed".to_string()))?;
    if !auth.cross_group_retry_enabled() {
        return Err(worker::Error::RustError(
            "smoke token did not load cross_group_retry from D1 authentication".to_string(),
        ));
    }
    let now = crate::admin::unix_timestamp();
    let primary_groups = vec![
        PRIMARY_LOW_GROUP.to_string(),
        PRIMARY_HIGH_GROUP.to_string(),
    ];
    let fallback_groups = vec![
        FALLBACK_LOW_GROUP.to_string(),
        FALLBACK_HIGH_GROUP.to_string(),
    ];

    let (primary_plan, fallback_plan, expected_final_quota) = match scenario {
        ActualGroupBillingSmokeScenario::ActualGroupRefund => {
            let primary = execute_actual_group_billing_smoke_plan(
                db,
                &auth,
                CHANNEL_ID,
                PRIMARY_MODEL,
                &primary_groups,
                PRIMARY_LOW_GROUP,
                ActualGroupBillingSmokeAction::SettleSelectedGroup,
                now,
            )
            .await?;
            (Some(primary.into()), None, 350)
        }
        ActualGroupBillingSmokeScenario::FallbackPlanReplacement => {
            let primary = execute_actual_group_billing_smoke_plan(
                db,
                &auth,
                CHANNEL_ID,
                PRIMARY_MODEL,
                &primary_groups,
                PRIMARY_LOW_GROUP,
                ActualGroupBillingSmokeAction::RefundExhaustedPlan,
                now,
            )
            .await?;
            let fallback = execute_actual_group_billing_smoke_plan(
                db,
                &auth,
                CHANNEL_ID,
                FALLBACK_MODEL,
                &fallback_groups,
                FALLBACK_LOW_GROUP,
                ActualGroupBillingSmokeAction::SettleSelectedGroup,
                now,
            )
            .await?;
            (Some(primary.into()), Some(fallback.into()), 450)
        }
        ActualGroupBillingSmokeScenario::RetryExhaustionRefund => {
            let primary = execute_actual_group_billing_smoke_plan(
                db,
                &auth,
                CHANNEL_ID,
                PRIMARY_MODEL,
                &primary_groups,
                PRIMARY_LOW_GROUP,
                ActualGroupBillingSmokeAction::RefundExhaustedPlan,
                now,
            )
            .await?;
            (Some(primary.into()), None, 0)
        }
    };

    let final_snapshot = fixture_snapshot(db).await?;
    let expected_snapshot = settled_snapshot(expected_final_quota, now);
    let evidence_ok =
        plan_evidence_matches_scenario(scenario, primary_plan.as_ref(), fallback_plan.as_ref());
    let status = if setup_snapshot == initial_snapshot()
        && final_snapshot == expected_snapshot
        && evidence_ok
    {
        "PASS"
    } else {
        "FAIL"
    };

    Ok(ActualGroupBillingSmokeReport {
        scenario: scenario.name(),
        status,
        binding_path: "worker_binding",
        confirmation: "relay tiered group plan plus D1 reserve/settle/refund",
        cleanup_requested,
        cleanup_performed: false,
        cleanup_verified: false,
        primary_plan,
        fallback_plan,
        setup_snapshot,
        final_snapshot,
        expected_snapshot,
    })
}

fn plan_evidence_matches_scenario(
    scenario: ActualGroupBillingSmokeScenario,
    primary: Option<&ActualGroupBillingPlanEvidence>,
    fallback: Option<&ActualGroupBillingPlanEvidence>,
) -> bool {
    match scenario {
        ActualGroupBillingSmokeScenario::ActualGroupRefund => {
            primary.is_some_and(|plan| settled_plan_ok(plan, PRIMARY_LOW_GROUP, 1.0, 350))
                && fallback.is_none()
        }
        ActualGroupBillingSmokeScenario::FallbackPlanReplacement => {
            primary.is_some_and(refunded_plan_ok)
                && fallback.is_some_and(|plan| settled_plan_ok(plan, FALLBACK_LOW_GROUP, 1.0, 450))
        }
        ActualGroupBillingSmokeScenario::RetryExhaustionRefund => {
            primary.is_some_and(refunded_plan_ok) && fallback.is_none()
        }
    }
}

fn settled_plan_ok(
    plan: &ActualGroupBillingPlanEvidence,
    selected_group: &str,
    selected_ratio: f64,
    final_quota: i64,
) -> bool {
    plan.candidate_group_count == 2
        && plan.reservation_strategy == "max_candidate_group"
        && plan.selected_group.as_deref() == Some(selected_group)
        && plan.selected_group_ratio == Some(selected_ratio)
        && plan
            .selected_group_estimated_quota
            .is_some_and(|selected| plan.reserved_quota > selected)
        && plan.final_quota == final_quota
        && plan.refund_quota == plan.reserved_quota - final_quota
        && plan.additional_quota == 0
}

fn refunded_plan_ok(plan: &ActualGroupBillingPlanEvidence) -> bool {
    plan.candidate_group_count == 2
        && plan.reservation_strategy == "max_candidate_group"
        && plan.reserved_quota > 0
        && plan.selected_group.is_none()
        && plan.selected_group_ratio.is_none()
        && plan.selected_group_estimated_quota.is_none()
        && plan.final_quota == 0
        && plan.refund_quota == plan.reserved_quota
        && plan.additional_quota == 0
}

fn initial_snapshot() -> ActualGroupBillingSmokeSnapshot {
    settled_snapshot(0, 0)
}

fn settled_snapshot(final_quota: i64, now: i64) -> ActualGroupBillingSmokeSnapshot {
    ActualGroupBillingSmokeSnapshot {
        user_quota: INITIAL_QUOTA - final_quota,
        user_used_quota: final_quota,
        user_request_count: i64::from(final_quota > 0),
        token_remain_quota: INITIAL_QUOTA - final_quota,
        token_used_quota: final_quota,
        token_accessed_time: if final_quota > 0 { now } else { 0 },
        channel_used_quota: final_quota,
    }
}

async fn load_saved_options(db: &D1Database) -> WorkerResult<Vec<SavedOption>> {
    let mut saved = Vec::with_capacity(SMOKE_OPTION_KEYS.len());
    for &key in SMOKE_OPTION_KEYS {
        let arg = D1Type::Text(key);
        let value = db
            .prepare(r#"SELECT value FROM options WHERE "key" = ?1 LIMIT 1"#)
            .bind_refs(&arg)?
            .first::<OptionValueRow>(None)
            .await?
            .map(|row| row.value);
        saved.push(SavedOption { key, value });
    }
    Ok(saved)
}

async fn install_fixture_options(
    db: &D1Database,
    saved_options: &[SavedOption],
) -> WorkerResult<()> {
    let mut values = saved_options
        .iter()
        .map(|saved| parse_option_object(saved.key, saved.value.as_deref()))
        .collect::<WorkerResult<Vec<_>>>()?;

    values[0].insert(PRIMARY_MODEL.to_string(), json!("tiered_expr"));
    values[0].insert(FALLBACK_MODEL.to_string(), json!("tiered_expr"));
    values[1].insert(
        PRIMARY_MODEL.to_string(),
        json!(r#"tier("base", p * 2 + c * 10)"#),
    );
    values[1].insert(
        FALLBACK_MODEL.to_string(),
        json!(r#"tier("base", p * 3 + c * 12)"#),
    );
    for (group, ratio) in [
        (PRIMARY_LOW_GROUP, 1.0),
        (PRIMARY_HIGH_GROUP, 1.5),
        (FALLBACK_LOW_GROUP, 1.0),
        (FALLBACK_HIGH_GROUP, 1.75),
    ] {
        values[2].insert(group.to_string(), json!(ratio));
    }
    let user_overrides = values[3]
        .entry(USER_GROUP.to_string())
        .or_insert_with(|| json!({}));
    let Some(user_overrides) = user_overrides.as_object_mut() else {
        return Err(worker::Error::RustError(format!(
            "option {} entry for {USER_GROUP} must be a JSON object",
            crate::d1_repositories::GROUP_GROUP_RATIO_OPTION_KEY
        )));
    };
    user_overrides.insert(PRIMARY_HIGH_GROUP.to_string(), json!(2.0));
    user_overrides.insert(FALLBACK_HIGH_GROUP.to_string(), json!(2.5));

    for (saved, value) in saved_options.iter().zip(values) {
        upsert_option(db, saved.key, &Value::Object(value).to_string()).await?;
    }
    Ok(())
}

fn parse_option_object(key: &str, raw: Option<&str>) -> WorkerResult<Map<String, Value>> {
    let Some(raw) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(Map::new());
    };
    serde_json::from_str::<Map<String, Value>>(raw).map_err(|err| {
        worker::Error::RustError(format!("smoke option {key} must be a JSON object: {err}"))
    })
}

async fn upsert_option(db: &D1Database, key: &str, value: &str) -> WorkerResult<()> {
    let args = [D1Type::Text(key), D1Type::Text(value)];
    db.prepare(
        r#"
        INSERT INTO options ("key", value) VALUES (?1, ?2)
        ON CONFLICT("key") DO UPDATE SET value = excluded.value
        "#,
    )
    .bind_refs(&args)?
    .run()
    .await?;
    Ok(())
}

async fn restore_options(db: &D1Database, saved_options: &[SavedOption]) -> WorkerResult<()> {
    for saved in saved_options {
        if let Some(value) = saved.value.as_deref() {
            upsert_option(db, saved.key, value).await?;
        } else {
            let arg = D1Type::Text(saved.key);
            db.prepare(r#"DELETE FROM options WHERE "key" = ?1"#)
                .bind_refs(&arg)?
                .run()
                .await?;
        }
    }
    Ok(())
}

async fn seed_fixture_rows(db: &D1Database) -> WorkerResult<()> {
    let user_args = [
        D1Type::Integer(USER_ID as i32),
        D1Type::Text(USERNAME),
        D1Type::Integer(INITIAL_QUOTA as i32),
        D1Type::Text(USER_GROUP),
    ];
    db.prepare(
        r#"
        INSERT INTO users (
          id, username, password, role, status, quota, used_quota,
          request_count, "group", aff_code, created_at
        ) VALUES (?1, ?2, 'disabled-staging-smoke-user', 1, 1, ?3, 0, 0, ?4,
          'ct_actual_group_smoke_aff', 0)
        "#,
    )
    .bind_refs(&user_args)?
    .run()
    .await?;

    let token_args = [
        D1Type::Integer(TOKEN_ID as i32),
        D1Type::Integer(USER_ID as i32),
        D1Type::Text(TOKEN_KEY),
        D1Type::Integer(INITIAL_QUOTA as i32),
    ];
    db.prepare(
        r#"
        INSERT INTO tokens (
          id, user_id, "key", status, name, created_time, accessed_time,
          expired_time, remain_quota, unlimited_quota, used_quota, "group",
          cross_group_retry
        ) VALUES (?1, ?2, ?3, 1, 'actual-group billing smoke', 0, 0, -1, ?4, 0, 0, 'auto', 1)
        "#,
    )
    .bind_refs(&token_args)?
    .run()
    .await?;

    let channel_args = [
        D1Type::Integer(CHANNEL_ID as i32),
        D1Type::Text(PRIMARY_MODEL),
        D1Type::Text(PRIMARY_LOW_GROUP),
    ];
    db.prepare(
        r#"
        INSERT INTO channels (
          id, type, "key", status, name, created_time, models, "group", used_quota
        ) VALUES (?1, 1, 'disabled-smoke-channel-key', 1,
          'actual-group billing smoke', 0, ?2, ?3, 0)
        "#,
    )
    .bind_refs(&channel_args)?
    .run()
    .await?;
    Ok(())
}

async fn fixture_snapshot(db: &D1Database) -> WorkerResult<ActualGroupBillingSmokeSnapshot> {
    let user_arg = D1Type::Integer(USER_ID as i32);
    let user = db
        .prepare("SELECT quota, used_quota, request_count FROM users WHERE id = ?1")
        .bind_refs(&user_arg)?
        .first::<UserSnapshotRow>(None)
        .await?
        .ok_or_else(|| worker::Error::RustError("actual-group smoke user missing".to_string()))?;
    let token_arg = D1Type::Integer(TOKEN_ID as i32);
    let token = db
        .prepare("SELECT remain_quota, used_quota, accessed_time FROM tokens WHERE id = ?1")
        .bind_refs(&token_arg)?
        .first::<TokenSnapshotRow>(None)
        .await?
        .ok_or_else(|| worker::Error::RustError("actual-group smoke token missing".to_string()))?;
    let channel_arg = D1Type::Integer(CHANNEL_ID as i32);
    let channel = db
        .prepare("SELECT used_quota FROM channels WHERE id = ?1")
        .bind_refs(&channel_arg)?
        .first::<ChannelSnapshotRow>(None)
        .await?
        .ok_or_else(|| {
            worker::Error::RustError("actual-group smoke channel missing".to_string())
        })?;
    Ok(ActualGroupBillingSmokeSnapshot {
        user_quota: user.quota,
        user_used_quota: user.used_quota,
        user_request_count: user.request_count,
        token_remain_quota: token.remain_quota,
        token_used_quota: token.used_quota,
        token_accessed_time: token.accessed_time,
        channel_used_quota: channel.used_quota,
    })
}

async fn cleanup_fixture(db: &D1Database, saved_options: &[SavedOption]) -> WorkerResult<()> {
    cleanup_fixture_rows(db).await?;
    restore_options(db, saved_options).await
}

async fn cleanup_fixture_rows(db: &D1Database) -> WorkerResult<()> {
    let reservation_args = [
        D1Type::Integer(USER_ID as i32),
        D1Type::Integer(TOKEN_ID as i32),
    ];
    db.prepare("DELETE FROM relay_billing_reservations WHERE user_id = ?1 AND token_id = ?2")
        .bind_refs(&reservation_args)?
        .run()
        .await?;
    for (table, id, marker_column, marker) in [
        ("tokens", TOKEN_ID, "key", TOKEN_KEY),
        ("channels", CHANNEL_ID, "name", "actual-group billing smoke"),
        ("users", USER_ID, "username", USERNAME),
    ] {
        let args = [D1Type::Integer(id as i32), D1Type::Text(marker)];
        db.prepare(&format!(
            "DELETE FROM {table} WHERE id = ?1 AND {marker_column} = ?2"
        ))
        .bind_refs(&args)?
        .run()
        .await?;
    }
    Ok(())
}

async fn ensure_fixture_slots_owned(db: &D1Database) -> WorkerResult<()> {
    for (table, id, marker_column, marker) in [
        ("users", USER_ID, "username", USERNAME),
        ("tokens", TOKEN_ID, "key", TOKEN_KEY),
        ("channels", CHANNEL_ID, "name", "actual-group billing smoke"),
    ] {
        let args = [D1Type::Integer(id as i32), D1Type::Text(marker)];
        let conflict_count = db
            .prepare(&format!(
                "SELECT COUNT(1) AS count FROM {table} \
                 WHERE (id = ?1 AND {marker_column} <> ?2) \
                    OR ({marker_column} = ?2 AND id <> ?1)"
            ))
            .bind_refs(&args)?
            .first::<CountRow>(None)
            .await?
            .map(|row| row.count)
            .unwrap_or(0);
        if conflict_count != 0 {
            return Err(worker::Error::RustError(format!(
                "actual-group billing smoke fixture ownership conflict in {table}"
            )));
        }
    }
    Ok(())
}

async fn verify_cleanup(db: &D1Database, saved_options: &[SavedOption]) -> WorkerResult<bool> {
    let fixture_rows = db
        .prepare(&format!(
            "SELECT ((SELECT COUNT(1) FROM users WHERE id = {USER_ID}) + \
             (SELECT COUNT(1) FROM tokens WHERE id = {TOKEN_ID}) + \
             (SELECT COUNT(1) FROM channels WHERE id = {CHANNEL_ID}) + \
             (SELECT COUNT(1) FROM relay_billing_reservations \
              WHERE user_id = {USER_ID} AND token_id = {TOKEN_ID})) AS count"
        ))
        .first::<CountRow>(None)
        .await?
        .map(|row| row.count)
        .unwrap_or(0);
    if fixture_rows != 0 {
        return Ok(false);
    }
    let current = load_saved_options(db).await?;
    Ok(current
        .iter()
        .zip(saved_options)
        .all(|(current, saved)| current.key == saved.key && current.value == saved.value))
}

fn runtime_value(env: &Env, name: &str) -> Option<String> {
    env.var(name)
        .ok()
        .map(|value| value.to_string())
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn smoke_contract_exposes_only_fixed_scenarios() {
        assert!(smoke_compiled());
        assert_eq!(
            smoke_scenario("actual-group-refund"),
            Some(ActualGroupBillingSmokeScenario::ActualGroupRefund)
        );
        assert!(smoke_scenario("arbitrary-sql").is_none());
    }

    #[test]
    fn settled_evidence_requires_max_reserve_and_actual_group() {
        let evidence = ActualGroupBillingPlanEvidence {
            candidate_group_count: 2,
            reservation_strategy: "max_candidate_group",
            reserved_quota: 1_000,
            selected_group: Some(PRIMARY_LOW_GROUP.to_string()),
            selected_group_ratio: Some(1.0),
            selected_group_estimated_quota: Some(500),
            final_quota: 350,
            refund_quota: 650,
            additional_quota: 0,
        };
        assert!(settled_plan_ok(&evidence, PRIMARY_LOW_GROUP, 1.0, 350));
        let mut wrong = evidence;
        wrong.selected_group = Some(PRIMARY_HIGH_GROUP.to_string());
        assert!(!settled_plan_ok(&wrong, PRIMARY_LOW_GROUP, 1.0, 350));
    }

    #[test]
    fn refunded_evidence_requires_full_refund_without_selection() {
        let evidence = ActualGroupBillingPlanEvidence {
            candidate_group_count: 2,
            reservation_strategy: "max_candidate_group",
            reserved_quota: 1_000,
            selected_group: None,
            selected_group_ratio: None,
            selected_group_estimated_quota: None,
            final_quota: 0,
            refund_quota: 1_000,
            additional_quota: 0,
        };
        assert!(refunded_plan_ok(&evidence));
    }

    #[test]
    fn option_object_parser_rejects_non_object_state() {
        assert!(parse_option_object("test", Some(r#"{"ok":1}"#)).is_ok());
        assert!(parse_option_object("test", Some("[]")).is_err());
    }
}
