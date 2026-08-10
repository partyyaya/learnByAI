import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// 測試用的 render 包裝（第 14 章）。
//
// 為什麼需要它？
// 本專案的元件大量使用 useQuery / useMutation / Link / useParams，
// 這些 hook 都是「向上找 context」才拿得到東西的。直接 render(<CourseListPage />)
// 會炸在 "No QueryClient set" 或 "useNavigate() may be used only in the context of
// a <Router>"——這不是元件壞了，是測試少給了執行環境。
//
// 正式環境的 Provider 由 main.jsx 掛載；測試環境就由這支檔案負責掛同一組。

// 每次 render 都用「全新的」QueryClient，這點很關鍵。
// 共用一個 client 會讓 A 測試抓到的資料留在快取裡，B 測試直接讀到舊資料，
// 於是 B 的 queryFn 根本沒被呼叫——測試就變得不可信。
export function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // 測試裡最重要的一項。正式設定是 retry: 1，
        // 但測「錯誤狀態」時重試會讓 queryFn 多跑一次、拖慢數秒才顯示錯誤畫面，
        // 常常導致 waitFor 逾時。測試中一律關掉。
        retry: false,
        // 不要保留上一次的資料，避免跨測試互相干擾。
        gcTime: 0,
        // jsdom 沒有真的視窗焦點事件，關掉比較單純。
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: false,
      },
    },
  })
}

/**
 * 把元件包進 QueryClientProvider + MemoryRouter 後 render。
 *
 * @param ui       要測的元件，例如 <CourseListPage />
 * @param options.route  初始網址，預設 '/'。測動態路由時填實際網址，如 '/courses/3'
 * @param options.path   路由樣板，如 '/courses/:id'。有填才會用 Routes 包起來，
 *                       元件內的 useParams() 才拿得到參數
 * @param options.queryClient  想自己控制快取時可傳入，否則每次都給新的
 */
export function renderWithProviders(
  ui,
  { route = '/', path, queryClient = createTestQueryClient(), ...options } = {}
) {
  function Wrapper({ children }) {
    return (
      <QueryClientProvider client={queryClient}>
        {/* MemoryRouter：把網址存在記憶體而非真實 URL，
            jsdom 環境不能用 BrowserRouter 的 history API 導頁。
            initialEntries 就是「假的瀏覽紀錄」，陣列最後一項是當前頁。 */}
        <MemoryRouter initialEntries={[route]}>
          {path ? (
            // 有 path 才需要 Routes：唯有比對到路由樣板，
            // React Router 才會把 :id 解析成參數餵給 useParams()。
            <Routes>
              <Route path={path} element={children} />
            </Routes>
          ) : (
            children
          )}
        </MemoryRouter>
      </QueryClientProvider>
    )
  }

  return {
    // 一併回傳 user，測試裡就不用每次自己 setup()。
    // 注意 userEvent.setup() 必須在 render 之前呼叫，這裡的順序是對的。
    user: userEvent.setup(),
    // 回傳 queryClient，需要時可以手動塞快取或清空。
    queryClient,
    ...render(ui, { wrapper: Wrapper, ...options }),
  }
}
