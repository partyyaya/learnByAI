# 第 2 章：JavaScript 必備觀念補強

## 本章目標

完成這一章後，你應該可以：

1. 熟練 React 常用的 JavaScript 寫法。
2. 用不可變資料思維更新陣列與物件。
3. 使用 `map / filter / reduce` 處理清單資料。
4. 讀懂並撰寫 `async/await` 的資料處理流程。
5. 用 `import / export` 拆分與組合模組。

---

## 1. 為什麼 React 前要先補 JavaScript？

React 看起來像在寫 UI，但本質仍是 JavaScript。  
你在元件裡每天都會做這些事：

- 用解構拿 props 或 state
- 用陣列方法渲染清單
- 用展開運算子更新資料
- 用 async/await 打 API

所以 JS 基礎穩不穩，會直接決定你寫 React 的速度與可讀性。

---

## 2. 解構（Destructuring）與預設值

React 中常見場景：

```js
const user = { name: "Gary", role: "student" };
const { name, role, avatar = "/default-avatar.png" } = user;
```

重點：

- 解構可以快速拿到欄位。
- 預設值可避免 `undefined` 造成顯示錯誤。
- 預設值只在欄位是 `undefined`（或根本沒有這個欄位）時生效；值是 `null` 時不會套用，這時要改用第 5 節的 `??`。

解構時也可以順便改名，後端欄位名稱跟畫面想用的不同時很常用（本章最後範例就是這樣寫）：

```js
const lesson = { lesson_id: "r-101", lesson_title: "React 入門" };
const { lesson_id: id, lesson_title: title } = lesson;
// 取出 lesson_id 存成變數 id，取出 lesson_title 存成變數 title
```

---

## 3. 展開運算子（Spread）與不可變更新

React 內更新資料時，不要直接改原始值。

```js
const prev = { theme: "light", lang: "zh-TW" };
const next = { ...prev, theme: "dark" };
```

陣列也一樣：

```js
const prevLessons = ["JS", "React"];
const nextLessons = [...prevLessons, "TanStack Query"];
```

這是 React 狀態管理最關鍵的基本功。原因是 React 判斷資料有沒有變，比的是「是不是同一個物件／陣列」，不會逐欄比對內容；直接改原本的物件，它還是同一個，畫面可能就不會更新（第 5 章會實際看到）。

要注意展開只複製「一層」。巢狀物件要一路展開到要改的那一層：

```js
const prevUser = { name: "Gary", profile: { city: "Taipei" } };
const nextUser = { ...prevUser, profile: { ...prevUser.profile, city: "Taichung" } };
```

---

## 4. 陣列三兄弟：map、filter、reduce

### `map`
把資料轉成另一種格式（例如給 UI 顯示用）。

### `filter`
做資料篩選（例如只保留已發布課程）。

### `reduce`
做統計、分組、彙總（例如總時數、每個等級課程數量）。

三者都不會改動原陣列，而是回傳新的結果，正好符合上一節的不可變更新；本章最後範例會把三者串起來用。

---

## 5. Optional Chaining 與 Nullish Coalescing

後端資料不完整時，這兩個語法很常救你：

```js
const authorName = lesson.author?.name ?? "未知作者";
```

- `?.`：前一段是 `null/undefined` 時就停止，整段得到 `undefined`，不丟錯
- `??`：只有在 `null/undefined` 才套預設值

`??` 和 `||` 的差別在於 `0`、`""`、`false`：`||` 會把它們也當成「沒有值」而換成預設值，`??` 則會保留。

```js
const minutes = 0;
minutes || 30; // 30（0 被換掉了）
minutes ?? 30; // 0
```

---

## 6. async/await 與錯誤處理

打 API 的基本版型：

```js
async function fetchData() {
  try {
    const response = await fetch("/api/lessons");
    if (!response.ok) {
      throw new Error("API request failed");
    }
    return await response.json();
  } catch (error) {
    console.error(error);
    return [];
  }
}
```

`if (!response.ok)` 這一行不能省：`fetch` 只有在連不上伺服器這類網路錯誤時才會丟錯，伺服器回 404、500 時仍會正常拿到 `response`，所以要自己檢查、自己丟錯。

「檢查 `response.ok`、不成功就丟錯」這段，在第 7、9 章串 API 時會一直用到。不過交給 TanStack Query 時，取資料的函式通常不在裡面 `catch` 再回傳 `[]`，而是讓錯誤直接丟出去，Query 才知道這次請求失敗（第 9 章）。

---

## 7. ES Modules：import 與 export

React 專案的每個元件、hook、工具函式都是一個模組，你會在每一章看到這兩種匯出方式：

### 預設匯出（default export）——一個檔案一個主角

```js
// LessonCard.jsx
export default function LessonCard() { /* ... */ }

// 匯入時名稱可以自取（但建議與檔名一致）
import LessonCard from "./LessonCard";
```

### 具名匯出（named export）——一個檔案多個工具

```js
// utils/format.js
export function formatMinutes(min) { /* ... */ }
export const LEVELS = ["beginner", "intermediate", "advanced"];

// 匯入時名稱必須相同，且要加大括號
import { formatMinutes, LEVELS } from "./utils/format";
```

記憶重點：

- **元件檔**通常用 `export default`（一個檔案一個元件）。
- **工具 / API / hook 檔**通常用具名匯出（一個檔案多個函式）。
- 匯入路徑是相對路徑（`./`、`../`）；忘記大括號或路徑打錯是初學最常見的錯誤。
- 在 Vite 專案裡可以省略 `.js`／`.jsx` 副檔名；但用 `node` 直接執行時（例如小練習 5 拆檔後），要寫完整檔名，如 `"./utils/format.js"`，否則會出現 `ERR_MODULE_NOT_FOUND`。

---

## 8. 本章小練習

1. 將一組課程資料轉成 `{ id, title, minutes }` 結構。
2. 篩出 `published: true` 的課程。
3. 用 `reduce` 算出總分鐘數。
4. 模擬一個 `fetchLessons` 非同步函式並加入錯誤處理。
5. 把 `normalizeLesson` 拆到獨立檔案，用具名匯出後再 `import` 回來使用。

---

## 最後範例：課程資料轉換器（React 前置版）

> 這個範例可先用 Node 執行；下一章的元件會用同樣結構的資料（`id`、`title`、`minutes`…）渲染畫面。

### `lesson-data-adapter.js`

```js
const rawLessons = [
  {
    lesson_id: "r-101",
    lesson_title: "React 入門與心智模型",
    duration_min: 35,
    level: "beginner",
    published: true,
    author: { name: "Eddy" },
  },
  {
    lesson_id: "r-102",
    lesson_title: "JSX 與元件拆分",
    duration_min: 42,
    level: "beginner",
    published: true,
    author: null,
  },
  {
    lesson_id: "r-201",
    lesson_title: "TanStack Query 快取策略",
    duration_min: 55,
    level: "intermediate",
    published: false,
    author: { name: "Nina" },
  },
];

function normalizeLesson(lesson) {
  const {
    lesson_id: id,
    lesson_title: title,
    duration_min: minutes,
    level,
    published,
    author,
  } = lesson;

  return {
    id,
    title,
    minutes,
    level,
    published,
    authorName: author?.name ?? "未知作者",
  };
}

function buildLessonViewModel(lessons) {
  const normalized = lessons.map(normalizeLesson);
  const publishedLessons = normalized.filter((lesson) => lesson.published);

  const summary = normalized.reduce(
    (acc, lesson) => {
      acc.totalLessons += 1;
      acc.totalMinutes += lesson.minutes;
      acc.levelCount[lesson.level] = (acc.levelCount[lesson.level] ?? 0) + 1;
      return acc;
    },
    {
      totalLessons: 0,
      totalMinutes: 0,
      levelCount: {},
    }
  );

  return {
    normalized,
    publishedLessons,
    summary,
  };
}

async function fetchLessonsMock() {
  return new Promise((resolve) => {
    setTimeout(() => resolve(rawLessons), 300);
  });
}

async function run() {
  try {
    const lessons = await fetchLessonsMock();
    const viewModel = buildLessonViewModel(lessons);
    console.log("=== 可用於 React 畫面的資料 ===");
    console.log(JSON.stringify(viewModel, null, 2));
  } catch (error) {
    console.error("資料處理失敗：", error);
  }
}

run();
```

### 執行方式

```bash
node lesson-data-adapter.js
```

---

## 本章結語

你現在補齊了 React 最常用的 JavaScript 能力。  
下一章會正式進入 JSX 與元件拆分，開始把資料渲染成可維護的 UI。
