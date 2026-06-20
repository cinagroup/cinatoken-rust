mod cache;
mod d1_repositories;
mod relay;

use worker::{event, Context, Env, Method, Request, Response, Result, Router};

#[event(fetch)]
pub async fn fetch(req: Request, env: Env, ctx: Context) -> Result<Response> {
    console_error_panic_hook::set_once();

    if req.method() == Method::Options {
        return empty_cors_response();
    }

    if req.method() == Method::Post {
        if let Some(route) = cinatoken_relay::parse_gemini_native_path(&req.path()) {
            return relay::gemini_native(req, env, ctx, route).await;
        }
    }

    Router::with_data(ctx)
        .get("/api/status", |_, ctx| {
            let environment = ctx
                .var("ENVIRONMENT")
                .map(|value| value.to_string())
                .unwrap_or_else(|_| "development".to_string());
            let mut status = cinatoken_api::status(environment);
            set_feature(&mut status, "d1", ctx.env.d1("DB").is_ok());
            set_feature(
                &mut status,
                "upstash_redis",
                cache::upstash_redis_configured(&ctx.env),
            );
            set_feature(
                &mut status,
                "relay_rate_limit",
                relay::relay_rate_limit_configured(&ctx.env),
            );
            set_feature(
                &mut status,
                "relay_read_cache",
                relay::relay_read_cache_configured(&ctx.env),
            );
            json_with_status(&status, 200)
        })
        .get("/v1/models", |_, _| {
            json_with_status(&cinatoken_api::models(), 200)
        })
        .post_async("/v1/chat/completions", |req, ctx| async move {
            let env = ctx.env;
            let event_ctx = ctx.data;
            relay::chat_completions(req, env, event_ctx).await
        })
        .post_async("/v1/completions", |req, ctx| async move {
            let env = ctx.env;
            let event_ctx = ctx.data;
            relay::completions(req, env, event_ctx).await
        })
        .post_async("/v1/responses", |req, ctx| async move {
            let env = ctx.env;
            let event_ctx = ctx.data;
            relay::responses(req, env, event_ctx).await
        })
        .post_async("/v1/messages", |req, ctx| async move {
            let env = ctx.env;
            let event_ctx = ctx.data;
            relay::anthropic_messages(req, env, event_ctx).await
        })
        .post_async("/v1/embeddings", |req, ctx| async move {
            relay::embeddings(req, ctx.env).await
        })
        .post_async("/v1/images/generations", |req, ctx| async move {
            let env = ctx.env;
            let event_ctx = ctx.data;
            relay::image_generations(req, env, event_ctx).await
        })
        .run(req, env)
        .await
}

pub(crate) fn json_with_status<T: serde::Serialize>(body: &T, status: u16) -> Result<Response> {
    let mut response = Response::from_json(body)?.with_status(status);
    set_cors_headers(&mut response)?;
    Ok(response)
}

fn empty_cors_response() -> Result<Response> {
    let mut response = Response::empty()?.with_status(204);
    set_cors_headers(&mut response)?;
    Ok(response)
}

pub(crate) fn set_cors_headers(response: &mut Response) -> Result<()> {
    let headers = response.headers_mut();
    headers.set("Access-Control-Allow-Origin", "*")?;
    headers.set(
        "Access-Control-Allow-Headers",
        "authorization,content-type,x-api-key,x-goog-api-key,anthropic-version,anthropic-beta",
    )?;
    headers.set(
        "Access-Control-Allow-Methods",
        "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    )?;
    Ok(())
}

fn set_feature(status: &mut cinatoken_core::StatusResponse, name: &'static str, enabled: bool) {
    if let Some(feature) = status
        .features
        .iter_mut()
        .find(|feature| feature.name == name)
    {
        feature.enabled = enabled;
    }
}

#[allow(dead_code)]
fn is_supported_preflight(method: &Method) -> bool {
    *method == Method::Options
}
