use std::collections::HashSet;

use cinatoken_billing::{
    compute_flat_quota_from_snapshot, estimate_flat_pre_consumed_quota,
    free_model_runtime_decision, FlatBillingMode, FlatPricingSnapshot, FlatUsage,
    ImageGenerationPriceClass, PricingConfig,
};
use serde::Deserialize;

const MANIFEST: &str = include_str!("fixtures/flat_billing_go_manifest.json");

#[derive(Debug, Deserialize)]
struct Manifest {
    schema_version: u16,
    manifest_sha256: String,
    source: Source,
    terminal_cases: Vec<TerminalCase>,
    admission_cases: Vec<AdmissionCase>,
}

#[derive(Debug, Deserialize)]
struct Source {
    repository: String,
    commit: String,
}

#[derive(Debug, Deserialize)]
struct TerminalCase {
    name: String,
    kind: String,
    model: String,
    snapshot: Snapshot,
    usage: Usage,
    expected_quota: i64,
}

#[derive(Debug, Deserialize)]
struct Snapshot {
    mode: String,
    model_ratio: f64,
    completion_ratio: f64,
    group_ratio: f64,
    cache_ratio: f64,
    cache_creation_ratio: f64,
    cache_creation_ratio_5m: f64,
    cache_creation_ratio_1h: f64,
    image_ratio: f64,
    audio_ratio: f64,
    audio_completion_ratio: f64,
    uses_audio_detail_billing: bool,
    audio_input_price_per_million: f64,
    quota_per_unit: f64,
    model_price: Option<f64>,
    image_price_ratio: f64,
    other_ratio_product: f64,
}

#[derive(Debug, Deserialize)]
struct Usage {
    prompt_tokens: i64,
    completion_tokens: i64,
    total_tokens: i64,
    cached_tokens: i64,
    cache_creation_tokens: i64,
    cache_creation_5m_tokens: i64,
    cache_creation_1h_tokens: i64,
    image_tokens: i64,
    audio_input_tokens: i64,
    audio_output_tokens: i64,
    web_search_preview_calls: i64,
    web_search_calls: i64,
    file_search_calls: i64,
    image_generation_price_class: Option<String>,
    is_anthropic_usage_semantic: bool,
}

#[derive(Debug, Deserialize)]
struct AdmissionCase {
    name: String,
    input: AdmissionInput,
    expected: AdmissionExpected,
}

#[derive(Debug, Deserialize)]
struct AdmissionInput {
    model: String,
    group: String,
    prompt_tokens: i64,
    max_tokens: i64,
    image_price_ratio: f64,
    model_ratios: String,
    completion_ratios: String,
    model_prices: String,
    cache_ratios: String,
    create_cache_ratios: String,
    image_ratios: String,
    audio_ratios: String,
    audio_completion_ratios: String,
    group_ratios: String,
    self_use_mode: bool,
    accept_unset_ratio_model: bool,
    enable_free_model_pre_consume: bool,
}

#[derive(Debug, Deserialize)]
struct AdmissionExpected {
    admitted: bool,
    mode: Option<String>,
    model_price: f64,
    model_ratio: f64,
    completion_ratio: f64,
    group_ratio: f64,
    cache_ratio: f64,
    cache_creation_ratio: f64,
    image_ratio: f64,
    audio_ratio: f64,
    audio_completion_ratio: f64,
    pre_consumed_quota: i64,
    free_model: bool,
    error_code: Option<String>,
}

fn manifest() -> Manifest {
    serde_json::from_str(MANIFEST).expect("Go flat billing manifest must decode")
}

fn image_price_class(value: Option<&str>) -> Option<ImageGenerationPriceClass> {
    match value {
        None => None,
        Some("low_1024x1024") => Some(ImageGenerationPriceClass::Low1024x1024),
        Some(other) => panic!("unsupported manifest image price class: {other}"),
    }
}

fn snapshot_for(case: &TerminalCase) -> FlatPricingSnapshot {
    let input = &case.snapshot;
    let mut config = PricingConfig::new();
    config
        .model_ratios
        .insert(case.model.clone(), input.model_ratio);
    config
        .completion_ratios
        .insert(case.model.clone(), input.completion_ratio);
    config
        .group_ratios
        .insert("manifest".to_string(), input.group_ratio);
    if let Some(price) = input.model_price {
        config.model_prices.insert(case.model.clone(), price);
    }
    config.quota_per_unit = input.quota_per_unit;

    let mut snapshot = FlatPricingSnapshot::from_config(
        &case.model,
        "manifest",
        &config,
        input.other_ratio_product,
        0,
    )
    .with_image_price_ratio(input.image_price_ratio);
    snapshot.mode = match input.mode.as_str() {
        "per_token" => FlatBillingMode::PerToken,
        "fixed_price" => FlatBillingMode::FixedPrice,
        other => panic!("unsupported manifest billing mode: {other}"),
    };
    snapshot.model_ratio = input.model_ratio;
    snapshot.completion_ratio = input.completion_ratio;
    snapshot.group_ratio = input.group_ratio;
    snapshot.cache_ratio = input.cache_ratio;
    snapshot.cache_creation_ratio = input.cache_creation_ratio;
    snapshot.cache_creation_ratio_5m = input.cache_creation_ratio_5m;
    snapshot.cache_creation_ratio_1h = input.cache_creation_ratio_1h;
    snapshot.image_ratio = input.image_ratio;
    snapshot.audio_ratio = input.audio_ratio;
    snapshot.audio_completion_ratio = input.audio_completion_ratio;
    snapshot.uses_audio_detail_billing = input.uses_audio_detail_billing;
    snapshot.audio_input_price_per_million = input.audio_input_price_per_million;
    snapshot.quota_per_unit = input.quota_per_unit;
    snapshot.model_price = input.model_price;
    snapshot
}

fn usage_for(case: &TerminalCase) -> FlatUsage {
    let usage = &case.usage;
    FlatUsage {
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
        cached_tokens: usage.cached_tokens,
        cache_creation_tokens: usage.cache_creation_tokens,
        cache_creation_5m_tokens: usage.cache_creation_5m_tokens,
        cache_creation_1h_tokens: usage.cache_creation_1h_tokens,
        image_tokens: usage.image_tokens,
        audio_input_tokens: usage.audio_input_tokens,
        audio_output_tokens: usage.audio_output_tokens,
        web_search_preview_calls: usage.web_search_preview_calls,
        web_search_calls: usage.web_search_calls,
        file_search_calls: usage.file_search_calls,
        image_generation_price_class: image_price_class(
            usage.image_generation_price_class.as_deref(),
        ),
        is_anthropic_usage_semantic: usage.is_anthropic_usage_semantic,
    }
}

fn admission_config(input: &AdmissionInput) -> PricingConfig {
    PricingConfig::new()
        .with_json_maps(
            Some(&input.model_ratios),
            Some(&input.completion_ratios),
            Some(&input.model_prices),
            Some(&input.cache_ratios),
            Some(&input.group_ratios),
            None,
        )
        .with_subcategory_maps(
            Some(&input.create_cache_ratios),
            Some(&input.image_ratios),
            Some(&input.audio_ratios),
            Some(&input.audio_completion_ratios),
        )
        .with_self_use_mode(input.self_use_mode || input.accept_unset_ratio_model)
}

#[test]
fn immutable_manifest_has_source_identity_and_unique_cases() {
    let manifest = manifest();
    assert_eq!(manifest.schema_version, 1);
    assert_eq!(manifest.source.repository, "github.com/cinagroup/cinatoken");
    assert_eq!(manifest.source.commit.len(), 40);
    assert_eq!(manifest.manifest_sha256.len(), 64);

    let mut names = HashSet::new();
    for name in manifest
        .terminal_cases
        .iter()
        .map(|case| case.name.as_str())
        .chain(
            manifest
                .admission_cases
                .iter()
                .map(|case| case.name.as_str()),
        )
    {
        assert!(names.insert(name), "duplicate manifest case {name}");
    }
}

#[test]
fn rust_terminal_flat_billing_matches_go_manifest() {
    let manifest = manifest();
    for case in &manifest.terminal_cases {
        assert!(matches!(case.kind.as_str(), "text" | "audio_detail"));
        let snapshot = snapshot_for(case);
        snapshot
            .validate()
            .unwrap_or_else(|error| panic!("{} snapshot invalid: {error}", case.name));
        let result = compute_flat_quota_from_snapshot(&usage_for(case), &snapshot);
        assert_eq!(
            result.quota, case.expected_quota,
            "Go/Rust terminal quota mismatch for {}",
            case.name
        );
    }
}

#[test]
fn rust_flat_admission_and_preconsume_match_go_manifest() {
    let manifest = manifest();
    for case in &manifest.admission_cases {
        let input = &case.input;
        let expected = &case.expected;
        let config = admission_config(input);
        assert_eq!(
            config.admits_model(&input.model),
            expected.admitted,
            "admission mismatch for {}",
            case.name
        );
        if !expected.admitted {
            assert_eq!(
                expected.error_code.as_deref(),
                Some("model_price_not_configured")
            );
            continue;
        }

        let snapshot =
            FlatPricingSnapshot::from_config(&input.model, &input.group, &config, 1.0, 500)
                .with_image_price_ratio(input.image_price_ratio);
        let mode = match snapshot.mode {
            FlatBillingMode::FixedPrice => "fixed_price",
            FlatBillingMode::PerToken => "per_token",
        };
        assert_eq!(
            Some(mode),
            expected.mode.as_deref(),
            "mode for {}",
            case.name
        );
        assert_eq!(
            snapshot.group_ratio, expected.group_ratio,
            "group ratio for {}",
            case.name
        );
        if snapshot.mode == FlatBillingMode::PerToken {
            assert_eq!(
                snapshot.model_ratio, expected.model_ratio,
                "model ratio for {}",
                case.name
            );
            assert_eq!(
                snapshot.completion_ratio, expected.completion_ratio,
                "completion ratio for {}",
                case.name
            );
            assert_eq!(
                snapshot.cache_ratio, expected.cache_ratio,
                "cache ratio for {}",
                case.name
            );
            assert_eq!(
                snapshot.cache_creation_ratio, expected.cache_creation_ratio,
                "cache creation ratio for {}",
                case.name
            );
            assert_eq!(
                snapshot.image_ratio, expected.image_ratio,
                "image ratio for {}",
                case.name
            );
            assert_eq!(
                snapshot.audio_ratio, expected.audio_ratio,
                "audio ratio for {}",
                case.name
            );
            assert_eq!(
                snapshot.audio_completion_ratio, expected.audio_completion_ratio,
                "audio completion ratio for {}",
                case.name
            );
        }

        let effective_model_price = match snapshot.mode {
            FlatBillingMode::FixedPrice => {
                snapshot.model_price.unwrap_or_default() * snapshot.image_price_ratio
            }
            FlatBillingMode::PerToken => -1.0,
        };
        assert_eq!(
            effective_model_price, expected.model_price,
            "model price for {}",
            case.name
        );
        assert_eq!(
            estimate_flat_pre_consumed_quota(&snapshot, input.prompt_tokens, input.max_tokens,),
            expected.pre_consumed_quota,
            "pre-consume quota for {}",
            case.name
        );

        let go_free_model =
            free_model_runtime_decision(&snapshot, input.enable_free_model_pre_consume).free_model;
        assert_eq!(
            go_free_model, expected.free_model,
            "free-model policy for {}",
            case.name
        );
    }
}
