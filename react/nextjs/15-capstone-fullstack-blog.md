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
| `/` | 文章列表（已發佈） | 所有人 | 02, 05, 12 |
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
│  ├─ layout.js          # 根版面 + metadata + 主題腳本
│  ├─ globals.css        # 全域樣式（含亮 / 暗主題變數）
│  ├─ ThemeToggle.js     # 主題切換（Client）
│  ├─ page.js            # 首頁：文章列表
│  ├─ posts/[id]/
│  │  ├─ page.js         # 文章詳情 + generateMetadata（getPost 用 cache() 只查一次，第 13 章）
│  │  └─ not-found.js    # 找不到文章時的 404 畫面
│  ├─ login/
│  │  ├─ page.js         # 登入表單（Client）
│  │  └─ actions.js      # 登入 / 登出 Server Actions
│  └─ admin/             # 後台（受 middleware 保護）
│     ├─ layout.js       # 後台版面：再確認一次登入 + 登出按鈕
│     ├─ page.js         # 文章管理列表
│     ├─ actions.js      # 建立 / 刪除 / 切換發佈
│     ├─ PostForm.js     # 新增表單（Client）
│     └─ SubmitButton.js # 送出中狀態按鈕（Client）
├─ middleware.js         # 保護 /admin
├─ eslint.config.mjs     # ESLint 設定（npm run lint，第 14 章）
├─ .env                  # DATABASE_URL（SQLite 檔位置）
└─ package.json
```

---

## 3. 分階段組裝（建議的實作順序）

不要一次全寫。照這個順序，每一步都能跑起來再往下：

**階段 1：資料層**
- `prisma/schema.prisma` 定義 `Post`，`migrate dev`，`seed`（第一次建資料庫時，`migrate dev` 會自動跑 seed）。
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
- SEO metadata（title template、`metadataBase`）、亮暗主題、部署設定。blog-demo 沒有圖片；要加封面圖時，再用第 11 章的 `next/image`。

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

// 精簡版：blog-demo 的完整檔案另有文章數、摘要、日期與「還沒有文章」提示
export default async function HomePage() {
  const posts = await prisma.post.findMany({
    where: { published: true },
    orderBy: { createdAt: "desc" },
  });

  return (
    <main className="wrap">
      <h1>最新文章</h1>
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

首頁沒有用到 cookies 之類的動態 API，所以 `npm run build` 時就會查一次資料庫，產生靜態頁，之後每 60 秒最多更新一次。後台一有異動就呼叫 `revalidatePath("/")`，不用等 60 秒，首頁會立刻更新。也因為 build 時要查資料庫，**一定要先建好資料庫再 build**。

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
  if (title.length > 100) return { error: "標題不可超過 100 字" };
  if (!content) return { error: "內容不可為空" };

  await prisma.post.create({
    data: { title, content, published: formData.get("published") === "on" },
  });

  revalidatePath("/admin"); // 刷新後台
  revalidatePath("/");       // 首頁列表也可能變
  redirect("/admin");
}
```

- 第一個參數是 `prevState`，因為這個 action 是交給 `PostForm.js` 的 `useActionState` 呼叫（第 8 章）；回傳的 `{ error }` 會變成表單的新 state，顯示在畫面上。
- 勾選框 `published` 有勾時，`formData` 裡的值是 `"on"`，沒勾時根本不會出現，所以用 `=== "on"` 判斷。
- `redirect()` 會以拋出例外的方式中斷函式，所以 `revalidatePath` 要寫在它前面。
- 刪除、切換發佈的 `deletePost`、`togglePublish` 直接綁在一般 `<form action>` 上，只收 `formData` 一個參數，用 hidden input 帶文章 `id`。

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

middleware 只是第一道快速攔截。Server Action 本質上是一個可以被直接送 POST 呼叫的端點，不能只靠 middleware 有沒有攔到，所以 `app/admin/layout.js` 和每個 Server Action 都會再呼叫 `requireUser()` 確認一次（第 10 章的雙層防護）。

> 完整的每個檔案（含登入頁、詳情頁 metadata、切換發佈、樣式、seed）都在 **[blog-demo/](./blog-demo/)**，照下一節的步驟建好資料庫就能跑。

---

## 5. 跑起來

```bash
cd blog-demo
npm install        # 安裝依賴（postinstall 會自動 prisma generate）
npm run setup      # 建立資料庫 + 塞入初始文章
npm run dev        # 啟動
```

`npm run setup` 等於依序跑 `prisma generate`、`prisma migrate deploy`、`prisma db seed`。`migrate deploy` 會套用專案裡已經提交的 migration（`prisma/migrations/`），不會問問題，也不會產生新的 migration。資料庫位置寫在專案附的 `.env`（`DATABASE_URL="file:./dev.db"`），不用另外設定。

> 想照第 9 章自己跑 `npx prisma migrate dev` 也可以。第一次建資料庫時它會自動跑一次 seed，不用再手動 `npx prisma db seed`。多跑一次也不會重複塞資料（seed 會先清空），只是文章 id 會往後跳。

打開 `http://localhost:3000`：

- 首頁看文章列表 → 點進詳情。
- `/login` 用 `admin` / `admin123` 登入 → 進 `/admin` 管理。
- 沒登入直接開 `/admin` → 被踢回 `/login`（middleware 生效）。

---

## 6. 驗收清單（做完打勾）

- [ ] 首頁只顯示「已發佈」文章，新到舊排序
- [ ] 詳情頁 `<title>` 是「文章標題 | My Blog」（檢視原始碼確認）
- [ ] 不存在的文章 id 顯示 404 頁
- [ ] 未登入無法進 `/admin`
- [ ] 後台能新增、刪除、切換發佈，且列表即時更新
- [ ] 空標題/內容會顯示驗證錯誤
- [ ] `npm run build` 通過，路由標記符合預期：`/`、`/login` 是 `○`（`/` 的 Revalidate 欄為 `1m`），`/admin`、`/posts/[id]` 是 `ƒ`

---

## 7. 延伸挑戰（自己加，鞏固能力）

1. **編輯文章**：加 `/admin/[id]/edit` 頁與 `updatePost` action。
2. **分類/標籤**：schema 加關聯，列表可按分類篩選。
3. **留言**：新增 `Comment` model，詳情頁用 Server Action 留言。
4. **分頁**：首頁用 `searchParams` 做分頁（第 6 章）。用了 `searchParams` 後，首頁會從 `○` 變成動態的 `ƒ`，`revalidate = 60` 也就不再有作用（第 12 章）。
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
