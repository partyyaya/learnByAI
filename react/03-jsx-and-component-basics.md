# 第 3 章：JSX 與元件基礎

## 本章目標

完成這一章後，你應該可以：

1. 正確撰寫 JSX，避開常見語法錯誤。
2. 把畫面拆成可重用的函式元件。
3. 用簡單的資料陣列渲染卡片清單。
4. 建立一個小型頁面並保持結構清楚。

---

## 1. JSX 是什麼？

JSX 是 JavaScript 的語法擴充，讓你可以在 JS 裡描述 UI。

你可以把它理解成：

> **「用類似 HTML 的寫法，回傳 React 元素」**

例如：

```jsx
function Title() {
  return <h1>React 元件課程</h1>;
}
```

---

## 2. JSX 三個必懂規則

### 2.1 元件只能回傳一個根節點

```jsx
return (
  <div>
    <h1>標題</h1>
    <p>內容</p>
  </div>
);
```

### 2.2 在 JSX 中插入 JS 要用 `{}` 

```jsx
const name = "Gary";
return <h1>Hi, {name}</h1>;
```

### 2.3 屬性名稱用駝峰式（camelCase）

- `class` -> `className`
- `onclick` -> `onClick`

---

## 3. 函式元件的最小樣板

```jsx
function LessonCard() {
  return (
    <article>
      <h3>JSX 與元件</h3>
      <p>35 分鐘</p>
    </article>
  );
}
```

命名規則：

- 元件名稱首字母大寫
- 一個元件只做一件事（顯示卡片、顯示標題、顯示清單）

---

## 4. 畫面拆分思維

假設你要做「課程列表頁」，可以這樣拆：

- `CourseHeader`：頁面標題與說明
- `LessonCard`：單張課程卡片
- `LessonList`：負責迭代清單
- `App`：組合整頁

這樣拆的好處是：未來新增功能時，不會全部擠在同一個檔案。

---

## 5. 清單渲染與 key

渲染清單時請記得加上穩定的 `key`：

```jsx
{lessons.map((lesson) => (
  <LessonCard key={lesson.id} lesson={lesson} />
))}
```

`key` 建議用資料本身的 id，不要用 index（除非真的沒有穩定 id）。

---

## 6. 本章小練習

1. 將一個單頁資訊區塊拆成至少 3 個元件。
2. 使用陣列資料渲染至少 4 張卡片。
3. 每張卡片顯示標題、時長、難度。
4. 加入「已發布 / 草稿」標籤樣式。

---

## 最後範例：課程列表頁（元件拆分版）

### `src/App.jsx`

```jsx
import CourseHeader from "./components/CourseHeader";
import LessonList from "./components/LessonList";
import "./App.css";

const lessons = [
  { id: "r-101", title: "React 心智模型", minutes: 35, level: "Beginner", published: true },
  { id: "r-102", title: "JSX 與元件拆分", minutes: 42, level: "Beginner", published: true },
  { id: "r-201", title: "路由與頁面結構", minutes: 50, level: "Intermediate", published: false },
  { id: "r-301", title: "效能優化入門", minutes: 47, level: "Intermediate", published: true },
];

function App() {
  return (
    <main className="page">
      <CourseHeader
        title="React 課程列表"
        subtitle="第 3 章最終範例：用 JSX + 元件拆分完成可維護頁面"
      />
      <LessonList lessons={lessons} />
    </main>
  );
}

export default App;
```

### `src/components/CourseHeader.jsx`

```jsx
function CourseHeader({ title, subtitle }) {
  return (
    <header className="header">
      <h1>{title}</h1>
      <p>{subtitle}</p>
    </header>
  );
}

export default CourseHeader;
```

### `src/components/LessonCard.jsx`

```jsx
function LessonCard({ lesson }) {
  return (
    <article className="card">
      <div className="card-top">
        <h2>{lesson.title}</h2>
        <span className={lesson.published ? "badge published" : "badge draft"}>
          {lesson.published ? "已發布" : "草稿"}
        </span>
      </div>
      <p>時長：{lesson.minutes} 分鐘</p>
      <p>難度：{lesson.level}</p>
    </article>
  );
}

export default LessonCard;
```

### `src/components/LessonList.jsx`

```jsx
import LessonCard from "./LessonCard";

function LessonList({ lessons }) {
  return (
    <section className="list">
      {lessons.map((lesson) => (
        <LessonCard key={lesson.id} lesson={lesson} />
      ))}
    </section>
  );
}

export default LessonList;
```

### `src/App.css`

```css
:root {
  font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: #f5f7fb;
  color: #111827;
}

.page {
  width: min(920px, 100%);
  margin: 40px auto;
  padding: 0 16px 32px;
}

.header {
  background: #ffffff;
  border-radius: 16px;
  padding: 20px;
  margin-bottom: 18px;
  box-shadow: 0 8px 24px rgba(17, 24, 39, 0.08);
}

.header h1 {
  margin: 0 0 8px;
}

.header p {
  margin: 0;
  color: #4b5563;
}

.list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 14px;
}

.card {
  background: #ffffff;
  border-radius: 14px;
  padding: 16px;
  box-shadow: 0 8px 20px rgba(17, 24, 39, 0.06);
}

.card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.card h2 {
  font-size: 18px;
  margin: 0;
}

.badge {
  font-size: 12px;
  padding: 4px 8px;
  border-radius: 999px;
}

.badge.published {
  background: #dcfce7;
  color: #166534;
}

.badge.draft {
  background: #fee2e2;
  color: #991b1b;
}
```

---

## 本章結語

到這裡你已經能把 UI 拆成可讀、可維護、可重用的元件。  
下一章會進一步聚焦在 `props`，把資料在元件之間穩定地傳遞與組合起來。
