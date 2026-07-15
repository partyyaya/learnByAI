import { useQuery } from '@tanstack/react-query'
import { dashboardApi } from '@/services/api/dashboard.api'

// 儀表板統計查詢（對應第 09 章：useQuery 取代手寫 loading/error 樣板）。
export function useDashboardQuery() {
  return useQuery({
    queryKey: ['dashboard', 'summary'],
    queryFn: () => dashboardApi.summary(),
    staleTime: 60_000,
  })
}
