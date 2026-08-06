import { describe } from "../utils/format";

/**
 * 狀態標籤。tone 只決定顏色，文字一律從字典（utils/format.js）來，
 * 所以後端多一個狀態值時只要改字典，不用翻遍每個頁面。
 */
export function StatusBadge({ dictionary, value }) {
  const { label, tone } = describe(dictionary, value);
  return <span className={`badge badge--${tone}`}>{label}</span>;
}
