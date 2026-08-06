import { api } from "../api/client";
import { useApi } from "../hooks/useApi";
import { RevenueChart } from "../components/RevenueChart";
import { StatCard } from "../components/StatCard";
import { ErrorState } from "../components/StateBlock";
import { IconCheck, IconOrders, IconSettings, IconUser } from "../components/icons";
import { ORDER_STATUS, describe, formatNumber, formatRelative } from "../utils/format";

const ACTIVITY_ICONS = {
  user: IconUser,
  order: IconOrders,
  login: IconCheck,
  setting: IconSettings,
  refund: IconOrders
};

/** 訂單狀態分布。橫向長條，每一列都有文字標籤與數字，顏色不負責傳達身分 */
function StatusBreakdown({ items }) {
  const max = Math.max(...items.map((item) => item.count));
  const total = items.reduce((sum, item) => sum + item.count, 0);

  return (
    <section className="card">
      <header className="card__head">
        <div>
          <h2 className="card__title">訂單狀態分布</h2>
          <p className="card__subtitle">共 {formatNumber(total)} 筆訂單</p>
        </div>
      </header>

      <ul className="breakdown">
        {items.map((item) => (
          <li className="breakdown__row" key={item.status}>
            <span className="breakdown__label">{describe(ORDER_STATUS, item.status).label}</span>
            <span className="breakdown__track">
              <span className="breakdown__fill" style={{ width: `${(item.count / max) * 100}%` }} />
            </span>
            <span className="breakdown__value">{formatNumber(item.count)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ActivityFeed({ items }) {
  return (
    <section className="card">
      <header className="card__head">
        <div>
          <h2 className="card__title">最近動態</h2>
          <p className="card__subtitle">系統操作紀錄</p>
        </div>
      </header>

      <ul className="feed">
        {items.map((item) => {
          const Icon = ACTIVITY_ICONS[item.type] ?? IconCheck;
          return (
            <li className="feed__item" key={item.id}>
              <span className={`feed__icon feed__icon--${item.type}`}>
                <Icon size={15} />
              </span>
              <span className="feed__text">{item.text}</span>
              {/* <time> 的 dateTime 放完整 ISO，畫面上只顯示相對時間 */}
              <time className="feed__time" dateTime={item.at}>
                {formatRelative(item.at)}
              </time>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** 載入中的骨架。版面配置跟真的內容一樣，資料回來時不會整頁跳動 */
function DashboardSkeleton() {
  return (
    <div className="dashboard">
      <div className="dashboard__kpis">
        {[0, 1, 2, 3].map((index) => (
          <article className="stat-card" key={index}>
            <span className="skeleton" style={{ width: "40%" }} />
            <span className="skeleton skeleton--lg" style={{ width: "70%" }} />
            <span className="skeleton" style={{ width: "55%" }} />
          </article>
        ))}
      </div>
      <div className="dashboard__grid">
        <div className="card card--chart">
          <span className="skeleton skeleton--block" />
        </div>
        <div className="card">
          <span className="skeleton skeleton--block" />
        </div>
      </div>
    </div>
  );
}

export function DashboardPage() {
  const { data, loading, error, reload } = useApi(() => api.get("/dashboard/summary"), []);

  if (loading && !data) return <DashboardSkeleton />;
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;

  return (
    <div className={`dashboard${loading ? " is-refreshing" : ""}`}>
      <div className="dashboard__kpis">
        {/* key 要先從物件裡拆出來再展開。連著 {...kpi} 一起丟進去的話，
            React 會警告「key 不該用 spread 傳」——因為它分不清那是 React 的
            key 還是元件真正想收的 prop。 */}
        {data.kpis.map(({ key, ...kpi }) => (
          <StatCard key={key} {...kpi} />
        ))}
      </div>

      <div className="dashboard__grid">
        <RevenueChart series={data.revenueSeries} />
        <StatusBreakdown items={data.orderStatus} />
      </div>

      <ActivityFeed items={data.activities} />
    </div>
  );
}
