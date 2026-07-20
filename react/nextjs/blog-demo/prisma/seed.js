// 初始資料：npx prisma db seed（或 npm run db:seed）
// 這支用 node 直接跑，故用 CommonJS 的 require。
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

async function main() {
  // 先清空，讓重複執行 seed 不會一直疊加
  await prisma.post.deleteMany();

  await prisma.post.createMany({
    data: [
      {
        title: "用 App Router 打造第一個頁面",
        content:
          "App Router 用資料夾對應網址：放一個 page.js，那條路徑就出現了。這篇帶你認識最基本的檔案系統路由。",
        published: true,
      },
      {
        title: "Server Components 心法：預設 Server，需要互動才 Client",
        content:
          "在 App Router 裡，元件預設在伺服器執行。只有需要 useState、onClick 這類互動時，才在檔案最上面加 use client。",
        published: true,
      },
      {
        title: "用 Server Actions 處理表單，不必手寫 fetch",
        content:
          "把一個標了 use server 的函式直接綁到 <form action={...}>，送出時 Next.js 幫你把 FormData 交給伺服器函式。",
        published: true,
      },
      {
        title: "（草稿）尚未發佈的文章",
        content: "這篇 published=false，只會出現在後台，不會出現在首頁。用來示範發佈狀態。",
        published: false,
      },
    ],
  });

  const count = await prisma.post.count();
  console.log(`Seed 完成，共 ${count} 篇文章。`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
