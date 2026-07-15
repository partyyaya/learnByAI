import http from '@/services/http'

// 認證相關 API。元件與 store 只呼叫這裡，不直接碰 axios。
export const authApi = {
  login(payload) {
    // payload: { username, password } → 回傳 { token, user }
    return http.post('/auth/login', payload)
  },
  getProfile() {
    return http.get('/auth/profile')
  },
}
