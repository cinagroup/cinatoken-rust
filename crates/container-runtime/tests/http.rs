use std::time::{SystemTime, UNIX_EPOCH};

use axum::{
    body::{to_bytes, Body},
    http::{header::CONTENT_TYPE, Request, StatusCode},
};
use cinatoken_container_runtime::{app, CONTAINER_PROTOCOL_HEADER, MAX_REQUEST_BODY_BYTES};
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

async fn send(body: String, content_type: Option<&str>) -> (StatusCode, Value) {
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
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&body).unwrap())
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
}

#[tokio::test]
async fn health_and_readiness_endpoints_are_live() {
    let health = app()
        .oneshot(Request::get("/healthz").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(health.status(), StatusCode::OK);
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
    let body = to_bytes(readiness.into_body(), usize::MAX).await.unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap(),
        json!({
            "status": "ready",
            "protocol_version": 1,
            "shard_contract_version": 1,
            "execution_enabled": false,
        })
    );
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
async fn request_body_is_limited_to_64_kib() {
    let oversized = "x".repeat(MAX_REQUEST_BODY_BYTES + 1);
    let (status, body) = send(oversized, Some("application/json")).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(body["code"], "request_body_too_large");
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
