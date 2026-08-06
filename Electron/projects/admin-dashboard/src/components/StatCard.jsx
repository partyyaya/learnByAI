import { formatCurrency, formatNumber } from "../utils/format";

/**
 * KPI 卡。一個數字就是全部重點，所以不畫圖——一根長條的長條圖不如直接把數字放大。
 *
 * 漲跌用顏色 + 箭頭 + 百分比三重表示。只靠紅綠的話，紅綠色盲的使用者看不出
 * 差別（這兩個顏色在色盲模擬下的距離非常近），箭頭與數字才是真正傳達訊息的部分。
 */
export function StatCard({ label, value, hint, delta, format }) {
  const rising = (delta ?? 0) >= 0;

  return (
    <article className="stat-card">
      <p className="stat-card__label">{label}</p>
      <p className="stat-card__value">
        {format === "currency" ? formatCurrency(value) : formatNumber(value)}
      </p>
      <p className="stat-card__foot">
        {delta === undefined || delta === null ? null : (
          <span className={`delta delta--${rising ? "up" : "down"}`}>
            <span aria-hidden="true">{rising ? "▲" : "▼"}</span>
            {Math.abs(delta)}%
            <span className="sr-only">{rising ? "較前一日成長" : "較前一日下降"}</span>
          </span>
        )}
        <span className="stat-card__hint">{hint}</span>
      </p>
    </article>
  );
}
