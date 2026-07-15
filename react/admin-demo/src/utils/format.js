// 純函式工具：格式化與小工具。刻意保持無副作用，方便測試與重用。

/** 難度 → 中文標籤 */
export const LEVEL_LABELS = {
  beginner: '入門',
  intermediate: '中階',
  advanced: '進階',
}

/** 難度 → 對應徽章色系（給 Badge 元件用） */
export const LEVEL_TONES = {
  beginner: 'green',
  intermediate: 'blue',
  advanced: 'purple',
}

/** 把 ISO 字串或 timestamp 格式化為 YYYY-MM-DD */
export function formatDate(value) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 千分位數字，例如 12345 → 12,345 */
export function formatNumber(value) {
  const n = Number(value)
  if (Number.isNaN(n)) return '0'
  return n.toLocaleString('en-US')
}

/** 產生名稱縮寫（頭像用），取第一個字 */
export function initials(name = '') {
  return String(name).trim().slice(0, 1).toUpperCase() || '?'
}
