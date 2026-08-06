import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "admin.theme";
const THEMES = ["dark", "light"];

/**
 * 讀出存起來的主題。這個函式在模組載入時（React render 之前）就被呼叫，
 * 所以第一次繪製用的就是正確的顏色，不會先閃一下深色再變淺色。
 *
 * 這裡把偏好存在 renderer 的 localStorage，而不是像 notepad-app 那樣寫到
 * main process 的 userData：主題純粹是 UI 偏好，讀不到就退回預設值，沒必要
 * 為它多開一條 IPC。代價是 BrowserWindow 的 backgroundColor 只能寫死一個值
 * （main.js 裡是深色的 #0d1117），淺色主題下開場那一瞬間會偏暗。
 */
function readStoredTheme() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (THEMES.includes(stored)) return stored;
  } catch {
    // 隱私模式之類讀不到 localStorage 的情況：當作沒設定過
  }
  return "dark";
}

const initialTheme = readStoredTheme();
document.documentElement.dataset.theme = initialTheme;

const ThemeContext = createContext(null);

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(initialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    // 標題列那一條是頁面自己畫的（<Titlebar />），跟著 CSS 變數換色就好；
    // 但 Windows / Linux 上的系統控制鈕是原生的，得請 main 換（見 electron/main.js）。
    // 在瀏覽器裡跑（沒有 preload）時 appWindow 是 undefined，所以用 ?.
    window.appWindow?.setTitleBarTheme(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // 存不起來就只是這次有效，不影響功能
    }
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((current) => (current === "dark" ? "light" : "dark"));
  }, []);

  const value = useMemo(() => ({ theme, setTheme, toggleTheme }), [theme, toggleTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme 必須放在 <ThemeProvider> 裡面");
  return context;
}
