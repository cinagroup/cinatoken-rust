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
import { z } from 'zod'

// ============================================================================
// Subscription Plan Schema & Types
// ============================================================================

export const subscriptionPlanSchema = z.object({
  id: z.number(),
  title: z.string(),
  subtitle: z.string().optional(),
  price_amount: z.number(),
  currency: z.string().default('USD'),
  duration_unit: z.enum(['year', 'month', 'day', 'hour', 'custom']),
  duration_value: z.number(),
  custom_seconds: z.number().optional(),
  quota_reset_period: z.enum(['never', 'daily', 'weekly', 'monthly', 'custom']),
  quota_reset_custom_seconds: z.number().optional(),
  enabled: z.boolean(),
  sort_order: z.number(),
  allow_balance_pay: z.boolean().optional().default(true),
  max_purchase_per_user: z.number(),
  total_amount: z.number(),
  upgrade_group: z.string().optional(),
  stripe_price_id: z.string().optional(),
  creem_product_id: z.string().optional(),
  waffo_pancake_product_id: z.string().optional(),
})

export type SubscriptionPlan = z.infer<typeof subscriptionPlanSchema>

export interface PlanRecord {
  plan: SubscriptionPlan
}

// ============================================================================
// User Subscription Schema & Types
// ============================================================================

export const userSubscriptionSchema = z.object({
  id: z.number(),
  user_id: z.number(),
  plan_id: z.number(),
  status: z.string(),
  source: z.string().optional(),
  start_time: z.number(),
  end_time: z.number(),
  amount_total: z.number(),
  amount_used: z.number(),
  next_reset_time: z.number().optional(),
})

export type UserSubscription = z.infer<typeof userSubscriptionSchema>

export interface UserSubscriptionRecord {
  subscription: UserSubscription
}

// ============================================================================
// API Request/Response Types
// ============================================================================

export interface ApiResponse<T = unknown> {
  success: boolean
  message?: string
  data?: T
}

export interface PlanPayload {
  plan: Partial<SubscriptionPlan>
}

export interface SubscriptionPayRequest {
  plan_id: number
  payment_method?: string
}

export interface SubscriptionPayResponse {
  success: boolean
  message?: string
  data?: {
    // Stripe-style hosted checkout link.
    pay_link?: string
    // Waffo Pancake / Creem hosted checkout URL.
    checkout_url?: string
    // Pancake-only: order metadata + self-service buyer session token,
    // surfaced for future flows (refund / cancel from cinatoken's own UI).
    session_id?: string
    expires_at?: number | string
    order_id?: string
    token?: string
    token_expires_at?: number | string
  }
  url?: string
}

export interface CreateUserSubscriptionRequest {
  plan_id: number
}

// ============================================================================
// Self Subscription Data (user-facing)
// ============================================================================

export const billingPreferences = [
  'subscription_first',
  'wallet_first',
  'subscription_only',
  'wallet_only',
] as const

export type BillingPreference = (typeof billingPreferences)[number]

export interface SelfSubscriptionData {
  billing_preference: string
  funding_source_ready?: boolean
  supported_funding_surfaces?: string[]
  subscriptions: UserSubscriptionRecord[]
  all_subscriptions: UserSubscriptionRecord[]
}

type SubscriptionFundingCapability = Pick<
  SelfSubscriptionData,
  'funding_source_ready' | 'supported_funding_surfaces'
>

export function isSubscriptionFundingSourceReady(
  capability: SubscriptionFundingCapability | null | undefined
): boolean {
  return (
    capability?.funding_source_ready === true &&
    Array.isArray(capability.supported_funding_surfaces) &&
    capability.supported_funding_surfaces.length > 0
  )
}

export function canSelectBillingPreference(
  preference: BillingPreference,
  fundingSourceReady: boolean,
  hasActiveSubscription: boolean
): boolean {
  if (!fundingSourceReady) return preference === 'wallet_only'
  if (!hasActiveSubscription) {
    return !['subscription_first', 'subscription_only'].includes(preference)
  }
  return true
}

export function getDisplayedBillingPreference(
  preference: BillingPreference,
  fundingSourceReady: boolean,
  hasActiveSubscription: boolean
): BillingPreference {
  if (!fundingSourceReady) return preference
  if (
    !hasActiveSubscription &&
    ['subscription_first', 'subscription_only'].includes(preference)
  ) {
    return 'wallet_first'
  }
  return preference
}

// ============================================================================
// Dialog Types
// ============================================================================

export type SubscriptionsDialogType = 'create' | 'update' | 'toggle-status'
