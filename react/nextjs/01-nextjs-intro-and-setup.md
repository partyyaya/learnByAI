# 第 1 章：Next.js 是什麼與環境建立

## 本章目標

完成這一章後，你應該可以：

1. 說出 Next.js 相對於純 React（Vite）多解決了哪些問題。
2. 分清 App Router 與 Pages Router，知道本課用哪個。
3. 用 `create-next-app` 建立一個可正常開發的專案。
4. 看懂 App Router 專案的基本結構與日常開發流程。

---

## 1. React 之後，為什麼還要 Next.js？

你在 React 課學到的是「用元件建構 UI」。但一個真正要上線的產品，還缺很多東西：

- **路由**：純 React 要自己裝 React Router，Next.js 用資料夾就是路由。
- **伺服器渲染（SSR）與 SEO**：SPA 首屏是空白 HTML，爬蟲不友善；Next.js 可在伺服器先產出 HTML。
- **資料抓取的位置**：SPA 只能在瀏覽器抓資料；Next.js 可以在伺服器抓，速度快又安全。
- **後端能力**：API 路由、Server Actions 讓你不必另外開一個後端專案。
- **效能優化**：圖片、字型、程式碼分割、快取，框架幫你處理掉大半。

用一句話記：

> **React 負責畫面，Next.js 負責「把 React 變成一個可上線的全端框架」。**

---

## 2. App Router vs Pages Router

Next.js 目前有兩套路由系統：

| | Pages Router（舊） | App Router（新，本課採用） |
|---|---|---|
| 資料夾 | `pages/` | `app/` |
| 元件預設 | Client Component | **Server Component** |
| 資料抓取 | `getServerSideProps` 等特殊函式 | 元件內直接 `await fetch` |
| 版面共享 | `_app.js` 一層 | `layout.js` 可巢狀多層 |
| 資料異動 | 自己寫 API + fetch | **Server Actions** |

新專案一律用 **App Router**。本課全程使用 App Router（Next.js 15）。

> 看到網路上教學用 `pages/` 或 `getServerSideProps`，那是舊寫法，別跟本課混用。

---

## 3. 安裝開發環境

### 3.1 Node.js 版本

Next.js 15 需要 **Node.js 18.18 以上（建議 20 LTS）**。確認版本：

```bash
node -v   # 要 >= 18.18，建議 v20
npm -v
```

若版本太舊，用 nvm 切換：

```bash
nvm install 20
nvm use 20
```

### 3.2 推薦工具

- 編輯器：Cursor / VS Code
- 瀏覽器：Chrome / Edge
- VS Code 插件：ESLint、Prettier

---

## 4. 用 create-next-app 建立專案

```bash
npx create-next-app@latest my-next-course
```

它會問幾個問題，本課建議這樣選：

```text
✔ Would you like to use TypeScript?        › No   （本課用 JavaScript，和 React 課一致）
✔ Would you like to use ESLint?            › Yes
✔ Would you like to use Tailwind CSS?      › No   （第 11 章再教，先用一般 CSS）
✔ Would you like to use `src/` directory?  › No
✔ Would you like to use App Router?        › Yes  （重要！）
✔ Would you like to customize the import alias? › No
```

建立完成後啟動：

```bash
cd my-next-course
npm run dev
```

打開 `http://localhost:3000`，看到 Next.js 歡迎頁就代表環境正確。

---

## 5. 專案結構先看懂

App Router 專案最重要的是 `app/` 資料夾：

```text
my-next-course/
├─ app/
│  ├─ layout.js      # 根版面，包住所有頁面（必要，含 <html><body>）
│  ├─ page.js        # 首頁，對應網址 "/"
│  └─ globals.css    # 全域樣式
├─ public/           # 靜態資源（圖片等），用 "/檔名" 存取
├─ next.config.mjs   # Next.js 設定
└─ package.json
```

三個關鍵約定，先記住：

> - `app/page.js` = 網址 `/` 的畫面
> - `app/layout.js` = 包在頁面外層的共用版面
> - 資料夾名稱 = 網址路徑（下一章詳談）

---

## 6. 日常開發流程（最小迴圈）

1. 啟動開發伺服器：`npm run dev`
2. 修改 `app/` 內的 `page.js` / `layout.js`
3. 瀏覽器自動熱更新（Fast Refresh）
4. 看終端機與瀏覽器 console 是否有錯誤
5. 每個小步驟一個 commit

> 和 Vite 不同的地方：Next.js 的錯誤（尤其是 Server Component 的錯）會出現在**跑 `npm run dev` 的終端機**，不只在瀏覽器，養成兩邊都看的習慣。

---

## 7. 本章小練習

把預設首頁換成你自己的內容：

1. 清空 `app/page.js`，改成顯示「Next.js 學習儀表板」。
2. 顯示今天日期。
3. 列出你這門課想達成的 3 個目標。
4. 在 `app/globals.css` 加一層簡單卡片樣式。

---

## 最後範例：Next.js 開發環境健康檢查頁

> 這是一個最小可跑的 App Router 專案。三個檔案原樣貼上即可運作。

### `app/layout.js`

```jsx
// 根版面：每個頁面都會被它包住，必須包含 <html> 與 <body>
import "./globals.css";

export const metadata = {
  title: "Next.js 學習儀表板",
  description: "Next.js 課程第一章環境檢查頁",
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}
```

### `app/page.js`

```jsx
// 這是 Server Component（App Router 預設），可以直接算好資料再渲染
const goals = [
  "完成 Next.js 開發環境安裝",
  "看懂 App Router 專案結構",
  "能獨立啟動並修改第一個頁面",
];

export default function HomePage() {
  const today = new Date().toLocaleDateString("zh-TW", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  });

  return (
    <main className="page">
      <section className="card">
        <h1>Next.js 學習儀表板</h1>
        <p className="muted">今天是：{today}</p>
        <h2>本章完成目標</h2>
        <ul>
          {goals.map((goal) => (
            <li key={goal}>{goal}</li>
          ))}
        </ul>
      </section>
    </main>
  );
}
```

### `app/globals.css`

```css
:root {
  font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: #111827;
  background-color: #f3f4f6;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
}

.page {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
}

.card {
  width: min(680px, 100%);
  background: #ffffff;
  border-radius: 16px;
  padding: 24px;
  box-shadow: 0 10px 30px rgba(17, 24, 39, 0.08);
}

.muted {
  color: #4b5563;
}

h1,
h2 {
  margin-top: 0;
}

ul {
  padding-left: 20px;
}

li {
  margin-bottom: 8px;
}
```

---

## 本章結語

你已經把 Next.js 專案跑起來，也知道 `app/` 是整個 App Router 的核心。  
下一章會深入檔案系統路由：資料夾怎麼變成網址、怎麼做巢狀頁面與導覽。
