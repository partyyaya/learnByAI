# 第 11 章：Zustand 全域狀態管理

## 本章目標

完成這一章後，你應該可以：

1. 建立 Zustand store 並定義 actions。
2. 管理跨元件共用的 UI / 本地狀態。
3. 使用 selector 只訂閱需要的欄位，避免不必要重渲染。
4. 使用 `persist` 把偏好設定保存到 localStorage。

---

## 1. 為什麼要 Zustand？

當狀態需要跨層共用時，單靠 props 傳遞會變長鏈條（props drilling）。  
Zustand 提供輕量且直覺的全域狀態方案。

適合放在 Zustand 的通常是：

- UI 偏好（深色模式、側欄開關）
- 跨頁共享但不屬於伺服器資料的狀態
- 短期快取的本地互動資料

---

## 2. 安裝

```bash
npm install zustand
```

---

## 3. 建立 store 基本模式

```jsx
import { create } from "zustand";

export const useUiStore = create((set) => ({
  theme: "light",
  toggleTheme: () => set((state) => ({ theme: state.theme === "light" ? "dark" : "light" })),
}));
```

- `create` 回傳的是一個 hook。store 本身活在這個模組裡，不需要像 `QueryClientProvider` 那樣在外層包 Provider，任何元件 import 這個 hook 就能用。
- `set` 可以傳物件，也可以傳函式：新值要依賴舊值時（例如切換、累加）用 `set((state) => ...)`，直接指定時寫 `set({ theme: "dark" })` 即可。
- 傳給 `set` 的物件（或函式回傳的物件）會和現有狀態**淺層合併**，不必像 `useState` 的物件那樣自己寫 `...state`；但只合併第一層，巢狀物件仍要自己展開。

---

## 4. selector 與最小訂閱

```jsx
const theme = useUiStore((state) => state.theme);
```

只取需要欄位，能減少無關重渲染，對大型畫面很重要。

Zustand 會在 store 每次變動後重跑 selector，用 `Object.is` 比較這次與上次的回傳值，不同才讓元件重渲染。
所以不傳 selector、直接寫 `useUiStore()` 等於訂閱整個 store，任何欄位變動都會重渲染。
actions（如 `toggleTheme`）建立後就不會再變，單獨選出來不會造成額外重渲染。

> **selector 不要每次回傳新物件或新陣列。**
> 想一次取多個欄位而寫成 `useUiStore((state) => ({ theme: state.theme, sidebarOpen: state.sidebarOpen }))`，
> 每次執行都是一個新物件，`Object.is` 永遠判定「變了」。在 Zustand v5 會直接無限重渲染，
> 主控台出現 `Maximum update depth exceeded`。
> 解法是像下面的範例一樣一個欄位寫一個 selector，或用 `useShallow` 包起來改成逐欄比較：
>
> ```jsx
> import { useShallow } from "zustand/react/shallow";
>
> const { theme, sidebarOpen } = useUiStore(
>   useShallow((state) => ({ theme: state.theme, sidebarOpen: state.sidebarOpen }))
> );
> ```
>
> 在 selector 裡 `filter`、`map` 產生新陣列也是同一個問題；這類衍生資料請先選出原始陣列，再到元件裡計算
> （像下面範例的 `filteredLessons`）。資料量大、計算真的昂貴時，才需要第 13 章的 `useMemo`。

---

## 5. 本章小練習

1. 建一個 UI store：`theme`、`sidebarOpen`、`activeTrack`。
2. 做主題切換、側欄開關、學習路徑切換。
3. 新增收藏課程功能（`bookmarkedIds`）。
4. 透過 `persist` 保留使用者偏好。

---

## 最後範例：學習控制台全域狀態

### `src/store/useUiStore.js`

```jsx
import { create } from "zustand";
import { persist } from "zustand/middleware";

export const useUiStore = create(
  persist(
    (set) => ({
      theme: "light",
      sidebarOpen: true,
      activeTrack: "react-core",
      bookmarkedLessonIds: [],

      toggleTheme: () =>
        set((state) => ({
          theme: state.theme === "light" ? "dark" : "light",
        })),

      toggleSidebar: () =>
        set((state) => ({
          sidebarOpen: !state.sidebarOpen,
        })),

      setActiveTrack: (track) =>
        set(() => ({
          activeTrack: track,
        })),

      toggleBookmark: (lessonId) =>
        set((state) => {
          const exists = state.bookmarkedLessonIds.includes(lessonId);
          return {
            bookmarkedLessonIds: exists
              ? state.bookmarkedLessonIds.filter((id) => id !== lessonId)
              : [...state.bookmarkedLessonIds, lessonId],
          };
        }),
    }),
    { name: "react-course-ui-store" }
  )
);
```

### `src/App.jsx`

```jsx
import { useUiStore } from "./store/useUiStore";
import "./App.css";

const lessons = [
  { id: "r-101", title: "React 核心", track: "react-core" },
  { id: "r-201", title: "Router 實戰", track: "react-core" },
  { id: "q-101", title: "TanStack Query 基礎", track: "data-layer" },
  { id: "z-101", title: "Zustand 狀態管理", track: "data-layer" },
];

function App() {
  const theme = useUiStore((state) => state.theme);
  const sidebarOpen = useUiStore((state) => state.sidebarOpen);
  const activeTrack = useUiStore((state) => state.activeTrack);
  const bookmarkedIds = useUiStore((state) => state.bookmarkedLessonIds);
  const toggleTheme = useUiStore((state) => state.toggleTheme);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  const setActiveTrack = useUiStore((state) => state.setActiveTrack);
  const toggleBookmark = useUiStore((state) => state.toggleBookmark);

  // 只有四筆資料，每次 render 直接篩選即可
  const filteredLessons = lessons.filter((lesson) => lesson.track === activeTrack);

  return (
    <main className={`page ${theme}`}>
      <header className="header">
        <h1>第 11 章最終範例：Zustand 全域狀態</h1>
        <div className="row">
          <button onClick={toggleTheme}>切換主題</button>
          <button onClick={toggleSidebar}>{sidebarOpen ? "收合側欄" : "展開側欄"}</button>
        </div>
      </header>

      <div className="layout">
        {sidebarOpen && (
          <aside className="sidebar">
            <h2>學習路徑</h2>
            <button
              className={activeTrack === "react-core" ? "active" : ""}
              onClick={() => setActiveTrack("react-core")}
            >
              React Core
            </button>
            <button
              className={activeTrack === "data-layer" ? "active" : ""}
              onClick={() => setActiveTrack("data-layer")}
            >
              Data Layer
            </button>
          </aside>
        )}

        <section className="content">
          <h2>課程列表</h2>
          <ul>
            {filteredLessons.map((lesson) => {
              const isBookmarked = bookmarkedIds.includes(lesson.id);
              return (
                <li key={lesson.id}>
                  <span>{lesson.title}</span>
                  <button onClick={() => toggleBookmark(lesson.id)}>
                    {isBookmarked ? "取消收藏" : "加入收藏"}
                  </button>
                </li>
              );
            })}
          </ul>
          <p>目前收藏數量：{bookmarkedIds.length}</p>
        </section>
      </div>
    </main>
  );
}

export default App;
```

### `src/App.css`

```css
body {
  margin: 0;
  font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

.page {
  min-height: 100vh;
  padding: 18px;
  transition: background 0.2s ease, color 0.2s ease;
}

.page.light {
  background: #f8fafc;
  color: #0f172a;
}

.page.dark {
  background: #0f172a;
  color: #e2e8f0;
}

.header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.row {
  display: flex;
  gap: 8px;
}

.layout {
  margin-top: 12px;
  display: grid;
  grid-template-columns: 220px 1fr;
  gap: 12px;
}

.sidebar,
.content {
  background: rgba(255, 255, 255, 0.9);
  color: #0f172a;
  border-radius: 12px;
  padding: 14px;
}

.sidebar button,
.content button,
.header button {
  border: 0;
  border-radius: 8px;
  background: #1d4ed8;
  color: #fff;
  padding: 7px 10px;
  cursor: pointer;
}

.sidebar button {
  display: block;
  width: 100%;
  margin-bottom: 8px;
}

.sidebar button.active {
  background: #0f172a;
}

ul {
  list-style: none;
  padding: 0;
}

li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  border-bottom: 1px solid #e2e8f0;
}
```

### 範例解釋

1. `useUiStore` 集中管理 UI 偏好與跨元件狀態，避免 props 層層傳遞。
2. `persist` 把 store 寫入 localStorage，刷新頁面後仍保留使用者偏好。`name` 就是 localStorage 的 key，可以在瀏覽器 DevTools 的 Application → Local Storage 看到 `react-course-ui-store` 存了什麼；函式（actions）不會被存進去。只想保存部分欄位時，可以在第二個參數加 `partialize`。
3. 每個欄位各寫一個 selector，元件只會在自己讀的欄位變動時重渲染。這個範例為了好讀全寫在 `App` 裡，所以任一欄位變動 `App` 仍會重渲染；拆成 Header、Sidebar 等子元件、各自只選自己需要的欄位後，效果才會明顯。
4. `toggleBookmark` 用不可變更新維護 id 清單，邏輯穩定可預測。

> **改了 store 的預設值卻沒反應？** 加上 `persist` 之後，重新整理時 localStorage 裡的舊值會蓋過程式裡的預設值。
> 開發時想看預設值的效果，先到 DevTools 刪掉那個 key 再重新整理。

---

## 本章結語

你已能用 Zustand 管理全域本地狀態。  
下一章會把 Zustand 與 TanStack Query 串起來，建立實務級資料分工架構。
