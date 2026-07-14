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
import { api } from '@/lib/api'
import {
  buildQuotaCoordinatorReconciliationRequest,
  type CanonicalPositiveI64String,
  type QuotaCoordinatorReconciliationResponse,
} from './integrations/quota-coordinator-reconciliation'
import {
  normalizeRealtimeBillingLedgerStatus,
  type RealtimeBillingReconciliationApplyRequest,
  type RealtimeBillingReconciliationApplyResponse,
  type RealtimeBillingReconciliationDecision,
  type RealtimeBillingReconciliationPreviewResponse,
  type RealtimeBillingReconciliationQueueResponse,
  type RealtimeBillingLedgerResponse,
} from './integrations/realtime-billing-ledger'
import {
  buildWfpTenantPlanRequest,
  type WfpTenantPlanFormInput,
  type WfpTenantPlanResponse,
} from './integrations/wfp-tenant-plan'
import type {
  ConfirmPaymentComplianceResponse,
  DeleteLogsResponse,
  FetchUpstreamRatiosRequest,
  PlatformCapabilitiesResponse,
  SystemOptionsResponse,
  TaskRunnerStatusProbeResponse,
  UpdateOptionRequest,
  UpdateOptionResponse,
  UpstreamChannelsResponse,
  UpstreamRatiosResponse,
} from './types'

export async function getSystemOptions() {
  const res = await api.get<SystemOptionsResponse>('/api/option/')
  return res.data
}

export async function updateSystemOption(request: UpdateOptionRequest) {
  const res = await api.put<UpdateOptionResponse>('/api/option/', request)
  return res.data
}

export async function confirmPaymentCompliance() {
  const res = await api.post<ConfirmPaymentComplianceResponse>(
    '/api/option/payment_compliance',
    { confirmed: true }
  )
  return res.data
}

export async function deleteLogsBefore(targetTimestamp: number) {
  const res = await api.delete<DeleteLogsResponse>('/api/log/', {
    params: { target_timestamp: targetTimestamp },
  })
  return res.data
}

export async function resetModelRatios() {
  const res = await api.post<UpdateOptionResponse>(
    '/api/option/rest_model_ratio'
  )
  return res.data
}

export async function getUpstreamChannels() {
  const res = await api.get<UpstreamChannelsResponse>(
    '/api/ratio_sync/channels'
  )
  return res.data
}

export async function fetchUpstreamRatios(request: FetchUpstreamRatiosRequest) {
  const res = await api.post<UpstreamRatiosResponse>(
    '/api/ratio_sync/fetch',
    request
  )
  return res.data
}

export async function getPlatformCapabilities() {
  const res = await api.get<PlatformCapabilitiesResponse>(
    '/api/platform/capabilities'
  )
  return res.data
}

export async function getTaskRunnerStatus(taskId: string) {
  const res = await api.get<TaskRunnerStatusProbeResponse>(
    `/api/platform/task-runner/${encodeURIComponent(taskId)}/status`,
    { disableDuplicate: true }
  )
  return res.data
}

export async function getRealtimeBillingLedgerStatus() {
  const res = await api.get<RealtimeBillingLedgerResponse>(
    '/api/platform/realtime-billing/ledger/status',
    { disableDuplicate: true }
  )
  return {
    ...res.data,
    data: normalizeRealtimeBillingLedgerStatus(res.data.data),
  }
}

export async function previewRealtimeBillingReconciliation(
  reconciliationId: string,
  decision: RealtimeBillingReconciliationDecision
) {
  const res = await api.post<RealtimeBillingReconciliationPreviewResponse>(
    `/api/platform/realtime-billing/reconciliations/${encodeURIComponent(reconciliationId)}/preview`,
    decision,
    { disableDuplicate: true }
  )
  return res.data
}

export async function getRealtimeBillingReconciliationQueue(
  cursor?: string
) {
  const res = await api.get<RealtimeBillingReconciliationQueueResponse>(
    '/api/platform/realtime-billing/reconciliations',
    {
      disableDuplicate: true,
      params: { limit: 50, ...(cursor ? { cursor } : {}) },
    }
  )
  return res.data
}

export async function applyRealtimeBillingReconciliation(
  reconciliationId: string,
  request: RealtimeBillingReconciliationApplyRequest
) {
  const res = await api.post<RealtimeBillingReconciliationApplyResponse>(
    `/api/platform/realtime-billing/reconciliations/${encodeURIComponent(reconciliationId)}/apply`,
    request,
    { disableDuplicate: true }
  )
  return res.data
}

export async function reconcileQuotaCoordinator(
  tokenId: CanonicalPositiveI64String
) {
  const res = await api.post<QuotaCoordinatorReconciliationResponse>(
    '/api/platform/quota-coordinator/reconciliation',
    buildQuotaCoordinatorReconciliationRequest(tokenId)
  )
  return res.data
}

export async function getWfpTenantPlan(input: WfpTenantPlanFormInput) {
  const res = await api.post<WfpTenantPlanResponse>(
    '/api/platform/wfp/tenant-script/plan',
    buildWfpTenantPlanRequest(input)
  )
  return res.data
}
