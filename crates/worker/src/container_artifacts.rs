//! Immutable R2 artifacts exchanged with the native Container execution plane.

use js_sys::{Object as JsObject, Reflect, Uint8Array};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;
use worker::{Env, Headers, Object as R2Object, Response, ResponseBody};

pub const CONTAINER_ARTIFACT_BUCKET: &str = "FILE_BUCKET";
pub const MAX_CONTAINER_ARTIFACT_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_CONTAINER_CLIENT_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

const INPUT_KEY_PREFIX: &str = "container-inputs/v1";
const CLIENT_RESPONSE_KEY_PREFIX: &str = "container-client-responses/v1";
const CLIENT_RESPONSE_HEADERS_MAX_BYTES: usize = 4 * 1024;
const METADATA_VERSION: &str = "1";
const CLIENT_RESPONSE_ALLOWED_HEADERS: [&str; 6] = [
    "anthropic-request-id",
    "cache-control",
    "content-type",
    "openai-request-id",
    "retry-after",
    "x-request-id",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContainerArtifactManifest {
    pub object_key: String,
    pub object_version: String,
    pub sha256: String,
    pub size: u64,
    pub content_type: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContainerInputArtifact {
    pub manifest: ContainerArtifactManifest,
    pub created: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContainerClientResponseManifest {
    pub status: u16,
    pub headers_json: String,
    pub headers_sha256: String,
    pub body: ContainerArtifactManifest,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContainerClientResponseArtifact {
    pub manifest: ContainerClientResponseManifest,
    pub created: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContainerClientResponseObjectState {
    Missing,
    Matching,
    Divergent,
}

pub async fn put_container_input(
    env: &Env,
    operation_id: &str,
    owner_generation: i64,
    content_type: &str,
    body: &[u8],
) -> worker::Result<ContainerInputArtifact> {
    validate_identifier(operation_id, "operation id")?;
    validate_content_type(content_type)?;
    if owner_generation <= 0 || owner_generation > i64::from(i32::MAX) {
        return Err(artifact_error(
            "container artifact owner generation is invalid",
        ));
    }
    if body.len() > MAX_CONTAINER_ARTIFACT_BYTES {
        return Err(artifact_error("container input artifact is too large"));
    }

    let sha256 = sha256_hex(body);
    let object_key = container_input_key(operation_id, owner_generation, &sha256)?;
    let size = body.len() as u64;
    let expected_metadata =
        input_metadata(operation_id, owner_generation, &sha256, size, content_type);
    let (object, created) = put_create_only_object(
        env,
        &object_key,
        content_type,
        &sha256,
        &expected_metadata,
        body,
    )
    .await?;
    verify_object(
        &object,
        &object_key,
        None,
        &sha256,
        size,
        content_type,
        Some("no-store"),
        Some(&expected_metadata),
    )?;
    Ok(ContainerInputArtifact {
        manifest: ContainerArtifactManifest {
            object_key,
            object_version: object.version(),
            sha256,
            size,
            content_type: content_type.to_string(),
        },
        created,
    })
}

pub fn canonical_container_client_response_headers<I, N, V>(
    headers: I,
    content_type: &str,
) -> worker::Result<(String, String)>
where
    I: IntoIterator<Item = (N, V)>,
    N: AsRef<str>,
    V: AsRef<str>,
{
    validate_content_type(content_type)?;
    let mut replayable = BTreeMap::<String, String>::new();
    for (name, value) in headers {
        let name = name.as_ref();
        if name != name.trim() || !name.is_ascii() {
            continue;
        }
        let name = name.to_ascii_lowercase();
        if CLIENT_RESPONSE_ALLOWED_HEADERS
            .binary_search(&name.as_str())
            .is_err()
            || name == "cache-control"
        {
            continue;
        }
        let value = value.as_ref();
        validate_client_response_header_value(value)?;
        if replayable.insert(name, value.to_string()).is_some() {
            return Err(artifact_error(
                "container client response header is duplicated",
            ));
        }
    }
    if replayable
        .get("content-type")
        .is_some_and(|actual| actual != content_type)
    {
        return Err(artifact_error(
            "container client response content type is inconsistent",
        ));
    }
    replayable.insert("cache-control".to_string(), "no-store".to_string());
    replayable.insert("content-type".to_string(), content_type.to_string());
    let headers_json = serde_json::to_string(&replayable).map_err(|err| {
        artifact_error(&format!(
            "container client response headers serialization failed: {err}"
        ))
    })?;
    if headers_json.len() > CLIENT_RESPONSE_HEADERS_MAX_BYTES {
        return Err(artifact_error(
            "container client response headers are too large",
        ));
    }
    let headers_sha256 = sha256_hex(headers_json.as_bytes());
    Ok((headers_json, headers_sha256))
}

pub async fn put_container_client_response(
    env: &Env,
    operation_id: &str,
    owner_generation: i64,
    status: u16,
    headers_json: &str,
    headers_sha256: &str,
    content_type: &str,
    body: &[u8],
) -> worker::Result<ContainerClientResponseArtifact> {
    validate_identifier(operation_id, "operation id")?;
    validate_client_response_status(status)?;
    validate_container_client_response_headers_json(headers_json, headers_sha256, content_type)?;
    if owner_generation <= 0 || owner_generation > i64::from(i32::MAX) {
        return Err(artifact_error(
            "container client response owner generation is invalid",
        ));
    }
    if body.len() > MAX_CONTAINER_CLIENT_RESPONSE_BYTES {
        return Err(artifact_error(
            "container client response body is too large",
        ));
    }

    let sha256 = sha256_hex(body);
    let object_key = container_client_response_key(operation_id, owner_generation, &sha256)?;
    let size = body.len() as u64;
    let expected_metadata = client_response_metadata(
        operation_id,
        owner_generation,
        status,
        headers_sha256,
        &sha256,
        size,
        content_type,
    );
    let (object, created) = put_create_only_object(
        env,
        &object_key,
        content_type,
        &sha256,
        &expected_metadata,
        body,
    )
    .await?;
    verify_object(
        &object,
        &object_key,
        None,
        &sha256,
        size,
        content_type,
        Some("no-store"),
        Some(&expected_metadata),
    )?;
    let manifest = ContainerClientResponseManifest {
        status,
        headers_json: headers_json.to_string(),
        headers_sha256: headers_sha256.to_string(),
        body: ContainerArtifactManifest {
            object_key,
            object_version: object.version(),
            sha256,
            size,
            content_type: content_type.to_string(),
        },
    };
    validate_container_client_response_manifest(operation_id, owner_generation, &manifest)?;
    Ok(ContainerClientResponseArtifact { manifest, created })
}

pub async fn inspect_container_client_response(
    env: &Env,
    operation_id: &str,
    owner_generation: i64,
    manifest: &ContainerClientResponseManifest,
) -> worker::Result<ContainerClientResponseObjectState> {
    validate_container_client_response_manifest(operation_id, owner_generation, manifest)?;
    let expected_metadata = client_response_metadata(
        operation_id,
        owner_generation,
        manifest.status,
        &manifest.headers_sha256,
        &manifest.body.sha256,
        manifest.body.size,
        &manifest.body.content_type,
    );
    let bucket = env.bucket(CONTAINER_ARTIFACT_BUCKET)?;
    let Some(object) = bucket.head(manifest.body.object_key.clone()).await? else {
        return Ok(ContainerClientResponseObjectState::Missing);
    };
    Ok(
        if verify_object(
            &object,
            &manifest.body.object_key,
            Some(&manifest.body.object_version),
            &manifest.body.sha256,
            manifest.body.size,
            &manifest.body.content_type,
            Some("no-store"),
            Some(&expected_metadata),
        )
        .is_ok()
        {
            ContainerClientResponseObjectState::Matching
        } else {
            ContainerClientResponseObjectState::Divergent
        },
    )
}

pub async fn read_verified_container_client_response(
    env: &Env,
    operation_id: &str,
    owner_generation: i64,
    manifest: &ContainerClientResponseManifest,
) -> worker::Result<Response> {
    match inspect_container_client_response(env, operation_id, owner_generation, manifest).await? {
        ContainerClientResponseObjectState::Missing => {
            return Err(artifact_error(
                "container client response object is missing",
            ));
        }
        ContainerClientResponseObjectState::Divergent => {
            return Err(artifact_error(
                "container client response object is divergent",
            ));
        }
        ContainerClientResponseObjectState::Matching => {}
    }

    let expected_metadata = client_response_metadata(
        operation_id,
        owner_generation,
        manifest.status,
        &manifest.headers_sha256,
        &manifest.body.sha256,
        manifest.body.size,
        &manifest.body.content_type,
    );
    let bucket = env.bucket(CONTAINER_ARTIFACT_BUCKET)?;
    let object = bucket
        .get(manifest.body.object_key.clone())
        .execute()
        .await?
        .ok_or_else(|| artifact_error("container client response object is missing"))?;
    verify_object(
        &object,
        &manifest.body.object_key,
        Some(&manifest.body.object_version),
        &manifest.body.sha256,
        manifest.body.size,
        &manifest.body.content_type,
        Some("no-store"),
        Some(&expected_metadata),
    )?;
    let bytes = object
        .body()
        .ok_or_else(|| artifact_error("container client response body is unavailable"))?
        .bytes()
        .await?;
    if bytes.len() as u64 != manifest.body.size || sha256_hex(&bytes) != manifest.body.sha256 {
        return Err(artifact_error("container client response body is corrupt"));
    }
    let headers = container_client_response_headers(manifest)?;
    Ok(Response::from_body(ResponseBody::Body(bytes))?
        .with_status(manifest.status)
        .with_headers(headers))
}

pub async fn read_verified_container_result(
    env: &Env,
    manifest: &ContainerArtifactManifest,
) -> worker::Result<Vec<u8>> {
    validate_container_artifact_manifest(manifest)?;
    let bucket = env.bucket(CONTAINER_ARTIFACT_BUCKET)?;
    let object = bucket
        .get(manifest.object_key.clone())
        .execute()
        .await?
        .ok_or_else(|| artifact_error("container result artifact is missing"))?;
    verify_object(
        &object,
        &manifest.object_key,
        Some(&manifest.object_version),
        &manifest.sha256,
        manifest.size,
        &manifest.content_type,
        None,
        None,
    )?;
    let bytes = object
        .body()
        .ok_or_else(|| artifact_error("container result artifact body is unavailable"))?
        .bytes()
        .await?;
    if bytes.len() as u64 != manifest.size || sha256_hex(&bytes) != manifest.sha256 {
        return Err(artifact_error("container result artifact body is corrupt"));
    }
    Ok(bytes)
}

async fn put_create_only_object(
    env: &Env,
    object_key: &str,
    content_type: &str,
    sha256: &str,
    expected_metadata: &HashMap<String, String>,
    body: &[u8],
) -> worker::Result<(R2Object, bool)> {
    let bucket = env.bucket(CONTAINER_ARTIFACT_BUCKET)?;
    let edge_bucket: worker_sys::R2Bucket = bucket.as_ref().clone().unchecked_into();
    let options = r2_create_only_options(content_type, sha256, expected_metadata)?;
    let value = Uint8Array::from(body).buffer();
    let result =
        JsFuture::from(edge_bucket.put(object_key.to_string(), value.into(), options)?).await?;
    let created = !result.is_null();
    let object = bucket
        .head(object_key.to_string())
        .await?
        .ok_or_else(|| artifact_error("container artifact was not persisted"))?;
    verify_object(
        &object,
        object_key,
        None,
        sha256,
        body.len() as u64,
        content_type,
        Some("no-store"),
        Some(expected_metadata),
    )?;
    Ok((object, created))
}

pub fn container_client_response_key(
    operation_id: &str,
    owner_generation: i64,
    sha256: &str,
) -> worker::Result<String> {
    validate_identifier(operation_id, "operation id")?;
    validate_sha256(sha256)?;
    if owner_generation <= 0 || owner_generation > i64::from(i32::MAX) {
        return Err(artifact_error(
            "container client response owner generation is invalid",
        ));
    }
    Ok(format!(
        "{CLIENT_RESPONSE_KEY_PREFIX}/{operation_id}/{owner_generation}/{sha256}"
    ))
}

pub(crate) fn validate_container_client_response_headers_json(
    headers_json: &str,
    headers_sha256: &str,
    content_type: &str,
) -> worker::Result<()> {
    validate_sha256(headers_sha256)?;
    validate_content_type(content_type)?;
    if headers_json.len() < 2 || headers_json.len() > CLIENT_RESPONSE_HEADERS_MAX_BYTES {
        return Err(artifact_error(
            "container client response headers size is invalid",
        ));
    }
    if sha256_hex(headers_json.as_bytes()) != headers_sha256 {
        return Err(artifact_error(
            "container client response header digest does not match",
        ));
    }
    let headers = parse_container_client_response_headers(headers_json)?;
    if headers.get("cache-control").map(String::as_str) != Some("no-store")
        || headers.get("content-type").map(String::as_str) != Some(content_type)
    {
        return Err(artifact_error(
            "container client response replay headers are inconsistent",
        ));
    }
    Ok(())
}

pub(crate) fn validate_container_client_response_manifest(
    operation_id: &str,
    owner_generation: i64,
    manifest: &ContainerClientResponseManifest,
) -> worker::Result<()> {
    validate_client_response_status(manifest.status)?;
    validate_container_client_response_headers_json(
        &manifest.headers_json,
        &manifest.headers_sha256,
        &manifest.body.content_type,
    )?;
    validate_container_artifact_manifest(&manifest.body)?;
    if manifest.body.size > MAX_CONTAINER_CLIENT_RESPONSE_BYTES as u64
        || manifest.body.object_key
            != container_client_response_key(operation_id, owner_generation, &manifest.body.sha256)?
    {
        return Err(artifact_error(
            "container client response manifest is invalid",
        ));
    }
    Ok(())
}

fn parse_container_client_response_headers(
    headers_json: &str,
) -> worker::Result<BTreeMap<String, String>> {
    let headers = serde_json::from_str::<BTreeMap<String, String>>(headers_json)
        .map_err(|_| artifact_error("container client response headers are invalid"))?;
    let canonical = serde_json::to_string(&headers)
        .map_err(|_| artifact_error("container client response headers are invalid"))?;
    if canonical != headers_json || headers.len() > CLIENT_RESPONSE_ALLOWED_HEADERS.len() {
        return Err(artifact_error(
            "container client response headers must use canonical JSON",
        ));
    }
    for (name, value) in &headers {
        if CLIENT_RESPONSE_ALLOWED_HEADERS
            .binary_search(&name.as_str())
            .is_err()
        {
            return Err(artifact_error(
                "container client response header is not replayable",
            ));
        }
        validate_client_response_header_value(value)?;
    }
    Ok(headers)
}

fn container_client_response_headers(
    manifest: &ContainerClientResponseManifest,
) -> worker::Result<Headers> {
    let values = parse_container_client_response_headers(&manifest.headers_json)?;
    let mut headers = Headers::new();
    for (name, value) in values {
        headers.set(&name, &value)?;
    }
    Ok(headers)
}

fn validate_client_response_status(status: u16) -> worker::Result<()> {
    if ((200..=299).contains(&status) && status != 202) || (400..=599).contains(&status) {
        Ok(())
    } else {
        Err(artifact_error(
            "container client response status is invalid",
        ))
    }
}

fn validate_client_response_header_value(value: &str) -> worker::Result<()> {
    if value.is_empty()
        || value.len() > 1_024
        || !value.is_ascii()
        || !value.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
    {
        return Err(artifact_error(
            "container client response header value is invalid",
        ));
    }
    Ok(())
}

pub fn container_input_key(
    operation_id: &str,
    owner_generation: i64,
    sha256: &str,
) -> worker::Result<String> {
    validate_identifier(operation_id, "operation id")?;
    validate_sha256(sha256)?;
    if owner_generation <= 0 || owner_generation > i64::from(i32::MAX) {
        return Err(artifact_error(
            "container artifact owner generation is invalid",
        ));
    }
    Ok(format!(
        "{INPUT_KEY_PREFIX}/{operation_id}/{owner_generation}/{sha256}"
    ))
}

pub(crate) fn validate_container_artifact_manifest(
    manifest: &ContainerArtifactManifest,
) -> worker::Result<()> {
    if manifest.object_key.len() < 8
        || manifest.object_key.len() > 512
        || !manifest.object_key.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'_' | b'.' | b':' | b'-')
        })
        || manifest.size > MAX_CONTAINER_ARTIFACT_BYTES as u64
    {
        return Err(artifact_error("container artifact manifest is invalid"));
    }
    validate_identifier(&manifest.object_version, "object version")?;
    validate_sha256(&manifest.sha256)?;
    validate_content_type(&manifest.content_type)
}

fn verify_object(
    object: &R2Object,
    expected_key: &str,
    expected_version: Option<&str>,
    expected_sha256: &str,
    expected_size: u64,
    expected_content_type: &str,
    expected_cache_control: Option<&str>,
    expected_metadata: Option<&HashMap<String, String>>,
) -> worker::Result<()> {
    let checksum = object.checksum().sha256.map(|bytes| {
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    });
    let metadata_matches = match expected_metadata {
        None => true,
        Some(expected) => object
            .custom_metadata()
            .is_ok_and(|actual| actual == *expected),
    };
    let http_metadata = object.http_metadata();
    if object.key() != expected_key
        || expected_version.is_some_and(|version| object.version() != version)
        || object.size() != expected_size
        || http_metadata.content_type.as_deref() != Some(expected_content_type)
        || expected_cache_control
            .is_some_and(|value| http_metadata.cache_control.as_deref() != Some(value))
        || checksum.as_deref() != Some(expected_sha256)
        || !metadata_matches
    {
        return Err(artifact_error("container artifact integrity mismatch"));
    }
    let version = object.version();
    validate_identifier(&version, "object version")?;
    Ok(())
}

fn r2_create_only_options(
    content_type: &str,
    sha256: &str,
    custom_metadata: &HashMap<String, String>,
) -> worker::Result<JsValue> {
    let options = JsObject::new();
    let only_if = JsObject::new();
    set_js(&only_if, "etagDoesNotMatch", &JsValue::from_str("*"))?;
    set_js(&options, "onlyIf", &only_if.into())?;

    let http_metadata = JsObject::new();
    set_js(
        &http_metadata,
        "contentType",
        &JsValue::from_str(content_type),
    )?;
    set_js(
        &http_metadata,
        "cacheControl",
        &JsValue::from_str("no-store"),
    )?;
    set_js(&options, "httpMetadata", &http_metadata.into())?;

    let metadata = JsObject::new();
    for (name, value) in custom_metadata {
        set_js(&metadata, name, &JsValue::from_str(value))?;
    }
    set_js(&options, "customMetadata", &metadata.into())?;
    set_js(&options, "sha256", &JsValue::from_str(sha256))?;
    Ok(options.into())
}

fn set_js(target: &JsObject, name: &str, value: &JsValue) -> worker::Result<()> {
    Reflect::set(target, &JsValue::from_str(name), value)
        .map(|_| ())
        .map_err(worker::Error::from)
}

fn input_metadata(
    operation_id: &str,
    owner_generation: i64,
    sha256: &str,
    size: u64,
    content_type: &str,
) -> HashMap<String, String> {
    HashMap::from([
        ("gateway_version".to_string(), METADATA_VERSION.to_string()),
        ("operation_id".to_string(), operation_id.to_string()),
        ("owner_generation".to_string(), owner_generation.to_string()),
        ("sha256".to_string(), sha256.to_string()),
        ("size".to_string(), size.to_string()),
        ("content_type".to_string(), content_type.to_string()),
    ])
}

fn client_response_metadata(
    operation_id: &str,
    owner_generation: i64,
    status: u16,
    headers_sha256: &str,
    sha256: &str,
    size: u64,
    content_type: &str,
) -> HashMap<String, String> {
    HashMap::from([
        ("gateway_version".to_string(), METADATA_VERSION.to_string()),
        ("artifact_kind".to_string(), "client_response".to_string()),
        ("operation_id".to_string(), operation_id.to_string()),
        ("owner_generation".to_string(), owner_generation.to_string()),
        ("response_status".to_string(), status.to_string()),
        ("headers_sha256".to_string(), headers_sha256.to_string()),
        ("sha256".to_string(), sha256.to_string()),
        ("size".to_string(), size.to_string()),
        ("content_type".to_string(), content_type.to_string()),
    ])
}

fn validate_identifier(value: &str, field: &str) -> worker::Result<()> {
    if value != value.trim()
        || value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        return Err(artifact_error(&format!(
            "container artifact {field} is invalid"
        )));
    }
    Ok(())
}

fn validate_sha256(value: &str) -> worker::Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(artifact_error("container artifact sha256 is invalid"));
    }
    Ok(())
}

fn validate_content_type(value: &str) -> worker::Result<()> {
    let token_byte = |byte: u8| {
        byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'!' | b'#' | b'$' | b'&' | b'^' | b'_' | b'.' | b'+' | b'-'
            )
    };
    let (media_type, parameters) = value
        .split_once(';')
        .map_or((value, None), |(media_type, parameters)| {
            (media_type, Some(parameters))
        });
    if value != value.trim()
        || !(3..=128).contains(&value.len())
        || !value.is_ascii()
        || !media_type.split_once('/').is_some_and(|(kind, subtype)| {
            !kind.is_empty()
                && !subtype.is_empty()
                && kind.bytes().all(token_byte)
                && subtype.bytes().all(token_byte)
        })
        || parameters.is_some_and(|parameters| {
            parameters.is_empty() || !parameters.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
        })
    {
        return Err(artifact_error("container artifact content type is invalid"));
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn artifact_error(message: &str) -> worker::Error {
    worker::Error::RustError(message.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn input_keys_are_deterministic_content_addressed_and_bounded() {
        let sha256 = sha256_hex(br#"{"model":"gpt-test"}"#);
        let first = container_input_key("relayreserve-test", 2, &sha256).unwrap();
        let second = container_input_key("relayreserve-test", 2, &sha256).unwrap();
        assert_eq!(first, second);
        assert_eq!(
            first,
            format!("container-inputs/v1/relayreserve-test/2/{sha256}")
        );
        assert!(container_input_key("../escape", 2, &sha256).is_err());
        assert!(container_input_key("relayreserve-test", 0, &sha256).is_err());
    }

    #[test]
    fn result_manifests_reject_untrusted_shape_before_r2_io() {
        let valid = ContainerArtifactManifest {
            object_key: "container-results/v1/relayreserve-test/2/result".to_string(),
            object_version: "version-1".to_string(),
            sha256: "a".repeat(64),
            size: 128,
            content_type: "application/json".to_string(),
        };
        validate_container_artifact_manifest(&valid).unwrap();

        let mut invalid = valid.clone();
        invalid.object_key = "bad?key".to_string();
        assert!(validate_container_artifact_manifest(&invalid).is_err());
        invalid = valid.clone();
        invalid.object_version = " version-1".to_string();
        assert!(validate_container_artifact_manifest(&invalid).is_err());
        invalid = valid.clone();
        invalid.content_type = "a/ b".to_string();
        assert!(validate_container_artifact_manifest(&invalid).is_err());
        invalid = valid;
        invalid.size = MAX_CONTAINER_ARTIFACT_BYTES as u64 + 1;
        assert!(validate_container_artifact_manifest(&invalid).is_err());
    }

    #[test]
    fn client_response_headers_are_canonical_allowlisted_and_no_store() {
        let (headers_json, headers_sha256) = canonical_container_client_response_headers(
            [
                ("Content-Type", "application/json"),
                ("X-Request-Id", "request-001"),
                ("Set-Cookie", "secret=1"),
                ("Cache-Control", "public, max-age=3600"),
            ],
            "application/json",
        )
        .unwrap();
        assert_eq!(
            headers_json,
            r#"{"cache-control":"no-store","content-type":"application/json","x-request-id":"request-001"}"#
        );
        validate_container_client_response_headers_json(
            &headers_json,
            &headers_sha256,
            "application/json",
        )
        .unwrap();
        assert!(canonical_container_client_response_headers(
            [
                ("content-type", "application/json"),
                ("x-request-id", "request-001"),
                ("X-Request-Id", "request-002"),
            ],
            "application/json",
        )
        .is_err());
        assert!(canonical_container_client_response_headers(
            [
                ("content-type", "application/json"),
                ("x-request-id", "line\nbreak"),
            ],
            "application/json",
        )
        .is_err());
    }

    #[test]
    fn client_response_manifest_is_exact_and_uses_the_relay_bound() {
        let body_sha256 = sha256_hex(br#"{"id":"response-001"}"#);
        let (headers_json, headers_sha256) = canonical_container_client_response_headers(
            [("content-type", "application/json")],
            "application/json",
        )
        .unwrap();
        let mut manifest = ContainerClientResponseManifest {
            status: 200,
            headers_json,
            headers_sha256,
            body: ContainerArtifactManifest {
                object_key: container_client_response_key("relayreserve-test", 2, &body_sha256)
                    .unwrap(),
                object_version: "version-1".to_string(),
                sha256: body_sha256,
                size: MAX_CONTAINER_CLIENT_RESPONSE_BYTES as u64,
                content_type: "application/json".to_string(),
            },
        };
        validate_container_client_response_manifest("relayreserve-test", 2, &manifest).unwrap();

        manifest.body.size = MAX_CONTAINER_CLIENT_RESPONSE_BYTES as u64 + 1;
        assert!(
            validate_container_client_response_manifest("relayreserve-test", 2, &manifest).is_err()
        );
        manifest.body.size = 1;
        manifest.status = 202;
        assert!(
            validate_container_client_response_manifest("relayreserve-test", 2, &manifest).is_err()
        );
        manifest.status = 200;
        manifest.body.object_key = manifest.body.object_key.replace("/2/", "/3/");
        assert!(
            validate_container_client_response_manifest("relayreserve-test", 2, &manifest).is_err()
        );
    }
}
