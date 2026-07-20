# 第 15 章：期末專題 — 全端部落格

## 本章目標

把前 14 章的能力整合成一個**可上線的全端部落格**：

1. 首頁文章列表（Server Component 抓 DB）。
2. 文章詳情動態頁 + 完整 SEO metadata。
3. 後台登入 + 路由守衛。
4. 後台用 Server Actions 做文章 CRUD。
5. Prisma + SQLite 落地資料，可部署。

> 本章對照 React 課程的 [admin-demo](../admin-demo/)。完整可跑的成品放在 **[blog-demo/](./blog-demo/)**，本章帶你看懂它怎麼組起來、每一塊對應哪一章。

---

## 1. 需求規劃：先想清楚頁面與資料流

### 頁面地圖

| 網址 | 說明 | 誰能看 | 對應章節 |
|------|------|--------|----------|
| `/` | 文章列表（已發佈） | 所有人 | 02, 05, 11 |
| `/posts/[id]` | 文章詳情 | 所有人 | 06, 13 |
| `/login` | 登入 | 所有人 | 08, 10 |
| `/admin` | 後台文章管理 | 需登入 | 08, 09, 10 |

### 資料流原則（整合全課心法）

> - **讀資料**：在 Server Component 直接查 Prisma（不經 API）。
> - **寫資料**：用 Server Action，寫完 `revalidatePath` 刷新。
> - **權限**：middleware 擋 `/admin`，Server Action 再確認一次。
> - **互動**（送出中、錯誤）：抽小的 Client 元件。

---

## 2. 專案結構

```text
blog-demo/
├─ prisma/
│  ├─ schema.prisma      # Post 資料模型
│  └─ seed.js            # 初始文章
├─ lib/
│  ├─ prisma.js          # 共用 Prisma Client（第 9 章）
│  └─ auth.js            # cookie 登入輔助（第 10 章）
├─ app/
│  ├─ layout.js          # 根版面 + metadata
│  ├─ page.js            # 首頁：文章列表
│  ├─ posts/[id]/page.js # 文章詳情 + generateMetadata
│  ├─ login/             # 登入頁 + action
│  └─ admin/             # 後台（受 middleware 保護）
│     ├─ page.js         # 文章管理列表
│     ├─ actions.js      # 建立 / 刪除 / 切換發佈
│     └─ *.js            # 表單、送出按鈕等 Client 元件
├─ middleware.js         # 保護 /admin
└─ package.json
```

---

## 3. 分階段組裝（建議的實作順序）

不要一次全寫。照這個順序，每一步都能跑起來再往下：

**階段 1：資料層**
- `prisma/schema.prisma` 定義 `Post`，`migrate dev`，`seed`。
- `lib/prisma.js` 建好共用 client。

**階段 2：公開頁面（唯讀）**
- `/`：`prisma.post.findMany` 列出已發佈文章。
- `/posts/[id]`：`findUnique`，找不到 `notFound()`，加 `generateMetadata`。

**階段 3：認證**
- `lib/auth.js`、`/login`（Server Action 寫 cookie）、`middleware.js` 守 `/admin`。

**階段 4：後台 CRUD**
- `/admin`：列出所有文章（含未發佈）。
- `actions.js`：`createPost` / `deletePost` / `togglePublish`，每個都 `revalidatePath`。

**階段 5：收尾**
- SEO metadata、`next/image`、亮暗主題、部署設定。

---

## 4. 關鍵程式碼片段（其餘見 blog-demo/）

### 資料模型 `prisma/schema.prisma`

```prisma
model Post {
  id        Int      @id @default(autoincrement())
  title     String
  content   String
  published Boolean  @default(false)
  createdAt DateTime @default(now())
}
```

### 首頁列表 `app/page.js`（讀 = Server Component 直接查 DB）

```jsx
import Link from "next/link";
import { prisma } from "@/lib/prisma";

export const revalidate = 60; // ISR：列表每 60 秒可更新

export default async function HomePage() {
  const posts = await prisma.post.findMany({
    where: { published: true },
    orderBy: { createdAt: "desc" },
  });

  return (
    <main className="wrap">
      <h1>我的部落格</h1>
      <ul className="post-list">
        {posts.map((p) => (
          <li key={p.id}>
            <Link href={`/posts/${p.id}`}>{p.title}</Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
```

### 後台建立文章 `app/admin/actions.js`（寫 = Server Action）

```jsx
"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";

export async function createPost(prevState, formData) {
  await requireUser(); // 第二道防護：Action 也確認登入

  const title = (formData.get("title") ?? "").trim();
  const content = (formData.get("content") ?? "").trim();
  if (!title) return { error: "標題不可為空" };
  if (!content) return { error: "內容不可為空" };

  await prisma.post.create({
    data: { title, content, published: formData.get("published") === "on" },
  });

  revalidatePath("/admin"); // 刷新後台
  revalidatePath("/");       // 首頁列表也可能變
  redirect("/admin");
}
```

### 守門 `middleware.js`

```js
import { NextResponse } from "next/server";

export function middleware(request) {
  const token = request.cookies.get("token")?.value;
  if (!token) return NextResponse.redirect(new URL("/login", request.url));
  return NextResponse.next();
}

export const config = { matcher: ["/admin/:path*"] };
```

> 完整的每個檔案（含登入頁、詳情頁 metadata、切換發佈、樣式、seed）都在 **[blog-demo/](./blog-demo/)**，可直接 `npm install && npm run dev`。

---

## 5. 跑起來

```bash
cd blog-demo
npm install                    # 安裝依賴
npx prisma migrate dev --name init   # 建立資料庫
npx prisma db seed             # 塞入初始文章
npm run dev                    # 啟動
```

打開 `http://localhost:3000`：

- 首頁看文章列表 → 點進詳情。
- `/login` 用 `admin` / `admin123` 登入 → 進 `/admin` 管理。
- 沒登入直接開 `/admin` → 被踢回 `/login`（middleware 生效）。

---

## 6. 驗收清單（做完打勾）

- [ ] 首頁只顯示「已發佈」文章，新到舊排序
- [ ] 詳情頁 `<title>` 是文章標題（檢視原始碼確認）
- [ ] 不存在的文章 id 顯示 404 頁
- [ ] 未登入無法進 `/admin`
- [ ] 後台能新增、刪除、切換發佈，且列表即時更新
- [ ] 空標題/內容會顯示驗證錯誤
- [ ] `npm run build` 通過，路由標記符合預期

---

## 7. 延伸挑戰（自己加，鞏固能力）

1. **編輯文章**：加 `/admin/[id]/edit` 頁與 `updatePost` action。
2. **分類/標籤**：schema 加關聯，列表可按分類篩選。
3. **留言**：新增 `Comment` model，詳情頁用 Server Action 留言。
4. **分頁**：首頁用 `searchParams` 做分頁（第 6 章）。
5. **動態 OG image**：每篇文章自動產生分享圖（第 13 章）。
6. **部署**：把 SQLite 換成雲端 Postgres，部署到 Vercel（第 14 章）。

---

## 課程結語

恭喜你完成整套 Next.js 課程！你已經能：

- 用 App Router 設計多頁面站台與版面
- 分清 Server / Client 元件，在伺服器抓資料
- 用 Server Actions 處理表單與資料異動
- 整合 Prisma 資料庫、做認證與路由守衛
- 控制渲染策略與快取、顧好 SEO
- 測試並部署上線

接下來最好的鞏固方式，就是把 [blog-demo/](./blog-demo/) 當骨架，加上你自己的功能，做出一個真正屬於你的作品並部署上線。祝你玩得開心！
