// 模擬後端：把一組「路由表」放在 main process，行為刻意做得像真的 HTTP API。
//
// 為什麼要這麼像？因為這樣 renderer 那邊寫出來的程式碼，將來接真後端幾乎不用改：
// 一樣有 method / path / query / body、一樣回 200 / 401 / 403 / 404 / 422 / 500、
// 一樣會有延遲與偶發失敗。差別只在最外層的傳輸從 fetch 換成 IPC（見 api.ipc.js）。
//
// 注意這裡「不 throw 給 renderer」——錯誤穿過 IPC 會被 Electron 包成
// "Error invoking remote method '…': Error: XXX"，訊息會變髒、自訂欄位也會掉。
// 所以一律回傳 { ok, status, … } 這種信封，由 renderer 決定要不要 throw。

const crypto = require("node:crypto");
const { db } = require("./db");

// ---------------------------------------------------------------------------
// 可以在「系統設定」頁即時調整的模擬參數
// ---------------------------------------------------------------------------

const mockConfig = {
  minLatencyMs: 180,
  maxLatencyMs: 520,
  failureRate: 0, // 0 ~ 1：每次請求隨機噴 500 的機率
  offline: false, // true＝模擬完全連不到伺服器
  sessionTtlMinutes: 30
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomBetween = (min, max) => min + Math.random() * (max - min);

// ---------------------------------------------------------------------------
// Session（等同真後端的 access token）
// ---------------------------------------------------------------------------

const sessions = new Map(); // token -> { userId, issuedAt, expiresAt }
const loginFailures = new Map(); // account -> { count, lockedUntil }

const LOCK_THRESHOLD = 5;
const LOCK_SECONDS = 20;

function issueSession(userId) {
  const token = crypto.randomBytes(24).toString("hex");
  const now = Date.now();
  sessions.set(token, {
    userId,
    issuedAt: now,
    expiresAt: now + mockConfig.sessionTtlMinutes * 60 * 1000
  });
  return token;
}

function resolveSession(token) {
  if (!token) return { error: { status: 401, code: "NO_TOKEN" } };

  const session = sessions.get(token);
  if (!session) return { error: { status: 401, code: "INVALID_TOKEN" } };

  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return { error: { status: 401, code: "TOKEN_EXPIRED" } };
  }

  const account = db.accounts.find((item) => item.id === session.userId);
  if (!account) return { error: { status: 401, code: "INVALID_TOKEN" } };

  return { session, account };
}

// 回給 renderer 的使用者資料：不含 password
function publicProfile(account) {
  const { password, ...rest } = account;
  return rest;
}

// ---------------------------------------------------------------------------
// 查詢輔助
// ---------------------------------------------------------------------------

function paginate(items, params) {
  const page = Math.max(1, Number(params.page) || 1);
  const pageSize = Math.min(100, Math.max(5, Number(params.pageSize) || 10));
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  // 刪到最後一頁只剩 0 筆時要退回上一頁，不然畫面會空白
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * pageSize;

  return {
    items: items.slice(start, start + pageSize),
    pagination: { page: safePage, pageSize, total, totalPages }
  };
}

function matchKeyword(keyword, ...fields) {
  if (!keyword) return true;
  const needle = String(keyword).trim().toLowerCase();
  if (!needle) return true;
  return fields.some((field) => String(field ?? "").toLowerCase().includes(needle));
}

// ---------------------------------------------------------------------------
// 路由表
// ---------------------------------------------------------------------------

// auth: false ＝ 不需要 token；roles ＝ 只有這些角色能呼叫（沒寫就是全部）
const routes = [
  {
    method: "POST",
    path: "/auth/login",
    auth: false,
    handler({ body }) {
      const account = String(body?.account ?? "").trim();
      const password = String(body?.password ?? "");

      if (!account || !password) {
        return { status: 422, code: "MISSING_CREDENTIALS" };
      }

      const failure = loginFailures.get(account);
      if (failure?.lockedUntil > Date.now()) {
        return {
          status: 429,
          code: "TOO_MANY_ATTEMPTS",
          data: { retryAfterSeconds: Math.ceil((failure.lockedUntil - Date.now()) / 1000) }
        };
      }

      const matched = db.accounts.find(
        (item) => item.account === account && item.password === password
      );

      if (!matched) {
        const count = (failure?.count ?? 0) + 1;
        loginFailures.set(account, {
          count,
          lockedUntil: count >= LOCK_THRESHOLD ? Date.now() + LOCK_SECONDS * 1000 : 0
        });
        return {
          status: 401,
          code: "BAD_CREDENTIALS",
          data: { remainingAttempts: Math.max(0, LOCK_THRESHOLD - count) }
        };
      }

      loginFailures.delete(account);

      const listed = db.users.find((user) => user.id === matched.id);
      if (listed) listed.lastLoginAt = new Date().toISOString();

      return {
        status: 200,
        data: {
          token: issueSession(matched.id),
          expiresInMinutes: mockConfig.sessionTtlMinutes,
          user: publicProfile(matched)
        }
      };
    }
  },

  {
    method: "POST",
    path: "/auth/logout",
    handler({ token }) {
      sessions.delete(token);
      return { status: 200, data: { loggedOut: true } };
    }
  },

  {
    method: "GET",
    path: "/auth/me",
    handler({ account, session }) {
      return {
        status: 200,
        data: {
          user: publicProfile(account),
          session: {
            issuedAt: new Date(session.issuedAt).toISOString(),
            expiresAt: new Date(session.expiresAt).toISOString()
          }
        }
      };
    }
  },

  {
    method: "GET",
    path: "/announcements",
    handler() {
      return { status: 200, data: { items: db.announcements } };
    }
  },

  {
    method: "GET",
    path: "/dashboard/summary",
    handler() {
      const series = db.revenueSeries;
      const today = series.at(-1);
      const yesterday = series.at(-2);
      const revenueDelta = ((today.revenue - yesterday.revenue) / yesterday.revenue) * 100;

      const activeUsers = db.users.filter((user) => user.status === "active").length;
      const pendingOrders = db.orders.filter((order) =>
        ["pending", "processing"].includes(order.status)
      ).length;
      const monthRevenue = series.reduce((sum, item) => sum + item.revenue, 0);

      const statusCounts = db.orders.reduce((acc, order) => {
        acc[order.status] = (acc[order.status] ?? 0) + 1;
        return acc;
      }, {});

      return {
        status: 200,
        data: {
          kpis: [
            {
              key: "revenue",
              label: "今日營收",
              value: today.revenue,
              format: "currency",
              delta: Number(revenueDelta.toFixed(1)),
              hint: `較昨日 ${yesterday.revenue.toLocaleString("zh-TW")} 元`
            },
            {
              key: "orders",
              label: "今日訂單",
              value: today.orders,
              format: "number",
              delta: Number((((today.orders - yesterday.orders) / yesterday.orders) * 100).toFixed(1)),
              hint: `待處理 ${pendingOrders} 筆`
            },
            {
              key: "users",
              label: "啟用中帳號",
              value: activeUsers,
              format: "number",
              delta: 2.4,
              hint: `總計 ${db.users.length} 個帳號`
            },
            {
              key: "month",
              label: "近 14 日營收",
              value: monthRevenue,
              format: "currency",
              delta: 8.1,
              hint: "含所有通路"
            }
          ],
          revenueSeries: series,
          orderStatus: Object.entries(statusCounts)
            .map(([status, count]) => ({ status, count }))
            .sort((a, b) => b.count - a.count),
          activities: db.activities
        }
      };
    }
  },

  {
    method: "GET",
    path: "/users",
    handler({ params }) {
      let items = db.users.filter(
        (user) =>
          matchKeyword(params.keyword, user.name, user.account, user.email, user.department) &&
          (!params.role || user.role === params.role) &&
          (!params.status || user.status === params.status)
      );

      // 排序欄位一定要白名單，不能直接拿 params.sort 去索引物件
      const sortable = { name: "name", createdAt: "createdAt", lastLoginAt: "lastLoginAt" };
      const key = sortable[params.sort] ?? "createdAt";
      const direction = params.order === "asc" ? 1 : -1;
      items = [...items].sort(
        (a, b) => String(a[key] ?? "").localeCompare(String(b[key] ?? "")) * direction
      );

      return { status: 200, data: paginate(items, params) };
    }
  },

  {
    method: "PATCH",
    path: "/users/:id",
    roles: ["admin", "editor"],
    handler({ pathParams, body }) {
      const user = db.users.find((item) => item.id === pathParams.id);
      if (!user) return { status: 404, code: "USER_NOT_FOUND" };

      const patch = {};

      if (body?.status !== undefined) {
        if (!["active", "disabled", "pending"].includes(body.status)) {
          return { status: 422, code: "INVALID_STATUS" };
        }
        patch.status = body.status;
      }

      if (body?.role !== undefined) {
        if (!["admin", "editor", "viewer"].includes(body.role)) {
          return { status: 422, code: "INVALID_ROLE" };
        }
        patch.role = body.role;
      }

      if (Object.keys(patch).length === 0) {
        return { status: 422, code: "NOTHING_TO_UPDATE" };
      }

      Object.assign(user, patch);
      return { status: 200, data: { user } };
    }
  },

  {
    method: "DELETE",
    path: "/users/:id",
    roles: ["admin"],
    handler({ pathParams, account }) {
      const index = db.users.findIndex((item) => item.id === pathParams.id);
      if (index === -1) return { status: 404, code: "USER_NOT_FOUND" };

      // 真後端也會有這種「業務規則」的錯誤，順便讓前端練習顯示 409
      if (pathParams.id === account.id) {
        return { status: 409, code: "CANNOT_DELETE_SELF" };
      }

      const [removed] = db.users.splice(index, 1);
      return { status: 200, data: { deleted: removed.id } };
    }
  },

  {
    method: "GET",
    path: "/orders",
    handler({ params }) {
      const items = db.orders.filter(
        (order) =>
          matchKeyword(params.keyword, order.id, order.customerName, order.product) &&
          (!params.status || order.status === params.status) &&
          (!params.channel || order.channel === params.channel)
      );

      const revenue = items
        .filter((order) => !["refunded", "cancelled"].includes(order.status))
        .reduce((sum, order) => sum + order.amount, 0);

      const result = paginate(items, params);
      return { status: 200, data: { ...result, summary: { revenue, count: items.length } } };
    }
  },

  {
    method: "GET",
    path: "/system/mock-config",
    handler() {
      return { status: 200, data: { ...mockConfig } };
    }
  },

  {
    method: "PUT",
    path: "/system/mock-config",
    handler({ body }) {
      const clamp = (value, min, max, fallback) => {
        const number = Number(value);
        if (!Number.isFinite(number)) return fallback;
        return Math.min(max, Math.max(min, number));
      };

      mockConfig.minLatencyMs = clamp(body?.minLatencyMs, 0, 5000, mockConfig.minLatencyMs);
      mockConfig.maxLatencyMs = clamp(body?.maxLatencyMs, 0, 5000, mockConfig.maxLatencyMs);
      mockConfig.failureRate = clamp(body?.failureRate, 0, 1, mockConfig.failureRate);
      mockConfig.offline = Boolean(body?.offline ?? mockConfig.offline);

      // max 不能小於 min，否則 randomBetween 會算出負數延遲
      if (mockConfig.maxLatencyMs < mockConfig.minLatencyMs) {
        mockConfig.maxLatencyMs = mockConfig.minLatencyMs;
      }

      return { status: 200, data: { ...mockConfig } };
    }
  },

  {
    method: "POST",
    path: "/system/expire-session",
    handler({ token }) {
      // 讓目前的 token 立刻過期，用來示範「session 逾期 → 自動踢回登入頁」
      const session = sessions.get(token);
      if (session) session.expiresAt = Date.now() - 1;
      return { status: 200, data: { expired: true } };
    }
  }
];

// ---------------------------------------------------------------------------
// 路由比對
// ---------------------------------------------------------------------------

// "/users/:id" → { regexp: /^\/users\/([^/]+)$/, keys: ["id"] }
function compile(path) {
  const keys = [];
  const pattern = path
    .split("/")
    .map((segment) => {
      if (!segment.startsWith(":")) return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      keys.push(segment.slice(1));
      return "([^/]+)";
    })
    .join("/");

  return { regexp: new RegExp(`^${pattern}$`), keys };
}

const compiledRoutes = routes.map((route) => ({ ...route, ...compile(route.path) }));

function matchRoute(method, path) {
  // 同一個路徑會有好幾個 method（/users/:id 有 PATCH 也有 DELETE），
  // 所以「路徑對上但 method 不對」不能直接放棄——要繼續往下找。
  // 只在整張表都走完、確定沒有相符的 method 時才是 405。
  let pathMatched = false;

  for (const route of compiledRoutes) {
    const matched = route.regexp.exec(path);
    if (!matched) continue;

    pathMatched = true;
    if (route.method !== method) continue;

    const pathParams = {};
    route.keys.forEach((key, index) => {
      pathParams[key] = decodeURIComponent(matched[index + 1]);
    });
    return { route, pathParams };
  }

  // 路徑存在但沒有這個 method＝405，路徑本身不存在＝404，跟真的 HTTP 伺服器一樣
  return { methodMismatch: pathMatched };
}

// ---------------------------------------------------------------------------
// 進入點
// ---------------------------------------------------------------------------

const CODE_MESSAGES = {
  MISSING_CREDENTIALS: "請輸入帳號與密碼",
  BAD_CREDENTIALS: "帳號或密碼錯誤",
  TOO_MANY_ATTEMPTS: "嘗試次數過多，請稍後再試",
  NO_TOKEN: "尚未登入",
  INVALID_TOKEN: "登入狀態無效，請重新登入",
  TOKEN_EXPIRED: "登入已逾期，請重新登入",
  FORBIDDEN: "權限不足，無法執行這個操作",
  NOT_FOUND: "找不到這個 API",
  METHOD_NOT_ALLOWED: "這個路徑不支援該 method",
  USER_NOT_FOUND: "找不到這個使用者",
  CANNOT_DELETE_SELF: "不能刪除自己的帳號",
  INVALID_STATUS: "狀態值不正確",
  INVALID_ROLE: "角色值不正確",
  NOTHING_TO_UPDATE: "沒有任何要更新的欄位",
  SERVER_BUSY: "伺服器忙碌中，請稍後再試",
  NETWORK_OFFLINE: "無法連線到伺服器"
};

function envelope({ status, code, data }) {
  const ok = status >= 200 && status < 300;
  return {
    ok,
    status,
    code: code ?? (ok ? "OK" : "ERROR"),
    message: code ? (CODE_MESSAGES[code] ?? code) : "",
    data: data ?? null
  };
}

/**
 * 模擬器自己的控制面板不參與模擬。
 *
 * 少了這一條，「模擬斷線」與「失敗率 100%」就變成單向門：連那支用來關掉它的
 * PUT /system/mock-config 都會失敗，只能重啟 App 才救得回來。登入也一起放行，
 * 否則失敗率調高之後連登入頁都過不了。
 *
 * 延遲不在這個豁免範圍內——慢一點不會把自己鎖死，而且設定頁本來就該一起變慢。
 */
function isControlPath(path) {
  return path === "/auth/login" || path.startsWith("/system/");
}

/**
 * @param {{ method?: string, path?: string, params?: object, body?: any, token?: string }} request
 */
async function handleRequest(request = {}) {
  const method = String(request.method ?? "GET").toUpperCase();
  const path = String(request.path ?? "");
  const params = request.params ?? {};
  const startedAt = Date.now();

  const exempt = isControlPath(path);

  // 1. 先模擬「網路」層：斷線與延遲都發生在伺服器邏輯之前，
  //    因為真實世界的網路問題不會等伺服器想好要回什麼
  if (mockConfig.offline && !exempt) {
    await sleep(randomBetween(200, 600));
    return { ...envelope({ status: 0, code: "NETWORK_OFFLINE" }), durationMs: Date.now() - startedAt };
  }

  await sleep(randomBetween(mockConfig.minLatencyMs, mockConfig.maxLatencyMs));

  // 2. 隨機故障
  if (mockConfig.failureRate > 0 && !exempt && Math.random() < mockConfig.failureRate) {
    return { ...envelope({ status: 500, code: "SERVER_BUSY" }), durationMs: Date.now() - startedAt };
  }

  const finish = (result) => ({ ...envelope(result), durationMs: Date.now() - startedAt });

  // 3. 找路由
  const { route, pathParams, methodMismatch } = matchRoute(method, path);
  if (!route) {
    return finish(
      methodMismatch
        ? { status: 405, code: "METHOD_NOT_ALLOWED" }
        : { status: 404, code: "NOT_FOUND" }
    );
  }

  // 4. 驗證身分與權限
  let account = null;
  let session = null;

  if (route.auth !== false) {
    const resolved = resolveSession(request.token);
    if (resolved.error) return finish(resolved.error);
    ({ account, session } = resolved);

    if (route.roles && !route.roles.includes(account.role)) {
      return finish({ status: 403, code: "FORBIDDEN" });
    }
  }

  // 5. 執行。handler 自己丟例外＝mock 有 bug，包成 500 回去而不是讓 IPC 爆掉
  try {
    return finish(await route.handler({ params, body: request.body, pathParams, account, session, token: request.token }));
  } catch (error) {
    console.error(`[mock] ${method} ${path} 發生未預期錯誤：`, error);
    return finish({ status: 500, code: "SERVER_BUSY" });
  }
}

module.exports = { handleRequest };
