// 前端 mock 的「記憶體資料庫」。
// 這裡的資料在瀏覽器分頁存活期間可被 mutation 改動（新增 / 更新 / 刪除），
// 重新整理後回到初始狀態——足以示範完整的 CRUD 資料流。

const LEVELS = ['beginner', 'intermediate', 'advanced']
const CATEGORIES = ['前端', '後端', '資料庫', 'DevOps', '行動開發']

const COURSE_TITLES = [
  'React 元件設計實戰',
  'TanStack Query 資料層架構',
  'Zustand 全域狀態管理',
  'React Router 巢狀路由',
  '表單驗證與使用者體驗',
  'useEffect 與副作用管理',
  'Vite 打包與效能調校',
  'TypeScript 漸進式導入',
  'Node.js API 設計',
  'PostgreSQL 查詢優化',
  'Docker 容器化部署',
  'CI/CD 自動化流水線',
  'Flutter 跨平台開發',
  'CSS 版面與響應式',
  'Web 安全基礎',
  '前端測試策略',
  'GraphQL 入門到實戰',
  'Redis 快取設計',
  'Nginx 反向代理',
  'gRPC 前端串接',
]

// 以固定規則生成，讓每次啟動的初始資料一致、可預期。
function buildCourses() {
  const now = Date.now()
  const list = []
  for (let i = 0; i < 46; i += 1) {
    const base = COURSE_TITLES[i % COURSE_TITLES.length]
    const title = i < COURSE_TITLES.length ? base : `${base} #${i}`
    list.push({
      id: i + 1,
      title,
      level: LEVELS[i % LEVELS.length],
      category: CATEGORIES[i % CATEGORIES.length],
      minutes: 30 + (i % 12) * 10,
      students: 120 + ((i * 37) % 2000),
      rating: Number((3.6 + ((i * 7) % 14) / 10).toFixed(1)),
      published: i % 4 !== 0,
      description:
        '本課程從觀念出發，搭配可操作的範例，帶你完成一個可維護的實作，' +
        '並在最後收斂到常見的實務問題與除錯技巧。',
      updatedAt: now - i * 36 * 60 * 60 * 1000,
    })
  }
  return list
}

function buildUsers() {
  const names = [
    ['王小明', 'ming', 'admin'],
    ['陳美惠', 'meihui', 'editor'],
    ['林建宏', 'jianhong', 'editor'],
    ['張雅婷', 'yating', 'viewer'],
    ['李俊傑', 'junjie', 'editor'],
    ['吳佩珊', 'peishan', 'viewer'],
    ['劉冠廷', 'guanting', 'editor'],
    ['蔡依林', 'yilin', 'viewer'],
    ['黃志豪', 'zhihao', 'editor'],
    ['周杰倫', 'jaychou', 'viewer'],
    ['許慧珊', 'huishan', 'editor'],
    ['鄭文傑', 'wenjie', 'viewer'],
  ]
  const now = Date.now()
  return names.map(([name, username, role], i) => ({
    id: i + 1,
    name,
    username,
    email: `${username}@example.com`,
    role,
    status: i % 5 === 0 ? 'disabled' : 'active',
    createdAt: now - (i + 1) * 5 * 24 * 60 * 60 * 1000,
  }))
}

// 對外提供可變的資料表。mock 攔截器直接讀寫這些陣列。
export const db = {
  courses: buildCourses(),
  users: buildUsers(),
}

// 供 mutation 產生新 id
export function nextCourseId() {
  return db.courses.reduce((max, c) => Math.max(max, Number(c.id) || 0), 0) + 1
}

export const CONSTANTS = { LEVELS, CATEGORIES }
