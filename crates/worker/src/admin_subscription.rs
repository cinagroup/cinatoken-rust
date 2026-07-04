//! Subscription plan and user-subscription routes.
//!
//! This is the balance-payable and Stripe-checkout core of Go
//! `controller/subscription.go`. Non-Stripe external payment providers stay on
//! the payment migration track; the D1 schema and shared creation path here are
//! intentionally provider-neutral.

use std::time::Duration;

use futures_util::{
    future::{select, Either},
    TryStreamExt,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha1::{Digest, Sha1};
use wasm_bindgen::JsValue;
use worker::{
    AbortController, Delay, Env, Fetch, Headers, Method, Request, RequestInit, RequestRedirect,
    Response, Result as WorkerResult,
};

use cinatoken_auth::USER_STATUS_DISABLED;
use cinatoken_session::SessionClaims;

use crate::admin::{
    admin_audit_info, envelope_error_response, envelope_ok_response, read_json_body,
    require_admin_auth, require_user_auth, unix_timestamp,
};
use crate::admin_payment;
use crate::admin_user::parse_group_ratios;
use crate::d1_repositories::{
    self, SubscriptionOrderSettlementWrite, SubscriptionOrderWrite, SubscriptionPlanRow,
    SubscriptionPlanWrite, SubscriptionUserState, UserSubscriptionRow, UserSubscriptionWrite,
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
const ORDER_STATUS_PENDING: &str = "pending";
const ORDER_STATUS_SUCCESS: &str = "success";
const ORDER_STATUS_EXPIRED: &str = "expired";
const PAYMENT_METHOD_BALANCE: &str = "balance";
const PAYMENT_PROVIDER_BALANCE: &str = "balance";
const PAYMENT_PROVIDER_CREEM: &str = "creem";
const PAYMENT_PROVIDER_STRIPE: &str = "stripe";
const CREEM_API_KEY_KEY: &str = "CreemApiKey";
const CREEM_TEST_MODE_KEY: &str = "CreemTestMode";
const CREEM_WEBHOOK_SECRET_KEY: &str = "CreemWebhookSecret";
const GENERAL_QUOTA_DISPLAY_TYPE_KEY: &str = "general_setting.quota_display_type";
const STRIPE_CHECKOUT_SESSIONS_URL: &str = "https://api.stripe.com/v1/checkout/sessions";
const STRIPE_FETCH_TIMEOUT: Duration = Duration::from_secs(30);
const STRIPE_RESPONSE_LIMIT_BYTES: usize = 64 * 1024;

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

pub async fn stripe_pay(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let payload: PlanIdRequest = match parse_body(&mut req, "subscription stripe pay").await {
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
    let config = d1_repositories::load_stripe_config(&db).await?;
    if !stripe_configured(&config.api_secret, &config.webhook_secret) {
        return Ok(envelope_error_response(
            503,
            "Stripe subscription payment is not configured",
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
    let stripe_price_id = plan.stripe_price_id.trim();
    if stripe_price_id.is_empty() {
        return Ok(envelope_error_response(
            400,
            "subscription plan is missing a Stripe price id",
        ));
    }
    if plan.max_purchase_per_user > 0 {
        let count =
            d1_repositories::count_user_subscriptions_by_plan(&db, claims.id, plan.id).await?;
        if count >= plan.max_purchase_per_user {
            return Ok(envelope_error_response(
                400,
                "subscription purchase limit reached",
            ));
        }
    }

    let Some(user) = d1_repositories::find_user_by_id_full(&db, claims.id).await? else {
        return Ok(envelope_error_response(404, "user not found"));
    };
    if user.deleted_at.is_some() {
        return Ok(envelope_error_response(404, "user not found"));
    }
    let trade_no = match stripe_subscription_trade_no(claims.id) {
        Some(value) => value,
        None => {
            return Ok(envelope_error_response(
                500,
                "failed to generate subscription order id",
            ))
        }
    };
    let now = unix_timestamp();
    if let Err(err) = d1_repositories::insert_subscription_order(
        &db,
        &SubscriptionOrderWrite {
            user_id: claims.id,
            plan_id: plan.id,
            money: plan.price_amount,
            trade_no: &trade_no,
            payment_method: PAYMENT_PROVIDER_STRIPE,
            payment_provider: PAYMENT_PROVIDER_STRIPE,
            status: ORDER_STATUS_PENDING,
            create_time: now,
            complete_time: 0,
            provider_payload: "",
        },
    )
    .await
    {
        worker::console_error!("failed to record pending subscription order {trade_no}: {err}");
        return Ok(envelope_error_response(
            500,
            "failed to record pending subscription order",
        ));
    }

    let frontend_base = match resolve_frontend_base_url(&env, &req) {
        Ok(value) => value,
        Err(message) => return Ok(envelope_error_response(400, &message)),
    };
    let return_url = join_url_path(&frontend_base, "/console/topup");
    let form_body = stripe_subscription_checkout_form(
        &trade_no,
        &return_url,
        &return_url,
        stripe_price_id,
        user.stripe_customer.trim(),
        user.email.trim(),
    );
    let session =
        match create_stripe_checkout_session(&config.api_secret, form_body.as_bytes()).await {
            Ok(session) => session,
            Err(message) => {
                worker::console_error!(
                    "failed to create Stripe subscription checkout {trade_no}: {message}"
                );
                return Ok(envelope_error_response(
                    502,
                    "failed to create Stripe checkout session",
                ));
            }
        };

    Ok(envelope_ok_response(&StripeSubscriptionPayResponse {
        pay_link: session.checkout_url.clone(),
        checkout_url: session.checkout_url,
        session_id: session.session_id,
        trade_no,
    })?)
}

pub async fn creem_pay(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let payload: PlanIdRequest = match parse_body(&mut req, "subscription creem pay").await {
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
    let values = d1_repositories::option_values(
        &db,
        &[
            CREEM_API_KEY_KEY,
            CREEM_TEST_MODE_KEY,
            CREEM_WEBHOOK_SECRET_KEY,
            GENERAL_QUOTA_DISPLAY_TYPE_KEY,
        ],
    )
    .await?;
    let api_key = values[0].as_deref().unwrap_or_default().trim();
    let test_mode = parse_bool(values[1].as_deref(), false);
    let webhook_secret = values[2].as_deref().unwrap_or_default().trim();
    let currency = creem_subscription_currency(values[3].as_deref());
    if api_key.is_empty() || webhook_secret.is_empty() {
        return Ok(envelope_error_response(
            503,
            "Creem subscription payment is not configured",
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
    let creem_product_id = plan.creem_product_id.trim();
    if creem_product_id.is_empty() {
        return Ok(envelope_error_response(
            400,
            "subscription plan is missing a Creem product id",
        ));
    }
    if plan.max_purchase_per_user > 0 {
        let count =
            d1_repositories::count_user_subscriptions_by_plan(&db, claims.id, plan.id).await?;
        if count >= plan.max_purchase_per_user {
            return Ok(envelope_error_response(
                400,
                "subscription purchase limit reached",
            ));
        }
    }

    let Some(user) = d1_repositories::find_user_by_id(&db, claims.id).await? else {
        return Ok(envelope_error_response(404, "user not found"));
    };
    if user.status == USER_STATUS_DISABLED {
        return Ok(envelope_error_response(403, "user is disabled"));
    }
    let trade_no = match creem_subscription_trade_no(&user.username) {
        Some(value) => value,
        None => {
            return Ok(envelope_error_response(
                500,
                "failed to generate subscription order id",
            ))
        }
    };
    let now = unix_timestamp();
    if let Err(err) = d1_repositories::insert_subscription_order(
        &db,
        &SubscriptionOrderWrite {
            user_id: claims.id,
            plan_id: plan.id,
            money: plan.price_amount,
            trade_no: &trade_no,
            payment_method: PAYMENT_PROVIDER_CREEM,
            payment_provider: PAYMENT_PROVIDER_CREEM,
            status: ORDER_STATUS_PENDING,
            create_time: now,
            complete_time: 0,
            provider_payload: "",
        },
    )
    .await
    {
        worker::console_error!(
            "failed to record pending Creem subscription order {trade_no}: {err}"
        );
        return Ok(envelope_error_response(
            500,
            "failed to record pending subscription order",
        ));
    }

    let product = admin_payment::CreemProduct {
        product_id: creem_product_id.to_string(),
        name: plan.title.clone(),
        price: plan.price_amount,
        currency: currency.to_string(),
        quota: 0,
    };
    let checkout = match admin_payment::create_creem_checkout(
        api_key, test_mode, &trade_no, &product, &user,
    )
    .await
    {
        Ok(checkout) => checkout,
        Err(message) => {
            worker::console_error!(
                    "failed to create Creem subscription checkout user_id={} trade_no={} product_id={} error={}",
                    claims.id,
                    trade_no,
                    product.product_id,
                    message
                );
            return Ok(envelope_error_response(
                502,
                "failed to create Creem checkout session",
            ));
        }
    };

    Ok(envelope_ok_response(&CreemSubscriptionPayResponse {
        checkout_url: checkout.checkout_url,
        order_id: trade_no,
    })?)
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
    let prepared = prepare_subscription_from_plan(db, user_id, plan, source, now).await?;
    let sub = prepared.as_write();
    d1_repositories::insert_user_subscription(db, &sub)
        .await
        .map_err(|err| err.to_string())?;
    if prepared.upgrade_applies {
        d1_repositories::update_user_group(db, user_id, &prepared.upgrade_group)
            .await
            .map_err(|err| err.to_string())?;
    }
    Ok(prepared.upgrade_message())
}

async fn prepare_subscription_from_plan(
    db: &worker::D1Database,
    user_id: i64,
    plan: &SubscriptionPlanRow,
    source: &str,
    now: i64,
) -> std::result::Result<PreparedSubscription, String> {
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
    let upgrade_applies = !upgrade_group.is_empty() && user.group_name != upgrade_group;
    let prev_user_group = previous_group_for_upgrade(&user, upgrade_group);
    Ok(PreparedSubscription {
        user_id,
        plan_id: plan.id,
        amount_total: plan.total_amount,
        amount_used: 0,
        start_time: now,
        end_time,
        status: SUB_STATUS_ACTIVE.to_string(),
        source: source.to_string(),
        last_reset_time,
        next_reset_time,
        upgrade_group: upgrade_group.to_string(),
        prev_user_group,
        upgrade_applies,
        created_at: now,
        updated_at: now,
    })
}

pub(crate) async fn complete_order_for_provider(
    db: &worker::D1Database,
    trade_no: &str,
    provider_payload: &str,
    expected_provider: &str,
    actual_payment_method: &str,
    now: i64,
) -> WorkerResult<SubscriptionOrderWebhookOutcome> {
    let Some(order) = d1_repositories::find_subscription_order_by_trade_no(db, trade_no).await?
    else {
        return Ok(SubscriptionOrderWebhookOutcome::NotFound);
    };
    if order.payment_provider != expected_provider {
        return Ok(SubscriptionOrderWebhookOutcome::ProviderMismatch);
    }
    match order.status.as_str() {
        ORDER_STATUS_SUCCESS => return Ok(SubscriptionOrderWebhookOutcome::AlreadyComplete),
        ORDER_STATUS_PENDING => {}
        ORDER_STATUS_EXPIRED => return Ok(SubscriptionOrderWebhookOutcome::AlreadyTerminal),
        _ => return Ok(SubscriptionOrderWebhookOutcome::InvalidStatus),
    }

    let Some(plan) = d1_repositories::find_subscription_plan_by_id(db, order.plan_id).await? else {
        return Err(worker::Error::RustError(format!(
            "subscription order {trade_no} references missing plan {}",
            order.plan_id
        )));
    };
    let prepared = prepare_subscription_from_plan(db, order.user_id, &plan, "order", now)
        .await
        .map_err(worker::Error::RustError)?;

    if let Some(topup) = d1_repositories::find_topup_by_trade_no(db, trade_no).await? {
        if topup.payment_provider != expected_provider {
            return Err(worker::Error::RustError(format!(
                "subscription order {trade_no} collides with topup provider {}",
                topup.payment_provider
            )));
        }
    }

    let subscription = prepared.as_write();
    let settlement = SubscriptionOrderSettlementWrite {
        subscription,
        trade_no,
        expected_provider,
        from_status: ORDER_STATUS_PENDING,
        to_status: ORDER_STATUS_SUCCESS,
        actual_payment_method,
        provider_payload,
        money: order.money,
        create_time: order.create_time,
        complete_time: now,
    };
    let result = d1_repositories::complete_subscription_order_batch(db, &settlement).await?;
    if !result.order_marked {
        let Some(current) =
            d1_repositories::find_subscription_order_by_trade_no(db, trade_no).await?
        else {
            return Ok(SubscriptionOrderWebhookOutcome::NotFound);
        };
        return Ok(match current.status.as_str() {
            ORDER_STATUS_SUCCESS => SubscriptionOrderWebhookOutcome::AlreadyComplete,
            ORDER_STATUS_EXPIRED => SubscriptionOrderWebhookOutcome::AlreadyTerminal,
            ORDER_STATUS_PENDING => SubscriptionOrderWebhookOutcome::InvalidStatus,
            _ => SubscriptionOrderWebhookOutcome::InvalidStatus,
        });
    }
    if !result.subscription_inserted || !result.topup_recorded() {
        return Err(worker::Error::RustError(format!(
            "subscription order {trade_no} marked success without subscription/topup batch changes"
        )));
    }

    let username = d1_repositories::find_user_by_id(db, order.user_id)
        .await?
        .map(|user| user.username)
        .unwrap_or_default();
    let _ = d1_repositories::insert_system_log(
        db,
        order.user_id,
        &username,
        &format!(
            "subscription {expected_provider} purchase succeeded, plan: {}",
            plan.title
        ),
        now,
    )
    .await;
    Ok(SubscriptionOrderWebhookOutcome::Completed)
}

pub(crate) async fn expire_order_for_provider(
    db: &worker::D1Database,
    trade_no: &str,
    expected_provider: &str,
    now: i64,
) -> WorkerResult<SubscriptionOrderWebhookOutcome> {
    let Some(order) = d1_repositories::find_subscription_order_by_trade_no(db, trade_no).await?
    else {
        return Ok(SubscriptionOrderWebhookOutcome::NotFound);
    };
    if order.payment_provider != expected_provider {
        return Ok(SubscriptionOrderWebhookOutcome::ProviderMismatch);
    }
    match order.status.as_str() {
        ORDER_STATUS_PENDING => {
            let marked = d1_repositories::mark_subscription_order_status_for_provider(
                db,
                trade_no,
                expected_provider,
                ORDER_STATUS_PENDING,
                ORDER_STATUS_EXPIRED,
                now,
                "",
                "",
            )
            .await?;
            if marked {
                Ok(SubscriptionOrderWebhookOutcome::Expired)
            } else {
                Ok(SubscriptionOrderWebhookOutcome::InvalidStatus)
            }
        }
        ORDER_STATUS_SUCCESS => Ok(SubscriptionOrderWebhookOutcome::AlreadyComplete),
        ORDER_STATUS_EXPIRED => Ok(SubscriptionOrderWebhookOutcome::AlreadyTerminal),
        _ => Ok(SubscriptionOrderWebhookOutcome::InvalidStatus),
    }
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

#[derive(Debug, Serialize)]
struct StripeSubscriptionPayResponse {
    pay_link: String,
    checkout_url: String,
    session_id: String,
    trade_no: String,
}

#[derive(Debug, Serialize)]
struct CreemSubscriptionPayResponse {
    checkout_url: String,
    order_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct StripeCheckoutSession {
    checkout_url: String,
    session_id: String,
}

#[derive(Debug, Clone)]
struct PreparedSubscription {
    user_id: i64,
    plan_id: i64,
    amount_total: i64,
    amount_used: i64,
    start_time: i64,
    end_time: i64,
    status: String,
    source: String,
    last_reset_time: i64,
    next_reset_time: i64,
    upgrade_group: String,
    prev_user_group: String,
    upgrade_applies: bool,
    created_at: i64,
    updated_at: i64,
}

impl PreparedSubscription {
    fn as_write(&self) -> UserSubscriptionWrite<'_> {
        UserSubscriptionWrite {
            user_id: self.user_id,
            plan_id: self.plan_id,
            amount_total: self.amount_total,
            amount_used: self.amount_used,
            start_time: self.start_time,
            end_time: self.end_time,
            status: &self.status,
            source: &self.source,
            last_reset_time: self.last_reset_time,
            next_reset_time: self.next_reset_time,
            upgrade_group: &self.upgrade_group,
            prev_user_group: &self.prev_user_group,
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }

    fn upgrade_message(&self) -> Option<String> {
        self.upgrade_applies
            .then(|| format!("user group will upgrade to {}", self.upgrade_group))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SubscriptionOrderWebhookOutcome {
    Completed,
    AlreadyComplete,
    Expired,
    AlreadyTerminal,
    NotFound,
    ProviderMismatch,
    InvalidStatus,
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

fn stripe_configured(api_secret: &str, webhook_secret: &str) -> bool {
    let api_secret = api_secret.trim();
    !webhook_secret.trim().is_empty()
        && (api_secret.starts_with("sk_") || api_secret.starts_with("rk_"))
}

fn stripe_subscription_trade_no(user_id: i64) -> Option<String> {
    let suffix = random_base62(4)?;
    Some(stripe_subscription_trade_no_from_parts(
        user_id,
        unix_timestamp_millis(),
        &suffix,
    ))
}

fn stripe_subscription_trade_no_from_parts(user_id: i64, millis: i64, suffix: &str) -> String {
    let reference = format!("sub-stripe-ref-{user_id}-{millis}-{suffix}");
    let mut hasher = Sha1::new();
    hasher.update(reference.as_bytes());
    format!("sub_ref_{}", hex_lower(&hasher.finalize()))
}

fn creem_subscription_trade_no(username: &str) -> Option<String> {
    let suffix = random_base62(6)?;
    Some(creem_subscription_trade_no_from_parts(
        username,
        unix_timestamp_millis(),
        &suffix,
    ))
}

fn creem_subscription_trade_no_from_parts(username: &str, millis: i64, suffix: &str) -> String {
    let reference = format!("sub-creem-ref-{suffix}{millis}{username}");
    let mut hasher = Sha1::new();
    hasher.update(reference.as_bytes());
    format!("sub_ref_{}", hex_lower(&hasher.finalize()))
}

fn creem_subscription_currency(quota_display_type: Option<&str>) -> &'static str {
    match quota_display_type.map(str::trim) {
        Some("CNY") => "CNY",
        _ => "USD",
    }
}

fn stripe_subscription_checkout_form(
    reference_id: &str,
    success_url: &str,
    cancel_url: &str,
    stripe_price_id: &str,
    customer_id: &str,
    email: &str,
) -> String {
    let mut form = url::form_urlencoded::Serializer::new(String::new());
    form.append_pair("mode", "subscription");
    form.append_pair("client_reference_id", reference_id);
    form.append_pair("success_url", success_url);
    form.append_pair("cancel_url", cancel_url);
    form.append_pair("line_items[0][price]", stripe_price_id);
    form.append_pair("line_items[0][quantity]", "1");
    if !customer_id.trim().is_empty() {
        form.append_pair("customer", customer_id.trim());
    } else {
        if !email.trim().is_empty() {
            form.append_pair("customer_email", email.trim());
        }
        form.append_pair("customer_creation", "always");
    }
    form.finish()
}

async fn create_stripe_checkout_session(
    api_secret: &str,
    form_body: &[u8],
) -> std::result::Result<StripeCheckoutSession, String> {
    let mut headers = Headers::new();
    headers
        .set("Authorization", &format!("Bearer {}", api_secret.trim()))
        .map_err(|err| format!("failed to set Stripe Authorization header: {err}"))?;
    headers
        .set("Content-Type", "application/x-www-form-urlencoded")
        .map_err(|err| format!("failed to set Stripe Content-Type header: {err}"))?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(wasm_bindgen::JsValue::from(js_sys::Uint8Array::from(
            form_body,
        ))))
        .with_redirect(RequestRedirect::Error);
    let request = Request::new_with_init(STRIPE_CHECKOUT_SESSIONS_URL, &init)
        .map_err(|err| format!("failed to build Stripe request: {err}"))?;
    let controller = AbortController::default();
    let signal = controller.signal();
    let outbound = Fetch::Request(request);
    let fetch = outbound.send_with_signal(&signal);
    let delay = Delay::from(STRIPE_FETCH_TIMEOUT);
    futures_util::pin_mut!(fetch);
    futures_util::pin_mut!(delay);
    let mut response = match select(fetch, delay).await {
        Either::Left((result, _)) => {
            result.map_err(|err| format!("failed to fetch Stripe request: {err}"))?
        }
        Either::Right(((), _)) => {
            controller.abort();
            return Err("Stripe request timed out".to_string());
        }
    };
    let content_type = response
        .headers()
        .get("Content-Type")
        .map_err(|err| format!("failed to inspect Stripe headers: {err}"))?
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !content_type.is_empty()
        && !content_type.contains("application/json")
        && !content_type.contains("+json")
    {
        return Err("Stripe response is not JSON".to_string());
    }
    let status = response.status_code();
    let bytes = read_limited_stripe_response_body(&mut response).await?;
    if status != 200 {
        let body = String::from_utf8_lossy(&bytes);
        return Err(format!("Stripe API error {status}: {body}"));
    }
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|err| format!("invalid Stripe response: {err}"))?;
    let checkout_url = value
        .get("url")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let session_id = value
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if checkout_url.is_empty() || session_id.is_empty() {
        return Err("Stripe checkout session response is missing url or id".to_string());
    }
    Ok(StripeCheckoutSession {
        checkout_url,
        session_id,
    })
}

async fn read_limited_stripe_response_body(
    response: &mut Response,
) -> std::result::Result<Vec<u8>, String> {
    if let Some(raw) = response
        .headers()
        .get("Content-Length")
        .map_err(|err| format!("failed to inspect Stripe headers: {err}"))?
    {
        let raw = raw.trim();
        if !raw.is_empty() {
            let length = raw
                .parse::<usize>()
                .map_err(|_| "Stripe Content-Length is invalid".to_string())?;
            if length > STRIPE_RESPONSE_LIMIT_BYTES {
                return Err("Stripe response body is too large".to_string());
            }
        }
    }
    response
        .stream()
        .map_err(|err| format!("failed to read Stripe response: {err}"))?
        .try_fold(Vec::new(), |mut bytes, chunk| async move {
            if bytes.len().saturating_add(chunk.len()) > STRIPE_RESPONSE_LIMIT_BYTES {
                return Err(worker::Error::RustError(
                    "Stripe response body is too large".to_string(),
                ));
            }
            bytes.extend_from_slice(&chunk);
            Ok(bytes)
        })
        .await
        .map_err(|err| err.to_string())
}

fn resolve_frontend_base_url(env: &Env, req: &Request) -> std::result::Result<String, String> {
    let configured = env
        .var("FRONTEND_BASE_URL")
        .map(|value| value.to_string())
        .unwrap_or_default();
    if !configured.trim().is_empty() {
        return validate_http_base_url(configured.trim());
    }
    request_origin_base_url(req)
}

fn request_origin_base_url(req: &Request) -> std::result::Result<String, String> {
    let url = req
        .url()
        .map_err(|err| format!("request URL is invalid: {err}"))?;
    let scheme = url.scheme();
    if scheme != "http" && scheme != "https" {
        return Err("request URL must use http or https".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "request URL is missing host".to_string())?;
    let port = url
        .port()
        .map(|port| format!(":{port}"))
        .unwrap_or_default();
    validate_http_base_url(&format!("{scheme}://{host}{port}"))
}

fn validate_http_base_url(raw: &str) -> std::result::Result<String, String> {
    let parsed = url::Url::parse(raw).map_err(|_| "payment base URL is invalid".to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("payment base URL must use http or https".to_string());
    }
    if parsed.host_str().is_none() || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("payment base URL must be an absolute public URL".to_string());
    }
    Ok(raw.trim_end_matches('/').to_string())
}

fn join_url_path(base: &str, path: &str) -> String {
    format!("{}{}", base.trim_end_matches('/'), path)
}

fn unix_timestamp_millis() -> i64 {
    js_sys::Date::now().floor() as i64
}

fn random_base62(len: usize) -> Option<String> {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let mut buf = vec![0u8; len.saturating_mul(2).max(16)];
    getrandom::getrandom(&mut buf).ok()?;
    let mut out = Vec::with_capacity(len);
    for &byte in &buf {
        if out.len() >= len {
            break;
        }
        if byte < 248 {
            out.push(ALPHABET[(byte % 62) as usize]);
        }
    }
    if out.len() == len {
        String::from_utf8(out).ok()
    } else {
        None
    }
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
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

    #[test]
    fn stripe_config_requires_api_and_webhook_secrets() {
        assert!(stripe_configured("sk_test_123", "whsec_123"));
        assert!(stripe_configured("rk_live_123", "whsec_123"));
        assert!(!stripe_configured("pk_test_123", "whsec_123"));
        assert!(!stripe_configured("sk_test_123", ""));
    }

    #[test]
    fn stripe_subscription_trade_no_matches_go_shape() {
        let trade_no = stripe_subscription_trade_no_from_parts(42, 1_700_000_000_123, "Ab9z");
        assert!(trade_no.starts_with("sub_ref_"));
        assert_eq!(trade_no.len(), "sub_ref_".len() + 40);
        assert!(trade_no["sub_ref_".len()..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()));
    }

    #[test]
    fn creem_subscription_trade_no_matches_go_shape() {
        let trade_no = creem_subscription_trade_no_from_parts("alice", 1_700_000_000_123, "Ab9zQ1");
        assert!(trade_no.starts_with("sub_ref_"));
        assert_eq!(trade_no.len(), "sub_ref_".len() + 40);
        assert!(trade_no["sub_ref_".len()..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()));
    }

    #[test]
    fn creem_subscription_currency_matches_go_display_type_mapping() {
        assert_eq!(creem_subscription_currency(Some("CNY")), "CNY");
        assert_eq!(creem_subscription_currency(Some("USD")), "USD");
        assert_eq!(creem_subscription_currency(Some("TOKENS")), "USD");
        assert_eq!(creem_subscription_currency(Some("CUSTOM")), "USD");
        assert_eq!(creem_subscription_currency(None), "USD");
    }

    #[test]
    fn stripe_subscription_checkout_form_uses_customer_or_email() {
        let with_customer = stripe_subscription_checkout_form(
            "sub_ref_abc",
            "https://example.com/ok",
            "https://example.com/cancel",
            "price_123",
            "cus_123",
            "u@example.com",
        );
        assert!(with_customer.contains("mode=subscription"));
        assert!(with_customer.contains("client_reference_id=sub_ref_abc"));
        assert!(with_customer.contains("customer=cus_123"));
        assert!(!with_customer.contains("customer_email="));

        let with_email = stripe_subscription_checkout_form(
            "sub_ref_abc",
            "https://example.com/ok",
            "https://example.com/cancel",
            "price_123",
            "",
            "u@example.com",
        );
        assert!(with_email.contains("customer_email=u%40example.com"));
        assert!(with_email.contains("customer_creation=always"));
    }
}
