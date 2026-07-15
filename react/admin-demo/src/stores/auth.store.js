import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { setAuthToken } from '@/services/http'

// 登入態屬於「跨頁共用的本地狀態」，用 Zustand 管理並 persist 到 localStorage，
// 讓重新整理後仍維持登入。對應課程第 11 章。
//
// 注意：token 同時要同步給 http 層（攔截器注入 Authorization），
// 因此 login/logout 與 rehydrate 都會呼叫 setAuthToken。
export const useAuthStore = create(
  persist(
    (set) => ({
      token: '',
      user: null,

      // 由 LoginPage 呼叫（拿到 authApi.login 的結果後）
      setSession: ({ token, user }) => {
        setAuthToken(token)
        set({ token, user })
      },

      logout: () => {
        setAuthToken('')
        set({ token: '', user: null })
      },
    }),
    {
      name: 'admin-auth',
      // 還原時把 token 重新灌回 http 攔截器
      onRehydrateStorage: () => (state) => {
        if (state?.token) setAuthToken(state.token)
      },
    }
  )
)

// 是否已登入的衍生判斷（元件可用 selector 取用）
export const selectIsAuthenticated = (state) => Boolean(state.token)
