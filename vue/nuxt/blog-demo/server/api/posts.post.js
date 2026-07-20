// POST /api/posts  —— 新增文章（要登入）
export default defineEventHandler(async (event) => {
  // 伺服器端守衛：沒登入直接 401（前端守衛擋不住惡意請求）
  const { user } = await requireUserSession(event)

  const body = await readBody(event)
  if (!body?.title) {
    throw createError({ statusCode: 400, statusMessage: '標題必填' })
  }

  setResponseStatus(event, 201)
  return await prisma.post.create({
    data: {
      title: body.title,
      content: body.content ?? '',
      published: body.published ?? true,
      authorId: user.id, // 記錄作者，之後用來判斷「能不能刪」
    },
  })
})
