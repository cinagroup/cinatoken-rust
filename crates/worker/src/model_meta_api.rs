//! Admin CRUD for the `models` metadata + `vendors` tables (Go
//! `controller/model_meta.go` + `controller/vendor_meta.go`, routes
//! `/api/models/*` and `/api/vendors/*`, AdminAuth).
//!
//! Deferred vs Go (documented): the list responses return the base rows
//! without the batch display enrichment (`bound_channels` / `enable_groups` /
//! `quota_types` per row and the vendor model-counts) — display extras the Go
//! frontend tolerates missing; and `sync_upstream*` (fetches provider model
//! lists from upstream — live provider I/O, see the completion-status doc).

use serde::{Deserialize, Serialize};
use worker::{Env, Request, Response, Result as WorkerResult};

use crate::admin::{
    envelope_error_response, envelope_ok_response, read_json_body, require_admin_auth,
    unix_timestamp,
};
use crate::d1_repositories::{self, ModelMetaFull, VendorFull};

// ---------------------------------------------------------------------------
// Shared helpers (module-local copies of the admin CRUD conventions)
// ---------------------------------------------------------------------------

fn parse_query_string(req: &Request, key: &str) -> Option<String> {
    let url = req.url().ok()?;
    let value = url
        .query_pairs()
        .find(|(k, _)| k == key)?
        .1
        .trim()
        .to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn parse_pagination(req: &Request) -> (u32, u32) {
    let parse = |key: &str| -> Option<u32> { parse_query_string(req, key)?.parse().ok() };
    let page = parse("p").unwrap_or(1).max(1);
    let page_size = parse("page_size").unwrap_or(10).clamp(1, 100);
    (page, page_size)
}

fn parse_id_param(id_param: Option<&String>) -> Option<i64> {
    id_param?.trim().parse().ok()
}

/// The `{items,total,page,page_size}` list envelope shared by the Go admin
/// list endpoints.
#[derive(Serialize)]
struct Page<T: Serialize> {
    items: Vec<T>,
    total: i64,
    page: u32,
    page_size: u32,
}

// ---------------------------------------------------------------------------
// Models metadata CRUD
// ---------------------------------------------------------------------------

/// Create/update request body (Go binds straight into `model.Model`).
#[derive(Debug, Deserialize, Default)]
pub struct ModelMetaRequest {
    #[serde(default)]
    pub id: i64,
    #[serde(default)]
    pub model_name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub tags: String,
    #[serde(default)]
    pub vendor_id: i64,
    #[serde(default)]
    pub endpoints: String,
    #[serde(default = "default_status")]
    pub status: i32,
    #[serde(default = "default_sync_official")]
    pub sync_official: i32,
    #[serde(default)]
    pub name_rule: i32,
}

fn default_status() -> i32 {
    1
}
fn default_sync_official() -> i32 {
    1
}

/// `GET /api/models/` and `GET /api/models/search`: paginated live metadata
/// rows; search adds `keyword` + `vendor` filters (the plain list is the
/// search with no filters, so one handler serves both).
pub async fn list_models_meta(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let keyword = parse_query_string(&req, "keyword");
    let vendor_id = parse_query_string(&req, "vendor").and_then(|value| value.parse::<i64>().ok());
    let (page, page_size) = parse_pagination(&req);
    let db = env.d1("DB")?;
    let (items, total) = d1_repositories::list_models_meta(
        &db,
        keyword.as_deref(),
        vendor_id,
        (page - 1) * page_size,
        page_size,
    )
    .await?;
    envelope_ok_response(&Page {
        items,
        total,
        page,
        page_size,
    })
}

/// `GET /api/models/:id`: one metadata row.
pub async fn get_model_meta(
    req: Request,
    env: Env,
    id_param: Option<&String>,
) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let Some(id) = parse_id_param(id_param) else {
        return Ok(envelope_error_response(400, "invalid model id"));
    };
    let db = env.d1("DB")?;
    match d1_repositories::get_model_meta(&db, id).await? {
        Some(row) => envelope_ok_response(&row),
        None => Ok(envelope_error_response(404, "model not found")),
    }
}

/// `POST /api/models/`: create a metadata row (name must be unique among live
/// rows; Go `CreateModelMeta`).
pub async fn create_model_meta(mut req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let payload: ModelMetaRequest = serde_json::from_value(body).unwrap_or_default();
    let name = payload.model_name.trim();
    if name.is_empty() {
        return Ok(envelope_error_response(400, "model name must not be empty"));
    }
    let db = env.d1("DB")?;
    if d1_repositories::model_meta_name_duplicated(&db, 0, name).await? {
        return Ok(envelope_error_response(409, "model name already exists"));
    }
    let now = unix_timestamp();
    let id = d1_repositories::insert_model_meta(
        &db,
        &ModelMetaFull {
            id: 0,
            model_name: name.to_string(),
            description: payload.description,
            icon: payload.icon,
            tags: payload.tags,
            vendor_id: payload.vendor_id,
            endpoints: payload.endpoints,
            status: payload.status,
            sync_official: payload.sync_official,
            name_rule: payload.name_rule,
            created_time: now,
            updated_time: now,
        },
    )
    .await?;
    envelope_ok_response(&serde_json::json!({"id": id}))
}

/// `PUT /api/models/`: update a metadata row. `?status_only=true` flips only
/// the status (Go `UpdateModelMeta`).
pub async fn update_model_meta(mut req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let status_only = parse_query_string(&req, "status_only").as_deref() == Some("true");
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let payload: ModelMetaRequest = serde_json::from_value(body).unwrap_or_default();
    if payload.id == 0 {
        return Ok(envelope_error_response(400, "missing model id"));
    }
    let db = env.d1("DB")?;
    if status_only {
        d1_repositories::update_model_meta_status(&db, payload.id, payload.status).await?;
        return envelope_ok_response(&serde_json::Value::Null);
    }
    let name = payload.model_name.trim();
    if name.is_empty() {
        return Ok(envelope_error_response(400, "model name must not be empty"));
    }
    if d1_repositories::model_meta_name_duplicated(&db, payload.id, name).await? {
        return Ok(envelope_error_response(409, "model name already exists"));
    }
    d1_repositories::update_model_meta(
        &db,
        &ModelMetaFull {
            id: payload.id,
            model_name: name.to_string(),
            description: payload.description,
            icon: payload.icon,
            tags: payload.tags,
            vendor_id: payload.vendor_id,
            endpoints: payload.endpoints,
            status: payload.status,
            sync_official: payload.sync_official,
            name_rule: payload.name_rule,
            created_time: 0,
            updated_time: unix_timestamp(),
        },
    )
    .await?;
    envelope_ok_response(&serde_json::Value::Null)
}

/// `DELETE /api/models/:id`: soft-delete a metadata row.
pub async fn delete_model_meta(
    req: Request,
    env: Env,
    id_param: Option<&String>,
) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let Some(id) = parse_id_param(id_param) else {
        return Ok(envelope_error_response(400, "invalid model id"));
    };
    let db = env.d1("DB")?;
    d1_repositories::soft_delete_model_meta(&db, id, unix_timestamp()).await?;
    envelope_ok_response(&serde_json::Value::Null)
}

/// `GET /api/models/missing`: enabled ability models with no metadata row
/// under the name rules (Go `GetMissingModels`).
pub async fn get_missing_models(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let db = env.d1("DB")?;
    let enabled = d1_repositories::distinct_all_enabled_models(&db).await?;
    let meta_rows = d1_repositories::list_model_meta(&db).await?;
    let matched = crate::pricing_api::match_meta(&enabled, &meta_rows);
    let missing: Vec<&String> = enabled
        .iter()
        .filter(|model| !matched.contains_key(model.as_str()))
        .collect();
    envelope_ok_response(&missing)
}

// ---------------------------------------------------------------------------
// Vendors CRUD
// ---------------------------------------------------------------------------

/// Create/update request body (Go binds into `model.Vendor`).
#[derive(Debug, Deserialize, Default)]
pub struct VendorRequest {
    #[serde(default)]
    pub id: i64,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default = "default_status")]
    pub status: i32,
}

/// `GET /api/vendors/` and `GET /api/vendors/search`: paginated live vendors
/// (search adds `keyword`).
pub async fn list_vendors(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let keyword = parse_query_string(&req, "keyword");
    let (page, page_size) = parse_pagination(&req);
    let db = env.d1("DB")?;
    let (items, total) = d1_repositories::list_vendors_page(
        &db,
        keyword.as_deref(),
        (page - 1) * page_size,
        page_size,
    )
    .await?;
    envelope_ok_response(&Page {
        items,
        total,
        page,
        page_size,
    })
}

/// `GET /api/vendors/:id`: one vendor.
pub async fn get_vendor(
    req: Request,
    env: Env,
    id_param: Option<&String>,
) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let Some(id) = parse_id_param(id_param) else {
        return Ok(envelope_error_response(400, "invalid vendor id"));
    };
    let db = env.d1("DB")?;
    match d1_repositories::get_vendor(&db, id).await? {
        Some(row) => envelope_ok_response(&row),
        None => Ok(envelope_error_response(404, "vendor not found")),
    }
}

/// `POST /api/vendors/`: create a vendor (unique live name).
pub async fn create_vendor(mut req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let payload: VendorRequest = serde_json::from_value(body).unwrap_or_default();
    let name = payload.name.trim();
    if name.is_empty() {
        return Ok(envelope_error_response(
            400,
            "vendor name must not be empty",
        ));
    }
    let db = env.d1("DB")?;
    if d1_repositories::vendor_name_duplicated(&db, 0, name).await? {
        return Ok(envelope_error_response(409, "vendor name already exists"));
    }
    let now = unix_timestamp();
    let id = d1_repositories::insert_vendor(
        &db,
        &VendorFull {
            id: 0,
            name: name.to_string(),
            description: payload.description,
            icon: payload.icon,
            status: payload.status,
            created_time: now,
            updated_time: now,
        },
    )
    .await?;
    envelope_ok_response(&serde_json::json!({"id": id}))
}

/// `PUT /api/vendors/`: update a vendor.
pub async fn update_vendor(mut req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let payload: VendorRequest = serde_json::from_value(body).unwrap_or_default();
    if payload.id == 0 {
        return Ok(envelope_error_response(400, "missing vendor id"));
    }
    let name = payload.name.trim();
    if name.is_empty() {
        return Ok(envelope_error_response(
            400,
            "vendor name must not be empty",
        ));
    }
    let db = env.d1("DB")?;
    if d1_repositories::vendor_name_duplicated(&db, payload.id, name).await? {
        return Ok(envelope_error_response(409, "vendor name already exists"));
    }
    d1_repositories::update_vendor(
        &db,
        &VendorFull {
            id: payload.id,
            name: name.to_string(),
            description: payload.description,
            icon: payload.icon,
            status: payload.status,
            created_time: 0,
            updated_time: unix_timestamp(),
        },
    )
    .await?;
    envelope_ok_response(&serde_json::Value::Null)
}

/// `DELETE /api/vendors/:id`: soft-delete a vendor.
pub async fn delete_vendor(
    req: Request,
    env: Env,
    id_param: Option<&String>,
) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let Some(id) = parse_id_param(id_param) else {
        return Ok(envelope_error_response(400, "invalid vendor id"));
    };
    let db = env.d1("DB")?;
    d1_repositories::soft_delete_vendor(&db, id, unix_timestamp()).await?;
    envelope_ok_response(&serde_json::Value::Null)
}
