import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders } from '@/test/renderWithProviders'
import { courseApi } from '@/services/api/course.api'
import { useUiStore } from '@/stores/ui.store'
import CourseDetailPage from './CourseDetailPage'

// 元件測試：課程詳情頁（第 14 章 §5）。
//
// 這一頁示範的是「動態路由參數」怎麼測。
// 元件用 useParams() 取 :courseId——而 useParams 只有在「網址比對到某條路由」時才有值。
// 所以光包 MemoryRouter 不夠，還要用 Routes/Route 宣告路由樣板，
// renderWithProviders 的 path 選項就是在做這件事：
//   renderWithProviders(<CourseDetailPage />, {
//     route: '/courses/3',       ← 假裝使用者現在在這個網址
//     path: '/courses/:courseId' ← 路由樣板，:courseId 因此解析成 '3'
//   })
// 少了 path，useParams() 會回空物件，courseId 是 undefined，
// useCourseDetailQuery 的 enabled: Boolean(id) 就永遠是 false——
// 畫面卡在載入中，錯誤訊息還完全不會提到路由，很難debug。

vi.mock('@/services/api/course.api', () => ({
  courseApi: {
    list: vi.fn(),
    listInfinite: vi.fn(),
    detail: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  },
}))

const COURSE = {
  id: 3,
  title: 'PostgreSQL 查詢優化',
  level: 'advanced',
  category: '資料庫',
  minutes: 120,
  students: 12345,
  rating: 4.9,
  published: true,
  description: '從執行計畫讀起，逐步找出慢查詢的真正瓶頸。',
  updatedAt: new Date(2024, 2, 7).getTime(),
}

// 每個測試都用同一組路由設定，抽成常數少寫幾次
const ROUTE_OPTIONS = { route: '/courses/3', path: '/courses/:courseId' }

describe('CourseDetailPage', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    courseApi.detail.mockResolvedValue(COURSE)
  })

  it('用網址上的 id 抓資料', async () => {
    renderWithProviders(<CourseDetailPage />, ROUTE_OPTIONS)

    await screen.findByText('PostgreSQL 查詢優化')
    // useParams 拿到的永遠是字串，這裡順便釘住這個容易踩的細節：
    // 若哪天改成 Number(courseId) 傳進去，這個斷言會提醒你 API 層的預期也要跟著改。
    expect(courseApi.detail).toHaveBeenCalledWith('3')
  })

  it('顯示課程的完整資訊', async () => {
    renderWithProviders(<CourseDetailPage />, ROUTE_OPTIONS)

    expect(await screen.findByText('PostgreSQL 查詢優化')).toBeInTheDocument()
    expect(screen.getByText('課程編號 #3')).toBeInTheDocument()
    expect(screen.getByText('進階')).toBeInTheDocument()
    expect(screen.getByText('120 分鐘')).toBeInTheDocument()
    // 驗的是「經過 formatNumber 之後」的畫面文字，不是原始的 12345。
    // 使用者看到的是 12,345，測試就該對著這個值。
    expect(screen.getByText('12,345')).toBeInTheDocument()
    expect(screen.getByText('2024-03-07')).toBeInTheDocument()
  })

  it('載入中先顯示 Spinner', () => {
    // 讓 Promise 永遠不 resolve，把畫面凍在載入狀態方便斷言。
    // 這是測 loading 最可靠的做法——不必猜時間、也不會有 race。
    courseApi.detail.mockReturnValue(new Promise(() => {}))

    renderWithProviders(<CourseDetailPage />, ROUTE_OPTIONS)

    // 這裡不用 await：要驗的就是「render 當下」的畫面
    expect(screen.getByText('載入課程詳情…')).toBeInTheDocument()
  })

  it('抓不到資料時顯示錯誤狀態', async () => {
    courseApi.detail.mockRejectedValue(new Error('查無此課程'))

    renderWithProviders(<CourseDetailPage />, ROUTE_OPTIONS)

    expect(await screen.findByText('查無此課程')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重試' })).toBeInTheDocument()
  })

  it('點收藏會切換按鈕文字並寫進 Zustand', async () => {
    const { user } = renderWithProviders(<CourseDetailPage />, ROUTE_OPTIONS)

    const bookmarkButton = await screen.findByRole('button', {
      name: '加入收藏',
    })
    await user.click(bookmarkButton)

    // 兩層都要驗：畫面回饋（使用者看得到的）與 store 內容（persist 後會保留的）
    expect(screen.getByRole('button', { name: '已收藏' })).toBeInTheDocument()
    expect(useUiStore.getState().bookmarkedCourseIds).toContain(3)
  })

  it('已收藏的課程一進頁面就顯示「已收藏」', async () => {
    // 直接設定 store 來鋪陳前置狀態，比在測試裡先點一次按鈕更快也更明確
    useUiStore.setState({ bookmarkedCourseIds: [3] })

    renderWithProviders(<CourseDetailPage />, ROUTE_OPTIONS)

    expect(await screen.findByRole('button', { name: '已收藏' })).toBeInTheDocument()
  })
})
