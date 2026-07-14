/*
Copyright (C) 2023-2026 CinaGroup

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@cinagroup.com
*/
export type SystemOption = {
  key: string
  value: string
}

export type SystemOptionKey = string

export type SystemOptionsResponse = {
  success: boolean
  message: string
  data: SystemOption[]
}

export type UpdateOptionRequest = {
  key: string
  value: string | boolean | number
}

export type UpdateOptionResponse = {
  success: boolean
  message: string
}

export type ConfirmPaymentComplianceResponse = {
  success: boolean
  message: string
  data?: {
    confirmed: boolean
    terms_version: string
    confirmed_at: number
    confirmed_by: number
  }
}

export type DeleteLogsResponse = {
  success: boolean
  message: string
  data?: number
}

export type SiteSettings = {
  'theme.frontend': string
  Notice: string
  SystemName: string
  Logo: string
  Footer: string
  About: string
  HomePageContent: string
  ServerAddress: string
  'legal.user_agreement': string
  'legal.privacy_policy': string
  HeaderNavModules: string
  SidebarModulesAdmin: string
}

export type AuthSettings = {
  PasswordLoginEnabled: boolean
  PasswordRegisterEnabled: boolean
  EmailVerificationEnabled: boolean
  RegisterEnabled: boolean
  EmailDomainRestrictionEnabled: boolean
  EmailAliasRestrictionEnabled: boolean
  EmailDomainWhitelist: string
  GitHubOAuthEnabled: boolean
  GitHubClientId: string
  GitHubClientSecret: string
  'discord.enabled': boolean
  'discord.client_id': string
  'discord.client_secret': string
  'oidc.enabled': boolean
  'oidc.client_id': string
  'oidc.client_secret': string
  'oidc.well_known': string
  'oidc.authorization_endpoint': string
  'oidc.token_endpoint': string
  'oidc.user_info_endpoint': string
  TelegramOAuthEnabled: boolean
  TelegramBotToken: string
  TelegramBotName: string
  LinuxDOOAuthEnabled: boolean
  LinuxDOClientId: string
  LinuxDOClientSecret: string
  LinuxDOMinimumTrustLevel: string
  WeChatAuthEnabled: boolean
  WeChatServerAddress: string
  WeChatServerToken: string
  WeChatAccountQRCodeImageURL: string
  TurnstileCheckEnabled: boolean
  TurnstileSiteKey: string
  TurnstileSecretKey: string
  'passkey.enabled': boolean
  'passkey.rp_display_name': string
  'passkey.rp_id': string
  'passkey.origins': string
  'passkey.allow_insecure_origin': boolean
  'passkey.user_verification': 'required' | 'preferred' | 'discouraged'
  'passkey.attachment_preference': '' | 'platform' | 'cross-platform'
}

export type ContentSettings = {
  'console_setting.api_info': string
  'console_setting.announcements': string
  'console_setting.faq': string
  'console_setting.uptime_kuma_groups': string
  'console_setting.api_info_enabled': boolean
  'console_setting.announcements_enabled': boolean
  'console_setting.faq_enabled': boolean
  'console_setting.uptime_kuma_enabled': boolean
  DataExportEnabled: boolean
  DataExportDefaultTime: string
  DataExportInterval: number
  Chats: string
  DrawingEnabled: boolean
  MjNotifyEnabled: boolean
  MjAccountFilterEnabled: boolean
  MjForwardUrlEnabled: boolean
  MjModeClearEnabled: boolean
  MjActionCheckSuccessEnabled: boolean
}

export type ModelSettings = {
  'global.pass_through_request_enabled': boolean
  'global.thinking_model_blacklist': string
  'global.chat_completions_to_responses_policy': string
  'general_setting.ping_interval_enabled': boolean
  'general_setting.ping_interval_seconds': number
  'gemini.safety_settings': string
  'gemini.version_settings': string
  'gemini.supported_imagine_models': string
  'gemini.thinking_adapter_enabled': boolean
  'gemini.thinking_adapter_budget_tokens_percentage': number
  'gemini.function_call_thought_signature_enabled': boolean
  'gemini.remove_function_response_id_enabled': boolean
  'claude.model_headers_settings': string
  'claude.default_max_tokens': string
  'claude.thinking_adapter_enabled': boolean
  'claude.thinking_adapter_budget_tokens_percentage': number
  'grok.violation_deduction_enabled': boolean
  'grok.violation_deduction_amount': number
  ModelPrice: string
  ModelRatio: string
  CacheRatio: string
  CreateCacheRatio: string
  CompletionRatio: string
  ImageRatio: string
  AudioRatio: string
  AudioCompletionRatio: string
  ExposeRatioEnabled: boolean
  'billing_setting.billing_mode': string
  'billing_setting.billing_expr': string
  'tool_price_setting.prices': string
  TopupGroupRatio: string
  GroupRatio: string
  UserUsableGroups: string
  GroupGroupRatio: string
  AutoGroups: string
  DefaultUseAutoGroup: boolean
  'group_ratio_setting.group_special_usable_group': string
  'channel_affinity_setting.enabled': boolean
  'channel_affinity_setting.switch_on_success': boolean
  'channel_affinity_setting.keep_on_channel_disabled': boolean
  'channel_affinity_setting.max_entries': number
  'channel_affinity_setting.default_ttl_seconds': number
  'channel_affinity_setting.rules': string
  'model_deployment.ionet.api_key': string
  'model_deployment.ionet.enabled': boolean
}

export type BillingSettings = {
  QuotaForNewUser: number
  PreConsumedQuota: number
  QuotaForInviter: number
  QuotaForInvitee: number
  TopUpLink: string
  'general_setting.docs_link': string
  'quota_setting.enable_free_model_pre_consume': boolean
  QuotaPerUnit: number
  USDExchangeRate: number
  'general_setting.quota_display_type': string
  'general_setting.custom_currency_symbol': string
  'general_setting.custom_currency_exchange_rate': number
  DisplayInCurrencyEnabled: boolean
  DisplayTokenStatEnabled: boolean
  ModelPrice: string
  ModelRatio: string
  CacheRatio: string
  CreateCacheRatio: string
  CompletionRatio: string
  ImageRatio: string
  AudioRatio: string
  AudioCompletionRatio: string
  ExposeRatioEnabled: boolean
  'billing_setting.billing_mode': string
  'billing_setting.billing_expr': string
  'tool_price_setting.prices': string
  TopupGroupRatio: string
  GroupRatio: string
  UserUsableGroups: string
  GroupGroupRatio: string
  AutoGroups: string
  DefaultUseAutoGroup: boolean
  'group_ratio_setting.group_special_usable_group': string
  PayAddress: string
  EpayId: string
  EpayKey: string
  Price: number
  MinTopUp: number
  CustomCallbackAddress: string
  PayMethods: string
  'payment_setting.amount_options': string
  'payment_setting.amount_discount': string
  'payment_setting.compliance_confirmed': boolean
  'payment_setting.compliance_terms_version': string
  'payment_setting.compliance_confirmed_at': number
  'payment_setting.compliance_confirmed_by': number
  'payment_setting.compliance_confirmed_ip': string
  StripeApiSecret: string
  StripeWebhookSecret: string
  StripePriceId: string
  StripeUnitPrice: number
  StripeMinTopUp: number
  StripePromotionCodesEnabled: boolean
  CreemApiKey: string
  CreemWebhookSecret: string
  CreemTestMode: boolean
  CreemProducts: string
  WaffoEnabled: boolean
  WaffoApiKey: string
  WaffoPrivateKey: string
  WaffoPublicCert: string
  WaffoSandboxPublicCert: string
  WaffoSandboxApiKey: string
  WaffoSandboxPrivateKey: string
  WaffoSandbox: boolean
  WaffoMerchantId: string
  WaffoCurrency: string
  WaffoUnitPrice: number
  WaffoMinTopUp: number
  WaffoNotifyUrl: string
  WaffoReturnUrl: string
  WaffoPayMethods: string
  WaffoPancakeMerchantID: string
  WaffoPancakePrivateKey: string
  WaffoPancakeReturnURL: string
  // Bound by the operator through the catalog flow in the admin Pancake
  // section (saved via /api/option/waffo-pancake/save).
  WaffoPancakeStoreID: string
  WaffoPancakeProductID: string
  'checkin_setting.enabled': boolean
  'checkin_setting.min_quota': number
  'checkin_setting.max_quota': number
}

export type OperationsSettings = {
  RetryTimes: number
  DefaultCollapseSidebar: boolean
  DemoSiteEnabled: boolean
  SelfUseModeEnabled: boolean
  ChannelDisableThreshold: string
  QuotaRemindThreshold: string
  AutomaticDisableChannelEnabled: boolean
  AutomaticEnableChannelEnabled: boolean
  AutomaticDisableKeywords: string
  AutomaticDisableStatusCodes: string
  AutomaticRetryStatusCodes: string
  'monitor_setting.auto_test_channel_enabled': boolean
  'monitor_setting.auto_test_channel_minutes': number
  SMTPServer: string
  SMTPPort: string
  SMTPAccount: string
  SMTPFrom: string
  SMTPToken: string
  SMTPSSLEnabled: boolean
  SMTPForceAuthLogin: boolean
  WorkerUrl: string
  WorkerValidKey: string
  WorkerAllowHttpImageRequestEnabled: boolean
  LogConsumeEnabled: boolean
  'performance_setting.disk_cache_enabled': boolean
  'performance_setting.disk_cache_threshold_mb': number
  'performance_setting.disk_cache_max_size_mb': number
  'performance_setting.disk_cache_path': string
  'performance_setting.monitor_enabled': boolean
  'performance_setting.monitor_cpu_threshold': number
  'performance_setting.monitor_memory_threshold': number
  'performance_setting.monitor_disk_threshold': number
  'perf_metrics_setting.enabled': boolean
  'perf_metrics_setting.flush_interval': number
  'perf_metrics_setting.bucket_time': 'hour' | 'minute' | '5min'
  'perf_metrics_setting.retention_days': number
}

export type SecuritySettings = {
  ModelRequestRateLimitEnabled: boolean
  ModelRequestRateLimitCount: number
  ModelRequestRateLimitSuccessCount: number
  ModelRequestRateLimitDurationMinutes: number
  ModelRequestRateLimitGroup: string
  CheckSensitiveEnabled: boolean
  CheckSensitiveOnPromptEnabled: boolean
  SensitiveWords: string
  'fetch_setting.enable_ssrf_protection': boolean
  'fetch_setting.allow_private_ip': boolean
  'fetch_setting.domain_filter_mode': boolean
  'fetch_setting.ip_filter_mode': boolean
  'fetch_setting.domain_list': string[]
  'fetch_setting.ip_list': string[]
  'fetch_setting.allowed_ports': number[]
  'fetch_setting.apply_ip_filter_for_domain': boolean
}

export type UpstreamChannel = {
  id: number
  name: string
  base_url: string
  status: number
  type?: number
}

export type RatioType =
  | 'model_ratio'
  | 'completion_ratio'
  | 'cache_ratio'
  | 'create_cache_ratio'
  | 'image_ratio'
  | 'audio_ratio'
  | 'audio_completion_ratio'
  | 'model_price'
  | 'billing_mode'
  | 'billing_expr'

export type RatioDifference = {
  current: number | string | null
  upstreams: Record<string, number | string | 'same'>
  confidence: Record<string, boolean>
}

export type DifferencesMap = Record<
  string,
  Partial<Record<RatioType, RatioDifference>>
>

export type UpstreamChannelsResponse = {
  success: boolean
  message: string
  data: UpstreamChannel[]
}

export type UpstreamConfig = {
  id: number
  name: string
  base_url: string
  endpoint: string
}

export type FetchUpstreamRatiosRequest = {
  upstreams: UpstreamConfig[]
  timeout: number
}

export type TestResult = {
  name: string
  status: 'success' | 'error'
  error?: string
}

export type UpstreamRatiosResponse = {
  success: boolean
  message: string
  data: {
    differences: DifferencesMap
    test_results: TestResult[]
  }
}

export type PlatformCapabilities = {
  scheduling_gateway_compiled: boolean
  scheduling_gateway_active: boolean
  scheduling_gateway_owner_contract_version: number
  scheduling_gateway_route_precedence: string[]
  scheduling_gateway_preview_fail_closed_compiled: boolean
  d1_migration_status_available: boolean
  d1_migration_applied_count: number
  d1_migration_latest: string | null
  d1_expected_migration: string
  d1_expected_migration_applied: boolean
  d1_migration_set_matches: boolean
  d1_migration_ready: boolean
  ai_binding_available: boolean
  ai_gateway_id_configured: boolean
  cloudflare_account_id_configured: boolean
  cloudflare_ai_gateway_token_configured: boolean
  relay_ai_gateway_router_enabled: boolean
  relay_ai_gateway_router_ready: boolean
  relay_ai_gateway_rest_routes: string[]
  relay_ai_gateway_model_prefixes: string[]
  relay_ai_gateway_direct_fallback_prefixes: string[]
  relay_ai_gateway_cutover_guards: string[]
  relay_ai_gateway_channel_opt_in_supported: boolean
  relay_ai_gateway_rest_forwarder_compiled: boolean
  relay_ai_gateway_same_channel_fallback_compiled: boolean
  relay_ai_gateway_cross_model_fallback_compiled: boolean
  relay_ai_gateway_messages_cross_model_fallback_compiled: boolean
  relay_ai_gateway_messages_cross_model_fallback_staging_verified: boolean
  relay_ai_gateway_messages_cross_model_fallback_cutover_ready: boolean
  relay_ai_gateway_cross_model_actual_group_billing_compiled: boolean
  relay_ai_gateway_actual_group_billing_staging_smoke_compiled: boolean
  relay_ai_gateway_actual_group_billing_staging_smoke_enabled: boolean
  relay_ai_gateway_actual_group_billing_staging_smoke_ready: boolean
  relay_ai_gateway_cross_model_fallback_enabled: boolean
  relay_ai_gateway_cross_model_fallback_configured: boolean
  relay_ai_gateway_cross_model_fallback_config_valid: boolean
  relay_ai_gateway_cross_model_fallback_mapping_count: number
  relay_ai_gateway_cross_model_terminal_audit_compiled: boolean
  relay_ai_gateway_cross_model_fallback_ready: boolean
  relay_ai_gateway_cross_model_fallback_staging_verified: boolean
  relay_ai_gateway_cross_model_fallback_cutover_ready: boolean
  relay_ai_gateway_cross_model_fallback_cutover_guards: string[]
  relay_retry_times: number | null
  channel_affinity_do_available: boolean
  quota_coordinator_contract_version: number
  quota_coordinator_do_available: boolean
  quota_coordinator_shadow_enabled: boolean
  quota_coordinator_foundation_compiled: boolean
  quota_coordinator_observer_contract_compiled: boolean
  quota_coordinator_reserve_observation_compiled: boolean
  quota_coordinator_finalization_observation_compiled: boolean
  quota_coordinator_recovery_observation_compiled: boolean
  quota_coordinator_relay_observation_compiled: boolean
  quota_coordinator_retention_compaction_compiled: boolean
  quota_coordinator_reconciliation_compiled: boolean
  quota_coordinator_reconciliation_runtime_ready: boolean
  quota_coordinator_storage_retention_ready: boolean
  quota_coordinator_shadow_token_allowlist_configured: boolean
  quota_coordinator_shadow_token_allowlist_valid: boolean
  quota_coordinator_shadow_token_count: number
  quota_coordinator_tiered_only: boolean
  quota_coordinator_write_authority_enabled: boolean
  quota_coordinator_staging_verified: boolean
  quota_coordinator_shadow_runtime_ready: boolean
  quota_coordinator_cutover_ready: boolean
  quota_coordinator_cutover_guards: string[]
  realtime_sessions_do_available: boolean
  wfp_dispatch_binding_available: boolean
  wfp_dispatch_enabled: boolean
  wfp_internal_dispatch_enabled: boolean
  wfp_dispatch_failure_contract_version: number
  wfp_dispatch_failure_classes: string[]
  wfp_dispatch_failure_contract_compiled: boolean
  wfp_relay_transport_enabled: boolean
  wfp_relay_authority_secret_configured: boolean
  wfp_authority_replay_do_available: boolean
  wfp_authority_replay_do_compiled: boolean
  wfp_preview_host_suffix_configured: boolean
  wfp_worker_prefix_configured: boolean
  wfp_tenant_supported_routes: string[]
  wfp_tenant_cutover_guards: string[]
  wfp_tenant_script_plan_compiled: boolean
  wfp_tenant_rust_wasm_runtime_compiled: boolean
  wfp_tenant_route_manifest_compiled: boolean
  wfp_tenant_internal_dispatch_required_compiled: boolean
  wfp_outbound_invocation_context_compiled: boolean
  wfp_outbound_authority_verifier_compiled: boolean
  wfp_outbound_replay_guard_compiled: boolean
  wfp_tenant_response_header_guard_compiled: boolean
  wfp_preview_response_security_headers_compiled: boolean
  wfp_tenant_ai_gateway_policy_compiled: boolean
  wfp_outbound_egress_policy_compiled: boolean
  wfp_outbound_private_ingress_config_compiled: boolean
  wfp_relay_authority_transport_compiled: boolean
  wfp_relay_authority_transport_ready: boolean
  wfp_tenant_smoke_ready: boolean
  relay_billing_reservation_ledger_compiled: boolean
  relay_billing_ledger_status_compiled: boolean
  relay_billing_reservation_lease_seconds: number
  relay_billing_prebind_owner_generation_contract_version: number
  relay_billing_prebind_owner_generation_compiled: boolean
  relay_billing_prebind_owner_generation_schema_ready: boolean
  relay_billing_prebind_owner_deadline_configured: boolean
  relay_billing_prebind_owner_deadline_valid: boolean
  relay_billing_prebind_owner_deadline_seconds: number
  relay_billing_prebind_owner_generation_configured: boolean
  relay_billing_prebind_owner_generation_staging_verified: boolean
  relay_billing_prebind_owner_generation_cutover_ready: boolean
  relay_billing_prebind_owner_generation_cutover_guards: string[]
  relay_billing_stream_lease_renewal_compiled: boolean
  relay_billing_stream_lease_heartbeat_configured: boolean
  relay_billing_stream_lease_heartbeat_valid: boolean
  relay_billing_stream_lease_heartbeat_seconds: number
  relay_billing_stream_lease_renewal_staging_verified: boolean
  relay_billing_stream_error_usage_recovery_compiled: boolean
  relay_billing_stream_error_usage_recovery_staging_verified: boolean
  relay_billing_missing_usage_estimate_enabled: boolean
  relay_billing_finalization_queue_enabled: boolean
  relay_billing_finalization_queue_available: boolean
  relay_billing_finalization_consumer_compiled: boolean
  relay_billing_finalization_dlq_contract_compiled: boolean
  relay_billing_finalization_dlq_consumer_compiled: boolean
  relay_billing_finalization_replay_compiled: boolean
  relay_billing_finalization_reconcile_compiled: boolean
  relay_billing_finalization_reconcile_enabled: boolean
  relay_billing_finalization_reconcile_ready: boolean
  relay_billing_finalization_runtime_ready: boolean
  relay_billing_finalization_replay_staging_verified: boolean
  relay_billing_orphan_recovery_enabled: boolean
  relay_billing_orphan_recovery_ready: boolean
  relay_billing_orphan_recovery_cutover_ready: boolean
  relay_billing_orphan_recovery_grace_seconds: number
  relay_billing_orphan_sweep_limit: number
  realtime_session_gateway_enabled: boolean
  realtime_session_v1_enabled: boolean
  realtime_session_billing_settlement_write_enabled: boolean
  do_websocket_hibernation_compiled: boolean
  realtime_session_cutover_guards: string[]
  realtime_session_auth_boundary_compiled: boolean
  realtime_session_metrics_persisted_compiled: boolean
  realtime_session_control_no_echo_compiled: boolean
  realtime_session_upstream_bridge_planner_compiled: boolean
  realtime_session_upstream_channel_planner_compiled: boolean
  realtime_session_upstream_bridge_connect_contract_compiled: boolean
  realtime_session_upstream_connect_handoff_compiled: boolean
  realtime_session_upstream_fetch_upgrade_adapter_compiled: boolean
  realtime_session_upstream_bridge_lifecycle_compiled: boolean
  realtime_session_upstream_bridge_hibernation_fail_closed_compiled: boolean
  realtime_session_upstream_bridge_frame_guard_compiled: boolean
  realtime_session_upstream_bridge_close_mapping_compiled: boolean
  realtime_session_upstream_bridge_send_failure_guard_compiled: boolean
  realtime_session_upstream_bridge_event_trace_compiled: boolean
  realtime_session_upstream_bridge_replay_contract_compiled: boolean
  realtime_session_upstream_bridge_backpressure_policy_compiled: boolean
  realtime_session_upstream_bridge_backpressure_runtime_compiled: boolean
  realtime_session_upstream_usage_capture_compiled: boolean
  realtime_session_billing_presettlement_snapshot_compiled: boolean
  realtime_session_billing_settlement_preview_compiled: boolean
  realtime_session_billing_settlement_handoff_compiled: boolean
  realtime_session_billing_settlement_mutation_plan_compiled: boolean
  realtime_session_billing_settlement_writer_compiled: boolean
  realtime_session_billing_settlement_replay_marker_compiled: boolean
  realtime_session_billing_settlement_audit_log_compiled: boolean
  realtime_session_billing_settlement_batch_compiled: boolean
  realtime_session_billing_settlement_retry_compiled: boolean
  realtime_session_billing_reservation_lease_compiled: boolean
  realtime_session_billing_reservation_lease_seconds: number
  realtime_session_billing_global_orphan_recovery_compiled: boolean
  realtime_session_billing_global_orphan_recovery_enabled: boolean
  realtime_session_billing_global_orphan_recovery_ready: boolean
  realtime_session_billing_orphan_recovery_grace_seconds: number
  realtime_session_billing_orphan_sweep_limit: number
  realtime_session_billing_ledger_status_compiled: boolean
  realtime_session_usage_reconciliation_compiled: boolean
  realtime_session_billing_reconciliation_compiled: boolean
  realtime_session_billing_reconciliation_enabled: boolean
  realtime_session_billing_reconciliation_ready: boolean
  realtime_session_billing_settlement_staging_smoke_compiled: boolean
  realtime_session_billing_settlement_staging_smoke_enabled: boolean
  realtime_session_billing_settlement_staging_smoke_ready: boolean
  realtime_session_platform_header_boundary_compiled: boolean
  realtime_session_platform_admin_auth_compiled: boolean
  realtime_session_upstream_bridge_compiled: boolean
  realtime_session_billing_settlement_compiled: boolean
  realtime_session_platform_smoke_ready: boolean
  realtime_session_v1_cutover_ready: boolean
  task_poller_scheduled_handler_compiled: boolean
  task_poller_timeout_sweep_compiled: boolean
  task_poller_refund_batch_compiled: boolean
  task_poller_refund_replay_contract_compiled: boolean
  task_runner_do_available: boolean
  task_runner_do_enabled: boolean
  task_runner_do_foundation_compiled: boolean
  task_runner_alarm_contract_compiled: boolean
  task_runner_storage_error_retry_contract_compiled: boolean
  task_runner_rearm_contract_compiled: boolean
  task_runner_max_alarm_fires: number
  task_runner_submit_path_compiled: boolean
  task_runner_poll_path_compiled: boolean
  task_runner_status_probe_compiled: boolean
  task_runner_staging_replay_verified: boolean
  task_runner_cutover_ready: boolean
  task_runner_cutover_guards: string[]
  task_poller_timeout_sweep_enabled: boolean
  task_poller_query_limit: number
  task_poller_timeout_minutes: number
  task_poller_timeout_sweep_limit: number
}

export type TaskRunnerDurableObjectStatus = {
  compiled: boolean
  task_id: string | null
  status:
    | 'armed'
    | 'alarm_fired'
    | 'poll_skipped'
    | 'poll_noop'
    | 'poll_progressed'
    | 'poll_applied'
    | 'poll_failed'
    | null
  replay_evidence:
    | 'no_record'
    | 'armed_pending'
    | 'alarm_fired_pending_poll'
    | 'first_apply'
    | 'progress_applied'
    | 'nonterminal_cas_noop'
    | 'second_replay_noop'
    | 'gate_disabled_fallback'
    | 'cron_already_settled'
    | 'poll_skipped'
    | 'poll_failed'
    | 'unknown'
  alarm_scheduled_at_ms: number | null
  alarm_delay_ms: number | null
  alarm_fired_at_ms: number | null
  alarm_fired_count: number
  poll_attempted_at_ms: number | null
  poll_completed_at_ms: number | null
  poll_status: 'skipped' | 'noop' | 'progressed' | 'applied' | 'failed' | null
  poll_reason: string | null
  poll_cas_won: boolean | null
  poll_terminal: boolean | null
  last_rearmed_at_ms: number | null
  last_rearm_delay_ms: number | null
  rearm_count: number
  consecutive_failures: number
  max_alarm_fires: number
  cron_fallback_reason: string | null
}

export type TaskRunnerStatusProbe = {
  task_id: string
  instance: string
  durable_object_status: TaskRunnerDurableObjectStatus
}

export type PlatformCapabilitiesResponse = {
  success: boolean
  message: string
  data: PlatformCapabilities
}

export type TaskRunnerStatusProbeResponse = {
  success: boolean
  message: string
  data: TaskRunnerStatusProbe
}
