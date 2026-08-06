import { useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import { StatusBadge } from "./StatusBadge";
import { USER_ROLE } from "../utils/format";
import { IconChevronDown, IconMoon, IconSettings, IconSun, IconUser } from "./icons";

/** 沒有頭像圖檔，用姓名的第一個字當頭像——中文名字這樣做比縮寫好認 */
function Avatar({ name }) {
  return <span className="avatar">{name?.slice(0, 1) ?? "?"}</span>;
}

export function UserMenu() {
  const { user } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();

  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const menuId = useId();

  // 點外面關閉、按 Esc 關閉。兩個事件都掛在 document 上，而且只在打開時掛，
  // 關著的時候不留任何監聽器。
  useEffect(() => {
    if (!open) return undefined;

    // 用 pointerdown 而不是 click：click 要等按鍵放開才觸發，
    // 拖曳選字之類的操作會讓選單延遲關閉，感覺很鈍。
    const handlePointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const handleKeyDown = (event) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const go = (path) => {
    setOpen(false);
    navigate(path);
  };

  return (
    <div className="user-menu" ref={rootRef}>
      <button
        type="button"
        className={`user-menu__trigger${open ? " is-open" : ""}`}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={menuId}
      >
        <Avatar name={user?.name} />
        <span className="user-menu__identity">
          <span className="user-menu__name">{user?.name}</span>
          <span className="user-menu__title">{user?.title}</span>
        </span>
        <IconChevronDown size={16} className="user-menu__caret" />
      </button>

      {open ? (
        <div className="user-menu__panel" id={menuId} role="menu">
          <div className="user-menu__header">
            <Avatar name={user?.name} />
            <div>
              <p className="user-menu__name">{user?.name}</p>
              <p className="user-menu__email">{user?.email}</p>
              <p className="user-menu__meta">
                <StatusBadge dictionary={USER_ROLE} value={user?.role} />
                <span>{user?.department}</span>
              </p>
            </div>
          </div>

          <div className="user-menu__items">
            <button type="button" role="menuitem" className="user-menu__item" onClick={() => go("/profile")}>
              <IconUser size={16} />
              個人資料
            </button>
            {/*
              「系統設定」在側邊欄是群組（沒有自己的頁面），所以這裡導到它的第一個
              子項 /settings（介面外觀）——從選單進去的人要的就是「先到那一區」，
              到了之後左邊子選單會自動展開，其他兩個子頁一眼就看得到。
            */}
            <button type="button" role="menuitem" className="user-menu__item" onClick={() => go("/settings")}>
              <IconSettings size={16} />
              系統設定
            </button>
            <button type="button" role="menuitem" className="user-menu__item" onClick={toggleTheme}>
              {theme === "dark" ? <IconSun size={16} /> : <IconMoon size={16} />}
              切換為{theme === "dark" ? "淺色" : "深色"}主題
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
