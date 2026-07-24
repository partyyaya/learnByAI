import { useCallback, useRef, useState } from 'react'
import { isApiError } from '@/types'

export interface UseAsyncResult<T> {
  data: T | null
  loading: boolean
  error: string | null
  run: () => Promise<void>
}

// 泛型的非同步 hook：包裝任一回傳 Promise<T> 的函式，統一管理 data / loading / error。
// 以 useCallback 記憶 run，避免每次 render 產生新函式而觸發 useEffect 重複執行（stale-closure 陷阱）。
export function useAsync<T>(fn: () => Promise<T>): UseAsyncResult<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 記錄「目前最新一次呼叫」的序號，用來丟棄過期的結果。
  // 情境：例如使用者在詳情頁快速切換不同 :id，較早那次的 fn() 可能比較晚 resolve
  // （網路順序不保證），若不做這層判斷，舊結果就可能覆蓋新結果、顯示錯誤的資料
  // （例如 A 使用者的文章短暫顯示在 B 使用者的頁面下）。
  const latestRunId = useRef(0)

  const run = useCallback(async () => {
    const runId = ++latestRunId.current
    setLoading(true)
    setError(null)
    try {
      const result = await fn()
      if (runId !== latestRunId.current) return // 已經有更新的 run() 呼叫，這次結果過期，捨棄
      setData(result)
    } catch (err) {
      if (runId !== latestRunId.current) return
      setError(isApiError(err) ? err.message : '載入失敗')
    } finally {
      if (runId === latestRunId.current) {
        setLoading(false)
      }
    }
  }, [fn])

  return { data, loading, error, run }
}
