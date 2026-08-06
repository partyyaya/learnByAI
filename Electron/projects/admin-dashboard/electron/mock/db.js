// 假資料庫：所有資料都放在記憶體裡，關掉 App 就回到原始狀態。
//
// 資料是「用固定種子亂數生出來的」，不是隨機的——每次啟動看到的使用者、訂單
// 都完全一樣，改 UI 的時候才有穩定的畫面可以對照（真的想換一批資料就改 SEED）。

const SEED = 20260803;

// mulberry32：很短的偽亂數產生器。給同一個種子就永遠吐同一串數字。
function createRandom(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = createRandom(SEED);
const pick = (list) => list[Math.floor(random() * list.length)];
const between = (min, max) => min + Math.floor(random() * (max - min + 1));

const DAY = 24 * 60 * 60 * 1000;
const startedAt = Date.now(); // 資料的時間都相對於「啟動那一刻」，儀表板才會有「今天」

function daysAgo(days, hour = 9) {
  const date = new Date(startedAt - days * DAY);
  date.setHours(hour, between(0, 59), 0, 0);
  return date.toISOString();
}

// ---------------------------------------------------------------------------
// 登入帳號
// ---------------------------------------------------------------------------

// 密碼直接寫在這裡是因為這是 mock；真正的後端只會存雜湊值，而且驗證一定在伺服器端。
const ACCOUNTS = [
  {
    id: "u-001",
    account: "admin",
    password: "admin123",
    name: "gary",
    role: "admin",
    title: "系統管理員",
    email: "admin@learnbyai.dev",
    department: "資訊部"
  },
  {
    id: "u-002",
    account: "editor",
    password: "editor123",
    name: "黃小明",
    role: "editor",
    title: "內容編輯",
    email: "editor@learnbyai.dev",
    department: "行銷部"
  },
  {
    id: "u-003",
    account: "viewer",
    password: "viewer123",
    name: "葉小黃",
    role: "viewer",
    title: "唯讀訪客",
    email: "viewer@learnbyai.dev",
    department: "稽核室"
  }
];

// ---------------------------------------------------------------------------
// 使用者列表
// ---------------------------------------------------------------------------

const SURNAMES = ["陳", "林", "黃", "張", "李", "王", "吳", "劉", "蔡", "楊", "許", "鄭", "謝", "郭", "洪"];
const GIVEN_NAMES = [
  "彥廷", "宜蓁", "冠宇", "詩涵", "家豪", "佳穎", "俊傑", "雅婷", "承翰", "怡君",
  "柏睿", "宛庭", "志明", "淑芬", "威廷", "曉薇", "宗翰", "品妤", "建宏", "宜靜"
];
const DEPARTMENTS = ["資訊部", "行銷部", "業務部", "客服中心", "財務部", "稽核室"];
const ROLES = ["admin", "editor", "viewer"];
const STATUSES = ["active", "active", "active", "disabled", "pending"]; // 刻意讓 active 佔多數

function createUsers() {
  // 前三筆＝可以登入的帳號，讓「使用者管理」裡看得到自己
  const users = ACCOUNTS.map((account, index) => ({
    id: account.id,
    name: account.name,
    account: account.account,
    email: account.email,
    role: account.role,
    department: account.department,
    status: "active",
    createdAt: daysAgo(300 - index * 20),
    lastLoginAt: daysAgo(index)
  }));

  for (let i = 4; i <= 47; i += 1) {
    const name = pick(SURNAMES) + pick(GIVEN_NAMES);
    const id = `u-${String(i).padStart(3, "0")}`;
    users.push({
      id,
      name,
      account: `user${String(i).padStart(3, "0")}`,
      email: `user${String(i).padStart(3, "0")}@learnbyai.dev`,
      role: pick(ROLES),
      department: pick(DEPARTMENTS),
      status: pick(STATUSES),
      createdAt: daysAgo(between(5, 280)),
      lastLoginAt: random() > 0.15 ? daysAgo(between(0, 30)) : null
    });
  }

  return users;
}

// ---------------------------------------------------------------------------
// 訂單列表
// ---------------------------------------------------------------------------

const ORDER_STATUSES = ["paid", "paid", "processing", "shipped", "pending", "refunded", "cancelled"];
const CHANNELS = ["官網", "行動 App", "門市 POS", "電話訂購", "經銷商"];
const PRODUCTS = [
  "年度授權 - 標準版",
  "年度授權 - 企業版",
  "教育訓練場次",
  "技術支援加購包",
  "客製化開發工時",
  "資料移轉服務"
];

function createOrders(users) {
  const orders = [];

  for (let i = 1; i <= 136; i += 1) {
    const customer = pick(users);
    const createdDaysAgo = between(0, 59);
    orders.push({
      id: `SO-2026-${String(i).padStart(4, "0")}`,
      customerId: customer.id,
      customerName: customer.name,
      product: pick(PRODUCTS),
      channel: pick(CHANNELS),
      quantity: between(1, 12),
      amount: between(3, 240) * 500,
      status: pick(ORDER_STATUSES),
      createdAt: daysAgo(createdDaysAgo, between(8, 21))
    });
  }

  // 新到舊，跟畫面上的預設排序一致
  return orders.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ---------------------------------------------------------------------------
// 公告（導航欄的跑馬燈）
// ---------------------------------------------------------------------------

const ANNOUNCEMENTS = [
  { id: "a-1", level: "info", text: "系統將於 8/10 02:00–04:00 進行例行維護，期間服務可能短暫中斷。" },
  { id: "a-2", level: "success", text: "7 月營收達成率 118%，恭喜業務部連續三個月超標。" },
  { id: "a-3", level: "warning", text: "提醒：仍有 6 個帳號未完成雙因素驗證設定，請盡快處理。" },
  { id: "a-4", level: "info", text: "新版報表匯出功能已上線，支援 CSV 與 Excel 兩種格式。" },
  { id: "a-5", level: "warning", text: "本週有 3 筆退款申請待稽核室覆核，請於 8/6 前完成。" }
];

// ---------------------------------------------------------------------------
// 最近動態（儀表板）
// ---------------------------------------------------------------------------

const ACTIVITY_TEMPLATES = [
  { type: "user", text: "{name} 建立了新的使用者帳號" },
  { type: "order", text: "{name} 完成訂單 {order} 的出貨作業" },
  { type: "login", text: "{name} 從新的裝置登入系統" },
  { type: "setting", text: "{name} 調整了權限群組設定" },
  { type: "refund", text: "{name} 送出一筆退款申請待覆核" }
];

function createActivities(users, orders) {
  return Array.from({ length: 8 }, (_, index) => {
    const template = pick(ACTIVITY_TEMPLATES);
    const user = pick(users);
    return {
      id: `act-${index + 1}`,
      type: template.type,
      text: template.text.replace("{name}", user.name).replace("{order}", pick(orders).id),
      at: new Date(startedAt - between(3, 900) * 60 * 1000 * (index + 1)).toISOString()
    };
  }).sort((a, b) => b.at.localeCompare(a.at));
}

// ---------------------------------------------------------------------------
// 匯出：一份可以被 server.js 直接改的可變狀態
// ---------------------------------------------------------------------------

const users = createUsers();
const orders = createOrders(users);

const db = {
  accounts: ACCOUNTS,
  users,
  orders,
  announcements: ANNOUNCEMENTS,
  activities: createActivities(users, orders),

  // 每天的營收，給儀表板畫折線圖用（最近 14 天，舊到新）
  revenueSeries: Array.from({ length: 14 }, (_, index) => {
    const day = 13 - index;
    return {
      date: new Date(startedAt - day * DAY).toISOString().slice(0, 10),
      revenue: between(48, 196) * 1000,
      orders: between(6, 34)
    };
  })
};

module.exports = { db };
