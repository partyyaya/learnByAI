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
- **SQLite**：一個檔案就是一個資料庫，零安裝、零設定，最適合學習與開發。上線再換 PostgreSQL，主要是改 schema 的 `provider` 和連線字串、重新產生 migration，查詢的程式碼幾乎不用動（第 14 章）。

> Prisma 只能在**伺服器**跑（Server Component、Server Action、Route Handler）。**不要**在 Client Component（`"use client"` 的檔案）import Prisma：Prisma Client 不能在瀏覽器執行，會直接報錯，而且資料庫本來就不該讓瀏覽器直連。Client 元件需要資料時，由 Server Component 查好當 props 傳下去；要寫入就呼叫 Server Action。

---

## 2. 安裝與初始化

```bash
npm install prisma@6 --save-dev
npm install @prisma/client@6
npx prisma init --datasource-provider sqlite
```

> **版本**：本課與 blog-demo 用 Prisma 6，安裝時請加上 `@6`。不指定版本會裝到 Prisma 7 以後的版本，設定方式不同（例如連線字串改寫在 `prisma.config.ts`），照本章做會跑不起來。

這會產生：

```text
prisma/schema.prisma   # 資料模型定義
prisma.config.ts       # Prisma 設定檔（本課不用，見下方說明）
.env                   # 內含 DATABASE_URL="file:./dev.db"
```

本課沿用 blog-demo 的設定方式（連線字串放 `.env`、seed 設定寫在 `package.json`），所以請**刪掉 `prisma.config.ts`**。留著它的話，Prisma 會改讀這個檔、不再自動載入 `.env`，它開頭的 `import "dotenv/config"` 也預設你另外裝了 `dotenv`。（`.env` 開頭那段「不會自動載入」的英文註解，說的就是有 `prisma.config.ts` 的情況，刪掉設定檔後可以一併刪掉。）

---

## 3. 定義 schema

把 `prisma/schema.prisma` 的內容**整份換成**下面這樣，定義一張 `Post` 表：

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

> 注意 `generator` 那段：新版 `prisma init` 產生的是 `provider = "prisma-client"` 再加一行 `output = "../generated/prisma"`（新式產生器，會把 client 產生到專案裡的資料夾）。本課和 blog-demo 用的是 `prisma-client-js`、不寫 `output`，client 會產生在 `node_modules` 裡，後面才能 `import { PrismaClient } from "@prisma/client"`。如果只把 `model` 貼進去、保留原本的 generator，這個 import 就會失敗。

---

## 4. 跑 migration 建立資料表

```bash
npx prisma migrate dev --name init
```

這會：建立 `dev.db`、依 schema 建表、把這次的變更存成 `prisma/migrations/時間_init/migration.sql`，並產生型別化的 Prisma Client。日後改了 schema，就再跑一次 `migrate dev --name 你的說明`。

`DATABASE_URL="file:./dev.db"` 的路徑是**相對於 `schema.prisma`**，所以資料庫檔會出現在 `prisma/dev.db`，不在專案根目錄。`prisma/migrations/` 要跟著程式碼一起 commit（部署時用它重建資料表，第 14 章），`dev.db` 本身則不必。

> **改了 schema 記得重啟 dev server**：`migrate dev` 會重新產生 Prisma Client，但一直開著的 `npm run dev` 還拿著舊的那份。例如把第 8 章的待辦改用 Prisma、新增了 `Todo` model 卻沒重啟，就會看到 `Cannot read properties of undefined`（舊 client 裡沒有 `prisma.todo`）。停掉再 `npm run dev` 一次就好。

> **`migrate dev` 和 `db push`**：`npx prisma db push` 也能把 schema 同步到資料庫，但不會產生 migration 檔，適合還在試 schema 的階段；要留下能在別台電腦、正式環境重放的變更紀錄，就用 `migrate dev`。本課一律用 `migrate dev`。

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

`globalThis` 不會因為模組重新載入而清空，所以第二次載入時 `globalForPrisma.prisma` 已經有值，就沿用同一個 client。正式環境（`next start`）模組只會載入一次，不會重複建立，所以只在開發時掛上去。

之後全專案都 `import { prisma } from "@/lib/prisma"`（`@/` 是 create-next-app 預設的路徑別名，指向專案根目錄，所以檔案放在根目錄的 `lib/prisma.js`）。

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

`findUnique` 找不到會回 `null`；`update`、`delete` 找不到那筆則會直接丟錯（錯誤代碼 `P2025`），例如同一篇文章被刪兩次。

---

## 7. 塞初始資料（seed）

建立 `prisma/seed.js`：

```js
// 這支用 node 直接執行（不經過 Next.js），所以用 CommonJS 的 require。
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  await prisma.post.deleteMany(); // 先清空，重複執行也不會越塞越多
  await prisma.post.createMany({
    data: [
      { title: "第一篇", content: "Hello Prisma", published: true },
      { title: "第二篇", content: "SQLite 好方便", published: true },
    ],
  });
}

main().finally(() => prisma.$disconnect());
```

在 `package.json` 最外層加一個 `prisma` 欄位（和 `scripts` 同一層，不是取代整個檔案）：

```json
{
  "prisma": { "seed": "node prisma/seed.js" }
}
```

執行：`npx prisma db seed`。

> Prisma 6 執行時會印一行 `package.json#prisma` 已不建議使用的警告（Prisma 7 改寫在 `prisma.config.ts`），在 6 版可以忽略。另外，之後只要 `migrate dev` 建立了新的資料庫（或跑 `migrate reset`），Prisma 會**自動**跑一次 seed——這也是上面先 `deleteMany()` 的原因。

---

## 8. 本章小練習

1. 依上面步驟初始化 Prisma + SQLite，建立 `Post` 表。
2. 用 seed 塞 2～3 筆文章。
3. 在 `/posts` 頁用 `prisma.post.findMany` 顯示列表。
4. 把第 8 章的待辦改成用 Prisma 存（新增/刪除接資料庫）。
5. 開 `npx prisma studio` 確認資料真的寫進去了。

---

## 最後範例：文章 CRUD（真實資料庫落地）

> 承接第 8 章的表單模式，把資料源換成 Prisma。以下檔案 + 上面的 schema / client 設定即可跑出真正會存檔的 CRUD（`/posts` 和第 5 章的範例同路徑，`app/posts/page.js` 直接覆蓋即可）。

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
  const id = Number(formData.get("id")); // FormData 的值是字串，schema 的 id 是 Int，要轉數字
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
