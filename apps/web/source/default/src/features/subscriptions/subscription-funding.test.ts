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
  billingPreferences,
  canSelectBillingPreference,
  getDisplayedBillingPreference,
  isSubscriptionFundingSourceReady,
} from './types'

describe('subscription funding capability', () => {
  test('fails closed when the capability is false, missing, or empty', () => {
    assert.equal(isSubscriptionFundingSourceReady(undefined), false)
    assert.equal(
      isSubscriptionFundingSourceReady({
        funding_source_ready: false,
        supported_funding_surfaces: [],
      }),
      false
    )
    assert.equal(
      isSubscriptionFundingSourceReady({
        funding_source_ready: true,
        supported_funding_surfaces: [],
      }),
      false
    )
  })

  test('requires explicit readiness and at least one supported surface', () => {
    assert.equal(
      isSubscriptionFundingSourceReady({
        funding_source_ready: true,
        supported_funding_surfaces: ['api'],
      }),
      true
    )
  })

  test('allows only wallet_only while funding sources are unavailable', () => {
    const selectable = billingPreferences.filter((preference) =>
      canSelectBillingPreference(preference, false, true)
    )

    assert.deepEqual(selectable, ['wallet_only'])
  })

  test('keeps an existing non-wallet preference visible while unavailable', () => {
    assert.equal(
      getDisplayedBillingPreference('subscription_first', false, true),
      'subscription_first'
    )
    assert.equal(
      getDisplayedBillingPreference('wallet_first', false, true),
      'wallet_first'
    )
  })

  test('keeps purchase-independent preferences available when ready', () => {
    assert.equal(canSelectBillingPreference('wallet_first', true, false), true)
    assert.equal(canSelectBillingPreference('wallet_only', true, false), true)
    assert.equal(
      canSelectBillingPreference('subscription_first', true, false),
      false
    )
    assert.equal(
      canSelectBillingPreference('subscription_only', true, true),
      true
    )
  })
})
