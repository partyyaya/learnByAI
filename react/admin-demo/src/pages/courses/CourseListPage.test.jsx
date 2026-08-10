import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { renderWithProviders } from '@/test/renderWithProviders'
import { courseApi } from '@/services/api/course.api'
import { useCourseFilterStore } from '@/stores/courseFilter.store'
import CourseListPage from './CourseListPage'

// 元件測試：課程管理頁（第 14 章 §5）。
//
// 這一頁是整個專案「Zustand + TanStack Query」整合的樣板，也是最需要 Provider 的一頁：
//   篩選條件（Zustand）→ 組成 queryKey → useQuery 抓資料 → useMutation 樂觀更新
// 因此測試同時要準備 QueryClientProvider（Query）與 MemoryRouter（表格內的 <Link>）。
// 這兩件事都封裝在 renderWithProviders 裡了。

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

// 測試用假資料。刻意只留三筆、欄位齊全但精簡：
// 資料越少，斷言越好寫，測試失敗時也越容易一眼看出哪裡不對。
const COURSES = [
  {
    id: 1,
    title: 'React 元件設計實戰',
    level: 'beginner',
    category: '前端',
    minutes: 60,
    students: 1200,
    rating: 4.8,
    published: true,
    updatedAt: new Date(2024, 2, 7).getTime(),
  },
  {
    id: 2,
    title: 'TanStack Query 資料層架構',
    level: 'intermediate',
    category: '前端',
    minutes: 90,
    students: 860,
    rating: 4.6,
    published: false,
    updatedAt: new Date(2024, 2, 5).getTime(),
  },
  {
    id: 3,
    title: 'PostgreSQL 查詢優化',
    level: 'advanced',
    category: '資料庫',
    minutes: 120,
    students: 430,
    rating: 4.9,
    published: true,
    updatedAt: new Date(2024, 2, 1).getTime(),
  },
]

describe('CourseListPage', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    // 預設情境：API 正常回三筆。個別測試需要別的回應時再自己覆寫。
    courseApi.list.mockResolvedValue({ items: COURSES, total: COURSES.length })
  })

  it('載入完成後把課程渲染成表格', async () => {
    renderWithProviders(<CourseListPage />)

    // findBy* 內建等待：第一次 render 時資料還沒回來，畫面是 loading。
    // 用 getBy* 會當場失敗，這是元件測試最常見的第一個坑。
    expect(await screen.findByText('React 元件設計實戰')).toBeInTheDocument()
    expect(screen.getByText('PostgreSQL 查詢優化')).toBeInTheDocument()

    // 表頭一列 + 資料三列
    expect(screen.getAllByRole('row')).toHaveLength(4)
  })

  it('把 Zustand 的篩選條件原封不動帶進 API 呼叫', async () => {
    renderWithProviders(<CourseListPage />)

    await waitFor(() => {
      // 第 12 章的核心：條件 → queryKey → queryFn 參數。
      // 驗這一行等於驗「條件真的有傳到後端」，而不是只有畫面上看起來有選。
      expect(courseApi.list).toHaveBeenCalledWith({
        search: '',
        level: 'all',
        sort: 'updated-desc',
        page: 1,
        pageSize: 8,
      })
    })
  })

  it('輸入搜尋字會用新條件重新抓資料', async () => {
    const { user } = renderWithProviders(<CourseListPage />)
    await screen.findByText('React 元件設計實戰')

    // 用 getByLabelText 而非 getByPlaceholderText：
    // placeholder 一開始打字就消失了，不是穩定的識別依據；
    // 元件已用 aria-label 補上可及名稱，測試就跟著走使用者視角。
    await user.type(screen.getByLabelText('搜尋課程名稱'), 'Query')

    // 每一個按鍵都會改 store → 換 queryKey → 觸發一次抓取，
    // 所以這裡看「最後一次」呼叫帶的條件，而不是總呼叫次數。
    // （正式產品該加 debounce，這裡保持單純以突顯資料流。）
    await waitFor(() => {
      expect(courseApi.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ search: 'Query', page: 1 })
      )
    })
  })

  it('切換難度會帶著 level 重新抓，並回到第 1 頁', async () => {
    // 先把頁碼設到第 2 頁，才能驗「換條件要跳回第 1 頁」這個行為
    useCourseFilterStore.setState({ page: 2 })

    const { user } = renderWithProviders(<CourseListPage />)
    await screen.findByText('React 元件設計實戰')

    // 這兩個 <select> 版面上沒有可見的文字標籤，元件用 aria-label 提供可及名稱，
    // 測試就能用「難度篩選」這種語意明確的方式定位，而不是靠 class 或選項文字。
    await user.selectOptions(screen.getByLabelText('難度篩選'), 'advanced')

    await waitFor(() => {
      expect(courseApi.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ level: 'advanced', page: 1 })
      )
    })
  })

  it('切換排序會帶著 sort 重新抓', async () => {
    const { user } = renderWithProviders(<CourseListPage />)
    await screen.findByText('React 元件設計實戰')

    await user.selectOptions(screen.getByLabelText('排序方式'), 'rating-desc')

    await waitFor(() => {
      expect(courseApi.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ sort: 'rating-desc', page: 1 })
      )
    })
  })

  it('按重設會清掉所有篩選條件', async () => {
    useCourseFilterStore.setState({
      search: 'React',
      level: 'advanced',
      page: 3,
    })

    const { user } = renderWithProviders(<CourseListPage />)
    await screen.findByText('React 元件設計實戰')

    await user.click(screen.getByRole('button', { name: '重設' }))

    await waitFor(() => {
      expect(courseApi.list).toHaveBeenLastCalledWith({
        search: '',
        level: 'all',
        sort: 'updated-desc',
        page: 1,
        pageSize: 8,
      })
    })
    // 順帶確認畫面上的輸入框也跟著清空（受控元件與 store 同步）
    expect(screen.getByLabelText('搜尋課程名稱')).toHaveValue('')
  })

  it('查無資料時顯示空狀態而不是空白表格', async () => {
    courseApi.list.mockResolvedValue({ items: [], total: 0 })

    renderWithProviders(<CourseListPage />)

    expect(await screen.findByText('目前沒有資料')).toBeInTheDocument()
    expect(
      screen.getByText('換個關鍵字或重設篩選條件試試。')
    ).toBeInTheDocument()
  })

  it('API 失敗時顯示錯誤訊息與重試按鈕，按下會再打一次', async () => {
    courseApi.list.mockRejectedValue(new Error('伺服器連線失敗'))

    const { user } = renderWithProviders(<CourseListPage />)

    // 這個測試能穩定通過，關鍵在 createTestQueryClient 設了 retry: false。
    // 沿用正式設定的 retry: 1 的話，要等重試跑完才會進入 error 狀態，
    // waitFor 常常先逾時——「測錯誤狀態很慢」幾乎都是這個原因。
    expect(await screen.findByText('伺服器連線失敗')).toBeInTheDocument()

    const callsBeforeRetry = courseApi.list.mock.calls.length
    await user.click(screen.getByRole('button', { name: '重試' }))

    await waitFor(() => {
      expect(courseApi.list.mock.calls.length).toBeGreaterThan(callsBeforeRetry)
    })
  })

  it('刪除課程時會先跳確認，樂觀更新讓該列立刻消失', async () => {
    // window.confirm 在 jsdom 沒有實作，不攔截會直接拋錯。
    // 這裡讓它一律回 true，模擬使用者按下「確定」。
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    courseApi.remove.mockResolvedValue({ ok: true })
    // 這裡要模擬「刪除前 / 刪除後」兩種伺服器回應，順序很重要：
    // mockResolvedValueOnce 只生效一次（第一次載入，三筆都在），
    // 之後的呼叫才落到 mockResolvedValue（onSettled invalidate 重抓，剩兩筆）。
    // 若一開始就回兩筆，那列從頭到尾沒出現過，測試等於什麼都沒驗到；
    // 若重抓還回三筆，被刪掉的列又會被抓回畫面上，斷言就會忽過忽不過。
    courseApi.list
      .mockResolvedValueOnce({ items: COURSES, total: COURSES.length })
      .mockResolvedValue({
        items: COURSES.filter((c) => c.id !== 2),
        total: 2,
      })

    const { user } = renderWithProviders(<CourseListPage />)
    const targetRow = (
      await screen.findByText('TanStack Query 資料層架構')
    ).closest('tr')

    // within 把查詢範圍限縮在這一列，避免點到其他列的刪除鈕。
    // 按鈕內容只有 SVG，沒有文字，可及名稱是由 title="刪除" 提供的。
    await user.click(within(targetRow).getByRole('button', { name: '刪除' }))

    expect(confirmSpy).toHaveBeenCalledWith(
      '確定要刪除「TanStack Query 資料層架構」嗎？'
    )
    await waitFor(() => {
      expect(courseApi.remove).toHaveBeenCalledWith(2)
    })
    await waitFor(() => {
      expect(
        screen.queryByText('TanStack Query 資料層架構')
      ).not.toBeInTheDocument()
    })
  })

  it('刪除時按取消不會呼叫 API，資料留在畫面上', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)

    const { user } = renderWithProviders(<CourseListPage />)
    const targetRow = (
      await screen.findByText('TanStack Query 資料層架構')
    ).closest('tr')

    await user.click(within(targetRow).getByRole('button', { name: '刪除' }))

    expect(courseApi.remove).not.toHaveBeenCalled()
    expect(screen.getByText('TanStack Query 資料層架構')).toBeInTheDocument()
  })

  it('切換上架狀態會樂觀更新徽章文字', async () => {
    courseApi.update.mockResolvedValue({ ok: true })
    // 同樣是「動作前回原狀、動作後回新狀態」的兩段式 mock：
    // 第一次載入時第 2 筆必須是「未上架」，才有東西可以點。
    courseApi.list
      .mockResolvedValueOnce({ items: COURSES, total: COURSES.length })
      .mockResolvedValue({
        items: COURSES.map((c) => (c.id === 2 ? { ...c, published: true } : c)),
        total: COURSES.length,
      })

    const { user } = renderWithProviders(<CourseListPage />)
    const targetRow = (
      await screen.findByText('TanStack Query 資料層架構')
    ).closest('tr')

    expect(within(targetRow).getByText('未上架')).toBeInTheDocument()
    await user.click(within(targetRow).getByText('未上架'))

    await waitFor(() => {
      expect(courseApi.update).toHaveBeenCalledWith(2, { published: true })
    })
    expect(await within(targetRow).findByText('已上架')).toBeInTheDocument()
  })

  it('表格內的課程名稱是連到詳情頁的連結', async () => {
    renderWithProviders(<CourseListPage />)

    // <Link> 需要 Router 才能 render，這正是要包 MemoryRouter 的原因；
    // 少包的話這裡會直接炸 useNavigate/useHref 相關錯誤。
    const link = await screen.findByRole('link', { name: 'React 元件設計實戰' })
    expect(link).toHaveAttribute('href', '/courses/1')
  })
})
