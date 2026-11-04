import { createApp, reactive } from 'vue'
import './style.css'
import App from './App.vue'
import { registerSW } from 'virtual:pwa-register'

// 提供給主畫面使用的應用狀態（更新提示、離線就緒提示）。
const pwaState = reactive({
  needRefresh: false,
  offlineReady: false,
  updateServiceWorker: () => {},
})

// 立即註冊服務工作執行緒，並把生命週期事件同步到畫面狀態。
const updateSW = registerSW({
  immediate: true,
  // 掃碼頁常開著不重新整理，每小時主動檢查一次有沒有新版 sw.js。
  onRegisteredSW(_swUrl, registration) {
    if (!registration) return
    window.setInterval(() => {
      registration.update().catch(() => {})
    }, 60 * 60 * 1000)
  },
  // 有新版本時顯示「稍後 / 立即更新」彈窗；想改成自動更新，改用下面註解掉的兩行。
  onNeedRefresh() {
    pwaState.needRefresh = true // 原本的設定，有新版本時顯示更新提示。
    // 直接更新
    // pwaState.needRefresh = false
    // updateSW(true)
  },
  // 離線快取完成後，短暫顯示「離線可用」提示。
  onOfflineReady() {
    pwaState.offlineReady = true
    window.setTimeout(() => {
      pwaState.offlineReady = false
    }, 3000)
  },
})

// 提供手動更新方法給畫面按鈕呼叫。
pwaState.updateServiceWorker = () => updateSW(true)

const app = createApp(App)
app.provide('pwaState', pwaState)
app.mount('#app')
