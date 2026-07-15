import http from '@/services/http'

// 課程 domain 的 API。每個函式對應一支後端端點，
// 由 hooks/ 內的 Query / Mutation 呼叫，頁面不直接使用。
export const courseApi = {
  // 分頁列表；filters = { search, level, sort, page, pageSize }
  list(filters) {
    return http.get('/courses', { params: filters })
  },
  // 無限捲動用的分頁
  listInfinite(page) {
    return http.get('/courses/infinite', { params: { page } })
  },
  // 單筆詳情
  detail(id) {
    return http.get(`/courses/${id}`)
  },
  // 新增
  create(payload) {
    return http.post('/courses', payload)
  },
  // 部分更新（例如切換上架、編輯欄位）
  update(id, patch) {
    return http.patch(`/courses/${id}`, patch)
  },
  // 刪除
  remove(id) {
    return http.delete(`/courses/${id}`)
  },
}
