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
import { createFileRoute, redirect } from '@tanstack/react-router'
import { clearAuthSession, useAuthStore } from '@/stores/auth-store'
import { getSelf } from '@/lib/api'
import { AuthenticatedLayout } from '@/components/layout'

export const Route = createFileRoute('/_authenticated')({
  beforeLoad: async ({ location }) => {
    const { auth } = useAuthStore.getState()

    // 如果本地没有用户信息，直接跳转登录页
    if (!auth.user) {
      throw redirect({
        to: '/sign-in',
        search: { redirect: location.href },
      })
    }

    // 本地有用户信息，但需要验证 session 是否有效（每个会话只验证一次）
    const verificationGeneration = auth.verificationGeneration
    if (auth.verifiedGeneration !== verificationGeneration) {
      const res = await getSelf(verificationGeneration).catch(() => null)
      if (res?.success && res.data) {
        const committed = useAuthStore
          .getState()
          .auth.commitSessionVerification(res.data, verificationGeneration)
        if (committed) return
      }

      // Only clear the session that initiated this request. A newer login must
      // not be overwritten by a stale verification result.
      if (!clearAuthSession(verificationGeneration)) return
      throw redirect({
        to: '/sign-in',
        search: { redirect: location.href },
      })
    }
  },
  component: AuthenticatedLayout,
})
