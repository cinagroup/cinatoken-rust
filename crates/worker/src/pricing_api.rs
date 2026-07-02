//! Public pricing endpoint (Go `controller.GetPricing` + `model.updatePricing`).
//!
//! Builds the per-model pricing array from the enabled abilities (model ×
//! groups × channel-type endpoints), the merged default+option ratio maps (the
//! same layering `/api/ratio_config` exposes), and optional operator metadata
//! from the `models`/`vendors` tables (migration 0008). Go's 1-minute in-memory
//! pricing cache is not needed here (D1 reads per request); the deferred
//! per-user-group ratio overrides / special usable groups match the
//! GetUserGroups port. Anonymous access is allowed (Go gates by console nav
//! config; a session, when present, feeds the same default-config maps).

use std::collections::{BTreeMap, HashMap, HashSet};

use serde::Serialize;
use worker::{Env, Request, Response, Result as WorkerResult};

use crate::admin_user::{merged_ratio_map, parse_group_ratios, parse_usable_groups};
use crate::d1_repositories::{self, AbilityWithChannelType, ModelMetaRow};

/// Hardcoded pricing schema version echoed by Go's controller.
const PRICING_VERSION: &str = "a42d372ccf0b5dd13ecf71203521f9d2";

// Go constant/channel.go types with non-default endpoint sets.
const CHANNEL_TYPE_ANTHROPIC: i32 = 14;
const CHANNEL_TYPE_OPENROUTER: i32 = 20;
const CHANNEL_TYPE_GEMINI: i32 = 24;
const CHANNEL_TYPE_AWS: i32 = 33;
const CHANNEL_TYPE_JINA: i32 = 38;
const CHANNEL_TYPE_VERTEX_AI: i32 = 41;
const CHANNEL_TYPE_XAI: i32 = 48;
const CHANNEL_TYPE_SORA: i32 = 55;

/// Go `common.OpenAIResponseOnlyModels` (substring match).
const OPENAI_RESPONSE_ONLY_MODELS: &[&str] =
    &["o3-pro", "o3-deep-research", "o4-mini-deep-research"];
/// Go `common.ImageGenerationModels` (lowercased substring match; a `prefix:`
/// entry matches as a prefix instead).
const IMAGE_GENERATION_MODELS: &[&str] = &[
    "dall-e-3",
    "dall-e-2",
    "gpt-image-1",
    "prefix:imagen-",
    "flux-",
    "flux.1-",
];

/// Go `common.defaultEndpointInfoMap` (endpoint type -> path).
const DEFAULT_ENDPOINT_INFO: &[(&str, &str)] = &[
    ("openai", "/v1/chat/completions"),
    ("openai-response", "/v1/responses"),
    ("openai-response-compact", "/v1/responses/compact"),
    ("anthropic", "/v1/messages"),
    ("gemini", "/v1beta/models/{model}:generateContent"),
    ("jina-rerank", "/v1/rerank"),
    ("image-generation", "/v1/images/generations"),
    ("embeddings", "/v1/embeddings"),
];

fn is_openai_response_only_model(model: &str) -> bool {
    OPENAI_RESPONSE_ONLY_MODELS
        .iter()
        .any(|needle| model.contains(needle))
}

fn is_image_generation_model(model: &str) -> bool {
    let model = model.to_lowercase();
    IMAGE_GENERATION_MODELS.iter().any(|entry| {
        if let Some(prefix) = entry.strip_prefix("prefix:") {
            model.starts_with(prefix)
        } else {
            model.contains(entry)
        }
    })
}

/// Endpoint types served by a channel type for a model (Go
/// `common.GetEndpointTypesByChannelType`). Order matters: the first endpoint
/// is the preferred one, and image-generation is prepended when it applies.
fn endpoint_types_for(channel_type: i32, model: &str) -> Vec<&'static str> {
    let mut endpoints: Vec<&'static str> = match channel_type {
        CHANNEL_TYPE_JINA => vec!["jina-rerank"],
        CHANNEL_TYPE_AWS | CHANNEL_TYPE_ANTHROPIC => vec!["anthropic", "openai"],
        CHANNEL_TYPE_VERTEX_AI | CHANNEL_TYPE_GEMINI => vec!["gemini", "openai"],
        CHANNEL_TYPE_OPENROUTER => vec!["openai"],
        CHANNEL_TYPE_XAI => vec!["openai", "openai-response"],
        CHANNEL_TYPE_SORA => vec!["openai-video"],
        _ => {
            if is_openai_response_only_model(model) {
                vec!["openai-response"]
            } else {
                vec!["openai"]
            }
        }
    };
    if is_image_generation_model(model) {
        endpoints.insert(0, "image-generation");
    }
    endpoints
}

/// Resolve each enabled model to its metadata row per Go's name rules: exact
/// entries win, then prefix rules, then suffix, then contains — first rule hit
/// sticks (Go fills `metaMap` in that order and never overwrites).
pub(crate) fn match_meta<'m>(
    models: &[String],
    meta_rows: &'m [ModelMetaRow],
) -> HashMap<String, &'m ModelMetaRow> {
    // Go model_meta.go: 0 exact, 1 prefix, 2 contains, 3 suffix.
    let exact: HashMap<&str, &ModelMetaRow> = meta_rows
        .iter()
        .filter(|row| row.name_rule == 0)
        .map(|row| (row.model_name.as_str(), row))
        .collect();
    let by_rule = |rule: i32| meta_rows.iter().filter(move |row| row.name_rule == rule);

    let mut matched: HashMap<String, &ModelMetaRow> = HashMap::new();
    for model in models {
        if let Some(row) = exact.get(model.as_str()) {
            matched.insert(model.clone(), row);
        }
    }
    // Application order per Go updatePricing: prefix, suffix, contains.
    for rule in [1_i32, 3, 2] {
        for row in by_rule(rule) {
            for model in models {
                if matched.contains_key(model) {
                    continue;
                }
                let hit = match rule {
                    1 => model.starts_with(&row.model_name),
                    3 => model.ends_with(&row.model_name),
                    _ => model.contains(&row.model_name),
                };
                if hit {
                    matched.insert(model.clone(), row);
                }
            }
        }
    }
    matched
}

/// One pricing row (Go `model.Pricing`, JSON field names preserved).
#[derive(Debug, Default, Serialize)]
pub struct PricingRow {
    pub model_name: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub description: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub icon: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub tags: String,
    #[serde(skip_serializing_if = "is_zero")]
    pub vendor_id: i64,
    pub quota_type: i32,
    pub model_ratio: f64,
    pub model_price: f64,
    pub owner_by: String,
    pub completion_ratio: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_ratio: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub create_cache_ratio: Option<f64>,
    pub enable_groups: Vec<String>,
    pub supported_endpoint_types: Vec<&'static str>,
}

fn is_zero(value: &i64) -> bool {
    *value == 0
}

/// The merged ratio inputs for the pure row builder.
pub struct PricingMaps {
    pub model_ratios: BTreeMap<String, f64>,
    pub completion_ratios: BTreeMap<String, f64>,
    pub model_prices: BTreeMap<String, f64>,
    pub cache_ratios: BTreeMap<String, f64>,
    pub create_cache_ratios: BTreeMap<String, f64>,
}

/// Build the pricing rows from enabled abilities + metadata + merged maps.
/// Pure, so it is unit-testable. Models whose metadata row is disabled
/// (`status != 1`) are dropped, matching Go.
pub fn build_pricing_rows(
    abilities: &[AbilityWithChannelType],
    meta_rows: &[ModelMetaRow],
    maps: &PricingMaps,
) -> Vec<PricingRow> {
    // model -> groups (sorted for a stable response) and model -> endpoints.
    let mut model_groups: BTreeMap<String, HashSet<String>> = BTreeMap::new();
    let mut model_endpoints: BTreeMap<String, Vec<&'static str>> = BTreeMap::new();
    for ability in abilities {
        model_groups
            .entry(ability.model.clone())
            .or_default()
            .insert(ability.group_name.clone());
        let endpoints = model_endpoints.entry(ability.model.clone()).or_default();
        for endpoint in endpoint_types_for(ability.channel_type, &ability.model) {
            if !endpoints.contains(&endpoint) {
                endpoints.push(endpoint);
            }
        }
    }
    let models: Vec<String> = model_groups.keys().cloned().collect();
    let matched_meta = match_meta(&models, meta_rows);

    // Completion-ratio resolution with the full Go precedence (hardcoded
    // authoritative table > merged map > soft default) via billing's config.
    let mut completion_config = cinatoken_billing::PricingConfig::new();
    completion_config.completion_ratios = maps
        .completion_ratios
        .iter()
        .map(|(name, ratio)| (name.clone(), *ratio))
        .collect();

    let mut rows = Vec::with_capacity(models.len());
    for (model, groups) in &model_groups {
        let mut row = PricingRow {
            model_name: model.clone(),
            enable_groups: {
                let mut sorted: Vec<String> = groups.iter().cloned().collect();
                sorted.sort();
                sorted
            },
            supported_endpoint_types: model_endpoints.remove(model).unwrap_or_default(),
            ..Default::default()
        };
        if let Some(meta) = matched_meta.get(model) {
            if meta.status != 1 {
                continue; // disabled model: hidden from pricing entirely.
            }
            row.description = meta.description.clone();
            row.icon = meta.icon.clone();
            row.tags = meta.tags.clone();
            row.vendor_id = meta.vendor_id;
            // A metadata `endpoints` JSON object replaces the defaults.
            let trimmed = meta.endpoints.trim();
            if !trimmed.is_empty() {
                if let Ok(map) =
                    serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(trimmed)
                {
                    let custom: Vec<&'static str> = DEFAULT_ENDPOINT_INFO
                        .iter()
                        .map(|(endpoint, _)| *endpoint)
                        .filter(|endpoint| map.contains_key(*endpoint))
                        .collect();
                    if !custom.is_empty() {
                        row.supported_endpoint_types = custom;
                    }
                }
            }
        }
        if let Some(price) = maps.model_prices.get(model) {
            row.model_price = *price;
            row.quota_type = 1;
        } else {
            row.model_ratio = maps.model_ratios.get(model).copied().unwrap_or(37.5);
            row.completion_ratio = completion_config.completion_ratio(model);
            row.quota_type = 0;
        }
        row.cache_ratio = maps.cache_ratios.get(model).copied();
        row.create_cache_ratio = maps.create_cache_ratios.get(model).copied();
        rows.push(row);
    }
    rows
}

/// Filter pricing rows to those usable by the caller (Go
/// `filterPricingByUsableGroups`): a row survives when any of its enable
/// groups is usable, or it is enabled for the special group `all`.
pub fn filter_by_usable_groups(
    rows: Vec<PricingRow>,
    usable: &HashMap<String, String>,
) -> Vec<PricingRow> {
    if usable.is_empty() {
        return Vec::new();
    }
    rows.into_iter()
        .filter(|row| {
            row.enable_groups.iter().any(|group| group == "all")
                || row
                    .enable_groups
                    .iter()
                    .any(|group| usable.contains_key(group))
        })
        .collect()
}

/// `GET /api/pricing`: the public pricing table (Go `GetPricing`). Response
/// carries `data` (pricing rows filtered to the usable groups), `vendors`,
/// `group_ratio` (usable groups only), `usable_group`, `supported_endpoint`
/// (endpoint -> {path, method}), `auto_groups`, and the pricing version.
pub async fn get_pricing(_req: Request, env: Env) -> WorkerResult<Response> {
    let db = env.d1("DB")?;
    let opts = d1_repositories::option_values(
        &db,
        &[
            "ModelRatio",
            "CompletionRatio",
            "ModelPrice",
            "CacheRatio",
            "CreateCacheRatio",
            "UserUsableGroups",
            "GroupRatio",
            "AutoGroups",
        ],
    )
    .await?;
    use cinatoken_core::default_ratios as dr;
    let maps = PricingMaps {
        model_ratios: merged_ratio_map(dr::DEFAULT_MODEL_RATIO, opts[0].as_deref()),
        completion_ratios: merged_ratio_map(dr::DEFAULT_COMPLETION_RATIO, opts[1].as_deref()),
        model_prices: merged_ratio_map(dr::DEFAULT_MODEL_PRICE, opts[2].as_deref()),
        cache_ratios: merged_ratio_map(dr::DEFAULT_CACHE_RATIO, opts[3].as_deref()),
        create_cache_ratios: merged_ratio_map(dr::DEFAULT_CREATE_CACHE_RATIO, opts[4].as_deref()),
    };
    let usable = parse_usable_groups(opts[5].as_deref());
    let mut group_ratio = parse_group_ratios(opts[6].as_deref());
    group_ratio.retain(|group, _| usable.contains_key(group));
    // Go `setting.GetAutoGroups()` defaults to ["default"]; the option replaces
    // it. Only usable groups qualify (Go GetUserAutoGroup).
    let auto_groups: Vec<String> = opts[7]
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Vec<String>>(raw.trim()).ok())
        .unwrap_or_else(|| vec!["default".to_string()])
        .into_iter()
        .filter(|group| usable.contains_key(group))
        .collect();

    let abilities = d1_repositories::enabled_abilities_with_channel_type(&db).await?;
    let meta_rows = d1_repositories::list_model_meta(&db).await?;
    let vendors = d1_repositories::list_vendors(&db).await?;

    let rows = build_pricing_rows(&abilities, &meta_rows, &maps);
    let rows = filter_by_usable_groups(rows, &usable);

    // supported_endpoint map for the endpoints actually in use.
    let mut used_endpoints: HashSet<&str> = HashSet::new();
    for row in &rows {
        used_endpoints.extend(row.supported_endpoint_types.iter().copied());
    }
    let supported_endpoint: BTreeMap<&str, serde_json::Value> = DEFAULT_ENDPOINT_INFO
        .iter()
        .filter(|(endpoint, _)| used_endpoints.contains(endpoint))
        .map(|(endpoint, path)| {
            (
                *endpoint,
                serde_json::json!({"path": path, "method": "POST"}),
            )
        })
        .collect();

    // Go's response is the envelope PLUS extra top-level fields, so build it raw.
    Response::from_json(&serde_json::json!({
        "success": true,
        "message": "",
        "data": rows,
        "vendors": vendors,
        "group_ratio": group_ratio,
        "usable_group": usable,
        "supported_endpoint": supported_endpoint,
        "auto_groups": auto_groups,
        "pricing_version": PRICING_VERSION,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ability(model: &str, group: &str, channel_type: i32) -> AbilityWithChannelType {
        AbilityWithChannelType {
            model: model.to_string(),
            group_name: group.to_string(),
            channel_type,
        }
    }

    fn maps() -> PricingMaps {
        PricingMaps {
            model_ratios: [("gpt-4o".to_string(), 1.25)].into_iter().collect(),
            completion_ratios: BTreeMap::new(),
            model_prices: [("dall-e-3".to_string(), 0.04)].into_iter().collect(),
            cache_ratios: [("gpt-4o".to_string(), 0.5)].into_iter().collect(),
            create_cache_ratios: BTreeMap::new(),
        }
    }

    #[test]
    fn endpoint_mapping_matches_go() {
        assert_eq!(endpoint_types_for(38, "jina-reranker"), vec!["jina-rerank"]);
        assert_eq!(
            endpoint_types_for(14, "claude-3"),
            vec!["anthropic", "openai"]
        );
        assert_eq!(
            endpoint_types_for(24, "gemini-pro"),
            vec!["gemini", "openai"]
        );
        assert_eq!(
            endpoint_types_for(48, "grok-3"),
            vec!["openai", "openai-response"]
        );
        assert_eq!(endpoint_types_for(55, "sora-2"), vec!["openai-video"]);
        // Default channel: response-only model -> openai-response.
        assert_eq!(endpoint_types_for(1, "o3-pro"), vec!["openai-response"]);
        assert_eq!(endpoint_types_for(1, "gpt-4o"), vec!["openai"]);
        // Image model prepends image-generation (incl. the imagen- prefix rule).
        assert_eq!(
            endpoint_types_for(1, "dall-e-3"),
            vec!["image-generation", "openai"]
        );
        assert_eq!(
            endpoint_types_for(1, "imagen-3.0"),
            vec!["image-generation", "openai"]
        );
    }

    #[test]
    fn meta_matching_follows_name_rules_and_priority() {
        let rows = vec![
            ModelMetaRow {
                model_name: "gpt-4o".into(),
                description: "exact".into(),
                icon: String::new(),
                tags: String::new(),
                vendor_id: 0,
                endpoints: String::new(),
                status: 1,
                name_rule: 0,
            },
            ModelMetaRow {
                model_name: "gpt-".into(),
                description: "prefix".into(),
                icon: String::new(),
                tags: String::new(),
                vendor_id: 0,
                endpoints: String::new(),
                status: 1,
                name_rule: 1,
            },
            ModelMetaRow {
                model_name: "-mini".into(),
                description: "suffix".into(),
                icon: String::new(),
                tags: String::new(),
                vendor_id: 0,
                endpoints: String::new(),
                status: 1,
                name_rule: 3,
            },
        ];
        let models = vec![
            "gpt-4o".to_string(),
            "gpt-4o-mini".to_string(),
            "o4-mini".to_string(),
            "claude-3".to_string(),
        ];
        let matched = match_meta(&models, &rows);
        // Exact beats prefix for gpt-4o.
        assert_eq!(matched["gpt-4o"].description, "exact");
        // Prefix rule applies before suffix for gpt-4o-mini.
        assert_eq!(matched["gpt-4o-mini"].description, "prefix");
        // Suffix rule catches o4-mini.
        assert_eq!(matched["o4-mini"].description, "suffix");
        // No rule matches claude-3.
        assert!(!matched.contains_key("claude-3"));
    }

    #[test]
    fn pricing_rows_price_vs_ratio_and_disabled_meta() {
        let abilities = vec![
            ability("gpt-4o", "default", 1),
            ability("gpt-4o", "vip", 1),
            ability("dall-e-3", "default", 1),
            ability("hidden-model", "default", 1),
        ];
        let meta = vec![ModelMetaRow {
            model_name: "hidden-model".into(),
            description: "off".into(),
            icon: String::new(),
            tags: String::new(),
            vendor_id: 0,
            endpoints: String::new(),
            status: 0, // disabled -> dropped from pricing
            name_rule: 0,
        }];
        let rows = build_pricing_rows(&abilities, &meta, &maps());
        let by_name: HashMap<&str, &PricingRow> = rows
            .iter()
            .map(|row| (row.model_name.as_str(), row))
            .collect();
        // Priced model -> quota_type 1 with the price.
        let dalle = by_name["dall-e-3"];
        assert_eq!(dalle.quota_type, 1);
        assert_eq!(dalle.model_price, 0.04);
        // Ratio model -> quota_type 0 with ratio + cache ratio, groups sorted.
        let gpt = by_name["gpt-4o"];
        assert_eq!(gpt.quota_type, 0);
        assert_eq!(gpt.model_ratio, 1.25);
        assert_eq!(gpt.cache_ratio, Some(0.5));
        assert_eq!(gpt.enable_groups, vec!["default", "vip"]);
        // Disabled-by-meta model is gone entirely.
        assert!(!by_name.contains_key("hidden-model"));
    }

    #[test]
    fn usable_group_filter_keeps_all_and_intersections() {
        let usable: HashMap<String, String> = [("default".to_string(), "d".to_string())]
            .into_iter()
            .collect();
        let mk = |name: &str, groups: &[&str]| PricingRow {
            model_name: name.to_string(),
            enable_groups: groups.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        };
        let rows = vec![
            mk("keep-default", &["default"]),
            mk("keep-all", &["all"]),
            mk("drop-vip-only", &["vip"]),
        ];
        let kept = filter_by_usable_groups(rows, &usable);
        let names: Vec<&str> = kept.iter().map(|row| row.model_name.as_str()).collect();
        assert_eq!(names, vec!["keep-default", "keep-all"]);
    }
}
