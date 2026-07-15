import { useMutation, useQueryClient } from '@tanstack/react-query'
import { courseApi } from '@/services/api/course.api'
import { courseKeys } from '@/hooks/useCoursesQuery'

// 課程「寫入」相關的 Mutation hooks（對應第 10 章）。
// 重點示範：樂觀更新（先改畫面）+ 失敗回滾（onError 還原）+ onSettled 重新同步。
//
// listFilters 是目前列表頁的篩選條件，用來精準更新「當前這一頁」的快取。
export function useCourseMutations(listFilters) {
  const queryClient = useQueryClient()
  const listKey = courseKeys.list(listFilters)

  // 共用：取消進行中的查詢並快照，回傳可回滾的 context
  async function snapshotList() {
    await queryClient.cancelQueries({ queryKey: listKey })
    return { previousList: queryClient.getQueryData(listKey) }
  }

  // 新增課程（樂觀更新）
  const createCourse = useMutation({
    mutationFn: (payload) => courseApi.create(payload),
    onMutate: async (payload) => {
      const context = await snapshotList()
      queryClient.setQueryData(listKey, (old) => {
        if (!old) return old
        const optimistic = {
          id: `temp-${Date.now()}`,
          title: payload.title,
          level: payload.level,
          category: payload.category || '前端',
          minutes: Number(payload.minutes) || 30,
          students: 0,
          rating: 0,
          published: false,
          description: payload.description || '',
          updatedAt: Date.now(),
          _optimistic: true,
        }
        return {
          ...old,
          items: [optimistic, ...old.items],
          total: old.total + 1,
        }
      })
      return context
    },
    onError: (_error, _payload, context) => {
      if (context?.previousList) {
        queryClient.setQueryData(listKey, context.previousList)
      }
    },
    onSettled: () => {
      // 與伺服器重新對齊：整組 courses 查詢都失效重抓
      queryClient.invalidateQueries({ queryKey: courseKeys.all })
    },
  })

  // 更新課程（例如切換上架、編輯欄位）——同樣做樂觀更新
  const updateCourse = useMutation({
    mutationFn: ({ id, patch }) => courseApi.update(id, patch),
    onMutate: async ({ id, patch }) => {
      const context = await snapshotList()
      queryClient.setQueryData(listKey, (old) => {
        if (!old) return old
        return {
          ...old,
          items: old.items.map((c) =>
            c.id === id ? { ...c, ...patch } : c
          ),
        }
      })
      // 若詳情頁快取存在也一併更新
      queryClient.setQueryData(courseKeys.detail(id), (old) =>
        old ? { ...old, ...patch } : old
      )
      return context
    },
    onError: (_error, _vars, context) => {
      if (context?.previousList) {
        queryClient.setQueryData(listKey, context.previousList)
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: courseKeys.all })
    },
  })

  // 刪除課程（樂觀移除）
  const deleteCourse = useMutation({
    mutationFn: (id) => courseApi.remove(id),
    onMutate: async (id) => {
      const context = await snapshotList()
      queryClient.setQueryData(listKey, (old) => {
        if (!old) return old
        return {
          ...old,
          items: old.items.filter((c) => c.id !== id),
          total: Math.max(0, old.total - 1),
        }
      })
      return context
    },
    onError: (_error, _id, context) => {
      if (context?.previousList) {
        queryClient.setQueryData(listKey, context.previousList)
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: courseKeys.all })
    },
  })

  return { createCourse, updateCourse, deleteCourse }
}
