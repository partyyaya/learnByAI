# 第 2 章：JavaScript 必備觀念補強

## 本章目標

完成這一章後，你應該可以：

1. 熟練 React 常用的 JavaScript 寫法。
2. 用不可變資料思維更新陣列與物件。
3. 使用 `map / filter / reduce` 處理清單資料。
4. 讀懂並撰寫 `async/await` 的資料處理流程。

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

這是 React 狀態管理最關鍵的基本功。

---

## 4. 陣列三兄弟：map、filter、reduce

### `map`
把資料轉成另一種格式（例如給 UI 顯示用）。

### `filter`
做資料篩選（例如只保留已發布課程）。

### `reduce`
做統計、分組、彙總（例如總時數、每個等級課程數量）。

---

## 5. Optional Chaining 與 Nullish Coalescing

後端資料不完整時，這兩個語法很常救你：

```js
const authorName = lesson.author?.name ?? "未知作者";
```

- `?.`：前一段是 `null/undefined` 時就停止，不丟錯
- `??`：只有在 `null/undefined` 才套預設值

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

這個模式在 React + TanStack Query 時也會一直用到。

---

## 7. 本章小練習

1. 將一組課程資料轉成 `{ id, title, minutes }` 結構。
2. 篩出 `published: true` 的課程。
3. 用 `reduce` 算出總分鐘數。
4. 模擬一個 `fetchLessons` 非同步函式並加入錯誤處理。

---

## 最後範例：課程資料轉換器（React 前置版）

> 這個範例可先用 Node 執行，下一章會把結果接到 React 元件。

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
