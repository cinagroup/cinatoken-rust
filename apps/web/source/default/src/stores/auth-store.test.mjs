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
import { beforeEach, describe, expect, test } from 'bun:test'
import { api } from '../lib/api.ts'
import { clearAuthSession, useAuthStore } from './auth-store.ts'

const user = {
  id: 7,
  username: 'session-user',
  role: 1,
}

async function rejectWithUnauthorized(authGeneration) {
  await api
    .get('/test/session-generation', {
      authGeneration,
      disableDuplicate: true,
      skipErrorHandler: true,
      adapter: async (config) =>
        Promise.reject({ config, response: { status: 401 } }),
    })
    .catch(() => null)
}

beforeEach(() => {
  clearAuthSession()
})

describe('auth session verification lifecycle', () => {
  test('commits verification only for the current generation', () => {
    useAuthStore.getState().auth.setUser(user)
    const generation = useAuthStore.getState().auth.verificationGeneration

    expect(useAuthStore.getState().auth.verifiedGeneration).toBeNull()
    expect(
      useAuthStore
        .getState()
        .auth.commitSessionVerification(
          { ...user, display_name: 'Verified user' },
          generation
        )
    ).toBe(true)
    expect(useAuthStore.getState().auth.verifiedGeneration).toBe(generation)
    expect(useAuthStore.getState().auth.user?.display_name).toBe(
      'Verified user'
    )
  })

  test('logout or 401 clear invalidates verification before relogin', () => {
    useAuthStore.getState().auth.setUser(user)
    const previousGeneration =
      useAuthStore.getState().auth.verificationGeneration
    expect(
      useAuthStore
        .getState()
        .auth.commitSessionVerification(user, previousGeneration)
    ).toBe(true)

    expect(clearAuthSession()).toBe(true)
    expect(useAuthStore.getState().auth.user).toBeNull()
    expect(useAuthStore.getState().auth.verifiedGeneration).toBeNull()

    useAuthStore.getState().auth.setUser(user)
    const reloginGeneration =
      useAuthStore.getState().auth.verificationGeneration
    expect(reloginGeneration).toBeGreaterThan(previousGeneration)
    expect(useAuthStore.getState().auth.verifiedGeneration).toBeNull()
    expect(
      useAuthStore
        .getState()
        .auth.commitSessionVerification(user, previousGeneration)
    ).toBe(false)
  })

  test('stale verification cannot clear a newer authenticated session', () => {
    useAuthStore.getState().auth.setUser(user)
    const staleGeneration = useAuthStore.getState().auth.verificationGeneration

    const newerUser = { ...user, username: 'new-session-user' }
    useAuthStore.getState().auth.setUser(newerUser)

    expect(clearAuthSession(staleGeneration)).toBe(false)
    expect(useAuthStore.getState().auth.user).toEqual(newerUser)
    expect(
      useAuthStore
        .getState()
        .auth.commitSessionVerification(user, staleGeneration)
    ).toBe(false)
  })

  test('stale request 401 cannot clear a newer authenticated session', async () => {
    useAuthStore.getState().auth.setUser(user)
    const staleGeneration = useAuthStore.getState().auth.verificationGeneration
    const newerUser = { ...user, username: 'new-session-user' }
    useAuthStore.getState().auth.setUser(newerUser)

    await rejectWithUnauthorized(staleGeneration)

    expect(useAuthStore.getState().auth.user).toEqual(newerUser)
  })

  test('current request 401 clears the authenticated session', async () => {
    useAuthStore.getState().auth.setUser(user)
    const currentGeneration =
      useAuthStore.getState().auth.verificationGeneration

    await rejectWithUnauthorized(currentGeneration)

    expect(useAuthStore.getState().auth.user).toBeNull()
  })

  test('GET deduplication is isolated by auth generation', async () => {
    useAuthStore.getState().auth.setUser(user)
    const oldGeneration = useAuthStore.getState().auth.verificationGeneration
    let adapterCalls = 0
    const adapter = async (config) => {
      adapterCalls += 1
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { config, data: {}, headers: {}, status: 200, statusText: 'OK' }
    }

    const oldRequest = api.get('/test/session-deduplication', {
      authGeneration: oldGeneration,
      adapter,
    })
    const oldDuplicate = api.get('/test/session-deduplication', {
      authGeneration: oldGeneration,
      adapter,
    })
    expect(oldDuplicate).toBe(oldRequest)

    useAuthStore
      .getState()
      .auth.setUser({ ...user, username: 'new-session-user' })
    const newGeneration = useAuthStore.getState().auth.verificationGeneration
    const newRequest = api.get('/test/session-deduplication', {
      authGeneration: newGeneration,
      adapter,
    })

    await Promise.all([oldRequest, oldDuplicate, newRequest])
    expect(adapterCalls).toBe(2)
  })
})
