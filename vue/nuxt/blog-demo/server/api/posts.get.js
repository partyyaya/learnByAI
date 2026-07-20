// GET /api/posts?all=true
// 預設只回「已發佈」文章（給首頁）；帶 ?all=true 且已登入時回全部（給後台）。
export default defineEventHandler(async (event) => {
  const { all } = getQuery(event)

  // 後台要看全部（含草稿）→ 需登入
  if (all === 'true') {
    await requireUserSession(event)
    return await prisma.post.findMany({
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
