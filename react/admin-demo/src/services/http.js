import axios from 'axios'

// 全專案唯一的 axios 實例。所有 API 都經由它送出，好處：
// - 統一 baseURL 與逾時
// - 統一在 request 攔截器注入 token
// - 統一在 response 攔截器攤平資料與轉換錯誤訊息
//
// 對應課程第 7 章「API 串接」的正式版：把散落在元件裡的 fetch 收斂成一層。

const http = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '/api',
  timeout: 10000,
})

// token 存在模組層，由 auth store 於登入/登出/還原時呼叫 setAuthToken 更新。
// 這樣 http 不需反向 import store，避免循環相依。
let authToken = ''

export function setAuthToken(token) {
  authToken = token || ''
}

http.interceptors.request.use((config) => {
  if (authToken) {
    config.headers.Authorization = `Bearer ${authToken}`
  }
  return config
})

http.interceptors.response.use(
  // 成功：直接把後端 body 攤平回傳，呼叫端拿到的就是資料本身。
  (response) => response.data,
  // 失敗：把各種錯誤格式收斂成一個帶有可讀 message 的 Error。
  (error) => {
    const status = error.response?.status
    const serverMessage = error.response?.data?.message
    const message =
      serverMessage ||
      (status === 401
        ? '登入已失效，請重新登入'
        : status === 403
          ? '沒有權限執行此操作'
          : status >= 500
            ? '伺服器發生錯誤，請稍後再試'
            : error.message || '請求失敗')

    const normalized = new Error(message)
    normalized.status = status
    return Promise.reject(normalized)
  }
)

export default http
