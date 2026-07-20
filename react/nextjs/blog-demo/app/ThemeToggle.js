"use client";
// 亮/暗主題切換（Client Component，因為要用 localStorage 與 onClick）
import { useEffect, useState } from "react";

export default function ThemeToggle() {
  const [theme, setTheme] = useState("light");

  useEffect(() => {
    const saved = localStorage.getItem("theme") || "light";
    setTheme(saved);
    document.documentElement.dataset.theme = saved;
  }, []);

  function toggle() {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    localStorage.setItem("theme", next);
  }

  return (
    <button className="theme-toggle" onClick={toggle} aria-label="切換主題">
      {theme === "light" ? "🌙" : "☀️"}
    </button>
  );
}
