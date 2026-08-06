// 前端唯一的資料出入口。介面刻意做成 axios 那個樣子：
//
//   await api.get("/users", { page: 2, keyword: "陳" })
//   await api.patch(`/users/${id}`, { status: "disabled" })
//
// 底下走的是 IPC 而不是 HTTP，但頁面元件不需要知道這件事。將來真的要接後端，
// 只有這個檔案裡的 transport() 要改成 fetch，其他地方一行都不用動。

const NOT_IN_ELECTRON =
  "window.adminApi 不存在。這個頁面要在 Electron 裡開（npm run dev），直接用瀏覽器開是拿不到 preload 的。";

/** 所有非 2xx 的回應都會變成這個錯誤丟出來 */
export class ApiError extends Error {
  constructor({ status, code, message }) {
    super(message || code || "請求失敗");
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }

  /** status 0 ＝ 連不到伺服器（模擬斷線）。真的 fetch 也是連不上時沒有 status 可拿 */
  get isNetworkError() {
    return this.status === 0;
  }

  get isUnauthorized() {
    return this.status === 401;
  }

  get isForbidden() {
    return this.status === 403;
  }
}

// ---------------------------------------------------------------------------
// 模組層的狀態：token 與 401 的處理策略
// ---------------------------------------------------------------------------

let authToken = "";
let unauthorizedHandler = null;

/**
 * token 存在模組變數，不放 localStorage。
 *
 * 這是刻意的取捨：後台的登入憑證放進 localStorage 之後，只要頁面上有任何一處 XSS
 * 就能把它讀走，而且重開 App 還會自動登入（對後台反而不是好事）。代價是重新載入
 * 頁面（開發時存檔觸發 HMR reload）會回到登入頁。
 */
export function setAuthToken(token) {
  authToken = token ?? "";
}

/** 註冊「token 失效時要做什麼」。由 AuthProvider 掛上去，統一導回登入頁 */
export function setUnauthorizedHandler(handler) {
  unauthorizedHandler = handler;
}

// ---------------------------------------------------------------------------
// 傳輸層
// ---------------------------------------------------------------------------

async function transport(payload) {
  if (!window.adminApi) throw new ApiError({ status: 0, code: "NO_BRIDGE", message: NOT_IN_ELECTRON });
  return window.adminApi.request(payload);
}

async function request(method, path, { params, body } = {}) {
  const response = await transport({ method, path, params, body, token: authToken });

  if (response.ok) return response.data;

  const error = new ApiError(response);

  // 401 集中在這裡處理，頁面元件不必每支 API 都寫一次「如果是登入逾期就…」。
  // 登入本身的 401（帳密錯誤）要排除，否則打錯密碼會觸發「登入已逾期」的流程。
  if (error.isUnauthorized && path !== "/auth/login") {
    unauthorizedHandler?.(error);
  }

  throw error;
}

export const api = {
  get: (path, params) => request("GET", path, { params }),
  post: (path, body) => request("POST", path, { body }),
  put: (path, body) => request("PUT", path, { body }),
  patch: (path, body) => request("PATCH", path, { body }),
  del: (path) => request("DELETE", path)
};
