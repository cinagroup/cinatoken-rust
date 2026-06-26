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
//! ## Implemented here
//!
//! - **Default-table base layer.** Go's `InitRatioSettings` seeds the operator
//!   ratio/price maps with hardcoded defaults (`defaultModelRatio`,
//!   `defaultModelPrice`, `defaultCompletionRatio`) as a base the operator's
//!   `options` JSON overrides per-entry. [`PricingConfig::model_ratio`] /
//!   [`PricingConfig::model_price`] / [`PricingConfig::completion_ratio`]
//!   consult `cinatoken_core::default_ratios` as a fallback beneath the
//!   operator map, so an unconfigured-but-known model (e.g. `gpt-4o` → 1.25)
//!   bills correctly without an explicit operator entry.
//! - **Self-use mode.** Go returns `37.5` for a model in neither map when
//!   `SelfUseModeEnabled`; otherwise the caller treats it as unconfigured.
//!   [`PricingConfig::with_self_use_mode`] reproduces this.
//! - Hardcoded completion-ratio prefix table (`gpt-4o* → 4`, `claude-* → 5`,
//!   ...) is wired into [`PricingConfig::completion_ratio`] via
//!   `cinatoken_core::hardcoded_completion_ratio`, with Go's
//!   authoritative > options-map > soft-default precedence and
//!   `format_matching_model_name` normalization applied first.
//!
//! ## Not implemented here (deferred)
//!
//! - `CacheRatio` default table (`defaultCacheRatio`) — the operator map only
//!   is consulted; default 1.0. (The cache/audio/image tables are the natural
//!   next port; their settlement arithmetic is still simplified.)
//! - `CacheCreation5mRatio` / `CacheCreation1hRatio` split. A single
//!   `create_cache_ratio` is used instead.
//! - Compact-suffix (`-openai-compact`) wildcard fallback for ratio/price.
//! - `AcceptUnsetRatioModel` per-user override + the `modelPriceNotConfigured`
//!   error path outside self-use.

use std::collections::HashMap;

use cinatoken_core::{
    default_completion_ratio, default_model_price, default_model_ratio, format_matching_model_name,
    hardcoded_completion_ratio,
};

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
    /// Mirrors Go `operation_setting.SelfUseModeEnabled`. When true, a model
    /// present in NEITHER the operator maps NOR the Go default tables resolves
    /// its model ratio to `37.5` (Go's unconfigured default) instead of `1.0`.
    /// Outside self-use, an unconfigured model is treated as not-configured by
    /// the caller's `has_pricing` gate (matching Go's
    /// `modelPriceNotConfiguredError` path). Set via [`Self::with_self_use_mode`].
    pub self_use_mode: bool,
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

    /// Enable Go `SelfUseModeEnabled` semantics (unconfigured models bill at
    /// the `37.5` default ratio). Builder-style; off by default.
    pub fn with_self_use_mode(mut self, enabled: bool) -> Self {
        self.self_use_mode = enabled;
        self
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

    /// Per-token prompt ratio for a model. Ports Go `GetModelRatio` precedence
    /// (after `format_matching_model_name`):
    /// 1. operator `ModelRatio` map hit;
    /// 2. Go default-table hit (`defaultModelRatio`, the base layer Go's
    ///    `InitRatioSettings` seeds);
    /// 3. in self-use mode, the Go unconfigured default `37.5`; otherwise
    ///    `1.0` (and the caller's `has_pricing` gate treats the model as
    ///    unconfigured).
    pub fn model_ratio(&self, model: &str) -> f64 {
        let name = format_matching_model_name(model);
        if let Some(ratio) = self.model_ratios.get(&name).copied() {
            return ratio;
        }
        if let Some(ratio) = default_model_ratio(&name) {
            return ratio;
        }
        if self.self_use_mode {
            37.5
        } else {
            1.0
        }
    }

    /// Completion-token ratio relative to prompt. Ports Go
    /// `GetCompletionRatio` precedence exactly (after
    /// `format_matching_model_name`):
    /// 1. if the normalized name contains `/` AND an options-map hit exists,
    ///    return it (a `/`-name with NO hit falls through to the table, per Go);
    /// 2. `hardcoded_completion_ratio` — when `authoritative`, that value wins;
    /// 3. otherwise an options-map hit wins;
    /// 4. otherwise the Go default-completion map (`defaultCompletionRatio`);
    /// 5. otherwise the non-authoritative hardcoded value (a soft default).
    pub fn completion_ratio(&self, model: &str) -> f64 {
        let name = format_matching_model_name(model);
        let map_hit = self.completion_ratios.get(&name).copied();
        // Go: a `/`-name short-circuits ONLY on a map hit; a miss falls through
        // to the hardcoded table (where no `/`-name matches a prefix, so the
        // observable result is the 1.0 default, but the path is faithful).
        if name.contains('/') {
            if let Some(ratio) = map_hit {
                return ratio;
            }
        }
        let (hardcoded, authoritative) = hardcoded_completion_ratio(&name);
        if authoritative {
            return hardcoded;
        }
        // Non-authoritative: operator map, then the Go default-completion map,
        // then the hardcoded soft default (1.0 for fully-unknown models).
        map_hit
            .or_else(|| default_completion_ratio(&name))
            .unwrap_or(if hardcoded != 1.0 { hardcoded } else { 1.0 })
    }

    /// Fixed per-request USD price. `None` means per-token mode. Ports Go
    /// `GetModelPrice` (after `format_matching_model_name`): operator
    /// `ModelPrice` map, then the Go default-price table (`defaultModelPrice`).
    pub fn model_price(&self, model: &str) -> Option<f64> {
        let name = format_matching_model_name(model);
        self.model_prices
            .get(&name)
            .copied()
            .or_else(|| default_model_price(&name))
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
        // The Go default-table base layer applies even with an empty operator
        // map: gpt-4o → 1.25 (defaultModelRatio), not 1.0.
        assert_eq!(config.model_ratio("gpt-4o"), 1.25);
        // An unknown model (no default-table entry) resolves to 1.0 outside
        // self-use mode (see self_use_mode tests for the 37.5 path).
        assert_eq!(config.model_ratio("does-not-exist"), 1.0);
        // An unknown model (no hardcoded completion entry) resolves to the 1.0
        // default.
        assert_eq!(config.completion_ratio("deepseek-chat"), 1.0);
        assert_eq!(config.group_ratio("default"), 1.0);
        assert_eq!(config.cache_ratio("gpt-4o"), 1.0);
        // gpt-4o is ratio-billed, so no default price.
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
        // claude-3-5-sonnet is AUTHORITATIVE in the hardcoded table (5.0), so
        // it wins even though no map entry exists and ignores the 1.5 model
        // ratio — completion_ratio is independent of model_ratio.
        assert_eq!(config.completion_ratio("claude-3-5-sonnet"), 5.0);
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

    // --- completion_ratio Go-precedence parity (source-pricing-ratio-parity.md
    // gap #1). The hardcoded table is authoritative for some families
    // (claude-*→5, gpt-5*→8, o1/o3→4) and a soft default for others
    // (gpt-4o*→4, gemini-2.5-pro→8). Precedence after format_matching_model_name:
    //   1. name has "/" → map-only (no table)
    //   2. authoritative hardcoded → wins over map
    //   3. map hit → wins over soft default
    //   4. soft-default hardcoded → wins over 1.0
    //   5. 1.0 for fully-unknown models.

    #[test]
    fn completion_ratio_authoritative_overrides_map() {
        // claude-3-5-sonnet is AUTHORITATIVE (5.0); the map's 2.0 must lose.
        let mut config = PricingConfig::new();
        config
            .completion_ratios
            .insert("claude-3-5-sonnet".to_string(), 2.0);
        assert_eq!(config.completion_ratio("claude-3-5-sonnet"), 5.0);
        // gpt-5 is authoritative 8.0 even with a conflicting map entry.
        let mut config = PricingConfig::new();
        config
            .completion_ratios
            .insert("gpt-5-pro".to_string(), 1.0);
        assert_eq!(config.completion_ratio("gpt-5-pro"), 8.0);
    }

    #[test]
    fn completion_ratio_map_overrides_soft_default() {
        // gpt-4o is a NON-authoritative soft default (4.0); an explicit map hit
        // (7.0) must win.
        let mut config = PricingConfig::new();
        config.completion_ratios.insert("gpt-4o".to_string(), 7.0);
        assert_eq!(config.completion_ratio("gpt-4o"), 7.0);
    }

    #[test]
    fn completion_ratio_soft_default_when_unconfigured() {
        // Empty map: gpt-4o resolves to its 4.0 soft default, claude-* to 5.0.
        let config = PricingConfig::new();
        assert_eq!(config.completion_ratio("gpt-4o"), 4.0);
        assert_eq!(config.completion_ratio("claude-sonnet-4"), 5.0);
        assert_eq!(config.completion_ratio("gemini-2.5-pro"), 8.0);
    }

    #[test]
    fn completion_ratio_unknown_model_is_one() {
        // A model with no hardcoded entry and no map hit → 1.0 (no premium).
        let config = PricingConfig::new();
        assert_eq!(config.completion_ratio("deepseek-chat"), 1.0);
        assert_eq!(config.completion_ratio("totally-unknown-model"), 1.0);
    }

    #[test]
    fn completion_ratio_slash_name_falls_through_to_table() {
        // Go: a `/`-name short-circuits ONLY on a map hit; a miss falls through
        // to the hardcoded table (where no `/`-name matches a prefix, so the
        // observable result is the 1.0 default). Map hit wins:
        let mut config = PricingConfig::new();
        config
            .completion_ratios
            .insert("org/gpt-4o".to_string(), 9.0);
        assert_eq!(config.completion_ratio("org/gpt-4o"), 9.0);
        // No map hit → falls through to the table → no prefix matches → 1.0.
        let config = PricingConfig::new();
        assert_eq!(config.completion_ratio("org/gpt-4o"), 1.0);
    }

    #[test]
    fn completion_ratio_applies_format_matching_model_name() {
        // A thinking-budget gemini name normalizes to its wildcard before the
        // table/map lookup, so a map keyed on the wildcard applies.
        let mut config = PricingConfig::new();
        config
            .completion_ratios
            .insert("gemini-2.5-flash-thinking-*".to_string(), 3.0);
        assert_eq!(
            config.completion_ratio("gemini-2.5-flash-thinking-8192"),
            3.0
        );
        // Without a map hit, the normalized name still hits the hardcoded
        // table: gemini-2.5-flash-* resolves to (2.5/0.3, false) soft default.
        let config = PricingConfig::new();
        assert_eq!(
            config.completion_ratio("gemini-2.5-flash-thinking-8192"),
            2.5 / 0.3
        );
    }

    // --- Default-table base layer + self_use_mode parity (Go
    // InitRatioSettings + GetModelRatio/Price). source-pricing-ratio-parity.md
    // gaps #2/#3. ---

    #[test]
    fn model_ratio_uses_default_table_when_unconfigured() {
        // Empty operator map: gpt-4o resolves to its Go default 1.25, o1 to 7.5.
        let config = PricingConfig::new();
        assert_eq!(config.model_ratio("gpt-4o"), 1.25);
        assert_eq!(config.model_ratio("o1"), 7.5);
        assert_eq!(config.model_ratio("claude-3-opus-20240229"), 7.5);
    }

    #[test]
    fn model_ratio_operator_override_beats_default() {
        // Operator map entry (2.0) wins over the default-table 1.25.
        let mut config = PricingConfig::new();
        config.model_ratios.insert("gpt-4o".to_string(), 2.0);
        assert_eq!(config.model_ratio("gpt-4o"), 2.0);
    }

    #[test]
    fn model_ratio_unknown_is_one_outside_self_use() {
        let config = PricingConfig::new();
        assert_eq!(config.model_ratio("totally-unknown-model"), 1.0);
    }

    #[test]
    fn model_ratio_self_use_mode_returns_go_default_375() {
        // In self-use mode an unknown model resolves to Go's unconfigured
        // default 37.5 (operation_setting.SelfUseModeEnabled).
        let config = PricingConfig::new().with_self_use_mode(true);
        assert_eq!(config.model_ratio("totally-unknown-model"), 37.5);
        // A known model still uses its default-table value, not 37.5.
        assert_eq!(config.model_ratio("gpt-4o"), 1.25);
    }

    #[test]
    fn model_price_uses_default_table_when_unconfigured() {
        let config = PricingConfig::new();
        assert_eq!(config.model_price("dall-e-3"), Some(0.04));
        assert_eq!(config.model_price("sora-2-pro"), Some(0.5));
        // Ratio-billed model has no default price.
        assert_eq!(config.model_price("gpt-4o"), None);
    }

    #[test]
    fn model_price_operator_override_beats_default() {
        let mut config = PricingConfig::new();
        config.model_prices.insert("dall-e-3".to_string(), 0.07);
        assert_eq!(config.model_price("dall-e-3"), Some(0.07));
    }

    #[test]
    fn completion_ratio_uses_default_table_when_unconfigured() {
        // gpt-image-1 is in the Go defaultCompletionRatio map (8.0).
        let config = PricingConfig::new();
        assert_eq!(config.completion_ratio("gpt-image-1"), 8.0);
        assert_eq!(config.completion_ratio("gpt-4o-gizmo-*"), 3.0);
    }
}
