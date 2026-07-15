import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// UI 偏好與跨元件共用的本地狀態。全部 persist，重整後保留使用者偏好。
// 對應課程第 11 章：theme、sidebar 開合、收藏清單。
export const useUiStore = create(
  persist(
    (set) => ({
      theme: 'light', // 'light' | 'dark'
      sidebarOpen: true,
      bookmarkedCourseIds: [], // 收藏的課程 id

      toggleTheme: () =>
        set((state) => ({
          theme: state.theme === 'light' ? 'dark' : 'light',
        })),

      toggleSidebar: () =>
        set((state) => ({ sidebarOpen: !state.sidebarOpen })),

      toggleBookmark: (courseId) =>
        set((state) => {
          const exists = state.bookmarkedCourseIds.includes(courseId)
          return {
            bookmarkedCourseIds: exists
              ? state.bookmarkedCourseIds.filter((id) => id !== courseId)
              : [...state.bookmarkedCourseIds, courseId],
          }
        }),

      clearBookmarks: () => set({ bookmarkedCourseIds: [] }),

      setTheme: (theme) => set({ theme }),
    }),
    { name: 'admin-ui' }
  )
)
