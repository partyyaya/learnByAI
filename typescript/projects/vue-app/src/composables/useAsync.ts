import { ref, type Ref } from 'vue'
import { isApiError } from '@/types'

// useAsync 的回傳型別
export interface UseAsyncReturn<T> {
  data: Ref<T | null>
  loading: Ref<boolean>
  error: Ref<string | null>
  run: () => Promise<void>
}

/**
 * 泛型非同步 composable：包裝任意 `() => Promise<T>`，
 * 自動管理 data / loading / error 三種狀態。
 */
export function useAsync<T>(fn: () => Promise<T>): UseAsyncReturn<T> {
  const data = ref<T | null>(null) as Ref<T | null>
  const loading = ref(false)
  const error = ref<string | null>(null)

  // 記錄「目前最新一次呼叫」的序號，用來丟棄過期的結果。
  // 情境：使用者連續呼叫 run()（例如快速切換不同 :id 的頁面）時，
  // 較早呼叫的 fn() 可能比較晚 resolve（網路順序不保證），
  // 若不做這層判斷，舊結果就可能覆蓋新結果、顯示錯誤的資料。
  let latestRunId = 0

  async function run(): Promise<void> {
    const runId = ++latestRunId
    loading.value = true
    error.value = null
    try {
      const result = await fn()
      if (runId !== latestRunId) return // 已經有更新的 run() 呼叫，這次結果過期，捨棄
      data.value = result
    } catch (err) {
      if (runId !== latestRunId) return
      // 攔截器已把錯誤正規化成 ApiError；用型別守衛而非 as 斷言取出訊息
      error.value = isApiError(err) ? err.message : '載入失敗'
    } finally {
      if (runId === latestRunId) {
        loading.value = false
      }
    }
  }

  return { data, loading, error, run }
}
