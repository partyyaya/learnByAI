import { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { NAV_ITEMS, findPage } from "../navigation";
import { IconChevronDown } from "./icons";

export function Sidebar({ collapsed, onExpand }) {
  const { pathname } = useLocation();
  // 目前這一頁屬於哪一個群組（頂層頁面是 null）
  const activeGroupKey = findPage(pathname).parent?.key ?? null;

  // 哪些群組是展開的。用 Set 而不是「一次只能開一個」的手風琴：後台的人常常在
  // 兩個群組之間來回，每次都被自動收起來很煩。
  const [openKeys, setOpenKeys] = useState(() => new Set(activeGroupKey ? [activeGroupKey] : []));

  // 換頁時把「目前這一頁所在的群組」打開——直接輸入網址、或從別的地方跳進子頁時，
  // 選單不能還是收著的。這裡只加不減，所以使用者手動展開的那些會留著。
  useEffect(() => {
    if (!activeGroupKey) return;
    setOpenKeys((prev) => (prev.has(activeGroupKey) ? prev : new Set(prev).add(activeGroupKey)));
  }, [activeGroupKey]);

  function toggleGroup(key) {
    // 側邊欄收起來的時候只剩 68px，沒有地方畫子選單（.sidebar 是 overflow: hidden，
    // 硬塞會被切掉）。所以收起狀態下點群組是「先把側邊欄展開」，不是切換。
    if (collapsed) {
      onExpand();
      setOpenKeys((prev) => new Set(prev).add(key));
      return;
    }

    setOpenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <aside className="sidebar" aria-label="主要選單">
      <div className="sidebar__brand">
        <span className="sidebar__logo">LB</span>
        <span className="sidebar__brand-text">
          <strong>LearnByAI</strong>
          <small>後台管理系統</small>
        </span>
      </div>

      {/* 選單比視窗高的時候要自己捲，不然會把下面的版號擠掉 */}
      <nav className="sidebar__nav">
        {NAV_ITEMS.map((item) => {
          const { icon: Icon, label } = item;

          // 沒有 children 就是單純一個連結。NavLink 會自己判斷 active 並加上
          // class，不必自己比對 pathname。
          if (!item.children) {
            return (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) => `sidebar__link${isActive ? " is-active" : ""}`}
                title={collapsed ? label : undefined}
              >
                <span className="sidebar__icon">
                  <Icon size={19} />
                </span>
                <span className="sidebar__label">{label}</span>
              </NavLink>
            );
          }

          // 收起來的時候一律當成沒展開（子選單畫不出來），但 openKeys 裡的紀錄留著，
          // 展開側邊欄之後還是回到原本開著的那幾個。
          const open = !collapsed && openKeys.has(item.key);
          const isActiveGroup = activeGroupKey === item.key;

          return (
            <div key={item.key} className={`sidebar__group${open ? " is-open" : ""}`}>
              <button
                type="button"
                className={`sidebar__link sidebar__group-btn${isActiveGroup ? " is-active-group" : ""}`}
                onClick={() => toggleGroup(item.key)}
                aria-expanded={open}
                aria-controls={`sidebar-sub-${item.key}`}
                title={collapsed ? label : undefined}
              >
                <span className="sidebar__icon">
                  <Icon size={19} />
                </span>
                <span className="sidebar__label">{label}</span>
                <span className="sidebar__caret" aria-hidden="true">
                  <IconChevronDown size={15} />
                </span>
              </button>

              {/*
                收起來的子選單用 inert 而不是 display: none：display 不能過場動畫，
                但單純把高度收成 0 又會留下「看不見卻還能用 Tab 選到」的連結。
                inert 一次解決兩件事——收起來時整塊不吃鍵盤與滑鼠。
              */}
              <div className="sidebar__sub" id={`sidebar-sub-${item.key}`} inert={!open}>
                <div className="sidebar__sub-inner">
                  {item.children.map((child) => (
                    // end 是必要的：/users 是 /users/roles 的前綴，沒有 end 的話
                    // 在「角色與權限」頁時兩個子項會同時亮起來。
                    <NavLink
                      key={child.to}
                      to={child.to}
                      end
                      className={({ isActive }) => `sidebar__sub-link${isActive ? " is-active" : ""}`}
                    >
                      {child.label}
                    </NavLink>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </nav>

      <div className="sidebar__footer">
        <span className="sidebar__dot" />
        <span className="sidebar__footer-text">
          模擬後端 v{window.appInfo?.version ?? "0.0.0"}
          {window.appInfo?.isDev ? "（開發模式）" : ""}
        </span>
      </div>
    </aside>
  );
}
