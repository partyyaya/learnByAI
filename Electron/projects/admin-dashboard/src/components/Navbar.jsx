import { useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { findTrail } from "../navigation";
import { Marquee } from "./Marquee";
import { UserMenu } from "./UserMenu";
import { IconLogout, IconSidebar } from "./icons";

export function Navbar({ collapsed, onToggleSidebar }) {
  const { pathname } = useLocation();
  const { logout } = useAuth();
  // 子頁會回 [群組, 頁面]：標題前面補一層「系統設定 ／」，不然三個設定子頁的
  // 標題單獨看很像在講同一件事
  const trail = findTrail(pathname);
  const page = trail.at(-1);
  const group = trail.length > 1 ? trail[0] : null;

  return (
    <header className="navbar">
      <div className="navbar__left">
        <button
          type="button"
          className="icon-btn"
          onClick={onToggleSidebar}
          aria-label={collapsed ? "展開側邊欄" : "收起側邊欄"}
          title={collapsed ? "展開側邊欄" : "收起側邊欄"}
        >
          <IconSidebar size={18} />
        </button>
        <div className="navbar__title">
          <h1>
            {group ? <span className="navbar__crumb">{group.label} ／</span> : null}
            {page.label}
          </h1>
          <p>{page.description}</p>
        </div>
      </div>

      {/* 跑馬燈放中間，左右都用 flex 撐開，視窗變窄時第一個被壓縮的是它 */}
      <Marquee />

      <div className="navbar__right">
        <UserMenu />
        <button type="button" className="btn btn--ghost btn--compact" onClick={logout}>
          <IconLogout size={16} />
          登出
        </button>
      </div>
    </header>
  );
}
