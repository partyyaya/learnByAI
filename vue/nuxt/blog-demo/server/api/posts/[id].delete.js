// DELETE /api/posts/:id  —— 刪除文章（要登入 + 只能刪自己的）
export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)
  const id = Number(getRouterParam(event, 'id'))
  // 驗證 id，避免 /api/posts/abc → NaN 傳給 Prisma 變成 500
  if (!Number.isInteger(id)) {
    throw createError({ statusCode: 404, statusMessage: '找不到文章' })
  }

  const post = await prisma.post.findUnique({ where: { id } })
  if (!post) {
    throw createError({ statusCode: 404, statusMessage: '找不到文章' })
  }

  // 授權檢查：不是作者就擋（示範文章 authorId 為 null，任何人都不是作者）
  if (post.authorId !== user.id) {
    throw createError({ statusCode: 403, statusMessage: '只能刪除自己的文章' })
  }

  await prisma.post.delete({ where: { id } })
  return { ok: true }
})
