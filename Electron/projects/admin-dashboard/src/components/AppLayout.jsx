import { useState } from "react";
import { Outlet } from "react-router-dom";
import { Navbar } from "./Navbar";
import { Sidebar } from "./Sidebar";

/**
 * 登入之後的外框：左邊側邊欄、上面導航欄、右下角是內容。
 *
 * 側邊欄的寬度寫在 CSS 變數 --sidebar-width 上，收起來時改成 --sidebar-width-collapsed，
 * 所以 grid 的欄寬與過場動畫都由 CSS 處理，JS 只負責翻一個布林值。
 *
 * <Outlet /> 是 react-router 的插槽，子路由的頁面會畫在這裡（見 App.jsx）。
 */
export function AppLayout() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className={`app-shell${collapsed ? " is-collapsed" : ""}`}>
      {/* onExpand：側邊欄收起來時點到有子選單的群組，要先把側邊欄展開才有地方畫 */}
      <Sidebar collapsed={collapsed} onExpand={() => setCollapsed(false)} />
      <div className="app-body">
        <Navbar collapsed={collapsed} onToggleSidebar={() => setCollapsed((value) => !value)} />
        <main className="app-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
