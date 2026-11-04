# 第 8 章：React Router 路由實戰

## 本章目標

完成這一章後，你應該可以：

1. 安裝並設定 React Router。
2. 建立多頁路由（首頁、列表頁、詳情頁、404）。
3. 使用巢狀路由與共用 Layout。
4. 使用動態路由參數載入指定內容。

---

## 1. 為什麼需要 Router？

單頁應用（SPA）雖然只載入一次 HTML，  
但仍需要「像多頁網站一樣」切換不同畫面。

Router 幫你處理：

- URL 對應哪個元件
- 頁面切換不刷新整站
- 巢狀頁面與共享 Layout

---

## 2. 安裝

```bash
npm install react-router-dom@6
```

> **版本提醒：**不加 `@6` 會裝到 React Router v7。本章用到的 `BrowserRouter`、`Routes`、`Route`、`Link`、`NavLink`、`Outlet`、`useParams` 在 v7 照樣可用、寫法相同（v7 也可以改從 `react-router` 匯入）；這裡鎖定 v6，是為了和後面章節與 admin-demo 一致。

---

## 3. 常用元件與 Hook

- `BrowserRouter`：啟用路由
- `Routes` / `Route`：定義路由規則
- `Link`：建立站內連結，取代 `<a href>`；點擊時只在瀏覽器內切換畫面，不會整頁重新載入
- `NavLink`：建立導覽連結，網址符合時會自動加上 `active` class
- `Outlet`：在 Layout 中渲染子頁面
- `useParams`：取得動態路由參數

> **官方文件的另一種寫法：**React Router 文件常見 `createBrowserRouter` + `RouterProvider`（資料路由，支援 loader／action）。本課程與 admin-demo 用的是 `<BrowserRouter>` + `<Routes>` 的宣告式寫法，資料抓取則交給第 9 章的 TanStack Query。

---

## 4. 巢狀路由思維

建議把共同區塊抽到 Layout（例如導覽列、頁尾）：

```txt
/
  |- layout
      |- index (Home)
      |- /courses
      |- /courses/:courseId
      |- /about
      |- *（其他網址 → 404）
```

寫成程式時，子路由的 `path` 不加開頭的 `/`（寫成 `courses`），會自動接在父路由 `/` 後面；`index` 代表父路徑本身，也就是 `/`。
`:courseId` 是動態片段，`/courses/react-basic` 的 `react-basic` 會變成 `courseId` 參數。

---

## 5. 本章小練習

1. 建立首頁、課程列表頁、關於頁。
2. 列表頁每筆課程可點進詳情頁。
3. 詳情頁用 `:courseId` 載入資料。
4. 加入 404 Not Found 頁面。

---

## 最後範例：課程網站路由結構

### `src/main.jsx`

```jsx
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./App.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
```

> **Console 出現 `React Router Future Flag Warning`？**這是 v6.28 之後加入的開發模式提醒（`v7_startTransition`、`v7_relativeSplatPath`），預告 v7 會改變的行為，不是錯誤，本章程式照常運作。想提前採用 v7 行為並消除警告，可以把 `<BrowserRouter>` 改成：
>
> ```jsx
> <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
> ```
>
> admin-demo 的 `src/main.jsx` 就是這樣設定的。

### `src/App.jsx`

```jsx
import { Route, Routes } from "react-router-dom";
import AppLayout from "./components/AppLayout";
import AboutPage from "./pages/AboutPage";
import CourseDetailPage from "./pages/CourseDetailPage";
import CoursesPage from "./pages/CoursesPage";
import HomePage from "./pages/HomePage";
import NotFoundPage from "./pages/NotFoundPage";

function App() {
  return (
    <Routes>
      <Route path="/" element={<AppLayout />}>
        <Route index element={<HomePage />} />
        <Route path="courses" element={<CoursesPage />} />
        <Route path="courses/:courseId" element={<CourseDetailPage />} />
        <Route path="about" element={<AboutPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

export default App;
```

### `src/data/courses.js`

```jsx
export const courses = [
  {
    id: "react-basic",
    title: "React 基礎入門",
    level: "beginner",
    description: "掌握元件、props、state 與事件處理。",
  },
  {
    id: "router-practice",
    title: "React Router 實戰",
    level: "intermediate",
    description: "建立多頁導覽、動態參數與巢狀路由。",
  },
  {
    id: "query-and-state",
    title: "Query + Zustand 整合",
    level: "advanced",
    description: "拆分伺服器狀態與本地狀態，建立可維護架構。",
  },
];
```

### `src/components/AppLayout.jsx`

```jsx
import { NavLink, Outlet } from "react-router-dom";

function AppLayout() {
  return (
    <div className="layout">
      <header className="header">
        <h1>React Course Site</h1>
        <nav>
          <NavLink to="/" end>
            首頁
          </NavLink>
          <NavLink to="/courses">課程</NavLink>
          <NavLink to="/about">關於</NavLink>
        </nav>
      </header>

      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}

export default AppLayout;
```

### `src/pages/HomePage.jsx`

```jsx
function HomePage() {
  return (
    <section className="card">
      <h2>首頁</h2>
      <p>歡迎來到 React 課程網站，請從課程頁開始學習。</p>
    </section>
  );
}

export default HomePage;
```

### `src/pages/CoursesPage.jsx`

```jsx
import { Link } from "react-router-dom";
import { courses } from "../data/courses";

function CoursesPage() {
  return (
    <section className="card">
      <h2>課程列表</h2>
      <ul>
        {courses.map((course) => (
          <li key={course.id}>
            <Link to={`/courses/${course.id}`}>{course.title}</Link> - {course.level}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default CoursesPage;
```

### `src/pages/CourseDetailPage.jsx`

```jsx
import { useParams } from "react-router-dom";
import { courses } from "../data/courses";

function CourseDetailPage() {
  const { courseId } = useParams();
  const course = courses.find((item) => item.id === courseId);

  if (!course) {
    return (
      <section className="card">
        <h2>找不到課程</h2>
        <p>請回到課程列表重新選擇。</p>
      </section>
    );
  }

  return (
    <section className="card">
      <h2>{course.title}</h2>
      <p>難度：{course.level}</p>
      <p>{course.description}</p>
    </section>
  );
}

export default CourseDetailPage;
```

### `src/pages/AboutPage.jsx`

```jsx
function AboutPage() {
  return (
    <section className="card">
      <h2>關於課程</h2>
      <p>這門課程會從 React 基礎一路帶到 Zustand 與 TanStack Query 實戰。</p>
    </section>
  );
}

export default AboutPage;
```

### `src/pages/NotFoundPage.jsx`

```jsx
import { Link } from "react-router-dom";

function NotFoundPage() {
  return (
    <section className="card">
      <h2>404 Not Found</h2>
      <p>你造訪的頁面不存在。</p>
      <Link to="/">回首頁</Link>
    </section>
  );
}

export default NotFoundPage;
```

### `src/App.css`

```css
body {
  margin: 0;
  font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #f8fafc;
}

.layout {
  width: min(900px, 100%);
  margin: 0 auto;
  padding: 0 16px 30px;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 0;
}

nav {
  display: flex;
  gap: 12px;
}

a {
  color: #334155;
  text-decoration: none;
}

a.active {
  color: #2563eb;
  font-weight: 700;
}

.content {
  margin-top: 8px;
}

.card {
  background: #ffffff;
  border-radius: 12px;
  padding: 16px;
  box-shadow: 0 6px 18px rgba(15, 23, 42, 0.06);
}

ul {
  padding-left: 18px;
}
```

### 範例解釋

1. `AppLayout` 提供共用導覽與 `Outlet`，避免每頁重複寫 header。`NavLink` 符合目前網址時會加上 `active` class，CSS 的 `a.active` 就是靠它變色；預設只要網址是 `to` 本身或它底下的路徑就算符合，所以在 `/courses/react-basic` 時「課程」也會亮起。加上 `end` 則只在網址完全相同時才算；首頁的 `/` 本來就只在剛好是 `/` 時亮起，加 `end` 是把意圖寫清楚。
2. `Routes` 內使用巢狀路由，讓首頁與其他頁面共用同一層布局。
3. `CourseDetailPage` 透過 `useParams` 讀取 `courseId`，做動態資料匹配。`useParams` 拿到的值一律是字串；這裡的 `id` 本來就是字串所以能直接 `===` 比較，若資料的 id 是數字，要先 `Number(courseId)` 再比。
4. `NotFoundPage` 讓錯誤路徑有明確回饋，提升導航體驗。它放在 `AppLayout` 底下，所以 404 畫面仍保有導覽列。注意 `/courses/abc` 這種網址仍會符合 `courses/:courseId`，不會進到 404，所以 `CourseDetailPage` 要自己處理「找不到課程」。

---

## 本章結語

你已經具備多頁應用的路由能力。  
下一章開始導入 TanStack Query，正式管理伺服器資料快取與抓取狀態。
