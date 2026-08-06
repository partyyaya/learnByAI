import { useTheme } from "../context/ThemeContext";
import { IconCheck, IconMoon, IconSun } from "../components/icons";

const THEME_OPTIONS = [
  { value: "dark", label: "深色", icon: IconMoon },
  { value: "light", label: "淺色", icon: IconSun }
];

/**
 * 系統設定的第一個子頁：介面外觀。
 *
 * 原本「介面外觀 / 模擬後端參數 / 連線測試」三張卡都疊在同一頁，拆成三個子頁之後
 * 側邊欄的群組才有東西可以展開，而且三件事的性質本來就不同：主題是個人偏好、
 * 模擬參數會影響所有 API、連線測試是拿來按的工具。
 */
export function SettingsPage() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="page page--narrow">
      <section className="card">
        <header className="card__head">
          <div>
            <h2 className="card__title">介面外觀</h2>
            <p className="card__subtitle">存在這台電腦的 localStorage，只影響目前的使用者</p>
          </div>
        </header>

        <div className="theme-picker">
          {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              className={`theme-option${theme === value ? " is-active" : ""}`}
              onClick={() => setTheme(value)}
              aria-pressed={theme === value}
            >
              <Icon size={18} />
              {label}
              {theme === value ? <IconCheck size={15} /> : null}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
