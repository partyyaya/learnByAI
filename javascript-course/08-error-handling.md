# 08 — 錯誤處理

> 只丟 `Error` 物件、只在能做點什麼的地方接、接了就要處理或重新丟出、包裝錯誤時用 `cause` 保留原因。

JavaScript 的 `try/catch` 和 Java、C# 看起來一樣，但沒有受檢例外（checked exception），函式簽章也看不出它會丟什麼。哪裡會出錯、在哪裡處理，完全靠慣例。這一章整理這些慣例，非同步的部分在 [11.5 節](11-promise-and-async-await.md#115-asyncawait語法糖不是新機制)與 [11.11 節](11-promise-and-async-await.md#1111-常見錯誤與排查)會再接上。

## 8.1 只丟 Error 物件

`throw` 可以丟出任何值，但只應該丟 `Error`（或它的子類別）：

```js
try {
  throw "壞掉了";
} catch (e) {
  typeof e; // "string"
  e.stack;  // undefined，不知道是哪裡丟出來的
}
```

`Error` 物件帶有三個主要屬性：

```js
try {
  null.x;
} catch (e) {
  e.name;    // "TypeError"
  e.message; // "Cannot read properties of null (reading 'x')"
  e.stack;   // 包含錯誤訊息與呼叫堆疊，記錄錯誤時最有用的資訊
}
```

`stack` 是排查問題的關鍵。丟字串、丟一般物件都沒有它；記錄錯誤時也要記 `stack`，不要只記 `message`。

### 內建的錯誤類型

| 類型 | 常見原因 |
|------|---------|
| `TypeError` | 對 `null`／`undefined` 讀屬性、呼叫不是函式的值、對唯讀屬性賦值 |
| `ReferenceError` | 變數不存在、在 TDZ 中存取（[3.2 節](03-scope-closures-and-hoisting.md#32-提升與-tdz)） |
| `RangeError` | 數值超出允許範圍：`new Array(-1)`、遞迴太深導致堆疊溢位 |
| `SyntaxError` | 語法錯誤；執行時最常見的是 `JSON.parse` 收到格式錯誤的字串 |
| `AggregateError` | 同時包含多個錯誤，例如 `Promise.any` 全部失敗時，`errors` 陣列裡是每一個錯誤 |

自己的程式碼丟錯時，參數型別不對用 `TypeError`，數值超出範圍用 `RangeError`，其他業務上的錯誤用自訂的錯誤類別（8.4 節）。

## 8.2 `try`／`catch`／`finally`

```js
try {
  const data = JSON.parse(text);
  render(data);
} catch (err) {
  showError("資料格式錯誤");
} finally {
  hideSpinner(); // 不管成功、失敗，或 try 裡 return，都會執行
}
```

用不到錯誤物件時，`catch` 可以不寫參數：

```js
try {
  return JSON.parse(text);
} catch {
  return null;
}
```

### `finally` 裡不要 `return`

`finally` 裡的 `return` 會**覆蓋** `try` 的回傳值，甚至**吞掉** `try` 丟出的錯誤：

```js
function g() {
  try {
    return "try";
  } finally {
    return "finally";
  }
}
g(); // "finally"

function h() {
  try {
    throw new Error("lost");
  } finally {
    return "swallowed";
  }
}
h(); // "swallowed"，錯誤消失了
```

`finally` 只放清理工作：關閉資源、重設狀態、隱藏 loading。

## 8.3 錯誤該在哪一層接

**只在能對錯誤做點什麼的地方接。** 能做的事包括：

- **重試**：網路暫時失敗（[11.10 節](11-promise-and-async-await.md#1110-重試與退避)）。
- **改用替代方案**：快取讀不到就從伺服器讀、設定檔讀不到就用預設值。
- **轉換成使用者看得懂的訊息**：在 UI 層把錯誤顯示成「儲存失敗，請稍後再試」。
- **補上脈絡後重新丟出**：見 8.5 節。

如果以上都做不到，就**不要接**，讓錯誤往上傳。最糟的寫法是接了之後什麼都不做：

```js
try {
  await saveOrder(order);
} catch (err) {
  console.log(err); // 印了一行，然後當作沒事
}
showSuccess("訂單已送出"); // 實際上失敗了
```

呼叫端以為成功，使用者看到成功訊息，資料卻沒存進去。這類錯誤最難查，因為出問題的地方和發現問題的地方離得很遠。

一般的分層方式：

- **底層**（資料存取、API 呼叫）：大多不接，或接了補上脈絡再丟出。
- **中間層**（業務邏輯）：處理能處理的（重試、替代方案），其他往上傳。
- **最外層**（事件處理器、路由處理、程式進入點）：一定要接，記錄完整的錯誤，並轉成使用者看得到的訊息或適當的 HTTP 回應。

## 8.4 自訂錯誤類別

需要讓呼叫端依錯誤種類做不同處理時，定義自己的錯誤類別：

```js
class NotFoundError extends Error {
  constructor(resource, id, options) {
    super(`${resource} ${id} not found`, options);
    this.name = "NotFoundError";
    this.resource = resource;
    this.id = id;
  }
}

class ValidationError extends Error {
  name = "ValidationError";
  constructor(fields) {
    super("validation failed");
    this.fields = fields; // 例如 { email: "格式錯誤" }
  }
}
```

呼叫端用 `instanceof` 區分：

```js
try {
  await updateOrder(id, input);
} catch (err) {
  if (err instanceof ValidationError) {
    showFieldErrors(err.fields);
  } else if (err instanceof NotFoundError) {
    showMessage("訂單不存在或已刪除");
  } else {
    throw err; // 不認得的錯誤，交給上層處理
  }
}
```

幾個細節：

- **設定 `name`**。預設的 `name` 是 `"Error"`，`String(err)` 和堆疊的第一行會顯示 `Error: ...`；設成類別名稱，記錄裡一眼就看得出種類。
- **把 `options` 傳給 `super`**，`cause` 才能運作（8.5 節）。
- **不認得的錯誤要重新丟出**。`catch` 會接到所有錯誤，包括程式本身的 bug（`TypeError`）。只處理認得的，其他 `throw err`。

錯誤會跨越邊界傳遞時，`instanceof` 可能失效：從 Worker 或 iframe 傳回來的錯誤、經過 JSON 傳輸的錯誤，都不再是原本那個類別的實例。這種情況改用 `code` 欄位（例如 `err.code === "NOT_FOUND"`）判斷，Node 的內建錯誤也是這樣做的（`err.code === "ENOENT"`）。

## 8.5 `cause`：包裝錯誤而不丟失原因

底層的錯誤訊息對上層常常沒有意義。`SyntaxError: Expected property name` 沒說是哪個檔案出錯。補上脈絡時，用 `cause` 保留原本的錯誤：

```js
async function loadConfig(path) {
  const text = await readFile(path, "utf8");
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`設定檔 ${path} 格式錯誤`, { cause: err });
  }
}
```

Node 印出這個錯誤時，會連同 `cause` 的堆疊一起印：

```text
Error: 設定檔 config.json 格式錯誤
    at loadConfig (file:///.../app.mjs:30:11)
    ... {
  [cause]: SyntaxError: Expected property name or '}' in JSON at position 1
      at JSON.parse (<anonymous>)
      at loadConfig (file:///.../app.mjs:28:10)
      ...
}
```

瀏覽器的 DevTools 也會顯示 `cause`。新的錯誤說明「在做什麼的時候出錯」，`cause` 說明「底層為什麼出錯」，兩者都保留下來。

不要只保留訊息字串（`throw new Error("設定檔錯誤：" + err.message)`），那樣原本的堆疊就不見了。

## 8.6 非同步的錯誤

`try/catch` 只接得到**同一段同步執行**期間丟出的錯誤。callback 晚一點才執行時，`try` 區塊早就結束了：

```js
try {
  setTimeout(() => {
    throw new Error("late"); // 沒有被下面的 catch 接到
  }, 0);
} catch {
  console.log("永遠不會執行");
}
```

這個錯誤會變成未捕捉的例外：瀏覽器在 Console 印出錯誤，Node 會直接結束程式。錯誤處理要寫在 callback **裡面**。

Promise 和 `async/await` 讓非同步錯誤回到熟悉的寫法：`await` 一個失敗的 Promise，錯誤就在那一行丟出，可以用外面的 `try/catch` 接住。這是 `async/await` 最大的好處之一，詳細規則見[第 11 章](11-promise-and-async-await.md)。事件監聽器裡的錯誤同樣不會傳到 `addEventListener` 那一行，要在處理函式裡面接。

### 最後一道防線

漏接的錯誤可以在全域層級攔截，用來記錄與回報：

```js
// 瀏覽器
window.addEventListener("error", (event) => report(event.error));
window.addEventListener("unhandledrejection", (event) => report(event.reason));

// Node
process.on("uncaughtException", (err) => {
  report(err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  report(reason);
  process.exit(1);
});
```

這裡只做記錄，不是用來「讓程式繼續跑」。Node 發生未捕捉的例外後，程式可能處於不一致的狀態（一半的資料寫了、連線沒關），記錄完應該結束程式，交給程序管理工具重新啟動。前端的錯誤監控服務（例如 Sentry）也是掛在這兩個事件上。

## 8.7 判斷一個值是不是錯誤

`catch` 接到的不一定是 `Error`：第三方程式碼可能丟字串，Promise 可能用任何值 reject。要讀 `message`、`stack` 之前，先確認：

```js
function toError(value) {
  return value instanceof Error ? value : new Error(String(value));
}

try {
  await thirdPartyCall();
} catch (err) {
  logger.error(toError(err));
}
```

`instanceof Error` 對來自其他 iframe 的錯誤會回傳 `false`。較新的 `Error.isError(value)` 可以跨 iframe 正確判斷，Node 24 已經支援；在瀏覽器使用前先查相容性表。

TypeScript 在 `catch (err)` 裡把 `err` 標成 `unknown`，也是因為接到的值可能是任何型別。

## 8.8 預期的失敗不一定要丟例外

例外適合「不應該發生、或發生了也無法在當下處理」的情況。有些失敗是**正常流程的一部分**，例如表單驗證、使用者取消、複製到剪貼簿被拒絕。這類情況回傳結果物件，呼叫端會比較好寫：

```js
function parseAge(input) {
  const age = Number(input);
  if (input.trim() === "" || !Number.isInteger(age)) {
    return { ok: false, error: "請輸入整數" };
  }
  if (age < 0 || age > 150) {
    return { ok: false, error: "年齡超出範圍" };
  }
  return { ok: true, value: age };
}

const result = parseAge(form.age.value);
if (!result.ok) {
  showFieldError("age", result.error);
  return;
}
save(result.value);
```

呼叫端看到回傳值的形狀，就知道要處理失敗的情況，不會忘記；使用 TypeScript 時，型別系統還能強制檢查。

判斷用哪一種的參考：

| 用例外 | 用結果物件 |
|--------|-----------|
| 呼叫端通常無法處理，只能往上傳 | 呼叫端一定要處理，而且處理方式明確 |
| 程式錯誤、環境錯誤（檔案不存在、網路斷線） | 使用者輸入不合法、業務規則不允許 |
| 很少發生 | 經常發生，是正常流程 |

兩者可以並存：[15.10 節](15-browser-native-apis.md#1510-clipboard使用者按下按鈕時複製)的 `copyText` 在內部接住例外，對外回傳結果物件，因為「複製失敗」在呼叫端只需要顯示一段訊息。

## 8.9 本章小結

- 只丟 `Error` 物件；記錄錯誤時記 `stack`。
- `finally` 只放清理，不要在裡面 `return`。
- 只在能做點什麼（重試、替代方案、轉成訊息、補脈絡）的地方接錯誤；接了不處理就重新丟出；最外層一定要接。
- 自訂錯誤類別要設定 `name`、把 `options` 傳給 `super`；用 `instanceof` 或 `code` 區分；不認得的錯誤重新丟出。
- 包裝錯誤時用 `cause` 保留原本的錯誤與堆疊。
- `try/catch` 接不到稍後才執行的 callback 裡的錯誤；`await` 讓非同步錯誤可以被接住。
- 全域的錯誤事件只用來記錄；Node 記錄完要結束程式。
- 預期中的失敗可以回傳結果物件，讓呼叫端一定要處理。

下一章：[09 — 模組](09-modules.md)。

---

[上一章：Map／Set、Symbol、迭代器與產生器](07-collections-iterators-and-generators.md) · [返回課程總覽](README.md) · [下一章：模組](09-modules.md)
