import axios, {
  AxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
} from 'axios'
import type { ApiError } from '@/types'

// 建立 axios 實例：baseURL 讀環境變數，讀不到就 fallback 到公開 API
const client: AxiosInstance = axios.create({
  baseURL:
    import.meta.env.VITE_API_BASE_URL ?? 'https://jsonplaceholder.typicode.com',
  timeout: 10000,
})

// 請求攔截器：統一附加標頭
client.interceptors.request.use((config) => {
  // 示範用的自訂標頭
  config.headers.set('X-Demo-Client', 'ts-course')

  // 真實專案中，這裡會從 localStorage 取出 token 並附加到 Authorization。
  // 範例僅示範位置，JSONPlaceholder 不需要驗證。
  // 私密瀏覽模式等環境下 localStorage 可能直接丟出例外，這裡用 try/catch 保護，
  // 避免「讀不到 token」這種小事拖垮整個請求（包含完全不需要驗證的請求）。
  try {
    const token = localStorage.getItem('token')
    if (token) {
      config.headers.set('Authorization', `Bearer ${token}`)
    }
  } catch {
    // 讀取失敗就當作沒有 token，不影響請求繼續送出
  }

  return config
})

// 回應攔截器：把任何 AxiosError 正規化成 ApiError（{ status, message }）後再 reject
client.interceptors.response.use(
  (response) => response,
  (error: AxiosError<{ message?: string }>) => {
    const apiError: ApiError = {
      // 沒有回應（例如逾時、斷線）時，status 以 0 表示
      status: error.response?.status ?? 0,
      // 優先採用後端回傳的錯誤訊息，否則退回 axios 的訊息
      message: error.response?.data?.message ?? error.message ?? '未知錯誤',
    }
    return Promise.reject(apiError)
  },
)

// 型別化的 GET 輔助函式：呼叫端拿到的是 T，而不是 AxiosResponse<T>
export async function get<T>(
  url: string,
  config?: AxiosRequestConfig,
): Promise<T> {
  const res = await client.get<T>(url, config)
  return res.data
}

export default client
