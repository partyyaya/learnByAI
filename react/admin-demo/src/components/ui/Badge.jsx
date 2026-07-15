// 狀態徽章。tone 對應色系（見 styles/components.css）。
function Badge({ tone = 'gray', children }) {
  return <span className={`badge badge--${tone}`}>{children}</span>
}

export default Badge
