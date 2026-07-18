//! Transport-neutral interpretation of bounded provider responses.
//!
//! The Worker and Container egress paths both call this module after applying
//! their own body-size and deadline limits. Routing, retries, persistence, and
//! billing remain caller policy; this module freezes the response facts they
//! must agree on.

use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::openai_compatible::{
    usage_summary_from_anthropic_body, usage_summary_from_body_with_cache_policy,
    usage_summary_from_gemini_body, usage_summary_from_moonshot_body,
    usage_summary_from_rerank_body, UsageCacheFieldPolicy, UsageSummary,
};

pub const MAX_PROVIDER_REQUEST_ID_BYTES: usize = 128;
pub const PROVIDER_RESPONSE_INTERPRETER_CONTRACT: &str = "go-openai-response-v1";

/// Provider headers that may cross the public success boundary.
///
/// Error responses are rebuilt locally and never inherit provider headers.
pub const PUBLIC_SUCCESS_RESPONSE_HEADERS: &[&str] = &[
    "content-type",
    "content-language",
    "retry-after",
    "x-request-id",
    "request-id",
    "openai-request-id",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderResponseProfile {
    OpenAiCompatible(UsageCacheFieldPolicy),
    Moonshot,
    Anthropic,
    Gemini,
    Rerank,
}

impl Default for ProviderResponseProfile {
    fn default() -> Self {
        Self::OpenAiCompatible(UsageCacheFieldPolicy::Standard)
    }
}

impl ProviderResponseProfile {
    fn detects_openai_error(self) -> bool {
        matches!(
            self,
            Self::OpenAiCompatible(_) | Self::Moonshot | Self::Rerank
        )
    }

    fn usage(self, body: &str) -> UsageSummary {
        match self {
            Self::OpenAiCompatible(policy) => {
                usage_summary_from_body_with_cache_policy(body, policy)
            }
            Self::Moonshot => usage_summary_from_moonshot_body(body),
            Self::Anthropic => usage_summary_from_anthropic_body(body),
            Self::Gemini => usage_summary_from_gemini_body(body),
            Self::Rerank => usage_summary_from_rerank_body(body),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderResponseClass {
    Success,
    TypedError,
    HttpError,
    InvalidBody,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OpenAiCompatibleError {
    pub message: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub param: String,
    pub code: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OpenAiCompatibleErrorEnvelope {
    pub error: OpenAiCompatibleError,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BufferedProviderResponse {
    upstream_status: u16,
    client_status: u16,
    class: ProviderResponseClass,
    body_sha256: String,
    value: Option<Value>,
    error: Option<OpenAiCompatibleError>,
    usage: UsageSummary,
}

impl BufferedProviderResponse {
    pub fn upstream_status(&self) -> u16 {
        self.upstream_status
    }

    pub fn client_status(&self) -> u16 {
        self.client_status
    }

    pub fn audit_status(&self) -> u16 {
        if self.is_success() || self.upstream_status >= 400 {
            self.upstream_status
        } else {
            500
        }
    }

    pub fn class(&self) -> ProviderResponseClass {
        self.class
    }

    pub fn is_success(&self) -> bool {
        self.class == ProviderResponseClass::Success
    }

    pub fn body_sha256(&self) -> &str {
        &self.body_sha256
    }

    pub fn json_value(&self) -> Option<&Value> {
        self.value.as_ref()
    }

    pub fn error(&self) -> Option<&OpenAiCompatibleError> {
        self.error.as_ref()
    }

    pub fn error_envelope(&self) -> Option<OpenAiCompatibleErrorEnvelope> {
        self.error
            .clone()
            .map(|error| OpenAiCompatibleErrorEnvelope { error })
    }

    pub fn usage(&self) -> UsageSummary {
        self.usage
    }
}

/// Interpret one bounded, non-streaming JSON response using the Go relay's
/// outer status and dynamic OpenAI-error rules.
pub fn interpret_buffered_provider_response(
    profile: ProviderResponseProfile,
    upstream_status: u16,
    body: &[u8],
) -> BufferedProviderResponse {
    let body_sha256 = format!("{:x}", Sha256::digest(body));
    let parsed = serde_json::from_slice::<Value>(body)
        .ok()
        .filter(Value::is_object);

    if upstream_status != 200 {
        let error = parsed
            .as_ref()
            .and_then(Value::as_object)
            .and_then(openai_error_from_http_error)
            .unwrap_or_else(|| generic_http_error(upstream_status, parsed.as_ref()));
        return BufferedProviderResponse {
            upstream_status,
            client_status: upstream_status,
            class: ProviderResponseClass::HttpError,
            body_sha256,
            value: parsed,
            error: Some(error),
            usage: UsageSummary::default(),
        };
    }

    let Some(value) = parsed else {
        return BufferedProviderResponse {
            upstream_status,
            client_status: 500,
            class: ProviderResponseClass::InvalidBody,
            body_sha256,
            value: None,
            error: Some(OpenAiCompatibleError {
                message: "invalid upstream JSON response".to_string(),
                kind: "bad_response_body".to_string(),
                param: String::new(),
                code: Value::String("bad_response_body".to_string()),
                metadata: None,
            }),
            usage: UsageSummary::default(),
        };
    };

    if profile.detects_openai_error() {
        if let Some(error) = value
            .as_object()
            .and_then(|object| object.get("error"))
            .and_then(dynamic_openai_error)
            .filter(|error| !error.kind.is_empty())
        {
            return BufferedProviderResponse {
                upstream_status,
                client_status: upstream_status,
                class: ProviderResponseClass::TypedError,
                body_sha256,
                value: Some(value),
                error: Some(error),
                usage: UsageSummary::default(),
            };
        }
    }

    let body = std::str::from_utf8(body).unwrap_or_default();
    BufferedProviderResponse {
        upstream_status,
        client_status: upstream_status,
        class: ProviderResponseClass::Success,
        body_sha256,
        value: Some(value),
        error: None,
        usage: profile.usage(body),
    }
}

pub fn should_forward_public_response_header(name: &str, class: ProviderResponseClass) -> bool {
    class == ProviderResponseClass::Success
        && PUBLIC_SUCCESS_RESPONSE_HEADERS
            .iter()
            .any(|allowed| name.eq_ignore_ascii_case(allowed))
}

pub fn first_safe_provider_request_id<'a>(
    candidates: impl IntoIterator<Item = Option<&'a str>>,
) -> Option<String> {
    candidates
        .into_iter()
        .flatten()
        .find(|value| valid_provider_request_id(value))
        .map(str::to_string)
}

pub fn valid_provider_request_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_PROVIDER_REQUEST_ID_BYTES
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'/' | b'@' | b'-')
        })
}

fn dynamic_openai_error(value: &Value) -> Option<OpenAiCompatibleError> {
    match value {
        Value::Null => None,
        Value::Object(object) => Some(OpenAiCompatibleError {
            message: string_field(object, "message"),
            kind: string_field(object, "type"),
            param: string_field(object, "param"),
            code: object.get("code").cloned().unwrap_or(Value::Null),
            metadata: None,
        }),
        Value::String(message) => Some(OpenAiCompatibleError {
            message: message.clone(),
            kind: "error".to_string(),
            param: String::new(),
            code: Value::Null,
            metadata: None,
        }),
        other => Some(OpenAiCompatibleError {
            message: scalar_error_message(other),
            kind: "unknown_error".to_string(),
            param: String::new(),
            code: Value::Null,
            metadata: None,
        }),
    }
}

fn openai_error_from_http_error(object: &Map<String, Value>) -> Option<OpenAiCompatibleError> {
    let error = object.get("error")?.as_object()?;
    let mut parsed = strict_openai_error(error)?;
    if parsed.message.is_empty() {
        return None;
    }
    if parsed.kind.is_empty() {
        parsed.kind = "upstream_error".to_string();
    }
    Some(parsed)
}

fn strict_openai_error(object: &Map<String, Value>) -> Option<OpenAiCompatibleError> {
    Some(OpenAiCompatibleError {
        message: strict_string_field(object, "message")?,
        kind: strict_string_field(object, "type")?,
        param: strict_string_field(object, "param")?,
        code: object.get("code").cloned().unwrap_or(Value::Null),
        metadata: object.get("metadata").cloned(),
    })
}

fn generic_http_error(status: u16, value: Option<&Value>) -> OpenAiCompatibleError {
    let message = value
        .and_then(Value::as_object)
        .and_then(general_error_message)
        .filter(|message| !message.is_empty())
        .unwrap_or_else(|| format!("bad response status code {status}"));
    OpenAiCompatibleError {
        message,
        kind: "bad_response_status_code".to_string(),
        param: String::new(),
        code: Value::String("bad_response_status_code".to_string()),
        metadata: None,
    }
}

fn general_error_message(object: &Map<String, Value>) -> Option<String> {
    if let Some(error) = object.get("error") {
        match error {
            Value::Object(error) => {
                if let Some(parsed) = strict_openai_error(error) {
                    if !parsed.message.is_empty() {
                        return Some(parsed.message);
                    }
                }
            }
            Value::String(message) if !message.is_empty() => return Some(message.clone()),
            other => return Some(other.to_string()),
        }
    }
    for field in ["message", "msg", "err", "error_msg", "detail"] {
        if let Some(message) = object.get(field).and_then(Value::as_str) {
            if !message.is_empty() {
                return Some(message.to_string());
            }
        }
    }
    nested_string(object, &["header", "message"])
        .or_else(|| nested_string(object, &["response", "error", "message"]))
}

fn nested_string(object: &Map<String, Value>, path: &[&str]) -> Option<String> {
    let mut current = object.get(*path.first()?)?;
    for segment in &path[1..] {
        current = current.get(*segment)?;
    }
    current
        .as_str()
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn string_field(object: &Map<String, Value>, field: &str) -> String {
    object
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn strict_string_field(object: &Map<String, Value>, field: &str) -> Option<String> {
    match object.get(field) {
        None | Some(Value::Null) => Some(String::new()),
        Some(Value::String(value)) => Some(value.clone()),
        Some(_) => None,
    }
}

fn scalar_error_message(value: &Value) -> String {
    match value {
        Value::Null => "<nil>".to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => value.clone(),
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(scalar_error_message)
                .collect::<Vec<_>>()
                .join(" ")
        ),
        Value::Object(values) => {
            let mut entries = values.iter().collect::<Vec<_>>();
            entries.sort_unstable_by(|left, right| left.0.cmp(right.0));
            format!(
                "map[{}]",
                entries
                    .into_iter()
                    .map(|(key, value)| format!("{key}:{}", scalar_error_message(value)))
                    .collect::<Vec<_>>()
                    .join(" ")
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn interpret(status: u16, body: &str) -> BufferedProviderResponse {
        interpret_buffered_provider_response(
            ProviderResponseProfile::default(),
            status,
            body.as_bytes(),
        )
    }

    #[test]
    fn only_exact_200_is_ordinary_success() {
        let success = interpret(
            200,
            r#"{"id":"chatcmpl-1","usage":{"prompt_tokens":7,"completion_tokens":5,"total_tokens":12}}"#,
        );
        assert!(success.is_success());
        assert_eq!(success.client_status(), 200);
        assert_eq!(success.usage().total_tokens, 12);

        for status in [201, 202, 204, 206, 299, 300] {
            let response = interpret(status, r#"{"id":"not-success"}"#);
            assert_eq!(response.class(), ProviderResponseClass::HttpError);
            assert_eq!(response.client_status(), status);
            assert_eq!(response.usage(), UsageSummary::default());
        }
    }

    #[test]
    fn interpreter_contract_name_is_versioned() {
        assert_eq!(
            PROVIDER_RESPONSE_INTERPRETER_CONTRACT,
            "go-openai-response-v1"
        );
    }

    #[test]
    fn typed_error_inside_200_preserves_go_dynamic_semantics() {
        let typed = interpret(
            200,
            r#"{"error":{"message":"rate limited","type":"rate_limit_error","param":"model","code":429}}"#,
        );
        assert_eq!(typed.class(), ProviderResponseClass::TypedError);
        assert_eq!(typed.client_status(), 200);
        assert_eq!(typed.audit_status(), 500);
        assert_eq!(typed.error().unwrap().message, "rate limited");
        assert_eq!(typed.error().unwrap().code, json!(429));
        assert_eq!(typed.usage(), UsageSummary::default());

        let string_error = interpret(200, r#"{"error":"provider failed"}"#);
        assert_eq!(string_error.class(), ProviderResponseClass::TypedError);
        assert_eq!(string_error.error().unwrap().kind, "error");

        let array_error = interpret(200, r#"{"error":["provider",429,true]}"#);
        assert_eq!(array_error.class(), ProviderResponseClass::TypedError);
        assert_eq!(array_error.error().unwrap().message, "[provider 429 true]");

        let message_only = interpret(200, r#"{"error":{"message":"not typed"}}"#);
        assert!(message_only.is_success());
    }

    #[test]
    fn non_200_errors_follow_go_message_precedence() {
        let openai = interpret(
            429,
            r#"{"error":{"message":"slow down","type":"rate_limit_error","code":"rate_limit"},"message":"ignored"}"#,
        );
        assert_eq!(openai.error().unwrap().message, "slow down");
        assert_eq!(openai.error().unwrap().kind, "rate_limit_error");
        assert_eq!(openai.error().unwrap().code, json!("rate_limit"));

        let general = interpret(503, r#"{"msg":"try later","detail":"ignored"}"#);
        assert_eq!(general.error().unwrap().message, "try later");
        assert_eq!(general.error().unwrap().kind, "bad_response_status_code");

        let malformed = interpret(500, "not-json");
        assert_eq!(
            malformed.error().unwrap().message,
            "bad response status code 500"
        );
    }

    #[test]
    fn malformed_200_is_a_bad_response_body() {
        for body in ["", "[]", "null", "not-json"] {
            let response = interpret(200, body);
            assert_eq!(response.class(), ProviderResponseClass::InvalidBody);
            assert_eq!(response.client_status(), 500);
            assert_eq!(response.error().unwrap().kind, "bad_response_body");
        }
    }

    #[test]
    fn errors_never_forward_provider_headers() {
        for class in [
            ProviderResponseClass::TypedError,
            ProviderResponseClass::HttpError,
            ProviderResponseClass::InvalidBody,
        ] {
            for name in PUBLIC_SUCCESS_RESPONSE_HEADERS {
                assert!(!should_forward_public_response_header(name, class));
            }
        }
        assert!(should_forward_public_response_header(
            "OpenAI-Request-ID",
            ProviderResponseClass::Success
        ));
        assert!(!should_forward_public_response_header(
            "set-cookie",
            ProviderResponseClass::Success
        ));
    }

    #[test]
    fn request_id_selection_is_ordered_and_bounded() {
        assert_eq!(
            first_safe_provider_request_id([
                Some("unsafe request"),
                Some("request-safe_1"),
                Some("later"),
            ]),
            Some("request-safe_1".to_string())
        );
        let oversized = "x".repeat(MAX_PROVIDER_REQUEST_ID_BYTES + 1);
        assert_eq!(
            first_safe_provider_request_id([Some(oversized.as_str())]),
            None
        );
    }
}
