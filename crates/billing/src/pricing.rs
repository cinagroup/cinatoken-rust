//! Non-tiered pricing configuration and per-model ratio lookups.
//!
//! Ports the Go gateway's `setting/ratio_setting/` package's core lookup
//! logic. The configuration is loaded from D1 options in the Worker layer
//! and passed into this module as parsed JSON maps, keeping the billing
//! crate free of Worker bindings so it can be unit-tested on the host.
//!
//! ## Option keys (read by the Worker caller)
//!
//! - `ModelRatio` — JSON map `{model: ratio}`. Per-token prompt multiplier.
//!   `1 ratio === $0.002 / 1K tokens`; `QuotaPerUnit = 500_000`.
//! - `CompletionRatio` — JSON map `{model: ratio}`. Completion token
//!   multiplier relative to prompt. Default 1.0 when absent.
//! - `ModelPrice` — JSON map `{model: usd_price}`. Fixed per-request USD
//!   price. Presence switches the model to flat-price mode.
//! - `CacheRatio` — JSON map `{model: ratio}`. Discount multiplier for
//!   cached prompt tokens. Default 1.0 (no discount).
//! - `group_ratio_setting.group_ratio` — JSON map `{group: ratio}`.
//!   Per-group multiplier. Default 1.0.
//! - `QuotaPerUnit` — scalar. `$1 = QuotaPerUnit quota`. Default 500_000.
//!
//! ## Not implemented here (deferred)
//!
//! - Hardcoded completion-ratio prefix table (`gpt-4o* → 4`, `claude-* → 5`,
//!   ...). Operators must configure `CompletionRatio` explicitly for models
//!   with completion premiums. Default is 1.0 (prompt == completion price).
//! - `CacheCreation5mRatio` / `CacheCreation1hRatio` split. A single
//!   `create_cache_ratio` is used instead.

use std::collections::HashMap;

use crate::DEFAULT_QUOTA_PER_UNIT;

/// Per-model pricing configuration. All maps use the model name as key.
/// Empty maps fall back to the documented defaults.
#[derive(Debug, Clone, Default)]
pub struct PricingConfig {
    pub model_ratios: HashMap<String, f64>,
    pub completion_ratios: HashMap<String, f64>,
    pub model_prices: HashMap<String, f64>,
    pub cache_ratios: HashMap<String, f64>,
    pub group_ratios: HashMap<String, f64>,
    pub quota_per_unit: f64,
}

impl PricingConfig {
    /// Build an empty config with the default `quota_per_unit`. Maps are
    /// populated by [`Self::with_json_maps`].
    pub fn new() -> Self {
        Self {
            quota_per_unit: DEFAULT_QUOTA_PER_UNIT,
            ..Default::default()
        }
    }

    /// Parse the raw JSON option strings into the config maps. Any malformed
    /// JSON entry is skipped (best-effort load; the relay must still serve).
    pub fn with_json_maps(
        mut self,
        model_ratio_json: Option<&str>,
        completion_ratio_json: Option<&str>,
        model_price_json: Option<&str>,
        cache_ratio_json: Option<&str>,
        group_ratio_json: Option<&str>,
        quota_per_unit: Option<&str>,
    ) -> Self {
        if let Some(json) = model_ratio_json {
            self.model_ratios = parse_ratio_map(json);
        }
        if let Some(json) = completion_ratio_json {
            self.completion_ratios = parse_ratio_map(json);
        }
        if let Some(json) = model_price_json {
            self.model_prices = parse_ratio_map(json);
        }
        if let Some(json) = cache_ratio_json {
            self.cache_ratios = parse_ratio_map(json);
        }
        if let Some(json) = group_ratio_json {
            self.group_ratios = parse_ratio_map(json);
        }
        if let Some(raw) = quota_per_unit {
            if let Ok(value) = raw.trim().parse::<f64>() {
                if value > 0.0 {
                    self.quota_per_unit = value;
                }
            }
        }
        self
    }

    /// Per-token prompt ratio for a model. Default 1.0 when unset.
    pub fn model_ratio(&self, model: &str) -> f64 {
        self.model_ratios.get(model).copied().unwrap_or(1.0)
    }

    /// Completion-token ratio relative to prompt. Default 1.0 (no premium).
    pub fn completion_ratio(&self, model: &str) -> f64 {
        self.completion_ratios.get(model).copied().unwrap_or(1.0)
    }

    /// Fixed per-request USD price. `None` means per-token mode.
    pub fn model_price(&self, model: &str) -> Option<f64> {
        self.model_prices.get(model).copied()
    }

    /// Cache-read discount multiplier. Default 1.0 (no discount).
    pub fn cache_ratio(&self, model: &str) -> f64 {
        self.cache_ratios.get(model).copied().unwrap_or(1.0)
    }

    /// Per-group multiplier. Default 1.0.
    pub fn group_ratio(&self, group: &str) -> f64 {
        self.group_ratios.get(group).copied().unwrap_or(1.0)
    }
}

/// Parse a JSON object of `{key: number}` into a HashMap. Malformed entries
/// are silently dropped. Accepts integers and floats.
fn parse_ratio_map(json: &str) -> HashMap<String, f64> {
    let trimmed = json.trim();
    if trimmed.is_empty() {
        return HashMap::new();
    }
    let value: serde_json::Value = match serde_json::from_str(trimmed) {
        Ok(value) => value,
        Err(_) => return HashMap::new(),
    };
    let map = value.as_object().cloned().unwrap_or_default();
    let mut out = HashMap::with_capacity(map.len());
    for (key, value) in map {
        let ratio = match value {
            serde_json::Value::Number(n) if n.is_f64() => n.as_f64(),
            serde_json::Value::Number(n) if n.is_i64() => Some(n.as_i64().unwrap_or(0) as f64),
            serde_json::Value::Number(n) if n.is_u64() => Some(n.as_u64().unwrap_or(0) as f64),
            serde_json::Value::String(s) => s.trim().parse::<f64>().ok(),
            _ => None,
        };
        if let Some(ratio) = ratio {
            out.insert(key, ratio);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_config_uses_defaults() {
        let config = PricingConfig::new();
        assert_eq!(config.model_ratio("gpt-4o"), 1.0);
        assert_eq!(config.completion_ratio("gpt-4o"), 1.0);
        assert_eq!(config.group_ratio("default"), 1.0);
        assert_eq!(config.cache_ratio("gpt-4o"), 1.0);
        assert_eq!(config.model_price("gpt-4o"), None);
        assert_eq!(config.quota_per_unit, 500_000.0);
    }

    #[test]
    fn json_maps_populate_lookups() {
        let config = PricingConfig::new().with_json_maps(
            Some(r#"{"gpt-4o": 1.25, "claude-3-5-sonnet": 1.5}"#),
            Some(r#"{"gpt-4o": 4}"#),
            Some(r#"{"dall-e-3": 0.04}"#),
            Some(r#"{"gpt-4o": 0.5}"#),
            Some(r#"{"default": 1, "vip": 2}"#),
            Some("500000"),
        );
        assert_eq!(config.model_ratio("gpt-4o"), 1.25);
        assert_eq!(config.model_ratio("claude-3-5-sonnet"), 1.5);
        assert_eq!(config.completion_ratio("gpt-4o"), 4.0);
        assert_eq!(config.completion_ratio("claude-3-5-sonnet"), 1.0); // default
        assert_eq!(config.model_price("dall-e-3"), Some(0.04));
        assert_eq!(config.model_price("gpt-4o"), None);
        assert_eq!(config.cache_ratio("gpt-4o"), 0.5);
        assert_eq!(config.group_ratio("vip"), 2.0);
        assert_eq!(config.group_ratio("unknown"), 1.0);
    }

    #[test]
    fn malformed_json_is_silently_dropped() {
        let config = PricingConfig::new().with_json_maps(
            Some("not json"),
            Some(r#"{"gpt-4o": "fast"}"#), // non-numeric value dropped
            None,
            None,
            None,
            None,
        );
        assert!(config.model_ratios.is_empty());
        assert!(config.completion_ratios.is_empty());
    }

    #[test]
    fn quota_per_unit_only_accepts_positive() {
        let config = PricingConfig::new().with_json_maps(None, None, None, None, None, Some("-1"));
        assert_eq!(config.quota_per_unit, 500_000.0); // unchanged

        let config =
            PricingConfig::new().with_json_maps(None, None, None, None, None, Some("1000000"));
        assert_eq!(config.quota_per_unit, 1_000_000.0);
    }

    #[test]
    fn string_numeric_values_are_parsed() {
        // Some option stores serialize numbers as strings.
        let config = PricingConfig::new().with_json_maps(
            Some(r#"{"gpt-4o": "2.5"}"#),
            None,
            None,
            None,
            None,
            None,
        );
        assert_eq!(config.model_ratio("gpt-4o"), 2.5);
    }

    #[test]
    fn empty_json_string_yields_empty_map() {
        let config =
            PricingConfig::new().with_json_maps(Some(""), Some("   "), None, None, None, None);
        assert!(config.model_ratios.is_empty());
        assert!(config.completion_ratios.is_empty());
    }
}
