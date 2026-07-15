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
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  buildRedactedWfpTenantPlanArchive,
  buildWfpTenantPlanRequest,
  EMPTY_WFP_TENANT_PLAN_INPUT,
  normalizeWfpWorkerName,
  stringifyRedactedWfpTenantPlanArchive,
  validateWfpTenantPlanInput,
  type WfpTenantPlan,
} from './wfp-tenant-plan'

const PLAN: WfpTenantPlan = {
  public_script_name: 'tenant-secret',
  script_name: 'prod-tenant-secret',
  tenant_id: 'customer-secret',
  namespace: 'production',
  upload_url:
    'https://api.cloudflare.com/client/v4/accounts/account-secret/workers/dispatch/namespaces/production/scripts/prod-tenant-secret',
  module_name: 'tenant.mjs',
  deployment_runtime: 'js-fallback',
  compatibility_date: '2026-07-14',
  ai_gateway_id_configured: true,
  route_ai_gateway_ids_configured: {
    openai_chat: true,
    openai_responses: false,
    anthropic_messages: true,
    ai_run: false,
  },
  ai_gateway_request_policy_configured: {
    request_timeout_ms: true,
    max_attempts: true,
    retry_delay_ms: false,
    backoff: false,
    cache_ttl_seconds: false,
    skip_cache: true,
    collect_log: true,
  },
  tenant_gateway_bindings_attached: false,
  outbound_auth_mode: 'platform-outbound-v1',
  tenant_cloudflare_token_attached: false,
  artifact_upload_required: true,
  js_fallback_ai_capable: false,
  deployable: false,
  missing: [{ name: 'CLOUDFLARE_ACCOUNT_ID', secret: false }],
  warnings: ['Rust/Wasm artifact upload is required.'],
  metadata: {
    bindings: [{ name: 'AI_GATEWAY_ID', text: 'gateway-secret' }],
  },
  script: 'const embeddedSecret = "script-secret"',
  rust_wasm_runtime: {
    available: true,
    crate_path: 'crates/wfp-tenant',
    build_command: 'bun run build:wfp-tenant',
    shim_path: 'crates/wfp-tenant/build/index.js',
    deployment_status: 'artifact_upload_tool_required',
  },
}

describe('WFP tenant plan input', () => {
  test('normalizes the Worker name and omits empty optional fields', () => {
    assert.deepEqual(
      buildWfpTenantPlanRequest({
        ...EMPTY_WFP_TENANT_PLAN_INPUT,
        scriptName: ' Tenant_A ',
        dispatchNamespace: ' Staging_NS ',
      }),
      {
        script_name: 'tenant_a',
        dispatch_namespace: 'staging_ns',
      }
    )
  })

  test('mirrors backend validation for names and bounded identifiers', () => {
    assert.equal(normalizeWfpWorkerName('Tenant-A'), 'tenant-a')
    assert.equal(normalizeWfpWorkerName('-tenant'), null)
    assert.equal(
      validateWfpTenantPlanInput({
        ...EMPTY_WFP_TENANT_PLAN_INPUT,
        scriptName: 'tenant-a',
        dispatchNamespace: '../production',
      }),
      'dispatch_namespace_invalid'
    )
  })

  test('rejects missing names and malformed compatibility dates', () => {
    assert.equal(
      validateWfpTenantPlanInput(EMPTY_WFP_TENANT_PLAN_INPUT),
      'script_name_required'
    )
    assert.equal(
      validateWfpTenantPlanInput({
        ...EMPTY_WFP_TENANT_PLAN_INPUT,
        scriptName: 'tenant-a',
        compatibilityDate: '07/14/2026',
      }),
      'compatibility_date_invalid'
    )
  })
})

describe('WFP tenant plan archive', () => {
  test('keeps only the deployment evidence allowlist', () => {
    const archive = buildRedactedWfpTenantPlanArchive(PLAN)
    assert.deepEqual(
      {
        archive_schema: archive.archive_schema,
        identifiers_redacted: archive.identifiers_redacted,
        namespace_configured: archive.namespace_configured,
        upload_target_ready: archive.upload_target_ready,
        deployable: archive.deployable,
        artifact_upload_required: archive.artifact_upload_required,
        tenant_cloudflare_token_attached:
          archive.tenant_cloudflare_token_attached,
        tenant_gateway_bindings_attached:
          archive.tenant_gateway_bindings_attached,
      },
      {
        archive_schema: 'wfp-tenant-plan-redacted-v1',
        identifiers_redacted: true,
        namespace_configured: true,
        upload_target_ready: true,
        deployable: false,
        artifact_upload_required: true,
        tenant_cloudflare_token_attached: false,
        tenant_gateway_bindings_attached: false,
      }
    )

    const raw = stringifyRedactedWfpTenantPlanArchive(PLAN)
    for (const forbidden of [
      'tenant-secret',
      'customer-secret',
      'account-secret',
      'gateway-secret',
      'script-secret',
      'upload_url',
      'metadata',
      '"script"',
    ]) {
      assert.equal(
        raw.includes(forbidden),
        false,
        `archive contains ${forbidden}`
      )
    }
  })
})
