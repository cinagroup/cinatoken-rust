//! Worker-side task polling I/O.
//!
//! The pure halves — building the upstream poll request, parsing the response,
//! and deciding the settlement — live in `cinatoken_tasks` and are host-tested.
//! This module is the thin wasm I/O that executes a [`PollRequest`] over the
//! Workers `fetch` runtime and threads the bytes into the parser + the D1
//! settle-apply. It is foundation ahead of the submit flow / poll trigger /
//! routes that drive it; runtime-verified by a staging poll.
#![allow(dead_code)]

use crate::task_repository::{apply_poll_result, find_unfinished_tasks, TaskRow};
use cinatoken_tasks::providers::poll_request::{self, HttpMethod, PollRequest};
use cinatoken_tasks::providers::VideoProvider;
use cinatoken_tasks::TaskInfo;
use wasm_bindgen::JsValue;
use worker::{D1Database, Fetch, Headers, Method, Request, RequestInit};

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
