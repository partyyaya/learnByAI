import { afterEach, beforeEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import '@testing-library/jest-dom'

import { useAuthStore } from '@/stores/auth.store'
import { useUiStore } from '@/stores/ui.store'
import { useCourseFilterStore } from '@/stores/courseFilter.store'

// 每個測試檔開跑前都會先執行這支（見 vite.config.js 的 test.setupFiles）。
// 它負責兩件事：擴充斷言、以及把「跨測試會殘留的東西」清乾淨。
//
// 為什麼需要清乾淨？
// 同一個測試檔裡的所有 it 共用同一個 Node process，模組只會被載入一次。
// 也就是說 Zustand store 與 localStorage 是「整檔共用」的——
// 前一個 it 登入後，下一個 it 一開始就是登入狀態，測試會互相污染。
// 這種 bug 的症狀很典型：單獨跑會過，整檔一起跑就掛，而且順序一換結果就變。

// 開跑前先記下每個 store 的初始狀態（此時還沒有任何測試動過它們）。
// 注意用 getState() 拿到的物件同時含 state 與 actions，整包存起來再整包還原最省事。
const initialStoreStates = [
  [useAuthStore, useAuthStore.getState()],
  [useUiStore, useUiStore.getState()],
  [useCourseFilterStore, useCourseFilterStore.getState()],
]

beforeEach(() => {
  // persist 中介層會把狀態寫進 localStorage，不清會跨測試還原回來。
  localStorage.clear()
  // 第二個參數 true = 整包取代而非合併，確保上一個測試新增的欄位也一併消失。
  initialStoreStates.forEach(([store, state]) => store.setState(state, true))
})

afterEach(() => {
  // 卸載上一個測試 render 出來的 DOM。
  // globals: true 時 RTL 其實會自動做，這裡明寫是為了讓行為一目了然。
  cleanup()
})
