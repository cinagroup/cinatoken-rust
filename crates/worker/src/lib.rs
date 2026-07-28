#![recursion_limit = "256"]

mod admin;
mod admin_2fa;
mod admin_affinity;
mod admin_channel;
mod admin_checkin;
mod admin_codex_channel;
mod admin_crud;
mod admin_custom_oauth;
mod admin_data;
mod admin_deployments;
mod admin_email;
mod admin_oauth;
mod admin_ollama;
mod admin_passkey;
mod admin_payment;
mod admin_redemption;
mod admin_subscription;
mod admin_task_logs;
mod admin_user;
mod admin_wechat;
mod affinity;
mod cache;
mod cache_invalidation;
mod channel_upstream_update;
mod container_artifacts;
mod container_controller;
mod container_r2_inventory;
mod container_r2_inventory_admin;
mod container_reconciliation;
mod container_reconciliation_admin;
mod container_relay_canary;
mod container_scheduler;
mod container_shard_activation_admin;
mod container_shard_activation_campaign_admin;
mod container_shard_placement_admin;
mod container_shard_placement_authorization_admin;
#[allow(dead_code)]
pub(crate) mod container_shard_placement_mutation_authorization;
mod container_terminal_outbox;
mod container_terminal_outbox_admin;
mod d1_repositories;
// Foundational mutable-flow-state substrate (item 2.1). Its consumers
// (secure-verification step-up, Turnstile, OAuth/2FA/passkey) land in following
// increments; allow dead_code until the first one is wired.
#[allow(dead_code)]
mod flow_state;
mod relay;
mod relay_ai_gateway_policy;
mod relay_billing_queue;
mod relay_billing_reconcile;
mod relay_billing_smoke;
mod relay_http_stream_handoff;
// Provider-independent task lifecycle persistence + CAS settlement guard (item
// 4.2). Foundation ahead of the task orchestration that consumes it; the module
// allows dead_code internally until then.
mod task_billing_reconcile;
mod task_poll_recovery;
mod task_repository;
// Worker-side task polling I/O (executes the pure poll requests + threads bytes
// into the parser/settle-apply). Foundation ahead of its routes/trigger.
mod task_orchestration;
mod task_runner;
// Midjourney subsystem persistence (separate `midjourneys` table). Foundation
// ahead of the mj submit/poll wiring.
mod mj_repository;
mod model_meta_api;
mod operations;
mod passkey_ceremony;
mod platform_gateway;
mod prefill_group_api;
mod pricing_api;
mod quota_coordinator;
mod rankings_api;
mod ratio_sync;
mod realtime_billing_reconcile;
mod realtime_session;
mod turnstile;
mod webauthn;
mod wfp_authority_replay;
mod wfp_tenant;

use worker::{
    event, Context, Env, MessageBatch, MessageExt, Method, Request, Response, Result, Router,
};

use cinatoken_gateway::{plan_request, GatewayConfig, GatewayMethod, GatewayOwner, GatewayRequest};
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

    let method = if req.method() == Method::Options {
        GatewayMethod::Options
    } else if req.method() == Method::Post {
        GatewayMethod::Post
    } else {
        GatewayMethod::Other
    };
    let path = req.path();
    let gemini_route = (method == GatewayMethod::Post)
        .then(|| cinatoken_relay::parse_gemini_native_path(&path))
        .flatten();
    let preview_host_suffix =
        platform_gateway::runtime_value(&env, platform_gateway::WFP_PREVIEW_HOST_SUFFIX_ENV);
    let request_host = scheduling_gateway_request_host(&req)?;
    let plan = plan_request(
        GatewayRequest {
            method,
            path: &path,
            host: request_host.as_deref(),
            gemini_native_candidate: gemini_route.is_some(),
        },
        GatewayConfig {
            wfp_dispatch_enabled: platform_gateway::env_flag(
                &env,
                platform_gateway::WFP_DISPATCH_ENABLED_ENV,
            ),
            wfp_internal_dispatch_enabled: platform_gateway::env_flag(
                &env,
                platform_gateway::WFP_INTERNAL_DISPATCH_ENABLED_ENV,
            ),
            wfp_preview_host_suffix: preview_host_suffix.as_deref(),
            wfp_tenant_status_path: wfp_tenant::WFP_TENANT_STATUS_PATH,
        },
    );

    if plan.owner == GatewayOwner::CorsPreflight {
        let mut response = empty_cors_response()?;
        upgrade_cors_for_origin(&mut response, cors_allow_origin.as_deref());
        return Ok(response);
    }

    if plan.owner == GatewayOwner::GeminiNative {
        let Some(route) = gemini_route else {
            return scheduling_gateway_invariant_response("missing Gemini native route");
        };
        let mut response = relay::gemini_native(req, env, ctx, route).await?;
        upgrade_cors_for_origin(&mut response, cors_allow_origin.as_deref());
        return Ok(response);
    }

    if plan.owner == GatewayOwner::WfpDispatch {
        let Some(wfp_dispatch) = plan.wfp_dispatch.as_ref() else {
            return scheduling_gateway_invariant_response("missing WFP dispatch plan");
        };
        let target = platform_gateway::dispatch_target_for_plan(wfp_dispatch, &env)?;
        let mut response = platform_gateway::dispatch_request(req, env.clone(), target).await?;
        upgrade_cors_for_origin(&mut response, cors_allow_origin.as_deref());
        return Ok(response);
    }

    if plan.owner == GatewayOwner::WfpPreviewUnavailable {
        let mut response = platform_gateway::wfp_preview_unavailable_response()?;
        upgrade_cors_for_origin(&mut response, cors_allow_origin.as_deref());
        return Ok(response);
    }

    if plan.owner == GatewayOwner::RealtimeSession {
        let mut response = realtime_session::handle_gateway(req, env.clone()).await?;
        upgrade_cors_for_origin(&mut response, cors_allow_origin.as_deref());
        return Ok(response);
    }

    // Admin/frontend static assets: when the ASSETS binding is configured
    // (see wrangler.toml `[assets]`), non-API paths fall through to it so the
    // React SPA's client-side routes (`/dashboard`, `/channels`, `/keys`,
    // `/sign-in`, ...) survive hard refreshes. Cloudflare's `single-page-
    // application` not_found_handling takes care of serving index.html for
    // unknown paths. API paths (/api, /v1, /v1beta, /mj, /suno) never reach
    // the asset binding and are always handled by the Router below.
    if plan.owner == GatewayOwner::StaticAssets {
        if let Ok(assets) = env.assets("ASSETS") {
            return assets.fetch_request(req).await;
        }
        // No assets binding configured (local dev without a built frontend) —
        // fall through to the Router, which will 404 the unknown path. This
        // keeps `cargo test` / wasm check working without a built frontend.
    }

    if req.method() == Method::Get && path == "/api/platform/relay-billing/ledger/status" {
        let mut response = platform_gateway::relay_billing_ledger_status(req, env).await?;
        upgrade_cors_for_origin(&mut response, cors_allow_origin.as_deref());
        return Ok(response);
    }

    let response = Router::with_data(ctx)
        .get_async("/api/status", |req, ctx| async move {
            admin::get_status(req, ctx.env).await
        })
        .get_async("/api/platform/capabilities", |req, ctx| async move {
            platform_gateway::capabilities(req, ctx.env).await
        })
        .get_async(
            "/api/platform/container/shards/activations",
            |req, ctx| async move { container_shard_activation_admin::list(req, ctx.env).await },
        )
        .get_async(
            "/api/platform/container/shards/placements",
            |req, ctx| async move { container_shard_placement_admin::list(req, ctx.env).await },
        )
        .get_async(
            "/api/platform/container/shards/placement-mutation-authorizations",
            |req, ctx| async move {
                container_shard_placement_authorization_admin::get(req, ctx.env).await
            },
        )
        .get_async(
            "/api/platform/container/shards/activation-campaigns",
            |req, ctx| async move {
                container_shard_activation_campaign_admin::status(req, ctx.env).await
            },
        )
        .post_async(
            "/api/platform/container/shards/activation-campaigns",
            |req, ctx| async move {
                container_shard_activation_campaign_admin::create(req, ctx.env).await
            },
        )
        .post_async(
            "/api/platform/container/shards/readiness",
            |req, ctx| async move {
                platform_gateway::container_shard_readiness(req, ctx.env).await
            },
        )
        .get_async(
            "/api/platform/container/reconciliation/status",
            |req, ctx| async move {
                container_reconciliation_admin::status(req, ctx.env).await
            },
        )
        .get_async(
            "/api/platform/container/terminal-outbox/status",
            |req, ctx| async move { container_terminal_outbox_admin::status(req, ctx.env).await },
        )
        .get_async(
            "/api/platform/container/reconciliations",
            |req, ctx| async move {
                container_reconciliation_admin::list(req, ctx.env).await
            },
        )
        .post_async(
            "/api/platform/container/reconciliations/:target/retry/preview",
            |req, ctx| async move {
                let target = ctx.param("target").cloned();
                container_reconciliation_admin::retry_preview(req, ctx.env, target).await
            },
        )
        .post_async(
            "/api/platform/container/reconciliations/:target/retry/apply",
            |req, ctx| async move {
                let target = ctx.param("target").cloned();
                container_reconciliation_admin::retry_apply(req, ctx.env, target).await
            },
        )
        .get_async(
            "/api/platform/container/r2-inventory/status",
            |req, ctx| async move { container_r2_inventory_admin::status(req, ctx.env).await },
        )
        .get_async(
            "/api/platform/container/r2-inventory/findings",
            |req, ctx| async move { container_r2_inventory_admin::list(req, ctx.env).await },
        )
        .post_async(
            "/api/platform/quota-coordinator/reconciliation",
            |req, ctx| async move {
                quota_coordinator::quota_coordinator_reconciliation(req, ctx.env).await
            },
        )
        .get_async(
            "/api/platform/task-billing/reconciliations",
            |req, ctx| async move { task_billing_reconcile::list(req, ctx.env).await },
        )
        .post_async(
            "/api/platform/task-billing/reconciliations/:reconciliation_id/preview",
            |req, ctx| async move {
                let reconciliation_id = ctx.param("reconciliation_id").cloned();
                task_billing_reconcile::preview(req, ctx.env, reconciliation_id).await
            },
        )
        .post_async(
            "/api/platform/task-billing/reconciliations/:reconciliation_id/apply",
            |req, ctx| async move {
                let reconciliation_id = ctx.param("reconciliation_id").cloned();
                task_billing_reconcile::apply(req, ctx.env, reconciliation_id).await
            },
        )
        .get_async(
            "/api/platform/task-poll/quarantines",
            |req, ctx| async move { task_poll_recovery::list(req, ctx.env).await },
        )
        .post_async(
            "/api/platform/task-poll/quarantines/:entity_kind/:entity_id/preview",
            |req, ctx| async move {
                let entity_kind = ctx.param("entity_kind").cloned();
                let entity_id = ctx.param("entity_id").cloned();
                task_poll_recovery::preview(req, ctx.env, entity_kind, entity_id).await
            },
        )
        .post_async(
            "/api/platform/task-poll/quarantines/:entity_kind/:entity_id/apply",
            |req, ctx| async move {
                let entity_kind = ctx.param("entity_kind").cloned();
                let entity_id = ctx.param("entity_id").cloned();
                task_poll_recovery::apply(req, ctx.env, entity_kind, entity_id).await
            },
        )
        .get_async(
            "/api/platform/relay/billing-finalization/incidents",
            |req, ctx| async move { relay_billing_reconcile::list_incidents(req, ctx.env).await },
        )
        .post_async(
            "/api/platform/relay/billing-finalization/incidents/:incident_id/replay",
            |req, ctx| async move {
                let incident_id = ctx.param("incident_id").cloned();
                relay_billing_reconcile::replay_incident(req, ctx.env, incident_id).await
            },
        )
        .get_async(
            "/api/platform/realtime-billing/ledger/status",
            |req, ctx| async move {
                platform_gateway::realtime_billing_ledger_status(req, ctx.env).await
            },
        )
        .get_async(
            "/api/platform/realtime-billing/reconciliations",
            |req, ctx| async move { realtime_billing_reconcile::list(req, ctx.env).await },
        )
        .post_async(
            "/api/platform/realtime-billing/reconciliations/:reconciliation_id/preview",
            |req, ctx| async move {
                let reconciliation_id = ctx.param("reconciliation_id").cloned();
                realtime_billing_reconcile::preview(req, ctx.env, reconciliation_id).await
            },
        )
        .post_async(
            "/api/platform/realtime-billing/reconciliations/:reconciliation_id/apply",
            |req, ctx| async move {
                let reconciliation_id = ctx.param("reconciliation_id").cloned();
                realtime_billing_reconcile::apply(req, ctx.env, reconciliation_id).await
            },
        )
        .get_async(
            "/api/platform/task-runner/:task_id/status",
            |req, ctx| async move {
                let task_id = ctx.param("task_id").cloned();
                platform_gateway::task_runner_status(req, ctx.env, task_id).await
            },
        )
        .post_async(
            "/api/platform/realtime/settlement-batch/smoke",
            |req, ctx| async move {
                platform_gateway::realtime_settlement_batch_smoke(req, ctx.env).await
            },
        )
        .post_async(
            "/api/platform/relay/actual-group-billing/smoke",
            |req, ctx| async move { relay_billing_smoke::handler(req, ctx.env).await },
        )
        .post_async(
            "/api/platform/wfp/tenant-script/plan",
            |req, ctx| async move { wfp_tenant::plan(req, ctx.env).await },
        )
        .post_async(
            "/api/platform/wfp/tenant-script/deploy",
            |req, ctx| async move { wfp_tenant::deploy(req, ctx.env).await },
        )
        .get_async("/v1/models", |req, ctx| async move {
            relay::list_models(req, ctx.env).await
        })
        .get_async("/v1/models/:model", |req, ctx| async move {
            let model = ctx.param("model").cloned();
            relay::retrieve_model(req, ctx.env, model.as_deref()).await
        })
        .get_async("/v1beta/models", |req, ctx| async move {
            relay::list_gemini_models(req, ctx.env).await
        })
        .get_async("/v1beta/openai/models", |req, ctx| async move {
            relay::list_gemini_openai_models(req, ctx.env).await
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
        .get_async("/api/ratio_sync/channels", |req, ctx| async move {
            ratio_sync::channels(req, ctx.env).await
        })
        .post_async("/api/ratio_sync/fetch", |req, ctx| async move {
            ratio_sync::fetch(req, ctx.env).await
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
        .get_async("/api/verification", |req, ctx| async move {
            admin_email::send_email_verification(req, ctx.env).await
        })
        .get_async("/api/reset_password", |req, ctx| async move {
            admin_email::send_password_reset_email(req, ctx.env).await
        })
        .post_async("/api/user/reset", |req, ctx| async move {
            admin_email::reset_password(req, ctx.env).await
        })
        // Two-step login second factor (item 4.6): complete a 2FA-gated login.
        .post_async("/api/user/login/2fa", |req, ctx| async move {
            admin::login_2fa(req, ctx.env).await
        })
        // OAuth login (item 4.6): CSRF state + GitHub callback.
        .get_async("/api/oauth/state", |req, ctx| async move {
            admin_oauth::oauth_state(req, ctx.env).await
        })
        .post_async("/api/oauth/email/bind", |req, ctx| async move {
            admin_email::bind_email(req, ctx.env).await
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
        .get_async("/api/oauth/wechat", |req, ctx| async move {
            admin_wechat::wechat_auth(req, ctx.env).await
        })
        .get_async("/api/oauth/wechat/bind", |req, ctx| async move {
            admin_wechat::bind_wechat(req, ctx.env).await
        })
        .post_async("/api/oauth/wechat/bind", |req, ctx| async move {
            admin_wechat::bind_wechat(req, ctx.env).await
        })
        .get_async("/api/oauth/:provider", |req, ctx| async move {
            let provider = ctx.param("provider").cloned();
            admin_custom_oauth::oauth_callback(req, ctx.env, provider.as_ref()).await
        })
        .post_async(
            "/api/custom-oauth-provider/discovery",
            |req, ctx| async move { admin_custom_oauth::discover(req, ctx.env).await },
        )
        .get_async("/api/custom-oauth-provider", |req, ctx| async move {
            admin_custom_oauth::list(req, ctx.env).await
        })
        .get_async("/api/custom-oauth-provider/", |req, ctx| async move {
            admin_custom_oauth::list(req, ctx.env).await
        })
        .get_async("/api/custom-oauth-provider/:id", |req, ctx| async move {
            let id = ctx.param("id").cloned();
            admin_custom_oauth::get(req, ctx.env, id.as_ref()).await
        })
        .post_async("/api/custom-oauth-provider", |req, ctx| async move {
            admin_custom_oauth::create(req, ctx.env).await
        })
        .post_async("/api/custom-oauth-provider/", |req, ctx| async move {
            admin_custom_oauth::create(req, ctx.env).await
        })
        .put_async("/api/custom-oauth-provider/:id", |req, ctx| async move {
            let id = ctx.param("id").cloned();
            admin_custom_oauth::update(req, ctx.env, id.as_ref()).await
        })
        .delete_async("/api/custom-oauth-provider/:id", |req, ctx| async move {
            let id = ctx.param("id").cloned();
            admin_custom_oauth::delete(req, ctx.env, id.as_ref()).await
        })
        .get_async("/api/user/logout", |req, ctx| async move {
            admin::logout_handler(req, ctx.env).await
        })
        .post_async("/api/user/logout", |req, ctx| async move {
            admin::logout_handler(req, ctx.env).await
        })
        .get_async("/api/user/self", |req, ctx| async move {
            admin::self_handler(req, ctx.env).await
        })
        .get_async("/api/user/checkin", |req, ctx| async move {
            admin_checkin::status(req, ctx.env).await
        })
        .post_async("/api/user/checkin", |req, ctx| async move {
            admin_checkin::perform(req, ctx.env).await
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
        .get_async("/api/user/oauth/bindings", |req, ctx| async move {
            admin_user::list_self_oauth_bindings(req, ctx.env).await
        })
        .delete_async(
            "/api/user/oauth/bindings/:provider_id",
            |req, ctx| async move {
                let provider_id = ctx.param("provider_id").cloned();
                admin_user::unbind_self_oauth_binding(req, ctx.env, provider_id.as_ref()).await
            },
        )
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
        // Passkey/WebAuthn route boundary. Begin routes create short-lived
        // challenges; finish routes fail closed until Worker-safe WebAuthn
        // attestation/assertion verification is wired.
        .get_async("/api/user/passkey", |req, ctx| async move {
            admin_passkey::status(req, ctx.env).await
        })
        .delete_async("/api/user/passkey", |req, ctx| async move {
            admin_passkey::delete(req, ctx.env).await
        })
        .post_async("/api/user/passkey/register/begin", |req, ctx| async move {
            admin_passkey::register_begin(req, ctx.env).await
        })
        .post_async("/api/user/passkey/register/finish", |req, ctx| async move {
            admin_passkey::register_finish(req, ctx.env).await
        })
        .post_async("/api/user/passkey/login/begin", |req, ctx| async move {
            admin_passkey::login_begin(req, ctx.env).await
        })
        .post_async("/api/user/passkey/login/finish", |req, ctx| async move {
            admin_passkey::login_finish(req, ctx.env).await
        })
        .post_async("/api/user/passkey/verify/begin", |req, ctx| async move {
            admin_passkey::verify_begin(req, ctx.env).await
        })
        .post_async("/api/user/passkey/verify/finish", |req, ctx| async move {
            admin_passkey::verify_finish(req, ctx.env).await
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
        // Async task usage logs (Go midjourney.go/task.go read-only list
        // surfaces): admin + self scopes for the React usage-log tabs.
        .get_async("/api/mj", |req, ctx| async move {
            admin_task_logs::list_midjourneys_admin(req, ctx.env).await
        })
        .get_async("/api/mj/", |req, ctx| async move {
            admin_task_logs::list_midjourneys_admin(req, ctx.env).await
        })
        .get_async("/api/mj/self", |req, ctx| async move {
            admin_task_logs::list_midjourneys_self(req, ctx.env).await
        })
        .get_async("/api/task", |req, ctx| async move {
            admin_task_logs::list_tasks_admin(req, ctx.env).await
        })
        .get_async("/api/task/", |req, ctx| async move {
            admin_task_logs::list_tasks_admin(req, ctx.env).await
        })
        .get_async("/api/task/self", |req, ctx| async move {
            admin_task_logs::list_tasks_self(req, ctx.env).await
        })
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
        .post_async("/api/option/waffo-pancake/catalog", |req, ctx| async move {
            admin_payment::list_waffo_pancake_catalog(req, ctx.env).await
        })
        .post_async("/api/option/waffo-pancake/pair", |req, ctx| async move {
            admin_payment::create_waffo_pancake_pair(req, ctx.env).await
        })
        .post_async("/api/option/waffo-pancake/save", |req, ctx| async move {
            admin_payment::save_waffo_pancake_config(req, ctx.env).await
        })
        .post_async(
            "/api/option/waffo-pancake/subscription-product",
            |req, ctx| async move {
                admin_payment::create_waffo_pancake_subscription_product(req, ctx.env).await
            },
        )
        .post_async(
            "/api/option/waffo-pancake/subscription-product-options",
            |req, ctx| async move {
                admin_payment::list_waffo_pancake_subscription_product_options(req, ctx.env).await
            },
        )
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
        // Redemption codes (admin, Go controller/redemption.go compatibility).
        .get_async("/api/redemption", |req, ctx| async move {
            admin_redemption::list(req, ctx.env).await
        })
        .get_async("/api/redemption/", |req, ctx| async move {
            admin_redemption::list(req, ctx.env).await
        })
        .get_async("/api/redemption/search", |req, ctx| async move {
            admin_redemption::search(req, ctx.env).await
        })
        .post_async("/api/redemption", |req, ctx| async move {
            admin_redemption::create(req, ctx.env).await
        })
        .post_async("/api/redemption/", |req, ctx| async move {
            admin_redemption::create(req, ctx.env).await
        })
        .put_async("/api/redemption", |req, ctx| async move {
            admin_redemption::update(req, ctx.env).await
        })
        .put_async("/api/redemption/", |req, ctx| async move {
            admin_redemption::update(req, ctx.env).await
        })
        .delete_async("/api/redemption/invalid", |req, ctx| async move {
            admin_redemption::delete_invalid(req, ctx.env).await
        })
        .get_async("/api/redemption/:id", |req, ctx| async move {
            let id = ctx.param("id").cloned();
            admin_redemption::get(req, ctx.env, id.as_ref()).await
        })
        .get_async("/api/redemption/:id/", |req, ctx| async move {
            let id = ctx.param("id").cloned();
            admin_redemption::get(req, ctx.env, id.as_ref()).await
        })
        .delete_async("/api/redemption/:id", |req, ctx| async move {
            let id = ctx.param("id").cloned();
            admin_redemption::delete(req, ctx.env, id.as_ref()).await
        })
        .delete_async("/api/redemption/:id/", |req, ctx| async move {
            let id = ctx.param("id").cloned();
            admin_redemption::delete(req, ctx.env, id.as_ref()).await
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
        // Public rankings (Go controller/rankings.go compatibility).
        .get_async("/api/rankings", |req, ctx| async move {
            rankings_api::get_rankings(req, ctx.env).await
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
        .post_async("/api/user/stripe/amount", |req, ctx| async move {
            admin_payment::stripe_amount(req, ctx.env).await
        })
        .post_async("/api/user/pay", |req, ctx| async move {
            admin_payment::epay_pay(req, ctx.env).await
        })
        .post_async("/api/user/creem/pay", |req, ctx| async move {
            admin_payment::creem_pay(req, ctx.env).await
        })
        .post_async("/api/user/waffo/pay", |req, ctx| async move {
            admin_payment::waffo_pay(req, ctx.env).await
        })
        .post_async("/api/user/amount", |req, ctx| async move {
            admin_payment::online_amount(req, ctx.env).await
        })
        .post_async("/api/user/waffo-pancake/amount", |req, ctx| async move {
            admin_payment::waffo_pancake_amount(req, ctx.env).await
        })
        .post_async("/api/user/waffo-pancake/pay", |req, ctx| async move {
            admin_payment::waffo_pancake_pay(req, ctx.env).await
        })
        .post_async("/api/stripe/webhook", |req, ctx| async move {
            admin_payment::stripe_webhook(req, ctx.env).await
        })
        .post_async("/api/creem/webhook", |req, ctx| async move {
            admin_payment::creem_webhook(req, ctx.env).await
        })
        .post_async("/api/waffo/webhook", |req, ctx| async move {
            admin_payment::waffo_webhook(req, ctx.env).await
        })
        .post_async("/api/waffo-pancake/webhook/:env", |req, ctx| async move {
            let env_name = ctx.param("env").cloned();
            admin_payment::waffo_pancake_webhook(req, ctx.env, env_name.as_ref()).await
        })
        .post_async("/api/user/epay/notify", |req, ctx| async move {
            admin_payment::epay_notify(req, ctx.env).await
        })
        .get_async("/api/user/epay/notify", |req, ctx| async move {
            admin_payment::epay_notify(req, ctx.env).await
        })
        .get_async("/api/user/topup/info", |req, ctx| async move {
            admin_payment::topup_info(req, ctx.env).await
        })
        .post_async("/api/user/topup", |req, ctx| async move {
            admin_payment::redeem_topup_code(req, ctx.env).await
        })
        .get_async("/api/user/topup/self", |req, ctx| async move {
            admin_payment::list_self_topups(req, ctx.env).await
        })
        .get_async("/api/user/topup", |req, ctx| async move {
            admin_payment::list_topups(req, ctx.env).await
        })
        .post_async("/api/user/topup/complete", |req, ctx| async move {
            admin_payment::complete_topup(req, ctx.env).await
        })
        // Subscription billing core (plans, self state, Stripe/balance pay,
        // admin binding). Other external payment providers remain deferred.
        .get_async("/api/subscription/plans", |req, ctx| async move {
            admin_subscription::public_plans(req, ctx.env).await
        })
        .get_async("/api/subscription/self", |req, ctx| async move {
            admin_subscription::self_summary(req, ctx.env).await
        })
        .put_async("/api/subscription/self/preference", |req, ctx| async move {
            admin_subscription::update_preference(req, ctx.env).await
        })
        .post_async("/api/subscription/balance/pay", |req, ctx| async move {
            admin_subscription::balance_pay(req, ctx.env).await
        })
        .post_async("/api/subscription/stripe/pay", |req, ctx| async move {
            admin_subscription::stripe_pay(req, ctx.env).await
        })
        .post_async("/api/subscription/creem/pay", |req, ctx| async move {
            admin_subscription::creem_pay(req, ctx.env).await
        })
        .post_async(
            "/api/subscription/waffo-pancake/pay",
            |req, ctx| async move { admin_subscription::waffo_pancake_pay(req, ctx.env).await },
        )
        .post_async("/api/subscription/epay/pay", |req, ctx| async move {
            admin_subscription::epay_pay(req, ctx.env).await
        })
        .post_async("/api/subscription/epay/notify", |req, ctx| async move {
            admin_subscription::epay_notify(req, ctx.env).await
        })
        .get_async("/api/subscription/epay/notify", |req, ctx| async move {
            admin_subscription::epay_notify(req, ctx.env).await
        })
        .post_async("/api/subscription/epay/return", |req, ctx| async move {
            admin_subscription::epay_return(req, ctx.env).await
        })
        .get_async("/api/subscription/epay/return", |req, ctx| async move {
            admin_subscription::epay_return(req, ctx.env).await
        })
        .get_async("/api/subscription/admin/plans", |req, ctx| async move {
            admin_subscription::admin_list_plans(req, ctx.env).await
        })
        .post_async("/api/subscription/admin/plans", |req, ctx| async move {
            admin_subscription::admin_create_plan(req, ctx.env).await
        })
        .put_async("/api/subscription/admin/plans/:id", |req, ctx| async move {
            let id = ctx.param("id").cloned();
            admin_subscription::admin_update_plan(req, ctx.env, id.as_ref()).await
        })
        .patch_async("/api/subscription/admin/plans/:id", |req, ctx| async move {
            let id = ctx.param("id").cloned();
            admin_subscription::admin_update_plan_status(req, ctx.env, id.as_ref()).await
        })
        .get_async(
            "/api/subscription/admin/users/:id/subscriptions",
            |req, ctx| async move {
                let id = ctx.param("id").cloned();
                admin_subscription::admin_list_user_subscriptions(req, ctx.env, id.as_ref()).await
            },
        )
        .post_async(
            "/api/subscription/admin/users/:id/subscriptions",
            |req, ctx| async move {
                let id = ctx.param("id").cloned();
                admin_subscription::admin_bind_user_subscription(req, ctx.env, id.as_ref()).await
            },
        )
        .post_async(
            "/api/subscription/admin/user_subscriptions/:id/invalidate",
            |req, ctx| async move {
                let id = ctx.param("id").cloned();
                admin_subscription::admin_invalidate_user_subscription(req, ctx.env, id.as_ref())
                    .await
            },
        )
        .delete_async(
            "/api/subscription/admin/user_subscriptions/:id",
            |req, ctx| async move {
                let id = ctx.param("id").cloned();
                admin_subscription::admin_delete_user_subscription(req, ctx.env, id.as_ref()).await
            },
        )
        // Channels (admin, Tier 1 CRUD).
        .get_async("/api/channel/", |req, ctx| async move {
            admin_channel::list_channels(req, ctx.env).await
        })
        .get_async("/api/channel/search", |req, ctx| async move {
            admin_channel::search_channels(req, ctx.env).await
        })
        .get_async("/api/channel/models", |req, ctx| async move {
            admin_channel::list_channel_models(req, ctx.env).await
        })
        .get_async("/api/channel/models_enabled", |req, ctx| async move {
            admin_channel::enabled_list_models(req, ctx.env).await
        })
        .get_async("/api/channel/provider-readiness", |req, ctx| async move {
            admin_channel::provider_readiness(req, ctx.env).await
        })
        .get_async("/api/channel/update_balance/:id", |req, ctx| async move {
            let id = ctx.param("id").cloned();
            admin_channel::update_channel_balance(req, ctx.env, id.as_ref()).await
        })
        .get_async("/api/channel/update_balance", |req, ctx| async move {
            admin_channel::update_all_channel_balances(req, ctx.env).await
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
        .get_async("/api/channel/test", |req, ctx| async move {
            admin_channel::test_all_channels(req, ctx.env).await
        })
        .get_async("/api/channel/test/:id", |req, ctx| async move {
            let id = ctx.param("id").cloned();
            admin_channel::test_channel(req, ctx.env, id.as_ref()).await
        })
        .post_async("/api/channel/test/:id", |req, ctx| async move {
            let id = ctx.param("id").cloned();
            admin_channel::test_channel(req, ctx.env, id.as_ref()).await
        })
        .post_async("/api/channel/copy/:id", |req, ctx| async move {
            let id = ctx.param("id").cloned();
            admin_channel::copy_channel(req, ctx.env, id.as_ref()).await
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
        // Model deployments (Go `/api/deployments*`, AdminAuth). io.net is
        // option-gated and all external calls use bounded Worker fetches.
        .get_async("/api/deployments/settings", |req, ctx| async move {
            admin_deployments::get_settings(req, ctx.env).await
        })
        .post_async(
            "/api/deployments/settings/test-connection",
            |req, ctx| async move { admin_deployments::test_connection(req, ctx.env).await },
        )
        .get_async("/api/deployments/search", |req, ctx| async move {
            admin_deployments::search(req, ctx.env).await
        })
        .get_async("/api/deployments/hardware-types", |req, ctx| async move {
            admin_deployments::hardware_types(req, ctx.env).await
        })
        .get_async("/api/deployments/locations", |req, ctx| async move {
            admin_deployments::locations(req, ctx.env).await
        })
        .get_async(
            "/api/deployments/available-replicas",
            |req, ctx| async move { admin_deployments::available_replicas(req, ctx.env).await },
        )
        .post_async("/api/deployments/price-estimation", |req, ctx| async move {
            admin_deployments::price_estimation(req, ctx.env).await
        })
        .get_async("/api/deployments/check-name", |req, ctx| async move {
            admin_deployments::check_name(req, ctx.env).await
        })
        .get_async("/api/deployments", |req, ctx| async move {
            admin_deployments::list(req, ctx.env).await
        })
        .get_async("/api/deployments/", |req, ctx| async move {
            admin_deployments::list(req, ctx.env).await
        })
        .post_async("/api/deployments", |req, ctx| async move {
            admin_deployments::create(req, ctx.env).await
        })
        .post_async("/api/deployments/", |req, ctx| async move {
            admin_deployments::create(req, ctx.env).await
        })
        .get_async(
            "/api/deployments/:id/containers/:container_id",
            |req, ctx| async move {
                let id = ctx.param("id").cloned();
                let container_id = ctx.param("container_id").cloned();
                admin_deployments::get_container(req, ctx.env, id.as_ref(), container_id.as_ref())
                    .await
            },
        )
        .get_async("/api/deployments/:id/containers", |req, ctx| async move {
            let id = ctx.param("id").cloned();
            admin_deployments::list_containers(req, ctx.env, id.as_ref()).await
        })
        .get_async("/api/deployments/:id/logs", |req, ctx| async move {
            let id = ctx.param("id").cloned();
            admin_deployments::get_logs(req, ctx.env, id.as_ref()).await
        })
        .put_async("/api/deployments/:id/name", |req, ctx| async move {
            let id = ctx.param("id").cloned();
            admin_deployments::rename(req, ctx.env, id.as_ref()).await
        })
        .post_async("/api/deployments/:id/extend", |req, ctx| async move {
            let id = ctx.param("id").cloned();
            admin_deployments::extend(req, ctx.env, id.as_ref()).await
        })
        .get_async("/api/deployments/:id", |req, ctx| async move {
            let id = ctx.param("id").cloned();
            admin_deployments::get(req, ctx.env, id.as_ref()).await
        })
        .put_async("/api/deployments/:id", |req, ctx| async move {
            let id = ctx.param("id").cloned();
            admin_deployments::update(req, ctx.env, id.as_ref()).await
        })
        .delete_async("/api/deployments/:id", |req, ctx| async move {
            let id = ctx.param("id").cloned();
            admin_deployments::delete(req, ctx.env, id.as_ref()).await
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
        .get_async("/api/user/:id/oauth/bindings", |req, ctx| async move {
            let id = ctx.param("id").cloned();
            admin_user::list_user_oauth_bindings_by_admin(req, ctx.env, id.as_ref()).await
        })
        .delete_async(
            "/api/user/:id/oauth/bindings/:provider_id",
            |req, ctx| async move {
                let id = ctx.param("id").cloned();
                let provider_id = ctx.param("provider_id").cloned();
                admin_user::unbind_user_oauth_binding_by_admin(
                    req,
                    ctx.env,
                    id.as_ref(),
                    provider_id.as_ref(),
                )
                .await
            },
        )
        .delete_async(
            "/api/user/:id/bindings/:binding_type",
            |req, ctx| async move {
                let id = ctx.param("id").cloned();
                let binding_type = ctx.param("binding_type").cloned();
                admin_user::clear_user_binding_by_admin(
                    req,
                    ctx.env,
                    id.as_ref(),
                    binding_type.as_ref(),
                )
                .await
            },
        )
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
        .delete_async("/api/user/:id/reset_passkey", |req, ctx| async move {
            let id = ctx.param("id").cloned();
            admin_user::reset_user_passkey(req, ctx.env, id.as_ref()).await
        })
        .delete_async("/api/user/:id", |req, ctx| async move {
            let id = ctx.param("id").cloned();
            admin_user::delete_user(req, ctx.env, id.as_ref()).await
        })
        .post_async("/pg/chat/completions", |req, ctx| async move {
            let env = ctx.env;
            let event_ctx = ctx.data;
            relay::playground_chat_completions(req, env, event_ctx).await
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
        .post_async("/v1/videos", |req, ctx| async move {
            let env = ctx.env;
            let now = (worker::Date::now().as_millis() / 1000) as i64;
            task_orchestration::handle_openai_video_submit(req, env, now).await
        })
        .post_async("/kling/v1/videos/text2video", |req, ctx| async move {
            let env = ctx.env;
            let now = (worker::Date::now().as_millis() / 1000) as i64;
            task_orchestration::handle_kling_video_submit(req, env, "textGenerate", now).await
        })
        .post_async("/kling/v1/videos/image2video", |req, ctx| async move {
            let env = ctx.env;
            let now = (worker::Date::now().as_millis() / 1000) as i64;
            task_orchestration::handle_kling_video_submit(req, env, "generate", now).await
        })
        .post_async("/jimeng/", |req, ctx| async move {
            let env = ctx.env;
            let now = (worker::Date::now().as_millis() / 1000) as i64;
            task_orchestration::handle_jimeng_official(req, env, now).await
        })
        .post_async("/jimeng", |req, ctx| async move {
            let env = ctx.env;
            let now = (worker::Date::now().as_millis() / 1000) as i64;
            task_orchestration::handle_jimeng_official(req, env, now).await
        })
        // Suno task submit (platform "suno"): POST /suno/submit/:action.
        // Client-facing async-task fetch (Go RelayTaskFetch): the owner's
        // stored TaskDto, kept current by the poller cron.
        .get_async("/v1/video/generations/:task_id", |req, ctx| async move {
            let task_id = ctx.param("task_id").cloned();
            task_orchestration::handle_task_fetch_by_id(req, ctx.env, task_id.as_ref()).await
        })
        .get_async(
            "/kling/v1/videos/text2video/:task_id",
            |req, ctx| async move {
                let task_id = ctx.param("task_id").cloned();
                task_orchestration::handle_task_fetch_by_id(req, ctx.env, task_id.as_ref()).await
            },
        )
        .get_async(
            "/kling/v1/videos/image2video/:task_id",
            |req, ctx| async move {
                let task_id = ctx.param("task_id").cloned();
                task_orchestration::handle_task_fetch_by_id(req, ctx.env, task_id.as_ref()).await
            },
        )
        // Source Go exposes this as a TokenOrUserAuth video proxy. Rust now
        // owns the token-or-session-authenticated stored-URL/data-URL proxy
        // slice; provider credential refetch remains an explicit G7 follow-up.
        .get_async("/v1/videos/:task_id/content", |req, ctx| async move {
            let task_id = ctx.param("task_id").cloned();
            task_orchestration::handle_openai_video_content_by_id(req, ctx.env, task_id.as_ref())
                .await
        })
        .get_async("/v1/videos/:task_id", |req, ctx| async move {
            let task_id = ctx.param("task_id").cloned();
            task_orchestration::handle_openai_video_fetch_by_id(req, ctx.env, task_id.as_ref())
                .await
        })
        .post_async("/v1/videos/:video_id/remix", |req, ctx| async move {
            let video_id = ctx.param("video_id").cloned();
            let now = (worker::Date::now().as_millis() / 1000) as i64;
            task_orchestration::handle_openai_video_remix(req, ctx.env, video_id.as_ref(), now)
                .await
        })
        .get_async("/suno/fetch/:id", |req, ctx| async move {
            let task_id = ctx.param("id").cloned();
            task_orchestration::handle_task_fetch_by_id(req, ctx.env, task_id.as_ref()).await
        })
        .post_async("/suno/fetch", |req, ctx| async move {
            task_orchestration::handle_task_fetch_batch(req, ctx.env).await
        })
        .get_async(
            "/api/task/submissions/:submission_id",
            |req, ctx| async move {
                let submission_id = ctx.param("submission_id").cloned();
                task_orchestration::handle_task_submission_status(
                    req,
                    ctx.env,
                    submission_id.as_ref(),
                )
                .await
            },
        )
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
        // Go's PaLM-era legacy engines alias falls back to the `:model` path
        // param when the JSON body omits `model`, then uses embeddings relay
        // mode. Keep it on the same bounded JSON relay as `/v1/embeddings`.
        .post_async("/v1/engines/:model/embeddings", |req, ctx| async move {
            let model = ctx.param("model").cloned();
            let env = ctx.env;
            let event_ctx = ctx.data;
            relay::engine_embeddings(req, env, event_ctx, model).await
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
        .await?;
    let mut response = response;
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
    match d1_repositories::relay_container_shard_activation_campaign_schema_ready(&db).await {
        Ok(true) => {
            match d1_repositories::materialize_expired_relay_container_shard_activation_campaigns(
                &db,
                d1_repositories::RELAY_CONTAINER_SHARD_ACTIVATION_CAMPAIGN_EXPIRY_LIMIT,
            )
            .await
            {
                Ok(materialized) if materialized > 0 => worker::console_log!(
                    "{}",
                    serde_json::json!({
                        "event": "relay_container_shard_activation_campaign_expiry_materialization",
                        "status": "materialized",
                        "scope": "minute_cron",
                        "limit": d1_repositories::RELAY_CONTAINER_SHARD_ACTIVATION_CAMPAIGN_EXPIRY_LIMIT,
                        "materialized": materialized,
                    })
                ),
                Ok(_) => {}
                Err(err) => worker::console_error!(
                    "{}",
                    serde_json::json!({
                        "event": "relay_container_shard_activation_campaign_expiry_materialization",
                        "status": "error",
                        "scope": "minute_cron",
                        "error": err.to_string(),
                    })
                ),
            }
        }
        Ok(false) => worker::console_error!(
            "{}",
            serde_json::json!({
                "event": "relay_container_shard_activation_campaign_expiry_materialization",
                "status": "schema_not_ready",
                "scope": "minute_cron",
            })
        ),
        Err(err) => worker::console_error!(
            "{}",
            serde_json::json!({
                "event": "relay_container_shard_activation_campaign_expiry_materialization",
                "status": "schema_probe_error",
                "scope": "minute_cron",
                "error": err.to_string(),
            })
        ),
    }
    let terminal_outbox = container_terminal_outbox::container_terminal_outbox_runtime_config(&env);
    if terminal_outbox.enabled {
        match container_terminal_outbox::run_container_terminal_outbox(&env, &db, now).await {
            Ok(summary) => match serde_json::to_string(&summary) {
                Ok(summary) => worker::console_log!("container terminal outbox: {summary}"),
                Err(_) => {
                    worker::console_error!("container terminal outbox summary serialization failed")
                }
            },
            Err(err) => worker::console_error!("container terminal outbox failed: {err}"),
        }
    } else if !terminal_outbox.valid {
        worker::console_error!("container terminal outbox configuration is invalid");
    }
    let http_stream_handoff =
        relay_http_stream_handoff::relay_http_stream_handoff_runtime_config(&env);
    if http_stream_handoff.outbox_enabled || http_stream_handoff.recovery_enabled {
        match relay_http_stream_handoff::run_relay_http_stream_handoff_scheduled(&env, &db, now)
            .await
        {
            Ok(summary) => match serde_json::to_string(&summary) {
                Ok(summary) => worker::console_log!("relay HTTP stream handoff: {summary}"),
                Err(_) => {
                    worker::console_error!("relay HTTP stream handoff summary serialization failed")
                }
            },
            Err(err) => worker::console_error!("relay HTTP stream handoff failed: {err}"),
        }
    } else if !http_stream_handoff.valid {
        worker::console_error!("relay HTTP stream handoff configuration is invalid");
    }
    if container_scheduler::container_operation_runtime_status(&env)
        .operation_reconciliation_enabled
    {
        match container_reconciliation::run_container_reconciliation_observer(&env, &db, now).await
        {
            Ok(summary) => match serde_json::to_string(&summary) {
                Ok(summary) => {
                    worker::console_log!("container reconciliation observer: {summary}")
                }
                Err(_) => worker::console_error!(
                    "container reconciliation observer summary serialization failed"
                ),
            },
            Err(err) => {
                worker::console_error!("container reconciliation observer failed: {err}")
            }
        }
    }
    let container_r2_inventory =
        container_r2_inventory::container_r2_inventory_runtime_config(&env);
    if container_r2_inventory.enabled {
        match container_r2_inventory::run_container_r2_orphan_inventory(&env, &db, now).await {
            Ok(summary) => match serde_json::to_string(&summary) {
                Ok(summary) => worker::console_log!("container R2 orphan inventory: {summary}"),
                Err(_) => worker::console_error!(
                    "container R2 orphan inventory summary serialization failed"
                ),
            },
            Err(err) => worker::console_error!("container R2 orphan inventory failed: {err}"),
        }
    } else if !container_r2_inventory.valid {
        worker::console_error!("container R2 orphan inventory configuration is invalid");
    }
    match task_repository::task_billing_intent_schema_ready(&db).await {
        Ok(true) => match task_repository::sweep_expired_task_billing_intents(&db, now, 64).await {
            Ok(summary) if summary.candidates > 0 => worker::console_log!(
                "task billing intent recovery: candidates={} refunded={} recovery_required={} finalized={} failed={}",
                summary.candidates,
                summary.refunded,
                summary.recovery_required,
                summary.already_finalized,
                summary.failed
            ),
            Ok(_) => {}
            Err(err) => worker::console_error!("task billing intent recovery failed: {err}"),
        },
        Ok(false) => worker::console_error!(
            "task billing intent recovery refused: migration 0031 is not applied"
        ),
        Err(err) => worker::console_error!(
            "task billing intent recovery migration check failed: {err}"
        ),
    }
    if relay::relay_billing_orphan_recovery_enabled(&env) {
        let heartbeat = relay::relay_billing_stream_lease_heartbeat_runtime_status(&env);
        if !heartbeat.valid {
            worker::console_error!(
                "relay billing orphan sweep refused: stream lease heartbeat configuration is invalid"
            );
        } else {
            match d1_repositories::relay_billing_reservation_schema_ready(&db).await {
                Ok(true) => {
                    if relay::relay_billing_orphan_recovery_execution_ready(&env, true) {
                        if let Err(err) =
                            d1_repositories::mark_relay_billing_recovery_started(&db, now).await
                        {
                            worker::console_error!(
                                "relay billing orphan sweep start status failed: {err}"
                            );
                        }
                        match d1_repositories::sweep_expired_relay_billing_reservations(
                            &db,
                            now,
                            relay::relay_billing_orphan_sweep_limit(&env),
                        )
                        .await
                        {
                            Ok(summary) => {
                                for reservation_key in &summary.observation_reservation_keys {
                                    quota_coordinator::observe_committed_relay_billing_reservation(
                                        &env,
                                        &db,
                                        reservation_key,
                                    )
                                    .await;
                                }
                                if let Err(err) =
                                    d1_repositories::mark_relay_billing_recovery_completed(
                                        &db, now, &summary,
                                    )
                                    .await
                                {
                                    worker::console_error!(
                                        "relay billing orphan sweep completion status failed: {err}"
                                    );
                                }
                                worker::console_log!(
                                    "relay billing orphan sweep: candidates={} refunded={} recovery_required={} finalized={} active={} missing={} failed={} deferred={}",
                                    summary.candidates,
                                    summary.refunded,
                                    summary.recovery_required,
                                    summary.already_finalized,
                                    summary.lease_active,
                                    summary.not_found,
                                    summary.failed,
                                    summary.deferred
                                );
                            }
                            Err(err) => {
                                worker::console_error!("relay billing orphan sweep failed: {err}")
                            }
                        }
                    } else {
                        worker::console_error!(
                            "relay billing orphan sweep refused: durable finalization cutover prerequisites are not met"
                        );
                    }
                }
                Ok(false) => worker::console_error!(
                    "relay billing orphan sweep refused: migrations 0023-0026 are not applied"
                ),
                Err(err) => {
                    worker::console_error!(
                        "relay billing orphan sweep migration check failed: {err}"
                    )
                }
            }
        }
    }
    if realtime_session::realtime_billing_orphan_recovery_enabled(&env) {
        match d1_repositories::realtime_billing_global_recovery_schema_ready(&db).await {
            Ok(true) => {
                let orphan_sweep_limit =
                    realtime_session::realtime_billing_orphan_sweep_limit(&env);
                if let Err(err) =
                    d1_repositories::mark_realtime_billing_recovery_started(&db, now).await
                {
                    worker::console_error!(
                        "realtime billing orphan sweep start status failed: {err}"
                    );
                }
                match d1_repositories::sweep_expired_realtime_billing_reservations(
                    &db,
                    now,
                    orphan_sweep_limit,
                )
                .await
                {
                    Ok(summary) => {
                        if let Err(err) = d1_repositories::mark_realtime_billing_recovery_completed(
                            &db, now, summary,
                        )
                        .await
                        {
                            worker::console_error!(
                                "realtime billing orphan sweep completion status failed: {err}"
                            );
                        }
                        if summary.failed > 0 {
                            worker::console_error!(
                                "realtime billing orphan sweep: candidates={} refunded={} recovery_required={} finalized={} active={} missing={} failed={} deferred={}",
                                summary.candidates,
                                summary.refunded,
                                summary.recovery_required,
                                summary.already_finalized,
                                summary.lease_active,
                                summary.not_found,
                                summary.failed,
                                summary.deferred
                            );
                        } else {
                            worker::console_log!(
                                "realtime billing orphan sweep: candidates={} refunded={} recovery_required={} finalized={} active={} missing={} failed=0 deferred=0",
                                summary.candidates,
                                summary.refunded,
                                summary.recovery_required,
                                summary.already_finalized,
                                summary.lease_active,
                                summary.not_found
                            );
                        }
                    }
                    Err(err) => {
                        worker::console_error!("realtime billing orphan sweep failed: {err}")
                    }
                }
            }
            Ok(false) => worker::console_error!(
                "realtime billing orphan sweep refused: migrations 0022 and 0027 are not applied"
            ),
            Err(err) => worker::console_error!(
                "realtime billing orphan sweep migration check failed: {err}"
            ),
        }
    }
    let poller_config = task_orchestration::task_poller_config_from_env(&env);
    if !task_orchestration::task_poll_lease_enabled(&env) {
        worker::console_log!("task poller skipped: TASK_POLL_LEASE_ENABLED is disabled");
        return;
    }
    if !poller_config.scheduler_enabled {
        worker::console_log!("task poller skipped: TASK_POLL_SCHEDULER_ENABLED is disabled");
        return;
    }
    let poll_lease_status = match task_repository::task_poll_lease_runtime_status(&db).await {
        Ok(status) if status.schema_ready && status.authority_enabled => status,
        Ok(status) if status.schema_ready => {
            worker::console_warn!("task poller skipped: D1 task poll authority is disabled");
            return;
        }
        Ok(_) => {
            worker::console_error!("task poller refused: migrations 0034 and 0035 are not applied");
            return;
        }
        Err(err) => {
            worker::console_error!("task poller lease schema check failed: {err}");
            return;
        }
    };
    if !poll_lease_status.enforcement_enabled {
        worker::console_warn!(
            "task poller skipped because lease old-writer enforcement is disabled"
        );
        return;
    }
    match task_repository::task_poll_scheduler_runtime_status(&db).await {
        Ok(status) if status.schema_ready => {}
        Ok(_) => {
            worker::console_error!("task poller refused: migration 0036 is not applied");
            return;
        }
        Err(err) => {
            worker::console_error!("task poller scheduler schema check failed: {err}");
            return;
        }
    }
    match task_orchestration::sweep_timed_out_tasks(
        &db,
        now,
        poller_config.timeout_minutes,
        poller_config.poll_lease_seconds,
        poller_config.timeout_sweep_limit,
    )
    .await
    {
        Ok(settled) => worker::console_log!("task poller: timed out {settled} task(s)"),
        Err(err) => worker::console_error!("task poller: timeout sweep failed: {err}"),
    }
    match mj_repository::sweep_timed_out_midjourneys(
        &db,
        now,
        poller_config.poll_lease_seconds,
        poller_config.timeout_sweep_limit,
    )
    .await
    {
        Ok(settled) => worker::console_log!("task poller: timed out {settled} mj task(s)"),
        Err(err) => worker::console_error!("task poller: mj timeout sweep failed: {err}"),
    }
    let family_limit = task_orchestration::task_poll_family_query_limit(poller_config.query_limit);
    match task_orchestration::task_poll_family_for_slot(now) {
        task_orchestration::TaskPollFamily::Video => {
            match task_orchestration::poll_unfinished_tasks(
                &db,
                &gemini_version,
                now,
                poller_config.poll_lease_seconds,
                poller_config.retry_base_seconds,
                poller_config.retry_max_seconds,
                poller_config.max_consecutive_failures,
                family_limit,
            )
            .await
            {
                Ok(settled) => {
                    worker::console_log!("task poller: settled {settled} video task(s)")
                }
                Err(err) => worker::console_error!("task poller: video batch failed: {err}"),
            }
        }
        task_orchestration::TaskPollFamily::Suno => {
            match task_orchestration::poll_unfinished_suno_tasks(
                &db,
                now,
                poller_config.poll_lease_seconds,
                poller_config.retry_base_seconds,
                poller_config.retry_max_seconds,
                poller_config.max_consecutive_failures,
                family_limit,
            )
            .await
            {
                Ok(settled) => {
                    worker::console_log!("task poller: settled {settled} suno task(s)")
                }
                Err(err) => worker::console_error!("task poller: suno batch failed: {err}"),
            }
        }
        task_orchestration::TaskPollFamily::Midjourney => {
            match task_orchestration::poll_unfinished_midjourney_tasks(
                &db,
                now,
                poller_config.poll_lease_seconds,
                poller_config.retry_base_seconds,
                poller_config.retry_max_seconds,
                poller_config.max_consecutive_failures,
                family_limit,
            )
            .await
            {
                Ok(settled) => {
                    worker::console_log!("task poller: settled {settled} mj task(s)")
                }
                Err(err) => worker::console_error!("task poller: mj batch failed: {err}"),
            }
        }
    }
}

#[event(queue)]
pub async fn queue(
    message_batch: MessageBatch<serde_json::Value>,
    env: Env,
    _ctx: Context,
) -> Result<()> {
    let queue_name = message_batch.queue();
    let Some(queue_kind) = relay_billing_queue::worker_queue_kind(&queue_name) else {
        worker::console_error!("queue {queue_name}: queue name is not owned by this Worker");
        message_batch.retry_all();
        return Ok(());
    };
    let messages = match message_batch.messages() {
        Ok(messages) => messages,
        Err(err) => {
            worker::console_error!("queue {queue_name}: failed to deserialize batch: {err}");
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
            worker::console_error!("queue {queue_name}: D1 binding unavailable: {err}");
            message_batch.retry_all();
            return Ok(());
        }
    };

    let mut audit_messages = Vec::new();
    for message in &messages {
        if queue_kind == relay_billing_queue::WorkerQueueKind::RelayBillingFinalizationDeadLetter {
            match relay_billing_queue::quarantine_relay_billing_finalization_dead_letter(
                &db,
                &message.id(),
                message.body(),
                crate::admin::unix_timestamp(),
            )
            .await
            {
                Ok(disposition) => {
                    worker::console_log!(
                        "BILLING_QUEUE DLQ: quarantined {} as {:?}",
                        message.id(),
                        disposition
                    );
                    message.ack();
                }
                Err(err) => {
                    worker::console_error!(
                        "BILLING_QUEUE DLQ: failed to quarantine {}: {err}",
                        message.id()
                    );
                    message.retry();
                }
            }
            continue;
        }
        let event = match serde_json::from_value::<relay_billing_queue::WorkerQueueEvent>(
            message.body().clone(),
        ) {
            Ok(event) => event,
            Err(err) => {
                worker::console_error!("queue {queue_name}: invalid message shape: {err}");
                message.retry();
                continue;
            }
        };
        match (queue_kind, event) {
            (
                relay_billing_queue::WorkerQueueKind::RelayBillingFinalization,
                relay_billing_queue::WorkerQueueEvent::RelayBillingFinalization(event),
            ) => {
                match relay_billing_queue::apply_relay_billing_finalization_event(&env, &db, &event)
                    .await
                {
                    Ok(outcome) => {
                        let observed_at = crate::admin::unix_timestamp();
                        match relay_http_stream_handoff::observe_applied_finalization(
                            &db,
                            &event,
                            observed_at,
                        )
                        .await
                        {
                            Ok(
                                d1_repositories::RelayHttpStreamHandoffTransitionOutcome::Applied
                                | d1_repositories::RelayHttpStreamHandoffTransitionOutcome::MatchingReplay
                                | d1_repositories::RelayHttpStreamHandoffTransitionOutcome::NotFound,
                            ) => {}
                            Ok(handoff_outcome) => worker::console_error!(
                                "BILLING_QUEUE: HTTP stream handoff for {} remains {:?}",
                                event.event_id,
                                handoff_outcome
                            ),
                            Err(err) => {
                                worker::console_error!(
                                    "BILLING_QUEUE: HTTP stream handoff completion for {} failed: {err}",
                                    event.event_id
                                );
                                message.retry();
                                continue;
                            }
                        }
                        let resolution = match outcome {
                            relay_billing_queue::RelayBillingFinalizationApplyOutcome::Applied => {
                                "applied"
                            }
                            relay_billing_queue::RelayBillingFinalizationApplyOutcome::Replay => {
                                "idempotent_replay"
                            }
                        };
                        if let Err(err) = crate::d1_repositories::resolve_relay_billing_finalization_incident_for_event(
                            &db,
                            &event.event_id,
                            resolution,
                            observed_at,
                        )
                        .await
                        {
                            worker::console_error!(
                                "BILLING_QUEUE: incident completion for {} failed: {err}",
                                event.event_id
                            );
                            message.retry();
                            continue;
                        }
                        worker::console_log!(
                            "BILLING_QUEUE: processed {} as {:?}",
                            event.event_id,
                            outcome
                        );
                        message.ack();
                    }
                    Err(err) => {
                        worker::console_error!(
                            "BILLING_QUEUE: finalization event {} failed: {err}",
                            event.event_id
                        );
                        message.retry();
                    }
                }
            }
            (
                relay_billing_queue::WorkerQueueKind::AuditLog,
                relay_billing_queue::WorkerQueueEvent::AuditLog(event),
            ) => {
                audit_messages.push((message, event));
            }
            _ => {
                worker::console_error!(
                    "queue {queue_name}: message type does not belong to this queue"
                );
                message.retry();
            }
        }
    }

    if audit_messages.is_empty() {
        return Ok(());
    }

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
    let terminal_attempt_stmt = db.prepare(
        r#"
        INSERT INTO logs (
          user_id, created_at, type, content, username, token_name, model_name,
          quota, prompt_tokens, completion_tokens, use_time, is_stream,
          channel_id, token_id, "group", ip, request_id, upstream_request_id, other
        )
        SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19
        WHERE NOT EXISTS (
          SELECT 1 FROM logs WHERE type = ?3 AND other = ?19
        )
        "#,
    );

    let mut stmts = Vec::with_capacity(audit_messages.len());
    let mut bound_messages = Vec::with_capacity(audit_messages.len());
    for (message, event) in &audit_messages {
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
        let event_stmt = if event.terminal_relay_attempt_audit_id().is_some() {
            &terminal_attempt_stmt
        } else {
            &stmt
        };
        match event_stmt.bind_refs(&args) {
            Ok(bound) => {
                stmts.push(bound);
                bound_messages.push(message);
            }
            Err(err) => {
                worker::console_error!("LOG_QUEUE: failed to bind event: {err}");
                message.retry();
            }
        }
    }

    if stmts.is_empty() {
        worker::console_warn!("LOG_QUEUE: no bindable events in batch, retrying individually");
        return Ok(());
    }

    match db.batch(stmts).await {
        Ok(_) => {
            for message in bound_messages {
                message.ack();
            }
            Ok(())
        }
        Err(err) => {
            worker::console_error!("LOG_QUEUE: D1 batch insert failed: {err}");
            for message in bound_messages {
                message.retry();
            }
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
        "authorization,content-type,idempotency-key,x-api-key,x-goog-api-key,anthropic-version,anthropic-beta",
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
/// `router/video-router.go`); the pure gateway crate is the ownership authority.
#[cfg(test)]
fn is_static_asset_path(path: &str) -> bool {
    cinatoken_gateway::is_static_asset_path(path)
}

fn scheduling_gateway_request_host(req: &Request) -> Result<Option<String>> {
    Ok(req.headers().get("Host")?.or_else(|| {
        req.url()
            .ok()
            .and_then(|url| url.host_str().map(str::to_string))
    }))
}

fn scheduling_gateway_invariant_response(detail: &str) -> Result<Response> {
    json_with_status(
        &serde_json::json!({
            "error": {
                "code": "scheduling_gateway_invariant_failed",
                "message": detail,
                "type": "platform_gateway_error"
            }
        }),
        500,
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
    fn go_compatible_channel_and_logout_routes_are_registered_with_exact_methods() {
        let source = include_str!("lib.rs");
        let router_source = source.split("#[cfg(test)]").next().unwrap();
        for registration in [
            ".get_async(\"/api/channel/models\"",
            ".get_async(\"/api/channel/test\"",
            ".post_async(\"/api/channel/test/:id\"",
            ".get_async(\"/api/channel/update_balance\"",
            ".post_async(\"/api/channel/copy/:id\"",
            ".get_async(\"/api/user/logout\"",
            ".post_async(\"/api/user/logout\"",
        ] {
            assert!(
                router_source.contains(registration),
                "missing route registration {registration}"
            );
        }
        assert_eq!(
            router_source
                .matches("admin::logout_handler(req, ctx.env).await")
                .count(),
            2
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
            "/api/platform/capabilities",
            "/api/platform/container/shards/activations",
            "/api/platform/container/shards/placements",
            "/api/platform/container/shards/placement-mutation-authorizations",
            "/api/platform/container/shards/activation-campaigns",
            "/api/platform/container/shards/readiness",
            "/api/platform/container/reconciliation/status",
            "/api/platform/container/reconciliations",
            "/api/platform/container/reconciliations/:target/retry/preview",
            "/api/platform/container/reconciliations/:target/retry/apply",
            "/api/platform/container/r2-inventory/status",
            "/api/platform/container/r2-inventory/findings",
            "/api/platform/quota-coordinator/reconciliation",
            "/api/platform/relay-billing/ledger/status",
            "/api/platform/task-runner/task-smoke/status",
            "/api/platform/dispatch/tenant-a",
            "/api/platform/realtime/session-a",
            "/api/platform/realtime/settlement-batch/smoke",
            "/api/platform/relay/actual-group-billing/smoke",
            "/api/user/login",
            "/api/user/logout",
            "/api/user/self",
            "/api/user/checkin",
            "/api/token/",
            "/api/channel/",
            "/api/log/",
            "/internal",
            "/internal/v1/status",
            "/internal/v1/operations",
            "/v1/models",
            "/v1/chat/completions",
            "/v1/completions",
            "/v1/responses",
            "/v1/realtime",
            "/v1/messages",
            "/v1/embeddings",
            "/v1/engines/text-embedding-3-small/embeddings",
            "/v1/rerank",
            "/v1/images/generations",
            "/v1/audio/speech",
            "/v1/audio/transcriptions",
            "/v1beta/models/gemini-2.0-flash:generateContent",
            "/mj/submit/imagine",
            "/jimeng/?Action=CVSync2AsyncSubmitTask&Version=2022-08-31",
            "/jimeng?Action=CVSync2AsyncGetResult&Version=2022-08-31",
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
