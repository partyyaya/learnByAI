import http from '@/services/http'

export const userApi = {
  // filters = { search, role, page, pageSize }
  list(filters) {
    return http.get('/users', { params: filters })
  },
}
