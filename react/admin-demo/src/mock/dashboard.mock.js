import { db } from './db'

// 儀表板統計。刻意由 db 即時計算，讓「新增/刪除課程」後回到儀表板數字也會變。
export function registerDashboardMock(mock) {
  mock.onGet('/dashboard/summary').reply(() => {
    const courses = db.courses
    const published = courses.filter((c) => c.published).length
    const totalStudents = courses.reduce((sum, c) => sum + c.students, 0)
    const avgRating =
      courses.reduce((sum, c) => sum + c.rating, 0) / (courses.length || 1)

    // 各分類課程數（給長條圖用）
    const byCategory = {}
    for (const c of courses) {
      byCategory[c.category] = (byCategory[c.category] || 0) + 1
    }
    const categoryStats = Object.entries(byCategory).map(([name, value]) => ({
      name,
      value,
    }))

    // 近 7 日新增註冊（示意資料）
    const trend = [42, 58, 51, 73, 66, 88, 95].map((value, i) => ({
      day: `週${['一', '二', '三', '四', '五', '六', '日'][i]}`,
      value,
    }))

    const stats = [
      { key: 'courses', label: '課程總數', value: courses.length, delta: 8.2 },
      { key: 'published', label: '已上架', value: published, delta: 3.1 },
      {
        key: 'students',
        label: '總報名人次',
        value: totalStudents,
        delta: 12.5,
      },
      {
        key: 'rating',
        label: '平均評分',
        value: Number(avgRating.toFixed(2)),
        delta: 0.4,
      },
    ]

    return [200, { stats, categoryStats, trend }]
  })
}
