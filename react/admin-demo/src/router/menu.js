// 側欄選單設定：單一資料來源。
// 每個 item：{ path, label, icon, roles? }
//   roles 未指定 → 所有已登入者可見；有指定 → 只有清單內角色可見。
// 這讓「選單」與「權限」集中管理，Sidebar 依登入者 role 過濾即可。
export const menuSections = [
  {
    title: '總覽',
    items: [{ path: '/dashboard', label: '儀表板', icon: 'grid' }],
  },
  {
    title: '內容管理',
    items: [
      { path: '/courses', label: '課程管理', icon: 'book' },
      { path: '/courses/feed', label: '課程動態', icon: 'feed' },
    ],
  },
  {
    title: '系統',
    items: [
      { path: '/users', label: '使用者管理', icon: 'users', roles: ['admin'] },
      { path: '/settings', label: '設定', icon: 'settings' },
    ],
  },
  {
    title: '課程實驗室',
    items: [
      { path: '/labs/effects', label: 'Effects 實驗室', icon: 'bolt' },
      { path: '/labs/performance', label: '效能實驗室', icon: 'gauge' },
    ],
  },
]

// 依角色過濾出可見選單
export function getVisibleSections(role) {
  return menuSections
    .map((section) => ({
      ...section,
      items: section.items.filter(
        (item) => !item.roles || item.roles.includes(role)
      ),
    }))
    .filter((section) => section.items.length > 0)
}

// 給頁面標題 / 麵包屑用：path → label 對照
export function findMenuLabel(pathname) {
  for (const section of menuSections) {
    const hit = section.items.find((item) => item.path === pathname)
    if (hit) return hit.label
  }
  return ''
}
