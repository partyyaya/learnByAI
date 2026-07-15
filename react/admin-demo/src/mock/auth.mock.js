// 登入相關的 mock。示範「後端驗證帳密 → 發 token → 回傳使用者與權限」的流程。

// 預設帳號。role 決定可見選單（見 router/menu.js 的 roles 欄位）。
const ACCOUNTS = [
  {
    username: 'admin',
    password: 'admin123',
    user: { id: 1, name: '系統管理員', username: 'admin', role: 'admin' },
  },
  {
    username: 'editor',
    password: 'editor123',
    user: { id: 2, name: '內容編輯', username: 'editor', role: 'editor' },
  },
]

export function registerAuthMock(mock) {
  // POST /auth/login
  mock.onPost('/auth/login').reply((config) => {
    const body = JSON.parse(config.data || '{}')
    const account = ACCOUNTS.find(
      (a) => a.username === body.username && a.password === body.password
    )

    if (!account) {
      return [401, { message: '帳號或密碼錯誤' }]
    }

    // token 這裡只是示範用的字串；真實情境是後端簽發的 JWT。
    const token = `mock-token.${account.user.role}.${account.user.id}`
    return [200, { token, user: account.user }]
  })

  // GET /auth/profile —— 用 token 換回目前登入者（示範帶 token 的請求）。
  mock.onGet('/auth/profile').reply((config) => {
    const auth = config.headers?.Authorization || ''
    const token = auth.replace('Bearer ', '')
    const account = ACCOUNTS.find((a) => token.endsWith(`.${a.user.id}`))
    if (!account) return [401, { message: '登入已失效' }]
    return [200, { user: account.user }]
  })
}
