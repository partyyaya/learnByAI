// GET /api/posts/:id  —— 單篇文章
// 授權重點：未發佈（草稿）只有作者本人能看。
// 「前端把草稿藏起來」不算安全，這支公開端點自己也必須擋——這正是第 11 章的主張。
export default defineEventHandler(async (event) => {
  // 先驗證 id：/api/posts/abc → Number('abc') 為 NaN，若直接丟給 Prisma 會拋錯變成 500。
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) {
    throw createError({ statusCode: 404, statusMessage: '找不到文章' })
  }

  const post = await prisma.post.findUnique({
    where: { id },
    include: { author: { select: { id: true, name: true } } },
  })
  if (!post) {
    throw createError({ statusCode: 404, statusMessage: '找不到文章' })
  }

  // 未發佈（草稿）：只有作者本人能看，其他人一律當作不存在（回 404 而非 403，不洩漏草稿存在）。
  if (!post.published) {
    // getUserSession 不會在未登入時丟錯（requireUserSession 才會），這裡只是「取來比對」。
    const session = await getUserSession(event)
    if (!session.user || post.authorId !== session.user.id) {
      throw createError({ statusCode: 404, statusMessage: '找不到文章' })
    }
  }

  return post
})
