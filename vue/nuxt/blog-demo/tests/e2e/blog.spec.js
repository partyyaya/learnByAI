// E2E 測試（第 15 章）：setup() 會真的啟動一個 Nuxt 實例，
// $fetch 打的是真的伺服器——SSR、Nitro API、Prisma 全都會真的跑。
//
// 先決條件（第一次跑或換機器時）：
//   cp .env.example .env                 # .env 不進版控，先從範本複製
//   npx prisma migrate dev --name init   # 建好 SQLite 資料表
//   npm run test:e2e
//
// 這裡用 dev 模式啟動：起得快，而且會自動讀 .env（DATABASE_URL / NUXT_SESSION_PASSWORD）。
// 想改測正式打包後的結果，把下面改成 setup()：它會自己先打包（輸出到 .nuxt/test/ 底下）再啟動，
// 同樣會讀 .env，只是慢很多。
// 啟動要花幾秒，比單元測試慢很多，屬於正常現象。
//
// E2E 要跑真的 Node 伺服器，所以這支檔案不用 vitest.config.ts 的 nuxt 環境：
// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { setup, $fetch } from '@nuxt/test-utils/e2e'

describe('blog-demo E2E', async () => {
  // rootDir 預設就是專案根目錄（vitest.config.ts 所在處），不必特別指定
  await setup({ dev: true })

  it('首頁 SSR 出得來（HTML 裡就有內容，不是等前端再補）', async () => {
    const html = await $fetch('/')

    expect(html).toContain('最新文章')
  })

  it('GET /api/posts 回傳陣列', async () => {
    const posts = await $fetch('/api/posts')

    expect(Array.isArray(posts)).toBe(true)
  })

  it('公開列表只回已發佈的文章', async () => {
    const posts = await $fetch('/api/posts')

    expect(posts.every((p) => p.published)).toBe(true)
  })

  it('未登入拿後台列表（?all=true）會被伺服器擋下來', async () => {
    // requireUserSession 會丟 401；$fetch 收到非 2xx 會 reject。
    // 斷言要寫到狀態碼：只寫 rejects.toThrow() 的話，伺服器壞掉回 500 也會「通過」
    await expect($fetch('/api/posts?all=true')).rejects.toMatchObject({ statusCode: 401 })
  })

  it('未登入發文會被伺服器擋下來（前端藏按鈕不算安全）', async () => {
    await expect(
      $fetch('/api/posts', {
        method: 'POST',
        body: { title: '偷發的文章', content: '不該成功' },
      })
    ).rejects.toMatchObject({ statusCode: 401 })
  })

  it('不存在的文章回 404', async () => {
    await expect($fetch('/api/posts/999999')).rejects.toMatchObject({ statusCode: 404 })
  })
})
