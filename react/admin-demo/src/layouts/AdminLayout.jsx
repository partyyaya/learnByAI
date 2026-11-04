import { Suspense } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import ErrorBoundary from '@/components/ui/ErrorBoundary'
import Spinner from '@/components/ui/Spinner'
import Sidebar from './components/Sidebar'
import Header from './components/Header'

// 後台外殼：Sidebar + Header + 內容區的 <Outlet />。
// 對應第 08 章「共用 Layout + 巢狀路由」：所有受保護頁面共用這一層。
//
// 內容區外面再包兩層（第 13 章）：
// - Suspense：頁面是 React.lazy 載入的（見 App.jsx），下載頁面程式時只有內容區顯示載入中，
//   側欄與頁首留在畫面上。
// - ErrorBoundary：某一頁渲染出錯時，只有內容區換成錯誤畫面。
//   key 用目前路徑：換頁時重新掛載、清掉錯誤狀態，否則錯誤畫面會一直留著。
function AdminLayout() {
  const location = useLocation()

  return (
    <div className="admin-shell">
      <Sidebar />
      <div className="admin-main">
        <Header />
        <main className="admin-content">
          <ErrorBoundary key={location.pathname}>
            <Suspense fallback={<Spinner label="頁面載入中…" />}>
              <Outlet />
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>
    </div>
  )
}

export default AdminLayout
