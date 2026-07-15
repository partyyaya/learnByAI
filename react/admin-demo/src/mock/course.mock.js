import { db, nextCourseId } from './db'

// 課程 CRUD 與列表查詢的 mock。這支檔案是整個資料流的核心，
// 對應課程第 09/10/12 章（Query 讀取、Mutation 寫入、篩選 → queryKey）。

function applyFilters(list, { search = '', level = 'all', sort = 'updated-desc' }) {
  const text = String(search).trim().toLowerCase()

  let result = list.filter((c) => {
    const matchText = !text || c.title.toLowerCase().includes(text)
    const matchLevel = level === 'all' || c.level === level
    return matchText && matchLevel
  })

  result = [...result].sort((a, b) => {
    switch (sort) {
      case 'title-asc':
        return a.title.localeCompare(b.title)
      case 'students-desc':
        return b.students - a.students
      case 'rating-desc':
        return b.rating - a.rating
      case 'updated-desc':
      default:
        return b.updatedAt - a.updatedAt
    }
  })

  return result
}

function getIdFromUrl(url) {
  const match = String(url).match(/\/courses\/(\d+)/)
  return match ? Number(match[1]) : null
}

export function registerCourseMock(mock) {
  // 無限捲動列表：GET /courses/infinite?page=1 —— 放在具體路徑前面註冊，避免被 /courses 吃掉。
  mock.onGet('/courses/infinite').reply((config) => {
    const page = Number(config.params?.page) || 1
    const pageSize = 6
    const sorted = applyFilters(db.courses, { sort: 'updated-desc' })
    const start = (page - 1) * pageSize
    const items = sorted.slice(start, start + pageSize)
    const nextPage = start + pageSize < sorted.length ? page + 1 : null
    return [200, { items, nextPage }]
  })

  // 課程詳情：GET /courses/:id
  mock.onGet(/\/courses\/\d+$/).reply((config) => {
    const id = getIdFromUrl(config.url)
    const course = db.courses.find((c) => c.id === id)
    if (!course) return [404, { message: '找不到這門課程' }]
    return [200, course]
  })

  // 分頁列表：GET /courses?search=&level=&sort=&page=&pageSize=
  mock.onGet('/courses').reply((config) => {
    const {
      search = '',
      level = 'all',
      sort = 'updated-desc',
      page = 1,
      pageSize = 8,
    } = config.params || {}

    const filtered = applyFilters(db.courses, { search, level, sort })
    const pageNum = Number(page) || 1
    const size = Number(pageSize) || 8
    const start = (pageNum - 1) * size
    const items = filtered.slice(start, start + size)

    return [
      200,
      { items, total: filtered.length, page: pageNum, pageSize: size },
    ]
  })

  // 新增：POST /courses
  mock.onPost('/courses').reply((config) => {
    const input = JSON.parse(config.data || '{}')

    // 教學用：標題含「fail」時一定失敗，方便穩定示範樂觀更新的「回滾」。
    if (String(input.title).toLowerCase().includes('fail')) {
      return [500, { message: '伺服器忙碌中，新增失敗（示範回滾）' }]
    }

    const course = {
      id: nextCourseId(),
      title: input.title,
      level: input.level || 'beginner',
      category: input.category || '前端',
      minutes: Number(input.minutes) || 30,
      students: 0,
      rating: 0,
      published: false,
      description: input.description || '',
      updatedAt: Date.now(),
    }
    db.courses = [course, ...db.courses]
    return [201, course]
  })

  // 更新（含切換上架狀態）：PATCH /courses/:id
  mock.onPatch(/\/courses\/\d+$/).reply((config) => {
    const id = getIdFromUrl(config.url)
    const patch = JSON.parse(config.data || '{}')
    const index = db.courses.findIndex((c) => c.id === id)
    if (index === -1) return [404, { message: '找不到這門課程' }]

    const updated = { ...db.courses[index], ...patch, updatedAt: Date.now() }
    db.courses[index] = updated
    return [200, updated]
  })

  // 刪除：DELETE /courses/:id
  mock.onDelete(/\/courses\/\d+$/).reply((config) => {
    const id = getIdFromUrl(config.url)
    const exists = db.courses.some((c) => c.id === id)
    if (!exists) return [404, { message: '找不到這門課程' }]
    db.courses = db.courses.filter((c) => c.id !== id)
    return [200, { success: true, id }]
  })
}
