// POST /api/auth/register  —— 註冊並直接登入
export default defineEventHandler(async (event) => {
  const { email, password, name } = await readBody(event)
  if (!email || !password) {
    throw createError({ statusCode: 400, statusMessage: 'email 與密碼必填' })
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
