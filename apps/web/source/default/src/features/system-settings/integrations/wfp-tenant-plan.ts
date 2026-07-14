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
export type WfpTenantPlanFormInput = {
  scriptName: string
  tenantId: string
  dispatchNamespace: string
  compatibilityDate: string
}

export type WfpTenantPlanRequest = {
  script_name: string
  tenant_id?: string
  dispatch_namespace?: string
  compatibility_date?: string
}

export type WfpTenantConfigRequirement = {
  name: string
  secret: boolean
}

export type WfpTenantRouteGatewayConfiguration = {
  openai_chat: boolean
  openai_responses: boolean
  anthropic_messages: boolean
  ai_run: boolean
}

export type WfpTenantGatewayPolicyConfiguration = {
  request_timeout_ms: boolean
  max_attempts: boolean
  retry_delay_ms: boolean
  backoff: boolean
  cache_ttl_seconds: boolean
  skip_cache: boolean
  collect_log: boolean
}

export type WfpTenantRustWasmRuntimePlan = {
  available: boolean
  crate_path: string
  build_command: string
  shim_path: string
  deployment_status: string
}

export type WfpTenantPlan = {
  public_script_name: string
  script_name: string
  tenant_id: string
  namespace: string | null
  upload_url: string | null
  module_name: string
  deployment_runtime: string
  compatibility_date: string
  ai_gateway_id_configured: boolean
  route_ai_gateway_ids_configured: WfpTenantRouteGatewayConfiguration
  ai_gateway_request_policy_configured: WfpTenantGatewayPolicyConfiguration
  tenant_gateway_bindings_attached: boolean
  outbound_auth_mode: string
  tenant_cloudflare_token_attached: boolean
  artifact_upload_required: boolean
  js_fallback_ai_capable: boolean
  deployable: boolean
  missing: WfpTenantConfigRequirement[]
  warnings: string[]
  metadata: unknown
  script: string
  rust_wasm_runtime: WfpTenantRustWasmRuntimePlan
}

export type WfpTenantPlanResponse = {
  success: boolean
  message: string
  data: WfpTenantPlan
}

export type WfpTenantPlanValidationError =
  | 'script_name_required'
  | 'script_name_invalid'
  | 'tenant_id_invalid'
  | 'dispatch_namespace_invalid'
  | 'compatibility_date_invalid'

export const EMPTY_WFP_TENANT_PLAN_INPUT: WfpTenantPlanFormInput = {
  scriptName: '',
  tenantId: '',
  dispatchNamespace: '',
  compatibilityDate: '',
}

export function normalizeWfpWorkerName(value: string): string | null {
  const normalized = value.trim().toLowerCase()
  if (
    normalized.length === 0 ||
    normalized.length > 63 ||
    normalized.startsWith('-') ||
    normalized.endsWith('-') ||
    normalized.startsWith('_') ||
    normalized.endsWith('_') ||
    !/^[a-z0-9_-]+$/.test(normalized)
  ) {
    return null
  }
  return normalized
}

export function validateWfpTenantPlanInput(
  input: WfpTenantPlanFormInput
): WfpTenantPlanValidationError | null {
  if (input.scriptName.trim().length === 0) return 'script_name_required'
  if (!normalizeWfpWorkerName(input.scriptName)) return 'script_name_invalid'
  if (!isOptionalHeaderValue(input.tenantId)) return 'tenant_id_invalid'
  if (!isOptionalDispatchNamespace(input.dispatchNamespace)) {
    return 'dispatch_namespace_invalid'
  }
  if (!isOptionalCompatibilityDate(input.compatibilityDate)) {
    return 'compatibility_date_invalid'
  }
  return null
}

export function buildWfpTenantPlanRequest(
  input: WfpTenantPlanFormInput
): WfpTenantPlanRequest {
  const validationError = validateWfpTenantPlanInput(input)
  if (validationError) {
    throw new Error(validationError)
  }

  return compactOptionalFields({
    script_name: normalizeWfpWorkerName(input.scriptName)!,
    tenant_id: input.tenantId,
    dispatch_namespace: input.dispatchNamespace.toLowerCase(),
    compatibility_date: input.compatibilityDate,
  })
}

export function buildRedactedWfpTenantPlanArchive(plan: WfpTenantPlan) {
  return {
    archive_schema: 'wfp-tenant-plan-redacted-v1',
    identifiers_redacted: true,
    namespace_configured: plan.namespace !== null,
    upload_target_ready: plan.upload_url !== null,
    module_name: plan.module_name,
    deployment_runtime: plan.deployment_runtime,
    compatibility_date: plan.compatibility_date,
    ai_gateway_id_configured: plan.ai_gateway_id_configured,
    route_ai_gateway_ids_configured: {
      ...plan.route_ai_gateway_ids_configured,
    },
    ai_gateway_request_policy_configured: {
      ...plan.ai_gateway_request_policy_configured,
    },
    tenant_gateway_bindings_attached: plan.tenant_gateway_bindings_attached,
    outbound_auth_mode: plan.outbound_auth_mode,
    tenant_cloudflare_token_attached: plan.tenant_cloudflare_token_attached,
    artifact_upload_required: plan.artifact_upload_required,
    js_fallback_ai_capable: plan.js_fallback_ai_capable,
    deployable: plan.deployable,
    missing: plan.missing.map(({ name, secret }) => ({ name, secret })),
    warnings: [...plan.warnings],
    rust_wasm_runtime: { ...plan.rust_wasm_runtime },
  }
}

export function stringifyRedactedWfpTenantPlanArchive(plan: WfpTenantPlan) {
  return JSON.stringify(buildRedactedWfpTenantPlanArchive(plan), null, 2)
}

function isOptionalHeaderValue(value: string) {
  const trimmed = value.trim()
  return (
    trimmed.length === 0 ||
    (trimmed.length <= 128 && !Array.from(trimmed).some(isControlCharacter))
  )
}

function isOptionalDispatchNamespace(value: string) {
  const normalized = value.trim().toLowerCase()
  return (
    normalized.length === 0 ||
    (normalized.length <= 64 && /^[a-z0-9_-]+$/.test(normalized))
  )
}

function isOptionalCompatibilityDate(value: string) {
  const trimmed = value.trim()
  return trimmed.length === 0 || /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
}

function isControlCharacter(value: string) {
  const codePoint = value.codePointAt(0) ?? 0
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
}

function compactOptionalFields<T extends Record<string, string>>(
  value: T
): WfpTenantPlanRequest {
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, fieldValue]) => {
      const trimmed = fieldValue.trim()
      return trimmed.length > 0 ? [[key, trimmed]] : []
    })
  ) as WfpTenantPlanRequest
}
