import { create } from 'zustand'
import { getUser, getUsers } from '@/api/users'
import { isApiError, type User } from '@/types'

interface UserState {
  users: User[]
  current: User | null
  loading: boolean
  error: string | null
  fetchUsers: () => Promise<void>
  fetchUser: (id: number) => Promise<void>
}

// 使用 curried 的 create<T>()(...) 形式，讓 TypeScript 正確推論
export const useUserStore = create<UserState>()((set) => ({
  users: [],
  current: null,
  loading: false,
  error: null,

  async fetchUsers() {
    set({ loading: true, error: null })
    try {
      const users = await getUsers()
      set({ users, loading: false })
    } catch (error) {
      set({
        loading: false,
        error: isApiError(error) ? error.message : '載入使用者失敗',
      })
    }
  },

  async fetchUser(id: number) {
    set({ loading: true, error: null })
    try {
      const current = await getUser(id)
      set({ current, loading: false })
    } catch (error) {
      set({
        loading: false,
        error: isApiError(error) ? error.message : '載入使用者失敗',
      })
    }
  },
}))
