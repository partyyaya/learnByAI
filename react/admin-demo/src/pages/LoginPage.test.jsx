import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@/test/renderWithProviders'
import { authApi } from '@/services/api/auth.api'
import { useAuthStore } from '@/stores/auth.store'
import LoginPage from './LoginPage'

// 元件測試：登入頁（第 14 章 §5）。
//
// 這一頁同時吃到三種 context，是「為什麼需要 renderWithProviders」的最佳範例：
// - useMutation      → 需要 QueryClientProvider
// - useNavigate / Navigate / useLocation → 需要 Router
// - useAuthStore     → Zustand 不需要 Provider，但需要在測試間重設（見 src/test/setup.js）

// 攔截 API 層，而不是攔截 axios。
// 理由：測試要驗的是「元件在 API 成功 / 失敗時的反應」，
// 從最靠近元件的那一層換掉最省事，也不會綁死底層用什麼送請求。
// 注意 vi.mock 會被提升到檔案最上方執行，所以不能在工廠函式裡引用外部變數。
vi.mock('@/services/api/auth.api', () => ({
  authApi: { login: vi.fn(), getProfile: vi.fn() },
}))

// 兩個欄位的取用方式抽成小函式，原因值得記住：
// Field 元件把「label 文字 + 輸入框 + 錯誤訊息」包在同一個 <label> 裡，
// 所以一旦出現錯誤，這個 label 的文字會從「帳號」變成「帳號請輸入帳號」，
// getByLabelText('帳號') 這種完全比對就會突然找不到元素。
// 改用正規表達式做部分比對，有沒有錯誤訊息都抓得到同一個欄位。
const usernameInput = () => screen.getByLabelText(/帳號/)
const passwordInput = () => screen.getByLabelText(/密碼/)

describe('LoginPage', () => {
  beforeEach(() => {
    // 清掉上一個測試累積的呼叫紀錄與回傳設定，
    // 否則 toHaveBeenCalledTimes 之類的斷言會把前面的次數也算進來。
    vi.resetAllMocks()
  })

  it('未填任何欄位就送出，顯示兩個必填錯誤且不打 API', async () => {
    const { user } = renderWithProviders(<LoginPage />, { route: '/login' })

    await user.click(screen.getByRole('button', { name: '登入' }))

    expect(screen.getByText('請輸入帳號')).toBeInTheDocument()
    expect(screen.getByText('請輸入密碼')).toBeInTheDocument()
    // 前端驗證的價值就在這行：擋掉不必要的請求
    expect(authApi.login).not.toHaveBeenCalled()
  })

  it('密碼少於 6 碼時擋下並提示', async () => {
    const { user } = renderWithProviders(<LoginPage />, { route: '/login' })

    // getByLabelText 走的是使用者視角：畫面上寫「帳號」的那格。
    // Field 元件用 <label> 把 <input> 包住，所以不需要 htmlFor/id 也能對應到。
    await user.type(usernameInput(), 'admin')
    await user.type(passwordInput(), '123')
    await user.click(screen.getByRole('button', { name: '登入' }))

    expect(screen.getByText('密碼至少 6 碼')).toBeInTheDocument()
    expect(authApi.login).not.toHaveBeenCalled()
  })

  it('修正欄位後錯誤訊息會消失', async () => {
    const { user } = renderWithProviders(<LoginPage />, { route: '/login' })

    await user.click(screen.getByRole('button', { name: '登入' }))
    expect(screen.getByText('請輸入帳號')).toBeInTheDocument()

    await user.type(usernameInput(), 'admin')

    // queryByText 找不到會回 null（而非拋錯），才適合拿來斷言「不存在」。
    // 這裡驗的是 updateField 會順手清掉該欄位的錯誤——一種容易在重構時弄丟的體貼。
    expect(screen.queryByText('請輸入帳號')).not.toBeInTheDocument()
  })

  it('驗證通過會帶著表單內容呼叫 login，成功後把登入態寫進 Zustand', async () => {
    authApi.login.mockResolvedValue({
      token: 'fake-token',
      user: { id: 1, name: '王小明', role: 'admin' },
    })

    const { user } = renderWithProviders(<LoginPage />, { route: '/login' })

    await user.type(usernameInput(), 'admin')
    await user.type(passwordInput(), 'admin123')
    await user.click(screen.getByRole('button', { name: '登入' }))

    // waitFor 會反覆重試裡面的斷言直到通過或逾時。
    // mutation 是非同步的，點下去的當下 onSuccess 還沒跑，直接斷言必定失敗。
    await waitFor(() => {
      // 第二個參數 expect.anything() 不能省略。
      // TanStack Query v5 呼叫 mutationFn 時會多帶一個「mutation 情境」物件
      // （內含 client、meta、mutationKey），而元件是把 authApi.login 直接當
      // mutationFn 傳進去的，所以這個 spy 實際上收到兩個參數。
      // 只寫第一個參數會得到「多了一個物件」的比對失敗——很容易誤判成程式有 bug。
      expect(authApi.login).toHaveBeenCalledWith(
        { username: 'admin', password: 'admin123' },
        expect.anything()
      )
    })

    await waitFor(() => {
      expect(useAuthStore.getState().token).toBe('fake-token')
    })
    expect(useAuthStore.getState().user.role).toBe('admin')
  })

  it('登入失敗時顯示後端回傳的錯誤訊息，且不寫入登入態', async () => {
    // mockRejectedValue 模擬 API 拋錯；元件用 loginMutation.error.message 呈現。
    authApi.login.mockRejectedValue(new Error('帳號或密碼錯誤'))

    const { user } = renderWithProviders(<LoginPage />, { route: '/login' })

    await user.type(usernameInput(), 'admin')
    await user.type(passwordInput(), 'wrong-password')
    await user.click(screen.getByRole('button', { name: '登入' }))

    // findByText = getByText + waitFor，等待非同步出現的元素時用它最直覺
    expect(await screen.findByText('帳號或密碼錯誤')).toBeInTheDocument()
    expect(useAuthStore.getState().token).toBe('')
  })

  it('點「快速填入 admin」會把帳密填好', async () => {
    const { user } = renderWithProviders(<LoginPage />, { route: '/login' })

    await user.click(screen.getByRole('button', { name: 'admin' }))

    // 受控 input 的當前值就是 state 的鏡子，驗它等於驗 state 有沒有更新
    expect(usernameInput()).toHaveValue('admin')
    expect(passwordInput()).toHaveValue('admin123')
  })

  it('已登入者看不到登入表單（會被導走）', async () => {
    // 直接把 store 設成已登入，模擬「重整後 persist 還原登入態」的情境。
    useAuthStore.setState({
      token: 'existing-token',
      user: { id: 1, name: '王小明', role: 'admin' },
    })

    renderWithProviders(<LoginPage />, { route: '/login' })

    // 元件回傳 <Navigate to="/dashboard" />，本身不渲染任何表單內容。
    // MemoryRouter 裡沒有 /dashboard 這條路由，所以畫面是空的——
    // 我們要驗的就是「登入表單沒有出現」這件事。
    expect(screen.queryByRole('button', { name: '登入' })).not.toBeInTheDocument()
  })
})
