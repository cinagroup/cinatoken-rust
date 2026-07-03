//! Stripe topup handlers (Scenario C MVP).
//!
//! Wallet/topup routes:
//! - `POST /api/user/stripe/pay` creates a Stripe Checkout Session and returns
//!   the frontend-compatible payment link. UserAuth.
//! - `POST /api/user/stripe/amount` estimates the Stripe charge amount.
//! - `POST /api/user/amount` estimates legacy online/Epay-style charge amount.
//! - `POST /api/user/waffo-pancake/amount` estimates Waffo Pancake charge amount.
//! - `POST /api/option/waffo-pancake/save` persists Waffo Pancake admin config.
//! - `POST /api/stripe/webhook` verifies Stripe events and credits quota.
//! - `GET /api/user/topup/info` exposes implemented payment capabilities.
//! - `POST /api/user/topup` redeems a public redemption code.
//! - `GET /api/user/topup/self` lists the current user's recent topups.
//! - `GET /api/user/topup` lists all topups for admins.
//! - `POST /api/user/topup/complete` manually completes a pending topup.

use cinatoken_auth::USER_STATUS_DISABLED;
use cinatoken_payments::{
    verify_stripe_webhook, StripeWebhookError, STRIPE_WEBHOOK_TOLERANCE_SECONDS,
};
use rust_decimal::prelude::ToPrimitive;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use worker::{Env, Fetch, Headers, Method, Request, Response, Result as WorkerResult};

use crate::admin::{
    admin_audit_info, envelope_error_response, envelope_ok_response, read_json_body,
    require_admin_auth, require_root_auth, require_user_auth, unix_timestamp,
};
use crate::d1_repositories;

const CURRENT_COMPLIANCE_TERMS_VERSION: &str = "v1";
const PAYMENT_COMPLIANCE_CONFIRMED_KEY: &str = "payment_setting.compliance_confirmed";
const PAYMENT_COMPLIANCE_TERMS_KEY: &str = "payment_setting.compliance_terms_version";
const PAYMENT_AMOUNT_OPTIONS_KEY: &str = "payment_setting.amount_options";
const PAYMENT_AMOUNT_DISCOUNT_KEY: &str = "payment_setting.amount_discount";
const GENERAL_QUOTA_DISPLAY_TYPE_KEY: &str = "general_setting.quota_display_type";
const PRICE_KEY: &str = "Price";
const QUOTA_PER_UNIT_KEY: &str = "QuotaPerUnit";
const TOPUP_GROUP_RATIO_KEY: &str = "TopupGroupRatio";
const WAFFO_PANCAKE_MERCHANT_ID_KEY: &str = "WaffoPancakeMerchantID";
const WAFFO_PANCAKE_PRIVATE_KEY_KEY: &str = "WaffoPancakePrivateKey";
const WAFFO_PANCAKE_RETURN_URL_KEY: &str = "WaffoPancakeReturnURL";
const WAFFO_PANCAKE_STORE_ID_KEY: &str = "WaffoPancakeStoreID";
const WAFFO_PANCAKE_PRODUCT_ID_KEY: &str = "WaffoPancakeProductID";
const WAFFO_PANCAKE_MIN_TOPUP_KEY: &str = "WaffoPancakeMinTopUp";
const WAFFO_PANCAKE_UNIT_PRICE_KEY: &str = "WaffoPancakeUnitPrice";
const QUOTA_DISPLAY_TYPE_TOKENS: &str = "TOKENS";
const DEFAULT_PRICE: &str = "7.3";
const DEFAULT_QUOTA_PER_UNIT: &str = "500000";
const DEFAULT_WAFFO_PANCAKE_UNIT_PRICE: &str = "1";
const TOPUP_INFO_OPTION_KEYS: &[&str] = &[
    PAYMENT_COMPLIANCE_CONFIRMED_KEY,
    PAYMENT_COMPLIANCE_TERMS_KEY,
    "MinTopUp",
    "StripeMinTopUp",
    PAYMENT_AMOUNT_OPTIONS_KEY,
    PAYMENT_AMOUNT_DISCOUNT_KEY,
    "TopUpLink",
];
const ONLINE_AMOUNT_OPTION_KEYS: &[&str] = &[
    PAYMENT_COMPLIANCE_CONFIRMED_KEY,
    PAYMENT_COMPLIANCE_TERMS_KEY,
    "MinTopUp",
    PRICE_KEY,
    QUOTA_PER_UNIT_KEY,
    TOPUP_GROUP_RATIO_KEY,
    GENERAL_QUOTA_DISPLAY_TYPE_KEY,
    PAYMENT_AMOUNT_DISCOUNT_KEY,
];
const WAFFO_PANCAKE_AMOUNT_OPTION_KEYS: &[&str] = &[
    PAYMENT_COMPLIANCE_CONFIRMED_KEY,
    PAYMENT_COMPLIANCE_TERMS_KEY,
    WAFFO_PANCAKE_MIN_TOPUP_KEY,
    WAFFO_PANCAKE_UNIT_PRICE_KEY,
    QUOTA_PER_UNIT_KEY,
    TOPUP_GROUP_RATIO_KEY,
    GENERAL_QUOTA_DISPLAY_TYPE_KEY,
    PAYMENT_AMOUNT_DISCOUNT_KEY,
];

/// `POST /api/user/stripe/pay`: initiate a Stripe checkout session.
pub async fn stripe_pay(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    if body
        .get("payment_method")
        .and_then(Value::as_str)
        .filter(|method| !method.is_empty() && *method != "stripe")
        .is_some()
    {
        return Ok(envelope_error_response(400, "unsupported payment method"));
    }
    let amount = request_amount(&body);
    if amount <= 0.0 {
        return Ok(envelope_error_response(400, "amount must be positive"));
    }
    if amount > 10_000.0 {
        return Ok(envelope_error_response(400, "amount must be at most 10000"));
    }

    let db = env.d1("DB")?;
    if !payment_compliance_confirmed(&db).await? {
        return Ok(envelope_error_response(
            403,
            "payment compliance is not confirmed",
        ));
    }
    let config = d1_repositories::load_stripe_config(&db).await?;
    if !config.is_enabled() {
        return Ok(envelope_error_response(
            503,
            "Stripe payment is not configured",
        ));
    }
    if amount < config.min_topup {
        return Ok(envelope_error_response(
            400,
            &format!("minimum topup is ${:.2}", config.min_topup),
        ));
    }

    let quota = config.money_to_quota(amount);
    let now = unix_timestamp();
    // Fixed-width random suffix (avoids the degenerate "00000000" fallback when
    // Math::random() renders to a short decimal).
    let rand_suffix = format!("{:08x}", (js_sys::Math::random() * 4_294_967_296.0) as u32);
    let trade_no = format!("ref_{}{}{}", claims.id, now, rand_suffix);

    // Persist the pending top-up BEFORE creating the Stripe session, and abort
    // if it fails: a paid checkout must always have a creditable record. An
    // orphaned pending row (if the Stripe call below fails) is harmless; a
    // paid-but-missing row is an unrecoverable missed credit.
    if let Err(err) =
        d1_repositories::create_topup(&db, claims.id, quota, amount, &trade_no, now).await
    {
        worker::console_error!("failed to record pending topup {trade_no}: {err}");
        return Ok(envelope_error_response(
            500,
            "failed to record pending topup",
        ));
    }

    // Build redirect URLs from the configured frontend origin (never a
    // hardcoded placeholder domain).
    let frontend_base = env
        .var("FRONTEND_BASE_URL")
        .map(|v| v.to_string())
        .unwrap_or_default();
    let frontend_base = frontend_base.trim_end_matches('/');
    let success_url = js_sys::encode_uri_component(&format!("{frontend_base}/profile"))
        .as_string()
        .unwrap_or_default();
    let cancel_url = js_sys::encode_uri_component(&format!("{frontend_base}/profile"))
        .as_string()
        .unwrap_or_default();

    // Create Stripe Checkout Session via API.
    let amount_cents = (amount * 100.0).round() as u64;
    let form_body = format!(
        "mode=payment&client_reference_id={trade_no}&\
         success_url={success_url}&\
         cancel_url={cancel_url}&\
         line_items[0][quantity]=1&\
         line_items[0][price_data][currency]=usd&\
         line_items[0][price_data][unit_amount]={amount_cents}&\
         line_items[0][price_data][product_data][name]=Cinatoken+Quota+Topup"
    );

    let mut headers = Headers::new();
    headers.set("Authorization", &format!("Bearer {}", config.api_secret))?;
    headers.set("Content-Type", "application/x-www-form-urlencoded")?;

    let mut init = worker::RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(wasm_bindgen::JsValue::from_str(&form_body)));

    let stripe_req = Request::new_with_init("https://api.stripe.com/v1/checkout/sessions", &init)?;
    let mut resp = Fetch::Request(stripe_req).send().await?;
    let status = resp.status_code();
    let text = resp.text().await?;
    if status != 200 {
        worker::console_error!("Stripe API error {status}: {text}");
        return Ok(envelope_error_response(
            502,
            "failed to create Stripe checkout session",
        ));
    }
    let session: Value = serde_json::from_str(&text)
        .map_err(|e| worker::Error::RustError(format!("invalid Stripe response: {e}")))?;
    let checkout_url = session
        .get("url")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let session_id = session
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if checkout_url.is_empty() {
        return Ok(envelope_error_response(
            502,
            "Stripe returned empty checkout URL",
        ));
    }

    worker::console_log!(
        "stripe_pay: user={} trade_no={} amount=${} quota={}",
        claims.id,
        trade_no,
        amount,
        quota
    );

    Ok(envelope_ok_response(&StripePayResponse {
        pay_link: checkout_url.clone(),
        checkout_url,
        session_id,
        trade_no,
    })?)
}

/// `POST /api/user/stripe/amount`: estimate Stripe payment amount.
pub async fn stripe_amount(mut req: Request, env: Env) -> WorkerResult<Response> {
    let _claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let amount = request_amount(&body);
    if amount <= 0.0 {
        return Ok(envelope_error_response(400, "amount must be positive"));
    }
    let db = env.d1("DB")?;
    if !payment_compliance_confirmed(&db).await? {
        return Ok(envelope_error_response(
            403,
            "payment compliance is not confirmed",
        ));
    }
    let config = d1_repositories::load_stripe_config(&db).await?;
    if !config.is_enabled() {
        return Ok(envelope_error_response(
            503,
            "Stripe payment is not configured",
        ));
    }
    if amount < config.min_topup {
        return Ok(envelope_error_response(
            400,
            &format!("minimum topup is ${:.2}", config.min_topup),
        ));
    }
    Ok(envelope_ok_response(&format!("{amount:.2}"))?)
}

/// `POST /api/user/amount`: estimate legacy online/Epay-style payment amount.
pub async fn online_amount(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let amount = request_amount(&body);
    if !amount.is_finite() || amount <= 0.0 || amount.fract() != 0.0 || amount > i64::MAX as f64 {
        return Ok(envelope_error_response(
            400,
            "amount must be a positive integer",
        ));
    }
    let amount = amount as i64;

    let db = env.d1("DB")?;
    let values = d1_repositories::option_values(&db, ONLINE_AMOUNT_OPTION_KEYS).await?;
    let compliance_confirmed = parse_bool(values[0].as_deref(), false)
        && values[1].as_deref().unwrap_or("") == CURRENT_COMPLIANCE_TERMS_VERSION;
    if !compliance_confirmed {
        return Ok(envelope_error_response(
            403,
            "payment compliance is not confirmed",
        ));
    }

    let Some(user) = d1_repositories::find_user_by_id(&db, claims.id).await? else {
        return Ok(envelope_error_response(401, "user not found"));
    };
    if user.status == USER_STATUS_DISABLED {
        return Ok(envelope_error_response(403, "user is disabled"));
    }

    let settings = OnlineAmountSettings {
        min_topup: parse_positive_i64(values[2].as_deref(), 1),
        price: parse_positive_decimal(values[3].as_deref(), DEFAULT_PRICE),
        quota_per_unit: parse_positive_decimal(values[4].as_deref(), DEFAULT_QUOTA_PER_UNIT),
        topup_group_ratio: topup_group_ratio_for_group(&user.group, values[5].as_deref()),
        quota_display_type: values[6].as_deref().unwrap_or("USD"),
        discount: discount_for_amount(amount, values[7].as_deref()),
    };

    let min_topup = online_min_topup(&settings);
    if amount < min_topup {
        return Ok(envelope_error_response(
            400,
            &format!("minimum topup is {min_topup}"),
        ));
    }
    let pay_money = online_pay_money(amount, &settings);
    if pay_money <= Decimal::new(1, 2) {
        return Ok(envelope_error_response(400, "amount is too small"));
    }

    Ok(envelope_ok_response(&format_pay_money(pay_money))?)
}

/// `POST /api/user/waffo-pancake/amount`: estimate Waffo Pancake payment amount.
pub async fn waffo_pancake_amount(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let amount = request_amount(&body);
    if !amount.is_finite() || amount <= 0.0 || amount.fract() != 0.0 || amount > i64::MAX as f64 {
        return Ok(envelope_error_response(
            400,
            "amount must be a positive integer",
        ));
    }
    let amount = amount as i64;

    let db = env.d1("DB")?;
    let values = d1_repositories::option_values(&db, WAFFO_PANCAKE_AMOUNT_OPTION_KEYS).await?;
    let compliance_confirmed = parse_bool(values[0].as_deref(), false)
        && values[1].as_deref().unwrap_or("") == CURRENT_COMPLIANCE_TERMS_VERSION;
    if !compliance_confirmed {
        return Ok(envelope_error_response(
            403,
            "payment compliance is not confirmed",
        ));
    }

    let Some(user) = d1_repositories::find_user_by_id(&db, claims.id).await? else {
        return Ok(envelope_error_response(401, "user not found"));
    };
    if user.status == USER_STATUS_DISABLED {
        return Ok(envelope_error_response(403, "user is disabled"));
    }

    let min_topup = parse_positive_i64(values[2].as_deref(), 1);
    if amount < min_topup {
        return Ok(envelope_error_response(
            400,
            &format!("minimum topup is {min_topup}"),
        ));
    }
    let settings = OnlineAmountSettings {
        min_topup,
        price: parse_positive_decimal(values[3].as_deref(), DEFAULT_WAFFO_PANCAKE_UNIT_PRICE),
        quota_per_unit: parse_positive_decimal(values[4].as_deref(), DEFAULT_QUOTA_PER_UNIT),
        topup_group_ratio: topup_group_ratio_for_group(&user.group, values[5].as_deref()),
        quota_display_type: values[6].as_deref().unwrap_or("USD"),
        discount: discount_for_amount(amount, values[7].as_deref()),
    };

    let pay_money = online_pay_money(amount, &settings);
    if pay_money <= Decimal::new(1, 2) {
        return Ok(envelope_error_response(400, "amount is too small"));
    }

    Ok(envelope_ok_response(&format_pay_money(pay_money))?)
}

/// `POST /api/option/waffo-pancake/save`: persist Waffo Pancake admin config.
///
/// Mirrors Go `SaveWaffoPancakeConfig`: merchant/store/product are required,
/// return URL is trimmed, and a blank private key means "keep the existing key".
pub async fn save_waffo_pancake_config(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_root_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let payload: SaveWaffoPancakeConfigRequest = match serde_json::from_value(body) {
        Ok(payload) => payload,
        Err(err) => {
            return Ok(envelope_error_response(
                400,
                &format!("invalid Waffo Pancake config request: {err}"),
            ));
        }
    };
    let updates = match waffo_pancake_config_updates(&payload) {
        Ok(updates) => updates,
        Err(message) => return Ok(envelope_error_response(400, message)),
    };
    let private_key_updated = !payload.private_key.trim().is_empty();
    let store_id = payload.store_id.trim().to_string();
    let product_id = payload.product_id.trim().to_string();

    let db = env.d1("DB")?;
    d1_repositories::upsert_options_pub(&db, &updates).await?;
    crate::cache_invalidation::invalidate_option_cache(&env).await?;

    let _ = d1_repositories::insert_admin_audit_log(
        &db,
        None,
        None,
        &claims.username,
        "option.waffo_pancake.save",
        &format!("admin {} saved Waffo Pancake config", claims.username),
        &serde_json::json!({
            "store_id": store_id.as_str(),
            "product_id": product_id.as_str(),
            "private_key_updated": private_key_updated,
        }),
        &admin_audit_info(&claims, &req),
        unix_timestamp(),
    )
    .await;

    Ok(envelope_ok_response(&WaffoPancakeConfigSaveResponse {
        product_id,
        store_id,
    })?)
}

/// `POST /api/stripe/webhook`: receive and process a Stripe webhook.
/// Public route - security relies on HMAC-SHA256 signature verification.
pub async fn stripe_webhook(mut req: Request, env: Env) -> WorkerResult<Response> {
    let db = env.d1("DB")?;
    let config = d1_repositories::load_stripe_config(&db).await?;
    if !config.is_enabled() {
        // Stripe not configured — return 200 so Stripe doesn't retry.
        return Ok(Response::empty()?.with_status(200));
    }

    let signature = req
        .headers()
        .get("Stripe-Signature")
        .ok()
        .flatten()
        .unwrap_or_default();
    let payload = req.bytes().await?;

    let event = match verify_stripe_webhook(
        &config,
        &payload,
        &signature,
        STRIPE_WEBHOOK_TOLERANCE_SECONDS,
    ) {
        Ok(event) => event,
        Err(StripeWebhookError::InvalidSignature(msg)) => {
            worker::console_warn!("Stripe webhook signature invalid: {msg}");
            return Ok(Response::error("invalid signature", 400)?);
        }
        Err(StripeWebhookError::TimestampOutsideTolerance) => {
            return Ok(Response::error("timestamp outside tolerance", 400)?);
        }
        Err(StripeWebhookError::InvalidPayload(msg)) => {
            worker::console_warn!("Stripe webhook payload invalid: {msg}");
            return Ok(Response::error("invalid payload", 400)?);
        }
        Err(StripeWebhookError::HexDecode) => {
            return Ok(Response::error("invalid signature encoding", 400)?);
        }
    };

    let event_id = event.id.clone();
    let now = unix_timestamp();

    // Only `checkout.session.completed` credits a top-up; record other events
    // for observability and ack so Stripe stops retrying.
    if event.event_type != "checkout.session.completed" {
        let _ = d1_repositories::insert_payment_event(
            &db,
            "stripe",
            &event_id,
            "",
            "ignored",
            &String::from_utf8_lossy(&payload),
            now,
        )
        .await;
        return Ok(Response::empty()?.with_status(200));
    }

    let trade_no = match &event.data.object.client_reference_id {
        Some(id) if !id.is_empty() => id.clone(),
        _ => {
            worker::console_warn!("Stripe webhook: no client_reference_id in event {event_id}");
            return Ok(Response::empty()?.with_status(200));
        }
    };

    // Idempotency + atomicity: the conditional `WHERE status = 0` CAS inside
    // `complete_topup_and_credit` is the credit-once gate, and it flips the
    // status and credits the quota in one D1 batch (so a crash can't leave a
    // top-up completed-but-uncredited). A replay no-ops (no double-credit); a
    // transient failure leaves the top-up pending so the retry credits exactly
    // once. The credit is deliberately NOT gated on the payment_events dedup,
    // which would otherwise skip an un-credited top-up after a failed retry.
    let credited = d1_repositories::complete_topup_and_credit(&db, &trade_no, now).await?;

    // Record the event for observability/audit (best-effort, non-gating).
    let _ = d1_repositories::insert_payment_event(
        &db,
        "stripe",
        &event_id,
        &trade_no,
        "paid",
        &String::from_utf8_lossy(&payload),
        now,
    )
    .await;

    if credited {
        if let Some(topup) = d1_repositories::find_topup_by_trade_no(&db, &trade_no).await? {
            let _ = d1_repositories::insert_admin_audit_log(
                &db,
                Some(topup.user_id),
                None,
                "system",
                "topup.credit",
                &format!(
                    "Stripe topup {} credited {} quota ({} USD)",
                    trade_no, topup.amount, topup.money
                ),
                &serde_json::json!({"trade_no": trade_no, "amount": topup.amount, "money": topup.money}),
                &d1_repositories::AdminAuditInfo {
                    admin_id: 0,
                    admin_username: "stripe-webhook".to_string(),
                    admin_role: 0,
                    auth_method: "webhook".to_string(),
                    ip: String::new(),
                },
                now,
            )
            .await;
            worker::console_log!(
                "stripe_webhook: credited {} quota to user {} for trade_no={}",
                topup.amount,
                topup.user_id,
                trade_no
            );
        }
    }

    Ok(Response::empty()?.with_status(200))
}

/// `GET /api/user/topup/info`: wallet payment capability/config summary.
pub async fn topup_info(req: Request, env: Env) -> WorkerResult<Response> {
    let _claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let db = env.d1("DB")?;
    let values = d1_repositories::option_values(&db, TOPUP_INFO_OPTION_KEYS).await?;
    let compliance_confirmed = parse_bool(values[0].as_deref(), false)
        && values[1].as_deref().unwrap_or("") == CURRENT_COMPLIANCE_TERMS_VERSION;
    let config = d1_repositories::load_stripe_config(&db).await?;

    let min_topup = parse_positive_f64(values[2].as_deref(), 1.0);
    let stripe_min_topup = parse_positive_f64(values[3].as_deref(), config.min_topup);
    let amount_options = parse_json_option(
        values[4].as_deref(),
        serde_json::json!([10, 20, 50, 100, 200, 500]),
    );
    let discount = parse_json_option(values[5].as_deref(), serde_json::json!({}));
    let topup_link = values[6].clone().unwrap_or_default();

    // Only expose provider methods that have a Rust Worker implementation.
    // Epay/Creem/Waffo remain payment-deferred and stay hidden even if legacy
    // option keys are present, so the frontend never renders broken buttons.
    let enable_stripe_topup = compliance_confirmed && config.is_enabled();
    let mut pay_methods = Vec::new();
    if enable_stripe_topup {
        pay_methods.push(serde_json::json!({
            "name": "Stripe",
            "type": "stripe",
            "color": "rgba(var(--semi-purple-5), 1)",
            "min_topup": stripe_min_topup,
        }));
    }

    Ok(envelope_ok_response(&TopupInfoResponse {
        enable_online_topup: false,
        enable_stripe_topup,
        enable_creem_topup: false,
        enable_waffo_topup: false,
        enable_waffo_pancake_topup: false,
        enable_redemption: compliance_confirmed,
        payment_compliance_confirmed: compliance_confirmed,
        payment_compliance_terms_version: CURRENT_COMPLIANCE_TERMS_VERSION.to_string(),
        waffo_pay_methods: Value::Null,
        creem_products: Value::Array(Vec::new()),
        pay_methods,
        min_topup,
        stripe_min_topup,
        waffo_min_topup: 1.0,
        waffo_pancake_min_topup: 1.0,
        amount_options,
        discount,
        topup_link,
    })?)
}

/// `POST /api/user/topup`: redeem a public redemption code.
pub async fn redeem_topup_code(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let db = env.d1("DB")?;
    if !payment_compliance_confirmed(&db).await? {
        return Ok(envelope_error_response(
            200,
            "payment compliance is required",
        ));
    }

    let payload: RedemptionRequest = match read_json_body(&mut req).await.and_then(|value| {
        serde_json::from_value(value).map_err(|err| {
            envelope_error_response(400, &format!("invalid redemption request: {err}"))
        })
    }) {
        Ok(payload) => payload,
        Err(response) => return Ok(response),
    };
    let key = payload.key.trim();
    if key.is_empty() {
        return Ok(envelope_error_response(200, "redemption code is required"));
    }

    let now = unix_timestamp();
    match d1_repositories::redeem_redemption_code(&db, key, claims.id, now).await? {
        d1_repositories::RedeemRedemptionResult::Credited { id, quota } => {
            let ip = crate::relay::client_ip(&req).unwrap_or_default();
            let _ = d1_repositories::insert_topup_log(
                &db,
                claims.id,
                &claims.username,
                &format!("Redeemed code {id}, credited quota {quota}"),
                &ip,
                &serde_json::json!({
                    "admin_info": {
                        "caller_ip": ip,
                        "payment_method": "redemption",
                        "callback_payment_method": "redemption",
                        "version": "rust-worker",
                    }
                }),
                now,
            )
            .await;
            Ok(envelope_ok_response(&quota)?)
        }
        d1_repositories::RedeemRedemptionResult::Invalid => {
            Ok(envelope_error_response(200, "invalid redemption code"))
        }
        d1_repositories::RedeemRedemptionResult::Used => Ok(envelope_error_response(
            200,
            "redemption code has been used",
        )),
        d1_repositories::RedeemRedemptionResult::Expired => {
            Ok(envelope_error_response(200, "redemption code has expired"))
        }
    }
}

/// `GET /api/user/topup/self`: list the current user's recent topup records.
pub async fn list_self_topups(req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let keyword = match parse_keyword_pattern(&req) {
        Ok(keyword) => keyword,
        Err(response) => return Ok(response),
    };
    let (page, page_size) = parse_pagination(&req);
    let db = env.d1("DB")?;
    let (rows, total) = d1_repositories::list_user_topups_page(
        &db,
        claims.id,
        page,
        page_size,
        keyword.as_deref(),
        unix_timestamp(),
    )
    .await?;
    Ok(envelope_ok_response(&topups_page(
        rows, total, page, page_size,
    ))?)
}

/// `GET /api/user/topup`: admin list of all topup records.
pub async fn list_topups(req: Request, env: Env) -> WorkerResult<Response> {
    let _claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let keyword = match parse_keyword_pattern(&req) {
        Ok(keyword) => keyword,
        Err(response) => return Ok(response),
    };
    let (page, page_size) = parse_pagination(&req);
    let db = env.d1("DB")?;
    let (rows, total) =
        d1_repositories::list_all_topups_page(&db, page, page_size, keyword.as_deref()).await?;
    Ok(envelope_ok_response(&topups_page(
        rows, total, page, page_size,
    ))?)
}

/// `POST /api/user/topup/complete`: admin manual completion for a pending row.
pub async fn complete_topup(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let payload: CompleteTopupRequest = match read_json_body(&mut req).await {
        Ok(body) => serde_json::from_value(body).unwrap_or_default(),
        Err(response) => return Ok(response),
    };
    let trade_no = payload.trade_no.trim();
    if trade_no.is_empty() {
        return Ok(envelope_error_response(400, "trade_no is required"));
    }

    let db = env.d1("DB")?;
    let Some(before) = d1_repositories::find_topup_by_trade_no(&db, trade_no).await? else {
        return Ok(envelope_error_response(404, "topup not found"));
    };
    match before.status {
        1 => {
            return Ok(envelope_ok_response(&serde_json::json!({
                "trade_no": trade_no,
                "completed": false,
                "status": "success"
            }))?)
        }
        0 => {}
        _ => return Ok(envelope_error_response(400, "topup status is not pending")),
    }

    let now = unix_timestamp();
    let completed = d1_repositories::complete_topup_and_credit(&db, trade_no, now).await?;
    let after = d1_repositories::find_topup_by_trade_no(&db, trade_no)
        .await?
        .unwrap_or(before);
    let _ = d1_repositories::insert_admin_audit_log(
        &db,
        Some(after.user_id),
        None,
        &claims.username,
        "topup.complete",
        &format!("admin {} completed topup {}", claims.username, trade_no),
        &serde_json::json!({
            "trade_no": trade_no,
            "completed": completed,
            "amount": after.amount,
            "money": after.money,
            "payment_method": after.payment_method.clone(),
        }),
        &admin_audit_info(&claims, &req),
        now,
    )
    .await;

    Ok(envelope_ok_response(&serde_json::json!({
        "trade_no": trade_no,
        "completed": completed,
        "status": topup_status_label(after.status),
    }))?)
}

#[derive(Debug, Serialize)]
struct StripePayResponse {
    pay_link: String,
    checkout_url: String,
    session_id: String,
    trade_no: String,
}

#[derive(Debug, Serialize)]
struct TopupInfoResponse {
    enable_online_topup: bool,
    enable_stripe_topup: bool,
    enable_creem_topup: bool,
    enable_waffo_topup: bool,
    enable_waffo_pancake_topup: bool,
    enable_redemption: bool,
    payment_compliance_confirmed: bool,
    payment_compliance_terms_version: String,
    waffo_pay_methods: Value,
    creem_products: Value,
    pay_methods: Vec<Value>,
    min_topup: f64,
    stripe_min_topup: f64,
    waffo_min_topup: f64,
    waffo_pancake_min_topup: f64,
    amount_options: Value,
    discount: Value,
    topup_link: String,
}

#[derive(Debug)]
struct OnlineAmountSettings<'a> {
    min_topup: i64,
    price: Decimal,
    quota_per_unit: Decimal,
    topup_group_ratio: Decimal,
    quota_display_type: &'a str,
    discount: Decimal,
}

#[derive(Debug, Deserialize)]
struct RedemptionRequest {
    key: String,
}

#[derive(Debug, Serialize)]
struct TopupsPage {
    items: Vec<TopupRecord>,
    total: i64,
    page: u32,
    page_size: u32,
}

#[derive(Debug, Serialize)]
struct TopupRecord {
    id: i64,
    user_id: i64,
    amount: i64,
    money: f64,
    trade_no: String,
    payment_method: String,
    payment_provider: String,
    status: String,
    create_time: i64,
    complete_time: i64,
}

#[derive(Debug, Default, Deserialize)]
struct CompleteTopupRequest {
    trade_no: String,
}

#[derive(Debug, Default, Deserialize)]
struct SaveWaffoPancakeConfigRequest {
    #[serde(default)]
    merchant_id: String,
    #[serde(default)]
    private_key: String,
    #[serde(default)]
    return_url: String,
    #[serde(default)]
    store_id: String,
    #[serde(default)]
    product_id: String,
}

#[derive(Debug, Serialize, PartialEq)]
struct WaffoPancakeConfigSaveResponse {
    product_id: String,
    store_id: String,
}

fn waffo_pancake_config_updates(
    payload: &SaveWaffoPancakeConfigRequest,
) -> std::result::Result<Vec<(&'static str, String)>, &'static str> {
    let merchant_id = payload.merchant_id.trim();
    let store_id = payload.store_id.trim();
    let product_id = payload.product_id.trim();
    if merchant_id.is_empty() || store_id.is_empty() || product_id.is_empty() {
        return Err("merchant id, store id, and product id are required");
    }

    let mut updates = vec![
        (WAFFO_PANCAKE_MERCHANT_ID_KEY, merchant_id.to_string()),
        (
            WAFFO_PANCAKE_RETURN_URL_KEY,
            payload.return_url.trim().to_string(),
        ),
        (WAFFO_PANCAKE_STORE_ID_KEY, store_id.to_string()),
        (WAFFO_PANCAKE_PRODUCT_ID_KEY, product_id.to_string()),
    ];
    let private_key = payload.private_key.trim();
    if !private_key.is_empty() {
        updates.push((WAFFO_PANCAKE_PRIVATE_KEY_KEY, private_key.to_string()));
    }
    Ok(updates)
}

fn topups_page(
    rows: Vec<d1_repositories::TopupRow>,
    total: i64,
    page: u32,
    page_size: u32,
) -> TopupsPage {
    TopupsPage {
        items: rows.into_iter().map(topup_record).collect(),
        total,
        page,
        page_size,
    }
}

fn topup_record(row: d1_repositories::TopupRow) -> TopupRecord {
    TopupRecord {
        payment_provider: row.payment_method.clone(),
        status: topup_status_label(row.status).to_string(),
        id: row.id,
        user_id: row.user_id,
        amount: row.amount,
        money: row.money,
        trade_no: row.trade_no,
        payment_method: row.payment_method,
        create_time: row.create_time,
        complete_time: row.complete_time,
    }
}

fn topup_status_label(status: i32) -> &'static str {
    match status {
        0 => "pending",
        1 => "success",
        2 => "failed",
        3 => "expired",
        _ => "pending",
    }
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

fn request_amount(body: &Value) -> f64 {
    body.get("amount")
        .and_then(|value| match value {
            Value::Number(number) => number.as_f64(),
            Value::String(value) => value.trim().parse::<f64>().ok(),
            _ => None,
        })
        .unwrap_or(0.0)
}

fn online_min_topup(settings: &OnlineAmountSettings<'_>) -> i64 {
    if settings
        .quota_display_type
        .eq_ignore_ascii_case(QUOTA_DISPLAY_TYPE_TOKENS)
    {
        (Decimal::from(settings.min_topup) * settings.quota_per_unit)
            .trunc()
            .to_i64()
            .unwrap_or(i64::MAX)
    } else {
        settings.min_topup
    }
}

fn online_pay_money(amount: i64, settings: &OnlineAmountSettings<'_>) -> Decimal {
    let mut display_amount = Decimal::from(amount);
    if settings
        .quota_display_type
        .eq_ignore_ascii_case(QUOTA_DISPLAY_TYPE_TOKENS)
    {
        display_amount /= settings.quota_per_unit;
    }
    display_amount * settings.price * settings.topup_group_ratio * settings.discount
}

fn format_pay_money(value: Decimal) -> String {
    format!("{:.2}", value.to_f64().unwrap_or(0.0))
}

fn topup_group_ratio_for_group(group: &str, raw: Option<&str>) -> Decimal {
    let Some(raw) = raw else {
        return Decimal::ONE;
    };
    let Ok(Value::Object(map)) = serde_json::from_str::<Value>(raw) else {
        return Decimal::ONE;
    };
    map.get(group)
        .and_then(json_decimal)
        .filter(|value| *value > Decimal::ZERO)
        .unwrap_or(Decimal::ONE)
}

fn discount_for_amount(amount: i64, raw: Option<&str>) -> Decimal {
    let Some(raw) = raw else {
        return Decimal::ONE;
    };
    let Ok(Value::Object(map)) = serde_json::from_str::<Value>(raw) else {
        return Decimal::ONE;
    };
    map.get(&amount.to_string())
        .and_then(json_decimal)
        .filter(|value| *value > Decimal::ZERO)
        .unwrap_or(Decimal::ONE)
}

fn json_decimal(value: &Value) -> Option<Decimal> {
    match value {
        Value::Number(number) => number.to_string().parse::<Decimal>().ok(),
        Value::String(value) => value.trim().parse::<Decimal>().ok(),
        _ => None,
    }
}

fn parse_positive_decimal(value: Option<&str>, default: &str) -> Decimal {
    value
        .and_then(|value| value.trim().parse::<Decimal>().ok())
        .filter(|value| *value > Decimal::ZERO)
        .unwrap_or_else(|| {
            default
                .parse::<Decimal>()
                .expect("default decimal constant must parse")
        })
}

fn parse_positive_i64(value: Option<&str>, default: i64) -> i64 {
    value
        .and_then(|value| value.trim().parse::<i64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

fn parse_pagination(req: &Request) -> (u32, u32) {
    let page = parse_query_u32(req, "p").unwrap_or(1).max(1);
    let page_size = parse_query_u32(req, "page_size")
        .or_else(|| parse_query_u32(req, "ps"))
        .or_else(|| parse_query_u32(req, "size"))
        .unwrap_or(10)
        .clamp(1, 100);
    (page, page_size)
}

fn parse_keyword_pattern(req: &Request) -> std::result::Result<Option<String>, Response> {
    let Some(keyword) = parse_query_string(req, "keyword") else {
        return Ok(None);
    };
    sanitize_like_pattern(&keyword)
        .map(Some)
        .map_err(|message| envelope_error_response(400, message))
}

fn parse_query_string(req: &Request, key: &str) -> Option<String> {
    let url = req.url().ok()?;
    let pair = url
        .query_pairs()
        .find(|(k, _)| k == key)?
        .1
        .trim()
        .to_string();
    if pair.is_empty() {
        None
    } else {
        Some(pair)
    }
}

fn parse_query_u32(req: &Request, key: &str) -> Option<u32> {
    parse_query_string(req, key)?.parse::<u32>().ok()
}

fn sanitize_like_pattern(input: &str) -> std::result::Result<String, &'static str> {
    let input = input.trim();
    if input.is_empty() {
        return Err("keyword is empty");
    }

    let mut escaped = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '!' => escaped.push_str("!!"),
            '_' => escaped.push_str("!_"),
            other => escaped.push(other),
        }
    }
    if escaped.contains("%%") {
        return Err("keyword must not contain consecutive % wildcards");
    }
    let wildcard_count = escaped.matches('%').count();
    if wildcard_count > 2 {
        return Err("keyword may contain at most two % wildcards");
    }
    if wildcard_count > 0 {
        let non_wildcard_len = escaped.replace('%', "").chars().count();
        if non_wildcard_len < 2 {
            return Err("fuzzy keyword must contain at least two non-wildcard characters");
        }
    }
    Ok(escaped)
}

fn parse_bool(value: Option<&str>, default: bool) -> bool {
    match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
        Some("true" | "1" | "yes" | "on") => true,
        Some("false" | "0" | "no" | "off") => false,
        _ => default,
    }
}

fn parse_positive_f64(value: Option<&str>, default: f64) -> f64 {
    value
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|value| *value > 0.0)
        .unwrap_or(default)
}

fn parse_json_option(value: Option<&str>, default: Value) -> Value {
    value
        .and_then(|value| serde_json::from_str::<Value>(value).ok())
        .unwrap_or(default)
}

#[cfg(test)]
mod tests {
    use super::{
        discount_for_amount, format_pay_money, online_min_topup, online_pay_money, request_amount,
        sanitize_like_pattern, topup_group_ratio_for_group, topup_status_label,
        waffo_pancake_config_updates, OnlineAmountSettings, SaveWaffoPancakeConfigRequest,
        WAFFO_PANCAKE_MERCHANT_ID_KEY, WAFFO_PANCAKE_PRIVATE_KEY_KEY, WAFFO_PANCAKE_PRODUCT_ID_KEY,
        WAFFO_PANCAKE_RETURN_URL_KEY, WAFFO_PANCAKE_STORE_ID_KEY,
    };
    use rust_decimal::Decimal;

    fn decimal(value: &str) -> Decimal {
        value.parse::<Decimal>().unwrap()
    }

    #[test]
    fn topup_status_labels_match_go_strings() {
        assert_eq!(topup_status_label(0), "pending");
        assert_eq!(topup_status_label(1), "success");
        assert_eq!(topup_status_label(2), "failed");
        assert_eq!(topup_status_label(3), "expired");
        assert_eq!(topup_status_label(99), "pending");
    }

    #[test]
    fn sanitize_like_pattern_escapes_escape_and_underscore() {
        assert_eq!(sanitize_like_pattern("ref_1!").unwrap(), "ref!_1!!");
        assert_eq!(sanitize_like_pattern("ab%").unwrap(), "ab%");
        assert!(sanitize_like_pattern("a%").is_err());
        assert!(sanitize_like_pattern("a%%b").is_err());
        assert!(sanitize_like_pattern("a%b%c%d").is_err());
    }

    #[test]
    fn request_amount_accepts_numbers_and_numeric_strings() {
        assert_eq!(request_amount(&serde_json::json!({"amount": 1.5})), 1.5);
        assert_eq!(request_amount(&serde_json::json!({"amount": "2.25"})), 2.25);
        assert_eq!(request_amount(&serde_json::json!({})), 0.0);
    }

    #[test]
    fn online_amount_matches_go_currency_formula() {
        let settings = OnlineAmountSettings {
            min_topup: 1,
            price: decimal("7.3"),
            quota_per_unit: decimal("500000"),
            topup_group_ratio: decimal("1.5"),
            quota_display_type: "USD",
            discount: decimal("0.9"),
        };

        assert_eq!(online_min_topup(&settings), 1);
        assert_eq!(format_pay_money(online_pay_money(100, &settings)), "985.50");
    }

    #[test]
    fn online_amount_matches_go_tokens_formula() {
        let settings = OnlineAmountSettings {
            min_topup: 1,
            price: decimal("7.3"),
            quota_per_unit: decimal("500000"),
            topup_group_ratio: Decimal::ONE,
            quota_display_type: "TOKENS",
            discount: Decimal::ONE,
        };

        assert_eq!(online_min_topup(&settings), 500_000);
        assert_eq!(
            format_pay_money(online_pay_money(500_000, &settings)),
            "7.30"
        );
    }

    #[test]
    fn online_amount_formats_after_decimal_intermediate_like_go() {
        let settings = OnlineAmountSettings {
            min_topup: 1,
            price: decimal("7.3"),
            quota_per_unit: decimal("500000"),
            topup_group_ratio: decimal("1.3"),
            quota_display_type: "USD",
            discount: decimal("1.5"),
        };

        assert_eq!(online_pay_money(1, &settings), decimal("14.235"));
        assert_eq!(format_pay_money(online_pay_money(1, &settings)), "14.23");
    }

    #[test]
    fn waffo_pancake_amount_matches_go_tokens_formula() {
        let settings = OnlineAmountSettings {
            min_topup: 1,
            price: decimal("1"),
            quota_per_unit: decimal("500000"),
            topup_group_ratio: decimal("1.25"),
            quota_display_type: "TOKENS",
            discount: decimal("0.8"),
        };

        assert_eq!(settings.min_topup, 1);
        assert_eq!(
            format_pay_money(online_pay_money(500_000, &settings)),
            "1.00"
        );
    }

    #[test]
    fn topup_group_ratio_and_discount_accept_numeric_or_string_values() {
        assert_eq!(
            topup_group_ratio_for_group("vip", Some(r#"{"default":1,"vip":"1.2"}"#)),
            decimal("1.2")
        );
        assert_eq!(
            topup_group_ratio_for_group("svip", Some(r#"{"default":1,"svip":1.5}"#)),
            decimal("1.5")
        );
        assert_eq!(
            topup_group_ratio_for_group("missing", Some(r#"{"default":1}"#)),
            Decimal::ONE
        );
        assert_eq!(
            discount_for_amount(100, Some(r#"{"100":"0.9"}"#)),
            decimal("0.9")
        );
        assert_eq!(
            discount_for_amount(200, Some(r#"{"200":0.8}"#)),
            decimal("0.8")
        );
        assert_eq!(discount_for_amount(300, Some(r#"{"300":0}"#)), Decimal::ONE);
    }

    #[test]
    fn waffo_pancake_save_trims_and_keeps_existing_private_key_when_blank() {
        let updates = waffo_pancake_config_updates(&SaveWaffoPancakeConfigRequest {
            merchant_id: " merchant ".to_string(),
            private_key: "   ".to_string(),
            return_url: " https://example.test/return ".to_string(),
            store_id: " store_123 ".to_string(),
            product_id: " prod_456 ".to_string(),
        })
        .unwrap();

        assert_eq!(
            updates,
            vec![
                (WAFFO_PANCAKE_MERCHANT_ID_KEY, "merchant".to_string()),
                (
                    WAFFO_PANCAKE_RETURN_URL_KEY,
                    "https://example.test/return".to_string()
                ),
                (WAFFO_PANCAKE_STORE_ID_KEY, "store_123".to_string()),
                (WAFFO_PANCAKE_PRODUCT_ID_KEY, "prod_456".to_string()),
            ]
        );
    }

    #[test]
    fn waffo_pancake_save_includes_non_blank_private_key() {
        let updates = waffo_pancake_config_updates(&SaveWaffoPancakeConfigRequest {
            merchant_id: "merchant".to_string(),
            private_key: " secret ".to_string(),
            return_url: String::new(),
            store_id: "store".to_string(),
            product_id: "product".to_string(),
        })
        .unwrap();

        assert_eq!(
            updates.last(),
            Some(&(WAFFO_PANCAKE_PRIVATE_KEY_KEY, "secret".to_string()))
        );
    }

    #[test]
    fn waffo_pancake_save_requires_merchant_store_and_product() {
        let missing = SaveWaffoPancakeConfigRequest {
            merchant_id: "merchant".to_string(),
            private_key: String::new(),
            return_url: String::new(),
            store_id: " ".to_string(),
            product_id: "product".to_string(),
        };

        assert_eq!(
            waffo_pancake_config_updates(&missing).unwrap_err(),
            "merchant id, store id, and product id are required"
        );
    }
}
