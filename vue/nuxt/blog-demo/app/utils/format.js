// 放在 app/utils/ 的函式會被自動匯入（第 4 章），元件裡不用 import 就能用。
// 這種「輸入什麼就回傳什麼、不碰外部狀態」的純函式最好測——不用掛元件、不用 mock（第 15 章）。

/** 取內容摘要：超過 max 個字就截斷並補刪節號 */
export function excerpt(text, max = 60) {
  const content = text ?? ''
  return content.length > max ? content.slice(0, max) + '…' : content
}

/** 把日期（Date 物件或 ISO 字串）格式化成台灣慣用的年月日 */
export function formatDate(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString('zh-TW')
}

/** 顯示用的作者名稱：沒有作者（例如 seed 的示範文章）就掛站長 */
export function authorName(post) {
  return post?.author?.name || '站長'
}
