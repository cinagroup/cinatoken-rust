use std::time::{SystemTime, UNIX_EPOCH};

use axum::{
    body::{to_bytes, Body},
    http::{header::CONTENT_TYPE, Request, StatusCode},
};
use cinatoken_container_runtime::{app, MAX_REQUEST_BODY_BYTES};
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
async fn health_and_readiness_endpoints_are_live() {
    for (path, expected) in [("/healthz", "ok"), ("/readyz", "ready")] {
        let response = app()
            .oneshot(Request::get(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap()["status"],
            expected
        );
    }
}

#[tokio::test]
async fn health_probe_is_accepted_without_execution() {
    let (status, body) = send(
        valid_operation("health_probe").to_string(),
        Some("application/json"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "accepted");
    assert_eq!(body["operation_id"], "operation-123");
    assert!(body.get("code").is_none());
}

#[tokio::test]
async fn other_valid_operations_fail_closed_with_a_stable_code() {
    let (status, body) = send(
        valid_operation("chat_completion").to_string(),
        Some("application/json"),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
    assert_eq!(body["status"], "rejected");
    assert_eq!(body["code"], "execution_not_enabled");
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
