import { IconDashboard, IconOrders, IconSettings, IconUsers } from "./components/icons";

/**
 * 側邊欄的選單。這份定義同時被三個地方使用：
 *
 *   Sidebar  → 畫出兩層選單
 *   Navbar   → 反查目前頁面的標題、說明，以及它屬於哪一個群組
 *   App.jsx  → 註冊路由
 *
 * 放在同一個陣列的好處是「選單有這一項但路由忘了加」這種錯不會發生。
 *
 * 有 `children` 的那一項是**群組**，本身不是一個頁面（沒有 `to`）：點它只會展開／
 * 收起。要不要讓群組自己也是一頁是個取捨——給了 `to` 就得回答「點父層跟點第一個
 * 子項有什麼不同」，多數後台的答案是「沒有不同」，那就別給，少一個沒人按得懂的目標。
 */
export const NAV_ITEMS = [
  {
    to: "/dashboard",
    label: "儀表板",
    description: "營運概況與最近動態",
    icon: IconDashboard
  },
  {
    // 群組要有自己的 key：React 的 key、aria-controls 的 id、以及「哪些群組是
    // 展開的」那個 Set 都用它，不能拿 label 當 id（中文不適合當 DOM id）
    key: "users",
    label: "使用者管理",
    icon: IconUsers,
    children: [
      { to: "/users", label: "使用者列表", description: "帳號、角色與啟用狀態" },
      { to: "/users/roles", label: "角色與權限", description: "三個角色各自能做什麼" }
    ]
  },
  {
    to: "/orders",
    label: "訂單管理",
    description: "訂單查詢與狀態追蹤",
    icon: IconOrders
  },
  {
    key: "settings",
    label: "系統設定",
    icon: IconSettings,
    children: [
      { to: "/settings", label: "介面外觀", description: "主題偏好，存在這台電腦" },
      { to: "/settings/mock", label: "模擬後端", description: "延遲、失敗率與斷線" },
      { to: "/settings/probe", label: "連線測試", description: "手動打 API，看前端怎麼反應" }
    ]
  }
];

// 不出現在側邊欄、但需要標題的頁面（從使用者下拉選單進去）
const EXTRA_PAGES = [
  { to: "/profile", label: "個人資料", description: "目前登入的帳號與 session 狀態" }
];

/**
 * 攤平成「真的對應一個路由的節點」，順便把上一層記在 `parent` 上。
 * 群組自己不進這份清單——它沒有 `to`，反查頁面標題時不該被找到。
 */
export const PAGES = [
  ...NAV_ITEMS.flatMap((item) =>
    item.children
      ? item.children.map((child) => ({ ...child, parent: item }))
      : [{ ...item, parent: null }]
  ),
  ...EXTRA_PAGES.map((page) => ({ ...page, parent: null }))
];

/**
 * 反查目前在哪一頁。
 *
 * **不能用「第一個 startsWith 就算」**——`/settings` 是 `/settings/mock` 的前綴，
 * 那樣三個子頁的標題都會變成「介面外觀」。所以先找完全相同的，再退回**最長**的
 * 前綴。前綴這條規則還是要留：以後多一個 `/users/42` 這種細節頁時，它仍然應該
 * 算在「使用者列表」底下。
 */
export function findPage(pathname) {
  const exact = PAGES.find((page) => page.to === pathname);
  if (exact) return exact;

  const prefixed = PAGES.filter((page) => pathname.startsWith(`${page.to}/`)).sort(
    (a, b) => b.to.length - a.to.length
  );

  return prefixed[0] ?? PAGES[0];
}

/** 麵包屑：子頁回 [群組, 頁面]，頂層頁面回 [頁面] */
export function findTrail(pathname) {
  const page = findPage(pathname);
  return page.parent ? [page.parent, page] : [page];
}
