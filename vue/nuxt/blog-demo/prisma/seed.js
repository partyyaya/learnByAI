// 初始資料：npm run db:seed
// 專案是 ESM（package.json 有 "type": "module"），故用 import 語法。
// 這些示範文章 authorId 為 null（視為「站長發佈」），任何登入者都無法刪除；
// 你自己註冊帳號後發表的文章才會出現「刪除」鈕。
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  // 先清空文章，讓重複執行 seed 不會一直疊加
  await prisma.post.deleteMany()

  await prisma.post.createMany({
    data: [
      {
        title: '用檔案式路由打造第一個頁面',
        content:
          'Nuxt 用 app/pages/ 底下的檔案對應網址：放一個 index.vue，那條路徑就出現了。這篇帶你認識最基本的檔案系統路由（對應課程第 2 章）。',
        published: true,
      },
      {
        title: 'useFetch 心法：在伺服器就把資料抓好',
        content:
          '頁面初始資料用 useFetch，它會在 SSR 抓好、隨 HTML 送到瀏覽器，不重抓；使用者互動才發的請求用 $fetch（對應第 6、8 章）。',
        published: true,
      },
      {
        title: '用 Nitro 寫自家 API，不必另外開後端',
        content:
          'server/api/ 底下放 defineEventHandler，網址自動加 /api 前綴。搭配 Prisma 就是完整的全端 CRUD（對應第 8、10 章）。',
        published: true,
      },
      {
        title: '（草稿）尚未發佈的文章',
        content: '這篇 published=false，只會出現在後台，不會出現在首頁。用來示範發佈狀態。',
        published: false,
      },
    ],
  })

  const count = await prisma.post.count()
  console.log(`Seed 完成，共 ${count} 篇文章。`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
