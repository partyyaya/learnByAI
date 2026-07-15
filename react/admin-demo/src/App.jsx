import { useEffect } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import AdminLayout from '@/layouts/AdminLayout'
import ProtectedRoute from '@/router/ProtectedRoute'
import { useUiStore } from '@/stores/ui.store'

import LoginPage from '@/pages/LoginPage'
import DashboardPage from '@/pages/DashboardPage'
import CourseListPage from '@/pages/courses/CourseListPage'
import CourseFeedPage from '@/pages/courses/CourseFeedPage'
import CourseDetailPage from '@/pages/courses/CourseDetailPage'
import UserListPage from '@/pages/users/UserListPage'
import EffectsLabPage from '@/pages/EffectsLabPage'
import PerformanceLabPage from '@/pages/PerformanceLabPage'
import SettingsPage from '@/pages/SettingsPage'
import ForbiddenPage from '@/pages/ForbiddenPage'
import NotFoundPage from '@/pages/NotFoundPage'

// 應用路由樹（第 08 章）：
// - /login 為公開頁。
// - 其餘掛在 AdminLayout 之下，需登入（ProtectedRoute）。
// - /users 額外要求 admin 角色。
// - 巢狀 * 捕捉未知路徑，顯示殼內 404。
function App() {
  // 把 Zustand 的 theme 同步到 <html data-theme>，讓全域 CSS 變數切換亮/暗。
  // 這是「UI 狀態 → 真實 DOM」的副作用，屬於第 07 章 useEffect 的典型用途。
  const theme = useUiStore((state) => state.theme)
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route
        path="/"
        element={
          <ProtectedRoute>
            <AdminLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="courses" element={<CourseListPage />} />
        <Route path="courses/feed" element={<CourseFeedPage />} />
        <Route path="courses/:courseId" element={<CourseDetailPage />} />
        <Route
          path="users"
          element={
            <ProtectedRoute roles={['admin']}>
              <UserListPage />
            </ProtectedRoute>
          }
        />
        <Route path="labs/effects" element={<EffectsLabPage />} />
        <Route path="labs/performance" element={<PerformanceLabPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="403" element={<ForbiddenPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}

export default App
