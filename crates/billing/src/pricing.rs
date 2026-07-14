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
//! - **Default-table startup state.** Go's `InitRatioSettings` seeds the operator
//!   ratio/price maps with hardcoded defaults (`defaultModelRatio`,
//!   `defaultModelPrice`, `defaultCompletionRatio`). An existing option row
//!   replaces that complete runtime map, including an
//!   explicit `{}`; defaults apply only while the option row is absent.
//! - **Unset-model admission.** Go returns `37.5` for a model in neither map,
//!   then admits it only through site self-use or the user's
//!   `AcceptUnsetRatioModel`. [`PricingConfig::admits_model`] reproduces this.
//! - Hardcoded completion-ratio prefix table (`gpt-4o* → 4`, `claude-* → 5`,
//!   ...) is wired into [`PricingConfig::completion_ratio`] via
//!   `cinatoken_core::hardcoded_completion_ratio`, with Go's
//!   authoritative > options-map > soft-default precedence and
//!   `format_matching_model_name` normalization applied first.
//! - **Compact-suffix wildcard.** A `-openai-compact` name with no direct
//!   ratio/price falls back to the `*-openai-compact` wildcard in the operator
//!   map and default table (Go `CompactModelSuffix`). Applies to `model_ratio`
//!   and `model_price` only. [`PricingConfig::has_model_pricing`] consults the
//!   same layers so the billability gate and lookups agree.
//!
//! ## Implemented here
//!
//! - **Replacement-aware sub-category maps.** Missing option rows use seeded
//!   cache/image/audio defaults. Existing option rows replace those maps, with
//!   final base defaults of 1.0 (or 1.25 for cache creation) on a miss.
//! - **Cache-creation 5m/1h split.** `cache_creation_ratio_5m` aliases the
//!   create-cache ratio; `cache_creation_ratio_1h = 5m *
//!   CLAUDE_CACHE_CREATION_1H_MULTIPLIER (6/3.75)`, faithful to Go.
//! - The per-token settlement arithmetic in `flat.rs::compute_flat_quota` prices
//!   each sub-category (cache-read, cache-write, image) at its own ratio,
//!   subtracting them from the prompt base for non-Anthropic usage.
//!
//! ## Not implemented here (deferred)
//!
//! - `OtherRatios` (image `n` multiplier) and `ToolCallSurcharge` (web/file
//!   search, image-generation call) additive quota adjustments.

use std::collections::HashMap;

use cinatoken_core::{
    default_audio_completion_ratio, default_audio_ratio, default_cache_ratio,
    default_completion_ratio, default_create_cache_ratio, default_image_ratio, default_model_price,
    default_model_ratio, format_matching_model_name, hardcoded_completion_ratio,
    CLAUDE_CACHE_CREATION_1H_MULTIPLIER,
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
    /// Cache-write (creation) ratios — the 5-minute tier. The 1-hour tier is
    /// derived as `cache_creation_ratio * CLAUDE_CACHE_CREATION_1H_MULTIPLIER`.
    pub cache_creation_ratios: HashMap<String, f64>,
    pub image_ratios: HashMap<String, f64>,
    pub audio_ratios: HashMap<String, f64>,
    pub audio_completion_ratios: HashMap<String, f64>,
    /// True when Go would admit an unset model through site self-use or the
    /// user's `AcceptUnsetRatioModel`. An admitted unset model uses ratio 37.5.
    pub self_use_mode: bool,
    model_ratios_replaced: bool,
    completion_ratios_replaced: bool,
    model_prices_replaced: bool,
    cache_ratios_replaced: bool,
    cache_creation_ratios_replaced: bool,
    image_ratios_replaced: bool,
    audio_ratios_replaced: bool,
    audio_completion_ratios_replaced: bool,
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

    /// Record the combined Go unset-model admission decision (site self-use or
    /// user `AcceptUnsetRatioModel`). Builder-style; off by default.
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
            self.model_ratios_replaced = true;
            self.model_ratios = parse_ratio_map(json);
        }
        if let Some(json) = completion_ratio_json {
            self.completion_ratios_replaced = true;
            self.completion_ratios = parse_ratio_map(json);
        }
        if let Some(json) = model_price_json {
            self.model_prices_replaced = true;
            self.model_prices = parse_ratio_map(json);
        }
        if let Some(json) = cache_ratio_json {
            self.cache_ratios_replaced = true;
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

    /// Parse the sub-category ratio option strings (cache-creation, image,
    /// audio, audio-completion) into the config maps. Kept separate from
    /// [`with_json_maps`](Self::with_json_maps) to avoid growing its positional
    /// arg list; the caller chains this after it when it has the extra option
    /// keys. Any malformed JSON entry is dropped (best-effort).
    pub fn with_subcategory_maps(
        mut self,
        cache_creation_ratio_json: Option<&str>,
        image_ratio_json: Option<&str>,
        audio_ratio_json: Option<&str>,
        audio_completion_ratio_json: Option<&str>,
    ) -> Self {
        if let Some(json) = cache_creation_ratio_json {
            self.cache_creation_ratios_replaced = true;
            self.cache_creation_ratios = parse_ratio_map(json);
        }
        if let Some(json) = image_ratio_json {
            self.image_ratios_replaced = true;
            self.image_ratios = parse_ratio_map(json);
        }
        if let Some(json) = audio_ratio_json {
            self.audio_ratios_replaced = true;
            self.audio_ratios = parse_ratio_map(json);
        }
        if let Some(json) = audio_completion_ratio_json {
            self.audio_completion_ratios_replaced = true;
            self.audio_completion_ratios = parse_ratio_map(json);
        }
        self
    }

    /// Per-token prompt ratio for a model. Ports Go `GetModelRatio` precedence
    /// (after `format_matching_model_name`):
    /// 1. direct or compact-wildcard entry in the active runtime map;
    /// 2. seeded defaults only when no option row replaced that map;
    /// 3. Go's unconfigured numeric value `37.5`.
    ///
    /// The numeric fallback does not itself grant access; use
    /// [`Self::admits_model`] for the separate Go success flag.
    pub fn model_ratio(&self, model: &str) -> f64 {
        let name = format_matching_model_name(model);
        let ratio = if self.model_ratios_replaced {
            compact_map_lookup(&name, &self.model_ratios)
        } else {
            compact_wildcard_lookup(&name, &self.model_ratios, default_model_ratio)
        };
        ratio.unwrap_or(37.5)
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
            .or_else(|| {
                (!self.completion_ratios_replaced)
                    .then(|| default_completion_ratio(&name))
                    .flatten()
            })
            .unwrap_or(if hardcoded != 1.0 { hardcoded } else { 1.0 })
    }

    /// Fixed per-request USD price. `None` means per-token mode. Ports Go
    /// `GetModelPrice` (after `format_matching_model_name`): operator
    /// `ModelPrice` runtime map, including the compact wildcard. The seeded Go
    /// default table is used only when no `ModelPrice` option row replaced it.
    pub fn model_price(&self, model: &str) -> Option<f64> {
        let name = format_matching_model_name(model);
        if self.model_prices_replaced {
            compact_map_lookup(&name, &self.model_prices)
        } else {
            compact_wildcard_lookup(&name, &self.model_prices, default_model_price)
        }
    }

    /// Cache-read discount multiplier. Ports Go `GetCacheRatio`: operator map,
    /// then the Go default-cache table (`defaultCacheRatio`), else 1.0 (no
    /// discount). Applied after `format_matching_model_name`.
    pub fn cache_ratio(&self, model: &str) -> f64 {
        let name = format_matching_model_name(model);
        self.cache_ratios
            .get(&name)
            .copied()
            .or_else(|| {
                (!self.cache_ratios_replaced)
                    .then(|| default_cache_ratio(&name))
                    .flatten()
            })
            .unwrap_or(1.0)
    }

    /// Cache-creation (cache-write) ratio for the 5-minute tier. Ports Go
    /// `GetCreateCacheRatio`: operator map, then the Go default table
    /// (`defaultCreateCacheRatio`), else **1.25** (Go's create-cache default).
    pub fn cache_creation_ratio(&self, model: &str) -> f64 {
        let name = format_matching_model_name(model);
        self.cache_creation_ratios
            .get(&name)
            .copied()
            .or_else(|| {
                (!self.cache_creation_ratios_replaced)
                    .then(|| default_create_cache_ratio(&name))
                    .flatten()
            })
            .unwrap_or(1.25)
    }

    /// Cache-creation ratio for the 5-minute tier (alias of
    /// [`cache_creation_ratio`](Self::cache_creation_ratio)).
    pub fn cache_creation_ratio_5m(&self, model: &str) -> f64 {
        self.cache_creation_ratio(model)
    }

    /// Cache-creation ratio for the 1-hour tier. Go derives this as
    /// `cache_creation_ratio * claudeCacheCreation1hMultiplier (6/3.75 = 1.6)`.
    pub fn cache_creation_ratio_1h(&self, model: &str) -> f64 {
        self.cache_creation_ratio(model) * CLAUDE_CACHE_CREATION_1H_MULTIPLIER
    }

    /// Image-token ratio. Ports Go `GetImageRatio`: operator map, then the Go
    /// default table (`defaultImageRatio`), else 1.0. Image tokens are billed
    /// at this ratio (relative to the model ratio) instead of the prompt rate.
    pub fn image_ratio(&self, model: &str) -> f64 {
        let name = format_matching_model_name(model);
        self.image_ratios
            .get(&name)
            .copied()
            .or_else(|| {
                (!self.image_ratios_replaced)
                    .then(|| default_image_ratio(&name))
                    .flatten()
            })
            .unwrap_or(1.0)
    }

    /// Audio-input-token ratio. Ports Go `GetAudioRatio`: operator map, then
    /// the Go default table (`defaultAudioRatio`), else 1.0.
    pub fn audio_ratio(&self, model: &str) -> f64 {
        let name = format_matching_model_name(model);
        self.audio_ratios
            .get(&name)
            .copied()
            .or_else(|| {
                (!self.audio_ratios_replaced)
                    .then(|| default_audio_ratio(&name))
                    .flatten()
            })
            .unwrap_or(1.0)
    }

    /// Audio-completion-token ratio. Ports Go `GetAudioCompletionRatio`:
    /// operator map, then the Go default table, else 1.0.
    pub fn audio_completion_ratio(&self, model: &str) -> f64 {
        let name = format_matching_model_name(model);
        self.audio_completion_ratios
            .get(&name)
            .copied()
            .or_else(|| {
                (!self.audio_completion_ratios_replaced)
                    .then(|| default_audio_completion_ratio(&name))
                    .flatten()
            })
            .unwrap_or(1.0)
    }

    /// Gemini input-audio price in USD per million tokens. This mirrors the
    /// ordered prefix lookup in Go's `GetGeminiInputAudioPricePerMillionTokens`.
    pub fn audio_input_price_per_million(&self, model: &str) -> f64 {
        if model.starts_with("gemini-2.5-flash-preview-native-audio") {
            3.0
        } else if model.starts_with("gemini-2.5-flash-preview-lite") {
            0.5
        } else if model.starts_with("gemini-2.5-flash-preview")
            || model.starts_with("gemini-2.5-flash")
            || model.starts_with("gemini-robotics-er-1.5")
        {
            1.0
        } else if model.starts_with("gemini-2.0-flash") {
            0.7
        } else {
            0.0
        }
    }

    /// Per-group multiplier. Default 1.0.
    pub fn group_ratio(&self, group: &str) -> f64 {
        self.group_ratios.get(group).copied().unwrap_or(1.0)
    }

    /// True when the active Go runtime maps contain a ratio or price. A value
    /// of zero is still configured. Seeded defaults count only while the
    /// corresponding D1 option row is absent.
    pub fn has_model_pricing(&self, model: &str) -> bool {
        let name = format_matching_model_name(model);
        let has_ratio = if self.model_ratios_replaced {
            compact_map_lookup(&name, &self.model_ratios).is_some()
        } else {
            compact_wildcard_lookup(&name, &self.model_ratios, default_model_ratio).is_some()
        };
        let has_price = if self.model_prices_replaced {
            compact_map_lookup(&name, &self.model_prices).is_some()
        } else {
            compact_wildcard_lookup(&name, &self.model_prices, default_model_price).is_some()
        };
        has_ratio || has_price
    }

    /// Whether Go would admit this model to flat billing. Zero-valued map
    /// entries count as configured; an unset model is admitted only through an
    /// already-resolved site/user policy and then bills at ratio 37.5.
    pub fn admits_model(&self, model: &str) -> bool {
        self.has_model_pricing(model) || self.self_use_mode
    }
}

/// Compact-model suffix and its wildcard key, faithful ports of Go
/// `setting/ratio_setting.CompactModelSuffix` / `CompactWildcardModelKey`.
/// A model name ending in `-openai-compact` that has no direct ratio/price
/// entry falls back to the `*-openai-compact` wildcard, so one wildcard entry
/// can price every compact variant. Applied to `model_ratio` and `model_price`
/// only (Go's `GetCompletionRatio` does not consult the compact wildcard).
const COMPACT_MODEL_SUFFIX: &str = "-openai-compact";
const COMPACT_WILDCARD_MODEL_KEY: &str = "*-openai-compact";

/// Compact-suffix wildcard fallback for an operator map + Go default table,
/// mirroring Go `GetModelRatio`/`GetModelPrice`. Both the operator map and the
/// default table are consulted first by direct key, then — only when `name`
/// ends in the compact suffix — by the `*-openai-compact` wildcard key. Returns
/// the first hit, or `None`. `default_fn` is `default_model_ratio` or
/// `default_model_price`.
fn compact_wildcard_lookup(
    name: &str,
    op_map: &HashMap<String, f64>,
    default_fn: impl Fn(&str) -> Option<f64>,
) -> Option<f64> {
    if let Some(v) = op_map.get(name).copied() {
        return Some(v);
    }
    if let Some(v) = default_fn(name) {
        return Some(v);
    }
    if name.ends_with(COMPACT_MODEL_SUFFIX) {
        if let Some(v) = op_map.get(COMPACT_WILDCARD_MODEL_KEY).copied() {
            return Some(v);
        }
        if let Some(v) = default_fn(COMPACT_WILDCARD_MODEL_KEY) {
            return Some(v);
        }
    }
    None
}

fn compact_map_lookup(name: &str, map: &HashMap<String, f64>) -> Option<f64> {
    map.get(name).copied().or_else(|| {
        name.ends_with(COMPACT_MODEL_SUFFIX)
            .then(|| map.get(COMPACT_WILDCARD_MODEL_KEY).copied())
            .flatten()
    })
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
        // Go always returns 37.5 for an unset model; admission is separate.
        assert_eq!(config.model_ratio("does-not-exist"), 37.5);
        assert!(!config.admits_model("does-not-exist"));
        // An unknown model (no hardcoded completion entry) resolves to the 1.0
        // default.
        assert_eq!(config.completion_ratio("deepseek-chat"), 1.0);
        assert_eq!(config.group_ratio("default"), 1.0);
        // gpt-4o has a Go default cache ratio of 0.5 (defaultCacheRatio).
        assert_eq!(config.cache_ratio("gpt-4o"), 0.5);
        // An unknown model has no default cache entry → 1.0 (no discount).
        assert_eq!(config.cache_ratio("does-not-exist"), 1.0);
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
    fn model_ratio_unknown_uses_go_375_but_is_not_admitted() {
        let config = PricingConfig::new();
        assert_eq!(config.model_ratio("totally-unknown-model"), 37.5);
        assert!(!config.admits_model("totally-unknown-model"));
    }

    #[test]
    fn model_ratio_self_use_mode_returns_go_default_375() {
        // In self-use mode an unknown model resolves to Go's unconfigured
        // default 37.5 (operation_setting.SelfUseModeEnabled).
        let config = PricingConfig::new().with_self_use_mode(true);
        assert_eq!(config.model_ratio("totally-unknown-model"), 37.5);
        assert!(config.admits_model("totally-unknown-model"));
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

    // --- Compact-suffix (`-openai-compact`) wildcard fallback parity (Go
    // GetModelRatio/GetModelPrice). source-pricing-ratio-parity.md. ---

    #[test]
    fn model_ratio_compact_falls_back_to_operator_wildcard() {
        // acme-foo-openai-compact has no direct entry; the operator's
        // *-openai-compact wildcard (3.0) prices it.
        let mut config = PricingConfig::new();
        config
            .model_ratios
            .insert("*-openai-compact".to_string(), 3.0);
        assert_eq!(config.model_ratio("acme-foo-openai-compact"), 3.0);
    }

    #[test]
    fn model_ratio_compact_direct_entry_beats_wildcard() {
        // A direct entry for the exact compact name wins over the wildcard.
        let mut config = PricingConfig::new();
        config
            .model_ratios
            .insert("*-openai-compact".to_string(), 3.0);
        config
            .model_ratios
            .insert("acme-foo-openai-compact".to_string(), 9.0);
        assert_eq!(config.model_ratio("acme-foo-openai-compact"), 9.0);
    }

    #[test]
    fn model_ratio_non_compact_model_ignores_wildcard() {
        // The wildcard must NOT apply to a name that lacks the compact suffix.
        let mut config = PricingConfig::new();
        config
            .model_ratios
            .insert("*-openai-compact".to_string(), 3.0);
        // gpt-4o is in the default table (1.25); the wildcard is irrelevant.
        assert_eq!(config.model_ratio("gpt-4o"), 1.25);
        // Unknown non-compact model -> Go's unset 37.5, never the wildcard.
        assert_eq!(config.model_ratio("acme-foo"), 37.5);
    }

    #[test]
    fn model_price_compact_falls_back_to_operator_wildcard() {
        let mut config = PricingConfig::new();
        config
            .model_prices
            .insert("*-openai-compact".to_string(), 0.02);
        assert_eq!(config.model_price("acme-foo-openai-compact"), Some(0.02));
    }

    #[test]
    fn has_model_pricing_reflects_all_layers() {
        // Default-table model is priced.
        assert!(PricingConfig::new().has_model_pricing("gpt-4o"));
        // Unknown model is not priced.
        assert!(!PricingConfig::new().has_model_pricing("acme-foo"));
        // A compact model priced only via the wildcard counts as priced.
        let mut config = PricingConfig::new();
        config
            .model_ratios
            .insert("*-openai-compact".to_string(), 3.0);
        assert!(config.has_model_pricing("acme-foo-openai-compact"));
    }

    #[test]
    fn explicit_option_maps_replace_seeded_defaults_and_preserve_zero() {
        let config = PricingConfig::new().with_json_maps(
            Some(r#"{"free-ratio":0}"#),
            Some("{}"),
            Some(r#"{"free-price":0}"#),
            Some("{}"),
            None,
            None,
        );

        assert_eq!(config.model_ratio("gpt-4o"), 37.5);
        assert_eq!(config.model_price("dall-e-3"), None);
        assert!(!config.admits_model("gpt-4o"));
        assert!(config.has_model_pricing("free-ratio"));
        assert!(config.has_model_pricing("free-price"));
        assert_eq!(config.model_ratio("free-ratio"), 0.0);
        assert_eq!(config.model_price("free-price"), Some(0.0));
        assert_eq!(config.cache_ratio("gpt-4o"), 1.0);
        assert_eq!(config.completion_ratio("gpt-image-1"), 2.0);
    }

    #[test]
    fn explicit_subcategory_maps_replace_seeded_defaults() {
        let config = PricingConfig::new().with_subcategory_maps(
            Some("{}"),
            Some("{}"),
            Some("{}"),
            Some("{}"),
        );

        assert_eq!(config.cache_creation_ratio("gpt-4o"), 1.25);
        assert_eq!(config.image_ratio("gpt-image-1"), 1.0);
        assert_eq!(config.audio_ratio("gpt-4o-audio-preview"), 1.0);
        assert_eq!(config.audio_completion_ratio("gpt-4o-audio-preview"), 1.0);
    }

    #[test]
    fn gemini_audio_input_price_prefix_order_matches_go() {
        let config = PricingConfig::new();
        assert_eq!(
            config.audio_input_price_per_million("gemini-2.5-flash-preview-native-audio-dialog"),
            3.0
        );
        assert_eq!(
            config.audio_input_price_per_million("gemini-2.5-flash-preview-lite-06-17"),
            0.5
        );
        assert_eq!(
            config.audio_input_price_per_million("gemini-2.5-flash"),
            1.0
        );
        assert_eq!(
            config.audio_input_price_per_million("gemini-2.0-flash"),
            0.7
        );
        assert_eq!(
            config.audio_input_price_per_million("gpt-4o-audio-preview"),
            0.0
        );
    }
}
