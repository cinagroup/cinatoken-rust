//! Stripe topup handlers (Scenario C MVP).
//!
//! Wallet/topup routes:
//! - `POST /api/user/stripe/pay` creates a Stripe Checkout Session and returns
//!   the frontend-compatible payment link. UserAuth.
//! - `POST /api/user/stripe/amount` estimates the Stripe charge amount.
//! - `POST /api/user/pay` creates an Epay-compatible pending topup order and
//!   returns the signed form action/params. UserAuth.
//! - `POST /api/user/amount` estimates legacy online/Epay-style charge amount.
//! - `POST /api/user/waffo-pancake/amount` estimates Waffo Pancake charge amount.
//! - `POST /api/user/waffo-pancake/pay` creates a Waffo Pancake checkout session.
//! - `POST /api/option/waffo-pancake/catalog` lists Waffo Pancake stores/products.
//! - `POST /api/option/waffo-pancake/pair` creates a Waffo Pancake store/product pair.
//! - `POST /api/option/waffo-pancake/save` persists Waffo Pancake admin config.
//! - `POST /api/option/waffo-pancake/subscription-product` creates a plan product.
//! - `POST /api/option/waffo-pancake/subscription-product-options` lists saved-store products.
//! - `POST /api/stripe/webhook` verifies Stripe events and credits quota.
//! - `POST /api/waffo-pancake/webhook/:env` verifies Waffo Pancake events and credits quota.
//! - `GET/POST /api/user/epay/notify` verifies Epay callbacks and credits quota.
//! - `GET /api/user/topup/info` exposes implemented payment capabilities.
//! - `POST /api/user/topup` redeems a public redemption code.
//! - `GET /api/user/topup/self` lists the current user's recent topups.
//! - `GET /api/user/topup` lists all topups for admins.
//! - `POST /api/user/topup/complete` manually completes a pending topup.

use std::collections::BTreeMap;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use cinatoken_auth::USER_STATUS_DISABLED;
use cinatoken_payments::{
    verify_stripe_webhook, StripeWebhookError, STRIPE_WEBHOOK_TOLERANCE_SECONDS,
};
use futures_util::{
    future::{select, Either},
    TryStreamExt,
};
use rsa::pkcs1::{DecodeRsaPrivateKey, DecodeRsaPublicKey};
use rsa::pkcs1v15::{Signature as RsaSignature, SigningKey, VerifyingKey};
use rsa::pkcs8::{DecodePrivateKey, DecodePublicKey};
use rsa::signature::{SignatureEncoding, Signer, Verifier};
use rsa::{RsaPrivateKey, RsaPublicKey};
use rust_decimal::prelude::ToPrimitive;
use rust_decimal::Decimal;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use worker::{
    AbortController, Delay, Env, Fetch, Headers, Method, Request, RequestInit, RequestRedirect,
    Response, Result as WorkerResult,
};

use crate::admin::{
    admin_audit_info, envelope_error_response, envelope_ok_response, read_json_body,
    require_admin_auth, require_root_auth, require_user_auth, unix_timestamp,
};
use crate::d1_repositories;
use crate::set_cors_headers;

const CURRENT_COMPLIANCE_TERMS_VERSION: &str = "v1";
const PAYMENT_COMPLIANCE_CONFIRMED_KEY: &str = "payment_setting.compliance_confirmed";
const PAYMENT_COMPLIANCE_TERMS_KEY: &str = "payment_setting.compliance_terms_version";
const PAYMENT_AMOUNT_OPTIONS_KEY: &str = "payment_setting.amount_options";
const PAYMENT_AMOUNT_DISCOUNT_KEY: &str = "payment_setting.amount_discount";
const GENERAL_QUOTA_DISPLAY_TYPE_KEY: &str = "general_setting.quota_display_type";
const PRICE_KEY: &str = "Price";
const QUOTA_PER_UNIT_KEY: &str = "QuotaPerUnit";
const TOPUP_GROUP_RATIO_KEY: &str = "TopupGroupRatio";
const PAY_ADDRESS_KEY: &str = "PayAddress";
const EPAY_ID_KEY: &str = "EpayId";
const EPAY_KEY_KEY: &str = "EpayKey";
const PAY_METHODS_KEY: &str = "PayMethods";
const CUSTOM_CALLBACK_ADDRESS_KEY: &str = "CustomCallbackAddress";
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
const PAYMENT_PROVIDER_STRIPE: &str = "stripe";
const PAYMENT_PROVIDER_EPAY: &str = "epay";
const PAYMENT_PROVIDER_WAFFO_PANCAKE: &str = "waffo_pancake";
const TOPUP_STATUS_SUCCESS: i32 = 1;
const TOPUP_STATUS_FAILED: i32 = 2;
const EPAY_SUBMIT_PATH: &str = "/submit.php";
const EPAY_NOTIFY_BODY_LIMIT_BYTES: usize = 16 * 1024;
const EPAY_RETURN_PATH: &str = "/usage-logs";
const WAFFO_PANCAKE_API_BASE_URL: &str = "https://api.waffo.ai";
const WAFFO_PANCAKE_GRAPHQL_URL: &str = "https://api.waffo.ai/v1/graphql";
const WAFFO_PANCAKE_GRAPHQL_PATH: &str = "/v1/graphql";
const WAFFO_PANCAKE_CREATE_STORE_PATH: &str = "/v1/actions/store/create-store";
const WAFFO_PANCAKE_CREATE_ONETIME_PRODUCT_PATH: &str =
    "/v1/actions/onetime-product/create-product";
const WAFFO_PANCAKE_PUBLISH_ONETIME_PRODUCT_PATH: &str =
    "/v1/actions/onetime-product/publish-product";
const WAFFO_PANCAKE_ISSUE_SESSION_TOKEN_PATH: &str = "/v1/actions/auth/issue-session-token";
const WAFFO_PANCAKE_CREATE_CHECKOUT_SESSION_PATH: &str = "/v1/actions/checkout/create-session";
const WAFFO_PANCAKE_FETCH_TIMEOUT: Duration = Duration::from_secs(12);
const WAFFO_PANCAKE_GRAPHQL_RESPONSE_LIMIT_BYTES: usize = 512 * 1024;
const WAFFO_PANCAKE_ADMIN_BODY_LIMIT_BYTES: usize = 64 * 1024;
const WAFFO_PANCAKE_WEBHOOK_BODY_LIMIT_BYTES: usize = 64 * 1024;
const WAFFO_PANCAKE_WEBHOOK_TOLERANCE_MS: u64 = 5 * 60 * 1000;
const WAFFO_PANCAKE_CHECKOUT_EXPIRES_SECONDS: i32 = 45 * 60;
const DEFAULT_WAFFO_PANCAKE_STORE_NAME: &str = "cinatoken-store";
const DEFAULT_WAFFO_PANCAKE_PRODUCT_NAME: &str = "cinatoken-charge-product";
const WAFFO_PANCAKE_TAX_CATEGORY_SAAS: &str = "saas";
const WAFFO_PANCAKE_BUILTIN_TEST_PUBLIC_KEY: &str = r#"-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxnmRY6yMMA3lVqmAU6ZG
b1sjL/+r/z6E+ZjkXaDAKiqOhk9rpazni0bNsGXwmftTPk9jy2wn+j6JHODD/WH/
SCnSfvKkLIjy4Hk7BuCgB174C0ydan7J+KgXLkOwgCAxxB68t2tezldwo74ZpXgn
F49opzMvQ9prEwIAWOE+kV9iK6gx/AckSMtHIHpUesoPDkldpmFHlB2qpf1vsFTZ
5kD6DmGl+2GIVK01aChy2lk8pLv0yUMu18v44sLkO5M44TkGPJD9qG09wrvVG2wp
OTVCn1n5pP8P+HRLcgzbUB3OlZVfdFurn6EZwtyL4ZD9kdkQ4EZE/9inKcp3c1h4
xwIDAQAB
-----END PUBLIC KEY-----"#;
const WAFFO_PANCAKE_BUILTIN_PROD_PUBLIC_KEY: &str = r#"-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAz+xApdTIb4ua+DgZKQ54
iBsD82ybyhGCLRETONW4Jgbb3A8DUM1LqBk6r/CmTOCHqLalTQHNigvP3R5zkDNX
iRJz6gA4MJ/+8K0+mnEE2RISQzN+Qu65TNd6svb+INm/kMaftY4uIXr6y6kchtTJ
dwnQhcKdAL2v7h7IFnkVelQsKxDdb2PqX8xX/qwd01iXvMcpCCaXovUwZsxH2QN5
ZKBTseJivbhUeyJCco4fdUyxOMHe2ybCVhyvim2uxAl1nkvL5L8RCWMCAV55LLo0
9OhmLahz/DYNu13YLVP6dvIT09ZFBYU6Owj1NxdinTynlJCFS9VYwBgmftosSE1U
dwIDAQAB
-----END PUBLIC KEY-----"#;
const WAFFO_PANCAKE_CATALOG_QUERY: &str = r#"query {
    stores(limit: 100) {
        id
        name
        status
        prodEnabled
        onetimeProducts {
            id
            name
            status
        }
    }
}"#;
const TOPUP_INFO_OPTION_KEYS: &[&str] = &[
    PAYMENT_COMPLIANCE_CONFIRMED_KEY,
    PAYMENT_COMPLIANCE_TERMS_KEY,
    "MinTopUp",
    "StripeMinTopUp",
    PAYMENT_AMOUNT_OPTIONS_KEY,
    PAYMENT_AMOUNT_DISCOUNT_KEY,
    "TopUpLink",
    PAY_ADDRESS_KEY,
    EPAY_ID_KEY,
    EPAY_KEY_KEY,
    PAY_METHODS_KEY,
    WAFFO_PANCAKE_MERCHANT_ID_KEY,
    WAFFO_PANCAKE_PRIVATE_KEY_KEY,
    WAFFO_PANCAKE_PRODUCT_ID_KEY,
    WAFFO_PANCAKE_MIN_TOPUP_KEY,
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
const EPAY_TOPUP_OPTION_KEYS: &[&str] = &[
    PAYMENT_COMPLIANCE_CONFIRMED_KEY,
    PAYMENT_COMPLIANCE_TERMS_KEY,
    "MinTopUp",
    PRICE_KEY,
    QUOTA_PER_UNIT_KEY,
    TOPUP_GROUP_RATIO_KEY,
    GENERAL_QUOTA_DISPLAY_TYPE_KEY,
    PAYMENT_AMOUNT_DISCOUNT_KEY,
    PAY_ADDRESS_KEY,
    EPAY_ID_KEY,
    EPAY_KEY_KEY,
    PAY_METHODS_KEY,
    CUSTOM_CALLBACK_ADDRESS_KEY,
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
const WAFFO_PANCAKE_TOPUP_OPTION_KEYS: &[&str] = &[
    PAYMENT_COMPLIANCE_CONFIRMED_KEY,
    PAYMENT_COMPLIANCE_TERMS_KEY,
    WAFFO_PANCAKE_MIN_TOPUP_KEY,
    WAFFO_PANCAKE_UNIT_PRICE_KEY,
    QUOTA_PER_UNIT_KEY,
    TOPUP_GROUP_RATIO_KEY,
    GENERAL_QUOTA_DISPLAY_TYPE_KEY,
    PAYMENT_AMOUNT_DISCOUNT_KEY,
    WAFFO_PANCAKE_MERCHANT_ID_KEY,
    WAFFO_PANCAKE_PRIVATE_KEY_KEY,
    WAFFO_PANCAKE_PRODUCT_ID_KEY,
];
const WAFFO_PANCAKE_CREDENTIAL_OPTION_KEYS: &[&str] =
    &[WAFFO_PANCAKE_MERCHANT_ID_KEY, WAFFO_PANCAKE_PRIVATE_KEY_KEY];
const WAFFO_PANCAKE_SUBSCRIPTION_OPTIONS_KEYS: &[&str] = &[
    WAFFO_PANCAKE_MERCHANT_ID_KEY,
    WAFFO_PANCAKE_PRIVATE_KEY_KEY,
    WAFFO_PANCAKE_STORE_ID_KEY,
];
const WAFFO_PANCAKE_SUBSCRIPTION_PRODUCT_KEYS: &[&str] = &[
    WAFFO_PANCAKE_MERCHANT_ID_KEY,
    WAFFO_PANCAKE_PRIVATE_KEY_KEY,
    WAFFO_PANCAKE_STORE_ID_KEY,
    WAFFO_PANCAKE_RETURN_URL_KEY,
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
    let rand_suffix = match random_base62(8) {
        Some(value) => value,
        None => {
            return Ok(envelope_error_response(
                500,
                "failed to generate topup order id",
            ));
        }
    };
    let trade_no = format!("ref_{}{}{}", claims.id, now, rand_suffix);

    // Persist the pending top-up BEFORE creating the Stripe session, and abort
    // if it fails: a paid checkout must always have a creditable record. An
    // orphaned pending row (if the Stripe call below fails) is harmless; a
    // paid-but-missing row is an unrecoverable missed credit.
    if let Err(err) = d1_repositories::create_topup(
        &db,
        claims.id,
        quota,
        amount,
        &trade_no,
        PAYMENT_PROVIDER_STRIPE,
        PAYMENT_PROVIDER_STRIPE,
        now,
    )
    .await
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

/// `POST /api/user/pay`: create a legacy Epay-compatible topup order.
pub async fn epay_pay(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let frontend_base = match resolve_frontend_base_url(&env, &req) {
        Ok(base) => base,
        Err(message) => return Ok(epay_error_response(&message)?),
    };
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let amount = request_amount(&body);
    if !amount.is_finite() || amount <= 0.0 || amount.fract() != 0.0 || amount > i64::MAX as f64 {
        return Ok(epay_error_response("amount must be a positive integer")?);
    }
    let amount = amount as i64;
    let payment_method = body
        .get("payment_method")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if payment_method.is_empty() {
        return Ok(epay_error_response("payment method is required")?);
    }

    let db = env.d1("DB")?;
    let values = d1_repositories::option_values(&db, EPAY_TOPUP_OPTION_KEYS).await?;
    let compliance_confirmed = parse_bool(values[0].as_deref(), false)
        && values[1].as_deref().unwrap_or("") == CURRENT_COMPLIANCE_TERMS_VERSION;
    if !compliance_confirmed {
        return Ok(epay_error_response("payment compliance is not confirmed")?);
    }
    let Some(user) = d1_repositories::find_user_by_id(&db, claims.id).await? else {
        return Ok(epay_error_response("user not found")?);
    };
    if user.status == USER_STATUS_DISABLED {
        return Ok(epay_error_response("user is disabled")?);
    }

    let pay_methods = parse_payment_methods(values[11].as_deref());
    if !epay_payment_method_allowed(payment_method, &pay_methods) {
        return Ok(epay_error_response("payment method does not exist")?);
    }
    let config = match epay_config_from_values(&values[8], &values[9], &values[10]) {
        Some(config) => config,
        None => return Ok(epay_error_response("Epay payment is not configured")?),
    };

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
        return Ok(epay_error_response(&format!(
            "topup amount cannot be less than {min_topup}"
        ))?);
    }
    let pay_money = online_pay_money(amount, &settings);
    if pay_money <= Decimal::new(1, 2) {
        return Ok(epay_error_response("payment amount is too small")?);
    }
    let credit_quota = epay_credit_quota(amount, &settings);
    if credit_quota <= 0 {
        return Ok(epay_error_response("credited quota is too small")?);
    }

    let callback_base = match resolve_callback_base_url(&env, &req, values[12].as_deref()) {
        Ok(base) => base,
        Err(message) => return Ok(epay_error_response(&message)?),
    };
    let notify_url = join_url_path(&callback_base, "/api/user/epay/notify");
    let return_url = join_url_path(&frontend_base, EPAY_RETURN_PATH);
    let now = unix_timestamp();
    let trade_no = match epay_trade_no(claims.id, now) {
        Some(value) => value,
        None => return Ok(epay_error_response("failed to generate order id")?),
    };
    let money = format_pay_money(pay_money);
    let submit_url = match epay_submit_url(&config.pay_address) {
        Ok(url) => url,
        Err(message) => return Ok(epay_error_response(&message)?),
    };
    let params = epay_purchase_params(EpayPurchaseInput {
        partner_id: &config.partner_id,
        key: &config.key,
        payment_method,
        trade_no: &trade_no,
        name: &format!("TUC{amount}"),
        money: &money,
        notify_url: &notify_url,
        return_url: &return_url,
    });

    if let Err(err) = d1_repositories::create_topup(
        &db,
        claims.id,
        credit_quota,
        money.parse::<f64>().unwrap_or(0.0),
        &trade_no,
        payment_method,
        PAYMENT_PROVIDER_EPAY,
        now,
    )
    .await
    {
        worker::console_error!("failed to record Epay pending topup {trade_no}: {err}");
        return Ok(epay_error_response("failed to create topup order")?);
    }

    let _ = d1_repositories::insert_admin_audit_log(
        &db,
        Some(claims.id),
        None,
        "user",
        "topup.epay.create",
        &format!(
            "user {} created Epay topup {} via {}",
            claims.username, trade_no, payment_method
        ),
        &serde_json::json!({
            "trade_no": trade_no,
            "amount": amount,
            "credit_quota": credit_quota,
            "money": money,
            "payment_method": payment_method,
        }),
        &admin_audit_info(&claims, &req),
        now,
    )
    .await;

    epay_success_response(&submit_url, &params)
}

/// `GET/POST /api/user/epay/notify`: verify Epay callback and credit topup.
pub async fn epay_notify(mut req: Request, env: Env) -> WorkerResult<Response> {
    let db = env.d1("DB")?;
    let values = d1_repositories::option_values(
        &db,
        &[
            PAYMENT_COMPLIANCE_CONFIRMED_KEY,
            PAYMENT_COMPLIANCE_TERMS_KEY,
            PAY_ADDRESS_KEY,
            EPAY_ID_KEY,
            EPAY_KEY_KEY,
            PAY_METHODS_KEY,
        ],
    )
    .await?;
    let compliance_confirmed = parse_bool(values[0].as_deref(), false)
        && values[1].as_deref().unwrap_or("") == CURRENT_COMPLIANCE_TERMS_VERSION;
    let config = epay_config_from_values(&values[2], &values[3], &values[4]);
    let pay_methods = parse_payment_methods(values[5].as_deref());
    if !compliance_confirmed || config.is_none() || pay_methods.is_empty() {
        worker::console_warn!("Epay notify rejected: payment is not enabled");
        return Response::ok("fail");
    }
    let config = config.expect("checked above");
    let params = match epay_notify_params(&mut req).await {
        Ok(params) => params,
        Err(message) => {
            worker::console_warn!("Epay notify rejected: {message}");
            return Response::ok("fail");
        }
    };
    if params.is_empty() {
        worker::console_warn!("Epay notify rejected: empty params");
        return Response::ok("fail");
    }
    let Some(info) = verify_epay_notify(&params, &config.key) else {
        worker::console_warn!("Epay notify signature verification failed");
        return Response::ok("fail");
    };

    if info.trade_status != "TRADE_SUCCESS" {
        let raw = serde_json::to_string(&params).unwrap_or_default();
        let event_id = epay_event_id(&info);
        let _ = d1_repositories::insert_payment_event(
            &db,
            PAYMENT_PROVIDER_EPAY,
            &event_id,
            &info.out_trade_no,
            "ignored",
            &raw,
            unix_timestamp(),
        )
        .await;
        return Response::ok("success");
    }

    let expected_money = info.money.trim().parse::<f64>().unwrap_or(-1.0);
    if expected_money < 0.0 {
        worker::console_warn!(
            "Epay notify rejected invalid money for trade_no={}",
            info.out_trade_no
        );
        return Response::ok("fail");
    }
    let now = unix_timestamp();
    let credit_result = d1_repositories::complete_topup_and_credit_for_provider(
        &db,
        &info.out_trade_no,
        PAYMENT_PROVIDER_EPAY,
        &info.payment_method,
        expected_money,
        now,
    )
    .await?;
    let raw = serde_json::to_string(&params).unwrap_or_default();
    let event_id = epay_event_id(&info);
    let _ = d1_repositories::insert_payment_event(
        &db,
        PAYMENT_PROVIDER_EPAY,
        &event_id,
        &info.out_trade_no,
        "paid",
        &raw,
        now,
    )
    .await;

    if credit_result.credited_now() {
        if let Some(topup) =
            d1_repositories::find_topup_by_trade_no(&db, &info.out_trade_no).await?
        {
            let _ = d1_repositories::insert_admin_audit_log(
                &db,
                Some(topup.user_id),
                None,
                "system",
                "topup.credit",
                &format!(
                    "Epay topup {} credited {} quota ({} paid)",
                    topup.trade_no, topup.amount, topup.money
                ),
                &serde_json::json!({
                    "trade_no": topup.trade_no,
                    "amount": topup.amount,
                    "money": topup.money,
                    "payment_method": topup.payment_method,
                    "payment_provider": PAYMENT_PROVIDER_EPAY,
                }),
                &d1_repositories::AdminAuditInfo {
                    admin_id: 0,
                    admin_username: "epay-notify".to_string(),
                    admin_role: 0,
                    auth_method: "webhook".to_string(),
                    ip: String::new(),
                },
                now,
            )
            .await;
        }
    } else if let Some(topup) =
        d1_repositories::find_topup_by_trade_no(&db, &info.out_trade_no).await?
    {
        if !is_completed_epay_replay(&topup, &info, expected_money) {
            worker::console_warn!(
                "Epay notify verified but did not credit trade_no={} type={} money={} status={} credited={} provider={}",
                info.out_trade_no,
                info.payment_method,
                info.money,
                topup.status,
                topup.credited,
                topup.payment_provider
            );
            return Response::ok("fail");
        }
    } else {
        worker::console_warn!(
            "Epay notify verified but topup was not found trade_no={} type={} money={}",
            info.out_trade_no,
            info.payment_method,
            info.money
        );
        return Response::ok("fail");
    }

    Response::ok("success")
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
    if pay_money < Decimal::new(1, 2) {
        return Ok(envelope_error_response(400, "amount is too small"));
    }

    Ok(envelope_ok_response(&format_pay_money(pay_money))?)
}

/// `POST /api/user/waffo-pancake/pay`: create a Waffo Pancake checkout session.
pub async fn waffo_pancake_pay(mut req: Request, env: Env) -> WorkerResult<Response> {
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
        return waffo_pancake_error_message_response(200, "amount must be a positive integer");
    }
    let amount = amount as i64;

    let db = env.d1("DB")?;
    let values = d1_repositories::option_values(&db, WAFFO_PANCAKE_TOPUP_OPTION_KEYS).await?;
    let compliance_confirmed = parse_bool(values[0].as_deref(), false)
        && values[1].as_deref().unwrap_or("") == CURRENT_COMPLIANCE_TERMS_VERSION;
    if !compliance_confirmed {
        return waffo_pancake_error_message_response(200, "payment compliance is not confirmed");
    }
    let creds = match waffo_pancake_creds_from_parts(
        values[8].as_deref().unwrap_or_default(),
        values[9].as_deref().unwrap_or_default(),
    ) {
        Ok(creds) => creds,
        Err(message) => return waffo_pancake_error_message_response(200, message),
    };
    let product_id = values[10].as_deref().unwrap_or_default().trim();
    if let Err(message) = validate_waffo_pancake_short_id("productId", product_id, "PROD") {
        return waffo_pancake_error_message_response(200, &message);
    }

    let Some(user) = d1_repositories::find_user_by_id(&db, claims.id).await? else {
        return waffo_pancake_error_message_response(200, "user not found");
    };
    if user.status == USER_STATUS_DISABLED {
        return waffo_pancake_error_message_response(200, "user is disabled");
    }

    let min_topup = parse_positive_i64(values[2].as_deref(), 1);
    if amount < min_topup {
        return waffo_pancake_error_message_response(200, &format!("minimum topup is {min_topup}"));
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
    if pay_money < Decimal::new(1, 2) {
        return waffo_pancake_error_message_response(200, "payment amount is too small");
    }
    let credit_quota = waffo_pancake_credit_quota(amount, &settings);
    if credit_quota <= 0 {
        return waffo_pancake_error_message_response(200, "credited quota is too small");
    }

    let money = format_pay_money(pay_money);
    let money_value = money.parse::<f64>().unwrap_or(0.0);
    let now = unix_timestamp();
    let trade_no = match waffo_pancake_trade_no(claims.id) {
        Some(value) => value,
        None => return waffo_pancake_error_message_response(200, "failed to generate order id"),
    };

    if let Err(err) = d1_repositories::create_topup(
        &db,
        claims.id,
        credit_quota,
        money_value,
        &trade_no,
        PAYMENT_PROVIDER_WAFFO_PANCAKE,
        PAYMENT_PROVIDER_WAFFO_PANCAKE,
        now,
    )
    .await
    {
        worker::console_error!("failed to record Waffo Pancake pending topup {trade_no}: {err}");
        return waffo_pancake_error_message_response(200, "failed to create topup order");
    }

    let buyer_identity = waffo_pancake_buyer_identity(claims.id);
    let buyer_email = optional_waffo_pancake_string(&user.email);
    let session = match create_waffo_pancake_checkout_session(
        &creds,
        product_id,
        &buyer_identity,
        buyer_email.as_deref(),
        &money,
        &trade_no,
    )
    .await
    {
        Ok(session) => session,
        Err(err) => {
            worker::console_error!(
                "failed to create Waffo Pancake checkout session user_id={} trade_no={} error={}",
                claims.id,
                trade_no,
                err
            );
            let _ = d1_repositories::update_pending_topup_status_for_provider(
                &db,
                &trade_no,
                PAYMENT_PROVIDER_WAFFO_PANCAKE,
                TOPUP_STATUS_FAILED,
            )
            .await;
            return waffo_pancake_error_message_response(200, "failed to create checkout session");
        }
    };

    let _ = d1_repositories::insert_admin_audit_log(
        &db,
        Some(claims.id),
        None,
        "user",
        "topup.waffo_pancake.create",
        &format!(
            "user {} created Waffo Pancake topup {}",
            claims.username, trade_no
        ),
        &serde_json::json!({
            "trade_no": trade_no,
            "amount": amount,
            "credit_quota": credit_quota,
            "money": money,
            "session_id": session.session_id,
        }),
        &admin_audit_info(&claims, &req),
        now,
    )
    .await;

    waffo_pancake_ok_response(&session)
}

/// `POST /api/option/waffo-pancake/catalog`: read Waffo Pancake store/product catalog.
///
/// Mirrors Go's credential resolution: body credentials are used when present;
/// when both body fields are blank, persisted option values are used.
pub async fn list_waffo_pancake_catalog(mut req: Request, env: Env) -> WorkerResult<Response> {
    let _claims = match require_root_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let body = match read_optional_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let payload: WaffoPancakeCredsRequest = match serde_json::from_value(body) {
        Ok(payload) => payload,
        Err(err) => {
            return waffo_pancake_error_message_response(
                200,
                &format!("invalid Waffo Pancake catalog request: {err}"),
            );
        }
    };
    let db = env.d1("DB")?;
    let creds =
        match resolve_waffo_pancake_admin_creds(&db, &payload.merchant_id, &payload.private_key)
            .await?
        {
            Ok(creds) => creds,
            Err(message) => return waffo_pancake_error_message_response(200, message),
        };

    match fetch_waffo_pancake_catalog(&creds).await {
        Ok(catalog) => waffo_pancake_ok_response(&catalog),
        Err(err) => {
            worker::console_warn!("failed to fetch Waffo Pancake catalog: {err}");
            waffo_pancake_error_message_response(200, "failed to fetch Waffo Pancake catalog")
        }
    }
}

/// `POST /api/option/waffo-pancake/pair`: create Waffo Pancake store/product pair.
pub async fn create_waffo_pancake_pair(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_root_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let body = match read_optional_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let payload: CreateWaffoPancakePairRequest = match serde_json::from_value(body) {
        Ok(payload) => payload,
        Err(err) => {
            return waffo_pancake_error_message_response(
                200,
                &format!("invalid Waffo Pancake pair request: {err}"),
            );
        }
    };
    let db = env.d1("DB")?;
    let creds =
        match resolve_waffo_pancake_admin_creds(&db, &payload.merchant_id, &payload.private_key)
            .await?
        {
            Ok(creds) => creds,
            Err(message) => return waffo_pancake_error_message_response(200, message),
        };

    let result = create_waffo_pancake_primary_pair(&creds, &payload.return_url).await;
    match result {
        Ok(pair) => {
            let _ = d1_repositories::insert_admin_audit_log(
                &db,
                None,
                None,
                &claims.username,
                "option.waffo_pancake.pair.create",
                &format!("admin {} created Waffo Pancake pair", claims.username),
                &serde_json::json!({
                    "store_id": pair.store_id.as_str(),
                    "product_id": pair.product_id.as_str(),
                }),
                &admin_audit_info(&claims, &req),
                unix_timestamp(),
            )
            .await;
            waffo_pancake_ok_response(&pair)
        }
        Err(WaffoPancakePairError::Store(error)) => {
            worker::console_warn!("failed to create Waffo Pancake store: {error}");
            waffo_pancake_error_response(
                200,
                &serde_json::json!({
                    "error": error,
                }),
            )
        }
        Err(WaffoPancakePairError::OrphanStore { store_id, error }) => {
            worker::console_warn!(
                "created Waffo Pancake store but failed to create product: store_id={store_id} error={error}"
            );
            let _ = d1_repositories::insert_admin_audit_log(
                &db,
                None,
                None,
                &claims.username,
                "option.waffo_pancake.pair.orphan_store",
                &format!(
                    "admin {} created Waffo Pancake store but product creation failed",
                    claims.username
                ),
                &serde_json::json!({
                    "store_id": store_id.as_str(),
                    "orphan_store": true,
                }),
                &admin_audit_info(&claims, &req),
                unix_timestamp(),
            )
            .await;
            waffo_pancake_error_response(
                200,
                &serde_json::json!({
                    "error": error,
                    "store_id": store_id,
                    "store_name": DEFAULT_WAFFO_PANCAKE_STORE_NAME,
                    "orphan_store": true,
                }),
            )
        }
    }
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
            return waffo_pancake_error_message_response(
                200,
                &format!("invalid Waffo Pancake config request: {err}"),
            );
        }
    };
    let updates = match waffo_pancake_config_updates(&payload) {
        Ok(updates) => updates,
        Err(message) => return waffo_pancake_error_message_response(200, message),
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

    waffo_pancake_ok_response(&WaffoPancakeConfigSaveResponse {
        product_id,
        store_id,
    })
}

/// `POST /api/option/waffo-pancake/subscription-product`: create a plan product.
pub async fn create_waffo_pancake_subscription_product(
    mut req: Request,
    env: Env,
) -> WorkerResult<Response> {
    let claims = match require_root_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let payload: CreateWaffoPancakeSubscriptionProductRequest = match serde_json::from_value(body) {
        Ok(payload) => payload,
        Err(err) => {
            return waffo_pancake_error_message_response(
                200,
                &format!("invalid Waffo Pancake subscription product request: {err}"),
            );
        }
    };
    let name = payload.name.trim();
    if name.is_empty() {
        return waffo_pancake_error_message_response(200, "plan name is required");
    }
    let amount = payload.amount.trim();
    if amount.is_empty() {
        return waffo_pancake_error_message_response(200, "plan price is required");
    }

    let db = env.d1("DB")?;
    let values =
        d1_repositories::option_values(&db, WAFFO_PANCAKE_SUBSCRIPTION_PRODUCT_KEYS).await?;
    let merchant_id = values[0].clone().unwrap_or_default();
    let private_key = values[1].clone().unwrap_or_default();
    let store_id = values[2].clone().unwrap_or_default();
    let return_url = values[3].clone().unwrap_or_default();
    let creds = match waffo_pancake_creds_from_parts(&merchant_id, &private_key) {
        Ok(creds) => creds,
        Err(_) => {
            return waffo_pancake_error_message_response(
                200,
                "Waffo Pancake is not fully configured",
            );
        }
    };
    let store_id = store_id.trim();
    if store_id.is_empty() {
        return waffo_pancake_error_message_response(200, "Waffo Pancake is not fully configured");
    }

    match create_waffo_pancake_product_for_plan(&creds, store_id, name, amount, &return_url).await {
        Ok(product_id) => {
            let _ = d1_repositories::insert_admin_audit_log(
                &db,
                None,
                None,
                &claims.username,
                "option.waffo_pancake.subscription_product.create",
                &format!(
                    "admin {} created Waffo Pancake subscription product",
                    claims.username
                ),
                &serde_json::json!({
                    "store_id": store_id,
                    "product_id": product_id.as_str(),
                    "product_name": name,
                }),
                &admin_audit_info(&claims, &req),
                unix_timestamp(),
            )
            .await;
            waffo_pancake_ok_response(&WaffoPancakeSubscriptionProductCreateResponse {
                product_id,
                product_name: name.to_string(),
                store_id: store_id.to_string(),
            })
        }
        Err(err) => {
            worker::console_warn!(
                "failed to create Waffo Pancake subscription product: store_id={store_id} name={name} error={err}"
            );
            waffo_pancake_error_message_response(200, "failed to create Waffo Pancake product")
        }
    }
}

/// `POST /api/option/waffo-pancake/subscription-product-options`: list products in saved store.
pub async fn list_waffo_pancake_subscription_product_options(
    req: Request,
    env: Env,
) -> WorkerResult<Response> {
    let _claims = match require_root_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let db = env.d1("DB")?;
    let values =
        d1_repositories::option_values(&db, WAFFO_PANCAKE_SUBSCRIPTION_OPTIONS_KEYS).await?;
    let merchant_id = values[0].clone().unwrap_or_default();
    let private_key = values[1].clone().unwrap_or_default();
    let store_id = values[2].clone().unwrap_or_default();
    let creds = match waffo_pancake_creds_from_parts(&merchant_id, &private_key) {
        Ok(creds) => creds,
        Err(_) => {
            return waffo_pancake_error_message_response(
                200,
                "Waffo Pancake is not fully configured",
            );
        }
    };
    let store_id = store_id.trim();
    if store_id.is_empty() {
        return waffo_pancake_error_message_response(200, "Waffo Pancake is not fully configured");
    }

    match fetch_waffo_pancake_catalog(&creds).await {
        Ok(catalog) => {
            waffo_pancake_ok_response(&waffo_pancake_subscription_options(&catalog, store_id))
        }
        Err(err) => {
            worker::console_warn!("failed to fetch Waffo Pancake subscription products: {err}");
            waffo_pancake_error_message_response(200, "failed to fetch Waffo Pancake products")
        }
    }
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

/// `POST /api/waffo-pancake/webhook/:env`: verify Waffo Pancake and credit quota.
pub async fn waffo_pancake_webhook(
    mut req: Request,
    env: Env,
    expected_env: Option<&String>,
) -> WorkerResult<Response> {
    let expected_env = expected_env
        .map(String::as_str)
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if expected_env != "test" && expected_env != "prod" {
        return Ok(Response::error("unknown env", 404)?);
    }

    let db = env.d1("DB")?;
    let values = d1_repositories::option_values(
        &db,
        &[
            PAYMENT_COMPLIANCE_CONFIRMED_KEY,
            PAYMENT_COMPLIANCE_TERMS_KEY,
            WAFFO_PANCAKE_MERCHANT_ID_KEY,
            WAFFO_PANCAKE_PRIVATE_KEY_KEY,
            WAFFO_PANCAKE_PRODUCT_ID_KEY,
        ],
    )
    .await?;
    let compliance_confirmed = parse_bool(values[0].as_deref(), false)
        && values[1].as_deref().unwrap_or("") == CURRENT_COMPLIANCE_TERMS_VERSION;
    let gateway_configured = waffo_pancake_topup_configured(
        values[2].as_deref().unwrap_or_default(),
        values[3].as_deref().unwrap_or_default(),
        values[4].as_deref().unwrap_or_default(),
    );
    if !compliance_confirmed || !gateway_configured {
        worker::console_warn!("Waffo Pancake webhook rejected: gateway disabled");
        return Ok(Response::error("webhook disabled", 403)?);
    }

    let signature = req
        .headers()
        .get("X-Waffo-Signature")
        .ok()
        .flatten()
        .unwrap_or_default();
    if let Err(message) = validate_waffo_pancake_webhook_content_length(
        req.headers().get("Content-Length").ok().flatten(),
    ) {
        let status = if message.contains("too large") {
            413
        } else {
            400
        };
        worker::console_warn!("Waffo Pancake webhook rejected: {message}");
        return Ok(Response::error(&message, status)?);
    }
    let payload_bytes = req.bytes().await?;
    if payload_bytes.len() > WAFFO_PANCAKE_WEBHOOK_BODY_LIMIT_BYTES {
        return Ok(Response::error("webhook body too large", 413)?);
    }
    let payload = match String::from_utf8(payload_bytes) {
        Ok(payload) => payload,
        Err(_) => return Ok(Response::error("invalid payload encoding", 400)?),
    };

    let event = match verify_waffo_pancake_webhook(&env, &payload, &signature, &expected_env) {
        Ok(event) => event,
        Err(message) => {
            worker::console_warn!("Waffo Pancake webhook signature invalid: {message}");
            return Ok(Response::error("invalid signature", 401)?);
        }
    };
    let now = unix_timestamp();
    let event_id = waffo_pancake_event_id(&event, &payload);
    let raw_trade_no = event
        .data
        .order_merchant_external_id
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_string();
    let event_order_id = if raw_trade_no.is_empty() {
        event.data.order_id.trim()
    } else {
        raw_trade_no.as_str()
    };

    if !event.mode.trim().eq_ignore_ascii_case(&expected_env) {
        worker::console_error!(
            "Waffo Pancake webhook env mismatch expected={} actual={} event_id={} order_id={}",
            expected_env,
            event.mode,
            event_id,
            event_order_id
        );
        let _ = d1_repositories::insert_payment_event(
            &db,
            PAYMENT_PROVIDER_WAFFO_PANCAKE,
            &event_id,
            event_order_id,
            "ignored",
            &payload,
            now,
        )
        .await;
        return Response::ok("OK");
    }

    if event.event_type != "order.completed" {
        let _ = d1_repositories::insert_payment_event(
            &db,
            PAYMENT_PROVIDER_WAFFO_PANCAKE,
            &event_id,
            event_order_id,
            "ignored",
            &payload,
            now,
        )
        .await;
        return Response::ok("OK");
    }

    if raw_trade_no.is_empty() {
        worker::console_error!(
            "Waffo Pancake webhook missing orderMerchantExternalId event_id={} order_id={}",
            event_id,
            event.data.order_id
        );
        let _ = d1_repositories::insert_payment_event(
            &db,
            PAYMENT_PROVIDER_WAFFO_PANCAKE,
            &event_id,
            event_order_id,
            "unmatched",
            &payload,
            now,
        )
        .await;
        return Response::ok("OK");
    }
    if raw_trade_no.starts_with("WAFFO_PANCAKE_SUB-") {
        let _ = d1_repositories::insert_payment_event(
            &db,
            PAYMENT_PROVIDER_WAFFO_PANCAKE,
            &event_id,
            &raw_trade_no,
            "subscription_deferred",
            &payload,
            now,
        )
        .await;
        return Response::ok("OK");
    }

    let Some(topup) = d1_repositories::find_topup_by_trade_no(&db, &raw_trade_no).await? else {
        worker::console_error!(
            "Waffo Pancake webhook topup not found event_id={} trade_no={} buyer_identity={}",
            event_id,
            raw_trade_no,
            event
                .data
                .merchant_provided_buyer_identity
                .as_deref()
                .unwrap_or_default()
        );
        let _ = d1_repositories::insert_payment_event(
            &db,
            PAYMENT_PROVIDER_WAFFO_PANCAKE,
            &event_id,
            &raw_trade_no,
            "unmatched",
            &payload,
            now,
        )
        .await;
        return Response::ok("OK");
    };
    if topup.payment_provider != PAYMENT_PROVIDER_WAFFO_PANCAKE {
        worker::console_error!(
            "Waffo Pancake webhook provider mismatch event_id={} trade_no={} provider={}",
            event_id,
            raw_trade_no,
            topup.payment_provider
        );
        let _ = d1_repositories::insert_payment_event(
            &db,
            PAYMENT_PROVIDER_WAFFO_PANCAKE,
            &event_id,
            &raw_trade_no,
            "rejected",
            &payload,
            now,
        )
        .await;
        return Response::ok("OK");
    }
    let expected_identity = waffo_pancake_buyer_identity(topup.user_id);
    let actual_identity = event
        .data
        .merchant_provided_buyer_identity
        .as_deref()
        .unwrap_or_default()
        .trim();
    if actual_identity != expected_identity {
        worker::console_error!(
            "Waffo Pancake webhook buyer identity mismatch event_id={} trade_no={} expected={} actual={}",
            event_id,
            raw_trade_no,
            expected_identity,
            actual_identity
        );
        let _ = d1_repositories::insert_payment_event(
            &db,
            PAYMENT_PROVIDER_WAFFO_PANCAKE,
            &event_id,
            &raw_trade_no,
            "rejected",
            &payload,
            now,
        )
        .await;
        return Response::ok("OK");
    }

    let event_money = parse_waffo_pancake_event_money(&event.data.amount);
    if let Some(event_money) = event_money {
        if (topup.money - event_money).abs() >= 0.000001 {
            worker::console_error!(
                "Waffo Pancake webhook amount mismatch event_id={} trade_no={} topup_money={} event_amount={}",
                event_id,
                raw_trade_no,
                topup.money,
                event.data.amount
            );
            let _ = d1_repositories::insert_payment_event(
                &db,
                PAYMENT_PROVIDER_WAFFO_PANCAKE,
                &event_id,
                &raw_trade_no,
                "rejected",
                &payload,
                now,
            )
            .await;
            return Response::ok("OK");
        }
    }
    let expected_money = event_money.unwrap_or(topup.money);
    let credit_result = d1_repositories::complete_topup_and_credit_for_provider(
        &db,
        &raw_trade_no,
        PAYMENT_PROVIDER_WAFFO_PANCAKE,
        PAYMENT_PROVIDER_WAFFO_PANCAKE,
        expected_money,
        now,
    )
    .await?;
    let _ = d1_repositories::insert_payment_event(
        &db,
        PAYMENT_PROVIDER_WAFFO_PANCAKE,
        &event_id,
        &raw_trade_no,
        "paid",
        &payload,
        now,
    )
    .await;

    if credit_result.credited_now() {
        if let Some(topup) = d1_repositories::find_topup_by_trade_no(&db, &raw_trade_no).await? {
            let _ = d1_repositories::insert_admin_audit_log(
                &db,
                Some(topup.user_id),
                None,
                "system",
                "topup.credit",
                &format!(
                    "Waffo Pancake topup {} credited {} quota ({} paid)",
                    topup.trade_no, topup.amount, topup.money
                ),
                &serde_json::json!({
                    "trade_no": topup.trade_no,
                    "amount": topup.amount,
                    "money": topup.money,
                    "payment_method": topup.payment_method,
                    "payment_provider": PAYMENT_PROVIDER_WAFFO_PANCAKE,
                    "event_id": event_id,
                    "order_id": event.data.order_id,
                }),
                &d1_repositories::AdminAuditInfo {
                    admin_id: 0,
                    admin_username: "waffo-pancake-webhook".to_string(),
                    admin_role: 0,
                    auth_method: "webhook".to_string(),
                    ip: String::new(),
                },
                now,
            )
            .await;
        }
    } else if let Some(topup) = d1_repositories::find_topup_by_trade_no(&db, &raw_trade_no).await? {
        if !is_completed_waffo_pancake_replay(&topup, expected_money) {
            worker::console_error!(
                "Waffo Pancake webhook verified but did not credit trade_no={} status={} credited={} provider={}",
                raw_trade_no,
                topup.status,
                topup.credited,
                topup.payment_provider
            );
            return Ok(Response::error("retry", 500)?);
        }
    } else {
        worker::console_error!(
            "Waffo Pancake webhook verified but topup disappeared trade_no={}",
            raw_trade_no
        );
        return Ok(Response::error("retry", 500)?);
    }

    Response::ok("OK")
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
    let epay_configured = epay_config_from_values(&values[7], &values[8], &values[9]).is_some();
    let epay_pay_methods = parse_payment_methods(values[10].as_deref());
    let waffo_pancake_min_topup = parse_positive_f64(values[14].as_deref(), 1.0);
    let waffo_pancake_configured = waffo_pancake_topup_configured(
        values[11].as_deref().unwrap_or_default(),
        values[12].as_deref().unwrap_or_default(),
        values[13].as_deref().unwrap_or_default(),
    );

    // Only expose provider methods that have a Rust Worker implementation.
    // Creem/Waffo remain payment-deferred and stay hidden even if legacy option
    // keys are present, so the frontend never renders broken buttons.
    let enable_stripe_topup = compliance_confirmed && config.is_enabled();
    let enable_online_topup =
        compliance_confirmed && epay_configured && !epay_pay_methods.is_empty();
    let enable_waffo_pancake_topup = compliance_confirmed && waffo_pancake_configured;
    let mut pay_methods = if enable_online_topup {
        epay_pay_methods
    } else {
        Vec::new()
    };
    if enable_stripe_topup {
        let has_stripe = pay_methods.iter().any(|method| {
            method.get("type").and_then(Value::as_str) == Some(PAYMENT_PROVIDER_STRIPE)
        });
        if !has_stripe {
            pay_methods.push(serde_json::json!({
                "name": "Stripe",
                "type": "stripe",
                "color": "rgba(var(--semi-purple-5), 1)",
                "min_topup": stripe_min_topup,
            }));
        }
    }
    if enable_waffo_pancake_topup {
        let has_waffo_pancake = pay_methods.iter().any(|method| {
            method.get("type").and_then(Value::as_str) == Some(PAYMENT_PROVIDER_WAFFO_PANCAKE)
        });
        if !has_waffo_pancake {
            pay_methods.push(serde_json::json!({
                "name": "Waffo Pancake",
                "type": PAYMENT_PROVIDER_WAFFO_PANCAKE,
                "color": "rgba(var(--semi-blue-5), 1)",
                "min_topup": waffo_pancake_min_topup,
            }));
        }
    }

    Ok(envelope_ok_response(&TopupInfoResponse {
        enable_online_topup,
        enable_stripe_topup,
        enable_creem_topup: false,
        enable_waffo_topup: false,
        enable_waffo_pancake_topup,
        enable_waffo_pancake_subscription: false,
        enable_redemption: compliance_confirmed,
        payment_compliance_confirmed: compliance_confirmed,
        payment_compliance_terms_version: CURRENT_COMPLIANCE_TERMS_VERSION.to_string(),
        waffo_pay_methods: Value::Null,
        creem_products: Value::Array(Vec::new()),
        pay_methods,
        min_topup,
        stripe_min_topup,
        waffo_min_topup: 1.0,
        waffo_pancake_min_topup,
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

#[derive(Debug, Clone)]
struct EpayConfig {
    pay_address: String,
    partner_id: String,
    key: String,
}

#[derive(Debug, Clone, Copy)]
struct EpayPurchaseInput<'a> {
    partner_id: &'a str,
    key: &'a str,
    payment_method: &'a str,
    trade_no: &'a str,
    name: &'a str,
    money: &'a str,
    notify_url: &'a str,
    return_url: &'a str,
}

#[derive(Debug, Clone)]
struct EpayNotifyInfo {
    payment_method: String,
    trade_no: String,
    out_trade_no: String,
    money: String,
    trade_status: String,
}

#[derive(Debug, Serialize)]
struct TopupInfoResponse {
    enable_online_topup: bool,
    enable_stripe_topup: bool,
    enable_creem_topup: bool,
    enable_waffo_topup: bool,
    enable_waffo_pancake_topup: bool,
    enable_waffo_pancake_subscription: bool,
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
struct WaffoPancakeCredsRequest {
    #[serde(default)]
    merchant_id: String,
    #[serde(default)]
    private_key: String,
}

#[derive(Debug, Clone, PartialEq)]
struct WaffoPancakeCreds {
    merchant_id: String,
    private_key: String,
}

#[derive(Debug, Default, Deserialize)]
struct CreateWaffoPancakePairRequest {
    #[serde(default)]
    merchant_id: String,
    #[serde(default)]
    private_key: String,
    #[serde(default)]
    return_url: String,
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

#[derive(Debug, Default, Deserialize)]
struct CreateWaffoPancakeSubscriptionProductRequest {
    #[serde(default)]
    name: String,
    #[serde(default)]
    amount: String,
}

#[derive(Debug, Serialize, PartialEq)]
struct WaffoPancakePairResponse {
    store_id: String,
    store_name: String,
    product_id: String,
    product_name: String,
}

#[derive(Debug, Serialize, PartialEq)]
struct WaffoPancakeSubscriptionProductCreateResponse {
    product_id: String,
    product_name: String,
    store_id: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
struct WaffoPancakeCatalog {
    stores: Vec<WaffoPancakeCatalogStore>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
struct WaffoPancakeCatalogStore {
    id: String,
    name: String,
    status: String,
    #[serde(rename = "prodEnabled", default)]
    prod_enabled: bool,
    #[serde(rename = "onetimeProducts", default)]
    onetime_products: Vec<WaffoPancakeCatalogProduct>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
struct WaffoPancakeCatalogProduct {
    id: String,
    name: String,
    status: String,
}

#[derive(Debug, Deserialize)]
struct WaffoPancakeGraphqlEnvelope {
    #[serde(default)]
    data: Option<WaffoPancakeCatalog>,
    #[serde(default)]
    errors: Vec<WaffoPancakeNotice>,
}

#[derive(Debug, Deserialize)]
struct WaffoPancakeActionEnvelope<T> {
    data: Option<T>,
    #[serde(default)]
    errors: Vec<WaffoPancakeNotice>,
}

#[derive(Debug, Deserialize)]
struct WaffoPancakeNotice {
    #[serde(default)]
    message: String,
}

#[derive(Debug, Deserialize)]
struct WaffoPancakeStoreActionData {
    store: WaffoPancakeStoreActionStore,
}

#[derive(Debug, Deserialize)]
struct WaffoPancakeStoreActionStore {
    id: String,
    #[serde(default)]
    name: String,
}

#[derive(Debug, Deserialize)]
struct WaffoPancakeProductActionData {
    product: WaffoPancakeProductActionProduct,
}

#[derive(Debug, Deserialize)]
struct WaffoPancakeProductActionProduct {
    id: String,
    #[serde(default)]
    name: String,
}

#[derive(Debug, Serialize)]
struct WaffoPancakeCreateStoreBody<'a> {
    name: &'a str,
}

#[derive(Debug, Serialize)]
struct WaffoPancakeCreateOnetimeProductBody {
    #[serde(rename = "storeId")]
    store_id: String,
    name: String,
    prices: BTreeMap<String, WaffoPancakePriceInfo>,
    #[serde(rename = "successUrl", skip_serializing_if = "Option::is_none")]
    success_url: Option<String>,
}

#[derive(Debug, Serialize)]
struct WaffoPancakePriceInfo {
    amount: String,
    #[serde(rename = "taxCategory")]
    tax_category: &'static str,
}

#[derive(Debug, Serialize)]
struct WaffoPancakeIssueSessionTokenBody<'a> {
    #[serde(rename = "productId")]
    product_id: &'a str,
    #[serde(rename = "buyerIdentity")]
    buyer_identity: &'a str,
}

#[derive(Debug, Deserialize)]
struct WaffoPancakeSessionTokenData {
    token: String,
    #[serde(rename = "expiresAt")]
    expires_at: String,
}

#[derive(Debug, Serialize)]
struct WaffoPancakeCheckoutSessionBody<'a> {
    #[serde(rename = "productId")]
    product_id: &'a str,
    currency: &'static str,
    #[serde(rename = "priceSnapshot")]
    price_snapshot: WaffoPancakePriceInfo,
    #[serde(rename = "buyerEmail", skip_serializing_if = "Option::is_none")]
    buyer_email: Option<&'a str>,
    #[serde(rename = "expiresInSeconds")]
    expires_in_seconds: i32,
    #[serde(rename = "orderMerchantExternalId")]
    order_merchant_external_id: &'a str,
}

#[derive(Debug, Deserialize)]
struct WaffoPancakeCheckoutSessionData {
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(rename = "checkoutUrl")]
    checkout_url: String,
    #[serde(rename = "expiresAt")]
    expires_at: String,
}

#[derive(Debug, Serialize)]
struct WaffoPancakePayResponse {
    checkout_url: String,
    session_id: String,
    expires_at: String,
    order_id: String,
    token: String,
    token_expires_at: String,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
struct WaffoPancakeWebhookEvent {
    #[serde(default)]
    id: String,
    #[serde(default)]
    timestamp: String,
    #[serde(rename = "eventType", default)]
    event_type: String,
    #[serde(rename = "eventId", default)]
    event_id: String,
    #[serde(rename = "storeId", default)]
    store_id: String,
    #[serde(rename = "storeName", default)]
    store_name: String,
    #[serde(default)]
    mode: String,
    #[serde(default)]
    data: WaffoPancakeWebhookData,
}

#[allow(dead_code)]
#[derive(Debug, Default, Deserialize)]
struct WaffoPancakeWebhookData {
    #[serde(rename = "orderId", default)]
    order_id: String,
    #[serde(rename = "orderMerchantExternalId", default)]
    order_merchant_external_id: Option<String>,
    #[serde(rename = "buyerEmail", default)]
    buyer_email: String,
    #[serde(rename = "merchantProvidedBuyerIdentity", default)]
    merchant_provided_buyer_identity: Option<String>,
    #[serde(default)]
    currency: String,
    #[serde(default)]
    amount: String,
    #[serde(rename = "taxAmount", default)]
    tax_amount: String,
    #[serde(rename = "productName", default)]
    product_name: String,
}

#[derive(Debug, Serialize)]
struct WaffoPancakePublishOnetimeProductBody {
    id: String,
}

#[derive(Debug, PartialEq)]
enum WaffoPancakePairError {
    Store(String),
    OrphanStore { store_id: String, error: String },
}

#[derive(Debug, Serialize, PartialEq)]
struct WaffoPancakeSubscriptionProductOptions {
    store_id: String,
    products: Vec<WaffoPancakeCatalogProduct>,
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

async fn read_optional_json_body(req: &mut Request) -> std::result::Result<Value, Response> {
    let content_length = match req.headers().get("Content-Length") {
        Ok(content_length) => content_length,
        Err(err) => {
            return Err(envelope_error_response(
                400,
                &format!("failed to read request headers: {err}"),
            ));
        }
    };
    if let Err(message) = validate_waffo_pancake_admin_content_length(content_length.as_deref()) {
        return Err(envelope_error_response(
            if message.contains("too large") {
                413
            } else {
                400
            },
            &message,
        ));
    }

    let bytes = match req.bytes().await {
        Ok(bytes) => bytes,
        Err(err) => {
            return Err(envelope_error_response(
                400,
                &format!("failed to read request body: {err}"),
            ));
        }
    };
    parse_optional_json_bytes(&bytes).map_err(|message| {
        envelope_error_response(
            if message.contains("too large") {
                413
            } else {
                400
            },
            &message,
        )
    })
}

fn parse_optional_json_bytes(bytes: &[u8]) -> Result<Value, String> {
    if bytes.len() > WAFFO_PANCAKE_ADMIN_BODY_LIMIT_BYTES {
        return Err("admin request body too large".to_string());
    }
    if bytes.is_empty() || bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(serde_json::json!({}));
    }
    serde_json::from_slice::<Value>(bytes)
        .map_err(|err| format!("request body is not valid JSON: {err}"))
}

fn validate_waffo_pancake_admin_content_length(raw: Option<&str>) -> Result<(), String> {
    let Some(raw) = raw else {
        return Ok(());
    };
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(());
    }
    let length = raw
        .parse::<usize>()
        .map_err(|_| "admin request Content-Length is invalid".to_string())?;
    if length > WAFFO_PANCAKE_ADMIN_BODY_LIMIT_BYTES {
        return Err("admin request body too large".to_string());
    }
    Ok(())
}

fn waffo_pancake_ok_response<T: Serialize>(data: &T) -> WorkerResult<Response> {
    let body = serde_json::json!({
        "message": "success",
        "data": data,
    });
    let mut response = Response::from_json(&body)?.with_status(200);
    set_cors_headers(&mut response)?;
    Ok(response)
}

fn waffo_pancake_error_message_response(status: u16, message: &str) -> WorkerResult<Response> {
    waffo_pancake_error_response(status, &message)
}

fn waffo_pancake_error_response<T: Serialize>(status: u16, data: &T) -> WorkerResult<Response> {
    let body = serde_json::json!({
        "message": "error",
        "data": data,
    });
    let mut response = Response::from_json(&body)?.with_status(status);
    set_cors_headers(&mut response)?;
    Ok(response)
}

async fn resolve_waffo_pancake_admin_creds(
    db: &worker::D1Database,
    body_merchant_id: &str,
    body_private_key: &str,
) -> WorkerResult<Result<WaffoPancakeCreds, &'static str>> {
    let merchant_id = body_merchant_id.trim();
    let private_key = body_private_key.trim();
    if !merchant_id.is_empty() || !private_key.is_empty() {
        return Ok(waffo_pancake_creds_from_parts(merchant_id, private_key));
    }

    let values = d1_repositories::option_values(db, WAFFO_PANCAKE_CREDENTIAL_OPTION_KEYS).await?;
    Ok(waffo_pancake_creds_from_parts(
        values[0].as_deref().unwrap_or_default(),
        values[1].as_deref().unwrap_or_default(),
    ))
}

fn waffo_pancake_creds_from_parts(
    merchant_id: &str,
    private_key: &str,
) -> Result<WaffoPancakeCreds, &'static str> {
    let merchant_id = merchant_id.trim();
    let private_key = private_key.trim();
    if merchant_id.is_empty() || private_key.is_empty() {
        return Err("Waffo Pancake credentials are not configured");
    }
    Ok(WaffoPancakeCreds {
        merchant_id: merchant_id.to_string(),
        private_key: private_key.to_string(),
    })
}

async fn create_waffo_pancake_primary_pair(
    creds: &WaffoPancakeCreds,
    return_url: &str,
) -> Result<WaffoPancakePairResponse, WaffoPancakePairError> {
    let store = create_waffo_pancake_primary_store(creds)
        .await
        .map_err(WaffoPancakePairError::Store)?;
    match create_waffo_pancake_primary_product(creds, &store.id, return_url).await {
        Ok(product) => Ok(WaffoPancakePairResponse {
            store_id: store.id,
            store_name: non_empty_or(&store.name, DEFAULT_WAFFO_PANCAKE_STORE_NAME),
            product_id: product.id,
            product_name: non_empty_or(&product.name, DEFAULT_WAFFO_PANCAKE_PRODUCT_NAME),
        }),
        Err(error) => {
            let store_id = store.id;
            Err(WaffoPancakePairError::OrphanStore {
                error: format!("store created at {store_id} but product creation failed: {error}"),
                store_id,
            })
        }
    }
}

fn non_empty_or(value: &str, default: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        default.to_string()
    } else {
        value.to_string()
    }
}

async fn create_waffo_pancake_primary_store(
    creds: &WaffoPancakeCreds,
) -> Result<WaffoPancakeStoreActionStore, String> {
    let data: WaffoPancakeStoreActionData = post_waffo_pancake_action(
        creds,
        WAFFO_PANCAKE_CREATE_STORE_PATH,
        &WaffoPancakeCreateStoreBody {
            name: DEFAULT_WAFFO_PANCAKE_STORE_NAME,
        },
    )
    .await?;
    if data.store.id.trim().is_empty() {
        return Err("Waffo Pancake create-store returned no store id".to_string());
    }
    Ok(data.store)
}

async fn create_waffo_pancake_primary_product(
    creds: &WaffoPancakeCreds,
    store_id: &str,
    return_url: &str,
) -> Result<WaffoPancakeProductActionProduct, String> {
    create_waffo_pancake_onetime_product(
        creds,
        store_id,
        DEFAULT_WAFFO_PANCAKE_PRODUCT_NAME,
        "1.00",
        return_url,
    )
    .await
}

async fn create_waffo_pancake_product_for_plan(
    creds: &WaffoPancakeCreds,
    store_id: &str,
    name: &str,
    amount: &str,
    return_url: &str,
) -> Result<String, String> {
    let product =
        create_waffo_pancake_onetime_product(creds, store_id, name, amount, return_url).await?;
    Ok(product.id)
}

async fn create_waffo_pancake_onetime_product(
    creds: &WaffoPancakeCreds,
    store_id: &str,
    name: &str,
    amount: &str,
    return_url: &str,
) -> Result<WaffoPancakeProductActionProduct, String> {
    let store_id = store_id.trim();
    validate_waffo_pancake_short_id("storeId", store_id, "STO")?;
    let name = name.trim();
    if name.is_empty() {
        return Err("plan name is required".to_string());
    }
    let amount = amount.trim();
    validate_waffo_pancake_amount("prices.USD.amount", amount)?;

    let mut prices = BTreeMap::new();
    prices.insert(
        "USD".to_string(),
        WaffoPancakePriceInfo {
            amount: amount.to_string(),
            tax_category: WAFFO_PANCAKE_TAX_CATEGORY_SAAS,
        },
    );
    let success_url = optional_waffo_pancake_string(return_url);
    let data: WaffoPancakeProductActionData = post_waffo_pancake_action(
        creds,
        WAFFO_PANCAKE_CREATE_ONETIME_PRODUCT_PATH,
        &WaffoPancakeCreateOnetimeProductBody {
            store_id: store_id.to_string(),
            name: name.to_string(),
            prices,
            success_url,
        },
    )
    .await?;
    validate_waffo_pancake_short_id("id", &data.product.id, "PROD")?;
    publish_waffo_pancake_onetime_product(creds, &data.product.id).await
}

async fn publish_waffo_pancake_onetime_product(
    creds: &WaffoPancakeCreds,
    product_id: &str,
) -> Result<WaffoPancakeProductActionProduct, String> {
    validate_waffo_pancake_short_id("id", product_id, "PROD")?;
    let data: WaffoPancakeProductActionData = post_waffo_pancake_action(
        creds,
        WAFFO_PANCAKE_PUBLISH_ONETIME_PRODUCT_PATH,
        &WaffoPancakePublishOnetimeProductBody {
            id: product_id.to_string(),
        },
    )
    .await?;
    if data.product.id.trim().is_empty() {
        return Err("Waffo Pancake publish-product returned no product id".to_string());
    }
    Ok(data.product)
}

async fn create_waffo_pancake_checkout_session(
    creds: &WaffoPancakeCreds,
    product_id: &str,
    buyer_identity: &str,
    buyer_email: Option<&str>,
    amount: &str,
    trade_no: &str,
) -> Result<WaffoPancakePayResponse, String> {
    validate_waffo_pancake_short_id("productId", product_id, "PROD")?;
    let buyer_identity = buyer_identity.trim();
    if buyer_identity.is_empty() {
        return Err("buyer identity is required".to_string());
    }
    let trade_no = trade_no.trim();
    if trade_no.is_empty() {
        return Err("order merchant external id is required".to_string());
    }
    validate_waffo_pancake_amount("priceSnapshot.amount", amount)?;

    let token: WaffoPancakeSessionTokenData = post_waffo_pancake_action(
        creds,
        WAFFO_PANCAKE_ISSUE_SESSION_TOKEN_PATH,
        &WaffoPancakeIssueSessionTokenBody {
            product_id,
            buyer_identity,
        },
    )
    .await?;
    if token.token.trim().is_empty() {
        return Err("Waffo Pancake returned empty session token".to_string());
    }

    let session: WaffoPancakeCheckoutSessionData = post_waffo_pancake_action(
        creds,
        WAFFO_PANCAKE_CREATE_CHECKOUT_SESSION_PATH,
        &WaffoPancakeCheckoutSessionBody {
            product_id,
            currency: "USD",
            price_snapshot: WaffoPancakePriceInfo {
                amount: amount.to_string(),
                tax_category: WAFFO_PANCAKE_TAX_CATEGORY_SAAS,
            },
            buyer_email,
            expires_in_seconds: WAFFO_PANCAKE_CHECKOUT_EXPIRES_SECONDS,
            order_merchant_external_id: trade_no,
        },
    )
    .await?;
    if session.session_id.trim().is_empty() || session.checkout_url.trim().is_empty() {
        return Err("Waffo Pancake returned empty checkout session".to_string());
    }

    Ok(WaffoPancakePayResponse {
        checkout_url: format!("{}#token={}", session.checkout_url, token.token),
        session_id: session.session_id,
        expires_at: session.expires_at,
        order_id: trade_no.to_string(),
        token: token.token,
        token_expires_at: token.expires_at,
    })
}

async fn post_waffo_pancake_action<T, B>(
    creds: &WaffoPancakeCreds,
    path: &str,
    body: &B,
) -> Result<T, String>
where
    T: DeserializeOwned,
    B: Serialize,
{
    let body = serde_json::to_vec(body)
        .map_err(|err| format!("failed to encode Waffo Pancake action body: {err}"))?;
    let timestamp = unix_timestamp().to_string();
    let signature =
        sign_waffo_pancake_request("POST", path, &timestamp, &body, &creds.private_key)?;
    let idempotency_key = waffo_pancake_idempotency_key(&creds.merchant_id, path, &body);

    let mut headers = Headers::new();
    headers
        .set("Accept", "application/json")
        .map_err(|err| err.to_string())?;
    headers
        .set("Content-Type", "application/json")
        .map_err(|err| err.to_string())?;
    headers
        .set("X-Merchant-Id", &creds.merchant_id)
        .map_err(|err| err.to_string())?;
    headers
        .set("X-Timestamp", &timestamp)
        .map_err(|err| err.to_string())?;
    headers
        .set("X-Signature", &signature)
        .map_err(|err| err.to_string())?;
    headers
        .set("X-Idempotency-Key", &idempotency_key)
        .map_err(|err| err.to_string())?;

    let url = format!("{WAFFO_PANCAKE_API_BASE_URL}{path}");
    let mut response = fetch_waffo_pancake_json(&url, headers, &body).await?;
    let bytes = read_limited_waffo_pancake_response_body(&mut response).await?;
    if bytes.iter().all(u8::is_ascii_whitespace) {
        if response.status_code() >= 400 {
            return Err(format!(
                "Waffo Pancake action HTTP {}",
                response.status_code()
            ));
        }
        return Err("Waffo Pancake action returned empty response".to_string());
    }

    let envelope: WaffoPancakeActionEnvelope<T> = serde_json::from_slice(&bytes)
        .map_err(|err| format!("failed to parse Waffo Pancake action response: {err}"))?;
    if let Some(first_error) = envelope.errors.first() {
        let message = first_error.message.trim();
        return Err(if message.is_empty() {
            format!(
                "Waffo Pancake action returned {} API errors",
                envelope.errors.len()
            )
        } else {
            message.to_string()
        });
    }
    if response.status_code() >= 400 {
        return Err(format!(
            "Waffo Pancake action HTTP {}",
            response.status_code()
        ));
    }
    envelope
        .data
        .ok_or_else(|| "Waffo Pancake action returned no data".to_string())
}

async fn fetch_waffo_pancake_catalog(
    creds: &WaffoPancakeCreds,
) -> Result<WaffoPancakeCatalog, String> {
    let body = serde_json::to_vec(&serde_json::json!({
        "query": WAFFO_PANCAKE_CATALOG_QUERY,
    }))
    .map_err(|err| format!("failed to encode GraphQL body: {err}"))?;
    let timestamp = unix_timestamp().to_string();
    let signature = sign_waffo_pancake_request(
        "POST",
        WAFFO_PANCAKE_GRAPHQL_PATH,
        &timestamp,
        &body,
        &creds.private_key,
    )?;

    let mut headers = Headers::new();
    headers
        .set("Accept", "application/json")
        .map_err(|err| err.to_string())?;
    headers
        .set("Content-Type", "application/json")
        .map_err(|err| err.to_string())?;
    headers
        .set("X-Merchant-Id", &creds.merchant_id)
        .map_err(|err| err.to_string())?;
    headers
        .set("X-Timestamp", &timestamp)
        .map_err(|err| err.to_string())?;
    headers
        .set("X-Signature", &signature)
        .map_err(|err| err.to_string())?;

    let mut response = fetch_waffo_pancake_json(WAFFO_PANCAKE_GRAPHQL_URL, headers, &body).await?;
    if response.status_code() != 200 {
        return Err(format!(
            "Waffo Pancake catalog HTTP {}",
            response.status_code()
        ));
    }
    let bytes = read_limited_waffo_pancake_response_body(&mut response).await?;
    let envelope: WaffoPancakeGraphqlEnvelope = serde_json::from_slice(&bytes)
        .map_err(|err| format!("failed to parse Waffo Pancake catalog: {err}"))?;
    if let Some(first_error) = envelope.errors.first() {
        let message = first_error.message.trim();
        return Err(if message.is_empty() {
            format!(
                "Waffo Pancake catalog returned {} GraphQL errors",
                envelope.errors.len()
            )
        } else {
            format!("Waffo Pancake catalog returned GraphQL error: {message}")
        });
    }
    let mut catalog = envelope.data.unwrap_or_default();
    filter_active_waffo_pancake_products(&mut catalog);
    Ok(catalog)
}

async fn fetch_waffo_pancake_json(
    url: &str,
    headers: Headers,
    body: &[u8],
) -> Result<Response, String> {
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(wasm_bindgen::JsValue::from(js_sys::Uint8Array::from(
            body,
        ))))
        .with_redirect(RequestRedirect::Error);
    let request = Request::new_with_init(url, &init)
        .map_err(|err| format!("failed to build Waffo Pancake request: {err}"))?;
    let controller = AbortController::default();
    let signal = controller.signal();
    let outbound = Fetch::Request(request);
    let fetch = outbound.send_with_signal(&signal);
    let delay = Delay::from(WAFFO_PANCAKE_FETCH_TIMEOUT);
    futures_util::pin_mut!(fetch);
    futures_util::pin_mut!(delay);
    let response = match select(fetch, delay).await {
        Either::Left((result, _)) => {
            result.map_err(|err| format!("failed to fetch Waffo Pancake request: {err}"))?
        }
        Either::Right(((), _)) => {
            controller.abort();
            return Err("Waffo Pancake request timed out".to_string());
        }
    };
    let content_type = response
        .headers()
        .get("Content-Type")
        .map_err(|err| format!("failed to inspect Waffo Pancake headers: {err}"))?
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !content_type.is_empty()
        && !content_type.contains("application/json")
        && !content_type.contains("+json")
    {
        return Err("Waffo Pancake response is not JSON".to_string());
    }
    Ok(response)
}

async fn read_limited_waffo_pancake_response_body(
    response: &mut Response,
) -> Result<Vec<u8>, String> {
    if let Some(raw) = response
        .headers()
        .get("Content-Length")
        .map_err(|err| format!("failed to inspect Waffo Pancake headers: {err}"))?
    {
        let raw = raw.trim();
        if !raw.is_empty() {
            let length = raw
                .parse::<usize>()
                .map_err(|_| "Waffo Pancake Content-Length is invalid".to_string())?;
            if length > WAFFO_PANCAKE_GRAPHQL_RESPONSE_LIMIT_BYTES {
                return Err("Waffo Pancake catalog response is too large".to_string());
            }
        }
    }
    response
        .stream()
        .map_err(|err| format!("failed to read Waffo Pancake response: {err}"))?
        .try_fold(Vec::new(), |mut bytes, chunk| async move {
            if bytes.len().saturating_add(chunk.len()) > WAFFO_PANCAKE_GRAPHQL_RESPONSE_LIMIT_BYTES
            {
                return Err(worker::Error::RustError(
                    "Waffo Pancake catalog response is too large".to_string(),
                ));
            }
            bytes.extend_from_slice(&chunk);
            Ok(bytes)
        })
        .await
        .map_err(|err| err.to_string())
}

fn sign_waffo_pancake_request(
    method: &str,
    path: &str,
    timestamp: &str,
    body: &[u8],
    private_key: &str,
) -> Result<String, String> {
    let key = parse_waffo_pancake_private_key(private_key)?;
    let canonical = waffo_pancake_signature_input(method, path, timestamp, body);
    let signing_key = SigningKey::<Sha256>::new(key);
    let signature = signing_key.sign(canonical.as_bytes());
    Ok(BASE64_STANDARD.encode(signature.to_bytes()))
}

fn waffo_pancake_idempotency_key(merchant_id: &str, path: &str, body: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(merchant_id.as_bytes());
    hasher.update(b":");
    hasher.update(path.as_bytes());
    hasher.update(b":");
    hasher.update(body);
    hex_lower(&hasher.finalize())
}

fn waffo_pancake_signature_input(method: &str, path: &str, timestamp: &str, body: &[u8]) -> String {
    let body_hash = Sha256::digest(body);
    format!(
        "{method}\n{path}\n{timestamp}\n{}",
        BASE64_STANDARD.encode(body_hash)
    )
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

fn parse_waffo_pancake_private_key(raw: &str) -> Result<RsaPrivateKey, String> {
    let pem = normalize_waffo_pancake_private_key(raw)?;
    RsaPrivateKey::from_pkcs8_pem(&pem)
        .or_else(|_| RsaPrivateKey::from_pkcs1_pem(&pem))
        .map_err(|err| format!("invalid Waffo Pancake private key: {err}"))
}

fn parse_waffo_pancake_public_key(raw: &str) -> Result<RsaPublicKey, String> {
    let pem = normalize_waffo_pancake_public_key(raw)?;
    RsaPublicKey::from_public_key_pem(&pem)
        .or_else(|_| RsaPublicKey::from_pkcs1_pem(&pem))
        .map_err(|err| format!("invalid Waffo Pancake public key: {err}"))
}

fn verify_waffo_pancake_webhook(
    env: &Env,
    payload: &str,
    signature_header: &str,
    expected_env: &str,
) -> Result<WaffoPancakeWebhookEvent, String> {
    if signature_header.trim().is_empty() {
        return Err("missing X-Waffo-Signature header".to_string());
    }
    let (timestamp, signature_b64) = parse_waffo_pancake_signature_header(signature_header)?;
    let timestamp_ms = timestamp
        .parse::<i64>()
        .map_err(|_| "invalid timestamp in X-Waffo-Signature header".to_string())?;
    if unix_timestamp_millis().abs_diff(timestamp_ms) > WAFFO_PANCAKE_WEBHOOK_TOLERANCE_MS {
        return Err("webhook timestamp outside tolerance window".to_string());
    }

    let public_key =
        parse_waffo_pancake_public_key(&waffo_pancake_public_key_for_env(env, expected_env))?;
    let signature_input = format!("{timestamp}.{payload}");
    let signature_bytes = BASE64_STANDARD
        .decode(signature_b64.as_bytes())
        .map_err(|_| "invalid webhook signature encoding".to_string())?;
    let signature = RsaSignature::try_from(signature_bytes.as_slice())
        .map_err(|_| "invalid webhook signature length".to_string())?;
    VerifyingKey::<Sha256>::new(public_key)
        .verify(signature_input.as_bytes(), &signature)
        .map_err(|_| format!("invalid webhook signature ({expected_env} key)"))?;

    serde_json::from_str::<WaffoPancakeWebhookEvent>(payload)
        .map_err(|err| format!("decode webhook event: {err}"))
}

fn parse_waffo_pancake_signature_header(header: &str) -> Result<(String, String), String> {
    let mut timestamp = String::new();
    let mut signature = String::new();
    for part in header.split(',') {
        let Some((key, value)) = part.split_once('=') else {
            continue;
        };
        match key.trim() {
            "t" => timestamp = value.trim().to_string(),
            "v1" => signature = value.trim().to_string(),
            _ => {}
        }
    }
    if timestamp.is_empty() || signature.is_empty() {
        return Err("malformed X-Waffo-Signature header: missing t or v1".to_string());
    }
    Ok((timestamp, signature))
}

fn waffo_pancake_public_key_for_env(env: &Env, expected_env: &str) -> String {
    let per_env_key = if expected_env == "test" {
        "WAFFO_WEBHOOK_TEST_PUBLIC_KEY"
    } else {
        "WAFFO_WEBHOOK_PROD_PUBLIC_KEY"
    };
    env.var(per_env_key)
        .ok()
        .map(|value| value.to_string())
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            env.var("WAFFO_WEBHOOK_PUBLIC_KEY")
                .ok()
                .map(|value| value.to_string())
                .filter(|value| !value.trim().is_empty())
        })
        .unwrap_or_else(|| {
            if expected_env == "test" {
                WAFFO_PANCAKE_BUILTIN_TEST_PUBLIC_KEY.to_string()
            } else {
                WAFFO_PANCAKE_BUILTIN_PROD_PUBLIC_KEY.to_string()
            }
        })
}

fn normalize_waffo_pancake_private_key(raw: &str) -> Result<String, String> {
    let mut pem = raw.replace("\\n", "\n").replace("\r\n", "\n");
    pem = pem.trim().to_string();
    if pem.is_empty() {
        return Err("Waffo Pancake private key is empty".to_string());
    }
    const PKCS8_HEADER: &str = "-----BEGIN PRIVATE KEY-----";
    const PKCS8_FOOTER: &str = "-----END PRIVATE KEY-----";
    const PKCS1_HEADER: &str = "-----BEGIN RSA PRIVATE KEY-----";
    const PKCS1_FOOTER: &str = "-----END RSA PRIVATE KEY-----";
    let has_pkcs1 = pem.contains(PKCS1_HEADER);
    let has_pkcs8 = pem.contains(PKCS8_HEADER);
    if has_pkcs1 || has_pkcs8 {
        let mut stripped = pem
            .replace(PKCS8_HEADER, "")
            .replace(PKCS8_FOOTER, "")
            .replace(PKCS1_HEADER, "")
            .replace(PKCS1_FOOTER, "");
        stripped = strip_key_whitespace(&stripped);
        if stripped.is_empty() {
            return Err("Waffo Pancake private key contains no key data".to_string());
        }
        let (header, footer) = if has_pkcs1 {
            (PKCS1_HEADER, PKCS1_FOOTER)
        } else {
            (PKCS8_HEADER, PKCS8_FOOTER)
        };
        return Ok(format!(
            "{header}\n{}\n{footer}",
            wrap_key_base64(&stripped)
        ));
    }

    let stripped = strip_key_whitespace(&pem);
    BASE64_STANDARD
        .decode(stripped.as_bytes())
        .map_err(|_| "Waffo Pancake private key is not valid PEM or base64".to_string())?;
    Ok(format!(
        "{PKCS8_HEADER}\n{}\n{PKCS8_FOOTER}",
        wrap_key_base64(&stripped)
    ))
}

fn normalize_waffo_pancake_public_key(raw: &str) -> Result<String, String> {
    let mut pem = raw.replace("\\n", "\n").replace("\r\n", "\n");
    pem = pem.trim().to_string();
    if pem.is_empty() {
        return Err("Waffo Pancake public key is empty".to_string());
    }
    const PKIX_HEADER: &str = "-----BEGIN PUBLIC KEY-----";
    const PKIX_FOOTER: &str = "-----END PUBLIC KEY-----";
    const PKCS1_HEADER: &str = "-----BEGIN RSA PUBLIC KEY-----";
    const PKCS1_FOOTER: &str = "-----END RSA PUBLIC KEY-----";
    let has_pkcs1 = pem.contains(PKCS1_HEADER);
    let has_pkix = pem.contains(PKIX_HEADER);
    if has_pkcs1 || has_pkix {
        let mut stripped = pem
            .replace(PKIX_HEADER, "")
            .replace(PKIX_FOOTER, "")
            .replace(PKCS1_HEADER, "")
            .replace(PKCS1_FOOTER, "");
        stripped = strip_key_whitespace(&stripped);
        if stripped.is_empty() {
            return Err("Waffo Pancake public key contains no key data".to_string());
        }
        let (header, footer) = if has_pkcs1 {
            (PKCS1_HEADER, PKCS1_FOOTER)
        } else {
            (PKIX_HEADER, PKIX_FOOTER)
        };
        return Ok(format!(
            "{header}\n{}\n{footer}",
            wrap_key_base64(&stripped)
        ));
    }

    let stripped = strip_key_whitespace(&pem);
    BASE64_STANDARD
        .decode(stripped.as_bytes())
        .map_err(|_| "Waffo Pancake public key is not valid PEM or base64".to_string())?;
    Ok(format!(
        "{PKIX_HEADER}\n{}\n{PKIX_FOOTER}",
        wrap_key_base64(&stripped)
    ))
}

fn strip_key_whitespace(value: &str) -> String {
    value.chars().filter(|ch| !ch.is_whitespace()).collect()
}

fn wrap_key_base64(value: &str) -> String {
    if value.len() <= 64 {
        return value.to_string();
    }
    let mut out = String::with_capacity(value.len() + value.len() / 64);
    for (index, chunk) in value.as_bytes().chunks(64).enumerate() {
        if index > 0 {
            out.push('\n');
        }
        out.push_str(std::str::from_utf8(chunk).unwrap_or_default());
    }
    out
}

fn filter_active_waffo_pancake_products(catalog: &mut WaffoPancakeCatalog) {
    for store in &mut catalog.stores {
        store
            .onetime_products
            .retain(|product| product.status.trim().eq_ignore_ascii_case("active"));
    }
}

fn optional_waffo_pancake_string(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn validate_waffo_pancake_short_id(field: &str, value: &str, prefix: &str) -> Result<(), String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("Missing required field: {field}"));
    }
    if !value.starts_with(&format!("{prefix}_")) {
        return Err(format!(
            "Invalid {field}: expected {prefix}_ prefix, got {value:?}"
        ));
    }
    let suffix = &value[prefix.len() + 1..];
    if suffix.len() != 22 || !suffix.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        return Err(format!(
            "Invalid {field}: expected {prefix} Short ID format ({prefix}_xxx), got {value:?}"
        ));
    }
    Ok(())
}

fn validate_waffo_pancake_amount(field: &str, value: &str) -> Result<(), String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("Missing required field: {field}"));
    }
    if !value.as_bytes()[0].is_ascii_digit() {
        return Err(format!(
            "Invalid {field}: expected numeric string in display format, got {value:?}"
        ));
    }
    let mut saw_digit = false;
    let mut saw_dot = false;
    for byte in value.bytes() {
        match byte {
            b'0'..=b'9' => saw_digit = true,
            b'.' if !saw_dot => saw_dot = true,
            _ => {
                return Err(format!(
                    "Invalid {field}: expected numeric string in display format, got {value:?}"
                ));
            }
        }
    }
    if !saw_digit || value.ends_with('.') {
        return Err(format!(
            "Invalid {field}: expected numeric string in display format, got {value:?}"
        ));
    }
    Ok(())
}

fn waffo_pancake_subscription_options(
    catalog: &WaffoPancakeCatalog,
    store_id: &str,
) -> WaffoPancakeSubscriptionProductOptions {
    let products = catalog
        .stores
        .iter()
        .find(|store| store.id == store_id)
        .map(|store| store.onetime_products.clone())
        .unwrap_or_default();
    WaffoPancakeSubscriptionProductOptions {
        store_id: store_id.to_string(),
        products,
    }
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
        payment_provider: row.payment_provider,
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

fn epay_config_from_values(
    pay_address: &Option<String>,
    partner_id: &Option<String>,
    key: &Option<String>,
) -> Option<EpayConfig> {
    let pay_address = pay_address.as_deref()?.trim();
    let partner_id = partner_id.as_deref()?.trim();
    let key = key.as_deref()?.trim();
    if pay_address.is_empty() || partner_id.is_empty() || key.is_empty() {
        return None;
    }
    Some(EpayConfig {
        pay_address: pay_address.to_string(),
        partner_id: partner_id.to_string(),
        key: key.to_string(),
    })
}

fn waffo_pancake_topup_configured(merchant_id: &str, private_key: &str, product_id: &str) -> bool {
    waffo_pancake_creds_from_parts(merchant_id, private_key).is_ok()
        && validate_waffo_pancake_short_id("productId", product_id.trim(), "PROD").is_ok()
}

fn parse_payment_methods(raw: Option<&str>) -> Vec<Value> {
    match raw.and_then(|raw| serde_json::from_str::<Value>(raw).ok()) {
        Some(Value::Array(items)) => items,
        _ => Vec::new(),
    }
}

fn epay_payment_method_allowed(payment_method: &str, methods: &[Value]) -> bool {
    methods
        .iter()
        .any(|method| method.get("type").and_then(Value::as_str) == Some(payment_method))
}

fn epay_credit_quota(amount: i64, settings: &OnlineAmountSettings<'_>) -> i64 {
    if settings
        .quota_display_type
        .eq_ignore_ascii_case(QUOTA_DISPLAY_TYPE_TOKENS)
    {
        amount
    } else {
        (Decimal::from(amount) * settings.quota_per_unit)
            .trunc()
            .to_i64()
            .unwrap_or(i64::MAX)
    }
}

fn waffo_pancake_credit_quota(amount: i64, settings: &OnlineAmountSettings<'_>) -> i64 {
    if settings
        .quota_display_type
        .eq_ignore_ascii_case(QUOTA_DISPLAY_TYPE_TOKENS)
    {
        let normalized = (Decimal::from(amount) / settings.quota_per_unit)
            .trunc()
            .to_i64()
            .unwrap_or(0)
            .max(1);
        (Decimal::from(normalized) * settings.quota_per_unit)
            .trunc()
            .to_i64()
            .unwrap_or(i64::MAX)
    } else {
        (Decimal::from(amount) * settings.quota_per_unit)
            .trunc()
            .to_i64()
            .unwrap_or(i64::MAX)
    }
}

fn epay_trade_no(user_id: i64, now: i64) -> Option<String> {
    let suffix = random_base62(6)?;
    Some(format!("USR{user_id}NO{suffix}{now}"))
}

fn waffo_pancake_trade_no(user_id: i64) -> Option<String> {
    let suffix = random_base62(6)?;
    Some(format!(
        "WAFFO_PANCAKE-{user_id}-{}-{suffix}",
        unix_timestamp_millis()
    ))
}

fn waffo_pancake_buyer_identity(user_id: i64) -> String {
    format!("cinatoken-user-{user_id}")
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

fn resolve_frontend_base_url(env: &Env, req: &Request) -> Result<String, String> {
    let configured = env
        .var("FRONTEND_BASE_URL")
        .map(|value| value.to_string())
        .unwrap_or_default();
    if !configured.trim().is_empty() {
        return validate_http_base_url(configured.trim());
    }
    request_origin_base_url(req)
}

fn resolve_callback_base_url(
    env: &Env,
    req: &Request,
    custom_callback_address: Option<&str>,
) -> Result<String, String> {
    if let Some(value) = custom_callback_address
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return validate_http_base_url(value);
    }
    resolve_frontend_base_url(env, req)
}

fn request_origin_base_url(req: &Request) -> Result<String, String> {
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

fn validate_http_base_url(raw: &str) -> Result<String, String> {
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

fn epay_submit_url(pay_address: &str) -> Result<String, String> {
    let mut parsed =
        url::Url::parse(pay_address).map_err(|_| "Epay pay address is invalid".to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("Epay pay address must use http or https".to_string());
    }
    if parsed.host_str().is_none() || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Epay pay address must be an absolute public URL".to_string());
    }
    let base_path = parsed.path().trim_end_matches('/');
    let submit_path = if base_path.is_empty() {
        EPAY_SUBMIT_PATH.to_string()
    } else {
        format!("{base_path}{EPAY_SUBMIT_PATH}")
    };
    parsed.set_path(&submit_path);
    parsed.set_query(None);
    parsed.set_fragment(None);
    Ok(parsed.to_string())
}

fn epay_purchase_params(input: EpayPurchaseInput<'_>) -> BTreeMap<String, String> {
    let mut params = BTreeMap::from([
        ("pid".to_string(), input.partner_id.to_string()),
        ("type".to_string(), input.payment_method.to_string()),
        ("out_trade_no".to_string(), input.trade_no.to_string()),
        ("notify_url".to_string(), input.notify_url.to_string()),
        ("name".to_string(), input.name.to_string()),
        ("money".to_string(), input.money.to_string()),
        ("device".to_string(), "pc".to_string()),
        ("sign_type".to_string(), "MD5".to_string()),
        ("return_url".to_string(), input.return_url.to_string()),
        ("sign".to_string(), String::new()),
    ]);
    let sign = epay_sign(&params, input.key);
    params.insert("sign".to_string(), sign);
    params
}

fn epay_sign(params: &BTreeMap<String, String>, key: &str) -> String {
    let signing = epay_signing_string(params);
    format!("{:x}", md5::compute(format!("{signing}{key}")))
}

fn epay_signing_string(params: &BTreeMap<String, String>) -> String {
    params
        .iter()
        .filter(|(key, value)| {
            key.as_str() != "sign" && key.as_str() != "sign_type" && !value.is_empty()
        })
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("&")
}

fn epay_success_response(url: &str, params: &BTreeMap<String, String>) -> WorkerResult<Response> {
    let mut response = Response::from_json(&serde_json::json!({
        "message": "success",
        "data": params,
        "url": url,
    }))?
    .with_status(200);
    set_cors_headers(&mut response)?;
    Ok(response)
}

fn epay_error_response(message: &str) -> WorkerResult<Response> {
    let mut response = Response::from_json(&serde_json::json!({
        "message": "error",
        "data": message,
    }))?
    .with_status(200);
    set_cors_headers(&mut response)?;
    Ok(response)
}

async fn epay_notify_params(req: &mut Request) -> Result<BTreeMap<String, String>, String> {
    if req.method() == Method::Post {
        validate_epay_notify_content_length(req.headers().get("Content-Length").ok().flatten())?;
        let bytes = req
            .bytes()
            .await
            .map_err(|err| format!("failed to read Epay notify body: {err}"))?;
        if bytes.len() > EPAY_NOTIFY_BODY_LIMIT_BYTES {
            return Err(format!(
                "Epay notify body exceeds {EPAY_NOTIFY_BODY_LIMIT_BYTES} byte limit"
            ));
        }
        return Ok(parse_form_params(&bytes));
    }

    let url = req
        .url()
        .map_err(|err| format!("failed to read Epay notify URL: {err}"))?;
    Ok(url
        .query_pairs()
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect())
}

fn validate_epay_notify_content_length(value: Option<String>) -> Result<(), String> {
    let Some(value) = value else {
        return Err("Epay notify Content-Length is required".to_string());
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Epay notify Content-Length is required".to_string());
    }
    let len = trimmed
        .parse::<usize>()
        .map_err(|_| "Epay notify Content-Length is invalid".to_string())?;
    if len > EPAY_NOTIFY_BODY_LIMIT_BYTES {
        return Err(format!(
            "Epay notify body exceeds {EPAY_NOTIFY_BODY_LIMIT_BYTES} byte limit"
        ));
    }
    Ok(())
}

fn parse_form_params(bytes: &[u8]) -> BTreeMap<String, String> {
    url::form_urlencoded::parse(bytes)
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect()
}

fn verify_epay_notify(params: &BTreeMap<String, String>, key: &str) -> Option<EpayNotifyInfo> {
    let expected = epay_sign(params, key);
    let provided = params.get("sign")?;
    if !constant_time_str_eq(&expected, provided) {
        return None;
    }
    Some(EpayNotifyInfo {
        payment_method: params.get("type").cloned().unwrap_or_default(),
        trade_no: params.get("trade_no").cloned().unwrap_or_default(),
        out_trade_no: params.get("out_trade_no").cloned().unwrap_or_default(),
        money: params.get("money").cloned().unwrap_or_default(),
        trade_status: params.get("trade_status").cloned().unwrap_or_default(),
    })
}

fn is_completed_epay_replay(
    topup: &d1_repositories::TopupRow,
    info: &EpayNotifyInfo,
    expected_money: f64,
) -> bool {
    topup.status == TOPUP_STATUS_SUCCESS
        && topup.credited == 1
        && topup.payment_provider == PAYMENT_PROVIDER_EPAY
        && topup.payment_method == info.payment_method
        && (topup.money - expected_money).abs() < 0.000001
}

fn is_completed_waffo_pancake_replay(
    topup: &d1_repositories::TopupRow,
    expected_money: f64,
) -> bool {
    topup.status == TOPUP_STATUS_SUCCESS
        && topup.credited == 1
        && topup.payment_provider == PAYMENT_PROVIDER_WAFFO_PANCAKE
        && topup.payment_method == PAYMENT_PROVIDER_WAFFO_PANCAKE
        && (topup.money - expected_money).abs() < 0.000001
}

fn constant_time_str_eq(left: &str, right: &str) -> bool {
    let left = left.as_bytes();
    let right = right.as_bytes();
    let mut diff = left.len() ^ right.len();
    let max_len = left.len().max(right.len());
    for idx in 0..max_len {
        let a = left.get(idx).copied().unwrap_or(0);
        let b = right.get(idx).copied().unwrap_or(0);
        diff |= usize::from(a ^ b);
    }
    diff == 0
}

fn validate_waffo_pancake_webhook_content_length(value: Option<String>) -> Result<(), String> {
    let Some(value) = value else {
        return Ok(());
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    let len = trimmed
        .parse::<usize>()
        .map_err(|_| "Waffo Pancake webhook Content-Length is invalid".to_string())?;
    if len > WAFFO_PANCAKE_WEBHOOK_BODY_LIMIT_BYTES {
        return Err("Waffo Pancake webhook body too large".to_string());
    }
    Ok(())
}

fn epay_event_id(info: &EpayNotifyInfo) -> String {
    let provider_trade = if info.trade_no.is_empty() {
        "unknown"
    } else {
        &info.trade_no
    };
    format!(
        "{}:{}:{}",
        info.out_trade_no, provider_trade, info.trade_status
    )
}

fn waffo_pancake_event_id(event: &WaffoPancakeWebhookEvent, payload: &str) -> String {
    let id = event.id.trim();
    if !id.is_empty() {
        return id.to_string();
    }
    let event_id = event.event_id.trim();
    if !event_id.is_empty() {
        return event_id.to_string();
    }
    format!("payload:{}", hex_lower(&Sha256::digest(payload.as_bytes())))
}

fn parse_waffo_pancake_event_money(raw: &str) -> Option<f64> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    raw.parse::<f64>().ok().filter(|value| value.is_finite())
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
    use std::collections::BTreeMap;

    use super::{
        constant_time_str_eq, discount_for_amount, epay_credit_quota, epay_payment_method_allowed,
        epay_purchase_params, epay_sign, epay_signing_string, epay_submit_url,
        filter_active_waffo_pancake_products, format_pay_money, is_completed_epay_replay,
        is_completed_waffo_pancake_replay, normalize_waffo_pancake_private_key,
        normalize_waffo_pancake_public_key, online_min_topup, online_pay_money,
        optional_waffo_pancake_string, parse_form_params, parse_optional_json_bytes,
        parse_payment_methods, parse_waffo_pancake_event_money,
        parse_waffo_pancake_signature_header, request_amount, sanitize_like_pattern,
        topup_group_ratio_for_group, topup_status_label, validate_epay_notify_content_length,
        validate_waffo_pancake_admin_content_length, validate_waffo_pancake_amount,
        validate_waffo_pancake_short_id, validate_waffo_pancake_webhook_content_length,
        verify_epay_notify, waffo_pancake_buyer_identity, waffo_pancake_config_updates,
        waffo_pancake_credit_quota, waffo_pancake_creds_from_parts, waffo_pancake_event_id,
        waffo_pancake_idempotency_key, waffo_pancake_signature_input,
        waffo_pancake_subscription_options, waffo_pancake_topup_configured, EpayNotifyInfo,
        EpayPurchaseInput, OnlineAmountSettings, SaveWaffoPancakeConfigRequest,
        WaffoPancakeCatalog, WaffoPancakeCatalogProduct, WaffoPancakeCatalogStore,
        WaffoPancakeCreateOnetimeProductBody, WaffoPancakePriceInfo, WaffoPancakeWebhookData,
        WaffoPancakeWebhookEvent, EPAY_NOTIFY_BODY_LIMIT_BYTES, PAYMENT_PROVIDER_EPAY,
        PAYMENT_PROVIDER_WAFFO_PANCAKE, TOPUP_STATUS_SUCCESS, WAFFO_PANCAKE_ADMIN_BODY_LIMIT_BYTES,
        WAFFO_PANCAKE_CREATE_ONETIME_PRODUCT_PATH, WAFFO_PANCAKE_MERCHANT_ID_KEY,
        WAFFO_PANCAKE_PRIVATE_KEY_KEY, WAFFO_PANCAKE_PRODUCT_ID_KEY, WAFFO_PANCAKE_RETURN_URL_KEY,
        WAFFO_PANCAKE_STORE_ID_KEY, WAFFO_PANCAKE_TAX_CATEGORY_SAAS,
        WAFFO_PANCAKE_WEBHOOK_BODY_LIMIT_BYTES,
    };
    use crate::d1_repositories::TopupRow;
    use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
    use rust_decimal::Decimal;
    use sha2::{Digest, Sha256};

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
    fn epay_sign_matches_go_sdk_md5_golden() {
        let params = BTreeMap::from([
            ("device".to_string(), "devicev".to_string()),
            ("money".to_string(), "moneyv".to_string()),
            ("sign".to_string(), String::new()),
            ("sign_type".to_string(), "MD5".to_string()),
        ]);

        assert_eq!(epay_signing_string(&params), "device=devicev&money=moneyv");
        assert_eq!(
            epay_sign(&params, "1234567"),
            "3854cc9f022e0fb821bd2e002260245d"
        );
    }

    #[test]
    fn epay_purchase_params_match_sdk_shape() {
        let params = epay_purchase_params(EpayPurchaseInput {
            partner_id: "pid",
            key: "secret",
            payment_method: "alipay",
            trade_no: "USR1NOabc123",
            name: "TUC100",
            money: "7.30",
            notify_url: "https://example.com/api/user/epay/notify",
            return_url: "https://example.com/usage-logs",
        });

        assert_eq!(params["pid"], "pid");
        assert_eq!(params["type"], "alipay");
        assert_eq!(params["out_trade_no"], "USR1NOabc123");
        assert_eq!(params["device"], "pc");
        assert_eq!(params["sign_type"], "MD5");
        assert_eq!(
            epay_submit_url("https://pay.example.com/base").unwrap(),
            "https://pay.example.com/base/submit.php"
        );
        assert!(!params["sign"].is_empty());
    }

    #[test]
    fn epay_form_and_notify_helpers_match_sdk_filtering() {
        let mut params = parse_form_params(
            b"pid=pid&type=alipay&out_trade_no=NO1&money=7.30&trade_status=TRADE_SUCCESS&empty=",
        );
        let sign = epay_sign(&params, "key");
        params.insert("sign".to_string(), sign);
        params.insert("sign_type".to_string(), "MD5".to_string());

        let info = verify_epay_notify(&params, "key").unwrap();
        assert_eq!(info.payment_method, "alipay");
        assert_eq!(info.out_trade_no, "NO1");
        assert_eq!(info.money, "7.30");
        assert_eq!(info.trade_status, "TRADE_SUCCESS");
        assert!(validate_epay_notify_content_length(None).is_err());
        assert!(validate_epay_notify_content_length(Some(" ".to_string())).is_err());
        assert!(validate_epay_notify_content_length(Some(
            EPAY_NOTIFY_BODY_LIMIT_BYTES.to_string()
        ))
        .is_ok());
        assert!(validate_epay_notify_content_length(Some(
            (EPAY_NOTIFY_BODY_LIMIT_BYTES + 1).to_string()
        ))
        .is_err());
    }

    #[test]
    fn epay_notify_rejects_bad_signature_with_constant_time_helper() {
        assert!(constant_time_str_eq(
            "3854cc9f022e0fb821bd2e002260245d",
            "3854cc9f022e0fb821bd2e002260245d"
        ));
        assert!(!constant_time_str_eq(
            "3854cc9f022e0fb821bd2e002260245d",
            "3854cc9f022e0fb821bd2e002260245e"
        ));
        assert!(!constant_time_str_eq(
            "3854cc9f022e0fb821bd2e002260245d",
            "short"
        ));

        let mut params = parse_form_params(
            b"pid=pid&type=alipay&out_trade_no=NO1&money=7.30&trade_status=TRADE_SUCCESS",
        );
        params.insert("sign".to_string(), "bad-signature".to_string());

        assert!(verify_epay_notify(&params, "key").is_none());
    }

    #[test]
    fn epay_replay_requires_completed_credited_matching_topup() {
        fn topup(provider: &str, method: &str, money: f64, status: i32, credited: i32) -> TopupRow {
            TopupRow {
                id: 1,
                user_id: 2,
                amount: 500_000,
                money,
                trade_no: "USR2NOabc123".to_string(),
                payment_method: method.to_string(),
                payment_provider: provider.to_string(),
                status,
                create_time: 10,
                complete_time: 20,
                credited,
            }
        }

        let info = EpayNotifyInfo {
            payment_method: "alipay".to_string(),
            trade_no: "EPAY123".to_string(),
            out_trade_no: "USR2NOabc123".to_string(),
            money: "7.30".to_string(),
            trade_status: "TRADE_SUCCESS".to_string(),
        };

        assert!(is_completed_epay_replay(
            &topup(
                PAYMENT_PROVIDER_EPAY,
                "alipay",
                7.30,
                TOPUP_STATUS_SUCCESS,
                1
            ),
            &info,
            7.30
        ));
        assert!(!is_completed_epay_replay(
            &topup("stripe", "alipay", 7.30, TOPUP_STATUS_SUCCESS, 1),
            &info,
            7.30
        ));
        assert!(!is_completed_epay_replay(
            &topup(
                PAYMENT_PROVIDER_EPAY,
                "wxpay",
                7.30,
                TOPUP_STATUS_SUCCESS,
                1
            ),
            &info,
            7.30
        ));
        assert!(!is_completed_epay_replay(
            &topup(
                PAYMENT_PROVIDER_EPAY,
                "alipay",
                7.31,
                TOPUP_STATUS_SUCCESS,
                1
            ),
            &info,
            7.30
        ));
        assert!(!is_completed_epay_replay(
            &topup(PAYMENT_PROVIDER_EPAY, "alipay", 7.30, 0, 0),
            &info,
            7.30
        ));
    }

    #[test]
    fn epay_method_allowlist_and_credit_quota_match_go_translation() {
        let methods = parse_payment_methods(Some(
            r#"[{"type":"alipay"},{"type":"wxpay","name":"WeChat"}]"#,
        ));
        assert!(epay_payment_method_allowed("alipay", &methods));
        assert!(!epay_payment_method_allowed("stripe", &methods));

        let currency_settings = OnlineAmountSettings {
            min_topup: 1,
            price: decimal("7.3"),
            quota_per_unit: decimal("500000"),
            topup_group_ratio: Decimal::ONE,
            quota_display_type: "USD",
            discount: Decimal::ONE,
        };
        assert_eq!(epay_credit_quota(2, &currency_settings), 1_000_000);

        let token_settings = OnlineAmountSettings {
            quota_display_type: "TOKENS",
            ..currency_settings
        };
        assert_eq!(epay_credit_quota(500_000, &token_settings), 500_000);
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
    fn waffo_pancake_credit_quota_matches_go_recharge_normalization() {
        let currency_settings = OnlineAmountSettings {
            min_topup: 1,
            price: decimal("1"),
            quota_per_unit: decimal("500000"),
            topup_group_ratio: Decimal::ONE,
            quota_display_type: "USD",
            discount: Decimal::ONE,
        };
        assert_eq!(waffo_pancake_credit_quota(2, &currency_settings), 1_000_000);

        let token_settings = OnlineAmountSettings {
            quota_display_type: "TOKENS",
            ..currency_settings
        };
        assert_eq!(
            waffo_pancake_credit_quota(499_999, &token_settings),
            500_000
        );
        assert_eq!(
            waffo_pancake_credit_quota(500_000, &token_settings),
            500_000
        );
        assert_eq!(
            waffo_pancake_credit_quota(1_250_000, &token_settings),
            1_000_000
        );
    }

    #[test]
    fn waffo_pancake_identity_and_gateway_config_match_go_contract() {
        assert_eq!(waffo_pancake_buyer_identity(42), "cinatoken-user-42");
        assert!(waffo_pancake_topup_configured(
            "MER_merchant",
            "private",
            "PROD_1234567890123456789012"
        ));
        assert!(!waffo_pancake_topup_configured(
            "MER_merchant",
            "",
            "PROD_1234567890123456789012"
        ));
        assert!(!waffo_pancake_topup_configured(
            "MER_merchant",
            "private",
            "not-a-product"
        ));
    }

    #[test]
    fn waffo_pancake_webhook_signature_header_and_limits_match_sdk_shape() {
        let (timestamp, signature) =
            parse_waffo_pancake_signature_header("t=1700000,v1=abc").unwrap();
        assert_eq!(timestamp, "1700000");
        assert_eq!(signature, "abc");
        assert!(parse_waffo_pancake_signature_header("garbage").is_err());
        assert!(validate_waffo_pancake_webhook_content_length(None).is_ok());
        assert!(validate_waffo_pancake_webhook_content_length(Some("64".to_string())).is_ok());
        assert!(validate_waffo_pancake_webhook_content_length(Some(
            (WAFFO_PANCAKE_WEBHOOK_BODY_LIMIT_BYTES + 1).to_string()
        ))
        .is_err());
    }

    #[test]
    fn waffo_pancake_webhook_event_helpers_are_stable() {
        let payload = r#"{"eventType":"order.completed"}"#;
        let event = WaffoPancakeWebhookEvent {
            id: "evt_1".to_string(),
            timestamp: String::new(),
            event_type: "order.completed".to_string(),
            event_id: "PAY_1".to_string(),
            store_id: String::new(),
            store_name: String::new(),
            mode: "prod".to_string(),
            data: WaffoPancakeWebhookData::default(),
        };
        assert_eq!(waffo_pancake_event_id(&event, payload), "evt_1");

        let fallback = WaffoPancakeWebhookEvent {
            id: String::new(),
            event_id: String::new(),
            ..event
        };
        assert!(waffo_pancake_event_id(&fallback, payload).starts_with("payload:"));
        assert_eq!(parse_waffo_pancake_event_money("1.20"), Some(1.2));
        assert_eq!(parse_waffo_pancake_event_money(""), None);
        assert_eq!(parse_waffo_pancake_event_money("nan"), None);
    }

    #[test]
    fn waffo_pancake_replay_requires_completed_provider_method_and_money() {
        fn topup(provider: &str, money: f64) -> TopupRow {
            TopupRow {
                id: 1,
                user_id: 2,
                amount: 500_000,
                money,
                trade_no: "WAFFO_PANCAKE-2-1700000000000-abc123".to_string(),
                payment_method: PAYMENT_PROVIDER_WAFFO_PANCAKE.to_string(),
                payment_provider: provider.to_string(),
                status: TOPUP_STATUS_SUCCESS,
                create_time: 10,
                complete_time: 20,
                credited: 1,
            }
        }
        assert!(is_completed_waffo_pancake_replay(
            &topup(PAYMENT_PROVIDER_WAFFO_PANCAKE, 7.3),
            7.3
        ));
        assert!(!is_completed_waffo_pancake_replay(
            &topup(PAYMENT_PROVIDER_EPAY, 7.3),
            7.3
        ));
        assert!(!is_completed_waffo_pancake_replay(
            &topup(PAYMENT_PROVIDER_WAFFO_PANCAKE, 7.3),
            7.31
        ));
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
    fn optional_json_body_accepts_empty_or_object() {
        assert_eq!(
            parse_optional_json_bytes(b"").unwrap(),
            serde_json::json!({})
        );
        assert_eq!(
            parse_optional_json_bytes(br#"{"merchant_id":"m"}"#).unwrap(),
            serde_json::json!({"merchant_id": "m"})
        );
        assert!(parse_optional_json_bytes(b"{").is_err());
        assert!(
            parse_optional_json_bytes(&vec![b' '; WAFFO_PANCAKE_ADMIN_BODY_LIMIT_BYTES + 1])
                .is_err()
        );
    }

    #[test]
    fn optional_json_content_length_is_bounded_before_reading() {
        assert!(validate_waffo_pancake_admin_content_length(None).is_ok());
        assert!(validate_waffo_pancake_admin_content_length(Some(" 64 ")).is_ok());
        assert!(validate_waffo_pancake_admin_content_length(Some("not-a-number")).is_err());
        assert!(validate_waffo_pancake_admin_content_length(Some(
            &(WAFFO_PANCAKE_ADMIN_BODY_LIMIT_BYTES + 1).to_string()
        ))
        .is_err());
    }

    #[test]
    fn waffo_pancake_credentials_require_both_fields() {
        assert_eq!(
            waffo_pancake_creds_from_parts(" merchant ", " key ")
                .unwrap()
                .merchant_id,
            "merchant"
        );
        assert!(waffo_pancake_creds_from_parts("", "key").is_err());
        assert!(waffo_pancake_creds_from_parts("merchant", "").is_err());
    }

    #[test]
    fn waffo_pancake_signature_input_matches_sdk_canonical_shape() {
        let body = br#"{"query":"query { stores { id } }"}"#;
        let expected_hash = BASE64_STANDARD.encode(Sha256::digest(body));
        assert_eq!(
            waffo_pancake_signature_input("POST", "/v1/graphql", "1700000000", body),
            format!("POST\n/v1/graphql\n1700000000\n{expected_hash}")
        );
    }

    #[test]
    fn waffo_pancake_idempotency_key_matches_sdk_shape() {
        let body = br#"{"name":"cinatoken-store"}"#;
        let input = [
            b"merchant".as_slice(),
            b":",
            WAFFO_PANCAKE_CREATE_ONETIME_PRODUCT_PATH.as_bytes(),
            b":",
            body,
        ]
        .concat();
        let expected = format!("{:x}", Sha256::digest(&input));
        assert_eq!(
            waffo_pancake_idempotency_key(
                "merchant",
                WAFFO_PANCAKE_CREATE_ONETIME_PRODUCT_PATH,
                body
            ),
            expected
        );
    }

    #[test]
    fn waffo_pancake_sdk_validation_helpers_match_source_bounds() {
        assert!(
            validate_waffo_pancake_short_id("storeId", "STO_1234567890123456789012", "STO").is_ok()
        );
        assert!(
            validate_waffo_pancake_short_id("storeId", "PROD_1234567890123456789012", "STO")
                .is_err()
        );
        assert!(validate_waffo_pancake_short_id("storeId", "STO_short", "STO").is_err());
        assert!(validate_waffo_pancake_amount("amount", "1").is_ok());
        assert!(validate_waffo_pancake_amount("amount", "1.00").is_ok());
        assert!(validate_waffo_pancake_amount("amount", ".5").is_err());
        assert!(validate_waffo_pancake_amount("amount", "1.").is_err());
        assert!(validate_waffo_pancake_amount("amount", "1a").is_err());
    }

    #[test]
    fn waffo_pancake_product_body_serializes_success_url_like_sdk() {
        let mut prices = BTreeMap::new();
        prices.insert(
            "USD".to_string(),
            WaffoPancakePriceInfo {
                amount: "1.00".to_string(),
                tax_category: WAFFO_PANCAKE_TAX_CATEGORY_SAAS,
            },
        );
        let body = WaffoPancakeCreateOnetimeProductBody {
            store_id: "STO_1234567890123456789012".to_string(),
            name: "plan".to_string(),
            prices,
            success_url: optional_waffo_pancake_string("  "),
        };
        let value = serde_json::to_value(&body).unwrap();
        assert_eq!(value["storeId"], "STO_1234567890123456789012");
        assert!(value.get("successUrl").is_none());

        let with_url = WaffoPancakeCreateOnetimeProductBody {
            success_url: optional_waffo_pancake_string(" https://example.com/ok "),
            ..body
        };
        let value = serde_json::to_value(&with_url).unwrap();
        assert_eq!(value["successUrl"], "https://example.com/ok");
        assert_eq!(value["prices"]["USD"]["taxCategory"], "saas");
    }

    #[test]
    fn waffo_pancake_private_key_normalization_accepts_raw_base64() {
        let raw = BASE64_STANDARD.encode([1_u8, 2, 3, 4]);
        let normalized = normalize_waffo_pancake_private_key(&raw).unwrap();
        assert!(normalized.starts_with("-----BEGIN PRIVATE KEY-----\n"));
        assert!(normalized.ends_with("\n-----END PRIVATE KEY-----"));
    }

    #[test]
    fn waffo_pancake_public_key_normalization_accepts_raw_base64() {
        let raw = BASE64_STANDARD.encode([1_u8, 2, 3, 4]);
        let normalized = normalize_waffo_pancake_public_key(&raw).unwrap();
        assert!(normalized.starts_with("-----BEGIN PUBLIC KEY-----\n"));
        assert!(normalized.ends_with("\n-----END PUBLIC KEY-----"));
    }

    #[test]
    fn waffo_pancake_catalog_filters_to_active_products() {
        let mut catalog = WaffoPancakeCatalog {
            stores: vec![WaffoPancakeCatalogStore {
                id: "store".to_string(),
                name: "Store".to_string(),
                status: "active".to_string(),
                prod_enabled: true,
                onetime_products: vec![
                    WaffoPancakeCatalogProduct {
                        id: "active".to_string(),
                        name: "Active".to_string(),
                        status: " active ".to_string(),
                    },
                    WaffoPancakeCatalogProduct {
                        id: "draft".to_string(),
                        name: "Draft".to_string(),
                        status: "draft".to_string(),
                    },
                ],
            }],
        };

        filter_active_waffo_pancake_products(&mut catalog);

        assert_eq!(
            catalog.stores[0].onetime_products,
            vec![WaffoPancakeCatalogProduct {
                id: "active".to_string(),
                name: "Active".to_string(),
                status: " active ".to_string(),
            }]
        );
    }

    #[test]
    fn waffo_pancake_subscription_options_select_saved_store() {
        let catalog = WaffoPancakeCatalog {
            stores: vec![
                WaffoPancakeCatalogStore {
                    id: "other".to_string(),
                    name: String::new(),
                    status: String::new(),
                    prod_enabled: true,
                    onetime_products: vec![WaffoPancakeCatalogProduct {
                        id: "p1".to_string(),
                        name: "P1".to_string(),
                        status: "active".to_string(),
                    }],
                },
                WaffoPancakeCatalogStore {
                    id: "saved".to_string(),
                    name: String::new(),
                    status: String::new(),
                    prod_enabled: true,
                    onetime_products: vec![WaffoPancakeCatalogProduct {
                        id: "p2".to_string(),
                        name: "P2".to_string(),
                        status: "active".to_string(),
                    }],
                },
            ],
        };

        let options = waffo_pancake_subscription_options(&catalog, "saved");

        assert_eq!(options.store_id, "saved");
        assert_eq!(options.products[0].id, "p2");
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
