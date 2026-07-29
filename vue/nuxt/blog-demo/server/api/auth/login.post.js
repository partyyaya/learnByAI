// POST /api/auth/login  —— 登入
export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  // 用與註冊相同的正規化，才能對上資料庫裡存的 email
  const email = String(body?.email ?? '').trim().toLowerCase()
  const password = String(body?.password ?? '')

  const user = await prisma.user.findUnique({ where: { email } })
  // 帳號不存在或密碼錯，都回同一則訊息（不洩漏是哪個錯）
  if (!user || !(await verifyPassword(user.password, password))) {
    throw createError({ statusCode: 401, statusMessage: '帳號或密碼錯誤' })
  }

  await setUserSession(event, {
    user: { id: user.id, name: user.name, email: user.email },
  })
  return { ok: true }
})
