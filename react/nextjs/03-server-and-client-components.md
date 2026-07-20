# 第 3 章：Server Components 與 Client Components

## 本章目標

完成這一章後，你應該可以：

1. 說出 Server Component 與 Client Component 各在哪裡執行。
2. 判斷一個元件該用哪一種。
3. 正確使用 `"use client"`，並理解它的「傳染」邊界。
4. 把 Server 與 Client 元件正確組合在一起。

---

## 1. 兩種元件，兩個世界

App Router 裡的元件預設是 **Server Component**：

- **Server Component**：在**伺服器**執行，產出 HTML 送到瀏覽器。不會被打包進前端 JS。
- **Client Component**：在**瀏覽器**執行，能用互動、狀態、瀏覽器 API。

用一張表記住能力邊界：

| 能力 | Server Component | Client Component |
|------|:---:|:---:|
| `async/await` 直接抓資料 | ✅ | ❌（用別的方式） |
| 直接讀資料庫、用密鑰 | ✅ | ❌（會外洩） |
| `useState` / `useEffect` | ❌ | ✅ |
| `onClick` 等事件 | ❌ | ✅ |
| 用 `window`、`localStorage` | ❌ | ✅ |
| 打包進前端 JS bundle | ❌（更輕） | ✅ |

> 一句話：**要互動就 Client，其他盡量 Server。** 預設 Server 能讓送到瀏覽器的 JS 更少、首屏更快、密鑰更安全。

---

## 2. 怎麼變成 Client Component：`"use client"`

在檔案**最上面**加一行 `"use client";`，這個檔案（及它 import 的模組）就成為 Client Component：

```jsx
"use client";

import { useState } from "react";

export default function Counter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(count + 1)}>點了 {count} 次</button>;
}
```

沒有 `"use client"` 卻用了 `useState` / `onClick`，會直接報錯。這是新手最常見的錯。

---

## 3. `"use client"` 會「傳染」給子元件

一旦一個檔案標了 `"use client"`，它 import 進來的元件也會在客戶端執行。所以：

> **把 `"use client"` 放在越靠近葉子（真正需要互動的地方）越好，不要標在最上層。**

反例（不好）：在根 Layout 標 `"use client"`，會讓整棵樹都變 Client，失去 Server Component 的好處。

正解：頁面維持 Server，只把「按鈕」「表單」這種互動小元件抽出來標 `"use client"`。

---

## 4. 組合模式：Server 包 Client

最常見的正確結構——**Server 元件負責抓資料，把資料當 props 傳給 Client 元件做互動**：

```jsx
// app/page.js （Server Component，沒有 "use client"）
import LikeButton from "./LikeButton";

export default async function Page() {
  // 在伺服器抓資料（假裝是 DB 或 API）
  const article = { title: "Server 抓的文章", likes: 42 };

  return (
    <article>
      <h1>{article.title}</h1>
      {/* 把資料交給 Client 元件做互動 */}
      <LikeButton initialLikes={article.likes} />
    </article>
  );
}
```

```jsx
// app/LikeButton.js （Client Component）
"use client";
import { useState } from "react";

export default function LikeButton({ initialLikes }) {
  const [likes, setLikes] = useState(initialLikes);
  return <button onClick={() => setLikes(likes + 1)}>👍 {likes}</button>;
}
```

### 進階：用 children 把 Server 內容「塞進」Client 元件

Client 元件不能自己抓資料，但可以透過 `children` 接收「已經在 Server 算好的內容」：

```jsx
// Panel.js （Client：負責可折疊互動）
"use client";
import { useState } from "react";

export default function Panel({ children }) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <button onClick={() => setOpen(!open)}>{open ? "收合" : "展開"}</button>
      {open && <div>{children}</div>}
    </div>
  );
}
```

```jsx
// page.js （Server：把 Server 算好的內容當 children 傳進去）
import Panel from "./Panel";

export default function Page() {
  return (
    <Panel>
      {/* 這段仍是 Server Component，可以抓資料、不進前端 bundle */}
      <p>這段內容在伺服器算好，被折疊面板包住。</p>
    </Panel>
  );
}
```

> 記住：`children` 是把 Server 內容傳進 Client 元件的橋樑。Client 元件本身不變 Server，但它包住的內容可以是 Server 產物。

---

## 5. 常見錯誤對照

- ❌ 在 Server Component 用 `onClick` → 加 `"use client"` 或抽成 Client 子元件。
- ❌ 在 Client Component 用 `async function Component()` 直接 `await fetch` → Client 元件不能是 async；改用第 5 章的資料抓取方式或由 Server 傳入。
- ❌ 在 Client Component import 帶密鑰的模組 → 密鑰會被打包外洩，改在 Server 端使用。
- ❌ 整站標 `"use client"` → 失去 Server Component 優勢，只在葉子標。

---

## 6. 本章小練習

1. 做一個頁面（Server），在伺服器算出目前時間字串傳給一個 Client 計數器。
2. 把計數器抽成獨立檔案並標 `"use client"`，確認頁面本身沒有 `"use client"`。
3. 試著在 Server 頁面直接寫 `onClick`，看錯誤訊息，再修好。
4. 做一個可折疊 `Panel`（Client），把一段 Server 內容當 `children` 傳進去。

---

## 最後範例：Server 抓資料 + Client 互動混用

> 三個檔案示範「Server 負責資料、Client 負責互動」的標準組合。

### `app/page.js`（Server Component）

```jsx
import Counter from "./Counter";
import Panel from "./Panel";

// Server Component 可以是 async，直接在伺服器準備資料
export default async function Page() {
  // 模擬伺服器端資料（實務上是 DB / API，見第 5 章）
  const serverTime = new Date().toLocaleTimeString("zh-TW");
  const stats = { visits: 1280, likes: 42 };

  return (
    <main className="page">
      <h1>Server + Client 混用示範</h1>
      <p className="muted">伺服器渲染時間：{serverTime}</p>

      <Panel title="站台數據（Server 算好，Client 折疊）">
        <ul>
          <li>造訪次數：{stats.visits}</li>
          <li>初始讚數：{stats.likes}</li>
        </ul>
      </Panel>

      {/* 把 Server 算好的初始值交給 Client 元件做互動 */}
      <Counter initialLikes={stats.likes} />
    </main>
  );
}
```

### `app/Counter.js`（Client Component）

```jsx
"use client";
import { useState } from "react";

export default function Counter({ initialLikes }) {
  const [likes, setLikes] = useState(initialLikes);
  return (
    <div className="counter">
      <button onClick={() => setLikes(likes + 1)}>👍 讚一下</button>
      <span>目前 {likes} 個讚</span>
    </div>
  );
}
```

### `app/Panel.js`（Client Component）

```jsx
"use client";
import { useState } from "react";

export default function Panel({ title, children }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="panel">
      <button className="panel-head" onClick={() => setOpen(!open)}>
        {open ? "▼" : "▶"} {title}
      </button>
      {open && <div className="panel-body">{children}</div>}
    </section>
  );
}
```

### `app/globals.css`（可選樣式）

```css
.page { max-width: 640px; margin: 40px auto; font-family: sans-serif; }
.muted { color: #6b7280; }
.panel { border: 1px solid #e5e7eb; border-radius: 12px; margin: 16px 0; overflow: hidden; }
.panel-head { width: 100%; text-align: left; padding: 12px 16px; background: #f9fafb; border: 0; cursor: pointer; font-size: 15px; }
.panel-body { padding: 12px 16px; }
.counter { display: flex; align-items: center; gap: 12px; margin-top: 12px; }
.counter button { padding: 8px 14px; border-radius: 8px; border: 0; background: #2563eb; color: #fff; cursor: pointer; }
```

---

## 本章結語

你現在有了 App Router 最重要的心智模型：**預設 Server、需要互動才 Client、Server 抓資料 Client 做互動**。  
下一章用 `layout.js`、`loading.js`、`error.js` 把版面、載入與錯誤狀態組起來，讓頁面更完整。
