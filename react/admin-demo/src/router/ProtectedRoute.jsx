import { Navigate, useLocation } from 'react-router-dom'
import { useAuthStore, selectIsAuthenticated } from '@/stores/auth.store'

// 路由守衛（對應第 08 章的實務延伸）：
// - 未登入 → 導向 /login，並用 state.from 記住原本要去的頁，登入後可回訪。
// - 已登入但角色不符 → 導向 /403（沒有權限）。
function ProtectedRoute({ children, roles }) {
  const isAuthenticated = useAuthStore(selectIsAuthenticated)
  const role = useAuthStore((state) => state.user?.role)
  const location = useLocation()

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />
  }

  if (roles && !roles.includes(role)) {
    return <Navigate to="/403" replace />
  }

  return children
}

export default ProtectedRoute
