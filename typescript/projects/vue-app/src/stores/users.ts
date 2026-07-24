import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { getUsers, getUser } from '@/api/users'
import { isApiError, type User } from '@/types'

// 使用 Pinia 的 setup 語法（composition 風格），對 TS 型別推論最友善。
export const useUsersStore = defineStore('users', () => {
  // state
  const users = ref<User[]>([])
  const current = ref<User | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  // getters
  const userCount = computed(() => users.value.length)

  // actions
  async function fetchUsers(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      users.value = await getUsers()
    } catch (err) {
      error.value = isApiError(err) ? err.message : '載入使用者失敗'
    } finally {
      loading.value = false
    }
  }

  async function fetchUser(id: number): Promise<void> {
    loading.value = true
    error.value = null
    try {
      current.value = await getUser(id)
    } catch (err) {
      error.value = isApiError(err) ? err.message : '載入使用者失敗'
    } finally {
      loading.value = false
    }
  }

  return {
    users,
    current,
    loading,
    error,
    userCount,
    fetchUsers,
    fetchUser,
  }
})
