//! Worker-side task polling I/O.
//!
//! The pure halves — building the upstream poll request, parsing the response,
//! and deciding the settlement — live in `cinatoken_tasks` and are host-tested.
//! This module is the thin wasm I/O that executes a [`PollRequest`] over the
//! Workers `fetch` runtime and threads the bytes into the parser + the D1
//! settle-apply. It is foundation ahead of the submit flow / poll trigger /
//! routes that drive it; runtime-verified by a staging poll.
#![allow(dead_code)]

use crate::d1_repositories::{refund_reserved_relay_quota, reserve_relay_quota};
use crate::task_repository::{
    apply_poll_result, find_unfinished_tasks, generate_task_id, insert_task, NewTask, TaskRow,
};
use cinatoken_tasks::providers::poll_request::{self, HttpMethod, PollRequest};
use cinatoken_tasks::providers::{
    ali, doubao, gemini, hailuo, jimeng, kling, midjourney, sora, submit_request, suno, vertex,
    vidu, VideoProvider,
};
use cinatoken_tasks::taskcommon::decode_local_task_id;
use cinatoken_tasks::{
    apply_other_ratios, cover_task_action_to_model_name, TaskInfo, TaskStatus, TaskSubmitReq,
};
use std::collections::HashMap;
use wasm_bindgen::JsValue;
use worker::{D1Database, Env, Fetch, Headers, Method, Request, RequestInit, Response};

/// Build the submit request body for a provider by dispatching to its ported
/// body transform (the submit half of Go `BuildRequestBody`). The JSON-payload
/// providers serialize their `convert_to_request_payload`; Sora overrides `model`
/// in the raw client body; Gemini/Vertex share the Veo payload. All providers'
/// bodies are ported. `raw_client_body` is the original request body Sora
/// reshapes.
pub fn build_submit_body(
    provider: VideoProvider,
    req: &TaskSubmitReq,
    upstream_model: &str,
    raw_client_body: &[u8],
) -> Result<Vec<u8>, String> {
    fn serialize_payload<T: serde::Serialize>(
        result: Result<T, String>,
    ) -> Result<Vec<u8>, String> {
        serde_json::to_vec(&result?).map_err(|err| err.to_string())
    }
    match provider {
        VideoProvider::Doubao => serialize_payload(doubao::convert_to_request_payload(req)),
        VideoProvider::Hailuo => {
            serialize_payload(hailuo::convert_to_request_payload(req, upstream_model))
        }
        VideoProvider::Vidu => {
            serialize_payload(vidu::convert_to_request_payload(req, upstream_model))
        }
        VideoProvider::Kling => {
            serialize_payload(kling::convert_to_request_payload(req, upstream_model))
        }
        VideoProvider::Jimeng => {
            serialize_payload(jimeng::convert_to_request_payload(req, upstream_model))
        }
        VideoProvider::Ali => {
            serialize_payload(ali::convert_to_request_payload(req, upstream_model))
        }
        VideoProvider::Sora => Ok(sora::build_json_body(raw_client_body, upstream_model)),
        // Gemini and Vertex share the Veo predictLongRunning body. (Vertex's full
        // submit runs through submit_vertex_task, which needs the async token, so
        // this arm is only reached for Gemini in practice.)
        VideoProvider::Gemini | VideoProvider::Vertex => {
            serialize_payload(gemini::convert_to_request_payload(req))
        }
    }
}

/// The host component of a base URL (scheme stripped, up to the first `/`), for
/// the Jimeng/Volcengine SigV4 `Host` header.
fn url_host(base_url: &str) -> &str {
    base_url
        .strip_prefix("https://")
        .or_else(|| base_url.strip_prefix("http://"))
        .unwrap_or(base_url)
        .split('/')
        .next()
        .unwrap_or(base_url)
}

/// Build a signed Jimeng (Volcengine) request for a `CVSync2Async*` action. A
/// new-api relay key (`sk-`) uses `Bearer` auth and the `/jimeng/` path; a direct
/// `accessKey|secretKey` uses SigV4 signing (host/date/content-sha256/auth
/// headers). Shared by submit (`SubmitTask`) and poll (`GetResult`).
fn build_jimeng_request(
    base_url: &str,
    key: &str,
    query_action: &str,
    body: Vec<u8>,
    now: i64,
) -> Result<PollRequest, String> {
    let is_relay = key.starts_with("sk-");
    let path_prefix = if is_relay { "/jimeng/" } else { "/" };
    let url = format!("{base_url}{path_prefix}?Action={query_action}&Version=2022-08-31");
    let body_string = String::from_utf8(body.clone()).map_err(|err| err.to_string())?;

    let mut headers = vec![
        ("Accept".to_string(), "application/json".to_string()),
        ("Content-Type".to_string(), "application/json".to_string()),
    ];
    if is_relay {
        headers.push(("Authorization".to_string(), format!("Bearer {key}")));
    } else {
        let parts: Vec<&str> = key.split('|').collect();
        if parts.len() != 2 {
            return Err("invalid jimeng key, required accessKey|secretKey".to_string());
        }
        let (access_key, secret_key) = (parts[0].trim(), parts[1].trim());
        let (x_date, short_date) = jimeng::format_volcengine_dates(now);
        let query = [
            ("Action".to_string(), query_action.to_string()),
            ("Version".to_string(), "2022-08-31".to_string()),
        ];
        let signed = jimeng::sign_request(
            "POST",
            url_host(base_url),
            "/",
            &query,
            Some("application/json"),
            &body,
            access_key,
            secret_key,
            &x_date,
            &short_date,
        );
        headers.push(("Host".to_string(), signed.host));
        headers.push(("X-Date".to_string(), signed.x_date));
        headers.push(("X-Content-Sha256".to_string(), signed.x_content_sha256));
        headers.push(("Authorization".to_string(), signed.authorization));
    }

    Ok(PollRequest {
        method: HttpMethod::Post,
        url,
        headers,
        body: Some(body_string),
    })
}

/// Build the signed submit HTTP request (a `POST` [`PollRequest`]). The
/// simple-auth providers use the action-dependent submit URL + a key-derived
/// auth header (`Bearer` for sora/doubao/ali/hailuo, `Token` for vidu); Kling
/// mints a JWT, Jimeng builds a Volcengine-SigV4-signed request, and Gemini posts
/// to `predictLongRunning` with an `x-goog-api-key` header. Vertex is handled by
/// [`submit_vertex_task`] (async GCP token exchange) and never reaches here.
pub fn build_submit_http_request(
    provider: VideoProvider,
    base_url: &str,
    key: &str,
    action: &str,
    origin_task_id: &str,
    upstream_model: &str,
    gemini_version: &str,
    body: Vec<u8>,
    now: i64,
) -> Result<PollRequest, String> {
    // Jimeng builds the full signed request (SigV4 adds host/date/sha256 headers).
    if provider == VideoProvider::Jimeng {
        return build_jimeng_request(base_url, key, "CVSync2AsyncSubmitTask", body, now);
    }
    // Gemini posts to predictLongRunning with the `x-goog-api-key` header (not a
    // bearer Authorization), so it builds its request directly.
    if provider == VideoProvider::Gemini {
        let body = String::from_utf8(body).map_err(|err| err.to_string())?;
        return Ok(PollRequest {
            method: HttpMethod::Post,
            url: submit_request::gemini(base_url, gemini_version, upstream_model),
            headers: vec![
                ("x-goog-api-key".to_string(), key.to_string()),
                ("Content-Type".to_string(), "application/json".to_string()),
            ],
            body: Some(body),
        });
    }
    let (url, auth) = match provider {
        VideoProvider::Sora => (
            submit_request::sora(base_url, action, origin_task_id),
            format!("Bearer {key}"),
        ),
        VideoProvider::Doubao => (submit_request::doubao(base_url), format!("Bearer {key}")),
        VideoProvider::Ali => (submit_request::ali(base_url), format!("Bearer {key}")),
        VideoProvider::Hailuo => (submit_request::hailuo(base_url), format!("Bearer {key}")),
        VideoProvider::Vidu => (
            submit_request::vidu(base_url, action),
            format!("Token {key}"),
        ),
        VideoProvider::Kling => {
            // Kling signs with a JWT minted from the channel key (an `sk-`-prefixed
            // key is a new-api relay key, routed through the `/kling` prefix and
            // passed through verbatim by create_jwt_token).
            let is_new_api_relay = key.starts_with("sk-");
            let token = kling::create_jwt_token(key, now)?;
            (
                submit_request::kling(base_url, action, is_new_api_relay),
                format!("Bearer {token}"),
            )
        }
        VideoProvider::Jimeng | VideoProvider::Gemini | VideoProvider::Vertex => {
            // Jimeng + Gemini are handled above; only Vertex (GCP OAuth) is
            // genuinely unported here.
            return Err(
                "submit request not wired for this provider (Vertex GCP OAuth)".to_string(),
            );
        }
    };
    let body = String::from_utf8(body).map_err(|err| err.to_string())?;
    Ok(PollRequest {
        method: HttpMethod::Post,
        url,
        headers: vec![
            ("Authorization".to_string(), auth),
            ("Content-Type".to_string(), "application/json".to_string()),
        ],
        body: Some(body),
    })
}

/// The submit HTTP half (symmetric to [`poll_task`]): build the provider body,
/// build the signed submit request, send it, and parse the upstream task id from
/// the response. The pure pieces (body transform, request URL, response parser)
/// are host-tested; this thin I/O wrapper is runtime-verified by a staging
/// submit. Returns the upstream task id.
/// Acquire a Vertex access token: parse the service-account JSON (the channel
/// key), mint the RS256 assertion JWT, and exchange it at Google's OAuth2 token
/// endpoint. Returns `(access_token, project_id)`. No caching yet — each
/// submit/poll exchanges fresh (Vertex is low-volume); a KV-backed cache is a
/// follow-up.
async fn acquire_vertex_token(
    service_account_json: &str,
    now: i64,
) -> worker::Result<(String, String)> {
    let sa: vertex::ServiceAccount = serde_json::from_str(service_account_json)
        .map_err(|err| worker::Error::RustError(format!("parse service account: {err}")))?;
    let jwt = vertex::create_signed_jwt(&sa.client_email, &sa.private_key, now)
        .map_err(worker::Error::RustError)?;
    let request = PollRequest {
        method: HttpMethod::Post,
        url: vertex::TOKEN_ENDPOINT.to_string(),
        headers: vec![(
            "Content-Type".to_string(),
            "application/x-www-form-urlencoded".to_string(),
        )],
        body: Some(vertex::token_exchange_body(&jwt)),
    };
    let response = execute_poll_request(&request).await?;
    let token = vertex::parse_token_response(&response).map_err(worker::Error::RustError)?;
    Ok((token, sa.project_id))
}

/// Submit a Vertex task: acquire a token, build the `predictLongRunning` URL +
/// the shared Veo body, POST, and return the encoded operation name.
async fn submit_vertex_task(
    base_url: &str,
    service_account_json: &str,
    region: &str,
    req: &TaskSubmitReq,
    model: &str,
    now: i64,
) -> worker::Result<String> {
    let (token, project_id) = acquire_vertex_token(service_account_json, now).await?;
    let url = vertex::build_predict_url(base_url, "v1", &project_id, region, model);
    let payload = gemini::convert_to_request_payload(req).map_err(worker::Error::RustError)?;
    let body = serde_json::to_string(&payload)?;
    let request = PollRequest {
        method: HttpMethod::Post,
        url,
        headers: vec![
            ("Authorization".to_string(), format!("Bearer {token}")),
            ("Content-Type".to_string(), "application/json".to_string()),
        ],
        body: Some(body),
    };
    let response = execute_poll_request(&request).await?;
    vertex::parse_submit_response(&response).map_err(worker::Error::RustError)
}

/// Poll a Vertex task: decode the operation name, build the
/// `fetchPredictOperation` URL, acquire a token, POST `{operationName}`, parse,
/// and apply the settle.
async fn poll_vertex_task(
    db: &D1Database,
    task: &TaskRow,
    base_url: &str,
    service_account_json: &str,
    now: i64,
) -> worker::Result<bool> {
    let operation_name =
        decode_local_task_id(&task.upstream_task_id).map_err(worker::Error::RustError)?;
    let url =
        vertex::build_fetch_url(base_url, &operation_name).map_err(worker::Error::RustError)?;
    let (token, _project_id) = acquire_vertex_token(service_account_json, now).await?;
    let request = PollRequest {
        method: HttpMethod::Post,
        url,
        headers: vec![
            ("Authorization".to_string(), format!("Bearer {token}")),
            ("Content-Type".to_string(), "application/json".to_string()),
        ],
        body: Some(serde_json::json!({ "operationName": operation_name }).to_string()),
    };
    let response = execute_poll_request(&request).await?;
    let info = vertex::parse_task_result(&response).map_err(worker::Error::RustError)?;
    let finish_time = if info.status.is_terminal() { now } else { 0 };
    apply_poll_result(db, task, &info, finish_time, now).await
}

pub async fn submit_task(
    provider: VideoProvider,
    base_url: &str,
    key: &str,
    action: &str,
    origin_task_id: &str,
    req: &TaskSubmitReq,
    upstream_model: &str,
    gemini_version: &str,
    vertex_region: &str,
    raw_client_body: &[u8],
    now: i64,
) -> worker::Result<String> {
    // Vertex needs an async GCP token exchange before building the request, so it
    // bypasses the sync build_submit_* path.
    if provider == VideoProvider::Vertex {
        return submit_vertex_task(base_url, key, vertex_region, req, upstream_model, now).await;
    }
    let body = build_submit_body(provider, req, upstream_model, raw_client_body)
        .map_err(worker::Error::RustError)?;
    let request = build_submit_http_request(
        provider,
        base_url,
        key,
        action,
        origin_task_id,
        upstream_model,
        gemini_version,
        body,
        now,
    )
    .map_err(worker::Error::RustError)?;
    let response = execute_poll_request(&request).await?;
    provider
        .parse_submit_response(&response)
        .map_err(|message| worker::Error::RustError(format!("parse submit response: {message}")))
}

/// Compute the base per-call quota for a task model — a port of Go
/// `ModelPriceHelperPerCall`: `model_price * quota_per_unit * group_ratio`.
/// Returns `Ok(None)` when the model has no configured price (unbilled). Loads
/// the pricing options in one D1 round-trip, mirroring the relay's flat-billing
/// load.
pub async fn compute_task_base_quota(
    db: &D1Database,
    model: &str,
    group: &str,
) -> worker::Result<Option<i64>> {
    let keys = [
        "ModelRatio",
        "CompletionRatio",
        "ModelPrice",
        "CacheRatio",
        "QuotaPerUnit",
        crate::d1_repositories::GROUP_RATIO_OPTION_KEY,
        "CreateCacheRatio",
        "ImageRatio",
        "AudioRatio",
        "AudioCompletionRatio",
    ];
    let values = crate::d1_repositories::option_values(db, &keys).await?;
    let config = cinatoken_billing::PricingConfig::new()
        .with_json_maps(
            values[0].as_deref(),
            values[1].as_deref(),
            values[2].as_deref(),
            values[3].as_deref(),
            values[5].as_deref(), // group ratio
            values[4].as_deref(), // quota per unit
        )
        .with_subcategory_maps(
            values[6].as_deref(),
            values[7].as_deref(),
            values[8].as_deref(),
            values[9].as_deref(),
        );
    let Some(price) = config.model_price(model) else {
        return Ok(None);
    };
    let group_ratio = crate::d1_repositories::group_ratio_for_group(db, group).await?;
    Ok(Some((price * config.quota_per_unit * group_ratio) as i64))
}

/// The resolved auth/channel/billing context for a task submit — what the route
/// handler produces (authenticate → select channel → price the base model)
/// before the billing+submit orchestration runs.
pub struct TaskSubmitContext<'a> {
    pub provider: VideoProvider,
    pub channel_id: i64,
    pub channel_base_url: &'a str,
    pub channel_key: &'a str,
    pub user_id: i64,
    pub token_id: i64,
    pub username: &'a str,
    pub group: &'a str,
    pub platform: &'a str,
    pub upstream_model: &'a str,
    pub action: &'a str,
    pub origin_task_id: &'a str,
    pub base_quota: i64,
    pub now: i64,
    /// Configured Gemini API version (e.g. `v1beta`); only used by Gemini.
    pub gemini_version: &'a str,
    /// Configured Vertex region (e.g. `us-central1`); only used by Vertex.
    pub vertex_region: &'a str,
}

/// Orchestrate a task submit — the billing + submit + insert core of Go
/// `RelayTaskSubmit` (the route handler supplies the resolved context). Steps:
/// estimate the pre-charge ratios and apply them to the base quota, reserve it,
/// submit upstream, and on success insert the task row (status `SUBMITTED`). A
/// submit failure refunds the reserve before returning the error. Returns the
/// public task id.
///
/// Today only Sora contributes a billing estimate; other providers use the base
/// quota. The estimate ratios are applied via `apply_other_ratios` whose per-step
/// truncation is order-sensitive — like Go (which iterates a map), so the
/// ordering is unspecified for multi-ratio estimates. Runtime-verified by a
/// staging submit.
pub async fn relay_task_submit(
    db: &D1Database,
    ctx: &TaskSubmitContext<'_>,
    req: &TaskSubmitReq,
    raw_client_body: &[u8],
) -> worker::Result<String> {
    let ratios: Vec<f64> = match ctx.provider {
        VideoProvider::Sora => sora::estimate_billing(
            &req.seconds,
            req.duration,
            &req.size,
            ctx.action == "remixGenerate",
        )
        .map(|estimate| estimate.into_values().collect())
        .unwrap_or_default(),
        _ => Vec::new(),
    };
    let quota = apply_other_ratios(ctx.base_quota, &ratios);

    reserve_relay_quota(db, ctx.user_id, ctx.token_id, quota, ctx.now).await?;

    let upstream_task_id = match submit_task(
        ctx.provider,
        ctx.channel_base_url,
        ctx.channel_key,
        ctx.action,
        ctx.origin_task_id,
        req,
        ctx.upstream_model,
        ctx.gemini_version,
        ctx.vertex_region,
        raw_client_body,
        ctx.now,
    )
    .await
    {
        Ok(id) => id,
        Err(err) => {
            // Best-effort refund of the reserve before surfacing the failure.
            let _ =
                refund_reserved_relay_quota(db, ctx.user_id, ctx.token_id, quota, ctx.now).await;
            return Err(err);
        }
    };

    let public_task_id = generate_task_id();
    let new_task = NewTask {
        task_id: &public_task_id,
        upstream_task_id: &upstream_task_id,
        platform: ctx.platform,
        user_id: ctx.user_id,
        username: ctx.username,
        group: ctx.group,
        channel_id: ctx.channel_id,
        token_id: ctx.token_id,
        quota,
        action: ctx.action,
        status: TaskStatus::Submitted,
        submit_time: ctx.now,
        created_at: ctx.now,
        updated_at: ctx.now,
    };
    insert_task(db, &new_task).await?;

    Ok(public_task_id)
}

/// Video channel types that run task providers (`constant/channel.go`), used to
/// scope channel selection to task-capable channels.
const VIDEO_CHANNEL_TYPES: &[i32] = &[1, 17, 24, 35, 41, 45, 50, 51, 52, 54, 55];

/// HTTP entry for a video task submit — the route handler that produces the
/// [`TaskSubmitContext`] and drives [`relay_task_submit`]: authenticate the key,
/// parse the request, select a task channel for the model, price the base model
/// ([`compute_task_base_quota`]), and submit. Returns `{"task_id": "task_..."}`.
///
/// Simplifications pending runtime tuning against Go: the action defaults to
/// `generate` (Go derives it per-provider in `ValidateRequestAndSetAction`), the
/// platform tag uses the model, and channel model-mapping isn't applied — these
/// affect provider routing/billing detail and are validated by a staging submit.
pub async fn handle_task_submit(mut req: Request, env: Env, now: i64) -> worker::Result<Response> {
    let db = env.d1("DB")?;

    let Some(api_key) = crate::relay::extract_api_key(&req) else {
        return crate::json_with_status(&serde_json::json!({"error": "missing api key"}), 401);
    };
    let Some(auth) = crate::d1_repositories::authenticate_token(&db, &api_key).await? else {
        return crate::json_with_status(&serde_json::json!({"error": "invalid api key"}), 401);
    };

    let body_bytes = req.bytes().await?;
    let task_req: TaskSubmitReq = match serde_json::from_slice(&body_bytes) {
        Ok(parsed) => parsed,
        Err(err) => {
            return crate::json_with_status(
                &serde_json::json!({"error": format!("invalid request: {err}")}),
                400,
            )
        }
    };
    let model = task_req.model.clone();

    let channels = crate::d1_repositories::select_relay_channels(
        &db,
        &model,
        &auth.user_group,
        VIDEO_CHANNEL_TYPES,
    )
    .await?;
    let Some(channel) = channels.into_iter().next() else {
        return crate::json_with_status(
            &serde_json::json!({"error": "no available channel for model"}),
            503,
        );
    };
    let Some(provider) = VideoProvider::from_channel_type(channel.channel_type as i64) else {
        return crate::json_with_status(
            &serde_json::json!({"error": "channel is not a task provider"}),
            503,
        );
    };

    let base_quota = compute_task_base_quota(&db, &model, &auth.user_group)
        .await?
        .unwrap_or(0);

    let channel_base_url = channel.base_url.as_deref().unwrap_or_default();
    let gemini_version = env
        .var("GEMINI_VERSION")
        .map(|value| value.to_string())
        .unwrap_or_else(|_| "v1beta".to_string());
    let vertex_region = env
        .var("VERTEX_REGION")
        .map(|value| value.to_string())
        .unwrap_or_else(|_| "us-central1".to_string());
    let ctx = TaskSubmitContext {
        provider,
        channel_id: channel.id,
        channel_base_url,
        channel_key: &channel.key,
        user_id: auth.user_id,
        token_id: auth.token_id,
        username: &auth.username,
        group: &auth.token_group,
        platform: &model,
        upstream_model: &model,
        action: "generate",
        origin_task_id: "",
        base_quota,
        now,
        gemini_version: &gemini_version,
        vertex_region: &vertex_region,
    };

    match relay_task_submit(&db, &ctx, &task_req, &body_bytes).await {
        Ok(public_task_id) => {
            crate::json_with_status(&serde_json::json!({"task_id": public_task_id}), 200)
        }
        Err(err) => crate::json_with_status(&serde_json::json!({"error": err.to_string()}), 500),
    }
}

/// HTTP entry for a Suno task submit (`POST /suno/submit/:action`). Suno is a
/// platform (not a channel-type video provider): it selects a SunoAPI channel
/// (type 36), reserves the base quota, forwards the client body verbatim to
/// `{base}/suno/submit/{action}` with bearer auth, parses the upstream task id,
/// and inserts the task with platform `suno`. The billing model is the request's
/// model, or `suno_<action>` when absent. A submit failure refunds the reserve.
/// Runtime-verified by a staging submit.
pub async fn handle_suno_submit(
    mut req: Request,
    env: Env,
    action: &str,
    now: i64,
) -> worker::Result<Response> {
    let db = env.d1("DB")?;
    // Go uppercases the action (ValidateRequestAndSetAction); the upstream URL
    // and stored action use it, while the billing model lowercases it back.
    let action = action.to_uppercase();

    let Some(api_key) = crate::relay::extract_api_key(&req) else {
        return crate::json_with_status(&serde_json::json!({"error": "missing api key"}), 401);
    };
    let Some(auth) = crate::d1_repositories::authenticate_token(&db, &api_key).await? else {
        return crate::json_with_status(&serde_json::json!({"error": "invalid api key"}), 401);
    };

    let body_bytes = req.bytes().await?;
    let task_req: TaskSubmitReq = serde_json::from_slice(&body_bytes).unwrap_or_default();
    let model = if task_req.model.is_empty() {
        cover_task_action_to_model_name("suno", &action)
    } else {
        task_req.model.clone()
    };

    // Suno channels are channel type 36 (SunoAPI).
    let channels =
        crate::d1_repositories::select_relay_channels(&db, &model, &auth.user_group, &[36]).await?;
    let Some(channel) = channels.into_iter().next() else {
        return crate::json_with_status(
            &serde_json::json!({"error": "no available suno channel for model"}),
            503,
        );
    };

    let base_quota = compute_task_base_quota(&db, &model, &auth.user_group)
        .await?
        .unwrap_or(0);
    reserve_relay_quota(&db, auth.user_id, auth.token_id, base_quota, now).await?;

    let base_url = channel.base_url.as_deref().unwrap_or_default();
    let request = PollRequest {
        method: HttpMethod::Post,
        url: format!("{base_url}/suno/submit/{action}"),
        headers: vec![
            (
                "Authorization".to_string(),
                format!("Bearer {}", channel.key),
            ),
            ("Content-Type".to_string(), "application/json".to_string()),
        ],
        body: Some(String::from_utf8(body_bytes).unwrap_or_default()),
    };

    let upstream_task_id = match execute_poll_request(&request).await {
        Ok(response) => match suno::parse_submit_response(&response) {
            Ok(id) => id,
            Err(err) => {
                let _ =
                    refund_reserved_relay_quota(&db, auth.user_id, auth.token_id, base_quota, now)
                        .await;
                return crate::json_with_status(&serde_json::json!({"error": err}), 500);
            }
        },
        Err(err) => {
            let _ = refund_reserved_relay_quota(&db, auth.user_id, auth.token_id, base_quota, now)
                .await;
            return crate::json_with_status(&serde_json::json!({"error": err.to_string()}), 500);
        }
    };

    let public_task_id = generate_task_id();
    let new_task = NewTask {
        task_id: &public_task_id,
        upstream_task_id: &upstream_task_id,
        platform: "suno",
        user_id: auth.user_id,
        username: &auth.username,
        group: &auth.token_group,
        channel_id: channel.id,
        token_id: auth.token_id,
        quota: base_quota,
        action: &action,
        status: TaskStatus::Submitted,
        submit_time: now,
        created_at: now,
        updated_at: now,
    };
    insert_task(&db, &new_task).await?;

    crate::json_with_status(&serde_json::json!({"task_id": public_task_id}), 200)
}

/// HTTP entry for a Midjourney submit (`POST /mj/submit/:action`). mj is its own
/// subsystem: it selects a Midjourney channel (type 2 or 5), reserves the base
/// quota, forwards the client body to `{base}/mj/submit/{action}` with the
/// `mj-api-secret` header, parses the `MidjourneyResponse` (`code == 1` ⇒ the
/// `result` mj id), and inserts a row into `midjourneys`. The billing model is
/// `mj_<action>`. A submit failure refunds the reserve. Runtime-verified by a
/// staging submit.
pub async fn handle_mj_submit(
    mut req: Request,
    env: Env,
    action: &str,
    now: i64,
) -> worker::Result<Response> {
    let db = env.d1("DB")?;

    let Some(api_key) = crate::relay::extract_api_key(&req) else {
        return crate::json_with_status(&serde_json::json!({"error": "missing api key"}), 401);
    };
    let Some(auth) = crate::d1_repositories::authenticate_token(&db, &api_key).await? else {
        return crate::json_with_status(&serde_json::json!({"error": "invalid api key"}), 401);
    };

    let body_bytes = req.bytes().await?;
    let body_value: serde_json::Value = serde_json::from_slice(&body_bytes).unwrap_or_default();
    let prompt = body_value
        .get("prompt")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    let model = cover_task_action_to_model_name("mj", action);

    // Midjourney channels are type 2 (Midjourney) or 5 (MidjourneyPlus).
    let channels =
        crate::d1_repositories::select_relay_channels(&db, &model, &auth.user_group, &[2, 5])
            .await?;
    let Some(channel) = channels.into_iter().next() else {
        return crate::json_with_status(
            &serde_json::json!({"error": "no available midjourney channel for model"}),
            503,
        );
    };

    let base_quota = compute_task_base_quota(&db, &model, &auth.user_group)
        .await?
        .unwrap_or(0);
    reserve_relay_quota(&db, auth.user_id, auth.token_id, base_quota, now).await?;

    let base_url = channel.base_url.as_deref().unwrap_or_default();
    let request = PollRequest {
        method: HttpMethod::Post,
        url: format!("{base_url}/mj/submit/{action}"),
        headers: vec![
            ("mj-api-secret".to_string(), channel.key.clone()),
            ("Content-Type".to_string(), "application/json".to_string()),
        ],
        body: Some(String::from_utf8(body_bytes.clone()).unwrap_or_default()),
    };

    let mj_id = match execute_poll_request(&request).await {
        Ok(response) => match midjourney::parse_submit_response(&response) {
            Ok(id) => id,
            Err(err) => {
                let _ =
                    refund_reserved_relay_quota(&db, auth.user_id, auth.token_id, base_quota, now)
                        .await;
                return crate::json_with_status(
                    &serde_json::json!({"code": 4, "description": err}),
                    400,
                );
            }
        },
        Err(err) => {
            let _ = refund_reserved_relay_quota(&db, auth.user_id, auth.token_id, base_quota, now)
                .await;
            return crate::json_with_status(
                &serde_json::json!({"code": 4, "description": err.to_string()}),
                500,
            );
        }
    };

    let new_mj = crate::mj_repository::NewMidjourney {
        code: 1,
        user_id: auth.user_id,
        action,
        mj_id: &mj_id,
        prompt,
        prompt_en: prompt,
        channel_id: channel.id,
        quota: base_quota,
        status: "SUBMITTED",
        progress: "0%",
        submit_time: now,
    };
    crate::mj_repository::insert_midjourney(&db, &new_mj).await?;

    crate::json_with_status(
        &serde_json::json!({"code": 1, "description": "submit success", "result": mj_id}),
        200,
    )
}

/// Execute a provider poll request and return the response body bytes. The
/// caller feeds these to the matching provider parser
/// ([`VideoProvider::parse_task_result`]).
pub async fn execute_poll_request(request: &PollRequest) -> worker::Result<Vec<u8>> {
    let mut headers = Headers::new();
    for (name, value) in &request.headers {
        headers.set(name, value)?;
    }

    let mut init = RequestInit::new();
    init.with_method(match request.method {
        HttpMethod::Get => Method::Get,
        HttpMethod::Post => Method::Post,
    })
    .with_headers(headers);
    if let Some(body) = &request.body {
        init.with_body(Some(JsValue::from_str(body)));
    }

    let outbound = Request::new_with_init(&request.url, &init)?;
    let mut response = Fetch::Request(outbound).send().await?;
    Ok(response.text().await?.into_bytes())
}

/// Execute a poll request and parse it with the given provider's parser — the
/// fetch-then-parse half of one poll cycle. The settle-apply half is
/// [`crate::task_repository::apply_poll_result`], which the caller invokes with
/// the returned [`TaskInfo`].
pub async fn poll_task(provider: VideoProvider, request: &PollRequest) -> worker::Result<TaskInfo> {
    let body = execute_poll_request(request).await?;
    provider
        .parse_task_result(&body)
        .map_err(|message| worker::Error::RustError(format!("parse task result: {message}")))
}

/// Run one full poll cycle for a task against its channel: resolve the provider
/// from the channel type, build the (simple-auth) poll request, fetch + parse,
/// and apply the result through the CAS settle-apply.
///
/// Returns `Ok(None)` when the channel type runs no task provider, or when the
/// provider needs worker-side signing that is not yet ported (Kling JWT, Jimeng
/// Volcengine HMAC, Vertex GCP OAuth); `Ok(Some(won))` otherwise, where `won`
/// reports whether this call won the settlement transition.
///
/// The fetch id is the task's `upstream_task_id` (for Gemini that is the
/// base64-encoded operation name the request builder decodes). The exact id
/// field per provider is confirmed by a staging poll.
pub async fn poll_one_task(
    db: &D1Database,
    task: &TaskRow,
    channel_type: i32,
    channel_key: &str,
    channel_base_url: &str,
    gemini_version: &str,
    now: i64,
) -> worker::Result<Option<bool>> {
    let Some(provider) = VideoProvider::from_channel_type(channel_type as i64) else {
        return Ok(None);
    };
    let id = task.upstream_task_id.as_str();

    let request = match provider {
        VideoProvider::Sora => poll_request::sora(channel_base_url, channel_key, id),
        VideoProvider::Vidu => poll_request::vidu(channel_base_url, channel_key, id),
        VideoProvider::Ali => poll_request::ali(channel_base_url, channel_key, id),
        VideoProvider::Doubao => poll_request::doubao(channel_base_url, channel_key, id),
        VideoProvider::Hailuo => poll_request::hailuo(channel_base_url, channel_key, id),
        VideoProvider::Gemini => {
            poll_request::gemini(channel_base_url, channel_key, id, gemini_version)
                .map_err(worker::Error::RustError)?
        }
        VideoProvider::Kling => {
            let is_new_api_relay = channel_key.starts_with("sk-");
            let token =
                kling::create_jwt_token(channel_key, now).map_err(worker::Error::RustError)?;
            poll_request::kling(channel_base_url, &token, &task.action, id, is_new_api_relay)
        }
        VideoProvider::Jimeng => {
            // Jimeng polls with a POST carrying a fixed req_key + the task id,
            // SigV4-signed (or Bearer for a relay key).
            let body = serde_json::to_vec(&serde_json::json!({
                "req_key": "jimeng_vgfm_t2v_l20",
                "task_id": id,
            }))
            .map_err(|err| worker::Error::RustError(err.to_string()))?;
            build_jimeng_request(
                channel_base_url,
                channel_key,
                "CVSync2AsyncGetResult",
                body,
                now,
            )
            .map_err(worker::Error::RustError)?
        }
        VideoProvider::Vertex => {
            // Vertex needs an async GCP token exchange + the operation-name-based
            // fetch URL, so it runs its own poll cycle.
            return poll_vertex_task(db, task, channel_base_url, channel_key, now)
                .await
                .map(Some);
        }
    };

    let info = poll_task(provider, &request).await?;
    let finish_time = if info.status.is_terminal() { now } else { 0 };
    let won = apply_poll_result(db, task, &info, finish_time, now).await?;
    Ok(Some(won))
}

/// Drive one batch of the poller: load up to `limit` unfinished tasks, look up
/// each task's channel, and run a poll cycle. Best-effort per task — a lookup or
/// poll failure on one task is skipped rather than aborting the batch (mirroring
/// the per-task error handling in Go's pollers). Returns the number of tasks
/// whose terminal settlement this run won.
pub async fn poll_unfinished_tasks(
    db: &D1Database,
    gemini_version: &str,
    now: i64,
    limit: i64,
) -> worker::Result<u32> {
    let tasks = find_unfinished_tasks(db, limit).await?;
    let mut settled = 0u32;
    for task in &tasks {
        let channel = match crate::d1_repositories::find_channel_by_id(db, task.channel_id).await {
            Ok(Some(channel)) => channel,
            _ => continue,
        };
        let outcome = poll_one_task(
            db,
            task,
            channel.kind,
            &channel.key,
            &channel.base_url,
            gemini_version,
            now,
        )
        .await;
        if let Ok(Some(true)) = outcome {
            settled += 1;
        }
    }
    Ok(settled)
}

/// Drive the Suno batch poll (Go `UpdateSunoTasks`): load unfinished `suno`
/// tasks, group them by channel, and for each channel POST the batch of upstream
/// ids to `{base}/suno/fetch`, parse the `TaskResponse<Vec<SunoDataResponse>>`,
/// and merge each item back onto its task via
/// [`crate::task_repository::apply_suno_poll_result`] (CAS status + refund on
/// failure). Best-effort per channel/item. Returns the count of settlements won.
pub async fn poll_unfinished_suno_tasks(
    db: &D1Database,
    now: i64,
    limit: i64,
) -> worker::Result<u32> {
    let tasks = find_unfinished_tasks(db, limit).await?;
    let mut by_channel: HashMap<i64, Vec<&TaskRow>> = HashMap::new();
    for task in &tasks {
        if task.platform == "suno" && !task.upstream_task_id.is_empty() {
            by_channel.entry(task.channel_id).or_default().push(task);
        }
    }

    let mut settled = 0u32;
    for (channel_id, channel_tasks) in by_channel {
        let channel = match crate::d1_repositories::find_channel_by_id(db, channel_id).await {
            Ok(Some(channel)) => channel,
            _ => continue,
        };
        let ids: Vec<&str> = channel_tasks
            .iter()
            .map(|task| task.upstream_task_id.as_str())
            .collect();
        let request = PollRequest {
            method: HttpMethod::Post,
            url: format!("{}/suno/fetch", channel.base_url),
            headers: vec![
                (
                    "Authorization".to_string(),
                    format!("Bearer {}", channel.key),
                ),
                ("Content-Type".to_string(), "application/json".to_string()),
            ],
            body: Some(serde_json::json!({ "ids": ids }).to_string()),
        };

        let Ok(response) = execute_poll_request(&request).await else {
            continue;
        };
        let parsed: suno::TaskResponse<Vec<suno::SunoDataResponse>> =
            match serde_json::from_slice(&response) {
                Ok(parsed) => parsed,
                Err(_) => continue,
            };
        if !parsed.is_success() {
            continue;
        }

        for item in &parsed.data {
            let Some(task) = channel_tasks
                .iter()
                .find(|task| task.upstream_task_id == item.task_id)
            else {
                continue;
            };
            if let Ok(true) = crate::task_repository::apply_suno_poll_result(
                db,
                task,
                &item.status,
                &item.fail_reason,
                now,
            )
            .await
            {
                settled += 1;
            }
        }
    }
    Ok(settled)
}

/// Drive the Midjourney batch poll (Go `controller/midjourney.go`): load
/// unfinished `midjourneys` rows, group by channel, POST the batch of `mj_id`s to
/// `{base}/mj/task/list-by-condition` (authenticated with the `mj-api-secret`
/// header), parse the `[]MidjourneyDto` array, and merge each item onto its row
/// via [`crate::mj_repository::apply_midjourney_poll_result`]. A row that has
/// been unfinished for over an hour without reaching 100% is forced to FAILURE
/// (Go's timeout guard). Best-effort per channel/item; returns settlements won.
pub async fn poll_unfinished_midjourney_tasks(
    db: &D1Database,
    now: i64,
    limit: i64,
) -> worker::Result<u32> {
    use crate::mj_repository::{apply_midjourney_poll_result, MjPollResult, MjRow};

    let rows = crate::mj_repository::find_unfinished_midjourneys(db, limit).await?;
    let mut by_channel: HashMap<i64, Vec<&MjRow>> = HashMap::new();
    for row in &rows {
        by_channel.entry(row.channel_id).or_default().push(row);
    }

    let mut settled = 0u32;
    for (channel_id, channel_rows) in by_channel {
        let channel = match crate::d1_repositories::find_channel_by_id(db, channel_id).await {
            Ok(Some(channel)) => channel,
            _ => continue,
        };
        let ids: Vec<&str> = channel_rows.iter().map(|row| row.mj_id.as_str()).collect();
        let request = PollRequest {
            method: HttpMethod::Post,
            url: format!("{}/mj/task/list-by-condition", channel.base_url),
            headers: vec![
                ("mj-api-secret".to_string(), channel.key.clone()),
                ("Content-Type".to_string(), "application/json".to_string()),
            ],
            body: Some(serde_json::json!({ "ids": ids }).to_string()),
        };

        let Ok(response) = execute_poll_request(&request).await else {
            continue;
        };
        let items: Vec<midjourney::MidjourneyDto> = match serde_json::from_slice(&response) {
            Ok(items) => items,
            Err(_) => continue,
        };

        for item in &items {
            let Some(row) = channel_rows.iter().find(|row| row.mj_id == item.mj_id) else {
                continue;
            };
            // Over an hour unfinished and not at 100% -> force failure (Go guard).
            let timed_out = now - row.submit_time > 3600 && row.progress != "100%";
            let status = if timed_out {
                "FAILURE"
            } else {
                item.status.as_str()
            };
            let fail_reason = if timed_out {
                "upstream task timeout (over 1 hour)"
            } else {
                item.fail_reason.as_str()
            };
            let finish_time = if status == "SUCCESS" || status == "FAILURE" {
                now
            } else {
                0
            };
            let result = MjPollResult {
                status,
                progress: &item.progress,
                fail_reason,
                image_url: &item.image_url,
                video_url: &item.video_url,
                finish_time,
            };
            if let Ok(true) = apply_midjourney_poll_result(db, row, &result).await {
                settled += 1;
            }
        }
    }
    Ok(settled)
}
