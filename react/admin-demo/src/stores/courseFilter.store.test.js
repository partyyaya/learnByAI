import { describe, expect, it } from 'vitest'
import { useCourseFilterStore } from './courseFilter.store'

// Zustand store 測試（第 14 章 §5）。
//
// 重點：store 不需要 React。Zustand 的狀態活在元件外，
// 可以直接用 getState() 讀、呼叫 action 改，不必 render 任何東西——
// 所以這類測試跟純函式一樣快，也一樣穩。
//
// 前置清理由 src/test/setup.js 的 beforeEach 統一處理（每個 it 開始前還原初始狀態）。
// 少了那一步，下面的測試會互相污染：前一個 it 設過 search，後一個 it 就不是從空字串開始。

// 小工具：少寫幾次 useCourseFilterStore.getState()
const state = () => useCourseFilterStore.getState()

describe('useCourseFilterStore', () => {
  it('初始條件是「無搜尋、全部難度、最近更新、第 1 頁」', () => {
    expect(state().search).toBe('')
    expect(state().level).toBe('all')
    expect(state().sort).toBe('updated-desc')
    expect(state().page).toBe(1)
  })

  it('改搜尋字會把頁碼拉回第 1 頁', () => {
    // 這是本 store 最重要的行為。情境：使用者翻到第 5 頁才輸入關鍵字，
    // 若頁碼留在 5，篩選後可能只剩 2 頁 → 畫面直接空白，看起來像搜尋壞掉。
    state().setPage(5)
    expect(state().page).toBe(5)

    state().setSearch('React')

    expect(state().search).toBe('React')
    expect(state().page).toBe(1)
  })

  it('改難度也會回到第 1 頁', () => {
    state().setPage(3)
    state().setLevel('advanced')

    expect(state().level).toBe('advanced')
    expect(state().page).toBe(1)
  })

  it('改排序同樣回到第 1 頁', () => {
    state().setPage(4)
    state().setSort('rating-desc')

    expect(state().sort).toBe('rating-desc')
    expect(state().page).toBe(1)
  })

  it('單純換頁不會動到其他條件', () => {
    state().setSearch('Query')
    state().setLevel('beginner')
    state().setPage(2)

    // 換頁只該影響 page；搜尋字被清掉的話，翻第 2 頁就會看到不相干的資料
    expect(state().page).toBe(2)
    expect(state().search).toBe('Query')
    expect(state().level).toBe('beginner')
  })

  it('resetFilters 會還原所有篩選條件', () => {
    state().setSearch('Zustand')
    state().setLevel('advanced')
    state().setSort('title-asc')
    state().setPage(3)

    state().resetFilters()

    expect(state().search).toBe('')
    expect(state().level).toBe('all')
    expect(state().sort).toBe('updated-desc')
    expect(state().page).toBe(1)
  })

  it('resetFilters 不會清掉選取中的課程', () => {
    // 反向斷言：確認 reset 的範圍只有篩選條件。
    // selectedCourseId 屬於「選取狀態」而非「篩選條件」，不該被順手清掉。
    state().selectCourse(7)
    state().resetFilters()

    expect(state().selectedCourseId).toBe(7)
  })
})
