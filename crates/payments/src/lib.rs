use async_trait::async_trait;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use thiserror::Error;

type HmacSha256 = Hmac<Sha256>;

/// Webhook timestamp tolerance in seconds (5 minutes, matching Stripe's
/// default). Mirrors Go's `webhook.ConstructEventWithOptions` tolerance.
pub const STRIPE_WEBHOOK_TOLERANCE_SECONDS: u64 = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PaymentProvider {
    Balance,
    Stripe,
    Creem,
    Epay,
    Waffo,
    WaffoPancake,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PaymentStatus {
    Created,
    Pending,
    Paid,
    Failed,
    Cancelled,
    Refunded,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaymentEvent {
    pub provider: PaymentProvider,
    pub event_id: String,
    pub order_id: String,
    pub status: PaymentStatus,
    pub amount: String,
    pub currency: String,
}

#[async_trait(?Send)]
pub trait PaymentEventStore {
    async fn was_processed(
        &self,
        provider: PaymentProvider,
        event_id: &str,
    ) -> cinatoken_core::ApiResult<bool>;
    async fn mark_processed(&self, event: &PaymentEvent) -> cinatoken_core::ApiResult<()>;
}

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------

/// Stripe payment configuration loaded from D1 options. The operator sets
/// these via `PUT /api/option/` with keys `StripeApiSecret`,
/// `StripeWebhookSecret`, `StripeUnitPrice`, `StripeMinTopUp`.
#[derive(Debug, Clone)]
pub struct StripeConfig {
    pub api_secret: String,
    pub webhook_secret: String,
    /// USD → quota conversion ratio. Default 8.0 (matching Go).
    pub unit_price: f64,
    /// Minimum topup amount in USD. Default 1.0.
    pub min_topup: f64,
}

impl Default for StripeConfig {
    fn default() -> Self {
        Self {
            api_secret: String::new(),
            webhook_secret: String::new(),
            unit_price: 8.0,
            min_topup: 1.0,
        }
    }
}

impl StripeConfig {
    /// Returns `true` when Stripe is enabled (API secret is present).
    pub fn is_enabled(&self) -> bool {
        !self.api_secret.is_empty() && !self.webhook_secret.is_empty()
    }

    /// Compute the quota to credit for a given USD amount.
    /// `quota = money * unit_price * QuotaPerUnit` (500_000).
    ///
    /// Truncates toward zero to match Go, which credits `int(Money *
    /// QuotaPerUnit)` (Stripe `Recharge`) and `decimal(...).IntPart()` (manual /
    /// decimal top-up paths) — neither rounds. Rounding would create ±1 quota
    /// drift on fractional-cent credits. See
    /// docs/source-payment-idempotency-parity.md and
    /// docs/source-pricing-ratio-parity.md.
    pub fn money_to_quota(&self, money: f64) -> i64 {
        (money * self.unit_price * 500_000.0).trunc() as i64
    }
}

/// Parameters for creating a Stripe Checkout Session.
#[derive(Debug, Clone)]
pub struct StripeCheckoutRequest {
    /// Amount in USD cents (e.g. 500 = $5.00).
    pub amount_cents: u64,
    pub currency: String,
    pub success_url: String,
    pub cancel_url: String,
    /// Internal order reference (trade_no), passed through as
    /// `client_reference_id` so the webhook can match it.
    pub reference_id: String,
}

/// Result of a successful checkout session creation.
#[derive(Debug, Clone)]
pub struct StripeCheckoutResult {
    /// The hosted checkout URL the client should redirect to.
    pub checkout_url: String,
    /// The Stripe session ID.
    pub session_id: String,
}

/// Parse a Stripe webhook signature header into (timestamp, signatures).
/// Format: `t=1614631200,v1=abc123,v1=def456`.
pub fn parse_stripe_signature(header: &str) -> Result<(u64, Vec<Vec<u8>>), StripeWebhookError> {
    let mut timestamp: Option<u64> = None;
    let mut signatures: Vec<Vec<u8>> = Vec::new();
    for part in header.split(',') {
        let part = part.trim();
        if let Some(rest) = part.strip_prefix("t=") {
            timestamp =
                Some(rest.parse::<u64>().map_err(|_| {
                    StripeWebhookError::InvalidSignature("invalid timestamp".into())
                })?);
        } else if let Some(rest) = part.strip_prefix("v1=") {
            let sig = hex_decode(rest)?;
            signatures.push(sig);
        }
    }
    let timestamp = timestamp
        .ok_or_else(|| StripeWebhookError::InvalidSignature("missing timestamp".into()))?;
    if signatures.is_empty() {
        return Err(StripeWebhookError::InvalidSignature(
            "no v1 signatures".into(),
        ));
    }
    Ok((timestamp, signatures))
}

/// Verify a Stripe webhook payload against the signing secret. Returns the
/// verified payload as a JSON Value on success. Mirrors Go's
/// `webhook.ConstructEventWithOptions` with tolerance.
pub fn verify_stripe_webhook(
    config: &StripeConfig,
    payload: &[u8],
    signature_header: &str,
    tolerance_seconds: u64,
) -> Result<StripeWebhookEvent, StripeWebhookError> {
    let (timestamp, signatures) = parse_stripe_signature(signature_header)?;

    // Tolerance check: reject if the timestamp is too far in the past.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(timestamp);
    if now.saturating_sub(timestamp) > tolerance_seconds {
        return Err(StripeWebhookError::TimestampOutsideTolerance);
    }

    // Compute expected signature: HMAC-SHA256(secret, "{timestamp}.{payload}")
    let signed_payload = format!(
        "{}.{}",
        timestamp,
        std::str::from_utf8(payload).unwrap_or("")
    );
    let mut mac = HmacSha256::new_from_slice(config.webhook_secret.as_bytes())
        .expect("HMAC accepts any key length");
    mac.update(signed_payload.as_bytes());
    let expected = mac.finalize().into_bytes();

    // Check if any provided signature matches.
    let valid = signatures.iter().any(|sig| {
        sig.len() == expected.len() && {
            // Constant-time comparison.
            let mut mac = HmacSha256::new_from_slice(config.webhook_secret.as_bytes())
                .expect("HMAC accepts any key length");
            mac.update(signed_payload.as_bytes());
            mac.verify_slice(sig).is_ok()
        }
    });
    if !valid {
        return Err(StripeWebhookError::InvalidSignature(
            "no matching signature".into(),
        ));
    }

    let event: StripeWebhookEvent = serde_json::from_slice(payload)
        .map_err(|err| StripeWebhookError::InvalidPayload(err.to_string()))?;
    Ok(event)
}

/// Decoded Stripe webhook event. Only the fields needed by the topup flow
/// are extracted.
#[derive(Debug, Clone, Deserialize)]
pub struct StripeWebhookEvent {
    pub id: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub data: StripeWebhookData,
}

#[derive(Debug, Clone, Deserialize)]
pub struct StripeWebhookData {
    pub object: StripeCheckoutObject,
}

#[derive(Debug, Clone, Deserialize)]
pub struct StripeCheckoutObject {
    /// Matches the `reference_id` we set during checkout creation.
    #[serde(default)]
    pub client_reference_id: Option<String>,
    /// Stripe customer id attached to the Checkout Session, when present.
    #[serde(default)]
    pub customer: Option<String>,
    /// Total paid in cents.
    #[serde(default)]
    pub amount_total: Option<u64>,
    /// Currency code (usd).
    #[serde(default)]
    pub currency: Option<String>,
    /// Payment status (paid, unpaid, no_payment_required).
    #[serde(default)]
    pub payment_status: Option<String>,
}

/// Errors that can occur during Stripe webhook verification.
#[derive(Debug, Error)]
pub enum StripeWebhookError {
    #[error("invalid signature: {0}")]
    InvalidSignature(String),
    #[error("timestamp outside tolerance window")]
    TimestampOutsideTolerance,
    #[error("invalid payload: {0}")]
    InvalidPayload(String),
    #[error("hex decode error")]
    HexDecode,
}

fn hex_decode(hex: &str) -> Result<Vec<u8>, StripeWebhookError> {
    (0..hex.len())
        .step_by(2)
        .map(|i| {
            u8::from_str_radix(hex.get(i..i + 2).ok_or(StripeWebhookError::HexDecode)?, 16)
                .map_err(|_| StripeWebhookError::HexDecode)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stripe_config_default_unit_price() {
        let config = StripeConfig::default();
        assert_eq!(config.unit_price, 8.0);
        assert_eq!(config.min_topup, 1.0);
    }

    #[test]
    fn money_to_quota_conversion() {
        let config = StripeConfig {
            api_secret: "sk_test".into(),
            webhook_secret: "whsec".into(),
            unit_price: 8.0,
            min_topup: 1.0,
        };
        // $5.00 * 8.0 * 500_000 = 20_000_000
        assert_eq!(config.money_to_quota(5.0), 20_000_000);
        // $1.00 * 8.0 * 500_000 = 4_000_000
        assert_eq!(config.money_to_quota(1.0), 4_000_000);
    }

    #[test]
    fn money_to_quota_truncates_toward_zero_like_go() {
        // Go credits `int(Money * QuotaPerUnit)` (Stripe `Recharge`) and
        // `decimal(...).IntPart()` (manual / decimal top-up paths); both
        // truncate toward zero, they do not round. A fractional-cent `Money`
        // (group-ratio-converted USD) can land on a non-integer quota, where
        // truncate and round diverge.
        let config = StripeConfig::default(); // unit_price = 8.0, QuotaPerUnit = 500_000
                                              // 0.25000015 * 8.0 * 500_000 = 1_000_000.6
        let money = 0.25000015;
        let raw = money * config.unit_price * 500_000.0;
        assert!((raw - 1_000_000.6).abs() < 1e-6, "raw product = {raw}");
        // Go truncates -> 1_000_000; a `.round()` impl would over-credit by 1.
        assert_eq!(config.money_to_quota(money), 1_000_000);
        assert_eq!(raw.round() as i64, 1_000_001);
    }

    #[test]
    fn is_enabled_requires_both_secrets() {
        let mut config = StripeConfig::default();
        assert!(!config.is_enabled());
        config.api_secret = "sk_test".into();
        assert!(!config.is_enabled());
        config.webhook_secret = "whsec".into();
        assert!(config.is_enabled());
    }

    #[test]
    fn parse_stripe_signature_valid() {
        let header = "t=1614631200,v1=abc123,v1=def456";
        let (ts, sigs) = parse_stripe_signature(header).unwrap();
        assert_eq!(ts, 1614631200);
        assert_eq!(sigs.len(), 2);
    }

    #[test]
    fn parse_stripe_signature_missing_timestamp() {
        assert!(parse_stripe_signature("v1=abc123").is_err());
    }

    #[test]
    fn parse_stripe_signature_missing_signatures() {
        assert!(parse_stripe_signature("t=1614631200").is_err());
    }

    #[test]
    fn verify_rejects_bad_signature() {
        let config = StripeConfig {
            api_secret: "sk_test".into(),
            webhook_secret: "secret".into(),
            unit_price: 8.0,
            min_topup: 1.0,
        };
        let payload =
            b"{\"id\":\"evt_1\",\"type\":\"checkout.session.completed\",\"data\":{\"object\":{}}}";
        let header =
            "t=9999999999,v1=0000000000000000000000000000000000000000000000000000000000000000";
        let result = verify_stripe_webhook(&config, payload, header, 3600);
        assert!(matches!(
            result,
            Err(StripeWebhookError::InvalidSignature(_))
        ));
    }

    #[test]
    fn hex_decode_valid_and_invalid() {
        assert_eq!(hex_decode("48656c6c6f").unwrap(), b"Hello");
        assert!(hex_decode("xyz").is_err());
        assert!(hex_decode("123").is_err()); // odd length
    }
}
