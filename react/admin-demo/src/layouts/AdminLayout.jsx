import { Outlet } from 'react-router-dom'
import Sidebar from './components/Sidebar'
import Header from './components/Header'

// 後台外殼：Sidebar + Header + 內容區的 <Outlet />。
// 對應第 08 章「共用 Layout + 巢狀路由」：所有受保護頁面共用這一層。
function AdminLayout() {
  return (
    <div className="admin-shell">
      <Sidebar />
      <div className="admin-main">
        <Header />
        <main className="admin-content">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

export default AdminLayout
