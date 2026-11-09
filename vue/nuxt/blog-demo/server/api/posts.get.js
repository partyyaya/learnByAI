// GET /api/posts?all=true
// 預設只回「已發佈」文章（給首頁）；帶 ?all=true 且已登入時，回「已發佈 + 自己的草稿」（給後台）。
export default defineEventHandler(async (event) => {
  const { all } = getQuery(event)

  // 後台列表 → 需登入；別人的草稿一樣看不到（與 [id].get.js 的規則一致）
  if (all === 'true') {
    const { user } = await requireUserSession(event)
    return await prisma.post.findMany({
      where: { OR: [{ published: true }, { authorId: user.id }] },
      orderBy: { createdAt: 'desc' },
      include: { author: { select: { id: true, name: true } } },
    })
  }

  // 公開列表：只回已發佈
  return await prisma.post.findMany({
    where: { published: true },
    orderBy: { createdAt: 'desc' },
    include: { author: { select: { id: true, name: true } } },
  })
})
