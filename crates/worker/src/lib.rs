mod admin;
mod admin_2fa;
mod admin_affinity;
mod admin_channel;
mod admin_codex_channel;
mod admin_crud;
mod admin_data;
mod admin_oauth;
mod admin_ollama;
mod admin_payment;
mod admin_user;
mod affinity;
mod cache;
mod cache_invalidation;
mod channel_upstream_update;
mod d1_repositories;
// Foundational mutable-flow-state substrate (item 2.1). Its consumers
// (secure-verification step-up, Turnstile, OAuth/2FA/passkey) land in following
// increments; allow dead_code until the first one is wired.
#[allow(dead_code)]
mod flow_state;
mod relay;
// Provider-independent task lifecycle persistence + CAS settlement guard (item
// 4.2). Foundation ahead of the task orchestration that consumes it; the module
// allows dead_code internally until then.
mod task_repository;
// Worker-side task polling I/O (executes the pure poll requests + threads bytes
// into the parser/settle-apply). Foundation ahead of its routes/trigger.
mod task_orchestration;
// Midjourney subsystem persistence (separate `midjourneys` table). Foundation
// ahead of the mj submit/poll wiring.
mod mj_repository;
mod model_meta_api;
mod operations;
mod prefill_group_api;
mod pricing_api;
mod turnstile;

use worker::{event, Context, Env, MessageBatch, Method, Request, Response, Result, Router};

use cinatoken_storage::AuditLogEvent;
use worker::D1Type;

/// Re-export the i64→i32 clamp helper for the queue consumer's D1 binding.
use cinatoken_relay::clamp_i64_to_i32 as d1_i32;

#[event(fetch)]
pub async fn fetch(req: Request, env: Env, ctx: Context) -> Result<Response> {
    console_error_panic_hook::set_once();

    // Resolve the credentialed CORS origin once, before `req`/`env` are moved
    // into the route handlers. Allowlisted browser Origins get a credentialed
    // echo; everything else keeps the permissive non-credentialed wildcard.
    let cors_allow_origin = {
        let configured = env.var("CORS_ORIGINS").map(|value| value.to_string()).ok();
        let request_origin = req.headers().get("Origin").ok().flatten();
        resolve_cors_allow_origin(configured.as_deref(), request_origin.as_deref())
    };

    if req.method() == Method::Options {
        let mut response = empty_cors_response()?;
        upgrade_cors_for_origin(&mut response, cors_allow_origin.as_deref());
        return Ok(response);
    }

    if req.method() == Method::Post {
        if let Some(route) = cinatoken_relay::parse_gemini_native_path(&req.path()) {
            let mut response = relay::gemini_native(req, env, ctx, route).await?;
            upgrade_cors_for_origin(&mut response, cors_allow_origin.as_deref());
            return Ok(response);
        }
    }

    // Admin/frontend static assets: when the ASSETS binding is configured
    // (see wrangler.toml `[assets]`), non-API paths fall through to it so the
    // React SPA's client-side routes (`/dashboard`, `/channels`, `/keys`,
    // `/sign-in`, ...) survive hard refreshes. Cloudflare's `single-page-
    // application` not_found_handling takes care of serving index.html for
    // unknown paths. API paths (/api, /v1, /v1beta, /mj, /suno) never reach
    // the asset binding and are always handled by the Router below.
    let path = req.path();
    if is_static_asset_path(&path) {
        if let Ok(assets) = env.assets("ASSETS") {
            return assets.fetch_request(req).await;
        }
        // No assets binding configured (local dev without a built frontend) —
        // fall through to the Router, which will 404 the unknown path. This
        // keeps `cargo test` / wasm check working without a built frontend.
    }

    let response = Router::with_data(ctx)
        .get_async("/api/status", |req, ctx| async move {
            admin::get_status(req, ctx.env).await
        })
        .get("/v1/models", |_, _| {
            json_with_status(&cinatoken_api::models(), 200)
        })
        // Admin / frontend auth surface (G5 foundation).
        .get_async("/api/setup", |req, ctx| async move {
            admin::get_setup_handler(req, ctx.env).await
        })
        .post_async("/api/setup", |req, ctx| async move {
            admin::post_setup_handler(req, ctx.env).await
        })
        // Public info strings (Go misc.go: OptionMap-backed).
        .get_async("/api/notice", |req, ctx| async move {
            admin::get_notice(req, ctx.env).await
        })
        .get_async("/api/about", |req, ctx| async move {
            admin::get_about(req, ctx.env).await
        })
        .get_async("/api/home_page_content", |req, ctx| async move {
            admin::get_home_page_content(req, ctx.env).await
        })
        // Exposed ratio config (Go GetRatioConfig; gated by ExposeRatioEnabled).
        .get_async("/api/ratio_config", |req, ctx| async move {
            admin_user::get_ratio_config(req, ctx.env).await
        })
        // Public pricing table (Go GetPricing; abilities x ratio maps + 0008
        // model/vendor metadata).
        .get_async("/api/pricing", |req, ctx| async move {
            pricing_api::get_pricing(req, ctx.env).await
        })
        .get_async("/api/uptime/status", |req, ctx| async move {
            operations::uptime_status(req, ctx.env).await
        })
        .get_async("/api/perf-metrics/summary", |req, ctx| async move {
            operations::perf_metrics_summary(req, ctx.env).await
        })
        .get_async("/api/perf-metrics", |req, ctx| async move {
            operations::perf_metrics(req, ctx.env).await
        })
        // Legal text (Go misc.go).
        .get_async("/api/user-agreement", |req, ctx| async move {
            admin::get_user_agreement(req, ctx.env).await
        })
        .get_async("/api/privacy-policy", |req, ctx| async move {
            admin::get_privacy_policy(req, ctx.env).await
        })
        .get_async("/api/midjourney", |req, ctx| async move {
            admin::get_midjourney(req, ctx.env).await
        })
        .post_async("/api/user/login", |req, ctx| async move {
            admin::login_handler(req, ctx.env).await
        })
        // Public self-registration (Go `controller.Register`): option-gated,
        // creates a common user; does not auto-login.
        .post_async("/api/user/register", |req, ctx| async move {
            admin_user::register(req, ctx.env).await
        })
        // Two-step login second factor (item 4.6): complete a 2FA-gated login.
        .post_async("/api/user/login/2fa", |req, ctx| async move {
            admin::login_2fa(req, ctx.env).await
        })
        // OAuth login (item 4.6): CSRF state + GitHub callback.
        .get_async("/api/oauth/state", |req, ctx| async move {
            admin_oauth::oauth_state(req, ctx.env).await
        })
        .get_async("/api/oauth/github", |req, ctx| async move {
            admin_oauth::github_oauth(req, ctx.env).await
        })
        .get_async("/api/oauth/oidc", |req, ctx| async move {
            admin_oauth::oidc_oauth(req, ctx.env).await
        })
        .get_async("/api/oauth/discord", |req, ctx| async move {
            admin_oauth::discord_oauth(req, ctx.env).await
        })
        .post_async("/api/user/logout", |req, ctx| async move {
            admin::logout_handler(req, ctx.env).await
        })
        .get_async("/api/user/self", |req, ctx| async move {
            admin::self_handler(req, ctx.env).await
        })
        // Self-service account endpoints (Go user.go self-routes).
        .put_async("/api/user/self", |req, ctx| async move {
            admin_user::update_self(req, ctx.env).await
        })
        .delete_async("/api/user/self", |req, ctx| async move {
            admin_user::delete_self(req, ctx.env).await
        })
        .get_async("/api/user/aff", |req, ctx| async move {
            admin_user::get_aff_code(req, ctx.env).await
        })
        .post_async("/api/user/aff_transfer", |req, ctx| async move {
            admin_user::transfer_aff_quota(req, ctx.env).await
        })
        .get_async("/api/user/token", |req, ctx| async move {
            admin_user::generate_access_token(req, ctx.env).await
        })
        // Usable groups (Go GetUserGroups): self (auth) + public variants.
        .get_async("/api/user/self/groups", |req, ctx| async move {
            admin_user::get_self_groups(req, ctx.env).await
        })
        .get_async("/api/user/groups", |req, ctx| async move {
            admin_user::get_public_groups(req, ctx.env).await
        })
        .get_async("/api/user/models", |req, ctx| async move {
            admin_user::get_self_models(req, ctx.env).await
        })
        // Admin forms use both spellings; keep the slashless alias because the
        // default frontend also reuses this endpoint from subscription views.
        .get_async("/api/group", |req, ctx| async move {
            admin_user::get_groups(req, ctx.env).await
        })
        .get_async("/api/group/", |req, ctx| async move {
            admin_user::get_groups(req, ctx.env).await
        })
        // Notification preferences (Go UpdateUserSetting).
        .put_async("/api/user/setting", |req, ctx| async move {
            admin_user::update_user_setting(req, ctx.env).await
        })
        // Secure-verification step-up (item 2.3): re-auth -> 300s flow-state
        // marker gating sensitive operations (credential reveal).
        .post_async("/api/verify", |req, ctx| async move {
            admin::secure_verify_handler(req, ctx.env).await
        })
        // 2FA enrollment (item 4.6).
        .post_async("/api/user/2fa/setup", |req, ctx| async move {
            admin_2fa::setup(req, ctx.env).await
        })
        .post_async("/api/user/2fa/confirm", |req, ctx| async move {
            admin_2fa::confirm(req, ctx.env).await
        })
        .post_async("/api/user/2fa/enable", |req, ctx| async move {
            admin_2fa::confirm(req, ctx.env).await
        })
        .get_async("/api/user/2fa/status", |req, ctx| async move {
            admin_2fa::status(req, ctx.env).await
        })
        .post_async("/api/user/2fa/disable", |req, ctx| async move {
            admin_2fa::disable(req, ctx.env).await
        })
        .post_async("/api/user/2fa/backup-codes", |req, ctx| async move {
            admin_2fa::regenerate_backup_codes(req, ctx.env).await
        })
        .post_async("/api/user/2fa/backup_codes", |req, ctx| async move {
            admin_2fa::regenerate_backup_codes_with_code(req, ctx.env).await
        })
        // Admin CRUD (G5 P0): logs, options, tokens.
        // Logs.
        .get_async("/api/log/", |req, ctx| async move {
            admin_crud::list_all_logs(req, ctx.env).await
        })
        .get_async("/api/log/stat", |req, ctx| async move {
            admin_crud::logs_stat(req, ctx.env).await
        })
        .delete_async("/api/log/", |req, ctx| async move {
            admin_crud::delete_history_logs(req, ctx.env).await
        })
        .get_async("/api/log/search", |req, ctx| async move {
            admin_crud::deprecated_log_search(req, ctx.env).await
        })
        .get_async("/api/log/self", |req, ctx| async move {
            admin_crud::list_self_logs(req, ctx.env).await
        })
        .get_async("/api/log/self/stat", |req, ctx| async move {
            admin_crud::self_logs_stat(req, ctx.env).await
        })
        .get_async("/api/log/self/search", |req, ctx| async move {
            admin_crud::deprecated_log_search(req, ctx.env).await
        })
        .get_async(
            "/api/log/channel_affinity_usage_cache",
            |req, ctx| async move { admin_affinity::get_usage_cache_stats(req, ctx.env).await },
        )
        // Options (root-only).
        .get_async("/api/option/", |req, ctx| async move {
            admin_crud::list_options(req, ctx.env).await
        })
        .put_async("/api/option/", |req, ctx| async move {
            admin_crud::update_option(req, ctx.env).await
        })
        .get_async(
            "/api/option/channel_affinity_cache",
            |req, ctx| async move { admin_affinity::get_cache_stats(req, ctx.env).await },
        )
        .delete_async(
            "/api/option/channel_affinity_cache",
            |req, ctx| async move { admin_affinity::clear_cache(req, ctx.env).await },
        )
        .post_async("/api/option/rest_model_ratio", |req, ctx| async move {
            admin_crud::reset_model_ratio(req, ctx.env).await
        })
        .post_async("/api/option/payment_compliance", |req, ctx| async move {
            admin_crud::confirm_payment_compliance(req, ctx.env).await
        })
        // Worker-native operational compatibility. Local disk/GC actions are
        // explicit no-ops; Uptime and perf metrics above are real read paths.
        .get_async("/api/performance/stats", |req, ctx| async move {
            operations::performance_stats(req, ctx.env).await
        })
        .delete_async("/api/performance/disk_cache", |req, ctx| async move {
            operations::clear_disk_cache(req, ctx.env).await
        })
        .post_async("/api/performance/reset_stats", |req, ctx| async move {
            operations::reset_performance_stats(req, ctx.env).await
        })
        .post_async("/api/performance/gc", |req, ctx| async move {
            operations::force_gc(req, ctx.env).await
        })
        .get_async("/api/performance/logs", |req, ctx| async move {
            operations::log_files(req, ctx.env).await
        })
        .delete_async("/api/performance/logs", |req, ctx| async move {
            operations::cleanup_log_files(req, ctx.env).await
        })
        // Tokens (user-scoped).
        .get_async("/api/token/", |req, ctx| async move {
            admin_crud::list_tokens(req, ctx.env).await
        })
        .get_async("/api/token/search", |req, ctx| async move {
            admin_crud::search_tokens(req, ctx.env).await
        })
        .post_async("/api/token/", |req, ctx| async move {
            admin_crud::create_token(req, ctx.env).await
        })
        .put_async("/api/token/", |req, ctx| async move {
            admin_crud::update_token(req, ctx.env).await
        })
        .post_async("/api/token/batch/keys", |req, ctx| async move {
            admin_crud::reveal_token_keys_batch(req, ctx.env).await
        })
        .get_async("/api/token/:id", |req, ctx| async move {
            let id = ctx.param("id").cloned();
            admin_crud::get_token(req, ctx.env, id.as_ref()).await
        })
        .post_async("/api/token/:id/key", |req, ctx| async move {
            let id = ctx.param("id").cloned();
            admin_crud::reveal_token_key(req, ctx.env, id.as_ref()).await
        })
        .delete_async("/api/token/:id", |req, ctx| async move {
            let id = ctx.param("id").cloned();
            admin_crud::delete_token(req, ctx.env, id.as_ref()).await
        })
        .post_async("/api/token/batch", |req, ctx| async move {
            admin_crud::delete_tokens_batch(req, ctx.env).await
        })
        // Dashboard data endpoints (quota trends + token usage).
        .get_async("/api/data/", |req, ctx| async move {
            admin_data::quota_trend_by_model(req, ctx.env).await
        })
        .get_async("/api/data/self", |req, ctx| async move {
            admin_data::quota_trend_self(req, ctx.env).await
        })
        .get_async("/api/data/users", |req, ctx| async move {
            admin_data::quota_trend_by_user(req, ctx.env).await
        })
        // OpenAI-compatible billing views (Go billing.go; token Bearer auth).
        .get_async("/dashboard/billing/subscription", |req, ctx| async move {
            admin_data::billing_subscription(req, ctx.env).await
        })
        .get_async(
            "/v1/dashboard/billing/subscription",
            |req, ctx| async move { admin_data::billing_subscription(req, ctx.env).await },
        )
        .get_async("/dashboard/billing/usage", |req, ctx| async move {
            admin_data::billing_usage(req, ctx.env).await
        })
        .get_async("/v1/dashboard/billing/usage", |req, ctx| async move {
            admin_data::billing_usage(req, ctx.env).await
        })
        .get_async("/api/usage/token/", |req, ctx| async move {
            admin_data::token_usage(req, ctx.env).await
        })
        // Stripe payment (Scenario C MVP).
        .post_async("/api/user/stripe/pay", |req, ctx| async move {
            admin_payment::stripe_pay(req, ctx.env).await
        })
        .post_async("/api/stripe/webhook", |req, ctx| async move {
            admin_payment::stripe_webhook(req, ctx.env).await
        })
        .get_async("/api/user/topup", |req, ctx| async move {
            admin_payment::list_topups(req, ctx.env).await
        })
        // Channels (admin, Tier 1 CRUD).
        .get_async("/api/channel/", |req, ctx| async move {
            admin_channel::list_channels(req, ctx.env).await
        })
        .get_async("/api/channel/search", |req, ctx| async move {
            admin_channel::search_channels(req, ctx.env).await
        })
        .get_async("/api/channel/models_enabled", |req, ctx| async move {
            admin_channel::enabled_list_models(req, ctx.env).await
        })
        .get_async("/api/channel/update_balance/:id", |req, ctx| async move {
            let id = ctx.param("id").cloned();
            admin_channel::update_channel_balance(req, ctx.env, id.as_ref()).await
        })
        .post_async("/api/channel/multi_key/manage", |req, ctx| async move {
            admin_channel::manage_multi_keys(req, ctx.env).await
        })
        .post_async(
            "/api/channel/upstream_updates/detect",
            |req, ctx| async move { channel_upstream_update::detect(req, ctx.env).await },
        )
        .post_async(
            "/api/channel/upstream_updates/detect_all",
            |req, ctx| async move { channel_upstream_update::detect_all(req, ctx.env).await },
        )
        .post_async(
            "/api/channel/upstream_updates/apply",
            |req, ctx| async move { channel_upstream_update::apply(req, ctx.env).await },
        )
        .post_async(
            "/api/channel/upstream_updates/apply_all",
            |req, ctx| async move { channel_upstream_update::apply_all(req, ctx.env).await },
        )
        .get_async("/api/channel/ollama/version/:id", |req, ctx| async move {
            let id = ctx.param("id").cloned();
            admin_ollama::version(req, ctx.env, id.as_ref()).await
        })
        .delete_async("/api/channel/ollama/delete", |req, ctx| async move {
            admin_ollama::delete_model(req, ctx.env).await
        })
        .post_async("/api/channel/ollama/pull/stream", |req, ctx| async move {
            admin_ollama::pull_model_stream(req, ctx.env).await
        })
        // Channel tag bulk ops (Go DisableTagChannels / EnableTagChannels /
        // DeleteDisabledChannel).
        .post_async("/api/channel/tag/disabled", |req, ctx| async move {
            admin_channel::disable_tag_channels(req, ctx.env).await
        })
        .post_async("/api/channel/tag/enabled", |req, ctx| async move {
            admin_channel::enable_tag_channels(req, ctx.env).await
        })
        .put_async("/api/channel/tag", |req, ctx| async move {
            admin_channel::edit_tag_channels(req, ctx.env).await
        })
        .get_async("/api/channel/tag/models", |req, ctx| async move {
            admin_channel::get_tag_models(req, ctx.env).await
        })
        // Channel connectivity ops (use the channel's own stored key).
        .get_async("/api/channel/test/:id", |req, ctx| async move {
            let id = ctx.param("id").cloned();
            admin_channel::test_channel(req, ctx.env, id.as_ref()).await
        })
        .get_async("/api/channel/fetch_models/:id", |req, ctx| async move {
            let id = ctx.param("id").cloned();
            admin_channel::fetch_upstream_models(req, ctx.env, id.as_ref()).await
        })
        .post_async("/api/channel/fetch_models", |req, ctx| async move {
            admin_channel::fetch_models_probe(req, ctx.env).await
        })
        // Model metadata + vendor CRUD (Go /api/models/* + /api/vendors/*,
        // AdminAuth; backs the 0008 tables the pricing endpoint reads).
        .get_async("/api/models/", |req, ctx| async move {
            model_meta_api::list_models_meta(req, ctx.env).await
        })
        .get_async("/api/models/search", |req, ctx| async move {
            model_meta_api::list_models_meta(req, ctx.env).await
        })
        .get_async("/api/models/missing", |req, ctx| async move {
            model_meta_api::get_missing_models(req, ctx.env).await
        })
        .get_async("/api/models/sync_upstream/preview", |req, ctx| async move {
            model_meta_api::preview_upstream_models(req, ctx.env).await
        })
        .post_async("/api/models/sync_upstream", |req, ctx| async move {
            model_meta_api::sync_upstream_models(req, ctx.env).await
        })
        .get_async("/api/models/:id", |req, ctx| async move {
            let id = ctx.param("id").cloned();
            model_meta_api::get_model_meta(req, ctx.env, id.as_ref()).await
        })
        .post_async("/api/models/", |req, ctx| async move {
            model_meta_api::create_model_meta(req, ctx.env).await
        })
        .put_async("/api/models/", |req, ctx| async move {
            model_meta_api::update_model_meta(req, ctx.env).await
        })
        .delete_async("/api/models/:id", |req, ctx| async move {
            let id = ctx.param("id").cloned();
            model_meta_api::delete_model_meta(req, ctx.env, id.as_ref()).await
        })
        .get_async("/api/vendors/", |req, ctx| async move {
            model_meta_api::list_vendors(req, ctx.env).await
        })
        .get_async("/api/vendors/search", |req, ctx| async move {
            model_meta_api::list_vendors(req, ctx.env).await
        })
        .get_async("/api/vendors/:id", |req, ctx| async move {
            let id = ctx.param("id").cloned();
            model_meta_api::get_vendor(req, ctx.env, id.as_ref()).await
        })
        .post_async("/api/vendors/", |req, ctx| async move {
            model_meta_api::create_vendor(req, ctx.env).await
        })
        .put_async("/api/vendors/", |req, ctx| async move {
            model_meta_api::update_vendor(req, ctx.env).await
        })
        .delete_async("/api/vendors/:id", |req, ctx| async move {
            let id = ctx.param("id").cloned();
            model_meta_api::delete_vendor(req, ctx.env, id.as_ref()).await
        })
        .get_async("/api/prefill_group", |req, ctx| async move {
            prefill_group_api::get_prefill_groups(req, ctx.env).await
        })
        .post_async("/api/prefill_group", |req, ctx| async move {
            prefill_group_api::create_prefill_group(req, ctx.env).await
        })
        .put_async("/api/prefill_group", |req, ctx| async move {
            prefill_group_api::update_prefill_group(req, ctx.env).await
        })
        .delete_async("/api/prefill_group/:id", |req, ctx| async move {
            let id = ctx.param("id").cloned();
            prefill_group_api::delete_prefill_group(req, ctx.env, id.as_ref()).await
        })
        .delete_async("/api/channel/disabled", |req, ctx| async move {
            admin_channel::delete_disabled_channels(req, ctx.env).await
        })
        .post_async("/api/channel/", |req, ctx| async move {
            admin_channel::create_channel(req, ctx.env).await
        })
        .put_async("/api/channel/", |req, ctx| async move {
            admin_channel::update_channel(req, ctx.env).await
        })
        .post_async("/api/channel/batch", |req, ctx| async move {
            admin_channel::delete_channels_batch(req, ctx.env).await
        })
        .post_async("/api/channel/batch/tag", |req, ctx| async move {
            admin_channel::batch_set_channel_tag(req, ctx.env).await
        })
        .post_async("/api/channel/fix", |req, ctx| async move {
            admin_channel::fix_abilities(req, ctx.env).await
        })
        .get_async("/api/channel/:id/codex/usage", |req, ctx| async move {
            let id = ctx.param("id").cloned();
            admin_codex_channel::get_usage(req, ctx.env, id.as_ref()).await
        })
        .post_async("/api/channel/:id/codex/refresh", |req, ctx| async move {
            let id = ctx.param("id").cloned();
            admin_codex_channel::refresh_credential(req, ctx.env, id.as_ref()).await
        })
        .get_async("/api/channel/:id", |req, ctx| async move {
            let id = ctx.param("id").cloned();
            admin_channel::get_channel(req, ctx.env, id.as_ref()).await
        })
        // Channel-key reveal: admin + secure-verification step-up (item 2.3).
        .post_async("/api/channel/:id/key", |req, ctx| async move {
            let id = ctx.param("id").cloned();
            admin_channel::reveal_channel_key(req, ctx.env, id.as_ref()).await
        })
        .delete_async("/api/channel/:id", |req, ctx| async move {
            let id = ctx.param("id").cloned();
            admin_channel::delete_channel(req, ctx.env, id.as_ref()).await
        })
        // User admin (admin, with role-tier permission checks).
        .get_async("/api/user/", |req, ctx| async move {
            admin_user::list_users(req, ctx.env).await
        })
        .get_async("/api/user/search", |req, ctx| async move {
            admin_user::search_users(req, ctx.env).await
        })
        .post_async("/api/user/", |req, ctx| async move {
            admin_user::create_user(req, ctx.env).await
        })
        .post_async("/api/user/manage", |req, ctx| async move {
            admin_user::manage_user(req, ctx.env).await
        })
        .put_async("/api/user/", |req, ctx| async move {
            admin_user::update_user(req, ctx.env).await
        })
        .get_async("/api/user/:id", |req, ctx| async move {
            let id = ctx.param("id").cloned();
            admin_user::get_user(req, ctx.env, id.as_ref()).await
        })
        // Admin account recovery: clear a target user's 2FA (item 4.6).
        .post_async("/api/user/:id/2fa/disable", |req, ctx| async move {
            let id = ctx.param("id").cloned();
            admin_user::admin_disable_2fa(req, ctx.env, id.as_ref()).await
        })
        .delete_async("/api/user/:id/2fa", |req, ctx| async move {
            let id = ctx.param("id").cloned();
            admin_user::admin_disable_2fa(req, ctx.env, id.as_ref()).await
        })
        .delete_async("/api/user/:id", |req, ctx| async move {
            let id = ctx.param("id").cloned();
            admin_user::delete_user(req, ctx.env, id.as_ref()).await
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
        // Async video task submit (item 4.x): authenticate → select channel →
        // price → reserve → submit upstream → insert SUBMITTED task. The cron
        // poller settles it. Runtime-verified by a staging submit.
        .post_async("/v1/video/generations", |req, ctx| async move {
            let env = ctx.env;
            let now = (worker::Date::now().as_millis() / 1000) as i64;
            task_orchestration::handle_task_submit(req, env, now).await
        })
        // Suno task submit (platform "suno"): POST /suno/submit/:action.
        // Client-facing async-task fetch (Go RelayTaskFetch): the owner's
        // stored TaskDto, kept current by the poller cron.
        .get_async("/v1/video/generations/:task_id", |req, ctx| async move {
            let task_id = ctx.param("task_id").cloned();
            task_orchestration::handle_task_fetch_by_id(req, ctx.env, task_id.as_ref()).await
        })
        .get_async("/suno/fetch/:id", |req, ctx| async move {
            let task_id = ctx.param("id").cloned();
            task_orchestration::handle_task_fetch_by_id(req, ctx.env, task_id.as_ref()).await
        })
        .post_async("/suno/fetch", |req, ctx| async move {
            task_orchestration::handle_task_fetch_batch(req, ctx.env).await
        })
        .post_async("/suno/submit/:action", |req, ctx| async move {
            let action = ctx.param("action").cloned().unwrap_or_default();
            let now = (worker::Date::now().as_millis() / 1000) as i64;
            task_orchestration::handle_suno_submit(req, ctx.env, &action, now).await
        })
        // Midjourney submit (mj subsystem): POST /mj/submit/:action.
        .post_async("/mj/submit/:action", |req, ctx| async move {
            let action = ctx.param("action").cloned().unwrap_or_default();
            let now = (worker::Date::now().as_millis() / 1000) as i64;
            task_orchestration::handle_mj_submit(req, ctx.env, &action, now).await
        })
        // Client-facing Midjourney task fetch (Go RelayMidjourneyTask).
        .get_async("/mj/task/:id/fetch", |req, ctx| async move {
            let mj_id = ctx.param("id").cloned();
            task_orchestration::handle_mj_task_fetch(req, ctx.env, mj_id.as_ref()).await
        })
        .post_async("/mj/task/list-by-condition", |req, ctx| async move {
            task_orchestration::handle_mj_task_list_by_condition(req, ctx.env).await
        })
        .post_async("/v1/responses", |req, ctx| async move {
            let env = ctx.env;
            let event_ctx = ctx.data;
            relay::responses(req, env, event_ctx).await
        })
        .post_async("/v1/responses/compact", |req, ctx| async move {
            let env = ctx.env;
            let event_ctx = ctx.data;
            relay::responses_compact(req, env, event_ctx).await
        })
        .post_async("/v1/moderations", |req, ctx| async move {
            let env = ctx.env;
            let event_ctx = ctx.data;
            relay::moderations(req, env, event_ctx).await
        })
        .post_async("/v1/edits", |req, ctx| async move {
            let env = ctx.env;
            let event_ctx = ctx.data;
            relay::edits(req, env, event_ctx).await
        })
        // Go relays these two in GEMINI format (PaLM-era legacy aliases on
        // /v1). The Rust Gemini-native relay covers the canonical /v1beta
        // surface; the legacy aliases answer a structured 501 rather than a
        // wrong-format relay.
        .post("/v1/engines/:model/embeddings", |_, _| {
            relay::relay_not_implemented()
        })
        // Go RelayNotImplemented surface: structured 501s instead of 404s.
        .post("/v1/images/variations", |_, _| {
            relay::relay_not_implemented()
        })
        .get("/v1/files", |_, _| relay::relay_not_implemented())
        .post("/v1/files", |_, _| relay::relay_not_implemented())
        .delete("/v1/files/:id", |_, _| relay::relay_not_implemented())
        .get("/v1/files/:id", |_, _| relay::relay_not_implemented())
        .get("/v1/files/:id/content", |_, _| {
            relay::relay_not_implemented()
        })
        .post("/v1/fine-tunes", |_, _| relay::relay_not_implemented())
        .get("/v1/fine-tunes", |_, _| relay::relay_not_implemented())
        .get("/v1/fine-tunes/:id", |_, _| relay::relay_not_implemented())
        .post("/v1/fine-tunes/:id/cancel", |_, _| {
            relay::relay_not_implemented()
        })
        .get("/v1/fine-tunes/:id/events", |_, _| {
            relay::relay_not_implemented()
        })
        .delete("/v1/models/:model", |_, _| relay::relay_not_implemented())
        .post_async("/v1/messages", |req, ctx| async move {
            let env = ctx.env;
            let event_ctx = ctx.data;
            relay::anthropic_messages(req, env, event_ctx).await
        })
        .post_async("/v1/embeddings", |req, ctx| async move {
            let env = ctx.env;
            let event_ctx = ctx.data;
            relay::embeddings(req, env, event_ctx).await
        })
        .post_async("/v1/rerank", |req, ctx| async move {
            let env = ctx.env;
            let event_ctx = ctx.data;
            relay::rerank(req, env, event_ctx).await
        })
        .post_async("/v1/images/generations", |req, ctx| async move {
            let env = ctx.env;
            let event_ctx = ctx.data;
            relay::image_generations(req, env, event_ctx).await
        })
        .post_async("/v1/audio/speech", |req, ctx| async move {
            let env = ctx.env;
            let event_ctx = ctx.data;
            relay::audio_speech(req, env, event_ctx).await
        })
        .post_async("/v1/audio/transcriptions", |req, ctx| async move {
            let env = ctx.env;
            let event_ctx = ctx.data;
            relay::audio_transcriptions(req, env, event_ctx).await
        })
        .post_async("/v1/audio/translations", |req, ctx| async move {
            let env = ctx.env;
            let event_ctx = ctx.data;
            relay::audio_translations(req, env, event_ctx).await
        })
        .post_async("/v1/images/edits", |req, ctx| async move {
            let env = ctx.env;
            let event_ctx = ctx.data;
            relay::image_edits(req, env, event_ctx).await
        })
        .run(req, env)
        .await;
    let mut response = response?;
    upgrade_cors_for_origin(&mut response, cors_allow_origin.as_deref());
    Ok(response)
}

/// LOG_QUEUE consumer: drains relay audit events in batches and bulk-INSERTs
/// them into D1 in a single round-trip. The producer (relay path) sends
/// [`AuditLogEvent`] messages via `env.queue("LOG_QUEUE").send(...)`;
/// Cloudflare groups up to `max_batch_size` (100) messages or flushes every
/// `max_batch_timeout` (5s), whichever comes first.
///
/// On D1 batch failure, the entire batch is retried (`retry_all`); after
/// `max_retries` (3) attempts Cloudflare routes surviving messages to the
/// dead-letter queue for manual inspection.
/// Cron-triggered task poller. Drives one batch of `poll_unfinished_tasks`
/// (query unfinished tasks → poll each provider → CAS-settle). Inert until a
/// `[triggers] crons` schedule is configured in wrangler.toml and async tasks
/// exist to poll, so shipping the handler is safe ahead of the submit flow.
#[event(scheduled)]
pub async fn scheduled(_event: worker::ScheduledEvent, env: Env, _ctx: worker::ScheduleContext) {
    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(err) => {
            worker::console_error!("task poller: D1 binding unavailable: {err}");
            return;
        }
    };
    let gemini_version = env
        .var("GEMINI_VERSION")
        .map(|value| value.to_string())
        .unwrap_or_else(|_| "v1beta".to_string());
    let now = (worker::Date::now().as_millis() / 1000) as i64;
    match task_orchestration::poll_unfinished_tasks(&db, &gemini_version, now, 100).await {
        Ok(settled) => worker::console_log!("task poller: settled {settled} video task(s)"),
        Err(err) => worker::console_error!("task poller: video batch failed: {err}"),
    }
    match task_orchestration::poll_unfinished_suno_tasks(&db, now, 100).await {
        Ok(settled) => worker::console_log!("task poller: settled {settled} suno task(s)"),
        Err(err) => worker::console_error!("task poller: suno batch failed: {err}"),
    }
    match task_orchestration::poll_unfinished_midjourney_tasks(&db, now, 100).await {
        Ok(settled) => worker::console_log!("task poller: settled {settled} mj task(s)"),
        Err(err) => worker::console_error!("task poller: mj batch failed: {err}"),
    }
}

#[event(queue)]
pub async fn queue(
    message_batch: MessageBatch<AuditLogEvent>,
    env: Env,
    _ctx: Context,
) -> Result<()> {
    let messages = match message_batch.messages() {
        Ok(messages) => messages,
        Err(err) => {
            worker::console_error!("LOG_QUEUE: failed to deserialize batch: {err}");
            message_batch.retry_all();
            return Ok(());
        }
    };
    if messages.is_empty() {
        return Ok(());
    }

    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(err) => {
            worker::console_error!("LOG_QUEUE: D1 binding unavailable: {err}");
            message_batch.retry_all();
            return Ok(());
        }
    };

    // Prepare the INSERT once, bind each event's columns, and execute all
    // statements in a single D1 batch round-trip.
    let stmt = db.prepare(
        r#"
        INSERT INTO logs (
          user_id, created_at, type, content, username, token_name, model_name,
          quota, prompt_tokens, completion_tokens, use_time, is_stream,
          channel_id, token_id, "group", ip, request_id, upstream_request_id, other
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19
        )
        "#,
    );

    let mut stmts = Vec::with_capacity(messages.len());
    for msg in &messages {
        let event = msg.body();
        let args = [
            D1Type::Integer(d1_i32(event.user_id)),
            D1Type::Integer(d1_i32(event.created_at)),
            D1Type::Integer(event.log_type),
            D1Type::Text(&event.content),
            D1Type::Text(&event.username),
            D1Type::Text(&event.token_name),
            D1Type::Text(&event.model_name),
            D1Type::Integer(d1_i32(event.quota)),
            D1Type::Integer(event.prompt_tokens),
            D1Type::Integer(event.completion_tokens),
            D1Type::Integer(d1_i32(event.use_time)),
            D1Type::Integer(event.is_stream),
            D1Type::Integer(d1_i32(event.channel_id)),
            D1Type::Integer(d1_i32(event.token_id)),
            D1Type::Text(&event.group),
            D1Type::Text(&event.ip),
            D1Type::Text(&event.request_id),
            D1Type::Text(&event.upstream_request_id),
            D1Type::Text(&event.other),
        ];
        match stmt.bind_refs(&args) {
            Ok(bound) => stmts.push(bound),
            Err(err) => {
                worker::console_error!("LOG_QUEUE: failed to bind event: {err}");
            }
        }
    }

    if stmts.is_empty() {
        worker::console_warn!("LOG_QUEUE: no bindable events in batch, acking");
        message_batch.ack_all();
        return Ok(());
    }

    match db.batch(stmts).await {
        Ok(_) => {
            message_batch.ack_all();
            Ok(())
        }
        Err(err) => {
            worker::console_error!("LOG_QUEUE: D1 batch insert failed: {err}");
            message_batch.retry_all();
            Ok(())
        }
    }
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
    // Permissive default (no credentials) for Bearer/API and no-Origin clients.
    // For an allowlisted browser Origin this is upgraded to a credentialed echo
    // by `upgrade_cors_for_origin` in the global `fetch` pass — a credentialed
    // wildcard (`*` + Allow-Credentials) is never emitted.
    headers.set("Access-Control-Allow-Origin", "*")?;
    headers.set(
        "Access-Control-Allow-Headers",
        "authorization,content-type,x-api-key,x-goog-api-key,anthropic-version,anthropic-beta",
    )?;
    headers.set(
        "Access-Control-Allow-Methods",
        "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    )?;
    // Mirror Go `middleware.CORS` ExposeHeaders so browsers can read these on
    // cross-origin (esp. SSE) responses.
    headers.set(
        "Access-Control-Expose-Headers",
        "Content-Length,Cache-Control,X-Accel-Buffering,X-Request-Id",
    )?;
    Ok(())
}

/// Default CORS allowlist when `CORS_ORIGINS` is unset/empty — faithful to Go
/// `middleware.CORS` (production frontend + local dev server).
const DEFAULT_CORS_ORIGINS: &[&str] = &["https://app.cinatoken.com", "http://localhost:5173"];

/// Resolve the `Access-Control-Allow-Origin` to echo for a credentialed request,
/// faithful to Go `middleware.CORS`: the allowlist is `CORS_ORIGINS`
/// (comma-separated) or, when unset/empty, [`DEFAULT_CORS_ORIGINS`]. Returns the
/// request `Origin` when it is allowlisted (the caller echoes it and sets
/// `Allow-Credentials: true`), else `None` (keep the permissive non-credentialed
/// wildcard). `configured` is the raw `CORS_ORIGINS` value (split here so the
/// logic is host-testable without an `Env`).
fn resolve_cors_allow_origin(
    configured: Option<&str>,
    request_origin: Option<&str>,
) -> Option<String> {
    let origin = request_origin?.trim();
    if origin.is_empty() {
        return None;
    }
    let allowed = configured
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| DEFAULT_CORS_ORIGINS.to_vec());
    if allowed
        .iter()
        .any(|allowed_origin| *allowed_origin == origin)
    {
        Some(origin.to_string())
    } else {
        None
    }
}

/// Upgrade an already-built response's CORS headers to a credentialed echo when
/// the request `Origin` is allowlisted. No-op (keeps the non-credentialed
/// wildcard from [`set_cors_headers`]) otherwise. Errors are ignored: an
/// immutable-header response (e.g. a static asset) simply keeps its own headers.
fn upgrade_cors_for_origin(response: &mut Response, allow_origin: Option<&str>) {
    if let Some(origin) = allow_origin {
        let headers = response.headers_mut();
        let _ = headers.set("Access-Control-Allow-Origin", origin);
        let _ = headers.set("Access-Control-Allow-Credentials", "true");
        let _ = headers.set("Vary", "Origin");
    }
}

#[allow(dead_code)]
fn is_supported_preflight(method: &Method) -> bool {
    *method == Method::Options
}

/// Return `true` when `path` should be served by the static-asset binding
/// rather than the API router. The API prefixes mirror the route groups
/// declared by the Go gateway (`router/relay-router.go`, `router/api-router.go`,
/// `router/video-router.go`) so adding a new API group here is the only place
/// that needs to change when the API surface grows.
fn is_static_asset_path(path: &str) -> bool {
    let path = path.split('?').next().unwrap_or(path);
    for prefix in [
        "/api/",
        "/v1/",
        "/v1beta/",
        "/mj/",
        "/suno/",
        "/pg/",
        // OpenAI-compatible billing views (Go dashboard.go) — API, not the SPA
        // `/dashboard` route.
        "/dashboard/billing/",
    ] {
        if path.starts_with(prefix) {
            return false;
        }
    }
    // Exact-match API endpoints without a trailing slash (e.g. `/api/status`,
    // `/v1/models`) are also router-owned.
    !matches!(
        path,
        "/api/status"
            | "/api/setup"
            | "/v1/models"
            | "/v1/chat/completions"
            | "/v1/completions"
            | "/v1/responses"
            | "/v1/messages"
            | "/v1/embeddings"
            | "/v1/rerank"
            | "/v1/images/generations"
            | "/v1/audio/speech"
            | "/v1/audio/transcriptions"
            | "/v1/audio/translations"
            | "/v1/images/edits"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cors_allowlist_resolves_like_go() {
        // Default allowlist (CORS_ORIGINS unset): only the default origins echo.
        assert_eq!(
            resolve_cors_allow_origin(None, Some("https://app.cinatoken.com")).as_deref(),
            Some("https://app.cinatoken.com")
        );
        assert_eq!(
            resolve_cors_allow_origin(None, Some("http://localhost:5173")).as_deref(),
            Some("http://localhost:5173")
        );
        // A non-allowlisted Origin is denied (caller keeps the wildcard, no creds).
        assert_eq!(
            resolve_cors_allow_origin(None, Some("https://evil.example")),
            None
        );
        // Configured allowlist overrides the default; whitespace is trimmed.
        assert_eq!(
            resolve_cors_allow_origin(
                Some(" https://a.test , https://b.test "),
                Some("https://b.test")
            )
            .as_deref(),
            Some("https://b.test")
        );
        assert_eq!(
            resolve_cors_allow_origin(Some("https://a.test"), Some("https://app.cinatoken.com")),
            None // default no longer applies once CORS_ORIGINS is set
        );
        // Empty/absent Origin (non-browser/API client) -> no credentialed echo.
        assert_eq!(resolve_cors_allow_origin(None, None), None);
        assert_eq!(resolve_cors_allow_origin(None, Some("   ")), None);
        // Empty CORS_ORIGINS falls back to the default list.
        assert_eq!(
            resolve_cors_allow_origin(Some("  "), Some("https://app.cinatoken.com")).as_deref(),
            Some("https://app.cinatoken.com")
        );
    }

    #[test]
    fn static_asset_path_routes_known_admin_spa_routes_to_assets() {
        // Frontend SPA routes the React dashboard uses (TanStack Router paths
        // from web/default/src/routes).
        for path in [
            "/",
            "/dashboard",
            "/channels",
            "/keys",
            "/users",
            "/usage-logs",
            "/models",
            "/system-settings",
            "/profile",
            "/sign-in",
            "/setup",
            "/subscriptions",
            "/dashboard/usage",
            "/channels/123",
            "/assets/index.hash.js",
            "/favicon.ico",
            "/index.html",
        ] {
            assert!(
                is_static_asset_path(path),
                "{path:?} should fall through to static assets"
            );
        }
    }

    #[test]
    fn static_asset_path_routes_api_paths_to_router() {
        // API prefixes — must NOT be served by the static-asset binding or
        // they would be shadowed by index.html.
        for path in [
            "/api/status",
            "/api/setup",
            "/api/user/login",
            "/api/user/self",
            "/api/token/",
            "/api/channel/",
            "/api/log/",
            "/v1/models",
            "/v1/chat/completions",
            "/v1/completions",
            "/v1/responses",
            "/v1/messages",
            "/v1/embeddings",
            "/v1/rerank",
            "/v1/images/generations",
            "/v1/audio/speech",
            "/v1/audio/transcriptions",
            "/v1beta/models/gemini-2.0-flash:generateContent",
            "/mj/submit/imagine",
            "/suno/submit/music",
            "/pg/chat/completions",
        ] {
            assert!(
                !is_static_asset_path(path),
                "{path:?} should be handled by the API router"
            );
        }
    }

    #[test]
    fn static_asset_path_strips_query_string() {
        // The Gemini native route carries `?key=...&alt=sse`; query must not
        // break the path-based routing decision.
        assert!(!is_static_asset_path(
            "/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse"
        ));
        assert!(is_static_asset_path("/dashboard?section=usage"));
    }
}
