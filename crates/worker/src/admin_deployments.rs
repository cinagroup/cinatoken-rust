//! Admin model-deployment routes (Go `controller/deployment.go`).
//!
//! The Rust Worker keeps the same frontend envelope and io.net option keys as
//! the Go gateway, while forcing every external call through bounded response
//! reads and explicit timeouts.

use std::collections::HashMap;
use std::time::Duration;

use futures_util::future::{select, Either};
use futures_util::TryStreamExt;
use serde_json::{Map, Value};
use url::form_urlencoded;
use worker::{
    AbortController, Delay, Env, Fetch, Headers, Method, Request, RequestInit, RequestRedirect,
    Response, Result as WorkerResult,
};

use crate::admin::{
    envelope_error_response, envelope_ok_response, read_json_body, require_admin_auth,
};
use crate::d1_repositories;

const IONET_ENABLED_KEY: &str = "model_deployment.ionet.enabled";
const IONET_API_KEY_KEY: &str = "model_deployment.ionet.api_key";
const DEFAULT_ENTERPRISE_BASE_URL: &str = "https://api.io.solutions/enterprise/v1/io-cloud/caas";
const DEFAULT_PUBLIC_BASE_URL: &str = "https://api.io.solutions/v1/io-cloud/caas";
const DEFAULT_TIMEOUT_SECONDS: u64 = 30;
const MAX_TIMEOUT_SECONDS: u64 = 30;
const IONET_RESPONSE_LIMIT_BYTES: usize = 1024 * 1024;
const DEPLOYMENT_PAGE_SIZE_DEFAULT: u32 = 10;
const DEPLOYMENT_PAGE_SIZE_MAX: u32 = 100;

pub async fn get_settings(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let db = env.d1("DB")?;
    let config = read_config(&db).await?;
    envelope_ok_response(&serde_json::json!({
        "provider": "io.net",
        "enabled": config.enabled,
        "configured": config.api_key.is_some(),
        "can_connect": config.enabled && config.api_key.is_some(),
    }))
}

pub async fn test_connection(mut req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let db = env.d1("DB")?;
    let api_key = match optional_api_key_from_body(&mut req).await {
        Ok(Some(value)) => value,
        Ok(None) => {
            let config = read_config(&db).await?;
            match config.api_key {
                Some(value) => value,
                None => return Ok(envelope_error_response(400, "api_key is required")),
            }
        }
        Err(response) => return Ok(response),
    };

    let client = IoNetClient::enterprise(api_key, deployment_timeout(&env));
    let value = match client
        .request_json(Method::Get, "/hardware/max-gpus-per-container", None)
        .await
    {
        Ok(value) => value,
        Err(err) => return Ok(envelope_error_response(err.status, &err.message)),
    };
    let data = unwrap_data(value);
    let hardware = data
        .get("hardware")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut total_available = data.get("total").and_then(value_as_i64).unwrap_or(0);
    if total_available == 0 {
        total_available = hardware
            .iter()
            .map(|item| item.get("available").and_then(value_as_i64).unwrap_or(0))
            .sum();
    }
    envelope_ok_response(&serde_json::json!({
        "hardware_count": hardware.len(),
        "total_available": total_available,
    }))
}

pub async fn list(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let client = match enabled_enterprise_client(&env).await? {
        Ok(client) => client,
        Err(response) => return Ok(response),
    };
    let page = parse_query_u32(&req, "p").unwrap_or(1).max(1);
    let page_size = parse_query_u32(&req, "page_size")
        .unwrap_or(DEPLOYMENT_PAGE_SIZE_DEFAULT)
        .clamp(1, DEPLOYMENT_PAGE_SIZE_MAX);
    let mut params = QueryBuilder::default();
    params.push_nonempty("status", parse_query_string(&req, "status"));
    params.push_u32("page", page);
    params.push_u32("page_size", page_size);
    params.push("sort_by", "created_at");
    params.push("sort_order", "desc");

    let value = match client
        .request_json(
            Method::Get,
            &format!("/deployments{}", params.finish()),
            None,
        )
        .await
    {
        Ok(value) => value,
        Err(err) => return Ok(envelope_error_response(err.status, &err.message)),
    };
    let data = deployment_list_data(unwrap_data(value), page, page_size, true);
    envelope_ok_response(&data)
}

pub async fn search(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let client = match enabled_enterprise_client(&env).await? {
        Ok(client) => client,
        Err(response) => return Ok(response),
    };
    let page = parse_query_u32(&req, "p").unwrap_or(1).max(1);
    let page_size = parse_query_u32(&req, "page_size")
        .unwrap_or(DEPLOYMENT_PAGE_SIZE_DEFAULT)
        .clamp(1, DEPLOYMENT_PAGE_SIZE_MAX);
    let keyword = parse_query_string(&req, "keyword").unwrap_or_default();
    let mut params = QueryBuilder::default();
    params.push_nonempty("status", parse_query_string(&req, "status"));
    params.push_u32("page", page);
    params.push_u32("page_size", page_size);
    params.push("sort_by", "created_at");
    params.push("sort_order", "desc");

    let value = match client
        .request_json(
            Method::Get,
            &format!("/deployments{}", params.finish()),
            None,
        )
        .await
    {
        Ok(value) => value,
        Err(err) => return Ok(envelope_error_response(err.status, &err.message)),
    };
    let mut data = deployment_list_data(unwrap_data(value), page, page_size, false);
    if !keyword.trim().is_empty() {
        filter_deployments_by_keyword(&mut data, keyword.trim());
    }
    envelope_ok_response(&data)
}

pub async fn get(req: Request, env: Env, id_param: Option<&String>) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let Some(id) = nonempty_param(id_param, "deployment ID is required") else {
        return Ok(envelope_error_response(400, "deployment ID is required"));
    };
    let client = match enabled_enterprise_client(&env).await? {
        Ok(client) => client,
        Err(response) => return Ok(response),
    };
    let value = match client
        .request_json(
            Method::Get,
            &format!("/deployment/{}", encode_path_segment(&id)),
            None,
        )
        .await
    {
        Ok(value) => value,
        Err(err) => return Ok(envelope_error_response(err.status, &err.message)),
    };
    envelope_ok_response(&map_deployment_detail(unwrap_data(value)))
}

pub async fn list_containers(
    req: Request,
    env: Env,
    id_param: Option<&String>,
) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let Some(id) = nonempty_param(id_param, "deployment ID is required") else {
        return Ok(envelope_error_response(400, "deployment ID is required"));
    };
    let client = match enabled_enterprise_client(&env).await? {
        Ok(client) => client,
        Err(response) => return Ok(response),
    };
    let value = match client
        .request_json(
            Method::Get,
            &format!("/deployment/{}/containers", encode_path_segment(&id)),
            None,
        )
        .await
    {
        Ok(value) => value,
        Err(err) => return Ok(envelope_error_response(err.status, &err.message)),
    };
    let data = unwrap_data(value);
    let workers = data
        .get("workers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(map_container)
        .collect::<Vec<_>>();
    envelope_ok_response(&serde_json::json!({
        "total": data.get("total").and_then(value_as_i64).unwrap_or(workers.len() as i64),
        "containers": workers,
    }))
}

pub async fn get_container(
    req: Request,
    env: Env,
    id_param: Option<&String>,
    container_param: Option<&String>,
) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let Some(id) = nonempty_param(id_param, "deployment ID is required") else {
        return Ok(envelope_error_response(400, "deployment ID is required"));
    };
    let Some(container_id) = nonempty_param(container_param, "container ID is required") else {
        return Ok(envelope_error_response(400, "container ID is required"));
    };
    let client = match enabled_enterprise_client(&env).await? {
        Ok(client) => client,
        Err(response) => return Ok(response),
    };
    let value = match client
        .request_json(
            Method::Get,
            &format!(
                "/deployment/{}/container/{}",
                encode_path_segment(&id),
                encode_path_segment(&container_id)
            ),
            None,
        )
        .await
    {
        Ok(value) => value,
        Err(err) => return Ok(envelope_error_response(err.status, &err.message)),
    };
    let mut data = map_container(unwrap_data(value));
    data["deployment_id"] = Value::String(id);
    envelope_ok_response(&data)
}

pub async fn get_logs(req: Request, env: Env, id_param: Option<&String>) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let Some(id) = nonempty_param(id_param, "deployment ID is required") else {
        return Ok(envelope_error_response(400, "deployment ID is required"));
    };
    let Some(container_id) = parse_query_string(&req, "container_id").filter(|v| !v.is_empty())
    else {
        return Ok(envelope_error_response(
            400,
            "container_id parameter is required",
        ));
    };
    let client = match enabled_public_client(&env).await? {
        Ok(client) => client,
        Err(response) => return Ok(response),
    };
    let mut params = QueryBuilder::default();
    params.push_nonempty("level", parse_query_string(&req, "level"));
    params.push_nonempty("stream", parse_query_string(&req, "stream"));
    params.push_nonempty("cursor", parse_query_string(&req, "cursor"));
    params.push_nonempty("start_time", parse_query_string(&req, "start_time"));
    params.push_nonempty("end_time", parse_query_string(&req, "end_time"));
    params.push("limit", &bounded_log_limit(&req).to_string());
    if parse_query_string(&req, "follow").as_deref() == Some("true") {
        params.push("follow", "true");
    }
    let text = match client
        .request_text(
            Method::Get,
            &format!(
                "/deployment/{}/log/{}{}",
                encode_path_segment(&id),
                encode_path_segment(&container_id),
                params.finish()
            ),
            None,
        )
        .await
    {
        Ok(text) => text,
        Err(err) => return Ok(envelope_error_response(err.status, &err.message)),
    };
    envelope_ok_response(&text)
}

pub async fn hardware_types(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let client = match enabled_enterprise_client(&env).await? {
        Ok(client) => client,
        Err(response) => return Ok(response),
    };
    let value = match client
        .request_json(Method::Get, "/hardware/max-gpus-per-container", None)
        .await
    {
        Ok(value) => value,
        Err(err) => return Ok(envelope_error_response(err.status, &err.message)),
    };
    let data = unwrap_data(value);
    let hardware = data
        .get("hardware")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let hardware_types = hardware
        .iter()
        .map(map_hardware_type)
        .collect::<Vec<Value>>();
    let total_available = data
        .get("total")
        .and_then(value_as_i64)
        .filter(|value| *value > 0)
        .unwrap_or_else(|| {
            hardware
                .iter()
                .map(|item| item.get("available").and_then(value_as_i64).unwrap_or(0))
                .sum()
        });
    envelope_ok_response(&serde_json::json!({
        "hardware_types": hardware_types,
        "total": hardware_types.len(),
        "total_available": total_available,
    }))
}

pub async fn locations(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let client = match enabled_public_client(&env).await? {
        Ok(client) => client,
        Err(response) => return Ok(response),
    };
    let value = match client.request_json(Method::Get, "/locations", None).await {
        Ok(value) => value,
        Err(err) => return Ok(envelope_error_response(err.status, &err.message)),
    };
    let data = unwrap_data(value);
    let locations = data
        .get("locations")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(map_location)
        .collect::<Vec<_>>();
    let total = data
        .get("total")
        .and_then(value_as_i64)
        .filter(|value| *value > 0)
        .unwrap_or_else(|| {
            locations
                .iter()
                .map(|item| item.get("available").and_then(value_as_i64).unwrap_or(0))
                .sum()
        });
    envelope_ok_response(&serde_json::json!({
        "locations": locations,
        "total": total,
    }))
}

pub async fn available_replicas(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let Some(hardware_id) = parse_query_i64(&req, "hardware_id").filter(|value| *value > 0) else {
        return Ok(envelope_error_response(
            400,
            "invalid hardware_id parameter",
        ));
    };
    let gpu_count = parse_query_i64(&req, "gpu_count")
        .filter(|value| *value > 0)
        .unwrap_or(1);
    let client = match enabled_enterprise_client(&env).await? {
        Ok(client) => client,
        Err(response) => return Ok(response),
    };
    let mut params = QueryBuilder::default();
    params.push("hardware_id", &hardware_id.to_string());
    params.push("hardware_qty", &gpu_count.to_string());
    let value = match client
        .request_json(
            Method::Get,
            &format!("/available-replicas{}", params.finish()),
            None,
        )
        .await
    {
        Ok(value) => value,
        Err(err) => return Ok(envelope_error_response(err.status, &err.message)),
    };
    let data = unwrap_data(value);
    let replicas = data
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|item| map_available_replica(item, hardware_id, gpu_count))
        .collect::<Vec<_>>();
    envelope_ok_response(&serde_json::json!({ "replicas": replicas }))
}

pub async fn price_estimation(mut req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let params = match price_query(&body) {
        Ok(params) => params,
        Err(message) => return Ok(envelope_error_response(400, &message)),
    };
    let client = match enabled_enterprise_client(&env).await? {
        Ok(client) => client,
        Err(response) => return Ok(response),
    };
    let value = match client
        .request_json(Method::Get, &format!("/price{}", params), None)
        .await
    {
        Ok(value) => value,
        Err(err) => return Ok(envelope_error_response(err.status, &err.message)),
    };
    let pricing = unwrap_data(value);
    envelope_ok_response(&map_price_estimation(&pricing, &body))
}

pub async fn check_name(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let Some(name) = parse_query_string(&req, "name").filter(|value| !value.is_empty()) else {
        return Ok(envelope_error_response(400, "name parameter is required"));
    };
    let client = match enabled_enterprise_client(&env).await? {
        Ok(client) => client,
        Err(response) => return Ok(response),
    };
    let mut params = QueryBuilder::default();
    params.push("cluster_name", &name);
    let value = match client
        .request_json(
            Method::Get,
            &format!(
                "/clusters/check_cluster_name_availability{}",
                params.finish()
            ),
            None,
        )
        .await
    {
        Ok(value) => value,
        Err(err) => return Ok(envelope_error_response(err.status, &err.message)),
    };
    envelope_ok_response(&serde_json::json!({
        "available": value.as_bool().unwrap_or(false),
        "name": name,
    }))
}

pub async fn create(mut req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    if let Err(message) = validate_create_request(&body) {
        return Ok(envelope_error_response(400, message));
    }
    let client = match enabled_enterprise_client(&env).await? {
        Ok(client) => client,
        Err(response) => return Ok(response),
    };
    let value = match client
        .request_json(Method::Post, "/deploy", Some(body))
        .await
    {
        Ok(value) => value,
        Err(err) => return Ok(envelope_error_response(err.status, &err.message)),
    };
    envelope_ok_response(&serde_json::json!({
        "deployment_id": value.get("deployment_id").and_then(Value::as_str).unwrap_or(""),
        "status": value.get("status").and_then(Value::as_str).unwrap_or(""),
        "message": "Deployment created successfully",
    }))
}

pub async fn update(
    mut req: Request,
    env: Env,
    id_param: Option<&String>,
) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let Some(id) = nonempty_param(id_param, "deployment ID is required") else {
        return Ok(envelope_error_response(400, "deployment ID is required"));
    };
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let client = match enabled_enterprise_client(&env).await? {
        Ok(client) => client,
        Err(response) => return Ok(response),
    };
    let value = match client
        .request_json(
            Method::Patch,
            &format!("/deployment/{}", encode_path_segment(&id)),
            Some(body),
        )
        .await
    {
        Ok(value) => value,
        Err(err) => return Ok(envelope_error_response(err.status, &err.message)),
    };
    envelope_ok_response(&serde_json::json!({
        "status": value.get("status").and_then(Value::as_str).unwrap_or(""),
        "deployment_id": value
            .get("deployment_id")
            .and_then(Value::as_str)
            .unwrap_or(id.as_str()),
    }))
}

pub async fn rename(
    mut req: Request,
    env: Env,
    id_param: Option<&String>,
) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let Some(id) = nonempty_param(id_param, "deployment ID is required") else {
        return Ok(envelope_error_response(400, "deployment ID is required"));
    };
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let Some(name) = body
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(envelope_error_response(
            400,
            "deployment name cannot be empty",
        ));
    };
    let client = match enabled_enterprise_client(&env).await? {
        Ok(client) => client,
        Err(response) => return Ok(response),
    };
    let mut check = QueryBuilder::default();
    check.push("cluster_name", name);
    let available = match client
        .request_json(
            Method::Get,
            &format!(
                "/clusters/check_cluster_name_availability{}",
                check.finish()
            ),
            None,
        )
        .await
    {
        Ok(value) => value.as_bool().unwrap_or(false),
        Err(err) => return Ok(envelope_error_response(err.status, &err.message)),
    };
    if !available {
        return Ok(envelope_error_response(
            400,
            "deployment name is not available, please choose a different name",
        ));
    }
    let value = match client
        .request_json(
            Method::Put,
            &format!("/clusters/{}/update-name", encode_path_segment(&id)),
            Some(serde_json::json!({ "cluster_name": name })),
        )
        .await
    {
        Ok(value) => value,
        Err(err) => return Ok(envelope_error_response(err.status, &err.message)),
    };
    envelope_ok_response(&serde_json::json!({
        "status": value.get("status").and_then(Value::as_str).unwrap_or(""),
        "message": value.get("message").and_then(Value::as_str).unwrap_or(""),
        "id": id,
        "name": name,
    }))
}

pub async fn extend(
    mut req: Request,
    env: Env,
    id_param: Option<&String>,
) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let Some(id) = nonempty_param(id_param, "deployment ID is required") else {
        return Ok(envelope_error_response(400, "deployment ID is required"));
    };
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    if body
        .get("duration_hours")
        .and_then(value_as_i64)
        .unwrap_or(0)
        < 1
    {
        return Ok(envelope_error_response(
            400,
            "duration_hours must be at least 1",
        ));
    }
    let client = match enabled_enterprise_client(&env).await? {
        Ok(client) => client,
        Err(response) => return Ok(response),
    };
    let value = match client
        .request_json(
            Method::Post,
            &format!("/deployment/{}/extend", encode_path_segment(&id)),
            Some(body),
        )
        .await
    {
        Ok(value) => value,
        Err(err) => return Ok(envelope_error_response(err.status, &err.message)),
    };
    let data = unwrap_data(value);
    envelope_ok_response(&map_extended_deployment(&id, data))
}

pub async fn delete(req: Request, env: Env, id_param: Option<&String>) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let Some(id) = nonempty_param(id_param, "deployment ID is required") else {
        return Ok(envelope_error_response(400, "deployment ID is required"));
    };
    let client = match enabled_enterprise_client(&env).await? {
        Ok(client) => client,
        Err(response) => return Ok(response),
    };
    let value = match client
        .request_json(
            Method::Delete,
            &format!("/deployment/{}", encode_path_segment(&id)),
            None,
        )
        .await
    {
        Ok(value) => value,
        Err(err) => return Ok(envelope_error_response(err.status, &err.message)),
    };
    envelope_ok_response(&serde_json::json!({
        "status": value.get("status").and_then(Value::as_str).unwrap_or(""),
        "deployment_id": value
            .get("deployment_id")
            .and_then(Value::as_str)
            .unwrap_or(id.as_str()),
        "message": "Deployment termination requested successfully",
    }))
}

async fn enabled_enterprise_client(
    env: &Env,
) -> WorkerResult<std::result::Result<IoNetClient, Response>> {
    enabled_client(env, DEFAULT_ENTERPRISE_BASE_URL).await
}

async fn enabled_public_client(
    env: &Env,
) -> WorkerResult<std::result::Result<IoNetClient, Response>> {
    enabled_client(env, DEFAULT_PUBLIC_BASE_URL).await
}

async fn enabled_client(
    env: &Env,
    base_url: &str,
) -> WorkerResult<std::result::Result<IoNetClient, Response>> {
    let db = env.d1("DB")?;
    let config = read_config(&db).await?;
    match (config.enabled, config.api_key) {
        (true, Some(api_key)) => Ok(Ok(IoNetClient::new(
            api_key,
            base_url.to_string(),
            deployment_timeout(env),
        ))),
        _ => Ok(Err(envelope_error_response(
            400,
            "io.net model deployment is not enabled or api key missing",
        ))),
    }
}

async fn read_config(db: &worker::D1Database) -> WorkerResult<IoNetConfig> {
    let values =
        d1_repositories::option_values(db, &[IONET_ENABLED_KEY, IONET_API_KEY_KEY]).await?;
    Ok(IoNetConfig {
        enabled: parse_bool(values.first().and_then(Option::as_deref), false),
        api_key: values
            .get(1)
            .and_then(Option::as_deref)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
    })
}

fn deployment_timeout(env: &Env) -> Duration {
    let seconds = env
        .var("DEPLOYMENT_HTTP_TIMEOUT_SECONDS")
        .ok()
        .and_then(|value| value.to_string().parse::<u64>().ok())
        .unwrap_or(DEFAULT_TIMEOUT_SECONDS)
        .clamp(1, MAX_TIMEOUT_SECONDS);
    Duration::from_secs(seconds)
}

async fn optional_api_key_from_body(
    req: &mut Request,
) -> std::result::Result<Option<String>, Response> {
    let bytes = req.bytes().await.map_err(|err| {
        envelope_error_response(400, &format!("failed to read request body: {err}"))
    })?;
    if bytes.iter().all(|byte| byte.is_ascii_whitespace()) {
        return Ok(None);
    }
    if bytes.len() > 64 * 1024 {
        return Err(envelope_error_response(413, "request body too large"));
    }
    let body = serde_json::from_slice::<Value>(&bytes).map_err(|err| {
        envelope_error_response(400, &format!("request body is not valid JSON: {err}"))
    })?;
    Ok(body
        .get("api_key")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string))
}

#[derive(Debug, Clone)]
struct IoNetConfig {
    enabled: bool,
    api_key: Option<String>,
}

#[derive(Debug, Clone)]
struct IoNetClient {
    api_key: String,
    base_url: String,
    timeout: Duration,
}

impl IoNetClient {
    fn enterprise(api_key: String, timeout: Duration) -> Self {
        Self::new(api_key, DEFAULT_ENTERPRISE_BASE_URL.to_string(), timeout)
    }

    fn new(api_key: String, base_url: String, timeout: Duration) -> Self {
        Self {
            api_key,
            base_url: base_url.trim_end_matches('/').to_string(),
            timeout,
        }
    }

    async fn request_json(
        &self,
        method: Method,
        endpoint: &str,
        body: Option<Value>,
    ) -> std::result::Result<Value, IoNetError> {
        let bytes = self.request_bytes(method, endpoint, body).await?;
        serde_json::from_slice(&bytes).map_err(|err| IoNetError {
            status: 502,
            message: format!("failed to parse io.net response: {err}"),
        })
    }

    async fn request_text(
        &self,
        method: Method,
        endpoint: &str,
        body: Option<Value>,
    ) -> std::result::Result<String, IoNetError> {
        let bytes = self.request_bytes(method, endpoint, body).await?;
        String::from_utf8(bytes).map_err(|err| IoNetError {
            status: 502,
            message: format!("io.net response is not valid UTF-8: {err}"),
        })
    }

    async fn request_bytes(
        &self,
        method: Method,
        endpoint: &str,
        body: Option<Value>,
    ) -> std::result::Result<Vec<u8>, IoNetError> {
        let mut headers = Headers::new();
        headers
            .set("X-API-KEY", self.api_key.trim())
            .map_err(IoNetError::internal)?;
        headers
            .set("Accept", "application/json, text/plain")
            .map_err(IoNetError::internal)?;
        let body_bytes = if let Some(body) = body {
            headers
                .set("Content-Type", "application/json")
                .map_err(IoNetError::internal)?;
            let bytes = serde_json::to_vec(&body).map_err(|err| IoNetError {
                status: 400,
                message: format!("failed to encode request body: {err}"),
            })?;
            Some(bytes)
        } else {
            None
        };
        let mut init = RequestInit::new();
        init.with_method(method)
            .with_headers(headers)
            .with_redirect(RequestRedirect::Error);
        if let Some(bytes) = body_bytes {
            init.with_body(Some(wasm_bindgen::JsValue::from(js_sys::Uint8Array::from(
                bytes.as_slice(),
            ))));
        }
        let url = format!("{}{}", self.base_url, endpoint);
        let request = Request::new_with_init(&url, &init).map_err(IoNetError::internal)?;
        let controller = AbortController::default();
        let signal = controller.signal();
        let outbound = Fetch::Request(request);
        let fetch = outbound.send_with_signal(&signal);
        let delay = Delay::from(self.timeout);
        futures_util::pin_mut!(fetch);
        futures_util::pin_mut!(delay);
        let mut response = match select(fetch, delay).await {
            Either::Left((result, _)) => result.map_err(|err| IoNetError {
                status: 502,
                message: format!("io.net request failed: {err}"),
            })?,
            Either::Right(((), _)) => {
                controller.abort();
                return Err(IoNetError {
                    status: 504,
                    message: format!(
                        "io.net request timed out after {} seconds",
                        self.timeout.as_secs()
                    ),
                });
            }
        };
        let status = response.status_code();
        let bytes = read_limited_response_body(&mut response).await?;
        if status >= 400 {
            return Err(IoNetError {
                status: upstream_status(status),
                message: upstream_error_message(status, &bytes),
            });
        }
        Ok(bytes)
    }
}

#[derive(Debug)]
struct IoNetError {
    status: u16,
    message: String,
}

impl IoNetError {
    fn internal(error: worker::Error) -> Self {
        Self {
            status: 500,
            message: error.to_string(),
        }
    }
}

async fn read_limited_response_body(
    response: &mut Response,
) -> std::result::Result<Vec<u8>, IoNetError> {
    if let Some(raw) = response
        .headers()
        .get("Content-Length")
        .map_err(IoNetError::internal)?
    {
        if raw
            .trim()
            .parse::<usize>()
            .ok()
            .is_some_and(|length| length > IONET_RESPONSE_LIMIT_BYTES)
        {
            return Err(IoNetError {
                status: 502,
                message: "io.net response body is too large".to_string(),
            });
        }
    }
    response
        .stream()
        .map_err(IoNetError::internal)?
        .try_fold(Vec::new(), |mut bytes, chunk| async move {
            if bytes.len().saturating_add(chunk.len()) > IONET_RESPONSE_LIMIT_BYTES {
                return Err(worker::Error::RustError(
                    "io.net response body is too large".to_string(),
                ));
            }
            bytes.extend_from_slice(&chunk);
            Ok(bytes)
        })
        .await
        .map_err(IoNetError::internal)
}

fn upstream_status(status: u16) -> u16 {
    if matches!(status, 400 | 401 | 403 | 404 | 409 | 422 | 429) {
        status
    } else {
        502
    }
}

fn upstream_error_message(status: u16, bytes: &[u8]) -> String {
    if let Ok(value) = serde_json::from_slice::<Value>(bytes) {
        if let Some(detail) = value.get("detail").and_then(Value::as_str) {
            return detail.trim().to_string();
        }
        if let Some(message) = value.get("message").and_then(Value::as_str) {
            return message.trim().to_string();
        }
    }
    let raw = String::from_utf8_lossy(bytes).trim().to_string();
    if raw.is_empty() {
        format!("io.net API request failed with status {status}")
    } else {
        raw
    }
}

struct QueryBuilder {
    inner: form_urlencoded::Serializer<'static, String>,
}

impl Default for QueryBuilder {
    fn default() -> Self {
        Self {
            inner: form_urlencoded::Serializer::new(String::new()),
        }
    }
}

impl QueryBuilder {
    fn push(&mut self, key: &str, value: &str) {
        if !value.trim().is_empty() {
            self.inner.append_pair(key, value.trim());
        }
    }

    fn push_nonempty(&mut self, key: &str, value: Option<String>) {
        if let Some(value) = value {
            self.push(key, &value);
        }
    }

    fn push_u32(&mut self, key: &str, value: u32) {
        if value > 0 {
            self.inner.append_pair(key, &value.to_string());
        }
    }

    fn push_json_i64_array(&mut self, key: &str, values: &[i64]) {
        if !values.is_empty() {
            if let Ok(raw) = serde_json::to_string(values) {
                self.inner.append_pair(key, &raw);
            }
        }
    }

    fn finish(mut self) -> String {
        let raw = self.inner.finish();
        if raw.is_empty() {
            String::new()
        } else {
            format!("?{raw}")
        }
    }
}

fn deployment_list_data(
    data: Value,
    page: u32,
    page_size: u32,
    include_status_counts: bool,
) -> Value {
    let deployments = data
        .get("deployments")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let items = deployments
        .iter()
        .cloned()
        .map(map_deployment)
        .collect::<Vec<_>>();
    let mut payload = Map::new();
    payload.insert("page".to_string(), serde_json::json!(page));
    payload.insert("page_size".to_string(), serde_json::json!(page_size));
    payload.insert(
        "total".to_string(),
        serde_json::json!(data
            .get("total")
            .and_then(value_as_i64)
            .unwrap_or(items.len() as i64)),
    );
    payload.insert("items".to_string(), Value::Array(items));
    if include_status_counts {
        payload.insert(
            "status_counts".to_string(),
            serde_json::json!(status_counts(
                data.get("total").and_then(value_as_i64).unwrap_or(0),
                &deployments
            )),
        );
    }
    Value::Object(payload)
}

fn filter_deployments_by_keyword(data: &mut Value, keyword: &str) {
    let needle = keyword.to_ascii_lowercase();
    let total = {
        let Some(items) = data.get_mut("items").and_then(Value::as_array_mut) else {
            return;
        };
        items.retain(|item| {
            item.get("deployment_name")
                .or_else(|| item.get("name"))
                .and_then(Value::as_str)
                .map(|name| name.to_ascii_lowercase().contains(&needle))
                .unwrap_or(false)
        });
        items.len()
    };
    if let Some(object) = data.as_object_mut() {
        object.insert("total".to_string(), serde_json::json!(total));
    }
}

fn status_counts(total: i64, deployments: &[Value]) -> HashMap<String, i64> {
    let mut counts = HashMap::new();
    counts.insert("all".to_string(), total);
    for status in [
        "running",
        "completed",
        "failed",
        "deployment requested",
        "termination requested",
        "destroyed",
    ] {
        counts.insert(status.to_string(), 0);
    }
    for item in deployments {
        let status = item
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if !status.is_empty() {
            *counts.entry(status).or_insert(0) += 1;
        }
    }
    counts
}

fn map_deployment(value: Value) -> Value {
    let created_at = value
        .get("created_at")
        .and_then(unix_timestamp_value)
        .unwrap_or_else(crate::admin::unix_timestamp);
    let remaining = value
        .get("compute_minutes_remaining")
        .and_then(value_as_i64)
        .unwrap_or(0);
    let hardware_quantity = value
        .get("hardware_quantity")
        .and_then(value_as_i64)
        .unwrap_or(0);
    let brand = value
        .get("brand_name")
        .and_then(Value::as_str)
        .unwrap_or("");
    let hardware = value
        .get("hardware_name")
        .and_then(Value::as_str)
        .unwrap_or("");
    serde_json::json!({
        "id": value.get("id").cloned().unwrap_or(Value::Null),
        "deployment_name": value.get("name").cloned().unwrap_or(Value::Null),
        "container_name": value.get("name").cloned().unwrap_or(Value::Null),
        "status": value
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase(),
        "type": "Container",
        "time_remaining": format_minutes_remaining(remaining),
        "time_remaining_minutes": remaining,
        "hardware_info": format!("{} {} x{}", brand, hardware, hardware_quantity).trim().to_string(),
        "hardware_name": hardware,
        "brand_name": brand,
        "hardware_quantity": hardware_quantity,
        "completed_percent": value.get("completed_percent").cloned().unwrap_or(Value::Null),
        "compute_minutes_served": value.get("compute_minutes_served").cloned().unwrap_or(Value::Null),
        "compute_minutes_remaining": value.get("compute_minutes_remaining").cloned().unwrap_or(Value::Null),
        "created_at": created_at,
        "updated_at": created_at,
        "model_name": "",
        "model_version": "",
        "instance_count": hardware_quantity,
        "resource_config": {
            "cpu": "",
            "memory": "",
            "gpu": hardware_quantity.to_string(),
        },
        "description": "",
        "provider": "io.net",
    })
}

fn map_deployment_detail(value: Value) -> Value {
    let created_at = value
        .get("created_at")
        .and_then(unix_timestamp_value)
        .unwrap_or_default();
    let total_gpus = value.get("total_gpus").and_then(value_as_i64).unwrap_or(0);
    serde_json::json!({
        "id": value.get("id").cloned().unwrap_or(Value::Null),
        "deployment_name": value.get("id").cloned().unwrap_or(Value::Null),
        "model_name": "",
        "model_version": "",
        "status": value
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase(),
        "instance_count": value.get("total_containers").cloned().unwrap_or(Value::Null),
        "hardware_id": value.get("hardware_id").cloned().unwrap_or(Value::Null),
        "resource_config": {
            "cpu": "",
            "memory": "",
            "gpu": total_gpus.to_string(),
        },
        "created_at": created_at,
        "updated_at": created_at,
        "description": "",
        "amount_paid": value.get("amount_paid").cloned().unwrap_or(Value::Null),
        "completed_percent": value.get("completed_percent").cloned().unwrap_or(Value::Null),
        "gpus_per_container": value.get("gpus_per_container").cloned().unwrap_or(Value::Null),
        "total_gpus": total_gpus,
        "total_containers": value.get("total_containers").cloned().unwrap_or(Value::Null),
        "hardware_name": value.get("hardware_name").cloned().unwrap_or(Value::Null),
        "brand_name": value.get("brand_name").cloned().unwrap_or(Value::Null),
        "compute_minutes_served": value.get("compute_minutes_served").cloned().unwrap_or(Value::Null),
        "compute_minutes_remaining": value.get("compute_minutes_remaining").cloned().unwrap_or(Value::Null),
        "locations": value.get("locations").cloned().unwrap_or_else(|| Value::Array(Vec::new())),
        "container_config": value.get("container_config").cloned().unwrap_or(Value::Null),
    })
}

fn map_extended_deployment(deployment_id: &str, value: Value) -> Value {
    let source = serde_json::json!({
        "id": value.get("id").cloned().unwrap_or(Value::String(deployment_id.to_string())),
        "status": value.get("status").cloned().unwrap_or(Value::Null),
        "name": deployment_id,
        "completed_percent": value.get("completed_percent").cloned().unwrap_or(Value::Null),
        "hardware_quantity": value.get("total_gpus").cloned().unwrap_or(Value::Null),
        "brand_name": value.get("brand_name").cloned().unwrap_or(Value::Null),
        "hardware_name": value.get("hardware_name").cloned().unwrap_or(Value::Null),
        "compute_minutes_served": value.get("compute_minutes_served").cloned().unwrap_or(Value::Null),
        "compute_minutes_remaining": value.get("compute_minutes_remaining").cloned().unwrap_or(Value::Null),
        "created_at": value.get("created_at").cloned().unwrap_or(Value::Null),
    });
    map_deployment(source)
}

fn map_container(value: Value) -> Value {
    let created_at = value
        .get("created_at")
        .and_then(unix_timestamp_value)
        .unwrap_or_default();
    let events = value
        .get("container_events")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|event| {
            serde_json::json!({
                "time": event.get("time").and_then(unix_timestamp_value).unwrap_or_default(),
                "message": event.get("message").cloned().unwrap_or(Value::Null),
            })
        })
        .collect::<Vec<_>>();
    serde_json::json!({
        "container_id": value.get("container_id").cloned().unwrap_or(Value::Null),
        "device_id": value.get("device_id").cloned().unwrap_or(Value::Null),
        "status": value
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase(),
        "hardware": value.get("hardware").cloned().unwrap_or(Value::Null),
        "brand_name": value.get("brand_name").cloned().unwrap_or(Value::Null),
        "created_at": created_at,
        "uptime_percent": value.get("uptime_percent").cloned().unwrap_or(Value::Null),
        "gpus_per_container": value.get("gpus_per_container").cloned().unwrap_or(Value::Null),
        "public_url": value.get("public_url").cloned().unwrap_or(Value::Null),
        "events": events,
    })
}

fn map_hardware_type(value: &Value) -> Value {
    let id = value.get("hardware_id").and_then(value_as_i64).unwrap_or(0);
    let name = value
        .get("hardware_name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("Hardware {id}"));
    let available = value.get("available").and_then(value_as_i64).unwrap_or(0);
    serde_json::json!({
        "id": id,
        "name": name,
        "description": "",
        "gpu_type": "",
        "gpu_memory": 0,
        "max_gpus": value.get("max_gpus_per_container").and_then(value_as_i64).unwrap_or(0),
        "cpu": "",
        "memory": 0,
        "storage": 0,
        "hourly_rate": 0,
        "available": available > 0,
        "brand_name": value.get("brand_name").cloned().unwrap_or(Value::Null),
        "available_count": available,
    })
}

fn map_location(mut value: Value) -> Value {
    if let Some(iso2) = value.get("iso2").and_then(Value::as_str) {
        value["iso2"] = Value::String(iso2.trim().to_ascii_uppercase());
    }
    value
}

fn map_available_replica(value: Value, hardware_id: i64, gpu_count: i64) -> Value {
    serde_json::json!({
        "location_id": value.get("id").and_then(value_as_i64).unwrap_or(0),
        "location_name": value.get("name").cloned().unwrap_or(Value::Null),
        "hardware_id": hardware_id,
        "hardware_name": "",
        "available_count": value.get("available_replicas").and_then(value_as_i64).unwrap_or(0),
        "max_gpus": gpu_count,
    })
}

fn price_query(body: &Value) -> std::result::Result<String, String> {
    let location_ids = body
        .get("location_ids")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(value_as_i64)
                .filter(|v| *v > 0)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if location_ids.is_empty() {
        return Err("location_ids is required".to_string());
    }
    let hardware_id = body.get("hardware_id").and_then(value_as_i64).unwrap_or(0);
    if hardware_id <= 0 {
        return Err("hardware_id is required".to_string());
    }
    let replica_count = body
        .get("replica_count")
        .and_then(value_as_i64)
        .unwrap_or(0);
    if replica_count < 1 {
        return Err("replica_count must be at least 1".to_string());
    }
    let gpus = body
        .get("gpus_per_container")
        .and_then(value_as_i64)
        .unwrap_or(0);
    let hardware_qty = body
        .get("hardware_qty")
        .and_then(value_as_i64)
        .or_else(|| body.get("gpus_per_container").and_then(value_as_i64))
        .unwrap_or(0);
    if hardware_qty < 1 {
        return Err("hardware_qty must be at least 1".to_string());
    }
    let duration_qty = body
        .get("duration_qty")
        .and_then(value_as_i64)
        .or_else(|| body.get("duration_hours").and_then(value_as_i64))
        .unwrap_or(0);
    if duration_qty < 1 {
        return Err("duration_qty must be at least 1".to_string());
    }
    let duration_type = duration_type_for_api(
        body.get("duration_type")
            .and_then(Value::as_str)
            .unwrap_or("hour"),
    );
    let mut params = QueryBuilder::default();
    params.push_json_i64_array("location_ids", &location_ids);
    params.push("hardware_id", &hardware_id.to_string());
    params.push("hardware_qty", &hardware_qty.to_string());
    params.push("gpus_per_container", &gpus.to_string());
    params.push("duration_type", duration_type);
    params.push("duration_qty", &duration_qty.to_string());
    params.push(
        "duration_hours",
        &body
            .get("duration_hours")
            .and_then(value_as_i64)
            .unwrap_or(duration_qty)
            .to_string(),
    );
    params.push("replica_count", &replica_count.to_string());
    params.push(
        "currency",
        body.get("currency")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("usdc"),
    );
    Ok(params.finish())
}

fn duration_type_for_api(raw: &str) -> &'static str {
    match raw.trim().to_ascii_lowercase().as_str() {
        "day" | "days" | "daily" => "daily",
        "week" | "weeks" | "weekly" => "weekly",
        "month" | "months" | "monthly" => "monthly",
        _ => "hourly",
    }
}

fn map_price_estimation(pricing: &Value, body: &Value) -> Value {
    let total = pricing
        .get("total_cost_usdc")
        .and_then(value_as_f64)
        .unwrap_or(0.0);
    let ionet_fee = pricing
        .get("ionet_fee")
        .and_then(value_as_f64)
        .unwrap_or(0.0);
    let conversion_fee = pricing
        .get("currency_conversion_fee")
        .and_then(value_as_f64)
        .unwrap_or(0.0);
    let hours = duration_hours_for_rate(body).max(1.0);
    let currency = body
        .get("currency")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("usdc")
        .to_ascii_uppercase();
    serde_json::json!({
        "estimated_cost": total,
        "currency": currency,
        "estimation_valid": true,
        "price_breakdown": {
            "compute_cost": total - ionet_fee - conversion_fee,
            "total_cost": total,
            "hourly_rate": total / hours,
        }
    })
}

fn duration_hours_for_rate(body: &Value) -> f64 {
    let qty = body
        .get("duration_qty")
        .and_then(value_as_f64)
        .or_else(|| body.get("duration_hours").and_then(value_as_f64))
        .unwrap_or(1.0);
    match body
        .get("duration_type")
        .and_then(Value::as_str)
        .unwrap_or("hour")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "day" | "days" | "daily" => qty * 24.0,
        "week" | "weeks" | "weekly" => qty * 24.0 * 7.0,
        "month" | "months" | "monthly" => qty * 24.0 * 30.0,
        _ => qty,
    }
}

fn validate_create_request(body: &Value) -> std::result::Result<(), &'static str> {
    if body
        .get("resource_private_name")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .is_empty()
    {
        return Err("resource_private_name is required");
    }
    if body
        .get("location_ids")
        .and_then(Value::as_array)
        .map_or(true, |value| value.is_empty())
    {
        return Err("location_ids is required");
    }
    if body.get("hardware_id").and_then(value_as_i64).unwrap_or(0) <= 0 {
        return Err("hardware_id is required");
    }
    if body
        .pointer("/registry_config/image_url")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .is_empty()
    {
        return Err("registry_config.image_url is required");
    }
    if body
        .get("gpus_per_container")
        .and_then(value_as_i64)
        .unwrap_or(0)
        < 1
    {
        return Err("gpus_per_container must be at least 1");
    }
    if body
        .get("duration_hours")
        .and_then(value_as_i64)
        .unwrap_or(0)
        < 1
    {
        return Err("duration_hours must be at least 1");
    }
    if body
        .pointer("/container_config/replica_count")
        .and_then(value_as_i64)
        .unwrap_or(0)
        < 1
    {
        return Err("container_config.replica_count must be at least 1");
    }
    Ok(())
}

fn unwrap_data(value: Value) -> Value {
    match value {
        Value::Object(mut object) => object.remove("data").unwrap_or(Value::Object(object)),
        other => other,
    }
}

fn parse_bool(value: Option<&str>, default: bool) -> bool {
    match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
        Some("true" | "1" | "yes" | "on") => true,
        Some("false" | "0" | "no" | "off") => false,
        _ => default,
    }
}

fn parse_query_string(req: &Request, key: &str) -> Option<String> {
    let url = req.url().ok()?;
    url.query_pairs()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn parse_query_i64(req: &Request, key: &str) -> Option<i64> {
    parse_query_string(req, key)?.parse::<i64>().ok()
}

fn parse_query_u32(req: &Request, key: &str) -> Option<u32> {
    parse_query_string(req, key)?.parse::<u32>().ok()
}

fn bounded_log_limit(req: &Request) -> i64 {
    parse_query_i64(req, "limit")
        .filter(|value| *value > 0)
        .map(|value| value.min(1000))
        .unwrap_or(100)
}

fn nonempty_param(value: Option<&String>, _message: &str) -> Option<String> {
    value
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn encode_path_segment(value: &str) -> String {
    form_urlencoded::byte_serialize(value.as_bytes()).collect::<String>()
}

fn value_as_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
        .or_else(|| value.as_f64().map(|value| value as i64))
        .or_else(|| value.as_str()?.trim().parse::<i64>().ok())
}

fn value_as_f64(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_i64().map(|value| value as f64))
        .or_else(|| value.as_u64().map(|value| value as f64))
        .or_else(|| value.as_str()?.trim().parse::<f64>().ok())
}

fn unix_timestamp_value(value: &Value) -> Option<i64> {
    if let Some(number) = value_as_i64(value) {
        return Some(number);
    }
    let raw = value.as_str()?.trim();
    if raw.is_empty() {
        return None;
    }
    let millis = js_sys::Date::parse(raw);
    if millis.is_finite() {
        Some((millis / 1000.0) as i64)
    } else {
        None
    }
}

fn format_minutes_remaining(minutes: i64) -> String {
    let minutes = minutes.max(0);
    let hours = minutes / 60;
    let mins = minutes % 60;
    if hours > 0 {
        format!("{hours} hour {mins} minutes")
    } else if mins > 0 {
        format!("{mins} minutes")
    } else {
        "completed".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn price_query_normalizes_duration_and_arrays() {
        let body = serde_json::json!({
            "location_ids": [1, "2", 0],
            "hardware_id": 7,
            "gpus_per_container": 2,
            "duration_type": "day",
            "duration_qty": 3,
            "replica_count": 4,
            "currency": "usdc"
        });
        let query = price_query(&body).unwrap();
        assert!(query.starts_with('?'));
        assert!(query.contains("hardware_id=7"));
        assert!(query.contains("duration_type=daily"));
        assert!(query.contains("location_ids=%5B1%2C2%5D"));
    }

    #[test]
    fn deployment_mapping_matches_frontend_shape() {
        let value = serde_json::json!({
            "id": "dep_1",
            "name": "demo",
            "status": "Running",
            "hardware_quantity": 2,
            "brand_name": "NVIDIA",
            "hardware_name": "A100",
            "compute_minutes_remaining": 75,
            "compute_minutes_served": 5,
            "completed_percent": 10,
            "created_at": 1700000000
        });
        let mapped = map_deployment(value);
        assert_eq!(mapped["deployment_name"], "demo");
        assert_eq!(mapped["status"], "running");
        assert_eq!(mapped["time_remaining"], "1 hour 15 minutes");
        assert_eq!(mapped["provider"], "io.net");
    }

    #[test]
    fn create_request_validation_keeps_required_fields() {
        let missing = serde_json::json!({});
        assert_eq!(
            validate_create_request(&missing).unwrap_err(),
            "resource_private_name is required"
        );
        let ok = serde_json::json!({
            "resource_private_name": "demo",
            "duration_hours": 1,
            "gpus_per_container": 1,
            "hardware_id": 1,
            "location_ids": [1],
            "container_config": {"replica_count": 1},
            "registry_config": {"image_url": "registry.example/app:latest"}
        });
        assert!(validate_create_request(&ok).is_ok());
    }
}
