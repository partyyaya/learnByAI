import { db } from './db'

// 使用者管理列表 mock。只提供讀取與分頁，示範「表格 + 分頁 + 搜尋」。
export function registerUserMock(mock) {
  mock.onGet('/users').reply((config) => {
    const { search = '', role = 'all', page = 1, pageSize = 8 } =
      config.params || {}
    const text = String(search).trim().toLowerCase()

    const filtered = db.users.filter((u) => {
      const matchText =
        !text ||
        u.name.toLowerCase().includes(text) ||
        u.username.toLowerCase().includes(text) ||
        u.email.toLowerCase().includes(text)
      const matchRole = role === 'all' || u.role === role
      return matchText && matchRole
    })

    const pageNum = Number(page) || 1
    const size = Number(pageSize) || 8
    const start = (pageNum - 1) * size
    const items = filtered.slice(start, start + size)

    return [
      200,
      { items, total: filtered.length, page: pageNum, pageSize: size },
    ]
  })
}
