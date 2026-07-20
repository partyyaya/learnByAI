# 第 9 章：資料庫整合（Prisma + SQLite）

## 本章目標

完成這一章後，你應該可以：

1. 安裝並初始化 Prisma，用 SQLite 當開發資料庫。
2. 寫 schema、跑 migration 建立資料表。
3. 在專案裡建立一個可重用的 Prisma Client。
4. 在 Server Component / Server Action 裡做完整 CRUD。
5. 用 seed 塞入初始資料。

---

## 1. 為什麼選 Prisma + SQLite

- **Prisma**：型別安全的 ORM，用 `prisma.post.findMany()` 這種寫法取代手寫 SQL，且自動補全。
- **SQLite**：一個檔案就是一個資料庫，零安裝、零設定，最適合學習與開發。上線再換 PostgreSQL 只要改連線字串。

> Prisma 只能在**伺服器**跑（Server Component、Server Action、Route Handler）。**絕對不要**在 Client Component import Prisma，會把資料庫連線與密鑰打包到瀏覽器。

---

## 2. 安裝與初始化

```bash
npm install prisma --save-dev
npm install @prisma/client
npx prisma init --datasource-provider sqlite
```

這會產生：

```text
prisma/schema.prisma   # 資料模型定義
.env                   # 內含 DATABASE_URL="file:./dev.db"
```

---

## 3. 定義 schema

編輯 `prisma/schema.prisma`，定義一張 `Post` 表：

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}

model Post {
  id        Int      @id @default(autoincrement())
  title     String
  content   String
  published Boolean  @default(false)
  createdAt DateTime @default(now())
}
```

---

## 4. 跑 migration 建立資料表

```bash
npx prisma migrate dev --name init
```

這會：建立 `dev.db`、依 schema 建表、產生型別化的 Prisma Client。日後改了 schema，就再跑一次 `migrate dev --name 你的說明`。

> 想用視覺化介面看/改資料，可跑 `npx prisma studio`，開一個網頁版資料庫瀏覽器。

---

## 5. 建立可重用的 Prisma Client

開發時 Next.js 熱更新會一直重新載入模組，若每次都 `new PrismaClient()` 會爆出太多連線。標準做法是快取在 `globalThis`：

```js
// lib/prisma.js
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis;

export const prisma =
  globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
```

之後全專案都 `import { prisma } from "@/lib/prisma"`。

---

## 6. CRUD 常用寫法

```js
import { prisma } from "@/lib/prisma";

// 查全部（新到舊）
await prisma.post.findMany({ orderBy: { createdAt: "desc" } });

// 查單筆
await prisma.post.findUnique({ where: { id: 1 } });

// 新增
await prisma.post.create({ data: { title: "標題", content: "內容" } });

// 更新
await prisma.post.update({ where: { id: 1 }, data: { published: true } });

// 刪除
await prisma.post.delete({ where: { id: 1 } });
```

---

## 7. 塞初始資料（seed）

建立 `prisma/seed.js`：

```js
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  await prisma.post.createMany({
    data: [
      { title: "第一篇", content: "Hello Prisma", published: true },
      { title: "第二篇", content: "SQLite 好方便", published: true },
    ],
  });
}

main().finally(() => prisma.$disconnect());
```

在 `package.json` 加：

```json
{
  "prisma": { "seed": "node prisma/seed.js" }
}
```

執行：`npx prisma db seed`。

---

## 8. 本章小練習

1. 依上面步驟初始化 Prisma + SQLite，建立 `Post` 表。
2. 用 seed 塞 2～3 筆文章。
3. 在 `/posts` 頁用 `prisma.post.findMany` 顯示列表。
4. 把第 8 章的待辦改成用 Prisma 存（新增/刪除接資料庫）。
5. 開 `npx prisma studio` 確認資料真的寫進去了。

---

## 最後範例：文章 CRUD（真實資料庫落地）

> 承接第 8 章的表單模式，把資料源換成 Prisma。以下檔案 + 上面的 schema / client 設定即可跑出真正會存檔的 CRUD。

### `lib/prisma.js`

```js
// 和上面 5. 相同，原樣搬來，全專案共用同一個 Prisma Client
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis;
export const prisma = globalForPrisma.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
```

### `app/posts/actions.js`（Server Actions，接 Prisma）

```jsx
"use server";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";

// 新增文章
export async function createPost(prevState, formData) {
  const title = (formData.get("title") ?? "").trim();
  const content = (formData.get("content") ?? "").trim();
  if (!title) return { error: "標題不可為空" };
  if (!content) return { error: "內容不可為空" };

  await prisma.post.create({ data: { title, content, published: true } });
  revalidatePath("/posts"); // 刷新列表
  return { success: true };
}

// 刪除文章
export async function deletePost(formData) {
  const id = Number(formData.get("id"));
  await prisma.post.delete({ where: { id } });
  revalidatePath("/posts");
}
```

### `app/posts/SubmitButton.js`（Client：送出中狀態）

```jsx
"use client";
import { useFormStatus } from "react-dom";

export default function SubmitButton({ children }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending}>
      {pending ? "處理中…" : children}
    </button>
  );
}
```

### `app/posts/PostForm.js`（Client：新增表單）

```jsx
"use client";
import { useActionState } from "react";
import { createPost } from "./actions";
import SubmitButton from "./SubmitButton";

export default function PostForm() {
  const [state, formAction] = useActionState(createPost, { error: null });

  return (
    <form action={formAction} className="post-form">
      <input name="title" placeholder="標題" />
      <textarea name="content" placeholder="內容" rows={3} />
      <SubmitButton>發表文章</SubmitButton>
      {state?.error && <p className="err">{state.error}</p>}
    </form>
  );
}
```

### `app/posts/page.js`（Server：從資料庫讀列表）

```jsx
import { prisma } from "@/lib/prisma";
import { deletePost } from "./actions";
import PostForm from "./PostForm";
import SubmitButton from "./SubmitButton";

export default async function PostsPage() {
  // 直接在 Server Component 查資料庫
  const posts = await prisma.post.findMany({ orderBy: { createdAt: "desc" } });

  return (
    <main className="wrap">
      <h1>文章管理（Prisma）</h1>
      <PostForm />

      <ul className="post-list">
        {posts.map((p) => (
          <li key={p.id}>
            <div>
              <strong>{p.title}</strong>
              <p className="muted">{p.content}</p>
            </div>
            <form action={deletePost}>
              <input type="hidden" name="id" value={p.id} />
              <SubmitButton>刪除</SubmitButton>
            </form>
          </li>
        ))}
        {posts.length === 0 && <li className="muted">還沒有文章，發表第一篇吧。</li>}
      </ul>
    </main>
  );
}
```

### 樣式（加進 `app/globals.css`）

```css
.wrap { max-width: 640px; margin: 40px auto; font-family: sans-serif; padding: 0 16px; }
.muted { color: #6b7280; margin: 4px 0 0; }
.post-form { display: flex; flex-direction: column; gap: 8px; margin-bottom: 20px; }
.post-form input, .post-form textarea { padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 8px; font: inherit; }
button { padding: 8px 14px; border: 0; border-radius: 8px; background: #2563eb; color: #fff; cursor: pointer; align-self: flex-start; }
button:disabled { opacity: 0.6; }
.err { color: #dc2626; }
.post-list { list-style: none; padding: 0; }
.post-list li { display: flex; justify-content: space-between; gap: 12px; padding: 14px 0; border-bottom: 1px solid #eee; }
.post-list form button { background: #ef4444; }
```

> `@/lib/prisma` 的 `@` 是 create-next-app 預設的路徑別名，指向專案根目錄。若你關掉了它，改成相對路徑即可。

---

## 本章結語

現在你的資料會真正存進 SQLite，重啟也不會消失，CRUD 全走 Server Component + Server Action。  
資料有了，接著要保護它——下一章用 `middleware.js` + cookie 做登入與路由守衛。
