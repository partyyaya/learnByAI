import {
  useQuery,
  useInfiniteQuery,
  keepPreviousData,
} from '@tanstack/react-query'
import { courseApi } from '@/services/api/course.api'

// 課程「讀取」相關的 Query hooks（對應第 09、10、12 章）。
// 集中管理 queryKey，避免各頁面各寫一份、日後 invalidate 對不上。

// queryKey 工廠：把課程相關的 key 收在一起，方便 mutation 端 invalidate。
export const courseKeys = {
  all: ['courses'],
  list: (filters) => ['courses', 'list', filters],
  infinite: ['courses', 'infinite'],
  detail: (id) => ['courses', 'detail', Number(id)],
}

// 分頁列表：filters 來自 Zustand（search / level / sort / page）。
// filters 進 queryKey，條件一變就自動抓新資料，這就是第 12 章的整合重點。
export function useCoursesQuery(filters) {
  return useQuery({
    queryKey: courseKeys.list(filters),
    queryFn: () => courseApi.list(filters),
    // 換頁時保留上一頁資料，避免畫面閃爍（比 isLoading 全屏更順）
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  })
}

// 單筆課程詳情：對應第 08 章的動態路由頁
export function useCourseDetailQuery(id) {
  return useQuery({
    queryKey: courseKeys.detail(id),
    queryFn: () => courseApi.detail(id),
    enabled: Boolean(id),
  })
}

// 無限捲動列表：對應第 10 章 useInfiniteQuery
export function useCoursesInfiniteQuery() {
  return useInfiniteQuery({
    queryKey: courseKeys.infinite,
    queryFn: ({ pageParam }) => courseApi.listInfinite(pageParam),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => lastPage.nextPage,
  })
}
