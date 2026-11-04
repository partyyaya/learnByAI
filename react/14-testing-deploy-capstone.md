# 第 14 章：測試、部署與期末專題

## 本章目標

完成這一章後，你應該可以：

1. 在 Vite 專案中設定 Vitest + React Testing Library。
2. 為純函式與 React 元件撰寫可維護的測試。
3. 測試依賴 Router、TanStack Query 與 Zustand 的元件。
4. 打包專案、設定環境變數，並部署到靜態託管平台。
5. 獨立完成一個涵蓋全課程能力的期末專題。

---

## 1. 測試在測什麼？

前端測試的重點不是「測 React」，而是**測你的行為承諾**：

- 純函式：給定輸入，輸出是否正確（驗證規則、資料轉換）
- 元件：使用者操作後，畫面是否呈現預期結果

有兩個原則貫穿本章：

> 1. **測行為，不測實作細節。** 測「點了新增後清單多一筆」，不要測「state 變數叫什麼名字」。
> 2. **查詢元素優先用使用者視角。** `getByRole` / `getByLabelText` 優先，`getByTestId` 是最後手段。

---

## 2. 安裝 Vitest + React Testing Library

Vite 專案的標準測試組合：

```bash
npm install -D vitest jsdom @testing-library/react @testing-library/dom @testing-library/jest-dom @testing-library/user-event
```

各套件角色：

- `vitest`：測試框架（跑測試、斷言），與 Vite 共用設定，速度快
- `jsdom`：在 Node 中模擬瀏覽器 DOM
- `@testing-library/react`：渲染元件並以使用者視角查詢
- `@testing-library/dom`：`getByRole` 等查詢的底層實作；`@testing-library/react` 從 v16 起不再自帶，要自己裝
- `@testing-library/jest-dom`：補充 DOM 斷言（如 `toBeInTheDocument`）
- `@testing-library/user-event`：模擬真實使用者操作（輸入、點擊）

### 設定 `vite.config.js`

```js
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    // jsdom：在 Node 裡模擬瀏覽器 DOM，元件才有地方可以 render
    environment: "jsdom",
    // globals：讓 describe / it / expect 免 import 就能用
    globals: true,
    // 每個測試檔開跑前先執行的共用設定
    setupFiles: "./src/test/setup.js",
  },
});
```

這段 `test` 是加進你原本的 `vite.config.js`，`plugins` 等既有設定照舊保留。
Vitest 直接讀 `vite.config.js`，所以專案若設定了路徑別名（例如 admin-demo 的 `@` → `src/`），
在測試檔裡同樣有效，不必再設定一次。`npm create vite` 建立的專案預設沒有這個別名，本章的範例除了 §5.5 之外都用相對路徑。

### 建立 `src/test/setup.js`

```js
import "@testing-library/jest-dom";
```

目前只需要這一行；到 §5.5 會再往裡面加「每個測試前重設 Zustand 與 localStorage」。

這行會擴充全域的 `expect`，所以要搭配上面的 `globals: true`。若你不開 globals，改寫成 `import "@testing-library/jest-dom/vitest";`，
否則每個測試檔一開跑就會失敗在 `ReferenceError: expect is not defined`。

### 加入 npm script

```json
{
  "scripts": {
    "test": "vitest",
    "test:run": "vitest run"
  }
}
```

`npm run test` 進入 watch 模式，存檔即重跑，適合開發時開著。
`npm run test:run` 跑完一輪就結束並回傳結束碼，是 CI 與部署前檢查要用的那一個。

---

## 3. 第一個測試：純函式

最容易上手也最划算的測試對象，是第 6 章的 `validateForm` 這類純函式。  
先把它抽到獨立檔案（`src/utils/validateForm.js`），再寫測試。搬的時候記得三件事：
它用到的 `levelOptions` 要一起搬過去（否則會報 `levelOptions is not defined`）、函式前面加上 `export`、
`App.jsx` 改成 `import { validateForm } from "./utils/validateForm";`。

```js
// src/utils/validateForm.test.js
import { describe, expect, it } from "vitest";
import { validateForm } from "./validateForm";

const validInput = {
  title: "React Router 實戰",
  level: "beginner",
  minutes: "60",
  description: "學會巢狀路由與動態參數的實務用法",
};

describe("validateForm", () => {
  it("合法輸入不回傳任何錯誤", () => {
    expect(validateForm(validInput)).toEqual({});
  });

  it("標題太短時回傳錯誤訊息", () => {
    const errors = validateForm({ ...validInput, title: "abc" });
    expect(errors.title).toBe("課程名稱至少 4 個字。");
  });

  it("時長超出範圍時回傳錯誤訊息", () => {
    const errors = validateForm({ ...validInput, minutes: "999" });
    expect(errors.minutes).toBe("課程時長需介於 5 到 180 分鐘。");
  });
});
```

寫測試的節奏是固定的三段式：**準備輸入 → 執行 → 斷言輸出**。

---

## 4. 元件測試：render、screen、userEvent

元件測試模擬的是使用者的完整操作流程：

```jsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
```

- `render(<App />)`：把元件掛進 jsdom
- `screen.getByRole(...)`：像使用者一樣「看到」元素
- `userEvent.setup()`：產生模擬操作者，`type`、`click` 都回傳 Promise，記得 `await`

常用查詢優先序：

| 優先序 | 查詢 | 例子 |
|--------|------|------|
| 1 | `getByRole` | `getByRole("button", { name: "新增" })` |
| 2 | `getByLabelText` | 表單欄位 |
| 3 | `getByPlaceholderText` / `getByText` | 無 label 時 |
| 最後 | `getByTestId` | 上面都拿不到才用 |

> **測不到，常常代表使用者也「看不到」。**
> 工具列上的搜尋框與下拉選單為了版面，往往只有 placeholder 甚至什麼都沒有。
> 這種元素用 `getByRole` / `getByLabelText` 都抓不到——但真正的問題不在測試，
> 而是讀螢幕的使用者也不知道那格是做什麼的。正確的處理是回頭補上可及名稱：
>
> ```jsx
> <input aria-label="搜尋課程名稱" placeholder="搜尋課程名稱" ... />
> <select aria-label="難度篩選" ...>
> ```
>
> 補完之後測試自然就能寫成 `getByLabelText("難度篩選")`。
> 注意 placeholder 不能取代 label——它一開始打字就消失了。
> 先想著繞過去改用 `getByTestId`，等於把問題藏起來。

上面的寫法適用於「自給自足」的元件——只靠 props 與自己的 `useState` 就能運作。
一旦元件用到路由或 TanStack Query，直接 `render` 會當場失敗，下一節專門處理這件事。

---

## 5. 測試需要 Provider 的元件

第 8 章之後的元件幾乎都不再自給自足，它們依賴「由外部提供的執行環境」：

| 元件用了什麼 | 由誰提供 | 少給了會看到的錯誤 |
|---|---|---|
| `useNavigate` | Router | `useNavigate() may be used only in the context of a <Router> component` |
| `<Link>` | Router | `Cannot destructure property 'basename' of ... as it is null`（React Router 6 後期版本；字面上完全看不出是少了 Router） |
| `useParams` | Router + 對應的 `<Route>` | 不報錯，只會拿到空物件（見 5.2） |
| `useQuery`、`useMutation` | `QueryClientProvider` | `No QueryClient set, use QueryClientProvider to set one` |
| Zustand store | 不需要 Provider | 不報錯，但測試之間會互相污染 |

正式環境這些 Provider 掛在 `main.jsx`；測試環境沒有 `main.jsx`，就得自己補上。

> **元件測試第一次跑就爆炸，八成不是元件壞了，是測試少給了執行環境。**

### 5.1 用到 `<Link>` / `useNavigate`：包 MemoryRouter

被測元件：

```jsx
// src/components/CourseCard.jsx
import { Link } from "react-router-dom";

function CourseCard({ course }) {
  return (
    <article className="course-card">
      <h3>
        <Link to={`/courses/${course.id}`}>{course.title}</Link>
      </h3>
      <p>{course.minutes} 分鐘</p>
    </article>
  );
}

export default CourseCard;
```

測試：

```jsx
// src/components/CourseCard.test.jsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import CourseCard from "./CourseCard";

const course = { id: 7, title: "React Router 巢狀路由", minutes: 90 };

describe("CourseCard", () => {
  it("課程名稱是連到詳情頁的連結", () => {
    // 少了 MemoryRouter 這一層，render 會直接拋錯，
    // 而且錯誤訊息是「Cannot destructure property 'basename'...」，完全看不出是測試設定的問題。
    render(
      <MemoryRouter>
        <CourseCard course={course} />
      </MemoryRouter>
    );

    const link = screen.getByRole("link", { name: "React Router 巢狀路由" });
    expect(link).toHaveAttribute("href", "/courses/7");
  });
});
```

**為什麼是 `MemoryRouter` 而不是 `BrowserRouter`？**

`BrowserRouter` 依賴瀏覽器的 history API 去改真實網址，jsdom 裡沒有真的可導覽的網址。
`MemoryRouter` 把「目前在哪一頁」存在記憶體裡：不碰真實網址、可以用 `initialEntries` 指定起點，
而且每次 render 都是全新的，測試之間不會殘留上一次導頁的結果。

跑這類測試時，終端機的 stderr 可能會印出 `⚠️ React Router Future Flag Warning: ...`。
那是 React Router v6 後期版本提醒「升級到 v7 時某些行為會改變」，不是測試失敗；只要最後顯示 passed 就可以先不理它。
想消掉它，就在 `MemoryRouter` 加上和第 8 章 `BrowserRouter` 相同的 `future` 設定；admin-demo 的 `renderWithProviders` 就是這樣做的。

### 5.2 用到 `useParams`：還要加上 Routes / Route

只包 `MemoryRouter` **不夠**。動態參數是「網址比對到路由樣板」之後才產生的，
沒有 `<Route path="...">` 就沒有樣板可比對，`useParams()` 會回傳空物件。

被測元件：

```jsx
// src/pages/CourseDetail.jsx
import { useParams } from "react-router-dom";

const COURSE_TITLES = {
  7: "React Router 巢狀路由",
  8: "TanStack Query 資料層架構",
};

function CourseDetail() {
  const { courseId } = useParams();
  return <h1>{COURSE_TITLES[courseId] ?? "找不到課程"}</h1>;
}

export default CourseDetail;
```

測試：

```jsx
// src/pages/CourseDetail.test.jsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import CourseDetail from "./CourseDetail";

describe("CourseDetail", () => {
  it("依網址上的 id 顯示對應課程", () => {
    render(
      // initialEntries：假裝使用者現在站在這個網址
      <MemoryRouter initialEntries={["/courses/7"]}>
        {/* Routes + Route：宣告路由樣板，:courseId 才會被解析成 "7" */}
        <Routes>
          <Route path="/courses/:courseId" element={<CourseDetail />} />
        </Routes>
      </MemoryRouter>
    );

    expect(
      screen.getByRole("heading", { name: "React Router 巢狀路由" })
    ).toBeInTheDocument();
  });
});
```

> 這裡有個難查的坑：忘了包 `Routes`，`courseId` 會是 `undefined`。
> 元件不會拋錯，只會顯示「找不到課程」——如果後面接的是 `useQuery` 且設了
> `enabled: Boolean(id)`，查詢根本不會發出：用 `isPending` 判斷載入的畫面會永遠卡在載入中，
> 用 `isLoading` 判斷的（v5 裡查詢沒在跑時 `isLoading` 是 `false`）則會往下讀到 `undefined` 的 `data` 而報錯。
> 兩種情況的錯誤訊息都完全不會提到路由。

### 5.3 用到 `useQuery` / `useMutation`：包 QueryClientProvider

被測元件與它呼叫的 API 模組：

```js
// src/services/courseApi.js
export async function fetchCourses() {
  const res = await fetch("/api/courses");
  if (!res.ok) throw new Error("課程載入失敗");
  return res.json();
}
```

```jsx
// src/pages/CourseList.jsx
import { useQuery } from "@tanstack/react-query";
import { fetchCourses } from "../services/courseApi";

function CourseList() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["courses"],
    queryFn: fetchCourses,
  });

  if (isLoading) return <p>載入中…</p>;
  if (isError) return <p role="alert">{error.message}</p>;

  return (
    <ul>
      {data.map((course) => (
        <li key={course.id}>{course.title}</li>
      ))}
    </ul>
  );
}

export default CourseList;
```

測試：

```jsx
// src/pages/CourseList.test.jsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { fetchCourses } from "../services/courseApi";
import CourseList from "./CourseList";

// 攔截 API 模組，而不是攔截 fetch。
// 測試要驗的是「元件在資料成功 / 失敗時的反應」，
// 從最靠近元件的那一層換掉最省事，也不會綁死底層用 fetch 還是 axios。
vi.mock("../services/courseApi", () => ({
  fetchCourses: vi.fn(),
}));

// 每個測試都給一個全新的 QueryClient。共用一個的話，
// 前一個測試抓到的資料會留在快取裡，下一個測試直接讀到舊資料、
// queryFn 根本不會被呼叫——測試就失去意義了。
function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false, // 關鍵，理由見下方說明
        gcTime: 0,
      },
    },
  });
}

function renderWithQuery(ui) {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      {ui}
    </QueryClientProvider>
  );
}

describe("CourseList", () => {
  beforeEach(() => {
    vi.resetAllMocks(); // 清掉上一個測試的呼叫紀錄與回傳設定
  });

  it("載入完成後列出課程", async () => {
    fetchCourses.mockResolvedValue([
      { id: 7, title: "React Router 巢狀路由" },
      { id: 8, title: "TanStack Query 資料層架構" },
    ]);

    renderWithQuery(<CourseList />);

    // findBy* = getBy* + waitFor。第一次 render 時資料還沒回來，
    // 用 getBy* 會當場失敗——這是元件測試最常見的第一個坑。
    expect(
      await screen.findByText("React Router 巢狀路由")
    ).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("抓不到資料時顯示錯誤訊息", async () => {
    fetchCourses.mockRejectedValue(new Error("課程載入失敗"));

    renderWithQuery(<CourseList />);

    expect(await screen.findByRole("alert")).toHaveTextContent("課程載入失敗");
  });
});
```

`vi.mock` 雖然寫在 import 下面，Vitest 會把它提升到檔案最上方先執行。所以 `import { fetchCourses }` 拿到的已經是 `vi.fn()` 做出來的假函式，
測試裡才能用 `mockResolvedValue`（回傳成功的 Promise）、`mockRejectedValue`（回傳失敗的 Promise）指定這一次 API 的結果。

**`retry: false` 是測試設定裡最重要的一行。**
正式環境設 `retry: 1`（甚至預設的 3）很合理——網路偶爾抖一下就自動重來。
但在測試裡，重試會讓 `queryFn` 多跑好幾次、而且每次之間有遞增的等待時間，
錯誤畫面往往拖到好幾秒後才出現，`findBy` / `waitFor` 早就逾時了。
「測錯誤狀態時測試莫名很慢又會失敗」，幾乎都是這個原因。

### 5.4 兩個都要：抽一支 `renderWithProviders`

實務上的頁面通常同時吃到路由和 Query，每個測試檔都手寫一次包裝很囉唆。
把它抽成共用工具，之後每支測試只寫一行：

```jsx
// src/test/renderWithProviders.jsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

export function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

/**
 * @param ui              要測的元件，例如 <CourseListPage />
 * @param options.route   初始網址，預設 "/"
 * @param options.path    路由樣板（如 "/courses/:courseId"）。
 *                        有填才會用 Routes 包住，useParams 才拿得到參數
 */
export function renderWithProviders(
  ui,
  { route = "/", path, queryClient = createTestQueryClient(), ...options } = {}
) {
  function Wrapper({ children }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[route]}>
          {path ? (
            <Routes>
              <Route path={path} element={children} />
            </Routes>
          ) : (
            children
          )}
        </MemoryRouter>
      </QueryClientProvider>
    );
  }

  return {
    // 一併回傳 user，測試裡就不用每次自己 setup()。
    // 注意 userEvent.setup() 必須在 render 之前呼叫，這裡的順序是對的。
    user: userEvent.setup(),
    queryClient,
    ...render(ui, { wrapper: Wrapper, ...options }),
  };
}
```

用起來就變成這樣：

```jsx
// 一般頁面
const { user } = renderWithProviders(<CourseListPage />);

// 動態路由頁面
renderWithProviders(<CourseDetailPage />, {
  route: "/courses/3", // 假裝現在在這個網址
  path: "/courses/:courseId", // 樣板，:courseId 因此是 "3"
});
```

### 5.5 Zustand 不用 Provider，但一定要重設

Zustand 的狀態活在元件之外，所以測試裡可以直接讀寫，不需要任何 Provider：

```js
useAuthStore.getState().token; // 讀
useAuthStore.setState({ token: "fake-token" }); // 鋪陳前置狀態
```

方便歸方便，代價是**它會跨測試殘留**。同一個測試檔裡的所有 `it` 共用一個 Node process，
模組只會被載入一次——前一個測試登入後，下一個測試一開始就是登入狀態。
這種 bug 的症狀很典型：**單獨跑會過，整檔一起跑就掛，順序一換結果又變。**

解法是在共用的 setup 檔裡統一還原：

```js
// src/test/setup.js（對應 vite.config.js 的 test.setupFiles）
import { afterEach, beforeEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom";

import { useAuthStore } from "@/stores/auth.store";
import { useUiStore } from "@/stores/ui.store";

// 在任何測試動過 store 之前，先記下初始狀態。
// getState() 拿到的物件同時含 state 與 actions，整包存起來再整包還原最省事。
const initialStoreStates = [
  [useAuthStore, useAuthStore.getState()],
  [useUiStore, useUiStore.getState()],
];

beforeEach(() => {
  // persist 中介層會把狀態寫進 localStorage，不清會被還原回來
  localStorage.clear();
  // 第二個參數 true = 整包取代而非合併，上一個測試新增的欄位也會一併消失
  initialStoreStates.forEach(([store, state]) => store.setState(state, true));
});

afterEach(() => {
  cleanup(); // 卸載上一個測試 render 出來的 DOM
});
```

這份 setup 的 store 名稱與路徑照 admin-demo：store 放在 `src/stores/*.store.js`，用 `@` 別名匯入（設定在 admin-demo 的 `vite.config.js` 的 `resolve.alias`）。
你的專案請換成實際有的 store 與路徑，例如沿用第 11 章的寫法就是 `import { useUiStore } from "../store/useUiStore";`。
沒有用 `persist` 的 store 也要列進來——它們一樣會跨測試殘留，只是不會寫進 localStorage。

### 5.6 這一節的錯誤訊息對照表

| 症狀 | 原因 | 解法 |
|---|---|---|
| `No QueryClient set` | 沒包 `QueryClientProvider` | 用 `renderWithProviders` |
| `useNavigate() may be used only in the context of a <Router>` 或 `Cannot destructure property 'basename'` | 沒包 Router | 同上 |
| `useParams()` 回傳空物件 | 只包了 `MemoryRouter`，沒有 `Routes` / `Route` | 傳 `path` 選項 |
| 元素明明會出現卻 `Unable to find` | 用了 `getBy*` 沒等非同步 | 改用 `findBy*` 或 `waitFor` |
| 錯誤狀態的測試很慢又逾時 | `retry` 沒關 | 測試用的 QueryClient 設 `retry: false` |
| 單獨跑會過、整檔跑就掛 | Zustand / localStorage 殘留 | 在 `setup.js` 統一重設 |
| 測試互相看到對方的資料 | 共用同一個 `QueryClient` | 每次 render 都建新的 |

> 想看這一整套用在真實專案的樣子，直接讀 [admin-demo/](./admin-demo/) 的
> `src/test/` 與各個 `*.test.jsx`——那是本節所有觀念的完整實作。

---

## 6. 打包與環境變數

### 打包與本機預覽

```bash
npm run build      # 產出 dist/（壓縮後的靜態檔案）
npm run preview    # 用本機伺服器預覽 dist/，模擬正式環境
```

部署前務必用 `preview` 走一遍主要流程——開發模式（dev）與打包結果偶爾行為不同。

### 環境變數

Vite 只會把 **`VITE_` 開頭**的變數暴露給前端程式：

```bash
# .env.development
VITE_API_URL=http://localhost:3000

# .env.production
VITE_API_URL=https://api.example.com
```

程式中透過 `import.meta.env` 讀取：

```js
const baseURL = import.meta.env.VITE_API_URL;
```

- `npm run dev` 使用 `.env.development`，`npm run build` 使用 `.env.production`；沒有分環境的共用值可以放在 `.env`。
- 讀到的值一律是字串：`VITE_USE_MOCK=true` 讀出來是 `"true"`，判斷時要寫 `import.meta.env.VITE_USE_MOCK === "true"`（admin-demo 的 `main.jsx` 就是這樣寫）。
- 沒有 `VITE_` 開頭的變數在程式裡讀到的是 `undefined`，不會報錯，很容易以為是值沒設好。

注意：前端環境變數會在 build 時直接替換進 JS，**任何人打開瀏覽器都看得到**，絕不能放密鑰。
也因為是 build 時寫死的，在託管平台上改了環境變數，要重新 build（重新部署）才會生效。

---

## 7. 部署 SPA 的一個關鍵：路由 fallback

React Router 的路徑（如 `/courses/react-basic`）只存在於前端。  
使用者直接重新整理這個網址時，伺服器上並沒有這個檔案，會回 404。

解法是讓伺服器把所有路徑都導回 `index.html`（稱為 history fallback）：

| 平台 | 設定方式 |
|------|----------|
| Vercel | 會自動偵測 Vite 並執行 build，但深層路由**不會**自動 fallback；在專案根目錄加 `vercel.json`，內容：`{ "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }] }` |
| Netlify | 在 `public/` 加 `_redirects` 檔，內容：`/*  /index.html  200` |
| GitHub Pages | 不支援 rewrite，需設定 Vite 的 `base`（React Router 也要設相同的 `basename`），並用 404.html 技巧（或改用 HashRouter） |
| Nginx | `try_files $uri $uri/ /index.html;` |

`public/` 裡的檔案會原封不動複製到 `dist/` 根目錄，所以 Netlify 的 `_redirects` 放在 `public/`；`vercel.json` 則是給 Vercel 讀的專案設定，放在專案根目錄（和 `package.json` 同一層）。

admin-demo 兩份都有放。它沒有真後端，所以另外附了 `.env.production`，讓正式 build 也啟用前端 mock；少了這個檔，`VITE_USE_MOCK` 在 build 時是 `undefined`，部署上去所有 API 請求都會失敗。

部署流程以 Vercel 為例：推上 GitHub → 在 Vercel 匯入 repo → 它自動執行 `npm run build` 並發布 `dist/`，之後每次 push 自動重新部署。
部署完成後，直接在網址列輸入一個深層路由（例如 `/courses/1`）再重新整理，確認不是 404，才算 fallback 設定成功。

---

## 8. 期末專題：課程管理後台

把 14 章的能力收斂成一個完整專案。題目：**線上課程管理後台**。

### 必做需求

| # | 需求 | 對應章節 |
|---|------|----------|
| 1 | 登入頁：受控表單 + 同步驗證，登入態存 Zustand | 06、11 |
| 2 | 多頁路由：Layout、巢狀路由、動態參數、404、路由守衛 | 08 |
| 3 | 課程列表：`useQuery` 抓資料，loading / error / empty 三態 | 09 |
| 4 | 課程新增與刪除：`useMutation` + 樂觀更新 + 失敗回滾 | 10 |
| 5 | 篩選與搜尋：條件放 Zustand，接進 `queryKey` 自動重抓 | 11、12 |
| 6 | 效能：大型列表用 `memo` / `useMemo`，頁面用 `React.lazy` 拆包 | 13 |
| 7 | 測試：至少 1 個純函式測試 + 2 個元件互動測試 | 14 |
| 8 | 部署：發布到 Vercel 或 Netlify，重新整理深層路由不 404 | 14 |

### 加分項

- `useInfiniteQuery` 無限捲動列表
- 亮 / 暗主題切換並以 `persist` 保存
- Error Boundary 包住主要內容區

### 驗收清單

- [ ] 重新整理任一頁面，登入態與偏好設定不丟失
- [ ] 關閉網路後操作，畫面有明確錯誤回饋而非白屏
- [ ] 樂觀更新失敗時，列表會回滾到操作前狀態
- [ ] `npm run test` 全數通過、`npm run build` 無錯誤

### 參考實作

卡關時可對照課程附帶的 [admin-demo/](./admin-demo/)——它實作了這份規格的必做需求與加分項（外加使用者管理與效能實驗室）。建議先自己做，再回頭比對架構差異。
幾個比較不好找的位置：第 6 項的 `React.lazy` 在 `src/App.jsx`；加分項的 Error Boundary 在 `src/components/ui/ErrorBoundary.jsx`，由 `src/layouts/AdminLayout.jsx` 包住內容區（效能實驗室頁尾可以故意觸發錯誤來觀察）；第 8 項的部署設定是根目錄的 `vercel.json`、`public/_redirects` 與 `.env.production`。

測試的部分（第 7 項需求）在 demo 裡也備齊了，`cd admin-demo && npm install && npm run test` 就能跑：

| 檔案 | 示範什麼 |
|---|---|
| `src/test/setup.js` | 共用設定：jest-dom 斷言、每個測試前重設 Zustand 與 localStorage |
| `src/test/renderWithProviders.jsx` | Query + Router 的共用包裝（§5.4） |
| `src/utils/format.test.js` | 純函式測試與邊界情況（§3） |
| `src/stores/courseFilter.store.test.js` | Zustand store 測試，不需要 render 任何元件 |
| `src/pages/LoginPage.test.jsx` | 表單驗證、mutation 成功 / 失敗、登入態寫入 store |
| `src/pages/courses/CourseListPage.test.jsx` | 篩選條件 → `queryKey` → API 參數，以及樂觀更新的刪除與上下架 |
| `src/pages/courses/CourseDetailPage.test.jsx` | 動態路由參數（`route` + `path` 選項）與載入 / 錯誤狀態 |

---

## 9. 本章小練習

1. 幫第 5 章的任務追蹤器補上「新增任務」與「切換完成」兩個元件測試。
2. 把第 6 章的 `validateForm` 抽成獨立模組並寫齊錯誤分支測試。
3. 在自己的專案建立 `src/test/renderWithProviders.jsx` 與 `src/test/setup.js`，
   為第 9 章的課程列表頁寫「成功 / 空資料 / 錯誤」三個測試。
4. 為第 8 章的動態路由頁寫一個測試，刻意先不傳 `path` 選項，
   親眼確認 `useParams()` 會是空的，再加回去。
5. 用 `npm run build && npm run preview` 驗證打包結果可正常操作。
6. 把任一章的最終範例部署到 Vercel，確認深層路由重新整理不會 404。

---

## 最後範例：為學習任務追蹤器補上測試

以第 5 章的最終範例（學習任務追蹤器）為測試對象，元件程式不需修改。

### `src/App.test.jsx`

```jsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";

describe("學習任務追蹤器", () => {
  it("預設渲染三筆任務", () => {
    render(<App />);
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("輸入文字並送出後，清單新增一筆任務", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.type(
      screen.getByPlaceholderText(/新增任務/),
      "完成第 14 章測試練習"
    );
    await user.click(screen.getByRole("button", { name: "新增" }));

    expect(screen.getByText("完成第 14 章測試練習")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
  });

  it("空白輸入送出時，不會新增任務", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "新增" }));

    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("勾選任務會切換完成狀態", async () => {
    const user = userEvent.setup();
    render(<App />);

    const checkbox = screen.getByLabelText("手打 JSX 範例一遍");
    await user.click(checkbox);

    expect(checkbox).toBeChecked();
  });

  it("刪除任務後，清單少一筆", async () => {
    const user = userEvent.setup();
    render(<App />);

    const deleteButtons = screen.getAllByRole("button", { name: "刪除" });
    await user.click(deleteButtons[0]);

    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByText("完成 React 第 1 章")).not.toBeInTheDocument();
  });
});
```

### 執行結果

```bash
npm run test:run -- --reporter=verbose

 ✓ src/App.test.jsx > 學習任務追蹤器 > 預設渲染三筆任務
 ✓ src/App.test.jsx > 學習任務追蹤器 > 輸入文字並送出後，清單新增一筆任務
 ✓ src/App.test.jsx > 學習任務追蹤器 > 空白輸入送出時，不會新增任務
 ✓ src/App.test.jsx > 學習任務追蹤器 > 勾選任務會切換完成狀態
 ✓ src/App.test.jsx > 學習任務追蹤器 > 刪除任務後，清單少一筆

 Test Files  1 passed (1)
      Tests  5 passed (5)
```

`--reporter=verbose` 會逐條列出測試名稱；不加的話預設只印一行 `✓ src/App.test.jsx (5 tests)` 加上統計。
實際輸出還會多出開始時間與耗時，格式也會隨 Vitest 版本略有不同，重點是最後的 passed 數量。

### 範例解釋

1. 所有查詢都走使用者視角（`getByRole`、`getByLabelText`、`getByText`），元件內部重構不會弄壞測試。
2. `userEvent` 的操作都要 `await`，它會模擬完整的事件序列（focus、keydown、input…）。
3. 「空白輸入不新增」測的是邊界行為——這類測試最能在日後改壞邏輯時救你。
4. `queryByText` 用於斷言「元素不存在」；`getByText` 找不到會直接拋錯，不適合這個場景。

---

## 本章結語

到這裡，整套課程正式完成。你已經走過：元件與資料流（01～05）、表單與副作用（06～07）、路由（08）、伺服器狀態與本地狀態分工（09～12）、效能與除錯（13），以及測試與部署（14）。

最後一步是把期末專題做完、部署上線，再與 [admin-demo/](./admin-demo/) 比對架構差異——能獨立完成這個專題，你就具備了開發可維護 React 應用的完整能力。
