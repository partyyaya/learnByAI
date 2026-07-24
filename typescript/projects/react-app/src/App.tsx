import { BrowserRouter, Route, Routes } from 'react-router-dom'
import NavBar from '@/components/NavBar'
import HomeView from '@/views/HomeView'
import UsersView from '@/views/UsersView'
import UserDetailView from '@/views/UserDetailView'
import NotFoundView from '@/views/NotFoundView'
import '@/App.css'

export default function App() {
  return (
    <BrowserRouter>
      <NavBar />
      <main className="container">
        <Routes>
          <Route path="/" element={<HomeView />} />
          <Route path="/users" element={<UsersView />} />
          <Route path="/users/:id" element={<UserDetailView />} />
          {/* 萬用路由：放在最後，其他路由都比對不到時才會落到這裡 */}
          <Route path="*" element={<NotFoundView />} />
        </Routes>
      </main>
    </BrowserRouter>
  )
}
