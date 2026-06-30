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
    doubao, hailuo, kling, sora, submit_request, vidu, VideoProvider,
};
use cinatoken_tasks::{apply_other_ratios, TaskInfo, TaskStatus, TaskSubmitReq};
use wasm_bindgen::JsValue;
use worker::{D1Database, Env, Fetch, Headers, Method, Request, RequestInit, Response};

/// Build the submit request body for a provider by dispatching to its ported
/// body transform (the submit half of Go `BuildRequestBody`). The four
/// JSON-payload providers serialize their `convert_to_request_payload`; Sora
/// overrides `model` in the raw client body. Ali (nested struct + no-model-strip
/// metadata merge), Gemini, and Vertex submit bodies are not yet ported and
/// return an error so the caller can fall back. `raw_client_body` is the original
/// request body Sora reshapes.
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
        VideoProvider::Sora => Ok(sora::build_json_body(raw_client_body, upstream_model)),
        VideoProvider::Ali
        | VideoProvider::Gemini
        | VideoProvider::Vertex
        | VideoProvider::Jimeng => Err("submit body not yet ported for this provider".to_string()),
    }
}

/// Build the signed submit HTTP request (a `POST` [`PollRequest`]) for the
/// simple-auth providers: the submit URL (action-dependent), the key-derived
/// auth header (`Bearer` for sora/doubao/ali/hailuo, `Token` for vidu), and the
/// JSON body. Kling (JWT) and Jimeng (Volcengine SigV4) need request signing and
/// are not wired here; Gemini/Vertex submit bodies aren't ported.
pub fn build_submit_http_request(
    provider: VideoProvider,
    base_url: &str,
    key: &str,
    action: &str,
    origin_task_id: &str,
    body: Vec<u8>,
    now: i64,
) -> Result<PollRequest, String> {
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
            return Err("submit request not wired for this provider (signing/unported)".to_string())
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
pub async fn submit_task(
    provider: VideoProvider,
    base_url: &str,
    key: &str,
    action: &str,
    origin_task_id: &str,
    req: &TaskSubmitReq,
    upstream_model: &str,
    raw_client_body: &[u8],
    now: i64,
) -> worker::Result<String> {
    let body = build_submit_body(provider, req, upstream_model, raw_client_body)
        .map_err(worker::Error::RustError)?;
    let request =
        build_submit_http_request(provider, base_url, key, action, origin_task_id, body, now)
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
    };

    match relay_task_submit(&db, &ctx, &task_req, &body_bytes).await {
        Ok(public_task_id) => {
            crate::json_with_status(&serde_json::json!({"task_id": public_task_id}), 200)
        }
        Err(err) => crate::json_with_status(&serde_json::json!({"error": err.to_string()}), 500),
    }
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
        VideoProvider::Kling | VideoProvider::Jimeng | VideoProvider::Vertex => return Ok(None),
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
