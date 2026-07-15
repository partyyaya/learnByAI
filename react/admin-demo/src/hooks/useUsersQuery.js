import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { userApi } from '@/services/api/user.api'

export const userKeys = {
  all: ['users'],
  list: (filters) => ['users', 'list', filters],
}

// 使用者列表查詢。filters = { search, role, page, pageSize }
export function useUsersQuery(filters) {
  return useQuery({
    queryKey: userKeys.list(filters),
    queryFn: () => userApi.list(filters),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  })
}
