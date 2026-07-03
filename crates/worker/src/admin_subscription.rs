//! Subscription plan and user-subscription routes.
//!
//! This is the balance-payable core of Go `controller/subscription.go`.
//! External payment providers stay on the payment migration track; the D1
//! schema and shared creation path here are intentionally provider-neutral.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use wasm_bindgen::JsValue;
use worker::{Env, Request, Response, Result as WorkerResult};

use cinatoken_session::SessionClaims;

use crate::admin::{
    admin_audit_info, envelope_error_response, envelope_ok_response, read_json_body,
    require_admin_auth, require_user_auth, unix_timestamp,
};
use crate::admin_user::parse_group_ratios;
use crate::d1_repositories::{
    self, SubscriptionOrderWrite, SubscriptionPlanRow, SubscriptionPlanWrite,
    SubscriptionUserState, UserSubscriptionRow, UserSubscriptionWrite,
};

const CURRENT_COMPLIANCE_TERMS_VERSION: &str = "v1";
const PAYMENT_COMPLIANCE_CONFIRMED_KEY: &str = "payment_setting.compliance_confirmed";
const PAYMENT_COMPLIANCE_TERMS_KEY: &str = "payment_setting.compliance_terms_version";
const QUOTA_PER_UNIT_KEY: &str = "QuotaPerUnit";
const DEFAULT_QUOTA_PER_UNIT: f64 = 500_000.0;

const DURATION_YEAR: &str = "year";
const DURATION_MONTH: &str = "month";
const DURATION_DAY: &str = "day";
const DURATION_HOUR: &str = "hour";
const DURATION_CUSTOM: &str = "custom";

const RESET_NEVER: &str = "never";
const RESET_DAILY: &str = "daily";
const RESET_WEEKLY: &str = "weekly";
const RESET_MONTHLY: &str = "monthly";
const RESET_CUSTOM: &str = "custom";

const SUB_STATUS_ACTIVE: &str = "active";
const ORDER_STATUS_SUCCESS: &str = "success";
const PAYMENT_METHOD_BALANCE: &str = "balance";
const PAYMENT_PROVIDER_BALANCE: &str = "balance";

pub async fn public_plans(req: Request, env: Env) -> WorkerResult<Response> {
    let _claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let db = env.d1("DB")?;
    if !payment_compliance_confirmed(&db).await? {
        return Ok(envelope_ok_response(&Vec::<PlanRecord>::new())?);
    }
    let rows = d1_repositories::list_subscription_plans(&db, false).await?;
    Ok(envelope_ok_response(&plan_records(rows))?)
}

pub async fn self_summary(req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let db = env.d1("DB")?;
    let now = unix_timestamp();
    let setting = d1_repositories::get_user_setting(&db, claims.id).await?;
    let preference = read_billing_preference(setting.as_deref());
    let subscriptions = d1_repositories::list_user_subscriptions(&db, claims.id, true, now).await?;
    let all_subscriptions =
        d1_repositories::list_user_subscriptions(&db, claims.id, false, now).await?;
    Ok(envelope_ok_response(&SelfSubscriptionResponse {
        billing_preference: preference,
        subscriptions: subscription_records(subscriptions),
        all_subscriptions: subscription_records(all_subscriptions),
    })?)
}

pub async fn update_preference(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let payload: PreferenceRequest = match parse_body(&mut req, "subscription preference").await {
        Ok(payload) => payload,
        Err(response) => return Ok(response),
    };
    let preference = normalize_billing_preference(payload.billing_preference.as_deref());
    let db = env.d1("DB")?;
    let setting = d1_repositories::get_user_setting(&db, claims.id).await?;
    let merged = merge_billing_preference(setting.as_deref(), &preference);
    d1_repositories::update_user_setting(&db, claims.id, &merged).await?;
    Ok(envelope_ok_response(&serde_json::json!({
        "billing_preference": preference
    }))?)
}

pub async fn balance_pay(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let payload: PlanIdRequest = match parse_body(&mut req, "subscription balance pay").await {
        Ok(payload) => payload,
        Err(response) => return Ok(response),
    };
    let Some(plan_id) = payload.plan_id.filter(|id| *id > 0) else {
        return Ok(envelope_error_response(400, "plan_id is required"));
    };

    let db = env.d1("DB")?;
    if !payment_compliance_confirmed(&db).await? {
        return Ok(envelope_error_response(
            400,
            "payment compliance is required",
        ));
    }
    let Some(plan) = d1_repositories::find_subscription_plan_by_id(&db, plan_id).await? else {
        return Ok(envelope_error_response(404, "subscription plan not found"));
    };
    if plan.enabled == 0 {
        return Ok(envelope_error_response(
            400,
            "subscription plan is disabled",
        ));
    }
    if plan.price_amount < 0.0 {
        return Ok(envelope_error_response(
            400,
            "subscription price cannot be negative",
        ));
    }
    if plan.allow_balance_pay == 0 {
        return Ok(envelope_error_response(
            400,
            "subscription plan does not allow balance pay",
        ));
    }

    let quota_per_unit = quota_per_unit(&db).await?;
    let required_quota = calc_balance_quota(plan.price_amount, quota_per_unit)?;
    if required_quota > 0 {
        let Some(user) = d1_repositories::find_subscription_user_state(&db, claims.id).await?
        else {
            return Ok(envelope_error_response(404, "user not found"));
        };
        if user.quota < required_quota {
            return Ok(envelope_error_response(400, "insufficient balance"));
        }
        if !d1_repositories::decrease_user_quota_if_enough(&db, claims.id, required_quota).await? {
            return Ok(envelope_error_response(400, "insufficient balance"));
        }
    }

    let now = unix_timestamp();
    let create_result =
        create_subscription_from_plan(&db, claims.id, &plan, PAYMENT_METHOD_BALANCE, now).await;
    if let Err(message) = create_result {
        if required_quota > 0 {
            let _ = d1_repositories::increase_user_quota(&db, claims.id, required_quota).await;
        }
        return Ok(envelope_error_response(400, &message));
    }

    let trade_no = balance_trade_no(claims.id);
    let payload_text = format!("charged_quota={required_quota}");
    if let Err(err) = d1_repositories::insert_subscription_order(
        &db,
        &SubscriptionOrderWrite {
            user_id: claims.id,
            plan_id: plan.id,
            money: plan.price_amount,
            trade_no: &trade_no,
            payment_method: PAYMENT_METHOD_BALANCE,
            payment_provider: PAYMENT_PROVIDER_BALANCE,
            status: ORDER_STATUS_SUCCESS,
            create_time: now,
            complete_time: now,
            provider_payload: &payload_text,
        },
    )
    .await
    {
        worker::console_error!("failed to insert subscription balance order: {}", err);
    }

    let _ = d1_repositories::insert_system_log(
        &db,
        claims.id,
        &claims.username,
        &format!(
            "subscription balance purchase succeeded, plan: {}, charged_quota: {}",
            plan.title, required_quota
        ),
        now,
    )
    .await;

    Ok(envelope_ok_response(&Value::Null)?)
}

pub async fn admin_list_plans(req: Request, env: Env) -> WorkerResult<Response> {
    let _claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let db = env.d1("DB")?;
    let rows = d1_repositories::list_subscription_plans(&db, true).await?;
    Ok(envelope_ok_response(&plan_records(rows))?)
}

pub async fn admin_create_plan(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let payload: PlanPayload = match parse_body(&mut req, "subscription plan create").await {
        Ok(payload) => payload,
        Err(response) => return Ok(response),
    };
    let db = env.d1("DB")?;
    if !payment_compliance_confirmed(&db).await? {
        return Ok(envelope_error_response(
            400,
            "payment compliance is required",
        ));
    }
    let normalized = match normalize_plan_input(payload.plan, None) {
        Ok(plan) => plan,
        Err(message) => return Ok(envelope_error_response(400, &message)),
    };
    if let Err(message) = validate_upgrade_group(&db, &normalized.upgrade_group).await {
        return Ok(envelope_error_response(400, &message));
    }
    let now = unix_timestamp();
    let write = normalized.as_write(now);
    let id = d1_repositories::insert_subscription_plan(&db, &write).await?;
    let row = d1_repositories::find_subscription_plan_by_id(&db, id)
        .await?
        .ok_or_else(|| worker::Error::RustError("subscription plan disappeared".to_string()))?;
    audit_subscription_admin(
        &db,
        &claims,
        &req,
        "subscription.plan_create",
        serde_json::json!({"plan_id": id, "title": row.title}),
        now,
    )
    .await;
    Ok(envelope_ok_response(&PlanRecord {
        plan: plan_dto(row),
    })?)
}

pub async fn admin_update_plan(
    mut req: Request,
    env: Env,
    id_param: Option<&String>,
) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let Some(id) = parse_id_param(id_param) else {
        return Ok(envelope_error_response(400, "plan id is required"));
    };
    let payload: PlanPayload = match parse_body(&mut req, "subscription plan update").await {
        Ok(payload) => payload,
        Err(response) => return Ok(response),
    };
    let db = env.d1("DB")?;
    if !payment_compliance_confirmed(&db).await? {
        return Ok(envelope_error_response(
            400,
            "payment compliance is required",
        ));
    }
    let Some(existing) = d1_repositories::find_subscription_plan_by_id(&db, id).await? else {
        return Ok(envelope_error_response(404, "subscription plan not found"));
    };
    let normalized = match normalize_plan_input(payload.plan, Some(&existing)) {
        Ok(plan) => plan,
        Err(message) => return Ok(envelope_error_response(400, &message)),
    };
    if let Err(message) = validate_upgrade_group(&db, &normalized.upgrade_group).await {
        return Ok(envelope_error_response(400, &message));
    }
    let now = unix_timestamp();
    let write = normalized.as_write(now);
    if !d1_repositories::update_subscription_plan(&db, id, &write).await? {
        return Ok(envelope_error_response(404, "subscription plan not found"));
    }
    let row = d1_repositories::find_subscription_plan_by_id(&db, id)
        .await?
        .ok_or_else(|| worker::Error::RustError("subscription plan disappeared".to_string()))?;
    audit_subscription_admin(
        &db,
        &claims,
        &req,
        "subscription.plan_update",
        serde_json::json!({"plan_id": id, "title": row.title}),
        now,
    )
    .await;
    Ok(envelope_ok_response(&PlanRecord {
        plan: plan_dto(row),
    })?)
}

pub async fn admin_update_plan_status(
    mut req: Request,
    env: Env,
    id_param: Option<&String>,
) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let Some(id) = parse_id_param(id_param) else {
        return Ok(envelope_error_response(400, "plan id is required"));
    };
    let payload: PlanStatusRequest = match parse_body(&mut req, "subscription plan status").await {
        Ok(payload) => payload,
        Err(response) => return Ok(response),
    };
    let db = env.d1("DB")?;
    if !payment_compliance_confirmed(&db).await? {
        return Ok(envelope_error_response(
            400,
            "payment compliance is required",
        ));
    }
    let now = unix_timestamp();
    if !d1_repositories::update_subscription_plan_status(&db, id, payload.enabled, now).await? {
        return Ok(envelope_error_response(404, "subscription plan not found"));
    }
    audit_subscription_admin(
        &db,
        &claims,
        &req,
        "subscription.plan_update",
        serde_json::json!({"plan_id": id, "enabled": payload.enabled}),
        now,
    )
    .await;
    Ok(envelope_ok_response(&Value::Null)?)
}

pub async fn admin_list_user_subscriptions(
    req: Request,
    env: Env,
    user_id_param: Option<&String>,
) -> WorkerResult<Response> {
    let _claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let Some(user_id) = parse_id_param(user_id_param) else {
        return Ok(envelope_error_response(400, "user id is required"));
    };
    let db = env.d1("DB")?;
    let rows =
        d1_repositories::list_user_subscriptions(&db, user_id, false, unix_timestamp()).await?;
    Ok(envelope_ok_response(&subscription_records(rows))?)
}

pub async fn admin_bind_user_subscription(
    mut req: Request,
    env: Env,
    user_id_param: Option<&String>,
) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let Some(user_id) = parse_id_param(user_id_param) else {
        return Ok(envelope_error_response(400, "user id is required"));
    };
    let payload: PlanIdRequest = match parse_body(&mut req, "subscription bind").await {
        Ok(payload) => payload,
        Err(response) => return Ok(response),
    };
    let Some(plan_id) = payload.plan_id.filter(|id| *id > 0) else {
        return Ok(envelope_error_response(400, "plan_id is required"));
    };
    let db = env.d1("DB")?;
    if !payment_compliance_confirmed(&db).await? {
        return Ok(envelope_error_response(
            400,
            "payment compliance is required",
        ));
    }
    let Some(plan) = d1_repositories::find_subscription_plan_by_id(&db, plan_id).await? else {
        return Ok(envelope_error_response(404, "subscription plan not found"));
    };
    let now = unix_timestamp();
    let message = match create_subscription_from_plan(&db, user_id, &plan, "admin", now).await {
        Ok(message) => message,
        Err(message) => return Ok(envelope_error_response(400, &message)),
    };
    audit_subscription_admin(
        &db,
        &claims,
        &req,
        "subscription.bind",
        serde_json::json!({"user_id": user_id, "plan_id": plan_id}),
        now,
    )
    .await;
    match message {
        Some(message) => Ok(envelope_ok_response(
            &serde_json::json!({ "message": message }),
        )?),
        None => Ok(envelope_ok_response(&Value::Null)?),
    }
}

pub async fn admin_invalidate_user_subscription(
    req: Request,
    env: Env,
    sub_id_param: Option<&String>,
) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let Some(sub_id) = parse_id_param(sub_id_param) else {
        return Ok(envelope_error_response(400, "subscription id is required"));
    };
    let db = env.d1("DB")?;
    let Some(sub) = d1_repositories::find_user_subscription_by_id(&db, sub_id).await? else {
        return Ok(envelope_error_response(404, "subscription not found"));
    };
    let now = unix_timestamp();
    if !d1_repositories::cancel_user_subscription(&db, sub_id, now).await? {
        return Ok(envelope_error_response(404, "subscription not found"));
    }
    let downgrade = downgrade_user_group_for_subscription(&db, &sub, now).await?;
    audit_subscription_admin(
        &db,
        &claims,
        &req,
        "subscription.invalidate",
        serde_json::json!({"subscription_id": sub_id, "user_id": sub.user_id}),
        now,
    )
    .await;
    match downgrade {
        Some(group) => Ok(envelope_ok_response(&serde_json::json!({
            "message": format!("user group will roll back to {group}")
        }))?),
        None => Ok(envelope_ok_response(&Value::Null)?),
    }
}

pub async fn admin_delete_user_subscription(
    req: Request,
    env: Env,
    sub_id_param: Option<&String>,
) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let Some(sub_id) = parse_id_param(sub_id_param) else {
        return Ok(envelope_error_response(400, "subscription id is required"));
    };
    let db = env.d1("DB")?;
    let Some(sub) = d1_repositories::find_user_subscription_by_id(&db, sub_id).await? else {
        return Ok(envelope_error_response(404, "subscription not found"));
    };
    let now = unix_timestamp();
    let downgrade = downgrade_user_group_for_subscription(&db, &sub, now).await?;
    if !d1_repositories::delete_user_subscription(&db, sub_id).await? {
        return Ok(envelope_error_response(404, "subscription not found"));
    }
    audit_subscription_admin(
        &db,
        &claims,
        &req,
        "subscription.delete",
        serde_json::json!({"subscription_id": sub_id, "user_id": sub.user_id}),
        now,
    )
    .await;
    match downgrade {
        Some(group) => Ok(envelope_ok_response(&serde_json::json!({
            "message": format!("user group will roll back to {group}")
        }))?),
        None => Ok(envelope_ok_response(&Value::Null)?),
    }
}

async fn create_subscription_from_plan(
    db: &worker::D1Database,
    user_id: i64,
    plan: &SubscriptionPlanRow,
    source: &str,
    now: i64,
) -> std::result::Result<Option<String>, String> {
    if user_id <= 0 || plan.id <= 0 {
        return Err("invalid user or plan id".to_string());
    }
    if plan.max_purchase_per_user > 0 {
        let count = d1_repositories::count_user_subscriptions_by_plan(db, user_id, plan.id)
            .await
            .map_err(|err| err.to_string())?;
        if count >= plan.max_purchase_per_user {
            return Err("subscription purchase limit reached".to_string());
        }
    }
    let user = d1_repositories::find_subscription_user_state(db, user_id)
        .await
        .map_err(|err| err.to_string())?
        .ok_or_else(|| "user not found".to_string())?;
    let end_time = calc_plan_end_time(now, plan)?;
    let next_reset_time = calc_next_reset_time(now, plan, end_time);
    let last_reset_time = if next_reset_time > 0 { now } else { 0 };
    let upgrade_group = plan.upgrade_group.trim();
    let prev_user_group = previous_group_for_upgrade(&user, upgrade_group);
    let sub = UserSubscriptionWrite {
        user_id,
        plan_id: plan.id,
        amount_total: plan.total_amount,
        amount_used: 0,
        start_time: now,
        end_time,
        status: SUB_STATUS_ACTIVE,
        source,
        last_reset_time,
        next_reset_time,
        upgrade_group,
        prev_user_group: &prev_user_group,
        created_at: now,
        updated_at: now,
    };
    d1_repositories::insert_user_subscription(db, &sub)
        .await
        .map_err(|err| err.to_string())?;
    if !upgrade_group.is_empty() && user.group_name != upgrade_group {
        d1_repositories::update_user_group(db, user_id, upgrade_group)
            .await
            .map_err(|err| err.to_string())?;
    }
    Ok((!upgrade_group.is_empty()).then(|| format!("user group will upgrade to {upgrade_group}")))
}

fn previous_group_for_upgrade(user: &SubscriptionUserState, upgrade_group: &str) -> String {
    if !upgrade_group.is_empty() && user.group_name != upgrade_group {
        user.group_name.clone()
    } else {
        String::new()
    }
}

async fn downgrade_user_group_for_subscription(
    db: &worker::D1Database,
    sub: &UserSubscriptionRow,
    now: i64,
) -> WorkerResult<Option<String>> {
    let upgrade_group = sub.upgrade_group.trim();
    if upgrade_group.is_empty() {
        return Ok(None);
    }
    let Some(user) = d1_repositories::find_subscription_user_state(db, sub.user_id).await? else {
        return Ok(None);
    };
    if user.group_name != upgrade_group {
        return Ok(None);
    }
    if d1_repositories::active_upgrade_subscription_exists_excluding(db, sub.user_id, sub.id, now)
        .await?
    {
        return Ok(None);
    }
    let prev = sub.prev_user_group.trim();
    if prev.is_empty() || prev == user.group_name {
        return Ok(None);
    }
    if d1_repositories::update_user_group(db, sub.user_id, prev).await? {
        Ok(Some(prev.to_string()))
    } else {
        Ok(None)
    }
}

#[derive(Debug, Deserialize)]
struct PlanPayload {
    plan: PlanInput,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct PlanInput {
    title: Option<String>,
    subtitle: Option<String>,
    price_amount: Option<f64>,
    currency: Option<String>,
    duration_unit: Option<String>,
    duration_value: Option<i64>,
    custom_seconds: Option<i64>,
    enabled: Option<bool>,
    sort_order: Option<i64>,
    allow_balance_pay: Option<bool>,
    stripe_price_id: Option<String>,
    creem_product_id: Option<String>,
    waffo_pancake_product_id: Option<String>,
    max_purchase_per_user: Option<i64>,
    upgrade_group: Option<String>,
    total_amount: Option<i64>,
    quota_reset_period: Option<String>,
    quota_reset_custom_seconds: Option<i64>,
}

#[derive(Debug, Clone)]
struct NormalizedPlan {
    title: String,
    subtitle: String,
    price_amount: f64,
    currency: String,
    duration_unit: String,
    duration_value: i64,
    custom_seconds: i64,
    enabled: bool,
    sort_order: i64,
    allow_balance_pay: bool,
    stripe_price_id: String,
    creem_product_id: String,
    waffo_pancake_product_id: String,
    max_purchase_per_user: i64,
    upgrade_group: String,
    total_amount: i64,
    quota_reset_period: String,
    quota_reset_custom_seconds: i64,
}

impl NormalizedPlan {
    fn as_write(&self, now: i64) -> SubscriptionPlanWrite<'_> {
        SubscriptionPlanWrite {
            title: &self.title,
            subtitle: &self.subtitle,
            price_amount: self.price_amount,
            currency: &self.currency,
            duration_unit: &self.duration_unit,
            duration_value: self.duration_value,
            custom_seconds: self.custom_seconds,
            enabled: self.enabled,
            sort_order: self.sort_order,
            allow_balance_pay: self.allow_balance_pay,
            stripe_price_id: &self.stripe_price_id,
            creem_product_id: &self.creem_product_id,
            waffo_pancake_product_id: &self.waffo_pancake_product_id,
            max_purchase_per_user: self.max_purchase_per_user,
            upgrade_group: &self.upgrade_group,
            total_amount: self.total_amount,
            quota_reset_period: &self.quota_reset_period,
            quota_reset_custom_seconds: self.quota_reset_custom_seconds,
            now,
        }
    }
}

#[derive(Debug, Deserialize)]
struct PlanStatusRequest {
    enabled: bool,
}

#[derive(Debug, Deserialize)]
struct PlanIdRequest {
    plan_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct PreferenceRequest {
    billing_preference: Option<String>,
}

#[derive(Debug, Serialize)]
struct PlanRecord {
    plan: SubscriptionPlanDto,
}

#[derive(Debug, Serialize)]
struct SubscriptionPlanDto {
    id: i64,
    title: String,
    subtitle: String,
    price_amount: f64,
    currency: String,
    duration_unit: String,
    duration_value: i64,
    custom_seconds: i64,
    enabled: bool,
    sort_order: i64,
    allow_balance_pay: bool,
    stripe_price_id: String,
    creem_product_id: String,
    waffo_pancake_product_id: String,
    max_purchase_per_user: i64,
    upgrade_group: String,
    total_amount: i64,
    quota_reset_period: String,
    quota_reset_custom_seconds: i64,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Serialize)]
struct UserSubscriptionRecord {
    subscription: UserSubscriptionRow,
}

#[derive(Debug, Serialize)]
struct SelfSubscriptionResponse {
    billing_preference: String,
    subscriptions: Vec<UserSubscriptionRecord>,
    all_subscriptions: Vec<UserSubscriptionRecord>,
}

fn normalize_plan_input(
    input: PlanInput,
    existing: Option<&SubscriptionPlanRow>,
) -> std::result::Result<NormalizedPlan, String> {
    let title = input
        .title
        .as_deref()
        .or_else(|| existing.map(|row| row.title.as_str()))
        .unwrap_or("")
        .trim()
        .to_string();
    let _requested_currency = input.currency.as_deref();
    if title.is_empty() {
        return Err("subscription plan title must not be empty".to_string());
    }
    let price_amount = input
        .price_amount
        .or_else(|| existing.map(|row| row.price_amount))
        .unwrap_or(0.0);
    if !(0.0..=9999.0).contains(&price_amount) {
        return Err("subscription plan price must be between 0 and 9999".to_string());
    }
    let mut duration_unit = input
        .duration_unit
        .as_deref()
        .or_else(|| existing.map(|row| row.duration_unit.as_str()))
        .unwrap_or(DURATION_MONTH)
        .trim()
        .to_string();
    if !matches!(
        duration_unit.as_str(),
        DURATION_YEAR | DURATION_MONTH | DURATION_DAY | DURATION_HOUR | DURATION_CUSTOM
    ) {
        duration_unit = DURATION_MONTH.to_string();
    }
    let mut duration_value = input
        .duration_value
        .or_else(|| existing.map(|row| row.duration_value))
        .unwrap_or(1);
    if duration_unit != DURATION_CUSTOM && duration_value <= 0 {
        duration_value = 1;
    }
    let custom_seconds = input
        .custom_seconds
        .or_else(|| existing.map(|row| row.custom_seconds))
        .unwrap_or(0)
        .max(0);
    if duration_unit == DURATION_CUSTOM && custom_seconds <= 0 {
        return Err("custom subscription duration requires positive seconds".to_string());
    }
    let max_purchase_per_user = input
        .max_purchase_per_user
        .or_else(|| existing.map(|row| row.max_purchase_per_user))
        .unwrap_or(0)
        .max(0);
    let total_amount = input
        .total_amount
        .or_else(|| existing.map(|row| row.total_amount))
        .unwrap_or(0)
        .max(0);
    let quota_reset_period = normalize_reset_period(
        input
            .quota_reset_period
            .as_deref()
            .or_else(|| existing.map(|row| row.quota_reset_period.as_str())),
    );
    let quota_reset_custom_seconds = input
        .quota_reset_custom_seconds
        .or_else(|| existing.map(|row| row.quota_reset_custom_seconds))
        .unwrap_or(0)
        .max(0);
    if quota_reset_period == RESET_CUSTOM && quota_reset_custom_seconds <= 0 {
        return Err("custom quota reset requires positive seconds".to_string());
    }

    Ok(NormalizedPlan {
        title,
        subtitle: text_or_existing(input.subtitle, existing.map(|row| row.subtitle.as_str())),
        price_amount,
        currency: "USD".to_string(),
        duration_unit,
        duration_value,
        custom_seconds,
        enabled: input
            .enabled
            .or_else(|| existing.map(|row| row.enabled != 0))
            .unwrap_or(true),
        sort_order: input
            .sort_order
            .or_else(|| existing.map(|row| row.sort_order))
            .unwrap_or(0),
        allow_balance_pay: input
            .allow_balance_pay
            .or_else(|| existing.map(|row| row.allow_balance_pay != 0))
            .unwrap_or(true),
        stripe_price_id: text_or_existing(
            input.stripe_price_id,
            existing.map(|row| row.stripe_price_id.as_str()),
        ),
        creem_product_id: text_or_existing(
            input.creem_product_id,
            existing.map(|row| row.creem_product_id.as_str()),
        ),
        waffo_pancake_product_id: text_or_existing(
            input.waffo_pancake_product_id,
            existing.map(|row| row.waffo_pancake_product_id.as_str()),
        ),
        max_purchase_per_user,
        upgrade_group: text_or_existing(
            input.upgrade_group,
            existing.map(|row| row.upgrade_group.as_str()),
        ),
        total_amount,
        quota_reset_period,
        quota_reset_custom_seconds,
    })
}

fn text_or_existing(value: Option<String>, existing: Option<&str>) -> String {
    value
        .as_deref()
        .or(existing)
        .unwrap_or("")
        .trim()
        .to_string()
}

async fn validate_upgrade_group(
    db: &worker::D1Database,
    group: &str,
) -> std::result::Result<(), String> {
    let group = group.trim();
    if group.is_empty() {
        return Ok(());
    }
    let raw = match d1_repositories::get_option(db, d1_repositories::GROUP_RATIO_OPTION_KEY)
        .await
        .map_err(|err| err.to_string())?
    {
        Some(value) => Some(value),
        None => d1_repositories::get_option(db, "GroupRatio")
            .await
            .map_err(|err| err.to_string())?,
    };
    let ratios = parse_group_ratios(raw.as_deref());
    ratios
        .contains_key(group)
        .then_some(())
        .ok_or_else(|| format!("upgrade group does not exist: {group}"))
}

fn normalize_reset_period(period: Option<&str>) -> String {
    match period.unwrap_or("").trim() {
        RESET_DAILY => RESET_DAILY.to_string(),
        RESET_WEEKLY => RESET_WEEKLY.to_string(),
        RESET_MONTHLY => RESET_MONTHLY.to_string(),
        RESET_CUSTOM => RESET_CUSTOM.to_string(),
        _ => RESET_NEVER.to_string(),
    }
}

fn calc_plan_end_time(start: i64, plan: &SubscriptionPlanRow) -> std::result::Result<i64, String> {
    let value = plan.duration_value;
    if plan.duration_unit != DURATION_CUSTOM && value <= 0 {
        return Err("duration_value must be positive".to_string());
    }
    match plan.duration_unit.as_str() {
        DURATION_YEAR => Ok(add_utc_years(start, value)),
        DURATION_MONTH => Ok(add_utc_months(start, value)),
        DURATION_DAY => Ok(start.saturating_add(value.saturating_mul(24 * 3600))),
        DURATION_HOUR => Ok(start.saturating_add(value.saturating_mul(3600))),
        DURATION_CUSTOM => {
            if plan.custom_seconds <= 0 {
                Err("custom_seconds must be positive".to_string())
            } else {
                Ok(start.saturating_add(plan.custom_seconds))
            }
        }
        _ => Err(format!("invalid duration_unit: {}", plan.duration_unit)),
    }
}

fn calc_next_reset_time(start: i64, plan: &SubscriptionPlanRow, end_time: i64) -> i64 {
    let next = match normalize_reset_period(Some(&plan.quota_reset_period)).as_str() {
        RESET_DAILY => next_utc_midnight(start),
        RESET_WEEKLY => next_utc_monday_midnight(start),
        RESET_MONTHLY => first_day_next_utc_month(start),
        RESET_CUSTOM => {
            if plan.quota_reset_custom_seconds <= 0 {
                0
            } else {
                start.saturating_add(plan.quota_reset_custom_seconds)
            }
        }
        _ => 0,
    };
    if next > 0 && (end_time <= 0 || next <= end_time) {
        next
    } else {
        0
    }
}

fn add_utc_years(start: i64, years: i64) -> i64 {
    let date = date_from_unix(start);
    let year = (date.get_utc_full_year() as i64)
        .saturating_add(years)
        .max(0) as u32;
    date.set_utc_full_year(year);
    unix_from_date(&date)
}

fn add_utc_months(start: i64, months: i64) -> i64 {
    let date = date_from_unix(start);
    let current = date.get_utc_month() as i64;
    let target = current.saturating_add(months).max(0) as u32;
    date.set_utc_month(target);
    unix_from_date(&date)
}

fn next_utc_midnight(start: i64) -> i64 {
    let date = date_from_unix(start);
    date.set_utc_hours(0);
    date.set_utc_minutes(0);
    date.set_utc_seconds(0);
    date.set_utc_milliseconds(0);
    date.set_utc_date(date.get_utc_date().saturating_add(1));
    unix_from_date(&date)
}

fn next_utc_monday_midnight(start: i64) -> i64 {
    let date = date_from_unix(start);
    let weekday = match date.get_utc_day() {
        0 => 7,
        day => day,
    };
    let days_until = 8_u32.saturating_sub(weekday);
    date.set_utc_hours(0);
    date.set_utc_minutes(0);
    date.set_utc_seconds(0);
    date.set_utc_milliseconds(0);
    date.set_utc_date(date.get_utc_date().saturating_add(days_until));
    unix_from_date(&date)
}

fn first_day_next_utc_month(start: i64) -> i64 {
    let date = date_from_unix(start);
    date.set_utc_hours(0);
    date.set_utc_minutes(0);
    date.set_utc_seconds(0);
    date.set_utc_milliseconds(0);
    date.set_utc_date(1);
    date.set_utc_month(date.get_utc_month().saturating_add(1));
    unix_from_date(&date)
}

fn date_from_unix(seconds: i64) -> js_sys::Date {
    js_sys::Date::new(&JsValue::from_f64(seconds as f64 * 1000.0))
}

fn unix_from_date(date: &js_sys::Date) -> i64 {
    (date.get_time() / 1000.0) as i64
}

async fn quota_per_unit(db: &worker::D1Database) -> WorkerResult<f64> {
    Ok(d1_repositories::get_option(db, QUOTA_PER_UNIT_KEY)
        .await?
        .as_deref()
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|value| *value > 0.0)
        .unwrap_or(DEFAULT_QUOTA_PER_UNIT))
}

fn calc_balance_quota(price_amount: f64, quota_per_unit: f64) -> WorkerResult<i64> {
    if price_amount <= 0.0 {
        return Ok(0);
    }
    if quota_per_unit <= 0.0 {
        return Err(worker::Error::RustError(
            "quota unit configuration is invalid".to_string(),
        ));
    }
    Ok((price_amount * quota_per_unit).ceil() as i64)
}

async fn payment_compliance_confirmed(db: &worker::D1Database) -> WorkerResult<bool> {
    let values = d1_repositories::option_values(
        db,
        &[
            PAYMENT_COMPLIANCE_CONFIRMED_KEY,
            PAYMENT_COMPLIANCE_TERMS_KEY,
        ],
    )
    .await?;
    Ok(parse_bool(values[0].as_deref(), false)
        && values[1].as_deref().unwrap_or("") == CURRENT_COMPLIANCE_TERMS_VERSION)
}

fn parse_bool(value: Option<&str>, default: bool) -> bool {
    match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
        Some("true" | "1" | "yes" | "on") => true,
        Some("false" | "0" | "no" | "off") => false,
        _ => default,
    }
}

fn normalize_billing_preference(value: Option<&str>) -> String {
    match value.unwrap_or("").trim() {
        "subscription_first" => "subscription_first",
        "wallet_first" => "wallet_first",
        "subscription_only" => "subscription_only",
        "wallet_only" => "wallet_only",
        _ => "subscription_first",
    }
    .to_string()
}

fn read_billing_preference(setting: Option<&str>) -> String {
    let value = setting
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|value| {
            value
                .get("billing_preference")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    normalize_billing_preference(value.as_deref())
}

fn merge_billing_preference(setting: Option<&str>, preference: &str) -> String {
    let mut map = setting
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    map.insert(
        "billing_preference".to_string(),
        Value::String(normalize_billing_preference(Some(preference))),
    );
    Value::Object(map).to_string()
}

fn plan_records(rows: Vec<SubscriptionPlanRow>) -> Vec<PlanRecord> {
    rows.into_iter()
        .map(|row| PlanRecord {
            plan: plan_dto(row),
        })
        .collect()
}

fn plan_dto(row: SubscriptionPlanRow) -> SubscriptionPlanDto {
    SubscriptionPlanDto {
        id: row.id,
        title: row.title,
        subtitle: row.subtitle,
        price_amount: row.price_amount,
        currency: row.currency,
        duration_unit: row.duration_unit,
        duration_value: row.duration_value,
        custom_seconds: row.custom_seconds,
        enabled: row.enabled != 0,
        sort_order: row.sort_order,
        allow_balance_pay: row.allow_balance_pay != 0,
        stripe_price_id: row.stripe_price_id,
        creem_product_id: row.creem_product_id,
        waffo_pancake_product_id: row.waffo_pancake_product_id,
        max_purchase_per_user: row.max_purchase_per_user,
        upgrade_group: row.upgrade_group,
        total_amount: row.total_amount,
        quota_reset_period: row.quota_reset_period,
        quota_reset_custom_seconds: row.quota_reset_custom_seconds,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

fn subscription_records(rows: Vec<UserSubscriptionRow>) -> Vec<UserSubscriptionRecord> {
    rows.into_iter()
        .map(|subscription| UserSubscriptionRecord { subscription })
        .collect()
}

fn parse_id_param(value: Option<&String>) -> Option<i64> {
    value
        .and_then(|raw| raw.trim().parse::<i64>().ok())
        .filter(|id| *id > 0)
}

async fn parse_body<T: for<'de> Deserialize<'de>>(
    req: &mut Request,
    action: &str,
) -> std::result::Result<T, Response> {
    let body = read_json_body(req).await?;
    serde_json::from_value(body)
        .map_err(|err| envelope_error_response(400, &format!("invalid {action} request: {err}")))
}

async fn audit_subscription_admin(
    db: &worker::D1Database,
    claims: &SessionClaims,
    req: &Request,
    action: &str,
    params: Value,
    now: i64,
) {
    let _ = d1_repositories::insert_admin_audit_log(
        db,
        Some(claims.id),
        Some(&claims.username),
        &claims.username,
        action,
        &format!("admin {} performed {action}", claims.username),
        &params,
        &admin_audit_info(claims, req),
        now,
    )
    .await;
}

fn balance_trade_no(user_id: i64) -> String {
    let random = (js_sys::Math::random() * 1_000_000.0).floor() as i64;
    let millis = js_sys::Date::now() as i64;
    format!("SUBBALUSR{user_id}NO{random:06}{millis}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_billing_preference() {
        assert_eq!(
            normalize_billing_preference(Some("wallet_only")),
            "wallet_only"
        );
        assert_eq!(
            normalize_billing_preference(Some("not-real")),
            "subscription_first"
        );
    }

    #[test]
    fn merges_billing_preference_without_losing_other_settings() {
        let merged = merge_billing_preference(Some(r#"{"language":"zh"}"#), "wallet_first");
        let value: Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(value["language"], "zh");
        assert_eq!(value["billing_preference"], "wallet_first");
    }

    #[test]
    fn normalizes_plan_defaults() {
        let plan = normalize_plan_input(
            PlanInput {
                title: Some(" Pro ".to_string()),
                price_amount: Some(12.0),
                ..PlanInput::default()
            },
            None,
        )
        .unwrap();
        assert_eq!(plan.title, "Pro");
        assert_eq!(plan.currency, "USD");
        assert_eq!(plan.duration_unit, DURATION_MONTH);
        assert_eq!(plan.duration_value, 1);
        assert!(plan.allow_balance_pay);
    }
}
