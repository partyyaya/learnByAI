// POST /api/auth/logout  —— 登出（清除 session cookie）
export default defineEventHandler(async (event) => {
  await clearUserSession(event)
  return { ok: true }
})
