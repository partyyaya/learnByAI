# 03.a TypeScript 選讀講解：把型別用在穩定協作

> 這份是第 03 章的延伸講解，給想把 SDK 工程品質再拉高的學員。你不學 TypeScript 也能完成主線課程，但有 TS 會更容易在多人協作中維持品質。

## 1. 這堂選讀的目標

- 知道 TypeScript 在 gRPC 專案中的實際價值。
- 會為 client 呼叫建立清楚的輸入輸出型別。
- 會用 `DomainError` 做錯誤語意統一。
- 會用泛型封裝通用呼叫器，避免重複程式碼。

## 2. 老師講解主軸

這段上課我會直接講一句話：**TypeScript 的重點不是語法炫技，而是降低協作成本**。

在 gRPC 專案裡，最常見的痛點不是「呼叫不到 API」，而是：

- 不確定輸入資料到底要什麼欄位
- 各頁面錯誤處理標準不一致
- 需求一改動就連鎖壞掉

TypeScript 就是用來把這些不確定性提前消掉。

## 3. 第一段：先把 client 輸入輸出說清楚

先從 `createXxxClient` 與 use case 的 I/O 型別開始，不需要一次就進到很複雜。

```ts
type CreateTodoInput = {
  title: string;
  assignee?: string;
};

type CreateTodoOutput = {
  id: string;
  title: string;
  done: boolean;
};
```

課堂提示：

- 輸入輸出型別清楚，IDE 才能在開發當下提醒錯誤。
- 型別是「團隊共識文件」，不是只給編譯器看。

## 4. 第二段：統一錯誤語意（DomainError）

不要把底層錯誤直接丟給 UI。先轉成業務能理解的錯誤模型，畫面層才好維護。

```ts
type DomainErrorCode =
  | "UNAUTHENTICATED"
  | "PERMISSION_DENIED"
  | "NOT_FOUND"
  | "UNAVAILABLE"
  | "UNKNOWN";

type DomainError = {
  code: DomainErrorCode;
  message: string;
  requestId?: string;
};
```

課堂提示：

- 畫面層只看 `DomainError`，不直接依賴 gRPC runtime 細節。
- 這樣未來改傳輸層時，UI 改動會小很多。

## 5. 第三段：用泛型封裝通用呼叫流程

當你發現每個 API 都在重複 timeout、retry、error mapping，就是該抽象的時候。

```ts
async function callRpc<TInput, TOutput>(
  fn: (input: TInput) => Promise<TOutput>,
  input: TInput
): Promise<TOutput> {
  try {
    return await fn(input);
  } catch (err) {
    throw toDomainError(err);
  }
}
```

課堂提示：

- 泛型不是目的，目的是「共通規則只寫一次」。
- 先從 1 個通用呼叫器開始，後續再補 timeout/retry 選項。

## 6. 給學員的收斂句

先用 TypeScript 做兩件事就夠了：

1. 固定 API 輸入輸出契約
2. 固定錯誤語意

把這兩件做好，團隊的開發穩定性通常就能明顯提升。

## 7. 練習完成版（可直接給學員）

以下把三題一次做完，學員可以先照抄跑通，再理解每段目的。

### 7.1 完整 `toDomainError()`

```ts
import { Code, ConnectError } from "@connectrpc/connect";

export type DomainErrorCode =
  | "UNAUTHENTICATED"
  | "PERMISSION_DENIED"
  | "NOT_FOUND"
  | "UNAVAILABLE"
  | "UNKNOWN";

export type DomainError = {
  code: DomainErrorCode;
  message: string;
  requestId?: string;
};

function mapGrpcCode(code: Code): DomainErrorCode {
  switch (code) {
    case Code.Unauthenticated:
      return "UNAUTHENTICATED";
    case Code.PermissionDenied:
      return "PERMISSION_DENIED";
    case Code.NotFound:
      return "NOT_FOUND";
    case Code.Unavailable:
      return "UNAVAILABLE";
    default:
      return "UNKNOWN";
  }
}

export function toDomainError(error: unknown): DomainError {
  const e = ConnectError.from(error);
  return {
    code: mapGrpcCode(e.code),
    message: e.rawMessage || e.message || "系統忙碌中，請稍後再試。",
    requestId: e.metadata.get("x-request-id") ?? undefined,
  };
}
```

### 7.2 `callRpc` 支援 `timeoutMs` 與 `retry`

```ts
type CallRpcOptions = {
  timeoutMs?: number;
  retry?: number;
  retryableCodes?: DomainErrorCode[];
};

function timeoutPromise(timeoutMs: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject({
        code: "UNAVAILABLE",
        message: `請求逾時（>${timeoutMs}ms）`,
      } satisfies DomainError);
    }, timeoutMs);
  });
}

export async function callRpc<TInput, TOutput>(
  fn: (input: TInput) => Promise<TOutput>,
  input: TInput,
  options: CallRpcOptions = {}
): Promise<TOutput> {
  const {
    timeoutMs = 5000,
    retry = 0,
    retryableCodes = ["UNAVAILABLE", "UNKNOWN"],
  } = options;

  for (let attempt = 0; attempt <= retry; attempt += 1) {
    try {
      return await Promise.race([fn(input), timeoutPromise(timeoutMs)]);
    } catch (err) {
      const domainError =
        typeof err === "object" && err && "code" in err
          ? (err as DomainError)
          : toDomainError(err);

      const canRetry =
        attempt < retry && retryableCodes.includes(domainError.code);

      if (!canRetry) throw domainError;
    }
  }

  throw {
    code: "UNKNOWN",
    message: "未預期錯誤",
  } satisfies DomainError;
}
```

### 7.3 真實頁面改寫（把零散 try/catch 收斂）

```ts
// before: 每頁自己 try/catch
// await todoClient.createTodo({ title });
// ...

// after: 統一使用 callRpc + DomainError
async function onCreateTodo(title: string) {
  try {
    await callRpc(
      (input: { title: string }) => todoClient.createTodo(input),
      { title },
      { timeoutMs: 5000, retry: 1 }
    );
    toast.success("建立成功");
  } catch (err) {
    const e = err as DomainError;
    if (e.code === "UNAUTHENTICATED") {
      navigate("/login");
      return;
    }
    toast.error(e.message);
  }
}
```

## 8. 延伸閱讀

- [TypeScript Handbook](https://www.typescriptlang.org/docs/)
- [Connect for Web](https://connectrpc.com/docs/web/getting-started/)
