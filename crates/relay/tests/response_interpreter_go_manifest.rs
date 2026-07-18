use std::collections::{BTreeMap, BTreeSet, HashSet};

use cinatoken_relay::{
    interpret_buffered_provider_response, should_forward_public_response_header,
    ProviderResponseClass, ProviderResponseProfile, PROVIDER_RESPONSE_INTERPRETER_CONTRACT,
};
use serde::Deserialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

const MANIFEST_JSON: &str = include_str!("fixtures/response_interpreter_go_manifest.json");
const GENERATOR_SCRIPT: &[u8] =
    include_bytes!("../../../tools/generate_go_response_interpreter_manifest.mjs");
const PINNED_COMMIT: &str = "73652508abc5cb09214dde02d51d69d1d1ccc703";
const EXPECTED_CASE_COUNT: usize = 27;
const EXPECTED_SOURCE_FILES: [&str; 7] = [
    "relay/compatible_handler.go",
    "relay/channel/openai/relay-openai.go",
    "dto/openai_response.go",
    "dto/error.go",
    "service/error.go",
    "service/http.go",
    "types/error.go",
];
const EXPECTED_HEADERS: [&str; 11] = [
    "Content-Type",
    "content-language",
    "Retry-After",
    "X-Request-ID",
    "request-id",
    "OpenAI-Request-ID",
    "Content-Length",
    "X-Oneapi-Request-Id",
    "Set-Cookie",
    "Authorization",
    "Transfer-Encoding",
];
const REQUIRED_STATUSES: [u16; 17] = [
    200, 201, 202, 204, 300, 302, 399, 400, 401, 404, 409, 422, 429, 500, 502, 503, 599,
];

#[derive(Debug, Deserialize)]
struct Manifest {
    schema_version: u16,
    contract: String,
    source: Source,
    generator: Generator,
    capabilities: Capabilities,
    cases: Vec<ResponseCase>,
    manifest_sha256: String,
}

#[derive(Debug, Deserialize)]
struct Source {
    repository: String,
    commit: String,
    files_sha256: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
struct Generator {
    runtime: String,
    injected_target: String,
    script_sha256: String,
    template_name: String,
    template_sha256: String,
}

#[derive(Debug, Deserialize)]
struct Capabilities {
    buffered_provider_response: bool,
    stream_partial_usage_shared_api: bool,
}

#[derive(Debug, Deserialize)]
struct ResponseCase {
    name: String,
    status: u16,
    body: String,
    expected: ExpectedResponse,
}

#[derive(Debug, Deserialize)]
struct ExpectedResponse {
    class: String,
    upstream_status: u16,
    client_status: u16,
    audit_status: u16,
    success: bool,
    has_json_object: bool,
    body_sha256: String,
    error: Option<ExpectedError>,
    usage: ExpectedUsage,
    header_decisions: Vec<HeaderDecision>,
}

#[derive(Debug, Deserialize)]
struct ExpectedError {
    message: String,
    #[serde(rename = "type")]
    kind: String,
    param: String,
    code: Value,
    metadata: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct ExpectedUsage {
    prompt_tokens: i32,
    completion_tokens: i32,
    total_tokens: i32,
    cached_tokens: i32,
    cache_creation_tokens: i32,
    claude_cache_creation_5m_tokens: i32,
    claude_cache_creation_1h_tokens: i32,
    image_input_tokens: i32,
    image_output_tokens: i32,
    audio_input_tokens: i32,
    audio_output_tokens: i32,
    is_anthropic_usage_semantic: bool,
    usage_semantic_source: String,
    provider_cost_usd: Option<String>,
    cache_creation_source: String,
    responses_web_search_calls: i32,
    responses_file_search_calls: i32,
    claude_web_search_calls: i32,
    image_generation_present: bool,
}

#[derive(Debug, Deserialize)]
struct HeaderDecision {
    name: String,
    source_eligible: bool,
    public_forward: bool,
}

fn manifest() -> Manifest {
    serde_json::from_str(MANIFEST_JSON).expect("Go response interpreter manifest must decode")
}

fn sha256(value: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(value.as_ref()))
}

fn is_lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn canonicalize(value: Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.into_iter().map(canonicalize).collect()),
        Value::Object(object) => {
            let mut entries = object.into_iter().collect::<Vec<_>>();
            entries.sort_by(|left, right| left.0.cmp(&right.0));
            let mut canonical = Map::new();
            for (key, value) in entries {
                canonical.insert(key, canonicalize(value));
            }
            Value::Object(canonical)
        }
        other => other,
    }
}

fn canonical_manifest_digest() -> String {
    let mut value: Value =
        serde_json::from_str(MANIFEST_JSON).expect("manifest JSON must decode as a value");
    value
        .as_object_mut()
        .expect("manifest must be a JSON object")
        .remove("manifest_sha256")
        .expect("manifest must carry its digest");
    let encoded = serde_json::to_vec(&canonicalize(value))
        .expect("canonical manifest payload must serialize");
    sha256(encoded)
}

fn class_name(class: ProviderResponseClass) -> &'static str {
    match class {
        ProviderResponseClass::Success => "success",
        ProviderResponseClass::TypedError => "typed_error",
        ProviderResponseClass::HttpError => "http_error",
        ProviderResponseClass::InvalidBody => "invalid_body",
    }
}

fn assert_usage(case: &ResponseCase, actual: cinatoken_relay::UsageSummary) {
    let expected = &case.expected.usage;
    assert_eq!(
        actual.prompt_tokens, expected.prompt_tokens,
        "{} prompt tokens",
        case.name
    );
    assert_eq!(
        actual.completion_tokens, expected.completion_tokens,
        "{} completion tokens",
        case.name
    );
    assert_eq!(
        actual.total_tokens, expected.total_tokens,
        "{} total tokens",
        case.name
    );
    assert_eq!(
        actual.cached_tokens, expected.cached_tokens,
        "{} cached tokens",
        case.name
    );
    assert_eq!(
        actual.cache_creation_tokens, expected.cache_creation_tokens,
        "{} cache creation tokens",
        case.name
    );
    assert_eq!(
        actual.claude_cache_creation_5m_tokens, expected.claude_cache_creation_5m_tokens,
        "{} 5m cache creation tokens",
        case.name
    );
    assert_eq!(
        actual.claude_cache_creation_1h_tokens, expected.claude_cache_creation_1h_tokens,
        "{} 1h cache creation tokens",
        case.name
    );
    assert_eq!(
        actual.image_input_tokens, expected.image_input_tokens,
        "{} image input tokens",
        case.name
    );
    assert_eq!(
        actual.image_output_tokens, expected.image_output_tokens,
        "{} image output tokens",
        case.name
    );
    assert_eq!(
        actual.audio_input_tokens, expected.audio_input_tokens,
        "{} audio input tokens",
        case.name
    );
    assert_eq!(
        actual.audio_output_tokens, expected.audio_output_tokens,
        "{} audio output tokens",
        case.name
    );
    assert_eq!(
        actual.is_anthropic_usage_semantic, expected.is_anthropic_usage_semantic,
        "{} usage semantic",
        case.name
    );
    assert_eq!(
        actual.usage_semantic_source.as_str(),
        expected.usage_semantic_source,
        "{} usage semantic source",
        case.name
    );
    assert_eq!(
        actual.provider_cost_usd.map(|cost| cost.to_string()),
        expected.provider_cost_usd,
        "{} provider cost",
        case.name
    );
    assert_eq!(
        actual.cache_creation_source.as_str(),
        expected.cache_creation_source,
        "{} cache creation source",
        case.name
    );
    assert_eq!(
        actual.tool_usage.responses_web_search_calls, expected.responses_web_search_calls,
        "{} response web searches",
        case.name
    );
    assert_eq!(
        actual.tool_usage.responses_file_search_calls, expected.responses_file_search_calls,
        "{} response file searches",
        case.name
    );
    assert_eq!(
        actual.tool_usage.claude_web_search_calls, expected.claude_web_search_calls,
        "{} Claude web searches",
        case.name
    );
    assert_eq!(
        actual.tool_usage.image_generation.is_some(),
        expected.image_generation_present,
        "{} image generation usage",
        case.name
    );
}

#[test]
fn immutable_manifest_has_pinned_identity_unique_coverage_and_valid_digest() {
    let manifest = manifest();
    assert_eq!(manifest.schema_version, 1);
    assert_eq!(manifest.contract, PROVIDER_RESPONSE_INTERPRETER_CONTRACT);
    assert_eq!(manifest.source.repository, "github.com/cinagroup/cinatoken");
    assert_eq!(manifest.source.commit, PINNED_COMMIT);
    assert_eq!(manifest.cases.len(), EXPECTED_CASE_COUNT);
    assert_eq!(manifest.manifest_sha256, canonical_manifest_digest());
    assert!(is_lower_hex(&manifest.manifest_sha256, 64));

    let expected_source_files = EXPECTED_SOURCE_FILES
        .into_iter()
        .map(str::to_string)
        .collect::<BTreeSet<_>>();
    assert_eq!(
        manifest
            .source
            .files_sha256
            .keys()
            .cloned()
            .collect::<BTreeSet<_>>(),
        expected_source_files
    );
    for (path, digest) in &manifest.source.files_sha256 {
        assert!(
            is_lower_hex(digest, 64),
            "source hash for {path} must be lowercase SHA-256"
        );
    }

    assert_eq!(
        manifest.generator.runtime,
        "go test ./relay/channel/openai against pinned source"
    );
    assert_eq!(
        manifest.generator.injected_target,
        "relay/channel/openai/zz_cinatoken_response_interpreter_manifest_test.go"
    );
    assert_eq!(
        manifest.generator.template_name,
        "embedded_go_response_interpreter_manifest_test.go"
    );
    assert_eq!(manifest.generator.script_sha256, sha256(GENERATOR_SCRIPT));
    assert!(is_lower_hex(&manifest.generator.template_sha256, 64));
    assert!(manifest.capabilities.buffered_provider_response);
    assert!(!manifest.capabilities.stream_partial_usage_shared_api);

    let mut names = HashSet::new();
    let mut statuses = BTreeSet::new();
    let mut class_counts = BTreeMap::<&str, usize>::new();
    for case in &manifest.cases {
        assert!(
            names.insert(case.name.as_str()),
            "duplicate case {}",
            case.name
        );
        statuses.insert(case.status);
        *class_counts
            .entry(case.expected.class.as_str())
            .or_default() += 1;
        assert_eq!(case.expected.upstream_status, case.status, "{}", case.name);
        assert_eq!(case.expected.body_sha256, sha256(case.body.as_bytes()));

        let header_names = case
            .expected
            .header_decisions
            .iter()
            .map(|decision| decision.name.as_str())
            .collect::<Vec<_>>();
        assert_eq!(header_names, EXPECTED_HEADERS, "{} headers", case.name);
        let mut unique_headers = HashSet::new();
        for decision in &case.expected.header_decisions {
            assert!(
                unique_headers.insert(decision.name.to_ascii_lowercase()),
                "{} duplicates header {}",
                case.name,
                decision.name
            );
            let source_eligible = !matches!(
                decision.name.to_ascii_lowercase().as_str(),
                "content-length" | "x-oneapi-request-id"
            );
            assert_eq!(
                decision.source_eligible, source_eligible,
                "{} source eligibility for {}",
                case.name, decision.name
            );
        }
    }
    for status in REQUIRED_STATUSES {
        assert!(statuses.contains(&status), "missing status {status}");
    }
    assert_eq!(class_counts.get("success"), Some(&4));
    assert_eq!(class_counts.get("typed_error"), Some(&3));
    assert_eq!(class_counts.get("invalid_body"), Some(&3));
    assert_eq!(class_counts.get("http_error"), Some(&17));
    assert_eq!(class_counts.len(), 4);
}

#[test]
fn rust_buffered_interpreter_matches_every_go_manifest_case() {
    let manifest = manifest();
    for case in &manifest.cases {
        let response = interpret_buffered_provider_response(
            ProviderResponseProfile::default(),
            case.status,
            case.body.as_bytes(),
        );
        let expected = &case.expected;

        assert_eq!(
            class_name(response.class()),
            expected.class,
            "{} class",
            case.name
        );
        assert_eq!(
            response.upstream_status(),
            expected.upstream_status,
            "{} upstream status",
            case.name
        );
        assert_eq!(
            response.client_status(),
            expected.client_status,
            "{} client status",
            case.name
        );
        assert_eq!(
            response.audit_status(),
            expected.audit_status,
            "{} audit status",
            case.name
        );
        assert_eq!(
            response.is_success(),
            expected.success,
            "{} success",
            case.name
        );
        assert_eq!(
            response.json_value().is_some(),
            expected.has_json_object,
            "{} parsed JSON object",
            case.name
        );
        assert_eq!(
            response.body_sha256(),
            expected.body_sha256,
            "{} body hash",
            case.name
        );

        match (&expected.error, response.error()) {
            (None, None) => {}
            (Some(expected_error), Some(actual_error)) => {
                assert_eq!(
                    actual_error.message, expected_error.message,
                    "{} error message",
                    case.name
                );
                assert_eq!(
                    actual_error.kind, expected_error.kind,
                    "{} error type",
                    case.name
                );
                assert_eq!(
                    actual_error.param, expected_error.param,
                    "{} error param",
                    case.name
                );
                assert_eq!(
                    actual_error.code, expected_error.code,
                    "{} error code",
                    case.name
                );
                assert_eq!(
                    actual_error.metadata, expected_error.metadata,
                    "{} error metadata",
                    case.name
                );
            }
            (expected_error, actual_error) => panic!(
                "{} error presence mismatch: expected {}, actual {}",
                case.name,
                expected_error.is_some(),
                actual_error.is_some()
            ),
        }

        assert_usage(case, response.usage());
        for decision in &expected.header_decisions {
            assert_eq!(
                should_forward_public_response_header(&decision.name, response.class()),
                decision.public_forward,
                "{} public header decision for {}",
                case.name,
                decision.name
            );
        }
    }
}
