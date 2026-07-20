// Nuxt 4 設定檔（放專案根目錄，不在 app/）
export default defineNuxtConfig({
  // 設一個相容日期，鎖定 Nitro/Nuxt 的預設行為
  compatibilityDate: '2025-07-01',

  // 開啟 Nuxt DevTools
  devtools: { enabled: true },

  // 認證：nuxt-auth-utils 提供 setUserSession / requireUserSession / useUserSession
  // 需要環境變數 NUXT_SESSION_PASSWORD（見 .env）
  modules: ['nuxt-auth-utils'],

  // 全域樣式
  css: ['~/assets/css/main.css'],

  app: {
    head: {
      htmlAttrs: { lang: 'zh-Hant' },
      meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }],
    },
  },
})
