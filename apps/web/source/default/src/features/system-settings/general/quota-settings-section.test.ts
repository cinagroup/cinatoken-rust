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
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'

const source = readFileSync(
  new URL('./quota-settings-section.tsx', import.meta.url),
  'utf8'
)

describe('free-model base balance policy copy', () => {
  test('limits the setting to base admission and reservation', () => {
    assert.match(source, /Require Base Balance for Free Models/)
    assert.match(
      source,
      /Controls base balance admission and base quota reservation for zero-base-cost models\./
    )
  })

  test('keeps usage-based tool and audio add-ons explicit', () => {
    assert.match(
      source,
      /Tool and audio add-ons are still charged from final usage when applicable\./
    )
    assert.doesNotMatch(
      source,
      /zero-cost models also pre-consume quota before final settlement/
    )
  })
})
