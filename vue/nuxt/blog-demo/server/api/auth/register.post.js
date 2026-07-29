// POST /api/auth/register  —— 註冊並直接登入
// 輸入驗證是 API 安全的一環：不能只信任前端表單，伺服器端一定要再驗一次。
export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const email = String(body?.email ?? '').trim().toLowerCase() // 正規化：避免 Foo@x.com 與 foo@x.com 被當成兩個帳號
  const password = String(body?.password ?? '')
  const name = String(body?.name ?? '').trim().slice(0, 50) // name 長度上限，避免灌爆

  // 基本驗證（實務可改用 zod + readValidatedBody，見第 11 章）
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw createError({ statusCode: 400, statusMessage: 'email 格式不正確' })
  }
  if (password.length < 8) {
    throw createError({ statusCode: 400, statusMessage: '密碼至少 8 個字元' })
  }

  const exists = await prisma.user.findUnique({ where: { email } })
  if (exists) {
    throw createError({ statusCode: 409, statusMessage: 'email 已被註冊' })
  }

  // hashPassword 由 nuxt-auth-utils 提供（scrypt），密碼雜湊後才存
  const hashed = await hashPassword(password)
  const user = await prisma.user.create({
    data: { email, name: name || email, password: hashed },
  })

  // 把使用者放進加密的 httpOnly session cookie（只放非機密欄位）
  await setUserSession(event, {
    user: { id: user.id, name: user.name, email: user.email },
  })
  return { ok: true }
})
