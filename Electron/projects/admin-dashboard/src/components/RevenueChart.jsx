import { useState } from "react";
import { formatCompact, formatCurrency, formatNumber } from "../utils/format";

/**
 * 每日營收長條圖。只有一組數列，所以只用一個顏色（--chart-series），
 * 不做「愈高愈深」的漸層——那會把「長度」重複編碼成「顏色」，白白浪費一個
 * 可以拿來表達其他資訊的通道，而且深淺不一的一排藍色其實更難比較。
 *
 * 三個刻意做的事：
 *
 * - **只標最高的那一根**：每根都標數字會變成一片雜訊，其他的值交給 hover 與表格。
 * - **hover 與 focus 顯示同一個提示**：長條是 <button>，所以鍵盤 Tab 也能讀到值，
 *   而不是只有滑鼠使用者看得到。
 * - **提供「表格」檢視**：圖表不該是取得數字的唯一途徑。切到表格就是同一份資料的
 *   無障礙版本（也方便複製貼上）。
 */
export function RevenueChart({ series }) {
  const [view, setView] = useState("chart");
  const [activeIndex, setActiveIndex] = useState(null);

  const max = Math.max(...series.map((point) => point.revenue));
  const peakIndex = series.reduce(
    (best, point, index) => (point.revenue > series[best].revenue ? index : best),
    0
  );

  return (
    <section className="card card--chart">
      <header className="card__head">
        <div>
          <h2 className="card__title">每日營收</h2>
          <p className="card__subtitle">最近 14 天，含所有通路</p>
        </div>
        <div className="segmented" role="tablist" aria-label="檢視方式">
          {[
            ["chart", "圖表"],
            ["table", "表格"]
          ].map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={view === key}
              className={`segmented__btn${view === key ? " is-active" : ""}`}
              onClick={() => setView(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      {view === "chart" ? (
        <div className="chart">
          {/* 格線用最淡的一階顏色畫，只是輔助讀值，不該比資料還顯眼 */}
          <div className="chart__grid" aria-hidden="true">
            {[1, 0.5, 0].map((ratio) => (
              <div className="chart__grid-line" key={ratio}>
                <span className="chart__tick">{formatCompact(max * ratio)}</span>
              </div>
            ))}
          </div>

          <div className="chart__plot">
            {series.map((point, index) => (
              <div className="chart__col" key={point.date}>
                <button
                  type="button"
                  className={`chart__bar${activeIndex === index ? " is-active" : ""}`}
                  style={{ height: `${Math.max(2, (point.revenue / max) * 100)}%` }}
                  onMouseEnter={() => setActiveIndex(index)}
                  onMouseLeave={() => setActiveIndex(null)}
                  onFocus={() => setActiveIndex(index)}
                  onBlur={() => setActiveIndex(null)}
                >
                  <span className="sr-only">
                    {point.date}：{formatCurrency(point.revenue)}，{point.orders} 筆訂單
                  </span>

                  {/* 標籤與提示都放在長條「裡面」，用 bottom:100% 貼在長條頂端。
                      這樣就不必把長條的高度百分比再算一次給它們定位。 */}
                  {index === peakIndex && activeIndex !== index ? (
                    <span className="chart__peak">{formatCompact(point.revenue)}</span>
                  ) : null}

                  {activeIndex === index ? (
                    <span className="chart__tip">
                      <strong>{formatCurrency(point.revenue)}</strong>
                      {point.date}｜{point.orders} 筆
                    </span>
                  ) : null}
                </button>

                <span className="chart__label">{point.date.slice(5).replace("-", "/")}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="table-wrap table-wrap--plain">
          <table className="table table--compact">
            <thead>
              <tr>
                <th scope="col">日期</th>
                <th scope="col" style={{ textAlign: "right" }}>
                  營收
                </th>
                <th scope="col" style={{ textAlign: "right" }}>
                  訂單數
                </th>
              </tr>
            </thead>
            <tbody>
              {[...series].reverse().map((point) => (
                <tr key={point.date}>
                  <td>{point.date.replaceAll("-", "/")}</td>
                  <td style={{ textAlign: "right" }}>{formatCurrency(point.revenue)}</td>
                  <td style={{ textAlign: "right" }}>{formatNumber(point.orders)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
