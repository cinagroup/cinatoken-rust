use async_trait::async_trait;
use serde::{Deserialize, Serialize};

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
