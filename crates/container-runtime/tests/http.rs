use std::time::{SystemTime, UNIX_EPOCH};

use axum::{
    body::{to_bytes, Body},
    http::{header::CONTENT_TYPE, HeaderMap, Request, StatusCode},
};
use cinatoken_container_runtime::{
    app, protobuf::wire, CONTAINER_PROTOCOL_HEADER, MAX_REQUEST_BODY_BYTES, PROTOBUF_CONTENT_TYPE,
};
use prost::Message;
use serde_json::{json, Value};
use tower::ServiceExt;

fn valid_operation(kind: &str) -> Value {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    json!({
        "protocol_version": 1,
        "operation_id": "operation-123",
        "operation_kind": kind,
        "owner_generation": 1,
        "owner_lease_expires_at": now + 120,
        "execution_deadline_at": now + 60,
        "provider_operation_id": "provider-operation-123",
        "admission_sha256": "a".repeat(64),
        "input": {
            "mode": "inline",
            "sha256": "b".repeat(64),
            "size": 0,
            "content_type": "application/json"
        },
        "shard": {
            "contract_version": 1,
            "ring_generation": 1,
            "shard_count": 8,
            "shard_index": 3,
            "instance_name": "cinatoken-relay-shard-v1-0003"
        },
        "trace_id": "trace-123"
    })
}

fn valid_protobuf_operation(kind: &str) -> wire::OperationEnvelope {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    wire::OperationEnvelope {
        protocol_version: 1,
        operation_id: "operation-123".to_string(),
        operation_kind: kind.to_string(),
        owner_generation: 1,
        owner_lease_expires_at: now + 120,
        execution_deadline_at: now + 60,
        provider_operation_id: "provider-operation-123".to_string(),
        admission_sha256: "a".repeat(64),
        input: Some(wire::OperationInput {
            mode: wire::OperationInputMode::Inline as i32,
            sha256: "b".repeat(64),
            size: 0,
            content_type: "application/json".to_string(),
            request_object_key: None,
            object_version: None,
        }),
        shard: Some(wire::OperationShard {
            contract_version: 1,
            ring_generation: 1,
            shard_count: 8,
            shard_index: 3,
            instance_name: "cinatoken-relay-shard-v1-0003".to_string(),
        }),
        trace_id: "trace-123".to_string(),
    }
}

async fn send_raw(body: Vec<u8>, content_type: Option<&str>) -> (StatusCode, HeaderMap, Vec<u8>) {
    let mut builder = Request::builder().method("POST").uri("/v1/operations");
    builder = builder.header(CONTAINER_PROTOCOL_HEADER, "1");
    if let Some(content_type) = content_type {
        builder = builder.header(CONTENT_TYPE, content_type);
    }
    let response = app()
        .oneshot(builder.body(Body::from(body)).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, headers, body.to_vec())
}

async fn send(body: String, content_type: Option<&str>) -> (StatusCode, Value) {
    let (status, _, body) = send_raw(body.into_bytes(), content_type).await;
    (status, serde_json::from_slice(&body).unwrap())
}

fn assert_protobuf_content_type(headers: &HeaderMap) {
    assert_eq!(headers.get(CONTENT_TYPE).unwrap(), PROTOBUF_CONTENT_TYPE);
}

#[tokio::test]
async fn operation_endpoint_requires_the_controller_protocol_header() {
    let response = app()
        .oneshot(
            Request::post("/v1/operations")
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(valid_operation("health_probe").to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UPGRADE_REQUIRED);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap()["code"],
        "invalid_container_protocol"
    );

    let response = app()
        .oneshot(
            Request::post("/v1/operations")
                .header(CONTENT_TYPE, PROTOBUF_CONTENT_TYPE)
                .body(Body::from(
                    valid_protobuf_operation("health_probe").encode_to_vec(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UPGRADE_REQUIRED);
    assert_eq!(response.headers()[CONTENT_TYPE], PROTOBUF_CONTENT_TYPE);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let error = wire::ErrorResponse::decode(body).unwrap();
    assert_eq!(error.code, "invalid_container_protocol");
}

#[tokio::test]
async fn health_and_readiness_endpoints_are_live() {
    let health = app()
        .oneshot(Request::get("/healthz").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(health.status(), StatusCode::OK);
    assert_eq!(health.headers()[CONTENT_TYPE], "application/json");
    let body = to_bytes(health.into_body(), usize::MAX).await.unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap(),
        json!({ "status": "ok" })
    );

    let readiness = app()
        .oneshot(Request::get("/readyz").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(readiness.status(), StatusCode::OK);
    assert_eq!(readiness.headers()[CONTENT_TYPE], "application/json");
    let body = to_bytes(readiness.into_body(), usize::MAX).await.unwrap();
    let readiness = serde_json::from_slice::<Value>(&body).unwrap();
    assert_eq!(readiness["status"], "ready");
    assert_eq!(readiness["protocol_version"], 1);
    assert_eq!(readiness["shard_contract_version"], 1);
    assert_eq!(readiness["execution_enabled"], false);
    let runtime_build_id = readiness["runtime_build_id"].as_str().unwrap();
    assert_eq!(runtime_build_id.len(), 64);
    assert!(runtime_build_id
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
}

#[tokio::test]
async fn health_probe_is_completed_without_enabling_execution() {
    let (status, body) = send(
        valid_operation("health_probe").to_string(),
        Some("application/json"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        json!({
            "protocol_version": 1,
            "operation_id": "operation-123",
            "status": "completed",
            "trace_id": "trace-123"
        })
    );
}

#[tokio::test]
async fn protobuf_health_probe_returns_a_protobuf_outcome() {
    let (status, headers, body) = send_raw(
        valid_protobuf_operation("health_probe").encode_to_vec(),
        Some(PROTOBUF_CONTENT_TYPE),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_protobuf_content_type(&headers);

    let response = wire::OperationResponse::decode(body.as_slice()).unwrap();
    assert_eq!(response.protocol_version, 1);
    assert_eq!(response.operation_id, "operation-123");
    assert_eq!(
        response.status,
        wire::OperationOutcomeStatus::Completed as i32
    );
    assert_eq!(response.code, None);
    assert_eq!(response.result, None);
    assert_eq!(response.classification, None);
    assert_eq!(response.provider_status, None);
    assert_eq!(response.client_status, None);
    assert_eq!(response.client_artifact, None);
    assert_eq!(response.trace_id, "trace-123");
}

#[tokio::test]
async fn protobuf_invalid_bytes_return_a_protobuf_422_error() {
    let (status, headers, body) = send_raw(vec![0x80], Some(PROTOBUF_CONTENT_TYPE)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_protobuf_content_type(&headers);

    let error = wire::ErrorResponse::decode(body.as_slice()).unwrap();
    assert_eq!(error.code, "invalid_operation_envelope");
    assert_eq!(
        error.message,
        "request body must match the operation envelope"
    );
}

#[tokio::test]
async fn protobuf_known_errors_and_rejected_outcomes_keep_protobuf_content_type() {
    let (status, headers, body) = send_raw(
        valid_protobuf_operation("chat_completion").encode_to_vec(),
        Some(PROTOBUF_CONTENT_TYPE),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
    assert_protobuf_content_type(&headers);
    let outcome = wire::OperationResponse::decode(body.as_slice()).unwrap();
    assert_eq!(
        outcome.status,
        wire::OperationOutcomeStatus::Rejected as i32
    );
    assert_eq!(outcome.code.as_deref(), Some("execution_not_enabled"));

    let mut invalid = valid_protobuf_operation("health_probe");
    invalid.owner_generation = 9_007_199_254_740_992;
    let (status, headers, body) =
        send_raw(invalid.encode_to_vec(), Some(PROTOBUF_CONTENT_TYPE)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_protobuf_content_type(&headers);
    let error = wire::ErrorResponse::decode(body.as_slice()).unwrap();
    assert_eq!(error.code, "invalid_owner_generation");
}

#[tokio::test]
async fn protobuf_non_canonical_envelopes_are_rejected() {
    let canonical = valid_protobuf_operation("health_probe").encode_to_vec();
    assert_eq!(&canonical[..2], &[0x08, 0x01]);

    let mut unknown_field = canonical.clone();
    unknown_field.extend_from_slice(&[0x78, 0x01]);

    let mut duplicate_field = canonical.clone();
    duplicate_field.extend_from_slice(&[0x08, 0x01]);

    let mut non_canonical_varint = Vec::with_capacity(canonical.len() + 1);
    non_canonical_varint.extend_from_slice(&[0x08, 0x81, 0x00]);
    non_canonical_varint.extend_from_slice(&canonical[2..]);

    let mut out_of_order = canonical[2..].to_vec();
    out_of_order.extend_from_slice(&canonical[..2]);

    for body in [
        unknown_field,
        duplicate_field,
        non_canonical_varint,
        out_of_order,
    ] {
        let (status, headers, body) = send_raw(body, Some(PROTOBUF_CONTENT_TYPE)).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_protobuf_content_type(&headers);
        let error = wire::ErrorResponse::decode(body.as_slice()).unwrap();
        assert_eq!(error.code, "invalid_operation_envelope");
    }
}

#[tokio::test]
async fn protobuf_requires_message_presence_and_known_nonzero_enums() {
    let mut missing_input = valid_protobuf_operation("health_probe");
    missing_input.input = None;

    let mut unspecified_mode = valid_protobuf_operation("health_probe");
    unspecified_mode.input.as_mut().unwrap().mode = wire::OperationInputMode::Unspecified as i32;

    let mut unknown_mode = valid_protobuf_operation("health_probe");
    unknown_mode.input.as_mut().unwrap().mode = 99;

    for envelope in [missing_input, unspecified_mode, unknown_mode] {
        let (status, headers, body) =
            send_raw(envelope.encode_to_vec(), Some(PROTOBUF_CONTENT_TYPE)).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_protobuf_content_type(&headers);
        let error = wire::ErrorResponse::decode(body.as_slice()).unwrap();
        assert_eq!(error.code, "invalid_operation_envelope");
    }
}

#[tokio::test]
async fn json_health_probe_response_bytes_remain_unchanged() {
    let (status, headers, body) = send_raw(
        valid_operation("health_probe").to_string().into_bytes(),
        Some("application/json"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[CONTENT_TYPE], "application/json");
    assert_eq!(
        body,
        br#"{"protocol_version":1,"operation_id":"operation-123","status":"completed","trace_id":"trace-123"}"#
    );
}

#[tokio::test]
async fn other_valid_operations_fail_closed_with_a_stable_code() {
    let (status, body) = send(
        valid_operation("chat_completion").to_string(),
        Some("application/json"),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
    assert_eq!(
        body,
        json!({
            "protocol_version": 1,
            "operation_id": "operation-123",
            "status": "rejected",
            "code": "execution_not_enabled",
            "trace_id": "trace-123"
        })
    );
}

#[tokio::test]
async fn content_type_and_strict_envelope_are_enforced() {
    let (status, body) = send(valid_operation("health_probe").to_string(), None).await;
    assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert_eq!(body["code"], "unsupported_media_type");

    let mut operation = valid_operation("health_probe");
    operation["unknown"] = json!(true);
    let (status, body) = send(
        operation.to_string(),
        Some("application/json; charset=utf-8"),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["code"], "invalid_operation_envelope");
}

#[tokio::test]
async fn protobuf_content_type_is_exact_and_unknown_media_returns_json_415() {
    let (status, headers, body) = send_raw(
        valid_protobuf_operation("health_probe").encode_to_vec(),
        Some("application/x-protobuf; charset=binary"),
    )
    .await;
    assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert_eq!(headers[CONTENT_TYPE], "application/json");
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap(),
        json!({
            "code": "unsupported_media_type",
            "message": "content-type must be application/json or application/x-protobuf"
        })
    );
}

#[tokio::test]
async fn request_body_is_limited_to_64_kib() {
    let oversized = "x".repeat(MAX_REQUEST_BODY_BYTES + 1);
    let (status, body) = send(oversized, Some("application/json")).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(body["code"], "request_body_too_large");

    let (status, headers, body) = send_raw(
        vec![0; MAX_REQUEST_BODY_BYTES + 1],
        Some(PROTOBUF_CONTENT_TYPE),
    )
    .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_protobuf_content_type(&headers);
    let error = wire::ErrorResponse::decode(body.as_slice()).unwrap();
    assert_eq!(error.code, "request_body_too_large");
}

#[tokio::test]
async fn invalid_deadlines_are_rejected_before_dispatch() {
    let mut operation = valid_operation("health_probe");
    operation["execution_deadline_at"] = operation["owner_lease_expires_at"].clone();
    operation["owner_lease_expires_at"] = json!(1);
    let (status, body) = send(operation.to_string(), Some("application/json")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["code"], "invalid_execution_deadline");
}
