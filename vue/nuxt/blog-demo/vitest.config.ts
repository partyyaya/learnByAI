// 測試設定（第 15 章）。用 Nuxt 提供的 defineVitestConfig，
// 測試才能享有自動匯入、~ 別名與 Nuxt runtime。
import { defineVitestConfig } from '@nuxt/test-utils/config'

export default defineVitestConfig({
  test: {
    // 在模擬的 Nuxt 環境跑（底層是 happy-dom）
    environment: 'nuxt',
  },
})
