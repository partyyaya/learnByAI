import http from '@/services/http'

export const dashboardApi = {
  summary() {
    return http.get('/dashboard/summary')
  },
}
