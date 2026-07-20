// GET /api/posts/:id  —— 單篇文章（公開）
export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  const post = await prisma.post.findUnique({
    where: { id },
    include: { author: { select: { id: true, name: true } } },
  })
  if (!post) {
    throw createError({ statusCode: 404, statusMessage: '找不到文章' })
  }
  return post
})
