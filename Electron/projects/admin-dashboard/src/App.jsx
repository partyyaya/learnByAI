import { HashRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { ThemeProvider } from "./context/ThemeContext";
import { ToastProvider } from "./context/ToastContext";
import { AppLayout } from "./components/AppLayout";
import { Titlebar } from "./components/Titlebar";
import { DashboardPage } from "./pages/DashboardPage";
import { LoginPage } from "./pages/LoginPage";
import { MockConfigPage } from "./pages/MockConfigPage";
import { OrdersPage } from "./pages/OrdersPage";
import { ProbePage } from "./pages/ProbePage";
import { ProfilePage } from "./pages/ProfilePage";
import { RolesPage } from "./pages/RolesPage";
import { SettingsPage } from "./pages/SettingsPage";
import { UsersPage } from "./pages/UsersPage";

/**
 * 沒登入就一律導到登入頁，並把「原本想去哪裡」記在 location.state 裡，
 * 登入成功後才能回到那一頁（見 LoginPage 的 <Navigate>）。
 *
 * 這一層同時也是「401 自動登出」的出口：任何 API 回 401 時 AuthProvider 會把
 * user 清成 null，React 重新 render，這裡就把人送回登入頁——不需要在每個頁面
 * 各寫一次判斷。
 */
function RequireAuth({ children }) {
  const { isAuthenticated } = useAuth();
  const location = useLocation();

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return children;
}

export function App() {
  return (
    // 順序有意義：ToastProvider 要在 AuthProvider 外面，因為 AuthProvider 會用
    // useToast() 告知「登入已逾期」。ThemeProvider 最外層，它只碰 <html> 的屬性。
    <ThemeProvider>
      <ToastProvider>
        <AuthProvider>
          {/*
            app-frame 只有兩列：自己畫的標題列，以及底下的頁面。標題列放在路由外面，
            登入頁與後台都要有它——原生標題列已經藏起來了，少一頁就少一條可拖曳的邊。
          */}
          <div className="app-frame">
            <Titlebar />

            {/*
              用 HashRouter 而不是 BrowserRouter。打包後頁面是用 file:// 載入的，
              BrowserRouter 靠 history.pushState 產生 /users 這種路徑，重新載入時
              瀏覽器會真的去磁碟找那個檔案，直接 404。HashRouter 把路徑放在 # 後面
              （file:///…/index.html#/users），不會影響檔案請求。
            */}
            <HashRouter>
              <Routes>
                <Route path="/login" element={<LoginPage />} />

                <Route
                  path="/"
                  element={
                    <RequireAuth>
                      <AppLayout />
                    </RequireAuth>
                  }
                >
                  <Route index element={<Navigate to="/dashboard" replace />} />
                  <Route path="dashboard" element={<DashboardPage />} />

                  {/*
                    側邊欄有子選單的兩組，路由就是「多一層路徑」。這裡刻意攤平成
                    一條一條寫，而不是用巢狀 <Route> ——巢狀要多一個帶
                    <Outlet /> 的中間層元件，而群組本身並不是一個頁面。
                    路徑與選單的對應關係在 navigation.js。
                  */}
                  <Route path="users" element={<UsersPage />} />
                  <Route path="users/roles" element={<RolesPage />} />

                  <Route path="orders" element={<OrdersPage />} />

                  <Route path="settings" element={<SettingsPage />} />
                  <Route path="settings/mock" element={<MockConfigPage />} />
                  <Route path="settings/probe" element={<ProbePage />} />

                  <Route path="profile" element={<ProfilePage />} />
                </Route>

                {/* 打錯的路徑就回儀表板，不要留一個空白畫面 */}
                <Route path="*" element={<Navigate to="/dashboard" replace />} />
              </Routes>
            </HashRouter>
          </div>
        </AuthProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
