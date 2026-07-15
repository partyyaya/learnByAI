import { create } from 'zustand'

// 課程列表的「篩選 / 分頁 / 選取」本地狀態。
// 這是課程第 12 章的核心：把這些條件放 Zustand，再組進 TanStack Query 的 queryKey，
// 條件一變，Query 就自動抓對應資料。這裡「不」persist（屬於臨時互動狀態）。
export const useCourseFilterStore = create((set) => ({
  search: '',
  level: 'all', // all | beginner | intermediate | advanced
  sort: 'updated-desc',
  page: 1,
  selectedCourseId: null,

  // 改搜尋字或篩選時要回到第 1 頁，避免停在超出範圍的頁碼
  setSearch: (search) => set({ search, page: 1 }),
  setLevel: (level) => set({ level, page: 1 }),
  setSort: (sort) => set({ sort, page: 1 }),
  setPage: (page) => set({ page }),
  selectCourse: (id) => set({ selectedCourseId: id }),

  resetFilters: () =>
    set({ search: '', level: 'all', sort: 'updated-desc', page: 1 }),
}))
