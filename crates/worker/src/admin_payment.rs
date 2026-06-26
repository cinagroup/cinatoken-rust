//! Stripe topup handlers (Scenario C MVP).
//!
//! Three routes:
//! - `POST /api/user/stripe/pay` — create a Stripe Checkout Session and
//!   return the redirect URL. UserAuth.
//! - `POST /api/stripe/webhook` — receive and verify a Stripe webhook,
//!   complete the topup, credit quota. Public (no auth — signature-based).
//! - `GET /api/user/topup` — list the user's recent topups. UserAuth.

use cinatoken_payments::{
    verify_stripe_webhook, StripeWebhookError, STRIPE_WEBHOOK_TOLERANCE_SECONDS,
};
use serde::Serialize;
use serde_json::Value;
use worker::{Env, Fetch, Headers, Method, Request, Response, Result as WorkerResult};

use crate::admin::{
    envelope_error_response, envelope_ok_response, read_json_body, require_user_auth,
    unix_timestamp,
};
use crate::d1_repositories;

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
    let amount: f64 = body.get("amount").and_then(Value::as_f64).unwrap_or(0.0);
    if amount <= 0.0 {
        return Ok(envelope_error_response(400, "amount must be positive"));
    }

    let db = env.d1("DB")?;
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
        return Ok(envelope_error_response(500, "failed to record pending topup"));
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
        checkout_url,
        session_id,
        trade_no,
    })?)
}

/// `POST /api/stripe/webhook`: receive and process a Stripe webhook.
/// Public route — security relies on HMAC-SHA256 signature verification.
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

/// `GET /api/user/topup`: list the user's recent topup records.
pub async fn list_topups(req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let db = env.d1("DB")?;
    let limit: u32 = req
        .url()
        .ok()
        .and_then(|u| {
            u.query_pairs()
                .find(|(k, _)| k == "limit")
                .and_then(|(_, v)| v.parse().ok())
        })
        .unwrap_or(20);
    let topups = d1_repositories::list_user_topups(&db, claims.id, limit).await?;
    Ok(envelope_ok_response(&topups)?)
}

#[derive(Debug, Serialize)]
struct StripePayResponse {
    checkout_url: String,
    session_id: String,
    trade_no: String,
}
