// 整個 App 只開一個 IPC 通道：api:request。
//
// 這是刻意的設計。如果每支 API 都開一個通道（users:list、users:update、orders:list…），
// preload 的白名單會跟著後端一起長，加一支 API 就要改三個檔案。改成「一個通道 +
// 路由字串」之後，前端加 API 只要改 renderer，main 這邊完全不用動。
//
// 代價是通道本身變成通用入口，所以進來的東西一律當成不可信：method 要在白名單裡、
// path 只允許安全字元、query 只收純量。真正決定「這個路徑存不存在、能不能呼叫」
// 的是 server.js 的路由表，renderer 傳什麼都不會變成檔案讀寫。

const { ipcMain } = require("electron");
const { handleRequest } = require("./server");

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

// 只允許英數與 - _ . / ：擋掉 ../ 之類的東西（雖然這裡不碰檔案系統，但通用入口要養成習慣）
const PATH_PATTERN = /^\/[A-Za-z0-9\-_./]*$/;

// query 只收字串／數字／布林，避免有人塞進巨大的物件或函式
function sanitizeParams(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};

  const result = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === null || value === undefined || value === "") continue;
    if (["string", "number", "boolean"].includes(typeof value)) {
      result[key] = value;
    }
  }
  return result;
}

function registerApiIpc() {
  ipcMain.handle("api:request", async (_event, raw) => {
    const method = String(raw?.method ?? "GET").toUpperCase();
    const path = String(raw?.path ?? "");

    if (!ALLOWED_METHODS.has(method) || !PATH_PATTERN.test(path) || path.includes("..")) {
      return { ok: false, status: 400, code: "BAD_REQUEST", message: "請求格式不正確", data: null };
    }

    const response = await handleRequest({
      method,
      path,
      params: sanitizeParams(raw?.params),
      body: raw?.body ?? null,
      token: typeof raw?.token === "string" ? raw.token : ""
    });

    // 開發時把每一次呼叫印出來，行為就跟瀏覽器的 Network 分頁一樣好追
    console.log(
      `[api] ${method} ${path} → ${response.status} (${response.durationMs}ms)`
    );

    return response;
  });
}

module.exports = { registerApiIpc };
