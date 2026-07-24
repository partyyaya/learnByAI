import axios, {
  AxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
} from 'axios'
import type { ApiError } from '@/types'

// 建立共用的 axios 實例。baseURL 由環境變數提供，沒設定時退回公開 API。
const client: AxiosInstance = axios.create({
  baseURL:
    import.meta.env.VITE_API_BASE_URL ?? 'https://jsonplaceholder.typicode.com',
  timeout: 10000,
})

// 請求攔截器：加上示範用的自訂標頭；並示範真實專案如何附上驗證 token。
client.interceptors.request.use((config) => {
  config.headers.set('X-Demo-Client', 'ts-course')

  // 真實專案通常會從 localStorage（或其他來源）讀取 token 附到 Authorization。
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

// 回應攔截器：把任何 AxiosError 正規化成 ApiError（{ status, message }）後 reject。
client.interceptors.response.use(
  (response) => response,
  (error: AxiosError) => {
    const apiError: ApiError = {
      status: error.response?.status ?? 0,
      message: error.message || '發生未知的網路錯誤',
    }
    return Promise.reject(apiError)
  },
)

// 型別化的 GET 輔助函式：讓呼叫端直接拿到 T，而不是 AxiosResponse<T>。
export async function get<T>(
  url: string,
  config?: AxiosRequestConfig,
): Promise<T> {
  const res = await client.get<T>(url, config)
  return res.data
}

export default client
